// Dependency impact — the fold (docs/proposals/dependency-impact.md §3) and the
// `farsight-impact-tests v1` contract (§5). In-memory fixtures; core has no
// parser dependency. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildIndex, impactOf, impactTestsV1, impactTestsReaching, isSharedNode, STRINGS,
  IMPACT_CUT_REASONS, IMPACT_UNSELECTABLE_REASONS, IMPACT_MAX_HOPS,
} from '../dist/index.js';
import type { GraphEdge, GraphNode, EdgeResolution, ImpactReport } from '../dist/index.js';
import { validate } from './validate.ts';

const R = 'shop';
const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = () => JSON.parse(readFileSync(join(here, '..', '..', '..', 'schemas', 'farsight-impact-tests-v1.schema.json'), 'utf8'));
const DIFF_SCHEMA = () => JSON.parse(readFileSync(join(here, '..', '..', '..', 'schemas', 'farsight-diff-v1.schema.json'), 'utf8'));

const IDENTITY = {
  sync: 9, source_commit: 'abc1234', source_digest: { [R]: 'd1g35700' },
  farsight: 'farsight 0.0.0 · built 1970-01-01T00:00:00.000Z · workspace',
  generated_at: '2026-09-24T00:00:00.000Z',
};

const res = (technique: EdgeResolution['technique'], confidence: EdgeResolution['confidence'], extra: Partial<EdgeResolution> = {}): EdgeResolution =>
  ({ status: 'resolved', technique, confidence, ...extra });

const node = (id: string, kind: GraphNode['kind'], name: string, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, kind, name, tags: [], ...extra }) as GraphNode;
const fn = (name: string, path: string, line: number, extra: Partial<GraphNode> = {}): GraphNode =>
  node(`${R}::${path}::${name}`, 'function', name, { loc: { repo: R, path, line }, ...extra });
const edge = (kind: GraphEdge['kind'], from: string, to: string, line: number, resolution?: EdgeResolution, meta?: GraphEdge['meta']): GraphEdge =>
  ({ id: `${kind}|${from}|${to}`, kind, from, to, meta: { line, ...meta }, ...(resolution ? { resolution } : {}) });

const F = (n: string, p = 'svc.ts'): string => `${R}::${p}::${n}`;
const TABLE = `${R}::table::invoices`;

/**
 * One table, its accessors, what calls them, and every edge shape the fold has
 * an opinion about: a stamped write, an unstamped read, an interface call with
 * a twin set aside, plumbing with a crowd behind it, the boot, later work, and
 * a test that covers one accessor.
 */
function shop(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    node(TABLE, 'table', 'invoices'),
    fn('saveInvoice', 'db.ts', 10), fn('findInvoice', 'db.ts', 20),
    fn('memSave', 'db-mem.ts', 5),
    fn('submit', 'svc.ts', 30), fn('listInvoices', 'svc.ts', 60),
    fn('fmt', 'plumbing.ts', 4, { tags: ['plumbing'] }),
    fn('a1', 'ui.ts', 1), fn('a2', 'ui.ts', 2), fn('a3', 'ui.ts', 3),
    node(`${R}::route::POST /invoices`, 'route', 'POST /invoices', { loc: { repo: R, path: 'routes.ts', line: 7 } }),
    node(`${R}::route::GET /planned`, 'route', 'GET /planned', { contract: { status: 'spec-only', apiId: `${R}::api::spec` } as GraphNode['contract'] }),
    fn('auditLater', 'hooks.ts', 9), fn('seedDb', 'seed.ts', 3), fn('buildContainer', 'container.ts', 2, { tags: ['setup'] }),
    node(`${R}::test::saves a draft`, 'test', 'saves a draft', {
      loc: { repo: R, path: 'db.spec.ts', line: 12 },
      test: { level: 'unit', runner: 'vitest', suite: ['invoices'], file: 'db.spec.ts', project: 'db' },
    }),
  ];
  const edges: GraphEdge[] = [
    // hop 1: one stamped write, one read nobody recorded
    edge('writes', F('saveInvoice', 'db.ts'), TABLE, 11, res('raw-sql', 'HIGH')),
    edge('reads', F('findInvoice', 'db.ts'), TABLE, 21),
    // hop 2: an interface call that set a twin aside, and a plain one
    edge('calls', F('submit'), F('saveInvoice', 'db.ts'), 31, res('interface', 'MEDIUM', { alternatives: [F('memSave', 'db-mem.ts')] })),
    edge('calls', F('listInvoices'), F('findInvoice', 'db.ts'), 61, res('static-import', 'HIGH')),
    // plumbing with a crowd behind it
    edge('calls', F('fmt', 'plumbing.ts'), F('findInvoice', 'db.ts'), 5, res('static-import', 'HIGH')),
    edge('calls', F('a1', 'ui.ts'), F('fmt', 'plumbing.ts'), 1, res('static-import', 'HIGH')),
    edge('calls', F('a2', 'ui.ts'), F('fmt', 'plumbing.ts'), 2, res('static-import', 'HIGH')),
    edge('calls', F('a3', 'ui.ts'), F('fmt', 'plumbing.ts'), 3, res('static-import', 'HIGH')),
    // hop 3
    edge('calls', `${R}::route::POST /invoices`, F('submit'), 8, res('static-import', 'HIGH')),
    // the boot, and work that runs later on its own
    edge('writes', F('seedDb', 'seed.ts'), TABLE, 4, res('raw-sql', 'HIGH'), { origin: 'setup' }),
    edge('calls', F('buildContainer', 'container.ts'), F('seedDb', 'seed.ts'), 3, res('same-file', 'HIGH'), { origin: 'setup' }),
    edge('writes', F('auditLater', 'hooks.ts'), TABLE, 10, res('raw-sql', 'HIGH'), { deferred: true }),
    // a test is evidence, not a dependent
    { id: 'covers|t1', kind: 'covers', from: `${R}::test::saves a draft`, to: F('saveInvoice', 'db.ts'), meta: { evidence: 'static' }, resolution: res('import-resolution', 'HIGH') },
  ];
  return { nodes, edges };
}

