// The round-3 swarm's verdict findings (2026-10-11), held at the fold:
//  - build state wins: a partly built journey's word carries `builtOnly`, every surface prints *partly built · n of m*
//    before it and *over the n built screens* after it, and the state of play counts it apart from *passed*;
//  - the readiness brief holds only on a screen not built or the journey's own declared case skipped or failed, names
//    the case, keeps every other skip as a note, and its header totals are distinct with the per-row numbers beside.
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndex, journey, journeySummary, screensFor, journeyCoverage, coverageFor, builtOnlyWords, readiness, stateOfPlay, STRINGS, codeFree, httpWords,
} from '../dist/index.js';
import type { GraphNode, GraphEdge, JourneyTree } from '../dist/index.js';

const R = 'app';
const edge = (kind: GraphEdge['kind'], from: string, to: string, meta?: GraphEdge['meta']): GraphEdge => ({ id: `${kind}|${from}|${to}`, kind, from, to, ...(meta ? { meta } : {}) });
const FLOW = `${R}::flow::f`, BUILT = `${R}::page::/a`, PLANNED = `${R}::page::/done`, ROUTE = `${R}::route::POST /api/x`;
const E2E = `${R}::test::e.spec.ts::submits`, UNIT = `${R}::test::r.test.ts::answers`;
const FLOW2 = `${R}::flow::g`, PAGE2 = `${R}::page::/b`, E2E2 = `${R}::test::g.spec.ts::walks`;

type St = 'passed' | 'skipped' | 'failed';
function app(o: { e2e?: St; unit?: St; e2e2?: St; planned?: boolean } = {}) {
  const run = (status: St) => ({ id: 'r', at: '2026-10-01T00:00:00.000Z', status, freshness: 'unknown' as const, stale: false });
  const nodes = [
    { id: FLOW, kind: 'flow', name: 'F', tags: [], design: { id: 'f', name: 'F' } },
    { id: BUILT, kind: 'page', name: '/a', tags: [], loc: { repo: R, path: 'a.tsx', line: 1 }, design: { id: 'S-01', status: 'both' } },
    o.planned === false
      ? { id: PLANNED, kind: 'page', name: '/done', tags: [], loc: { repo: R, path: 'done.tsx', line: 1 }, design: { id: 'S-02', status: 'both' } }
      : { id: PLANNED, kind: 'page', name: '/done', tags: [], design: { id: 'S-02', status: 'design-only' } },
    { id: ROUTE, kind: 'route', name: 'POST /api/x', tags: [], loc: { repo: R, path: 'r.ts', line: 2 } },
    { id: E2E, kind: 'test', name: 'submits', tags: ['test'], loc: { repo: R, path: 'e.spec.ts', line: 1 }, test: { level: 'e2e', runner: 'playwright', suite: [], file: 'e.spec.ts', declares: ['f'], run: run(o.e2e ?? 'passed') } },
    { id: UNIT, kind: 'test', name: 'answers', tags: ['test'], loc: { repo: R, path: 'r.test.ts', line: 1 }, test: { level: 'unit', runner: 'vitest', suite: [], file: 'r.test.ts', run: run(o.unit ?? 'skipped') } },
    { id: FLOW2, kind: 'flow', name: 'G', tags: [], design: { id: 'g', name: 'G' } },
    { id: PAGE2, kind: 'page', name: '/b', tags: [], loc: { repo: R, path: 'b.tsx', line: 1 }, design: { id: 'S-03', status: 'both' } },
    { id: E2E2, kind: 'test', name: 'walks', tags: ['test'], loc: { repo: R, path: 'g.spec.ts', line: 1 }, test: { level: 'e2e', runner: 'playwright', suite: [], file: 'g.spec.ts', declares: ['g'], run: run(o.e2e2 ?? 'passed') } },
  ] as GraphNode[];
  const edges = [
    edge('renders', FLOW, BUILT), edge('renders', FLOW, PLANNED),
    edge('http', BUILT, ROUTE, { line: 3 }), edge('http', PLANNED, ROUTE, { line: 3 }),
    edge('covers', E2E, BUILT, { evidence: 'declared' }), edge('covers', E2E, ROUTE, { evidence: 'declared' }), edge('covers', UNIT, ROUTE, { evidence: 'static' }),
    edge('renders', FLOW2, PAGE2), edge('http', PAGE2, ROUTE, { line: 4 }), edge('covers', E2E2, PAGE2, { evidence: 'declared' }),
  ];
  return buildIndex(nodes, edges);
}

