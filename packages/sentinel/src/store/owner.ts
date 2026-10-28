// Store ownership: one process at a time holds a store, for its whole lifetime.
//
// The lock is a lifetime EXCLUSIVE transaction on owner.sqlite in rollback-journal (DELETE) mode, separate from
// the WAL ledger. SQLite takes POSIX advisory locks through its unix VFS, so the operating system releases them
// when the process dies, however it dies, and the next opener rolls the dead holder's hot journal back. There
// is no lease, no PID file and no time-based takeover. owner.sqlite is never deleted, so every process locks the
// same inode; its path and the folder's are bound to the inode identity seen at acquisition and re-checked by
// assertHeld(). owner.json describes the holder for people and tools; it is never consulted as the lock.
//
// The epoch is an opaque contract Id (`epoch-<uuid>`, the coordinatorEpoch of PR 02's envelopes), committed
// before the lock is held: BEGIN EXCLUSIVE, record the new epoch and bump a private generation counter, COMMIT,
// BEGIN EXCLUSIVE again and confirm no other process committed in between. A process that loses the race
// between the two transactions gets no epoch. Epochs are unique per acquisition; their order is not public.
//
// Same-process rule: a second acquisition in this process is refused before any descriptor is opened, because
// closing a descriptor on the locked file would drop the process's own lock (see paths.ts).
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import type { Id } from '../contracts/common.js';
import { StoreError, ioFailure, isSqliteBusy, sqlitePrimaryCode } from './errors.js';
import {
  assertPrivateFileIfPresent,
  hasIdentity,
  preparePrivateFile,
  prepareStoreRoot,
  storeLayout,
  type FileIdentity,
  type FilesystemIdentity,
  type StoreLayout,
} from './paths.js';
import { checkSqliteRuntime, type SqliteRuntime } from './runtime.js';

/** Something that must close while the lock is still held, such as the ledger connection. */
export interface OwnedResource {
  /** Shown in a resourceCloseFailed error; no other use. */
  readonly name?: string;
  close(): void;
}

/** An opaque ownership capability. There is deliberately no access to the lock's database connection. */
export interface StoreOwner {
  /** The canonical store folder. */
  readonly storePath: string;
  readonly layout: StoreLayout;
  /** Stable for the life of the store; created by the first owner. */
  readonly storeId: string;
  /** Unique per acquisition (`epoch-<uuid>`); the coordinatorEpoch that fences work started under another owner. */
  readonly epoch: Id;
  readonly filesystem: FilesystemIdentity;
  /** The store folder's `dev:ino` seen at acquisition; assertHeld() re-checks the folder still has it. */
  readonly rootIdentity: FileIdentity;
  /** The checked SQLite runtime; ledger code opens its connection through `runtime.sqlite`. */
  readonly runtime: SqliteRuntime;
  /** False once closed, closing or lost. Cheap; does not re-check identity (assertHeld does). */
  readonly held: boolean;
  /** Throws ownerClosed, ownerLost or identityChanged unless this process still holds the store. Synchronous. */
  assertHeld(): void;
  /** Register a resource to close (last registered first) before the lock is released. Returns an unregister. */
  registerResource(resource: OwnedResource): () => void;
  /** Close registered resources, remove this holder's descriptor, release the lock. Idempotent. */
  close(): void;
}

/** How an owner lock is acquired: SQLite's busy budget for a contended lock. */
export interface AcquireOptions {
  /**
   * SQLite's busy budget for a contended lock, in ms (0–10000, default 250). Not a lease. SQLite's busy handler
   * sleeps in coarse steps, so the wall time is longer: 250 measured about 1.2 s on darwin-arm64 with 3.53.3.
   */
  waitMs?: number;
}

/** owner.json: informational only. */
export interface OwnerDescriptor {
  format: 'sentinel-owner-descriptor/draft-1';
  storeId: string;
  epoch: Id;
  pid: number;
  acquiredAt: string;
  node: string;
  sqlite: string;
  platform: string;
}

