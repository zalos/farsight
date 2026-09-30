// One number, one scope, one word — the counting defects of the visual swarm of
// 2026-09-24 (the 2026-09-24 visual-swarm review §2.1).
//
// The faults these pin, each measured on the live build before it was changed:
//
//  1. `19 things the user can do` on the reference app's submission flow, four inches above
//     nine cards captioned *actions 1–9 again* — the header counted occurrences
//     where ten operations exist. On the POC flow it read `31` while the flow
//     status table read `15` for the same flow, and fourteen of the thirty-one
//     were `via:'planned'` steps nothing implements.
//  2. `19 called` under a column headed OPERATIONS, for ten operations.
//  3. `19 declared, not called` on one surface where the storyboard's dotted
//     stops summed to 5 — one number deduplicated, the other not.
//
// In-memory fixtures (core has no parser dependency). Runs against the built
// package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, journey, journeySummary, screensFor, STRINGS } from '../dist/index.js';
import type { GraphNode, GraphEdge, OperationContract } from '../dist/index.js';

const R = 'app';
const API = `${R}::api::openapi.yaml`;
const FLOW = `${R}::flow::thing`;
const C = 'api/client.ts';

const fn = (name: string, path: string, line: number): GraphNode =>
  ({ id: `${R}::${path}::${name}`, kind: 'function', name, tags: [], loc: { repo: R, path, line } }) as GraphNode;
const comp = (name: string, path: string, line: number): GraphNode =>
  ({ id: `${R}::${path}::${name}`, kind: 'component', name, tags: [], loc: { repo: R, path, line } }) as GraphNode;
const page = (name: string, line: number, operations: string[]): GraphNode =>
  ({
    id: `${R}::page::${name}`, kind: 'page', name, tags: [], loc: { repo: R, path: 'ui/router.tsx', line },
    design: { id: `SCR-${line}`, status: 'both', origin: 'manifest', operations },
  }) as GraphNode;
const route = (name: string, line: number, operationId: string): GraphNode =>
  ({
    id: `${R}::route::${name}`, kind: 'route', name, tags: [], loc: { repo: R, path: 'server/routes.ts', line },
    contract: { status: 'both', apiId: API, summary: `${operationId} summary`, spec: { operationId } } as OperationContract,
  }) as GraphNode;
const e = (kind: GraphEdge['kind'], from: string, to: string, line: number): GraphEdge =>
  ({ id: `${kind}|${from}|${to}|${line}`, kind, from, to, meta: { line } });

/**
 * Two screens, one of which does the same thing again. `/things` lists; `/things/new`
 * lists (the same call, a walk re-visit) and creates. Both screens' manifests name
 * `deleteThing`, which the spec declares and no action makes.
 *
 * So: three action occurrences · two operations called · one of them run again ·
 * one operation declared and not called, named by two screens.
 */
function twoScreens(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    { id: FLOW, kind: 'flow', name: 'Do a thing', tags: [] } as GraphNode,
    { id: API, kind: 'api', name: 'Thing API', tags: [] } as GraphNode,
    page('/things', 8, ['listThings', 'deleteThing']),
    page('/things/new', 9, ['listThings', 'createThing', 'deleteThing']),
    comp('ThingList', 'ui/ThingList.tsx', 3),
    comp('NewThing', 'ui/NewThing.tsx', 3),
    fn('listThings', C, 4), fn('createThing', C, 10),
    route('GET /things', 5, 'listThings'),
    route('POST /things', 9, 'createThing'),
    route('DELETE /things/:id', 14, 'deleteThing'),
    fn('listThings', 'server/svc.ts', 6),
  ];
  const edges: GraphEdge[] = [
    e('renders', FLOW, `${R}::page::/things`, 1),
    e('renders', FLOW, `${R}::page::/things/new`, 2),
    e('renders', `${R}::page::/things`, `${R}::ui/ThingList.tsx::ThingList`, 8),
    e('renders', `${R}::page::/things/new`, `${R}::ui/NewThing.tsx::NewThing`, 9),
    e('calls', `${R}::ui/ThingList.tsx::ThingList`, `${R}::${C}::listThings`, 12),
    e('calls', `${R}::ui/NewThing.tsx::NewThing`, `${R}::${C}::listThings`, 7),
    e('calls', `${R}::ui/NewThing.tsx::NewThing`, `${R}::${C}::createThing`, 15),
    e('http', `${R}::${C}::listThings`, `${R}::route::GET /things`, 5),
    e('http', `${R}::${C}::createThing`, `${R}::route::POST /things`, 11),
    e('calls', `${R}::route::GET /things`, `${R}::server/svc.ts::listThings`, 6),
  ];
  return { nodes, edges };
}

