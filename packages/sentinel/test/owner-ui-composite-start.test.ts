// A model start confirmed once in the owner panel (lane L-UX U-3, ADR 48 as amended): the panel's preview names the
// stages and each model with its budget (the service's own start.preview), and its confirmation issues one owner-UI
// receipt for the start and one paid.admit receipt per model envelope, which the service checks and spends. The run
// completes over a local mock model, after the confirming request's scope has closed. A genuine workspace, store,
// owner service and plan; the model is a loopback mock endpoint, so nothing leaves this computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OwnerService } from '../dist/service/owner-service.js';
import { adoptWorkspaceSettings, adoptedPolicy } from '../dist/service/local.js';
import { planWorkspaceCanonical } from '../dist/service/canonical.js';
import { publishOwnerCompanion } from '../dist/owner-ui/descriptor.js';
import { companionDirectory, companionWorkspaceDigest } from '@farsight/core/dist/sentinel-companion.js';
import { preparationFixture } from './helpers/preparation-fixture.ts';
import { json, mockEndpoint, ollamaReply, trustedPolicy } from './provider-helpers.ts';
import { scratchUnder, removeScratch } from './lease-helpers.ts';
import { needsStore } from './snapshot-helpers.ts';

const UI = { principal: 'agent' as const, channel: 'owner-ui' as const };
const AGENT = { principal: 'agent' as const, channel: 'mcp' as const };

test(
  'the panel confirms a model start once: one start receipt and one envelope receipt, spent by the service, and the run completes',
  { ...needsStore, timeout: 120000 },
  async (t) => {
    const f = await preparationFixture(t),
      previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(f.dir, 'owner');
    t.after(() => {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
    });
    const ep = await mockEndpoint(t, (q, r) => {
      const last = JSON.parse(JSON.parse(q.body).messages.at(-1).content),
        reply = last.evidence
          ? {
              action: 'final',
              verdict: 'finding',
              claims: [{ statement: 'A fixture review candidate.', citations: last.evidence.map((e: any) => e.id) }],
              inspected: ['src/one.ts'],
            }
          : { action: 'read', path: 'src/one.ts', startLine: 1, endLine: 1 };
      json(r, 200, ollamaReply({ message: { role: 'assistant', content: JSON.stringify(reply) } }));
    });
    const path = join(f.ws.path, '.farsight', 'sentinel', 'settings.json'),
      settings = JSON.parse(readFileSync(path, 'utf8')),
      fixture = trustedPolicy({ ollama: ep.origin }).settings;
    settings.providers = [structuredClone(fixture.providers[0])];
    settings.providers[0].models[0].capability.revision = null;
    settings.reviewModels = {
      stages: [
        { stage: 'guided', providerId: 'local-review', modelId: 'review' },
        { stage: 'general', providerId: 'local-review', modelId: 'review' },
      ],
      segments: [],
    };
    settings.grants.push({ actions: ['paid.admit'], principals: ['human'], confirm: 'always' });
    settings.grants[0].scope.effects = ['local-artifacts', 'tool-execution', 'paid-inference'];
    writeFileSync(path, JSON.stringify(settings));
    assert.equal(adoptWorkspaceSettings(f.ws, { confirm: true, now: new Date() }).outcome, 'prepared');
    const adopted = adoptedPolicy(f.ws);
    if (!('policy' in adopted)) assert.fail('settings not adopted');
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
    });
    const runId = prepared.disclosure.runId;

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
        expiresAt: new Date(Date.now() + 90000).toISOString(),
      });
    t.after(async () => {
      await service.stop();
      await descriptor.close();
    });
    const pair: any = await service.handle(
      'owner-ui.pair',
      { farsightOrigin: 'http://127.0.0.1:4500', hostInstance, processNonce: nonce },
      UI,
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
      UI,
    );
    const dir = join(f.ws.trustDir, 'receipts');
    const panelReceipts = () =>
      readdirSync(dir)
        .filter((n) => n.endsWith('.json'))
        .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')))
        .filter((r) => r.schema === 'sentinel-owneruireceipt/draft-1');

    // The preview: the composite the owner confirms, with nothing issued yet.
    const preview: any = await service.handle(
      'owner-ui.control-preview',
      { proof: pair.proof, revision: 1, runId, action: 'start' },
      UI,
    );
    assert.equal(preview.unavailable, undefined, JSON.stringify(preview));
    assert.equal(preview.modelAdmission, true);
    assert.ok(preview.composite.stages.includes('review-general'), JSON.stringify(preview.composite));
    assert.equal(preview.composite.models[0].runner, 'ollama');
    assert.equal(preview.composite.models[0].budget.maxTokens > 0, true);
    assert.equal(preview.composite.envelopes, 1);
    assert.deepEqual(panelReceipts(), [], 'a preview issues nothing');
    assert.equal(ep.seen.length, 0);

    // Confirmed: a start receipt and one envelope receipt, both spent by the service; the run calls the model.
    const started: any = await service.handle(
      'owner-ui.control',
      { proof: pair.proof, revision: 1, previewId: preview.id },
      UI,
    );
    assert.equal(started.outcome, 'submitted', JSON.stringify(started));
    let done: any;
    for (let i = 0; i < 40; i++) {
      done = await service.handle('run.wait', { runId, timeoutMs: 5000 }, AGENT);
      if (done.outcome !== 'submitted') break;
    }
    assert.equal(done.facts.state, 'completed', JSON.stringify(done));
    assert.ok(ep.seen.length > 0, 'the run called the local model after the confirming request closed');
    const issued = panelReceipts();
    assert.deepEqual(issued.map((r) => r.action).sort(), ['paid.admit', 'run.start']);
    for (const r of issued) assert.ok(existsSync(join(dir, `${r.id}.spent`)), `${r.action} spent`);
    const envelope = issued.find((r) => r.action === 'paid.admit');
    assert.equal(
      Date.parse(envelope.expiresAt.slice(0, 23) + 'Z') - Date.parse(envelope.issuedAt.slice(0, 23) + 'Z'),
      600000,
    );

    // The preview is spent with its confirmation: confirming it again starts nothing.
    await assert.rejects(
      service.handle('owner-ui.control', { proof: pair.proof, revision: 1, previewId: preview.id }, UI),
      (e: any) => e?.code === 'sentinel.ownerUi.changed',
    );
  },
);
