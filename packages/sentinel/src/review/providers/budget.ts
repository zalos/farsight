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
import { isAbsolute } from 'node:path';
import { checkSqliteRuntime } from '../../store/runtime.js';
import { fail } from './errors.js';

export type ReservationState = 'held' | 'dispatched' | 'settled' | 'uncertain' | 'released';

export const RESERVATION_STATE_KEYS: Readonly<Record<ReservationState, string>> = Object.freeze({
  held: 'sentinel.reservation.held', dispatched: 'sentinel.reservation.dispatched', settled: 'sentinel.reservation.settled',
  uncertain: 'sentinel.reservation.uncertain', released: 'sentinel.reservation.released',
});

export interface EnvelopeInput {
  readonly id: string;
  readonly runId: string;
  readonly providerId: string;
  readonly bindingDigest: string;
  readonly admissionDigest: string;
  readonly receiptDigest: string | null;
  readonly maxTokens: number;
  readonly maxCostNanos: bigint;
  readonly currency: string;
  readonly createdAt: string;
}

export interface Reservation {
  readonly id: string;
  readonly envelopeId: string;
  readonly operationId: string;
  readonly state: ReservationState;
  readonly tokens: number;
  readonly costNanos: bigint;
  readonly usedInputTokens: number | null;
  readonly usedOutputTokens: number | null;
  readonly usedCostNanos: bigint | null;
  readonly epoch: string;
  readonly reconciledBy: string | null;
}

export interface EnvelopeTotals {
  readonly maxTokens: number;
  readonly maxCostNanos: bigint;
  /** Charged against the envelope: worst case for held, dispatched and uncertain; actual for settled. */
  readonly chargedTokens: number;
  readonly chargedCostNanos: bigint;
  readonly byState: Readonly<Record<ReservationState, number>>;
  readonly overdrawn: boolean;
}

export interface Usage { readonly inputTokens: number; readonly outputTokens: number; readonly costNanos: bigint }

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

// Recognize only this package's exact historical schemas before changing a database. Unknown DDL is refused;
// a legacy row has genuinely unobserved provider provenance, never a guessed binding or provider id.
function ddl(sql: string): string {
  // Tokenize instead of deleting whitespace: both literal contents and token boundaries are semantic.
  // Unknown comments/quoting/operators refuse; this recognizes only the package's emitted DDL vocabulary.
  const out: string[] = []; let end = 0;
  const token = /'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_]*|[0-9]+|>=|<=|<>|!=|[(),;=<>+*-]/g;
  for (const match of sql.matchAll(token)) {
    if (/\S/.test(sql.slice(end, match.index))) return fail('sentinel.provider.ledgerInvalid', 'unknown budget ledger DDL');
    out.push(match[0]); end = match.index! + match[0].length;
  }
  if (/\S/.test(sql.slice(end))) return fail('sentinel.provider.ledgerInvalid', 'unknown budget ledger DDL');
  if (out[0] === 'CREATE' && out[1] === 'TABLE' && out.slice(2, 5).join(' ') === 'IF NOT EXISTS') out.splice(2, 3);
  if (out.at(-1) === ';') out.pop();
  return JSON.stringify(out);
}
const rawTables = new Map([...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \([\s\S]*?\) STRICT;/g)]
  .map(m => [m[1]!, m[0]]));
