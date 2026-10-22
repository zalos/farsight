// The model broker (PR 21): the only Sentinel code that resolves a provider credential or contacts a model endpoint.
//
// openEnvelope — admits one budget for one run and one provider binding through the shared three-verdict gate
//   (`policy/admission`): the policy verdict is the reused grant matcher; capability (a capability record for this
//   exact origin and model) and credential authority (no credential needed for a local-only provider, or a keychain
//   value actually read for the approved reference) are this module's own answers. The intent's input is the
//   binding digest, so the owner's receipt confirms the exact origin, credential reference, disclosure, model, limits,
//   price and terms. A priced or hosted provider needs a spent owner receipt whatever the grants say; the policy is
//   evaluated before the keychain is read, and a denial contacts nothing.
// generate — one call under an envelope: the current binding must be the envelope's; the worst case (every request
//   byte as a token, the template allowance per message, the full output allowance, at the trusted rates) must fit
//   the context and is reserved durably before anything is sent; the reservation is marked dispatched before the
//   request leaves; the reply's usage settles it, or it stays uncertain. No retry, no fallback to another provider.
import { randomUUID } from 'node:crypto';
import type { ActionEffect, ActionIntent, Budget, DecisionChannel, Principal } from '../../contracts/index.js';
import { admit, type AdmissionResult } from '../../policy/admission.js';
import { canonicalDigest } from '../../policy/digest.js';
import { isConsumedReceipt, receiptAuthority, type ReceiptBook } from '../../policy/receipts.js';
import { isEffectivePolicy, type EffectivePolicy } from '../../policy/settings.js';
import type { BudgetLedger, Reservation } from './budget.js';
import { resolveCredential, type CredentialSource, type Secret } from './credentials.js';
import { costOf, toNanos, fromNanos } from './decimal.js';
import { ProviderError, fail } from './errors.js';
import { chatBody, chatPath, parseReply, type ChatMessage, type FinishReason, type ReplyIdentity } from './kinds.js';
import { isProviderBinding, type ProviderBinding } from './profile.js';
import { exchange } from './transport.js';

export interface BrokerDeps {
  readonly ledger: BudgetLedger;
  readonly credentials: CredentialSource;
  /** This coordinator epoch; recovery fences other epochs' reservations. */
  readonly epoch: string;
  readonly now?: () => Date;
}

export interface OpenEnvelopeRequest {
  readonly binding: ProviderBinding;
  readonly policy: EffectivePolicy;
  readonly runId: string;
  /** The whole run's model budget under this provider; each call reserves within it. */
  readonly budget: Budget;
  /** Set by the transport the request arrived on, never by a request body. */
  readonly requestedBy: { principal: Principal; channel: DecisionChannel };
  readonly stateDigest: string;
  readonly receipt?: { book: ReceiptBook; id: string };
}

/** An admitted budget. Only `openEnvelope` makes one; its credential is held privately, never on the object. */
export interface ModelEnvelope {
  readonly id: string;
  readonly runId: string;
  readonly bindingDigest: string;
  readonly admission: AdmissionResult['record'];
  readonly receiptDigest: string | null;
}

export interface GenerateRequest {
  /** Stable per logical call: asking again returns the same reservation and is never sent twice. */
  readonly operationId: string;
  readonly messages: readonly ChatMessage[];
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}

export interface ModelReply {
  readonly content: string;
  readonly finish: FinishReason;
  /** The output stopped at the allowance: the content is incomplete. */
  readonly truncated: boolean;
  readonly identity: ReplyIdentity;
  readonly usage: {
    readonly certainty: 'confirmed';
    readonly inputTokens: number;
    readonly outputTokens: number;
    /** DecimalAmount; `0` with basis `no-fee` is a local runtime's absent fee, not free compute. */
    readonly monetaryCost: string;
    readonly currency: string;
    readonly basis: 'rate-schedule' | 'no-fee';
  };
  readonly reservation: Reservation;
}

/** Thrown after a call settled or stayed uncertain; carries the reservation as recorded. */
export class ModelCallError extends ProviderError {
  readonly reservation: Reservation | null;
  constructor(cause: ProviderError, reservation: Reservation | null) {
    super(cause.code, '', cause.spend);
    this.message = cause.message;
    this.reservation = reservation;
  }
}

/**
 * The exact intent an envelope is admitted for, and an owner receipt confirms: `paid.admit` over the binding digest,
 * with disclosure and network effects for a hosted provider, the run's budget and the provider as scope.
 */
export function envelopeIntent(binding: ProviderBinding, runId: string, budget: Budget): ActionIntent {
  const effects: ActionEffect[] = ['paid-inference', ...(binding.disclosure === 'hosted' ? ['source-disclosure', 'network'] as const : [])];
  return { action: 'paid.admit', input: binding.digest, effects, budget: { ...budget }, scope: { profile: null, provider: binding.providerId, targets: [runId] } };
}

const envelopes = new WeakMap<object, { binding: ProviderBinding; credential: Secret | null; budget: Budget }>();
const stamp = (d: Date) => d.toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z');
const ROLES = new Set(['system', 'user', 'assistant']);