const idx = () => buildIndex(...(({ nodes, edges }) => [nodes, edges] as const)(shop()));

// ── the five checks this chunk owes ────────────────────────────────────────

test('setup and deferred edges are excluded by default, named apart, and included on request', () => {
  const index = idx();
  const r = impactOf(index, TABLE);
  const hop1 = r.hops[0]!.nodes.map((n) => n.name);
  assert.deepEqual(hop1, ['findInvoice', 'saveInvoice'], 'the boot’s seed write and the later audit write are not dependents of the request');
  assert.deepEqual(r.excluded.setup.map((n) => n.name), ['seedDb']);
  assert.deepEqual(r.excluded.deferred.map((n) => n.name), ['auditLater']);
  // and they are cut points, so the not-walked block can print them
  assert.deepEqual(
    r.cutPoints.filter((c) => c.reason === 'setup' || c.reason === 'deferred').map((c) => [c.reason, c.name, c.hop]),
    [['setup', 'seedDb', 1], ['deferred', 'auditLater', 1]],
  );
  // the boot's own caller sits behind the seed write and is not counted as a dependent either
  assert.equal(r.excluded.setup[0]!.strength.hops, 1);
  assert.equal(r.excluded.setup[0]!.via.origin, 'setup');
  assert.equal(r.excluded.deferred[0]!.via.deferred, true);

  const withBoot = impactOf(index, TABLE, { includeSetup: true, includeDeferred: true });
  assert.deepEqual(withBoot.hops[0]!.nodes.map((n) => n.name).sort(), ['auditLater', 'findInvoice', 'saveInvoice', 'seedDb']);
  assert.deepEqual(withBoot.excluded, { setup: [], deferred: [] });
  assert.deepEqual(withBoot.hops[1]!.nodes.map((n) => n.name).sort(), ['buildContainer', 'fmt', 'listInvoices', 'submit']);
});

test('a shared node is listed, not opened, and its cut says how much is behind it', () => {
  const index = idx();
  const r = impactOf(index, TABLE, { hops: 3 });
  const fmtNode = r.hops[1]!.nodes.find((n) => n.name === 'fmt')!;
  assert.equal(fmtNode.shared, true, 'plumbing is a shared node');
  assert.ok(isSharedNode(index, index.byId.get(fmtNode.nodeId)!));
  const cut = r.cutPoints.find((c) => c.reason === 'shared')!;
  assert.equal(cut.name, 'fmt');
  assert.equal(cut.behind, 3, 'a1 · a2 · a3 sit behind it and were not walked');
  assert.equal(cut.direct, 3, 'and all three are one edge behind — behind and direct are different questions');
  assert.ok(!r.hops[2]!.nodes.some((n) => n.name.startsWith('a')), 'the crowd behind the helper never enters the answer');
  // --expand-shared is for someone who really is changing the helper
  const open = impactOf(index, TABLE, { hops: 3, expandShared: true });
  assert.deepEqual(open.hops[2]!.nodes.map((n) => n.name).sort(), ['POST /invoices', 'a1', 'a2', 'a3']);
  assert.equal(open.cutPoints.filter((c) => c.reason === 'shared').length, 0);
});

