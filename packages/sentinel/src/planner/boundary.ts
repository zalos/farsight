// From a sealed plan revision to what the coordinator (PR 08) executes: canonical sentinel-work/draft-1 envelopes,
// one per unit, with the resources the trusted profile grants each stage, and each unit's influence manifest (the
// inspectable list of everything its input fingerprint covers). The coordinator stores each manifest with
// putCanonicalJson before creating the work: its artifact id is the canonical digest of the value given here.
//
// Nothing here adds coverage. checksCoveredBy() returns exactly the checks the plan assigned to a unit, and a unit's
// captured inputs are exactly the files the plan lists for it, resolved against the snapshot it pins.
import { createHash } from 'node:crypto';
import type { ArtifactId, Id, Timestamp, WorkRef } from '../contracts/common.js';
import type { RunEnvelope } from '../contracts/run.js';
import type { SnapshotEnvelope } from '../contracts/snapshot.js';
import type { ResourcePolicy, StageKind, WorkEnvelope } from '../contracts/work.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { validateEnvelope } from '../validate.js';
import { PlanError } from './errors.js';
import { verifyPlanRevision } from './planner.js';
import type { PlanRevision, PlanStage, PlannedWork } from './types.js';

const invalid = (detail: string) => new PlanError('sentinel.plan.invalidInput', detail);
const mismatch = (detail: string) => new PlanError('sentinel.plan.pinMismatch', detail);

/** What the trusted profile grants each stage. Each must be within the work contract's ceilings, or it is refused. */
export interface ExecutionProfile {
  readonly resources: Readonly<Record<PlanStage, ResourcePolicy>>;
}

export interface WorkConversion {
  readonly coordinatorEpoch: Id;
  readonly createdAt: Timestamp;
  readonly execution: ExecutionProfile;
}

/** One unit's influence manifest: the plan it belongs to and every input its fingerprint covers. */
export interface InfluenceManifest {
  readonly schema: 'sentinel-influence/draft-1';
  readonly plan: { readonly runId: Id; readonly revision: number; readonly digest: string };
  readonly unit: WorkRef;
  readonly stage: PlanStage;
  readonly inputFingerprint: string;
  readonly implementationDigest: string;
  readonly adapterId: Id | null;
  readonly dependencies: readonly WorkRef[];
  readonly checks: readonly Id[];
  readonly scopes: readonly string[];
  readonly inputs: PlannedWork['inputs'];
  readonly pins: PlanRevision['pins'];
}

export interface ConvertedWork {
  readonly envelope: WorkEnvelope;
  readonly manifest: InfluenceManifest;
}

/** The artifact id the object store gives a value stored with putCanonicalJson. */
export const canonicalArtifactId = (value: unknown): ArtifactId =>
  `sha256:${createHash('sha256').update(canonicalJsonBytes(value)).digest('hex')}`;

function sealedPlan(plan: PlanRevision): PlanRevision {
  if (!validateEnvelope('plan', plan).ok || !verifyPlanRevision(plan)) throw mismatch('the plan revision does not validate or match its digest');
  return plan;
}

const unitOf = (plan: PlanRevision, ref: WorkRef): PlannedWork => {
  const unit = plan.units.find(u => u.id === ref.id && u.revision === ref.revision);
  if (!unit) throw invalid(`${ref.id}@${ref.revision} is not a unit of this plan`);
  return unit;
};

export function influenceManifestOf(plan: PlanRevision, ref: WorkRef): InfluenceManifest {
  const u = unitOf(sealedPlan(plan), ref);
  return {
    schema: 'sentinel-influence/draft-1', plan: { runId: plan.runId, revision: plan.revision, digest: plan.digest },
    unit: { id: u.id, revision: u.revision }, stage: u.stage, inputFingerprint: u.inputFingerprint,
    implementationDigest: u.implementationDigest, adapterId: u.adapterId, dependencies: u.dependencies.map(d => ({ ...d })),
    checks: [...u.checks], scopes: [...u.scopes], inputs: u.inputs.map(i => ({ ...i })), pins: plan.pins,
  };
}

/**
 * Every unit of the plan as a canonical work envelope (validated), with its influence manifest. A unit without
 * dependencies starts `ready`; one waiting on other work starts `pending`. A locked tool's unit is an
 * `external-tool` stage; built-in adapters and the bootstrap stages are `coded`.
 */
