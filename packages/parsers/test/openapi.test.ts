// OpenAPI reading + discovery + the ingestRepo post-pass, against the real
// examples/invoice-app fixture (its openapi.yaml carries deliberate drift).
// Runs against the built packages: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ingestRepo, parseSpecText, discoverSpecs, ingestSpec, specToYaml } from '../dist/index.js';
import { graphToSpec, buildIndex } from '@farsight/core';

const invoiceApp = resolve(import.meta.dirname, '../../../examples/invoice-app');

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-oas-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

test('parseSpecText: YAML with operation line numbers; JSON with a best-effort locator; non-specs rejected', () => {
  const y = parseSpecText(
    [
      'openapi: 3.0.0',
      'info: {title: T}',
      'paths:',
      '  /a:',
      '    get:',
      '      responses: {}',
      '    post:',
      '      responses: {}',
    ].join('\n'),
    'y.yaml',
  );
  assert.equal(y.format, 'yaml');
  assert.equal(y.lineOf('/a', 'get'), 5);
  assert.equal(y.lineOf('/a', 'post'), 7);
  assert.equal(y.lineOf('/zzz', 'get'), undefined);
  const j = parseSpecText(
    JSON.stringify({ swagger: '2.0', info: { title: 'J' }, paths: { '/b': { get: { responses: {} } } } }, null, 2),
    'j.json',
  );
  assert.equal(j.format, 'json');
  assert.equal(j.lineOf('/b', 'get'), 8);
  assert.throws(() => parseSpecText('name: not-a-spec\nversion: 1', 'x.yaml'), /not an OpenAPI/);
  assert.throws(() => parseSpecText('{"a": 1}', 'x.json'), /not an OpenAPI/);
  assert.throws(() => parseSpecText('paths: [unclosed', 'bad.yaml'), /YAML error/);
});

test('discoverSpecs: finds openapi.yaml in examples/invoice-app by name and content', async () => {
  const { specs, errors } = await discoverSpecs(invoiceApp, {});
  assert.deepEqual(errors, []);
  assert.deepEqual(
    specs.map((s) => [s.path, s.origin]),
    [['openapi.yaml', 'file']],
  );
  assert.equal(specs[0]!.doc.info?.title, 'Billing API');
});

test('discoverSpecs: config-declared paths win, names apply, a spec-named file that is not a spec is reported not thrown', async () => {
  const dir = tempRepo({
    'docs/contract.yaml': 'openapi: 3.0.0\ninfo: {title: Declared}\npaths: {}\n',
    'swagger.json': '{"not": "a spec"}',
    'package.json': '{"name": "x"}',
  });
  const { specs, errors } = await discoverSpecs(dir, {}, [{ path: 'docs/contract.yaml', name: 'Contract' }]);
  assert.deepEqual(
    specs.map((s) => [s.path, s.origin, s.name]),
    [['docs/contract.yaml', 'config', 'Contract']],
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /swagger\.json/);
});

