import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, mkdirSync, symlinkSync, chmodSync, realpathSync, renameSync, linkSync, openSync, closeSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  ObjectStore, ObjectStoreError, NODE_OBJECT_IO, identify, canonicalJson, canonicalJsonBytes, objectRelPath,
  MAX_OBJECT_BYTES, type ObjectStoreIo, type ObjectStoreOwner,
} from '../dist/store/objects.js';

const objectsModule = new URL('../dist/store/objects.js', import.meta.url).href;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function scratch(t: { after(fn: () => void): void }): string {
  // The store root must be canonical: on macOS tmpdir() passes through the /var symbolic link.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-os-')));
  t.after(() => { chmodTree(dir); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function chmodTree(dir: string) {
  try { chmodSync(dir, 0o700); } catch { return; }
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) chmodTree(join(dir, e.name));
}
const owner = (storePath: string, storeId = 'store-test-1'): ObjectStoreOwner => ({ storePath, storeId, assertHeld() {} });

// Synthetic source-like bytes: CRLF, multibyte characters and invalid UTF-8 must all survive untouched.
const SOURCE = Buffer.concat([Buffer.from('const café = "東京";\r\n// 🔐\r\n'), Buffer.from([0xff, 0xfe, 0x00, 0x80])]);

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { assert.ok(e instanceof ObjectStoreError, String(e)); return (e as ObjectStoreError).code; }
  assert.fail('expected an ObjectStoreError');
}

test('raw and gzip objects round-trip exactly and are read back by a fresh process', async t => {
  const dir = scratch(t);
  const store = new ObjectStore(owner(dir));
  const gz = await store.put(SOURCE);
  const raw = await store.put(SOURCE, { codec: 'raw' });
  assert.equal(gz.artifactId, `sha256:${sha(SOURCE)}`);
  assert.equal(raw.artifactId, gz.artifactId, 'the logical id is the uncompressed bytes in every codec');
  assert.equal(gz.codec, 'gzip');
  assert.equal(gz.canonicalization, 'bytes');
  assert.equal(gz.created, true);
  assert.equal(gz.storeId, 'store-test-1');
  assert.equal(gz.relPath, objectRelPath(gz.rawDigest, 'gzip'));
  assert.equal(gz.encodedDigest, sha(readFileSync(join(dir, gz.relPath))));
  assert.equal(raw.encodedDigest, raw.rawDigest);
  assert.ok(Object.isFrozen(gz));
  assert.equal(statSync(join(dir, gz.relPath)).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'objects')).mode & 0o777, 0o700);
  assert.deepEqual(await store.read(gz), SOURCE);
  assert.deepEqual(await store.read(raw), SOURCE);
  assert.deepEqual(readdirSync(join(dir, 'objects/tmp')), [], 'no staged copy is left behind');

  const script = `
    const { ObjectStore } = await import(${JSON.stringify(objectsModule)});
    const store = new ObjectStore({ storePath: process.argv[1], storeId: 'store-test-1', assertHeld() {} });
    const ref = JSON.parse(process.argv[2]);
    process.stdout.write((await store.read(ref)).toString('base64'));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, dir, JSON.stringify(gz)], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Buffer.from(r.stdout, 'base64'), SOURCE);
});

test('structured artifacts are canonical JSON and refuse non-canonical bytes', async t => {
  const dir = scratch(t);
  const store = new ObjectStore(owner(dir));
  assert.equal(canonicalJson({ b: [1, -0, 'x'], a: { d: null, c: true } }), '{"a":{"c":true,"d":null},"b":[1,0,"x"]}');
  for (const bad of [undefined, NaN, Infinity, 1n, () => 1, new Date(0), new Map(), Symbol('s')]) {
    assert.throws(() => canonicalJson({ v: bad }), (e: any) => e.code === 'sentinel.object.notCanonical');
  }
  const cyclic: any = {}; cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), (e: any) => e.code === 'sentinel.object.notCanonical');

  const value = { kind: 'finding', evidence: ['sha256:00'], z: 1, a: 'é' };
  const r1 = await store.putCanonicalJson(value);
  const r2 = await store.putCanonicalJson({ a: 'é', z: 1, evidence: ['sha256:00'], kind: 'finding' });
  assert.equal(r1.artifactId, r2.artifactId, 'key order does not change identity');
  assert.equal(r1.canonicalization, 'canonical-json/1');
  assert.equal(r2.created, false);
  assert.deepEqual(await store.readCanonicalJson(r1), JSON.parse(canonicalJson(value)));

  const loose = await store.put(Buffer.from('{ "b": 1, "a": 2 }'));
  assert.equal(await code(store.readCanonicalJson(loose)), 'sentinel.object.notCanonical');
  assert.deepEqual(canonicalJsonBytes(value), Buffer.from(canonicalJson(value)));
});

test('identity and limits are checked before anything is written', async t => {
  const dir = scratch(t);
  const store = new ObjectStore(owner(dir));
  const id = identify(SOURCE);
  assert.equal(await code(store.put(Buffer.from('other'), { expect: id })), 'sentinel.object.digestMismatch');
  assert.equal(await code(store.put(Buffer.alloc(MAX_OBJECT_BYTES + 1))), 'sentinel.object.tooLarge');
  assert.equal(await code(store.put('text' as any)), 'sentinel.object.invalidInput');
  assert.equal(await code(store.put(SOURCE, { codec: 'zstd' as any })), 'sentinel.object.invalidInput');
  assert.equal(existsSync(join(dir, 'objects')), false, 'refused puts create nothing');
  const ok = await store.put(SOURCE, { expect: id });
  assert.equal(ok.rawDigest, id.rawDigest);
  // Exactly at the limit is accepted.
  const big = await store.put(Buffer.alloc(MAX_OBJECT_BYTES, 7));
  assert.equal(big.rawSize, MAX_OBJECT_BYTES);
  assert.equal((await store.read(big)).length, MAX_OBJECT_BYTES);
});

test('missing, truncated, altered, oversize and wrong-store objects fail integrity checks', async t => {
  const dir = scratch(t);
  const store = new ObjectStore(owner(dir));
  const receipt = await store.put(SOURCE);
  const path = join(dir, receipt.relPath);
  const original = readFileSync(path);

  assert.deepEqual(await store.check(receipt), { status: 'ok' });
  assert.deepEqual(store.checkSync(receipt), { status: 'ok' });
  assert.equal(await code(store.read({ ...receipt, storeId: 'another-store' })), 'sentinel.object.wrongStore');
  const absent = identify(Buffer.from('never written'));
  assert.equal((await store.check({ rawDigest: absent.rawDigest, codec: 'gzip' })).status, 'missing');
  assert.equal((await store.check({ rawDigest: receipt.rawDigest, codec: 'raw' })).status, 'missing');

  chmodSync(path, 0o600);
  writeFileSync(path, original.subarray(0, original.length - 3));
  assert.equal((await store.check(receipt)).status, 'corrupt', 'truncated (size mismatch)');
  assert.equal(store.checkSync(receipt).status, 'corrupt', 'the synchronous check agrees');
  assert.equal((await store.check({ rawDigest: receipt.rawDigest, codec: 'gzip' })).status, 'corrupt', 'truncated gzip without a recorded size');

  const flipped = Buffer.from(original); flipped[flipped.length - 9]! ^= 0xff;
  writeFileSync(path, flipped);
  assert.equal((await store.check(receipt)).status, 'corrupt', 'same size, different bytes');
  assert.equal((await store.check({ rawDigest: receipt.rawDigest, codec: 'gzip' })).status, 'corrupt', 'raw digest still checked without encoded facts');

  // A valid gzip of other bytes under this name: decodes, but not to the digest.
  writeFileSync(path, gzipSync(Buffer.from('impostor')));
  assert.equal((await store.check({ rawDigest: receipt.rawDigest, codec: 'gzip' })).status, 'corrupt');
  assert.equal(store.checkSync({ rawDigest: receipt.rawDigest, codec: 'gzip' }).status, 'corrupt');

  writeFileSync(path, Buffer.alloc(16 * 1024 * 1024 + 64 * 1024 + 1));
  assert.match((await store.check({ rawDigest: receipt.rawDigest, codec: 'gzip' }) as any).detail, /limit/);

  rmSync(path);
  symlinkSync(join(dir, 'elsewhere'), path);
  assert.equal((await store.check(receipt)).status, 'unsafe', 'a symbolic link is never followed');
  assert.equal(store.checkSync(receipt).status, 'unsafe');
  assert.equal(store.checkSync({ rawDigest: absent.rawDigest, codec: 'gzip' }).status, 'missing');
});

test('a gzip bomb stops at the recorded size and at the store limit', async t => {
  const dir = scratch(t);
  const store = new ObjectStore(owner(dir));
  const small = Buffer.from('tiny');
  const receipt = await store.put(small);
  const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 }); // 64 MiB of zeros in ~64 KiB
  assert.ok(bomb.length < 128 * 1024);
  chmodSync(join(dir, receipt.relPath), 0o600);
  writeFileSync(join(dir, receipt.relPath), bomb);
  const before = process.memoryUsage().arrayBuffers;
  const r = await store.check({ rawDigest: receipt.rawDigest, codec: 'gzip', rawSize: small.length });
  assert.equal(r.status, 'corrupt');
  const r2 = await store.check({ rawDigest: receipt.rawDigest, codec: 'gzip' });
  assert.equal(r2.status, 'corrupt', 'without a recorded size the 16 MiB cap still applies');
  assert.equal(store.checkSync({ rawDigest: receipt.rawDigest, codec: 'gzip' }).status, 'corrupt', 'the synchronous decode is bounded too');
  assert.ok(process.memoryUsage().arrayBuffers - before < 48 * 1024 * 1024, 'inflation never allocated the full bomb');
});

test('an existing valid winner with another encoding is accepted and reported as it is', async t => {
  const dir = scratch(t);
  const store = new ObjectStore(owner(dir));
  const id = identify(SOURCE);
  const rel = objectRelPath(id.rawDigest, 'gzip');
  mkdirSync(join(dir, rel, '..'), { recursive: true, mode: 0o700 });
  const level9 = gzipSync(SOURCE, { level: 9, memLevel: 9, windowBits: 10 });
  writeFileSync(join(dir, rel), level9, { mode: 0o600 });
  const receipt = await store.put(SOURCE);
  assert.equal(receipt.created, false);
  assert.equal(receipt.encodedDigest, sha(level9));
  assert.equal(receipt.encodedSize, level9.length);
  assert.deepEqual(readFileSync(join(dir, rel)), level9, 'the winner is never rewritten');
});

test('a corrupt existing object is never overwritten', async t => {
  const dir = scratch(t);
  const store = new ObjectStore(owner(dir));
  const id = identify(SOURCE);
  for (const codec of ['gzip', 'raw'] as const) {
    const rel = objectRelPath(id.rawDigest, codec);
    mkdirSync(join(dir, rel, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, rel), 'garbage', { mode: 0o600 });
    assert.equal(await code(store.put(SOURCE, { codec })), 'sentinel.object.corruptExisting');
    assert.equal(readFileSync(join(dir, rel), 'utf8'), 'garbage');
  }
});

/** Wraps the real filesystem; `faults` decides per call whether to throw. */
function faultyIo(fault: (op: string, path: string) => string | undefined): ObjectStoreIo {
  const boom = (code: string) => Object.assign(new Error(code), { code });
  const wrapHandle = (h: any, path: string) => ({
    write: (...a: any[]) => { const c = fault('write', path); return c ? Promise.reject(boom(c)) : h.write(...a); },
    read: (...a: any[]) => h.read(...a),
    stat: () => h.stat(),
    sync: () => { const c = fault('sync', path); return c ? Promise.reject(boom(c)) : h.sync(); },
    close: () => h.close(),
  });
  return {
    open: async (path, flags, mode) => { const c = fault('open', path); if (c) throw boom(c); return wrapHandle(await NODE_OBJECT_IO.open(path, flags, mode), path); },
    mkdir: async (path, mode) => { const c = fault('mkdir', path); if (c) throw boom(c); return NODE_OBJECT_IO.mkdir(path, mode); },
    lstat: path => NODE_OBJECT_IO.lstat(path),
    link: async (a, b) => { const c = fault('link', b); if (c) throw boom(c); return NODE_OBJECT_IO.link(a, b); },
    unlink: path => NODE_OBJECT_IO.unlink(path),
    readdir: path => NODE_OBJECT_IO.readdir(path),
  };
}

test('disk-full, fsync, link and directory failures return no receipt and publish nothing', async t => {
  const cases: [string, (op: string, path: string) => string | undefined, boolean][] = [
    ['ENOSPC on write', op => op === 'write' ? 'ENOSPC' : undefined, false],
    ['fsync of the staged file', (op, p) => op === 'sync' && p.includes('.partial') ? 'EIO' : undefined, false],
    ['link not permitted', op => op === 'link' ? 'EPERM' : undefined, false],
    ['link on a filesystem without hard links', op => op === 'link' ? 'ENOTSUP' : undefined, false],
    ['staging directory cannot be created', (op, p) => op === 'mkdir' && p.endsWith('tmp') ? 'EACCES' : undefined, false],
    // The object name exists after link, but its directory entry is not durable: still no receipt.
    ['fsync of the shard directory', (op, p) => op === 'sync' && /sha256[\\/][0-9a-f]{2}$/.test(p) ? 'EIO' : undefined, true],
    ['fsync of the store directory', (op, p) => op === 'sync' && !p.includes('objects') ? 'EIO' : undefined, true],
  ];
  for (const [name, fault, linked] of cases) {
    const dir = scratch(t);
    const store = new ObjectStore(owner(dir), { io: faultyIo(fault) });
    assert.equal(await code(store.put(SOURCE)), 'sentinel.object.io', name);
    const final = join(dir, objectRelPath(identify(SOURCE).rawDigest, 'gzip'));
    assert.equal(existsSync(final), linked, `${name}: published name`);
    if (existsSync(join(dir, 'objects/tmp'))) assert.deepEqual(readdirSync(join(dir, 'objects/tmp')), [], `${name}: staged copy removed`);
    // A later healthy put completes durability (and verifies what is there) rather than rewriting it.
    const healthy = await new ObjectStore(owner(dir)).put(SOURCE);
    assert.equal(healthy.created, !linked, name);
    assert.deepEqual(await store.read(healthy), SOURCE);
  }
});

test('losing ownership mid-publication yields no receipt', async t => {
  const dir = scratch(t);
  let held = true;
  const store = new ObjectStore({ storePath: dir, storeId: 's', assertHeld() { if (!held) throw new Error('owner lost'); } },
    { io: faultyIo(op => { if (op === 'link') held = false; return undefined; }) });
  await assert.rejects(store.put(SOURCE), /owner lost/);
});

test('a symlinked objects directory is refused, not followed', async t => {
  const dir = scratch(t);
  const elsewhere = scratch(t);
  symlinkSync(elsewhere, join(dir, 'objects'));
  const store = new ObjectStore(owner(dir));
  assert.equal(await code(store.put(SOURCE)), 'sentinel.object.unsafePath');
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.equal(await code(store.read({ rawDigest: identify(SOURCE).rawDigest, codec: 'gzip' })), 'sentinel.object.unsafePath');
});

test('concurrent writers in one process and across processes publish one winner and identical receipts', async t => {
  const dir = scratch(t);
  const bytes = Buffer.from('shared synthetic evidence\n'.repeat(4096));
  const stores = Array.from({ length: 8 }, () => new ObjectStore(owner(dir)));
  const receipts = await Promise.all(stores.map(s => s.put(bytes)));
  assert.equal(receipts.filter(r => r.created).length, 1);
  assert.equal(new Set(receipts.map(r => `${r.encodedDigest}:${r.encodedSize}:${r.relPath}`)).size, 1);

  const fresh = Buffer.from('cross-process synthetic evidence\n'.repeat(4096));
  // The bytes reach the children through a file: Linux caps one argv string at 128 KiB (E2BIG), and the fixture
  // must stay this large so the writers overlap. The file lives outside the store root.
  const freshPath = join(scratch(t), 'fresh.bin');
  writeFileSync(freshPath, fresh, { mode: 0o600 });
  const script = `
    const { ObjectStore } = await import(${JSON.stringify(objectsModule)});
    const { readFileSync } = await import('node:fs');
    const store = new ObjectStore({ storePath: process.argv[1], storeId: 'store-test-1', assertHeld() {} });
    const bytes = readFileSync(process.argv[2]);
    // Ready once the bytes are in memory; publish only when the parent releases every writer at once.
    process.once('message', async () => {
      process.stdout.write(JSON.stringify(await store.put(bytes)));
      process.disconnect();
    });
    process.send('ready');`;
  type Run = { status: number | null; out: string; err: string };
  const children = Array.from({ length: 6 }, () => spawn(process.execPath, ['--input-type=module', '-e', script, dir, freshPath],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
  // Bounded: a child that never reports or never finishes is killed, and the test fails rather than hangs.
  t.after(() => { for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); });
  const within = <T>(p: Promise<T>, what: string) => {
    let timer: NodeJS.Timeout;
    return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), 20_000); })])
      .finally(() => clearTimeout(timer));
  };
  const done = children.map(child => new Promise<Run>(resolve => {
    let out = '', err = '';
    child.stdout!.on('data', d => { out += d; });
    child.stderr!.on('data', d => { err += d; });
    child.on('close', status => resolve({ status, out, err }));
  }));
  await within(Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
    child.once('message', m => m === 'ready' ? resolve() : reject(new Error(`unexpected message ${String(m)}`)));
    child.once('exit', status => reject(new Error(`a writer exited (${status}) before it was ready`)));
  }))), 'waiting for every writer to be ready');
  for (const child of children) child.send('go');
  const runs = await within(Promise.all(done), 'waiting for every writer to finish');
  for (const r of runs) assert.equal(r.status, 0, r.err);
  const cross = runs.map(r => JSON.parse(r.out));
  assert.equal(cross.filter(r => r.created).length, 1, 'link(2) admits exactly one creator');
  assert.equal(new Set(cross.map(r => r.encodedDigest)).size, 1);
  assert.deepEqual(await new ObjectStore(owner(dir)).read(cross[0]), fresh);
  assert.deepEqual(readdirSync(join(dir, 'objects/tmp')), []);
});

test('list() reports objects, staged leftovers and foreign entries without touching them', async t => {
  const dir = scratch(t);
  const store = new ObjectStore(owner(dir));
  const a = await store.put(Buffer.from('a'));
  const b = await store.put(Buffer.from('b'), { codec: 'raw' });
  writeFileSync(join(dir, 'objects/tmp/leftover.partial'), 'x');
  writeFileSync(join(dir, 'objects/stray.txt'), 'x');
  writeFileSync(join(dir, a.relPath, '..', 'not-an-object'), 'x');
  const listing = await store.list();
  assert.deepEqual(listing.objects.map(o => o.relPath).sort(), [a.relPath, b.relPath].sort());
  assert.deepEqual(listing.staging, ['objects/tmp/leftover.partial']);
  assert.deepEqual([...listing.unexpected].sort(), [`objects/sha256/${a.rawDigest.slice(0, 2)}/not-an-object`, 'objects/stray.txt'].sort());
  assert.deepEqual(await new ObjectStore(owner(join(dir, 'absent'))).list(), { objects: [], staging: [], unexpected: [] });
});

test('a non-canonical or shared store root is refused before anything is written', async t => {
  const dir = scratch(t);
  const alias = join(scratch(t), 'alias');
  symlinkSync(dir, alias);
  assert.equal(await code(new ObjectStore(owner(alias)).put(SOURCE)), 'sentinel.object.unsafePath');
  assert.equal(new ObjectStore(owner(alias)).checkSync({ rawDigest: identify(SOURCE).rawDigest, codec: 'gzip' }).status, 'unsafe');
  assert.throws(() => new ObjectStore(owner('relative/store')), (e: any) => e.code === 'sentinel.object.unsafePath');
  chmodSync(dir, 0o755);
  assert.equal(await code(new ObjectStore(owner(dir)).put(SOURCE)), 'sentinel.object.unsafePath');
  assert.deepEqual(readdirSync(dir), []);
  chmodSync(dir, 0o700);
  const receipt = await new ObjectStore(owner(dir)).put(SOURCE);
  chmodSync(join(dir, 'objects/sha256'), 0o755);
  assert.equal(new ObjectStore(owner(dir)).checkSync(receipt).status, 'unsafe', 'a directory open to others is refused');
  chmodSync(join(dir, 'objects/sha256'), 0o700);
  chmodSync(join(dir, receipt.relPath), 0o644);
  assert.equal(new ObjectStore(owner(dir)).checkSync(receipt).status, 'unsafe', 'an object readable by others is refused');
});

test('a shard directory swapped for a symbolic link just before link(2) yields no receipt', async t => {
  const dir = scratch(t);
  const outside = scratch(t);
  const id = identify(SOURCE);
  const shard = join(dir, 'objects/sha256', id.rawDigest.slice(0, 2));
  const io: ObjectStoreIo = {
    ...NODE_OBJECT_IO,
    link: async (a, b) => {
      renameSync(shard, join(dir, 'moved-shard'));
      symlinkSync(outside, shard);
      return NODE_OBJECT_IO.link(a, b);
    },
  };
  assert.equal(await code(new ObjectStore(owner(dir), { io }).put(SOURCE)), 'sentinel.object.unsafePath');
  // Node cannot pin link(2) to a directory handle, so the name may be created outside before detection;
  // it is detected, no receipt is issued, and nothing outside the store is removed.
  assert.deepEqual(readdirSync(outside), [`${id.rawDigest}.gzip`]);
  assert.equal(new ObjectStore(owner(dir)).checkSync({ rawDigest: id.rawDigest, codec: 'gzip' }).status, 'unsafe');
});

test('a directory swapped between staging and the directory fsync yields no receipt', async t => {
  const dir = scratch(t);
  const id = identify(SOURCE);
  const shard = join(dir, 'objects/sha256', id.rawDigest.slice(0, 2));
  let swapped = false;
  const io: ObjectStoreIo = {
    ...NODE_OBJECT_IO,
    open: async (path, flags, mode) => {
      if (!swapped && path === shard) {
        swapped = true;
        renameSync(shard, `${shard}.old`);
        mkdirSync(shard, { mode: 0o700 });
      }
      return NODE_OBJECT_IO.open(path, flags, mode);
    },
  };
  assert.equal(await code(new ObjectStore(owner(dir), { io }).put(SOURCE)), 'sentinel.object.unsafePath');
});

test('an object with a hard-link alias outside the store is never trusted', async t => {
  const dir = scratch(t);
  const outside = scratch(t);
  const id = identify(SOURCE);
  const rel = objectRelPath(id.rawDigest, 'gzip');
  const foreign = join(outside, 'valid.gz');
  writeFileSync(foreign, gzipSync(SOURCE), { mode: 0o600 });
  mkdirSync(join(dir, rel, '..'), { recursive: true, mode: 0o700 });
  linkSync(foreign, join(dir, rel));
  const store = new ObjectStore(owner(dir));
  assert.equal(await code(store.put(SOURCE)), 'sentinel.object.unsafePath', 'an aliased winner is refused, not accepted');
  assert.equal(store.checkSync({ rawDigest: id.rawDigest, codec: 'gzip' }).status, 'unsafe');
  assert.equal(await code(store.read({ rawDigest: id.rawDigest, codec: 'gzip' })), 'sentinel.object.unsafePath');
  assert.ok(existsSync(foreign) && existsSync(join(dir, rel)), 'neither name is removed');
});

test('an extra name inside objects/tmp (a writer between link and unlink) is tolerated', async t => {
  const dir = scratch(t);
  const store = new ObjectStore(owner(dir));
  const receipt = await store.put(SOURCE);
  linkSync(join(dir, receipt.relPath), join(dir, 'objects/tmp', `${receipt.rawDigest}.gzip.0000.partial`));
  assert.deepEqual(store.checkSync(receipt), { status: 'ok' });
  assert.equal((await store.put(SOURCE)).created, false);
});

test('a parent directory swapped before link(2) yields no receipt', async t => {
  for (const parent of ['objects', 'objects/sha256']) {
    const dir = scratch(t);
    const io: ObjectStoreIo = {
      ...NODE_OBJECT_IO,
      link: async (a, b) => {
        // Same contents under a new directory inode: only identity can tell.
        const p = join(dir, parent);
        renameSync(p, `${p}.old`);
        mkdirSync(p, { mode: 0o700 });
        return NODE_OBJECT_IO.link(a, b); // fails (the new parent is empty) or lands in the new tree
      },
    };
    assert.equal(await code(new ObjectStore(owner(dir), { io }).put(SOURCE)), 'sentinel.object.unsafePath', parent);
  }
});

test('a staged file or a published name replaced by another inode yields no receipt', async t => {
  const id = identify(SOURCE);
  // Identical bytes under a new inode. The old inode is held open until the test ends: a filesystem may hand a
  // freed inode number straight to the next file (ext4 does), and then (dev, ino) cannot tell the two apart.
  const held: number[] = [];
  t.after(() => { for (const fd of held) closeSync(fd); });
  const replace = (path: string) => {
    const bytes = readFileSync(path);
    const fd = openSync(path, 'r');
    held.push(fd);
    const before = statSync(path);
    rmSync(path);
    writeFileSync(path, bytes, { mode: 0o600 });
    const after = statSync(path);
    assert.ok(after.dev !== before.dev || after.ino !== before.ino, `the replacement has its own identity (${before.dev}:${before.ino})`);
  };
  {
    const dir = scratch(t);
    const io: ObjectStoreIo = { ...NODE_OBJECT_IO, link: async (a, b) => { replace(a); return NODE_OBJECT_IO.link(a, b); } };
    assert.equal(await code(new ObjectStore(owner(dir), { io }).put(SOURCE)), 'sentinel.object.unsafePath', 'staged file replaced before link');
  }
  {
    // Same inode, other bytes: what a reused inode number looks like to (dev, ino). The receipt rests on the bytes
    // verified at the final name, so this is refused too.
    const dir = scratch(t);
    const io: ObjectStoreIo = { ...NODE_OBJECT_IO, link: async (a, b) => { writeFileSync(a, gzipSync(Buffer.from('impostor'))); return NODE_OBJECT_IO.link(a, b); } };
    assert.equal(await code(new ObjectStore(owner(dir), { io }).put(SOURCE)), 'sentinel.object.unsafePath', 'staged file rewritten in place before link');
  }
  {
    const dir = scratch(t);
    const final = join(dir, objectRelPath(id.rawDigest, 'gzip'));
    const io: ObjectStoreIo = { ...NODE_OBJECT_IO, unlink: async p => { await NODE_OBJECT_IO.unlink(p); replace(final); } };
    assert.equal(await code(new ObjectStore(owner(dir), { io }).put(SOURCE)), 'sentinel.object.unsafePath', 'published name replaced after link');
  }
  {
    // An existing winner replaced between its verification and the receipt.
    const dir = scratch(t);
    await new ObjectStore(owner(dir)).put(SOURCE);
    const final = join(dir, objectRelPath(id.rawDigest, 'gzip'));
    let done = false;
    const io: ObjectStoreIo = {
      ...NODE_OBJECT_IO,
      open: async (p, f, m) => { if (!done && p === final) { done = true; replace(final); } return NODE_OBJECT_IO.open(p, f, m); },
    };
    assert.equal(await code(new ObjectStore(owner(dir), { io }).put(SOURCE)), 'sentinel.object.unsafePath', 'winner replaced before its fsync');
  }
});

test('an alias outside objects/tmp created during publication refuses the receipt', async t => {
  const id = identify(SOURCE);
  {
    // A new publication: the extra name appears after link(2), while the staged copy is being removed.
    const dir = scratch(t);
    const outside = scratch(t);
    const final = join(dir, objectRelPath(id.rawDigest, 'gzip'));
    const io: ObjectStoreIo = { ...NODE_OBJECT_IO, unlink: async p => { await NODE_OBJECT_IO.unlink(p); linkSync(final, join(outside, 'alias')); } };
    assert.equal(await code(new ObjectStore(owner(dir), { io }).put(SOURCE)), 'sentinel.object.unsafePath');
    assert.equal(new ObjectStore(owner(dir)).checkSync({ rawDigest: id.rawDigest, codec: 'gzip' }).status, 'unsafe', 'receipt and check agree');
  }
  {
    // An existing winner that gains the extra name between its verification and its fsync.
    const dir = scratch(t);
    const outside = scratch(t);
    await new ObjectStore(owner(dir)).put(SOURCE);
    const final = join(dir, objectRelPath(id.rawDigest, 'gzip'));
    let done = false;
    const io: ObjectStoreIo = {
      ...NODE_OBJECT_IO,
      open: async (p, f, m) => { if (!done && p === final) { done = true; linkSync(final, join(outside, 'alias')); } return NODE_OBJECT_IO.open(p, f, m); },
    };
    assert.equal(await code(new ObjectStore(owner(dir), { io }).put(SOURCE)), 'sentinel.object.unsafePath');
  }
  {
    // A mode opened to other accounts during publication is refused the same way.
    const dir = scratch(t);
    const final = join(dir, objectRelPath(id.rawDigest, 'gzip'));
    const io: ObjectStoreIo = { ...NODE_OBJECT_IO, unlink: async p => { await NODE_OBJECT_IO.unlink(p); chmodSync(final, 0o644); } };
    assert.equal(await code(new ObjectStore(owner(dir), { io }).put(SOURCE)), 'sentinel.object.unsafePath');
  }
});
