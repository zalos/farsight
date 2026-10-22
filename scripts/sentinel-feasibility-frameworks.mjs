#!/usr/bin/env node
// PR 01 E2 framework prototype only. Not a production Sentinel scanner, framework adapter or support
// claim. Builds one pinned original fixture app per framework (acquisition: docker build, network
// allowed) and runs it with --network none (execution: no network), observing real HTTP responses
// instead of assuming them from source text. See docs/proposals/farsight-sentinel/framework-feasibility.md.
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, dirname, basename, sep, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { platform, arch } from 'node:os';
import {
  execute, scrub, loadCorpus, materializeCase, writeGeneratedFile, buildImage, runProbeContainer,
  parseProbeOutput, BASE_IMAGES, CORPUS,
} from './sentinel-feasibility/frameworks/runtime.mjs';
import * as expressFramework from './sentinel-feasibility/frameworks/express.mjs';
import * as nestFramework from './sentinel-feasibility/frameworks/nest.mjs';
import * as nextFramework from './sentinel-feasibility/frameworks/next.mjs';
import * as springFramework from './sentinel-feasibility/frameworks/spring.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

const FRAMEWORKS = Object.freeze({
  'express-order': expressFramework,
  'nest-validation': nestFramework,
  'next-matcher': nextFramework,
  'spring-chains': springFramework,
});

