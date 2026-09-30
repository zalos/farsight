// Pass A of docs/proposals/feedback-response-plan-2026-09.md — the papercuts
// the reference-app consumer hit while wiring design intent into journeys:
// headline precedence, one entry resolver, counts vocabulary, x-* extensions,
// config-declared route gates + their drift, scoped search.
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GraphStore, buildIndex, businessSummary, resolveEntry, search, applyConfig, applyRouteGuards, journey, diffGraphs, changeSentence,
  specOperations, extensionTags, reconcile, applySpecToFragment, specToFragment, apiSurface, contractLines,
} from '../dist/index.js';
import type { GraphNode, GraphEdge, GraphFragment, OpenApiDoc } from '../dist/index.js';

const node = (id: string, kind: GraphNode['kind'], name: string, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, kind, name, tags: [], ...extra }) as GraphNode;
const edge = (kind: GraphEdge['kind'], from: string, to: string, meta?: GraphEdge['meta']): GraphEdge =>
  ({ id: `${kind}|${from}|${to}`, kind, from, to, ...(meta ? { meta } : {}) });

test('businessSummary: @business, then the spec summary, then the first docs sentence — description never outranks summary', () => {
  const route = node('r::route::POST /x', 'route', 'POST /x', {
    docs: 'Long-form description that the spec author wrote second. It goes on.',
    contract: { status: 'spec-only', apiId: 'a', summary: 'Submit an invoice.', description: 'Long-form description that the spec author wrote second. It goes on.' },
  });
  assert.equal(businessSummary(route), 'Submit an invoice.');
  assert.equal(businessSummary({ ...route, facets: { business: { description: 'Authored wins.' } } }), 'Authored wins.');
  assert.equal(businessSummary(node('f', 'function', 'f', { docs: 'First sentence. Second.' })), 'First sentence.');
  assert.equal(businessSummary(node('g', 'function', 'g')), undefined);
});

test('resolveEntry: exact id, else the best runnable hit, honouring repo/group', () => {
  const nodes = [
    node('app::a.ts::submit', 'function', 'submit', { loc: { repo: 'app', path: 'a.ts', line: 1 }, group: 'Submissions' }),
    node('scripts::e2e.ts::submit', 'function', 'submit', { loc: { repo: 'scripts', path: 'e2e.ts', line: 1 }, group: 'E2E' }),
    node('app::table::submissions', 'table', 'submissions', { loc: { repo: 'app', path: 'schema.ts', line: 1 } }),
  ];
  const index = buildIndex(nodes, []);
  assert.equal(resolveEntry(index, 'app::table::submissions')?.id, 'app::table::submissions', 'an exact id wins even for a non-runnable kind');
  assert.equal(resolveEntry(index, 'submit')?.kind, 'function');
  assert.equal(resolveEntry(index, 'submit', { repo: 'scripts' })?.id, 'scripts::e2e.ts::submit');
  assert.equal(resolveEntry(index, 'submit', { group: 'Submissions' })?.id, 'app::a.ts::submit');
  assert.equal(resolveEntry(index, 'nothing-here'), undefined);
  assert.deepEqual(search(index, 'submit', { repo: 'app' }).map((n) => n.id), ['app::a.ts::submit']);
});

test('x-* extensions travel on the contract and scalar ones become tags (never our own x-farsight-* markers)', () => {
  const doc: OpenApiDoc = {
    openapi: '3.1.0', info: { title: 'T' },
    paths: { '/track/{token}': { get: { operationId: 'track', summary: 'Track a submission.', 'x-phase': 2, 'x-internal': true, 'x-owner': { team: 'ops' }, 'x-farsight-inferred': true, 'x-off': false, responses: {} } } },
  } as OpenApiDoc;
  const [op] = specOperations(doc, { repo: 'r', path: 'openapi.yaml' });
  assert.deepEqual(op!.contract.extensions, { 'x-phase': 2, 'x-internal': true, 'x-owner': { team: 'ops' }, 'x-farsight-inferred': true, 'x-off': false });
  assert.deepEqual(extensionTags(op!.contract.extensions), ['phase:2', 'internal']);
  const fragment = specToFragment(doc, { repo: 'r', path: 'openapi.yaml' });
  const route = fragment.nodes.find((n) => n.kind === 'route')!;
  assert.ok(route.tags.includes('phase:2') && route.tags.includes('internal'), route.tags.join(','));
  assert.ok(contractLines(route.contract!).some((l) => l.includes('extensions: x-phase=2')));
});