const expectedTables = new Map([...rawTables].map(([name, sql]) => [name, ddl(sql)]));
const oldEnvelopeSql = rawTables.get('envelopes')!.replace('provider_id TEXT NOT NULL, ', '');
const oldEnvelope = ddl(oldEnvelopeSql);
const migratedEnvelope = ddl(oldEnvelopeSql.replace(/\) STRICT;$/, ', provider_id TEXT) STRICT;'));
type SchemaDb = InstanceType<typeof import('node:sqlite')['DatabaseSync']>;
function knownSchema(db: SchemaDb): 'empty' | 'legacy' | 'current' {
  const all = db.prepare('SELECT name, type, tbl_name, sql FROM sqlite_master ORDER BY name LIMIT 65').all() as { name: string; type: string; tbl_name: string; sql: string | null }[];
  if (all.length > 64) return fail('sentinel.provider.ledgerInvalid', 'unknown budget ledger schema');
  const indexes = new Map([['sqlite_autoindex_envelopes_1', 'envelopes'], ['sqlite_autoindex_reservations_1', 'reservations'],
    ['sqlite_autoindex_reservations_2', 'reservations'], ['sqlite_autoindex_fenced_epochs_1', 'fenced_epochs'], ['sqlite_autoindex_review_checkpoints_1', 'review_checkpoints']]);
  const objects = all.filter(o => {
    if (o.name === 'sqlite_sequence' && o.type === 'table' && o.tbl_name === 'sqlite_sequence' && o.sql !== null
      && ddl(o.sql) === ddl('CREATE TABLE sqlite_sequence(name,seq)')) return false;
    if (indexes.get(o.name) === o.tbl_name && o.type === 'index' && o.sql === null) return false;
    return true;
  });
  if (objects.length === 0 && all.length === 0) return 'empty';
  if (objects.length > 5 || objects.some(o => o.type !== 'table' || !expectedTables.has(o.name) || !o.sql)) {
    return fail('sentinel.provider.ledgerInvalid', 'unknown budget ledger schema');
  }
  const names = new Set(objects.map(o => o.name));
  if (!['envelopes', 'reservations', 'reservation_events'].every(n => names.has(n))
    || names.has('fenced_epochs') !== names.has('review_checkpoints')) return fail('sentinel.provider.ledgerInvalid', 'incomplete budget ledger schema');
  let legacy = false;
  for (const object of objects) {
    const actual = ddl(object.sql!);
    if (object.name === 'envelopes') {
      if (actual === oldEnvelope) legacy = true;
      else if (actual !== expectedTables.get(object.name) && actual !== migratedEnvelope) return fail('sentinel.provider.ledgerInvalid', 'unknown envelope schema');
    } else if (actual !== expectedTables.get(object.name)) return fail('sentinel.provider.ledgerInvalid', 'unknown reservation or checkpoint schema');
  }
  if (db.prepare('PRAGMA foreign_key_check').get()) return fail('sentinel.provider.ledgerInvalid', 'budget ledger foreign keys are invalid');
  return legacy ? 'legacy' : 'current';
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const id = (v: unknown, what: string) => { if (typeof v !== 'string' || !ID.test(v)) fail('sentinel.provider.ledgerInvalid', `${what} is not an id`); };
const tokens = (v: unknown, what: string) => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail('sentinel.provider.ledgerInvalid', `${what} must be a whole number`); };
const nanos = (v: unknown, what: string) => { if (typeof v !== 'bigint' || v < 0n || v > 9_000_000_000_000_000_000n) fail('sentinel.provider.ledgerInvalid', `${what} must be a non-negative amount`); };

type Db = InstanceType<typeof import('node:sqlite')['DatabaseSync']>;
type Row = Record<string, unknown>;

