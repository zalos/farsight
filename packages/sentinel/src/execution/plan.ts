// The admitted plan, bound once to what will execute.
//
// The coordinator runs only a plan revision admitted in the ledger (plans.ts). At open, that revision and the
// profile it was admitted with are read back and checked, and every unit is bound exactly, through PR 06's canonical
// boundary (planBoundaryFor / workEnvelopesFor, verifyWorkEnvelope, verifyInputSet):
//   - its work envelope is the plan's canonical one, naming the canonical influence manifest (influenceManifestOf);
//   - its adapter is the registered one the plan pins, by digest: a check adapter for a check unit, the bootstrap
//     operation of exactly its stage for a capture, parse or inventory unit; a unit with no operation stays held;
//   - a check unit's captured inputs are exactly the plan's, read from a restore of the pinned snapshot.
// Work an earlier revision published and this one reuses must already be published, in this run.
//
// The execution binding is a separate record, never the plan's manifest: it names the canonical manifest's id, the
// adapter digest, the exact inputs and the PR 07 protocol fingerprint the worker's start carries and its result must
// repeat. It is accepted with every attempt's start (linked from its invocation record), failed attempts included.
import { pathRequestOf } from '../analysis/paths/request.js';
import { pathUnitsFor } from '../analysis/paths/admission.js';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ArtifactId, Digest, Id, WorkRef } from '../contracts/common.js';
import type { PlanCheck, PlanWork } from '../contracts/plan.js';
import type { ResultMessage } from '../contracts/protocol.js';
import type { RunEnvelope } from '../contracts/run.js';
import type { WorkEnvelope } from '../contracts/work.js';
import {
  planBoundaryFor,
  verifyInputSet,
  verifyWorkEnvelope,
  workEnvelopesFor,
  canonicalArtifactId,
  influenceManifestOf,
  ownedPlanRevision,
  plannedChecksOf,
  type InfluenceManifest,
} from '../planner/boundary.js';
import { openSnapshot } from '../snapshot/materialize.js';
import type { SentinelStore } from '../store/index.js';
import { boundOwner } from '../store/owner-binding.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { ExecutionError } from './errors.js';
import type { AdmittedPlan } from './plans.js';
import { checkProfileRegistry } from './profile.js';
import { NOT_SELECTED, unitsToRun } from './selection.js';
import { SCRIPT_CONTRACT } from '../planner/pipeline.js';
import type { AdapterRegistry, TrustedAdapter } from './registry.js';
import { orderPlan } from './scheduler.js';
import { inputFingerprintOf, type CapturedInput } from './supervisor.js';

/** A sealed content's path scopes, plus only repository scopes assigned to this same work and source. */
export function capturedInputScopes(
  unit: Readonly<PlanWork>,
  checks: readonly Readonly<PlanCheck>[],
  sealed: readonly Pick<CapturedInput, 'id'>[],
): Array<{ input: ArtifactId; scopes: string[] }> {
  const scopesOf = new Map<string, Set<string>>();
  for (const input of unit.inputs) {
    const scopes = scopesOf.get(input.content) ?? new Set<string>();
    scopes.add(`${input.sourceId}:${input.relativePath}`);
    for (const check of checks)
      if (
        check.state === 'planned' &&
        check.unit?.id === unit.id &&
        check.unit.revision === unit.revision &&
        unit.checks.includes(check.id) &&
        check.scopeKind === 'repository' &&
        check.sourceId === input.sourceId &&
        check.sourceId === unit.sourceId &&
        check.scopeId === input.sourceId &&
        unit.scopes.includes(check.scopeId)
      )
        scopes.add(check.scopeId);
    scopesOf.set(input.content, scopes);
  }
  return sealed.map((input) => ({ input: input.id, scopes: [...(scopesOf.get(input.id) ?? [])].sort() }));
}

export const EXECUTION_BINDING_SCHEMA = 'sentinel-execution-binding/draft-1';
/** A coordinator's input restore under its scratch root: `inputs.<epoch>.<uuid>`. */
export const RESTORE_PREFIX = 'inputs.';

export interface ExecutionBinding {
  schema: typeof EXECUTION_BINDING_SCHEMA;
  plan: { runId: Id; revision: number; digest: Digest };
  work: WorkRef;
  /** The canonical influence manifest's artifact id (the work envelope's influenceManifest). */
  influenceManifest: ArtifactId;
  adapter: { id: Id; digest: Digest };
  inputs: ArtifactId[];
  /** inputFingerprintOf(inputs): what the worker protocol carries. */
  protocolFingerprint: Digest;
  /** The plan's own input fingerprint for the unit (wider than the inputs). */
  inputFingerprint: Digest;
  /**
   * With a check driver: the plan's exact source inputs (the attempt's `inputs` add the driver's job and auxiliary
   * inputs), and the job and auxiliary inputs by digest and role.
   */
  sourceInputs?: ArtifactId[];
  derived?: {
    job: ArtifactId;
    auxiliary: Array<{ id: ArtifactId; role: string }>;
    analysis?: {
      inventory: WorkRef;
      result: ArtifactId;
      index: ArtifactId;
      artifact: ArtifactId;
      manifest: ArtifactId;
    };
  };
}

