/**
 * Coverage as a fold over the graph — what a journey, a segment or a single
 * step is verified by (docs/proposals/tests-surface.md §3.3, §4.2).
 *
 * Kept in its own module on purpose: `journeySummary()` calls it in one line so
 * the tests branch and the journey branch merge without fighting over
 * query.ts (docs/proposals/journey-views-pass-2026-09.md §3).
 *
 * The vocabulary is the swarm's glossary and it is load-bearing, and it is
 * exactly three rungs: **declared only** = a test author claims it and nothing
 * imported or ran · **reached by tests** = a test *body* imports, renders or
 * requests it (static evidence, a floor) · **verified by a run** = a results or
 * coverage report saw it run — or a results report says an end-to-end case
 * passed and the case declares it (`observedBy: 'declaration'`, worded *passed,
 * by its own declaration*: a way of earning the third rung, not a fourth).
 * Nothing below the third rung may wear the word *verified*, and no surface
 * may invent a fourth rung.
 */
import type { ConfidenceTier, GraphNode, ResolutionTechnique, TestRef, Loc } from './graph.js';
import type { GraphIndex, Journey, JourneySummary } from './query.js';
import { flowScreenIds, isDeclaredOnly, journey } from './query.js';
import { computeMetric, testsCovering, EVIDENCE_RANK, type MetricValue, type MetricScope, type CoveringTest } from './metrics.js';
import { counted, type Counted, type CountScope } from './counts.js';

/**
 * The test counts of one scope as typed counts (docs/COUNTS.md): every number
 * the tests foot, the flow status table's TESTED cell and the business
 * sentence print, with the scope it counts over. `e2e` is the number the
 * reviewers met as `80` on Portfolio, `13` on a screen and `91` on the Tests
 * page — three scopes (this journey · this screen · the source), now each
 * saying which. Every level count breaks down by the three evidence classes,
 * so `80 e2e` carries `0 seen in a run` beside it wherever it is printed.
 */
export interface CoverageCounted {
  /** distinct cases, every level; breakdown by level */
  tests: Counted;
  e2e: Counted;
  unit: Counted;
  integration: Counted;
  /**
   * cases a results report named running over this scope; breakdown: named by a
   * run's coverage · passed, by their own declaration (an e2e `@covers` whose case passed)
   */
  observed: Counted;
  /** coverage reports that saw this scope run — never cases */
  runReports: Counted;
}

/**
 * The run that earned the observed class — kept apart from `run`/`lastRun`,
 * which are the covering tests' own last runs whatever their evidence here. A
 * surface that prints *verified* or *seen by a coverage run* prints this run
 * beside it: `VERIFIED · STALE` sat above `LAST RUN skipped` because the chip
 * came from a 2026-09-22 coverage report and the run line from the covering
 * cases' 2026-09-25 results (pass swarm 2026-09-25, staff engineer's blocker).
 */
export interface CoverageObservation {
  by: 'tests' | 'declaration' | 'runs';
  /** the most recent observing run */
  at: string;
  /** the weakest verdict across the observing refs — a coverage report records `unknown` */
  status: NonNullable<TestRef['run']>['status'];
  freshness: NonNullable<TestRef['run']>['freshness'];
  /** `changed` only: a new commit, or the same commit with a working tree that differs from HEAD */
  changedBy?: NonNullable<TestRef['run']>['changedBy'];
  /** observing cases (named by a results report) and observing coverage reports */
  cases: number;
  reports: number;
  /** of `cases`, the ones that observe by their own declaration (a passed e2e `@covers`) */
  declared?: number;
}

/** One test on a coverage foot — enough to render the chip and open the detail. */
export interface CoverageTestRef {
  id: string;
  name: string;
  level: TestRef['level'];
  runner: TestRef['runner'];
  evidence: 'declared' | 'static' | 'observed';
  /** `declaration`: observed because a results report says this e2e case passed, for what its `@covers` declares — no coverage measured it */
  observedVia?: 'declaration';
  /** the edge came from a run-level node: *reached by the run*, never *by this test* */
  runLevel: boolean;
  status?: NonNullable<TestRef['run']>['status'];
  at?: string;
  freshness?: NonNullable<TestRef['run']>['freshness'];
  /** `changed` only: a new commit, or the same commit with a working tree that differs from HEAD */
  changedBy?: NonNullable<TestRef['run']>['changedBy'];
  stale?: boolean;
  loc?: Loc;
  /** `.skip`/`.todo`: the case exists and is listed, and it lifts no word and no chip */
  inactive?: boolean;
  /** the Playwright / Nx project of the run behind this case */
  project?: string;
  retries?: number;
  /** the node **in this scope** the test's edge lands on — judge a helper by what it reached */
  reaches: { nodeId: string; name: string; kind: GraphNode['kind'] };
  /** a table reached through an accessor rather than directly: the accessor's node id */
  via?: string;
  /** `reaches` was picked by method name over a set-aside double — the note says which */
  twin?: { note: string; nodeId: string };
  technique?: ResolutionTechnique;
  confidence?: ConfidenceTier;
  note?: string;
}

