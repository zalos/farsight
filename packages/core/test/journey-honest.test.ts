// Honest defaults in the fold — docs/proposals/journey-views-pass-2026-09.md §1.
// Local cut points instead of a global truncation, decisions filtered to what a person
// would call a decision, and plumbing folded under the thing that used it.
// In-memory fixtures (core has no parser dependency). Runs against the built package:
// `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, journey, journeySummary, screensFor, rulesFor, trace, impact } from '../dist/index.js';
import type { GraphNode, GraphEdge, BranchPoint } from '../dist/index.js';

const R = 'app';
const node = (id: string, kind: GraphNode['kind'], name: string, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, kind, name, tags: [], ...extra }) as GraphNode;
const fn = (name: string, path: string, line: number, extra: Partial<GraphNode> = {}): GraphNode =>
  node(`${R}::${path}::${name}`, 'function', name, { loc: { repo: R, path, line }, ...extra });
const edge = (kind: GraphEdge['kind'], from: string, to: string, line?: number): GraphEdge =>
  ({ id: `${kind}|${from}|${to}`, kind, from, to, ...(line != null ? { meta: { line } } : {}) });

// ── cut points ───────────────────────────────────────────────────────────

/** A flow over two screens: the first one runs deeper than the budget, the second is shallow. */
function twoScreens(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    node(`${R}::flow::two`, 'flow', 'Two screens', { design: { id: 'FL-1', status: 'both', source: 'docs/design/screens.json' } }),
    node(`${R}::page::/a`, 'page', '/a', { loc: { repo: R, path: 'ui/router.tsx', line: 3 } }),
    node(`${R}::page::/b`, 'page', '/b', { loc: { repo: R, path: 'ui/router.tsx', line: 4 } }),
    fn('a1', 'a.ts', 1), fn('a2', 'a.ts', 10), fn('a3', 'a.ts', 20), fn('a4', 'a.ts', 30), fn('a5', 'a.ts', 40),
    fn('b1', 'b.ts', 1),
  ];
  const a = (n: string) => `${R}::a.ts::${n}`;
  const edges: GraphEdge[] = [
    edge('renders', `${R}::flow::two`, `${R}::page::/a`, 1),
    edge('renders', `${R}::flow::two`, `${R}::page::/b`, 2),
    edge('calls', `${R}::page::/a`, a('a1'), 3),
    edge('calls', a('a1'), a('a2'), 5),
    edge('calls', a('a2'), a('a3'), 12),
    edge('calls', a('a3'), a('a4'), 22),
    edge('calls', a('a4'), a('a5'), 32),
    edge('calls', `${R}::page::/b`, `${R}::b.ts::b1`, 4),
  ];
  return { nodes, edges };
}

test('depth exhaustion is local: the deep first screen is cut where it ran out, the second screen still walks', () => {
  const { nodes, edges } = twoScreens();
  const index = buildIndex(nodes, edges);
  const entry = `${R}::flow::two`;
  const j = journey(index, entry, { maxDepth: 4 });
  const names = j.steps.map((s) => index.byId.get(s.nodeId)!.name);
  assert.deepEqual(names, ['Two screens', '/a', 'a1', 'a2', 'a3', '/b', 'b1'],
    'a4 is past the budget, but /b is a sibling of /a and keeps walking');
  assert.equal(j.truncated, false, 'depth never truncates — only the global step budget does');
  const a3 = j.steps.find((s) => index.byId.get(s.nodeId)!.name === 'a3')!;
  assert.deepEqual(j.cutPoints, [{
    reason: 'depth', parentStep: a3.order, nodeId: `${R}::a.ts::a4`,
    edgeId: `calls|${R}::a.ts::a3|${R}::a.ts::a4`, depth: 5,
  }], 'the cut names the parent whose subtree stopped, and the child that was not walked');

  const sum = journeySummary(index, j, screensFor(index, entry));
  assert.deepEqual(sum.segments.map((sg) => sg.screen?.name), ['/a', '/b'], 'both screens segment');
  assert.equal(sum.counts.cutPoints, 1);
  assert.equal(sum.counts.repeats, 0);
  assert.deepEqual(sum.segments.map((sg) => sg.counts.cutPoints), [1, 0], 'the cut belongs to the segment it happened in');
  assert.equal(sum.segments[0]!.markers.find((m) => m.name === 'a3')!.cut, 1, 'the marker says how much hangs off it unfollowed');
  assert.ok(sum.segments[0]!.markers.every((m) => m.name === 'a3' || m.cut == null));
});

test('the step budget is the only global stop: truncated, with exactly one `steps` cut point', () => {
  const { nodes, edges } = twoScreens();
  const index = buildIndex(nodes, edges);
  const j = journey(index, `${R}::flow::two`, { maxSteps: 3 });
  assert.equal(j.steps.length, 3);
  assert.equal(j.truncated, true);
  assert.equal(j.cutPoints.length, 1, 'one cut point for the whole walk, at the spot it ran out');
  assert.equal(j.cutPoints[0]!.reason, 'steps');
  assert.equal(j.cutPoints[0]!.nodeId, `${R}::a.ts::a2`, 'the child that did not fit');
});

/**
 * One page, n client calls into n routes. Every handler calls `audit` (which reads a table and
 * so is real work) and `fmt` (pure plumbing); `audit` calls `fmt` too. The first handler also
 * calls `explain` (a pure function with an authored business label) and `describe` (pure, with
 * only a `@business` sentence) — both authored, so both stay steps.
 */
function sharedHelper(times: 2 | 3): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const UI = 'ui/Page.tsx', CLIENT = 'api/client.ts', SVC = 'server/svc.ts';
  const routes = ['GET /x', 'GET /y', 'GET /z'].slice(0, times);
  const nodes: GraphNode[] = [
    node(`${R}::page::/p`, 'page', '/p', { loc: { repo: R, path: UI, line: 1 } }),
    node(`${R}::${UI}::Screen`, 'component', 'Screen', { loc: { repo: R, path: UI, line: 3 } }),
    fn('audit', SVC, 90), fn('fmt', SVC, 95),
    fn('explain', SVC, 98, { facets: { business: { label: 'Why it was held' } } }),
    fn('describe', SVC, 99, { facets: { business: { description: 'Says why the invoice was held.' } } }),
    node(`${R}::table::audit_log`, 'table', 'audit_log'),
  ];
  const edges: GraphEdge[] = [
    edge('renders', `${R}::page::/p`, `${R}::${UI}::Screen`, 2),
    edge('reads', `${R}::${SVC}::audit`, `${R}::table::audit_log`, 91),
    edge('calls', `${R}::${SVC}::audit`, `${R}::${SVC}::fmt`, 92),
  ];
  routes.forEach((r, i) => {
    const client = `fetch${i}`, handler = `handle${i}`;
    nodes.push(fn(client, CLIENT, 10 + i), fn(handler, SVC, 20 + i * 10),
      node(`${R}::route::${r}`, 'route', r, { loc: { repo: R, path: 'server/routes.ts', line: 5 + i } }));
    edges.push(
      edge('calls', `${R}::${UI}::Screen`, `${R}::${CLIENT}::${client}`, 10 + i),
      edge('http', `${R}::${CLIENT}::${client}`, `${R}::route::${r}`, 11 + i),
      edge('calls', `${R}::route::${r}`, `${R}::${SVC}::${handler}`, 6 + i),
      edge('calls', `${R}::${SVC}::${handler}`, `${R}::${SVC}::audit`, 21 + i * 10),
    );
    if (i === 0) edges.push(
      edge('calls', `${R}::${SVC}::${handler}`, `${R}::${SVC}::explain`, 22),
      edge('calls', `${R}::${SVC}::${handler}`, `${R}::${SVC}::describe`, 23),
    );
  });
  return { nodes, edges };
}