export function workEnvelopesFor(plan: PlanRevision, conversion: WorkConversion): ConvertedWork[] {
  sealedPlan(plan);
  const tools = new Set(plan.pins.tools.map(t => t.adapterId));
  return plan.units.map(u => {
    const manifest = influenceManifestOf(plan, u);
    const resources = conversion.execution.resources[u.stage];
    if (!resources) throw invalid(`the profile grants no resources to the ${u.stage} stage`);
    const kind: StageKind = u.adapterId !== null && tools.has(u.adapterId) ? 'external-tool' : 'coded';
    const common = {
      schema: 'sentinel-work/draft-1' as const, id: u.id, revision: u.revision, runId: plan.runId, planRevision: plan.revision,
      stage: { contract: u.contract, contractVersion: 'draft-1', kind, implementationDigest: u.implementationDigest },
      inputFingerprint: u.inputFingerprint, influenceManifest: canonicalArtifactId(manifest),
      dependencies: u.dependencies.map(d => ({ id: d.id, revision: d.revision })), resources: { ...resources },
      coordinatorEpoch: conversion.coordinatorEpoch, createdAt: conversion.createdAt, activeAttemptId: null,
    };
    // A unit without a registered operation is blocked with its reason: nothing generic may run it.
    const envelope: WorkEnvelope = u.adapterId === null
      ? { ...common, state: 'blocked', reasonCode: 'sentinel.plan.operationUnbound' }
      : { ...common, state: u.dependencies.length ? 'pending' : 'ready' };
    const checked = validateEnvelope('work', envelope);
    if (!checked.ok) throw invalid(`${u.id} is not a valid work envelope: ${checked.errors[0]?.path || '/'} ${checked.errors[0]?.message ?? ''}`);
    return Object.freeze({ envelope: checked.value, manifest });
  });
}

/** Exactly the checks the plan assigned to this unit: never more. */
export function checksCoveredBy(plan: PlanRevision, ref: WorkRef): readonly Id[] {
  return [...unitOf(sealedPlan(plan), ref).checks];
}

/** The registered adapter that runs a unit; null for a bootstrap stage with no bound operation (its work is blocked). */
export function adapterOf(plan: PlanRevision, ref: WorkRef): Id | null {
  return unitOf(sealedPlan(plan), ref).adapterId;
}

/**
 * The captured files a unit reads, by their content artifact, from the snapshot the plan pins. A listed input that
 * the snapshot does not hold as an included file is refused rather than skipped.
 */
export function capturedInputsOf(plan: PlanRevision, ref: WorkRef, snapshot: Pick<SnapshotEnvelope, 'id' | 'entries'>):
  { sourceId: Id; relativePath: string; id: ArtifactId }[] {
  const unit = unitOf(sealedPlan(plan), ref);
  if (plan.pins.snapshotId !== snapshot.id) throw mismatch('the snapshot is not the one the plan pins');
  const included = new Map<string, ArtifactId>();
  for (const e of snapshot.entries) if (e.kind === 'file' && e.disposition === 'included') included.set(`${e.sourceId}\u0000${e.relativePath}`, e.content);
  return unit.inputs.map(i => {
    const id = included.get(`${i.sourceId}\u0000${i.relativePath}`);
    if (!id) throw mismatch(`${i.sourceId}:${i.relativePath} is not an included file of the pinned snapshot`);
    if (id !== i.content) throw mismatch(`${i.sourceId}:${i.relativePath} holds other bytes than the plan pinned`);
    return { sourceId: i.sourceId, relativePath: i.relativePath, id };
  });
}

/** A captured input as the coordinator's supervisor takes it: the artifact and where its bytes are now. */
export interface BoundaryInput {
  readonly id: ArtifactId;
  readonly path: string;
}

/**
 * The coordinator's PlanBoundary (PR 08): the run, its canonical work and the two lookups execution needs, plus the
 * sealed plan itself (every check with its required flag and state, and the rule gaps) and the exact checks each
 * work covers, so required coverage is computed from coverage evidence, never from work having finished.
 */
export interface PlanBoundaryParts {
  readonly run: RunEnvelope;
  readonly works: readonly WorkEnvelope[];
  adapterFor(work: WorkEnvelope): Id;
  inputsFor(work: WorkEnvelope): readonly BoundaryInput[];
  readonly plan: PlanRevision;
  checksFor(work: WorkEnvelope): readonly Id[];
}

