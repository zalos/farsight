// The shared model budget ledger (PR 21): durable, cross-process reservations against an owner-approved budget
// envelope. A narrow standalone seam until the coordinator's durable store (PR 08) can hold it: one SQLite file whose
// every mutation is one IMMEDIATE transaction, so concurrent reviewers in any number of processes share one budget and
// none can reserve past it. It holds no run, work or attempt state; it names the run, binding and admission it serves.
//
// A reservation is the worst case of one call: `held` (set aside, not sent) → `dispatched` (written before the request
// leaves) → `settled` (charged at its reported usage) or `uncertain` (may have been charged, usage unknown: its whole
// reservation stays charged until the owner reconciles it). Only a call proven never sent is `released`. Recovery,
// for epochs the coordinator has fenced, releases what was only held and turns what was dispatched into uncertain:
// a restart never forgets a call that may have been billed. A settlement above its reservation is recorded in full and
// marks the envelope overdrawn, which refuses every further reservation; nothing is clamped.
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { checkSqliteRuntime } from '../../store/runtime.js';
import { fail } from './errors.js';

export type ReservationState = 'held' | 'dispatched' | 'settled' | 'uncertain' | 'released';

export const RESERVATION_STATE_KEYS: Readonly<Record<ReservationState, string>> = Object.freeze({
  held: 'sentinel.reservation.held',
  dispatched: 'sentinel.reservation.dispatched',
  settled: 'sentinel.reservation.settled',
  uncertain: 'sentinel.reservation.uncertain',
  released: 'sentinel.reservation.released',
});

export interface EnvelopeInput {
  readonly id: string;
  readonly runId: string;
  readonly providerId: string;
  readonly bindingDigest: string;
  readonly admissionDigest: string;
  readonly receiptDigest: string | null;
  readonly maxTokens: number;
  readonly maxCostNanos: bigint | null;
  readonly accountingBasis?: 'subscription-quota';
  readonly currency: string | null;
  readonly createdAt: string;
}

export interface Reservation {
  readonly id: string;
  readonly envelopeId: string;
  readonly operationId: string;
  readonly state: ReservationState;
  readonly tokens: number;
  readonly costNanos: bigint | null;
  readonly accountingBasis?: 'subscription-quota';
  readonly usedInputTokens: number | null;
  readonly usedOutputTokens: number | null;
  readonly usedCostNanos: bigint | null;
  readonly epoch: string;
  readonly reconciledBy: string | null;
}

