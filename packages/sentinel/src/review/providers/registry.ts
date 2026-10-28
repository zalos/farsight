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
import type { ChatMessage, IdentityStrength, ParsedReply } from './kinds.js';
import type { ModelLimits, ProviderBinding, ProviderKind } from './profile.js';
import { OLLAMA_WIRE, OPENAI_COMPATIBLE_WIRE, type HttpKindWire } from './http-kinds.js';
import {
  issueCopilotCall,
  issueNativeCall,
  finishCopilotCall,
  finishNativeCall,
  type NativeLimits,
} from './authority.js';
import { COPILOT_NATIVE_PROFILE, qualifyInstalledNativeCopilot } from './cli-copilot-profile.js';
import { nativeCopilotCall } from './cli-copilot-call.js';
import { renderNativeCopilotWire } from './cli-copilot-wire.js';
import {
  CLAUDE_NATIVE_PROFILE,
  nativeRuntimeHelper,
  qualifyInstalledNativeClaude,
  type NativeClaudeRuntime,
} from './cli-native-profile.js';
import { nativeClaudeCall } from './cli-native-call.js';
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
  /** A release gate the adopted settings must open before a stage may select this CLI. */
  readonly releaseGate?: Readonly<{
    open(settings: SettingsEnvelope): boolean;
    code: 'sentinel.provider.nativeClaudeDisabled';
    detail: string;
  }>;
}

export interface ProviderKindEntry {
  readonly kind: ProviderKind;
  readonly transport: 'http' | 'sandboxed-cli';
  /** An HTTP API kind: a hosted one is refused unless the adopted `hostedApiReviewEnabled` is on. CLIs are not. */
  readonly apiKind: boolean;
  /** Who reports the answering model's identity. */
  readonly identitySource: IdentityStrength;
  /** Money: a native subscription records tokens and `unobserved` money; HTTP kinds record rates or no fee. */
  readonly accounting: 'rates-or-no-fee' | 'subscription-quota';
  readonly http?: HttpKindWire;
  readonly cli?: CliKind;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const subscriptionBudget = (s: ProviderSettings) =>
  s.budget.maxTokens !== null && s.budget.maxCost === null && s.budget.currency === null;

const CLAUDE_CLI = Object.freeze<CliKind>({
  profileField: 'nativeProfile' as const,
  checkBinding(settings: ProviderSettings, model: ModelSettings, limits: ModelLimits) {
    const p = settings.nativeProfile;
    if (
      !p ||
      p.id !== CLAUDE_NATIVE_PROFILE.id ||
      p.executableDigest !== CLAUDE_NATIVE_PROFILE.executableDigest ||
      !DIGEST.test(p.helperDigest) ||
      !DIGEST.test(p.profileDigest) ||
      settings.endpoint !== 'https://api.anthropic.com' ||
      settings.disclosure !== 'hosted' ||
      settings.credential !== null ||
      model.model !== 'claude-haiku-4-5-20251001' ||
      limits.contextTokens !== 200000 ||
      limits.maxRequestBytes > 65536 ||
      limits.maxOutputTokens > 4096 ||
      limits.maxMessages > 32 ||
      !subscriptionBudget(settings)
    )
      fail('sentinel.provider.invalidProfile', 'the adopted native CLI profile is missing or outside its fixed bounds');
  },
  renderWire: renderNativeClaudeWire,
  async qualify(binding: ProviderBinding, given: { nativeClaude?: NativeClaudeRuntime }) {
    const runtime = given.nativeClaude ?? (await qualifyInstalledNativeClaude({ deadlineAt: Date.now() + 5000 }));
    const p = binding.nativeProfile;
    if (
      !p ||
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
  issue: (c) => issueNativeCall({ ...c, runtime: c.runtime as NativeClaudeRuntime }),
  call: (authority: object) => nativeClaudeCall(authority as Parameters<typeof nativeClaudeCall>[0]),
  release: (authority: object) => finishNativeCall(authority as Parameters<typeof finishNativeCall>[0]),
  capsTurnDeadline: false,
  releaseGate: Object.freeze({
    open: (settings: SettingsEnvelope) => settings.nativeClaudeReviewEnabled === true,
    code: 'sentinel.provider.nativeClaudeDisabled' as const,
    detail: 'native Claude execution is deferred until separately enabled and qualified',
  }),
});

const COPILOT_CLI = Object.freeze<CliKind>({
  profileField: 'copilotProfile' as const,
  checkBinding(settings: ProviderSettings, model: ModelSettings, limits: ModelLimits) {
    const p = settings.copilotProfile;
    if (
      !p ||
      p.id !== COPILOT_NATIVE_PROFILE.id ||
      p.executableDigest !== COPILOT_NATIVE_PROFILE.executableDigest ||
      p.runtimeDigest !== COPILOT_NATIVE_PROFILE.runtimeDigest ||
      !DIGEST.test(p.profileDigest) ||
      settings.nativeProfile !== undefined ||
      settings.endpoint !== 'https://api.githubcopilot.com' ||
      settings.disclosure !== 'hosted' ||
      settings.credential !== null ||
      model.model !== COPILOT_NATIVE_PROFILE.model ||
      limits.contextTokens !== COPILOT_NATIVE_PROFILE.contextReservation ||
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
    const runtime = await qualifyInstalledNativeCopilot({ deadlineAt: Date.now() + 5000 });
    const p = binding.copilotProfile;
    if (
      !p ||
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
  issue: (c) => issueCopilotCall({ ...c, runtime: c.runtime as Parameters<typeof issueCopilotCall>[0]['runtime'] }),
  call: (authority: object) => nativeCopilotCall(authority as Parameters<typeof nativeCopilotCall>[0]),
  release: (authority: object) => finishCopilotCall(authority as Parameters<typeof finishCopilotCall>[0]),
  sessionBudget: Object.freeze({ maxSteps: 3, deadlineMs: 120000 }),
  capsTurnDeadline: true,
});

const ENTRIES: readonly ProviderKindEntry[] = Object.freeze([
  Object.freeze({
    kind: 'ollama' as const,
    transport: 'http' as const,
    apiKind: true,
    identitySource: 'host-reported' as const,
    accounting: 'rates-or-no-fee' as const,
    http: OLLAMA_WIRE,
  }),
  Object.freeze({
    kind: 'openai-compatible' as const,
    transport: 'http' as const,
    apiKind: true,
    identitySource: 'provider-response' as const,
    accounting: 'rates-or-no-fee' as const,
    http: OPENAI_COMPATIBLE_WIRE,
  }),
  Object.freeze({
    kind: 'claude-cli' as const,
    transport: 'sandboxed-cli' as const,
    apiKind: false,
    identitySource: 'host-reported' as const,
    accounting: 'subscription-quota' as const,
    cli: CLAUDE_CLI,
  }),
  Object.freeze({
    kind: 'copilot-cli' as const,
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