/** What one scope (a journey, a segment, a step) is verified by. */
export interface CoverageFacts {
  /** the metric for this scope — value, bound, scopeLabel, evidence and gaps. No consumer recomputes it. */
  metric: MetricValue;
  counts: {
    /** node counts, from the metric */
    nodes: number; covered: number; unit: number; integration: number; e2e: number; declared: number; observed: number;
    /** distinct test **cases** with an observed edge here (run-level nodes apart) */
    observedTests: number;
    /**
     * distinct test cases per level — the foot's line. A run-level node is a report, counted apart.
     * `observed` includes `declaredPassed`: the cases observed by their own declaration.
     */
    tests: { unit: number; integration: number; e2e: number; observed: number; runLevel: number; declaredPassed: number };
  };
  /**
   * The strongest end-to-end evidence on this scope (README, "the `e2e ✓` body
   * rule"): `declared` = a header `@covers` and nothing more · `reached` = a test
   * *body* imports, renders or requests something in scope · `observed` = a run
   * saw it. Inactive cases lift nothing.
   */
  e2e: 'none' | 'declared' | 'reached' | 'observed';
  /** the node and test that lifted the word, and the other journeys whose scope holds that node */
  e2eVia?: {
    nodeId: string; name: string; testId: string; testName: string;
    /** the lifting test's own spec file — carried, never parsed back out of the id by a consumer */
    file?: string;
    line?: number; sharedWith: { id: string; name: string }[];
    /** `declaration`: the lifting case is observed because it passed, for what it declares */
    via?: 'declaration';
  };
  /**
   * *Verified* means a run saw it, so this is `e2e === 'observed'` and nothing
   * weaker. `reached` says a Playwright body carries a route literal — those
   * edges are stamped `route-literal` LOW — and a static match is not a
   * verification (swarm 2026-09-23, blocker 6). A consumer that wants to know
   * whether any end-to-end test exists reads `e2e`, which names its own rung.
   */
  verifiedEndToEnd: boolean;
  /** one chip per cell; `observed-stale` when every observed edge's run is `changed` */
  chip: 'none' | 'declared' | 'reached' | 'observed' | 'observed-stale';
  /**
   * Who observed, when anything did: `tests` = a results report named a case
   * and coverage placed it on this code · `declaration` = a results report says
   * an end-to-end case passed, and the case declares (`@covers`) this code — no
   * coverage measured it, so the word is *passed, by its own declaration* ·
   * `runs` = only run-level coverage reports, which say a run reached this code
   * and not which case did. Strongest first: a case a coverage report placed
   * outranks a declaration, which outranks a run with no case named. The class
   * is `observed` in every case; this is how it was earned, and it is the
   * difference between *verified by a run*, *passed, by its own declaration*
   * and *seen by a coverage run*. Absent where nothing observed.
   */
  observedBy?: 'tests' | 'declaration' | 'runs';
  /**
   * The evidence word for this scope, decided **here** so every printer says the
   * same thing: the class a surface styles with, and the catalog key it prints.
   * Four printers used to choose it themselves and two of them did not know
   * about `observedBy`, so one flow read *verified by a run* on the front door
   * and *seen by a coverage run* on the Tests tab at the same sync (visual swarm
   * 2026-09-24, and the acceptance's own ranked item "one evidence word across
   * four printers"). A consumer that needs the shape of the claim reads `chip`;
   * one that needs the words reads this.
   */
  evidenceWord: EvidenceWord;
  /** the cell's one verdict: the word, what the run behind it said, and every case by its own run — `testVerdict()` */
  verdict: TestVerdict;
  /** the numbers of this scope, typed, each naming its scope (docs/COUNTS.md) */
  counted?: CoverageCounted;
  /** the run behind the observed class — present only when something observed */
  observation?: CoverageObservation;
  /**
   * Flow scopes only, and only where there is a chip to qualify: the flow's
   * design declares screens and code implements **none** of them, so every
   * covering test reached code this flow shares with others. The chip's class
   * is earned by that shared code and says nothing about this flow — a surface
   * prints the absence word *not built* where it would print the chip, and
   * names the evidence as shared (swarm 2026-09-23, blocker 2). Absent on every
   * other scope, and absent on a flow that has built something: a chip that is
   * earned is never weakened.
   */
  sharedEvidence?: { screens: number };
  /**
   * The covering tests' runs folded to their weakest verdict — kept for
   * consumers that read it, and **never printed as the cell's verdict**: one
   * skipped case among a hundred made it *skipped* beside a word a passed run
   * earned. Surfaces print `verdict` (the word and its own run) and
   * `verdict.runs` (every case by its run, a breakdown that sums).
   */
  run?: { status: NonNullable<TestRef['run']>['status']; at: string; freshness: NonNullable<TestRef['run']>['freshness']; changedBy?: NonNullable<TestRef['run']>['changedBy']; projects: string[] };
  tests: CoverageTestRef[];
  /** the most recent run behind any covering test */
  lastRun?: { at: string; status: NonNullable<TestRef['run']>['status']; freshness: NonNullable<TestRef['run']>['freshness']; stale: boolean; changedBy?: NonNullable<TestRef['run']>['changedBy'] };
  /** the sentence a surface shows verbatim — including "No test reaches this step" */
  note: string;
}

/**
 * The evidence word: the class a surface styles with (four classes plus the
 * absence, a closed set), the catalog key it prints, and — where tests exist —
 * the business lens's sentence about the run (`journey.biz.testsRun.*`), so no
 * surface derives that clause itself.
 */
export interface EvidenceWord {
  cls: 'none' | 'declared' | 'reached' | 'observed' | 'stale';
  key: string;
  biz?: string;
}

/**
 * **The one test verdict of a cell** (swarm 2026-10-05, finding 1: one action
 * carried *passed, by its own declaration · stale*, *their own last run:
 * skipped* and a tip saying *verdict: unknown* at once). Computed here, once,
 * from the same refs every surface reads, and printed as it is by every one of
 * them — the journey's chips, the Sheet's *Verified by*, the timeline and the
 * drill, the Map's property and street, the Tests matrix, MCP and the CLI.
 *
 *  - `word` is the cell's one word: the strongest evidence class over the
 *    active refs (declared < reached < observed), with how it was earned —
 *    exactly `evidenceWord`, never a fourth class and never a seventh absence;
 *  - `status` is what the run **behind that word** said, read over the refs
 *    that earned it and nothing else: a declaration word is earned only by
 *    passed cases, so it never stands beside *unknown* (a coverage report's
 *    missing verdict) or *skipped* (another case's run). Absent when no run
 *    earned the word (*declared only*, *reached by tests*, nothing) or the
 *    only run behind it is a coverage report, which records no verdict;
 *  - `runs` is every case in scope by its own last recorded run — passed ·
 *    failed · skipped · flaky · no run recorded — a breakdown that sums to the
 *    scope's cases (`counted.tests`). It is a count of cases, printed as a
 *    number with its tip, never as a second verdict beside the word.
 */
export interface TestVerdict {
  word: EvidenceWord;
  status?: NonNullable<TestRef['run']>['status'];
  runs: Counted;
}

/** One action's tests, slim: the chip, the word, the typed counts and the observing run — no test list, no metric. */
export interface MomentCoverage {
  chip: CoverageFacts['chip'];
  observedBy?: CoverageFacts['observedBy'];
  evidenceWord: EvidenceWord;
  /** the cell's one verdict — `testVerdict()` */
  verdict: TestVerdict;
  counted: CoverageCounted;
  observation?: CoverageObservation;
  run?: CoverageFacts['run'];
}