export interface ExecutableUnit {
  readonly work: Readonly<WorkEnvelope>;
  readonly unit: Readonly<PlanWork>;
  /** Null for a unit the plan holds (no bound operation). */
  readonly adapter: TrustedAdapter | null;
  /** The captured inputs, one per distinct artifact (two captured files with the same bytes are one input). */
  readonly inputs: readonly CapturedInput[];
  /** Which admitted scopes each sealed content is: its captured paths and its assigned repository check, if any. */
  readonly inputScopes: readonly { input: ArtifactId; scopes: string[] }[];
  readonly manifest: Readonly<InfluenceManifest>;
  readonly checks: readonly Readonly<PlanCheck>[];
}

export interface ValidatedPlan {
  /** The run as executed: its recorded envelope with its current plan revision. */
  readonly run: Readonly<RunEnvelope>;
  readonly admitted: Readonly<AdmittedPlan>;
  readonly works: readonly Readonly<WorkEnvelope>[];
  /** Published work of earlier revisions this one depends on. */
  readonly external: ReadonlySet<string>;
  /** Only the exact bootstrap references proven by existing plan validation. */
  reusedProven(ref: WorkRef): boolean;
  unitOf(ref: WorkRef): ExecutableUnit;
  bindingOf(ref: WorkRef): Readonly<ExecutionBinding>;
  /** Where the coordinator restores the pinned snapshot for the check units' inputs (null for a bootstrap revision). */
  readonly restored: string | null;
}

const validated = new WeakMap<object, { store: SentinelStore; epoch: string }>();
export function isValidatedPlan(store: SentinelStore, value: unknown): value is ValidatedPlan {
  const binding = value && typeof value === 'object' ? validated.get(value) : undefined;
  return binding?.store === store && binding.epoch === store.epoch;
}

const key = (r: WorkRef) => `${r.id}@${r.revision}`;
const refuse = (reason: string): never => {
  throw new ExecutionError('sentinel.execution.planInvalid', { reason });
};

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as object)) deepFreeze(x);
  }
  return v;
}

export function executionBinding(
  plan: AdmittedPlan['plan'],
  work: WorkEnvelope,
  adapter: TrustedAdapter,
  inputs: readonly ArtifactId[],
): ExecutionBinding {
  const sorted = [...inputs].sort();
  return {
    schema: EXECUTION_BINDING_SCHEMA,
    plan: { runId: plan.runId, revision: plan.revision, digest: plan.digest },
    work: { id: work.id, revision: work.revision },
    influenceManifest: work.influenceManifest,
    adapter: { id: adapter.id, digest: adapter.digest },
    inputs: sorted,
    protocolFingerprint: inputFingerprintOf(sorted),
    inputFingerprint: work.inputFingerprint,
  };
}

export const bindingId = (b: ExecutionBinding): ArtifactId =>
  `sha256:${createHash('sha256').update(canonicalJsonBytes(b)).digest('hex')}`;

/**
 * What actually ran must be what the plan bound: the invocation's adapter digest, its exact inputs and the protocol
 * fingerprint the result repeated. Returns a reason when it differs.
 */
export function bindingMismatch(
  binding: ExecutionBinding,
  invocation: { adapter: { digest: Digest }; inputs: readonly ArtifactId[]; inputFingerprint: Digest },
  result: ResultMessage,
): string | undefined {
  if (invocation.adapter.digest !== binding.adapter.digest) return 'the invocation ran another adapter';
  if (JSON.stringify([...invocation.inputs].sort()) !== JSON.stringify(binding.inputs))
    return 'the invocation read other inputs';
  if (
    invocation.inputFingerprint !== binding.protocolFingerprint ||
    result.inputFingerprint !== binding.protocolFingerprint
  )
    return 'the result names other inputs';
  return undefined;
}

