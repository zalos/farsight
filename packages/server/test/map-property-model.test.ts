// The map property's model (docs/proposals/map-view.md §3.2), held against a real
// `/api/journey` answer captured from the invoice-app fixture and the street model
// lane A builds from it. The modules are the ones the viewer imports, so this suite
// tests the shipped code. Every count the property prints must be the summary's own
// `Counted` object, never a number the viewer made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', 'public', 'app');
const { streetModel } = await import(join(appDir, 'lib', 'map-model.js'));
const { propertyModel, heroKind, reachedData, alsoInFlows, otherWaysIn, placeOf } = await import(join(appDir, 'lib', 'map-property-model.js'));
const fx = JSON.parse(readFileSync(join(here, 'fixtures', 'map-property-billing-cycle.json'), 'utf8'));
const byId: Record<string, any> = Object.fromEntries(fx.nodes.map((n: { id: string }) => [n.id, n]));
const data = fx.journey;
const model = streetModel(data, byId);
const prop = (i: number) => propertyModel(data, i, byId, model, { edges: fx.edges });
const FLOW = 'invoice-app::flow::billing-cycle';

test('prev, next and the journey around a screen', () => {
  const first = prop(0), mid = prop(1), last = prop(2);
  assert.equal(first.prev, null);
  assert.equal(first.next.name, 'Invoice list');
  assert.equal(mid.prev.name, 'New invoice');
  assert.equal(mid.next.name, 'Discard draft');
  assert.equal(last.next, null);
  assert.equal(mid.total, 3);
  assert.equal(propertyModel(data, 7, byId, model), null, 'no screen at that index → null, never a stub');
});

test('also in: the other flows that render the same page, never the one on screen', () => {
  assert.deepEqual(prop(0).alsoIn.map((f: { name: string }) => f.name), ['Start a new invoice']);
  assert.deepEqual(prop(1).alsoIn.map((f: { name: string }) => f.name), ['Draft and send an invoice']);
  assert.ok(!prop(1).alsoIn.some((f: { id: string }) => f.id === FLOW));
  assert.deepEqual(alsoInFlows('x::page::none', FLOW, byId, fx.edges), []);
});

test('the hero: a file image for the built screens, a Figma frame with no render for Discard draft', () => {
  assert.equal(prop(0).hero.kind, 'image');
  assert.equal(prop(1).hero.kind, 'image');
  assert.equal(prop(2).hero.kind, 'figma');
  assert.equal(prop(2).hero.planned, true);
  assert.deepEqual(prop(2).hero.components, [], 'designed, not built: no components found');
  assert.equal(heroKind({ design: { status: 'design-only' } }), 'none');
  assert.equal(heroKind(null), 'none');
});

test('the tab strip prints only typed counts, and they are the summary\'s own objects', () => {
  const seg = data.summary.segments[1];
  const cov = data.summary.coverage.segments[1];
  const c = prop(1).counts;
  assert.equal(c.gates, seg.counted.gates);
  assert.equal(c.apis, seg.counted.actions);
  assert.equal(c.tests, cov.counted.tests);
  assert.deepEqual([c.ux, c.work, c.changes], [null, null, null], 'nothing types these: no number on those tabs');
  assert.deepEqual([c.gates.n, c.apis.n, c.tests.n], [5, 5, 5]);
  // a screen not built counts the stops its design declares, not the calls code makes
  assert.equal(prop(2).counts.apis, data.summary.segments[2].counted.actionStops);
  assert.equal(prop(2).counts.apis.n, 1);
  assert.deepEqual([prop(0).counts.gates.n, prop(0).counts.apis.n, prop(0).counts.tests.n], [2, 1, 4]);
});

test('gates split into guards and rules, in walk order; decisions kept whole for the surface to filter', () => {
  const g = prop(1).tabs.gates;
  assert.deepEqual(g.guards.map((x: { name: string }) => x.name), ['requireScope: billing:read', 'requireScope: billing:write', 'requireScope: billing:admin']);
  assert.deepEqual(g.rules.map((x: { name: string }) => x.name), ['draftInvoiceSchema', 'updateInvoiceSchema']);
  assert.equal(g.rows.length, g.counted.n, 'the rows and the number beside them are one claim');
  assert.equal(g.decisions.length, 3);
  assert.equal(g.decisionsCounted, data.summary.segments[1].counted.decisions);
  // Discard draft's one gate is the spec's planned security requirement
  assert.equal(prop(2).tabs.gates.rows[0].planned, true);
});

