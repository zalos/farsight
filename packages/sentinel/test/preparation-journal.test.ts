// Storage data only, not fabricated execution/admission publications: genuine held store and private durable files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  PreparationJournal,
  PREPARATION_TERMINAL_LIMIT,
  type PreparationRecord,
} from '../dist/service/preparation-journal.js';
import { canonicalJsonBytes } from '../dist/store/objects.js';
import { openStore } from '../dist/store/index.js';
import { needsStore, openCaptureStore, scratch } from './snapshot-helpers.ts';
const D = (v: Uint8Array | string) => `sha256:${createHash('sha256').update(v).digest('hex')}`;
const code = (c: string) => (e: any) => e?.code === c;
function fixtureRecord(store: any, n = 1): { record: PreparationRecord; bytes: Buffer } {
  const bytes = canonicalJsonBytes({ configuration: 'inert storage fixture', n }),
    acceptedAt = new Date().toISOString();
  return {
    bytes,
    record: {
      schema: 'sentinel-preparation/1',
      prepId: `prep-${n.toString(16).padStart(32, '0')}`,
      requestKeyDigest: D(`key-${n}`),
      requestDigest: D(`intent-${n}`),
      storeId: store.storeId,
      workspaceIdentity: D('workspace'),
      createdEpoch: store.epoch,
      ownerEpoch: store.epoch,
      recordRevision: 1,
      phase: 'accepted',
      checkpoint: 'none',
      mode: 'workspace',
      parentId: null,
      parentRevision: null,
      parentPlanDigest: null,
      parentSnapshotId: null,
      acceptedAt,
      deadlineAt: new Date(Date.parse(acceptedAt) + 600000).toISOString(),
      updatedAt: acceptedAt,
      runDeadlineAt: new Date(Date.parse(acceptedAt) + 600000).toISOString(),
      configDigest: D(bytes),
      resolvedDigest: null,
      admissionDigest: D('storage datum, not authority'),
      resumeAdmissionDigest: null,
      snapshotId: null,
      runId: null,
      planRevision: null,
      planDigest: null,
      errorCode: null,
    },
  };
}
const next = (r: PreparationRecord, patch: Partial<PreparationRecord>): PreparationRecord => ({
  ...r,
  ...patch,
  recordRevision: r.recordRevision + 1,
  updatedAt: new Date().toISOString(),
});
test('construct, status and history lookups create no journal folders', needsStore, async (t) => {
  const { store } = await openCaptureStore(t, scratch(t)),
    j = new PreparationJournal(store);
  assert.equal(existsSync(j.directory), false);
  assert.equal(j.read(D('missing')), null);
  assert.deepEqual(j.list(), []);
  assert.equal(existsSync(j.directory), false);
});
test(
  'exact private record/config/resolved bytes survive reopen without conferring authority',
  needsStore,
  async (t) => {
    const f = await openCaptureStore(t, scratch(t)),
      j = new PreparationJournal(f.store),
      v = fixtureRecord(f.store);
    let r = j.create(v.record, v.bytes);
    assert.deepEqual(j.readBundle(r, 'config'), v.bytes);
    r = j.update(next(r, { phase: 'discovering' }), r.recordRevision);
    const resolved = canonicalJsonBytes({ profile: 'inert fixture' }),
      digest = j.writeResolved(r, resolved);
    r = j.update(next(r, { phase: 'capturing', resolvedDigest: digest }), r.recordRevision);
    const stored = readFileSync(join(j.directory, 'records', `${r.requestKeyDigest.slice(7)}.json`));
    f.store.close();
    const store = await openStore(f.storePath);
    t.after(() => store.close());
    const reopened = new PreparationJournal(store);
    assert.deepEqual(reopened.readBundle(r, 'resolved'), resolved);
    assert.deepEqual(
      readFileSync(join(j.directory, 'records', `${r.requestKeyDigest.slice(7)}.json`)),
      stored,
      'lookup never repairs or advances an old epoch',
    );
    assert.equal(reopened.read(r.requestKeyDigest)!.ownerEpoch, r.ownerEpoch);
    assert.notEqual(store.epoch, r.ownerEpoch);
  },
);
test('one active preparation, exact request, original identity and deadline remain bound', needsStore, async (t) => {
  const { store } = await openCaptureStore(t, scratch(t)),
    j = new PreparationJournal(store),
    a = fixtureRecord(store),
    r = j.create(a.record, a.bytes),
    b = fixtureRecord(store, 2);
  assert.throws(() => j.create(b.record, b.bytes), code('sentinel.preparation.busy'));
  assert.throws(() => j.create(a.record, a.bytes), code('sentinel.preparation.changed'));
  for (const patch of [
    { requestDigest: D('other') },
    { acceptedAt: new Date(Date.parse(r.acceptedAt) + 1).toISOString() },
    { deadlineAt: new Date(Date.parse(r.deadlineAt) + 1).toISOString() },
    { runDeadlineAt: new Date(Date.parse(r.runDeadlineAt) + 1).toISOString() },
    { configDigest: D('other') },
  ])
    assert.throws(() => j.update(next(r, { phase: 'discovering', ...patch }), r.recordRevision));
  assert.deepEqual(j.read(r.requestKeyDigest), r);
  assert.equal(j.list().length, 1);
});
test('resolved bundle is write-once and changes or missing bytes never become a profile', needsStore, async (t) => {
  const { store } = await openCaptureStore(t, scratch(t)),
    j = new PreparationJournal(store),
    a = fixtureRecord(store);
  let r = j.create(a.record, a.bytes);
  r = j.update(next(r, { phase: 'discovering' }), r.recordRevision);
  const bytes = canonicalJsonBytes({ profile: 'fixed' }),
    digest = j.writeResolved(r, bytes);
  assert.equal(j.writeResolved(r, bytes), digest);
  assert.throws(
    () => j.writeResolved(r, canonicalJsonBytes({ profile: 'different' })),
    code('sentinel.preparation.changed'),
  );
  r = j.update(next(r, { phase: 'capturing', resolvedDigest: digest }), r.recordRevision);
  assert.deepEqual(j.readBundle(r, 'resolved'), bytes);
  writeFileSync(join(j.directory, 'bundles', `${r.prepId}.resolved.json`), '{}');
  assert.throws(() => j.readBundle(r, 'resolved'), code('sentinel.preparation.invalid'));
});
test('hardlink, symlink, foreign store or malformed fields remain refused and untouched', needsStore, async (t) => {
  const { store } = await openCaptureStore(t, scratch(t)),
    j = new PreparationJournal(store),
    a = fixtureRecord(store),
    r = j.create(a.record, a.bytes),
    path = join(j.directory, 'records', `${r.requestKeyDigest.slice(7)}.json`),
    alias = join(j.directory, 'records', 'unknown-alias');
  linkSync(path, alias);
  assert.throws(() => j.read(r.requestKeyDigest));
  assert.ok(existsSync(alias));
  assert.throws(() => j.list());
});
test(
  'replaced owned journal directory refuses rather than recreating or deleting unknown data',
  needsStore,
  async (t) => {
    const { store } = await openCaptureStore(t, scratch(t)),
      j = new PreparationJournal(store),
      a = fixtureRecord(store);
    j.create(a.record, a.bytes);
    const old = `${j.directory}-kept`;
    renameSync(j.directory, old);
    symlinkSync(old, j.directory);
    assert.throws(() => j.read(a.record.requestKeyDigest));
    assert.equal(readFileSync(join(old, 'bundles', `${a.record.prepId}.config.json`)).toString(), a.bytes.toString());
  },
);
test(
  'no pre-capture interruption can resume; pinned interrupted state needs a new explicit admission reference',
  needsStore,
  async (t) => {
    const { store } = await openCaptureStore(t, scratch(t)),
      j = new PreparationJournal(store),
      a = fixtureRecord(store);
    let r = j.create(a.record, a.bytes);
    r = j.update(next(r, { phase: 'interrupted', errorCode: 'sentinel.preparation.canceled' }), r.recordRevision);
    assert.throws(() =>
      j.update(
        next(r, {
          phase: 'captured',
          snapshotId: 'snap-unknown',
          resolvedDigest: D('unknown'),
          checkpoint: 'captured',
          resumeAdmissionDigest: D('new'),
        }),
        r.recordRevision,
      ),
    );
    assert.equal(j.read(r.requestKeyDigest)!.phase, 'interrupted');
  },
);
test(
  '256 retained terminal records refuse one more without deleting any history or bundles',
  { ...needsStore, timeout: 60000 },
  async (t) => {
    const { store } = await openCaptureStore(t, scratch(t)),
      j = new PreparationJournal(store);
    for (let n = 1; n <= PREPARATION_TERMINAL_LIMIT; n++) {
      const v = fixtureRecord(store, n),
        r = j.create(v.record, v.bytes);
      j.update(next(r, { phase: 'failed', errorCode: 'sentinel.preparation.unavailable' }), r.recordRevision);
    }
    const before = readdirSync(join(j.directory, 'records')).sort(),
      bundles = readdirSync(join(j.directory, 'bundles')).sort(),
      v = fixtureRecord(store, 257);
    assert.throws(() => j.create(v.record, v.bytes), code('sentinel.preparation.retentionRequired'));
    assert.deepEqual(readdirSync(join(j.directory, 'records')).sort(), before);
    assert.deepEqual(readdirSync(join(j.directory, 'bundles')).sort(), bundles);
    assert.equal(j.list().length, 256);
  },
);
