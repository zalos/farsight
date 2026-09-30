/**
 * Metrics & provenance — the one place a percentage is computed
 * (docs/proposals/v3-build-plan.md §2.3).
 *
 * **No consumer computes a percentage itself.** A KPI card, a journey chip, an
 * export footer and an MCP answer all call `computeMetric` and render what
 * comes back: a value *with* its scope label, its bound (exact or floor), the
 * evidence behind it and the gaps it leaves. That rule is what keeps the number
 * honest in four places at once.
 *
 * `test-coverage` is the first metric (docs/proposals/tests-surface.md §3.3);
 * the id union has room for the rest of the v3 set, which land with P3.
 */
import type { ConfidenceTier, GraphEdge, GraphNode, Loc, ResolutionTechnique, TestRef } from './graph.js';
import type { GraphIndex } from './query.js';
import { isDeclaredOnly, repoOf } from './query.js';

export type MetricId =
  | 'test-coverage'
  // P3 (v3 §2.3) — defined here so the union is stable for consumers:
  | 'sources' | 'indexed' | 'journeys' | 'guard-coverage' | 'guard-coverage-nonroute' | 'described';

export interface MetricDefinition {
  id: MetricId;
  /** bumping is a visible event: a consumer that stored the old value shows `definitionChanged` */
  version: number;
  /** string-catalog key, both registers */
  labelKey: string;
  formula: string;
  includes: string;
  excludes: string;
  companionOf?: MetricId;
}

/** What a metric was computed over. `nodeIds` wins when present; otherwise `repos` filters the whole graph. */
export interface MetricScope {
  kind: 'workspace' | 'source' | 'collection' | 'flow' | 'segment' | 'node';
  /** human label — "the whole workspace", "example-app", "Submit an invoice" */
  label?: string;
  repos?: string[];
  nodeIds?: string[];
  flowId?: string;
}

/** One piece of the evidence (or of the gap) behind a value — what the ⓘ popover lists. */
export interface MetricEvidence {
  nodeId: string;
  name: string;
  loc?: Loc;
  note?: string;
}

export interface MetricValue {
  def: MetricDefinition;
  scope: MetricScope;
  /** always present beside the number: a percentage with no scope is a lie waiting to happen */
  scopeLabel: string;
  numerator: number;
  denominator: number;
  /** null when the denominator is 0 — "nothing to measure", never 0% */
  value: number | null;
  /** floor ⇒ renders "≥ 64%" / "at least 64%" */
  bound: 'exact' | 'floor';
  range?: [number, number];
  /**
   * floor only: what the exact rule could not prove (03 §3.3). `filesUncovered` =
   * members whose file is in no fresh coverage report; `staleRuns` = observed runs
   * whose source moved since. Both uncapped — a JSON consumer gets the whole list.
   */
  uncertainty?: { note: string; affects: string[]; filesUncovered?: string[]; staleRuns?: string[] };
  /** where the numerator's evidence came from */
  origin: { static: number; annotated: number; humanConfirmed: number };
  asOf?: { sync?: number; commit?: string; at?: string; tz?: string };
  /** what backs the numerator */
  evidence: MetricEvidence[];
  /** what the numerator does NOT include — the actionable half (F11: gaps are drawn, not omitted) */
  gaps: MetricEvidence[];
  /** sub-values the same computation yields (test-coverage: unit · e2e · either) */
  parts?: Record<string, { numerator: number; denominator: number; value: number | null }>;
  /**
   * The nodes of a coverable *kind* in scope that the predicate put out of the
   * denominator, by reason and mutually exclusive, so a reader can reconcile:
   * `nodes of a coverable kind in scope = denominator + manifestOnly + plumbing +
   * presentational + declaredOnly` (03 §2.4 — "Anna 2: reconcile to zero").
   */
  excluded: { manifestOnly: number; plumbing: number; presentational: number; declaredOnly: number };
  definitionChanged?: { fromVersion: number; was: string };
}

