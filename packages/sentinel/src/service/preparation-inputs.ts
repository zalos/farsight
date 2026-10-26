// Internal preparation resolution. The returned handle is a store/epoch-bound read proof, not admission.
// It reads actual adopted inputs and exact promoted pack bytes. Readiness remains an effectful later phase.
import type { SentinelStore } from '../store/index.js';
import { boundOwner } from '../store/owner-binding.js';
import type { SnapshotEnvelope } from '../contracts/snapshot.js';
import { snapshot as immutable } from '../policy/immutable.js';
import type { RunEnvelope } from '../contracts/run.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { loadPolicyInputsReadOnly, workspaceIdentity } from '../policy/adoption.js';
import { effectivePolicy, type EffectivePolicy, type PolicyInputs } from '../policy/settings.js';
import { canonicalDigest } from '../policy/digest.js';
import { createAdapterRegistry, type AdapterRegistry, type AdapterDefinition } from '../execution/registry.js';
import { loadPlan } from '../execution/plans.js';
import { planBootstrap } from '../planner/index.js';
import { openSnapshot } from '../snapshot/materialize.js';
import { RuleLockBook, type CurrentLock } from './rule-locks.js';
import type { ValidatedPack } from '../rules/index.js';
import { externalDrivers, publicProfile } from './scanner-profile.js';
import { hasConfiguredReviews, REVIEW_ADAPTERS } from './review-adapter.js';
import { frameworkAvailable, FRAMEWORK_CONTROLS_ADAPTER_ID } from './framework-adapter.js';
import { foundationProfile, OPERATIONS, type TrustedProfile } from './trusted-profile.js';
import { PREVIEW_DETECTOR_ID } from '../adapters/preview-detector.js';
import { workspaceRunIdentity } from './canonical.js';
import {
  checkPreparationClock,
  tightenPreparationClock,
  PreparationError,
  type PreparationClock,
} from './preparation-clock.js';

export const PREPARATION_BUNDLE_LIMIT = 256 * 1024;
export interface PreparationInputs {
  readonly digest: string;
}
export interface PreparationRunIdentity {
  readonly runId: string;
  readonly snapshotId: string;
}
interface Inputs {
  readonly store: SentinelStore;
  readonly epoch: string;
  readonly workspace: string;
  readonly trustDir: string;
  readonly registry: AdapterRegistry;
  readonly policy: EffectivePolicy;
  readonly inputs: PolicyInputs;
  readonly current: CurrentLock;
  readonly packs: readonly ValidatedPack[];
  readonly profile: TrustedProfile;
  readonly bytes: Buffer;
  readonly resolvedBytes: Buffer | null;
}
const inputsFor = new WeakMap<object, Inputs>();
export interface PreparationParent {
  readonly runId: string;
  readonly revision: number;
  readonly planDigest: string;
  readonly snapshotId: string;
}
export interface PreparationAvailability {
  readonly adapterId: string;
  readonly available: boolean;
  readonly reasonCode: string | null;
}
interface PreparedRunState {
  inputs: PreparationInputs;
  clock: PreparationClock;
  parent: PreparationParent | null;
  snapshot: SnapshotEnvelope;
  recordedEnvelope: RunEnvelope | null;
  recordedAnalysis: { revision: number; digest: string; runDeadlineAt: string } | null;
}
const runsFor = new WeakMap<object, PreparedRunState>();
const refuse = (): never => {
  throw new PreparationError('sentinel.preparation.changed');
};