export interface JourneyCoverage {
  journey: CoverageFacts;
  /** one entry per segment of the summary, aligned by index */
  segments: CoverageFacts[];
  /**
   * one entry per action: `moments[i][k]` is `segments[i].moments[k]`, over the
   * nodes of the steps inside it — what the Sheet's *Verified by* cell prints,
   * decided here so the viewer never derives an evidence word from refs
   */
  moments?: MomentCoverage[][];
}

/** Per-step coverage the server attaches in `enrichStep` — the journey gutter reads this. */
export interface StepCoverage {
  /**
   * every case that is not end to end — integration cases and coverage reports
   * included. Kept for compatibility; it is not a count of unit cases, which
   * is `counted.unit` (docs/COUNTS.md).
   */
  unit: number;
  e2e: number;
  tests: CoverageTestRef[];
  /** the chip, its word and the typed counts for this one node, scoped `for this part alone` */
  chip?: CoverageFacts['chip'];
  observedBy?: CoverageFacts['observedBy'];
  evidenceWord?: EvidenceWord;
  /** the cell's one verdict — `testVerdict()` */
  verdict?: TestVerdict;
  counted?: CoverageCounted;
  observation?: CoverageObservation;
  /**
   * The nodes sharing this node's file and line whose tests were read with its
   * own: a route and the handler it calls at the same `file:line` are one place
   * in the code, so they carry one verdict (swarm 2026-10-05: `route.ts:24` read
   * *reached by tests* on the route and *no test reaches this step* on its handler).
   */
  sameLoc?: string[];
  /** observed evidence exists for this node: the only class allowed to colour lines */
  observed: boolean;
  note: string;
}

/** A `method-name` resolution whose note says a production twin was picked over a double. */
const TWIN_NOTE = /set aside|stepped aside|in-memory|in memory|mock|fake|double|stub/i;

/**
 * The set-aside-double fact behind the node a test reached, when the graph
 * carries one. Exported because the test detail page (03 §4.2) prints the same
 * note beside the same confidence: *"one of these"* is one rule, read once.
 */
export function twinOf(index: GraphIndex, nodeId: string): { note: string; nodeId: string } | undefined {
  for (const e of index.in.get(nodeId) ?? []) {
    if (e.kind !== 'calls' || e.resolution?.technique !== 'method-name') continue;
    const note = e.resolution.note;
    if (note && TWIN_NOTE.test(note)) return { note, nodeId: e.from };
  }
  return undefined;
}

/**
 * One covering test, as a list row. `node` is the node **in scope** the edge
 * landed on, so a reader judges a shared helper's test by what it reached here.
 */
export function toCoverageRef(index: GraphIndex, t: CoveringTest, node: GraphNode | undefined): CoverageTestRef {
  const twin = node ? twinOf(index, node.id) : undefined;
  return {
    id: t.id, name: t.name, level: t.level, runner: t.runner, evidence: t.evidence, runLevel: t.runLevel,
    ...(t.observedVia ? { observedVia: t.observedVia } : {}),
    ...(t.inactive ? { inactive: true } : {}),
    ...(t.project ? { project: t.project } : {}),
    ...(t.retries != null ? { retries: t.retries } : {}),
    reaches: node
      ? { nodeId: node.id, name: node.name, kind: node.kind }
      : { nodeId: '', name: '', kind: 'unknown' as GraphNode['kind'] },
    ...(twin ? { twin } : {}),
    ...(t.technique ? { technique: t.technique } : {}),
    ...(t.confidence ? { confidence: t.confidence } : {}),
    ...(t.note ? { note: t.note } : {}),
    ...(t.loc ? { loc: t.loc } : {}),
    ...(t.run ? { status: t.run.status, at: t.run.at, freshness: t.run.freshness, stale: t.run.stale, ...(t.run.changedBy ? { changedBy: t.run.changedBy } : {}) } : {}),
  };
}

/**
 * What moved under the `changed` refs of a list: `working-tree` only when every
 * one of them is on the commit its run saw — one run on another commit makes
 * the whole fold a commit change. Undefined when nothing is `changed` or git
 * could not say.
 */
export function changedByOfRefs(refs: Pick<CoverageTestRef, 'freshness' | 'changedBy'>[]): CoverageTestRef['changedBy'] {
  const changed = refs.filter((t) => t.freshness === 'changed');
  if (!changed.length) return undefined;
  if (changed.some((t) => t.changedBy === 'commit')) return 'commit';
  return changed.every((t) => t.changedBy === 'working-tree') ? 'working-tree' : undefined;
}

/** declared · reached · verified — never "verified" for a claim nobody ran. */
function noteFor(tests: CoverageTestRef[], covered: number, nodes: number, what: string): string {
  if (!nodes) return `Nothing in ${what} can carry a test.`;
  if (!tests.length) return `No test reaches ${what}.`;
  const classes = new Set(tests.map((t) => t.evidence));
  const parts: string[] = [];
  if (classes.has('declared')) parts.push('declared by its author');
  if (classes.has('static')) parts.push('inferred from what the test imports or opens');
  const observedRefs = tests.filter((t) => t.evidence === 'observed');
  if (observedRefs.some((t) => t.observedVia !== 'declaration')) parts.push('reached by an observed run');
  if (observedRefs.some((t) => t.observedVia === 'declaration')) parts.push('passed in a results report, by its own declaration');
  const stale = observedRefs.some((t) => t.stale);
  const unknown = observedRefs.some((t) => t.freshness === 'unknown');
  const freshness = stale
    ? changedByOfRefs(observedRefs.filter((t) => t.stale)) === 'working-tree'
      ? ' The files changed after the run without a new commit — the working tree differs from HEAD — so it is evidence of the past, not of now.'
      : ' The run is older than the code, so it is evidence of the past, not of now.'
    : unknown
      ? ' The report records no source digest, so whether the code changed since the run is unknown.'
      : '';
  const reach = `${covered} of ${nodes} thing${nodes === 1 ? '' : 's'} in ${what} ${covered === 1 ? 'is' : 'are'} covered`;
  // One clause per level, and a run-level report counted as a report. Folding
  // integration cases and coverage reports into the phrase "unit tests" is how
  // `270 unit tests` came to stand three lines under `252 unit`
  // (swarm 2026-09-23, blocker 5). The clauses count the same `cases` basis as
  // `counts.tests`, so the sentence and the count line cannot diverge.
  const cases = tests.filter((t) => !t.runLevel);
  const clauses: string[] = [];
  const clause = (n: number, one: string): void => { if (n) clauses.push(`${n} ${one}${n === 1 ? '' : 's'}`); };
  clause(cases.filter((t) => t.level === 'e2e').length, 'end-to-end test');
  clause(cases.filter((t) => t.level === 'unit').length, 'unit test');
  clause(cases.filter((t) => t.level === 'integration').length, 'integration test');
  clause(tests.length - cases.length, 'run-level coverage report');
  const by = clauses.length > 1
    ? `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]}`
    : clauses[0] ?? 'nothing';
  return `${reach} by ${by} — ${parts.join(', ')}.${freshness}`;
}

