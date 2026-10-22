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
import { PREVIEW_DETECTOR_ID, PREVIEW_FINDINGS_SCHEMA, PREVIEW_RULE } from '../adapters/preview-detector.js';
import { result, type CommandResult, type PrintedVerdicts } from '../cli/outcome.js';
import { RuleLockBook } from './rule-locks.js';
import { foundationProfile, foundationRegistry, unsupportedRules, type TrustedProfile } from './trusted-profile.js';
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
  /** The analysis units, by id: what `rerun --stage` selects from. */
  readonly unitIds: readonly string[];
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

/** A plan resting on the foundation-preview detector, whatever its rules are called. */
const isPreview = (plan: PlanRevision) => plan.pins.rules.some(r => r.adapterId === PREVIEW_DETECTOR_ID || r.familyId === PREVIEW_RULE);

/** Refuses a plan that would ask a shipped check adapter to run a rule it does not implement exactly. */
export function assertSupportedRules(plan: Pick<PlanRevision, 'pins'>): void {
  const unsupported = unsupportedRules(plan);
  if (unsupported.length) throw new ServiceError('sentinel.service.ruleUnsupported', { unsupported });
}

function disclose(plan: PlanRevision): CanonicalDisclosure {
  return Object.freeze({
    planId: plan.runId, runId: plan.runId, revision: plan.revision, planDigest: plan.digest, snapshotId: plan.pins.snapshotId!,
    effects: Object.freeze(['local-artifacts'] as const), checks: Object.freeze({ ...plan.tallies.checks }), units: plan.units.length,
    unitIds: Object.freeze(plan.units.map(u => u.id).sort()),
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
  // Before admission: a shipped check adapter runs only the exact rules it implements.
  assertSupportedRules(analysis);
  await admitPlan(store, { plan: analysis, ruleLock: current.lock, policy: options.policy, profile: profile.record });
  store.ledger.advanceRunPlan(runId, analysis.revision);
  return { outcome: 'prepared', disclosure: disclose(analysis) };
}

/** Executes the run's current admitted revision. The coordinator records coverage and the outcome. */
export async function executeRun(store: SentinelStore, runId: string, options: { scratchRoot: string; registry?: AdapterRegistry; run?: RunEnvelope }): Promise<RunSummary> {
  // Again before anything runs: an admitted plan from elsewhere is held to the same exact rules.
  const plan = await currentPlan(store, runId);
  if (plan) assertSupportedRules((await loadPlan(store, runId, plan.revision)).plan);
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

/** What a selected-stage rerun would do, from the parent's admitted plan alone. */
export interface RerunPreview {
  readonly parentId: string;
  readonly snapshotId: string;
  /** The units asked for. */
  readonly selected: readonly string[];
  /** Units that depend on a selected one, transitively: their inputs change, so they run again too. */
  readonly downstream: readonly string[];
  /** Units a selected one depends on, transitively, and the bootstrap: reused from the parent as published. */
  readonly prerequisites: readonly string[];
  /** Every check the units to run cover. */
  readonly checks: number;
  /** The whole analysis is selected: the rerun re-plans every unit over the retained snapshot. */
  readonly all: boolean;
  readonly effects: readonly ['local-artifacts'];
}

/**
 * The dependency consequences of rerunning `selected` units of an ended run (all of them when none are named): which
 * units run again (the selected and everything downstream of them) and which are reused from the parent
 * (prerequisites and the published bootstrap). Reads only.
 */
export async function previewRerun(store: SentinelStore, parentId: string, selected: readonly string[]): Promise<RerunPreview | { reasonCode: string; facts?: Record<string, unknown> }> {
  const parent = store.ledger.getRun(parentId);
  if (!parent) return { reasonCode: 'sentinel.service.runUnknown' };
  if (parent.state !== 'completed' && parent.state !== 'canceled') return { reasonCode: 'sentinel.service.runNotEnded' };
  const plan = await currentPlan(store, parentId);
  if (!plan || plan.kind !== 'analysis') return { reasonCode: 'sentinel.service.planUnknown' };
  const { plan: revision } = await loadPlan(store, parentId, plan.revision);
  const units = new Map(revision.units.map(u => [u.id, u]));
  const unknown = selected.filter(id => !units.has(id));
  if (unknown.length) return { reasonCode: 'sentinel.service.stageUnknown', facts: { unknown } };
  const chosen = new Set(selected.length ? selected : [...units.keys()]);
  const dependents = new Map<string, string[]>();
  for (const u of revision.units) for (const d of u.dependencies) if (units.has(d.id)) dependents.set(d.id, [...(dependents.get(d.id) ?? []), u.id]);
  const downstream = new Set<string>();
  const walkDown = (id: string) => { for (const n of dependents.get(id) ?? []) if (!chosen.has(n) && !downstream.has(n)) { downstream.add(n); walkDown(n); } };
  for (const id of chosen) walkDown(id);
  const rerun = new Set([...chosen, ...downstream]);
  const prerequisites = new Set<string>(revision.reused.map(r => r.id));
  const walkUp = (id: string) => { for (const d of units.get(id)?.dependencies ?? []) if (!rerun.has(d.id) && !prerequisites.has(d.id)) { prerequisites.add(d.id); walkUp(d.id); } };
  for (const id of rerun) walkUp(id);
  const sorted = (x: Iterable<string>) => [...x].sort();
  return Object.freeze({
    parentId, snapshotId: parent.envelope.snapshotId, selected: sorted(chosen), downstream: sorted(downstream), prerequisites: sorted(prerequisites),
    checks: [...rerun].reduce((n, id) => n + (units.get(id)?.checks.length ?? 0), 0), all: rerun.size === units.size,
    effects: Object.freeze(['local-artifacts'] as const),
  });
}

/**
 * A rerun of an ended run: a new run that names it as its parent, over the parent's retained snapshot (nothing is
 * captured again), planned and admitted under the lock and policy current now, and left waiting to be run. Only the
 * whole analysis can be rerun today: running a strict subset needs the planner to plan just the selected units and
 * downstream ones, and the coordinator to reuse the parent's published prerequisites, neither of which exists yet,
 * so such a selection is previewed and refused (sentinel.service.selectionUnsupported), never widened silently.
 */
export async function rerunRun(store: SentinelStore, parentId: string, selected: readonly string[], options: {
  workspace: string; trustDir: string; policy: EffectivePolicy; scratchRoot: string; registry?: AdapterRegistry; now: Date;
}): Promise<{ outcome: 'prepared' | 'kept'; disclosure: CanonicalDisclosure; preview: RerunPreview } | { reasonCode: string; facts?: Record<string, unknown> }> {
  const preview = await previewRerun(store, parentId, selected);
  if ('reasonCode' in preview) return preview;
  if (!preview.all) return { reasonCode: 'sentinel.service.selectionUnsupported', facts: { preview } };
  const planned = await planWorkspaceCanonical(store, { ...options, parentId, snapshotId: preview.snapshotId });
  return { ...planned, preview };
}

/**
 * A retry of an ended run: a new run naming it as its parent, re-planned over the parent's retained snapshot with no
 * recapture, under the lock and policy current now, waiting to be run. A run that has not ended is resumed instead;
 * a new snapshot of changed source is a new `plan`.
 */
export async function followRun(store: SentinelStore, parentId: string, mode: 'retry', options: {
  workspace: string; trustDir: string; policy: EffectivePolicy; scratchRoot: string; registry?: AdapterRegistry; now: Date;
}): Promise<{ outcome: 'prepared' | 'kept'; disclosure: CanonicalDisclosure } | { reasonCode: string }> {
  const parent = store.ledger.getRun(parentId);
  if (!parent) return { reasonCode: 'sentinel.service.runUnknown' };
  if (parent.state !== 'completed' && parent.state !== 'canceled') return { reasonCode: 'sentinel.service.runNotEnded' };
  void mode;
  return planWorkspaceCanonical(store, { ...options, parentId, snapshotId: parent.envelope.snapshotId });
}