export const METRICS: Partial<Record<MetricId, MetricDefinition>> = {
  'test-coverage': {
    id: 'test-coverage',
    // v2 (clarity phase A2.5): the coverable predicate excludes manifest-only,
    // plumbing and presentational nodes, integration tests stopped folding into
    // `unit`, and `exact` became a whole-scope rule. A stored v1 value is not
    // comparable with a v2 one — pass `ctx.storedVersion` and the answer says so.
    version: 2,
    labelKey: 'metric.testCoverage',
    formula: 'nodes in scope with ≥1 covers edge ÷ nodes in scope a test could cover',
    includes: 'function, component, page, route, guard and rule nodes in scope that have a source location, are not plumbing and are not presentational',
    excludes: 'test nodes themselves, repo/module/file/api/design/flow/table/queue/external/unknown nodes, manifest-only pages, plumbing, presentational components, declared-only routes',
  },
};

/** What a superseded version of a metric measured — printed beside `definitionChanged`. */
const PRIOR_DEFINITIONS: Partial<Record<MetricId, Record<number, string>>> = {
  'test-coverage': {
    1: 'every function, component, page, route, guard and rule node in scope was in the denominator (manifest-only, plumbing and presentational nodes included), integration tests counted inside the `unit` part, and one digest-verified observed edge made the value exact',
  },
};

/** The kinds a test can be said to cover — the first half of `isCoverable`. */
const COVERABLE = new Set<GraphNode['kind']>(['function', 'component', 'page', 'route', 'guard', 'rule']);

/** Outbound edges that prove a component does work of its own, not just draw. */
const DOES_WORK = new Set<GraphEdge['kind']>(['http', 'reads', 'writes', 'publishes']);

/**
 * A rendered UI primitive — `Button`, `Checkbox`, `Spinner`, `Card`: something
 * another view draws, which reaches nothing and calls nothing outside its own
 * file. Counting those as untested things is how *Program landing* came to read
 * "≥ 78% of 9 coverable nodes" where the nine were `Card`, `Button`, `cx`
 * (the clarity-phase plan R8/R9).
 *
 * The rule, deliberately conservative — anything unproven is **not**
 * presentational, so a component only leaves the denominator when the graph
 * shows it is a leaf:
 * - kind `component`, and
 * - at least one inbound `renders` from a node that is not a `flow` (a flow
 *   renders screens, not primitives — a screen rendered only by its flow stays), and
 * - no outbound `http | reads | writes | publishes`, and
 * - every outbound `calls` resolves to a node in the same file.
 *
 * `SubmissionWizard` fails the last clause (it calls the API client) and stays
 * in the denominator.
 */
export function isPresentational(index: GraphIndex, n: GraphNode): boolean {
  if (n.kind !== 'component') return false;
  const renderedByView = (index.in.get(n.id) ?? []).some((e) => e.kind === 'renders' && index.byId.get(e.from)?.kind !== 'flow');
  if (!renderedByView) return false;
  const file = n.loc?.path;
  for (const e of index.out.get(n.id) ?? []) {
    if (DOES_WORK.has(e.kind)) return false;
    if (e.kind !== 'calls') continue;
    // an unresolved call, or one leaving the file, is work we cannot dismiss
    const target = index.byId.get(e.to);
    if (!file || target?.loc?.path !== file) return false;
  }
  return true;
}

/**
 * **The one coverable predicate.** Every denominator in the product comes from
 * here: the journey fold, the catalogue, the matrix and `computeMetric` all ask
 * this question and get the same answer (R9 — "one denominator per scope").
 *
 * Out of the denominator: a node of a kind no test can cover; a **manifest-only**
 * node with no source location (a screen that is designed but not built cannot
 * be untested — it does not exist yet); anything tagged `plumbing`
 * (`farsight.config.json → plumbing`); and a rendered UI primitive.
 */
export function isCoverable(index: GraphIndex, n: GraphNode): boolean {
  return COVERABLE.has(n.kind)
    && !!n.loc
    && !(n.tags ?? []).includes('plumbing')
    && !isPresentational(index, n);
}

/** Is this node inside the scope? */
function inScope(node: GraphNode, scope: MetricScope, ids: Set<string> | null): boolean {
  if (ids) return ids.has(node.id);
  if (scope.repos?.length) return scope.repos.includes(repoOf(node));
  return true;
}

