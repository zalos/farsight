// The storyline as swimlanes (round 2026-10-10 §2): `laneLayout()` and `laneGeometry()` held against answers captured
// from the public examples (invoice-app's storyline with its branch, nx-workspace's two-persona storyline) and a
// synthetic eighteen-journey storyline. The module is the one the viewer imports, so this tests the shipped code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const { laneLayout, laneGeometry, firstSentence } = await import(join(here, '..', 'public', 'app', 'lib', 'map-model.js'));
const fx = JSON.parse(readFileSync(join(here, 'fixtures', 'map-lanes.json'), 'utf8'));

type AnyRec = Record<string, any>;
function model(id: string, config: AnyRec = {}) {
  const f = fx[id];
  return laneLayout(f.storyline, fx.designs, fx.tree, new Map(Object.entries(f.journeys)), config);
}
/** A Counted's breakdown adds up to it. */
function sums(c: AnyRec) {
  if (!c.breakdown) return;
  assert.equal(c.breakdown.reduce((n: number, p: AnyRec) => n + p.n, 0), c.n, JSON.stringify(c));
}

test('invoice-app: two persona lanes in the tree\'s order and one store lane, from what the code writes', () => {
  const m = model('invoice');
  assert.deepEqual(m.lanes.map((l: AnyRec) => [l.id, l.kind, l.name]), [
    ['billing', 'persona', 'Billing'], ['ops', 'persona', 'Operations'], ['store:Invoice DB', 'store', 'Invoice DB'],
  ]);
  assert.equal(m.lanes[0].description, 'The people who draft invoices and send them to customers.');
  assert.equal(m.ready, true);
  for (const l of m.lanes) sums(l.count);
});

test('invoice-app: the screens in step order as columns, a screen met again drawn once; the branch on its persona\'s lane after its step', () => {
  const m = model('invoice');
  const main = m.stages.filter((s: AnyRec) => !s.branch);
  assert.deepEqual(main.map((s: AnyRec) => [s.col, s.lane, s.name, s.state, s.step]), [
    [0, 'billing', 'New invoice', 'built', 1], [1, 'billing', 'Invoice list', 'built', 2], [2, 'billing', 'Discard draft', 'planned', 2],
  ]);
  const br = m.stages.filter((s: AnyRec) => s.branch);
  assert.deepEqual(br.map((s: AnyRec) => [s.col, s.lane, s.name]), [[1, 'ops', 'Invoice list'], [2, 'ops', 'Discard draft']]);
  assert.equal(br[0].branch.when, 'Operations reviews the draft before it is sent');
  // the stage carries the street's test fold for its screen, and where opening it lands
  assert.equal(main[0].tests.n, 4);
  assert.equal(main[0].flowId, 'invoice-app::flow::new-invoice');
  assert.equal(main[1].flowId, 'invoice-app::flow::billing-cycle');
  assert.equal(main[1].screenIndex, 1);
  // a decision the code holds is beside its screen, never a screen
  assert.ok(main[1].decisions.length >= 1);
  assert.equal(m.counts.screens.n, 3);
});

test('invoice-app: the record lane reads in the lifecycle\'s order — created (draft), then status → open — and names the code that moves it', () => {
  const m = model('invoice');
  const inv = m.pills.filter((p: AnyRec) => p.record.name === 'invoices');
  assert.deepEqual(inv.map((p: AnyRec) => [p.kind, p.status, p.writers.join(','), p.col]), [
    ['created', 'draft', 'createInvoice', 0], ['move', 'open', 'finalizeInvoice', 1],
  ]);
  // approve is a move the lifecycle declares and this storyline never runs: no pill
  assert.ok(!m.pills.some((p: AnyRec) => p.status === 'approved'));
  // a record without declared statuses is a written pill
  assert.ok(m.pills.some((p: AnyRec) => p.record.name === 'ledger_entries' && p.kind === 'written'));
  // one solid arrow per pill, from the first screen that makes the move
  const moves = m.arrows.filter((a: AnyRec) => a.kind === 'moves');
  assert.equal(moves.length, m.pills.length);
  assert.deepEqual(moves.slice(0, 2).map((a: AnyRec) => a.from), ['s:INV-02', 's:INV-01']);
  assert.equal(m.arrows.filter((a: AnyRec) => a.kind === 'branch').length, 1);
  assert.equal(m.arrows.filter((a: AnyRec) => a.kind === 'seen').length, 0, 'no walk says which status a screen sees: nothing derived');
  assert.equal(m.lifecycles[0].name, 'invoices');
});

