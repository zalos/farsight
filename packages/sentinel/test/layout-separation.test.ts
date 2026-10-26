// Owner trust state and the service's runtime folder never live in the source Sentinel captures. Each is checked
// against the real source roots by the caller that knows them, before anything is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { IpcError, newOwnerNonce, runtimeAddress } from '../dist/transport/ipc.js';
import { assertTrustOutside } from '../dist/policy/adoption.js';
import { loadPolicyInputs } from '../dist/policy/index.js';
import { adoptedPolicy, checkWorkspaceLayout, receiptBook, workspaceOf } from '../dist/service/local.js';
import { serveWorkspace } from '../dist/service/owner-service.js';
import { initWorkspace } from '../dist/cli/init.js';
import { openStore } from '../dist/store/index.js';
import { commitRepo, needsStore, scratch } from './snapshot-helpers.ts';

const policyCode = (code: string) => (e: any) => e?.code === code;
const ipcCode = (code: string) => (e: unknown) => e instanceof IpcError && e.code === code;

test('a trust folder that is, holds or lies inside the checkout is refused with nothing created', (t) => {
  const dir = scratch(t);
  const ws = join(dir, 'workspace');
  mkdirSync(ws);
  for (const [name, trust] of [
    ['inside', join(ws, 'state', 'trust')],
    ['equal', ws],
    ['holds', dir],
  ] as const) {
    const w = workspaceOf(ws, { ...process.env, XDG_STATE_HOME: '/unused' });
    const at = { ...w, trustDir: trust };
    assert.throws(() => checkWorkspaceLayout(at), policyCode('sentinel.policy.trustDirInsideWorkspace'), name);
    assert.throws(() => adoptedPolicy(at), policyCode('sentinel.policy.trustDirInsideWorkspace'), name);
    assert.throws(() => receiptBook(at), policyCode('sentinel.policy.trustDirInsideWorkspace'), name);
    assert.throws(
      () => loadPolicyInputs({ workspace: ws, trustDir: trust }),
      policyCode('sentinel.policy.trustDirInsideWorkspace'),
      name,
    );
  }
  assert.equal(existsSync(join(ws, 'state')), false, 'nothing made inside the checkout');
  assert.deepEqual(readdirSync(ws), []);
  // The default owner state, configured inside the checkout through XDG_STATE_HOME, is the same refusal.
  const viaEnv = workspaceOf(ws, { ...process.env, XDG_STATE_HOME: join(ws, '.state') });
  assert.throws(() => adoptedPolicy(viaEnv), policyCode('sentinel.policy.trustDirInsideWorkspace'));
  assert.equal(existsSync(join(ws, '.state')), false);
  // A trust folder reached through a link is refused before anything is made, as an unsafe folder.
  mkdirSync(join(dir, 'real'));
  symlinkSync(join(dir, 'real'), join(dir, 'linked'));
  assert.throws(
    () => checkWorkspaceLayout({ ...viaEnv, trustDir: join(dir, 'linked', 'trust') }),
    policyCode('sentinel.policy.trustDirUnsafe'),
  );
  assert.deepEqual(readdirSync(join(dir, 'real')), []);
  // Disjoint: accepted and made.
  const ok = { ...viaEnv, trustDir: join(dir, 'owner', 'trust') };
  checkWorkspaceLayout(ok);
  assert.equal(existsSync(join(dir, 'owner')), false, 'the check itself creates nothing');
  receiptBook(ok);
  assert.ok(existsSync(join(dir, 'owner', 'trust', 'receipts')));
});

test('the separation helper checks every source a caller captures, not only the first', (t) => {
  const dir = scratch(t);
  const a = join(dir, 'a'),
    b = join(dir, 'b');
  mkdirSync(a);
  mkdirSync(b);
  assertTrustOutside(join(dir, 'trust'), a, b);
  assert.throws(
    () => assertTrustOutside(join(b, 'nested', 'trust'), a, b),
    policyCode('sentinel.policy.trustDirInsideWorkspace'),
  );
  assertTrustOutside(join(dir, 'a-trust'), a, b); // a prefix neighbour is not inside
});

