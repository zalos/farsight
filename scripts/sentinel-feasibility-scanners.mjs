#!/usr/bin/env node
// PR 01 experiment only. This is not a production scanner adapter or isolation service.
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, lstat, realpath, chmod, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const CANDIDATES = Object.freeze([
  Object.freeze({ id: 'semgrep', version: '1.181.0', image: 'semgrep/semgrep@sha256:81474464c1f07483ba0682a44787fd93c91397419762a04abe2bafaae396304b', entrypoint: 'semgrep' }),
  Object.freeze({ id: 'opengrep', version: '1.31.0', image: 'debian@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8', entrypoint: '/tool/opengrep', binarySha256: '2b713a29a00237f85408b83002fc111db5b94c7fa8d263f0a93184a960655d9d' }),
]);
const OWNER_LABEL = 'org.farsight.sentinel-feasibility.owner';
const CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/sentinel/test/fixtures/feasibility');
const MAX_OUTPUT = 4 * 1024 * 1024;
const TIMEOUT = 120_000;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const selectedCases = ['ts-injection-pair', 'java-injection-pair'];

async function plainDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Fixture root/parent must be a plain directory, not a symbolic link');
}

async function readFixture(root, path) {
  const target = safePath(root, path);
  for (let directory = dirname(target); directory !== root; directory = dirname(directory)) await plainDirectory(directory);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Fixture index/source must be a regular file, not a symbolic link');
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size > 2 * 1024 * 1024) throw new Error('Fixture identity changed or file exceeds the 2 MiB read bound');
    return await file.readFile();
  } finally { await file.close(); }
}

export async function scriptProvenance(runner = execute) {
  const path = fileURLToPath(import.meta.url), root = resolve(dirname(path), '..');
  const bytes = await readFixture(dirname(path), 'sentinel-feasibility-scanners.mjs');
  const revision = await runner('git', ['-C', root, 'rev-parse', 'HEAD'], { timeout: 30_000 });
  const status = await runner('git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all', '--', 'scripts/sentinel-feasibility-scanners.mjs'], { timeout: 30_000 });
  return { script: 'scripts/sentinel-feasibility-scanners.mjs', sha256: digest(bytes),
    revision: commandOK(revision) && /^[a-f0-9]{40}$/.test(revision.stdout.trim()) ? revision.stdout.trim() : null,
    dirty: commandOK(status) ? status.stdout.trim().length > 0 : null,
    revisionEvidence: revision, statusEvidence: status };
}

