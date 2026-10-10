// Preconditions read from the code (parsers/src/preconditions.ts, gates lane 2026-10-10): a refusing
// comparison on the status, kind, flag or list of the record an action writes — or one it loaded
// beside it — becomes a `rule` tagged `precondition` that `validates` the action. Four shapes: a guard
// clause, a related record, a blocker list one throw refuses (one hop), a transition table read
// inverted. A comparison that only routes is not one. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ingestRepo } from '../dist/index.js';
import { gateTierOf, isConfigCheck, type GraphFragment, type GraphNode } from '@farsight/core';

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-pre-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
const ingest = (files: Record<string, string>): Promise<GraphFragment> =>
  ingestRepo(tempRepo({ 'package.json': '{"name":"p"}', ...files }), { repoName: 'p', openapi: false, design: false, tests: false, stories: false, projects: false });
const pres = (g: GraphFragment): GraphNode[] => g.nodes.filter((n) => n.precondition);
const pre = (g: GraphFragment, action: string, record: string): GraphNode | undefined =>
  pres(g).find((n) => n.precondition!.action.endsWith(`::${action}`) && n.precondition!.record === record);

const REPO = {
  'src/migrations.ts': [
    'export const M1 = `',
    'CREATE TABLE orders (',
    "  id uuid PRIMARY KEY, sync_status text, lines jsonb,",
    "  status text NOT NULL CHECK (status IN ('DRAFT','SUBMITTED','VERIFIED','APPROVED','PAID'))",
    ');',
    "CREATE TABLE vendors (id uuid PRIMARY KEY, status text CHECK (status IN ('ACTIVE','SUSPENDED')));",
    "CREATE TABLE contact_vendor_links (id uuid PRIMARY KEY, status text CHECK (status IN ('PENDING','APPROVED','REJECTED')));",
    '`;',
  ].join('\n'),
  'src/state.ts': [
    'export const ORDER_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {',
    "  DRAFT: ['SUBMITTED'], SUBMITTED: ['VERIFIED'], VERIFIED: ['APPROVED'], APPROVED: ['PAID'], PAID: [],",
    '};',
    "export const ROLES = { review: ['ops.reviewer', 'ops.approver'], approve: ['ops.approver'] } as const;",
    '/**',
    ' * Throw unless the move is in the table.',
    ' * @guard order state machine',
    ' */',
    'export function guardTransition(from: string, to: string): void {',
    "  if (!ORDER_TRANSITIONS[from].includes(to)) throw new Error('illegal');",
    '}',
  ].join('\n'),
  'src/errors.ts': [
    'export function conflict(detail: string) { return Object.assign(new Error(detail), { status: 409 }); }',
  ].join('\n'),
  'src/repo.ts': [
    "import { Pool } from 'pg';",
    'const pool = new Pool();',
    'export class PgOrderRepository {',
    '  async getById(id: string) { return pool.query(`SELECT * FROM orders WHERE id = $1`, [id]); }',
    '  async transition(id: string, patch: { status: string }) {',
    '    return pool.query(`UPDATE orders SET status = $2 WHERE id = $1`, [id, patch.status]);',
    '  }',
    '}',
    'export class PgVendorRepository {',
    '  async getVendor(id: string) { return pool.query(`SELECT * FROM vendors WHERE id = $1`, [id]); }',
    '  async findLink(id: string) { return pool.query(`SELECT * FROM contact_vendor_links WHERE id = $1`, [id]); }',
    '}',
  ].join('\n'),
  'src/service.ts': [
    "import { PgOrderRepository, PgVendorRepository } from './repo';",
    "import { conflict } from './errors';",
    "import { guardTransition } from './state';",
    'const repos = { orders: new PgOrderRepository(), vendors: new PgVendorRepository() };',
    // shape 1: a guard clause on the written record's own status
    'export async function submitOrder(id: string) {',
    '  const order = await repos.orders.getById(id);',
    "  if (order.status !== 'DRAFT') throw conflict('This order has already been submitted.');",
    "  return repos.orders.transition(id, { status: 'SUBMITTED' });",
    '}',
    'async function loadForReview(id: string) {',
    '  const order = await repos.orders.getById(id);',
    '  const vendor = await repos.vendors.getVendor(order.vendorId);',
    '  const link = await repos.vendors.findLink(order.linkId);',
    '  return { order, vendor, link };',
    '}',
    // shape 3's half: the blocker list a called function returns
    'async function reviewBlockers(ctx: { vendor: any; link: any }): Promise<string[]> {',
    '  const blockers: string[] = [];',
    "  if (ctx.link?.status === 'PENDING') {",
    "    blockers.push('Submitter identity not verified');",
    "  } else if (ctx.link?.status === 'REJECTED') {",
    "    blockers.push('Submitter identity rejected');",
    '  }',
    "  if (ctx.vendor && ctx.vendor.status !== 'ACTIVE') {",
    '    blockers.push(`Vendor account is ${ctx.vendor.status}, not ACTIVE`);',
    '  }',
    '  return blockers;',
    '}',
    'function transitionOrConflict(from: string, to: string) {',
    "  try { guardTransition(from, to); } catch { throw conflict('An order cannot move that way.'); }",
    '}',
    '/**',
    ' * Approves an order.',
    ' * @guard order approval',
    ' */',
    'export async function approveOrder(id: string) {',
    '  const ctx = await loadForReview(id);',
    // shape 4: the transition table
    "  transitionOrConflict(ctx.order.status, 'APPROVED');",
    // shape 3: the list one throw refuses, one hop away
    '  const blockers = await reviewBlockers(ctx);',
    "  if (blockers.length > 0) throw conflict('Approval is blocked.');",
    // shape 2: a related field of the written record compared in place (a sync status)
    "  if (ctx.order.sync_status !== 'SYNCED') throw conflict('The ledger draft is not synced yet.');",
    "  return repos.orders.transition(id, { status: 'APPROVED' });",
    '}',
    // a comparison that only routes: a decision, never a precondition
    'export async function payOrder(id: string) {',
    '  const order = await repos.orders.getById(id);',
    "  let lane = 'slow';",
    "  if (order.kind === 'EXPRESS') { lane = 'fast'; }",
    "  return repos.orders.transition(id, { status: 'PAID', lane });",
    '}',
    // a list that must not be empty
    'export async function sendOrder(id: string) {',
    '  const order = await repos.orders.getById(id);',
    "  if (order.lines.length < 1) throw conflict('An order needs a line.');",
    "  return repos.orders.transition(id, { status: 'VERIFIED' });",
    '}',
  ].join('\n'),
  'src/auth.ts': [
    '/**',
    ' * @guard session role',
    ' */',
    'export function requireRole(req: any, roles: readonly string[]) { if (!roles.includes(req.role)) throw new Error("no"); }',
    '/**',
    ' * @guard[policy] four eyes',
    ' */',
    'export function fourEyes(req: any) { if (req.a === req.b) throw new Error("same"); }',
  ].join('\n'),
  'src/routes.ts': [
    "import { Router } from 'express';",
    "import { requireRole, fourEyes } from './auth';",
    "import { ROLES } from './state';",
    "import { approveOrder } from './service';",
    'export const router = Router();',
    "router.post('/orders/:id/approve', async (req, res) => {",
    '  requireRole(req, ROLES.approve);',
    '  fourEyes(req);',
    '  res.json(await approveOrder(req.params.id));',
    '});',
  ].join('\n'),
  'src/ui/Drawer.tsx': [
    'export function Drawer({ order }: { order: any }) {',
    '  async function onSend() {',
    '    // @business Only a draft can be sent',
    "    if (order.status !== 'DRAFT') return;",
    "    await fetch('/orders/1/send', { method: 'POST' });",
    '  }',
    '  async function onPeek() {',
    // an unlabelled early return in a UI handler routes; it is not a precondition
    "    if (order.status !== 'DRAFT') return;",
    "    await fetch('/orders/1', { method: 'GET' });",
    '  }',
    '  return <button onClick={onSend}>Send</button>;',
    '}',
  ].join('\n'),
  'src/client.ts': [
    "import { z } from 'zod';",
    'export const problemSchema = z.object({ title: z.string() });',
    'export const orderSchema = z.object({ id: z.string() });',
    // reading a response the server already sent: not a gate on the caller
    'export async function toProblem(res: Response) { return problemSchema.safeParse(await res.json()); }',
    'export function check(input: unknown) { return orderSchema.parse(input); }',
  ].join('\n'),
};

