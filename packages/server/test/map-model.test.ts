// The Map surface's model (docs/proposals/map-view.md §3.1), held against a real
// `/api/journey` answer captured from the invoice-app fixture. The module is the
// one the viewer imports (`public/app/lib/map-model.js`), so this suite tests the
// shipped code and not a restatement of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', 'public', 'app');
const { streetModel, neighbourhoodModel, screensUsing, layoutDistricts } = await import(join(appDir, 'lib', 'map-model.js'));
const fx = JSON.parse(readFileSync(join(here, 'fixtures', 'map-billing-cycle.json'), 'utf8'));
const byId = new Map(fx.nodes.map((n: { id: string }) => [n.id, n]));
const model = streetModel(fx.journey, byId);

test('the street names its journey and its services from the summary', () => {
  assert.equal(model.journey.id, 'invoice-app::flow::billing-cycle');
  assert.equal(model.journey.name, 'Billing cycle');
  // only the api rows are services; their order is the colour index
  assert.deepEqual(model.services.map((s: { label: string; index: number }) => [s.label, s.index]), [['Billing API', 0]]);
});

test('three screens in step order, the third designed and not built', () => {
  assert.deepEqual(model.screens.map((s: { ordinal: number; name: string; state: string }) => [s.ordinal, s.name, s.state]), [
    [1, 'New invoice', 'built'],
    [2, 'Invoice list', 'built'],
    [3, 'Discard draft', 'planned'],
  ]);
  assert.equal(model.screens[0].route, '/invoices/new');
  assert.equal(model.screens[0].node.design.id, 'INV-02', 'the full design reference comes from data.screens');
});

test('the chips are the summary\'s own Counteds, never recounted', () => {
  const list = model.screens[1];
  assert.equal(list.chips.calls, fx.journey.summary.segments[1].counted.actions);
  assert.equal(list.chips.gates, fx.journey.summary.segments[1].counted.gates);
  assert.equal(list.chips.tests, fx.journey.summary.coverage.segments[1].counted.tests);
  assert.equal(list.chips.work, null);
});

test('Invoice list: five calls in moment order, the repeated PATCH drawn once, POST marked as a repeat', () => {
  const list = model.screens[1];
  assert.deepEqual(list.calls.map((c: { method: string; path: string }) => c.method + ' ' + c.path), [
    'GET /invoices', 'POST /invoices', 'GET /invoices/:id', 'PATCH /invoices/:id', 'POST /invoices/:id/finalize',
  ]);
  const post = list.calls[1];
  assert.equal(post.repeat, true, 'the journey made this call on the screen before');
  assert.equal(list.calls[0].repeat, false);
  for (const c of list.calls) assert.equal(c.service && c.service.index, 0);
});

test('reads, writes and both: a record read and written by one call reads both', () => {
  const list = model.screens[1];
  const patch = list.calls.find((c: { method: string }) => c.method === 'PATCH');
  assert.deepEqual(patch.data.map((d: { name: string; mode: string }) => [d.name, d.mode]), [['invoices', 'both']]);
  const fin = list.calls.find((c: { path: string }) => c.path.endsWith('/finalize'));
  assert.deepEqual(fin.data.map((d: { kind: string; name: string; mode: string }) => [d.kind, d.name, d.mode]), [
    ['record', 'invoices', 'both'],
    ['record', 'ledger_entries', 'write'],
    ['message', 'invoice.finalized', 'write'],
  ]);
  assert.equal(fin.evidence, 'implied', 'the finalize route is in the code and not in the spec');
  assert.equal(list.calls[0].evidence, 'spec-backed');
  assert.equal(list.calls[0].operationId, 'listInvoices');
});

test('a call\'s data is what the call reached, not everything in its moment', () => {
  const create = model.screens[0].calls[0];
  assert.equal(create.method + ' ' + create.path, 'POST /invoices');
  // computeTax (called by the handler) reads customers; the handler writes invoices
  assert.deepEqual(create.data.map((d: { name: string; mode: string }) => [d.name, d.mode]).sort(), [['customers', 'read'], ['invoices', 'write']]);
});

test('a planned screen\'s call is its planned marker, not built and with no data', () => {
  const discard = model.screens[2];
  assert.equal(discard.calls.length, 1);
  assert.equal(discard.calls[0].method + ' ' + discard.calls[0].path, 'DELETE /invoices/{id}');
  assert.equal(discard.calls[0].evidence, 'not built');
  assert.deepEqual(discard.calls[0].data, []);
});

test('an operation a built screen\'s design names and no code calls is kept as declared, after the calls', () => {
  const calls = model.screens[0].calls;
  const last = calls[calls.length - 1];
  assert.equal(last.evidence, 'declared');
  assert.equal(last.operationId, 'getInvoice');
  assert.equal(last.method + ' ' + last.path, 'GET /invoices/:id');
  assert.deepEqual(last.data, []);
});

test('helpers and plain steps never become calls', () => {
  for (const s of model.screens) for (const c of s.calls) assert.ok(!c.marker || c.marker.kind === 'call');
});

