// A record's status lifecycle, read from the code (parsers/src/lifecycle.ts, swarm-fixes round
// 2026-10-05 finding 7): the statuses come from a declaration — a SQL CHECK on the column, a
// `const … as const` array, a `z.enum`, a string-literal union — and each transition only with the
// function that writes it; `from` only when that function compares the status to exactly one prior
// status in a way that says what it *was*. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ingestRepo } from '../dist/index.js';
import type { GraphFragment, GraphNode } from '@farsight/core';

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-life-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
const ingest = (files: Record<string, string>): Promise<GraphFragment> =>
  ingestRepo(tempRepo({ 'package.json': '{"name":"l"}', ...files }), { repoName: 'l', openapi: false, design: false, tests: false, stories: false, projects: false });
const table = (g: GraphFragment, name: string): GraphNode => g.nodes.find((n) => n.id === `l::table::${name}`)!;
const moves = (n: GraphNode) => n.lifecycle!.transitions.map((x) => `${x.from ?? '·'}>${x.to}@${x.by.split('::').pop()}/${x.via}`);

// the reference app's shape: a migration's CHECK, a const list naming the same set, a repository
// that writes `status = $2`, services that pass the new status in an update call's patch
const SQL_REPO = {
  'src/migrations.ts': [
    'export const M1 = `',
    'CREATE TABLE IF NOT EXISTS orders (',
    '  id uuid PRIMARY KEY,',
    "  status text NOT NULL DEFAULT 'DRAFT'",
    "    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','PAID','CANCELLED')),",
    "  kind text CHECK (kind IN ('A','B'))",
    ');`;',
  ].join('\n'),
  'src/state.ts': "export const ORDER_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'PAID', 'CANCELLED'] as const;",
  // a fixture imitating the same set is never where the statuses live
  'src/mock/fixtures.ts': "export const FAKE_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'PAID', 'CANCELLED'] as const;",
  'src/repo.ts': [
    "import { Pool } from 'pg';",
    'const pool = new Pool();',
    'export class PgOrderRepository {',
    '  async transition(id: string, patch: { status: string }) {',
    '    return pool.query(`UPDATE orders SET status = $2 WHERE id = $1`, [id, patch.status]);',
    '  }',
    '  async cancelStale() {',
    "    return pool.query(`UPDATE orders SET status = 'CANCELLED' WHERE status = 'DRAFT'`);",
    '  }',
    '}',
  ].join('\n'),
  'src/service.ts': [
    "import { PgOrderRepository } from './repo';",
    'const repos = { orders: new PgOrderRepository() };',
    'export async function submitOrder(order: { id: string; status: string }) {',
    "  if (order.status !== 'DRAFT') throw new Error('only a draft');",
    "  return repos.orders.transition(order.id, { status: 'SUBMITTED' });",
    '}',
    'export async function approveOrder(order: { id: string; status: string }) {',
    // `=== X` followed by an exit says the status is *not* X: no from
    "  if (order.status === 'CANCELLED') throw new Error('cancelled');",
    "  return repos.orders.transition(order.id, { status: 'APPROVED' });",
    '}',
    'export async function payOrder(order: { id: string; status: string }) {',
    "  if (order.status === 'APPROVED') {",
    "    await repos.orders.transition(order.id, { status: 'PAID' });",
    '  }',
    '}',
    // a returned object is an answer, not a write
    "export function view(id: string) { return { id, status: 'DRAFT' }; }",
  ].join('\n'),
};

test('a SQL CHECK binds the record: statuses in declared order, the const list that agrees named beside it, a mock never', async () => {
  const g = await ingest(SQL_REPO);
  const life = table(g, 'orders').lifecycle!;
  assert.ok(life, 'orders has a lifecycle');
  assert.equal(life.field, 'status');
  assert.deepEqual(life.statuses, ['DRAFT', 'SUBMITTED', 'APPROVED', 'PAID', 'CANCELLED']);
  assert.deepEqual(life.provenance.map((p) => `${p.kind}:${p.name ?? ''}`), ['sql-check:', 'const-array:ORDER_STATUSES']);
});

test('each move has its writer; from only where the writer says what the status was', async () => {
  const g = await ingest(SQL_REPO);
  assert.deepEqual(moves(table(g, 'orders')), [
    'DRAFT>SUBMITTED@submitOrder/update-call',
    '·>APPROVED@approveOrder/update-call',
    'APPROVED>PAID@payOrder/update-call',
    'DRAFT>CANCELLED@PgOrderRepository.cancelStale/sql',
  ]);
  const by = table(g, 'orders').lifecycle!.transitions[0]!.by;
  assert.ok(g.nodes.some((n) => n.id === by), 'the writer is a node of the graph');
});

test('a string-literal union binds a record only when every status written to it fits; a z.enum and an `as const` list do too', async () => {
  const base = {
    'src/db.ts': [
      'export const db = { invoices: table(), notes: table() };',
      'function table() { return { insert: async (r: any) => r, update: async (_q: unknown, p: any) => p }; }',
    ].join('\n'),
    'src/service.ts': [
      "import { db } from './db';",
      "export async function create() { return db.invoices.insert({ status: 'draft' }); }",
      "export async function send(id: string) { return db.invoices.update({ id }, { status: 'open' }); }",
      // a filter (the first object) is a compare, the patch a write
      "export async function close() { return db.notes.update({ status: 'open' }, { status: 'closed' }); }",
    ].join('\n'),
  };
  // union on a row type
  let g = await ingest({ ...base, 'src/types.ts': "export type InvoiceStatus = 'draft' | 'open' | 'paid';\nexport interface InvoiceRow { status: InvoiceStatus }" });
  assert.deepEqual(table(g, 'invoices').lifecycle?.statuses, ['draft', 'open', 'paid']);
  assert.deepEqual(table(g, 'invoices').lifecycle?.provenance.map((p) => p.kind), ['union']);
  assert.deepEqual(moves(table(g, 'invoices')), ['·>draft@create/update-call', '·>open@send/update-call']);
  // notes writes `closed`, which no declared enum for `status` holds: no lifecycle, nothing guessed
  assert.equal(table(g, 'notes').lifecycle, undefined);
  // zod enum over a const array
  g = await ingest({ ...base, 'src/schemas.ts': "import { z } from 'zod';\nexport const S = ['draft', 'open', 'void'] as const;\nexport const invoiceSchema = z.object({ status: z.enum(S) });" });
  assert.deepEqual(table(g, 'invoices').lifecycle?.statuses, ['draft', 'open', 'void']);
  // an enum that does not hold every written status binds nothing
  g = await ingest({ ...base, 'src/types.ts': "export type InvoiceStatus = 'draft' | 'paid';\nexport interface InvoiceRow { status: InvoiceStatus }" });
  assert.equal(table(g, 'invoices').lifecycle, undefined);
});

test('an assignment counts when the writer reaches exactly one record with that status, and one writer makes one move once', async () => {
  const g = await ingest({
    'src/db.ts': 'export const db = { tickets: { update: async (_q: unknown, p: any) => p } };',
    'src/types.ts': "export type TicketStatus = 'new' | 'done';\nexport interface Ticket { status: TicketStatus }",
    'src/service.ts': [
      "import { db } from './db';",
      'export async function finish(t: { id: string; status: string }) {',
      "  if (t.status !== 'new') return;",
      "  t.status = 'done';",
      "  await db.tickets.update({ id: t.id }, { status: 'done' });",
      '}',
    ].join('\n'),
  });
  // the assignment comes first in the code; the update that saves it is the same move by the same writer
  assert.deepEqual(moves(table(g, 'tickets')), ['new>done@finish/assignment']);
});
