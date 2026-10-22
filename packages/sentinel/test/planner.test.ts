// The deterministic planner on synthetic inputs: bootstrap and analysis revisions, applicability, capability and
// scope states, physical batching that covers exactly its checks, pins, immutability, re-planning a new rule
// without recapture, cycles and limits. No file, ledger, scanner or network is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CHECK_STATES, PLAN_ERROR_CODES, PLAN_REASON_CODES, PlanError, checkWorkGraph, languageOf, planAnalysis, planBootstrap,
  surfacesFromIndex, verifyPlanRevision,
} from '../dist/planner/index.js';
import type { PlanRevision } from '../dist/planner/index.js';
import { analysisView, lockedRules, policyView, registry, snapshotView, trustedProfile, type RuleSpec } from './planner-helpers.ts';

const d = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const code = (c: string) => (e: unknown) => e instanceof PlanError && e.code === c;

const profile = trustedProfile({ permitExtra: ['framework-order'] });

const rule = (familyId: string, over: Partial<RuleSpec> = {}): RuleSpec => ({ familyId, ...over });

const RULES = {
  eval: rule('sentinel.ts.eval'),
  calls: rule('sentinel.ts.dangerous-call', { requires: ['call-occurrence'] }),
  spring: rule('sentinel.spring.unprotected-route', { languages: ['java'], scopeKind: 'surface', frameworks: ['spring'], requires: ['source-span'] }),
  springOrder: rule('sentinel.spring.filter-order', { languages: ['java'], scopeKind: 'surface', frameworks: ['spring'], requires: ['framework-order'] }),
  deps: rule('sentinel.deps.known-vulnerable', { languages: ['typescript', 'javascript', 'java'], scopeKind: 'dependency-manifest', requires: ['dependency-manifest', 'advisory-database'], adapterId: 'osv' }),
  ci: rule('sentinel.ci.unpinned-action', { scopeKind: 'ci-config', adapterId: 'zizmor' }),
  repo: rule('sentinel.repo.missing-policy', { scopeKind: 'repository' }),
};

const lock = (rules: RuleSpec[]) => lockedRules(rules).view;
const policy = (familyIds: string[], options: Parameters<typeof policyView>[1] = {}) => policyView(familyIds, options).view;

const file = (sourceId: string, relativePath: string) => ({ sourceId, relativePath, kind: 'file' as const, disposition: 'included' as const,
  content: d(`${sourceId}/${relativePath}`), bytes: 10, generated: false });

const ENTRIES = [
  file('web', 'src/a.ts'), file('web', 'src/b.tsx'), file('web', 'src/broken.ts'), file('web', 'package.json'),
  file('web', '.github/workflows/ci.yml'), file('web', 'README.md'),
  { sourceId: 'web', relativePath: 'src/huge.ts', kind: 'file', disposition: 'too-large', reasonCode: 'sentinel.capture.tooLarge', bytes: 99, generated: false },
  { sourceId: 'web', relativePath: 'vendor/x.js', kind: 'file', disposition: 'excluded', reasonCode: 'sentinel.capture.excludedByPolicy', generated: false },
  { sourceId: 'web', relativePath: 'node_modules', kind: 'directory-boundary', disposition: 'excluded', reasonCode: 'sentinel.capture.excludedDependencyCache', knownDescendants: null },
  { sourceId: 'web', relativePath: 'locked', kind: 'directory-boundary', disposition: 'unreadable', reasonCode: 'sentinel.capture.unreadable', knownDescendants: null },
  file('api', 'src/main/java/App.java'), file('api', 'pom.xml'),
];
const SPRING = [{ framework: 'spring', state: 'resolved', version: '3.3.0', provenance: { sourceId: 'api', relativePath: 'pom.xml' } }];
const snap = (frameworkVersions: unknown[] = SPRING, entries: unknown[] = ENTRIES, sources = ['web', 'api']) => snapshotView(sources, entries, frameworkVersions).view;
const snapshot = snap();
const snapshotEntries = ENTRIES;

const analysisInputs = () => [
  analysisView('web', [{ path: 'src/a.ts', class: 'parsed' }, { path: 'src/b.tsx', class: 'parsed' }, { path: 'src/broken.ts', class: 'parse-failed' }]),
  analysisView('api', [{ path: 'src/main/java/App.java', class: 'parsed' }],
    [{ nodeId: 'api::src/main/java/App.java::App.list', path: 'src/main/java/App.java', kind: 'route' },
      { nodeId: 'api::src/main/java/App.java::App.create', path: 'src/main/java/App.java', kind: 'route' }]),
];
const analyses = analysisInputs();

