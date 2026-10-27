// The object store against the real ledger: receipts, the verifier and the dry-run prune over its GC snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectStore, identify } from '../dist/store/objects.js';
import { planPrune } from '../dist/store/gc.js';
import {
  ledgerObjectVerifier,
  planPruneFromLedger,
  reachabilityFromLedger,
  refFromLedgerReceipt,
  toLedgerReceipt,
} from '../dist/store/objects-ledger.js';
import { openLedger } from '../dist/store/ledger.js';
import { LedgerError, type GcSnapshot } from '../dist/store/store-types.js';
import { FakeOwner, attemptEnvelope, runEnvelope, workEnvelope } from './store-helpers.ts';

const W1 = { id: 'work-pattern-api', revision: 1 };
const code = (c: string) => (e: unknown) => e instanceof LedgerError && e.code === c;

async function setup(t: { after(fn: () => void): void }) {
  // The object store requires a canonical root: on macOS tmpdir() passes through the /var symbolic link.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-objledger-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const owner = new FakeOwner(dir, 'epoch-1', 'store-ol-1');
  const store = new ObjectStore(owner);
  const ledger = await openLedger(owner, { objects: ledgerObjectVerifier(store) });
  t.after(() => ledger.close());
  // Unfinished work and running attempts name real objects: GC treats them as active roots that must exist.
  const manifest = await store.putCanonicalJson({ kind: 'synthetic-influence-manifest' });
  const invocation = await store.putCanonicalJson({ kind: 'synthetic-invocation' });
  ledger.createRun(runEnvelope(owner.epoch) as never);
  ledger.createWork(workEnvelope(owner.epoch, { influenceManifest: manifest.artifactId }) as never);
  ledger.startAttempt(
    attemptEnvelope(owner.epoch, { id: 'att-1', ordinal: 1, work: W1, invocation: invocation.artifactId }) as never,
    { supersede: false },
  );
  return { dir, owner, store, ledger, manifest, invocation };
}

test('receipts use the ledger codec names and round-trip to object references', async (t) => {
  const { store } = await setup(t);
  const gz = await store.put(Buffer.from('finding'));
  const raw = await store.put(Buffer.from('finding'), { codec: 'raw' });
  const lg = toLedgerReceipt(gz);
  assert.deepEqual(lg, {
    id: gz.artifactId,
    codec: 'gzip',
    storedDigest: `sha256:${gz.encodedDigest}`,
    rawSize: gz.rawSize,
    storedSize: gz.encodedSize,
  });
  assert.equal(toLedgerReceipt(raw).codec, 'identity');
  assert.deepEqual(refFromLedgerReceipt(lg), {
    rawDigest: gz.rawDigest,
    codec: 'gzip',
    rawSize: gz.rawSize,
    encodedDigest: gz.encodedDigest,
    encodedSize: gz.encodedSize,
  });
  for (const bad of [
    { ...lg, codec: 'gzip-6' },
    { ...lg, codec: 'raw' },
    { ...lg, id: 'finding' },
    { ...lg, storedDigest: gz.encodedDigest },
    null,
  ]) {
    assert.equal(refFromLedgerReceipt(bad as any), undefined, JSON.stringify(bad));
  }
});

