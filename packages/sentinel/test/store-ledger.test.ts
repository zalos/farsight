import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openLedger, type Ledger } from '../dist/store/ledger.js';
import { LedgerError, MAX_ARTIFACT_BYTES } from '../dist/store/store-types.js';
import {
  FakeObjects, FakeOwner, OBJECTS, attemptEnvelope, identityReceipt, runEnvelope, scratch, sha, unstoredReceipt,
  workEnvelope,
} from './store-helpers.ts';

const code = (c: string) => (e: unknown) => e instanceof LedgerError && e.code === c;
const W1 = { id: 'work-pattern-api', revision: 1 };
const W2 = { id: 'work-pattern-api', revision: 2 };

async function setup(t: { after(fn: () => void): void }, opts: Parameters<typeof openLedger>[1] = {}) {
  const dir = scratch(t);
  const owner = new FakeOwner(dir, 'epoch-1');
  const ledger = await openLedger(owner, { objects: OBJECTS, ...opts });
  t.after(() => ledger.close());
  ledger.createRun(runEnvelope(owner.epoch) as never);
  ledger.createWork(workEnvelope(owner.epoch) as never);
  return { dir, owner, ledger };
}

function start(ledger: Ledger, epoch: string, id: string, ordinal: number, work = W1, supersede = false) {
  return ledger.startAttempt(attemptEnvelope(epoch, { id, ordinal, work }) as never, { supersede });
}

/** Stage one output (and optionally a linked child), the way a coordinator would before writing bytes. */
function stageAndPublish(ledger: Ledger, work: typeof W1, attemptId: string, stageId: string, text: string,
  opts: { child?: string; privacy?: 'metadata' | 'source-derived' | 'source'; idempotency?: { clientId: string; key: string } } = {}) {
  const out = identityReceipt(text);
  const staged = [{ id: out.id, schema: 'sentinel-observation/draft-1', privacy: opts.privacy ?? 'source-derived',
    links: opts.child ? [sha(opts.child)] : [] }];
  const receipts = [out];
  if (opts.child) {
    staged.push({ id: sha(opts.child), schema: 'text/plain', privacy: 'source', links: [] });
    receipts.push(identityReceipt(opts.child));
  }
  ledger.registerStaging(stageId, staged, { work, attemptId });
  return ledger.publish({ work, attemptId, stageId, receipts, outputs: [out.id], endedAt: '2026-10-21T12:01:00Z',
    idempotency: opts.idempotency });
}

function raw(ledger: Ledger) {
  return new DatabaseSync(ledger.path, { timeout: 0 });
}

test('a publication is accepted once, atomically, with its references and event', async t => {
  const { ledger } = await setup(t);
  start(ledger, 'epoch-1', 'att-1', 1);
  const receipt = stageAndPublish(ledger, W1, 'att-1', 'stage-1', 'finding one', { child: 'quoted bytes' });
  assert.match(receipt.resultDigest, /^sha256:[0-9a-f]{64}$/);
  const pub = ledger.getPublication(W1)!;
  assert.equal(pub.attemptId, 'att-1');
  assert.deepEqual(pub.outputs.map(o => o.id), [sha('finding one')]);
  assert.equal(ledger.getWork(W1)!.state, 'published');
  assert.equal(ledger.getAttempt('att-1')!.state, 'succeeded');
  const snap = ledger.gcSnapshot();
  assert.deepEqual(snap.staged, []);
  assert.deepEqual(snap.referenced, [sha('finding one'), sha('quoted bytes')].sort());
  assert.deepEqual(snap.links, [[sha('finding one'), sha('quoted bytes')]]);
  assert.throws(() => ledger.publish({ work: W1, attemptId: 'att-1', stageId: 'stage-1', receipts: [identityReceipt('x')],
    outputs: [], endedAt: '2026-10-21T12:02:00Z' }), code('sentinel.store.alreadyPublished'));
  assert.deepEqual(ledger.checkIntegrity(), { integrity: 'ok', foreignKeyViolations: 0 });
});

