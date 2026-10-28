// Sentinel's fixed supervised structural-query child. Reads only start.job and named sealed IDs. No target imports,
// checkout, network, deep engine or security coverage. Supervisor owns hard process cancellation/deadline/output;
// cooperative checks share the remaining original unit deadline through reading, all queries and output writing.
import { constants as FS, openSync, fstatSync, readFileSync, closeSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspectPathInputs, PATHS_OUTPUT_MEDIA } from './protocol.js';
import { PATHS_ADAPTER_ID, PATHS_PROTOCOL_INPUT_LIMIT } from './request.js';
import { PathExecutionBudget, PathBudgetError } from './budget.js';
import type { ArtifactId } from '../../contracts/common.js';
import { sha256Hex } from '../../kernel/digest.js';

const P = 'sentinel-worker/draft-1',
  ID = /^sha256:([0-9a-f]{64})$/;
/**
 * The bounded-paths child process: answers its hello's welcome and start, then reads only the sealed ids it was given,
 * answers every query under one shared budget and the unit's remaining deadline, writes one output named by its digest
 * and reports it. Its exit codes:
 * - 0 after a cancel (before the welcome, before the start, or after it with a cancel acknowledgement) or when its
 *   input ends;
 * - 9 when the message after its hello is not a welcome;
 * - 3 for input past 1 MiB or more than four queued messages, a line that is not JSON, a start that is not this
 *   adapter's valid start (its job a sealed digest among at most 1,024 inputs), a deadline that is not finite, and a
 *   refusal, which it first reports as a diagnostic with `sentinel.paths.budgetExceeded` (a budget, its deadline or a
 *   cancel) or `sentinel.paths.unbound` (any other failure, such as a read the job did not seal).
 */
export async function runBoundedPathsWorker(): Promise<void> {
  const input = process.env.SENTINEL_INPUT!,
    output = process.env.SENTINEL_OUTPUT!;
  const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  const queue: any[] = [];
  let pending = '',
    wake: (() => void) | undefined,
    started = false;
  const canceled = new AbortController();
  process.stdin.on('data', (bytes: Buffer) => {
    pending += bytes.toString('utf8');
    if (Buffer.byteLength(pending) > 1024 * 1024 || queue.length > 4) process.exit(3);
    for (let nl; (nl = pending.indexOf('\n')) >= 0;) {
      let value: any;
      try {
        value = JSON.parse(pending.slice(0, nl));
      } catch {
        process.exit(3);
      }
      pending = pending.slice(nl + 1);
      if (started && value.type === 'cancel') {
        canceled.abort();
        send({ protocol: P, type: 'cancel-ack', ...binding, seq: sequence++ });
        process.exit(0);
      }
      if (queue.length >= 4) process.exit(3);
      queue.push(value);
      wake?.();
    }
  });
  process.stdin.on('end', () => {
    canceled.abort();
    process.exit(0);
  });
  const next = async () => {
    while (!queue.length)
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    return queue.shift();
  };
  send({
    protocol: P,
    type: 'hello',
    supported: [P],
    adapterId: process.env.SENTINEL_ADAPTER_ID,
    adapterDigest: process.env.SENTINEL_ADAPTER_DIGEST,
  });
  const welcome = await next();
  if (welcome.type === 'cancel') process.exit(0);
  if (welcome.type !== 'welcome') process.exit(9);
  const start = await next();
  if (start.type === 'cancel') process.exit(0);
  if (
    start.type !== 'start' ||
    process.env.SENTINEL_ADAPTER_ID !== PATHS_ADAPTER_ID ||
    !Array.isArray(start.inputs) ||
    start.inputs.length > PATHS_PROTOCOL_INPUT_LIMIT ||
    !ID.test(start.job) ||
    !start.inputs.includes(start.job)
  )
    process.exit(3);
  const binding = { attemptId: start.attemptId, work: start.work, coordinatorEpoch: start.coordinatorEpoch };
  let sequence = 0;
  started = true;
  // Stream chunks are not message boundaries: start and cancel can be decoded before the awaits above resume.
  // Consume that already queued cancel before any job read, rather than leaving it behind the selected start.
  if (queue.some((value) => value.type === 'cancel')) {
    canceled.abort();
    send({ protocol: P, type: 'cancel-ack', ...binding, seq: sequence++ });
    process.exit(0);
  }
  const absolute = Date.parse(start.deadlineAt);
  if (!Number.isFinite(absolute)) process.exit(3);
  let budget: PathExecutionBudget | undefined;
  try {
    budget = new PathExecutionBudget({
      signal: canceled.signal,
      deadlineAt: performance.now() + Math.max(0, absolute - Date.now()),
    });
    const allowed = new Set<string>(start.inputs);
    const read = async (id: ArtifactId, max = 16 * 1024 * 1024) => {
      budget!.boundary();
      const match = ID.exec(id);
      if (!match || !allowed.has(id)) throw Error('unsealed');
      const fd = openSync(`${input}/${match[1]}`, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > max) throw Error('input bound');
        return readFileSync(fd);
      } finally {
        closeSync(fd);
      }
    };
    // The selected job is read once here to discover named IDs. The shared reader rechecks its exact sealed bytes
    // and charges it with every other unique object; no captured JSON is scanned to choose a job.
    const job = await read(start.job, 4096),
      doc = await inspectPathInputs(
        job,
        start.inputs,
        (id) => (id === start.job ? Promise.resolve(job) : read(id)),
        budget,
      );
    budget.boundary();
    const bytes = Buffer.from(JSON.stringify(doc));
    budget.output(bytes.length);
    budget.boundary();
    const hash = sha256Hex(bytes);
    writeFileSync(`${output}/${hash}`, bytes, { flag: 'wx', mode: 0o600 });
    budget.boundary();
    send({
      protocol: P,
      type: 'result',
      ...binding,
      seq: sequence++,
      inputFingerprint: start.inputFingerprint,
      granularity: 'aggregate',
      artifacts: [{ id: `sha256:${hash}`, mediaType: PATHS_OUTPUT_MEDIA, bytes: bytes.length }],
      observations: [],
      coveredChecks: [],
      scannedSet: [],
      skipped: [],
      actualReadSet: [],
      unresolvedFrontiers: [],
      diagnostics: [],
    });
    process.stdin.destroy();
  } catch (error) {
    const code = error instanceof PathBudgetError ? error.code : 'sentinel.paths.unbound';
    process.stderr.write(
      JSON.stringify({
        code,
        reason: error instanceof PathBudgetError ? error.reason : 'unbound',
        usage: budget?.usage(),
      }) + '\n',
    );
    send({ protocol: P, type: 'diagnostic', ...binding, seq: sequence++, code });
    process.exitCode = 3;
    process.stdin.destroy();
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runBoundedPathsWorker();
