// The e2e evidence agrees with itself (story swarm 2026-09-25, all eight
// reviewers): a declared end-to-end case a results report says **passed** is
// observed for what it declares — *passed, by its own declaration* — and a
// failed, flaky, skipped or unrun one stays declared. Plus the freshness words:
// a `changed` run on the commit the run saw says *the working tree differs from
// HEAD*, and the Changes spine says the same on a sync whose files moved on one
// commit. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GraphStore, SnapshotDb, sqliteAvailable, buildIndex, journey, journeyScope, flowScreenIds, coverageFor, stepCoverage,
  testsCovering, testsSurface, testsMatrixV1, evidenceWord, countedProblems, computeMetric, freshnessSentence, freshnessKey,
  spineOf, spineRowNote, spineSentences, STRINGS,
} from '../dist/index.js';
import type { GraphNode, GraphEdge, TestRun } from '../dist/index.js';
import { validate } from './validate.ts';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const R = 'shop';
const here = dirname(fileURLToPath(import.meta.url));
const edge = (kind: GraphEdge['kind'], from: string, to: string, meta?: GraphEdge['meta'], resolution?: GraphEdge['resolution']): GraphEdge =>
  ({ id: `${kind}|${from}|${to}`, kind, from, to, ...(meta ? { meta } : {}), ...(resolution ? { resolution } : {}) });
const FLOW = `${R}::flow::place-order`;
const PAGE = `${R}::page::/orders`;
const ROUTE = `${R}::route::POST /orders`;
const E2E = `${R}::test::e2e/order.pw.spec.ts::places an order`;
const run = (status: TestRun['status'], extra: Partial<TestRun> = {}): TestRun =>
  ({ id: 'pw1', at: '2026-09-25T10:00:00.000Z', status, freshness: 'unknown', stale: false, ...extra });