test('strength over an unstamped edge is never a tier: the pair says a tier is absent and counts the silence', () => {
  const index = idx();
  const r = impactOf(index, TABLE, { hops: 2 });
  const find = r.hops[0]!.nodes.find((n) => n.name === 'findInvoice')!;
  assert.deepEqual(find.strength, { tier: null, unstamped: 1, hops: 1 },
    'the read edge records no technique: that is an absence of provenance, not a LOW confidence');
  const save = r.hops[0]!.nodes.find((n) => n.name === 'saveInvoice')!;
  assert.deepEqual(save.strength, { tier: 'HIGH', unstamped: 0, hops: 1 });
  // the weakest link governs the path: HIGH write under a MEDIUM call reads MEDIUM
  const submit = r.hops[1]!.nodes.find((n) => n.name === 'submit')!;
  assert.deepEqual(submit.strength, { tier: 'MEDIUM', unstamped: 0, hops: 2 });
  // one unstamped edge under a stamped one keeps both facts
  const list = r.hops[1]!.nodes.find((n) => n.name === 'listInvoices')!;
  assert.deepEqual(list.strength, { tier: 'HIGH', unstamped: 1, hops: 2 });
  assert.equal(r.bound, 'floor');
  // an unstamped path crosses an edge that records NOTHING; this assertion used to
  // pin the inverse of that, which is how the sentence shipped saying the opposite
  assert.match(r.uncertainty!.note, /cross an edge that records nothing about how it was resolved/);
  // nothing anywhere ranks "records nothing" as a tier
  for (const n of r.hops.flatMap((h) => h.nodes)) {
    assert.ok(n.strength.tier === null || ['HIGH', 'MEDIUM', 'LOW'].includes(n.strength.tier));
  }
});

test('hops carries no total: the type cannot hold the number the brief says never to print', () => {
  const r = impactOf(idx(), TABLE, { hops: 3 });
  assert.ok(!('total' in r), Object.keys(r).join(','));
  assert.ok(!('count' in r));
  assert.ok(!('nodes' in r));
  assert.deepEqual(Object.keys(r).sort(), ['asOf', 'bound', 'cutPoints', 'direction', 'excluded', 'hops', 'seed', 'uncertainty']);
  assert.deepEqual(r.hops.map((h) => [h.hop, h.found]), [[1, 2], [2, 3], [3, 1]]);
  for (const h of r.hops) assert.ok(!('total' in h));
});

test('the envelope validates against its schema, and the enums cannot drift from the code', () => {
  const index = idx();
  const report = impactOf(index, TABLE, { hops: 2 });
  const doc = impactTestsV1(index, [{ report }], IDENTITY);
  assert.equal(doc.schema, 'farsight-impact-tests v1');
  assert.deepEqual(validate(doc, SCHEMA()), []);
  assert.deepEqual(doc.identity, IDENTITY, 'the tests-matrix identity block, verbatim');

  // the schema file is held to real output, and rejects a document that breaks it
  const broken = JSON.parse(JSON.stringify(doc));
  broken.cut.push({ reason: 'gave up', behind: 1, direct: 1, hop: 1 });
  broken.hops[0].nodes[0].strength.tier = 'unstamped';
  assert.ok(validate(broken, SCHEMA()).length >= 2);

  // the enums a consumer switches on are pinned to an explicit list in both places
  const schema = SCHEMA();
  assert.deepEqual([...IMPACT_CUT_REASONS], ['hops', 'shared', 'setup', 'deferred', 'cap']);
  assert.deepEqual([...IMPACT_CUT_REASONS].sort(), [...schema.$defs.cut.properties.reason.enum].sort());
  assert.deepEqual([...IMPACT_UNSELECTABLE_REASONS], ['no covers edge', 'declared only', 'inactive', 'run-level only']);
  assert.deepEqual([...IMPACT_UNSELECTABLE_REASONS].sort(), [...schema.$defs.unselectable.properties.reason.enum].sort());
  assert.deepEqual(schema.$defs.evidenceClass.enum, ['declared', 'reached', 'observed']);
  // the confidence ladder is the graph's, plus the null that says nothing was recorded
  const diffTiers = DIFF_SCHEMA().$defs.confidence.enum.filter((t: string) => t !== 'resolved');
  assert.deepEqual(schema.$defs.tier.enum, [...diffTiers, null]);
  assert.deepEqual(schema.$defs.edgeKind.enum, [
    'contains', 'imports', 'calls', 'renders', 'http', 'publishes', 'consumes', 'reads', 'writes', 'validates', 'guards', 'covers', 'tracks',
  ]);
});

