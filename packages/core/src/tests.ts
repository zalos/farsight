/**
 * The tests surface — the catalogue every consumer reads
 * (docs/proposals/tests-surface.md §3.4). `/api/tests`, MCP `test_coverage`
 * and `farsight tests list|matrix` are all views over this one fold, so they
 * cannot disagree about what is covered.
 *
 * Nothing here computes a percentage: `computeMetric` does, and its
 * `scopeLabel` + `evidence` travel with every value.
 */
import type { GraphNode, TestsMeta, TestRef } from './graph.js';
import type { GraphMeta } from './store.js';
import type { GraphIndex } from './query.js';
import { journey, flowScreenIds, repoOf } from './query.js';
import { coverageFor, caseWord, journeyScope, testNodes, toCoverageRef, twinOf, type CoverageFacts, type CoverageTestRef } from './coverage.js';
import { t as word } from './strings.js';
import { computeMetric, testsCovering, type MetricValue } from './metrics.js';
import { buildLine } from './version.js';
import { counted, type Counted } from './counts.js';
import { freshnessFact, codeAtOfIndex, type FreshnessFact, type FreshnessRun } from './freshness.js';

/**
 * How many source cards a list of tests makes — one per source × level × runner of its spec cases, a
 * level with only run-level reports counting once. The same rule the cards are built by.
 */
function cardCount(tests: GraphNode[]): number {
  const keys = new Set<string>();
  for (const t of tests) if (!t.test!.runLevel) keys.add(`${repoOf(t)} ${t.test!.level} ${t.test!.runner}`);
  for (const t of tests) {
    if (!t.test!.runLevel) continue;
    const lv = `${repoOf(t)} ${t.test!.level} `;
    if (![...keys].some((k) => k.startsWith(lv))) keys.add(lv + t.test!.runner);
  }
  return keys.size;
}

/** One spec file with its cases — the `suites` view. */
export interface TestSuiteRow {
  repo: string;
  file: string;
  level: TestRef['level'];
  runner: TestRef['runner'];
  project?: string;
  cases: { id: string; name: string; suite: string[]; line: number; status?: string; declares?: string[]; unresolved?: string[]; covers: number }[];
  /** `flaky` is its own bucket — the reporter retried and it then passed; it is never counted as passed */
  counts: { cases: number; passed: number; failed: number; skipped: number; flaky: number; unknown: number };
  lastRun?: { at: string; freshness: NonNullable<TestRef['run']>['freshness']; stale: boolean; changedBy?: NonNullable<TestRef['run']>['changedBy']; report?: string };
}

/** One source × level card — *example-app · unit · vitest · 68 files · 412 cases · run 2026-09-08*. */
export interface TestSourceCard {
  repo: string;
  level: TestRef['level'];
  runner: TestRef['runner'];
  files: number;
  cases: number;
  lastRun?: { at: string; freshness: NonNullable<TestRef['run']>['freshness']; stale: boolean; changedBy?: NonNullable<TestRef['run']>['changedBy'] };
  /** the honest sentence beside the counts */
  freshness: string;
  /**
   * The card's freshness fact (`freshness.ts`) over its cases' own runs — one state,
   * so a card never says *no source digest* and *changed since the run* at once
   * (SDET, swarm 2026-10-05). Absent when no case of the card has a run.
   */
  fresh?: FreshnessFact;
  /** the results reports this card's runs came from — the card's blind spots are the ones naming these */
  reports?: string[];
  /**
   * each case's last recorded verdict, summed — the card said *37 cases ·
   * digest matches* and never whether they passed (pass swarm 2026-09-25).
   * `noRun` = cases no results report named. Sums to `cases`.
   */
  runs?: { passed: number; failed: number; skipped: number; flaky: number; unknown: number; noRun: number };
  /**
   * `cases` as a typed count, scoped `in this source`, broken down by verdict.
   * `passedByDeclaration` (end-to-end cards with a passed case): the passed
   * cases split by what they declare — why the source's `89 passed` is not the
   * number of cases a journey counts as *passed, by its own declaration*.
   */
  counted?: { cases: Counted; files: Counted; passedByDeclaration?: Counted };
}

/** One row of the journeys × tests matrix. */
export interface TestMatrixRow {
  flowId: string;
  name: string;
  designId?: string;
  screens: number;
  built: number;
  coverage: CoverageFacts;
  declared: CoverageTestRef[];
  inferred: CoverageTestRef[];
  observed: CoverageTestRef[];
  /** the end-to-end word for this journey — a header-only `@covers` is `declared`, never a tick */
  e2e: CoverageFacts['e2e'];
  /** `e2e === 'observed'` and nothing weaker: see `CoverageFacts.verifiedEndToEnd` */
  verifiedEndToEnd: boolean;
  /** what is missing, in words — never an empty row */
  gap: string;
}

/** A test that verifies nothing the graph knows, or a claim that resolves to nothing. */
export interface TestOrphan {
  testId: string;
  name: string;
  file: string;
  line?: number;
  reason: 'covers-nothing' | 'unresolved-claim';
  declares?: string[];
}