export function parseArgs(args) {
  const options = { run: false };
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === '--run') options.run = true;
    else if (argument === '--help') options.help = true;
    else if (argument === '--out' || argument === '--opengrep-binary') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${argument}`);
      options[argument === '--out' ? 'out' : 'binary'] = resolve(args[++i]);
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.run && (!options.out || !options.binary)) throw new Error('--run requires --out <fresh-directory> and --opengrep-binary <verified-path>');
  return options;
}

export function scrub(value) {
  return value.replaceAll(homedir(), '<home>')
    .replace(/(Bearer\s+)[\w.\-]+/gi, '$1<redacted>')
    .replace(/((?:api[_-]?key|password|token)\s*[=:]\s*)[^\s,;"'\]}]+/gi, '$1<redacted>');
}

// No shell, inherited stdin, scanner fallback, or command sourced from fixture contents.
export function execute(program, args, { timeout = TIMEOUT, maxOutput = MAX_OUTPUT, signal } = {}) {
  return new Promise(resolveResult => {
    const begin = performance.now();
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = { stdout: [], stderr: [] };
    let size = 0, timedOut = false, outputExceeded = false, cancelled = false, spawnError = null;
    const collect = (stream, bytes) => {
      const remaining = Math.max(0, maxOutput - size);
      chunks[stream].push(bytes.subarray(0, remaining));
      size += bytes.length;
      if (size > maxOutput) { outputExceeded = true; child.kill('SIGKILL'); }
    };
    child.stdout.on('data', bytes => collect('stdout', bytes));
    child.stderr.on('data', bytes => collect('stderr', bytes));
    const cancel = () => { cancelled = true; child.kill('SIGKILL'); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.on('error', error => { spawnError = error.code ?? 'spawn-error'; });
    child.on('close', (exitCode, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      const stdout = scrub(Buffer.concat(chunks.stdout).toString('utf8'));
      const stderr = scrub(Buffer.concat(chunks.stderr).toString('utf8'));
      resolveResult({ exitCode, exitSignal, timedOut, outputExceeded, cancelled, spawnError,
        wallMs: performance.now() - begin,
        stdout, stderr, stdoutSha256: digest(Buffer.from(stdout)), stderrSha256: digest(Buffer.from(stderr)), outputEncoding: 'utf8-scrubbed' });
    });
  });
}

export async function verifyBinary(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 200 * 1024 * 1024) throw new Error('Opengrep binary must be a bounded regular file, not a symbolic link');
  const actual = digest(await readFile(path));
  if (actual !== CANDIDATES[1].binarySha256) throw new Error('Opengrep binary checksum does not match the pinned acquisition');
  return { path: await realpath(path), sha256: actual, bytes: info.size };
}

// These pins and the acquired executable support only native ARM64 execution.
export function validateHost(host = { os: process.platform, arch: process.arch }) {
  if (!['arm64', 'aarch64'].includes(host.arch) || !['darwin', 'linux'].includes(host.os)) throw new Error('Probe requires a native arm64 macOS or Linux host; no emulation');
  return { os: host.os, arch: 'arm64' };
}
export function validateDockerPlatform(version, images) {
  let server;
  try { server = JSON.parse(version.stdout).Server; } catch { throw new Error('Invalid Docker server platform evidence'); }
  const platform = value => {
    if (value?.os !== 'linux' || !['arm64', 'aarch64'].includes(value?.arch)) throw new Error('Pinned probe requires Linux/arm64 Docker server and images; no emulation');
    return { os: 'linux', arch: 'arm64' };
  };
  const validatedServer = platform({ os: server?.Os, arch: server?.Arch });
  const validatedImages = images.map(image => {
    let values;
    try { values = JSON.parse(image.inspection.stdout); } catch { throw new Error('Invalid Docker image platform evidence'); }
    if (!Array.isArray(values) || values.length !== 1) throw new Error('Missing or ambiguous Docker image platform');
    return { candidate: image.candidate, ...platform({ os: values[0]?.Os, arch: values[0]?.Architecture }) };
  });
  return { server: validatedServer, images: validatedImages };
}

export function networkDenied(trial) {
  return trial.isolation?.networkMode === 'none' && commandOK(trial.execution) &&
    trial.socketAttempt?.connected === false && trial.socketAttempt?.errorType === 'OSError' &&
    trial.socketAttempt?.errno === 101;
}

export function validateSpans(expectations, sourceTexts) {
  const seen = new Map();
  for (const rule of expectations) {
    if (!Array.isArray(rule.matches) || !Array.isArray(rule.noMatches)) throw new Error('Missing expected symbol spans');
    for (const entry of [...rule.matches, ...rule.noMatches]) {
      const path = `${entry.case}/${entry.path}`, text = sourceTexts[path];
      const lines = typeof text === 'string' ? text.replace(/\n$/, '').split('\n').length : 0;
      if (!entry.symbol || !Number.isInteger(entry.startLine) || !Number.isInteger(entry.endLine) || entry.startLine < 1 || entry.endLine < entry.startLine || entry.endLine > lines) throw new Error('Invalid expected symbol span');
      const prior = seen.get(path) ?? [];
      if (prior.some(span => entry.startLine <= span.endLine && entry.endLine >= span.startLine)) throw new Error('Overlapping expected symbol spans');
      prior.push(entry); seen.set(path, prior);
    }
  }
}

export function containerArgs({ candidate, name, owner, scenario, source, rules, binary, command }) {
  const args = ['create', '--pull', 'never', '--name', name,
    '--label', `${OWNER_LABEL}=${owner}`, '--label', `org.farsight.sentinel-feasibility.scenario=${scenario}`,
    '--platform', 'linux/arm64', '--network', 'none', '--read-only', '--user', '65534:65534', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--memory', '2g', '--cpus', '2', '--pids-limit', '128',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m,mode=1777', '--workdir', '/input',
    '--env', 'HOME=/tmp', '--env', 'SEMGREP_SEND_METRICS=off', '--env', 'SEMGREP_ENABLE_VERSION_CHECK=0',
    '--env', 'OPENGREP_SEND_METRICS=off', '--env', 'OPENGREP_ENABLE_VERSION_CHECK=0',
    '--env', 'SEMGREP_APP_TOKEN=', '--env', 'OPENGREP_APP_TOKEN=',
    '--mount', `type=bind,src=${source},dst=/input,readonly`,
    '--mount', `type=bind,src=${rules},dst=/rules,readonly`];
  if (candidate.id === 'opengrep') args.push('--mount', `type=bind,src=${binary},dst=/tool/opengrep,readonly`);
  args.push('--entrypoint', candidate.entrypoint, candidate.image, ...command);
  return args;
}

const commandCompleted = result => Number.isInteger(result?.exitCode) && !result.spawnError && !result.timedOut && !result.cancelled && !result.outputExceeded && !result.exitSignal;
const commandOK = result => commandCompleted(result) && result.exitCode === 0;
const containerAbsent = result => commandCompleted(result) && result.exitCode !== 0 && /^(?:Error(?: response from daemon)?:\s*)?No such (?:object|container):\s*\S+\s*$/im.test(result.stderr ?? '');
async function inspectOwned(runner, identity, owner) {
  const result = await runner('docker', ['inspect', '--type', 'container', identity], { timeout: 30_000 });
  if (!commandOK(result)) return { result, container: null };
  let containers;
  try { containers = JSON.parse(result.stdout); } catch { throw new Error('Invalid Docker inspection response; ownership cannot be verified'); }
  const container = containers[0];
  if (containers.length !== 1 || !/^[a-f0-9]{64}$/.test(container?.Id ?? '') || container.Config?.Labels?.[OWNER_LABEL] !== owner) {
    throw new Error('Container ownership mismatch; refusing start or removal');
  }
  if (/^[a-f0-9]{64}$/.test(identity) && container.Id !== identity) throw new Error('Container identity changed; refusing mutation');
  return { result, container };
}

export async function cleanupOwned(runner, identity, owner) {
  const inspected = await inspectOwned(runner, identity, owner);
  if (!inspected.container) return { state: containerAbsent(inspected.result) ? 'not-found' : 'cleanup-failed', reason: containerAbsent(inspected.result) ? 'docker-confirmed-absent' : 'inspection-unavailable-ownership-or-absence-unknown', inspect: inspected.result };
  const removed = await runner('docker', ['rm', '--force', inspected.container.Id], { timeout: 30_000 });
  if (!commandOK(removed)) return { state: 'cleanup-failed', id: inspected.container.Id, result: removed };
  const verification = await runner('docker', ['inspect', '--type', 'container', inspected.container.Id], { timeout: 30_000 });
  const absent = containerAbsent(verification);
  return { state: absent ? 'removed-owned-container' : 'cleanup-failed', id: inspected.container.Id, result: removed, verification };
}

export async function runContainer(spec, runner = execute, signal) {
  const owner = randomUUID(), name = `sentinel-feasibility-${randomUUID()}`;
  const args = containerArgs({ ...spec, name, owner });
  const record = { candidate: spec.candidate.id, scenario: spec.scenario, owner, name, command: ['docker', ...args],
    expectedImage: spec.candidate.image, networkPolicy: 'none', limits: { timeoutMs: TIMEOUT, outputBytes: MAX_OUTPUT, memoryBytes: 2147483648, cpus: 2, pids: 128 }, state: 'failed' };
  let identity = name;
  try {
    record.create = await runner('docker', args, { signal });
    if (!commandOK(record.create)) { record.reason = 'container-create-failed'; return record; }
    const id = record.create.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Docker create did not return a container ID');
    identity = id;
    const inspected = await inspectOwned(runner, id, owner);
    const container = inspected.container;
    record.inspect = inspected.result;
    if (!container || container.HostConfig?.NetworkMode !== 'none' || container.Config?.Image !== spec.candidate.image) {
      throw new Error('Container image/network identity does not match requested pinned isolation');
    }
    record.isolation = { id, imageId: container.Image, image: container.Config.Image, networkMode: container.HostConfig.NetworkMode,
      user: container.Config.User, readOnlyRootfs: container.HostConfig.ReadonlyRootfs,
      capDrop: container.HostConfig.CapDrop, securityOpt: container.HostConfig.SecurityOpt,
      memory: container.HostConfig.Memory, nanoCpus: container.HostConfig.NanoCpus, pidsLimit: container.HostConfig.PidsLimit,
      mounts: container.Mounts?.map(m => ({ destination: m.Destination, readWrite: m.RW, type: m.Type })) };
    record.execution = await runner('docker', ['start', '--attach', id], { signal });
    const after = await inspectOwned(runner, id, owner);
    record.completionInspect = after.result;
    record.containerState = after.container?.State ?? null;
    record.containerExit = after.container?.State?.ExitCode ?? null;
    const state = record.containerState;
    record.containerCompleted = state?.Status === 'exited' && state?.Running === false && state?.Dead === false && state?.OOMKilled === false;
    record.containerExitMatchesClient = record.containerCompleted && commandCompleted(record.execution) && Number.isInteger(record.containerExit) && record.containerExit === record.execution.exitCode;
    record.state = commandOK(record.execution) && record.containerExitMatchesClient ? 'measured' : 'failed';
    if (!record.containerExitMatchesClient) record.reason = 'Inspected container completion/exit disagrees with the Docker client outcome';
  } catch (error) { record.reason = scrub(error.message); }
  finally {
    try { record.cleanup = await cleanupOwned(runner, identity, owner); }
    catch (error) { record.cleanup = { state: 'refused', reason: scrub(error.message) }; }
    if (record.cleanup.state === 'cleanup-failed' || record.cleanup.state === 'refused') record.state = 'failed';
  }
  return record;
}

function safePath(root, path) {
  const target = resolve(root, path);
  if (!path || isAbsolute(path) || relative(root, target).startsWith('..') || path.includes(',')) throw new Error('Unsafe fixture path');
  return target;
}

export async function materialize(root, corpusRoot = CORPUS) {
  root = resolve(root); corpusRoot = resolve(corpusRoot);
  await plainDirectory(root); await plainDirectory(corpusRoot);
  const indexBytes = await readFixture(corpusRoot, 'cases.json');
  const index = JSON.parse(indexBytes);
  if (index.schemaVersion !== 'sentinel-feasibility-corpus-v1') throw new Error('Unsupported corpus index');
  const inputs = [];
  const source = join(root, 'input'), rules = join(root, 'rules');
  await mkdir(source); await chmod(source, 0o755); await mkdir(rules); await chmod(rules, 0o755);
  for (const id of selectedCases) {
    const entry = index.cases.find(c => c.id === id);
    if (!entry) throw new Error('Required paired case missing');
    for (const file of entry.files) {
      const bytes = await readFixture(corpusRoot, file.source);
      if (digest(bytes) !== file.sha256) throw new Error('Fixture source hash mismatch');
      const path = `${id}/${file.path}`, target = safePath(source, path);
      await mkdir(dirname(target), { recursive: true });
      for (let directory = dirname(target); directory !== source; directory = dirname(directory)) await chmod(directory, 0o755);
      await writeFile(target, bytes, { flag: 'wx', mode: 0o644 }); await chmod(target, 0o644);
      inputs.push({ path, sha256: file.sha256, bytes: bytes.length });
    }
  }
  const sourceTexts = {};
  for (const input of inputs) sourceTexts[input.path] = await readFile(join(source, input.path), 'utf8');
  validateSpans(index.rules.map(r => ({ matches: r.expectedMatches, noMatches: r.expectedNoMatches })), sourceTexts);
  const expectedRules = ['sentinel-fixture-sql-concat-tsjs', 'sentinel-fixture-sql-concat-java'];
  if (!Array.isArray(index.rules) || index.rules.length !== 2 || expectedRules.some(id => !index.rules.some(rule => rule.id === id))) throw new Error('Unexpected rule inventory');
  for (const rule of index.rules) {
    const bytes = await readFixture(corpusRoot, rule.source);
    if (digest(bytes) !== rule.sha256) throw new Error('Rule source hash mismatch');
    await writeFile(join(rules, `${rule.id}.yaml`), bytes, { flag: 'wx', mode: 0o644 });
    await chmod(join(rules, `${rule.id}.yaml`), 0o644);
    inputs.push({ path: `rules/${rule.id}.yaml`, sha256: rule.sha256, bytes: bytes.length });
  }
  const oversizeSource = join(root, 'oversize-input');
  await mkdir(oversizeSource); await chmod(oversizeSource, 0o755);
  const oversized = Buffer.from('// synthetic oversize control\n'.repeat(400) + 'db.query("SELECT " + request.name);\n');
  await writeFile(join(oversizeSource, 'oversized.ts'), oversized, { flag: 'wx', mode: 0o644 });
  await chmod(join(oversizeSource, 'oversized.ts'), 0o644);
  const oversize = { path: 'oversized.ts', bytes: oversized.length, sha256: digest(oversized), maxTargetBytes: 4096 };
  return { source, rules, oversizeSource, inputs, oversize, indexHash: digest(indexBytes), expectations: index.rules.map(r => ({ id: r.id, matches: r.expectedMatches, noMatches: r.expectedNoMatches })) };
}

export function scanCommand(scenario, candidate = CANDIDATES[0]) {
  return ['--json', '--verbose', ...(candidate.id === 'semgrep' ? ['--metrics=off'] : []), '--disable-version-check', '--jobs', '1', '--timeout', '20', '--max-target-bytes', '4096',
    '--config', scenario === 'missing-rules' ? '/rules/not-present.yaml' : '/rules/sentinel-fixture-sql-concat-tsjs.yaml',
    ...(scenario === 'missing-rules' ? [] : ['--config', '/rules/sentinel-fixture-sql-concat-java.yaml']), '/input'];
}

// Do not turn successful process execution into successful file coverage.
export function assessScan(record, expectations, sourceTexts) {
  const result = { executionState: record.state, exitCode: record.execution?.exitCode ?? null, parseableJson: false,
    coverage: { scanned: null, skipped: null, granularity: 'unavailable' }, positiveSymbols: [], negativeSymbols: [], gaps: [] };
  let output;
  try { output = JSON.parse(record.execution?.stdout ?? ''); result.parseableJson = true; }
  catch { result.gaps.push('missing-or-invalid-json'); return result; }
  if (!output || typeof output !== 'object' || Array.isArray(output) || (output.results !== undefined && !Array.isArray(output.results)) || (output.errors !== undefined && !Array.isArray(output.errors))) {
    result.gaps.push('invalid-engine-output-shape'); return result;
  }
  result.errors = output.errors ?? [];
  const diagnostics = [...result.errors.map(error => typeof error === 'string' ? error : JSON.stringify(error)), record.execution?.stderr ?? ''];
  result.missingRuleDiagnostic = result.errors.length > 0 && diagnostics.some(text => text.includes('/rules/not-present.yaml') && /\b(unable to find a config|does not exist|not found|no such file|invalid config(?:uration)?(?: file)?|cannot (?:read|find)|failed to (?:read|load))\b/i.test(text));
  result.coverage = { scanned: output.paths?.scanned ?? null, skipped: output.paths?.skipped ?? null,
    granularity: output.paths ? 'engine-reported-paths' : 'unavailable' };
  if (result.coverage.scanned === null) result.gaps.push('scanned-file-inventory-unavailable');
  if (result.coverage.skipped === null) result.gaps.push('skipped-file-reasons-unavailable');
  if (result.errors.length) result.gaps.push('engine-reported-errors');
  try { validateSpans(expectations, sourceTexts); }
  catch { result.gaps.push('invalid-expected-symbol-spans'); result.unattributedFindings = (output.results ?? []).length; return result; }
  const findings = output.results ?? [];
  const matchesSymbol = (finding, expected) => {
    const path = `${expected.case}/${expected.path}`;
    const actualPath = String(finding.path ?? '').replace(/^\/input\//, '').replace(/^\.\//, '');
    if (actualPath !== path) return false;
    return Number.isInteger(finding.start?.line) && finding.start.line >= expected.startLine && finding.start.line <= expected.endLine &&
      (finding.end?.line === undefined || (Number.isInteger(finding.end.line) && finding.end.line >= finding.start.line && finding.end.line <= expected.endLine));
  };
  for (const rule of expectations) {
    for (const [kind, entries] of [['positiveSymbols', rule.matches], ['negativeSymbols', rule.noMatches]]) {
      for (const expected of entries) {
        const hits = findings.filter(f => (f.check_id === rule.id || String(f.check_id).endsWith(`.${rule.id}`)) && matchesSymbol(f, expected));
        result[kind].push({ ...expected, rule: rule.id, matched: hits.length > 0, rawLocations: hits.length });
      }
    }
  }
  result.unattributedFindings = findings.filter(f => !expectations.some(rule => (f.check_id === rule.id || String(f.check_id).endsWith(`.${rule.id}`)) && [...rule.matches, ...rule.noMatches].some(e => matchesSymbol(f, e)))).length;
  if (result.unattributedFindings) result.gaps.push('unattributed-findings');
  if (record.state !== 'measured') result.gaps.push('execution-failed');
  return result;
}

export function scenarioControl(trial) {
  const checks = [];
  const check = (name, passed) => checks.push({ name, passed: passed === true });
  check('owned-container-removed', trial.cleanup?.state === 'removed-owned-container');
  check('pinned-container-identity', /^[a-f0-9]{64}$/.test(trial.isolation?.id ?? '') && trial.isolation?.image === trial.expectedImage);
  check('network-none-inspected', trial.isolation?.networkMode === 'none');
  check('container-stopped-and-exit-agrees', trial.containerCompleted === true && trial.containerExitMatchesClient === true && trial.containerExit === trial.execution?.exitCode);
  const execution = trial.execution;
  const finished = execution && !execution.timedOut && !execution.cancelled && !execution.outputExceeded && !execution.spawnError && !execution.exitSignal;
  if (trial.scenario === 'missing-rules') {
    check('expected-process-failure', !!finished && Number.isInteger(execution.exitCode) && execution.exitCode !== 0);
  } else check('execution-completed-zero', !!execution && commandOK(execution));
  const assessment = trial.assessment;
  if (trial.scenario === 'version') check('version-pin-matches', trial.versionMatches);
  else if (trial.scenario === 'paired-baseline') {
    check('valid-json', assessment?.parseableJson);
    check('all-findings-attributed', assessment?.unattributedFindings === 0 && !assessment?.gaps?.includes('invalid-expected-symbol-spans'));
    check('three-positive-symbols-found', assessment?.positiveSymbols?.length === 3 && assessment.positiveSymbols.every(s => s.matched === true));
    check('three-safe-symbols-unmatched', assessment?.negativeSymbols?.length === 3 && assessment.negativeSymbols.every(s => s.matched === false));
    check('no-engine-errors', Array.isArray(assessment?.errors) && assessment.errors.length === 0);
  } else if (trial.scenario === 'oversized') {
    check('valid-json', assessment?.parseableJson);
    check('explicit-size-omission', Array.isArray(assessment?.coverage?.scanned) && assessment.oversizedNotScanned === true);
    check('no-engine-errors', Array.isArray(assessment?.errors) && assessment.errors.length === 0);
  } else if (trial.scenario === 'network-denial') {
    check('socket-attempt-denied', networkDenied(trial));
  } else if (trial.scenario === 'missing-rules') {
    check('valid-json-missing-rule-diagnostic', assessment?.parseableJson === true && assessment.missingRuleDiagnostic === true);
  } else check('known-scenario', false);
  return { candidate: trial.candidate, scenario: trial.scenario, passed: checks.every(c => c.passed), checks };
}

export function evaluateControls(result) {
  const controls = result.trials.map(scenarioControl);
  const required = CANDIDATES.flatMap(c => ['version', 'paired-baseline', 'oversized', 'missing-rules'].map(s => `${c.id}:${s}`));
  required.push('semgrep:network-denial');
  const keys = controls.map(c => `${c.candidate}:${c.scenario}`);
  const complete = keys.length === required.length && new Set(keys).size === keys.length && required.every(k => keys.includes(k));
  const identity = Array.isArray(result.inputIntegrity) && result.inputIntegrity.length === 7 && result.inputIntegrity.every(input => input.unchanged === true);
  const manifest = /^[a-f0-9]{64}$/.test(result.inputManifestHash ?? '');
  const provenance = /^[a-f0-9]{64}$/.test(result.provenance?.sha256 ?? '') && /^[a-f0-9]{40}$/.test(result.provenance?.revision ?? '') && typeof result.provenance?.dirty === 'boolean';
  const checks = [{ name: 'all-nine-controls-present-once', passed: complete }, { name: 'all-input-identities-unchanged', passed: identity },
    { name: 'corpus-index-identified', passed: manifest }, { name: 'script-revision-hash-and-dirty-recorded', passed: provenance }];
  return { passed: checks.every(c => c.passed) && controls.every(c => c.passed), checks, scenarios: controls,
    decision: 'measurement-controls-only; capability acceptance and ranking remain separate' };
}

export function preview(options = {}) {
  return { schemaVersion: 'sentinel-feasibility-scanners-v1', mode: options.run ? 'run' : 'preview',
    platformRestriction: 'Native arm64 macOS/Linux host; Linux/arm64 Docker server and pinned images only; no emulation',
    tmpfs: '/tmp:rw,noexec,nosuid,size=256m,mode=1777',
    candidates: CANDIDATES, cases: selectedCases, scenarios: ['version', 'paired-baseline', 'oversized', 'missing-rules', 'network-denial'],
    effects: { acquisition: false, hostScannerExecution: false, providerCalls: false, network: 'none inside each container',
      localWrites: options.run ? 'fresh --out directory; synthetic inputs and retained evidence' : 'none',
      programs: options.run ? ['docker; scanners and network control only inside owned containers'] : [] },
    limitations: ['Narrow synthetic rules only; label review and capability acceptance are recorded separately.', 'Container flags and a denied socket trial do not prove hostile-code isolation.',
      'No support ranking, production orphan recovery, deep-flow or dependency coverage claim.'] };
}

export async function runProbe(options, { runner = execute, corpusRoot = CORPUS, signal } = {}) {
  // Verify every immutable prerequisite before creating output or a container.
  const host = validateHost();
  const binary = await verifyBinary(options.binary);
  const provenance = await scriptProvenance(runner);
  if (options.out.includes(',') || binary.path.includes(',')) throw new Error('Docker mount paths cannot contain commas');
  const dockerVersion = await runner('docker', ['version', '--format', '{{json .}}'], { timeout: 30_000, signal });
  if (!commandOK(dockerVersion)) throw new Error('Docker unavailable; no host fallback');
  const images = [];
  for (const candidate of CANDIDATES) {
    const image = await runner('docker', ['image', 'inspect', candidate.image], { timeout: 30_000, signal });
    if (!commandOK(image)) throw new Error(`Pinned ${candidate.id} image unavailable locally; no acquisition or host fallback`);
    images.push({ candidate: candidate.id, inspection: image });
  }
  const validatedPlatform = { host, ...validateDockerPlatform(dockerVersion, images) };
  await mkdir(options.out); // Exclusive: existing evidence is never replaced.
  await chmod(options.out, 0o755); // Rootless container UID can read only the explicitly mounted subdirectories.
  const materialized = await materialize(options.out, corpusRoot);
  const toolDirectory = join(options.out, 'tools');
  await mkdir(toolDirectory); await chmod(toolDirectory, 0o755);
  const binaryBytes = await readFile(binary.path);
  if (digest(binaryBytes) !== binary.sha256) throw new Error('Opengrep binary changed after verification');
  const copiedBinary = join(toolDirectory, 'opengrep');
  await writeFile(copiedBinary, binaryBytes, { flag: 'wx', mode: 0o555 }); await chmod(copiedBinary, 0o555);
  const sourceTexts = {};
  for (const input of materialized.inputs.filter(x => !x.path.startsWith('rules/'))) sourceTexts[input.path] = await readFile(join(materialized.source, input.path), 'utf8');
  const result = { ...preview(options), startedAt: new Date().toISOString(), nodeVersion: process.version,
    platform: process.platform, arch: process.arch, validatedPlatform, provenance, dockerVersion, images, binary: { sha256: binary.sha256, bytes: binary.bytes },
    inputManifestHash: materialized.indexHash, inputs: materialized.inputs, oversize: materialized.oversize, trials: [] };
  const persist = async () => {
    const bytes = JSON.stringify(result, null, 2) + '\n';
    await writeFile(join(options.out, 'results.json'), bytes, { mode: 0o600 });
    await writeFile(join(options.out, 'results.sha256'), digest(Buffer.from(bytes)) + '\n', { mode: 0o600 });
  };
  try {
    for (const candidate of CANDIDATES) {
      for (const scenario of ['version', 'paired-baseline', 'oversized', 'missing-rules']) {
        if (signal?.aborted) throw new Error('Probe cancelled');
        const trial = await runContainer({ candidate, scenario, source: scenario === 'oversized' ? materialized.oversizeSource : materialized.source,
          rules: materialized.rules, binary: copiedBinary, command: scenario === 'version' ? ['--version'] : scanCommand(scenario, candidate) }, runner, signal);
        if (scenario === 'version') {
          trial.observedVersion = trial.execution?.stdout.trim() ?? null;
          trial.versionMatches = new RegExp(`(^|\\s)${candidate.version.replaceAll('.', '\\.')}($|\\s)`).test(trial.observedVersion ?? '');
          if (!trial.versionMatches) trial.state = 'failed';
        } else {
          trial.assessment = assessScan(trial, scenario === 'paired-baseline' ? materialized.expectations : [], sourceTexts);
          if (scenario === 'oversized') {
            const scanned = trial.assessment.coverage.scanned;
            trial.assessment.oversizedNotScanned = Array.isArray(scanned) ? !scanned.some(p => String(p).endsWith('/oversized.ts') || p === 'oversized.ts') : null;
            trial.assessment.gaps.push('oversized-input-not-a-clean-check');
          }
          if (scenario === 'missing-rules') {
            trial.assessment.expectedFailureObserved = commandCompleted(trial.execution) && trial.execution.exitCode !== 0 && trial.containerExitMatchesClient === true && trial.assessment.parseableJson && trial.assessment.missingRuleDiagnostic;
            trial.assessment.gaps.push('required-local-rule-unavailable');
          }
        }
        result.trials.push(trial); await persist();
        if (trial.cleanup?.state !== 'removed-owned-container') throw new Error('Owned container cleanup not verified; aborting further probes');
        if (scenario === 'version' && !trial.versionMatches) throw new Error('Candidate version did not match the fixed experiment pin');
      }
    }
    const networkScript = 'import json,socket\ns=socket.socket(); s.settimeout(2)\ntry:\n s.connect(("192.0.2.1",443)); print(json.dumps({"connected":True})); raise SystemExit(3)\nexcept OSError as error:\n print(json.dumps({"connected":False,"errorType":type(error).__name__,"errno":error.errno}))\nfinally:\n s.close()';
    const candidate = { ...CANDIDATES[0], entrypoint: 'python3' };
    const network = await runContainer({ candidate, scenario: 'network-denial', source: materialized.source,
      rules: materialized.rules, binary: copiedBinary, command: ['-c', networkScript] }, runner, signal);
    try { network.socketAttempt = JSON.parse(network.execution?.stdout); } catch { network.socketAttempt = null; }
    network.denialObserved = networkDenied(network);
    result.trials.push(network);
  } catch (error) { result.state = 'failed'; result.reason = scrub(error.message); }
  finally {
    result.inputIntegrity = [];
    const integrity = async (path, relativePath, expected) => {
      try { result.inputIntegrity.push({ path: relativePath, unchanged: digest(await readFixture(dirname(path), path.slice(dirname(path).length + 1))) === expected }); }
      catch (error) { result.inputIntegrity.push({ path: relativePath, unchanged: false, reason: scrub(error.message) }); }
    };
    for (const input of materialized.inputs) {
      const path = input.path.startsWith('rules/') ? join(options.out, input.path) : join(materialized.source, input.path);
      await integrity(path, input.path, input.sha256);
    }
    await integrity(join(materialized.oversizeSource, 'oversized.ts'), 'oversized.ts', materialized.oversize.sha256);
    // The acquired executable is larger than the bounded source-file reader permits.
    try { const info = await lstat(copiedBinary); result.inputIntegrity.push({ path: 'tools/opengrep', unchanged: info.isFile() && !info.isSymbolicLink() && digest(await readFile(copiedBinary)) === binary.sha256 }); }
    catch (error) { result.inputIntegrity.push({ path: 'tools/opengrep', unchanged: false, reason: scrub(error.message) }); }
    result.controls = evaluateControls(result);
    if (result.state !== 'failed') result.state = result.controls.passed ? 'measured-with-explicit-gaps' : 'failed';
    if (!result.controls.passed && !result.reason) result.reason = 'One or more required measurement controls failed; inspect controls and raw evidence';
    result.endedAt = new Date().toISOString(); await persist();
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log('Usage: node scripts/sentinel-feasibility-scanners.mjs [--run --out <fresh-directory> --opengrep-binary <pinned-binary>]');
    else if (!options.run) console.log(JSON.stringify(preview(options), null, 2));
    else {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      try { const result = await runProbe(options, { signal: controller.signal }); console.log(JSON.stringify({ state: result.state, trials: result.trials.length })); if (result.state === 'failed') process.exitCode = 1; }
      finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    }
  } catch (error) { console.error(scrub(error.message)); process.exitCode = 1; }
}
