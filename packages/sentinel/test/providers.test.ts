// PR 21: opt-in model providers against original local mock endpoints only. No hosted call, model download or real
// keychain read: hosted rules are checked where no network is involved, and credentials come from an in-memory source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { join } from 'node:path';
import { ReceiptBook } from '../dist/policy/index.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import {
  BudgetLedger, ModelBroker, ModelCallError, ProviderError, Secret, bindProvider, envelopeIntent, probeCapability, probeConfigured, resolveCredential,
  PROVIDER_ERROR_CODES, RESERVATION_STATE_KEYS, toNanos, fromNanos, costOf,
} from '../dist/review/providers/index.js';
import { needsStore } from './snapshot-helpers.ts';
import { D, NOW, TERMS, json, mockEndpoint, ollamaProfile, ollamaReply, openaiProfile, openaiReply, scratchDir, trustedPolicy, capability, withModel } from './provider-helpers.ts';

const SECRET = 'synthetic-test-value-7f3a';
const code = (c: string) => (e: unknown) => e instanceof ProviderError && e.code === c;
const HUMAN = { principal: 'human' as const, channel: 'owner-cli' as const };
const BUDGET = { maxTokens: 20000, maxCost: '0', currency: 'USD' };

async function setup(t: any, opts: { epoch?: string; credentials?: (ref: string) => Promise<string> } = {}) {
  const dir = scratchDir(t);
  const ledger = await BudgetLedger.open(join(dir, 'budget.db'));
  t.after(() => ledger.close());
  const reads: string[] = [];
  const credentials = opts.credentials ?? (async (ref: string) => { reads.push(ref); return SECRET; });
  const broker = new ModelBroker({ ledger, credentials, epoch: opts.epoch ?? 'epoch-a', now: () => NOW });
  return { dir, ledger, broker, reads };
}

async function ollamaEnvelope(t: any, handle: Parameters<typeof mockEndpoint>[1], budget = BUDGET) {
  const ep = await mockEndpoint(t, handle);
  const policy = trustedPolicy({ ollama: ep.origin });
  const binding = bindProvider(policy, 'local-review', 'review');
  const s = await setup(t);
  const env = await s.broker.openEnvelope({ binding, policy, runId: 'run-1', budget, requestedBy: HUMAN, stateDigest: D('plan') });
  return { ...s, ep, policy, binding, env };
}

const ask = (operationId = 'op-1', over: Record<string, unknown> = {}) => ({ operationId, messages: [{ role: 'user' as const, content: 'Review this synthetic span.' }], maxOutputTokens: 64, ...over });

test('a binding comes only from the adopted settings, and is refused for an untrusted provider or model, a non-loopback local origin, plain-HTTP hosting, missing terms, no price and another capability', async () => {
  const o = 'http://127.0.0.1:11434';
  const refused = async (profile: Record<string, unknown>, c: string, opts: Record<string, unknown> = { ollama: o }) =>
    assert.throws((await withModel(opts as any, profile)).bind, code(c));
  const policy = trustedPolicy({ ollama: o });
  assert.throws(() => bindProvider(policy, 'unknown', 'review'), code('sentinel.provider.notTrusted'));
  assert.throws(() => bindProvider(policy, 'local-review', 'unknown'), code('sentinel.provider.notTrusted'), 'a caller cannot name a model the owner did not configure');
  assert.throws(() => bindProvider(policy as any, 'local-review', { model: 'x' } as any), code('sentinel.provider.notTrusted'), 'nor hand one in');
  await refused(ollamaProfile('http://localhost:11434', { providerId: 'named-local', capability: capability('ollama', 'http://localhost:11434', 'review-model:1') }), 'sentinel.provider.originRefused');
  const hosted = (over: Record<string, unknown>) => openaiProfile('https://models.example.com', { providerId: 'hosted-review', capability: capability('openai-compatible', 'https://models.example.com', 'review-model'), ...over });
  await refused(hosted({ providerId: 'plain-hosted', terms: TERMS, capability: capability('openai-compatible', 'http://models.example.com', 'review-model') }), 'sentinel.provider.originRefused');
  await refused(hosted({ terms: null }), 'sentinel.provider.termsRequired');
  assert.ok((await withModel({}, hosted({ terms: TERMS }))).bind());
  await refused(ollamaProfile(o, { pricing: null }), 'sentinel.provider.unpriced');
  await refused(hosted({ terms: TERMS, pricing: { kind: 'no-fee', basis: 'local-runtime' } }), 'sentinel.provider.unpriced');
  await refused(ollamaProfile(o, { capability: null }), 'sentinel.provider.capabilityUntested');
  await refused(ollamaProfile(o, { capability: capability('ollama', 'http://127.0.0.1:1', 'review-model:1') }), 'sentinel.provider.capabilityUntested');
  await refused(ollamaProfile(o, { limits: { ...ollamaProfile(o).limits, timeoutMs: 10_000_000 } }), 'sentinel.provider.invalidProfile');
  // Every term is in the digest an owner confirms.
  const a = bindProvider(policy, 'local-review', 'review');
  const b = (await withModel({ ollama: o }, ollamaProfile(o, { limits: { ...ollamaProfile(o).limits, maxOutputTokens: 128 } }))).bind();
  assert.notEqual(a.digest, b.digest);
  assert.equal(a.modelId, 'review');
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.limits));
});

