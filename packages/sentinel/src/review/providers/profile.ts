// A model profile and the trusted provider binding it yields (PR 21). The adopted settings name a provider's kind,
// origin, credential reference, disclosure and per-action budget; the profile adds what a call needs: the model to
// ask for, hard limits, a price (or an explicit local no-fee basis), recorded hosted terms and the capability record
// a probe of this exact origin produced. `bindProvider` checks them together and returns a frozen binding whose
// digest is the `input` an owner receipt confirms, so a changed origin, credential, disclosure, model, limit, price,
// term or capability needs a new confirmation. Nothing here contacts a provider or reads a credential.
import type {
  Digest,
  EndpointOrigin,
  Id,
  KeychainRef,
  ModelCapability,
  ModelLimits as ContractModelLimits,
  ModelPricing as ContractModelPricing,
  ModelSettings,
  ProviderSettings,
  ProviderTerms as ContractProviderTerms,
} from '../../contracts/index.js';
import { canonicalDigest } from '../../policy/digest.js';
import { snapshot } from '../../policy/immutable.js';
import { isEffectivePolicy, type EffectivePolicy } from '../../policy/settings.js';
import { toNanos } from './decimal.js';
import { fail } from './errors.js';
import { COPILOT_NATIVE_PROFILE } from './cli-copilot-profile.js';
import { CLAUDE_NATIVE_PROFILE } from './cli-native-profile.js';

export type ProviderKind = ProviderSettings['kind'];

/** Contract types (`contracts/policy.ts`): the model configuration lives in the adopted settings. */
export type ModelLimits = ContractModelLimits;
export type ModelPricing = ContractModelPricing;
export type ProviderTerms = ContractProviderTerms;
export type CapabilityRecord = ModelCapability;
export type ModelProfile = ModelSettings;

/** Audit data sampled from a current genuine binding; never a capability or admission input. */
export interface ProviderSelection {
  readonly providerId: Id;
  readonly modelId: Id;
  readonly bindingDigest: Digest;
}

/** The checked, frozen union of the adopted provider and one of its models. Only `bindProvider` makes one. */
export interface ProviderBinding {
  readonly providerId: Id;
  /** The model's id in the adopted settings. */
  readonly modelId: Id;
  readonly kind: ProviderKind;
  readonly origin: EndpointOrigin;
  readonly credential: KeychainRef | null;
  readonly nativeProfile?: ProviderSettings['nativeProfile'];
  readonly copilotProfile?: ProviderSettings['copilotProfile'];
  readonly disclosure: 'local-only' | 'hosted';
  readonly model: string;
  readonly limits: ModelLimits;
  readonly pricing: ModelPricing;
  readonly terms: ProviderTerms | null;
  readonly capability: CapabilityRecord;
  /** The provider's per-action budget from the adopted settings. */
  readonly settingsBudget: ProviderSettings['budget'];
  /** Canonical digest of everything above: what an owner receipt's intent names as its input. */
  readonly digest: string;
  /** The policy revision the binding was checked under. */
  readonly policyRevision: string;
}

/** The most a profile may set; a request may only lower them. */
export const LIMIT_CEILINGS: Readonly<ModelLimits> = Object.freeze({
  maxRequestBytes: 4 * 1024 * 1024,
  maxResponseBytes: 4 * 1024 * 1024,
  timeoutMs: 600_000,
  maxOutputTokens: 131_072,
  contextTokens: 2_000_000,
  maxMessages: 256,
  templateTokensPerMessage: 1024,
});

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z)?$/;
const text = (v: unknown, max = 500) =>
  // eslint-disable-next-line no-control-regex -- Provider profile text must exclude control characters.
  typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const LOOPBACK = new Set(['127.0.0.1', '[::1]']);

const bindings = new WeakSet<object>();
export const isProviderBinding = (v: unknown): v is ProviderBinding =>
  typeof v === 'object' && v !== null && bindings.has(v);

