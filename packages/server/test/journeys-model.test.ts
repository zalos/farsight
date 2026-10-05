// The viewer's fallback fold of the journeys organised persona → group
// (docs/proposals/journey-organisation-and-config-files.md §4.1, §4.3): the
// module the viewer imports (`public/app/lib/journeys-model.js`), held to the
// proposal's rules on a synthetic `/api/design` answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const M = await import(join(here, '..', 'public', 'app', 'lib', 'journeys-model.js'));

type Row = Record<string, unknown>;
const flow = (id: string, extra: Row = {}): Row => ({
  nodeId: `app::flow::${id}`, id, name: extra['name'] ?? id, screens: ['CON-01'], built: 1, total: 1, status: 'both', ...extra,
});
const ids = (tree: any) => tree.personas.map((p: any) => [p.id, p.groups.map((g: any) => [g.id, g.journeys.map((j: any) => j.id)])]);

// the shape of §4.1's example, written out of order on purpose: /api/design sorts flows by name
const designs = [{
  repo: 'app',
  personas: [
    { id: 'contractor', name: 'Contractor', description: 'A vendor who submits and tracks invoices.' },
    { id: 'ops', name: 'Operations' },
  ],
  groups: [
    { id: 'access', name: 'Access', description: 'Ways in and out.' },
    { id: 'vendor-accounts', name: 'Vendor accounts', persona: 'contractor' },
    { id: 'invoices', name: 'Invoices' },
  ],
  screens: [],
  flows: [
    flow('vendor-account-creation', { name: 'Create a vendor account', persona: ['contractor', 'ops'], group: 'vendor-accounts', screens: ['CON-03', 'OPS-04'], built: 1, total: 2 }),
    flow('contractor-sign-in', { name: 'Sign in with email', persona: 'contractor', group: 'access', order: 1 }),
    flow('contractor-sign-out', { name: 'Sign out', persona: 'Contractor', group: 'Access', order: 2 }),
    flow('ops-sign-in', { name: 'Sign in with the directory', persona: 'ops', group: 'access' }),
    flow('submit', { name: 'Submit an invoice', persona: 'contractor', group: 'invoices' }),
    flow('track', { name: 'Track an invoice', persona: 'contractor', group: 'invoices' }),
  ],
}];
// the manifest's order, as the graph keeps it
const manifest = ['contractor-sign-in', 'contractor-sign-out', 'vendor-account-creation', 'ops-sign-in', 'track', 'submit'];
const ordinal = (nodeId: string) => manifest.indexOf(nodeId.split('::').pop()!);

test('personas in declared order, groups in declared order, journeys by order then manifest order', () => {
  const tree = M.treeFrom(designs, null, { ordinal });
  assert.deepEqual(ids(tree), [
    ['contractor', [
      ['access', ['contractor-sign-in', 'contractor-sign-out']],
      ['vendor-accounts', ['vendor-account-creation']],
      // no order on either: the manifest wrote track before submit, and that wins over the name
      ['invoices', ['track', 'submit']],
    ]],
    ['ops', [
      ['access', ['ops-sign-in']],
      // a group declared for the contractor is not ops's: under ops the shared journey sits in Other journeys
      ['_other', ['vendor-account-creation']],
    ]],
  ]);
});

test('a persona or group value matches by id, else by name, case-insensitive and trimmed', () => {
  const tree = M.treeFrom(designs, null, { ordinal });
  const access = tree.personas[0].groups[0];
  assert.equal(access.name, 'Access');
  assert.equal(access.description, 'Ways in and out.');
  assert.ok(access.journeys.some((j: any) => j.id === 'contractor-sign-out'), '"Contractor" / "Access" by name');
  assert.equal(tree.personas[0].description, 'A vendor who submits and tracks invoices.');
});

