// Planner inputs from the published shapes of the rule lock, the pack manifests, the effective policy, the snapshot
// and the parser evidence. The shapes are structural subsets of those contracts (sentinel-rulelock/draft-1,
// sentinel-rulepack/draft-1, sentinel-policy/draft-1, sentinel-snapshot/draft-1 and the parser result), so this
// module imports none of their implementations.
//
// The lock pins a rule only by digest. A definition is admitted only when the digest recomputed from the pack
// manifest's definition and the lock's own inventory entries for the files it names equals the pinned
// `definitionDigest` (`sha256` over canonical JSON of `{ kind: 'sentinel-rule/1', rule, files }`, the rule
// lock's formula). A definition that differs, a rule missing from its manifest or a pack without one is refused.
import { createHash } from 'node:crypto';
import { canonicalJsonBytes } from '../store/objects.js';
import { PlanError } from './errors.js';
import { surfacesFromIndex } from './planner.js';
import type { PlannerAnalysis, PlannerLanguage, PlannerPolicy, PlannerRule, PlannerRuleLock, PlannerScopeKind } from './types.js';

const canonicalDigest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalJsonBytes(value)).digest('hex')}`;
const mismatch = (detail: string) => new PlanError('sentinel.plan.pinMismatch', detail);

interface PackFileShape { readonly path: string; readonly digest: string; readonly size: number }

/** The fields of a rule definition (sentinel-rulepack/draft-1 `rules[]`). Kept whole: its digest covers all of it. */
export interface RuleDefinitionShape {
  readonly familyId: string;
  readonly revision: number;
  readonly applicability: { readonly languages: readonly string[]; readonly scopeKind: string; readonly frameworks?: readonly string[] };
  readonly requires: readonly string[];
  readonly implementation: { readonly adapterId: string; readonly rulePath: string };
  readonly fixtures: { readonly positive: readonly string[]; readonly negative: readonly string[] };
  readonly [field: string]: unknown;
}

export interface PackManifestShape { readonly packId: string; readonly rules: readonly RuleDefinitionShape[] }

export interface RuleLockShape {
  readonly packs: readonly {
    readonly packId: string;
    readonly packDigest: string;
    readonly files: readonly PackFileShape[];
    readonly rules: readonly { readonly familyId: string; readonly revision: number; readonly definitionDigest: string }[];
  }[];
  readonly tools: readonly { readonly adapterId: string; readonly version: string; readonly artifactDigest: string }[];
  readonly databases: readonly { readonly databaseId: string; readonly snapshotDigest: string }[];
  readonly [field: string]: unknown;
}

/** The rule lock's own digest: the one a plan pins (canonical JSON, as the lock module computes it). */
export const ruleLockDigest = (lock: RuleLockShape): string => canonicalDigest(lock);

/**
 * The planner's lock view: every locked rule with its definition, verified against its pin. `pinned`, when given,
 * must equal the lock's digest; another lock is refused rather than substituted.
 */
export function plannerLockFrom(lock: RuleLockShape, manifests: readonly PackManifestShape[], pinned?: string): PlannerRuleLock {
  const digest = ruleLockDigest(lock);
  if (pinned !== undefined && pinned !== digest) throw mismatch('the rule lock is not the revision the plan pins');
  const byPack = new Map(manifests.map(m => [m.packId, m]));
  const rules: PlannerRule[] = [];
  for (const pack of lock.packs) {
    const manifest = byPack.get(pack.packId);
    if (!manifest) throw mismatch(`no manifest for locked pack ${pack.packId}`);
    const files = new Map(pack.files.map(f => [f.path, f]));
    for (const locked of pack.rules) {
      const rule = manifest.rules.find(r => r.familyId === locked.familyId && r.revision === locked.revision);
      if (!rule) throw mismatch(`${locked.familyId} revision ${locked.revision} is not in pack ${pack.packId}'s manifest`);
      const named = [rule.implementation.rulePath, ...rule.fixtures.positive, ...rule.fixtures.negative].map(p => {
        const f = files.get(p);
        if (!f) throw mismatch(`${locked.familyId} names ${p}, which the lock's inventory of ${pack.packId} does not hold`);
        return f;
      });
      if (canonicalDigest({ kind: 'sentinel-rule/1', rule, files: named }) !== locked.definitionDigest) {
        throw mismatch(`${locked.familyId}'s definition is not the one the lock pins`);
      }
      const a = rule.applicability;
      rules.push({
        familyId: rule.familyId, revision: rule.revision, definitionDigest: locked.definitionDigest, packDigest: pack.packDigest,
        languages: [...a.languages] as PlannerLanguage[], scopeKind: a.scopeKind as PlannerScopeKind,
        ...(a.frameworks ? { frameworks: [...a.frameworks] } : {}),
        requires: [...rule.requires], adapterId: rule.implementation.adapterId,
      });
    }
  }
  return {
    digest, rules,
    tools: lock.tools.map(t => ({ adapterId: t.adapterId, version: t.version, artifactDigest: t.artifactDigest })),
    databases: lock.databases.map(d => ({ databaseId: d.databaseId, snapshotDigest: d.snapshotDigest })),
  };
}

/** The effective policy's planning view (sentinel-policy/draft-1). Its digest is the canonical digest of the envelope. */
export interface EffectivePolicyShape {
  readonly rules: readonly { readonly familyId: string; readonly source: 'mandatory' | 'requested' | 'both' }[];
  readonly thresholds: { readonly requireCompleteCoverage: boolean; readonly requiredCapabilities: readonly string[] };
  readonly [field: string]: unknown;
}

export function plannerPolicyFrom(policy: EffectivePolicyShape): PlannerPolicy {
  return {
    digest: canonicalDigest(policy),
    rules: policy.rules.map(r => ({ familyId: r.familyId, source: r.source })),
    requireCompleteCoverage: policy.thresholds.requireCompleteCoverage,
    requiredCapabilities: [...policy.thresholds.requiredCapabilities],
  };
}

/** One source's parser evidence (the parser result's entries and index nodes), with an explicit surface allowlist. */
export interface SourceAnalysisShape {
  readonly sourceId: string;
  readonly result: { readonly analysisFingerprint: string; readonly entries: readonly { readonly path: string; readonly class: string }[] };
  readonly index: { readonly nodes: readonly { readonly nodeId: string; readonly kind: string; readonly path: string }[] };
}

export function plannerAnalysisFrom(source: SourceAnalysisShape, surfaceKinds: readonly string[]): PlannerAnalysis {
  return {
    sourceId: source.sourceId,
    analysisFingerprint: source.result.analysisFingerprint,
    files: source.result.entries.map(e => ({ path: e.path, class: e.class })),
    surfaces: surfacesFromIndex(source.index, surfaceKinds),
  };
}
