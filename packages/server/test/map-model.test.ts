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
const { streetModel, neighbourhoodModel, screensUsing } = await import(join(appDir, 'lib', 'map-model.js'));
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

test('the neighbourhood lays the containing journey first, then the rest in the order the design walks them', () => {
  const nb = neighbourhoodModel(fx.design.designs, new Map([['invoice-app::flow::new-invoice', { counts: { items: { n: 2 } } }]]), byId);
  // Billing cycle holds every screen of the other two; Start a new invoice leads to Draft and send
  assert.deepEqual(nb.districts.map((d: { name: string; total: number; container: boolean }) => [d.name, d.total, d.container]), [
    ['Billing cycle', 3, true], ['Start a new invoice', 1, false], ['Draft and send an invoice', 2, false],
  ]);
  assert.equal(nb.districts[1].work.counts.items.n, 2);
  // without the graph the leads-to order is unknown: the larger journey comes first
  assert.deepEqual(neighbourhoodModel(fx.design.designs).districts.map((d: { name: string }) => d.name),
    ['Billing cycle', 'Draft and send an invoice', 'Start a new invoice']);
  assert.equal(nb.districts[0].work, null);
  assert.deepEqual(nb.districts.map((d: { index: number }) => d.index), [0, 1, 2]);
});

test('the model survives an empty or older answer', () => {
  const m = streetModel({}, null);
  assert.deepEqual(m.screens, []);
  assert.deepEqual(m.services, []);
  assert.deepEqual(neighbourhoodModel(undefined).districts, []);
});
