import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ingestJava } from '../dist/java/index.js';
import { ingestTsJs } from '../dist/tsjs.js';
import type { AdapterOptions } from '../dist/types.js';

async function fixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'framework-aliases-'));
  try {
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
    }
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const frameworks: AdapterOptions['frameworks'] = {
  spring: {
    mappings: {
      ApiRoute: { method: 'pair:method', path: 'arg:0' },
      JsonGet: { method: 'GET', path: 'pair:path' },
      PosRoute: { method: 'arg:0', path: 'pair:path' },
      ValueRoute: { method: 'GET', path: 'pair:value' },
    },
    security: {
      SomeAnnotationPolicy: { label: '$action on $resource', requires: '$action', tier: 'policy' },
      RequiresRole: { label: 'role: $0', requires: '$0' },
    },
    listeners: { OnEvent: 'pair:topic' },
    delegates: ['*ApiDelegate'],
  },
  nest: {
    verbs: { JsonGet: 'GET' },
    guards: { UseTenant: { label: '$action on $resource', tier: 'technical', requires: '$action' } },
  },
  express: {
    middleware: {
      withTenant: { label: 'tenant: $0', requires: '$0', tier: 'policy' },
      tenant: { label: 'tenant' },
      requireRole: { label: 'role: $0', requires: '$0' },
    },
  },
};

test('Spring aliases read paths and verbs, policy grants and tiers, listeners and implemented interfaces', async () => {
  await fixture(
    {
      'Api.java': `
@RestController @RequestMapping("/invoices")
class InvoiceApiDelegateImpl implements InvoiceApiDelegate, java.io.Serializable {
  @ApiRoute(value = "/approve", method = "POST")
  @SomeAnnotationPolicy(resource = "invoice", action = "approve")
  public void approve() {}
  @JsonGet(path = "/list") public void list() {}
  @PosRoute(value = "PATCH", path = "/edit") public void edit() {}
  @ValueRoute("/short") public void shortValue() {}
  @ApiRoute(value = "/enum", method = RequestMethod.PUT) public void enumVerb() {}
  @ApiRoute("/unknown") public void missingVerb() {}
  @ApiRoute(value = Paths.APPROVE, method = "POST") public void constantPath() {}
  @ApiRoute(value = "/prefix" + SUFFIX, method = "POST") public void expressionPath() {}
  @ApiRoute(value = "/unknown-verb", method = HttpVerbs.POST) public void constantVerb() {}
  @SomeAnnotationPolicy(resource = Resources.INVOICE, action = Actions.APPROVE) public void constantPolicy() {}
  @RequiresRole() public void missingRole() {}
  @RequiresRole("billing") public void billing() {}
  @OnEvent(topic = "invoice.approved") @KafkaListener("invoice.legacy") public void consume() {}
  @Override public ResponseEntity<Invoice> getInvoice() { return null; }
  @PreAuthorize("hasAuthority('billing')") public void builtIn() {}
}`,
    },
    async (root) => {
      const f = await ingestJava(root, { repoName: 'sample', frameworks });
      assert.deepEqual(
        f.nodes
          .filter((n) => n.kind === 'route')
          .map((n) => n.name)
          .sort(),
        [
          'GET /invoices/list',
          'GET /invoices/short',
          'PATCH /invoices/edit',
          'POST /invoices/approve',
          'PUT /invoices/enum',
        ],
      );
      assert.equal(f.meta?.routes?.gaps.length, 4);
      assert.ok(f.meta!.routes!.gaps.every((g) => g.kind === 'non-literal-path' && g.path === 'Api.java' && g.line));
      const constantPolicy = f.nodes.find((n) => n.kind === 'guard' && n.name === 'SomeAnnotationPolicy')!;
      assert.ok(constantPolicy);
      assert.equal(f.edges.find((e) => e.from === constantPolicy.id)?.meta?.requires, undefined);
      const policy = f.nodes.find((n) => n.name === 'approve on invoice')!;
      assert.equal(policy.kind, 'guard');
      assert.deepEqual(policy.gateTier, { tier: 'policy', from: 'config' });
      const edge = f.edges.find((e) => e.from === policy.id && e.kind === 'guards')!;
      assert.equal(edge.to, 'sample::route::POST /invoices/approve');
      assert.equal(edge.meta?.requires, 'approve');
      assert.deepEqual(edge.resolution, {
        status: 'resolved',
        technique: 'annotation-scan',
        confidence: 'HIGH',
        note: '@SomeAnnotationPolicy read as a gate by farsight.config.json → frameworks.spring.security',
      });
      assert.ok(f.nodes.find((n) => n.name === 'RequiresRole' && n.kind === 'guard'));
      assert.ok(f.nodes.find((n) => n.name === 'role: billing'));
      assert.ok(
        f.edges
          .find((e) => e.kind === 'consumes' && e.from === 'sample::queue::invoice.approved')
          ?.resolution?.note?.includes('@OnEvent'),
      );
      assert.equal(
        f.edges.find((e) => e.kind === 'consumes' && e.from === 'sample::queue::invoice.legacy')?.resolution?.note,
        'a listener annotation naming invoice.legacy',
      );
      const cls = f.nodes.find((n) => n.name === 'InvoiceApiDelegateImpl')!;
      assert.ok(cls.tags.includes('implements:InvoiceApiDelegate'));
      assert.ok(cls.tags.includes('implements:java.io.Serializable'));
      assert.equal(cls.signature, 'implements InvoiceApiDelegate, java.io.Serializable');
      assert.match(
        f.nodes.find((n) => n.name === 'InvoiceApiDelegateImpl.getInvoice')!.signature!,
        /@Override public ResponseEntity<Invoice>/,
      );
      const builtin = f.nodes.find((n) => n.name === "PreAuthorize: hasAuthority('billing')")!;
      assert.ok(builtin);
      assert.equal(f.edges.find((e) => e.from === builtin.id)?.resolution?.note, '@PreAuthorize on builtIn');
      const plain = await ingestJava(root, { repoName: 'sample' });
      assert.equal(plain.nodes.filter((n) => n.kind === 'route').length, 0);
      assert.ok(!plain.nodes.find((n) => n.name === 'InvoiceApiDelegateImpl.getInvoice')!.signature);
      assert.ok(!plain.nodes.find((n) => n.name === 'InvoiceApiDelegateImpl')!.signature);
      assert.ok(!plain.nodes.some((n) => n.tags.some((t) => t.startsWith('implements:'))));
    },
  );
});