test('two revisions of one work ID publish independently; revisions append without gaps', async t => {
  const { ledger } = await setup(t);
  start(ledger, 'epoch-1', 'att-1', 1);
  stageAndPublish(ledger, W1, 'att-1', 'stage-1', 'rev one');
  ledger.createRun(runEnvelope('epoch-1', { id: 'run-2', parentId: 'run-1' }) as never);
  assert.throws(() => ledger.createWork(workEnvelope('epoch-1', { runId: 'run-2', revision: 3 }) as never),
    code('sentinel.store.conflict'));
  ledger.createWork(workEnvelope('epoch-1', { runId: 'run-2', revision: 2 }) as never);
  start(ledger, 'epoch-1', 'att-2', 1, W2);
  stageAndPublish(ledger, W2, 'att-2', 'stage-2', 'rev two');
  assert.equal(ledger.getPublication(W1)!.attemptId, 'att-1');
  assert.equal(ledger.getPublication(W2)!.attemptId, 'att-2');
  assert.equal(ledger.getWork(W1)!.runId, 'run-1');
  assert.equal(ledger.getWork(W2)!.runId, 'run-2');
});

test('cross-revision attempt references are refused by the fence and by the database itself', async t => {
  const { ledger } = await setup(t);
  ledger.createWork(workEnvelope('epoch-1', { revision: 2 }) as never);
  start(ledger, 'epoch-1', 'att-1', 1, W1);
  start(ledger, 'epoch-1', 'att-2', 1, W2);
  ledger.registerStaging('stage-1', [{ id: sha('a'), schema: 'text/plain', privacy: 'metadata' }], { work: W1, attemptId: 'att-1' });
  assert.throws(() => ledger.publish({ work: W2, attemptId: 'att-1', stageId: 'stage-1', receipts: [identityReceipt('a')],
    outputs: [sha('a')], endedAt: '2026-10-21T12:01:00Z' }), code('sentinel.store.notActiveAttempt'));

  const db = raw(ledger);
  t.after(() => db.close());
  const ev = Number(Object.values(db.prepare('SELECT max(sequence) FROM events').get()!)[0]);
  assert.throws(() => db.prepare(`INSERT INTO publications (work_id, work_revision, attempt_id, result_digest,
    coordinator_epoch, accepted_at, sequence) VALUES ('work-pattern-api', 2, 'att-1', ?, 'epoch-1', 'x', ?)`)
    .run(sha('r'), ev), /FOREIGN KEY/);
  db.exec('BEGIN');
  db.exec("UPDATE work_units SET active_attempt_id = 'att-1' WHERE id = 'work-pattern-api' AND revision = 2");
  assert.throws(() => db.exec('COMMIT'), /FOREIGN KEY/);
  if (db.isTransaction) db.exec('ROLLBACK');
  assert.equal(ledger.getWork(W2)!.activeAttemptId, 'att-2');
  assert.deepEqual(ledger.checkIntegrity(), { integrity: 'ok', foreignKeyViolations: 0 });
});

test('a duplicate publication is refused by the unique key, including a late second attempt', async t => {
  const { ledger } = await setup(t);
  start(ledger, 'epoch-1', 'att-1', 1);
  stageAndPublish(ledger, W1, 'att-1', 'stage-1', 'first');
  assert.throws(() => start(ledger, 'epoch-1', 'att-2', 2), code('sentinel.store.wrongState'));
  const db = raw(ledger);
  t.after(() => db.close());
  // Bypass the fence entirely: the database alone refuses a second accepted publication for the revision.
  db.exec('PRAGMA foreign_keys = OFF');
  assert.throws(() => db.prepare(`INSERT INTO publications (work_id, work_revision, attempt_id, result_digest,
    coordinator_epoch, accepted_at, sequence) VALUES ('work-pattern-api', 1, 'att-other', ?, 'epoch-1', 'x', 999)`)
    .run(sha('r')), /UNIQUE/);
  assert.throws(() => db.exec('DELETE FROM publications'), /appendOnly/);
  assert.throws(() => db.exec('DELETE FROM events'), /appendOnly/);
});

