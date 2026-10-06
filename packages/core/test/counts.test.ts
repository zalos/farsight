// Typed counts — one concept, one number; two numbers, two names and a printed
// scope (docs/COUNTS.md). The pass swarm of 2026-09-25 met, on one journey:
// `13 actions` beside `ACTION 1 OF 31`; `118` conditions not in plain language
// in business beside `90` in hybrid; `34 gates` beside `Gates & rules 34`; e2e
// `80` / `91` / `13` with no scope; `VERIFIED · STALE` above `0 observed`;
// `IN WORDS · 0` above words; a Tests header that ignored the E2E filter; and
// `NONE INDEXED` above twelve story chips. Each test below pins the decision
// the ledger records for one of them.
//
// In-memory fixtures (core has no parser dependency). Runs against the built
// package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndex, journey, journeySummary, screensFor, flowScreenIds, journeyScope, coverageFor, stepCoverage,
  testsSurface, storyCounts, STRINGS, COUNT_SCOPES, countedProblems, countedText, countedLine, evidenceWord,
} from '../dist/index.js';
import type { GraphNode, GraphEdge, OperationContract, BranchPoint, Counted, JourneySummary } from '../dist/index.js';

// ── the shape itself ─────────────────────────────────────────────────────

/** RULE 5 of scripts/lint-strings.mjs: the words the business register never counts in. */
const BIZ_BANNED = /\b(steps?|cuts?|seams?|beats?|moments?|truncated|helpers?|hops?)\b/i;

/** Every `Counted` anywhere inside a value, with a path to it. */
function allCounted(v: unknown, path = '$', out: [string, Counted][] = []): [string, Counted][] {
  if (!v || typeof v !== 'object') return out;
  const o = v as Record<string, unknown>;
  if (typeof o.n === 'number' && typeof o.unit === 'string' && typeof o.scope === 'string') { out.push([path, o as unknown as Counted]); return out; }
  for (const [k, x] of Object.entries(o)) allCounted(x, `${path}.${k}`, out);
  return out;
}

function assertSound(v: unknown, label: string): number {
  const found = allCounted(v);
  for (const [path, c] of found) {
    assert.deepEqual(countedProblems(c, `${label}${path.slice(1)}`), []);
    if (c.bizUnit) {
      for (const reg of ['hud', 'professional'] as const) {
        assert.equal(BIZ_BANNED.test(STRINGS[c.bizUnit]![reg]), false, `${path}: bizUnit ${c.bizUnit} counts in a developer's unit`);
      }
    }
  }
  return found.length;
}

test('every scope a count may carry is in the catalog, defined, and printable in the business lens', () => {
  // the Map's Affected mode (lane I) added one scope: an impact answer placed on the journeys
  assert.ok(COUNT_SCOPES.includes('count.scope.affected'));
  for (const k of COUNT_SCOPES) {
    const e = STRINGS[k];
    assert.ok(e, `${k} is not in the catalog`);
    assert.ok(e!.define && e!.define.length > 30, `${k} has no define: a scope nobody can look up`);
    for (const reg of ['hud', 'professional'] as const) assert.equal(BIZ_BANNED.test(e![reg]), false, `${k} counts in a developer's unit`);
  }
  // every count.* key — scopes, units, parts — may be printed in any lens
  for (const [k, e] of Object.entries(STRINGS)) {
    if (!k.startsWith('count.')) continue;
    for (const reg of ['hud', 'professional'] as const) assert.equal(BIZ_BANNED.test(e[reg]), false, `${k} counts in a developer's unit`);
    if (!k.endsWith('One') && !k.startsWith('count.scope.')) assert.match(e.professional, /\{n\}/, `${k} prints no number`);
  }
});

