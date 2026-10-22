// The supervisor runs one attempt of one work revision under the current store owner, and returns a checked
// outcome. It never publishes: PR 08's scheduler records the outcome in the ledger.
//
// Authority comes only from the caller and the trusted registry: the attempt id, work revision, coordinator epoch
// (the owner's), the adapter and its digest, and the inputs by digest. The invocation record that binds them is
// hashed and carried as a container label. Inputs are copied into the attempt and hashed while copied; the worker
// sees only those copies, read-only. A result is accepted only when it repeats the binding, names the start's
// input fingerprint, and every artifact it lists is re-read and hashed from the output folder, with nothing
// unlisted, linked or oversized there.
//
// Ending: a result, an acknowledged cancel, the deadline, a cancel the worker ignores past its grace, a protocol
// or framing error, an output or stdout budget, or the worker exiting. Every path stops the worker, removes its
// container by exact identity and confirms the removal; the owner's close path does the same synchronously.
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactId, Digest, Id, WorkRef } from '../contracts/common.js';
import type { AttemptWorker } from '../contracts/attempt.js';
import type { ProtocolMessage, ResultMessage } from '../contracts/protocol.js';
import type { ResourcePolicy } from '../contracts/work.js';
import type { WorkerJournal, WorkerIdentity } from './recovery.js';
import { kernelStartOf, tokenArgument } from './recovery.js';
import { syncDirectory } from './durability.js';
import type { OwnedResource } from '../store/owner.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { ExecutionError, isExecutionError, type ExecutionErrorCode } from './errors.js';
import { ContainerBackend, containerUser, intentDetail, ownerNonce, type BackendFacts, type CleanupState, type ImagePin } from './isolation.js';
import { BoundedCapture, spawnWorker, type WorkerProcess } from './processes.js';
import { encodeFrame, FrameDecoder, WorkerSession } from './protocol.js';
import { effectiveLimits, moduleDigestOf, type AdapterRegistry, type TrustedAdapter } from './registry.js';

/** The part of the store owner the supervisor needs; a StoreOwner satisfies it. */
export interface SupervisorOwner {
  readonly storeId: string;
  readonly epoch: Id;
  assertHeld(): void;
  registerResource(resource: OwnedResource): () => void;
}

export interface CapturedInput {
  id: ArtifactId;
  /** Where the captured bytes are now. They are copied and hashed before the worker starts. */
  path: string;
}

export interface AttemptRequest {
  owner: SupervisorOwner;
  registry: AdapterRegistry;
  adapterId: Id;
  attemptId: Id;
  work: WorkRef;
  inputs: readonly CapturedInput[];
  /** A private (0700, this user's) folder; the attempt works in a new folder inside it. */
  scratchRoot: string;
  /** Required for external adapters; built-in workers run without one. */
  backend?: ContainerBackend;
  signal?: AbortSignal;
  /**
   * Called once the worker exists (container created and verified, or child spawned) and before it may do any work.
   * The coordinator records the attempt in the ledger here, so the ledger's fence exists before the worker acts.
   * Throwing stops and removes the worker; the error is rethrown.
   */
  onWorker?: (worker: AttemptWorker) => void;
  /** A durable journal of container intents (recovery, PR 08): recorded before a create, settled once removed. */
  intents?: IntentJournal;
  /** A durable journal of built-in worker identities: recorded after spawn and before the worker acts. */
  workers?: WorkerJournal;
  /** The work's own resource policy; it lowers the adapter's limits (never raises them) for this attempt. */
  resources?: ResourcePolicy;
}

export type OutcomeState = 'succeeded' | 'failed' | 'canceled' | 'timed-out';

export interface VerifiedOutput {
  id: ArtifactId;
  mediaType: string;
  bytes: number;
  path: string;
}

