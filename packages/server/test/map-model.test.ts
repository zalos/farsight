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
const { streetModel, neighbourhoodModel, screensUsing, layoutDistricts, routeLinks, storesOf, mergeMode, MODE_ORDER } = await import(join(appDir, 'lib', 'map-model.js'));
const fx = JSON.parse(readFileSync(join(here, 'fixtures', 'map-billing-cycle.json'), 'utf8'));
import { withStores, type AnyRec } from './map-stores-fixture.ts';
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

type Box = { x: number; y: number; w: number; h: number };
type Pt = { x: number; y: number };
/** Whether a straight run from a to b passes through the inside of r. */
function crosses(a: Pt, b: Pt, r: Box) {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  return x0 < r.x + r.w - 1 && x1 > r.x + 1 && y0 < r.y + r.h - 1 && y1 > r.y + 1;
}
for (const n of [3, 12, 21, 40]) {
  test(`the lines between ${n} journeys run in the gutters, square, with one label each that clears every journey`, () => {
    const items = synthetic(n);
    const L = layoutDistricts(items, { aspect: 1440 / 760 });
    const ids = items.map((i) => i.id);
    const links: Array<{ from: string; to: string; kind: string; labelW: number; labelH: number }> = [];
    for (let i = 0; i < n - 1; i++) links.push({ from: ids[i], to: ids[i + 1], kind: 'leadsTo', labelW: 84, labelH: 18 });
    for (let i = 0; i + 5 < n; i += 4) links.push({ from: ids[i], to: ids[i + 5], kind: 'partOf', labelW: 76, labelH: 18 });
    if (n > 2) links.push({ from: ids[n - 1], to: ids[0], kind: 'leadsTo', labelW: 84, labelH: 18 });
    const out = routeLinks(L.rects, links);
    assert.equal(out.length, links.length, 'every link is routed');
    const rects = [...L.rects.values()] as Box[];
    const labels: Box[] = [];
    for (const l of out) {
      const p = l.points as Pt[];
      // it starts on the edge of its own district and ends on the edge of the other
      const a = L.rects.get(l.from)!, b = L.rects.get(l.to)!;
      const onEdge = (q: Pt, r: Box) => (q.x === r.x || q.x === r.x + r.w || q.y === r.y || q.y === r.y + r.h)
        && q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h;
      assert.ok(onEdge(p[0], a) && onEdge(p[p.length - 1], b), `${l.from} → ${l.to} does not leave and arrive at the edges`);
      for (let k = 0; k < p.length - 1; k++) {
        assert.ok(p[k].x === p[k + 1].x || p[k].y === p[k + 1].y, 'a run that is not square');
        for (const r of rects) assert.ok(!crosses(p[k], p[k + 1], r), `${l.from} → ${l.to} crosses a journey`);
      }
      if (l.label) {
        const bx = { x: l.label.x - l.label.w / 2, y: l.label.y - l.label.h / 2, w: l.label.w, h: l.label.h };
        for (const r of rects) assert.ok(!overlaps(bx, r), `the label of ${l.from} → ${l.to} covers a journey`);
        for (const o of labels) assert.ok(!overlaps(bx, o), 'two labels overlap');
        assert.ok([4, 3, 2, 1.5, 1].includes(l.label.scale));
        labels.push(bx);
      }
    }
    // the gutters leave room: most lines carry their word at the coarsest zoom
    assert.ok(out.filter((l: { label: { scale: number } | null }) => l.label && l.label.scale === 4).length >= Math.ceil(out.length * 0.75), 'too few labels at the fit');
  });
}

test('a line between two journeys side by side goes over the top when the gap between them cannot hold its word', () => {
  const rects = new Map([['a', { x: 0, y: 200, w: 880, h: 500 }], ['b', { x: 1080, y: 200, w: 880, h: 500 }]]);
  const [l] = routeLinks(rects, [{ from: 'a', to: 'b', kind: 'leadsTo', labelW: 84, labelH: 18 }]);
  assert.ok(l.label, 'the label is placed');
  assert.ok(l.points.length > 2, 'the route bends');
  assert.ok(l.label.y < 200 || l.label.y > 700, 'the label sits in the gutter, not between the two');
  assert.deepEqual(routeLinks(rects, [{ from: 'a', to: 'zz', kind: 'leadsTo' }]), [], 'a link to a journey not on the board is left out');
});

test('a band\'s districts share its height, so its rows line up', () => {
  const L = layoutDistricts([{ id: 'a', repo: 'r', w: 880, h: 438 }, { id: 'b', repo: 'r', w: 880, h: 900 }, { id: 'c', repo: 's', w: 880, h: 438 }]);
  assert.equal(L.rects.get('a')!.h, 900);
  assert.equal(L.rects.get('c')!.h, 438);
  assert.deepEqual(L.bands.map((b: { repo: string }) => b.repo), ['r', 's']);
  assert.deepEqual(layoutDistricts([]).rects.size, 0);
});

