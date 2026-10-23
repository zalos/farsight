// A stage/segment choice is audit data derived from the current owner-adopted policy. It never admits a call.
// The existing bindProvider boundary supplies the actual binding; no structural selection can recreate authority.
import type { Digest, ReviewModelStage, ReviewModelsSettings, ReviewStageModelSelection, ProviderSettings } from '../../contracts/index.js';
import { canonicalDigest } from '../../policy/digest.js';
import { isEffectivePolicy, type EffectivePolicy } from '../../policy/settings.js';
import { bindProvider, type ProviderBinding, type ProviderSelection } from './profile.js';
import { fail } from './errors.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Closed dispatch classification: adding a provider kind requires an explicit hosted-pause decision.
function isApiKind(kind: ProviderSettings['kind']): boolean {
  switch (kind) {
    case 'ollama': case 'openai-compatible': return true;
    case 'claude-cli': return false;
    default: { const unhandled: never = kind; return fail('sentinel.provider.invalidProfile', 'unsupported provider kind'); }
  }
}
const stageIs = (v: unknown): v is ReviewModelStage => v === 'guided' || v === 'general';

export interface ResolvedReviewModel {
  readonly stage: ReviewModelStage;
  readonly segmentId: string;
  readonly selectedBy: 'stage' | 'segment';
  readonly selection: Readonly<ProviderSelection>;
  readonly policyRevision: string;
  /** Binds selection to its actual stage, segment and policy; instruction provenance is sealed by SessionSpec. */
  readonly digest: Digest;
  readonly binding: ProviderBinding;
}

function check(config: ReviewModelsSettings) {
  if (!config || !Array.isArray(config.stages) || config.stages.length > 2 || !Array.isArray(config.segments) || config.segments.length > 10000
    || Object.keys(config).some(k => k !== 'stages' && k !== 'segments')) fail('sentinel.provider.invalidProfile', 'invalid bounded review model selections');
  const seen = new Set<string>();
  for (const [entries, segment] of [[config.stages, false], [config.segments, true]] as const) for (const row of entries) {
    if (!row || !stageIs(row.stage) || typeof row.providerId !== 'string' || !ID.test(row.providerId) || typeof row.modelId !== 'string' || !ID.test(row.modelId)
      || Object.keys(row).some(k => !['stage', 'providerId', 'modelId', ...(segment ? ['segmentId'] : [])].includes(k))) {
      fail('sentinel.provider.invalidProfile', 'review model selection names exact stage and configured ids');
    }
    const segmentId = 'segmentId' in row ? row.segmentId : undefined;
    if (segment && (typeof segmentId !== 'string' || !ID.test(segmentId))) fail('sentinel.provider.invalidProfile', 'review segment is an exact prepared id');
    const key = JSON.stringify([row.stage, segment ? segmentId : null]);
    if (seen.has(key)) fail('sentinel.provider.invalidProfile', 'duplicate review model selection');
    seen.add(key);
  }
}

/** Pure public-stage release gate; retained provider binding remains available for later qualification. */
export function assertNativeClaudeReviewEnabled(policy: EffectivePolicy, providerId: string): void {
  if (!isEffectivePolicy(policy)) fail('sentinel.provider.notTrusted', 'review execution needs the genuine current policy');
  if (policy.settings.providers.find(p => p.id === providerId)?.kind === 'claude-cli'
    && policy.settings.nativeClaudeReviewEnabled !== true) {
    fail('sentinel.provider.nativeClaudeDisabled', 'native Claude execution is deferred until separately enabled and qualified');
  }
}

/** Deterministic execution never chooses or probes a model. Agentic resolution alone makes no call or receipt. */
export function resolveReviewModel(policy: EffectivePolicy, stage: 'deterministic', segmentId?: string): Readonly<{ stage: 'deterministic'; model: 'not-applicable' }>;
export function resolveReviewModel(policy: EffectivePolicy, stage: ReviewModelStage, segmentId: string): Readonly<ResolvedReviewModel>;
export function resolveReviewModel(policy: EffectivePolicy, stage: ReviewModelStage | 'deterministic', segmentId?: string) {
  if (!isEffectivePolicy(policy)) fail('sentinel.provider.notTrusted', 'review selection requires the genuine current policy');
  if (stage === 'deterministic') return Object.freeze({ stage, model: 'not-applicable' as const });
  if (!stageIs(stage) || typeof segmentId !== 'string' || !ID.test(segmentId)) fail('sentinel.provider.invalidProfile', 'review selection needs an exact stage and segment');
  const config = policy.settings.reviewModels;
  if (config === undefined) return fail('sentinel.provider.capabilityUntested', 'no owner-adopted review model selection');
  check(config);
  const specific = config.segments.find(x => x.stage === stage && x.segmentId === segmentId);
  const selected: ReviewStageModelSelection | undefined = specific ?? config.stages.find(x => x.stage === stage);
  if (!selected) return fail('sentinel.provider.capabilityMissing', 'no configured model for this review segment');
  assertNativeClaudeReviewEnabled(policy, selected.providerId);
  const provider = policy.settings.providers.find(x => x.id === selected.providerId);
  if (provider?.disclosure === 'hosted' && isApiKind(provider.kind)
    && policy.settings.hostedApiReviewEnabled !== true) {
    fail('sentinel.provider.featureDisabled', 'the adopted hosted review feature is off');
  }
  const binding = bindProvider(policy, selected.providerId, selected.modelId);
  const selection = Object.freeze({ providerId: binding.providerId, modelId: binding.modelId, bindingDigest: binding.digest });
  const body = { stage, segmentId, selectedBy: specific ? 'segment' as const : 'stage' as const, selection, policyRevision: policy.revision };
  return Object.freeze({ ...body, digest: canonicalDigest(body) as Digest, binding });
}
