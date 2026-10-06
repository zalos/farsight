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