/** Bind an admitted plan revision for execution in `run`. Restores the pinned snapshot under scratchRoot when needed. */
export async function executablePlan(
  store: SentinelStore,
  admitted: AdmittedPlan,
  recordedRun: RunEnvelope,
  currentRevision: number,
  registry: AdapterRegistry,
  scratchRoot: string,
): Promise<ValidatedPlan> {
  boundOwner(store);
  store.assertHeld();
  const given = admitted.plan;
  checkProfileRegistry(admitted.profile, registry);
  if (given.runId !== recordedRun.id || given.revision !== currentRevision)
    refuse("the plan is not the run's current revision");
  const run = deepFreeze({ ...structuredClone(recordedRun), planRevision: currentRevision });
  if (!store.ledger.getSnapshot(run.snapshotId)) refuse('the run names a snapshot that was not admitted in this store');
  // The envelopes' epoch and time are the run's; each work revision is created under the epoch that creates it.
  const conversion = {
    coordinatorEpoch: run.coordinatorEpoch,
    createdAt: run.createdAt,
    execution: { resources: admitted.profile.resources },
  };
  let works: WorkEnvelope[];
  // Everything below binds one private, deep-frozen copy of the admitted plan, validated in full when it is taken
  // (after the only await): each unit is then checked against it by lookup instead of re-validating the whole plan.
  let plan: AdmittedPlan['plan'];
  let inputsOf = (_w: WorkEnvelope): CapturedInput[] => [];
  let restored: string | null = null;
  if (given.kind === 'analysis') {
    if (given.pins.snapshotId !== run.snapshotId) refuse('the plan pins another snapshot than the run');
    const { snapshot } = await openSnapshot(store, run.snapshotId);
    // Where the coordinator restores the pinned snapshot while it may start attempts (restoreSnapshot puts each
    // source at <target>/<sourceId>); named by this owner's epoch so recovery can tell a dead owner's restore apart.
    restored = join(scratchRoot, `${RESTORE_PREFIX}${store.epoch}.${randomUUID()}`);
    const root = restored;
    const sources = new Set(snapshot.sources.map((s) => s.sourceId));
    const boundary = planBoundaryFor(given, {
      run,
      conversion,
      snapshot,
      pathOf: (i) =>
        join(
          root,
          sources.has(i.sourceId) ? i.sourceId : refuse(`no captured source ${i.sourceId}`),
          ...i.relativePath.split('/'),
        ),
    });
    plan = boundary.plan;
    works = [...boundary.works];
    // A selected rerun runs exactly its selection: every other unit is held, disabled by the selection, and its
    // envelope says so, so the coordinator records the hold and never admits it.
    if (admitted.selection) {
      const runs = unitsToRun(admitted.selection);
      works = works.map((w) =>
        runs.has(w.id) ? w : ({ ...w, state: 'disabled-by-policy', reasonCode: NOT_SELECTED } as WorkEnvelope),
      );
    }
    if (plan.pins.pathRequest) {
      if (!admitted.pathRequest) refuse('the path task has no accepted request');
      const active = pathUnitsFor(plan, pathRequestOf(admitted.pathRequest));
      works = works.map((w) =>
        active.has(w.id) ? w : ({ ...w, state: 'disabled-by-policy', reasonCode: NOT_SELECTED } as WorkEnvelope),
      );
    }
    const held = new Set(works.filter((w) => w.state === 'blocked' || w.state === 'disabled-by-policy').map(key));
    inputsOf = (w) => (held.has(key(w)) ? [] : boundary.inputsFor(w).map((i) => ({ id: i.id, path: i.path })));
  } else {
    plan = ownedPlanRevision(given);
    if (plan.kind !== 'bootstrap') refuse('the bootstrap boundary requires a bootstrap plan');
    works = workEnvelopesFor(plan, conversion).map((c) => c.envelope);
  }
  if (plan.runId !== recordedRun.id || plan.revision !== currentRevision)
    refuse("the plan is not the run's current revision");
  orderPlan(works, new Set(plan.reused.map(key)));
  // Reused work must be published in this run, or in a run on this run's parent chain over the same snapshot (a
  // rerun is a child run of the run it reruns, and never re-executes the prerequisites it reuses).
  const lineage = new Set<Id>([run.id]);
  for (let parent = run.parentId, depth = 0; parent && depth < 64; depth++) {
    const p = store.ledger.getRun(parent);
    if (!p || p.envelope.snapshotId !== run.snapshotId) break;
    lineage.add(p.id);
    parent = p.envelope.parentId;
  }
  for (const r of plan.reused) {
    const row = store.ledger.getWork(r);
    if (!row || !lineage.has(row.runId) || !store.ledger.getPublication(r)) {
      refuse(`reused work ${key(r)} is not published in this run or in a parent run over the same snapshot`);
    }
  }
  const exact = (r: WorkRef) => JSON.stringify([r.id, r.revision]);
  const unitAt = new Map<string, number>();
  plan.units.forEach((u, i) => {
    if (!unitAt.has(exact(u))) unitAt.set(exact(u), i);
  });
  const units = new Map<string, ExecutableUnit>();
  const bindings = new Map<string, ExecutionBinding>();
  for (const w of works) {
    verifyWorkEnvelope(plan, w);
    const unit = plan.units[unitAt.get(exact(w))!]!;
    const manifest = influenceManifestOf(plan, unit);
    if (canonicalArtifactId(manifest) !== w.influenceManifest)
      refuse(`work ${key(w)} does not name its canonical influence manifest`);
    let adapter: TrustedAdapter | null = null;
    if (unit.adapterId !== null) {
      adapter = registry.get(unit.adapterId);
      if (adapter.digest !== unit.implementationDigest)
        refuse(`work ${key(w)} names implementation ${unit.implementationDigest}, not adapter ${adapter.id}`);
      // A declared script stage's unit runs the script runner operation; every other unit the operation of its stage.
      const operation = unit.contract === SCRIPT_CONTRACT ? 'script' : unit.stage;
      if (
        unit.stage === 'check'
          ? adapter.kind === 'operation'
          : adapter.kind !== 'operation' || adapter.operation !== operation
      ) {
        refuse(`work ${key(w)} is a ${unit.stage} stage and ${adapter.id} is not its operation`);
      }
    }
    const listed = inputsOf(w);
    // A held unit never runs, so it is given no inputs; every unit that can run gets exactly the plan's.
    if ((unit.stage === 'check' || unit.review) && adapter && w.state !== 'disabled-by-policy' && w.state !== 'blocked')
      verifyInputSet(plan, w, listed);
    const inputs = deepFreeze(listed.filter((i, n) => listed.findIndex((x) => x.id === i.id) === n));
    const checks = plannedChecksOf(plan, w);
    const inputScopes = deepFreeze(capturedInputScopes(unit, checks, inputs));
    units.set(
      key(w),
      deepFreeze({ work: deepFreeze(structuredClone(w)), unit, adapter, inputs, inputScopes, manifest, checks }),
    );
    if (adapter)
      bindings.set(
        key(w),
        deepFreeze(
          executionBinding(
            plan,
            w,
            adapter,
            inputs.map((i) => i.id),
          ),
        ),
      );
  }
  const get = <T>(m: Map<string, T>, r: WorkRef): T => m.get(key(r)) ?? refuse(`work ${key(r)} is not in the plan`);
  const proven = new Set(plan.reused.map(key));
  // Preserve the exact plan every unit was bound to; copying the caller admission again could read a later plan.
  const admittedCopy = deepFreeze({
    ...structuredClone({
      record: admitted.record,
      ruleLock: admitted.ruleLock,
      policy: admitted.policy,
      profile: admitted.profile,
      selection: admitted.selection,
      ...(admitted.pathRequest ? { pathRequest: admitted.pathRequest } : {}),
    }),
    plan,
  });
  const result = Object.freeze({
    run,
    admitted: admittedCopy,
    works: Object.freeze(works.map((w) => units.get(key(w))!.work)),
    external: new Set(proven),
    restored,
    reusedProven: (r: WorkRef) => proven.has(key(r)),
    unitOf: (r: WorkRef) => get(units, r),
    bindingOf: (r: WorkRef) => get(bindings, r),
  });
  validated.set(result, { store, epoch: store.epoch });
  return result;
}

