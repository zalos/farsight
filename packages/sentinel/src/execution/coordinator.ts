// The coordinator: one plan revision executed against a store opened through openStore(), durably, so that a
// crash at any point can be finished by a later coordinator with no lost and no duplicate accepted output.
//
// Every decision is made from the ledger's committed state (scheduler.ts) and every effect goes through it:
// a work revision is created when it becomes ready; an attempt is recorded (and so fenced by attempt and epoch)
// after its worker exists and before it may act; a result is published through staging (publication.ts); a failure
// ends the attempt, leaving the work ready for a bounded retry or failed. Pause stops admitting new work while
// in-flight attempts may still finish and publish; cancel stops the workers and the ledger then refuses any
// publication for the run. The plan comes from PR 06 through PlanBoundary; this module does not plan.
import { createHash } from 'node:crypto';
import type { Id, WorkRef } from '../contracts/common.js';
import type { RunEnvelope, RunOutcome, RunState } from '../contracts/run.js';
import type { WorkEnvelope } from '../contracts/work.js';
import type { SentinelStore } from '../store/index.js';
import { LedgerError } from '../store/store-types.js';
import { ExecutionError, isExecutionError } from './errors.js';
import { publishOutcome, PUBLICATION_BOUNDARIES, type BoundaryContext } from './publication.js';
import { IntentFiles, readHistory, recoverStore, type LedgerHistory, type RecoveryReport } from './recovery.js';
import { TRUSTED_ADAPTERS, type AdapterRegistry } from './registry.js';
import {
  checkRetryPolicy, decide, DEFAULT_CAPACITY, DEFAULT_RETRY, orderPlan, ReservationPool, retryable,
  type Capacity, type CommittedUnit, type RetryPolicy, type UnitDecision,
} from './scheduler.js';
import { createExecutionService, type ExecutionService } from './service.js';
import { releaseWorkDir, type CapturedInput, type WorkerOutcome } from './supervisor.js';

/** What PR 06's planner hands the coordinator: canonical envelopes plus the two lookups execution needs. */
export interface PlanBoundary {
  readonly run: RunEnvelope;
  readonly works: readonly WorkEnvelope[];
  /** The trusted adapter that executes this work's stage. */
  adapterFor(work: WorkEnvelope): Id;
  /** The captured inputs the work's input fingerprint covers. */
  inputsFor(work: WorkEnvelope): readonly CapturedInput[];
}

export const COORDINATOR_BOUNDARIES = ['after-attempt-start', ...PUBLICATION_BOUNDARIES] as const;
export type CoordinatorBoundary = typeof COORDINATOR_BOUNDARIES[number];

/** Test seam (deterministic crash injection). Production passes none. */
export interface CoordinatorHooks {
  at?(boundary: CoordinatorBoundary, context: BoundaryContext): void;
}

export interface CoordinatorOptions {
  store: SentinelStore;
  plan: PlanBoundary;
  /** A private, canonical folder for attempt work folders. */
  scratchRoot: string;
  registry?: AdapterRegistry;
  containers?: boolean;
  capacity?: Capacity;
  retry?: RetryPolicy;
  hooks?: CoordinatorHooks;
}

export interface UnitFailure { work: WorkRef; attemptId: Id | null; code: string; detail?: Readonly<Record<string, unknown>> }

export interface RunSummary {
  runId: Id;
  state: RunState;
  outcome?: RunOutcome;
  units: UnitDecision[];
  failures: UnitFailure[];
  recovery: RecoveryReport;
  /** Accepted publications for this plan's work revisions, counted from the ledger. */
  published: number;
}

const key = (r: WorkRef) => `${r.id}@${r.revision}`;
const now = () => new Date().toISOString();
const attemptIdFor = (ref: WorkRef, ordinal: number): Id =>
  `att-${createHash('sha256').update(`${ref.id}@${ref.revision}#${ordinal}`).digest('hex').slice(0, 40)}`;

