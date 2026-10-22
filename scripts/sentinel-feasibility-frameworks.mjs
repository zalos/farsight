#!/usr/bin/env node
// PR 01 E2 framework prototype only. Not a production Sentinel scanner, framework adapter or support
// claim. Two explicit, separate steps: `--acquire` builds one pinned image per framework (network
// allowed; docker build only) and freezes its exact content-addressed image ID plus resolved dependency
// evidence into a manifest; `--run` consumes that frozen manifest by exact image ID only — it never
// builds, pulls or re-resolves anything — and probes the already-acquired image with --network none,
// observing real HTTP responses instead of assuming them from source text.
// See docs/proposals/farsight-sentinel/framework-feasibility.md.
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { platform, arch } from 'node:os';
import {
  execute, scrub, loadCorpus, materializeCase, writeGeneratedFile, buildImage, runOwnedContainer,
  parseProbeOutput, evaluateCaseOutcome, BASE_IMAGES, CORPUS,
} from './sentinel-feasibility/frameworks/runtime.mjs';
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

async function gitProvenance() {
  let revision = 'unavailable', dirty = true;
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { /* leave defaults */ }
  return { revision, dirty };
}

// Every named harness file must hash successfully; a missing one is a hard failure, never a silently
// incomplete provenance record.
async function harnessFileHashes() {
  const paths = [
    'scripts/sentinel-feasibility-frameworks.mjs',
    'scripts/sentinel-feasibility/frameworks/runtime.mjs',
    'scripts/sentinel-feasibility/frameworks/express.mjs',
    'scripts/sentinel-feasibility/frameworks/nest.mjs',
    'scripts/sentinel-feasibility/frameworks/next.mjs',
    'scripts/sentinel-feasibility/frameworks/spring.mjs',
  ];
  const out = [];
  for (const path of paths) {
    const bytes = await fs.readFile(resolve(REPO, path));
    out.push({ path, sha256: digest(bytes), bytes: bytes.length });
  }
  return out;
}

function expectedVersions(index, caseId) {
  const map = {};
  for (const candidate of index.candidates) if (candidate.case === caseId && /^\d/.test(candidate.version ?? '')) map[candidate.id] = candidate.version;
  return map;
}

function validateNpmLockVersions(lockText, expected) {
  let lock;
  try { lock = JSON.parse(lockText); } catch { return { valid: false, mismatches: Object.keys(expected).map(name => ({ name, expected: expected[name], resolved: null })), reason: 'invalid-lockfile-json' }; }
  const mismatches = [];
  for (const [name, expectedVersion] of Object.entries(expected)) {
    const resolved = lock.packages?.[`node_modules/${name}`]?.version ?? null;
    if (resolved !== expectedVersion) mismatches.push({ name, expected: expectedVersion, resolved });
  }
  return { valid: mismatches.length === 0, mismatches };
}

function extractMavenResolvedVersions(treeText) {
  const versions = {};
  for (const match of treeText.matchAll(/([\w.-]+):([\w.-]+):(?:jar|pom):([\w.-]+):/g)) versions[`${match[1]}:${match[2]}`] = match[3];
  return versions;
}

function validateMavenVersions(treeText, expected) {
  const resolved = extractMavenResolvedVersions(treeText);
  const mismatches = [];
  for (const [name, expectedVersion] of Object.entries(expected)) {
    if (name.endsWith(':spring-boot-starter-parent')) continue; // the parent POM itself, not a dependency-tree node
    const actual = resolved[name] ?? null;
    if (actual !== expectedVersion) mismatches.push({ name, expected: expectedVersion, resolved: actual });
  }
  const resolvedSecurityCore = resolved['org.springframework.security:spring-security-core'] ?? null;
  return { valid: mismatches.length === 0, mismatches, resolvedSpringSecurityCoreVersion: resolvedSecurityCore };
}