export interface CoveringTest {
  id: string;
  name: string;
  level: TestRef['level'];
  runner: TestRef['runner'];
  /** the strongest evidence class this test contributes to the node */
  evidence: 'declared' | 'static' | 'observed';
  runLevel: boolean;
  loc?: Loc;
  run?: TestRef['run'];
  /** the case is `.skip`/`.todo`, or the edge it emitted is marked inactive — it lifts no word and no chip */
  inactive?: boolean;
  /** the Playwright / Nx project of the run behind this case */
  project?: string;
  retries?: number;
  /** the covers edge's resolution, so a list can print how the edge was found */
  technique?: ResolutionTechnique;
  confidence?: ConfidenceTier;
  note?: string;
  /** observed edges: how the coverage row met the node (`name+line` · `name` · `line±1`) */
  match?: string;
  /**
   * `declaration`: the edge is an `@covers` claim, and a results report says the
   * end-to-end case that makes it **passed** — so the case counts as observed
   * for what it declares, worded *passed, by its own declaration*. No coverage
   * data is involved (a Playwright run produces none), which is why it is carried
   * apart from an observed edge a coverage report measured. The class stays one
   * of the three; this is the way it was earned (docs/COUNTS.md §2 #13).
   */
  observedVia?: 'declaration';
  /** run-level nodes only: every file the coverage report contained — the whole-scope exactness rule reads it */
  files?: string[];
}

export const EVIDENCE_RANK: Record<string, number> = { declared: 1, static: 2, observed: 3 };

/**
 * Which tests cover one node, strongest evidence first. Pure and cheap — the
 * shared primitive under the metric, the journey fold and `/api/tests`.
 */
export function testsCovering(index: GraphIndex, nodeId: string): CoveringTest[] {
  const out: CoveringTest[] = [];
  for (const e of index.in.get(nodeId) ?? []) {
    if (e.kind !== 'covers') continue;
    const t = index.byId.get(e.from);
    if (!t?.test) continue;
    const edgeClass = (e.meta?.evidence as CoveringTest['evidence']) ?? 'declared';
    // the case is .skip/.todo, or the edge was emitted by one: kept in the list,
    // never allowed to speak for the node (graph.ts, covers `meta.inactive`)
    const inactive = e.meta?.inactive === true || t.test.inactive === true;
    // *verified* has one meaning (docs/COUNTS.md): a results report named a case
    // that ran over this code. A declared end-to-end case the report names as
    // passed meets it for what it declares — a Playwright run leaves no coverage
    // data, so without this every reference-app flow read `0 seen in a run` under a
    // source card that said `89 passed` (story swarm 2026-09-25, 8 of 8). A
    // failed, flaky, skipped or unrun case stays declared.
    const byDeclaration = edgeClass === 'declared' && t.test.level === 'e2e' && !t.test.runLevel && !inactive
      && t.test.run?.status === 'passed';
    const evidence: CoveringTest['evidence'] = byDeclaration ? 'observed' : edgeClass;
    out.push({
      id: t.id, name: t.name, level: t.test.level, runner: t.test.runner, evidence,
      ...(byDeclaration ? { observedVia: 'declaration' as const } : {}),
      runLevel: !!t.test.runLevel,
      ...(inactive ? { inactive: true } : {}),
      ...(t.loc ? { loc: t.loc } : {}),
      ...(t.test.run ? { run: t.test.run } : {}),
      ...(t.test.run?.project ? { project: t.test.run.project } : t.test.project ? { project: t.test.project } : {}),
      ...(t.test.run?.retries != null ? { retries: t.test.run.retries } : {}),
      ...(e.resolution ? { technique: e.resolution.technique, confidence: e.resolution.confidence, ...(e.resolution.note ? { note: e.resolution.note } : {}) } : {}),
      ...(e.meta?.match ? { match: String(e.meta.match) } : {}),
      ...(t.test.files?.length ? { files: t.test.files } : {}),
    });
  }
  // an inactive case sorts last so the strongest *active* evidence is out[0]
  return out.sort((a, b) =>
    (a.inactive === b.inactive ? 0 : a.inactive ? 1 : -1)
    || (EVIDENCE_RANK[b.evidence]! - EVIDENCE_RANK[a.evidence]!)
    || a.name.localeCompare(b.name));
}

