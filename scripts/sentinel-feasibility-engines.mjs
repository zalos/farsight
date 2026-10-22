#!/usr/bin/env node
// Original PR01 E3 experiment only; no production adapter or support contract.
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANDIDATES, execute, scrub, validateHost, verifyBinary, validateDockerPlatform, runContainer } from './sentinel-feasibility-scanners.mjs';
import { hash, loadCorpus, materialize, readPlain } from './sentinel-feasibility/engine-matrix/corpus.mjs';
import { assess, controls, proposals } from './sentinel-feasibility/engine-matrix/assess.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'packages/sentinel/test/fixtures/engine-feasibility');
const OWNED = ['scripts/sentinel-feasibility-engines.mjs', 'scripts/sentinel-feasibility/engine-matrix/corpus.mjs', 'scripts/sentinel-feasibility/engine-matrix/assess.mjs', 'scripts/sentinel-feasibility-scanners.mjs'];
const ok = r => r?.exitCode === 0 && !r.timedOut && !r.outputExceeded && !r.cancelled && !r.spawnError && !r.exitSignal;
export function parseArgs(args) {
  const options = { run: false };
  for (let n = 0; n < args.length; n++) {
    const arg = args[n];
    if (arg === '--run') options.run = true;
    else if (arg === '--help') options.help = true;
    else if (arg === '--out' || arg === '--opengrep-binary') {
      if (!args[n + 1] || args[n + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[arg === '--out' ? 'out' : 'binary'] = resolve(args[++n]);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.run && (!options.out || !options.binary)) throw new Error('--run requires fresh --out and pinned --opengrep-binary');
  if (options.out?.includes(',')) throw new Error('Output mount path cannot contain comma');
  return options;
}
export function scanCommand(mode, candidate, missing = false) {
  return ['--json', '--verbose', '--dataflow-traces', ...(candidate.id === 'semgrep' ? ['--metrics=off'] : []), '--disable-version-check', '--jobs', '1', '--timeout', '20', '--max-target-bytes', '4096', '--config', missing ? '/rules/not-present.yaml' : `/rules/${mode}.yaml`, '/input'];
}
export function preview() {
  return { schemaVersion: 'sentinel-engine-matrix-v1', mode: 'preview', candidates: CANDIDATES,
    sourcePolicy: 'Original inert fixtures only; source read only, never executed, built, installed or loaded as plugins.',
    executionPolicy: 'Native ARM64 only; fixed pinned container flags and exact-owner cleanup from sentinel-feasibility-scanners.mjs; no host fallback, acquisition or retry.',
    input: 'packages/sentinel/test/fixtures/engine-feasibility/index.json',
    denominator: { validFiles: 9, positiveSymbols: 9, safeSymbols: 9, inputControlsOutsideCapability: 3 },
    scenarios: ['version', 'valid-pattern', 'valid-taint', 'partial', 'out-of-rule-language', 'oversize', 'missing-rules'],
    effects: { writes: false, containerExecution: false, network: false, providerCalls: false },
    limits: { commandMs: 120000, outputBytes: 4194304, engineJobs: 1, ruleTimeoutSeconds: 20, maxTargetBytes: 4096, memoryBytes: 2147483648, cpus: 2, pids: 128 },
    decision: 'Only proposed micro-corpus criteria are evaluated; capability acceptance and pattern-default selection belong to the lead/owner.' };
}
async function provenance(runner, corpus) {
  const revision = await runner('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { timeout: 30000 });
  const status = await runner('git', ['-C', ROOT, 'status', '--porcelain=v1', '--untracked-files=all', '--', ...OWNED, 'packages/sentinel/test/fixtures/engine-feasibility'], { timeout: 30000 });
  if (!ok(revision) || !/^[a-f0-9]{40}$/.test(revision.stdout.trim()) || !ok(status)) throw new Error('Probe revision/status evidence unavailable');
  if (status.stdout.trim()) throw new Error('Commit probe, helper and corpus before measuring for clean provenance');
  const scripts = [];
  for (const path of OWNED) scripts.push({ path, sha256: hash(await readPlain(ROOT, path)) });
  return { revision: revision.stdout.trim(), dirty: false, scripts, corpusIndexSha256: corpus.indexSha256, revisionEvidence: revision, statusEvidence: status };
}
export async function runProbe(options, { runner = execute, signal } = {}) {
  const host = validateHost();
  const binary = await verifyBinary(options.binary);
  if (binary.path.includes(',')) throw new Error('Binary path cannot contain comma');
  const corpus = await loadCorpus(CORPUS);
  const identity = await provenance(runner, corpus);
  const dockerVersion = await runner('docker', ['version', '--format', '{{json .}}'], { timeout: 30000, signal });
  if (!ok(dockerVersion)) throw new Error('Docker unavailable; no host fallback');
  const images = [];
  for (const candidate of CANDIDATES) {
    const inspection = await runner('docker', ['image', 'inspect', candidate.image], { timeout: 30000, signal });
    if (!ok(inspection)) throw new Error('Pinned image absent; no acquisition/fallback');
    images.push({ candidate: candidate.id, inspection });
  }
  const platform = { host, ...validateDockerPlatform(dockerVersion, images) };
  await mkdir(options.out); await chmod(options.out, 0o755);
  const { dirs, inventory } = await materialize(options.out, corpus);
  const tools = join(options.out, 'tools'); await mkdir(tools); await chmod(tools, 0o755);
  const binaryBytes = await readFile(binary.path);
  if (hash(binaryBytes) !== binary.sha256) throw new Error('Verified binary changed');
  const copied = join(tools, 'opengrep'); await writeFile(copied, binaryBytes, { flag: 'wx', mode: 0o555 }); await chmod(copied, 0o555);
  const result = { ...preview(), mode: 'run', effects: { writes: 'fresh output only', containerExecution: true, network: 'none inside containers', providerCalls: false },
    startedAt: new Date().toISOString(), nodeVersion: process.version, provenance: identity, platform, dockerVersion, images,
    binary: { sha256: binary.sha256, bytes: binary.bytes }, inputs: inventory, independentLabels: corpus.index.labels,
    labelReview: corpus.index.labelReview, thresholdProposals: corpus.index.thresholdProposals, denominator: corpus.index.denominator,
    stageInventory: Object.fromEntries(Object.entries(dirs).map(([stage]) => [stage, inventory.filter(f => f.stage === stage).map(f => f.path)])), trials: [], state: 'running' };
  const persist = async () => {
    const bytes = JSON.stringify(result, null, 2) + '\n';
    await writeFile(join(options.out, 'results.json'), bytes, { mode: 0o600 });
    await writeFile(join(options.out, 'results.sha256'), hash(bytes) + '\n', { mode: 0o600 });
  };
  await persist();
  try {
    for (const candidate of CANDIDATES) {
      for (const scenario of preview().scenarios) {
        if (signal?.aborted) throw new Error('Probe cancelled');
        const mode = scenario === 'valid-taint' ? 'taint' : 'pattern';
        const stage = scenario.startsWith('valid-') || ['version', 'missing-rules'].includes(scenario) ? 'valid' : scenario;
        const trial = await runContainer({ candidate, scenario, source: dirs[stage], rules: dirs.rules, binary: copied,
          command: scenario === 'version' ? ['--version'] : scanCommand(mode, candidate, scenario === 'missing-rules') }, runner, signal);
        if (scenario === 'version') {
          trial.observedVersion = trial.execution?.stdout?.trim();
          trial.versionMatches = new RegExp(`(^|\\s)${candidate.version.replaceAll('.', '\\.')}($|\\s)`).test(trial.observedVersion ?? '');
        } else trial.assessment = assess(trial, { index: corpus.index, mode, stage: scenario === 'missing-rules' ? 'missing-rules' : stage });
        trial.controls = controls(trial); result.trials.push(trial); await persist();
        if (trial.cleanup?.state !== 'removed-owned-container') throw new Error('Owned container cleanup not verified; aborting');
        if (!trial.controls.passed) throw new Error(`Measurement controls failed for ${candidate.id}/${scenario}; no retry`);
      }
    }
  } catch (error) { result.state = 'failed'; result.reason = scrub(error.message); }
  finally {
    result.inputIntegrity = [];
    for (const input of inventory) {
      try { result.inputIntegrity.push({ path: input.outputRelativePath, unchanged: hash(await readPlain(options.out, input.outputRelativePath)) === input.sha256 }); }
      catch (error) { result.inputIntegrity.push({ path: input.outputRelativePath, unchanged: false, reason: scrub(error.message) }); }
    }
    result.binaryUnchanged = hash(await readFile(copied)) === binary.sha256;
    result.proposedCriteria = proposals(result.trials);
    result.controlsPassed = result.trials.length === 14 && result.trials.every(t => t.controls.passed) && result.inputIntegrity.every(f => f.unchanged) && result.binaryUnchanged;
    if (result.state !== 'failed') result.state = result.controlsPassed ? 'measured-with-explicit-gaps' : 'failed';
    result.endedAt = new Date().toISOString(); await persist();
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log('Usage: node scripts/sentinel-feasibility-engines.mjs [--run --out <fresh-directory> --opengrep-binary <pinned-binary>]');
    else if (!options.run) console.log(JSON.stringify(preview(), null, 2));
    else {
      const controller = new AbortController(), cancel = () => controller.abort();
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      try {
        const result = await runProbe(options, { signal: controller.signal });
        console.log(JSON.stringify({ state: result.state, controlsPassed: result.controlsPassed, trials: result.trials.length, proposedCriteria: result.proposedCriteria }));
        if (result.state === 'failed') process.exitCode = 1;
      } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    }
  } catch (error) { console.error(scrub(error.message)); process.exitCode = 1; }
}
