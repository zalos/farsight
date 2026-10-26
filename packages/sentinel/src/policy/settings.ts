// Trusted settings and repository requests, parsed strictly, and the one merge that yields the effective policy.
//
// The repository requests; adopted settings grant. The effective rule set is the owner's mandatory rules united
// with the repository's requested rules, so removing or disabling a mandatory rule in the repository changes
// nothing. Thresholds take the stricter side of each field. A suppression request, a weaker threshold and a
// provider the settings do not define are recorded as refused requests, never applied. Untrusted settings (missing,
// not adopted, changed or invalid) fall back to the built-in defaults, which grant nothing.
import { containsCredentialShape } from '@farsight/core/dist/credential-shapes.js';
import type {
  EffectivePolicyEnvelope,
  PolicyThresholds,
  RefusedRequest,
  RepoConfigEnvelope,
  SettingsEnvelope,
  SettingsTrust,
  Severity,
} from '../contracts/index.js';
import { SEVERITIES } from '../contracts/index.js';
import { validateEnvelope } from '../validate.js';
import { canonicalDigest } from './digest.js';
import { policyFail } from './errors.js';
import { deepFreeze, snapshot } from './immutable.js';

/** The largest settings or repository config file read. */
export const MAX_SETTINGS_BYTES = 256 * 1024;

/**
 * What applies when no adopted settings exist: no grants, no providers, agents always wait for a person, findings
 * from medium up fail, and required coverage must complete. A repository can only make this stricter.
 */
export const DEFAULT_SETTINGS: SettingsEnvelope = deepFreeze<SettingsEnvelope>({
  schema: 'sentinel-settings/draft-1',
  mandatoryRules: [],
  thresholds: { failOnSeverity: 'medium', requireCompleteCoverage: true, requiredCapabilities: [] },
  grants: [],
  agentActions: 'confirm',
  providers: [],
});

function decode(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return policyFail('sentinel.policy.settingsInvalid', 'not UTF-8 JSON');
  }
}

/** Every string in the value except the named keychain-reference fields. */
function* strings(value: unknown, path: string, skip: (path: string) => boolean): Generator<[string, string]> {
  if (typeof value === 'string') {
    if (!skip(path)) yield [path, value];
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* strings(value[i], `${path}/${i}`, skip);
    return;
  }
  if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) yield* strings(v, `${path}/${k}`, skip);
}

/** Parses settings bytes. A secret-shaped value anywhere but a keychain field is refused without echoing it. */
export function parseSettings(bytes: Uint8Array): SettingsEnvelope {
  const value = decode(bytes);
  const checked = validateEnvelope('settings', value);
  if (!checked.ok)
    return policyFail(
      'sentinel.policy.settingsInvalid',
      `${checked.errors[0]?.path || '/'}: ${checked.errors[0]?.message ?? 'invalid'}`,
    );
  // Only schema-validated native identity digests are metadata. Preserve the real settings bytes; filter an elided clone.
  const secretView = structuredClone(checked.value);
  for (const provider of secretView.providers)
    if (provider.kind === 'claude-cli' && provider.nativeProfile) {
      const pins = provider.nativeProfile as unknown as Record<string, unknown>;
      for (const key of ['executableDigest', 'helperDigest', 'profileDigest'])
        if (typeof pins[key] === 'string' && /^sha256:[a-f0-9]{64}$/.test(pins[key] as string)) delete pins[key];
    }
  for (const provider of secretView.providers)
    if (provider.kind === 'copilot-cli' && provider.copilotProfile) {
      const pins = provider.copilotProfile as unknown as Record<string, unknown>;
      for (const key of ['executableDigest', 'runtimeDigest', 'profileDigest'])
        if (typeof pins[key] === 'string' && /^sha256:[a-f0-9]{64}$/.test(pins[key] as string)) delete pins[key];
    }
  for (const [path, text] of strings(secretView, '', (p) => /^\/providers\/\d+\/credential$/.test(p))) {
    if (containsCredentialShape(text))
      policyFail(
        'sentinel.policy.credentialValue',
        `${path} holds a value shaped like a credential; settings hold keychain references only`,
      );
  }
  return checked.value;
}

/** Parses repository scan intent. It is a request, so it is validated but never trusted. */
export function parseRepoConfig(bytes: Uint8Array): RepoConfigEnvelope {
  const checked = validateEnvelope('repoconfig', decode(bytes));
  if (!checked.ok)
    return policyFail(
      'sentinel.policy.settingsInvalid',
      `${checked.errors[0]?.path || '/'}: ${checked.errors[0]?.message ?? 'invalid'}`,
    );
  return checked.value;
}

const rank = (s: Severity) => SEVERITIES.indexOf(s);

/** The effective policy, with the settings that produced it. `settings` is used for admission, never served. */
export interface EffectivePolicy {
  readonly settings: SettingsEnvelope;
  readonly thresholds: PolicyThresholds;
  readonly rules: readonly string[];
  /** The redacted view: the only policy any surface returns. */
  readonly view: EffectivePolicyEnvelope;
  /**
   * Digest of the complete trusted snapshot (the settings in effect and the view): what a receipt and an admission
   * name as the policy they were decided under. Any grant, provider or budget difference changes it.
   */
  readonly revision: string;
}

