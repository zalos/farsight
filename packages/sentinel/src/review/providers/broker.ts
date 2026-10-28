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
import type { NativeClaudeRuntime } from './cli-native-profile.js';
import type { NativeReviewWire } from './cli-native-wire.js';
import { providerKind } from './registry.js';
import type { CopilotAgentPartial, CopilotAgentRequest, CopilotAgentResult } from './cli-copilot-agent.js';
export type { NativeCallAuthority, CopilotCallAuthority } from './authority.js';
export {
  beginNativeCall,
  claimNativeLogin,
  assertNativeLoginActive,
  finishNativeCall,
  beginCopilotCall,
  finishCopilotCall,
} from './authority.js';

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
  /** A native run that completed and settled, then was refused (identity, budget): kept for the private record. */
  readonly agentResult?: CopilotAgentResult;
  /** A native run that failed before completing: its bounded partial ledger, kept for the private record. */
  readonly agentPartial?: CopilotAgentPartial;
  /** The qualified installation a native run used (category and exact path): private provenance. */
  readonly agentInstallation?: Readonly<{ source: string; executable: string }>;
  constructor(
    cause: ProviderError,
    reservation: Reservation | null,
    agentResult?: CopilotAgentResult,
    agentInstallation?: Readonly<{ source: string; executable: string }>,
  ) {
    super(cause.code, '', cause.spend);
    this.message = cause.message;
    this.reservation = reservation;
    if (agentResult) this.agentResult = agentResult;
    if (agentInstallation) this.agentInstallation = agentInstallation;
    const partial = (cause as { partial?: CopilotAgentPartial }).partial;
    if (partial) this.agentPartial = partial;
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
    /** The qualified CLI runtime for a sandboxed-CLI kind, compared with the adopted pin at open. */
    cliRuntime?: object;
    receipt?: ConsumedReceipt;
  }