test('only plumbing folds: a function that reads a table, or that a person named, stays a step', () => {
  const { nodes, edges } = sharedHelper(2);
  const index = buildIndex(nodes, edges);
  const entry = `${R}::page::/p`;
  const sum = journeySummary(index, journey(index, entry), screensFor(index, entry));
  const seg = sum.segments[0]!;
  const handlers = seg.markers.filter((m) => m.name.startsWith('handle'));
  const audits = seg.markers.filter((m) => m.name === 'audit');
  assert.equal(audits.length, 2, 'called from both handlers');
  assert.ok(audits.every((m) => !m.helper), 'it reads a table — the service row must show it');
  assert.ok(handlers.every((m) => !m.helper), 'the handler under the route is never a helper');
  assert.ok(seg.markers.filter((m) => m.name === 'explain').every((m) => !m.helper), 'a person gave it a business label');
  assert.ok(seg.markers.filter((m) => m.name === 'describe').every((m) => !m.helper), 'a @business sentence is authored prose: it keeps a step visible too');
  // the pure one folds — under audit where audit called it, under the handler where the handler did
  const fmts = seg.markers.filter((m) => m.name === 'fmt');
  assert.ok(fmts.every((m) => m.helper), 'pure plumbing, called by a function on the same side');
  assert.deepEqual(fmts.map((m) => m.under), audits.map((m) => m.stepOrder), 'each copy folds under the real step above it');
  // the record is never folded: it hangs off the step that read it
  const rows = seg.markers.filter((m) => m.kind === 'record');
  assert.deepEqual(rows.map((m) => m.helper ?? false), [false, false]);
  assert.deepEqual(rows.map((m) => m.under), audits.map((m) => m.stepOrder));
  assert.deepEqual(seg.moments.map((m) => m.counts.helpers), [1, 1], 'only fmt folds, once per moment');
});

test('past the re-visit budget a node is still a step — repeat, not followed, counted apart from cut points', () => {
  const { nodes, edges } = sharedHelper(3);
  const index = buildIndex(nodes, edges);
  const entry = `${R}::page::/p`;
  const j = journey(index, entry);
  const audits = j.steps.filter((s) => s.nodeId === `${R}::server/svc.ts::audit`);
  assert.equal(audits.length, 3, 'the third call is visible instead of vanishing');
  assert.deepEqual(audits.map((s) => [s.repeat, s.cycle]), [[false, false], [true, false], [true, false]]);
  const third = audits[2]!;
  assert.ok(!j.steps.some((s) => s.order > third.order), 'the third copy has no subtree: the table read was not walked again');
  assert.deepEqual(j.cutPoints.filter((c) => c.reason === 'repeat'), [{
    reason: 'repeat', parentStep: third.order, nodeId: `${R}::server/svc.ts::audit`,
    edgeId: `calls|${R}::server/svc.ts::handle2|${R}::server/svc.ts::audit`, depth: third.depth,
  }], 'the whole list keeps every reason');
  assert.equal(j.truncated, false);
  const sum = journeySummary(index, j, screensFor(index, entry));
  // a re-visit hides nothing — the subtree was drawn the first time — so it is never a cut point
  assert.equal(sum.counts.cutPoints, 0);
  assert.equal(sum.counts.repeats, 1);
  assert.equal(sum.segments[0]!.counts.repeats, 1);
  assert.equal(sum.segments[0]!.markers.find((m) => m.stepOrder === third.order)!.cut, undefined);
  // a re-visit of a real step is still a real step: folding is judged per node over the whole walk
  assert.equal(sum.segments[0]!.markers.find((m) => m.stepOrder === third.order)!.helper, undefined);
});

test('a true cycle is emitted once and never recursed — no cut point, it is not a budget', () => {
  const nodes = [fn('c1', 'c.ts', 1), fn('c2', 'c.ts', 10)];
  const index = buildIndex(nodes, [
    edge('calls', `${R}::c.ts::c1`, `${R}::c.ts::c2`, 2),
    edge('calls', `${R}::c.ts::c2`, `${R}::c.ts::c1`, 11),
  ]);
  const j = journey(index, `${R}::c.ts::c1`);
  assert.deepEqual(j.steps.map((s) => [index.byId.get(s.nodeId)!.name, s.cycle]), [['c1', false], ['c2', false], ['c1', true]]);
  assert.deepEqual(j.cutPoints, []);
  assert.equal(j.truncated, false);
});

// ── decision classes ─────────────────────────────────────────────────────

/** A caller whose four forks span the four classes: authored, refusal, feature flag, thrown error. */
function decisions(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const P = 'server/submit.ts';
  const branches: BranchPoint[] = [
    {
      kind: 'if', line: 10, condition: 'invoice.total > limit', business: 'A large invoice needs a second approval',
      arms: [{ label: 'then', requires: 'invoice.total > limit', line: 10, endLine: 14, business: 'Over the approval limit' }],
    },
    { kind: 'if', line: 20, condition: 'session.role !== "admin"', exits: true, arms: [{ label: 'then', requires: 'session.role !== "admin"', line: 20, endLine: 24 }] },
    { kind: 'if', line: 30, condition: 'env.FEATURE_OCR', arms: [{ label: 'then', requires: 'env.FEATURE_OCR', line: 30, endLine: 34 }] },
    { kind: 'catch', line: 40, condition: 'try/catch', arms: [{ label: 'catch', requires: 'exception thrown', line: 40, endLine: 44 }] },
  ];
  const nodes: GraphNode[] = [
    fn('submit', P, 5, { branches }),
    fn('approve', P, 60), fn('refuse', P, 70), fn('ocr', P, 80), fn('report', P, 90),
  ];
  const edges: GraphEdge[] = [
    edge('calls', `${R}::${P}::submit`, `${R}::${P}::approve`, 12),
    edge('calls', `${R}::${P}::submit`, `${R}::${P}::refuse`, 22),
    edge('calls', `${R}::${P}::submit`, `${R}::${P}::ocr`, 32),
    edge('calls', `${R}::${P}::submit`, `${R}::${P}::report`, 42),
  ];
  return { nodes, edges };
}