export interface TestsSurface {
  /** over the tests in scope — and, when `opts.level` is given, at that level only */
  /**
   * `declared`/`static`/`observed` count covers **edges** by the class the graph
   * stores. `declaredPassed` (additive): of the `declared` edges, those whose
   * end-to-end case passed — every surface reading a scope counts them as
   * observed, *passed, by its own declaration* (docs/COUNTS.md §2 #13).
   */
  counts: { sources: number; files: number; cases: number; covers: number; declared: number; static: number; observed: number; orphans: number; declaredPassed?: number };
  /** the same counts before the level filter — present only when one was applied, so nothing is lost by filtering */
  countsAll?: TestsSurface['counts'];
  /** the level the counts, sources and suites were filtered to */
  level?: TestRef['level'];
  /**
   * The page's header and tiles as typed counts, scoped to what the page has
   * selected (`in the sources and level selected`) or, unfiltered, to the
   * workspace. The E2E filter used to filter the rows and leave the header's
   * `5825` / `431 spec files` unfiltered above them (pass swarm 2026-09-25).
   */
  counted?: { cases: Counted; files: Counted; sources: Counted; reached: Counted };
  metric: MetricValue;
  sources: TestSourceCard[];
  suites: TestSuiteRow[];
  journeys: TestMatrixRow[];
  /** under a level filter: the journeys in scope no case of that level reaches, left out of `journeys` (finding 1.8) */
  journeysLeftOut?: number;
  orphans: TestOrphan[];
  /** one sentence per gap in the evidence — printed by the tab, the overview and `farsight status` */
  blindSpots: string[];
}

const FRESHNESS_SENTENCE: Record<NonNullable<TestRef['run']>['freshness'], string> = {
  unchanged: 'the run recorded a source digest that still matches this code',
  changed: 'the code changed after this run — the result is evidence of the past, not of now',
  unknown: 'no source digest was recorded, so whether the code changed since the run is unknown',
};
/** `changed`, on the same commit: never implies a commit the Changes spine will not show */
const FRESHNESS_TREE = 'the files changed after this run without a new commit — the working tree differs from HEAD — so the result is evidence of the past, not of now';

/**
 * The freshness sentence for a run, one wording for every printer (the Tests
 * cards, MCP `test_coverage`, `farsight tests list`). `changed` on the commit
 * the run saw says *the working tree differs from HEAD*: the Tests page used to
 * say *the code changed after this run* while Changes showed the source at one
 * commit for 27 syncs (story swarm 2026-09-25, three reviewers).
 */
export function freshnessSentence(freshness: NonNullable<TestRef['run']>['freshness'], changedBy?: NonNullable<TestRef['run']>['changedBy']): string {
  return freshness === 'changed' && changedBy === 'working-tree' ? FRESHNESS_TREE : FRESHNESS_SENTENCE[freshness];
}

/** The catalog key of a run's freshness word — `tests.freshness.changedTree` for a working-tree change. */
export function freshnessKey(freshness: NonNullable<TestRef['run']>['freshness'], changedBy?: NonNullable<TestRef['run']>['changedBy']): string {
  return freshness === 'changed' && changedBy === 'working-tree' ? 'tests.freshness.changedTree' : `tests.freshness.${freshness}`;
}

/** Every `covers` edge's evidence class, counted — from the tests in scope only, so a scoped catalogue never carries the whole graph's numbers. */
function edgeCounts(index: GraphIndex, tests: GraphNode[]): { covers: number; declared: number; static: number; observed: number; declaredPassed: number } {
  const out = { covers: 0, declared: 0, static: 0, observed: 0, declaredPassed: 0 };
  for (const t of tests) {
    const passed = t.test?.level === 'e2e' && !t.test.runLevel && !t.test.inactive && t.test.run?.status === 'passed';
    for (const e of index.out.get(t.id) ?? []) {
      if (e.kind !== 'covers') continue;
      out.covers++;
      const cls = String(e.meta?.evidence ?? 'declared');
      if (cls === 'declared' && passed && e.meta?.inactive !== true) out.declaredPassed++;
      if (cls === 'declared') out.declared++;
      else if (cls === 'static') out.static++;
      else if (cls === 'observed') out.observed++;
    }
  }
  return out;
}

/**
 * The whole tests catalogue for a scope. `meta` is the per-repo `TestsMeta`
 * the ingest recorded (blind spots, reports read) — optional, because a graph
 * written before this pass has none.
 */
