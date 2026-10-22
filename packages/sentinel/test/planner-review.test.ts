// Regressions for review findings on the plan revision: undiscovered surfaces stay required gaps, only frozen adapter
// derivations carry trusted identity, the validator re-derives the pin and identity graph, and every binding handed
// out is deep-frozen. Synthetic inputs through the real adapters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { digestOf } from '../dist/store/ledger-json.js';
import { validateEnvelope } from '../dist/validate.js';
import { PlanError, evaluateRequiredCoverage, planAnalysis, planBootstrap, workEnvelopesFor } from '../dist/planner/index.js';
import { analysisView, included, lockedRules, policyView, snapshotView, trustedProfile } from './planner-helpers.ts';

const d = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const code = (c: string) => (e: unknown) => e instanceof PlanError && e.code === c;
const profile = trustedProfile();
const boot = planBootstrap({ runId: 'run-1', sourceIds: ['web'], profile });
const inventory = [{ id: boot.units.at(-1)!.id, revision: 1 }];
const L = { deadlineMs: 1000, memoryBytes: 1 << 26, cpuQuota: 1, maxPids: 8, maxOutputBytes: 1 << 16 };
const conversion = { coordinatorEpoch: 'epoch-1', createdAt: '2026-10-22T12:00:00Z', execution: { resources: { capture: L, parse: L, inventory: L, check: L } } };

function plan(over: Record<string, unknown> = {}) {
  return planAnalysis({ runId: 'run-1', revision: 2, previous: boot, bootstrap: inventory, profile,
    snapshot: snapshotView(['web'], [included('web', 'src/a.ts'), included('web', 'src/b.ts')]).view,
    analyses: [analysisView('web', [{ path: 'src/a.ts', class: 'parsed' }, { path: 'src/b.ts', class: 'parsed' }])],
    lock: lockedRules([{ familyId: 'sentinel.ts.eval' }]).view, policy: policyView(['sentinel.ts.eval']).view, ...over });
}
/** A revision edited and resealed with a correct digest, as a forger would. */
const reseal = (p: object, edit: (v: any) => void) => {
  const v: any = structuredClone(p); delete v.digest; edit(v); return { ...v, digest: digestOf(v) };
};

test('surfaces nobody could discover stay required gaps: a parse-failed file and an unlisted folder', () => {
  const p = planAnalysis({ runId: 'run-1', revision: 2, previous: boot, bootstrap: inventory, profile,
    snapshot: snapshotView(['web'], [included('web', 'src/broken.ts'),
      { sourceId: 'web', relativePath: 'locked', kind: 'directory-boundary', disposition: 'unreadable', reasonCode: 'sentinel.capture.unreadable', knownDescendants: null }]).view,
    analyses: [analysisView('web', [{ path: 'src/broken.ts', class: 'parse-failed' }], [])],
    lock: lockedRules([{ familyId: 'sentinel.http.route-guard', languages: ['typescript'], scopeKind: 'surface', requires: ['source-span'] }]).view,
    policy: policyView(['sentinel.http.route-guard']).view });
  assert.deepEqual(p.checks.map(c => [c.scopeId, c.state, c.reasonCode, c.required]).sort(), [
    ['web:locked/', 'scope-unknown', 'sentinel.plan.unknownDescendants', true],
    ['web:src/broken.ts', 'scope-unknown', 'sentinel.plan.surfacesUndiscovered', true],
  ]);
  assert.equal(p.requiredCoverageAchievable, false);
  assert.equal(evaluateRequiredCoverage(p, []).complete, false);
});

test('only the adapters’ frozen derivations carry a trusted policy, lock, snapshot or analysis identity', () => {
  const { view: policy } = policyView(['sentinel.ts.eval']);
  assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.rules));
  assert.throws(() => { (policy.rules as unknown[]).length = 0; }, TypeError, 'the derivation cannot be emptied');
  const copy = { ...policy, rules: [] };
  assert.throws(() => plan({ policy: copy }), code('sentinel.plan.pinMismatch'), 'a copy keeping the trusted revision is refused');
  const lock = lockedRules([{ familyId: 'sentinel.ts.eval' }]).view;
  assert.throws(() => plan({ lock: { ...lock } }), code('sentinel.plan.pinMismatch'));
  assert.throws(() => plan({ snapshot: { ...snapshotView(['web'], [included('web', 'src/a.ts')]).view } }), code('sentinel.plan.pinMismatch'));
  assert.throws(() => plan({ analyses: [{ ...analysisView('web', []) }] }), code('sentinel.plan.pinMismatch'));
  assert.equal(plan().checks.length, 2, 'the real derivations plan');
});