/** One flow → one page → one route; one e2e case that `@covers` the flow and its screen. */
function shop(opts: { status?: TestRun['status'] | null; run?: Partial<TestRun>; body?: boolean; coverageCase?: boolean; more?: boolean } = {}) {
  const nodes: GraphNode[] = [
    { id: FLOW, kind: 'flow', name: 'Place an order', tags: [], design: { status: 'both', origin: 'manifest', id: 'ORD-01' } } as GraphNode,
    { id: PAGE, kind: 'page', name: '/orders', tags: [], loc: { repo: R, path: 'src/ui/OrderPage.tsx', line: 3 }, design: { status: 'both', origin: 'manifest', id: 'ORD-01' } } as GraphNode,
    { id: ROUTE, kind: 'route', name: 'POST /orders', tags: [], loc: { repo: R, path: 'src/orders.ts', line: 2 } } as GraphNode,
    {
      id: E2E, kind: 'test', name: 'places an order', tags: ['test', 'test:e2e'],
      loc: { repo: R, path: 'e2e/order.pw.spec.ts', line: 8, endLine: 14 },
      test: {
        level: 'e2e', runner: 'playwright', suite: ['orders'], file: 'e2e/order.pw.spec.ts', declares: ['place-order', 'ORD-01'],
        ...(opts.status === null ? {} : { run: run(opts.status ?? 'passed', opts.run) }),
      },
    } as GraphNode,
  ];
  const edges: GraphEdge[] = [
    edge('renders', FLOW, PAGE, { line: 1 }),
    edge('http', PAGE, ROUTE, { line: 12 }),
    edge('covers', E2E, FLOW, { evidence: 'declared', declared: 'place-order' }, { status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH' }),
    edge('covers', E2E, PAGE, { evidence: 'declared', declared: 'ORD-01' }, { status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH' }),
  ];
  if (opts.body) {
    edges.push(edge('covers', E2E, ROUTE, { evidence: 'static' }, { status: 'resolved', technique: 'route-literal', confidence: 'MEDIUM' }));
  }
  if (opts.coverageCase) {
    // a unit case a results report named and coverage placed on the route: the case's own word outranks a declaration
    nodes.push({
      id: `${R}::test::src/orders.spec.ts::posts`, kind: 'test', name: 'posts', tags: ['test', 'test:unit'],
      loc: { repo: R, path: 'src/orders.spec.ts', line: 3 },
      test: { level: 'unit', runner: 'vitest', suite: [], file: 'src/orders.spec.ts', run: run('passed', { id: 'v1' }) },
    } as GraphNode);
    edges.push(edge('covers', `${R}::test::src/orders.spec.ts::posts`, ROUTE, { evidence: 'observed', runId: 'v1', lines: 2 },
      { status: 'resolved', technique: 'coverage-report', confidence: 'HIGH' }));
  }
  if (opts.more) {
    // a passed case that declares only what nothing matches, and one that declares nothing
    nodes.push(
      { id: `${R}::test::e2e/misc.pw.spec.ts::orphan claim`, kind: 'test', name: 'orphan claim', tags: ['test', 'test:e2e'],
        loc: { repo: R, path: 'e2e/misc.pw.spec.ts', line: 3 },
        test: { level: 'e2e', runner: 'playwright', suite: [], file: 'e2e/misc.pw.spec.ts', declares: ['ORD-99'], unresolved: ['ORD-99'], run: run('passed') } } as GraphNode,
      { id: `${R}::test::e2e/misc.pw.spec.ts::no claim`, kind: 'test', name: 'no claim', tags: ['test', 'test:e2e'],
        loc: { repo: R, path: 'e2e/misc.pw.spec.ts', line: 9 },
        test: { level: 'e2e', runner: 'playwright', suite: [], file: 'e2e/misc.pw.spec.ts', run: run('passed') } } as GraphNode,
      { id: `${R}::test::e2e/misc.pw.spec.ts::red`, kind: 'test', name: 'red', tags: ['test', 'test:e2e'],
        loc: { repo: R, path: 'e2e/misc.pw.spec.ts', line: 15 },
        test: { level: 'e2e', runner: 'playwright', suite: [], file: 'e2e/misc.pw.spec.ts', declares: ['place-order'], run: run('failed') } } as GraphNode,
    );
    edges.push(edge('covers', `${R}::test::e2e/misc.pw.spec.ts::red`, FLOW, { evidence: 'declared', declared: 'place-order' },
      { status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH' }));
  }
  return { nodes, edges };
}

function flowFacts(g: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const index = buildIndex(g.nodes, g.edges);
  const ids = journeyScope(index, journey(index, FLOW), flowScreenIds(index, FLOW));
  return coverageFor(index, ids, { kind: 'flow', label: 'Place an order', flowId: FLOW });
}

test('a declared e2e case a results report says passed is observed for what it declares — passed, by its own declaration', () => {
  const f = flowFacts(shop());
  assert.equal(f.chip, 'observed');
  assert.equal(f.observedBy, 'declaration');
  assert.deepEqual(f.evidenceWord, { cls: 'observed', key: 'tests.evidence.declaredPassed', biz: 'journey.biz.testsRun.declaredPassed' });
  assert.equal(f.e2e, 'observed');
  assert.equal(f.verifiedEndToEnd, true, 'a results report named the case, and the case names this flow');
  assert.equal(f.e2eVia!.via, 'declaration');
  // the ref says how it was earned; the class stays one of three
  const ref = f.tests.find((t) => t.id === E2E)!;
  assert.equal(ref.evidence, 'observed');
  assert.equal(ref.observedVia, 'declaration');
  // the counts: observed, and said apart from a run seen reaching the code
  assert.equal(f.counts.tests.observed, 1);
  assert.equal(f.counts.tests.declaredPassed, 1);
  assert.deepEqual(f.counted!.e2e.breakdown!.map((p) => [p.key, p.n]), [
    ['count.part.declared', 0], ['count.part.reached', 0], ['count.part.observed', 0], ['count.part.declaredPassed', 1],
  ]);
  assert.deepEqual(f.counted!.observed.breakdown!.map((p) => [p.key, p.n]), [['count.part.observed', 0], ['count.part.declaredPassed', 1]]);
  for (const [k, c] of Object.entries(f.counted!)) assert.deepEqual(countedProblems(c, k), [], k);
  assert.deepEqual({ by: f.observation!.by, cases: f.observation!.cases, reports: f.observation!.reports, declared: f.observation!.declared, status: f.observation!.status },
    { by: 'declaration', cases: 1, reports: 0, declared: 1, status: 'passed' });
  assert.match(f.note, /passed in a results report, by its own declaration/);
  // the step fold on a declared node agrees
  const index = buildIndex(shop().nodes, shop().edges);
  assert.equal(stepCoverage(index, PAGE)!.observedBy, 'declaration');
  // and only the declared targets: the route the case never declares is not observed by it
  assert.equal(testsCovering(index, ROUTE).length, 0);
});

test('a failed, flaky, skipped or unrun declared case stays declared', () => {
  for (const status of ['failed', 'flaky', 'skipped', 'unknown', null] as const) {
    const f = flowFacts(shop({ status }));
    assert.equal(f.chip, 'declared', `${status}: a claim nobody saw pass is a claim`);
    assert.equal(f.observedBy, undefined);
    assert.equal(f.e2e, 'declared');
    assert.equal(f.verifiedEndToEnd, false);
    assert.equal(f.counts.tests.observed, 0);
    assert.equal(f.counts.tests.declaredPassed, 0);
    assert.equal(f.counted!.e2e.breakdown!.some((p) => p.key === 'count.part.declaredPassed'), false, 'no empty fourth part');
  }
  // an inactive (.skip) case lifts nothing even when a row says passed
  const g = shop();
  (g.nodes.find((n) => n.id === E2E)!.test as { inactive?: boolean }).inactive = true;
  const inactive = flowFacts(g);
  assert.equal(inactive.observedBy, undefined);
  assert.equal(inactive.counts.tests.declaredPassed, 0);
});

test('a case coverage placed outranks a declaration; a declaration outranks a coverage report alone', () => {
  const f = flowFacts(shop({ coverageCase: true }));
  assert.equal(f.observedBy, 'tests');
  assert.equal(f.evidenceWord.key, 'journey.evidence.observed');
  assert.equal(f.counts.tests.observed, 2);
  assert.equal(f.counts.tests.declaredPassed, 1);
  assert.equal(f.observation!.declared, 1);
  // the word for each attribution exists, in both registers, with a define
  for (const key of ['tests.evidence.declaredPassed', 'tests.evidence.declaredPassedStale', 'journey.biz.testsRun.declaredPassed',
    'journey.biz.testsRun.declaredPassedStale', 'count.part.declaredPassed', 'count.part.declaredPassedOne', 'tests.freshness.changedTree', 'changes.treeChanged']) {
    assert.ok(STRINGS[key]?.hud && STRINGS[key]?.professional && STRINGS[key]?.define, key);
  }
  assert.deepEqual(evidenceWord('observed-stale', 'declaration'),
    { cls: 'stale', key: 'tests.evidence.declaredPassedStale', biz: 'journey.biz.testsRun.declaredPassedStale' });
});

test('the metric: a pass by declaration measures no line, so it never makes a count exact', () => {
  const index = buildIndex(shop().nodes, shop().edges);
  const m = computeMetric(index, 'test-coverage');
  assert.equal(m.bound, 'floor');
  assert.match(m.uncertainty!.note, /by their own declaration/);
  assert.ok(m.origin.annotated >= 1, 'the origin is still the annotation');
});

test('the Tests card says why its passed cases are not the journey number', () => {
  const g = shop({ more: true });
  const index = buildIndex(g.nodes, g.edges);
  const s = testsSurface(index, null);
  const card = s.sources.find((c) => c.level === 'e2e')!;
  assert.equal(card.runs!.passed, 3);
  const k = card.counted!.passedByDeclaration!;
  assert.equal(k.n, 3);
  assert.equal(k.unit, 'count.unit.passedInReport');
  assert.equal(k.scope, 'count.scope.source');
  assert.deepEqual(k.breakdown!.map((p) => [p.key, p.n]), [
    ['count.part.declaresKnown', 1], ['count.part.declaresUnmatched', 1], ['count.part.declaresNothing', 1],
  ]);
  assert.deepEqual(countedProblems(k, 'passedByDeclaration'), []);
  // the flow: one case passed by declaration, the failed one stays declared
  const row = s.journeys.find((r) => r.flowId === FLOW)!;
  assert.equal(row.coverage.counts.tests.declaredPassed, 1);
  assert.equal(row.declared.length, 1);
  assert.equal(row.observed.length, 1);
  // edge counts stay the graph's classes, with the passed declarations named apart
  assert.equal(s.counts.observed, 0);
  assert.equal(s.counts.declaredPassed, 2);
  // the frozen matrix: the document still validates, rows keep the edge's class
  const doc = testsMatrixV1(index, s, { generated_at: '2026-09-27T00:00:00.000Z', farsight: 'test' });
  const schema = JSON.parse(readFileSync(join(here, '..', '..', '..', 'schemas', 'farsight-tests-matrix-v1.schema.json'), 'utf8'));
  assert.deepEqual(validate(doc, schema), []);
  assert.ok(doc.rows.every((r) => ['declared', 'reached', 'observed'].includes(r.evidence_class)));
});

test('freshness: `changed` on the run\'s own commit says the working tree differs from HEAD, never a new commit', () => {
  assert.match(freshnessSentence('changed', 'working-tree'), /without a new commit — the working tree differs from HEAD/);
  assert.match(freshnessSentence('changed', 'commit'), /the code changed after this run/);
  assert.match(freshnessSentence('changed'), /the code changed after this run/);
  assert.equal(freshnessKey('changed', 'working-tree'), 'tests.freshness.changedTree');
  assert.equal(freshnessKey('changed', 'commit'), 'tests.freshness.changed');
  assert.equal(freshnessKey('unknown', 'working-tree'), 'tests.freshness.unknown');

  const g = shop({ run: { freshness: 'changed', stale: true, changedBy: 'working-tree', sourceDigest: 'abc' } });
  const index = buildIndex(g.nodes, g.edges);
  const card = testsSurface(index, null).sources.find((c) => c.level === 'e2e')!;
  assert.equal(card.lastRun!.changedBy, 'working-tree');
  assert.match(card.freshness, /the working tree differs from HEAD/);
  assert.doesNotMatch(card.freshness, /code changed after this run/);
  const f = flowFacts(g);
  assert.equal(f.chip, 'observed-stale');
  assert.equal(f.observation!.changedBy, 'working-tree');
  assert.equal(f.run!.changedBy, 'working-tree');
  assert.match(f.note, /the working tree differs from HEAD/);
  // one run on another commit makes the fold a commit change
  const g2 = shop({ run: { freshness: 'changed', stale: true, changedBy: 'commit' } });
  assert.equal(flowFacts(g2).observation!.changedBy, 'commit');
});

test('the Changes spine: the same commit with different files says the working tree differs from HEAD', () => {
  const spine = spineOf([
    { sync: 1, at: '2026-09-20T00:00:00.000Z', commitUnverified: 'c1', sourceDigest: 'd1' },
    { sync: 2, at: '2026-09-21T00:00:00.000Z', commitUnverified: 'c1', sourceDigest: 'd1' },
    { sync: 3, at: '2026-09-22T00:00:00.000Z', commitUnverified: 'c1', sourceDigest: 'd2' },
    { sync: 4, at: '2026-09-23T00:00:00.000Z', commitUnverified: 'c1' },
  ], []);
  // spineOf with no history read reads history-unread first; with a history the note is ours
  const read = spineOf([
    { sync: 1, at: '2026-09-20T00:00:00.000Z', commit: 'c1', sourceDigest: 'd1' },
    { sync: 2, at: '2026-09-21T00:00:00.000Z', commit: 'c1', sourceDigest: 'd1' },
    { sync: 3, at: '2026-09-22T00:00:00.000Z', commit: 'c1', sourceDigest: 'd2' },
    { sync: 4, at: '2026-09-23T00:00:00.000Z', commit: 'c1' },
  ], [{ repo: 'r', sha: 'c1', at: '2026-09-19T00:00:00.000Z', author: 'A', email: 'a@x', subject: 's', parents: [], merge: false, indexed: true, syncs: [1] }]);
  assert.deepEqual(read.rows.map((r) => [r.sync, r.reindexed, !!r.treeChanged, spineRowNote(r).kind]), [
    [4, true, false, 'reindexed'], // no digest recorded: a re-index and an edit look the same, so nothing is claimed
    [3, true, true, 'tree-changed'],
    [2, true, false, 'reindexed'],
    [1, false, false, 'subject'],
  ]);
  assert.match(spineRowNote(read.rows[1]!).text, /working tree differs from HEAD/);
  assert.match(spineSentences(read).syncs!.text, /1 of them read a working tree that differs from HEAD/);
  assert.equal(spine.rows.find((r) => r.sync === 3)!.treeChanged, true, 'a fact about the digests, whatever the history');
});

test('SnapshotDb records each source\'s content digest, so the spine can tell a working-tree change', { skip: sqliteAvailable() ? false : 'node:sqlite unavailable' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-e2e-ev-'));
  try {
    const db = new SnapshotDb(join(dir, 'farsight.db'));
    const store = (digest: string) => {
      const s = new GraphStore();
      s.addFragment({ repo: 'r', nodes: [{ id: 'r::a', kind: 'function', name: 'a', tags: [] } as GraphNode], edges: [], meta: { files: 1, sourceHash: 'h', sourceDigest: digest } });
      return s;
    };
    db.write(store('d1'), { sources: [{ name: 'r', commit: 'c1' }] });
    db.write(store('d1'), { sources: [{ name: 'r', commit: 'c1' }] });
    db.write(store('d2'), { sources: [{ name: 'r', commit: 'c1' }] });
    db.writeCommits('r', [{ sha: 'c1', at: '2026-09-01T00:00:00.000Z', author: 'A', email: 'a@x', subject: 'one', parents: [], files: [] }]);
    const rows = db.commitSpine('r').rows;
    assert.deepEqual(rows.map((r) => [r.sync, !!r.treeChanged]), [[3, true], [2, false], [1, false]]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