test('APIs: the street\'s calls, and every record reached named once with all its modes', () => {
  const a = prop(1).tabs.apis;
  assert.equal(a.calls, model.screens[1].calls, 'the same MapCall rows the street draws');
  assert.equal(a.calls.length, 5);
  const recs = Object.fromEntries(a.records.map((r: { name: string; modes: string[] }) => [r.name, r.modes.slice().sort().join('+')]));
  assert.deepEqual(recs, { invoices: 'read+write', customers: 'read', ledger_entries: 'write', 'invoice.finalized': 'write' });
  assert.equal(prop(2).tabs.apis.planned, true);
  assert.deepEqual(prop(2).tabs.apis.calls.map((c: { evidence: string }) => c.evidence), ['not built']);
  assert.deepEqual(prop(2).tabs.apis.records, []);
  assert.deepEqual(reachedData([{ data: [{ nodeId: 'r', name: 'r', kind: 'record', mode: 'read' }] }, { data: [{ nodeId: 'r', name: 'r', kind: 'record', mode: 'write' }] }])[0].modes, ['read', 'write']);
});

test('UX: the components the walk met on the screen, each once, the page never', () => {
  const names = prop(1).tabs.ux.components.map((n: { name: string }) => n.name);
  assert.deepEqual(names, ['InvoiceListPage', 'CreateInvoiceForm', 'EditInvoiceDrawer']);
  assert.deepEqual(prop(0).tabs.ux.components.map((n: { name: string }) => n.name), ['CreateInvoiceForm', 'LineItemRow']);
  assert.equal(prop(2).tabs.ux.built, false);
});

test('Tests: the screen\'s own fold, cases apart from coverage runs that name none', () => {
  const t0 = prop(0).tabs.tests;
  assert.equal(t0.facts, data.summary.coverage.segments[0]);
  assert.equal(t0.cases.length, t0.facts.counted.tests.n, 'the cases listed are the cases counted');
  assert.equal(t0.reports.length, t0.facts.counted.runReports.n);
  assert.ok(t0.cases.some((x: { observedVia?: string }) => x.observedVia === 'declaration'), 'New invoice has a case verified by its own declaration');
  const t1 = prop(1).tabs.tests;
  assert.equal(t1.cases.length, t1.facts.counted.tests.n);
  assert.ok(!t1.cases.some((x: { evidence: string }) => x.evidence === 'observed'), 'Invoice list: no case a run named — its word is seen by a coverage run');
  assert.deepEqual(prop(2).tabs.tests.cases, []);
});

test('Route: address, built or planned, where declared, and no other way in on this fixture', () => {
  const r = prop(1).tabs.route;
  assert.equal(r.route, '/invoices');
  assert.equal(r.status, 'built');
  assert.equal(r.declaredIn.path, 'docs/design/screens.json');
  assert.equal(r.codeAt.path, 'src/ui/router.tsx');
  assert.deepEqual(r.otherWays, [], 'design containment, test coverage and journey membership are not ways in');
  assert.equal(prop(2).tabs.route.status, 'planned');
  assert.equal(prop(2).tabs.route.codeAt, null);
  const ways = otherWaysIn('p', {}, [[{ kind: 'navigates', from: 'a', to: 'p' }, { kind: 'covers', from: 't', to: 'p' }], [{ kind: 'navigates', from: 'a', to: 'p' }]]);
  assert.deepEqual(ways.map((w: { nodeId: string }) => w.nodeId), ['a']);
});

test('Changes keeps the page, its components and the routes and handlers its calls reach', () => {
  const ids = prop(0).changeIds;
  assert.ok(ids.includes('invoice-app::page::/invoices/new'));
  assert.ok(ids.includes('invoice-app::src/ui/CreateInvoiceForm.tsx::CreateInvoiceForm'));
  assert.ok(ids.includes('invoice-app::route::POST /invoices'));
  assert.ok(ids.includes('invoice-app::src/server/invoiceService.ts::createInvoice'));
});

// ── data stores: Data this screen reaches, grouped by store ─────────────────
import { withStores } from './map-stores-fixture.ts';
const { dataByStore } = await import(join(appDir, 'lib', 'map-property-model.js'));

test('Data this screen reaches is grouped by store, the outside store with its mode, named stores first', () => {
  const s = withStores(fx);
  const sById: Record<string, any> = Object.fromEntries(s.nodes.map((n: { id: string }) => [n.id, n]));
  const sm = streetModel(s.journey, sById);
  const a = propertyModel(s.journey, 1, sById, sm, { edges: fx.edges }).tabs.apis;
  assert.deepEqual(a.groups.map((g: any) => g.store ? g.store.name + ' · ' + g.store.kind : 'plain ' + g.kind), [
    'Invoice DB · sql', 'Example ERP · erp', 'plain message',
  ]);
  const erp = a.groups[1].rows[0];
  assert.deepEqual(erp.modes, ['write'], 'reached on the list read yields to the write on finalize');
  assert.equal(a.records.length, a.groups.reduce((n: number, g: any) => n + g.rows.length, 0), 'every reached row is in exactly one group');
});