test('screensUsing names every screen a record is drawn under', () => {
  assert.deepEqual(screensUsing(model, 'record', 'invoice-app::table::invoices').map((s: { name: string }) => s.name), ['New invoice', 'Invoice list']);
  assert.deepEqual(screensUsing(model, 'call', 'invoice-app::route::GET /invoices').map((s: { name: string }) => s.name), ['Invoice list']);
});

test('the neighbourhood: inside a source the containing journey first, then by name', () => {
  const nb = neighbourhoodModel(fx.design.designs, new Map([['invoice-app::flow::new-invoice', { counts: { items: { n: 2 } } }]]));
  // Billing cycle holds every screen of the other two
  assert.deepEqual(nb.districts.map((d: { name: string; total: number; container: boolean }) => [d.name, d.total, d.container]), [
    ['Billing cycle', 3, true], ['Draft and send an invoice', 2, false], ['Start a new invoice', 1, false],
  ]);
  assert.equal(nb.districts[2].work.counts.items.n, 2);
  assert.equal(nb.districts[0].work, null);
  assert.deepEqual(nb.districts.map((d: { index: number }) => d.index), [0, 1, 2]);
});

test('the neighbourhood keeps each source together, in the order the design answer names the sources', () => {
  const designs = [
    { repo: 'beta', flows: [{ nodeId: 'b::flow::z', id: 'z', name: 'Zeta', screens: ['S1'] }] },
    { repo: 'alpha', flows: [{ nodeId: 'a::flow::y', id: 'y', name: 'Yankee', screens: ['A1'] }, { nodeId: 'a::flow::x', id: 'x', name: 'Xray', screens: ['A1', 'A2'] }] },
    { repo: 'beta', flows: [{ nodeId: 'b::flow::a', id: 'a', name: 'Alpha', screens: ['S2'] }] },
  ];
  assert.deepEqual(neighbourhoodModel(designs).districts.map((d: { name: string }) => d.name), ['Alpha', 'Zeta', 'Xray', 'Yankee']);
});

// ── the layout rule, on synthetic journeys (no real application's names) ──
/** n districts over up to three sources, street widths from one to twelve screens, deterministic. */
function synthetic(n: number) {
  const repos = ['source-a', 'source-b', 'source-c'];
  return Array.from({ length: n }, (_, i) => {
    const screens = 1 + ((i * 7 + 3) % 12);
    return { id: 'flow-' + i, repo: repos[(i * 5) % Math.min(3, Math.max(1, Math.ceil(n / 4)))], w: Math.max(880, 120 + screens * 400 - 140), h: 438 + ((i % 3) ? 0 : 200) };
  });
}
function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
for (const n of [1, 3, 8, 21, 40]) {
  test(`layout of ${n} journeys: no two districts overlap, bands stack, the board's shape stays near the viewport's`, () => {
    const items = synthetic(n);
    const aspect = 1440 / 760;
    const L = layoutDistricts(items, { aspect });
    assert.equal(L.rects.size, n);
    const rs = [...L.rects.values()];
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) assert.ok(!overlaps(rs[i], rs[j]), `districts ${i} and ${j} overlap`);
    // every district keeps its street's width and sits inside the board
    for (const it of items) {
      const r = L.rects.get(it.id)!;
      assert.equal(r.w, it.w);
      assert.ok(r.h >= it.h);
      assert.ok(r.x + r.w <= L.size.w && r.y + r.h <= L.size.h);
    }
    // bands do not overlap, and each holds exactly its source's districts
    for (let i = 1; i < L.bands.length; i++) assert.ok(L.bands[i].y >= L.bands[i - 1].y + L.bands[i - 1].h);
    for (const b of L.bands) {
      for (const it of items.filter((x) => x.repo === b.repo)) {
        const r = L.rects.get(it.id)!;
        assert.ok(r.y >= b.y && r.y + r.h <= b.y + b.h, `${it.id} outside its band`);
      }
    }
    const ratio = (L.size.w / L.size.h) / aspect;
    if (n >= 8) assert.ok(ratio > 0.6 && ratio < 1.67, `aspect ${L.size.w}×${L.size.h} is ${ratio.toFixed(2)}× the viewport's`);
  });
}

test('a band\'s districts share its height, so its rows line up', () => {
  const L = layoutDistricts([{ id: 'a', repo: 'r', w: 880, h: 438 }, { id: 'b', repo: 'r', w: 880, h: 900 }, { id: 'c', repo: 's', w: 880, h: 438 }]);
  assert.equal(L.rects.get('a')!.h, 900);
  assert.equal(L.rects.get('c')!.h, 438);
  assert.deepEqual(L.bands.map((b: { repo: string }) => b.repo), ['r', 's']);
  assert.deepEqual(layoutDistricts([]).rects.size, 0);
});

test('the model survives an empty or older answer', () => {
  const m = streetModel({}, null);
  assert.deepEqual(m.screens, []);
  assert.deepEqual(m.services, []);
  assert.deepEqual(neighbourhoodModel(undefined).districts, []);
});
