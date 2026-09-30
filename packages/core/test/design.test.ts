// Design source (docs/proposals/design-source.md): manifest → design node,
// reconcile against pages (route spellings, operations reached), ingest-time
// application, the surface, screensFor, and design-only screens journeying
// through planned calls. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndex, journey, journeySummary, screenRouteKey, figmaFileKey, figmaNodeId, isDesignManifest,
  reconcileDesign, applyDesignToFragment, designToFragment, designSurface, screensFor, designDriftMarkdown, applySpecToFragment,
} from '../dist/index.js';
import type { GraphNode, GraphEdge, GraphFragment, DesignManifest, OpenApiDoc } from '../dist/index.js';
import { buildInfo, buildLine } from '../dist/index.js';

const node = (id: string, kind: GraphNode['kind'], name: string, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, kind, name, tags: [], ...extra }) as GraphNode;
const edge = (kind: GraphEdge['kind'], from: string, to: string, meta?: GraphEdge['meta']): GraphEdge =>
  ({ id: `${kind}|${from}|${to}`, kind, from, to, ...(meta ? { meta } : {}) });
const loc = (path: string, line: number) => ({ repo: 'app', path, line });

/** Two pages (one reaching listInvoices, one reaching nothing), a component, and a spec with three operations. */
function fragment(): GraphFragment {
  const nodes: GraphNode[] = [
    node('app::page::/invoices', 'page', '/invoices', { loc: loc('router.tsx', 8) }),
    node('app::page::/invoices/:param/edit', 'page', '/invoices/:param/edit', { loc: loc('router.tsx', 10) }),
    node('app::List.tsx::InvoiceList', 'component', 'InvoiceList', { loc: loc('List.tsx', 1) }),
    node('app::client.ts::listInvoices', 'function', 'listInvoices', { loc: loc('client.ts', 3) }),
    node('app::route::GET /invoices', 'route', 'GET /invoices', { loc: loc('routes.ts', 8) }),
  ];
  const edges: GraphEdge[] = [
    edge('renders', 'app::page::/invoices', 'app::List.tsx::InvoiceList', { line: 8 }),
    edge('calls', 'app::List.tsx::InvoiceList', 'app::client.ts::listInvoices', { line: 5 }),
    edge('http', 'app::client.ts::listInvoices', 'app::route::GET /invoices', { method: 'GET', path: '/invoices', line: 4 }),
  ];
  const f: GraphFragment = { repo: 'app', nodes, edges, meta: { files: 5, sourceHash: 'x' } };
  const spec: OpenApiDoc = {
    openapi: '3.1.0', info: { title: 'Billing' },
    paths: {
      '/invoices': { get: { operationId: 'listInvoices', summary: 'List invoices.', responses: {} }, post: { operationId: 'createInvoice', summary: 'Draft an invoice.', security: [{ bearer: ['billing:write'] }], responses: { '201': { description: 'created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Invoice' } } } } } } },
      '/invoices/{id}': { delete: { operationId: 'deleteInvoice', summary: 'Discard a draft invoice.', security: [{ bearer: ['billing:admin'] }], responses: {} } },
    },
  } as OpenApiDoc;
  applySpecToFragment(f, spec, { repo: 'app', path: 'openapi.yaml' });
  return f;
}

const manifest: DesignManifest = {
  name: 'Invoice screens',
  figma: { file: 'https://www.figma.com/design/ABC123/Invoice' },
  screens: [
    { id: 'INV-01', name: 'Invoice list', route: '/invoices', nodeId: '1:2', image: 'docs/design/inv-01.svg', operations: ['listInvoices'], phase: '1' },
    { id: 'INV-02', name: 'Edit', route: '/invoices/[id]/edit', operations: ['getInvoice', 'listInvoices'] },
    { id: 'INV-03', name: 'Discard', route: '/invoices/{id}/discard', url: 'https://www.figma.com/design/ABC123/Invoice?node-id=1-4', operations: ['deleteInvoice'], description: 'Confirm and discard.' },
    { id: 'INV-04', name: 'Orphan row' },
  ],
};

