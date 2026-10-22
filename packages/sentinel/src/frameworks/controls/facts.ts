// Framework control inspection (PRs 14–17 wiring, ADR 44): from the control-fact envelopes the four reviewed framework
// libraries emit for one captured source, to the coverage of the plan's inspection checks and one inspection report.
//
// These are inspection facts, never an assessment. `applies` and `does-not-apply` both mean only that the library
// established, within its exact supported scope, whether the property's control applies to the surface; neither is a
// finding, an observation or a policy failure (a route deliberately left outside middleware, or one with no body to
// validate, is not a problem by itself). Policy over these facts is a later, separate step (PR 20).
//
// A check (surface S, property P) is complete only when every library that claims S resolved every position it gives
// for P, and those libraries agree; one library's positions fold along the request path (any position applying
// means the control applies). Anything less stays visible: an unknown fact or disagreeing claims leave it partial with the
// library's own reason; no claim, a property the claiming library does not model, or a library that could not run
// over the source leaves it not run with its reason. Pure: no I/O.
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
  readonly granularity: 'per-file-per-rule';
  readonly coveredChecks: { checkId: string; coverage: string }[];
  readonly scannedSet: string[];
  readonly skipped: ScopedReason[];
  readonly unresolvedFrontiers: ScopedReason[];
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

/**
 * Coverage and inspection rows for the assigned checks. `report` is the digest the covered checks name (the
 * inspection report's identity, computed by the caller); `sourceId` scopes source-wide frontiers.
 */
export function inspect(checks: readonly InspectionCheck[], libraries: readonly LibraryOutcome[], sourceId: string, report: string): { coverage: InspectionCoverage; rows: InspectedRow[] } {
  const covered = new Set<string>();
  const scanned = new Set<string>();
  const skipped = new Map<string, ScopedReason>();
  const frontiers = new Map<string, ScopedReason>();
  const skip = (scopeId: string, reasonCode: string) => skipped.set(`${scopeId}\u0000${reasonCode}`, { scopeId, reasonCode });
  const frontier = (scopeId: string, reasonCode: string) => frontiers.set(`${scopeId}\u0000${reasonCode}`, { scopeId, reasonCode });
  // A library's frontiers bear on the inspection only where it found its framework (it claims some surface): the
  // Nest library's "no bootstrap" in a repository without Nest limits nothing. They stay in the report either way.
  for (const lib of libraries) {
    if (!lib.envelopes.some(e => e.facts.length > 0)) continue;
    for (const f of lib.frontiers ?? []) frontier(f.scopeId, f.reasonCode);
    for (const env of lib.envelopes) for (const f of env.frontiers) frontier(f.scopeId, f.reasonCode);
  }
  // A library that could not run over the source may have claimed any surface: every check bears that gap.
  const refused = libraries.filter(l => l.refused);
  const rows: InspectedRow[] = [];
  for (const check of checks) {
    const property = CONTROL_FAMILIES[check.familyId];
    if (!property) { skip(check.scopeId, 'sentinel.controls.familyUnsupported'); continue; }
    const claiming = libraries.filter(l => l.envelopes.some(e => e.facts.some(f => f.surfaceId === check.scopeId)));
    const claims = claiming.flatMap(l => l.envelopes.flatMap(e => e.facts.filter(f => f.surfaceId === check.scopeId && f.property === property)
      .map(f => ({ framework: l.framework, verdict: f.verdict, factId: f.id, reasonCode: f.reasonCode }))));
    const row = (state: InspectedRow['state'], verdict: InspectedRow['verdict'], reasonCode: string | null) =>
      rows.push({ surfaceId: check.scopeId, property, state, verdict, reasonCode, claims: claims.map(({ reasonCode: _r, ...c }) => c) });
    if (!claiming.length) {
      const why = refused.length ? refused[0]!.refused! : 'sentinel.controls.unclaimed';
      skip(check.scopeId, why); row('not-run', null, why); continue;
    }
    if (!claims.length) { skip(check.scopeId, 'sentinel.controls.propertyNotModeled'); row('not-run', null, 'sentinel.controls.propertyNotModeled'); continue; }
    covered.add(check.id);
    scanned.add(check.scopeId);
    const unknown = claims.find(c => c.verdict === 'unknown');
    // One library's facts for a property are positions along the request path (a Spring chain, then method
    // security): its control applies when any position applies. Only libraries that disagree are a conflict.
    const answering = claiming.filter(l => claims.some(c => c.framework === l.framework));
    const verdicts = new Set(answering.map(l => (claims.some(c => c.framework === l.framework && c.verdict === 'applies') ? 'applies' : 'does-not-apply')));
    // A refused library could also have claimed this surface: what the others established is then not the whole story.
    const limits: string[] = [];
    if (unknown) limits.push(unknown.reasonCode ?? 'sentinel.controls.conflict');
    else if (verdicts.size > 1) limits.push('sentinel.controls.conflict');
    for (const l of refused) limits.push(l.refused!);
    for (const r of limits) skip(check.scopeId, r);
    if (limits.length) row('partial', null, limits[0]!);
    else row('established', [...verdicts][0] as Exclude<ControlVerdict, 'unknown'>, null);
  }
  const sort = <T>(xs: Iterable<T>, key: (x: T) => string) => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return {
    coverage: {
      granularity: 'per-file-per-rule',
      coveredChecks: sort(covered, x => x).map(checkId => ({ checkId, coverage: report })),
      scannedSet: sort(scanned, x => x),
      skipped: sort(skipped.values(), x => `${x.scopeId}\u0000${x.reasonCode}`),
      unresolvedFrontiers: sort(frontiers.values(), x => `${x.scopeId}\u0000${x.reasonCode}`),
    },
    rows: sort(rows, r => `${r.surfaceId}\u0000${r.property}`),
  };
}

/** The inspection report record value: facts with their supported scope, explicitly not an assessment. */
export function inspectionReport(binding: Readonly<Record<string, unknown>>, libraries: readonly LibraryOutcome[], rows: readonly InspectedRow[],
  scope: Readonly<Record<FrameworkName, { readonly versions: Readonly<Record<string, string>>; readonly properties: readonly string[] }>>) {
  return {
    ...binding, kind: 'framework-inspection' as const, assessment: 'none' as const,
    libraries: libraries.map(l => ({
      framework: l.framework, packDigest: l.packDigest, ran: !l.refused, ...(l.refused ? { reasonCode: l.refused } : {}),
      versions: l.envelopes.map(e => e.framework.version), envelopes: l.envelopes.length, supportedScope: scope[l.framework],
    })),
    inspected: rows,
    counts: {
      established: rows.filter(r => r.state === 'established').length, partial: rows.filter(r => r.state === 'partial').length,
      notRun: rows.filter(r => r.state === 'not-run').length,
    },
  };
}
