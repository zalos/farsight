// Tests in the graph, Pass 2: the `test-coverage` metric, the journey coverage
// fold, the tests surface, and the four additive farsight-diff v1 kinds.
// The fixture is an in-memory graph (core has no parser dependency).
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GraphStore, buildIndex, journey, journeySummary, screensFor, diffGraphs,
  computeMetric, formatMetric, testsCovering, coverageFor, stepCoverage, testsSurface, testDetail, verifiedBy, METRICS,
  isCoverable, isPresentational, journeyScope, flowScreenIds,
  testsMatrixRows, testsMatrixV1, testsMatrixCsv, testsIdentity, verifiedThrough, TESTS_MATRIX_COLUMNS,
  evidenceWord, STRINGS,
} from '../dist/index.js';
import type { GraphNode, GraphEdge, GraphDiff } from '../dist/index.js';
import { validate } from './validate.ts';

const R = 'shop';
const here = dirname(fileURLToPath(import.meta.url));

const fn = (name: string, path: string, line: number): GraphNode =>
  ({ id: `${R}::${path}::${name}`, kind: 'function', name, tags: [], loc: { repo: R, path, line, endLine: line + 4 } }) as GraphNode;
const edge = (kind: GraphEdge['kind'], from: string, to: string, meta?: GraphEdge['meta'], resolution?: GraphEdge['resolution']): GraphEdge =>
  ({ id: `${kind}|${from}|${to}`, kind, from, to, ...(meta ? { meta } : {}), ...(resolution ? { resolution } : {}) });

const SVC = 'src/orders.ts';
const UI = 'src/ui/OrderPage.tsx';

