// The owner lock between real, independent processes: simultaneous bootstrap from an absent store, SIGKILL
// takeover, cooperative release, closed and stale capabilities, resource ordering and identity binding.
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireStoreOwner } from '../dist/store/owner.js';
import { isStoreError } from '../dist/store/errors.js';
import { SQLITE_RELEASE_POLICY, currentHost } from '../dist/store/runtime.js';
import { validateEnvelope } from '../dist/index.js';
import { OwnerProcesses, probeOwnership } from './helpers/owner-processes.ts';

// Ownership is exercised only on hosts the release policy qualifies; elsewhere the gate refuses first (tested
// in store-runtime.test.ts). Qualifying a host means adding it to the policy and running this suite there.
// On CI nothing skips: an unqualified CI host runs these tests and fails at the gate, loudly.
const unqualified = !SQLITE_RELEASE_POLICY.hosts.includes(currentHost()) && !process.env.CI
  && `host ${currentHost()} is not in SQLITE_RELEASE_POLICY.hosts`;
const test = (name: string, fn: () => Promise<void> | void) => nodeTest(name, { skip: unqualified }, fn);

const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'sentinel-owner-'));
const procs = new OwnerProcesses();
after(async () => { await procs.cleanup(); rmSync(scratch, { recursive: true, force: true }); });
let n = 0;
const freshStore = () => join(scratch, `case-${++n}`, 'store'); // the store and its parent are both absent

const rejectsWith = async (code: string, run: () => unknown) => {
  await assert.rejects(async () => run(), (e: unknown) => isStoreError(e) && e.code === code);
};

test('simultaneous starts from an absent store yield exactly one owner', async () => {
  for (let round = 0; round < 5; round++) {
    const store = freshStore();
    const contenders = await Promise.all(Array.from({ length: 4 }, () => procs.spawn(store)));
    for (const c of contenders) c.send({ type: 'go' }); // a barrier: all are ready before any starts
    const outcomes = await Promise.all(contenders.map(c => c.next()));
    const acquired = outcomes.filter(o => o.type === 'acquired');
    assert.equal(acquired.length, 1, JSON.stringify(outcomes));
    assert.deepEqual(outcomes.filter(o => o.type !== 'acquired').map(o => o.code), Array(3).fill('sentinel.store.ownedElsewhere'));
    assert.equal(statSync(store).mode & 0o777, 0o700);
    assert.equal(statSync(join(store, 'owner.sqlite')).mode & 0o777, 0o600);
    const descriptor = JSON.parse(readFileSync(join(store, 'owner.json'), 'utf8'));
    assert.equal(descriptor.pid, acquired[0].pid);
    assert.equal(descriptor.epoch, acquired[0].epoch);
    for (const c of contenders) await procs.kill(c);
  }
});

test('SIGKILL releases the lock; the successor takes over with a later epoch and excludes others', async () => {
  const store = freshStore();
  const first = await procs.spawn(store);
  first.send({ type: 'go' });
  const held = await first.next();
  assert.equal(held.type, 'acquired');
  assert.deepEqual(probeOwnership(store), { outcome: 'refused', code: 'sentinel.store.ownedElsewhere' });

  const killed = await procs.kill(first, 'SIGKILL');
  assert.equal(killed.signal, 'SIGKILL');
  const successor = await procs.spawn(store);
  successor.send({ type: 'go' });
  const taken = await successor.next();
  assert.equal(taken.type, 'acquired');
  assert.equal(taken.storeId, held.storeId);
  assert.notEqual(taken.epoch, held.epoch);
  successor.send({ type: 'assert' });
  assert.equal((await successor.next()).type, 'held');
  assert.deepEqual(probeOwnership(store), { outcome: 'refused', code: 'sentinel.store.ownedElsewhere' });
  successor.send({ type: 'release' });
  assert.equal((await successor.next()).type, 'released');
  assert.equal(probeOwnership(store).outcome, 'acquired');
  assert.ok(existsSync(join(store, 'owner.sqlite')), 'the lock file is never deleted');
  await procs.kill(successor);
});

test('cooperative release hands over; epochs increase; the descriptor is informational only', async () => {
  const store = freshStore();
  const a = await acquireStoreOwner(store);
  assert.match(a.storeId, /^[0-9a-f-]{36}$/);
  assert.match(a.epoch, /^epoch-[0-9a-f-]{36}$/);
  assert.equal(a.storePath, store);
  // Rewriting the descriptor does not move the lock.
  writeFileSync(join(store, 'owner.json'), '{"epoch":"epoch-someone-else"}');
  assert.deepEqual(probeOwnership(store), { outcome: 'refused', code: 'sentinel.store.ownedElsewhere' });
  a.assertHeld();
  a.close();
  assert.ok(existsSync(join(store, 'owner.json')), 'another holder\'s descriptor is not removed');
  const b = await acquireStoreOwner(store);
  assert.equal(b.storeId, a.storeId);
  assert.notEqual(b.epoch, a.epoch);
  assert.equal(JSON.parse(readFileSync(join(store, 'owner.json'), 'utf8')).epoch, b.epoch);
  b.close();
  assert.ok(!existsSync(join(store, 'owner.json')), 'the holder removes its own descriptor');
  assert.ok(existsSync(join(store, 'owner.sqlite')));
});

test('a second acquisition in the same process is refused without disturbing the first', async () => {
  const store = freshStore();
  const owner = await acquireStoreOwner(store);
  await rejectsWith('sentinel.store.ownedElsewhere', () => acquireStoreOwner(store));
  owner.assertHeld();
  assert.deepEqual(probeOwnership(store), { outcome: 'refused', code: 'sentinel.store.ownedElsewhere' });
  owner.close();
  (await acquireStoreOwner(store)).close();
});

