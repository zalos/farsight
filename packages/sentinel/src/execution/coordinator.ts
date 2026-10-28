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
import { prepareAdmittedReview, runAdmittedReview, type ReviewRuntime } from '../review/dispatch.js';
import { BUILTIN_WORKERS, closureRefusalOf } from './builtin-workers.js';
import { deepFreeze } from '../policy/immutable.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  driverRefusal,
  fileDigest,
  isCheckDriverRegistry,
  type CheckDriver,
  type CheckDriverRegistry,
  type DriverContext,
  type RuleFiles,
} from './check-drivers.js';
import { retainedAnalysisFor, retainedBinding, verifyRetainedAuxiliary } from './retained-analysis.js';
import { resolveLockedRules } from '../rules/resolve.js';
import type { ValidatedPack } from '../rules/pack.js';
import { restoreSnapshot } from '../snapshot/materialize.js';
import { PREP_PREFIX, reconcileScratch, removeOwned, type ScratchReconciliation } from './scratch.js';
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
  checkRetryPolicy,
  decide,
  DEFAULT_CAPACITY,
  DEFAULT_RETRY,
  ReservationPool,
  retryable,
  type Capacity,
  type CommittedUnit,
  type RetryPolicy,
  type UnitDecision,
} from './scheduler.js';
import { createExecutionService, type ExecutionService } from './service.js';
import { inputFingerprintOf, releaseWorkDir, type InvocationRecord, type WorkerOutcome } from './supervisor.js';
import {
  bindingId,
  bindingMismatch,
  checkRecordedRun,
  checkRecordedWork,
  executablePlan,
  EXECUTION_BINDING_SCHEMA,
  type ExecutionBinding,
  type ValidatedPlan,
} from './plan.js';
import { loadPlan } from './plans.js';
import { stageInputsForUnit } from './stage-inputs.js';
import { checkEntry, runHostScript, SCRIPT_CONTRACT } from './script-runner.js';
import { featureEnabled } from '../policy/features.js';
import type { ScriptStageDefinition } from '../contracts/pipeline.js';
import type { StageInputBinding } from '../contracts/pipeline.js';

/**
 * The review dispatch, handed the attempt's sealed stage inputs as its last argument (undefined for a unit whose
 * stage reads no other stage's output). The binding is the one the invocation record accepted with the attempt.
 */
const runReviewWithInputs: (
  ...args: [...Parameters<typeof runAdmittedReview>, stageInputs: readonly StageInputBinding[] | undefined]
) => ReturnType<typeof runAdmittedReview> = runAdmittedReview;
import { publishPrepared, runOperation } from './bootstrap.js';
import { COVERAGE_SCHEMA, coverageRecords, scopeIndex, type ScopeIndex } from './coverage.js';
import { evaluateRequiredCoverage, type RequiredCoverage } from '../planner/coverage.js';

export const COORDINATOR_BOUNDARIES = [
  'before-spawn',
  'after-spawn',
  'after-attempt-start',
  ...PUBLICATION_BOUNDARIES,
] as const;
export type CoordinatorBoundary = (typeof COORDINATOR_BOUNDARIES)[number];

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
  /** Trusted check drivers (createCheckDriverRegistry), bound to adapters by id and implementation digest. */
  drivers?: CheckDriverRegistry;
  /** The admitted owner copies of the advisory databases the plan pins, for drivers (each verified when used). */
  databases?: ReadonlyArray<{ databaseId: Id; snapshotDigest: string; path: string }>;
  /** The promoted packs the plan's lock pins, with their files' bytes, for drivers (each verified when used). */
  packs?: ReadonlyArray<{ pack: ValidatedPack; files: ReadonlyMap<string, Uint8Array> }>;
  /** Package-internal test seam for the container runtime (see ContainerBackend.connect). */
  review?: ReviewRuntime;
  /**
   * The entry bytes of the run's host script stages, by digest, as the owner's promoted stage packs hold them. Each is
   * checked against the digest the run's profile pins before its attempt starts; a missing or changed entry refuses.
   */
  scripts?: ReadonlyMap<string, Uint8Array>;
  backendOptions?: { wrapRunner?: (runner: DockerRunner) => DockerRunner };
}