/**
 * **The one journey scope.** Every denominator printed for a flow — the journey
 * fold, the catalogue matrix row, a test's flow list and `computeMetric` — comes
 * from this list, so the four can never disagree (R9, "one denominator per
 * scope"). `screenIds` must be the flow's **full** screen list
 * (`flowScreenIds`), never the capped one a band happens to draw.
 *
 * No filtering happens here: `computeMetric`'s `isCoverable` is the one
 * predicate, and it is applied once, downstream.
 */
export function journeyScope(index: GraphIndex, j: Journey, screenIds: string[]): string[] {
  const out: string[] = [j.entryId, ...screenIds];
  for (const s of j.steps) {
    out.push(s.nodeId);
    for (const g of s.gates) out.push(g.id);
  }
  return [...new Set(out)].filter((id) => index.byId.has(id));
}

/** Every flow's journey scope, computed once per index — what `sharedWith` reads. */
const FLOW_SCOPES = new WeakMap<GraphIndex, { id: string; name: string; ids: Set<string> }[]>();
function flowScopes(index: GraphIndex): { id: string; name: string; ids: Set<string> }[] {
  let cached = FLOW_SCOPES.get(index);
  if (!cached) {
    cached = [];
    for (const n of index.byId.values()) {
      if (n.kind !== 'flow') continue;
      cached.push({ id: n.id, name: n.name, ids: new Set(journeyScope(index, journey(index, n.id), flowScreenIds(index, n.id))) });
    }
    FLOW_SCOPES.set(index, cached);
  }
  return cached;
}

/** A test body reached something real when its static edge lands on one of these. */
const BODY_KINDS = new Set<GraphNode['kind']>(['route', 'page', 'component', 'function']);

/** worst first: a case is as good as its weakest project, never a majority (03 §3.2). */
const WEAKEST: Record<NonNullable<TestRef['run']>['status'], number> = { failed: 5, flaky: 4, skipped: 3, unknown: 2, passed: 1 };
const WEAKEST_FRESHNESS: Record<NonNullable<TestRef['run']>['freshness'], number> = { changed: 3, unknown: 2, unchanged: 1 };

/**
 * The coverage facts for a set of node ids. One entry point for every scope:
 * a journey, a segment, a flow, a source, a single node.
 */
/** The count scope a metric scope reads as. A moment passes its own (`count.scope.action`). */
const COUNT_SCOPE_OF: Record<MetricScope['kind'], CountScope> = {
  workspace: 'count.scope.workspace', source: 'count.scope.source', collection: 'count.scope.workspace',
  flow: 'journey.scopeAll', segment: 'journey.scopeHere', node: 'count.scope.node',
};

/** The chip over a scope's active refs — the strongest class, stale only when every run behind the word is `changed`. */
function chipOf(active: CoverageTestRef[], earning: CoverageTestRef[]): CoverageFacts['chip'] {
  return earning.length
    ? (earning.every((t) => t.freshness === 'changed') ? 'observed-stale' : 'observed')
    : active.some((t) => t.evidence === 'static') ? 'reached'
      : active.length ? 'declared' : 'none';
}

/**
 * The evidence facts every scope shares — the chip, who observed, the word,
 * the typed counts and the observing run — from one list of covering refs.
 * `coverageFor` (a journey, a screen, a flow), `stepCoverage` (one node) and
 * the per-action fold all read this, so the three can never say different
 * things about the same refs.
 */
