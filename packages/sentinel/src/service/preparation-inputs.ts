// Internal preparation resolution. The returned handle is a store/epoch-bound read proof, not admission.
// It reads actual adopted inputs and exact promoted pack bytes. Readiness remains an effectful later phase.
import type { SentinelStore } from '../store/index.js';
import { boundOwner } from '../store/owner-binding.js';
import type { RunEnvelope } from '../contracts/run.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { loadPolicyInputsReadOnly, workspaceIdentity } from '../policy/adoption.js';
import { effectivePolicy, type EffectivePolicy, type PolicyInputs } from '../policy/settings.js';
import { canonicalDigest } from '../policy/digest.js';
import type { AdapterRegistry } from '../execution/registry.js';
import { loadPlan } from '../execution/plans.js';
import { planBootstrap } from '../planner/index.js';
import { openSnapshot } from '../snapshot/materialize.js';
import { RuleLockBook, type CurrentLock } from './rule-locks.js';
import type { ValidatedPack } from '../rules/index.js';
import { externalDrivers, publicProfile } from './scanner-profile.js';
import { frameworkAvailable, FRAMEWORK_CONTROLS_ADAPTER_ID } from './framework-adapter.js';
import type { TrustedProfile } from './trusted-profile.js';
import { workspaceRunIdentity } from './canonical.js';
import { checkPreparationClock, PreparationError, type PreparationClock } from './preparation-clock.js';

export const PREPARATION_BUNDLE_LIMIT = 256 * 1024;
export interface PreparationInputs { readonly digest: string }
export interface PreparationRunIdentity { readonly runId: string; readonly snapshotId: string }
interface Inputs {
  readonly store: SentinelStore; readonly epoch: string; readonly workspace: string; readonly trustDir: string;
  readonly registry: AdapterRegistry; readonly policy: EffectivePolicy; readonly inputs: PolicyInputs;
  readonly current: CurrentLock; readonly packs: readonly ValidatedPack[]; readonly profile: TrustedProfile;
  readonly bytes: Buffer;
}
const inputsFor = new WeakMap<object, Inputs>();
export interface PreparationParent { readonly runId: string; readonly revision: number; readonly planDigest: string; readonly snapshotId: string }
const runsFor = new WeakMap<object, { inputs: PreparationInputs; clock: PreparationClock; parent: PreparationParent | null }>();
const refuse = (): never => { throw new PreparationError('sentinel.preparation.changed'); };

/** Pure candidate terms, not an available-capability claim. Only the existing held-service registry is supplied. */
export function resolvePreparationInputs(store: SentinelStore, options: {
  readonly workspace: string; readonly trustDir: string; readonly registry: AdapterRegistry;
}, stillWithin: () => void = () => {}): PreparationInputs {
  boundOwner(store).assertHeld(); stillWithin();
  const workspace = workspaceIdentity(options.workspace);
  const inputs = loadPolicyInputsReadOnly(options);
  if (inputs.trust !== 'adopted') throw new PreparationError('sentinel.preparation.unavailable');
  const policy = effectivePolicy(inputs);
  const book = new RuleLockBook(options.trustDir, { repairReads: false, stillWithin });
  const current = book.current();
  if (!current) throw new PreparationError('sentinel.preparation.unavailable');
  const packs = book.packsOf(current.lock);
  // These are requested fixed pins, not daemon observations. Discovery must later prove the same profile before capture.
  const ids = new Set(packs.flatMap(p => p.manifest.rules.filter(r => policy.rules.includes(r.familyId))
    .map(r => r.implementation.adapterId)).filter(id => externalDrivers().has(id)));
  if (frameworkAvailable(current.lock, packs)) ids.add(FRAMEWORK_CONTROLS_ADAPTER_ID);
  const profile = publicProfile(options.registry, ids, packs);
  const bytes = canonicalJsonBytes({ schema: 'sentinel-preparation-inputs/1', storeId: store.storeId, workspace,
    inputs, policy: { settings: policy.settings, view: policy.view }, lock: current.lock, profile: profile.record });
  if (bytes.length > PREPARATION_BUNDLE_LIMIT) throw new PreparationError('sentinel.preparation.invalid');
  stillWithin(); store.assertHeld();
  const out = Object.freeze({ digest: canonicalDigest(JSON.parse(bytes.toString('utf8'))) });
  inputsFor.set(out, { store, epoch: store.epoch, workspace: options.workspace, trustDir: options.trustDir,
    registry: options.registry, policy, inputs, current, packs, profile, bytes });
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
  stillWithin(); store.assertHeld();
}

/** Actual availability must match the fixed candidate profile; unavailable assets do not silently downgrade it. */
export function checkPreparationProfile(store: SentinelStore, value: PreparationInputs, available: ReadonlySet<string>, clock: PreparationClock): void {
  checkPreparationClock(store, clock);
  const original = bound(store, value);
  assertPreparationInputs(store, value, () => clock.stillWithin());
  if (!canonicalJsonBytes(publicProfile(original.registry, available, original.packs).record).equals(canonicalJsonBytes(original.profile.record))) {
    throw new PreparationError('sentinel.preparation.unavailable');
  }
  clock.stillWithin();
}

