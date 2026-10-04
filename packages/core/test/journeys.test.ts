// Journeys organised by persona and group (docs/proposals/journey-organisation-and-config-files.md §4):
// journeysMetaOf at ingest, journeyTree at request time — matching by id then name, undeclared
// values after the declared ones, the derived and trailing fallbacks, the declared order, the
// config's overrides and notes, one flow under two personas, the per-persona way in, and every
// count a sound Counted whose parts agree. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndex, applyDesignToFragment, designSurface, journeysMetaOf, journeyTree, pickJourneys, journeyPlacements,
  journeyTreeLines, journeyTreeSummary, countedProblems, sanitizeJourneys, JOURNEY_NO_PERSONA, JOURNEY_NO_GROUP,
} from '../dist/index.js';
import type { GraphNode, GraphFragment, DesignManifest, JourneysConfig, JourneyTree, FarsightConfig } from '../dist/index.js';

type Screen = DesignManifest['screens'][number];
type Flow = NonNullable<DesignManifest['flows']>[number];

/** A repo whose pages are the `built` routes, with every manifest applied in order, and its meta. */
function graph(manifests: { manifest: DesignManifest; path: string }[], built: string[] = [], config?: JourneysConfig, repo = 'app') {
  const nodes: GraphNode[] = built.map((r, i) => ({ id: `${repo}::page::${r}`, kind: 'page', name: r, tags: [], loc: { repo, path: 'router.tsx', line: i + 1 } }) as GraphNode);
  const fragment: GraphFragment = { repo, nodes, edges: [], meta: { files: 1, sourceHash: 'x' } };
  for (const m of manifests) applyDesignToFragment(fragment, m.manifest, { repo, path: m.path });
  return { fragment, meta: journeysMetaOf(manifests, config) };
}
function treeOf(g: ReturnType<typeof graph>, scope?: Set<string> | null): JourneyTree {
  return journeyTree(buildIndex(g.fragment.nodes, g.fragment.edges), { [g.fragment.repo]: g.meta }, scope);
}
const screen = (id: string, route: string): Screen => ({ id, route });
const flow = (id: string, screens: string[], extra: Partial<Flow> = {}): Flow => ({ id, name: extra.name ?? id, screens, ...extra });
/** persona › group › journey ids, the shape a reader sees */
const shape = (t: JourneyTree) => t.personas.map((p) => `${p.name}: ${p.groups.map((g) => `${g.name}[${g.journeys.map((j) => j.id).join(',')}]`).join(' ')}`);
function soundCounts(t: JourneyTree): void {
  const all = [t.counts.journeys, t.counts.personas, t.counts.groups,
    ...t.personas.flatMap((p) => [p.counts.journeys, p.counts.built, ...p.groups.flatMap((g) => [g.counts.journeys, g.counts.built])])];
  for (const c of all) assert.deepEqual(countedProblems(c), [], JSON.stringify(c));
  for (const p of t.personas) {
    assert.equal(p.counts.journeys.n, p.groups.reduce((n, g) => n + g.counts.journeys.n, 0), `${p.name}: the groups sum to the persona`);
    assert.equal(p.counts.built.n, p.groups.reduce((n, g) => n + g.counts.built.n, 0));
    for (const g of p.groups) assert.equal(g.counts.journeys.n, g.journeys.length);
  }
  const unique = new Set(t.personas.flatMap((p) => p.groups.flatMap((g) => g.journeys.map((j) => j.nodeId))));
  assert.equal(t.counts.journeys.n, unique.size, 'the tree counts each journey once');
  assert.equal(t.counts.personas.n, t.personas.length);
  assert.equal(t.counts.groups.n, t.personas.reduce((n, p) => n + p.groups.length, 0));
  assert.equal(t.counts.journeys.scope, 'count.scope.workspace');
}

const SCREENS = [screen('CON-01', '/sign-in'), screen('CON-02', '/sign-out'), screen('CON-03', '/vendors/new'), screen('OPS-01', '/ops/sign-in'), screen('OPS-04', '/ops/vendors')];

