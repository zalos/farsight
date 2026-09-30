// One absence word per fact — the story swarm of 2026-09-25, finding 4.
//
// Measured on the reference app's invoice-submission flow before this was changed: of the
// 60 empty (action, layer) cells the Timeline and the Sheet both draw, 43 wore
// two words — *not involved* on the Timeline, *none indexed* on the Sheet — for
// Records, Azure Document Intelligence and Business Central. Each view chose its
// own word. The word is now decided once, in `journeyAbsence()`, and every view
// reads it; these tests pin the rule and the agreement between the shapes each
// view consumes (rows / sheet / drill read `absent.moments`, the storyboard's
// ledger `absent.kinds`, the ladder's folded columns `absent.screen`).
//
// In-memory fixtures (core has no parser dependency). Runs against the built
// package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndex, journey, journeySummary, screensFor, stepCoverage, STRINGS, ABSENCE_WORDS, ABSENCE_KINDS, absenceWord,
} from '../dist/index.js';
import type { GraphNode, GraphEdge, OperationContract, JourneySummary } from '../dist/index.js';

const R = 'app';
const API = `${R}::api::openapi.yaml`;
const FLOW = `${R}::flow::things`;
const C = 'api/client.ts';
const SV = 'server/svc.ts';

const fn = (name: string, path: string, line: number): GraphNode =>
  ({ id: `${R}::${path}::${name}`, kind: 'function', name, tags: [], loc: { repo: R, path, line } }) as GraphNode;
const route = (name: string, line: number, operationId: string): GraphNode =>
  ({
    id: `${R}::route::${name}`, kind: 'route', name, tags: [], loc: { repo: R, path: 'server/routes.ts', line },
    contract: { status: 'both', apiId: API, summary: `${operationId} summary`, spec: { operationId } } as OperationContract,
  }) as GraphNode;
const e = (kind: GraphEdge['kind'], from: string, to: string, line: number): GraphEdge =>
  ({ id: `${kind}|${from}|${to}|${line}`, kind, from, to, meta: { line } });
const id = (path: string, name: string) => `${R}::${path}::${name}`;

/**
 * One screen, three actions: *list* reads the `things` table; *ping* reaches the
 * server and touches no table; *create* writes the table through a helper one
 * hop deeper than list's read. No queue anywhere — the journey has no messages.
 */
function things(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    { id: FLOW, kind: 'flow', name: 'Things', tags: [] } as GraphNode,
    { id: API, kind: 'api', name: 'Thing API', tags: [] } as GraphNode,
    { id: `${R}::page::/things`, kind: 'page', name: '/things', tags: [], loc: { repo: R, path: 'ui/router.tsx', line: 3 } } as GraphNode,
    { id: id('ui/Things.tsx', 'Things'), kind: 'component', name: 'Things', tags: [], loc: { repo: R, path: 'ui/Things.tsx', line: 1 } } as GraphNode,
    fn('listThings', C, 4), fn('pingThing', C, 8), fn('createThing', C, 12),
    route('GET /things', 5, 'listThings'), route('GET /ping', 6, 'pingThing'), route('POST /things', 7, 'createThing'),
    fn('listThings', SV, 3), fn('ping', SV, 9), fn('createThing', SV, 14), fn('persist', SV, 20),
    { id: `${R}::table::things`, kind: 'table', name: 'things', tags: [] } as GraphNode,
  ];
  const edges: GraphEdge[] = [
    e('renders', FLOW, `${R}::page::/things`, 1),
    e('renders', `${R}::page::/things`, id('ui/Things.tsx', 'Things'), 2),
    e('calls', id('ui/Things.tsx', 'Things'), id(C, 'listThings'), 3),
    e('calls', id('ui/Things.tsx', 'Things'), id(C, 'pingThing'), 4),
    e('calls', id('ui/Things.tsx', 'Things'), id(C, 'createThing'), 5),
    e('http', id(C, 'listThings'), `${R}::route::GET /things`, 5),
    e('http', id(C, 'pingThing'), `${R}::route::GET /ping`, 9),
    e('http', id(C, 'createThing'), `${R}::route::POST /things`, 13),
    e('calls', `${R}::route::GET /things`, id(SV, 'listThings'), 6),
    e('calls', `${R}::route::GET /ping`, id(SV, 'ping'), 7),
    e('calls', `${R}::route::POST /things`, id(SV, 'createThing'), 8),
    e('reads', id(SV, 'listThings'), `${R}::table::things`, 4),
    e('calls', id(SV, 'createThing'), id(SV, 'persist'), 15),
    e('writes', id(SV, 'persist'), `${R}::table::things`, 21),
  ];
  return { nodes, edges };
}

const fold = (maxDepth?: number): JourneySummary => {
  const { nodes, edges } = things();
  const index = buildIndex(nodes, edges);
  return journeySummary(index, journey(index, FLOW, maxDepth ? { maxDepth } : {}), screensFor(index, FLOW));
};
/** The action whose call is this operation. */
const action = (sum: JourneySummary, op: string) => {
  const sg = sum.segments.find((s) => s.moments.some((mo) => mo.label.startsWith(op)))!;
  return { sg, mo: sg.moments.find((mo) => mo.label.startsWith(op))! };
};