/** A tiny shop: one flow → one page → one route → two service functions, plus three tests. */
function shop(opts: {
  withObserved?: boolean; freshness?: 'unchanged' | 'changed' | 'unknown'; dropE2E?: boolean;
  /** the e2e test's body also reaches the route (an `import-resolution`/`route-literal` static edge) */
  e2eBody?: boolean;
  /** the e2e case is `.skip`/`.todo` — it is listed and lifts nothing */
  e2eInactive?: boolean;
  /** the files the coverage report contained; defaults to the two files the members live in */
  runFiles?: string[];
  /** an e2e run-level report that observed the route */
  e2eObserved?: boolean;
  /** a records layer: the `orders` table, written by placeOrder and read by refundOrder */
  withTable?: boolean;
} = {}) {
  const freshness = opts.freshness ?? 'unknown';
  const nodes: GraphNode[] = [
    { id: `${R}::flow::place-order`, kind: 'flow', name: 'Place an order', tags: [], design: { status: 'both', origin: 'manifest', id: 'ORD-01' } } as GraphNode,
    { id: `${R}::page::/orders`, kind: 'page', name: '/orders', tags: [], loc: { repo: R, path: UI, line: 3 }, design: { status: 'both', origin: 'manifest', id: 'ORD-01' } } as GraphNode,
    { id: `${R}::route::POST /orders`, kind: 'route', name: 'POST /orders', tags: [], loc: { repo: R, path: SVC, line: 2 } } as GraphNode,
    fn('placeOrder', SVC, 10),
    fn('refundOrder', SVC, 20),
    // ── the tests ──
    {
      id: `${R}::test::e2e/order.pw.spec.ts::places an order`, kind: 'test', name: 'places an order', tags: ['test', 'test:e2e'],
      loc: { repo: R, path: 'e2e/order.pw.spec.ts', line: 8, endLine: 14 }, group: 'e2e/order.pw.spec.ts',
      test: {
        level: 'e2e', runner: 'playwright', suite: ['orders'], file: 'e2e/order.pw.spec.ts',
        declares: ['place-order', 'ORD-99'], unresolved: ['ORD-99'],
        ...(opts.e2eInactive ? { inactive: true } : {}),
      },
    } as GraphNode,
    {
      id: `${R}::test::src/orders.spec.ts::placeOrder totals the lines`, kind: 'test', name: 'placeOrder totals the lines', tags: ['test', 'test:unit'],
      loc: { repo: R, path: 'src/orders.spec.ts', line: 4, endLine: 7 }, group: 'src/orders.spec.ts',
      test: {
        level: 'unit', runner: 'vitest', suite: [], file: 'src/orders.spec.ts',
        run: { id: 'r1', at: '2026-09-10T09:00:00.000Z', status: 'passed', durationMs: 7, freshness, stale: freshness === 'changed' },
      },
    } as GraphNode,
  ];
  const edges: GraphEdge[] = [
    edge('renders', `${R}::flow::place-order`, `${R}::page::/orders`, { line: 1 }),
    edge('http', `${R}::page::/orders`, `${R}::route::POST /orders`, { line: 12 }),
    edge('calls', `${R}::route::POST /orders`, `${R}::${SVC}::placeOrder`, { line: 3 }),
    edge('covers', `${R}::test::src/orders.spec.ts::placeOrder totals the lines`, `${R}::${SVC}::placeOrder`,
      { evidence: 'static' }, { status: 'resolved', technique: 'import-resolution', confidence: 'HIGH' }),
  ];
  if (!opts.dropE2E) {
    edges.push(edge('covers', `${R}::test::e2e/order.pw.spec.ts::places an order`, `${R}::flow::place-order`,
      { evidence: 'declared', declared: 'place-order' }, { status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH' }));
    edges.push(edge('covers', `${R}::test::e2e/order.pw.spec.ts::places an order`, `${R}::page::/orders`,
      { evidence: 'declared', declared: 'ORD-01' }, { status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH' }));
    if (opts.e2eBody) {
      // the body itself opens the route: a static edge onto a node in scope
      edges.push(edge('covers', `${R}::test::e2e/order.pw.spec.ts::places an order`, `${R}::route::POST /orders`,
        { evidence: 'static', ...(opts.e2eInactive ? { inactive: true } : {}) },
        { status: 'resolved', technique: 'route-literal', confidence: 'MEDIUM' }));
    }
  }
  if (opts.withObserved) {
    nodes.push({
      id: `${R}::test::run:unit:shop`, kind: 'test', name: 'unit run · 2026-09-10', tags: ['test', 'test:unit', 'test:run-level'],
      test: {
        level: 'unit', runner: 'vitest', suite: ['unit run', 'shop'], file: 'coverage/coverage-final.json', runLevel: true,
        // what the report measured, hit or not — the whole-scope exactness rule reads it
        files: opts.runFiles ?? [SVC, UI],
        run: { id: 'r2', at: '2026-09-10T09:00:00.000Z', status: 'unknown', freshness, stale: freshness === 'changed', ...(freshness !== 'unknown' ? { sourceDigest: 'abc123' } : {}) },
      },
    } as GraphNode);
    for (const target of [`${R}::${SVC}::placeOrder`, `${R}::route::POST /orders`]) {
      edges.push(edge('covers', `${R}::test::run:unit:shop`, target, { evidence: 'observed', runId: 'r2', lines: 4 },
        { status: 'resolved', technique: 'coverage-report', confidence: freshness === 'unchanged' ? 'HIGH' : 'MEDIUM' }));
    }
  }
  if (opts.withTable) {
    nodes.push({ id: `${R}::table::orders`, kind: 'table', name: 'orders', tags: [],
      loc: { repo: R, path: 'db/schema.sql', line: 1 } } as GraphNode);
    edges.push(edge('writes', `${R}::${SVC}::placeOrder`, `${R}::table::orders`, { line: 14, op: 'insert' }));
    edges.push(edge('reads', `${R}::${SVC}::refundOrder`, `${R}::table::orders`, { line: 24, op: 'select' }));
  }
  if (opts.e2eObserved) {
    nodes.push({
      id: `${R}::test::run:e2e:shop`, kind: 'test', name: 'e2e run · 2026-09-11', tags: ['test', 'test:e2e', 'test:run-level'],
      test: {
        level: 'e2e', runner: 'playwright', suite: ['e2e run', 'shop'], file: 'e2e/coverage-final.json', runLevel: true,
        files: opts.runFiles ?? [SVC, UI],
        run: { id: 'r3', at: '2026-09-11T09:00:00.000Z', status: 'unknown', freshness, stale: freshness === 'changed' },
      },
    } as GraphNode);
    edges.push(edge('covers', `${R}::test::run:e2e:shop`, `${R}::route::POST /orders`, { evidence: 'observed', runId: 'r3', lines: 2 },
      { status: 'resolved', technique: 'coverage-report', confidence: 'MEDIUM' }));
  }
  return { nodes, edges };
}

/** The flow with eight more screens — more than any band draws at once. */
function wideShop() {
  const g = shop();
  for (let i = 1; i <= 8; i++) {
    g.nodes.push({ id: `${R}::page::/step${i}`, kind: 'page', name: `/step${i}`, tags: [],
      loc: { repo: R, path: `src/ui/Step${i}.tsx`, line: 1 } } as GraphNode);
    g.edges.push(edge('renders', `${R}::flow::place-order`, `${R}::page::/step${i}`, { line: 10 + i }));
  }
  return g;
}

/** The coverage facts for the shop's one flow, through the one scope. */
function flowFacts(g: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const index = indexOf(g);
  const entry = `${R}::flow::place-order`;
  const ids = journeyScope(index, journey(index, entry), flowScreenIds(index, entry));
  return coverageFor(index, ids, { kind: 'flow', label: 'Place an order', flowId: entry });
}

const BTN = 'src/ui/Button.tsx';
const FORM = 'src/ui/OrderForm.tsx';
const CLIENT = 'src/api/client.ts';
const SHELL = `${R}::src/ui/RootShell.tsx::RootShell`;

const comp = (name: string, path: string, line: number): GraphNode =>
  ({ id: `${R}::${path}::${name}`, kind: 'component', name, tags: [], loc: { repo: R, path, line, endLine: line + 4 } }) as GraphNode;

/**
 * The shop with a UI layer, for the one coverable predicate: a page the manifest
 * declares but nobody built, a `plumbing` helper, two leaf primitives, a form
 * that calls the API client, and a shell nothing renders.
 */
function shopUi(opts: Parameters<typeof shop>[0] = {}) {
  const g = shop(opts);
  g.nodes.push(
    // (a) manifest-only: designed, not built — no `loc`, so nothing can test it
    { id: `${R}::page::/orders/legacy`, kind: 'page', name: '/orders/legacy', tags: [],
      design: { status: 'design-only', origin: 'manifest', id: 'ORD-09' } } as GraphNode,
    // (b) plumbing by config
    { ...fn('cx', BTN, 30), tags: ['plumbing'] } as GraphNode,
    // (c) leaf primitives
    comp('Button', BTN, 2),
    comp('Spinner', BTN, 12),
    // ...and the two components that are not primitives
    comp('OrderForm', FORM, 5),
    comp('RootShell', 'src/ui/RootShell.tsx', 1),
    fn('apiPost', CLIENT, 3),
  );
  g.edges.push(
    edge('renders', `${R}::page::/orders`, `${R}::${BTN}::Button`, { line: 20 }),
    edge('renders', `${R}::page::/orders`, `${R}::${FORM}::OrderForm`, { line: 21 }),
    edge('renders', `${R}::${BTN}::Button`, `${R}::${BTN}::Spinner`, { line: 6 }),
    edge('calls', `${R}::${BTN}::Button`, `${R}::${BTN}::cx`, { line: 5 }),      // same file: still a primitive
    edge('calls', `${R}::${FORM}::OrderForm`, `${R}::${CLIENT}::apiPost`, { line: 9 }), // leaves the file: real work
  );
  return g;
}

const indexOf = (g: { nodes: GraphNode[]; edges: GraphEdge[] }) => buildIndex(g.nodes, g.edges);
const storeOf = (g: { nodes: GraphNode[]; edges: GraphEdge[] }, sync: number) => {
  const s = new GraphStore();
  s.addFragment({ repo: R, nodes: g.nodes, edges: g.edges });
  s.meta.sync = sync;
  return s;
};

test('computeMetric: a percentage never travels without its scope, and unknown freshness keeps it a floor', () => {
  const index = indexOf(shop({ withObserved: true }));
  const m = computeMetric(index, 'test-coverage');
  // coverable = flow is NOT coverable; page + route + two functions = 4
  assert.equal(m.denominator, 4);
  assert.equal(m.numerator, 3);
  assert.equal(m.def.version, METRICS['test-coverage']!.version);
  assert.match(m.scopeLabel, /4 coverable nodes across the whole workspace/);
  // an observed report with no verified digest is still only a floor (§3-C.1)
  assert.equal(m.bound, 'floor');
  assert.equal(formatMetric(m), '≥ 75%');
  assert.deepEqual(m.range, [0.75, 1]);
  assert.match(m.uncertainty!.note, /cannot be proven to match this source/);
  // the gap is named, never omitted (F11)
  assert.deepEqual(m.gaps.map((g) => g.nodeId), [`${R}::${SVC}::refundOrder`]);
  assert.equal(m.gaps[0]!.note, 'no test reaches this');
  assert.ok(m.evidence.length === 3 && m.evidence.every((e) => e.note));
  assert.equal(m.parts!['unit']!.numerator, 2);
  assert.equal(m.parts!['e2e']!.numerator, 1);
});

test('computeMetric: a digest-verified run is exact; declared/static evidence alone never is', () => {
  const exact = computeMetric(indexOf(shop({ withObserved: true, freshness: 'unchanged' })), 'test-coverage');
  assert.equal(exact.bound, 'exact');
  assert.equal(formatMetric(exact), '75%');
  assert.equal(exact.range, undefined);

  const claimOnly = computeMetric(indexOf(shop()), 'test-coverage');
  assert.equal(claimOnly.bound, 'floor');
  assert.match(claimOnly.uncertainty!.note, /no run has been observed/);

  const stale = computeMetric(indexOf(shop({ withObserved: true, freshness: 'changed' })), 'test-coverage');
  assert.equal(stale.bound, 'floor');

  // an unimplemented metric must throw, never return a made-up number
  assert.throws(() => computeMetric(indexOf(shop()), 'guard-coverage'), /not implemented in this build/);
});

test('testsCovering + verifiedBy: strongest evidence first, and a run-level edge says so', () => {
  const index = indexOf(shop({ withObserved: true }));
  const covers = testsCovering(index, `${R}::${SVC}::placeOrder`);
  assert.deepEqual(covers.map((c) => c.evidence), ['observed', 'static']);
  assert.equal(covers[0]!.runLevel, true);
  assert.equal(covers[1]!.runLevel, false);
  assert.deepEqual(verifiedBy(index, `${R}::${SVC}::refundOrder`), []);
});

test('stepCoverage: a step nothing reaches says so in a sentence, never blank', () => {
  const index = indexOf(shop({ withObserved: true }));
  const none = stepCoverage(index, `${R}::${SVC}::refundOrder`)!;
  assert.equal(none.tests.length, 0);
  assert.equal(none.observed, false);
  assert.equal(none.note, 'No test reaches this step.');

  const some = stepCoverage(index, `${R}::${SVC}::placeOrder`)!;
  assert.equal(some.unit, 2);
  assert.equal(some.e2e, 0);
  assert.equal(some.observed, true);
  assert.match(some.note, /reached by an observed run/);
});

test('journeySummary carries the coverage fold: whole journey + one entry per segment', () => {
  const g = shop({ withObserved: true });
  const index = indexOf(g);
  const entry = `${R}::flow::place-order`;
  const j = journey(index, entry);
  const sum = journeySummary(index, j, screensFor(index, entry));
  assert.ok(sum.coverage, 'summary.coverage is attached');
  assert.equal(sum.coverage!.segments.length, sum.segments.length);
  // a header-only @covers is a claim, not a tick: `verifiedEndToEnd` needs a body
  assert.equal(sum.coverage!.journey.e2e, 'declared');
  assert.equal(sum.coverage!.journey.verifiedEndToEnd, false);
  // a segment says out loud that its number does not add up with its neighbours'
  assert.ok(sum.coverage!.segments.every((sg) => !sg.metric.denominator || /do not add up/.test(sg.note)));
  assert.ok(sum.coverage!.journey.metric.denominator > 0);
  assert.match(sum.coverage!.journey.note, /covered by/);
  // a graph with no test nodes is untouched — an old snapshot serves byte-identical journeys
  const bare = { nodes: g.nodes.filter((n) => n.kind !== 'test'), edges: g.edges.filter((e) => e.kind !== 'covers') };
  const bi = indexOf(bare);
  const bj = journey(bi, entry);
  assert.equal(journeySummary(bi, bj, screensFor(bi, entry)).coverage, undefined);
});

test('coverageFor never counts a declared-but-unbuilt route as uncovered', () => {
  const g = shop();
  g.nodes.push({ id: `${R}::route::DELETE /orders/{id}`, kind: 'route', name: 'DELETE /orders/{id}', tags: [], contract: { status: 'spec-only', apiId: `${R}::api::x` } } as GraphNode);
  const index = indexOf(g);
  const facts = coverageFor(index, g.nodes.map((n) => n.id), { kind: 'workspace', label: 'the shop' });
  assert.equal(facts.metric.gaps.some((x) => x.nodeId.includes('DELETE')), false);
});

test('testsSurface: suites, the journeys × tests matrix, orphans and the blind-spot sentences', () => {
  const index = indexOf(shop({ withObserved: true }));
  const s = testsSurface(index, null, {
    [R]: { files: 2, cases: 2, edges: { declared: 2, static: 1, observed: 2 }, runs: 1, reports: [], blindSpots: ['`e2e/order.pw.spec.ts` declares `ORD-99`, which nothing in the graph matches'] },
  });
  assert.equal(s.counts.cases, 2);
  assert.equal(s.counts.files, 2);
  assert.deepEqual([s.counts.declared, s.counts.static, s.counts.observed], [2, 1, 2]);
  // the run-level node is a report, not a spec file: it never appears as a suite
  assert.deepEqual(s.suites.map((x) => x.file).sort(), ['e2e/order.pw.spec.ts', 'src/orders.spec.ts']);
  assert.equal(s.journeys.length, 1);
  assert.equal(s.journeys[0]!.e2e, 'declared');
  assert.equal(s.journeys[0]!.verifiedEndToEnd, false);
  assert.equal(s.journeys[0]!.declared.length, 1);
  assert.equal(s.journeys[0]!.observed.length, 1);
  assert.match(s.journeys[0]!.gap, /declares this journey, but no test body reaches anything on it/);
  assert.ok(s.orphans.some((o) => o.reason === 'unresolved-claim' && o.declares!.includes('ORD-99')));
  assert.ok(s.blindSpots.some((b) => b.includes('ORD-99')));
  // freshness is a sentence, not a colour
  assert.ok(s.sources.every((c) => c.freshness.length > 10));

  const detail = testDetail(index, `${R}::test::e2e/order.pw.spec.ts::places an order`)!;
  assert.equal(detail.covers.length, 2);
  assert.ok(detail.covers.every((c) => c.evidence === 'declared' && c.technique === 'annotation-scan'));
  assert.deepEqual(detail.journeys.map((x) => x.id), [`${R}::flow::place-order`]);
  assert.equal(testDetail(index, 'nope::test::x'), undefined);
});

test('a scoped catalogue counts only the covers edges of the tests in scope, never the whole graph', () => {
  // two repos in one graph: the shop, plus a second repo with its own test and edge
  const g = shop({ withObserved: true });
  g.nodes.push(fn('ping', 'other/src/ping.ts', 1));
  g.nodes[g.nodes.length - 1]!.id = 'other::other/src/ping.ts::ping';
  g.nodes[g.nodes.length - 1]!.loc = { repo: 'other', path: 'other/src/ping.ts', line: 1 };
  g.nodes.push({ id: 'other::test::t/ping.test.ts::pings', kind: 'test', name: 'pings', tags: ['test:unit'], loc: { repo: 'other', path: 't/ping.test.ts', line: 1 },
    test: { level: 'unit', runner: 'vitest', suite: [], file: 't/ping.test.ts' } } as GraphNode);
  g.edges.push(edge('covers', 'other::test::t/ping.test.ts::pings', 'other::other/src/ping.ts::ping', { evidence: 'static' }));
  const index = indexOf(g);
  const all = testsSurface(index, null);
  const shopOnly = testsSurface(index, new Set([R]));
  const otherOnly = testsSurface(index, new Set(['other']));
  assert.equal(all.counts.covers, shopOnly.counts.covers + otherOnly.counts.covers, 'the scopes partition the edges');
  assert.deepEqual([otherOnly.counts.cases, otherOnly.counts.covers, otherOnly.counts.static], [1, 1, 1]);
  assert.equal(shopOnly.counts.covers, all.counts.covers - 1);
});

test('an empty graph reports no tests indexed rather than 0%', () => {
  const index = buildIndex([], []);
  const s = testsSurface(index, null);
  assert.equal(s.counts.cases, 0);
  assert.equal(s.metric.value, null);
  assert.equal(formatMetric(s.metric), 'nothing to measure');
  assert.ok(s.blindSpots[0]!.startsWith('No tests are indexed'));
});

test('farsight-diff v1: the four additive kinds, and the schema still validates', () => {
  const base = storeOf(shop({ withObserved: true }), 1);
  // head: the e2e test is deleted, so the flow and the page lose their last covers edge,
  // and refundOrder's body changes while nothing verifies it
  const headGraph = shop({ withObserved: true, dropE2E: true });
  headGraph.nodes = headGraph.nodes.filter((n) => !n.id.includes('e2e/order.pw.spec.ts'));
  const refund = headGraph.nodes.find((n) => n.name === 'refundOrder')!;
  refund.signature = 'refundOrder(id: string, amount: number)';
  const baseNodes = shop({ withObserved: true }).nodes;
  const baseRefund = baseNodes.find((n) => n.name === 'refundOrder')!;
  baseRefund.signature = 'refundOrder(id: string)';
  const head = storeOf(headGraph, 2);
  const withSig = storeOf({ nodes: baseNodes, edges: shop({ withObserved: true }).edges }, 1);

  const diff = diffGraphs(withSig, head);
  assert.equal(diff.counts.test_removed, 1);
  assert.equal(diff.counts.test_added, 0);
  // the flow and the page each lost their last test; the route keeps its observed edge
  assert.equal(diff.counts.coverage_lost, 2);
  assert.deepEqual(
    diff.changes.filter((c) => c.kind === 'coverage_lost').map((c) => c.subject.id).sort(),
    [`${R}::flow::place-order`, `${R}::page::/orders`],
  );
  assert.equal(diff.counts.uncovered_change, 1);
  assert.equal(diff.changes.find((c) => c.kind === 'uncovered_change')!.subject.name, 'refundOrder');
  // severities are a fact of the contract table
  assert.equal(diff.changes.find((c) => c.kind === 'coverage_lost')!.severity, 'notable');
  assert.equal(diff.changes.find((c) => c.kind === 'uncovered_change')!.severity, 'info');

  const schema = JSON.parse(readFileSync(join(here, '..', '..', '..', 'schemas', 'farsight-diff-v1.schema.json'), 'utf8'));
  assert.deepEqual(validate(diff as GraphDiff, schema), []);
});

test('uncovered_change never fires on a graph that indexes no tests at all', () => {
  const bare = (sig: string) => {
    const g = shop();
    g.nodes = g.nodes.filter((n) => n.kind !== 'test');
    g.edges = g.edges.filter((e) => e.kind !== 'covers');
    g.nodes.find((n) => n.name === 'refundOrder')!.signature = sig;
    return g;
  };
  const diff = diffGraphs(storeOf(bare('a'), 1), storeOf(bare('b'), 2));
  assert.equal(diff.counts.uncovered_change, 0);
  assert.equal(diff.counts.coverage_lost, 0);
});

test('isPresentational: a leaf another view draws is a primitive; one that calls the API client is not', () => {
  const index = indexOf(shopUi());
  const at = (id: string) => index.byId.get(id)!;
  // drawn by the page, calls only its own file's helper
  assert.equal(isPresentational(index, at(`${R}::${BTN}::Button`)), true);
  // drawn by another primitive, reaches nothing at all
  assert.equal(isPresentational(index, at(`${R}::${BTN}::Spinner`)), true);
  // drawn by the page, but calls out of its file — the SubmissionWizard case
  assert.equal(isPresentational(index, at(`${R}::${FORM}::OrderForm`)), false);
  // nothing renders it: it is an entry point, not a primitive
  assert.equal(isPresentational(index, at(SHELL)), false);
  // only `component` nodes can be presentational
  assert.equal(isPresentational(index, at(`${R}::page::/orders`)), false);
  assert.equal(isPresentational(index, at(`${R}::${SVC}::placeOrder`)), false);

  // an outbound http edge is work of its own, whatever else the component does
  const fetching = shopUi();
  fetching.edges.push(edge('http', `${R}::${BTN}::Button`, `${R}::route::POST /orders`, { line: 7 }));
  const fi = indexOf(fetching);
  assert.equal(isPresentational(fi, fi.byId.get(`${R}::${BTN}::Button`)!), false);
  assert.equal(isCoverable(fi, fi.byId.get(`${R}::${BTN}::Button`)!), true);

  // a component only its flow renders is a screen, not a primitive
  const screen = shopUi();
  screen.nodes.push(comp('LandingScreen', 'src/ui/LandingScreen.tsx', 1));
  screen.edges.push(edge('renders', `${R}::flow::place-order`, `${R}::src/ui/LandingScreen.tsx::LandingScreen`, { line: 2 }));
  const si = indexOf(screen);
  assert.equal(isPresentational(si, si.byId.get(`${R}::src/ui/LandingScreen.tsx::LandingScreen`)!), false);
});

test('isCoverable: manifest-only, plumbing and UI primitives are out of the denominator', () => {
  const index = indexOf(shopUi());
  const at = (id: string) => index.byId.get(id)!;
  // out
  assert.equal(isCoverable(index, at(`${R}::page::/orders/legacy`)), false, 'a designed-but-unbuilt screen has no source to test');
  assert.equal(isCoverable(index, at(`${R}::${BTN}::cx`)), false, 'plumbing is not a thing a test is owed');
  assert.equal(isCoverable(index, at(`${R}::${BTN}::Button`)), false);
  assert.equal(isCoverable(index, at(`${R}::${BTN}::Spinner`)), false);
  assert.equal(isCoverable(index, at(`${R}::flow::place-order`)), false, 'a flow is not a kind a test covers');
  // in
  for (const id of [`${R}::page::/orders`, `${R}::route::POST /orders`, `${R}::${SVC}::placeOrder`,
    `${R}::${SVC}::refundOrder`, `${R}::${FORM}::OrderForm`, `${R}::${CLIENT}::apiPost`,
    SHELL]) {
    assert.equal(isCoverable(index, at(id)), true, `${id} is coverable`);
  }
});

test('computeMetric: the denominator is the coverable set — primitives, plumbing and unbuilt screens never inflate it', () => {
  const index = indexOf(shopUi());
  const m = computeMetric(index, 'test-coverage');
  // 11 nodes of a coverable kind; 4 of them fail the predicate
  const ofCoverableKind = [...index.byId.values()]
    .filter((n) => ['function', 'component', 'page', 'route', 'guard', 'rule'].includes(n.kind)).length;
  assert.equal(ofCoverableKind, 11);
  assert.equal(m.denominator, 7);
  assert.match(m.scopeLabel, /7 coverable nodes across the whole workspace/);
  const named = new Set([...m.evidence, ...m.gaps].map((e) => e.nodeId));
  for (const out of [`${R}::page::/orders/legacy`, `${R}::${BTN}::cx`, `${R}::${BTN}::Button`, `${R}::${BTN}::Spinner`]) {
    assert.equal(named.has(out), false, `${out} is neither evidence nor a gap — it is not measured at all`);
  }
  // the five that are in and untested are named as gaps, never dropped silently
  assert.deepEqual(m.gaps.map((g) => g.nodeId).sort(), [
    `${R}::route::POST /orders`, `${R}::${CLIENT}::apiPost`, `${R}::${FORM}::OrderForm`, `${R}::${SVC}::refundOrder`, SHELL,
  ].sort());
  // and the journey fold reads the same predicate
  const facts = coverageFor(index, [...index.byId.keys()], { kind: 'workspace', label: 'the shop' });
  assert.equal(facts.metric.denominator, 7);
  assert.equal(facts.counts.nodes, 7);
});

test('one journey scope: the fold, the matrix row, a test detail and computeMetric all print the same denominator', () => {
  const index = indexOf(shop({ withObserved: true }));
  const entry = `${R}::flow::place-order`;
  const j = journey(index, entry);
  const ids = journeyScope(index, j, flowScreenIds(index, entry));
  // the scope is the entry, the flow's screens, every step and every gate met
  assert.ok(ids.includes(entry));
  assert.ok(ids.includes(`${R}::page::/orders`));
  assert.ok(ids.includes(`${R}::${SVC}::placeOrder`));
  assert.equal(new Set(ids).size, ids.length, 'the scope is a set');

  // (1) the journey fold · (2) the catalogue matrix row · (3) computeMetric on the same list
  const fold = journeySummary(index, j, screensFor(index, entry)).coverage!.journey;
  const row = testsSurface(index, null).journeys.find((r) => r.flowId === entry)!;
  const m = computeMetric(index, 'test-coverage', { kind: 'flow', label: 'Place an order', flowId: entry, nodeIds: ids });
  assert.equal(fold.metric.denominator, row.coverage.metric.denominator);
  assert.equal(fold.metric.denominator, m.denominator);
  assert.equal(fold.metric.scopeLabel, row.coverage.metric.scopeLabel);
  assert.equal(fold.metric.scopeLabel, m.scopeLabel);
  assert.equal(fold.metric.numerator, m.numerator);
  // (4) a test's flow list is the same scope: it finds the flow through a node inside it
  const detail = testDetail(index, `${R}::test::src/orders.spec.ts::placeOrder totals the lines`)!;
  assert.deepEqual(detail.journeys.map((x) => x.id), [entry]);
});

test('the journey scope takes the flow’s full screen list, never the capped one a band drew', () => {
  const index = indexOf(wideShop());
  const entry = `${R}::flow::place-order`;
  const j = journey(index, entry);
  const full = flowScreenIds(index, entry);
  assert.equal(full.length, 9, 'more screens than any band draws at once');
  // a band that only drew six screens must not shrink the denominator
  const drawn = screensFor(index, entry).slice(0, 6);
  const fold = journeySummary(index, j, drawn).coverage!.journey;
  const row = testsSurface(index, null).journeys.find((r) => r.flowId === entry)!;
  assert.equal(fold.metric.denominator, row.coverage.metric.denominator);
  assert.equal(fold.metric.denominator, 11, 'the page, the route, placeOrder and the eight steps');

  // and the screen list is load-bearing: a screen the walk did not reach still
  // enters the scope from the flow's list, and a capped list loses it
  const late = `${R}::page::/step7`;
  const short = { ...j, steps: j.steps.filter((st) => st.nodeId !== late) };
  assert.ok(journeyScope(index, short, full).includes(late));
  assert.equal(journeyScope(index, short, full.slice(0, 6)).includes(late), false);
});

test('the e2e word: a header @covers declares, a body edge reaches, a run observes', () => {
  // (a) declared: the only e2e evidence is the @covers header
  const declaredOnly = flowFacts(shop());
  assert.equal(declaredOnly.e2e, 'declared');
  assert.equal(declaredOnly.verifiedEndToEnd, false);
  assert.equal(declaredOnly.e2eVia!.testId, `${R}::test::e2e/order.pw.spec.ts::places an order`);

  // (b) reached: the body opens the route, so a node in scope carries a static edge
  const reached = flowFacts(shop({ e2eBody: true }));
  assert.equal(reached.e2e, 'reached');
  // *reached* is a route literal in a test body, stamped `route-literal` LOW. It
  // is the floor, not a verification, and the word *verified* may not ride on it
  // (swarm 2026-09-23, blocker 6): `verifiedEndToEnd` says a run saw it, nothing weaker.
  assert.equal(reached.verifiedEndToEnd, false, 'static evidence is not a verification');
  assert.equal(reached.e2eVia!.nodeId, `${R}::route::POST /orders`);
  assert.equal(reached.e2eVia!.name, 'POST /orders');

  // (c) observed: an e2e run reached it — the one rung that earns the word
  const observed = flowFacts(shop({ e2eBody: true, e2eObserved: true }));
  assert.equal(observed.e2e, 'observed');
  assert.equal(observed.chip, 'observed');
  assert.equal(observed.verifiedEndToEnd, true, 'a run saw it: this is the only rung that is verified');
});

test('one evidence word, from the fold: an observed class carried only by a coverage report says who observed', () => {
  // The flow status table said *verified by a run* and the Tests tab said *seen by
  // a coverage run* for the same eight of ten flows at one sync, because four
  // printers each chose the word and two of them did not know about the run-level
  // attribution (visual swarm 2026-09-24; the acceptance's own ranked item 3).
  // The fold decides it now, once, and hands out the catalog key.
  const runOnly = flowFacts(shop({ withObserved: true, freshness: 'unchanged' }));
  assert.equal(runOnly.chip, 'observed', 'the class is the edge\'s and does not move');
  assert.equal(runOnly.counts.tests.observed, 0, 'no results report named a case here');
  assert.ok(runOnly.counts.tests.runLevel > 0, 'a coverage report did see it');
  assert.equal(runOnly.observedBy, 'runs');
  assert.deepEqual(runOnly.evidenceWord, { cls: 'observed', key: 'tests.evidence.runSeen', biz: 'journey.biz.testsRun.runOnly' },
    'the class stays observed and the word names the run — downgrading to *reached* would drop real evidence');

  // a case a results report named earns the case's word: the same fixture with one
  // observed edge on the unit *case* rather than only on the run
  const named = shop({ withObserved: true, freshness: 'unchanged' });
  named.nodes.push({
    id: `${R}::test::src/orders.spec.ts::places an order end to end`, kind: 'test', name: 'places an order end to end',
    tags: ['test', 'test:unit'], loc: { repo: R, path: 'src/orders.spec.ts', line: 20 },
    test: {
      level: 'unit', runner: 'vitest', suite: [], file: 'src/orders.spec.ts',
      run: { id: 'r1', at: '2026-09-10T09:00:00.000Z', status: 'passed', freshness: 'unchanged', stale: false },
    },
  } as GraphNode);
  named.edges.push(edge('covers', `${R}::test::src/orders.spec.ts::places an order end to end`, `${R}::${SVC}::placeOrder`,
    { evidence: 'observed', runId: 'r1', lines: 3 }, { status: 'resolved', technique: 'coverage-report', confidence: 'HIGH' }));
  const byCase = flowFacts(named);
  assert.equal(byCase.counts.tests.observed > 0, true, 'a results report named a case');
  assert.equal(byCase.observedBy, 'tests');
  assert.deepEqual(byCase.evidenceWord, { cls: 'observed', key: 'journey.evidence.observed', biz: 'journey.biz.testsRun.observed' });

  // the words exist, in both registers, wherever the fold may point
  for (const k of ['journey.evidence.observed', 'journey.evidence.reached', 'journey.evidence.declared',
    'journey.evidence.stale', 'tests.evidence.runSeen', 'tests.evidence.runSeenStale', 'journey.absent.noneIndexed',
    'journey.biz.testsRun.none', 'journey.biz.testsRun.observed', 'journey.biz.testsRun.runOnly',
    'journey.biz.testsRun.stale', 'journey.biz.testsRun.runOnlyStale']) {
    assert.ok(STRINGS[k], `${k} is not in the catalog — the fold points at a word nothing can print`);
  }
});

test('the evidence word is the four classes and nothing else — a stale run keeps the stale class', () => {
  // The closed set is not reopened: five chips map onto four classes plus the
  // absence word, and *stale* wins the class over the run-level attribution
  // because a run older than the code is the louder fact.
  //
  // The attribution still picks the words (pass swarm 2026-09-25, staff
  // engineer's blocker): every reference-app screen whose only run was a coverage
  // report wore `VERIFIED · STALE` above `0 observed`. *Verified* means a
  // results report named a case; a coverage report says *seen by a coverage run*.
  assert.deepEqual(evidenceWord('observed-stale', 'runs'), { cls: 'stale', key: 'tests.evidence.runSeenStale', biz: 'journey.biz.testsRun.runOnlyStale' });
  assert.deepEqual(evidenceWord('observed-stale', 'tests'), { cls: 'stale', key: 'journey.evidence.stale', biz: 'journey.biz.testsRun.stale' });
  for (const chip of ['observed', 'observed-stale'] as const) {
    assert.equal(/verified/i.test(STRINGS[evidenceWord(chip, 'runs').key]!.professional), false,
      `a coverage report alone must never print *verified* (${chip})`);
  }
  assert.deepEqual(evidenceWord('reached'), { cls: 'reached', key: 'journey.evidence.reached', biz: 'journey.biz.testsRun.none' });
  assert.deepEqual(evidenceWord('declared'), { cls: 'declared', key: 'journey.evidence.declared', biz: 'journey.biz.testsRun.none' });
  assert.deepEqual(evidenceWord('none'), { cls: 'none', key: 'journey.absent.noneIndexed' });
  const classes = new Set((['none', 'declared', 'reached', 'observed', 'observed-stale'] as const)
    .flatMap((c) => [evidenceWord(c, 'tests').cls, evidenceWord(c, 'runs').cls]));
  assert.deepEqual([...classes].sort(), ['declared', 'none', 'observed', 'reached', 'stale'],
    'a fifth evidence class is the failure mode this phase existed to remove');
});

test('a flow with nothing built never wears an earned chip: the evidence is named as shared', () => {
  // Two rows of the reference app's front door read `designed, not built · 0 of 2` in SCREENS
  // and `⊙ verified by a run` in TESTED, on the same row, at the same sync — the
  // e2e evidence being another flow's test hitting a shared route (swarm
  // 2026-09-23, blocker 2). Nothing of such a flow is built, so no run can have
  // exercised it: the class is true of the shared code and says nothing about
  // this flow, and every surface prints the absence word in the chip's place.
  const unbuilt = shop({ withObserved: true, freshness: 'unchanged', e2eBody: true, e2eObserved: true });
  // the flow's one screen is designed and not built — no `loc`
  const page = unbuilt.nodes.find((n) => n.id === `${R}::page::/orders`)!;
  delete (page as { loc?: unknown }).loc;
  (page as GraphNode).design = { status: 'design-only', origin: 'manifest', id: 'ORD-01' };
  const facts = flowFacts(unbuilt);
  // the evidence itself is untouched: the class is still what the run earned
  assert.equal(facts.chip, 'observed', 'the class stays what the evidence earns — a chip is never downgraded');
  assert.deepEqual(facts.sharedEvidence, { screens: 1 }, 'the flow declares one screen and has built none of it');

  // ...and a flow that has built something keeps its chip with no qualifier at all
  const built = flowFacts(shop({ withObserved: true, freshness: 'unchanged', e2eBody: true, e2eObserved: true }));
  assert.equal(built.chip, 'observed');
  assert.equal(built.sharedEvidence, undefined, 'a chip a flow has earned is never weakened');

  // a scope that is not a flow carries no such qualifier — there is no design claim to contradict
  const index = indexOf(shop({ withObserved: true }));
  const seg = coverageFor(index, [`${R}::route::POST /orders`], { kind: 'segment', label: 'one screen' });
  assert.equal(seg.sharedEvidence, undefined);
});

test('the coverage sentence names every level it counts and calls a report a report', () => {
  // `tests: 33 e2e · 252 unit · 5 integration · 0 observed · 13 run-level report(s)`
  // stood three lines above `covered by 33 end-to-end tests and 270 unit tests`,
  // and 252 + 5 + 13 = 270: the prose folded integration cases and coverage
  // reports into the phrase "unit tests" (swarm 2026-09-23, blocker 5). Metric v2
  // exists so integration stops folding into unit, and the sentence is the number
  // most likely to be pasted into a document.
  const g = shop({ withObserved: true, freshness: 'unchanged' });
  // one integration case over the same service function
  g.nodes.push({
    id: `${R}::test::src/orders.int.spec.ts::places and refunds`, kind: 'test', name: 'places and refunds',
    tags: ['test', 'test:integration'], loc: { repo: R, path: 'src/orders.int.spec.ts', line: 3 },
    test: { level: 'integration', runner: 'vitest', suite: [], file: 'src/orders.int.spec.ts' },
  } as GraphNode);
  g.edges.push(edge('covers', `${R}::test::src/orders.int.spec.ts::places and refunds`, `${R}::${SVC}::placeOrder`,
    { evidence: 'static' }, { status: 'resolved', technique: 'import-resolution', confidence: 'HIGH' }));
  const facts = flowFacts(g);
  const c = facts.counts.tests;
  assert.equal(c.integration, 1, 'the fixture has one integration case');
  assert.equal(c.runLevel, 1, 'and one run-level coverage report');
  // every level the count line names appears in the sentence with the same number
  assert.match(facts.note, new RegExp(`${c.e2e} end-to-end tests?`));
  assert.match(facts.note, new RegExp(`${c.unit} unit tests?`));
  assert.match(facts.note, new RegExp(`${c.integration} integration tests?`));
  assert.match(facts.note, new RegExp(`${c.runLevel} run-level coverage reports?`));
  // ...and no number in it is a sum of two of them
  const folded = c.unit + c.integration + c.runLevel;
  assert.equal(facts.note.includes(`${folded} unit`), false, `the sentence folds ${folded} into "unit"`);
  assert.equal(facts.note.includes(`${c.unit + c.integration} unit`), false);
});

test('an inactive e2e case is listed and lifts nothing — not the word, not the chip', () => {
  const facts = flowFacts(shop({ e2eBody: true, e2eInactive: true }));
  assert.equal(facts.e2e, 'none', 'a .skip case is not end-to-end evidence');
  assert.equal(facts.verifiedEndToEnd, false);
  assert.equal(facts.e2eVia, undefined);
  // it is still in the list, marked, never silently dropped
  const ref = facts.tests.find((t) => t.level === 'e2e')!;
  assert.equal(ref.inactive, true);
  // the unit test's static edge still lifts the chip
  assert.equal(facts.chip, 'reached');
});

test('e2eVia names the other journeys whose scope holds the lifting node', () => {
  const g = shop({ e2eBody: true });
  // a second journey through the same route
  g.nodes.push(
    { id: `${R}::flow::refund`, kind: 'flow', name: 'Refund an order', tags: [], design: { status: 'both', origin: 'manifest', id: 'ORD-02' } } as GraphNode,
    { id: `${R}::page::/refunds`, kind: 'page', name: '/refunds', tags: [], loc: { repo: R, path: 'src/ui/RefundPage.tsx', line: 3 } } as GraphNode,
  );
  g.edges.push(
    edge('renders', `${R}::flow::refund`, `${R}::page::/refunds`, { line: 1 }),
    edge('http', `${R}::page::/refunds`, `${R}::route::POST /orders`, { line: 9 }),
  );
  const facts = flowFacts(g);
  assert.equal(facts.e2eVia!.nodeId, `${R}::route::POST /orders`);
  assert.deepEqual(facts.e2eVia!.sharedWith.map((f) => f.name), ['Refund an order']);
});

test('exactness is whole-scope: a fresh run plus a file no report looked at is still a floor', () => {
  // every member's file is in the fresh report → exact
  const exact = computeMetric(indexOf(shop({ withObserved: true, freshness: 'unchanged' })), 'test-coverage');
  assert.equal(exact.bound, 'exact');
  assert.equal(exact.uncertainty, undefined);

  // one observed-fresh edge, the rest declared, and a member's file outside the report
  const partial = computeMetric(indexOf(shop({ withObserved: true, freshness: 'unchanged', runFiles: [SVC] })), 'test-coverage');
  assert.equal(partial.bound, 'floor');
  assert.deepEqual(partial.uncertainty!.filesUncovered, [UI]);
  assert.match(partial.uncertainty!.note, /in no fresh coverage report/);
  assert.equal(partial.uncertainty!.staleRuns, undefined);

  // a stale run names the run, not the files
  const stale = computeMetric(indexOf(shop({ withObserved: true, freshness: 'changed' })), 'test-coverage');
  assert.equal(stale.bound, 'floor');
  assert.deepEqual(stale.uncertainty!.staleRuns, ['unit run · 2026-09-10']);
  assert.equal(stale.uncertainty!.filesUncovered, undefined);

  // …and a report that measured a file is what makes its untested members a measurement
  const facts = flowFacts(shop({ withObserved: true, freshness: 'changed' }));
  assert.equal(facts.chip, 'observed-stale', 'every observed run has moved on');
});

test('excluded reconciles to zero: the coverable kinds in scope are the denominator plus the four reasons', () => {
  const index = indexOf(shopUi());
  const m = computeMetric(index, 'test-coverage');
  const ofCoverableKind = [...index.byId.values()]
    .filter((n) => ['function', 'component', 'page', 'route', 'guard', 'rule'].includes(n.kind)).length;
  const { manifestOnly, plumbing, presentational, declaredOnly } = m.excluded;
  assert.equal(m.denominator + manifestOnly + plumbing + presentational + declaredOnly, ofCoverableKind);
  assert.deepEqual(m.excluded, { manifestOnly: 1, plumbing: 1, presentational: 2, declaredOnly: 0 });

  // a declared-but-unbuilt route is its own reason, never folded into manifest-only
  const g = shopUi();
  g.nodes.push({ id: `${R}::route::DELETE /orders/{id}`, kind: 'route', name: 'DELETE /orders/{id}', tags: [],
    contract: { status: 'spec-only', apiId: `${R}::api::x` } } as GraphNode);
  const m2 = computeMetric(indexOf(g), 'test-coverage');
  assert.deepEqual(m2.excluded, { manifestOnly: 1, plumbing: 1, presentational: 2, declaredOnly: 1 });
  assert.equal(m2.denominator, m.denominator);
});

test('metric v2: integration is its own part, and a value stored under v1 says the definition changed', () => {
  const g = shop({ withObserved: true });
  g.nodes.push({
    id: `${R}::test::src/orders.int.spec.ts::refunds against the db`, kind: 'test', name: 'refunds against the db',
    tags: ['test', 'test:integration'], loc: { repo: R, path: 'src/orders.int.spec.ts', line: 3 }, group: 'src/orders.int.spec.ts',
    test: { level: 'integration', runner: 'vitest', suite: [], file: 'src/orders.int.spec.ts' },
  } as GraphNode);
  g.edges.push(edge('covers', `${R}::test::src/orders.int.spec.ts::refunds against the db`, `${R}::${SVC}::refundOrder`,
    { evidence: 'static' }, { status: 'resolved', technique: 'import-resolution', confidence: 'HIGH' }));
  const index = indexOf(g);
  const m = computeMetric(index, 'test-coverage');
  assert.equal(METRICS['test-coverage']!.version, 2);
  assert.equal(m.def.version, 2);
  // an integration test no longer hides inside `unit`
  assert.equal(m.parts!['integration']!.numerator, 1);
  assert.equal(m.parts!['unit']!.numerator, 2);
  assert.equal(m.parts!['either']!.numerator, 4);
  const facts = coverageFor(index, [...index.byId.keys()], { kind: 'workspace', label: 'the shop' });
  assert.equal(facts.counts.integration, 1);
  assert.equal(facts.counts.tests.integration, 1);
  assert.equal(facts.counts.tests.runLevel, 1, 'a report is counted apart from the cases');
  assert.equal(facts.counts.tests.observed, 0, 'the observed edges came from the report, not from a case');
  assert.equal(facts.counts.observedTests, 0);

  // a consumer holding a v1 value is told the question changed, with what it used to ask
  const restated = computeMetric(index, 'test-coverage', { kind: 'workspace' }, { storedVersion: 1 });
  assert.equal(restated.definitionChanged!.fromVersion, 1);
  assert.match(restated.definitionChanged!.was, /integration tests counted inside the `unit` part/);
  assert.equal(computeMetric(index, 'test-coverage', { kind: 'workspace' }, { storedVersion: 2 }).definitionChanged, undefined);
});

test('the gap and evidence lists are uncapped for JSON and capped only when a text printer asks', () => {
  const index = indexOf(shopUi());
  const all = computeMetric(index, 'test-coverage');
  assert.equal(all.gaps.length, 5);
  const capped = computeMetric(index, 'test-coverage', { kind: 'workspace' }, { cap: 2 });
  assert.equal(capped.gaps.length, 2);
  assert.equal(capped.denominator, all.denominator, 'a cap never changes the number');
  assert.equal(capped.numerator, all.numerator);
});

test('suite tallies keep flaky out of passed and out of unknown', () => {
  const g = shop();
  const unit = g.nodes.find((n) => n.name === 'placeOrder totals the lines')!;
  unit.test!.run = { id: 'r9', at: '2026-09-12T09:00:00.000Z', status: 'flaky', retries: 2, freshness: 'unknown', stale: false };
  const s = testsSurface(indexOf(g), null);
  const suite = s.suites.find((x) => x.file === 'src/orders.spec.ts')!;
  assert.equal(suite.counts.flaky, 1);
  assert.equal(suite.counts.passed, 0);
  assert.equal(suite.counts.unknown, 0);
  assert.equal(suite.counts.cases, 1);
});

// ── the farsight-tests-matrix v1 contract (A2.6) ───────────────────────────

const MATRIX_SCHEMA = () => JSON.parse(readFileSync(join(here, '..', '..', '..', 'schemas', 'farsight-tests-matrix-v1.schema.json'), 'utf8'));
const IDENTITY = {
  sync: 7, source_commit: 'abc1234', source_digest: { [R]: 'd1g35700' },
  farsight: 'farsight 0.0.0 · built 1970-01-01T00:00:00.000Z · workspace',
  generated_at: '2026-09-22T00:00:00.000Z',
};

test('farsight-tests-matrix v1: the document validates against the schema file', () => {
  const g = shop({ withObserved: true, e2eBody: true });
  const index = indexOf(g);
  const doc = testsMatrixV1(index, testsSurface(index, null), IDENTITY);
  assert.equal(doc.schema, 'farsight-tests-matrix v1');
  assert.deepEqual(validate(doc, MATRIX_SCHEMA()), []);
  // identity travels with the document and is repeated on every row (a CSV line stands alone)
  assert.deepEqual(doc.identity, IDENTITY);
  assert.ok(doc.rows.length > 0);
  assert.ok(doc.rows.every((r) => r.sync === 7 && r.source_commit === 'abc1234' && r.source_digest === 'd1g35700'));
  // one row per (flow, node, test, covers edge) — never one per node
  assert.equal(new Set(doc.rows.map((r) => `${r.flow_id}|${r.node_id}|${r.test_id}`)).size, doc.rows.length);
  // the schema file is held to real output, and rejects a row that breaks it
  const broken = JSON.parse(JSON.stringify(doc));
  broken.rows[0].evidence_class = 'verified';
  broken.rows[0].stale = 'maybe';
  assert.ok(validate(broken, MATRIX_SCHEMA()).length >= 2);
});

test('testsIdentity: what the graph recorded, and nothing it did not (B3.1)', () => {
  // the full case: sync, commit and a per-repo content digest all read off the graph's meta
  const full = testsIdentity({ sync: 7, commit: 'abc1234', repos: { [R]: { files: 3, sourceHash: 'h', sourceDigest: 'd1g35700' } } }, 'build-line');
  assert.equal(full.sync, 7);
  assert.equal(full.source_commit, 'abc1234');
  assert.deepEqual(full.source_digest, { [R]: 'd1g35700' });
  assert.equal(full.farsight, 'build-line');
  assert.match(full.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  // a graph with none of it: the keys are absent — a `sync: 0` or an empty commit would be a claim
  const bare = testsIdentity({}, 'build-line');
  assert.ok(!('sync' in bare));
  assert.ok(!('source_commit' in bare));
  // `{}` and not undefined: the pass ran and no repo recorded a digest — which is also
  // why a run's freshness can then only read `unknown`
  assert.deepEqual(bare.source_digest, {});
  // a repo with a file count but no content digest contributes no entry, never an empty string
  assert.deepEqual(testsIdentity({ repos: { [R]: { files: 3, sourceHash: 'h' } } }, 'b').source_digest, {});
});

test('testsMatrixCsv: the header is the column order, a null stale prints unknown, commas are quoted', () => {
  const index = indexOf(shop({ withObserved: true, e2eBody: true }));
  const rows = testsMatrixRows(index, testsSurface(index, null), IDENTITY);
  const csv = testsMatrixCsv(rows);
  const lines = csv.split('\n');
  assert.equal(lines[0], TESTS_MATRIX_COLUMNS.join(','));
  assert.equal(lines.length, rows.length + 1);
  // `stale: null` is not `false` — the contract prints the unanswerable question as `unknown`
  const col = TESTS_MATRIX_COLUMNS.indexOf('stale');
  const unknown = rows.findIndex((r) => r.stale === null);
  assert.ok(unknown >= 0, 'the fixture has a run with no source digest');
  assert.equal(lines[unknown + 1]!.split(',')[col], 'unknown');
  // a value with a comma is RFC-4180 quoted, and a quote inside it is doubled
  const quoted = testsMatrixCsv([{ ...rows[0]!, title: 'totals, "twice"' }]);
  assert.ok(quoted.split('\n')[1]!.includes('"totals, ""twice"""'), quoted.split('\n')[1]);
});

test('farsight-tests-matrix v1: the rows sort by every column, so the same graph is byte-identical', () => {
  const g = shop({ withObserved: true, e2eBody: true });
  const forward = testsMatrixRows(indexOf(g), testsSurface(indexOf(g), null), IDENTITY);
  // the same graph, handed to the index in the opposite order: insertion order must not leak into the artefact
  const reversed = { nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() };
  const back = testsMatrixRows(indexOf(reversed), testsSurface(indexOf(reversed), null), IDENTITY);
  assert.equal(JSON.stringify(back), JSON.stringify(forward));
  // sorted by the contract's column order, which is also the CSV header
  const key = (r: (typeof forward)[number]) => TESTS_MATRIX_COLUMNS.map((c) => String(r[c])).join(' ');
  assert.deepEqual(forward.map(key), [...forward.map(key)].sort());
  assert.equal(TESTS_MATRIX_COLUMNS[0], 'flow_id');
  assert.equal(TESTS_MATRIX_COLUMNS.length, Object.keys(forward[0]!).length);
});

test('farsight-tests-matrix v1: `static` prints as reached, and unknown freshness leaves `stale` null', () => {
  const index = indexOf(shop({ withObserved: true, e2eBody: true }));
  const rows = testsMatrixRows(index, testsSurface(index, null), IDENTITY);
  const unit = rows.find((r) => r.test_id.endsWith('placeOrder totals the lines') && r.node_id === `${R}::${SVC}::placeOrder`)!;
  // the graph stores `static`; every consumer reads *reached*
  assert.equal(unit.evidence_class, 'reached');
  assert.equal(unit.technique, 'import-resolution');
  assert.equal(unit.confidence, 'HIGH');
  assert.equal(unit.suite, '');
  assert.equal(unit.level, 'unit');
  // the run exists but recorded no source digest: "not stale" and "not proven fresh" stay apart
  assert.equal(unit.freshness, 'unknown');
  assert.equal(unit.stale, null);
  assert.equal(unit.run_id, 'r1');
  // a declared @covers is never dressed up as an observation
  const declared = rows.find((r) => r.node_id === `${R}::flow::place-order`)!;
  assert.equal(declared.evidence_class, 'declared');
  assert.equal(declared.node_kind, 'flow');
  assert.equal(declared.run_at, '');
  assert.equal(declared.stale, null);
  assert.equal(declared.line, 8);
  // a coverage report is a run, not a test case
  const runLevel = rows.find((r) => r.run_level)!;
  assert.equal(runLevel.evidence_class, 'observed');
  assert.equal(runLevel.line, null);
  // the screen carries its design id; a non-screen node carries none
  assert.equal(rows.find((r) => r.node_id === `${R}::page::/orders`)!.screen_id, 'ORD-01');
  assert.equal(unit.screen_id, '');

  // a run whose digest no longer matches: freshness answers, and `stale` becomes a real boolean
  const fresh = indexOf(shop({ withObserved: true, e2eBody: true, freshness: 'changed' }));
  const changed = testsMatrixRows(fresh, testsSurface(fresh, null), IDENTITY).find((r) => r.run_level)!;
  assert.equal(changed.freshness, 'changed');
  assert.equal(changed.stale, true);
});

test('verifiedThrough: a table is reached through its accessors, and the ref names which', () => {
  const index = indexOf(shop({ withTable: true }));
  const table = `${R}::table::orders`;
  // nothing covers a table directly - that is the whole point of the accessor question
  assert.deepEqual(verifiedBy(index, table), []);
  const through = verifiedThrough(index, table);
  assert.equal(through.length, 1);
  assert.equal(through[0]!.id, `${R}::test::src/orders.spec.ts::placeOrder totals the lines`);
  assert.equal(through[0]!.via, `${R}::${SVC}::placeOrder`);         // the accessor that reached it
  assert.equal(through[0]!.reaches.nodeId, table);                    // what it verifies, through that accessor
  assert.equal(through[0]!.evidence, 'static');
  // refundOrder reads the table too, but no test reaches it: an absence, not a row
  assert.ok(!through.some((t) => t.via === `${R}::${SVC}::refundOrder`));
  // an observed run reaching the accessor is listed as well, once per (test, accessor)
  const withRun = indexOf(shop({ withTable: true, withObserved: true }));
  const refs = verifiedThrough(withRun, table);
  assert.equal(refs.length, 2);
  assert.ok(refs.some((t) => t.runLevel && t.evidence === 'observed'));
  assert.equal(new Set(refs.map((t) => `${t.id}|${t.via}`)).size, refs.length);
  assert.deepEqual(verifiedThrough(index, 'shop::table::nope'), []);
});

// ── one test's own page: the detail fold (03 §4.2, chunk B3.4) ──────────────

test('the detail fold carries per-edge technique, confidence, the twin note and what it set aside', () => {
  const g = shop({ withObserved: true, freshness: 'unchanged' });
  const unit = `${R}::test::src/orders.spec.ts::placeOrder totals the lines`;
  // the production accessor was picked by method name over an in-memory double:
  // the note lives on the `calls` edge, and the detail row prints it
  g.edges.push(edge('calls', `${R}::${SVC}::refundOrder`, `${R}::${SVC}::placeOrder`, { line: 25 },
    { status: 'heuristic', technique: 'method-name', confidence: 'MEDIUM',
      note: 'in-memory twin set aside: InMemoryOrders.placeOrder', alternatives: [`${R}::src/test/InMemoryOrders.ts::placeOrder`] }));
  // a second, weak reach: a URL literal, LOW — a class is not a confidence
  g.edges.push(edge('covers', unit, `${R}::route::POST /orders`, { evidence: 'static', line: 9 },
    { status: 'heuristic', technique: 'route-literal', confidence: 'LOW', note: 'a URL literal in the test',
      alternatives: [`${R}::route::POST /orders/legacy`] }));
  const index = indexOf(g);
  const d = testDetail(index, unit)!;

  const toPlace = d.covers.find((c) => c.nodeId === `${R}::${SVC}::placeOrder`)!;
  assert.equal(toPlace.evidence, 'static');
  assert.equal(toPlace.technique, 'import-resolution');
  assert.equal(toPlace.confidence, 'HIGH');
  // the twin is the graph's fact about the node, not the covers edge's
  assert.match(toPlace.twin!.note, /in-memory twin set aside/);
  assert.equal(toPlace.twin!.nodeId, `${R}::${SVC}::refundOrder`);
  assert.equal(toPlace.alternatives, undefined, 'this edge recorded none — silence, not "none considered"');

  const weak = d.covers.find((c) => c.nodeId === `${R}::route::POST /orders`)!;
  assert.equal(weak.evidence, 'static', 'the class is the edge’s');
  assert.equal(weak.confidence, 'LOW', 'and the confidence is its own — a reached edge can be LOW');
  assert.deepEqual(weak.alternatives, [`${R}::route::POST /orders/legacy`]);
  assert.equal(weak.line, 9, 'the line of the test file the reach was found on');

  // a coverage report observed nodes this case reaches; it named no case, so the
  // observation is listed as the run's, never as this test's
  assert.equal(d.covers.some((c) => c.evidence === 'observed'), false);
  assert.equal(d.alsoObserved!.length, 1);
  assert.equal(d.alsoObserved![0]!.id, `${R}::test::run:unit:shop`);
  assert.equal(d.alsoObserved![0]!.runLevel, true);
  assert.equal(d.alsoObserved![0]!.nodes, 2, 'both nodes this case reaches');
  // the run-level node's own page has the observed edges and no claims
  const report = testDetail(index, `${R}::test::run:unit:shop`)!;
  assert.equal(report.test.runLevel, true);
  assert.ok(report.covers.every((c) => c.evidence === 'observed'));
  assert.equal(report.alsoObserved, undefined);
});

test('an inactive case shows its edges marked and no observed one; an orphan says which reason', () => {
  const g = shop({ e2eBody: true, e2eInactive: true, withObserved: true });
  const e2e = `${R}::test::e2e/order.pw.spec.ts::places an order`;
  const index = indexOf(g);
  const d = testDetail(index, e2e)!;
  // .skip: the case is listed, its edges are marked, and nothing it touches is observed by it
  assert.equal(d.test.inactive, true);
  assert.ok(d.covers.length >= 3);
  assert.ok(d.covers.every((c) => c.inactive), 'the flag rides on the case as well as the edge');
  assert.equal(d.covers.some((c) => c.evidence === 'observed'), false);
  // the fixture's e2e test declares ORD-99, which nothing answers to
  assert.equal(d.orphan!.reason, 'unresolved-claim');
  assert.deepEqual(d.orphan!.declares, ['ORD-99']);
  // ...and the page and the catalogue agree about who the orphans are
  const surface = testsSurface(index, null);
  assert.ok(surface.orphans.some((o) => o.testId === e2e && o.reason === d.orphan!.reason));

  // a test that lands on nothing reads the other reason
  const lone = { ...g };
  lone.nodes = [...g.nodes, { id: `${R}::test::src/lone.spec.ts::proves nothing here`, kind: 'test', name: 'proves nothing here',
    tags: ['test', 'test:unit'], loc: { repo: R, path: 'src/lone.spec.ts', line: 2 },
    test: { level: 'unit', runner: 'vitest', suite: [], file: 'src/lone.spec.ts' } } as GraphNode];
  const li = indexOf(lone);
  const orphan = testDetail(li, `${R}::test::src/lone.spec.ts::proves nothing here`)!;
  assert.equal(orphan.orphan!.reason, 'covers-nothing');
  assert.equal(orphan.covers.length, 0);
});

test('an observed edge carries how the coverage row met the node, and the match is not the freshness', () => {
  const g = shop({ withObserved: true, freshness: 'unchanged' });
  const run = `${R}::test::run:unit:shop`;
  // the weakest of the three joins: a different name, one line away
  g.edges.push(edge('covers', run, `${R}::${SVC}::refundOrder`, { evidence: 'observed', match: 'line±1' },
    { status: 'heuristic', technique: 'coverage-report', confidence: 'LOW', note: 'matched by line ±1 — the name differs' }));
  const d = testDetail(indexOf(g), run)!;
  const weak = d.covers.find((c) => c.nodeId === `${R}::${SVC}::refundOrder`)!;
  assert.equal(weak.match, 'line±1');
  assert.equal(weak.confidence, 'LOW');
  // the fresh digest does not lift it: freshness is about the code, match is about the row
  assert.equal(d.test.run!.freshness, 'unchanged');
  const strong = d.covers.find((c) => c.nodeId === `${R}::${SVC}::placeOrder`)!;
  assert.equal(strong.confidence, 'HIGH');
  assert.equal(strong.match, undefined, 'this fixture edge records none');
});

test('e2eVia carries the lifting test’s file, so no consumer parses it out of an id', () => {
  const facts = flowFacts(shop({ e2eBody: true }));
  assert.equal(facts.e2eVia!.file, 'e2e/order.pw.spec.ts');
  assert.equal(facts.e2eVia!.line, 8);
  // and it is the same file the test node carries — one fact, read once
  assert.equal(facts.e2eVia!.file, indexOf(shop({ e2eBody: true })).byId.get(facts.e2eVia!.testId)!.test!.file);
});