test('config route guards: a `METHOD /path` matcher declares a gate on the route; drift says when the code enforces nothing', () => {
  const config = { guards: { 'tracking token': ['GET /api/v1/track/{token}'], 'tenant-isolation': ['withTenant'] } };
  const nodes = [
    node('app::route::GET /api/v1/track/:token', 'route', 'GET /api/v1/track/:token', { loc: { repo: 'app', path: 'r.ts', line: 3 } }),
    node('app::route::GET /other', 'route', 'GET /other', { loc: { repo: 'app', path: 'r.ts', line: 9 } }),
    node('app::w.ts::withTenant', 'function', 'withTenant', { loc: { repo: 'app', path: 'w.ts', line: 1 } }),
    node('app::h.ts::handler', 'function', 'handler', { loc: { repo: 'app', path: 'h.ts', line: 1 } }),
  ];
  const edges = [edge('calls', 'app::h.ts::handler', 'app::w.ts::withTenant', { line: 4 })];
  applyConfig(nodes, config, edges);
  // function matcher still works exactly as before
  assert.equal(nodes.find((n) => n.id === 'app::w.ts::withTenant')!.kind, 'guard');
  const wrapper = edges.find((e) => e.kind === 'guards' && e.from === 'app::w.ts::withTenant' && e.to === 'app::h.ts::handler')!;
  assert.ok(wrapper);
  // a config declaration is a declaration: the same stamp applyRouteGuards has always used (B5.1)
  assert.equal(wrapper.resolution?.technique, 'annotation-scan');
  assert.equal(wrapper.resolution?.confidence, 'HIGH');
  // route matcher: one declared guard node, one guards edge, spelled {token} vs :token
  const guard = nodes.find((n) => n.id === 'app::guard::config:tracking token')!;
  assert.ok(guard && guard.kind === 'guard' && guard.tags.includes('declared'));
  assert.equal(edges.filter((e) => e.kind === 'guards' && e.from === guard.id).length, 1);
  assert.equal(applyRouteGuards(nodes, config, edges), 0, 'idempotent');

  // drift: the spec declares no security for the capability URL (it cannot); the config gate is the only one on
  // an implemented route → security-declared-only, and never security-missing-in-spec noise
  const doc: OpenApiDoc = {
    openapi: '3.1.0', info: { title: 'T' }, components: { securitySchemes: { bearer: { type: 'http' } } },
    paths: {
      '/api/v1/track/{token}': { get: { operationId: 'track', responses: {} } },
      '/other': { get: { operationId: 'other', security: [{ bearer: [] }], responses: {} } },
    },
  } as OpenApiDoc;
  const r = reconcile(doc, buildIndex(nodes, edges), { repo: 'app', path: 'openapi.yaml' }, { repo: 'app' });
  const track = r.matched.find((m) => m.op.includes('track'))!;
  assert.deepEqual(track.contract.drift?.map((d) => d.kind), ['security-declared-only']);
  const other = r.matched.find((m) => m.op.includes('other'))!;
  assert.deepEqual(other.contract.drift?.map((d) => d.kind), ['security-missing-in-code']);
});

test('config route guards reach spec-only routes added by the OpenAPI pass (declared gate, no drift — nothing is built yet)', () => {
  const config = { guards: { 'tracking token': ['GET /api/v1/track/{token}'] } };
  const doc: OpenApiDoc = { openapi: '3.1.0', info: { title: 'T' }, paths: { '/api/v1/track/{token}': { get: { operationId: 'track', summary: 'Track.', responses: {} } } } } as OpenApiDoc;
  const fragment: GraphFragment = { repo: 'app', nodes: [node('app::f.ts::f', 'function', 'f', { loc: { repo: 'app', path: 'f.ts', line: 1 } })], edges: [], meta: { files: 1, sourceHash: 'x' } };
  applyConfig(fragment.nodes, config, fragment.edges);
  applySpecToFragment(fragment, doc, { repo: 'app', path: 'openapi.yaml' });
  applyRouteGuards(fragment.nodes, config, fragment.edges);
  const route = fragment.nodes.find((n) => n.kind === 'route')!;
  assert.equal(route.contract?.status, 'spec-only');
  assert.ok(fragment.edges.some((e) => e.kind === 'guards' && e.to === route.id), 'the declared gate sits on the spec-only route');
  const surface = apiSurface(buildIndex(fragment.nodes, fragment.edges))[0]!;
  assert.deepEqual(surface.operations[0]!.gates, ['tracking token']);
  assert.deepEqual(surface.counts, { operations: 1, declared: 1, implemented: 0, notImplemented: 1, undocumented: 0, consumers: 0, drift: 1, gated: 1 });
});

