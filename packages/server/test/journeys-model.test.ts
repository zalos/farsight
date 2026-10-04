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
      // a group scoped to the contractor still holds the shared journey under ops: the journey names it
      ['vendor-accounts', ['vendor-account-creation']],
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
  // built counts only journeys every screen of which is built
  assert.equal(tree.personas[0].counts.built.n, 4);
  assert.equal(tree.personas[0].counts.built.unit, 'count.unit.journeysBuilt');
});

test('a persona\'s breakdown by group adds up to its count', () => {
  const tree = M.treeFrom(designs, null, { ordinal });
  const c = tree.personas[0].counts.journeys;
  assert.equal(c.breakdown.reduce((a: number, p: any) => a + p.n, 0), c.n);
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
  assert.deepEqual(tree.personas.map((p: any) => [p.name, p.declared]),
    [['Contractor', false], ['Contractor and Operations', false], ['INV', false], ['Operations', false], ['', false]]);
  assert.equal(tree.derived, true);
  // no group anywhere: one trailing *Other journeys* group under each persona
  for (const p of tree.personas) assert.deepEqual(p.groups.map((g: any) => g.id), ['']);
  assert.equal(tree.counts.groups.n, 1);
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
  assert.deepEqual(tree.personas[0].groups.map((g: any) => [g.name, g.declared]), [['Access', true], ['Apple', false], ['Zebra', false], ['', false]]);
});

test('the config overrides a flow\'s placement by id and orders personas first (meta.journeys)', () => {
  const metas = {
    app: {
      personas: [{ id: 'ops', name: 'Operations', declared: true, from: 'farsight.config.json' }],
      groups: [],
      flows: { 'contractor-sign-in': { persona: 'ops', group: 'access', order: 0, from: 'farsight.config.json' } },
      notes: ['flow "x" is named by farsight.config.json but no manifest declares it'],
    },
  };
  const tree = M.treeFrom(designs, metas, { ordinal });
  assert.equal(tree.personas[0].id, 'ops', 'the config\'s order is the order');
  assert.deepEqual(tree.personas[0].groups[0].journeys.map((j: any) => j.id), ['contractor-sign-in', 'ops-sign-in']);
  assert.deepEqual(tree.notes, metas.app.notes);
});

test('the pinned way in is marked and does not move', () => {
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
