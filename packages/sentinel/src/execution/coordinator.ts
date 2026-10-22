// The coordinator: one plan revision executed against a store opened through openStore(), durably, so that a
// crash at any point can be finished by a later coordinator with no lost and no duplicate accepted output.
//
// Every decision is made from the ledger's typed, committed state (getRun, getWork, listAttempts; scheduler.ts)
// and every effect goes through it: a work revision is created when it becomes ready, or held (blocked by a failed
// dependency, disabled by policy) with its reason; an attempt is recorded (and so fenced by attempt and epoch)
// after its worker exists and before it may act; a result is published through staging (publication.ts); a failure
// ends the attempt with its recorded error, leaving the work ready for a bounded retry or failed. Each attempt runs
// under its work's resource policy intersected with the adapter's limits. Pause stops admitting new work while
// in-flight attempts may still finish and publish; cancel stops the workers and the ledger then refuses any
// publication for the run. The plan comes from PR 06 through PlanBoundary; this module does not plan.
import { createHash } from 'node:crypto';
import type { CatalogKey, Id, WorkRef } from '../contracts/common.js';
import type { RunEnvelope, RunOutcome, RunState } from '../contracts/run.js';
import type { WorkEnvelope } from '../contracts/work.js';
import type { SentinelStore } from '../store/index.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { LedgerError } from '../store/store-types.js';
import { ExecutionError, isExecutionError } from './errors.js';
import { publishOutcome, PUBLICATION_BOUNDARIES, type BoundaryContext } from './publication.js';
import { IntentFiles, recoverStore, WorkerFiles, type RecoveryReport } from './recovery.js';
import { effectiveLimits, TRUSTED_ADAPTERS, type AdapterRegistry } from './registry.js';
import {
  checkRetryPolicy, decide, DEFAULT_CAPACITY, DEFAULT_RETRY, orderPlan, ReservationPool, retryable,
  type Capacity, type CommittedUnit, type RetryPolicy, type UnitDecision,
} from './scheduler.js';
import { createExecutionService, type ExecutionService } from './service.js';
import { releaseWorkDir, type CapturedInput, type WorkerOutcome } from './supervisor.js';

/** What PR 06's planner hands the coordinator: canonical envelopes plus the two lookups execution needs. */
export interface PlanBoundary {
  readonly run: RunEnvelope;
  /** Each pending or ready, or held (blocked / disabled-by-policy, with its reasonCode) by the plan itself. */
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
  /** Accepted publications for this plan's work revisions, read from the ledger. */
  published: number;
  /** False while recovery holds an obligation, a pending intent, an unreadable journal record or an uncertain container. */
  clean: boolean;
}

const key = (r: WorkRef) => `${r.id}@${r.revision}`;
const now = () => new Date().toISOString();
const attemptIdFor = (ref: WorkRef, ordinal: number): Id =>
  `att-${createHash('sha256').update(`${ref.id}@${ref.revision}#${ordinal}`).digest('hex').slice(0, 40)}`;
const MAX_DETAIL_BYTES = 3_072;
const DEPENDENCY_FAILED: CatalogKey = 'sentinel.execution.dependencyFailed';

export class Coordinator {
  readonly #store: SentinelStore;
  readonly #plan: PlanBoundary;
  readonly #service: ExecutionService;
  readonly #intents: IntentFiles;
  readonly #workers: WorkerFiles;
  readonly #pool: ReservationPool;
  readonly #retry: RetryPolicy;
  readonly #hooks?: CoordinatorHooks;
  readonly #registry: AdapterRegistry;
  readonly #cancel = new AbortController();
  readonly #failures: UnitFailure[] = [];
  /** Units refused before any worker existed (no attempt in the ledger): not retried in this coordinator. */
  readonly #failedUnstarted = new Map<string, string>();
  readonly recovery: RecoveryReport;
  #pauseRequested = false;
  #cancelRequested = false;