export function parseArgs(args) {
  const options = { run: false, cases: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--run') { if (options.run) throw new Error('Duplicate --run'); options.run = true; }
    else if (arg === '--help') options.help = true;
    else if (arg === '--case' || arg === '--out') {
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value: ${arg}`);
      if (arg === '--case') options.cases.push(...value.split(',')); else options.out = resolve(value);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.cases.some(id => !FRAMEWORKS[id]) || new Set(options.cases).size !== options.cases.length) throw new Error('Unknown or duplicate --case selection');
  if (options.run && !options.out) throw new Error('--run requires a fresh --out directory');
  if (!options.run && options.out) throw new Error('--out requires --run');
  return options;
}

export function preview(options = {}) {
  const selected = options.cases?.length ? options.cases : Object.keys(FRAMEWORKS);
  return {
    schemaVersion: 'sentinel-feasibility-frameworks-v1',
    mode: options.run ? 'run' : 'preview',
    purpose: 'PR 01 E2 framework evidence: real no-network runtime observation kept distinct from the source-grounded static label for each scenario. Not a production Sentinel framework adapter.',
    cases: selected,
    baseImages: BASE_IMAGES,
    effects: {
      acquisition: options.run ? 'docker build only, per selected case; network allowed; no bespoke download in this script' : false,
      execution: 'docker run --network none; no egress from the probed container',
      providerCalls: false,
      localWrites: options.run ? 'fresh --out directory; generated Dockerfile/probe script, build logs and retained results only' : 'none',
    },
    limitations: [
      'Four original synthetic apps and a handful of scenarios each; this is not a framework conformance suite, a deep/taint engine or a supported-version matrix.',
      'The Next.js candidate runs without --read-only (observed runtime trace writes); the other three run with --read-only. See framework-feasibility.md.',
      'Spring Boot/Security resolves its own managed dependency versions at build time; the resolved spring-security-core version is recorded from that build, not assumed.',
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
  for (const path of paths) { try { const bytes = await fs.readFile(resolve(REPO, path)); out.push({ path, sha256: digest(bytes), bytes: bytes.length }); } catch { /* skip */ } }
  return out;
}

// Reads one baked-in file from the already-built image with no network, as acquisition evidence
// (resolved package-lock.json or a Maven dependency tree). Read-only; never mutates the image.
async function extractAcquisitionEvidence(tag, path, runner = execute) {
  const result = await runner('docker', ['run', '--rm', '--platform', 'linux/arm64', '--network', 'none', '--entrypoint', 'cat', tag, path], { timeout: 30_000 });
  const ok = Number.isInteger(result.exitCode) && result.exitCode === 0 && !result.spawnError && !result.timedOut;
  return { path, ok, bytes: ok ? result.stdout.length : 0, sha256: ok ? digest(Buffer.from(result.stdout)) : null, result };
}

async function runOneCase(caseId, outDir, runner, signal) {
  const framework = FRAMEWORKS[caseId];
  const { index } = await loadCorpus(CORPUS);
  const caseEntry = index.cases.find(c => c.id === caseId);
  if (!caseEntry) throw new Error(`Unknown case in corpus: ${caseId}`);
  const caseDir = join(outDir, caseId);
  const buildDir = join(caseDir, 'build');
  await fs.mkdir(buildDir, { recursive: true });
  const materialized = await materializeCase(caseEntry, buildDir, CORPUS);
  const dockerfile = framework.dockerfile();
  const generated = [await writeGeneratedFile(buildDir, 'Dockerfile', dockerfile)];
  if (typeof framework.probeScript === 'function') generated.push(await writeGeneratedFile(buildDir, 'probe.sh', framework.probeScript(), 0o755));
  const tag = `sentinel-feasibility-frameworks-${caseId}-${randomUUID()}`.toLowerCase();
  const build = await buildImage({ buildDir, tag }, runner, signal);
  const record = { caseId, materialized, generated, tag, build, state: 'failed' };
  if (!build.ok) { record.reason = 'image-build-failed'; return record; }
  record.acquisitionEvidence = caseId === 'spring-chains'
    ? await extractAcquisitionEvidence(tag, 'dependency-tree.txt', runner)
    : await extractAcquisitionEvidence(tag, 'package-lock.json', runner);
  const readOnly = framework.READ_ONLY ?? true;
  record.probe = await runProbeContainer({ tag, caseId, readOnly }, runner, signal);
  if (record.probe.state !== 'measured') { record.reason = 'probe-container-failed'; return record; }
  const parsed = parseProbeOutput(record.probe.execution);
  record.parsedProbeOutput = parsed;
  if (!parsed.ok) { record.reason = 'probe-produced-no-usable-marker-line'; return record; }
  if (parsed.payload.status !== 'ok') { record.reason = `probe-reported-${parsed.payload.status}`; return record; }
  record.assessment = framework.assess(caseEntry, parsed.payload.observations);
  const assessed = record.assessment.filter(a => a.matchesExpected !== null);
  record.state = assessed.every(a => a.matchesExpected === true) ? 'measured' : 'measured-with-mismatch';
  // Always clean up the locally built image; this is a bounded prototype, not a cache.
  try { record.imageRemoved = (await runner('docker', ['rmi', '--force', tag], { timeout: 30_000 })).exitCode === 0; } catch { record.imageRemoved = false; }
  return record;
}

export async function runHarness(options) {
  if (!options.run) return preview(options);
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 or newer required');
  const dockerVersion = await execute('docker', ['version', '--format', '{{json .}}'], { timeout: 30_000 });
  if (!(Number.isInteger(dockerVersion.exitCode) && dockerVersion.exitCode === 0)) throw new Error('Docker unavailable; no host fallback for the probed app containers');
  const out = resolve(options.out);
  await fs.mkdir(out); // Exclusive: existing evidence is never replaced.
  const { index, indexSha256 } = await loadCorpus(CORPUS);
  const selected = options.cases.length ? options.cases : Object.keys(FRAMEWORKS);
  const provenance = await gitProvenance();
  const envelope = {
    format: 'sentinel-feasibility-frameworks-results/draft-1',
    startedAt: new Date().toISOString(),
    provenance,
    runtime: { node: process.versions.node, platform: platform(), arch: arch() },
    corpus: { indexSha256 },
    harness: await harnessFileHashes(),
    cases: [],
  };
  for (const caseId of selected) {
    const record = await runOneCase(caseId, out, execute);
    await fs.mkdir(join(out, caseId), { recursive: true });
    await fs.writeFile(join(out, caseId, 'result.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    envelope.cases.push(record);
  }
  envelope.endedAt = new Date().toISOString();
  await fs.writeFile(join(out, 'results.json'), JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx' });
  return envelope;
}

export function runHasFailures(result) {
  return Array.isArray(result?.cases) && result.cases.some(c => c.state === 'failed' || c.state === 'measured-with-mismatch');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log('Preview: node scripts/sentinel-feasibility-frameworks.mjs [--case express-order,nest-validation,next-matcher,spring-chains]\nRun: add --run --out <fresh-directory>'); return; }
  const result = await runHarness(options);
  console.log(JSON.stringify(options.run ? { format: result.format, cases: result.cases?.map(c => ({ caseId: c.caseId, state: c.state, reason: c.reason })) } : result, null, 2));
  if (options.run && runHasFailures(result)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`sentinel-feasibility-frameworks: ${scrub(error.message)}`); process.exitCode = 1; });
