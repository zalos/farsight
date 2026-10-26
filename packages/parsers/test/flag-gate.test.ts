// A status move is credited to the live path that writes it (lane `moves`, 2026-10-13). The reference app's
// shape: the one function that writes PAID is called from two actions, and one of the two calls sits under
// `if (PAYMENT_INTENT_MARKS_PAID)` where that constant is the literal `false` — the code says that call does
// not run. The parser keeps the edge (the code holds both) and says so on it: `meta.inactive`, the flag, its
// value and where it is declared, technique `flag-gate`. Two more writer shapes the reference app uses: a
// status-named setter handed the status as a positional literal (`setContractorStatus(id, 'ACTIVE')`) and a
// ternary of two literals in an update's patch (`status: submitter ? 'ACTIVE' : 'PENDING'`), each arm a move
// with its condition. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ingestRepo } from '../dist/index.js';
import type { GraphEdge, GraphFragment, GraphNode } from '@farsight/core';

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-flag-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
const ingest = (files: Record<string, string>): Promise<GraphFragment> =>
  ingestRepo(tempRepo({ 'package.json': '{"name":"f"}', ...files }), {
    repoName: 'f',
    openapi: false,
    design: false,
    tests: false,
    stories: false,
    projects: false,
  });
const table = (g: GraphFragment, name: string): GraphNode => g.nodes.find((n) => n.id === `f::table::${name}`)!;
const call = (g: GraphFragment, from: string, to: string): GraphEdge[] =>
  g.edges.filter((e) => e.kind === 'calls' && e.from.endsWith(`::${from}`) && e.to.endsWith(`::${to}`));
const moves = (n: GraphNode) =>
  n.lifecycle!.transitions.map(
    (x) => `${x.from ?? '·'}>${x.to}@${x.by.split('::').pop()}/${x.via}${x.when ? `?${x.when}` : ''}`,
  );

const REPO = {
  'src/migrations.ts': [
    'export const M1 = `',
    'CREATE TABLE IF NOT EXISTS payouts (',
    '  id uuid PRIMARY KEY,',
    "  status text NOT NULL DEFAULT 'DRAFT'",
    "    CHECK (status IN ('DRAFT','PENDING','ACTIVE','SCHEDULED','PAID','BLOCKED'))",
    ');`;',
  ].join('\n'),
  'src/repo.ts': [
    "import { Pool } from 'pg';",
    'const pool = new Pool();',
    'export class PgPayoutRepository {',
    '  async transition(id: string, patch: { status: string }) {',
    '    return pool.query(`UPDATE payouts SET status = $2 WHERE id = $1`, [id, patch.status]);',
    '  }',
    '  async setPayoutStatus(id: string, status: string) {',
    '    return pool.query(`UPDATE payouts SET status = $2 WHERE id = $1`, [id, status]);',
    '  }',
    '  async create(row: { status: string }) {',
    '    return pool.query(`INSERT INTO payouts (status) VALUES ($1)`, [row.status]);',
    '  }',
    '}',
  ].join('\n'),
  // the decision switches, one module over: imported one hop
  'src/decisions.ts': [
    '// DECISION(D6): recording the intent is not Paid',
    'export const INTENT_MARKS_PAID = false;',
    'export const NOTIFY_BY_DEFAULT = true as const;',
  ].join('\n'),
  'src/service.ts': [
    "import { PgPayoutRepository } from './repo';",
    "import { INTENT_MARKS_PAID, NOTIFY_BY_DEFAULT } from './decisions';",
    'const repos = { payouts: new PgPayoutRepository() };',
    'const LOCAL_OFF = false;',
    'async function settle(id: string) {',
    "  await repos.payouts.transition(id, { status: 'PAID' });",
    '}',
    'function notify(id: string) { return id; }',
    'function audit(id: string) { return id; }',
    'function legacy(id: string) { return id; }',
    'export async function recordIntent(p: { id: string; status: string }) {',
    "  if (p.status !== 'ACTIVE') throw new Error('not active');",
    "  await repos.payouts.transition(p.id, { status: 'SCHEDULED' });",
    '  if (INTENT_MARKS_PAID) {',
    '    await settle(p.id);',
    '  }',
    '  NOTIFY_BY_DEFAULT && notify(p.id);',
    '  if (!LOCAL_OFF) audit(p.id);',
    '  LOCAL_OFF ? legacy(p.id) : audit(p.id);',
    '}',
    'export async function markPaid(p: { id: string }) {',
    '  await settle(p.id);',
    '}',
    // a status-named setter handed the status as a positional literal
    'export async function approve(p: { id: string; status: string }) {',
    "  if (p.status !== 'PENDING') throw new Error('not pending');",
    "  await repos.payouts.setPayoutStatus(p.id, 'ACTIVE');",
    '}',
    // a ternary of two literals in a create's row: both arms are moves, each with its condition
    'export async function attach(submitter: boolean) {',
    "  await repos.payouts.create({ status: submitter ? 'ACTIVE' : 'PENDING' });",
    '}',
  ].join('\n'),
};

test('a call under a constant-false flag is kept and marked inactive, with the flag, its value and where it is declared', async () => {
  const g = await ingest(REPO);
  const off = call(g, 'recordIntent', 'settle');
  assert.equal(off.length, 1, 'the edge is kept: the code holds the call');
  assert.equal(off[0]!.meta?.inactive, true);
  assert.equal(off[0]!.meta?.whenFlag, 'INTENT_MARKS_PAID');
  assert.equal(off[0]!.meta?.whenValue, false);
  assert.equal(off[0]!.meta?.whenAt, 'src/decisions.ts:2');
  assert.equal(off[0]!.resolution?.technique, 'flag-gate');
  assert.match(String(off[0]!.resolution?.note), /INTENT_MARKS_PAID = false/);
  const live = call(g, 'markPaid', 'settle');
  assert.equal(live.length, 1);
  assert.equal(live[0]!.meta?.inactive, undefined, 'the unconditional call is live');
  assert.equal(live[0]!.meta?.whenFlag, undefined);
});

test('a flag that lets the call run is recorded and stays live: `X && f()` with X true, `if (!X)` with X false, the false arm of `X ? a : b`', async () => {
  const g = await ingest(REPO);
  const n = call(g, 'recordIntent', 'notify')[0]!;
  assert.equal(n.meta?.whenFlag, 'NOTIFY_BY_DEFAULT');
  assert.equal(n.meta?.whenValue, true);
  assert.equal(n.meta?.inactive, undefined);
  const a = call(g, 'recordIntent', 'audit');
  assert.equal(a.length, 1, 'two live calls under one flag are one edge');
  assert.equal(a[0]!.meta?.whenFlag, 'LOCAL_OFF');
  assert.equal(a[0]!.meta?.inactive, undefined);
  const l = call(g, 'recordIntent', 'legacy')[0]!;
  assert.equal(l.meta?.inactive, true, 'the true arm of a ternary on a false constant does not run');
  assert.equal(l.meta?.whenAt, 'src/service.ts:4');
});

test('a status-named setter with a positional literal and a ternary of literals are both writers', async () => {
  const g = await ingest(REPO);
  const m = moves(table(g, 'payouts'));
  assert.ok(m.includes('PENDING>ACTIVE@approve/update-call'), m.join(' · '));
  assert.ok(m.includes('·>ACTIVE@attach/update-call?submitter'), m.join(' · '));
  assert.ok(m.includes('·>PENDING@attach/update-call?not submitter'), m.join(' · '));
  // the flag-gated writer is still a writer of PAID: the record's lifecycle is what the code can do
  assert.ok(m.includes('·>PAID@settle/update-call'), m.join(' · '));
});
