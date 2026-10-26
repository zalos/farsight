// Genuine held owner, private descriptor and actual admission/publication. No forged accepted capabilities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { OwnerService } from '../dist/service/owner-service.js';
import { publishOwnerCompanion } from '../dist/owner-ui/descriptor.js';
import { companionDirectory, companionWorkspaceDigest } from '@farsight/core/dist/sentinel-companion.js';
import { preparationFixture } from './helpers/preparation-fixture.ts';
import { needsStore } from './snapshot-helpers.ts';
import { ReceiptBook } from '../dist/policy/receipts.js';
const by = { principal: 'agent' as const, channel: 'owner-ui' as const },
  key = 'browser_preparation_request_0001',
  wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function fixture(t: any) {
  const f = await preparationFixture(t);
  const oldState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(f.dir, 'owner');
  t.after(() => {
    if (oldState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = oldState;
  });
  const service = new OwnerService(f.store, f.ws, { registry: f.registry });
  t.after(() => service.stop());
  const hostInstance = 'host-' + 'a'.repeat(32),
    value = {
      schema: 'farsight-sentinel-companion/1' as const,
      workspaceDigest: companionWorkspaceDigest(f.ws.path),
      ownerOrigin: 'http://127.0.0.1:4501',
      farsightOrigin: 'http://127.0.0.1:4500',
      hostInstance,
      processNonce: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
    descriptor = await publishOwnerCompanion(companionDirectory(), value);
  t.after(() => descriptor.close());
  const pair: any = await service.handle(
      'owner-ui.pair',
      { farsightOrigin: value.farsightOrigin, hostInstance, processNonce: value.processNonce },
      by,
    ),
    view = {
      frameNonce: 'frame-' + 'c'.repeat(32),
      documentId: 'document-' + 'd'.repeat(32),
      revision: 1,
      hostInstance,
      mode: 'live',
      sync: null,
    };
  await service.handle('owner-ui.context', { proof: pair.proof, view }, by);
  const call = (op: string, body: any = {}) => service.handle(op, { proof: pair.proof, revision: 1, ...body }, by);
  return { ...f, service, descriptor, pair, view, call };
}
test(
  'genuine paired UI prepares, inspects source-gone inputs and separately starts with honest four-action receipts',
  { ...needsStore, timeout: 60000 },
  async (t) => {
    const f = await fixture(t),
      preview: any = await f.call('owner-ui.preview', { requestKey: key });
    assert.equal('confirmation' in preview, false);
    const accepted: any = await f.call('owner-ui.accept', { requestKey: key, previewId: preview.id });
    assert.equal(accepted.outcome, 'submitted', JSON.stringify(accepted));
    for (let i = 0; i < 600 && f.service.busy; i++) await wait(10);
    const status: any = await f.call('owner-ui.status', { requestKey: key });
    assert.equal(status.facts.phase, 'prepared', JSON.stringify(status));
    const runId = status.facts.runId;
    rmSync(join(f.ws.path, 'src'), { recursive: true });
    const inspection: any = await f.service.handle('run.inspect', { runId }, by);
    assert.ok(inspection.counts.inputs.n > 0);
    const control: any = await f.call('owner-ui.control-preview', { runId, action: 'start' });
    assert.equal(control.modelAdmission, false);
    const started: any = await f.call('owner-ui.control', { previewId: control.id });
    assert.equal(started.outcome, 'submitted', JSON.stringify(started));
    await f.service.handle('run.wait', { runId, timeoutMs: 25000 }, by);
    assert.equal(f.store.ledger.getRun(runId)!.state, 'completed');
    assert.ok(await f.service.handle('report.open', { runId, format: 'json' }, by));
    const receipts = join(f.ws.trustDir, 'receipts'),
      records = readdirSync(receipts)
        .filter((n) => n.endsWith('.json'))
        .map((n) => JSON.parse(readFileSync(join(receipts, n), 'utf8')))
        .filter((v) => v.schema === 'sentinel-owneruireceipt/draft-1');
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((v) => v.actor),
      [
        { channel: 'owner-ui', principal: 'human' },
        { channel: 'owner-ui', principal: 'human' },
      ],
    );
    assert.deepEqual(records.map((v) => v.action).sort(), ['capture.source', 'run.start']);
    for (const r of records)
      assert.throws(() =>
        new ReceiptBook(receipts).check(
          r.id,
          { intent: preview as any, stateDigest: r.stateDigest, policyRevision: r.policyRevision },
          new Date(),
        ),
      );
  },
);
test(
  'owner-ui hello, wrong descriptor proof, historical context and copied private tokens grant no owner authority',
  { ...needsStore, timeout: 60000 },
  async (t) => {
    const f = await fixture(t),
      seq = f.store.ledger.currentSequence(),
      spentBefore = readdirSync(join(f.ws.trustDir, 'receipts'))
        .filter((n) => n.endsWith('.spent'))
        .sort();
    await assert.rejects(
      f.service.handle(
        'owner-ui.pair',
        { farsightOrigin: 'http://127.0.0.1:4500', hostInstance: f.view.hostInstance, processNonce: 'e'.repeat(64) },
        by,
      ),
    );
    await assert.rejects(
      f.service.handle('owner-ui.preview', { proof: 'e'.repeat(64), revision: 1, requestKey: key }, by),
    );
    const preview: any = await f.call('owner-ui.preview', { requestKey: key });
    const denied: any = await f.service.handle('prepare.accept', { requestKey: key, previewId: preview.id }, by);
    assert.equal(denied.outcome, 'configuration-failure');
    await f.service.handle(
      'owner-ui.context',
      { proof: f.pair.proof, view: { ...f.view, revision: 2, mode: 'historical', sync: 1 } },
      by,
    );
    const historical: any = await f.service.handle(
      'owner-ui.accept',
      { proof: f.pair.proof, revision: 2, requestKey: key, previewId: preview.id },
      by,
    );
    assert.equal(historical.outcome, 'configuration-failure');
    assert.equal(historical.reasonCode, 'sentinel.ownerUi.changed');
    assert.equal(historical.status, null);
    assert.equal(f.store.ledger.currentSequence(), seq);
    assert.deepEqual(
      readdirSync(join(f.ws.trustDir, 'receipts'))
        .filter((n) => n.endsWith('.spent'))
        .sort(),
      spentBefore,
    );
  },
);