// ── Band by: persona (journey-organisation §4.4) ──────────────────────────
const { treeFrom } = await import(join(appDir, 'lib', 'journeys-model.js'));
const pf = (id: string, extra: Record<string, unknown> = {}) => ({ nodeId: 'r::flow::' + id, id, name: id, screens: ['S-1'], built: 1, total: 1, ...extra });
const pdesigns = [{
  repo: 'r', screens: [],
  personas: [{ id: 'con', name: 'Contractor' }, { id: 'ops', name: 'Operations' }],
  groups: [{ id: 'access', name: 'Access' }, { id: 'inv', name: 'Invoices' }],
  flows: [
    pf('alpha', { persona: 'con', group: 'inv' }),
    pf('both', { persona: ['con', 'ops'], group: 'inv' }),
    pf('login', { persona: 'con', group: 'access', order: 1 }),
    pf('opslogin', { persona: 'ops', group: 'access' }),
    pf('loose', { screens: ['A-1', 'B-1'] }),
  ],
}];
const ptree = treeFrom(pdesigns, null, { ordinal: (id: string) => ['login', 'alpha', 'both', 'opslogin', 'loose'].indexOf(id.split('::').pop()!) });

test('with a tree, a district carries its personas, its group and its order', () => {
  const nb = neighbourhoodModel(pdesigns, null, ptree);
  const by = new Map(nb.districts.map((d: any) => [d.flowId, d]));
  assert.deepEqual((by.get('both') as any).personaIds, ['con', 'ops']);
  assert.equal((by.get('login') as any).groupId, 'access');
  assert.equal((by.get('login') as any).order, 1);
  assert.deepEqual((by.get('loose') as any).personaIds, ['']);
  assert.deepEqual(nb.personaOrder, ['con', 'ops', '']);
  assert.equal(nb.personas.get('ops'), 'Operations');
  // without a tree nothing changes: the source band's model, no places
  const plain = neighbourhoodModel(pdesigns);
  assert.deepEqual(plain.districts.map((d: any) => d.personaIds.length), [0, 0, 0, 0, 0]);
});

test('banded by persona: bands in the tree\'s persona order, districts by group then journey order', () => {
  const nb = neighbourhoodModel(pdesigns, null, ptree);
  const items = nb.districts.map((d: any) => ({ id: d.id, repo: d.repo, places: d.places, w: 880, h: 400 }));
  const L = layoutDistricts(items, { bandKey: 'persona', personaOrder: nb.personaOrder, aspect: 100 });
  assert.deepEqual(L.bands.map((b: { repo: string }) => b.repo), ['con', 'ops', '']);
  // one wide row per band (aspect 100): x order is the band's order
  const xs = (band: number) => [...L.rects.entries()].filter(([, r]: any) => r.y >= L.bands[band].y && r.y <= L.bands[band].y + L.bands[band].h)
    .sort((a: any, b: any) => a[1].x - b[1].x).map(([id]: any) => String(id).replace('r::flow::', ''));
  assert.deepEqual(xs(0), ['login', 'alpha', 'both'], 'Access before Invoices, then the manifest order');
  assert.deepEqual(xs(1), ['opslogin', 'both\u0001ops'], 'the shared journey is drawn again under ops — as an echo');
  assert.deepEqual(xs(2), ['loose']);
  assert.deepEqual([...L.echoes.entries()], [['r::flow::both\u0001ops', 'r::flow::both']]);
  // the journey is counted once: one district, one street; the echo is a slot, not a district
  assert.equal(nb.districts.filter((d: any) => d.flowId === 'both').length, 1);
  // bands do not overlap and no two slots overlap
  for (let i = 1; i < L.bands.length; i++) assert.ok(L.bands[i].y >= L.bands[i - 1].y + L.bands[i - 1].h);
  const rs = [...L.rects.values()] as { x: number; y: number; w: number; h: number }[];
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const a = rs[i]!, b = rs[j]!;
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, 'two slots overlap');
  }
});

test('an echo can be narrower than the street it leads to', () => {
  const nb = neighbourhoodModel(pdesigns, null, ptree);
  const items = nb.districts.map((d: any) => ({ id: d.id, repo: d.repo, places: d.places, w: 2400, h: 400 }));
  const L = layoutDistricts(items, { bandKey: 'persona', personaOrder: nb.personaOrder, echoW: 880 });
  assert.equal(L.rects.get('r::flow::both')!.w, 2400);
  assert.equal(L.rects.get('r::flow::both\u0001ops')!.w, 880);
});

test('the source and domain bands carry no echoes', () => {
  const L = layoutDistricts([{ id: 'a', repo: 'r', w: 880, h: 438 }]);
  assert.equal(L.echoes.size, 0);
});

test('the model survives an empty or older answer', () => {
  const m = streetModel({}, null);
  assert.deepEqual(m.screens, []);
  assert.deepEqual(m.services, []);
  assert.deepEqual(neighbourhoodModel(undefined).districts, []);
});

// ── data stores (docs/proposals/data-stores.md §3) ─────────────────────────
const sfx = withStores(fx);
const smodel = streetModel(sfx.journey, new Map(sfx.nodes.map((n: AnyRec) => [n.id, n])));

