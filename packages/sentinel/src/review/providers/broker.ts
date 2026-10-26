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
import { isConsumedReceipt, receiptAuthority, type ReceiptBook, type ConsumedReceipt } from '../../policy/receipts.js';
import { snapshot } from '../../policy/immutable.js';
import { isEffectivePolicy, type EffectivePolicy } from '../../policy/settings.js';
import type { BudgetLedger, Reservation } from './budget.js';
import { resolveCredential, type CredentialSource, type Secret } from './credentials.js';
import { costOf, toNanos, fromNanos } from './decimal.js';
import {
  ProviderError,
  NativeCredentialError,
  NativeCopilotError,
  copilotFailureEvent,
  type NativeCopilotDiagnostic,
  type NativeAuthDiagnostic,
  fail,
} from './errors.js';
import { chatBody, chatPath, parseReply, type ChatMessage, type FinishReason, type ReplyIdentity } from './kinds.js';
import { isProviderBinding, type ProviderBinding } from './profile.js';
import { exchange } from './transport.js';
import { nativeCopilotCall } from './cli-copilot-call.js';
import { qualifyInstalledNativeCopilot, type NativeCopilotRuntime } from './cli-copilot-profile.js';
import { renderNativeCopilotWire } from './cli-copilot-wire.js';
import { nativeClaudeCall } from './cli-native-call.js';
import {
  nativeRuntimeHelper,
  qualifyInstalledNativeClaude,
  type NativeClaudeRuntime,
  type NativeTiming,
} from './cli-native-profile.js';
import { renderNativeClaudeWire, type NativeReviewWire } from './cli-native-wire.js';

export interface BrokerDeps {
  readonly ledger: BudgetLedger;
  readonly credentials: CredentialSource;
  /** This coordinator epoch; recovery fences other epochs' reservations. */
  readonly epoch: string;
  readonly now?: () => Date;
  /** Qualified closed native runtime supplied by the trusted local owner process, never a request body. */
  readonly nativeClaude?: NativeClaudeRuntime;
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
  /** Canonical digest of the exact native wire already retained before this call. */
  readonly expectedWireDigest?: string;
  /** Original absolute coordinator unit deadline. Required by the native profile. */
  readonly deadlineAt?: number;
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
    readonly monetaryCost: string | null;
    readonly currency: string | null;
    readonly basis: 'rate-schedule' | 'no-fee' | 'subscription-quota';
  };
  readonly reservation: Reservation;
}

/** Thrown after a call settled or stayed uncertain; carries the reservation as recorded. */
export class ModelCallError extends ProviderError {
  readonly reservation: Reservation | null;
  readonly nativeAuth?: Readonly<NativeAuthDiagnostic>;
  readonly nativeCopilot?: Readonly<NativeCopilotDiagnostic>;
  constructor(cause: ProviderError, reservation: Reservation | null) {
    super(cause.code, '', cause.spend);
    this.message = cause.message;
    this.reservation = reservation;
    if (cause instanceof NativeCredentialError) this.nativeAuth = cause.nativeAuth;
    if (cause instanceof NativeCopilotError) this.nativeCopilot = cause.nativeCopilot;
  }
}

/**
 * The exact intent an envelope is admitted for, and an owner receipt confirms: `paid.admit` over the binding digest,
 * with disclosure and network effects for a hosted provider, the run's budget and the provider as scope.
 */
export function envelopeIntent(binding: ProviderBinding, runId: string, budget: Budget): ActionIntent {
  const effects: ActionEffect[] = [
    'paid-inference',
    ...(binding.disclosure === 'hosted' ? (['source-disclosure', 'network'] as const) : []),
  ];
  return {
    action: 'paid.admit',
    input: binding.digest,
    effects,
    budget: { ...budget },
    scope: { profile: null, provider: binding.providerId, targets: [runId] },
  };
}

const envelopes = new WeakMap<
  object,
  {
    binding: ProviderBinding;
    credential: Secret | null;
    budget: Budget;
    nativeRuntime?: NativeClaudeRuntime;
    copilotRuntime?: NativeCopilotRuntime;
    receipt?: ConsumedReceipt;
  }
>();
/** Package-internal opaque authority. No exported factory: only generate can issue it from its private envelope. */
export interface NativeCallAuthority {
  readonly nativeCall: 'closed-v1';
}
type NativeCallContext = {
  runtime: NativeClaudeRuntime;
  wire: NativeReviewWire;
  limits: NativeTiming & { maxResponseBytes: number; maxOutputTokens: number };
};
const nativeCalls = new WeakMap<
  object,
  NativeCallContext & {
    ledger: BudgetLedger;
    reservationId: string;
    receipt: ConsumedReceipt;
    phase: 'issued' | 'started' | 'read';
  }
