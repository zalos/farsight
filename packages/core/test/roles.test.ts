// A gate at every action it guards, with that call site's own roles — and the role × action table
// (outsider round 2026-10-13, worklist F2 + F4). On the reference app the approve action's column showed no
// *who may*: the segment fold merged a screen's gates by name, kept the first occurrence's step and unioned the
// roles, so the role guard landed on the first action that met it with every role any action passed. These tests
// pin the placement (one guard, two actions, two role lists) and the table folded from the guards edges.
//
// In-memory fixtures. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndex, journey, journeySummary, screensFor, gatesInRange, roleTable, rolesFor, rolesCsv, countedProblems,
} from '../dist/index.js';
import type { GraphNode, GraphEdge } from '../dist/index.js';

const R = 'ops';
const loc = (path: string, line: number) => ({ repo: R, path, line });
let eid = 0;
const edge = (kind: GraphEdge['kind'], from: string, to: string, meta?: Record<string, unknown>): GraphEdge => ({ id: `e${eid++}`, kind, from, to, ...(meta ? { meta } : {}) });

const FLOW = `${R}::flow::review`;
const PAGE = `${R}::page::/review`;
const COMP = `${R}::src/review/page.tsx::ReviewPage`;
const C_VERIFY = `${R}::src/client.ts::verifyInvoice`;
const C_APPROVE = `${R}::src/client.ts::approveInvoice`;
const C_VENDOR = `${R}::src/client.ts::approveVendor`;
const R_VERIFY = `${R}::route::POST /invoices/:param/verify`;
const R_APPROVE = `${R}::route::POST /invoices/:param/approve`;
const R_VENDOR = `${R}::route::POST /vendors/:param/approve`;
const H_VERIFY = `${R}::src/api/verify/route.ts::POST`;
const H_APPROVE = `${R}::src/api/approve/route.ts::POST`;
const H_VENDOR = `${R}::src/api/vendor/route.ts::POST`;
const ROLE = `${R}::src/auth/principal.ts::requireRole`;
const SESSION = `${R}::src/auth/principal.ts::requireSession`;
const T_APPROVE = `${R}::test::src/api/approve/route.spec.ts::403 when a reviewer approves`;
const T_VENDOR = `${R}::test::src/api/vendor/route.spec.ts::an admin approves a vendor`;
const REVIEW = 'ops.reviewer, ops.approver, ops.admin';