test('manifest helpers: route spellings normalize, Figma keys/nodes parse, shape check', () => {
  assert.equal(screenRouteKey('/track/[token]'), '/track/:param');
  assert.equal(screenRouteKey('track/{token}/'), '/track/:param');
  assert.equal(screenRouteKey('/(ops)/ops/invoices/:id'), '/ops/invoices/:param');
  assert.equal(figmaFileKey('https://www.figma.com/design/N2ha2Cj4/File?node-id=1-2'), 'N2ha2Cj4');
  assert.equal(figmaNodeId('https://www.figma.com/design/N2ha2Cj4/File?node-id=26-9'), '26-9');
  assert.equal(figmaNodeId('https://www.figma.com/design/N2ha2Cj4/File?node-id=26%3A9'), '26-9');
  assert.equal(isDesignManifest({ screens: [] }), false);
  assert.equal(isDesignManifest({ screens: [{ id: 'A' }] }), true);
});

test('reconcileDesign: built / not built / undesigned, operation drift on built screens, unmatched rows kept', () => {
  const f = fragment();
  const r = reconcileDesign(manifest, buildIndex(f.nodes, f.edges), { repo: 'app', path: 'docs/design/screens.json' });
  assert.deepEqual(r.counts, { screens: 4, built: 2, designOnly: 1, codeOnly: 0, unmatched: 1, drift: 3 });
  const list = r.matched.find((m) => m.screen.id === 'INV-01')!;
  assert.deepEqual(list.drift, [], 'the list page reaches exactly the operation the design lists');
  const edit = r.matched.find((m) => m.screen.id === 'INV-02')!;
  assert.deepEqual(edit.drift.map((d) => d.kind), ['operation-not-in-spec', 'operation-unreached'], 'getInvoice is in no contract; listInvoices is declared but the edit page never reaches it');
  assert.equal(r.designOnly[0]!.screen.id, 'INV-03');
  assert.equal(r.designOnly[0]!.nodeId, 'app::page::/invoices/:param/discard');
  assert.deepEqual(r.designOnly[0]!.drift.map((d) => d.kind), ['design-only']);
  assert.equal(r.unmatched[0]!.id, 'INV-04');
  assert.match(designDriftMarkdown(r), /designed, not built[\s\S]*INV-03/);
});

test('applyDesignToFragment: design node + contains edges; matched pages gain design, unbuilt screens become pages with no loc, extra pages are stamped code-only', () => {
  const f = fragment();
  f.nodes.push(node('app::page::/settings', 'page', '/settings', { loc: loc('router.tsx', 12) }));
  applyDesignToFragment(f, manifest, { repo: 'app', path: 'docs/design/screens.json', lastModified: '2026-09-01T00:00:00Z', freshness: 'figma' });
  const design = f.nodes.find((n) => n.kind === 'design')!;
  assert.equal(design.id, 'app::design::docs/design/screens.json');
  assert.deepEqual(design.links, [{ kind: 'design', url: 'https://www.figma.com/design/ABC123/Invoice' }]);
  const list = f.nodes.find((n) => n.id === 'app::page::/invoices')!;
  assert.equal(list.design?.status, 'both');
  assert.equal(list.design?.nodeId, '1-2', 'Figma node ids normalize 1:2 → 1-2');
  assert.equal(list.design?.url, 'https://www.figma.com/design/ABC123/Invoice?node-id=1-2', 'a url is derived from the file + node id');
  assert.deepEqual(list.design?.image, { kind: 'file', path: 'docs/design/inv-01.svg' });
  assert.equal(list.design?.freshness, 'figma');
  assert.ok(list.tags.includes('design:inv-01'));
  const discard = f.nodes.find((n) => n.id === 'app::page::/invoices/:param/discard')!;
  assert.equal(discard.kind, 'page');
  assert.equal(discard.loc, undefined);
  assert.equal(discard.design?.status, 'design-only');
  assert.deepEqual(discard.design?.image, { kind: 'figma' }, 'a Figma node with no file image is a Figma render reference');
  assert.equal(discard.facets?.business?.label, 'Discard');
  assert.ok(discard.tags.includes('design-only'));
  const settings = f.nodes.find((n) => n.id === 'app::page::/settings')!;
  assert.equal(settings.design?.status, 'code-only');
  assert.ok(settings.tags.includes('undesigned'));
  const contains = f.edges.filter((e) => e.kind === 'contains' && e.from === design.id).map((e) => e.to).sort();
  assert.deepEqual(contains, ['app::page::/invoices', 'app::page::/invoices/:param/discard', 'app::page::/invoices/:param/edit', 'app::page::/settings']);
  // idempotent on re-application
  const before = f.nodes.length + f.edges.length;
  applyDesignToFragment(f, manifest, { repo: 'app', path: 'docs/design/screens.json' });
  assert.equal(f.nodes.length + f.edges.length, before);
});