export function evidenceFacts(tests: CoverageTestRef[], countScope: CountScope, source: string): {
  chip: CoverageFacts['chip']; observedBy?: CoverageFacts['observedBy']; evidenceWord: EvidenceWord; verdict: TestVerdict;
  counted: CoverageCounted; observation?: CoverageObservation; testCounts: CoverageFacts['counts']['tests'];
} {
  const active = tests.filter((t) => !t.inactive);
  // the refs that earned the word decide whether it is stale — never a coverage
  // report beside a declaration, or a declaration beside a case coverage placed
  const chip = chipOf(active, earningRefs(active));
  const cases = tests.filter((t) => !t.runLevel);
  const byLevel = (level: TestRef['level']) => cases.filter((t) => t.level === level);
  const isDeclaredPass = (t: CoverageTestRef) => t.evidence === 'observed' && t.observedVia === 'declaration';
  const testCounts = {
    unit: byLevel('unit').length,
    integration: byLevel('integration').length,
    e2e: byLevel('e2e').length,
    observed: cases.filter((t) => t.evidence === 'observed').length,
    runLevel: tests.filter((t) => t.runLevel).length,
    declaredPassed: cases.filter(isDeclaredPass).length,
  };
  // who observed: the strongest attribution among the active observing refs
  const activeObserving = active.filter((t) => t.evidence === 'observed');
  const observedBy: CoverageFacts['observedBy'] = chip === 'observed' || chip === 'observed-stale'
    ? (activeObserving.some((t) => !t.runLevel && !isDeclaredPass(t)) ? 'tests'
      : activeObserving.some(isDeclaredPass) ? 'declaration' : 'runs')
    : undefined;
  // the three evidence classes, as a partition of one level's cases — the
  // observed class in its two parts, so a pass by declaration is never printed
  // as a run that was seen reaching the code (and never hidden inside one)
  const byClass = (list: CoverageTestRef[]) => [
    { key: 'count.part.declared', n: list.filter((t) => t.evidence === 'declared').length },
    { key: 'count.part.reached', n: list.filter((t) => t.evidence === 'static').length },
    { key: 'count.part.observed', n: list.filter((t) => t.evidence === 'observed' && !isDeclaredPass(t)).length },
    ...(list.some(isDeclaredPass) ? [{ key: 'count.part.declaredPassed', n: list.filter(isDeclaredPass).length }] : []),
  ];
  const level = (l: TestRef['level'], unit: string, bizUnit?: string): Counted =>
    counted(byLevel(l).length, unit, countScope, `${source}.counts.tests.${l}`, { ...(bizUnit ? { bizUnit } : {}), breakdown: byClass(byLevel(l)) });
  const countedTests: CoverageCounted = {
    tests: counted(cases.length, 'count.unit.cases', countScope, `${source}.counts.tests (unit + integration + e2e)`, {
      bizUnit: 'journey.biz.countTests',
      breakdown: [
        { key: 'journey.testsUnit', n: testCounts.unit },
        { key: 'journey.testsIntegration', n: testCounts.integration },
        { key: 'journey.testsE2e', n: testCounts.e2e },
      ],
    }),
    e2e: level('e2e', 'journey.testsE2e', 'journey.biz.countE2e'),
    unit: level('unit', 'journey.testsUnit'),
    integration: level('integration', 'journey.testsIntegration'),
    observed: counted(testCounts.observed, 'journey.testsObserved', countScope, `${source}.counts.tests.observed`, testCounts.declaredPassed ? {
      breakdown: [
        { key: 'count.part.observed', n: testCounts.observed - testCounts.declaredPassed },
        { key: 'count.part.declaredPassed', n: testCounts.declaredPassed },
      ],
    } : {}),
    runReports: counted(testCounts.runLevel, 'count.unit.runReports', countScope, `${source}.counts.tests.runLevel`),
  };
  // the run that earned the observed class, and only that run: the refs behind
  // the word (`earningRefs`) — a declaration's cases, the cases coverage placed,
  // or the coverage reports when nothing named a case. A coverage report's
  // `unknown` beside a declaration's passed cases made the tip say *verdict:
  // unknown* under *passed, by its own declaration* (swarm 2026-10-05).
  const observing = earningRefs(active);
  let observation: CoverageObservation | undefined;
  if (observedBy && observing.length) {
    const timed = observing.filter((t) => t.at);
    observation = {
      by: observedBy,
      at: timed.map((t) => t.at!).sort().at(-1) ?? '',
      status: observing.reduce((worst, t) => (WEAKEST[t.status ?? 'unknown']! > WEAKEST[worst]! ? (t.status ?? 'unknown') : worst), 'passed' as NonNullable<TestRef['run']>['status']),
      freshness: observing.reduce((worst, t) => (WEAKEST_FRESHNESS[t.freshness ?? 'unknown']! > WEAKEST_FRESHNESS[worst]! ? (t.freshness ?? 'unknown') : worst), 'unchanged' as NonNullable<TestRef['run']>['freshness']),
      ...(changedByOfRefs(observing) ? { changedBy: changedByOfRefs(observing) } : {}),
      cases: observing.filter((t) => !t.runLevel).length,
      reports: observing.filter((t) => t.runLevel).length,
      ...(observing.some(isDeclaredPass) ? { declared: observing.filter(isDeclaredPass).length } : {}),
    };
  }
  const word = evidenceWord(chip, observedBy);
  // a coverage report records no verdict: the word it earns (*seen by a coverage run*) has no run status beside it
  const verdict = testVerdict(tests, word, observation && observation.by !== 'runs' ? observation.status : undefined, countScope, source);
  return { chip, ...(observedBy ? { observedBy } : {}), evidenceWord: word, verdict, counted: countedTests, ...(observation ? { observation } : {}), testCounts };
}

/** The run parts of a verdict's `runs`, in print order — the source cards' parts (`testsSurface().sources[].counted.cases`). */
const RUN_PARTS = ['passed', 'failed', 'skipped', 'flaky'] as const;

/**
 * The cell's one verdict from its refs (see `TestVerdict`): the word the fold
 * chose, the status of the run behind it, and every case by its own last run.
 * `evidenceFacts` calls it for every scope — a journey, a screen, an action, a
 * step — so no printer derives a verdict for itself.
 */
export function testVerdict(
  tests: CoverageTestRef[], word: EvidenceWord, status: CoverageObservation['status'] | undefined,
  countScope: CountScope, source: string,
): TestVerdict {
  const cases = tests.filter((t) => !t.runLevel);
  const n = (s: string) => cases.filter((t) => t.status === s).length;
  // a verdict nobody recorded and no run at all read as one absence, as on the source cards
  const noRun = cases.filter((t) => !t.status || !(RUN_PARTS as readonly string[]).includes(t.status)).length;
  const runs = counted(cases.length, 'count.unit.cases', countScope, `${source}.verdict.runs (each case's own last run)`, {
    bizUnit: 'journey.biz.countTests',
    breakdown: [...RUN_PARTS.map((s) => ({ key: `count.part.${s}`, n: n(s) })), { key: 'count.part.noRun', n: noRun }],
  });
  return { word, ...(status && word.cls !== 'none' && word.cls !== 'declared' && word.cls !== 'reached' ? { status } : {}), runs };
}

/**
 * The refs that earned an observed word, strongest attribution first: the
 * cases a results report named and coverage placed (with any passed by their
 * declaration beside them), else the end-to-end cases that passed for what
 * they declare, else the coverage reports that name no case. Empty when
 * nothing observed.
 */
function earningRefs(active: CoverageTestRef[]): CoverageTestRef[] {
  const observing = active.filter((t) => t.evidence === 'observed');
  const isDeclaredPass = (t: CoverageTestRef) => t.observedVia === 'declaration';
  if (observing.some((t) => !t.runLevel && !isDeclaredPass(t))) return observing.filter((t) => !t.runLevel);
  if (observing.some(isDeclaredPass)) return observing.filter(isDeclaredPass);
  return observing;
}

