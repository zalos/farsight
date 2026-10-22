// A model profile and the trusted provider binding it yields (PR 21). The adopted settings name a provider's kind,
// origin, credential reference, disclosure and per-action budget; the profile adds what a call needs: the model to
// ask for, hard limits, a price (or an explicit local no-fee basis), recorded hosted terms and the capability record
// a probe of this exact origin produced. `bindProvider` checks them together and returns a frozen binding whose
// digest is the `input` an owner receipt confirms, so a changed origin, credential, disclosure, model, limit, price,
// term or capability needs a new confirmation. Nothing here contacts a provider or reads a credential.
import type { EndpointOrigin, Id, KeychainRef, ProviderSettings } from '../../contracts/index.js';
import { canonicalDigest } from '../../policy/digest.js';
import { snapshot } from '../../policy/immutable.js';
import { isEffectivePolicy, type EffectivePolicy } from '../../policy/settings.js';
import { toNanos } from './decimal.js';
import { fail } from './errors.js';

export type ProviderKind = ProviderSettings['kind'];

export interface ModelLimits {
  /** The serialized request, every message included. */
  readonly maxRequestBytes: number;
  /** The response body as read; reading stops past it. */
  readonly maxResponseBytes: number;
  /** One call, connect to last byte. */
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  /** The context the model is run with: worst-case input plus output must fit, so nothing is cut silently. */
  readonly contextTokens: number;
  readonly maxMessages: number;
  /**
   * Tokens a provider's chat template may add per message, beyond the bytes sent. Part of the worst-case input
   * bound; a provider that reports more than the reservation is an overrun, recorded, never absorbed.
   */
  readonly templateTokensPerMessage: number;
}

/** How spend is priced. `null` (no price) is refused: an unpriced call cannot be bounded. */
export type ModelPricing =
  | {
      readonly kind: 'rates';
      /** ISO 4217; must equal the provider budget's currency. */
      readonly currency: string;
      /** DecimalAmount per million input / output tokens. */
      readonly inputPerMillion: string;
      readonly outputPerMillion: string;
      /** Where the owner read the rate schedule, and when. */
      readonly source: string;
      readonly asOf: string;
    }
  /** Local runtimes only: no provider fee. Compute is not claimed free; tokens are still reserved. */
  | { readonly kind: 'no-fee'; readonly basis: 'local-runtime' };

/** A hosted provider's recorded terms. Endpoint-specific facts the owner read, never a promise of the protocol. */
export interface ProviderTerms {
  readonly retention: string;
  readonly training: 'not-used' | 'used' | 'unknown';
  readonly source: string;
  readonly recordedAt: string;
}

/** What a probe of this origin found for this model. Produced by `probeCapability`, stored by the trusted caller. */
export interface CapabilityRecord {
  readonly schema: 'sentinel-model-capability/draft-1';
  readonly kind: ProviderKind;
  readonly origin: EndpointOrigin;
  readonly model: string;
  /** The model was listed by the provider at `probedAt`. */
  readonly listed: true;
  /** An immutable revision the provider listed for it (Ollama's weight digest), else null. */
  readonly revision: string | null;
  readonly probedAt: string;
}

export interface ModelProfile {
  readonly providerId: Id;
  readonly kind: ProviderKind;
  readonly model: string;
  readonly limits: ModelLimits;
  readonly pricing: ModelPricing | null;
  /** Required when the provider's disclosure is `hosted`. */
  readonly terms: ProviderTerms | null;
  readonly capability: CapabilityRecord | null;
}

/** The checked, frozen union of the adopted provider settings and the profile. Only `bindProvider` makes one. */
export interface ProviderBinding {
  readonly providerId: Id;
  readonly kind: ProviderKind;
  readonly origin: EndpointOrigin;
  readonly credential: KeychainRef | null;
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
  maxRequestBytes: 4 * 1024 * 1024, maxResponseBytes: 4 * 1024 * 1024, timeoutMs: 600_000, maxOutputTokens: 131_072,
  contextTokens: 2_000_000, maxMessages: 256, templateTokensPerMessage: 1024,
});

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z)?$/;
const text = (v: unknown, max = 500) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const LOOPBACK = new Set(['127.0.0.1', '[::1]']);

const bindings = new WeakSet<object>();
export const isProviderBinding = (v: unknown): v is ProviderBinding => typeof v === 'object' && v !== null && bindings.has(v);

