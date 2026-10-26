// The Linux process-table readers decide a worker is gone only on proven absence (ENOENT, ESRCH). A denied,
// exhausted or failing /proc read (EACCES, EMFILE, EIO) leaves its state unknown: the worker record is kept as an
// obligation and admission waits. The Linux branch is exercised here through a package-internal seam (procIo) with
// injected /proc answers, so this runs on any host; it is fault injection, not native Linux qualification.
import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { openSync, writeFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  argumentsOf,
  kernelStartOf,
  procIo,
  processesCarrying,
  recoverStore,
  verifyWorker,
  IntentFiles,
  WorkerFiles,
  tokenArgument,
} from '../dist/execution/recovery.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';

const real = { ...procIo };
afterEach(() => Object.assign(procIo, real));
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sentinel-proc-')));
after(() => rmSync(dir, { recursive: true, force: true }));
const roots: string[] = [];
after(() => roots.forEach(removeScratch));

const TOKEN = '11111111-2222-4333-8444-555555555555';
const BOOT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const statFor = (ticks: number) => `4242 (node) S ${Array.from({ length: 18 }, () => '0').join(' ')} ${ticks} 0 0\n`;
let files = 0;

/** A Linux /proc as `answers` describes it: text served from a real file, or the errno an open throws. */
function linux(answers: Record<string, string | { code: string }>, entries: string[] = []) {
  procIo.platform = 'linux';
  procIo.openSync = ((path: string, flags: number) => {
    const a = answers[String(path)];
    if (a === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    if (typeof a !== 'string') throw Object.assign(new Error(a.code), { code: a.code });
    const f = join(dir, `proc-${++files}`);
    writeFileSync(f, a);
    return openSync(f, flags);
  }) as typeof openSync;
  procIo.opendirSync = (() => {
    const left = [...entries];
    return { readSync: () => (left.length ? { name: left.shift()! } : null), closeSync: () => {} };
  }) as any;
}

const cmdline = (...args: string[]) => `${args.join('\0')}\0`;

test('argumentsOf: absence only on ENOENT or ESRCH; EACCES, EMFILE and EIO are unknown', () => {
  for (const code of ['ENOENT', 'ESRCH']) {
    linux({ [`/proc/${process.pid}/cmdline`]: { code } });
    assert.equal(argumentsOf(process.pid), null, code);
  }
  for (const code of ['EACCES', 'EMFILE', 'EIO', 'EPERM']) {
    linux({ [`/proc/${process.pid}/cmdline`]: { code } });
    assert.equal(argumentsOf(process.pid), undefined, code);
  }
  linux({ [`/proc/${process.pid}/cmdline`]: cmdline('node', 'w.mjs', tokenArgument(TOKEN)) });
  assert.deepEqual(argumentsOf(process.pid), ['node', 'w.mjs', tokenArgument(TOKEN)]);
});

test('kernelStartOf: a denied stat or boot id, or an unparseable stat, is unknown; a missing stat is gone', () => {
  const pid = process.pid;
  linux({ [`/proc/${pid}/stat`]: statFor(77), '/proc/sys/kernel/random/boot_id': `${BOOT}\n` });
  assert.equal(kernelStartOf(pid), `${BOOT}:77`);
  linux({ [`/proc/${pid}/stat`]: { code: 'ENOENT' }, '/proc/sys/kernel/random/boot_id': `${BOOT}\n` });
  assert.equal(kernelStartOf(pid), null);
  for (const code of ['EACCES', 'EMFILE', 'EIO']) {
    linux({ [`/proc/${pid}/stat`]: { code }, '/proc/sys/kernel/random/boot_id': `${BOOT}\n` });
    assert.equal(kernelStartOf(pid), undefined, `stat ${code}`);
    linux({ [`/proc/${pid}/stat`]: statFor(77), '/proc/sys/kernel/random/boot_id': { code } });
    assert.equal(kernelStartOf(pid), undefined, `boot id ${code}`);
  }
  linux({ [`/proc/${pid}/stat`]: 'garbage', '/proc/sys/kernel/random/boot_id': `${BOOT}\n` });
  assert.equal(kernelStartOf(pid), undefined);
});

test('verifyWorker on a live process: an unreadable /proc entry is unverifiable, never gone', () => {
  const pid = process.pid;
  const id = { attempt: 'att-x', store: 'store-x', epoch: 'epoch-x', pid, token: TOKEN, kernelStart: `${BOOT}:77` };
  const ok = {
    [`/proc/${pid}/cmdline`]: cmdline('node', tokenArgument(TOKEN)),
    [`/proc/${pid}/stat`]: statFor(77),
    '/proc/sys/kernel/random/boot_id': `${BOOT}\n`,
  };
  linux(ok);
  assert.equal(verifyWorker(id), 'ours');
  for (const code of ['EACCES', 'EMFILE', 'EIO']) {
    linux({ ...ok, [`/proc/${pid}/cmdline`]: { code } });
    assert.equal(verifyWorker(id), 'unverifiable', `cmdline ${code}`);
    linux({ ...ok, [`/proc/${pid}/stat`]: { code } });
    assert.equal(verifyWorker(id), 'unverifiable', `stat ${code}`);
  }
  linux({ ...ok, [`/proc/${pid}/cmdline`]: { code: 'ESRCH' } });
  assert.equal(verifyWorker(id), 'gone');
  linux({ ...ok, [`/proc/${pid}/stat`]: statFor(78) });
  assert.equal(verifyWorker(id), 'someone-else', 'another start is another process');
});

test('processesCarrying: one unreadable entry makes the table unreadable; an entry gone mid-scan is skipped', () => {
  linux({ '/proc/10/cmdline': cmdline('node', tokenArgument(TOKEN)), '/proc/11/cmdline': { code: 'ENOENT' } }, [
    '10',
    '11',
    'self',
  ]);
  assert.deepEqual(processesCarrying(TOKEN), [10]);
  linux({ '/proc/10/cmdline': cmdline('sleep'), '/proc/11/cmdline': { code: 'EACCES' } }, ['10', '11']);
  assert.equal(processesCarrying(TOKEN), undefined, 'the unreadable process might be the one carrying the token');
});

test('recovery keeps a record whose live process cannot be read: an obligation, never settled, and the store is not clean', async () => {
  const s = scratch('proc-absence');
  roots.push(s.root);
  const store = await storeIn(s.root);
  const live = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    await new Promise((r) => live.once('spawn', r));
    const workers = new WorkerFiles(store.storePath);
    workers.record({
      attempt: 'att-earlier',
      store: store.storeId,
      epoch: 'epoch-earlier',
      pid: live.pid!,
      token: TOKEN,
      kernelStart: `${BOOT}:77`,
    });
    workers.record({
      attempt: 'att-prespawn',
      store: store.storeId,
      epoch: 'epoch-earlier',
      pid: 0,
      token: '99999999-2222-4333-8444-555555555555',
      kernelStart: '',
    });
    const intents = new IntentFiles(store.storePath);
    linux({ [`/proc/${live.pid}/cmdline`]: { code: 'EACCES' }, '/proc/12/cmdline': { code: 'EMFILE' } }, ['12']);
    const report = await recoverStore(store, { intents, workers });
    Object.assign(procIo, real);
    assert.deepEqual(report.obligations.map((o) => [o.attempt, o.reason]).sort(), [
      ['att-earlier', 'identity could not be read'],
      ['att-prespawn', 'process table could not be read'],
    ]);
    assert.deepEqual(report.stoppedWorkers, [], 'nothing was killed on a guess');
    assert.equal(report.clean, false, 'admission is blocked');
    assert.equal(new WorkerFiles(store.storePath).list().records.length, 2, 'both records are kept');
    assert.equal(live.exitCode, null, 'the live process was not touched');
  } finally {
    Object.assign(procIo, real);
    live.kill('SIGKILL');
    store.close();
  }
});
