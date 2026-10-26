// Binding a plan to execution validates it once per boundary, not once per unit, and never trusts a plan it did not
// copy itself. A plan the caller holds is validated in full on every call (so a change after an earlier call is still
// refused); a frozen or structural copy is not taken for the boundary's own; held units are bound and checked like any
// other; and what the boundary hands out is unchanged.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  adapterOf,
  canonicalArtifactId,
  capturedInputsOf,
  checksCoveredBy,
  createCapabilityTable,
  planBootstrap,
  influenceManifestOf,
  planBoundaryFor,
  verifyInputSet,
  verifyWorkEnvelope,
  workEnvelopesFor,
} from '../dist/planner/index.js';
import { ownedPlanRevision, plannedChecksOf } from '../dist/planner/boundary.js';
import { deepFreeze } from '../dist/planner/identity.js';
import { executablePlan } from '../dist/execution/plan.js';
import { admitPlan, loadPlan } from '../dist/execution/plans.js';
import { openSnapshot } from '../dist/snapshot/materialize.js';
import { NOT_SELECTED } from '../dist/execution/selection.js';
import { digestOf } from '../dist/store/ledger-json.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';
import { RESOURCES, syntheticPlan } from './coordinator-helpers.ts';

const roots: string[] = [];
after(() => roots.forEach(removeScratch));
const fresh = (label: string) => {
  const s = scratch(label);
  roots.push(s.root);
  return s;
};
const D = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const execution = { resources: { capture: RESOURCES, parse: RESOURCES, inventory: RESOURCES, check: RESOURCES } };
const pinMismatch = (e: any) => e?.code === 'sentinel.plan.pinMismatch';

async function fixture(label: string) {
  const s = fresh(label);
  const store = await storeIn(s.root);
  const p = await syntheticPlan(store, s.root);
  const admitted = await loadPlan(store, p.runId);
  return { s, store, p, admitted };
}

const conversionOf = (run: any) => ({ coordinatorEpoch: run.coordinatorEpoch, createdAt: run.createdAt, execution });

test('a caller plan changed after an earlier call is refused, not served from an earlier validation', async () => {
  const { store, p } = await fixture('binding-mutable');
  try {
    const plan = structuredClone(p.plan);
    const works = workEnvelopesFor(plan, conversionOf(p.run)).map((c) => c.envelope);
    const unit = plan.units[1];
    influenceManifestOf(plan, unit);
    verifyWorkEnvelope(plan, works[1]!);
    checksCoveredBy(plan, unit);
    unit.inputFingerprint = D('changed after an earlier call');
    assert.throws(() => influenceManifestOf(plan, unit), pinMismatch);
    assert.throws(() => verifyWorkEnvelope(plan, works[1]!), pinMismatch);
    assert.throws(() => checksCoveredBy(plan, unit), pinMismatch);
    assert.throws(() => plannedChecksOf(plan, unit), pinMismatch);
    assert.throws(() => workEnvelopesFor(plan, conversionOf(p.run)), pinMismatch);
    assert.throws(
      () =>
        verifyInputSet(
          plan,
          unit,
          unit.inputs.map((i: any) => ({ id: i.content })),
        ),
      pinMismatch,
    );
  } finally {
    store.close();
  }
});

test("a frozen or structural copy is not the boundary's own: an altered unit in it is refused, held units included", async () => {
  const { store, p } = await fixture('binding-forged');
  try {
    const conversion = conversionOf(p.run);
    const owned = ownedPlanRevision(p.plan);
    const works = workEnvelopesFor(owned, conversion).map((c) => c.envelope);
    // A deep-frozen copy whose LAST unit (one a selection would hold) changed without a new digest.
    const forged = structuredClone(owned);
    forged.units.at(-1)!.contract = 'sentinel.stage.check.other';
    deepFreeze(forged);
    assert.ok(Object.isFrozen(forged) && Object.isFrozen(forged.units.at(-1)));
    for (const w of works)
      assert.throws(() => verifyWorkEnvelope(forged, w), pinMismatch, 'freezing is not provenance');
    assert.throws(() => influenceManifestOf(forged, works[0]!), pinMismatch);
    assert.throws(() => workEnvelopesFor(forged, conversion), pinMismatch);
    // The same with its digest recomputed is a different, self-consistent plan: its works are not the owned plan's.
    const { digest: _, ...body } = structuredClone(forged) as any;
    const resealed = { ...body, digest: digestOf(body) };
    assert.throws(() => verifyWorkEnvelope(resealed, works.at(-1)!), pinMismatch);
    // A structurally equal, unfrozen copy of the owned plan is validated in full and gives the same answers.
    const copy = JSON.parse(JSON.stringify(owned));
    for (const w of works) {
      verifyWorkEnvelope(copy, w);
      assert.deepEqual(influenceManifestOf(copy, w), influenceManifestOf(owned, w));
      assert.deepEqual(plannedChecksOf(copy, w), plannedChecksOf(owned, w));
    }
  } finally {
    store.close();
  }
});

