#!/usr/bin/env node
// PR 01 E2 framework prototype only. Not a production Sentinel scanner, framework adapter or support
// claim. Two explicit, separate steps: `--acquire` builds one pinned image per framework (network
// allowed; docker build only) and freezes its exact content-addressed image ID plus resolved dependency
// evidence into a manifest; `--run` consumes that frozen manifest by exact image ID only — it never
// builds, pulls or re-resolves anything — and probes the already-acquired image with --network none,
// observing real HTTP responses instead of assuming them from source text.
// See docs/proposals/farsight-sentinel/framework-feasibility.md.
import { promises as fs, constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { platform, arch } from 'node:os';
import {
  execute, scrub, loadCorpus, materializeCase, writeGeneratedFile, buildImage, runOwnedContainer,
  parseProbeOutput, evaluateCaseOutcome, BASE_IMAGES, CORPUS,
} from './sentinel-feasibility/frameworks/runtime.mjs';
import { validateHost, validateDockerPlatform } from './sentinel-feasibility-scanners.mjs';
import * as expressFramework from './sentinel-feasibility/frameworks/express.mjs';
import * as nestFramework from './sentinel-feasibility/frameworks/nest.mjs';
import * as nextFramework from './sentinel-feasibility/frameworks/next.mjs';
import * as springFramework from './sentinel-feasibility/frameworks/spring.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const ACQUISITION_FORMAT = 'sentinel-feasibility-frameworks-acquisition/draft-1';
const RESULTS_FORMAT = 'sentinel-feasibility-frameworks-results/draft-1';

const FRAMEWORKS = Object.freeze({
  'express-order': expressFramework,
  'nest-validation': nestFramework,
  'next-matcher': nextFramework,
  'spring-chains': springFramework,
});

export function parseArgs(args) {
  const options = { mode: 'preview', cases: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--acquire' || arg === '--run' || arg === '--dispose') {
      if (options.mode !== 'preview') throw new Error('Only one of --acquire, --run or --dispose may be given');
      options.mode = arg.slice(2);
    } else if (arg === '--help') options.help = true;
    else if (arg === '--case' || arg === '--out' || arg === '--acquired') {
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value: ${arg}`);
      if (arg === '--case') options.cases.push(...value.split(',')); else options[arg.slice(2)] = resolve(value);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.cases.some(id => !FRAMEWORKS[id]) || new Set(options.cases).size !== options.cases.length) throw new Error('Unknown or duplicate --case selection');
  if (options.mode === 'acquire' && !options.out) throw new Error('--acquire requires a fresh --out directory');
  if (options.mode === 'run' && (!options.acquired || !options.out)) throw new Error('--run requires --acquired <acquire-out-directory> and a fresh --out directory');
  if (options.mode === 'dispose' && !options.acquired) throw new Error('--dispose requires --acquired <acquire-out-directory>');
  if (options.mode === 'dispose' && options.out) throw new Error('--dispose does not take --out');
  if (options.mode === 'preview' && (options.out || options.acquired)) throw new Error('--out/--acquired require --acquire, --run or --dispose');
  return options;
}

export function preview(options = {}) {
  const selected = options.cases?.length ? options.cases : Object.keys(FRAMEWORKS);
  return {
    schemaVersion: 'sentinel-feasibility-frameworks-v1',
    mode: options.mode ?? 'preview',
    purpose: 'PR 01 E2 framework evidence: real no-network runtime observation kept distinct from the source-grounded static label for each scenario. Not a production Sentinel framework adapter.',
    cases: selected,
    baseImages: BASE_IMAGES,
    effects: {
      acquisition: options.mode === 'acquire' ? 'docker build only, per selected case; network allowed; nothing built or pulled at --run time' : false,
      execution: options.mode === 'run' ? 'docker create/start on an already-acquired image by exact content-addressed ID, --network none; no registry access of any kind' : false,
      providerCalls: false,
      localWrites: options.mode !== 'preview' ? 'fresh --out directory; generated Dockerfile/probe script, build/run logs and retained results only' : 'none',
    },
    limitations: [
      'Four original synthetic apps and a handful of scenarios each; this is not a framework conformance suite, a deep/taint engine or a supported-version matrix.',
      'Spring Boot/Security resolves its own managed dependency versions at acquisition time; the resolved spring-security-core version is recorded from that build, not assumed.',
      'A single successful probe run is one measurement, not a statistical claim; no repeated-trial statistics are computed here.',
    ],
  };
}

export const HARNESS_PATHS = Object.freeze([
  'scripts/sentinel-feasibility-frameworks.mjs',
  'scripts/sentinel-feasibility/frameworks/runtime.mjs',
  'scripts/sentinel-feasibility/frameworks/express.mjs',
  'scripts/sentinel-feasibility/frameworks/nest.mjs',
  'scripts/sentinel-feasibility/frameworks/next.mjs',
  'scripts/sentinel-feasibility/frameworks/spring.mjs',
  'scripts/sentinel-feasibility-scanners.mjs',
]);
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const cleanCommand = result => result?.exitCode === 0 && !result.spawnError && !result.timedOut && !result.cancelled && !result.outputExceeded && !result.exitSignal;
const abortCheck = signal => { if (signal?.aborted) throw new Error('FRAMEWORK_OPERATION_CANCELLED'); };
function selectCases(cases, defaults = Object.keys(FRAMEWORKS)) {
  const selected = cases?.length ? [...cases] : [...defaults];
  if (!selected.length || selected.some(id => !Object.hasOwn(FRAMEWORKS, id)) || new Set(selected).size !== selected.length) throw new Error('Unknown, duplicate or empty framework selection');
  return selected;
}
export async function readBoundedPlain(root, path, limit = MAX_EVIDENCE_BYTES) {
  root = resolve(root);
  const target = resolve(root, path);
  if (!path || target === root || isAbsolute(path) || relative(root, target).startsWith('..') || path.includes('\\')) throw new Error('UNSAFE_EVIDENCE_PATH');
  for (let directory = dirname(target);; directory = dirname(directory)) {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('EVIDENCE_PARENT_NOT_PLAIN');
    if (directory === root) break;
  }
  let handle;
  try {
    handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error('EVIDENCE_NOT_BOUNDED_REGULAR_FILE');
    const bytes = Buffer.alloc(info.size + 1); let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count !== info.size) throw new Error('EVIDENCE_CHANGED_DURING_READ');
    return bytes.subarray(0, count);
  } finally { await handle?.close(); }
}
async function command(runner, program, args, signal, limits = {}) {
  abortCheck(signal);
  const result = await runner(program, args, { timeout: 30_000, maxOutput: 1024 * 1024, ...limits, signal });
  abortCheck(signal);
  return result;
}
export async function gitProvenance(runner = execute, signal) {
  const revisionArgs = ['-C', REPO, 'rev-parse', 'HEAD'];
  const statusArgs = ['-C', REPO, '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', 'status', '--porcelain=v1', '--untracked-files=all', '--', ...HARNESS_PATHS, 'packages/sentinel/test/fixtures/framework-feasibility'];
  const revisionEvidence = await command(runner, 'git', revisionArgs, signal);
  const statusEvidence = await command(runner, 'git', statusArgs, signal);
  const revision = revisionEvidence.stdout?.trim();
  if (!cleanCommand(revisionEvidence) || !/^[a-f0-9]{40}$/.test(revision ?? '') || !cleanCommand(statusEvidence) || statusEvidence.stdout.trim()) throw Object.assign(new Error('CLEAN_COMPLETE_FRAMEWORK_PROVENANCE_REQUIRED'), { evidence: { revisionEvidence, statusEvidence } });
  return { revision, dirty: false, revisionCommand: ['git', ...revisionArgs], statusCommand: ['git', ...statusArgs], revisionEvidence, statusEvidence };
}
export async function harnessFileHashes() {
  const out = [];
  for (const path of HARNESS_PATHS) {
    const bytes = await readBoundedPlain(REPO, path);
    out.push({ path, sha256: digest(bytes), bytes: bytes.length });
  }
  return out;
}
export function expectedVersions(index, caseId) {
  const map = {};
  for (const candidate of index.candidates.filter(candidate => candidate.case === caseId)) {
    if (Object.hasOwn(map, candidate.id) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(candidate.version ?? '')) throw new Error('EXACT_UNIQUE_CANDIDATE_VERSIONS_REQUIRED');
    map[candidate.id] = candidate.version;
  }
  if (!Object.keys(map).length) throw new Error('MISSING_EXPECTED_CANDIDATE_VERSIONS');
  return map;
}
export function validateNpmLockVersions(lockText, expected) {
  let lock;
  try { lock = JSON.parse(lockText); } catch { return { valid: false, mismatches: Object.keys(expected).map(name => ({ name, expected: expected[name], resolved: null })), reason: 'invalid-lockfile-json' }; }
  const mismatches = [];
  for (const [name, expectedVersion] of Object.entries(expected)) {
    const resolved = lock.packages?.[`node_modules/${name}`]?.version ?? null;
    if (resolved !== expectedVersion) mismatches.push({ name, expected: expectedVersion, resolved });
  }
  return { valid: mismatches.length === 0, mismatches };
}

export function extractMavenResolvedVersions(treeText) {
  const versions = {};
  for (const match of treeText.matchAll(/([\w.-]+):([\w.-]+):(?:jar|pom):([\w.-]+):/g)) versions[`${match[1]}:${match[2]}`] = match[3];
  return versions;
}

export function validateMavenVersions(treeText, expected, pomText) {
  const resolved = extractMavenResolvedVersions(treeText);
  const mismatches = [];
  for (const [name, expectedVersion] of Object.entries(expected)) {
    let actual = resolved[name] ?? null;
    if (name === 'org.springframework.boot:spring-boot-starter-parent') {
      const parent = /<parent>([\s\S]*?)<\/parent>/.exec(pomText ?? '')?.[1] ?? '';
      actual = /<groupId>\s*org\.springframework\.boot\s*<\/groupId>/.test(parent) && /<artifactId>\s*spring-boot-starter-parent\s*<\/artifactId>/.test(parent) ? /<version>\s*([^<\s]+)\s*<\/version>/.exec(parent)?.[1] ?? null : null;
    }
    if (actual !== expectedVersion) mismatches.push({ name, expected: expectedVersion, resolved: actual });
  }
  const resolvedSecurityCore = resolved['org.springframework.security:spring-security-core'] ?? null;
  return { valid: mismatches.length === 0, mismatches, resolvedSpringSecurityCoreVersion: resolvedSecurityCore };
}

export async function runtimePlatform(runner = execute, signal, host = { os: platform(), arch: arch() }) {
  abortCheck(signal);
  const nativeHost = validateHost(host);
  const dockerVersion = await command(runner, 'docker', ['version', '--format', '{{json .}}'], signal);
  if (!cleanCommand(dockerVersion)) throw Object.assign(new Error('DOCKER_UNAVAILABLE_NO_FALLBACK'), { evidence: dockerVersion });
  const parsed = JSON.parse(dockerVersion.stdout);
  if (typeof parsed.Server?.Version !== 'string' || !/^\d+\.\d+\.\d+/.test(parsed.Server.Version)) throw new Error('DOCKER_SERVER_VERSION_UNAVAILABLE');
  try { return { host: nativeHost, ...validateDockerPlatform(dockerVersion, []), dockerVersion }; }
  catch (error) { error.evidence = dockerVersion; throw error; }
}
async function inspectImage(imageId, runtime, runner, signal) {
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId ?? '')) throw new Error('INVALID_ACQUIRED_IMAGE_ID');
  const inspection = await command(runner, 'docker', ['image', 'inspect', imageId], signal);
  if (!cleanCommand(inspection)) throw Object.assign(new Error('ACQUIRED_IMAGE_UNAVAILABLE_NO_ACQUISITION'), { evidence: inspection });
  const values = JSON.parse(inspection.stdout);
  if (!Array.isArray(values) || values.length !== 1 || values[0].Id !== imageId) throw new Error('ACQUIRED_IMAGE_IDENTITY_MISMATCH');
  let validated;
  try { validated = validateDockerPlatform(runtime.dockerVersion, [{ candidate: imageId, inspection }]); }
  catch (error) { error.evidence = inspection; throw error; }
  return { imageId, inspection, platform: validated.images[0] };
}
function sameSet(left, right) { return left.length === right.length && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort()); }
function validProvenance(value) {
  return value?.dirty === false && /^[a-f0-9]{40}$/.test(value.revision ?? '') && cleanCommand(value.revisionEvidence) && value.revisionEvidence.stdout.trim() === value.revision && cleanCommand(value.statusEvidence) && value.statusEvidence.stdout.trim() === '';
}
export function validateAcquisitionManifest(manifest, current, requestedCases) {
  if (manifest?.format !== ACQUISITION_FORMAT || manifest.state !== 'acquired' || !manifest.endedAt || !validProvenance(manifest.provenance)) throw new Error('INCOMPLETE_OR_DIRTY_ACQUISITION');
  const selection = selectCases(manifest.selectedCases);
  if (!Array.isArray(manifest.selectedCases) || !manifest.selectedCases.length || !Array.isArray(manifest.cases) || !sameSet(selection, manifest.cases.map(entry => entry?.caseId)) || new Set(manifest.cases.map(entry => entry?.caseId)).size !== selection.length) throw new Error('ACQUISITION_CASE_SET_MISMATCH');
  const requested = selectCases(requestedCases, selection);
  if (requested.some(id => !selection.includes(id)) || requested.some(id => manifest.cases.find(entry => entry.caseId === id)?.state !== 'acquired')) throw new Error('REQUESTED_CASE_NOT_ACQUIRED');
  if (manifest.corpus?.indexSha256 !== current.indexSha256) throw new Error('ACQUISITION_CORPUS_IDENTITY_MISMATCH');
  if (!Array.isArray(manifest.harness) || manifest.harness.length !== current.harness.length || new Set(manifest.harness.map(entry => entry?.path)).size !== current.harness.length ||
      current.harness.some(file => !manifest.harness.some(entry => entry.path === file.path && entry.sha256 === file.sha256 && entry.bytes === file.bytes))) throw new Error('ACQUISITION_HARNESS_IDENTITY_MISMATCH');
  if (!manifest.platform?.host || typeof manifest.platform.host.os !== 'string' || typeof manifest.platform.host.arch !== 'string' || !cleanCommand(manifest.platform.dockerVersion) ||
      Number(String(manifest.runtime?.node ?? '').split('.')[0]) < 24 || !/^\d+\./.test(manifest.runtime?.node ?? '') || manifest.runtime?.platform !== manifest.platform.host.os || manifest.runtime?.arch !== 'arm64') throw new Error('ACQUISITION_PLATFORM_EVIDENCE_REQUIRED');
  validateHost(manifest.platform.host);
  const acquiredDocker = JSON.parse(manifest.platform.dockerVersion.stdout);
  if (!/^\d+\.\d+\.\d+/.test(acquiredDocker.Server?.Version ?? '')) throw new Error('ACQUISITION_DOCKER_VERSION_UNAVAILABLE');
  validateDockerPlatform(manifest.platform.dockerVersion, []);
  return requested;
}
function evidenceNames(caseId) { return caseId === 'spring-chains' ? ['dependency-tree.txt', 'pom.xml'] : ['package-lock.json']; }
function expectedGenerated(caseId) {
  const framework = FRAMEWORKS[caseId];
  return [{ path: 'Dockerfile', text: framework.dockerfile() }, ...(typeof framework.probeScript === 'function' ? [{ path: 'probe.sh', text: framework.probeScript() }] : [])];
}
async function verifyBuildInputs(root, caseEntry, record) {
  const generated = expectedGenerated(caseEntry.id).map(file => ({ path: file.path, sha256: digest(Buffer.from(file.text)), bytes: Buffer.byteLength(file.text) }));
  if (!Array.isArray(record.materialized) || !sameSet(record.materialized.map(file => file.path), caseEntry.files.map(file => file.path)) || new Set(record.materialized.map(file => file.path)).size !== caseEntry.files.length ||
      caseEntry.files.some(file => !record.materialized.some(copy => copy.path === file.path && copy.sha256 === file.sha256))) throw new Error('ACQUISITION_SOURCE_INVENTORY_MISMATCH');
  if (!Array.isArray(record.generated) || !sameSet(record.generated.map(file => file.path), generated.map(file => file.path)) || new Set(record.generated.map(file => file.path)).size !== generated.length ||
      generated.some(file => !record.generated.some(copy => copy.path === file.path && copy.sha256 === file.sha256 && copy.bytes === file.bytes))) throw new Error('ACQUISITION_GENERATED_INPUT_MISMATCH');
  for (const file of [...record.materialized, ...record.generated]) {
    const bytes = await readBoundedPlain(root, `${caseEntry.id}/build/${file.path}`);
    if (digest(bytes) !== file.sha256 || bytes.length !== file.bytes) throw new Error('ACQUISITION_RETAINED_BUILD_INPUT_CHANGED');
  }
}
export function validateDependencyContainer(record, imageId, imagePath) {
  if (record?.state !== 'measured' || record.completed !== true || record.expectedImageId !== imageId || record.image !== imageId || !cleanCommand(record.execution) || record.cleanup?.state !== 'removed-owned-container') throw new Error('DEPENDENCY_EXTRACTION_NOT_COMPLETED');
  if (!Array.isArray(record.command) || record.command[record.command.indexOf('--entrypoint') + 1] !== 'cat' || !sameSet(record.command.slice(-2), [imageId, imagePath]) || record.command.at(-2) !== imageId || record.command.at(-1) !== imagePath) throw new Error('DEPENDENCY_EXTRACTION_COMMAND_MISMATCH');
  const before = JSON.parse(record.preStartInspect?.stdout ?? 'null'), after = JSON.parse(record.postStartInspect?.stdout ?? 'null');
  if (!cleanCommand(record.preStartInspect) || !cleanCommand(record.postStartInspect) || !Array.isArray(before) || before.length !== 1 || !Array.isArray(after) || after.length !== 1) throw new Error('DEPENDENCY_IMAGE_BINDING_UNAVAILABLE');
  const first = before[0], last = after[0];
  if (!/^[a-f0-9]{64}$/.test(first.Id ?? '') || last.Id !== first.Id || first.Image !== imageId || last.Image !== imageId || first.Config?.Image !== imageId || last.Config?.Image !== imageId || first.HostConfig?.NetworkMode !== 'none' || last.HostConfig?.NetworkMode !== 'none' ||
      first.Config?.Labels?.['org.farsight.sentinel-feasibility-frameworks.owner'] !== record.owner || last.Config?.Labels?.['org.farsight.sentinel-feasibility-frameworks.owner'] !== record.owner ||
      first.Config?.Labels?.['org.farsight.sentinel-feasibility-frameworks.case'] !== record.caseId || last.Config?.Labels?.['org.farsight.sentinel-feasibility-frameworks.case'] !== record.caseId ||
      last.State?.Status !== 'exited' || last.State?.Running !== false || last.State?.OOMKilled !== false || last.State?.Dead !== false || last.State?.ExitCode !== 0 || record.cleanup.id !== first.Id) throw new Error('DEPENDENCY_IMAGE_BINDING_MISMATCH');
  const absent = record.cleanup.verification;
  if (!Number.isInteger(absent?.exitCode) || absent.exitCode === 0 || absent.spawnError || absent.timedOut || absent.cancelled || absent.outputExceeded || absent.exitSignal ||
      !new RegExp(`^(?:Error(?: response from daemon)?:\\s*)?No such (?:object|container):\\s*${first.Id}\\s*$`, 'i').test((absent.stderr ?? '').trim())) throw new Error('DEPENDENCY_EXTRACTION_CLEANUP_UNVERIFIED');
  const bytes = Buffer.from(record.execution.stdout, 'utf8');
  if (record.execution.stdoutSha256 !== digest(bytes) || record.execution.stderrSha256 !== digest(Buffer.from(record.execution.stderr ?? '', 'utf8'))) throw new Error('DEPENDENCY_STREAM_HASH_MISMATCH');
  return bytes;
}
async function extractDependencies(caseId, imageId, runner, signal, pending) {
  const observations = [];
  for (const imagePath of evidenceNames(caseId)) {
    abortCheck(signal);
    const extraction = await runOwnedContainer({ expectedImageId: imageId, image: imageId, caseId, entrypoint: 'cat', command: [imagePath] }, runner, signal);
    pending?.push({ imagePath, imageId, extraction });
    const bytes = validateDependencyContainer(extraction, imageId, imagePath);
    if (bytes.length > MAX_EVIDENCE_BYTES) throw new Error('DEPENDENCY_EVIDENCE_TOO_LARGE');
    observations.push({ imagePath, imageId, bytes: bytes.length, sha256: digest(bytes), extraction, bytesData: bytes });
  }
  return observations;
}
function versionCheck(caseId, evidence, index) {
  const expected = expectedVersions(index, caseId);
  return caseId === 'spring-chains' ? validateMavenVersions(evidence[0].bytesData.toString('utf8'), expected, evidence[1].bytesData.toString('utf8')) : validateNpmLockVersions(evidence[0].bytesData.toString('utf8'), expected);
}
async function acquireOneCase(caseId, outDir, corpus, runtime, runner, signal) {
  const framework = FRAMEWORKS[caseId], caseEntry = corpus.index.cases.find(entry => entry.id === caseId);
  const record = { caseId, tag: `sentinel-feasibility-frameworks-${caseId}-${randomUUID()}`.toLowerCase(), state: 'failed' };
  try {
    abortCheck(signal); expectedVersions(corpus.index, caseId);
    const buildDir = join(outDir, caseId, 'build'); await fs.mkdir(buildDir, { recursive: true });
    record.materialized = await materializeCase(caseEntry, buildDir, CORPUS);
    record.generated = [];
    for (const generated of expectedGenerated(caseId)) record.generated.push(await writeGeneratedFile(buildDir, generated.path, generated.text, generated.path === 'probe.sh' ? 0o755 : 0o644));
    await verifyBuildInputs(outDir, caseEntry, record); abortCheck(signal);
    record.build = await buildImage({ buildDir, tag: record.tag }, runner, signal); abortCheck(signal);
    if (!record.build.ok || !cleanCommand(record.build.build)) throw new Error('IMAGE_BUILD_FAILED_OR_WRONG_PLATFORM');
    record.imageId = record.build.imageId;
    record.imageIdentity = await inspectImage(record.imageId, runtime, runner, signal);
    record.imagePlatform = { os: record.imageIdentity.platform.os, arch: record.imageIdentity.platform.arch };
    await verifyBuildInputs(outDir, caseEntry, record);
    record.pendingDependencyExtractions = [];
    const evidence = await extractDependencies(caseId, record.imageId, runner, signal, record.pendingDependencyExtractions);
    const checked = versionCheck(caseId, evidence, corpus.index);
    record.dependencyEvidence = [];
    for (const { bytesData, ...entry } of evidence) {
      const path = `${caseId}/${entry.imagePath}`;
      await fs.writeFile(join(outDir, path), bytesData, { flag: 'wx', mode: 0o600 });
      record.dependencyEvidence.push({ ...entry, path });
    }
    delete record.pendingDependencyExtractions;
    record.versionCheck = checked;
    if (!checked.valid) throw new Error('RESOLVED_DEPENDENCY_VERSION_MISMATCH');
    abortCheck(signal); record.state = 'acquired';
  } catch (error) { record.reason = scrub(error.message); if (error.evidence) record.failureEvidence = error.evidence; }
  return record;
}
async function beginEnvelope(options, format, selectedCases) {
  const out = resolve(options.out); await fs.mkdir(out, { mode: 0o700 });
  const envelope = { format, startedAt: new Date().toISOString(), state: 'running', selectedCases, runtime: { node: process.versions.node, platform: platform(), arch: arch() }, cases: [] };
  return { out, envelope, persist: () => fs.writeFile(join(out, format === ACQUISITION_FORMAT ? 'acquisition.json' : 'results.json'), scrub(JSON.stringify(envelope, null, 2)) + '\n', { mode: 0o600 }) };
}
function finishEnvelope(envelope, successState, signal) {
  if (signal?.aborted) { envelope.state = 'failed'; envelope.reason = 'FRAMEWORK_OPERATION_CANCELLED'; }
  for (const caseId of envelope.selectedCases) if (!envelope.cases.some(entry => entry.caseId === caseId)) envelope.cases.push({ caseId, state: 'not-run', reason: envelope.reason ?? 'EARLIER_CASE_FAILED' });
  if (envelope.state !== 'failed') envelope.state = envelope.cases.every(entry => entry.state === successState) ? (successState === 'acquired' ? 'acquired' : 'measured') : 'failed';
  envelope.endedAt = new Date().toISOString();
}
async function verifyFinalInputs(envelope, runner, signal) {
  envelope.finalProvenance = await gitProvenance(runner, signal);
  const current = await loadCorpus(CORPUS), harness = await harnessFileHashes();
  if (current.indexSha256 !== envelope.corpus.indexSha256 || JSON.stringify(harness) !== JSON.stringify(envelope.harness)) throw new Error('FRAMEWORK_INPUTS_CHANGED_DURING_OPERATION');
}
export async function runAcquire(options, { runner = execute, signal, host } = {}) {
  abortCheck(signal); const selected = selectCases(options.cases);
  const { out, envelope, persist } = await beginEnvelope(options, ACQUISITION_FORMAT, selected);
  try {
    await persist();
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('NODE24_REQUIRED');
    envelope.provenance = await gitProvenance(runner, signal);
    const corpus = await loadCorpus(CORPUS); envelope.corpus = { indexSha256: corpus.indexSha256 }; envelope.harness = await harnessFileHashes();
    envelope.platform = await runtimePlatform(runner, signal, host); await persist();
    for (const caseId of selected) {
      abortCheck(signal); envelope.activeCase = caseId; await persist();
      const record = await acquireOneCase(caseId, out, corpus, envelope.platform, runner, signal); envelope.cases.push(record); await persist();
      if (record.state !== 'acquired') throw new Error(record.reason ?? 'FRAMEWORK_ACQUISITION_FAILED');
    }
    await verifyFinalInputs(envelope, runner, signal);
  } catch (error) { envelope.state = 'failed'; envelope.reason = scrub(error.message); if (error.evidence) envelope.failureEvidence = error.evidence; }
  finally { finishEnvelope(envelope, 'acquired', signal); delete envelope.activeCase; await persist(); }
  return envelope;
}
export async function validateAcquiredEvidence(acquiredCase, root, corpus) {
  const caseEntry = corpus.index.cases.find(entry => entry.id === acquiredCase.caseId);
  await verifyBuildInputs(root, caseEntry, acquiredCase);
  const names = evidenceNames(acquiredCase.caseId);
  if (!Array.isArray(acquiredCase.dependencyEvidence) || !sameSet(acquiredCase.dependencyEvidence.map(entry => entry.imagePath), names) || new Set(acquiredCase.dependencyEvidence.map(entry => entry.imagePath)).size !== names.length) throw new Error('DEPENDENCY_EVIDENCE_INVENTORY_MISMATCH');
  const evidence = [];
  for (const imagePath of names) {
    const entry = acquiredCase.dependencyEvidence.find(entry => entry.imagePath === imagePath);
    if (entry.path !== `${acquiredCase.caseId}/${imagePath}` || entry.imageId !== acquiredCase.imageId) throw new Error('DEPENDENCY_EVIDENCE_IMAGE_MISMATCH');
    const bytes = await readBoundedPlain(root, entry.path);
    const extracted = validateDependencyContainer(entry.extraction, acquiredCase.imageId, imagePath);
    if (digest(bytes) !== entry.sha256 || bytes.length !== entry.bytes || !bytes.equals(extracted)) throw new Error('DEPENDENCY_EVIDENCE_IDENTITY_MISMATCH');
    evidence.push({ ...entry, bytesData: bytes });
  }
  const checked = versionCheck(acquiredCase.caseId, evidence, corpus.index);
  if (!checked.valid) throw new Error('RESOLVED_DEPENDENCY_VERSION_MISMATCH');
  return { evidence, versionCheck: checked };
}
async function runOneProbe(acquiredCase, root, corpus, runtime, runner, signal) {
  const record = { caseId: acquiredCase.caseId, imageId: acquiredCase.imageId, state: 'failed' };
  try {
    abortCheck(signal);
    record.acquisitionValidation = (await validateAcquiredEvidence(acquiredCase, root, corpus)).versionCheck;
    record.imageIdentity = await inspectImage(acquiredCase.imageId, runtime, runner, signal);
    record.pendingDependencyExtractions = [];
    const currentEvidence = await extractDependencies(acquiredCase.caseId, acquiredCase.imageId, runner, signal, record.pendingDependencyExtractions);
    record.dependencyVerification = currentEvidence.map(({ bytesData, ...entry }) => entry); delete record.pendingDependencyExtractions;
    if (currentEvidence.some(entry => !acquiredCase.dependencyEvidence.some(saved => saved.imagePath === entry.imagePath && saved.sha256 === entry.sha256 && saved.bytes === entry.bytes))) throw new Error('CURRENT_IMAGE_DEPENDENCY_EVIDENCE_CHANGED');
    const checked = versionCheck(acquiredCase.caseId, currentEvidence, corpus.index); record.versionCheck = checked;
    if (!checked.valid) throw new Error('RESOLVED_DEPENDENCY_VERSION_MISMATCH');
    const framework = FRAMEWORKS[acquiredCase.caseId], caseEntry = corpus.index.cases.find(entry => entry.id === acquiredCase.caseId);
    abortCheck(signal);
    record.probe = await runOwnedContainer({ expectedImageId: acquiredCase.imageId, image: acquiredCase.imageId, caseId: acquiredCase.caseId, extraEnv: framework.EXTRA_ENV ?? [] }, runner, signal);
    abortCheck(signal);
    if (record.probe.state !== 'measured') throw new Error('PROBE_CONTAINER_FAILED');
    const parsed = parseProbeOutput(record.probe.execution); record.parsedProbeOutput = parsed;
    if (!parsed.ok || parsed.payload.status !== 'ok') throw new Error('PROBE_PRODUCED_NO_SUCCESS_MARKER');
    record.assessment = framework.assess(caseEntry, parsed.payload.observations);
    const outcome = evaluateCaseOutcome(record.assessment); record.state = outcome.state; record.outcomeReason = outcome.reason;
  } catch (error) { record.reason = scrub(error.message); if (error.evidence) record.failureEvidence = error.evidence; }
  return record;
}
export async function runRun(options, { runner = execute, signal, host } = {}) {
  abortCheck(signal); const initialSelection = selectCases(options.cases);
  const { envelope, persist } = await beginEnvelope(options, RESULTS_FORMAT, initialSelection);
  try {
    await persist(); if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('NODE24_REQUIRED');
    envelope.provenance = await gitProvenance(runner, signal);
    const corpus = await loadCorpus(CORPUS); envelope.harness = await harnessFileHashes(); envelope.corpus = { indexSha256: corpus.indexSha256 };
    const bytes = await readBoundedPlain(options.acquired, 'acquisition.json', MAX_MANIFEST_BYTES);
    envelope.acquisition = { path: options.acquired, bytes: bytes.length, sha256: digest(bytes) };
    const manifest = JSON.parse(bytes);
    Object.assign(envelope.acquisition, { selectedCases: manifest.selectedCases, startedAt: manifest.startedAt, provenance: manifest.provenance });
    const selected = validateAcquisitionManifest(manifest, { indexSha256: corpus.indexSha256, harness: envelope.harness }, options.cases);
    envelope.selectedCases = selected;
    envelope.platform = await runtimePlatform(runner, signal, host); await persist();
    for (const caseId of selected) {
      abortCheck(signal); envelope.activeCase = caseId; await persist();
      const record = await runOneProbe(manifest.cases.find(entry => entry.caseId === caseId), options.acquired, corpus, envelope.platform, runner, signal); envelope.cases.push(record); await persist();
      if (record.state !== 'measured') throw new Error(record.reason ?? record.outcomeReason ?? 'FRAMEWORK_PROBE_FAILED');
    }
    await verifyFinalInputs(envelope, runner, signal);
  } catch (error) { envelope.state = 'failed'; envelope.reason = scrub(error.message); if (error.evidence) envelope.failureEvidence = error.evidence; }
  finally { finishEnvelope(envelope, 'measured', signal); delete envelope.activeCase; await persist(); }
  return envelope;
}

// Removes exactly the images this acquisition built, each verified present by its own exact
// content-addressed ID before removal; never a broader `docker image prune` or tag-based match.
export async function runDispose(options, runner = execute) {
  const manifest = JSON.parse(await readBoundedPlain(options.acquired, 'acquisition.json', MAX_MANIFEST_BYTES));
  if (manifest.format !== ACQUISITION_FORMAT) throw new Error('Unsupported acquisition manifest format');
  const selected = options.cases.length ? options.cases : Object.keys(FRAMEWORKS);
  const results = [];
  for (const caseId of selected) {
    const acquired = manifest.cases.find(c => c.caseId === caseId);
    if (!acquired?.imageId) { results.push({ caseId, state: 'nothing-to-dispose' }); continue; }
    const inspect = await runner('docker', ['image', 'inspect', '--format', '{{.Id}}', acquired.imageId], { timeout: 30_000 });
    if (!(Number.isInteger(inspect.exitCode) && inspect.exitCode === 0 && inspect.stdout.trim() === acquired.imageId)) { results.push({ caseId, state: 'already-absent', imageId: acquired.imageId }); continue; }
    const removed = await runner('docker', ['rmi', '--force', acquired.imageId], { timeout: 60_000 });
    const ok = Number.isInteger(removed.exitCode) && removed.exitCode === 0;
    const verify = await runner('docker', ['image', 'inspect', '--format', '{{.Id}}', acquired.imageId], { timeout: 30_000 });
    const verifiedAbsent = !(Number.isInteger(verify.exitCode) && verify.exitCode === 0);
    results.push({ caseId, imageId: acquired.imageId, state: ok && verifiedAbsent ? 'disposed' : 'dispose-failed' });
  }
  return { format: 'sentinel-feasibility-frameworks-dispose/draft-1', cases: results };
}

export function runHasFailures(result) {
  return !Array.isArray(result?.cases) || result.cases.length === 0 || result.state === 'failed' || result.cases.some(c => c.state !== 'measured');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Preview:  node scripts/sentinel-feasibility-frameworks.mjs [--case a,b]\n' +
      'Acquire:  node scripts/sentinel-feasibility-frameworks.mjs --acquire --out <fresh-dir> [--case a,b]\n' +
      'Run:      node scripts/sentinel-feasibility-frameworks.mjs --run --acquired <acquire-out-dir> --out <fresh-dir> [--case a,b]\n' +
      'Dispose:  node scripts/sentinel-feasibility-frameworks.mjs --dispose --acquired <acquire-out-dir> [--case a,b]');
    return;
  }
  if (options.mode === 'preview') { console.log(JSON.stringify(preview(options), null, 2)); return; }
  if (options.mode === 'dispose') {
    const result = await runDispose(options);
    console.log(JSON.stringify(result, null, 2));
    if (result.cases.some(c => c.state === 'dispose-failed')) process.exitCode = 1;
    return;
  }
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  let result;
  try { result = options.mode === 'acquire' ? await runAcquire(options, { signal: controller.signal }) : await runRun(options, { signal: controller.signal }); }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  const summary = options.mode === 'acquire'
    ? { format: result.format, cases: result.cases.map(c => ({ caseId: c.caseId, state: c.state, reason: c.reason })) }
    : { format: result.format, cases: result.cases.map(c => ({ caseId: c.caseId, state: c.state, reason: c.reason ?? c.outcomeReason })) };
  console.log(JSON.stringify(summary, null, 2));
  const failed = options.mode === 'acquire' ? result.state !== 'acquired' || result.cases.some(c => c.state !== 'acquired') : result.state !== 'measured' || runHasFailures(result);
  if (failed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`sentinel-feasibility-frameworks: ${scrub(error.message)}`); process.exitCode = 1; });