export class ModelBroker {
  readonly #deps: BrokerDeps;
  constructor(deps: BrokerDeps) { this.#deps = deps; }
  #now() { return (this.#deps.now ?? (() => new Date()))(); }

  async openEnvelope(req: OpenEnvelopeRequest): Promise<ModelEnvelope> {
    const { binding, policy } = req;
    if (!isProviderBinding(binding)) fail('sentinel.provider.notTrusted', 'only bindProvider’s own binding is accepted');
    if (!isEffectivePolicy(policy) || policy.revision !== binding.policyRevision) fail('sentinel.provider.bindingChanged', 'the policy changed since the binding was made');
    const b = req.budget;
    if (b.maxTokens === null || b.maxCost === null || b.currency === null || toNanos(b.maxCost) === null) fail('sentinel.provider.budgetExhausted', 'a model budget states its tokens, money and currency');
    const hosted = binding.disclosure === 'hosted';
    const priced = binding.pricing.kind === 'rates';
    const intent = envelopeIntent(binding, req.runId, b);
    const capability = () => ({ available: true, detail: `capability record for ${binding.model} at ${binding.origin}, probed ${binding.capability.probedAt}` });
    const decide = (credential: Parameters<typeof admit>[0]['credential'], receipt?: OpenEnvelopeRequest['receipt']) => admit({
      intent, requestedBy: req.requestedBy, policy, capability, credential, stateDigest: req.stateDigest, now: this.#now(), ...(receipt ? { receipt } : {}),
    });
    // The policy first, with no credential read: a denial reads nothing and contacts nothing.
    const preview = decide(() => ({ basis: 'unknown', detail: 'not read yet' }));
    if (!preview.record.verdicts.policy.allowed) fail('sentinel.provider.notAdmitted', preview.record.verdicts.policy.reasonCode);
    if ((hosted || priced) && !req.receipt) fail('sentinel.provider.receiptRequired', hosted ? 'hosted disclosure' : 'priced inference');
    let credential: Secret | null = null;
    let answer: ReturnType<Parameters<typeof admit>[0]['credential']>;
    if (binding.credential === null) {
      answer = hosted ? { basis: 'unknown', detail: 'a hosted provider with no credential reference' } : { basis: 'local-only', detail: 'a loopback provider needs no remote credential' };
    } else {
      try { credential = await resolveCredential(this.#deps.credentials, binding.credential); answer = { basis: 'keychain-scope', allowed: true, detail: 'read for the approved reference' }; }
      catch { answer = { basis: 'keychain-scope', allowed: false, detail: 'the approved reference could not be read' }; }
    }
    const result = decide(() => answer, req.receipt);
    if (result.record.outcome !== 'admitted') fail('sentinel.provider.notAdmitted', result.record.outcome === 'awaiting-confirmation' ? 'waiting for the owner' : 'denied');
    // Paid or disclosing use needs the owner's receipt even when the grants ask for no confirmation: spend it here
    // when admission did not, against exactly this intent, state and policy revision.
    let spent = result.receipt;
    if ((hosted || priced) && !spent && req.receipt) {
      spent = req.receipt.book.consume(req.receipt.id, { intent, stateDigest: req.stateDigest, policyRevision: policy.revision }, this.#now());
    }
    if ((hosted || priced) && !(spent && isConsumedReceipt(spent) && receiptAuthority(spent)?.intentDigest === result.record.intentDigest)) {
      fail('sentinel.provider.receiptRequired', hosted ? 'hosted disclosure' : 'priced inference');
    }
    const receiptDigest = spent?.digest ?? null;
    const admissionDigest = canonicalDigest(result.record);
    const id = `menv-${admissionDigest.slice(7, 39)}`;
    this.#deps.ledger.createEnvelope({ id, runId: req.runId, bindingDigest: binding.digest, admissionDigest, receiptDigest,
      maxTokens: b.maxTokens!, maxCostNanos: toNanos(b.maxCost)!, currency: b.currency!, createdAt: stamp(this.#now()) });
    const env: ModelEnvelope = Object.freeze({ id, runId: req.runId, bindingDigest: binding.digest, admission: result.record, receiptDigest });
    envelopes.set(env, { binding, credential, budget: { ...b } });
    return env;
  }

  /** The worst case one call could be charged, before it is sent. */
  worstCase(binding: ProviderBinding, body: Uint8Array, messages: number, maxOutputTokens: number): { inputTokens: number; tokens: number; costNanos: bigint } {
    const inputTokens = body.byteLength + messages * binding.limits.templateTokensPerMessage;
    const tokens = inputTokens + maxOutputTokens;
    const costNanos = binding.pricing.kind === 'rates'
      ? costOf(inputTokens, toNanos(binding.pricing.inputPerMillion)!) + costOf(maxOutputTokens, toNanos(binding.pricing.outputPerMillion)!) : 0n;
    return { inputTokens, tokens, costNanos };
  }

  async generate(env: ModelEnvelope, current: ProviderBinding, call: GenerateRequest): Promise<ModelReply> {
    const held = envelopes.get(env);
    if (!held) return fail('sentinel.provider.notAdmitted', 'only an envelope openEnvelope returned is accepted');
    const { binding, credential } = held;
    if (!isProviderBinding(current) || current.digest !== binding.digest) fail('sentinel.provider.bindingChanged', 'the provider’s binding is not the one approved');
    // The binding is re-made under the policy in force for every call: any policy change, a revoked grant included,
    // stops the envelope until the owner approves again.
    if (current.policyRevision !== binding.policyRevision) fail('sentinel.provider.bindingChanged', 'the policy changed since this budget was approved');
    const L = binding.limits;
    if (!Number.isSafeInteger(call.maxOutputTokens) || call.maxOutputTokens < 1 || call.maxOutputTokens > L.maxOutputTokens) fail('sentinel.provider.invalidProfile', 'maxOutputTokens is outside the profile');
    if (!Array.isArray(call.messages) || call.messages.length < 1 || call.messages.length > L.maxMessages
      || call.messages.some(m => !m || !ROLES.has(m.role) || typeof m.content !== 'string')) fail('sentinel.provider.invalidProfile', 'messages are a bounded list of role and text');
    const body = Buffer.from(JSON.stringify(chatBody(binding.kind, binding.model, call.messages, call.maxOutputTokens, L.contextTokens)), 'utf8');
    if (body.byteLength > L.maxRequestBytes) fail('sentinel.provider.requestTooLarge', `${body.byteLength} of ${L.maxRequestBytes} bytes`);
    const worst = this.worstCase(binding, body, call.messages.length, call.maxOutputTokens);
    if (worst.tokens > L.contextTokens) fail('sentinel.provider.contextExceeded', `${worst.tokens} of ${L.contextTokens} tokens`);

    const ledger = this.#deps.ledger;
    let res = ledger.reserve({ envelopeId: env.id, operationId: call.operationId, tokens: worst.tokens, costNanos: worst.costNanos, epoch: this.#deps.epoch, at: stamp(this.#now()) });
    // An operation is sent at most once: a repeat finds its reservation already past `held` and is refused.
    if (res.state !== 'held') fail('sentinel.provider.reservationState', `operation ${call.operationId} is already ${res.state}`);
    res = ledger.dispatch(res.id, stamp(this.#now()));

    let parsed: ReturnType<typeof parseReply>;
    try {
      const { json } = await exchange({ origin: binding.origin, method: 'POST', path: chatPath(binding.kind), body, credential,
        maxResponseBytes: L.maxResponseBytes, timeoutMs: L.timeoutMs, ...(call.signal ? { signal: call.signal } : {}) });
      parsed = parseReply(binding.kind, json);
    } catch (error) {
      const e = error instanceof ProviderError ? error : new ProviderError('sentinel.provider.malformedResponse', 'unexpected failure', 'possible');
      const after = e.spend === 'none' ? ledger.releaseUnsent(res.id, stamp(this.#now()), 'no-connection') : ledger.markUncertain(res.id, stamp(this.#now()), e.code);
      throw new ModelCallError(e, after);
    }

    const { inputTokens, outputTokens } = parsed.usage;
    let settled: Reservation;
    let costNanos = 0n;
    if (inputTokens === null || outputTokens === null) {
      settled = ledger.markUncertain(res.id, stamp(this.#now()), 'the reply reported no usage');
    } else {
      if (binding.pricing.kind === 'rates') {
        costNanos = costOf(inputTokens, toNanos(binding.pricing.inputPerMillion)!) + costOf(outputTokens, toNanos(binding.pricing.outputPerMillion)!);
      }
      settled = ledger.settle(res.id, { inputTokens, outputTokens, costNanos }, stamp(this.#now()));
    }
    if (parsed.returnedModel === null) throw new ModelCallError(new ProviderError('sentinel.provider.identityMalformed', 'no model name', 'possible'), settled);
    if (parsed.returnedModel !== binding.model) {
      throw new ModelCallError(new ProviderError('sentinel.provider.identityMismatch', `${binding.model} asked, ${parsed.returnedModel.slice(0, 64)} answered`, 'possible'), settled);
    }
    if (settled.state !== 'settled') throw new ModelCallError(new ProviderError('sentinel.provider.malformedResponse', 'no usage reported; the reservation stays held', 'possible'), settled);
    return Object.freeze({
      content: parsed.content, finish: parsed.finish, truncated: parsed.finish === 'length',
      identity: Object.freeze({ requestedModel: binding.model, returnedModel: parsed.returnedModel, probedRevision: binding.capability.revision,
        source: binding.kind === 'ollama' ? 'host-reported' as const : 'provider-response' as const }),
      usage: Object.freeze({ certainty: 'confirmed' as const, inputTokens: inputTokens!, outputTokens: outputTokens!, monetaryCost: fromNanos(costNanos),
        currency: held.budget.currency!, basis: binding.pricing.kind === 'rates' ? 'rate-schedule' as const : 'no-fee' as const }),
      reservation: settled,
    });
  }
}

/** A fresh coordinator-scoped epoch id, for callers without one. */
export const newEpoch = () => `epoch-${randomUUID()}`;
