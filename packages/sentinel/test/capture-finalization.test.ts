// Exact private association and genuine service interruption. These tests never execute captured application code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openScratchLease, releaseScratchLease } from '../dist/service/scratch-lease.js';
import { ContainerBackend } from '../dist/execution/isolation.js';
import { needsStore, openCaptureStore, scratch } from './snapshot-helpers.ts';
import { frameworkFixture } from './framework-canonical-helpers.ts';
import { ORDER } from './express-fixtures.ts';
import { confirmForService } from '../dist/service/local.js';
import { connectService, readServiceDescriptor } from '../dist/service/owner-service.js';
import { openStore } from '../dist/store/index.js';
import { executeRun } from '../dist/service/canonical.js';

async function associated(t: any, dir: string, lease: any) {
  const docker = join(dir, 'original-inert-docker');
  fs.writeFileSync(
    docker,
    '#!/bin/sh\ncase "$1" in version) echo \'{"Os":"linux","Arch":"x86_64","Version":"0"}\';; info) echo \'{"OperatingSystem":"inert"}\';; esac\n',
    { mode: 0o700 },
  );
  const prior = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = 'unix:///nonexistent-inert.sock';
  try {
    await assert.rejects(ContainerBackend.connect({ privateDir: lease.path, docker, wrapRunner: lease.wrapRunner }));
  } finally {
    if (prior === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = prior;
  }
  const names = fs.readdirSync(lease.path);
  assert.equal(names.length, 1);
  return join(lease.path, names[0]!);
}

test('associated stopped client config removes; a changed or retargeted config is retained', needsStore, async (t) => {
  const dir = scratch(t, 'capture-final-config-'),
    f = await openCaptureStore(t, dir);
  const safe = openScratchLease(f.store);
  await associated(t, dir, safe);
  assert.deepEqual(releaseScratchLease(f.store, safe), { removed: true });
  for (const link of [false, true]) {
    const lease = openScratchLease(f.store),
      config = await associated(t, dir, lease),
      moved = config + '.original';
    fs.renameSync(config, moved);
    if (link) fs.symlinkSync(moved, config);
    else fs.mkdirSync(config);
    assert.deepEqual([releaseScratchLease(f.store, lease).removed, fs.existsSync(moved)], [false, true]);
    assert.ok(fs.existsSync(config));
  }
});

test(
  'genuine hold loss after first associated unlink permits no later chmod, unlink or rmdir',
  needsStore,
  async (t) => {
    const dir = scratch(t, 'capture-final-fence-'),
      f = await openCaptureStore(t, dir),
      lease = openScratchLease(f.store),
      config = await associated(t, dir, lease);
    for (const n of ['a', 'b', 'c']) fs.writeFileSync(join(config, n), 'original inert file');
    const original = { unlink: fs.unlinkSync, chmod: fs.fchmodSync, rmdir: fs.rmdirSync };
    let closed = false,
      removed = 0;
    const after: string[] = [];
    fs.unlinkSync = ((p: any) => {
      if (closed) after.push('unlink');
      original.unlink(p);
      if (String(p).startsWith(config + '/') && ++removed === 1) {
        f.store.close();
        closed = true;
      }
    }) as any;
    fs.fchmodSync = ((...args: any[]) => {
      if (closed) after.push('fchmod');
      return (original.chmod as any)(...args);
    }) as any;
    fs.rmdirSync = ((...args: any[]) => {
      if (closed) after.push('rmdir');
      return (original.rmdir as any)(...args);
    }) as any;
    syncBuiltinESMExports();
    let result: any;
    try {
      result = releaseScratchLease(f.store, lease);
    } finally {
      fs.unlinkSync = original.unlink;
      fs.fchmodSync = original.chmod;
      fs.rmdirSync = original.rmdir;
      syncBuiltinESMExports();
    }
    assert.equal(removed, 1);
    assert.deepEqual(after, []);
    assert.deepEqual([result.removed, result.reason, result.partial], [false, 'ownerNotHeld', true]);
    assert.equal(fs.readdirSync(config).length, 2);
  },
);

test(
  'an unassociated child appearing before final rmdir is retained without a recursive second pass',
  needsStore,
  async (t) => {
    const dir = scratch(t, 'capture-final-race-'),
      f = await openCaptureStore(t, dir),
      lease = openScratchLease(f.store);
    await associated(t, dir, lease);
    const original = fs.rmdirSync;
    let inserted = false;
    const keep = join(lease.path, 'original-late-child');
    fs.rmdirSync = ((p: any, ...args: any[]) => {
      if (String(p) === lease.path && !inserted) {
        inserted = true;
        fs.mkdirSync(keep);
        fs.writeFileSync(join(keep, 'retain'), 'original inert bytes');
      }
      return (original as any)(p, ...args);
    }) as any;
    syncBuiltinESMExports();
    let result: any;
    try {
      result = releaseScratchLease(f.store, lease);
    } finally {
      fs.rmdirSync = original;
      syncBuiltinESMExports();
    }
    assert.ok(inserted);
    assert.deepEqual([result.removed, result.partial], [false, true]);
    assert.equal(fs.readFileSync(join(keep, 'retain'), 'utf8'), 'original inert bytes');
  },
);

test(
  'SIGKILL of the real owner during genuine framework preparation retains its old lease; restart publishes once',
  needsStore,
  async (t) => {
    const f = await frameworkFixture(t, ORDER, { run: false }),
      unit = f.admitted.plan.units[0]!;
    f.store.close();
    const child = spawn(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        fileURLToPath(new URL('./helpers/capture-preparation-child.ts', import.meta.url)),
        f.path,
      ],
      { env: { ...process.env, XDG_STATE_HOME: join(f.dir, 'owner') }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const stopped = new Promise<void>((resolve) => child.once('close', () => resolve()));
    let err = '',
      pending = '';
    const messages: any[] = [];
    child.stderr!.on('data', (b) => {
      err = (err + String(b)).slice(-4000);
    });
    child.stdout!.on('data', (b) => {
      pending += String(b);
      for (let n; (n = pending.indexOf('\n')) >= 0;) {
        const line = pending.slice(0, n);
        pending = pending.slice(n + 1);
        if (line) messages.push(JSON.parse(line));
      }
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await stopped;
      }
    });
    const phase = async (name: string) => {
      const until = Date.now() + 30000;
      for (;;) {
        const found = messages.find((m) => m.phase === name);
        if (found) return found;
        assert.ok(child.exitCode === null && child.signalCode === null, err);
        assert.ok(Date.now() < until, 'service phase ' + name + ': ' + err);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await phase('listening');
    const request = async (op: string, body: any) => {
      const client = await connectService(f.ws);
      assert.ok(client);
      try {
        return await client.request(op, body);
      } finally {
        client.close();
      }
    };
    const plan: any = await request('run.describe', { runId: f.runId });
    const receipt = confirmForService(f.ws, {
      command: 'run',
      action: 'run.start',
      plan,
      planId: f.runId,
      confirm: true,
      now: new Date(),
      storeId: readServiceDescriptor(f.ws)!.storeId,
    });
    assert.ok('receiptId' in receipt);
    const start: any = await request('run.start', { planId: f.runId, receiptId: receipt.receiptId });
    assert.equal(start.outcome, 'submitted');
    const prep = await phase('preparing');
    assert.equal(dirname(prep.path), prep.lease);
    assert.ok(prep.lease.startsWith(f.ws.storePath + '/scratch/'));
    const identity = fs.lstatSync(prep.lease, { bigint: true });
    child.kill('SIGKILL');
    await stopped;
    const store = await openStore(f.ws.storePath);
    t.after(() => {
      if (store.held) store.close();
    });
    assert.equal(store.ledger.listAttempts(unit).length, 0, 'killed before the supervisor/attempt-start boundary');
    assert.equal(
      fs.readFileSync(join(prep.path, 'preparation-in-progress'), 'utf8'),
      'original inert preparation marker',
    );
    // Captured bytes still drive restart; no application checkout is needed and prior-epoch unknown prep stays private.
    for (const path of Object.keys(ORDER)) if (path.endsWith('.ts')) fs.rmSync(join(f.path, path), { force: true });
    const next = openScratchLease(store);
    try {
      const result = await executeRun(store, f.runId, {
        scratchRoot: next.path,
        wrapRunner: next.wrapRunner,
        trustDir: f.ws.trustDir,
      });
      assert.equal(result.state, 'completed', JSON.stringify(result.failures));
      assert.ok(store.ledger.getPublication(unit));
      assert.equal(store.ledger.listAttempts(unit).length, 1);
    } finally {
      assert.deepEqual(releaseScratchLease(store, next), { removed: true });
    }
    const retained = fs.lstatSync(prep.lease, { bigint: true });
    assert.deepEqual([retained.dev, retained.ino], [identity.dev, identity.ino]);
    assert.ok(fs.existsSync(join(prep.path, 'preparation-in-progress')));
  },
);
