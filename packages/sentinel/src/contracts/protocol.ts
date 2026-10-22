import type { ArtifactId, CatalogKey, Count, Digest, Id, ScopeId, ScopedReason, Timestamp, WorkRef } from './common.js';
import type { CoverageGranularity } from './coverage.js';

/**
 * A supported protocol version string.
 * @pattern ^sentinel-worker/(draft-[1-9][0-9]*|v[1-9][0-9]*)$
 */
export type ProtocolVersion = string;

/** Binds every message after the handshake to one attempt under one coordinator epoch. */
export interface AttemptBinding {
  attemptId: Id;
  work: WorkRef;
  coordinatorEpoch: Id;
  /** Required for an external claim, absent for an owned child. */
  fencingGeneration?: Count;
  /** Monotonic per attempt and direction; a gap or repeat is a protocol error. */
  seq: Count;
}

/** The worker opens with every version it speaks; the coordinator answers with one or refuses explicitly. */
export interface HelloMessage {
  protocol: 'sentinel-worker/draft-1';
  type: 'hello';
  /**
   * @minItems 1
   * @maxItems 8
   */
  supported: ProtocolVersion[];
  adapterId: Id;
  adapterDigest: Digest;
}

export interface WelcomeMessage {
  protocol: 'sentinel-worker/draft-1';
  type: 'welcome';
  selected: 'sentinel-worker/draft-1';
}

/** No shared version: the coordinator refuses rather than guessing a compatible subset. */
export interface RefuseMessage {
  protocol: 'sentinel-worker/draft-1';
  type: 'refuse';
  reasonCode: CatalogKey;
  /** @maxItems 8 */
  supported: ProtocolVersion[];
}

export interface StartMessage extends AttemptBinding {
  protocol: 'sentinel-worker/draft-1';
  type: 'start';
  inputFingerprint: Digest;
  /** @maxItems 1024 */
  inputs: ArtifactId[];
  deadlineAt: Timestamp;
}

export interface CancelMessage extends AttemptBinding {
  protocol: 'sentinel-worker/draft-1';
  type: 'cancel';
  reasonCode: CatalogKey;
}

export interface ProgressMessage extends AttemptBinding {
  protocol: 'sentinel-worker/draft-1';
  type: 'progress';
  completed: Count;
  planned: Count;
}

export interface CheckpointMessage extends AttemptBinding {
  protocol: 'sentinel-worker/draft-1';
  type: 'checkpoint';
  checkpoint: ArtifactId;
}

/** Client-hosted claims only; owned children are supervised by process exit, not wall-clock leases. */
export interface HeartbeatMessage extends AttemptBinding {
  protocol: 'sentinel-worker/draft-1';
  type: 'heartbeat';
  fencingGeneration: Count;
}

export interface DiagnosticMessage extends AttemptBinding {
  protocol: 'sentinel-worker/draft-1';
  type: 'diagnostic';
  code: CatalogKey;
  scopeId?: ScopeId;
}

export interface CancelAckMessage extends AttemptBinding {
  protocol: 'sentinel-worker/draft-1';
  type: 'cancel-ack';
}

export interface ResultArtifact {
  id: ArtifactId;
  /** @maxLength 128 */
  mediaType: string;
  bytes: Count;
}

/** A bounded candidate result. The coordinator recomputes digests and revalidates every field before publishing. */
export interface ResultMessage extends AttemptBinding {
  protocol: 'sentinel-worker/draft-1';
  type: 'result';
  inputFingerprint: Digest;
  granularity: CoverageGranularity;
  /** @maxItems 1024 */
  artifacts: ResultArtifact[];
  /** @maxItems 10000 */
  observations: ArtifactId[];
  /** @maxItems 10000 */
  coveredChecks: Array<{ checkId: Id; coverage: ArtifactId }>;
  /**
   * Never finer than the engine exposes.
   * @maxItems 100000
   */
  scannedSet: ScopeId[];
  /** @maxItems 100000 */
  skipped: ScopedReason[];
  /** @maxItems 100000 */
  actualReadSet: ScopeId[];
  /** @maxItems 10000 */
  unresolvedFrontiers: ScopedReason[];
  /** @maxItems 10000 */
  diagnostics: Array<{ code: CatalogKey; scopeId?: ScopeId }>;
}

/**
 * sentinel-worker/draft-1 — every message either side may send.
 * @discriminator type
 */
export type ProtocolMessage =
  | HelloMessage
  | WelcomeMessage
  | RefuseMessage
  | StartMessage
  | CancelMessage
  | ProgressMessage
  | CheckpointMessage
  | HeartbeatMessage
  | DiagnosticMessage
  | CancelAckMessage
  | ResultMessage;
