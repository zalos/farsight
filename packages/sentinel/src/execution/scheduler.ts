// The scheduler: pure decisions over a plan's work DAG and the ledger's committed state. No I/O here, so every
// decision is reproducible from (plan, committed state, reservations) and testable without a process.
//
// - Readiness: a work unit may start when every dependency is published. A dependency that failed for good, or
//   is itself blocked, blocks its dependents; that is a derived decision with a reason, never a fake attempt.
// - Reservations: a bounded pool of worker slots, memory and CPUs. A unit is admitted only when its limits fit what
//   is not already reserved; the pool's capacity can only be lower than the accepted ceilings.
// - Retry: an attempt that ended for a retryable reason is tried again up to a bounded number of attempts; an
//   integrity, isolation or input failure is never retried, since repeating it cannot change the answer.
import type { Id, WorkRef } from '../contracts/common.js';
import type { WorkEnvelope } from '../contracts/work.js';
import { ExecutionError, type ExecutionErrorCode } from './errors.js';
import { ACCEPTED_CEILINGS } from './registry.js';

export type UnitState = 'waiting' | 'ready' | 'running' | 'published' | 'failed' | 'blocked' | 'disabled';

/** What the ledger has committed about one plan unit (absent from the ledger: not created yet). */
export interface CommittedUnit {
  created: boolean;
  /** The ledger's work state, when created. */
  workState?: string;
  /** Attempts started so far for this revision. */
  attempts: number;
  /** The last ended attempt's reason, when it did not publish. */
  lastFailure?: ExecutionErrorCode | string;
}

export interface UnitDecision {
  ref: WorkRef;
  state: UnitState;
  reason?: string;
}

/** Reasons a retry can change. Everything else (integrity, isolation, input, protocol) is final. */
export const RETRYABLE: ReadonlySet<string> = new Set<string>([
  'sentinel.execution.deadlineExceeded', 'sentinel.execution.workerExited', 'sentinel.execution.resourceExceeded',
  'sentinel.execution.commandFailed',
]);

export interface RetryPolicy {
  /** Attempts per work revision, including the first (1–5). */
  maxAttempts: number;
}

export const DEFAULT_RETRY: Readonly<RetryPolicy> = Object.freeze({ maxAttempts: 3 });

export function checkRetryPolicy(p: RetryPolicy): RetryPolicy {
  if (!Number.isInteger(p.maxAttempts) || p.maxAttempts < 1 || p.maxAttempts > 5) {
    throw new ExecutionError('sentinel.execution.planInvalid', { reason: 'retry maxAttempts is 1 to 5' });
  }
  return p;
}

/** Whether an attempt that ended with `code` should leave its work ready for another attempt. */
export function retryable(code: string | undefined, attemptsSoFar: number, policy: RetryPolicy): boolean {
  return code !== undefined && RETRYABLE.has(code) && attemptsSoFar < policy.maxAttempts;
}

const key = (r: WorkRef) => `${r.id}@${r.revision}`;

/**
 * Validate the plan's DAG: unique revisions, dependencies inside the plan, no cycle. Returns a topological order.
 * A plan that fails here is refused before anything is written.
 */