test('ingestRepo(examples/invoice-app): the fixture drift lands on the route nodes', async () => {
  const f = await ingestRepo(invoiceApp, { repoName: 'invoice-app' });
  assert.equal(f.specErrors, undefined);
  const byId = new Map(f.nodes.map((n) => [n.id, n]));
  const api = f.nodes.find((n) => n.kind === 'api')!;
  assert.equal(api.id, 'invoice-app::api::openapi.yaml');
  assert.deepEqual(api.loc, { repo: 'invoice-app', path: 'openapi.yaml', line: 1 });
  const status = (id: string) => byId.get(id)?.contract?.status;
  const drift = (id: string) => (byId.get(id)?.contract?.drift ?? []).map((d) => d.kind);
  assert.equal(status('invoice-app::route::GET /invoices'), 'both');
  assert.deepEqual(drift('invoice-app::route::GET /invoices'), []);
  assert.equal(
    byId.get('invoice-app::route::GET /invoices')!.contract!.spec!.line,
    19,
    'operation line from the YAML (the get: key)',
  );
  assert.deepEqual(drift('invoice-app::route::PATCH /invoices/:id'), ['security-mismatch']);
  assert.equal(status('invoice-app::route::DELETE /invoices/{id}'), 'spec-only');
  assert.equal(byId.get('invoice-app::route::DELETE /invoices/{id}')!.loc, undefined);
  assert.equal(status('invoice-app::route::POST /invoices/:id/finalize'), 'code-only');
  assert.ok(byId.get('invoice-app::route::POST /invoices/:id/finalize')!.tags.includes('undocumented'));
  assert.deepEqual(byId.get('invoice-app::route::POST /invoices')!.contract!.requestBody, {
    contentType: 'application/json',
    schema: 'DraftInvoice',
    required: true,
    fields: ['customerId', 'lines'],
  });
  // freshness folds the spec in (23 source files — payments.ts and PaymentsPage.tsx since lane moves — + src/ui/CreateInvoiceForm.stories.tsx +
  // scripts/make-coverage.mjs + 4 spec files claimed by the tests adapter + openapi.yaml +
  // docs/design/screens.json)
  assert.equal(f.meta!.files, 31);
  // every http edge into a route carries a resolution (the fixture's third-party edges — the
  // SDK and the constant host — are `sdk-import` / `constant-host`, asserted in honest-systems)
  assert.ok(
    f.edges
      .filter((e) => e.kind === 'http' && byId.get(e.to)?.kind === 'route')
      .every((e) => e.resolution?.technique === 'fetch→route' && e.resolution.confidence === 'HIGH'),
  );
  // opting out leaves the code graph untouched
  const plain = await ingestRepo(invoiceApp, { repoName: 'invoice-app', openapi: false });
  assert.equal(
    plain.nodes.some((n) => n.kind === 'api' || n.contract),
    false,
  );
});

test('tsjs: unmatched fetches become unknown stubs (relative) or external hosts (absolute), never dropped', async () => {
  const dir = tempRepo({
    'src/client.ts': [
      "export async function a() { return fetch('/api/claims'); }",
      "export async function b() { return fetch('https://api.stripe.com/v1/charges', { method: 'POST' }); }",
      'export async function c(id: string) { return fetch(`/api/claims/${id}`); }',
    ].join('\n'),
  });
  const f = await ingestRepo(dir, { repoName: 'web' });
  const stubs = f.nodes
    .filter((n) => n.kind === 'unknown')
    .map((n) => n.name)
    .sort();
  assert.deepEqual(stubs, ['GET /api/claims', 'GET /api/claims/:param']);
  const ext = f.nodes.find((n) => n.kind === 'external')!;
  assert.equal(ext.name, 'api.stripe.com');
  const toExt = f.edges.find((e) => e.to === ext.id)!;
  assert.deepEqual(toExt.meta, { method: 'POST', path: '/v1/charges', line: 2 });
  const toStub = f.edges.find((e) => e.to === 'web::unknown::GET /api/claims')!;
  assert.equal(toStub.resolution!.status, 'unresolved');
  assert.equal(toStub.resolution!.confidence, 'LOW');
});

test('ingestSpec: a lone spec file becomes a spec-only source; specToYaml round-trips through parseSpecText', async () => {
  const dir = tempRepo({
    'petstore.yaml':
      'openapi: 3.0.0\ninfo: {title: Petstore, version: 9}\npaths:\n  /pets:\n    get: {responses: {}}\n',
  });
  const f = await ingestSpec(join(dir, 'petstore.yaml'), { repoName: 'petstore' });
  assert.equal(f.repo, 'petstore');
  assert.deepEqual(f.nodes.map((n) => n.kind).sort(), ['api', 'route']);
  assert.equal(f.nodes.find((n) => n.kind === 'route')!.contract!.status, 'declared');
  const doc = graphToSpec(buildIndex(f.nodes, f.edges), { repo: 'petstore' });
  assert.deepEqual(doc.paths, {}, 'declared-only routes are not generated as implemented');
  const text = specToYaml({
    openapi: '3.1.0',
    info: { title: 'X' },
    paths: { '/x': { get: { responses: { '200': { description: 'ok' } } } } },
  });
  assert.equal(parseSpecText(text, 'gen.yaml').lineOf('/x', 'get'), 6);
});

