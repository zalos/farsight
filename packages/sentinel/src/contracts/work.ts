import type { ArtifactId, CatalogKey, Count, Digest, Id, Ordinal, Timestamp, WorkRef } from './common.js';

/** Who implements a stage. An agentic stage never inherits a deterministic stage's provenance. */
export type StageKind = 'coded' | 'agentic' | 'external-tool';

export interface StageRef {
  /** @maxLength 128 */
  contract: string;
  /** @pattern ^draft-[1-9][0-9]*$|^v[1-9][0-9]*$ */
  contractVersion: string;
  kind: StageKind;
  implementationDigest: Digest;
}

/**
 * Bounds the supervisor enforces. The PR 01 proposed ceilings (2 GiB, 2 CPUs, 128 PIDs, 120 s, 4 MiB output)
 * are the maxima here; a profile may only lower them.
 */
export interface ResourcePolicy {
  /**
   * @asType integer
   * @minimum 1
   * @maximum 120000
   */
  deadlineMs: number;
  /**
   * @asType integer
   * @minimum 1
   * @maximum 2147483648
   */
  memoryBytes: number;
  /**
   * @minimum 0.1
   * @maximum 2
   */
  cpuQuota: number;
  /**
   * @asType integer
   * @minimum 1
   * @maximum 128
   */
  maxPids: number;
  /**
   * @asType integer
   * @minimum 1
   * @maximum 4194304
   */
  maxOutputBytes: number;
}

interface WorkBase {
  schema: 'sentinel-work/draft-1';
  id: Id;
  revision: Ordinal;
  runId: Id;
  planRevision: Ordinal;
  stage: StageRef;
  inputFingerprint: Digest;
  /** The artifact listing every fingerprint input, kept so the hash can be inspected. */
  influenceManifest: ArtifactId;
  /** @maxItems 1024 */
  dependencies: WorkRef[];
  resources: ResourcePolicy;
  coordinatorEpoch: Id;
  createdAt: Timestamp;
}

/** Waiting, ready, or finished without an active attempt. */
export interface IdleWork extends WorkBase {
  state: 'pending' | 'ready' | 'published' | 'failed';
  activeAttemptId: null;
}

/** An owned child or container attempt is running. */
export interface RunningWork extends WorkBase {
  state: 'running';
  activeAttemptId: Id;
}

/** An external client holds an expiring, fenced claim. Expiry is an interruption, not proof the client stopped. */
export interface LeasedWork extends WorkBase {
  state: 'leased';
  activeAttemptId: Id;
  claim: { leaseExpiresAt: Timestamp; fencingGeneration: Count };
}

/** Blocked by a dependency or disabled by policy: a decision with a reason, not a fake successful attempt. */
export interface HeldWork extends WorkBase {
  state: 'blocked' | 'disabled-by-policy';
  activeAttemptId: null;
  reasonCode: CatalogKey;
}

/** Satisfied by explicit reuse: it points at the original publication and never counts as executed now. */
export interface ReusedWork extends WorkBase {
  state: 'satisfied-by-reuse';
  activeAttemptId: null;
  reuse: { publication: WorkRef; derivationArtifact: ArtifactId };
}

/**
 * sentinel-work/draft-1 — one logical work unit at one immutable revision.
 * @discriminator state
 */
export type WorkEnvelope = IdleWork | RunningWork | LeasedWork | HeldWork | ReusedWork;