/** Pure candidate terms, not an available-capability claim. Only the existing held-service registry is supplied. */
export function resolvePreparationInputs(
  store: SentinelStore,
  options: {
    readonly workspace: string;
    readonly trustDir: string;
    readonly registry: AdapterRegistry;
  },
  stillWithin: () => void = () => {},
): PreparationInputs {
  boundOwner(store).assertHeld();
  stillWithin();
  const workspace = workspaceIdentity(options.workspace);
  const inputs = loadPolicyInputsReadOnly(options);
  if (inputs.trust !== 'adopted') throw new PreparationError('sentinel.preparation.unavailable');
  const policy = effectivePolicy(inputs);
  const book = new RuleLockBook(options.trustDir, { repairReads: false, stillWithin });
  const current = book.current();
  if (!current) throw new PreparationError('sentinel.preparation.unavailable');
  const packs = book.packsOf(current.lock);
  // These are requested fixed pins, not daemon observations. Discovery must later prove the same profile before capture.
  const ids = new Set(
    packs
      .flatMap((p) =>
        p.manifest.rules.filter((r) => policy.rules.includes(r.familyId)).map((r) => r.implementation.adapterId),
      )
      .filter((id) => externalDrivers().has(id)),
  );
  if (frameworkAvailable(current.lock, packs)) ids.add(FRAMEWORK_CONTROLS_ADAPTER_ID);
  if (
    Object.values(OPERATIONS).some(
      (id) => !options.registry.ids.includes(id) || options.registry.get(id).kind !== 'operation',
    )
  ) {
    throw new PreparationError('sentinel.preparation.unavailable');
  }
  const profile = publicProfile(options.registry, new Set(), packs);
  const fixed = foundationProfile(options.registry).record;
  const bytes = canonicalJsonBytes({
    schema: 'sentinel-preparation-inputs/1',
    storeId: store.storeId,
    workspace,
    inputs,
    policy: { settings: policy.settings, view: policy.view },
    lock: current.lock,
    recipe: {
      schema: 'sentinel-preparation-readiness/1',
      registry: options.registry.ids.map((id) => options.registry.get(id)),
      requestedAdapters: [...ids].sort(),
      operations: fixed.operations,
      resources: fixed.resources,
      parse: fixed.parse,
      unavailable: 'retain-canonical-gaps',
      databasePolicy: 'complete-shipped-ecosystems',
      acquisitions: false,
    },
  });
  if (bytes.length > PREPARATION_BUNDLE_LIMIT) throw new PreparationError('sentinel.preparation.invalid');
  stillWithin();
  store.assertHeld();
  const out = Object.freeze({ digest: canonicalDigest(JSON.parse(bytes.toString('utf8'))) });
  inputsFor.set(out, {
    store,
    epoch: store.epoch,
    workspace: options.workspace,
    trustDir: options.trustDir,
    registry: options.registry,
    policy,
    inputs,
    current,
    packs,
    profile,
    bytes,
    resolvedBytes: null,
  });
  return out;
}

function bound(store: SentinelStore, value: PreparationInputs): Inputs {
  const held = inputsFor.get(value);
  if (!held || held.store !== store || held.epoch !== store.epoch) return refuse();
  store.assertHeld();
  return held;
}

/** A private copy of full canonical input bytes, never a substitute for rederiving current trusted inputs. */
export function preparationInputBytes(store: SentinelStore, value: PreparationInputs): Buffer {
  return Buffer.from(bound(store, value).bytes);
}

/** Full-byte equality against newly read genuine adoption/configuration/lock/profile; a stored digest alone cannot pass. */
export function assertPreparationInputs(store: SentinelStore, value: PreparationInputs, stillWithin: () => void): void {
  const previous = bound(store, value);
  stillWithin();
  const fresh = resolvePreparationInputs(store, previous, stillWithin);
  if (!bound(store, fresh).bytes.equals(previous.bytes)) return refuse();
  stillWithin();
  store.assertHeld();
}

/** Freeze actual discovery once, before capture. Neither this data nor its handle grants admission. */
export function checkPreparationProfile(
  store: SentinelStore,
  value: PreparationInputs,
  available: ReadonlySet<string>,
  clock: PreparationClock,
  answers: readonly PreparationAvailability[] = [],
): PreparationInputs {
  checkPreparationClock(store, clock);
  const original = bound(store, value);
  assertPreparationInputs(store, value, () => clock.stillWithin());
  const intended = JSON.parse(original.bytes.toString('utf8')).recipe.requestedAdapters as string[];
  if (
    [...available].some((id) => !intended.includes(id)) ||
    answers.length > 32 ||
    answers.some(
      (a) =>
        !a ||
        typeof a !== 'object' ||
        Object.keys(a).sort().join(',') !== 'adapterId,available,reasonCode' ||
        typeof a.available !== 'boolean',
    ) ||
    new Set(answers.map((a) => a.adapterId)).size !== answers.length ||
    answers.some(
      (a) =>
        !intended.includes(a.adapterId) ||
        a.available !== available.has(a.adapterId) ||
        (a.available
          ? a.reasonCode !== null
          : ![
              'sentinel.preparation.toolMissing',
              'sentinel.preparation.databaseMissing',
              'sentinel.preparation.databaseMismatch',
              'sentinel.assets.missing',
              'sentinel.execution.imageMissing',
              'sentinel.execution.isolationUnavailable',
              'sentinel.execution.backendUnqualified',
              'sentinel.plan.toolMismatch',
            ].includes(a.reasonCode!)),
    )
  )
    return refuse();
  if (answers.length && answers.length !== intended.length) return refuse();
  // Fixed in-process review operations are part of the shipped registry. This records code availability only;
  // native qualification and model authority remain separate foreground owner actions. Freeze before capture.
  const reviewIds = hasConfiguredReviews(original.policy) ? REVIEW_ADAPTERS.map((a) => a.id) : [];
  const fixedAvailable = new Set([...available, ...reviewIds]);
  const registry = createAdapterRegistry(
    original.registry.ids
      .filter(
        (id) =>
          id === PREVIEW_DETECTOR_ID ||
          (Object.values(OPERATIONS) as readonly string[]).includes(id) ||
          fixedAvailable.has(id),
      )
      .map((id) => original.registry.get(id) as AdapterDefinition),
  );
  const profile = publicProfile(registry, fixedAvailable, original.packs);
  const resolvedBytes = canonicalJsonBytes({
    schema: 'sentinel-preparation-resolved/1',
    initial: value.digest,
    profile: profile.record,
    availability: answers.length
      ? answers
      : intended.map((adapterId) => ({
          adapterId,
          available: available.has(adapterId),
          reasonCode: available.has(adapterId) ? null : 'sentinel.assets.missing',
        })),
  });
  if (resolvedBytes.length > PREPARATION_BUNDLE_LIMIT) throw new PreparationError('sentinel.preparation.invalid');
  if (original.resolvedBytes !== null && !original.resolvedBytes.equals(resolvedBytes))
    throw new PreparationError('sentinel.preparation.changed');
  clock.stillWithin();
  const out = Object.freeze({ digest: value.digest });
  inputsFor.set(out, { ...original, profile, resolvedBytes });
  return out;
}

