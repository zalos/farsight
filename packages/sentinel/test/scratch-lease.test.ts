// A run's scratch lease inside the exact held store: made only from a genuine store along a chain re-checked at
// every step, and removed only where the lease can tie a folder to a consumer it watched stop. Everything else is
// kept. Removal is bounded from its first read and fenced before every destructive step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { openScratchLease, releaseScratchLease } from '../dist/service/scratch-lease.js';
import { ContainerBackend } from '../dist/execution/isolation.js';
import { executeRun } from '../dist/service/canonical.js';
import { frameworkFixture } from './framework-canonical-helpers.ts';
import { ORDER } from './express-fixtures.ts';
import { needsStore, openCaptureStore, scratch } from './snapshot-helpers.ts';

const mode = (p: string) => statSync(p).mode & 0o777;
const reason = (r: any) => (r.removed ? 'removed' : r.reason);

/**
 * A real client configuration folder made by the execution layer inside the lease, through an original inert
 * stand-in for the docker client that answers `version` and an unqualified `info`, so connect refuses after both
 * clients exited. No container runtime is contacted.
 */
async function realClientConfig(t: any, dir: string, lease: any): Promise<string> {
  const fake = join(dir, 'fake-docker');
  writeFileSync(
    fake,
    '#!/bin/sh\ncase "$1" in version) echo \'{"Os":"linux","Arch":"x86_64","Version":"0"}\';; info) echo \'{"OperatingSystem":"inert"}\';; esac\n',
    { mode: 0o700 },
  );
  const saved = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = 'unix:///nonexistent-inert.sock';
  try {
    await assert.rejects(
      ContainerBackend.connect({ privateDir: lease.path, docker: fake, wrapRunner: lease.wrapRunner }),
    );
  } finally {
    if (saved === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = saved;
  }
  const configs = readdirSync(lease.path).filter((n) => n.startsWith('docker-config-'));
  assert.equal(configs.length, 1);
  return join(lease.path, configs[0]!);
}

test('a lease is made only inside a genuine held store, one private level at a time', needsStore, async (t) => {
  const dir = scratch(t);
  const fx = await openCaptureStore(t, dir);
  const lease = openScratchLease(fx.store);
  assert.match(lease.path, new RegExp(`^${fx.storePath}/scratch/${fx.store.epoch}/w-[0-9a-f]{24}$`));
  for (const p of [join(fx.storePath, 'scratch'), join(fx.storePath, 'scratch', fx.store.epoch), lease.path])
    assert.equal(mode(p), 0o700, p);
  assert.throws(() => openScratchLease(Object.create(fx.store)), /not a store opened by openStore/);
  assert.throws(() => openScratchLease({ ...fx.store } as any), /not a store opened by openStore/);
  // A copy of the lease is not a lease: releasing it removes nothing.
  assert.deepEqual(releaseScratchLease(fx.store, { ...lease }), {
    removed: false,
    reason: 'consumerUnknown',
    partial: false,
    lease: '',
  });
  assert.ok(existsSync(lease.path));
  assert.deepEqual(releaseScratchLease(fx.store, lease), { removed: true });
  assert.equal(existsSync(lease.path), false);
  assert.equal(existsSync(join(fx.storePath, 'scratch', fx.store.epoch)), false, 'an empty epoch folder goes too');
  fx.store.close();
  assert.throws(
    () => openScratchLease(fx.store),
    (e: any) => e.code === 'sentinel.store.ownerClosed',
  );
});

test(
  'a scratch folder that is a link, or an ancestor swapped for a link while the lease is made, mints nothing',
  needsStore,
  async (t) => {
    const dir = scratch(t);
    const fx = await openCaptureStore(t, dir);
    mkdirSync(join(dir, 'elsewhere'), { mode: 0o700 });
    symlinkSync(join(dir, 'elsewhere'), join(fx.storePath, 'scratch'));
    assert.throws(
      () => openScratchLease(fx.store),
      (e: any) => e.code === 'sentinel.store.scratchUnsafe',
    );
    assert.deepEqual(readdirSync(join(dir, 'elsewhere')), [], 'nothing made through the link');
    fs.unlinkSync(join(fx.storePath, 'scratch'));
    // The parent replaced by a link to an outside folder just as the epoch folder is made.
    const parent = join(fx.storePath, 'scratch'),
      outside = join(dir, 'outside');
    mkdirSync(outside, { mode: 0o700 });
    const original = fs.mkdirSync;
    let swapped = false;
    fs.mkdirSync = ((path: any, ...args: any[]) => {
      if (String(path) === join(parent, fx.store.epoch) && !swapped) {
        swapped = true;
        renameSync(parent, `${parent}.original`);
        symlinkSync(outside, parent);
      }
      return (original as any)(path, ...args);
    }) as any;
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => openScratchLease(fx.store),
        (e: any) => e.code === 'sentinel.store.scratchUnsafe',
      );
    } finally {
      fs.mkdirSync = original;
      syncBuiltinESMExports();
    }
    assert.ok(swapped);
  },
);