test('capability is probed per endpoint: the listing, not a vendor assumption', async t => {
  const ep = await mockEndpoint(t, (req, res) => req.path === '/api/tags'
    ? json(res, 200, { models: [{ name: 'review-model:1', model: 'review-model:1', digest: 'b'.repeat(64) }] })
    : json(res, 200, { object: 'list', data: [{ id: 'review-model' }] }));
  const base = { origin: ep.origin, timeoutMs: 1000, maxResponseBytes: 4096, now: NOW };
  const rec = await probeCapability({ ...base, kind: 'ollama', model: 'review-model:1' });
  assert.deepEqual([rec.listed, rec.revision, rec.origin], [true, `sha256:${'b'.repeat(64)}`, ep.origin]);
  assert.equal((await probeCapability({ ...base, kind: 'openai-compatible', model: 'review-model' })).revision, null);
  await assert.rejects(probeCapability({ ...base, kind: 'ollama', model: 'other' }), code('sentinel.provider.capabilityMissing'));
  assert.deepEqual(ep.seen.map(s => `${s.method} ${s.path}`), ['GET /api/tags', 'GET /v1/models', 'GET /api/tags']);
});

test('Ollama: reserved before sending, dispatched, settled at reported usage, identity at its actual strength', needsStore, async t => {
  const { ep, broker, ledger, env, binding } = await ollamaEnvelope(t, (req, res) => json(res, 200, ollamaReply()));
  const reply = await broker.generate(env, binding, ask());
  assert.equal(reply.content, 'NO_FINDING');
  assert.equal(reply.truncated, false);
  assert.deepEqual(reply.identity, { requestedModel: 'review-model:1', returnedModel: 'review-model:1', probedRevision: `sha256:${'a'.repeat(64)}`, source: 'host-reported' });
  assert.deepEqual({ ...reply.usage }, { certainty: 'confirmed', inputTokens: 40, outputTokens: 3, monetaryCost: '0', currency: 'USD', basis: 'no-fee' });
  const sent = JSON.parse(ep.seen[0]!.body);
  assert.deepEqual([sent.stream, sent.options.num_predict, sent.options.num_ctx], [false, 64, 8192], 'the context is set, so input is never cut silently');
  assert.equal(ep.seen[0]!.headers.authorization, undefined, 'a local-only provider gets no credential');
  assert.deepEqual(ledger.events(reply.reservation.id).map(e => e.to), ['held', 'dispatched', 'settled']);
  const totals = ledger.totals(env.id);
  assert.equal(totals.chargedTokens, 43, 'charged at use, not at the worst case');
  assert.equal(totals.byState.settled, 1);
});

test('an output stopped at its allowance is reported truncated, and charged', needsStore, async t => {
  const { broker, env, binding } = await ollamaEnvelope(t, (req, res) => json(res, 200, ollamaReply({ done_reason: 'length', eval_count: 64 })));
  const reply = await broker.generate(env, binding, ask());
  assert.deepEqual([reply.truncated, reply.finish, reply.usage.outputTokens], [true, 'length', 64]);
});

test('a redirect is refused and never followed; the call stays uncertain and charged', needsStore, async t => {
  const elsewhere = await mockEndpoint(t, (req, res) => json(res, 200, ollamaReply()));
  const { ep, broker, ledger, env, binding } = await ollamaEnvelope(t, (req, res) => { res.writeHead(307, { location: `${elsewhere.origin}/api/chat` }); res.end(); });
  await assert.rejects(broker.generate(env, binding, ask()), (e: any) => e instanceof ModelCallError && e.code === 'sentinel.provider.redirectRefused' && e.reservation.state === 'uncertain');
  assert.equal(ep.seen.length, 1);
  assert.equal(elsewhere.seen.length, 0, 'nothing reaches the redirect target');
  assert.equal(ledger.totals(env.id).byState.uncertain, 1);
});

test('an oversized answer is discarded at the byte cap, streamed or declared; the reservation stays held', needsStore, async t => {
  const big = 'x'.repeat(20 * 1024);
  const streamed = await ollamaEnvelope(t, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"pad":"'); res.write(big); res.end('"}'); });
  await assert.rejects(streamed.broker.generate(streamed.env, streamed.binding, ask()), (e: any) => e.code === 'sentinel.provider.responseTooLarge' && e.spend === 'possible' && e.reservation.state === 'uncertain');
  const declared = await ollamaEnvelope(t, (req, res) => json(res, 200, ollamaReply({ message: { role: 'assistant', content: big } })));
  await assert.rejects(declared.broker.generate(declared.env, declared.binding, ask()), code('sentinel.provider.responseTooLarge'));
});

