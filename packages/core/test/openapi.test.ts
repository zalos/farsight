// OpenAPI surface (docs/proposals/openapi-surface.md): spec → operations,
// reconcile drift cases, ingest-time application, generation round trip,
// cross-source HTTP stitching, the APIs surface and consumers.
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GraphStore, buildIndex, specOperations, reconcile, applySpecToFragment, specToFragment, graphToSpec,
  stitchHttp, apiSurface, consumersOf, fieldsFromSource, normalizeRoutePath, flattenSecurity, driftMarkdown,
} from '../dist/index.js';
import type { GraphNode, GraphEdge, GraphFragment, OpenApiDoc } from '../dist/index.js';

const node = (id: string, kind: GraphNode['kind'], name: string, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, kind, name, tags: [], ...extra }) as GraphNode;
const edge = (kind: GraphEdge['kind'], from: string, to: string, meta?: GraphEdge['meta']): GraphEdge =>
  ({ id: `${kind}|${from}|${to}`, kind, from, to, ...(meta ? { meta } : {}) });
const loc = (path: string, line: number) => ({ repo: 'app', path, line });

/** An invoice-app-shaped fragment: 4 guarded routes, one client per route, one screen. */
function codeFragment(): GraphFragment {
  const nodes: GraphNode[] = [
    node('app::route::GET /invoices', 'route', 'GET /invoices', { loc: loc('routes.ts', 8) }),
    node('app::route::POST /invoices', 'route', 'POST /invoices', { loc: loc('routes.ts', 16), snippet: 'res.status(201).json(x)' }),
    node('app::route::PATCH /invoices/:id', 'route', 'PATCH /invoices/:id', { loc: loc('routes.ts', 21) }),
    node('app::route::POST /invoices/:id/finalize', 'route', 'POST /invoices/:id/finalize', { loc: loc('routes.ts', 26) }),
    node('app::guard::requireScope(billing:read)', 'guard', 'requireScope: billing:read', { tags: ['auth'] }),
    node('app::guard::requireScope(billing:write)', 'guard', 'requireScope: billing:write', { tags: ['auth'] }),
    node('app::rule::draftInvoiceSchema', 'rule', 'draftInvoiceSchema', { loc: loc('schemas.ts', 3), snippet: 'export const draftInvoiceSchema = z.object({ customerId: z.string(), lines: z.array(z.object({ amount: z.number() })) })' }),
    node('app::client.ts::createInvoice', 'function', 'createInvoice', { loc: loc('client.ts', 10), docs: 'Creates a draft invoice.' }),
    node('app::client.ts::listInvoices', 'function', 'listInvoices', { loc: loc('client.ts', 3) }),
    node('app::Form.tsx::CreateInvoiceForm', 'component', 'CreateInvoiceForm', { loc: loc('Form.tsx', 1) }),
    node('app::service.ts::listInvoices', 'function', 'listInvoices', { loc: loc('service.ts', 5), docs: 'Lists invoices, newest first.' }),
  ];
  const edges: GraphEdge[] = [
    edge('guards', 'app::guard::requireScope(billing:read)', 'app::route::GET /invoices'),
    edge('guards', 'app::guard::requireScope(billing:write)', 'app::route::POST /invoices'),
    edge('guards', 'app::guard::requireScope(billing:write)', 'app::route::PATCH /invoices/:id'),
    edge('validates', 'app::rule::draftInvoiceSchema', 'app::route::POST /invoices'),
    edge('http', 'app::client.ts::createInvoice', 'app::route::POST /invoices', { method: 'POST', path: '/invoices', line: 12 }),
    edge('http', 'app::client.ts::listInvoices', 'app::route::GET /invoices', { method: 'GET', path: '/invoices', line: 4 }),
    edge('calls', 'app::Form.tsx::CreateInvoiceForm', 'app::client.ts::createInvoice', { line: 9 }),
    edge('calls', 'app::route::GET /invoices', 'app::service.ts::listInvoices', { line: 9 }),
  ];
  return { repo: 'app', nodes, edges, meta: { files: 4, sourceHash: 'abc' } };
}

