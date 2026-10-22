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
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, binding_digest TEXT NOT NULL, admission_digest TEXT NOT NULL,
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
CREATE TABLE IF NOT EXISTS reservation_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, reservation_id TEXT NOT NULL REFERENCES reservations(id),
  from_state TEXT, to_state TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL) STRICT;
`;

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
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    db.exec('BEGIN IMMEDIATE');
    try { db.exec(SCHEMA); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); db.close(); throw e; }
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

  /** Records an approved envelope once. Re-creating the same id with other terms is refused. */
  createEnvelope(e: EnvelopeInput): void {
    id(e.id, 'the envelope'); id(e.runId, 'the run'); tokens(e.maxTokens, 'maxTokens'); nanos(e.maxCostNanos, 'maxCost');
    this.#tx(() => {
      const prior = this.#get('SELECT * FROM envelopes WHERE id = ?', e.id);
      if (prior) {
        if (prior.binding_digest !== e.bindingDigest || prior.admission_digest !== e.admissionDigest || BigInt(prior.max_tokens as bigint) !== BigInt(e.maxTokens)
          || prior.max_cost_nanos !== e.maxCostNanos || prior.currency !== e.currency || prior.run_id !== e.runId) {
          fail('sentinel.provider.ledgerInvalid', 'an envelope with this id already has other terms');
        }
        return;
      }
      this.#run('INSERT INTO envelopes (id, run_id, binding_digest, admission_digest, receipt_digest, max_tokens, max_cost_nanos, currency, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        e.id, e.runId, e.bindingDigest, e.admissionDigest, e.receiptDigest, e.maxTokens, e.maxCostNanos, e.currency, e.createdAt);
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
      const prior = this.#get('SELECT id, tokens, cost_nanos FROM reservations WHERE envelope_id = ? AND operation_id = ?', r.envelopeId, r.operationId);
      if (prior) {
        if (Number(prior.tokens) !== r.tokens || prior.cost_nanos !== r.costNanos) fail('sentinel.provider.operationConflict', r.operationId);
        return this.#row(prior.id as string);
      }
      const t = this.#totals(r.envelopeId);
      if (t.overdrawn) fail('sentinel.provider.envelopeOverdrawn', 'an earlier call reported more than it reserved');
      if (t.chargedTokens + r.tokens > t.maxTokens) fail('sentinel.provider.budgetExhausted', `${t.maxTokens - t.chargedTokens} tokens left, ${r.tokens} needed`);
      if (t.chargedCostNanos + r.costNanos > t.maxCostNanos) fail('sentinel.provider.budgetExhausted', 'not enough money left for the worst case');
      const rid = `res-${r.envelopeId.slice(0, 40)}-${r.operationId.slice(0, 60)}`.slice(0, 128);
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
  dispatch(rid: string, at: string): Reservation { return this.#tx(() => this.#move(rid, ['held'], 'dispatched', 'about to send', at)); }

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
    if (u.inputTokens + u.outputTokens > before.tokens || u.costNanos > before.costNanos) this.#event(rid, 'settled', 'settled', 'overrun: reported usage above the reservation', at);
    const t = this.#totals(before.envelopeId);
    if (t.chargedTokens > t.maxTokens || t.chargedCostNanos > t.maxCostNanos) this.#run('UPDATE envelopes SET overdrawn = 1 WHERE id = ?', before.envelopeId);
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

  /** Every state change of one reservation, oldest first. */
  events(rid: string): { from: ReservationState | null; to: ReservationState; detail: string; at: string }[] {
    return this.#all('SELECT from_state, to_state, detail, at FROM reservation_events WHERE reservation_id = ? ORDER BY seq', rid)
      .map(r => ({ from: (r.from_state as ReservationState | null) ?? null, to: r.to_state as ReservationState, detail: r.detail as string, at: r.at as string }));
  }
}