test('a deadline and a cancellation after sending leave the call uncertain; before sending, or unreachable, it is released', needsStore, async t => {
  const hang = await ollamaEnvelope(t, () => { /* never answers */ });
  const slowPolicy = await withModel({ ollama: hang.ep.origin }, ollamaProfile(hang.ep.origin, { limits: { ...ollamaProfile(hang.ep.origin).limits, timeoutMs: 150 } }));
  const slow = slowPolicy.bind();
  const env2 = await hang.broker.openEnvelope({ binding: slow, policy: slowPolicy.policy, runId: 'run-2', budget: BUDGET, requestedBy: HUMAN, stateDigest: D('plan') });
  await assert.rejects(hang.broker.generate(env2, slow, ask('op-t')), (e: any) => e.code === 'sentinel.provider.timeout' && e.reservation.state === 'uncertain');

  const ac = new AbortController();
  const p = hang.broker.generate(hang.env, hang.binding, ask('op-c', { signal: ac.signal }));
  await new Promise(r => setTimeout(r, 80));
  ac.abort();
  await assert.rejects(p, (e: any) => e.code === 'sentinel.provider.canceled' && e.spend === 'possible' && e.reservation.state === 'uncertain');

  const early = new AbortController();
  early.abort();
  await assert.rejects(hang.broker.generate(hang.env, hang.binding, ask('op-e', { signal: early.signal })), (e: any) => e.code === 'sentinel.provider.canceled' && e.reservation.state === 'released');

  const closed = await mockEndpoint(t, () => {});
  const origin = closed.origin;
  await new Promise<void>(r => { closed.server.closeAllConnections(); closed.server.close(() => r()); });
  const policy = trustedPolicy({ ollama: origin });
  const binding = bindProvider(policy, 'local-review', 'review');
  const s = await setup(t);
  const env = await s.broker.openEnvelope({ binding, policy, runId: 'run-1', budget: BUDGET, requestedBy: HUMAN, stateDigest: D('plan') });
  await assert.rejects(s.broker.generate(env, binding, ask()), (e: any) => e.code === 'sentinel.provider.unreachable' && e.spend === 'none' && e.reservation.state === 'released');
  assert.equal(s.ledger.totals(env.id).chargedTokens, 0);
});

test('a reply that names no model, or another one, is not used; its reported usage is still charged', needsStore, async t => {
  const none = await ollamaEnvelope(t, (req, res) => json(res, 200, ollamaReply({ model: undefined })));
  await assert.rejects(none.broker.generate(none.env, none.binding, ask()), (e: any) => e.code === 'sentinel.provider.identityMalformed' && e.reservation.state === 'settled');
  const other = await ollamaEnvelope(t, (req, res) => json(res, 200, ollamaReply({ model: 'other-model:7' })));
  await assert.rejects(other.broker.generate(other.env, other.binding, ask()), (e: any) => e.code === 'sentinel.provider.identityMismatch' && e.reservation.usedOutputTokens === 3);
  const noUsage = await ollamaEnvelope(t, (req, res) => json(res, 200, ollamaReply({ prompt_eval_count: undefined })));
  await assert.rejects(noUsage.broker.generate(noUsage.env, noUsage.binding, ask()), (e: any) => e.reservation.state === 'uncertain');
  assert.equal(noUsage.ledger.totals(noUsage.env.id).byState.uncertain, 1);
  const shape = await ollamaEnvelope(t, (req, res) => json(res, 200, { done: false }));
  await assert.rejects(shape.broker.generate(shape.env, shape.binding, ask()), (e: any) => e.code === 'sentinel.provider.malformedResponse' && e.reservation.state === 'uncertain');
});

test('the worst case is reserved before anything is sent; a call that does not fit sends nothing', needsStore, async t => {
  const { ep, broker, ledger, env, binding } = await ollamaEnvelope(t, (req, res) => json(res, 200, ollamaReply()), { maxTokens: 400, maxCost: '0', currency: 'USD' });
  const body = Buffer.from(JSON.stringify({ model: 'review-model:1', messages: ask().messages, stream: false, options: { num_predict: 64, num_ctx: 8192 } }));
  const worst = broker.worstCase(binding, body, 1, 64);
  assert.equal(worst.tokens, body.byteLength + 8 + 64);
  await broker.generate(env, binding, ask('op-1'));
  await broker.generate(env, binding, ask('op-2'));
  // 2 × 43 charged; a third worst case (~240) no longer fits in 400.
  await assert.rejects(broker.generate(env, binding, ask('op-3', { messages: [{ role: 'user', content: 'x'.repeat(200) }] })), code('sentinel.provider.budgetExhausted'));
  assert.equal(ep.seen.length, 2, 'the refused call never reached the provider');
  await assert.rejects(broker.generate(env, binding, ask('op-4', { maxOutputTokens: 9000 })), code('sentinel.provider.invalidProfile'));
  assert.equal(ledger.totals(env.id).byState.held, 0);
});

