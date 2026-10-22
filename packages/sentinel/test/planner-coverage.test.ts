// Required coverage from coverage records only: work finishing never completes a check, imported or unrelated
// reuse never counts, and anything the plan could not plan stays incomplete. Synthetic plan, real contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { analysisView, lockedRules, policyView, snapshotView, trustedProfile } from './planner-helpers.ts';
import { evaluateRequiredCoverage, planAnalysis, planBootstrap, verifyWorkEnvelope, workEnvelopesFor, PlanError } from '../dist/planner/index.js';

const d = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const profile = trustedProfile({ permitExtra: ['framework-order'] });
const rule = (familyId: string, over: Record<string, unknown> = {}) => ({ familyId, languages: ['typescript'], ...over });
const file = (p: string) => ({ sourceId: 'web', relativePath: p, kind: 'file' as const, disposition: 'included' as const, content: d(p), bytes: 1, generated: false });
const boot = planBootstrap({ runId: 'run-1', sourceIds: ['web'], profile });
const inventory = { id: boot.units.at(-1)!.id, revision: 1 };

function plan(rules: ReturnType<typeof rule>[], mandatory: string[], gaps: string[] = []) {
  return planAnalysis({ runId: 'run-1', revision: 2, previous: boot, bootstrap: [inventory], profile,
    snapshot: snapshotView(['web'], [file('src/a.ts'), file('src/b.ts')]).view,
    analyses: [analysisView('web', [])],
    lock: lockedRules(rules as never).view,
    policy: policyView([...mandatory, ...gaps]).view });
}

let n = 0;
const record = (p: ReturnType<typeof plan>, checkId: string, over: Record<string, unknown> = {}) => {
  const c = p.checks.find(x => x.id === checkId)!;
  return { schema: 'sentinel-coverage/draft-1', id: `cov-${++n}`, runId: p.runId, checkId, workId: c.unit?.id ?? 'work-x', workRevision: c.unit?.revision ?? 1,
    status: 'complete', granularity: 'per-file-per-rule', assessedScopeArtifact: d('scope'), limitationsArtifact: d('lim'),
    basis: { kind: 'executed', attemptId: 'att-1' }, skipped: [], recordedAt: '2026-10-22T12:00:00Z', ...over } as never;
};

test('required coverage completes only from complete coverage records for exactly the planned work', () => {
  const p = plan([rule('sentinel.ts.eval')], ['sentinel.ts.eval']);
  const ids = p.checks.map(c => c.id);
  assert.equal(evaluateRequiredCoverage(p, []).complete, false, 'finished work without records completes nothing');
  assert.deepEqual(evaluateRequiredCoverage(p, []).checks.map(c => c.reasonCode), ['sentinel.plan.coverageMissing', 'sentinel.plan.coverageMissing']);
  const done = evaluateRequiredCoverage(p, ids.map(id => record(p, id)));
  assert.deepEqual([done.complete, done.required, done.requiredComplete], [true, 2, 2]);
  const partial = evaluateRequiredCoverage(p, [record(p, ids[0]!), record(p, ids[1]!, { status: 'partial', skipped: [{ scopeId: 'web:src/b.ts', reasonCode: 'sentinel.capture.tooLarge' }] })]);
  assert.equal(partial.complete, false);
  assert.equal(partial.checks[1]!.reasonCode, 'sentinel.plan.coverageNotComplete');
});

test('imported, wrongly assigned, unrelated or conflicting evidence never counts', () => {
  const p = plan([rule('sentinel.ts.eval')], ['sentinel.ts.eval']);
  const [a, b] = p.checks.map(c => c.id) as [string, string];
  const reasons = (records: never[]) => evaluateRequiredCoverage(p, records).checks.map(c => c.reasonCode ?? 'complete');
  assert.deepEqual(reasons([record(p, a, { basis: { kind: 'imported', provenanceArtifact: d('report') } }), record(p, b)]), ['sentinel.plan.coverageImported', 'complete']);
  assert.deepEqual(reasons([record(p, a, { workId: 'work-other' }), record(p, b)]), ['sentinel.plan.coverageWrongUnit', 'complete']);
  assert.deepEqual(reasons([record(p, a, { basis: { kind: 'reused', publication: { id: 'work-unrelated', revision: 1 }, derivationArtifact: d('x') } }), record(p, b)]),
    ['sentinel.plan.coverageReuseUnproven', 'complete'], 'reuse of work the plan does not name');
  assert.deepEqual(reasons([record(p, a, { basis: { kind: 'reused', publication: inventory, derivationArtifact: d('x') } }), record(p, b)]),
    ['sentinel.plan.coverageReuseUnproven', 'complete'], 'not even reuse of work the plan names: no check-specific derivation is recorded yet');
  assert.deepEqual(reasons([record(p, a), record(p, a, { status: 'error' }), record(p, b)]), ['sentinel.plan.coverageConflict', 'complete']);
  const other = evaluateRequiredCoverage(p, [record(p, a, { runId: 'run-9' }), record(p, b)]);
  assert.equal(other.checks[0]!.reasonCode, 'sentinel.plan.coverageMissing', 'another run’s records are ignored');
  const unknown = evaluateRequiredCoverage(p, [record(p, a), record(p, b), { ...record(p, a), id: 'cov-ghost', checkId: 'chk-ghost' } as never]);
  assert.deepEqual([unknown.complete, unknown.unknownRecords], [true, ['cov-ghost']]);
});