test('decision classes: an authored arm and a refusal are drawn; a flag and an error are counted, not drawn', () => {
  const { nodes, edges } = decisions();
  const index = buildIndex(nodes, edges);
  const entry = `${R}::server/submit.ts::submit`;
  const j = journey(index, entry);
  // every class stays on the step, so the forks drawer and the spliced code still show all four
  assert.deepEqual(j.steps.flatMap((s) => (s.conditions ?? []).map((c) => [c.class, c.category])),
    [['business', 'branch'], ['guard', 'access'], ['technical', 'flag'], ['technical', 'error']]);

  const sum = journeySummary(index, j, screensFor(index, entry));
  assert.deepEqual(sum.business.decisions.map((d) => [d.label, d.class, d.stepOrder]), [
    ['Over the approval limit', 'business', 1],
    ['session.role !== "admin"', 'guard', 2],
  ], 'only what a person would call a decision, each anchored to the step it gates');
  assert.equal(sum.counts.decisions, 2, 'counts.decisions is translated decisions only');
  // the refusal is drawn in code and hybrid, but nobody wrote words for it: the business
  // register folds it into the same "not translated" sentence, from this count (A1.7)
  const { items, ...untr } = sum.business.untranslated;
  assert.deepEqual(untr, { count: 2, byCategory: { flag: 1, error: 1 }, guardsUnlabelled: 1 });
  // the sentence says they are listed one by one behind it: the list is the count
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((u) => u.category).sort(), ['error', 'flag']);
  for (const u of items) assert.ok(u.nodeId && u.name && u.requires !== undefined, 'each names where it is and what it tests');
  assert.equal(sum.segments[0]!.untranslated, 2);
  assert.deepEqual(sum.segments[0]!.decisions.map((d) => d.class), ['business', 'guard']);
  assert.deepEqual(sum.system.timeline.filter((t) => t.kind === 'decision').map((t) => t.name),
    ['Over the approval limit', 'session.role !== "admin"'], 'the timeline draws no technical diamonds');
});

// ── the drill tree ───────────────────────────────────────────────────────

/** One screen, one call: the handler calls a service, the service a deeper function that reads a table and calls plumbing. */
function deepService(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const UI = 'ui/Page.tsx', CLIENT = 'api/client.ts', SVC = 'server/svc.ts';
  const nodes: GraphNode[] = [
    node(`${R}::page::/p`, 'page', '/p', { loc: { repo: R, path: UI, line: 1 } }),
    node(`${R}::${UI}::Screen`, 'component', 'Screen', { loc: { repo: R, path: UI, line: 3 } }),
    fn('load', UI, 5), fn('fetchIt', CLIENT, 10), fn('http', CLIENT, 30),
    node(`${R}::route::GET /x`, 'route', 'GET /x', { loc: { repo: R, path: 'server/routes.ts', line: 5 } }),
    fn('handle', SVC, 20), fn('service', SVC, 40), fn('deeper', SVC, 60), fn('fmt', SVC, 80),
    node(`${R}::table::things`, 'table', 'things'),
  ];
  const edges: GraphEdge[] = [
    edge('renders', `${R}::page::/p`, `${R}::${UI}::Screen`, 2),
    edge('calls', `${R}::${UI}::Screen`, `${R}::${UI}::load`, 4),
    edge('calls', `${R}::${UI}::load`, `${R}::${CLIENT}::fetchIt`, 6),
    edge('http', `${R}::${CLIENT}::fetchIt`, `${R}::route::GET /x`, 11),
    edge('calls', `${R}::${CLIENT}::fetchIt`, `${R}::${CLIENT}::http`, 12),
    edge('calls', `${R}::route::GET /x`, `${R}::${SVC}::handle`, 6),
    edge('calls', `${R}::${SVC}::handle`, `${R}::${SVC}::service`, 21),
    edge('calls', `${R}::${SVC}::service`, `${R}::${SVC}::deeper`, 41),
    edge('reads', `${R}::${SVC}::deeper`, `${R}::table::things`, 61),
    edge('calls', `${R}::${SVC}::deeper`, `${R}::${SVC}::fmt`, 62),
  ];
  return { nodes, edges };
}

test('the drill tree: every marker hangs under its part, tiers count from the handler or the action, nothing is dropped', () => {
  const { nodes, edges } = deepService();
  const index = buildIndex(nodes, edges);
  const entry = `${R}::page::/p`;
  const sum = journeySummary(index, journey(index, entry), screensFor(index, entry));
  const seg = sum.segments[0]!;
  const by = (name: string) => seg.markers.find((m) => m.name === name)!;
  const [screen, load, fetchIt, http, call, handle, service, deeper, fmt, things] =
    ['Screen', 'load', 'fetchIt', 'http', 'GET /x', 'handle', 'service', 'deeper', 'fmt', 'things'].map(by);
  // the browser: the component is the moment's span header, the action under it starts at tier 0
  assert.equal(seg.moments.length, 1);
  assert.equal(seg.moments[0]!.component?.stepOrder, screen.stepOrder);
  assert.equal(load.under, screen.stepOrder); assert.equal(load.tier, 0, 'the action is a root of its cell');
  assert.equal(fetchIt.under, load.stepOrder); assert.equal(fetchIt.tier, 1, 'the client function is a part of the action');
  assert.equal(http.helper, true); assert.equal(http.under, fetchIt.stepOrder); assert.equal(http.tier, 2, 'plumbing sits one tier under what used it');
  // the seam: the call hangs under the client function but sits on the API row, so it is a root there
  assert.equal(call.under, fetchIt.stepOrder); assert.equal(call.tier, 0);
  // the server: the handler is a root, the service its part, the deeper function a drill-down
  assert.equal(handle.under, call.stepOrder); assert.equal(handle.tier, 0, 'the handler under the route');
  assert.equal(service.under, handle.stepOrder); assert.equal(service.tier, 1);
  assert.equal(deeper.under, service.stepOrder); assert.equal(deeper.tier, 2, 'drawn only when the service is drilled into');
  assert.equal(deeper.helper, undefined, 'it reads a table — never plumbing, even when folded by tier');
  assert.equal(fmt.helper, true); assert.equal(fmt.under, deeper.stepOrder); assert.equal(fmt.tier, 3);
  // the record is on its own row: it hangs under the function that read it and is a root there
  assert.equal(things.under, deeper.stepOrder); assert.equal(things.tier, 0);
  assert.ok(seg.markers.every((m) => m.tier != null), 'every marker has a tier');
});

// ── guards are also run ─────────────────────────────────────────────────

