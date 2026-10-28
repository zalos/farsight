// A persona per screen (lane persona, 2026-10-13): a journey for two kinds of person still has screens only one of
// them uses. The outsiders learned *contractors approve themselves* because an operator's review screen inside a
// journey for the contractor and the operator was drawn in the contractor's lane, the WALK said *Contractor uses it*
// and ASK credited the contractor. Four rules, strongest first — the screen's own row, a persona's routes, the
// identity guard its code meets, the journey — each recorded with where it came from; a disagreement is a note.
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndex,
  applyDesignToFragment,
  journeysMetaOf,
  journeyTree,
  pickJourneys,
  journeyTreeLines,
  personaOfScreen,
  screenPersonasOfFlow,
  screenPersonaNotes,
  withScreenPersonas,
  countedProblems,
  sanitizeJourneys,
  tourOf,
} from '../dist/index.js';
import type {
  GraphNode,
  GraphEdge,
  GraphFragment,
  DesignManifest,
  JourneysConfig,
  JourneysMeta,
  FarsightConfig,
} from '../dist/index.js';

const R = 'app';
const page = (route: string, line: number): GraphNode =>
  ({
    id: `${R}::page::${route}`,
    kind: 'page',
    name: route,
    tags: [],
    loc: { repo: R, path: 'router.tsx', line },
  }) as GraphNode;
const comp = (name: string, line: number): GraphNode =>
  ({
    id: `${R}::ui.tsx::${name}`,
    kind: 'component',
    name,
    tags: [],
    loc: { repo: R, path: 'ui.tsx', line },
  }) as GraphNode;
const route = (name: string, line: number): GraphNode =>
  ({ id: `${R}::api.ts::${name}`, kind: 'route', name, tags: [], loc: { repo: R, path: 'api.ts', line } }) as GraphNode;
const guard = (fn: string, words: string, group: string | undefined, line: number): GraphNode =>
  ({
    id: `${R}::auth.ts::${fn}`,
    kind: 'guard',
    name: `${fn}: ${words}`,
    tags: ['auth'],
    ...(group ? { group } : {}),
    loc: { repo: R, path: 'auth.ts', line },
  }) as GraphNode;
let seq = 0;
const edge = (kind: GraphEdge['kind'], from: string, to: string): GraphEdge =>
  ({
    id: `e${seq++}`,
    kind,
    from,
    to,
    resolution: { status: 'resolved', technique: 'import-trace', confidence: 'HIGH' },
  }) as GraphEdge;

/**
 * The reference app's shape, small: a vendor-account journey for the contractor and the operator whose last two
 * screens are the operator's review page and the decision component it renders; each side's routes signed in by
 * its own session guard (the guard's `@group` is the persona's id).
 */
