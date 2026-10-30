import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinDelegates } from '../dist/openapi/delegates.js';
import { buildIndex, roleTable, type GraphFragment, type GraphNode } from '@farsight/core';

function fixture(): GraphFragment {
  const loc = { repo: 'sample', path: 'src/InvoiceApiDelegateImpl.java', line: 1 };
  const cls: GraphNode = {
    id: 'cls',
    kind: 'class',
    name: 'InvoiceApiDelegateImpl',
    lang: 'java',
    loc,
    tags: ['implements:InvoiceApiDelegate'],
  };
  const fn: GraphNode = {
    id: 'fn',
    kind: 'function',
    name: 'InvoiceApiDelegateImpl.approveInvoice',
    lang: 'java',
    loc: { ...loc, line: 5 },
    signature: '@Override public ResponseEntity<Invoice> approveInvoice(String id)',
    tags: [],
  };
  const route: GraphNode = {
    id: 'sample::route::POST /invoices/:param/approve',
    kind: 'route',
    name: 'POST /invoices/:param/approve',
    lang: 'openapi',
    tags: ['spec-only'],
    contract: {
      status: 'spec-only',
      apiId: 'api',
      spec: { path: 'openapi.yaml', operationId: 'approveInvoice' },
      drift: [{ kind: 'spec-only', message: 'not implemented' }],
    },
  };
  return {
    repo: 'sample',
    nodes: [cls, fn, route, { id: 'guard', kind: 'guard', name: 'approve on invoice', tags: ['auth'] }],
    edges: [
      {
        id: 'gate',
        kind: 'guards',
        from: 'guard',
        to: 'fn',
        meta: { requires: 'approve' },
        resolution: { status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH' },
      },
    ],
  };
}

test('delegate operationId join credits implementation and mirrors grants with annotation evidence', () => {
  const f = fixture();
  assert.deepEqual(joinDelegates(f, ['*ApiDelegate']), []);
  const route = f.nodes.find((n) => n.kind === 'route')!;
  const call = f.edges.find((e) => e.kind === 'calls')!;
  assert.equal(call.from, route.id);
  assert.equal(call.to, 'fn');
  assert.equal(call.resolution?.technique, 'annotation-scan');
  assert.equal(call.resolution?.confidence, 'HIGH');
  assert.match(call.resolution!.note!, /approveInvoice is the spec's operationId/);
  assert.equal(route.contract?.status, 'both');
  assert.ok(!route.tags.includes('spec-only'));
  assert.ok(!route.contract?.drift?.some((d) => d.kind === 'spec-only'));
  assert.equal(route.loc?.path, 'src/InvoiceApiDelegateImpl.java');
  assert.ok(f.nodes[0]!.tags.includes('controller'));
  const gate = f.edges.find((e) => e.to === route.id && e.kind === 'guards')!;
  assert.equal(gate.meta?.requires, 'approve');
  assert.equal(gate.meta?.handler, 'fn');
  const rows = roleTable(buildIndex(f.nodes, f.edges)).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.guard.name, 'approve on invoice');
  assert.deepEqual(rows[0]?.roles, ['approve']);
  const once = JSON.stringify(f);
  joinDelegates(f, ['*ApiDelegate']);
  assert.equal(JSON.stringify(f), once, 'joining twice changes nothing');
});

test('unmatched public overrides are gaps, and no spec gives neither calls nor gaps', () => {
  const f = fixture();
  f.nodes.find((n) => n.kind === 'route')!.contract!.spec!.operationId = 'otherOperation';
  const gaps = joinDelegates(f, ['*ApiDelegate']);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.kind, 'delegate-unmatched');
  assert.equal(gaps[0]?.name, 'InvoiceApiDelegateImpl.approveInvoice');
  assert.ok(!f.edges.some((e) => e.kind === 'calls'));
  f.nodes = f.nodes.filter((n) => n.kind !== 'route');
  assert.deepEqual(joinDelegates(f, ['*ApiDelegate']), []);
  assert.ok(!f.edges.some((e) => e.kind === 'calls'));
});

test('delegate matching respects declaration paths, public overrides and operation ambiguity', () => {
  for (const signature of [
    'public ResponseEntity<Invoice> approveInvoice()',
    '@Override private ResponseEntity<Invoice> approveInvoice()',
    '@Override public String approveInvoice()',
  ]) {
    const f = fixture();
    f.nodes[1]!.signature = signature;
    assert.deepEqual(joinDelegates(f, ['*ApiDelegate']), []);
    assert.ok(!f.edges.some((e) => e.kind === 'calls'));
  }
  const f = fixture();
  f.nodes[1]!.loc!.path = 'elsewhere/SameName.java';
  assert.deepEqual(joinDelegates(f, ['*ApiDelegate']), []);
  assert.ok(!f.edges.some((e) => e.kind === 'calls'));
  const ambiguous = fixture();
  ambiguous.nodes.push({ ...ambiguous.nodes[2]!, id: 'second-route' });
  assert.equal(joinDelegates(ambiguous, ['*ApiDelegate'])[0]?.kind, 'delegate-unmatched');
  assert.ok(!ambiguous.edges.some((e) => e.kind === 'calls'));
});