/** Resolve exact identity from a genuine admitted snapshot before any plan-stage or run mutation. */
export async function resolvePreparationRun(store: SentinelStore, value: PreparationInputs, snapshotId: string,
  clock: PreparationClock, givenParent: PreparationParent | null = null): Promise<PreparationRunIdentity> {
  checkPreparationClock(store, clock);
  if (typeof snapshotId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(snapshotId)) return refuse();
  assertPreparationInputs(store, value, () => clock.stillWithin());
  const terms = bound(store, value);
  const { snapshot } = await openSnapshot(store, snapshotId);
  clock.stillWithin();
  if (snapshot.sources.length !== 1 || snapshot.sources[0]!.sourceId !== 'workspace') return refuse();
  const parent = givenParent === null ? null : Object.freeze(structuredClone(givenParent));
  if (parent !== null) await checkParent(store, parent, snapshotId, clock);
  const runId = workspaceRunIdentity(store, { inventory: snapshot.inventoryDigest, lock: terms.current.digest,
    policy: terms.policy.revision, profile: terms.profile.digest, parent: parent?.runId ?? null });
  assertPreparationInputs(store, value, () => clock.stillWithin());
  const out = Object.freeze({ runId, snapshotId });
  runsFor.set(out, { inputs: value, clock, parent });
  return out;
}

/** Record an already admitted bootstrap as planned with the ORIGINAL clock, before Coordinator.open.
 * No coordinator default changes. An existing row is never overwritten or promoted by this helper. */
export async function recordPreparationBootstrap(store: SentinelStore, identity: PreparationRunIdentity): Promise<{ runDeadlineAt: string }> {
  const run = runsFor.get(identity);
  if (!run) return refuse();
  checkPreparationClock(store, run.clock);
  const terms = bound(store, run.inputs);
  assertPreparationInputs(store, run.inputs, () => run.clock.stillWithin());
  if (run.parent) await checkParent(store, run.parent, identity.snapshotId, run.clock);
  const admitted = await loadPlan(store, identity.runId, 1);
  run.clock.stillWithin();
  const expected = planBootstrap({ runId: identity.runId, sourceIds: ['workspace'], profile: terms.profile.planner });
  if (admitted.plan.kind !== 'bootstrap' || admitted.plan.digest !== expected.digest || admitted.selection
    || !canonicalJsonBytes(admitted.profile).equals(canonicalJsonBytes(terms.profile.record))) return refuse();
  const envelope: RunEnvelope = {
    schema: 'sentinel-run/draft-1', id: identity.runId, parentId: run.parent?.runId ?? null, baselineId: null,
    snapshotId: identity.snapshotId, planRevision: 1, coordinatorEpoch: store.epoch,
    ruleLockDigest: terms.current.digest, toolLockDigest: terms.current.digest, policyRevisionDigest: terms.policy.revision,
    requestedScope: { sourceIds: ['workspace'], profile: terms.profile.planner.id },
    budgets: { maxTokens: null, maxCost: null, deadlineMs: Date.parse(run.clock.runDeadlineAt) - Date.parse(run.clock.acceptedAt) },
    createdAt: run.clock.acceptedAt, state: 'planned',
  } as RunEnvelope;
  const recorded = store.ledger.getRun(identity.runId);
  if (recorded) {
    const { state: _oldState, coordinatorEpoch: _oldEpoch, ...old } = recorded.envelope;
    const { state: _state, coordinatorEpoch: _epoch, ...expected } = envelope;
    if (recorded.planRevision !== 1 || !canonicalJsonBytes(old).equals(canonicalJsonBytes(expected))) return refuse();
  } else {
    assertPreparationInputs(store, run.inputs, () => run.clock.stillWithin());
    run.clock.stillWithin();
    store.ledger.createRun(envelope);
  }
  run.clock.stillWithin();
  return Object.freeze({ runDeadlineAt: run.clock.runDeadlineAt });
}

/** Internal trusted controller access; it is never serialized as a service response or treated as admission. */
export function preparationTerms(store: SentinelStore, value: PreparationInputs, stillWithin: () => void) {
  assertPreparationInputs(store, value, stillWithin);
  const t = bound(store, value);
  return Object.freeze({ policy: t.policy, current: t.current, packs: t.packs, profile: t.profile, registry: t.registry,
    workspace: t.workspace, trustDir: t.trustDir });
}

async function checkParent(store: SentinelStore, parent: PreparationParent, snapshotId: string, clock: PreparationClock): Promise<void> {
  if (typeof parent.runId !== 'string' || typeof parent.revision !== 'number' || !Number.isSafeInteger(parent.revision)
    || typeof parent.planDigest !== 'string' || parent.snapshotId !== snapshotId) return refuse();
  const actual = store.ledger.getRun(parent.runId);
  if (!actual || !['completed', 'canceled'].includes(actual.state) || actual.planRevision !== parent.revision
    || actual.envelope.snapshotId !== snapshotId) return refuse();
  const admitted = await loadPlan(store, parent.runId, actual.planRevision);
  clock.stillWithin();
  const after = store.ledger.getRun(parent.runId);
  if (admitted.plan.digest !== parent.planDigest || !after || after.planRevision !== parent.revision
    || !['completed', 'canceled'].includes(after.state) || after.envelope.snapshotId !== snapshotId) return refuse();
}