  private constructor(o: CoordinatorOptions, service: ExecutionService, intents: IntentFiles, workers: WorkerFiles, recovery: RecoveryReport) {
    this.#store = o.store; this.#plan = o.plan; this.#service = service; this.#intents = intents; this.#workers = workers;
    this.#pool = new ReservationPool(o.capacity ?? DEFAULT_CAPACITY);
    this.#retry = checkRetryPolicy(o.retry ?? DEFAULT_RETRY);
    this.#registry = o.registry ?? TRUSTED_ADAPTERS;
    if (o.hooks) this.#hooks = o.hooks;
    this.recovery = recovery;
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
    const intents = new IntentFiles(o.store.storePath);
    const workers = new WorkerFiles(o.store.storePath);
    const recovery = await recoverStore(o.store, { intents, workers, ...(service.backend ? { backend: service.backend } : {}) });
    return new Coordinator(o, service, intents, workers, recovery);
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
      this.#persistHolds(decisions);
      const admitting = !this.#pauseRequested && !this.#cancelRequested && this.#runState() === 'running';
      let admitted = 0;
      if (admitting) {
        for (const d of decisions) {
          if (d.state !== 'ready' || inflight.has(key(d.ref))) continue;
          const work = this.#work(d.ref);
          const limits = effectiveLimits(this.#registry.get(this.#plan.adapterFor(work)).limits, work.resources);
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
        if (final.every(d => ['published', 'failed', 'blocked', 'disabled'].includes(d.state))) {
          this.#persistHolds(final);
          const outcome: RunOutcome = final.every(d => d.state === 'published') ? 'complete-coverage'
            : final.every(d => d.state === 'published' || d.state === 'disabled') ? 'partial-coverage' : 'execution-failure';
          this.#store.ledger.setRunState(runId, 'completed', { outcome });
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

  /** Record in the ledger each hold the plan or the scheduler decided: disabled by policy, blocked by a dependency. */
  #persistHolds(decisions: UnitDecision[]): void {
    const runState = this.#runState();
    if (runState === 'completed' || runState === 'canceled' || runState === undefined) return;
    for (const d of decisions) {
      if (d.state !== 'blocked' && d.state !== 'disabled') continue;
      const want = d.state === 'disabled' ? 'disabled-by-policy' : 'blocked';
      let row = this.#store.ledger.getWork(d.ref);
      if (row?.state === want) continue;
      const work = this.#work(d.ref);
      // A revision names its dependencies, which must already be in the ledger; a later pass records it then.
      if (!row && work.dependencies.some(dep => !this.#store.ledger.getWork(dep))) continue;
      if (!row) { this.#create(work, 'pending'); row = this.#store.ledger.getWork(d.ref)!; }
      const reason = want === 'disabled-by-policy' ? planReason(work) ?? 'sentinel.execution.planInvalid' : DEPENDENCY_FAILED;
      if (['pending', 'ready', 'blocked'].includes(row.state)) this.#store.ledger.setWorkState(d.ref, want, { reasonCode: reason });
    }
  }

  #finishRunState(to: 'paused' | 'canceled'): void {
    const s = this.#runState();
    if (to === 'paused' && s === 'running') this.#store.ledger.setRunState(this.#plan.run.id, 'pausing');
    if (to === 'canceled' && s !== 'canceling' && s !== 'canceled') this.#store.ledger.setRunState(this.#plan.run.id, 'canceling');
    if (this.#runState() !== to) this.#store.ledger.setRunState(this.#plan.run.id, to);
  }

  /** Create a plan unit's revision in the ledger under this epoch; a plan-held unit is created pending, then held. */
  #create(work: WorkEnvelope, state: 'pending' | 'ready'): void {
    const { reasonCode: _held, ...rest } = work as WorkEnvelope & { reasonCode?: string };
    void _held;
    this.#store.ledger.createWork({ ...rest, state, activeAttemptId: null, coordinatorEpoch: this.#store.epoch, createdAt: now() } as WorkEnvelope);
  }

  /** One attempt of one unit, from creating its work revision to publishing or ending it. Never throws. */
  async #unit(work: WorkEnvelope): Promise<void> {
    const ref: WorkRef = { id: work.id, revision: work.revision };
    let attemptId: Id | null = null;
    let outcome: WorkerOutcome | undefined;
    try {
      const row = this.#store.ledger.getWork(ref);
      if (!row) this.#create(work, 'ready');
      else if (row.state === 'pending') this.#store.ledger.setWorkState(ref, 'ready');
      const ordinal = this.#store.ledger.listAttempts(ref).length + 1;
      const id = attemptIdFor(ref, ordinal);
      outcome = await this.#service.run({
        adapterId: this.#plan.adapterFor(work), attemptId: id, work: ref, inputs: this.#plan.inputsFor(work),
        signal: this.#cancel.signal, intents: this.#intents, workers: this.#workers, resources: work.resources,
        onWorker: worker => {
          this.#store.ledger.startAttempt({
            schema: 'sentinel-attempt/draft-1', id, work: ref, ordinal, coordinatorEpoch: this.#store.epoch, operationId: id,
            worker, startedAt: now(), usage: { certainty: 'not-applicable' }, state: 'running',
          });
          attemptId = id;
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
    let attempts = 1;
    try { attempts = this.#store.ledger.listAttempts(ref).length; } catch { /* the store is gone; the end below fails too */ }
    const again = retryable(code, attempts, this.#retry);
    // A canceled attempt leaves its work ready: cancellation is the run's decision, not the work's failure.
    const workState = state === 'canceled' || again ? 'ready' : 'failed';
    try {
      this.#store.ledger.endAttempt({ work: ref, attemptId, state, endedAt: now(), workState,
        error: { code: catalogCode(code), retryable: again, ...(detail ? { detail: boundedDetail(detail) } : {}) } });
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

  #work(ref: WorkRef): WorkEnvelope {
    return this.#plan.works.find(w => w.id === ref.id && w.revision === ref.revision)!;
  }

  #committed(): Map<string, CommittedUnit> {
    const m = new Map<string, CommittedUnit>();
    for (const w of this.#plan.works) {
      const ref = { id: w.id, revision: w.revision };
      const row = this.#store.ledger.getWork(ref);
      const attempts = row ? this.#store.ledger.listAttempts(ref).length : 0;
      const unstarted = this.#failedUnstarted.get(key(ref));
      const planHold = (w.state === 'disabled-by-policy' || w.state === 'blocked') ? w.state : undefined;
      if (unstarted) { m.set(key(ref), { created: !!row, workState: 'failed', attempts, lastFailure: unstarted }); continue; }
      if (!row && planHold) { m.set(key(ref), { created: false, workState: planHold, attempts: 0 }); continue; }
      m.set(key(ref), row ? { created: true, workState: row.state, attempts } : { created: false, attempts });
    }
    return m;
  }

  #runState(): RunState | undefined {
    return this.#store.ledger.getRun(this.#plan.run.id)?.state;
  }

  #summary(): RunSummary {
    const units = this.progress();
    const run = this.#store.ledger.getRun(this.#plan.run.id);
    let published = 0;
    for (const w of this.#plan.works) if (this.#store.ledger.getPublication({ id: w.id, revision: w.revision })) published++;
    return { runId: this.#plan.run.id, state: run?.state ?? 'planned', ...(run?.outcome ? { outcome: run.outcome } : {}), units,
      failures: [...this.#failures], recovery: this.recovery, published, clean: this.recovery.clean };
  }
}

const CATALOG = /^sentinel\.[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;
const catalogCode = (code: string): string => (CATALOG.test(code) ? code : 'sentinel.execution.workerExited');
const planReason = (w: WorkEnvelope): string | undefined => ('reasonCode' in w && typeof w.reasonCode === 'string' ? w.reasonCode : undefined);
const codeOf = (e: unknown): string => (isExecutionError(e) || e instanceof LedgerError ? e.code : (e as { code?: string })?.code) ?? 'sentinel.execution.workerExited';
const detailOf = (e: unknown): Readonly<Record<string, unknown>> | undefined => (isExecutionError(e) ? e.detail : undefined);

/** The detail as recorded: safe structured context only, cut to a bound rather than refused. */
function boundedDetail(detail: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const plain = JSON.parse(JSON.stringify(detail)) as Record<string, unknown>;
  return canonicalJsonBytes(plain).byteLength <= MAX_DETAIL_BYTES ? plain : { truncated: true, keys: Object.keys(plain).slice(0, 16) };
}