test('a @guard function with a calls edge is a gate on its caller AND a step the walk descends — its writes reach the records', () => {
  const nodes: GraphNode[] = [
    node(`${R}::route::POST /submit`, 'route', 'POST /submit', { loc: { repo: R, path: 'route.ts', line: 1 } }),
    node(`${R}::svc.ts::submitDraft`, 'guard', 'submitDraft: submit readiness', { loc: { repo: R, path: 'svc.ts', line: 10 }, snippet: 'x' }),
    node(`${R}::table::tracking_tokens`, 'table', 'tracking_tokens'),
  ];
  const edges: GraphEdge[] = [
    { id: 'g1', kind: 'guards', from: `${R}::svc.ts::submitDraft`, to: `${R}::route::POST /submit` },
    { id: 'c1', kind: 'calls', from: `${R}::route::POST /submit`, to: `${R}::svc.ts::submitDraft`, meta: { via: 'guard', line: 3 } },
    { id: 'w1', kind: 'writes', from: `${R}::svc.ts::submitDraft`, to: `${R}::table::tracking_tokens`, meta: { op: 'insert' } },
  ];
  const idx = buildIndex(nodes, edges);
  const j = journey(idx, `${R}::route::POST /submit`);
  assert.ok(j.steps[0]!.gates.some((g) => g.name.startsWith('submitDraft')), 'the guard is a gate on the route');
  assert.ok(j.steps.some((s) => s.nodeId === `${R}::svc.ts::submitDraft`), 'the guard is also a step');
  assert.ok(j.steps.some((s) => s.nodeId === `${R}::table::tracking_tokens` && s.via === 'writes'), 'its write is reached');
  const sum = journeySummary(idx, j, screensFor(idx, `${R}::route::POST /submit`));
  assert.ok(sum.system.records.some((r) => r.name === 'tracking_tokens'), 'the record is on the summary');
  // a guard that only checks is a badge, never a step
  nodes.push(node(`${R}::svc.ts::requireSession`, 'guard', 'requireSession: session', { loc: { repo: R, path: 'svc.ts', line: 2 }, snippet: 'y' }));
  edges.push({ id: 'g2', kind: 'guards', from: `${R}::svc.ts::requireSession`, to: `${R}::route::POST /submit` });
  edges.push({ id: 'c2', kind: 'calls', from: `${R}::route::POST /submit`, to: `${R}::svc.ts::requireSession`, meta: { via: 'guard', line: 2 } });
  const j2 = journey(buildIndex(nodes, edges), `${R}::route::POST /submit`);
  assert.ok(j2.steps[0]!.gates.some((g) => g.name.startsWith('requireSession')), 'the leaf guard is a gate');
  assert.ok(!j2.steps.some((s) => s.nodeId === `${R}::svc.ts::requireSession`), 'the leaf guard is not a step');
});

// ── A1.4: env schemas are rules of the code, not gates on a journey ─────────

test('an env-schema rule is skipped by the journey’s gates but stays in rulesFor', () => {
  const nodes: GraphNode[] = [
    node(`${R}::route::POST /invoices`, 'route', 'POST /invoices', { loc: { repo: R, path: 'route.ts', line: 1 } }),
    node(`${R}::env.ts::webEnvSchema`, 'rule', 'webEnvSchema', { loc: { repo: R, path: 'env.ts', line: 4 }, tags: ['env-schema'] }),
    node(`${R}::http/client.ts::retrySchema`, 'rule', 'retrySchema', { loc: { repo: R, path: 'http/client.ts', line: 9 }, tags: ['plumbing'] }),
    node(`${R}::schemas.ts::invoiceSchema`, 'rule', 'invoiceSchema', { loc: { repo: R, path: 'schemas.ts', line: 2 }, tags: [] }),
  ];
  const edges: GraphEdge[] = [
    edge('validates', `${R}::env.ts::webEnvSchema`, `${R}::route::POST /invoices`),
    edge('validates', `${R}::http/client.ts::retrySchema`, `${R}::route::POST /invoices`),
    edge('validates', `${R}::schemas.ts::invoiceSchema`, `${R}::route::POST /invoices`),
  ];
  const idx = buildIndex(nodes, edges);
  const j = journey(idx, `${R}::route::POST /invoices`);
  assert.deepEqual(j.steps[0]!.gates.map((g) => g.name), ['invoiceSchema'],
    'only the rule a person’s data has to pass is a checkpoint');
  // the same rules are still rules of the code: list_rules and the Rules lens keep every one
  const rules = rulesFor(idx, trace(idx, [`${R}::route::POST /invoices`], 'upstream', 2));
  assert.deepEqual(rules.map((r) => r.rule.name).sort(), ['invoiceSchema', 'retrySchema', 'webEnvSchema']);
});

// ── A1.7: the boot printed once, deferred work named not walked ─────────────

/** An edge carrying the contract's meta keys (`origin: 'setup'`, `deferred`, `tx`). */
const mEdge = (kind: GraphEdge['kind'], from: string, to: string, meta: GraphEdge['meta']): GraphEdge =>
  ({ id: `${kind}|${from}|${to}`, kind, from, to, meta });

/** Two screens, each reaching the process container: the second request must not rebuild it. */
function boot(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    node(`${R}::flow::boot`, 'flow', 'Boot twice', { design: { id: 'FL-B', status: 'both', source: 'docs/design/screens.json' } }),
    node(`${R}::page::/a`, 'page', '/a', { loc: { repo: R, path: 'ui/router.tsx', line: 3 } }),
    node(`${R}::page::/b`, 'page', '/b', { loc: { repo: R, path: 'ui/router.tsx', line: 4 } }),
    fn('h1', 'a.ts', 1), fn('h2', 'b.ts', 1),
    fn('getContainer', 'container.ts', 170), fn('build', 'container.ts', 60, { tags: ['setup'] }),
    fn('runMigrations', 'db.ts', 5),
    node(`${R}::table::schema_migrations`, 'table', 'schema_migrations'),
  ];
  const edges: GraphEdge[] = [
    edge('renders', `${R}::flow::boot`, `${R}::page::/a`, 1),
    edge('renders', `${R}::flow::boot`, `${R}::page::/b`, 2),
    edge('calls', `${R}::page::/a`, `${R}::a.ts::h1`, 3),
    edge('calls', `${R}::page::/b`, `${R}::b.ts::h2`, 4),
    edge('calls', `${R}::a.ts::h1`, `${R}::container.ts::getContainer`, 11),
    edge('calls', `${R}::b.ts::h2`, `${R}::container.ts::getContainer`, 21),
    // the closure: the call into the setup root, and everything it does inside
    mEdge('calls', `${R}::container.ts::getContainer`, `${R}::container.ts::build`, { line: 176, origin: 'setup' }),
    mEdge('calls', `${R}::container.ts::build`, `${R}::db.ts::runMigrations`, { line: 61, origin: 'setup' }),
    mEdge('writes', `${R}::db.ts::runMigrations`, `${R}::table::schema_migrations`, { line: 6, origin: 'setup' }),
  ];
  return { nodes, edges };
}

