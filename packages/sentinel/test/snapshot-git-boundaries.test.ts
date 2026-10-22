// The Git reader's read boundary and budgets, on synthetic repositories only: explicit Git-root grants, unsafe ref
// names, symbolic links and special files under the Git directory, pack index validation and limits, one delta
// chain budget across offset and object-id bases, and descriptors that never outlive a read. Nothing outside the
// scratch folders is read; the git CLI only builds fixtures, never runs inside the reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { DEFAULT_GIT_READ_BUDGET, DEFAULT_GIT_READ_LIMITS, GitReadBudget, GitReadError, GitRepository, isSafeRefName } from '../dist/snapshot/git.js';
import { commitRepo, git, scratch, writeTree } from './snapshot-helpers.ts';

const GIT_DIST = fileURLToPath(new URL('../dist/snapshot/git.js', import.meta.url));
const code = (c: string) => (e: unknown) => e instanceof GitReadError && e.code === c;
const sha1 = (...parts: (Buffer | string)[]) => { const h = createHash('sha1'); for (const p of parts) h.update(p); return h.digest(); };

/** A bare-bones Git directory with no objects: HEAD names `head`, config is minimal. */
function emptyRepo(root: string, head = 'ref: refs/heads/main'): string {
  const gitDir = join(root, '.git');
  mkdirSync(join(gitDir, 'objects', 'pack'), { recursive: true });
  mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), `${head}\n`);
  writeFileSync(join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n');
  return gitDir;
}

/** Writes a loose object into a Git directory; returns its id. */
function looseObject(gitDir: string, type: string, data: Buffer): string {
  const raw = Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data]);
  const oid = sha1(raw).toString('hex');
  mkdirSync(join(gitDir, 'objects', oid.slice(0, 2)), { recursive: true });
  writeFileSync(join(gitDir, 'objects', oid.slice(0, 2), oid.slice(2)), deflateSync(raw));
  return oid;
}

function varintSize(type: number, size: number): Buffer {
  const out = [((type & 7) << 4) | (size & 15) | (size > 15 ? 0x80 : 0)];
  let rest = Math.floor(size / 16);
  while (rest > 0) { out.push((rest & 0x7f) | (rest > 0x7f ? 0x80 : 0)); rest = Math.floor(rest / 128); }
  return Buffer.from(out);
}

const deltaVarint = (n: number) => { const out: number[] = []; do { out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); n = Math.floor(n / 128); } while (n > 0); return Buffer.from(out); };

/** A delta that inserts `text` into a result built from a `baseSize`-byte base (no copies). */
const insertDelta = (baseSize: number, text: string) =>
  Buffer.concat([deltaVarint(baseSize), deltaVarint(text.length), Buffer.from([text.length]), Buffer.from(text)]);

type Entry = { oid: string; kind: 'blob'; data: Buffer } | { oid: string; kind: 'ref-delta'; base: string; delta: Buffer }
  | { oid: string; kind: 'ofs-delta'; baseIndex: number; delta: Buffer };

/**
 * Writes a version-2 pack and index holding `entries` in order. Entry ids are given, so cyclic or never-hashing
 * deltas can be expressed; `mutateIndex` may change the index before its checksum is recomputed.
 */
