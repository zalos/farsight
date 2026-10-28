// A model unit refused before its attempt keeps its reason in the ledger. The foundation-preview path is planned
// canonically with the general review configured on a local model, and run with no review runtime: the coordinator
// cannot prepare the admitted review, so the review unit never starts. It is held with that refusal's reason (not
// left ready with the reason only in the coordinator's memory), so status and the report can say why it did not run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../dist/store/index.js';
import { adoptedPolicy, adoptWorkspaceSettings, promoteRulePack, workspaceOf } from '../dist/service/local.js';
import { executeRun, planWorkspaceCanonical } from '../dist/service/canonical.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { initWorkspace } from '../dist/cli/init.js';
import { loadPlan } from '../dist/execution/plans.js';
import { stageInputsForUnit } from '../dist/execution/stage-inputs.js';
import { defaultPipelineOf } from '../dist/planner/index.js';
import { PREVIEW_FINDINGS_SCHEMA, PREVIEW_RULE } from '../dist/adapters/preview-detector.js';
import { scratchUnder, removeScratch } from './lease-helpers.ts';
import { needsStore, unlock } from './snapshot-helpers.ts';

const PROVIDER = {
  id: 'local-review',
  kind: 'ollama',
  endpoint: 'http://127.0.0.1:9',
  credential: null,
  disclosure: 'local-only',
  budget: { maxTokens: 100000, maxCost: '0', currency: 'USD' },
  models: [
    {
      id: 'review',
      model: 'review-model:1',
      limits: {
        maxRequestBytes: 65536,
        maxResponseBytes: 16384,
        timeoutMs: 2000,
        maxOutputTokens: 256,
        contextTokens: 8192,
        maxMessages: 16,
        templateTokensPerMessage: 8,
      },
      pricing: { kind: 'no-fee', basis: 'local-runtime' },
      terms: null,
      capability: {
        schema: 'sentinel-model-capability/draft-1',
        kind: 'ollama',
        origin: 'http://127.0.0.1:9',
        model: 'review-model:1',
        listed: true,
        revision: null,
        probedAt: '2026-10-27T11:00:00.000000000Z',
      },
    },
  ],
};