test('apiSurface: a spec-only source is flagged specSource and counts every declared operation as declared', () => {
  const doc: OpenApiDoc = { openapi: '3.1.0', info: { title: 'T' }, paths: { '/a': { get: { responses: {} } }, '/b': { post: { responses: {} } } } } as OpenApiDoc;
  const fragment = specToFragment(doc, { repo: 'spec', path: 'https://api.example.com/openapi.json' });
  const [s] = apiSurface(buildIndex(fragment.nodes, fragment.edges));
  assert.equal(s!.specSource, true);
  assert.deepEqual(s!.counts, { operations: 2, declared: 2, implemented: 0, notImplemented: 2, undocumented: 0, consumers: 0, drift: 0, gated: 0 });
});

// ── Pass B: planned journeys from contracts ──────────────────────────────

test('journey(): a declared route with no code continues as planned steps from its contract, its security as a planned gate', () => {
  const doc: OpenApiDoc = {
    openapi: '3.1.0', info: { title: 'T' }, components: { securitySchemes: { bearer: { type: 'http' } } },
    paths: {
      '/api/v1/submissions/{id}/submit': {
        post: {
          operationId: 'submitSubmission', summary: 'Submit an invoice for review.', description: 'Long form.',
          security: [{ bearer: ['contractor'] }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitRequest' } } } },
          responses: {
            '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Submission' } } } },
            '202': { description: 'queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/Submission' } } } },
            '404': { description: 'missing', content: { 'application/json': { schema: { $ref: '#/components/schemas/Problem' } } } },
          },
        },
      },
    },
  } as OpenApiDoc;
  const fragment = specToFragment(doc, { repo: 'example-app', path: 'docs/api/openapi.yaml' });
  const index = buildIndex(fragment.nodes, fragment.edges);
  const route = fragment.nodes.find((n) => n.kind === 'route')!;
  const j = journey(index, route.id);
  assert.equal(j.plannedCount, 3);
  assert.equal(j.steps.length, 4);
  assert.deepEqual(j.steps[0]!.gates, [{ id: `${route.id}#security:bearer: contractor`, kind: 'guard', name: 'bearer: contractor', planned: true }]);
  assert.deepEqual(j.steps.slice(1).map((s) => [s.via, s.depth, s.nodeId === route.id, s.planned]), [
    ['planned', 1, true, { kind: 'receives', label: 'SubmitRequest', detail: 'required' }],
    ['planned', 1, true, { kind: 'step', label: 'Submit an invoice for review.' }],
    ['planned', 1, true, { kind: 'returns', label: 'Submission', detail: '200' }],
  ], 'receives → step → distinct 2xx payloads; the 404 Problem is not a planned outcome');
  // a route the code implements never gets planned steps, even with a contract
  const built = node('app::route::POST /x', 'route', 'POST /x', { loc: { repo: 'app', path: 'r.ts', line: 1 }, contract: { status: 'both', apiId: 'a', summary: 'X.', security: ['bearer'] } });
  const j2 = journey(buildIndex([built], []), built.id);
  assert.equal(j2.plannedCount, 0);
  assert.deepEqual(j2.steps[0]!.gates, []);
});

