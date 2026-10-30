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

test('joined routes use the ordinary security and request-body drift checks', () => {
  const f = fixture();
  f.edges = [];
  f.nodes[2]!.contract!.security = ['bearer'];
  f.nodes[2]!.contract!.requestBody = { schema: 'Invoice', required: true };
  joinDelegates(f, ['*ApiDelegate']);
  const kinds = f.nodes[2]!.contract!.drift!.map((d) => d.kind);
  assert.ok(kinds.includes('security-missing-in-code'));
  assert.ok(kinds.includes('body-unvalidated'));
  assert.ok(!kinds.includes('spec-only'));
});

test('a spec without operationIds still names the unmatched delegate override', () => {
  const f = fixture();
  delete f.nodes[2]!.contract!.spec!.operationId;
  assert.equal(joinDelegates(f, ['*ApiDelegate'])[0]?.kind, 'delegate-unmatched');
  assert.ok(!f.edges.some((e) => e.kind === 'calls'));
});

test('ingest passes configured aliases into readers, joins spec delegates, and respects disabling specs', async () => {
  const { ingestRepo } = await import('../dist/index.js');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../../examples/spring-invoice-api', import.meta.url));
  const f = await ingestRepo(root, { repoName: 'spring', tests: false, design: false });
  const alias = f.nodes.find((n) => n.name === 'POST /api/invoices/:param/approval' && n.kind === 'route');
  assert.ok(alias);
  const route = f.nodes.find((n) => n.contract?.spec?.operationId === 'getInvoiceForApproval')!;
  assert.equal(route.contract?.status, 'both');
  assert.ok(
    f.edges.some(
      (e) => e.kind === 'calls' && e.from === route.id && e.to.endsWith('InvoiceApiDelegateImpl.getInvoiceForApproval'),
    ),
  );
  const rows = roleTable(buildIndex(f.nodes, f.edges)).rows;
  assert.ok(
    rows.some((r) => r.guard.name === 'approve on invoice' && r.action.id === route.id && r.roles.includes('approve')),
  );
  assert.ok(f.meta?.config?.files.find((file) => file.root)?.fields.includes('frameworks'));
  const noSpecs = await ingestRepo(root, { repoName: 'spring', openapi: false, tests: false, design: false });
  assert.ok(!noSpecs.edges.some((e) => e.resolution?.note?.includes('frameworks.spring.delegates')));
  assert.ok(!noSpecs.meta?.routes?.gaps.some((g) => g.kind === 'delegate-unmatched'));
});

test('framework aliases in a nested config are reported as ignored, with root and overlay aliases applied', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ingestRepo } = await import('../dist/index.js');
  const root = mkdtempSync(join(tmpdir(), 'nested-frameworks-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src', 'api.ts'),
      `import {Controller} from '@nestjs/common'; @Controller('api') class C { @JsonGet('x') x() {} }`,
    );
    const frameworks = { nest: { verbs: { JsonGet: 'GET' } } };
    writeFileSync(join(root, 'src', 'farsight.config.json'), JSON.stringify({ frameworks }));
    const nested = await ingestRepo(root, { repoName: 'sample', openapi: false, design: false, tests: false });
    assert.ok(!nested.nodes.some((n) => n.kind === 'route'));
    assert.ok(
      nested.meta?.config?.files.find((f) => f.path === 'src/farsight.config.json')?.ignored.includes('frameworks'),
    );
    const overlay = await ingestRepo(root, {
      repoName: 'sample',
      openapi: false,
      design: false,
      tests: false,
      configOverlay: { from: '.farsight/settings.json', config: { frameworks } },
    });
    assert.ok(overlay.nodes.some((n) => n.name === 'GET /api/x'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
