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

test('a review unit refused before its attempt is held with the refusal reason', needsStore, async (t) => {
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
