import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, lstatSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ObjectStore, NODE_OBJECT_IO, identify, type ObjectReceipt, type ObjectStoreIo } from '../dist/store/objects.js';
import { inspectReachability, planPrune, type ReachabilitySnapshot } from '../dist/store/gc.js';
import { ledgerObjectPresence, reachabilityFromLedger, toLedgerReceipt, refFromLedgerReceipt } from '../dist/store/objects-ledger.js';

const STORE = 'store-gc-1';
function scratch(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-gc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Path → mode, size, mtime and content digest for every entry: proves a dry run changed nothing. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, r));
      const body = st.isFile() ? createHash('sha256').update(readFileSync(join(dir, r))).digest('hex') : '';
      out[r] = `${st.mode}:${st.size}:${st.mtimeMs}:${body}`;
      if (st.isDirectory()) walk(r);
    }
  };
  walk('');
  return out;
}

/** The real filesystem for reads; any mutating call fails the test. */
const readOnlyIo: ObjectStoreIo = {
  ...NODE_OBJECT_IO,
  open: (path, flags, mode) => {
    if ((flags & 3) !== 0) throw new Error(`GC opened ${path} for writing`);
    return NODE_OBJECT_IO.open(path, flags, mode);
  },
  mkdir: path => { throw new Error(`GC created ${path}`); },
  link: path => { throw new Error(`GC linked ${path}`); },
  unlink: path => { throw new Error(`GC removed ${path}`); },
};

async function fixture(t: { after(fn: () => void): void }) {
  const dir = scratch(t);
  const writer = new ObjectStore({ storePath: dir, storeId: STORE, assertHeld() {} });
  const put = (s: string, codec: 'raw' | 'gzip' = 'gzip') => writer.put(Buffer.from(s), { codec });
  const r: Record<string, ObjectReceipt> = {
    report: await put('report'), finding: await put('finding'), evidence: await put('evidence'),
    shared: await put('shared'), sharedRaw: await put('shared', 'raw'), cycleA: await put('cycle-a'), cycleB: await put('cycle-b'),
    active: await put('active'), pinned: await put('pinned'), staged: await put('staged'),
    orphan: await put('orphan'), orphanChild: await put('orphan-child'),
  };
  writeFileSync(join(dir, 'objects/tmp/interrupted.gzip.0000.partial'), 'partial');
  writeFileSync(join(dir, 'objects/stray'), 'not ours');
  const id = (k: string) => r[k]!.artifactId;
  const snapshot: ReachabilitySnapshot = {
    storeId: STORE, sequence: 42, complete: true,
    roots: [
      { kind: 'report', id: 'report-1', artifacts: [id('report')] },
      { kind: 'active', id: 'attempt-1', artifacts: [id('active'), id('cycleA')] },
      { kind: 'pinned', id: 'pin-1', artifacts: [id('pinned')] },
      { kind: 'staged', id: 'stage-1', artifacts: [id('staged'), identify(Buffer.from('not written yet')).artifactId] },
    ],
    links: [
      { from: id('report'), to: id('finding') }, { from: id('finding'), to: id('evidence') },
      { from: id('finding'), to: id('shared') }, { from: id('active'), to: id('shared') },
      { from: id('cycleA'), to: id('cycleB') }, { from: id('cycleB'), to: id('cycleA') },
      // A link out of an unreachable object protects nothing.
      { from: id('orphan'), to: id('orphanChild') },
    ],
  };
  return { dir, r, id, snapshot, store: new ObjectStore({ storePath: dir, storeId: STORE, assertHeld() {} }, { io: readOnlyIo }) };
}

test('reachability follows links transitively through cycles and shared children, in every codec', async t => {
  const { r, id, snapshot, store } = await fixture(t);
  const report = await inspectReachability(store, snapshot);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.sequence, 42);
  const expected = ['report', 'finding', 'evidence', 'shared', 'cycleA', 'cycleB', 'active', 'pinned', 'staged'].map(id);
  expected.push(identify(Buffer.from('not written yet')).artifactId);
  assert.deepEqual(report.reachable, [...new Set(expected)].sort());
  assert.deepEqual(report.rootCounts, { referenced: 0, active: 1, staged: 1, report: 1, pinned: 1 });
  assert.deepEqual(report.pendingStaged, [identify(Buffer.from('not written yet')).artifactId], 'registered before its write');
  assert.equal(report.physical.objects, 12);
  assert.equal(report.physical.protectedObjects, 10, 'shared is protected in both its gzip and raw files');
  assert.deepEqual(report.physical.staging, ['objects/tmp/interrupted.gzip.0000.partial']);
  assert.deepEqual(report.physical.unexpected, ['objects/stray']);
  void r;
});