export function testsSurface(index: GraphIndex, scope?: Set<string> | null, meta?: Record<string, TestsMeta>, opts: { level?: TestRef['level'] | null } = {}): TestsSurface {
  const inScope = testNodes(index, scope);
  const level = opts.level ?? undefined;
  // the level filter applies to every count, card and suite — never to the rows alone
  const tests = level ? inScope.filter((t) => t.test!.level === level) : inScope;
  const repos = [...new Set(tests.map((t) => repoOf(t)))];

  // ── suites ──
  const byFile = new Map<string, { repo: string; file: string; nodes: GraphNode[] }>();
  for (const t of tests) {
    // a run-level node is a report, not a spec file - it belongs on the source card, not in the suite list
    if (t.test!.runLevel) continue;
    const repo = repoOf(t);
    const file = t.test!.file;
    const key = `${repo}::${file}`;
    if (!byFile.has(key)) byFile.set(key, { repo, file, nodes: [] });
    byFile.get(key)!.nodes.push(t);
  }
  const suites: TestSuiteRow[] = [...byFile.values()].map(({ repo, file, nodes: group }) => {
    const head = group[0]!.test!;
    const counts = { cases: group.length, passed: 0, failed: 0, skipped: 0, flaky: 0, unknown: 0 };
    let lastRun: TestSuiteRow['lastRun'];
    for (const t of group) {
      const run = t.test!.run;
      const status = run?.status ?? 'unknown';
      counts[status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : status === 'skipped' ? 'skipped' : status === 'flaky' ? 'flaky' : 'unknown']++;
      if (run && (!lastRun || run.at > lastRun.at)) lastRun = { at: run.at, freshness: run.freshness, stale: run.stale, ...(run.changedBy ? { changedBy: run.changedBy } : {}), ...(run.report ? { report: run.report } : {}) };
    }
    return {
      repo, file, level: head.level, runner: head.runner,
      ...(head.project ? { project: head.project } : {}),
      cases: group.map((t) => ({
        id: t.id, name: t.name, suite: t.test!.suite, line: t.loc?.line ?? 0,
        ...(t.test!.run ? { status: t.test!.run.status } : {}),
        ...(t.test!.declares?.length ? { declares: t.test!.declares } : {}),
        ...(t.test!.unresolved?.length ? { unresolved: t.test!.unresolved } : {}),
        covers: (index.out.get(t.id) ?? []).filter((e) => e.kind === 'covers').length,
      })),
      counts,
      ...(lastRun ? { lastRun } : {}),
    };
  }).sort((a, b) => a.repo.localeCompare(b.repo) || a.file.localeCompare(b.file));

  // ── source cards: one per repo × level ──
  const cards = new Map<string, TestSourceCard & { files: Set<string>; declares?: { known: number; unmatched: number; nothing: number }; freshRuns: FreshnessRun[]; reportSet: Set<string> }>();
  // spec cases first, run-level report nodes after: a report joins the card of its runner, or its level's
  // biggest card — a coverage report is not a runner of its own and never opens a card with no cases
  for (const t of [...tests.filter((x) => !x.test!.runLevel), ...tests.filter((x) => x.test!.runLevel)]) {
    const repo = repoOf(t);
    // one card per source × level × runner: an e2e level that holds a few vitest specs beside its
    // Playwright suite was badged with whichever runner came first (VITEST over Playwright files)
    let key = `${repo} ${t.test!.level} ${t.test!.runner}`;
    if (t.test!.runLevel && !cards.has(key)) {
      const sameLevel = [...cards.entries()].filter(([k]) => k.startsWith(`${repo} ${t.test!.level} `)).sort((a, b) => b[1].cases - a[1].cases)[0];
      if (sameLevel) key = sameLevel[0];
    }
    let card = cards.get(key);
    if (!card) {
      card = { repo, level: t.test!.level, runner: t.test!.runner, files: new Set<string>(), cases: 0, freshness: '', freshRuns: [], reportSet: new Set<string>() } as unknown as TestSourceCard & { files: Set<string>; declares?: { known: number; unmatched: number; nothing: number }; freshRuns: FreshnessRun[]; reportSet: Set<string> };
      cards.set(key, card);
    }
    const run = t.test!.run;
    if (!t.test!.runLevel) {
      card.files.add(t.test!.file); card.cases++;
      const runs = (card.runs ??= { passed: 0, failed: 0, skipped: 0, flaky: 0, unknown: 0, noRun: 0 });
      runs[run ? run.status : 'noRun']++;
    }
    if (run && (!card.lastRun || run.at > card.lastRun.at)) card.lastRun = { at: run.at, freshness: run.freshness, stale: run.stale, ...(run.changedBy ? { changedBy: run.changedBy } : {}) };
    if (run && !t.test!.inactive) {
      card.freshRuns.push({ freshness: run.freshness, ...(run.changedBy ? { changedBy: run.changedBy } : {}), at: run.at, ...(run.commit ? { commit: run.commit } : {}), repo });
      if (run.report) card.reportSet.add(run.report);
    }
    // a passed end-to-end case: what does it declare? (the passed-by-declaration split)
    if (!t.test!.runLevel && t.test!.level === 'e2e' && run?.status === 'passed') {
      const decl = (card.declares ??= { known: 0, unmatched: 0, nothing: 0 });
      const known = (index.out.get(t.id) ?? []).some((e) => e.kind === 'covers' && (e.meta?.evidence ?? 'declared') === 'declared');
      if (known) decl.known++;
      else if (t.test!.declares?.length) decl.unmatched++;
      else decl.nothing++;
    }
  }
  const codeAt = codeAtOfIndex(index);
  const sources: TestSourceCard[] = [...cards.values()].map((c) => {
    const runs = c.runs ?? { passed: 0, failed: 0, skipped: 0, flaky: 0, unknown: 0, noRun: 0 };
    const fresh = c.freshRuns.length ? freshnessFact(c.freshRuns, codeAt) : undefined;
    return {
      repo: c.repo, level: c.level, runner: c.runner, files: c.files.size, cases: c.cases,
      ...(c.lastRun ? { lastRun: c.lastRun } : {}),
      ...(fresh ? { fresh } : {}),
      ...(c.reportSet.size ? { reports: [...c.reportSet].sort() } : {}),
      // the sentence reads the card's one freshness fact, so it cannot say what the fact does not
      freshness: fresh && fresh.ranAt
        ? `last run ${fresh.ranAt.slice(0, 10)} — ${freshnessSentence(fresh.state === 'current' ? 'unchanged' : fresh.state === 'stale' ? 'changed' : 'unknown', fresh.changedBy)}`
        : c.lastRun
        ? `last run ${c.lastRun.at.slice(0, 10)} — ${freshnessSentence(c.lastRun.freshness, c.lastRun.changedBy)}`
        : 'no run has been observed; declared and inferred evidence only',
      runs,
      counted: {
        cases: counted(c.cases, 'count.unit.cases', 'count.scope.source', 'testsSurface().sources[].cases', {
          bizUnit: 'journey.biz.countTests',
          breakdown: [
            { key: 'count.part.passed', n: runs.passed }, { key: 'count.part.failed', n: runs.failed },
            { key: 'count.part.skipped', n: runs.skipped }, { key: 'count.part.flaky', n: runs.flaky },
            // a verdict nobody recorded and no run at all read as one absence here: nothing says it passed
            { key: 'count.part.noRun', n: runs.unknown + runs.noRun },
          ],
        }),
        files: counted(c.files.size, 'count.unit.specFiles', 'count.scope.source', 'testsSurface().sources[].files'),
        ...(c.declares ? {
          passedByDeclaration: counted(runs.passed, 'count.unit.passedInReport', 'count.scope.source', 'testsSurface().sources[].runs.passed', {
            breakdown: [
              { key: 'count.part.declaresKnown', n: c.declares.known },
              { key: 'count.part.declaresUnmatched', n: c.declares.unmatched },
              { key: 'count.part.declaresNothing', n: c.declares.nothing },
            ],
          }),
        } : {}),
      },
    };
  }).sort((a, b) => a.repo.localeCompare(b.repo) || a.level.localeCompare(b.level) || b.cases - a.cases || a.runner.localeCompare(b.runner));

  // ── the journeys × tests matrix ──
  const journeys: TestMatrixRow[] = [];
  let levelLeftOut = 0;
  for (const n of index.byId.values()) {
    if (n.kind !== 'flow') continue;
    if (scope && !scope.has(repoOf(n))) continue;
    const screenIds = flowScreenIds(index, n.id);
    const walk = journey(index, n.id);
    // the one journey scope — byte-identical to the journey fold's (R9)
    const ids = journeyScope(index, walk, screenIds);
    // under a level filter the row reads that level's cases only, and a journey no case of that level reaches is left out
    const coverage = coverageFor(index, ids, { kind: 'flow', label: n.name, flowId: n.id }, undefined, level ? { level } : {});
    if (level && !coverage.tests.length) { levelLeftOut++; continue; }
    const declared = coverage.tests.filter((t) => t.evidence === 'declared');
    const inferred = coverage.tests.filter((t) => t.evidence === 'static');
    const observed = coverage.tests.filter((t) => t.evidence === 'observed');
    const built = screenIds.filter((id) => index.byId.get(id)?.loc).length;
    const uncovered = coverage.metric.gaps.length;
    const rest = uncovered
      ? `${uncovered} step${uncovered === 1 ? '' : 's'} unreached.`
      : 'every step on it is reached by a smaller test.';
    const gap = !coverage.tests.length
      ? 'No test reaches this journey.'
      : coverage.e2e === 'none'
        ? `No end-to-end test reaches this journey; ${rest}`
        : coverage.e2e === 'declared'
          ? `An end-to-end test declares this journey, but no test body reaches anything on it; ${rest}`
          : uncovered
            ? `${uncovered} step${uncovered === 1 ? '' : 's'} on this journey no test reaches.`
            : 'Every step on this journey is covered.';
    journeys.push({
      flowId: n.id, name: n.name,
      ...(n.design?.id ? { designId: n.design.id } : {}),
      screens: screenIds.length, built,
      coverage, declared, inferred, observed,
      e2e: coverage.e2e,
      verifiedEndToEnd: coverage.verifiedEndToEnd,
      gap,
    });
  }
  journeys.sort((a, b) => a.name.localeCompare(b.name));

  // ── orphans: a test that covers nothing, a claim that resolves to nothing ──
  const orphans = orphansOf(index, tests);

  const blindSpots = [...new Set(repos.flatMap((r) => meta?.[r]?.blindSpots ?? []))];
  if (!inScope.length) blindSpots.unshift('No tests are indexed in this graph — either the sources have none, or they were excluded from ingest.');
  const countsOf = (list: GraphNode[], nSources: number, nOrphans: number): TestsSurface['counts'] => ({
    sources: nSources,
    files: new Set(list.filter((t) => !t.test!.runLevel).map((t) => `${repoOf(t)}/${t.test!.file}`)).size,
    cases: list.filter((t) => !t.test!.runLevel).length,
    ...edgeCounts(index, list),
    orphans: nOrphans,
  });
  const counts = countsOf(tests, sources.length, orphans.length);
  const metric = computeMetric(index, 'test-coverage', scope ? { kind: 'source', repos: [...scope], label: [...scope].join(', ') } : { kind: 'workspace' });
  const selection = level || scope ? 'count.scope.selection' as const : 'count.scope.workspace' as const;
  const byLevel = (l: TestRef['level']) => tests.filter((t) => !t.test!.runLevel && t.test!.level === l).length;
  // under a level filter the reach is that level's part of the same metric: the share of the
  // coverable nodes in scope a test **of that level** reaches — one computation, not a second one
  const part = level ? metric.parts?.[level] : undefined;
  return {
    counts,
    ...(level ? { level, countsAll: countsOf(inScope, cardCount(inScope), orphansOf(index, inScope).length), journeysLeftOut: levelLeftOut } : {}),
    counted: {
      cases: counted(counts.cases, 'count.unit.cases', selection, 'testsSurface().counts.cases', {
        bizUnit: 'journey.biz.countTests',
        breakdown: [
          { key: 'journey.testsUnit', n: byLevel('unit') },
          { key: 'journey.testsIntegration', n: byLevel('integration') },
          { key: 'journey.testsE2e', n: byLevel('e2e') },
        ],
      }),
      files: counted(counts.files, 'count.unit.specFiles', selection, 'testsSurface().counts.files'),
      sources: counted(new Set(sources.map((c) => c.repo)).size, 'count.unit.sources', selection, 'testsSurface().sources — distinct repos'),
      reached: counted(part ? part.numerator : metric.numerator, 'count.unit.reached', selection,
        part ? `testsSurface().metric.parts.${level}` : 'testsSurface().metric', { of: part ? part.denominator : metric.denominator }),
    },
    metric,
    sources, suites, journeys, orphans, blindSpots,
  };
}

