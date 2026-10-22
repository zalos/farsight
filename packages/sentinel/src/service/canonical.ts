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
import type { ActionEffect } from '../contracts/policy.js';
import type { RunEnvelope } from '../contracts/run.js';
import type { PlanRevision } from '../planner/types.js';
import { Coordinator, type RunSummary } from '../execution/coordinator.js';
import { admitPlan, loadPlan } from '../execution/plans.js';
import { loadBootstrap } from '../execution/bootstrap.js';
import type { AdapterRegistry } from '../execution/registry.js';
import { checkProfileRegistry } from '../execution/profile.js';
import { planAnalysis, planBootstrap, plannerAnalysisFrom, plannerLockFrom, plannerPolicyFrom, plannerSnapshotFrom } from '../planner/index.js';
import type { EffectivePolicy } from '../policy/index.js';
import { captureSnapshot } from '../snapshot/capture.js';
import { openSnapshot } from '../snapshot/materialize.js';
import { canonicalJsonBytes } from '../store/objects.js';
import type { SentinelStore } from '../store/index.js';
import { PREVIEW_DETECTOR_ID, PREVIEW_FINDINGS_SCHEMA, PREVIEW_RULE } from '../adapters/preview-detector.js';
import { result, type CommandResult, type PrintedVerdicts } from '../cli/outcome.js';
import { RuleLockBook } from './rule-locks.js';
import { foundationProfile, unsupportedRules, type TrustedProfile } from './trusted-profile.js';
import { ServiceError } from './owner-service.js';
import { scannerReportOf } from '../reports/scanner.js';
import { retainedBootstrapForReport } from '../execution/retained-bootstrap.js';
import type { BootstrapEvidence } from '../execution/bootstrap.js';
import { publicRegistry, publicProfile, scannerExecution, externalDrivers, publicAvailability } from './scanner-profile.js';
import { checkPlanDatabases } from './scanner-assets.js';
import { recordRunFailure, runFailureFacts } from './run-failure.js';
import { SELECTION_SCHEMA, selectionClosure, unitIdentity, unitsToRun, type RerunSelection } from '../execution/selection.js';

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
  readonly effects: readonly ActionEffect[];
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
  readonly effects: readonly ActionEffect[];
}

/** A plan resting on the foundation-preview detector, whatever its rules are called. */
const isPreview = (plan: PlanRevision) => !plan.pins.rules.some(r => externalDrivers().has(r.adapterId)) && plan.pins.rules.some(r => r.adapterId === PREVIEW_DETECTOR_ID || r.familyId === PREVIEW_RULE);

/** Refuses a plan that would ask a shipped check adapter to run a rule it does not implement exactly. */
export function assertSupportedRules(plan: Pick<PlanRevision, 'pins'>): void {
  const unsupported = unsupportedRules(plan);
  if (unsupported.length) throw new ServiceError('sentinel.service.ruleUnsupported', { unsupported });
}

/** Effects follow executable admitted units; only the exact package preview is a local artifact operation. */
export function planEffects(plan: Pick<PlanRevision, 'units'>): readonly ActionEffect[] {
  const preview = publicRegistry().get(PREVIEW_DETECTOR_ID).digest;
  const tool = plan.units.some(unit => unit.stage === 'check' && (unit.adapterId !== PREVIEW_DETECTOR_ID || unit.implementationDigest !== preview));
  return Object.freeze(tool ? ['local-artifacts', 'tool-execution'] as const : ['local-artifacts'] as const);
}

