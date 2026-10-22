// The command line's canonical path over a store this process holds: plan and run exactly what the coordinator
// admits. Nothing here plans, schedules or evaluates coverage itself; it calls PR 06's planner and PR 08's admission,
// bootstrap operations and coordinator, in their order:
//
//   plan  capture the workspace (admitted as capture.source by the caller) → admit the bootstrap revision → the
//         coordinator's own capture, parse and inventory operations publish it → plan the analysis from exactly
//         that published evidence, under the owner's promoted rule lock (resolved against its stored pack bytes) and
//         the adopted policy → admit it with the lock, policy and profile → advance the run to it. Nothing is checked.
//   run   the coordinator executes the run's current admitted revision and records coverage from coverage records.
//
// A run's result is read back from the ledger: its recorded outcome and the coverage its units published. A run
// that rests on the foundation-preview rule is required coverage incomplete whatever it records, and this build
// never prints a satisfied result (findings are not judged against the policy until the full report exists).
import { createHash } from 'node:crypto';
import type { RunEnvelope } from '../contracts/run.js';
import type { PlanRevision } from '../planner/types.js';
import { Coordinator, type RunSummary } from '../execution/coordinator.js';
import { admitPlan, loadPlan } from '../execution/plans.js';
import { loadBootstrap } from '../execution/bootstrap.js';
import type { AdapterRegistry } from '../execution/registry.js';
import { planAnalysis, planBootstrap, plannerAnalysisFrom, plannerLockFrom, plannerPolicyFrom, plannerSnapshotFrom } from '../planner/index.js';
import type { EffectivePolicy } from '../policy/index.js';
import { captureSnapshot } from '../snapshot/capture.js';
import { openSnapshot } from '../snapshot/materialize.js';
import { canonicalJsonBytes } from '../store/objects.js';
import type { SentinelStore } from '../store/index.js';
import { PREVIEW_FINDINGS_SCHEMA, PREVIEW_RULE } from '../adapters/preview-detector.js';
import { result, type CommandResult, type PrintedVerdicts } from '../cli/outcome.js';
import { RuleLockBook } from './rule-locks.js';
import { foundationProfile, foundationRegistry, type TrustedProfile } from './trusted-profile.js';
import { ServiceError } from './owner-service.js';

const digest = (v: unknown) => `sha256:${createHash('sha256').update(canonicalJsonBytes(v)).digest('hex')}`;
export const WORKSPACE_SOURCE = 'workspace';
/** The analysis plans one scope per check unit: the only way a worker can tell which captured file is which scope. */
const ANALYSIS_LIMITS = Object.freeze({ maxScopesPerWork: 1 });

/** What `plan` discloses: the admitted analysis revision and what it will and will not check. */
export interface CanonicalDisclosure {
  readonly planId: string;
  readonly runId: string;
  readonly revision: number;
  readonly planDigest: string;
  readonly snapshotId: string;
  readonly effects: readonly ['local-artifacts'];
  readonly checks: Readonly<Record<string, number>>;
  readonly units: number;
  readonly ruleGaps: number;
  readonly requiredCoverageAchievable: boolean;
  readonly label: 'foundation-preview' | 'deterministic';
}

/** The identity a write on a run is decided against: its current admitted revision. */
export interface CurrentPlan {
  readonly runId: string;
  readonly revision: number;
  readonly planDigest: string;
  readonly policyRevision: string;
  readonly kind: 'bootstrap' | 'analysis';
}

const isPreview = (plan: PlanRevision) => plan.pins.rules.some(r => r.familyId === PREVIEW_RULE);

function disclose(plan: PlanRevision): CanonicalDisclosure {
  return Object.freeze({
    planId: plan.runId, runId: plan.runId, revision: plan.revision, planDigest: plan.digest, snapshotId: plan.pins.snapshotId!,
    effects: Object.freeze(['local-artifacts'] as const), checks: Object.freeze({ ...plan.tallies.checks }), units: plan.units.length,
    ruleGaps: plan.ruleGaps.length, requiredCoverageAchievable: plan.requiredCoverageAchievable,
    label: isPreview(plan) ? 'foundation-preview' as const : 'deterministic' as const,
  });
}

/** The run's current admitted revision, read back and verified; undefined when the run has none. */
export async function currentPlan(store: SentinelStore, runId: string): Promise<CurrentPlan | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) return undefined;
  const revision = store.ledger.getRun(runId)?.planRevision ?? store.ledger.latestPlan(runId)?.revision;
  if (revision === undefined) return undefined;
  const admitted = await loadPlan(store, runId, revision);
  return Object.freeze({ runId, revision, planDigest: admitted.plan.digest, policyRevision: admitted.plan.pins.policyDigest ?? '', kind: admitted.plan.kind });
}

/**
 * Plans the workspace canonically (see the file header). Planning the same content under the same lock, policy and
 * profile again is the same run: its admitted analysis is disclosed again (`kept`), nothing is captured twice.
 */