test('works of another plan are refused against an owned plan', async () => {
  const a = await fixture('binding-cross-a');
  const s = fresh('binding-cross-b');
  const storeB = await storeIn(s.root);
  try {
    const b = await syntheticPlan(storeB, s.root, {}, { runId: 'run-other' });
    const ownedA = ownedPlanRevision(a.p.plan);
    const worksB = workEnvelopesFor(b.plan, conversionOf(b.run)).map((c) => c.envelope);
    for (const w of worksB) assert.throws(() => verifyWorkEnvelope(ownedA, w));
    const worksA = workEnvelopesFor(ownedA, conversionOf(a.p.run)).map((c) => c.envelope);
    // Same unit ids, another run: the run binding refuses it.
    assert.throws(() => verifyWorkEnvelope(ownedA, { ...worksA[0]!, runId: 'run-other' }), pinMismatch);
    // A unit is found only by the exact id and revision values, never by their spelling.
    assert.throws(
      () => verifyWorkEnvelope(ownedA, { ...worksA[0]!, revision: String(worksA[0]!.revision) } as any),
      /is not a unit of this plan/,
    );
    assert.throws(
      () => checksCoveredBy(ownedA, { id: worksA[0]!.id, revision: String(worksA[0]!.revision) } as any),
      /is not a unit of this plan/,
    );
  } finally {
    a.store.close();
    storeB.close();
  }
});

test('the boundary always takes a fresh copy and hands out the same bytes as a per-call conversion', async () => {
  const { store, p } = await fixture('binding-identity');
  try {
    const conversion = conversionOf(p.run);
    const fromCaller = workEnvelopesFor(structuredClone(p.plan), conversion);
    const owned = ownedPlanRevision(p.plan);
    assert.notEqual(owned, p.plan);
    assert.ok(Object.isFrozen(owned.units[0]));
    const fromOwned = workEnvelopesFor(owned, conversion);
    assert.deepEqual(fromOwned, fromCaller);
    for (const { envelope, manifest } of fromOwned) {
      assert.equal(envelope.influenceManifest, canonicalArtifactId(manifest));
      assert.deepEqual(
        plannedChecksOf(owned, envelope),
        p.plan.checks.filter(
          (c: any) => c.state === 'planned' && c.unit?.id === envelope.id && c.unit.revision === envelope.revision,
        ),
      );
    }
    // Handing the boundary's own plan back in still gives a fresh copy, with equal works.
    const snapshot = { id: p.plan.pins.snapshotId, entries: [] as any[] };
    const request = {
      run: { ...p.run, coordinatorEpoch: 'epoch-x' },
      conversion: { ...conversion, coordinatorEpoch: 'epoch-x' },
      snapshot,
      pathOf: () => '/nowhere',
    };
    const first = planBoundaryFor(p.plan, request);
    const second = planBoundaryFor(first.plan, request);
    assert.notEqual(second.plan, first.plan);
    assert.deepEqual(second.works, first.works);
    assert.deepEqual(second.plan, p.plan);
  } finally {
    store.close();
  }
});

test('executablePlan binds every unit, held ones included, against one validated copy; an altered held unit is refused', async () => {
  const { s, store, p, admitted } = await fixture('binding-executable');
  try {
    const held = p.plan.units.slice(1).map((u: any) => u.id);
    const selection = {
      schema: 'sentinel-rerun-selection/draft-1',
      parent: { runId: 'run-parent', revision: 1, planDigest: D('parent'), snapshotId: p.plan.pins.snapshotId },
      selected: [{ parentUnit: p.plan.units[0].id, unit: p.plan.units[0].id }],
      downstream: [],
      held: held.map((unit: string) => ({ unit, parentUnit: unit })),
      reused: [],
    };
    const run = p.run;
    const bound = await executablePlan(store, { ...admitted, selection } as any, run, 1, p.registry, s.work);
    const byId = (a: any[], b: any[]) => (a[0] < b[0] ? -1 : 1);
    const selectedState = p.plan.units[0].dependencies.length ? 'pending' : 'ready';
    assert.deepEqual(
      bound.works.map((w) => [w.id, w.state, (w as any).reasonCode ?? null]).sort(byId),
      p.plan.units
        .map((u: any, i: number) => [
          u.id,
          i === 0 ? selectedState : 'disabled-by-policy',
          i === 0 ? null : NOT_SELECTED,
        ])
        .sort(byId),
    );
    for (const u of p.plan.units) {
      const x = bound.unitOf(u);
      assert.equal(x.manifest.unit.id, u.id);
      assert.deepEqual(
        x.checks,
        p.plan.checks.filter((c: any) => c.state === 'planned' && c.unit?.id === u.id),
      );
      assert.equal(x.work.state, held.includes(u.id) ? 'disabled-by-policy' : selectedState);
      assert.deepEqual(x.unit, u);
      assert.equal(
        x.unit,
        bound.admitted.plan.units.find((v) => v.id === u.id && v.revision === u.revision),
        'the returned plan is the exact copy each unit was bound to',
      );
    }
    assert.deepEqual(bound.admitted.plan, p.plan);
    // A held unit altered in the admitted plan (no new digest) is refused before anything is bound.
    const altered = structuredClone(admitted);
    altered.plan.units.find((u: any) => u.id === held[0])!.inputFingerprint = D('altered held unit');
    await assert.rejects(
      executablePlan(store, { ...altered, selection } as any, run, 1, p.registry, s.work),
      pinMismatch,
    );
  } finally {
    store.close();
  }
});