test('designSurface + screensFor: rows in id order with counts; the SCREEN band is the entry or the pages upstream', () => {
  const f = fragment();
  applyDesignToFragment(f, manifest, { repo: 'app', path: 'docs/design/screens.json' });
  const index = buildIndex(f.nodes, f.edges);
  const [d] = designSurface(index);
  assert.equal(d!.name, 'Invoice screens');
  assert.deepEqual(d!.counts, { screens: 3, designed: 3, built: 2, designOnly: 1, codeOnly: 0, drift: 3, flows: 0 });
  assert.deepEqual(d!.screens.map((s) => [s.designId, s.status, s.hasImage]), [['INV-01', 'both', true], ['INV-02', 'both', false], ['INV-03', 'design-only', true]]);
  assert.deepEqual(designSurface(index, new Set(['other'])), [], 'scope filters by repo');
  assert.deepEqual(screensFor(index, 'app::page::/invoices').map((n) => n.id), ['app::page::/invoices']);
  assert.deepEqual(screensFor(index, 'app::route::GET /invoices').map((n) => n.id), ['app::page::/invoices', 'app::List.tsx::InvoiceList'], 'pages first, then components, walking upstream over http/calls/renders');
  assert.deepEqual(screensFor(index, 'app::route::DELETE /invoices/{id}'), []);
});

test('journey(): a designed, unbuilt screen continues as planned calls into the real routes, which then run their own planned steps', () => {
  const f = fragment();
  applyDesignToFragment(f, manifest, { repo: 'app', path: 'docs/design/screens.json' });
  const index = buildIndex(f.nodes, f.edges);
  const j = journey(index, 'app::page::/invoices/:param/discard');
  assert.equal(j.plannedCount, 2);
  assert.deepEqual(j.steps.map((s) => [s.via, s.depth, s.nodeId, s.planned?.kind, s.planned?.label]), [
    ['entry', 0, 'app::page::/invoices/:param/discard', undefined, undefined],
    ['planned', 1, 'app::route::DELETE /invoices/{id}', 'calls', 'deleteInvoice'],
    ['planned', 2, 'app::route::DELETE /invoices/{id}', 'step', 'Discard a draft invoice.'],
  ]);
  assert.deepEqual(j.steps[1]!.gates.map((g) => [g.name, g.planned]), [['bearer: billing:admin', true]]);
  // a design-only source (manifest, no code at all): every screen designed, not built; journeys are planned end to end
  const alone = designToFragment(manifest, { repo: 'design', path: 'screens.json' });
  assert.equal(alone.nodes.filter((n) => n.kind === 'page').length, 3);
  assert.ok(alone.nodes.filter((n) => n.kind === 'page').every((n) => n.design?.status === 'design-only'));
});

