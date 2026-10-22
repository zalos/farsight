#!/usr/bin/env node
// PR 01 E2 framework prototype only. Not a production scanner adapter, framework support claim or
// isolation service. Shared container plumbing for the four framework probes. Reuses only the generic,
// stateless `execute`/`scrub` process primitives from the scanner harness (never edited); container
// ownership/cleanup is fully self-contained here under this module's own label, so this file never
// depends on an unexported constant in a module it does not own.
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, chmod } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute, scrub } from '../../sentinel-feasibility-scanners.mjs';

export { execute, scrub };

// Locally built acquisition base images, pinned by exact digest at the time they were pulled for this
// prototype. Acquisition (image build; network allowed) is distinct from execution (container run with
// --network none) throughout this module.
export const BASE_IMAGES = Object.freeze({
  node: 'node@sha256:ebc216c22db53dbde85719a874978d5aec04e6e405ad26a3804c6f9abc4ca1a9',
  maven: 'maven@sha256:5a8b906c4faa11d33f6c74758f67db8eac25441e14b0729f6d50ff78992be58a',
});

// Owned exclusively by this module; never shared with scripts/sentinel-feasibility-scanners.mjs so a
// change there cannot silently break (or be silently coupled to) this harness's cleanup.
export const OWNER_LABEL = 'org.farsight.sentinel-feasibility-frameworks.owner';
export const CASE_LABEL = 'org.farsight.sentinel-feasibility-frameworks.case';
export const RUN_UID = 65534;
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
// resolution of the Dockerfile's RUN steps, never a bespoke download in this module. Returns the
// resulting image's exact content-addressed ID (`docker image inspect --format {{.Id}}`), the single
// fact every later `--run` must match before it will create a container from this tag.
export async function buildImage({ buildDir, tag, dockerfile = 'Dockerfile' }, runner = execute, signal) {
  const build = await runner('docker', ['build', '--platform', 'linux/arm64', '-t', tag, '-f', join(buildDir, dockerfile), buildDir], { timeout: 20 * 60_000, maxOutput: 8 * 1024 * 1024, signal });
  const ok = Number.isInteger(build.exitCode) && build.exitCode === 0 && !build.spawnError && !build.timedOut && !build.cancelled && !build.outputExceeded;
  let imageId = null, imagePlatform = null;
  if (ok) {
    const inspect = await runner('docker', ['image', 'inspect', '--format', '{{.Id}}|{{.Os}}|{{.Architecture}}', tag], { timeout: 30_000, signal });
    if (Number.isInteger(inspect.exitCode) && inspect.exitCode === 0) {
      const [id, os, arch] = inspect.stdout.trim().split('|');
      imageId = /^sha256:[a-f0-9]{64}$/.test(id) ? id : null;
      imagePlatform = { os, arch };
    }
  }
  const platformOk = imagePlatform?.os === 'linux' && imagePlatform?.arch === 'arm64';
  return { tag, ok: ok && Boolean(imageId) && platformOk, build, imageId, imagePlatform };
}

async function inspectOwnedContainer(runner, identity, owner) {
  const result = await runner('docker', ['inspect', '--type', 'container', identity], { timeout: 30_000 });
  if (!(Number.isInteger(result.exitCode) && result.exitCode === 0)) return { result, container: null };
  let containers;
  try { containers = JSON.parse(result.stdout); } catch { throw new Error('Invalid Docker inspection response; ownership cannot be verified'); }
  const container = containers[0];
  if (containers.length !== 1 || !/^[a-f0-9]{64}$/.test(container?.Id ?? '') || container.Config?.Labels?.[OWNER_LABEL] !== owner) {
    throw new Error('Container ownership mismatch; refusing start or removal');
  }
  if (/^[a-f0-9]{64}$/.test(identity) && container.Id !== identity) throw new Error('Container identity changed; refusing mutation');
  return { result, container };
}

function containerAbsent(result) {
  return Number.isInteger(result?.exitCode) && !result.spawnError && !result.timedOut && !result.cancelled && !result.outputExceeded && !result.exitSignal &&
    result.exitCode !== 0 && /^(?:Error(?: response from daemon)?:\s*)?No such (?:object|container):\s*\S+\s*$/im.test(result.stderr ?? '');
}