export function preparationResolvedBytes(store: SentinelStore, value: PreparationInputs): Buffer {
  const bytes = bound(store, value).resolvedBytes;
  if (!bytes) throw new PreparationError('sentinel.preparation.unavailable');
  return Buffer.from(bytes);
}

/** Restore only as data plus fresh genuine rederivation; callers still need new admission and pinned readiness. */
export function restorePreparationInputs(
  store: SentinelStore,
  options: { workspace: string; trustDir: string; registry: AdapterRegistry },
  initialBytes: Uint8Array,
  resolvedBytes: Uint8Array,
  clock: PreparationClock,
): PreparationInputs {
  checkPreparationClock(store, clock);
  if (initialBytes.byteLength > PREPARATION_BUNDLE_LIMIT || resolvedBytes.byteLength > PREPARATION_BUNDLE_LIMIT)
    return refuse();
  const initial = resolvePreparationInputs(store, options, () => clock.stillWithin());
  if (!preparationInputBytes(store, initial).equals(Buffer.from(initialBytes))) return refuse();
  let v: any;
  try {
    v = JSON.parse(Buffer.from(resolvedBytes).toString('utf8'));
  } catch {
    return refuse();
  }
  if (
    !v ||
    Object.keys(v).sort().join(',') !== 'availability,initial,profile,schema' ||
    v.schema !== 'sentinel-preparation-resolved/1' ||
    v.initial !== initial.digest ||
    !Array.isArray(v.availability)
  )
    return refuse();
  const resolved = checkPreparationProfile(
    store,
    initial,
    new Set(v.availability.filter((a: any) => a?.available === true).map((a: any) => a.adapterId)),
    clock,
    v.availability,
  );
  if (!preparationResolvedBytes(store, resolved).equals(Buffer.from(resolvedBytes))) return refuse();
  return resolved;
}

