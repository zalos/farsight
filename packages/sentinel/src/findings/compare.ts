// Comparing two complete assessments (PR 19, ADR 38). Every current finding gets a label and every baseline finding
// the current findings do not continue is kept with a reason. Absence alone never resolves an issue: a baseline
// finding is `resolved-by-comparable-check` only when its anchors' code is still there, a complete current check of
// its rule family covered all of its files, and that check ran under the same rule revision, engine and capabilities
// (or a reviewed compatibility mapping) and the same environment and limits. A removed file or symbol is a removed
// surface, not a fix; a missing, failed or narrower check is unassessed scope; a changed rule, engine or capability
// is changed detection; other differing conditions are incomparable; probable and ambiguous pairings stay open.
import type { CoverageStatus } from '../contracts/index.js';
import { matchFindings, type MatchableFinding } from './match.js';

export interface DetectionConditions {
  readonly ruleRevision: string;
  readonly engine: string;
  readonly capabilities: string;
  readonly environment: string;
  readonly relevantLimits: string;
}

/** What one check of a rule family established in a run. `files` are `sourceId:relativePath`. */
export interface CheckAssessment {
  readonly ruleFamilyId: string;
  readonly status: CoverageStatus;
  readonly files: ReadonlySet<string>;
  readonly conditions: DetectionConditions;
}

/** A reviewed statement that two detection conditions of one rule family detect equivalently. */
export interface CompatibilityMapping {
  readonly ruleFamilyId: string;
  readonly from: DetectionConditions;
  readonly to: DetectionConditions;
  readonly rationale: string;
}

export interface ComparableFinding extends MatchableFinding {
  readonly ruleFamilyId: string;
  readonly anchors: readonly { readonly sourceId: string; readonly relativePath: string | null; readonly withheld?: boolean; readonly content?: string; readonly locationKey?: string | null; readonly nodeId: string | null; readonly span: { readonly startByte: number; readonly endByte: number } }[];
}

export interface AssessmentSide<F extends ComparableFinding = ComparableFinding> {
  readonly findings: readonly F[];
  readonly checks: readonly CheckAssessment[];
}

export interface CurrentSurfaces {
  /** Every included captured file, as `sourceId:relativePath`. */
  readonly files: ReadonlySet<string>;
  /** Folders whose contents were never enumerated, as `sourceId:relativePath/`: a file under one is unknown, not removed. */
  readonly unknownScope: readonly string[];
  /** The canonical node ids of the current graph, and the files the parser analysed completely; null without a graph. */
  readonly graph: { readonly nodeIds: ReadonlySet<string>; readonly analysedFiles: ReadonlySet<string> } | null;
}

export type CurrentLabel = 'new' | 'persistent' | 'changed-evidence' | 'changed-detection' | 'reopened' | 'reopened-disposition-expired';
export type HistoricalLabel = 'resolved-by-comparable-check' | 'removed-surface' | 'unassessed-in-current-scope' | 'changed-detection' | 'incomparable-conditions' | 'changed-evidence';

export interface CurrentOutcome {
  readonly findingId: string;
  readonly label: CurrentLabel;
  readonly reasonCode: string;
  readonly match?: { readonly kind: 'exact' | 'probable' | 'ambiguous'; readonly baselineFindingIds: readonly string[] };
}
export interface HistoricalOutcome {
  readonly baselineFindingId: string;
  readonly label: HistoricalLabel;
  readonly reasonCode: string;
  readonly match?: { readonly kind: 'ambiguous'; readonly baselineFindingIds: readonly string[] };
}

export interface ComparisonRequest<F extends ComparableFinding> {
  readonly baseline: AssessmentSide<F> & {
    /** Findings the baseline report already listed as resolved by a comparable check: a match reopens them. */
    readonly resolved?: readonly F[];
    /** Baseline findings whose disposition has expired by the current evaluation time. */
    readonly expiredDispositions?: ReadonlySet<string>;
  };
  readonly current: AssessmentSide<F> & { readonly surfaces: CurrentSurfaces };
  readonly compatibility?: readonly CompatibilityMapping[];
}

export interface Comparison {
  readonly current: readonly CurrentOutcome[];
  readonly historical: readonly HistoricalOutcome[];
}

const same = (a: DetectionConditions, b: DetectionConditions, keys: readonly (keyof DetectionConditions)[]) => keys.every(k => a[k] === b[k]);
const DETECTION: readonly (keyof DetectionConditions)[] = ['ruleRevision', 'engine', 'capabilities'];
const CONDITIONS: readonly (keyof DetectionConditions)[] = ['environment', 'relevantLimits'];

