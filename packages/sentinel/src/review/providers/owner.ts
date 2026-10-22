// Owner command helpers for models (PR 21/22). The canonical CLI owns dispatch, admission and receipts
// (`src/service/local.ts`): it decides `probeIntent` / `reconcileIntent` with the three verdicts and `--confirm`, then
// calls these helpers with the admitted admission record. The helpers spend nothing themselves; they check that the
// admission is exactly for their intent, and return bounded facts with no credential or provider text. A refusal is a
// ProviderError with its catalog code.
import type { ActionIntent, AdmissionEnvelope, ModelCapability } from '../../contracts/index.js';
import { canonicalDigest } from '../../policy/digest.js';
import { intentDigest, type ReceiptBook } from '../../policy/receipts.js';
import { isEffectivePolicy, type EffectivePolicy } from '../../policy/settings.js';
import type { BudgetLedger, Reservation } from './budget.js';
import { resolveCredential, type CredentialSource } from './credentials.js';
import { fromNanos, toNanos } from './decimal.js';
import { fail } from './errors.js';
import { probeConfigured } from './kinds.js';

const located = (policy: EffectivePolicy, providerId: string, modelId: string) => {
  if (!isEffectivePolicy(policy)) fail('sentinel.provider.notTrusted', 'only effectivePolicy’s own result');
  const p = policy.settings.providers.findIndex(x => x.id === providerId);
  const provider = policy.settings.providers[p];
  const m = provider?.models?.findIndex(x => x.id === modelId) ?? -1;
  if (!provider || m < 0) fail('sentinel.provider.notTrusted', 'the adopted settings define no such provider or model');
  return { provider: provider!, model: provider!.models![m]!, p, m };
};

const admitted = (admission: AdmissionEnvelope, intent: ActionIntent, stateDigest: string, needReceipt: boolean) => {
  if (admission.outcome !== 'admitted') fail('sentinel.provider.notAdmitted', admission.outcome === 'awaiting-confirmation' ? 'waiting for the owner' : 'denied');
  if (admission.intentDigest !== intentDigest(intent) || admission.action !== intent.action) fail('sentinel.provider.notAdmitted', 'the admission is for another intent');
  if (needReceipt && admission.receipt === null) fail('sentinel.provider.receiptRequired', 'the owner’s confirmation');
  void stateDigest;
};

/** The probe the owner confirms: one network listing of a configured provider; bound to its current settings. */
export function probeIntent(policy: EffectivePolicy, providerId: string, modelId: string): { intent: ActionIntent; stateDigest: string } {
  const { provider, model } = located(policy, providerId, modelId);
  const intent: ActionIntent = { action: 'tool.acquire', input: canonicalDigest({ probe: 'sentinel-model-capability/draft-1', providerId, modelId, model: model.model, origin: provider.endpoint }),
    effects: ['network'], budget: { maxTokens: null, maxCost: null, currency: null }, scope: { profile: null, provider: providerId, targets: [] } };
  const { models: _models, ...settings } = provider;
  void _models;
  return { intent, stateDigest: canonicalDigest({ provider: settings, model }) };
}

/**
 * Runs the admitted probe and returns the capability with the JSON pointer it belongs at in the settings. It never
 * writes settings: the owner re-adopts them with the record.
 */
export async function probeModel(admission: AdmissionEnvelope, policy: EffectivePolicy, providerId: string, modelId: string,
  options: { credentials: CredentialSource; now: Date; timeoutMs?: number; maxResponseBytes?: number; signal?: AbortSignal }): Promise<{ capability: ModelCapability; settingsPatch: { path: string; value: ModelCapability } }> {
  const { intent, stateDigest } = probeIntent(policy, providerId, modelId);
  admitted(admission, intent, stateDigest, true);
  const { provider, p, m } = located(policy, providerId, modelId);
  const credential = await resolveCredential(options.credentials, provider.credential);
  const capability = await probeConfigured(policy, providerId, modelId, { credential, now: options.now, timeoutMs: Math.min(options.timeoutMs ?? 10_000, 60_000),
    maxResponseBytes: Math.min(options.maxResponseBytes ?? 1024 * 1024, 4 * 1024 * 1024), ...(options.signal ? { signal: options.signal } : {}) });
  return { capability, settingsPatch: { path: `/providers/${p}/models/${m}/capability`, value: capability } };
}

