// The Map's Affected mode, pure parts (lib/map-affected-model.js, map-pass-2026-10-03 §4): the seed's
// link grammar, several seeds laid over one board with each kept apart (never summed), the words key
// for a distance, and one answer read per distance with each test once at its nearest distance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', 'public', 'app');
const M = await import(join(appDir, 'lib', 'map-affected-model.js'));

test('a seed reads from the link: a node id, a package, a work item, a commit', () => {
  assert.deepEqual(M.parseSeedSpec('app::route::POST /x'), { type: 'node', id: 'app::route::POST /x', spec: 'app::route::POST /x' });
  assert.deepEqual(M.parseSeedSpec('package:app::package::zod'), { type: 'package', id: 'app::package::zod', spec: 'package:app::package::zod' });
  assert.deepEqual(M.parseSeedSpec('work:KAN-3'), { type: 'work', id: 'KAN-3', spec: 'work:KAN-3' });
  assert.equal(M.parseSeedSpec('commit:a1c9e02').type, 'commit');
  assert.equal(M.parseSeedSpec('commit:nope'), null, 'a commit is hex');
  assert.equal(M.parseSeedSpec(''), null);
  assert.equal(M.parseSeedSpec('work:'), null);
  assert.equal(M.seedSpec('work', 'KAN-3'), 'work:KAN-3');
  assert.equal(M.hopsOf('4'), 4);
  assert.equal(M.hopsOf(9), M.AFF_HOPS);
});

test('several seeds lay over one board: the nearest distance shows, every seed keeps its own', () => {
  const reach = (seed: string, screens: [string, number][]) => ({ seed, reach: {
    journeys: [{ flowId: 'f', hop: Math.min(...screens.map((s) => s[1])) }],
    screens: screens.map(([id, hop]) => ({ flowId: 'f', screenId: id, hop })), calls: [{ nodeId: 'r', hop: 2 }], data: [],
  } });
  const c = M.combineReaches([reach('a', [['p1', 0]]), reach('b', [['p1', 2], ['p2', 1]])]);
  assert.deepEqual(c.screens.get('f|p1'), { hop: 0, by: [{ seed: 'a', hop: 0 }, { seed: 'b', hop: 2 }] });
  assert.deepEqual(c.screens.get('f|p2'), { hop: 1, by: [{ seed: 'b', hop: 1 }] });
  assert.equal(c.nodes.get('r').by.length, 2, 'two seeds, two entries — not a count');
});

test('the words for a distance: its own path is not a distance, and business counts no links', () => {
  assert.equal(M.reachKey(0, false), 'map.affected.self');
  assert.equal(M.reachKey(2, false), 'map.affected.at');
  assert.equal(M.reachKey(1, true), 'map.affected.bizAt1');
  assert.equal(M.reachKey(4, true), 'map.affected.bizFar');
  assert.equal(M.reachKey(null, true), 'map.affected.not');
});

test('one answer per distance, each test once at the nearest distance it reaches', () => {
  const t = (id: string) => ({ id, name: id, level: 'unit', evidence: 'static' });
  const report = {
    hops: [
      { hop: 1, nodes: [{ nodeId: 'x', tests: [t('t1')] }] },
      { hop: 2, nodes: [{ nodeId: 'y', tests: [t('t1'), t('t2')] }] },
    ],
    reach: { journeys: [{ flowId: 'f', hop: 0 }], screens: [{ flowId: 'f', screenId: 's', hop: 1 }], calls: [{ nodeId: 'r', hop: 2 }] },
  };
  const g = M.hopGroups(report);
  assert.deepEqual(g.map((x: any) => [x.hop, x.journeys.length, x.screens.length, x.calls.length, x.tests.map((y: any) => y.id)]),
    [[0, 1, 0, 0, []], [1, 0, 1, 0, ['t1']], [2, 0, 0, 1, ['t2']]]);
});

test('a test says its evidence class the way the Tests page does', () => {
  assert.equal(M.testEvidenceKey({ evidence: 'static' }), 'journey.evidence.reached');
  assert.equal(M.testEvidenceKey({ evidence: 'observed', runLevel: true }), 'tests.evidence.runSeen');
  assert.equal(M.testEvidenceKey({ evidence: 'observed', observedVia: 'declaration' }), 'tests.evidence.declaredPassed');
});

test('a change asks about screens and calls first and names the rest as not asked', () => {
  const nodes = Array.from({ length: 10 }, (_, i) => ({ id: 'n' + i, name: 'n' + i, kind: i === 9 ? 'page' : 'function' }));
  const p = M.pickSeeds(nodes, 8);
  assert.equal(p.seeds[0].id, 'n9');
  assert.equal(p.more, 2);
});