export interface WorkerOutcome {
  state: OutcomeState;
  /** Why it did not succeed. */
  code?: ExecutionErrorCode;
  detail?: Readonly<Record<string, unknown>>;
  attemptId: Id;
  work: WorkRef;
  coordinatorEpoch: Id;
  adapter: { id: Id; digest: Digest };
  invocation: { digest: Digest; record: InvocationRecord };
  /** The worker as an attempt envelope records it. */
  worker?: AttemptWorker;
  result?: ResultMessage;
  outputs: VerifiedOutput[];
  /** Captured from stderr, bounded, never parsed as protocol. */
  diagnostics: { bytes: number; truncated: boolean; text: string };
  protocol: { frames: number; bytes: number };
  container?: { id: string; image: ImagePin; state?: { exitCode: number | null; oomKilled: boolean } };
  exit?: { exitCode: number | null; exitSignal: NodeJS.Signals | null };
  cleanup: CleanupState | 'not-applicable';
  /** For a container stopped early: whether the daemon confirmed it stopped (a client exit never proves it). */
  stopConfirmed?: boolean;
  backend?: Readonly<BackendFacts>;
  workDir: string;
}

/** A container create's whole intent: name, owner nonce and the ownership labels (see isolation.intentDetail). */
export type ContainerIntent = ReturnType<typeof intentDetail>;

export interface IntentJournal {
  /** Durable before it returns: the create may happen right after. */
  record(intent: ContainerIntent): void;
  /** The container is confirmed removed or was never made; the intent may be forgotten. */
  settle(intent: ContainerIntent): void;
}

/** Everything that decided this invocation. Hashed; its digest labels the container. No credential, ever. */
export interface InvocationRecord {
  format: 'sentinel-invocation/draft-1';
  store: string;
  attemptId: Id;
  work: WorkRef;
  coordinatorEpoch: Id;
  adapter: { id: Id; version: string; digest: Digest };
  isolation: 'container' | 'child';
  image?: { reference: string; id: string; architecture: string };
  argv: string[];
  environmentNames: string[];
  limits: TrustedAdapter['limits'];
  inputFingerprint: Digest;
  inputs: ArtifactId[];
  deadlineAt: string;
}

const sha256 = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const hexOf = (id: ArtifactId) => {
  const m = /^sha256:([0-9a-f]{64})$/.exec(id);
  if (!m) throw new ExecutionError('sentinel.execution.inputMismatch', {});
  return m[1]!;
};

/** The digest of the sorted input ids: the input fingerprint a result must repeat. */
export function inputFingerprintOf(inputs: readonly ArtifactId[]): Digest {
  return sha256(canonicalJsonBytes([...inputs].sort()));
}