const bootstrap = planBootstrap({ runId: 'run-1', sourceIds: ['web', 'api'], profile });
const inventoryRef = () => { const w = bootstrap.units.find(x => x.stage === 'inventory')!; return [{ id: w.id, revision: w.revision }]; };

function analysis(rules: RuleSpec[], over: Partial<Parameters<typeof planAnalysis>[0]> = {}): PlanRevision {
  return planAnalysis({ runId: 'run-1', revision: 2, previous: bootstrap, bootstrap: inventoryRef(), snapshot, analyses,
    lock: lock(rules), policy: policy(rules.map(r => r.familyId)), profile, ...over });
}

const checksOf = (plan: PlanRevision, familyId: string) => plan.checks.filter(c => c.familyId === familyId);

test('the bootstrap revision captures once, parses each source after it, and inventories after every parse', () => {
  assert.equal(bootstrap.kind, 'bootstrap');
  assert.deepEqual(bootstrap.units.map(w => w.stage), ['capture', 'parse', 'parse', 'inventory']);
  const capture = bootstrap.units[0]!;
  for (const p of bootstrap.units.filter(w => w.stage === 'parse')) assert.deepEqual(p.dependencies, [{ id: capture.id, revision: 1 }]);
  assert.equal(bootstrap.units.at(-1)!.dependencies.length, 2);
  assert.equal(verifyPlanRevision(bootstrap), true);
  assert.ok(Object.isFrozen(bootstrap) && Object.isFrozen(bootstrap.units[0]));
  assert.equal(planBootstrap({ runId: 'run-1', sourceIds: ['api', 'web'], profile }).digest, bootstrap.digest, 'source order does not matter');
});

test('every scope a rule names gets a check with an explicit state; nothing is dropped or invented', () => {
  const plan = analysis(Object.values(RULES));
  const evalChecks = checksOf(plan, RULES.eval.familyId);
  const byScope = Object.fromEntries(evalChecks.map(c => [c.scopeId, `${c.state}${c.reasonCode ? ` ${c.reasonCode}` : ''}`]));
  assert.deepEqual(byScope, {
    'web:src/a.ts': 'planned', 'web:src/b.tsx': 'planned', 'web:src/broken.ts': 'planned',
    'web:src/huge.ts': 'scope-unavailable sentinel.capture.tooLarge',
    'web:locked/': 'scope-unknown sentinel.plan.unknownDescendants',
  }, 'excluded files and an excluded folder are out of scope; a refused file and an unlisted folder stay visible');
  assert.equal(checksOf(plan, RULES.calls.familyId).find(c => c.scopeId === 'web:src/broken.ts')!.reasonCode, 'sentinel.plan.parseRequired',
    'a rule that needs parser evidence cannot run on a file that did not parse');
  // Framework-gated: one check per discovered Spring surface; the web source's unlisted folder may hold Java
  // surfaces too, and Spring is not detected there, so it stays unknown. The order rule's capability is unavailable.
  assert.deepEqual(checksOf(plan, RULES.spring.familyId).map(c => [c.scopeId, c.state]).sort(),
    [['api::src/main/java/App.java::App.create', 'planned'], ['api::src/main/java/App.java::App.list', 'planned'], ['web:locked/', 'applicability-unknown']]);
  assert.ok(checksOf(plan, RULES.springOrder.familyId).filter(c => c.sourceId === 'api').every(c => c.state === 'unsupported' && c.reasonCode === 'sentinel.plan.capabilityUnavailable'),
    'permitted by the profile, but no registered adapter establishes it');
  assert.deepEqual(checksOf(plan, RULES.deps.familyId).map(c => [c.scopeId, c.state]).sort(),
    [['api:pom.xml', 'planned'], ['web:locked/', 'scope-unknown'], ['web:package.json', 'planned']], 'an unlisted folder may hold manifests too');
  assert.deepEqual(checksOf(plan, RULES.ci.familyId).map(c => [c.scopeId, c.state, c.reasonCode]).sort(),
    [['web:.github/workflows/ci.yml', 'unsupported', 'sentinel.plan.adapterNotRegistered'], ['web:locked/', 'scope-unknown', 'sentinel.plan.unknownDescendants']]);
  // A whole-repository check reads every captured file of its source; everything it cannot read is an explicit gap.
  assert.deepEqual(Object.fromEntries(checksOf(plan, RULES.repo.familyId).map(c => [c.scopeId, `${c.state}${c.reasonCode ? ` ${c.reasonCode}` : ''}`])), {
    'api': 'planned', 'web': 'planned',
    'web:src/huge.ts': 'scope-unavailable sentinel.capture.tooLarge',
    'web:vendor/x.js': 'scope-unavailable sentinel.capture.excludedByPolicy',
    'web:node_modules/': 'scope-unavailable sentinel.capture.excludedDependencyCache',
    'web:locked/': 'scope-unknown sentinel.plan.unknownDescendants',
  });
  const repoUnit = plan.units.find(u => u.checks.includes(checksOf(plan, RULES.repo.familyId).find(c => c.scopeId === 'web')!.id))!;
  assert.deepEqual(repoUnit.inputs.map(i => i.relativePath),
    (snapshotEntries as any[]).filter(e => e.sourceId === 'web' && e.kind === 'file' && e.disposition === 'included').map(e => e.relativePath).sort(),
    'the complete captured set, never an empty input');
  // Tallies agree with the checks; mandatory unsupported checks make complete required coverage unachievable.
  assert.equal(Object.values(plan.tallies.checks).reduce((a, b) => a + b, 0), plan.checks.length);
  assert.equal(plan.requiredCoverageAchievable, false);
  assert.equal(plan.tallies.requiredNotPlanned, plan.checks.filter(c => c.state !== 'planned').length);
});

