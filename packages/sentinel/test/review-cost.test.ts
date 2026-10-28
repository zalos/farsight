// What a brokered review records about money, and where the model ledger lives. A brokered stage states its cost the
// way a stage's provenance does (`StageCost`): the rates price of the confirmed usage, or unobserved with its reason,
// never a zero amount for a subscription CLI. The budget ledger holds the owner's model usage, so it is 0600.
// No real provider, model or keychain: a stub broker, a local mock endpoint and in-memory credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { providerCaller } from '../dist/review/caller.js';
import { BudgetLedger, ModelBroker, bindProvider, envelopeIntent } from '../dist/review/providers/index.js';
import { fromNanos } from '../dist/review/providers/decimal.js';
import { CLAUDE_NATIVE_PROFILE } from '../dist/review/providers/cli-native-profile.js';
import { DEFAULT_SETTINGS, effectivePolicy, ReceiptBook } from '../dist/policy/index.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import {
  D,
  LIMITS,
  NOW,
  TERMS,
  json,
  mockEndpoint,
  openaiReply,
  scratchDir,
  trustedPolicy,
} from './provider-helpers.ts';
import { needsStore } from './snapshot-helpers.ts';

const code = (c: string) => (e: any) => e?.code === c;
const costOf = (binding: unknown, usage: { inputTokens: number; outputTokens: number }[], unsettled = false) =>
  providerCaller({} as any, {} as any, () => binding as any).costOf!(usage, unsettled);

/** The owner-adopted brokered Claude Code subscription: tokens are bounded, money is never reported. */
function subscriptionPolicy() {
  const model = 'claude-haiku-4-5-20251001';
  return effectivePolicy({
    trust: 'adopted',
    settings: {
      ...structuredClone(DEFAULT_SETTINGS),
      nativeClaudeReviewEnabled: true,
      grants: [
        { actions: ['paid.admit'], principals: ['human'], confirm: 'never', scope: { providers: ['native-claude'] } },
      ],
      reviewModels: { stages: [{ stage: 'guided', providerId: 'native-claude', modelId: 'haiku' }], segments: [] },
      providers: [
        {
          id: 'native-claude',
          kind: 'claude-cli',
          endpoint: 'https://api.anthropic.com',
          credential: null,
          disclosure: 'hosted',
          nativeProfile: {
            id: CLAUDE_NATIVE_PROFILE.id,
            executableDigest: CLAUDE_NATIVE_PROFILE.executableDigest,
            helperDigest: D('synthetic-helper'),
            profileDigest: D('synthetic-profile'),
          },
          budget: { maxTokens: 200000, maxCost: null, currency: null },
          models: [
            {
              id: 'haiku',
              model,
              limits: { ...LIMITS, contextTokens: 200000 },
              pricing: { kind: 'subscription-quota', basis: 'owner-subscription' },
              terms: TERMS,
              capability: {
                schema: 'sentinel-model-capability/draft-1',
                kind: 'claude-cli',
                origin: 'https://api.anthropic.com',
                model,
                listed: true,
                revision: null,
                probedAt: '2026-10-22T11:00:00.000000000Z',
              },
            },
          ],
        },
      ],
    } as any,
    settingsDigest: D('subscription'),
    repoConfig: null,
    repoConfigDigest: null,
  });
}

test('a brokered review states its cost as a stage provenance does: a subscription CLI is unobserved, never zero', () => {
  const usage = [
    { inputTokens: 1000, outputTokens: 100 },
    { inputTokens: 2000, outputTokens: 50 },
  ];
  const subscription = bindProvider(subscriptionPolicy(), 'native-claude', 'haiku');
  assert.equal(subscription.pricing.kind, 'subscription-quota');
  assert.deepEqual(costOf(subscription, usage), { basis: 'unobserved', reason: 'subscription' });
  // A local runtime has no fee and no rates: its cost is unobserved too, never the ledger's `0`.
  assert.deepEqual(costOf(bindProvider(trustedPolicy(), 'local-review', 'review'), usage), {
    basis: 'unobserved',
    reason: 'no-rates',
  });
  // Owner-entered rates price the confirmed usage: 1000 × 2.50 + 100 × 10 + 2000 × 2.50 + 50 × 10 per million.
  const rates = bindProvider(trustedPolicy(), 'local-openai', 'review');
  assert.deepEqual(costOf(rates, usage), { basis: 'rates', amount: '0.009', currency: 'USD' });
  // A call that may have been charged without its usage leaves the cost unknown, whatever the pricing.
  for (const b of [subscription, rates])
    assert.deepEqual(costOf(b, usage, true), { basis: 'unobserved', reason: 'usage-unknown' });
  assert.throws(() => costOf({ ...rates }, usage), code('sentinel.provider.notTrusted'));
});