/** The proposal's §4.1 example, verbatim in shape. */
const PORTAL: DesignManifest = {
  name: 'Contractor portal — screens',
  personas: [
    { id: 'contractor', name: 'Contractor', description: 'A vendor who submits and tracks invoices.' },
    { id: 'ops', name: 'Operations', description: 'The team that verifies vendors and approves invoices.' },
  ],
  groups: [
    { id: 'access', name: 'Access', description: 'Ways in and out.' },
    { id: 'vendor-accounts', name: 'Vendor accounts', persona: 'contractor' },
    { id: 'invoices', name: 'Invoices' },
    { id: 'vendors', name: 'Manage vendors', persona: 'ops' },
  ],
  screens: SCREENS,
  flows: [
    flow('contractor-sign-in', ['CON-01'], { name: 'Sign in with email', persona: 'contractor', group: 'access', order: 1 }),
    flow('contractor-sign-out', ['CON-02'], { name: 'Sign out', persona: 'contractor', group: 'access', order: 2 }),
    flow('vendor-account-creation', ['CON-03', 'OPS-04'], { name: 'Create a vendor account', persona: ['contractor', 'ops'], group: 'vendor-accounts' }),
    flow('ops-sign-in', ['OPS-01'], { name: 'Sign in with the directory', persona: 'ops', group: 'access' }),
  ],
};

test('the proposal example: personas and groups in declared order, a two-persona journey under each, a persona-only group kept to its persona', () => {
  const t = treeOf(graph([{ manifest: PORTAL, path: 'docs/design/screens.json' }], ['/sign-in', '/sign-out', '/vendors/new', '/ops/sign-in']));
  assert.deepEqual(shape(t), [
    'Contractor: Access[contractor-sign-in,contractor-sign-out] Vendor accounts[vendor-account-creation]',
    // vendor-accounts belongs to the contractor: under Operations the same journey is in Other journeys
    'Operations: Access[ops-sign-in] Other journeys[vendor-account-creation]',
  ]);
  assert.equal(t.counts.journeys.n, 4, 'four journeys, though one is shown twice');
  assert.equal(t.counts.personas.n, 2);
  assert.equal(t.counts.groups.n, 4);
  const ops = t.personas[1]!;
  assert.equal(ops.groups[1]!.id, JOURNEY_NO_GROUP);
  assert.equal(ops.groups[1]!.key, 'journeys.noGroup');
  assert.equal(ops.description, 'The team that verifies vendors and approves invoices.');
  const shared = ops.groups[1]!.journeys[0]!;
  assert.deepEqual(shared.personaIds, ['contractor', 'ops']);
  assert.deepEqual(shared.personaNames, ['Contractor', 'Operations']);
  assert.equal(shared.status, 'design-only');
  assert.equal(shared.built, 1);
  assert.equal(shared.total, 2);
  assert.equal(shared.statusKey, 'journey.status.partly');
  assert.equal(shared.repo, 'app');
  assert.equal(shared.designId, 'app::design::docs/design/screens.json');
  assert.deepEqual(journeyPlacements(t, shared.nodeId).map((w) => `${w.persona} › ${w.group}`), ['Contractor › Vendor accounts', 'Operations › Other journeys']);
  soundCounts(t);
});