/** A workspace with the foundation preview and the general review on a local model, adopted, and its store. */
async function reviewed(t: any) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-refused-review-')));
  t.after(() => {
    unlock(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'ws');
  mkdirSync(join(path, 'src'), { recursive: true });
  writeFileSync(
    join(path, 'src/users.ts'),
    'export const find = (id: string) => db.query("SELECT 1 WHERE id = " + id);\n',
  );
  const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
  initWorkspace({ workspace: path });
  const file = join(path, '.farsight/sentinel/settings.json');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(
    file,
    JSON.stringify({
      ...settings,
      providers: [PROVIDER],
      reviewModels: { stages: [{ stage: 'general', providerId: 'local-review', modelId: 'review' }], segments: [] },
    }),
  );
  assert.equal(adoptWorkspaceSettings(ws, { confirm: true, now: new Date() }).outcome, 'prepared');
  promoteRulePack(ws, {
    packDir: realpathSync.native(builtinPackDir('foundation-preview')!),
    confirm: true,
    now: new Date(),
  });
  const adopted = adoptedPolicy(ws);
  assert.ok('policy' in adopted);
  const store = await openStore(ws.storePath);
  t.after(() => {
    try {
      store.close();
    } catch {
      /* closed */
    }
  });
  return { path, ws, adopted, store };
}

test('a review unit refused before its attempt is held with the refusal reason', needsStore, async (t) => {
  const { path, ws, adopted, store } = await reviewed(t);
  const work = scratchUnder(store);
  try {
    const planned = await planWorkspaceCanonical(store, {
      workspace: path,
      trustDir: ws.trustDir,
      policy: adopted.policy,
      scratchRoot: work,
      now: new Date(),
    });
    const { plan } = await loadPlan(store, planned.disclosure.runId, planned.disclosure.revision);
    const reviews = plan.units.filter((u) => u.review);
    assert.equal(reviews.length, 1, 'the general review is planned');
    // No review runtime: the admitted review cannot be prepared, so its unit never starts.
    const summary = await executeRun(store, planned.disclosure.runId, { scratchRoot: work });
    assert.equal(summary.state, 'completed', JSON.stringify(summary.failures));
    const ref = { id: reviews[0]!.id, revision: reviews[0]!.revision };
    assert.ok(summary.failures.some((f) => f.work.id === ref.id && f.attemptId === null));
    const row = store.ledger.getWork(ref)!;
    assert.equal(row.state, 'blocked');
    assert.equal(row.reason, 'sentinel.execution.planInvalid');
    assert.equal(store.ledger.countAttempts(ref), 0, 'nothing was attempted');
    // The deterministic units are untouched by the refusal.
    for (const u of plan.units.filter((x) => !x.review))
      assert.equal(store.ledger.getWork({ id: u.id, revision: u.revision })!.state, 'published');
  } finally {
    removeScratch(work);
  }
});

test(
  'a declared pipeline planned through the canonical path is recorded, and its agent stage binds preview.findings',
  needsStore,
  async (t) => {
    const { path, ws, adopted, store } = await reviewed(t);
    const pipeline = defaultPipelineOf({
      checks: [{ adapterId: 'sentinel.preview.detector', rules: [PREVIEW_RULE] }],
      reviews: [{ kind: 'general', runner: 'hosted-api', provider: 'local-review', model: 'review' }],
    }) as any;
    const declared = {
      ...pipeline,
      id: 'reviewed-findings',
      stages: pipeline.stages.map((s: any) =>
        s.id === 'review-general' ? { ...s, needs: ['inventory', { stage: 'preview', output: 'findings' }] } : s,
      ),
    };
    const work = scratchUnder(store);
    try {
      const terms = {
        workspace: path,
        trustDir: ws.trustDir,
        policy: adopted.policy,
        scratchRoot: work,
        now: new Date(),
      };
      const planned = await planWorkspaceCanonical(store, { ...terms, pipeline: declared });
      const admitted = await loadPlan(store, planned.disclosure.runId, planned.disclosure.revision);
      assert.deepEqual(admitted.profile.pipeline, declared, 'the run records the declaration it was planned from');
      // The same terms without a declaration are another run: the declaration is part of a run's identity.
      const plain = await planWorkspaceCanonical(store, terms);
      assert.notEqual(plain.disclosure.runId, planned.disclosure.runId);
      assert.equal(
        (await loadPlan(store, plain.disclosure.runId, plain.disclosure.revision)).profile.pipeline,
        undefined,
      );
      const review = admitted.plan.units.find((u) => u.review)!;
      const summary = await executeRun(store, planned.disclosure.runId, { scratchRoot: work });
      assert.equal(summary.state, 'completed', JSON.stringify(summary.failures));
      // The review unit (refused here for want of a model runtime) is bound to the preview's exact findings documents.
      const inputs = (await stageInputsForUnit(store, admitted, { id: review.id, revision: review.revision }))!;
      assert.equal(inputs.length, 1);
      const findings: string[] = [];
      for (const u of admitted.plan.units.filter((x) => !x.review))
        for (const o of store.ledger.getPublication({ id: u.id, revision: u.revision })!.outputs)
          if (
            o.schema === 'application/json' &&
            JSON.parse((await store.readArtifact(o.id as never)).toString('utf8')).schema === PREVIEW_FINDINGS_SCHEMA
          )
            findings.push(o.id);
      assert.deepEqual(
        [inputs[0]!.state, inputs[0]!.artifacts, inputs[0]!.secretFold],
        ['resolved', findings.sort(), 'applied'],
      );
    } finally {
      removeScratch(work);
    }
  },
);