export function orderPlan(works: readonly WorkEnvelope[], external: ReadonlySet<string> = new Set()): WorkEnvelope[] {
  const byKey = new Map<string, WorkEnvelope>();
  for (const w of works) {
    if (byKey.has(key(w))) throw new ExecutionError('sentinel.execution.planInvalid', { reason: `work ${key(w)} is listed twice` });
    byKey.set(key(w), w);
  }
  const order: WorkEnvelope[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (w: WorkEnvelope, depth: number) => {
    const k = key(w);
    if (state.get(k) === 'done') return;
    if (state.get(k) === 'visiting' || depth > works.length) throw new ExecutionError('sentinel.execution.planInvalid', { reason: `the plan has a cycle through ${k}` });
    state.set(k, 'visiting');
    for (const d of w.dependencies) {
      // Published work of an earlier revision the plan reuses (checked published when the plan is opened).
      if (external.has(key(d))) continue;
      const dep = byKey.get(key(d));
      if (!dep) throw new ExecutionError('sentinel.execution.planInvalid', { reason: `work ${k} depends on ${key(d)}, which is not in the plan` });
      visit(dep, depth + 1);
    }
    state.set(k, 'done');
    order.push(w);
  };
  for (const w of works) visit(w, 0);
  return order;
}

/** Every unit's state from the plan and what the ledger committed. Pure; the coordinator acts on it. */
export function decide(works: readonly WorkEnvelope[], committed: ReadonlyMap<string, CommittedUnit>, policy: RetryPolicy,
  external: ReadonlySet<string> = new Set()): UnitDecision[] {
  const order = orderPlan(works, external);
  const out = new Map<string, UnitDecision>();
  for (const w of order) {
    const ref = { id: w.id, revision: w.revision };
    const c = committed.get(key(ref));
    const deps = w.dependencies.filter(d => !external.has(key(d))).map(d => out.get(key(d))!);
    if (c?.workState === 'published') { out.set(key(ref), { ref, state: 'published' }); continue; }
    if (c?.workState === 'running') { out.set(key(ref), { ref, state: 'running' }); continue; }
    if (c?.workState === 'disabled-by-policy') { out.set(key(ref), { ref, state: 'disabled', reason: 'disabled by policy' }); continue; }
    if (c?.workState === 'blocked') { out.set(key(ref), { ref, state: 'blocked', reason: 'held in the ledger' }); continue; }
    if (c?.workState === 'failed' || (c?.created && c.workState === 'ready' && c.attempts >= policy.maxAttempts)) {
      out.set(key(ref), { ref, state: 'failed', reason: String(c.lastFailure ?? 'sentinel.execution.workerExited') }); continue;
    }
    const blocker = deps.find(d => d.state === 'failed' || d.state === 'blocked' || d.state === 'disabled');
    if (blocker) { out.set(key(ref), { ref, state: 'blocked', reason: `dependency ${key(blocker.ref)} ${blocker.state}` }); continue; }
    out.set(key(ref), { ref, state: deps.every(d => d.state === 'published') ? 'ready' : 'waiting' });
  }
  return works.map(w => out.get(key({ id: w.id, revision: w.revision }))!);
}

export interface Capacity {
  slots: number;
  memoryBytes: number;
  cpus: number;
}

/** One heavy scanner at a time with the accepted ceilings (feasibility-decisions scannerConcurrency 1). */
export const DEFAULT_CAPACITY: Readonly<Capacity> = Object.freeze({
  slots: 1, memoryBytes: ACCEPTED_CEILINGS.memoryBytes, cpus: ACCEPTED_CEILINGS.cpus,
});

export interface Reservation { readonly id: Id; readonly memoryBytes: number; readonly cpus: number }

/** A bounded admission pool. Reservations are explicit and released exactly once. */
export class ReservationPool {
  readonly capacity: Readonly<Capacity>;
  #held = new Map<Id, Reservation>();

  constructor(capacity: Capacity = DEFAULT_CAPACITY) {
    for (const [k, v] of Object.entries(capacity)) {
      if (!Number.isInteger(v) || v < 1) throw new ExecutionError('sentinel.execution.planInvalid', { reason: `capacity ${k}` });
    }
    this.capacity = Object.freeze({ ...capacity });
  }

  get held(): number { return this.#held.size; }

  /** Admit a unit if its limits fit what is free; a unit larger than the whole pool can never run, and is refused. */
  tryReserve(id: Id, need: { memoryBytes: number; cpus: number }): Reservation | null {
    if (need.memoryBytes > this.capacity.memoryBytes || need.cpus > this.capacity.cpus) {
      throw new ExecutionError('sentinel.execution.resourceExceeded', { reason: 'larger than the admission capacity' });
    }
    if (this.#held.has(id)) return null;
    let memory = 0, cpus = 0;
    for (const r of this.#held.values()) { memory += r.memoryBytes; cpus += r.cpus; }
    if (this.#held.size + 1 > this.capacity.slots || memory + need.memoryBytes > this.capacity.memoryBytes || cpus + need.cpus > this.capacity.cpus) return null;
    const r = Object.freeze({ id, memoryBytes: need.memoryBytes, cpus: need.cpus });
    this.#held.set(id, r);
    return r;
  }

  release(r: Reservation): void { this.#held.delete(r.id); }
}
