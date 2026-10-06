// One gate, answered (swarm-fixes round 2026-10-05, finding 4). The swarm met a gate whose click did nothing it
// could use, no way from a gate to the call it guards or the tests that reach it, and three ops sign-in config
// checks listed as a contractor screen's gates. These tests pin the config-check rule, the journey listing those
// checks apart, and the gate card's fold.
//
// In-memory fixtures. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndex, journey, journeySummary, configCheckOf, isConfigCheck, paramsText, gateCard, countedProblems, CONFIG_CHECK_TAG,
} from '../dist/index.js';
import type { GraphNode, GraphEdge } from '../dist/index.js';

const R = 'shop';
const loc = (path: string, line: number) => ({ repo: R, path, line });
let eid = 0;
const edge = (kind: GraphEdge['kind'], from: string, to: string, meta?: Record<string, unknown>): GraphEdge => ({ id: `e${eid++}`, kind, from, to, ...(meta ? { meta } : {}) });

const PAGE = `${R}::page::/submit`;
const COMP = `${R}::src/submit/page.tsx::SubmitPage`;
const CTX = `${R}::src/lib/context.ts::serverContext`;
const ENV = `${R}::src/config/env.ts::loadEnv`;
const DEV = `${R}::src/config/env.ts::resolveDevLogin`;
const ROUTE = `${R}::route::POST /api/submit`;
const HANDLER = `${R}::src/api/submit/route.ts::POST`;
const SVC = `${R}::src/svc/submit.ts::submitInvoice`;
const SESSION = `${R}::src/auth/session.ts::requireSession`;
const STATE = `${R}::src/domain/state.ts::guardTransition`;
const UNIT = `${R}::test::src/domain/state.spec.ts::refuses an approved invoice`;
const E2E = `${R}::test::e2e/submit.pw.spec.ts::submits an invoice`;

const DEV_CODE = `function resolveDevLogin(
  requested: 'true' | 'false' | undefined,
  env: Record<string, string | undefined>,
): boolean {
  const production = env['NODE_ENV'] === 'production';
  if (requested === 'true' && production) throw new Error('refused');
  return !production;
}`;

function shop(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    { id: PAGE, kind: 'page', name: '/submit', loc: loc('src/submit/page.tsx', 1) },
    { id: COMP, kind: 'component', name: 'SubmitPage', loc: loc('src/submit/page.tsx', 3) },
    { id: CTX, kind: 'function', name: 'serverContext', loc: loc('src/lib/context.ts', 5) },
    { id: ENV, kind: 'function', name: 'loadEnv', loc: loc('src/config/env.ts', 10) },
    // the parser's tag; the snippet alone would say the same
    { id: DEV, kind: 'guard', name: 'resolveDevLogin: dev sign-in only outside production', loc: loc('src/config/env.ts', 40), snippet: DEV_CODE, tags: ['auth', CONFIG_CHECK_TAG] },
    { id: ROUTE, kind: 'route', name: 'POST /api/submit', loc: loc('src/api/submit/route.ts', 8), contract: { status: 'both', apiId: `${R}::api::openapi.yaml`, summary: 'Submit a draft invoice' } as GraphNode['contract'] },
    { id: HANDLER, kind: 'function', name: 'POST', loc: loc('src/api/submit/route.ts', 8) },
    { id: SVC, kind: 'function', name: 'submitInvoice', loc: loc('src/svc/submit.ts', 20) },
    { id: SESSION, kind: 'guard', name: 'requireSession: a signed-in contractor', loc: loc('src/auth/session.ts', 12),
      snippet: 'async function requireSession(req: Request, env = process.env) { return env.SECRET ? read(req) : null; }', tags: ['auth'],
      facets: { business: { description: 'Lets only a signed-in contractor submit.' } } },
    { id: STATE, kind: 'guard', name: 'guardTransition: invoice state machine', loc: loc('src/domain/state.ts', 30), docs: 'Refuses a move the state machine does not allow. Approved stays approved.', tags: ['auth'] },
    { id: UNIT, kind: 'test', name: 'refuses an approved invoice', loc: loc('src/domain/state.spec.ts', 4), test: { level: 'unit', runner: 'vitest', suite: [], file: 'src/domain/state.spec.ts' } },
    { id: E2E, kind: 'test', name: 'submits an invoice', loc: loc('e2e/submit.pw.spec.ts', 9), test: { level: 'e2e', runner: 'playwright', suite: [], file: 'e2e/submit.pw.spec.ts' } },
  ];
  const edges: GraphEdge[] = [
    edge('renders', PAGE, COMP),
    edge('calls', COMP, CTX, { line: 4 }),
    edge('calls', CTX, ENV, { line: 6 }),
    edge('guards', DEV, ENV),
    edge('calls', ENV, DEV, { via: 'guard', line: 12 }),
    edge('http', COMP, ROUTE, { method: 'POST', line: 7 }),
    edge('calls', ROUTE, HANDLER),
    edge('guards', SESSION, ROUTE),
    edge('calls', HANDLER, SVC, { line: 9 }),
    edge('guards', STATE, SVC),
    edge('calls', SVC, STATE, { via: 'guard', line: 22 }),
    edge('covers', UNIT, STATE, { evidence: 'static' }),
    edge('covers', E2E, ROUTE, { evidence: 'declared' }),
  ];
  // every node the parser writes carries tags
  return { nodes: nodes.map((n) => ({ tags: [], ...n })), edges };
}

