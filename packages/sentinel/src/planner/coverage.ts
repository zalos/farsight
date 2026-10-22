// Required coverage, from coverage evidence only. A run's required coverage is complete exactly when every required
// check of its plan has one coverage record (sentinel-coverage/draft-1, the one coverage contract) that counts:
//
// - it is for this run, this check and the exact work revision the plan assigned the check to;
// - its status is `complete`;
// - its basis is `executed`. Reuse does not count yet: no contract records a reused result's exact prior check,
//   scope, rule, inputs, environment and derivation, so a reused record keeps the check incomplete rather than
//   borrowing coverage (PR 27 adds that derivation). Imported evidence never counts; neither does work finishing;
// - its granularity is fine enough for the check: a file, surface, manifest or CI check needs per-file-per-rule
//   coverage; only a whole-repository check may be completed by an aggregate record.
//
// A required check the plan could not plan (unsupported, applicability unknown, scope unavailable or unknown) and a
// required rule gap are incomplete by definition. Records for other runs are ignored; a record for this run that
// names an unknown check is reported. Nothing here reads attempts, publications or process outcomes.
import type { CatalogKey, Id } from '../contracts/common.js';
import type { CoverageEnvelope, CoverageStatus } from '../contracts/coverage.js';
import { validateEnvelope } from '../validate.js';
import { PlanError } from './errors.js';
import { verifyPlanRevision } from './planner.js';
import { deepFreeze } from './identity.js';
import type { CheckState, PlanRevision } from './types.js';

export interface CheckCoverage {
  readonly checkId: Id;
  readonly required: boolean;
  readonly planState: CheckState;
  /** The counting record's status, or null when no record counts. */
  readonly status: CoverageStatus | null;
  /** True only for a counting `complete` record. */
  readonly complete: boolean;
  /** Why it is not complete. */
  readonly reasonCode?: CatalogKey;
}

export interface RequiredCoverage {
  /** True only when every required check is complete and no required rule gap remains. */
  readonly complete: boolean;
  readonly required: number;
  readonly requiredComplete: number;
  readonly checks: readonly CheckCoverage[];
  /** Required rule gaps: rules the plan could not schedule at all. */
  readonly ruleGaps: PlanRevision['ruleGaps'];
  /** Records for this run that name no check of the plan. */
  readonly unknownRecords: readonly Id[];
}

export function evaluateRequiredCoverage(plan: PlanRevision, records: readonly CoverageEnvelope[]): RequiredCoverage {
  if (!validateEnvelope('plan', plan).ok || !verifyPlanRevision(plan)) throw new PlanError('sentinel.plan.pinMismatch', 'the plan revision does not validate or match its digest');
  const byCheck = new Map<string, CoverageEnvelope[]>();
  const known = new Set(plan.checks.map(c => c.id));
  const unknownRecords: Id[] = [];
  for (const r of records) {
    if (!validateEnvelope('coverage', r).ok) throw new PlanError('sentinel.plan.invalidInput', 'a coverage record does not validate');
    if (r.runId !== plan.runId) continue;
    if (!known.has(r.checkId)) { unknownRecords.push(r.id); continue; }
    (byCheck.get(r.checkId) ?? byCheck.set(r.checkId, []).get(r.checkId)!).push(r);
  }
  const checks: CheckCoverage[] = plan.checks.map(c => {
    const base = { checkId: c.id, required: c.required, planState: c.state };
    if (c.state !== 'planned') return { ...base, status: null, complete: false, reasonCode: c.reasonCode! };
    const counting: CoverageEnvelope[] = [];
    let refused: CatalogKey | undefined;
    for (const r of byCheck.get(c.id) ?? []) {
      if (r.workId !== c.unit!.id || r.workRevision !== c.unit!.revision) { refused = 'sentinel.plan.coverageWrongUnit'; continue; }
      if (r.basis.kind === 'imported') { refused = 'sentinel.plan.coverageImported'; continue; }
      if (r.basis.kind === 'reused') { refused = 'sentinel.plan.coverageReuseUnproven'; continue; }
      if (r.basis.kind !== 'executed') { refused = 'sentinel.plan.coverageMissing'; continue; }
      if (r.granularity !== 'per-file-per-rule' && !(c.scopeKind === 'repository' && r.granularity === 'aggregate')) {
        refused = 'sentinel.plan.coverageTooCoarse'; continue;
      }
      counting.push(r);
    }
    if (counting.length === 0) return { ...base, status: null, complete: false, reasonCode: refused ?? 'sentinel.plan.coverageMissing' };
    if (counting.length > 1 && new Set(counting.map(r => r.status)).size > 1) {
      return { ...base, status: null, complete: false, reasonCode: 'sentinel.plan.coverageConflict' };
    }
    const status = counting[0]!.status;
    return status === 'complete' ? { ...base, status, complete: true } : { ...base, status, complete: false, reasonCode: 'sentinel.plan.coverageNotComplete' };
  });
  const required = checks.filter(c => c.required);
  const requiredComplete = required.filter(c => c.complete).length;
  const ruleGaps = plan.ruleGaps.filter(g => g.required);
  return deepFreeze(structuredClone({
    complete: requiredComplete === required.length && ruleGaps.length === 0,
    required: required.length, requiredComplete, checks, ruleGaps, unknownRecords,
  }));
}