function writePack(gitDir: string, entries: Entry[], mutateIndex?: (idx: Buffer) => Buffer): void {
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.from([0, 0, 0, 2]), Buffer.alloc(4)];
  parts[2]!.writeUInt32BE(entries.length);
  const offsets: number[] = [];
  let at = 12;
  for (const e of entries) {
    offsets.push(at);
    let body: Buffer;
    if (e.kind === 'blob') body = Buffer.concat([varintSize(3, e.data.length), deflateSync(e.data)]);
    else if (e.kind === 'ref-delta') body = Buffer.concat([varintSize(7, e.delta.length), Buffer.from(e.base, 'hex'), deflateSync(e.delta)]);
    else {
      let rel = at - offsets[e.baseIndex]!;
      const enc = [rel & 0x7f];
      while ((rel >>= 7) > 0) enc.unshift(0x80 | ((--rel) & 0x7f));
      body = Buffer.concat([varintSize(6, e.delta.length), Buffer.from(enc), deflateSync(e.delta)]);
    }
    parts.push(body);
    at += body.length;
  }
  const packBody = Buffer.concat(parts);
  const packSum = sha1(packBody);
  const name = `pack-${packSum.toString('hex')}`;
  writeFileSync(join(gitDir, 'objects', 'pack', `${name}.pack`), Buffer.concat([packBody, packSum]));
  const order = entries.map((e, i) => ({ oid: Buffer.from(e.oid, 'hex'), offset: offsets[i]! })).sort((a, b) => Buffer.compare(a.oid, b.oid));
  const fanout = Buffer.alloc(1024);
  for (let b = 0; b < 256; b++) fanout.writeUInt32BE(order.filter(o => o.oid[0]! <= b).length, b * 4);
  const off = Buffer.alloc(order.length * 4);
  order.forEach((o, i) => off.writeUInt32BE(o.offset, i * 4));
  let idx = Buffer.concat([Buffer.from([0xff, 0x74, 0x4f, 0x63, 0, 0, 0, 2]), fanout, ...order.map(o => o.oid),
    Buffer.alloc(order.length * 4), off, packSum]);
  if (mutateIndex) idx = mutateIndex(idx);
  writeFileSync(join(gitDir, 'objects', 'pack', `${name}.idx`), Buffer.concat([idx, sha1(idx)]));
}

const blobOid = (data: Buffer) => sha1(`blob ${data.length}\0`, data).toString('hex');
const fakeOid = (n: number) => createHash('sha1').update(`synthetic-${n}`).digest('hex');

// ---- Git roots ----

test('a commondir outside the Git directory needs an explicit, exact grant', t => {
  const dir = scratch(t);
  const root = join(dir, 'source'), external = join(dir, 'external');
  const gitDir = emptyRepo(root);
  mkdirSync(join(external, 'objects'), { recursive: true });
  writeFileSync(join(external, 'config'), '[core]\n');
  for (const named of [external, '../../external']) {
    writeFileSync(join(gitDir, 'commondir'), `${named}\n`);
    assert.throws(() => GitRepository.open(root), code('unsupported'), `commondir ${named} without a grant`);
    assert.throws(() => GitRepository.open(root, { commonDir: root }), code('unsupported'), 'a grant for another folder is refused');
    assert.equal(GitRepository.open(root, { commonDir: external }).commonDir, external);
  }
  rmSync(join(gitDir, 'commondir'));
  assert.throws(() => GitRepository.open(root, { commonDir: external }), code('unsupported'), 'a grant the repository does not name is refused');
  assert.equal(GitRepository.open(root).commonDir, gitDir);
});

test('a linked worktree reads with both its Git directory and its common directory granted', t => {
  const dir = scratch(t);
  const main = join(dir, 'main');
  const head = commitRepo(main, { 'a.ts': 'a\n' });
  git(main, ['worktree', 'add', '--quiet', join(dir, 'linked')]);
  const gitDir = join(main, '.git/worktrees/linked');
  assert.throws(() => GitRepository.open(join(dir, 'linked')), code('unsupported'));
  assert.throws(() => GitRepository.open(join(dir, 'linked'), { gitDir }), code('unsupported'), 'no implicit grant of the common directory');
  const repo = GitRepository.open(join(dir, 'linked'), { gitDir, commonDir: join(main, '.git') });
  assert.equal(repo.resolveCommit(), head);
});

// ---- refs ----

test('ref names that could leave the refs tree are refused before any file is read', t => {
  const root = join(scratch(t), 'source');
  const gitDir = emptyRepo(root);
  const tree = looseObject(gitDir, 'tree', Buffer.alloc(0));
  const commit = looseObject(gitDir, 'commit', Buffer.from(`tree ${tree}\n\nfixture\n`));
  writeFileSync(join(root, 'reference'), `${commit}\n`); // a sibling file a traversal would reach
  writeFileSync(join(gitDir, 'reference'), `${commit}\n`);
  mkdirSync(join(gitDir, 'refs', 'heads', 'feature'), { recursive: true });
  writeFileSync(join(gitDir, 'refs', 'heads', 'feature', 'x'), `${commit}\n`);
  const repo = GitRepository.open(root);
  for (const name of ['refs/../../../reference', 'refs/../reference', 'refs/heads/../../reference', 'refs/heads/.hidden',
    'refs/heads/x.lock', 'refs//heads', 'refs/heads/a..b', 'refs/heads/x.', 'refs/heads/', 'refs/heads/a\\b', 'refs/heads/a b']) {
    assert.equal(isSafeRefName(name), false, name);
    assert.throws(() => repo.resolveCommit(name), code('unsupported'), name);
  }
  assert.equal(repo.resolveCommit('refs/heads/feature/x'), commit);
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/../reference\n');
  assert.throws(() => repo.resolveCommit(), code('unsupported'), 'a symbolic ref to an unsafe name');
});