test('tsjs: raw node:http createServer handlers become routes; a templated-host fetch matches them', async () => {
  const dir = tempRepo({
    'src/server.ts': [
      "import { createServer } from 'node:http';",
      "function health() { return 'ok'; }",
      'createServer((req, res) => {',
      "  const url = new URL(req.url ?? '/', 'http://localhost');",
      "  if (url.pathname === '/healthz') { res.end(health()); return; }",
      "  if (url.pathname === '/api/settings' && req.method === 'PUT') { res.end('saved'); return; }",
      "  if (url.pathname.startsWith('/api/journey')) { res.end('j'); return; }",
      '});',
    ].join('\n'),
    'src/probe.ts': 'export async function probe(base: string) { return fetch(`${base}/healthz`); }',
  });
  const f = await ingestRepo(dir, { repoName: 'svc' });
  assert.deepEqual(
    f.nodes
      .filter((n) => n.kind === 'route')
      .map((n) => n.name)
      .sort(),
    ['GET /api/journey', 'GET /healthz', 'PUT /api/settings'],
  );
  assert.ok(
    f.edges.some(
      (e) => e.kind === 'calls' && e.from === 'svc::route::GET /healthz' && e.to === 'svc::src/server.ts::health',
    ),
    'calls inside the matching branch belong to the route',
  );
  const http = f.edges.find((e) => e.kind === 'http')!;
  assert.equal(http.to, 'svc::route::GET /healthz');
  assert.equal(f.nodes.filter((n) => n.kind === 'unknown').length, 0);
});

test('tsjs: raw test servers are excluded while production inspection routes remain', async () => {
  const server = (path: string) => `import { createServer } from 'node:http';
createServer((req, res) => { const url = new URL(req.url ?? '/', 'http://localhost');
if (url.pathname === '${path}') res.end('ok'); });`;
  const dir = tempRepo({
    'src/testing/provider.ts': server('/'),
    'testing/nested/provider.ts': server('/favicon.ico'),
    'src/provider.test-server.ts': server('/fixture'),
    'src/provider.test-server.js': server('/fixture-js'),
    'src/inspection.ts': server('/healthz'),
    'src/testing-tools/inspection.ts': server('/extractions/recent'),
  });
  const f = await ingestRepo(dir, { repoName: 'svc' });
  assert.deepEqual(
    f.nodes
      .filter((n) => n.kind === 'route')
      .map((n) => n.name)
      .sort(),
    ['GET /extractions/recent', 'GET /healthz'],
  );
});

// route-handler-attribution: a route that delegates to a named handler (App Router's
// exported verb function, or an Express identifier argument) inherits the handler's
// guards/validates so the drift check — which reads the route node directly — sees them.
test("tsjs: an App Router route mirrors its handler's guards and validates onto the route node", async () => {
  const dir = tempRepo({
    'lib/guards.ts': [
      '/** @guard */',
      'export function requireContractorSession(token: string) { return token; }',
    ].join('\n'),
    'lib/schemas.ts': [
      "import { z } from 'zod';",
      'export const magicLinkRequestSchema = z.object({ email: z.string() });',
    ].join('\n'),
    'app/api/v1/auth/magic-link/route.ts': [
      "import { magicLinkRequestSchema } from '../../../../../lib/schemas';",
      'function handle(fn: () => unknown) { return fn(); }',
      'export async function POST(req: Request) {',
      '  return handle(async () => {',
      '    const body = magicLinkRequestSchema.safeParse(await req.json());',
      '    return body;',
      '  });',
      '}',
    ].join('\n'),
    'app/api/v1/auth/session/route.ts': [
      "import { requireContractorSession } from '../../../../../lib/guards';",
      'function handle(fn: () => unknown) { return fn(); }',
      'export async function GET() {',
      "  return handle(async () => { requireContractorSession('t'); return null; });",
      '}',
      'export async function DELETE() {',
      "  return handle(async () => { requireContractorSession('t'); return null; });",
      '}',
    ].join('\n'),
  });
  const f = await ingestRepo(dir, { repoName: 'web' });
  const routeId = 'web::route::POST /api/v1/auth/magic-link';
  const handlerId = 'web::app/api/v1/auth/magic-link/route.ts::POST';
  const ruleId = 'web::lib/schemas.ts::magicLinkRequestSchema';
  // (1) the edge reaches both the handler and the route
  assert.ok(f.edges.some((e) => e.kind === 'validates' && e.from === ruleId && e.to === handlerId));
  const mirrored = f.edges.find((e) => e.kind === 'validates' && e.from === ruleId && e.to === routeId);
  assert.ok(mirrored, 'validates edge mirrored onto the route');
  // (2) the mirrored edge carries meta.via === 'handler'
  assert.equal(mirrored!.meta?.via, 'handler');
  assert.equal(mirrored!.meta?.handler, handlerId);

  const getRouteId = 'web::route::GET /api/v1/auth/session';
  const getHandlerId = 'web::app/api/v1/auth/session/route.ts::GET';
  const deleteRouteId = 'web::route::DELETE /api/v1/auth/session';
  const deleteHandlerId = 'web::app/api/v1/auth/session/route.ts::DELETE';
  const guardId = 'web::lib/guards.ts::requireContractorSession';
  for (const [routeId2, handlerId2] of [
    [getRouteId, getHandlerId],
    [deleteRouteId, deleteHandlerId],
  ] as const) {
    assert.ok(f.edges.some((e) => e.kind === 'guards' && e.from === guardId && e.to === handlerId2));
    const g = f.edges.find((e) => e.kind === 'guards' && e.from === guardId && e.to === routeId2);
    assert.ok(g, `guards edge mirrored onto ${routeId2}`);
    assert.equal(g!.meta?.via, 'handler');
  }
});

