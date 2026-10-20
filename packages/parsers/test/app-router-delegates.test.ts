// Next.js App Router verbs that hand their whole body to a handler — `export async function POST(req, ctx) {
// return approveOrder(req, ctx); }` over an imported function (code-parser/src/walk.ts `singleReturnCallee`,
// wired in tsjs.ts beside the NestJS reader's delegate rule): the handler's guards and rules mirror onto the
// route node, the verb → handler call is the delegation core reads as one coverage cell, and a wrapped route is
// the same route (id, location, the verb's own hop) as the inline one. Runs against the built packages:
// `pnpm build` first.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestRepo } from '../dist/index.js';
import { buildIndex, stepCoverage, journey, journeySummary, screensFor, graphToSpec } from '@farsight/core';
import type { GraphFragment } from '@farsight/core';

const tempRepos: string[] = [];
after(() => { for (const dir of tempRepos) rmSync(dir, { recursive: true, force: true }); });

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-app-router-'));
  tempRepos.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

/** The code only — no spec, design, tests, stories or projects pass unless a test asks for one. */
const ingest = (dir: string, extra: Record<string, unknown> = {}) =>
  ingestRepo(dir, { repoName: 'web', openapi: false, design: false, tests: false, stories: false, projects: false, ...extra });

const byId = (f: GraphFragment) => new Map(f.nodes.map((n) => [n.id, n]));
const routeIds = (f: GraphFragment) => f.nodes.filter((n) => n.kind === 'route').map((n) => n.id).sort();
const edgesOf = (f: GraphFragment, kind: string, to: string) => f.edges.filter((e) => e.kind === kind && e.to === to);
const callsFrom = (f: GraphFragment, from: string) => f.edges.filter((e) => e.kind === 'calls' && e.from === from);

const ROUTE_FILE = 'app/api/orders/[orderId]/approve/route.ts';
const ROUTE = 'web::route::POST /api/orders/:param/approve';
const VERB = `web::${ROUTE_FILE}::POST`;
const HANDLER = 'web::lib/handlers/approve-order.ts::approveOrder';
const GUARD = 'web::lib/auth/session.ts::requireSession';
const SCHEMA = 'web::lib/handlers/approve-order.ts::approveSchema';

