import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, statSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLedger } from '../dist/store/ledger.js';
import { LEDGER_APPLICATION_ID, LEDGER_MIGRATIONS } from '../dist/store/migrations.js';
import { ARTIFACT_CODECS, ARTIFACT_PRIVACY, LEDGER_EVENT_KINDS, LedgerError } from '../dist/store/store-types.js';
import { ATTEMPT_STATES, RUN_OUTCOMES, RUN_STATES, USAGE_CERTAINTIES, WORK_STATES } from '../dist/index.js';
import { FakeOwner, runEnvelope, scratch } from './store-helpers.ts';

// The shipped list's length; the synthetic next step is numbered after it.
const N = LEDGER_MIGRATIONS.length;
const V2 = { version: N + 1, name: 'second', sql: 'CREATE TABLE later_projection (id TEXT PRIMARY KEY) STRICT;' };
let epochs = 0;
const owner = (dir: string) => new FakeOwner(dir, `epoch-${++epochs}`);
const code = (c: string) => (e: unknown) => e instanceof LedgerError && e.code === c;

function peek(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const one = (sql: string) => Object.values(db.prepare(sql).get() ?? {})[0];
    return {
      version: Number(one('PRAGMA user_version')),
      appId: Number(one('PRAGMA application_id')),
      runs: Number(one('SELECT count(*) FROM runs')),
      later: Number(one("SELECT count(*) FROM sqlite_schema WHERE name = 'later_projection'")),
    };
  } finally { db.close(); }
}

async function seeded(dir: string) {
  const o = owner(dir);
  const ledger = await openLedger(o);
  ledger.createRun(runEnvelope(o.epoch) as never);
  ledger.close();
  return ledger.path;
}

test('a new ledger is created at the newest schema with WAL, FULL sync, foreign keys and no backup', async t => {
  const dir = scratch(t);
  const o = owner(dir);
  const ledger = await openLedger(o, { build: 'test-build' });
  assert.deepEqual(ledger.migration, { from: 0, to: LEDGER_MIGRATIONS.length, backupPath: null });
  ledger.close();
  const db = new DatabaseSync(ledger.path);
  const one = (sql: string) => Object.values(db.prepare(sql).get() ?? {})[0];
  assert.equal(one('PRAGMA journal_mode'), 'wal');
  assert.equal(Number(one('PRAGMA application_id')), LEDGER_APPLICATION_ID);
  assert.equal(Number(one('PRAGMA user_version')), N);
  assert.equal(statSync(ledger.path).mode & 0o777, 0o600);
  const m = db.prepare('SELECT version, name, checksum, build FROM schema_migrations').all() as Array<Record<string, unknown>>;
  assert.equal(m.length, N);
  assert.equal(m[0]!.build, 'test-build');
  assert.match(String(m[0]!.checksum), /^sha256:[0-9a-f]{64}$/);
  db.close();
  const again = await openLedger(owner(dir));
  assert.deepEqual(again.migration, { from: N, to: N, backupPath: null });
  again.close();
});

test('an upgrade takes a verified backup first, then applies every pending step', async t => {
  const dir = scratch(t);
  const path = await seeded(dir);
  const ledger = await openLedger(owner(dir), { migrations: [...LEDGER_MIGRATIONS, V2] });
  assert.equal(ledger.migration.from, N);
  assert.equal(ledger.migration.to, N + 1);
  const backup = ledger.migration.backupPath!;
  ledger.close();
  assert.ok(existsSync(backup));
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  assert.deepEqual(peek(backup), { version: N, appId: LEDGER_APPLICATION_ID, runs: 1, later: 0 });
  assert.deepEqual(peek(path), { version: N + 1, appId: LEDGER_APPLICATION_ID, runs: 1, later: 1 });
});

