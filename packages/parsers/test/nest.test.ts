// NestJS controllers as HTTP routes (code-parser/src/nest.ts, wired in tsjs.ts): the same route ids
// App Router gives the same endpoints, the method as the route's body, the handler it delegates to
// mirrored onto the route, @UseGuards as guards, docs, gaps, the spec join and the coverage cell.
// Runs against the built packages: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestRepo, parseSpecText } from '../dist/index.js';
import { buildIndex, stepCoverage, reconcile, driftMarkdown, journey, journeySummary, screensFor, graphToSpec } from '@farsight/core';
import type { GraphFragment } from '@farsight/core';
import { createParser } from '@farsight/code-parser';
import { tsJsAdapter } from '@farsight/code-parser/adapters/tsjs';

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-nest-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

/** The code only — no spec, design, tests, stories or projects pass unless a test asks for one. */
const ingest = (dir: string, extra: Record<string, unknown> = {}) =>
  ingestRepo(dir, { repoName: 'svc', openapi: false, design: false, tests: false, stories: false, projects: false, ...extra });

const byId = (f: GraphFragment) => new Map(f.nodes.map((n) => [n.id, n]));
const routeIds = (f: GraphFragment) => f.nodes.filter((n) => n.kind === 'route').map((n) => n.id).sort();
const edgesOf = (f: GraphFragment, kind: string, to: string) => f.edges.filter((e) => e.kind === kind && e.to === to);

const CONTROLLER = 'src/orders/orders.controller.ts';
const METHOD = `svc::${CONTROLLER}::OrdersController.approveOrder`;
const ROUTE = 'svc::route::POST /api/v1/orders/:param/approve';
const HANDLER = 'svc::src/handlers/approve-order.ts::approveOrder';

/** The brief's §2 shape: a controller whose method is one `return handler(req, ctx)`, guards and the schema inline in the handler. */
const handlerFiles = {
  'src/handlers/approve-order.ts': [
    "import { z } from 'zod';",
    "import { requireSession } from '../auth/session';",
    'export const approveSchema = z.object({ note: z.string() });',
    '/** @business Approves an order. */',
    'export async function approveOrder(req: Request, ctx: Ctx): Promise<Response> {',
    '  const who = await requireSession(req);',
    '  const body = approveSchema.safeParse(await req.json());',
    '  return json(who, body);',
    '}',
  ].join('\n'),
  'src/auth/session.ts': [
    '/** @guard a signed-in session */',
    "export async function requireSession(req: Request) { return req.headers.get('x-session'); }",
  ].join('\n'),
};
const controllerFile = (body = 'return approveOrder(req, ctx);', head = '') => [
  "import { Controller, Post } from '@nestjs/common';",
  "import { approveOrder } from '../handlers/approve-order';",
  head,
  "@Controller('api/v1/orders')",
  'export class OrdersController {',
  "  @Post(':orderId/approve')",
  '  approveOrder(req: Request, ctx: Ctx) {',
  `    ${body}`,
  '  }',
  '}',
].join('\n');