test('countedProblems catches a breakdown that is not a partition, an unknown key and a scope outside the list', () => {
  const ok: Counted = { n: 3, unit: 'journey.countActions', scope: 'journey.scopeAll', source: 'x' };
  assert.deepEqual(countedProblems(ok), []);
  assert.equal(countedProblems({ ...ok, breakdown: [{ key: 'count.part.guards', n: 1 }] }).length, 1, 'parts must sum to n');
  assert.equal(countedProblems({ ...ok, unit: 'nope.key' }).length, 1);
  assert.equal(countedProblems({ ...ok, scope: 'journey.bizTabs' }).length, 1, 'a scope outside COUNT_SCOPES');
  assert.equal(countedText(ok), '3 actions across this journey');
  assert.equal(countedText({ ...ok, n: 1 }), '1 action across this journey', 'the singular, from the catalog');
  assert.equal(countedText(ok, { lens: 'business' }), '', 'no bizUnit: the business lens does not print it');
});

// ── the journey: actions and stops, gates, not in plain language, in words ──

const R = 'app';
const API = `${R}::api::openapi.yaml`;
const FLOW = `${R}::flow::thing`;
const C = 'api/client.ts';
const fn = (name: string, path: string, line: number, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id: `${R}::${path}::${name}`, kind: 'function', name, tags: [], loc: { repo: R, path, line }, ...extra }) as GraphNode;
const comp = (name: string, path: string, line: number, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id: `${R}::${path}::${name}`, kind: 'component', name, tags: [], loc: { repo: R, path, line }, ...extra }) as GraphNode;
const page = (name: string, line: number, operations: string[], extra: Partial<GraphNode> = {}): GraphNode =>
  ({
    id: `${R}::page::${name}`, kind: 'page', name, tags: [], loc: { repo: R, path: 'ui/router.tsx', line },
    design: { id: `SCR-${line}`, status: 'both', origin: 'manifest', operations }, ...extra,
  }) as GraphNode;
const route = (name: string, line: number, operationId: string): GraphNode =>
  ({
    id: `${R}::route::${name}`, kind: 'route', name, tags: [], loc: { repo: R, path: 'server/routes.ts', line },
    contract: { status: 'both', apiId: API, summary: `${operationId} summary`, spec: { operationId } } as OperationContract,
  }) as GraphNode;
const e = (kind: GraphEdge['kind'], from: string, to: string, line: number): GraphEdge =>
  ({ id: `${kind}|${from}|${to}|${line}`, kind, from, to, meta: { line } });

/**
 * Three screens: `/things` lists; `/things/new` lists again (a re-visit) and
 * creates; `/done` calls nothing. Every manifest also names `deleteThing`,
 * which nothing calls. The create handler decides three things: a gate
 * condition nobody labelled, an authored business decision, and a flag.
 */
function threeScreens(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const S = 'server/svc.ts';
  const branches: BranchPoint[] = [
    { kind: 'if', line: 10, condition: 'thing.size > limit', business: 'A big thing needs a second look',
      arms: [{ label: 'then', requires: 'thing.size > limit', line: 10, endLine: 14, business: 'Over the limit' }] },
    { kind: 'if', line: 20, condition: 'session.role !== "admin"', exits: true, arms: [{ label: 'then', requires: 'session.role !== "admin"', line: 20, endLine: 24 }] },
    { kind: 'if', line: 30, condition: 'env.FEATURE_X', arms: [{ label: 'then', requires: 'env.FEATURE_X', line: 30, endLine: 34 }] },
  ];
  const nodes: GraphNode[] = [
    { id: FLOW, kind: 'flow', name: 'Do a thing', tags: [] } as GraphNode,
    { id: API, kind: 'api', name: 'Thing API', tags: [] } as GraphNode,
    page('/things', 8, ['listThings', 'deleteThing'], { facets: { business: { description: 'See every thing you have.' } } } as Partial<GraphNode>),
    page('/things/new', 9, ['listThings', 'createThing', 'deleteThing']),
    page('/done', 10, []),
    comp('ThingList', 'ui/ThingList.tsx', 3), comp('NewThing', 'ui/NewThing.tsx', 3),
    fn('listThings', C, 4), fn('createThing', C, 10),
    route('GET /things', 5, 'listThings'), route('POST /things', 9, 'createThing'), route('DELETE /things/:id', 14, 'deleteThing'),
    fn('listThings', S, 6), fn('createThing', S, 5, { branches }),
    fn('review', S, 60), fn('refuse', S, 70), fn('flagged', S, 80),
  ];
  const edges: GraphEdge[] = [
    e('renders', FLOW, `${R}::page::/things`, 1), e('renders', FLOW, `${R}::page::/things/new`, 2), e('renders', FLOW, `${R}::page::/done`, 3),
    e('renders', `${R}::page::/things`, `${R}::ui/ThingList.tsx::ThingList`, 8),
    e('renders', `${R}::page::/things/new`, `${R}::ui/NewThing.tsx::NewThing`, 9),
    e('calls', `${R}::ui/ThingList.tsx::ThingList`, `${R}::${C}::listThings`, 12),
    e('calls', `${R}::ui/NewThing.tsx::NewThing`, `${R}::${C}::listThings`, 7),
    e('calls', `${R}::ui/NewThing.tsx::NewThing`, `${R}::${C}::createThing`, 15),
    e('http', `${R}::${C}::listThings`, `${R}::route::GET /things`, 5),
    e('http', `${R}::${C}::createThing`, `${R}::route::POST /things`, 11),
    e('calls', `${R}::route::GET /things`, `${R}::${S}::listThings`, 6),
    e('calls', `${R}::route::POST /things`, `${R}::${S}::createThing`, 6),
    e('calls', `${R}::${S}::createThing`, `${R}::${S}::review`, 12),
    e('calls', `${R}::${S}::createThing`, `${R}::${S}::refuse`, 22),
    e('calls', `${R}::${S}::createThing`, `${R}::${S}::flagged`, 32),
  ];
  return { nodes, edges };
}

