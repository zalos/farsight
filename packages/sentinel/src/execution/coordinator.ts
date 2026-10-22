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
// publication for the run. The plan is a revision admitted in the ledger (plans.ts), made by PR 06's planner and
// bound through its canonical boundary (plan.ts); this module does not plan. A bootstrap revision's capture, parse
// and inventory units run as the coordinator's own operations (bootstrap.ts); an analysis revision's check units
// run as workers, and what each covered is recorded as canonical coverage records (coverage.ts) that PR 06's
// evaluateRequiredCoverage alone turns into the run's outcome.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { restoreSnapshot } from '../snapshot/materialize.js';
import { reconcileScratch, removeOwned, type ScratchReconciliation } from './scratch.js';
import type { ArtifactId, CatalogKey, Id, WorkRef } from '../contracts/common.js';
import type { CoverageEnvelope } from '../contracts/coverage.js';
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
import { releaseWorkDir, type InvocationRecord, type WorkerOutcome } from './supervisor.js';
import { bindingId, bindingMismatch, checkRecordedRun, checkRecordedWork, executablePlan, EXECUTION_BINDING_SCHEMA, type ValidatedPlan } from './plan.js';
import { loadPlan } from './plans.js';
import { publishPrepared, runOperation } from './bootstrap.js';
import { COVERAGE_SCHEMA, coverageRecords, scopeIndex, type ScopeIndex } from './coverage.js';
import { evaluateRequiredCoverage, type RequiredCoverage } from '../planner/coverage.js';

export const COORDINATOR_BOUNDARIES = ['before-spawn', 'after-spawn', 'after-attempt-start', ...PUBLICATION_BOUNDARIES] as const;
export type CoordinatorBoundary = typeof COORDINATOR_BOUNDARIES[number];

/** Test seam (deterministic crash injection). Production passes none. */
export interface CoordinatorHooks {
  at?(boundary: CoordinatorBoundary, context: BoundaryContext): void;
}

export interface CoordinatorOptions {
  store: SentinelStore;
  /** The run to execute: its current admitted plan revision is what runs. */
  runId: Id;
  /**
   * The run as requested, recorded on the first run() when the ledger does not hold it yet (its plan revision must
   * then be admitted). When the ledger holds it, it must be the recorded run, field for field.
   */
  run?: RunEnvelope;
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
  /** The plan revision's kind: a bootstrap revision leaves the run running once its units publish. */
  kind: 'bootstrap' | 'analysis';
  /** The revision that ran. */
  planRevision: number;
  /** Required coverage from PR 06's evaluator over every coverage record this revision's units published; null for bootstrap. */
  coverage: RequiredCoverage | null;
  /** Coverage records read back from this revision's publications. */
  coverageRecords: number;
}

const key = (r: WorkRef) => `${r.id}@${r.revision}`;
const now = () => new Date().toISOString();
const attemptIdFor = (ref: WorkRef, ordinal: number): Id =>
  `att-${createHash('sha256').update(`${ref.id}@${ref.revision}#${ordinal}`).digest('hex').slice(0, 40)}`;