/** The orphans of a list of tests — the same two reasons the surface lists. */
function orphansOf(index: GraphIndex, tests: GraphNode[]): TestOrphan[] {
  const out: TestOrphan[] = [];
  for (const t of tests) {
    const covers = (index.out.get(t.id) ?? []).filter((e) => e.kind === 'covers');
    const base = { testId: t.id, name: t.name, file: t.test!.file, ...(t.loc?.line ? { line: t.loc.line } : {}) };
    if (t.test!.unresolved?.length) out.push({ ...base, reason: 'unresolved-claim', declares: t.test!.unresolved });
    if (!covers.length) out.push({ ...base, reason: 'covers-nothing' });
  }
  return out;
}

/** One covers edge of one test, with everything that says how strong it is. */
export interface TestDetailCover {
  nodeId: string;
  name: string;
  kind: GraphNode['kind'];
  /** the frozen class on the edge; the printed word for `static` is *reached* */
  evidence: string;
  technique?: string;
  confidence?: string;
  note?: string;
  /** the resolution picked this node over a set-aside double — the note names which */
  twin?: { note: string; nodeId: string };
  /**
   * The other candidates the resolution set aside, when it recorded any. Absent
   * means none were recorded — not that the resolution had only one candidate.
   */
  alternatives?: string[];
  /** the case is `.skip`/`.todo`, or the edge it emitted is marked inactive: it lifts nothing */
  inactive?: boolean;
  /** observed edges only: how the coverage row met the node (`name+line` · `name` · `line±1`) */
  match?: string;
  /** the covered node's own location */
  loc?: GraphNode['loc'];
  /** the line of the **test** file the reach was found on */
  line?: number;
}

