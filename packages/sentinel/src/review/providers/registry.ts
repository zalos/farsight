// The provider-kind registry: the one place a provider kind's behaviour is decided. The broker, the binding check,
// the stage selection, the caller and the review adapter ask this table; none of them switches on a kind name.
//
// Two transports: `http` (Ollama, an OpenAI-compatible endpoint) through the bounded loopback-or-TLS exchange, and
// `sandboxed-cli` (Claude Code, Copilot CLI) through one admitted turn of the pinned CLI under the shared sandboxed
// runner. Adding a kind is one entry here plus its contract member; a kind with no entry is refused everywhere.
import type { ProviderSettings, ModelSettings, SettingsEnvelope } from '../../contracts/index.js';
import type { ConsumedReceipt } from '../../policy/receipts.js';
import type { BudgetLedger } from './budget.js';
import { fail } from './errors.js';
import { featureEnabled } from '../../policy/features.js';
import type { ChatMessage, IdentityStrength, ParsedReply } from './kinds.js';
import type { ModelLimits, ProviderBinding, ProviderKind } from './profile.js';
import { OLLAMA_WIRE, OPENAI_COMPATIBLE_WIRE, type HttpKindWire } from './http-kinds.js';
import {
  issueCopilotCall,
  issueNativeCall,
  issueCopilotAgentCall,
  finishCopilotCall,
  finishNativeCall,
  finishCopilotAgentCall,
  issueClaudeAgentCall,
  finishClaudeAgentCall,
  type ClaudeAgentAuthority,
  type CopilotAgentAuthority,
  type NativeLimits,
} from './authority.js';
import {
  copilotProfileById,
  copilotProfileMode,
  copilotRuntimeInstallation,
  qualifyInstalledNativeCopilot,
  type NativeCopilotRuntime,
} from './cli-copilot-profile.js';
import { nativeCopilotAgentCall, type CopilotAgentRequest, type CopilotAgentResult } from './cli-copilot-agent.js';
import { nativeCopilotCall } from './cli-copilot-call.js';
import { renderNativeCopilotWire } from './cli-copilot-wire.js';
import {
  claudeProfileById,
  claudeProfileMode,
  claudeRuntimeInstallation,
  nativeRuntimeHelper,
  qualifyInstalledNativeClaude,
  type NativeClaudeRuntime,
  type NativeTiming,
} from './cli-native-profile.js';
import { nativeClaudeCall } from './cli-native-call.js';
import { nativeClaudeAgentCall, type ClaudeAgentRequest } from './cli-native-agent.js';
import type { Secret } from './credentials.js';
import { runnerQualified } from '../qualification.js';
import { renderNativeClaudeWire, type NativeReviewWire } from './cli-native-wire.js';

/** What a sandboxed CLI kind needs from the broker to qualify, bind, render and run one admitted turn. */
export interface CliKind {
  /** The settings field that pins this CLI's exact code; it belongs to this kind only. */
  readonly profileField: 'nativeProfile' | 'copilotProfile';
  /** Refuses a provider/model outside this CLI's fixed bounds. Throws `invalidProfile`. */
  checkBinding(settings: ProviderSettings, model: ModelSettings, limits: ModelLimits): void;
  renderWire(model: string, messages: readonly ChatMessage[], maxOutputTokens: number): NativeReviewWire;
  /** Qualifies the installed code and compares it with the adopted pin. Reads code only; no login, no call. */
  qualify(binding: ProviderBinding, given: { nativeClaude?: NativeClaudeRuntime }): Promise<object>;
  /** The credential verdict's detail: native authentication stays inside the pinned process. */
  readonly credentialDetail: string;
  /**
   * Where the adopted pin's login comes from: `vendor`, the CLI's own login, which the broker never reads; or
   * `reference`, the owner's token under the adopted `keychain:farsight/…` reference, read in-process by the broker
   * and handed to the pinned process on an anonymous descriptor only.
   */
  credentialSource(binding: ProviderBinding): 'vendor' | 'reference';
  /** One start authority for one dispatched reservation; the call consumes it. */
  issue(context: {
    runtime: object;
    wire: NativeReviewWire;
    limits: NativeLimits;
    ledger: BudgetLedger;
    reservationId: string;
    receipt: ConsumedReceipt;
  }): object;
  call(authority: object): Promise<ParsedReply>;
  /** Ends the authority whatever the call did; idempotent. */
  release(authority: object): void;
  /** Review sessions over this CLI seal these step and deadline caps (Copilot's three turns in 120 s). */
  readonly sessionBudget?: Readonly<{ maxSteps: number; deadlineMs: number }>;
  /** Each turn's deadline is the unit's, capped at the model's own timeout. */
  readonly capsTurnDeadline: boolean;
  /** Which mode the adopted pin runs: brokered turns, or the CLI's own native loop over a scratch tree. */
  mode(binding: ProviderBinding): 'brokered' | 'native';
  /** The native mode, where the CLI has a qualified native profile. */
  readonly agent?: Readonly<{
    issue(context: {
      runtime: object;
      request: AgentCallRequest;
      limits: NativeTiming;
      /** The adopted reference's value for a `reference` pin; null for a vendor login. */
      credential: Secret | null;
      ledger: BudgetLedger;
      reservationId: string;
      receipt: ConsumedReceipt;
    }): object;
    call(authority: object): Promise<CopilotAgentResult>;
    release(authority: object): void;
    /** The qualified installation that runs: its category and exact executable path (private provenance). */
    installation(runtime: object): Readonly<{ source: string; executable: string }>;
    /** Whether the reported model is the requested one; exact equality when absent. */
    sameModel?(requested: string, reported: string): boolean;
  }>;
  /** A release gate the adopted settings must open before a stage may select this CLI. */
  readonly releaseGate?: Readonly<{
    /** Open when the adopted pin has a complete qualification record, or the owner turned its runner flag on. */
    open(settings: SettingsEnvelope, provider: ProviderSettings): boolean;
    code: 'sentinel.provider.nativeClaudeDisabled';
    detail: string;
  }>;
}