const MAX_DETAIL_BYTES = 3_072;
const DEPENDENCY_FAILED: CatalogKey = 'sentinel.execution.dependencyFailed';
/** Allowance for timer and scheduling granularity when an operation's CPU time is compared with its quota. */
const CPU_SLACK_MS = 100;

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
  /** What open removed from, and kept in, the scratch root. */
  scratch: ScratchReconciliation = { removedRestores: [], removedWorkDirs: [], kept: [] };
  /** This epoch's own creates that ended without a confirmed answer: they block admission until settled. */
  readonly #pendingNow: ContainerIntent[] = [];
  #pauseRequested = false;
  #active: Promise<RunSummary> | undefined;
  #cancelRequested = false;
  /** The run's aggregate deadline (its recorded creation plus budgets.deadlineMs), and the signal it fires. */
  #runDeadline = Number.POSITIVE_INFINITY;
  readonly #deadline = new AbortController();
  #deadlinePassed = false;

  /** Coverage records read back from publications, by work. */
  readonly #coverage = new Map<string, CoverageEnvelope[]>();
  readonly #scratchRoot: string;
  /** The plan's scope extents, indexed once. */
  readonly #scopes: ScopeIndex;

  private constructor(o: CoordinatorOptions, plan: ValidatedPlan, service: ExecutionService, intents: IntentFiles, workers: WorkerFiles, recovery: RecoveryReport) {
    this.#store = o.store; this.#plan = plan; this.#service = service; this.#intents = intents; this.#workers = workers;
    this.#scratchRoot = o.scratchRoot;
    this.#scopes = scopeIndex(plan.admitted.plan);
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

  /** Load the run's admitted plan revision, bind it, and recover whatever an earlier epoch left. Starts no new work. */
  static async open(o: CoordinatorOptions): Promise<Coordinator> {
    o.store.assertHeld();
    const registry = o.registry ?? TRUSTED_ADAPTERS;
    const recorded = o.store.ledger.getRun(o.runId);
    if (o.run && o.run.id !== o.runId) throw new ExecutionError('sentinel.execution.planInvalid', { reason: 'the run envelope names another run' });
    if (o.run) checkRecordedRun(o.run, recorded?.envelope);
    const run = recorded?.envelope ?? o.run;
    if (!run) throw new ExecutionError('sentinel.execution.planInvalid', { reason: 'the run is not recorded and no run envelope was given' });
    const revision = recorded?.planRevision ?? run.planRevision;
    // Exactly the admitted revision, read back and checked, bound to its adapters and actual inputs.
    const admitted = await loadPlan(o.store, o.runId, revision);
    const plan = await executablePlan(o.store, admitted, run, revision, registry, o.scratchRoot);
    for (const w of plan.works) checkRecordedWork(plan, { id: w.id, revision: w.revision }, o.store.ledger.getWork({ id: w.id, revision: w.revision }));
    const service = await createExecutionService(o.store, { scratchRoot: o.scratchRoot, ...(o.registry ? { registry: o.registry } : {}),
      ...(o.containers ? { containers: true } : {}), ...(o.backendOptions?.wrapRunner ? { wrapRunner: o.backendOptions.wrapRunner } : {}) });
    const intents = new IntentFiles(o.store.storePath);
    const workers = new WorkerFiles(o.store.storePath);
    const recovery = await recoverStore(o.store, { intents, workers, ...(service.backend ? { backend: service.backend } : {}) });
    const c = new Coordinator(o, plan, service, intents, workers, recovery);
    // What dead owners left in this scratch root that is provably unused now goes; anything uncertain stays.
    c.scratch = reconcileScratch(o.scratchRoot, o.store, recovery);
    return c;
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
    return decide(this.#plan.works, this.#committed(), this.#retry, this.#plan.external);
  }

  /**
   * Execute (or resume) the run until it completes, pauses or is canceled. One drive at a time: a run() while one is
   * active returns that same drive. A pause asked for at any moment before the drive ends is honoured: before this
   * call, during its set-up awaits, or while work is in flight; it is cleared only once the run is recorded paused.
   */
  run(): Promise<RunSummary> {
    if (this.#active) return this.#active;
    const drive = this.#run().finally(() => { if (this.#active === drive) this.#active = undefined; });
    this.#active = drive;
    return drive;
  }

  async #run(): Promise<RunSummary> {
    const runId = this.#plan.run.id;
    // Earlier publications' coverage evaluations, read once; they decide the outcome together with this run's.
    await this.#loadCoverage();
    // Read after every await of the set-up, never before it: a pause requested meanwhile holds this run.
    const pauseFirst = this.#pauseRequested;
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
    const recorded = this.#store.ledger.getRun(runId)!;
    this.#runDeadline = Date.parse(recorded.envelope.createdAt) + recorded.envelope.budgets.deadlineMs;
    const remaining = this.#runDeadline - Date.now();
    const deadlineTimer = setTimeout(() => { this.#deadlinePassed = true; this.#deadline.abort(); }, Math.max(0, Math.min(remaining, 2_147_000_000)));
    if (remaining <= 0) { this.#deadlinePassed = true; this.#deadline.abort(); }
    try {
      // The pinned snapshot is restored for this drive only: attempts copy their inputs from it while it lasts, and
      // the drive returns with nothing in flight, so nothing reads it after.
      const restored = this.#plan.restored;
      if (restored && !existsSync(restored)) await restoreSnapshot(this.#store, this.#plan.run.snapshotId, restored);
      try { return await this.#drive(runId); } finally { if (restored) removeOwned(restored); }
    } finally { clearTimeout(deadlineTimer); }
  }

  async #drive(runId: Id): Promise<RunSummary> {

    // Unconfirmed cleanup holds admission: a prior worker may still run and hold what a new one would be given.
    const blocked = await this.#awaitCleanup();
    if (blocked.length) return this.#summary(blocked);

    const inflight = new Map<string, Promise<void>>();
    for (;;) {
      const decisions = this.progress();
      await this.#persistHolds(decisions);
      const admitting = !this.#pauseRequested && !this.#cancelRequested && !this.#deadlinePassed && this.#runState() === 'running' && this.#pendingNow.length === 0;
      let admitted = 0;
      if (admitting) {
        for (const d of decisions) {
          if (d.state !== 'ready' || inflight.has(key(d.ref))) continue;
          const work = this.#work(d.ref);
          const limits = effectiveLimits(this.#plan.unitOf(d.ref).adapter!.limits, work.resources);
          const reservation = this.#pool.tryReserve(key(d.ref), { memoryBytes: limits.memoryBytes, cpus: limits.cpus });
          if (!reservation) break;
          const task = this.#unit(work).finally(() => { this.#pool.release(reservation); inflight.delete(key(d.ref)); });
          inflight.set(key(d.ref), task);
          admitted++;
        }
      }
      if (inflight.size === 0) {
        if (this.#cancelRequested) { this.#finishRunState('canceled'); break; }
        if (this.#deadlinePassed && this.#runState() === 'running') { await this.#expire(); break; }
        if (this.#pendingNow.length) {
          const still = await this.#awaitCleanup();
          if (still.length) return this.#summary(still);
          continue;
        }
        if (this.#pauseRequested || this.#runState() === 'pausing') { this.#finishRunState('paused'); this.#pauseRequested = false; break; }
        const final = this.progress();
        if (final.every(d => ['published', 'failed', 'blocked', 'disabled'].includes(d.state))) {
          await this.#persistHolds(final);
          const failed = !final.every(d => d.state === 'published' || d.state === 'disabled');
          // A published bootstrap leaves the run running: its analysis revision is planned from what it published.
          if (this.#plan.admitted.plan.kind === 'bootstrap' && !failed) break;
          // Exit codes prove nothing about coverage: the outcome is PR 06's evaluation of the coverage records alone.
          const coverage = this.#plan.admitted.plan.kind === 'analysis' ? this.#requiredCoverage() : null;
          const outcome: RunOutcome = failed ? 'execution-failure'
            : final.every(d => d.state === 'published') && coverage?.complete === true ? 'complete-coverage' : 'partial-coverage';
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
  async #expire(): Promise<void> {
    for (const d of this.progress()) {
      if (d.state !== 'ready' && d.state !== 'waiting') continue;
      const row = this.#store.ledger.getWork(d.ref);
      const work = this.#work(d.ref);
      if (!row && work.dependencies.some(dep => !this.#store.ledger.getWork(dep))) continue;
      if (!row) await this.#create(work, 'pending');
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
  async #persistHolds(decisions: UnitDecision[]): Promise<void> {
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
      if (!row) { await this.#create(work, 'pending'); row = this.#store.ledger.getWork(d.ref)!; }
      const reason = planReason(work) ?? (want === 'disabled-by-policy' ? 'sentinel.execution.planInvalid' : DEPENDENCY_FAILED);
      if (['pending', 'ready', 'blocked'].includes(row.state)) this.#store.ledger.setWorkState(d.ref, want, { reasonCode: reason });
    }
  }

  #finishRunState(to: 'paused' | 'canceled'): void {
    const s = this.#runState();
    if (to === 'paused' && s === 'running') this.#store.ledger.setRunState(this.#plan.run.id, 'pausing');
    if (to === 'canceled' && s !== 'canceling' && s !== 'canceled') this.#store.ledger.setRunState(this.#plan.run.id, 'canceling');
    if (this.#runState() !== to) this.#store.ledger.setRunState(this.#plan.run.id, to);
  }

  /**
   * Create a plan unit's revision in the ledger under this epoch, with its canonical influence manifest accepted in
   * the same transaction (the root its envelope names). A plan-held unit is created pending, then held.
   */
  async #create(work: Readonly<WorkEnvelope>, state: 'pending' | 'ready'): Promise<void> {
    const { reasonCode: _held, ...rest } = structuredClone(work) as WorkEnvelope & { reasonCode?: string };
    void _held;
    const manifest = this.#plan.unitOf(work).manifest;
    const records = await this.#stageRecords(`manifest.${work.id}.${work.revision}`, [{ value: manifest, schema: 'sentinel-influence/draft-1' }]);
    try {
      this.#store.ledger.createWork({ ...rest, state, activeAttemptId: null, coordinatorEpoch: this.#store.epoch, createdAt: now() } as WorkEnvelope, { records });
    } catch (error) { this.#abortStage(records.stageId); throw error; }
  }

  /** Stage canonical records unbound under this epoch and store their bytes; the first links the rest. */
  async #stageRecords(tag: string, values: Array<{ value: unknown; schema: string }>): Promise<{ stageId: string; receipts: Awaited<ReturnType<SentinelStore['objects']['putCanonicalJson']>>[] }> {
    const ids = values.map(v => this.#store.objects.identifyCanonicalJson(v.value));
    const stageId = `${tag}.${createHash('sha256').update(`${this.#store.epoch}\u0000${tag}\u0000${Date.now()}\u0000${Math.random()}`).digest('hex').slice(0, 16)}`.slice(0, 128);
    const unique = ids.map((id, i) => ({ id, i })).filter((x, j, all) => all.findIndex(y => y.id.id === x.id.id) === j);
    this.#store.ledger.registerStaging(stageId, unique.map(({ id, i }) => ({ id: id.id, schema: values[i]!.schema.slice(0, 128), privacy: 'metadata' as const,
      ...(i === 0 ? { links: unique.filter(u => u.i !== 0).map(u => u.id.id) } : {}) })));
    try {
      const receipts = [];
      for (const { id, i } of unique) receipts.push(await this.#store.objects.putCanonicalJson(values[i]!.value, { expect: id }));
      return { stageId, receipts };
    } catch (error) { this.#abortStage(stageId); throw error; }
  }

  #abortStage(stageId: string): void {
    try { this.#store.assertHeld(); this.#store.ledger.abortStaging(stageId); } catch { /* recovery aborts a stage left open */ }
  }

  /** One attempt of one unit, from creating its work revision to publishing or ending it. Never throws. */
  async #unit(work: Readonly<WorkEnvelope>): Promise<void> {
    const ref: WorkRef = { id: work.id, revision: work.revision };
    let attemptId: Id | null = null;
    let outcome: WorkerOutcome | undefined;
    try {
      const row = this.#store.ledger.getWork(ref);
      if (!row) await this.#create(work, 'ready');
      else if (row.state === 'pending') this.#store.ledger.setWorkState(ref, 'ready');
      const ordinal = this.#store.ledger.countAttempts(ref) + 1;
      const id = attemptIdFor(ref, ordinal);
      const executable = this.#plan.unitOf(ref);
      if (executable.adapter!.kind === 'operation') { attemptId = await this.#operation(work, ordinal, id); return; }
      const binding = this.#plan.bindingOf(ref);
      // The attempt's deadline is the work's, cut to what is left of the run's budget.
      const left = Math.max(1, Math.floor(this.#runDeadline - Date.now()));
      const resources = { ...structuredClone(work.resources), deadlineMs: Math.min(work.resources.deadlineMs, left) };
      let invocation: { digest: string; record: InvocationRecord } | undefined;
      outcome = await this.#service.run({
        adapterId: executable.adapter!.id, attemptId: id, work: ref, inputs: executable.inputs,
        assignment: { checks: executable.checks.map(c => c.id), scopes: [...executable.unit.scopes] },
        signal: AbortSignal.any([this.#cancel.signal, this.#deadline.signal]), intents: this.#intents, workers: this.#workers, resources,
        ...(this.#hooks ? { hooks: { at: (b: 'before-spawn' | 'after-spawn') => this.#hooks!.at?.(b, { work: ref, attemptId: id }) } } : {}),
        onWorker: async (worker, inv) => {
          invocation = inv;
          // The attempt names its exact invocation record, accepted with its start together with the execution
          // binding it links: a failed, canceled or interrupted attempt keeps both.
          const records = await this.#stageRecords(`invocation.${id}`, [{ value: inv.record, schema: 'sentinel-invocation/draft-1' }, { value: binding, schema: EXECUTION_BINDING_SCHEMA }]);
          if (this.#store.objects.identifyCanonicalJson(inv.record).id !== inv.digest || records.receipts.every(r => r.id !== bindingId(binding))) {
            this.#abortStage(records.stageId);
            throw new ExecutionError('sentinel.execution.resultMismatch', { reason: 'the invocation record is not the one the attempt names' });
          }
          try {
            this.#store.ledger.startAttempt({
              schema: 'sentinel-attempt/draft-1', id, work: ref, ordinal, coordinatorEpoch: this.#store.epoch, operationId: id,
              worker, startedAt: now(), usage: { certainty: 'not-applicable' }, state: 'running', invocation: inv.digest,
            }, { records });
          } catch (error) { this.#abortStage(records.stageId); throw error; }
          attemptId = id;
          this.#hooks?.at?.('after-attempt-start', { work: ref, attemptId: id });
        },
      });
      const mismatch = outcome.state === 'succeeded' && invocation ? bindingMismatch(binding, invocation.record, outcome.result!) : undefined;
      if (outcome.state === 'succeeded' && attemptId && (mismatch || !invocation)) {
        this.#end(ref, attemptId, 'failed', 'sentinel.execution.resultMismatch', { reason: mismatch ?? 'no invocation was recorded' });
      } else if (outcome.state === 'succeeded' && attemptId) {
        try {
          // One canonical coverage record per check the plan assigned this unit, at no finer granularity than the
          // trusted adapter establishes; published with the result.
          const coverage = coverageRecords({ runId: this.#plan.run.id, attemptId, work: ref, checks: executable.checks, scopes: this.#scopes,
            adapterGranularity: executable.adapter!.coverage, result: outcome.result!, recordedAt: now() });
          await publishOutcome({ store: this.#store, work: ref, attemptId, result: outcome.result!, outputs: outcome.outputs, endedAt: now(),
            records: coverage.records, ...(this.#hooks ? { hooks: { at: (b, c) => this.#hooks!.at?.(b, c) } } : {}) });
          this.#coverage.set(key(ref), coverage.envelopes);
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

  /**
   * A bootstrap unit: the coordinator's own operation (bootstrap.ts) under a recorded attempt whose worker is this
   * coordinator, naming the operation adapter the plan pinned. Its invocation record (what was asked, with what
   * settings) is accepted with the start. The operation only prepares its records; they are published through the
   * attempt only when the unit's grant held: its deadline, the process memory it added (sampled; it runs in this
   * process, so the bound is on what this process grew by) and its CPU time against the quota. It starts no process
   * and writes no process output, so its pid and process-output grants always hold; retained artifact sizes are the
   * store's and the parser's own bounds. Returns the attempt id.
   */
  async #operation(work: Readonly<WorkEnvelope>, ordinal: number, id: Id): Promise<Id> {
    const ref: WorkRef = { id: work.id, revision: work.revision };
    const executable = this.#plan.unitOf(ref);
    const adapter = executable.adapter!;
    if (adapter.kind !== 'operation') throw new ExecutionError('sentinel.execution.planInvalid', { reason: 'not an operation' });
    const profile = this.#plan.admitted.profile;
    const record = {
      format: 'sentinel-operation-invocation/draft-1', store: this.#store.storeId, attemptId: id, work: ref, coordinatorEpoch: this.#store.epoch,
      adapter: { id: adapter.id, version: adapter.version, digest: adapter.digest }, operation: adapter.operation,
      plan: { runId: this.#plan.run.id, revision: this.#plan.admitted.plan.revision, digest: this.#plan.admitted.plan.digest },
      influenceManifest: work.influenceManifest, snapshotId: this.#plan.run.snapshotId, sourceId: executable.unit.sourceId,
      ...(adapter.operation === 'parse' ? { parse: profile.parse } : {}),
    };
    const invocation = this.#store.objects.identifyCanonicalJson(record).id as ArtifactId;
    const records = await this.#stageRecords(`invocation.${id}`, [{ value: record, schema: 'sentinel-operation-invocation/draft-1' }]);
    try {
      this.#store.ledger.startAttempt({
        schema: 'sentinel-attempt/draft-1', id, work: ref, ordinal, coordinatorEpoch: this.#store.epoch, operationId: id,
        worker: { kind: 'coordinator-operation', adapterId: adapter.id, adapterDigest: adapter.digest },
        startedAt: now(), usage: { certainty: 'not-applicable' }, state: 'running', invocation,
      }, { records });
    } catch (error) { this.#abortStage(records.stageId); throw error; }
    this.#hooks?.at?.('after-attempt-start', { work: ref, attemptId: id });
    // The unit's grant holds the operation as it holds a worker: its deadline (cut to what is left of the run's),
    // the process memory it may add and the CPU time it may use. The operation only prepares; nothing is published
    // unless every bound held and the run was not canceled or expired meanwhile. maxOutputBytes bounds a worker's
    // process output (stdout and stderr); an operation has none, so it holds trivially. The size of what it retains
    // is a separate contract: the store's object cap and the parser's own pinned limits, enforced where they apply.
    const grant = work.resources;
    const deadlineMs = Math.max(1, Math.min(grant.deadlineMs, Math.floor(this.#runDeadline - Date.now())));
    const own = AbortSignal.timeout(deadlineMs);
    const memory = new AbortController();
    const signal = AbortSignal.any([this.#cancel.signal, this.#deadline.signal, own, memory.signal]);
    const baseline = process.memoryUsage().rss;
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    let peak = 0;
    const sample = () => { peak = Math.max(peak, process.memoryUsage().rss - baseline); if (peak > grant.memoryBytes) memory.abort(); };
    const sampler = setInterval(sample, 20);
    let prepared: Awaited<ReturnType<typeof runOperation>> | undefined;
    let failure: unknown;
    try {
      prepared = await runOperation(adapter.operation, { store: this.#store, run: this.#plan.run, plan: this.#plan.admitted.plan, unit: executable.unit, profile,
        attemptId: id, scratchRoot: this.#scratchRoot, signal });
    } catch (error) { failure = error; } finally { clearInterval(sampler); sample(); }
    const wallMs = performance.now() - t0;
    const used = process.cpuUsage(cpu0);
    const cpuMs = (used.user + used.system) / 1000;
    // Checked in this order; the first that applies ends the attempt without a publication.
    const refusal: [string, Record<string, unknown>] | null =
      this.#cancel.signal.aborted ? ['sentinel.execution.canceled', {}]
        : this.#deadlinePassed || this.#deadline.signal.aborted ? ['sentinel.execution.runDeadline', {}]
          : own.aborted || wallMs > deadlineMs ? ['sentinel.execution.deadlineExceeded', { deadlineMs, elapsedMs: Math.round(wallMs) }]
            : memory.signal.aborted || peak > grant.memoryBytes ? ['sentinel.execution.resourceExceeded', { resource: 'memory', limit: grant.memoryBytes, observed: peak }]
              // The process's CPU time over the operation (its own GC and I/O threads included), against the quota.
              : cpuMs > grant.cpuQuota * wallMs + CPU_SLACK_MS ? ['sentinel.execution.resourceExceeded', { resource: 'cpu', quota: grant.cpuQuota, cpuMs: Math.round(cpuMs), wallMs: Math.round(wallMs) }]
                : null;
    if (refusal) {
      this.#end(ref, id, refusal[0] === 'sentinel.execution.canceled' ? 'canceled' : 'failed', refusal[0], refusal[1]);
      return id;
    }
    if (failure) {
      this.#end(ref, id, 'failed', codeOf(failure), detailOf(failure));
      return id;
    }
    try {
      await publishPrepared(this.#store, ref, id, prepared!);
    } catch (error) {
      const canceled = error instanceof LedgerError && error.code === 'sentinel.store.wrongState';
      this.#end(ref, id, canceled ? 'canceled' : 'failed', canceled ? 'sentinel.execution.canceled' : codeOf(error), detailOf(error));
    }
    return id;
  }

  /** Required coverage: PR 06's evaluator over every coverage record this revision's units published. */
  #requiredCoverage(): RequiredCoverage {
    return evaluateRequiredCoverage(this.#plan.admitted.plan, [...this.#coverage.values()].flat());
  }

  /** Read every earlier publication's coverage records from the store; an unreadable one counts as missing. */
  async #loadCoverage(): Promise<void> {
    for (const w of this.#plan.works) {
      const ref = { id: w.id, revision: w.revision };
      if (this.#coverage.has(key(ref))) continue;
      const outs = this.#store.ledger.getPublication(ref)?.outputs.filter(o => o.schema === COVERAGE_SCHEMA);
      if (!outs) continue;
      const records: CoverageEnvelope[] = [];
      for (const o of outs) { try { records.push(JSON.parse((await this.#store.readArtifact(o.id)).toString('utf8')) as CoverageEnvelope); } catch { /* missing */ } }
      this.#coverage.set(key(ref), records);
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
    for (const w of this.#plan.works) if (this.#store.ledger.getPublication({ id: w.id, revision: w.revision })) published++;
    const kind = this.#plan.admitted.plan.kind;
    const coverage = kind === 'analysis' ? this.#requiredCoverage() : null;
    return { runId: this.#plan.run.id, state: run?.state ?? 'planned', ...(run?.outcome ? { outcome: run.outcome } : {}), units,
      failures: [...this.#failures], recovery: this.recovery, published, blockedByCleanup, kind, planRevision: this.#plan.admitted.plan.revision,
      coverage, coverageRecords: [...this.#coverage.values()].reduce((n, r) => n + r.length, 0), unknownCleanup: this.#unknown.list(),
      clean: this.recovery.clean && this.#unknown.list().length === 0 };
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
