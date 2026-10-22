// The SQLite runtime gate. Nothing imports node:sqlite at module load: the first store open calls
// checkSqliteRuntime(), which imports it lazily, compares the linked SQLite release against a fixed, tested
// policy and exercises the API, SQL and pragma behaviour the store relies on, before any store file is touched.
//
// Qualification is the SQLite release plus the host, not the Node major: two Node 24 releases can link
// different SQLite releases, and a release that has not passed the storage trials is refused until it has.
// Importing node:sqlite may print Node's own experimental warning; the gate never touches process warning
// handlers (the package's test script passes --disable-warning on the command line instead).
import { StoreError, sqlitePrimaryCode } from './errors.js';

type SqliteModule = typeof import('node:sqlite');

export interface SqliteReleasePolicy {
  /** SQLite releases that passed the PR 01 storage probe and this package's store tests. */
  readonly qualifiedSqlite: readonly string[];
  /** Hosts whose file locking was exercised (POSIX advisory locks through SQLite's default unix VFS). */
  readonly platforms: readonly NodeJS.Platform[];
  /** Where the qualification came from, for reports and error detail. */
  readonly evidence: string;
}

/**
 * PR 01's E4 probe measured SQLite 3.53.3 (linked by Node 24.19.0) on darwin-arm64; the store tests in this
 * package run the same lock protocol on every host CI runs. Add a release only with that evidence.
 */
export const SQLITE_RELEASE_POLICY: SqliteReleasePolicy = Object.freeze({
  qualifiedSqlite: Object.freeze(['3.53.3']),
  platforms: Object.freeze(['darwin', 'linux'] as NodeJS.Platform[]),
  evidence: 'PR 01 E4 storage probe (SQLite 3.53.3, Node 24.19.0, darwin-arm64) and the PR 03 store tests',
});

export interface SqliteRuntime {
  /** The lazily imported module; store code opens connections through this, never by importing it again. */
  readonly sqlite: SqliteModule;
  readonly sqliteVersion: string;
  readonly node: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** The behaviour checks that passed, by name. */
  readonly checks: readonly string[];
}

const BEHAVIOUR_CHECKS = [
  'api-surface', 'version-agrees', 'error-codes', 'foreign-keys', 'strict-tables', 'deferred-foreign-keys',
  'transaction-state', 'compile-options',
] as const;

let defaultGate: Promise<SqliteRuntime> | undefined;

/** Check the runtime once per process against the default policy; a test may pass its own policy. */
export function checkSqliteRuntime(policy: SqliteReleasePolicy = SQLITE_RELEASE_POLICY): Promise<SqliteRuntime> {
  if (policy !== SQLITE_RELEASE_POLICY) return runGate(policy);
  // A refused gate is not cached, so a test or caller sees the same error again rather than a stale success.
  defaultGate ??= runGate(policy).catch(error => { defaultGate = undefined; throw error; });
  return defaultGate;
}

async function runGate(policy: SqliteReleasePolicy): Promise<SqliteRuntime> {
  if (!policy.platforms.includes(process.platform)) {
    throw new StoreError('sentinel.store.platformUnqualified', { platform: process.platform, qualified: policy.platforms });
  }
  let sqlite: SqliteModule;
  try {
    sqlite = await import('node:sqlite');
  } catch (error) {
    throw new StoreError('sentinel.store.runtimeUnavailable', { node: process.versions.node }, { cause: error });
  }
  const found = process.versions.sqlite ?? 'unknown';
  if (!policy.qualifiedSqlite.includes(found)) {
    throw new StoreError('sentinel.store.runtimeUnqualified', { found, qualified: policy.qualifiedSqlite, node: process.versions.node, evidence: policy.evidence });
  }
  const passed: string[] = [];
  let current = 'api-surface';
  const fail = (cause?: unknown): never => {
    throw new StoreError('sentinel.store.runtimeBehavior', { check: current, sqlite: found, node: process.versions.node }, cause ? { cause } : undefined);
  };
  const expect = (ok: boolean) => { if (!ok) fail(); passed.push(current); };
  const rejectsWith = (primary: number, run: () => void): boolean => {
    try { run(); return false; } catch (error) { return sqlitePrimaryCode(error) === primary; }
  };

  let db: InstanceType<SqliteModule['DatabaseSync']> | undefined;
  try {
    expect(typeof sqlite.DatabaseSync === 'function' && typeof sqlite.StatementSync === 'function' && typeof sqlite.backup === 'function'
      && 'isTransaction' in sqlite.DatabaseSync.prototype);
    db = new sqlite.DatabaseSync(':memory:');
    current = 'version-agrees';
    expect((db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v === found);
    // Busy detection and constraint handling read errcode; a release that stopped exposing it fails here.
    current = 'error-codes';
    expect(rejectsWith(1, () => db!.exec('SELECT * FROM no_such_table')));
    current = 'foreign-keys';
    db.exec('PRAGMA foreign_keys=ON');
    db.exec('CREATE TABLE p(id INTEGER PRIMARY KEY) STRICT; CREATE TABLE c(p INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED) STRICT;');
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1
      && rejectsWith(19, () => db!.exec('INSERT INTO c VALUES(42)')));
    current = 'strict-tables';
    expect(rejectsWith(19, () => db!.prepare('INSERT INTO p VALUES(?)').run('not-an-integer')));
    current = 'deferred-foreign-keys';
    db.exec('BEGIN IMMEDIATE; INSERT INTO c VALUES(7); INSERT INTO p VALUES(7); COMMIT;');
    expect((db.prepare('SELECT count(*) AS n FROM c').get() as { n: number }).n === 1);
    current = 'transaction-state';
    db.exec('BEGIN EXCLUSIVE');
    const inside = db.isTransaction;
    db.exec('ROLLBACK');
    expect(inside === true && db.isTransaction === false);
    current = 'compile-options';
    const options = new Set((db.prepare('PRAGMA compile_options').all() as { compile_options: string }[]).map(r => r.compile_options));
    expect(!['OMIT_WAL', 'OMIT_FOREIGN_KEY', 'OMIT_AUTOINIT', 'THREADSAFE=0'].some(o => options.has(o)));
  } catch (error) {
    if (error instanceof StoreError) throw error;
    fail(error);
  } finally {
    try { db?.close(); } catch { /* an in-memory database holds no file */ }
  }
  if (passed.length !== BEHAVIOUR_CHECKS.length) fail();
  return Object.freeze({
    sqlite, sqliteVersion: found, node: process.versions.node, platform: process.platform, arch: process.arch,
    checks: Object.freeze(passed),
  });
}