export async function superviseAttempt(request: AttemptRequest): Promise<WorkerOutcome> {
  const { owner, registry } = request;
  owner.assertHeld();
  const adapter = registry.get(request.adapterId);
  if (adapter.kind === 'external' && !request.backend) {
    // No backend means no isolation, and there is no host fallback.
    throw new ExecutionError('sentinel.execution.isolationUnavailable', { reason: 'no container backend' });
  }
  const inputs = [...new Set(request.inputs.map(i => i.id))];
  if (inputs.length !== request.inputs.length) throw new ExecutionError('sentinel.execution.inputMismatch', { reason: 'duplicate input' });
  const workDir = prepareWorkDir(request.scratchRoot, request.attemptId);
  const folders = { input: identityOfDir(join(workDir, 'input')), output: identityOfDir(join(workDir, 'output')) };
  const inputDir = join(workDir, 'input');
  const outputDir = join(workDir, 'output');
  for (const input of request.inputs) copyVerified(input, join(inputDir, hexOf(input.id)));
  sealInputs(inputDir);

  const limits = effectiveLimits(adapter.limits, request.resources);
  const token = randomUUID();
  const deadlineAt = new Date(Date.now() + limits.timeoutMs).toISOString();
  const inputFingerprint = inputFingerprintOf(inputs);
  let image: ImagePin | undefined;
  if (adapter.kind === 'external') image = await request.backend!.inspectImage(adapter.image, request.signal);
  if (adapter.kind === 'built-in' && moduleDigestOf(adapter.module) !== adapter.moduleDigest) {
    throw new ExecutionError('sentinel.execution.adapterIdentityMismatch', { adapter: adapter.id });
  }
  const argv = adapter.kind === 'external' ? [...adapter.command] : [process.execPath, adapter.module, inputDir, outputDir, tokenArgument(token)];
  const environmentNames = adapter.kind === 'external'
    ? ['HOME', 'SENTINEL_INPUT', 'SENTINEL_OUTPUT', 'SENTINEL_ADAPTER_ID', 'SENTINEL_ADAPTER_DIGEST']
    : ['SENTINEL_INPUT', 'SENTINEL_OUTPUT', 'SENTINEL_ADAPTER_ID', 'SENTINEL_ADAPTER_DIGEST'];
  const record: InvocationRecord = {
    format: 'sentinel-invocation/draft-1', store: owner.storeId, attemptId: request.attemptId, work: { ...request.work },
    coordinatorEpoch: owner.epoch, adapter: { id: adapter.id, version: adapter.version, digest: adapter.digest },
    isolation: adapter.isolation, ...(image ? { image: { reference: image.reference, id: image.id, architecture: image.architecture } } : {}),
    argv, environmentNames, limits, inputFingerprint, inputs: [...inputs].sort(), deadlineAt,
  };
  const invocationDigest = sha256(canonicalJsonBytes(record));
  const session = new WorkerSession({
    attemptId: request.attemptId, work: request.work, coordinatorEpoch: owner.epoch, adapterId: adapter.id,
    adapterDigest: adapter.digest, inputFingerprint, inputs, deadlineAt,
  });
  const outcome: WorkerOutcome = {
    state: 'failed', attemptId: request.attemptId, work: { ...request.work }, coordinatorEpoch: owner.epoch,
    adapter: { id: adapter.id, digest: adapter.digest }, invocation: { digest: invocationDigest, record },
    outputs: [], diagnostics: { bytes: 0, truncated: false, text: '' }, protocol: { frames: 0, bytes: 0 },
    cleanup: 'not-applicable', workDir, ...(request.backend ? { backend: request.backend.facts } : {}),
  };

  // Start the worker: a verified container, or a built-in child with no inherited environment. The cleanup guard
  // is registered with the owner before anything exists, so closing the owner at any moment (while a create is in
  // flight, or while the worker runs) stops and removes what this attempt made. If that cannot be confirmed, the
  // guard throws with the container and its owner nonce, and the owner's close reports it rather than staying
  // silent; the labels let recovery (PR 08) find it later by store, attempt and epoch.
  const nonce = ownerNonce();
  const labels = { owner: nonce, store: owner.storeId, attempt: request.attemptId, epoch: owner.epoch, invocation: invocationDigest };
  let containerId: string | undefined;
  let proc: WorkerProcess;
  let identity: WorkerIdentity | undefined;
  const guard: { ownerClosed: boolean; createPending: boolean; id?: string; proc?: WorkerProcess } = { ownerClosed: false, createPending: false };
  const backend = request.backend;
  const unregister = owner.registerResource({
    name: `worker ${request.attemptId}${backend ? ` (container owner ${nonce})` : ''}`,
    close: () => {
      guard.ownerClosed = true;
      guard.proc?.kill();
      if (!backend) return;
      const direct = guard.id ? backend.removeSync(guard.id, labels) : 'already-absent';
      const swept = backend.reconcileOwnedSync(labels);
      if (direct === 'cleanup-failed' || swept.uncertain.length) {
        throw new ExecutionError('sentinel.execution.cleanupFailed', { ...intentDetail({ labels }), container: guard.id ?? swept.uncertain.join(', ') });
      }
      // A create still in flight may commit after this sweep; an empty sweep proves nothing then.
      if (guard.createPending && !guard.id && swept.removed.length === 0) {
        throw new ExecutionError('sentinel.execution.reconciliationPending', intentDetail({ labels }));
      }
    },
  });
  if (adapter.kind === 'external') {
    const b = backend!;
    const intent = intentDetail({ labels });
    try {
      request.intents?.record(intent);
      guard.createPending = true;
      containerId = await b.create({
        image: image!, command: adapter.command, limits, inputDir, outputDir, adapter: { id: adapter.id, digest: adapter.digest }, user: containerUser(), labels,
      }, request.signal).finally(() => { guard.createPending = false; });
      guard.id = containerId;
      if (guard.ownerClosed) {
        // The owner closed while the create was in flight; the guard swept what existed then. Remove this one too.
        const late = await b.remove(containerId, labels).catch(() => 'cleanup-failed' as const);
        if (late === 'cleanup-failed') throw new ExecutionError('sentinel.execution.cleanupFailed', { container: containerId, owner: nonce });
        owner.assertHeld();
      }
      // The mounts were read back by path; the paths must still be the folders this attempt created.
      if (!sameIdentity(inputDir, folders.input) || !sameIdentity(outputDir, folders.output)) {
        const gone = await b.remove(containerId, labels).catch(() => 'cleanup-failed' as const);
        throw new ExecutionError(gone === 'cleanup-failed' ? 'sentinel.execution.cleanupFailed' : 'sentinel.execution.isolationMismatch',
          gone === 'cleanup-failed' ? { container: containerId, owner: nonce } : { setting: 'mount identity' });
      }
      outcome.container = { id: containerId, image: image! };
      outcome.worker = { kind: 'owned-container', containerId, ownershipLabels: { store: owner.storeId, attempt: request.attemptId, epoch: owner.epoch } };
      request.onWorker?.(outcome.worker);
    } catch (error) {
      // A container that exists is removed before the error leaves; its intent is settled only when that is confirmed.
      if (containerId) {
        const gone = await b.remove(containerId, labels).catch(() => 'cleanup-failed' as const);
        if (gone !== 'cleanup-failed') request.intents?.settle(intent);
      } else if (!isExecutionError(error, 'sentinel.execution.reconciliationPending') && !isExecutionError(error, 'sentinel.execution.cleanupFailed')) {
        // The create was refused or reconciled (found and removed); nothing remains under this intent.
        if (isExecutionError(error, 'sentinel.execution.commandFailed') || isExecutionError(error, 'sentinel.execution.canceled')) request.intents?.settle(intent);
      }
      unregister();
      throw error;
    }
    const id = containerId;
    proc = b.startAttached(id);
  } else {
    // A built-in worker inherits nothing: its environment is exactly these four names.
    proc = spawnWorker(process.execPath, [adapter.module, inputDir, outputDir, tokenArgument(token)], { cwd: workDir, env: {
      SENTINEL_INPUT: inputDir, SENTINEL_OUTPUT: outputDir, SENTINEL_ADAPTER_ID: adapter.id, SENTINEL_ADAPTER_DIGEST: adapter.digest,
    } });
    const pid = proc.child.pid;
    if (pid) outcome.worker = { kind: 'owned-child', pid, processStartedAt: proc.startedAt.toISOString() };
    try {
      if (!outcome.worker || !pid) throw new ExecutionError('sentinel.execution.workerExited', { reason: 'no process id' });
      // The identity is durable before the attempt is recorded, so a crash at any later point leaves a verifiable worker.
      identity = { attempt: request.attemptId, store: owner.storeId, epoch: owner.epoch, pid, token, kernelStart: kernelStartOf(pid) ?? '' };
      request.workers?.record(identity);
      request.onWorker?.(outcome.worker);
    } catch (error) {
      proc.kill();
      await proc.exited;
      if (identity) request.workers?.settle(identity);
      unregister();
      throw error;
    }
  }
  guard.proc = proc;

  try {
    await drive(proc, session, limits, outputDir, outcome, request.signal, async () => {
      if (containerId) outcome.stopConfirmed = await request.backend!.kill(containerId, labels).catch(() => false);
      proc.kill();
    });
  } finally {
    proc.kill();
    const exit = await proc.exited;
    outcome.exit = { exitCode: exit.exitCode, exitSignal: exit.exitSignal };
    // Reaped: the pid may now be anyone's, and the worker has no identity left to verify.
    if (identity) request.workers?.settle(identity);
    if (containerId) {
      const backend = request.backend!;
      const state = await backend.state(containerId, labels).catch(() => null);
      if (state) outcome.container!.state = { exitCode: state.exitCode, oomKilled: state.oomKilled };
      if (state?.oomKilled && outcome.state === 'failed') setFailure(outcome, 'sentinel.execution.resourceExceeded', {}, true);
      outcome.cleanup = await backend.remove(containerId, labels).catch(() => 'cleanup-failed' as const);
      if (outcome.cleanup !== 'cleanup-failed') request.intents?.settle(intentDetail({ labels }));
    }
    unregister();
  }

  // Exit facts first: a worker that delivered a result must also have exited cleanly.
  if (outcome.state === 'succeeded') {
    const containerExit = outcome.container?.state?.exitCode;
    const exitCode = containerExit ?? outcome.exit.exitCode;
    if (exitCode !== 0) setFailure(outcome, 'sentinel.execution.workerExited', { exitCode: exitCode ?? -1 }, true);
  }
  if (outcome.state === 'succeeded') {
    try { outcome.outputs = verifyOutputs(outputDir, outcome.result!, limits.outputBytes); }
    catch (error) {
      if (error instanceof ExecutionError) setFailure(outcome, error.code, error.detail, true);
      else setFailure(outcome, 'sentinel.execution.outputMismatch', { reason: 'output unreadable' }, true);
    }
  }
  if (outcome.cleanup === 'cleanup-failed') setFailure(outcome, 'sentinel.execution.cleanupFailed', { container: containerId ?? '' }, true);
  if (outcome.state === 'succeeded') {
    try { owner.assertHeld(); } catch (error) { setFailure(outcome, 'sentinel.execution.protocolViolation', { rule: 'owner-lost', cause: (error as { code?: string }).code ?? 'unknown' }, true); }
  }
  if (outcome.state !== 'succeeded') delete outcome.result;
  return outcome;
}