test('the validator re-derives the pin and identity graph, whatever digest a forger reseals with', () => {
  const p = plan();
  assert.ok(validateEnvelope('plan', p).ok);
  const refused = (v: unknown, path: string) => {
    const r = validateEnvelope('plan', v);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some(e => e.path === path), `${path}: ${JSON.stringify(r.errors.slice(0, 3))}`);
  };
  refused(reseal(p, v => { v.pins.rules = []; }), '/checks/0/familyId');
  refused(reseal(p, v => { v.checks[0].ruleRevision = 7; }), '/checks/0/familyId');
  refused(reseal(p, v => { v.pins.rules[0].revision = 7; v.checks.forEach((c: any) => { c.ruleRevision = 7; }); }), '/checks/0/id');
  refused(reseal(p, v => { v.pins.rules[0].adapterId = 'osv'; }), '/units/0/adapterId');
  refused(reseal(p, v => { v.units[0].id = 'work-check-forged'; v.checks.forEach((c: any) => { c.unit.id = 'work-check-forged'; }); }), '/units/0/id');
  refused(reseal(p, v => { v.pins.analyses = []; }), '/pins/analyses');
  refused(reseal(p, v => { v.units[0].inputs.pop(); }), '/units/0/inputSetDigest');
  refused(reseal(boot, v => { v.units = []; v.tallies.units = 0; }), '/units');
  refused(reseal(boot, v => { v.units = v.units.filter((u: any) => u.stage !== 'parse'); v.tallies.units = v.units.length; }), '/units');
});

test('every binding handed out is a deep-frozen copy', () => {
  const p = plan();
  const [converted] = workEnvelopesFor(p, conversion);
  for (const mutate of [
    () => { (converted!.manifest.inputs as unknown[]).push({}); },
    () => { (converted!.manifest.inputs[0] as any).content = d('other'); },
    () => { (converted!.manifest.pins as any).ruleLockDigest = d('other'); },
    () => { (converted!.envelope.dependencies as unknown[]).length = 0; },
    () => { (converted!.envelope.resources as any).maxPids = 128; },
  ]) assert.throws(mutate, TypeError);
  const coverage = evaluateRequiredCoverage(p, []);
  assert.throws(() => { (coverage.checks[0] as any).complete = true; }, TypeError);
});

test('an index that stopped at its bound or placed locations outside the capture leaves surface gaps', () => {
  const surfaceRule = lockedRules([{ familyId: 'sentinel.http.route-guard', languages: ['typescript'], scopeKind: 'surface', requires: ['source-span'] }]).view;
  const planWith = (frontiers: { omitted?: number; unplaced?: number }) => planAnalysis({ runId: 'run-1', revision: 2, previous: boot, bootstrap: inventory, profile,
    snapshot: snapshotView(['web'], [included('web', 'src/a.ts')]).view,
    analyses: [analysisView('web', [{ path: 'src/a.ts', class: 'parsed' }], [], 'fp-web', 'snap-1', frontiers)],
    lock: surfaceRule, policy: policyView(['sentinel.http.route-guard']).view });
  assert.deepEqual(planWith({}).checks, [], 'a complete index of a parsed file with no surface has none to check');
  const omitted = planWith({ omitted: 1 });
  assert.deepEqual(omitted.checks.map(c => [c.scopeId, c.state, c.reasonCode, c.required]), [['web:#index-omitted', 'scope-unknown', 'sentinel.plan.surfacesOmitted', true]]);
  assert.equal(omitted.requiredCoverageAchievable, false);
  assert.deepEqual(planWith({ unplaced: 2 }).checks.map(c => c.reasonCode), ['sentinel.plan.surfacesUnplaced']);
});
