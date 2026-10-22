import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
    inputs.push({ kind, requestedMinimumBytes: size, bytes: bytes.length, sha256: sha(bytes), path: `resources/${kind}-${size}.json` });
    for (let repetition = 1; repetition <= 3; repetition++) for (const codec of ['raw', 'gzip', 'zstd']) {
      if (signal?.aborted) throw new Error('RESOURCE_TRIAL_CANCELLED');
      const artifact = `${kind}-${size}-${codec}-${repetition}.bin`;
      const command = [process.execPath, join(dirname(fileURLToPath(import.meta.url)), 'codec-worker.mjs'), path, join(directory, artifact), codec];
      const execution = await runner(command[0], command.slice(1), { timeout: 15_000, maxOutput: 16_384, signal });
      let metric = null; try { metric = JSON.parse(execution.stdout); } catch { /* Retain failed child evidence. */ }
      trials.push({ kind, requestedMinimumBytes: size, repetition, codec, command: command.map(scrub), execution, metric, artifact: `resources/${artifact}` });
      await writeFile(join(directory, 'progress.json'), JSON.stringify({ inputs, trials }, null, 2) + '\n', { mode: 0o600 });
      if (execution.exitCode !== 0 || execution.timedOut || execution.outputExceeded || execution.cancelled || metric?.state === 'failed') throw new Error('RESOURCE_CHILD_FAILED');
    }
  }
  return { inputs, trials, controls: [
    { id: 'synthetic-input-admission-exhaustion', ...admission({ inputBytes: LIMITS.maxInputBytes + 1, totalBytes: 0, trials: 1 }) },
    { id: 'synthetic-total-admission-exhaustion', ...admission({ inputBytes: 1, totalBytes: LIMITS.totalInputBytes + 1, trials: 1 }) },
    { id: 'synthetic-trial-admission-exhaustion', ...admission({ inputBytes: 1, totalBytes: 1, trials: LIMITS.maxTrials + 1 }) },
    { id: 'synthetic-unavailable-measurement', ...admission({ inputBytes: 1, totalBytes: 1, trials: 1, measurementAvailable: false }) },
  ], provenance: 'Serial trials, fresh Node process per repetition, retained input and encoded hashes. Child encode/decode timers exclude disk IO and hashing; parent wall includes process startup, file IO and hashing. Child maxRSS is lifetime high-water, never codec-only peak.' };
}