test('the six absence words are a closed set, each a catalog key with a define', () => {
  assert.deepEqual([...ABSENCE_WORDS], ['noneIndexed', 'notBuilt', 'notInvolved', 'notReached', 'notIndexed', 'notTranslated'],
    'six words — adding a seventh is the failure mode the clarity phase existed to remove');
  const absentKeys = Object.keys(STRINGS).filter((k) => k.startsWith('journey.absent.')).map((k) => k.slice('journey.absent.'.length));
  assert.deepEqual(absentKeys.sort(), [...ABSENCE_WORDS].sort(), 'the catalog carries exactly the six');
  // the two a journey cell is most often read with say which fact they name
  for (const w of ['noneIndexed', 'notInvolved', 'notReached']) {
    assert.ok((STRINGS[`journey.absent.${w}`]!.define ?? '').length > 30, `journey.absent.${w} has no define: its fact cannot be looked up`);
  }
});

test('the rule: none indexed is about the journey, not reached about a cut, not involved about this action', () => {
  assert.equal(absenceWord({ inJourney: false, cutBefore: false }), 'noneIndexed');
  assert.equal(absenceWord({ inJourney: false, cutBefore: true }), 'noneIndexed', 'a kind the journey has none of is none indexed whatever the walk did');
  assert.equal(absenceWord({ inJourney: true, cutBefore: true }), 'notReached');
  assert.equal(absenceWord({ inJourney: true, cutBefore: false }), 'notInvolved');
});

test('an action that does not touch a layer the journey has reads *not involved* — never *none indexed*', () => {
  const sum = fold();
  assert.ok(sum.systems.some((r) => r.key === 'records'), 'the journey reads and writes a table');
  const { sg, mo } = action(sum, 'pingThing');
  // the Sheet printed *none indexed* here, the Timeline *not involved*
  assert.equal(sg.absent!.moments[mo.index]!.records, 'notInvolved');
  assert.equal(sg.absent!.kinds[mo.index]!.records, 'notInvolved', 'the storyboard ledger reads the same word');
  // a layer this action does use has no absence word at all
  const list = action(sum, 'listThings');
  assert.equal(list.sg.absent!.moments[list.mo.index]!.records, undefined);
  assert.equal(list.sg.absent!.kinds[list.mo.index]!.records, undefined);
});

test('a kind the whole journey has none of reads *none indexed* on every action and on the journey', () => {
  const sum = fold();
  assert.equal(sum.absentKinds!.messages, 'noneIndexed', 'no queue anywhere: the drill\'s always-present Messages row');
  for (const sg of sum.segments) for (const mo of sg.moments) assert.equal(sg.absent!.kinds[mo.index]!.messages, 'noneIndexed');
  assert.equal(sum.absentKinds!.records, undefined, 'the journey has records');
});

test('a walk cut inside an action says *not reached* for the layers past the cut, and nowhere else', () => {
  // depth 6 reaches createThing on the server and cuts persist — the write is never walked
  const full = fold();
  const cut = fold(6);
  const c = action(cut, 'createThing');
  assert.ok(c.sg.cutPoints.some((p) => p.moment === c.mo.index), 'the create action carries a cut');
  assert.equal(c.sg.absent!.moments[c.mo.index]!.records, 'notReached', 'the table persist writes lies past the cut');
  assert.equal(c.sg.absent!.kinds[c.mo.index]!.records, 'notReached');
  // without the cut the same action writes the table: no absence
  const f = action(full, 'createThing');
  assert.equal(f.sg.absent!.moments[f.mo.index]!.records, undefined);
  // the action that simply never touches a table is still *not involved*, cut or not
  const p = action(cut, 'pingThing');
  assert.equal(p.sg.absent!.moments[p.mo.index]!.records, 'notInvolved');
});

test('one word per (action, layer) fact across every shape a view consumes', () => {
  for (const sum of [fold(), fold(6)]) {
    const kindOf = new Map(sum.systems.map((r) => [r.key, r.kind] as const));
    for (const sg of sum.segments) {
      const a = sg.absent!;
      for (const mo of sg.moments) {
        const used = new Set(sg.markers.filter((m) => m.moment === mo.index).map((m) => m.system));
        const cell = a.moments[mo.index]!;
        for (const r of sum.systems) {
          const browserOpen = r.kind === 'repo' && r.side === 'ux' && !!mo.component;
          // rows · sheet · drill: every empty cell has exactly one word, every used one none
          if (used.has(r.key) || browserOpen) assert.equal(cell[r.key], undefined, `${r.key} is used in action ${mo.index}`);
          else assert.ok(ABSENCE_WORDS.includes(cell[r.key]!), `${r.key} in action ${mo.index} has no word`);
        }
        // the storyboard's ledger (by kind) says what the rows say, for a kind with one system
        for (const k of ABSENCE_KINDS) {
          const rows = sum.systems.filter((r) => r.kind === k);
          if (rows.length !== 1) continue;
          assert.equal(a.kinds[mo.index]![k], cell[rows[0]!.key], `${k}: ledger and rows disagree on action ${mo.index}`);
        }
      }
      // the ladder's folded column for a system the whole screen leaves empty: *not reached*
      // exactly when some action's cell for it says so, else *not involved* like every cell
      for (const [key, w] of Object.entries(a.screen)) {
        const cells = sg.moments.map((mo) => a.moments[mo.index]![key]);
        assert.ok(cells.every(Boolean), `${key} is folded on the ladder but used by an action`);
        assert.equal(w, cells.includes('notReached') ? 'notReached' : 'notInvolved', `${key}: ladder and rows disagree`);
        assert.ok(kindOf.has(key));
      }
    }
  }
});