/** One test: its suite path, every covers edge with its evidence, and its run. */
export interface TestDetail {
  id: string;
  name: string;
  repo: string;
  test: TestRef;
  docs?: string;
  loc?: GraphNode['loc'];
  covers: TestDetailCover[];
  /** the flows this test participates in, by covering one of their nodes */
  journeys: { id: string; name: string }[];
  /**
   * This test lands on nothing, or claims something nothing answers to — the
   * same two reasons `testsSurface().orphans` records, so the list and the page
   * cannot disagree about which tests are orphans.
   */
  orphan?: { reason: TestOrphan['reason']; declares?: string[] };
  /**
   * Other tests that observed a node **this** test reaches. On a coverage
   * report there is no per-case attribution, so its observations hang off a
   * run-level node: this says the observation exists and says whose it is. It
   * is never evidence about this test.
   */
  alsoObserved?: { id: string; name: string; level: TestRef['level']; runLevel: boolean; nodes: number }[];
}

export function testDetail(index: GraphIndex, testId: string): TestDetail | undefined {
  const t = index.byId.get(testId);
  if (!t || t.kind !== 'test' || !t.test) return undefined;
  const ref = t.test;
  const covers: TestDetailCover[] = (index.out.get(t.id) ?? []).filter((e) => e.kind === 'covers').map((e) => {
    const to = index.byId.get(e.to);
    // the twin is the graph's, not the edge's: the same `method-name` note the
    // journey foot prints, so "one of these" reads the same in both places
    const twin = twinOf(index, e.to);
    return {
      nodeId: e.to, name: to?.name ?? e.to, kind: (to?.kind ?? 'unknown') as GraphNode['kind'],
      evidence: String(e.meta?.evidence ?? 'declared'),
      ...(e.resolution
        ? {
            technique: e.resolution.technique, confidence: e.resolution.confidence,
            ...(e.resolution.note ? { note: e.resolution.note } : {}),
            ...(e.resolution.alternatives?.length ? { alternatives: e.resolution.alternatives } : {}),
          }
        : {}),
      ...(twin ? { twin } : {}),
      // .skip/.todo: the edge exists and lifts nothing. The flag rides on the
      // edge or on the case — either one makes this row inactive
      ...(e.meta?.inactive || ref.inactive ? { inactive: true } : {}),
      ...(e.meta?.match ? { match: String(e.meta.match) } : {}),
      ...(to?.loc ? { loc: to.loc } : {}),
      ...(e.meta?.line != null ? { line: Number(e.meta.line) } : {}),
    };
  });
  // who else saw these nodes run — a coverage report names no case, so its
  // observations sit on a run-level node and are counted there, never here
  const alsoBy = new Map<string, { id: string; name: string; level: TestRef['level']; runLevel: boolean; nodes: number }>();
  for (const c of covers) {
    for (const e of index.in.get(c.nodeId) ?? []) {
      if (e.kind !== 'covers' || e.from === t.id || e.meta?.evidence !== 'observed') continue;
      const other = index.byId.get(e.from);
      if (!other?.test) continue;
      const seen = alsoBy.get(e.from);
      if (seen) seen.nodes++;
      else alsoBy.set(e.from, { id: e.from, name: other.name, level: other.test.level, runLevel: !!other.test.runLevel, nodes: 1 });
    }
  }
  const journeys: { id: string; name: string }[] = [];
  for (const n of index.byId.values()) {
    if (n.kind !== 'flow') continue;
    const ids = new Set(journeyScope(index, journey(index, n.id), flowScreenIds(index, n.id)));
    if (covers.some((c) => ids.has(c.nodeId))) journeys.push({ id: n.id, name: n.name });
  }
  const orphan: TestDetail['orphan'] = ref.unresolved?.length
    ? { reason: 'unresolved-claim', declares: ref.unresolved }
    : covers.length ? undefined : { reason: 'covers-nothing' };
  return {
    id: t.id, name: t.name, repo: repoOf(t), test: ref,
    ...(t.docs ? { docs: t.docs } : {}),
    ...(t.loc ? { loc: t.loc } : {}),
    covers, journeys,
    ...(orphan ? { orphan } : {}),
    ...(alsoBy.size ? { alsoObserved: [...alsoBy.values()].sort((a, b) => b.nodes - a.nodes || a.name.localeCompare(b.name)) } : {}),
  };
}