const effective = new WeakSet<object>();

/** True only for an object `effectivePolicy` returned in this process: admission accepts nothing else. */
export function isEffectivePolicy(value: unknown): value is EffectivePolicy {
  return typeof value === 'object' && value !== null && effective.has(value);
}

export interface PolicyInputs {
  trust: SettingsTrust;
  /** Adopted settings only; anything else is ignored and the defaults apply. */
  settings: SettingsEnvelope | null;
  settingsDigest: string | null;
  repoConfig: RepoConfigEnvelope | null;
  repoConfigDigest: string | null;
}

/**
 * The effective policy as one immutable snapshot: the inputs are deep-copied before anything is read, and the result
 * (settings in effect, thresholds, rules, view) is deep-frozen and recognised by `isEffectivePolicy`, so changing the
 * caller's settings afterwards, or anything reachable from the result, cannot change what admission decides.
 */
export function effectivePolicy(given: PolicyInputs): EffectivePolicy {
  const inputs = snapshot(given);
  // `adopted` without settings bytes is not a trust state anyone can hold: it is reported as invalid.
  const trust: SettingsTrust =
    inputs.trust === 'adopted' && (!inputs.settings || !inputs.settingsDigest) ? 'invalid' : inputs.trust;
  const trusted: SettingsEnvelope = trust === 'adopted' ? inputs.settings! : snapshot(DEFAULT_SETTINGS);
  const repo = inputs.repoConfig;
  const refused: RefusedRequest[] = [];

  const mandatory = new Set(trusted.mandatoryRules);
  const requested = new Set(repo?.requestedRules ?? []);
  for (const r of repo?.disabledRules ?? []) {
    if (mandatory.has(r))
      refused.push({ request: 'disable-rule', subject: r, reasonCode: 'sentinel.policy.mandatoryRuleKept' });
    requested.delete(r);
  }
  const rules = [...new Set([...mandatory, ...requested])].sort();

  const t = trusted.thresholds;
  const want = repo?.thresholds ?? {};
  let failOnSeverity = t.failOnSeverity;
  if (want.failOnSeverity !== undefined) {
    if (rank(want.failOnSeverity) <= rank(t.failOnSeverity)) failOnSeverity = want.failOnSeverity;
    else
      refused.push({
        request: 'weaken-threshold',
        subject: 'failOnSeverity',
        reasonCode: 'sentinel.policy.thresholdNotWeakened',
      });
  }
  if (want.requireCompleteCoverage === false && t.requireCompleteCoverage) {
    refused.push({
      request: 'weaken-threshold',
      subject: 'requireCompleteCoverage',
      reasonCode: 'sentinel.policy.thresholdNotWeakened',
    });
  }
  const thresholds: PolicyThresholds = {
    failOnSeverity,
    requireCompleteCoverage: t.requireCompleteCoverage || want.requireCompleteCoverage === true,
    requiredCapabilities: [...new Set([...t.requiredCapabilities, ...(want.requiredCapabilities ?? [])])].sort(),
  };

  for (const s of repo?.suppressions ?? []) {
    refused.push({
      request: 'suppression',
      subject: `${s.familyId} ${s.scopeId}`.slice(0, 200),
      reasonCode: 'sentinel.policy.suppressionNotApproved',
    });
  }
  const providers = new Set(trusted.providers.map((p) => p.id));
  for (const p of repo?.providers ?? []) {
    if (!providers.has(p))
      refused.push({ request: 'provider', subject: p, reasonCode: 'sentinel.policy.providerNotTrusted' });
  }

  const view: EffectivePolicyEnvelope = {
    schema: 'sentinel-policy/draft-1',
    settingsTrust: trust,
    ...(trusted.hostedReviewSecretScan === undefined ? {} : { hostedReviewSecretScan: trusted.hostedReviewSecretScan }),
    settingsDigest: trust === 'adopted' ? inputs.settingsDigest : null,
    repoConfigDigest: inputs.repoConfigDigest,
    rules: rules.map((familyId) => ({
      familyId,
      source:
        mandatory.has(familyId) && requested.has(familyId)
          ? 'both'
          : mandatory.has(familyId)
            ? 'mandatory'
            : 'requested',
    })),
    thresholds,
    agentActions: trusted.agentActions,
    grants: trusted.grants.map((g) => ({
      actions: [...g.actions],
      principals: [...(g.principals ?? ['human'])],
      confirm: g.confirm ?? 'default',
      scoped: g.scope !== undefined,
    })),
    providers: trusted.providers.map((p) => ({
      id: p.id,
      kind: p.kind,
      disclosure: p.disclosure,
      credential: p.credential ? 'keychain' : 'none',
    })),
    refused,
  };
  const checked = validateEnvelope('policy', view);
  if (!checked.ok)
    policyFail(
      'sentinel.policy.settingsInvalid',
      `the effective policy does not validate: ${checked.errors[0]?.message ?? 'invalid'}`,
    );
  const result: EffectivePolicy = deepFreeze({
    settings: trusted,
    thresholds,
    rules,
    view,
    revision: canonicalDigest({ kind: 'sentinel-effective-policy/1', settings: trusted, view }),
  });
  effective.add(result);
  return result;
}
