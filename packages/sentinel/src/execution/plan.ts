// The approved plan, captured once and checked before anything runs.
//
// At Coordinator.open the plan's run and work envelopes are deep-copied and frozen, and each work's adapter and
// captured inputs are resolved once; nothing the caller does to its objects or callbacks afterwards changes what
// executes. Each work is bound exactly:
//   - its stage's implementationDigest is the trusted adapter's digest;
//   - its inputFingerprint is inputFingerprintOf(the captured input ids) — the fingerprint the worker's start
//     message carries and its result must repeat;
//   - its influenceManifest is the artifact id of the influence manifest below (canonical JSON listing every
//     fingerprint input), which is published with the result so the binding can be inspected.
// A work revision or run already in the ledger must be this plan's, field for field; a reference to another run's
// work is refused (reuse across runs needs an explicit satisfied-by-reuse lineage, which this coordinator does not
// execute). Coverage is evaluated from the worker's own result against the plan's required checks and scope.
import { createHash } from 'node:crypto';
import type { ArtifactId, Digest, Id, ScopeId, WorkRef } from '../contracts/common.js';
import type { ResultMessage } from '../contracts/protocol.js';
import type { RunEnvelope } from '../contracts/run.js';
import type { WorkEnvelope } from '../contracts/work.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { ExecutionError } from './errors.js';
import type { AdapterRegistry, TrustedAdapter } from './registry.js';
import { orderPlan } from './scheduler.js';
import { inputFingerprintOf, type CapturedInput } from './supervisor.js';

export const INFLUENCE_SCHEMA = 'sentinel-influence/draft-1';
export const COVERAGE_EVALUATION_SCHEMA = 'sentinel-coverage-evaluation/draft-1';

/** What a work must cover for its result to count as complete coverage. */
export interface RequiredCoverage {
  /** Every planned check id must appear in the result's coveredChecks. */
  checks: readonly Id[];
  /** Every scope id must be in the result's scannedSet and in no skipped or unresolved entry. */
  scope: readonly ScopeId[];
}

/** The plan as approved: frozen copies, with each work's adapter, inputs and required coverage resolved once. */
export interface ValidatedPlan {
  readonly run: Readonly<RunEnvelope>;
  readonly works: readonly Readonly<WorkEnvelope>[];
  adapterOf(ref: WorkRef): TrustedAdapter;
  inputsOf(ref: WorkRef): readonly CapturedInput[];
  manifestOf(ref: WorkRef): Readonly<InfluenceManifest>;
  requiredOf(ref: WorkRef): Readonly<RequiredCoverage> | undefined;
}

export interface InfluenceManifest {
  schema: typeof INFLUENCE_SCHEMA;
  work: WorkRef;
  stage: WorkEnvelope['stage'];
  adapter: { id: Id; digest: Digest };
  inputs: ArtifactId[];
  inputFingerprint: Digest;
  dependencies: WorkRef[];
  resources: WorkEnvelope['resources'];
}

const key = (r: WorkRef) => `${r.id}@${r.revision}`;
const sha = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const refuse = (reason: string): never => { throw new ExecutionError('sentinel.execution.planInvalid', { reason }); };

/** The influence manifest a work's influenceManifest must name, and its artifact id. */
export function influenceManifest(work: Pick<WorkEnvelope, 'id' | 'revision' | 'stage' | 'dependencies' | 'resources'>, adapter: { id: Id; digest: Digest }, inputs: readonly ArtifactId[]): { manifest: InfluenceManifest; id: ArtifactId } {
  const sorted = [...inputs].sort();
  const manifest: InfluenceManifest = {
    schema: INFLUENCE_SCHEMA, work: { id: work.id, revision: work.revision }, stage: work.stage, adapter: { id: adapter.id, digest: adapter.digest },
    inputs: sorted, inputFingerprint: inputFingerprintOf(sorted), dependencies: work.dependencies.map(d => ({ id: d.id, revision: d.revision })), resources: work.resources,
  };
  return { manifest, id: sha(canonicalJsonBytes(manifest)) };
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v as object)) deepFreeze(x); }
  return v;
}

export interface PlanSource {
  readonly run: RunEnvelope;
  readonly works: readonly WorkEnvelope[];
  adapterFor(work: WorkEnvelope): Id;
  inputsFor(work: WorkEnvelope): readonly CapturedInput[];
  requiredCoverage?(work: WorkEnvelope): RequiredCoverage | undefined;
}