test('shape 1: a guard clause on the written record is a precondition on the action, in the team’s message', async () => {
  const g = await ingest(REPO);
  const p = pre(g, 'submitOrder', 'orders');
  assert.ok(p, 'submitOrder has a precondition on orders');
  assert.equal(p!.kind, 'rule');
  assert.ok(p!.tags.includes('precondition'));
  assert.deepEqual(p!.precondition!.requires, ['DRAFT']);
  assert.equal(p!.precondition!.relation, 'own');
  assert.equal(p!.precondition!.class, 'record-state');
  assert.equal(p!.precondition!.tier, 'business');
  assert.equal(p!.precondition!.else, '409 conflict');
  assert.equal(p!.precondition!.wordsFrom, 'message');
  assert.equal(p!.precondition!.words, 'This order has already been submitted.');
  const e = g.edges.find((x) => x.from === p!.id);
  assert.equal(e?.kind, 'validates');
  assert.equal(e?.to, p!.precondition!.action);
  assert.equal(e?.resolution?.technique, 'precondition');
});

test('shapes 2 and 3: related records refused through a blocker list one hop away, merged per record and field', async () => {
  const g = await ingest(REPO);
  const vendor = pre(g, 'approveOrder', 'vendors');
  assert.ok(vendor, 'the vendor account check is a precondition of approve');
  assert.deepEqual(vendor!.precondition!.requires, ['ACTIVE']);
  assert.equal(vendor!.precondition!.via, 'blocker-list');
  assert.equal(vendor!.precondition!.relation, 'related');
  assert.equal(vendor!.precondition!.words, 'Vendor account is …, not ACTIVE');
  const link = pre(g, 'approveOrder', 'contact_vendor_links');
  assert.ok(link, 'a word resolves to the one table ending in it');
  assert.deepEqual(link!.precondition!.excludes, ['PENDING', 'REJECTED']);
  assert.equal(link!.precondition!.wordsFrom, 'humanize', 'two messages merged say it in words from the names');
  const sync = pres(g).find((n) => n.precondition!.action.endsWith('::approveOrder') && n.precondition!.field === 'sync_status');
  assert.deepEqual(sync?.precondition?.requires, ['SYNCED']);
});