/** One native run's request: the Copilot fields, plus the output schema and dollar cap a CLI enforces itself. */
export type AgentCallRequest = CopilotAgentRequest & Readonly<{ jsonSchema?: string; maxUsd?: string }>;

export interface ProviderKindEntry {
  readonly kind: ProviderKind;
  readonly transport: 'http' | 'sandboxed-cli';
  /** An HTTP API kind: a hosted one is refused unless the `review.hosted-api` feature is on. CLIs are not. */
  readonly apiKind: boolean;
  /** Who reports the answering model's identity. */
  readonly identitySource: IdentityStrength;
  /** Money: a native subscription records tokens and `unobserved` money; HTTP kinds record rates or no fee. */
  readonly accounting: 'rates-or-no-fee' | 'subscription-quota';
  readonly http?: HttpKindWire;
  readonly cli?: CliKind;
  /** The agent runner this kind's stages run on (`review/runner.ts`). */
  readonly runner: 'copilot-cli' | 'claude-cli' | 'hosted-api';
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const subscriptionBudget = (s: ProviderSettings) =>
  s.budget.maxTokens !== null && s.budget.maxCost === null && s.budget.currency === null;

const CLAUDE_MODEL = /^claude-[a-z0-9][a-z0-9.-]{0,63}$/;
const KEYCHAIN = /^keychain:farsight\/[a-z0-9][a-z0-9-]{0,62}$/;
const claudePinned = (binding: { nativeProfile?: ProviderSettings['nativeProfile'] }) =>
  binding.nativeProfile ? claudeProfileById(binding.nativeProfile.id) : undefined;

const CLAUDE_CLI = Object.freeze<CliKind>({
  profileField: 'nativeProfile' as const,
  checkBinding(settings: ProviderSettings, model: ModelSettings, limits: ModelLimits) {
    const p = settings.nativeProfile,
      pinned = claudePinned(settings);
    const common =
      !!p &&
      !!pinned &&
      p.executableDigest === pinned.executableDigest &&
      DIGEST.test(p.helperDigest) &&
      DIGEST.test(p.profileDigest) &&
      settings.copilotProfile === undefined &&
      settings.endpoint === 'https://api.anthropic.com' &&
      settings.disclosure === 'hosted' &&
      limits.maxRequestBytes <= 65536 &&
      limits.maxMessages <= 32 &&
      subscriptionBudget(settings);
    const bounded =
      pinned && claudeProfileMode(pinned) === 'native'
        ? // Native: the owner's own token under an adopted reference, any Claude model id, a stage-sized context.
          typeof settings.credential === 'string' &&
          KEYCHAIN.test(settings.credential) &&
          CLAUDE_MODEL.test(model.model) &&
          Number.isSafeInteger(limits.contextTokens) &&
          limits.contextTokens >= 1 &&
          limits.contextTokens <= 1000000 &&
          limits.maxOutputTokens <= 32000
        : // Brokered: the vendor login through the fixed helper, the one fixed model and context.
          settings.credential === null &&
          model.model === 'claude-haiku-4-5-20251001' &&
          limits.contextTokens === 200000 &&
          limits.maxOutputTokens <= 4096;
    if (!common || !bounded)
      fail('sentinel.provider.invalidProfile', 'the adopted native CLI profile is missing or outside its fixed bounds');
  },
  renderWire: renderNativeClaudeWire,
  async qualify(binding: ProviderBinding, given: { nativeClaude?: NativeClaudeRuntime }) {
    const p = binding.nativeProfile,
      pinned = claudePinned(binding);
    if (!p || !pinned) return fail('sentinel.provider.capabilityUntested', 'adopted Claude profile is not a known one');
    const runtime =
      given.nativeClaude ?? (await qualifyInstalledNativeClaude({ deadlineAt: Date.now() + 5000 }, pinned));
    if (
      runtime.profileId !== p.id ||
      runtime.executableDigest !== p.executableDigest ||
      runtime.helperDigest !== p.helperDigest ||
      runtime.profileDigest !== p.profileDigest
    )
      fail('sentinel.provider.capabilityUntested', 'adopted native runtime is unavailable or changed');
    nativeRuntimeHelper(runtime); // genuine fixed qualification only, no credential read
    return runtime;
  },
  credentialDetail: 'fixed no-UI native read capability; login validity remains unobserved until admitted call',
  credentialSource: (binding: ProviderBinding) => {
    const pinned = claudePinned(binding);
    return pinned && claudeProfileMode(pinned) === 'native' ? ('reference' as const) : ('vendor' as const);
  },
  mode: (binding: ProviderBinding) => {
    const pinned = claudePinned(binding);
    return pinned ? claudeProfileMode(pinned) : 'brokered';
  },
  agent: Object.freeze({
    issue: (c: Parameters<NonNullable<CliKind['agent']>['issue']>[0]) => {
      if (typeof c.request.jsonSchema !== 'string')
        return fail('sentinel.provider.invalidProfile', 'a native Claude run names its output schema');
      return issueClaudeAgentCall({
        ...c,
        runtime: c.runtime as NativeClaudeRuntime,
        request: c.request as ClaudeAgentRequest,
      });
    },
    call: (authority: object) => nativeClaudeAgentCall(authority as ClaudeAgentAuthority),
    release: (authority: object) => finishClaudeAgentCall(authority as ClaudeAgentAuthority),
    installation: (runtime: object) => claudeRuntimeInstallation(runtime),
    // An alias answers as its own dated snapshot (`claude-x-y` as `claude-x-y-20261001`); nothing looser.
    sameModel: (requested: string, reported: string) =>
      reported === requested ||
      (reported.startsWith(requested + '-') && /^\d{8}$/.test(reported.slice(requested.length + 1))),
  }),
  issue: (c) => issueNativeCall({ ...c, runtime: c.runtime as NativeClaudeRuntime }),
  call: (authority: object) => nativeClaudeCall(authority as Parameters<typeof nativeClaudeCall>[0]),
  release: (authority: object) => finishNativeCall(authority as Parameters<typeof finishNativeCall>[0]),
  capsTurnDeadline: false,
  releaseGate: Object.freeze({
    open: (settings: SettingsEnvelope, provider: ProviderSettings) =>
      (provider.nativeProfile !== undefined && runnerQualified(provider.nativeProfile.id)) ||
      featureEnabled(settings, 'runner.claude-cli'),
    code: 'sentinel.provider.nativeClaudeDisabled' as const,
    detail: "native Claude execution needs a qualified profile or the owner's runner.claude-cli flag",
  }),
});

const COPILOT_CLI = Object.freeze<CliKind>({
  profileField: 'copilotProfile' as const,
  checkBinding(settings: ProviderSettings, model: ModelSettings, limits: ModelLimits) {
    const p = settings.copilotProfile,
      pinned = p ? copilotProfileById(p.id) : undefined;
    if (
      !p ||
      !pinned ||
      p.executableDigest !== pinned.executableDigest ||
      p.runtimeDigest !== pinned.runtimeDigest ||
      !DIGEST.test(p.profileDigest) ||
      settings.nativeProfile !== undefined ||
      settings.endpoint !== 'https://api.githubcopilot.com' ||
      settings.disclosure !== 'hosted' ||
      settings.credential !== null ||
      model.model !== pinned.model ||
      limits.contextTokens !== pinned.contextReservation ||
      limits.maxRequestBytes > 65536 ||
      limits.maxResponseBytes > 16384 ||
      limits.timeoutMs > 60000 ||
      limits.maxOutputTokens > 512 ||
      limits.maxMessages > 32 ||
      !subscriptionBudget(settings)
    )
      fail('sentinel.provider.invalidProfile', 'the fixed Copilot profile is missing or outside its bounds');
  },
  renderWire: renderNativeCopilotWire,
  async qualify(binding: ProviderBinding) {
    const p = binding.copilotProfile,
      pinned = p ? copilotProfileById(p.id) : undefined;
    if (!p || !pinned)
      return fail('sentinel.provider.capabilityUntested', 'adopted Copilot profile is not a qualified one');
    const runtime = await qualifyInstalledNativeCopilot({ deadlineAt: Date.now() + 5000 }, pinned);
    if (
      runtime.profileId !== p.id ||
      runtime.executableDigest !== p.executableDigest ||
      runtime.runtimeDigest !== p.runtimeDigest ||
      runtime.profileDigest !== p.profileDigest
    )
      fail('sentinel.provider.capabilityUntested', 'adopted Copilot code closure is unavailable or changed');
    return runtime;
  },
  credentialDetail:
    'pinned vendor native keychain capability; shared securityd trust, login unobserved until invocation',
  credentialSource: () => 'vendor' as const,
  mode: (binding: ProviderBinding) => {
    const pinned = binding.copilotProfile ? copilotProfileById(binding.copilotProfile.id) : undefined;
    return pinned ? copilotProfileMode(pinned) : 'brokered';
  },
  agent: Object.freeze({
    issue: (c: Parameters<NonNullable<CliKind['agent']>['issue']>[0]) =>
      issueCopilotAgentCall({
        runtime: c.runtime as NativeCopilotRuntime,
        request: c.request,
        limits: c.limits,
        ledger: c.ledger,
        reservationId: c.reservationId,
        receipt: c.receipt,
      }),
    call: (authority: object) => nativeCopilotAgentCall(authority as CopilotAgentAuthority),
    release: (authority: object) => finishCopilotAgentCall(authority as CopilotAgentAuthority),
    installation: (runtime: object) => copilotRuntimeInstallation(runtime),
  }),
  issue: (c) => issueCopilotCall({ ...c, runtime: c.runtime as Parameters<typeof issueCopilotCall>[0]['runtime'] }),
  call: (authority: object) => nativeCopilotCall(authority as Parameters<typeof nativeCopilotCall>[0]),
  release: (authority: object) => finishCopilotCall(authority as Parameters<typeof finishCopilotCall>[0]),
  sessionBudget: Object.freeze({ maxSteps: 3, deadlineMs: 120000 }),
  capsTurnDeadline: true,
});

const ENTRIES: readonly ProviderKindEntry[] = Object.freeze([
  Object.freeze({
    kind: 'ollama' as const,
    runner: 'hosted-api' as const,
    transport: 'http' as const,
    apiKind: true,
    identitySource: 'host-reported' as const,
    accounting: 'rates-or-no-fee' as const,
    http: OLLAMA_WIRE,
  }),
  Object.freeze({
    kind: 'openai-compatible' as const,
    runner: 'hosted-api' as const,
    transport: 'http' as const,
    apiKind: true,
    identitySource: 'provider-response' as const,
    accounting: 'rates-or-no-fee' as const,
    http: OPENAI_COMPATIBLE_WIRE,
  }),
  Object.freeze({
    kind: 'claude-cli' as const,
    runner: 'claude-cli' as const,
    transport: 'sandboxed-cli' as const,
    apiKind: false,
    identitySource: 'host-reported' as const,
    accounting: 'subscription-quota' as const,
    cli: CLAUDE_CLI,
  }),
  Object.freeze({
    kind: 'copilot-cli' as const,
    runner: 'copilot-cli' as const,
    transport: 'sandboxed-cli' as const,
    apiKind: false,
    identitySource: 'host-reported' as const,
    accounting: 'subscription-quota' as const,
    cli: COPILOT_CLI,
  }),
]);
const BY_KIND = new Map<string, ProviderKindEntry>(ENTRIES.map((e) => [e.kind, e]));

/** Every registered kind, in a fixed order. */
export const PROVIDER_KIND_ENTRIES = ENTRIES;

/** The registered entry for a kind; an unregistered kind is refused, never defaulted. */
export function providerKind(kind: string): ProviderKindEntry {
  return BY_KIND.get(kind) ?? fail('sentinel.provider.invalidProfile', 'unsupported provider kind');
}
/** The HTTP codec for an HTTP kind; a CLI kind has none. */
export function httpKind(
  kind: string,
  detail: string,
  code:
    'sentinel.provider.invalidProfile' | 'sentinel.provider.capabilityUntested' = 'sentinel.provider.invalidProfile',
): HttpKindWire {
  return providerKind(kind).http ?? fail(code, detail);
}
/** The CLI entry for a sandboxed CLI kind, or undefined for an HTTP kind. */
export const cliKind = (kind: string): CliKind | undefined => providerKind(kind).cli;