function fold(g = threeScreens()): JourneySummary {
  const index = buildIndex(g.nodes, g.edges);
  return journeySummary(index, journey(index, FLOW), screensFor(index, FLOW));
}

test('every count the journey fold hands out is sound: known words, a define, a listed scope, a partition', () => {
  const sum = fold();
  const n = assertSound(sum.counted, 'journey') + sum.segments.reduce((a, sg) => a + assertSound(sg.counted, `segment ${sg.index}`), 0);
  // 20 since the data-stores pass: `stores` joined the header counts; 21 since the map pass: `screensReached`
  assert.equal(n, 21 + 7 * sum.segments.length, 'every header count and every screen count is typed');
  for (const sg of sum.segments) assert.ok(sg.counted, `segment ${sg.index} carries no typed counts`);
});

test('screens declared and screens reached are two numbers with two names, and the split adds up', () => {
  // the map pass (2026-10-03): one journey printed 14 (the design's screens), 10 (the street's) and
  // 23 (the drill's stops) with nothing saying which unit each was
  const sum = fold();
  const q = sum.counted!;
  assert.equal(q.screens.n, sum.user.length, 'screens are the ones the journey names');
  assert.equal(q.screensReached.n, 3, 'the walk reaches all three');
  assert.deepEqual(q.screens.breakdown!.map((p) => [p.key, p.n]), [['count.part.screensReached', 3], ['count.part.screensNotReached', 0]]);
  assert.notEqual(q.screens.unit, q.screensReached.unit, 'two numbers must carry two names');
  // a fourth screen the journey names and nothing on the walk leads to: named, not reached
  const g = threeScreens();
  g.nodes.push(page('/orphan', 11, []));
  const index = buildIndex(g.nodes, g.edges);
  const named = [...screensFor(index, FLOW), index.byId.get(`${R}::page::/orphan`)!];
  const s2 = journeySummary(index, journey(index, FLOW), named);
  assert.equal(s2.counted!.screens.n, 4);
  assert.equal(s2.counted!.screensReached.n, 3);
  assert.deepEqual(s2.counted!.screens.breakdown!.map((p) => p.n), [3, 1]);
  assert.deepEqual(countedProblems(s2.counted!.screens), []);
  assert.deepEqual(countedProblems(s2.counted!.screensReached), []);
});

