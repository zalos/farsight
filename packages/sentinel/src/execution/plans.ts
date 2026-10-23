// Plan admission: an exact PR 06 plan revision, with the rule lock, effective policy and execution profile it was
// made under, made durable in one ledger transaction, and read back verified.
//
// What is checked before anything is written: the plan validates and matches its own digest; the rule lock's digest
// is the plan's pin, and so is the effective policy's revision (its stored record is exactly the value that revision
// digests); the profile record is the plan's profile and holds every adapter and capability the plan pins; an
// analysis plan pins an admitted snapshot. Then the four records are staged, stored and admitted together; the plan
// is a collection root and links the other three. loadPlan reads them back and repeats every check, so what the
// coordinator executes is exactly what was admitted, whatever happened to the caller's objects.
import type { PathRequestEnvelope } from '../contracts/pathrequest.js';
import { pathRequestOf, PATH_REQUEST_SCHEMA } from '../analysis/paths/request.js';
import { verifyPathAdmission, pathUnitsFor, type PathRequestAdmission } from '../analysis/paths/admission.js';
import { createHash } from 'node:crypto';
import type { ArtifactId, Id } from '../contracts/common.js';
import type { RuleLockEnvelope } from '../contracts/rules.js';
import { verifyPlanRevision } from '../planner/planner.js';
import type { PlanRevision } from '../planner/types.js';
import { isEffectivePolicy, type EffectivePolicy } from '../policy/settings.js';
import { lockDigest } from '../rules/lock.js';
import type { SentinelStore } from '../store/index.js';
import { canonicalJsonBytes } from '../store/objects.js';
import type { PlanRecord } from '../store/store-types.js';
import { validateEnvelope } from '../validate.js';
import { ExecutionError } from './errors.js';
import { checkProfileForPlan, type ExecutionProfileRecord } from './profile.js';
import { checkSelection, SELECTION_SCHEMA, type RerunSelection } from './selection.js';
import { COVERAGE_SCHEMA } from './coverage.js';
import { evaluateRequiredCoverage, type RequiredCoverage } from '../planner/coverage.js';
import type { CoverageEnvelope } from '../contracts/coverage.js';

/** The record an effective policy's revision is the digest of. */
export interface EffectivePolicyRecord {
  kind: 'sentinel-effective-policy/1';
  settings: EffectivePolicy['settings'];
  view: EffectivePolicy['view'];
}

export interface AdmitPlanRequest {
  plan: PlanRevision;
  /** Both for an analysis revision; neither for a bootstrap one. */
  ruleLock: RuleLockEnvelope | null;
  policy: EffectivePolicy | null;
  profile: ExecutionProfileRecord;
  /** A selected rerun's selection (analysis revisions only): the units this run executes. */
  selection?: RerunSelection | null;
  /** Required exactly when the plan pins a source-derived structural request. */
  pathRequest?: PathRequestAdmission;
}

export interface AdmittedPlan {
  record: PlanRecord;
  plan: PlanRevision;
  ruleLock: RuleLockEnvelope | null;
  policy: EffectivePolicyRecord | null;
  profile: ExecutionProfileRecord;
  selection: RerunSelection | null;
  /** Accepted canonical request bytes; absent for all legacy plans. Never a launch capability. */
  pathRequest?: Readonly<PathRequestEnvelope>;
}

const refuse = (reason: string): never => { throw new ExecutionError('sentinel.execution.planInvalid', { reason }); };
const digestOf = (v: unknown): ArtifactId => `sha256:${createHash('sha256').update(canonicalJsonBytes(v)).digest('hex')}`;
const policyRecordOf = (p: EffectivePolicy): EffectivePolicyRecord => ({ kind: 'sentinel-effective-policy/1', settings: p.settings, view: p.view });