// Lookup keys must preserve strict primitive reference identity. JSON serialization can unbox wrappers or invoke
// toJSON/valueOf/toString; none of those conversions may resolve a caller object to an admitted unit.
for (const kind of ['boxed-id', 'boxed-revision', 'json-id', 'json-revision'] as const) {
  test(`public and boundary lookups refuse ${kind} without invoking conversion hooks`, async () => {
    const { s, store, p } = await fixture('binding-reference-' + kind);
    try {
      const conversion = conversionOf(p.run);
      const work = workEnvelopesFor(p.plan, conversion)[0]!.envelope;
      const snapshot = (await openSnapshot(store, p.run.snapshotId)).snapshot;
      const epoch = 'epoch-reference-test';
      const boundary = planBoundaryFor(p.plan, {
        run: { ...p.run, coordinatorEpoch: epoch },
        conversion: { ...conversion, coordinatorEpoch: epoch },
        snapshot,
        pathOf: (i) => s.root + '/bound-source/' + i.relativePath,
      });
      const plans = { caller: p.plan, owned: ownedPlanRevision(p.plan), frozen: deepFreeze(structuredClone(p.plan)) };
      const results: Array<{ api: string; code: string | null; conversions: number }> = [];
      const check = (api: string, invoke: (ref: any) => unknown) => {
        let conversions = 0;
        const id =
          kind === 'boxed-id'
            ? Object.assign(new String(work.id), {
                toString() {
                  conversions++;
                  return work.id;
                },
              })
            : kind === 'json-id'
              ? {
                  toJSON() {
                    conversions++;
                    return work.id;
                  },
                  toString() {
                    conversions++;
                    return work.id;
                  },
                }
              : work.id;
        const revision =
          kind === 'boxed-revision'
            ? Object.assign(new Number(work.revision), {
                valueOf() {
                  conversions++;
                  return work.revision;
                },
              })
            : kind === 'json-revision'
              ? {
                  toJSON() {
                    conversions++;
                    return work.revision;
                  },
                  toString() {
                    conversions++;
                    return String(work.revision);
                  },
                }
              : work.revision;
        const ref = Object.freeze({ ...work, id, revision });
        let code: string | null = null;
        try {
          invoke(ref);
        } catch (e) {
          code = (e as any).code ?? (e as Error).name;
        }
        results.push({ api, code, conversions });
      };
      for (const [label, plan] of Object.entries(plans)) {
        check(label + '.checksCoveredBy', (r) => checksCoveredBy(plan, r));
        check(label + '.plannedChecksOf', (r) => plannedChecksOf(plan, r));
        check(label + '.adapterOf', (r) => adapterOf(plan, r));
        check(label + '.influenceManifestOf', (r) => influenceManifestOf(plan, r));
        check(label + '.capturedInputsOf', (r) => capturedInputsOf(plan, r, snapshot));
        check(label + '.verifyWorkEnvelope', (r) => verifyWorkEnvelope(plan, r));
        check(label + '.verifyInputSet', (r) =>
          verifyInputSet(
            plan,
            r,
            p.plan.units.find((u) => u.id === work.id)!.inputs.map((i) => ({ id: i.content })),
          ),
        );
      }
      check('boundary.checksFor', (r) => boundary.checksFor(r));
      check('boundary.adapterFor', (r) => boundary.adapterFor(r));
      check('boundary.inputsFor', (r) => boundary.inputsFor(r));
      assert.deepEqual(
        results,
        results.map((r) => ({ ...r, code: 'sentinel.plan.invalidInput', conversions: 0 })),
      );
    } finally {
      store.close();
    }
  });
}