test('physical batching covers exactly the planned checks, each once, within its bounds', () => {
  const plan = analysis(Object.values(RULES), { limits: { maxScopesPerWork: 2 } });
  const planned = new Set(plan.checks.filter(c => c.state === 'planned').map(c => c.id));
  const covered = plan.units.flatMap(w => w.checks);
  assert.equal(covered.length, new Set(covered).size, 'no check in two units');
  assert.deepEqual(new Set(covered), planned, 'units cover the planned checks and nothing else');
  for (const w of plan.units) {
    assert.equal(w.stage, 'check');
    assert.ok(w.scopes.length <= 2, `${w.id} covers ${w.scopes.length} scopes`);
    for (const id of w.checks) assert.equal(plan.checks.find(c => c.id === id)!.unit?.id, w.id);
    assert.deepEqual(w.dependencies, inventoryRef(), 'checks wait for the published inventory');
    assert.ok(new Set(w.checks.map(id => plan.checks.find(c => c.id === id)!.sourceId)).size === 1, 'one source per unit');
  }
  for (const c of plan.checks) if (c.state !== 'planned') assert.equal(c.unit, undefined, 'an unplanned check has no work');
  const dbUnit = plan.units.find(w => w.adapterId === 'osv')!;
  assert.equal(dbUnit.implementationDigest, registry.get('osv').digest, 'a registered adapter runs by its registry digest');
});

test('the same inputs in any order give the same revision; the pins name exactly what it used', () => {
  const a = analysis(Object.values(RULES));
  // The same lock and policy; the snapshot's entries, its sources and the analyses in other orders.
  const b = planAnalysis({ runId: 'run-1', revision: 2, previous: bootstrap, bootstrap: inventoryRef(),
    snapshot: snap(SPRING, [...ENTRIES].reverse()), analyses: [...analysisInputs()].reverse(), profile,
    lock: lock(Object.values(RULES)), policy: policy(Object.values(RULES).map(r => r.familyId)) });
  assert.equal(b.digest, a.digest);
  assert.equal(a.pins.snapshotId, 'snap-1');
  assert.equal(a.pins.ruleLockDigest, lock(Object.values(RULES)).digest);
  assert.deepEqual(a.pins.analyses.map(x => x.sourceId), ['api', 'web']);
  assert.deepEqual(a.pins.databases, [{ databaseId: 'osv-db', snapshotDigest: d('osv db snapshot') }]);
  assert.equal(a.previous, bootstrap.digest);
  assert.equal(verifyPlanRevision(a), true);
});