const DEFAULT_WAIT_MS = 250;
const MAX_ATTEMPTS = 3;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS owner_store (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  epoch TEXT,
  format INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS owner_hold (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  epoch TEXT NOT NULL
) STRICT;`;

type Db = InstanceType<SqliteRuntime['sqlite']['DatabaseSync']>;

// Stores held by this process, by the lock file's inode identity and by canonical path.
const heldInProcess = new Set<string>();

/**
 * Takes the store's owner lock for this process with a fresh epoch. Refuses, with a StoreError, an unqualified
 * runtime, an unsafe path or lock file, a store this process or another already holds, and a folder or lock file
 * whose identity changed while it was acquired; a `waitMs` outside 0 to 10000 is a RangeError.
 */
export async function acquireStoreOwner(storePath: string, options: AcquireOptions = {}): Promise<StoreOwner> {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 10_000)
    throw new RangeError('waitMs must be an integer from 0 to 10000');
  const runtime = await checkSqliteRuntime();
  const root = prepareStoreRoot(storePath, { create: true });
  const layout = storeLayout(root.path);
  if (heldInProcess.has(`path:${layout.root}`))
    throw new StoreError('sentinel.store.ownedElsewhere', { path: layout.root, holder: 'this process' });
  const lockFile = preparePrivateFile(layout.owner);
  if (heldInProcess.has(`inode:${lockFile.identity}`))
    throw new StoreError('sentinel.store.ownedElsewhere', { path: layout.root, holder: 'this process' });
  assertPrivateFileIfPresent(`${layout.owner}-journal`);

  let db: Db;
  try {
    db = new runtime.sqlite.DatabaseSync(layout.owner);
  } catch (error) {
    throw ioFailure('open-owner', error);
  }
  const epoch: Id = `epoch-${randomUUID()}`;
  try {
    const { storeId } = lock(db, waitMs, epoch, layout.owner);
    if (!hasIdentity(layout.owner, lockFile.identity) || !hasIdentity(layout.root, root.identity)) {
      throw new StoreError('sentinel.store.identityChanged', { path: layout.root });
    }
    // Everything that can fail happens before the Owner exists: its constructor is the only place that records
    // the store as held in this process, so a failed acquisition leaves no registration behind to clean up.
    writeDescriptor(layout, {
      format: 'sentinel-owner-descriptor/draft-1',
      storeId,
      epoch,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      node: runtime.node,
      sqlite: runtime.sqliteVersion,
      platform: `${runtime.platform}-${runtime.arch}`,
    });
    return new Owner(db, runtime, layout, root.filesystem, root.identity, lockFile.identity, storeId, epoch);
  } catch (error) {
    release(db);
    throw error;
  }
}

// SQLITE_CORRUPT (11) and SQLITE_NOTADB (26): the lock file holds bytes SQLite cannot read as a database.
const CORRUPT_CODES = new Set([11, 26]);

/** Every failure of the lock protocol leaves as a StoreError with the SQLite error kept as its cause. */
function lockFailure(error: unknown, path: string): StoreError {
  if (error instanceof StoreError) return error;
  if (isSqliteBusy(error)) return new StoreError('sentinel.store.ownedElsewhere', {}, { cause: error });
  const sqliteCode = sqlitePrimaryCode(error) ?? null;
  if (sqliteCode !== null && CORRUPT_CODES.has(sqliteCode))
    return new StoreError('sentinel.store.lockFileCorrupt', { path, sqliteCode }, { cause: error });
  return new StoreError('sentinel.store.ioFailure', { operation: 'owner-lock', sqliteCode }, { cause: error });
}

function lock(db: Db, waitMs: number, epoch: Id, path: string): { storeId: string } {
  const read = () =>
    db.prepare('SELECT store_id AS storeId, generation, epoch FROM owner_store').get() as {
      storeId: string;
      generation: number;
      epoch: string | null;
    };
  try {
    db.exec(`PRAGMA busy_timeout=${waitMs}`);
    const mode = (db.prepare('PRAGMA journal_mode=DELETE').get() as { journal_mode: string }).journal_mode;
    if (mode !== 'delete') throw new StoreError('sentinel.store.ownershipUncertain', { journalMode: mode });
    db.exec('PRAGMA synchronous=FULL');
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      db.exec('BEGIN EXCLUSIVE');
      db.exec(SCHEMA);
      db.prepare('INSERT OR IGNORE INTO owner_store VALUES (1, ?, 0, NULL, 1)').run(randomUUID());
      db.prepare('UPDATE owner_store SET generation = generation + 1, epoch = ?').run(epoch);
      const committed = read();
      db.exec('COMMIT');
      db.exec('BEGIN EXCLUSIVE');
      const now = read();
      if (now.epoch !== epoch || now.generation !== committed.generation || now.storeId !== committed.storeId) {
        // Another process committed between our two transactions; it may hold or have held the store since.
        db.exec('ROLLBACK');
        continue;
      }
      // The uncommitted row makes a journal, so a holder that dies leaves a hot journal the next opener rolls back.
      db.prepare('INSERT OR REPLACE INTO owner_hold VALUES (1, ?)').run(epoch);
      if (!db.isTransaction) throw new StoreError('sentinel.store.ownershipUncertain', {});
      return { storeId: now.storeId };
    }
    throw new StoreError('sentinel.store.ownershipUncertain', { attempts: MAX_ATTEMPTS });
  } catch (error) {
    throw lockFailure(error, path);
  }
}

function release(db: Db): void {
  try {
    if (db.isOpen && db.isTransaction) db.exec('ROLLBACK');
  } catch {
    /* closing below still releases the lock */
  }
  try {
    if (db.isOpen) db.close();
  } catch {
    /* process exit releases it in the worst case */
  }
}

function writeDescriptor(layout: StoreLayout, descriptor: OwnerDescriptor): void {
  const tmp = `${layout.descriptor}.${descriptor.epoch}.tmp`;
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, `${JSON.stringify(descriptor, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, layout.descriptor);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing was written */
    }
    throw ioFailure('write-descriptor', error);
  }
}