export class Coordinator {
  readonly #store: SentinelStore;
  readonly #plan: PlanBoundary;
  readonly #service: ExecutionService;
  readonly #journal: IntentFiles;
  readonly #pool: ReservationPool;
  readonly #retry: RetryPolicy;
  readonly #hooks?: CoordinatorHooks;
  readonly #registry: AdapterRegistry;
  readonly #cancel = new AbortController();
  readonly #failures: UnitFailure[] = [];
  /** Units that failed without an attempt in the ledger (refused before the worker existed). */
  readonly #failedUnstarted = new Map<string, string>();
  readonly #stale = new Map<string, Id>();
  readonly recovery: RecoveryReport;
  #history: LedgerHistory;
  #pauseRequested = false;
  #cancelRequested = false;
  /** Set when this coordinator completed the run; the ledger's events do not carry the outcome. */
  #outcome: RunOutcome | undefined;

  private constructor(o: CoordinatorOptions, service: ExecutionService, journal: IntentFiles, history: LedgerHistory, recovery: RecoveryReport) {
    this.#store = o.store; this.#plan = o.plan; this.#service = service; this.#journal = journal;
    this.#pool = new ReservationPool(o.capacity ?? DEFAULT_CAPACITY);
    this.#retry = checkRetryPolicy(o.retry ?? DEFAULT_RETRY);
    this.#registry = o.registry ?? TRUSTED_ADAPTERS;
    if (o.hooks) this.#hooks = o.hooks;
    this.#history = history;
    this.recovery = recovery;
    for (const s of recovery.staleAttempts) this.#stale.set(key(s.work), s.attemptId);
  }

  /** Validate the plan, bind to the store, and recover whatever an earlier epoch left. Starts no new work. */
  static async open(o: CoordinatorOptions): Promise<Coordinator> {
    o.store.assertHeld();
    orderPlan(o.plan.works);
    for (const w of o.plan.works) {
      if (w.runId !== o.plan.run.id || w.planRevision !== o.plan.run.planRevision) {
        throw new ExecutionError('sentinel.execution.planInvalid', { reason: `work ${key(w)} belongs to another run or plan revision` });
      }
    }
    const service = await createExecutionService(o.store, { scratchRoot: o.scratchRoot, ...(o.registry ? { registry: o.registry } : {}), ...(o.containers ? { containers: true } : {}) });
    const journal = new IntentFiles(o.store.storePath);
    const history = readHistory(o.store);
    const recovery = await recoverStore(o.store, { journal, history, ...(service.backend ? { backend: service.backend } : {}) });
    return new Coordinator(o, service, journal, readHistory(o.store), recovery);
  }