test('genuine primitive references retain every public and boundary lookup answer', async () => {
  const { s, store, p } = await fixture('binding-primitive-reference');
  try {
    const snapshot = (await openSnapshot(store, p.run.snapshotId)).snapshot;
    const conversion = conversionOf(p.run),
      epoch = 'epoch-primitive-test';
    const boundary = planBoundaryFor(p.plan, {
      run: { ...p.run, coordinatorEpoch: epoch },
      conversion: { ...conversion, coordinatorEpoch: epoch },
      snapshot,
      pathOf: (i) => s.root + '/bound-source/' + i.relativePath,
    });
    for (const w of boundary.works) {
      const ref = { id: w.id, revision: w.revision };
      const expected = p.plan.units.find((u) => u.id === ref.id && u.revision === ref.revision)!;
      assert.deepEqual(boundary.checksFor(w), expected.checks);
      assert.equal(boundary.adapterFor(w), expected.adapterId);
      assert.deepEqual(
        boundary.inputsFor(w),
        expected.inputs.map((i) => ({ id: i.content, path: s.root + '/bound-source/' + i.relativePath })),
      );
      verifyWorkEnvelope(boundary.plan, w);
      assert.deepEqual(checksCoveredBy(boundary.plan, ref), expected.checks);
      assert.deepEqual(
        plannedChecksOf(boundary.plan, ref),
        p.plan.checks.filter((c) => c.state === 'planned' && c.unit?.id === ref.id && c.unit.revision === ref.revision),
      );
      assert.equal(adapterOf(boundary.plan, ref), expected.adapterId);
      assert.equal(canonicalArtifactId(influenceManifestOf(boundary.plan, ref)), w.influenceManifest);
      const inputs = capturedInputsOf(boundary.plan, ref, snapshot);
      verifyInputSet(boundary.plan, ref, inputs);
    }
  } finally {
    store.close();
  }
});

test('executablePlan returns the minted plan without re-reading an accessor on the caller admission', async () => {
  const { s, store, p, admitted } = await fixture('binding-admitted-accessor');
  try {
    const changed = structuredClone(admitted.plan);
    changed.units[0]!.inputFingerprint = D('not the plan that was bound');
    let reads = 0;
    const request = {
      ...admitted,
      get plan() {
        return ++reads === 1 ? admitted.plan : changed;
      },
    };
    const bound = await executablePlan(store, request, p.run, 1, p.registry, s.work);
    assert.equal(reads, 1, 'binding must not take a later caller value for the returned plan');
    assert.notEqual(bound.admitted.plan, admitted.plan);
    assert.deepEqual(bound.admitted, admitted);
    assert.ok(Object.isFrozen(bound.admitted.plan.units[0]));
    for (const u of bound.admitted.plan.units) assert.equal(bound.unitOf(u).unit, u);
  } finally {
    store.close();
  }
});

test('executablePlan refuses an analysis copy routed through the bootstrap branch by a kind accessor', async () => {
  const { s, store, p, admitted } = await fixture('binding-kind-accessor');
  try {
    let reads = 0;
    const plan = {
      ...admitted.plan,
      get kind() {
        return ++reads === 1 ? ('bootstrap' as const) : ('analysis' as const);
      },
    };
    await assert.rejects(
      executablePlan(store, { ...admitted, plan }, p.run, 1, p.registry, s.work),
      (e: any) =>
        e?.code === 'sentinel.execution.planInvalid' &&
        e.detail?.reason === 'the bootstrap boundary requires a bootstrap plan',
    );
    assert.equal(store.ledger.listOpenStages(500).length, 0, 'refusal creates no staging');
    assert.ok(reads > 1, 'the branch and minted copy saw different kinds');
  } finally {
    store.close();
  }
});

test('a genuinely admitted bootstrap is bound to its exact minted plan and stays held without operations', async () => {
  const { s, store, p, admitted } = await fixture('binding-bootstrap');
  try {
    const runId = 'run-bootstrap-binding';
    const profile = {
      id: admitted.profile.id,
      registry: p.registry,
      capabilities: createCapabilityTable(p.registry, []),
      permits: [],
    };
    const boot = planBootstrap({ runId, sourceIds: p.run.requestedScope.sourceIds, profile: profile as any });
    await admitPlan(store, { plan: boot, ruleLock: null, policy: null, profile: admitted.profile });
    const back = await loadPlan(store, runId, 1);
    const bound = await executablePlan(store, back, { ...p.run, id: runId }, 1, p.registry, s.work);
    assert.equal(bound.admitted.plan.kind, 'bootstrap');
    assert.deepEqual(bound.admitted.plan, boot);
    assert.notEqual(bound.admitted.plan, back.plan);
    assert.equal(bound.restored, null);
    assert.equal(bound.works.length, boot.units.length);
    for (const u of bound.admitted.plan.units) {
      assert.equal(bound.unitOf(u).unit, u);
      assert.equal(bound.unitOf(u).work.state, 'blocked');
      assert.equal(bound.unitOf(u).adapter, null);
      assert.deepEqual(bound.unitOf(u).inputs, []);
    }
  } finally {
    store.close();
  }
});
