import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { providerCaller } from '../dist/review/caller.js';
import { bindProvider, BudgetLedger, ModelBroker } from '../dist/review/providers/index.js';
import { trustedPolicy, D, NOW, scratchDir, mockEndpoint, json, ollamaReply } from './provider-helpers.ts';
import { needsStore } from './snapshot-helpers.ts';
test('provider caller compares and dispatches the same genuine binding with no getter reread', async () => {
  const policy = trustedPolicy(),
    first = bindProvider(policy, 'local-review', 'review'),
    second = bindProvider(policy, 'local-openai', 'review');
  let getters = 0,
    dispatched: any;
  const caller = providerCaller(
    {
      generate: async (_e: any, b: any) => {
        dispatched = b;
        return {
          content: 'original',
          truncated: false,
          identity: { requestedModel: 'original', returnedModel: 'original', probedRevision: null, source: 'unknown' },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    } as any,
    {} as any,
    () => (++getters === 1 ? first : second),
  );
  await caller.call({
    operationId: 'original',
    messages: [{ role: 'system', content: 'original' }],
    maxOutputTokens: 1,
    requestedSelection: { providerId: first.providerId, modelId: first.modelId, bindingDigest: first.digest },
  });
  assert.equal(getters, 1);
  assert.equal(dispatched, first);
});
test(
  'changed selection refuses before a genuine broker request even if the envelope matches the substituted binding',
  needsStore,
  async (t) => {
    const ep = await mockEndpoint(t, (_q, r) => json(r, 200, ollamaReply())),
      policy = trustedPolicy({ ollama: ep.origin }),
      first = bindProvider(policy, 'local-review', 'review'),
      other = bindProvider(policy, 'local-openai', 'review'),
      ledger = await BudgetLedger.open(join(scratchDir(t), 'model.sqlite'));
    t.after(() => ledger.close());
    const broker = new ModelBroker({
        ledger,
        credentials: async () => {
          throw Error('no credential');
        },
        epoch: 'epoch-original',
        now: () => NOW,
      }),
      env = await broker.openEnvelope({
        binding: first,
        policy,
        runId: 'run-original',
        budget: { maxTokens: 100000, maxCost: '0', currency: 'USD' },
        requestedBy: { principal: 'human', channel: 'owner-cli' },
        stateDigest: D('state'),
      });
    const caller = providerCaller(broker, env, () => first);
    await assert.rejects(
      caller.call({
        operationId: 'operation-original',
        messages: [{ role: 'system', content: 'original' }],
        maxOutputTokens: 1,
        requestedSelection: { providerId: other.providerId, modelId: other.modelId, bindingDigest: other.digest },
      }),
      (e: any) => e.code === 'sentinel.provider.bindingChanged',
    );
    assert.equal(ep.seen.length, 0);
    assert.equal(ledger.totals(env.id).chargedTokens, 0);
  },
);