/** What covers one node — the *Verified by* block on `describe_node` and the inspector. */
export function verifiedBy(index: GraphIndex, nodeId: string): CoverageTestRef[] {
  const node = index.byId.get(nodeId);
  return testsCovering(index, nodeId).map((t) => toCoverageRef(index, t, node));
}

// ── the matrix document: `farsight-tests-matrix v1` ────────────────────────
// docs/contracts/farsight-tests-matrix-v1.md. One flat row per (flow, node,
// test, covers edge), so a CI consumer never has to re-derive "which test
// touches this journey, and how do we know". The rows are the CSV and the JSON
// alike: `farsight tests matrix --format json|csv` and `GET /api/tests/matrix`
// print this one fold (03 §2.7).

/** One row of the matrix: what this test says about this node on this journey. */
export interface TestMatrixCell {
  flow_id: string;
  flow_name: string;
  /** the design id of the screen when the node is one of the flow's screens, else '' */
  screen_id: string;
  node_id: string;
  node_kind: string;
  node_name: string;
  test_id: string;
  file: string;
  line: number | null;
  /** the describe path, outermost first, joined with ` > ` */
  suite: string;
  title: string;
  level: TestRef['level'];
  runner: TestRef['runner'];
  project: string;
  /** the edge came from a coverage report with no per-test attribution */
  run_level: boolean;
  /** the case is `.skip`/`.todo`, or the edge it emitted is marked inactive */
  inactive: boolean;
  /** the printed vocabulary: the edge's `static` is *reached* */
  evidence_class: 'declared' | 'reached' | 'observed';
  technique: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | '';
  resolution_note: string;
  /** observed edges: how the coverage row met the node (`name+line` · `name` · `line±1`) */
  match: string;
  run_id: string;
  run_at: string;
  status: NonNullable<TestRef['run']>['status'] | '';
  retries: number | null;
  duration_ms: number | null;
  freshness: NonNullable<TestRef['run']>['freshness'] | '';
  /** null when freshness is unknown — "not stale" and "not proven fresh" are different facts */
  stale: boolean | null;
  source_digest: string;
  sync: number | null;
  source_commit: string;
  /**
   * Added 2026-10-10, additive (swarm round 2, finding 1.9: `evidence_class=observed`
   * with `status=unknown` read *seen by a coverage run* on screen, and a declared
   * case that passed read *passed, by its own declaration* on screen and `declared`
   * here). The case's own evidence word on this node, in the words the screen
   * prints it (core `caseWord`, professional register) — one of `EVIDENCE_WORDS`.
   */
  evidence_word: string;
  /**
   * The run behind that word, as the screen prints it beside the word: the run's
   * status when a results report named the case and its run earned the word;
   * `''` when the word is a claim or a reading (declared only, reached by tests)
   * or a coverage report earned it (a report records no verdict).
   */
  verdict: NonNullable<TestRef['run']>['status'] | '';
}

