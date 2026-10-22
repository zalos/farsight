// The SQLite runtime gate and the storage path checks, measured on the host that runs the test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SENTINEL_STORE_STRINGS } from '@farsight/core/dist/strings-sentinel-store.js';
import { checkSqliteRuntime, SQLITE_RELEASE_POLICY } from '../dist/store/runtime.js';
import { STORE_ERROR_CODES, StoreError, isStoreError } from '../dist/store/errors.js';
import { acquireStoreOwner } from '../dist/store/owner.js';
import { measureFilesystem, prepareStoreRoot, preparePrivateFile, canonicalSpelling, storeLayout } from '../dist/store/paths.js';

const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'sentinel-runtime-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(scratch, `case-${++n}`);
const is = (code: string) => (e: unknown) => isStoreError(e) && e.code === code;

test('every store error code is a catalog entry and every store catalog entry is a code', () => {
  assert.deepEqual([...STORE_ERROR_CODES].sort(), Object.keys(SENTINEL_STORE_STRINGS).sort());
  const e = new StoreError('sentinel.store.runtimeUnqualified', { found: '9.9.9', qualified: ['3.53.3'] });
  assert.equal(e.message, 'SQLite 9.9.9 has not been qualified for the Sentinel store (qualified: 3.53.3)');
  assert.ok(Object.isFrozen(e.detail));
});

test('the gate passes the qualified runtime and names every behaviour it checked', async () => {
  const rt = await checkSqliteRuntime();
  assert.equal(rt.sqliteVersion, process.versions.sqlite);
  assert.ok(SQLITE_RELEASE_POLICY.qualifiedSqlite.includes(rt.sqliteVersion));
  assert.deepEqual([...rt.checks], ['api-surface', 'version-agrees', 'error-codes', 'foreign-keys', 'strict-tables',
    'deferred-foreign-keys', 'transaction-state', 'compile-options']);
  assert.equal(typeof rt.sqlite.DatabaseSync, 'function');
  assert.strictEqual(await checkSqliteRuntime(), rt, 'the default gate runs once per process');
});

test('an unqualified SQLite release or host is refused, and a refusal is not cached', async () => {
  const unqualified = { ...SQLITE_RELEASE_POLICY, qualifiedSqlite: ['0.0.1'] };
  await assert.rejects(checkSqliteRuntime(unqualified), (e: unknown) => is('sentinel.store.runtimeUnqualified')(e)
    && (e as StoreError).detail.found === process.versions.sqlite);
  const host = { ...SQLITE_RELEASE_POLICY, platforms: ['aix' as NodeJS.Platform] };
  await assert.rejects(checkSqliteRuntime(host), is('sentinel.store.platformUnqualified'));
  assert.ok((await checkSqliteRuntime()).checks.length > 0);
});

test('loading the store modules imports neither node:sqlite nor anything else with effects', () => {
  const dist = fileURLToPath(new URL('../dist/store/', import.meta.url));
  const script = `await import(${JSON.stringify(`${dist}owner.js`)});
    process.stdout.write(JSON.stringify(process.moduleLoadList.filter(m => /sqlite/i.test(m))));`;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), []);
});

test('created folders are 0700 and files 0600; the file system is measured, not assumed', () => {
  const root = join(fresh(), 'nested', 'store');
  const checked = prepareStoreRoot(root);
  assert.equal(checked.created, true);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(join(root, '..')).mode & 0o777, 0o700);
  const file = preparePrivateFile(storeLayout(root).owner);
  assert.equal(file.created, true);
  assert.equal(statSync(storeLayout(root).owner).mode & 0o777, 0o600);
  if (process.platform === 'darwin') {
    assert.match(checked.filesystem.type, /^(apfs|hfs)$/);
    assert.match(checked.filesystem.evidence, /^mount:\//);
  } else {
    assert.match(checked.filesystem.evidence, /^statfs:0x[0-9a-f]+$/);
  }
  assert.equal(prepareStoreRoot(root).created, false);
});

test('a file system not known to be local is refused', { skip: !['darwin', 'linux'].includes(process.platform) }, () => {
  // devfs on macOS and procfs on Linux are real, measured, non-store file systems.
  assert.throws(() => measureFilesystem(process.platform === 'darwin' ? '/dev' : '/proc'), is('sentinel.store.filesystemUnsupported'));
});

test('relative, dotted and trailing-separator paths are refused', async () => {
  await assert.rejects(acquireStoreOwner('relative/store'), is('sentinel.store.pathNotAbsolute'));
  await assert.rejects(acquireStoreOwner(`${fresh()}/./store`), is('sentinel.store.pathNotCanonical'));
  await assert.rejects(acquireStoreOwner(`${fresh()}/x/../store`), is('sentinel.store.pathNotCanonical'));
  await assert.rejects(acquireStoreOwner(`${fresh()}/store/`), is('sentinel.store.pathNotCanonical'));
  await assert.rejects(acquireStoreOwner('/'), is('sentinel.store.pathNotCanonical'));
});

