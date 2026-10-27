// New instruction-context neighbors of the unchanged a0 binding oracle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createModelReviewOperation, guidedSpec, planReviewWork, prepareInstructions } from '../dist/review/index.js';
import { BudgetLedger, ModelBroker, bindProvider } from '../dist/review/providers/index.js';
import { trustedPolicy, NOW, D, scratchDir, mockEndpoint, json, ollamaReply } from './provider-helpers.ts';
import { needsStore } from './snapshot-helpers.ts';
const sha = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex');
test(
  'planned instruction work refuses changed prompt skill and provider selection before checkpoints or fixture requests',
  needsStore,
  async (t) => {
    const ep = await mockEndpoint(t, (_req, res) =>
        json(
          res,
          200,
          ollamaReply({
            message: {
              role: 'assistant',
              content: JSON.stringify({ action: 'final', verdict: 'no-finding', claims: [], inspected: [] }),
            },
          }),
        ),
      ),
      policy = trustedPolicy({ ollama: ep.origin }),
      binding = bindProvider(policy, 'local-review', 'review');
    const ledger = await BudgetLedger.open(join(scratchDir(t), 'model.sqlite'));
    t.after(() => ledger.close());
    const broker = new ModelBroker({
        ledger,
        credentials: async () => {
          throw Error('no credential');
        },
        epoch: 'epoch-original',
        now: () => NOW,
      }),
      envelope = await broker.openEnvelope({
        binding,
        policy,
        runId: 'run-original',
        budget: { maxTokens: 100000, maxCost: '0', currency: 'USD' },
        requestedBy: { principal: 'human', channel: 'owner-cli' },
        stateDigest: D('original'),
      });
    const spec = guidedSpec({
      runId: 'run-original',
      attemptId: 'attempt-original',
      snapshotId: 'snapshot-original',
      sourceId: 'web',
      check: {
        checkId: 'check-original',
        familyId: 'original.rule',
        revisionDigest: sha('rule'),
        ruleText: 'Original rule.',
        files: [{ relativePath: 'original.ts', content: sha('original'), bytes: 8 }],
      },
      limits: { maxSliceLines: 10, maxSliceBytes: 65536, maxToolCalls: 10, maxServedBytes: 262144 },
      budget: { maxSteps: 4, maxInvalidReplies: 1, maxInputBytes: 1048576, maxOutputTokens: 64, deadlineMs: 60000 },
    });
    const selection = { providerId: binding.providerId, modelId: binding.modelId, bindingDigest: binding.digest },
      bound = {
        ...spec,
        instructions: prepareInstructions({
          prompt: spec.prompt,
          skills: [{ id: 'original.skill', revision: 1, text: 'Original selected skill.' }],
        }),
        segmentId: 'original-segment',
        requestedSelection: selection,
      };
    const [unit] = planReviewWork({
      runId: spec.runId,
      planRevision: 2,
      coordinatorEpoch: 'epoch-original',
      createdAt: NOW.toISOString(),
      dependencies: [],
      resources: { deadlineMs: 120000, memoryBytes: 268435456, cpuQuota: 1, maxPids: 8, maxOutputBytes: 4194304 },
      specs: [bound],
    });
    const operation = createModelReviewOperation({
      broker,
      ledger,
      envelope,
      binding: () => bindProvider(policy, 'local-review', 'review'),
      now: () => NOW,
    });
    for (const changed of [
      {
        ...bound,
        prompt: { ...bound.prompt, text: bound.prompt.text + ' changed' },
        instructions: prepareInstructions({
          prompt: { ...bound.prompt, text: bound.prompt.text + ' changed' },
          skills: [],
        }),
      },
      {
        ...bound,
        instructions: prepareInstructions({
          prompt: spec.prompt,
          skills: [{ id: 'original.skill', revision: 2, text: 'Original selected skill.' }],
        }),
      },
      { ...bound, requestedSelection: { ...selection, modelId: 'another-model' } },
      { ...bound, segmentId: 'another-segment' },
    ])
      await assert.rejects(
        operation.run({
          work: unit!.work,
          spec: changed,
          attemptId: spec.attemptId,
          epoch: 'epoch-original',
          read: async () => {
            throw Error('must not read captured bytes');
          },
        }),
        (e: any) => e.code === 'sentinel.review.integrity',
      );
    assert.equal(ep.seen.length, 0, 'no provider request');
    assert.equal(ledger.loadCheckpoint(bound.sessionId), null, 'no request or artifact checkpoint');
  },
);