test('Nest verb and guard aliases retain route ids and annotation evidence', async () => {
  await fixture(
    {
      'api.ts': `
import { Controller, Get, UseGuards } from '@nestjs/common';
import { JsonGet, UseTenant } from './aliases';
@Controller('invoices')
class InvoicesController {
  @JsonGet('list') @UseTenant({resource: 'invoice', action: 'read'}) list() { return []; }
  @JsonGet('missing') @UseTenant({resource: 'invoice'}) missing() { return []; }
  @Get('builtin') @UseGuards(AuthGuard) builtin() { return []; }
}`,
    },
    async (root) => {
      const f = await ingestTsJs(root, { repoName: 'sample', frameworks });
      assert.ok(f.nodes.find((n) => n.id === 'sample::route::GET /invoices/list'));
      const guard = f.nodes.find((n) => n.kind === 'guard' && n.name === 'read on invoice')!;
      assert.deepEqual(guard.gateTier, { tier: 'technical', from: 'config' });
      const edge = f.edges.find((e) => e.from === guard.id && e.kind === 'guards')!;
      assert.equal(edge.meta?.requires, 'read');
      assert.equal(edge.resolution?.confidence, 'HIGH');
      assert.match(edge.resolution!.note!, /frameworks.nest.guards/);
      assert.ok(f.nodes.find((n) => n.kind === 'guard' && n.name === 'UseTenant'));
      assert.ok(f.nodes.find((n) => n.kind === 'guard' && n.name === 'UseGuards: AuthGuard'));
      assert.match(
        f.edges.find((e) => e.from === 'sample::route::GET /invoices/list' && e.kind === 'calls')!.resolution!.note!,
        /frameworks.nest.verbs/,
      );
    },
  );
});

test('Express aliases read factory and bare middleware while retaining the existing heuristic', async () => {
  await fixture(
    {
      'api.ts': `
app.post('/invoices', withTenant('invoice'), requireRole('approve'), handler);
app.get('/tenant', tenant, handler);
app.get('/missing', withTenant(value), handler);
app.get('/builtin', requireAuth('session'), handler);
function handler() {}
`,
    },
    async (root) => {
      const f = await ingestTsJs(root, { repoName: 'sample', frameworks });
      const guard = f.nodes.find((n) => n.kind === 'guard' && n.name === 'tenant: invoice')!;
      assert.deepEqual(guard.gateTier, { tier: 'policy', from: 'config' });
      const e = f.edges.find((e) => e.from === guard.id && e.kind === 'guards')!;
      assert.equal(e.meta?.requires, 'invoice');
      assert.equal(e.resolution?.technique, 'annotation-scan');
      assert.equal(e.resolution?.confidence, 'HIGH');
      assert.ok(f.nodes.find((n) => n.name === 'tenant' && n.kind === 'guard'));
      assert.ok(f.nodes.find((n) => n.id === 'sample::guard::requireRole(approve)' && n.name === 'role: approve'));
      const missing = f.nodes.find((n) => n.name === 'withTenant' && n.kind === 'guard')!;
      assert.equal(f.edges.find((e) => e.from === missing.id && e.kind === 'guards')!.meta?.requires, undefined);
      assert.equal(
        f.edges.find((e) => e.from === 'sample::guard::requireAuth(session)')!.resolution?.confidence,
        'MEDIUM',
      );
    },
  );
});
