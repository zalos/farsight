// The Sentinel ledger: one SQLite file (WAL, synchronous=FULL, foreign keys) owned by one coordinator. Callers get
// domain operations only — no connection, statement or transaction callback — and every mutation re-checks, inside
// its own transaction, that the store owner is still held and that this ledger's epoch is still the current one.
// Publication additionally fences the exact work revision, its active attempt and that attempt's state, so a
// superseded attempt in the same epoch cannot win.
import { closeSync, lstatSync, openSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { compareTimestamps, isCalendarTimestamp, validateEnvelope } from '../validate.js';
import type {
  AttemptEnvelope, AttemptUsage, Id, RunEnvelope, RunOutcome, RunState, WorkEnvelope, WorkRef,
} from '../contracts/index.js';
import { canonicalJson, digestOf } from './ledger-json.js';
import { LEDGER_MIGRATIONS, migrateLedger, type LedgerGuard } from './migrations.js';
import {
  ARTIFACT_CODECS, ARTIFACT_PRIVACY, LedgerError, MAX_ARTIFACT_BYTES, MAX_EVENT_PAGE, MAX_SNAPSHOT_ARTIFACTS,
  type AdmitSnapshotInput, type SnapshotRecord, type AdmitPlanInput, type PlanRecord, type AttemptRecords, type ArtifactPrivacy, type AttemptError, type EndAttemptInput, type WorkTransition, type EventPage, type GcSnapshot, type IdempotencyRef, type LedgerEvent,
  type LedgerEventKind, type LedgerFailpoint, type LedgerOwner, type MigrationReport, type ObjectVerifier,
  type ObjectReceipt, type OpenLedgerOptions, type PublicationReceipt, type PublishInput, type StageId,
  type StagedArtifact, type VerifiedObject,
} from './store-types.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CATALOG_KEY = /^sentinel\.[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;
const MAX_ERROR_DETAIL_BYTES = 4096;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_STAGED = 4096;
const MAX_PAYLOAD_BYTES = 16384;

const RUN_MOVES: Readonly<Record<RunState, readonly RunState[]>> = {
  planned: ['running', 'canceling', 'canceled'],
  running: ['pausing', 'canceling', 'completed'],
  pausing: ['paused', 'canceling'],
  paused: ['running', 'canceling'],
  canceling: ['canceled'],
  canceled: [],
  completed: [],
};
/** Runs that may still accept a publication: pause stops admission but lets in-flight work publish. */
const PUBLISHING_RUN_STATES: readonly RunState[] = ['running', 'pausing'];

const invalid = (message: string) => new LedgerError('sentinel.store.invalidInput', message);
const checkId = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || value.length > 128 || !ID.test(value)) throw invalid(`${what} is not a ledger ID`);
  return value;
};
const checkDigest = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw invalid(`${what} is not a sha256 digest`);
  return value;
};
const checkRef = (ref: WorkRef, what = 'work'): WorkRef => {
  checkId(ref?.id, `${what} id`);
  if (!Number.isInteger(ref.revision) || ref.revision < 1 || ref.revision > 2147483647) {
    throw invalid(`${what} revision is not a positive ordinal`);
  }
  return { id: ref.id, revision: ref.revision };
};
const checkTime = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !isCalendarTimestamp(value)) throw invalid(`${what} is not a Sentinel timestamp`);
  return value;
};
/**
 * The ledger and its WAL/SHM siblings are regular files owned by this user with no group or other access; a new
 * ledger file is created 0600 before SQLite opens it (SQLite gives its siblings the main file's mode).
 */
function preparePrivateLedgerFile(path: string, guard: LedgerGuard): void {
  for (const p of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) guard.notOwnerFile(p);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  for (const p of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    let stat;
    try { stat = lstatSync(p); } catch { continue; }
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) {
      throw new LedgerError('sentinel.store.unsafePath', 'a ledger file is not a private regular file of this user');
    }
  }
  try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new LedgerError('sentinel.store.unsafePath', 'could not create the ledger file', { cause: error });
    }
  }
}

/**
 * Any descriptor this process opens on the owner lock file — and closes — drops its POSIX lock without notice, so
 * no ledger, sibling or backup path may name it, by spelling or by inode. Only lstat is used: it opens nothing.
 */
function ownerGuard(owner: LedgerOwner): LedgerGuard {
  const ownerPath = resolve(owner.layout.owner);
  const fold = (p: string) => (process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p);
  return {
    assertHeld() {
      try { owner.assertHeld(); } catch (cause) {
        throw new LedgerError('sentinel.store.ownerNotHeld', 'the store owner is no longer held', { cause });
      }
    },
    notOwnerFile(candidate: string) {
      const refuse = () => new LedgerError('sentinel.store.unsafePath', 'a ledger path names the owner lock file');
      if (fold(resolve(candidate)) === fold(ownerPath)) throw refuse();
      let a; let b;
      try { a = lstatSync(candidate, { bigint: true }); } catch { return; }
      try { b = lstatSync(ownerPath, { bigint: true }); } catch { return; }
      if (a.dev === b.dev && a.ino === b.ino) throw refuse();
    },
  };
}

const privacyRank = (p: ArtifactPrivacy) => ARTIFACT_PRIVACY.indexOf(p);

function contract<K extends 'run' | 'work' | 'attempt'>(kind: K, value: unknown) {
  const result = validateEnvelope(kind, value);
  if (!result.ok) {
    const first = result.errors[0];
    throw invalid(`not a valid ${kind} envelope (${first?.code ?? 'unknown'} at ${first?.path || '/'})`);
  }
  return result.value;
}

function isConstraint(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && (code & 0xff) === 19;
}

type Row = Record<string, unknown>;

/**
 * Opens (creating or upgrading) the ledger under a held store owner. An existing ledger is backed up and the copy
 * verified before any schema change; a failed backup or migration leaves the file as it was.
 */
export async function openLedger(owner: LedgerOwner, options: OpenLedgerOptions = {}): Promise<Ledger> {
  const guard = ownerGuard(owner);
  guard.assertHeld();
  // The owner has already checked the SQLite release and the store root (canonical, local, owner-only, no alias).
  const sqlite = owner.runtime.sqlite;
  const path = owner.layout.ledger;
  preparePrivateLedgerFile(path, guard);
  guard.assertHeld();
  const now = options.now ?? (() => new Date().toISOString());
  const failpoint = options.failpoint ?? (() => {});
  const db = new sqlite.DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 0, defensive: true });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    const mode = Object.values(db.prepare('PRAGMA journal_mode').get() ?? {})[0];
    const sync = Number(Object.values(db.prepare('PRAGMA synchronous').get() ?? {})[0]);
    const fk = Number(Object.values(db.prepare('PRAGMA foreign_keys').get() ?? {})[0]);
    if (mode !== 'wal' || sync !== 2 || fk !== 1) {
      throw new LedgerError('sentinel.store.sqliteUnsupported', 'WAL, synchronous=FULL and foreign keys are required');
    }
    guard.assertHeld();
    const migration = await migrateLedger(db, path, {
      migrations: options.migrations ?? LEDGER_MIGRATIONS,
      build: options.build ?? 'unknown',
      now,
      backupTag: checkId(owner.epoch, 'owner epoch'),
      sqlite,
      failpoint,
      guard,
    });
    guard.assertHeld();
    const ledger = new Ledger(db, owner, path, migration, now, failpoint, options.objects);
    owner.registerResource(ledger);
    return ledger;
  } catch (error) {
    if (db.isOpen) db.close();
    throw error;
  }
}

export class Ledger {
  readonly #db: DatabaseSync;
  readonly #owner: LedgerOwner;
  readonly #now: () => string;
  readonly #failpoint: (p: LedgerFailpoint) => void;
  readonly #objects: ObjectVerifier | undefined;
  readonly path: string;
  readonly epoch: Id;
  readonly storeId: Id;
  readonly migration: MigrationReport;
  #closed = false;

  /** @internal Use openLedger(). */
  constructor(
    db: DatabaseSync, owner: LedgerOwner, path: string, migration: MigrationReport, now: () => string,
    failpoint: (p: LedgerFailpoint) => void, objects: ObjectVerifier | undefined,
  ) {
    this.#db = db;
    this.#owner = owner;
    this.#now = now;
    this.#failpoint = failpoint;
    this.#objects = objects;
    this.path = path;
    this.migration = migration;
    this.epoch = checkId(owner.epoch, 'owner epoch');
    this.storeId = checkId(owner.storeId, 'store id');
    this.#openEpoch();
  }

  get closed(): boolean { return this.#closed; }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
    this.#db.close();
  }

  // ---- transactions ----

