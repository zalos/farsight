import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acceptReportImportFiles } from '../dist/evidence/accept.js';
import { readAcceptedReportImport, validateAcceptedImport, reportImportView } from '../dist/evidence/reader.js';
import { importOwnerContext } from '../dist/evidence/owner-context.js';
import { admissionRequest, verifyRetainedAudit, boundedAudit, AUDIT_BYTES } from '../dist/evidence/audit.js';
import { admit } from '../dist/policy/admission.js';
import { canonicalJson } from '../dist/store/ledger-json.js';
import { evidenceLedgerFor } from '../dist/store/evidence-binding.js';
import { openStore } from '../dist/store/index.js';
import { evidenceIo } from '../dist/evidence/test-hooks.js';
import { EVIDENCE_LIMITS } from '../dist/evidence/import-operation.js';
import { abandonReportImport, readAbandonedReportImport } from '../dist/evidence/abandon.js';
import { needsStore } from './snapshot-helpers.ts';
import { acceptFixture, timing, imported, confirm, report } from './evidence-acceptance-helpers.ts';

const fails = (e: any) => typeof e?.code === 'string' && e.code.startsWith('sentinel.');
test(
  'actual owner import: waiting has no writes; atomic six-role acceptance survives source deletion/reopen and lost acknowledgement without re-spend',
  needsStore,
  async (t) => {
    const s = await acceptFixture(t),
      seq = s.store.ledger.currentSequence();
    assert.equal(existsSync(s.repo), false);
    const preview = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing() });
    assert.equal(preview.status, 'awaiting-confirmation');
    assert.equal(s.store.ledger.currentSequence(), seq);
    const receiptId = confirm(s, preview.binding!);
    evidenceIo.after = (p) => {
      if (p === 'before-reply') throw new Error('original lost acknowledgement');
    };
    let result;
    try {
      result = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing(), receiptId });
    } finally {
      evidenceIo.after = null;
    }
    assert.equal(result.status, 'publicationUnknown', JSON.stringify(result));
    const record = evidenceLedgerFor(s.store).acceptance(preview.binding!.intent.input)!;
    assert.ok(record);
    assert.equal(record.identity.artifacts.length, 6);
    assert.equal(s.store.ledger.listOpenStages(500, { domain: 'evidence' }).length, 0);
    assert.equal(s.store.checkIntegrity().foreignKeyViolations, 0);
    const inspected = await s.store.inspect();
    assert.ok(inspected.ok, JSON.stringify(inspected.errors));
    assert.ok(inspected.reachable.includes(record.root));
    s.store.close();
    const store = await openStore(s.ws.storePath);
    t.after(() => store.close());
    const view = await readAcceptedReportImport(store, s.ws, record.candidateDigest, { timing: timing() });
    assert.equal(view.withheld, false);
    assert.ok(view.document);
    assert.ok(JSON.stringify(view).includes('external-rule'));
    const before = store.ledger.currentSequence(),
      retry = await acceptReportImportFiles(store, s.ws, s.ancestor, s.files, {
        timing: timing(),
        receiptId: 'does-not-exist',
      });
    assert.equal(retry.status, 'accepted');
    assert.equal((retry as any).reused, true);
    assert.equal(
      store.ledger.currentSequence(),
      before,
      'idempotency checks accepted data before any fresh receipt read/spend',
    );
    const db = new DatabaseSync(join(store.storePath, 'ledger.sqlite'), { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM evidence_acceptances').get()!.n, 1);
    } finally {
      db.close();
    }
  },
);

test(
  'current shared policy denies before reading an absent input; settings changes and actor-mismatched receipt refuse before spend',
  needsStore,
  async (t) => {
    const s = await acceptFixture(t);
    s.settings(['evidence.abandon']);
    const seq = s.store.ledger.currentSequence(),
      denied = await acceptReportImportFiles(
        s.store,
        s.ws,
        s.ancestor,
        { reportPath: '/missing-original-report', manifestPath: '/missing-original-manifest' },
        { timing: timing() },
      );
    assert.equal(denied.status, 'denied');
    assert.equal(s.store.ledger.currentSequence(), seq);
    s.settings(['evidence.import', 'evidence.abandon']);
    const preview = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing() });
    assert.ok(preview.binding);
    const receiptId = confirm(s, preview.binding, 'different-owner');
    await assert.rejects(
      () => acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing(), receiptId }),
      fails,
    );
    assert.equal(
      existsSync(join(s.book.directory, receiptId + '.spent')),
      false,
      'actor mismatch is refused before spending',
    );
    const genuine = confirm(s, preview.binding);
    s.settings(['evidence.import']);
    await assert.rejects(
      () => acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing(), receiptId: genuine }),
      fails,
    );
    assert.equal(existsSync(join(s.book.directory, genuine + '.spent')), false);
    assert.equal(s.store.ledger.currentSequence(), seq);
  },
);

