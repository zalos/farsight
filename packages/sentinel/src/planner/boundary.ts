// From a sealed plan revision to what the coordinator (PR 08) executes: canonical sentinel-work/draft-1 envelopes,
// one per unit, with the resources the trusted profile grants each stage, and each unit's influence manifest (the
// inspectable list of everything its input fingerprint covers). The coordinator stores each manifest with
// putCanonicalJson before creating the work: its artifact id is the canonical digest of the value given here.
//
// Nothing here adds coverage. checksCoveredBy() returns exactly the checks the plan assigned to a unit, and a unit's
// captured inputs are exactly the files the plan lists for it, resolved against the snapshot it pins.
import { createHash } from 'node:crypto';
import type { ArtifactId, Id, Timestamp, WorkRef } from '../contracts/common.js';
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
    const envelope: WorkEnvelope = {
      schema: 'sentinel-work/draft-1', id: u.id, revision: u.revision, runId: plan.runId, planRevision: plan.revision,
      stage: { contract: u.contract, contractVersion: 'draft-1', kind, implementationDigest: u.implementationDigest },
      inputFingerprint: u.inputFingerprint, influenceManifest: canonicalArtifactId(manifest),
      dependencies: u.dependencies.map(d => ({ id: d.id, revision: d.revision })), resources: { ...resources },
      coordinatorEpoch: conversion.coordinatorEpoch, createdAt: conversion.createdAt,
      state: u.dependencies.length ? 'pending' : 'ready', activeAttemptId: null,
    };
    const checked = validateEnvelope('work', envelope);
    if (!checked.ok) throw invalid(`${u.id} is not a valid work envelope: ${checked.errors[0]?.path || '/'} ${checked.errors[0]?.message ?? ''}`);
    return Object.freeze({ envelope: checked.value, manifest });
  });
}

/** Exactly the checks the plan assigned to this unit: never more. */
export function checksCoveredBy(plan: PlanRevision, ref: WorkRef): readonly Id[] {
  return [...unitOf(sealedPlan(plan), ref).checks];
}

/** The adapter that runs a check unit; null for the bootstrap stages, which the service runs itself. */
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
    return { sourceId: i.sourceId, relativePath: i.relativePath, id };
  });
}