test('invoice-app: the footer counts are the tree\'s journeys, the distinct screens, how many are built and the branches', () => {
  const m = model('invoice');
  assert.equal(m.counts.journeys.n, 3);
  assert.equal(m.counts.screens.n, 3);
  assert.deepEqual([m.counts.built.n, m.counts.built.of], [2, 3]);
  assert.equal(m.counts.branches.n, 1);
  for (const c of Object.values(m.counts)) sums(c as AnyRec);
  assert.equal(m.counts.screens.scope, 'count.scope.storyline');
});

test('config lanes name and order what the graph found; hand-offs draw only where the graph finds both ends; the rest are notes', () => {
  const m = model('invoice', {
    lanes: [
      { id: 'ops-lane', persona: 'ops', surface: 'review console', name: 'Ops' },
      { id: 'ghost', persona: 'nobody' },
      { id: 'ledger', store: 'Invoice DB' },
      { id: 'erp', store: 'Example ERP' },
    ],
    handoffs: [
      { from: 'ledger', to: 'billing-cycle#2', kind: 'seen', status: 'open', when: 'the list shows it as open' },
      { from: 'ledger', to: 'billing-cycle#1', kind: 'seen', status: 'open' },
      { from: 'billing-cycle#2', to: 'ledger', kind: 'moves', status: 'paid' },
      { from: 'ledger', to: 'billing-cycle#2', kind: 'seen' },
      { from: 'nowhere#1', to: 'ledger', kind: 'moves', status: 'open' },
      { from: 'billing-cycle#2', to: 'ledger', kind: 'moves', status: 'open', when: 'sends it' },
    ],
  });
  assert.deepEqual(m.lanes.map((l: AnyRec) => l.id), ['ops-lane', 'billing', 'ledger']);
  assert.equal(m.lanes[0].surface, 'review console');
  assert.equal(m.lanes[0].name, 'Ops');
  const seen = m.arrows.filter((a: AnyRec) => a.kind === 'seen');
  assert.equal(seen.length, 1, 'the list reads invoices: drawn; New invoice reads no invoices row: a note');
  assert.equal(seen[0].label, 'the list shows it as open');
  assert.ok(m.arrows.some((a: AnyRec) => a.kind === 'moves' && a.declared && a.label === 'sends it'));
  const keys = m.notes.map((n: AnyRec) => (n.why ? n.why.key : n.key));
  for (const k of ['lanes.note.persona', 'lanes.note.store', 'lanes.why.noRead', 'lanes.why.noMove', 'lanes.why.noStatus', 'lanes.why.noScreen']) assert.ok(keys.includes(k), k + ' in ' + keys.join(','));
});

test('nx-workspace: a storyline across two apps draws a lane per persona in step order', () => {
  const m = model('billing-day');
  const persona = m.lanes.filter((l: AnyRec) => l.kind === 'persona').map((l: AnyRec) => l.id);
  assert.deepEqual(persona, ['billing', 'ops']);
  assert.equal(m.stages.length, m.counts.screens.n);
  assert.deepEqual(m.stages.map((s: AnyRec) => s.col), m.stages.map((_: unknown, i: number) => i));
  assert.deepEqual(m.stages.map((s: AnyRec) => s.lane), ['billing', 'billing', 'ops', 'ops']);
  const G = laneGeometry(m, { aspect: 1.6 });
  assert.equal(G.k, 1);
});

test('before a journey is read its screens come from the design, and the footer says how many are read', () => {
  const f = fx.invoice;
  const partial = new Map(Object.entries(f.journeys).slice(0, 1));
  const m = laneLayout(f.storyline, fx.designs, fx.tree, partial, {});
  assert.equal(m.ready, false);
  assert.equal(m.read, 1);
  assert.equal(m.of, 3);
  assert.ok(m.stages.length >= 3);
});

