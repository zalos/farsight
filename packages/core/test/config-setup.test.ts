// The setup closure and the config tags it needs —
// the clarity-phase plan §2.3.3 (setup origin) and §2.3.6 (plumbing).
//
// The container build is real code that runs once. Walking it under every request is
// what made the reference app's first action write `schema_migrations`. Here: a root declared in
// `farsight.config.json → setup`, a function only boot ever calls (joins the closure),
// and a function boot shares with a request handler (stays out).
//
// In-memory fixtures (core has no parser dependency). Runs against the built package:
// `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyConfig, applySetupOrigin, globToRegExp, applyTooling, glossaryEntryFor, buildIndex, journey } from '../dist/index.js';
import type { GraphNode, GraphEdge, FarsightConfig } from '../dist/index.js';

const R = 'app';
const id = (path: string, name: string): string => `${R}::${path}::${name}`;
const fn = (name: string, path: string, line: number, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id: id(path, name), kind: 'function', name, tags: [], loc: { repo: R, path, line }, ...extra }) as GraphNode;
const edge = (kind: GraphEdge['kind'], from: string, to: string, line: number): GraphEdge =>
  ({ id: `${kind}|${from}|${to}`, kind, from, to, meta: { line } });

const CONTAINER = 'libs/runtime/container.ts';
const BUILD = id(CONTAINER, 'build');

/**
 * `getContainer` memoises `build()`; `build` wires the process. `runMigrations` is
 * called from nowhere else and writes a table; `loadEnv` is called by `build` and by
 * the request handler, so it is not boot-only — and neither is `parseEnv` under it.
 */
function container(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    fn('getContainer', CONTAINER, 170),
    fn('build', CONTAINER, 80),
    fn('runMigrations', 'libs/db/migrate.ts', 12),
    fn('loadEnv', 'libs/config/env.ts', 4),
    fn('parseEnv', 'libs/config/env.ts', 40),
    fn('handler', 'apps/web/routes.ts', 9),
    { id: `${R}::table::schema_migrations`, kind: 'table', name: 'schema_migrations', tags: [] } as GraphNode,
  ];
  const edges: GraphEdge[] = [
    edge('calls', id(CONTAINER, 'getContainer'), BUILD, 176),
    edge('calls', BUILD, id('libs/db/migrate.ts', 'runMigrations'), 92),
    edge('calls', BUILD, id('libs/config/env.ts', 'loadEnv'), 84),
    edge('calls', id('apps/web/routes.ts', 'handler'), id('libs/config/env.ts', 'loadEnv'), 11),
    edge('calls', id('libs/config/env.ts', 'loadEnv'), id('libs/config/env.ts', 'parseEnv'), 6),
    edge('writes', id('libs/db/migrate.ts', 'runMigrations'), `${R}::table::schema_migrations`, 20),
  ];
  return { nodes, edges };
}

const originOf = (edges: GraphEdge[], kind: GraphEdge['kind'], from: string, to: string): unknown =>
  edges.find((e) => e.kind === kind && e.from === from && e.to === to)?.meta?.origin;

// ── the closure ──────────────────────────────────────────────────────────

test('a setup root declared by exact node id: boot-only callees join the closure, a shared callee stays out', () => {
  const { nodes, edges } = container();
  applyConfig(nodes, { setup: [BUILD] } as FarsightConfig, edges);
  assert.deepEqual(nodes.filter((n) => n.tags.includes('setup')).map((n) => n.name), ['build']);

  const stamped = applySetupOrigin(nodes, edges);
  assert.equal(stamped, 4);

  // out-edges of a closure member, whatever the target: runMigrations joined (only build calls it)
  assert.equal(originOf(edges, 'calls', BUILD, id('libs/db/migrate.ts', 'runMigrations')), 'setup');
  assert.equal(originOf(edges, 'calls', BUILD, id('libs/config/env.ts', 'loadEnv')), 'setup');
  assert.equal(originOf(edges, 'writes', id('libs/db/migrate.ts', 'runMigrations'), `${R}::table::schema_migrations`), 'setup');
  // the calls in-edge into a setup root — the memo that hands the container out
  assert.equal(originOf(edges, 'calls', id(CONTAINER, 'getContainer'), BUILD), 'setup');

  // loadEnv has a second caller, so it is not boot-only: its own call is ordinary work,
  // and the request path into it is never dimmed
  assert.equal(originOf(edges, 'calls', id('libs/config/env.ts', 'loadEnv'), id('libs/config/env.ts', 'parseEnv')), undefined);
  assert.equal(originOf(edges, 'calls', id('apps/web/routes.ts', 'handler'), id('libs/config/env.ts', 'loadEnv')), undefined);
});