test(
  'signal/deadline and actual commit rollback never manufacture acceptance or remove pending pins',
  needsStore,
  async (t) => {
    const s = await acceptFixture(t),
      preview = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing() });
    assert.ok(preview.binding);
    const receiptId = confirm(s, preview.binding),
      abort = new AbortController();
    evidenceIo.after = (p) => {
      if (p === 'before-commit') abort.abort();
    };
    let result;
    try {
      result = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, {
        timing: { signal: abort.signal },
        receiptId,
      });
    } finally {
      evidenceIo.after = null;
    }
    assert.ok(['spentNotPublished', 'publicationUnknown'].includes(result.status));
    assert.equal(evidenceLedgerFor(s.store).acceptance(preview.binding.intent.input), null);
    assert.equal(
      s.store.ledger.listOpenStages(500, { domain: 'evidence' }).length,
      1,
      'all pending pins remain after rollback',
    );
    const before = s.store.ledger.currentSequence();
    await assert.rejects(
      () =>
        acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, {
          timing: { signal: new AbortController().signal, deadlineAt: performance.now() },
        }),
      fails,
    );
    assert.equal(s.store.ledger.currentSequence(), before, 'the exact deadline is expired');
  },
);

test(
  'retained authority rejects changed issued/spent metadata and missing payload rather than crediting less',
  needsStore,
  async (t) => {
    const s = await acceptFixture(t),
      a = await imported(s),
      id = a.result.candidateDigest!,
      record = evidenceLedgerFor(s.store).acceptance(id)!;
    const issued = join(s.book.directory, a.receiptId + '.json'),
      original = readFileSync(issued);
    const r = JSON.parse(original.toString());
    r.actor.principal = 'different-owner';
    writeFileSync(issued, JSON.stringify(r), { mode: 0o600 });
    await assert.rejects(() => readAcceptedReportImport(s.store, s.ws, id, { timing: timing() }), fails);
    writeFileSync(issued, original, { mode: 0o600 });
    const spent = join(s.book.directory, a.receiptId + '.spent'),
      spentBytes = readFileSync(spent);
    writeFileSync(spent, 'not-a-time', { mode: 0o600 });
    await assert.rejects(() => readAcceptedReportImport(s.store, s.ws, id, { timing: timing() }), fails);
    writeFileSync(spent, spentBytes, { mode: 0o600 });
    const raw = record.identity.publication!.roles.raw,
      hex = raw.slice(7),
      folder = join(s.store.storePath, 'objects', 'sha256', hex.slice(0, 2));
    const names = (await import('node:fs')).readdirSync(folder).filter((n) => n.startsWith(hex + '.'));
    assert.ok(names.length);
    const files = names.map((n) => join(folder, n));
    const backup = files.map((p) => readFileSync(p));
    for (const p of files) unlinkSync(p);
    await assert.rejects(() => readAcceptedReportImport(s.store, s.ws, id, { timing: timing() }), fails);
    for (let n = 0; n < files.length; n++) writeFileSync(files[n]!, backup[n]!, { mode: 0o600 });
    assert.equal((await readAcceptedReportImport(s.store, s.ws, id, { timing: timing() })).withheld, false);
  },
);

async function pending(s: any, point = 'after-objects') {
  const preview = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing() });
  assert.ok(preview.binding);
  const receiptId = confirm(s, preview.binding);
  evidenceIo.after = (p) => {
    if (p === point) throw new Error('original interrupted import');
  };
  try {
    const result = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing(), receiptId });
    assert.equal(result.status, 'spentNotPublished');
    assert.ok(result.operationId);
    return { operationId: result.operationId, receiptId, binding: preview.binding };
  } finally {
    evidenceIo.after = null;
  }
}
async function reopen(s: any, t: any) {
  s.store.close();
  const store = await openStore(s.ws.storePath);
  t.after(() => {
    if (store.held) store.close();
  });
  return { ...s, store };
}