test('actions and stops are two numbers with two names — and the stops contain the actions', () => {
  // `13 actions` on the header and `ACTION 1 OF 31` in the drill were one noun over two
  // populations. The header counts what a person can do, once each; the drill's rail
  // stops at every time the journey does something.
  const sum = fold();
  const q = sum.counted!;
  const moments = sum.segments.flatMap((sg) => sg.moments);
  assert.equal(q.actions.n, sum.counts.called, 'the header\'s actions are the fold\'s called operations');
  assert.equal(q.actionStops.n, moments.length, 'the stops are every column the drill\'s rail draws');
  assert.notEqual(q.actions.unit, q.actionStops.unit, 'two numbers must carry two names');
  const [calledStops, declaredStops, noCall] = q.actionStops.breakdown!.map((p) => p.n);
  assert.equal(calledStops, q.actions.n + q.again.n, 'the calls the code makes = the actions + the ones made again');
  assert.equal(noCall, 1, '/done calls nothing and is still a stop');
  assert.equal(declaredStops, moments.filter((mo) => mo.callStep != null).length - calledStops);
  // per screen, the same two concepts on the screen's scope
  for (const sg of sum.segments) {
    assert.equal(sg.counted!.actionStops.n, sg.moments.length);
    assert.equal(sg.counted!.actionStops.scope, 'journey.scopeHere');
  }
  // the drill's caption names its own unit, not the header's
  assert.match(STRINGS['journey.drill.actionOf']!.professional, /^stop \{n\} of \{t\}/);
});

test('the Sheet\'s columns are the stops, and actions + again + declared + nothing to call = stops', () => {
  // swarm 2026-10-05 (finding 3): *5 actions* above a Sheet of 6 numbered columns, *15 actions*
  // beside *stop 1 of 23*. The columns are the stops (`counted.actionStops`, the number the
  // Sheet's corner prints); the header's actions are one named part of them.
  const sum = fold();
  const q = sum.counted!;
  const columns = sum.segments.reduce((a, sg) => a + sg.moments.length, 0);
  assert.equal(q.actionStops.n, columns, 'the number above the Sheet is its columns');
  const [calledStops, declaredStops, noCall] = q.actionStops.breakdown!.map((p) => p.n);
  assert.equal(calledStops + declaredStops + noCall, columns, 'the stops\' split adds up to the columns');
  assert.equal(q.actions.n + q.again.n + declaredStops + noCall, columns,
    'the header\'s actions reconcile with the columns through named parts — never a silent difference');
  assert.ok(q.actions.n < columns, 'more columns than actions here, which is why they carry two names');
});

test('conditions not in plain language are one number in every register, and the screens add up to it', () => {
  // Business printed 118 and hybrid 90 for the reference app's POC flow: business folded the gate
  // conditions nobody labelled in, hybrid drew them as decisions and left them out.
  const sum = fold();
  const q = sum.counted!;
  const un = sum.business.untranslated;
  assert.equal(q.notInWords.n, un.count + un.guardsUnlabelled);
  assert.deepEqual(q.notInWords.breakdown!.map((p) => [p.key, p.n]), [['journey.untranslated', un.count], ['count.part.gateConditions', un.guardsUnlabelled]]);
  assert.equal(q.notInWords.n, 2, 'the flag and the unlabelled gate condition');
  assert.ok(q.notInWords.bizUnit && q.notInWords.unit, 'printed in every lens');
  assert.equal(sum.segments.reduce((a, sg) => a + sg.counted!.notInWords.n, 0), q.notInWords.n, 'the screens partition the journey\'s number');
  // the gate condition is the same population in both breakdowns it appears in
  const gateInDecisions = q.decisions.breakdown!.find((p) => p.key === 'count.part.gateConditions')!;
  assert.equal(gateInDecisions.n, un.guardsUnlabelled);
  // `checks` is the header's word for meetings of a gate: the business sentence no longer borrows it
  assert.equal(/\bchecks?\b/.test(STRINGS['journey.biz.untranslated']!.professional), false);
  assert.ok(STRINGS['journey.biz.untranslatedOne'], '"1 checks … were" had no singular');
});

test('gates count gates and validation rules, and say so', () => {
  const g = threeScreens();
  g.nodes.push({ id: `${R}::guard::requireSession`, kind: 'guard', name: 'requireSession', tags: [] } as GraphNode,
    { id: `${R}::rule::ThingSchema`, kind: 'rule', name: 'ThingSchema', tags: [] } as GraphNode);
  g.edges.push(e('guards', `${R}::guard::requireSession`, `${R}::route::POST /things`, 1),
    e('validates', `${R}::rule::ThingSchema`, `${R}::route::POST /things`, 1));
  const sum = fold(g);
  const q = sum.counted!;
  assert.equal(q.gates.n, sum.counts.gates);
  assert.equal(q.gates.breakdown!.reduce((a, p) => a + p.n, 0), q.gates.n);
  assert.match(STRINGS['journey.countGates']!.professional, /gates & rules/, 'the header\'s word names both kinds, like the lane\'s tab');
});

