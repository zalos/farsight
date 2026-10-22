// Planner inputs from the actual exported types: the rule lock and the validated packs it was promoted from
// (rules/), the effective policy (policy/), the snapshot envelope and the parser's per-source analysis
// (snapshot/parser). Nothing here restates their schemas; it reads their fields and refuses anything that does not
// match its pin.
//
// A rule is planned only with the definition the lock pinned: for each locked rule, a validated pack with the same
// pack id and pack digest must hold a rule of that family and revision whose definition digest equals the lock's.
// The digest is the rules module's own (validatePack); the planner never recomputes or substitutes one.
import type { RuleDefinition, RuleLockEnvelope, SnapshotEnvelope } from '../contracts/index.js';
import { isEffectivePolicy, type EffectivePolicy } from '../policy/settings.js';
import { isValidatedPack, type ValidatedPack } from '../rules/pack.js';
import { lockDigest, verifyPinnedLock } from '../rules/lock.js';
import type { SourceAnalysis } from '../snapshot/parser.js';
import { PlanError } from './errors.js';
import { SURFACE_NODE_KINDS, surfacesFromIndex } from './planner.js';
import type { PlannerAnalysis, PlannerPolicy, PlannerRule, PlannerRuleLock, PlannerSnapshot } from './types.js';

const mismatch = (detail: string) => new PlanError('sentinel.plan.pinMismatch', detail);

export interface LockedRuleDefinition {
  readonly packId: string;
  readonly packDigest: string;
  readonly definitionDigest: string;
  readonly definition: RuleDefinition;
}

/**
 * Every rule the lock pins with the exact definition it pinned. `pinned`, when given, must be the lock's digest
 * (the rules module's verifyPinnedLock). A missing pack, a pack with another digest, a missing rule or a definition
 * with another digest is refused; a pack object not returned by validatePack is refused too.
 */
export function lockedRuleDefinitions(lock: RuleLockEnvelope, packs: readonly ValidatedPack[], pinned?: string): LockedRuleDefinition[] {
  const checked = pinned === undefined ? lock : verifyPinnedLock(lock, pinned);
  for (const p of packs) if (!isValidatedPack(p)) throw mismatch('a pack is accepted only as validatePack returned it');
  const out: LockedRuleDefinition[] = [];
  for (const locked of checked.packs) {
    const pack = packs.find(p => p.manifest.packId === locked.packId && p.packDigest === locked.packDigest);
    if (!pack) throw mismatch(`no validated pack ${locked.packId} with the pinned digest`);
    for (const rule of locked.rules) {
      const digest = pack.rules.find(r => r.familyId === rule.familyId && r.revision === rule.revision)?.definitionDigest;
      const definition = pack.manifest.rules.find(r => r.familyId === rule.familyId && r.revision === rule.revision);
      if (!definition || digest !== rule.definitionDigest) throw mismatch(`${rule.familyId} revision ${rule.revision} is not the definition the lock pins`);
      out.push({ packId: locked.packId, packDigest: locked.packDigest, definitionDigest: rule.definitionDigest, definition });
    }
  }
  return out;
}

/** The planner's rule-lock view, from verified definitions. Its digest is the rules module's lockDigest. */
export function plannerLockFrom(lock: RuleLockEnvelope, packs: readonly ValidatedPack[], pinned?: string): PlannerRuleLock {
  const rules: PlannerRule[] = lockedRuleDefinitions(lock, packs, pinned).map(({ definition: d, packDigest, definitionDigest }) => ({
    familyId: d.familyId, revision: d.revision, definitionDigest, packDigest,
    languages: [...d.applicability.languages], scopeKind: d.applicability.scopeKind,
    ...(d.applicability.frameworks ? { frameworks: [...d.applicability.frameworks] } : {}),
    requires: [...d.requires], adapterId: d.implementation.adapterId,
  }));
  return {
    digest: lockDigest(lock), rules,
    tools: lock.tools.map(t => ({ adapterId: t.adapterId, version: t.version, artifactDigest: t.artifactDigest })),
    databases: lock.databases.map(d => ({ databaseId: d.databaseId, snapshotDigest: d.snapshotDigest })),
  };
}

/** The planning view of the effective policy. It pins `revision`, the digest receipts and admission bind to. */
export function plannerPolicyFrom(policy: EffectivePolicy): PlannerPolicy {
  if (!isEffectivePolicy(policy)) throw mismatch('the policy is accepted only as effectivePolicy returned it');
  return {
    digest: policy.revision,
    rules: policy.view.rules.map(r => ({ familyId: r.familyId, source: r.source })),
    requireCompleteCoverage: policy.thresholds.requireCompleteCoverage,
    requiredCapabilities: [...policy.thresholds.requiredCapabilities],
  };
}

/** The planning view of a snapshot envelope. */
export function plannerSnapshotFrom(snapshot: SnapshotEnvelope): PlannerSnapshot {
  return {
    id: snapshot.id, inventoryDigest: snapshot.inventoryDigest, environmentProfileDigest: snapshot.environmentProfileDigest,
    sources: snapshot.sources.map(s => ({ sourceId: s.sourceId })), entries: snapshot.entries, frameworkVersions: snapshot.frameworkVersions,
  };
}

/** One source's parser evidence: each captured path's class, and surfaces from the index by graph kind. */
export function plannerAnalysisFrom(source: SourceAnalysis, surfaceKinds: readonly string[] = SURFACE_NODE_KINDS): PlannerAnalysis {
  return {
    sourceId: source.sourceId,
    analysisFingerprint: source.result.analysisFingerprint,
    files: source.result.entries.map(e => ({ path: e.path, class: e.class })),
    surfaces: surfacesFromIndex(source.index, surfaceKinds),
  };
}
