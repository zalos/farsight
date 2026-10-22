// A run's scratch lease inside the exact held store: made only from a genuine store, removed only when every
// consumer tied to it is proven stopped by the store's own lifecycle records, and removed by a bounded post-order
// walk that never follows a link out of the lease.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openScratchLease, releaseScratchLease, attemptOf } from '../dist/service/scratch-lease.js';
import { executeRun } from '../dist/service/canonical.js';
import { frameworkFixture } from './framework-canonical-helpers.ts';
import { ORDER } from './express-fixtures.ts';
import { needsStore, openCaptureStore, scratch } from './snapshot-helpers.ts';

const mode = (p: string) => statSync(p).mode & 0o777;

/** A real run's ended attempt of this store and epoch, to name lease children after. */
async function endedAttempt(t: any) {
  const f = await frameworkFixture(t, ORDER);
  const unit = f.admitted.plan.units[0]!;
  const [attempt] = f.store.ledger.listAttempts({ id: unit.id, revision: unit.revision });
  assert.ok(attempt && attempt.state !== 'running');
  return { ...f, attemptId: attempt.id };
}

test('a lease is made only inside a genuine held store, one private level at a time', needsStore, async t => {
  const dir = scratch(t);
  const fx = await openCaptureStore(t, dir);
  const lease = openScratchLease(fx.store);
  assert.match(lease.path, new RegExp(`^${fx.storePath}/scratch/${fx.store.epoch}/w-[0-9a-f]{24}$`));
  for (const p of [join(fx.storePath, 'scratch'), join(fx.storePath, 'scratch', fx.store.epoch), lease.path]) assert.equal(mode(p), 0o700, p);
  assert.throws(() => openScratchLease(Object.create(fx.store)), /not a store opened by openStore/);
  assert.throws(() => openScratchLease({ ...fx.store } as any), /not a store opened by openStore/);
  // A copy of the lease is not a lease: releasing it removes nothing.
  assert.deepEqual(releaseScratchLease(fx.store, { ...lease }), { removed: false, reason: 'consumerUnknown', partial: false, lease: '' });
  assert.ok(existsSync(lease.path));
  assert.deepEqual(releaseScratchLease(fx.store, lease), { removed: true });
  assert.equal(existsSync(lease.path), false);
  assert.equal(existsSync(join(fx.storePath, 'scratch', fx.store.epoch)), false, 'an empty epoch folder goes too');
  fx.store.close();
  assert.throws(() => openScratchLease(fx.store), (e: any) => e.code === 'sentinel.store.ownerClosed');
});

test('a scratch folder that is a link or open to others refuses a lease', needsStore, async t => {
  const dir = scratch(t);
  const fx = await openCaptureStore(t, dir);
  mkdirSync(join(dir, 'elsewhere'), { mode: 0o700 });
  symlinkSync(join(dir, 'elsewhere'), join(fx.storePath, 'scratch'));
  assert.throws(() => openScratchLease(fx.store), (e: any) => e.code === 'sentinel.store.scratchUnsafe');
  assert.deepEqual(readdirSync(join(dir, 'elsewhere')), [], 'nothing made through the link');
});

test('a genuine run releases its own lease; a stopped attempt\'s sealed folders go with it', needsStore, async t => {
  const f = await endedAttempt(t);
  const lease = openScratchLease(f.store);
  const work = join(lease.path, `${f.attemptId}-${randomUUID()}`);
  mkdirSync(join(work, 'input', 'deep'), { recursive: true });
  writeFileSync(join(work, 'input', 'deep', 'a.ts'), 'x');
  chmodSync(join(work, 'input', 'deep'), 0o500);
  chmodSync(join(work, 'input'), 0o500);
  const prep = join(lease.path, `prep.${f.attemptId}.${randomUUID()}`);
  mkdirSync(prep);
  assert.equal(attemptOf(prep.slice(prep.lastIndexOf('/') + 1)), f.attemptId);
  assert.deepEqual(releaseScratchLease(f.store, lease), { removed: true });
  assert.equal(existsSync(lease.path), false);
  // An actual run through a lease, with its wrapped runner, ends with the lease removed.
  const run = openScratchLease(f.store);
  const summary = await executeRun(f.store, f.runId, { scratchRoot: run.path, wrapRunner: run.wrapRunner, trustDir: f.ws.trustDir });
  assert.equal(summary.state, 'completed');
  assert.deepEqual(releaseScratchLease(f.store, run), { removed: true });
});

test('a consumer tied to the lease that is not proven stopped retains it; unrelated records neither block nor certify', needsStore, async t => {
  const f = await endedAttempt(t);
  const journal = join(f.store.storePath, 'execution');
  // A terminal-unknown record for this attempt existed before the lease: an unchanged listing is no proof.
  writeFileSync(join(journal, 'unknown', `workers.${f.attemptId}.json`), '{}', { mode: 0o600 });
  const first = openScratchLease(f.store);
  mkdirSync(join(first.path, `${f.attemptId}-${randomUUID()}`));
  assert.deepEqual(releaseScratchLease(f.store, first), { removed: false, reason: 'consumerNotStopped', partial: false, lease: `${f.store.epoch}/${first.path.split('/').pop()}` });
  assert.ok(existsSync(first.path));
  // A worker record of another attempt is unrelated: a lease whose own consumers stopped is still released.
  writeFileSync(join(journal, 'unknown', 'workers.attempt-unrelated.json'), '{}', { mode: 0o600 });
  const clean = openScratchLease(f.store);
  assert.deepEqual(releaseScratchLease(f.store, clean), { removed: true });
  // A record that names no attempt could be anyone's: it retains, it never certifies.
  writeFileSync(join(journal, 'unknown', 'intents.unattributed.json'), '{}', { mode: 0o600 });
  const uncertain = openScratchLease(f.store);
  assert.equal((releaseScratchLease(f.store, uncertain) as any).reason, 'storeUncertain');
  assert.ok(existsSync(uncertain.path));
});

