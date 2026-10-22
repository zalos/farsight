import { scannerKernels } from '../dist/adapters/drivers/kernels.js';
// The production check drivers with their real pinned engines, through PR 07's execution service only (no host
// fallback, no pull, no network): each driver prepares a unit from the shipped original rules and captured files, the
// service runs it, and the driver normalizes the verified outputs into per-check facts. Runs with SENTINEL_ISOLATION=1;
// the Trivy case also needs SENTINEL_TRIVY_CHECKS_DIR (the owner-acquired bundle) and fails rather than skips without it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { createExecutionService } from '../dist/execution/service.js';
import { PATTERN_SUPPORTED_RULES, OSV_SUPPORTED_RULES, TRIVY_SUPPORTED_RULES, ZIZMOR_SUPPORTED_RULES } from '../dist/adapters/drivers/index.js';
import { loadChecksBundle } from '../dist/adapters/trivy/index.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';
import { checks, execute, PACKS, prepareContext, sha, shippedRules, unit, verdicts } from './driver-helpers.ts';
import { capturedTree, TRIVY_LAYOUT, ZIZMOR_LAYOUT } from './iac-helpers.ts';
import { capturedTree as advisoryTree, syntheticSnapshot } from './osv-helpers.ts';

const enabled = process.env.SENTINEL_ISOLATION === '1';
const skip = !enabled && 'real pinned engines: set SENTINEL_ISOLATION=1 with a qualified local Docker and the pinned images installed';
const drivers = scannerKernels({ maxAdvisoryAgeMs: 3650 * 86_400_000 });
const driver = (id: string) => drivers.get(id)!.driver;
let root: { root: string; work: string };
let store: any;
let service: any;
let n = 0;
before(async () => {
  if (!enabled) return;
  root = scratch('drivers');
  store = await storeIn(root.root);
  service = await createExecutionService(store, { scratchRoot: root.work, registry: createAdapterRegistry([...drivers.values()].map(d => d.definition)), containers: true });
});
after(async () => { if (enabled) { await store.close(); removeScratch(root.root); } });