export interface UnitFailure {
  work: WorkRef;
  attemptId: Id | null;
  code: string;
  detail?: Readonly<Record<string, unknown>>;
}

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
  readonly #review: ReviewRuntime | undefined;
  readonly #scripts: ReadonlyMap<string, Uint8Array> | undefined;
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
  readonly #drivers: CheckDriverRegistry | undefined;
  readonly #packs: CoordinatorOptions['packs'];
  readonly #databases: ReadonlyArray<{ databaseId: Id; snapshotDigest: string; path: string }>;
  /** The plan's scope extents, indexed once. */
  readonly #scopes: ScopeIndex;

  private constructor(
    o: CoordinatorOptions,
    plan: ValidatedPlan,
    service: ExecutionService,
    intents: IntentFiles,
    workers: WorkerFiles,
    recovery: RecoveryReport,
  ) {
    this.#store = o.store;
    this.#review = o.review;
    this.#scripts = o.scripts;
    this.#plan = plan;
    this.#service = service;
    this.#intents = intents;
    this.#workers = workers;
    this.#scratchRoot = o.scratchRoot;
    this.#databases = o.databases ? o.databases.map((d) => ({ ...d })) : [];
    this.#drivers = o.drivers;
    this.#packs = o.packs
      ? o.packs.map((p) => ({ pack: p.pack, files: new Map([...p.files].map(([k, v]) => [k, Uint8Array.from(v)])) }))
      : undefined;
    this.#scopes = scopeIndex(plan.admitted.plan);
    this.#unknown = new UnknownCleanup(o.store.storePath);
    const wait = o.cleanupWaitMs ?? 30_000;
    if (!Number.isInteger(wait) || wait < 0 || wait > 600_000)
      throw new ExecutionError('sentinel.execution.planInvalid', { reason: 'cleanupWaitMs is 0 to 600000' });
    this.#cleanupWaitMs = wait;
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
    if (o.run && o.run.id !== o.runId)
      throw new ExecutionError('sentinel.execution.planInvalid', { reason: 'the run envelope names another run' });
    if (o.run) checkRecordedRun(o.run, recorded?.envelope);
    const run = recorded?.envelope ?? o.run;
    if (!run)
      throw new ExecutionError('sentinel.execution.planInvalid', {
        reason: 'the run is not recorded and no run envelope was given',
      });
    const revision = recorded?.planRevision ?? run.planRevision;
    // Exactly the admitted revision, read back and checked, bound to its adapters and actual inputs.
    const admitted = await loadPlan(o.store, o.runId, revision);
    if (o.drivers !== undefined && !isCheckDriverRegistry(o.drivers))
      throw new ExecutionError('sentinel.execution.adapterInvalid', {
        reason: 'drivers come only from createCheckDriverRegistry',
      });
    // Rebind selected drivers here: the caller may have built them against a different registry earlier.
    const refusal = o.drivers ? driverRefusal(admitted.plan, o.drivers, registry) : undefined;
    if (refusal) throw new ExecutionError('sentinel.execution.planInvalid', { reason: refusal });
    const plan = await executablePlan(o.store, admitted, run, revision, registry, o.scratchRoot);
    for (const w of plan.works)
      checkRecordedWork(
        plan,
        { id: w.id, revision: w.revision },
        o.store.ledger.getWork({ id: w.id, revision: w.revision }),
      );
    const service = await createExecutionService(o.store, {
      scratchRoot: o.scratchRoot,
      ...(o.registry ? { registry: o.registry } : {}),
      ...(o.containers ? { containers: true } : {}),
      ...(o.backendOptions?.wrapRunner ? { wrapRunner: o.backendOptions.wrapRunner } : {}),
    });
    const intents = new IntentFiles(o.store.storePath);
    const workers = new WorkerFiles(o.store.storePath);
    const recovery = await recoverStore(o.store, {
      intents,
      workers,
      ...(service.backend ? { backend: service.backend } : {}),
    });
    const c = new Coordinator(o, plan, service, intents, workers, recovery);
    // What dead owners left in this scratch root that is provably unused now goes; anything uncertain stays.
    c.scratch = reconcileScratch(o.scratchRoot, o.store, recovery, c.#unknown.list());
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
    if (s && s !== 'canceling' && s !== 'canceled' && s !== 'completed')
      this.#store.ledger.setRunState(this.#plan.run.id, 'canceling');
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
    const drive = this.#run().finally(() => {
      if (this.#active === drive) this.#active = undefined;
    });
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
      this.#store.ledger.createRun({
        ...structuredClone(this.#plan.run),
        state: 'running',
        coordinatorEpoch: this.#store.epoch,
        createdAt: now(),
      } as RunEnvelope);
    } else if (state === 'completed' || state === 'canceled') {
      return this.#summary();
    } else if (state === 'canceling') {
      this.#cancelRequested = true;
    } else {
      // planned, paused, or a pause an earlier epoch did not finish: run() resumes.
      if (state === 'pausing') {
        this.#store.ledger.setRunState(runId, 'paused');
        state = 'paused';
      }
      if ((state === 'planned' || state === 'paused') && !pauseFirst && !this.#cancelRequested) {
        this.#store.ledger.setRunState(runId, 'running');
      }
    }
    if (pauseFirst && !this.#cancelRequested && this.#runState() !== 'canceling') {
      // A prepared linked run already has a planned row. Honor a setup pause through the same legal states as an
      // ordinary start, without admitting any work or changing the original creation time/budget. Cancel wins.
      if (this.#runState() === 'planned') this.#store.ledger.setRunState(runId, 'running');
      if (this.#runState() === 'running') this.#store.ledger.setRunState(runId, 'pausing');
      this.#pauseRequested = false;
      this.#finishRunState('paused');
      return this.#summary();
    }
    const recorded = this.#store.ledger.getRun(runId)!;
    this.#runDeadline = Date.parse(recorded.envelope.createdAt) + recorded.envelope.budgets.deadlineMs;
    const remaining = this.#runDeadline - Date.now();
    const deadlineTimer = setTimeout(
      () => {
        this.#deadlinePassed = true;
        this.#deadline.abort();
      },
      Math.max(0, Math.min(remaining, 2_147_000_000)),
    );
    if (remaining <= 0) {
      this.#deadlinePassed = true;
      this.#deadline.abort();
    }
    try {
      // The pinned snapshot is restored for this drive only: attempts copy their inputs from it while it lasts, and
      // the drive returns with nothing in flight, so nothing reads it after.
      const restored = this.#plan.restored;
      if (restored && !existsSync(restored)) await restoreSnapshot(this.#store, this.#plan.run.snapshotId, restored);
      try {
        return await this.#drive(runId);
      } finally {
        if (restored) removeOwned(restored);
      }
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  async #drive(runId: Id): Promise<RunSummary> {
    // Unconfirmed cleanup holds admission: a prior worker may still run and hold what a new one would be given.
    const blocked = await this.#awaitCleanup();
    if (blocked.length) return this.#summary(blocked);

    const inflight = new Map<string, Promise<void>>();
    for (;;) {
      const decisions = this.progress();
      await this.#persistHolds(decisions);
      const admitting =
        !this.#pauseRequested &&
        !this.#cancelRequested &&
        !this.#deadlinePassed &&
        this.#runState() === 'running' &&
        this.#pendingNow.length === 0;
      let admitted = 0;
      if (admitting) {
        for (const d of decisions) {
          if (d.state !== 'ready' || inflight.has(key(d.ref))) continue;
          const work = this.#work(d.ref);
          const limits = effectiveLimits(this.#plan.unitOf(d.ref).adapter!.limits, work.resources);
          const reservation = this.#pool.tryReserve(key(d.ref), { memoryBytes: limits.memoryBytes, cpus: limits.cpus });
          if (!reservation) break;
          const task = this.#unit(work).finally(() => {
            this.#pool.release(reservation);
            inflight.delete(key(d.ref));
          });
          inflight.set(key(d.ref), task);
          admitted++;
        }
      }
      if (inflight.size === 0) {
        if (this.#cancelRequested) {
          this.#finishRunState('canceled');
          break;
        }
        if (this.#deadlinePassed && this.#runState() === 'running') {
          await this.#expire();
          break;
        }
        if (this.#pendingNow.length) {
          const still = await this.#awaitCleanup();
          if (still.length) return this.#summary(still);
          continue;
        }
        if (this.#pauseRequested || this.#runState() === 'pausing') {
          this.#finishRunState('paused');
          this.#pauseRequested = false;
          break;
        }
        const final = this.progress();
        if (final.every((d) => ['published', 'failed', 'blocked', 'disabled'].includes(d.state))) {
          await this.#persistHolds(final);
          const failed = !final.every((d) => d.state === 'published' || d.state === 'disabled');
          // A published bootstrap leaves the run running: its analysis revision is planned from what it published.
          if (this.#plan.admitted.plan.kind === 'bootstrap' && !failed) break;
          // Exit codes prove nothing about coverage: the outcome is PR 06's evaluation of the coverage records alone.
          const coverage = this.#plan.admitted.plan.kind === 'analysis' ? this.#requiredCoverage() : null;
          const outcome: RunOutcome = failed
            ? 'execution-failure'
            : final.every((d) => d.state === 'published') && coverage?.complete === true
              ? 'complete-coverage'
              : 'partial-coverage';
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
      if (!row && work.dependencies.some((dep) => !this.#store.ledger.getWork(dep))) continue;
      if (!row) await this.#create(work, 'pending');
      const current = this.#store.ledger.getWork(d.ref)!;
      if (['pending', 'ready'].includes(current.state))
        this.#store.ledger.setWorkState(d.ref, 'blocked', { reasonCode: 'sentinel.execution.runDeadline' });
    }
    this.#store.ledger.setRunState(this.#plan.run.id, 'completed', { outcome: 'execution-failure' });
  }

  /** What recovery could not confirm and nobody acknowledged: each one blocks admission. */
  #outstanding(): string[] {
    const r = this.recovery;
    return [
      ...this.#pendingNow.map((i) => `pending container create ${i.name}`),
      ...r.pendingIntents.map((i) => `pending container create ${i.name}`),
      ...r.uncertain.map((c) => `container ${c} not confirmed removed`),
      ...r.obligations.map((o) => `worker ${o.pid || '?'} of attempt ${o.attempt}: ${o.reason}`),
      ...r.unresolved.map((u) => `unreadable ${u.journal} record ${u.file}: ${u.reason}`),
    ];
  }

  /** Re-check unconfirmed cleanup about once a second, up to cleanupWaitMs; returns what still blocks. */
  async #awaitCleanup(): Promise<string[]> {
    const deadline = Date.now() + this.#cleanupWaitMs;
    for (;;) {
      const left = this.#outstanding();
      if (left.length === 0 || this.#cancelRequested) return left;
      if (Date.now() >= deadline) return left;
      await new Promise((r) => setTimeout(r, Math.min(1_000, Math.max(0, deadline - Date.now()))));
      this.recovery = await recoverStore(this.#store, {
        intents: this.#intents,
        workers: this.#workers,
        ...(this.#service.backend ? { backend: this.#service.backend } : {}),
      });
      for (const intent of [...this.#pendingNow]) {
        const r = await this.#service.backend?.settleIntent(intent).catch(() => 'uncertain' as const);
        if (r === 'removed') {
          this.#intents.settle(intent);
          this.#pendingNow.splice(this.#pendingNow.indexOf(intent), 1);
        }
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
      if (!row && work.dependencies.some((dep) => !this.#store.ledger.getWork(dep))) continue;
      if (!row) {
        await this.#create(work, 'pending');
        row = this.#store.ledger.getWork(d.ref)!;
      }
      const reason =
        planReason(work) ?? (want === 'disabled-by-policy' ? 'sentinel.execution.planInvalid' : DEPENDENCY_FAILED);
      if (['pending', 'ready', 'blocked'].includes(row.state))
        this.#store.ledger.setWorkState(d.ref, want, { reasonCode: reason });
    }
  }

  #finishRunState(to: 'paused' | 'canceled'): void {
    const s = this.#runState();
    if (to === 'paused' && s === 'running') this.#store.ledger.setRunState(this.#plan.run.id, 'pausing');
    if (to === 'canceled' && s !== 'canceling' && s !== 'canceled')
      this.#store.ledger.setRunState(this.#plan.run.id, 'canceling');
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
    const records = await this.#stageRecords(`manifest.${work.id}.${work.revision}`, [
      { value: manifest, schema: 'sentinel-influence/draft-1', privacy: 'source-derived' },
    ]);
    try {
      this.#store.ledger.createWork(
        {
          ...rest,
          state,
          activeAttemptId: null,
          coordinatorEpoch: this.#store.epoch,
          createdAt: now(),
        } as WorkEnvelope,
        { records },
      );
    } catch (error) {
      this.#abortStage(records.stageId);
      throw error;
    }
  }

  /** Stage canonical records unbound under this epoch and store their bytes; the first links the rest. */
  async #stageRecords(
    tag: string,
    values: Array<
      ({ value: unknown; schema: string } | { bytes: Uint8Array; schema: string }) & {
        privacy?: 'metadata' | 'source-derived' | 'source';
      }
    >,
    stillWithin?: () => void,
  ): Promise<{ stageId: string; receipts: Awaited<ReturnType<SentinelStore['objects']['putCanonicalJson']>>[] }> {
    const ids = values.map((v) =>
      'bytes' in v
        ? {
            id: `sha256:${createHash('sha256').update(v.bytes).digest('hex')}` as ArtifactId,
            rawSize: v.bytes.byteLength,
          }
        : this.#store.objects.identifyCanonicalJson(v.value),
    );
    const stageId =
      `${tag}.${createHash('sha256').update(`${this.#store.epoch}\u0000${tag}\u0000${Date.now()}\u0000${Math.random()}`).digest('hex').slice(0, 16)}`.slice(
        0,
        128,
      );
    const unique = ids
      .map((id, i) => ({ id, i }))
      .filter((x, j, all) => all.findIndex((y) => y.id.id === x.id.id) === j);
    this.#store.ledger.registerStaging(
      stageId,
      unique.map(({ id, i }) => ({
        id: id.id,
        schema: values[i]!.schema.slice(0, 128),
        privacy: values[i]!.privacy ?? 'metadata',
        ...(i === 0 ? { links: unique.filter((u) => u.i !== 0).map((u) => u.id.id) } : {}),
      })),
    );
    try {
      const receipts = [];
      for (const { id, i } of unique) {
        stillWithin?.();
        const v = values[i]!;
        receipts.push(
          'bytes' in v
            ? await this.#store.objects.put(Buffer.from(v.bytes), {
                expect: { id: id.id as ArtifactId, rawSize: id.rawSize },
              })
            : await this.#store.objects.putCanonicalJson(v.value, { expect: id as never }),
        );
        stillWithin?.();
      }
      return { stageId, receipts };
    } catch (error) {
      this.#abortStage(stageId);
      throw error;
    }
  }

  #abortStage(stageId: string): void {
    try {
      this.#store.assertHeld();
      this.#store.ledger.abortStaging(stageId);
    } catch {
      /* recovery aborts a stage left open */
    }
  }

  /** One attempt of one unit, from creating its work revision to publishing or ending it. Never throws. */
  async #unit(work: Readonly<WorkEnvelope>): Promise<void> {
    const ref: WorkRef = { id: work.id, revision: work.revision };
    let attemptId: Id | null = null;
    let outcome: WorkerOutcome | undefined;
    let prepDir: string | null = null;
    let stillWithin: (() => void) | undefined;
    try {
      const row = this.#store.ledger.getWork(ref);
      if (!row) await this.#create(work, 'ready');
      else if (row.state === 'pending') this.#store.ledger.setWorkState(ref, 'ready');
      const ordinal = this.#store.ledger.countAttempts(ref) + 1;
      const id = attemptIdFor(ref, ordinal);
      const executable = this.#plan.unitOf(ref);
      if (executable.adapter!.kind === 'operation') {
        attemptId = await this.#operation(work, ordinal, id);
        return;
      }
      // One monotonic deadline covers preparation, launch, execution, normalization and durable acceptance.
      // Driver work never earns a fresh grant for the worker or for publication.
      const t0 = performance.now();
      const unitDeadlineAt = t0 + work.resources.deadlineMs;
      const unitDeadline = AbortSignal.timeout(work.resources.deadlineMs);
      const elapsedDeadline = new AbortController();
      const signal = AbortSignal.any([
        this.#cancel.signal,
        this.#deadline.signal,
        unitDeadline,
        elapsedDeadline.signal,
      ]);
      stillWithin = () => {
        if (this.#cancel.signal.aborted)
          throw new ExecutionError('sentinel.execution.canceled', { reason: 'canceled before acceptance' });
        if (this.#deadlinePassed || Date.now() >= this.#runDeadline) {
          this.#deadlinePassed = true;
          this.#deadline.abort();
          throw new ExecutionError('sentinel.execution.runDeadline', {
            reason: 'the run deadline passed before acceptance',
          });
        }
        if (unitDeadline.aborted || performance.now() >= unitDeadlineAt) {
          // The monotonic boundary can precede delivery of the timeout event; notify driver work before refusing.
          elapsedDeadline.abort(new DOMException('unit deadline elapsed', 'TimeoutError'));
          throw new ExecutionError('sentinel.execution.deadlineExceeded', {
            deadlineMs: work.resources.deadlineMs,
            elapsedMs: Math.round(performance.now() - t0),
          });
        }
      };
      stillWithin();
      // A trusted check driver prepares the exact job and auxiliary inputs; the source inputs stay the plan's own.
      const driver = this.#drivers?.driverFor(executable.adapter!.id);
      const prepared = driver ? await this.#prepare(driver, executable, id, signal, stillWithin) : null;
      prepDir = prepared?.dir ?? null;
      stillWithin();
      const binding = prepared ? prepared.binding : this.#plan.bindingOf(ref);
      const inputs = prepared ? prepared.inputs : executable.inputs;
      // The attempt's deadline is the work's, cut to what is left of the run's budget.
      const left = Math.max(
        1,
        Math.floor(Math.min(unitDeadlineAt - performance.now(), this.#runDeadline - Date.now())),
      );
      const resources = { ...structuredClone(work.resources), deadlineMs: Math.min(work.resources.deadlineMs, left) };
      let invocation: { digest: string; record: InvocationRecord } | undefined;
      outcome = await this.#service.run({
        adapterId: executable.adapter!.id,
        attemptId: id,
        work: ref,
        inputs,
        ...(prepared &&
        executable.adapter!.kind === 'built-in' &&
        Object.hasOwn(BUILTIN_WORKERS, executable.adapter!.id)
          ? { job: prepared.binding.derived!.job }
          : {}),
        assignment: {
          checks: executable.checks.map((c) => c.id),
          scopes: [...executable.unit.scopes],
          inputScopes: executable.inputScopes.map((x) => ({ input: x.input, scopes: [...x.scopes] })),
        },
        signal,
        intents: this.#intents,
        workers: this.#workers,
        resources,
        ...(this.#hooks
          ? { hooks: { at: (b: 'before-spawn' | 'after-spawn') => this.#hooks!.at?.(b, { work: ref, attemptId: id }) } }
          : {}),
        onWorker: async (worker, inv) => {
          stillWithin!();
          invocation = inv;
          // The attempt names its exact invocation record, accepted with its start together with the execution
          // binding it links: a failed, canceled or interrupted attempt keeps both.
          const records = await this.#stageRecords(
            `invocation.${id}`,
            [
              { value: inv.record, schema: 'sentinel-invocation/draft-1', privacy: 'source-derived' },
              { value: binding, schema: EXECUTION_BINDING_SCHEMA },
              ...(prepared?.records ?? []),
            ],
            stillWithin,
          );
          if (
            this.#store.objects.identifyCanonicalJson(inv.record).id !== inv.digest ||
            records.receipts.every((r) => r.id !== bindingId(binding))
          ) {
            this.#abortStage(records.stageId);
            throw new ExecutionError('sentinel.execution.resultMismatch', {
              reason: 'the invocation record is not the one the attempt names',
            });
          }
          try {
            this.#store.ledger.startAttempt(
              {
                schema: 'sentinel-attempt/draft-1',
                id,
                work: ref,
                ordinal,
                coordinatorEpoch: this.#store.epoch,
                operationId: id,
                worker,
                startedAt: now(),
                usage: { certainty: 'not-applicable' },
                state: 'running',
                invocation: inv.digest,
              },
              { records },
            );
          } catch (error) {
            this.#abortStage(records.stageId);
            throw error;
          }
          attemptId = id;
          this.#hooks?.at?.('after-attempt-start', { work: ref, attemptId: id });
          stillWithin!();
        },
      });
      stillWithin();
      const mismatch =
        outcome.state === 'succeeded' && invocation
          ? bindingMismatch(binding, invocation.record, outcome.result!)
          : undefined;
      if (outcome.state === 'succeeded' && attemptId && (mismatch || !invocation)) {
        this.#end(ref, attemptId, 'failed', 'sentinel.execution.resultMismatch', {
          reason: mismatch ?? 'no invocation was recorded',
        });
      } else if (outcome.state === 'succeeded' && attemptId) {
        try {
          // One canonical coverage record per check the plan assigned this unit, at no finer granularity than the
          // trusted adapter establishes; published with the result.
          // A driver normalizes the verified result (before the work folder is released) into the coverage view
          // and records published with it; without one, the result's own coverage claims are read.
          const out = deepFreeze(outcome);
          const normalized = driver
            ? await driver.normalize(prepared!.context, {
                outcome: out,
                result: out.result!,
                outputs: out.outputs,
                workDir: out.workDir,
                job: prepared!.job,
                binding: deepFreeze(binding),
                output: (oid: ArtifactId) => {
                  const o = out.outputs.find((x) => x.id === oid);
                  if (!o)
                    throw new ExecutionError('sentinel.execution.outputMismatch', { reason: 'not a verified output' });
                  const bytes = readFileSync(o.path);
                  if (
                    bytes.length !== o.bytes ||
                    `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== o.id
                  ) {
                    throw new ExecutionError('sentinel.execution.outputMismatch', {
                      reason: 'the normalized output is not its verified bytes',
                    });
                  }
                  return bytes;
                },
                sealed: (sid: ArtifactId) => {
                  const m = /^sha256:([0-9a-f]{64})$/.exec(sid);
                  if (!m) return undefined;
                  try {
                    return readFileSync(join(out.workDir, 'input', m[1]!));
                  } catch {
                    return undefined;
                  }
                },
              })
            : null;
          stillWithin();
          const view = normalized ? { ...outcome.result!, ...normalized.coverage } : outcome.result!;
          if (normalized?.coverage.actualReadSet !== undefined) {
            const read = normalized.coverage.actualReadSet;
            const allowed = new Set(
              executable.inputScopes.flatMap((i) => {
                const source = executable.unit.inputs.find((s) => s.content === i.input);
                if (!source || !executable.inputs.some((s) => s.id === i.input)) return [];
                const path = join(out.workDir, 'input', i.input.slice(7));
                let bytes: Buffer;
                try {
                  bytes = readFileSync(path);
                } catch {
                  throw new ExecutionError('sentinel.execution.inputMismatch', {
                    reason: 'a normalized read names no sealed source input',
                  });
                }
                if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== i.input)
                  throw new ExecutionError('sentinel.execution.inputMismatch', {
                    reason: 'a normalized read does not name the sealed source bytes',
                  });
                return i.scopes.filter((scope) => executable.unit.scopes.includes(scope));
              }),
            );
            if (
              new Set(read).size !== read.length ||
              read.some((scope) => !allowed.has(scope)) ||
              normalized.coverage.scannedSet.some((scope) => !read.includes(scope))
            ) {
              throw new ExecutionError('sentinel.execution.resultMismatch', {
                reason: 'the normalized read set is outside sealed source scopes or omits a scanned scope',
              });
            }
          }

          const coverage = coverageRecords({
            runId: this.#plan.run.id,
            attemptId,
            work: ref,
            checks: executable.checks,
            scopes: this.#scopes,
            adapterGranularity: executable.adapter!.coverage,
            result: view,
            recordedAt: now(),
          });
          await publishOutcome({
            store: this.#store,
            work: ref,
            attemptId,
            result: outcome.result!,
            outputs: outcome.outputs,
            endedAt: now(),
            records: [...coverage.records, ...(normalized?.records ?? [])],
            ...(this.#hooks ? { hooks: { at: (b, c) => this.#hooks!.at?.(b, c) } } : {}),
            beforeAccept: stillWithin,
          });
          this.#coverage.set(key(ref), coverage.envelopes);
        } catch (caught) {
          let error = caught;
          try {
            stillWithin();
          } catch (boundary) {
            error = boundary;
          }
          const canceled =
            (error instanceof LedgerError && error.code === 'sentinel.store.wrongState') ||
            isExecutionError(error, 'sentinel.execution.canceled');
          this.#end(
            ref,
            attemptId,
            canceled ? 'canceled' : 'failed',
            canceled ? 'sentinel.execution.canceled' : codeOf(error),
            detailOf(error),
          );
        }
      } else if (attemptId && this.#deadlinePassed && !this.#cancelRequested) {
        this.#end(ref, attemptId, 'failed', 'sentinel.execution.runDeadline', outcome.detail);
      } else if (attemptId) {
        const refusal = closureRefusalOf(executable.adapter, driver, outcome);
        this.#end(
          ref,
          attemptId,
          outcome.state === 'canceled' ? 'canceled' : 'failed',
          refusal?.code ?? outcome.code ?? 'sentinel.execution.workerExited',
          refusal?.detail ?? outcome.detail,
        );
      } else {
        this.#unstarted(ref, outcome.code ?? 'sentinel.execution.workerExited', outcome.detail);
      }
    } catch (caught) {
      let error = caught;
      // A late driver error cannot hide the budget or cancellation that already ended this unit.
      try {
        stillWithin?.();
      } catch (boundary) {
        error = boundary;
      }
      if (attemptId)
        this.#end(
          ref,
          attemptId,
          isExecutionError(error, 'sentinel.execution.canceled') ? 'canceled' : 'failed',
          codeOf(error),
          detailOf(error),
        );
      else this.#unstarted(ref, codeOf(error), detailOf(error));
    } finally {
      if (outcome) {
        try {
          releaseWorkDir(outcome.workDir);
        } catch {
          /* left for an explicit cleanup */
        }
      }
      if (prepDir) {
        try {
          removeOwned(prepDir);
        } catch {
          /* left for an explicit cleanup */
        }
      }
    }
  }

  /**
   * Run a driver's prepare for one attempt: the job as canonical JSON and its auxiliary files become extra inputs,
   * each hashed here, and the execution binding records the plan's exact source inputs apart from them.
   */
  async #prepare(
    driver: CheckDriver,
    executable: ReturnType<ValidatedPlan['unitOf']>,
    attemptId: Id,
    signal: AbortSignal,
    stillWithin: () => void,
  ) {
    const dir = join(this.#scratchRoot, `${PREP_PREFIX}${attemptId}.${randomUUID()}`);
    mkdirSync(dir, { mode: 0o700 });
    try {
      return await this.#prepareIn(dir, driver, executable, signal, stillWithin);
    } catch (error) {
      removeOwned(dir);
      throw error;
    }
  }

  async #prepareIn(
    dir: string,
    driver: CheckDriver,
    executable: ReturnType<ValidatedPlan['unitOf']>,
    signal: AbortSignal,
    stillWithin: () => void,
  ) {
    const context: DriverContext = Object.freeze({
      signal,
      analysis: driver.reads?.analysis
        ? await retainedAnalysisFor(
            this.#store,
            this.#plan,
            executable.unit,
            this.#plan.admitted.profile,
            signal,
            stillWithin,
          )
        : null,
      plan: this.#plan.admitted.plan,
      ...(this.#plan.admitted.pathRequest ? { pathRequest: this.#plan.admitted.pathRequest } : {}),
      unit: executable.unit,
      checks: executable.checks,
      profile: this.#plan.admitted.profile,
      inputs: executable.inputs,
      inputScopes: executable.inputScopes,
      rules: this.#rulesOf(executable.checks),
      tools: this.#plan.admitted.plan.pins.tools
        .filter((t) => t.adapterId === executable.unit.adapterId)
        .map((t) => ({ ...t })),
      databases: this.#plan.admitted.plan.pins.databases.map((pin) => {
        const copy = this.#databases.find(
          (d) => d.databaseId === pin.databaseId && d.snapshotDigest === pin.snapshotDigest,
        );
        if (!copy)
          throw new ExecutionError('sentinel.execution.inputMismatch', {
            reason: `no admitted copy of database ${pin.databaseId}`,
          });
        if (fileDigest(copy.path) !== pin.snapshotDigest)
          throw new ExecutionError('sentinel.execution.inputMismatch', {
            reason: `database ${pin.databaseId} is not the pinned snapshot`,
          });
        return { databaseId: pin.databaseId, snapshotDigest: pin.snapshotDigest, path: copy.path };
      }),
      restored: this.#plan.restored,
      workDir: dir,
    });
    stillWithin();
    const job = await driver.prepare(context);
    stillWithin();
    const jobBytes = canonicalJsonBytes(job.job);
    const jobPath = join(dir, 'sentinel-job.json');
    writeFileSync(jobPath, jobBytes, { mode: 0o600 });
    const jobId = this.#store.objects.identifyCanonicalJson(job.job).id as ArtifactId;
    const auxiliary = job.auxiliary.map((a) => {
      const s = lstatSync(a.path);
      if (!s.isFile() || s.isSymbolicLink())
        throw new ExecutionError('sentinel.execution.inputMismatch', {
          reason: 'a prepared input is not a regular file',
        });
      return { id: fileDigest(a.path) as ArtifactId, path: a.path, role: String(a.role).slice(0, 64) };
    });
    verifyRetainedAuxiliary(context.analysis, auxiliary);
    const base = this.#plan.bindingOf(executable.work);
    const extra = [{ id: jobId, path: jobPath }, ...auxiliary.map((a) => ({ id: a.id, path: a.path }))];
    const inputs = [...executable.inputs, ...extra].filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i);
    const ids = inputs.map((i) => i.id).sort();
    const binding: ExecutionBinding = {
      ...base,
      inputs: ids,
      protocolFingerprint: inputFingerprintOf(ids),
      sourceInputs: [...base.inputs],
      derived: {
        job: jobId,
        auxiliary: auxiliary.map((a) => ({ id: a.id, role: a.role })),
        ...(context.analysis ? { analysis: retainedBinding(context.analysis) } : {}),
      },
    };
    const records = [
      { value: job.job, schema: 'sentinel-check-job/draft-1', privacy: 'source-derived' as const },
      ...auxiliary.map((a) => ({
        bytes: readFileSync(a.path),
        schema: `sentinel-check-input/${a.role}`.slice(0, 128),
        privacy: a.role === 'analysis-artifact' ? ('source' as const) : ('source-derived' as const),
      })),
    ];
    return { dir, context, binding, inputs, records, job: job.job };
  }

  /** The resolved rules (with verified pack file bytes) of exactly these checks, under the plan's pinned lock. */
  #rulesOf(checks: readonly { familyId: string }[]): RuleFiles[] {
    const lock = this.#plan.admitted.ruleLock;
    const pin = this.#plan.admitted.plan.pins.ruleLockDigest;
    if (!lock || !pin || !this.#packs?.length) return [];
    const families = [...new Set(checks.map((c) => c.familyId))];
    const resolved = resolveLockedRules(
      lock,
      pin,
      this.#packs.map((p) => p.pack),
      families,
    );
    return resolved.map((rule) => {
      const pack = this.#packs!.find((p) => p.pack.packDigest === rule.packDigest)!;
      const d = rule.definition;
      const named = [d.implementation.rulePath, ...d.fixtures.positive, ...d.fixtures.negative];
      const files = named.map((path) => {
        const listed = pack.pack.files.find((f) => f.path === path);
        const bytes = pack.files.get(path);
        if (!listed || !bytes || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== listed.digest) {
          throw new ExecutionError('sentinel.execution.inputMismatch', {
            reason: `pack file ${path} is not the bytes the lock pins`,
          });
        }
        return { path, digest: listed.digest, bytes };
      });
      return { rule, files };
    });
  }

  #end(
    ref: WorkRef,
    attemptId: Id,
    state: 'failed' | 'canceled',
    code: string,
    detail?: Readonly<Record<string, unknown>>,
  ): void {
    this.#failures.push({ work: ref, attemptId, code, ...(detail ? { detail } : {}) });
    let attempts = 1;
    try {
      attempts = this.#store.ledger.countAttempts(ref);
    } catch {
      /* the store is gone; the end below fails too */
    }
    const again = retryable(code, attempts, this.#retry);
    // A canceled attempt leaves its work ready: cancellation is the run's decision, not the work's failure.
    const workState = state === 'canceled' || again ? 'ready' : 'failed';
    try {
      this.#store.ledger.endAttempt({
        work: ref,
        attemptId,
        state,
        endedAt: now(),
        workState,
        error: { code: catalogCode(code), retryable: again, ...(detail ? { detail: boundedDetail(detail) } : {}) },
      });
    } catch (error) {
      // Fenced off (a newer epoch, or the attempt already ended): that coordinator's recovery owns it now.
      this.#failures.push({ work: ref, attemptId, code: codeOf(error) });
    }
  }

  #unstarted(ref: WorkRef, code: string, detail?: Readonly<Record<string, unknown>>): void {
    this.#failures.push({ work: ref, attemptId: null, code, ...(detail ? { detail } : {}) });
    // A create that may still commit: hold admission until its container is confirmed absent, then try the unit again.
    if (code === 'sentinel.execution.reconciliationPending' && detail && typeof detail.owner === 'string') {
      this.#pendingNow.push({
        name: String(detail.name),
        owner: String(detail.owner),
        store: String(detail.store),
        attempt: String(detail.attempt),
        epoch: String(detail.epoch),
        invocation: String(detail.invocation),
      });
      return;
    }
    // Refused before any worker acted (an unknown adapter, a mismatched input, a pending create): not retried here.
    if (!this.#cancelRequested && !this.#pauseRequested) {
      this.#failedUnstarted.set(key(ref), code);
      this.#holdRefusedModelUnit(ref, code);
    }
  }

  /**
   * A model unit refused before its attempt (its admitted inputs no longer hold, a secret is known, an input is
   * withheld or missing) is held in the ledger with that reason, so status and the report can say why it did not
   * run; the refusal is never only in this process's memory. Other units keep their unstarted handling.
   */
  #holdRefusedModelUnit(ref: WorkRef, code: string): void {
    try {
      const unit = this.#plan.unitOf(ref).unit;
      if (!(unit.review || unit.contract === SCRIPT_CONTRACT) || !CATALOG.test(code)) return;
      const row = this.#store.ledger.getWork(ref);
      if (row && ['pending', 'ready'].includes(row.state))
        this.#store.ledger.setWorkState(ref, 'blocked', { reasonCode: code.slice(0, 128) });
    } catch {
      /* the run ended or the store is gone: the in-memory refusal above still ends this unit here */
    }
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
  /**
   * A host script unit's declared stage, entry digest and entry bytes, before anything is recorded: the run's
   * recorded pipeline names the stage, the adopted settings must turn host scripts on, and the entry supplied must be
   * the bytes the profile pins. Any of these failing refuses the unit before its attempt (and holds it with why).
   */
  #scriptOf(unit: Readonly<import('../contracts/plan.js').PlanWork>): {
    stage: ScriptStageDefinition;
    digest: string;
    entry: Uint8Array;
  } {
    const profile = this.#plan.admitted.profile;
    const stage = profile.pipeline?.stages.find((s) => s.id === unit.stage && s.kind === 'script') as
      ScriptStageDefinition | undefined;
    const pinned = profile.scripts?.find((s) => s.stage === unit.stage);
    if (!stage || !pinned)
      throw new ExecutionError('sentinel.execution.planInvalid', {
        reason: `script unit ${unit.id} has no declared stage and entry in its run's profile`,
      });
    if (stage.runner === 'host' && !featureEnabled(this.#plan.admitted.policy?.settings ?? null, 'stage.host-scripts'))
      throw new ExecutionError('sentinel.execution.featureOff', { feature: 'stage.host-scripts' });
    if (stage.runner !== 'host')
      throw new ExecutionError('sentinel.execution.isolationUnavailable', {
        reason: 'a script-runner container is not available in this build',
      });
    return { stage, digest: pinned.digest, entry: checkEntry(this.#scripts?.get(pinned.digest), pinned.digest) };
  }

  async #operation(work: Readonly<WorkEnvelope>, ordinal: number, id: Id): Promise<Id> {
    const ref: WorkRef = { id: work.id, revision: work.revision };
    const executable = this.#plan.unitOf(ref);
    const adapter = executable.adapter!;
    if (adapter.kind !== 'operation')
      throw new ExecutionError('sentinel.execution.planInvalid', { reason: 'not an operation' });
    const profile = this.#plan.admitted.profile;
    const review = executable.unit.review
      ? await prepareAdmittedReview(this.#store, this.#plan, ref, this.#review)
      : undefined;
    const script = adapter.operation === 'script' ? this.#scriptOf(executable.unit) : undefined;
    // A declared stage that reads other stages' outputs is bound to their exact published artifacts, folded for
    // secrets first; the binding is sealed in the invocation record accepted with the attempt's start.
    const stageInputs = review || script ? await stageInputsForUnit(this.#store, this.#plan.admitted, ref) : undefined;
    const record = {
      format: 'sentinel-operation-invocation/draft-1',
      store: this.#store.storeId,
      attemptId: id,
      work: ref,
      coordinatorEpoch: this.#store.epoch,
      adapter: { id: adapter.id, version: adapter.version, digest: adapter.digest },
      operation: adapter.operation,
      plan: {
        runId: this.#plan.run.id,
        revision: this.#plan.admitted.plan.revision,
        digest: this.#plan.admitted.plan.digest,
      },
      influenceManifest: work.influenceManifest,
      snapshotId: this.#plan.run.snapshotId,
      sourceId: executable.unit.sourceId,
      ...(adapter.operation === 'parse' ? { parse: profile.parse } : {}),
      ...(review ? { review: review.review } : {}),
      ...(stageInputs ? { stageInputs } : {}),
      ...(script
        ? {
            script: {
              stage: script.stage.id,
              runner: script.stage.runner,
              entry: script.stage.entry,
              entryDigest: script.digest,
              interpreter: script.stage.interpreter,
              args: [...(script.stage.args ?? [])],
              environmentNames: [],
            },
          }
        : {}),
    };
    const invocation = this.#store.objects.identifyCanonicalJson(record).id as ArtifactId;
    const records = await this.#stageRecords(`invocation.${id}`, [
      { value: record, schema: 'sentinel-operation-invocation/draft-1', privacy: 'source-derived' },
      ...(review
        ? [{ value: review.admission, schema: 'sentinel-admission/draft-1', privacy: 'source-derived' as const }]
        : []),
      // The exact entry the attempt runs is retained with its start, so the run keeps what ran without its pack.
      ...(script ? [{ bytes: script.entry, schema: 'sentinel-script-entry/draft-1', privacy: 'source' as const }] : []),
    ]);
    try {
      this.#store.ledger.startAttempt(
        {
          schema: 'sentinel-attempt/draft-1',
          id,
          work: ref,
          ordinal,
          coordinatorEpoch: this.#store.epoch,
          operationId: id,
          worker: { kind: 'coordinator-operation', adapterId: adapter.id, adapterDigest: adapter.digest },
          startedAt: now(),
          usage: { certainty: review ? 'unknown' : 'not-applicable' },
          state: 'running',
          invocation,
        },
        { records },
      );
    } catch (error) {
      this.#abortStage(records.stageId);
      throw error;
    }
    this.#hooks?.at?.('after-attempt-start', { work: ref, attemptId: id });
    // The unit's grant holds the operation as it holds a worker: its deadline (cut to what is left of the run's),
    // the process memory it may add and the CPU time it may use. The operation only prepares; nothing is published
    // unless every bound held and the run was not canceled or expired meanwhile. maxOutputBytes bounds a worker's
    // process output (stdout and stderr); an operation has none, so it holds trivially. The size of what it retains
    // is a separate contract: the store's object cap and the parser's own pinned limits, enforced where they apply.
    const grant = work.resources;
    const deadlineMs = Math.max(1, Math.min(grant.deadlineMs, Math.floor(this.#runDeadline - Date.now())));
    const deadlineAt = Date.now() + deadlineMs;
    const own = AbortSignal.timeout(deadlineMs);
    const memory = new AbortController();
    const signal = AbortSignal.any([this.#cancel.signal, this.#deadline.signal, own, memory.signal]);
    const baseline = process.memoryUsage().rss;
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    let peak = 0;
    const sample = () => {
      peak = Math.max(peak, process.memoryUsage().rss - baseline);
      if (peak > grant.memoryBytes) memory.abort();
    };
    const sampler = setInterval(sample, 20);
    let prepared: Awaited<ReturnType<typeof runOperation>> | undefined;
    let failure: unknown;
    try {
      prepared = review
        ? await runReviewWithInputs(this.#store, this.#plan, ref, id, review, signal, deadlineAt, stageInputs)
        : script
          ? await runHostScript({
              store: this.#store,
              stage: script.stage,
              unit: ref,
              attemptId: id,
              invocation,
              entry: script.entry,
              entryDigest: script.digest,
              inputs: stageInputs ?? [],
              scratchRoot: this.#scratchRoot,
              signal,
              deadlineMs,
              maxOutputBytes: grant.maxOutputBytes,
            })
          : await runOperation(adapter.operation as import('./registry.js').BootstrapOperation, {
              store: this.#store,
              run: this.#plan.run,
              plan: this.#plan.admitted.plan,
              unit: executable.unit,
              profile,
              attemptId: id,
              scratchRoot: this.#scratchRoot,
              signal,
            });
    } catch (error) {
      failure = error;
    } finally {
      clearInterval(sampler);
      sample();
    }
    const wallMs = performance.now() - t0;
    const used = process.cpuUsage(cpu0);
    const cpuMs = (used.user + used.system) / 1000;
    // Checked in this order; the first that applies ends the attempt without a publication.
    const refusal: [string, Record<string, unknown>] | null = this.#cancel.signal.aborted
      ? ['sentinel.execution.canceled', {}]
      : this.#deadlinePassed || this.#deadline.signal.aborted
        ? ['sentinel.execution.runDeadline', {}]
        : own.aborted || wallMs > deadlineMs
          ? ['sentinel.execution.deadlineExceeded', { deadlineMs, elapsedMs: Math.round(wallMs) }]
          : memory.signal.aborted || peak > grant.memoryBytes
            ? ['sentinel.execution.resourceExceeded', { resource: 'memory', limit: grant.memoryBytes, observed: peak }]
            : // The process's CPU time over the operation (its own GC and I/O threads included), against the quota.
              cpuMs > grant.cpuQuota * wallMs + CPU_SLACK_MS
              ? [
                  'sentinel.execution.resourceExceeded',
                  { resource: 'cpu', quota: grant.cpuQuota, cpuMs: Math.round(cpuMs), wallMs: Math.round(wallMs) },
                ]
              : null;
    if (refusal) {
      this.#end(ref, id, refusal[0] === 'sentinel.execution.canceled' ? 'canceled' : 'failed', refusal[0], refusal[1]);
      return id;
    }
    if (failure) {
      this.#end(ref, id, 'failed', codeOf(failure), detailOf(failure));
      return id;
    }
    // The bounds are checked again after every object write, immediately before the ledger accepts: an operation
    // whose unit or run deadline passed while its objects were being stored is never published.
    const unitDeadlineAt = t0 + deadlineMs;
    const stillWithin = () => {
      if (this.#cancel.signal.aborted)
        throw new ExecutionError('sentinel.execution.canceled', { reason: 'canceled before acceptance' });
      if (this.#deadlinePassed || Date.now() >= this.#runDeadline)
        throw new ExecutionError('sentinel.execution.runDeadline', {
          reason: 'the run deadline passed before acceptance',
        });
      if (performance.now() >= unitDeadlineAt)
        throw new ExecutionError('sentinel.execution.deadlineExceeded', {
          deadlineMs,
          elapsedMs: Math.round(performance.now() - t0),
        });
    };
    try {
      await publishPrepared(this.#store, ref, id, prepared!, stillWithin);
    } catch (error) {
      const canceled =
        (error instanceof LedgerError && error.code === 'sentinel.store.wrongState') ||
        isExecutionError(error, 'sentinel.execution.canceled');
      this.#end(
        ref,
        id,
        canceled ? 'canceled' : 'failed',
        canceled ? 'sentinel.execution.canceled' : codeOf(error),
        detailOf(error),
      );
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
      const outs = this.#store.ledger.getPublication(ref)?.outputs.filter((o) => o.schema === COVERAGE_SCHEMA);
      if (!outs) continue;
      const records: CoverageEnvelope[] = [];
      for (const o of outs) {
        try {
          records.push(JSON.parse((await this.#store.readArtifact(o.id)).toString('utf8')) as CoverageEnvelope);
        } catch {
          /* missing */
        }
      }
      this.#coverage.set(key(ref), records);
    }
  }

  #work(ref: WorkRef): Readonly<WorkEnvelope> {
    return this.#plan.works.find((w) => w.id === ref.id && w.revision === ref.revision)!;
  }

  #committed(): Map<string, CommittedUnit> {
    const m = new Map<string, CommittedUnit>();
    for (const w of this.#plan.works) {
      const ref = { id: w.id, revision: w.revision };
      const row = this.#store.ledger.getWork(ref);
      const attempts = row ? this.#store.ledger.countAttempts(ref) : 0;
      const unstarted = this.#failedUnstarted.get(key(ref));
      const planHold = w.state === 'disabled-by-policy' || w.state === 'blocked' ? w.state : undefined;
      if (unstarted) {
        m.set(key(ref), { created: !!row, workState: 'failed', attempts, lastFailure: unstarted });
        continue;
      }
      if (!row && planHold) {
        m.set(key(ref), { created: false, workState: planHold, attempts: 0 });
        continue;
      }
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
    for (const w of this.#plan.works)
      if (this.#store.ledger.getPublication({ id: w.id, revision: w.revision })) published++;
    const kind = this.#plan.admitted.plan.kind;
    const coverage = kind === 'analysis' ? this.#requiredCoverage() : null;
    return {
      runId: this.#plan.run.id,
      state: run?.state ?? 'planned',
      ...(run?.outcome ? { outcome: run.outcome } : {}),
      units,
      failures: [...this.#failures],
      recovery: this.recovery,
      published,
      blockedByCleanup,
      kind,
      planRevision: this.#plan.admitted.plan.revision,
      coverage,
      coverageRecords: [...this.#coverage.values()].reduce((n, r) => n + r.length, 0),
      unknownCleanup: this.#unknown.list(),
      clean: this.recovery.clean && this.#unknown.list().length === 0,
    };
  }
}

const CATALOG = /^sentinel\.[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;
const catalogCode = (code: string): string => (CATALOG.test(code) ? code : 'sentinel.execution.workerExited');
const planReason = (w: WorkEnvelope): string | undefined =>
  'reasonCode' in w && typeof w.reasonCode === 'string' ? w.reasonCode : undefined;
const codeOf = (e: unknown): string =>
  (isExecutionError(e) || e instanceof LedgerError ? e.code : (e as { code?: string })?.code) ??
  'sentinel.execution.workerExited';
const detailOf = (e: unknown): Readonly<Record<string, unknown>> | undefined =>
  isExecutionError(e) ? e.detail : undefined;

/** The detail as recorded: safe structured context only, cut to a bound rather than refused. */
function boundedDetail(detail: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const plain = JSON.parse(JSON.stringify(detail)) as Record<string, unknown>;
  return canonicalJsonBytes(plain).byteLength <= MAX_DETAIL_BYTES
    ? plain
    : { truncated: true, keys: Object.keys(plain).slice(0, 16) };
}
