// What makes a capability, an adapter or a bootstrap stage usable: trusted registry and capability facts only,
// intersected with what the profile permits; whole-repository scopes; per-source unknown frameworks; the exact
// captured input set. Synthetic inputs over a real adapter registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import {
  PlanError, createCapabilityTable, planAnalysis, planBootstrap, verifyInputSet, workEnvelopesFor,
} from '../dist/planner/index.js';
import { OSV_IMAGE, registry, trustedProfile } from './planner-helpers.ts';

const d = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const code = (c: string) => (e: unknown) => e instanceof PlanError && e.code === c;
const rule = (familyId: string, over: Record<string, unknown> = {}) => ({ familyId, revision: 1, definitionDigest: d(familyId), packDigest: d('pack'),
  languages: ['typescript', 'java'], scopeKind: 'source-file', requires: ['source-bytes', 'pattern-match'], adapterId: 'sentinel-pattern', ...over });
const file = (s: string, p: string) => ({ sourceId: s, relativePath: p, kind: 'file' as const, disposition: 'included' as const, content: d(`${s}/${p}`), bytes: 1, generated: false });
const L = { deadlineMs: 1000, memoryBytes: 1 << 26, cpuQuota: 1, maxPids: 8, maxOutputBytes: 1 << 16 };
const conversion = { coordinatorEpoch: 'epoch-1', createdAt: '2026-10-22T12:00:00Z', execution: { resources: { capture: L, parse: L, inventory: L, check: L } } };

function plan(rules: ReturnType<typeof rule>[], over: Record<string, unknown> = {}) {
  const profile = (over.profile as ReturnType<typeof trustedProfile>) ?? trustedProfile();
  const boot = planBootstrap({ runId: 'run-1', sourceIds: ['web', 'api'], profile });
  return planAnalysis({ runId: 'run-1', revision: 2, previous: boot, bootstrap: [{ id: boot.units.at(-1)!.id, revision: 1 }], profile,
    snapshot: { id: 'snap-1', inventoryDigest: d('inv'), environmentProfileDigest: d('env'), sources: [{ sourceId: 'web' }, { sourceId: 'api' }],
      frameworkVersions: [], entries: [file('web', 'src/a.ts'), file('web', 'src/b.ts'), file('api', 'App.java'), file('web', 'package.json')], ...(over.snapshot as object ?? {}) },
    analyses: [{ sourceId: 'web', analysisFingerprint: 'fp-w', files: [], surfaces: [] }, { sourceId: 'api', analysisFingerprint: 'fp-a', files: [], surfaces: [] }],
    lock: { digest: d('lock'), rules, tools: (over.tools as never) ?? [{ adapterId: 'osv', version: '2.0.0', artifactDigest: d('osv') }], databases: [] },
    policy: { digest: d('policy'), rules: rules.map(r => ({ familyId: r.familyId, source: 'mandatory' as const })), requireCompleteCoverage: false, requiredCapabilities: [] },
    ...(over.limits ? { limits: over.limits } : {}) });
}
const states = (p: ReturnType<typeof plan>) => [...new Set(p.checks.map(c => `${c.state}${c.reasonCode ? ` ${c.reasonCode}` : ''}`))];

test('a capability is available only when a registered adapter establishes it and the profile permits it', () => {
  assert.deepEqual(states(plan([rule('sentinel.ts.eval')])), ['planned']);
  assert.deepEqual(states(plan([rule('sentinel.ts.eval')], { profile: trustedProfile({ forbid: ['pattern-match'] }) })), ['unsupported sentinel.plan.capabilityNotPermitted']);
  assert.deepEqual(states(plan([rule('sentinel.ts.order', { requires: ['framework-order'] })], { profile: trustedProfile({ permitExtra: ['framework-order'] }) })),
    ['unsupported sentinel.plan.capabilityUnavailable'], 'permission cannot make an unestablished capability available');
  const forged = { ...trustedProfile(), capabilities: { facts: [{ capability: 'framework-order', adapterId: 'sentinel-pattern', evidence: 'claimed', adapterDigest: registry.get('sentinel-pattern').digest }] } };
  assert.throws(() => plan([rule('sentinel.ts.eval')], { profile: forged }), code('sentinel.plan.invalidInput'), 'a table not built by createCapabilityTable');
  assert.throws(() => createCapabilityTable(registry, [{ capability: 'framework-order', adapterId: 'not-registered', evidence: 'claimed' }]), code('sentinel.plan.invalidInput'));
  // The same adapter id re-registered with another definition is another adapter: the fact no longer holds.
  const other = createAdapterRegistry([{ id: 'sentinel-pattern', version: '2', kind: 'built-in', isolation: 'child',
    module: fileURLToPath(new URL('./fixtures/workers/hostile-worker.mjs', import.meta.url)) }]);
  const stale = { ...trustedProfile({ bootstrap: false }), registry: other };
  assert.deepEqual(states(plan([rule('sentinel.ts.eval')], { profile: stale })), ['unsupported sentinel.plan.capabilityUnavailable']);
});

