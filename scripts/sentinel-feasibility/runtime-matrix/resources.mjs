import { createHash } from 'node:crypto';
import { open, writeFile, mkdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute, scrub } from '../../sentinel-feasibility-scanners.mjs';
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const LIMITS = Object.freeze({ maxInputBytes: 16 * 1024 * 1024, totalInputBytes: 32 * 1024 * 1024, maxTrials: 60 });
export function admission({ inputBytes, totalBytes, trials, measurementAvailable = true }) {
  if (!Number.isSafeInteger(inputBytes) || inputBytes < 0 || !Number.isSafeInteger(totalBytes) || totalBytes < 0 || !Number.isSafeInteger(trials) || trials < 1) throw new Error('INVALID_ADMISSION_REQUEST');
  if (!measurementAvailable) return { admitted: false, state: 'gap', reason: 'MEASUREMENT_UNAVAILABLE' };
  if (inputBytes > LIMITS.maxInputBytes || totalBytes > LIMITS.totalInputBytes || trials > LIMITS.maxTrials) return { admitted: false, state: 'gap', reason: 'RESOURCE_BUDGET_EXHAUSTED' };
  return { admitted: true, state: 'admitted' };
}
async function artifactIdentity(path, prefix) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > LIMITS.maxInputBytes + 1_048_576) throw new Error(`${prefix}_ARTIFACT_INVALID`);
    const bytes = await file.readFile();
    if (bytes.length !== info.size) throw new Error(`${prefix}_ARTIFACT_CHANGED`);
    return { bytes: bytes.length, sha256: sha(bytes) };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${prefix}_ARTIFACT_MISSING`);
    throw error;
  } finally { await file?.close(); }
}
export async function verifyInputIdentity(path, expected) {
  const identity = await artifactIdentity(path, 'INPUT');
  if (identity.bytes !== expected.bytes || identity.sha256 !== expected.sha256) throw new Error('INPUT_ARTIFACT_IDENTITY_MISMATCH');
  return identity;
}
// Parent independently binds trusted child metrics to generated input and the bytes actually retained.
export async function verifyTrialIdentity({ inputPath, artifactPath, expectedInput, metric, codec }) {
  if (metric?.state !== 'measured' || metric.codec !== codec || metric.rawBytes !== expectedInput.bytes || metric.rawSha256 !== expectedInput.sha256 ||
      !Number.isSafeInteger(metric.encodedBytes) || metric.encodedBytes < 1 || !/^[a-f0-9]{64}$/.test(metric.encodedSha256 ?? '')) throw new Error('TRIAL_METRIC_IDENTITY_MISMATCH');
  const input = await verifyInputIdentity(inputPath, expectedInput);
  const encoded = await artifactIdentity(artifactPath, 'ENCODED');
  if (encoded.bytes !== metric.encodedBytes || encoded.sha256 !== metric.encodedSha256) throw new Error('ENCODED_ARTIFACT_IDENTITY_MISMATCH');
  return { input, encoded, verified: true };
}
const completedZero = execution => execution?.exitCode === 0 && !execution.timedOut && !execution.outputExceeded && !execution.cancelled && !execution.spawnError && !execution.exitSignal;
export function knownZstdUnavailable(codec, metric) {
  return codec === 'zstd' && metric?.state === 'unavailable' && metric.codec === 'zstd' && metric.reason === 'NODE_ZSTD_API_UNAVAILABLE' &&
    JSON.stringify(Object.keys(metric).sort()) === JSON.stringify(['codec', 'reason', 'state']);
}
export async function verifyTrialOutcome({ execution, ...options }) {
  if (!completedZero(execution)) throw new Error('RESOURCE_CHILD_FAILED');
  if (options.metric?.state === 'unavailable') {
    if (!knownZstdUnavailable(options.codec, options.metric)) throw new Error('UNEXPECTED_CODEC_UNAVAILABLE');
    const inputIdentity = await verifyInputIdentity(options.inputPath, options.expectedInput);
    let absent = false;
    try { await lstat(options.artifactPath); } catch (error) { if (error.code === 'ENOENT') absent = true; else throw error; }
    if (!absent) throw new Error('UNAVAILABLE_CODEC_ARTIFACT_PRESENT');
    return { state: 'unavailable', inputIdentity, artifactAbsent: true, reason: options.metric.reason };
  }
  return { state: 'measured', identity: await verifyTrialIdentity(options) };
}
export function trialAccounting(trials, inputs) {
  const expectedAttempts = new Set();
  for (const kind of ['parser', 'scan']) for (const size of [65_536, 1_048_576, 8_388_608]) for (let repetition = 1; repetition <= 3; repetition++) for (const codec of ['raw', 'gzip', 'zstd']) expectedAttempts.add(`${kind}/${size}/${repetition}/${codec}`);
  let measuredTrials = 0, unavailableTrials = 0, verifiedAttempts = true;
  for (const trial of trials) {
    const key = `${trial.kind}/${trial.requestedMinimumBytes}/${trial.repetition}/${trial.codec}`;
    if (!expectedAttempts.delete(key)) verifiedAttempts = false;
    const input = inputs.find(value => value.kind === trial.kind && value.requestedMinimumBytes === trial.requestedMinimumBytes);
    const sameInput = identity => input && identity?.bytes === input.bytes && identity?.sha256 === input.sha256;
    if (trial.state === 'measured') {
      measuredTrials++;
      verifiedAttempts &&= completedZero(trial.execution) && trial.identity?.verified === true && trial.metric?.state === 'measured' && trial.metric?.codec === trial.codec &&
        sameInput(trial.identity?.input) && trial.metric.rawBytes === input.bytes && trial.metric.rawSha256 === input.sha256 && typeof trial.artifact === 'string' &&
        trial.identity.encoded?.bytes === trial.metric.encodedBytes && trial.identity.encoded?.sha256 === trial.metric.encodedSha256;
    } else if (trial.state === 'unavailable') {
      unavailableTrials++;
      verifiedAttempts &&= completedZero(trial.execution) && knownZstdUnavailable(trial.codec, trial.metric) && sameInput(trial.inputIdentity) && trial.artifact === null && trial.artifactAbsent === true;
    } else verifiedAttempts = false;
  }
  const verifiedInputs = inputs.length === 6 && new Set(inputs.map(input => `${input.kind}/${input.requestedMinimumBytes}`)).size === 6 && inputs.every(input => input.finalIdentity?.bytes === input.bytes && input.finalIdentity?.sha256 === input.sha256);
  return { expectedTrials: 54, attemptedTrials: trials.length, measuredTrials, unavailableTrials,
    passed: trials.length === 54 && expectedAttempts.size === 0 && measuredTrials + unavailableTrials === 54 && verifiedAttempts && verifiedInputs };
}
// Original synthetic JSON represents artifact structure, not a distribution sampled from real applications.
export function payload(kind, minimumBytes) {
  if (!['parser', 'scan'].includes(kind) || !Number.isInteger(minimumBytes) || minimumBytes < 1 || minimumBytes > LIMITS.maxInputBytes) throw new Error('INVALID_PAYLOAD');
  const rows = []; let size = 0;
  for (let i = 0; size < minimumBytes; i++) {
    const id = sha(Buffer.from(`${kind}-${i}`));
    const row = kind === 'parser' ? { id, kind: i % 3 ? 'function' : 'route', path: `src/group-${i % 53}/file-${i}.ts`, name: `operation${i}`, start: { line: i % 300 + 1, column: 1 }, end: { line: i % 300 + 12, column: 2 }, signature: `(request: Request${i % 7}) => Promise<Response>`, sourceDigest: sha(Buffer.from(`source-${i}`)) }
      : { check_id: `original.sql.${i % 4}`, path: `src/group-${i % 53}/file-${i}.ts`, start: { line: i % 300 + 1, col: 3 }, end: { line: i % 300 + 1, col: 44 }, extra: { message: 'Original synthetic request expression reaches query construction', severity: 'WARNING', fingerprint: id, metadata: { evidence: 'syntax-only', fixture: `synthetic-${i}` } } };
    rows.push(row); size += Buffer.byteLength(JSON.stringify(row)) + 1;
  }
  return Buffer.from(JSON.stringify(kind === 'parser' ? { format: 'original-parser-style-v1', nodes: rows, diagnostics: [] } : { version: 'original-scan-style-v1', results: rows, errors: [] }));
}
export async function resourceTrials(out, runner = execute, signal) {
  const directory = join(out, 'resources'); await mkdir(directory);
  const trials = [], inputs = []; const sizes = [65_536, 1_048_576, 8_388_608];
  let totalBytes = 0;
  for (const kind of ['parser', 'scan']) for (const size of sizes) {
    const bytes = payload(kind, size), path = join(directory, `${kind}-${size}.json`);
    totalBytes += bytes.length;
    const gate = admission({ inputBytes: bytes.length, totalBytes, trials: 54 });
    if (!gate.admitted) throw new Error('RESOURCE_ADMISSION_FAILED');
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    const expectedInput = { kind, requestedMinimumBytes: size, bytes: bytes.length, sha256: sha(bytes), path: `resources/${kind}-${size}.json` };
    inputs.push(expectedInput);
    for (let repetition = 1; repetition <= 3; repetition++) for (const codec of ['raw', 'gzip', 'zstd']) {
      if (signal?.aborted) throw new Error('RESOURCE_TRIAL_CANCELLED');
      const artifact = `${kind}-${size}-${codec}-${repetition}.bin`;
      const command = [process.execPath, join(dirname(fileURLToPath(import.meta.url)), 'codec-worker.mjs'), path, join(directory, artifact), codec];
      const execution = await runner(command[0], command.slice(1), { timeout: 15_000, maxOutput: 16_384, signal });
      let metric = null; try { metric = JSON.parse(execution.stdout); } catch { /* Retain failed child evidence. */ }
      const trial = { kind, requestedMinimumBytes: size, repetition, codec, command: command.map(scrub), execution, metric, artifact: null };
      trials.push(trial);
      try {
        const outcome = await verifyTrialOutcome({ execution, inputPath: path, artifactPath: join(directory, artifact), expectedInput, metric, codec });
        trial.state = outcome.state;
        if (outcome.state === 'measured') { trial.identity = outcome.identity; trial.artifact = `resources/${artifact}`; }
        else { trial.inputIdentity = outcome.inputIdentity; trial.artifactAbsent = true; trial.gap = outcome.reason; }
      } catch (error) { trial.identityFailure = scrub(error.message); }
      await writeFile(join(directory, 'progress.json'), JSON.stringify({ inputs, trials }, null, 2) + '\n', { mode: 0o600 });
      if (trial.identityFailure) throw new Error(trial.identityFailure);
    }
  }
  for (const input of inputs) {
    input.finalIdentity = await verifyInputIdentity(join(out, input.path), input);
  }
  await writeFile(join(directory, 'progress.json'), JSON.stringify({ inputs, trials }, null, 2) + '\n', { mode: 0o600 });
  const accounting = trialAccounting(trials, inputs);
  return { inputs, trials, accounting, gaps: accounting.unavailableTrials ? [{ id: 'zstd-api-unavailable', state: 'gap', reason: 'NODE_ZSTD_API_UNAVAILABLE', unavailableTrials: accounting.unavailableTrials }] : [], controls: [
    { id: 'synthetic-input-admission-exhaustion', ...admission({ inputBytes: LIMITS.maxInputBytes + 1, totalBytes: 0, trials: 1 }) },
    { id: 'synthetic-total-admission-exhaustion', ...admission({ inputBytes: 1, totalBytes: LIMITS.totalInputBytes + 1, trials: 1 }) },
    { id: 'synthetic-trial-admission-exhaustion', ...admission({ inputBytes: 1, totalBytes: 1, trials: LIMITS.maxTrials + 1 }) },
    { id: 'synthetic-unavailable-measurement', ...admission({ inputBytes: 1, totalBytes: 1, trials: 1, measurementAvailable: false }) },
  ], provenance: 'Serial trials, fresh Node process per repetition, retained input and encoded hashes. Child encode/decode timers exclude disk IO and hashing; parent wall includes process startup, file IO and hashing. Child maxRSS is lifetime high-water, never codec-only peak.' };
}
