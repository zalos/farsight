// Planner inputs from the actual exported types: the rule lock resolved against the validated packs it was
// promoted from (rules/resolveLockedRules), the effective policy (policy/), the snapshot envelope and the parser's
// per-source analysis (snapshot/parser). Nothing here restates their schemas or recomputes their digests.
import type { RuleLockEnvelope, SnapshotEnvelope } from '../contracts/index.js';
import { isEffectivePolicy, type EffectivePolicy } from '../policy/settings.js';
import type { ValidatedPack } from '../rules/pack.js';
import { resolveLockedRules } from '../rules/resolve.js';
import type { SourceAnalysis } from '../snapshot/parser.js';
import { PlanError } from './errors.js';
import { trustedView } from './identity.js';
import { validateEnvelope } from '../validate.js';
import { SURFACE_NODE_KINDS, surfacesFromIndex } from './planner.js';
import type { PlannerAnalysis, PlannerPolicy, PlannerRuleLock, PlannerSnapshot } from './types.js';

const mismatch = (detail: string) => new PlanError('sentinel.plan.pinMismatch', detail);

/**
 * The planner's rule-lock view: every rule the lock pins, with the original definition resolveLockedRules verified
 * against the canonical lock pin and the exact validated pack (a missing, stale or forged pack or lock is refused
 * there, with the rules module's own reason). The view's digest is the pin.
 */
export function plannerLockFrom(lock: RuleLockEnvelope, packs: readonly ValidatedPack[], pin: string): PlannerRuleLock {
  const resolved = resolveLockedRules(lock, pin, packs);
  return trustedView({
    digest: pin,
    rules: resolved.map(({ definition: d, definitionDigest, packDigest }) => ({
      familyId: d.familyId,
      revision: d.revision,
      definitionDigest,
      packDigest,
      languages: [...d.applicability.languages],
      scopeKind: d.applicability.scopeKind,
      ...(d.applicability.frameworks ? { frameworks: [...d.applicability.frameworks] } : {}),
      requires: [...d.requires],
      adapterId: d.implementation.adapterId,
    })),
    tools: lock.tools.map((t) => ({ adapterId: t.adapterId, version: t.version, artifactDigest: t.artifactDigest })),
    databases: lock.databases.map((d) => ({ databaseId: d.databaseId, snapshotDigest: d.snapshotDigest })),
  });
}

/** The planning view of the effective policy. It pins `revision`, the digest receipts and admission bind to. */
export function plannerPolicyFrom(policy: EffectivePolicy): PlannerPolicy {
  if (!isEffectivePolicy(policy)) throw mismatch('the policy is accepted only as effectivePolicy returned it');
  return trustedView({
    digest: policy.revision,
    rules: policy.view.rules.map((r) => ({ familyId: r.familyId, source: r.source })),
    requireCompleteCoverage: policy.thresholds.requireCompleteCoverage,
    requiredCapabilities: [...policy.thresholds.requiredCapabilities],
  });
}

/** The planning view of a snapshot envelope. */
export function plannerSnapshotFrom(snapshot: SnapshotEnvelope): PlannerSnapshot {
  if (!validateEnvelope('snapshot', snapshot).ok)
    throw mismatch('the snapshot is not a valid sentinel-snapshot/draft-1 envelope');
  return trustedView({
    id: snapshot.id,
    inventoryDigest: snapshot.inventoryDigest,
    environmentProfileDigest: snapshot.environmentProfileDigest,
    sources: snapshot.sources.map((s) => ({ sourceId: s.sourceId })),
    entries: snapshot.entries,
    frameworkVersions: snapshot.frameworkVersions,
  });
}

/** One source's parser evidence: each captured path's class, and surfaces from the index by graph kind. */
export function plannerAnalysisFrom(
  source: SourceAnalysis,
  surfaceKinds: readonly string[] = SURFACE_NODE_KINDS,
): PlannerAnalysis {
  // The result and the index must be one analysis of one source of one snapshot.
  const { result, index } = source;
  if (result.sourceId !== source.sourceId || index.sourceId !== source.sourceId)
    throw mismatch('the parser result, its index and its source disagree on the source');
  if (result.snapshotId !== index.snapshotId)
    throw mismatch('the parser result and its index name different snapshots');
  if (result.analysisFingerprint !== index.analysisFingerprint)
    throw mismatch('the parser result and its index are different analyses');
  const artifact = (source as { artifact?: { analysis?: { fingerprint?: string } } }).artifact;
  if (artifact?.analysis?.fingerprint !== undefined && artifact.analysis.fingerprint !== result.analysisFingerprint) {
    throw mismatch('the retained analysis artifact is not the analysis its result describes');
  }
  return trustedView({
    snapshotId: result.snapshotId,
    sourceId: source.sourceId,
    analysisFingerprint: result.analysisFingerprint,
    omitted: index.omitted ?? 0,
    unplaced: index.unplaced?.count ?? 0,
    files: result.entries.map((e) => ({
      path: e.path,
      class: e.class,
      ...(e.content !== undefined ? { content: e.content } : {}),
    })),
    surfaces: surfacesFromIndex(source.index, surfaceKinds),
  });
}