async function acquireOneCase(caseId, outDir, runner, signal) {
  const framework = FRAMEWORKS[caseId];
  const { index } = await loadCorpus(CORPUS);
  const caseEntry = index.cases.find(c => c.id === caseId);
  if (!caseEntry) throw new Error(`Unknown case in corpus: ${caseId}`);
  const buildDir = join(outDir, caseId, 'build');
  await fs.mkdir(buildDir, { recursive: true });
  const materialized = await materializeCase(caseEntry, buildDir, CORPUS);
  const dockerfile = framework.dockerfile();
  const generated = [await writeGeneratedFile(buildDir, 'Dockerfile', dockerfile)];
  if (typeof framework.probeScript === 'function') generated.push(await writeGeneratedFile(buildDir, 'probe.sh', framework.probeScript(), 0o755));
  const tag = `sentinel-feasibility-frameworks-${caseId}-${randomUUID()}`.toLowerCase();
  const build = await buildImage({ buildDir, tag }, runner, signal);
  const record = { caseId, tag, materialized, generated, build, state: 'failed' };
  if (!build.ok) { record.reason = 'image-build-failed-or-wrong-platform'; return record; }
  record.imageId = build.imageId;
  record.imagePlatform = build.imagePlatform;

  const evidencePath = caseId === 'spring-chains' ? 'dependency-tree.txt' : 'package-lock.json';
  const evidence = await runOwnedContainer({ expectedImageId: build.imageId, image: build.imageId, caseId, entrypoint: 'cat', command: [evidencePath] }, runner, signal);
  record.acquisitionEvidenceContainer = evidence;
  if (evidence.state !== 'measured') { record.reason = 'dependency-evidence-extraction-failed'; return record; }
  const evidenceText = evidence.execution.stdout;
  const expected = expectedVersions(index, caseId);
  const versionCheck = caseId === 'spring-chains' ? validateMavenVersions(evidenceText, expected) : validateNpmLockVersions(evidenceText, expected);
  record.dependencyEvidence = { path: evidencePath, bytes: evidenceText.length, sha256: digest(Buffer.from(evidenceText)), versionCheck };
  if (!versionCheck.valid) { record.reason = 'resolved-dependency-version-mismatch'; return record; }

  record.state = 'acquired';
  return record;
}

