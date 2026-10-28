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
  StageCost,
} from '../../contracts/index.js';
import { canonicalDigest } from '../../policy/digest.js';
import { snapshot } from '../../policy/immutable.js';
import { isEffectivePolicy, type EffectivePolicy } from '../../policy/settings.js';
import { costOf, fromNanos, toNanos } from './decimal.js';
import { fail } from './errors.js';
import { PROVIDER_KIND_ENTRIES, providerKind } from './registry.js';

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

  const kind = providerKind(settings.kind);
  const native = kind.accounting === 'subscription-quota';
  // A CLI's code pin belongs to its own kind only; then that CLI's fixed bounds.
  for (const other of PROVIDER_KIND_ENTRIES)
    if (other.cli && other.kind !== settings.kind && settings[other.cli.profileField] !== undefined)
      fail('sentinel.provider.invalidProfile', 'a native CLI code pin belongs only to its own fixed kind');
  kind.cli?.checkBinding(settings, profile, limits);
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

/**
 * What confirmed usage cost under a binding's pricing, as a stage's provenance states it (`StageCost`). Each call is
 * priced as the broker settles it in the ledger, then summed, so a rates amount is the amount the ledger holds. A
 * subscription CLI reports tokens and never a price, and a local runtime has no rates: both are unobserved, never zero.
 * A call that may have been charged without its usage (`unsettled`) leaves the cost unknown, whatever the pricing.
 */
export function stageCostOf(
  binding: ProviderBinding,
  usage: readonly Readonly<{ inputTokens: number; outputTokens: number }>[],
  unsettled: boolean,
): StageCost {
  if (!isProviderBinding(binding)) fail('sentinel.provider.notTrusted', 'the cost requires a genuine binding');
  if (unsettled) return Object.freeze({ basis: 'unobserved' as const, reason: 'usage-unknown' as const });
  const p = binding.pricing;
  if (p.kind === 'subscription-quota')
    return Object.freeze({ basis: 'unobserved' as const, reason: 'subscription' as const });
  if (p.kind !== 'rates') return Object.freeze({ basis: 'unobserved' as const, reason: 'no-rates' as const });
  const input = toNanos(p.inputPerMillion)!,
    output = toNanos(p.outputPerMillion)!;
  const nanos = usage.reduce((n, u) => n + costOf(u.inputTokens, input) + costOf(u.outputTokens, output), 0n);
  return Object.freeze({ basis: 'rates' as const, amount: fromNanos(nanos), currency: p.currency });
}
