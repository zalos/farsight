// The journey's pure folds (lanes round 2026-10-10, proposal 1 step 1): `public/app/lib/journey-model.js`, the module
// the journey overlay, the drill and the Map's journey / screen / action stops all draw from, held against a real
// `/api/journey` answer captured from the invoice-app fixture (Billing cycle, with its walk). The surfaces re-export
// these under their old names, so what is held here is what every one of them draws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const M = await import(join(here, '..', 'public', 'app', 'lib', 'journey-model.js'));
const fx = JSON.parse(readFileSync(join(here, 'fixtures', 'journey-billing-cycle.json'), 'utf8'));
const sum = fx.summary, steps = fx.steps;
const tree = M.buildTree(steps);

test('the Sheet: one column per stop, the count the core types as actionStops, the layers in request order', () => {
  const sm = M.sheetModel(sum);
  assert.equal(sm.cols.length, 8);
  assert.equal(sm.cols.length, sum.counted.actionStops.n, 'stop n on the Sheet is stop n everywhere');
  assert.deepEqual(sm.cols.map((c: any) => c.index), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(sm.layers.map((l: any) => l.kind), ['user', 'repo', 'api', 'repo', 'gates', 'records', 'messages', 'verified']);
  // the words come from the caller: the catalog's key by default, the surface passes `t`
  assert.equal(sm.layers[0].label, 'journey.layer.user');
  assert.equal(M.sheetModel(sum, { t: (k: string) => k.toUpperCase() }).layers[0].label, 'JOURNEY.LAYER.USER');
});

test('the actions of a screen in the order its manifest lists them, the walk order kept underneath', () => {
  const list = sum.segments[1];
  const ranked = M.rankOrder(list).map((mo: any) => mo.index);
  assert.deepEqual(ranked, [0, 1, 2, 3, 5, 4], 'finalize is last on the manifest though the walk met it fifth');
  assert.deepEqual(list.moments.map((mo: any) => mo.index), [0, 1, 2, 3, 4, 5], 'the fold\'s own array is untouched');
  assert.equal(M.momOrdinal(list, list.moments[4]), 6, 'finalize is action 6 of 6 on Invoice list');
  assert.deepEqual(M.rankOrder({ moments: [{ index: 1 }, { index: 0 }] }).map((m: any) => m.index), [1, 0], 'no rank: walk order');
});

test('the walk\'s tree from depths, and the stop a part sits in', () => {
  assert.equal(tree.parent.length, steps.length);
  assert.deepEqual(tree.roots, [0]);
  tree.parent.forEach((p: number, i: number) => { if (p >= 0) assert.ok(tree.children[p].includes(i)); });
  const fin = M.sheetModel(sum).cols[6];
  const call = fin.sg.markers.find((m: any) => m.kind === 'call' && m.moment === fin.mo.index);
  assert.deepEqual(M.stopOf(sum, call.stepOrder, tree.parent), { n: 7, t: 8 });
  assert.equal(M.stopOf(sum, -1, tree.parent), null);
  assert.equal(M.actionOfMarker(M.sheetModel(sum).cols, call.stepOrder), 6);
});

test('a cell\'s tree: roots and tiers 0–1 drawn, a repeat folded under its first visit, plumbing per the helper', () => {
  const ms = [
    { stepOrder: 1, nodeId: 'a', tier: 0 },
    { stepOrder: 2, nodeId: 'b', tier: 1, under: 1 },
    { stepOrder: 3, nodeId: 'c', tier: 2, under: 2 },
    { stepOrder: 4, nodeId: 'b', tier: 1, under: 1 },
    { stepOrder: 5, nodeId: 'h', tier: 1, under: 1, helper: true },
  ];
  const t0 = M.cellTree(ms);
  assert.deepEqual(t0.top.map((m: any) => m.stepOrder), [1, 2]);
  assert.deepEqual(t0.again(2).map((m: any) => m.stepOrder), [4]);
  assert.deepEqual(t0.drill(2).map((m: any) => m.stepOrder), [3]);
  assert.deepEqual(t0.drill(1).map((m: any) => m.stepOrder), [5], 'a helper folds under its part');
  const t1 = M.cellTree(ms, () => false);
  assert.deepEqual(t1.top.map((m: any) => m.stepOrder), [1, 2, 5], 'a lens that folds nothing as plumbing draws it');
});

test('the drill\'s beats of Finalize invoice: the screen kept open, browser, seam, server, the helper it calls', () => {
  const sm = M.sheetModel(sum);
  const layers = M.drillLayers(sum);
  assert.deepEqual(layers.map((l: any) => l.kind), ['user', 'repo', 'api', 'repo', 'gates', 'records', 'messages', 'external']);
  assert.equal(layers[7].absent, true, 'the third-party row stays, saying the core\'s word');
  const b = M.drillBeats(sm.cols[6], layers, { steps, parent: tree.parent });
  assert.deepEqual(b.beats.map((x: any) => x.kind), ['screen', 'part', 'seam', 'part', 'part']);
  assert.deepEqual(b.beats.slice(1).map((x: any) => x.m.name), ['finalizeInvoice', 'POST /invoices/:id/finalize', 'finalizeInvoice', 'nextInvoiceNumber']);
  assert.equal(b.call.kind, 'call');
  assert.equal(M.beatOrder(b.beats[0]), b.beats[0].order);
  // every box sits in a real layer and beat, and every wire names two boxes the cells draw
  for (const k of Object.keys(b.cells)) {
    const [li, bi] = k.split(':').map(Number);
    assert.ok(layers[li] && bi < b.beats.length, k);
  }
  assert.ok(b.wires.length >= b.beats.length - 1);
  // the gates the caller hands in land in the column of their step, with a wire to it
  const g = { stepOrder: b.beats[3].m.stepOrder, id: 'x', name: 'g' };
  const withGate = M.drillBeats(sm.cols[6], layers, { steps, parent: tree.parent, gates: [g] });
  const gi = layers.findIndex((l: any) => l.kind === 'gates');
  assert.equal(withGate.cells[gi + ':3'][0].type, 'gate');
  assert.ok(withGate.wires.some((w: any) => w.cls === 'gate' && w.b === 'jrn-bg-3-0'));
});

test('an action with a contract gets its answer after the last server beat', () => {
  const sm = M.sheetModel(sum);
  const b = M.drillBeats(sm.cols[1], M.drillLayers(sum), { steps, parent: tree.parent });
  assert.deepEqual(b.beats.map((x: any) => x.kind), ['part', 'part', 'seam', 'part', 'answer']);
  assert.ok(b.wires.some((w: any) => w.b === 'jrn-ans' && w.cls === 'dash'));
});

test('a street screen stands for its segment and the screenless ones folded into it', () => {
  const screens = [{ segment: { index: 1 } }, { segment: { index: 2 } }];
  assert.deepEqual(M.screenSegments(screens, 0), [0, 1]);
  assert.deepEqual(M.screenSegments(screens, 1), [2]);
  const cols = M.sheetModel(sum).cols;
  assert.deepEqual(M.screenActions(cols, screens, 0).map((c: any) => c.index), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(M.screenOfAction(cols, screens, 7), 1);
  assert.equal(M.screenOfAction(cols, screens, 99), -1);
});

test('the ladder: a column per system used, the call crossing the seam, an action\'s ladder kept to its own lines', () => {
  const lm = M.ladderModel(sum, sum.segments[1], { steps });
  assert.equal(lm.lines.length, sum.segments[1].markers.length);
  assert.ok(lm.lines.some((l: any) => Object.values(l.cells).some((c: any) => c.type === 'seam')));
  const fin = M.sheetModel(sum).cols[6];
  const al = M.actionLadderModel(sum, fin, { steps });
  assert.equal(al.lines.length, fin.sg.markers.filter((m: any) => m.moment === fin.mo.index).length);
  assert.ok(al.lines[0].time.mo, 'the action starts on its first line');
});
