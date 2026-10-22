// Framework control inspection (PRs 14–17 wiring, ADR 44): from the control-fact envelopes the four reviewed framework
// libraries emit for one captured source, to the coverage of the plan's inspection checks and one inspection report.
//
// These are inspection facts, never an assessment. `applies` and `does-not-apply` both mean only that the library
// established, within its exact supported scope, whether the property's control applies to the surface; neither is a
// finding, an observation or a policy failure (a route deliberately left outside middleware, or one with no body to
// validate, is not a problem by itself). Policy over these facts is a later, separate step (PR 20).
//
// The plan's inspection checks are repository-scoped: one per family and source, whose sealed inputs are every captured
// file of the source (the libraries read configuration, manifests and code, not one surface's file). The check's
// extent is every surface the parser indexed (the planner's route and page nodes) for the family's property; each
// surface keeps its own row in the report. A check is complete only when every surface in the extent is established
// and no library that found its framework left a frontier. A surface is established when every library that claims
// it resolved every position it gives for the property and those libraries agree; one library's positions fold along
// the request path (any position applying means the control applies). An unknown position, disagreeing libraries, an
// unclaimed surface, a property the claiming library does not model, a frontier or a refused library each leave the
// check partial with that reason; every library refusing leaves it not run. Pure: no I/O.
import type { ControlFactsEnvelope, ControlProperty, ControlVerdict } from '../../contracts/controls.js';
import type { ScopedReason } from '../../contracts/common.js';

export type InspectedProperty = Extract<ControlProperty, 'authentication' | 'authorization' | 'input-validation'>;
/** The inspection rule families, one per property the libraries actually model. No other property is inspected. */
export const CONTROL_FAMILIES: Readonly<Record<string, InspectedProperty>> = Object.freeze({
  'sentinel.controls.authentication': 'authentication',
  'sentinel.controls.authorization': 'authorization',
  'sentinel.controls.input-validation': 'input-validation',
});
export const INSPECTED_PROPERTIES: readonly InspectedProperty[] = Object.freeze(['authentication', 'authorization', 'input-validation'] as const);
export const FRAMEWORKS = Object.freeze(['next', 'express', 'nest', 'spring'] as const);
export type FrameworkName = typeof FRAMEWORKS[number];

export const CONTROLS_REASONS = Object.freeze([
  'sentinel.controls.unclaimed', 'sentinel.controls.propertyNotModeled', 'sentinel.controls.conflict',
  'sentinel.controls.analysisUnavailable', 'sentinel.controls.libraryRefused', 'sentinel.controls.familyUnsupported',
  'sentinel.controls.surfaceExtentUnproven', 'sentinel.controls.surfaceOutsideExtent',
] as const);
export type ControlsReason = typeof CONTROLS_REASONS[number];

/** What one library did over the source: its envelopes, or the fixed reason it could not run. */
export interface LibraryOutcome {
  readonly framework: FrameworkName;
  /** The library's pack digest from its envelopes; null when it emitted none (it refused, or found nothing). */
  readonly packDigest: string | null;
  readonly envelopes: readonly ControlFactsEnvelope[];
  /** Set when the library refused its inputs; its envelopes are then empty. Never engine or source text. */
  readonly refused?: ControlsReason;
  /** Source-wide frontiers outside the envelopes (Next's surfaces no project routes). */
  readonly frontiers?: readonly ScopedReason[];
}

/** An inspection check as the plan assigned it. */
export interface InspectionCheck { readonly id: string; readonly familyId: string; readonly scopeId: string }

export interface InspectionCoverage {
  readonly granularity: 'aggregate';
  readonly coveredChecks: { checkId: string; coverage: string }[];
  readonly scannedSet: string[];
  readonly skipped: ScopedReason[];
  readonly unresolvedFrontiers: ScopedReason[];
}

/**
 * One check's own inspection state. The plan's coverage attributes limits by scope, and every family's check for a
 * source shares the source's scope, so coverage is the conservative union; this is the per-family answer.
 */
export interface CheckInspection {
  readonly checkId: string;
  readonly familyId: string;
  readonly state: 'complete' | 'partial' | 'not-run';
  readonly reasons: readonly string[];
}