>();
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
    const kind = providerKind(binding.kind);
    const native = kind.accounting === 'subscription-quota';
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
    const cliRuntime = kind.cli
      ? await kind.cli.qualify(binding, this.#deps.nativeClaude ? { nativeClaude: this.#deps.nativeClaude } : {})
      : undefined;
    let credential: Secret | null = null;
    let answer: ReturnType<Parameters<typeof admit>[0]['credential']>;
    if (kind.cli) {
      answer = { basis: 'keychain-scope', allowed: true, detail: kind.cli.credentialDetail };
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
      ...(cliRuntime ? { cliRuntime } : {}),
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
    const cli = providerKind(binding.kind).cli;
    if (!cli) return undefined;
    const wire = cli.renderWire(binding.model, messages, maxOutputTokens);
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
    if (providerKind(binding.kind).accounting === 'subscription-quota')
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

  /**
   * One native-mode stage run under an envelope: the CLI runs its own loop over the stage's inputs. The stage's token
   * budget is reserved durably before dispatch and the reservation is marked dispatched before the process starts;
   * the owned usage file settles it, or it stays uncertain. A run that reports more tokens than its stage allows is
   * settled (overdrawing the envelope) and then refused, so its output is never published.
   */
  async runAgent(env: ModelEnvelope, current: ProviderBinding, req: AgentRunRequest): Promise<AgentRunReply> {
    const held = envelopes.get(env);
    if (!held) return fail('sentinel.provider.notAdmitted', 'only an envelope openEnvelope returned is accepted');
    const { binding } = held;
    if (!isProviderBinding(current) || current.digest !== binding.digest)
      fail('sentinel.provider.bindingChanged', 'the provider’s binding is not the one approved');
    if (current.policyRevision !== binding.policyRevision)
      fail('sentinel.provider.bindingChanged', 'the policy changed since this budget was approved');
    const cli = providerKind(binding.kind).cli;
    if (!cli?.agent || cli.mode(binding) !== 'native')
      return fail('sentinel.provider.invalidProfile', 'the adopted profile has no qualified native mode');
    if (!Number.isSafeInteger(req.maxTurns) || req.maxTurns < 1 || req.maxTurns > 64)
      fail('sentinel.provider.invalidProfile', 'a native stage allows 1 to 64 turns');
    if (!Number.isSafeInteger(req.tokens) || req.tokens < 1 || req.tokens > binding.limits.contextTokens)
      fail('sentinel.provider.contextExceeded', 'a native stage token budget is within the adopted context');
    if (!Number.isSafeInteger(req.deadlineAt) || req.deadlineAt <= Date.now() || req.deadlineAt - Date.now() > 600000)
      fail('sentinel.provider.timeout', 'a native stage needs its original bounded deadline');
    if (
      !Array.isArray(req.files) ||
      req.files.length > 1000 ||
      typeof req.task !== 'string' ||
      !(req.instructions instanceof Uint8Array)
    )
      fail('sentinel.provider.invalidProfile', 'a native stage names bounded inputs, instructions and a task');
    const bytes =
      req.files.reduce((n, f) => n + f.bytes.byteLength, 0) + req.instructions.byteLength + Buffer.byteLength(req.task);
    if (bytes > binding.limits.maxRequestBytes * 64)
      fail('sentinel.provider.requestTooLarge', `${bytes} input bytes for a native stage`);
    const ledger = this.#deps.ledger;
    let res = ledger.reserve({
      envelopeId: env.id,
      operationId: req.operationId,
      tokens: req.tokens,
      costNanos: null,
      epoch: this.#deps.epoch,
      at: stamp(this.#now()),
    });
    if (res.state !== 'held')
      fail('sentinel.provider.reservationState', `operation ${req.operationId} is already ${res.state}`);
    if (
      !held.cliRuntime ||
      !held.receipt ||
      !isConsumedReceipt(held.receipt) ||
      receiptAuthority(held.receipt)?.intentDigest !== env.admission.intentDigest ||
      res.envelopeId !== env.id
    )
      return fail('sentinel.provider.notAdmitted', 'a native run requires its exact admitted receipt and reservation');
    const authority = cli.agent.issue({
      runtime: held.cliRuntime,
      request: Object.freeze({
        model: binding.model,
        files: req.files,
        instructions: req.instructions,
        task: req.task,
        maxTurns: req.maxTurns,
      }),
      limits: Object.freeze({ deadlineAt: req.deadlineAt, ...(req.signal ? { signal: req.signal } : {}) }),
      ledger,
      reservationId: res.id,
      receipt: held.receipt,
    });
    res = ledger.dispatch(res.id, stamp(this.#now()));
    const installation = cli.agent.installation(held.cliRuntime);
    let result: CopilotAgentResult;
    try {
      result = await cli.agent.call(authority);
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
      throw new ModelCallError(e, after, undefined, installation);
    } finally {
      cli.agent.release(authority);
    }
    const settled = ledger.settle(
      res.id,
      { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, costNanos: null },
      stamp(this.#now()),
    );
    if (result.reportedModel !== binding.model)
      throw new ModelCallError(
        new ProviderError(
          'sentinel.provider.identityMismatch',
          `${binding.model} asked, another model answered`,
          'possible',
        ),
        settled,
        result,
        installation,
      );
    if (result.usage.inputTokens + result.usage.outputTokens > req.tokens)
      throw new ModelCallError(
        new ProviderError(
          'sentinel.provider.budgetExhausted',
          'the run used more tokens than its stage allows',
          'possible',
        ),
        settled,
        result,
        installation,
      );
    return Object.freeze({
      result,
      installation,
      identity: Object.freeze({
        requestedModel: binding.model,
        returnedModel: result.reportedModel,
        probedRevision: binding.capability.revision,
        source: providerKind(binding.kind).identitySource,
      }),
      usage: Object.freeze({
        certainty: 'confirmed' as const,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        monetaryCost: null,
        currency: null,
        basis: 'subscription-quota' as const,
      }),
      reservation: settled,
    });
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
    if (providerKind(binding.kind).cli?.mode(binding) === 'native')
      fail('sentinel.provider.invalidProfile', 'a native agent profile runs whole stages, not brokered turns');
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
    const cli = providerKind(binding.kind).cli;
    let authority: object | undefined;
    if (wire && cli) {
      if (
        !held.cliRuntime ||
        !held.receipt ||
        !isConsumedReceipt(held.receipt) ||
        receiptAuthority(held.receipt)?.intentDigest !== env.admission.intentDigest ||
        res.envelopeId !== env.id
      )
        return fail(
          'sentinel.provider.notAdmitted',
          'native call requires its exact admitted receipt and held reservation',
        );
      authority = cli.issue({
        runtime: held.cliRuntime,
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
      });
    }
    res = ledger.dispatch(res.id, stamp(this.#now()));

    let parsed: ReturnType<typeof parseReply>;
    try {
      if (wire && cli) {
        parsed = await cli.call(authority!);
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
      if (authority) cli?.release(authority);
    }

    const { inputTokens, outputTokens } = parsed.usage;
    let settled: Reservation;
    let costNanos: bigint | null = providerKind(binding.kind).accounting === 'subscription-quota' ? null : 0n;
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
        source: providerKind(binding.kind).identitySource,
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

export interface AgentRunRequest {
  /** Stable per logical run: asking again returns the same reservation and is never sent twice. */
  readonly operationId: string;
  readonly files: CopilotAgentRequest['files'];
  readonly instructions: Uint8Array;
  readonly task: string;
  /** The stage's turn budget: model requests allowed. */
  readonly maxTurns: number;
  /** The stage's token budget: reserved before dispatch; a run that reports more fails after settling. */
  readonly tokens: number;
  /** The stage's absolute deadline. */
  readonly deadlineAt: number;
  readonly signal?: AbortSignal;
}
export interface AgentRunReply {
  readonly result: CopilotAgentResult;
  /** Which installation ran and its exact path on this machine: private provenance, redacted in public artifacts. */
  readonly installation: Readonly<{ source: string; executable: string }>;
  readonly identity: ReplyIdentity;
  readonly usage: ModelReply['usage'];
  readonly reservation: Reservation;
}

/** A fresh coordinator-scoped epoch id, for callers without one. */
export const newEpoch = () => `epoch-${randomUUID()}`;