test('an operation is sent once: a repeat is refused, other amounts conflict', needsStore, async t => {
  const { ep, broker, ledger, env, binding } = await ollamaEnvelope(t, (req, res) => json(res, 200, ollamaReply()));
  await broker.generate(env, binding, ask('op-1'));
  await assert.rejects(broker.generate(env, binding, ask('op-1')), code('sentinel.provider.reservationState'));
  await assert.rejects(broker.generate(env, binding, ask('op-1', { maxOutputTokens: 32 })), code('sentinel.provider.operationConflict'));
  assert.equal(ep.seen.length, 1);
  assert.equal(ledger.totals(env.id).byState.settled, 1);
});

test('usage above the reservation is charged in full and overdraws the envelope; nothing more is admitted', needsStore, async t => {
  const { ep, broker, ledger, env, binding } = await ollamaEnvelope(t, (req, res) => json(res, 200, ollamaReply({ prompt_eval_count: 900, eval_count: 50 })),
    { maxTokens: 600, maxCost: '0', currency: 'USD' });
  const reply = await broker.generate(env, binding, ask('op-1'));
  assert.equal(reply.usage.inputTokens, 900, 'reported as reported, never clamped');
  const totals = ledger.totals(env.id);
  assert.deepEqual([totals.chargedTokens, totals.overdrawn], [950, true]);
  assert.ok(ledger.events(reply.reservation.id).some(e => e.detail.startsWith('overrun')));
  await assert.rejects(broker.generate(env, binding, ask('op-2')), code('sentinel.provider.envelopeOverdrawn'));
  assert.equal(ep.seen.length, 1);
});

test('a priced provider: the owner receipt binds the binding, the credential is sent only to it and never printed', needsStore, async t => {
  const ep = await mockEndpoint(t, (req, res) => json(res, 200, openaiReply()));
  const policy = trustedPolicy({ openai: ep.origin });
  const binding = bindProvider(policy, 'local-openai', 'review');
  const s = await setup(t);
  const budget = { maxTokens: 20000, maxCost: '0.50', currency: 'USD' };
  const base = { binding, policy, runId: 'run-1', budget, requestedBy: HUMAN, stateDigest: D('plan') };
  await assert.rejects(s.broker.openEnvelope(base), code('sentinel.provider.receiptRequired'), 'priced inference needs the owner whatever the grant says');
  assert.deepEqual(s.reads, [], 'refused before the keychain is read');
  const book = new ReceiptBook(join(s.dir, 'receipts'));
  const binding0 = { intent: envelopeIntent(binding, 'run-1', budget), stateDigest: D('plan'), policyRevision: policy.revision };
  const r = issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, binding0, { now: NOW, ttlMs: 600_000 });
  const env = await s.broker.openEnvelope({ ...base, receipt: { book, id: r.id } });
  assert.match(env.receiptDigest!, /^sha256:/);
  assert.deepEqual(s.reads, ['keychain:farsight/sentinel-review']);
  const reply = await s.broker.generate(env, binding, ask());
  assert.equal(ep.seen[0]!.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(ep.seen[0]!.path, '/v1/chat/completions');
  assert.deepEqual(JSON.parse(ep.seen[0]!.body).max_tokens, 64);
  // 50 × 2.50 + 4 × 10 per million, rounded up to a nano-unit.
  assert.equal(reply.usage.monetaryCost, fromNanos(costOf(50, toNanos('2.50')!) + costOf(4, toNanos('10')!)));
  assert.equal(reply.usage.monetaryCost, '0.000165');
  assert.equal(reply.identity.source, 'provider-response');
  const text = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
  assert.ok(!text(env).includes(SECRET) && !inspect(env, { depth: 9 }).includes(SECRET) && !text(reply).includes(SECRET));
  // A changed binding (another model) needs a new approval; the old envelope will not carry it.
  const changed = (await withModel({ openai: ep.origin }, openaiProfile(ep.origin, { limits: { ...openaiProfile(ep.origin).limits, maxOutputTokens: 100 } }))).bind();
  await assert.rejects(s.broker.generate(env, changed, ask('op-2')), code('sentinel.provider.bindingChanged'));
  // A changed policy (here: the grants) stops the envelope, even for the same provider and profile.
  const revoked = trustedPolicy({ openai: ep.origin, grants: [] });
  await assert.rejects(s.broker.generate(env, bindProvider(revoked, 'local-openai', 'review'), ask('op-3')), code('sentinel.provider.bindingChanged'));
  assert.equal(ep.seen.length, 1);
  // The receipt is spent once.
  await assert.rejects(s.broker.openEnvelope({ ...base, receipt: { book, id: r.id } }), (e: any) => /already used/.test(e.message));
});