test('In words counts the lines its view draws — never 0 above words', () => {
  const sum = fold();
  const q = sum.counted!.inWords;
  // one line per screen (a sentence, or the name) + one per decision in words
  const decisionsInWords = sum.business.decisions.filter((d) => d.class === 'business').length;
  assert.equal(q.n, sum.segments.length + decisionsInWords);
  assert.deepEqual(q.breakdown!.map((p) => p.n), [1, 2, decisionsInWords], '/things has a sentence, the other two print their names');
  assert.ok(q.n > 0);
});

// ── coverage: e2e counts with their scope, and *verified* with one meaning ──

const S2 = 'src/orders.ts';
const shopFn = (name: string, line: number): GraphNode =>
  ({ id: `shop::${S2}::${name}`, kind: 'function', name, tags: [], loc: { repo: 'shop', path: S2, line, endLine: line + 4 } }) as GraphNode;
const ce = (from: string, to: string, meta: GraphEdge['meta'], technique: string): GraphEdge =>
  ({ id: `covers|${from}|${to}`, kind: 'covers', from, to, meta, resolution: { status: 'resolved', technique, confidence: 'MEDIUM' } } as GraphEdge);

/** One flow, one page, one route, one function; an e2e that declares it, a unit that imports it, and a coverage report that saw it run before the code changed. */
function shop(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    { id: 'shop::flow::order', kind: 'flow', name: 'Order', tags: [] } as GraphNode,
    { id: 'shop::page::/orders', kind: 'page', name: '/orders', tags: [], loc: { repo: 'shop', path: 'src/ui/Orders.tsx', line: 1 } } as GraphNode,
    { id: 'shop::route::POST /orders', kind: 'route', name: 'POST /orders', tags: [], loc: { repo: 'shop', path: S2, line: 2 } } as GraphNode,
    shopFn('placeOrder', 10),
    { id: 'shop::test::e2e/o.pw.spec.ts::orders', kind: 'test', name: 'orders', tags: ['test'], loc: { repo: 'shop', path: 'e2e/o.pw.spec.ts', line: 3 },
      test: { level: 'e2e', runner: 'playwright', suite: [], file: 'e2e/o.pw.spec.ts' } } as GraphNode,
    { id: 'shop::test::e2e/other.pw.spec.ts::elsewhere', kind: 'test', name: 'elsewhere', tags: ['test'], loc: { repo: 'shop', path: 'e2e/other.pw.spec.ts', line: 3 },
      test: { level: 'e2e', runner: 'playwright', suite: [], file: 'e2e/other.pw.spec.ts' } } as GraphNode,
    { id: 'shop::test::src/o.spec.ts::totals', kind: 'test', name: 'totals', tags: ['test'], loc: { repo: 'shop', path: 'src/o.spec.ts', line: 3 },
      test: { level: 'unit', runner: 'vitest', suite: [], file: 'src/o.spec.ts', run: { id: 'r1', at: '2026-09-25T00:00:00.000Z', status: 'skipped', freshness: 'unknown', stale: false } } } as GraphNode,
    { id: 'shop::test::run:unit:shop', kind: 'test', name: 'unit run', tags: ['test'],
      test: { level: 'unit', runner: 'vitest', suite: [], file: 'coverage/coverage-final.json', runLevel: true, files: [S2],
        run: { id: 'r2', at: '2026-09-22T00:00:00.000Z', status: 'unknown', freshness: 'changed', stale: true, sourceDigest: 'old' } } } as GraphNode,
  ];
  const edges: GraphEdge[] = [
    { id: 'r1', kind: 'renders', from: 'shop::flow::order', to: 'shop::page::/orders', meta: { line: 1 } } as GraphEdge,
    { id: 'h1', kind: 'http', from: 'shop::page::/orders', to: 'shop::route::POST /orders', meta: { line: 2 } } as GraphEdge,
    { id: 'c1', kind: 'calls', from: 'shop::route::POST /orders', to: `shop::${S2}::placeOrder`, meta: { line: 3 } } as GraphEdge,
    ce('shop::test::e2e/o.pw.spec.ts::orders', 'shop::page::/orders', { evidence: 'declared' }, 'annotation-scan'),
    ce('shop::test::src/o.spec.ts::totals', `shop::${S2}::placeOrder`, { evidence: 'static' }, 'import-resolution'),
    ce('shop::test::run:unit:shop', `shop::${S2}::placeOrder`, { evidence: 'observed', runId: 'r2' }, 'coverage-report'),
  ];
  return { nodes, edges };
}