  #get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.#db.prepare(sql).get(...params) as Row | undefined;
  }
  #all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.#db.prepare(sql).all(...params) as Row[];
  }
  #run(sql: string, ...params: SQLInputValue[]) {
    return this.#db.prepare(sql).run(...params);
  }

  #assertOwner(): void {
    try { this.#owner.assertHeld(); } catch (cause) {
      throw new LedgerError('sentinel.store.ownerNotHeld', 'the store owner is no longer held', { cause });
    }
  }

  /** One short IMMEDIATE transaction. The body is synchronous; a returned promise is refused and rolled back. */
  #transaction<T>(body: () => T, fence: boolean, commitPoint?: LedgerFailpoint): T {
    if (this.#closed) throw new LedgerError('sentinel.store.closed', 'the ledger is closed');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#assertOwner();
      if (fence) {
        const current = this.#get('SELECT store_id, current_epoch FROM ledger_store WHERE singleton = 1');
        if (current?.store_id !== this.storeId) throw new LedgerError('sentinel.store.storeMismatch', 'store identity changed');
        if (current.current_epoch !== this.epoch) {
          throw new LedgerError('sentinel.store.staleEpoch', 'a newer coordinator epoch owns this ledger');
        }
      }
      const result = body();
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new LedgerError('sentinel.store.asyncTransaction', 'a ledger transaction body must be synchronous');
      }
      if (commitPoint) this.#failpoint(commitPoint);
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      if (error instanceof LedgerError) throw error;
      if (isConstraint(error)) {
        throw new LedgerError('sentinel.store.conflict', 'a ledger constraint refused the change', { cause: error });
      }
      throw error;
    }
  }

  /** A fenced mutation; with a key, the same request replays its first result and a different one is refused. */
  #mutate<T>(operation: string, request: unknown, idem: IdempotencyRef | undefined, body: () => T,
    commitPoint?: LedgerFailpoint): T {
    const digest = idem ? digestOf({ operation, request }) : null;
    if (idem) { checkId(idem.clientId, 'idempotency client'); checkId(idem.key, 'idempotency key'); }
    return this.#transaction(() => {
      if (idem && digest) {
        const prior = this.#get(
          'SELECT operation, request_digest, result FROM idempotency_keys WHERE client_id = ? AND key = ?',
          idem.clientId, idem.key);
        if (prior) {
          if (prior.operation !== operation || prior.request_digest !== digest) {
            throw new LedgerError('sentinel.store.idempotencyConflict',
              'the idempotency key was already used for a different request');
          }
          return JSON.parse(String(prior.result)) as T;
        }
      }
      const result = body();
      if (idem && digest) {
        this.#run(`INSERT INTO idempotency_keys (client_id, key, operation, request_digest, result, coordinator_epoch,
          created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, idem.clientId, idem.key, operation, digest,
        JSON.stringify(result ?? null), this.epoch, this.#now());
      }
      return result;
    }, true, commitPoint);
  }

  #event(kind: LedgerEventKind, runId: Id | null, work: WorkRef | null, payload: Record<string, unknown>): number {
    const text = JSON.stringify(payload);
    if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) throw invalid('event payload exceeds its bound');
    const info = this.#run(`INSERT INTO events (kind, run_id, work_id, work_revision, coordinator_epoch, at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, kind, runId, work?.id ?? null, work?.revision ?? null, this.epoch, this.#now(), text);
    return Number(info.lastInsertRowid);
  }

  #openEpoch(): void {
    this.#transaction(() => {
      const store = this.#get('SELECT store_id, current_epoch FROM ledger_store WHERE singleton = 1');
      if (this.#get('SELECT 1 AS x FROM epochs WHERE epoch = ?', this.epoch)) {
        throw new LedgerError('sentinel.store.staleEpoch', 'this owner epoch was already used');
      }
      const at = this.#now();
      if (!store) {
        this.#run('INSERT INTO epochs (epoch, previous_epoch, opened_at) VALUES (?, NULL, ?)', this.epoch, at);
        this.#run('INSERT INTO ledger_store (singleton, store_id, current_epoch, created_at) VALUES (1, ?, ?, ?)',
          this.storeId, this.epoch, at);
      } else {
        if (store.store_id !== this.storeId) {
          throw new LedgerError('sentinel.store.storeMismatch', 'the ledger belongs to another store');
        }
        this.#run('INSERT INTO epochs (epoch, previous_epoch, opened_at) VALUES (?, ?, ?)',
          this.epoch, String(store.current_epoch), at);
        this.#run('UPDATE ledger_store SET current_epoch = ? WHERE singleton = 1', this.epoch);
      }
      this.#event('epoch-opened', null, null, { previous: store?.current_epoch ?? null });
    }, false);
  }

  #requireCurrentEpoch(value: string, what: string): void {
    if (value !== this.epoch) throw new LedgerError('sentinel.store.staleEpoch', `${what} names another coordinator epoch`);
  }

  // ---- runs ----

  /** Records a new run (planned or running) under this epoch. A child run names its parent. */
  createRun(envelope: RunEnvelope, opts: { idempotency?: IdempotencyRef } = {}): { runId: Id; sequence: number } {
    const run = contract('run', envelope);
    return this.#mutate('createRun', run, opts.idempotency, () => {
      if (run.state !== 'planned' && run.state !== 'running') throw invalid('a new run starts planned or running');
      this.#requireCurrentEpoch(run.coordinatorEpoch, 'the run');
      if (run.parentId && !this.#get('SELECT 1 AS x FROM runs WHERE id = ?', run.parentId)) {
        throw new LedgerError('sentinel.store.notFound', 'the parent run is not in the ledger');
      }
      // A run whose plans were admitted starts at one of them, and every analysis revision it has binds its snapshot.
      if (this.migration.to >= 4) this.#checkRunPlans(run.id, run.planRevision, run.snapshotId);
      this.#run(`INSERT INTO runs (id, parent_id, snapshot_id, plan_revision, coordinator_epoch, state, envelope,
        created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, run.id, run.parentId, run.snapshotId, run.planRevision,
      run.coordinatorEpoch, run.state, JSON.stringify(run), run.createdAt);
      return { runId: run.id, sequence: this.#event('run-created', run.id, null, { state: run.state }) };
    });
  }

  setRunState(runId: Id, to: RunState, opts: { outcome?: RunOutcome; idempotency?: IdempotencyRef } = {}):
    { runId: Id; state: RunState; sequence: number } {
    checkId(runId, 'run id');
    return this.#mutate('setRunState', { runId, to, outcome: opts.outcome ?? null }, opts.idempotency, () => {
      const row = this.#get('SELECT state FROM runs WHERE id = ?', runId);
      if (!row) throw new LedgerError('sentinel.store.notFound', 'no such run');
      const from = row.state as RunState;
      if (!RUN_MOVES[from]?.includes(to)) throw new LedgerError('sentinel.store.wrongState', `a run cannot move ${from} → ${to}`);
      if ((to === 'completed') !== (opts.outcome !== undefined)) throw invalid('an outcome is given exactly when completing');
      this.#run('UPDATE runs SET state = ?, outcome = ?, completed_at = ? WHERE id = ?', to, opts.outcome ?? null,
        to === 'completed' ? this.#now() : null, runId);
      return { runId, state: to, sequence: this.#event('run-state', runId, null, { from, to, ...(opts.outcome ? { outcome: opts.outcome } : {}) }) };
    });
  }

  // ---- work and attempts ----

  /** Appends a work revision. Revisions of one ID are contiguous: the next is always the highest plus one. */
  createWork(envelope: WorkEnvelope, opts: { idempotency?: IdempotencyRef; records?: AttemptRecords } = {}): { work: WorkRef; sequence: number } {
    const work = contract('work', envelope);
    // The influence manifest the work names may be accepted with it, so the root it names is a stored record.
    const records = opts.records ? this.#checkUnboundStage(opts.records, 'work records') : null;
    if (records && !records.receipts.some(r => r.id === work.influenceManifest)) throw invalid('work records must hold the work\'s influence manifest');
    return this.#mutate('createWork', records ? { work, records: { stageId: records.stageId, receipts: records.receipts } } : work, opts.idempotency, () => {
      if (work.state !== 'pending' && work.state !== 'ready') throw invalid('new work starts pending or ready');
      this.#requireCurrentEpoch(work.coordinatorEpoch, 'the work');
      const run = this.#get('SELECT state, plan_revision FROM runs WHERE id = ?', work.runId);
      if (!run) throw new LedgerError('sentinel.store.notFound', 'the work names an unknown run');
      // A run with admitted plans takes work only from an admitted revision no later than its current one.
      if (this.migration.to >= 4 && this.#get('SELECT 1 AS x FROM plans WHERE run_id = ?', work.runId)
        && (work.planRevision > Number(run.plan_revision) || !this.#get('SELECT 1 AS x FROM plans WHERE run_id = ? AND revision = ?', work.runId, work.planRevision))) {
        throw new LedgerError('sentinel.store.wrongState', 'the work names a plan revision this run has not admitted');
      }
      if (run.state === 'completed' || run.state === 'canceled') {
        throw new LedgerError('sentinel.store.wrongState', 'the run has ended');
      }
      const top = Number(this.#get('SELECT coalesce(max(revision), 0) AS r FROM work_units WHERE id = ?', work.id)?.r ?? 0);
      if (work.revision !== top + 1) {
        throw new LedgerError('sentinel.store.conflict', `work ${work.id} expects revision ${top + 1}`);
      }
      this.#run(`INSERT INTO work_units (id, revision, run_id, plan_revision, input_fingerprint, influence_manifest,
        coordinator_epoch, state, active_attempt_id, envelope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      work.id, work.revision, work.runId, work.planRevision, work.inputFingerprint, work.influenceManifest,
      work.coordinatorEpoch, work.state, JSON.stringify(work));
      for (const dep of work.dependencies) {
        this.#run(`INSERT INTO work_dependencies (work_id, work_revision, depends_on_id, depends_on_revision)
          VALUES (?, ?, ?, ?)`, work.id, work.revision, dep.id, dep.revision);
      }
      const ref = { id: work.id, revision: work.revision };
      const sequence = this.#event('work-created', work.runId, ref, { state: work.state });
      if (records) this.#acceptUnboundStages([records.stageId], records.receipts, [work.influenceManifest], sequence);
      return { work: ref, sequence };
    });
  }

  /**
   * Starts an attempt on a ready work revision. With `supersede`, a running revision's current attempt is marked
   * interrupted and replaced; the old attempt can then never publish, even within this epoch.
   */
  startAttempt(envelope: AttemptEnvelope, opts: { supersede?: boolean; idempotency?: IdempotencyRef; records?: AttemptRecords } = {}):
    { attemptId: Id; work: WorkRef; superseded: Id | null; sequence: number } {
    const attempt = contract('attempt', envelope);
    // The invocation record (and what it links) is accepted with the start, so an attempt that later fails, is
    // canceled or is interrupted still names a durable record of what it was asked to run.
    const records = opts.records ? this.#checkUnboundStage(opts.records, 'attempt records') : null;
    if (records && (attempt.invocation === undefined || !records.receipts.some(r => r.id === attempt.invocation))) {
      throw invalid('attempt records must hold the attempt\'s invocation record');
    }
    return this.#mutate('startAttempt', { attempt, supersede: !!opts.supersede, records: records ? { stageId: records.stageId, receipts: records.receipts } : null }, opts.idempotency, () => {
      if (attempt.state !== 'running') throw invalid('a new attempt starts running');
      if (attempt.worker.kind === 'external-claim') throw invalid('external claims are not admitted by this ledger yet');
      this.#requireCurrentEpoch(attempt.coordinatorEpoch, 'the attempt');
      const ref = attempt.work;
      const work = this.#get(`SELECT w.state, w.active_attempt_id, w.run_id, r.state AS run_state FROM work_units w
        JOIN runs r ON r.id = w.run_id WHERE w.id = ? AND w.revision = ?`, ref.id, ref.revision);
      if (!work) throw new LedgerError('sentinel.store.notFound', 'no such work revision');
      if (work.run_state !== 'running') throw new LedgerError('sentinel.store.wrongState', 'the run is not admitting work');
      let superseded: Id | null = null;
      if (work.state === 'running' && opts.supersede) {
        superseded = String(work.active_attempt_id);
        this.#finishAttempt(superseded, 'interrupted', this.#now(), undefined, [], true);
      } else if (work.state !== 'ready') {
        throw new LedgerError('sentinel.store.wrongState', `work is ${String(work.state)}, not ready`);
      }
      const top = Number(this.#get('SELECT coalesce(max(ordinal), 0) AS o FROM attempts WHERE work_id = ? AND work_revision = ?',
        ref.id, ref.revision)?.o ?? 0);
      if (attempt.ordinal !== top + 1) throw new LedgerError('sentinel.store.conflict', `attempt ordinal ${top + 1} expected`);
      this.#run(`INSERT INTO attempts (id, work_id, work_revision, ordinal, coordinator_epoch, state, usage_certainty,
        started_at, ended_at, envelope) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, NULL, ?)`, attempt.id, ref.id, ref.revision,
      attempt.ordinal, attempt.coordinatorEpoch, attempt.usage.certainty, attempt.startedAt, JSON.stringify(attempt));
      this.#run("UPDATE work_units SET state = 'running', active_attempt_id = ? WHERE id = ? AND revision = ?",
        attempt.id, ref.id, ref.revision);
      const sequence = this.#event('attempt-started', String(work.run_id), ref, { attemptId: attempt.id, superseded });
      if (records) this.#acceptUnboundStages([records.stageId], records.receipts, [attempt.invocation!], sequence);
      return { attemptId: attempt.id, work: { id: ref.id, revision: ref.revision }, superseded, sequence };
    });
  }

  /**
   * Ends a running attempt with a validated final envelope built from its stored start: the start's identity and
   * time, the end state and time, the outputs and the observed usage (the start's when none is given). The contract's
   * own invariants then apply against what is stored — an end before the start (at full precision) or a
   * canceled-after-spend without confirmed usage is refused; the ledger never invents a usage fact. A supersession
   * at an instant before the start (clock skew) is recorded at the start.
   */
  #finishAttempt(attemptId: Id, state: AttemptEnvelope['state'], endedAt: string, usage: AttemptUsage | undefined,
    outputs: string[], clampToStart = false, error?: AttemptError): void {
    const row = this.#get("SELECT envelope FROM attempts WHERE id = ? AND state = 'running'", attemptId);
    if (!row) throw new LedgerError('sentinel.store.notActiveAttempt', 'the attempt is not running');
    const start = JSON.parse(String(row.envelope)) as AttemptEnvelope;
    const at = clampToStart && compareTimestamps(endedAt, start.startedAt) < 0 ? start.startedAt : endedAt;
    const recorded = error ? { error: { code: error.code, retryable: error.retryable, ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}) } } : {};
    const final = contract('attempt', { ...start, state, endedAt: at, outputs, usage: usage ?? start.usage, ...recorded });
    // The detail column exists from schema 3; an end without one writes only the foundation columns.
    if (error?.detail) {
      this.#run(`UPDATE attempts SET state = ?, ended_at = ?, final_usage_certainty = ?, final_envelope = ?, error_detail = ?
        WHERE id = ?`, state, at, final.usage.certainty, JSON.stringify(final), canonicalJson(error.detail), attemptId);
    } else {
      this.#run('UPDATE attempts SET state = ?, ended_at = ?, final_usage_certainty = ?, final_envelope = ? WHERE id = ?',
        state, at, final.usage.certainty, JSON.stringify(final), attemptId);
    }
  }

  #checkError(error: AttemptError | undefined): AttemptError | undefined {
    if (error === undefined) return undefined;
    if (!error || typeof error !== 'object' || !CATALOG_KEY.test(String(error.code)) || typeof error.retryable !== 'boolean') {
      throw invalid('an attempt error is a catalog code and whether it is retryable');
    }
    if (error.diagnostics !== undefined) {
      checkDigest(error.diagnostics, 'error diagnostics');
      if (!this.#get('SELECT 1 AS x FROM artifacts WHERE id = ?', error.diagnostics)) {
        throw new LedgerError('sentinel.store.notFound', 'error diagnostics name an artifact that is not accepted');
      }
    }
    if (error.detail !== undefined) {
      const text = canonicalJson(error.detail);
      if (typeof error.detail !== 'object' || Array.isArray(error.detail) || Buffer.byteLength(text, 'utf8') > MAX_ERROR_DETAIL_BYTES) {
        throw invalid(`an attempt error detail is a JSON object of at most ${MAX_ERROR_DETAIL_BYTES} bytes`);
      }
    }
    return error;
  }

  /** The fence every attempt-scoped write passes: exact revision, its active attempt, running, this epoch. */
  #fenceAttempt(ref: WorkRef, attemptId: Id): { runId: Id; runState: RunState } {
    const row = this.#get(`SELECT w.state AS work_state, w.active_attempt_id, w.run_id, r.state AS run_state,
        a.state AS attempt_state, a.coordinator_epoch, a.work_id, a.work_revision
      FROM work_units w JOIN runs r ON r.id = w.run_id LEFT JOIN attempts a ON a.id = ?
      WHERE w.id = ? AND w.revision = ?`, attemptId, ref.id, ref.revision);
    if (!row) throw new LedgerError('sentinel.store.notFound', 'no such work revision');
    if (this.#get('SELECT 1 AS x FROM publications WHERE work_id = ? AND work_revision = ?', ref.id, ref.revision)) {
      throw new LedgerError('sentinel.store.alreadyPublished', 'this work revision already has an accepted publication');
    }
    if (row.work_id === null || row.work_id !== ref.id || row.work_revision !== ref.revision) {
      throw new LedgerError('sentinel.store.notActiveAttempt', 'the attempt does not belong to this work revision');
    }
    if (row.work_state !== 'running' || row.active_attempt_id !== attemptId || row.attempt_state !== 'running') {
      throw new LedgerError('sentinel.store.notActiveAttempt', 'the attempt is not the work revision\'s active attempt');
    }
    if (row.coordinator_epoch !== this.epoch) {
      throw new LedgerError('sentinel.store.staleEpoch', 'the attempt was started under another coordinator epoch');
    }
    return { runId: String(row.run_id), runState: row.run_state as RunState };
  }

  /** Ends the active attempt without a publication (failure, interruption, cancellation). */
  endAttempt(input: EndAttemptInput): { attemptId: Id; sequence: number } {
    const ref = checkRef(input.work);
    checkId(input.attemptId, 'attempt id');
    if (!['failed', 'interrupted', 'canceled', 'canceled-after-spend'].includes(input.state)) throw invalid('not an end state');
    if (input.workState !== 'ready' && input.workState !== 'failed') throw invalid('work ends ready or failed');
    checkTime(input.endedAt, 'endedAt');
    const request = { work: ref, attemptId: input.attemptId, state: input.state, endedAt: input.endedAt,
      workState: input.workState, usage: input.usage ?? null, error: input.error ?? null };
    return this.#mutate('endAttempt', request, input.idempotency, () => {
      const error = this.#checkError(input.error);
      const { runId } = this.#fenceAttempt(ref, input.attemptId);
      this.#finishAttempt(input.attemptId, input.state, input.endedAt, input.usage, [], false, error);
      this.#run('UPDATE work_units SET state = ?, active_attempt_id = NULL WHERE id = ? AND revision = ?',
        input.workState, ref.id, ref.revision);
      return { attemptId: input.attemptId,
        sequence: this.#event('attempt-ended', runId, ref, { attemptId: input.attemptId, state: input.state, ...(error ? { code: error.code } : {}) }) };
    });
  }

  /**
   * Releases or holds a work revision that has no active attempt: pending or blocked → ready, and pending, ready or
   * blocked → blocked / disabled-by-policy with a catalog reason. A held revision never starts; a running, leased,
   * published or failed one is not moved here.
   */
  setWorkState(ref: WorkRef, to: WorkTransition, opts: { reasonCode?: string; idempotency?: IdempotencyRef } = {}):
    { work: WorkRef; state: WorkTransition; sequence: number } {
    checkRef(ref);
    if (!['ready', 'blocked', 'disabled-by-policy'].includes(to)) throw invalid('work moves to ready, blocked or disabled-by-policy');
    const held = to !== 'ready';
    if (held !== (opts.reasonCode !== undefined)) throw invalid('a reason is given exactly when holding work');
    if (held && (!CATALOG_KEY.test(String(opts.reasonCode)) || String(opts.reasonCode).length > 128)) throw invalid('the reason is a catalog key');
    return this.#mutate('setWorkState', { ref, to, reason: opts.reasonCode ?? null }, opts.idempotency, () => {
      const row = this.#get(`SELECT w.state, w.run_id, r.state AS run_state FROM work_units w JOIN runs r ON r.id = w.run_id
        WHERE w.id = ? AND w.revision = ?`, ref.id, ref.revision);
      if (!row) throw new LedgerError('sentinel.store.notFound', 'no such work revision');
      const from = String(row.state);
      if (!['pending', 'ready', 'blocked'].includes(from) || from === to) {
        throw new LedgerError('sentinel.store.wrongState', `work cannot move ${from} → ${to}`);
      }
      if (row.run_state === 'completed' || row.run_state === 'canceled') throw new LedgerError('sentinel.store.wrongState', 'the run has ended');
      this.#run('UPDATE work_units SET state = ?, state_reason = ? WHERE id = ? AND revision = ?', to, opts.reasonCode ?? null, ref.id, ref.revision);
      return { work: { id: ref.id, revision: ref.revision }, state: to,
        sequence: this.#event('work-state', String(row.run_id), ref, { from, to, ...(held ? { reason: opts.reasonCode } : {}) }) };
    });
  }

  /**
   * Ends every attempt still running under an earlier epoch as interrupted, under this epoch's fence. Its work
   * becomes ready while its run can still admit work (planned, running, pausing, paused) and failed once the run
   * is canceling or has ended, since no attempt could start for it again. Each is recorded with an attempt-ended
   * event marked stale; nothing from the earlier epoch can publish afterwards.
   */
  interruptStaleAttempts(): Array<{ attemptId: Id; work: WorkRef; epoch: Id; workState: 'ready' | 'failed' }> {
    return this.#transaction(() => {
      const rows = this.#all(`SELECT a.id, a.work_id, a.work_revision, a.coordinator_epoch, w.run_id, r.state AS run_state
        FROM attempts a JOIN work_units w ON w.id = a.work_id AND w.revision = a.work_revision JOIN runs r ON r.id = w.run_id
        WHERE a.state = 'running' AND a.coordinator_epoch <> ? ORDER BY a.started_at, a.id`, this.epoch);
      const out: Array<{ attemptId: Id; work: WorkRef; epoch: Id; workState: 'ready' | 'failed' }> = [];
      for (const r of rows) {
        const ref = { id: String(r.work_id), revision: Number(r.work_revision) };
        const workState = ['planned', 'running', 'pausing', 'paused'].includes(String(r.run_state)) ? 'ready' as const : 'failed' as const;
        this.#finishAttempt(String(r.id), 'interrupted', this.#now(), undefined, [], true,
          { code: 'sentinel.store.staleEpoch', retryable: workState === 'ready' });
        this.#run(`UPDATE work_units SET state = ?, active_attempt_id = NULL WHERE id = ? AND revision = ? AND active_attempt_id = ?`,
          workState, ref.id, ref.revision, String(r.id));
        this.#event('attempt-ended', String(r.run_id), ref, { attemptId: String(r.id), state: 'interrupted', stale: true, epoch: String(r.coordinator_epoch) });
        out.push({ attemptId: String(r.id), work: ref, epoch: String(r.coordinator_epoch), workState });
      }
      return out;
    }, true);
  }

  // ---- staging and publication ----

  /**
   * Durably records what is about to be written to the object store, before any byte is. The rows pin the IDs
   * against collection until the stage is accepted by publish() or removed by abortStaging().
   */
  registerStaging(stageId: StageId, artifacts: StagedArtifact[], forAttempt?: { work: WorkRef; attemptId: Id }):
    { stageId: StageId; sequence: number } {
    checkId(stageId, 'stage id');
    if (!Array.isArray(artifacts) || artifacts.length === 0 || artifacts.length > MAX_STAGED) {
      throw invalid(`a stage holds 1..${MAX_STAGED} artifacts`);
    }
    const ids = new Set<string>();
    for (const a of artifacts) {
      checkDigest(a.id, 'staged artifact');
      if (ids.has(a.id)) throw invalid('a staged artifact is listed twice');
      ids.add(a.id);
      if (typeof a.schema !== 'string' || a.schema.length < 1 || a.schema.length > 128) throw invalid('artifact schema');
      if (!ARTIFACT_PRIVACY.includes(a.privacy)) throw invalid('artifact privacy');
      for (const l of a.links ?? []) {
        checkDigest(l, 'artifact link');
        if (l === a.id) throw invalid('an artifact cannot link itself');
      }
    }
    const target = forAttempt ? { work: checkRef(forAttempt.work), attemptId: checkId(forAttempt.attemptId, 'attempt id') } : null;
    return this.#transaction(() => {
      let runId: Id | null = null;
      if (target) runId = this.#fenceAttempt(target.work, target.attemptId).runId;
      for (const a of artifacts) {
        for (const l of a.links ?? []) {
          if (ids.has(l) || this.#get('SELECT 1 AS x FROM artifacts WHERE id = ?', l)) continue;
          // An unbound stage (a capture's) may link to an artifact another open unbound stage of this epoch holds:
          // they are accepted together by admitSnapshot. An attempt's stage may not.
          if (!target && this.#get(`SELECT 1 AS x FROM staging_artifacts sa JOIN staging s ON s.stage_id = sa.stage_id
            WHERE sa.artifact_id = ? AND s.attempt_id IS NULL AND s.coordinator_epoch = ?`, l, this.epoch)) continue;
          throw new LedgerError('sentinel.store.stagingMismatch', 'a link names an artifact that is neither staged nor stored');
        }
      }
      this.#run(`INSERT INTO staging (stage_id, coordinator_epoch, work_id, work_revision, attempt_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`, stageId, this.epoch, target?.work.id ?? null, target?.work.revision ?? null,
      target?.attemptId ?? null, this.#now());
      for (const a of artifacts) {
        this.#run('INSERT INTO staging_artifacts (stage_id, artifact_id, schema, privacy) VALUES (?, ?, ?, ?)',
          stageId, a.id, a.schema, a.privacy);
        for (const l of new Set(a.links ?? [])) {
          this.#run('INSERT INTO staging_links (stage_id, parent_id, child_id) VALUES (?, ?, ?)', stageId, a.id, l);
        }
      }
      const sequence = this.#event('staging-registered', runId, target?.work ?? null, { stageId, artifacts: artifacts.length });
      return { stageId, sequence };
    }, true, 'staging:before-commit');
  }

  /** Removes a stage that will not be published. Its bytes, if any, become unreferenced and wait for collection. */
  abortStaging(stageId: StageId): { stageId: StageId; sequence: number } {
    checkId(stageId, 'stage id');
    return this.#transaction(() => {
      const row = this.#get(`SELECT s.work_id, s.work_revision, w.run_id FROM staging s
        LEFT JOIN work_units w ON w.id = s.work_id AND w.revision = s.work_revision WHERE s.stage_id = ?`, stageId);
      if (!row) throw new LedgerError('sentinel.store.notFound', 'no such stage');
      this.#run('DELETE FROM staging WHERE stage_id = ?', stageId);
      const work = row.work_id === null ? null : { id: String(row.work_id), revision: Number(row.work_revision) };
      const runId = row.run_id === null ? null : String(row.run_id);
      return { stageId, sequence: this.#event('staging-aborted', runId, work, { stageId }) };
    }, true);
  }

  #checkReceipt(r: ObjectReceipt): void {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw invalid('a receipt is an object');
    checkDigest(r.id, 'receipt artifact');
    checkDigest(r.storedDigest, 'receipt stored digest');
    if (!ARTIFACT_CODECS.includes(r.codec)) throw invalid('receipt codec');
    for (const [n, v] of [['rawSize', r.rawSize], ['storedSize', r.storedSize]] as const) {
      if (!Number.isSafeInteger(v) || v < 0) throw invalid(`receipt ${n}`);
    }
    if (r.rawSize > MAX_ARTIFACT_BYTES) throw invalid('artifact exceeds the decoded size cap');
    if (r.codec === 'identity' && (r.storedDigest !== r.id || r.storedSize !== r.rawSize)) {
      throw invalid('an identity-coded object must store its raw bytes');
    }
  }

  /**
   * Accepts an attempt's result in one transaction: the fence (owner, epoch, exact work revision, active running
   * attempt, publishing run), the staged set equal to the receipts, every object durable, then artifacts, their
   * representations, links, references, the publication, the attempt's end and the event. The stage's pins are
   * removed in the same commit. At-least-once execution yields at most one accepted publication per revision.
   */
  publish(input: PublishInput): PublicationReceipt {
    const ref = checkRef(input.work);
    checkId(input.attemptId, 'attempt id');
    checkId(input.stageId, 'stage id');
    checkTime(input.endedAt, 'endedAt');
    if (!Array.isArray(input.receipts) || input.receipts.length === 0 || input.receipts.length > MAX_STAGED) {
      throw invalid('receipts');
    }
    input.receipts.forEach(r => this.#checkReceipt(r));
    if (!Array.isArray(input.outputs) || new Set(input.outputs).size !== input.outputs.length) {
      throw invalid('outputs must be distinct');
    }
    const receipts = [...input.receipts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.codec < b.codec ? -1 : 1));
    const request = { work: ref, attemptId: input.attemptId, stageId: input.stageId, outputs: input.outputs,
      receipts: receipts.map(r => ({ ...r })), endedAt: input.endedAt, usage: input.usage ?? null };
    // Verified before the transaction: each object is read and hashed by the object store, which can be slow, and
    // the stage registered before any byte was written keeps it pinned against collection until this commit.
    // The transaction then requires that same stage to still be open, so the verification still holds at commit.
    this.#verifyReceipts(receipts, 'publication');
    return this.#mutate('publish', request, input.idempotency, () => {
      const { runId, runState } = this.#fenceAttempt(ref, input.attemptId);
      if (!PUBLISHING_RUN_STATES.includes(runState)) {
        throw new LedgerError('sentinel.store.wrongState', `the run is ${runState}; publication is revoked`);
      }
      const stage = this.#get('SELECT coordinator_epoch, work_id, work_revision, attempt_id FROM staging WHERE stage_id = ?',
        input.stageId);
      if (!stage) throw new LedgerError('sentinel.store.stagingMismatch', 'no such stage');
      if (stage.coordinator_epoch !== this.epoch || stage.work_id !== ref.id || stage.work_revision !== ref.revision
        || stage.attempt_id !== input.attemptId) {
        throw new LedgerError('sentinel.store.stagingMismatch', 'the stage belongs to another attempt or epoch');
      }
      const staged = new Map(this.#all('SELECT artifact_id, schema, privacy FROM staging_artifacts WHERE stage_id = ?',
        input.stageId).map(r => [String(r.artifact_id), r]));
      const received = new Set(receipts.map(r => r.id));
      if (received.size !== staged.size || [...received].some(id => !staged.has(id))) {
        throw new LedgerError('sentinel.store.stagingMismatch', 'receipts do not match the staged artifacts');
      }
      if (input.outputs.some(id => !staged.has(id))) {
        throw new LedgerError('sentinel.store.stagingMismatch', 'an output was not staged');
      }
      const sequence = this.#event('work-published', runId, ref, { attemptId: input.attemptId, outputs: input.outputs.length });
      this.#acceptArtifacts(receipts, staged, sequence);
      const resultDigest = digestOf({ work: ref, attemptId: input.attemptId, outputs: input.outputs,
        receipts: request.receipts });
      const acceptedAt = this.#now();
      this.#run(`INSERT INTO publications (work_id, work_revision, attempt_id, result_digest, coordinator_epoch,
        accepted_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)`, ref.id, ref.revision, input.attemptId, resultDigest,
      this.epoch, acceptedAt, sequence);
      for (const l of this.#all('SELECT parent_id, child_id FROM staging_links WHERE stage_id = ?', input.stageId)) {
        this.#run('INSERT OR IGNORE INTO artifact_links (parent_id, child_id) VALUES (?, ?)', String(l.parent_id), String(l.child_id));
      }
      const position = new Map(input.outputs.map((id, i) => [id, i]));
      for (const [id, s] of staged) {
        const at = position.get(id);
        this.#run(`INSERT INTO artifact_refs (work_id, work_revision, attempt_id, artifact_id, role, position, schema,
          privacy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ref.id, ref.revision, input.attemptId, id,
        at === undefined ? 'linked' : 'output', at ?? null, String(s.schema), String(s.privacy));
      }
      this.#finishAttempt(input.attemptId, 'succeeded', input.endedAt, input.usage, input.outputs);
      this.#run("UPDATE work_units SET state = 'published', active_attempt_id = NULL WHERE id = ? AND revision = ?",
        ref.id, ref.revision);
      this.#run('DELETE FROM staging WHERE stage_id = ?', input.stageId);
      return { work: ref, attemptId: input.attemptId, resultDigest, sequence, acceptedAt };
    }, 'publish:before-commit');
  }

  /** Inserts accepted artifacts and their representations; the privacy floor only ever rises. */
  #acceptArtifacts(receipts: readonly ObjectReceipt[], staged: ReadonlyMap<string, Row>, sequence: number): void {
    for (const r of receipts) {
      const s = staged.get(r.id)!;
      const privacy = s.privacy as ArtifactPrivacy;
      const existing = this.#get('SELECT raw_size, privacy_floor FROM artifacts WHERE id = ?', r.id);
      if (!existing) {
        this.#run('INSERT INTO artifacts (id, raw_size, privacy_floor, first_sequence) VALUES (?, ?, ?, ?)',
          r.id, r.rawSize, privacy, sequence);
      } else {
        if (Number(existing.raw_size) !== r.rawSize) {
          throw new LedgerError('sentinel.store.stagingMismatch', 'an artifact was stored before with another size');
        }
        if (privacyRank(privacy) > privacyRank(existing.privacy_floor as ArtifactPrivacy)) {
          this.#run('UPDATE artifacts SET privacy_floor = ? WHERE id = ?', privacy, r.id);
        }
      }
      const rep = this.#get('SELECT stored_digest, stored_size FROM artifact_objects WHERE artifact_id = ? AND codec = ?',
        r.id, r.codec);
      if (!rep) {
        this.#run('INSERT INTO artifact_objects (artifact_id, codec, stored_digest, stored_size) VALUES (?, ?, ?, ?)',
          r.id, r.codec, r.storedDigest, r.storedSize);
      } else if (rep.stored_digest !== r.storedDigest || Number(rep.stored_size) !== r.storedSize) {
        throw new LedgerError('sentinel.store.stagingMismatch', 'a representation was recorded before with other bytes');
      }
    }
  }

  /** Every receipt re-read and hashed by this store's object verifier; refuses any that differs. */
  #verifyReceipts(receipts: readonly ObjectReceipt[], what: string): void {
    const verifier = this.#objects;
    if (!verifier) {
      throw new LedgerError('sentinel.store.objectVerifierUnavailable', `${what} needs the object store verifier; none was configured`);
    }
    for (const r of receipts) {
      let seen: VerifiedObject | null;
      try { seen = verifier.verify({ id: r.id, codec: r.codec }); } catch (cause) {
        throw new LedgerError('sentinel.store.objectMissing', 'the object store could not verify a staged object', { cause });
      }
      if (!seen || seen.storeId !== this.storeId || seen.id !== r.id || seen.codec !== r.codec
        || seen.storedDigest !== r.storedDigest || seen.rawSize !== r.rawSize || seen.storedSize !== r.storedSize) {
        throw new LedgerError('sentinel.store.objectMissing', 'a staged object is absent or differs from its receipt');
      }
    }
  }

  /**
   * Admits a captured snapshot in one transaction, without a run: every named stage is open, unbound and of this
   * epoch; the receipts name exactly the artifacts they hold and each is durable in this store; then artifacts,
   * representations, links, the snapshot row and its event are recorded and the stages released. The manifest and
   * the materialization become collection roots; the content stays reachable through their links.
   */
  admitSnapshot(input: AdmitSnapshotInput): SnapshotRecord {
    checkId(input.snapshotId, 'snapshot id');
    checkDigest(input.manifest, 'snapshot manifest');
    checkDigest(input.materialization, 'snapshot materialization');
    checkDigest(input.inventoryDigest, 'inventory digest');
    if (input.manifest === input.materialization) throw invalid('the manifest and the materialization are distinct artifacts');
    if (!Array.isArray(input.stageIds) || input.stageIds.length === 0 || input.stageIds.length > MAX_SNAPSHOT_ARTIFACTS
      || new Set(input.stageIds).size !== input.stageIds.length) throw invalid('stage ids');
    input.stageIds.forEach(id => checkId(id, 'stage id'));
    if (!Array.isArray(input.receipts) || input.receipts.length === 0 || input.receipts.length > MAX_SNAPSHOT_ARTIFACTS) {
      throw invalid('receipts');
    }
    input.receipts.forEach(r => this.#checkReceipt(r));
    const receipts = [...input.receipts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.codec < b.codec ? -1 : 1));
    const stageIds = [...input.stageIds].sort();
    const request = { snapshotId: input.snapshotId, stageIds, manifest: input.manifest, materialization: input.materialization,
      inventoryDigest: input.inventoryDigest, receipts: receipts.map(r => ({ ...r })) };
    // Verified before the transaction (it reads every object); the open stages keep them pinned until the commit,
    // which requires the same stages to be open still.
    this.#verifyReceipts(receipts, 'snapshot admission');
    return this.#mutate('admitSnapshot', request, input.idempotency, () => {
      if (this.#get('SELECT 1 AS x FROM snapshots WHERE id = ?', input.snapshotId)) {
        throw new LedgerError('sentinel.store.conflict', 'a snapshot with this id was already admitted');
      }
      const staged = new Map<string, Row>();
      for (const stageId of stageIds) {
        const stage = this.#get('SELECT coordinator_epoch, work_id, attempt_id FROM staging WHERE stage_id = ?', stageId);
        if (!stage) throw new LedgerError('sentinel.store.stagingMismatch', 'no such stage');
        if (stage.coordinator_epoch !== this.epoch || stage.work_id !== null || stage.attempt_id !== null) {
          throw new LedgerError('sentinel.store.stagingMismatch', 'a snapshot is admitted only from unbound stages of this epoch');
        }
        for (const row of this.#all('SELECT artifact_id, schema, privacy FROM staging_artifacts WHERE stage_id = ?', stageId)) {
          const id = String(row.artifact_id);
          const prior = staged.get(id);
          if (!prior || privacyRank(row.privacy as ArtifactPrivacy) > privacyRank(prior.privacy as ArtifactPrivacy)) staged.set(id, row);
        }
      }
      const received = new Set(receipts.map(r => r.id));
      if (received.size !== staged.size || [...received].some(id => !staged.has(id))) {
        throw new LedgerError('sentinel.store.stagingMismatch', 'receipts do not match the staged artifacts');
      }
      if (!staged.has(input.manifest) || !staged.has(input.materialization)) {
        throw new LedgerError('sentinel.store.stagingMismatch', 'the manifest and the materialization must be staged');
      }
      // Every admitted artifact must stay reachable from the two roots, or a prune plan would list it the moment its
      // stage is released. Walk the selected stages' links, plus links already recorded for artifacts this admission
      // re-stages; only staged nodes are expanded, so the walk visits at most the staged set and its direct targets.
      const children = new Map<string, Set<string>>();
      const addLink = (parent: string, child: string) => {
        let set = children.get(parent);
        if (!set) children.set(parent, set = new Set());
        set.add(child);
      };
      for (const stageId of stageIds) {
        for (const l of this.#all('SELECT parent_id, child_id FROM staging_links WHERE stage_id = ?', stageId)) addLink(String(l.parent_id), String(l.child_id));
      }
      for (const id of staged.keys()) {
        for (const l of this.#all('SELECT child_id FROM artifact_links WHERE parent_id = ?', id)) addLink(id, String(l.child_id));
      }
      const reached = new Set<string>([input.manifest, input.materialization]);
      const queue = [input.manifest, input.materialization];
      while (queue.length) {
        const next = queue.pop()!;
        if (!staged.has(next)) continue;
        for (const child of children.get(next) ?? []) {
          if (reached.has(child)) continue;
          // A link out of the selected stages may name only an artifact the ledger already accepted.
          if (!staged.has(child) && !this.#get('SELECT 1 AS x FROM artifacts WHERE id = ?', child)) {
            throw new LedgerError('sentinel.store.stagingMismatch', 'a snapshot link names an artifact that is neither selected nor accepted');
          }
          reached.add(child);
          queue.push(child);
        }
      }
      if ([...staged.keys()].some(id => !reached.has(id))) {
        throw new LedgerError('sentinel.store.stagingMismatch', 'an admitted artifact is not reachable from the snapshot\'s manifest or materialization');
      }
      const sequence = this.#event('snapshot-admitted', null, null, { snapshotId: input.snapshotId, artifacts: staged.size });
      this.#acceptArtifacts(receipts, staged, sequence);
      for (const stageId of stageIds) {
        for (const l of this.#all('SELECT parent_id, child_id FROM staging_links WHERE stage_id = ?', stageId)) {
          this.#run('INSERT OR IGNORE INTO artifact_links (parent_id, child_id) VALUES (?, ?)', String(l.parent_id), String(l.child_id));
        }
      }
      const admittedAt = this.#now();
      this.#run(`INSERT INTO snapshots (id, manifest_id, materialization_id, inventory_digest, coordinator_epoch, sequence,
        admitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, input.snapshotId, input.manifest, input.materialization,
      input.inventoryDigest, this.epoch, sequence, admittedAt);
      for (const stageId of stageIds) this.#run('DELETE FROM staging WHERE stage_id = ?', stageId);
      return { snapshotId: input.snapshotId, manifest: input.manifest, materialization: input.materialization,
        inventoryDigest: input.inventoryDigest, sequence, admittedAt };
    }, 'snapshot:before-commit');
  }

  /** An admitted snapshot's record, or undefined. */
  getSnapshot(snapshotId: Id): SnapshotRecord | undefined {
    checkId(snapshotId, 'snapshot id');
    const row = this.#read(() => this.#get('SELECT * FROM snapshots WHERE id = ?', snapshotId));
    if (!row) return undefined;
    return { snapshotId: String(row.id), manifest: String(row.manifest_id), materialization: String(row.materialization_id),
      inventoryDigest: String(row.inventory_digest), sequence: Number(row.sequence), admittedAt: String(row.admitted_at) };
  }

  // ---- plans ----

  /**
   * Admits one plan revision in one transaction: the chain (revision 1 has no predecessor; every later revision
   * names the digest of the revision before it, which must be admitted), a non-null snapshot already admitted, the
   * pins a kind requires, and unbound stages of this epoch holding exactly the receipts' artifacts, every one durable
   * and reachable from the plan through the staged links. The plan artifact becomes a collection root; the rule
   * lock, policy and profile stay reachable through its links. Rows are immutable. What the plan says is checked by
   * the caller (execution/plans.ts); the ledger records the exact artifacts and their binding.
   */
  admitPlan(input: AdmitPlanInput): PlanRecord {
    checkId(input.runId, 'run id');
    if (!Number.isInteger(input.revision) || input.revision < 1 || input.revision > 2147483647) throw invalid('plan revision');
    if (input.kind !== 'bootstrap' && input.kind !== 'analysis') throw invalid('plan kind');
    checkDigest(input.digest, 'plan digest');
    if ((input.revision === 1) !== (input.previous === null)) throw invalid('exactly revision 1 has no previous plan');
    if (input.previous !== null) checkDigest(input.previous, 'previous plan');
    checkDigest(input.plan, 'plan artifact');
    checkDigest(input.profile, 'profile artifact');
    const pinned = input.kind === 'analysis';
    if (pinned !== (input.ruleLock !== null) || pinned !== (input.policy !== null) || pinned !== (input.snapshotId !== null)) {
      throw invalid('an analysis plan pins a rule lock, a policy and a snapshot; a bootstrap plan pins none');
    }
    if (input.ruleLock !== null) checkDigest(input.ruleLock, 'rule lock artifact');
    if (input.policy !== null) checkDigest(input.policy, 'policy artifact');
    if (input.snapshotId !== null) checkId(input.snapshotId, 'snapshot id');
    const required = [input.plan, input.profile, ...(input.ruleLock ? [input.ruleLock] : []), ...(input.policy ? [input.policy] : [])];
    if (new Set(required).size !== required.length) throw invalid('the plan and its pinned artifacts are distinct artifacts');
    const stage = this.#checkUnboundStages(input.stageIds, input.receipts, 'plan admission');
    const request = { runId: input.runId, revision: input.revision, kind: input.kind, digest: input.digest, previous: input.previous,
      plan: input.plan, ruleLock: input.ruleLock, policy: input.policy, profile: input.profile, snapshotId: input.snapshotId,
      stageIds: stage.stageIds, receipts: stage.receipts.map(r => ({ ...r })) };
    return this.#mutate('admitPlan', request, input.idempotency, () => {
      if (this.#get('SELECT 1 AS x FROM plans WHERE run_id = ? AND revision = ?', input.runId, input.revision)) {
        throw new LedgerError('sentinel.store.conflict', 'this plan revision was already admitted');
      }
      if (input.previous !== null) {
        const prior = this.#get('SELECT digest FROM plans WHERE run_id = ? AND revision = ?', input.runId, input.revision - 1);
        if (!prior || prior.digest !== input.previous) throw new LedgerError('sentinel.store.conflict', 'the previous plan revision is not the admitted one');
      }
      if (input.snapshotId !== null && !this.#get('SELECT 1 AS x FROM snapshots WHERE id = ?', input.snapshotId)) {
        throw new LedgerError('sentinel.store.notFound', 'the plan pins a snapshot that was not admitted');
      }
      // A run is bound to one snapshot for good: a later analysis revision of an existing run pins that snapshot.
      // Changed source is a new, linked run.
      const run = this.#get('SELECT snapshot_id FROM runs WHERE id = ?', input.runId);
      if (run && input.snapshotId !== null && input.snapshotId !== run.snapshot_id) {
        throw new LedgerError('sentinel.store.conflict', 'an analysis revision of an existing run pins the run\'s own snapshot');
      }
      const sequence = this.#event('plan-admitted', null, null, { runId: input.runId, revision: input.revision, digest: input.digest });
      this.#acceptUnboundStages(stage.stageIds, stage.receipts, required, sequence, input.plan);
      const admittedAt = this.#now();
      this.#run(`INSERT INTO plans (run_id, revision, kind, digest, previous, plan_id, rule_lock_id, policy_id, profile_id,
        snapshot_id, coordinator_epoch, sequence, admitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.runId, input.revision, input.kind, input.digest, input.previous, input.plan, input.ruleLock, input.policy,
      input.profile, input.snapshotId, this.epoch, sequence, admittedAt);
      return { runId: input.runId, revision: input.revision, kind: input.kind, digest: input.digest, previous: input.previous,
        plan: input.plan, ruleLock: input.ruleLock, policy: input.policy, profile: input.profile, snapshotId: input.snapshotId, sequence, admittedAt };
    }, 'plan:before-commit');
  }

  /** An admitted plan revision's record, or undefined. */
  getPlan(runId: Id, revision: number): PlanRecord | undefined {
    checkId(runId, 'run id');
    const row = this.#read(() => this.#get('SELECT * FROM plans WHERE run_id = ? AND revision = ?', runId, revision));
    return row ? toPlanRecord(row) : undefined;
  }

  /** A run's latest admitted plan revision, or undefined. */
  latestPlan(runId: Id): PlanRecord | undefined {
    checkId(runId, 'run id');
    const row = this.#read(() => this.#get('SELECT * FROM plans WHERE run_id = ? ORDER BY revision DESC LIMIT 1', runId));
    return row ? toPlanRecord(row) : undefined;
  }

  /** Every admitted plan revision of a run, oldest first. */
  listPlans(runId: Id): PlanRecord[] {
    checkId(runId, 'run id');
    return this.#read(() => this.#all('SELECT * FROM plans WHERE run_id = ? ORDER BY revision', runId)).map(toPlanRecord);
  }

  /** Moves an active run to its next admitted plan revision (the analysis after its bootstrap, a new rule lock). */
  advanceRunPlan(runId: Id, revision: number, opts: { idempotency?: IdempotencyRef } = {}): { runId: Id; planRevision: number; sequence: number } {
    checkId(runId, 'run id');
    return this.#mutate('advanceRunPlan', { runId, revision }, opts.idempotency, () => {
      const run = this.#get('SELECT state, plan_revision FROM runs WHERE id = ?', runId);
      if (!run) throw new LedgerError('sentinel.store.notFound', 'no such run');
      if (run.state === 'completed' || run.state === 'canceled' || run.state === 'canceling') throw new LedgerError('sentinel.store.wrongState', 'the run has ended');
      if (revision !== Number(run.plan_revision) + 1) throw new LedgerError('sentinel.store.conflict', `the run's next plan revision is ${Number(run.plan_revision) + 1}`);
      const plan = this.#get('SELECT snapshot_id FROM plans WHERE run_id = ? AND revision = ?', runId, revision);
      if (!plan) throw new LedgerError('sentinel.store.notFound', 'that plan revision was not admitted');
      const snapshot = this.#get('SELECT snapshot_id FROM runs WHERE id = ?', runId)!.snapshot_id;
      if (plan.snapshot_id !== null && plan.snapshot_id !== snapshot) {
        throw new LedgerError('sentinel.store.conflict', 'the revision pins another snapshot than the run');
      }
      this.#run('UPDATE runs SET plan_revision = ? WHERE id = ?', revision, runId);
      return { runId, planRevision: revision, sequence: this.#event('run-plan-advanced', runId, null, { from: Number(run.plan_revision), to: revision }) };
    });
  }

  /**
   * Inside a transaction: when plans were admitted for this run id, the revision a run is created at must be one of
   * them, and every admitted analysis revision must pin the run's snapshot. A run with no admitted plan is the
   * ledger's own lower-level record and is not checked here (the coordinator executes only admitted revisions).
   */
  #checkRunPlans(runId: Id, revision: number, snapshotId: Id): void {
    const plans = this.#all('SELECT revision, snapshot_id FROM plans WHERE run_id = ?', runId);
    if (plans.length === 0) return;
    if (!plans.some(p => Number(p.revision) === revision)) {
      throw new LedgerError('sentinel.store.wrongState', `the run starts at plan revision ${revision}, which was not admitted`);
    }
    if (plans.some(p => p.snapshot_id !== null && p.snapshot_id !== snapshotId)) {
      throw new LedgerError('sentinel.store.conflict', 'an admitted analysis revision pins another snapshot than the run');
    }
  }

  /** Shape checks shared by admissions from unbound stages, before any transaction; verifies every object. */
  #checkUnboundStages(stageIds: unknown, given: unknown, what: string): { stageIds: StageId[]; receipts: ObjectReceipt[] } {
    if (!Array.isArray(stageIds) || stageIds.length === 0 || stageIds.length > MAX_SNAPSHOT_ARTIFACTS || new Set(stageIds).size !== stageIds.length) {
      throw invalid('stage ids');
    }
    stageIds.forEach(id => checkId(id, 'stage id'));
    if (!Array.isArray(given) || given.length === 0 || given.length > MAX_STAGED) throw invalid('receipts');
    (given as ObjectReceipt[]).forEach(r => this.#checkReceipt(r));
    const receipts = [...(given as ObjectReceipt[])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.codec < b.codec ? -1 : 1));
    this.#verifyReceipts(receipts, what);
    return { stageIds: [...(stageIds as StageId[])].sort(), receipts };
  }

  #checkUnboundStage(records: AttemptRecords, what: string): { stageId: StageId; receipts: ObjectReceipt[] } {
    const { stageIds, receipts } = this.#checkUnboundStages([records?.stageId], records?.receipts, what);
    return { stageId: stageIds[0]!, receipts };
  }

  /**
   * Inside a transaction: the stages are open, unbound and of this epoch, their artifacts are exactly the receipts',
   * every required artifact is among them, and (with a root) every one is reachable from the root through the staged
   * links; then they are accepted with their links and the stages released.
   */
  #acceptUnboundStages(stageIds: readonly StageId[], receipts: readonly ObjectReceipt[], required: readonly string[], sequence: number, root?: string): void {
    const staged = new Map<string, Row>();
    const links: Array<[string, string]> = [];
    for (const stageId of stageIds) {
      const stage = this.#get('SELECT coordinator_epoch, work_id, attempt_id FROM staging WHERE stage_id = ?', stageId);
      if (!stage) throw new LedgerError('sentinel.store.stagingMismatch', 'no such stage');
      if (stage.coordinator_epoch !== this.epoch || stage.work_id !== null || stage.attempt_id !== null) {
        throw new LedgerError('sentinel.store.stagingMismatch', 'records are accepted only from unbound stages of this epoch');
      }
      for (const row of this.#all('SELECT artifact_id, schema, privacy FROM staging_artifacts WHERE stage_id = ?', stageId)) {
        const id = String(row.artifact_id);
        const prior = staged.get(id);
        if (!prior || privacyRank(row.privacy as ArtifactPrivacy) > privacyRank(prior.privacy as ArtifactPrivacy)) staged.set(id, row);
      }
      for (const l of this.#all('SELECT parent_id, child_id FROM staging_links WHERE stage_id = ?', stageId)) links.push([String(l.parent_id), String(l.child_id)]);
    }
    const received = new Set(receipts.map(r => r.id));
    if (received.size !== staged.size || [...received].some(id => !staged.has(id))) {
      throw new LedgerError('sentinel.store.stagingMismatch', 'receipts do not match the staged artifacts');
    }
    if (required.some(id => !staged.has(id))) throw new LedgerError('sentinel.store.stagingMismatch', 'a required record was not staged');
    if (root !== undefined) {
      const reached = new Set([root]);
      for (let grew = true; grew;) {
        grew = false;
        for (const [p, c] of links) if (reached.has(p) && !reached.has(c)) { reached.add(c); grew = true; }
      }
      if ([...staged.keys()].some(id => !reached.has(id))) throw new LedgerError('sentinel.store.stagingMismatch', 'an admitted record is not reachable from its root');
    }
    this.#acceptArtifacts(receipts, staged, sequence);
    for (const [p, c] of links) {
      if (!staged.has(c) && !this.#get('SELECT 1 AS x FROM artifacts WHERE id = ?', c)) {
        throw new LedgerError('sentinel.store.stagingMismatch', 'a record links an artifact that is neither staged nor accepted');
      }
      this.#run('INSERT OR IGNORE INTO artifact_links (parent_id, child_id) VALUES (?, ?)', p, c);
    }
    for (const stageId of stageIds) this.#run('DELETE FROM staging WHERE stage_id = ?', stageId);
  }

  /** Pins a retained report's artifact closure roots. Every artifact must already be accepted. */
  pinReport(reportId: Id, runId: Id, artifacts: string[]): { reportId: Id; sequence: number } {
    checkId(reportId, 'report id');
    checkId(runId, 'run id');
    artifacts.forEach(a => checkDigest(a, 'report artifact'));
    return this.#transaction(() => {
      const sequence = this.#event('report-pinned', runId, null, { reportId, artifacts: artifacts.length });
      this.#run('INSERT INTO reports (id, run_id, sequence, created_at) VALUES (?, ?, ?, ?)', reportId, runId, sequence, this.#now());
      for (const a of new Set(artifacts)) {
        this.#run('INSERT INTO report_artifacts (report_id, artifact_id) VALUES (?, ?)', reportId, a);
      }
      return { reportId, sequence };
    }, true);
  }

  // ---- reads ----

  #read<T>(body: () => T): T {
    if (this.#closed) throw new LedgerError('sentinel.store.closed', 'the ledger is closed');
    this.#db.exec('BEGIN DEFERRED');
    try {
      const result = body();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Events in sequence order after a cursor, at most `limit` (≤ 500) per page, optionally for one run. */
  readEvents(opts: { after?: number; limit?: number; runId?: Id } = {}): EventPage {
    const after = opts.after ?? 0;
    const limit = opts.limit ?? 100;
    if (!Number.isSafeInteger(after) || after < 0) throw invalid('cursor');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE) throw invalid(`limit is 1..${MAX_EVENT_PAGE}`);
    if (opts.runId !== undefined) checkId(opts.runId, 'run id');
    const rows = this.#read(() => (opts.runId === undefined
      ? this.#all('SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?', after, limit + 1)
      : this.#all('SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?',
        opts.runId, after, limit + 1)));
    const more = rows.length > limit;
    const events: LedgerEvent[] = rows.slice(0, limit).map(r => ({
      sequence: Number(r.sequence),
      kind: r.kind as LedgerEventKind,
      runId: r.run_id === null ? null : String(r.run_id),
      work: r.work_id === null ? null : { id: String(r.work_id), revision: Number(r.work_revision) },
      epoch: String(r.coordinator_epoch),
      at: String(r.at),
      payload: JSON.parse(String(r.payload)) as Record<string, unknown>,
    }));
    return { events, cursor: events.at(-1)?.sequence ?? after, more };
  }

  /** A work revision as recorded: its current state, and the envelope it was created with (immutable identity). */
  getWork(ref: WorkRef): { work: WorkRef; runId: Id; state: string; activeAttemptId: Id | null; reason: string | null; envelope: WorkEnvelope } | null {
    checkRef(ref);
    const r = this.#read(() => this.#get('SELECT run_id, state, active_attempt_id, state_reason, envelope FROM work_units WHERE id = ? AND revision = ?',
      ref.id, ref.revision));
    return r ? { work: { id: ref.id, revision: ref.revision }, runId: String(r.run_id), state: String(r.state),
      activeAttemptId: r.active_attempt_id === null ? null : String(r.active_attempt_id), reason: r.state_reason === null ? null : String(r.state_reason),
      envelope: JSON.parse(String(r.envelope)) as WorkEnvelope } : null;
  }

  /** A run as recorded: its state, its outcome once completed, and its envelope. */
  /** A run: its state, and `planRevision`, the current one (its envelope keeps the revision it was created at). */
  getRun(id: Id): { id: Id; state: RunState; outcome: RunOutcome | null; completedAt: string | null; epoch: Id; planRevision: number; envelope: RunEnvelope } | null {
    checkId(id, 'run id');
    const r = this.#read(() => this.#get('SELECT state, outcome, completed_at, coordinator_epoch, plan_revision, envelope FROM runs WHERE id = ?', id));
    return r ? { id, state: r.state as RunState, outcome: (r.outcome ?? null) as RunOutcome | null, completedAt: r.completed_at === null ? null : String(r.completed_at),
      epoch: String(r.coordinator_epoch), planRevision: Number(r.plan_revision), envelope: JSON.parse(String(r.envelope)) as RunEnvelope } : null;
  }

  /**
   * One page of a work revision's attempts, by ordinal: those after `afterOrdinal`, at most `limit` (≤ 500, default
   * 500). Page with the last ordinal returned; countAttempts() gives the exact total.
   */
  listAttempts(ref: WorkRef, opts: { afterOrdinal?: number; limit?: number } = {}): Array<{ id: Id; ordinal: number; state: string; epoch: Id }> {
    checkRef(ref);
    const after = opts.afterOrdinal ?? 0;
    const limit = opts.limit ?? MAX_EVENT_PAGE;
    if (!Number.isSafeInteger(after) || after < 0) throw invalid('afterOrdinal');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE) throw invalid(`limit is 1..${MAX_EVENT_PAGE}`);
    return this.#read(() => this.#all('SELECT id, ordinal, state, coordinator_epoch FROM attempts WHERE work_id = ? AND work_revision = ? AND ordinal > ? ORDER BY ordinal LIMIT ?',
      ref.id, ref.revision, after, limit)).map(r => ({ id: String(r.id), ordinal: Number(r.ordinal), state: String(r.state), epoch: String(r.coordinator_epoch) }));
  }

  /** The exact number of attempts a work revision has had. */
  countAttempts(ref: WorkRef): number {
    checkRef(ref);
    return Number(this.#read(() => this.#get('SELECT count(*) AS n FROM attempts WHERE work_id = ? AND work_revision = ?', ref.id, ref.revision))?.n ?? 0);
  }

  /** Stages still open (registered, neither published nor aborted), oldest first, at most `limit` (≤ 500). */
  listOpenStages(limit = 500): Array<{ stageId: Id; epoch: Id; work: WorkRef | null; attemptId: Id | null; createdAt: string }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE) throw invalid(`limit is 1..${MAX_EVENT_PAGE}`);
    return this.#read(() => this.#all('SELECT stage_id, coordinator_epoch, work_id, work_revision, attempt_id, created_at FROM staging ORDER BY created_at, stage_id LIMIT ?', limit))
      .map(r => ({ stageId: String(r.stage_id), epoch: String(r.coordinator_epoch),
        work: r.work_id === null ? null : { id: String(r.work_id), revision: Number(r.work_revision) },
        attemptId: r.attempt_id === null ? null : String(r.attempt_id), createdAt: String(r.created_at) }));
  }

  /** An attempt as recorded: its final envelope once ended, else its start envelope. */
  getAttempt(id: Id): { id: Id; work: WorkRef; state: string; epoch: Id; envelope: AttemptEnvelope; errorDetail: Record<string, unknown> | null } | null {
    checkId(id, 'attempt id');
    const r = this.#read(() => this.#get(
      'SELECT work_id, work_revision, state, coordinator_epoch, envelope, final_envelope, error_detail FROM attempts WHERE id = ?', id));
    return r ? { id, work: { id: String(r.work_id), revision: Number(r.work_revision) }, state: String(r.state),
      epoch: String(r.coordinator_epoch),
      envelope: JSON.parse(String(r.final_envelope ?? r.envelope)) as AttemptEnvelope,
      errorDetail: r.error_detail === null ? null : JSON.parse(String(r.error_detail)) as Record<string, unknown> } : null;
  }

  getPublication(ref: WorkRef): (PublicationReceipt & { outputs: Array<{ id: string; schema: string; privacy: ArtifactPrivacy }> }) | null {
    checkRef(ref);
    return this.#read(() => {
      const p = this.#get('SELECT * FROM publications WHERE work_id = ? AND work_revision = ?', ref.id, ref.revision);
      if (!p) return null;
      const outputs = this.#all(`SELECT artifact_id, schema, privacy FROM artifact_refs WHERE work_id = ? AND work_revision = ?
        AND role = 'output' ORDER BY position`, ref.id, ref.revision)
        .map(r => ({ id: String(r.artifact_id), schema: String(r.schema), privacy: r.privacy as ArtifactPrivacy }));
      return { work: { id: ref.id, revision: ref.revision }, attemptId: String(p.attempt_id),
        resultDigest: String(p.result_digest), sequence: Number(p.sequence), acceptedAt: String(p.accepted_at), outputs };
    });
  }

  /** The recorded physical representations of one artifact, for the object store to read and verify. */
  objectsOf(id: string): ObjectReceipt[] {
    checkDigest(id, 'artifact');
    return this.#read(() => this.#all(`SELECT o.artifact_id, o.codec, o.stored_digest, o.stored_size, a.raw_size
      FROM artifact_objects o JOIN artifacts a ON a.id = o.artifact_id WHERE o.artifact_id = ? ORDER BY o.codec`, id))
      .map(toReceipt);
  }

  /** Every root and link at one ledger sequence, read in one transaction, for a dry-run collection. */
  gcSnapshot(): GcSnapshot {
    return this.#read(() => {
      const col = (sql: string) => this.#all(sql).map(r => String(Object.values(r)[0]));
      const sequence = Number(this.#get('SELECT coalesce(max(sequence), 0) AS s FROM events')?.s ?? 0);
      const { retained, active } = this.#retainedRoots();
      return {
        storeId: this.storeId,
        complete: true as const,
        sequence,
        // Accepted references: publication outputs and links, and every admitted snapshot's manifest and materialization.
        referenced: col(`SELECT artifact_id FROM artifact_refs UNION SELECT manifest_id FROM snapshots
          UNION SELECT materialization_id FROM snapshots ${this.migration.to >= 4 ? 'UNION SELECT plan_id FROM plans' : ''} ORDER BY 1`),
        staged: col('SELECT DISTINCT artifact_id FROM staging_artifacts ORDER BY artifact_id'),
        reports: col('SELECT DISTINCT artifact_id FROM report_artifacts ORDER BY artifact_id'),
        retained: [...retained].sort(),
        active: [...active].sort(),
        links: this.#all('SELECT parent_id, child_id FROM artifact_links ORDER BY parent_id, child_id')
          .map(r => [String(r.parent_id), String(r.child_id)] as [string, string]),
        objects: this.#all(`SELECT o.artifact_id, o.codec, o.stored_digest, o.stored_size, a.raw_size
          FROM artifact_objects o JOIN artifacts a ON a.id = o.artifact_id ORDER BY o.artifact_id, o.codec`).map(toReceipt),
      };
    });
  }

  /**
   * The artifacts every retained work and attempt envelope names, each envelope re-validated under its contract and
   * cross-checked against its columns. A record that cannot be read is an integrity error, never a smaller root set.
   * Plain digests (stage implementation, input fingerprint) and IDs are not artifacts and are not roots.
   */
  #retainedRoots(): { retained: Set<string>; active: Set<string> } {
    const retained = new Set<string>();
    const active = new Set<string>();
    const corrupt = (what: string) => new LedgerError('sentinel.store.corruptRecord', `a retained ${what} cannot be read`);
    const parse = <K extends 'work' | 'attempt'>(kind: K, text: unknown) => {
      let value: unknown;
      try { value = JSON.parse(String(text)); } catch { throw corrupt(kind); }
      const result = validateEnvelope(kind, value);
      if (!result.ok) throw corrupt(kind);
      return result.value;
    };
    const add = (ids: Array<string | undefined>, live: boolean) => {
      for (const id of ids) {
        if (id === undefined) continue;
        retained.add(id);
        if (live) active.add(id);
      }
    };
    const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
    for (const r of this.#all(`SELECT id, revision, run_id, plan_revision, input_fingerprint, influence_manifest,
        coordinator_epoch, state, envelope FROM work_units`)) {
      const w = parse('work', r.envelope);
      // The stored envelope is the creation record: its identity must be the row's, and its state the creation
      // state (pending/ready, the only ones createWork writes) or the row's own state for a record born final.
      if (w.id !== r.id || w.revision !== r.revision || w.runId !== r.run_id || w.planRevision !== r.plan_revision
        || w.inputFingerprint !== r.input_fingerprint || w.influenceManifest !== r.influence_manifest
        || w.coordinatorEpoch !== r.coordinator_epoch || !(w.state === 'pending' || w.state === 'ready' || w.state === r.state)) {
        throw corrupt('work');
      }
      add([w.influenceManifest, w.state === 'satisfied-by-reuse' ? w.reuse.derivationArtifact : undefined],
        !['published', 'failed', 'satisfied-by-reuse'].includes(String(r.state)));
    }
    for (const r of this.#all(`SELECT id, work_id, work_revision, ordinal, coordinator_epoch, state, usage_certainty,
        started_at, ended_at, final_usage_certainty, envelope, final_envelope FROM attempts`)) {
      const start = parse('attempt', r.envelope);
      // The start envelope is immutable and always the running record; its identity must be the row's.
      if (start.state !== 'running' || start.id !== r.id || start.work.id !== r.work_id
        || start.work.revision !== r.work_revision || start.ordinal !== r.ordinal
        || start.coordinatorEpoch !== r.coordinator_epoch || start.startedAt !== r.started_at
        || start.usage.certainty !== r.usage_certainty) {
        throw corrupt('attempt');
      }
      const running = r.state === 'running';
      if (running !== (r.final_envelope === null)) throw corrupt('attempt');
      add([start.invocation], running);
      if (!running) {
        // The final envelope repeats the start's identity unchanged and adds only the end facts.
        const end = parse('attempt', r.final_envelope);
        if (end.state === 'running' || end.state !== r.state || end.endedAt !== r.ended_at
          || end.usage.certainty !== r.final_usage_certainty
          || !same({ ...start, state: null, usage: null }, {
            schema: end.schema, id: end.id, work: end.work, ordinal: end.ordinal, coordinatorEpoch: end.coordinatorEpoch,
            operationId: end.operationId, worker: end.worker, startedAt: end.startedAt, state: null, usage: null,
            ...(end.invocation === undefined ? {} : { invocation: end.invocation }),
          })) {
          throw corrupt('attempt');
        }
        add([...end.outputs, end.error?.diagnostics], false);
      }
    }
    return { retained, active };
  }

  /** The last committed event sequence. */
  currentSequence(): number {
    return this.#read(() => Number(this.#get('SELECT coalesce(max(sequence), 0) AS s FROM events')?.s ?? 0));
  }

  /**
   * Throws unless a snapshot was taken from this ledger and nothing has been committed since. A collector calls it
   * after computing candidates and before reporting or acting on them.
   */
  assertSnapshotCurrent(snapshot: GcSnapshot): void {
    if (snapshot?.complete !== true || snapshot.storeId !== this.storeId) {
      throw new LedgerError('sentinel.store.snapshotStale', 'the snapshot is not a complete snapshot of this ledger');
    }
    if (this.currentSequence() !== snapshot.sequence) {
      throw new LedgerError('sentinel.store.snapshotStale', 'the ledger changed after the snapshot was taken');
    }
  }

  /** SQLite's own integrity and foreign-key checks. Object bytes are the object store's to verify. */
  checkIntegrity(): { integrity: string; foreignKeyViolations: number } {
    return this.#read(() => ({
      integrity: String(Object.values(this.#get('PRAGMA integrity_check') ?? {})[0]),
      foreignKeyViolations: this.#all('PRAGMA foreign_key_check').length,
    }));
  }
}

const toReceipt = (r: Row): ObjectReceipt => ({
  id: String(r.artifact_id), codec: r.codec as ObjectReceipt['codec'], storedDigest: String(r.stored_digest),
  rawSize: Number(r.raw_size), storedSize: Number(r.stored_size),
});

function toPlanRecord(row: Record<string, unknown>): PlanRecord {
  const opt = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return { runId: String(row.run_id), revision: Number(row.revision), kind: row.kind as PlanRecord['kind'], digest: String(row.digest),
    previous: opt(row.previous), plan: String(row.plan_id), ruleLock: opt(row.rule_lock_id), policy: opt(row.policy_id),
    profile: String(row.profile_id), snapshotId: opt(row.snapshot_id), sequence: Number(row.sequence), admittedAt: String(row.admitted_at) };
}