test('a required check the plan could not plan, or a required rule gap, keeps coverage incomplete', () => {
  const p = plan([rule('sentinel.ts.eval'), rule('sentinel.ts.order', { requires: ['framework-order'] })], ['sentinel.ts.eval', 'sentinel.ts.order'], ['sentinel.ts.not-locked']);
  const records = p.checks.filter(c => c.state === 'planned').map(c => record(p, c.id));
  const result = evaluateRequiredCoverage(p, records);
  assert.equal(result.complete, false);
  assert.ok(result.checks.filter(c => c.planState === 'unsupported').every(c => !c.complete && c.reasonCode === 'sentinel.plan.capabilityUnavailable'));
  assert.deepEqual(result.ruleGaps.map(g => g.familyId), ['sentinel.ts.not-locked']);
  assert.throws(() => evaluateRequiredCoverage({ ...p, revision: 7 } as never, records), (e: unknown) => e instanceof PlanError);
});

test('a work envelope that differs from its plan unit in any declared input is refused', () => {
  const p = plan([rule('sentinel.ts.eval')], ['sentinel.ts.eval']);
  const L = { deadlineMs: 1000, memoryBytes: 1 << 26, cpuQuota: 1, maxPids: 8, maxOutputBytes: 1 << 16 };
  const [{ envelope }] = workEnvelopesFor(p, { coordinatorEpoch: 'epoch-1', createdAt: '2026-10-22T12:00:00Z', execution: { resources: { capture: L, parse: L, inventory: L, check: L } } });
  assert.doesNotThrow(() => verifyWorkEnvelope(p, envelope));
  for (const over of [{ inputFingerprint: d('other') }, { influenceManifest: d('other') }, { dependencies: [] }, { runId: 'run-9' }, { planRevision: 3 }]) {
    assert.throws(() => verifyWorkEnvelope(p, { ...envelope, ...over } as never), (e: unknown) => e instanceof PlanError, JSON.stringify(over));
  }
  assert.deepEqual(p.units[0]!.inputs.map(i => i.content), [d('src/a.ts'), d('src/b.ts')], 'inputs pin the captured bytes');
});

test('a coarser record never completes a finer check; only a whole-repository check takes an aggregate record', () => {
  const p = plan([rule('sentinel.ts.eval'), rule('sentinel.repo.policy', { scopeKind: 'repository' })], ['sentinel.ts.eval', 'sentinel.repo.policy']);
  const byScope = (id: string) => p.checks.find(c => c.id === id)!;
  const records = p.checks.filter(c => c.state === 'planned').map(c => record(p, c.id, { granularity: 'aggregate' }));
  const result = evaluateRequiredCoverage(p, records);
  for (const c of result.checks.filter(x => x.planState === 'planned')) {
    const kind = byScope(c.checkId).scopeKind;
    assert.equal(c.complete, kind === 'repository', `${kind}: ${c.reasonCode ?? 'complete'}`);
    if (kind !== 'repository') assert.equal(c.reasonCode, 'sentinel.plan.coverageTooCoarse');
  }
  assert.equal(evaluateRequiredCoverage(p, p.checks.filter(c => c.state === 'planned').map(c => record(p, c.id, { granularity: 'per-file' })))
    .checks.filter(c => byScope(c.checkId).scopeKind === 'source-file').every(c => c.reasonCode === 'sentinel.plan.coverageTooCoarse'), true, 'per file is not per rule');
  // SOL's probe: aggregate reuse of the bootstrap inventory for every check completes nothing.
  const reuse = p.checks.filter(c => c.state === 'planned').map(c => record(p, c.id, { granularity: 'aggregate', basis: { kind: 'reused', publication: inventory, derivationArtifact: d('inventory') } }));
  const probe = evaluateRequiredCoverage(p, reuse);
  assert.deepEqual([probe.complete, probe.requiredComplete], [false, 0]);
});
