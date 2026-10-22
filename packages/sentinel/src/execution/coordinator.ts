// The coordinator: one plan revision executed against a store opened through openStore(), durably, so that a
// crash at any point can be finished by a later coordinator with no lost and no duplicate accepted output.
//
// Every decision is made from the ledger's typed, committed state (getRun, getWork, countAttempts; scheduler.ts)
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
import { IntentFiles, recoverStore, UnknownCleanup, WorkerFiles, type RecoveryReport } from './recovery.js';
import type { DockerRunner } from './isolation.js';
import type { ContainerIntent } from './supervisor.js';
import { effectiveLimits, TRUSTED_ADAPTERS, type AdapterRegistry } from './registry.js';
import {
  checkRetryPolicy, decide, DEFAULT_CAPACITY, DEFAULT_RETRY, orderPlan, ReservationPool, retryable,
  type Capacity, type CommittedUnit, type RetryPolicy, type UnitDecision,
} from './scheduler.js';
import { createExecutionService, type ExecutionService } from './service.js';
import { releaseWorkDir, type CapturedInput, type InvocationRecord, type WorkerOutcome } from './supervisor.js';
import {
  bindingMismatch, checkRecordedRun, checkRecordedWork, COVERAGE_EVALUATION_SCHEMA, evaluateCoverage, INFLUENCE_SCHEMA, validatePlan,
  type CoverageEvaluation, type RequiredCoverage, type ValidatedPlan,
} from './plan.js';

/** What PR 06's planner hands the coordinator: canonical envelopes plus the two lookups execution needs. */
export interface PlanBoundary {
  readonly run: RunEnvelope;
  /** Each pending or ready, or held (blocked / disabled-by-policy, with its reasonCode) by the plan itself. */
  readonly works: readonly WorkEnvelope[];
  /** The trusted adapter that executes this work's stage. */
  adapterFor(work: WorkEnvelope): Id;
  /** The captured inputs the work's input fingerprint covers. */
  inputsFor(work: WorkEnvelope): readonly CapturedInput[];
  /**
   * The planned checks and scope a work must cover (PR 06's check mapping). Without it a unit's coverage is
   * unevaluated and the run can at best complete with partial coverage.
   */
  requiredCoverage?(work: WorkEnvelope): RequiredCoverage | undefined;
}

export const COORDINATOR_BOUNDARIES = ['before-spawn', 'after-spawn', 'after-attempt-start', ...PUBLICATION_BOUNDARIES] as const;
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
  /**
   * How long run() keeps re-checking cleanup that recovery could not confirm (a create that may still commit, a
   * container whose removal failed, a worker whose identity could not be read, an unreadable journal record)
   * before it returns blocked. Nothing new is admitted meanwhile. 0–600000 ms, default 30000.
   */
  cleanupWaitMs?: number;
  /** Package-internal test seam for the container runtime (see ContainerBackend.connect). */
  backendOptions?: { wrapRunner?: (runner: DockerRunner) => DockerRunner };
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
  /**
   * Cleanup still unconfirmed when run() returned: while any remains, no new work was admitted, since a prior
   * worker may still be running and holding resources. Empty when admission was free.
   */
  blockedByCleanup: string[];
  /** Records acknowledged as terminal-unknown by acknowledgeUnknownCleanup(): kept for audit, never clean. */
  unknownCleanup: string[];
  /** Each published unit's coverage evaluation, read back from its publication. */
  coverage: CoverageEvaluation[];
}

const key = (r: WorkRef) => `${r.id}@${r.revision}`;
const now = () => new Date().toISOString();
const attemptIdFor = (ref: WorkRef, ordinal: number): Id =>
  `att-${createHash('sha256').update(`${ref.id}@${ref.revision}#${ordinal}`).digest('hex').slice(0, 40)}`;
const MAX_DETAIL_BYTES = 3_072;
const DEPENDENCY_FAILED: CatalogKey = 'sentinel.execution.dependencyFailed';