test('a journey for two people is listed under each and counted once in the tree', () => {
  const tree = M.treeFrom(designs, null, { ordinal });
  assert.equal(tree.counts.journeys.n, 6);
  assert.equal(tree.counts.journeys.scope, 'count.scope.workspace');
  assert.equal(tree.personas[0].counts.journeys.n, 5);
  assert.equal(tree.personas[1].counts.journeys.n, 2);
  assert.equal(tree.personas[0].counts.journeys.scope, 'count.scope.persona');
  assert.equal(tree.personas[0].groups[0].counts.journeys.scope, 'count.scope.group');
  assert.deepEqual(M.placesOf(tree, 'app::flow::vendor-account-creation').map((x: any) => x.persona.id), ['contractor', 'ops']);
  assert.equal(M.journeysInOrder(tree).length, 6);
  // built counts only journeys every screen of which is built, out of the journeys beside it
  assert.equal(tree.personas[0].counts.built.n, 4);
  assert.equal(tree.personas[0].counts.built.of, 5);
  assert.equal(tree.personas[0].counts.built.unit, 'count.unit.journeysBuilt');
  assert.equal(tree.personas[0].counts.built.bizUnit, 'count.unit.journeysBuilt', 'printed in the business lens too');
  // rows carry where they sit, as core's rows do
  const shared = tree.personas[1].groups[1].journeys[0];
  assert.deepEqual([shared.personaIds, shared.personaNames, shared.groupId, shared.statusKey], [['contractor', 'ops'], ['Contractor', 'Operations'], '_other', 'journey.status.partly']);
});

test('a manifest written before this pass: undeclared personas alphabetically, no persona last, the prefix fallback is derived', () => {
  const tree = M.treeFrom([{
    repo: 'app', screens: [], flows: [
      flow('b', { persona: 'Operations' }),
      flow('a', { persona: 'Contractor and Operations' }),
      flow('c', { persona: 'Contractor' }),
      flow('d', { screens: ['INV-01', 'INV-02'] }),
      flow('e', { screens: ['A-1', 'B-2'] }),
    ],
  }], null, {});
  assert.deepEqual(tree.personas.map((p: any) => [p.id, p.name, p.declared, !!p.derived, p.key]),
    [['Contractor', 'Contractor', false, false, undefined], ['Contractor and Operations', 'Contractor and Operations', false, false, undefined],
      ['INV', 'INV', false, true, undefined], ['Operations', 'Operations', false, false, undefined], ['_none', '', false, false, 'portfolio.noPersona']]);
  assert.equal(tree.derived, true);
  // no group anywhere: one trailing *Other journeys* group under each persona, counted once per persona
  for (const p of tree.personas) assert.deepEqual(p.groups.map((g: any) => [g.id, g.key]), [['_other', 'journeys.noGroup']]);
  assert.equal(tree.counts.groups.n, 5);
});

test('undeclared groups follow the declared ones alphabetically; no group is last', () => {
  const tree = M.treeFrom([{
    repo: 'app', screens: [], groups: [{ id: 'access', name: 'Access' }], flows: [
      flow('x', { persona: 'p', group: 'Zebra' }),
      flow('y', { persona: 'p', group: 'Apple' }),
      flow('z', { persona: 'p' }),
      flow('w', { persona: 'p', group: 'access' }),
    ],
  }], null, {});
  assert.deepEqual(tree.personas[0].groups.map((g: any) => [g.id, g.declared]), [['access', true], ['Apple', false], ['Zebra', false], ['_other', false]]);
});

test('the config overrides a flow\'s placement by id and orders personas first (meta.journeys)', () => {
  const metas = {
    app: {
      personas: [{ id: 'ops', name: 'Operations', declared: true, from: 'farsight.config.json' }],
      groups: [],
      flows: { 'contractor-sign-in': { persona: 'ops', group: 'access', order: 0, from: 'farsight.config.json', index: 0 } },
      notes: ['flow "x" is named by farsight.config.json but no manifest declares it'],
    },
  };
  const tree = M.treeFrom(designs, metas, { ordinal });
  assert.equal(tree.personas[0].id, 'ops', 'the config\'s order is the order');
  assert.deepEqual(tree.personas[0].groups[0].journeys.map((j: any) => [j.id, j.placedBy]), [['contractor-sign-in', 'farsight.config.json'], ['ops-sign-in', undefined]]);
  assert.deepEqual(tree.notes, metas.app.notes);
});