>();
function activeNativeCall(value: object) {
  const held = nativeCalls.get(value);
  if (!held || !isConsumedReceipt(held.receipt) || held.ledger.reservation(held.reservationId).state !== 'dispatched')
    return fail('sentinel.provider.notAdmitted', 'native call has no live admitted reservation');
  if (held.limits.signal?.aborted) fail('sentinel.provider.canceled', 'native authority canceled');
  if (Date.now() >= held.limits.deadlineAt)
    fail('sentinel.provider.timeout', 'native authority original deadline elapsed');
  return held;
}
/** One start only, validated against broker-private state. A qualified executable alone grants nothing. */
export function beginNativeCall(value: NativeCallAuthority): NativeCallContext {
  const held = activeNativeCall(value);
  if (held.phase !== 'issued') return fail('sentinel.provider.notAdmitted', 'native call authority was already used');
  held.phase = 'started';
  return { runtime: held.runtime, wire: held.wire, limits: held.limits };
}
/** The helper additionally consumes its exact one-read authority before the fixed native query. */
export function claimNativeLogin(value: NativeCallAuthority, helper: object, timing: NativeTiming): void {
  const held = activeNativeCall(value);
  if (
    held.phase !== 'started' ||
    nativeRuntimeHelper(held.runtime) !== helper ||
    held.limits.deadlineAt !== timing.deadlineAt ||
    held.limits.signal !== timing.signal
  )
    return fail('sentinel.provider.notAdmitted', 'native login has no exact one-read authority');
  held.phase = 'read';
}
export function assertNativeLoginActive(value: NativeCallAuthority): void {
  const held = activeNativeCall(value);
  if (held.phase !== 'read') fail('sentinel.provider.notAdmitted', 'native login authority is not active');
}
export function finishNativeCall(value: NativeCallAuthority): void {
  nativeCalls.delete(value);
}
/** Separate private one-start capability for the fixed Copilot path; no caller JSON can mint one. */
export interface CopilotCallAuthority {
  readonly nativeCall: 'copilot-closed-v1';
}
type CopilotContext = {
  runtime: NativeCopilotRuntime;
  wire: NativeReviewWire;
  limits: NativeTiming & { maxResponseBytes: number; maxOutputTokens: number };
};
const copilotCalls = new WeakMap<
  object,
  CopilotContext & { ledger: BudgetLedger; reservationId: string; receipt: ConsumedReceipt; started: boolean }
>();
export function beginCopilotCall(value: CopilotCallAuthority): CopilotContext {
  const held = copilotCalls.get(value);
  if (
    !held ||
    held.started ||
    !isConsumedReceipt(held.receipt) ||
    held.ledger.reservation(held.reservationId).state !== 'dispatched'
  )
    return fail('sentinel.provider.notAdmitted', 'Copilot requires its exact unused dispatched authority');
  if (held.limits.signal?.aborted) return fail('sentinel.provider.canceled', 'Copilot authority canceled');
  if (Date.now() >= held.limits.deadlineAt)
    return fail('sentinel.provider.timeout', 'Copilot authority deadline elapsed');
  held.started = true;
  return { runtime: held.runtime, wire: held.wire, limits: held.limits };
}
export function finishCopilotCall(value: CopilotCallAuthority) {
  copilotCalls.delete(value);
}
const stamp = (d: Date) => d.toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z');
const ROLES = new Set(['system', 'user', 'assistant']);

export class ModelBroker {
  readonly #deps: BrokerDeps;
  constructor(deps: BrokerDeps) {
    this.#deps = deps;
  }
  #now() {
    return (this.#deps.now ?? (() => new Date()))();
  }