test('a partly built journey: the word keeps its class and says it is over the built screens', () => {
  const index = app();
  const cov = journeyCoverage(index, journey(index, FLOW), journeySummary(index, journey(index, FLOW), screensFor(index, FLOW)))!;
  assert.equal(cov.journey.evidenceWord.cls, 'observed', 'the evidence is real — the class stays');
  assert.deepEqual(cov.journey.evidenceWord.builtOnly, { built: 1, of: 2 });
  assert.deepEqual(cov.journey.verdict.word.builtOnly, { built: 1, of: 2 }, 'the verdict is the same word');
  assert.deepEqual(builtOnlyWords(cov.journey.evidenceWord), { before: 'partly built · 1 of 2', after: 'over the 1 built screen' });
  // a fully built journey carries none
  const full = app({ planned: false });
  assert.equal(coverageFor(full, [BUILT, PLANNED, ROUTE], { kind: 'flow', label: 'F', flowId: FLOW }).evidenceWord.builtOnly, undefined);
  for (const k of ['tests.builtOnly.before', 'tests.builtOnly.after', 'tests.builtOnly.afterOne', 'state.unit.journeysBuiltOnly']) assert.ok(STRINGS[k]?.define, k);
});

test('the state of play never counts a partly built journey under its word', () => {
  const s = stateOfPlay(app(), undefined);
  assert.equal(s.validated.notFullyBuilt.n, 1);
  assert.deepEqual(s.validated.notFullyBuilt.breakdown!.map((p) => p.n), [1, 0]);
  const under = s.validated.byVerdict.reduce((a, v) => a + v.journeys.n, 0);
  assert.equal(under, 1, 'only the fully built journey G is counted under a word');
  const full = stateOfPlay(app({ planned: false }), undefined);
  assert.equal(full.validated.notFullyBuilt.n, 0);
});

function tree(): JourneyTree {
  const row = (nodeId: string, id: string, name: string, built: number, total: number) => ({ nodeId, id, name, repo: R, built, total, status: built === total ? 'both' : 'design-only', screens: [], docs: [], operations: [] });
  return { storylines: [{ id: 's', name: 'S', repo: R, journeys: [row(FLOW, 'f', 'F', 1, 2), row(FLOW2, 'g', 'G', 1, 1)], branches: [] }] } as unknown as JourneyTree;
}

test('readiness holds on its own declared case or a screen not built — and names the case; other skips are notes', () => {
  // the unit case skips: a note on F, never a hold reason; F holds only because a screen is not built
  let r = readiness(app({ planned: false }), tree(), 's')!;
  const f = r.rows.find((x) => x.flowId === FLOW)!;
  const g = r.rows.find((x) => x.flowId === FLOW2)!;
  assert.equal(f.ship, true, 'a skipped unit case three screens away does not hold the journey');
  assert.equal(f.notes.skipped, 1);
  assert.equal(f.ownCases, 1);
  assert.deepEqual(f.holdCases, []);
  assert.equal(g.ship, true);
  // its own declared case skipped: hold, and the case is named
  r = readiness(app({ planned: false, e2e: 'skipped' }), tree(), 's')!;
  const f2 = r.rows.find((x) => x.flowId === FLOW)!;
  assert.deepEqual(f2.hold, ['skipped']);
  assert.deepEqual(f2.holdCases.map((c) => [c.name, c.status]), [['submits', 'skipped']]);
  // a screen not built holds whatever the cases say
  r = readiness(app(), tree(), 's')!;
  assert.deepEqual(r.rows.find((x) => x.flowId === FLOW)!.hold, ['notBuilt']);
});

test('readiness: the header totals are distinct, with every row’s own count beside them for the tip', () => {
  const r = readiness(app({ planned: false }), tree(), 's')!;
  assert.match(STRINGS['count.unit.readinessSkipped']!.professional, /distinct/);
  assert.match(STRINGS['count.unit.readinessUnreached']!.professional, /distinct/);
  assert.equal(r.distinct.skipped.length, r.rows.length);
  assert.deepEqual(r.distinct.skipped.map((x) => x.n), r.rows.map((x) => x.skipped));
  assert.ok(r.distinct.skipped.reduce((a, x) => a + x.n, 0) >= r.counted.skipped.n, 'the rows add up to at least the distinct total');
});

test('the business register says an HTTP status in words, and leaves a count alone', () => {
  assert.equal(codeFree('401 without an operator session'), 'a refusal (nobody is signed in) without an operator session');
  assert.equal(codeFree('approve: 409 while SUBMITTED'), 'approve: a refusal (the record is not in the right state) while SUBMITTED');
  assert.equal(codeFree('the service answers 422 when a field is missing'), 'the service answers a refusal (the details do not pass the checks) when a field is missing');
  assert.equal(codeFree('401 test cases over this journey'), '401 test cases over this journey');
  assert.equal(httpWords('29 passed of 401.', () => 'X'), '29 passed of 401.');
  for (const c of ['400', '401', '403', '404', '409', '413', '415', '422', '429', '5xx']) assert.ok(STRINGS[`http.word.${c}`]?.define, c);
});
