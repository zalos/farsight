// Planner inputs from the actual rule lock, validated packs and effective policy, and the conversion of a plan
// into canonical work envelopes. Anything that does not match its pin is refused, never substituted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { emptyLock, lockDigest, validatePack } from '../dist/rules/index.js';
import { DEFAULT_SETTINGS, effectivePolicy } from '../dist/policy/index.js';
import { validateEnvelope } from '../dist/validate.js';
import {
  PlanError, adapterOf, canonicalArtifactId, capturedInputsOf, checksCoveredBy, influenceManifestOf,
  planAnalysis, planBootstrap, plannerLockFrom, plannerPolicyFrom, workEnvelopesFor,
} from '../dist/planner/index.js';

const D = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const code = (c: string) => (e: unknown) => e instanceof PlanError && e.code === c;

const definition = {
  familyId: 'sentinel.ts.eval', revision: 2, titleKey: 'sentinel.rule.evalTitle',
  applicability: { languages: ['typescript'], scopeKind: 'source-file' },
  requires: ['source-bytes', 'pattern-match'], implementation: { adapterId: 'sentinel-pattern', rulePath: 'rules/eval.yml' },
  meaning: 'candidate', severity: 'high', evidenceRequired: ['source-span'], limitationKeys: [], mappings: { cwe: ['CWE-95'] },
  fixtures: { positive: ['fixtures/eval-bad.ts'], negative: ['fixtures/eval-good.ts'] },
};
const packOf = (rules: unknown[]) => validatePack(new Map<string, Uint8Array>([
  ['sentinel-pack.json', Buffer.from(JSON.stringify({ schema: 'sentinel-rulepack/draft-1', packId: 'pack-core', version: '1.0.0', rights: { spdx: 'MIT', origin: 'sentinel-original' }, rules }))],
  ['rules/eval.yml', Buffer.from('rule\n')], ['fixtures/eval-bad.ts', Buffer.from('bad\n')], ['fixtures/eval-good.ts', Buffer.from('good\n')],
]));
const pack = packOf([definition]);
const NOW = new Date('2026-10-22T12:00:00.000Z');
// A lock entry exactly as promotion writes it (promotion itself is exercised in planner-integration.test.ts).
const lock = { ...emptyLock(NOW), revision: 2, previous: lockDigest(emptyLock(NOW)),
  packs: [{ ...structuredClone((pack as any).entry), promotion: { receipt: D('receipt'), at: '2026-10-22T12:00:00.000000000Z' } }] };

const pin = lockDigest(lock as never);
const policyCode = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

test('a locked rule is planned with exactly the definition the lock pins', () => {
  assert.ok(validateEnvelope('rulelock', lock).ok);
  const view = plannerLockFrom(lock, [pack], pin);
  assert.equal(view.digest, pin);
  assert.deepEqual(view.rules[0], { familyId: 'sentinel.ts.eval', revision: 2, definitionDigest: pack.rules[0]!.definitionDigest, packDigest: pack.packDigest,
    languages: ['typescript'], scopeKind: 'source-file', requires: ['source-bytes', 'pattern-match'], adapterId: 'sentinel-pattern' });
});

test('another lock, a missing, changed or forged pack, or a forged policy object is refused', () => {
  assert.throws(() => plannerLockFrom(lock, [pack], D('another lock')), policyCode('sentinel.rules.lockInvalid'));
  assert.throws(() => plannerLockFrom(lock, [], pin), policyCode('sentinel.rules.packMissing'));
  assert.throws(() => plannerLockFrom(lock, [packOf([{ ...definition, severity: 'low' }])], pin), policyCode('sentinel.rules.packMismatch'));
  assert.throws(() => plannerLockFrom(lock, [JSON.parse(JSON.stringify(pack))], pin), policyCode('sentinel.rules.packMismatch'), 'a copy is not a validated pack');
  const real = effectivePolicy({ trust: 'missing', settings: null, settingsDigest: null, repoConfig: null, repoConfigDigest: null });
  assert.equal(plannerPolicyFrom(real).digest, real.revision);
  assert.throws(() => plannerPolicyFrom({ ...real } as never), code('sentinel.plan.pinMismatch'), 'only effectivePolicy’s own result');
});

