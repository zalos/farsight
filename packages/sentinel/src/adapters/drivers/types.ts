// Private scanner-kernel composition types. canonical.ts adapts these pure preparation/normalization functions
// to execution/check-drivers.ts, the coordinator's only trusted driver contract. Kernels never start a process,
// acquire assets, or read a checkout. Only the coordinator seals inputs, executes workers and accepts publications.
import type { ArtifactId, Digest, Id, ScopeId } from '../../contracts/common.js';
import type { PlanCheck, PlanInput, PlanPinnedRule, PlanWork } from '../../contracts/plan.js';
import type { PackFile } from '../../contracts/rules.js';
import type { ResultMessage } from '../../contracts/protocol.js';
import type { WorkerOutcome } from '../../execution/supervisor.js';
import type { ResolvedRule } from '../../rules/resolve.js';

/** One rule a driver runs exactly: the shipped definition it was built and tested against. */
export interface SupportedRule {
  readonly familyId: string;
  readonly revision: number;
  readonly definitionDigest: Digest;
}

/** The pinned rules of a unit, resolved by the coordinator from the admitted lock and packs (resolveLockedRules). */
export interface DriverRules {
  readonly pins: readonly PlanPinnedRule[];
  readonly resolved: readonly ResolvedRule[];
  /** The validated packs' file lists (path, digest, size) for the resolved rules. */
  readonly files: readonly PackFile[];
  /** A pack file's bytes by its digest, verified by the coordinator; undefined when not held. */
  bytesOf(digest: Digest): Uint8Array | undefined;
}

/** An admitted database or checks bundle: where its verified copy is, and its provenance record. */
export interface DriverDatabase {
  readonly pin: { readonly databaseId: Id; readonly snapshotDigest: Digest };
  readonly path: string;
  /** The owner's explicitly supplied acquisition provenance; a neighboring file never supplies trust. */
  readonly record: unknown;
}

export interface DriverPrepare {
  readonly run: { readonly id: Id; readonly snapshotId: Id };
  readonly unit: Readonly<PlanWork>;
  readonly checks: readonly PlanCheck[];
  /** The captured files this unit reads, as the plan pinned them, with the scopes each covers and its sealed copy. */
  readonly inputs: readonly { readonly input: PlanInput; readonly scopes: readonly ScopeId[]; readonly path: string }[];
  readonly rules: DriverRules;
  readonly tools: readonly { readonly adapterId: Id; readonly artifactDigest: Digest }[];
  readonly databases: readonly DriverDatabase[];
  /** A private folder the coordinator creates and removes. */
  readonly scratch: string;
  /** The current time for freshness decisions, from the coordinator. */
  readonly now: Date;
}

export type PreparedRole = 'worker' | 'job' | 'rules' | 'database' | 'bundle';

export interface DriverPrepared {
  /** Extra sealed inputs, journaled with the invocation record before the worker starts. */
  readonly artifacts: readonly { readonly id: ArtifactId; readonly path: string; readonly role: PreparedRole }[];
  /** Canonical JSON the driver needs again at normalize; recorded with the invocation. Null when nothing is run. */
  readonly context: unknown;
  /**
   * Nothing should run (unsupported checks, nothing applicable, or a required asset absent). The canonical bridge
   * refuses preparation: its current coordinator seam cannot publish a worker-free check, so no check gains coverage.
   * Low-level callers may inspect these explicit not-run facts without starting a worker.
   */
  readonly skipRun?: { readonly result: Omit<ResultMessage, keyof ResultBinding> };
}

/** The worker binding fields omitted from a kernel's worker-free not-run facts. */
export type ResultBinding = Pick<ResultMessage, 'protocol' | 'type' | 'attemptId' | 'work' | 'coordinatorEpoch' | 'seq' | 'inputFingerprint'>;

export interface DriverNormalize {
  readonly context: unknown;
  readonly outcome: Readonly<WorkerOutcome>;
  readonly unit: Readonly<PlanWork>;
  readonly checks: readonly PlanCheck[];
  readonly now: Date;
  /** A verified output's bytes by artifact id. */
  output(id: ArtifactId): Uint8Array;
  /** The attempt's sealed copy of an input by artifact id, never a live path. */
  sealed(id: ArtifactId): Uint8Array | undefined;
}

/** A normalized record to publish with the result (findings, the normalized report). */
export interface DriverRecord { readonly value: unknown; readonly schema: string }

export interface DriverNormalized {
  /** The worker's result with its binding unchanged and its coverage facts replaced by the driver's. */
  readonly result: ResultMessage;
  readonly records: readonly DriverRecord[];
}

export interface CheckDriver {
  readonly adapterId: Id;
  /** The only rules this driver runs; any other pinned rule is never covered. */
  readonly supportedRules: readonly SupportedRule[];
  prepare(ctx: DriverPrepare): Promise<DriverPrepared>;
  normalize(ctx: DriverNormalize): DriverNormalized;
}