const fold = () => {
  const { nodes, edges } = twoScreens();
  const index = buildIndex(nodes, edges);
  return journeySummary(index, journey(index, FLOW), screensFor(index, FLOW));
};

test('an operation two screens call is one operation, and the second time is counted as a repeat', () => {
  const sum = fold();
  const moments = sum.segments.flatMap((sg) => sg.moments);
  // the occurrences are all still there — the band draws them, with ↺ on the repeat
  assert.equal(moments.length, 3, 'three action occurrences across the two screens');
  assert.deepEqual(moments.map((mo) => mo.repeat), [false, true, false]);
  // ...and the journey-level number counts the operation once
  assert.equal(sum.counts.called, 2, 'two operations: list and create — not three occurrences of them');
  assert.equal(sum.counts.again, 1, 'the list call is made a second time on the second screen');
  // nothing is lost: the occurrence total any earlier reading printed is recoverable
  assert.equal(sum.counts.called + sum.counts.again, moments.filter((mo) => mo.callStep != null).length);
});

test('an operation two screens declare is one operation declared, not called', () => {
  const sum = fold();
  // both screens' manifests list deleteThing and no action makes it
  assert.deepEqual(sum.segments.map((sg) => sg.declaredOnly.map((d) => d.op)), [['deleteThing'], ['deleteThing']]);
  assert.equal(sum.counts.declaredNotCalled, 1, 'two screens naming one operation name one operation');
  // and it is never counted on both sides of the split
  assert.equal(sum.counts.called, 2);
});

test('the two halves of the operations split stay disjoint', () => {
  const sum = fold();
  const ops = new Set(sum.segments.flatMap((sg) => sg.moments)
    .filter((mo) => mo.callStep != null).map((mo) => mo.label));
  assert.equal(ops.has('deleteThing summary'), false, 'a declared operation is not an action of this journey');
});

test('every word that carries a number says what it counts', () => {
  // The analyst's finding, mechanically: the narrative strings had two-paragraph
  // defines and the counting words — the ones a reader has to defend in a meeting
  // — were the ones left blank.
  const counting = [
    'journey.countActions', 'journey.countAgain', 'journey.countGates', 'journey.countChecks',
    'journey.countBuilt', 'journey.countDeclaredOnly', 'journey.countScreens', 'journey.countSteps',
    'journey.countDecisions', 'journey.countSystems', 'journey.countSetup', 'journey.countAfterwards',
    'journey.countChoices', 'journey.countCut', 'journey.countCalls', 'journey.countRecords',
    'journey.countMessages', 'journey.plannedCount', 'journey.decisionsFolded', 'journey.untranslated',
    'journey.identity', 'journey.status.built', 'journey.status.partly', 'journey.status.designedNotBuilt',
    'journey.flowE2e.declared', 'journey.flowE2e.reached', 'journey.flowE2e.observed', 'journey.flowE2e.none',
    'portfolio.opsCalled', 'portfolio.col.api', 'journey.scopeAll', 'journey.scopeHere',
  ];
  for (const k of counting) {
    const entry = STRINGS[k];
    assert.ok(entry, `${k} is not in the catalog`);
    assert.ok(entry!.define && entry!.define.length > 30, `${k} carries no define: a number nobody can look up`);
  }
});