test('policy denies before any credential is read or provider contacted; an unreadable credential denies too', needsStore, async t => {
  const ep = await mockEndpoint(t, (req, res) => json(res, 200, openaiReply()));
  const denied = trustedPolicy({ openai: ep.origin, grants: [] });
  const s = await setup(t);
  const binding = bindProvider(denied, 'local-openai', 'review');
  await assert.rejects(s.broker.openEnvelope({ binding, policy: denied, runId: 'run-1', budget: { maxTokens: 100, maxCost: '0.10', currency: 'USD' }, requestedBy: HUMAN, stateDigest: D('plan') }),
    code('sentinel.provider.notAdmitted'));
  assert.deepEqual(s.reads, [], 'no keychain read');
  const allowed = trustedPolicy({ openai: ep.origin });
  const failing = await setup(t, { credentials: async () => { throw new Error(`keychain said ${SECRET}`); } });
  const b2 = bindProvider(allowed, 'local-openai', 'review');
  const small = { maxTokens: 100, maxCost: '0.10', currency: 'USD' };
  const book = new ReceiptBook(join(failing.dir, 'receipts'));
  const r = issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, { intent: envelopeIntent(b2, 'run-1', small), stateDigest: D('plan'), policyRevision: allowed.revision }, { now: NOW, ttlMs: 600_000 });
  await assert.rejects(failing.broker.openEnvelope({ binding: b2, policy: allowed, runId: 'run-1', budget: small, requestedBy: HUMAN, stateDigest: D('plan'), receipt: { book, id: r.id } }),
    (e: any) => e.code === 'sentinel.provider.notAdmitted' && !e.message.includes(SECRET));
  assert.equal(ep.seen.length, 0);
  // A budget above the provider's adopted per-action budget is refused by the shared policy verdict.
  await assert.rejects(s.broker.openEnvelope({ binding: b2, policy: allowed, runId: 'run-1', budget: { maxTokens: 100, maxCost: '9.00', currency: 'USD' }, requestedBy: HUMAN, stateDigest: D('plan') }),
    code('sentinel.provider.notAdmitted'));
});

test('hosted disclosure needs the owner receipt; no envelope opens without it, and opening one contacts nothing', needsStore, async t => {
  const policy = trustedPolicy();
  const origin = 'https://models.example.com';
  const binding = bindProvider(policy, 'hosted-review', 'review');
  const s = await setup(t);
  const budget = { maxTokens: 1000, maxCost: '1.00', currency: 'USD' };
  const req = { binding, policy, runId: 'run-1', budget, requestedBy: { principal: 'agent' as const, channel: 'mcp' as const }, stateDigest: D('plan') };
  await assert.rejects(s.broker.openEnvelope(req), code('sentinel.provider.receiptRequired'));
  assert.deepEqual(s.reads, []);
  const intent = envelopeIntent(binding, 'run-1', budget);
  assert.deepEqual(intent.effects, ['paid-inference', 'source-disclosure', 'network']);
  const book = new ReceiptBook(join(s.dir, 'receipts'));
  const r = issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, { intent, stateDigest: D('plan'), policyRevision: policy.revision }, { now: NOW, ttlMs: 600_000 });
  const env = await s.broker.openEnvelope({ ...req, receipt: { book, id: r.id } });
  assert.equal(env.admission.outcome, 'admitted');
  assert.equal(env.admission.verdicts.credential.basis, 'keychain-scope');
  // A receipt for another budget does not admit this one.
  const r2 = issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, { intent: { ...intent, budget: { ...budget, maxCost: '0.50' } }, stateDigest: D('plan'), policyRevision: policy.revision }, { now: NOW, ttlMs: 600_000 });
  await assert.rejects(s.broker.openEnvelope({ ...req, runId: 'run-1', receipt: { book, id: r2.id } }), (e: any) => /different action, input, effect, budget or scope/.test(e.message));
});