// ── the rest of the fold ───────────────────────────────────────────────────

test('a covers edge is never followed: a test is evidence about a node, not a dependent of it', () => {
  const index = idx();
  const r = impactOf(index, F('saveInvoice', 'db.ts'), { hops: 2, tests: true });
  assert.ok(!r.hops.flatMap((h) => h.nodes).some((n) => n.kind === 'test'), 'no test node is ever a hop');
  assert.deepEqual(r.hops[0]!.nodes.map((n) => n.name), ['submit']);
  // the test reaches the answer where it belongs: attached to the node it covers
  const back = impactOf(index, TABLE, { tests: true });
  const save = back.hops[0]!.nodes.find((n) => n.name === 'saveInvoice')!;
  assert.deepEqual(save.tests!.map((t) => [t.name, t.evidence]), [['saves a draft', 'static']]);
  assert.deepEqual(back.hops[0]!.nodes.find((n) => n.name === 'findInvoice')!.tests, []);
});

test('one of several: a call the code resolves at run time is drawn, never folded away', () => {
  const r = impactOf(idx(), TABLE, { hops: 2 });
  const submit = r.hops[1]!.nodes.find((n) => n.name === 'submit')!;
  assert.deepEqual(submit.oneOf, { chosen: 'saveInvoice', alternatives: ['memSave'] });
  assert.equal(r.bound, 'floor');
  assert.match(r.uncertainty!.note, /resolves at run time/);
});

test('the widest path wins among equally short ones — the best of the weakest links, ties to fewer silences', () => {
  // two 2-hop routes into the same table: one all-MEDIUM, one HIGH over an unstamped edge
  const nodes = [
    node(TABLE, 'table', 'invoices'),
    fn('viaMedium', 'a.ts', 1), fn('viaHigh', 'b.ts', 1), fn('caller', 'c.ts', 1),
  ];
  const edges = [
    edge('reads', F('viaMedium', 'a.ts'), TABLE, 2, res('method-name', 'MEDIUM')),
    edge('reads', F('viaHigh', 'b.ts'), TABLE, 2),                                   // records nothing
    edge('calls', F('caller', 'c.ts'), F('viaMedium', 'a.ts'), 3, res('static-import', 'HIGH')),
    edge('calls', F('caller', 'c.ts'), F('viaHigh', 'b.ts'), 4, res('static-import', 'HIGH')),
  ];
  const r = impactOf(buildIndex(nodes, edges), TABLE, { hops: 2 });
  const caller = r.hops[1]!.nodes[0]!;
  assert.deepEqual(caller.strength, { tier: 'HIGH', unstamped: 1, hops: 2 },
    'the best of the weakest links — and the silence on that path is still counted, not hidden');
  assert.deepEqual(caller.path, [TABLE, F('viaHigh', 'b.ts'), F('caller', 'c.ts')]);

  // same tier on both routes: the one with fewer unstamped edges wins the tie
  const tie = impactOf(buildIndex(nodes, [
    edge('reads', F('viaMedium', 'a.ts'), TABLE, 2, res('method-name', 'MEDIUM')),
    edge('reads', F('viaHigh', 'b.ts'), TABLE, 2, res('method-name', 'MEDIUM')),
    edge('calls', F('caller', 'c.ts'), F('viaMedium', 'a.ts'), 3, res('static-import', 'HIGH')),
    edge('calls', F('caller', 'c.ts'), F('viaHigh', 'b.ts'), 4),
  ]), TABLE, { hops: 2 });
  assert.deepEqual(tie.hops[1]!.nodes[0]!.strength, { tier: 'MEDIUM', unstamped: 0, hops: 2 });
  assert.deepEqual(tie.hops[1]!.nodes[0]!.path[1], F('viaMedium', 'a.ts'));
});

test('a hop is the shortest distance, and a node answered nearer is not answered again further out', () => {
  const nodes = [node(TABLE, 'table', 'invoices'), fn('near', 'a.ts', 1), fn('far', 'b.ts', 1)];
  const edges = [
    edge('reads', F('near', 'a.ts'), TABLE, 2, res('raw-sql', 'HIGH')),
    edge('reads', F('far', 'b.ts'), TABLE, 3, res('raw-sql', 'HIGH')),
    edge('calls', F('far', 'b.ts'), F('near', 'a.ts'), 4, res('static-import', 'HIGH')),
  ];
  const r = impactOf(buildIndex(nodes, edges), TABLE, { hops: 2 });
  assert.deepEqual(r.hops[0]!.nodes.map((n) => n.name), ['far', 'near']);
  assert.equal(r.hops.length, 1, 'both use it directly; neither is counted twice at hop 2');
});