test('a new rule plans new work over every relevant scope without recapture, and the active plan never changes', () => {
  const first = analysis([RULES.eval]);
  const frozen = JSON.stringify(first);
  const added = rule('sentinel.ts.new-sink');
  const second = planAnalysis({ runId: 'run-1', revision: 3, previous: first, bootstrap: inventoryRef(), snapshot, analyses,
    lock: lock([RULES.eval, added]), policy: policy([RULES.eval.familyId, added.familyId]), profile });
  assert.deepEqual(checksOf(second, added.familyId).filter(c => c.state === 'planned').map(c => c.scopeId).sort(),
    ['web:src/a.ts', 'web:src/b.tsx', 'web:src/broken.ts'], 'every relevant scope');
  assert.ok(second.units.every(w => w.stage === 'check'), 'no capture or parse is planned again');
  assert.deepEqual(second.reused, inventoryRef(), 'it depends on the published inventory');
  assert.equal(second.previous, first.digest);
  assert.equal(JSON.stringify(first), frozen, 'the earlier revision is unchanged');
  assert.equal(verifyPlanRevision(first), true);
  assert.throws(() => { (first.checks as unknown as unknown[]).push({}); }, TypeError, 'a revision is frozen');
  // A child run (a rule-lock change) starts its own revision 1 over the parent's published bootstrap.
  const child = planAnalysis({ runId: 'run-2', bootstrap: inventoryRef(), snapshot, analyses, lock: lock([RULES.eval, added]),
    policy: policy([RULES.eval.familyId, added.familyId]), profile });
  assert.equal(child.revision, 1);
  assert.equal(child.previous, null);
  assert.deepEqual(child.reused, inventoryRef());
  assert.ok(child.units.every(w => !first.units.some(x => x.id === w.id)), 'work ids are per run');
});

test('selection and capability decide required coverage; a policy rule missing from the lock is a visible gap', () => {
  const requested = planAnalysis({ runId: 'run-1', revision: 2, previous: bootstrap, bootstrap: inventoryRef(), snapshot, analyses,
    lock: lock([RULES.springOrder]), profile,
    policy: policy(['sentinel.ts.not-in-lock'], { requested: [RULES.springOrder.familyId] }) });
  assert.ok(checksOf(requested, RULES.springOrder.familyId).every(c => !c.required), 'a requested rule is not required by default');
  assert.deepEqual(requested.ruleGaps, [{ familyId: 'sentinel.ts.not-in-lock', required: true, reasonCode: 'sentinel.plan.ruleNotLocked' }]);
  assert.equal(requested.tallies.requiredNotPlanned, 1);
  const byCapability = planAnalysis({ runId: 'run-1', revision: 2, previous: bootstrap, bootstrap: inventoryRef(), snapshot, analyses,
    lock: lock([RULES.springOrder]), profile,
    policy: policy([], { requested: [RULES.springOrder.familyId], requiredCapabilities: ['framework-order'] }) });
  assert.ok(checksOf(byCapability, RULES.springOrder.familyId).every(c => c.required && (c.state === 'unsupported' || c.scopeId === 'web:locked/')));
  assert.equal(byCapability.requiredCoverageAchievable, false);
});

test('an unresolved framework leaves applicability unknown, and so does one the snapshot does not name', () => {
  const unresolved = snap([{ framework: 'spring', state: 'unknown', reasonCode: 'sentinel.capture.unreadable' }]);
  const plan = analysis([RULES.spring], { snapshot: unresolved });
  // Two discovered Java routes, and the unlisted folder that may hold more.
  assert.ok(plan.checks.length === 3 && plan.checks.every(c => c.state === 'applicability-unknown' && c.reasonCode === 'sentinel.plan.frameworkUnresolved'));
  const undetected = analysis([RULES.spring], { snapshot: snap([]) });
  assert.ok(undetected.checks.length === 3 && undetected.checks.every(c => c.state === 'applicability-unknown' && c.reasonCode === 'sentinel.plan.frameworkNotDetected'),
    'no version entry is never read as the framework being absent');
});

test('work cycles and unknown dependencies are refused', () => {
  const w = (id: string, deps: string[]) => ({ id, revision: 1, dependencies: deps.map(x => ({ id: x, revision: 1 })) });
  assert.throws(() => checkWorkGraph([w('a', ['b']), w('b', ['c']), w('c', ['a'])]), code('sentinel.plan.cycle'));
  assert.throws(() => checkWorkGraph([w('a', ['a'])]), code('sentinel.plan.cycle'));
  assert.throws(() => checkWorkGraph([w('a', ['ghost'])]), code('sentinel.plan.unknownDependency'));
  assert.doesNotThrow(() => checkWorkGraph([w('a', ['published']), w('b', ['a'])], [{ id: 'published', revision: 1 }]));
  assert.throws(() => checkWorkGraph([w('a', []), w('a', [])]), code('sentinel.plan.invalidInput'));
});

