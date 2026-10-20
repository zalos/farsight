// NestJS controllers as HTTP routes (code-parser/src/nest.ts, wired in tsjs.ts): the same route ids
// App Router gives the same endpoints, the method as the route's body, the handler it delegates to
// mirrored onto the route, @UseGuards as guards, docs, gaps, the spec join and the coverage cell.
// Runs against the built packages: `pnpm build` first.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestRepo, parseSpecText } from '../dist/index.js';
import { buildIndex, stepCoverage, reconcile, driftMarkdown, journey, journeySummary, screensFor, graphToSpec } from '@farsight/core';
import type { GraphFragment } from '@farsight/core';
import { createParser } from '@farsight/code-parser';
import { tsJsAdapter } from '@farsight/code-parser/adapters/tsjs';

const tempRepos: string[] = [];
after(() => { for (const dir of tempRepos) rmSync(dir, { recursive: true, force: true }); });

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-nest-'));
  tempRepos.push(dir);
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

test('Body schema declarations resolve aliases and barrels into rule edges on method and route', async () => {
  const f = await ingest(tempRepo({
    'src/schema.ts': "import { z } from 'zod'; export const orderSchema = z.object({ title: z.string() });",
    'src/barrel.ts': "export { orderSchema as inputSchema } from './schema';",
    'src/controller.ts': [
      "import { Controller as C, Post, Body as B, Query } from '@nestjs/common';",
      "import { inputSchema as bodySchema } from './barrel';",
      "@C('orders') export class Orders {",
      '  @Post() create(@B({ schema: bodySchema }) body: unknown) { return body; }',
      "  @Post('query') query(@Query({ schema: bodySchema }) body: unknown) { return body; }",
      "  @Post('type') type(@B() body: bodySchema) { return body; }",
      "  @Post('spread') spread(@B({ schema: bodySchema, ...options }) body: unknown) { return body; }",
      '}',
    ].join('\n'),
  }));
  const schema = 'svc::src/schema.ts::orderSchema';
  const method = edgesOf(f, 'validates', 'svc::src/controller.ts::Orders.create');
  assert.equal(method.length, 1);
  assert.equal(method[0]!.from, schema);
  assert.match(method[0]!.resolution!.note!, /runtime validation-pipe registration is not verified/);
  assert.equal(edgesOf(f, 'validates', 'svc::route::POST /orders')[0]?.from, schema);
  assert.match(edgesOf(f, 'validates', 'svc::route::POST /orders')[0]!.resolution!.note!, /runtime validation-pipe registration is not verified/);
  for (const path of ['query', 'type', 'spread']) assert.equal(edgesOf(f, 'validates', `svc::route::POST /orders/${path}`).length, 0);
});

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
  assert.deepEqual(r.graph.meta?.routes, f.meta?.routes, 'portable analysis retains the route gaps');
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
  const guardId = (label: string) => f.nodes.find(n => n.kind === 'guard' && n.name === `UseGuards: ${label}`)!.id;
  const SESSION = guardId('SessionGuard'), ROLES = guardId('RolesGuard'), JWT = guardId('AuthGuard(jwt)');
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

test('React Router data mode: `{ path, Component }` is a page rendering the component, beside `element` and `component`', async () => {
  const f = await ingest(tempRepo({
    'src/pages.tsx': [
      'export function OrdersPage() { return <main>orders</main>; }',
      'export function OrderPage() { return <main>order</main>; }',
      'export function LegacyPage() { return <main>legacy</main>; }',
    ].join('\n'),
    'src/routes.tsx': [
      "import { OrdersPage, OrderPage, LegacyPage } from './pages';",
      'export const routes = [',
      "  { path: '/orders', Component: OrdersPage },",
      "  { path: '/orders/:id', element: <OrderPage /> },",
      "  { path: '/legacy', component: LegacyPage },",
      "  { path: '/no-page', Component: someFactory() },",
      '];',
    ].join('\n'),
  }));
  const pages = f.nodes.filter((n) => n.kind === 'page').map((n) => n.id).sort();
  assert.deepEqual(pages, ['svc::page::/legacy', 'svc::page::/orders', 'svc::page::/orders/:id']);
  const renders = f.edges.filter((e) => e.kind === 'renders' && e.from === 'svc::page::/orders').map((e) => e.to);
  assert.deepEqual(renders, ['svc::src/pages.tsx::OrdersPage']);
});