test('a coverage report alone never earns *verified*: its word, its run and its counts say what it is', () => {
  // Every reference-app screen whose only run was a 2026-09-22 coverage report wore
  // `VERIFIED · STALE` above `0 observed · LAST RUN skipped` — the chip from the
  // report, the run line from the covering cases' own 2026-09-25 results.
  const g = shop();
  const index = buildIndex(g.nodes, g.edges);
  const ids = journeyScope(index, journey(index, 'shop::flow::order'), flowScreenIds(index, 'shop::flow::order'));
  const f = coverageFor(index, ids, { kind: 'flow', label: 'Order', flowId: 'shop::flow::order' });
  assert.equal(f.chip, 'observed-stale');
  assert.equal(f.observedBy, 'runs');
  assert.equal(f.evidenceWord.key, 'tests.evidence.runSeenStale');
  assert.equal(/verified/i.test(STRINGS[f.evidenceWord.key]!.professional), false);
  assert.equal(f.evidenceWord.biz, 'journey.biz.testsRun.runOnlyStale');
  // the run beside the word is the run that earned it — not the skipped case
  assert.deepEqual(f.observation, { by: 'runs', at: '2026-09-22T00:00:00.000Z', status: 'unknown', freshness: 'changed', cases: 0, reports: 1 });
  assert.equal(f.run?.status, 'skipped', 'the covering cases\' own last run stays where it was, for compatibility');
  // the counts: one e2e case reaches the flow — the other e2e case is in the source, not here
  assert.equal(f.counted!.e2e.n, f.counts.tests.e2e);
  assert.equal(f.counted!.e2e.n, 1);
  assert.equal(f.counted!.e2e.scope, 'journey.scopeAll');
  assert.deepEqual(f.counted!.e2e.breakdown!.map((p) => p.n), [1, 0, 0], 'declared only · reached · seen in a run');
  assert.equal(f.counted!.observed.n, 0, '0 cases observed');
  assert.equal(f.counted!.runReports.n, 1, 'one report, counted as a report');
  assertSound(f.counted, 'flow coverage');
  // the Tests page's source card counts the source's cases, under its own scope
  const card = testsSurface(index, null, undefined).sources.find((c) => c.level === 'e2e')!;
  assert.equal(card.cases, 2);
  assert.equal(card.counted!.cases.scope, 'count.scope.source');
  assert.notEqual(card.counted!.cases.scope, f.counted!.e2e.scope, 'two numbers, two printed scopes');
  // one node's facts carry the same word and typed counts
  const step = stepCoverage(index, `shop::${S2}::placeOrder`)!;
  assert.equal(step.evidenceWord?.key, 'tests.evidence.runSeenStale');
  assert.equal(step.counted?.unit.scope, 'count.scope.node');
  assert.equal(step.counted?.unit.n, 1, 'one unit case — the report is not a case');
  // and the stale word a named case earns keeps *verified*
  assert.equal(evidenceWord('observed-stale', 'tests').key, 'journey.evidence.stale');
});