test('a record names the store it lives in, with how the store is known', () => {
  const create = smodel.screens[0].calls[0];
  const inv = create.data.find((d: AnyRec) => d.name === 'invoices');
  assert.deepEqual(inv.store, { name: 'Invoice DB', kind: 'sql', engine: 'postgres', via: 'config', ref: 'stores[0]' });
  // the captured answer carries no store: nothing is guessed
  assert.equal(model.screens[0].calls[0].data[0].store, null);
});

test('a store-like external is a data node with its mode: writes from op, reached with no op, never write by default', () => {
  const list = smodel.screens[1];
  const get = list.calls.find((c: AnyRec) => c.method === 'GET' && c.path === '/invoices');
  const erpGet = get.data.find((d: AnyRec) => d.kind === 'external');
  assert.equal(erpGet.mode, 'reached');
  assert.deepEqual(erpGet.store && [erpGet.store.name, erpGet.store.kind], ['Example ERP', 'erp']);
  const fin = list.calls.find((c: AnyRec) => c.path.endsWith('/finalize'));
  const erpFin = fin.data.filter((d: AnyRec) => d.kind === 'external');
  assert.equal(erpFin.length, 1, 'the same node met twice on one call is drawn once');
  assert.equal(erpFin[0].mode, 'write', 'a known direction wins over reached, and never makes both');
});

test('mergeMode: both only from a read and a write; reached yields to either', () => {
  assert.equal(mergeMode('read', 'write'), 'both');
  assert.equal(mergeMode('reached', 'read'), 'read');
  assert.equal(mergeMode('write', 'reached'), 'write');
  assert.equal(mergeMode('reached', 'reached'), 'reached');
  assert.equal(mergeMode('both', 'reached'), 'both');
  assert.deepEqual(MODE_ORDER, ['write', 'both', 'read', 'reached']);
});

test('storesOf: derived from the data when the summary lists none, in the order the street meets them', () => {
  assert.deepEqual(storesOf(smodel), [
    { name: 'Invoice DB', kind: 'sql', ops: ['reads', 'writes'] },
    { name: 'Example ERP', kind: 'erp', ops: ['writes'] },
  ]);
  assert.deepEqual(storesOf(model), [], 'no store on the captured answer: the legend lists none');
  assert.deepEqual(storesOf(null), []);
});

test('storesOf: the summary\'s own list first when it is there, then any store drawn that it does not name', () => {
  const j = JSON.parse(JSON.stringify(sfx.journey));
  j.summary.system = { stores: [{ name: 'Example ERP', kind: 'erp', records: 1, ops: ['writes'] }, { name: 'Invoice DB', kind: 'sql', records: 3, ops: ['reads', 'writes'] }] };
  assert.deepEqual(storesOf(streetModel(j, null)).map((s: AnyRec) => s.name), ['Example ERP', 'Invoice DB']);
  j.summary.system = { stores: [{ name: 'Invoice DB', kind: 'sql', records: 3, ops: ['reads', 'writes'] }] };
  assert.deepEqual(storesOf(streetModel(j, null)).map((s: AnyRec) => s.name + ' ' + s.ops.join('+')), ['Invoice DB reads+writes', 'Example ERP writes']);
});

// ── the same, on the answers lane P captured (core: store and op on markers, system.stores, counted.stores) ──
const real = JSON.parse(readFileSync(join(here, 'fixtures', 'map-billing-cycle-stores.json'), 'utf8'));
const realModel = streetModel(real.journey, new Map(real.nodes.map((n: AnyRec) => [n.id, n])));
const erpFx = JSON.parse(readFileSync(join(here, 'fixtures', 'map-billing-cycle-erp.json'), 'utf8'));
const erpModel = streetModel(erpFx.journey, new Map(erpFx.nodes.map((n: AnyRec) => [n.id, n])));

test('captured: every record names Invoice DB, known from the config, and the journey lists one store', () => {
  for (const s of realModel.screens) for (const c of s.calls) for (const d of c.data) {
    if (d.kind !== 'record') continue;
    assert.equal(d.store && d.store.name, 'Invoice DB');
    assert.equal(d.store.via, 'config', 'the node\'s StoreRef wins over the marker\'s name and kind');
  }
  assert.deepEqual(storesOf(realModel), [{ name: 'Invoice DB', kind: 'sql', ops: ['reads', 'writes'] }]);
  assert.equal(real.journey.summary.counted.stores.n, 1);
});

test('captured: the ERP read, written and reached on finalize is one data node that reads · writes; the store list names it', () => {
  const fin = erpModel.screens[1].calls.find((c: AnyRec) => c.path.endsWith('/finalize'));
  const erp = fin.data.filter((d: AnyRec) => d.kind === 'external');
  assert.equal(erp.length, 1);
  assert.equal(erp[0].mode, 'both', 'reads + writes make both; the marker with no op yields');
  assert.deepEqual([erp[0].store.name, erp[0].store.kind], ['Example ERP', 'erp']);
  assert.deepEqual(storesOf(erpModel).map((s: AnyRec) => s.name + ' · ' + s.kind), ['Invoice DB · sql', 'Example ERP · erp']);
});