test('a superseded attempt cannot publish in the same epoch', async t => {
  const { ledger } = await setup(t);
  start(ledger, 'epoch-1', 'att-1', 1);
  ledger.registerStaging('stage-old', [{ id: sha('old'), schema: 'text/plain', privacy: 'metadata' }],
    { work: W1, attemptId: 'att-1' });
  assert.throws(() => start(ledger, 'epoch-1', 'att-2', 2), code('sentinel.store.wrongState'));
  const s = start(ledger, 'epoch-1', 'att-2', 2, W1, true);
  assert.equal(s.superseded, 'att-1');
  assert.equal(ledger.getAttempt('att-1')!.state, 'interrupted');
  assert.throws(() => ledger.publish({ work: W1, attemptId: 'att-1', stageId: 'stage-old', receipts: [identityReceipt('old')],
    outputs: [sha('old')], endedAt: '2026-10-21T12:01:00Z' }), code('sentinel.store.notActiveAttempt'));
  assert.throws(() => ledger.registerStaging('stage-late', [{ id: sha('late'), schema: 'text/plain', privacy: 'metadata' }],
    { work: W1, attemptId: 'att-1' }), code('sentinel.store.notActiveAttempt'));
  // The new attempt cannot borrow the superseded attempt's stage either.
  assert.throws(() => ledger.publish({ work: W1, attemptId: 'att-2', stageId: 'stage-old', receipts: [identityReceipt('old')],
    outputs: [sha('old')], endedAt: '2026-10-21T12:01:00Z' }), code('sentinel.store.stagingMismatch'));
  stageAndPublish(ledger, W1, 'att-2', 'stage-new', 'winner');
  assert.equal(ledger.getPublication(W1)!.attemptId, 'att-2');
  ledger.abortStaging('stage-old');
  assert.deepEqual(ledger.gcSnapshot().staged, []);
});

test('a stale epoch and a released owner are refused inside every mutation', async t => {
  const { dir, owner, ledger } = await setup(t);
  start(ledger, 'epoch-1', 'att-1', 1);
  ledger.registerStaging('stage-1', [{ id: sha('x'), schema: 'text/plain', privacy: 'metadata' }], { work: W1, attemptId: 'att-1' });

  owner.held = false;
  assert.throws(() => ledger.createRun(runEnvelope('epoch-1', { id: 'run-9' }) as never), code('sentinel.store.ownerNotHeld'));
  owner.held = true;

  // A successor coordinator opens the same store under a new epoch: the first ledger is fenced off.
  const next = new FakeOwner(dir, 'epoch-2');
  const successor = await openLedger(next, { objects: OBJECTS });
  t.after(() => successor.close());
  assert.throws(() => ledger.publish({ work: W1, attemptId: 'att-1', stageId: 'stage-1', receipts: [identityReceipt('x')],
    outputs: [sha('x')], endedAt: '2026-10-21T12:01:00Z' }), code('sentinel.store.staleEpoch'));
  assert.throws(() => ledger.createRun(runEnvelope('epoch-1', { id: 'run-9' }) as never), code('sentinel.store.staleEpoch'));
  // The successor cannot accept the old epoch's attempt or record work under the old epoch either.
  assert.throws(() => successor.publish({ work: W1, attemptId: 'att-1', stageId: 'stage-1', receipts: [identityReceipt('x')],
    outputs: [sha('x')], endedAt: '2026-10-21T12:01:00Z' }), code('sentinel.store.staleEpoch'));
  assert.throws(() => successor.createRun(runEnvelope('epoch-1', { id: 'run-9' }) as never), code('sentinel.store.staleEpoch'));
  assert.equal(successor.getPublication(W1), null);

  await assert.rejects(openLedger(new FakeOwner(dir, 'epoch-1')), code('sentinel.store.staleEpoch'));
  await assert.rejects(openLedger(new FakeOwner(dir, 'epoch-3', 'store-other')), code('sentinel.store.storeMismatch'));

  next.release();
  assert.ok(successor.closed, 'releasing the owner closes its registered ledger');
  assert.throws(() => successor.readEvents(), code('sentinel.store.closed'));
});

test('client idempotency replays the same result and refuses a conflicting reuse', async t => {
  const { ledger } = await setup(t);
  const key = { clientId: 'cli-1', key: 'req-1' };
  const env = runEnvelope('epoch-1', { id: 'run-7' }) as never;
  const first = ledger.createRun(env, { idempotency: key });
  assert.deepEqual(ledger.createRun(env, { idempotency: key }), first);
  assert.throws(() => ledger.createRun(runEnvelope('epoch-1', { id: 'run-8' }) as never, { idempotency: key }),
    code('sentinel.store.idempotencyConflict'));
  assert.throws(() => ledger.setRunState('run-7', 'pausing', { idempotency: key }), code('sentinel.store.idempotencyConflict'));
  assert.equal(ledger.readEvents({ runId: 'run-7' }).events.length, 1);

  start(ledger, 'epoch-1', 'att-1', 1);
  const pubKey = { clientId: 'cli-1', key: 'pub-1' };
  const receipt = stageAndPublish(ledger, W1, 'att-1', 'stage-1', 'out', { idempotency: pubKey });
  const before = ledger.readEvents({ limit: 500 }).events.length;
  const out = identityReceipt('out');
  assert.deepEqual(ledger.publish({ work: W1, attemptId: 'att-1', stageId: 'stage-1', receipts: [out], outputs: [out.id],
    endedAt: '2026-10-21T12:01:00Z', idempotency: pubKey }), receipt);
  assert.equal(ledger.readEvents({ limit: 500 }).events.length, before);
});