  async openEnvelope(given: OpenEnvelopeRequest): Promise<ModelEnvelope> {
    const { binding, policy } = given;
    // Every admission input is a private frozen copy taken before anything is awaited: a caller that changes its
    // objects during the keychain read cannot change the budget, run, requester or state the receipt is checked
    // against and the ledger records.
    const req = {
      binding,
      policy,
      ...snapshot({
        runId: given.runId,
        budget: given.budget,
        requestedBy: given.requestedBy,
        stateDigest: given.stateDigest,
      }),
      ...(given.receipt ? { receipt: Object.freeze({ book: given.receipt.book, id: given.receipt.id }) } : {}),
    };
    if (!isProviderBinding(binding))
      fail('sentinel.provider.notTrusted', 'only bindProvider’s own binding is accepted');
    if (!isEffectivePolicy(policy) || policy.revision !== binding.policyRevision)
      fail('sentinel.provider.bindingChanged', 'the policy changed since the binding was made');
    const b = req.budget;
    const native = binding.kind === 'claude-cli' || binding.kind === 'copilot-cli';
    if (native) {
      if (b.maxTokens === null || b.maxCost !== null || b.currency !== null)
        fail('sentinel.provider.budgetExhausted', 'native subscription states its token quota and unobserved money');
    } else if (b.maxTokens === null || b.maxCost === null || b.currency === null || toNanos(b.maxCost) === null)
      fail('sentinel.provider.budgetExhausted', 'a model budget states its tokens, money and currency');
    const hosted = binding.disclosure === 'hosted';
    const priced = binding.pricing.kind === 'rates';
    const intent = envelopeIntent(binding, req.runId, b);
    const capability = () => ({
      available: true,
      detail: `capability record for ${binding.model} at ${binding.origin}, probed ${binding.capability.probedAt}`,
    });
    const decide = (credential: Parameters<typeof admit>[0]['credential'], receipt?: OpenEnvelopeRequest['receipt']) =>
      admit({
        intent,
        requestedBy: req.requestedBy,
        policy,
        capability,
        credential,
        stateDigest: req.stateDigest,
        now: this.#now(),
        ...(receipt ? { receipt } : {}),
      });
    // The policy first, with no credential read: a denial reads nothing and contacts nothing.
    const preview = decide(() => ({ basis: 'unknown', detail: 'not read yet' }));
    if (!preview.record.verdicts.policy.allowed)
      fail('sentinel.provider.notAdmitted', preview.record.verdicts.policy.reasonCode);
    if ((hosted || priced) && !req.receipt)
      fail('sentinel.provider.receiptRequired', hosted ? 'hosted disclosure' : 'priced inference');
    let nativeRuntime: NativeClaudeRuntime | undefined;
    let copilotRuntime: NativeCopilotRuntime | undefined;
    if (binding.kind === 'claude-cli') {
      nativeRuntime =
        this.#deps.nativeClaude ?? (await qualifyInstalledNativeClaude({ deadlineAt: Date.now() + 5000 }));
      const p = binding.nativeProfile;
      if (
        !p ||
        nativeRuntime.profileId !== p.id ||
        nativeRuntime.executableDigest !== p.executableDigest ||
        nativeRuntime.helperDigest !== p.helperDigest ||
        nativeRuntime.profileDigest !== p.profileDigest
      )
        fail('sentinel.provider.capabilityUntested', 'adopted native runtime is unavailable or changed');
      nativeRuntimeHelper(nativeRuntime); // genuine fixed qualification only, no credential read
    }
    if (binding.kind === 'copilot-cli') {
      copilotRuntime = await qualifyInstalledNativeCopilot({ deadlineAt: Date.now() + 5000 });
      const p = binding.copilotProfile;
      if (
        !p ||
        copilotRuntime.profileId !== p.id ||
        copilotRuntime.executableDigest !== p.executableDigest ||
        copilotRuntime.runtimeDigest !== p.runtimeDigest ||
        copilotRuntime.profileDigest !== p.profileDigest
      )
        fail('sentinel.provider.capabilityUntested', 'adopted Copilot code closure is unavailable or changed');
    }
    let credential: Secret | null = null;
    let answer: ReturnType<Parameters<typeof admit>[0]['credential']>;
    if (native) {
      answer = {
        basis: 'keychain-scope',
        allowed: true,
        detail:
          binding.kind === 'copilot-cli'
            ? 'pinned vendor native keychain capability; shared securityd trust, login unobserved until invocation'
            : 'fixed no-UI native read capability; login validity remains unobserved until admitted call',
      };
    } else if (binding.credential === null) {
      answer = hosted
        ? { basis: 'unknown', detail: 'a hosted provider with no credential reference' }
        : { basis: 'local-only', detail: 'a loopback provider needs no remote credential' };
    } else {
      try {
        credential = await resolveCredential(this.#deps.credentials, binding.credential);
        answer = { basis: 'keychain-scope', allowed: true, detail: 'read for the approved reference' };
      } catch {
        answer = { basis: 'keychain-scope', allowed: false, detail: 'the approved reference could not be read' };
      }
    }
    const result = decide(() => answer, req.receipt);
    if (result.record.outcome !== 'admitted')
      fail(
        'sentinel.provider.notAdmitted',
        result.record.outcome === 'awaiting-confirmation' ? 'waiting for the owner' : 'denied',
      );
    // Paid or disclosing use needs the owner's receipt even when the grants ask for no confirmation: spend it here
    // when admission did not, against exactly this intent, state and policy revision.
    let spent = result.receipt;
    if ((hosted || priced) && !spent && req.receipt) {
      spent = req.receipt.book.consume(
        req.receipt.id,
        { intent, stateDigest: req.stateDigest, policyRevision: policy.revision },
        this.#now(),
      );
    }
    if (
      (hosted || priced) &&
      !(spent && isConsumedReceipt(spent) && receiptAuthority(spent)?.intentDigest === result.record.intentDigest)
    ) {
      fail('sentinel.provider.receiptRequired', hosted ? 'hosted disclosure' : 'priced inference');
    }
    const receiptDigest = spent?.digest ?? null;
    const admissionDigest = canonicalDigest(result.record);
    const id = `menv-${admissionDigest.slice(7, 39)}`;
    this.#deps.ledger.createEnvelope({
      id,
      runId: req.runId,
      providerId: binding.providerId,
      bindingDigest: binding.digest,
      admissionDigest,
      receiptDigest,
      maxTokens: b.maxTokens!,
      maxCostNanos: native ? null : toNanos(b.maxCost!)!,
      currency: b.currency!,
      ...(native ? { accountingBasis: 'subscription-quota' as const } : {}),
      createdAt: stamp(this.#now()),
    });
    const env: ModelEnvelope = Object.freeze({
      id,
      runId: req.runId,
      bindingDigest: binding.digest,
      admission: result.record,
      receiptDigest,
    });
    envelopes.set(env, {
      binding,
      credential,
      budget: { ...b },
      ...(nativeRuntime ? { nativeRuntime } : {}),
      ...(copilotRuntime ? { copilotRuntime } : {}),
      ...(spent ? { receipt: spent } : {}),
    });
    return env;
  }