test('symbolic links anywhere under the Git directory are refused, never followed', t => {
  const dir = scratch(t);
  const outside = join(dir, 'outside');
  mkdirSync(join(outside, 'refs', 'heads'), { recursive: true });
  const cases: Array<[string, (gitDir: string) => void, (repo: () => GitRepository) => void]> = [
    ['config', g => { writeFileSync(join(outside, 'config'), '[core]\n'); rmSync(join(g, 'config')); symlinkSync(join(outside, 'config'), join(g, 'config')); },
      open => assert.throws(open, code('unsupported'))],
    ['HEAD', g => { writeFileSync(join(outside, 'HEAD'), 'ref: refs/heads/main\n'); rmSync(join(g, 'HEAD')); symlinkSync(join(outside, 'HEAD'), join(g, 'HEAD')); },
      open => assert.throws(() => open().resolveCommit(), code('unsupported'))],
    ['refs folder', g => { rmSync(join(g, 'refs'), { recursive: true }); symlinkSync(join(outside, 'refs'), join(g, 'refs')); },
      open => assert.throws(() => open().resolveCommit(), code('unsupported'))],
    ['objects folder', g => { rmSync(join(g, 'objects'), { recursive: true }); mkdirSync(join(outside, 'objects', 'pack'), { recursive: true }); symlinkSync(join(outside, 'objects'), join(g, 'objects')); },
      open => assert.throws(() => open().readObject(fakeOid(1), 64), code('unsupported'))],
    ['object shard', g => { const o = fakeOid(2); mkdirSync(join(outside, 'shard'), { recursive: true }); symlinkSync(join(outside, 'shard'), join(g, 'objects', o.slice(0, 2))); },
      open => assert.throws(() => open().readObject(fakeOid(2), 64), code('unsupported'))],
    ['pack folder', g => { rmSync(join(g, 'objects', 'pack'), { recursive: true }); mkdirSync(join(outside, 'pack'), { recursive: true }); symlinkSync(join(outside, 'pack'), join(g, 'objects', 'pack')); },
      open => assert.throws(() => open().readObject(fakeOid(3), 64), code('unsupported'))],
    ['pack index', g => { writeFileSync(join(outside, 'x.idx'), 'not an index'); symlinkSync(join(outside, 'x.idx'), join(g, 'objects', 'pack', 'pack-x.idx')); },
      open => assert.throws(() => open().readObject(fakeOid(4), 64), code('unsupported'))],
  ];
  for (const [what, arrange, check] of cases) {
    const root = join(dir, what.replace(/ /g, '-'));
    const gitDir = emptyRepo(root);
    arrange(gitDir);
    check(() => GitRepository.open(root));
  }
});

