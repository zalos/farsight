import type { CatalogKey, Count, DecimalAmount, Digest, Id, Ordinal, Timestamp } from './common.js';

export type ActiveRunState = 'planned' | 'running' | 'pausing' | 'paused' | 'canceling' | 'canceled';
export type RunState = ActiveRunState | 'completed';

/** Completion's own outcome. Findings are independent of it: a complete run can hold critical findings. */
export type RunOutcome = 'complete-coverage' | 'partial-coverage' | 'execution-failure';

/** The recorded CI policy result. Its exit code is fixed by the result (see `policyExitCode`). */
export type PolicyResult =
  | 'satisfied'
  | 'finding-policy-failed'
  | 'required-coverage-incomplete'
  | 'configuration-failure'
  | 'awaiting-confirmation';

/**
 * @asType integer
 * @minimum 0
 * @maximum 4
 */
export type PolicyExitCode = number;

export interface RunBudgets {
  /** null: no model work is admitted under this run. */
  maxTokens: Count | null;
  /** null: no enforceable monetary budget, so a priced hosted profile is unavailable. */
  maxCost: DecimalAmount | null;
  /**
   * ISO 4217 currency of `maxCost`.
   * @pattern ^[A-Z]{3}$
   */
  currency?: string;
  /**
   * @asType integer
   * @minimum 1
   * @maximum 86400000
   */
  deadlineMs: number;
}

interface RunBase {
  schema: 'sentinel-run/draft-1';
  id: Id;
  parentId: Id | null;
  baselineId: Id | null;
  snapshotId: Id;
  planRevision: Ordinal;
  coordinatorEpoch: Id;
  ruleLockDigest: Digest;
  toolLockDigest: Digest;
  policyRevisionDigest: Digest;
  /** Present only when model review is part of the plan. */
  promptPolicyDigest?: Digest;
  requestedScope: {
    /**
     * @minItems 1
     * @maxItems 64
     */
    sourceIds: Id[];
    /** @maxLength 64 */
    profile: string;
  };
  budgets: RunBudgets;
  createdAt: Timestamp;
  policy?: {
    result: PolicyResult;
    exitCode: PolicyExitCode;
    /** @maxItems 32 */
    reasonCodes: CatalogKey[];
  };
}

export interface ActiveRun extends RunBase {
  // Written out, not the ActiveRunState alias: the schema generator's discriminator needs the literals here.
  state: 'planned' | 'running' | 'pausing' | 'paused' | 'canceling' | 'canceled';
}

export interface CompletedRun extends RunBase {
  state: 'completed';
  outcome: RunOutcome;
  completedAt: Timestamp;
}

/**
 * sentinel-run/draft-1 — requested analysis over one snapshot with exact locks, policy and budgets.
 * @discriminator state
 */
export type RunEnvelope = ActiveRun | CompletedRun;