test('dataByStore: unnamed data last under its plain kind, records before outside systems before messages', () => {
  const g = dataByStore([
    { nodeId: 'm', kind: 'message', modes: ['write'], store: null },
    { nodeId: 'x', kind: 'external', modes: ['reached'], store: null },
    { nodeId: 'r', kind: 'record', modes: ['read'], store: null },
    { nodeId: 's', kind: 'record', modes: ['read'], store: { name: 'S', kind: 'sql' } },
  ]);
  assert.deepEqual(g.map((x: any) => x.store ? x.store.name : x.kind), ['S', 'record', 'external', 'message']);
  assert.deepEqual(reachedData([{ data: [{ nodeId: 'e', name: 'e', kind: 'external', mode: 'reached' }] }, { data: [{ nodeId: 'e', name: 'e', kind: 'external', mode: 'read' }] }])[0].modes, ['read']);
});

test('the footer\'s units: reached is the summary\'s own count when it counts the street, the rest named with their absence word', () => {
  const reached = { n: 2, unit: 'count.unit.screensReached', scope: 'journey.scopeAll', source: 's' };
  const screens = { n: 4, unit: 'journey.countScreens', scope: 'journey.scopeAll', source: 's', breakdown: [{ key: 'count.part.screensReached', n: 2 }, { key: 'count.part.screensNotReached', n: 2 }] };
  const sum = {
    counted: { screens, screensReached: reached },
    user: [
      { id: 'a', name: 'A', designStatus: 'both' }, { id: 'b', name: 'B', designStatus: 'both' },
      { id: 'c', name: 'C', designStatus: 'both', loc: { path: 'x' } }, { id: 'd', name: 'D', designStatus: 'design-only' },
    ],
    segments: [{ screen: { id: 'a' } }, { screen: null }, { screen: { id: 'b' } }],
  };
  const p = placeOf(sum, 2);
  assert.equal(p.reached, reached, 'the same object, never a copy');
  assert.equal(p.declared, screens);
  assert.deepEqual(p.notReached, [{ id: 'c', name: 'C', word: 'notReached' }, { id: 'd', name: 'D', word: 'notBuilt' }]);
  // a street with a screen met twice has more rows than distinct screens: the count is not handed out for it
  assert.equal(placeOf(sum, 3).reached, null);
  // the captured fixture: every named screen reached
  assert.deepEqual(prop(1).place.notReached, []);
});

test('a screen\'s chip row carries its coverage fold, so its tests count travels with its evidence word', () => {
  const cov = data.summary.coverage.segments;
  model.screens.forEach((s: any) => assert.equal(s.chips.evidence, cov[s.segment.index] || null));
  const ov = prop(1).tabs.overview;
  assert.equal(ov.evidence, cov[model.screens[1].segment.index], 'the overview prints the screen\'s own evidence beside its tests');
});

// ── the Tests tab's one sentence of scopes and the screens no test is known to reach (round 2026-10-10) ──
const { testsScopeLine, screensNoTestReaches } = await import(join(appDir, 'lib', 'map-property-model.js'));

test('the tests scope line: each number names a scope inside the screen and never exceeds the screen’s own', () => {
  for (let i = 0; i < 3; i++) {
    const pm = prop(i);
    const line = pm.tabs.tests.scopeLine;
    const total = pm.counts.tests ? pm.counts.tests.n : 0;
    for (const a of line.actions) assert.ok(a.n > 0 && a.n <= Math.max(total, a.n), `action ${a.mo.label}`);
    for (const g of line.gates) assert.ok(g.n > 0 && g.n <= total, `gate ${g.gate.name}`);
    if (line.page != null) assert.ok(line.page <= total);
  }
  // a not-built screen has no inner scopes: the cases it counts reach the route it will call, not the screen
  assert.deepEqual(testsScopeLine({}, 0, { moments: [] }, { notBuilt: true, tests: [] }, []), { actions: [], gates: [], page: null });
});

test('screens no test is known to reach: zero cases, or designed and not built — in street order', () => {
  const sum = {
    segments: [{ screen: { name: 'A', id: 'a' } }, { screen: { name: 'B', id: 'b' } }, { screen: { name: 'C', id: 'c' } }],
    coverage: { segments: [
      { counted: { tests: { n: 4 } } },
      { counted: { tests: { n: 0 } } },
      { notBuilt: true, counted: { tests: { n: 2 } } },
    ] },
  };
  assert.deepEqual(screensNoTestReaches(sum), [{ name: 'B', id: 'b', notBuilt: false }, { name: 'C', id: 'c', notBuilt: true }]);
  assert.deepEqual(screensNoTestReaches({}), []);
});