export async function planWorkspaceCanonical(store: SentinelStore, options: {
  workspace: string; trustDir: string; policy: EffectivePolicy; scratchRoot: string; registry?: AdapterRegistry; parentId?: string | null; now: Date;
  /** Re-plan over this admitted snapshot instead of capturing again (a retry of the run that pinned it). */
  snapshotId?: string;
  /** Test seam: the trusted profile to plan under (the shipped one by default). */
  profile?: TrustedProfile;
}): Promise<{ outcome: 'prepared' | 'kept'; disclosure: CanonicalDisclosure }> {
  const book = new RuleLockBook(options.trustDir);
  const current = book.current();
  if (!current) throw new ServiceError('sentinel.service.noRuleLock');
  const packs = book.packsOf(current.lock);
  const registry = options.registry ?? foundationRegistry();
  const profile = options.profile ?? foundationProfile(registry);
  const snapshot = options.snapshotId !== undefined
    ? (await openSnapshot(store, options.snapshotId)).snapshot
    : (await captureSnapshot(store, {
      mode: 'working-copy', sources: [{ sourceId: WORKSPACE_SOURCE, repositoryId: 'local-workspace', root: options.workspace }],
      policy: { exclude: { '*': ['.farsight'] } },
    })).snapshot;
  // The run is what it would read and do: the captured inventory (not the capture's time), the lock, the policy and
  // the profile. The same content under the same terms plans to the same run.
  const runId = `run-${digest({ inventory: snapshot.inventoryDigest, lock: current.digest, policy: options.policy.revision, profile: profile.digest, parent: options.parentId ?? null }).slice(7, 39)}`;
  const latest = store.ledger.latestPlan(runId);
  if (latest?.kind === 'analysis') return { outcome: 'kept', disclosure: disclose((await loadPlan(store, runId, latest.revision)).plan) };

  const boot = latest ? (await loadPlan(store, runId, 1)).plan : planBootstrap({ runId, sourceIds: [WORKSPACE_SOURCE], profile: profile.planner });
  if (!latest) await admitPlan(store, { plan: boot, ruleLock: null, policy: null, profile: profile.record });
  const recorded = store.ledger.getRun(runId)?.envelope;
  const run: RunEnvelope = recorded ?? {
    schema: 'sentinel-run/draft-1', id: runId, parentId: options.parentId ?? null, baselineId: null, snapshotId: snapshot.id, planRevision: 1,
    coordinatorEpoch: store.epoch, ruleLockDigest: current.digest, toolLockDigest: current.digest, policyRevisionDigest: options.policy.revision,
    requestedScope: { sourceIds: [WORKSPACE_SOURCE], profile: profile.planner.id }, budgets: { maxTokens: null, maxCost: null, deadlineMs: 600_000 },
    createdAt: options.now.toISOString(), state: 'planned',
  } as RunEnvelope;
  // A run whose bootstrap already ended without publishing is finished: it is not run again. Planning the same
  // content again names it, and `rerun` plans a new run after it.
  const ended = recorded && (store.ledger.getRun(runId)?.state === 'completed' || store.ledger.getRun(runId)?.state === 'canceled');
  const booted = ended ? undefined : await (await Coordinator.open({ store, runId, ...(recorded ? {} : { run }), registry, scratchRoot: options.scratchRoot })).run();
  if (!booted || booted.kind !== 'bootstrap' || booted.published < boot.units.length) throw new ServiceError('sentinel.service.bootstrapFailed', { runId });

  const inventory = boot.units.find(u => u.stage === 'inventory')!;
  const evidence = await loadBootstrap(store, runId, { id: inventory.id, revision: inventory.revision });
  const analysis = planAnalysis({
    runId, revision: 2, previous: boot, bootstrap: [{ id: inventory.id, revision: inventory.revision }], profile: profile.planner,
    snapshot: plannerSnapshotFrom(evidence.snapshot), analyses: evidence.analyses.map(a => plannerAnalysisFrom(a as never)),
    lock: plannerLockFrom(current.lock, packs, current.digest), policy: plannerPolicyFrom(options.policy), limits: ANALYSIS_LIMITS,
  });
  await admitPlan(store, { plan: analysis, ruleLock: current.lock, policy: options.policy, profile: profile.record });
  store.ledger.advanceRunPlan(runId, analysis.revision);
  return { outcome: 'prepared', disclosure: disclose(analysis) };
}

/** Executes the run's current admitted revision. The coordinator records coverage and the outcome. */
export async function executeRun(store: SentinelStore, runId: string, options: { scratchRoot: string; registry?: AdapterRegistry; run?: RunEnvelope }): Promise<RunSummary> {
  const coordinator = await Coordinator.open({ store, runId, registry: options.registry ?? foundationRegistry(), scratchRoot: options.scratchRoot, ...(options.run ? { run: options.run } : {}) });
  return coordinator.run();
}

