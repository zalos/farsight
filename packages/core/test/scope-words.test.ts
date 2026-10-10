// Every test number carries its scope (round 2026-10-10, proposal 4; swarm round 2
// findings 1.1–1.4, 1.6, 1.7). One screen read *323 cases · passed*, its drawer
// *no test reaches this part · 125 reach the action*, impact *2 tests* and the gate
// card *16* — four true numbers over four scopes, none named. The verdict now
// carries the words its chip prints for the scope, the skips are lifted out of the
// runs so *passed* never hides them, and a designed, not-built screen has no
// verdict at all. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNT_SCOPES, SCOPE_WORDS, scopeWord, STRINGS, evidenceFacts, caseWord, coverageFor,
  buildIndex, journey, journeySummary, screensFor, journeyCoverage, cellCoverage, segmentNotBuilt,
} from '../dist/index.js';
import type { CoverageTestRef, GraphNode, GraphEdge } from '../dist/index.js';

test('every scope a test number can count over has chip words in the catalog, with a define', () => {
  for (const scope of COUNT_SCOPES) {
    const k = scopeWord(scope);
    assert.ok(STRINGS[k], `${scope} → ${k} is not in the catalog`);
    assert.ok(STRINGS[k]!.define, `${k} has no define`);
  }
  for (const k of Object.values(SCOPE_WORDS)) assert.match(STRINGS[k!]!.professional, /^over /, `${k} reads as a scope`);
  // the test scopes the swarm met side by side each have their own words
  const words = ['journey.scopeAll', 'journey.scopeHere', 'count.scope.action', 'count.scope.node', 'count.scope.gate', 'count.scope.affected'].map((s) => scopeWord(s));
  assert.equal(new Set(words).size, words.length);
});

let seq = 0;
function ref(evidence: CoverageTestRef['evidence'], status: string | null, extra: Partial<CoverageTestRef> = {}): CoverageTestRef {
  seq++;
  return {
    id: `r::test::t${seq}`, name: `case ${seq}`, level: 'e2e', runner: 'playwright', evidence, runLevel: false,
    reaches: { nodeId: 'r::page::/x', name: '/x', kind: 'page' },
    ...(status ? { status, at: '2026-10-04T10:00:00.000Z', freshness: 'unchanged', stale: false } : {}),
    ...extra,
  } as CoverageTestRef;
}

test('the verdict carries its scope words and lifts failed · skipped · flaky out of the runs', () => {
  const refs = [
    ref('observed', 'passed', { observedVia: 'declaration' }), ref('observed', 'passed', { observedVia: 'declaration' }),
    ref('static', 'skipped'), ref('static', 'skipped'), ref('static', 'failed'), ref('declared', 'flaky'), ref('declared', null),
  ];
  const v = evidenceFacts(refs, 'journey.scopeHere', 'test').verdict;
  assert.equal(v.scopeWord, 'count.over.screen');
  assert.equal(v.word.key, 'tests.evidence.declaredPassed');
  assert.equal(v.status, 'passed', 'the word keeps its run');
  assert.deepEqual({ failed: v.failed, skipped: v.skipped, flaky: v.flaky }, { failed: 1, skipped: 2, flaky: 1 });
  const part = (k: string) => v.runs.breakdown!.find((p) => p.key === `count.part.${k}`)!.n;
  assert.deepEqual([part('failed'), part('skipped'), part('flaky')], [v.failed, v.skipped, v.flaky], 'the same numbers as the runs breakdown');
  assert.equal(evidenceFacts(refs, 'count.scope.action', 'test').verdict.scopeWord, 'count.over.action');
  assert.equal(evidenceFacts(refs, 'count.scope.gate', 'test').verdict.scopeWord, 'count.over.gate');
});

