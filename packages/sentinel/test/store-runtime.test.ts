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
import { checkSqliteRuntime, currentHost, qualificationFor, SQLITE_RELEASE_POLICY } from '../dist/store/runtime.js';
import { STORE_ERROR_CODES, StoreError, isStoreError } from '../dist/store/errors.js';
import { acquireStoreOwner } from '../dist/store/owner.js';
import { measureFilesystem, prepareStoreRoot, preparePrivateFile, canonicalSpelling, storeLayout } from '../dist/store/paths.js';

const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'sentinel-runtime-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(scratch, `case-${++n}`);
const is = (code: string) => (e: unknown) => isStoreError(e) && e.code === code;
const qualifiedPair = qualificationFor(SQLITE_RELEASE_POLICY, currentHost(), process.versions.sqlite ?? '');
const qualifiedHost = SQLITE_RELEASE_POLICY.qualified.some(q => q.host === currentHost());
// On CI nothing skips: an unqualified CI host runs the qualified-host tests and fails at the gate, loudly.
const onQualifiedHost = { skip: !qualifiedPair && !process.env.CI
  && `${currentHost()} with SQLite ${process.versions.sqlite} is not a pair in SQLITE_RELEASE_POLICY` };
// The path checks need no SQLite, so they run (and gather evidence) on a host before it is qualified.
const checkStore = (root: string) => { prepareStoreRoot(root); return preparePrivateFile(storeLayout(root).owner); };
const refuses = (code: string, root: string) => assert.throws(() => checkStore(root), is(code));

test('every store error code is a catalog entry and every store catalog entry is a code', () => {
  assert.deepEqual([...STORE_ERROR_CODES].sort(), Object.keys(SENTINEL_STORE_STRINGS).sort());
  const e = new StoreError('sentinel.store.runtimeUnqualified', { found: '9.9.9', host: 'darwin-arm64', qualified: ['3.53.3', '3.53.4'] });
  assert.equal(e.message, 'SQLite 9.9.9 has not been qualified for the Sentinel store on darwin-arm64 (qualified there: 3.53.3, 3.53.4)');
  assert.ok(Object.isFrozen(e.detail));
});

test('an unqualified host is refused by the default gate before node:sqlite is used', { skip: qualifiedHost }, async () => {
  await assert.rejects(checkSqliteRuntime(), (e: unknown) => is('sentinel.store.platformUnqualified')(e)
    && (e as StoreError).detail.platform === currentHost());
});

test('qualification is exact host and SQLite pairs, each with evidence, never a cross product', () => {
  const keys = SQLITE_RELEASE_POLICY.qualified.map(q => `${q.host}/${q.sqlite}`);
  assert.equal(new Set(keys).size, keys.length, 'no pair is listed twice');
  for (const q of SQLITE_RELEASE_POLICY.qualified) {
    assert.match(q.host, /^[a-z0-9]+-[a-z0-9]+$/);
    assert.match(q.sqlite, /^\d+\.\d+\.\d+$/);
    assert.ok(['measured', 'candidate'].includes(q.status));
    assert.ok(q.evidence.length > 0);
  }
  assert.equal(qualificationFor(SQLITE_RELEASE_POLICY, 'darwin-arm64', '3.53.3')?.status, 'measured');
  // linux-x64 is qualified with 3.53.4 only; darwin-arm64's 3.53.3 does not carry over to it.
  assert.equal(qualificationFor(SQLITE_RELEASE_POLICY, 'linux-x64', '3.53.3'), undefined);
  assert.equal(qualificationFor(SQLITE_RELEASE_POLICY, 'linux-arm64', '3.53.4'), undefined);
  const synthetic = { qualified: [
    { host: 'host-a', sqlite: '1.0.0', status: 'measured' as const, evidence: 'synthetic' },
    { host: 'host-b', sqlite: '2.0.0', status: 'measured' as const, evidence: 'synthetic' },
  ] };
  assert.equal(qualificationFor(synthetic, 'host-a', '2.0.0'), undefined);
  assert.equal(qualificationFor(synthetic, 'host-b', '1.0.0'), undefined);
});

test('qualification facts for this host, printed for the run log', onQualifiedHost, async t => {
  const rt = await checkSqliteRuntime();
  const fs = prepareStoreRoot(join(fresh(), 'store')).filesystem;
  t.diagnostic(`sentinel-store-qualification host=${currentHost()} node=${rt.node} sqlite=${rt.sqliteVersion} status=${rt.qualification.status} `
    + `filesystem=${fs.type} evidence=${fs.evidence} checks=${rt.checks.join(',')} ci=${process.env.CI ? 'yes' : 'no'}`);
});

test('the gate passes the qualified runtime and names every behaviour it checked', onQualifiedHost, async () => {
  const rt = await checkSqliteRuntime();
  assert.equal(rt.sqliteVersion, process.versions.sqlite);
  assert.deepEqual(rt.qualification, qualificationFor(SQLITE_RELEASE_POLICY, currentHost(), rt.sqliteVersion));
  assert.deepEqual([...rt.checks], ['api-surface', 'version-agrees', 'error-codes', 'foreign-keys', 'strict-tables',
    'deferred-foreign-keys', 'transaction-state', 'compile-options']);
  assert.equal(typeof rt.sqlite.DatabaseSync, 'function');
  assert.strictEqual(await checkSqliteRuntime(), rt, 'the default gate runs once per process');
});