test('a hop bigger than the cap is counted, grouped and cut — never silently shortened', () => {
  const nodes: GraphNode[] = [node(TABLE, 'table', 'invoices')];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < 12; i++) {
    nodes.push(fn(`r${String(i).padStart(2, '0')}`, 'db.ts', i));
    edges.push(edge('reads', F(`r${String(i).padStart(2, '0')}`, 'db.ts'), TABLE, i, res('raw-sql', 'HIGH')));
  }
  const r = impactOf(buildIndex(nodes, edges), TABLE, { perHopCap: 5 });
  assert.equal(r.hops[0]!.found, 12, 'the count is a fact even when the list is not printed');
  assert.equal(r.hops[0]!.nodes.length, 5);
  assert.deepEqual(r.hops[0]!.byKind, { function: 12 });
  assert.deepEqual(r.hops[0]!.byRepo, { [R]: 12 });
  const cut = r.cutPoints.find((c) => c.reason === 'cap')!;
  assert.deepEqual([cut.behind, cut.direct, cut.hop, cut.nodeId], [7, 7, 1, undefined],
    'a cap is a fact about a hop, not about any one node');
  assert.equal(r.bound, 'floor');
});

test('downstream answers the same question the other way, and the seed is never its own dependent', () => {
  const index = idx();
  const down = impactOf(index, F('submit'), { direction: 'downstream', hops: 2 });
  assert.equal(down.direction, 'downstream');
  assert.deepEqual(down.hops[0]!.nodes.map((n) => n.name), ['saveInvoice']);
  assert.deepEqual(down.hops[1]!.nodes.map((n) => n.name), ['invoices']);
  assert.ok(!down.hops.flatMap((h) => h.nodes).some((n) => n.nodeId === F('submit')));
});

test('the answer is deterministic: the same graph in another order is the same document', () => {
  const { nodes, edges } = shop();
  const a = impactOf(buildIndex(nodes, edges), TABLE, { hops: 3, tests: true });
  const b = impactOf(buildIndex([...nodes].reverse(), [...edges].reverse()), TABLE, { hops: 3, tests: true });
  const strip = (r: ImpactReport) => JSON.stringify({ ...r, asOf: { ...r.asOf, generatedAt: '' } });
  assert.equal(strip(b), strip(a));
});

test('refusals: an id this graph does not hold, a zero-hop question, and a budget past what means anything', () => {
  const index = idx();
  assert.throws(() => impactOf(index, `${R}::table::nope`), /no node with id/);
  assert.throws(() => impactOf(index, TABLE, { hops: 0 }), /0 hops asks nothing/);
  assert.throws(() => impactOf(index, TABLE, { hops: IMPACT_MAX_HOPS + 1 }), /describes the application/);
  assert.equal(IMPACT_MAX_HOPS, 5);
});

test('a graph whose digest no longer matches the checkout is a floor on that alone', () => {
  const nodes = [node(TABLE, 'table', 'invoices'), fn('only', 'a.ts', 1)];
  const edges = [edge('reads', F('only', 'a.ts'), TABLE, 2, res('raw-sql', 'HIGH'))];
  const index = buildIndex(nodes, edges);
  const clean = impactOf(index, TABLE, { hops: 1 });
  assert.equal(clean.bound, 'exact', 'a fully stamped, uncut, unambiguous neighbourhood can earn it');
  assert.equal(clean.uncertainty, undefined);
  const stale = impactOf(index, TABLE, { hops: 1, asOf: { sync: 9, commit: 'abc1234', digestMatches: false } });
  assert.equal(stale.bound, 'floor');
  assert.match(stale.uncertainty!.note, /no longer matches the checkout/);
  assert.deepEqual([stale.asOf.sync, stale.asOf.commit], [9, 'abc1234']);
});

test('nothing uses it: an empty answer is an answer, not an error', () => {
  const index = buildIndex([node(TABLE, 'table', 'invoices')], []);
  const r = impactOf(index, TABLE);
  assert.deepEqual(r.hops, []);
  assert.deepEqual(r.cutPoints, []);
  assert.equal(r.bound, 'exact');
});

// ── farsight-impact-tests v1 ───────────────────────────────────────────────