function check(plan: PlanRevision, ruleLock: RuleLockEnvelope | null, policy: EffectivePolicyRecord | null, profile: ExecutionProfileRecord): void {
  if (!validateEnvelope('plan', plan).ok || !verifyPlanRevision(plan)) refuse('the plan revision does not validate or match its digest');
  if (plan.kind === 'analysis') {
    if (!ruleLock || !policy) refuse('an analysis plan is admitted with its rule lock and effective policy');
    if (!validateEnvelope('rulelock', ruleLock).ok || lockDigest(ruleLock!) !== plan.pins.ruleLockDigest) refuse('the rule lock is not the one the plan pins');
    if (digestOf(policy) !== plan.pins.policyDigest) refuse('the effective policy is not the one the plan pins');
  } else if (ruleLock || policy) {
    refuse('a bootstrap plan pins no rule lock and no policy');
  }
  checkProfileForPlan(profile, plan);
}

/** Admit an exact plan revision with what it pins. Returns the ledger's record. */
export async function admitPlan(store: SentinelStore, request: AdmitPlanRequest): Promise<PlanRecord> {
  store.assertHeld();
  const plan = structuredClone(request.plan);
  const ruleLock = request.ruleLock ? structuredClone(request.ruleLock) : null;
  if (request.policy !== null && !isEffectivePolicy(request.policy)) refuse('the policy is accepted only as effectivePolicy returned it');
  const policy = request.policy ? structuredClone(policyRecordOf(request.policy)) : null;
  const profile = structuredClone(request.profile);
  const selection = request.selection ? structuredClone(request.selection) : null;
  check(plan, ruleLock, policy, profile);
  if (selection) checkSelection(plan, selection);
  if (selection && plan.pins.pathRequest) refuse('selected reruns of path tasks require a separately authenticated request selection');
  if (plan.pins.snapshotId !== null && !store.ledger.getSnapshot(plan.pins.snapshotId)) refuse('the plan pins a snapshot that was not admitted');
  if ((plan.pins.pathRequest!==undefined)!==(request.pathRequest!==undefined)) refuse('a pinned path request requires its genuine read proof');
  const path=request.pathRequest?await verifyPathAdmission(store,plan,profile,request.pathRequest):undefined;
  const ids = {
    plan: store.objects.identifyCanonicalJson(plan), profile: store.objects.identifyCanonicalJson(profile),
    ruleLock: ruleLock ? store.objects.identifyCanonicalJson(ruleLock) : null, policy: policy ? store.objects.identifyCanonicalJson(policy) : null,
    selection: selection ? store.objects.identifyCanonicalJson(selection) : null,
  };
  // Admitting exactly the same revision again (the same plan and pinned records) returns the existing record.
  const existing = store.ledger.getPlan(plan.runId, plan.revision);
  if (existing) {
    if (existing.digest === plan.digest && existing.plan === ids.plan.id && existing.profile === ids.profile.id
      && existing.ruleLock === (ids.ruleLock?.id ?? null) && existing.policy === (ids.policy?.id ?? null)
      && existing.selection === (ids.selection?.id ?? null)) return existing;
    refuse(`revision ${plan.revision} of run ${plan.runId} was already admitted with other content`);
  }
  const pinned = [ids.profile.id, ...(ids.ruleLock ? [ids.ruleLock.id] : []), ...(ids.policy ? [ids.policy.id] : []), ...(ids.selection ? [ids.selection.id] : []),...(path?[path.request.id]:[])];
  const stageId = `plan.${plan.runId}.${plan.revision}.${plan.digest.slice(7, 23)}`.slice(0, 128);
  path?.boundary();
  store.ledger.registerStaging(stageId, [
    { id: ids.plan.id, schema: 'sentinel-plan/draft-1', privacy: 'source-derived', links: pinned },
    { id: ids.profile.id, schema: profile.schema, privacy: 'metadata' },
    ...(ruleLock ? [{ id: ids.ruleLock!.id, schema: 'sentinel-rulelock/draft-1', privacy: 'metadata' as const }] : []),
    ...(policy ? [{ id: ids.policy!.id, schema: policy.kind, privacy: 'metadata' as const }] : []),
    ...(selection ? [{ id: ids.selection!.id, schema: SELECTION_SCHEMA, privacy: 'metadata' as const }] : []),
    ...(path?[{id:path.request.id,schema:PATH_REQUEST_SCHEMA,privacy:'source-derived' as const,links:path.links}]:[]),
  ]);
  const put = async (value:unknown, expect: {id:ArtifactId;rawSize:number}) => {
    path?.boundary();const receipt=await store.objects.putCanonicalJson(value,{expect});path?.boundary();return receipt;
  };
  try {
    const receipts = [await put(plan, ids.plan), await put(profile, ids.profile)];
    if (ruleLock) receipts.push(await put(ruleLock, ids.ruleLock!));
    if (policy) receipts.push(await put(policy, ids.policy!));
    if (selection) receipts.push(await put(selection, ids.selection!));
    if(path) receipts.push(await put(path.request.value,{id:path.request.id,rawSize:canonicalJsonBytes(path.request.value).length}));
    path?.boundary();
    store.assertHeld();
    return store.ledger.admitPlan({ runId: plan.runId, revision: plan.revision, kind: plan.kind, digest: plan.digest, previous: plan.previous,
      plan: ids.plan.id, ruleLock: ids.ruleLock?.id ?? null, policy: ids.policy?.id ?? null, profile: ids.profile.id, selection: ids.selection?.id ?? null,
      snapshotId: plan.pins.snapshotId, stageIds: [stageId], receipts });
  } catch (error) {
    try { store.assertHeld(); store.ledger.abortStaging(stageId); } catch { /* recovery aborts a stage left open */ }
    throw error;
  }
}