test('events are ordered, paged by cursor, bounded and filterable by run', async t => {
  const { ledger } = await setup(t);
  ledger.createRun(runEnvelope('epoch-1', { id: 'run-2', parentId: 'run-1' }) as never);
  ledger.setRunState('run-2', 'pausing');
  ledger.setRunState('run-2', 'paused');
  const all: number[] = [];
  let cursor = 0;
  for (;;) {
    const page = ledger.readEvents({ after: cursor, limit: 2 });
    all.push(...page.events.map(e => e.sequence));
    cursor = page.cursor;
    if (!page.more) break;
  }
  assert.deepEqual(all, [...all].sort((a, b) => a - b));
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(ledger.readEvents().events.map(e => e.kind),
    ['epoch-opened', 'run-created', 'work-created', 'run-created', 'run-state', 'run-state']);
  assert.deepEqual(ledger.readEvents({ runId: 'run-2' }).events.map(e => e.payload),
    [{ state: 'running' }, { from: 'running', to: 'pausing' }, { from: 'pausing', to: 'paused' }]);
  assert.equal(ledger.readEvents({ after: cursor }).events.length, 0);
  assert.throws(() => ledger.readEvents({ limit: 501 }), code('sentinel.store.invalidInput'));
  assert.throws(() => ledger.setRunState('run-2', 'completed', { outcome: 'complete-coverage' }), code('sentinel.store.wrongState'));
});

test('artifact handoff failures never leave an accepted reference to an absent blob', async t => {
  let missing = false;
  let failCommit = false;
  const { ledger } = await setup(t, {
    objects: { verify: r => (missing ? null : OBJECTS.verify(r)) },
    failpoint: p => {
      if (p === 'staging:before-commit' && failCommit) throw new Error('disk full writing staging');
      if (p === 'publish:before-commit' && failCommit) throw new Error('disk full at commit');
    },
  });
  start(ledger, 'epoch-1', 'att-1', 1);
  const out = identityReceipt('payload');
  const staged = [{ id: out.id, schema: 'text/plain', privacy: 'source' as const }];
  const publish = () => ledger.publish({ work: W1, attemptId: 'att-1', stageId: 'stage-1', receipts: [out],
    outputs: [out.id], endedAt: '2026-10-21T12:01:00Z' });

  failCommit = true;
  assert.throws(() => ledger.registerStaging('stage-1', staged, { work: W1, attemptId: 'att-1' }), /disk full/);
  assert.deepEqual(ledger.gcSnapshot().staged, [], 'a failed staging commit records nothing');
  failCommit = false;
  ledger.registerStaging('stage-1', staged, { work: W1, attemptId: 'att-1' });

  missing = true; // the object store's write failed: its bytes never became durable
  assert.throws(publish, code('sentinel.store.objectMissing'));
  missing = false;

  failCommit = true; // bytes are durable but the ledger commit fails
  assert.throws(publish, /disk full/);
  failCommit = false;

  for (const s of [ledger.gcSnapshot()]) {
    assert.deepEqual(s.referenced, []);
    assert.deepEqual(s.objects, []);
    assert.deepEqual(s.staged, [out.id], 'the possibly written bytes stay pinned until accepted or aborted');
  }
  assert.equal(ledger.getPublication(W1), null);
  assert.equal(ledger.getWork(W1)!.state, 'running');

  assert.throws(() => ledger.publish({ work: W1, attemptId: 'att-1', stageId: 'stage-1',
    receipts: [out, identityReceipt('unstaged')], outputs: [out.id], endedAt: '2026-10-21T12:01:00Z' }),
  code('sentinel.store.stagingMismatch'));
  assert.throws(() => ledger.publish({ work: W1, attemptId: 'att-1', stageId: 'stage-1',
    receipts: [{ ...out, rawSize: MAX_ARTIFACT_BYTES + 1, storedSize: MAX_ARTIFACT_BYTES + 1 }], outputs: [out.id],
    endedAt: '2026-10-21T12:01:00Z' }), code('sentinel.store.invalidInput'));
  assert.throws(() => ledger.publish({ work: W1, attemptId: 'att-1', stageId: 'stage-1',
    receipts: [{ ...out, storedDigest: sha('other') }], outputs: [out.id], endedAt: '2026-10-21T12:01:00Z' }),
  code('sentinel.store.invalidInput'));

  publish();
  assert.deepEqual(ledger.gcSnapshot().referenced, [out.id]);
  assert.deepEqual(ledger.objectsOf(out.id), [out]);
});

