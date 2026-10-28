// The feature-flag registry: every gated Sentinel feature, the adopted settings key that sets it, and its default.
//
// A flag is read here and nowhere else (test/features.test.ts fails on a settings read elsewhere). The settings
// booleans that predate the registry are its aliases: `hostedApiReviewEnabled` sets `review.hosted-api` and
// `nativeClaudeReviewEnabled` sets `runner.claude-cli`, with the meaning they always had. `hostScripts` sets
// `stage.host-scripts`. `runner.copilot-cli` has no setting: the qualified Copilot CLI runner stays on, as it is
// today, until a per-runner qualification record decides it. Settings adoption itself is unchanged; untrusted
// settings never reach this module, because the effective policy falls back to the defaults, which set no flag.
import type { CatalogKey, FeatureFlagName, SettingsEnvelope } from '../contracts/index.js';
import { FEATURE_FLAG_NAMES } from '../contracts/index.js';

/** The settings booleans a flag may be read from. */
export type FeatureSetting = 'hostScripts' | 'nativeClaudeReviewEnabled' | 'hostedApiReviewEnabled';

export interface FeatureFlagDefinition {
  readonly name: FeatureFlagName;
  /** The adopted settings boolean that sets it, or null when no setting does. */
  readonly setting: FeatureSetting | null;
  /** Its value when the setting is absent, or when nothing is adopted. */
  readonly default: boolean;
  /** The catalog key that names the feature; its define says what turning it on allows. */
  readonly label: CatalogKey;
}

/** The registry, in a fixed order. */
export const FEATURE_FLAGS: readonly FeatureFlagDefinition[] = Object.freeze(
  [
    { name: 'stage.host-scripts', setting: 'hostScripts', default: false, label: 'sentinel.feature.hostScripts' },
    {
      name: 'runner.claude-cli',
      setting: 'nativeClaudeReviewEnabled',
      default: false,
      label: 'sentinel.feature.claudeCli',
    },
    { name: 'runner.copilot-cli', setting: null, default: true, label: 'sentinel.feature.copilotCli' },
    {
      name: 'review.hosted-api',
      setting: 'hostedApiReviewEnabled',
      default: false,
      label: 'sentinel.feature.hostedApi',
    },
  ].map((f) => Object.freeze(f as FeatureFlagDefinition)),
);

/** The reason code a dispatch or a plan carries when it needs a feature that is off. */
export const FEATURE_OFF_REASON: CatalogKey = 'sentinel.feature.off';

/** A name that is not in the registry. A programming error, never a settings value. */
export class FeatureFlagError extends Error {
  readonly code = 'sentinel.feature.unknown' as const;
  constructor(readonly flag: string) {
    super(`sentinel.feature.unknown: ${JSON.stringify(flag).slice(0, 80)} is not a registered feature`);
    this.name = 'FeatureFlagError';
  }
}

const BY_NAME: ReadonlyMap<string, FeatureFlagDefinition> = new Map(FEATURE_FLAGS.map((f) => [f.name, f]));
const BY_SETTING: ReadonlyMap<string, FeatureFlagDefinition> = new Map(
  FEATURE_FLAGS.filter((f) => f.setting !== null).map((f) => [f.setting as string, f]),
);

/** The definition for a registry name or a settings alias (`hostedApiReviewEnabled`); undefined for anything else. */
export function featureOf(nameOrSetting: string): FeatureFlagDefinition | undefined {
  return BY_NAME.get(nameOrSetting) ?? BY_SETTING.get(nameOrSetting);
}

function definition(name: FeatureFlagName): FeatureFlagDefinition {
  const found = typeof name === 'string' ? BY_NAME.get(name) : undefined;
  if (!found) throw new FeatureFlagError(String(name));
  return found;
}

/** One flag as the adopted settings decide it. */
export interface FeatureState {
  readonly name: FeatureFlagName;
  readonly enabled: boolean;
  /** `settings`: the adopted settings set it explicitly. `default`: the setting is absent or there is none. */
  readonly source: 'settings' | 'default';
  readonly setting: FeatureSetting | null;
  readonly label: CatalogKey;
  /** Present only while the flag is off. */
  readonly reasonCode?: CatalogKey;
}

/**
 * One flag under the given settings: pass the effective policy's `settings` (adopted settings, or the defaults when
 * nothing is adopted), or null for no settings. Only an explicit boolean in the settings moves a flag off its default.
 */
export function featureState(settings: Readonly<SettingsEnvelope> | null, name: FeatureFlagName): FeatureState {
  const def = definition(name);
  const value = def.setting === null || settings === null ? undefined : settings[def.setting];
  const explicit = value === true || value === false;
  const enabled = explicit ? value : def.default;
  return Object.freeze({
    name: def.name,
    enabled,
    source: explicit ? ('settings' as const) : ('default' as const),
    setting: def.setting,
    label: def.label,
    ...(enabled ? {} : { reasonCode: FEATURE_OFF_REASON }),
  });
}

/** True when the feature is on under these settings. */
export function featureEnabled(settings: Readonly<SettingsEnvelope> | null, name: FeatureFlagName): boolean {
  return featureState(settings, name).enabled;
}

/** Every flag under these settings, in registry order. */
export function featureStates(settings: Readonly<SettingsEnvelope> | null): readonly FeatureState[] {
  return Object.freeze(FEATURE_FLAG_NAMES.map((name) => featureState(settings, name)));
}