test(
  'only a client configuration folder the execution layer made for this lease is removed, after its clients exit',
  needsStore,
  async (t) => {
    const dir = scratch(t);
    const fx = await openCaptureStore(t, dir);
    const lease = openScratchLease(fx.store);
    const config = await realClientConfig(t, dir, lease);
    writeFileSync(join(config, 'config.json'), '{}');
    assert.deepEqual(releaseScratchLease(fx.store, lease), { removed: true });
    assert.equal(existsSync(lease.path), false);
    // The same name made by anyone else is not associated, even with a wrapped runner.
    const other = openScratchLease(fx.store);
    other.wrapRunner({ run: async () => ({}) as any, runSync: () => ({}) as any, start: () => ({}) as any });
    mkdirSync(join(other.path, 'docker-config-forged'));
    assert.equal(reason(releaseScratchLease(fx.store, other)), 'consumerUnknown');
    // The real folder replaced by another of the same name is not the one that was made.
    const third = openScratchLease(fx.store);
    const made = await realClientConfig(t, dir, third);
    renameSync(made, `${made}.moved`);
    mkdirSync(made);
    assert.equal(reason(releaseScratchLease(fx.store, third)), 'consumerUnknown');
    assert.ok(existsSync(`${made}.moved`));
  },
);

test('a running client keeps even an empty lease; it is released once the client exits', needsStore, async (t) => {
  const dir = scratch(t);
  const fx = await openCaptureStore(t, dir);
  const lease = openScratchLease(fx.store);
  let finish!: () => void;
  const wrapped = lease.wrapRunner({
    run: () =>
      new Promise<any>((r) => {
        finish = () => r({ exitCode: 0 });
      }),
    runSync: () => ({}) as any,
    start: () => ({}) as any,
  });
  const pending = wrapped.run(['version']);
  assert.equal(reason(releaseScratchLease(fx.store, lease)), 'consumerNotStopped');
  finish();
  await pending;
  assert.deepEqual(releaseScratchLease(fx.store, lease), { removed: true });
});

test(
  'an attempt folder, restore, parser folder or stray file keeps the lease, whatever the ledger says',
  needsStore,
  async (t) => {
    const f = await frameworkFixture(t, ORDER);
    const unit = f.admitted.plan.units[0]!;
    const [attempt] = f.store.ledger.listAttempts({ id: unit.id, revision: unit.revision });
    assert.ok(attempt && attempt.state !== 'running');
    for (const name of [
      `${attempt.id}-${randomUUID()}`,
      `prep.${attempt.id}.${randomUUID()}`,
      `inputs.${f.store.epoch}.${randomUUID()}`,
      'parse-x1',
    ]) {
      const lease = openScratchLease(f.store);
      mkdirSync(join(lease.path, name));
      assert.equal(reason(releaseScratchLease(f.store, lease)), 'consumerUnknown', name);
      assert.ok(existsSync(join(lease.path, name)));
    }
    const file = openScratchLease(f.store);
    writeFileSync(join(file.path, 'stray'), 'x');
    assert.equal(reason(releaseScratchLease(f.store, file)), 'consumerUnknown');
    // A genuine run through a lease leaves nothing its own consumers did not remove, so the lease goes.
    const run = openScratchLease(f.store);
    const summary = await executeRun(f.store, f.runId, {
      scratchRoot: run.path,
      wrapRunner: run.wrapRunner,
      trustDir: f.ws.trustDir,
    });
    assert.equal(summary.state, 'completed');
    assert.deepEqual(releaseScratchLease(f.store, run), { removed: true });
  },
);