function detectionEquivalent(rule: string, b: DetectionConditions, c: DetectionConditions, mappings: readonly CompatibilityMapping[]): boolean {
  if (same(b, c, DETECTION)) return true;
  return mappings.some(m => m.ruleFamilyId === rule && same(m.from, b, [...DETECTION, ...CONDITIONS]) && same(m.to, c, [...DETECTION, ...CONDITIONS]));
}

/** The one assessment of a rule family in a run; several (or none) cannot establish anything. */
function checkOf(side: AssessmentSide, rule: string): CheckAssessment | 'none' | 'several' {
  const hits = side.checks.filter(c => c.ruleFamilyId === rule);
  return hits.length === 0 ? 'none' : hits.length > 1 ? 'several' : hits[0]!;
}

const fileKey = (a: { sourceId: string; relativePath: string | null; content?: string; locationKey?: string | null }) => (a.relativePath === null ? `${a.sourceId}:withheld:${a.locationKey ?? ''}:${a.content ?? ''}` : `${a.sourceId}:${a.relativePath}`);

export function compareAssessments<F extends ComparableFinding>(request: ComparisonRequest<F>): Comparison {
  const { baseline, current } = request;
  const mappings = request.compatibility ?? [];
  const byIdB = new Map(baseline.findings.map(f => [f.id, f]));
  const byIdC = new Map(current.findings.map(f => [f.id, f]));
  const m = matchFindings(baseline.findings, current.findings);
  const out: CurrentOutcome[] = [];
  const historical: HistoricalOutcome[] = [];
  const expired = baseline.expiredDispositions ?? new Set<string>();

  for (const p of m.exact) {
    const b = byIdB.get(p.baseline)!, c = byIdC.get(p.current)!;
    const moved = JSON.stringify(b.anchors.map(a => [fileKey(a), a.span.startByte, a.span.endByte])) !== JSON.stringify(c.anchors.map(a => [fileKey(a), a.span.startByte, a.span.endByte]));
    const match = { kind: 'exact' as const, baselineFindingIds: [p.baseline] };
    if (expired.has(p.baseline)) out.push({ findingId: p.current, label: 'reopened-disposition-expired', reasonCode: 'sentinel.compare.dispositionExpired', match });
    else out.push({ findingId: p.current, label: moved ? 'changed-evidence' : 'persistent', reasonCode: moved ? 'sentinel.compare.evidenceMoved' : 'sentinel.compare.sameEvidence', match });
  }
  for (const p of m.probable) {
    // The cited code changed inside the same declarations: the issue continues, pending review; it is not resolved.
    out.push({ findingId: p.current, label: 'changed-evidence', reasonCode: 'sentinel.compare.probableMatch', match: { kind: 'probable', baselineFindingIds: [p.baseline] } });
  }
  for (const g of m.ambiguous) {
    for (const c of g.current) out.push({ findingId: c, label: 'changed-evidence', reasonCode: 'sentinel.compare.ambiguousMatch', match: { kind: 'ambiguous', baselineFindingIds: [...g.baseline] } });
    for (const b of g.baseline) historical.push({ baselineFindingId: b, label: 'changed-evidence', reasonCode: 'sentinel.compare.ambiguousMatch', match: { kind: 'ambiguous', baselineFindingIds: [...g.baseline] } });
  }

  // Current findings no baseline finding continues: reopened, changed detection, or new.
  const resolved = baseline.resolved ?? [];
  const reopened = resolved.length ? matchFindings(resolved, m.unmatchedCurrent.map(id => byIdC.get(id)!)) : undefined;
  const reopenedBy = new Map<string, string>();
  for (const p of [...reopened?.exact ?? [], ...reopened?.probable ?? []]) reopenedBy.set(p.current, p.baseline);
  for (const id of m.unmatchedCurrent) {
    const c = byIdC.get(id)!;
    if (reopenedBy.has(id)) { out.push({ findingId: id, label: 'reopened', reasonCode: 'sentinel.compare.reopened', match: { kind: 'exact', baselineFindingIds: [reopenedBy.get(id)!] } }); continue; }
    const bc = checkOf(baseline, c.ruleFamilyId);
    const cc = checkOf(current, c.ruleFamilyId);
    if (bc !== 'none' && bc !== 'several' && cc !== 'none' && cc !== 'several' && !detectionEquivalent(c.ruleFamilyId, bc.conditions, cc.conditions, mappings)) {
      out.push({ findingId: id, label: 'changed-detection', reasonCode: 'sentinel.compare.detectionChanged' });
    } else {
      const assessed = bc !== 'none' && bc !== 'several' && bc.status === 'complete' && c.anchors.every(a => bc.files.has(fileKey(a)));
      out.push({ findingId: id, label: 'new', reasonCode: assessed ? 'sentinel.compare.newInAssessedScope' : 'sentinel.compare.notPreviouslyAssessed' });
    }
  }

  // Baseline findings nothing continues: each keeps a reason; only a comparable clean check resolves one.
  for (const id of m.unmatchedBaseline) {
    const b = byIdB.get(id)!;
    historical.push({ baselineFindingId: id, ...historicalOutcome(b, current, baseline, mappings) });
  }
  return { current: out.sort((a, b) => (a.findingId < b.findingId ? -1 : 1)), historical: historical.sort((a, b) => (a.baselineFindingId < b.baselineFindingId ? -1 : 1)) };
}