test('guard declarations keep same-named classes in different modules separate', async () => {
  const f = await ingest(tempRepo(Object.fromEntries(['admin', 'public'].flatMap(area => [
    [`src/${area}/guard.ts`, `export class SessionGuard { canActivate() { return ${area === 'admin'}; } }`],
    [`src/${area}/controller.ts`, `import { Controller, Get, UseGuards } from '@nestjs/common';
import { SessionGuard } from './guard';
@Controller('${area}') @UseGuards(SessionGuard)
export class AreaController { @Get() list() { return 1; } }`],
  ]))));
  const guards = ['admin', 'public'].map(area => edgesOf(f, 'guards', `svc::route::GET /${area}`)[0]!.from);
  assert.notEqual(guards[0], guards[1], 'distinct guard classes must not share a node');
  for (const [i, area] of ['admin', 'public'].entries()) {
    assert.deepEqual(f.edges.filter(e => e.kind === 'calls' && e.from === guards[i]).map(e => e.to),
      [`svc::src/${area}/guard.ts::SessionGuard.canActivate`]);
  }
});

test('guard class resolution follows renamed barrel exports', async () => {
  const f = await ingest(tempRepo({
    'src/guard.ts': 'export class SessionGuard { canActivate() { return true; } }',
    'src/index.ts': "export { SessionGuard as Gate } from './guard';",
    'src/controller.ts': `import { Controller, Get, UseGuards } from '@nestjs/common';
import { Gate as Auth } from './index';
@Controller('orders') @UseGuards(Auth)
export class OrdersController { @Get() list() { return 1; } }`,
  }));
  const guard = edgesOf(f, 'guards', 'svc::route::GET /orders')[0]!.from;
  assert.deepEqual(f.edges.filter(e => e.kind === 'calls' && e.from === guard).map(e => e.to),
    ['svc::src/guard.ts::SessionGuard.canActivate']);
});

test('computed controller options are gaps, and controller versions and RouterModule aliases are reported', async () => {
  const dir = tempRepo({
    'src/controllers.ts': `import { Controller, Get } from '@nestjs/common';
const key = 'path';
@Controller({ [key]: 'hidden' })
export class Computed { @Get('item') item() { return 1; } }
@Controller({ path: 'known', [key]: 'override' })
export class Overridden { @Get('item') item() { return 1; } }
@Controller({ path: 'cats', version: '1' })
export class Versioned { @Get() cats() { return 1; } }`,
    'src/main.ts': `import { RouterModule as Router } from '@nestjs/core';
import * as core from '@nestjs/core';
Router.register([{ path: 'api', module: ApiModule }]);
core.RouterModule.register([{ path: 'v2', module: OtherModule }]);`,
  });
  const f = await ingest(dir);
  assert.deepEqual(routeIds(f), ['svc::route::GET /cats'], 'computed keys must not invent a root or ignore an override');
  assert.deepEqual(f.meta?.routes?.gaps.map(g => g.kind).sort(),
    ['non-literal-path', 'non-literal-path', 'router-module', 'router-module', 'versioning']);
  const r = await createParser({ adapters: [tsJsAdapter] }).parseRepository({ root: dir, sourceId: 'svc' });
  assert.equal(r.analysis.complete, false);
  assert.equal(r.analysis.diagnostics.filter(d => d.code === 'unsupported').length, 5);
});


test('factory guard arguments stay separate even when their labels omit non-literal options', async () => {
  const f = await ingest(tempRepo({
    'src/controller.ts': `import { Controller, Get, UseGuards } from '@nestjs/common';
@Controller('orders') @UseGuards(AuthGuard(ADMIN), AuthGuard(USER))
export class OrdersController { @Get() list() { return 1; } }`,
  }));
  assert.equal(new Set(edgesOf(f, 'guards', 'svc::route::GET /orders').map(e => e.from)).size, 2);
});

test('a parameter shadowing an imported handler does not inherit that handler’s gates or coverage', async () => {
  const file = controllerFile().replace('approveOrder(req: Request, ctx: Ctx)', 'approveOrder(req: Request, ctx: Ctx, approveOrder: Function)');
  const f = await ingest(tempRepo({ ...handlerFiles, [CONTROLLER]: file }));
  assert.deepEqual(edgesOf(f, 'guards', ROUTE), []);
  assert.deepEqual(edgesOf(f, 'validates', ROUTE), []);
  assert.ok(!f.edges.some(e => e.from === METHOD && e.meta?.via === 'delegate'));
});