test('a closed capability refuses use and close is idempotent', async () => {
  const owner = await acquireStoreOwner(freshStore());
  owner.close();
  owner.close();
  assert.equal(owner.held, false);
  assert.throws(() => owner.assertHeld(), (e: unknown) => isStoreError(e, 'sentinel.store.ownerClosed'));
  assert.throws(() => owner.registerResource({ close() {} }), (e: unknown) => isStoreError(e, 'sentinel.store.ownerClosed'));
  assert.throws(() => (owner as any).epoch = 'epoch-forged', TypeError);
  assert.equal(Object.keys(owner).some(k => /db|handle|connection/i.test(k)), false);
});

test('registered resources close last-first while the lock is still held, then the lock is released', async () => {
  const store = freshStore();
  const owner = await acquireStoreOwner(store);
  const order: string[] = [];
  const seen: string[] = [];
  owner.registerResource({ name: 'ledger', close() { order.push('ledger'); seen.push(probeOwnership(store).code ?? 'acquired'); } });
  const unregister = owner.registerResource({ name: 'dropped', close() { order.push('dropped'); } });
  owner.registerResource({ name: 'objects', close() { order.push('objects'); assert.throws(() => owner.assertHeld(), (e: unknown) => isStoreError(e, 'sentinel.store.ownerClosed')); } });
  unregister();
  owner.close();
  assert.deepEqual(order, ['objects', 'ledger']);
  assert.deepEqual(seen, ['sentinel.store.ownedElsewhere']);
  assert.equal(probeOwnership(store).outcome, 'acquired');
});

test('a failing resource is reported and the lock is still released', async () => {
  const store = freshStore();
  const owner = await acquireStoreOwner(store);
  owner.registerResource({ name: 'broken', close() { throw new Error('synthetic close failure'); } });
  assert.throws(() => owner.close(), (e: unknown) => isStoreError(e, 'sentinel.store.resourceCloseFailed')
    && JSON.stringify((e as any).detail.resources) === '["broken"]');
  assert.equal(probeOwnership(store).outcome, 'acquired');
});

test('replacing the store folder or the lock file while held is ownership lost', async () => {
  const store = freshStore();
  const owner = await acquireStoreOwner(store);
  renameSync(store, `${store}-moved`);
  assert.throws(() => owner.assertHeld(), (e: unknown) => isStoreError(e, 'sentinel.store.identityChanged'));
  assert.throws(() => owner.assertHeld(), (e: unknown) => isStoreError(e, 'sentinel.store.ownerLost'));
  owner.close();

  const store2 = freshStore();
  const owner2 = await acquireStoreOwner(store2);
  renameSync(join(store2, 'owner.sqlite'), join(store2, 'owner-old.sqlite'));
  writeFileSync(join(store2, 'owner.sqlite'), '', { mode: 0o600 });
  assert.throws(() => owner2.assertHeld(), (e: unknown) => isStoreError(e, 'sentinel.store.identityChanged'));
  owner2.close();
});

test('waitMs is bounded', async () => {
  await assert.rejects(() => acquireStoreOwner(freshStore(), { waitMs: -1 }), RangeError);
  await assert.rejects(() => acquireStoreOwner(freshStore(), { waitMs: 10_001 }), RangeError);
});

test('hazard, pinned: opening and closing owner.sqlite in the owning process drops the OS lock', async () => {
  // POSIX advisory locks belong to the process; this is why only owner.ts may open the lock file. assertHeld()
  // cannot see the loss (SQLite still believes it holds the lock), so the rule is enforced by review, not code.
  const store = freshStore();
  const owner = await acquireStoreOwner(store);
  assert.equal(probeOwnership(store).outcome, 'refused');
  readFileSync(join(store, 'owner.sqlite'));
  assert.equal(probeOwnership(store).outcome, 'acquired');
  owner.close();
});

test('the epoch and store id are the coordinatorEpoch and store label of the shared attempt contract', async () => {
  const owner = await acquireStoreOwner(freshStore());
  try {
    const fixture = JSON.parse(readFileSync(new URL('./contracts/valid/attempt-running.json', import.meta.url), 'utf8'));
    fixture.coordinatorEpoch = owner.epoch;
    fixture.worker.ownershipLabels = { ...fixture.worker.ownershipLabels, store: owner.storeId, epoch: owner.epoch };
    const checked = validateEnvelope('attempt', fixture);
    assert.equal(checked.ok, true, JSON.stringify(checked));
  } finally { owner.close(); }
});

test('a failed descriptor publication rolls the whole acquisition back: same-process retry and other processes succeed', async () => {
  const store = freshStore();
  (await acquireStoreOwner(store)).close();
  mkdirSync(join(store, 'owner.json'), { mode: 0o700 }); // renaming the descriptor over a folder fails
  await assert.rejects(acquireStoreOwner(store), (e: unknown) => isStoreError(e, 'sentinel.store.ioFailure')
    && (e as any).detail.operation === 'write-descriptor');
  assert.deepEqual(readdirSync(store).filter(f => f.endsWith('.tmp')), [], 'no descriptor temp file is left');
  // Another process gets past the lock (so it was released) and then meets the same folder-shaped descriptor.
  assert.deepEqual(probeOwnership(store), { outcome: 'refused', code: 'sentinel.store.ioFailure' }, 'the OS lock was released');
  rmSync(join(store, 'owner.json'), { recursive: true });
  const retry = await acquireStoreOwner(store);
  retry.assertHeld();
  assert.deepEqual(probeOwnership(store), { outcome: 'refused', code: 'sentinel.store.ownedElsewhere' });
  retry.close();
  assert.equal(probeOwnership(store).outcome, 'acquired');
});