test('flows: a named feature becomes a flow node rendering its screens in order; journey walks screen by screen; drift on unknown screens', () => {
  const f = fragment();
  const withFlows: DesignManifest = {
    ...manifest,
    flows: [
      { id: 'draft', name: 'Draft and discard', description: 'Draft, review, discard.', screens: ['INV-01', 'INV-03', 'NOPE'], docs: ['docs/flows.md', 'https://example.com/adr-1'], operations: ['listInvoices', 'ghostOp'], phase: '1' },
    ],
  };
  const r = reconcileDesign(withFlows, buildIndex(f.nodes, f.edges), { repo: 'app', path: 'docs/design/screens.json' });
  assert.equal(r.flows.length, 1);
  assert.equal(r.flows[0]!.built, 1);
  assert.deepEqual(r.flows[0]!.screenNodeIds, ['app::page::/invoices', 'app::page::/invoices/:param/discard']);
  assert.deepEqual(r.flows[0]!.drift.map((d) => d.kind), ['screen-unknown', 'operation-not-in-spec']);
  assert.match(designDriftMarkdown(r), /## flows[\s\S]*1 of 3 screens built/);

  applyDesignToFragment(f, withFlows, { repo: 'app', path: 'docs/design/screens.json' });
  const index = buildIndex(f.nodes, f.edges);
  const flow = index.byId.get('app::flow::draft')!;
  assert.equal(flow.kind, 'flow');
  assert.ok(flow.tags.includes('entrypoint') && flow.tags.includes('flow'));
  assert.deepEqual(flow.links, [{ kind: 'doc', ref: 'docs/flows.md' }, { kind: 'see', url: 'https://example.com/adr-1' }]);
  assert.equal(flow.design?.status, 'design-only', 'not every screen is built');
  const [d] = designSurface(index);
  assert.deepEqual(d!.flows.map((x) => [x.id, x.built, x.total, x.status, x.screens]), [['draft', 1, 2, 'design-only', ['INV-01', 'INV-03']]]);
  // the surface carries each document's own title beside its path when ingest read one (R21);
  // `docs` stays the bare refs, so a consumer written before titles existed still works
  assert.deepEqual(d!.flows[0]!.docs, ['docs/flows.md', 'https://example.com/adr-1']);
  assert.deepEqual(d!.flows[0]!.docLinks, [{ kind: 'doc', ref: 'docs/flows.md' }, { kind: 'see', url: 'https://example.com/adr-1' }]);
  index.byId.get('app::flow::draft')!.links![0]!.title = 'Flows of the invoice app';
  assert.equal(designSurface(buildIndex(f.nodes, f.edges))[0]!.flows[0]!.docLinks[0]!.title, 'Flows of the invoice app');
  assert.equal(d!.counts.flows, 1);
  assert.deepEqual(screensFor(index, flow.id).map((n) => n.id), ['app::page::/invoices', 'app::page::/invoices/:param/discard'], 'the SCREEN band keeps the flow order');
  const j = journey(index, flow.id);
  const walk = j.steps.map((s) => [s.depth, s.via, s.nodeId]);
  assert.deepEqual(walk[0], [0, 'entry', 'app::flow::draft']);
  assert.deepEqual(walk[1], [1, 'renders', 'app::page::/invoices']);
  assert.ok(walk.some((w) => w[1] === 'http' && w[2] === 'app::route::GET /invoices'), 'the built screen continues into its real code and HTTP call');
  const discardAt = walk.findIndex((w) => w[1] === 'renders' && w[2] === 'app::page::/invoices/:param/discard');
  assert.ok(discardAt > 1, 'the second screen follows the first screen\'s whole walk');
  assert.deepEqual(walk[discardAt + 1]!.slice(1), ['planned', 'app::route::DELETE /invoices/{id}'], 'the unbuilt screen continues as a planned call');
  assert.equal(j.plannedCount, 2);
});

test('the manifest can say who a flow is for, who owns it, what steps a screen has, and what surfaces exist — and an older manifest without any of it still parses', () => {
  const f = fragment();
  const richer: DesignManifest = {
    ...manifest,
    screens: manifest.screens.map((sc) => (sc.id === 'INV-01'
      ? { ...sc, steps: [{ id: 'INV-01.1', name: 'Pick a customer' }, { id: 'INV-01.2', name: 'Add the lines', operation: 'listInvoices' }] }
      : sc)),
    flows: [{ id: 'draft', name: 'Draft and discard', screens: ['INV-01', 'INV-03'], persona: 'biller', owner: 'Billing team' }],
    surfaces: [
      { id: 'portal', name: 'Customer portal', status: 'partly built' },
      { id: 'admin', name: 'Admin console', status: 'not started', description: 'Nobody has drawn it yet.' },
    ],
  };
  applyDesignToFragment(f, richer, { repo: 'app', path: 'docs/design/screens.json' });
  const index = buildIndex(f.nodes, f.edges);

  const flow = index.byId.get('app::flow::draft')!;
  assert.equal(flow.design?.persona, 'biller');
  assert.equal(flow.design?.owner, 'Billing team');
  const screen = index.byId.get('app::page::/invoices')!;
  assert.deepEqual(screen.design?.steps?.map((st) => st.id), ['INV-01.1', 'INV-01.2'], 'the screen keeps the numbered steps its tests name');

  const [d] = designSurface(index);
  assert.equal(d!.flows[0]!.persona, 'biller');
  assert.equal(d!.flows[0]!.owner, 'Billing team');
  assert.deepEqual(d!.surfaces.map((x) => [x.id, x.status]), [['portal', 'partly built'], ['admin', 'not started']],
    'a surface nobody has drawn is still a row — the front door shows it rather than leaving the reader to infer it');

  // the same manifest without any of the new fields: nothing invented, nothing thrown
  const plain = fragment();
  applyDesignToFragment(plain, manifest, { repo: 'app', path: 'docs/design/screens.json' });
  const pi = buildIndex(plain.nodes, plain.edges);
  const [pd] = designSurface(pi);
  assert.deepEqual(pd!.surfaces, []);
  assert.equal(pi.byId.get('app::page::/invoices')!.design?.steps, undefined);
  assert.equal(pd!.flows.length, 0);
});

test('journeySummary: the three bands — screens in order, business docs/gates/rules/decisions, the system timeline with records & messages', () => {
  const f = fragment();
  const withFlows: DesignManifest = { ...manifest, flows: [{ id: 'draft', name: 'Draft and discard', description: 'Draft, review, discard.', screens: ['INV-01', 'INV-03'], docs: ['docs/flows.md'] }] };
  applyDesignToFragment(f, withFlows, { repo: 'app', path: 'docs/design/screens.json' });
  // a guard on the built route + a table it reads, so the bands have something to say
  f.nodes.push(node('app::guard::requireScope(billing:read)', 'guard', 'requireScope: billing:read', { tags: ['auth'] }));
  f.nodes.push(node('app::table::invoices', 'table', 'invoices'));
  f.edges.push(edge('guards', 'app::guard::requireScope(billing:read)', 'app::route::GET /invoices'));
  f.edges.push(edge('reads', 'app::route::GET /invoices', 'app::table::invoices', { line: 9 }));
  const index = buildIndex(f.nodes, f.edges);
  const j = journey(index, 'app::flow::draft');
  const sum = journeySummary(index, j, screensFor(index, 'app::flow::draft'));
  assert.equal(sum.entry.name, 'Draft and discard');
  assert.equal(sum.business.description, 'Draft, review, discard.');
  assert.deepEqual(sum.user.map((u) => [u.designId, u.designStatus, u.hasImage, u.components.length]), [['INV-01', 'both', true, 1], ['INV-03', 'design-only', true, 0]]);
  assert.deepEqual(sum.business.docs, [{ kind: 'doc', ref: 'docs/flows.md' }]);
  assert.deepEqual(sum.business.gates.map((g) => [g.name, g.planned ?? false]), [['requireScope: billing:read', false], ['bearer: billing:admin', true]]);
  assert.deepEqual(sum.system.records, [{ id: 'app::table::invoices', name: 'invoices', ops: ['reads'] }]);
  const kinds = sum.system.timeline.map((t) => t.kind);
  assert.deepEqual(kinds.slice(0, 6), ['screen', 'screen', 'screen', 'step', 'gate', 'call'], 'flow → page → component → client fn → the gate row before the route call it guards');
  assert.ok(kinds.includes('record') && kinds.includes('planned'));
  // checks = gate occurrences (the two gates, met once each); setup/deferred = the boot and the
  // work that runs afterwards, neither of which this journey has (A1.7).
  // called / declaredNotCalled: INV-01 is built and its action calls the route, INV-03 is
  // designed and not built, so its operation is a contract-derived planned step that no code
  // performs. Counting both actions as *called* is how a flow with nothing built printed
  // `7 called` for seven operations no code implements (swarm 2026-09-23, blocker 1).
  assert.deepEqual(sum.counts, { screens: 2, steps: 7, planned: 2, gates: 2, checks: 2, decisions: 0, records: 1, messages: 0, segments: 2, cutPoints: 0, repeats: 0, setup: 0, deferred: 0, called: 1, again: 0, declaredNotCalled: 1, choices: 0 }, 'nothing was cut: no subtree hit the depth or re-visit budget');
  // the discriminator itself, so a reader of this test sees which action is which
  const acts = sum.segments.flatMap((sg) => sg.moments.filter((mo) => mo.callStep != null));
  assert.equal(acts.length, 2, 'both screens open one action');
  assert.deepEqual(
    acts.map((mo) => j.steps.find((st) => st.order === mo.callStep)!.via),
    ['http', 'planned'],
    'the built screen calls; the designed-not-built screen has a planned continuation and calls nothing',
  );
});

test('a flow whose every action is a planned step calls nothing: called is 0, and the operations are declared', () => {
  // the reference app's ops-review flow printed `7 called` for seven operations its own API
  // answer calls `[spec-only] … (no source: declared only)`, because every action
  // of a designed-but-unbuilt screen counted as a call (swarm 2026-09-23,
  // blocker 1). INV-03 is design-only, so its `deleteInvoice` action is a
  // contract-derived planned step: declared, and performed by nothing.
  const f = fragment();
  const onlyUnbuilt: DesignManifest = { ...manifest, flows: [{ id: 'discard', name: 'Discard a draft', screens: ['INV-03'] }] };
  applyDesignToFragment(f, onlyUnbuilt, { repo: 'app', path: 'docs/design/screens.json' });
  const index = buildIndex(f.nodes, f.edges);
  const j = journey(index, 'app::flow::discard');
  const sum = journeySummary(index, j, screensFor(index, 'app::flow::discard'));
  assert.ok(sum.segments.flatMap((sg) => sg.moments).length > 0, 'the flow does open an action');
  assert.equal(sum.counts.called, 0, 'no code in this flow calls anything');
  assert.equal(sum.counts.declaredNotCalled, 1, 'and the one operation it names is declared, not called');
  assert.equal(sum.counts.again, 0, 'nothing is called twice, so nothing runs again');
});

test('journeySummary segments: one per screen over system rows; a rendered component is a moment of its screen, not a segment; gates dedupe per segment; planned rows stay dashed', () => {
  const f = fragment();
  const withFlows: DesignManifest = { ...manifest, flows: [{ id: 'draft', name: 'Draft and discard', screens: ['INV-01', 'INV-03'] }] };
  applyDesignToFragment(f, withFlows, { repo: 'app', path: 'docs/design/screens.json' });
  f.nodes.push(node('app::guard::requireScope(billing:read)', 'guard', 'requireScope: billing:read', { tags: ['auth'] }));
  f.nodes.push(node('app::table::invoices', 'table', 'invoices'));
  f.edges.push(edge('guards', 'app::guard::requireScope(billing:read)', 'app::route::GET /invoices'));
  f.edges.push(edge('reads', 'app::route::GET /invoices', 'app::table::invoices', { line: 9 }));
  const index = buildIndex(f.nodes, f.edges);
  const sum = journeySummary(index, journey(index, 'app::flow::draft'), screensFor(index, 'app::flow::draft'));
  assert.deepEqual(sum.segments.map((sg) => sg.screen?.designId), ['INV-01', 'INV-03']);
  const [s1, s2] = sum.segments;
  // the built screen: component → client fn (repo row), the route call (api row), the record (records row)
  assert.deepEqual(s1!.markers.map((m) => [m.kind, m.name, m.system, m.planned ?? false]), [
    ['step', 'InvoiceList', 'repo:app:ux', false], ['step', 'listInvoices', 'repo:app:ux', false],
    ['call', 'GET /invoices', 'api:app::api::openapi.yaml', false], ['record', 'invoices', 'records', false],
  ]);
  assert.deepEqual(s1!.markers[2], { ...s1!.markers[2], method: 'GET', path: '/invoices' });
  assert.deepEqual(s1!.gates.map((g) => [g.kind, g.name, g.count]), [['guard', 'requireScope: billing:read', 1]]);
  assert.deepEqual(s1!.systems, ['repo:app:ux', 'api:app::api::openapi.yaml', 'records']);
  // the designed-only screen: its planned call into the real (declared) route, dashed
  assert.deepEqual(s2!.markers.map((m) => [m.kind, m.name, m.system, m.planned ?? false]), [['call', 'DELETE /invoices/{id}', 'api:app::api::openapi.yaml', true]]);
  assert.deepEqual(s2!.gates.map((g) => [g.name, g.planned ?? false]), [['bearer: billing:admin', true]]);
  assert.deepEqual(sum.systems.map((r) => [r.key, r.kind, r.planned]), [['repo:app:ux', 'repo', false], ['api:app::api::openapi.yaml', 'api', false], ['records', 'records', false]]);
  assert.equal(sum.counts.segments, 2);
  // a page entry: its components are markers in the one segment, never segments of their own
  const page = journeySummary(index, journey(index, 'app::page::/invoices'), screensFor(index, 'app::page::/invoices'));
  assert.equal(page.segments.length, 1);
  assert.equal(page.segments[0]!.screen?.id, 'app::page::/invoices');
  assert.equal(page.segments[0]!.markers[0]!.name, 'InvoiceList');
  // a route entry: no screen → segment 0 has no screen, the steps still land in rows
  const route = journeySummary(index, journey(index, 'app::route::GET /invoices'), screensFor(index, 'app::route::GET /invoices'));
  assert.equal(route.segments[0]!.screen, null);
  assert.deepEqual(route.segments[0]!.markers.map((m) => m.kind), ['call', 'record'], 'the entry route is the first marker in the API row');
});

test('linked journeys: declared requires/leadsTo on a flow, derived from a longer flow\'s screen order, part-of for a screen; unknown flow ids are drift', () => {
  const f = fragment();
  const withFlows: DesignManifest = { ...manifest, flows: [
    { id: 'route', name: 'Edit, draft, discard', screens: ['INV-02', 'INV-01', 'INV-03'] },
    { id: 'edit', name: 'Edit an invoice', screens: ['INV-02'] },
    { id: 'draft', name: 'Draft and discard', screens: ['INV-01', 'INV-03'], leadsTo: ['edit'], requires: ['nope'] },
  ] };
  const r = reconcileDesign(withFlows, buildIndex(f.nodes, f.edges), { repo: 'app', path: 'docs/design/screens.json' });
  assert.deepEqual(r.flows.find((x) => x.flow.id === 'draft')!.drift.map((d) => d.kind), ['flow-unknown']);
  applyDesignToFragment(f, withFlows, { repo: 'app', path: 'docs/design/screens.json' });
  const index = buildIndex(f.nodes, f.edges);
  assert.deepEqual(index.byId.get('app::flow::draft')!.design!.leadsTo, ['edit']);
  const sum = journeySummary(index, journey(index, 'app::flow::draft'), screensFor(index, 'app::flow::draft'));
  assert.deepEqual(sum.links.partOf.map((l) => [l.id, l.how]), [['app::flow::route', 'derived']]);
  assert.deepEqual(sum.links.requires.map((l) => [l.id, l.how, l.screens, l.built]), [['app::flow::edit', 'derived', 1, 1]], 'edit ends just before draft inside route');
  assert.deepEqual(sum.links.leadsTo.map((l) => [l.id, l.how]), [['app::flow::edit', 'declared']]);
  // a screen entry is part of every flow that renders it
  const page = journeySummary(index, journey(index, 'app::page::/invoices'), screensFor(index, 'app::page::/invoices'));
  assert.deepEqual(page.links.partOf.map((l) => l.id).sort(), ['app::flow::draft', 'app::flow::route']);
  assert.deepEqual(page.links.requires.map((l) => l.id), ['app::flow::edit']);
});

test('buildInfo: a workspace build reports the root version, a real build time, and prints one line', () => {
  const b = buildInfo();
  assert.match(b.version, /^\d+\.\d+\.\d+/);
  assert.ok(!Number.isNaN(Date.parse(b.built)) && Date.parse(b.built) > Date.parse('2026-01-01'), 'built is the dist mtime, not the epoch');
  assert.equal(b.source, 'workspace');
  assert.match(buildLine(), /^farsight \d+\.\d+\.\d+ · built \d{4}-/);
});