test(
  'explicit abandon releases only exact old pending pins without source proof or physical deletion; original full audit replays after restart',
  needsStore,
  async (t) => {
    let s = await acceptFixture(t);
    const p = await pending(s);
    const old = evidenceLedgerFor(s.store).operation(p.operationId)!;
    await assert.rejects(
      () => abandonReportImport(s.store, s.ws, p.operationId, { timing: timing() }),
      fails,
      'current epoch operation is never abandoned by this action',
    );
    s = await reopen(s, t);
    // Destroy only this fixture's source manifest bytes: abandoning unwanted pins must not require source proof.
    const manifestId = s.store.ledger.getSnapshot(s.snapshot.id)!.manifest,
      hex = manifestId.slice(7),
      folder = join(s.store.storePath, 'objects', 'sha256', hex.slice(0, 2));
    const file = (await import('node:fs')).readdirSync(folder).find((n) => n.startsWith(hex + '.'))!;
    const path = join(folder, file),
      backup = readFileSync(path);
    unlinkSync(path);
    const seq = s.store.ledger.currentSequence(),
      waiting = await abandonReportImport(s.store, s.ws, p.operationId, { timing: timing() });
    assert.equal(waiting.status, 'awaiting-confirmation');
    assert.equal(s.store.ledger.currentSequence(), seq);
    s.settings(['evidence.import']);
    const denied = await abandonReportImport(s.store, s.ws, p.operationId, { timing: timing() });
    assert.equal(denied.status, 'denied');
    assert.equal(s.store.ledger.listOpenStages(500, { domain: 'evidence' }).length, 1);
    s.settings(['evidence.import', 'evidence.abandon']);
    const preview = await abandonReportImport(s.store, s.ws, p.operationId, { timing: timing() });
    assert.ok(preview.binding);
    const receiptId = confirm(s, preview.binding!),
      raw = old.identity.publication!.roles.raw;
    const beforeRefs = s.store.ledger.objectsOf(raw); // Object bytes are deliberately not accepted yet.
    assert.equal(beforeRefs.length, 0);
    const rawHex = raw.slice(7),
      rawFolder = join(s.store.storePath, 'objects', 'sha256', rawHex.slice(0, 2));
    const rawNames = (await import('node:fs')).readdirSync(rawFolder).filter((n) => n.startsWith(rawHex + '.'));
    assert.ok(rawNames.length);
    const result = await abandonReportImport(s.store, s.ws, p.operationId, { timing: timing(), receiptId });
    assert.equal(result.status, 'abandoned', JSON.stringify(result));
    assert.equal(s.store.ledger.listOpenStages(500, { domain: 'evidence' }).length, 0);
    for (const n of rawNames)
      assert.ok(existsSync(join(rawFolder, n)), 'release never physically deletes object bytes');
    writeFileSync(path, backup, { mode: 0o600 });
    s = await reopen(s, t);
    const retained = readAbandonedReportImport(s.store, s.ws, p.operationId, timing());
    assert.equal(retained.status, 'abandoned');
    assert.ok(retained.auditBytes <= 16384);
    await assert.rejects(
      () => abandonReportImport(s.store, s.ws, p.operationId, { timing: timing(), receiptId }),
      fails,
      'terminal operation cannot consume again',
    );
  },
);