/** The origin rule: local-only means a literal loopback address; hosted means TLS. */
export function checkOrigin(origin: string, disclosure: 'local-only' | 'hosted'): void {
  let url: URL;
  try { url = new URL(origin); } catch { return fail('sentinel.provider.originRefused', 'not an origin'); }
  if (url.origin !== origin || url.username || url.password) fail('sentinel.provider.originRefused', 'an origin has no path, query or user part');
  if (disclosure === 'local-only' && !LOOPBACK.has(url.hostname)) {
    fail('sentinel.provider.originRefused', 'a local-only provider must be 127.0.0.1 or [::1], not a name that could resolve elsewhere');
  }
  if (disclosure === 'hosted' && url.protocol !== 'https:') fail('sentinel.provider.originRefused', 'a hosted provider must use https');
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
  if (Object.keys(l).some(k => !(k in LIMIT_CEILINGS))) fail('sentinel.provider.invalidProfile', 'limits hold an unknown key');
  if (out.maxOutputTokens >= out.contextTokens) fail('sentinel.provider.invalidProfile', 'the output allowance must leave room for input in the context');
  return out;
}

/**
 * Checks the profile against the adopted provider and returns the binding. Refuses a provider the adopted settings
 * do not define, a kind or origin that disagrees, an unpriced profile, a no-fee profile that is not local, a hosted
 * provider without recorded terms, and a capability record for another kind, origin or model.
 */
export function bindProvider(policy: EffectivePolicy, given: ModelProfile): ProviderBinding {
  if (!isEffectivePolicy(policy)) fail('sentinel.provider.notTrusted', 'a binding is made only under effectivePolicy’s own result');
  const profile = snapshot(given);
  if (!profile || typeof profile !== 'object') return fail('sentinel.provider.invalidProfile', 'a profile is required');
  const settings = policy.settings.providers.find(p => p.id === profile.providerId);
  if (!settings) return fail('sentinel.provider.notTrusted', `no provider "${String(profile.providerId).slice(0, 64)}"`);
  if (settings.kind !== profile.kind) fail('sentinel.provider.notTrusted', 'the profile names another provider kind than the settings');
  if (typeof profile.model !== 'string' || !MODEL.test(profile.model)) fail('sentinel.provider.invalidProfile', 'the model name is missing or outside the allowed characters');
  const limits = checkLimits(profile.limits);
  checkOrigin(settings.endpoint, settings.disclosure);

  const pricing = profile.pricing;
  if (pricing === null || pricing === undefined) return fail('sentinel.provider.unpriced', 'the profile gives no rate schedule and no local no-fee basis');
  if (pricing.kind === 'no-fee') {
    if (pricing.basis !== 'local-runtime' || settings.disclosure !== 'local-only') fail('sentinel.provider.unpriced', 'only a local-only provider may declare no fee');
  } else if (pricing.kind === 'rates') {
    if (toNanos(pricing.inputPerMillion) === null || toNanos(pricing.outputPerMillion) === null) fail('sentinel.provider.invalidProfile', 'rates are decimal amounts');
    if (!/^[A-Z]{3}$/.test(pricing.currency) || pricing.currency !== settings.budget.currency) fail('sentinel.provider.invalidProfile', 'the rate currency must be the provider budget’s');
    if (!text(pricing.source) || !DATE.test(String(pricing.asOf))) fail('sentinel.provider.invalidProfile', 'a rate schedule names its source and date');
  } else {
    fail('sentinel.provider.invalidProfile', 'unknown pricing kind');
  }

  const terms = profile.terms ?? null;
  if (settings.disclosure === 'hosted') {
    if (!terms || !text(terms.retention) || !['not-used', 'used', 'unknown'].includes(terms.training) || !text(terms.source) || !DATE.test(String(terms.recordedAt))) {
      fail('sentinel.provider.termsRequired', 'retention, training use, their source and the date they were read');
    }
  }

  const cap = profile.capability;
  if (!cap) return fail('sentinel.provider.capabilityUntested', 'no capability record');
  if (cap.schema !== 'sentinel-model-capability/draft-1' || cap.kind !== settings.kind || cap.origin !== settings.endpoint || cap.model !== profile.model || cap.listed !== true) {
    fail('sentinel.provider.capabilityUntested', 'the capability record is for another kind, origin or model');
  }

  const body = {
    providerId: settings.id, kind: settings.kind, origin: settings.endpoint, credential: settings.credential,
    disclosure: settings.disclosure, model: profile.model, limits, pricing, terms, capability: cap, settingsBudget: settings.budget,
  };
  const binding: ProviderBinding = snapshot({ ...body, digest: canonicalDigest(body), policyRevision: policy.revision });
  bindings.add(binding);
  return binding;
}