/** Resolve exact identity from a genuine admitted snapshot before any plan-stage or run mutation. */
export async function resolvePreparationRun(
  store: SentinelStore,
  value: PreparationInputs,
  snapshotId: string,
  clock: PreparationClock,
  givenParent: PreparationParent | null = null,
): Promise<PreparationRunIdentity> {
  checkPreparationClock(store, clock);
  if (typeof snapshotId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(snapshotId)) return refuse();
  assertPreparationInputs(store, value, () => clock.stillWithin());
  const terms = bound(store, value);
  if (terms.resolvedBytes === null) throw new PreparationError('sentinel.preparation.unavailable');
  let { snapshot } = await openSnapshot(store, snapshotId);
  clock.stillWithin();
  if (snapshot.sources.length !== 1 || snapshot.sources[0]!.sourceId !== 'workspace') return refuse();
  const parent = givenParent === null ? null : Object.freeze(structuredClone(givenParent));
  if (parent !== null) await checkParent(store, parent, snapshotId, clock);
  const runId = workspaceRunIdentity(store, {
    inventory: snapshot.inventoryDigest,
    lock: terms.current.digest,
    policy: terms.policy.revision,
    profile: terms.profile.digest,
    parent: parent?.runId ?? null,
  });
  const existing = store.ledger.getRun(runId);
  let recordedAnalysis: PreparedRunState['recordedAnalysis'] = null;
  if (existing) {
    const admitted = await loadPlan(store, runId, existing.planRevision);
    clock.stillWithin();
    if (
      !canonicalJsonBytes(admitted.profile).equals(canonicalJsonBytes(terms.profile.record)) ||
      existing.envelope.ruleLockDigest !== terms.current.digest ||
      existing.envelope.policyRevisionDigest !== terms.policy.revision ||
      existing.envelope.parentId !== (parent?.runId ?? null)
    )
      return refuse();
    const pinned = await openSnapshot(store, existing.envelope.snapshotId);
    clock.stillWithin();
    if (pinned.snapshot.inventoryDigest !== snapshot.inventoryDigest) return refuse();
    snapshot = pinned.snapshot;
    const deadline = Date.parse(existing.envelope.createdAt) + existing.envelope.budgets.deadlineMs;
    // Disclosing the exact recorded analysis starts no work and must not tighten a fresh request to an
    // already expired execution clock. Bootstrap continuation still preserves that earlier bound.
    if (admitted.plan.kind === 'analysis')
      recordedAnalysis = {
        revision: admitted.plan.revision,
        digest: admitted.plan.digest,
        runDeadlineAt: new Date(deadline).toISOString(),
      };
    else if (deadline < Date.parse(clock.runDeadlineAt))
      tightenPreparationClock(store, clock, new Date(deadline).toISOString());
  }
  assertPreparationInputs(store, value, () => clock.stillWithin());
  const out = Object.freeze({ runId, snapshotId: snapshot.id });
  runsFor.set(out, {
    inputs: value,
    clock,
    parent,
    snapshot: immutable(snapshot),
    recordedEnvelope: existing?.envelope ?? null,
    recordedAnalysis,
  });
  return out;
}

/** Read-only exact recorded analysis disclosure. This never admits/promotes a plan or renews its clock. */
export function existingPreparationAnalysis(store: SentinelStore, identity: PreparationRunIdentity) {
  preparationRunContext(store, identity);
  const proof = runsFor.get(identity)!,
    analysis = proof.recordedAnalysis;
  if (!analysis) return null;
  const actual = store.ledger.getRun(identity.runId),
    plan = store.ledger.getPlan(identity.runId, analysis.revision);
  if (
    !actual ||
    actual.planRevision !== analysis.revision ||
    actual.envelope.snapshotId !== identity.snapshotId ||
    actual.envelope.createdAt !== proof.recordedEnvelope!.createdAt ||
    actual.envelope.budgets.deadlineMs !== proof.recordedEnvelope!.budgets.deadlineMs ||
    plan?.digest !== analysis.digest
  )
    return refuse();
  proof.clock.stillWithin();
  return Object.freeze({ ...analysis });
}

/** Record an already admitted bootstrap as planned with the ORIGINAL clock, before Coordinator.open.
 * No coordinator default changes. An existing row is never overwritten or promoted by this helper. */
export async function recordPreparationBootstrap(
  store: SentinelStore,
  identity: PreparationRunIdentity,
): Promise<{ runDeadlineAt: string }> {
  const run = runsFor.get(identity);
  if (!run) return refuse();
  preparationRunContext(store, identity);
  checkPreparationClock(store, run.clock);
  const terms = bound(store, run.inputs);
  assertPreparationInputs(store, run.inputs, () => run.clock.stillWithin());
  if (run.parent) await checkParent(store, run.parent, identity.snapshotId, run.clock);
  const admitted = await loadPlan(store, identity.runId, 1);
  run.clock.stillWithin();
  const expected = planBootstrap({ runId: identity.runId, sourceIds: ['workspace'], profile: terms.profile.planner });
  if (
    admitted.plan.kind !== 'bootstrap' ||
    admitted.plan.digest !== expected.digest ||
    admitted.selection ||
    !canonicalJsonBytes(admitted.profile).equals(canonicalJsonBytes(terms.profile.record))
  )
    return refuse();
  const envelope: RunEnvelope = {
    schema: 'sentinel-run/draft-1',
    id: identity.runId,
    parentId: run.parent?.runId ?? null,
    baselineId: null,
    snapshotId: identity.snapshotId,
    planRevision: 1,
    coordinatorEpoch: store.epoch,
    ruleLockDigest: terms.current.digest,
    toolLockDigest: terms.current.digest,
    policyRevisionDigest: terms.policy.revision,
    requestedScope: { sourceIds: ['workspace'], profile: terms.profile.planner.id },
    budgets: {
      maxTokens: null,
      maxCost: null,
      deadlineMs: Date.parse(run.clock.runDeadlineAt) - Date.parse(run.clock.acceptedAt),
    },
    createdAt: run.clock.acceptedAt,
    state: 'planned',
  } as RunEnvelope;
  const recorded = store.ledger.getRun(identity.runId);
  if (recorded) {
    const { state: _oldState, coordinatorEpoch: _oldEpoch, ...old } = recorded.envelope;
    const { state: _state, coordinatorEpoch: _epoch, ...expected } = envelope;
    const prior = run.recordedEnvelope;
    if (!prior || recorded.planRevision !== 1) return refuse();
    const { state: _priorState, coordinatorEpoch: _priorEpoch, ...priorFields } = prior;
    if (
      !canonicalJsonBytes(old).equals(canonicalJsonBytes(priorFields)) ||
      old.snapshotId !== identity.snapshotId ||
      old.ruleLockDigest !== expected.ruleLockDigest ||
      old.policyRevisionDigest !== expected.policyRevisionDigest
    )
      return refuse();
    const deadline = Date.parse(old.createdAt) + old.budgets.deadlineMs;
    if (deadline < Date.parse(run.clock.runDeadlineAt))
      tightenPreparationClock(store, run.clock, new Date(deadline).toISOString());
  } else {
    assertPreparationInputs(store, run.inputs, () => run.clock.stillWithin());
    run.clock.stillWithin();
    store.ledger.createRun(envelope);
    run.recordedEnvelope = store.ledger.getRun(identity.runId)!.envelope;
  }
  run.clock.stillWithin();
  return Object.freeze({ runDeadlineAt: run.clock.runDeadlineAt });
}

