// Public held-service operations with genuine owner-issued one-use receipts. No fabricated admission/publication.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OwnerService } from '../dist/service/owner-service.js';
import { ReceiptBook } from '../dist/policy/receipts.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { currentPlan } from '../dist/service/canonical.js';
import { runWriteBinding, OWNER } from '../dist/service/local.js';
import { preparationFixture } from './helpers/preparation-fixture.ts';
import { needsStore } from './snapshot-helpers.ts';
const cli = { principal: 'agent' as const, channel: 'local-service' as const },
  mcp = { principal: 'agent' as const, channel: 'mcp' as const };
const key = 'fixture_preparation_key_0001';
async function untilPrepared(service: OwnerService, requestKey = key): Promise<any> {
  for (let i = 0; i < 500; i++) {
    const r: any = await service.handle('prepare.status', { requestKey }, cli);
    if (['prepared', 'failed', 'canceled', 'interrupted'].includes(r.facts.phase)) return r;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('preparation did not reach a retained terminal status');
}
function receipt(f: any, binding: any) {
  return issueReceipt(new ReceiptBook(join(f.ws.trustDir, 'receipts')), OWNER, binding, {
    now: new Date(),
    ttlMs: 600000,
  });
}
test(
  'actual held service durable prepare → lost acceptance ACK → key lookup → inspect → separate owner start',
  needsStore,
  async (t) => {
    const f = await preparationFixture(t),
      service = new OwnerService(f.store, f.ws, { registry: f.registry });
    t.after(() => service.stop());
    const preview: any = await service.handle('configuration.preview', { requestKey: key }, cli);
    assert.equal(preview.sourceCaptured, false);
    assert.equal(preview.capabilitiesChecked, false);
    assert.ok(preview.confirmation);
    const r = receipt(f, preview.confirmation),
      args = { previewId: preview.id, requestKey: key, receiptId: r.id };
    const accepted: any = await service.handle('prepare.accept', args, cli);
    assert.equal(accepted.outcome, 'submitted');
    assert.equal(accepted.facts.phase, 'accepted');
    assert.equal(service.busy, true);
    // Discard the acceptance response: reconnect/discovery uses the persisted caller key and never spends again.
    const joined: any = await service.handle('prepare.accept', args, cli);
    assert.equal(joined.outcome, 'kept');
    assert.equal(joined.facts.preparationId, accepted.facts.preparationId);
    const status = await untilPrepared(service);
    assert.equal(status.facts.phase, 'prepared', JSON.stringify(status));
    assert.equal(status.facts.checksStartedByPreparation, false);
    assert.ok(status.facts.runDeadlineAt);
    const runId = status.facts.runId;
    rmSync(join(f.ws.path, 'src'), { recursive: true });
    const inspected: any = await service.handle('run.inspect', { runId }, cli);
    assert.ok(inspected.viewId);
    const plan = (await currentPlan(f.store, runId))!;
    assert.equal(plan.revision, 2);
    const binding = runWriteBinding(f.ws, 'run.start', plan, { storeId: f.store.storeId, runId }),
      start = receipt(f, { ...binding, policyRevision: plan.policyRevision });
    const started: any = await service.handle('run.start', { planId: runId, receiptId: start.id }, cli);
    assert.equal(started.outcome, 'submitted');
    const done: any = await service.handle('run.wait', { runId, timeoutMs: 25000 }, cli);
    assert.equal(f.store.ledger.getRun(runId)!.state, 'completed');
    assert.notEqual(done.outcome, 'configuration-failure');
    assert.ok(
      f.store.ledger.readEvents({ runId, after: 0, limit: 500 }).events.some((e) => e.kind === 'work-published'),
    );
  },
);
test(
  'pure preview, denied/forged receipt and status create no preparation journal or source stage',
  needsStore,
  async (t) => {
    const f = await preparationFixture(t),
      service = new OwnerService(f.store, f.ws, { registry: f.registry });
    t.after(() => service.stop());
    const sequence = f.store.ledger.currentSequence();
    const unknown: any = await service.handle('prepare.status', { requestKey: key }, mcp);
    assert.equal(unknown.facts.found, false);
    const preview: any = await service.handle('configuration.preview', { requestKey: key }, mcp);
    assert.equal('confirmation' in preview, false);
    assert.equal(preview.sourceCaptured, false);
    const denied: any = await service.handle('prepare.accept', { previewId: preview.id, requestKey: key }, mcp);
    assert.equal(denied.outcome, 'configuration-failure');
    await assert.rejects(
      service.handle('prepare.accept', { previewId: preview.id, requestKey: key, receiptId: 'receipt-forged' }, mcp),
    );
    const own: any = await service.handle('configuration.preview', { requestKey: key }, cli);
    await assert.rejects(
      service.handle('prepare.accept', { previewId: own.id, requestKey: key, receiptId: 'receipt-forged' }, cli),
    );
    assert.equal(existsSync(join(f.store.storePath, 'preparation')), false);
    assert.equal(f.store.ledger.currentSequence(), sequence);
    assert.equal(f.store.ledger.listOpenStages().length, 0);
  },
);

test(
  'preparation-bound owner cancellation before capture stops effects, and the capture receipt cannot authorize it',
  needsStore,
  async (t) => {
    const f = await preparationFixture(t),
      service = new OwnerService(f.store, f.ws, { registry: f.registry });
    t.after(() => service.stop());
    const preview: any = await service.handle('configuration.preview', { requestKey: key }, cli),
      r = receipt(f, preview.confirmation);
    await service.handle('prepare.accept', { previewId: preview.id, requestKey: key, receiptId: r.id }, cli);
    await assert.rejects(service.handle('prepare.cancel', { requestKey: key, receiptId: r.id }, cli));
    const before: any = await service.handle('prepare.status', { requestKey: key }, cli),
      cancel = receipt(f, before.facts.confirmation.cancel);
    const requested: any = await service.handle('prepare.cancel', { requestKey: key, receiptId: cancel.id }, cli);
    assert.equal(requested.outcome, 'requested');
    const ended = await untilPrepared(service);
    assert.equal(ended.facts.phase, 'canceled');
    assert.equal(ended.facts.captured, false);
    assert.equal(
      f.store.ledger.readEvents({ after: 0, limit: 500 }).events.some((e) => e.kind === 'snapshot-admitted'),
      false,
    );
  },
);
test(
  'explicit fresh owner resume uses exact captured bytes after actual owner reopen and source removal, never recaptures',
  needsStore,
  async (t) => {
    const { ObjectStore } = await import('../dist/store/objects.js'),
      { openStore } = await import('../dist/store/index.js');
    const f = await preparationFixture(t),
      service = new OwnerService(f.store, f.ws, { registry: f.registry });
    let observed!: () => void,
      release!: () => void,
      gated = false;
    const atRead = new Promise<void>((r) => {
        observed = r;
      }),
      held = new Promise<void>((r) => {
        release = r;
      });
    const read = ObjectStore.prototype.read,
      mocked = t.mock.method(
        ObjectStore.prototype,
        'read',
        async function (this: InstanceType<typeof ObjectStore>, ...args: any[]) {
          const b = await (read as any).apply(this, args);
          if (!gated && b.toString('utf8').includes('sentinel-snapshot/draft-1')) {
            gated = true;
            observed();
            await held;
          }
          return b;
        },
      );
    const preview: any = await service.handle('configuration.preview', { requestKey: key }, cli),
      r = receipt(f, preview.confirmation);
    const accepted: any = await service.handle(
      'prepare.accept',
      { previewId: preview.id, requestKey: key, receiptId: r.id },
      cli,
    );
    await atRead;
    const captured: any = await service.handle('prepare.status', { requestKey: key }, cli);
    assert.equal(captured.facts.captured, true);
    const stopping = service.stop();
    release();
    await stopping;
    mocked.mock.restore();
    const interrupted: any = await service.handle('prepare.status', { requestKey: key }, cli);
    assert.equal(interrupted.facts.phase, 'interrupted');
    assert.equal(interrupted.facts.deadlineAt, accepted.facts.deadlineAt);
    rmSync(join(f.ws.path, 'src'), { recursive: true });
    f.store.close();
    const reopened = await openStore(f.ws.storePath);
    t.after(() => reopened.close());
    const next = new OwnerService(reopened, f.ws, { registry: f.registry });
    t.after(() => next.stop());
    const status: any = await next.handle('prepare.status', { requestKey: key }, cli);
    assert.equal(status.facts.phase, 'interrupted');
    assert.equal(status.facts.resumeAvailable, true);
    const resume = receipt(f, status.facts.confirmation.resume);
    const submitted: any = await next.handle('prepare.resume', { requestKey: key, receiptId: resume.id }, cli);
    assert.equal(submitted.outcome, 'submitted');
    const final = await untilPrepared(next);
    assert.equal(final.facts.phase, 'prepared', JSON.stringify(final));
    assert.equal(final.facts.deadlineAt, accepted.facts.deadlineAt);
    assert.equal(final.facts.runDeadlineAt, accepted.facts.runDeadlineAt);
    assert.equal(
      reopened.ledger.readEvents({ after: 0, limit: 500 }).events.filter((e) => e.kind === 'snapshot-admitted').length,
      1,
      'resume admits no second capture',
    );
    assert.equal(reopened.ledger.getRun(final.facts.runId)!.envelope.createdAt, accepted.facts.acceptedAt);
  },
);

test(
  'real receipt spent after readonly check is an ordinary typed interruption, never acceptance or capture',
  needsStore,
  async (t) => {
    const f = await preparationFixture(t),
      service = new OwnerService(f.store, f.ws, { registry: f.registry });
    t.after(() => service.stop());
    const preview: any = await service.handle('configuration.preview', { requestKey: key }, cli),
      r = receipt(f, preview.confirmation);
    const check = ReceiptBook.prototype.check;
    let raced = false;
    t.mock.method(ReceiptBook.prototype, 'check', function (this: ReceiptBook, ...args: any[]) {
      const out = (check as any).apply(this, args);
      if (!raced && args[0] === r.id) {
        raced = true;
        this.consume(args[0], args[1], args[2]);
      }
      return out;
    });
    await assert.rejects(
      service.handle('prepare.accept', { requestKey: key, previewId: preview.id, receiptId: r.id }, cli),
      (e: any) => e?.code === 'sentinel.receipt.alreadyUsed',
    );
    const status: any = await service.handle('prepare.status', { requestKey: key }, cli);
    assert.equal(status.facts.phase, 'interrupted');
    assert.equal(status.facts.captured, false);
    assert.equal(service.busy, false);
    assert.equal(
      f.store.ledger.readEvents({ after: 0, limit: 500 }).events.some((e) => e.kind === 'snapshot-admitted'),
      false,
    );
  },
);
test('configuration changing during real capture is refused before snapshot admission', needsStore, async (t) => {
  const { ObjectStore } = await import('../dist/store/objects.js'),
    { writeFileSync } = await import('node:fs');
  const f = await preparationFixture(t),
    service = new OwnerService(f.store, f.ws, { registry: f.registry });
  t.after(() => service.stop());
  const preview: any = await service.handle('configuration.preview', { requestKey: key }, cli),
    r = receipt(f, preview.confirmation),
    put = ObjectStore.prototype.put;
  let changed = false;
  t.mock.method(ObjectStore.prototype, 'put', async function (this: InstanceType<typeof ObjectStore>, ...args: any[]) {
    const result = await (put as any).apply(this, args);
    if (!changed) {
      changed = true;
      const path = join(f.ws.path, '.farsight/sentinel/settings.json'),
        settings = JSON.parse(readFileSync(path, 'utf8'));
      settings.mandatoryRules.push('sentinel.test.changed');
      writeFileSync(path, JSON.stringify(settings));
    }
    return result;
  });
  await service.handle('prepare.accept', { requestKey: key, previewId: preview.id, receiptId: r.id }, cli);
  const status = await untilPrepared(service);
  assert.equal(status.facts.phase, 'failed');
  assert.equal(status.facts.captured, false);
  assert.equal(changed, true);
  assert.equal(
    f.store.ledger.readEvents({ after: 0, limit: 500 }).events.some((e) => e.kind === 'snapshot-admitted'),
    false,
  );
});