/**
 * Compute a metric over a scope. Throws for an id this build does not implement
 * yet — a consumer must never silently render a made-up number.
 *
 * `ctx.cap` truncates the `evidence` and `gaps` lists for a **text** printer
 * only; the JSON path passes nothing and gets everything (03 §2.4 — `MAX_LIST`
 * was losing rows of the matrix). `ctx.storedVersion` is the version a consumer
 * saved a previous value under: a lower one comes back as `definitionChanged`.
 */
export function computeMetric(
  index: GraphIndex,
  id: MetricId,
  scope: MetricScope = { kind: 'workspace' },
  ctx: { asOf?: MetricValue['asOf']; cap?: number; storedVersion?: number } = {},
): MetricValue {
  const def = METRICS[id];
  if (!def) throw new Error(`metric "${id}" is not implemented in this build (implemented: ${Object.keys(METRICS).join(', ')})`);
  if (id !== 'test-coverage') throw new Error(`metric "${id}" has a definition but no computation in this build`);

  const cap = ctx.cap ?? Infinity;
  const ids = scope.nodeIds?.length ? new Set(scope.nodeIds) : null;
  const members: GraphNode[] = [];
  // every node of a coverable *kind* in scope is either a member or excluded for
  // exactly one reason, so the two reconcile (03 §2.4)
  const excluded = { manifestOnly: 0, plumbing: 0, presentational: 0, declaredOnly: 0 };
  for (const n of index.byId.values()) {
    if (n.kind === 'test' || !COVERABLE.has(n.kind)) continue;
    if (!inScope(n, scope, ids)) continue;
    if (isCoverable(index, n)) { members.push(n); continue; }
    if (isDeclaredOnly(n)) excluded.declaredOnly++;
    else if (!n.loc) excluded.manifestOnly++;
    else if ((n.tags ?? []).includes('plumbing')) excluded.plumbing++;
    else excluded.presentational++;
  }

  const evidence: MetricEvidence[] = [];
  const gaps: MetricEvidence[] = [];
  const origin = { static: 0, annotated: 0, humanConfirmed: 0 };
  const parts = {
    unit: { numerator: 0, denominator: members.length, value: null as number | null },
    integration: { numerator: 0, denominator: members.length, value: null as number | null },
    e2e: { numerator: 0, denominator: members.length, value: null as number | null },
  };
  let covered = 0;
  let anyObserved = false;
  let anyDeclaredPass = false;
  let allObservedFresh = true;
  const staleRuns = new Set<string>();
  // the files a *fresh* coverage report in this scope actually contained: the
  // only files whose "no test reaches this" is a measurement rather than a guess
  const freshFiles = new Set<string>();

  for (const n of members) {
    const tests = testsCovering(index, n.id);
    if (!tests.length) {
      if (gaps.length < cap) gaps.push({ nodeId: n.id, name: n.name, ...(n.loc ? { loc: n.loc } : {}), note: 'no test reaches this' });
      continue;
    }
    covered++;
    if (tests.some((t) => t.level === 'unit')) parts.unit.numerator++;
    if (tests.some((t) => t.level === 'integration')) parts.integration.numerator++;
    if (tests.some((t) => t.level === 'e2e')) parts.e2e.numerator++;
    // an annotation is still an annotation when its case passed: the origin is the claim
    if (tests.every((t) => t.evidence === 'declared' || t.observedVia === 'declaration')) origin.annotated++;
    else origin.static++;
    for (const t of tests) {
      if (t.evidence !== 'observed') continue;
      // a pass by declaration measured no line: it never makes a count exact
      if (t.observedVia === 'declaration') { anyDeclaredPass = true; continue; }
      anyObserved = true;
      if (t.run?.freshness === 'unchanged') {
        if (t.runLevel) for (const f of t.files ?? []) freshFiles.add(f);
      } else {
        allObservedFresh = false;
        staleRuns.add(t.name);
      }
    }
    if (evidence.length < cap) {
      evidence.push({
        nodeId: n.id, name: n.name, ...(n.loc ? { loc: n.loc } : {}),
        note: `${tests.length} test${tests.length === 1 ? '' : 's'} · ${[...new Set(tests.map((t) => t.evidence))].join(' + ')}`,
      });
    }
  }

  const denominator = members.length;
  const value = denominator ? covered / denominator : null;
  // Exactness is whole-scope (03 §3.3): a report proves a *file*, not a node, so
  // "0 tests reach this" is only a measurement when a fresh report contained the
  // file. One fresh run beside members no report saw is still a floor.
  const filesUncovered = [...new Set(members.map((m) => m.loc!.path).filter((path) => !freshFiles.has(path)))].sort();
  const bound: MetricValue['bound'] = anyObserved && allObservedFresh && !filesUncovered.length ? 'exact' : 'floor';
  parts.unit.value = denominator ? parts.unit.numerator / denominator : null;
  parts.integration.value = denominator ? parts.integration.numerator / denominator : null;
  parts.e2e.value = denominator ? parts.e2e.numerator / denominator : null;

  let uncertainty: MetricValue['uncertainty'];
  if (bound === 'floor') {
    if (!anyObserved) {
      uncertainty = {
        note: anyDeclaredPass
          ? 'no coverage run has been observed — the end-to-end cases that passed count by their own declaration, which measures no line — so the value is a floor'
          : 'declared and inferred evidence only — no run has been observed, so the value is a floor',
        affects: gaps.slice(0, 20).map((g) => g.nodeId),
      };
    } else if (!allObservedFresh) {
      uncertainty = {
        note: 'the coverage report cannot be proven to match this source, so the value is a floor',
        affects: [...staleRuns].slice(0, 20),
        staleRuns: [...staleRuns],
      };
    } else {
      uncertainty = {
        note: `${filesUncovered.length} file${filesUncovered.length === 1 ? '' : 's'} in this scope ${filesUncovered.length === 1 ? 'is' : 'are'} in no fresh coverage report, so the value is a floor`,
        affects: filesUncovered.slice(0, 20),
        filesUncovered,
      };
    }
  }

  const wasDefinition = ctx.storedVersion != null && ctx.storedVersion < def.version
    ? PRIOR_DEFINITIONS[id]?.[ctx.storedVersion]
    : undefined;

  return {
    def,
    scope,
    scopeLabel: scopeLabelOf(scope, denominator),
    numerator: covered,
    denominator,
    value,
    bound,
    ...(bound === 'floor' && value != null ? { range: [value, 1] as [number, number] } : {}),
    ...(uncertainty ? { uncertainty } : {}),
    origin,
    ...(ctx.asOf ? { asOf: ctx.asOf } : {}),
    evidence,
    gaps,
    parts: { ...parts, either: { numerator: covered, denominator, value } },
    excluded,
    ...(ctx.storedVersion != null && ctx.storedVersion < def.version
      ? { definitionChanged: { fromVersion: ctx.storedVersion, was: wasDefinition ?? `version ${ctx.storedVersion} of ${def.id}, which this build no longer computes` } }
      : {}),
  };
}

/** "3 of 11 things in Submit an invoice" — the sentence that must never be separated from the number. */
export function scopeLabelOf(scope: MetricScope, denominator: number): string {
  const what = `${denominator} coverable node${denominator === 1 ? '' : 's'}`;
  if (scope.label) return `${what} in ${scope.label}`;
  if (scope.kind === 'workspace') return `${what} across the whole workspace`;
  if (scope.repos?.length) return `${what} in ${scope.repos.join(', ')}`;
  return what;
}

/** "≥ 64%" / "64%" / "nothing to measure" — one rendering, so every surface says it the same way. */
export function formatMetric(m: MetricValue): string {
  if (m.value == null) return 'nothing to measure';
  const pct = `${Math.round(m.value * 100)}%`;
  return m.bound === 'floor' ? `≥ ${pct}` : pct;
}