/** Internal trusted controller access; it is never serialized as a service response or treated as admission. */
export function preparationTerms(store: SentinelStore, value: PreparationInputs, stillWithin: () => void) {
  assertPreparationInputs(store, value, stillWithin);
  const t = bound(store, value);
  return Object.freeze({
    policy: t.policy,
    current: t.current,
    packs: t.packs,
    profile: t.profile,
    registry: t.registry,
    workspace: t.workspace,
    trustDir: t.trustDir,
    resolved: t.resolvedBytes !== null,
  });
}

async function checkParent(
  store: SentinelStore,
  parent: PreparationParent,
  snapshotId: string,
  clock: PreparationClock,
): Promise<void> {
  if (
    typeof parent.runId !== 'string' ||
    typeof parent.revision !== 'number' ||
    !Number.isSafeInteger(parent.revision) ||
    typeof parent.planDigest !== 'string' ||
    parent.snapshotId !== snapshotId
  )
    return refuse();
  const actual = store.ledger.getRun(parent.runId);
  if (
    !actual ||
    !['completed', 'canceled'].includes(actual.state) ||
    actual.planRevision !== parent.revision ||
    actual.envelope.snapshotId !== snapshotId
  )
    return refuse();
  const admitted = await loadPlan(store, parent.runId, actual.planRevision);
  clock.stillWithin();
  const after = store.ledger.getRun(parent.runId);
  if (
    admitted.plan.digest !== parent.planDigest ||
    !after ||
    after.planRevision !== parent.revision ||
    !['completed', 'canceled'].includes(after.state) ||
    after.envelope.snapshotId !== snapshotId
  )
    return refuse();
}

/** Immediate pre-admission binding: rederive generation and current recorded parent, never caller metadata. */
export function preparationRunContext(store: SentinelStore, identity: PreparationRunIdentity) {
  const run = runsFor.get(identity);
  if (!run) return refuse();
  checkPreparationClock(store, run.clock);
  const terms = preparationTerms(store, run.inputs, () => run.clock.stillWithin());
  const id = workspaceRunIdentity(store, {
    inventory: run.snapshot.inventoryDigest,
    lock: terms.current.digest,
    policy: terms.policy.revision,
    profile: terms.profile.digest,
    parent: run.parent?.runId ?? null,
  });
  if (id !== identity.runId || identity.snapshotId !== run.snapshot.id) return refuse();
  if (run.parent) {
    const current = store.ledger.getRun(run.parent.runId),
      plan = store.ledger.getPlan(run.parent.runId, run.parent.revision);
    if (
      !current ||
      !['completed', 'canceled'].includes(current.state) ||
      current.planRevision !== run.parent.revision ||
      current.envelope.snapshotId !== run.parent.snapshotId ||
      plan?.digest !== run.parent.planDigest
    )
      return refuse();
  }
  run.clock.stillWithin();
  return Object.freeze({ ...terms, inputs: run.inputs, clock: run.clock, parent: run.parent, snapshot: run.snapshot });
}
