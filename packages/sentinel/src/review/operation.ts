// The trusted in-process model operation (PR 22). The coordinator runs one agentic review unit through it: a fixed,
// package-owned driver bound to the review adapter and its digest, never code from a worker, a repository or IPC. It
// runs the unit's session through the PR 21 broker under the run's admitted envelope, checkpoints in the model ledger
// under the coordinator's epoch, and returns records to publish plus the attempt's usage at its actual certainty.
// It returns no coverage, by construction. Recovery (`recoverModelWork`) fences stale epochs in the model ledger:
// their unsent reservations are released, their sent ones stay charged as uncertain, and their sessions resume under
// the new epoch from the last checkpoint without re-sending a settled call.
import type { AttemptUsage, Digest, ObservationEnvelope, ScopedReason, WorkEnvelope } from '../contracts/index.js';
import type { ModelBroker, ModelEnvelope } from './providers/broker.js';
import type { BudgetLedger } from './providers/budget.js';
import { fromNanos } from './providers/decimal.js';
import { type ProviderBinding } from './providers/profile.js';
import { providerCaller } from './caller.js';
import { LedgerCheckpointStore } from './checkpoints.js';
import { reviewFail } from './errors.js';
import { GENERAL_ADAPTER_DIGEST, GENERAL_ADAPTER_ID } from './general.js';
import { GUIDED_ADAPTER_DIGEST, GUIDED_ADAPTER_ID } from './guided.js';
import { canonicalDigest } from '../policy/digest.js';
import { runSession, specDigest, type ReviewRecord, type SessionSpec } from './session.js';
import { isReviewWork } from './stage.js';
import type { InstructionArtifact } from './instructions.js';
import type { DisclosureFilter } from './evidence.js';

export interface ModelOperationContext {
  readonly work: WorkEnvelope;
  readonly spec: SessionSpec;
  readonly attemptId: string;
  /** The coordinator's current epoch; the ledger refuses a fenced one. */
  readonly epoch: string;
  readonly read: (content: string) => Promise<Uint8Array>;
  readonly withhold?: DisclosureFilter;
  readonly signal?: AbortSignal;
}

export interface ModelOperationOutcome {
  /** Canonical records for the attempt's publication: the review record, then its observations. */
  readonly records: readonly { readonly value: ReviewRecord | ObservationEnvelope; readonly schema: string }[];
  readonly usage: AttemptUsage;
  readonly privateArtifacts?: readonly InstructionArtifact[];
  readonly frontiers: readonly ScopedReason[];
  /** Always none: agentic review never covers a check. */
  readonly coverage: readonly [];
}

export interface ModelOperationDeps {
  readonly broker: ModelBroker;
  readonly ledger: BudgetLedger;
  readonly envelope: ModelEnvelope;
  /** The binding re-made under the policy in force, for every call. */
  readonly binding: () => ProviderBinding;
  readonly now?: () => Date;
}

const DIGESTS: Readonly<Record<string, Digest>> = Object.freeze({
  [GUIDED_ADAPTER_ID]: GUIDED_ADAPTER_DIGEST,
  [GENERAL_ADAPTER_ID]: GENERAL_ADAPTER_DIGEST,
});

/** The driver for agentic review units. One per run and provider envelope. */
export function createModelReviewOperation(deps: ModelOperationDeps) {
  return Object.freeze({
    adapterIds: Object.freeze(Object.keys(DIGESTS)),
    async run(ctx: ModelOperationContext): Promise<ModelOperationOutcome> {
      if (!isReviewWork(ctx.work)) reviewFail('sentinel.review.invalidInput', 'not agentic review work');
      if (
        DIGESTS[ctx.spec.adapterId] !== ctx.spec.adapterDigest ||
        ctx.work.stage.implementationDigest !== ctx.spec.adapterDigest
      ) {
        reviewFail('sentinel.review.integrity', 'the unit names another review implementation');
      }
      if (ctx.spec.runId !== ctx.work.runId || ctx.spec.runId !== deps.envelope.runId)
        reviewFail('sentinel.review.integrity', 'the unit, its spec and the envelope name different runs');
      const sealed = specDigest(ctx.spec);
      if (
        ctx.work.inputFingerprint !== sealed ||
        ctx.work.influenceManifest !==
          canonicalDigest({ spec: sealed, kind: ctx.spec.kind, sessionId: ctx.spec.sessionId })
      )
        reviewFail('sentinel.review.integrity', 'the review spec differs from its planned work binding');
      if (ctx.spec.attemptId !== ctx.attemptId)
        reviewFail('sentinel.review.integrity', 'the spec is for another attempt');
      const checkpoints = new LedgerCheckpointStore(deps.ledger, ctx.epoch, deps.now);
      const caller = providerCaller(deps.broker, deps.envelope, deps.binding);
      const { record, observations, privateArtifacts } = await runSession(ctx.spec, {
        caller,
        checkpoints,
        read: ctx.read,
        ...(ctx.withhold ? { withhold: ctx.withhold } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return Object.freeze({
        records: [
          { value: record, schema: 'sentinel-review-record/draft-1' },
          ...observations.map((o) => ({ value: o, schema: 'sentinel-observation/draft-1' })),
        ],
        ...(privateArtifacts ? { privateArtifacts } : {}),
        usage: usageOf(deps.ledger, deps.envelope.id, record, deps.binding().settingsBudget.currency),
        frontiers: record.frontiers,
        coverage: [] as const,
      });
    },
  });
}

/** The attempt's usage, from the ledger: confirmed only when every operation settled. */
export function usageOf(
  ledger: BudgetLedger,
  envelopeId: string,
  record: ReviewRecord,
  currency?: string | null,
): AttemptUsage {
  let inputTokens = 0,
    outputTokens = 0,
    cost = 0n,
    unknown = false;
  for (const o of record.operations) {
    const r = ledger.reservationOf(envelopeId, o.operationId);
    if (!r || r.state !== 'settled') {
      if (r && r.state === 'released') continue;
      unknown = true;
      continue;
    }
    inputTokens += r.usedInputTokens ?? 0;
    outputTokens += r.usedOutputTokens ?? 0;
    cost += r.usedCostNanos ?? 0n;
  }
  return unknown
    ? { certainty: 'unknown' }
    : {
        certainty: 'confirmed',
        inputTokens,
        outputTokens,
        ...(currency ? { monetaryCost: fromNanos(cost), currency } : {}),
      };
}

/**
 * Recovery under the coordinator's exclusive ownership: fence the stale epochs in the model ledger. Their held
 * reservations are released, their dispatched ones become uncertain (still charged), and from now on they can neither
 * reserve, dispatch nor checkpoint. Sessions resume under the new epoch.
 */
export const recoverModelWork = (ledger: BudgetLedger, staleEpochs: readonly string[], at: Date) =>
  ledger.recover(staleEpochs, at.toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z'));