test('the GC snapshot reports accepted, staged, report and active roots at one sequence', async t => {
  const { ledger } = await setup(t);
  start(ledger, 'epoch-1', 'att-1', 1);
  stageAndPublish(ledger, W1, 'att-1', 'stage-1', 'parent', { child: 'child' });
  ledger.createWork(workEnvelope('epoch-1', { id: 'work-other', influenceManifest: sha('manifest') }) as never);
  start(ledger, 'epoch-1', 'att-o', 1, { id: 'work-other', revision: 1 });
  ledger.registerStaging('stage-open', [{ id: sha('in flight'), schema: 'text/plain', privacy: 'metadata' }],
    { work: { id: 'work-other', revision: 1 }, attemptId: 'att-o' });
  ledger.pinReport('report-1', 'run-1', [sha('parent')]);
  assert.throws(() => ledger.pinReport('report-2', 'run-1', [sha('never stored')]), code('sentinel.store.conflict'));
  const snap = ledger.gcSnapshot();
  assert.equal(snap.sequence, ledger.readEvents({ limit: 500 }).events.at(-1)!.sequence);
  assert.deepEqual(snap.referenced, [sha('child'), sha('parent')].sort());
  assert.deepEqual(snap.staged, [sha('in flight')]);
  assert.deepEqual(snap.reports, [sha('parent')]);
  assert.ok(snap.active.includes(sha('manifest')), 'unfinished work pins its influence manifest');
  assert.ok(snap.active.includes('sha256:8888888888888888888888888888888888888888888888888888888888888888'),
    'a running attempt pins its invocation');
  assert.deepEqual(snap.links, [[sha('parent'), sha('child')]]);
  assert.equal(snap.objects.length, 2);
  assert.equal(snap.storeId, 'store-1');
  assert.equal(snap.complete, true);
  ledger.assertSnapshotCurrent(snap);
  assert.throws(() => ledger.assertSnapshotCurrent({ ...snap, storeId: 'store-other' }), code('sentinel.store.snapshotStale'));
  ledger.abortStaging('stage-open');
  assert.throws(() => ledger.assertSnapshotCurrent(snap), code('sentinel.store.snapshotStale'),
    'a root change after the snapshot invalidates it');
});

test('an artifact privacy floor rises with a stronger reference and never falls', async t => {
  const { ledger } = await setup(t);
  start(ledger, 'epoch-1', 'att-1', 1);
  stageAndPublish(ledger, W1, 'att-1', 'stage-1', 'shared bytes', { privacy: 'source' });
  ledger.createWork(workEnvelope('epoch-1', { id: 'work-b' }) as never);
  start(ledger, 'epoch-1', 'att-b', 1, { id: 'work-b', revision: 1 });
  stageAndPublish(ledger, { id: 'work-b', revision: 1 }, 'att-b', 'stage-b', 'shared bytes', { privacy: 'metadata' });
  assert.equal(ledger.getPublication({ id: 'work-b', revision: 1 })!.outputs[0]!.privacy, 'metadata');
  const db = raw(ledger);
  t.after(() => db.close());
  const floor = () => Object.values(db.prepare('SELECT privacy_floor FROM artifacts WHERE id = ?').get(sha('shared bytes'))!)[0];
  assert.equal(floor(), 'source');
  assert.throws(() => db.prepare("UPDATE artifacts SET privacy_floor = 'metadata' WHERE id = ?").run(sha('shared bytes')),
    /privacyDowngrade/);
});