function vendorApp(
  opts: {
    routes?: boolean;
    screenPersona?: Record<string, string>;
    config?: JourneysConfig;
    groups?: boolean;
    signsInWith?: boolean;
  } = {},
) {
  const manifest: DesignManifest = {
    personas: [
      {
        id: 'contractor',
        name: 'Contractor',
        ...(opts.signsInWith ? { signsInWith: ['requireContractorSession'] } : {}),
      },
      {
        id: 'ops',
        name: 'Operator',
        ...(opts.routes ? { routes: ['/ops/**'] } : {}),
        ...(opts.signsInWith ? { signsInWith: ['requireOpsSession'] } : {}),
      },
    ],
    screens: [
      {
        id: 'CON-02',
        route: '/me',
        ...(opts.screenPersona?.['CON-02'] ? { persona: opts.screenPersona['CON-02'] } : {}),
      },
      { id: 'CON-03', route: '/me/vendor-accounts/new' },
      {
        id: 'OPS-04c',
        route: '/ops/vendor-accounts/[id]',
        ...(opts.screenPersona?.['OPS-04c'] ? { persona: opts.screenPersona['OPS-04c'] } : {}),
      },
      { id: 'OPS-04c.approved', component: 'VendorAccountDecision' },
      { id: 'OPS-01', route: '/ops/sign-in' },
    ],
    flows: [
      {
        id: 'vendor-account-creation',
        name: 'Create a vendor account',
        persona: ['contractor', 'ops'],
        screens: ['CON-02', 'CON-03', 'OPS-04c', 'OPS-04c.approved'],
      },
      { id: 'ops-sign-in', name: 'Operator sign-in', persona: 'ops', screens: ['OPS-01'] },
    ],
  };
  const me = page('/me', 1),
    add = page('/me/vendor-accounts/new', 2),
    review = page('/ops/vendor-accounts/:param', 3),
    signIn = page('/ops/sign-in', 4);
  const decision = comp('VendorAccountDecision', 10);
  const listMine = route('GET /api/me/vendor-accounts', 20),
    create = route('POST /api/me/vendor-accounts', 21);
  const getOne = route('GET /api/ops/vendor-accounts/:id', 22),
    approve = route('POST /api/ops/vendor-accounts/:id/approve', 23);
  const con = guard(
    'requireContractorSession',
    'contractorSession required',
    opts.groups === false ? undefined : 'contractor',
    30,
  );
  const ops = guard('requireOpsSession', 'entraSession required', opts.groups === false ? undefined : 'ops', 31);
  const nodes = [me, add, review, signIn, decision, listMine, create, getOne, approve, con, ops];
  const edges = [
    edge('http', me.id, listMine.id),
    edge('http', add.id, create.id),
    edge('http', review.id, getOne.id),
    edge('renders', review.id, decision.id),
    edge('http', decision.id, approve.id),
    edge('guards', con.id, listMine.id),
    edge('guards', con.id, create.id),
    edge('guards', ops.id, getOne.id),
    edge('guards', ops.id, approve.id),
  ];
  const fragment: GraphFragment = { repo: R, nodes, edges, meta: { files: 1, sourceHash: 'x' } };
  applyDesignToFragment(fragment, manifest, { repo: R, path: 'docs/design/screens.json' });
  const meta = journeysMetaOf([{ manifest, path: 'docs/design/screens.json' }], opts.config);
  const index = buildIndex(fragment.nodes, fragment.edges);
  return {
    index,
    metas: { [R]: meta } as Record<string, JourneysMeta>,
    flow: `${R}::flow::vendor-account-creation`,
    ids: { me: me.id, add: add.id, review: review.id, decision: decision.id, signIn: signIn.id },
  };
}
const placed = (list: { designId?: string; persona: string; personaFrom: string }[]) =>
  list.map((x) => `${x.designId}=${x.persona}/${x.personaFrom}`);

test("with nothing declared and no guard tied to a persona, every screen takes its journey's first persona — as before", () => {
  const g = vendorApp({ groups: false });
  assert.deepEqual(placed(screenPersonasOfFlow(g.index, g.metas, g.flow)), [
    'CON-02=contractor/journey',
    'CON-03=contractor/journey',
    'OPS-04c=contractor/journey',
    'OPS-04c.approved=contractor/journey',
  ]);
});

test("the identity guard a screen's code meets places it, when its @group is a declared persona — the reference app's case", () => {
  const g = vendorApp();
  assert.deepEqual(placed(screenPersonasOfFlow(g.index, g.metas, g.flow)), [
    'CON-02=contractor/guard',
    'CON-03=contractor/guard',
    'OPS-04c=ops/guard',
    'OPS-04c.approved=ops/guard',
  ]);
  const x = personaOfScreen(g.index, g.metas, g.ids.review, g.flow)!;
  assert.equal(x.personaName, 'Operator');
  assert.deepEqual(x.evidence, [`${R}::auth.ts::requireOpsSession`], 'the guard it met is cited');
  // a screen whose code meets no persona's guard takes the journey's persona; read outside a journey, nobody
  assert.equal(personaOfScreen(g.index, g.metas, g.ids.signIn, `${R}::flow::ops-sign-in`)?.personaFrom, 'journey');
  assert.equal(personaOfScreen(g.index, g.metas, g.ids.signIn), undefined);
});

test('personas[].signsInWith names the guard when no @group says whose it is', () => {
  const none = vendorApp({ groups: false });
  assert.equal(personaOfScreen(none.index, none.metas, none.ids.review, none.flow)?.personaFrom, 'journey');
  const g = vendorApp({ groups: false, signsInWith: true });
  assert.deepEqual(placed(screenPersonasOfFlow(g.index, g.metas, g.flow)).slice(2), [
    'OPS-04c=ops/guard',
    'OPS-04c.approved=ops/guard',
  ]);
});