test('an alias through a linked folder is refused with the canonical spelling, never followed', async () => {
  const base = fresh();
  mkdirSync(join(base, 'real'), { recursive: true, mode: 0o700 });
  symlinkSync(join(base, 'real'), join(base, 'alias'));
  await assert.rejects(acquireStoreOwner(join(base, 'alias', 'store')), (e: unknown) => is('sentinel.store.pathNotCanonical')(e)
    && (e as StoreError).detail.canonical === join(base, 'real', 'store'));
  assert.ok(!existsSync(join(base, 'real', 'store')), 'nothing was created through the alias');
});

test('macOS temp and letter-case aliases are refused', { skip: process.platform !== 'darwin' }, async () => {
  // tmpdir() is /var/folders/..., a link to /private/var/folders/...
  const viaVar = join(tmpdir(), 'sentinel-never-created');
  assert.notEqual(viaVar, canonicalSpelling(viaVar));
  await assert.rejects(acquireStoreOwner(viaVar), (e: unknown) => is('sentinel.store.pathNotCanonical')(e)
    && (e as StoreError).detail.canonical === join(realpathSync(tmpdir()), 'sentinel-never-created'));
  const base = fresh();
  mkdirSync(join(base, 'Store'), { recursive: true, mode: 0o700 });
  if (existsSync(join(base, 'STORE'))) { // a case-insensitive volume, the macOS default
    await assert.rejects(acquireStoreOwner(join(base, 'STORE')), (e: unknown) => is('sentinel.store.pathNotCanonical')(e)
      && (e as StoreError).detail.canonical === join(base, 'Store'));
  }
});

test('a linked store folder or lock file is refused', async () => {
  const base = fresh();
  mkdirSync(join(base, 'target'), { recursive: true, mode: 0o700 });
  symlinkSync(join(base, 'target'), join(base, 'store'));
  await assert.rejects(acquireStoreOwner(join(base, 'store')), is('sentinel.store.pathSymlink'));

  const store = join(fresh(), 'store');
  mkdirSync(store, { recursive: true, mode: 0o700 });
  writeFileSync(join(store, 'elsewhere.sqlite'), '', { mode: 0o600 });
  symlinkSync(join(store, 'elsewhere.sqlite'), join(store, 'owner.sqlite'));
  await assert.rejects(acquireStoreOwner(store), is('sentinel.store.pathSymlink'));
});

test('a hard-linked lock file is refused: a second name could be locked separately', async () => {
  const store = join(fresh(), 'store');
  (await acquireStoreOwner(store)).close();
  linkSync(join(store, 'owner.sqlite'), join(store, 'second-name.sqlite'));
  await assert.rejects(acquireStoreOwner(store), is('sentinel.store.fileUnsafe'));
});

test('a file where the store folder should be is refused and left alone', async () => {
  const base = fresh();
  mkdirSync(base, { mode: 0o700 });
  writeFileSync(join(base, 'store'), 'synthetic');
  await assert.rejects(acquireStoreOwner(join(base, 'store')), is('sentinel.store.pathNotDirectory'));
  assert.ok(lstatSync(join(base, 'store')).isFile());
});

test('broader existing permissions are refused, never widened or narrowed', async () => {
  const store = join(fresh(), 'store');
  mkdirSync(store, { recursive: true, mode: 0o700 });
  chmodSync(store, 0o750);
  await assert.rejects(acquireStoreOwner(store), is('sentinel.store.pathPermissions'));
  assert.equal(statSync(store).mode & 0o777, 0o750);

  chmodSync(store, 0o700);
  writeFileSync(join(store, 'owner.sqlite'), '', { mode: 0o600 });
  chmodSync(join(store, 'owner.sqlite'), 0o644);
  await assert.rejects(acquireStoreOwner(store), is('sentinel.store.pathPermissions'));
  assert.equal(statSync(join(store, 'owner.sqlite')).mode & 0o777, 0o644);
});

test('a folder above the store that others can rename into is refused; a sticky one is accepted', async () => {
  const base = fresh();
  mkdirSync(join(base, 'shared'), { recursive: true, mode: 0o700 });
  chmodSync(join(base, 'shared'), 0o777);
  await assert.rejects(acquireStoreOwner(join(base, 'shared', 'store')), (e: unknown) => is('sentinel.store.ancestorUnsafe')(e)
    && (e as StoreError).detail.path === join(base, 'shared'));
  chmodSync(join(base, 'shared'), 0o1777);
  (await acquireStoreOwner(join(base, 'shared', 'store'))).close();
  chmodSync(join(base, 'shared'), 0o700);
});

test('a store belonging to another user is refused', { skip: process.getuid?.() !== 0 && 'needs root to create another user\'s folder' }, async () => {
  const store = join(fresh(), 'store');
  mkdirSync(store, { recursive: true, mode: 0o700 });
  spawnSync('chown', ['1', store]);
  await assert.rejects(acquireStoreOwner(store), is('sentinel.store.pathWrongOwner'));
});