test('an attempt still running, not yet recorded, or of another epoch retains the lease', needsStore, async t => {
  const f = await endedAttempt(t);
  for (const [name, reason] of [[`attempt-never-recorded-${randomUUID()}`, 'consumerUnknown'], [`inputs.${f.store.epoch}.${randomUUID()}`, 'consumerUnknown'],
    [`parse-x1`, 'consumerUnknown']] as const) {
    const lease = openScratchLease(f.store);
    mkdirSync(join(lease.path, name));
    assert.equal((releaseScratchLease(f.store, lease) as any).reason, reason, name);
    assert.ok(existsSync(join(lease.path, name)));
  }
  const file = openScratchLease(f.store);
  writeFileSync(join(file.path, 'stray'), 'x');
  assert.equal((releaseScratchLease(f.store, file) as any).reason, 'consumerUnknown');
});

test('a container client still running retains the lease until it exits; an unseen client config retains it', needsStore, async t => {
  const dir = scratch(t);
  const fx = await openCaptureStore(t, dir);
  const lease = openScratchLease(fx.store);
  let finish!: () => void;
  const runner = { run: () => new Promise<any>(r => { finish = () => r({ exitCode: 0 }); }), runSync: () => ({}) as any, start: () => ({}) as any };
  const wrapped = lease.wrapRunner(runner as any);
  mkdirSync(join(lease.path, 'docker-config-abc'));
  const pending = wrapped.run(['version']);
  assert.equal((releaseScratchLease(fx.store, lease) as any).reason, 'consumerNotStopped');
  finish(); await pending;
  assert.deepEqual(releaseScratchLease(fx.store, lease), { removed: true });
  const unseen = openScratchLease(fx.store);
  mkdirSync(join(unseen.path, 'docker-config-zzz'));
  assert.equal((releaseScratchLease(fx.store, unseen) as any).reason, 'consumerUnknown');
});

test('without the hold, or with its folder swapped for a link, nothing is removed and nothing outside is touched', needsStore, async t => {
  const dir = scratch(t);
  const fx = await openCaptureStore(t, dir);
  const outside = join(dir, 'outside');
  mkdirSync(outside, { mode: 0o500 });
  const lease = openScratchLease(fx.store);
  renameSync(lease.path, `${lease.path}.moved`);
  symlinkSync(outside, lease.path);
  assert.equal((releaseScratchLease(fx.store, lease) as any).reason, 'leaseChanged');
  assert.equal(mode(outside), 0o500, 'no chmod through the link');
  assert.ok(lstatSync(lease.path).isSymbolicLink());
  const kept = openScratchLease(fx.store);
  fx.store.close();
  assert.equal((releaseScratchLease(fx.store, kept) as any).reason, 'ownerNotHeld');
  assert.ok(existsSync(kept.path));
});

test('removal is bounded: at its limit it stops, says what is partial, and never makes a second pass', needsStore, async t => {
  const f = await endedAttempt(t);
  const lease = openScratchLease(f.store);
  const work = join(lease.path, `${f.attemptId}-${randomUUID()}`);
  mkdirSync(work);
  for (let i = 0; i < 40; i++) writeFileSync(join(work, `f${i}`), 'x');
  const r = releaseScratchLease(f.store, lease, { maxEntries: 10, maxDepth: 256, maxMs: 30_000 }) as any;
  assert.deepEqual([r.removed, r.reason, r.partial], [false, 'budgetExhausted', true]);
  const left = readdirSync(work).length;
  assert.ok(left >= 30 && left < 40, `some removed, the rest kept: ${left}`);
  // Too deep a tree stops at the depth bound the same way.
  const deep = openScratchLease(f.store);
  let p = join(deep.path, `${f.attemptId}-${randomUUID()}`);
  for (let i = 0; i < 6; i++) { p = join(p, 'd'); }
  mkdirSync(p, { recursive: true });
  assert.equal((releaseScratchLease(f.store, deep, { maxEntries: 1000, maxDepth: 3, maxMs: 30_000 }) as any).reason, 'budgetExhausted');
});

test('a link inside the lease is removed as a link; its target outside keeps its mode and contents', needsStore, async t => {
  const f = await endedAttempt(t);
  const outside = join(f.dir, 'target');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep'), 'x');
  chmodSync(outside, 0o500);
  const lease = openScratchLease(f.store);
  const work = join(lease.path, `${f.attemptId}-${randomUUID()}`);
  mkdirSync(work);
  symlinkSync(outside, join(work, 'link'));
  assert.deepEqual(releaseScratchLease(f.store, lease), { removed: true });
  assert.equal(mode(outside), 0o500);
  assert.deepEqual(readdirSync(outside), ['keep']);
  chmodSync(outside, 0o700);
});
