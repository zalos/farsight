// The bounded worker protocol, sentinel-worker/draft-1 (contracts/protocol.ts), as the coordinator speaks it.
//
// Framing: one message per line of UTF-8 JSON on the worker's stdout, newline-terminated. The decoder enforces
// the frame size before it decodes or parses anything, so an endless or oversized line costs at most one frame
// of memory; it also caps the number of frames and the total bytes. Invalid UTF-8 is refused, not replaced.
// A partial line is copied into one reusable buffer, grown by doubling up to the frame limit, never kept as a
// list of chunks: however finely a worker splits its output, buffering stays O(maxFrameBytes).
// stderr is never read as protocol: the supervisor keeps it apart as bounded diagnostics.
//
// Authority: the session is built from the supervisor's own binding (attempt, work revision, coordinator epoch,
// adapter id and digest, input fingerprint). A worker's message is accepted only when it repeats that binding
// exactly and its sequence number is the next one; a worker cannot supply or change its own authority.
import { MAX_ENVELOPE_BYTES } from '../contracts/index.js';
import type {
  AttemptBinding, CancelMessage, HelloMessage, ProtocolMessage, RefuseMessage, ResultMessage, StartMessage, WelcomeMessage,
} from '../contracts/protocol.js';
import type { ArtifactId, Digest, Id, Timestamp, WorkRef } from '../contracts/common.js';
import { negotiateProtocol, validateEnvelope } from '../validate.js';
import { ExecutionError, type ExecutionErrorCode } from './errors.js';

export const PROTOCOL = 'sentinel-worker/draft-1' as const;
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_MAX_FRAMES = 100_000;
export const DEFAULT_MAX_PROTOCOL_BYTES = 64 * 1024 * 1024;

export interface FrameLimits {
  /** Largest single message line, newline excluded. At most the contract's envelope limit. */
  maxFrameBytes?: number;
  maxFrames?: number;
  /** Total protocol bytes over the attempt. */
  maxTotalBytes?: number;
}

const NEWLINE = 0x0a;
/** The partial-line buffer's first size; it doubles as needed, never past the frame limit. */
const INITIAL_PENDING_BYTES = 4096;

/** Splits a byte stream into bounded frames and decodes each as one validated protocol message. */
export class FrameDecoder {
  readonly #maxFrame: number;
  readonly #maxFrames: number;
  readonly #maxTotal: number;
  readonly #utf8 = new TextDecoder('utf-8', { fatal: true });
  /** The partial line so far: `#pending[0, #pendingBytes)`. Allocated on first need; capacity ≤ the frame limit. */
  #pending: Buffer | undefined;
  #pendingBytes = 0;
  #frames = 0;
  #total = 0;
  #failed: ExecutionError | undefined;

  constructor(limits: FrameLimits = {}) {
    this.#maxFrame = bounded(limits.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES, 1, MAX_ENVELOPE_BYTES, 'maxFrameBytes');
    this.#maxFrames = bounded(limits.maxFrames ?? DEFAULT_MAX_FRAMES, 1, 10_000_000, 'maxFrames');
    this.#maxTotal = bounded(limits.maxTotalBytes ?? DEFAULT_MAX_PROTOCOL_BYTES, 1, 2 ** 40, 'maxTotalBytes');
  }

