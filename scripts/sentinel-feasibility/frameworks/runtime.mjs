#!/usr/bin/env node
// PR 01 E2 framework prototype only. Not a production scanner adapter, framework support claim or
// isolation service. Shared container plumbing for the four framework probes; reuses the scanner
// harness's generic process/scrub/cleanup primitives without touching that shared file.
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, chmod } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute, scrub, cleanupOwned } from '../../sentinel-feasibility-scanners.mjs';

export { execute, scrub, cleanupOwned };

// Locally built acquisition base images, pinned by exact digest at the time they were pulled for this
// prototype. Acquisition (image build; network allowed) is distinct from execution (container run with
// --network none) throughout this module.
export const BASE_IMAGES = Object.freeze({
  node: 'node@sha256:ebc216c22db53dbde85719a874978d5aec04e6e405ad26a3804c6f9abc4ca1a9',
  maven: 'maven@sha256:5a8b906c4faa11d33f6c74758f67db8eac25441e14b0729f6d50ff78992be58a',
});

// Must equal the scanner harness's own (unexported) owner-label string: the imported `cleanupOwned`
// checks a container's label against that exact key, not against anything declared in this module.
export const OWNER_LABEL = 'org.farsight.sentinel-feasibility.owner';
export const CASE_LABEL = 'org.farsight.sentinel-feasibility-frameworks.case';
export const CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/sentinel/test/fixtures/framework-feasibility');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function safePath(root, path) {
  const target = resolve(root, path);
  if (!path || isAbsolute(path) || relative(root, target).startsWith('..') || path.includes(',')) throw new Error('Unsafe fixture path');
  return target;
}

async function plainDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Fixture root/parent must be a plain directory, not a symbolic link');
}

export async function loadCorpus(corpusRoot = CORPUS) {
  await plainDirectory(corpusRoot);
  const indexPath = join(corpusRoot, 'cases.json');
  const info = await lstat(indexPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Corpus index must be a regular file, not a symbolic link');
  const bytes = await readFile(indexPath);
  const index = JSON.parse(bytes);
  if (index.schemaVersion !== 'sentinel-framework-feasibility-corpus-v1') throw new Error('Unsupported framework corpus index');
  return { index, indexSha256: digest(bytes) };
}

// Copies every declared file for one case into a fresh build directory and verifies its fixture hash.
// Returns the materialized file list; never materializes files for a case that is not requested.
export async function materializeCase(caseEntry, buildDir, corpusRoot = CORPUS) {
  await mkdir(buildDir, { recursive: true });
  const materialized = [];
  for (const file of caseEntry.files) {
    const sourcePath = safePath(corpusRoot, file.source);
    const sourceInfo = await lstat(sourcePath);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error(`Fixture source must be a regular file, not a symbolic link: ${file.source}`);
    const bytes = await readFile(sourcePath);
    if (digest(bytes) !== file.sha256) throw new Error(`Fixture source hash mismatch: ${file.source}`);
    const target = safePath(buildDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o644 });
    materialized.push({ path: file.path, sha256: file.sha256, bytes: bytes.length });
  }
  return materialized;
}

export async function writeGeneratedFile(buildDir, relativePathName, contents, mode = 0o644) {
  const target = safePath(buildDir, relativePathName);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, { flag: 'wx', mode });
  await chmod(target, mode);
  return { path: relativePathName, sha256: digest(Buffer.from(contents)), bytes: Buffer.byteLength(contents) };
}

