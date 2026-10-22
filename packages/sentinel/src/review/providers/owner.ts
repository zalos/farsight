// Owner command helpers for models (PR 21/22). The canonical CLI owns dispatch and the preview: it may call `admit()`
// on `probeIntent` / `reconcileIntent` without a receipt to report "awaiting confirmation" (exit 4). With `--confirm`
// it issues the owner's receipt and passes only its reference here. Each helper then decides the intent itself through
// the shared three-verdict `admit()`, and its only authority is the consumed receipt that admission (or, where the
// grants asked for none, this helper) spends exactly once: an unforgeable object, never a JSON admission record or a
// boolean a caller could build. Results are bounded facts with no credential or provider text; a refusal is a
// ProviderError with its catalog code.
import type { ActionIntent, DecisionChannel, ModelCapability, Principal } from '../../contracts/index.js';
import { admit, type CredentialAnswer } from '../../policy/admission.js';
import { canonicalDigest } from '../../policy/digest.js';
import { intentDigest, isConsumedReceipt, receiptAuthority, type ConsumedReceipt, type ReceiptBook } from '../../policy/receipts.js';
import { isEffectivePolicy, type EffectivePolicy } from '../../policy/settings.js';
import type { BudgetLedger, Reservation } from './budget.js';
import { resolveCredential, type CredentialSource, type Secret } from './credentials.js';
import { fromNanos, toNanos } from './decimal.js';
import { fail } from './errors.js';
import { probeConfigured } from './kinds.js';

export interface OwnerAuthority {
  /** Set by the channel the request arrived on (the owner CLI), never by a request body. */
  readonly requestedBy: { readonly principal: Principal; readonly channel: DecisionChannel };
  /** The owner's receipt for exactly this intent, issued by the CLI's confirm flow; spent here, once. */
  readonly receipt?: { readonly book: ReceiptBook; readonly id: string };
}

/**
 * Admits `intent` and returns the consumed receipt that authorizes it. The policy is decided first with nothing read;
 * then the full admission, which spends the receipt when the grants require confirmation; when they do not, the
 * receipt is spent here instead. Without a receipt nothing is authorized: these actions always need the owner.
 */
function authorize(policy: EffectivePolicy, intent: ActionIntent, stateDigest: string, who: OwnerAuthority, credential: () => CredentialAnswer, now: Date): ConsumedReceipt {
  const base = { intent, requestedBy: who.requestedBy, policy, capability: () => ({ available: true, detail: 'owner helper' }), credential, stateDigest, now };
  const preview = admit(base);
  if (!preview.record.verdicts.policy.allowed) fail('sentinel.provider.notAdmitted', preview.record.verdicts.policy.reasonCode);
  if (!who.receipt) return fail('sentinel.provider.receiptRequired', 'the owner\u2019s confirmation');
  const result = admit({ ...base, receipt: who.receipt });
  if (result.record.outcome !== 'admitted') fail('sentinel.provider.notAdmitted', result.record.outcome);
  const spent = result.receipt ?? who.receipt.book.consume(who.receipt.id, { intent, stateDigest, policyRevision: policy.revision }, now);
  if (!isConsumedReceipt(spent) || receiptAuthority(spent)?.intentDigest !== intentDigest(intent)) fail('sentinel.provider.notAdmitted', 'the receipt is for another intent');
  return spent;
}

const located = (policy: EffectivePolicy, providerId: string, modelId: string) => {
  if (!isEffectivePolicy(policy)) fail('sentinel.provider.notTrusted', 'only effectivePolicy’s own result');
  const p = policy.settings.providers.findIndex(x => x.id === providerId);
  const provider = policy.settings.providers[p];
  const m = provider?.models?.findIndex(x => x.id === modelId) ?? -1;
  if (!provider || m < 0) fail('sentinel.provider.notTrusted', 'the adopted settings define no such provider or model');
  return { provider: provider!, model: provider!.models![m]!, p, m };
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
 * Decides and runs the probe: one listing of a configured provider. Returns the capability with the JSON pointer it
 * belongs at in the settings; it never writes settings, the owner re-adopts them with the record.
 */
export async function probeModel(policy: EffectivePolicy, providerId: string, modelId: string, who: OwnerAuthority,
  options: { credentials: CredentialSource; now: Date; timeoutMs?: number; maxResponseBytes?: number; signal?: AbortSignal }): Promise<{ capability: ModelCapability; settingsPatch: { path: string; value: ModelCapability } }> {
  const { intent, stateDigest } = probeIntent(policy, providerId, modelId);
  const { provider, p, m } = located(policy, providerId, modelId);
  let credential: Secret | null = null;
  let answer: CredentialAnswer = provider.disclosure === 'local-only' && provider.credential === null
    ? { basis: 'local-only', detail: 'a loopback provider needs no remote credential' } : { basis: 'unknown', detail: 'not read yet' };
  if (provider.credential !== null) {
    // Read only once the policy allows (authorize previews it first with nothing read).
    const preview = admit({ intent, requestedBy: who.requestedBy, policy, capability: () => ({ available: true, detail: 'owner helper' }), credential: () => answer, stateDigest, now: options.now });
    if (!preview.record.verdicts.policy.allowed) fail('sentinel.provider.notAdmitted', preview.record.verdicts.policy.reasonCode);
    try { credential = await resolveCredential(options.credentials, provider.credential); answer = { basis: 'keychain-scope', allowed: true, detail: 'read for the approved reference' }; }
    catch { answer = { basis: 'keychain-scope', allowed: false, detail: 'the approved reference could not be read' }; }
  }
  authorize(policy, intent, stateDigest, who, () => answer, options.now);
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

/** Decides the reconciliation and settles the uncertain reservation under the owner's spent receipt. */
export function reconcileReservation(ledger: BudgetLedger, policy: EffectivePolicy, reservationId: string, usage: ReconcileUsage, who: OwnerAuthority, now: Date): Reservation {
  if (!isEffectivePolicy(policy)) fail('sentinel.provider.notTrusted', 'only effectivePolicy\u2019s own result');
  const { intent, stateDigest } = reconcileIntent(ledger, reservationId, usage);
  const spent = authorize(policy, intent, stateDigest, who, () => ({ basis: 'local-only', detail: 'a ledger record; no provider is contacted' }), now);
  return ledger.reconcile(reservationId, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costNanos: toNanos(usage.cost)! }, spent.digest,
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