export function validatePlan(source: PlanSource, registry: AdapterRegistry): ValidatedPlan {
  const run = deepFreeze(structuredClone(source.run));
  const works = deepFreeze(structuredClone([...source.works]));
  orderPlan(works);
  const adapters = new Map<string, TrustedAdapter>(), inputs = new Map<string, readonly CapturedInput[]>();
  const manifests = new Map<string, InfluenceManifest>(), required = new Map<string, RequiredCoverage>();
  for (let i = 0; i < works.length; i++) {
    const w = works[i]!, original = source.works[i]!, k = key(w);
    if (w.runId !== run.id || w.planRevision !== run.planRevision) refuse(`work ${k} belongs to another run or plan revision`);
    if (!['pending', 'ready', 'blocked', 'disabled-by-policy'].includes(w.state)) {
      refuse(w.state === 'satisfied-by-reuse' ? `work ${k} is satisfied by reuse, which this coordinator does not execute` : `work ${k} is ${w.state}, not a plan state`);
    }
    const adapter = registry.get(source.adapterFor(original));
    if (adapter.digest !== w.stage.implementationDigest) refuse(`work ${k} names stage implementation ${w.stage.implementationDigest}, not adapter ${adapter.id}`);
    const captured = deepFreeze(structuredClone([...source.inputsFor(original)]));
    const ids = captured.map(c => c.id);
    if (new Set(ids).size !== ids.length) refuse(`work ${k} lists an input twice`);
    if (w.inputFingerprint !== inputFingerprintOf(ids)) refuse(`work ${k} input fingerprint does not match its captured inputs`);
    const m = influenceManifest(w, adapter, ids);
    if (w.influenceManifest !== m.id) refuse(`work ${k} influence manifest does not match its stage, adapter, inputs, dependencies and resources`);
    const req = source.requiredCoverage?.(original);
    if (req) required.set(k, deepFreeze(structuredClone({ checks: [...req.checks], scope: [...req.scope] })));
    adapters.set(k, adapter); inputs.set(k, captured); manifests.set(k, deepFreeze(m.manifest));
  }
  const get = <T>(m: Map<string, T>, r: WorkRef) => { const v = m.get(key(r)); if (v === undefined) refuse(`work ${key(r)} is not in the plan`); return v as T; };
  return Object.freeze({
    run, works,
    adapterOf: (r: WorkRef) => get(adapters, r),
    inputsOf: (r: WorkRef) => get(inputs, r),
    manifestOf: (r: WorkRef) => get(manifests, r),
    requiredOf: (r: WorkRef) => required.get(key(r)),
  });
}

const RUN_IDENTITY = ['id', 'parentId', 'baselineId', 'snapshotId', 'planRevision', 'ruleLockDigest', 'toolLockDigest', 'policyRevisionDigest', 'promptPolicyDigest', 'requestedScope', 'budgets'] as const;
const WORK_IDENTITY = ['id', 'revision', 'runId', 'planRevision', 'stage', 'inputFingerprint', 'influenceManifest', 'dependencies', 'resources'] as const;
const same = (a: unknown, b: unknown) => Buffer.from(canonicalJsonBytes(a ?? null)).equals(canonicalJsonBytes(b ?? null));

/** A recorded run must be this plan's run, field for field (state, epoch and times aside). */
export function checkRecordedRun(plan: ValidatedPlan, recorded: RunEnvelope | undefined): void {
  if (!recorded) return;
  for (const f of RUN_IDENTITY) if (!same((plan.run as unknown as Record<string, unknown>)[f], (recorded as unknown as Record<string, unknown>)[f])) refuse(`run ${plan.run.id} is recorded with another ${f}`);
}

/** A recorded work revision must be this plan's, for this run, field for field (state, epoch and times aside). */
export function checkRecordedWork(plan: ValidatedPlan, ref: WorkRef, recorded: { runId: Id; envelope: WorkEnvelope } | null): void {
  if (!recorded) return;
  if (recorded.runId !== plan.run.id) refuse(`work ${key(ref)} belongs to run ${recorded.runId}; reuse across runs needs a satisfied-by-reuse lineage`);
  const w = plan.works.find(x => x.id === ref.id && x.revision === ref.revision)!;
  for (const f of WORK_IDENTITY) if (!same((w as unknown as Record<string, unknown>)[f], (recorded.envelope as unknown as Record<string, unknown>)[f])) refuse(`work ${key(ref)} is recorded with another ${f}`);
}

export type CoverageVerdict = 'complete' | 'incomplete' | 'unevaluated';

export interface CoverageEvaluation {
  schema: typeof COVERAGE_EVALUATION_SCHEMA;
  work: WorkRef;
  verdict: CoverageVerdict;
  missingChecks: Id[];
  missingScope: ScopeId[];
  skipped: Array<{ scopeId: ScopeId; reasonCode: string }>;
  unresolved: Array<{ scopeId: ScopeId; reasonCode: string }>;
}

/**
 * The worker's own coverage facts against the plan's requirement. Without a requirement nothing can be said
 * complete: unevaluated. Any skipped or unresolved entry, a planned check not covered, or required scope not
 * scanned (or skipped) is incomplete. A process that exited cleanly proves nothing about coverage.
 */
export function evaluateCoverage(work: WorkRef, result: ResultMessage, required: RequiredCoverage | undefined): CoverageEvaluation {
  const skipped = result.skipped.map(s => ({ scopeId: s.scopeId, reasonCode: s.reasonCode }));
  const unresolved = result.unresolvedFrontiers.map(s => ({ scopeId: s.scopeId, reasonCode: s.reasonCode }));
  if (!required) return { schema: COVERAGE_EVALUATION_SCHEMA, work, verdict: 'unevaluated', missingChecks: [], missingScope: [], skipped, unresolved };
  const covered = new Set(result.coveredChecks.map(c => c.checkId));
  const scanned = new Set(result.scannedSet);
  const notCovered = new Set([...skipped, ...unresolved].map(s => s.scopeId));
  const missingChecks = required.checks.filter(c => !covered.has(c));
  const missingScope = required.scope.filter(s => !scanned.has(s) || notCovered.has(s));
  const verdict = missingChecks.length || missingScope.length || skipped.length || unresolved.length ? 'incomplete' : 'complete';
  return { schema: COVERAGE_EVALUATION_SCHEMA, work, verdict, missingChecks, missingScope, skipped, unresolved };
}