function ops(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const run = { id: 'r1', status: 'passed', at: '2026-10-08T10:00:00.000Z', durationMs: 5 };
  const nodes: GraphNode[] = [
    { id: FLOW, kind: 'flow', name: 'Verify and approve', loc: loc('docs/screens.json', 1), design: { status: 'both', origin: 'manifest', id: 'review' } as GraphNode['design'] },
    { id: PAGE, kind: 'page', name: '/review', loc: loc('src/review/page.tsx', 1) },
    { id: COMP, kind: 'component', name: 'ReviewPage', loc: loc('src/review/page.tsx', 3) },
    { id: C_VERIFY, kind: 'function', name: 'verifyInvoice', loc: loc('src/client.ts', 4) },
    { id: C_APPROVE, kind: 'function', name: 'approveInvoice', loc: loc('src/client.ts', 9) },
    { id: C_VENDOR, kind: 'function', name: 'approveVendor', loc: loc('src/client.ts', 14) },
    { id: R_VERIFY, kind: 'route', name: 'POST /invoices/:param/verify', loc: loc('src/api/verify/route.ts', 8) },
    { id: R_APPROVE, kind: 'route', name: 'POST /invoices/:param/approve', loc: loc('src/api/approve/route.ts', 8), contract: { status: 'both', summary: 'Approve an invoice' } as GraphNode['contract'] },
    { id: R_VENDOR, kind: 'route', name: 'POST /vendors/:param/approve', loc: loc('src/api/vendor/route.ts', 8) },
    { id: H_VERIFY, kind: 'function', name: 'POST', loc: loc('src/api/verify/route.ts', 8) },
    { id: H_APPROVE, kind: 'function', name: 'POST', loc: loc('src/api/approve/route.ts', 8) },
    { id: H_VENDOR, kind: 'function', name: 'POST', loc: loc('src/api/vendor/route.ts', 8) },
    { id: ROLE, kind: 'guard', name: 'requireRole: session role', loc: loc('src/auth/principal.ts', 40), tags: ['auth'],
      facets: { business: { description: 'Refuses a console action the signed-in operator’s role does not allow.' } } },
    { id: SESSION, kind: 'guard', name: 'requireSession: signed in', loc: loc('src/auth/principal.ts', 10), tags: ['auth'] },
    { id: T_APPROVE, kind: 'test', name: '403 when a reviewer approves', loc: loc('src/api/approve/route.spec.ts', 12),
      test: { level: 'unit', runner: 'vitest', suite: [], file: 'src/api/approve/route.spec.ts', run } as unknown as GraphNode['test'] },
    { id: T_VENDOR, kind: 'test', name: 'an admin approves a vendor', loc: loc('src/api/vendor/route.spec.ts', 5),
      test: { level: 'unit', runner: 'vitest', suite: [], file: 'src/api/vendor/route.spec.ts', run } as unknown as GraphNode['test'] },
  ];
  const edges: GraphEdge[] = [
    edge('renders', FLOW, PAGE, { line: 1 }),
    edge('renders', PAGE, COMP),
    edge('calls', COMP, C_VERIFY, { line: 5 }),
    edge('calls', COMP, C_APPROVE, { line: 6 }),
    edge('calls', COMP, C_VENDOR, { line: 7 }),
    edge('http', C_VERIFY, R_VERIFY, { method: 'POST', line: 5 }),
    edge('http', C_APPROVE, R_APPROVE, { method: 'POST', line: 10 }),
    edge('http', C_VENDOR, R_VENDOR, { method: 'POST', line: 15 }),
    edge('calls', R_VERIFY, H_VERIFY), edge('calls', R_APPROVE, H_APPROVE), edge('calls', R_VENDOR, H_VENDOR),
    // the parser writes the guards edge on the handler and on the route that inherits it, each with the roles
    // read from the call's constant argument (parsers preconditions.ts)
    edge('guards', ROLE, H_VERIFY, { requires: REVIEW, requiresFrom: 'ROLES.review' }),
    edge('guards', ROLE, R_VERIFY, { via: 'handler', handler: H_VERIFY, requires: REVIEW, requiresFrom: 'ROLES.review' }),
    edge('guards', ROLE, H_APPROVE, { requires: 'ops.approver', requiresFrom: 'ROLES.approve' }),
    edge('guards', ROLE, R_APPROVE, { via: 'handler', handler: H_APPROVE, requires: 'ops.approver', requiresFrom: 'ROLES.approve' }),
    edge('guards', ROLE, H_VENDOR, { requires: 'ops.approver, ops.admin', requiresFrom: 'VENDOR_APPROVER_ROLES' }),
    edge('guards', ROLE, R_VENDOR, { via: 'handler', handler: H_VENDOR, requires: 'ops.approver, ops.admin', requiresFrom: 'VENDOR_APPROVER_ROLES' }),
    edge('guards', SESSION, R_VERIFY), edge('guards', SESSION, R_APPROVE), edge('guards', SESSION, R_VENDOR),
    // a results report named the case and coverage placed it on the route: observed
    edge('covers', T_APPROVE, R_APPROVE, { evidence: 'observed' }),
    edge('covers', T_VENDOR, H_VENDOR, { evidence: 'static' }),
  ];
  return { nodes: nodes.map((n) => ({ tags: [], ...n })), edges };
}

const summaryOf = () => {
  const { nodes, edges } = ops();
  const index = buildIndex(nodes, edges);
  return { index, sum: journeySummary(index, journey(index, FLOW), screensFor(index, FLOW)) };
};

test('a guard met by two actions on one screen stands under both, each with the roles its own call site passed', () => {
  const { sum } = summaryOf();
  const seg = sum.segments.find((s) => s.screen?.id === PAGE)!;
  assert.ok(seg, 'the review screen is a segment');
  const momentOf = (route: string) => seg.moments.find((m) => seg.markers.some((mk) => mk.stepOrder === m.callStep && mk.nodeId === route))!;
  const verify = momentOf(R_VERIFY), approve = momentOf(R_APPROVE);
  assert.ok(verify && approve, 'one moment per action');
  const roleAt = (mo: { from: number; to: number }) => gatesInRange(seg, mo.from, mo.to).find((g) => g.id === ROLE);
  assert.equal(roleAt(verify)?.requires, REVIEW, 'verify: the review roles');
  assert.equal(roleAt(approve)?.requires, 'ops.approver', 'approve: the approver alone — not the union, not absent');
  // the placed copy stands on a step of its own action
  const a = roleAt(approve)!;
  assert.ok(a.stepOrder >= approve.from && a.stepOrder <= approve.to);
});