test('the ledger: recovery keeps uncertain spend reserved and releases only what was never sent; reconciliation names its authority', needsStore, async t => {
  const dir = scratchDir(t);
  const ledger = await BudgetLedger.open(join(dir, 'b.db'));
  t.after(() => ledger.close());
  const at = '2026-10-22T12:00:00.000000000Z';
  ledger.createEnvelope({ id: 'env-1', runId: 'run-1', bindingDigest: D('b'), admissionDigest: D('a'), receiptDigest: null, maxTokens: 1000, maxCostNanos: 0n, currency: 'USD', createdAt: at });
  const held = ledger.reserve({ envelopeId: 'env-1', operationId: 'op-held', tokens: 100, costNanos: 0n, epoch: 'epoch-dead', at });
  const sent = ledger.dispatch(ledger.reserve({ envelopeId: 'env-1', operationId: 'op-sent', tokens: 200, costNanos: 0n, epoch: 'epoch-dead', at }).id, at);
  const live = ledger.dispatch(ledger.reserve({ envelopeId: 'env-1', operationId: 'op-live', tokens: 300, costNanos: 0n, epoch: 'epoch-live', at }).id, at);
  assert.deepEqual(ledger.recover(['epoch-dead'], at), { released: 1, uncertain: 1 });
  assert.equal(ledger.reservation(held.id).state, 'released');
  assert.equal(ledger.reservation(sent.id).state, 'uncertain');
  assert.equal(ledger.reservation(live.id).state, 'dispatched', 'a live epoch is never touched');
  assert.equal(ledger.totals('env-1').chargedTokens, 500, 'uncertain spend stays charged at its worst case');
  assert.throws(() => ledger.releaseUnsent(sent.id, at, 'no-connection'), code('sentinel.provider.reservationState'), 'uncertain is never released');
  assert.throws(() => ledger.reconcile(sent.id, { inputTokens: 10, outputTokens: 5, costNanos: 0n }, 'owner says so', at), code('sentinel.provider.reservationState'));
  const done = ledger.reconcile(sent.id, { inputTokens: 10, outputTokens: 5, costNanos: 0n }, D('receipt'), at);
  assert.deepEqual([done.state, done.reconciledBy], ['settled', D('receipt')]);
  assert.equal(ledger.totals('env-1').chargedTokens, 315);
  // Reopening from disk keeps everything.
  ledger.close();
  const again = await BudgetLedger.open(join(dir, 'b.db'));
  t.after(() => again.close());
  assert.equal(again.totals('env-1').chargedTokens, 315);
  assert.deepEqual(again.events(sent.id).map(e => e.to), ['held', 'dispatched', 'uncertain', 'settled']);
});

test('concurrent reservations from separate processes never exceed the shared budget', needsStore, async t => {
  const dir = scratchDir(t);
  const path = join(dir, 'shared.db');
  const at = '2026-10-22T12:00:00.000000000Z';
  const ledger = await BudgetLedger.open(path);
  ledger.createEnvelope({ id: 'env-1', runId: 'run-1', bindingDigest: D('b'), admissionDigest: D('a'), receiptDigest: null, maxTokens: 1000, maxCostNanos: 5_000_000_000n, currency: 'USD', createdAt: at });
  ledger.close();
  const { spawn } = await import('node:child_process');
  const lib = new URL('../dist/review/providers/index.js', import.meta.url).href;
  const worker = `
    const { BudgetLedger } = await import(${JSON.stringify(lib)});
    const l = await BudgetLedger.open(process.argv[1]);
    let ok = 0, refused = 0;
    for (let i = 0; i < 10; i++) {
      try { l.reserve({ envelopeId: 'env-1', operationId: 'p' + process.argv[2] + '-' + i, tokens: 70, costNanos: 300_000_000n, epoch: 'e' + process.argv[2], at: '${at}' }); ok++; }
      catch (e) { if (e.code !== 'sentinel.provider.budgetExhausted') throw e; refused++; }
    }
    l.close();
    process.stdout.write(JSON.stringify({ ok, refused }));`;
  const run = (n: number) => new Promise<{ ok: number; refused: number }>((resolve, reject) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', worker, path, String(n)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('exit', c => (c === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
  });
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map(run));
  const ok = results.reduce((a, r) => a + r.ok, 0);
  // 1000 tokens / 70 = 14 by tokens; 5.0 / 0.3 = 16 by money: exactly 14 fit, across all processes.
  assert.equal(ok, 14);
  assert.equal(results.reduce((a, r) => a + r.refused, 0), 60 - 14);
  const check = await BudgetLedger.open(path);
  t.after(() => check.close());
  const totals = check.totals('env-1');
  assert.ok(totals.chargedTokens <= 1000 && totals.chargedCostNanos <= 5_000_000_000n);
  assert.equal(totals.byState.held, 14);
});

test('credentials print and serialize as redacted; a reference outside the farsight keychain service is refused', async () => {
  const s = await resolveCredential(async () => SECRET, 'keychain:farsight/sentinel-review');
  assert.ok(s instanceof Secret);
  assert.equal(String(s), '[redacted]');
  assert.equal(JSON.stringify({ s }), '{"s":"[redacted]"}');
  assert.ok(!inspect(s).includes(SECRET));
  await assert.rejects(resolveCredential(async () => SECRET, 'keychain:farsight-echo/x' as any), code('sentinel.provider.credentialUnavailable'));
  await assert.rejects(resolveCredential(async () => 'two\nlines', 'keychain:farsight/sentinel-review'), code('sentinel.provider.credentialUnavailable'));
  assert.equal(await resolveCredential(async () => SECRET, null), null);
});