export class Coordinator {
  readonly #store: SentinelStore;
  readonly #plan: ValidatedPlan;
  readonly #service: ExecutionService;
  readonly #intents: IntentFiles;
  readonly #workers: WorkerFiles;
  readonly #pool: ReservationPool;
  readonly #retry: RetryPolicy;
  readonly #hooks?: CoordinatorHooks;
  readonly #cancel = new AbortController();
  readonly #failures: UnitFailure[] = [];
  /** Units refused before any worker existed (no attempt in the ledger): not retried in this coordinator. */
  readonly #failedUnstarted = new Map<string, string>();
  readonly #unknown: UnknownCleanup;
  readonly #cleanupWaitMs: number;
  readonly #backendOptions: CoordinatorOptions['backendOptions'];
  /** The latest recovery; replaced each time unconfirmed cleanup is re-checked. */
  recovery: RecoveryReport;
  /** This epoch's own creates that ended without a confirmed answer: they block admission until settled. */
  readonly #pendingNow: ContainerIntent[] = [];
  #pauseRequested = false;
  #cancelRequested = false;
  /** The run's aggregate deadline (its recorded creation plus budgets.deadlineMs), and the signal it fires. */
  #runDeadline = Number.POSITIVE_INFINITY;
  readonly #deadline = new AbortController();
  #deadlinePassed = false;

  /** Evaluations read back from publications, by work. */
  readonly #coverage = new Map<string, CoverageEvaluation>();

  private constructor(o: CoordinatorOptions, plan: ValidatedPlan, service: ExecutionService, intents: IntentFiles, workers: WorkerFiles, recovery: RecoveryReport) {
    this.#store = o.store; this.#plan = plan; this.#service = service; this.#intents = intents; this.#workers = workers;
    this.#unknown = new UnknownCleanup(o.store.storePath);
    const wait = o.cleanupWaitMs ?? 30_000;
    if (!Number.isInteger(wait) || wait < 0 || wait > 600_000) throw new ExecutionError('sentinel.execution.planInvalid', { reason: 'cleanupWaitMs is 0 to 600000' });
    this.#cleanupWaitMs = wait;
    this.#backendOptions = o.backendOptions;
    this.#pool = new ReservationPool(o.capacity ?? DEFAULT_CAPACITY);
    // Copied and frozen: changing the caller's policy object after open changes nothing.
    this.#retry = Object.freeze(checkRetryPolicy({ ...(o.retry ?? DEFAULT_RETRY) }));
    if (o.hooks) this.#hooks = o.hooks;
    this.recovery = recovery;
  }

