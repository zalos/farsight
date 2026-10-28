// Current owner-adopted model selection enters only the two fixed coordinator operations. No vendor discovery.
import { join } from 'node:path';
import type { SentinelStore } from '../store/index.js';
import type { EffectivePolicy } from '../policy/settings.js';
import type { Workspace } from './local.js';
import { admit } from '../policy/admission.js';
import { issueReceipt } from '../policy/owner-receipts.js';
import { envelopeIntent } from '../review/providers/broker.js';
import { adoptedPolicy, OWNER, receiptBook } from './local.js';
import { createAdapterRegistry, type AdapterRegistry, type AdapterDefinition } from '../execution/registry.js';
import type { ExecutionProfileRecord } from '../execution/profile.js';
import { BudgetLedger } from '../review/providers/budget.js';
import { ModelBroker } from '../review/providers/broker.js';
import { keychainSource } from '../review/providers/credentials.js';
import { REVIEW_ADAPTERS, type ReviewRuntime } from '../review/dispatch.js';
export { REVIEW_ADAPTERS } from '../review/dispatch.js';
import { ExecutionError } from '../execution/errors.js';
export const hasConfiguredReviews = (p: EffectivePolicy) =>
  Boolean(
    p.settings.reviewModels && (p.settings.reviewModels.stages.length || p.settings.reviewModels.segments.length),
  );
export const reviewRegistry = (base: AdapterRegistry) =>
  createAdapterRegistry([...base.ids.map((id) => base.get(id) as AdapterDefinition), ...REVIEW_ADAPTERS]);
export function reviewProfile(record: ExecutionProfileRecord, registry: AdapterRegistry): ExecutionProfileRecord {
  return {
    ...record,
    adapters: [
      ...record.adapters,
      ...REVIEW_ADAPTERS.filter((a) => !record.adapters.some((r) => r.adapterId === a.id)).map((a) => ({
        adapterId: a.id,
        digest: registry.get(a.id).digest,
      })),
    ].sort((a, b) => (a.adapterId < b.adapterId ? -1 : 1)),
  };
}
// The stage-pack binding of a review spec lives with the packs; it is re-exported here for existing callers.
export { reviewInstructionsFor, type ReviewStagePacks } from '../review/packs.js';
/** Actual owner process only. Busy stores are refused by the caller's existing withStore, never seized. */
export async function reviewRuntime(
  store: SentinelStore,
  ws: Workspace,
  confirmModels = false,
): Promise<ReviewRuntime & { close(): void }> {
  store.assertHeld();
  if (ws.storePath !== store.storePath)
    throw new ExecutionError('sentinel.execution.planInvalid', { reason: 'model workspace names another held store' });
  const ledger = await BudgetLedger.open(join(store.storePath, 'review-budget.sqlite'));
  return {
    trustDir: ws.trustDir,
    ledger,
    broker: new ModelBroker({ ledger, credentials: keychainSource(), epoch: store.epoch }),
    requestedBy: OWNER,
    ...(confirmModels
      ? {
          receiptFor: (request: import('../review/providers/broker.js').OpenEnvelopeRequest) => {
            const intent = envelopeIntent(request.binding, request.runId, request.budget),
              now = new Date(),
              preflight = admit({
                intent,
                policy: request.policy,
                requestedBy: OWNER,
                stateDigest: request.stateDigest,
                now,
                capability: () => ({ available: true, detail: 'exact configured model capability' }),
                credential: () => ({ basis: 'unknown', detail: 'not read yet' }),
              });
            if (!preflight.record.verdicts.policy.allowed) return undefined;
            const book = receiptBook(ws),
              receipt = issueReceipt(
                book,
                OWNER,
                { intent, stateDigest: request.stateDigest, policyRevision: request.policy.revision },
                { now, ttlMs: 600000 },
              );
            return { book, id: receipt.id };
          },
        }
      : {}),
    currentPolicy: () => {
      store.assertHeld();
      const current = adoptedPolicy(ws);
      if ('refusal' in current)
        throw new ExecutionError('sentinel.execution.planInvalid', { reason: 'model policy is not currently adopted' });
      return current.policy;
    },
    close() {
      ledger.close();
    },
  };
}

export type ReviewIdentityView =
  | Readonly<{ status: 'unavailable' | 'withheld'; reviews: readonly [] }>
  | Readonly<{
      status: 'available';
      reviews: readonly Readonly<{
        stage: 'review-guided' | 'review-general';
        segmentId: string;
        requestedSelection: import('../contracts/instructions.js').ReviewProviderSelection;
        reportedIdentity: import('../contracts/observation.js').ModelIdentity | null;
        instructions: import('../review/instructions.js').InstructionIdentity;
      }>[];
    }>;
/** Exact accepted run identities only; no private prompt text, arbitrary object handles or paid action. */
export async function reviewIdentityIn(store: SentinelStore, runId: string): Promise<ReviewIdentityView> {
  store.assertHeld();
  const run = store.ledger.getRun(runId);
  if (!run) return { status: 'unavailable', reviews: [] };
  const admitted = await (await import('../execution/plans.js')).loadPlan(store, runId, run.planRevision),
    units = admitted.plan.units.filter((u) => u.review && store.ledger.getPublication(u));
  if (!units.length) return { status: 'unavailable', reviews: [] };
  if (units.length > 32) throw new ExecutionError('sentinel.execution.planInvalid', {});
  const { reviewSecretsKnown } = await import('../review/dispatch.js');
  if (await reviewSecretsKnown(store, runId, admitted)) return { status: 'withheld', reviews: [] };
  const { readPublishedInstructions } = await import('../review/instructions.js'),
    reviews = [];
  const deadlineAt = Date.now() + 20000,
    signal = AbortSignal.timeout(20000);
  for (const unit of units) {
    const trace = await readPublishedInstructions(store, unit, { deadlineAt, signal }),
      m = trace.instructions,
      content = (c: typeof m.prompt) => ({ revision: c.revision, digest: c.digest, bytes: c.bytes });
    reviews.push({
      stage: unit.stage as 'review-guided' | 'review-general',
      segmentId: unit.review!.segmentId,
      requestedSelection: { ...unit.review!.selection },
      reportedIdentity: trace.record.model,
      instructions: {
        assembly: m.assembly,
        digest: m.digest,
        prompt: content(m.prompt),
        skills: m.skills.map((s) => ({ ...content(s), resources: s.resources.map(content) })),
        assembled: { digest: m.assembled.digest, bytes: m.assembled.bytes },
      },
    });
  }
  store.assertHeld();
  if (signal.aborted || Date.now() >= deadlineAt) throw new ExecutionError('sentinel.execution.deadlineExceeded', {});
  if (await reviewSecretsKnown(store, runId, admitted)) return { status: 'withheld', reviews: [] };
  return { status: 'available', reviews };
}