test(
  'abandon transaction rollback retains exact old pins and requires a fresh receipt; accepted operations cannot be abandoned',
  needsStore,
  async (t) => {
    let s = await acceptFixture(t);
    const p = await pending(s);
    s = await reopen(s, t);
    const preview = await abandonReportImport(s.store, s.ws, p.operationId, { timing: timing() }),
      receiptId = confirm(s, preview.binding!),
      abort = new AbortController();
    evidenceIo.after = (point) => {
      if (point === 'abandon-before-commit') abort.abort();
    };
    let result;
    try {
      result = await abandonReportImport(s.store, s.ws, p.operationId, { timing: { signal: abort.signal }, receiptId });
    } finally {
      evidenceIo.after = null;
    }
    assert.equal(
      result.status,
      'applicationUnknown',
      'canceled context cannot establish whether the transaction applied',
    );
    assert.equal(evidenceLedgerFor(s.store).operation(p.operationId)!.state, 'open');
    assert.equal(s.store.ledger.listOpenStages(500, { domain: 'evidence' }).length, 1);
    await assert.rejects(
      () => abandonReportImport(s.store, s.ws, p.operationId, { timing: timing(), receiptId }),
      fails,
      'spent receipt is not reconstructed after rollback',
    );
    const fresh = await abandonReportImport(s.store, s.ws, p.operationId, { timing: timing() }),
      done = await abandonReportImport(s.store, s.ws, p.operationId, {
        timing: timing(),
        receiptId: confirm(s, fresh.binding!),
      });
    assert.equal(done.status, 'abandoned');
    const a = await imported(s);
    s = await reopen(s, t);
    const op = evidenceLedgerFor(s.store).acceptance(a.result.candidateDigest!)!.operationId;
    await assert.rejects(() => abandonReportImport(s.store, s.ws, op, { timing: timing() }), fails);
  },
);

test(
  'six-role restart transfer keeps four original pins continuous, replaces receipt audit/root atomically, and accepts exactly once',
  needsStore,
  async (t) => {
    let s = await acceptFixture(t);
    const p = await pending(s);
    const old = evidenceLedgerFor(s.store).operation(p.operationId)!.identity;
    s = await reopen(s, t);
    const preview = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing() }),
      receiptId = confirm(s, preview.binding!);
    const db = new DatabaseSync(join(s.store.storePath, 'ledger.sqlite'));
    db.exec(`CREATE TRIGGER original_dual_pin_control AFTER INSERT ON staging_artifacts
    WHEN (SELECT count(*) FROM staging WHERE evidence_operation_id IS NOT NULL)=2 AND (SELECT count(*) FROM staging_artifacts WHERE stage_id=NEW.stage_id)=6
    BEGIN SELECT RAISE(ABORT,'original dual pin rollback'); END;`);
    db.close();
    const failed = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, {
      timing: timing(),
      receiptId,
      predecessorId: p.operationId,
    });
    assert.equal(failed.status, 'spentNotPublished');
    assert.equal(evidenceLedgerFor(s.store).operation(p.operationId)!.state, 'open');
    assert.equal(s.store.ledger.listOpenStages(500, { domain: 'evidence' }).length, 1);
    const remove = new DatabaseSync(join(s.store.storePath, 'ledger.sqlite'));
    remove.exec('DROP TRIGGER original_dual_pin_control');
    remove.close();
    const fresh = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing() }),
      done = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, {
        timing: timing(),
        receiptId: confirm(s, fresh.binding!),
        predecessorId: p.operationId,
      });
    assert.equal(done.status, 'accepted', JSON.stringify(done));
    const accepted = evidenceLedgerFor(s.store).acceptance(done.candidateDigest!)!;
    assert.equal(evidenceLedgerFor(s.store).operation(p.operationId)!.state, 'superseded');
    for (const role of ['raw', 'manifest', 'normalized', 'candidate'] as const)
      assert.equal(old.publication!.roles[role], accepted.identity.publication!.roles[role]);
    assert.notEqual(old.publication!.roles.admission, accepted.identity.publication!.roles.admission);
    assert.notEqual(old.publication!.root, accepted.root);
    assert.equal(s.store.ledger.listOpenStages(500, { domain: 'evidence' }).length, 0);
    assert.equal(
      (await readAcceptedReportImport(s.store, s.ws, done.candidateDigest!, { timing: timing() })).withheld,
      false,
    );
    // These are our old, unaccepted authority payload objects only. Pruning them must not erase the immutable old
    // full authority audit, which is deliberately retained in its operation rather than a growing blob chain.
    for (const id of [old.publication!.roles.admission, old.publication!.root]) {
      const h = id.slice(7),
        folder = join(s.store.storePath, 'objects', 'sha256', h.slice(0, 2));
      for (const n of (await import('node:fs')).readdirSync(folder).filter((n) => n.startsWith(h + '.')))
        unlinkSync(join(folder, n));
    }
    const retained = evidenceLedgerFor(s.store).operation(p.operationId)!.identity;
    verifyRetainedAudit(importOwnerContext(s.store, s.ws, timing()), {
      receipt: retained.receipt,
      receiptDigest: retained.receiptDigest,
      admission: retained.publication!.admission,
      intent: retained.intent,
      stateDigest: retained.stateDigest,
      policyRevision: retained.policyRevision,
    });
    assert.equal(
      (await readAcceptedReportImport(s.store, s.ws, done.candidateDigest!, { timing: timing() })).withheld,
      false,
    );
  },
);