test('basic: @Controller + @Post give the App Router route id, calling the method HIGH by the decorator', async () => {
  const f = await ingest(tempRepo({ ...handlerFiles, [CONTROLLER]: controllerFile() }));
  const nodes = byId(f);
  const route = nodes.get(ROUTE)!;
  assert.ok(route, `route missing — have ${routeIds(f).join(', ')}`);
  assert.equal(route.name, 'POST /api/v1/orders/:param/approve');
  assert.deepEqual(route.loc, { repo: 'svc', path: CONTROLLER, line: 6 }, 'the route sits on the method (its first decorator)');
  const call = f.edges.find((e) => e.kind === 'calls' && e.from === ROUTE)!;
  assert.equal(call.to, METHOD);
  assert.deepEqual(call.resolution, { status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH', note: 'the @Post decorator on OrdersController.approveOrder' });
  assert.equal(nodes.get(METHOD)!.loc!.line, route.loc!.line, 'route and method share the line: one coverage cell (sameLocTwins)');
  assert.equal(f.meta!.routes, undefined, 'nothing was set aside');
});

test('prefix and verb forms: empty, slashes, { path }, arrays on both levels, @Head and @Options', async () => {
  const f = await ingest(tempRepo({
    'src/a.controller.ts': [
      "import { Controller, Get, Post, Head, Options } from '@nestjs/common';",
      '@Controller()',
      "export class RootController { @Get('/items/') list() { return 1; } @Get() root() { return 1; } }",
      "@Controller('/a/')",
      "export class AController { @Post('/b') b() { return 1; } @Head('h') h() { return 1; } @Options('o') o() { return 1; } }",
      "@Controller({ path: 'x', host: 'admin.example.test' })",
      'export class XController { @Get() x() { return 1; } }',
      "@Controller(['v1', 'v2'])",
      "export class VController { @Get(['a', 'b']) ab() { return 1; } }",
    ].join('\n'),
  }));
  assert.deepEqual(routeIds(f), [
    'svc::route::GET /', 'svc::route::GET /items', 'svc::route::GET /v1/a', 'svc::route::GET /v1/b', 'svc::route::GET /v2/a', 'svc::route::GET /v2/b',
    'svc::route::GET /x', 'svc::route::HEAD /a/h', 'svc::route::OPTIONS /a/o', 'svc::route::POST /a/b',
  ]);
  // four routes from one method: each calls it
  assert.equal(f.edges.filter((e) => e.kind === 'calls' && e.to === 'svc::src/a.controller.ts::VController.ab').length, 4);
});

test('gaps: a constant or template path, @All, setGlobalPrefix each produce no route and a named gap; other packages’ decorators nothing', async () => {
  const files = {
    'src/main.ts': [
      "import { NestFactory } from '@nestjs/core';",
      'async function boot() {',
      "  const app = await NestFactory.create(AppModule);",
      "  app.setGlobalPrefix('api');",
      '  await app.listen(3000);',
      '}',
    ].join('\n'),
    'src/gaps.controller.ts': [
      "import { Controller, Get, All } from '@nestjs/common';",
      "const PATH = 'from-a-constant';",
      "const BASE = 'base';",
      "@Controller('gaps')",
      'export class GapsController {',
      '  @Get(PATH) constant() { return 1; }',
      '  @Get(`${BASE}/x`) template() { return 1; }',
      "  @All('everything') all() { return 1; }",
      "  @Get('fine') fine() { return 1; }",
      '}',
    ].join('\n'),
    'src/other.controller.ts': [
      "import { Controller, Get } from 'routing-controllers';",
      "@Controller('/not-nest')",
      "export class OtherController { @Get('/x') x() { return 1; } }",
    ].join('\n'),
  };
  const dir = tempRepo(files);
  const f = await ingest(dir);
  assert.deepEqual(routeIds(f), ['svc::route::GET /gaps/fine']);
  const gaps = f.meta!.routes!.gaps;
  assert.deepEqual(gaps.map((g) => [g.kind, g.name, g.line]), [
    ['non-literal-path', 'GapsController.constant', 6],
    ['non-literal-path', 'GapsController.template', 7],
    ['all-verb', 'GapsController.all', 8],
    ['global-prefix', 'app.setGlobalPrefix', 4],
  ]);
  assert.match(gaps[3]!.text, /setGlobalPrefix\('api'\) is not applied/);
  assert.ok(gaps.every((g) => g.path.startsWith('src/')));
  // the library path says the same, and says the analysis is incomplete while a declared route went unread
  const r = await createParser({ adapters: [tsJsAdapter] }).parseRepository({ root: dir, sourceId: 'svc' });
  assert.equal(r.analysis.complete, false);
  assert.deepEqual(r.analysis.diagnostics.filter((d) => d.code === 'unsupported').map((d) => [d.reason, d.path, d.line]).sort(), [
    ['all-verb', 'src/gaps.controller.ts', 8], ['global-prefix', 'src/main.ts', 4],
    ['non-literal-path', 'src/gaps.controller.ts', 6], ['non-literal-path', 'src/gaps.controller.ts', 7],
  ]);
});

test('delegate: one `return handler(…)` (awaited or not) mirrors the handler’s guard and rule onto the route; a two-statement body keeps only the method edge', async () => {
  for (const body of ['return approveOrder(req, ctx);', 'return await approveOrder(req, ctx);']) {
    const f = await ingest(tempRepo({ ...handlerFiles, [CONTROLLER]: controllerFile(body) }));
    const guards = edgesOf(f, 'guards', ROUTE);
    const validates = edgesOf(f, 'validates', ROUTE);
    assert.deepEqual(guards.map((e) => [e.from, e.meta]), [['svc::src/auth/session.ts::requireSession', { via: 'handler', handler: HANDLER }]], body);
    assert.deepEqual(validates.map((e) => [e.from, e.meta]), [['svc::src/handlers/approve-order.ts::approveSchema', { via: 'handler', handler: HANDLER }]], body);
    // the method's call to the handler is the delegation — stamped so core reads the two as one place
    const call = f.edges.find((e) => e.kind === 'calls' && e.from === METHOD && e.to === HANDLER)!;
    assert.equal(call.meta?.via, 'delegate', body);
    // a guard inside a service the handler calls stays off the route (one hop, as today)
    assert.equal(f.edges.filter((e) => e.kind === 'calls' && e.from === ROUTE).length, 1);
  }
  const two = await ingest(tempRepo({ ...handlerFiles, [CONTROLLER]: controllerFile('const started = Date.now();\n    return approveOrder(req, ctx);') }));
  assert.deepEqual(edgesOf(two, 'guards', ROUTE), []);
  assert.deepEqual(edgesOf(two, 'validates', ROUTE), []);
  assert.deepEqual(two.edges.filter((e) => e.kind === 'calls' && e.from === ROUTE).map((e) => e.to), [METHOD]);
  const call = two.edges.find((e) => e.kind === 'calls' && e.from === METHOD && e.to === HANDLER)!;
  assert.equal(call.meta?.via, undefined, 'the body is not a delegation');
});

test('@UseGuards: class-level guards every route, method-level its own; a repo class with canActivate is walked into', async () => {
  const f = await ingest(tempRepo({
    'src/guards/session.guard.ts': [
      "import { Injectable } from '@nestjs/common';",
      '@Injectable()',
      'export class SessionGuard {',
      '  canActivate(ctx: ExecutionContext) { return ctx != null; }',
      '}',
    ].join('\n'),
    'src/orders.controller.ts': [
      "import { Controller, Get, Post, UseGuards } from '@nestjs/common';",
      "import { RolesGuard } from 'some-auth-package';",
      "import { SessionGuard } from './guards/session.guard';",
      "@Controller('orders')",
      '@UseGuards(SessionGuard)',
      'export class OrdersController {',
      '  @Get() list() { return 1; }',
      "  @Post('approve')",
      "  @UseGuards(RolesGuard, AuthGuard('jwt'))",
      '  approve() { return 1; }',
      '}',
    ].join('\n'),
  }));
  const LIST = 'svc::route::GET /orders', APPROVE = 'svc::route::POST /orders/approve';
  const SESSION = 'svc::guard::UseGuards(SessionGuard)', ROLES = 'svc::guard::UseGuards(RolesGuard)', JWT = 'svc::guard::UseGuards(AuthGuard(jwt))';
  const nodes = byId(f);
  assert.equal(nodes.get(SESSION)!.name, 'UseGuards: SessionGuard');
  assert.deepEqual(nodes.get(SESSION)!.tags, ['auth']);
  assert.deepEqual(edgesOf(f, 'guards', LIST).map((e) => e.from), [SESSION]);
  assert.deepEqual(edgesOf(f, 'guards', APPROVE).map((e) => e.from).sort(), [JWT, ROLES, SESSION]);
  const onList = edgesOf(f, 'guards', LIST)[0]!;
  assert.equal(onList.resolution!.technique, 'annotation-scan');
  assert.equal(onList.resolution!.note, '@UseGuards(SessionGuard) on OrdersController');
  // the guard runs SessionGuard.canActivate: the route calls the guard (via guard) and the guard calls the check
  const CHECK = 'svc::src/guards/session.guard.ts::SessionGuard.canActivate';
  assert.ok(nodes.has(CHECK));
  assert.deepEqual(f.edges.filter((e) => e.kind === 'calls' && e.from === SESSION).map((e) => [e.to, e.resolution!.technique]), [[CHECK, 'static-import']]);
  assert.deepEqual(f.edges.filter((e) => e.kind === 'calls' && e.to === SESSION).map((e) => [e.from, e.meta]).sort(), [[LIST, { via: 'guard' }], [APPROVE, { via: 'guard' }]]);
  // a guard from a package or a factory call is a gate only — nothing to walk into
  assert.deepEqual(f.edges.filter((e) => e.kind === 'calls' && (e.from === ROLES || e.from === JWT)), []);
});

test('docs: a class comment above @Controller and before `export` gives its @group to the methods; a disagreeing @entrypoint is a named gap, the decorators win', async () => {
  const f = await ingest(tempRepo({
    ...handlerFiles,
    [CONTROLLER]: [
      "import { Controller, Post, Get } from '@nestjs/common';",
      "import { approveOrder } from '../handlers/approve-order';",
      '/**',
      ' * Orders over HTTP.',
      ' * @group orders',
      ' */',
      "@Controller('api/v1/orders')",
      'export class OrdersController {',
      '  /** @entrypoint http:POST /api/v1/orders/{orderId}/approve */',
      "  @Post(':orderId/approve')",
      '  approveOrder(req: Request, ctx: Ctx) { return approveOrder(req, ctx); }',
      '  /** @entrypoint http:GET /api/v1/orders/list */',
      '  @Get()',
      '  list() { return 1; }',
      '}',
    ].join('\n'),
  }));
  const nodes = byId(f);
  assert.equal(nodes.get(METHOD)!.group, 'orders');
  assert.equal(nodes.get(`svc::${CONTROLLER}::OrdersController.list`)!.group, 'orders');
  assert.ok(nodes.get(METHOD)!.tags.includes('entrypoint'), 'the declared entry point still tags the method');
  assert.deepEqual(routeIds(f), ['svc::route::GET /api/v1/orders', ROUTE]);
  assert.deepEqual(f.meta!.routes!.gaps.map((g) => [g.kind, g.name]), [['entrypoint-mismatch', 'OrdersController.list']]);
  assert.match(f.meta!.routes!.gaps[0]!.text, /names GET \/api\/v1\/orders\/list; its decorators declare GET \/api\/v1\/orders — the decorators win/);
  // the method has no words of its own by convention: a journey borrows the handler's sentence for it
  const index = buildIndex(f.nodes, f.edges);
  const j = journey(index, ROUTE);
  const summary = journeySummary(index, j, screensFor(index, ROUTE));
  const marker = summary.segments.flatMap((s) => s.markers).find((m) => m.nodeId === METHOD);
  assert.ok(marker, 'the controller method is a step of the route journey');
  assert.deepEqual([marker!.title, marker!.titleFrom], ['Approves an order.', 'docs']);
  // and the generated spec reads the same sentence as the operation's summary
  const doc = graphToSpec(index, { repo: 'svc' });
  const [generatedPath, ops] = Object.entries(doc.paths!).find(([k]) => k.endsWith('/approve'))! as [string, Record<string, { summary?: string }>];
  assert.equal(generatedPath, '/api/v1/orders/{param}/approve', 'the route id already folded the parameter name');
  assert.equal(ops.post!.summary, 'Approves an order.');
});

const SPEC = [
  'openapi: 3.0.0',
  'info: { title: Orders, version: "1" }',
  'paths:',
  '  /api/v1/orders/{orderId}/approve:',
  '    post:',
  '      operationId: approveOrder',
  '      requestBody: { required: true, content: { application/json: { schema: { type: object, properties: { note: { type: string } } } } } }',
  '      responses: { "200": { description: ok } }',
].join('\n');

test('OpenAPI: the declared operation matches the controller route (`both`, operationId stamped); a renamed method raises the naming note, never drift', async () => {
  const f = await ingest(tempRepo({ ...handlerFiles, [CONTROLLER]: controllerFile(), 'openapi.yaml': SPEC }), { openapi: true });
  const route = byId(f).get(ROUTE)!;
  assert.equal(route.contract!.status, 'both');
  assert.equal(route.contract!.spec!.operationId, 'approveOrder');
  assert.equal(route.contract!.drift, undefined);
  const parsed = parseSpecText(SPEC, 'openapi.yaml');
  const same = reconcile(parsed.doc, buildIndex(f.nodes, f.edges), { repo: 'svc', path: 'openapi.yaml', lineOf: parsed.lineOf });
  assert.equal(same.notes, undefined, 'the method is named after the operation');
  // the same endpoint behind a method named differently
  const renamed = await ingest(tempRepo({ ...handlerFiles, [CONTROLLER]: controllerFile().replace('  approveOrder(req', '  approve(req') }));
  const r = reconcile(parsed.doc, buildIndex(renamed.nodes, renamed.edges), { repo: 'svc', path: 'openapi.yaml', lineOf: parsed.lineOf });
  assert.deepEqual(r.notes, [{ routeId: ROUTE, op: 'POST /api/v1/orders/{orderId}/approve', kind: 'operationId-name', message: 'the handler is OrdersController.approve; the spec names the operation approveOrder' }]);
  assert.equal(r.counts.drift, 0, 'a note is not drift: --strict stays green');
  assert.equal(r.matched.length, 1);
  assert.match(driftMarkdown(r), /## notes — not drift, never fails --strict\n- POST \/api\/v1\/orders\/\{orderId\}\/approve: the handler is OrdersController\.approve/);
});

test('coverage: a test that imports the handler reaches the route’s cell through the delegation, and the handler’s cell reads the route’s own tests', async () => {
  const f = await ingest(tempRepo({
    ...handlerFiles,
    [CONTROLLER]: controllerFile(),
    'src/handlers/approve-order.test.ts': [
      "import { test } from 'vitest';",
      "import { approveOrder } from './approve-order';",
      "test('approves', async () => { await approveOrder(new Request('http://x'), {}); });",
    ].join('\n'),
    'e2e/approve.pw.spec.ts': [
      "import { test } from '@playwright/test';",
      "test('approve over http', async ({ request }) => { const orderId = '42'; await request.post(`/api/v1/orders/${orderId}/approve`); });",
    ].join('\n'),
  }), { tests: true });
  const index = buildIndex(f.nodes, f.edges);
  const route = stepCoverage(index, ROUTE)!;
  assert.deepEqual(route.sameLoc, [METHOD]);
  assert.deepEqual(route.delegates, [HANDLER]);
  assert.deepEqual(route.tests.map((t) => t.name).sort(), ['approve over http', 'approves']);
  const method = stepCoverage(index, METHOD)!;
  assert.deepEqual(method.tests.map((t) => t.name).sort(), ['approve over http', 'approves']);
  const handler = stepCoverage(index, HANDLER)!;
  assert.deepEqual(handler.delegates!.sort(), [METHOD, ROUTE].sort());
  assert.deepEqual(handler.tests.map((t) => t.name).sort(), ['approve over http', 'approves']);
  // what the handler calls is its own cell, as before
  assert.deepEqual(stepCoverage(index, 'svc::src/auth/session.ts::requireSession')!.tests, []);
});

test('same id: an App Router route.ts and a controller for the same endpoint produce identical route ids', async () => {
  const appRouter = await ingest(tempRepo({
    'app/api/v1/orders/[orderId]/approve/route.ts': 'export async function POST(req: Request) { return new Response(null); }',
  }));
  const nest = await ingest(tempRepo({ ...handlerFiles, [CONTROLLER]: controllerFile() }));
  assert.deepEqual(routeIds(appRouter), [ROUTE]);
  assert.deepEqual(routeIds(nest), [ROUTE]);
  const a = appRouter.nodes.find((n) => n.id === ROUTE)!, b = nest.nodes.find((n) => n.id === ROUTE)!;
  assert.deepEqual({ ...a, loc: undefined }, { ...b, loc: undefined }, 'only the location differs');
});