/** The handler in a library: the guard and the schema inline, the words on the handler. */
const handlerFiles = {
  'lib/handlers/approve-order.ts': [
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
  'lib/auth/session.ts': [
    '/** @guard a signed-in session */',
    "export async function requireSession(req: Request) { return req.headers.get('x-session'); }",
  ].join('\n'),
};
/** The wrapper `route.ts`: the import on line 1, the verb on line 2. */
const routeFile = (verb = 'export async function POST(req: Request, ctx: Ctx) { return approveOrder(req, ctx); }', from = '../../../../../lib/handlers/approve-order', name = 'approveOrder') => [
  `import { ${name} } from '${from}';`,
  verb,
].join('\n');

test('a wrapped verb keeps the delegate’s guard and rule on the route, with the route itself unchanged', async () => {
  const forms: Record<string, string> = {
    'return': 'export async function POST(req: Request, ctx: Ctx) { return approveOrder(req, ctx); }',
    'return await': 'export async function POST(req: Request, ctx: Ctx) { return await approveOrder(req, ctx); }',
    'arrow block': 'export const POST = async (req: Request, ctx: Ctx) => { return approveOrder(req, ctx); };',
    'arrow expression': 'export const POST = async (req: Request, ctx: Ctx) => approveOrder(req, ctx);',
  };
  for (const [form, verb] of Object.entries(forms)) {
    const f = await ingest(tempRepo({ ...handlerFiles, [ROUTE_FILE]: routeFile(verb) }));
    const nodes = byId(f);
    assert.deepEqual(routeIds(f), [ROUTE], form);
    const route = nodes.get(ROUTE)!;
    assert.deepEqual(route.loc, { repo: 'web', path: ROUTE_FILE, line: 2 }, `${form}: the route sits on the verb`);
    assert.equal(nodes.get(VERB)!.loc!.line, 2, `${form}: the verb shares the line (sameLocTwins)`);
    // the handler's gate and rule are the route's, one hop away, marked as mirrored through the handler
    assert.deepEqual(edgesOf(f, 'guards', ROUTE).map((e) => [e.from, e.meta]), [[GUARD, { via: 'handler', handler: HANDLER }]], form);
    assert.deepEqual(edgesOf(f, 'validates', ROUTE).map((e) => [e.from, e.meta]), [[SCHEMA, { via: 'handler', handler: HANDLER }]], form);
    // the verb's call to the handler is the delegation; the route's own hop is the verb and nothing else
    assert.deepEqual(callsFrom(f, ROUTE).map((e) => [e.to, e.resolution?.technique]), [[VERB, 'same-file']], form);
    const call = callsFrom(f, VERB).find((e) => e.to === HANDLER)!;
    assert.ok(call, `${form}: the verb calls the handler`);
    assert.equal(call.meta?.via, 'delegate', form);
    assert.equal(call.resolution?.technique, 'static-import', form);
    // a guard inside a service the handler calls stays off the route (one hop, as today)
    assert.deepEqual(edgesOf(f, 'guards', HANDLER).map((e) => e.from), [GUARD], form);
  }
});

test('the wrapped route is the inline route: same id, same node, same location', async () => {
  const inline = await ingest(tempRepo({
    ...handlerFiles,
    [ROUTE_FILE]: [
      "import { requireSession } from '../../../../../lib/auth/session';",
      "export async function POST(req: Request, ctx: Ctx) { const who = await requireSession(req); return json(who); }",
    ].join('\n'),
  }));
  const wrapped = await ingest(tempRepo({ ...handlerFiles, [ROUTE_FILE]: routeFile() }));
  assert.deepEqual(routeIds(inline), [ROUTE]);
  assert.deepEqual(routeIds(wrapped), [ROUTE]);
  assert.deepEqual(byId(wrapped).get(ROUTE), byId(inline).get(ROUTE), 'the route node is byte-equal: a port to a wrapper is no change in farsight diff');
  // and both carry the guard on the route — inline from the verb's own call, wrapped through the handler
  assert.deepEqual(edgesOf(inline, 'guards', ROUTE).map((e) => [e.from, e.meta]), [[GUARD, { via: 'handler', handler: VERB }]]);
  assert.deepEqual(edgesOf(wrapped, 'guards', ROUTE).map((e) => [e.from, e.meta]), [[GUARD, { via: 'handler', handler: HANDLER }]]);
});

test('any other body shape keeps today’s behaviour: two statements, a same-file callee, a shadowing parameter, a member call', async () => {
  const shapes: Record<string, Record<string, string>> = {
    'two statements': { [ROUTE_FILE]: routeFile('export async function POST(req: Request, ctx: Ctx) {\n  const started = Date.now();\n  return approveOrder(req, ctx);\n}') },
    'a member call': { [ROUTE_FILE]: routeFile('export async function POST(req: Request, ctx: Ctx) { return orders.approveOrder(req, ctx); }') },
    'a shadowing parameter': { [ROUTE_FILE]: routeFile('export async function POST(req: Request, ctx: Ctx, approveOrder: Function) { return approveOrder(req, ctx); }') },
    'a same-file callee': {
      [ROUTE_FILE]: [
        "import { requireSession } from '../../../../../lib/auth/session';",
        'export async function POST(req: Request, ctx: Ctx) { return handle(req, ctx); }',
        'async function handle(req: Request, ctx: Ctx) { const who = await requireSession(req); return json(who); }',
      ].join('\n'),
    },
  };
  for (const [shape, files] of Object.entries(shapes)) {
    const f = await ingest(tempRepo({ ...handlerFiles, ...files }));
    assert.deepEqual(routeIds(f), [ROUTE], shape);
    assert.deepEqual(edgesOf(f, 'guards', ROUTE), [], `${shape}: nothing mirrors onto the route`);
    assert.deepEqual(edgesOf(f, 'validates', ROUTE), [], shape);
    assert.deepEqual(callsFrom(f, ROUTE).map((e) => e.to), [VERB], shape);
    assert.ok(!f.edges.some((e) => e.from === VERB && e.meta?.via === 'delegate'), `${shape}: the verb is not a delegation`);
  }
  // the two-statement verb still calls the handler — as any function's calls are walked — just not as its whole body
  const two = await ingest(tempRepo({ ...handlerFiles, ...shapes['two statements'] }));
  assert.deepEqual(callsFrom(two, VERB).map((e) => [e.to, e.meta?.via]), [[HANDLER, undefined]]);
});

test('a delegate imported through a barrel, renamed on the way, resolves to the declaring file', async () => {
  const f = await ingest(tempRepo({
    ...handlerFiles,
    'lib/index.ts': "export { approveOrder as approveOrderHandler } from './handlers/approve-order';",
    [ROUTE_FILE]: routeFile('export async function POST(req: Request, ctx: Ctx) { return approveOrderHandler(req, ctx); }', '../../../../../lib', 'approveOrderHandler'),
  }));
  assert.deepEqual(edgesOf(f, 'guards', ROUTE).map((e) => [e.from, e.meta]), [[GUARD, { via: 'handler', handler: HANDLER }]]);
  assert.deepEqual(edgesOf(f, 'validates', ROUTE).map((e) => [e.from, e.meta]), [[SCHEMA, { via: 'handler', handler: HANDLER }]]);
  assert.equal(callsFrom(f, VERB).find((e) => e.to === HANDLER)!.meta?.via, 'delegate');
});

test('the words: the generated spec borrows the handler’s @business sentence; in a journey the verb keeps its route’s words and the handler its own', async () => {
  const f = await ingest(tempRepo({ ...handlerFiles, [ROUTE_FILE]: routeFile() }));
  const index = buildIndex(f.nodes, f.edges);
  const j = journey(index, ROUTE);
  const summary = journeySummary(index, j, screensFor(index, ROUTE));
  const markers = summary.segments.flatMap((s) => s.markers);
  const verb = markers.find((m) => m.nodeId === VERB);
  assert.ok(verb, 'the verb is a step of the route journey');
  // a verb-named handler borrows its route's words before anything else (R7c) — the delegate rule adds
  // words only to a method that has none, as a controller method; the handler's sentence is its own step's
  assert.deepEqual([verb!.title, verb!.titleFrom], ['POST /api/orders/:param/approve', 'route']);
  const handler = markers.find((m) => m.nodeId === HANDLER);
  assert.deepEqual([handler!.title, handler!.titleFrom], ['Approves an order.', 'docs']);
  const doc = graphToSpec(index, { repo: 'web' });
  const ops = doc.paths!['/api/orders/{param}/approve'] as Record<string, { summary?: string }>;
  assert.equal(ops.post!.summary, 'Approves an order.');
});

test('coverage: route, verb and handler are one cell — a test that reaches any of them is read by all three', async () => {
  const f = await ingest(tempRepo({
    ...handlerFiles,
    [ROUTE_FILE]: routeFile(),
    'lib/handlers/approve-order.test.ts': [
      "import { test } from 'vitest';",
      "import { approveOrder } from './approve-order';",
      "test('approves', async () => { await approveOrder(new Request('http://x'), {}); });",
    ].join('\n'),
    'e2e/approve.pw.spec.ts': [
      "import { test } from '@playwright/test';",
      "test('approve over http', async ({ request }) => { const orderId = '42'; await request.post(`/api/orders/${orderId}/approve`); });",
    ].join('\n'),
  }), { tests: true });
  const index = buildIndex(f.nodes, f.edges);
  const route = stepCoverage(index, ROUTE)!;
  assert.deepEqual(route.sameLoc, [VERB]);
  assert.deepEqual(route.delegates, [HANDLER]);
  assert.deepEqual(route.tests.map((t) => t.name).sort(), ['approve over http', 'approves']);
  const verb = stepCoverage(index, VERB)!;
  assert.deepEqual(verb.tests.map((t) => t.name).sort(), ['approve over http', 'approves']);
  const handler = stepCoverage(index, HANDLER)!;
  assert.deepEqual(handler.delegates!.sort(), [ROUTE, VERB].sort());
  assert.deepEqual(handler.tests.map((t) => t.name).sort(), ['approve over http', 'approves']);
  // what the handler calls is its own cell, as before
  assert.deepEqual(stepCoverage(index, GUARD)!.tests, []);
});

const SPEC = [
  'openapi: 3.0.0',
  'info: { title: Orders, version: "1" }',
  'paths:',
  '  /api/orders/{orderId}/approve:',
  '    post:',
  '      operationId: approveOrder',
  '      security: [{ bearerAuth: [] }]',
  '      requestBody: { required: true, content: { application/json: { schema: { type: object, properties: { note: { type: string } } } } } }',
  '      responses: { "200": { description: ok } }',
].join('\n');

test('OpenAPI: a wrapped route reports no security-missing-in-code or body-unvalidated; a verb that does more than wrap still does', async () => {
  const wrapped = await ingest(tempRepo({ ...handlerFiles, [ROUTE_FILE]: routeFile(), 'openapi.yaml': SPEC }), { openapi: true });
  const route = byId(wrapped).get(ROUTE)!;
  assert.equal(route.contract!.status, 'both');
  assert.equal(route.contract!.spec!.operationId, 'approveOrder');
  assert.equal(route.contract!.drift, undefined, 'the guard and the schema the handler runs are the route’s');
  // the same handler reached from a verb whose body is not one return: the guard is two calls from the
  // route and the drift gate says so — the notes the wrappers introduced before this reader read them
  const bodied = await ingest(tempRepo({
    ...handlerFiles,
    [ROUTE_FILE]: routeFile('export async function POST(req: Request, ctx: Ctx) {\n  const started = Date.now();\n  return approveOrder(req, ctx);\n}'),
    'openapi.yaml': SPEC,
  }), { openapi: true });
  assert.deepEqual((byId(bodied).get(ROUTE)!.contract!.drift ?? []).map((d) => d.kind).sort(), ['body-unvalidated', 'security-missing-in-code']);
});