test('an unqualified SQLite release or host is refused, and a refusal is not cached', async () => {
  const unqualified = { qualified: [{ host: currentHost(), sqlite: '0.0.1', status: 'measured' as const, evidence: 'synthetic' }] };
  await assert.rejects(checkSqliteRuntime(unqualified), (e: unknown) => is('sentinel.store.runtimeUnqualified')(e)
    && (e as StoreError).detail.found === process.versions.sqlite);
  const host = { qualified: [{ host: 'aix-ppc64', sqlite: process.versions.sqlite ?? '', status: 'measured' as const, evidence: 'synthetic' }] };
  await assert.rejects(checkSqliteRuntime(host), is('sentinel.store.platformUnqualified'));
  if (qualifiedPair) assert.ok((await checkSqliteRuntime()).checks.length > 0);
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

test('relative, dotted and trailing-separator paths are refused', () => {
  refuses('sentinel.store.pathNotAbsolute', 'relative/store');
  refuses('sentinel.store.pathNotCanonical', `${fresh()}/./store`);
  refuses('sentinel.store.pathNotCanonical', `${fresh()}/x/../store`);
  refuses('sentinel.store.pathNotCanonical', `${fresh()}/store/`);
  refuses('sentinel.store.pathNotCanonical', '/');
});

test('acquisition runs the path checks before it creates anything', onQualifiedHost, async () => {
  const base = fresh();
  await assert.rejects(acquireStoreOwner(`${base}/x/../store`), is('sentinel.store.pathNotCanonical'));
  assert.ok(!existsSync(base));
});

test('an alias through a linked folder is refused with the canonical spelling, never followed', () => {
  const base = fresh();
  mkdirSync(join(base, 'real'), { recursive: true, mode: 0o700 });
  symlinkSync(join(base, 'real'), join(base, 'alias'));
  assert.throws(() => checkStore(join(base, 'alias', 'store')), (e: unknown) => is('sentinel.store.pathNotCanonical')(e)
    && (e as StoreError).detail.canonical === join(base, 'real', 'store'));
  assert.ok(!existsSync(join(base, 'real', 'store')), 'nothing was created through the alias');
});

test('macOS temp and letter-case aliases are refused', { skip: process.platform !== 'darwin' }, () => {
  // tmpdir() is /var/folders/..., a link to /private/var/folders/...
  const viaVar = join(tmpdir(), 'sentinel-never-created');
  assert.notEqual(viaVar, canonicalSpelling(viaVar));
  assert.throws(() => checkStore(viaVar), (e: unknown) => is('sentinel.store.pathNotCanonical')(e)
    && (e as StoreError).detail.canonical === join(realpathSync(tmpdir()), 'sentinel-never-created'));
  const base = fresh();
  mkdirSync(join(base, 'Store'), { recursive: true, mode: 0o700 });
  if (existsSync(join(base, 'STORE'))) { // a case-insensitive volume, the macOS default
    assert.throws(() => checkStore(join(base, 'STORE')), (e: unknown) => is('sentinel.store.pathNotCanonical')(e)
      && (e as StoreError).detail.canonical === join(base, 'Store'));
  }
});

test('a linked store folder or lock file is refused', () => {
  const base = fresh();
  mkdirSync(join(base, 'target'), { recursive: true, mode: 0o700 });
  symlinkSync(join(base, 'target'), join(base, 'store'));
  refuses('sentinel.store.pathSymlink', join(base, 'store'));

  const store = join(fresh(), 'store');
  mkdirSync(store, { recursive: true, mode: 0o700 });
  writeFileSync(join(store, 'elsewhere.sqlite'), '', { mode: 0o600 });
  symlinkSync(join(store, 'elsewhere.sqlite'), join(store, 'owner.sqlite'));
  refuses('sentinel.store.pathSymlink', store);
});

test('a hard-linked lock file is refused: a second name could be locked separately', () => {
  const store = join(fresh(), 'store');
  checkStore(store);
  linkSync(join(store, 'owner.sqlite'), join(store, 'second-name.sqlite'));
  refuses('sentinel.store.fileUnsafe', store);
});

test('a file where the store folder should be is refused and left alone', () => {
  const base = fresh();
  mkdirSync(base, { mode: 0o700 });
  writeFileSync(join(base, 'store'), 'synthetic');
  refuses('sentinel.store.pathNotDirectory', join(base, 'store'));
  assert.ok(lstatSync(join(base, 'store')).isFile());
});

test('broader existing permissions are refused, never widened or narrowed', () => {
  const store = join(fresh(), 'store');
  mkdirSync(store, { recursive: true, mode: 0o700 });
  chmodSync(store, 0o750);
  refuses('sentinel.store.pathPermissions', store);
  assert.equal(statSync(store).mode & 0o777, 0o750);

  chmodSync(store, 0o700);
  writeFileSync(join(store, 'owner.sqlite'), '', { mode: 0o600 });
  chmodSync(join(store, 'owner.sqlite'), 0o644);
  refuses('sentinel.store.pathPermissions', store);
  assert.equal(statSync(join(store, 'owner.sqlite')).mode & 0o777, 0o644);
});

test('a folder above the store that others can rename into is refused; a sticky one is accepted', () => {
  const base = fresh();
  mkdirSync(join(base, 'shared'), { recursive: true, mode: 0o700 });
  chmodSync(join(base, 'shared'), 0o777);
  assert.throws(() => checkStore(join(base, 'shared', 'store')), (e: unknown) => is('sentinel.store.ancestorUnsafe')(e)
    && (e as StoreError).detail.path === join(base, 'shared'));
  chmodSync(join(base, 'shared'), 0o1777);
  checkStore(join(base, 'shared', 'store'));
  chmodSync(join(base, 'shared'), 0o700);
});

test('a store belonging to another user is refused', { skip: process.getuid?.() !== 0 && 'needs root to create another user\'s folder' }, () => {
  const store = join(fresh(), 'store');
  mkdirSync(store, { recursive: true, mode: 0o700 });
  spawnSync('chown', ['1', store]);
  refuses('sentinel.store.pathWrongOwner', store);
});