/** Every value `evidence_word` takes — the catalog's words for the case words, pinned by a test against the schema. */
export const EVIDENCE_WORDS = [
  'declared only', 'reached by tests', 'verified by a run', 'verified · stale',
  'passed, by its own declaration', 'passed, by its own declaration · stale',
  'seen by a coverage run', 'seen by a coverage run · stale',
] as const;

/** What the document was computed from — the same identity every row repeats, so a CSV row stands alone. */
export interface TestsMatrixIdentity {
  sync?: number;
  source_commit?: string;
  /** repo → the content digest of the code this document describes */
  source_digest: Record<string, string>;
  /** the build that produced it (`buildLine()`) */
  farsight: string;
  generated_at: string;
}

export interface TestsMatrixV1 {
  schema: 'farsight-tests-matrix v1';
  identity: TestsMatrixIdentity;
  metric: MetricValue;
  journeys: TestMatrixRow[];
  rows: TestMatrixCell[];
}

/**
 * The column order — the CSV header, and the sort key. The rows are sorted by
 * every column in this order, so the same graph and the same reports produce
 * byte-identical output (03 §3.6).
 */
export const TESTS_MATRIX_COLUMNS: (keyof TestMatrixCell)[] = [
  'flow_id', 'flow_name', 'screen_id', 'node_id', 'node_kind', 'node_name',
  'test_id', 'file', 'line', 'suite', 'title', 'level', 'runner', 'project',
  'run_level', 'inactive', 'evidence_class', 'technique', 'confidence', 'resolution_note', 'match',
  'run_id', 'run_at', 'status', 'retries', 'duration_ms', 'freshness', 'stale',
  'source_digest', 'sync', 'source_commit',
  // appended 2026-10-10 (additive): the screen's word and verdict for the case on this node
  'evidence_word', 'verdict',
];