  /** Pure exact wire for the session checkpoint; grants no launch or admission authority. */
  renderRequest(
    binding: ProviderBinding,
    messages: readonly ChatMessage[],
    maxOutputTokens: number,
  ): NativeReviewWire | undefined {
    if (!isProviderBinding(binding))
      fail('sentinel.provider.notTrusted', 'native wire requires the current adopted binding');
    if (binding.kind !== 'claude-cli' && binding.kind !== 'copilot-cli') return undefined;
    const wire =
      binding.kind === 'copilot-cli'
        ? renderNativeCopilotWire(binding.model, messages, maxOutputTokens)
        : renderNativeClaudeWire(binding.model, messages, maxOutputTokens);
    if (Buffer.byteLength(wire.stdin) + Buffer.byteLength(wire.system) > binding.limits.maxRequestBytes)
      fail('sentinel.provider.requestTooLarge', 'native wire exceeds the adopted input bound');
    return wire;
  }

  /** The worst case one call could be charged, before it is sent. */
  worstCase(
    binding: ProviderBinding,
    body: Uint8Array,
    messages: number,
    maxOutputTokens: number,
  ): { inputTokens: number; tokens: number; costNanos: bigint | null } {
    // Reserve the entire fixed context, including opaque vendor overhead, for a single native turn.
    // This is a conservative token quota, not a monetary prediction or a free-subscription claim.
    if (binding.kind === 'claude-cli' || binding.kind === 'copilot-cli')
      return {
        inputTokens: binding.limits.contextTokens - maxOutputTokens,
        tokens: binding.limits.contextTokens,
        costNanos: null,
      };
    const inputTokens = body.byteLength + messages * binding.limits.templateTokensPerMessage;
    const tokens = inputTokens + maxOutputTokens;
    const costNanos =
      binding.pricing.kind === 'rates'
        ? costOf(inputTokens, toNanos(binding.pricing.inputPerMillion)!) +
          costOf(maxOutputTokens, toNanos(binding.pricing.outputPerMillion)!)
        : 0n;
    return { inputTokens, tokens, costNanos };
  }