test('a manifest written before personas reads as it did: undeclared personas alphabetically, no groups, the manifest order kept', () => {
  const m: DesignManifest = {
    screens: SCREENS,
    flows: [
      flow('z-first', ['CON-01'], { name: 'Zebra comes first in the manifest', persona: 'Operations' }),
      flow('a-second', ['CON-02'], { name: 'Aardvark second', persona: 'Operations' }),
      flow('contractor', ['CON-03'], { name: 'Contractor flow', persona: 'contractor' }),
      flow('mixed', ['CON-01', 'OPS-01'], { name: 'No persona, two prefixes' }),
      flow('prefixed', ['OPS-01', 'OPS-04'], { name: 'No persona, one prefix' }),
    ],
  };
  const t = treeOf(graph([{ manifest: m, path: 'docs/design/screens.json' }], ['/sign-in']));
  assert.deepEqual(shape(t), [
    'contractor: Other journeys[contractor]',
    'Operations: Other journeys[z-first,a-second]',
    'OPS: Other journeys[prefixed]',
    'Not grouped: Other journeys[mixed]',
  ]);
  assert.ok(t.personas.every((p) => !p.declared));
  assert.equal(t.derived, true);
  assert.equal(t.personas[2]!.derived, true);
  assert.equal(t.personas[3]!.id, JOURNEY_NO_PERSONA);
  assert.equal(t.personas[3]!.key, 'portfolio.noPersona');
  assert.deepEqual(t.notes, []);
  // designSurface keeps its own order (by name) — the tree restores the author's
  assert.deepEqual(designSurface(buildIndex(graph([{ manifest: m, path: 'p' }]).fragment.nodes, graph([{ manifest: m, path: 'p' }]).fragment.edges))[0]!.flows.map((f) => f.id),
    ['a-second', 'contractor', 'prefixed', 'mixed', 'z-first']);
  soundCounts(t);
});

test('matching: a declared persona or group by id, else by name, case-insensitive and trimmed; an unknown group is its own after the declared', () => {
  const m: DesignManifest = {
    personas: [{ id: 'ops', name: 'Operations' }],
    groups: [{ id: 'access', name: 'Ways in' }],
    screens: SCREENS,
    flows: [
      flow('a', ['OPS-01'], { persona: '  OPERATIONS ', group: 'ways IN' }),
      flow('b', ['OPS-04'], { persona: 'Ops', group: 'Zeta' }),
      flow('c', ['OPS-04'], { persona: 'ops', group: 'alpha' }),
      flow('d', ['OPS-04'], { persona: 'ops' }),
    ],
  };
  const t = treeOf(graph([{ manifest: m, path: 'm.json' }]));
  assert.deepEqual(shape(t), ['Operations: Ways in[a] alpha[c] Zeta[b] Other journeys[d]']);
  assert.equal(t.personas[0]!.declared, true);
  assert.deepEqual(t.personas[0]!.groups.map((g) => g.declared), [true, false, false, false]);
});

test('order: ascending inside a group, the ones without an order after, ties in manifest order', () => {
  const m: DesignManifest = {
    personas: [{ id: 'p', name: 'P' }],
    screens: SCREENS,
    flows: [
      flow('none-1', ['CON-01'], { persona: 'p' }),
      flow('three', ['CON-01'], { persona: 'p', order: 3 }),
      flow('one-b', ['CON-01'], { persona: 'p', order: 1 }),
      flow('none-2', ['CON-01'], { persona: 'p' }),
      flow('one-a', ['CON-01'], { persona: 'p', order: 1 }),
    ],
  };
  const t = treeOf(graph([{ manifest: m, path: 'm.json' }]));
  assert.deepEqual(shape(t), ['P: Other journeys[one-b,one-a,three,none-1,none-2]']);
});