test('the journey fold carries one slim coverage entry per action, with its own scope', () => {
  const g = shop();
  const index = buildIndex(g.nodes, g.edges);
  const sum = journeySummary(index, journey(index, 'shop::flow::order'), screensFor(index, 'shop::flow::order'));
  const moments = sum.coverage!.moments!;
  assert.equal(moments.length, sum.segments.length);
  sum.segments.forEach((sg, i) => assert.equal(moments[i]!.length, sg.moments.length));
  const m = moments[0]![0]!;
  assert.equal(m.counted.tests.scope, 'count.scope.action');
  assert.ok(!('tests' in m && Array.isArray((m as { tests?: unknown }).tests)), 'slim: no test list per action');
  assertSound(sum.coverage, 'coverage');
});

// ── the Tests page: the level filter reaches the header ─────────────────

test('the level filter holds every count to the level, and keeps the unfiltered ones beside', () => {
  // With E2E selected the header read `5825 · 0 unit · 0 integration · 368 e2e / 431 spec files`.
  const g = shop();
  const index = buildIndex(g.nodes, g.edges);
  const all = testsSurface(index, null, undefined);
  const e2e = testsSurface(index, null, undefined, { level: 'e2e' });
  assert.equal(e2e.counts.cases, 2);
  assert.equal(e2e.counts.cases, e2e.sources.reduce((a, c) => a + c.cases, 0), 'the header is the sum of the cards under it');
  assert.equal(e2e.counts.files, 2);
  assert.deepEqual(e2e.countsAll, all.counts, 'nothing lost: the whole scope rides beside');
  assert.equal(e2e.counted!.cases.scope, 'count.scope.selection');
  assert.equal(all.counted!.cases.scope, 'count.scope.workspace');
  assert.deepEqual(e2e.counted!.cases.breakdown!.map((p) => p.n), [0, 0, 2]);
  assert.ok(e2e.suites.every((s) => s.level === 'e2e'));
  assertSound(e2e.counted, 'tests e2e');
  assertSound(all.sources, 'tests sources');
  // each source card says whether its cases passed, not only when they ran
  const unit = all.sources.find((c) => c.level === 'unit')!;
  assert.deepEqual(unit.runs, { passed: 0, failed: 0, skipped: 1, flaky: 0, unknown: 0, noRun: 0 });
});

// ── stories: own, docs pages and the parts' stories are three numbers ──────

test('a screen with no story of its own counts its parts\' stories apart, and docs pages are not stories', () => {
  const story = (id: string) => ({ id, name: id, file: 'x.stories.tsx', line: 1 });
  const nodes: GraphNode[] = [
    { id: 'a::page::/submit', kind: 'page', name: '/submit', tags: [] } as GraphNode,
    { id: 'a::c::Wizard', kind: 'component', name: 'Wizard', tags: [], stories: [story('w1'), story('w2')] } as unknown as GraphNode,
    { id: 'a::c::Strip', kind: 'component', name: 'Strip', tags: [], stories: [story('s1')] } as unknown as GraphNode,
    { id: 'a::c::Button', kind: 'component', name: 'Button', tags: ['plumbing'], stories: [story('b1')] } as unknown as GraphNode,
  ];
  const edges: GraphEdge[] = [
    { id: '1', kind: 'renders', from: 'a::page::/submit', to: 'a::c::Wizard' } as GraphEdge,
    { id: '2', kind: 'renders', from: 'a::c::Wizard', to: 'a::c::Strip' } as GraphEdge,
    { id: '3', kind: 'renders', from: 'a::c::Wizard', to: 'a::c::Button' } as GraphEdge,
  ];
  const index = buildIndex(nodes, edges);
  const page = storyCounts(index, 'a::page::/submit');
  assert.equal(page.own.n, 0, 'no story renders the page itself');
  assert.equal(page.parts.n, 3, 'Wizard 2 + Strip 1; the plumbing Button is skipped');
  assert.deepEqual(page.parts.breakdown!.map((p) => [p.label, p.n]), [['Wizard', 2], ['Strip', 1]]);
  assert.notEqual(page.own.scope, page.parts.scope, 'own and parts print different scopes');
  // with a live index: 3 stories and a docs page are 3 stories and 1 docs page — 4 tabs
  const live = { 'a::c::Strip': [
    ...['s1', 's2', 's3'].map((id) => ({ id, name: id, type: 'story' as const, repo: 'a', inGraph: true, live: true })),
    { id: 'd', name: 'Docs', type: 'docs' as const, repo: 'a', inGraph: false, live: true },
  ] };
  const strip = storyCounts(index, 'a::c::Strip', live);
  assert.equal(strip.own.n, 3);
  assert.equal(strip.docs.n, 1);
  assertSound({ page, strip }, 'stories');
});