test('the verifier measures the stored bytes and never echoes the request', async (t) => {
  const { dir, store } = await setup(t);
  const verifier = ledgerObjectVerifier(store);
  const gz = await store.put(Buffer.from('measured bytes'));
  const seen = verifier.verify({ id: gz.artifactId, codec: 'gzip' });
  assert.deepEqual(seen, { ...toLedgerReceipt(gz), storeId: 'store-ol-1' });
  // A request carrying extra claims gets only what was measured.
  const claimed = verifier.verify({
    id: gz.artifactId,
    codec: 'gzip',
    storedDigest: `sha256:${'0'.repeat(64)}`,
    rawSize: 1,
  } as any);
  assert.deepEqual(claimed, seen);
  assert.equal(verifier.verify({ id: gz.artifactId, codec: 'identity' }), null, 'no raw representation was stored');
  for (const bad of [{ id: gz.artifactId, codec: 'gzip-6' }, { id: 'x', codec: 'gzip' }, null]) {
    assert.equal(verifier.verify(bad as any), null);
  }
  chmodSync(join(dir, gz.relPath), 0o600);
  writeFileSync(join(dir, gz.relPath), 'rot');
  assert.equal(verifier.verify({ id: gz.artifactId, codec: 'gzip' }), null, 'corrupt bytes are not durable');
  rmSync(join(dir, gz.relPath));
  assert.equal(verifier.verify({ id: gz.artifactId, codec: 'gzip' }), null, 'missing bytes are not durable');
});

test('a publication through the real ledger is accepted only for bytes this store holds as receipted', async (t) => {
  const { dir, store, ledger, manifest, invocation } = await setup(t);
  // The fixture names no unstored active object.
  const out = Buffer.from('finding one');
  const child = Buffer.from('quoted source bytes');
  const [oi, ci] = [identify(out), identify(child)];
  // Registration precedes the write, the way the coordinator does it.
  ledger.registerStaging(
    'stage-1',
    [
      { id: oi.artifactId, schema: 'sentinel-observation/draft-1', privacy: 'source-derived', links: [ci.artifactId] },
      { id: ci.artifactId, schema: 'text/plain', privacy: 'source', links: [] },
    ],
    { work: W1, attemptId: 'att-1' },
  );
  const pending = await planPruneFromLedger(store, ledger);
  assert.equal(pending.ok, true, JSON.stringify(pending.errors));
  assert.deepEqual([...pending.report.pendingStaged].sort(), [oi.artifactId, ci.artifactId].sort());

  const ro = await store.put(out, { expect: oi });
  const rc = await store.put(child, { codec: 'raw', expect: ci });
  // A receipt claiming other stored bytes than the verifier measures is refused.
  const forged = { ...toLedgerReceipt(ro), storedDigest: `sha256:${'0'.repeat(64)}` };
  assert.throws(
    () =>
      ledger.publish({
        work: W1,
        attemptId: 'att-1',
        stageId: 'stage-1',
        receipts: [forged, toLedgerReceipt(rc)],
        outputs: [oi.artifactId],
        endedAt: '2026-10-21T12:01:00Z',
      }),
    code('sentinel.store.objectMissing'),
  );

  // Corrupt bytes behind a correct receipt are refused too.
  chmodSync(join(dir, rc.relPath), 0o600);
  writeFileSync(join(dir, rc.relPath), 'tampered');
  assert.throws(
    () =>
      ledger.publish({
        work: W1,
        attemptId: 'att-1',
        stageId: 'stage-1',
        receipts: [toLedgerReceipt(ro), toLedgerReceipt(rc)],
        outputs: [oi.artifactId],
        endedAt: '2026-10-21T12:01:00Z',
      }),
    code('sentinel.store.objectMissing'),
  );
  writeFileSync(join(dir, rc.relPath), child);

  ledger.publish({
    work: W1,
    attemptId: 'att-1',
    stageId: 'stage-1',
    receipts: [toLedgerReceipt(ro), toLedgerReceipt(rc)],
    outputs: [oi.artifactId],
    endedAt: '2026-10-21T12:01:00Z',
  });

  const orphan = await store.put(Buffer.from('never referenced'));
  const plan = await planPruneFromLedger(store, ledger);
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.deepEqual(plan.validFor, { storeId: 'store-ol-1', sequence: ledger.currentSequence() });
  // The completed work's manifest and the attempt's invocation stay protected while their rows are retained;
  // only the independent orphan is a candidate.
  const snap = ledger.gcSnapshot();
  assert.ok(snap.retained.includes(manifest.artifactId) && snap.retained.includes(invocation.artifactId));
  assert.ok(!snap.active.includes(manifest.artifactId), 'the work is finished, so not active');
  assert.deepEqual(
    plan.candidates.map((c) => c.relPath),
    [orphan.relPath],
  );
  assert.ok(plan.report.rootCounts.retained === 1);
  assert.ok(
    !plan.candidates.some((c) => c.rawDigest === ro.rawDigest || c.rawDigest === rc.rawDigest),
    'published output and its link are kept',
  );
  assert.equal(plan.deleted, 0);
});