// Self-contained: checks ownership by exact label+ID before ever creating, starting or removing
// anything, and never removes a container this module did not itself create and label.
export async function cleanupOwnedContainer(runner, identity, owner) {
  const inspected = await inspectOwnedContainer(runner, identity, owner);
  if (!inspected.container) return { state: containerAbsent(inspected.result) ? 'not-found' : 'cleanup-failed', reason: containerAbsent(inspected.result) ? 'docker-confirmed-absent' : 'inspection-unavailable-ownership-or-absence-unknown', inspect: inspected.result };
  const removed = await runner('docker', ['rm', '--force', inspected.container.Id], { timeout: 30_000 });
  if (!(Number.isInteger(removed.exitCode) && removed.exitCode === 0)) return { state: 'cleanup-failed', id: inspected.container.Id, result: removed };
  const verification = await runner('docker', ['inspect', '--type', 'container', inspected.container.Id], { timeout: 30_000 });
  const absent = containerAbsent(verification);
  return { state: absent ? 'removed-owned-container' : 'cleanup-failed', id: inspected.container.Id, result: removed, verification };
}

function isolationFacts(container) {
  return {
    id: container.Id, imageId: container.Image, image: container.Config?.Image,
    user: container.Config?.User, networkMode: container.HostConfig?.NetworkMode,
    readOnlyRootfs: container.HostConfig?.ReadonlyRootfs, capDrop: container.HostConfig?.CapDrop,
    securityOpt: container.HostConfig?.SecurityOpt, tmpfs: container.HostConfig?.Tmpfs,
    memory: container.HostConfig?.Memory, memorySwap: container.HostConfig?.MemorySwap,
    nanoCpus: container.HostConfig?.NanoCpus, pidsLimit: container.HostConfig?.PidsLimit,
    mounts: container.Mounts?.map(m => ({ destination: m.Destination, readWrite: m.RW, type: m.Type })),
  };
}

// Every property this run is actually relying on, checked against what was requested — not merely
// that docker accepted the flags, but that the daemon reports them back unchanged.
function isolationMatchesRequest(facts, { expectedImageId, memoryBytes, cpus, pidsLimit }) {
  const checks = [
    { name: 'image-id-matches-acquired', passed: facts.imageId === expectedImageId },
    { name: 'network-none', passed: facts.networkMode === 'none' },
    { name: 'user-is-run-uid', passed: facts.user === `${RUN_UID}:${RUN_UID}` },
    { name: 'read-only-rootfs', passed: facts.readOnlyRootfs === true },
    { name: 'cap-drop-all', passed: Array.isArray(facts.capDrop) && facts.capDrop.includes('ALL') },
    { name: 'no-new-privileges', passed: Array.isArray(facts.securityOpt) && facts.securityOpt.some(o => o === 'no-new-privileges:true' || o === 'no-new-privileges') },
    { name: 'memory-limit-matches', passed: facts.memory === memoryBytes },
    { name: 'memory-swap-not-unbounded', passed: Number.isInteger(facts.memorySwap) && facts.memorySwap <= memoryBytes },
    { name: 'cpus-limit-matches', passed: facts.nanoCpus === Math.round(cpus * 1e9) },
    { name: 'pids-limit-matches', passed: facts.pidsLimit === pidsLimit },
    { name: 'no-host-bind-mounts', passed: Array.isArray(facts.mounts) && facts.mounts.every(m => m.type === 'tmpfs' || m.type === 'volume') },
  ];
  return { passed: checks.every(c => c.passed), checks };
}

