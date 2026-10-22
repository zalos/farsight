// Planner inputs from the rule lock, pack manifests, effective policy and parser evidence shapes. A definition is
// admitted only when it recomputes to the digest the lock pins; anything else is refused, never substituted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJsonBytes } from '../dist/store/objects.js';
import { PlanError, planAnalysis, planBootstrap, plannerAnalysisFrom, plannerLockFrom, plannerPolicyFrom, ruleLockDigest } from '../dist/planner/index.js';

const d = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const canonical = (v: unknown) => `sha256:${createHash('sha256').update(canonicalJsonBytes(v)).digest('hex')}`;
const code = (c: string) => (e: unknown) => e instanceof PlanError && e.code === c;

const definition = {
  familyId: 'sentinel.ts.eval', revision: 2, titleKey: 'sentinel.rule.evalTitle',
  applicability: { languages: ['typescript'], scopeKind: 'source-file' },
  requires: ['source-bytes', 'pattern-match'], implementation: { adapterId: 'sentinel-pattern', rulePath: 'rules/eval.yml' },
  meaning: 'candidate', severity: 'high', evidenceRequired: ['source-span'], limitationKeys: [], mappings: { cwe: ['CWE-95'] },
  fixtures: { positive: ['fixtures/eval-bad.ts'], negative: ['fixtures/eval-good.ts'] },
};
const manifest = { packId: 'pack-core', rules: [definition] };
const files = ['fixtures/eval-bad.ts', 'fixtures/eval-good.ts', 'rules/eval.yml', 'sentinel-pack.json'].map(path => ({ path, digest: d(path), size: 10 }));
const named = (p: string) => files.find(f => f.path === p)!;
const definitionDigest = canonical({ kind: 'sentinel-rule/1', rule: definition, files: ['rules/eval.yml', 'fixtures/eval-bad.ts', 'fixtures/eval-good.ts'].map(named) });
const lock = {
  schema: 'sentinel-rulelock/draft-1', revision: 2, previous: null, createdAt: '2026-10-22T00:00:00Z',
  packs: [{ packId: 'pack-core', version: '1.0.0', packDigest: d('inventory'), files, rules: [{ familyId: 'sentinel.ts.eval', revision: 2, definitionDigest }] }],
  tools: [{ adapterId: 'osv', version: '2.0.0', artifactDigest: d('osv') }], databases: [],
};

test('a locked rule is admitted with its verified definition, pinned to the lock digest', () => {
  const view = plannerLockFrom(lock, [manifest], ruleLockDigest(lock));
  assert.equal(view.digest, canonical(lock));
  assert.deepEqual(view.rules, [{ familyId: 'sentinel.ts.eval', revision: 2, definitionDigest, packDigest: d('inventory'),
    languages: ['typescript'], scopeKind: 'source-file', requires: ['source-bytes', 'pattern-match'], adapterId: 'sentinel-pattern' }]);
});

test('another lock, a changed definition, a missing rule, pack or pinned file is refused', () => {
  assert.throws(() => plannerLockFrom(lock, [manifest], d('another lock')), code('sentinel.plan.pinMismatch'));
  const changed = { ...manifest, rules: [{ ...definition, severity: 'low' }] };
  assert.throws(() => plannerLockFrom(lock, [changed]), code('sentinel.plan.pinMismatch'), 'any changed field');
  assert.throws(() => plannerLockFrom(lock, [{ packId: 'pack-core', rules: [] }]), code('sentinel.plan.pinMismatch'));
  assert.throws(() => plannerLockFrom(lock, []), code('sentinel.plan.pinMismatch'));
  const thin = { ...lock, packs: [{ ...lock.packs[0]!, files: files.filter(f => f.path !== 'rules/eval.yml') }] };
  assert.throws(() => plannerLockFrom(thin, [manifest]), code('sentinel.plan.pinMismatch'));
});

test('policy and parser evidence map to the planner view, surfaces only from the named kinds', () => {
  const effective = { schema: 'sentinel-policy/draft-1', settingsTrust: 'adopted', rules: [{ familyId: 'sentinel.ts.eval', source: 'mandatory' }],
    thresholds: { failOnSeverity: 'high', requireCompleteCoverage: true, requiredCapabilities: ['pattern-match'] } };
  const policy = plannerPolicyFrom(effective);
  assert.equal(policy.digest, canonical(effective));
  assert.deepEqual([policy.requireCompleteCoverage, policy.requiredCapabilities], [true, ['pattern-match']]);
  const analysis = plannerAnalysisFrom({ sourceId: 'web', result: { analysisFingerprint: 'fp', entries: [{ path: 'src/a.ts', class: 'parsed' }] },
    index: { nodes: [{ nodeId: 'web::src/a.ts::GET /a', kind: 'route', path: 'src/a.ts' }, { nodeId: 'web::src/a.ts::f', kind: 'function', path: 'src/a.ts' }] } }, ['route']);
  assert.deepEqual(analysis.surfaces.map(s => s.nodeId), ['web::src/a.ts::GET /a']);

  // End to end: the adapted inputs plan, pinning exactly the lock and policy digests they came from.
  const profile = { id: 'p', capabilities: [{ capability: 'source-bytes', available: true }, { capability: 'pattern-match', available: true }],
    builtInAdapters: [{ adapterId: 'sentinel-pattern', implementationDigest: d('pattern') }], stages: { capture: d('c'), parse: d('p'), inventory: d('i') } };
  const boot = planBootstrap({ runId: 'run-1', sourceIds: ['web'], profile });
  const inv = boot.work.at(-1)!;
  const plan = planAnalysis({ runId: 'run-1', revision: 2, previous: boot, bootstrap: [{ id: inv.id, revision: 1 }], profile,
    snapshot: { id: 'snap-1', inventoryDigest: d('inv'), environmentProfileDigest: d('env'), sources: [{ sourceId: 'web' }], frameworkVersions: [],
      entries: [{ sourceId: 'web', relativePath: 'src/a.ts', kind: 'file', disposition: 'included', content: d('a'), bytes: 1, generated: false }] },
    analyses: [analysis], lock: plannerLockFrom(lock, [manifest]), policy });
  assert.equal(plan.pins.ruleLockDigest, canonical(lock));
  assert.equal(plan.pins.policyDigest, canonical(effective));
  assert.deepEqual(plan.checks.map(c => [c.scopeId, c.state, c.required]), [['web:src/a.ts', 'planned', true]]);
});