function setFailure(outcome: WorkerOutcome, code: ExecutionErrorCode, detail: Record<string, unknown>, override = false): void {
  if (outcome.code && !override) return;
  outcome.state = code === 'sentinel.execution.canceled' ? 'canceled' : code === 'sentinel.execution.deadlineExceeded' ? 'timed-out' : 'failed';
  outcome.code = code;
  outcome.detail = Object.freeze({ ...detail });
  outcome.outputs = [];
}

/** Run the protocol until the worker ends one way or another. Never throws for worker behaviour. */
function drive(proc: WorkerProcess, session: WorkerSession, limits: TrustedAdapter['limits'], outputDir: string,
  outcome: WorkerOutcome, signal: AbortSignal | undefined, stop: () => Promise<void>): Promise<void> {
  return new Promise<void>(resolve => {
    const decoder = new FrameDecoder({ maxFrameBytes: limits.maxFrameBytes, maxTotalBytes: limits.stdoutBytes });
    const stderr = new BoundedCapture(limits.stderrBytes);
    const timers: NodeJS.Timeout[] = [];
    let settled = false;
    const finish = (code?: ExecutionErrorCode, detail: Record<string, unknown> = {}) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      clearInterval(poll);
      signal?.removeEventListener('abort', onAbort);
      if (code) setFailure(outcome, code, detail);
      outcome.diagnostics = { bytes: stderr.bytes, truncated: stderr.truncated, text: stderr.text() };
      outcome.protocol = { frames: decoder.frames, bytes: decoder.bytes };
      try { proc.child.stdin.end(); } catch { /* closed */ }
      if (code) void stop().finally(resolve); else resolve();
    };
    const send = (m: ProtocolMessage) => {
      try { proc.child.stdin.write(encodeFrame(m, limits.maxFrameBytes)); } catch { /* the worker closed stdin; exit decides */ }
    };
    // Each stream has an emitted-byte ceiling, and the two together have the combined one: past any of them the
    // worker is stopped. Only a bounded copy of stderr is kept for diagnostics.
    const combinedLimit = limits.stdoutBytes + limits.stderrBytes;
    let stdoutEmitted = 0;
    const overCombined = () => stdoutEmitted + stderr.bytes > combinedLimit;
    proc.child.stderr.on('data', (b: Buffer) => {
      if (settled) return;
      stderr.push(b);
      outcome.diagnostics = { bytes: stderr.bytes, truncated: stderr.truncated, text: '' };
      if (stderr.bytes > limits.stderrBytes || overCombined()) finish('sentinel.execution.stderrBudget', { bytes: limits.stderrBytes, combined: combinedLimit });
    });
    proc.child.stdout.on('data', (b: Buffer) => {
      if (settled) return;
      stdoutEmitted += b.byteLength;
      if (overCombined()) return finish('sentinel.execution.stdoutBudget', { combined: combinedLimit });
      let messages: ProtocolMessage[];
      try { messages = decoder.push(b); } catch (e) { return finish((e as ExecutionError).code, (e as ExecutionError).detail); }
      for (const m of messages) {
        if (settled) return;
        let step;
        try { step = session.receive(m); } catch (e) { return finish((e as ExecutionError).code, (e as ExecutionError).detail); }
        for (const out of step.send) send(out);
        if (step.canceled) return finish('sentinel.execution.canceled');
        if (step.result) {
          // Provisional: confirmed only at stdout end of stream with clean framing and a clean exit.
          outcome.result = step.result;
          outcome.state = 'succeeded';
          // The worker should now exit on its own; give it the cancel grace to do so.
          proc.child.stdin.end();
          timers.push(setTimeout(() => finish('sentinel.execution.workerExited', { reason: 'no exit after result' }), limits.cancelGraceMs));
          // Keep reading: any frame after the result, even in this same chunk, is a violation that voids it.
          continue;
        }
      }
      if (session.phase === 'failed') finish('sentinel.execution.versionRefused');
    });
    void proc.exited.then(exit => {
      if (settled) return;
      if (exit.spawnError) return finish('sentinel.execution.workerExited', { reason: exit.spawnError });
      // A result is only provisional until stdout has closed: 'close' fires after every stdout byte has been
      // delivered, and a partial trailing frame, even after a result, voids it.
      try { decoder.end(); } catch (e) { return finish((e as ExecutionError).code, (e as ExecutionError).detail); }
      if (outcome.state === 'succeeded') return finish();
      if (session.phase === 'canceling') return finish('sentinel.execution.canceled');
      return finish('sentinel.execution.workerExited', { exitCode: exit.exitCode ?? -1 });
    });
    timers.push(setTimeout(() => { if (session.phase === 'awaiting-hello') finish('sentinel.execution.protocolViolation', { rule: 'no-hello' }); }, limits.helloTimeoutMs));
    timers.push(setTimeout(() => finish('sentinel.execution.deadlineExceeded'), limits.timeoutMs));
    // The output folder is measured while the worker runs, so filling the disk is stopped, not just noticed.
    const poll = setInterval(() => {
      if (outputBytesOver(outputDir, limits.outputBytes)) finish('sentinel.execution.outputTooLarge', { bytes: limits.outputBytes });
    }, 200);
    const onAbort = () => {
      const cancel = session.cancel();
      if (!cancel) return finish('sentinel.execution.canceled');
      send(cancel);
      timers.push(setTimeout(() => finish('sentinel.execution.canceled', { forced: true }), limits.cancelGraceMs));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

const identityOfDir = (path: string): string => { const s = lstatSync(path, { bigint: true }); return `${s.dev}:${s.ino}`; };
const sameIdentity = (path: string, identity: string): boolean => { try { return identityOfDir(path) === identity; } catch { return false; } };

function prepareWorkDir(scratchRoot: string, attemptId: Id): string {
  let s, real;
  try { s = lstatSync(scratchRoot); real = realpathSync.native(scratchRoot); } catch { throw new ExecutionError('sentinel.execution.scratchUnsafe', {}); }
  // Canonical, so the mount sources the daemon reports can be compared with the folders as created.
  if (real !== scratchRoot || !s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0) {
    throw new ExecutionError('sentinel.execution.scratchUnsafe', {});
  }
  const dir = join(scratchRoot, `${attemptId.replace(/[^A-Za-z0-9._-]/g, '_')}-${randomUUID()}`);
  mkdirSync(dir, { mode: 0o700 });
  mkdirSync(join(dir, 'input'), { mode: 0o700 });
  mkdirSync(join(dir, 'output'), { mode: 0o700 });
  // A container running as 65534 (only when Sentinel itself runs as root) needs to write here; the folder is
  // still reachable only through the private parent. Otherwise the container runs as this user and it stays 0700.
  if (containerUser() === '65534:65534') chmodSync(join(dir, 'output'), 0o777);
  return dir;
}

/** Copy one input into the attempt, hashing the bytes actually written. */
function copyVerified(input: CapturedInput, target: string): void {
  let s;
  try { s = lstatSync(input.path); } catch { throw new ExecutionError('sentinel.execution.inputMismatch', { reason: 'unreadable' }); }
  if (!s.isFile()) throw new ExecutionError('sentinel.execution.inputMismatch', { reason: 'not a regular file' });
  copyFileSync(input.path, target, constants.COPYFILE_EXCL);
  if (digestFile(target) !== input.id) {
    rmSync(target, { force: true });
    throw new ExecutionError('sentinel.execution.inputMismatch', {});
  }
}

function sealInputs(dir: string): void {
  for (const name of readdirSync(dir)) chmodSync(join(dir, name), 0o444);
  chmodSync(dir, 0o555);
}

function digestFile(path: string): Digest {
  const hash = createHash('sha256');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n));
  } finally { closeSync(fd); }
  return `sha256:${hash.digest('hex')}`;
}

