// A child file's skip or unresolved frontier, or a limitation on a scope the result names that bears on none of the
// unit's checks, is never dropped: it keeps the canonical record partial and required coverage incomplete, checked
// through PR 06's own evaluator over a real planned revision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { analysisView, lockedRules, policyView, snapshotView, trustedProfile } from './planner-helpers.ts';
import { evaluateRequiredCoverage, planAnalysis, planBootstrap } from '../dist/planner/index.js';
import { bearsOn, coverageRecords, scopeIndex } from '../dist/execution/coverage.js';

const d = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const profile = trustedProfile();
const file = (p: string) => ({ sourceId: 'web', relativePath: p, kind: 'file' as const, disposition: 'included' as const, content: d(p), bytes: 1, generated: false });
const boot = planBootstrap({ runId: 'run-1', sourceIds: ['web'], profile });
const plan = (rules: any[], options: { surfaces?: any[]; requested?: string[] } = {}) => planAnalysis({ runId: 'run-1', revision: 2, previous: boot, bootstrap: [{ id: boot.units.at(-1)!.id, revision: 1 }], profile,
  snapshot: snapshotView(['web'], [file('src/a.ts'), file('src/b.ts')]).view,
  analyses: [analysisView('web', [{ path: 'src/a.ts', class: 'parsed', content: d('src/a.ts') }, { path: 'src/b.ts', class: 'parsed', content: d('src/b.ts') }], options.surfaces ?? [])],
  lock: lockedRules(rules as never).view,
  policy: policyView(rules.map(r => r.familyId).filter(f => !options.requested?.includes(f)), { requested: options.requested ?? [] }).view });

const result = (checks: string[], scanned: string[], over: Record<string, unknown> = {}) => ({
  protocol: 'sentinel-worker/draft-1', type: 'result', attemptId: 'att-1', work: { id: 'w', revision: 1 }, coordinatorEpoch: 'e', seq: 1,
  inputFingerprint: d('in'), granularity: 'aggregate', artifacts: [], observations: [], coveredChecks: checks.map(checkId => ({ checkId, coverage: d('c') })),
  scannedSet: scanned, skipped: [], actualReadSet: [], unresolvedFrontiers: [], diagnostics: [], ...over }) as any;

function evaluate(p: any, unitChecks: any[], res: any, granularity: 'aggregate' | 'per-file-per-rule') {
  const unit = p.units.find((u: any) => u.id === unitChecks[0].unit.id);
  const { envelopes } = coverageRecords({ runId: p.runId, attemptId: 'att-1', work: { id: unit.id, revision: unit.revision }, checks: unitChecks,
    adapterGranularity: granularity, result: res, recordedAt: '2026-10-22T12:00:00Z', scopes: scopeIndex(p) });
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

test('mixed scopes in one unit: a skipped file keeps a required surface check incomplete, since nothing records the surface\'s file', () => {
  // The review's case: an optional file rule and a mandatory surface rule, grouped in one unit over the same source.
  const p = plan([{ familyId: 'sentinel.ts.optional', languages: ['typescript'] }, { familyId: 'sentinel.http.surface', languages: ['typescript'], scopeKind: 'surface' }],
    { surfaces: [{ nodeId: 'web::src/a.ts::route', path: 'src/a.ts', kind: 'route' }], requested: ['sentinel.ts.optional'] });
  const surface = p.checks.find((c: any) => c.scopeKind === 'surface' && c.scopeId === 'web::src/a.ts::route' && c.state === 'planned');
  assert.ok(surface && surface.required, JSON.stringify(p.checks.map((c: any) => [c.scopeId, c.scopeKind, c.state, c.required])));
  const unit = p.checks.filter((c: any) => c.state === 'planned' && c.unit.id === surface.unit.id);
  assert.ok(unit.some((c: any) => c.scopeId === 'web:src/a.ts'), 'the file check is in the same unit');
  const res = result(unit.map((c: any) => c.id), unit.map((c: any) => c.scopeId),
    { granularity: 'per-file-per-rule', skipped: [{ scopeId: 'web:src/a.ts', reasonCode: 'sentinel.coverage.unsupported' }] });
  const { envelopes, coverage } = evaluate(p, unit, res, 'per-file-per-rule');
  const s = envelopes.find(e => e.checkId === surface.id)!;
  assert.equal(s.status, 'partial');
  assert.ok(s.skipped.some(x => x.scopeId === 'web:src/a.ts'), 'the skip is kept on the surface check');
  assert.equal(coverage.complete, false);
  assert.equal(coverage.checks.find((c: any) => c.checkId === surface.id)!.complete, false);
  // A skip on a different captured file is proven disjoint from the other file's check, but not from the surface.
  const other = evaluate(p, unit, result(unit.map((c: any) => c.id), unit.map((c: any) => c.scopeId),
    { granularity: 'per-file-per-rule', skipped: [{ scopeId: 'web:src/b.ts', reasonCode: 'sentinel.coverage.unsupported' }] }), 'per-file-per-rule');
  const fileA = other.envelopes.find(e => e.checkId === unit.find((c: any) => c.scopeId === 'web:src/a.ts')!.id)!;
  assert.equal(fileA.status, 'complete', 'src/b.ts is proven disjoint from src/a.ts');
  assert.equal(other.envelopes.find(e => e.checkId === surface.id)!.status, 'partial', 'the surface\'s file is not recorded, so it is not proven disjoint');
});

test('scope extents come from the plan: captured files, folder boundaries, whole sources; anything else is unknown', () => {
  const p = plan([{ familyId: 'sentinel.ts.eval', languages: ['typescript'] }, { familyId: 'sentinel.repo.policy', languages: ['typescript'], scopeKind: 'repository' }]);
  const index = scopeIndex(p);
  const repo = p.checks.find((c: any) => c.scopeId === 'web' && c.scopeKind === 'repository')!;
  const fileA = p.checks.find((c: any) => c.scopeId === 'web:src/a.ts')!;
  assert.equal(bearsOn('web:src/a.ts', repo, index), true);
  assert.equal(bearsOn('web:src/b.ts', fileA, index), false, 'two captured files of the plan are disjoint');
  assert.equal(bearsOn('webapp:src/a.ts', fileA, index), true, 'a scope the plan does not name is unknown and bears');
  assert.equal(bearsOn('web:#index-omitted', fileA, index), true, 'an opaque scope bears');
});