function disclose(plan: PlanRevision): CanonicalDisclosure {
  return Object.freeze({
    planId: plan.runId, runId: plan.runId, revision: plan.revision, planDigest: plan.digest, snapshotId: plan.pins.snapshotId!,
    effects: planEffects(plan), checks: Object.freeze({ ...plan.tallies.checks }), units: plan.units.length,
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
  // A selected rerun's effects are those of the units it runs; held units start nothing.
  const runs = admitted.selection ? unitsToRun(admitted.selection) : null;
  const effects = planEffects(runs ? { units: admitted.plan.units.filter(u => runs.has(u.id)) } : admitted.plan);
  return Object.freeze({ runId, revision, planDigest: admitted.plan.digest, policyRevision: admitted.plan.pins.policyDigest ?? '', kind: admitted.plan.kind, effects });
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
  const registry = options.registry ?? publicRegistry(options.trustDir);
  const ids = [...new Set(packs.flatMap(p => p.manifest.rules.filter(r => options.policy.rules.includes(r.familyId)).map(r => r.implementation.adapterId)))].filter(id => externalDrivers().has(id));
  const available = options.profile ? new Set<string>() : await publicAvailability(options.trustDir, current.lock, packs, ids, options.scratchRoot);
  const profile = options.profile ?? publicProfile(registry, available, packs);
  const snapshot = options.snapshotId !== undefined
    ? (await openSnapshot(store, options.snapshotId)).snapshot
    : (await captureSnapshot(store, {
      mode: 'working-copy', sources: [{ sourceId: WORKSPACE_SOURCE, repositoryId: 'local-workspace', root: options.workspace }],
      policy: { exclude: { '*': ['.farsight'] } },
    })).snapshot;
  // The run is what it would read and do: the captured inventory (not the capture's time), the lock, the policy and
  // the profile. The same content under the same terms plans to the same run.
  const key = { inventory: snapshot.inventoryDigest, lock: current.digest, policy: options.policy.revision, profile: profile.digest, parent: options.parentId ?? null };
  const runId = options.parentId ? rerunIdOf(store, key) : `run-${digest(key).slice(7, 39)}`;
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
    lock: plannerLockFrom(current.lock, packs, current.digest), policy: plannerPolicyFrom(options.policy), limits: options.policy.rules.includes(PREVIEW_RULE) ? ANALYSIS_LIMITS : { maxScopesPerWork: 32 },
  });
  // Before admission: a shipped check adapter runs only the exact rules it implements.
  assertSupportedRules(analysis);
  if (!options.profile) checkPlanDatabases(analysis, current.lock);
  await admitPlan(store, { plan: analysis, ruleLock: current.lock, policy: options.policy, profile: profile.record });
  store.ledger.advanceRunPlan(runId, analysis.revision);
  return { outcome: 'prepared', disclosure: disclose(analysis) };
}