test('personas[].routes places a page by its route and a component by the pages that render it; it wins over the guard', () => {
  const g = vendorApp({ routes: true, groups: false });
  assert.deepEqual(placed(screenPersonasOfFlow(g.index, g.metas, g.flow)), [
    'CON-02=contractor/journey',
    'CON-03=contractor/journey',
    'OPS-04c=ops/routes',
    'OPS-04c.approved=ops/routes',
  ]);
  const x = personaOfScreen(g.index, g.metas, g.ids.decision, g.flow)!;
  assert.deepEqual(x.evidence, ['/ops/** ← /ops/vendor-accounts/:param']);
  // '/ops/**' covers '/ops' itself and nothing outside it
  const both = vendorApp({ routes: true });
  assert.equal(
    personaOfScreen(both.index, both.metas, both.ids.signIn, `${R}::flow::ops-sign-in`)?.personaFrom,
    'routes',
  );
  assert.equal(
    personaOfScreen(both.index, both.metas, both.ids.review, both.flow)?.personaFrom,
    'routes',
    'routes before the guard',
  );
});

test('screens[].persona wins over everything, and a disagreement with the routes or the guard is a note, not a silent choice', () => {
  const g = vendorApp({ routes: true, screenPersona: { 'OPS-04c': 'contractor', 'CON-02': 'ops' } });
  const list = screenPersonasOfFlow(g.index, g.metas, g.flow);
  assert.deepEqual(placed(list).slice(0, 3), [
    'CON-02=ops/screen',
    'CON-03=contractor/guard',
    'OPS-04c=contractor/screen',
  ]);
  const notes = screenPersonaNotes(g.index, g.metas);
  assert.ok(
    notes.some(
      (n) =>
        n.includes('screen OPS-04c is declared for persona "contractor"') &&
        n.includes('"ops"') &&
        n.includes('/ops/**'),
    ),
    notes.join('\n'),
  );
  assert.ok(
    notes.some(
      (n) =>
        n.includes('screen CON-02 is placed with "ops" by its screen row') &&
        n.includes('sign-in guard of "contractor"') &&
        n.includes('requireContractorSession'),
    ),
    notes.join('\n'),
  );
  // the tree prints them: the journeys tool, farsight journeys and GET /api/journeys read tree.notes
  const tree = journeyTree(g.index, g.metas);
  assert.ok(
    tree.notes.some((n) => n.includes('screen OPS-04c is declared for persona')),
    tree.notes.join('\n'),
  );
  assert.ok(journeyTreeLines(tree).some((l) => l.includes('screen CON-02 is placed with "ops"')));
});

test("two personas' globs matching a route equally say nothing for it, with a note", () => {
  const cfg = sanitizeJourneys({
    journeys: {
      personas: [
        { id: 'contractor', routes: ['/ops/*/*'] },
        { id: 'ops', routes: '/ops/vendor-accounts/*' },
      ],
    },
  } as unknown as FarsightConfig).journeys!;
  const g = vendorApp({ groups: false, config: cfg });
  assert.deepEqual(
    g.metas[R]!.personas.map((p) => [p.id, p.routes]),
    [
      ['contractor', ['/ops/*/*']],
      ['ops', ['/ops/vendor-accounts/*']],
    ],
    'the config gives routes; a lone string is a list of one',
  );
  // `/ops/vendor-accounts/*` is the more specific of the two for the review page
  assert.equal(personaOfScreen(g.index, g.metas, g.ids.review, g.flow)?.persona, 'ops');
  const tie = vendorApp({
    groups: false,
    config: {
      personas: [
        { id: 'contractor', routes: ['/ops/**'] },
        { id: 'ops', routes: ['/ops/**'] },
      ],
    },
  });
  assert.equal(personaOfScreen(tie.index, tie.metas, tie.ids.review, tie.flow)?.personaFrom, 'journey');
  assert.ok(
    screenPersonaNotes(tie.index, tie.metas).some((n) =>
      n.includes('matches the routes of "contractor" and "ops" equally'),
    ),
  );
});

