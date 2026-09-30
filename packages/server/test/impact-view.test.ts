// The change-impact panel's pure parts, held against the core fold they mirror.
//
// The viewer cannot import the core, so `impact.js` carries its own copy of the
// "tests reaching hops 1–N" union. The story swarm (2026-09-25) found that copy
// printing only the tests *new* at each distance under a label that said
// *everything listed so far* — 1 · 8 · 42 · 22 on the reference app where the union is
// 1 · 9 · 51 · 73. This suite runs the shipped module against `impactOf` and
// `impactTestsReaching` on one graph, so the two cannot drift again, and holds
// the business sentence to agreeing in number with its counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildIndex, impactOf, impactTestsReaching, type GraphNode, type GraphEdge } from '@farsight/core';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', 'public', 'app');

// the viewer modules expect a browser: the smallest stand-ins that hold them
const g = globalThis as any;
g.window = g;
g.document = { body: { className: 'lens-business surface-graph' } };

const { STRINGS } = await import(join(here, '..', '..', 'core', 'dist', 'strings.js'));
const { S } = await import(join(appDir, 'store.js'));
const { impTestsReaching, impactBizLine } = await import(join(appDir, 'impact.js'));
S.STRINGS = STRINGS;
S.register = 'professional';

const R = 'shop';
const fn = (name: string, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id: `${R}::svc.ts::${name}`, kind: 'function', name, tags: [], loc: { repo: R, path: 'svc.ts', line: 1 }, ...extra }) as GraphNode;
const tst = (name: string, level: 'unit' | 'e2e'): GraphNode =>
  ({ id: `${R}::test::${name}`, kind: 'test', name, tags: [], loc: { repo: R, path: `${name}.spec.ts`, line: 1 },
    test: { level, runner: level === 'e2e' ? 'playwright' : 'vitest', suite: [], file: `${name}.spec.ts`, project: 'p' } }) as GraphNode;
const calls = (from: string, to: string): GraphEdge => ({ id: `calls|${from}|${to}`, kind: 'calls', from: `${R}::svc.ts::${from}`, to: `${R}::svc.ts::${to}`, meta: { line: 1 } });
const covers = (t: string, to: string): GraphEdge =>
  ({ id: `covers|${t}|${to}`, kind: 'covers', from: `${R}::test::${t}`, to: `${R}::svc.ts::${to}`, meta: { evidence: 'static' } } as GraphEdge);

/** seed ← a ← b ← c, and tests that meet the walk at more than one distance. */
function graph() {
  return buildIndex(
    [fn('seed'), fn('a'), fn('b'), fn('c'), tst('near', 'unit'), tst('span', 'e2e'), tst('far', 'unit'), tst('farther', 'e2e')],
    [calls('a', 'seed'), calls('b', 'a'), calls('c', 'b'),
      covers('near', 'a'), covers('span', 'a'), covers('span', 'b'), covers('span', 'c'), covers('far', 'b'), covers('farther', 'c')],
  );
}

test('the panel counts the same union as the core, at every distance, and it never goes down', () => {
  const report = impactOf(graph(), `${R}::svc.ts::seed`, { hops: 3, tests: true });
  const view = [1, 2, 3].map((h) => impTestsReaching(report, h));
  const core = [1, 2, 3].map((h) => impactTestsReaching(report, h));
  assert.deepEqual(view.map((v: { total: number }) => v.total), core.map((c) => c.total));
  assert.deepEqual(view.map((v: { byLevel: Record<string, number> }) => v.byLevel), core.map((c) => c.byLevel));
  // near + span at 1; far joins at 2 (span is already counted); farther at 3
  assert.deepEqual(view.map((v: { total: number }) => v.total), [2, 3, 4]);
  // the defect: a shared `seen` set across calls printed only what was new — 2 · 1 · 1
  const again = impTestsReaching(report, 2);
  assert.equal(again.total, 3, 'asking twice gives the same answer: nothing is carried between calls');
});

test('the business sentence agrees in number with each of its counts', () => {
  const one = { flows: new Map([['f', 'Pay an invoice']]), actions: 1, total: 10 };
  assert.equal(impactBizLine(1, 'Submit', one), '1 thing uses Submit directly, in 1 action across 1 of 10 journeys.');
  assert.equal(impactBizLine(5, 'Submit', { flows: new Map([['f', 'A'], ['g', 'B']]), actions: 47, total: 10 }),
    '5 things use Submit directly, in 47 actions across 2 of 10 journeys.');
  assert.equal(impactBizLine(1, 'Submit', { ...one, total: 1 }), '1 thing uses Submit directly, in 1 action across the one journey in this workspace.');
  assert.equal(impactBizLine(1, 'Submit', null), '1 thing uses Submit directly. No journey in this workspace reaches it.');
  for (const s of [impactBizLine(1, 'X', one), impactBizLine(1, 'X', null)]) {
    assert.doesNotMatch(s, /\b1 (things|actions|tests)\b/);
    assert.doesNotMatch(s, /\{[a-z]+\}/, 'every placeholder filled');
  }
});