export function coverageFor(index: GraphIndex, nodeIds: string[], scope: MetricScope, countScope?: CountScope): CoverageFacts {
  const ids = [...new Set(nodeIds)].filter((id) => {
    const n = index.byId.get(id);
    // a declared-but-unbuilt route cannot be "uncovered": there is nothing to test yet
    return !!n && !isDeclaredOnly(n);
  });
  const metric = computeMetric(index, 'test-coverage', { ...scope, nodeIds: ids });
  const byTest = new Map<string, CoverageTestRef>();
  let declared = 0;
  let observed = 0;
  for (const id of ids) {
    const node = index.byId.get(id);
    for (const t of testsCovering(index, id)) {
      if (t.evidence === 'declared') declared++;
      if (t.evidence === 'observed') observed++;
      const ref = toCoverageRef(index, t, node);
      const existing = byTest.get(t.id);
      // one row per test: keep the strongest class it contributes anywhere in scope
      if (!existing || EVIDENCE_RANK[existing.evidence]! < EVIDENCE_RANK[ref.evidence]!) byTest.set(t.id, ref);
    }
  }
  const tests = [...byTest.values()].sort((a, b) => a.level.localeCompare(b.level) || a.name.localeCompare(b.name));
  const runs = tests.filter((t) => t.at).sort((a, b) => (b.at! > a.at! ? 1 : -1));
  const last = runs[0];
  const what = scope.label ?? 'this';

  // ── the e2e word and its lift (03 §3.5) — an inactive case lifts nothing ──
  const active = tests.filter((t) => !t.inactive);
  const e2eRefs = active.filter((t) => t.level === 'e2e');
  const lifts = (t: CoverageTestRef): 'observed' | 'reached' | 'declared' =>
    t.evidence === 'observed' ? 'observed'
      : t.evidence === 'static' && BODY_KINDS.has(t.reaches.kind) ? 'reached'
        : 'declared';
  const WORD_RANK = { declared: 1, reached: 2, observed: 3 } as const;
  let e2e: CoverageFacts['e2e'] = 'none';
  let via: CoverageTestRef | undefined;
  for (const t of e2eRefs) {
    const word = lifts(t);
    if (e2e !== 'none' && WORD_RANK[word] < WORD_RANK[e2e as 'declared' | 'reached' | 'observed']) continue;
    // strongest class first, then the lowest line — one deterministic lifting test
    if (e2e !== 'none' && word === e2e && via && (via.loc?.line ?? Infinity) <= (t.loc?.line ?? Infinity)) continue;
    e2e = word;
    via = t;
  }
  const e2eVia = via
    ? {
        nodeId: via.reaches.nodeId, name: via.reaches.name, testId: via.id, testName: via.name,
        ...(via.loc?.path ? { file: via.loc.path } : {}),
        ...(via.loc?.line != null ? { line: via.loc.line } : {}),
        ...(via.observedVia ? { via: via.observedVia } : {}),
        sharedWith: scope.kind === 'flow'
          ? flowScopes(index).filter((f) => f.id !== scope.flowId && f.ids.has(via!.reaches.nodeId)).map((f) => ({ id: f.id, name: f.name }))
          : [],
      }
    : undefined;

  // ── the chip, the word, the typed counts and the observing run: one helper for every scope ──
  const facts = evidenceFacts(tests, countScope ?? COUNT_SCOPE_OF[scope.kind], `coverageFor(${scope.kind})`);
  const chip = facts.chip;

  // ── whose evidence is it? A flow whose design declares screens and has built
  // none of them cannot have been exercised as that flow: every covering test
  // reached code it shares with others. `built` is counted by the same rule the
  // matrix row counts it (`loc` on the screen node), so the two cannot disagree.
  let sharedEvidence: CoverageFacts['sharedEvidence'];
  if (scope.kind === 'flow' && scope.flowId && chip !== 'none') {
    const screenIds = flowScreenIds(index, scope.flowId);
    const built = screenIds.filter((id) => index.byId.get(id)?.loc).length;
    if (screenIds.length && !built) sharedEvidence = { screens: screenIds.length };
  }

  // ── the run: the weakest verdict across the covering tests' runs ──
  const withRuns = active.filter((t) => t.at);
  let run: CoverageFacts['run'];
  if (withRuns.length) {
    const status = withRuns.reduce((worst, t) => (WEAKEST[t.status ?? 'unknown']! > WEAKEST[worst]! ? (t.status ?? 'unknown') : worst), 'passed' as NonNullable<TestRef['run']>['status']);
    const freshness = withRuns.reduce((worst, t) => (WEAKEST_FRESHNESS[t.freshness ?? 'unknown']! > WEAKEST_FRESHNESS[worst]! ? (t.freshness ?? 'unknown') : worst), 'unchanged' as NonNullable<TestRef['run']>['freshness']);
    const changedBy = freshness === 'changed' ? changedByOfRefs(withRuns) : undefined;
    run = {
      status, freshness, ...(changedBy ? { changedBy } : {}),
      at: withRuns.map((t) => t.at!).sort().at(-1)!,
      projects: [...new Set(withRuns.map((t) => t.project).filter((p): p is string => !!p))].sort(),
    };
  }

  // ── counts: distinct test cases per level, the report counted apart ──
  const testCounts = facts.testCounts;

  // a segment's numbers overlap its neighbours' — said once, in the sentence
  const segmentCaveat = scope.kind === 'segment' ? ' Segments overlap the journey and each other: they do not add up.' : '';
  const observedBy = facts.observedBy;
  return {
    metric,
    counts: {
      nodes: metric.denominator, covered: metric.numerator,
      unit: metric.parts?.['unit']?.numerator ?? 0,
      integration: metric.parts?.['integration']?.numerator ?? 0,
      e2e: metric.parts?.['e2e']?.numerator ?? 0,
      declared, observed,
      observedTests: testCounts.observed,
      tests: testCounts,
    },
    e2e,
    ...(e2eVia ? { e2eVia } : {}),
    verifiedEndToEnd: e2e === 'observed',
    chip,
    ...(observedBy ? { observedBy } : {}),
    evidenceWord: facts.evidenceWord,
    verdict: facts.verdict,
    counted: facts.counted,
    ...(facts.observation ? { observation: facts.observation } : {}),
    ...(sharedEvidence ? { sharedEvidence } : {}),
    ...(run ? { run } : {}),
    tests,
    ...(last?.at ? { lastRun: { at: last.at, status: last.status ?? 'unknown', freshness: last.freshness ?? 'unknown', stale: !!last.stale, ...(last.changedBy ? { changedBy: last.changedBy } : {}) } } : {}),
    note: noteFor(tests, metric.numerator, metric.denominator, what) + segmentCaveat,
  };
}

/**
 * The evidence word for a chip and its attribution — one decision, read by the
 * HUD's journey header and tests foot, the flow status table, the Tests tab and
 * MCP. The class is the shape of the claim (four evidence classes, a closed
 * set); the key is what to print.
 *
 * `observed` carried only by run-level coverage earns the run's word, not the
 * case's: a coverage report says a run reached this code and does not say which
 * test did. The class does not change — istanbul coverage **is** observed
 * evidence, and downgrading it would drop a real fact (the Tests tab settled
 * this in B3.3) — only the attribution does. A stale run keeps the stale word
 * whoever observed it: the run being older than the code is the louder fact.
 */