test('the boot is one step on the whole journey: printed once, never descended, never a record of the request', () => {
  const { nodes, edges } = boot();
  const index = buildIndex(nodes, edges);
  const entry = `${R}::flow::boot`;
  const j = journey(index, entry);
  const setups = j.steps.filter((s) => s.setup);
  assert.deepEqual(setups.map((s) => index.byId.get(s.nodeId)!.name), ['build'],
    'two requests reach the container; the boot is printed at the first one and skipped at the second');
  assert.ok(!j.steps.some((s) => s.nodeId === `${R}::db.ts::runMigrations`), 'the closure is named, not walked');
  assert.ok(!j.steps.some((s) => s.nodeId === `${R}::table::schema_migrations`), 'so a migration never reads as this request’s write');

  const sum = journeySummary(index, j, screensFor(index, entry));
  assert.equal(sum.counts.setup, 1);
  assert.deepEqual(sum.system.records, [], 'nothing the boot touched is a record of the journey');
  assert.deepEqual(sum.segments.map((sg) => sg.counts.setup), [1, 0]);
  const mk = sum.segments[0]!.markers.find((m) => m.kind === 'setup')!;
  assert.equal(mk.name, 'build');
  assert.equal(mk.system, `repo:${R}:server`, 'the boot belongs to the process that runs it, not the browser that waited');

  // a later, genuine call to the same function is a step of its own: the printed-once step
  // never entered the walk's visit budget
  const solo = [fn('h', 'x.ts', 1), fn('getContainer', 'container.ts', 170), fn('build', 'container.ts', 60, { tags: ['setup'] })];
  const j2 = journey(buildIndex(solo, [
    edge('calls', `${R}::x.ts::h`, `${R}::container.ts::getContainer`, 2),
    mEdge('calls', `${R}::container.ts::getContainer`, `${R}::container.ts::build`, { line: 176, origin: 'setup' }),
    edge('calls', `${R}::x.ts::h`, `${R}::container.ts::build`, 3),
  ]), `${R}::x.ts::h`);
  assert.deepEqual(j2.steps.filter((s) => s.nodeId === `${R}::container.ts::build`).map((s) => [s.setup ?? false, s.repeat]),
    [[true, false], [false, false]], 'the boot, then a real call — not a re-visit of it');
});

/** A screen that submits: the handler registers a hook that runs later, on its own. */
function afterwards(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const UI = 'ui/Page.tsx', CLIENT = 'api/client.ts', SVC = 'server/svc.ts';
  const nodes: GraphNode[] = [
    node(`${R}::page::/p`, 'page', '/p', { loc: { repo: R, path: UI, line: 1 } }),
    node(`${R}::${UI}::Screen`, 'component', 'Screen', { loc: { repo: R, path: UI, line: 3 } }),
    fn('onSubmit', UI, 5), fn('submitInvoice', CLIENT, 10),
    node(`${R}::route::POST /invoices`, 'route', 'POST /invoices', { loc: { repo: R, path: 'server/routes.ts', line: 5 } }),
    fn('submit', SVC, 20), fn('invoiceCreated', 'server/container.ts', 110, { tags: ['callback'] }),
    node(`${R}::table::invoices`, 'table', 'invoices'),
  ];
  const edges: GraphEdge[] = [
    edge('renders', `${R}::page::/p`, `${R}::${UI}::Screen`, 2),
    edge('calls', `${R}::${UI}::Screen`, `${R}::${UI}::onSubmit`, 4),
    edge('calls', `${R}::${UI}::onSubmit`, `${R}::${CLIENT}::submitInvoice`, 6),
    edge('http', `${R}::${CLIENT}::submitInvoice`, `${R}::route::POST /invoices`, 11),
    edge('calls', `${R}::route::POST /invoices`, `${R}::${SVC}::submit`, 6),
    mEdge('calls', `${R}::${SVC}::submit`, `${R}::server/container.ts::invoiceCreated`, { line: 30, deferred: true }),
    edge('writes', `${R}::server/container.ts::invoiceCreated`, `${R}::table::invoices`, 111),
  ];
  return { nodes, edges };
}

test('deferred work is named where it was registered and left there: its own row, its own step, no subtree', () => {
  const { nodes, edges } = afterwards();
  const index = buildIndex(nodes, edges);
  const entry = `${R}::page::/p`;
  const j = journey(index, entry);
  const hook = j.steps.find((s) => s.nodeId === `${R}::server/container.ts::invoiceCreated`)!;
  assert.equal(hook.deferred, true);
  assert.ok(!j.steps.some((s) => s.nodeId === `${R}::table::invoices`), 'what the hook will write is not what this request wrote');

  const sum = journeySummary(index, j, screensFor(index, entry));
  assert.equal(sum.counts.deferred, 1);
  assert.deepEqual(sum.system.records, []);
  assert.deepEqual(sum.system.afterwards.map((a) => a.name), ['invoiceCreated']);
  const rows = sum.systems.map((r) => [r.key, r.kind]);
  assert.deepEqual(rows[rows.length - 1], ['afterwards', 'afterwards'], 'the last row on the request path');
  const seg = sum.segments[0]!;
  const mk = seg.markers.find((m) => m.kind === 'deferred')!;
  assert.equal(mk.system, 'afterwards');
  assert.equal(seg.counts.deferred, 1);
  const submit = seg.markers.find((m) => m.name === 'submit')!;
  assert.deepEqual(seg.moments[mk.moment]!.afterwards, [
    { stepOrder: hook.order, nodeId: `${R}::server/container.ts::invoiceCreated`, name: 'invoiceCreated', hostStep: submit.stepOrder },
  ], 'listed against the action that registered it, with the step that did');
});

// ── A1.7: plumbing by config, and the titles a non-code register prints ─────

/** One call whose handler goes through a declared-plumbing transport that reads a table. */
function plumbing(tagged: boolean, guardParent = false): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const UI = 'ui/Page.tsx', CLIENT = 'api/client.ts', SVC = 'server/svc.ts';
  const nodes: GraphNode[] = [
    node(`${R}::page::/p`, 'page', '/p', { loc: { repo: R, path: UI, line: 1 } }),
    node(`${R}::${UI}::Screen`, 'component', 'Screen', { loc: { repo: R, path: UI, line: 3 } }),
    fn('load', UI, 5), fn('fetchIt', CLIENT, 10),
    node(`${R}::route::GET /x`, 'route', 'GET /x', { loc: { repo: R, path: 'server/routes.ts', line: 5 } }),
    // a @guard with a body is walked (meta.via: 'guard') — the checkpoint and the work in one node
    guardParent
      ? node(`${R}::${SVC}::handle`, 'guard', 'handle', { loc: { repo: R, path: SVC, line: 20 } })
      : fn('handle', SVC, 20),
    fn('transport', 'libs/http/transport.ts', 30, {
      ...(tagged ? { tags: ['plumbing'] } : {}),
      facets: { business: { label: 'Sends the request', description: 'Sends the request and records the attempt.' } },
    }),
    node(`${R}::table::audit_log`, 'table', 'audit_log'),
  ];
  const edges: GraphEdge[] = [
    edge('renders', `${R}::page::/p`, `${R}::${UI}::Screen`, 2),
    edge('calls', `${R}::${UI}::Screen`, `${R}::${UI}::load`, 4),
    edge('calls', `${R}::${UI}::load`, `${R}::${CLIENT}::fetchIt`, 6),
    edge('http', `${R}::${CLIENT}::fetchIt`, `${R}::route::GET /x`, 11),
    ...(guardParent ? [edge('guards', `${R}::${SVC}::handle`, `${R}::route::GET /x`, 6)] : []),
    { ...edge('calls', `${R}::route::GET /x`, `${R}::${SVC}::handle`, 6), ...(guardParent ? { meta: { line: 6, via: 'guard' } } : {}) },
    edge('calls', `${R}::${SVC}::handle`, `${R}::libs/http/transport.ts::transport`, 21),
    edge('reads', `${R}::libs/http/transport.ts::transport`, `${R}::table::audit_log`, 31),
  ];
  return { nodes, edges };
}