test('diffGraphs: planned → built stamps contractStatus on journey_changed; a spec-only text edit alone is not a journey change', () => {
  const declared = (summary: string): GraphNode => node('app::route::POST /submit', 'route', 'POST /submit', {
    tags: ['spec-only'],
    contract: { status: 'spec-only', apiId: 'app::api::openapi.yaml', summary, requestBody: { schema: 'Req' }, responses: [{ status: '200', schema: 'Res' }] },
  });
  const mk = (nodes: GraphNode[], edges: GraphEdge[], sync: number) => {
    const s = new GraphStore();
    s.addFragment({ repo: 'app', nodes, edges });
    s.meta = { sync };
    return s;
  };
  // base: declared only. head: the same route, now implemented and calling a service
  const base = mk([declared('Submit.')], [], 1);
  const handler = node('app::svc.ts::submit', 'function', 'submit', { loc: { repo: 'app', path: 'svc.ts', line: 4 } });
  const builtRoute = node('app::route::POST /submit', 'route', 'POST /submit', { loc: { repo: 'app', path: 'r.ts', line: 9 }, contract: { status: 'both', apiId: 'app::api::openapi.yaml', summary: 'Submit.' } });
  const head = mk([builtRoute, handler], [edge('calls', builtRoute.id, handler.id, { line: 10 })], 2);
  const d = diffGraphs(base, head);
  const jc = d.changes.find((c) => c.kind === 'journey_changed')!;
  assert.ok(jc, 'the route is present in both snapshots and its hop sequence differs');
  assert.deepEqual(jc.contractStatus, { from: 'spec-only', to: 'both' });
  assert.match(changeSentence(jc), /planned → built/);
  // only the summary changed: planned steps are not hops → no journey_changed
  const d2 = diffGraphs(mk([declared('Submit.')], [], 1), mk([declared('Submit an invoice.')], [], 2));
  assert.equal(d2.counts.journey_changed, 0);
});

// route-handler-attribution follow-up: a route inherits its named handler's gates as a
// mirrored `via: 'handler'` edge. The journey must show that gate exactly once — and must
// never lose it because the walk stopped at the route.
test('journey(): a mirrored handler gate shows once, and survives when the walk never reaches the handler', () => {
  const route = node('app::route::GET /session', 'route', 'GET /session', { loc: { repo: 'app', path: 'app/api/session/route.ts', line: 1 } });
  const handler = node('app::app/api/session/route.ts::GET', 'function', 'GET', { loc: { repo: 'app', path: 'app/api/session/route.ts', line: 1 } });
  const guard = node('app::lib/guards.ts::requireContractorSession', 'guard', 'requireContractorSession: contractorSession', { tags: ['auth'] });
  const edges = [
    edge('calls', route.id, handler.id),
    edge('guards', guard.id, handler.id),
    edge('guards', guard.id, route.id, { via: 'handler', handler: handler.id }),
  ];
  const index = buildIndex([route, handler, guard], edges);

  const full = journey(index, route.id);
  assert.deepEqual(full.steps.map((s) => [s.nodeId, s.gates.map((g) => g.id)]), [
    [route.id, []],
    [handler.id, [guard.id]],
  ], 'the handler step carries the gate; the route\'s mirrored copy is dropped');

  // the walk stops at the route: the mirrored gate is the only evidence left, so it stays
  const cut = journey(index, route.id, { maxDepth: 0 });
  assert.deepEqual(cut.steps.map((s) => [s.nodeId, s.gates.map((g) => g.id)]), [[route.id, [guard.id]]]);
  // depth exhaustion is local now: the handler subtree is a cut point, the walk did not "truncate"
  assert.equal(cut.truncated, false, 'only the global step budget truncates a journey');
  assert.deepEqual(cut.cutPoints, [{ reason: 'depth', parentStep: 0, nodeId: handler.id, edgeId: `calls|${route.id}|${handler.id}`, depth: 1 }]);
});

test('journey(): a gate that also reaches the route directly is kept when the handler step drops its mirror', () => {
  const route = node('app::route::GET /session', 'route', 'GET /session');
  const handler = node('app::app/api/session/route.ts::GET', 'function', 'GET');
  const mw = node('app::guard::middleware', 'guard', 'middleware', { tags: ['auth'] });
  const index = buildIndex([route, handler, mw], [
    edge('calls', route.id, handler.id),
    { id: 'g-direct', kind: 'guards', from: mw.id, to: route.id },          // middleware guards the route itself
    edge('guards', mw.id, handler.id),
    { id: 'g-mirror', kind: 'guards', from: mw.id, to: route.id, meta: { via: 'handler', handler: handler.id } }, // and arrives mirrored too
  ]);
  const j = journey(index, route.id);
  assert.deepEqual(j.steps[0]!.gates.map((g) => g.id), [mw.id], 'the direct edge keeps the gate on the route');
});