test('a dry-run prune lists only unreachable published objects and changes nothing on disk', async t => {
  const { dir, r, snapshot, store } = await fixture(t);
  const before = fingerprint(dir);
  const plan = await planPrune(store, snapshot);
  assert.equal(plan.ok, true);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.deleted, 0);
  assert.deepEqual(plan.validFor, { storeId: STORE, sequence: 42 });
  assert.deepEqual(plan.candidates.map(c => c.relPath).sort(), [r.orphan!.relPath, r.orphanChild!.relPath].sort());
  assert.equal(plan.candidateBytes, r.orphan!.encodedSize + r.orphanChild!.encodedSize);
  assert.deepEqual(plan.retained, { staging: ['objects/tmp/interrupted.gzip.0000.partial'], unexpected: ['objects/stray'] });
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.candidates));
  assert.deepEqual(fingerprint(dir), before);
});

test('a snapshot that is incomplete, foreign, malformed, moving or missing an accepted object fails closed', async t => {
  const { r, id, snapshot, store } = await fixture(t);
  const missing = identify(Buffer.from('accepted but absent')).artifactId;
  const cases: [string, ReachabilitySnapshot | any, string, object?][] = [
    ['incomplete', { ...snapshot, complete: false }, 'sentinel.gc.incompleteSnapshot'],
    ['complete omitted', { ...snapshot, complete: undefined }, 'sentinel.gc.incompleteSnapshot'],
    ['another store', { ...snapshot, storeId: 'other' }, 'sentinel.gc.wrongStore'],
    ['negative sequence', { ...snapshot, sequence: -1 }, 'sentinel.gc.invalidSnapshot'],
    ['fractional sequence', { ...snapshot, sequence: 1.5 }, 'sentinel.gc.invalidSnapshot'],
    ['no roots list', { ...snapshot, roots: undefined }, 'sentinel.gc.invalidSnapshot'],
    ['unknown root kind', { ...snapshot, roots: [...snapshot.roots, { kind: 'cache', id: 'x', artifacts: [] }] }, 'sentinel.gc.invalidSnapshot'],
    ['root without id', { ...snapshot, roots: [...snapshot.roots, { kind: 'pinned', id: '', artifacts: [] }] }, 'sentinel.gc.invalidSnapshot'],
    ['invalid artifact id', { ...snapshot, roots: [...snapshot.roots, { kind: 'pinned', id: 'p', artifacts: ['sha256:XYZ'] }] }, 'sentinel.gc.invalidSnapshot'],
    ['invalid link', { ...snapshot, links: [...snapshot.links, { from: id('report'), to: 'evidence' }] }, 'sentinel.gc.invalidSnapshot'],
    ['accepted root missing', { ...snapshot, roots: [...snapshot.roots, { kind: 'report', id: 'r2', artifacts: [missing] }] }, 'sentinel.gc.missingReachable'],
    ['linked child missing', { ...snapshot, links: [...snapshot.links, { from: id('finding'), to: missing }] }, 'sentinel.gc.missingReachable'],
    ['sequence moved', snapshot, 'sentinel.gc.snapshotMoved', { readSequence: () => 43 }],
    ['sequence unreadable', snapshot, 'sentinel.gc.snapshotMoved', { readSequence: () => { throw new Error('ledger closed'); } }],
    ['no snapshot', null, 'sentinel.gc.invalidSnapshot'],
  ];
  for (const [name, snap, code, options] of cases) {
    const plan = await planPrune(store, snap, options);
    assert.equal(plan.ok, false, name);
    assert.deepEqual(plan.candidates, [], `${name}: no candidate when the graph cannot be trusted`);
    assert.equal(plan.deleted, 0);
    assert.ok(plan.errors.some(e => e.code === code), `${name}: ${JSON.stringify(plan.errors)}`);
  }
  // A staged artifact that a later accepted link also names is no longer excused from existing.
  const stagedMissing = identify(Buffer.from('not written yet')).artifactId;
  const promoted = await planPrune(store, { ...snapshot, links: [...snapshot.links, { from: id('report'), to: stagedMissing }] });
  assert.ok(promoted.errors.some(e => e.code === 'sentinel.gc.missingReachable'));
  // The unchanged sequence passes.
  assert.equal((await planPrune(store, snapshot, { readSequence: async () => 42 })).ok, true);
  void r;
});

test('an unreadable store fails closed', async t => {
  const { snapshot, dir } = await fixture(t);
  const broken = new ObjectStore({ storePath: dir, storeId: STORE, assertHeld() {} }, {
    io: { ...readOnlyIo, readdir: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } },
  });
  const plan = await planPrune(broken, snapshot);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.candidates, []);
  assert.ok(plan.errors.some(e => e.code === 'sentinel.gc.unreadableStore'));
});