/** Column by column, in order: absence first, numbers numerically, strings by code unit (never locale). */
function compareCells(a: TestMatrixCell, b: TestMatrixCell): number {
  for (const col of TESTS_MATRIX_COLUMNS) {
    const x = a[col] as string | number | boolean | null;
    const y = b[col] as string | number | boolean | null;
    if (x === y) continue;
    if (x == null) return -1;
    if (y == null) return 1;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'boolean' && typeof y === 'boolean') return x ? 1 : -1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/**
 * The matrix rows for a catalogue. One row per (flow, node, test, covers edge)
 * over **the one journey scope** (`journeyScope`), so the rows and the
 * denominator on the same journey can never disagree (R9).
 */
export function testsMatrixRows(index: GraphIndex, surface: TestsSurface, identity?: Partial<TestsMatrixIdentity>): TestMatrixCell[] {
  const sync = identity?.sync ?? null;
  const commit = identity?.source_commit ?? '';
  const digests = identity?.source_digest ?? {};
  const rows: TestMatrixCell[] = [];
  for (const row of surface.journeys) {
    const screenIds = flowScreenIds(index, row.flowId);
    const screens = new Set(screenIds);
    for (const nodeId of journeyScope(index, journey(index, row.flowId), screenIds)) {
      const node = index.byId.get(nodeId);
      if (!node) continue;
      for (const e of index.in.get(nodeId) ?? []) {
        if (e.kind !== 'covers') continue;
        const t = index.byId.get(e.from);
        if (!t?.test) continue;
        const run = t.test.run;
        const cls = String(e.meta?.evidence ?? 'declared');
        // the case's word on this node, by the screen's rule: a declared e2e case whose run passed is observed by its declaration (metrics.ts `testsCovering`)
        const inactive = t.test.inactive === true || e.meta?.inactive === true;
        const byDeclaration = cls === 'declared' && t.test.level === 'e2e' && !t.test.runLevel && !inactive && run?.status === 'passed';
        const ev = byDeclaration ? 'observed' : cls === 'static' ? 'static' : cls === 'observed' ? 'observed' : 'declared';
        const cw = caseWord({
          id: t.id, name: t.name, level: t.test.level, runner: t.test.runner, evidence: ev, runLevel: t.test.runLevel === true,
          ...(byDeclaration ? { observedVia: 'declaration' as const } : {}),
          ...(run ? { status: run.status, at: run.at, freshness: run.freshness } : {}),
          reaches: { nodeId, name: node.name, kind: node.kind },
        });
        const earnedByRun = (cw.cls === 'observed' || cw.cls === 'stale') && t.test.runLevel !== true;
        rows.push({
          flow_id: row.flowId,
          flow_name: row.name,
          screen_id: screens.has(nodeId) ? node.design?.id ?? nodeId : '',
          node_id: nodeId, node_kind: node.kind, node_name: node.name,
          test_id: t.id,
          file: t.test.file,
          line: t.loc?.line ?? null,
          suite: t.test.suite.join(' > '),
          title: t.name,
          level: t.test.level,
          runner: t.test.runner,
          project: t.test.project ?? run?.project ?? '',
          run_level: t.test.runLevel === true,
          inactive: t.test.inactive === true || e.meta?.inactive === true,
          evidence_class: cls === 'static' ? 'reached' : cls === 'observed' ? 'observed' : 'declared',
          technique: e.resolution?.technique ?? '',
          confidence: e.resolution?.confidence ?? '',
          resolution_note: e.resolution?.note ?? '',
          match: e.meta?.match != null ? String(e.meta.match) : '',
          run_id: run?.id ?? '',
          run_at: run?.at ?? '',
          status: run?.status ?? '',
          retries: run?.retries ?? null,
          duration_ms: run?.durationMs ?? null,
          freshness: run?.freshness ?? '',
          // `unknown` freshness is neither stale nor fresh: the honest answer is "no answer"
          stale: !run || run.freshness === 'unknown' ? null : run.stale,
          source_digest: digests[repoOf(node)] ?? run?.sourceDigest ?? '',
          sync,
          source_commit: commit,
          evidence_word: word(cw.key, 'professional'),
          verdict: earnedByRun && run?.status ? run.status : '',
        });
      }
    }
  }
  return rows.sort(compareCells);
}

/**
 * The whole `farsight-tests-matrix v1` document. `identity` is the caller's —
 * the CLI passes the store's `sync`/`commit`/per-repo digests; anything missing
 * falls back to this build and now.
 */
export function testsMatrixV1(index: GraphIndex, surface: TestsSurface, identity: Partial<TestsMatrixIdentity> = {}): TestsMatrixV1 {
  const id: TestsMatrixIdentity = {
    ...(identity.sync != null ? { sync: identity.sync } : {}),
    ...(identity.source_commit ? { source_commit: identity.source_commit } : {}),
    source_digest: identity.source_digest ?? {},
    farsight: identity.farsight ?? buildLine(),
    generated_at: identity.generated_at ?? new Date().toISOString(),
  };
  return {
    schema: 'farsight-tests-matrix v1',
    identity: id,
    metric: surface.metric,
    journeys: surface.journeys,
    rows: testsMatrixRows(index, surface, id),
  };
}

/**
 * The identity block read off a **saved graph's** meta — what `/api/tests` and
 * `/api/tests/matrix` were computed from. The CLI builds the same block from its
 * open `GraphStore` (`repoDigests`); both read the per-repo `sourceDigest` the
 * ingest recorded, so the two cannot disagree about which checkout a number
 * describes.
 *
 * Absence is kept: `sync` and `source_commit` are omitted when the graph records
 * none, and `source_digest` is `{}` when no repo recorded one — which is also why
 * a run's freshness can then only read `unknown`. The map is never filtered by the
 * caller's scope: a flow in one source can reach a node in another, and that row
 * still has to say which checkout it describes.
 *
 * `farsight` is the build *producing the document* (this process), not the build
 * that wrote the graph — `/api/version` and the sync chip answer that one.
 */
export function testsIdentity(meta: Pick<GraphMeta, 'sync' | 'commit' | 'repos'>, farsight?: string): TestsMatrixIdentity {
  const source_digest: Record<string, string> = {};
  for (const [repo, m] of Object.entries(meta.repos ?? {})) {
    if (m?.sourceDigest) source_digest[repo] = m.sourceDigest;
  }
  return {
    ...(meta.sync != null ? { sync: meta.sync } : {}),
    ...(meta.commit ? { source_commit: meta.commit } : {}),
    source_digest,
    farsight: farsight ?? buildLine(),
    generated_at: new Date().toISOString(),
  };
}

/**
 * The contract's CSV: `TESTS_MATRIX_COLUMNS` as the header, one RFC-4180 line per
 * row in the same order (`docs/contracts/farsight-tests-matrix-v1.md` §CSV). One
 * implementation, so `farsight tests matrix --format csv` and
 * `GET /api/tests/matrix?format=csv` are the same bytes for the same graph.
 *
 * `stale: null` prints as `unknown` — never as `false`: "not stale" and "not proven
 * fresh" are different facts. Every other null prints as an empty field.
 */
export function testsMatrixCsv(rows: TestMatrixCell[]): string {
  const cell = (v: unknown, col: keyof TestMatrixCell): string => {
    const t = v == null ? (col === 'stale' ? 'unknown' : '') : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = [TESTS_MATRIX_COLUMNS.join(',')];
  for (const row of rows) lines.push(TESTS_MATRIX_COLUMNS.map((c) => cell(row[c], c)).join(','));
  return lines.join('\n');
}

/**
 * A table is never covered directly — a test reaches it *through* an accessor
 * (the function that reads or writes it). `describe_node` of a table prints
 * these as *reached by n tests through its accessors* (01 §3.2); `reaches` is
 * the table, `via` the accessor's node id.
 */
export function verifiedThrough(index: GraphIndex, tableId: string): CoverageTestRef[] {
  const table = index.byId.get(tableId);
  if (!table) return [];
  const seen = new Set<string>();
  const out: { via: string; viaName: string; ref: CoverageTestRef }[] = [];
  for (const e of index.in.get(tableId) ?? []) {
    if (e.kind !== 'reads' && e.kind !== 'writes') continue;
    const accessor = index.byId.get(e.from);
    if (!accessor) continue;
    for (const t of testsCovering(index, accessor.id)) {
      const key = `${t.id}|${accessor.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ via: accessor.id, viaName: accessor.name, ref: { ...toCoverageRef(index, t, table), via: accessor.id } });
    }
  }
  return out
    .sort((a, b) => a.viaName.localeCompare(b.viaName) || a.via.localeCompare(b.via) || a.ref.name.localeCompare(b.ref.name))
    .map((x) => x.ref);
}