test('the CI document: what can be run, what cannot, and why the fallback fired', () => {
  const index = idx();
  const report = impactOf(index, F('saveInvoice', 'db.ts'), { hops: 2 });
  const doc = impactTestsV1(index, [{ report, from: 'hunk', hunk: 'db.ts:10-18' }], IDENTITY);
  assert.deepEqual(validate(doc, SCHEMA()), []);
  assert.deepEqual(doc.seeds, [{ id: F('saveInvoice', 'db.ts'), name: 'saveInvoice', kind: 'function', from: 'hunk', hunk: 'db.ts:10-18' }]);
  // the seed's own test is runnable, so it is selected
  assert.deepEqual(doc.select, { vitest: [{ file: 'db.spec.ts', title: 'saves a draft', project: 'db' }] });
  // its direct dependent has no covers edge at all, so the gate fails and says so
  assert.deepEqual(doc.unselectable, [{ node: F('submit'), name: 'submit', reason: 'no covers edge' }]);
  assert.equal(doc.fallback, 'run-all');
  assert.match(doc.fallback_reason!, /no test a job could name and run/);
  assert.equal(doc.bound, 'floor');
  assert.equal(doc.hops[0]!.nodes[0]!.tests.length, 0);
  assert.deepEqual(doc.hops.map((h) => h.hop), [1, 2]);
});

test('a document with nothing to say about the seed still says it in the closed words', () => {
  const index = idx();
  // a route declared in a spec and never built: nothing runs it and no test can
  const planned = impactOf(index, `${R}::route::GET /planned`, { hops: 1 });
  const doc = impactTestsV1(index, [{ report: planned }], IDENTITY);
  assert.deepEqual(validate(doc, SCHEMA()), []);
  assert.deepEqual(doc.unselectable, [{ node: `${R}::route::GET /planned`, name: 'GET /planned', reason: 'declared only' }]);
  assert.equal(doc.fallback, 'run-all');
  assert.deepEqual(doc.select, {}, 'an absent runner key is not an empty suite');
  assert.deepEqual(doc.hops, []);
});

test('two seeds fold into one hop list at the nearest distance, and the cut list travels with them', () => {
  const index = idx();
  const a = impactOf(index, F('saveInvoice', 'db.ts'), { hops: 2 });
  const b = impactOf(index, F('submit'), { hops: 2 });
  const doc = impactTestsV1(index, [{ report: a }, { report: b }], IDENTITY);
  assert.deepEqual(validate(doc, SCHEMA()), []);
  assert.deepEqual(doc.seeds.map((s) => s.name), ['saveInvoice', 'submit']);
  // `submit` is a seed here, so it is not listed as its own dependent; the route is at hop 1
  const hop1 = doc.hops.find((h) => h.hop === 1)!.nodes.map((n) => n.name);
  assert.deepEqual(hop1, ['POST /invoices'], 'nearest hop across both seeds, seeds themselves excluded');
  // nothing was cut here, and an empty cut list is the honest answer rather than a fixture to force:
  // both 2-hop walks end where the code ends
  assert.deepEqual(doc.cut, []);
  assert.deepEqual(impactTestsV1(index, [{ report: impactOf(index, TABLE, { hops: 2 }) }], IDENTITY).cut
    .every((c) => IMPACT_CUT_REASONS.includes(c.reason)), true);
});

test('run-level only: a coverage report proves a run reached the code and cannot name a case to re-run', () => {
  const nodes: GraphNode[] = [
    node(TABLE, 'table', 'invoices'), fn('only', 'a.ts', 1),
    node(`${R}::test::unit run · db`, 'test', 'unit run · db', {
      loc: { repo: R, path: 'coverage/db/coverage-final.json', line: 1 },
      test: { level: 'unit', runner: 'vitest', suite: [], file: 'coverage/db/coverage-final.json', runLevel: true },
    }),
    node(`${R}::test::skipped case`, 'test', 'skipped case', {
      loc: { repo: R, path: 'a.spec.ts', line: 3 },
      test: { level: 'unit', runner: 'vitest', suite: [], file: 'a.spec.ts', inactive: true },
    }),
  ];
  const edges: GraphEdge[] = [
    edge('reads', F('only', 'a.ts'), TABLE, 2, res('raw-sql', 'HIGH')),
    { id: 'c1', kind: 'covers', from: `${R}::test::unit run · db`, to: F('only', 'a.ts'), meta: { evidence: 'observed' }, resolution: res('coverage-report', 'HIGH') },
  ];
  const index = buildIndex(nodes, edges);
  const doc = impactTestsV1(index, [{ report: impactOf(index, TABLE, { hops: 1 }) }], IDENTITY);
  assert.deepEqual(validate(doc, SCHEMA()), []);
  assert.deepEqual(doc.unselectable, [{ node: F('only', 'a.ts'), name: 'only', reason: 'run-level only' }]);
  assert.deepEqual(doc.select, {}, 'a run is not a case: nothing here can be selected');
  assert.equal(doc.hops[0]!.nodes[0]!.tests[0]!.line, null, 'a report has no line');
  assert.equal(doc.hops[0]!.nodes[0]!.tests[0]!.run_level, true);
  assert.equal(doc.hops[0]!.nodes[0]!.tests[0]!.evidence_class, 'observed');

  // the same node covered only by a skipped case reads `inactive`, not `no covers edge`
  const withSkip = buildIndex(nodes, [...edges,
    { id: 'c2', kind: 'covers', from: `${R}::test::skipped case`, to: F('only', 'a.ts'), meta: { evidence: 'static', inactive: true } } as GraphEdge,
  ]);
  const doc2 = impactTestsV1(withSkip, [{ report: impactOf(withSkip, TABLE, { hops: 1 }) }], IDENTITY);
  assert.deepEqual(doc2.unselectable, [{ node: F('only', 'a.ts'), name: 'only', reason: 'inactive' }]);
});