// ── the text printers (CLI, MCP) ─────────────────────────────────────────

test('countedLine says each scope once, before the numbers it scopes, in the lens asked for', () => {
  const q = fold().counted!;
  const code = countedLine([q.screens, q.actions, q.actionStops, q.steps], { lens: 'code' });
  assert.match(code, /^across this journey: 3 screens · 2 actions · 4 stops \(/);
  assert.match(code, /visits/);
  const biz = countedLine([q.screens, q.actions, q.steps], { lens: 'business' });
  assert.equal(BIZ_BANNED.test(biz), false, `the business line counts in a developer's unit: ${biz}`);
  assert.match(biz, /2 things the user can do/);
});

// ── defines are read by people ───────────────────────────────────────────

/**
 * A define is prose a reader sees in a popover and in the Grammar Book, in both
 * registers, and the tip escapes it — nothing renders markdown (lib/tooltip.js,
 * docs/MAP-VIEWER.md). So a catalog key, a backticked span or an emphasis mark in
 * a define arrives on screen literally: the story swarm of 2026-09-25 read
 * `journey.untranslated`, `count.unit.notInWords` and `*actions*` in business
 * popovers. Returns what is wrong with one define, or [] when it reads as words.
 */
function defineProblems(d: string, keys: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (d.includes('`')) out.push('a backticked span (the tip prints the backticks)');
  if (/\*{1,2}[^*\s][^*]*?\*{1,2}/.test(d)) out.push('markdown emphasis (*…* or **…**) — the tip prints the asterisks');
  const ph = d.match(/\{[A-Za-z]\w*\}/);
  if (ph) out.push(`a placeholder ${ph[0]} nothing fills — t() leaves defines as written`);
  for (const m of d.matchAll(/\b[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+\b/g)) {
    out.push(keys.has(m[0]) ? `the catalog key ${m[0]}` : `the dotted identifier ${m[0]} (a key, a file or a member — not words)`);
  }
  return out;
}

test('no define quotes a catalog key, a backticked span, markdown or an unfilled placeholder', () => {
  const keys = new Set(Object.keys(STRINGS));
  const bad: string[] = [];
  for (const [k, e] of Object.entries(STRINGS)) {
    if (!e.define) continue;
    for (const p of defineProblems(e.define, keys)) bad.push(`${k}: ${p}`);
  }
  assert.deepEqual(bad, [], `defines that would print code or markup to a reader:\n  ${bad.join('\n  ')}`);
});

test('the define rules catch what the swarm read', () => {
  const keys = new Set(['journey.untranslated', 'count.unit.notInWords']);
  assert.equal(defineProblems('The first part of `journey.untranslated`.', keys).length, 2, 'backticks and the key');
  assert.ok(defineProblems('Counted as count.unit.notInWords.', keys).some((p) => p.includes('catalog key')));
  assert.ok(defineProblems('The other registers’ *actions*.', keys).length);
  assert.ok(defineProblems('The **whole** number.', keys).length);
  assert.ok(defineProblems('The same finding on {n} artefacts.', keys).length);
  assert.ok(defineProblems('Declared in .farsight/settings.json.', keys).length, 'a file name is not words either');
  // what a person would write passes: numbers, quotes, a plus sign, an ellipsis, dashes
  assert.deepEqual(defineProblems('Actions + this is how many times an action runs — “verified · stale”, 3 of 4… A.B is fine.', keys), []);
});

test('a singular carries its plural’s define, word for word — never a pointer to another entry', () => {
  let n = 0;
  for (const [k, e] of Object.entries(STRINGS)) {
    if (!e.singularOf) continue;
    n++;
    assert.equal(e.define, STRINGS[e.singularOf]!.define, `${k} does not carry ${e.singularOf}'s define`);
    assert.equal(/singular of/i.test(e.define ?? ''), false, `${k} still describes itself as a pointer`);
  }
  assert.ok(n > 30, 'the singulars are wired through one()');
});