export function evidenceWord(chip: CoverageFacts['chip'], observedBy?: CoverageFacts['observedBy']): EvidenceWord {
  const runs = observedBy === 'runs';
  // a results report says the case passed; the case says what it covers. Worded
  // as exactly that, never as a run seen reaching the code (docs/COUNTS.md §2 #13)
  if (observedBy === 'declaration' && (chip === 'observed' || chip === 'observed-stale')) return chip === 'observed-stale'
    ? { cls: 'stale', key: 'tests.evidence.declaredPassedStale', biz: 'journey.biz.testsRun.declaredPassedStale' }
    : { cls: 'observed', key: 'tests.evidence.declaredPassed', biz: 'journey.biz.testsRun.declaredPassed' };
  // *verified* means a results report named a case that ran over this code —
  // stale or not. A coverage report alone says *seen by a coverage run*: until
  // 2026-09-25 a stale one said *verified · stale* on every reference-app screen whose
  // only run was a coverage report, above `0 observed` (pass swarm, staff
  // engineer's blocker). The class stays `stale`; only the attribution moves.
  if (chip === 'observed-stale') return runs
    ? { cls: 'stale', key: 'tests.evidence.runSeenStale', biz: 'journey.biz.testsRun.runOnlyStale' }
    : { cls: 'stale', key: 'journey.evidence.stale', biz: 'journey.biz.testsRun.stale' };
  if (chip === 'observed') return runs
    ? { cls: 'observed', key: 'tests.evidence.runSeen', biz: 'journey.biz.testsRun.runOnly' }
    : { cls: 'observed', key: 'journey.evidence.observed', biz: 'journey.biz.testsRun.observed' };
  if (chip === 'reached') return { cls: 'reached', key: 'journey.evidence.reached', biz: 'journey.biz.testsRun.none' };
  if (chip === 'declared') return { cls: 'declared', key: 'journey.evidence.declared', biz: 'journey.biz.testsRun.none' };
  return { cls: 'none', key: 'journey.absent.noneIndexed' };
}

/**
 * The nodes at this node's own `file:line` that are the same place in the code:
 * a route and the handler it `calls` declared on the route's line (a Next.js
 * `route.ts` exporting `POST`, say). Nothing else — a module, a sibling export on
 * another line, or a caller elsewhere stays its own cell.
 */
export function sameLocTwins(index: GraphIndex, node: GraphNode): string[] {
  const at = node.loc;
  if (!at?.path || at.line == null) return [];
  const same = (n: GraphNode | undefined): boolean => !!n?.loc && n.loc.path === at.path && n.loc.line === at.line && (n.loc.repo ?? '') === (at.repo ?? '');
  const out: string[] = [];
  if (node.kind === 'route') {
    for (const e of index.out.get(node.id) ?? []) {
      if (e.kind === 'calls' && index.byId.get(e.to)?.kind === 'function' && same(index.byId.get(e.to))) out.push(e.to);
    }
  } else if (node.kind === 'function') {
    for (const e of index.in.get(node.id) ?? []) {
      if (e.kind === 'calls' && index.byId.get(e.from)?.kind === 'route' && same(index.byId.get(e.from))) out.push(e.from);
    }
  }
  return [...new Set(out)];
}

/** One step's coverage — what the journey band's foot and the code gutter read. */
export function stepCoverage(index: GraphIndex, nodeId: string): StepCoverage | undefined {
  const node = index.byId.get(nodeId);
  if (!node || isDeclaredOnly(node)) return undefined;
  // one place in the code, one verdict: a route and the handler it calls at the
  // same file and line read their tests together, each ref once at its strongest
  const twins = sameLocTwins(index, node);
  const byTest = new Map<string, CoverageTestRef>();
  for (const id of [nodeId, ...twins]) {
    const at = index.byId.get(id);
    for (const t of testsCovering(index, id)) {
      const ref = toCoverageRef(index, t, at);
      const have = byTest.get(t.id);
      if (!have || EVIDENCE_RANK[have.evidence]! < EVIDENCE_RANK[ref.evidence]!) byTest.set(t.id, ref);
    }
  }
  const tests = [...byTest.values()];
  const facts = evidenceFacts(tests, 'count.scope.node', 'stepCoverage()');
  const typed = {
    chip: facts.chip, ...(facts.observedBy ? { observedBy: facts.observedBy } : {}),
    evidenceWord: facts.evidenceWord, verdict: facts.verdict, counted: facts.counted,
    ...(facts.observation ? { observation: facts.observation } : {}),
    ...(twins.length ? { sameLoc: twins } : {}),
  };
  // nothing reaches it: the chip and the word say so, and six zero counts would only weigh the payload
  if (!tests.length) return { unit: 0, e2e: 0, tests: [], observed: false, note: 'No test reaches this step.', chip: facts.chip, evidenceWord: facts.evidenceWord, verdict: facts.verdict };
  const e2e = tests.filter((t) => t.level === 'e2e').length;
  return {
    unit: tests.length - e2e,
    e2e,
    tests,
    observed: tests.some((t) => t.evidence === 'observed'),
    note: noteFor(tests, 1, 1, node.name),
    ...typed,
  };
}

/**
 * The node ids a segment covers: its screen, its markers and the gates it meets.
 * A marker that folds a run-time choice stands for every candidate behind that
 * call — each is real code a test can reach, so all of them stay in the
 * denominator even though the band draws one place (blocker 3).
 */
function segmentNodeIds(segment: JourneySummary['segments'][number]): string[] {
  return [
    ...(segment.screen ? [segment.screen.id] : []),
    ...segment.markers.flatMap((m) => (m.choice ? m.choice.candidates.map((c) => c.nodeId) : [m.nodeId])),
    ...segment.gates.map((g) => g.id),
    // a config check is still code the screen's walk runs: it counts toward what tests reach (gates.ts)
    ...(segment.configChecks ?? []).map((g) => g.id),
  ];
}

/**
 * One action's tests: every test reaching a step inside it, each once, with
 * the strongest class it carries there — the same refs the Sheet's *Verified
 * by* cell used to fold for itself in the viewer.
 */
