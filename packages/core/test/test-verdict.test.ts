// One test verdict per cell (swarm 2026-10-05, finding 1). One action used to
// carry *passed, by its own declaration · stale*, *their own last run:
// skipped* and a tip saying *verdict: unknown* at once — three answers to "is
// this tested", from three folds over the same refs. `testVerdict` is the one
// fold now: the word, the status of the run behind that word (read over the
// refs that earned it and nothing else), and every case by its own last run as
// a count whose breakdown sums. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evidenceFacts, evidenceWord, caseWord, countedProblems, buildIndex, stepCoverage, sameLocTwins, coverageFor,
  journey, journeySummary, screensFor, journeyCoverage, cellCoverage, STRINGS,
} from '../dist/index.js';
import type { CoverageTestRef, GraphNode, GraphEdge, TestRun } from '../dist/index.js';

type Run = Partial<Pick<CoverageTestRef, 'status' | 'freshness' | 'at' | 'changedBy'>>;
let seq = 0;
/** One covering ref, as `toCoverageRef` writes it. */
function ref(evidence: CoverageTestRef['evidence'], run: Run | null, extra: Partial<CoverageTestRef> = {}): CoverageTestRef {
  seq++;
  return {
    id: `r::test::t${seq}`, name: `case ${seq}`, level: 'e2e', runner: 'playwright', evidence, runLevel: false,
    reaches: { nodeId: 'r::page::/x', name: '/x', kind: 'page' },
    ...(run ? { at: '2026-10-04T10:00:00.000Z', freshness: 'unchanged', stale: false, ...run } : {}),
    ...extra,
  } as CoverageTestRef;
}
const declaredPass = (run: Run = {}) => ref('observed', { status: 'passed', ...run }, { observedVia: 'declaration' });
const coveragePass = (run: Run = {}) => ref('observed', { status: 'passed', ...run }, { level: 'unit', runner: 'vitest' });
const report = (run: Run = {}) => ref('observed', { status: 'unknown', ...run }, { runLevel: true, level: 'unit', runner: 'vitest', name: 'coverage report' });
const reached = (run: Run | null) => ref('static', run);
const declared = (run: Run | null) => ref('declared', run);
const stale: Run = { freshness: 'changed', changedBy: 'commit' };

/** Every combination the reviewers met, and the one answer each must give. */
const CELLS: { name: string; refs: () => CoverageTestRef[]; word: string; status?: string; runs: Record<string, number> }[] = [
  { name: 'nothing reaches it', refs: () => [], word: 'journey.absent.noneIndexed', runs: {} },
  { name: 'declared only, never run', refs: () => [declared(null)], word: 'journey.evidence.declared', runs: { 'count.part.noRun': 1 } },
  { name: 'reached by a body, its run passed', refs: () => [reached({ status: 'passed' })], word: 'journey.evidence.reached', runs: { 'count.part.passed': 1 } },
  { name: 'reached, its run skipped', refs: () => [reached({ status: 'skipped' })], word: 'journey.evidence.reached', runs: { 'count.part.skipped': 1 } },
  {
    name: 'a declared pass beside a skipped case and a coverage report (the reference app’s action 1)',
    refs: () => [declaredPass(), declaredPass(), reached({ status: 'skipped' }), report(), declared({ status: 'unknown' })],
    word: 'tests.evidence.declaredPassed', status: 'passed', runs: { 'count.part.passed': 2, 'count.part.skipped': 1, 'count.part.noRun': 1 },
  },
  {
    name: 'the same, stale',
    refs: () => [declaredPass(stale), reached({ status: 'skipped', ...stale }), report(stale)],
    word: 'tests.evidence.declaredPassedStale', status: 'passed', runs: { 'count.part.passed': 1, 'count.part.skipped': 1 },
  },
  {
    // the report's run is current, the declaration's is not: the word follows the run that earned it
    name: 'a stale declaration beside a current coverage report',
    refs: () => [declaredPass(stale), report()],
    word: 'tests.evidence.declaredPassedStale', status: 'passed', runs: { 'count.part.passed': 1 },
  },
  {
    name: 'a case coverage placed, passed, beside a declaration and a failed case',
    refs: () => [coveragePass(), declaredPass(), reached({ status: 'failed' })],
    word: 'journey.evidence.observed', status: 'passed', runs: { 'count.part.passed': 2, 'count.part.failed': 1 },
  },
  {
    name: 'a case coverage placed whose own run failed',
    refs: () => [coveragePass({ status: 'failed' })],
    word: 'journey.evidence.observed', status: 'failed', runs: { 'count.part.failed': 1 },
  },
  { name: 'run-only: coverage reports, no case named', refs: () => [report(), reached({ status: 'passed' })], word: 'tests.evidence.runSeen', runs: { 'count.part.passed': 1 } },
  { name: 'run-only, stale', refs: () => [report(stale), reached({ status: 'flaky' })], word: 'tests.evidence.runSeenStale', runs: { 'count.part.flaky': 1 } },
  {
    name: 'an inactive declared pass lifts nothing, and is still counted by its run',
    refs: () => [declaredPass({ status: 'skipped' }), reached({ status: 'passed' })].map((r, i) => (i === 0 ? { ...r, inactive: true } : r)),
    word: 'journey.evidence.reached', runs: { 'count.part.skipped': 1, 'count.part.passed': 1 },
  },
];