  /** Validate the plan, bind to the store, and recover whatever an earlier epoch left. Starts no new work. */
  static async open(o: CoordinatorOptions): Promise<Coordinator> {
    o.store.assertHeld();
    // The plan as approved: frozen, bound to its adapters and actual inputs, and matching what the ledger holds.
    const plan = validatePlan(o.plan, o.registry ?? TRUSTED_ADAPTERS);
    checkRecordedRun(plan, o.store.ledger.getRun(plan.run.id)?.envelope);
    for (const w of plan.works) checkRecordedWork(plan, { id: w.id, revision: w.revision }, o.store.ledger.getWork({ id: w.id, revision: w.revision }));
    const service = await createExecutionService(o.store, { scratchRoot: o.scratchRoot, ...(o.registry ? { registry: o.registry } : {}),
      ...(o.containers ? { containers: true } : {}), ...(o.backendOptions?.wrapRunner ? { wrapRunner: o.backendOptions.wrapRunner } : {}) });
    const intents = new IntentFiles(o.store.storePath);
    const workers = new WorkerFiles(o.store.storePath);
    const recovery = await recoverStore(o.store, { intents, workers, ...(service.backend ? { backend: service.backend } : {}) });
    return new Coordinator(o, plan, service, intents, workers, recovery);
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

  /**
   * The explicit decision that unconfirmed cleanup will not be confirmed: every pending intent, worker obligation
   * and unreadable journal record is moved, byte for byte, into the terminal-unknown journal, kept for audit and
   * reported in every later summary, and admission continues. A container whose removal failed is not covered: it
   * is still present and keeps blocking until it is removed.
   */
  acknowledgeUnknownCleanup(): string[] {
    const moved = this.#unknown.acknowledge([this.#intents.dir, this.#workers.dir], this.recovery);
    this.recovery = { ...this.recovery, pendingIntents: [], obligations: [], unresolved: [] };
    return moved;
  }

  /** The plan's units as the ledger has them now. */
  progress(): UnitDecision[] {
    return decide(this.#plan.works, this.#committed(), this.#retry);
  }

  /** Execute (or resume) the run until it completes, pauses or is canceled. */
  async run(): Promise<RunSummary> {
    const runId = this.#plan.run.id;
    // A pause asked for before this call holds this run: it is recorded, and nothing is admitted.
    const pauseFirst = this.#pauseRequested;
    // Earlier publications' coverage evaluations, read once; they decide the outcome together with this run's.
    await this.#loadCoverage();
    let state = this.#runState();
    if (state === undefined) {
      // Recorded now: the run's time budget runs from here.
      this.#store.ledger.createRun({ ...structuredClone(this.#plan.run), state: 'running', coordinatorEpoch: this.#store.epoch, createdAt: now() } as RunEnvelope);
      state = 'running';
    } else if (state === 'completed' || state === 'canceled') {
      return this.#summary();
    } else if (state === 'canceling') {
      this.#cancelRequested = true;
    } else {
      // planned, paused, or a pause an earlier epoch did not finish: run() resumes.
      if (state === 'pausing') { this.#store.ledger.setRunState(runId, 'paused'); state = 'paused'; }
      if ((state === 'planned' || state === 'paused') && !pauseFirst && !this.#cancelRequested) { this.#store.ledger.setRunState(runId, 'running'); state = 'running'; }
    }
    if (pauseFirst) {
      if (this.#runState() === 'running') this.#store.ledger.setRunState(runId, 'pausing');
      this.#pauseRequested = false;
      this.#finishRunState('paused');
      return this.#summary();
    }
    this.#pauseRequested = false;
    const recorded = this.#store.ledger.getRun(runId)!;
    this.#runDeadline = Date.parse(recorded.envelope.createdAt) + recorded.envelope.budgets.deadlineMs;
    const remaining = this.#runDeadline - Date.now();
    const deadlineTimer = setTimeout(() => { this.#deadlinePassed = true; this.#deadline.abort(); }, Math.max(0, Math.min(remaining, 2_147_000_000)));
    if (remaining <= 0) { this.#deadlinePassed = true; this.#deadline.abort(); }
    try {
      return await this.#drive(runId);
    } finally { clearTimeout(deadlineTimer); }
  }

  async #drive(runId: Id): Promise<RunSummary> {

    // Unconfirmed cleanup holds admission: a prior worker may still run and hold what a new one would be given.
    const blocked = await this.#awaitCleanup();
    if (blocked.length) return this.#summary(blocked);

    const inflight = new Map<string, Promise<void>>();
    for (;;) {
      const decisions = this.progress();
      this.#persistHolds(decisions);
      const admitting = !this.#pauseRequested && !this.#cancelRequested && !this.#deadlinePassed && this.#runState() === 'running' && this.#pendingNow.length === 0;
      let admitted = 0;
      if (admitting) {
        for (const d of decisions) {
          if (d.state !== 'ready' || inflight.has(key(d.ref))) continue;
          const work = this.#work(d.ref);
          const limits = effectiveLimits(this.#plan.adapterOf(d.ref).limits, work.resources);
          const reservation = this.#pool.tryReserve(key(d.ref), { memoryBytes: limits.memoryBytes, cpus: limits.cpus });
          if (!reservation) break;
          const task = this.#unit(work).finally(() => { this.#pool.release(reservation); inflight.delete(key(d.ref)); });
          inflight.set(key(d.ref), task);
          admitted++;
        }
      }
      if (inflight.size === 0) {
        if (this.#cancelRequested) { this.#finishRunState('canceled'); break; }
        if (this.#deadlinePassed && this.#runState() === 'running') { this.#expire(); break; }
        if (this.#pendingNow.length) {
          const still = await this.#awaitCleanup();
          if (still.length) return this.#summary(still);
          continue;
        }
        if (this.#pauseRequested || this.#runState() === 'pausing') { this.#finishRunState('paused'); break; }
        const final = this.progress();
        if (final.every(d => ['published', 'failed', 'blocked', 'disabled'].includes(d.state))) {
          this.#persistHolds(final);
          // Exit codes prove nothing about coverage: complete only when every unit published and its evaluation is complete.
          const evaluations = final.filter(d => d.state === 'published').map(d => this.#evaluationOf(d.ref));
          const outcome: RunOutcome = !final.every(d => d.state === 'published' || d.state === 'disabled') ? 'execution-failure'
            : final.every(d => d.state === 'published') && evaluations.every(e => e?.verdict === 'complete') ? 'complete-coverage' : 'partial-coverage';
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

  /** The run's budget is spent: hold what has not run, then end the run as an execution failure. */
  #expire(): void {
    for (const d of this.progress()) {
      if (d.state !== 'ready' && d.state !== 'waiting') continue;
      const row = this.#store.ledger.getWork(d.ref);
      const work = this.#work(d.ref);
      if (!row && work.dependencies.some(dep => !this.#store.ledger.getWork(dep))) continue;
      if (!row) this.#create(work, 'pending');
      const current = this.#store.ledger.getWork(d.ref)!;
      if (['pending', 'ready'].includes(current.state)) this.#store.ledger.setWorkState(d.ref, 'blocked', { reasonCode: 'sentinel.execution.runDeadline' });
    }
    this.#store.ledger.setRunState(this.#plan.run.id, 'completed', { outcome: 'execution-failure' });
  }

  /** What recovery could not confirm and nobody acknowledged: each one blocks admission. */
  #outstanding(): string[] {
    const r = this.recovery;
    return [
      ...this.#pendingNow.map(i => `pending container create ${i.name}`),
      ...r.pendingIntents.map(i => `pending container create ${i.name}`),
      ...r.uncertain.map(c => `container ${c} not confirmed removed`),
      ...r.obligations.map(o => `worker ${o.pid || '?'} of attempt ${o.attempt}: ${o.reason}`),
      ...r.unresolved.map(u => `unreadable ${u.journal} record ${u.file}: ${u.reason}`),
    ];
  }

  /** Re-check unconfirmed cleanup about once a second, up to cleanupWaitMs; returns what still blocks. */
  async #awaitCleanup(): Promise<string[]> {
    const deadline = Date.now() + this.#cleanupWaitMs;
    for (;;) {
      const left = this.#outstanding();
      if (left.length === 0 || this.#cancelRequested) return left;
      if (Date.now() >= deadline) return left;
      await new Promise(r => setTimeout(r, Math.min(1_000, Math.max(0, deadline - Date.now()))));
      this.recovery = await recoverStore(this.#store, { intents: this.#intents, workers: this.#workers, ...(this.#service.backend ? { backend: this.#service.backend } : {}) });
      for (const intent of [...this.#pendingNow]) {
        const r = await this.#service.backend?.settleIntent(intent).catch(() => 'uncertain' as const);
        if (r === 'removed') { this.#intents.settle(intent); this.#pendingNow.splice(this.#pendingNow.indexOf(intent), 1); }
      }
    }
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
  #create(work: Readonly<WorkEnvelope>, state: 'pending' | 'ready'): void {
    const { reasonCode: _held, ...rest } = structuredClone(work) as WorkEnvelope & { reasonCode?: string };
    void _held;
    this.#store.ledger.createWork({ ...rest, state, activeAttemptId: null, coordinatorEpoch: this.#store.epoch, createdAt: now() } as WorkEnvelope);
  }

  /** One attempt of one unit, from creating its work revision to publishing or ending it. Never throws. */
  async #unit(work: Readonly<WorkEnvelope>): Promise<void> {
    const ref: WorkRef = { id: work.id, revision: work.revision };
    let attemptId: Id | null = null;
    let outcome: WorkerOutcome | undefined;
    try {
      const row = this.#store.ledger.getWork(ref);
      if (!row) this.#create(work, 'ready');
      else if (row.state === 'pending') this.#store.ledger.setWorkState(ref, 'ready');
      const ordinal = this.#store.ledger.countAttempts(ref) + 1;
      const id = attemptIdFor(ref, ordinal);
      // The attempt's deadline is the work's, cut to what is left of the run's budget.
      const left = Math.max(1, Math.floor(this.#runDeadline - Date.now()));
      const resources = { ...structuredClone(work.resources), deadlineMs: Math.min(work.resources.deadlineMs, left) };
      let invocation: { digest: string; record: InvocationRecord } | undefined;
      outcome = await this.#service.run({
        adapterId: this.#plan.adapterOf(ref).id, attemptId: id, work: ref, inputs: this.#plan.inputsOf(ref),
        signal: AbortSignal.any([this.#cancel.signal, this.#deadline.signal]), intents: this.#intents, workers: this.#workers, resources,
        ...(this.#hooks ? { hooks: { at: (b: 'before-spawn' | 'after-spawn') => this.#hooks!.at?.(b, { work: ref, attemptId: id }) } } : {}),
        onWorker: (worker, inv) => {
          invocation = inv;
          // The attempt names its exact invocation record (the record's own artifact id), published with the result.
          this.#store.ledger.startAttempt({
            schema: 'sentinel-attempt/draft-1', id, work: ref, ordinal, coordinatorEpoch: this.#store.epoch, operationId: id,
            worker, startedAt: now(), usage: { certainty: 'not-applicable' }, state: 'running', invocation: inv.digest,
          });
          attemptId = id;
          this.#hooks?.at?.('after-attempt-start', { work: ref, attemptId: id });
        },
      });
      const mismatch = outcome.state === 'succeeded' && invocation ? bindingMismatch(this.#plan.manifestOf(ref), invocation.record, outcome.result!) : undefined;
      if (outcome.state === 'succeeded' && attemptId && (mismatch || !invocation)) {
        this.#end(ref, attemptId, 'failed', 'sentinel.execution.resultMismatch', { reason: mismatch ?? 'no invocation was recorded' });
      } else if (outcome.state === 'succeeded' && attemptId) {
        try {
          const evaluation = evaluateCoverage(ref, outcome.result!, this.#plan.requiredOf(ref));
          await publishOutcome({ store: this.#store, work: ref, attemptId, result: outcome.result!, outputs: outcome.outputs, endedAt: now(),
            records: [{ value: this.#plan.manifestOf(ref), schema: INFLUENCE_SCHEMA }, { value: invocation!.record, schema: 'sentinel-invocation/draft-1' },
              { value: evaluation, schema: COVERAGE_EVALUATION_SCHEMA }],
            ...(this.#hooks ? { hooks: { at: (b, c) => this.#hooks!.at?.(b, c) } } : {}) });
          this.#coverage.set(key(ref), evaluation);
        } catch (error) {
          const canceled = error instanceof LedgerError && error.code === 'sentinel.store.wrongState';
          this.#end(ref, attemptId, canceled ? 'canceled' : 'failed', canceled ? 'sentinel.execution.canceled' : codeOf(error), detailOf(error));
        }
      } else if (attemptId && this.#deadlinePassed && !this.#cancelRequested) {
        this.#end(ref, attemptId, 'failed', 'sentinel.execution.runDeadline', outcome.detail);
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
    try { attempts = this.#store.ledger.countAttempts(ref); } catch { /* the store is gone; the end below fails too */ }
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
    // A create that may still commit: hold admission until its container is confirmed absent, then try the unit again.
    if (code === 'sentinel.execution.reconciliationPending' && detail && typeof detail.owner === 'string') {
      this.#pendingNow.push({ name: String(detail.name), owner: String(detail.owner), store: String(detail.store), attempt: String(detail.attempt),
        epoch: String(detail.epoch), invocation: String(detail.invocation) });
      return;
    }
    // Refused before any worker acted (an unknown adapter, a mismatched input, a pending create): not retried here.
    if (!this.#cancelRequested && !this.#pauseRequested) this.#failedUnstarted.set(key(ref), code);
  }

  /** A published unit's coverage evaluation: this coordinator's, or one read back from an earlier publication. */
  #evaluationOf(ref: WorkRef): CoverageEvaluation | undefined {
    return this.#coverage.get(key(ref));
  }

  /** Read every earlier publication's evaluation from the store; an unreadable one counts as not complete. */
  async #loadCoverage(): Promise<void> {
    for (const w of this.#plan.works) {
      const ref = { id: w.id, revision: w.revision };
      if (this.#coverage.has(key(ref))) continue;
      const out = this.#store.ledger.getPublication(ref)?.outputs.find(o => o.schema === COVERAGE_EVALUATION_SCHEMA);
      if (!out) continue;
      try { this.#coverage.set(key(ref), JSON.parse((await this.#store.readArtifact(out.id)).toString('utf8')) as CoverageEvaluation); } catch { /* not complete */ }
    }
  }

  #work(ref: WorkRef): Readonly<WorkEnvelope> {
    return this.#plan.works.find(w => w.id === ref.id && w.revision === ref.revision)!;
  }

  #committed(): Map<string, CommittedUnit> {
    const m = new Map<string, CommittedUnit>();
    for (const w of this.#plan.works) {
      const ref = { id: w.id, revision: w.revision };
      const row = this.#store.ledger.getWork(ref);
      const attempts = row ? this.#store.ledger.countAttempts(ref) : 0;
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

  #summary(blockedByCleanup: string[] = []): RunSummary {
    const units = this.progress();
    const run = this.#store.ledger.getRun(this.#plan.run.id);
    let published = 0;
    const coverage: CoverageEvaluation[] = [];
    for (const w of this.#plan.works) {
      const ref = { id: w.id, revision: w.revision };
      if (!this.#store.ledger.getPublication(ref)) continue;
      published++;
      const e = this.#evaluationOf(ref);
      if (e) coverage.push(e);
    }
    return { runId: this.#plan.run.id, state: run?.state ?? 'planned', ...(run?.outcome ? { outcome: run.outcome } : {}), units,
      failures: [...this.#failures], recovery: this.recovery, published, blockedByCleanup, coverage,
      unknownCleanup: this.#unknown.list(),
      clean: this.recovery.clean && this.#unknown.list().length === 0 && coverage.length === published && coverage.every(c => c.verdict === 'complete') };
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