for (const point of ['after-payload-reads', 'after-privacy'] as const)
  for (const mode of ['anchor', 'cancel'] as const)
    test(
      `final retained source fence after ${point} refuses late ${mode === 'anchor' ? 'retained-anchor corruption' : 'genuine cancellation'}`,
      needsStore,
      async (t) => {
        const s = await acceptFixture(t),
          a = await imported(s),
          abort = new AbortController(),
          context = importOwnerContext(s.store, s.ws, { signal: abort.signal });
        let handle;
        if (point === 'after-privacy') handle = await validateAcceptedImport(context, a.result.candidateDigest!);
        let changed = false;
        const triggers: string[] = [];
        evidenceIo.after = (p) => {
          if (p !== point || changed) return;
          changed = true;
          if (mode === 'cancel') abort.abort();
          else {
            const db = new DatabaseSync(join(s.store.storePath, 'ledger.sqlite'));
            try {
              // Explicit corruption of our fixture, not an allowed terminal lifecycle transition.
              for (const name of ['runs_plan_advance', 'runs_terminal']) {
                triggers.push(String(db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name)!.sql));
                db.exec('DROP TRIGGER ' + name);
              }
              db.prepare('UPDATE runs SET plan_revision=1 WHERE id=?').run(s.ancestor.runId);
            } finally {
              db.close();
            }
          }
        };
        try {
          await assert.rejects(
            () =>
              point === 'after-privacy'
                ? reportImportView(handle!)
                : validateAcceptedImport(context, a.result.candidateDigest!),
            fails,
          );
        } finally {
          evidenceIo.after = null;
          if (mode === 'anchor') {
            const db = new DatabaseSync(join(s.store.storePath, 'ledger.sqlite'));
            try {
              db.prepare('UPDATE runs SET plan_revision=? WHERE id=?').run(s.ancestor.revision, s.ancestor.runId);
              for (const sql of triggers) db.exec(sql);
            } finally {
              db.close();
            }
          }
        }
        assert.equal(changed, true);
        assert.equal(
          (await readAcceptedReportImport(s.store, s.ws, a.result.candidateDigest!, { timing: timing() })).withheld,
          false,
          'restoring this fixture anchor preserves the useful control',
        );
      },
    );

test(
  '64 genuine old pending operations remain retained; explicit receipt-bound abandon frees exactly one capacity slot',
  needsStore,
  async (t) => {
    let s = await acceptFixture(t);
    const pendingOps = [];
    for (let n = 0; n < EVIDENCE_LIMITS.openOperations; n++) pendingOps.push(await pending(s, 'after-stage'));
    assert.equal(s.store.ledger.listOpenStages(500, { domain: 'evidence' }).length, 64);
    s = await reopen(s, t);
    const full = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing() }),
      receiptId = confirm(s, full.binding!);
    const refused = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing(), receiptId });
    assert.equal(refused.status, 'spentNotPublished');
    assert.equal(s.store.ledger.listOpenStages(500, { domain: 'evidence' }).length, 64);
    const old = pendingOps[0]!.operationId,
      preview = await abandonReportImport(s.store, s.ws, old, { timing: timing() });
    assert.equal(preview.status, 'awaiting-confirmation');
    const abandoned = await abandonReportImport(s.store, s.ws, old, {
      timing: timing(),
      receiptId: confirm(s, preview.binding!),
    });
    assert.equal(abandoned.status, 'abandoned');
    assert.equal(s.store.ledger.listOpenStages(500, { domain: 'evidence' }).length, 63);
    const retained = readAbandonedReportImport(s.store, s.ws, old, timing());
    assert.ok(retained.auditBytes <= 16384);
    await pending(s, 'after-stage');
    assert.equal(s.store.ledger.listOpenStages(500, { domain: 'evidence' }).length, 64);
    for (const p of pendingOps.slice(1))
      assert.equal(
        evidenceLedgerFor(s.store).operation(p.operationId)!.state,
        'open',
        'no unrelated old operation is swept',
      );
    t.diagnostic(
      JSON.stringify({ oldRetained: 64, released: 1, replacement: 1, completeAuditBytes: retained.auditBytes }),
    );
  },
);