test('plumbing under a walked guard folds too — a @guard with a body is a part like any function', () => {
  const entry = `${R}::page::/p`;
  const { nodes, edges } = plumbing(true, true);
  const index = buildIndex(nodes, edges);
  const sg = journeySummary(index, journey(index, entry), screensFor(index, entry)).segments[0]!;
  const transport = sg.markers.find((m) => m.nodeId === `${R}::libs/http/transport.ts::transport`)!;
  const handle = sg.markers.find((m) => m.name === 'handle')!;
  assert.equal(handle.helper, undefined, 'the guard itself is never plumbing');
  assert.equal(transport.helper, true, 'the reference app: submitDraftInvoice is a @guard — its transport must still fold');
  assert.equal(sg.markers.find((m) => m.kind === 'record')!.under, handle.stepOrder);
});

test('declared plumbing folds whatever it says about itself — and the table it read is still drawn, under the part that used it', () => {
  const entry = `${R}::page::/p`;
  const fold = (tagged: boolean) => {
    const { nodes, edges } = plumbing(tagged);
    const index = buildIndex(nodes, edges);
    return journeySummary(index, journey(index, entry), screensFor(index, entry)).segments[0]!;
  };
  const off = fold(false);
  assert.equal(off.markers.find((m) => m.nodeId === `${R}::libs/http/transport.ts::transport`)!.helper, undefined,
    'authored prose and a table read would keep any other function visible');

  const on = fold(true);
  const transport = on.markers.find((m) => m.nodeId === `${R}::libs/http/transport.ts::transport`)!;
  const handle = on.markers.find((m) => m.name === 'handle')!;
  const row = on.markers.find((m) => m.kind === 'record')!;
  assert.equal(transport.helper, true, 'a path the config calls plumbing is a helper regardless of @business');
  assert.equal(row.name, 'audit_log');
  assert.equal(row.helper, undefined, 'records are never folded');
  assert.equal(row.under, handle.stepOrder, 'it hangs under the nearest part that is not plumbing, so nothing it touched is lost');
  assert.equal(on.moments[transport.moment]!.counts.helpers, 1);
});

test('an env-schema rule never becomes a checkpoint in the fold, and a plumbing rule does not either', () => {
  const nodes: GraphNode[] = [
    node(`${R}::route::POST /invoices`, 'route', 'POST /invoices', { loc: { repo: R, path: 'route.ts', line: 1 } }),
    node(`${R}::env.ts::webEnvSchema`, 'rule', 'webEnvSchema', { loc: { repo: R, path: 'env.ts', line: 4 }, tags: ['env-schema'] }),
    node(`${R}::http/client.ts::retrySchema`, 'rule', 'retrySchema', { loc: { repo: R, path: 'http/client.ts', line: 9 }, tags: ['plumbing'] }),
    node(`${R}::schemas.ts::invoiceSchema`, 'rule', 'invoiceSchema', { loc: { repo: R, path: 'schemas.ts', line: 2 }, tags: [] }),
  ];
  const edges: GraphEdge[] = [
    edge('validates', `${R}::env.ts::webEnvSchema`, `${R}::route::POST /invoices`),
    edge('validates', `${R}::http/client.ts::retrySchema`, `${R}::route::POST /invoices`),
    edge('validates', `${R}::schemas.ts::invoiceSchema`, `${R}::route::POST /invoices`),
  ];
  const idx = buildIndex(nodes, edges);
  const entry = `${R}::route::POST /invoices`;
  const sum = journeySummary(idx, journey(idx, entry), screensFor(idx, entry));
  assert.deepEqual(sum.business.rules.map((r) => r.name), ['invoiceSchema']);
  assert.deepEqual(sum.segments[0]!.gates.map((g) => g.name), ['invoiceSchema']);
  assert.equal(sum.counts.gates, 1);
  assert.equal(sum.counts.checks, 1, 'one checkpoint, met once');
});

test('titles: a verb-named handler borrows its route’s spec summary, an authored function keeps its own words', () => {
  const RT = `${R}::route::POST /invoices`;
  const nodes: GraphNode[] = [
    node(RT, 'route', 'POST /invoices', {
      loc: { repo: R, path: 'server/routes.ts', line: 5 },
      contract: { status: 'both', apiId: `${R}::api::openapi.yaml`, summary: 'Submit an invoice for processing.', spec: { path: 'openapi.yaml', operationId: 'submitInvoice' } },
    }),
    fn('POST', 'app/api/invoices/route.ts', 10),
    fn('chargeCard', 'server/pay.ts', 20, { facets: { business: { label: 'Takes the payment' } } }),
    fn('plain', 'server/pay.ts', 40, { docs: 'Does the thing. And more prose after it.' }),
    fn('GET', 'server/pay.ts', 60),
  ];
  const edges: GraphEdge[] = [
    edge('calls', RT, `${R}::app/api/invoices/route.ts::POST`, 6),
    edge('calls', `${R}::app/api/invoices/route.ts::POST`, `${R}::server/pay.ts::chargeCard`, 11),
    edge('calls', `${R}::app/api/invoices/route.ts::POST`, `${R}::server/pay.ts::plain`, 12),
    edge('calls', `${R}::server/pay.ts::chargeCard`, `${R}::server/pay.ts::GET`, 21),
  ];
  const idx = buildIndex(nodes, edges);
  const sum = journeySummary(idx, journey(idx, RT), screensFor(idx, RT));
  // a marker is *named* by its business label where there is one, so look these up by id
  const title = (id: string) => sum.segments[0]!.markers.find((m) => m.nodeId === id)!.title;
  assert.equal(title(`${R}::app/api/invoices/route.ts::POST`), 'Submit an invoice for processing.', 'the file convention has no words of its own: the spec’s do');
  assert.equal(title(`${R}::server/pay.ts::chargeCard`), 'Takes the payment', '@business wins over everything');
  assert.equal(title(`${R}::server/pay.ts::plain`), 'Does the thing.', 'else the first sentence a person wrote');
  assert.equal(title(`${R}::server/pay.ts::GET`), undefined, 'a verb-named function under a function borrows nothing — an absence, never a guess');
  assert.equal(title(RT), 'Submit an invoice for processing.');

  // and the marker says WHICH of the three the words are, so a surface can give a
  // short name room beside the identifier without re-deriving the rule and leave a
  // documentation sentence to the panel that has room for it
  const from = (id: string) => sum.segments[0]!.markers.find((m) => m.nodeId === id)!.titleFrom;
  assert.equal(from(`${R}::app/api/invoices/route.ts::POST`), 'route', 'the identifier is only an HTTP verb — the words are the route’s');
  assert.equal(from(`${R}::server/pay.ts::chargeCard`), 'label', 'a short name a person authored');
  assert.equal(from(`${R}::server/pay.ts::plain`), 'docs', 'a sentence out of the documentation');
  assert.equal(from(`${R}::server/pay.ts::GET`), undefined, 'no words, so nothing to say about where they came from');
  // the two are present or absent together on every marker of the walk
  for (const m of sum.segments.flatMap((sg) => sg.markers)) {
    assert.equal(m.title === undefined, m.titleFrom === undefined, `${m.name}: title and titleFrom disagree`);
  }
});