test('the pinned way in is marked per persona and does not move', () => {
  const tree = M.treeFrom([{
    repo: 'app', screens: [], flows: [
      flow('small', { persona: 'p', screens: ['A-1'], total: 1 }),
      flow('wide', { persona: 'p', screens: ['A-1', 'A-2', 'A-3'], built: 2, total: 3 }),
      flow('needs', { persona: 'p', screens: ['A-1', 'A-2', 'A-3', 'A-4'], total: 4, built: 4, requires: ['small'] }),
    ],
  }], null, { ordinal: (id: string) => ['small', 'wide', 'needs'].indexOf(id.split('::').pop()!) });
  const js = tree.personas[0].groups[0].journeys;
  assert.deepEqual(js.map((j: any) => [j.id, j.pinned]), [['small', false], ['wide', true], ['needs', false]]);
});

test('requires, leadsTo, group and order come from the node when the design row leaves them out', () => {
  const nodes: Record<string, any> = { 'app::flow::a': { design: { requires: ['b'], leadsTo: ['c'], group: 'g', order: 3, persona: ['p', 'q'] } } };
  const tree = M.treeFrom([{ repo: 'app', screens: [], flows: [flow('a')] }], null, { nodeOf: (id: string) => nodes[id] });
  const j = tree.personas[0].groups[0].journeys[0];
  assert.deepEqual([j.requires, j.leadsTo, j.group, j.order, j.repo], [['b'], ['c'], 'g', 3, 'app']);
  assert.deepEqual(tree.personas.map((p: any) => p.name), ['p', 'q']);
});

test('filterTree narrows by persona and group without recounting', () => {
  const tree = M.treeFrom(designs, null, { ordinal });
  const f = M.filterTree(tree, 'contractor', 'access');
  assert.deepEqual(ids(f), [['contractor', [['access', ['contractor-sign-in', 'contractor-sign-out']]]]]);
  assert.equal(f.counts.journeys.n, 6, 'the tree\'s total is the tree\'s');
  assert.equal(M.filterTree(tree, null, null), tree);
  assert.deepEqual(ids(M.filterTree(tree, null, 'access')).map((x: any) => x[0]), ['contractor', 'ops']);
});

test('storylines: declared order, steps in order across personas, multi-membership, a journey out of scope a note; storylineOf and findStoryline', () => {
  const metas = { app: { personas: [], groups: [], flows: {}, notes: [], storylines: [
    { id: 'vendor', name: 'A vendor account', journeys: ['contractor-sign-in', 'vendor-account-creation', 'ops-sign-in'], declared: true, from: 'm.json' },
    { id: 'leave', name: 'Leaving', description: 'Out.', journeys: ['vendor-account-creation', 'gone', 'contractor-sign-out'], declared: true, from: 'farsight.config.json' },
  ] } };
  const tree = M.treeFrom(designs, metas, { ordinal });
  assert.deepEqual(tree.storylines.map((s: any) => [s.id, s.journeys.map((j: any) => `${j.stepIndex}:${j.id}`)]), [
    ['vendor', ['0:contractor-sign-in', '1:vendor-account-creation', '2:ops-sign-in']],
    ['leave', ['0:vendor-account-creation', '1:contractor-sign-out']],
  ]);
  assert.equal(tree.storylines[1].notes.length, 1, 'the journey no row has is a note');
  assert.equal(tree.counts.storylines.n, 2);
  assert.equal(tree.counts.storylines.scope, 'count.scope.workspace');
  assert.deepEqual([tree.storylines[0].counts.journeys.n, tree.storylines[0].counts.built.n, tree.storylines[0].counts.built.of], [3, 2, 3]);
  assert.equal(tree.storylines[0].counts.journeys.scope, 'count.scope.storyline');
  const rows = tree.personas.flatMap((p: any) => p.groups.flatMap((g: any) => g.journeys)).filter((j: any) => j.id === 'vendor-account-creation');
  assert.equal(rows.length, 2);
  for (const r of rows) assert.deepEqual(r.storylines, ['vendor', 'leave']);
  const at = M.storylineOf(tree, 'app::flow::vendor-account-creation');
  assert.deepEqual(at.map((x: any) => [x.storyline.id, x.step, x.of, x.prev && x.prev.id, x.next && x.next.id]), [['vendor', 2, 3, 'contractor-sign-in', 'ops-sign-in'], ['leave', 1, 2, null, 'contractor-sign-out']]);
  assert.deepEqual(M.storylineOf(tree, 'track'), [], 'a journey in no storyline');
  assert.equal(M.findStoryline(tree, 'LEAVING').id, 'leave');
  assert.equal(M.findStoryline(tree, 'nope'), null);
  assert.deepEqual(M.treeFrom(designs, null, { ordinal }).storylines, [], 'no meta, no storylines');
});