test('a count that can be one has a singular', () => {
  // `1 calls` and `1 decisions` were both on screen: a plural beside a 1 invites
  // doubt about every other number on the line. `jrnCountWord` looks for
  // `<key>One`, so the pair has to exist in the catalog for the viewer to find it.
  for (const k of ['journey.countCalls', 'journey.countRecords', 'journey.countMessages',
    'journey.countSteps', 'journey.countGates', 'journey.countDecisions', 'journey.countChecks',
    'journey.countScreens', 'journey.countSystems', 'journey.countActions', 'journey.countAgain',
    'journey.countRepeats', 'journey.countChoices', 'journey.decisionsFolded', 'journey.biz.countSteps']) {
    const one = STRINGS[`${k}One`];
    assert.ok(one, `${k} has no singular — it will print "1 ${STRINGS[k]!.professional.replace('{n} ', '')}"`);
    assert.equal(one!.professional.includes('{n}'), false, `${k}One is a plural with a placeholder`);
  }
});

test('the grammar book does not claim the registers print identical numbers', () => {
  // `journey.biz.header`'s define said "Every number is the same number the other
  // registers print — only the words differ", while business printed 89 checks not
  // in plain language and hybrid printed 68 technical conditions for one flow at
  // one sync. A false claim in the book is worse than a wrong number on a
  // dashboard, because the book is what the dashboard is defended with.
  //
  // 2026-09-25 (docs/COUNTS.md): the concept is now one number, `count.unit.notInWords`
  // (technical + unlabelled gate conditions), handed out by the core for every register.
  // A lens that still prints `journey.untranslated` prints a named *part* of it, and each
  // define says which it is — never that two different numbers are one.
  const d = STRINGS['journey.biz.header']!.define!;
  assert.equal(/same number the other registers print/.test(d), false, 'the false claim is back');
  // …in words: a define is read by people, so it names the number, never its catalog key
  // (2026-09-27: business readers saw `count.unit.notInWords` printed in the popover)
  assert.match(d, /printed here as the whole/, 'the define must say this register prints the whole');
  assert.match(d, /technical conditions alone/, 'and say what another lens printing the part is printing');
  // the whole and its parts each name themselves where they are printed
  assert.match(STRINGS['journey.biz.untranslated']!.define!, /two parts/i);
  assert.match(STRINGS['journey.untranslated']!.define!, /one of the two parts/i);
  assert.match(STRINGS['count.unit.notInWords']!.define!, /same number in every register/i);
  // no define quotes a number measured on one graph as if it held for every journey
  for (const k of ['journey.biz.header', 'journey.biz.untranslated', 'journey.untranslated', 'count.unit.notInWords']) {
    assert.equal(/\b\d{2,}\b/.test(STRINGS[k]!.define!), false, `${k}'s define quotes a number from one graph`);
  }
});

test('the step unit does not claim a count the product makes', () => {
  // The define said the step count is made "never in business", and the business
  // register prints it on every cell of the system band as *n things happen here*.
  // The word is what business never prints; the parts are counted there too.
  const d = STRINGS['journey.unit.step']!.define!;
  assert.match(d, /things happen here/, 'the define must name the business register\'s own words for this count (in words, never its key)');
  assert.equal(/Counted in hybrid and code, never in business/.test(d), false);
});

test('the Tests matrix does not point its denominator at a number that is not printed', () => {
  // The caption claimed "every denominator is the one its journey header prints".
  // The journey header prints no denominator, no percentage and no bound, in any
  // register — the claim was unverifiable on the page it was written about.
  const sub = STRINGS['tests.matrixSub']!;
  assert.equal(/journey header prints/.test(sub.professional), false);
  assert.ok(sub.define, 'and the caption now says where a denominator is read');
});