test('the config: its arrays are the order, an entry overrides field by field, a placement moves a flow, an unknown flow id is a note', () => {
  const config: JourneysConfig = sanitizeJourneys({ journeys: {
    personas: [{ id: 'ops' }, { id: 'auditor', name: 'Auditor' }],
    groups: [{ id: 'invoices', name: 'Invoices and payments' }],
    flows: [
      { id: 'ops-sign-in', order: 0, group: 'invoices' },
      { id: 'contractor-sign-out', persona: ['contractor', 'ops'] },
      { id: 'no-such-flow', group: 'access' },
    ],
  } } as FarsightConfig).journeys!;
  const g = graph([{ manifest: PORTAL, path: 'docs/design/screens.json' }], [], config);
  // the config named ops first but gave no name: the manifest's name fills it
  assert.deepEqual(g.meta.personas.map((p) => `${p.id}=${p.name}@${p.from}`), [
    'ops=Operations@farsight.config.json', 'auditor=Auditor@farsight.config.json', 'contractor=Contractor@docs/design/screens.json']);
  assert.equal(g.meta.personas[0]!.description, 'The team that verifies vendors and approves invoices.');
  assert.deepEqual(g.meta.groups.map((x) => x.id), ['invoices', 'access', 'vendor-accounts', 'vendors']);
  assert.equal(g.meta.groups[0]!.name, 'Invoices and payments');
  assert.deepEqual(Object.keys(g.meta.flows), ['ops-sign-in', 'contractor-sign-out']);
  assert.deepEqual(g.meta.notes, ['flow "no-such-flow" is named by farsight.config.json but no manifest declares it']);
  const t = treeOf(g);
  assert.deepEqual(shape(t), [
    // auditor is declared but nothing is for them: no heading
    'Operations: Invoices and payments[ops-sign-in] Access[contractor-sign-out] Other journeys[vendor-account-creation]',
    'Contractor: Access[contractor-sign-in,contractor-sign-out] Vendor accounts[vendor-account-creation]',
  ]);
  const moved = t.personas[0]!.groups[0]!.journeys[0]!;
  assert.equal(moved.placedBy, 'farsight.config.json');
  assert.equal(moved.group, 'invoices', 'the row carries the placement the tree used');
  assert.equal(moved.order, 0);
  assert.deepEqual(t.notes, g.meta.notes);
  assert.equal(t.counts.journeys.n, 4);
  soundCounts(t);
});

test('the way in, per persona: the first journey nothing requires with something built and the most screens', () => {
  const m: DesignManifest = {
    personas: [{ id: 'c', name: 'C' }, { id: 'o', name: 'O' }],
    screens: SCREENS,
    flows: [
      flow('small', ['CON-01'], { persona: 'c' }),
      flow('big', ['CON-01', 'CON-02', 'CON-03'], { persona: 'c', requires: ['small'] }),
      flow('medium', ['CON-01', 'CON-02'], { persona: 'c' }),
      flow('unbuilt', ['OPS-01', 'OPS-04'], { persona: 'o' }),
      flow('also-unbuilt', ['OPS-04'], { persona: 'o' }),
    ],
  };
  const t = treeOf(graph([{ manifest: m, path: 'm.json' }], ['/sign-in', '/sign-out', '/vendors/new']));
  const pinned = t.personas.map((p) => p.groups.flatMap((g) => g.journeys).filter((j) => j.pinned).map((j) => j.id));
  // big has more screens but requires another; medium wins. O has nothing built: its first entry
  assert.deepEqual(pinned, [['medium'], ['unbuilt']]);
  const row = t.personas[0]!.groups[0]!.journeys.find((j) => j.id === 'big')!;
  assert.deepEqual(row.requires, ['small']);
  assert.deepEqual(row.leadsTo, []);
});

test('several manifests in one source: declarations merge in discovery order, the first name kept and the other noted; a repeated flow id is one journey', () => {
  const a: DesignManifest = { personas: [{ id: 'billing', name: 'Billing' }], groups: [{ id: 'access', name: 'Access' }], screens: [screen('BW-01', '/sign-in')], flows: [flow('sign-in', ['BW-01'], { persona: 'billing', group: 'access' })] };
  const b: DesignManifest = { personas: [{ id: 'billing', name: 'Billers' }], groups: [{ id: 'invoices', name: 'Invoices', persona: 'billing' }], screens: [screen('BIL-01', '/invoices')], flows: [flow('invoices', ['BIL-01'], { persona: 'billing', group: 'invoices' }), flow('sign-in', ['BIL-01'], { persona: 'billing' })] };
  const g = graph([{ manifest: a, path: 'apps/web/docs/design/screens.json' }, { manifest: b, path: 'docs/design/screens.json' }], ['/sign-in', '/invoices']);
  assert.deepEqual(g.meta.notes, ['persona "billing" is declared by apps/web/docs/design/screens.json and docs/design/screens.json with different names; "Billing" from apps/web/docs/design/screens.json is kept']);
  const t = treeOf(g);
  assert.deepEqual(shape(t), ['Billing: Access[sign-in] Invoices[invoices]']);
  assert.equal(t.counts.journeys.n, 2);
  // the page the second manifest designs is not left *undesigned* by the first
  const surfaces = designSurface(buildIndex(g.fragment.nodes, g.fragment.edges));
  assert.deepEqual(surfaces.map((d) => `${d.manifestPath}: ${d.counts.codeOnly} undesigned`), ['apps/web/docs/design/screens.json: 0 undesigned', 'docs/design/screens.json: 0 undesigned']);
});