test(
  'the hold lost after one deletion stops every later destructive step; what is left stays, reported partial',
  needsStore,
  async (t) => {
    const dir = scratch(t);
    const fx = await openCaptureStore(t, dir);
    const lease = openScratchLease(fx.store);
    const config = await realClientConfig(t, dir, lease);
    for (const n of ['a', 'b', 'c']) writeFileSync(join(config, n), 'original inert file');
    const original = fs.unlinkSync;
    let deleted = 0;
    fs.unlinkSync = ((path: any) => {
      original(path);
      if (String(path).startsWith(`${config}/`) && ++deleted === 1) fx.store.close();
    }) as any;
    syncBuiltinESMExports();
    let r: any;
    try {
      r = releaseScratchLease(fx.store, lease);
    } finally {
      fs.unlinkSync = original;
      syncBuiltinESMExports();
    }
    assert.deepEqual([r.removed, r.reason, r.partial], [false, 'ownerNotHeld', true]);
    assert.equal(deleted, 1, 'no second delete after the hold is gone');
    assert.equal(readdirSync(config).length, 2);
  },
);

test(
  'without the hold, or with its folder swapped for a link, nothing is removed and nothing outside is touched',
  needsStore,
  async (t) => {
    const dir = scratch(t);
    const fx = await openCaptureStore(t, dir);
    const outside = join(dir, 'outside');
    mkdirSync(outside, { mode: 0o500 });
    const lease = openScratchLease(fx.store);
    renameSync(lease.path, `${lease.path}.moved`);
    symlinkSync(outside, lease.path);
    assert.equal(reason(releaseScratchLease(fx.store, lease)), 'leaseChanged');
    assert.equal(mode(outside), 0o500, 'no chmod through the link');
    assert.ok(lstatSync(lease.path).isSymbolicLink());
    const kept = openScratchLease(fx.store);
    fx.store.close();
    assert.equal(reason(releaseScratchLease(fx.store, kept)), 'ownerNotHeld');
    assert.ok(existsSync(kept.path));
  },
);

test('removal is bounded from the first read; a caller can only tighten the budget', needsStore, async (t) => {
  const dir = scratch(t);
  const fx = await openCaptureStore(t, dir);
  const lease = openScratchLease(fx.store);
  const config = await realClientConfig(t, dir, lease);
  for (let i = 0; i < 40; i++) writeFileSync(join(config, `f${i}`), 'x');
  const r = releaseScratchLease(fx.store, lease, { maxEntries: 10 }) as any;
  assert.deepEqual([r.removed, r.reason, r.partial], [false, 'budgetExhausted', true]);
  const left = readdirSync(config).length;
  assert.ok(left >= 31 && left < 40, `some removed, the rest kept: ${left}`);
  // NaN, Infinity, negative and fractional limits never loosen the default; the default still removes it all.
  assert.deepEqual(
    releaseScratchLease(fx.store, lease, { maxEntries: Number.NaN, maxDepth: Infinity, maxMs: -1 } as any),
    { removed: true },
  );
  // Too deep a tree stops at the depth bound.
  const deep = openScratchLease(fx.store);
  const deepConfig = await realClientConfig(t, dir, deep);
  let p = deepConfig;
  for (let i = 0; i < 6; i++) p = join(p, 'd');
  mkdirSync(p, { recursive: true });
  assert.equal(reason(releaseScratchLease(fx.store, deep, { maxDepth: 3 })), 'budgetExhausted');
});

test(
  'a link inside a removable folder is removed as a link; its target outside keeps its mode and contents',
  needsStore,
  async (t) => {
    const dir = scratch(t);
    const fx = await openCaptureStore(t, dir);
    const outside = join(dir, 'target');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep'), 'x');
    chmodSync(outside, 0o500);
    const lease = openScratchLease(fx.store);
    const config = await realClientConfig(t, dir, lease);
    symlinkSync(outside, join(config, 'link'));
    chmodSync(config, 0o500);
    assert.deepEqual(releaseScratchLease(fx.store, lease), { removed: true });
    assert.equal(mode(outside), 0o500);
    assert.deepEqual(readdirSync(outside), ['keep']);
    chmodSync(outside, 0o700);
  },
);