// Acquisition: build a pinned image from the materialized context. Network is allowed here; this is
// the one place these probes may reach a package registry, and only through `docker build`'s own
// resolution of the Dockerfile's RUN steps, never a bespoke download in this module.
export async function buildImage({ buildDir, tag, dockerfile = 'Dockerfile' }, runner = execute, signal) {
  const build = await runner('docker', ['build', '--platform', 'linux/arm64', '-t', tag, '-f', join(buildDir, dockerfile), buildDir], { timeout: 20 * 60_000, maxOutput: 8 * 1024 * 1024, signal });
  const ok = Number.isInteger(build.exitCode) && build.exitCode === 0 && !build.spawnError && !build.timedOut && !build.cancelled && !build.outputExceeded;
  let imageId = null;
  if (ok) {
    const inspect = await runner('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], { timeout: 30_000, signal });
    imageId = Number.isInteger(inspect.exitCode) && inspect.exitCode === 0 ? inspect.stdout.trim() : null;
  }
  return { tag, ok, build, imageId };
}

// Execution: run the already-built image with no network. The container's own entrypoint starts the
// app and probes it over loopback from inside its own network namespace; no request ever leaves the
// container, and nothing is downloaded at this step.
export async function runProbeContainer({ tag, caseId, memory = '1g', cpus = '1', extraArgs = [], readOnly = true }, runner = execute, signal) {
  const owner = randomUUID(), name = `sentinel-feasibility-frameworks-${randomUUID()}`;
  const args = ['create', '--pull', 'never', '--name', name,
    '--label', `${OWNER_LABEL}=${owner}`, '--label', `${CASE_LABEL}=${caseId}`,
    '--platform', 'linux/arm64', '--network', 'none',
    ...(readOnly ? ['--read-only'] : []),
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--memory', memory, '--cpus', cpus, '--pids-limit', '256',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m,mode=1777',
    ...extraArgs, tag];
  const record = { tag, caseId, owner, name, command: ['docker', ...args], networkPolicy: 'none', readOnly, state: 'failed' };
  let identity = name;
  try {
    record.create = await runner('docker', args, { signal });
    if (!(Number.isInteger(record.create.exitCode) && record.create.exitCode === 0)) { record.reason = 'container-create-failed'; return record; }
    identity = record.create.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error('Docker create did not return a container ID');
    record.execution = await runner('docker', ['start', '--attach', identity], { timeout: 180_000, maxOutput: 2 * 1024 * 1024, signal });
    const inspect = await runner('docker', ['inspect', '--type', 'container', identity], { timeout: 30_000, signal });
    let container = null;
    try { const parsed = JSON.parse(inspect.stdout); container = parsed[0] ?? null; } catch { container = null; }
    record.inspect = inspect;
    record.containerState = container?.State ?? null;
    record.networkMode = container?.HostConfig?.NetworkMode ?? null;
    const completed = record.containerState?.Status === 'exited' && record.containerState?.Running === false && record.containerState?.OOMKilled === false;
    const executionOk = Number.isInteger(record.execution.exitCode) && !record.execution.spawnError && !record.execution.timedOut && !record.execution.cancelled && !record.execution.outputExceeded;
    record.state = completed && executionOk && record.networkMode === 'none' ? 'measured' : 'failed';
    if (record.state === 'failed' && !record.reason) record.reason = 'Container did not complete cleanly under --network none; inspect execution/containerState.';
  } catch (error) { record.reason = scrub(error.message); }
  finally {
    try { record.cleanup = await cleanupOwned(runner, identity, owner); }
    catch (error) { record.cleanup = { state: 'refused', reason: scrub(error.message) }; }
    if (record.cleanup.state === 'cleanup-failed' || record.cleanup.state === 'refused') record.state = 'failed';
  }
  return record;
}

// The in-container driver prints exactly one marker line: either {"status":"ok","observations":{...}}
// or {"status":"<failure-reason>"}. This parser only unwraps that single JSON value; it never adds a
// second "status"/"observations" layer of its own.
export function parseProbeOutput(execution) {
  const stdout = execution?.stdout ?? '';
  const marker = 'SENTINEL_FIXTURE_PROBE_RESULT=';
  const line = stdout.split('\n').reverse().find(l => l.startsWith(marker));
  if (!line) return { ok: false, reason: 'no-result-marker', raw: stdout.slice(-2000) };
  try {
    const payload = JSON.parse(line.slice(marker.length));
    if (!payload || typeof payload !== 'object' || typeof payload.status !== 'string') throw new Error('missing status');
    return { ok: true, payload };
  } catch { return { ok: false, reason: 'invalid-result-json', raw: line.slice(0, 2000) }; }
}
