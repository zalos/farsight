// The status-lifecycle strip's model (public/app/lib/lifecycle-model.js): statuses in declared
// order with whether some code moves to each, the moves with their writers' names, and a screen
// kept to the records its own calls reach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { lifecycleStripModel, lifecyclesFor } = await import(join(here, '..', 'public', 'app', 'lib', 'lifecycle-model.js'));

const lc = {
  nodeId: 'a::table::invoices', name: 'invoices',
  lifecycle: {
    field: 'status', statuses: ['draft', 'open', 'paid'],
    transitions: [{ to: 'draft', by: 'a::s.ts::create', via: 'update-call' }, { from: 'draft', to: 'open', by: 'a::s.ts::send', via: 'sql', line: 9 }],
    provenance: [{ kind: 'union', name: 'S', path: 'db.ts', line: 1 }],
  },
  onJourney: [false, true],
  writers: { 'a::s.ts::send': 'send' },
};

test('statuses keep declared order and say which some code moves to', () => {
  const m = lifecycleStripModel(lc);
  assert.deepEqual(m.statuses, [{ s: 'draft', written: true }, { s: 'open', written: true }, { s: 'paid', written: false }]);
  assert.deepEqual(m.moves.map((x: { byName: string; here: boolean; from?: string }) => [x.from ?? null, x.byName, x.here]), [[null, 'create', false], ['draft', 'send', true]]);
  assert.equal(lifecycleStripModel({ nodeId: 'x' }), null);
});

test('a screen keeps only the records its own calls reach', () => {
  assert.deepEqual(lifecyclesFor([lc, { ...lc, nodeId: 'a::table::notes' }], ['a::table::notes']).map((x: { nodeId: string }) => x.nodeId), ['a::table::notes']);
  assert.deepEqual(lifecyclesFor(undefined, ['x']), []);
});

const { headerLifecycles, screenLifecycles } = await import(join(here, '..', 'public', 'app', 'lib', 'lifecycle-model.js'));

test('the header keeps the records this journey moves, the most moves first, two at most', () => {
  const read = { ...lc, nodeId: 'a::table::read', onJourney: [false, false] };
  const one = { ...lc, nodeId: 'a::table::one', onJourney: [true, false] };
  const two = { ...lc, nodeId: 'a::table::two', onJourney: [true, true] };
  const three = { ...lc, nodeId: 'a::table::three', onJourney: [false, true] };
  const got = headerLifecycles([read, one, two, three]);
  assert.deepEqual(got.shown.map((x: { nodeId: string }) => x.nodeId), ['a::table::two', 'a::table::one']);
  assert.equal(got.more, 1);
  assert.deepEqual(headerLifecycles([read]), { shown: [], more: 0 });
});

test('a screen shows a record its calls reach, or one a step of it moves', () => {
  assert.deepEqual(screenLifecycles([lc], [], ['a::s.ts::send']).length, 1);
  assert.deepEqual(screenLifecycles([lc], [], ['a::s.ts::other']).length, 0);
});

// ── round 2026-10-10 §3: the persona's view ──
const { pickView, stripItems, stripCounts, tableRows, placedView } = await import(join(here, '..', 'public', 'app', 'lib', 'lifecycle-model.js'));
const mover = (by: string, extra = {}) => ({ by, name: by, words: by.toUpperCase(), via: 'update-call', ...extra });
const view = {
  persona: { id: 'billing', name: 'Billing' }, declared: true,
  rows: [
    { kind: 'status', status: 'draft', word: 'Being drafted', declared: true, written: true, movers: [mover('create', { at: { flowId: 'a::flow::f', flowName: 'F', screen: 1, screenName: 'S', here: true } })] },
    { kind: 'status', status: 'open', word: 'Sent', declared: true, written: true, movers: [mover('send', { from: 'draft' })] },
    { kind: 'status', status: 'paid', word: 'Paid', declared: false, written: false, movers: [] },
    { kind: 'status', status: 'void', word: 'Void', declared: false, written: true, movers: [mover('cancel', { from: 'open' })] },
  ],
  overlays: [{ kind: 'overlay', name: 'Posted', when: 'a row', table: 'ledger', tableId: 'a::table::ledger', tableName: 'ledger', movers: [] }],
  counts: { statuses: { n: 4 }, moved: { n: 3 }, unmoved: { n: 1 }, overlays: { n: 1 } },
};

test('the strip prints the word in business, word and constant in hybrid, the constant in code; arrows only where code moves', () => {
  assert.equal(pickView({ views: [{ declared: false }, view] }), view);
  const biz = stripItems(view, 'business');
  assert.deepEqual(biz.map((x: { sep: string; main: string; constant: string }) => x.sep + x.main + (x.constant ? '/' + x.constant : '')), ['Being drafted', '→Sent', '·Paid', '·Void']);
  assert.deepEqual(stripItems(view, 'hybrid').map((x: { constant: string }) => x.constant), ['draft', 'open', 'paid', 'void']);
  assert.deepEqual(stripItems(view, 'code').map((x: { main: string }) => x.main), ['draft', 'open', 'paid', 'void']);
  assert.deepEqual(stripCounts({ counts: { statuses: 's', transitions: 't', unwritten: 'u' } }, view, 'business').map((c: { n: number }) => c.n), [4, 3, 1]);
  assert.deepEqual(stripCounts({ counts: { statuses: 's', transitions: 't', unwritten: 'u' } }, view, 'code'), ['s', 't', 'u']);
});

test('the table is every status then every overlay; a mover placed on a screen gets a door, one not placed none', () => {
  const rows = tableRows(view, (m: { at: { flowId: string; screen: number } }) => '#/journeys/' + m.at.flowId + '?step=' + m.at.screen);
  assert.deepEqual(rows.map((r: { kind: string; word: string }) => r.kind + ':' + r.word), ['status:Being drafted', 'status:Sent', 'status:Paid', 'status:Void', 'overlay:Posted']);
  assert.equal(rows[0].movers[0].door, '#/journeys/a::flow::f?step=1');
  assert.equal(rows[1].movers[0].door, null);
  assert.deepEqual(rows[2].movers, []);
  assert.equal(placedView(view, { views: [{ persona: { id: 'ops' } }, { persona: { id: 'billing' }, x: 1 }] }).x, 1);
  assert.equal(placedView(view, null), view);
});