  async generate(env: ModelEnvelope, current: ProviderBinding, call: GenerateRequest): Promise<ModelReply> {
    const held = envelopes.get(env);
    if (!held) return fail('sentinel.provider.notAdmitted', 'only an envelope openEnvelope returned is accepted');
    const { binding, credential } = held;
    if (!isProviderBinding(current) || current.digest !== binding.digest)
      fail('sentinel.provider.bindingChanged', 'the provider’s binding is not the one approved');
    // The binding is re-made under the policy in force for every call: any policy change, a revoked grant included,
    // stops the envelope until the owner approves again.
    if (current.policyRevision !== binding.policyRevision)
      fail('sentinel.provider.bindingChanged', 'the policy changed since this budget was approved');
    const L = binding.limits;
    if (
      !Number.isSafeInteger(call.maxOutputTokens) ||
      call.maxOutputTokens < 1 ||
      call.maxOutputTokens > L.maxOutputTokens
    )
      fail('sentinel.provider.invalidProfile', 'maxOutputTokens is outside the profile');
    if (
      !Array.isArray(call.messages) ||
      call.messages.length < 1 ||
      call.messages.length > L.maxMessages ||
      call.messages.some((m) => !m || !ROLES.has(m.role) || typeof m.content !== 'string')
    )
      fail('sentinel.provider.invalidProfile', 'messages are a bounded list of role and text');
    const wire = this.renderRequest(binding, call.messages, call.maxOutputTokens);
    if (wire ? call.expectedWireDigest !== canonicalDigest(wire) : call.expectedWireDigest !== undefined)
      fail('sentinel.provider.bindingChanged', 'retained native wire does not match this exact call');
    const nativeDeadline = wire ? call.deadlineAt : undefined;
    if (
      wire &&
      (!Number.isSafeInteger(nativeDeadline) ||
        nativeDeadline! <= Date.now() ||
        nativeDeadline! - Date.now() > L.timeoutMs)
    )
      fail('sentinel.provider.timeout', 'native call requires its original bounded unit deadline');
    const body = Buffer.from(
      wire
        ? wire.system + wire.stdin
        : JSON.stringify(chatBody(binding.kind, binding.model, call.messages, call.maxOutputTokens, L.contextTokens)),
      'utf8',
    );
    if (body.byteLength > L.maxRequestBytes)
      fail('sentinel.provider.requestTooLarge', `${body.byteLength} of ${L.maxRequestBytes} bytes`);
    const worst = this.worstCase(binding, body, call.messages.length, call.maxOutputTokens);
    if (worst.tokens > L.contextTokens)
      fail('sentinel.provider.contextExceeded', `${worst.tokens} of ${L.contextTokens} tokens`);

    const ledger = this.#deps.ledger;
    let res = ledger.reserve({
      envelopeId: env.id,
      operationId: call.operationId,
      tokens: worst.tokens,
      costNanos: worst.costNanos,
      epoch: this.#deps.epoch,
      at: stamp(this.#now()),
    });
    // An operation is sent at most once: a repeat finds its reservation already past `held` and is refused.
    if (res.state !== 'held')
      fail('sentinel.provider.reservationState', `operation ${call.operationId} is already ${res.state}`);
    let nativeAuthority: NativeCallAuthority | undefined;
    let copilotAuthority: CopilotCallAuthority | undefined;
    if (wire && binding.kind === 'copilot-cli') {
      if (
        !held.copilotRuntime ||
        !held.receipt ||
        !isConsumedReceipt(held.receipt) ||
        receiptAuthority(held.receipt)?.intentDigest !== env.admission.intentDigest ||
        res.envelopeId !== env.id
      )
        return fail('sentinel.provider.notAdmitted', 'Copilot requires exact admitted receipt and held reservation');
      copilotAuthority = Object.freeze({ nativeCall: 'copilot-closed-v1' as const });
      copilotCalls.set(copilotAuthority, {
        runtime: held.copilotRuntime,
        wire,
        limits: Object.freeze({
          deadlineAt: nativeDeadline!,
          maxResponseBytes: L.maxResponseBytes,
          maxOutputTokens: call.maxOutputTokens,
          ...(call.signal ? { signal: call.signal } : {}),
        }),
        ledger,
        reservationId: res.id,
        receipt: held.receipt,
        started: false,
      });
    }
    if (wire && binding.kind === 'claude-cli') {
      if (
        !held.nativeRuntime ||
        !held.receipt ||
        !isConsumedReceipt(held.receipt) ||
        receiptAuthority(held.receipt)?.intentDigest !== env.admission.intentDigest ||
        res.envelopeId !== env.id
      )
        return fail(
          'sentinel.provider.notAdmitted',
          'native call requires its exact admitted receipt and held reservation',
        );
      nativeAuthority = Object.freeze({ nativeCall: 'closed-v1' as const });
      nativeCalls.set(nativeAuthority, {
        runtime: held.nativeRuntime,
        wire,
        limits: Object.freeze({
          deadlineAt: nativeDeadline!,
          maxResponseBytes: L.maxResponseBytes,
          maxOutputTokens: call.maxOutputTokens,
          ...(call.signal ? { signal: call.signal } : {}),
        }),
        ledger,
        reservationId: res.id,
        receipt: held.receipt,
        phase: 'issued',
      });
    }
    res = ledger.dispatch(res.id, stamp(this.#now()));

    let parsed: ReturnType<typeof parseReply>;
    try {
      if (wire) {
        parsed =
          binding.kind === 'copilot-cli'
            ? await nativeCopilotCall(copilotAuthority!)
            : await nativeClaudeCall(nativeAuthority!);
      } else {
        const { json } = await exchange({
          origin: binding.origin,
          method: 'POST',
          path: chatPath(binding.kind),
          body,
          credential,
          maxResponseBytes: L.maxResponseBytes,
          timeoutMs: L.timeoutMs,
          ...(call.signal ? { signal: call.signal } : {}),
        });
        parsed = parseReply(binding.kind, json);
      }
    } catch (error) {
      const e =
        error instanceof ProviderError
          ? error
          : new ProviderError('sentinel.provider.malformedResponse', 'unexpected failure', 'possible');
      const after =
        e.spend === 'none'
          ? ledger.releaseUnsent(res.id, stamp(this.#now()), 'no-connection')
          : ledger.markUncertain(
              res.id,
              stamp(this.#now()),
              e instanceof NativeCopilotError ? copilotFailureEvent(e) : e.code,
            );
      throw new ModelCallError(e, after);
    } finally {
      if (nativeAuthority) finishNativeCall(nativeAuthority);
      if (copilotAuthority) finishCopilotCall(copilotAuthority);
    }

    const { inputTokens, outputTokens } = parsed.usage;
    let settled: Reservation;
    let costNanos: bigint | null = binding.kind === 'claude-cli' || binding.kind === 'copilot-cli' ? null : 0n;
    if (inputTokens === null || outputTokens === null) {
      settled = ledger.markUncertain(res.id, stamp(this.#now()), 'the reply reported no usage');
    } else {
      if (binding.pricing.kind === 'rates') {
        costNanos =
          costOf(inputTokens, toNanos(binding.pricing.inputPerMillion)!) +
          costOf(outputTokens, toNanos(binding.pricing.outputPerMillion)!);
      }
      settled = ledger.settle(res.id, { inputTokens, outputTokens, costNanos }, stamp(this.#now()));
    }
    if (parsed.returnedModel === null)
      throw new ModelCallError(
        new ProviderError('sentinel.provider.identityMalformed', 'no model name', 'possible'),
        settled,
      );
    if (parsed.returnedModel !== binding.model) {
      // The returned name is provider-controlled text: it stays out of the public error (it could echo anything sent).
      throw new ModelCallError(
        new ProviderError(
          'sentinel.provider.identityMismatch',
          `${binding.model} asked, another model answered`,
          'possible',
        ),
        settled,
      );
    }
    if (settled.state !== 'settled')
      throw new ModelCallError(
        new ProviderError(
          'sentinel.provider.malformedResponse',
          'no usage reported; the reservation stays held',
          'possible',
        ),
        settled,
      );
    return Object.freeze({
      content: parsed.content,
      finish: parsed.finish,
      truncated: parsed.finish === 'length',
      identity: Object.freeze({
        requestedModel: binding.model,
        returnedModel: parsed.returnedModel,
        probedRevision: binding.capability.revision,
        source:
          binding.kind === 'ollama' || binding.kind === 'claude-cli' || binding.kind === 'copilot-cli'
            ? ('host-reported' as const)
            : ('provider-response' as const),
      }),
      usage: Object.freeze({
        certainty: 'confirmed' as const,
        inputTokens: inputTokens!,
        outputTokens: outputTokens!,
        monetaryCost: costNanos === null ? null : fromNanos(costNanos),
        currency: held.budget.currency,
        basis:
          binding.pricing.kind === 'subscription-quota'
            ? ('subscription-quota' as const)
            : binding.pricing.kind === 'rates'
              ? ('rate-schedule' as const)
              : ('no-fee' as const),
      }),
      reservation: settled,
    });
  }
}

/** A fresh coordinator-scoped epoch id, for callers without one. */
export const newEpoch = () => `epoch-${randomUUID()}`;