  /** Stop admitting new work; attempts in flight may finish and publish. The run becomes paused once they end. */
  pause(): void {
    this.#pauseRequested = true;
    if (this.#runState() === 'running') this.#store.ledger.setRunState(this.#plan.run.id, 'pausing');
  }

  /** Stop every worker; from now the ledger refuses publication for this run. */
  cancel(): void {
    this.#cancelRequested = true;
    const s = this.#runState();
    if (s && s !== 'canceling' && s !== 'canceled' && s !== 'completed') this.#store.ledger.setRunState(this.#plan.run.id, 'canceling');
    this.#cancel.abort();
  }

  /** The plan's units as the ledger has them now. */
  progress(): UnitDecision[] {
    return decide(this.#plan.works, this.#committed(), this.#retry);
  }

  /** Execute (or resume) the run until it completes, pauses or is canceled. */
  async run(): Promise<RunSummary> {
    const runId = this.#plan.run.id;
    let state = this.#runState();
    if (state === undefined) {
      this.#store.ledger.createRun({ ...this.#plan.run, state: 'running', coordinatorEpoch: this.#store.epoch } as RunEnvelope);
    } else if (state === 'completed' || state === 'canceled') {
      return this.#summary();
    } else if (state === 'canceling') {
      this.#cancelRequested = true;
    } else {
      // planned, paused, or a pause an earlier epoch did not finish: run() resumes.
      if (state === 'pausing') { this.#store.ledger.setRunState(runId, 'paused'); state = 'paused'; }
      if ((state === 'planned' || state === 'paused') && !this.#pauseRequested && !this.#cancelRequested) this.#store.ledger.setRunState(runId, 'running');
    }
    this.#pauseRequested = false;

    const inflight = new Map<string, Promise<void>>();
    for (;;) {
      const decisions = this.progress();
      const admitting = !this.#pauseRequested && !this.#cancelRequested && this.#runState() === 'running';
      let admitted = 0;
      if (admitting) {
        for (const d of decisions) {
          if (d.state !== 'ready' && !(d.state === 'running' && this.#stale.has(key(d.ref)))) continue;
          if (inflight.has(key(d.ref))) continue;
          const work = this.#plan.works.find(w => w.id === d.ref.id && w.revision === d.ref.revision)!;
          const limits = this.#registry.get(this.#plan.adapterFor(work)).limits;
          const reservation = this.#pool.tryReserve(key(d.ref), { memoryBytes: limits.memoryBytes, cpus: limits.cpus });
          if (!reservation) break;
          const task = this.#unit(work).finally(() => { this.#pool.release(reservation); inflight.delete(key(d.ref)); });
          inflight.set(key(d.ref), task);
          admitted++;
        }
      }
      if (inflight.size === 0) {
        if (this.#cancelRequested) { this.#finishRunState('canceled'); break; }
        if (this.#pauseRequested || this.#runState() === 'pausing') { this.#finishRunState('paused'); break; }
        const final = this.progress();
        if (final.every(d => ['published', 'failed', 'blocked'].includes(d.state))) {
          const outcome: RunOutcome = final.every(d => d.state === 'published') ? 'complete-coverage' : 'execution-failure';
          this.#store.ledger.setRunState(runId, 'completed', { outcome });
          this.#outcome = outcome;
          break;
        }
        // Not finished, nothing in flight and nothing admitted: stop rather than spin; the summary shows what waits.
        if (!admitting || admitted === 0) break;
      } else {
        await Promise.race(inflight.values());
      }
    }
    return this.#summary();
  }

  #finishRunState(to: 'paused' | 'canceled'): void {
    const s = this.#runState();
    if (to === 'paused' && s === 'running') this.#store.ledger.setRunState(this.#plan.run.id, 'pausing');
    if (to === 'canceled' && s !== 'canceling' && s !== 'canceled') this.#store.ledger.setRunState(this.#plan.run.id, 'canceling');
    if (this.#runState() !== to) this.#store.ledger.setRunState(this.#plan.run.id, to);
  }

  /** One attempt of one unit, from creating its work revision to publishing or ending it. Never throws. */
  async #unit(work: WorkEnvelope): Promise<void> {
    const ref: WorkRef = { id: work.id, revision: work.revision };
    const supersede = this.#stale.get(key(ref));
    let attemptId: Id | null = null;
    let outcome: WorkerOutcome | undefined;
    try {
      if (!this.#store.ledger.getWork(ref)) {
        this.#store.ledger.createWork({ ...work, state: 'ready', activeAttemptId: null, coordinatorEpoch: this.#store.epoch, createdAt: now() } as WorkEnvelope);
      }
      const ordinal = (this.#history.attemptCount.get(key(ref)) ?? 0) + 1;
      const id = attemptIdFor(ref, ordinal);
      outcome = await this.#service.run({
        adapterId: this.#plan.adapterFor(work), attemptId: id, work: ref, inputs: this.#plan.inputsFor(work),
        signal: this.#cancel.signal, intents: this.#journal,
        onWorker: worker => {
          this.#store.ledger.startAttempt({
            schema: 'sentinel-attempt/draft-1', id, work: ref, ordinal, coordinatorEpoch: this.#store.epoch, operationId: id,
            worker, startedAt: now(), usage: { certainty: 'not-applicable' }, state: 'running',
          }, { supersede: supersede !== undefined });
          attemptId = id;
          this.#history.attemptCount.set(key(ref), ordinal);
          this.#stale.delete(key(ref));
          this.#hooks?.at?.('after-attempt-start', { work: ref, attemptId: id });
        },
      });
      if (outcome.state === 'succeeded' && attemptId) {
        try {
          await publishOutcome({ store: this.#store, work: ref, attemptId, result: outcome.result!, outputs: outcome.outputs, endedAt: now(),
            ...(this.#hooks ? { hooks: { at: (b, c) => this.#hooks!.at?.(b, c) } } : {}) });
        } catch (error) {
          const canceled = error instanceof LedgerError && error.code === 'sentinel.store.wrongState';
          this.#end(ref, attemptId, canceled ? 'canceled' : 'failed', canceled ? 'sentinel.execution.canceled' : codeOf(error), detailOf(error));
        }
      } else if (attemptId) {
        this.#end(ref, attemptId, outcome.state === 'canceled' ? 'canceled' : 'failed', outcome.code ?? 'sentinel.execution.workerExited', outcome.detail);
      } else {
        this.#unstarted(ref, outcome.code ?? 'sentinel.execution.workerExited', outcome.detail);
      }
    } catch (error) {
      if (attemptId) this.#end(ref, attemptId, 'failed', codeOf(error), detailOf(error));
      else this.#unstarted(ref, codeOf(error), detailOf(error));
    } finally {
      if (outcome) { try { releaseWorkDir(outcome.workDir); } catch { /* left for an explicit cleanup */ } }
    }
  }

  #end(ref: WorkRef, attemptId: Id, state: 'failed' | 'canceled', code: string, detail?: Readonly<Record<string, unknown>>): void {
    this.#failures.push({ work: ref, attemptId, code, ...(detail ? { detail } : {}) });
    const attempts = this.#history.attemptCount.get(key(ref)) ?? 1;
    // A canceled attempt leaves its work ready: cancellation is the run's decision, not the work's failure.
    const workState = state === 'canceled' || retryable(code, attempts, this.#retry) ? 'ready' : 'failed';
    try {
      this.#store.ledger.endAttempt({ work: ref, attemptId, state, endedAt: now(), workState });
    } catch (error) {
      // Fenced off (a newer epoch, or the attempt already ended): that coordinator's recovery owns it now.
      this.#failures.push({ work: ref, attemptId, code: codeOf(error) });
    }
  }

  #unstarted(ref: WorkRef, code: string, detail?: Readonly<Record<string, unknown>>): void {
    this.#failures.push({ work: ref, attemptId: null, code, ...(detail ? { detail } : {}) });
    // Refused before any worker acted (an unknown adapter, a mismatched input, a pending create): not retried here.
    if (!this.#cancelRequested && !this.#pauseRequested) this.#failedUnstarted.set(key(ref), code);
  }

  #committed(): Map<string, CommittedUnit> {
    const m = new Map<string, CommittedUnit>();
    for (const w of this.#plan.works) {
      const ref = { id: w.id, revision: w.revision };
      const row = this.#store.ledger.getWork(ref);
      const unstarted = this.#failedUnstarted.get(key(ref));
      const attempts = this.#history.attemptCount.get(key(ref)) ?? 0;
      if (unstarted) { m.set(key(ref), { created: !!row, workState: 'failed', attempts, lastFailure: unstarted }); continue; }
      m.set(key(ref), row ? { created: true, workState: row.state, attempts } : { created: false, attempts });
    }
    return m;
  }

  #runState(): RunState | undefined {
    this.#history = readHistory(this.#store);
    return this.#history.runs.get(this.#plan.run.id) as RunState | undefined;
  }

  #summary(): RunSummary {
    const units = this.progress();
    const state = this.#runState() ?? 'planned';
    let published = 0;
    for (const w of this.#plan.works) if (this.#store.ledger.getPublication({ id: w.id, revision: w.revision })) published++;
    return { runId: this.#plan.run.id, state, ...(this.#outcome ? { outcome: this.#outcome } : {}), units, failures: [...this.#failures], recovery: this.recovery, published };
  }
}

const codeOf = (e: unknown): string => (isExecutionError(e) || e instanceof LedgerError ? e.code : (e as { code?: string })?.code) ?? 'sentinel.execution.workerExited';
const detailOf = (e: unknown): Readonly<Record<string, unknown>> | undefined => (isExecutionError(e) ? e.detail : undefined);