export interface ReconcileUsage { readonly inputTokens: number; readonly outputTokens: number; readonly cost: string }

/** The reconciliation the owner confirms: settle one uncertain reservation at stated usage, bound to its current state. */
export function reconcileIntent(ledger: BudgetLedger, reservationId: string, usage: ReconcileUsage): { intent: ActionIntent; stateDigest: string } {
  const r = ledger.reservation(reservationId);
  if (r.state !== 'uncertain') fail('sentinel.provider.reservationState', `${r.state} is not uncertain`);
  const env = ledger.listEnvelopes({ limit: 200 }).find(e => e.id === r.envelopeId);
  if (!env) return fail('sentinel.provider.ledgerInvalid', 'the reservation’s envelope is not listed');
  if (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0 || toNanos(usage.cost) === null) {
    fail('sentinel.provider.ledgerInvalid', 'usage is whole token counts and a decimal cost');
  }
  const intent: ActionIntent = { action: 'paid.admit', input: canonicalDigest({ reconcile: reservationId, usage }), effects: ['paid-inference'],
    budget: { maxTokens: usage.inputTokens + usage.outputTokens, maxCost: usage.cost, currency: env.currency }, scope: { profile: null, provider: env.providerId, targets: [reservationId] } };
  return { intent, stateDigest: canonicalDigest(snapshotOf(r)) };
}

const snapshotOf = (r: Reservation) => ({ ...r, costNanos: String(r.costNanos), usedCostNanos: r.usedCostNanos === null ? null : String(r.usedCostNanos) });

/**
 * Settles the uncertain reservation under the admitted reconciliation. Lowering charged spend always needs the owner's
 * confirmation: when admission spent a receipt, that one counts; when the grants asked for none, the owner's receipt
 * for exactly this intent is spent here, once, as the broker does for priced use.
 */
export function reconcileReservation(ledger: BudgetLedger, admission: AdmissionEnvelope, reservationId: string, usage: ReconcileUsage, now: Date,
  receipt?: { readonly book: ReceiptBook; readonly id: string }): Reservation {
  const { intent, stateDigest } = reconcileIntent(ledger, reservationId, usage);
  admitted(admission, intent, stateDigest, false);
  let authority = admission.receipt;
  if (authority === null && receipt) authority = receipt.book.consume(receipt.id, { intent, stateDigest, policyRevision: admission.policyRevision }, now).digest;
  if (authority === null) fail('sentinel.provider.receiptRequired', 'the owner\u2019s confirmation');
  return ledger.reconcile(reservationId, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costNanos: toNanos(usage.cost)! }, authority!,
    now.toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z'));
}

export const INSPECT_LIMITS = Object.freeze({ maxEnvelopes: 50, maxReservations: 100 });

/** A read: bounded envelopes with totals and their open reservations; no receipt, no provider text. */
export function inspectEnvelopes(ledger: BudgetLedger, options: { runId?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(1, options.limit ?? 20), INSPECT_LIMITS.maxEnvelopes);
  return ledger.listEnvelopes({ ...(options.runId !== undefined ? { runId: options.runId } : {}), limit }).map(e => ({
    id: e.id, runId: e.runId, providerId: e.providerId, currency: e.currency, createdAt: e.createdAt, confirmedByOwner: e.receiptDigest !== null,
    maxTokens: e.totals.maxTokens, maxCost: fromNanos(e.totals.maxCostNanos), chargedTokens: e.totals.chargedTokens, chargedCost: fromNanos(e.totals.chargedCostNanos),
    overdrawn: e.totals.overdrawn, byState: e.totals.byState,
    open: ledger.openReservations(e.id, INSPECT_LIMITS.maxReservations).map(r => ({ id: r.id, operationId: r.operationId, state: r.state, tokens: r.tokens, cost: fromNanos(r.costNanos) })),
  }));
}
