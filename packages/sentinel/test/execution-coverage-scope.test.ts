// A child file's skip or unresolved frontier, or a limitation on a scope the result names that bears on none of the
// unit's checks, is never dropped: it keeps the canonical record partial and required coverage incomplete, checked
// through PR 06's own evaluator over a real planned revision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { analysisView, lockedRules, policyView, snapshotView, trustedProfile } from './planner-helpers.ts';
import { evaluateRequiredCoverage, planAnalysis, planBootstrap } from '../dist/planner/index.js';
import { bearsOn, coverageRecords } from '../dist/execution/coverage.js';

const d = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const profile = trustedProfile();
const file = (p: string) => ({ sourceId: 'web', relativePath: p, kind: 'file' as const, disposition: 'included' as const, content: d(p), bytes: 1, generated: false });
const boot = planBootstrap({ runId: 'run-1', sourceIds: ['web'], profile });
const plan = (rules: any[]) => planAnalysis({ runId: 'run-1', revision: 2, previous: boot, bootstrap: [{ id: boot.units.at(-1)!.id, revision: 1 }], profile,
  snapshot: snapshotView(['web'], [file('src/a.ts'), file('src/b.ts')]).view, analyses: [analysisView('web', [])],
  lock: lockedRules(rules as never).view, policy: policyView(rules.map(r => r.familyId)).view });

const result = (checks: string[], scanned: string[], over: Record<string, unknown> = {}) => ({
  protocol: 'sentinel-worker/draft-1', type: 'result', attemptId: 'att-1', work: { id: 'w', revision: 1 }, coordinatorEpoch: 'e', seq: 1,
  inputFingerprint: d('in'), granularity: 'aggregate', artifacts: [], observations: [], coveredChecks: checks.map(checkId => ({ checkId, coverage: d('c') })),
  scannedSet: scanned, skipped: [], actualReadSet: [], unresolvedFrontiers: [], diagnostics: [], ...over }) as any;

function evaluate(p: any, unitChecks: any[], res: any, granularity: 'aggregate' | 'per-file-per-rule') {
  const unit = p.units.find((u: any) => u.id === unitChecks[0].unit.id);
  const { envelopes } = coverageRecords({ runId: p.runId, attemptId: 'att-1', work: { id: unit.id, revision: unit.revision }, checks: unitChecks,
    adapterGranularity: granularity, result: res, recordedAt: '2026-10-22T12:00:00Z' });
  return { envelopes, coverage: evaluateRequiredCoverage(p, envelopes) };
}

test('a whole-repository check: a skipped child file, or an unresolved child frontier, keeps it incomplete', () => {
  const p = plan([{ familyId: 'sentinel.repo.policy', languages: ['typescript'], scopeKind: 'repository' }]);
  const repo = p.checks.filter((c: any) => c.state === 'planned' && c.scopeKind === 'repository' && c.scopeId === 'web');
  assert.equal(repo.length, 1, JSON.stringify(p.checks.map((c: any) => [c.scopeId, c.state])));
  const ids = repo.map((c: any) => c.id);
  // The review's case: aggregate coverage of `web`, with one of its files skipped.
  const skipped = evaluate(p, repo, result(ids, ['web'], { skipped: [{ scopeId: 'web:src/a.ts', reasonCode: 'sentinel.coverage.unsupported' }] }), 'aggregate');
  assert.equal(skipped.envelopes[0]!.status, 'partial');
  assert.deepEqual(skipped.envelopes[0]!.skipped, [{ scopeId: 'web:src/a.ts', reasonCode: 'sentinel.coverage.unsupported' }], 'the child skip is kept');
  assert.equal(skipped.coverage.complete, false);
  // The same with an unresolved frontier in a child folder.
  const frontier = evaluate(p, repo, result(ids, ['web'], { unresolvedFrontiers: [{ scopeId: 'web:src/', reasonCode: 'sentinel.capture.unlisted' }] }), 'aggregate');
  assert.equal(frontier.envelopes[0]!.status, 'partial');
  assert.equal(frontier.coverage.complete, false);
  // Without either, the aggregate record completes the whole-repository check.
  assert.equal(evaluate(p, repo, result(ids, ['web']), 'aggregate').coverage.complete, true);
});

test('a limitation on a scope that bears on none of the unit\'s checks is kept on every check of the unit', () => {
  const p = plan([{ familyId: 'sentinel.ts.eval', languages: ['typescript'] }]);
  const files = p.checks.filter((c: any) => c.state === 'planned');
  const byUnit = files.filter((c: any) => c.unit.id === files[0]!.unit.id);
  const ids = byUnit.map((c: any) => c.id);
  const scopes = byUnit.map((c: any) => c.scopeId);
  const stray = evaluate(p, byUnit, result(ids, scopes, { granularity: 'per-file-per-rule', skipped: [{ scopeId: 'other:thing', reasonCode: 'sentinel.coverage.unsupported' }] }), 'per-file-per-rule');
  assert.ok(stray.envelopes.every(e => e.status === 'partial' && e.skipped.some(s => s.scopeId === 'other:thing')), 'never silently dropped');
  assert.equal(stray.coverage.complete, false);
  // A skip on one file bears on that file's check only.
  if (byUnit.length > 1) {
    const one = evaluate(p, byUnit, result(ids, scopes, { granularity: 'per-file-per-rule', skipped: [{ scopeId: scopes[0], reasonCode: 'sentinel.coverage.unsupported' }] }), 'per-file-per-rule');
    assert.deepEqual(one.envelopes.map(e => e.status), byUnit.map((_: any, i: number) => (i === 0 ? 'partial' : 'complete')));
  }
});

test('scope bindings follow the canonical ids', () => {
  const repo = { scopeId: 'web', scopeKind: 'repository', sourceId: 'web' } as const;
  const fileCheck = { scopeId: 'web:src/a.ts', scopeKind: 'source-file', sourceId: 'web' } as const;
  assert.equal(bearsOn('web:src/a.ts', repo), true);
  assert.equal(bearsOn('web:src/', repo), true);
  assert.equal(bearsOn('webapp:src/a.ts', repo), false, 'another source sharing a prefix');
  assert.equal(bearsOn('web:src/', fileCheck), true, 'a folder holding the file');
  assert.equal(bearsOn('web:src/b.ts', fileCheck), false);
});