test('one word per cell: the verdict is the evidence word, its status is the run behind it, the runs breakdown sums', () => {
  for (const cell of CELLS) {
    const refs = cell.refs();
    const f = evidenceFacts(refs, 'count.scope.action', 'test');
    // one word: the verdict's word is the evidence word, decided once
    assert.deepEqual(f.verdict.word, f.evidenceWord, cell.name);
    assert.deepEqual(f.evidenceWord, evidenceWord(f.chip, f.observedBy), cell.name);
    assert.equal(f.verdict.word.key, cell.word, `${cell.name}: word`);
    assert.equal(f.verdict.status, cell.status, `${cell.name}: the run behind the word`);
    // the tip's *verdict* row reads the observation: it can never say something else
    if (f.verdict.status) assert.equal(f.observation!.status, f.verdict.status, `${cell.name}: tip`);
    // a declaration word stands beside nothing but *passed*
    if (/declaredPassed/.test(f.verdict.word.key)) assert.equal(f.verdict.status, 'passed', cell.name);
    // the runs: every case once, by its own run — a count whose parts sum to the cell's cases
    const runs = f.verdict.runs;
    assert.equal(runs.n, f.counted.tests.n, `${cell.name}: the runs count the cell's cases`);
    assert.deepEqual(countedProblems(runs, cell.name), [], `${cell.name}: the breakdown sums`);
    const got = Object.fromEntries((runs.breakdown ?? []).filter((p) => p.n).map((p) => [p.key, p.n]));
    assert.deepEqual(got, cell.runs, `${cell.name}: runs`);
    for (const p of runs.breakdown ?? []) assert.ok(STRINGS[p.key]?.define, `${p.key} has a define`);
  }
});

test('the run behind the word is the refs that earned it: no coverage report’s `unknown` under a declaration', () => {
  const f = evidenceFacts([declaredPass(), declaredPass(), report(), report()], 'count.scope.action', 'test');
  assert.equal(f.observedBy, 'declaration');
  assert.deepEqual({ cases: f.observation!.cases, reports: f.observation!.reports, declared: f.observation!.declared, status: f.observation!.status },
    { cases: 2, reports: 0, declared: 2, status: 'passed' });
  // a coverage report alone records no verdict: the word stands with no status beside it
  const runs = evidenceFacts([report()], 'count.scope.action', 'test');
  assert.equal(runs.observedBy, 'runs');
  assert.equal(runs.verdict.status, undefined);
});

test('a case’s own word is the scope rule over that case alone', () => {
  assert.equal(caseWord(declaredPass()).key, 'tests.evidence.declaredPassed');
  assert.equal(caseWord(declaredPass(stale)).key, 'tests.evidence.declaredPassedStale');
  assert.equal(caseWord(coveragePass()).key, 'journey.evidence.observed');
  assert.equal(caseWord(report()).key, 'tests.evidence.runSeen');
  assert.equal(caseWord(reached({ status: 'skipped' })).key, 'journey.evidence.reached');
  assert.equal(caseWord(declared(null)).key, 'journey.evidence.declared');
});

// ── one file:line, one verdict; a door's cell, the cell's verdict ─────────

const R = 'app';
const edge = (kind: GraphEdge['kind'], from: string, to: string, meta?: GraphEdge['meta']): GraphEdge => ({ id: `${kind}|${from}|${to}`, kind, from, to, ...(meta ? { meta } : {}) });
const FLOW = `${R}::flow::sign-in`;
const PAGE = `${R}::page::/sign-in`;
const ROUTE = `${R}::route::POST /api/link`;
const HANDLER = `${R}::src/app/api/link/route.ts::POST`;
const SEND = `${R}::src/lib/mail.ts::send`;
const E2E = `${R}::test::e2e/link.pw.spec.ts::sends a link`;
const UNIT = `${R}::test::src/lib/mail.test.ts::sends`;
const run = (status: TestRun['status']): TestRun => ({ id: 'run1', at: '2026-10-04T10:00:00.000Z', status, freshness: 'unknown', stale: false });