/**
 * Refuses a work envelope that is not exactly the plan's unit: same identity, run, plan revision, stage, input
 * fingerprint, dependencies, and an influence manifest whose artifact id is the canonical id of the unit's manifest.
 */
export function verifyWorkEnvelope(plan: PlanRevision, work: WorkEnvelope): void {
  const unit = unitOf(sealedPlan(plan), work);
  const deps = (r: readonly WorkRef[]) => JSON.stringify(r.map(d => [d.id, d.revision]));
  const checks: Array<[string, unknown, unknown]> = [
    ['run', work.runId, plan.runId], ['plan revision', work.planRevision, plan.revision], ['stage contract', work.stage.contract, unit.contract],
    ['implementation', work.stage.implementationDigest, unit.implementationDigest], ['input fingerprint', work.inputFingerprint, unit.inputFingerprint],
    ['dependencies', deps(work.dependencies), deps(unit.dependencies)],
    ['influence manifest', work.influenceManifest, canonicalArtifactId(influenceManifestOf(plan, unit))],
  ];
  for (const [what, got, want] of checks) if (got !== want) throw mismatch(`${work.id}: the ${what} is not the plan's`);
}

export interface BoundaryRequest {
  /** The run the plan belongs to: its id, plan revision, snapshot, lock, policy and epoch must be the plan's. */
  readonly run: RunEnvelope;
  readonly conversion: WorkConversion;
  readonly snapshot: Pick<SnapshotEnvelope, 'id' | 'entries'>;
  /** Where a captured input's bytes are now (a materialization or restore), by its artifact. */
  pathOf(input: { readonly sourceId: Id; readonly relativePath: string; readonly id: ArtifactId }): string;
}

/**
 * The coordinator's boundary for an analysis revision. A bootstrap revision is refused: its units are run by the
 * service, not by a check adapter. The run is checked against the plan's own pins, never trusted to name them.
 */
export function planBoundaryFor(plan: PlanRevision, request: BoundaryRequest): PlanBoundaryParts {
  sealedPlan(plan);
  if (plan.kind !== 'analysis') throw invalid('only an analysis revision is handed to the coordinator');
  const run = request.run;
  const checked = validateEnvelope('run', run);
  if (!checked.ok) throw invalid(`the run is not a valid run envelope: ${checked.errors[0]?.path || '/'}`);
  const pairs: Array<[string, unknown, unknown]> = [
    ['run id', run.id, plan.runId], ['plan revision', run.planRevision, plan.revision], ['snapshot', run.snapshotId, plan.pins.snapshotId],
    ['rule lock', run.ruleLockDigest, plan.pins.ruleLockDigest], ['policy revision', run.policyRevisionDigest, plan.pins.policyDigest],
    ['coordinator epoch', run.coordinatorEpoch, request.conversion.coordinatorEpoch],
  ];
  for (const [what, got, want] of pairs) if (got !== want) throw mismatch(`the run's ${what} is not the plan's`);
  const converted = workEnvelopesFor(plan, request.conversion);
  const works = converted.map(c => c.envelope);
  const known = (w: WorkEnvelope) => {
    const i = works.findIndex(x => x.id === w?.id && x.revision === w?.revision);
    if (i < 0) throw invalid('the work is not part of this boundary');
    return plan.units.find(u => u.id === w.id && u.revision === w.revision)!;
  };
  return Object.freeze({
    run, works: Object.freeze(works), plan,
    checksFor: (w: WorkEnvelope) => Object.freeze([...known(w).checks]),
    adapterFor: (w: WorkEnvelope) => known(w).adapterId!,
    inputsFor: (w: WorkEnvelope) => Object.freeze(capturedInputsOf(plan, known(w), request.snapshot)
      .map(i => Object.freeze({ id: i.id, path: request.pathOf(i) }))),
  });
}

/**
 * Refuses an actual captured input set that is not exactly the plan's for this unit: the same artifacts, each once,
 * whatever order they come in. The unit's wider input fingerprint stays a separate binding.
 */
export function verifyInputSet(plan: PlanRevision, ref: WorkRef, actual: readonly { readonly id: ArtifactId }[]): void {
  const unit = unitOf(sealedPlan(plan), ref);
  const want = unit.inputs.map(i => i.content).sort();
  const got = actual.map(i => i.id).sort();
  if (got.length !== want.length || got.some((id, i) => id !== want[i])) throw mismatch(`${ref.id}: the captured inputs are not exactly the plan's`);
}
