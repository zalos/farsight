// *Stale* said once and only when true (swarm-fixes 2026-10-05, finding 2): one function decides the
// freshness fact for any list of runs — current · stale · no source digest · none — with the run's side
// and the code's side and the catalog key of the one sentence. These pin the fact over synthetic refs,
// the sentence each state prints (both sides, never a bare *stale*), the catalog entries in both
// registers, and the fact a journey's coverage carries agreeing with its chip.
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  freshnessFact, freshnessVars, fillFreshness, codeAtFor, setFreshnessMeta, buildIndex, journey, journeyScope, flowScreenIds,
  coverageFor, testsSurface, STRINGS,
} from '../dist/index.js';
import type { FreshnessRun, GraphNode, GraphEdge, GraphMeta, TestRun } from '../dist/index.js';

const RAN = 'ffe27594072f52c91af36314d4f0302d3b52c0b0';
const NOW = '4632734fc9ac27c228eabdf63b92863283fad0a2';
const run = (freshness: FreshnessRun['freshness'], extra: Partial<FreshnessRun> = {}): FreshnessRun =>
  ({ freshness, at: '2026-10-04T15:17:53.461Z', repo: 'app', ...extra });
const sentence = (f: ReturnType<typeof freshnessFact>, key = f.key) => fillFreshness(STRINGS[key]!.professional, freshnessVars(f));

test('current: a run whose digest still matches — said with the sync it holds for', () => {
  const f = freshnessFact([run('unchanged', { commit: NOW })], { commit: NOW, sync: 106 });
  assert.equal(f.state, 'current');
  assert.equal(f.key, 'fresh.sentence.current');
  assert.deepEqual(f.runs, { current: 1, stale: 0, noDigest: 0 });
  assert.equal(sentence(f), 'current as of sync 106 — the tests ran on the code as it is now');
  assert.equal(f.recipe, undefined, 'nothing to do when it is current');
  // without a sync the sentence drops it, never prints an empty one
  assert.equal(freshnessFact([run('unchanged')]).key, 'fresh.sentence.currentNoSync');
});