test('every code and reservation state is a catalog entry with both registers and a define', async () => {
  const { STRINGS } = await import('@farsight/core/dist/strings.js');
  for (const key of [...PROVIDER_ERROR_CODES, ...Object.values(RESERVATION_STATE_KEYS)]) {
    const e = STRINGS[key];
    assert.ok(e && e.hud && e.professional && e.define, key);
  }
});

test('worst-case input plus output that does not fit the context is never sent', needsStore, async t => {
  const ep = await mockEndpoint(t, (req, res) => json(res, 200, ollamaReply()));
  const { policy, bind } = await withModel({ ollama: ep.origin }, ollamaProfile(ep.origin, { limits: { ...ollamaProfile(ep.origin).limits, contextTokens: 300 } }));
  const binding = bind();
  const s = await setup(t);
  const env = await s.broker.openEnvelope({ binding, policy, runId: 'run-1', budget: BUDGET, requestedBy: HUMAN, stateDigest: D('plan') });
  await assert.rejects(s.broker.generate(env, binding, ask('op-1', { messages: [{ role: 'user', content: 'y'.repeat(400) }] })), code('sentinel.provider.contextExceeded'));
  assert.equal(ep.seen.length, 0);
  assert.equal(s.ledger.totals(env.id).chargedTokens, 0, 'nothing was reserved');
});

test('certificates are always verified: a self-signed endpoint is refused even with the environment override set', async t => {
  const { spawnSync } = await import('node:child_process');
  const dir = scratchDir(t);
  const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
    '-days', '1', '-subj', '/CN=127.0.0.1'], { encoding: 'utf8' });
  if (gen.status !== 0) { t.skip('openssl is not available to make a throwaway certificate'); return; }
  const { createServer } = await import('node:https');
  const { readFileSync } = await import('node:fs');
  let hits = 0;
  const server = createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (req, res) => { hits++; json(res, 200, { models: [] }); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    await assert.rejects(probeCapability({ kind: 'ollama', origin, model: 'm', timeoutMs: 2000, maxResponseBytes: 1024, now: NOW }),
      (e: any) => e.code === 'sentinel.provider.unreachable' && e.spend === 'none');
  } finally {
    if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
  }
  assert.equal(hits, 0, 'no request reached the server');
});

test('importing the providers loads no SQLite, starts no process and opens no connection', async t => {
  const { spawnSync } = await import('node:child_process');
  const { writeFileSync, readdirSync } = await import('node:fs');
  const dir = scratchDir(t);
  writeFileSync(join(dir, 'probe.mjs'), `
    import cp from 'node:child_process';
    import net from 'node:net';
    const events = [];
    for (const n of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) { const o = cp[n]; cp[n] = (...a) => { events.push(n); return o(...a); }; }
    const c = net.Socket.prototype.connect; net.Socket.prototype.connect = function (...a) { events.push('connect'); return c.apply(this, a); };
    await import(${JSON.stringify(new URL('../dist/review/providers/index.js', import.meta.url).href)});
    process.stdout.write(JSON.stringify({ events, sqlite: process.moduleLoadList.some(m => /sqlite/.test(m)) }));`);
  const r = spawnSync(process.execPath, ['probe.mjs'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { events: [], sqlite: false });
  assert.deepEqual(readdirSync(dir), ['probe.mjs']);
});

// ---- review regressions (SOL, provider 43930a84) ----

test('the budget, run and state confirmed are the ones recorded, even if the caller changes them during the keychain read', needsStore, async t => {
  const ep = await mockEndpoint(t, (req, res) => json(res, 200, openaiReply()));
  const policy = trustedPolicy({ openai: ep.origin });
  const binding = bindProvider(policy, 'local-openai', 'review');
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  let started!: () => void; const lookup = new Promise<void>(r => { started = r; });
  const s = await setup(t, { credentials: async () => { started(); await gate; return SECRET; } });
  const budget = { maxTokens: 300, maxCost: '0.01', currency: 'USD' };
  const book = new ReceiptBook(join(s.dir, 'receipts'));
  const r = issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, { intent: envelopeIntent(binding, 'run-1', budget), stateDigest: D('plan'), policyRevision: policy.revision }, { now: NOW, ttlMs: 600_000 });
  const req = { binding, policy, runId: 'run-1', budget, requestedBy: { ...HUMAN }, stateDigest: D('plan'), receipt: { book, id: r.id } };
  const pending = s.broker.openEnvelope(req);
  await lookup;
  budget.maxTokens = 100000; budget.maxCost = '1.00'; req.runId = 'run-2'; (req.requestedBy as any).principal = 'agent'; req.stateDigest = D('other');
  release();
  const env = await pending;
  const totals = s.ledger.totals(env.id);
  assert.deepEqual([totals.maxTokens, totals.maxCostNanos, env.runId], [300, 10_000_000n, 'run-1']);
  await assert.rejects(s.broker.generate(env, binding, ask('op-big', { messages: [{ role: 'user', content: 'x'.repeat(1000) }] })), code('sentinel.provider.budgetExhausted'));
  assert.equal(ep.seen.length, 0);
});