test("tsjs: an Express router.post('/x', namedHandler) route has a calls edge to its handler", async () => {
  const dir = tempRepo({
    'src/app.ts': [
      'declare const router: any;',
      'function createSession(req: unknown) { return req; }',
      "router.post('/session', createSession);",
    ].join('\n'),
  });
  const f = await ingestRepo(dir, { repoName: 'svc' });
  const routeId = 'svc::route::POST /session';
  const handlerId = 'svc::src/app.ts::createSession';
  assert.ok(
    f.edges.some((e) => e.kind === 'calls' && e.from === routeId && e.to === handlerId),
    'the route is no longer an orphan',
  );
});

test('reconcile(): a guarded, body-validating App Router route reports no security-missing-in-code or body-unvalidated', async () => {
  const dir = tempRepo({
    'lib/guards.ts': [
      '/** @guard */',
      'export function requireContractorSession(token: string) { return token; }',
    ].join('\n'),
    'lib/schemas.ts': [
      "import { z } from 'zod';",
      'export const magicLinkRequestSchema = z.object({ email: z.string() });',
    ].join('\n'),
    'app/api/v1/auth/magic-link/route.ts': [
      "import { magicLinkRequestSchema } from '../../../../../lib/schemas';",
      'function handle(fn: () => unknown) { return fn(); }',
      'export async function POST(req: Request) {',
      '  return handle(async () => {',
      '    const body = magicLinkRequestSchema.safeParse(await req.json());',
      '    return body;',
      '  });',
      '}',
    ].join('\n'),
    'app/api/v1/auth/session/route.ts': [
      "import { requireContractorSession } from '../../../../../lib/guards';",
      'function handle(fn: () => unknown) { return fn(); }',
      'export async function GET() {',
      "  return handle(async () => { requireContractorSession('t'); return null; });",
      '}',
    ].join('\n'),
    'openapi.yaml': [
      'openapi: 3.0.0',
      "info: {title: Auth, version: '1'}",
      'paths:',
      '  /api/v1/auth/magic-link:',
      '    post:',
      '      security: []',
      '      requestBody:',
      '        required: true',
      '        content: {application/json: {schema: {type: object}}}',
      "      responses: {'200': {description: ok}}",
      '  /api/v1/auth/session:',
      '    get:',
      '      security: [{bearerAuth: []}]',
      "      responses: {'200': {description: ok}}",
    ].join('\n'),
  });
  const f = await ingestRepo(dir, { repoName: 'web' });
  const byId = new Map(f.nodes.map((n) => [n.id, n]));
  const drift = (id: string) => (byId.get(id)?.contract?.drift ?? []).map((d) => d.kind);
  assert.deepEqual(drift('web::route::POST /api/v1/auth/magic-link'), []);
  assert.deepEqual(drift('web::route::GET /api/v1/auth/session'), []);
});

