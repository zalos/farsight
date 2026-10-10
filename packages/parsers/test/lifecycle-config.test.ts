// farsight.config.json → lifecycle applied at ingest (round 2026-10-10 §3, parsers/src/shared/lifecycle-config.ts):
// words land only on statuses the code declares, overlays only on tables the graph has, a nested file names
// only records declared under its folder and its word stands over the root's, and everything else is a note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLifecycleConfig, emptyWorkspaceConfig } from '../dist/index.js';
import type { GraphNode } from '@farsight/core';

function graph(): GraphNode[] {
  return [
    { id: 'a::table::invoices', kind: 'table', name: 'invoices', tags: [], lifecycle: { field: 'status', statuses: ['draft', 'open'], transitions: [], provenance: [{ kind: 'union', path: 'apps/billing/db.ts', line: 1 }] } },
    { id: 'a::table::ledger', kind: 'table', name: 'ledger', tags: [] },
  ] as GraphNode[];
}
function ws(files: { path: string; dir: string; root: boolean; config: Record<string, unknown> }[]) {
  const w = emptyWorkspaceConfig();
  w.files.push(...(files as never[]));
  return w;
}

test('words for declared statuses and an overlay on a table the graph has; the rest are notes', () => {
  const nodes = graph();
  const w = ws([{ path: 'farsight.config.json', dir: '.', root: true, config: { lifecycle: {
    invoices: { views: { billing: { 'Being drafted': ['draft'], Sent: ['open', 'sent'] } }, overlays: [{ name: 'Posted', table: 'ledger', when: 'a row' }, { name: 'Reviewed', table: 'reviews', when: 'open' }] },
    customers: { views: { billing: { X: ['y'] } } },
    ledger: { views: { billing: { X: ['y'] } } },
  } } }]);
  assert.equal(applyLifecycleConfig(nodes, w), 1);
  const names = nodes[0]!.lifecycle!.names!;
  assert.deepEqual(names.views, { billing: { draft: 'Being drafted', open: 'Sent' } });
  assert.deepEqual(names.overlays, [{ name: 'Posted', when: 'a row', table: 'ledger', tableId: 'a::table::ledger' }]);
  assert.deepEqual(names.from, ['farsight.config.json']);
  const notes = w.meta.notes.join('\n');
  assert.match(notes, /"sent" is not a status the code declares/);
  assert.match(notes, /names the table "reviews", which the code does not have/);
  assert.match(notes, /lifecycle\.customers names no record the code has/);
  assert.match(notes, /the code declares no statuses for ledger/);
});

test('a nested file names only records declared under its folder, and its word stands over the root\'s', () => {
  const nodes = graph();
  const w = ws([
    { path: 'farsight.config.json', dir: '.', root: true, config: { lifecycle: { invoices: { views: { billing: { Drafting: ['draft'] } } } } } },
    { path: 'apps/billing/farsight.config.json', dir: 'apps/billing', root: false, config: { lifecycle: { invoices: { views: { billing: { 'Being drafted': ['draft'] } } } } } },
    { path: 'apps/other/farsight.config.json', dir: 'apps/other', root: false, config: { lifecycle: { invoices: { views: { billing: { Nope: ['draft'] } } } } } },
  ]);
  applyLifecycleConfig(nodes, w);
  assert.equal(nodes[0]!.lifecycle!.names!.views.billing!.draft, 'Being drafted');
  assert.deepEqual(nodes[0]!.lifecycle!.names!.from, ['farsight.config.json', 'apps/billing/farsight.config.json']);
  assert.deepEqual(w.meta.conflicts.map((c) => [c.kind, c.kept]), [['lifecycle', 'apps/billing/farsight.config.json']]);
  assert.match(w.meta.notes.join('\n'), /declared outside apps\/other/);
});

test('no lifecycle block, nothing changes', () => {
  const nodes = graph();
  assert.equal(applyLifecycleConfig(nodes, ws([{ path: 'farsight.config.json', dir: '.', root: true, config: {} }])), 0);
  assert.equal(nodes[0]!.lifecycle!.names, undefined);
});