test('the gate can pass: every changed thing and its direct dependents have a test a job can run', () => {
  const nodes: GraphNode[] = [
    fn('only', 'a.ts', 1), fn('caller', 'b.ts', 1),
    node(`${R}::test::covers only`, 'test', 'covers only', {
      loc: { repo: R, path: 'a.spec.ts', line: 3 },
      test: { level: 'unit', runner: 'vitest', suite: [], file: 'a.spec.ts', project: 'a' },
    }),
    node(`${R}::test::covers caller`, 'test', 'covers caller', {
      loc: { repo: R, path: 'b.pw.spec.ts', line: 9 },
      test: { level: 'e2e', runner: 'playwright', suite: [], file: 'b.pw.spec.ts', project: 'api' },
    }),
  ];
  const edges: GraphEdge[] = [
    edge('calls', F('caller', 'b.ts'), F('only', 'a.ts'), 2, res('static-import', 'HIGH')),
    { id: 'c1', kind: 'covers', from: `${R}::test::covers only`, to: F('only', 'a.ts'), meta: { evidence: 'observed' } } as GraphEdge,
    { id: 'c2', kind: 'covers', from: `${R}::test::covers caller`, to: F('caller', 'b.ts'), meta: { evidence: 'static' } } as GraphEdge,
  ];
  const index = buildIndex(nodes, edges);
  const doc = impactTestsV1(index, [{ report: impactOf(index, F('only', 'a.ts'), { hops: 1 }) }], IDENTITY);
  assert.deepEqual(validate(doc, SCHEMA()), []);
  assert.deepEqual(doc.unselectable, []);
  assert.equal(doc.fallback, null);
  assert.equal(doc.fallback_reason, null);
  assert.deepEqual(Object.keys(doc.select).sort(), ['playwright', 'vitest']);
  assert.equal(doc.bound, 'exact', 'nothing cut, nothing unstamped, nothing chosen at run time');
  // and a caller who knows the graph is stale says so, which is a fallback of its own
  assert.equal(impactTestsV1(index, [{ report: impactOf(index, F('only', 'a.ts'), { hops: 1 }) }], IDENTITY, { digestMatches: false }).fallback, 'run-all');
});

test('the floor says what each tally counts, and never claims the opposite', () => {
  // Two wordings this sentence shipped with, both found by reading it on a real graph:
  //  - a tally of cut points rendered as "14 hops", which reads as a hop count;
  //  - paths crossing an edge that records NOTHING described as recording "how it
  //    was resolved" — the inverse of the fact.
  const ix = buildIndex(
    [
      { id: 'r::t::x', kind: 'table', name: 'x', repo: 'r' },
      { id: 'r::f::a', kind: 'function', name: 'a', repo: 'r' },
      { id: 'r::f::b', kind: 'function', name: 'b', repo: 'r' },
      { id: 'r::f::c', kind: 'function', name: 'c', repo: 'r' },
    ] as never,
    [
      { kind: 'reads', from: 'r::f::a', to: 'r::t::x' },
      { kind: 'calls', from: 'r::f::b', to: 'r::f::a' },
      { kind: 'calls', from: 'r::f::c', to: 'r::f::b' },
    ] as never,
  );
  const r = impactOf(ix, 'r::t::x', { hops: 1 });
  assert.equal(r.bound, 'floor', 'a walk that stopped is a floor');
  const note = r.uncertainty?.note ?? '';
  assert.match(note, /reached the hop budget/, 'a cut tally must name what stopped the walk');
  assert.doesNotMatch(note, /\d+ hops\b/, 'a tally of cut points must not read as a count of hops');
  assert.doesNotMatch(
    note,
    /cross an edge that records how it was resolved/,
    'an unstamped path records nothing — the sentence must not claim the opposite',
  );
  if (/cross an edge/.test(note)) assert.match(note, /records nothing/, 'say what is absent');
});

