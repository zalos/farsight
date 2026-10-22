#!/usr/bin/env node
// PR01 framework experiment only. Acquisition and offline owned execution remain separate.
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve, isAbsolute, relative, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute, scrub } from '../../sentinel-feasibility-scanners.mjs';
export { execute, scrub };
export const BASE_IMAGES = Object.freeze({
  node: 'node@sha256:ebc216c22db53dbde85719a874978d5aec04e6e405ad26a3804c6f9abc4ca1a9',
  maven: 'maven@sha256:5a8b906c4faa11d33f6c74758f67db8eac25441e14b0729f6d50ff78992be58a',
});
export const OWNER_LABEL = 'org.farsight.sentinel-feasibility-frameworks.owner';
export const CASE_LABEL = 'org.farsight.sentinel-feasibility-frameworks.case';
export const RUN_UID = 65534;
export const CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/sentinel/test/fixtures/framework-feasibility');
const MAX_FILE = 2 * 1024 * 1024;
const MAX_CONTEXT = 32 * 1024 * 1024;
const DEFAULT_TMPFS = '/tmp:rw,noexec,nosuid,size=128m,mode=1777';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const imageIdentity = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const completed = result => Number.isInteger(result?.exitCode) && !result.spawnError && !result.timedOut && !result.cancelled && !result.outputExceeded && !result.exitSignal;
const succeeded = result => completed(result) && result.exitCode === 0;
const abortCheck = signal => { if (signal?.aborted) throw new Error('Framework experiment cancelled before the next operation'); };
function safePath(root, path) {
  const target = resolve(root, path);
  if (typeof path !== 'string' || !path || isAbsolute(path) || relative(root, target).startsWith('..') || path.includes(',') || path.includes('\\') || target === root) throw new Error('Unsafe fixture path');
  return target;
}
async function plainDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Fixture root/parent must be a plain directory, not a symbolic link');
}
async function parents(root, target, create = false) {
  await plainDirectory(root);
  const pieces = relative(root, dirname(target)).split('/').filter(Boolean);
  let directory = root;
  for (const piece of pieces) {
    directory = join(directory, piece);
    if (create) try { await mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await plainDirectory(directory);
  }
}
async function readPlain(root, path) {
  const target = safePath(root, path);
  await parents(root, target);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE) throw new Error('Fixture must be a bounded regular file, not a symbolic link');
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size > MAX_FILE) throw new Error('Fixture identity changed');
    const buffer = Buffer.alloc(MAX_FILE + 1);
    let size = 0;
    while (size < buffer.length) {
      const part = await file.read(buffer, size, buffer.length - size, size);
      if (!part.bytesRead) break;
      size += part.bytesRead;
    }
    const after = await file.stat();
    if (size > MAX_FILE || size !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('Fixture changed or exceeds read bound');
    return buffer.subarray(0, size);
  } finally { await file.close(); }
}
async function outputRoot(path) {
  await plainDirectory(dirname(path));
  try { await mkdir(path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await plainDirectory(path);
}
async function writePlain(root, path, bytes, mode) {
  if (bytes.length > MAX_FILE || ![0o644, 0o755].includes(mode)) throw new Error('Generated fixture exceeds bounds or has an invalid mode');
  const target = safePath(root, path);
  await parents(root, target, true);
  const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await file.writeFile(bytes); await file.chmod(mode); } finally { await file.close(); }
}
export async function loadCorpus(corpusRoot = CORPUS) {
  corpusRoot = resolve(corpusRoot);
  const bytes = await readPlain(corpusRoot, 'cases.json');
  const index = JSON.parse(bytes);
  if (index?.schemaVersion !== 'sentinel-framework-feasibility-corpus-v1' || !Array.isArray(index.cases)) throw new Error('Unsupported framework corpus index');
  return { index, indexSha256: digest(bytes) };
}
// May also be called by the acquisition coordinator immediately before/after a build.
export async function verifyAcquisitionInputs(buildDir, files) {
  buildDir = resolve(buildDir);
  if (!Array.isArray(files) || files.length > 128 || new Set(files.map(file => file.path)).size !== files.length) throw new Error('Invalid acquisition input inventory');
  const verified = []; let total = 0;
  for (const file of files) {
    const bytes = await readPlain(buildDir, file.path); total += bytes.length;
    if (total > MAX_CONTEXT || bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error('Acquisition input identity mismatch');
    verified.push({ path: file.path, sha256: file.sha256, bytes: bytes.length });
  }
  return verified;
}
export async function materializeCase(caseEntry, buildDir, corpusRoot = CORPUS) {
  buildDir = resolve(buildDir); corpusRoot = resolve(corpusRoot);
  if (!Array.isArray(caseEntry?.files) || caseEntry.files.length > 128) throw new Error('Invalid case file inventory');
  const inputs = []; let total = 0;
  // Verify the complete source list before writing any build-context file.
  for (const file of caseEntry.files) {
    const bytes = await readPlain(corpusRoot, file.source); total += bytes.length;
    safePath(buildDir, file.path);
    if (total > MAX_CONTEXT || digest(bytes) !== file.sha256) throw new Error(`Fixture source hash mismatch or context limit: ${file.source}`);
    inputs.push({ file, bytes });
  }
  await outputRoot(buildDir);
  for (const { file, bytes } of inputs) await writePlain(buildDir, file.path, bytes, 0o644);
  return verifyAcquisitionInputs(buildDir, inputs.map(({ file, bytes }) => ({ path: file.path, sha256: file.sha256, bytes: bytes.length })));
}
export async function writeGeneratedFile(buildDir, relativePathName, contents, mode = 0o644) {
  buildDir = resolve(buildDir);
  const bytes = Buffer.from(contents);
  await writePlain(buildDir, relativePathName, bytes, mode);
  const expected = { path: relativePathName, sha256: digest(bytes), bytes: bytes.length };
  await verifyAcquisitionInputs(buildDir, [expected]);
  return expected;
}
// Acquisition only; no build/image operation is called from runOwnedContainer.
export async function buildImage({ buildDir, tag, dockerfile = 'Dockerfile' }, runner = execute, signal) {
  abortCheck(signal);
  await readPlain(resolve(buildDir), dockerfile);
  abortCheck(signal);
  const build = await runner('docker', ['build', '--platform', 'linux/arm64', '-t', tag, '-f', safePath(resolve(buildDir), dockerfile), buildDir], { timeout: 20 * 60_000, maxOutput: 8 * 1024 * 1024, signal });
  let imageId = null, imagePlatform = null, inspection = null;
  if (succeeded(build) && !signal?.aborted) {
    inspection = await runner('docker', ['image', 'inspect', '--format', '{{.Id}}|{{.Os}}|{{.Architecture}}', tag], { timeout: 30_000, signal });
    if (succeeded(inspection) && !signal?.aborted) {
      const parts = inspection.stdout.trim().split('|');
      if (parts.length === 3 && imageIdentity(parts[0])) { imageId = parts[0]; imagePlatform = { os: parts[1], arch: parts[2] }; }
    }
  }
  return { tag, ok: succeeded(build) && imageIdentity(imageId) && imagePlatform?.os === 'linux' && imagePlatform?.arch === 'arm64' && !signal?.aborted, build, inspection, imageId, imagePlatform };
}
async function inspectOwnedContainer(runner, identity, owner) {
  if (typeof identity !== 'string' || !identity || typeof owner !== 'string' || !owner) throw new Error('Container identity and owner are required');
  const result = await runner('docker', ['inspect', '--type', 'container', identity], { timeout: 30_000 });
  if (!succeeded(result)) return { result, container: null };
  let containers;
  try { containers = JSON.parse(result.stdout); } catch { throw new Error('Invalid Docker inspection response; ownership cannot be verified'); }
  const container = containers?.[0];
  if (!Array.isArray(containers) || containers.length !== 1 || !/^[a-f0-9]{64}$/.test(container?.Id ?? '') || container.Config?.Labels?.[OWNER_LABEL] !== owner) throw new Error('Container ownership mismatch; refusing start or removal');
  if (/^[a-f0-9]{64}$/.test(identity) && container.Id !== identity) throw new Error('Container identity changed; refusing mutation');
  return { result, container };
}
function containerAbsent(result, identity) {
  if (!completed(result) || result.exitCode === 0) return false;
  const match = /^(?:Error(?: response from daemon)?:\s*)?No such (?:object|container):\s*(\S+)$/.exec((result.stderr ?? '').trim());
  return match?.[1] === identity;
}
export async function cleanupOwnedContainer(runner, identity, owner) {
  const inspected = await inspectOwnedContainer(runner, identity, owner);
  if (!inspected.container) return { state: containerAbsent(inspected.result, identity) ? 'not-found' : 'cleanup-failed', reason: containerAbsent(inspected.result, identity) ? 'docker-confirmed-absent' : 'inspection-unavailable-ownership-or-absence-unknown', inspect: inspected.result };
  // Anonymous volumes allocated by this owned create are removed even when pre-start policy refused them.
  const removed = await runner('docker', ['rm', '--force', '--volumes', inspected.container.Id], { timeout: 30_000 });
  if (!succeeded(removed)) return { state: 'cleanup-failed', id: inspected.container.Id, inspect: inspected.result, result: removed };
  const verification = await runner('docker', ['inspect', '--type', 'container', inspected.container.Id], { timeout: 30_000 });
  return { state: containerAbsent(verification, inspected.container.Id) ? 'removed-owned-container' : 'cleanup-failed', id: inspected.container.Id, inspect: inspected.result, result: removed, verification };
}
function isolationFacts(container) {
  return { id: container.Id, imageId: container.Image, image: container.Config?.Image, platform: container.Platform,
    user: container.Config?.User, networkMode: container.HostConfig?.NetworkMode,
    readOnlyRootfs: container.HostConfig?.ReadonlyRootfs, capDrop: container.HostConfig?.CapDrop, capAdd: container.HostConfig?.CapAdd,
    privileged: container.HostConfig?.Privileged, securityOpt: container.HostConfig?.SecurityOpt, tmpfs: container.HostConfig?.Tmpfs,
    memory: container.HostConfig?.Memory, memorySwap: container.HostConfig?.MemorySwap, nanoCpus: container.HostConfig?.NanoCpus, pidsLimit: container.HostConfig?.PidsLimit,
    mounts: container.Mounts?.map(m => ({ destination: m.Destination, readWrite: m.RW, type: m.Type })) };
}
function memorySize(value) {
  const match = /^(\d+)([kmg]?)$/i.exec(String(value));
  const bytes = match ? Number(match[1]) * ({ k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2].toLowerCase()] ?? 1) : NaN;
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('Invalid positive memory/tmpfs size');
  return bytes;
}
function requestedTmpfs(extraTmpfs, memoryBytes) {
  if (!Array.isArray(extraTmpfs)) throw new Error('Invalid tmpfs request');
  const requested = {}; let total = 0;
  for (const spec of [DEFAULT_TMPFS, ...extraTmpfs]) {
    if (typeof spec !== 'string') throw new Error('Invalid tmpfs request');
    const split = spec.indexOf(':'), path = spec.slice(0, split), options = spec.slice(split + 1).split(',');
    const size = options.find(option => option.startsWith('size='));
    if (split < 1 || !isAbsolute(path) || path === '/' || normalize(path) !== path || path.includes(',') || Object.hasOwn(requested, path) ||
        options.length !== 5 || new Set(options).size !== 5 || !['rw', 'noexec', 'nosuid', 'mode=1777'].every(option => options.includes(option)) || !size) throw new Error('Invalid or weakened tmpfs request');
    total += memorySize(size.slice(5));
    requested[path] = options.sort();
  }
  if (total > memoryBytes) throw new Error('Tmpfs request exceeds the memory ceiling');
  return requested;
}
function isolationMatchesRequest(facts, { expectedImageId, memoryBytes, cpus, pidsLimit, tmpfs }) {
  const actualTmpfs = facts.tmpfs;
  const tmpfsMatches = actualTmpfs && JSON.stringify(Object.keys(actualTmpfs).sort()) === JSON.stringify(Object.keys(tmpfs).sort()) &&
    Object.entries(tmpfs).every(([path, tokens]) => typeof actualTmpfs[path] === 'string' && JSON.stringify(actualTmpfs[path].split(',').sort()) === JSON.stringify(tokens));
  const mountsMatch = Array.isArray(facts.mounts) && new Set(facts.mounts.map(m => m.destination)).size === facts.mounts.length && facts.mounts.every(m => m.type === 'tmpfs' && m.readWrite === true && Object.hasOwn(tmpfs, m.destination));
  const checks = [
    { name: 'image-id-matches-acquired', passed: imageIdentity(expectedImageId) && facts.imageId === expectedImageId },
    { name: 'linux-container-platform', passed: facts.platform === 'linux' },
    { name: 'network-none', passed: facts.networkMode === 'none' },
    { name: 'user-is-run-uid', passed: facts.user === `${RUN_UID}:${RUN_UID}` },
    { name: 'read-only-rootfs', passed: facts.readOnlyRootfs === true },
    { name: 'cap-drop-all', passed: Array.isArray(facts.capDrop) && facts.capDrop.length === 1 && facts.capDrop[0] === 'ALL' && (facts.capAdd === null || Array.isArray(facts.capAdd) && facts.capAdd.length === 0) && facts.privileged === false },
    { name: 'no-new-privileges', passed: Array.isArray(facts.securityOpt) && facts.securityOpt.length === 1 && facts.securityOpt[0] === 'no-new-privileges:true' },
    { name: 'memory-limit-matches', passed: facts.memory === memoryBytes },
    { name: 'memory-swap-matches-positive-ceiling', passed: Number.isSafeInteger(facts.memorySwap) && facts.memorySwap > 0 && facts.memorySwap === memoryBytes },
    { name: 'cpus-limit-matches', passed: facts.nanoCpus === Math.round(cpus * 1e9) },
    { name: 'pids-limit-matches', passed: facts.pidsLimit === pidsLimit },
    { name: 'requested-tmpfs-only', passed: tmpfsMatches === true && mountsMatch },
  ];
  return { passed: checks.every(check => check.passed === true), checks };
}
export async function runOwnedContainer({ expectedImageId, image, name, caseId, command = [], entrypoint, memory = '1g', memoryBytes = 1073741824, cpus = 1, pidsLimit = 256, extraTmpfs = [], extraEnv = [] }, runner = execute, signal) {
  const owner = randomUUID(), containerName = name ?? `sentinel-feasibility-frameworks-${randomUUID()}`;
  const record = { image, expectedImageId, caseId, owner, name: containerName, state: 'failed' };
  let identity = containerName, attemptedCreate = false;
  try {
    abortCheck(signal);
    if (!imageIdentity(expectedImageId) || typeof image !== 'string' || !image || !Number.isSafeInteger(memoryBytes) || memoryBytes < 1 || memorySize(memory) !== memoryBytes || !Number.isFinite(cpus) || cpus <= 0 || !Number.isSafeInteger(Math.round(cpus * 1e9)) || Math.round(cpus * 1e9) < 1 || !Number.isSafeInteger(pidsLimit) || pidsLimit < 1) throw new Error('Invalid immutable image or resource request');
    const tmpfs = requestedTmpfs(extraTmpfs, memoryBytes);
    const args = ['create', '--pull', 'never', '--name', containerName,
      '--label', `${OWNER_LABEL}=${owner}`, '--label', `${CASE_LABEL}=${caseId}`,
      '--platform', 'linux/arm64', '--network', 'none', '--user', `${RUN_UID}:${RUN_UID}`,
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--memory', memory, '--memory-swap', memory, '--cpus', String(cpus), '--pids-limit', String(pidsLimit),
      '--tmpfs', DEFAULT_TMPFS, ...extraTmpfs.flatMap(spec => ['--tmpfs', spec]),
      '--env', 'HOME=/tmp', ...extraEnv.flatMap(env => ['--env', env]),
      ...(entrypoint ? ['--entrypoint', entrypoint] : []), image, ...command];
    record.command = ['docker', ...args];
    abortCheck(signal); attemptedCreate = true;
    record.create = await runner('docker', args, { signal });
    if (!succeeded(record.create)) throw new Error('container-create-failed');
    identity = record.create.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(identity)) { identity = containerName; throw new Error('Docker create did not return a container ID'); }
    abortCheck(signal);
    const before = await inspectOwnedContainer(runner, identity, owner);
    record.preStartInspect = before.result;
    if (!before.container) throw new Error('Created container could not be inspected before start; refusing to start it');
    record.preStartIsolation = isolationFacts(before.container);
    const requested = { expectedImageId, memoryBytes, cpus, pidsLimit, tmpfs };
    record.preStartCheck = isolationMatchesRequest(record.preStartIsolation, requested);
    if (!record.preStartCheck.passed) throw new Error('Pre-start isolation check failed; refusing to start a container whose inspected configuration disagrees with what was requested');
    abortCheck(signal);
    record.execution = await runner('docker', ['start', '--attach', identity], { timeout: 180_000, maxOutput: 2 * 1024 * 1024, signal });
    const after = await inspectOwnedContainer(runner, identity, owner);
    record.postStartInspect = after.result;
    record.containerState = after.container?.State ?? null;
    record.postStartIsolation = after.container ? isolationFacts(after.container) : null;
    record.postStartCheck = after.container ? isolationMatchesRequest(record.postStartIsolation, requested) : { passed: false, checks: [] };
    const state = record.containerState;
    const containerClean = state?.Status === 'exited' && state.Running === false && state.OOMKilled === false && state.Dead === false && state.ExitCode === record.execution?.exitCode;
    record.completed = succeeded(record.execution) && containerClean && record.postStartCheck.passed && !signal?.aborted;
    record.state = record.completed ? 'measured' : 'failed';
    if (!record.completed) record.reason = 'Container execution or inspection disagreed with a clean isolated completion.';
  } catch (error) { record.reason = scrub(error.message); }
  finally {
    if (!attemptedCreate) record.cleanup = { state: 'not-created' };
    else try { record.cleanup = await cleanupOwnedContainer(runner, identity, owner); }
    catch (error) { record.cleanup = { state: 'refused', reason: scrub(error.message) }; }
    if (record.cleanup.state !== 'removed-owned-container') record.state = 'failed';
  }
  return record;
}
export function parseProbeOutput(execution) {
  const marker = 'SENTINEL_FIXTURE_PROBE_RESULT=', stdout = execution?.stdout ?? '';
  const lines = stdout.split('\n').filter(line => line.startsWith(marker));
  if (lines.length !== 1) return { ok: false, reason: lines.length ? 'ambiguous-result-markers' : 'no-result-marker', raw: stdout.slice(-2000) };
  try {
    const payload = JSON.parse(lines[0].slice(marker.length));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.status !== 'string') throw new Error('missing status');
    return { ok: true, payload };
  } catch { return { ok: false, reason: 'invalid-result-json', raw: lines[0].slice(0, 2000) }; }
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const httpStatus = value => Number.isInteger(value) && value >= 100 && value <= 599;
export function evaluateCaseOutcome(assessment) {
  if (!Array.isArray(assessment) || assessment.length === 0) return { state: 'failed', reason: 'no-scenarios-assessed' };
  const missing = assessment.filter(entry => !entry || entry.observed === null || entry.observed === undefined);
  if (missing.length) return { state: 'failed', reason: `missing observation for: ${missing.map(entry => entry?.scenario ?? 'unknown').join(', ')}` };
  if (new Set(assessment.map(entry => entry.scenario)).size !== assessment.length) return { state: 'failed', reason: 'duplicate-scenario-assessment' };
  for (const entry of assessment) {
    const expected = entry.expectedRuntime;
    if (typeof entry.scenario !== 'string' || !entry.scenario || !object(expected) || Object.keys(expected).length === 0 || !Object.values(expected).every(httpStatus)) return { state: 'failed', reason: `fixed HTTP expectation required for: ${entry.scenario}` };
    if (!object(entry.observed) || !Object.keys(expected).every(field => Object.hasOwn(entry.observed, field) && httpStatus(entry.observed[field]))) return { state: 'failed', reason: `invalid or partial HTTP observation for: ${entry.scenario}` };
    if (typeof entry.matchesExpected !== 'boolean' || entry.matchesExpected !== Object.keys(expected).every(field => entry.observed[field] === expected[field])) return { state: 'failed', reason: `invalid expectation comparison for: ${entry.scenario}` };
  }
  const mismatched = assessment.filter(entry => entry.matchesExpected === false);
  if (mismatched.length) return { state: 'measured-with-mismatch', reason: `runtime disagreed with expectation for: ${mismatched.map(entry => entry.scenario).join(', ')}` };
  return { state: 'measured' };
}