function historicalOutcome(b: ComparableFinding, current: ComparisonRequest<ComparableFinding>['current'], baseline: AssessmentSide, mappings: readonly CompatibilityMapping[]): { label: HistoricalLabel; reasonCode: string } {
  const s = current.surfaces;
  // A withheld location cannot be looked for: whether its code is still there is unknown, so it is never resolved.
  if (b.anchors.some(a => a.relativePath === null)) return { label: 'unassessed-in-current-scope', reasonCode: 'sentinel.compare.locationWithheld' };
  const files = [...new Set(b.anchors.map(fileKey))];
  const underUnknown = (f: string) => s.unknownScope.some(u => f.startsWith(u));
  // A file under a folder capture could not list is unknown, never removed.
  if (files.some(underUnknown)) return { label: 'unassessed-in-current-scope', reasonCode: 'sentinel.compare.unknownScope' };
  // Any anchor's code gone (all of it or part: a removed source with the sink still there) is a removed surface,
  // never a clean recheck of the issue as it was.
  if (files.every(f => !s.files.has(f))) return { label: 'removed-surface', reasonCode: 'sentinel.compare.fileRemoved' };
  if (files.some(f => !s.files.has(f))) return { label: 'removed-surface', reasonCode: 'sentinel.compare.partRemoved' };
  const symbols = [...new Set(b.anchors.map(a => a.nodeId).filter((n): n is string => !!n))];
  const verifiable = !!s.graph && files.every(f => s.graph!.analysedFiles.has(f));
  if (symbols.length && verifiable) {
    const gone = symbols.filter(n => !s.graph!.nodeIds.has(n)).length;
    if (gone === symbols.length) return { label: 'removed-surface', reasonCode: 'sentinel.compare.symbolRemoved' };
    if (gone) return { label: 'removed-surface', reasonCode: 'sentinel.compare.partRemoved' };
  }
  const cc = checkOf(current, b.ruleFamilyId);
  if (cc === 'none') return { label: 'unassessed-in-current-scope', reasonCode: 'sentinel.compare.noCurrentCheck' };
  if (cc === 'several') return { label: 'unassessed-in-current-scope', reasonCode: 'sentinel.compare.checksConflict' };
  if (cc.status !== 'complete') return { label: 'unassessed-in-current-scope', reasonCode: 'sentinel.compare.checkIncomplete' };
  if (!files.every(f => cc.files.has(f))) return { label: 'unassessed-in-current-scope', reasonCode: 'sentinel.compare.scopeNarrowed' };
  // Resolution needs the issue's code shown to be still there; without a current analysis of its files it is not.
  if (symbols.length && !verifiable) return { label: 'unassessed-in-current-scope', reasonCode: 'sentinel.compare.surfaceUnverified' };
  const bc = checkOf(baseline, b.ruleFamilyId);
  if (bc === 'none' || bc === 'several') return { label: 'incomparable-conditions', reasonCode: 'sentinel.compare.baselineConditionsUnknown' };
  if (!detectionEquivalent(b.ruleFamilyId, bc.conditions, cc.conditions, mappings)) return { label: 'changed-detection', reasonCode: 'sentinel.compare.detectionChanged' };
  if (!same(bc.conditions, cc.conditions, CONDITIONS)) return { label: 'incomparable-conditions', reasonCode: 'sentinel.compare.conditionsDiffer' };
  return { label: 'resolved-by-comparable-check', reasonCode: 'sentinel.compare.comparableCheckClean' };
}
