// Subscription quota shares the ordinary durable ledger; no monetary amount/currency is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BudgetLedger } from '../dist/review/providers/budget.js';
import { inspectEnvelopes } from '../dist/review/providers/owner.js';
const at = '2026-10-23T12:00:00.000000000Z';
const D = 'sha256:' + '0123456789abcdef'.repeat(4);
const code = (c: string) => (e: any) => e?.code === c;
const quota = (id = 'quota-env') => ({ id, runId: 'quota-run', providerId: 'native-claude', bindingDigest: D, admissionDigest: D, receiptDigest: D, maxTokens: 100, maxCostNanos: null, currency: null, accountingBasis: 'subscription-quota' as const, createdAt: at });
async function ledger(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'sentinel-quota-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'budget.db'), ledger = await BudgetLedger.open(path); t.after(() => ledger.close());
  ledger.createEnvelope(quota()); return { ledger, path };
}
const reserve = (l: BudgetLedger, operationId: string, tokens: number, epoch = 'live') => l.reserve({ envelopeId: 'quota-env', operationId, tokens, costNanos: null, epoch, at });

test('explicit quota persists NULL money/currency, never USD0 or no-fee', async t => {
  const { ledger: l, path } = await ledger(t); const r = reserve(l, 'call', 80);
  assert.equal(r.costNanos, null); assert.equal(r.accountingBasis, 'subscription-quota');
  assert.equal(l.totals('quota-env').chargedCostNanos, null); assert.equal(l.totals('quota-env').maxCostNanos, null);
  const [view] = inspectEnvelopes(l); assert.equal(view!.accountingBasis, 'subscription-quota');
  assert.equal(view!.currency, null); assert.equal(view!.maxCost, null); assert.equal(view!.chargedCost, null); assert.equal(view!.open[0]!.cost, null);
  const db = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(Object.values(db.prepare('SELECT max_cost_nanos,currency FROM envelopes').get()!), [null, null]);
  assert.equal((db.prepare('SELECT cost_nanos FROM reservations').get() as any).cost_nanos, null); db.close();
});

test('unknown consumption remains fully charged and cannot be refunded or resent', async t => {
  const { ledger: l } = await ledger(t); const r = reserve(l, 'unknown-call', 80); l.dispatch(r.id, at); l.markUncertain(r.id, at, 'partial native output');
  assert.equal(l.totals('quota-env').chargedTokens, 80);
  assert.throws(() => reserve(l, 'next', 21), code('sentinel.provider.budgetExhausted'));
  assert.throws(() => l.releaseUnsent(r.id, at, 'no-connection'), code('sentinel.provider.reservationState'));
  l.createEnvelope(quota('other'));
  assert.throws(() => l.reserve({ envelopeId: 'other', operationId: 'unknown-call', tokens: 80, costNanos: null, epoch: 'fresh', at }), code('sentinel.provider.reservationState'));
});

test('confirmed token usage settles only quota, while monetary consumption stays unobserved', async t => {
  const { ledger: l } = await ledger(t); const r = reserve(l, 'known-call', 80); l.dispatch(r.id, at);
  const settled = l.settle(r.id, { inputTokens: 20, outputTokens: 10, costNanos: null }, at);
  assert.equal(settled.state, 'settled'); assert.equal(settled.usedCostNanos, null); assert.equal(l.totals('quota-env').chargedTokens, 30);
  assert.equal(reserve(l, 'next', 70).state, 'held');
});

test('quota overrun is recorded in full and stops every further call', async t => {
  const { ledger: l } = await ledger(t); const r = reserve(l, 'overrun', 80); l.dispatch(r.id, at);
  l.settle(r.id, { inputTokens: 90, outputTokens: 20, costNanos: null }, at);
  assert.equal(l.totals('quota-env').chargedTokens, 110); assert.equal(l.totals('quota-env').overdrawn, true);
  assert.throws(() => reserve(l, 'later', 1), code('sentinel.provider.envelopeOverdrawn'));
});

test('quota uses existing epoch recovery: only proven unsent held work releases, sent work stays uncertain', async t => {
  const { ledger: l } = await ledger(t); const held = reserve(l, 'unsent', 20, 'stale'), sent = reserve(l, 'sent', 30, 'stale'); l.dispatch(sent.id, at);
  assert.deepEqual(l.recover(['stale'], at), { released: 1, uncertain: 1 });
  assert.equal(l.reservation(held.id).state, 'released'); assert.equal(l.reservation(sent.id).state, 'uncertain'); assert.equal(l.totals('quota-env').chargedTokens, 30);
  assert.throws(() => reserve(l, 'late', 1, 'stale'), code('sentinel.provider.epochFenced'));
});

test('quota and monetary bases cannot be mixed, inferred from zero, or changed during settlement', async t => {
  const { ledger: l } = await ledger(t);
  for (const value of [{ ...quota('bad-money'), maxCostNanos: 0n, currency: 'USD' }, { ...quota('missing-basis'), accountingBasis: undefined }]) assert.throws(() => l.createEnvelope(value), code('sentinel.provider.ledgerInvalid'));
  assert.throws(() => l.reserve({ envelopeId: 'quota-env', operationId: 'money', tokens: 1, costNanos: 0n, epoch: 'live', at }), code('sentinel.provider.ledgerInvalid'));
  const r = reserve(l, 'quota', 20); l.dispatch(r.id, at);
  assert.throws(() => l.settle(r.id, { inputTokens: 1, outputTokens: 1, costNanos: 0n }, at), code('sentinel.provider.ledgerInvalid'));
  assert.equal(l.reservation(r.id).state, 'dispatched');
});

test('resumed same-provider run cannot multiply quota across admissions, while an independent run has its own cap', async t => {
  const { ledger: l } = await ledger(t); const old = reserve(l, 'prior-unknown', 70); l.dispatch(old.id,at); l.markUncertain(old.id,at,'unknown before restart');
  l.createEnvelope(quota('resumed'));
  const next = (tokens: number) => l.reserve({envelopeId:'resumed',operationId:'resumed-call',tokens,costNanos:null,epoch:'new',at});
  assert.throws(()=>next(31),code('sentinel.provider.budgetExhausted')); assert.equal(next(30).state,'held');
  l.createEnvelope({...quota('independent'),runId:'other-run'});
  assert.equal(l.reserve({envelopeId:'independent',operationId:'other-run-call',tokens:100,costNanos:null,epoch:'new',at}).state,'held');
});
test('resume can only tighten the original run cap and cannot switch accounting basis/currency or escape a prior overrun', async t => {
  const {ledger:l}=await ledger(t);
  assert.throws(()=>l.createEnvelope({...quota('raised'),maxTokens:101}),code('sentinel.provider.budgetExhausted'));
  assert.throws(()=>l.createEnvelope({...quota('money-resume'),accountingBasis:undefined,maxCostNanos:1n,currency:'USD'}),code('sentinel.provider.ledgerInvalid'));
  l.createEnvelope({...quota('tightened'),maxTokens:60});
  assert.throws(()=>l.createEnvelope({...quota('re-raised'),maxTokens:70}),code('sentinel.provider.budgetExhausted'));
  const r=reserve(l,'overrun-old',50);l.dispatch(r.id,at);l.settle(r.id,{inputTokens:55,outputTokens:1,costNanos:null},at);
  assert.throws(()=>l.reserve({envelopeId:'tightened',operationId:'after-overrun',tokens:1,costNanos:null,epoch:'new',at}),code('sentinel.provider.envelopeOverdrawn'));
});