for (const field of ['principal'] as const)
  test(
    `retained admission rejects mismatched receipt actor ${field} even when issued bytes and genuine consumption agree`,
    needsStore,
    async (t) => {
      const s = await acceptFixture(t),
        preview = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing() }),
        binding = preview.binding!;
      const receiptId = confirm(s, binding, 'other-owner');
      const context = importOwnerContext(s.store, s.ws, timing()),
        now = new Date(),
        admitted = admit({ ...admissionRequest(context, binding, now), receipt: { book: s.book, id: receiptId } });
      assert.equal(admitted.record.outcome, 'admitted');
      assert.ok(admitted.receipt, 'shared admission consumed the actual issued receipt');
      assert.throws(
        () =>
          verifyRetainedAudit(context, {
            receipt: admitted.receipt!.receipt,
            receiptDigest: admitted.receipt!.digest,
            admission: admitted.record,
            intent: binding.intent,
            stateDigest: binding.stateDigest,
            policyRevision: binding.policyRevision,
          }),
        fails,
      );
    },
  );

test('the complete audit byte cap accepts exact16KiB and refuses +1 without truncating authority', () => {
  const overhead = Buffer.byteLength(canonicalJson({ original: '' }));
  boundedAudit({ original: 'x'.repeat(AUDIT_BYTES - overhead) });
  assert.throws(() => boundedAudit({ original: 'x'.repeat(AUDIT_BYTES - overhead + 1) }), fails);
});

test(
  'actual sixteen MiB raw payload accepts as six roles; raw +1 refuses before receipt or store writes',
  needsStore,
  async (t) => {
    const s = await acceptFixture(t),
      cap = 16 * 1024 * 1024,
      raw = Buffer.from(JSON.stringify(report)),
      exact = Buffer.alloc(cap, 0x20);
    raw.copy(exact);
    writeFileSync(s.files.reportPath, exact);
    const accepted = await imported(s),
      record = evidenceLedgerFor(s.store).acceptance(accepted.result.candidateDigest!)!;
    assert.equal(record.identity.artifacts.length, 6);
    assert.equal(s.store.ledger.objectsOf(record.identity.publication!.roles.raw)[0]!.rawSize, cap);
    writeFileSync(s.files.reportPath, Buffer.concat([exact, Buffer.from(' ')]));
    const before = s.store.ledger.currentSequence();
    const refused = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing() });
    assert.equal(refused.status, 'refused');
    assert.equal(refused.code, 'sentinel.import.tooLarge');
    assert.equal(s.store.ledger.currentSequence(), before);
  },
);

test(
  'receipt channel is a closed owner-cli schema and import refuses changed channel before spending',
  needsStore,
  async (t) => {
    const s = await acceptFixture(t),
      preview = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing() }),
      receiptId = confirm(s, preview.binding!),
      path = join(s.book.directory, receiptId + '.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.actor.channel = 'mcp';
    writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
    await assert.rejects(
      () => acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing(), receiptId }),
      fails,
    );
    assert.equal(existsSync(join(s.book.directory, receiptId + '.spent')), false);
  },
);

test(
  'identical imported and captured source bytes keep the stronger source floor and full source closure links',
  needsStore,
  async (t) => {
    const s = await acceptFixture(t, {
        extraFiles: {
          'captured-report.json': JSON.stringify(report),
          'captured-manifest.json': JSON.stringify((await import('./evidence-acceptance-helpers.ts')).manifest),
        },
      }),
      a = await imported(s),
      record = evidenceLedgerFor(s.store).acceptance(a.result.candidateDigest!)!;
    const roles = record.identity.publication!.roles;
    for (const id of [roles.raw, roles.manifest]) {
      assert.ok(record.identity.closure.includes(id));
      assert.equal(record.floors.find((f) => f.id === id)!.privacy, 'source');
      assert.ok(record.links.some((l) => l.parent === roles.candidate && l.child === id));
    }
    assert.equal(
      (await readAcceptedReportImport(s.store, s.ws, a.result.candidateDigest!, { timing: timing() })).withheld,
      false,
    );
  },
);