  /** Feed bytes; returns every complete message. Throws the first ExecutionError and keeps throwing it after. */
  push(chunk: Uint8Array): ProtocolMessage[] {
    if (this.#failed) throw this.#failed;
    try {
      this.#total += chunk.byteLength;
      if (this.#total > this.#maxTotal) this.#fail('sentinel.execution.stdoutBudget', { bytes: this.#maxTotal });
      const out: ProtocolMessage[] = [];
      let buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      for (;;) {
        const nl = buf.indexOf(NEWLINE);
        if (nl < 0) {
          // The size check happens before any decode: a line that cannot fit fails here, unread.
          if (this.#pendingBytes + buf.byteLength > this.#maxFrame) this.#fail('sentinel.execution.frameTooLarge', { bytes: this.#maxFrame });
          this.#append(buf);
          return out;
        }
        if (this.#pendingBytes + nl > this.#maxFrame) this.#fail('sentinel.execution.frameTooLarge', { bytes: this.#maxFrame });
        let frame: Buffer;
        if (this.#pendingBytes === 0) {
          frame = buf.subarray(0, nl); // the whole line is in this chunk: no copy
        } else {
          this.#append(buf.subarray(0, nl));
          frame = this.#pending!.subarray(0, this.#pendingBytes);
        }
        // Decoding copies the bytes into a string, so the buffer can be reused for the next line straight away.
        this.#pendingBytes = 0;
        buf = buf.subarray(nl + 1);
        if (++this.#frames > this.#maxFrames) this.#fail('sentinel.execution.stdoutBudget', { frames: this.#maxFrames });
        out.push(this.#decode(frame));
      }
    } catch (error) {
      this.#failed = error instanceof ExecutionError ? error : new ExecutionError('sentinel.execution.frameMalformed', {}, { cause: error });
      throw this.#failed;
    }
  }

  /** The stream ended. A partial final line is a malformed frame, never a message. */
  end(): void {
    if (this.#failed) throw this.#failed;
    if (this.#pendingBytes > 0) {
      this.#failed = new ExecutionError('sentinel.execution.frameMalformed', { reason: 'unterminated' });
      throw this.#failed;
    }
  }

  /** Copies bytes into the partial-line buffer. The caller has already checked the frame limit. */
  #append(bytes: Buffer): void {
    if (bytes.byteLength === 0) return;
    const needed = this.#pendingBytes + bytes.byteLength;
    if (!this.#pending || needed > this.#pending.byteLength) {
      let capacity = Math.max(this.#pending?.byteLength ?? 0, Math.min(INITIAL_PENDING_BYTES, this.#maxFrame));
      while (capacity < needed) capacity = Math.min(capacity * 2, this.#maxFrame);
      const grown = Buffer.allocUnsafe(capacity);
      if (this.#pending && this.#pendingBytes) this.#pending.copy(grown, 0, 0, this.#pendingBytes);
      this.#pending = grown;
    }
    bytes.copy(this.#pending, this.#pendingBytes);
    this.#pendingBytes = needed;
  }

  get frames(): number { return this.#frames; }
  get bytes(): number { return this.#total; }

  #decode(frame: Buffer): ProtocolMessage {
    let text: string;
    let value: unknown;
    try {
      text = this.#utf8.decode(frame);
      value = JSON.parse(text);
    } catch (cause) {
      throw new ExecutionError('sentinel.execution.frameMalformed', {}, { cause });
    }
    const checked = validateEnvelope('protocol', value);
    if (!checked.ok) throw new ExecutionError('sentinel.execution.messageInvalid', { errors: checked.errors.slice(0, 4).map(e => `${e.code} ${e.path}`) });
    return checked.value;
  }

  #fail(code: ExecutionErrorCode, detail: Record<string, number>): never {
    throw new ExecutionError(code, detail);
  }
}

function bounded(n: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

/** Serialise one coordinator message, validated and size-checked, as one frame. */
export function encodeFrame(message: ProtocolMessage, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES): Buffer {
  const checked = validateEnvelope('protocol', message);
  if (!checked.ok) throw new ExecutionError('sentinel.execution.messageInvalid', { errors: checked.errors.slice(0, 4).map(e => `${e.code} ${e.path}`) });
  const bytes = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
  if (bytes.byteLength - 1 > maxFrameBytes) throw new ExecutionError('sentinel.execution.frameTooLarge', { bytes: maxFrameBytes });
  return bytes;
}

/** Everything the coordinator, not the worker, decides about one attempt. */
export interface SessionBinding {
  attemptId: Id;
  work: WorkRef;
  coordinatorEpoch: Id;
  adapterId: Id;
  adapterDigest: Digest;
  inputFingerprint: Digest;
  inputs: ArtifactId[];
  deadlineAt: Timestamp;
}

export type SessionPhase = 'awaiting-hello' | 'running' | 'canceling' | 'finished' | 'failed';

/** What the supervisor must do after a worker message. */
export interface SessionStep {
  send: ProtocolMessage[];
  result?: ResultMessage;
  canceled?: boolean;
}

/**
 * The coordinator side of one attempt. Feed it each decoded worker message; it answers with what to send, and
 * throws a protocolViolation (or versionRefused, adapterIdentityMismatch, resultMismatch) the first time the
 * worker steps outside the protocol. After a throw the session stays failed.
 */
export class WorkerSession {
  readonly binding: Readonly<SessionBinding>;
  #phase: SessionPhase = 'awaiting-hello';
  #sentSeq = 0;
  #receivedSeq = 0;
  #failure: ExecutionError | undefined;

  constructor(binding: SessionBinding) {
    this.binding = Object.freeze({ ...binding, work: Object.freeze({ ...binding.work }), inputs: Object.freeze([...binding.inputs]) as ArtifactId[] });
  }

  get phase(): SessionPhase { return this.#phase; }

  receive(message: ProtocolMessage): SessionStep {
    if (this.#failure) throw this.#failure;
    try {
      return this.#receive(message);
    } catch (error) {
      this.#phase = 'failed';
      this.#failure = error instanceof ExecutionError ? error : new ExecutionError('sentinel.execution.protocolViolation', { rule: 'internal' }, { cause: error });
      throw this.#failure;
    }
  }

  /** The coordinator asks the worker to stop. Returns the frame to send, or nothing once finished. */
  cancel(reasonCode = 'sentinel.execution.canceled'): CancelMessage | undefined {
    if (this.#phase !== 'running') return undefined;
    this.#phase = 'canceling';
    return { protocol: PROTOCOL, type: 'cancel', ...this.#nextBinding(), reasonCode };
  }

  #receive(message: ProtocolMessage): SessionStep {
    if (this.#phase === 'awaiting-hello') {
      if (message.type !== 'hello') violation('hello-first');
      return this.#hello(message);
    }
    if (this.#phase === 'finished' || this.#phase === 'failed') violation('message-after-end');
    if (message.type === 'hello') violation('hello-repeated');
    if (!('attemptId' in message)) violation('coordinator-message-from-worker');
    // start, cancel, welcome and refuse travel only from the coordinator; heartbeats belong to external claims.
    if (message.type === 'start' || message.type === 'cancel') violation('coordinator-message-from-worker');
    if (message.type === 'heartbeat') violation('heartbeat-from-owned-worker');
    this.#checkBinding(message);
    switch (message.type) {
      case 'progress':
        if (message.completed > message.planned) violation('progress-overrun');
        return { send: [] };
      case 'diagnostic':
      case 'checkpoint':
        return { send: [] };
      case 'cancel-ack':
        if (this.#phase !== 'canceling') violation('cancel-ack-without-cancel');
        this.#phase = 'finished';
        return { send: [], canceled: true };
      case 'result':
        if (this.#phase === 'canceling') violation('result-after-cancel');
        if (message.inputFingerprint !== this.binding.inputFingerprint) {
          throw new ExecutionError('sentinel.execution.resultMismatch', {});
        }
        this.#phase = 'finished';
        return { send: [], result: message };
      default:
        return violation('unexpected-message');
    }
  }

  #hello(hello: HelloMessage): SessionStep {
    const answer: WelcomeMessage | RefuseMessage = negotiateProtocol(hello);
    if (answer.type === 'refuse') {
      this.#phase = 'failed';
      this.#failure = new ExecutionError('sentinel.execution.versionRefused', { supported: [PROTOCOL] });
      return { send: [answer] };
    }
    if (hello.adapterId !== this.binding.adapterId || hello.adapterDigest !== this.binding.adapterDigest) {
      throw new ExecutionError('sentinel.execution.adapterIdentityMismatch', { adapter: this.binding.adapterId });
    }
    this.#phase = 'running';
    const start: StartMessage = {
      protocol: PROTOCOL, type: 'start', ...this.#nextBinding(),
      inputFingerprint: this.binding.inputFingerprint, inputs: [...this.binding.inputs], deadlineAt: this.binding.deadlineAt,
    };
    return { send: [answer, start] };
  }

  #nextBinding(): AttemptBinding {
    return { attemptId: this.binding.attemptId, work: { ...this.binding.work }, coordinatorEpoch: this.binding.coordinatorEpoch, seq: this.#sentSeq++ };
  }

  #checkBinding(message: AttemptBinding): void {
    if (message.attemptId !== this.binding.attemptId) violation('attempt');
    if (message.work.id !== this.binding.work.id || message.work.revision !== this.binding.work.revision) violation('work-revision');
    if (message.coordinatorEpoch !== this.binding.coordinatorEpoch) violation('coordinator-epoch');
    if (message.fencingGeneration !== undefined) violation('fencing-on-owned-worker');
    if (message.seq !== this.#receivedSeq) violation(message.seq < this.#receivedSeq ? 'sequence-repeat' : 'sequence-gap');
    this.#receivedSeq++;
  }
}

function violation(rule: string): never {
  throw new ExecutionError('sentinel.execution.protocolViolation', { rule });
}
