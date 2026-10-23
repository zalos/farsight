// legacy-6c.db is a synthetic fixture emitted by the genuine old 6c19aa45 BudgetLedger. It contains no credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { BudgetLedger } from '../dist/review/providers/budget.js';

const at = '2026-10-22T12:00:00.000000000Z';
const D = (x: string) => 'sha256:' + createHash('sha256').update(x).digest('hex');
const code = (c: string) => (e: any) => e?.code === c;
const fixture = new URL('./fixtures/model-budget/legacy-6c.db', import.meta.url);
async function file(t: any) { const root = await mkdtemp(join(tmpdir(), 'sentinel-budget-migrate-')); t.after(() => rm(root, { recursive: true, force: true })); const path = join(root, 'ledger.db'); await copyFile(fixture, path); return path; }
function rows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return ['reservations', 'reservation_events'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()); }
  finally { db.close(); }
}
const fresh = (id = 'new-env') => ({ id, runId: 'new-run', providerId: 'exact-provider', bindingDigest: D('binding'), admissionDigest: D(id), receiptDigest: null, maxTokens: 2000, maxCostNanos: 20_000_000_000n, currency: 'USD', createdAt: at });

test('genuine legacy migration preserves exact pending spend, states, timestamps, epochs and event chronology', async t => {
  const path = await file(t), before = rows(path);
  const ledger = await BudgetLedger.open(path); t.after(() => ledger.close());
  const [env] = ledger.listEnvelopes({ limit: 10 });
  assert.equal(env!.providerId, null); assert.equal(env!.createdAt, at);
  assert.deepEqual(env!.totals.byState, { held: 1, dispatched: 1, settled: 0, uncertain: 1, released: 0 });
  assert.equal(env!.totals.chargedTokens, 600); assert.equal(env!.totals.chargedCostNanos, 6_000_000_000n);
  assert.deepEqual(rows(path), before);
});

test('legacy provenance cannot be rebound and a pending legacy operation cannot be redispatched under a new envelope', async t => {
  const path = await file(t), ledger = await BudgetLedger.open(path); t.after(() => ledger.close());
  assert.throws(() => ledger.createEnvelope({ ...fresh('legacy-env'), runId: 'legacy-run', bindingDigest: D('legacy-binding'), admissionDigest: D('legacy-admission') }), code('sentinel.provider.ledgerInvalid'));
  ledger.createEnvelope(fresh());
  assert.throws(() => ledger.reserve({ envelopeId: 'new-env', operationId: 'uncertain-op', tokens: 300, costNanos: 3_000_000_000n, epoch: 'new-epoch', at }), code('sentinel.provider.reservationState'));
  assert.equal(ledger.totals('new-env').chargedTokens, 0);
  const own = ledger.reserve({ envelopeId: 'new-env', operationId: 'new-op', tokens: 10, costNanos: 100n, epoch: 'new-epoch', at });
  assert.equal(own.state, 'held'); assert.equal(ledger.listEnvelopes({ limit: 10 }).find(x => x.id === 'new-env')!.providerId, 'exact-provider');
});

test('reopening the migrated ledger is idempotent without automatic recovery, refunds or clock rebasing', async t => {
  const path = await file(t); let ledger = await BudgetLedger.open(path); const first = ledger.listEnvelopes({ limit: 10 }); ledger.close();
  const before = rows(path); ledger = await BudgetLedger.open(path); t.after(() => ledger.close());
  assert.deepEqual(ledger.listEnvelopes({ limit: 10 }), first); assert.deepEqual(rows(path), before);
});

test('unknown schema and trigger additions refuse transactionally without changing the original database', async t => {
  for (const ddl of ['CREATE TABLE unrelated (value TEXT)', 'CREATE TRIGGER surprise AFTER INSERT ON reservations BEGIN SELECT 1; END']) {
    const path = await file(t), db = new DatabaseSync(path); db.exec(ddl); db.close();
    const before = await readFile(path);
    await assert.rejects(BudgetLedger.open(path), code('sentinel.provider.ledgerInvalid'));
    assert.deepEqual(await readFile(path), before);
  }
});

test('fresh current monetary ledger retains its existing reserve/dispatch/settle semantics', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sentinel-budget-fresh-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'fresh.db'); let ledger = await BudgetLedger.open(path);
  ledger.createEnvelope(fresh()); const r = ledger.reserve({ envelopeId: 'new-env', operationId: 'new-op', tokens: 100, costNanos: 1000n, epoch: 'new-epoch', at });
  ledger.dispatch(r.id, at); ledger.settle(r.id, { inputTokens: 20, outputTokens: 10, costNanos: 300n }, at); ledger.close();
  ledger = await BudgetLedger.open(path); t.after(() => ledger.close());
  assert.equal(ledger.totals('new-env').chargedTokens, 30); assert.equal(ledger.totals('new-env').chargedCostNanos, 300n);
});