test(
  'genuine canceled source anchor yields an explicitly unassessed, wholly withheld import without claiming clean coverage',
  needsStore,
  async (t) => {
    const s = await acceptFixture(t, { canceled: true }),
      a = await imported(s);
    assert.equal(a.result.view!.withheld, true);
    assert.equal(a.result.view!.document, null);
    assert.equal(a.result.view!.limitation, 'privacy-unassessed-canceled-run');
    const later = await reopen(s, t);
    const view = await readAcceptedReportImport(later.store, later.ws, a.result.candidateDigest!, { timing: timing() });
    assert.equal(view.document, null);
    assert.equal(view.limitation, 'privacy-unassessed-canceled-run');
  },
);

test(
  'immutable stage metadata and stale abandon confirmation cannot spend a receipt or release another pin; foreign workspace cannot replay acceptance',
  needsStore,
  async (t) => {
    let s = await acceptFixture(t);
    const p = await pending(s, 'after-stage');
    s = await reopen(s, t);
    const preview = await abandonReportImport(s.store, s.ws, p.operationId, { timing: timing() }),
      receiptId = confirm(s, preview.binding!);
    const stage = s.store.ledger.listOpenStages(500, { domain: 'evidence' })[0]!.stageId,
      db = new DatabaseSync(join(s.store.storePath, 'ledger.sqlite'));
    const row = db
      .prepare('SELECT artifact_id FROM staging_artifacts WHERE stage_id=? ORDER BY artifact_id LIMIT 1')
      .get(stage)!;
    assert.throws(
      () =>
        db
          .prepare("UPDATE staging_artifacts SET schema='text/plain' WHERE stage_id=? AND artifact_id=?")
          .run(stage, row.artifact_id),
      /appendOnly/,
      'existing append-only stage guard refuses the mutation before any domain call',
    );
    assert.throws(
      () => db.prepare('UPDATE staging SET work_id=? WHERE stage_id=?').run(s.analysis.units[0]!.id, stage),
      /evidence is not an attempt/,
      'migration6 guards UPDATE domain cross-use too',
    );
    db.close();
    const otherReceipt = confirm(s, preview.binding!);
    assert.equal(
      (await abandonReportImport(s.store, s.ws, p.operationId, { timing: timing(), receiptId: otherReceipt })).status,
      'abandoned',
    );
    const seq = s.store.ledger.currentSequence();
    await assert.rejects(
      () => abandonReportImport(s.store, s.ws, p.operationId, { timing: timing(), receiptId }),
      fails,
    );
    assert.equal(existsSync(join(s.book.directory, receiptId + '.spent')), false);
    assert.equal(s.store.ledger.currentSequence(), seq);
    const a = await imported(s),
      foreign = await acceptFixture(t);
    await assert.rejects(
      () => readAcceptedReportImport(s.store, foreign.ws, a.result.candidateDigest!, { timing: timing() }),
      fails,
    );
  },
);

test(
  'unsupported retained adapter, forged operation column and unexpected payload edge refuse; exact original acceptance remains useful',
  needsStore,
  async (t) => {
    const s = await acceptFixture(t),
      a = await imported(s),
      record = evidenceLedgerFor(s.store).acceptance(a.result.candidateDigest!)!,
      path = join(s.store.storePath, 'ledger.sqlite');
    const db = new DatabaseSync(path),
      trigger = String(
        db.prepare("SELECT sql FROM sqlite_schema WHERE name='evidence_operations_identity'").get()!.sql,
      ),
      original = String(
        db.prepare('SELECT identity FROM evidence_operations WHERE id=?').get(record.operationId)!.identity,
      );
    db.exec('DROP TRIGGER evidence_operations_identity');
    try {
      const changed = JSON.parse(original);
      changed.publication.adapter.version = 'unsupported-future';
      db.prepare('UPDATE evidence_operations SET identity=? WHERE id=?').run(
        JSON.stringify(changed),
        record.operationId,
      );
      await assert.rejects(
        () => readAcceptedReportImport(s.store, s.ws, a.result.candidateDigest!, { timing: timing() }),
        fails,
      );
      db.prepare('UPDATE evidence_operations SET identity=?,source_id=? WHERE id=?').run(
        original,
        'other',
        record.operationId,
      );
      await assert.rejects(
        () => readAcceptedReportImport(s.store, s.ws, a.result.candidateDigest!, { timing: timing() }),
        fails,
      );
      db.prepare('UPDATE evidence_operations SET source_id=? WHERE id=?').run(s.ancestor.sourceId, record.operationId);
    } finally {
      db.exec(trigger);
      db.close();
    }
    const raw = record.identity.publication!.roles.raw,
      child = record.identity.publication!.roles.manifest,
      edge = new DatabaseSync(path);
    edge.prepare('INSERT INTO artifact_links(parent_id,child_id) VALUES (?,?)').run(raw, child);
    edge.close();
    await assert.rejects(
      () => readAcceptedReportImport(s.store, s.ws, a.result.candidateDigest!, { timing: timing() }),
      fails,
    );
    const clean = new DatabaseSync(path),
      remove = clean
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='artifact_links' AND sql LIKE '%DELETE%'",
        )
        .all()
        .map((r) => String(r.sql));
    for (const r of clean
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='artifact_links' AND sql LIKE '%DELETE%'",
      )
      .all())
      clean.exec('DROP TRIGGER ' + r.name);
    clean.prepare('DELETE FROM artifact_links WHERE parent_id=? AND child_id=?').run(raw, child);
    for (const sql of remove) clean.exec(sql);
    clean.close();
    assert.equal(
      (await readAcceptedReportImport(s.store, s.ws, a.result.candidateDigest!, { timing: timing() })).withheld,
      false,
    );
  },
);