export async function runAcquire(options) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 or newer required');
  const dockerVersion = await execute('docker', ['version', '--format', '{{json .}}'], { timeout: 30_000 });
  if (!(Number.isInteger(dockerVersion.exitCode) && dockerVersion.exitCode === 0)) throw new Error('Docker unavailable; no host fallback');
  const out = resolve(options.out);
  await fs.mkdir(out); // Exclusive: existing evidence is never replaced.
  const { indexSha256 } = await loadCorpus(CORPUS);
  const selected = options.cases.length ? options.cases : Object.keys(FRAMEWORKS);
  const manifest = {
    format: ACQUISITION_FORMAT, startedAt: new Date().toISOString(),
    provenance: await gitProvenance(), runtime: { node: process.versions.node, platform: platform(), arch: arch() },
    corpus: { indexSha256 }, harness: await harnessFileHashes(), cases: [],
  };
  for (const caseId of selected) {
    const record = await acquireOneCase(caseId, out, execute);
    manifest.cases.push(record);
  }
  manifest.endedAt = new Date().toISOString();
  await fs.writeFile(join(out, 'acquisition.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

async function runOneProbe(acquiredCase, runner, signal) {
  const framework = FRAMEWORKS[acquiredCase.caseId];
  const { index } = await loadCorpus(CORPUS);
  const caseEntry = index.cases.find(c => c.id === acquiredCase.caseId);
  // Verify, by exact content-addressed ID, that the acquired image still exists locally. Never build,
  // never pull: a missing or changed image fails this case outright.
  const inspect = await runner('docker', ['image', 'inspect', '--format', '{{.Id}}', acquiredCase.imageId], { timeout: 30_000, signal });
  const stillPresent = Number.isInteger(inspect.exitCode) && inspect.exitCode === 0 && inspect.stdout.trim() === acquiredCase.imageId;
  if (!stillPresent) return { caseId: acquiredCase.caseId, state: 'failed', reason: 'acquired-image-missing-or-changed-since-acquisition', inspect };
  const probe = await runOwnedContainer({ expectedImageId: acquiredCase.imageId, image: acquiredCase.imageId, caseId: acquiredCase.caseId, extraEnv: framework.EXTRA_ENV ?? [] }, runner, signal);
  const record = { caseId: acquiredCase.caseId, tag: acquiredCase.tag, imageId: acquiredCase.imageId, probe, state: 'failed' };
  if (probe.state !== 'measured') { record.reason = 'probe-container-failed'; return record; }
  const parsed = parseProbeOutput(probe.execution);
  record.parsedProbeOutput = parsed;
  if (!parsed.ok) { record.reason = 'probe-produced-no-usable-marker-line'; return record; }
  if (parsed.payload.status !== 'ok') { record.reason = `probe-reported-${parsed.payload.status}`; return record; }
  record.assessment = framework.assess(caseEntry, parsed.payload.observations);
  const outcome = evaluateCaseOutcome(record.assessment);
  record.state = outcome.state; record.outcomeReason = outcome.reason;
  return record;
}

export async function runRun(options) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 or newer required');
  const manifest = JSON.parse(await fs.readFile(join(options.acquired, 'acquisition.json')));
  if (manifest.format !== ACQUISITION_FORMAT) throw new Error('Unsupported acquisition manifest format');
  const out = resolve(options.out);
  await fs.mkdir(out); // Exclusive: existing evidence is never replaced.
  const selected = options.cases.length ? options.cases : Object.keys(FRAMEWORKS);
  const envelope = {
    format: RESULTS_FORMAT, startedAt: new Date().toISOString(),
    provenance: await gitProvenance(), runtime: { node: process.versions.node, platform: platform(), arch: arch() },
    harness: await harnessFileHashes(), acquisition: { path: options.acquired, startedAt: manifest.startedAt, provenance: manifest.provenance },
    cases: [],
  };
  for (const caseId of selected) {
    const acquired = manifest.cases.find(c => c.caseId === caseId);
    if (!acquired || acquired.state !== 'acquired') { envelope.cases.push({ caseId, state: 'failed', reason: 'case-was-not-successfully-acquired' }); continue; }
    envelope.cases.push(await runOneProbe(acquired, execute));
  }
  envelope.endedAt = new Date().toISOString();
  await fs.writeFile(join(out, 'results.json'), JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx' });
  return envelope;
}

// Removes exactly the images this acquisition built, each verified present by its own exact
// content-addressed ID before removal; never a broader `docker image prune` or tag-based match.
export async function runDispose(options, runner = execute) {
  const manifest = JSON.parse(await fs.readFile(join(options.acquired, 'acquisition.json')));
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
  return Array.isArray(result?.cases) && result.cases.some(c => c.state === 'failed' || c.state === 'measured-with-mismatch');
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
  const result = options.mode === 'acquire' ? await runAcquire(options) : await runRun(options);
  const summary = options.mode === 'acquire'
    ? { format: result.format, cases: result.cases.map(c => ({ caseId: c.caseId, state: c.state, reason: c.reason })) }
    : { format: result.format, cases: result.cases.map(c => ({ caseId: c.caseId, state: c.state, reason: c.reason ?? c.outcomeReason })) };
  console.log(JSON.stringify(summary, null, 2));
  const failed = options.mode === 'acquire' ? result.cases.some(c => c.state !== 'acquired') : runHasFailures(result);
  if (failed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`sentinel-feasibility-frameworks: ${scrub(error.message)}`); process.exitCode = 1; });