test('a model name the provider returns never reaches a public error', needsStore, async t => {
  const ep = await mockEndpoint(t, (req, res) => json(res, 200, openaiReply({ model: SECRET })));
  const policy = trustedPolicy({ openai: ep.origin });
  const binding = bindProvider(policy, 'local-openai', 'review');
  const s = await setup(t);
  const budget = { maxTokens: 1000, maxCost: '0.01', currency: 'USD' };
  const book = new ReceiptBook(join(s.dir, 'receipts'));
  const r = issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, { intent: envelopeIntent(binding, 'run-1', budget), stateDigest: D('plan'), policyRevision: policy.revision }, { now: NOW, ttlMs: 600_000 });
  const env = await s.broker.openEnvelope({ binding, policy, runId: 'run-1', budget, requestedBy: HUMAN, stateDigest: D('plan'), receipt: { book, id: r.id } });
  await assert.rejects(s.broker.generate(env, binding, ask()), (e: any) => e.code === 'sentinel.provider.identityMismatch' && !e.message.includes(SECRET) && !inspect(e).includes(SECRET));
});

test('one call above its own reservation freezes the envelope even when the envelope has room', needsStore, async t => {
  const { ep, broker, ledger, env, binding } = await ollamaEnvelope(t, (req, res) => json(res, 200, ollamaReply({ prompt_eval_count: 900, eval_count: 50 })),
    { maxTokens: 20000, maxCost: '0', currency: 'USD' });
  const reply = await broker.generate(env, binding, ask('op-1'));
  assert.ok(reply.reservation.usedInputTokens! + reply.reservation.usedOutputTokens! > reply.reservation.tokens);
  const totals = ledger.totals(env.id);
  assert.ok(totals.chargedTokens < totals.maxTokens, 'the envelope as a whole still has room');
  assert.equal(totals.overdrawn, true);
  await assert.rejects(broker.generate(env, binding, ask('op-2')), code('sentinel.provider.envelopeOverdrawn'));
  assert.equal(ep.seen.length, 1);
});

test('long operation ids never collide: each distinct id has its own reservation', needsStore, async t => {
  const ledger = await BudgetLedger.open(join(scratchDir(t), 'b.db'));
  t.after(() => ledger.close());
  const at = '2026-10-22T12:00:00.000000000Z';
  ledger.createEnvelope({ id: 'env', runId: 'run', bindingDigest: D('b'), admissionDigest: D('a'), receiptDigest: null, maxTokens: 1000, maxCostNanos: 0n, currency: 'USD', createdAt: at });
  const long = 'o'.repeat(127);
  const ids = ['o'.repeat(60) + 'a', 'o'.repeat(60) + 'b', long.slice(0, 126) + 'a', long.slice(0, 126) + 'b'].map(op =>
    ledger.reserve({ envelopeId: 'env', operationId: op, tokens: 1, costNanos: 0n, epoch: 'epoch-a', at }).id);
  assert.equal(new Set(ids).size, 4);
  assert.equal(ledger.totals('env').byState.held, 4);
  assert.throws(() => ledger.reserve({ envelopeId: 'env', operationId: 'o'.repeat(129), tokens: 1, costNanos: 0n, epoch: 'epoch-a', at }), code('sentinel.provider.ledgerInvalid'));
});

test('the owner probe reads the origin and model from the adopted settings, never the caller', async t => {
  const ep = await mockEndpoint(t, (req, res) => json(res, 200, { models: [{ name: 'review-model:1', model: 'review-model:1', digest: 'c'.repeat(64) }] }));
  const policy = trustedPolicy({ ollama: ep.origin });
  const rec = await probeConfigured(policy, 'local-review', 'review', { timeoutMs: 1000, maxResponseBytes: 4096, now: NOW });
  assert.deepEqual([rec.origin, rec.model, rec.revision], [ep.origin, 'review-model:1', `sha256:${'c'.repeat(64)}`]);
  await assert.rejects(probeConfigured(policy, 'local-review', 'nope', { timeoutMs: 1000, maxResponseBytes: 4096, now: NOW }), code('sentinel.provider.notTrusted'));
  await assert.rejects(probeConfigured({ settings: policy.settings } as any, 'local-review', 'review', { timeoutMs: 1000, maxResponseBytes: 4096, now: NOW }), code('sentinel.provider.notTrusted'));
  assert.equal(ep.seen.length, 1);
});