test(
  'actual concurrent candidates bind the same prior head; only one atomically accepts and the spent loser retains its pending pins',
  needsStore,
  async (t) => {
    const s = await acceptFixture(t),
      other = { ...s.files, reportPath: join(s.dir, 'other-original-report.json') };
    writeFileSync(
      other.reportPath,
      JSON.stringify({ ...report, runs: [{ tool: { driver: { name: 'second-original-producer' } }, results: [] }] }),
    );
    const a = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing() }),
      b = await acceptReportImportFiles(s.store, s.ws, s.ancestor, other, { timing: timing() });
    assert.ok(a.binding && b.binding);
    assert.notEqual(a.binding.intent.input, b.binding.intent.input);
    const receiptA = confirm(s, a.binding),
      receiptB = confirm(s, b.binding),
      results = await Promise.all([
        acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing(), receiptId: receiptA }),
        acceptReportImportFiles(s.store, s.ws, s.ancestor, other, { timing: timing(), receiptId: receiptB }),
      ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['accepted', 'spentNotPublished']);
    assert.equal(s.store.ledger.listOpenStages(500, { domain: 'evidence' }).length, 1);
    const accepted = results.find((r) => r.status === 'accepted')!,
      lost = results.find((r) => r.status === 'spentNotPublished')!;
    assert.ok(evidenceLedgerFor(s.store).acceptance(accepted.candidateDigest!));
    assert.equal(evidenceLedgerFor(s.store).acceptance(lost.candidateDigest!), null);
    assert.ok(
      existsSync(join(s.book.directory, receiptA + '.spent')) &&
        existsSync(join(s.book.directory, receiptB + '.spent')),
    );
    assert.equal(s.store.checkIntegrity().foreignKeyViolations, 0);
  },
);

test(
  'genuine owner loss after durable object writes returns uncertainty and cannot publish with its old permit',
  needsStore,
  async (t) => {
    const s = await acceptFixture(t),
      preview = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing() }),
      receiptId = confirm(s, preview.binding!);
    evidenceIo.after = (p) => {
      if (p === 'after-objects') s.store.close();
    };
    let result;
    try {
      result = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing(), receiptId });
    } finally {
      evidenceIo.after = null;
    }
    assert.equal(result.status, 'publicationUnknown');
    const current = await reopen(s, t);
    assert.equal(evidenceLedgerFor(current.store).acceptance(preview.binding!.intent.input), null);
    assert.equal(current.store.ledger.listOpenStages(500, { domain: 'evidence' }).length, 1);
    const fresh = await acceptReportImportFiles(current.store, current.ws, current.ancestor, current.files, {
      timing: timing(),
    });
    assert.equal(fresh.status, 'awaiting-confirmation');
    await assert.rejects(
      () =>
        acceptReportImportFiles(current.store, current.ws, current.ancestor, current.files, {
          timing: timing(),
          receiptId,
        }),
      fails,
      'old epoch spend cannot be reconstructed',
    );
  },
);