test('a ledger snapshot that moved, names another store or is incomplete plans nothing', async (t) => {
  const { store, ledger, owner } = await setup(t);
  await store.put(Buffer.from('unreferenced'));
  const snap = ledger.gcSnapshot();
  const fresh = await planPrune(store, reachabilityFromLedger(snap), { readSequence: () => ledger.currentSequence() });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.candidates.length, 1);

  // Any committed change after the snapshot (here a staging registration) fails the stale plan closed.
  ledger.registerStaging(
    'stage-x',
    [{ id: identify(Buffer.from('later')).artifactId, schema: 'text/plain', privacy: 'metadata', links: [] }],
    { work: W1, attemptId: 'att-1' },
  );
  const stale = await planPrune(store, reachabilityFromLedger(snap), { readSequence: () => ledger.currentSequence() });
  assert.equal(stale.ok, false);
  assert.ok(stale.errors.some((e) => e.code === 'sentinel.gc.snapshotMoved'));
  assert.deepEqual(stale.candidates, []);
  assert.throws(() => ledger.assertSnapshotCurrent(snap), code('sentinel.store.snapshotStale'));

  const current = ledger.gcSnapshot();
  const cases: [string, Partial<GcSnapshot> | Record<string, unknown>][] = [
    ['another store', { storeId: 'other' }],
    ['no store id', { storeId: undefined }],
    ['not complete', { complete: false }],
    ['no links', { links: undefined }],
    ['no retained list', { retained: undefined }],
    ['retained not a list', { retained: 'all' }],
    ['sparse retained', { retained: new Array(2) }],
    ['malformed retained id', { retained: ['manifest'] }],
    ['retained artifact missing', { retained: [identify(Buffer.from('retained, never stored')).artifactId] }],
    ['malformed link', { links: [[current.referenced[0] ?? 'x']] }],
    ['sparse staged', { staged: new Array(2) }],
    ['malformed receipt', { objects: [{ id: 'x', codec: 'gzip', storedDigest: 'x', rawSize: 0, storedSize: 0 }] }],
    [
      'recorded but not stored',
      {
        objects: [
          {
            id: identify(Buffer.from('gone')).artifactId,
            codec: 'gzip',
            storedDigest: `sha256:${'1'.repeat(64)}`,
            rawSize: 4,
            storedSize: 24,
          },
        ],
      },
    ],
    ['accepted reference missing', { referenced: [identify(Buffer.from('accepted, never stored')).artifactId] }],
  ];
  for (const [name, over] of cases) {
    const p = await planPrune(store, reachabilityFromLedger({ ...current, ...over } as GcSnapshot), {
      readSequence: () => ledger.currentSequence(),
    });
    assert.equal(p.ok, false, name);
    assert.deepEqual(p.candidates, [], name);
  }
  void owner;
});

test('an active root the ledger names but this store lacks fails the plan closed', async (t) => {
  const { store, ledger } = await setup(t);
  ledger.createRun(runEnvelope('epoch-1', { id: 'run-2', parentId: 'run-1' }) as never);
  ledger.createWork(workEnvelope('epoch-1', { runId: 'run-2', revision: 2 }) as never); // the fixture's unstored manifest
  const plan = await planPruneFromLedger(store, ledger);
  assert.equal(plan.ok, false);
  assert.ok(plan.errors.some((e) => e.code === 'sentinel.gc.missingReachable'));
  assert.deepEqual(plan.candidates, []);
});