test('the action’s headline prefers the summary the API’s authors wrote over a humanized client identifier', () => {
  const RT = `${R}::route::GET /invoices`;
  const nodes: GraphNode[] = [
    node(`${R}::page::/p`, 'page', '/p', { loc: { repo: R, path: 'ui/Page.tsx', line: 1 } }),
    fn('fetchInvoices', 'api/client.ts', 10),
    node(RT, 'route', 'GET /invoices', {
      loc: { repo: R, path: 'server/routes.ts', line: 5 },
      contract: { status: 'both', apiId: `${R}::api::openapi.yaml`, summary: 'List every invoice.', spec: { path: 'openapi.yaml', operationId: 'listInvoices' } },
    }),
  ];
  const idx = buildIndex(nodes, [
    edge('calls', `${R}::page::/p`, `${R}::api/client.ts::fetchInvoices`, 3),
    edge('http', `${R}::api/client.ts::fetchInvoices`, RT, 11),
  ]);
  const sum = journeySummary(idx, journey(idx, `${R}::page::/p`), screensFor(idx, `${R}::page::/p`));
  assert.deepEqual(sum.segments[0]!.moments.map((m) => m.label), ['List every invoice.'], 'not "Fetch invoices"');
});

// ── A1.7: the manifest ranks the actions, and names the ones nobody made ────

test('rank and declared come from the screen’s manifest; an operation no action made is a declared-only stop', () => {
  const rt = (name: string, op: string, summary: string): GraphNode =>
    node(`${R}::route::${name}`, 'route', name, {
      loc: { repo: R, path: 'server/routes.ts', line: 5 },
      contract: { status: 'both', apiId: `${R}::api::openapi.yaml`, summary, spec: { path: 'openapi.yaml', operationId: op } },
    });
  const nodes: GraphNode[] = [
    node(`${R}::page::/s`, 'page', '/s', {
      loc: { repo: R, path: 'ui/Page.tsx', line: 1 },
      design: { id: 'S-1', status: 'both', origin: 'manifest', operations: ['opA', 'opB', 'opC'] },
    }),
    fn('cA', 'api/client.ts', 30), fn('cB', 'api/client.ts', 10), fn('cZ', 'api/client.ts', 20),
    rt('GET /a', 'opA', 'A summary'), rt('GET /b', 'opB', 'B summary'),
    rt('GET /c', 'opC', 'C summary'), rt('GET /z', 'opZ', 'Z summary'),
  ];
  const idx = buildIndex(nodes, [
    edge('calls', `${R}::page::/s`, `${R}::api/client.ts::cB`, 10),
    edge('calls', `${R}::page::/s`, `${R}::api/client.ts::cZ`, 20),
    edge('calls', `${R}::page::/s`, `${R}::api/client.ts::cA`, 30),
    edge('http', `${R}::api/client.ts::cB`, `${R}::route::GET /b`, 11),
    edge('http', `${R}::api/client.ts::cZ`, `${R}::route::GET /z`, 21),
    edge('http', `${R}::api/client.ts::cA`, `${R}::route::GET /a`, 31),
  ]);
  const sum = journeySummary(idx, journey(idx, `${R}::page::/s`), screensFor(idx, `${R}::page::/s`));
  const seg = sum.segments[0]!;
  assert.deepEqual(seg.moments.map((m) => m.label), ['B summary', 'Z summary', 'A summary'], 'moments[] stays in walk order');
  assert.deepEqual(seg.moments.map((m) => [m.rank, m.declared]), [[1, true], [4, false], [0, true]],
    'the manifest’s order, and the call it never listed ranked after all three');
  assert.deepEqual(seg.declaredOnly, [{ op: 'opC', routeId: `${R}::route::GET /c`, label: 'C summary' }]);
});

// ── A1.7: one gate met many times is one gate and many checks ───────────────

test('counts.checks is how many times the walk met a checkpoint; counts.gates is how many there are', () => {
  const { nodes, edges } = sharedHelper(3);
  nodes.push(node(`${R}::server/auth.ts::requireSession`, 'guard', 'requireSession', { loc: { repo: R, path: 'server/auth.ts', line: 4 } }));
  for (const r of ['GET /x', 'GET /y', 'GET /z']) {
    edges.push(edge('guards', `${R}::server/auth.ts::requireSession`, `${R}::route::${r}`));
  }
  const index = buildIndex(nodes, edges);
  const entry = `${R}::page::/p`;
  const sum = journeySummary(index, journey(index, entry), screensFor(index, entry));
  assert.equal(sum.counts.gates, 1, 'one checkpoint by name');
  assert.equal(sum.counts.checks, 3, 'met on all three routes');
  assert.ok(sum.counts.checks >= sum.counts.gates);
  assert.equal(sum.segments[0]!.counts.checks, 3);
  assert.equal(sum.segments[0]!.counts.gates, 1);
  assert.deepEqual(sum.segments[0]!.gates.map((g) => [g.name, g.count]), [['requireSession', 3]]);
});

// ── A1.7: externals say what kind of system they are ───────────────────────

test('mail is drawn in the messages row; every other third party keeps its own row and says its kind', () => {
  const RT = `${R}::route::POST /submit`;
  const nodes: GraphNode[] = [
    node(RT, 'route', 'POST /submit', { loc: { repo: R, path: 'server/routes.ts', line: 5 } }),
    fn('notify', 'server/notifier.ts', 10), fn('syncToErp', 'server/bc.ts', 10),
    node(`${R}::external::Azure Communication Services`, 'external', 'Azure Communication Services', {
      external: { kind: 'email', source: 'sdk', via: 'AcsEmailTransport', ref: '@azure/communication-email' },
    }),
    node(`${R}::external::Business Central`, 'external', 'Business Central', {
      external: { kind: 'erp', source: 'config', via: 'BcClient' },
    }),
  ];
  const idx = buildIndex(nodes, [
    edge('calls', RT, `${R}::server/notifier.ts::notify`, 6),
    edge('calls', RT, `${R}::server/bc.ts::syncToErp`, 7),
    edge('http', `${R}::server/notifier.ts::notify`, `${R}::external::Azure Communication Services`, 11),
    edge('http', `${R}::server/bc.ts::syncToErp`, `${R}::external::Business Central`, 11),
  ]);
  const sum = journeySummary(idx, journey(idx, RT), screensFor(idx, RT));
  const seg = sum.segments[0]!;
  assert.equal(seg.markers.find((m) => m.name === 'Azure Communication Services')!.system, 'messages',
    'an email is a message to a reader — one node, a lens choice in the fold');
  assert.equal(seg.markers.find((m) => m.name === 'Business Central')!.system, `external:Business Central`);
  const row = sum.systems.find((r) => r.key === 'external:Business Central')!;
  assert.deepEqual([row.kind, row.externalKind, row.label], ['external', 'erp', 'Business Central']);
  assert.ok(sum.systems.some((r) => r.key === 'messages'));
  assert.deepEqual(sum.systems.map((r) => r.kind), ['api', 'repo', 'messages', 'external'], 'the request path read downward');
});