function removeOwnDescriptor(layout: StoreLayout, epoch: Id): void {
  try {
    const current = JSON.parse(readFileSync(layout.descriptor, 'utf8')) as Partial<OwnerDescriptor>;
    if (current.epoch === epoch) unlinkSync(layout.descriptor);
  } catch {
    /* absent or replaced: it is informational, and not ours to remove then */
  }
}

class Owner implements StoreOwner {
  #db: Db;
  #state: 'held' | 'closing' | 'closed' | 'lost' = 'held';
  #resources: OwnedResource[] = [];
  readonly #rootIdentity: FileIdentity;
  readonly #lockIdentity: FileIdentity;

  constructor(
    db: Db,
    readonly runtime: SqliteRuntime,
    readonly layout: StoreLayout,
    readonly filesystem: FilesystemIdentity,
    rootIdentity: FileIdentity,
    lockIdentity: FileIdentity,
    readonly storeId: string,
    readonly epoch: Id,
  ) {
    this.#db = db;
    this.#rootIdentity = rootIdentity;
    this.#lockIdentity = lockIdentity;
    heldInProcess.add(`path:${layout.root}`);
    heldInProcess.add(`inode:${lockIdentity}`);
    Object.freeze(this);
  }

  get storePath(): string {
    return this.layout.root;
  }
  get rootIdentity(): FileIdentity {
    return this.#rootIdentity;
  }
  get held(): boolean {
    return this.#state === 'held';
  }

  assertHeld(): void {
    if (this.#state === 'closed' || this.#state === 'closing')
      throw new StoreError('sentinel.store.ownerClosed', { path: this.layout.root });
    if (this.#state === 'lost') throw new StoreError('sentinel.store.ownerLost', { path: this.layout.root });
    if (!hasIdentity(this.layout.root, this.#rootIdentity) || !hasIdentity(this.layout.owner, this.#lockIdentity)) {
      this.#state = 'lost';
      throw new StoreError('sentinel.store.identityChanged', { path: this.layout.root });
    }
    let holder: string | undefined;
    try {
      if (this.#db.isTransaction)
        holder = (this.#db.prepare('SELECT epoch FROM owner_hold').get() as { epoch: string } | undefined)?.epoch;
    } catch {
      holder = undefined;
    }
    if (holder !== this.epoch) {
      this.#state = 'lost';
      throw new StoreError('sentinel.store.ownerLost', { path: this.layout.root });
    }
  }

  registerResource(resource: OwnedResource): () => void {
    this.assertHeld();
    if (!resource || typeof resource.close !== 'function') throw new TypeError('a resource needs a close() method');
    this.#resources.push(resource);
    return () => {
      const i = this.#resources.lastIndexOf(resource);
      if (i >= 0) this.#resources.splice(i, 1);
    };
  }

  close(): void {
    if (this.#state === 'closed' || this.#state === 'closing') return;
    this.#state = 'closing';
    const failures: { name: string; error: unknown }[] = [];
    for (const resource of this.#resources.splice(0).reverse()) {
      try {
        resource.close();
      } catch (error) {
        failures.push({ name: resource.name ?? 'unnamed', error });
      }
    }
    removeOwnDescriptor(this.layout, this.epoch);
    release(this.#db);
    heldInProcess.delete(`path:${this.layout.root}`);
    heldInProcess.delete(`inode:${this.#lockIdentity}`);
    this.#state = 'closed';
    if (failures.length) {
      throw new StoreError(
        'sentinel.store.resourceCloseFailed',
        { resources: failures.map((f) => f.name) },
        { cause: failures.length === 1 ? failures[0]!.error : new AggregateError(failures.map((f) => f.error)) },
      );
    }
  }
}