function momentCoverage(index: GraphIndex, stepNode: Map<number, string>, from: number, to: number): MomentCoverage {
  const byTest = new Map<string, CoverageTestRef>();
  const seen = new Set<string>();
  for (let o = from; o <= to; o++) {
    const id = stepNode.get(o);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const node = index.byId.get(id);
    if (!node || isDeclaredOnly(node)) continue;
    for (const t of testsCovering(index, id)) {
      const ref = toCoverageRef(index, t, node);
      const have = byTest.get(t.id);
      if (!have || EVIDENCE_RANK[have.evidence]! < EVIDENCE_RANK[ref.evidence]!) byTest.set(t.id, ref);
    }
  }
  const tests = [...byTest.values()];
  const facts = evidenceFacts(tests, 'count.scope.action', 'journeySummary().coverage.moments');
  const withRuns = tests.filter((t) => !t.inactive && t.at);
  const run: CoverageFacts['run'] | undefined = withRuns.length ? {
    status: withRuns.reduce((w, t) => (WEAKEST[t.status ?? 'unknown']! > WEAKEST[w]! ? (t.status ?? 'unknown') : w), 'passed' as NonNullable<TestRef['run']>['status']),
    freshness: withRuns.reduce((w, t) => (WEAKEST_FRESHNESS[t.freshness ?? 'unknown']! > WEAKEST_FRESHNESS[w]! ? (t.freshness ?? 'unknown') : w), 'unchanged' as NonNullable<TestRef['run']>['freshness']),
    ...(changedByOfRefs(withRuns) ? { changedBy: changedByOfRefs(withRuns) } : {}),
    at: withRuns.map((t) => t.at!).sort().at(-1)!,
    projects: [...new Set(withRuns.map((t) => t.project).filter((p): p is string => !!p))].sort(),
  } : undefined;
  return {
    chip: facts.chip, ...(facts.observedBy ? { observedBy: facts.observedBy } : {}),
    evidenceWord: facts.evidenceWord, verdict: facts.verdict, counted: facts.counted,
    ...(facts.observation ? { observation: facts.observation } : {}),
    ...(run ? { run } : {}),
  };
}

/**
 * The coverage of one screen of a journey (`seg`), or of one action inside it
 * (`seg` + `action`), with its test list — what the Tests page prints when a
 * door from the journey opens it scoped to that cell (swarm 2026-10-05: *open
 * the list* and the Sheet's tests line dropped the scope). Folded over the same
 * node ids and by the same `evidenceFacts` as `journeyCoverage`'s segment and
 * moment entries, so the page's verdict is the cell's verdict. Undefined when
 * the summary has no such segment or action.
 */
export function cellCoverage(index: GraphIndex, j: Journey, summary: JourneySummary, seg: number, action?: number): { label: string; facts: CoverageFacts } | undefined {
  const sg = summary.segments[seg];
  if (!sg) return undefined;
  const label = sg.screen?.name ?? `step ${sg.index + 1} of ${summary.entry.name}`;
  if (action == null) return { label, facts: coverageFor(index, segmentNodeIds(sg), { kind: 'segment', label }) };
  const mo = sg.moments[action];
  if (!mo) return undefined;
  const stepNode = new Map(j.steps.map((st) => [st.order, st.nodeId] as const));
  const ids: string[] = [];
  for (let o = mo.from; o <= mo.to; o++) { const id = stepNode.get(o); if (id) ids.push(id); }
  const here = `${label} · ${mo.label}`;
  return { label: here, facts: coverageFor(index, ids, { kind: 'segment', label: here }, 'count.scope.action') };
}

/**
 * The cases behind a table's accessors (`verifiedThrough`) by their own last
 * runs — each case once. A table carries no evidence word (no test touches it),
 * so its foot prints this count and no verdict.
 */
export function viaRuns(refs: CoverageTestRef[]): Counted {
  const once = [...new Map(refs.map((r) => [r.id, r] as const)).values()];
  return testVerdict(once, { cls: 'none', key: 'journey.absent.noneIndexed' }, undefined, 'count.scope.node', 'verifiedThrough()').runs;
}

/**
 * One case's own word, by the same rule as a scope's: the case alone as the
 * scope. A list of cases prints this beside each name, so a row never words its
 * evidence differently from the chip above it.
 */
export function caseWord(ref: CoverageTestRef): EvidenceWord {
  return evidenceFacts([{ ...ref, inactive: false }], 'count.scope.node', 'caseWord()').evidenceWord;
}

/**
 * The tests fold for a journey: the whole walk, then one entry per segment.
 * Returns undefined when the graph carries no `test` node at all, so a graph
 * ingested before this pass serves byte-identical journeys.
 */
export function journeyCoverage(index: GraphIndex, j: Journey, summary: JourneySummary): JourneyCoverage | undefined {
  let hasTests = false;
  for (const n of index.byId.values()) { if (n.kind === 'test') { hasTests = true; break; } }
  if (!hasTests) return undefined;
  const label = summary.entry.name;
  // One scope, one denominator (R9): the flow's **full** screen list, not the
  // list this summary's band happened to draw. A non-flow entry (a page, a
  // route) has no `renders` edges, so its own screens stand in.
  const declaredScreens = flowScreenIds(index, j.entryId);
  const journeyIds = journeyScope(index, j, declaredScreens.length ? declaredScreens : summary.user.map((u) => u.id));
  const stepNode = new Map(j.steps.map((st) => [st.order, st.nodeId] as const));
  return {
    journey: coverageFor(index, journeyIds, { kind: 'flow', label, flowId: j.entryId }),
    segments: summary.segments.map((sg) =>
      coverageFor(index, segmentNodeIds(sg), { kind: 'segment', label: sg.screen?.name ?? `step ${sg.index + 1} of ${label}` })),
    moments: summary.segments.map((sg) => sg.moments.map((mo) => momentCoverage(index, stepNode, mo.from, mo.to))),
  };
}

/**
 * `journeySummary()`'s one-line tail: attach the coverage fold and hand the
 * summary back. Additive — a graph with no tests is untouched.
 */
export function withJourneyCoverage(index: GraphIndex, j: Journey, summary: JourneySummary): JourneySummary {
  const coverage = journeyCoverage(index, j, summary);
  if (coverage) summary.coverage = coverage;
  return summary;
}

/** Every `test` node in scope, for the catalogue surfaces. */
export function testNodes(index: GraphIndex, scope?: Set<string> | null): GraphNode[] {
  const out: GraphNode[] = [];
  for (const n of index.byId.values()) {
    if (n.kind !== 'test' || !n.test) continue;
    const repo = n.loc?.repo ?? n.id.split('::')[0]!;
    if (scope && !scope.has(repo)) continue;
    out.push(n);
  }
  return out.sort((a, b) => a.test!.file.localeCompare(b.test!.file) || (a.loc?.line ?? 0) - (b.loc?.line ?? 0));
}
