// Plan admission through the execution facade (plans.ts): the exact plan with what it pins, refused when any pin
// is not the plan's, and read back verified.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { admitPlan, loadPlan } from '../dist/execution/plans.js';
import { executionProfileRecord } from '../dist/execution/profile.js';
import { createCapabilityTable, planBootstrap } from '../dist/planner/index.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';
import { PARSE, RESOURCES, syntheticPlan, syntheticRegistry } from './coordinator-helpers.ts';
import { lockedRules, policyView } from './planner-helpers.ts';

const roots: string[] = [];
after(() => roots.forEach(removeScratch));
const refused = (re: RegExp) => (e: any) => e?.code === 'sentinel.execution.planInvalid' && re.test(e.detail?.reason ?? '');

test('admission refuses a lock, policy or profile that is not the plan\'s, and a plan that does not match its digest', async () => {
  const s = scratch('plans'); roots.push(s.root);
  const store = await storeIn(s.root);
  try {
    // A real admitted plan to take valid parts from, under another run id for each refusal.
    const p = await syntheticPlan(store, s.root);
    const loaded = await loadPlan(store, p.runId, 1);
    const plan = structuredClone(loaded.plan);
    const { lock } = lockedRules([{ familyId: 'sentinel.test.other', adapterId: 'test-ok' }], []);
    const { policy: other } = policyView(['sentinel.test.other']);
    const { policy: same } = policyView(plan.pins.rules.map((r: any) => r.familyId));
    assert.equal(same.revision, plan.pins.policyDigest, 'the same policy inputs give the same revision');
    const base = { plan, ruleLock: loaded.ruleLock as any, policy: same, profile: loaded.profile };
    await assert.rejects(admitPlan(store, { ...base, ruleLock: lock as any }), refused(/rule lock/));
    await assert.rejects(admitPlan(store, { ...base, policy: other }), refused(/effective policy/));
    await assert.rejects(admitPlan(store, { ...base, policy: { ...same } as any }), refused(/as effectivePolicy returned it/));
    await assert.rejects(admitPlan(store, { ...base, profile: { ...loaded.profile, id: 'profile-other' } }), refused(/another profile/));
    const registry = syntheticRegistry(s.root, ['hang']);
    const narrowed = executionProfileRecord({ id: loaded.profile.id, registry, capabilities: createCapabilityTable(registry, []), permits: [] } as any, loaded.profile.resources, PARSE);
    await assert.rejects(admitPlan(store, { ...base, profile: narrowed }), refused(/at another digest/));
    await assert.rejects(admitPlan(store, { ...base, plan: { ...plan, revision: 2 } }), refused(/digest/));
    await assert.rejects(admitPlan(store, { ...base, ruleLock: null }), refused(/rule lock and effective policy/));
    // The same exact revision cannot be admitted twice; the ledger keeps the first.
    await assert.rejects(admitPlan(store, base), (e: any) => e?.code === 'sentinel.store.conflict');
    assert.equal(store.ledger.listOpenStages(500).length, 0, 'no refused admission left a stage open');
  } finally { store.close(); }
});

test('a bootstrap revision is admitted without lock or policy, and read back as admitted', async () => {
  const s = scratch('plans-boot'); roots.push(s.root);
  const store = await storeIn(s.root);
  try {
    const registry = syntheticRegistry(s.root, ['ok']);
    const profile = { id: 'profile-boot', registry, capabilities: createCapabilityTable(registry, []), permits: [] };
    const record = executionProfileRecord(profile as any, { capture: RESOURCES, parse: RESOURCES, inventory: RESOURCES, check: RESOURCES } as any, PARSE);
    const boot = planBootstrap({ runId: 'run-plans', sourceIds: ['app'], profile: profile as any });
    const { policy } = policyView(['sentinel.test.x']);
    await assert.rejects(admitPlan(store, { plan: boot, ruleLock: null, policy, profile: record }), refused(/bootstrap plan pins no rule lock/));
    const admitted = await admitPlan(store, { plan: boot, ruleLock: null, policy: null, profile: record });
    const back = await loadPlan(store, 'run-plans', 1);
    assert.deepEqual(back.record, admitted);
    assert.deepEqual(back.plan, JSON.parse(JSON.stringify(boot)));
    assert.deepEqual(back.profile, record);
    await assert.rejects(loadPlan(store, 'run-plans', 2), refused(/was not admitted/));
  } finally { store.close(); }
});
