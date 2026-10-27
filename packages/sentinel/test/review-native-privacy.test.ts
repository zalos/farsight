// Existing pinned Gitleaks only; original inert source, no acquisition and no actual model inference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { scratch, unlock } from './snapshot-helpers.ts';
import { scratchUnder, removeScratch } from './lease-helpers.ts';
import { trustedPolicy, mockEndpoint, json, ollamaReply } from './provider-helpers.ts';
import { GENERIC_VALUE, absent } from './secrets-helpers.ts';
import { initWorkspace } from '../dist/cli/init.js';
import {
  workspaceOf,
  adoptWorkspaceSettings,
  adoptedPolicy,
  promoteRulePack,
  privateReviewTrace,
} from '../dist/service/local.js';
import { reviewRuntime, reviewIdentityIn } from '../dist/service/review-adapter.js';
import { reviewSecretsKnown, requireHostedSecretCoverage } from '../dist/review/dispatch.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { adoptScannerAsset } from '../dist/service/scanner-assets.js';
import { openStore } from '../dist/store/index.js';
import { planWorkspaceCanonical, executeRun } from '../dist/service/canonical.js';
import { retainedBootstrapForReport } from '../dist/execution/retained-bootstrap.js';
import { loadPlan } from '../dist/execution/plans.js';
import { assessRun } from '../dist/service/full-report.js';
const native = {
  skip: process.env.SENTINEL_ISOLATION !== '1' && 'requires existing pinned local Gitleaks; never acquires assets',
};
for (const mode of ['matched', 'clean', 'partial']) {
  const hasSecret = mode === 'matched',
    partial = mode === 'partial';
  test(
    'genuine accepted native secret privacy ' +
      (partial
        ? 'refuses partial no-match coverage for hosted use'
        : hasSecret
          ? 'withholds configured review before admission/call'
          : 'preserves useful accepted instruction identities'),
    native,
    async (t) => {
      const dir = scratch(t, 'sentinel-review-native-'),
        path = join(dir, 'workspace');
      mkdirSync(join(path, 'src'), { recursive: true });
      if (partial) writeFileSync(join(path, 'package-lock.json'), '{}\n');
      writeFileSync(
        join(path, 'src', 'original.ts'),
        hasSecret ? `export const api_key = "${GENERIC_VALUE}";\n` : 'export const original = "safe original";\n',
      );
      const endpoint = await mockEndpoint(t, (_q, r) =>
          json(
            r,
            200,
            ollamaReply({
              message: {
                role: 'assistant',
                content: JSON.stringify({ action: 'final', verdict: 'no-finding', claims: [], inspected: [] }),
              },
            }),
          ),
        ),
        ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
      initWorkspace({ workspace: path, profile: 'secrets' });
      const sp = join(path, '.farsight/sentinel/settings.json'),
        settings = JSON.parse(readFileSync(sp, 'utf8')),
        provider = structuredClone(trustedPolicy({ ollama: endpoint.origin }).settings.providers[0]);
      provider.models[0]!.capability.revision = null;
      settings.hostedReviewSecretScan = 'when-selected';
      settings.providers = [provider];
      settings.reviewModels = {
        stages: [{ stage: 'general', providerId: provider.id, modelId: provider.models[0]!.id }],
        segments: [],
      };
      settings.grants.push({ actions: ['paid.admit'], principals: ['human'], confirm: 'always' });
      settings.grants[0].scope.effects = ['local-artifacts', 'tool-execution', 'paid-inference'];
      writeFileSync(sp, JSON.stringify(settings));
      assert.equal(adoptWorkspaceSettings(ws, { confirm: true, now: new Date() }).outcome, 'prepared');
      assert.equal(
        promoteRulePack(ws, {
          packDir: realpathSync.native(builtinPackDir('secrets')!),
          confirm: true,
          now: new Date(),
        }).outcome,
        'prepared',
      );
      assert.equal(
        (await adoptScannerAsset(ws, { kind: 'tool', id: 'secrets-gitleaks', confirm: true, now: new Date() })).outcome,
        'prepared',
      );
      const adopted = adoptedPolicy(ws);
      assert.ok('policy' in adopted);
      if (!('policy' in adopted)) throw Error('policy absent');
      const store = await openStore(ws.storePath),
        work = scratchUnder(store);
      t.after(() => {
        if (store.held) {
          removeScratch(work);
          store.close();
        }
        unlock(dir);
      });
      const terms = {
          workspace: path,
          trustDir: ws.trustDir,
          policy: adopted.policy,
          scratchRoot: work,
          now: new Date(),
        },
        id = (await planWorkspaceCanonical(store, terms)).disclosure.runId,
        runtime = await reviewRuntime(store, ws, true);
      try {
        await executeRun(store, id, { scratchRoot: work, trustDir: ws.trustDir, review: runtime });
      } finally {
        runtime.close();
      }
      const admitted = await loadPlan(store, id),
        assessed = await assessRun(store, id, { trustDir: ws.trustDir });
      if (mode === 'clean') {
        const scans = admitted.plan.units.filter(
          (u) => u.adapterId === 'secrets-gitleaks' && u.sourceId === 'workspace',
        );
        assert.equal(
          scans.length,
          1,
          'hosted qualification uses a single whole-source publication, not a union of partial scans',
        );
        assert.ok(store.ledger.getPublication(scans[0]!));
        const captured = (await retainedBootstrapForReport(store, id, admitted)).snapshot.entries.filter(
          (e) => e.sourceId === 'workspace' && e.kind === 'file' && e.disposition === 'included',
        );
        assert.deepEqual(
          scans[0]!.inputs.map((e) => [e.relativePath, e.content]).sort(),
          captured.map((e) => [e.relativePath, e.content]).sort(),
          'that one scan covers every included captured source entry',
        );
      }
      assert.equal(
        assessed.observations.some((o) => o.producer.kind === 'scanner' && o.producer.adapterId === 'secrets-gitleaks'),
        hasSecret,
      );
      assert.equal(await reviewSecretsKnown(store, id, admitted), hasSecret);
      if (hasSecret || partial)
        await assert.rejects(
          requireHostedSecretCoverage(store, id, admitted, 'workspace'),
          (e: any) => e.code === 'sentinel.review.secretCoverageRequired',
        );
      else await requireHostedSecretCoverage(store, id, admitted, 'workspace');
      await assert.rejects(
        requireHostedSecretCoverage(store, id, admitted, 'foreign-source'),
        (e: any) => e.code === 'sentinel.review.secretCoverageRequired',
      );
      assert.equal(endpoint.seen.length, hasSecret ? 0 : 1);
      const units = admitted.plan.units.filter((u) => u.review);
      assert.equal(units.length, 1);
      assert.equal(Boolean(store.ledger.getPublication(units[0]!)), !hasSecret);
      assert.equal((await reviewIdentityIn(store, id)).status, hasSecret ? 'unavailable' : 'available');
      removeScratch(work);
      store.close();
      const privateView = await privateReviewTrace(ws, id);
      absent(JSON.stringify(privateView), 'private actual review privacy', GENERIC_VALUE);
      assert.equal(privateView.facts.privacy, hasSecret ? 'withheld' : 'private-owner-view');
    },
  );
}