// ── parity with core: the fallback draws what /api/journeys answers ──────────
import { GraphStore, buildIndex, designSurface, journeyTree, type GraphNode, type GraphEdge, type GraphMeta } from '@farsight/core';
import { ingestRepo } from '@farsight/parsers';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** The parts of a tree a surface draws, with a trailing bucket's name left to the surface (it carries `key`). */
function drawn(tree: any) {
  const c = (x: any) => [x.n, x.of ?? null, x.unit, x.bizUnit, x.scope];
  return {
    personas: tree.personas.map((p: any) => ({
      id: p.id, name: p.key ? '' : p.name, key: p.key, declared: p.declared, derived: !!p.derived, description: p.description,
      counts: [c(p.counts.journeys), c(p.counts.built)],
      groups: p.groups.map((g: any) => ({
        id: g.id, name: g.key ? '' : g.name, key: g.key, declared: g.declared, description: g.description,
        counts: [c(g.counts.journeys), c(g.counts.built)],
        journeys: g.journeys.map((j: any) => [j.nodeId, j.designId, j.groupId, j.pinned, j.statusKey, j.placedBy ?? null, j.personaIds, j.storylines]),
      })),
    })),
    storylines: tree.storylines.map((s: any) => ({
      id: s.id, name: s.name, description: s.description, repo: s.repo, from: s.from, notes: s.notes,
      counts: [c(s.counts.journeys), c(s.counts.built)],
      journeys: s.journeys.map((j: any) => [j.stepIndex, j.nodeId, j.statusKey, j.storylines]),
    })),
    counts: [c(tree.counts.journeys), c(tree.counts.personas), c(tree.counts.groups), c(tree.counts.storylines)],
    derived: tree.derived, notes: tree.notes,
  };
}

test('on the invoice-app fixture the fallback fold draws exactly what core journeyTree answers — with today\'s rows and with an older server\'s', async () => {
  const fixture = join(here, '..', '..', '..', 'examples', 'invoice-app');
  const dir = mkdtempSync(join(tmpdir(), 'farsight-jrn-parity-'));
  try {
    const store = new GraphStore();
    const fragment = await ingestRepo(fixture, { repoName: 'invoice-app' });
    store.roots[fragment.repo] = fixture;
    store.addFragment(fragment);
    store.save(join(dir, 'graph.json'));
    const data = JSON.parse(readFileSync(join(dir, 'graph.json'), 'utf8')) as { nodes: GraphNode[]; edges: GraphEdge[]; meta: GraphMeta };
    const index = buildIndex(data.nodes, data.edges);
    const core = journeyTree(index, data.meta.journeys);
    assert.ok(core.personas.length >= 2 && core.personas[0]!.groups.length >= 1, 'the fixture declares personas and groups');
    assert.deepEqual(core.storylines.map((s) => s.journeys.map((j) => j.id)), [['new-invoice', 'draft-and-send', 'billing-cycle']], 'the fixture declares one storyline');
    const designs = JSON.parse(JSON.stringify(designSurface(index, null)));
    const nodeOf = (id: string) => index.byId.get(id) ?? null;
    assert.deepEqual(drawn(M.treeFrom(designs, data.meta.journeys, { nodeOf })), drawn(core));
    // an older /api/design: flows by name, none of the organisation's fields — the node and its place in the graph fill them
    const flowAt = new Map(data.nodes.filter((n) => n.kind === 'flow').map((n, i) => [n.id, i]));
    const older = designs.map((d: any) => ({ ...d, flows: d.flows.map((f: any) => {
      const { position, group, order, requires, leadsTo, repo, ...rest } = f;
      void position; void group; void order; void requires; void leadsTo; void repo;
      return { ...rest, ...(typeof rest.persona === 'string' ? {} : { persona: undefined }) };
    }) }));
    assert.deepEqual(drawn(M.treeFrom(older, data.meta.journeys, { nodeOf, ordinal: (id: string) => flowAt.get(id) ?? null })), drawn(core));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