async function readJson<T>(store: SentinelStore, id: ArtifactId): Promise<T> {
  const value = JSON.parse((await store.readArtifact(id)).toString('utf8')) as T;
  if (digestOf(value) !== id) refuse('a stored plan record does not match its artifact id');
  return value;
}

/** An admitted plan revision (the latest when none is named) and what it pins, read back and checked again. */
export async function loadPlan(store: SentinelStore, runId: Id, revision?: number): Promise<AdmittedPlan> {
  const record = revision === undefined ? store.ledger.latestPlan(runId) : store.ledger.getPlan(runId, revision);
  if (!record) return refuse(`plan revision ${revision} of run ${runId} was not admitted`);
  const plan = await readJson<PlanRevision>(store, record.plan);
  const ruleLock = record.ruleLock ? await readJson<RuleLockEnvelope>(store, record.ruleLock) : null;
  const policy = record.policy ? await readJson<EffectivePolicyRecord>(store, record.policy) : null;
  const profile = await readJson<ExecutionProfileRecord>(store, record.profile);
  const selection = record.selection ? await readJson<RerunSelection>(store, record.selection) : null;
  check(plan, ruleLock, policy, profile);
  if (selection) checkSelection(plan, selection);
  if (selection && plan.pins.pathRequest) refuse('selected reruns of path tasks require a separately authenticated request selection');
  const pathRequest=plan.pins.pathRequest?pathRequestOf(await readJson(store,plan.pins.pathRequest)):undefined;
  if(pathRequest) pathUnitsFor(plan,pathRequest);
  if (plan.runId !== record.runId || plan.revision !== record.revision || plan.digest !== record.digest || plan.kind !== record.kind
    || plan.previous !== record.previous || plan.pins.snapshotId !== record.snapshotId) refuse('the stored plan is not the revision the ledger admitted');
  return { record, plan, ruleLock, policy, profile, selection,...(pathRequest?{pathRequest:pathRequest.value}:{}) };
}

/**
 * Required coverage of an admitted analysis revision, from the canonical coverage records its units published:
 * PR 06's evaluateRequiredCoverage over them alone. A unit that has not published contributes nothing.
 */
export async function requiredCoverageOf(store: SentinelStore, runId: Id, revision?: number): Promise<RequiredCoverage> {
  const { plan } = await loadPlan(store, runId, revision);
  if (plan.kind !== 'analysis') refuse('a bootstrap revision has no checks');
  const records: CoverageEnvelope[] = [];
  for (const u of plan.units) {
    for (const o of store.ledger.getPublication({ id: u.id, revision: u.revision })?.outputs ?? []) {
      if (o.schema === COVERAGE_SCHEMA) records.push(await readJson<CoverageEnvelope>(store, o.id));
    }
  }
  return evaluateRequiredCoverage(plan, records);
}