/** A synthetic storyline of `n` journeys over two personas, each writing the next status of one record. */
function synthetic(n: number) {
  const statuses = Array.from({ length: n }, (_, i) => 'S' + i);
  const journeys = Array.from({ length: n }, (_, i) => ({ nodeId: 'app::flow::j' + i, id: 'j' + i, name: 'Journey ' + i, personaIds: [i < n / 2 ? 'a' : 'b'], screens: ['X' + i, 'Y' + i] }));
  const lifecycle = { field: 'status', statuses, transitions: statuses.map((s, i) => ({ to: s, by: 'app::svc::w' + i, via: 'assignment' })), provenance: [] };
  const answers = new Map(journeys.map((j, i) => [j.nodeId, {
    summary: {
      segments: ['X' + i, 'Y' + i].map((sid, k) => ({
        index: k,
        screen: { id: 'app::page::' + sid, name: 'Screen ' + sid, designId: sid, designStatus: 'both', loc: { path: 'r.ts', line: 1 } },
        markers: k === 1 ? [
          { stepOrder: 1, kind: 'step', nodeId: 'app::svc::w' + i, name: 'w' + i },
          { stepOrder: 2, kind: 'record', nodeId: 'app::table::things', name: 'things', op: 'writes', under: 1, store: { name: 'DB', kind: 'sql' } },
        ] : [{ stepOrder: 1, kind: 'record', nodeId: 'app::table::things', name: 'things', op: 'reads', store: { name: 'DB', kind: 'sql' } }],
        decisions: [],
      })),
      coverage: { segments: [] },
    },
    lifecycles: [{ nodeId: 'app::table::things', name: 'things', lifecycle, writers: {} }],
  }]));
  const tree = { personas: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] };
  return laneLayout({ id: 's', name: 'S', journeys, branches: [] }, [], tree, answers, {});
}

test('eighteen journeys: 36 columns, two persona lanes and one store lane, the record in lifecycle order, wrapped to the stage\'s shape with nothing overlapping', () => {
  const m = synthetic(18);
  assert.equal(m.columns, 36);
  assert.deepEqual(m.lanes.map((l: AnyRec) => l.kind), ['persona', 'persona', 'store']);
  const pills = m.pills.filter((p: AnyRec) => p.record.name === 'things');
  assert.deepEqual(pills.map((p: AnyRec) => p.status), Array.from({ length: 18 }, (_, i) => 'S' + i));
  for (let i = 1; i < pills.length; i++) assert.ok(pills[i].col > pills[i - 1].col, 'left to right in the lifecycle\'s order');
  const G = laneGeometry(m, { aspect: 1440 / 720, extraH: 90 });
  assert.ok(G.k > 1, 'a long storyline wraps');
  // the wrap is the one that fits largest on the stage; a very wide stage keeps one segment
  const fit = (g: AnyRec) => Math.min(1440 / g.size.w, 720 / g.size.h);
  for (const k of [1, 2, 3, 4, 6]) assert.ok(fit(G) >= fit(laneGeometry(m, { aspect: 1440 / 720, extraH: 90, k })) - 1e-9, 'k=' + k);
  assert.equal(laneGeometry(m, { aspect: 100, extraH: 90 }).k, 1);
  // no two rects of one lane and segment overlap, and every rect is inside the board
  const rects = [...G.rects.values()] as AnyRec[];
  for (let i = 0; i < rects.length; i++) {
    const a = rects[i];
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= G.size.w && a.y + a.h <= G.size.h, 'inside the board');
    for (let j = i + 1; j < rects.length; j++) {
      const b = rects[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, 'no overlap: ' + JSON.stringify([a, b]));
    }
  }
});

test('the stage card\'s sub-line is the first sentence of the screen\'s words', () => {
  assert.equal(firstSentence('Draft a new invoice for a customer: pick the customer, add line items, save.'), 'Draft a new invoice for a customer');
  assert.equal(firstSentence('Every invoice, newest first.'), 'Every invoice, newest first');
  assert.equal(firstSentence(''), '');
});