test('a revoked run refuses publication, and a restart reads what was committed', async t => {
  const { dir, owner, ledger } = await setup(t);
  start(ledger, 'epoch-1', 'att-1', 1);
  stageAndPublish(ledger, W1, 'att-1', 'stage-1', 'kept');
  ledger.createWork(workEnvelope('epoch-1', { id: 'work-c' }) as never);
  start(ledger, 'epoch-1', 'att-c', 1, { id: 'work-c', revision: 1 });
  ledger.registerStaging('stage-c', [{ id: sha('late'), schema: 'text/plain', privacy: 'metadata' }],
    { work: { id: 'work-c', revision: 1 }, attemptId: 'att-c' });
  ledger.setRunState('run-1', 'canceling');
  assert.throws(() => ledger.publish({ work: { id: 'work-c', revision: 1 }, attemptId: 'att-c', stageId: 'stage-c',
    receipts: [identityReceipt('late')], outputs: [sha('late')], endedAt: '2026-10-21T12:01:00Z' }),
  code('sentinel.store.wrongState'));
  ledger.endAttempt({ work: { id: 'work-c', revision: 1 }, attemptId: 'att-c', state: 'canceled', endedAt: '2026-10-21T12:02:00Z',
    workState: 'failed' });
  owner.release();
  assert.ok(ledger.closed);

  const reopened = await openLedger(new FakeOwner(dir, 'epoch-2'));
  t.after(() => reopened.close());
  assert.equal(reopened.getPublication(W1)!.outputs[0]!.id, sha('kept'));
  assert.equal(reopened.getAttempt('att-c')!.state, 'canceled');
  const last = reopened.readEvents({ limit: 500 }).events.at(-1)!;
  assert.equal(last.kind, 'epoch-opened');
  assert.deepEqual(last.payload, { previous: 'epoch-1' });
  assert.ok(!('db' in reopened), 'no connection is exposed');
});

test('publication fails closed without a verifier and refuses forged, tampered or foreign objects', async t => {
  const dir = scratch(t);
  const owner = new FakeOwner(dir, 'epoch-1');
  const bare = await openLedger(owner);
  bare.createRun(runEnvelope('epoch-1') as never);
  bare.createWork(workEnvelope('epoch-1') as never);
  start(bare, 'epoch-1', 'att-1', 1);
  const forged = unstoredReceipt('never written');
  bare.registerStaging('stage-1', [{ id: forged.id, schema: 'text/plain', privacy: 'metadata' }], { work: W1, attemptId: 'att-1' });
  const publish = (l: Ledger, r: typeof forged) => l.publish({ work: W1, attemptId: 'att-1', stageId: 'stage-1',
    receipts: [r], outputs: [r.id], endedAt: '2026-10-21T12:01:00Z' });
  assert.throws(() => publish(bare, forged), code('sentinel.store.objectVerifierUnavailable'));
  owner.release();

  const objects = new FakeObjects();
  const check = async (epoch: string, store: FakeObjects, receipt: typeof forged) => {
    const o = new FakeOwner(dir, epoch);
    const l = await openLedger(o, { objects: store });
    l.startAttempt(attemptEnvelope(epoch, { id: `att-${epoch}`, ordinal: Number(epoch.slice(6)), work: W1 }) as never,
      { supersede: true });
    l.registerStaging(`stage-${epoch}`, [{ id: receipt.id, schema: 'text/plain', privacy: 'metadata' }],
      { work: W1, attemptId: `att-${epoch}` });
    assert.throws(() => l.publish({ work: W1, attemptId: `att-${epoch}`, stageId: `stage-${epoch}`, receipts: [receipt],
      outputs: [receipt.id], endedAt: '2026-10-21T12:01:00Z' }), code('sentinel.store.objectMissing'), epoch);
    assert.deepEqual(l.gcSnapshot().referenced, [], epoch);
    o.release();
  };
  await check('epoch-2', objects, forged); // never stored
  const real = objects.put('real bytes');
  objects.bytes.set(`${real.id}|identity`, Buffer.from('tampered bytes'));
  await check('epoch-3', objects, real); // stored bytes no longer hash to the receipt
  const other = new FakeObjects('store-other');
  await check('epoch-4', other, other.put('elsewhere')); // the bytes live in another store
  const honest = objects.put('honest');
  await check('epoch-5', objects, { ...honest, rawSize: honest.rawSize + 1, storedSize: honest.storedSize + 1 }); // the receipt overstates the bytes
});