// ── one step, two scopes ────────────────────────────────────────────────
//
// *72 tests* on the Submit action's Verified-by cell and *no test reaches this
// step* on the route handler in the same column: the action counts every test
// reaching any part of the action, the step only the tests reaching that part.
// Both are true; neither said its scope. The fold types both numbers with their
// scopes, and the step's foot prints the action's number beside its own absence.

test('a step no test reaches, inside an action tests do reach: two scopes, each named, never one bare word', () => {
  const S2 = 'src/orders.ts';
  const f2 = (name: string, line: number): GraphNode =>
    ({ id: `shop::${S2}::${name}`, kind: 'function', name, tags: [], loc: { repo: 'shop', path: S2, line, endLine: line + 4 } }) as GraphNode;
  const nodes: GraphNode[] = [
    { id: 'shop::flow::order', kind: 'flow', name: 'Order', tags: [] } as GraphNode,
    { id: 'shop::page::/orders', kind: 'page', name: '/orders', tags: [], loc: { repo: 'shop', path: 'src/ui/Orders.tsx', line: 1 } } as GraphNode,
    { id: 'shop::route::POST /orders', kind: 'route', name: 'POST /orders', tags: [], loc: { repo: 'shop', path: S2, line: 2 } } as GraphNode,
    f2('placeOrder', 10), f2('audit', 30),
    { id: 'shop::test::src/o.spec.ts::totals', kind: 'test', name: 'totals', tags: ['test'], loc: { repo: 'shop', path: 'src/o.spec.ts', line: 3 },
      test: { level: 'unit', runner: 'vitest', suite: [], file: 'src/o.spec.ts' } } as GraphNode,
  ];
  const edges: GraphEdge[] = [
    { id: 'r1', kind: 'renders', from: 'shop::flow::order', to: 'shop::page::/orders', meta: { line: 1 } } as GraphEdge,
    { id: 'h1', kind: 'http', from: 'shop::page::/orders', to: 'shop::route::POST /orders', meta: { line: 2 } } as GraphEdge,
    { id: 'c1', kind: 'calls', from: 'shop::route::POST /orders', to: `shop::${S2}::placeOrder`, meta: { line: 3 } } as GraphEdge,
    { id: 'c2', kind: 'calls', from: `shop::${S2}::placeOrder`, to: `shop::${S2}::audit`, meta: { line: 12 } } as GraphEdge,
    { id: 'covers|t|p', kind: 'covers', from: 'shop::test::src/o.spec.ts::totals', to: `shop::${S2}::placeOrder`, meta: { evidence: 'static' },
      resolution: { status: 'resolved', technique: 'import-resolution', confidence: 'MEDIUM' } } as GraphEdge,
  ];
  const index = buildIndex(nodes, edges);
  const j = journey(index, 'shop::flow::order');
  const sum = journeySummary(index, j, screensFor(index, 'shop::flow::order'));
  const auditStep = j.steps.find((s) => s.nodeId === `shop::${S2}::audit`)!;
  const sg = sum.segments.find((x) => auditStep.order >= x.from && auditStep.order <= x.to)!;
  const k = sg.moments.findIndex((mo) => auditStep.order >= mo.from && auditStep.order <= mo.to);
  const act = sum.coverage!.moments![sg.index]![k]!;
  // the action is reached; the step alone is not
  assert.equal(act.counted.tests.n, 1);
  assert.equal(act.counted.tests.scope, 'count.scope.action');
  // what the server attaches to each step of /api/journey: the node's own fold
  const own = stepCoverage(index, `shop::${S2}::audit`);
  assert.ok(!own || !own.counted || own.counted.tests.n === 0, 'no test reaches audit itself');
  const place = stepCoverage(index, `shop::${S2}::placeOrder`)!;
  assert.equal(place.counted!.tests.scope, 'count.scope.node', 'a step\'s own number is scoped to the part alone');
  assert.notEqual(place.counted!.tests.scope, act.counted.tests.scope, 'two numbers, two printed scopes');
  // the sentence the step's foot prints beside its absence names the wider scope and says the two differ
  const wider = STRINGS['journey.tests.widerScope']!;
  assert.match(wider.professional, /\{n\}/);
  assert.match(wider.professional, /action/);
  assert.ok((wider.define ?? '').length > 30);
  for (const s of ['count.scope.action', 'count.scope.node', 'journey.scopeHere']) assert.ok(STRINGS[s], `${s} is the scope a foot prints`);
});