/** The matching spec with deliberate drift: DELETE declared only, finalize missing, PATCH scope mismatch. */
function spec(): OpenApiDoc {
  return {
    openapi: '3.1.0',
    info: { title: 'Billing API', version: '1.2.0' },
    servers: [{ url: 'https://billing.example.com/v1' }],
    components: { securitySchemes: { billingAuth: { type: 'oauth2' } }, schemas: { DraftInvoice: { type: 'object', properties: { customerId: {}, lines: {} } } } },
    paths: {
      '/invoices': {
        get: { operationId: 'listInvoices', summary: 'List every invoice.', tags: ['Invoices'], security: [{ billingAuth: ['billing:read'] }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Invoice' } } } } } } },
        post: { operationId: 'createInvoice', summary: 'Draft a new invoice.', tags: ['Invoices'], security: [{ billingAuth: ['billing:write'] }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/DraftInvoice' } } } }, responses: { '201': { description: 'created' } } },
      },
      '/invoices/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        patch: { summary: 'Change a draft.', tags: ['Invoices'], security: [{ billingAuth: ['billing:admin'] }], deprecated: true, responses: { '200': { description: 'ok' } } },
        delete: { summary: 'Discard a draft.', tags: ['Invoices'], security: [{ billingAuth: ['billing:admin'] }], responses: { '204': { description: 'gone' } } },
      },
    },
  };
}

test('normalizeRoutePath unifies {id}, :id and ${id}', () => {
  assert.equal(normalizeRoutePath('/a/{id}/b/:x/c/${y}'), '/a/:param/b/:param/c/:param');
});

test('specOperations: path-level params merge, $ref follows, security flattens, responses/body summarized', () => {
  const ops = specOperations(spec(), { repo: 'app', path: 'openapi.yaml', lineOf: (p, m) => (p === '/invoices' && m === 'get' ? 12 : undefined) });
  assert.deepEqual(ops.map((o) => `${o.method} ${o.path}`), ['GET /invoices', 'POST /invoices', 'PATCH /invoices/{id}', 'DELETE /invoices/{id}']);
  const get = ops[0]!;
  assert.equal(get.contract.spec?.line, 12);
  assert.equal(get.contract.spec?.operationId, 'listInvoices');
  assert.deepEqual(get.contract.security, ['billingAuth: billing:read']);
  assert.deepEqual(get.contract.responses, [{ status: '200', description: 'ok', schema: 'Invoice[]' }]);
  const post = ops[1]!;
  assert.deepEqual(post.contract.requestBody, { contentType: 'application/json', schema: 'DraftInvoice', required: true, fields: ['customerId', 'lines'] });
  const patch = ops[2]!;
  assert.deepEqual(patch.contract.params, [{ name: 'id', in: 'path', required: true, type: 'string' }]);
  assert.equal(patch.contract.deprecated, true);
  assert.deepEqual(flattenSecurity([{}, { bearer: [] }, { oauth2: ['a', 'b'] }]), ['bearer', 'oauth2: a b']);
});

test('reconcile: exact matches, spec-only, code-only, security mismatch, deprecated-in-spec-only', () => {
  const f = codeFragment();
  const r = reconcile(spec(), buildIndex(f.nodes, f.edges), { repo: 'app', path: 'openapi.yaml' }, { repo: 'app' });
  assert.deepEqual(r.counts, { declared: 4, implemented: 4, matched: 3, specOnly: 1, codeOnly: 1, mismatched: 1, drift: 4 });
  assert.deepEqual(r.specOnly.map((s) => s.op), ['DELETE /invoices/{id}']);
  assert.deepEqual(r.codeOnly.map((c) => c.name), ['POST /invoices/:id/finalize']);
  const patch = r.matched.find((m) => m.op === 'PATCH /invoices/{id}')!;
  assert.deepEqual(patch.contract.drift!.map((d) => d.kind).sort(), ['deprecated-in-spec-only', 'security-mismatch']);
  assert.match(patch.contract.drift!.find((d) => d.kind === 'security-mismatch')!.message, /billing:admin.*billing:write/);
  const get = r.matched.find((m) => m.op === 'GET /invoices')!;
  assert.equal(get.contract.status, 'both');
  assert.equal(get.contract.drift, undefined);
  assert.deepEqual(get.contract.servers, ['/v1']);
  assert.deepEqual(r.repos, ['app']);
  const md = driftMarkdown(r);
  assert.match(md, /## declared, not implemented\n- DELETE \/invoices\/\{id\}/);
  assert.match(md, /security-mismatch/);
});

test('reconcile: security gaps in both directions, body-undeclared, base-path matching', () => {
  const f = codeFragment();
  const index = buildIndex(f.nodes, f.edges);
  const doc: OpenApiDoc = {
    openapi: '3.0.3', info: { title: 'T' }, servers: [{ url: '/v1' }],
    components: { securitySchemes: { bearer: { type: 'http' } } },
    paths: {
      // code path is /invoices; spec says /v1/invoices → matched via base path
      '/v1/invoices': { post: { responses: {} } },
      // GET is guarded in code; spec declares nothing (and the doc uses security) → missing-in-spec
      '/invoices': { get: { responses: {} } },
      // finalize is unguarded in code; spec requires bearer → missing-in-code
      '/invoices/{id}/finalize': { post: { security: [{ bearer: [] }], responses: {} } },
    },
  };
  const r = reconcile(doc, index, { repo: 'app', path: 'x.yaml' }, { repo: 'app' });
  const post = r.matched.find((m) => m.op === 'POST /v1/invoices')!;
  assert.equal(post.matchedBy, 'basePath');
  assert.equal(post.routeId, 'app::route::POST /invoices');
  assert.deepEqual(post.contract.drift!.map((d) => d.kind), ['security-missing-in-spec', 'body-undeclared']);
  const get = r.matched.find((m) => m.op === 'GET /invoices')!;
  assert.deepEqual(get.contract.drift!.map((d) => d.kind), ['security-missing-in-spec']);
  const fin = r.matched.find((m) => m.op === 'POST /invoices/{id}/finalize')!;
  assert.deepEqual(fin.contract.drift!.map((d) => d.kind), ['security-missing-in-code']);
  // a spec that never mentions security does not accuse every guarded route
  const quiet = reconcile({ openapi: '3.0.3', info: {}, paths: { '/invoices': { get: { responses: {} } } } }, index, { repo: 'app', path: 'q.yaml' }, { repo: 'app' });
  assert.equal(quiet.matched[0]!.contract.drift, undefined);
});

test('applySpecToFragment: api node + contains edges, contracts on routes, declared-only route added without loc, undocumented tagged', () => {
  const f = codeFragment();
  applySpecToFragment(f, spec(), { repo: 'app', path: 'openapi.yaml' });
  const api = f.nodes.find((n) => n.kind === 'api')!;
  assert.equal(api.id, 'app::api::openapi.yaml');
  assert.equal(api.name, 'Billing API');
  assert.match(api.signature!, /openapi 3\.1\.0 · version 1\.2\.0/);
  const contains = f.edges.filter((e) => e.kind === 'contains' && e.from === api.id).map((e) => e.to).sort();
  assert.deepEqual(contains, [
    'app::route::DELETE /invoices/{id}', 'app::route::GET /invoices', 'app::route::PATCH /invoices/:id',
    'app::route::POST /invoices', 'app::route::POST /invoices/:id/finalize',
  ]);
  const del = f.nodes.find((n) => n.id === 'app::route::DELETE /invoices/{id}')!;
  assert.equal(del.loc, undefined);
  assert.equal(del.contract!.status, 'spec-only');
  assert.ok(del.tags.includes('spec-only') && del.tags.includes('api:invoices'));
  const fin = f.nodes.find((n) => n.id === 'app::route::POST /invoices/:id/finalize')!;
  assert.equal(fin.contract!.status, 'code-only');
  assert.ok(fin.tags.includes('undocumented'));
  const patch = f.nodes.find((n) => n.id === 'app::route::PATCH /invoices/:id')!;
  assert.ok(patch.tags.includes('deprecated'), 'spec deprecation lands as a tag');
  // idempotent: a second application does not duplicate the api node
  applySpecToFragment(f, spec(), { repo: 'app', path: 'openapi.yaml' });
  assert.equal(f.nodes.filter((n) => n.kind === 'api').length, 1);
});

test('specToFragment: a spec with no code yields the api node and declared routes only', () => {
  const f = specToFragment(spec(), { repo: 'billing', path: 'https://billing.example.com/openapi.json' });
  assert.equal(f.nodes.filter((n) => n.kind === 'api').length, 1);
  assert.equal(f.nodes.find((n) => n.kind === 'api')!.loc, undefined, 'a URL source has no file to open');
  const routes = f.nodes.filter((n) => n.kind === 'route');
  assert.equal(routes.length, 4);
  assert.ok(routes.every((r) => r.contract!.status === 'declared' && !r.loc && !r.contract!.drift), 'no code to compare against → declared, no drift');
  assert.ok(routes.every((r) => r.tags.includes('declared') && !r.tags.includes('spec-only')));
});

test('graphToSpec round trip: generate from code → reconcile against the same graph → zero drift; inferences marked', () => {
  const f = codeFragment();
  const index = buildIndex(f.nodes, f.edges);
  const doc = graphToSpec(index, { repo: 'app', meta: { sync: 3, commit: 'abcdef0', tz: 'UTC' } });
  assert.equal(doc.openapi, '3.1.0');
  assert.deepEqual((doc.info as { 'x-farsight': { sync: number; commit: string } })['x-farsight'].sync, 3);
  const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
  assert.deepEqual(Object.keys(paths).sort(), ['/invoices', '/invoices/{id}', '/invoices/{id}/finalize']);
  const post = paths['/invoices']!.post!;
  assert.equal(post['x-farsight-source'], 'routes.ts:16');
  assert.deepEqual(post.security, [{ requireScope: ['billing:write'] }]);
  assert.deepEqual(post.requestBody, { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/draftInvoiceSchema' } } } });
  assert.deepEqual(Object.keys(post.responses as object), ['201'], 'status lifted from res.status(201) in the snippet');
  assert.deepEqual(post['x-farsight-inferred'], ['responses']);
  const get = paths['/invoices']!.get!;
  assert.equal(get.summary, 'Lists invoices, newest first.', 'summary falls back to the handler the route calls');
  assert.deepEqual((doc.components as { schemas: Record<string, { properties: object }> }).schemas.draftInvoiceSchema!.properties, { customerId: {}, lines: {} });
  const r = reconcile(doc, index, { repo: 'app', path: 'generated' }, { repo: 'app' });
  assert.equal(r.counts.drift, 0);
  assert.equal(r.counts.matched, 4);
});

test('graphToSpec keeps an existing contract: array responses become array schemas, spec tags win', () => {
  const f = codeFragment();
  applySpecToFragment(f, spec(), { repo: 'app', path: 'openapi.yaml' });
  const doc = graphToSpec(buildIndex(f.nodes, f.edges), { repo: 'app' });
  const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
  const get = paths['/invoices']!.get!;
  assert.deepEqual((get.responses as Record<string, { content: { 'application/json': { schema: unknown } } }>)['200']!.content['application/json'].schema, { type: 'array', items: { $ref: '#/components/schemas/Invoice' } });
  assert.deepEqual(get.tags, ['Invoices']);
  assert.deepEqual(paths['/invoices/{id}/finalize']!.post!.tags, ['Invoices'], 'an undocumented route reuses the spec tag its path segment matches');
  assert.equal(doc.info!.title, 'Billing API');
  assert.equal(doc.info!.version, '1.2.0');
  assert.equal(paths['/invoices/{id}']!.delete, undefined, 'declared-only operations are not claimed as implemented');
});

test('fieldsFromSource: zod object keys and Java DTO fields', () => {
  assert.deepEqual(fieldsFromSource('const s = z.object({ a: z.string(), b: z.object({ c: z.number() }).optional(), d: z.array(z.string()) })'), ['a', 'b', 'd']);
  assert.deepEqual(fieldsFromSource('public class Dto { private String customerId; private List<Line> lines = new ArrayList<>(); }'), ['customerId', 'lines']);
  assert.equal(fieldsFromSource('nothing here'), undefined);
});

test('stitchHttp: unknown stubs resolve across sources (MEDIUM), ambiguity stays unresolved, orphan stubs are dropped', () => {
  const store = new GraphStore();
  // web repo: a client that fetches two paths nobody local serves
  store.addFragment({
    repo: 'web',
    nodes: [
      node('web::api.ts::load', 'function', 'load', { loc: { repo: 'web', path: 'api.ts', line: 1 } }),
      node('web::unknown::GET /api/invoices', 'unknown', 'GET /api/invoices', { tags: ['http', 'unresolved'] }),
      node('web::unknown::GET /shared', 'unknown', 'GET /shared', { tags: ['http', 'unresolved'] }),
      node('web::unknown::GET /nowhere', 'unknown', 'GET /nowhere', { tags: ['http', 'unresolved'] }),
    ],
    edges: [
      { ...edge('http', 'web::api.ts::load', 'web::unknown::GET /api/invoices', { method: 'GET', path: '/api/invoices', line: 2 }), resolution: { status: 'unresolved', technique: 'fetch→route', confidence: 'LOW', candidates: [] } },
      { ...edge('http', 'web::api.ts::load', 'web::unknown::GET /shared', { method: 'GET', path: '/shared' }), resolution: { status: 'unresolved', technique: 'fetch→route', confidence: 'LOW', candidates: [] } },
      { ...edge('http', 'web::api.ts::load', 'web::unknown::GET /nowhere', { method: 'GET', path: '/nowhere' }), resolution: { status: 'unresolved', technique: 'fetch→route', confidence: 'LOW', candidates: [] } },
    ],
  });
  // a Spring repo serves /api/invoices; a spec-only source serves /invoices under base path /api too (alias); two repos serve /shared
  store.addFragment({ repo: 'spring', nodes: [node('spring::route::GET /api/invoices', 'route', 'GET /api/invoices', { loc: { repo: 'spring', path: 'C.java', line: 3 } }), node('spring::route::GET /shared', 'route', 'GET /shared', { loc: { repo: 'spring', path: 'S.java', line: 3 } })], edges: [] });
  store.addFragment({ repo: 'other', nodes: [node('other::route::GET /shared', 'route', 'GET /shared', { loc: { repo: 'other', path: 'o.ts', line: 3 } })], edges: [] });
  const report = stitchHttp(store);
  assert.deepEqual(report, { resolved: 1, ambiguous: 1, unresolved: 1 });
  const edges = store.allEdges().filter((e) => e.kind === 'http');
  const stitched = edges.find((e) => e.to === 'spring::route::GET /api/invoices')!;
  assert.equal(stitched.resolution!.confidence, 'MEDIUM');
  assert.equal(stitched.resolution!.status, 'resolved');
  assert.equal(stitched.meta!.line, 2, 'call-site line survives re-targeting');
  const amb = edges.find((e) => e.to === 'web::unknown::GET /shared')!;
  assert.deepEqual(amb.resolution!.candidates!.sort(), ['other::route::GET /shared', 'spring::route::GET /shared']);
  assert.equal(store.nodeById('web::unknown::GET /api/invoices'), undefined, 'resolved stub removed');
  assert.ok(store.nodeById('web::unknown::GET /shared'), 'ambiguous stub kept');
  assert.ok(store.nodeById('web::unknown::GET /nowhere'), 'unresolved stub kept — the "?" is the honest answer');
});

test('stitchHttp treats a leading :param (templated host) as a host wildcard', () => {
  const store = new GraphStore();
  store.addFragment({ repo: 'web', nodes: [node('web::a.ts::f', 'function', 'f'), node('web::unknown::GET :param/healthz', 'unknown', 'GET :param/healthz')], edges: [edge('http', 'web::a.ts::f', 'web::unknown::GET :param/healthz', { method: 'GET', path: ':param/healthz' })] });
  store.addFragment({ repo: 'svc', nodes: [node('svc::route::GET /healthz', 'route', 'GET /healthz', { loc: { repo: 'svc', path: 's.ts', line: 1 } })], edges: [] });
  assert.equal(stitchHttp(store).resolved, 1);
  assert.ok(store.allEdges().some((e) => e.kind === 'http' && e.to === 'svc::route::GET /healthz'));
});

test('stitchHttp honours spec server base paths: fetch("/v1/x") reaches a declared "/x"', () => {
  const store = new GraphStore();
  store.addFragment(specToFragment({ openapi: '3.0.0', info: { title: 'S' }, servers: [{ url: 'https://h/v1' }], paths: { '/x': { get: { responses: {} } } } }, { repo: 'svc', path: 'https://h/openapi.json' }));
  store.addFragment({ repo: 'web', nodes: [node('web::a.ts::f', 'function', 'f'), node('web::unknown::GET /v1/x', 'unknown', 'GET /v1/x')], edges: [edge('http', 'web::a.ts::f', 'web::unknown::GET /v1/x', { method: 'GET', path: '/v1/x' })] });
  assert.equal(stitchHttp(store).resolved, 1);
  assert.ok(store.allEdges().some((e) => e.kind === 'http' && e.to === 'svc::route::GET /x'));
});

test('apiSurface + consumersOf: spec-backed and implied surfaces, counts, consumers with screens', () => {
  const f = codeFragment();
  applySpecToFragment(f, spec(), { repo: 'app', path: 'openapi.yaml' });
  // a second repo with a route and no spec → implied surface
  f.nodes.push(node('svc::route::GET /health', 'route', 'GET /health', { loc: { repo: 'svc', path: 'h.ts', line: 1 } }));
  const index = buildIndex(f.nodes, f.edges);
  const apis = apiSurface(index);
  assert.deepEqual(apis.map((a) => [a.id, a.kind]), [['app::api::openapi.yaml', 'spec'], ['svc::api::implemented', 'implied']]);
  const billing = apis[0]!;
  assert.equal(billing.version, '1.2.0');
  assert.deepEqual(billing.counts, { operations: 5, declared: 4, implemented: 4, notImplemented: 1, undocumented: 1, consumers: 2, drift: 4, gated: 3 });
  assert.equal(billing.specSource, undefined, "a spec with code behind it is not a spec-only source");
  const post = billing.operations.find((o) => o.routeId === 'app::route::POST /invoices')!;
  assert.equal(post.summary, 'Draft a new invoice.', 'the spec summary is the business text for a route with no docs');
  assert.deepEqual(post.gates, ['requireScope: billing:write']);
  // scope filter
  const implied = apiSurface(index, new Set(['svc']));
  assert.deepEqual(implied.map((a) => a.id), ['svc::api::implemented']);
  assert.equal(implied[0]!.operations[0]!.status, 'implemented', 'no spec at all is not "undocumented" per route');
  assert.equal(implied[0]!.counts.undocumented, 0);
  const consumers = consumersOf(index, 'app::route::POST /invoices');
  assert.equal(consumers.length, 1);
  assert.equal(consumers[0]!.caller.name, 'createInvoice');
  assert.equal(consumers[0]!.line, 12);
  assert.equal(consumers[0]!.crossRepo, false);
  assert.deepEqual(consumers[0]!.screens.map((s) => s.name), ['CreateInvoiceForm']);
});