// ── a designed, not-built screen ───────────────────────────────────────────
const R = 'app';
const edge = (kind: GraphEdge['kind'], from: string, to: string, meta?: GraphEdge['meta']): GraphEdge => ({ id: `${kind}|${from}|${to}`, kind, from, to, ...(meta ? { meta } : {}) });
const FLOW = `${R}::flow::f`, BUILT = `${R}::page::/a`, PLANNED = `${R}::page::/done`, ROUTE = `${R}::route::POST /api/x`;
const E2E = `${R}::test::e.spec.ts::submits`, UNIT = `${R}::test::r.test.ts::answers`;
function app() {
  const run = (status: 'passed' | 'skipped') => ({ id: 'r', at: '2026-10-01T00:00:00.000Z', status, freshness: 'unknown' as const, stale: false });
  const nodes = [
    { id: FLOW, kind: 'flow', name: 'F', tags: [] },
    { id: BUILT, kind: 'page', name: '/a', tags: [], loc: { repo: R, path: 'a.tsx', line: 1 }, design: { id: 'S-01', status: 'both' } },
    { id: PLANNED, kind: 'page', name: '/done', tags: [], design: { id: 'S-02', status: 'design-only' } },
    { id: ROUTE, kind: 'route', name: 'POST /api/x', tags: [], loc: { repo: R, path: 'r.ts', line: 2 } },
    { id: E2E, kind: 'test', name: 'submits', tags: ['test'], loc: { repo: R, path: 'e.spec.ts', line: 1 }, test: { level: 'e2e', runner: 'playwright', suite: [], file: 'e.spec.ts', run: run('passed') } },
    { id: UNIT, kind: 'test', name: 'answers', tags: ['test'], loc: { repo: R, path: 'r.test.ts', line: 1 }, test: { level: 'unit', runner: 'vitest', suite: [], file: 'r.test.ts', run: run('skipped') } },
  ] as GraphNode[];
  const edges = [
    edge('renders', FLOW, BUILT), edge('renders', FLOW, PLANNED),
    edge('http', BUILT, ROUTE, { line: 3 }), edge('http', PLANNED, ROUTE, { line: 3 }),
    edge('covers', E2E, ROUTE, { evidence: 'declared' }), edge('covers', UNIT, ROUTE, { evidence: 'static' }),
  ];
  return buildIndex(nodes, edges);
}

test('a designed, not-built screen never carries passed: no word, no status, the cases that reach its route scoped to that route', () => {
  const index = app();
  const j = journey(index, FLOW);
  const summary = journeySummary(index, j, screensFor(index, FLOW));
  const cov = journeyCoverage(index, j, summary)!;
  const at = summary.segments.findIndex((sg) => sg.screen?.id === PLANNED);
  const built = summary.segments.findIndex((sg) => sg.screen?.id === BUILT);
  assert.ok(at >= 0 && built >= 0);
  assert.equal(segmentNotBuilt(summary.segments[at]!), true);
  assert.equal(segmentNotBuilt(summary.segments[built]!), false);
  // the built screen keeps its word and its run
  assert.equal(cov.segments[built]!.verdict.status, 'passed');
  const nb = cov.segments[at]!;
  assert.equal(nb.notBuilt, true);
  assert.equal(nb.chip, 'none');
  assert.equal(nb.evidenceWord.key, 'journey.absent.notBuilt');
  assert.equal(nb.verdict.notBuilt, true);
  assert.equal(nb.verdict.status, undefined, 'no status on a screen with no code');
  assert.equal(nb.observation, undefined);
  // what the cases do reach, with its own scope
  assert.equal(nb.counted!.tests.n, 2);
  assert.equal(nb.counted!.tests.scope, 'count.scope.route');
  assert.equal(nb.verdict.scopeWord, 'count.over.route');
  assert.equal(nb.verdict.skipped, 1, 'the skips stay counted');
  // its actions follow it, and the Tests page's door reads the same cell
  for (const m of cov.moments![at]!) { assert.equal(m.verdict.status, undefined); assert.equal(m.evidenceWord.key, 'journey.absent.notBuilt'); }
  const cell = cellCoverage(index, j, summary, at)!;
  assert.equal(cell.facts.notBuilt, true);
  assert.equal(cell.facts.verdict.word.key, nb.verdict.word.key);
  assert.equal(cell.facts.counted!.tests.n, nb.counted!.tests.n);
});

test('every covering ref carries its own word, equal to caseWord', () => {
  const index = app();
  const facts = coverageFor(index, [ROUTE], { kind: 'segment', label: 'x' });
  assert.ok(facts.tests.length === 2);
  for (const r of facts.tests) {
    const w = caseWord(r);
    assert.deepEqual(r.word, { cls: w.cls, key: w.key });
  }
  assert.ok(facts.tests.some((r) => r.word!.key === 'tests.evidence.declaredPassed'));
});