function app() {
  const nodes: GraphNode[] = [
    { id: FLOW, kind: 'flow', name: 'Sign in', tags: [] } as GraphNode,
    { id: PAGE, kind: 'page', name: '/sign-in', tags: [], loc: { repo: R, path: 'src/app/sign-in/page.tsx', line: 1 } } as GraphNode,
    { id: ROUTE, kind: 'route', name: 'POST /api/link', tags: [], loc: { repo: R, path: 'src/app/api/link/route.ts', line: 24 } } as GraphNode,
    { id: HANDLER, kind: 'function', name: 'POST', tags: [], loc: { repo: R, path: 'src/app/api/link/route.ts', line: 24, endLine: 40 } } as GraphNode,
    { id: SEND, kind: 'function', name: 'send', tags: [], loc: { repo: R, path: 'src/lib/mail.ts', line: 3 } } as GraphNode,
    { id: E2E, kind: 'test', name: 'sends a link', tags: ['test'], loc: { repo: R, path: 'e2e/link.pw.spec.ts', line: 5 },
      test: { level: 'e2e', runner: 'playwright', suite: [], file: 'e2e/link.pw.spec.ts', run: run('passed') } } as GraphNode,
    { id: UNIT, kind: 'test', name: 'sends', tags: ['test'], loc: { repo: R, path: 'src/lib/mail.test.ts', line: 2 },
      test: { level: 'unit', runner: 'vitest', suite: [], file: 'src/lib/mail.test.ts', run: run('skipped') } } as GraphNode,
  ];
  const edges: GraphEdge[] = [
    edge('renders', FLOW, PAGE),
    edge('http', PAGE, ROUTE, { line: 4 }),
    edge('calls', ROUTE, HANDLER),
    edge('calls', HANDLER, SEND),
    // the e2e body requests the route literal; nothing names the handler
    { ...edge('covers', E2E, ROUTE, { evidence: 'static' }), resolution: { status: 'resolved', technique: 'route-literal', confidence: 'MEDIUM' } },
    { ...edge('covers', UNIT, SEND, { evidence: 'static' }), resolution: { status: 'resolved', technique: 'import-scan', confidence: 'HIGH' } },
  ];
  return buildIndex(nodes, edges);
}

test('a route and the handler it calls at the same file:line carry one verdict', () => {
  const index = app();
  assert.deepEqual(sameLocTwins(index, index.byId.get(HANDLER)!), [ROUTE]);
  assert.deepEqual(sameLocTwins(index, index.byId.get(ROUTE)!), [HANDLER]);
  // a function on another line is its own cell
  assert.deepEqual(sameLocTwins(index, index.byId.get(SEND)!), []);
  const route = stepCoverage(index, ROUTE)!;
  const handler = stepCoverage(index, HANDLER)!;
  assert.equal(handler.verdict!.word.key, route.verdict!.word.key);
  assert.equal(handler.verdict!.word.key, 'journey.evidence.reached');
  assert.equal(handler.verdict!.runs.n, route.verdict!.runs.n);
  assert.deepEqual(handler.sameLoc, [ROUTE]);
});

test('the Tests page’s cell is the Sheet’s cell: cellCoverage folds the same verdict as the journey’s moments', () => {
  const index = app();
  const j = journey(index, FLOW);
  const summary = journeySummary(index, j, screensFor(index, FLOW));
  const cov = journeyCoverage(index, j, summary)!;
  // the same verdict: the word, the status, the runs and their parts (the source names its own fold)
  const same = (v: { word: unknown; status?: unknown; runs: { n: number; scope: string; breakdown?: unknown } }) => ({ word: v.word, status: v.status, n: v.runs.n, scope: v.runs.scope, parts: v.runs.breakdown });
  summary.segments.forEach((sg, i) => {
    const seg = cellCoverage(index, j, summary, i)!;
    assert.deepEqual(same(seg.facts.verdict), same(cov.segments[i]!.verdict), `screen ${i}`);
    sg.moments.forEach((_, k) => {
      const cell = cellCoverage(index, j, summary, i, k)!;
      assert.deepEqual(same(cell.facts.verdict), same(cov.moments![i]![k]!.verdict), `screen ${i} action ${k}`);
      assert.equal(cell.facts.tests.length, cell.facts.verdict.runs.n);
    });
  });
  assert.equal(cellCoverage(index, j, summary, 99), undefined);
  // the journey and the flow fold agree too
  const flow = coverageFor(index, [FLOW, PAGE, ROUTE, HANDLER, SEND], { kind: 'flow', label: 'Sign in', flowId: FLOW });
  assert.equal(flow.verdict.word.key, flow.evidenceWord.key);
});