export class BudgetLedger {
  readonly #db: Db;
  private constructor(db: Db) { this.#db = db; }

  /** Opens (creating if absent) the ledger at an absolute path, behind the store's SQLite release gate. */
  static async open(path: string, options: { busyTimeoutMs?: number } = {}): Promise<BudgetLedger> {
    if (typeof path !== 'string' || !isAbsolute(path)) fail('sentinel.provider.ledgerInvalid', 'the ledger path must be absolute');
    const { sqlite } = await checkSqliteRuntime();
    let db: Db;
    try { db = new sqlite.DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: options.busyTimeoutMs ?? 10_000, defensive: true }); }
    catch { return fail('sentinel.provider.ledgerInvalid', 'the ledger file could not be opened'); }
    try {
      // The first check is read-only: malformed existing files are not changed even to switch journal mode.
      knownSchema(db);
      db.exec('PRAGMA synchronous=FULL;');
      db.exec('BEGIN IMMEDIATE');
      const shape = knownSchema(db); // serialized again with writers before schema or row mutations
      if (shape === 'legacy') db.exec('ALTER TABLE envelopes ADD COLUMN provider_id TEXT');
      db.exec(SCHEMA); knownSchema(db);
      db.exec('COMMIT');
      // Change journal mode only after the serialized final schema check accepted the database.
      db.exec('PRAGMA journal_mode=WAL;');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK'); db.close();
      return fail('sentinel.provider.ledgerInvalid', (error as { errcode?: number }).errcode === 5 || (error as { errcode?: number }).errcode === 6
        ? 'budget ledger is busy' : 'budget ledger schema is unknown or could not be migrated');
    }
    return new BudgetLedger(db);
  }

  /** Idempotent. */
  close(): void { if (this.#db.isOpen) this.#db.close(); }

  #tx<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); this.#db.exec('COMMIT'); return out; } catch (e) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw e; }
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

  #run(sql: string, ...args: (string | number | bigint | null)[]): void { this.#db.prepare(sql).run(...args); }

  #fenced(epoch: string): boolean { return !!this.#get('SELECT 1 AS x FROM fenced_epochs WHERE epoch = ?', epoch); }

  #assertLive(epoch: string): void {
    if (this.#fenced(epoch)) fail('sentinel.provider.epochFenced', 'this coordinator epoch was fenced by recovery; a newer epoch owns its work');
  }

  /** Records an approved envelope once. Re-creating the same id with other terms is refused. */
  createEnvelope(e: EnvelopeInput): void {
    id(e.id, 'the envelope'); id(e.runId, 'the run'); id(e.providerId, 'the provider'); tokens(e.maxTokens, 'maxTokens'); nanos(e.maxCostNanos, 'maxCost');
    this.#tx(() => {
      const prior = this.#get('SELECT * FROM envelopes WHERE id = ?', e.id);
      if (prior) {
        if (prior.binding_digest !== e.bindingDigest || prior.admission_digest !== e.admissionDigest || BigInt(prior.max_tokens as bigint) !== BigInt(e.maxTokens)
          || prior.max_cost_nanos !== e.maxCostNanos || prior.currency !== e.currency || prior.run_id !== e.runId || prior.provider_id !== e.providerId) {
          fail('sentinel.provider.ledgerInvalid', 'an envelope with this id already has other terms');
        }
        return;
      }
      this.#run('INSERT INTO envelopes (id, run_id, provider_id, binding_digest, admission_digest, receipt_digest, max_tokens, max_cost_nanos, currency, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        e.id, e.runId, e.providerId, e.bindingDigest, e.admissionDigest, e.receiptDigest, e.maxTokens, e.maxCostNanos, e.currency, e.createdAt);
    });
  }

  #totals(envelopeId: string): EnvelopeTotals {
    const env = this.#get('SELECT max_tokens, max_cost_nanos, overdrawn FROM envelopes WHERE id = ?', envelopeId);
    if (!env) return fail('sentinel.provider.ledgerInvalid', 'no such envelope');
    const byState = { held: 0, dispatched: 0, settled: 0, uncertain: 0, released: 0 } as Record<ReservationState, number>;
    let t = 0n;
    let c = 0n;
    for (const r of this.#all('SELECT state, tokens, cost_nanos, used_input, used_output, used_cost_nanos FROM reservations WHERE envelope_id = ?', envelopeId)) {
      const s = r.state as ReservationState;
      byState[s]++;
      if (s === 'released') continue;
      if (s === 'settled') { t += (r.used_input as bigint) + (r.used_output as bigint); c += r.used_cost_nanos as bigint; }
      else { t += r.tokens as bigint; c += r.cost_nanos as bigint; }
    }
    return Object.freeze({ maxTokens: Number(env.max_tokens), maxCostNanos: env.max_cost_nanos as bigint, chargedTokens: Number(t), chargedCostNanos: c,
      byState: Object.freeze(byState), overdrawn: env.overdrawn === 1n });
  }

  totals(envelopeId: string): EnvelopeTotals { return this.#tx(() => this.#totals(envelopeId)); }

  #row(rid: string): Reservation {
    const r = this.#get('SELECT * FROM reservations WHERE id = ?', rid);
    if (!r) return fail('sentinel.provider.reservationState', 'no such reservation');
    return Object.freeze({
      id: r.id as string, envelopeId: r.envelope_id as string, operationId: r.operation_id as string, state: r.state as ReservationState,
      tokens: Number(r.tokens), costNanos: r.cost_nanos as bigint,
      usedInputTokens: r.used_input === null ? null : Number(r.used_input), usedOutputTokens: r.used_output === null ? null : Number(r.used_output),
      usedCostNanos: (r.used_cost_nanos as bigint | null) ?? null, epoch: r.epoch as string, reconciledBy: (r.reconciled_by as string | null) ?? null,
    });
  }

  reservation(rid: string): Reservation { return this.#tx(() => this.#row(rid)); }

  /**
   * Reserves the worst case of one operation, atomically against everything already charged. The same operation with
   * the same amounts returns its existing reservation (whatever its state); other amounts are a conflict.
   */
  reserve(r: { envelopeId: string; operationId: string; tokens: number; costNanos: bigint; epoch: string; at: string }): Reservation {
    id(r.envelopeId, 'the envelope'); id(r.operationId, 'the operation'); id(r.epoch, 'the epoch'); tokens(r.tokens, 'tokens'); nanos(r.costNanos, 'cost');
    return this.#tx(() => {
      const provenance = this.#get('SELECT provider_id FROM envelopes WHERE id = ?', r.envelopeId);
      if (!provenance || provenance.provider_id === null) fail('sentinel.provider.notTrusted', 'legacy provider provenance cannot admit new work');
      // An operation is sent at most once in this ledger, under whichever envelope: after a crash a new envelope never
      // makes an uncertain operation sendable again.
      const elsewhere = this.#get('SELECT state FROM reservations WHERE operation_id = ? AND envelope_id <> ?', r.operationId, r.envelopeId);
      if (elsewhere) fail('sentinel.provider.reservationState', `operation ${r.operationId.slice(0, 64)} is already ${String(elsewhere.state)} under another envelope`);
      const prior = this.#get('SELECT id, tokens, cost_nanos FROM reservations WHERE envelope_id = ? AND operation_id = ?', r.envelopeId, r.operationId);
      if (prior) {
        if (Number(prior.tokens) !== r.tokens || prior.cost_nanos !== r.costNanos) fail('sentinel.provider.operationConflict', r.operationId);
        return this.#row(prior.id as string);
      }
      this.#assertLive(r.epoch);
      const t = this.#totals(r.envelopeId);
      if (t.overdrawn) fail('sentinel.provider.envelopeOverdrawn', 'an earlier call reported more than it reserved');
      if (t.chargedTokens + r.tokens > t.maxTokens) fail('sentinel.provider.budgetExhausted', `${t.maxTokens - t.chargedTokens} tokens left, ${r.tokens} needed`);
      if (t.chargedCostNanos + r.costNanos > t.maxCostNanos) fail('sentinel.provider.budgetExhausted', 'not enough money left for the worst case');
      // A digest of the exact pair: distinct operations never share an id, whatever their length.
      const rid = `res-${createHash('sha256').update(`${r.envelopeId}\u0000${r.operationId}`).digest('hex').slice(0, 48)}`;
      this.#run('INSERT INTO reservations (id, envelope_id, operation_id, state, tokens, cost_nanos, epoch, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        rid, r.envelopeId, r.operationId, 'held', r.tokens, r.costNanos, r.epoch, r.at, r.at);
      this.#event(rid, null, 'held', 'reserved', r.at);
      return this.#row(rid);
    });
  }

  #event(rid: string, from: ReservationState | null, to: ReservationState, detail: string, at: string): void {
    this.#run('INSERT INTO reservation_events (reservation_id, from_state, to_state, detail, at) VALUES (?,?,?,?,?)', rid, from, to, detail.slice(0, 200), at);
  }

  #move(rid: string, from: readonly ReservationState[], to: ReservationState, detail: string, at: string, set = '', ...args: (string | number | bigint | null)[]): Reservation {
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
      if (!provenance || provenance.provider_id === null) fail('sentinel.provider.notTrusted', 'legacy provider provenance cannot dispatch work');
      this.#assertLive(row.epoch); return this.#move(rid, ['held'], 'dispatched', 'about to send', at); });
  }

  /** Returns a reservation that was never sent: held, or dispatched when no connection was ever made. */
  releaseUnsent(rid: string, at: string, proof: 'not-dispatched' | 'no-connection'): Reservation {
    return this.#tx(() => this.#move(rid, proof === 'not-dispatched' ? ['held'] : ['held', 'dispatched'], 'released', proof, at));
  }

  /** The call may have been charged but reported no usage: its whole reservation stays charged. */
  markUncertain(rid: string, at: string, detail: string): Reservation { return this.#tx(() => this.#move(rid, ['dispatched'], 'uncertain', detail, at)); }

  #settle(rid: string, from: readonly ReservationState[], u: Usage, at: string, detail: string, by: string | null): Reservation {
    tokens(u.inputTokens, 'input tokens'); tokens(u.outputTokens, 'output tokens'); nanos(u.costNanos, 'cost');
    const before = this.#row(rid);
    const out = this.#move(rid, from, 'settled', detail, at, ', used_input = ?, used_output = ?, used_cost_nanos = ?, reconciled_by = ?',
      u.inputTokens, u.outputTokens, u.costNanos, by);
    // Any call above its own reservation broke the per-call bound: the envelope takes no further call, even with room left.
    const overrun = u.inputTokens + u.outputTokens > before.tokens || u.costNanos > before.costNanos;
    if (overrun) this.#event(rid, 'settled', 'settled', 'overrun: reported usage above the reservation', at);
    const t = this.#totals(before.envelopeId);
    if (overrun || t.chargedTokens > t.maxTokens || t.chargedCostNanos > t.maxCostNanos) this.#run('UPDATE envelopes SET overdrawn = 1 WHERE id = ?', before.envelopeId);
    return out;
  }

  /** Charges a dispatched call at its reported usage. More than reserved is charged in full and overdraws the envelope. */
  settle(rid: string, u: Usage, at: string): Reservation { return this.#tx(() => this.#settle(rid, ['dispatched'], u, at, 'reported usage', null)); }

  /** Settles an uncertain call at usage the owner established, naming the authority (a spent receipt's digest). */
  reconcile(rid: string, u: Usage, authority: string, at: string): Reservation {
    if (typeof authority !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(authority)) fail('sentinel.provider.reservationState', 'reconciliation names its authority');
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
      for (const e of staleEpochs) this.#run('INSERT OR IGNORE INTO fenced_epochs (epoch, fenced_at) VALUES (?, ?)', e, at);
      let released = 0;
      let uncertain = 0;
      for (const e of staleEpochs) {
        for (const r of this.#all("SELECT id, state FROM reservations WHERE epoch = ? AND state IN ('held','dispatched')", e)) {
          if (r.state === 'held') { this.#move(r.id as string, ['held'], 'released', 'recovered: never sent', at); released++; }
          else { this.#move(r.id as string, ['dispatched'], 'uncertain', 'recovered: may have been sent', at); uncertain++; }
        }
      }
      return { released, uncertain };
    });
  }

  /** Whether recovery fenced this epoch. */
  isFenced(epoch: string): boolean { id(epoch, 'an epoch'); return this.#tx(() => this.#fenced(epoch)); }

  /** The reservation an operation made under an envelope, if any. */
  reservationOf(envelopeId: string, operationId: string): Reservation | null {
    return this.#tx(() => {
      const r = this.#get('SELECT id FROM reservations WHERE envelope_id = ? AND operation_id = ?', envelopeId, operationId);
      return r ? this.#row(r.id as string) : null;
    });
  }

  /** Envelopes, newest first, at most `limit` (1–200), optionally for one run. */
  listEnvelopes(options: { runId?: string; limit: number }): { id: string; runId: string; providerId: string | null; bindingDigest: string; receiptDigest: string | null; currency: string; createdAt: string; totals: EnvelopeTotals }[] {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200) fail('sentinel.provider.ledgerInvalid', 'list 1–200 envelopes');
    if (options.runId !== undefined) id(options.runId, 'the run');
    return this.#tx(() => {
      const rows = options.runId === undefined
        ? this.#all('SELECT * FROM envelopes ORDER BY created_at DESC, id LIMIT ?', options.limit)
        : this.#all('SELECT * FROM envelopes WHERE run_id = ? ORDER BY created_at DESC, id LIMIT ?', options.runId, options.limit);
      return rows.map(r => ({ id: r.id as string, runId: r.run_id as string, providerId: (r.provider_id as string | null) ?? null, bindingDigest: r.binding_digest as string, receiptDigest: (r.receipt_digest as string | null) ?? null,
        currency: r.currency as string, createdAt: r.created_at as string, totals: this.#totals(r.id as string) }));
    });
  }

  /** Held, dispatched and uncertain reservations of one envelope, at most `limit` (1–1000). */
  openReservations(envelopeId: string, limit: number): Reservation[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('sentinel.provider.ledgerInvalid', 'list 1–1000 reservations');
    return this.#tx(() => this.#all("SELECT id FROM reservations WHERE envelope_id = ? AND state IN ('held','dispatched','uncertain') ORDER BY created_at, id LIMIT ?", envelopeId, limit)
      .map(r => this.#row(r.id as string)));
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
    if (typeof body !== 'string' || Buffer.byteLength(body) > 4 * 1024 * 1024) fail('sentinel.provider.ledgerInvalid', 'a checkpoint is at most 4 MiB');
    return this.#tx(() => {
      this.#assertLive(epoch);
      const prior = this.#get('SELECT epoch, sequence FROM review_checkpoints WHERE session_id = ?', sessionId);
      if (prior && prior.epoch !== epoch && !this.#fenced(prior.epoch as string)) fail('sentinel.provider.epochFenced', 'another live epoch owns this session');
      const sequence = prior ? Number(prior.sequence) + 1 : 1;
      this.#run('INSERT INTO review_checkpoints (session_id, epoch, sequence, body, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET epoch = excluded.epoch, sequence = excluded.sequence, body = excluded.body, updated_at = excluded.updated_at',
        sessionId, epoch, sequence, body, at);
      return sequence;
    });
  }

  /** Every state change of one reservation, oldest first. */
  events(rid: string): { from: ReservationState | null; to: ReservationState; detail: string; at: string }[] {
    return this.#all('SELECT from_state, to_state, detail, at FROM reservation_events WHERE reservation_id = ? ORDER BY seq', rid)
      .map(r => ({ from: (r.from_state as ReservationState | null) ?? null, to: r.to_state as ReservationState, detail: r.detail as string, at: r.at as string }));
  }
}