// ── the tests reaching each distance: a union, never a sum (story swarm 2026-09-25) ──

/** The shop, plus a test that covers a node at hop 1 *and* one at hop 2, and a test that covers only hop 2. */
function twoHopTests(): ReturnType<typeof buildIndex> {
  const { nodes, edges } = shop();
  const t = (name: string, level: 'unit' | 'e2e') => node(`${R}::test::${name}`, 'test', name, {
    loc: { repo: R, path: `${name}.spec.ts`, line: 1 },
    test: { level, runner: level === 'e2e' ? 'playwright' : 'vitest', suite: [], file: `${name}.spec.ts`, project: 'p' },
  } as Partial<GraphNode>);
  const covers = (test: string, to: string): GraphEdge =>
    ({ id: `covers|${test}|${to}`, kind: 'covers', from: `${R}::test::${test}`, to, meta: { evidence: 'static' }, resolution: res('import-resolution', 'HIGH') });
  return buildIndex(
    [...nodes, t('both', 'e2e'), t('far', 'unit')],
    [...edges, covers('both', F('saveInvoice', 'db.ts')), covers('both', F('submit')), covers('far', F('submit'))],
  );
}

test('tests reaching hops 1–N are one set: a test met at two distances is counted once, and the number never goes down', () => {
  const r = impactOf(twoHopTests(), TABLE, { hops: 3, tests: true });
  // hop 1: saveInvoice is covered by `saves a draft` and `both`
  const perHop = r.hops.map((h) => new Set(h.nodes.flatMap((n) => (n.tests ?? []).map((x) => x.id))).size);
  assert.deepEqual(perHop, [2, 2, 0], 'the covering sets per distance, before any union');
  const reach = [1, 2, 3].map((h) => impactTestsReaching(r, h));
  // union: hop 1 = {saves a draft, both}; hops 1–2 adds `far` only — `both` is already in
  assert.deepEqual(reach.map((x) => x.total), [2, 3, 3], 'each test once, however many distances it reaches');
  assert.notEqual(reach[1]!.total, perHop[0]! + perHop[1]!, 'never the sum of the per-distance sets (4)');
  assert.notEqual(reach[1]!.total, 1, 'never only what is new at this distance — the defect the viewer shipped');
  for (let i = 1; i < reach.length; i++) assert.ok(reach[i]!.total >= reach[i - 1]!.total, 'a value "so far" cannot go down');
  // the breakdowns are partitions of the same union
  for (const x of reach) {
    assert.equal(Object.values(x.byLevel).reduce((a, b) => a + b, 0), x.total);
    assert.equal(Object.values(x.byEvidence).reduce((a, b) => a + b, 0), x.total);
    assert.equal(new Set(x.tests.map((t) => t.id)).size, x.total);
  }
  assert.deepEqual(reach[1]!.byLevel, { unit: 2, e2e: 1 });
  // still no total of dependents anywhere on the report
  assert.ok(!('total' in r));
});

test('the business sentence has a singular for every count it prints', () => {
  // "1 things use …", "1 tests reach them" were on screen (story swarm 2026-09-25):
  // the viewer picks `<key>One` when a count is one, so the pair has to exist
  for (const k of ['impact.biz.uses', 'impact.biz.actions', 'impact.biz.journeysOf', 'impact.biz.evidence.direct', 'impact.biz.evidence.near']) {
    const many = STRINGS[k], one = STRINGS[`${k}One`];
    assert.ok(many && one, `${k} has no singular`);
    assert.match(many!.professional, /\{n\}/, `${k} prints its count`);
    assert.doesNotMatch(one!.professional, /\{n\}/, `${k}One is a plural with a placeholder`);
    assert.doesNotMatch(one!.professional, /\b1 (things|actions|tests)\b/, `${k}One disagrees with its 1`);
  }
  for (const k of ['impact.biz.line', 'impact.biz.lineNoFlow']) {
    assert.doesNotMatch(STRINGS[k]!.professional, /\{direct\} things/, `${k} hard-codes a plural beside its count`);
  }
});