test('a config check reads the process environment and takes no request', () => {
  assert.equal(configCheckOf(DEV_CODE), true, 'a settings record keyed in SHOUT_CASE, no request');
  assert.equal(configCheckOf('function guardMockOnly(env = process.env) { if (env.BC_MODE !== "mock") throw new Error("x"); }'), true);
  assert.equal(configCheckOf('function resolveOidc(v: Settings, env: Record<string, string | undefined>) { return v.ON ? {} : null; }'), true, 'a settings record by its type');
  // a guard that takes the request is a gate on that request, whatever it reads from the environment
  assert.equal(configCheckOf('async function startSignIn(req: Request, env: Env) { if (!env.APP_BASE_URL) throw notFound(); }'), false);
  assert.equal(configCheckOf('function requireSession(ctx: Ctx) { return process.env.SECRET ? ctx.user : null; }'), false);
  assert.equal(configCheckOf('function requireOwner(user: User, invoice: Invoice) { return user.id === invoice.owner; }'), false, 'no environment read');
  assert.equal(paramsText('function f(a: (x: number) => void, b = g(1)): void {}'), 'a: (x: number) => void, b = g(1)', 'nested parentheses stay inside');
});

test('isConfigCheck: the parser tag, else the snippet; a declared gate never is one', () => {
  const g = shop();
  const by = new Map(g.nodes.map((n) => [n.id, n]));
  assert.equal(isConfigCheck(by.get(DEV)), true);
  assert.equal(isConfigCheck({ ...by.get(DEV)!, tags: ['auth'] }), true, 'an older graph: the snippet says so');
  assert.equal(isConfigCheck(by.get(SESSION)), false, 'it takes the request');
  assert.equal(isConfigCheck({ ...by.get(DEV)!, tags: ['auth', 'declared'] }), false);
  assert.equal(isConfigCheck(by.get(ENV)), false, 'not a guard');
});

test('a journey lists a config check apart from the screen\'s gates, and counts it apart', () => {
  const g = shop();
  const index = buildIndex(g.nodes, g.edges);
  const j = journey(index, PAGE);
  const sum = journeySummary(index, j, [index.byId.get(PAGE)!]);
  const sg = sum.segments[0]!;
  assert.deepEqual(sg.gates.map((x) => x.id).sort(), [SESSION, STATE].sort(), 'the gates are what the screen\'s requests meet');
  assert.deepEqual(sg.configChecks.map((x) => x.id), [DEV], 'the config check is listed on its own');
  assert.equal(sg.counts.configChecks, 1);
  assert.equal(sg.counts.gates, 2);
  assert.equal(sum.counts.gates, 2, 'the journey\'s gates leave the config check out');
  assert.equal(sum.counts.configChecks, 1);
  assert.deepEqual(sum.business.configChecks.map((x) => x.id), [DEV]);
  assert.ok(!sum.business.gates.some((x) => x.id === DEV));
  assert.equal(sg.counted!.configChecks.n, 1);
  assert.equal(sum.counted!.configChecks.n, 1);
  assert.deepEqual(countedProblems(sg.counted!.configChecks), []);
  // the step keeps the gate, marked
  const step = j.steps.find((s) => s.nodeId === ENV)!;
  assert.deepEqual(step.gates.map((x) => [x.id, !!x.config]), [[DEV, true]]);
});

test('gateCard: the words, what it sits on, the calls a request goes through, the tests that reach it', () => {
  const g = shop();
  const index = buildIndex(g.nodes, g.edges);

  const state = gateCard(index, STATE)!;
  assert.equal(state.gate.gateKind, 'guard');
  assert.equal(state.gate.configCheck, false);
  assert.equal(state.gate.ident, 'guardTransition');
  assert.equal(state.gate.phrase, 'invoice state machine');
  assert.equal(state.gate.business, undefined, 'nobody wrote a business line');
  assert.equal(state.gate.docs, 'Refuses a move the state machine does not allow.');
  assert.deepEqual(state.sitsOn.map((p) => p.id), [SVC]);
  assert.deepEqual(state.calls.map((c) => [c.id, c.depth, c.method, c.path]), [[ROUTE, 2, 'POST', '/api/submit']], 'the route two calls up');
  assert.equal(state.calls[0]!.summary, 'Submit a draft invoice');
  assert.deepEqual(state.tests.map((t) => [t.id, t.reaches.nodeId]), [[UNIT, STATE], [E2E, ROUTE]], 'its own test first, then the call\'s');
  assert.equal(state.testsOnGate, 1);
  assert.equal(state.counted.calls.n, 1);
  assert.equal(state.counted.calls.of, 1, 'out of every route in the graph');
  assert.deepEqual(state.counted.calls.breakdown!.map((p) => p.n), [0, 1]);
  assert.equal(state.counted.tests.tests.n, 2);
  for (const c of [state.counted.sitsOn, state.counted.calls, state.counted.pages, state.counted.tests.tests]) assert.deepEqual(countedProblems(c), []);
  assert.equal(state.counted.calls.scope, 'count.scope.gate');

  const session = gateCard(index, SESSION)!;
  assert.equal(session.gate.business, 'Lets only a signed-in contractor submit.');
  assert.deepEqual(session.calls.map((c) => [c.id, c.depth]), [[ROUTE, 0]], 'it guards the route directly');
  assert.deepEqual(session.counted.calls.breakdown!.map((p) => p.n), [1, 0]);
  assert.deepEqual(session.tests.map((t) => t.id), [E2E]);
  assert.equal(session.testsOnGate, 0);

  const dev = gateCard(index, DEV)!;
  assert.equal(dev.gate.configCheck, true);
  assert.deepEqual(dev.calls, [], 'no route reaches the settings here');
  assert.deepEqual(dev.pages.map((p) => p.id), [PAGE], 'the page reads them while it draws');
  assert.equal(dev.chip, 'none');

  assert.equal(gateCard(index, SVC), undefined, 'not a gate');
  assert.equal(gateCard(index, 'nope'), undefined);
});