test('scope keeps the sources asked for; a graph with no meta still organises by what the flows say', () => {
  const g = graph([{ manifest: PORTAL, path: 'm.json' }]);
  const index = buildIndex(g.fragment.nodes, g.fragment.edges);
  assert.equal(journeyTree(index, { app: g.meta }, new Set(['other'])).personas.length, 0);
  const bare = journeyTree(index, undefined, null);
  assert.deepEqual(shape(bare), [
    'contractor: access[contractor-sign-in,contractor-sign-out] vendor-accounts[vendor-account-creation]',
    'ops: access[ops-sign-in] vendor-accounts[vendor-account-creation]',
  ]);
  assert.ok(bare.personas.every((p) => !p.declared));
});

test('pickJourneys narrows by persona and group (id or name) and the tree counts follow', () => {
  const t = treeOf(graph([{ manifest: PORTAL, path: 'm.json' }]));
  const ops = pickJourneys(t, { persona: 'OPERATIONS' });
  assert.deepEqual(shape(ops), ['Operations: Access[ops-sign-in] Other journeys[vendor-account-creation]']);
  assert.equal(ops.counts.journeys.n, 2);
  const access = pickJourneys(t, { group: 'access' });
  assert.equal(access.counts.personas.n, 2);
  assert.equal(access.counts.journeys.n, 3);
  soundCounts(ops);
  soundCounts(access);
});

test('the text: persona and group headings, one line per journey with its status, way in, other personas and node id', () => {
  const t = treeOf(graph([{ manifest: PORTAL, path: 'm.json' }], ['/sign-in']));
  const lines = journeyTreeLines(t, { openHint: '(open with journey)' });
  assert.equal(lines[0], '4 journeys · 2 personas · 4 groups across every source in scope');
  assert.ok(lines.includes('## Contractor — 3 journeys · 1 of 3 journeys built — A vendor who submits and tracks invoices.'));
  assert.ok(lines.includes('### Access — 2 journeys — Ways in and out.'));
  assert.ok(lines.includes('- Sign in with email — built · built 1 of 1 · start here · `app::flow::contractor-sign-in` (open with journey)'));
  assert.ok(lines.some((l) => l.startsWith('- Create a vendor account — designed, not built · 0 of 2 · also under Operations ·')), lines.join('\n'));
  assert.equal(journeyTreeSummary(t), '4 journeys · 2 personas · 4 groups across every source in scope — first: Contractor › Access · Operations › Access');
});

/**
 * The shape the reference app has (measured read-only on the dogfood server, anonymised): 18
 * flows over three persona strings and nothing declared. The combined string is a persona of
 * its own — the tree never splits a string; declaring `persona: ["contractor", "ops"]` is the
 * manifest author's fix.
 */
