import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { admit, admitRequiringReceipt } from '../dist/policy/admission.js';
import { ReceiptBook, isConsumedReceipt } from '../dist/policy/receipts.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { PreparationController } from '../dist/service/preparation-controller.js';
import { preparationFixture } from './helpers/preparation-fixture.ts';
import { needsStore } from './snapshot-helpers.ts';
import { resolvePreparationInputs, preparationTerms } from '../dist/service/preparation-inputs.js';
import { adoptWorkspaceSettings, OWNER } from '../dist/service/local.js';
const by = { principal: 'agent' as const, channel: 'local-service' as const };
const code = (s: string) => (e: any) => e?.code === s;
for (const explicit of [false, true])
  test(
    `stricter internal receipt path spends once for genuine ${explicit ? 'explicit confirmation' : 'init non-confirming'} capture grant`,
    needsStore,
    async (t) => {
      const f = await preparationFixture(t);
      if (explicit) {
        const path = join(f.ws.path, '.farsight/sentinel/settings.json'),
          settings = JSON.parse(readFileSync(path, 'utf8'));
        settings.grants[0].confirm = 'always';
        writeFileSync(path, JSON.stringify(settings));
        assert.equal(adoptWorkspaceSettings(f.ws, { confirm: true, now: new Date() }).outcome, 'prepared');
      }
      const controller = new PreparationController(
          f.store,
          f.ws,
          f.registry,
          () => false,
          () => {},
        ),
        preview: any = controller.preview({ requestKey: 'receipt_admission_fixture' }, by),
        binding = preview.confirmation;
      const inputs = resolvePreparationInputs(f.store, {
          workspace: f.ws.path,
          trustDir: f.ws.trustDir,
          registry: f.registry,
        }),
        { policy } = preparationTerms(f.store, inputs, () => {}),
        book = new ReceiptBook(join(f.ws.trustDir, 'receipts')),
        now = new Date();
      const req = {
        intent: binding.intent,
        stateDigest: binding.stateDigest,
        policy,
        requestedBy: OWNER,
        now,
        capability: () => ({ available: true, detail: 'local' }),
        credential: () => ({ basis: 'local-only' as const, detail: 'local' }),
      };
      assert.equal(admit(req).record.outcome, explicit ? 'awaiting-confirmation' : 'admitted');
      assert.equal(admitRequiringReceipt(req).record.outcome, 'awaiting-confirmation');
      const r = issueReceipt(book, OWNER, binding, { now, ttlMs: 600000 });
      if (!explicit) {
        const ordinary = admit({ ...req, receipt: { book, id: r.id } });
        assert.equal(ordinary.record.outcome, 'admitted');
        assert.equal(ordinary.receipt, null, 'public default preserves its old no-spend semantics');
        book.check(r.id, binding, now);
      }
      const allowed = admitRequiringReceipt({ ...req, receipt: { book, id: r.id } });
      assert.ok(isConsumedReceipt(allowed.receipt));
      assert.equal(allowed.record.receipt, allowed.receipt!.digest);
      assert.throws(
        () => admitRequiringReceipt({ ...req, receipt: { book, id: r.id } }),
        code('sentinel.receipt.alreadyUsed'),
      );
    },
  );
test(
  'stricter admission preserves verdict order and denies unavailable, mismatched or expired receipt without spending',
  needsStore,
  async (t) => {
    const f = await preparationFixture(t),
      controller = new PreparationController(
        f.store,
        f.ws,
        f.registry,
        () => false,
        () => {},
      ),
      preview: any = controller.preview({ requestKey: 'receipt_denial_fixture_1' }, by),
      binding = preview.confirmation;
    const input = resolvePreparationInputs(f.store, {
        workspace: f.ws.path,
        trustDir: f.ws.trustDir,
        registry: f.registry,
      }),
      { policy } = preparationTerms(f.store, input, () => {}),
      book = new ReceiptBook(join(f.ws.trustDir, 'receipts')),
      now = new Date(),
      r = issueReceipt(book, OWNER, binding, { now, ttlMs: 1000 });
    let calls: string[] = [];
    const req = {
      intent: binding.intent,
      stateDigest: binding.stateDigest,
      policy,
      requestedBy: OWNER,
      now,
      receipt: { book, id: r.id },
      capability: () => {
        calls.push('capability');
        return { available: true, detail: 'local' };
      },
      credential: () => {
        calls.push('credential');
        return { basis: 'local-only' as const, detail: 'local' };
      },
    };
    const before = readdirSync(join(f.ws.trustDir, 'receipts')).sort();
    const denied = admitRequiringReceipt({ ...req, requestedBy: { principal: 'agent', channel: 'mcp' } });
    assert.equal(denied.record.outcome, 'denied');
    assert.deepEqual(calls, []);
    const unavailable = admitRequiringReceipt({
      ...req,
      capability: () => {
        calls.push('capability');
        return { available: false, detail: 'not available' };
      },
    });
    assert.equal(unavailable.record.outcome, 'denied');
    assert.deepEqual(calls, ['capability', 'credential']);
    book.check(r.id, binding, now);
    assert.throws(
      () => admitRequiringReceipt({ ...req, stateDigest: 'sha256:' + '0'.repeat(64) }),
      code('sentinel.receipt.mismatch'),
    );
    assert.throws(
      () => admitRequiringReceipt({ ...req, now: new Date(now.getTime() + 1000) }),
      code('sentinel.receipt.expired'),
    );
    assert.deepEqual(readdirSync(join(f.ws.trustDir, 'receipts')).sort(), before);
    book.check(r.id, binding, now);
  },
);