const RUN_IDENTITY = [
  'id',
  'parentId',
  'baselineId',
  'snapshotId',
  'planRevision',
  'ruleLockDigest',
  'toolLockDigest',
  'policyRevisionDigest',
  'promptPolicyDigest',
  'requestedScope',
  'budgets',
] as const;
const WORK_IDENTITY = [
  'id',
  'revision',
  'runId',
  'planRevision',
  'stage',
  'inputFingerprint',
  'influenceManifest',
  'dependencies',
  'resources',
] as const;
const same = (a: unknown, b: unknown) =>
  Buffer.from(canonicalJsonBytes(a ?? null)).equals(canonicalJsonBytes(b ?? null));

/** A requested run must be the recorded run, field for field (state, epoch and times aside). */
export function checkRecordedRun(requested: RunEnvelope, recorded: RunEnvelope | undefined): void {
  if (!recorded) return;
  for (const f of RUN_IDENTITY)
    if (
      !same((requested as unknown as Record<string, unknown>)[f], (recorded as unknown as Record<string, unknown>)[f])
    )
      refuse(`run ${requested.id} is recorded with another ${f}`);
}

/** A recorded work revision must be this plan's, for this run, field for field (state, epoch and times aside). */
export function checkRecordedWork(
  plan: ValidatedPlan,
  ref: WorkRef,
  recorded: { runId: Id; envelope: WorkEnvelope } | null,
): void {
  if (!recorded) return;
  if (recorded.runId !== plan.run.id)
    refuse(`work ${key(ref)} belongs to run ${recorded.runId}; reuse across runs needs a satisfied-by-reuse lineage`);
  const w = plan.unitOf(ref).work;
  for (const f of WORK_IDENTITY)
    if (
      !same((w as unknown as Record<string, unknown>)[f], (recorded.envelope as unknown as Record<string, unknown>)[f])
    )
      refuse(`work ${key(ref)} is recorded with another ${f}`);
}
