// The recovery journals and the durability policy under faults the file system will not produce on demand, through
// package-internal seams: short and stalled writes, short and truncated reads, records that name another store or
// carry malformed fields, and directory syncs that fail with an invalid descriptor or an I/O error.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { journalIo, WorkerFiles, IntentFiles } from '../dist/execution/recovery.js';
import { durabilityIo, syncDirectory } from '../dist/execution/durability.js';
import { Coordinator } from '../dist/execution/coordinator.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';
import { syntheticPlan } from './coordinator-helpers.ts';

const roots: string[] = [];
after(() => roots.forEach(removeScratch));
const real = { write: journalIo.writeSync, read: journalIo.readSync, fsync: durabilityIo.fsyncSync };
afterEach(() => { journalIo.writeSync = real.write; journalIo.readSync = real.read; durabilityIo.fsyncSync = real.fsync; });
const fresh = () => { const s = scratch('journal-faults'); roots.push(s.root); return s; };
const identity = (store: string, over: Record<string, unknown> = {}) => ({ attempt: `att-${randomUUID().slice(0, 8)}`, store, epoch: 'epoch-earlier', pid: 0, token: randomUUID(), kernelStart: '', ...over });

test('short writes are completed; a write that makes no progress publishes nothing', async () => {
  const s = fresh();
  const workers = new WorkerFiles(s.root);
  journalIo.writeSync = ((fd: number, buf: Buffer, off: number, len: number) => real.write(fd, buf, off, Math.min(len, 5))) as any;
  const rec = identity('store-x');
  workers.record(rec as any);
  journalIo.writeSync = real.write;
  assert.deepEqual(JSON.parse(readFileSync(join(workers.dir, `${rec.attempt}.json`), 'utf8')), rec, 'every byte, five at a time');
  journalIo.writeSync = (() => 0) as any;
  const stalled = identity('store-x');
  assert.throws(() => workers.record(stalled as any), (e: any) => e.code === 'sentinel.execution.durabilityFailed');
  journalIo.writeSync = real.write;
  assert.equal(existsSync(join(workers.dir, `${stalled.attempt}.json`)), false, 'no record was published');
  assert.deepEqual(readdirSync(workers.dir).filter(n => n.endsWith('.tmp')), [], 'and no temporary file is left');
});

test('reads loop to the exact file length; a read that stops short is never accepted as a record', async () => {
  const s = fresh();
  const workers = new WorkerFiles(s.root);
  const rec = identity('store-x');
  workers.record(rec as any);
  journalIo.readSync = ((fd: number, buf: Buffer, off: number, len: number, pos: number) => real.read(fd, buf, off, Math.min(len, 3), pos)) as any;
  assert.deepEqual(workers.list().records, [rec], 'three bytes at a time, the whole record');
  // A read that ends early (as if the file shrank) must not parse a prefix.
  let calls = 0;
  journalIo.readSync = ((fd: number, buf: Buffer, off: number, len: number, pos: number) => (calls++ === 0 ? real.read(fd, buf, off, Math.min(len, 20), pos) : 0)) as any;
  assert.deepEqual(workers.list(), { records: [], unresolved: [{ journal: 'workers', file: `${rec.attempt}.json`, reason: 'changed while read' }] });
  journalIo.readSync = real.read;
  // A valid record followed by trailing bytes is not a prefix to accept.
  writeFileSync(join(workers.dir, 'trailing.json'), `${JSON.stringify(identity('store-x'))}\n\u0000junk`, { mode: 0o600 });
  assert.equal(workers.list().unresolved.find((u: any) => u.file === 'trailing.json')?.reason, 'not JSON');
});

test('a record naming another store, or with malformed fields, is kept and reported, and recovery is not clean', async () => {
  const s = fresh();
  const store = await storeIn(s.root);
  try {
    const workers = new WorkerFiles(store.storePath);
    const intents = new IntentFiles(store.storePath);
    const foreign = identity('store-someone-else');
    workers.record(foreign as any);
    intents.record({ name: 'sentinel-n1', owner: 'n1', store: 'store-someone-else', attempt: 'att-x', epoch: 'epoch-x', invocation: `sha256:${'1'.repeat(64)}` });
    const bad = (name: string, value: unknown) => writeFileSync(join(workers.dir, name), JSON.stringify(value), { mode: 0o600 });
    bad('pid-string.json', { ...identity(store.storeId), pid: '12' });
    bad('token-short.json', { ...identity(store.storeId), token: 'abc' });
    bad('extra.json', { ...identity(store.storeId), surprise: 1 });
    assert.throws(() => workers.record({ ...identity(store.storeId), pid: -1 } as any), (e: any) => e.code === 'sentinel.execution.journalUnreadable', 'malformed records are not written either');
    const { plan, registry } = syntheticPlan(s.root);
    const c = await Coordinator.open({ store, plan, registry, scratchRoot: s.work, cleanupWaitMs: 0 });
    const reasons = Object.fromEntries(c.recovery.unresolved.map((u: any) => [`${u.journal}/${u.file}`, u.reason]));
    assert.deepEqual(reasons, {
      [`workers/${foreign.attempt}.json`]: 'names another store', 'intents/n1.json': 'names another store',
      'workers/pid-string.json': 'missing fields', 'workers/token-short.json': 'missing fields', 'workers/extra.json': 'unexpected fields',
    });
    assert.equal(c.recovery.clean, false);
    const summary = await c.run();
    assert.equal(summary.published, 0, 'unresolved records block admission');
    for (const f of [`${foreign.attempt}.json`, 'pid-string.json', 'token-short.json', 'extra.json']) assert.ok(existsSync(join(workers.dir, f)), `${f} kept`);
  } finally { store.close(); }
});

test('directory sync: only a documented "unsupported" answer passes; EBADF and I/O errors fail', () => {
  const s = fresh();
  const fail = (code: string) => { durabilityIo.fsyncSync = (() => { throw Object.assign(new Error(code), { code }); }) as any; };
  fail('EINVAL');
  assert.equal(syncDirectory(s.work), 'unsupported');
  fail('ENOTSUP');
  assert.equal(syncDirectory(s.work), 'unsupported');
  for (const code of ['EBADF', 'EIO', 'ENOSPC', 'EROFS', 'EISDIR']) {
    fail(code);
    assert.throws(() => syncDirectory(s.work), (e: any) => e.code === 'sentinel.execution.durabilityFailed' && e.detail.osCode === code, code);
  }
  // And a journal record is not published when its directory sync fails.
  const workers = new WorkerFiles(s.root);
  fail('EIO');
  assert.throws(() => workers.record(identity('store-x') as any), (e: any) => e.code === 'sentinel.execution.durabilityFailed');
});