test('placing a gate at every action does not count it twice: the screen still counts distinct gates', () => {
  const { sum } = summaryOf();
  const seg = sum.segments.find((s) => s.screen?.id === PAGE)!;
  const role = seg.gates.filter((g) => g.id === ROLE);
  assert.equal(role.length, 1, 'one gate, one row in the screen list');
  assert.equal(seg.counts.gates, seg.gates.length);
  const roles = new Set(role[0]!.at!.map((o) => o.requires));
  assert.deepEqual([...roles].sort(), ['ops.approver', 'ops.approver, ops.admin', REVIEW].sort(), 'every occurrence keeps its own roles');
});

test('the role × action table: one row per guarded action, the roles from the code, the proving test quoted', () => {
  const { index } = summaryOf();
  const t = roleTable(index);
  assert.deepEqual(t.rows.map((r) => [r.action.id, r.roles.join(' ')]).sort(), [
    [R_APPROVE, 'ops.approver'],
    [R_VERIFY, 'ops.reviewer ops.approver ops.admin'],
    [R_VENDOR, 'ops.approver ops.admin'],
  ].sort(), 'routes, never their handlers twice');
  assert.deepEqual(t.roles, ['ops.reviewer', 'ops.approver', 'ops.admin'], 'every role named, widest list first');
  const approve = t.rows.find((r) => r.action.id === R_APPROVE)!;
  assert.equal(approve.requiresFrom, 'ROLES.approve');
  assert.equal(approve.guard.id, ROLE);
  assert.deepEqual(approve.journeys.map((j) => j.id), [FLOW]);
  assert.equal(approve.tests[0]?.name, '403 when a reviewer approves');
  assert.equal(approve.verdict.status, 'passed');
  // the asymmetry the outsiders never reached: an admin may approve a vendor but not an invoice
  const vendor = t.rows.find((r) => r.action.id === R_VENDOR)!;
  assert.ok(vendor.roles.includes('ops.admin') && !approve.roles.includes('ops.admin'));
  assert.equal(vendor.tests[0]?.name, 'an admin approves a vendor', 'a test on the handler proves the route');
  // the numbers
  assert.equal(t.counted.actions.n, 3);
  assert.equal(t.counted.roles.n, 3);
  assert.equal(vendor.verdict.word.cls, 'reached', 'a static reach is not a verdict: no status');
  assert.equal(t.counted.passed.n, 2, 'each case by its own last run: both actions are reached by a case that passed');
  for (const c of Object.values(t.counted)) assert.deepEqual(countedProblems(c), []);
});

test('rolesFor: who may do one action, by id or by its words', () => {
  const { index } = summaryOf();
  assert.deepEqual(rolesFor(index, { action: R_APPROVE }).map((r) => r.roles), [['ops.approver']]);
  assert.deepEqual(rolesFor(index, { action: 'approve an invoice' }).map((r) => r.action.id), [R_APPROVE], 'the contract summary');
  assert.deepEqual(rolesFor(index, { action: 'approve' }).map((r) => r.action.id).sort(), [R_APPROVE, R_VENDOR].sort());
  assert.deepEqual(roleTable(index, { role: 'ops.admin' }).rows.map((r) => r.action.id).sort(), [R_VERIFY, R_VENDOR].sort());
  assert.equal(roleTable(index, { flow: FLOW }).rows.length, 3, 'a journey narrows to the actions its walk reaches');
  assert.equal(roleTable(index, { flow: 'ops::flow::nope' }).rows.length, 0);
  const csv = rolesCsv(roleTable(index));
  assert.match(csv.split('\n')[0]!, /^action,method,path,roles,/);
  assert.equal(csv.trim().split('\n').length, 4);
});