test('a setup root declared by name matcher reaches the same closure, and only functions match', () => {
  const { nodes, edges } = container();
  applyConfig(nodes, { setup: ['container.ts::build', 'build'] } as FarsightConfig, edges);
  assert.deepEqual(nodes.filter((n) => n.tags.includes('setup')).map((n) => n.name), ['build']);

  applySetupOrigin(nodes, edges);
  assert.equal(originOf(edges, 'writes', id('libs/db/migrate.ts', 'runMigrations'), `${R}::table::schema_migrations`), 'setup');
  assert.equal(originOf(edges, 'calls', id('apps/web/routes.ts', 'handler'), id('libs/config/env.ts', 'loadEnv')), undefined);
});

test('applySetupOrigin is idempotent and additive on meta', () => {
  const { nodes, edges } = container();
  applyConfig(nodes, { setup: [BUILD] } as FarsightConfig, edges);
  applySetupOrigin(nodes, edges);
  const after = JSON.stringify(edges);

  assert.equal(applySetupOrigin(nodes, edges), 0);
  assert.equal(JSON.stringify(edges), after);
  // the line the adapter stamped is still there beside the origin
  assert.equal(edges.find((e) => e.from === BUILD)?.meta?.line, 92);
});

test('no setup tag, no stamping — the graph is untouched', () => {
  const { nodes, edges } = container();
  const before = JSON.stringify(edges);
  assert.equal(applySetupOrigin(nodes, edges), 0);
  assert.equal(JSON.stringify(edges), before);
});

// ── plumbing ─────────────────────────────────────────────────────────────

test('a plumbing glob tags the directory it names and nothing beside it', () => {
  const nodes: GraphNode[] = [fn('format', 'src/plumbing/format.ts', 3), fn('format', 'src/format.ts', 3), fn('readJson', 'src/plumbing/http/json.ts', 8)];
  applyConfig(nodes, { plumbing: ['src/plumbing/**'] } as FarsightConfig, []);
  assert.deepEqual(nodes.map((n) => n.tags.includes('plumbing')), [true, false, true]);

  applyConfig(nodes, { plumbing: ['src/plumbing/**'] } as FarsightConfig, []);
  assert.deepEqual(nodes[0]!.tags, ['plumbing']); // idempotent — never a second copy
});

test('globToRegExp keeps `**​/` multi-segment and `*` inside one segment', () => {
  assert.equal(globToRegExp('libs/api/http/**').test('libs/api/http/fetch.ts'), true);
  assert.equal(globToRegExp('libs/api/http/**').test('libs/api/httpx/fetch.ts'), false);
  assert.equal(globToRegExp('**/primitives/*.tsx').test('libs/ux/primitives/Button.tsx'), true);
  assert.equal(globToRegExp('**/primitives/*.tsx').test('libs/ux/primitives/nested/Button.tsx'), false);
});

// ── the glossary meets class members (the reference app, 2026-09-27) ────────────────
// The reference app keyed its glossary by bare identifiers (`claimNext`, `BcClient`,
// `BcOutboxWorker`) and none matched: members are named `Class.method`, and a
// class has no node of its own — only its members do.

