// Genuine captured/publicly constructed plan. No provider process, auth, endpoint or inference is invoked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { OwnerService } from '../dist/service/owner-service.js';
import {
  adoptWorkspaceSettings,
  adoptedPolicy,
  confirmForService,
  receiptBook,
  runWriteBinding,
} from '../dist/service/local.js';
import { planWorkspaceCanonical, currentPlan } from '../dist/service/canonical.js';
import { controlOutcome } from '../dist/service/controls.js';
import { publishOwnerCompanion } from '../dist/owner-ui/descriptor.js';
import { companionDirectory, companionWorkspaceDigest } from '@farsight/core/dist/sentinel-companion.js';
import { loadPlan } from '../dist/execution/plans.js';
import { preparationFixture } from './helpers/preparation-fixture.ts';
import { trustedPolicy } from './provider-helpers.ts';
import { scratchUnder, removeScratch } from './lease-helpers.ts';
import { needsStore } from './snapshot-helpers.ts';
test(
  'owner UI refuses paid start before preview or UI receipt; shared MCP start leaves real owner receipt unspent',
  { ...needsStore, timeout: 30000 },
  async (t) => {
    const f = await preparationFixture(t),
      previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(f.dir, 'owner');
    t.after(() => {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
    });
    const path = join(f.ws.path, '.farsight/sentinel/settings.json'),
      settings = JSON.parse(readFileSync(path, 'utf8')),
      provider = structuredClone(trustedPolicy({ ollama: 'http://127.0.0.1:9' }).settings.providers[0]);
    provider.models[0]!.capability.revision = null;
    settings.providers = [provider];
    settings.reviewModels = {
      stages: [{ stage: 'general', providerId: provider.id, modelId: provider.models[0]!.id }],
      segments: [],
    };
    settings.grants[0].scope.effects = ['local-artifacts', 'tool-execution', 'paid-inference'];
    writeFileSync(path, JSON.stringify(settings));
    assert.equal(adoptWorkspaceSettings(f.ws, { confirm: true, now: new Date() }).outcome, 'prepared');
    const adopted = adoptedPolicy(f.ws);
    if (!('policy' in adopted)) assert.fail('genuine adoption absent');
    const lease = scratchUnder(f.store);
    t.after(() => {
      if (f.store.held) removeScratch(lease);
    });
    const prepared = await planWorkspaceCanonical(f.store, {
        workspace: f.ws.path,
        trustDir: f.ws.trustDir,
        policy: adopted.policy,
        scratchRoot: lease,
        now: new Date(),
      }),
      runId = prepared.disclosure.runId,
      plan = await currentPlan(f.store, runId);
    assert.ok(plan && plan.kind === 'analysis' && plan.effects.includes('paid-inference'));
    if (!plan) assert.fail('plan absent');
    const admitted = await loadPlan(f.store, runId);
    assert.ok(admitted.plan.units.some((u) => u.review));
    const service = new OwnerService(f.store, f.ws),
      hostInstance = 'host-' + 'b'.repeat(32),
      nonce = 'c'.repeat(64),
      descriptor = await publishOwnerCompanion(companionDirectory(), {
        schema: 'farsight-sentinel-companion/1',
        workspaceDigest: companionWorkspaceDigest(f.ws.path),
        ownerOrigin: 'http://127.0.0.1:4501',
        farsightOrigin: 'http://127.0.0.1:4500',
        hostInstance,
        processNonce: nonce,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
    t.after(async () => {
      await service.stop();
      await descriptor.close();
    });
    const ui = { principal: 'agent' as const, channel: 'owner-ui' as const },
      pair: any = await service.handle(
        'owner-ui.pair',
        { farsightOrigin: 'http://127.0.0.1:4500', hostInstance, processNonce: nonce },
        ui,
      );
    await service.handle(
      'owner-ui.context',
      {
        proof: pair.proof,
        view: {
          frameNonce: 'frame-' + 'd'.repeat(32),
          documentId: 'document-' + 'e'.repeat(32),
          revision: 1,
          hostInstance,
          mode: 'live',
          sync: null,
        },
      },
      ui,
    );
    const book = receiptBook(f.ws),
      confirmation = confirmForService(f.ws, {
        command: 'run',
        action: 'run.start',
        plan,
        planId: runId,
        confirm: true,
        now: new Date(),
        storeId: f.store.storeId,
      });
    if (!('receiptId' in confirmation)) assert.fail(JSON.stringify(confirmation));
    const binding = {
        ...runWriteBinding(f.ws, 'run.start', plan, { storeId: f.store.storeId, runId }),
        policyRevision: plan.policyRevision,
      },
      before = readdirSync(book.directory).sort(),
      sequence = f.store.ledger.currentSequence();
    const preview: any = await service.handle(
      'owner-ui.control-preview',
      { proof: pair.proof, revision: 1, runId, action: 'start' },
      ui,
    );
    assert.equal(preview.unavailable, true);
    assert.equal(preview.outcome.reasonCode, 'sentinel.review.foregroundRequired');
    assert.equal('id' in preview, false);
    assert.deepEqual(readdirSync(book.directory).sort(), before, 'no new UI receipt on a refused preview');
    for (const receiptId of [undefined, confirmation.receiptId]) {
      const value: any = await service.handle(
        'run.start',
        { planId: runId, ...(receiptId ? { receiptId } : {}) },
        { principal: 'agent', channel: 'mcp' },
      );
      assert.equal(controlOutcome(value).reasonCode, 'sentinel.review.foregroundRequired');
      assert.equal(f.store.ledger.currentSequence(), sequence);
      assert.deepEqual(readdirSync(book.directory).sort(), before);
      assert.doesNotThrow(() => book.check(confirmation.receiptId, binding, new Date()));
    }
    assert.equal(existsSync(join(f.store.storePath, 'review-budget.sqlite')), false);
    assert.ok(admitted.plan.units.every((u) => f.store.ledger.countAttempts(u) === 0));
  },
);