/** The origin rule: local-only means a literal loopback address; hosted means TLS. */
export function checkOrigin(origin: string, disclosure: 'local-only' | 'hosted'): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return fail('sentinel.provider.originRefused', 'not an origin');
  }
  if (url.origin !== origin || url.username || url.password)
    fail('sentinel.provider.originRefused', 'an origin has no path, query or user part');
  if (disclosure === 'local-only' && !LOOPBACK.has(url.hostname)) {
    fail(
      'sentinel.provider.originRefused',
      'a local-only provider must be 127.0.0.1 or [::1], not a name that could resolve elsewhere',
    );
  }
  if (disclosure === 'hosted' && url.protocol !== 'https:')
    fail('sentinel.provider.originRefused', 'a hosted provider must use https');
}

function checkLimits(l: unknown): ModelLimits {
  if (!l || typeof l !== 'object') return fail('sentinel.provider.invalidProfile', 'limits are required');
  const out = {} as Record<keyof ModelLimits, number>;
  for (const k of Object.keys(LIMIT_CEILINGS) as (keyof ModelLimits)[]) {
    const v = (l as Record<string, unknown>)[k];
    const min = k === 'templateTokensPerMessage' ? 0 : 1;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > LIMIT_CEILINGS[k]) {
      fail('sentinel.provider.invalidProfile', `limits.${k} must be an integer from ${min} to ${LIMIT_CEILINGS[k]}`);
    }
    out[k] = v as number;
  }
  if (Object.keys(l).some((k) => !(k in LIMIT_CEILINGS)))
    fail('sentinel.provider.invalidProfile', 'limits hold an unknown key');
  if (out.maxOutputTokens >= out.contextTokens)
    fail('sentinel.provider.invalidProfile', 'the output allowance must leave room for input in the context');
  return out;
}

/**
 * Binds one model the owner configured in the adopted settings (`providers[].models[]`). Refuses a provider or model
 * the adopted settings do not define, an origin that breaks the disclosure rule, a no-fee model that is not local, a
 * hosted model without recorded terms, and a model whose capability record is missing or for another kind, origin or
 * model. The caller names ids only; every term comes from the adopted settings.
 */