function outputBytesOver(dir: string, limit: number): boolean {
  let total = 0, entries = 0;
  const walk = (d: string): boolean => {
    let names: string[];
    try { names = readdirSync(d); } catch { return false; }
    for (const name of names) {
      if (++entries > 100_000) return true;
      let s;
      try { s = lstatSync(join(d, name)); } catch { continue; }
      total += s.isDirectory() ? 4096 : s.size;
      if (total > limit) return true;
      if (s.isDirectory() && walk(join(d, name))) return true;
    }
    return false;
  };
  return walk(dir);
}

/** Re-read every listed artifact; refuse anything missing, extra, linked, resized, changed or over budget. */
export function verifyOutputs(dir: string, result: ResultMessage, limit: number): VerifiedOutput[] {
  const mismatch = (reason: string): never => { throw new ExecutionError('sentinel.execution.outputMismatch', { reason }); };
  const listed = new Map<string, ResultMessage['artifacts'][number]>();
  for (const a of result.artifacts) {
    if (listed.has(hexOf(a.id))) mismatch('duplicate artifact');
    listed.set(hexOf(a.id), a);
  }
  const produced = new Set(result.artifacts.map(a => a.id));
  const refs = [...result.observations, ...result.coveredChecks.map(c => c.coverage)];
  if (refs.some(id => !produced.has(id))) mismatch('reference to an output that was not produced');
  const names = readdirSync(dir);
  if (names.some(n => !listed.has(n))) mismatch('unlisted output');
  let total = 0;
  const outputs: VerifiedOutput[] = [];
  for (const [hex, a] of listed) {
    const path = join(dir, hex);
    let s;
    try { s = lstatSync(path); } catch { return mismatch('missing output'); }
    if (!s.isFile() || s.nlink !== 1) mismatch('output is not a single regular file');
    if (s.size !== a.bytes) mismatch('output size differs');
    total += s.size;
    if (total > limit) throw new ExecutionError('sentinel.execution.outputTooLarge', { bytes: limit });
    if (digestFile(path) !== a.id) mismatch('output digest differs');
    outputs.push({ id: a.id, mediaType: a.mediaType, bytes: a.bytes, path });
  }
  syncDirectory(dir);
  return outputs;
}

/**
 * Remove an attempt folder once its outputs have been stored. The sealed input folder is made writable again
 * first; links inside are removed, never followed.
 */
export function releaseWorkDir(workDir: string): void {
  const input = join(workDir, 'input');
  try { if (lstatSync(input).isDirectory()) chmodSync(input, 0o700); } catch { /* absent */ }
  rmSync(workDir, { recursive: true, force: true });
}