test('glossary: exact name, then the member part, then the class part', () => {
  const glossary: FarsightConfig['glossary'] = {
    claimNext: { label: 'Claim the next outbox row', description: 'Takes one pending write.' },
    BcClient: { label: 'Business Central client', description: 'Talks to BC.' },
    'BcClient.request': { label: 'Send a request to Business Central' },
    BcOutboxWorker: { label: 'Business Central outbox worker' },
    assertSameOrigin: { label: 'Same-origin check' },
  };
  const nodes: GraphNode[] = [
    fn('PgBcOutboxRepository.claimNext', 'libs/bc/outbox/pg.ts', 10),
    fn('BcClient.request', 'libs/bc/client.ts', 20),
    fn('BcClient.createVendor', 'libs/bc/client.ts', 40),
    fn('BcOutboxWorker.drainOnce', 'libs/bc/outbox/worker.ts', 30),
    fn('BcOutboxWorker.claimNext', 'libs/bc/outbox/worker.ts', 50),
    fn('assertSameOrigin', 'libs/http/origin.ts', 5),
    fn('Unrelated.method', 'libs/x.ts', 1),
  ];
  applyConfig(nodes, { glossary });
  const label = (name: string) => nodes.find((n) => n.name === name)!.facets?.business?.label;
  assert.equal(label('assertSameOrigin'), 'Same-origin check', 'exact');
  assert.equal(label('PgBcOutboxRepository.claimNext'), 'Claim the next outbox row', 'member part');
  assert.equal(nodes.find((n) => n.name === 'PgBcOutboxRepository.claimNext')!.facets?.business?.description, 'Takes one pending write.');
  assert.equal(label('BcClient.request'), 'Send a request to Business Central', 'an exact Class.method entry beats the class');
  assert.equal(label('BcClient.createVendor'), 'Business Central client: create vendor', 'class part: its words plus the member');
  assert.equal(nodes.find((n) => n.name === 'BcClient.createVendor')!.facets?.business?.description, undefined,
    'the class’s description does not describe a member');
  assert.equal(label('BcOutboxWorker.drainOnce'), 'Business Central outbox worker: drain once');
  assert.equal(label('BcOutboxWorker.claimNext'), 'Claim the next outbox row', 'member beats class');
  assert.equal(label('Unrelated.method'), undefined);
  // a route name is never split on a dot
  assert.equal(glossaryEntryFor('GET /api/v1.2/x', { x: { label: 'nope' } }), undefined);
  // the lookup runs before a guard rule renames the node
  const g = [fn('assertSameOrigin', 'libs/http/origin.ts', 5)];
  applyConfig(g, { glossary, guards: { 'same origin on writes': ['assertSameOrigin'] } });
  assert.equal(g[0]!.facets?.business?.label, 'Same-origin check');
  assert.equal(g[0]!.kind, 'guard');
  // a guard the adapter already renamed (`name: label`) matches on the identifier before the colon,
  // and keeps the description its code wrote when the glossary gives none
  const found = [{ ...fn('assertSameOrigin: same-origin on mutating routes', 'libs/http/origin.ts', 5), kind: 'guard',
    facets: { business: { description: 'Blocks cross-site writes.' } } } as GraphNode];
  applyConfig(found, { glossary });
  assert.deepEqual(found[0]!.facets?.business, { label: 'Same-origin check', description: 'Blocks cross-site writes.' });
});

// ── tooling (config `tooling`, default scripts/**) ──────────────────────

test('tooling: tagged, the app’s edges into it demoted to LOW, and a journey from a script still walks the app', () => {
  const nodes: GraphNode[] = [
    fn('Worker.drain', 'src/worker.ts', 3),
    fn('build.log', 'src/container.ts', 9),
    fn('main', 'scripts/pilot.ts', 2),
    fn('main.log', 'scripts/pilot.ts', 3),
  ];
  const edges: GraphEdge[] = [
    edge('calls', id('src/worker.ts', 'Worker.drain'), id('src/container.ts', 'build.log'), 3),
    { ...edge('calls', id('src/worker.ts', 'Worker.drain'), id('scripts/pilot.ts', 'main.log'), 3),
      resolution: { status: 'heuristic', technique: 'hook-binding', confidence: 'MEDIUM', note: 'bound at scripts/pilot.ts:3' } },
    edge('calls', id('scripts/pilot.ts', 'main'), id('src/worker.ts', 'Worker.drain'), 4),
  ];
  assert.equal(applyTooling(nodes, edges), 1, 'one edge from the app into a script');
  assert.equal(applyTooling(nodes, edges), 0, 'idempotent');
  assert.deepEqual(nodes.filter((n) => n.tags.includes('tooling')).map((n) => n.name), ['main', 'main.log']);
  const into = edges[1]!;
  assert.equal(into.resolution?.confidence, 'LOW');
  assert.equal(into.resolution?.technique, 'hook-binding');
  assert.match(String(into.resolution?.note), /^bound at scripts\/pilot\.ts:3; the target is tooling/);
  assert.equal(edges[2]!.resolution, undefined, 'a script calling the app is untouched');
  const index = buildIndex(nodes, edges);
  const fromApp = journey(index, id('src/worker.ts', 'Worker.drain')).steps.map((s) => s.nodeId);
  assert.deepEqual(fromApp, [id('src/worker.ts', 'Worker.drain'), id('src/container.ts', 'build.log')]);
  const fromScript = journey(index, id('scripts/pilot.ts', 'main')).steps.map((s) => s.nodeId);
  assert.ok(fromScript.includes(id('scripts/pilot.ts', 'main.log')), 'a journey that starts in a script walks as it always did');
});