export const REFERENCE_SHAPED: DesignManifest = {
  screens: [screen('CON-01', '/c1'), screen('OPS-01', '/o1')],
  flows: [
    ['invoice-correction', 'Correct an invoice', 'Contractor and Operations'], ['erp-status', 'Check the ERP status', 'Operations'],
    ['email-intake', 'Invoices arriving by email', 'Operations'], ['ops-sign-in-refused', 'Sign-in refused', 'Operations'],
    ['ops-sign-in-dev', 'Sign in on a developer machine', 'Operations'], ['vendor-account-creation', 'Create a vendor account', 'Contractor and Operations'],
    ['invoice-paid', 'An invoice is paid', 'Contractor and Operations'], ['vendor-invoice', 'A vendor invoice, end to end', 'Contractor and Operations'],
    ['vendor-id-link', 'Link a vendor id', 'Contractor and Operations'], ['my-invoices', 'My invoices', 'Contractor'],
    ['contractor-sign-in', 'Sign in with email', 'Contractor'], ['invoice-submission', 'Submit an invoice', 'Contractor'],
    ['ops-sign-in', 'Sign in with the directory', 'Operations'], ['ops-invoice-by-image', 'Enter an invoice from an image', 'Operations'],
    ['vendor-account-review', 'Review a vendor account', 'Operations'], ['invoice-review', 'Review an invoice', 'Operations'],
    ['invoice-tracking', 'Track an invoice', 'Contractor'], ['weekly-cycle', 'The weekly cycle', 'Operations'],
  ].map(([id, name, persona]) => flow(id!, [persona === 'Contractor' ? 'CON-01' : 'OPS-01'], { name, persona })),
};

test('the reference-shaped manifest: three undeclared personas, the combined string one of them, each flow once', () => {
  const t = treeOf(graph([{ manifest: REFERENCE_SHAPED, path: 'docs/design/screens.json' }], ['/c1', '/o1']));
  assert.deepEqual(t.personas.map((p) => `${p.name} ${p.counts.journeys.n}`), ['Contractor 4', 'Contractor and Operations 5', 'Operations 9']);
  assert.ok(t.personas.every((p) => !p.declared && p.groups.length === 1 && p.groups[0]!.id === JOURNEY_NO_GROUP));
  // the manifest's order inside each persona, never alphabetical
  assert.deepEqual(t.personas[0]!.groups[0]!.journeys.map((j) => j.id), ['my-invoices', 'contractor-sign-in', 'invoice-submission', 'invoice-tracking']);
  assert.equal(t.counts.journeys.n, 18);
  soundCounts(t);
  // the fix is the author's: declare the personas and name both
  const fixed: DesignManifest = {
    ...REFERENCE_SHAPED,
    personas: [{ id: 'contractor', name: 'Contractor' }, { id: 'ops', name: 'Operations' }],
    flows: REFERENCE_SHAPED.flows!.map((f) => (f.persona === 'Contractor and Operations' ? { ...f, persona: ['contractor', 'ops'] } : f)),
  };
  const t2 = treeOf(graph([{ manifest: fixed, path: 'docs/design/screens.json' }], ['/c1', '/o1']));
  assert.deepEqual(t2.personas.map((p) => `${p.name} ${p.counts.journeys.n}`), ['Contractor 9', 'Operations 14']);
  assert.equal(t2.counts.journeys.n, 18);
  soundCounts(t2);
});

test('sanitizeJourneys keeps what is well formed and drops the rest, never throwing', () => {
  const c = sanitizeJourneys({ journeys: {
    personas: [{ id: ' a ', name: ' A ' }, { name: 'no id' }, 'x', { id: 'b' }],
    groups: [{ id: 'g', persona: 7, description: 'd' }, null],
    flows: [{ id: 'f', persona: [' x ', 3, ''], group: 5, order: 'one' }, { id: 'h', persona: ['only'] , order: 2 }, { group: 'no id' }],
  } } as unknown as FarsightConfig);
  assert.deepEqual(c.journeys, {
    personas: [{ id: 'a', name: 'A' }, { id: 'b' }],
    groups: [{ id: 'g', description: 'd' }],
    flows: [{ id: 'f', persona: ['x'] }, { id: 'h', persona: ['only'], order: 2 }],
  });
  assert.equal(sanitizeJourneys({ journeys: [] } as unknown as FarsightConfig).journeys, undefined);
  assert.deepEqual(sanitizeJourneys({}), {});
});