test('a FIFO in the Git directory is refused at once, without blocking the reader', { skip: spawnSync('mkfifo', ['--help']).error ? 'no mkfifo' : false }, t => {
  const root = join(scratch(t), 'source');
  const gitDir = emptyRepo(root);
  const oid = fakeOid(5);
  mkdirSync(join(gitDir, 'objects', oid.slice(0, 2)), { recursive: true });
  execFileSync('mkfifo', [join(gitDir, 'objects', oid.slice(0, 2), oid.slice(2))]);
  rmSync(join(gitDir, 'HEAD'));
  execFileSync('mkfifo', [join(gitDir, 'HEAD')]);
  // In a child with a deadline: a blocking open would hang it, not this suite.
  const child = `
    const { GitRepository } = await import(${JSON.stringify(GIT_DIST)});
    const repo = GitRepository.open(${JSON.stringify(root)});
    const codes = [];
    for (const run of [() => repo.readObject(${JSON.stringify(oid)}, 64), () => repo.objectHeader(${JSON.stringify(oid)}), () => repo.resolveCommit()]) {
      try { run(); codes.push('accepted'); } catch (e) { codes.push(e.code); }
    }
    process.stdout.write(JSON.stringify(codes));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(r.signal, null, 'the reader did not block');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['unsupported', 'unsupported', 'unsupported']);
});

test('an oversized ref, config or packed-refs file is refused, not silently ignored', t => {
  const root = join(scratch(t), 'source');
  const gitDir = emptyRepo(root);
  writeFileSync(join(gitDir, 'refs', 'heads', 'main'), 'x'.repeat(1024 * 1024 + 1));
  assert.throws(() => GitRepository.open(root).resolveCommit(), code('unsupported'));
  rmSync(join(gitDir, 'refs', 'heads', 'main'));
  writeFileSync(join(gitDir, 'packed-refs'), ' '.repeat(16 * 1024 * 1024 + 1));
  assert.throws(() => GitRepository.open(root).resolveCommit(), code('unsupported'));
  writeFileSync(join(gitDir, 'config'), ' '.repeat(1024 * 1024 + 1));
  assert.throws(() => GitRepository.open(root), code('unsupported'));
});

// ---- pack indexes ----

test('pack indexes are validated completely and held to their budgets', t => {
  const dir = scratch(t);
  const data = Buffer.from('payload\n');
  const good: Entry[] = [{ oid: blobOid(data), kind: 'blob', data }, { oid: blobOid(Buffer.from('other\n')), kind: 'blob', data: Buffer.from('other\n') }];
  let n = 0;
  const repoWith = (mutate?: (idx: Buffer) => Buffer, entries = good) => {
    const root = join(dir, `r${++n}`);
    writePack(emptyRepo(root), entries, mutate);
    return root;
  };
  const ok = GitRepository.open(repoWith());
  assert.equal(ok.readObject(blobOid(data), 64)!.data.toString(), 'payload\n', 'a valid synthetic pack reads');
  const corrupt = (why: string, mutate: (idx: Buffer) => Buffer) =>
    assert.throws(() => GitRepository.open(repoWith(mutate)).readObject(blobOid(data), 64), code('corrupt'), why);
  corrupt('decreasing fan-out', idx => { const c = Buffer.from(idx); c.writeUInt32BE(5, 8 + 10 * 4); return c; });
  corrupt('wrong length', idx => Buffer.concat([idx.subarray(0, idx.length - 20), Buffer.alloc(8), idx.subarray(idx.length - 20)]));
  corrupt('names out of order', idx => {
    const c = Buffer.from(idx); const a = Buffer.from(c.subarray(1032, 1052)); c.copy(c, 1032, 1052, 1072); a.copy(c, 1052); return c;
  });
  corrupt('one offset twice', idx => { const c = Buffer.from(idx); const at = 1032 + 2 * 20 + 2 * 4; c.writeUInt32BE(c.readUInt32BE(at), at + 4); return c; });
  corrupt('offset outside the pack', idx => { const c = Buffer.from(idx); c.writeUInt32BE(0x7fffff00, 1032 + 2 * 20 + 2 * 4); return c; });
  corrupt('bad large-offset index', idx => { const c = Buffer.from(idx); c.writeUInt32BE(0x80000005, 1032 + 2 * 20 + 2 * 4); return c; });
  const root = repoWith();
  const idxName = readdirSync(join(root, '.git/objects/pack')).find(f => f.endsWith('.idx'))!;
  const idxPath = join(root, '.git/objects/pack', idxName);
  const bytes = readFileSync(idxPath); bytes[bytes.length - 1]! ^= 1; writeFileSync(idxPath, bytes);
  assert.throws(() => GitRepository.open(root).readObject(blobOid(data), 64), code('corrupt'), 'a failed index checksum');
  // A huge declared object count is refused before anything is allocated for it.
  const huge = repoWith(idx => { const c = Buffer.from(idx); for (let b = 200; b < 256; b++) c.writeUInt32BE(0xfffffff0, 8 + b * 4); return c; });
  assert.throws(() => GitRepository.open(huge).readObject(blobOid(data), 64), code('unsupported'), 'an object count beyond the limit');
  // Lowered budgets apply; none may be raised.
  const limited = (limits: Record<string, number>) => () => GitRepository.open(repoWith(), { limits }).readObject(blobOid(data), 64);
  assert.throws(limited({ maxIndexObjects: 1 }), code('unsupported'));
  assert.throws(limited({ maxPackObjects: 1 }), code('unsupported'));
  assert.throws(limited({ maxIndexBytes: 1000 }), code('unsupported'));
  assert.throws(limited({ maxIndexCacheBytes: 100 }), code('unsupported'));
  const twoPacks = repoWith();
  writePack(join(twoPacks, '.git'), [{ oid: blobOid(Buffer.from('third\n')), kind: 'blob', data: Buffer.from('third\n') }]);
  assert.throws(() => GitRepository.open(twoPacks, { limits: { maxPacks: 1 } }).readObject(blobOid(data), 64), code('unsupported'));
  assert.throws(() => GitRepository.open(twoPacks, { limits: { maxPacks: 1e9 } }), RangeError, 'a limit cannot be raised');
});

// ---- delta chains ----

test('a ref-delta cycle and an offset/object-id cycle are refused, not followed forever', t => {
  const dir = scratch(t);
  const a = fakeOid(10), b = fakeOid(11);
  const cyc = join(dir, 'refs');
  writePack(emptyRepo(cyc), [
    { oid: a, kind: 'ref-delta', base: b, delta: insertDelta(3, 'aaa') },
    { oid: b, kind: 'ref-delta', base: a, delta: insertDelta(3, 'bbb') },
  ]);
  const repo = GitRepository.open(cyc);
  assert.throws(() => repo.readObject(a, 1024), code('corrupt'));
  assert.throws(() => repo.objectHeader(a), code('corrupt'), 'the header path shares the same chain budget');
  // An ofs-delta whose base is a ref-delta naming the first object again.
  const c = fakeOid(12), d = fakeOid(13);
  const mixed = join(dir, 'mixed');
  writePack(emptyRepo(mixed), [
    { oid: c, kind: 'ref-delta', base: d, delta: insertDelta(3, 'ccc') },
    { oid: d, kind: 'ofs-delta', baseIndex: 0, delta: insertDelta(3, 'ddd') },
  ]);
  const repo2 = GitRepository.open(mixed);
  assert.throws(() => repo2.readObject(d, 1024), code('corrupt'));
  assert.throws(() => repo2.objectHeader(d), code('corrupt'));
});

test('one depth budget covers a chain of object-id bases', t => {
  const root = join(scratch(t), 'chain');
  const base = Buffer.from('abc');
  const entries: Entry[] = [{ oid: blobOid(base), kind: 'blob', data: base }];
  let prev = blobOid(base);
  for (let i = 0; i < 6; i++) {
    const text = `v${i}x`.padEnd(3, 'x').slice(0, 3);
    const data = Buffer.from(text);
    entries.push({ oid: blobOid(data), kind: 'ref-delta', base: prev, delta: insertDelta(3, text) });
    prev = blobOid(data);
  }
  writePack(emptyRepo(root), entries);
  const last = prev;
  assert.equal(GitRepository.open(root).readObject(last, 64)!.data.length, 3, 'a seven-step chain reads within the default');
  assert.equal(GitRepository.open(root).objectHeader(last)!.type, 'blob');
  assert.throws(() => GitRepository.open(root, { limits: { maxDeltaDepth: 5 } }).readObject(last, 64), code('corrupt'));
  assert.throws(() => GitRepository.open(root, { limits: { maxDeltaDepth: 5 } }).objectHeader(last), code('corrupt'));
});

// ---- descriptors and identity ----

/** Open descriptors of this process, where the platform lists them. */
const openDescriptors = () => { try { return readdirSync('/dev/fd').length; } catch { return undefined; } };

test('no descriptor outlives a read, before or after close(), and a replaced pack is detected', t => {
  const root = join(scratch(t), 'repo');
  commitRepo(root, { 'a.ts': 'one\n'.repeat(200) });
  writeTree(root, { 'a.ts': 'one\n'.repeat(199) + 'two\n' });
  git(root, ['commit', '--quiet', '-am', 'v2']);
  git(root, ['repack', '-a', '-d', '-q']);
  const oid = git(root, ['rev-parse', 'HEAD:a.ts']).trim();
  const repo = GitRepository.open(root);
  const before = openDescriptors();
  for (let i = 0; i < 50; i++) repo.readObject(oid, 1 << 20);
  repo.close();
  for (let i = 0; i < 50; i++) repo.readObject(oid, 1 << 20); // a capture's re-read after enumeration closed it
  if (before !== undefined) assert.equal(openDescriptors(), before, 'nothing left open');
  // The same bytes under a new inode are still a different file than the one indexed.
  const packDir = join(root, '.git/objects/pack');
  const pack = readdirSync(packDir).find(f => f.endsWith('.pack'))!;
  cpSync(join(packDir, pack), join(packDir, `${pack}.copy`));
  renameSync(join(packDir, `${pack}.copy`), join(packDir, pack));
  assert.throws(() => repo.readObject(oid, 1 << 20), code('unsupported'));
});

test('a byte-wise SHA-1 history and its deltas still read as git stores them', t => {
  const root = join(scratch(t), 'repo');
  const base = Array.from({ length: 300 }, (_, i) => `line ${i}\n`).join('');
  commitRepo(root, { 'big.ts': base });
  for (let v = 1; v <= 3; v++) { writeTree(root, { 'big.ts': base.replace(`line ${v * 7}\n`, `edit ${v}\n`) }); git(root, ['commit', '--quiet', '-am', `v${v}`]); }
  git(root, ['repack', '-a', '-d', '-q', '--depth=50']);
  const repo = GitRepository.open(root);
  for (let v = 0; v <= 3; v++) {
    const rev = `HEAD~${3 - v}`;
    const oid = git(root, ['rev-parse', `${rev}:big.ts`]).trim();
    assert.equal(repo.readObject(oid, 1 << 20)!.data.toString(), git(root, ['show', `${rev}:big.ts`]));
    assert.equal(repo.objectHeader(oid)!.type, 'blob');
  }
});

// ---- the shared budget ----

/** A repository with one synthetic pack of `count` blobs; returns its root, one blob id, the index size and parsed size. */
function packedRepo(root: string, count: number, tag: string) {
  const entries: Entry[] = Array.from({ length: count }, (_, i) => { const data = Buffer.from(`${tag}-${i}\n`); return { oid: blobOid(data), kind: 'blob' as const, data }; });
  writePack(emptyRepo(root), entries);
  const idxName = readdirSync(join(root, '.git/objects/pack')).find(f => f.endsWith('.idx'))!;
  const idxBytes = readFileSync(join(root, '.git/objects/pack', idxName)).length;
  return { root, oid: entries[0]!.oid, idxBytes, parsedBytes: count * (20 + 16) + 1024 + 20, idxName };
}

test('the defaults fit a 128 MiB coordinator share and can only be lowered', () => {
  assert.deepEqual(DEFAULT_GIT_READ_BUDGET, { maxRetainedBytes: 128 * 1024 * 1024, maxPackObjects: 3_000_000 });
  assert.equal(DEFAULT_GIT_READ_LIMITS.maxIndexBytes, 64 * 1024 * 1024);
  assert.equal(DEFAULT_GIT_READ_LIMITS.maxIndexCacheBytes, 128 * 1024 * 1024);
  assert.equal(DEFAULT_GIT_READ_LIMITS.maxDeltaChainBytes, 64 * 1024 * 1024);
  assert.throws(() => new GitReadBudget({ maxRetainedBytes: 256 * 1024 * 1024 }), RangeError);
  assert.throws(() => new GitReadBudget({ maxPackObjects: 0 }), RangeError);
  assert.throws(() => GitRepository.open('/', { budget: {} as never }), TypeError);
});

test('repositories sharing one budget are refused past it, and close() gives their share back', t => {
  const dir = scratch(t);
  const a = packedRepo(join(dir, 'a'), 50, 'a');
  const b = packedRepo(join(dir, 'b'), 50, 'b');
  // Room for one repository's index while it is read and parsed, not for two parsed indexes at once.
  const budget = new GitReadBudget({ maxRetainedBytes: a.idxBytes + a.parsedBytes + 100 });
  const ra = GitRepository.open(a.root, { budget });
  const rb = GitRepository.open(b.root, { budget });
  assert.equal(ra.readObject(a.oid, 64)!.data.toString(), 'a-0\n');
  assert.equal(budget.usedBytes, a.parsedBytes, 'the read buffer is released; the parsed index is held');
  assert.equal(budget.usedObjects, 50);
  assert.throws(() => rb.readObject(b.oid, 64), code('unsupported'), 'the second repository does not fit');
  assert.equal(budget.usedBytes, a.parsedBytes, 'the refused load holds nothing');
  ra.close();
  assert.equal(budget.usedBytes, 0);
  assert.equal(rb.readObject(b.oid, 64)!.data.toString(), 'b-0\n', 'after a release the other fits');
  assert.throws(() => ra.readObject(a.oid, 64), code('unsupported'), 'a read after close() reserves again, and does not fit now');
  rb.close();
  assert.equal(ra.readObject(a.oid, 64)!.data.toString(), 'a-0\n', 'and reloads once there is room');
  ra.close();
  assert.deepEqual([budget.usedBytes, budget.usedObjects], [0, 0]);
});

test('an index is admitted before anything is allocated for it: the file, then its parsed tables', t => {
  const dir = scratch(t);
  const r = packedRepo(join(dir, 'r'), 40, 'r');
  const tooSmallForFile = new GitReadBudget({ maxRetainedBytes: r.idxBytes - 1 });
  assert.throws(() => GitRepository.open(r.root, { budget: tooSmallForFile }).readObject(r.oid, 64), code('unsupported'));
  assert.equal(tooSmallForFile.usedBytes, 0);
  const tooSmallForTables = new GitReadBudget({ maxRetainedBytes: r.idxBytes + r.parsedBytes - 1 });
  assert.throws(() => GitRepository.open(r.root, { budget: tooSmallForTables }).readObject(r.oid, 64), code('unsupported'));
  assert.equal(tooSmallForTables.usedBytes, 0);
  const objects = new GitReadBudget({ maxPackObjects: 39 });
  assert.throws(() => GitRepository.open(r.root, { budget: objects }).readObject(r.oid, 64), code('unsupported'));
  assert.equal(objects.usedObjects, 0);
  const exact = new GitReadBudget({ maxRetainedBytes: r.idxBytes + r.parsedBytes, maxPackObjects: 40 });
  assert.equal(GitRepository.open(r.root, { budget: exact }).readObject(r.oid, 64)!.data.toString(), 'r-0\n');
});

test('a failed load is all or nothing: it releases what it reserved, and the next read retries from the start', t => {
  const root = join(scratch(t), 'two');
  const good = packedRepo(root, 10, 'good');
  const gitDir = join(root, '.git');
  const later = Buffer.from('later\n');
  writePack(gitDir, [{ oid: blobOid(later), kind: 'blob', data: later }]);
  const packDir = join(gitDir, 'objects', 'pack');
  const second = readdirSync(packDir).find(f => f.endsWith('.idx') && f !== good.idxName)!;
  const valid = readFileSync(join(packDir, second));
  const broken = Buffer.from(valid); broken[broken.length - 1]! ^= 1;
  writeFileSync(join(packDir, second), broken);
  const budget = new GitReadBudget();
  const repo = GitRepository.open(root, { budget });
  assert.throws(() => repo.readObject(good.oid, 64), code('corrupt'), 'one bad index fails the load');
  assert.throws(() => repo.readObject(good.oid, 64), code('corrupt'), 'and is retried, not served partially');
  assert.deepEqual([budget.usedBytes, budget.usedObjects], [0, 0], 'nothing stays reserved');
  writeFileSync(join(packDir, second), valid);
  assert.equal(repo.readObject(good.oid, 64)!.data.toString(), 'good-0\n');
  assert.equal(repo.readObject(blobOid(later), 64)!.data.toString(), 'later\n');
  assert.equal(budget.usedObjects, 11);
  repo.close();
  assert.deepEqual([budget.usedBytes, budget.usedObjects], [0, 0]);
});