test('reconcile(): a GET whose handler validates the query is not reported as an undeclared body', async () => {
  const dir = tempRepo({
    'lib/schemas.ts': [
      "import { z } from 'zod';",
      'export const listQuerySchema = z.object({ page: z.string() });',
    ].join('\n'),
    'app/api/things/route.ts': [
      "import { listQuerySchema } from '../../../lib/schemas';",
      'export async function GET(req: Request) {',
      '  return listQuerySchema.parse(new URL(req.url).searchParams);',
      '}',
    ].join('\n'),
    'openapi.yaml': [
      'openapi: 3.0.0',
      "info: {title: Things, version: '1'}",
      'paths:',
      '  /api/things:',
      '    get:',
      '      parameters: [{name: page, in: query, schema: {type: string}}]',
      "      responses: {'200': {description: ok}}",
    ].join('\n'),
  });
  const f = await ingestRepo(dir, { repoName: 'web' });
  const route = f.nodes.find((n) => n.id === 'web::route::GET /api/things')!;
  // the rule is mirrored onto the route (it is the handler's), but a GET carries no body
  assert.ok(f.edges.some((e) => e.kind === 'validates' && e.to === route.id && e.meta?.via === 'handler'));
  assert.deepEqual(
    (route.contract?.drift ?? []).map((d) => d.kind),
    [],
  );
});

test("tsjs: a 'use server' action route has no method/path — an unmatched fetch skips it instead of crashing", async () => {
  const dir = tempRepo({
    'app/actions.ts': ["'use server';", 'export async function approveClaimAction(id: string) { return id; }'].join(
      '\n',
    ),
    'src/client.ts': ["export async function loadClaims() { return fetch('/api/claims'); }"].join('\n'),
  });
  const f = await ingestRepo(dir, { repoName: 'web' });
  assert.ok(
    f.nodes.some((n) => n.kind === 'route' && n.name === 'approveClaimAction'),
    'the action is a route node named for the function',
  );
  const stub = f.nodes.find((n) => n.kind === 'unknown');
  assert.ok(stub, 'the unmatched fetch still becomes a ? stub');
  assert.equal(stub!.name, 'GET /api/claims');
});

test('ingest config maps x-guards and proves configured multipart reader calls', async () => {
  const dir = tempRepo({
    'farsight.config.json': JSON.stringify({
      guards: { 'same-origin': ['assertSameOrigin'] },
      validators: ['readMultipart'],
    }),
    'lib/readers.ts':
      'export function assertSameOrigin(req: Request) { if (!req.headers.get("origin")) throw new Error("origin"); }\nexport function readMultipart(req: Request) { return req.formData(); }',
    'app/api/upload/route.ts':
      'import { assertSameOrigin, readMultipart } from "../../../lib/readers";\nexport async function POST(req: Request) { assertSameOrigin(req); return readMultipart(req); }',
    'openapi.json': JSON.stringify({
      openapi: '3.1.0',
      paths: {
        '/api/upload': {
          post: {
            'x-guards': ['same-origin'],
            requestBody: { required: true, content: { 'multipart/form-data': {} } },
          },
        },
      },
    }),
  });
  const fragment = await ingestRepo(dir, { repoName: 'app' });
  const route = fragment.nodes.find((node) => node.kind === 'route' && node.name === 'POST /api/upload');
  assert.ok(route);
  assert.equal(route.contract?.status, 'both');
  assert.deepEqual(route.contract?.drift ?? [], []);
  assert.ok(fragment.edges.some((edge) => edge.kind === 'calls' && edge.to.endsWith('::readMultipart')));
});

// Candidates are evidence for a registration door, never permission to change a graph.
test('discovery classifies named, directory, declared, workspace and sniffed documents; ignores win', async () => {
  const doc = JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Vendor', version: '1.4' },
    paths: { '/vendor': { get: {} } },
  });
  const dir = tempRepo({
    'openapi.yaml': 'openapi: 3.0.0\npaths: {}',
    'openapi/other.json': doc,
    'docs/vendor-api.json': doc,
    'docs/declared.json': doc,
    'docs/workspace.json': doc,
    'docs/ignored.json': doc,
    'excluded/vendor.json': doc,
  });
  const { specs, errors } = await discoverSpecs(
    dir,
    {
      exclude: ['excluded/**'],
      openapiIgnored: ['docs/ignored.json'],
      openapiRegistered: [{ path: 'docs/workspace.json', name: 'Workspace', phase: 'preview' }],
    },
    [{ path: 'docs/declared.json' }, { path: 'docs/missing.json' }, { path: 'docs/ignored.json' }],
  );
  assert.deepEqual(
    specs.map((s) => [s.path, s.status, s.origin]),
    [
      ['docs/declared.json', 'applied', 'config'],
      ['docs/workspace.json', 'applied', 'settings'],
      ['docs/vendor-api.json', 'candidate', 'file'],
      ['openapi.yaml', 'applied', 'file'],
      ['openapi/other.json', 'applied', 'file'],
    ],
  );
  assert.equal(specs[1]!.phase, 'preview');
  assert.deepEqual(errors, [
    'openapi docs/missing.json: declared in farsight.config.json, but there is no file at that path',
  ]);
});