test('pattern: the shipped rules find their positives on the files they apply to, and nothing else is claimed', { skip }, async () => {
  const { pack, rules } = shippedRules('pattern');
  const layout: Record<string, { text: Buffer }> = {};
  for (const r of pack.manifest.rules) for (const f of [...r.fixtures.positive, ...r.fixtures.negative]) layout[f.replace(/^fixtures\//, '').replace(/\.fixture$/, '')] = { text: readFileSync(join(PACKS, 'pattern', f)) };
  const tree = capturedTree(join(root.root, `tree-${n++}`), layout);
  const u = unit(`w-pattern-${n}`, 'web', tree);
  const cs = PATTERN_SUPPORTED_RULES.flatMap(s => {
    const def = pack.manifest.rules.find((r: any) => r.familyId === s.familyId)!;
    const exts = def.applicability.languages.includes('java') ? ['.java'] : ['.ts', '.js'];
    return checks(s.familyId, 'source-file', 'web', tree.map(t => t.relativePath).filter(p => exts.some(e => p.endsWith(e))));
  });
  const r = await execute(service, driver('pattern-semgrep'), prepareContext(rules, u, cs, tree, root.root), `att-dpat-${n++}`);
  assert.equal(r.outcome.state, 'succeeded');
  assert.equal(r.result.attemptId, r.outcome.result.attemptId, 'the worker’s binding is kept');
  assert.equal(r.result.inputFingerprint, r.outcome.result.inputFingerprint);
  // Per rule and file, from the engine's own timings. The taint rules report no timing on files without a source, so
  // those checks are not run; a result's skips are per scope, so the other rule on such a file is partial, never more.
  const v = verdicts(r.result, cs);
  for (const [k, got] of Object.entries(v)) {
    const direct = /\/(direct|Direct)/.test(k);
    const taint = k.includes('request-to-query');
    assert.equal(got, direct ? (taint ? 'not-run:ruleNotRun' : 'ran:ruleNotRun') : 'ran', k);
  }
  const found = new Set(r.records.filter((x: any) => x.schema === 'sentinel-driver-finding/draft-1').map((x: any) => `${x.value.familyId} ${x.value.relativePath}`));
  const positives = new Set(pack.manifest.rules.flatMap((x: any) => x.fixtures.positive.map((p: string) => `${x.familyId} ${p.replace(/^fixtures\//, '').replace(/\.fixture$/, '')}`)));
  assert.deepEqual(found, positives, 'positives found, negatives clean');
  assert.ok(r.result.coveredChecks.every((c: any) => /^sha256:[0-9a-f]{64}$/.test(c.coverage)), 'each covered check names the normalized report');
});

test('OSV: a lockfile assessed against the pinned snapshot; a manifest OSV cannot read is never covered', { skip }, async () => {
  const tree = advisoryTree(join(root.root, `tree-${n++}`), { 'package-lock.json': 'package-lock-json.fixture' }, { 'package.json': '{"name":"x","dependencies":{"a":"^1.0.0"}}\n' });
  const snap = syntheticSnapshot(join(root.root, `db-${n}`), 'npm', [1], '2026-10-21T00:00:00.000000000Z');
  const { rules } = shippedRules('advisories');
  const u = unit(`w-osv-${n}`, 'web', tree);
  const cs = checks(OSV_SUPPORTED_RULES[0]!.familyId, 'dependency-manifest', 'web', ['package-lock.json', 'package.json']);
  const r = await execute(service, driver('advisories-osv'), prepareContext(rules, u, cs, tree, root.root,
    { databases: [{ pin: { databaseId: 'osv:npm', snapshotDigest: snap.snapshot.sha256 }, path: snap.path, record: snap.snapshot }] }), `att-dosv-${n++}`);
  assert.equal(r.outcome.state, 'succeeded');
  assert.deepEqual(verdicts(r.result, cs), { 'web:package-lock.json': 'ran', 'web:package.json': 'not-run:notDependencyFile' });
  assert.deepEqual(r.records.filter((x: any) => x.schema === 'sentinel-driver-finding/draft-1').map((x: any) => x.value.name), ['sentinel-fixture-alpha']);
});

test('Trivy: infrastructure files with the pinned bundle; partial where the engine honours an ignore; unrecognized YAML not run', { skip }, async () => {
  const dir = process.env.SENTINEL_TRIVY_CHECKS_DIR;
  assert.ok(dir, 'SENTINEL_TRIVY_CHECKS_DIR must name the owner-acquired bundle folder when SENTINEL_ISOLATION=1');
  const held = loadChecksBundle(join(dir, 'checks'));
  assert.ok(held, 'the pinned checks bundle has been acquired');
  const tree = capturedTree(join(root.root, `tree-${n++}`), TRIVY_LAYOUT);
  const u = unit(`w-trivy-${n}`, 'web', tree);
  const cs = checks(TRIVY_SUPPORTED_RULES[0]!.familyId, 'infrastructure-config', 'web', tree.map(t => t.relativePath).filter(p => !p.endsWith('.tfvars')));
  const record = JSON.parse(readFileSync(join(dir, 'checks', `${held.bundle.layer.slice(7)}.json`), 'utf8'));
  const r = await execute(service, driver('iac-trivy'), prepareContext(shippedRules('infrastructure').rules, u, cs, tree, root.root,
    { databases: [{ pin: { databaseId: 'trivy-checks', snapshotDigest: held.bundle.layer }, path: held.path, record }] }), `att-dtrivy-${n++}`);
  assert.equal(r.outcome.state, 'succeeded');
  assert.deepEqual(verdicts(r.result, cs), {
    'web:services/api/Dockerfile': 'ran', 'web:services/worker/hardened.Dockerfile': 'ran', 'web:services/legacy/Containerfile': 'ran:inlineIgnore',
    'web:deploy/pod.yaml': 'ran', 'web:config/settings.yaml': 'not-run:notRecognized', 'web:infra/storage/main.tf': 'ran', 'web:infra/storage/locals.tf': 'ran',
    'web:infra/network/main.tf': 'ran:remoteModuleUnresolved,variablesNotRead',
  });
  assert.ok(r.records.some((x: any) => x.value.checkId === 'KSV-0017'));
});

test('zizmor: workflows, an action and Dependabot offline, never complete where online audits apply', { skip }, async () => {
  const tree = capturedTree(join(root.root, `tree-${n++}`), ZIZMOR_LAYOUT);
  const u = unit(`w-ci-${n}`, 'web', tree);
  const cs = checks(ZIZMOR_SUPPORTED_RULES[0]!.familyId, 'ci-config', 'web', tree.map(t => t.relativePath));
  const r = await execute(service, driver('ci-zizmor'), prepareContext(shippedRules('ci').rules, u, cs, tree, root.root), `att-dci-${n++}`);
  assert.equal(r.outcome.state, 'succeeded');
  assert.deepEqual(verdicts(r.result, cs), {
    'web:.github/workflows/triage.yml': 'ran:offlineDegraded,onlineAuditsSkipped', 'web:.github/workflows/build.yaml': 'ran:offlineDegraded,onlineAuditsSkipped',
    'web:.github/workflows/broken.yml': 'not-run:notAudited', 'web:.github/workflows/notes.yml': 'not-run:notAudited',
    'web:.github/actions/setup/action.yml': 'ran:offlineDegraded,onlineAuditsSkipped', 'web:.github/dependabot.yml': 'ran',
    'web:services/api/.github/workflows/ci.yml': 'ran:offlineDegraded,onlineAuditsSkipped',
  });
});