test('the rates amount a brokered review states is the amount the ledger settled', needsStore, async (t) => {
  const ep = await mockEndpoint(t, (_req, res) => json(res, 200, openaiReply()));
  const policy = trustedPolicy({ openai: ep.origin });
  const binding = bindProvider(policy, 'local-openai', 'review');
  const dir = scratchDir(t);
  const ledger = await BudgetLedger.open(join(dir, 'budget.db'));
  t.after(() => ledger.close());
  const broker = new ModelBroker({ ledger, credentials: async () => 'sk-test-only', epoch: 'epoch-a', now: () => NOW });
  const budget = { maxTokens: 20000, maxCost: '0.50', currency: 'USD' };
  const book = new ReceiptBook(join(dir, 'receipts'));
  const receipt = issueReceipt(
    book,
    { channel: 'owner-cli', principal: 'owner' },
    { intent: envelopeIntent(binding, 'run-1', budget), stateDigest: D('plan'), policyRevision: policy.revision },
    { now: NOW, ttlMs: 600_000 },
  );
  const env = await broker.openEnvelope({
    binding,
    policy,
    runId: 'run-1',
    budget,
    requestedBy: { principal: 'human', channel: 'owner-cli' },
    stateDigest: D('plan'),
    receipt: { book, id: receipt.id },
  });
  const caller = providerCaller(broker, env, () => binding);
  const usage: { inputTokens: number; outputTokens: number }[] = [];
  for (const operationId of ['op-1', 'op-2']) {
    const r = await caller.call({ operationId, messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: 64 });
    usage.push(r.usage);
  }
  const charged = ledger.totals(env.id).chargedCostNanos;
  assert.ok(charged !== null && charged > 0n);
  assert.deepEqual(caller.costOf!(usage, false), { basis: 'rates', amount: fromNanos(charged), currency: 'USD' });
});

test(
  'the budget ledger and its journal files are the owner’s alone: created 0600, an older wider file narrowed, a link refused',
  { skip: process.platform === 'win32' ? 'POSIX file modes' : (needsStore as { skip?: string }).skip },
  async (t) => {
    const dir = scratchDir(t);
    const path = join(dir, 'review-budget.sqlite');
    const mode = (p: string) => statSync(p).mode & 0o777;
    const ledger = await BudgetLedger.open(path);
    ledger.createEnvelope({
      id: 'env-1',
      runId: 'run-1',
      providerId: 'local-review',
      bindingDigest: D('binding'),
      admissionDigest: D('admission'),
      receiptDigest: null,
      maxTokens: 100,
      maxCostNanos: 0n,
      currency: 'USD',
      createdAt: '2026-10-22T12:00:00.000000000Z',
    });
    const files = [path, `${path}-wal`, `${path}-shm`].filter((p) => existsSync(p));
    assert.ok(files.includes(`${path}-wal`), 'a write opens the journal');
    for (const p of files) assert.equal(mode(p), 0o600, p);
    ledger.close();
    // A ledger an earlier version left readable by others is narrowed on open, its rows kept.
    chmodSync(path, 0o644);
    const again = await BudgetLedger.open(path);
    assert.equal(mode(path), 0o600);
    assert.equal(again.totals('env-1').maxTokens, 100);
    again.close();
    const link = join(dir, 'link.sqlite');
    symlinkSync(path, link);
    await assert.rejects(BudgetLedger.open(link), code('sentinel.provider.ledgerInvalid'));
  },
);