test('an empty store with an empty snapshot plans nothing', async t => {
  const dir = scratch(t);
  const store = new ObjectStore({ storePath: dir, storeId: STORE, assertHeld() {} }, { io: readOnlyIo });
  const plan = await planPrune(store, { storeId: STORE, sequence: 0, complete: true, roots: [], links: [] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(readdirSync(dir), [], 'inspection created no directory');
});

test('a corrupt protected object or a recorded object that is absent or altered fails closed', async t => {
  const { dir, r, snapshot, store } = await fixture(t);
  const before = fingerprint(dir);
  // Recorded and present: fine.
  assert.equal((await planPrune(store, { ...snapshot, recorded: [r.report!, r.orphan!] })).ok, true);
  const absent = { rawDigest: identify(Buffer.from('recorded, never stored')).rawDigest, codec: 'gzip' as const };
  const missing = await planPrune(store, { ...snapshot, recorded: [absent] });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some(e => e.code === 'sentinel.gc.missingRecorded'));
  assert.deepEqual(missing.candidates, []);
  const wrongSize = await planPrune(store, { ...snapshot, recorded: [{ ...r.orphan!, encodedSize: r.orphan!.encodedSize + 1 }] });
  assert.ok(wrongSize.errors.some(e => e.code === 'sentinel.gc.corruptObject'), 'an unreachable recorded object must still verify');
  assert.deepEqual(fingerprint(dir), before);

  chmodSync(join(dir, r.evidence!.relPath), 0o600);
  writeFileSync(join(dir, r.evidence!.relPath), 'rot');
  const plan = await planPrune(store, snapshot);
  assert.equal(plan.ok, false);
  assert.ok(plan.errors.some(e => e.code === 'sentinel.gc.corruptObject' && e.detail.includes(r.evidence!.relPath)));
  assert.deepEqual(plan.candidates, []);
  // Presence-only mode is explicit and does not hash.
  assert.equal((await planPrune(store, snapshot, { verify: false })).ok, true);
});

test('the ledger adapter converts receipts, verifies durability against disk and fails closed on bad snapshots', async t => {
  const { dir, r, id, store } = await fixture(t);
  const ledger = toLedgerReceipt(r.report!);
  assert.deepEqual(ledger, { id: id('report'), codec: 'gzip-6', storedDigest: `sha256:${r.report!.encodedDigest}`, rawSize: r.report!.rawSize, storedSize: r.report!.encodedSize });
  assert.equal(toLedgerReceipt(r.sharedRaw!).codec, 'identity');
  assert.deepEqual(refFromLedgerReceipt(ledger), { rawDigest: r.report!.rawDigest, codec: 'gzip', rawSize: r.report!.rawSize, encodedDigest: r.report!.encodedDigest, encodedSize: r.report!.encodedSize });

  const presence = ledgerObjectPresence(store);
  assert.equal(presence.isDurable(ledger), true);
  assert.equal(presence.isDurable(toLedgerReceipt(r.sharedRaw!)), true);
  for (const bad of [
    { ...ledger, codec: 'zstd' }, { ...ledger, id: 'report' }, { ...ledger, storedDigest: r.report!.encodedDigest },
    { ...ledger, storedSize: ledger.storedSize + 1 }, { ...ledger, rawSize: ledger.rawSize + 1 },
    { ...ledger, storedDigest: `sha256:${'0'.repeat(64)}` }, { ...ledger, codec: 'identity' }, null,
  ]) assert.equal(presence.isDurable(bad as any), false, JSON.stringify(bad));
  // The bytes are read every time: a receipt that was durable stops being so when its file rots.
  chmodSync(join(dir, r.report!.relPath), 0o600);
  writeFileSync(join(dir, r.report!.relPath), 'rot');
  assert.equal(presence.isDurable(ledger), false);
  rmSync(join(dir, r.report!.relPath));
  assert.equal(presence.isDurable(ledger), false);

  const ledgerSnapshot = {
    sequence: 7, referenced: [id('finding')], staged: [id('staged')], reports: [id('pinned')], active: [id('active')],
    links: [[id('finding'), id('evidence')], [id('active'), id('shared')]] as [string, string][],
    objects: [toLedgerReceipt(r.finding!), toLedgerReceipt(r.evidence!)],
  };
  const plan = await planPrune(store, reachabilityFromLedger(ledgerSnapshot, STORE));
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.deepEqual(plan.validFor, { storeId: STORE, sequence: 7 });
  assert.deepEqual(plan.report.rootCounts, { referenced: 1, active: 1, staged: 1, report: 1, pinned: 0 });
  assert.ok(!plan.candidates.some(c => c.rawDigest === r.evidence!.rawDigest || c.rawDigest === r.shared!.rawDigest));
  for (const [name, snap] of [
    ['no links', { ...ledgerSnapshot, links: undefined }],
    ['malformed link', { ...ledgerSnapshot, links: [[id('finding')]] }],
    ['malformed receipt', { ...ledgerSnapshot, objects: [{ ...toLedgerReceipt(r.finding!), codec: 'zstd' }] }],
    ['missing sequence', { ...ledgerSnapshot, sequence: undefined }],
    ['dangling link', { ...ledgerSnapshot, links: [[id('finding'), identify(Buffer.from('gone')).artifactId]] }],
  ] as const) {
    const p = await planPrune(store, reachabilityFromLedger(snap as any, STORE));
    assert.equal(p.ok, false, name);
    assert.deepEqual(p.candidates, [], name);
  }
});