/** Every finding the preview detector published for the run's current revision. */
export async function previewFindingsOf(store: SentinelStore, runId: string): Promise<{ findings: unknown[]; scanned: number; skipped: number } | undefined> {
  const plan = await currentPlan(store, runId);
  if (!plan || plan.kind !== 'analysis') return undefined;
  const admitted = await loadPlan(store, runId, plan.revision);
  let any = false;
  const out = { findings: [] as unknown[], scanned: 0, skipped: 0 };
  for (const u of admitted.plan.units) {
    const pub = store.ledger.getPublication({ id: u.id, revision: u.revision });
    if (!pub) continue;
    for (const o of pub.outputs.filter(x => x.schema === PREVIEW_FINDINGS_SCHEMA || x.schema === 'application/json')) {
      try {
        const v = JSON.parse((await store.readArtifact(o.id as never)).toString('utf8'));
        if (v?.schema !== PREVIEW_FINDINGS_SCHEMA) continue;
        any = true;
        out.findings.push(...v.findings);
        out.scanned += v.scanned.length;
        out.skipped += v.skipped.length;
      } catch { /* another output */ }
    }
  }
  return any ? out : undefined;
}

/**
 * A run's result from the ledger alone. Under way: `submitted` while something executes it, else interrupted. Ended:
 * an execution failure is one; anything resting on the preview rule is required coverage incomplete; otherwise
 * complete coverage still prints required coverage incomplete with the reason that the finding policy is not
 * evaluated here. Never `satisfied`.
 */
export async function canonicalResult(store: SentinelStore, command: string, runId: string, options: { executing: boolean; verdicts?: PrintedVerdicts; facts?: Record<string, unknown> }): Promise<CommandResult> {
  const base = options.verdicts ? { verdicts: options.verdicts } : {};
  const recorded = store.ledger.getRun(runId);
  const plan = await currentPlan(store, runId);
  if (!recorded || !plan) return result(command, 'configuration-failure', { ...base, reasonCode: 'sentinel.service.runUnknown', facts: { runId } });
  const state = recorded.state;
  const admitted = await loadPlan(store, runId, plan.revision);
  const preview = isPreview(admitted.plan);
  const findings = state === 'completed' ? await previewFindingsOf(store, runId) : undefined;
  const facts = { ...(options.facts ?? {}), runId, state, revision: plan.revision, runOutcome: recorded.outcome ?? null,
    previewFindings: findings?.findings.length ?? null, label: preview ? 'foundation-preview' : 'deterministic' };
  if (state === 'completed') {
    if (recorded.outcome === 'execution-failure') return result(command, 'configuration-failure', { ...base, facts, reasonCode: 'sentinel.service.executionFailed' });
    if (preview) return result(command, 'required-coverage-incomplete', { ...base, facts, reasonCode: 'sentinel.service.previewNotCoverage' });
    return result(command, 'required-coverage-incomplete', { ...base, facts,
      reasonCode: recorded.outcome === 'complete-coverage' ? 'sentinel.service.policyNotEvaluated' : 'sentinel.service.coverageIncomplete' });
  }
  if (state === 'canceled' || (state === 'paused' && !options.executing)) return result(command, 'configuration-failure', { ...base, facts, reasonCode: 'sentinel.service.runNotCompleted' });
  if (!options.executing) {
    // Planned and admitted, with none of its analysis started yet: waiting for `run`, not interrupted.
    const untouched = admitted.plan.kind === 'analysis' && admitted.plan.units.every(u => !store.ledger.getWork({ id: u.id, revision: u.revision }));
    return result(command, untouched ? 'prepared' : 'configuration-failure', { ...base, facts, reasonCode: untouched ? 'sentinel.service.runAwaiting' : 'sentinel.service.runInterrupted' });
  }
  return result(command, 'submitted', { ...base, facts });
}

/**
 * A new run that follows an ended one (its parent): `retry` re-plans over the parent's admitted snapshot with no
 * recapture; `rerun` captures the workspace again. Either is planned and admitted like any run, under the lock and
 * policy current now, and waits to be run. A run that has not ended is resumed, not retried.
 */
export async function followRun(store: SentinelStore, parentId: string, mode: 'retry' | 'rerun', options: {
  workspace: string; trustDir: string; policy: EffectivePolicy; scratchRoot: string; registry?: AdapterRegistry; now: Date;
}): Promise<{ outcome: 'prepared' | 'kept'; disclosure: CanonicalDisclosure } | { reasonCode: string }> {
  const parent = store.ledger.getRun(parentId);
  if (!parent) return { reasonCode: 'sentinel.service.runUnknown' };
  if (parent.state !== 'completed' && parent.state !== 'canceled') return { reasonCode: 'sentinel.service.runNotEnded' };
  return planWorkspaceCanonical(store, { ...options, parentId, ...(mode === 'retry' ? { snapshotId: parent.envelope.snapshotId } : {}) });
}