export interface InspectedRow {
  readonly surfaceId: string;
  readonly property: InspectedProperty;
  readonly state: 'established' | 'partial' | 'not-run';
  /** The agreed verdict when established; null otherwise. */
  readonly verdict: Exclude<ControlVerdict, 'unknown'> | null;
  readonly reasonCode: string | null;
  /** The claiming libraries and their own verdict. */
  readonly claims: readonly { readonly framework: FrameworkName; readonly verdict: ControlVerdict; readonly factId: string }[];
}

/** Whether a library found its framework in the source: it claims a surface, resolved a version or names a source gap. */
export function libraryPresent(lib: LibraryOutcome): boolean {
  if (lib.refused) return false;
  return (lib.frontiers?.length ?? 0) > 0 || lib.envelopes.some(e => e.facts.length > 0 || e.framework.version !== null);
}

/**
 * Coverage of the assigned repository-scoped checks and one row per surface and inspected property. `surfaces` is the
 * extent (the parser's route and page node ids for this source, as the planner reads them); `report` is the digest the
 * covered checks name (the inspection report's identity, computed by the caller).
 */
export function inspect(checks: readonly InspectionCheck[], libraries: readonly LibraryOutcome[], surfaces: readonly string[], report: string): { coverage: InspectionCoverage; rows: InspectedRow[]; checks: CheckInspection[] } {
  const states: CheckInspection[] = [];
  const covered = new Set<string>();
  const scanned = new Set<string>();
  const skipped = new Map<string, ScopedReason>();
  const frontiers = new Map<string, ScopedReason>();
  const skip = (scopeId: string, reasonCode: string) => skipped.set(`${scopeId}\u0000${reasonCode}`, { scopeId, reasonCode });
  // A library's frontiers bear on the inspection only where it found its framework: the Nest library's "no bootstrap"
  // in a repository without Nest limits nothing. They stay in the report either way.
  for (const lib of libraries.filter(libraryPresent)) {
    for (const f of lib.frontiers ?? []) frontiers.set(`${f.scopeId}\u0000${f.reasonCode}`, f);
    for (const env of lib.envelopes) for (const f of env.frontiers) frontiers.set(`${f.scopeId}\u0000${f.reasonCode}`, f);
  }
  const refused = libraries.filter(l => l.refused);
  const extent = [...new Set(surfaces)].sort();
  const extentIds = new Set(extent);
  // No trusted empty-surface proof exists in this slice. A recognised framework with no indexed route/page is
  // unanswered, not vacuously complete; a library may also name facts the index did not classify as a surface.
  // Keep either mismatch as one bounded source-wide reason rather than inventing rows or silently dropping it.
  const emptyExtent = extent.length === 0 && libraries.some(libraryPresent);
  const outsideExtent = libraries.some(l => l.envelopes.some(e => e.facts.some(f => !extentIds.has(f.surfaceId))));
  const rows: InspectedRow[] = [];
  const rowsFor = new Map<InspectedProperty, InspectedRow[]>();
  const rowsOf = (property: InspectedProperty): InspectedRow[] => {
    const have = rowsFor.get(property);
    if (have) return have;
    const out: InspectedRow[] = [];
    for (const surfaceId of extent) {
      const claiming = libraries.filter(l => l.envelopes.some(e => e.facts.some(f => f.surfaceId === surfaceId)));
      const claims = claiming.flatMap(l => l.envelopes.flatMap(e => e.facts.filter(f => f.surfaceId === surfaceId && f.property === property)
        .map(f => ({ framework: l.framework, verdict: f.verdict, factId: f.id, reasonCode: f.reasonCode }))));
      const row = (state: InspectedRow['state'], verdict: InspectedRow['verdict'], reasonCode: string | null) =>
        out.push({ surfaceId, property, state, verdict, reasonCode, claims: claims.map(({ reasonCode: _r, ...c }) => c) });
      if (!claiming.length) { row('not-run', null, refused.length ? refused[0]!.refused! : 'sentinel.controls.unclaimed'); continue; }
      if (!claims.length) { row('not-run', null, 'sentinel.controls.propertyNotModeled'); continue; }
      const unknown = claims.find(c => c.verdict === 'unknown');
      // Every library that claims the surface must answer the property: one that claims it and gives no fact for P
      // (Express claims a route and models no input validation) leaves P unanswered there, whatever another says.
      const silent = claiming.some(l => !claims.some(c => c.framework === l.framework));
      // One library's facts for a property are positions along the request path (a Spring chain, then method
      // security): its control applies when any position applies. Only libraries that disagree are a conflict.
      const verdicts = new Set(claiming.map(l => (claims.some(c => c.framework === l.framework && c.verdict === 'applies') ? 'applies' : 'does-not-apply')));
      // A refused library could also have claimed this surface: what the others established is then not the whole story.
      const limit = unknown ? (unknown.reasonCode ?? 'sentinel.controls.conflict') : silent ? 'sentinel.controls.propertyNotModeled'
        : verdicts.size > 1 ? 'sentinel.controls.conflict' : refused[0]?.refused ?? null;
      if (limit) row('partial', null, limit);
      else row('established', [...verdicts][0] as Exclude<ControlVerdict, 'unknown'>, null);
    }
    rowsFor.set(property, out);
    rows.push(...out);
    return out;
  };
  for (const check of checks) {
    const property = CONTROL_FAMILIES[check.familyId];
    const done = (state: CheckInspection['state'], reasons: Iterable<string>) => {
      const r = [...new Set(reasons)].sort();
      for (const x of r) skip(check.scopeId, x);
      states.push({ checkId: check.id, familyId: check.familyId, state, reasons: r });
    };
    if (!property) { done('not-run', ['sentinel.controls.familyUnsupported']); continue; }
    // Every library refused: nothing was inspected for this check.
    if (libraries.length > 0 && refused.length === libraries.length) { done('not-run', refused.map(l => l.refused!)); continue; }
    const mine = rowsOf(property);
    covered.add(check.id);
    scanned.add(check.scopeId);
    const reasons = [...(emptyExtent ? ['sentinel.controls.surfaceExtentUnproven'] : []), ...(outsideExtent ? ['sentinel.controls.surfaceOutsideExtent'] : []), ...mine.filter(r => r.state !== 'established').map(r => r.reasonCode!), ...refused.map(l => l.refused!), ...[...frontiers.values()].map(f => f.reasonCode)];
    done(reasons.length ? 'partial' : 'complete', reasons);
  }
  const sort = <T>(xs: Iterable<T>, key: (x: T) => string) => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return {
    coverage: {
      granularity: 'aggregate',
      coveredChecks: sort(covered, x => x).map(checkId => ({ checkId, coverage: report })),
      scannedSet: sort(scanned, x => x),
      skipped: sort(skipped.values(), x => `${x.scopeId}\u0000${x.reasonCode}`),
      unresolvedFrontiers: sort(frontiers.values(), x => `${x.scopeId}\u0000${x.reasonCode}`),
    },
    rows: sort(rows, r => `${r.surfaceId}\u0000${r.property}`),
    checks: sort(states, c => c.checkId),
  };
}

/** The inspection report record value: facts with their supported scope, explicitly not an assessment. */
export function inspectionReport(binding: Readonly<Record<string, unknown>>, libraries: readonly LibraryOutcome[], rows: readonly InspectedRow[], checks: readonly CheckInspection[],
  scope: Readonly<Record<FrameworkName, { readonly versions: Readonly<Record<string, string>>; readonly properties: readonly string[] }>>) {
  return {
    ...binding, kind: 'framework-inspection' as const, assessment: 'none' as const,
    libraries: libraries.map(l => ({
      framework: l.framework, packDigest: l.packDigest, ran: !l.refused, ...(l.refused ? { reasonCode: l.refused } : {}),
      versions: l.envelopes.map(e => e.framework.version), envelopes: l.envelopes.length, supportedScope: scope[l.framework],
    })),
    checks, inspected: rows,
    counts: {
      established: rows.filter(r => r.state === 'established').length, partial: rows.filter(r => r.state === 'partial').length,
      notRun: rows.filter(r => r.state === 'not-run').length,
    },
  };
}