export function bindProvider(policy: EffectivePolicy, providerId: string, modelId: string): ProviderBinding {
  if (!isEffectivePolicy(policy))
    fail('sentinel.provider.notTrusted', 'a binding is made only under effectivePolicy\u2019s own result');
  const settings = policy.settings.providers.find((p) => p.id === providerId);
  if (!settings) return fail('sentinel.provider.notTrusted', 'the adopted settings define no such provider');
  const profile = (settings.models ?? []).find((m) => m.id === modelId);
  if (!profile)
    return fail('sentinel.provider.notTrusted', 'the adopted settings define no such model for this provider');
  if (typeof profile.model !== 'string' || !MODEL.test(profile.model))
    fail('sentinel.provider.invalidProfile', 'the model name is missing or outside the allowed characters');
  const limits = checkLimits(profile.limits);
  checkOrigin(settings.endpoint, settings.disclosure);

  const native = settings.kind === 'claude-cli' || settings.kind === 'copilot-cli';
  if (settings.kind === 'claude-cli') {
    const p = settings.nativeProfile;
    if (
      !p ||
      p.id !== CLAUDE_NATIVE_PROFILE.id ||
      p.executableDigest !== CLAUDE_NATIVE_PROFILE.executableDigest ||
      !/^sha256:[a-f0-9]{64}$/.test(p.helperDigest) ||
      !/^sha256:[a-f0-9]{64}$/.test(p.profileDigest) ||
      settings.endpoint !== 'https://api.anthropic.com' ||
      settings.disclosure !== 'hosted' ||
      settings.credential !== null ||
      profile.model !== 'claude-haiku-4-5-20251001' ||
      limits.contextTokens !== 200000 ||
      limits.maxRequestBytes > 65536 ||
      limits.maxOutputTokens > 4096 ||
      limits.maxMessages > 32 ||
      settings.budget.maxTokens === null ||
      settings.budget.maxCost !== null ||
      settings.budget.currency !== null
    ) {
      fail('sentinel.provider.invalidProfile', 'the adopted native CLI profile is missing or outside its fixed bounds');
    }
  } else if (settings.nativeProfile !== undefined)
    fail('sentinel.provider.invalidProfile', 'native profile belongs only to the fixed CLI kind');
  if (settings.kind === 'copilot-cli') {
    const p = settings.copilotProfile;
    if (
      !p ||
      p.id !== COPILOT_NATIVE_PROFILE.id ||
      p.executableDigest !== COPILOT_NATIVE_PROFILE.executableDigest ||
      p.runtimeDigest !== COPILOT_NATIVE_PROFILE.runtimeDigest ||
      !/^sha256:[a-f0-9]{64}$/.test(p.profileDigest) ||
      settings.nativeProfile !== undefined ||
      settings.endpoint !== 'https://api.githubcopilot.com' ||
      settings.disclosure !== 'hosted' ||
      settings.credential !== null ||
      profile.model !== COPILOT_NATIVE_PROFILE.model ||
      limits.contextTokens !== COPILOT_NATIVE_PROFILE.contextReservation ||
      limits.maxRequestBytes > 65536 ||
      limits.maxResponseBytes > 16384 ||
      limits.timeoutMs > 60000 ||
      limits.maxOutputTokens > 512 ||
      limits.maxMessages > 32 ||
      settings.budget.maxTokens === null ||
      settings.budget.maxCost !== null ||
      settings.budget.currency !== null
    )
      fail('sentinel.provider.invalidProfile', 'the fixed Copilot profile is missing or outside its bounds');
  } else if (settings.copilotProfile !== undefined)
    fail('sentinel.provider.invalidProfile', 'Copilot code identity belongs only to its fixed kind');
  const pricing = profile.pricing;
  if (pricing === null || pricing === undefined)
    return fail('sentinel.provider.unpriced', 'the model gives no rate schedule and no local no-fee basis');
  if (pricing.kind === 'no-fee') {
    if (pricing.basis !== 'local-runtime' || settings.disclosure !== 'local-only')
      fail('sentinel.provider.unpriced', 'only a local-only provider may declare no fee');
  } else if (pricing.kind === 'rates') {
    if (toNanos(pricing.inputPerMillion) === null || toNanos(pricing.outputPerMillion) === null)
      fail('sentinel.provider.invalidProfile', 'rates are decimal amounts');
    if (!/^[A-Z]{3}$/.test(pricing.currency) || pricing.currency !== settings.budget.currency)
      fail('sentinel.provider.invalidProfile', 'the rate currency must be the provider budget\u2019s');
    if (!text(pricing.source) || !DATE.test(String(pricing.asOf)))
      fail('sentinel.provider.invalidProfile', 'a rate schedule names its source and date');
  } else if (pricing.kind === 'subscription-quota') {
    if (!native || pricing.basis !== 'owner-subscription')
      fail('sentinel.provider.unpriced', 'subscription quota belongs only to the adopted native CLI');
  } else {
    fail('sentinel.provider.invalidProfile', 'unknown pricing kind');
  }

  if (native && pricing.kind !== 'subscription-quota')
    fail('sentinel.provider.unpriced', 'native CLI requires explicit subscription quota');
  const terms = profile.terms ?? null;
  if (settings.disclosure === 'hosted') {
    if (
      !terms ||
      !text(terms.retention) ||
      !['not-used', 'used', 'unknown'].includes(terms.training) ||
      !text(terms.source) ||
      !DATE.test(String(terms.recordedAt))
    ) {
      fail('sentinel.provider.termsRequired', 'retention, training use, their source and the date they were read');
    }
  }

  const cap = profile.capability;
  if (!cap) return fail('sentinel.provider.capabilityUntested', 'no capability record in the adopted settings');
  if (
    cap.schema !== 'sentinel-model-capability/draft-1' ||
    cap.kind !== settings.kind ||
    cap.origin !== settings.endpoint ||
    cap.model !== profile.model ||
    cap.listed !== true
  ) {
    fail('sentinel.provider.capabilityUntested', 'the capability record is for another kind, origin or model');
  }

  const body = {
    providerId: settings.id,
    modelId: profile.id,
    kind: settings.kind,
    origin: settings.endpoint,
    credential: settings.credential,
    ...(settings.nativeProfile ? { nativeProfile: settings.nativeProfile } : {}),
    ...(settings.copilotProfile ? { copilotProfile: settings.copilotProfile } : {}),
    disclosure: settings.disclosure,
    model: profile.model,
    limits,
    pricing,
    terms,
    capability: cap,
    settingsBudget: settings.budget,
  };
  const binding: ProviderBinding = snapshot({
    ...body,
    digest: canonicalDigest(body),
    policyRevision: policy.revision,
  });
  bindings.add(binding);
  return binding;
}