test('stale by commit: both sides named — the commit the run saw and the commit the code is at', () => {
  const f = freshnessFact([run('changed', { changedBy: 'commit', commit: RAN })], { commit: NOW, sync: 106 });
  assert.equal(f.state, 'stale');
  assert.equal(f.changedBy, 'commit');
  assert.equal(f.key, 'fresh.sentence.staleCommit');
  assert.equal(sentence(f), 'stale — the tests ran on commit ffe2759 (2026-10-04); the code is at commit 4632734 now');
  assert.equal(f.recipe, 'fresh.recipe.rerun');
  assert.equal(f.biz, 'journey.biz.fresh.stale');
  // a run that recorded no commit: its date stands for its side, the code's commit for the other
  const g = freshnessFact([run('changed', { changedBy: 'commit' })], { commit: NOW });
  assert.equal(g.key, 'fresh.sentence.staleCode');
  assert.match(sentence(g), /ran on 2026-10-04, before the code at commit 4632734/);
  // nothing named on either side: the sentence still says what moved, never a commit it was not given
  const h = freshnessFact([run('changed')]);
  assert.equal(h.key, 'fresh.sentence.staleBare');
  assert.doesNotMatch(sentence(h), /\{|commit/);
});

test('stale by working tree: the same commit, files edited after the run', () => {
  const f = freshnessFact([run('changed', { changedBy: 'working-tree', commit: NOW })], { commit: NOW, sync: 7 });
  assert.equal(f.state, 'stale');
  assert.equal(f.key, 'fresh.sentence.staleTree');
  assert.equal(f.codeAt!.workingTree, true);
  assert.equal(f.biz, 'journey.biz.fresh.staleTree');
  assert.match(sentence(f), /working tree changed after the run/);
  // one run on another commit makes the whole fold a commit change
  const mixed = freshnessFact([run('changed', { changedBy: 'working-tree' }), run('changed', { changedBy: 'commit', commit: RAN })], { commit: NOW });
  assert.equal(mixed.changedBy, 'commit');
});

test('no digest: the absence, never stale — with the recipe that makes it comparable', () => {
  const f = freshnessFact([run('unknown'), run('unknown', { at: '2026-10-03T00:00:00Z' })], { commit: NOW, sync: 3 });
  assert.equal(f.state, 'no-digest');
  assert.equal(f.key, 'fresh.sentence.noDigest');
  assert.equal(f.ranAt, '2026-10-04T15:17:53.461Z', 'the newest run');
  assert.equal(f.recipe, 'fresh.recipe.stamp');
  assert.doesNotMatch(sentence(f), /\bstale\b/);
  // a mix of undigested and older runs: no answer for the whole, both counted in the one sentence
  const some = freshnessFact([run('unknown'), run('changed', { changedBy: 'commit', commit: RAN })], { commit: NOW });
  assert.equal(some.state, 'no-digest');
  assert.equal(some.key, 'fresh.sentence.noDigestSome');
  assert.equal(sentence(some), 'no source digest was recorded for 1 of these runs (the newest 2026-10-04); the other 1 ran before the code last changed');
});

test('none: no run, no comparison — and one current run outweighs older ones', () => {
  const f = freshnessFact([]);
  assert.equal(f.state, 'none');
  assert.equal(f.key, 'fresh.sentence.none');
  const best = freshnessFact([run('changed', { changedBy: 'commit' }), run('unknown'), run('unchanged')], { commit: NOW, sync: 2 });
  assert.equal(best.state, 'current', 'the chip is not stale while any observing run speaks for the code — neither is this');
  assert.deepEqual(best.runs, { current: 1, stale: 1, noDigest: 1 });
});

test('every freshness word and sentence is in the catalog, in both registers, with a define; no placeholder left unfilled', () => {
  const facts = [
    freshnessFact([run('unchanged')], { commit: NOW, sync: 1 }), freshnessFact([run('unchanged')]),
    freshnessFact([run('changed', { changedBy: 'commit', commit: RAN })], { commit: NOW, sync: 1 }),
    freshnessFact([run('changed', { changedBy: 'commit' })], { commit: NOW }), freshnessFact([run('changed')]),
    freshnessFact([run('changed', { changedBy: 'working-tree' })], { commit: NOW }),
    freshnessFact([run('unknown')]), freshnessFact([run('unknown'), run('changed')]), freshnessFact([]),
  ];
  for (const f of facts) {
    for (const key of [f.word, f.key, f.biz, ...(f.recipe ? [f.recipe] : [])]) {
      const e = STRINGS[key];
      assert.ok(e, `${key} is in the catalog`);
      assert.ok(e.hud && e.professional && e.define, `${key}: both registers and a define`);
    }
    for (const key of [f.key, f.biz]) {
      assert.doesNotMatch(fillFreshness(STRINGS[key]!.professional, freshnessVars(f)), /\{\w+\}/, `${key} filled`);
    }
  }
});

test('the code side comes from the graph meta: the tests pass\'s HEAD, else a one-source graph\'s commit', () => {
  assert.deepEqual(codeAtFor({ commit: NOW, sync: 9, repos: { app: { files: 1, sourceHash: 'x' } } } as GraphMeta, 'app'), { commit: NOW, sync: 9 });
  const two = { commit: 'workspace', sync: 9, repos: { a: { files: 1, sourceHash: 'x' }, b: { files: 1, sourceHash: 'y' } },
    tests: { a: { files: 0, cases: 0, edges: { declared: 0, static: 0, observed: 0 }, runs: 0, reports: [], blindSpots: [], head: { sha: RAN } } } } as unknown as GraphMeta;
  assert.deepEqual(codeAtFor(two, 'a'), { commit: RAN, sync: 9 });
  assert.deepEqual(codeAtFor(two, 'b'), { sync: 9 }, 'a workspace commit is not a source\'s commit');
});

// ── on a graph: the fact a journey's coverage carries agrees with its chip ──
const R = 'shop';
const FLOW = `${R}::flow::place-order`;
const PAGE = `${R}::page::/orders`;
const E2E = `${R}::test::e2e/order.pw.spec.ts::places an order`;
const edge = (kind: GraphEdge['kind'], from: string, to: string, meta?: GraphEdge['meta']): GraphEdge => ({ id: `${kind}|${from}|${to}`, kind, from, to, ...(meta ? { meta } : {}) });
function shop(r: Partial<TestRun>) {
  const nodes: GraphNode[] = [
    { id: FLOW, kind: 'flow', name: 'Place an order', tags: [], design: { status: 'both', origin: 'manifest', id: 'ORD-01' } } as GraphNode,
    { id: PAGE, kind: 'page', name: '/orders', tags: [], loc: { repo: R, path: 'src/ui/OrderPage.tsx', line: 3 }, design: { status: 'both', origin: 'manifest', id: 'ORD-01' } } as GraphNode,
    { id: E2E, kind: 'test', name: 'places an order', tags: ['test'], loc: { repo: R, path: 'e2e/order.pw.spec.ts', line: 8 },
      test: { level: 'e2e', runner: 'playwright', suite: [], file: 'e2e/order.pw.spec.ts', declares: ['place-order'],
        run: { id: 'pw', at: '2026-10-04T15:17:53.461Z', status: 'passed', freshness: 'unknown', stale: false, ...r } } } as GraphNode,
  ];
  const edges = [edge('renders', FLOW, PAGE, { line: 1 }), edge('covers', E2E, FLOW, { evidence: 'declared', declared: 'place-order' }), edge('covers', E2E, PAGE, { evidence: 'declared', declared: 'ORD-01' })];
  const index = buildIndex(nodes, edges);
  setFreshnessMeta(index, { commit: NOW, sync: 106, repos: { [R]: { files: 2, sourceHash: 'h' } } } as GraphMeta);
  return { index, facts: coverageFor(index, journeyScope(index, journey(index, FLOW), flowScreenIds(index, FLOW)), { kind: 'flow', label: 'Place an order', flowId: FLOW }) };
}

test('a journey whose observing run is older than its code: chip stale, the fact names both commits', () => {
  const { facts } = shop({ freshness: 'changed', stale: true, changedBy: 'commit', commit: RAN });
  assert.equal(facts.chip, 'observed-stale');
  assert.equal(facts.freshness!.state, 'stale');
  assert.equal(sentence(facts.freshness!), 'stale — the tests ran on commit ffe2759 (2026-10-04); the code is at commit 4632734 now');
});

test('a journey whose run is current says so; one with no digest is not stale', () => {
  const cur = shop({ freshness: 'unchanged', commit: NOW }).facts;
  assert.equal(cur.chip, 'observed');
  assert.equal(cur.freshness!.state, 'current');
  assert.equal(sentence(cur.freshness!), 'current as of sync 106 — the tests ran on the code as it is now');
  const nd = shop({ freshness: 'unknown' }).facts;
  assert.notEqual(nd.chip, 'observed-stale');
  assert.equal(nd.freshness!.state, 'no-digest');
});

test('a source card is per runner, with one freshness fact — never a Playwright card badged by a vitest spec', () => {
  const { index } = shop({ freshness: 'changed', stale: true, changedBy: 'commit', commit: RAN });
  // a vitest spec under the e2e level with an undigested run, newer than the Playwright run
  index.byId.set(`${R}::test::e2e/helpers.spec.ts::parses`, {
    id: `${R}::test::e2e/helpers.spec.ts::parses`, kind: 'test', name: 'parses', tags: ['test'], loc: { repo: R, path: 'e2e/helpers.spec.ts', line: 1 },
    test: { level: 'e2e', runner: 'vitest', suite: [], file: 'e2e/helpers.spec.ts', run: { id: 'v', at: '2026-10-04T18:00:00Z', status: 'passed', freshness: 'unknown', stale: false, report: 'coverage/e2e/vitest-results.json' } },
  } as GraphNode);
  const cards = testsSurface(index, null).sources.filter((c) => c.level === 'e2e');
  assert.deepEqual(cards.map((c) => c.runner).sort(), ['playwright', 'vitest']);
  const pw = cards.find((c) => c.runner === 'playwright')!;
  assert.equal(pw.fresh!.state, 'stale');
  assert.match(pw.freshness, /code changed after this run/);
  assert.doesNotMatch(pw.freshness, /no source digest/, 'one answer per card');
  assert.equal(cards.find((c) => c.runner === 'vitest')!.fresh!.state, 'no-digest');
});