/** Executes the run's current admitted revision. The coordinator records coverage and the outcome. */
export async function executeRun(store: SentinelStore, runId: string, options: { scratchRoot: string; registry?: AdapterRegistry; run?: RunEnvelope; trustDir?: string; drivers?: import('../execution/check-drivers.js').CheckDriverRegistry }): Promise<RunSummary> {
  // Again before anything runs: an admitted plan from elsewhere is held to the same exact rules.
  const plan = await currentPlan(store, runId);
  if (plan) assertSupportedRules((await loadPlan(store, runId, plan.revision)).plan);
  const registry = options.registry ?? publicRegistry(options.trustDir);
  const assets = options.drivers ? { drivers: options.drivers } : await scannerExecution(store, runId, options.trustDir, options.scratchRoot, registry);
  const run = options.run ?? await rerunEnvelopeOf(store, runId);
  const coordinator = await Coordinator.open({ ...assets, store, runId, registry, scratchRoot: options.scratchRoot, ...(run ? { run } : {}) });
  try { return await coordinator.run(); } catch (error) {
    try { recordRunFailure(store, runId, error); } catch { /* preserve the original error when the store cannot retain it */ }
    throw error;
  }
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
/**
 * Whether this installation can execute the run's current admitted revision: every check adapter is told only rules
 * it implements, and every adapter the admitted profile recorded is registered here with the same digest. Derived
 * from the store and this installation alone, so it reads the same after a disconnect or a restart. Undefined when it
 * can; otherwise why not, as the refusal a start would meet.
 */
export async function notExecutableHere(store: SentinelStore, runId: string, registry: AdapterRegistry = publicRegistry()):
  Promise<{ error: string; reason?: string } | undefined> {
  const plan = await currentPlan(store, runId);
  if (!plan) return undefined;
  const admitted = await loadPlan(store, runId, plan.revision);
  try {
    assertSupportedRules(admitted.plan);
    checkProfileRegistry(admitted.profile, registry);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    const reason = (e as { detail?: { reason?: unknown } }).detail?.reason;
    return { error: typeof code === 'string' ? code : 'sentinel.execution.planInvalid', ...(typeof reason === 'string' ? { reason } : {}) };
  }
  return undefined;
}

export async function canonicalResult(store: SentinelStore, command: string, runId: string, options: { executing: boolean; verdicts?: PrintedVerdicts; facts?: Record<string, unknown>;
  /** The registry that would execute it (this installation's by default). */
  registry?: AdapterRegistry; trustDir?: string }): Promise<CommandResult> {
  const base = options.verdicts ? { verdicts: options.verdicts } : {};
  const recorded = store.ledger.getRun(runId);
  const plan = await currentPlan(store, runId);
  if (!plan) return result(command, 'configuration-failure', { ...base, reasonCode: 'sentinel.service.runUnknown', facts: { runId } });
  if (!recorded) {
    // A selected rerun is admitted before it is first run: waiting for `run`, exactly as admitted.
    const admitted = await loadPlan(store, runId, plan.revision);
    if (!admitted.selection) return result(command, 'configuration-failure', { ...base, reasonCode: 'sentinel.service.runUnknown', facts: { runId } });
    return result(command, 'prepared', { ...base, reasonCode: 'sentinel.service.runAwaiting',
      facts: { ...(options.facts ?? {}), runId, state: 'planned', revision: plan.revision, parentId: admitted.selection.parent.runId,
        units: unitsToRun(admitted.selection).size, held: admitted.selection.held.length } });
  }
  const state = recorded.state;
  const admitted = await loadPlan(store, runId, plan.revision);
  const preview = isPreview(admitted.plan);
  const findings = state === 'completed' ? await previewFindingsOf(store, runId) : undefined;
  const scanner = state === 'completed' ? await scannerReportOf(store, runId, new Date(), {trustDir:options.trustDir}) : undefined;
  const diagnostic = runFailureFacts(store, runId);
  const facts = { ...(options.facts ?? {}), ...diagnostic, runId, state, revision: plan.revision, runOutcome: recorded.outcome ?? null,
    previewFindings: findings?.findings.length ?? null, ...(scanner ? { observations: scanner.observations.length, requiredChecks: scanner.coverage.required, requiredComplete: scanner.coverage.requiredComplete, requiredCoverageComplete: scanner.coverage.complete } : {}), label: preview ? 'foundation-preview' : 'deterministic' };
  if (state === 'completed') {
    if (recorded.outcome === 'execution-failure') return result(command, 'configuration-failure', { ...base, facts, reasonCode: 'sentinel.service.executionFailed' });
    if (preview) return result(command, 'required-coverage-incomplete', { ...base, facts, reasonCode: 'sentinel.service.previewNotCoverage' });
    return result(command, 'required-coverage-incomplete', { ...base, facts,
      reasonCode: recorded.outcome === 'complete-coverage' ? 'sentinel.service.policyNotEvaluated' : 'sentinel.service.coverageIncomplete' });
  }
  if (state === 'canceled' || (state === 'paused' && !options.executing)) return result(command, 'configuration-failure', { ...base, facts, reasonCode: 'sentinel.service.runNotCompleted' });
  if (!options.executing) {
    // Not executing and not ended: `run` would execute it, unless this installation cannot. Then saying it waits (or
    // was interrupted) would mislead; it needs a new plan made by this installation.
    const blocked = await notExecutableHere(store, runId, options.registry);
    if (blocked) return result(command, 'configuration-failure', { ...base, facts: { ...facts, ...blocked }, reasonCode: 'sentinel.service.runNotExecutable' });
    // Planned and admitted, with none of its analysis started yet: waiting for `run`, not interrupted.
    const untouched = admitted.plan.kind === 'analysis' && admitted.plan.units.every(u => !store.ledger.getWork({ id: u.id, revision: u.revision }));
    return result(command, untouched && !diagnostic.error ? 'prepared' : 'configuration-failure', { ...base, facts, reasonCode: untouched && !diagnostic.error ? 'sentinel.service.runAwaiting' : 'sentinel.service.runInterrupted' });
  }
  return result(command, 'submitted', { ...base, facts });
}

/** What a selected-stage rerun would do, under the terms in effect now. Exactly what `rerun --confirm` admits. */
export interface RerunPreview {
  readonly parentId: string;
  readonly snapshotId: string;
  /** The parent units asked for. */
  readonly selected: readonly string[];
  /** Units that depend on a selected one, transitively: their inputs change, so they run again too. */
  readonly downstream: readonly string[];
  /** Work reused from the parent as published: its bootstrap (capture, parse, inventory) and any prerequisites. */
  readonly prerequisites: readonly string[];
  /** Every check the units to run cover. */
  readonly checks: number;
  /** The whole analysis is selected: the rerun re-plans every unit over the retained snapshot. */
  readonly all: boolean;
  readonly effects: readonly ActionEffect[];
  /** For a strict subset: the rerun's run, its admitted revision's digest, and what it holds rather than runs. */
  readonly runId?: string;
  readonly planDigest?: string;
  /** The rerun's own units that run (the selected ones as they are now, and the downstream ones). */
  readonly units?: readonly string[];
  /** Units of the rerun not run here, with the parent unit whose published result stays the parent's (or null). */
  readonly held?: readonly { readonly unit: string; readonly parentUnit: string | null }[];
  /** Required checks of held units: this rerun cannot complete required coverage while any exists. */
  readonly requiredHeld?: number;
}

type Refusal = { reasonCode: string; facts?: Record<string, unknown> };
const sortedIds = (x: Iterable<string>) => [...x].sort();

/** The parent's admitted analysis and the dependency closure of a selection within it (no current terms yet). */
async function parentClosure(store: SentinelStore, parentId: string, selected: readonly string[]) {
  const parent = store.ledger.getRun(parentId);
  if (!parent) return { reasonCode: 'sentinel.service.runUnknown' } as Refusal;
  if (parent.state !== 'completed' && parent.state !== 'canceled') return { reasonCode: 'sentinel.service.runNotEnded' } as Refusal;
  const plan = await currentPlan(store, parentId);
  if (!plan) return { reasonCode: 'sentinel.service.planUnknown' } as Refusal;
  const admitted = await loadPlan(store, parentId, plan.revision);
  const revision = admitted.plan;
  const units = new Map(revision.units.map(u => [u.id, u]));
  const unknown = selected.filter(id => !units.has(id));
  if (unknown.length) return { reasonCode: 'sentinel.service.stageUnknown', facts: { unknown } } as Refusal;
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
  let bootstrap: BootstrapEvidence | undefined;
  if (chosen.size < units.size) {
    try { bootstrap = await retainedBootstrapForReport(store, parentId, admitted); }
    catch { return { reasonCode: 'sentinel.service.bootstrapUnavailable', facts: { parentId } } as Refusal; }
  }
  return { parent, revision, admitted, units, chosen, downstream, rerun, prerequisites, bootstrap };
}

/**
 * The dependency consequences of rerunning `selected` units of an ended run (all of them when none are named), read
 * from the parent's admitted plan: which units run again (the selected and everything downstream of them) and which
 * are reused (prerequisites and the published bootstrap). A strict subset is then planned under the terms in effect
 * now (selectedRerun) and the preview says exactly what that plan runs and holds; nothing is written.
 */
export async function previewRerun(store: SentinelStore, parentId: string, selected: readonly string[], terms?: RerunTerms): Promise<RerunPreview | Refusal> {
  const closure = await parentClosure(store, parentId, selected);
  if ('reasonCode' in closure) return closure;
  const { parent, revision, units, chosen, downstream, rerun, prerequisites } = closure;
  const base = {
    parentId, snapshotId: parent.envelope.snapshotId, selected: sortedIds(chosen), downstream: sortedIds(downstream), prerequisites: sortedIds(prerequisites),
    checks: [...rerun].reduce((n, id) => n + (units.get(id)?.checks.length ?? 0), 0), all: rerun.size === units.size,
    effects: planEffects({ units: revision.units.filter(unit => rerun.has(unit.id)) }),
  };
  if (base.all || !terms) return Object.freeze(base);
  const planned = await selectedRerun(store, parentId, [...chosen], terms);
  if ('reasonCode' in planned) return planned;
  return planned.preview;
}

/**
 * A rerun's id: its request (parent, selection and terms) and a generation. The first generation not yet admitted, or
 * admitted and not ended, is this request, so repeating it while it waits or runs joins it (`kept`) and a retry of it
 * resumes it. Once that run has ended, an explicit rerun of the same parent and selection is a fresh run with its own
 * id: an ended run is never handed back as a new one.
 */
function rerunIdOf(store: SentinelStore, request: Record<string, unknown>): string {
  for (let generation = 0; ; generation++) {
    const id = `run-${digest({ ...request, generation }).slice(7, 39)}`;
    if (!store.ledger.latestPlan(id)) return id;
    const state = store.ledger.getRun(id)?.state;
    if (state !== 'completed' && state !== 'canceled') return id;
  }
}

/** The terms a rerun is planned under: the owner's lock, adopted policy and this installation's profile, now. */
export interface RerunTerms {
  trustDir: string;
  policy: EffectivePolicy;
  scratchRoot: string;
  registry?: AdapterRegistry;
  /** Test seam: the trusted profile to plan under (the shipped one by default). */
  profile?: TrustedProfile;
}

async function currentTerms(terms: RerunTerms) {
  const book = new RuleLockBook(terms.trustDir);
  const current = book.current();
  if (!current) throw new ServiceError('sentinel.service.noRuleLock');
  const packs = book.packsOf(current.lock);
  const registry = terms.registry ?? publicRegistry(terms.trustDir);
  const ids = [...new Set(packs.flatMap(p => p.manifest.rules.filter(r => terms.policy.rules.includes(r.familyId)).map(r => r.implementation.adapterId)))].filter(id => externalDrivers().has(id));
  const available = terms.profile ? new Set<string>() : await publicAvailability(terms.trustDir, current.lock, packs, ids, terms.scratchRoot);
  const profile = terms.profile ?? publicProfile(registry, available, packs);
  return { current, packs, profile };
}

/**
 * Plans a selected rerun of an ended run as a linked child run, without writing anything (see execution/selection.ts):
 * the parent's published bootstrap reused through the parent chain, the analysis planned from exactly that evidence
 * under the lock, policy and profile in effect now, and the selection: the units matching the selected parent units,
 * and everything downstream, run; every other unit is held. A selected unit that is not the same work now, a
 * prerequisite the revision would have to reuse, or a parent without a published bootstrap is refused, never
 * widened.
 */
export async function selectedRerun(store: SentinelStore, parentId: string, selected: readonly string[], terms: RerunTerms) {
  const closure = await parentClosure(store, parentId, selected);
  if ('reasonCode' in closure) return closure;
  const { parent, revision: parentPlan, units: parentUnits, chosen } = closure;
  if (parentPlan.kind !== 'analysis') return { reasonCode: 'sentinel.service.bootstrapUnavailable', facts: { parentId } } as Refusal;
  // The same retained proof used by reporting: exact admitted selected edges and the actual accepted inventory
  // operation. A fresh whole-analysis rerun still follows its separate bootstrap path.
  let evidence = closure.bootstrap;
  if (!evidence) {
    try { evidence = await retainedBootstrapForReport(store, parentId, closure.admitted); }
    catch { return { reasonCode: 'sentinel.service.bootstrapUnavailable', facts: { parentId } } as Refusal; }
  }
  const { current, packs, profile } = await currentTerms(terms);
  const selectedIds = sortedIds(chosen);
  const runId = rerunIdOf(store, { rerun: parentId, parentPlan: parentPlan.digest, selected: selectedIds, lock: current.digest, policy: terms.policy.revision, profile: profile.digest });
  const plan = planAnalysis({
    runId, revision: 1, previous: null, bootstrap: parentPlan.reused.map(r => ({ id: r.id, revision: r.revision })), profile: profile.planner,
    snapshot: plannerSnapshotFrom(evidence.snapshot), analyses: evidence.analyses.map(a => plannerAnalysisFrom(a as never)),
    lock: plannerLockFrom(current.lock, packs, current.digest), policy: plannerPolicyFrom(terms.policy),
    limits: terms.policy.rules.includes(PREVIEW_RULE) ? ANALYSIS_LIMITS : { maxScopesPerWork: 32 },
  });
  assertSupportedRules(plan);
  if (!terms.profile) checkPlanDatabases(plan, current.lock);
  // Each selected parent unit must be the same work under the terms now; nothing is matched loosely.
  const byIdentity = new Map(plan.units.map(u => [unitIdentity(u), u.id]));
  const parentOf = new Map<string, string>();
  for (const u of parentPlan.units) { const child = byIdentity.get(unitIdentity(u)); if (child) parentOf.set(child, u.id); }
  const stale = selectedIds.filter(id => !byIdentity.has(unitIdentity(parentUnits.get(id)!)));
  if (stale.length) return { reasonCode: 'sentinel.service.selectionStale', facts: { stale } } as Refusal;
  const mapped = selectedIds.map(id => ({ parentUnit: id, unit: byIdentity.get(unitIdentity(parentUnits.get(id)!))! }));
  // Downstream within the rerun's own revision. OPEN GATE: a unit that runs and needs an analysis unit that does not
  // is refused, even when the parent published that unit under exactly these terms. Consuming such genuine parent
  // publications (and counting held results as coverage) is PR 27's; until then selections are fail-closed here. The
  // shipped planner's check units depend only on the bootstrap, so today this refusal is reached only by such plans.
  const { run, needed } = selectionClosure(plan.units, mapped.map(m => m.unit));
  if (needed.length) return { reasonCode: 'sentinel.service.prerequisiteNotReusable', facts: { needed } } as Refusal;
  const downstream = sortedIds([...run].filter(id => !mapped.some(m => m.unit === id)));
  const held = plan.units.filter(u => !run.has(u.id)).map(u => ({ unit: u.id, parentUnit: parentOf.get(u.id) ?? null })).sort((a, b) => (a.unit < b.unit ? -1 : 1));
  const selection: RerunSelection = {
    schema: SELECTION_SCHEMA, parent: { runId: parentId, revision: parentPlan.revision, planDigest: parentPlan.digest, snapshotId: parent.envelope.snapshotId },
    selected: mapped, downstream, held, reused: plan.reused.map(r => ({ id: r.id, revision: r.revision })),
  };
  const heldSet = new Set(held.map(h => h.unit));
  const requiredHeld = plan.checks.filter(c => c.required && c.state === 'planned' && c.unit && heldSet.has(c.unit.id)).length
    + plan.checks.filter(c => c.required && c.state !== 'planned').length + plan.ruleGaps.filter(g => g.required).length;
  const preview: RerunPreview = Object.freeze({
    parentId, snapshotId: parent.envelope.snapshotId, selected: selectedIds, downstream, prerequisites: sortedIds(plan.reused.map(r => r.id)),
    checks: plan.units.filter(u => run.has(u.id)).reduce((n, u) => n + u.checks.length, 0), all: false,
    effects: planEffects({ units: plan.units.filter(u => run.has(u.id)) }),
    runId, planDigest: plan.digest, units: sortedIds(run), held, requiredHeld,
  });
  return { preview, plan, selection, current, profile };
}

/** A selected rerun's run envelope, derived from its admitted revision and selection alone (the same every time). */
export async function rerunEnvelopeOf(store: SentinelStore, runId: string): Promise<RunEnvelope | undefined> {
  const record = store.ledger.getPlan(runId, 1);
  if (!record?.selection || store.ledger.getRun(runId)) return undefined;
  const admitted = await loadPlan(store, runId, 1);
  const s = admitted.selection!;
  const parent = store.ledger.getRun(s.parent.runId);
  if (!parent) return undefined;
  return {
    schema: 'sentinel-run/draft-1', id: runId, parentId: s.parent.runId, baselineId: null, snapshotId: s.parent.snapshotId, planRevision: 1,
    coordinatorEpoch: store.epoch, ruleLockDigest: admitted.plan.pins.ruleLockDigest!, toolLockDigest: admitted.plan.pins.ruleLockDigest!,
    policyRevisionDigest: admitted.plan.pins.policyDigest!, requestedScope: { sourceIds: [...parent.envelope.requestedScope.sourceIds], profile: admitted.plan.pins.profileId },
    budgets: structuredClone(parent.envelope.budgets), createdAt: record.admittedAt, state: 'planned',
  } as RunEnvelope;
}

/**
 * A rerun of an ended run: a new run that names it as its parent, over the parent's retained snapshot (nothing is
 * captured again), planned and admitted under the lock and policy current now, and left waiting to be run. The whole
 * analysis is re-planned from a fresh bootstrap over that snapshot; a strict subset runs exactly its selection
 * (selectedRerun), reusing the parent's published bootstrap, and is admitted with the selection that holds the rest.
 */
export async function rerunRun(store: SentinelStore, parentId: string, selected: readonly string[], options: {
  workspace: string; trustDir: string; policy: EffectivePolicy; scratchRoot: string; registry?: AdapterRegistry; now: Date; profile?: TrustedProfile;
}): Promise<{ outcome: 'prepared' | 'kept'; disclosure: CanonicalDisclosure; preview: RerunPreview } | Refusal> {
  const preview = await previewRerun(store, parentId, selected);
  if ('reasonCode' in preview) return preview;
  if (preview.all) {
    const planned = await planWorkspaceCanonical(store, { ...options, parentId, snapshotId: preview.snapshotId });
    return { ...planned, preview };
  }
  const planned = await selectedRerun(store, parentId, preview.selected, options);
  if ('reasonCode' in planned) return planned;
  const existing = store.ledger.latestPlan(planned.preview.runId!);
  if (existing) {
    const kept = await loadPlan(store, planned.preview.runId!, existing.revision);
    if (kept.plan.digest !== planned.plan.digest) return { reasonCode: 'sentinel.service.selectionStale', facts: { runId: planned.preview.runId } };
    return { outcome: 'kept', disclosure: disclose(kept.plan), preview: planned.preview };
  }
  await admitPlan(store, { plan: planned.plan, ruleLock: planned.current.lock, policy: options.policy, profile: planned.profile.record, selection: planned.selection });
  return { outcome: 'prepared', disclosure: disclose(planned.plan), preview: planned.preview };
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