test('a failing migration rolls back to the prior schema and data', async t => {
  const dir = scratch(t);
  const path = await seeded(dir);
  const broken = { version: N + 1, name: 'broken', sql: 'CREATE TABLE later_projection (id TEXT) STRICT; CREATE TABLE runs (x TEXT);' };
  await assert.rejects(openLedger(owner(dir), { migrations: [...LEDGER_MIGRATIONS, broken] }),
    code('sentinel.store.migrationFailed'));
  assert.deepEqual(peek(path), { version: N, appId: LEDGER_APPLICATION_ID, runs: 1, later: 0 });
  // A failure after the step's SQL ran (here: before it is recorded) is rolled back too.
  await assert.rejects(openLedger(owner(dir), {
    migrations: [...LEDGER_MIGRATIONS, V2],
    failpoint: p => { if (p === 'migrate:after-sql') throw new Error('injected'); },
  }), code('sentinel.store.migrationFailed'));
  assert.deepEqual(peek(path), { version: N, appId: LEDGER_APPLICATION_ID, runs: 1, later: 0 });
  const fixed = await openLedger(owner(dir), { migrations: [...LEDGER_MIGRATIONS, V2] });
  assert.equal(fixed.migration.to, N + 1);
  fixed.close();
});

test('a failed backup refuses the upgrade and leaves no partial copy', async t => {
  for (const point of ['backup:before', 'backup:after-copy'] as const) {
    const dir = scratch(t);
    const path = await seeded(dir);
    await assert.rejects(openLedger(owner(dir), {
      migrations: [...LEDGER_MIGRATIONS, V2],
      failpoint: p => { if (p === point) throw new Error('injected disk failure'); },
    }), code('sentinel.store.backupFailed'));
    assert.deepEqual(peek(path), { version: N, appId: LEDGER_APPLICATION_ID, runs: 1, later: 0 }, point);
    const backups = join(dir, 'backups');
    assert.deepEqual(existsSync(backups) ? readdirSync(backups) : [], [], point);
  }
});

test('a newer schema is refused without touching the file', async t => {
  const dir = scratch(t);
  const path = await seeded(dir);
  (await openLedger(owner(dir), { migrations: [...LEDGER_MIGRATIONS, V2] })).close();
  await assert.rejects(openLedger(owner(dir)), code('sentinel.store.newerSchema'));
  assert.equal(peek(path).version, N + 1);
});

test('a changed migration, a foreign database and an unsafe path are refused', async t => {
  const dir = scratch(t);
  await seeded(dir);
  const edited = [{ ...LEDGER_MIGRATIONS[0]!, sql: `${LEDGER_MIGRATIONS[0]!.sql}\n-- edited` }, ...LEDGER_MIGRATIONS.slice(1)];
  await assert.rejects(openLedger(owner(dir), { migrations: edited }), code('sentinel.store.migrationMismatch'));
  await assert.rejects(openLedger(owner(dir), { migrations: [V2] }), code('sentinel.store.migrationMismatch'));

  const other = scratch(t);
  const foreign = new DatabaseSync(join(other, 'ledger.sqlite'));
  foreign.exec('CREATE TABLE t (a TEXT)');
  foreign.close();
  chmodSync(join(other, 'ledger.sqlite'), 0o644);
  await assert.rejects(openLedger(owner(other)), code('sentinel.store.unsafePath'), 'a group-readable ledger is refused');
  chmodSync(join(other, 'ledger.sqlite'), 0o600);
  await assert.rejects(openLedger(owner(other)), code('sentinel.store.notLedger'));

  const linked = scratch(t);
  writeFileSync(join(linked, 'target.db'), '');
  symlinkSync(join(linked, 'target.db'), join(linked, 'ledger.sqlite'));
  await assert.rejects(openLedger(owner(linked)), code('sentinel.store.unsafePath'));
});