// ── A1.7: the cut list, and impact_of skipping the boot ────────────────────

test('a segment lists its cut points — the same ones the chip counts, each named where it happened', () => {
  const { nodes, edges } = twoScreens();
  const index = buildIndex(nodes, edges);
  const entry = `${R}::flow::two`;
  const j = journey(index, entry, { maxDepth: 4 });
  const sum = journeySummary(index, j, screensFor(index, entry));
  const sg = sum.segments[0]!;
  const a3 = sg.markers.find((m) => m.name === 'a3')!;
  assert.deepEqual(sg.cutPoints, [{ parentStep: a3.stepOrder, nodeId: `${R}::a.ts::a4`, name: 'a4', reason: 'depth', moment: a3.moment }]);
  assert.equal(sg.cutPoints.length, sg.counts.cutPoints, 'the list and the chip are the same fact');
  assert.deepEqual(sum.segments[1]!.cutPoints, []);
});

// B4.3: the chip opens a list, so the list has to be the chip. Both are built from
// the same filtered array — this pins that, at every budget the fixture can hit and
// for both reasons, and pins the other half of the promise too: every row names a
// marker the segment actually draws, so a reader who clicks one lands somewhere.
test('the cut list is the cut count, itemised — at every budget, and every row names a drawn marker', () => {
  const { nodes, edges } = twoScreens();
  const index = buildIndex(nodes, edges);
  const entry = `${R}::flow::two`;
  const seen = new Set<string>();
  for (const opts of [{ maxDepth: 2 }, { maxDepth: 3 }, { maxDepth: 4 }, { maxDepth: 5 }, { maxDepth: 20 }, { maxSteps: 4 }, { maxSteps: 6 }]) {
    const j = journey(index, entry, opts);
    const sum = journeySummary(index, j, screensFor(index, entry));
    const counted = j.cutPoints.filter((c) => c.reason !== 'repeat').length;
    const listed = sum.segments.reduce((a, sg) => a + sg.cutPoints.length, 0);
    const label = JSON.stringify(opts);
    assert.equal(sum.counts.cutPoints, counted, `the count is the non-repeat cuts ${label}`);
    assert.equal(listed, counted, `the list sums to the chip ${label}`);
    assert.equal(sum.segments.reduce((a, sg) => a + sg.counts.cutPoints, 0), counted, `and so do the per-segment chips ${label}`);
    for (const sg of sum.segments) {
      for (const c of sg.cutPoints) {
        seen.add(c.reason);
        assert.ok(sg.markers.some((m) => m.stepOrder === c.parentStep),
          `${c.name} is hung on a marker this segment draws ${label}`);
      }
    }
  }
  assert.deepEqual([...seen].sort(), ['depth', 'steps'], 'both reasons were exercised, and a re-visit is never one of them');
});

test('impact() can skip an edge kind: the boot is not what depends on a table', () => {
  const nodes: GraphNode[] = [
    node(`${R}::table::invoices`, 'table', 'invoices'),
    fn('findInvoice', 'server/repo.ts', 10), fn('buildContainer', 'container.ts', 60, { tags: ['setup'] }),
    fn('seedPg', 'db.ts', 20),
  ];
  const edges: GraphEdge[] = [
    edge('reads', `${R}::server/repo.ts::findInvoice`, `${R}::table::invoices`, 11),
    mEdge('writes', `${R}::db.ts::seedPg`, `${R}::table::invoices`, { line: 21, origin: 'setup' }),
    mEdge('calls', `${R}::container.ts::buildContainer`, `${R}::db.ts::seedPg`, { line: 61, origin: 'setup' }),
  ];
  const index = buildIndex(nodes, edges);
  const all = impact(index, `${R}::table::invoices`).nodes.map((n) => n.name).sort();
  assert.deepEqual(all, ['buildContainer', 'findInvoice', 'invoices', 'seedPg']);
  const skipped = impact(index, `${R}::table::invoices`, { skip: (e) => e.meta?.origin === 'setup' }).nodes.map((n) => n.name).sort();
  assert.deepEqual(skipped, ['findInvoice', 'invoices'], 'what the boot wrote is reported apart, never as hop 1');
});

test('a third party the server reaches does not open an action of its own — its marker and the afterwards stay with the call that caused them', () => {
  const UI = 'ui/Page.tsx', CLIENT = 'api/client.ts', SVC = 'server/svc.ts';
  const nodes: GraphNode[] = [
    node(`${R}::page::/p`, 'page', '/p', { loc: { repo: R, path: UI, line: 1 } }),
    node(`${R}::${UI}::Screen`, 'component', 'Screen', { loc: { repo: R, path: UI, line: 3 } }),
    fn('submit', UI, 5), fn('postIt', CLIENT, 10),
    node(`${R}::route::POST /x`, 'route', 'POST /x', { loc: { repo: R, path: 'server/routes.ts', line: 5 } }),
    fn('handle', SVC, 20), fn('BcClient.request', 'server/bc.ts', 30),
    node(`${R}::external::Business Central`, 'external', 'Business Central', { external: { kind: 'erp', source: 'config', via: 'BcClient' } } as Partial<GraphNode>),
    fn('build.hooks.invoiceCreated', 'server/container.ts', 40, { tags: ['callback'] }),
  ];
  const edges: GraphEdge[] = [
    edge('renders', `${R}::page::/p`, `${R}::${UI}::Screen`, 2),
    edge('calls', `${R}::${UI}::Screen`, `${R}::${UI}::submit`, 4),
    edge('calls', `${R}::${UI}::submit`, `${R}::${CLIENT}::postIt`, 6),
    edge('http', `${R}::${CLIENT}::postIt`, `${R}::route::POST /x`, 11),
    edge('calls', `${R}::route::POST /x`, `${R}::${SVC}::handle`, 6),
    edge('calls', `${R}::${SVC}::handle`, `${R}::server/bc.ts::BcClient.request`, 21),
    edge('http', `${R}::server/bc.ts::BcClient.request`, `${R}::external::Business Central`, 31),
    { ...edge('calls', `${R}::server/bc.ts::BcClient.request`, `${R}::server/container.ts::build.hooks.invoiceCreated`, 32), meta: { line: 32, via: 'hook', deferred: true } },
  ];
  const index = buildIndex(nodes, edges);
  const entry = `${R}::page::/p`;
  const sg = journeySummary(index, journey(index, entry), screensFor(index, entry)).segments[0]!;
  assert.equal(sg.moments.length, 1, 'one client-side action: the submit');
  const ext = sg.markers.find((m) => m.kind === 'external')!;
  assert.equal(ext.moment, 0, 'the third party is a marker of the action that reached it');
  assert.deepEqual(sg.moments[0]!.afterwards.map((a) => a.name), ['build.hooks.invoiceCreated']);
});