test("a screen meeting two personas' sign-in guards is placed by neither", () => {
  const g = vendorApp();
  // the contractor's page also calls an operator route
  const extra = edge('http', g.ids.me, `${R}::api.ts::GET /api/ops/vendor-accounts/:id`);
  const index = buildIndex([...g.index.byId.values()], [...[...g.index.out.values()].flat(), extra]);
  assert.equal(personaOfScreen(index, g.metas, g.ids.me, g.flow)?.personaFrom, 'journey');
});

test('JourneyRow.screenPersonas, the counts by source and per persona, the CLI line and pickJourneys', () => {
  const g = vendorApp({ routes: true });
  const tree = journeyTree(g.index, g.metas);
  const row = tree.personas
    .flatMap((p) => p.groups.flatMap((x) => x.journeys))
    .find((j) => j.id === 'vendor-account-creation')!;
  assert.deepEqual(placed(row.screenPersonas), [
    'CON-02=contractor/guard',
    'CON-03=contractor/guard',
    'OPS-04c=ops/routes',
    'OPS-04c.approved=ops/routes',
  ]);
  const sc = tree.counts.screens!;
  assert.deepEqual(countedProblems(sc), []);
  assert.equal(sc.n, 5, 'each screen once — the four of the vendor journey and the sign-in');
  assert.equal(sc.scope, 'count.scope.workspace');
  assert.deepEqual(
    sc.breakdown!.map((b) => [b.key, b.n]),
    [
      ['count.part.personaFromRoutes', 3],
      ['count.part.personaFromGuard', 2],
    ],
  );
  assert.equal(
    sc.breakdown!.reduce((n, b) => n + b.n, 0),
    sc.n,
    'the parts sum',
  );
  const by = Object.fromEntries(tree.personas.map((p) => [p.id, p.counts.screens!.n]));
  assert.deepEqual(
    by,
    { contractor: 2, ops: 3 },
    "an operator screen in a journey listed under the contractor is the operator's",
  );
  for (const p of tree.personas) assert.deepEqual(countedProblems(p.counts.screens!), []);
  const lines = journeyTreeLines(tree);
  assert.ok(
    lines.some((l) => l.includes('Create a vendor account') && l.includes('with Operator (2 of 4 screens)')),
    lines.join('\n'),
  );
  const picked = pickJourneys(tree, { persona: 'contractor' });
  assert.equal(picked.personas[0]!.counts.screens!.n, 2);
});

test("withScreenPersonas stamps who uses each screen onto a journey answer's screens", () => {
  const g = vendorApp();
  const user = [{ id: g.ids.me }, { id: g.ids.review }, { id: 'app::nope' }] as {
    id: string;
    persona?: string;
    personaName?: string;
    personaFrom?: string;
  }[];
  withScreenPersonas(g.index, g.metas, user as never, g.flow);
  assert.deepEqual(
    user.map((u) => [u.persona, u.personaName, u.personaFrom]),
    [
      ['contractor', 'Contractor', 'guard'],
      ['ops', 'Operator', 'guard'],
      [undefined, undefined, undefined],
    ],
  );
});

test("the WALK says who uses each screen: the operator on the operator's review, citing the guard", () => {
  const g = vendorApp();
  const tour = tourOf(g.index, g.flow, { metas: g.metas })!;
  const who = tour.stops
    .filter((s) => s.kind === 'screen')
    .map((s) => [s.screen.name, s.clauses.find((c) => c.key === 'tour.screen.who')?.text]);
  assert.ok(who.length >= 3, JSON.stringify(who));
  const review = tour.stops.find((s) => s.kind === 'screen' && s.screen.id === g.ids.review)!;
  const c = review.clauses.find((x) => x.key === 'tour.screen.who')!;
  assert.equal(c.text, 'Operator uses it.');
  assert.ok(c.cites.includes(`${R}::auth.ts::requireOpsSession`), 'the guard that placed it is cited');
  assert.equal(review.persona?.id, 'ops');
  const mine = tour.stops.find((s) => s.kind === 'screen' && s.screen.id === g.ids.me)!;
  assert.equal(mine.clauses.find((x) => x.key === 'tour.screen.who')!.text, 'Contractor uses it.');
});