// Full owned lifecycle for any bounded command against an already-acquired image: create (never
// started yet) -> verify every isolation property by inspection before the process runs at all ->
// start/attach -> verify the container actually exited clean and agrees with the client's own exit
// code -> force-remove by exact owned ID, verified absent, in every case including a failure.
export async function runOwnedContainer({ expectedImageId, image, name, caseId, command = [], entrypoint, memory = '1g', memoryBytes = 1073741824, cpus = 1, pidsLimit = 256, extraTmpfs = [], extraEnv = [] }, runner = execute, signal) {
  const owner = randomUUID();
  const containerName = name ?? `sentinel-feasibility-frameworks-${randomUUID()}`;
  const args = ['create', '--pull', 'never', '--name', containerName,
    '--label', `${OWNER_LABEL}=${owner}`, '--label', `${CASE_LABEL}=${caseId}`,
    '--platform', 'linux/arm64', '--network', 'none', '--user', `${RUN_UID}:${RUN_UID}`,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--memory', memory, '--memory-swap', memory, '--cpus', String(cpus), '--pids-limit', String(pidsLimit),
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m,mode=1777', ...extraTmpfs.flatMap(t => ['--tmpfs', t]),
    '--env', 'HOME=/tmp', ...extraEnv.flatMap(e => ['--env', e]),
    ...(entrypoint ? ['--entrypoint', entrypoint] : []), image, ...command];
  const record = { image, expectedImageId, caseId, owner, name: containerName, command: ['docker', ...args], state: 'failed' };
  let identity = containerName;
  try {
    record.create = await runner('docker', args, { signal });
    if (!(Number.isInteger(record.create.exitCode) && record.create.exitCode === 0)) { record.reason = 'container-create-failed'; return record; }
    identity = record.create.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error('Docker create did not return a container ID');

    const preInspect = await inspectOwnedContainer(runner, identity, owner);
    record.preStartInspect = preInspect.result;
    if (!preInspect.container) throw new Error('Created container could not be inspected before start; refusing to start it');
    record.preStartIsolation = isolationFacts(preInspect.container);
    record.preStartCheck = isolationMatchesRequest(record.preStartIsolation, { expectedImageId, memoryBytes, cpus, pidsLimit });
    if (!record.preStartCheck.passed) throw new Error('Pre-start isolation check failed; refusing to start a container whose inspected configuration disagrees with what was requested');

    record.execution = await runner('docker', ['start', '--attach', identity], { timeout: 180_000, maxOutput: 2 * 1024 * 1024, signal });

    const postInspect = await inspectOwnedContainer(runner, identity, owner);
    record.postStartInspect = postInspect.result;
    const container = postInspect.container;
    record.containerState = container?.State ?? null;
    record.postStartIsolation = container ? isolationFacts(container) : null;

    const executionClean = Number.isInteger(record.execution.exitCode) && record.execution.exitCode === 0 &&
      !record.execution.exitSignal && !record.execution.spawnError && !record.execution.timedOut &&
      !record.execution.cancelled && !record.execution.outputExceeded;
    const containerClean = record.containerState?.Status === 'exited' && record.containerState?.Running === false &&
      record.containerState?.OOMKilled === false && record.containerState?.Dead === false &&
      record.containerState?.ExitCode === record.execution?.exitCode;
    const imageStillMatches = record.postStartIsolation?.imageId === expectedImageId && record.postStartIsolation?.networkMode === 'none';
    record.completed = Boolean(executionClean && containerClean && imageStillMatches);
    record.state = record.completed ? 'measured' : 'failed';
    if (!record.completed && !record.reason) record.reason = 'Container execution or post-start inspection disagreed with a clean, isolated completion.';
  } catch (error) { record.reason = scrub(error.message); }
  finally {
    try { record.cleanup = await cleanupOwnedContainer(runner, identity, owner); }
    catch (error) { record.cleanup = { state: 'refused', reason: scrub(error.message) }; }
    if (record.cleanup.state !== 'removed-owned-container') record.state = 'failed';
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

// Strict pass/fail from an assess() array: every declared scenario must carry a real, non-null
// observation (a missing one is a failure, never silently dropped before the pass/fail fold), and
// every scenario that does have a fixed expectation must match it. A scenario with no fixed
// expectation (matchesExpected === null, e.g. Spring's "measured, not assumed" case) still requires
// a real observed value — it is exempt from the match requirement, never from being observed at all.
export function evaluateCaseOutcome(assessment) {
  if (!Array.isArray(assessment) || assessment.length === 0) return { state: 'failed', reason: 'no-scenarios-assessed' };
  const missing = assessment.filter(a => a.observed === null || a.observed === undefined);
  if (missing.length) return { state: 'failed', reason: `missing observation for: ${missing.map(a => a.scenario).join(', ')}` };
  const mismatched = assessment.filter(a => a.matchesExpected === false);
  if (mismatched.length) return { state: 'measured-with-mismatch', reason: `runtime disagreed with expectation for: ${mismatched.map(a => a.scenario).join(', ')}` };
  return { state: 'measured' };
}