test('the ledger CHECK sets equal the pinned contract and store enumerations', async t => {
  const dir = scratch(t);
  const ledger = await openLedger(owner(dir));
  ledger.close();
  const db = new DatabaseSync(ledger.path, { readOnly: true });
  const sqlOf = (name: string) => String((db.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(name) as { sql: string }).sql);
  const setIn = (table: string, column: string) => {
    const m = new RegExp(`${column} TEXT[^,]*?CHECK \\(${column} IN\\s*\\(([^)]*)\\)`).exec(sqlOf(table));
    assert.ok(m, `${table}.${column} has an IN check`);
    return m[1]!.split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  };
  assert.deepEqual(setIn('runs', 'state'), [...RUN_STATES]);
  assert.deepEqual(setIn('runs', 'outcome'), [...RUN_OUTCOMES]);
  assert.deepEqual(setIn('work_units', 'state'), [...WORK_STATES]);
  assert.deepEqual(setIn('attempts', 'state'), [...ATTEMPT_STATES]);
  assert.deepEqual(setIn('attempts', 'usage_certainty'), [...USAGE_CERTAINTIES]);
  assert.deepEqual(setIn('artifacts', 'privacy_floor'), [...ARTIFACT_PRIVACY]);
  assert.deepEqual(setIn('artifact_refs', 'privacy'), [...ARTIFACT_PRIVACY]);
  assert.deepEqual(setIn('artifact_objects', 'codec'), [...ARTIFACT_CODECS]);
  assert.deepEqual(setIn('events', 'kind'), [...LEDGER_EVENT_KINDS]);
  db.close();
});

test('losing the owner during an upgrade commits nothing, and a successor can still upgrade', async t => {
  for (const point of ['backup:after-copy', 'migrate:after-sql'] as const) {
    const dir = scratch(t);
    const path = await seeded(dir);
    const lost = owner(dir);
    await assert.rejects(openLedger(lost, {
      migrations: [...LEDGER_MIGRATIONS, V2],
      failpoint: p => { if (p === point) lost.release(); },
    }), code('sentinel.store.ownerNotHeld'), point);
    assert.deepEqual(peek(path), { version: N, appId: LEDGER_APPLICATION_ID, runs: 1, later: 0 }, point);
    const successor = await openLedger(owner(dir), { migrations: [...LEDGER_MIGRATIONS, V2] });
    assert.equal(successor.migration.to, N + 1, point);
    successor.close();
  }
  const fresh = scratch(t);
  const lost = owner(fresh);
  await assert.rejects(openLedger(lost, { failpoint: p => { if (p === 'migrate:after-sql') lost.release(); } }),
    code('sentinel.store.ownerNotHeld'));
  const db = new DatabaseSync(join(fresh, 'ledger.sqlite'), { readOnly: true });
  assert.equal(Number(Object.values(db.prepare("SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()!)[0]), 0);
  db.close();
});

test('no ledger path may name the owner lock file, by spelling, case or inode', async t => {
  const dir = scratch(t);
  const lockPath = join(dir, 'owner.sqlite');
  writeFileSync(lockPath, '', { mode: 0o600 });
  const before = statSync(lockPath, { bigint: true });
  const at = (ledger: string) => {
    const o = owner(dir) as unknown as { layout: { root: string; ledger: string; owner: string } };
    o.layout = { root: dir, ledger, owner: lockPath };
    return openLedger(o as never);
  };
  await assert.rejects(at(lockPath), code('sentinel.store.unsafePath'));
  await assert.rejects(at(join(dir, '.', 'owner.sqlite')), code('sentinel.store.unsafePath'));
  if (process.platform === 'darwin') await assert.rejects(at(join(dir, 'OWNER.sqlite')), code('sentinel.store.unsafePath'));
  linkSync(lockPath, join(dir, 'alias.sqlite'));
  await assert.rejects(at(join(dir, 'alias.sqlite')), code('sentinel.store.unsafePath'));
  const after = statSync(lockPath, { bigint: true });
  assert.equal(after.size, 0n);
  assert.equal(after.mtimeNs, before.mtimeNs, 'the owner file was never written');
});