test('candidate sniff is bounded and top-level, understands compact JSON and YAML, and respects ignores', async () => {
  const doc = { openapi: '3.0.0', paths: {} };
  const dir = tempRepo({
    'docs/compact.json': JSON.stringify({ info: { title: 'Nested' }, ...doc }),
    'docs/quoted.yaml': "'swagger': '2.0'\npaths: {}\n",
    'docs/nested.json': JSON.stringify({ example: doc, padding: 'x'.repeat(2048), ...doc }),
    'docs/late.json': JSON.stringify({ padding: 'x'.repeat(2048), ...doc }),
    'docs/too-big.json': JSON.stringify({ ...doc, description: 'x'.repeat(8 * 1024 * 1024) }),
    'docs/bad.yaml': 'openapi: 3.0.0\npaths: [',
    'docs/gitignored.json': JSON.stringify(doc),
    '.gitignore': 'docs/gitignored.json\n',
  });
  const { specs, errors } = await discoverSpecs(dir, {});
  assert.deepEqual(
    specs.map((s) => s.path),
    ['docs/compact.json', 'docs/quoted.yaml'],
  );
  assert.deepEqual(errors, []);
});

test('candidate metadata survives design and store persistence without moving nodes, edges or freshness', async () => {
  const dir = tempRepo({
    'src/app.ts': 'export function hello() { return 1; }',
    'docs/vendor-api.json': JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Vendor', version: '1.4' },
      paths: { '/vendor': { get: {}, parameters: [] } },
    }),
  });
  const plain = await ingestRepo(dir, { repoName: 'candidate', openapi: false });
  const found = await ingestRepo(dir, { repoName: 'candidate' });
  assert.deepEqual(found.nodes, plain.nodes);
  assert.deepEqual(found.edges, plain.edges);
  assert.equal(found.meta!.files, plain.meta!.files);
  assert.equal(found.meta!.sourceHash, plain.meta!.sourceHash);
  assert.equal(found.meta!.sourceDigest, plain.meta!.sourceDigest);
  assert.deepEqual(found.meta!.openapi, {
    applied: [],
    candidates: [{ path: 'docs/vendor-api.json', title: 'Vendor', version: '1.4', operations: 1, origin: 'file' }],
  });
  const { GraphStore, openApiCounts, countedProblems } = await import('@farsight/core');
  const store = new GraphStore();
  store.addFragment(found);
  const graphPath = join(dir, 'saved.json');
  store.save(graphPath);
  assert.deepEqual(GraphStore.load(graphPath).meta.openapi?.candidate, found.meta!.openapi);
  assert.deepEqual(store.toDocument().sources?.find((s) => s.repo === 'candidate')?.meta?.openapi, found.meta!.openapi);
  const counts = openApiCounts(found.meta!.openapi!);
  for (const c of [counts.applied, counts.candidates, ...Object.values(counts.operations)])
    assert.deepEqual(countedProblems(c), []);
  const invoice = await ingestRepo(invoiceApp, { repoName: 'invoice-app' });
  assert.equal(invoice.meta!.openapi!.applied[0]!.path, 'openapi.yaml', 'the later design pass retains the report');
  const registered = await ingestRepo(dir, {
    repoName: 'candidate',
    openapiRegistered: [{ path: 'docs/vendor-api.json', name: 'Registered', phase: 'preview' }],
  });
  assert.equal(registered.meta!.openapi!.applied[0]!.origin, 'settings');
  assert.equal(registered.meta!.openapi!.candidates.length, 0);
  assert.ok(registered.nodes.some((n) => n.kind === 'route' && n.name === 'GET /vendor'));
  assert.ok(registered.nodes.some((n) => n.kind === 'api' && n.name === 'Registered'));
  const ignored = await ingestRepo(dir, {
    repoName: 'candidate',
    openapiRegistered: [{ path: 'docs/vendor-api.json' }],
    openapiIgnored: ['docs/vendor-api.json'],
  });
  assert.equal(ignored.meta!.openapi, undefined);
});