export interface EnvelopeTotals {
  readonly maxTokens: number;
  readonly maxCostNanos: bigint | null;
  readonly accountingBasis?: 'subscription-quota';
  /** Charged against the envelope: worst case for held, dispatched and uncertain; actual for settled. */
  readonly chargedTokens: number;
  readonly chargedCostNanos: bigint | null;
  readonly byState: Readonly<Record<ReservationState, number>>;
  readonly overdrawn: boolean;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costNanos: bigint | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS envelopes (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, provider_id TEXT NOT NULL, binding_digest TEXT NOT NULL, admission_digest TEXT NOT NULL,
  receipt_digest TEXT, max_tokens INTEGER NOT NULL CHECK (max_tokens >= 0), max_cost_nanos INTEGER NOT NULL CHECK (max_cost_nanos >= 0),
  currency TEXT NOT NULL, overdrawn INTEGER NOT NULL DEFAULT 0 CHECK (overdrawn IN (0, 1)), created_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY, envelope_id TEXT NOT NULL REFERENCES envelopes(id), operation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held','dispatched','settled','uncertain','released')),
  tokens INTEGER NOT NULL CHECK (tokens >= 0), cost_nanos INTEGER NOT NULL CHECK (cost_nanos >= 0),
  used_input INTEGER, used_output INTEGER, used_cost_nanos INTEGER, epoch TEXT NOT NULL, reconciled_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK ((state = 'settled') = (used_cost_nanos IS NOT NULL)),
  UNIQUE (envelope_id, operation_id)) STRICT;
CREATE TABLE IF NOT EXISTS fenced_epochs (epoch TEXT PRIMARY KEY, fenced_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS review_checkpoints (
  session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, sequence INTEGER NOT NULL CHECK (sequence >= 1),
  body TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS reservation_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, reservation_id TEXT NOT NULL REFERENCES reservations(id),
  from_state TEXT, to_state TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL) STRICT;
`;

// The same durable ledger now also records token-bounded subscription quota. NULL monetary fields mean
// unobserved/not monetary accounting, never USD zero or a no-fee claim. Existing monetary rows remain monetary.
const QUOTA_ENVELOPES = `CREATE TABLE IF NOT EXISTS envelopes (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, provider_id TEXT, binding_digest TEXT NOT NULL, admission_digest TEXT NOT NULL,
  receipt_digest TEXT, max_tokens INTEGER NOT NULL CHECK (max_tokens >= 0), max_cost_nanos INTEGER CHECK (max_cost_nanos >= 0),
  currency TEXT, overdrawn INTEGER NOT NULL DEFAULT 0 CHECK (overdrawn IN (0, 1)), created_at TEXT NOT NULL,
  accounting_basis TEXT NOT NULL DEFAULT 'money' CHECK (accounting_basis IN ('money','subscription-quota')),
  CHECK ((accounting_basis = 'money' AND max_cost_nanos IS NOT NULL AND currency IS NOT NULL)
    OR (accounting_basis = 'subscription-quota' AND max_cost_nanos IS NULL AND currency IS NULL))) STRICT;`;
const QUOTA_RESERVATIONS = `CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY, envelope_id TEXT NOT NULL REFERENCES envelopes(id), operation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held','dispatched','settled','uncertain','released')),
  tokens INTEGER NOT NULL CHECK (tokens >= 0), cost_nanos INTEGER CHECK (cost_nanos >= 0),
  used_input INTEGER, used_output INTEGER, used_cost_nanos INTEGER, epoch TEXT NOT NULL, reconciled_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  accounting_basis TEXT NOT NULL DEFAULT 'money' CHECK (accounting_basis IN ('money','subscription-quota')),
  CHECK ((state = 'settled') = (used_input IS NOT NULL AND used_output IS NOT NULL)),
  CHECK ((accounting_basis = 'money' AND cost_nanos IS NOT NULL AND ((state = 'settled') = (used_cost_nanos IS NOT NULL)))
    OR (accounting_basis = 'subscription-quota' AND cost_nanos IS NULL AND used_cost_nanos IS NULL)),
  UNIQUE (envelope_id, operation_id)) STRICT;`;
const QUOTA_SCHEMA =
  QUOTA_ENVELOPES +
  '\n' +
  QUOTA_RESERVATIONS +
  '\n' +
  SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS fenced_epochs'));

// Recognize only this package's exact historical schemas before changing a database. Unknown DDL is refused;
// a legacy row has genuinely unobserved provider provenance, never a guessed binding or provider id.
function ddl(sql: string): string {
  // Tokenize instead of deleting whitespace: both literal contents and token boundaries are semantic.
  // Unknown comments/quoting/operators refuse; this recognizes only the package's emitted DDL vocabulary.
  const out: string[] = [];
  let end = 0;
  const token = /'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_]*|[0-9]+|>=|<=|<>|!=|[(),;=<>+*-]/g;
  for (const match of sql.matchAll(token)) {
    if (/\S/.test(sql.slice(end, match.index)))
      return fail('sentinel.provider.ledgerInvalid', 'unknown budget ledger DDL');
    out.push(match[0]);
    end = match.index! + match[0].length;
  }
  if (/\S/.test(sql.slice(end))) return fail('sentinel.provider.ledgerInvalid', 'unknown budget ledger DDL');
  if (out[0] === 'CREATE' && out[1] === 'TABLE' && out.slice(2, 5).join(' ') === 'IF NOT EXISTS') out.splice(2, 3);
  // SQLite's own ALTER TABLE RENAME quotes fixed table identifiers. Do not normalize quoted values elsewhere.
  for (let i = 0; i < out.length; i++)
    if ((i === 2 && out[0] === 'CREATE' && out[1] === 'TABLE') || out[i - 1] === 'REFERENCES') {
      if (['"envelopes"', '"reservations"'].includes(out[i]!)) out[i] = out[i]!.slice(1, -1);
    }
  if (out.at(-1) === ';') out.pop();
  return JSON.stringify(out);
}
const rawTables = new Map(
  [...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \([\s\S]*?\) STRICT;/g)].map((m) => [m[1]!, m[0]]),
);
const expectedTables = new Map([...rawTables].map(([name, sql]) => [name, ddl(sql)]));
const oldEnvelopeSql = rawTables.get('envelopes')!.replace('provider_id TEXT NOT NULL, ', '');
const oldEnvelope = ddl(oldEnvelopeSql);
const migratedEnvelope = ddl(oldEnvelopeSql.replace(/\) STRICT;$/, ', provider_id TEXT) STRICT;'));
const quotaTables = new Map(
  [...QUOTA_SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \([\s\S]*?\) STRICT;/g)].map((m) => [
    m[1]!,
    ddl(m[0]),
  ]),
);
type SchemaDb = InstanceType<(typeof import('node:sqlite'))['DatabaseSync']>;
function knownSchema(db: SchemaDb): 'empty' | 'legacy' | 'current' | 'quota' {
  const all = db.prepare('SELECT name, type, tbl_name, sql FROM sqlite_master ORDER BY name LIMIT 65').all() as {
    name: string;
    type: string;
    tbl_name: string;
    sql: string | null;
  }[];
  if (all.length > 64) return fail('sentinel.provider.ledgerInvalid', 'unknown budget ledger schema');
  const indexes = new Map([
    ['sqlite_autoindex_envelopes_1', 'envelopes'],
    ['sqlite_autoindex_reservations_1', 'reservations'],
    ['sqlite_autoindex_reservations_2', 'reservations'],
    ['sqlite_autoindex_fenced_epochs_1', 'fenced_epochs'],
    ['sqlite_autoindex_review_checkpoints_1', 'review_checkpoints'],
  ]);
  const objects = all.filter((o) => {
    if (
      o.name === 'sqlite_sequence' &&
      o.type === 'table' &&
      o.tbl_name === 'sqlite_sequence' &&
      o.sql !== null &&
      ddl(o.sql) === ddl('CREATE TABLE sqlite_sequence(name,seq)')
    )
      return false;
    if (indexes.get(o.name) === o.tbl_name && o.type === 'index' && o.sql === null) return false;
    return true;
  });
  if (objects.length === 0 && all.length === 0) return 'empty';
  if (objects.length > 5 || objects.some((o) => o.type !== 'table' || !expectedTables.has(o.name) || !o.sql)) {
    return fail('sentinel.provider.ledgerInvalid', 'unknown budget ledger schema');
  }
  const names = new Set(objects.map((o) => o.name));
  if (
    !['envelopes', 'reservations', 'reservation_events'].every((n) => names.has(n)) ||
    names.has('fenced_epochs') !== names.has('review_checkpoints')
  )
    return fail('sentinel.provider.ledgerInvalid', 'incomplete budget ledger schema');
  let legacy = false;
  const quota = objects.some((o) => o.name === 'envelopes' && ddl(o.sql!) === quotaTables.get('envelopes'));
  if (quota && !names.has('fenced_epochs'))
    return fail('sentinel.provider.ledgerInvalid', 'incomplete quota ledger schema');
  for (const object of objects) {
    const actual = ddl(object.sql!);
    if (object.name === 'envelopes') {
      if (actual === oldEnvelope) legacy = true;
      else if (
        actual !== expectedTables.get(object.name) &&
        actual !== migratedEnvelope &&
        actual !== quotaTables.get(object.name)
      )
        return fail('sentinel.provider.ledgerInvalid', 'unknown envelope schema');
    } else if (actual !== (quota ? quotaTables : expectedTables).get(object.name))
      return fail('sentinel.provider.ledgerInvalid', 'unknown reservation or checkpoint schema');
  }
  if (db.prepare('PRAGMA foreign_key_check').get())
    return fail('sentinel.provider.ledgerInvalid', 'budget ledger foreign keys are invalid');
  return legacy ? 'legacy' : quota ? 'quota' : 'current';
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const id = (v: unknown, what: string) => {
  if (typeof v !== 'string' || !ID.test(v)) fail('sentinel.provider.ledgerInvalid', `${what} is not an id`);
};
const tokens = (v: unknown, what: string) => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    fail('sentinel.provider.ledgerInvalid', `${what} must be a whole number`);
};
const nanos = (v: unknown, what: string) => {
  if (typeof v !== 'bigint' || v < 0n || v > 9_000_000_000_000_000_000n)
    fail('sentinel.provider.ledgerInvalid', `${what} must be a non-negative amount`);
};

type Db = InstanceType<(typeof import('node:sqlite'))['DatabaseSync']>;
type Row = Record<string, unknown>;

export class BudgetLedger {
  readonly #db: Db;
  private constructor(db: Db) {
    this.#db = db;
  }

  /** Opens (creating if absent) the ledger at an absolute path, behind the store's SQLite release gate. */
  static async open(path: string, options: { busyTimeoutMs?: number } = {}): Promise<BudgetLedger> {
    if (typeof path !== 'string' || !isAbsolute(path))
      fail('sentinel.provider.ledgerInvalid', 'the ledger path must be absolute');
    const { sqlite } = await checkSqliteRuntime();
    let db: Db;
    try {
      // SQLite creates WAL, SHM and rollback journals with the database file's permissions. Repair an older
      // world-readable ledger and its siblings before opening it; never follow a link or reuse a hard link.
      for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
        try {
          const stat = lstatSync(file);
          if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()))
            return fail('sentinel.provider.ledgerInvalid', 'the ledger file is not a private regular file');
          chmodSync(file, 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (file === path) closeSync(openSync(path, 'wx', 0o600));
        }
      }
      db = new sqlite.DatabaseSync(path, {
        enableForeignKeyConstraints: true,
        timeout: options.busyTimeoutMs ?? 10_000,
        defensive: true,
      });
    } catch {
      return fail('sentinel.provider.ledgerInvalid', 'the ledger file could not be opened');
    }
    try {
      // The first check is read-only: malformed existing files are not changed even to switch journal mode.
      knownSchema(db);
      // SQLite table replacement requires connection-local FK enforcement off before BEGIN.
      // Exact schema and every FK are checked again under the writer lock before COMMIT.
      db.exec('PRAGMA foreign_keys=OFF; PRAGMA synchronous=FULL;');
      db.exec('BEGIN IMMEDIATE');
      const shape = knownSchema(db); // serialized again with writers before schema or row mutations
      if (shape === 'legacy' || shape === 'current') {
        // Rebuild only these two tables to make monetary fields genuinely nullable, in one transaction.
        // Audit rows, epochs, checkpoints, state, timestamps and all original values are copied unchanged.
        db.exec(
          QUOTA_ENVELOPES.replace('envelopes (', 'envelopes_next (') +
            QUOTA_RESERVATIONS.replace('reservations (', 'reservations_next (').replace(
              'REFERENCES envelopes(',
              'REFERENCES envelopes_next(',
            ),
        );
        db.exec(`INSERT INTO envelopes_next (id,run_id,provider_id,binding_digest,admission_digest,receipt_digest,max_tokens,max_cost_nanos,currency,overdrawn,created_at,accounting_basis)
          SELECT id,run_id,${shape === 'legacy' ? 'NULL' : 'provider_id'},binding_digest,admission_digest,receipt_digest,max_tokens,max_cost_nanos,currency,overdrawn,created_at,'money' FROM envelopes`);
        db.exec(`INSERT INTO reservations_next (id,envelope_id,operation_id,state,tokens,cost_nanos,used_input,used_output,used_cost_nanos,epoch,reconciled_by,created_at,updated_at,accounting_basis)
          SELECT id,envelope_id,operation_id,state,tokens,cost_nanos,used_input,used_output,used_cost_nanos,epoch,reconciled_by,created_at,updated_at,'money' FROM reservations`);
        db.exec(
          'DROP TABLE reservations; DROP TABLE envelopes; ALTER TABLE envelopes_next RENAME TO envelopes; ALTER TABLE reservations_next RENAME TO reservations;',
        );
      }
      db.exec(QUOTA_SCHEMA);
      knownSchema(db);
      db.exec('COMMIT');
      db.exec('PRAGMA foreign_keys=ON;');
      // Change journal mode only after the serialized final schema check accepted the database.
      db.exec('PRAGMA journal_mode=WAL;');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      db.close();
      return fail(
        'sentinel.provider.ledgerInvalid',
        (error as { errcode?: number }).errcode === 5 || (error as { errcode?: number }).errcode === 6
          ? 'budget ledger is busy'
          : 'budget ledger schema is unknown or could not be migrated',
      );
    }
    return new BudgetLedger(db);
  }

  /** Idempotent. */
  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }

  #tx<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.#db.exec('COMMIT');
      return out;
    } catch (e) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw e;
    }
  }

  #get(sql: string, ...args: (string | number | bigint | null)[]): Row | undefined {
    const st = this.#db.prepare(sql);
    st.setReadBigInts(true);
    return st.get(...args) as Row | undefined;
  }

  #all(sql: string, ...args: (string | number | bigint | null)[]): Row[] {
    const st = this.#db.prepare(sql);
    st.setReadBigInts(true);
    return st.all(...args) as Row[];
  }

  #run(sql: string, ...args: (string | number | bigint | null)[]): void {
    this.#db.prepare(sql).run(...args);
  }

  #fenced(epoch: string): boolean {
    return !!this.#get('SELECT 1 AS x FROM fenced_epochs WHERE epoch = ?', epoch);
  }

  #assertLive(epoch: string): void {
    if (this.#fenced(epoch))
      fail(
        'sentinel.provider.epochFenced',
        'this coordinator epoch was fenced by recovery; a newer epoch owns its work',
      );
  }

  /** Records an approved envelope once. Re-creating the same id with other terms is refused. */
  createEnvelope(e: EnvelopeInput): void {
    id(e.id, 'the envelope');
    id(e.runId, 'the run');
    id(e.providerId, 'the provider');
    tokens(e.maxTokens, 'maxTokens');
    const quota = e.accountingBasis === 'subscription-quota';
    if (e.accountingBasis !== undefined && !quota) fail('sentinel.provider.ledgerInvalid', 'unknown accounting basis');
    if (quota) {
      if (e.maxCostNanos !== null || e.currency !== null)
        fail('sentinel.provider.ledgerInvalid', 'quota has no monetary cost or currency');
    } else {
      nanos(e.maxCostNanos, 'maxCost');
      if (e.currency === null) fail('sentinel.provider.ledgerInvalid', 'monetary budget needs a currency');
    }
    this.#tx(() => {
      const prior = this.#get('SELECT * FROM envelopes WHERE id = ?', e.id);
      if (prior) {
        if (
          prior.binding_digest !== e.bindingDigest ||
          prior.admission_digest !== e.admissionDigest ||
          BigInt(prior.max_tokens as bigint) !== BigInt(e.maxTokens) ||
          prior.max_cost_nanos !== e.maxCostNanos ||
          prior.currency !== e.currency ||
          prior.run_id !== e.runId ||
          prior.provider_id !== e.providerId ||
          prior.accounting_basis !== (quota ? 'subscription-quota' : 'money')
        ) {
          fail('sentinel.provider.ledgerInvalid', 'an envelope with this id already has other terms');
        }
        return;
      }
      // A new admission/resume does not create a new budget for the same provider and run.
      for (const old of this.#all(
        'SELECT max_tokens,max_cost_nanos,currency,accounting_basis FROM envelopes WHERE provider_id = ? AND run_id = ?',
        e.providerId,
        e.runId,
      )) {
        if (old.accounting_basis !== (quota ? 'subscription-quota' : 'money') || old.currency !== e.currency)
          fail('sentinel.provider.ledgerInvalid', 'a resumed run cannot change accounting basis or currency');
        if (
          BigInt(e.maxTokens) > (old.max_tokens as bigint) ||
          (e.maxCostNanos !== null && e.maxCostNanos > (old.max_cost_nanos as bigint))
        )
          fail('sentinel.provider.budgetExhausted', 'a resumed run may only tighten its original budget');
      }
      this.#run(
        'INSERT INTO envelopes (id, run_id, provider_id, binding_digest, admission_digest, receipt_digest, max_tokens, max_cost_nanos, currency, created_at, accounting_basis) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        e.id,
        e.runId,
        e.providerId,
        e.bindingDigest,
        e.admissionDigest,
        e.receiptDigest,
        e.maxTokens,
        e.maxCostNanos,
        e.currency,
        e.createdAt,
        quota ? 'subscription-quota' : 'money',
      );
    });
  }

  #totals(envelopeId: string): EnvelopeTotals {
    const env = this.#get(
      'SELECT max_tokens, max_cost_nanos, overdrawn, accounting_basis FROM envelopes WHERE id = ?',
      envelopeId,
    );
    if (!env) return fail('sentinel.provider.ledgerInvalid', 'no such envelope');
    const quota = env.accounting_basis === 'subscription-quota';
    const byState = { held: 0, dispatched: 0, settled: 0, uncertain: 0, released: 0 } as Record<
      ReservationState,
      number
    >;
    let t = 0n;
    let c = 0n;
    for (const r of this.#all(
      'SELECT state, tokens, cost_nanos, used_input, used_output, used_cost_nanos, accounting_basis FROM reservations WHERE envelope_id = ?',
      envelopeId,
    )) {
      if (r.accounting_basis !== env.accounting_basis)
        fail('sentinel.provider.ledgerInvalid', 'reservation accounting basis differs from its envelope');
      const s = r.state as ReservationState;
      byState[s]++;
      if (s === 'released') continue;
      if (s === 'settled') {
        t += (r.used_input as bigint) + (r.used_output as bigint);
        if (!quota) c += r.used_cost_nanos as bigint;
      } else {
        t += r.tokens as bigint;
        if (!quota) c += r.cost_nanos as bigint;
      }
    }
    return Object.freeze({
      maxTokens: Number(env.max_tokens),
      maxCostNanos: env.max_cost_nanos as bigint | null,
      chargedTokens: Number(t),
      chargedCostNanos: quota ? null : c,
      ...(quota ? { accountingBasis: 'subscription-quota' as const } : {}),
      byState: Object.freeze(byState),
      overdrawn: env.overdrawn === 1n,
    });
  }

  totals(envelopeId: string): EnvelopeTotals {
    return this.#tx(() => this.#totals(envelopeId));
  }

  #row(rid: string): Reservation {
    const r = this.#get('SELECT * FROM reservations WHERE id = ?', rid);
    if (!r) return fail('sentinel.provider.reservationState', 'no such reservation');
    return Object.freeze({
      id: r.id as string,
      envelopeId: r.envelope_id as string,
      operationId: r.operation_id as string,
      state: r.state as ReservationState,
      tokens: Number(r.tokens),
      costNanos: r.cost_nanos as bigint | null,
      ...(r.accounting_basis === 'subscription-quota' ? { accountingBasis: 'subscription-quota' as const } : {}),
      usedInputTokens: r.used_input === null ? null : Number(r.used_input),
      usedOutputTokens: r.used_output === null ? null : Number(r.used_output),
      usedCostNanos: (r.used_cost_nanos as bigint | null) ?? null,
      epoch: r.epoch as string,
      reconciledBy: (r.reconciled_by as string | null) ?? null,
    });
  }

  reservation(rid: string): Reservation {
    return this.#tx(() => this.#row(rid));
  }

  /**
   * Reserves the worst case of one operation, atomically against everything already charged. The same operation with
   * the same amounts returns its existing reservation (whatever its state); other amounts are a conflict.
   */
  reserve(r: {
    envelopeId: string;
    operationId: string;
    tokens: number;
    costNanos: bigint | null;
    epoch: string;
    at: string;
  }): Reservation {
    id(r.envelopeId, 'the envelope');
    id(r.operationId, 'the operation');
    id(r.epoch, 'the epoch');
    tokens(r.tokens, 'tokens');
    if (r.costNanos !== null) nanos(r.costNanos, 'cost');
    return this.#tx(() => {
      const provenance = this.#get('SELECT provider_id,run_id FROM envelopes WHERE id = ?', r.envelopeId);
      if (!provenance || provenance.provider_id === null)
        fail('sentinel.provider.notTrusted', 'legacy provider provenance cannot admit new work');
      // An operation is sent at most once in this ledger, under whichever envelope: after a crash a new envelope never
      // makes an uncertain operation sendable again.
      const elsewhere = this.#get(
        'SELECT state FROM reservations WHERE operation_id = ? AND envelope_id <> ?',
        r.operationId,
        r.envelopeId,
      );
      if (elsewhere)
        fail(
          'sentinel.provider.reservationState',
          `operation ${r.operationId.slice(0, 64)} is already ${String(elsewhere.state)} under another envelope`,
        );
      const prior = this.#get(
        'SELECT id, tokens, cost_nanos FROM reservations WHERE envelope_id = ? AND operation_id = ?',
        r.envelopeId,
        r.operationId,
      );
      if (prior) {
        if (Number(prior.tokens) !== r.tokens || prior.cost_nanos !== r.costNanos)
          fail('sentinel.provider.operationConflict', r.operationId);
        return this.#row(prior.id as string);
      }
      this.#assertLive(r.epoch);
      const t = this.#totals(r.envelopeId);
      if ((t.accountingBasis === 'subscription-quota') !== (r.costNanos === null))
        fail('sentinel.provider.ledgerInvalid', 'reservation must use its envelope accounting basis');
      const run = this.#get(
        `SELECT MIN(e.max_tokens) AS max_tokens,MIN(e.max_cost_nanos) AS max_cost,MAX(e.overdrawn) AS overdrawn,
        COALESCE(SUM(CASE WHEN r.state = 'settled' THEN r.used_input + r.used_output WHEN r.state = 'released' OR r.id IS NULL THEN 0 ELSE r.tokens END),0) AS tokens,
        COALESCE(SUM(CASE WHEN r.state = 'settled' THEN r.used_cost_nanos WHEN r.state = 'released' OR r.id IS NULL THEN 0 ELSE r.cost_nanos END),0) AS cost
        FROM envelopes e LEFT JOIN reservations r ON r.envelope_id = e.id WHERE e.provider_id = ? AND e.run_id = ?`,
        provenance!.provider_id as string,
        provenance!.run_id as string,
      )!;
      if (run.overdrawn === 1n)
        fail('sentinel.provider.envelopeOverdrawn', 'an earlier call in this run reported more than it reserved');
      if ((run.tokens as bigint) + BigInt(r.tokens) > (run.max_tokens as bigint))
        fail('sentinel.provider.budgetExhausted', 'not enough tokens left across this provider and run');
      if (
        r.costNanos !== null &&
        run.max_cost !== null &&
        (run.cost as bigint) + r.costNanos > (run.max_cost as bigint)
      )
        fail('sentinel.provider.budgetExhausted', 'not enough money left across this provider and run');
      // A digest of the exact pair: distinct operations never share an id, whatever their length.
      const rid = `res-${createHash('sha256').update(`${r.envelopeId}\u0000${r.operationId}`).digest('hex').slice(0, 48)}`;
      this.#run(
        'INSERT INTO reservations (id, envelope_id, operation_id, state, tokens, cost_nanos, epoch, created_at, updated_at, accounting_basis) VALUES (?,?,?,?,?,?,?,?,?,?)',
        rid,
        r.envelopeId,
        r.operationId,
        'held',
        r.tokens,
        r.costNanos,
        r.epoch,
        r.at,
        r.at,
        t.accountingBasis === 'subscription-quota' ? 'subscription-quota' : 'money',
      );
      this.#event(rid, null, 'held', 'reserved', r.at);
      return this.#row(rid);
    });
  }

  #event(rid: string, from: ReservationState | null, to: ReservationState, detail: string, at: string): void {
    this.#run(
      'INSERT INTO reservation_events (reservation_id, from_state, to_state, detail, at) VALUES (?,?,?,?,?)',
      rid,
      from,
      to,
      detail.slice(0, 200),
      at,
    );
  }

  #move(
    rid: string,
    from: readonly ReservationState[],
    to: ReservationState,
    detail: string,
    at: string,
    set = '',
    ...args: (string | number | bigint | null)[]
  ): Reservation {
    const cur = this.#row(rid);
    if (!from.includes(cur.state)) fail('sentinel.provider.reservationState', `${cur.state} cannot become ${to}`);
    this.#run(`UPDATE reservations SET state = ?, updated_at = ?${set} WHERE id = ?`, to, at, ...args, rid);
    this.#event(rid, cur.state, to, detail, at);
    return this.#row(rid);
  }

  /** Written before the request leaves: from here a crash leaves the call uncertain, never forgotten. */
  dispatch(rid: string, at: string): Reservation {
    return this.#tx(() => {
      const row = this.#row(rid);
      const provenance = this.#get('SELECT provider_id FROM envelopes WHERE id = ?', row.envelopeId);
      if (!provenance || provenance.provider_id === null)
        fail('sentinel.provider.notTrusted', 'legacy provider provenance cannot dispatch work');
      this.#assertLive(row.epoch);
      return this.#move(rid, ['held'], 'dispatched', 'about to send', at);
    });
  }

  /** Returns a reservation that was never sent: held, or dispatched when no connection was ever made. */
  releaseUnsent(rid: string, at: string, proof: 'not-dispatched' | 'no-connection'): Reservation {
    return this.#tx(() =>
      this.#move(rid, proof === 'not-dispatched' ? ['held'] : ['held', 'dispatched'], 'released', proof, at),
    );
  }

  /** The call may have been charged but reported no usage: its whole reservation stays charged. */
  markUncertain(rid: string, at: string, detail: string): Reservation {
    return this.#tx(() => this.#move(rid, ['dispatched'], 'uncertain', detail, at));
  }

  #settle(
    rid: string,
    from: readonly ReservationState[],
    u: Usage,
    at: string,
    detail: string,
    by: string | null,
  ): Reservation {
    tokens(u.inputTokens, 'input tokens');
    tokens(u.outputTokens, 'output tokens');
    if (u.costNanos !== null) nanos(u.costNanos, 'cost');
    const before = this.#row(rid);
    if ((before.accountingBasis === 'subscription-quota') !== (u.costNanos === null))
      fail('sentinel.provider.ledgerInvalid', 'usage must use its reservation accounting basis');
    const out = this.#move(
      rid,
      from,
      'settled',
      detail,
      at,
      ', used_input = ?, used_output = ?, used_cost_nanos = ?, reconciled_by = ?',
      u.inputTokens,
      u.outputTokens,
      u.costNanos,
      by,
    );
    // Any call above its own reservation broke the per-call bound: the envelope takes no further call, even with room left.
    const overrun =
      u.inputTokens + u.outputTokens > before.tokens ||
      (u.costNanos !== null && before.costNanos !== null && u.costNanos > before.costNanos);
    if (overrun) this.#event(rid, 'settled', 'settled', 'overrun: reported usage above the reservation', at);
    const t = this.#totals(before.envelopeId);
    if (
      overrun ||
      t.chargedTokens > t.maxTokens ||
      (t.chargedCostNanos !== null && t.maxCostNanos !== null && t.chargedCostNanos > t.maxCostNanos)
    )
      this.#run('UPDATE envelopes SET overdrawn = 1 WHERE id = ?', before.envelopeId);
    return out;
  }

  /** Charges a dispatched call at its reported usage. More than reserved is charged in full and overdraws the envelope. */
  settle(rid: string, u: Usage, at: string): Reservation {
    return this.#tx(() => this.#settle(rid, ['dispatched'], u, at, 'reported usage', null));
  }

  /** Settles an uncertain call at usage the owner established, naming the authority (a spent receipt's digest). */
  reconcile(rid: string, u: Usage, authority: string, at: string): Reservation {
    if (typeof authority !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(authority))
      fail('sentinel.provider.reservationState', 'reconciliation names its authority');
    return this.#tx(() => this.#settle(rid, ['uncertain'], u, at, 'reconciled by the owner', authority));
  }

  /**
   * For epochs the coordinator has fenced (their processes can no longer send): held → released, dispatched →
   * uncertain. Live epochs are never touched.
   */
  recover(staleEpochs: readonly string[], at: string): { released: number; uncertain: number } {
    for (const e of staleEpochs) id(e, 'an epoch');
    return this.#tx(() => {
      // Fenced first: from here a stale process can neither reserve, dispatch nor checkpoint under its epoch.
      for (const e of staleEpochs)
        this.#run('INSERT OR IGNORE INTO fenced_epochs (epoch, fenced_at) VALUES (?, ?)', e, at);
      let released = 0;
      let uncertain = 0;
      for (const e of staleEpochs) {
        for (const r of this.#all(
          "SELECT id, state FROM reservations WHERE epoch = ? AND state IN ('held','dispatched')",
          e,
        )) {
          if (r.state === 'held') {
            this.#move(r.id as string, ['held'], 'released', 'recovered: never sent', at);
            released++;
          } else {
            this.#move(r.id as string, ['dispatched'], 'uncertain', 'recovered: may have been sent', at);
            uncertain++;
          }
        }
      }
      return { released, uncertain };
    });
  }

  /** Whether recovery fenced this epoch. */
  isFenced(epoch: string): boolean {
    id(epoch, 'an epoch');
    return this.#tx(() => this.#fenced(epoch));
  }

  /** The reservation an operation made under an envelope, if any. */
  reservationOf(envelopeId: string, operationId: string): Reservation | null {
    return this.#tx(() => {
      const r = this.#get(
        'SELECT id FROM reservations WHERE envelope_id = ? AND operation_id = ?',
        envelopeId,
        operationId,
      );
      return r ? this.#row(r.id as string) : null;
    });
  }

  /** Envelopes, newest first, at most `limit` (1–200), optionally for one run. */
  listEnvelopes(options: { runId?: string; limit: number }): {
    id: string;
    runId: string;
    providerId: string | null;
    bindingDigest: string;
    receiptDigest: string | null;
    currency: string | null;
    createdAt: string;
    totals: EnvelopeTotals;
  }[] {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200)
      fail('sentinel.provider.ledgerInvalid', 'list 1–200 envelopes');
    if (options.runId !== undefined) id(options.runId, 'the run');
    return this.#tx(() => {
      const rows =
        options.runId === undefined
          ? this.#all('SELECT * FROM envelopes ORDER BY created_at DESC, id LIMIT ?', options.limit)
          : this.#all(
              'SELECT * FROM envelopes WHERE run_id = ? ORDER BY created_at DESC, id LIMIT ?',
              options.runId,
              options.limit,
            );
      return rows.map((r) => ({
        id: r.id as string,
        runId: r.run_id as string,
        providerId: (r.provider_id as string | null) ?? null,
        bindingDigest: r.binding_digest as string,
        receiptDigest: (r.receipt_digest as string | null) ?? null,
        currency: r.currency as string | null,
        createdAt: r.created_at as string,
        totals: this.#totals(r.id as string),
      }));
    });
  }

  /** Held, dispatched and uncertain reservations of one envelope, at most `limit` (1–1000). */
  openReservations(envelopeId: string, limit: number): Reservation[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      fail('sentinel.provider.ledgerInvalid', 'list 1–1000 reservations');
    return this.#tx(() =>
      this.#all(
        "SELECT id FROM reservations WHERE envelope_id = ? AND state IN ('held','dispatched','uncertain') ORDER BY created_at, id LIMIT ?",
        envelopeId,
        limit,
      ).map((r) => this.#row(r.id as string)),
    );
  }

  /** The latest checkpoint text a session saved, with the epoch that wrote it. */
  loadCheckpoint(sessionId: string): { body: string; epoch: string; sequence: number } | null {
    return this.#tx(() => {
      const r = this.#get('SELECT body, epoch, sequence FROM review_checkpoints WHERE session_id = ?', sessionId);
      return r ? { body: r.body as string, epoch: r.epoch as string, sequence: Number(r.sequence) } : null;
    });
  }

  /**
   * Saves a session's checkpoint under one epoch, atomically. Refused for a fenced epoch, and when another epoch that
   * is still live wrote the last one: a session has one writer at a time, and recovery hands it over.
   */
  saveCheckpoint(sessionId: string, epoch: string, body: string, at: string): number {
    id(epoch, 'the epoch');
    if (typeof body !== 'string' || Buffer.byteLength(body) > 4 * 1024 * 1024)
      fail('sentinel.provider.ledgerInvalid', 'a checkpoint is at most 4 MiB');
    return this.#tx(() => {
      this.#assertLive(epoch);
      const prior = this.#get('SELECT epoch, sequence FROM review_checkpoints WHERE session_id = ?', sessionId);
      if (prior && prior.epoch !== epoch && !this.#fenced(prior.epoch as string))
        fail('sentinel.provider.epochFenced', 'another live epoch owns this session');
      const sequence = prior ? Number(prior.sequence) + 1 : 1;
      this.#run(
        'INSERT INTO review_checkpoints (session_id, epoch, sequence, body, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET epoch = excluded.epoch, sequence = excluded.sequence, body = excluded.body, updated_at = excluded.updated_at',
        sessionId,
        epoch,
        sequence,
        body,
        at,
      );
      return sequence;
    });
  }

  /** Every state change of one reservation, oldest first. */
  events(rid: string): { from: ReservationState | null; to: ReservationState; detail: string; at: string }[] {
    return this.#all(
      'SELECT from_state, to_state, detail, at FROM reservation_events WHERE reservation_id = ? ORDER BY seq',
      rid,
    ).map((r) => ({
      from: (r.from_state as ReservationState | null) ?? null,
      to: r.to_state as ReservationState,
      detail: r.detail as string,
      at: r.at as string,
    }));
  }
}