test('a revision must follow its own run and an intact previous revision, over pinned inputs', () => {
  assert.throws(() => planAnalysis({ runId: 'run-9', revision: 2, previous: bootstrap, bootstrap: inventoryRef(), snapshot, analyses,
    lock: lock([RULES.eval]), policy: policy([RULES.eval.familyId]), profile }), code('sentinel.plan.pinMismatch'));
  assert.throws(() => analysis([RULES.eval], { revision: 5 }), code('sentinel.plan.invalidInput'));
  const tampered = { ...bootstrap, units: bootstrap.units.slice(1) } as PlanRevision;
  assert.throws(() => analysis([RULES.eval], { previous: tampered }), code('sentinel.plan.pinMismatch'));
  assert.throws(() => analysis([RULES.eval], { analyses: analyses.slice(0, 1) }), code('sentinel.plan.pinMismatch'));
  assert.throws(() => analysis([RULES.eval], { bootstrap: [] }), code('sentinel.plan.invalidInput'));
});

test('plan size is bounded, and a limit can only be lowered', () => {
  assert.throws(() => analysis(Object.values(RULES), { limits: { maxChecks: 3 } }), code('sentinel.plan.tooManyChecks'));
  assert.throws(() => analysis(Object.values(RULES), { limits: { maxWork: 1 } }), code('sentinel.plan.tooMuchWork'));
  assert.throws(() => analysis([RULES.eval], { limits: { maxChecks: 10_000_000 } }), code('sentinel.plan.invalidInput'));
});

test('surfaces come only from an explicit list of graph kinds; languages come from extensions', () => {
  const index = { nodes: [
    { nodeId: 'web::src/r.ts::GET /x', kind: 'route', path: 'src/r.ts' },
    { nodeId: 'web::src/r.ts::helper', kind: 'function', path: 'src/r.ts' },
  ] };
  assert.deepEqual(surfacesFromIndex(index, ['route']).map(s => s.nodeId), ['web::src/r.ts::GET /x']);
  assert.deepEqual(surfacesFromIndex(index, []), []);
  assert.deepEqual(['a.ts', 'a.d.ts', 'b.mjs', 'C.java', 'x.py', 'dir.ts/file'].map(languageOf),
    ['typescript', 'typescript', 'javascript', 'java', undefined, undefined]);
});

test('every planner code and check state has catalog words in both registers with a define', async () => {
  const { STRINGS } = await import('@farsight/core/dist/strings.js');
  const stateKey = (s: string) => `sentinel.plan.state${s.split('-').map(w => w[0]!.toUpperCase() + w.slice(1)).join('')}`;
  for (const key of [...PLAN_REASON_CODES, ...PLAN_ERROR_CODES, ...CHECK_STATES.map(stateKey)]) {
    const e = STRINGS[key];
    assert.ok(e?.hud && e.professional && e.define, key);
  }
});

test('an infrastructure-configuration rule scopes Dockerfiles, Terraform and YAML, each by file, and nothing else', () => {
  const iac = rule('sentinel.iac.misconfiguration', { scopeKind: 'infrastructure-config', adapterId: 'zizmor' });
  const entries = [...ENTRIES, file('web', 'deploy/Dockerfile'), file('web', 'deploy/app.dockerfile'), file('web', 'deploy/Containerfile.prod'),
    file('web', 'k8s/pod.yaml'), file('web', 'infra/main.tf'), file('web', 'infra/vars.tf.json'), file('web', 'infra/terraform.tfvars')];
  const plan = analysis([iac], { snapshot: snap(SPRING, entries) });
  assert.deepEqual(checksOf(plan, iac.familyId).map(c => c.scopeId).sort(), [
    'web:.github/workflows/ci.yml', 'web:deploy/Containerfile.prod', 'web:deploy/Dockerfile', 'web:deploy/app.dockerfile',
    'web:infra/main.tf', 'web:infra/vars.tf.json', 'web:k8s/pod.yaml', 'web:locked/',
  ], 'every candidate file is a check; the engine decides which YAML is a manifest, and says so');
});