test('a reached runtime candidate inside the source refuses before anything is made; a disjoint one is used', (t) => {
  const dir = scratch(t, 'snl-');
  const ws = join(dir, 'ws');
  mkdirSync(join(ws, '.farsight', 'custom'), { recursive: true });
  const nonce = newOwnerNonce();
  const at = (env: NodeJS.ProcessEnv, sources = [ws]) =>
    runtimeAddress({ storePath: '/s', ownerNonce: nonce, env, sources });
  // Selected, inside the source: refused, nothing made there.
  const custom = join(ws, '.farsight', 'custom');
  assert.throws(() => at({ XDG_RUNTIME_DIR: custom }), ipcCode('sentinel.ipc.runtimeDirInsideSource'));
  assert.deepEqual(readdirSync(custom), []);
  assert.throws(() => at({ TMPDIR: ws }), ipcCode('sentinel.ipc.runtimeDirInsideSource'));
  assert.deepEqual(readdirSync(ws).sort(), ['.farsight']);
  // An overlapping candidate too long for a socket is refused too, never replaced by the /tmp fallback.
  const long = join(ws, 'x'.repeat(110));
  mkdirSync(long);
  assert.throws(() => at({ TMPDIR: long }), ipcCode('sentinel.ipc.runtimeDirInsideSource'));
  // The source inside the base: its fresh fss- child is a sibling of the source, so it is used.
  const parent = at({ TMPDIR: dir });
  t.after(() => rmSync(parent.dir, { recursive: true, force: true }));
  assert.equal(dirname(parent.dir), dir);
  // A prefix neighbour is not inside.
  mkdirSync(`${ws}-tmp`);
  const neighbour = at({ TMPDIR: `${ws}-tmp` });
  t.after(() => rmSync(neighbour.dir, { recursive: true, force: true }));
  assert.equal(dirname(neighbour.dir), `${ws}-tmp`);
  // A lower candidate that is never reached does not matter.
  const reached = at({ XDG_RUNTIME_DIR: dir, TMPDIR: custom });
  assert.equal(reached.dir, parent.dir);
  // A disjoint candidate too long for a socket keeps the existing fallback under /tmp.
  const deep = join(dirname(dir), `${'y'.repeat(110)}-${process.pid}`);
  mkdirSync(deep);
  t.after(() => rmSync(deep, { recursive: true, force: true }));
  const fallback = at({ TMPDIR: deep });
  t.after(() => rmSync(fallback.dir, { recursive: true, force: true }));
  assert.ok(fallback.dir.startsWith(`${realpathSync.native('/tmp')}/fss-`));
  // A fallback whose /tmp lies inside a source is refused before mkdtemp.
  assert.throws(() => at({}, ['/']), ipcCode('sentinel.ipc.runtimeDirInsideSource'));
});

test(
  'the service refuses a runtime folder inside its workspace before it listens or writes a descriptor',
  needsStore,
  async (t) => {
    const dir = scratch(t, 'snv-');
    const path = join(dir, 'ws');
    commitRepo(path, { 'a.ts': 'a\n' });
    initWorkspace({ workspace: path });
    const run = join(path, '.farsight', 'custom', 'run');
    mkdirSync(run, { recursive: true, mode: 0o700 });
    const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'owner') });
    mkdirSync(ws.trustDir, { recursive: true, mode: 0o700 });
    const saved = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = run;
    try {
      await assert.rejects(serveWorkspace(ws, { idleMs: 50 }), ipcCode('sentinel.ipc.runtimeDirInsideSource'));
    } finally {
      if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = saved;
    }
    assert.deepEqual(readdirSync(run), [], 'no runtime folder or socket in the source');
    assert.equal(
      existsSync(join(dir, 'owner', 'farsight', 'sentinel', 'trust', 'services')),
      false,
      'no service descriptor',
    );
    (await openStore(ws.storePath)).close(); // the store was released
    // A trust folder inside the workspace stops the service before it opens the store.
    const inside = { ...ws, trustDir: join(path, '.farsight', 'trust') };
    await assert.rejects(serveWorkspace(inside, { idleMs: 50 }), policyCode('sentinel.policy.trustDirInsideWorkspace'));
    assert.equal(existsSync(inside.trustDir), false);
  },
);
