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

/** `measured`: the store tests passed on this exact pair. `candidate`: listed so CI runs them; not yet evidence. */
export type QualificationStatus = 'measured' | 'candidate';

/** One host (`platform-arch`) with one SQLite release. Pairs are listed one by one, never crossed. */
export interface QualifiedRuntime {
  readonly host: string;
  readonly sqlite: string;
  readonly status: QualificationStatus;
  /** What qualified this pair, or what must still run for a candidate. */
  readonly evidence: string;
}

export interface SqliteReleasePolicy {
  /**
   * Every qualified host and SQLite pair: POSIX advisory locks through SQLite's default unix VFS, the lock
   * protocol and the eight behaviour checks below. A host listed with one release qualifies no other release.
   */
  readonly qualified: readonly QualifiedRuntime[];
}

const pair = (host: string, sqlite: string, status: QualificationStatus, evidence: string): QualifiedRuntime =>
  Object.freeze({ host, sqlite, status, evidence });

/**
 * - darwin-arm64 · 3.53.3: PR 01's E4 probe and the PR 03 store tests on Node 24.19.0.
 * - darwin-arm64 · 3.53.4: the PR 03 store tests on the official Node 24.22.0 darwin-arm64 build (archive
 *   checked against its signed SHASUMS256.txt), run from a scratch folder, with no system install.
 * - linux-x64 · 3.53.4: PR 03's full store tests on GitHub Ubuntu, Node 24.21.0, ext4; the qualified
 *   runtime tests ran rather than skipping. The policy entry links the observed run.
 * A runtime linking any other release, or a host with no entry, is refused. Add a pair only with such evidence.
 */
export const SQLITE_RELEASE_POLICY: SqliteReleasePolicy = Object.freeze({
  qualified: Object.freeze([
    pair('darwin-arm64', '3.53.3', 'measured', 'PR 01 E4 storage probe and PR 03 store tests, Node 24.19.0'),
    pair('darwin-arm64', '3.53.4', 'measured', 'PR 03 store tests, official Node 24.22.0 darwin-arm64, checksum and signature verified'),
    pair('linux-x64', '3.53.4', 'measured', 'PR 03 store tests, Node 24.21.0, ext4: https://github.com/zalos/farsight/actions/runs/39723522049/job/119642215934'),
  ]),
});

/** This process's host in policy form, `platform-arch`. */
export const currentHost = (): string => `${process.platform}-${process.arch}`;

/** The policy entry for exactly this host and release, if there is one. */
export function qualificationFor(policy: SqliteReleasePolicy, host: string, sqlite: string): QualifiedRuntime | undefined {
  return policy.qualified.find(q => q.host === host && q.sqlite === sqlite);
}

export interface SqliteRuntime {
  /** The lazily imported module; store code opens connections through this, never by importing it again. */
  readonly sqlite: SqliteModule;
  readonly sqliteVersion: string;
  readonly node: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** The behaviour checks that passed, by name. */
  readonly checks: readonly string[];
  /** The policy entry that admitted this runtime. */
  readonly qualification: QualifiedRuntime;
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
  const host = currentHost();
  if (!policy.qualified.some(q => q.host === host)) {
    throw new StoreError('sentinel.store.platformUnqualified', { platform: host, qualified: [...new Set(policy.qualified.map(q => q.host))] });
  }
  let sqlite: SqliteModule;
  try {
    sqlite = await import('node:sqlite');
  } catch (error) {
    throw new StoreError('sentinel.store.runtimeUnavailable', { node: process.versions.node }, { cause: error });
  }
  const found = process.versions.sqlite ?? 'unknown';
  const qualification = qualificationFor(policy, host, found);
  if (!qualification) {
    throw new StoreError('sentinel.store.runtimeUnqualified', {
      found, host, node: process.versions.node, qualified: policy.qualified.filter(q => q.host === host).map(q => q.sqlite),
    });
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
    if (typeof sqlite.DatabaseSync !== 'function') fail();
    db = new sqlite.DatabaseSync(':memory:');
    // isOpen and isTransaction are per-connection accessors, not prototype members, on Node 24.
    expect(typeof sqlite.StatementSync === 'function' && typeof sqlite.backup === 'function'
      && typeof db.isOpen === 'boolean' && typeof db.isTransaction === 'boolean');
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
    // A rowid alias reports a datatype mismatch differently, so test an ordinary STRICT column.
    db.exec('CREATE TABLE s(v INTEGER NOT NULL) STRICT');
    expect(rejectsWith(19, () => db!.prepare('INSERT INTO s VALUES(?)').run('not-an-integer')));
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
    checks: Object.freeze(passed), qualification,
  });
}
