// One state machine, two views of it (round 2026-10-10 §3, core lifecycle.ts lifecycleViews): each status in
// the persona's word (config) or the constant humanized, what moves a record into it placed on a journey screen,
// the overlays as rows of their own kind with the code that writes their table, and the counts as Counteds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleViews, lifecycleViewLines, flowPersonas, placeOnJourney, buildIndex, countedText, STRINGS } from '../dist/index.js';
import type { GraphNode, GraphEdge, RecordLifecycle, JourneysMeta } from '../dist/index.js';

const life: RecordLifecycle = {
  field: 'status',
  statuses: ['draft', 'open', 'PENDING_CLIENT_APPROVAL', 'paid'],
  transitions: [
    { to: 'draft', by: 'a::s.ts::createInvoice', via: 'update-call', line: 27 },
    { from: 'draft', to: 'open', by: 'a::s.ts::finalizeInvoice', via: 'update-call', line: 66 },
    { to: 'PENDING_CLIENT_APPROVAL', by: 'a::s.ts::askClient', via: 'sql' },
  ],
  provenance: [{ kind: 'union', path: 'src/db.ts', line: 2 }],
  names: {
    views: { billing: { draft: 'Being drafted', open: 'Sent' } },
    overlays: [{ name: 'Posted to the ledger', when: 'a ledger entry names it', table: 'ledger', tableId: 'a::table::ledger' }],
    from: ['farsight.config.json'],
  },
};
const nodes = [
  { id: 'a::table::invoices', kind: 'table', name: 'invoices', tags: [], lifecycle: life },
  { id: 'a::table::ledger', kind: 'table', name: 'ledger', tags: [] },
  { id: 'a::s.ts::createInvoice', kind: 'function', name: 'createInvoice', tags: [] },
  { id: 'a::s.ts::finalizeInvoice', kind: 'function', name: 'finalizeInvoice', tags: [], facets: { business: { label: 'Send the invoice' } } },
  { id: 'a::s.ts::askClient', kind: 'function', name: 'askClient', tags: [] },
] as GraphNode[];
const edges = [{ id: 'e1', kind: 'writes', from: 'a::s.ts::finalizeInvoice', to: 'a::table::ledger' }] as GraphEdge[];
const index = buildIndex(nodes, edges);
const node = nodes[0]!;

test('the persona\'s word where config gave one, the constant humanized where it did not, and the counts partition', () => {
  const [v] = lifecycleViews(index, node, { personas: [{ id: 'billing', name: 'Billing' }] });
  assert.ok(v!.declared);
  assert.deepEqual(v!.rows.map((r) => [r.word, r.status, r.declared, r.written]), [
    ['Being drafted', 'draft', true, true], ['Sent', 'open', true, true],
    ['Pending client approval', 'PENDING_CLIENT_APPROVAL', false, true], ['Paid', 'paid', false, false],
  ]);
  assert.equal(v!.rows[1]!.movers[0]!.words, 'Send the invoice');
  assert.equal(v!.rows[1]!.movers[0]!.from, 'draft');
  assert.equal(v!.rows[0]!.movers[0]!.words, 'Create invoice');
  const c = v!.counts;
  assert.equal(c.moved.n + c.unmoved.n, c.statuses.n);
  assert.equal(c.statuses.breakdown!.reduce((a, p) => a + p.n, 0), c.statuses.n);
  for (const x of [c.statuses, c.moved, c.unmoved, c.overlays]) {
    assert.equal(x.scope, 'count.scope.node');
    assert.ok(STRINGS[x.unit]?.define && STRINGS[x.bizUnit!]?.define, x.unit);
  }
  assert.equal(countedText(c.moved, { lens: 'business', scope: false }), '3 that the app moves');
  assert.equal(countedText(c.unmoved, { lens: 'business', scope: false }), '1 nothing moves yet');
  assert.deepEqual(v!.from, ['farsight.config.json']);
});

test('a persona matches by id or name, case ignored; with no persona the view is the constants humanized', () => {
  assert.ok(lifecycleViews(index, node, { personas: [{ id: 'x', name: 'BILLING' }] })[0]!.declared);
  const [plain] = lifecycleViews(index, node);
  assert.equal(plain!.persona, undefined);
  assert.equal(plain!.declared, false);
  assert.deepEqual(plain!.rows.map((r) => r.word), ['Draft', 'Open', 'Pending client approval', 'Paid']);
  assert.deepEqual(lifecycleViews(index, { ...node, lifecycle: undefined }), []);
});

test('an overlay is a row of its own kind, with the code that writes its table', () => {
  const [v] = lifecycleViews(index, node);
  assert.equal(v!.overlays.length, 1);
  const o = v!.overlays[0]!;
  assert.equal(o.kind, 'overlay');
  assert.equal(o.tableName, 'ledger');
  assert.deepEqual(o.movers.map((m) => [m.by, m.via]), [['a::s.ts::finalizeInvoice', 'writes']]);
  assert.equal(v!.counts.overlays.n, 1);
});

test('a writer is placed on the journey screen whose markers name it, else whose steps reach it', () => {
  const summary = { segments: [
    { index: 0, screen: null, from: 0, to: 0, markers: [] },
    { index: 1, screen: { name: 'New invoice' }, from: 1, to: 3, markers: [{ nodeId: 'a::s.ts::createInvoice' }] },
    { index: 2, screen: { name: 'Invoice list' }, from: 4, to: 9, markers: [] },
  ] } as never;
  const j = { steps: [{ nodeId: 'a::s.ts::finalizeInvoice', order: 5 }, { nodeId: 'x', order: 0 }] } as never;
  const locate = placeOnJourney({ id: 'a::flow::f', name: 'Billing cycle' }, j, summary);
  const [v] = lifecycleViews(index, node, { locate });
  assert.deepEqual(v!.rows[0]!.movers[0]!.at, { flowId: 'a::flow::f', flowName: 'Billing cycle', screen: 2, screenName: 'New invoice', here: true });
  assert.equal(v!.rows[1]!.movers[0]!.at!.screen, 3);
  assert.equal(v!.rows[2]!.movers[0]!.at, undefined);
});

test('a flow\'s personas: the config placement over the manifest, matched to the declared persona', () => {
  const flow = { id: 'a::flow::f', kind: 'flow', name: 'F', tags: [], design: { id: 'f', persona: 'billing' } } as unknown as GraphNode;
  const idx = buildIndex([flow], []);
  const meta = { a: { personas: [{ id: 'billing', name: 'Billing', declared: true, from: 'm' }, { id: 'ops', name: 'Operations', declared: true, from: 'm' }], groups: [], flows: {}, notes: [] } } as Record<string, JourneysMeta>;
  assert.deepEqual(flowPersonas(idx, meta, 'a::flow::f'), [{ id: 'billing', name: 'Billing' }]);
  meta.a!.flows.f = { persona: ['Operations', 'Someone else'], from: 'c', index: 0 };
  assert.deepEqual(flowPersonas(idx, meta, 'a::flow::f'), [{ id: 'ops', name: 'Operations' }, { id: 'Someone else', name: 'Someone else' }]);
  assert.deepEqual(flowPersonas(idx, meta, 'nope'), []);
});

test('the lines for MCP name each persona\'s words with the constant, and the overlays', () => {
  const lines = lifecycleViewLines(lifecycleViews(index, node, { personas: [{ id: 'billing', name: 'Billing' }] }));
  assert.match(lines[0]!, /Billing calls them: Being drafted \(draft\) · Sent \(open\)/);
  assert.match(lines[1]!, /not a status: Posted to the ledger — a ledger entry names it · ledger · by finalizeInvoice/);
});