test('a plan converts to canonical work envelopes that cover exactly its checks', () => {
  const policy = effectivePolicy({ trust: 'adopted', settings: { ...structuredClone(DEFAULT_SETTINGS), mandatoryRules: ['sentinel.ts.eval'] },
    settingsDigest: D('settings'), repoConfig: null, repoConfigDigest: null });
  const profile = { id: 'p', capabilities: [{ capability: 'source-bytes', available: true }, { capability: 'pattern-match', available: true }],
    builtInAdapters: [{ adapterId: 'sentinel-pattern', implementationDigest: D('pattern') }], stages: { capture: D('c'), parse: D('p'), inventory: D('i') } };
  const boot = planBootstrap({ runId: 'run-1', sourceIds: ['web'], profile });
  const file = (p: string) => ({ sourceId: 'web', relativePath: p, kind: 'file' as const, disposition: 'included' as const, content: D(p), bytes: 1, generated: false });
  const snapshot = { id: 'snap-1', entries: [file('src/a.ts'), file('src/b.ts')] };
  const plan = planAnalysis({ runId: 'run-1', revision: 2, previous: boot, bootstrap: [{ id: boot.units.at(-1)!.id, revision: 1 }], profile,
    snapshot: { ...snapshot, inventoryDigest: D('inv'), environmentProfileDigest: D('env'), sources: [{ sourceId: 'web' }], frameworkVersions: [] },
    analyses: [{ sourceId: 'web', analysisFingerprint: 'fp', files: [], surfaces: [] }], lock: plannerLockFrom(lock, [pack], pin), policy: plannerPolicyFrom(policy) });
  const L = { deadlineMs: 1000, memoryBytes: 1 << 26, cpuQuota: 1, maxPids: 8, maxOutputBytes: 1 << 16 };
  const execution = { resources: { capture: L, parse: L, inventory: L, check: L } };
  const conversion = { coordinatorEpoch: 'epoch-1', createdAt: '2026-10-22T12:00:00Z', execution };
  const [unit] = workEnvelopesFor(plan, conversion);
  assert.ok(validateEnvelope('work', unit!.envelope).ok);
  assert.equal(unit!.envelope.influenceManifest, canonicalArtifactId(influenceManifestOf(plan, unit!.envelope)));
  assert.deepEqual(unit!.envelope.stage, { contract: 'sentinel.stage.check.sentinel-pattern', contractVersion: 'draft-1', kind: 'coded', implementationDigest: D('pattern') });
  assert.deepEqual(checksCoveredBy(plan, unit!.envelope), plan.checks.filter(c => c.state === 'planned').map(c => c.id));
  assert.equal(adapterOf(plan, unit!.envelope), 'sentinel-pattern');
  assert.deepEqual(capturedInputsOf(plan, unit!.envelope, snapshot).map(i => i.id), [D('src/a.ts'), D('src/b.ts')]);
  const bootUnits = workEnvelopesFor(boot, conversion);
  assert.deepEqual(bootUnits.map(u => u.envelope.state), ['ready', 'pending', 'pending']);
  assert.equal(adapterOf(boot, boot.units[0]!), null);
  // Refusals: an edited plan, a missing stage budget, a ceiling breach, another snapshot, an unlisted file, an unknown unit.
  assert.throws(() => workEnvelopesFor({ ...plan, revision: 9 } as never, conversion), code('sentinel.plan.pinMismatch'));
  assert.throws(() => workEnvelopesFor(plan, { ...conversion, execution: { resources: {} as never } }), code('sentinel.plan.invalidInput'));
  assert.throws(() => workEnvelopesFor(plan, { ...conversion, execution: { resources: { ...execution.resources, check: { ...L, maxPids: 4096 } } } }),
    code('sentinel.plan.invalidInput'), 'the work contract’s ceilings bind the profile');
  assert.throws(() => capturedInputsOf(plan, unit!.envelope, { ...snapshot, id: 'snap-2' }), code('sentinel.plan.pinMismatch'));
  assert.throws(() => capturedInputsOf(plan, unit!.envelope, { ...snapshot, entries: [file('src/a.ts')] }), code('sentinel.plan.pinMismatch'));
  assert.throws(() => checksCoveredBy(plan, { id: 'work-ghost', revision: 1 }), code('sentinel.plan.invalidInput'));
});