test('shape 4: a transition table read inverted gives the move its prior status and a precondition', async () => {
  const g = await ingest(REPO);
  const own = pres(g).find((n) => n.precondition!.action.endsWith('::approveOrder') && n.precondition!.record === 'orders' && n.precondition!.field === 'status');
  assert.ok(own);
  assert.equal(own!.precondition!.via, 'transition-table');
  assert.deepEqual(own!.precondition!.requires, ['VERIFIED']);
  const life = g.nodes.find((n) => n.id === 'p::table::orders')!.lifecycle!;
  const move = life.transitions.find((t) => t.to === 'APPROVED')!;
  assert.equal(move.from, 'VERIFIED');
  assert.deepEqual(move.fromAny, ['VERIFIED']);
});

test('a comparison that only routes is a decision; an empty list refused is completeness', async () => {
  const g = await ingest(REPO);
  assert.equal(pres(g).filter((n) => n.precondition!.action.endsWith('::payOrder')).length, 0);
  const lines = pre(g, 'sendOrder', 'orders');
  assert.equal(lines?.precondition?.kind, 'present');
  assert.equal(lines?.precondition?.class, 'completeness');
});

test('a UI handler’s early return counts only under the team’s @business label', async () => {
  const g = await ingest(REPO);
  const send = pres(g).find((n) => n.precondition!.action.endsWith('::onSend'));
  assert.ok(send, 'onSend carries its labelled precondition');
  assert.equal(send!.precondition!.wordsFrom, 'business');
  assert.equal(send!.precondition!.words, 'Only a draft can be sent');
  assert.equal(send!.facets?.business?.description, 'Only a draft can be sent');
  assert.ok(!pres(g).some((n) => n.precondition!.action.endsWith('::onPeek')));
});

test('a @guard that moves a record is the action itself; a role constant is read onto its guards edge', async () => {
  const g = await ingest(REPO);
  const approve = g.nodes.find((n) => n.id.endsWith('::approveOrder'))!;
  assert.equal(approve.kind, 'guard');
  assert.ok(approve.tags.includes('action-gate'));
  assert.equal(gateTierOf(approve).class, 'action-gate');
  const role = g.edges.find((e) => e.kind === 'guards' && e.from.endsWith('::requireRole') && typeof e.meta?.requires === 'string');
  assert.equal(role?.meta?.requires, 'ops.approver');
  assert.equal(role?.meta?.requiresFrom, 'ROLES.approve');
});

test('@guard[policy] sets the tier; a schema read over a response is not a gate', async () => {
  const g = await ingest(REPO);
  const four = g.nodes.find((n) => n.id.endsWith('::fourEyes'))!;
  assert.deepEqual(four.gateTier, { tier: 'policy', from: 'annotation' });
  assert.equal(four.name, 'fourEyes: four eyes');
  assert.equal(gateTierOf(four).class, 'integrity');
  assert.ok(!g.edges.some((e) => e.kind === 'validates' && e.from.endsWith('::problemSchema')), 'reading an error body is no gate');
  assert.ok(g.edges.some((e) => e.kind === 'validates' && e.from.endsWith('::orderSchema')), 'checking input still is');
});

test('a long use-case that reads a setting is not a config check', () => {
  const body = ['export function submit(c: Container, input: any) {', '  const x = process.env.APP_MODE;', ...Array.from({ length: 50 }, (_, i) => `  step${i}();`), '}'].join('\n');
  const node = { id: 'x', kind: 'guard', name: 'submit: readiness', tags: [], snippet: body, loc: { repo: 'p', path: 'a.ts', line: 1, endLine: 53 } } as unknown as GraphNode;
  assert.equal(isConfigCheck(node), false);
  const short = { ...node, snippet: 'export function mode(env: Env) { if (process.env.MODE === "x") throw 1; }', loc: { repo: 'p', path: 'a.ts', line: 1, endLine: 1 } } as GraphNode;
  assert.equal(isConfigCheck(short), true);
  // a long function handed the settings themselves is still a settings check
  const long = { ...node, snippet: ['export function resolveMail(env: Record<string, string>) {', '  const x = process.env.MAIL;', ...Array.from({ length: 50 }, (_, i) => `  if (!env.A${i}) throw new Error("x");`), '}'].join('\n') } as GraphNode;
  assert.equal(isConfigCheck(long), true);
});