test('a rule runs only through a registered adapter, and an external one only when the lock pins it', () => {
  assert.deepEqual(states(plan([rule('sentinel.ts.x', { adapterId: 'zizmor' })])), ['unsupported sentinel.plan.adapterNotRegistered']);
  const deps = rule('sentinel.deps.vuln', { scopeKind: 'dependency-manifest', requires: ['dependency-manifest', 'advisory-database'], adapterId: 'osv', languages: ['typescript'] });
  assert.deepEqual(states(plan([deps])), ['planned']);
  assert.deepEqual(states(plan([deps], { tools: [] })), ['unsupported sentinel.plan.adapterNotLocked']);
  const p = plan([deps]);
  assert.equal(p.units[0]!.implementationDigest, registry.get('osv').digest);
  assert.deepEqual(p.pins.adapters, [{ adapterId: 'osv', digest: registry.get('osv').digest }]);
  assert.deepEqual(p.pins.capabilities.map(c => c.capability), ['advisory-database', 'dependency-manifest']);
  void OSV_IMAGE;
});

test('an unbound bootstrap stage stays in the plan, and its work is blocked with its reason', () => {
  const boot = planBootstrap({ runId: 'run-1', sourceIds: ['web'], profile: trustedProfile({ bootstrap: false }) });
  assert.ok(boot.units.every(u => u.adapterId === null));
  assert.deepEqual(boot.pins.operations, { capture: null, parse: null, inventory: null });
  const works = workEnvelopesFor(boot, conversion).map(w => w.envelope);
  assert.ok(works.every(w => w.state === 'blocked' && (w as { reasonCode: string }).reasonCode === 'sentinel.plan.operationUnbound'));
  const bound = planBootstrap({ runId: 'run-1', sourceIds: ['web'], profile: trustedProfile() });
  assert.deepEqual(workEnvelopesFor(bound, conversion).map(w => w.envelope.state), ['ready', 'pending', 'pending']);
  assert.throws(() => planBootstrap({ runId: 'run-1', sourceIds: ['web'], profile: { ...trustedProfile(), operations: { capture: 'ghost' } } }), code('sentinel.plan.invalidInput'));
});

test('a whole-repository check reads the complete captured set or is not planned', () => {
  const repo = rule('sentinel.repo.policy', { scopeKind: 'repository' });
  const p = plan([repo]);
  const web = p.units.find(u => u.scopes.includes('web'))!;
  assert.deepEqual(web.inputs.map(i => i.relativePath), ['package.json', 'src/a.ts', 'src/b.ts']);
  assert.deepEqual(states(plan([repo], { limits: { maxRepositoryInputs: 2 } })).sort(), ['planned', 'scope-unavailable sentinel.plan.repositoryTooLarge'],
    'the two-file source is planned; the three-file source is not run over part of it');
  verifyInputSet(p, web, [...web.inputs].reverse().map(i => ({ id: i.content })));
  assert.throws(() => verifyInputSet(p, web, web.inputs.slice(1).map(i => ({ id: i.content }))), code('sentinel.plan.pinMismatch'));
  assert.throws(() => verifyInputSet(p, web, [...web.inputs.map(i => ({ id: i.content })), { id: d('extra') }]), code('sentinel.plan.pinMismatch'));
});

test('an unknown framework version read for one source is unknown there only; without a source it is unknown everywhere', () => {
  const spring = rule('sentinel.spring.x', { languages: ['java', 'typescript'], frameworks: ['spring'] });
  const reasons = (fv: unknown[]) => Object.fromEntries(plan([spring], { snapshot: { frameworkVersions: fv } }).checks.map(c => [c.scopeId, c.reasonCode]));
  assert.deepEqual(reasons([{ framework: 'spring', state: 'unknown', reasonCode: 'sentinel.capture.unreadable', sourceId: 'api' }]), {
    'api:App.java': 'sentinel.plan.frameworkUnresolved', 'web:src/a.ts': 'sentinel.plan.frameworkNotDetected', 'web:src/b.ts': 'sentinel.plan.frameworkNotDetected',
  });
  assert.ok(Object.values(reasons([{ framework: 'spring', state: 'unknown', reasonCode: 'sentinel.capture.unreadable' }])).every(r => r === 'sentinel.plan.frameworkUnresolved'));
});
