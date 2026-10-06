// The status lifecycle's numbers (core lifecycle.ts, docs/COUNTS.md § Lifecycle): three Counteds over
// one record node, each breakdown a partition that sums, the singular words at 1, and the text the
// CLI and MCP print naming every writer by node id. Runs against the built package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleCounts, lifecycleLines, journeyLifecycles, unwrittenStatuses, buildIndex, countedText, STRINGS } from '../dist/index.js';
import type { GraphNode, RecordLifecycle } from '../dist/index.js';

const life: RecordLifecycle = {
  field: 'status',
  statuses: ['draft', 'open', 'approved', 'paid', 'void'],
  transitions: [
    { to: 'draft', by: 'a::src/s.ts::createInvoice', via: 'update-call', line: 27 },
    { from: 'draft', to: 'open', by: 'a::src/s.ts::finalizeInvoice', via: 'update-call', line: 66 },
    { to: 'approved', by: 'a::src/approvals.ts::approveInvoice', via: 'update-call', line: 17 },
  ],
  provenance: [{ kind: 'union', name: 'InvoiceStatus', path: 'src/db.ts', line: 2 }],
};

test('three Counteds over one node, each breakdown summing to its number', () => {
  const c = lifecycleCounts(life);
  assert.equal(c.statuses.n, 5);
  assert.equal(c.transitions.n, 3);
  assert.equal(c.unwritten.n, 2);
  for (const x of [c.statuses, c.transitions, c.unwritten]) {
    assert.equal(x.scope, 'count.scope.node');
    assert.ok(STRINGS[x.unit] && STRINGS[x.unit]!.define, x.unit);
    if (x.breakdown) assert.equal(x.breakdown.reduce((a, p) => a + p.n, 0), x.n);
  }
  assert.deepEqual(c.statuses.breakdown!.map((p) => p.n), [3, 2]);
  assert.deepEqual(c.transitions.breakdown!.map((p) => p.n), [1, 2]);
  assert.deepEqual(unwrittenStatuses(life), ['paid', 'void']);
  assert.equal(countedText(c.statuses, { scope: false }), '5 statuses');
  assert.equal(countedText(lifecycleCounts({ ...life, statuses: ['draft'], transitions: [] }).statuses, { scope: false }), '1 status');
});

test('the text names the statuses in order, every move with its writer id, and what nothing writes', () => {
  const node = { id: 'a::table::invoices', kind: 'table', name: 'invoices', tags: [], lifecycle: life } as GraphNode;
  const lines = lifecycleLines(node);
  assert.match(lines[0]!, /status lifecycle · invoices · status — 5 statuses · 3 moves with a writer · 2 statuses no code moves to/);
  assert.equal(lines[1]!.trim(), 'draft · open · approved · paid · void');
  assert.ok(lines.some((l) => l.includes('draft → open') && l.includes('a::src/s.ts::finalizeInvoice:66')));
  assert.ok(lines.some((l) => l.includes('paid · void')));
  assert.ok(lines.some((l) => l.includes('InvoiceStatus src/db.ts:2')));
});

test('a journey lists the records it reaches with a lifecycle and lights the moves its own steps make', () => {
  const nodes = [
    { id: 'a::table::invoices', kind: 'table', name: 'invoices', tags: [], lifecycle: life },
    { id: 'a::src/s.ts::finalizeInvoice', kind: 'function', name: 'finalizeInvoice', tags: [] },
    { id: 'a::table::notes', kind: 'table', name: 'notes', tags: [] },
  ] as GraphNode[];
  const index = buildIndex(nodes, []);
  const got = journeyLifecycles(index, { steps: [{ nodeId: 'a::src/s.ts::finalizeInvoice' }, { nodeId: 'a::table::notes' }, { nodeId: 'a::table::invoices' }, { nodeId: 'a::table::invoices' }] });
  assert.equal(got.length, 1);
  assert.deepEqual(got[0]!.onJourney, [false, true, false]);
  assert.equal(got[0]!.writers['a::src/s.ts::finalizeInvoice'], 'finalizeInvoice');
  assert.equal(got[0]!.writers['a::src/approvals.ts::approveInvoice'], 'approveInvoice');
});
