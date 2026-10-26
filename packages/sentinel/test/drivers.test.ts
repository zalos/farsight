import { scannerKernels } from '../dist/adapters/drivers/kernels.js';
// The production check drivers without an engine: each supports exactly the shipped original rules (pinned by
// digest), refuses every other rule before anything runs, and records why each check is not run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PATTERN_SUPPORTED_RULES,
  OSV_SUPPORTED_RULES,
  TRIVY_SUPPORTED_RULES,
  ZIZMOR_SUPPORTED_RULES,
  DRIVER_REASONS,
} from '../dist/adapters/drivers/index.js';
import { STRINGS } from '@farsight/core/dist/strings.js';
import { checks, prepareContext, sha, shippedRules, unit, verdicts } from './driver-helpers.ts';
import { capturedTree, IAC_FIXTURES } from './iac-helpers.ts';

function scratch(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'sentinel-drivers-'));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const drivers = scannerKernels({ maxAdvisoryAgeMs: 7 * 86_400_000 });
const driver = (id: string) => drivers.get(id)!.driver;

test('each driver supports exactly the rules of its shipped original pack, at their exact definition digests', () => {
  for (const [pack, supported] of [
    ['pattern', PATTERN_SUPPORTED_RULES],
    ['advisories', OSV_SUPPORTED_RULES],
    ['infrastructure', TRIVY_SUPPORTED_RULES],
    ['ci', ZIZMOR_SUPPORTED_RULES],
  ] as const) {
    const { pack: p } = shippedRules(pack);
    assert.deepEqual(
      [...supported].map((r) => `${r.familyId}@${r.revision} ${r.definitionDigest}`).sort(),
      p.entry.rules.map((r: any) => `${r.familyId}@${r.revision} ${r.definitionDigest}`).sort(),
      pack,
    );
    assert.equal(p.manifest.rights.origin, 'sentinel-original');
  }
  assert.deepEqual([...drivers.keys()].sort(), ['advisories-osv', 'ci-zizmor', 'iac-trivy', 'pattern-semgrep']);
  for (const [id, { definition, driver: d }] of drivers) {
    assert.equal(definition.id, id);
    assert.equal(d.adapterId, id);
  }
});

test('a custom or changed rule, another adapter’s rule or another scope kind never runs, and every check says why', async (t) => {
  const dir = scratch(t);
  const tree = capturedTree(join(dir, 'tree'), { 'src/a.ts': { text: 'db.query("SELECT " + id);\n' } });
  const u = unit('w-pattern', 'web', tree);
  const family = PATTERN_SUPPORTED_RULES.find(
    (r) => r.familyId.endsWith('tsjs') && r.familyId.includes('concatenated'),
  )!.familyId;
  const cs = checks(family, 'source-file', 'web', ['src/a.ts']);
  for (const [why, rules] of [
    [
      'changed bytes',
      shippedRules('pattern', { definitionDigest: sha('a promoted copy with other detector bytes') }).rules,
    ],
    ['another adapter', shippedRules('pattern', { adapterId: 'pattern-other' }).rules],
  ] as const) {
    const p = await driver('pattern-semgrep').prepare(prepareContext(rules, u, cs, tree, dir));
    assert.ok(p.skipRun, `${why}: nothing runs`);
    assert.deepEqual(verdicts(p.skipRun.result, cs), { 'web:src/a.ts': 'not-run:ruleUnsupported' }, why);
    assert.deepEqual(p.skipRun.result.coveredChecks, []);
  }
  const custom = {
    ...shippedRules('pattern').rules,
    pins: [
      {
        familyId: 'sentinel.custom.other-rule',
        revision: 1,
        definitionDigest: sha('x'),
        packDigest: sha('p'),
        adapterId: 'pattern-semgrep',
      },
    ],
  };
  const other = checks('sentinel.custom.other-rule', 'source-file', 'web', ['src/a.ts']);
  const p = await driver('pattern-semgrep').prepare(prepareContext(custom, u, other, tree, dir));
  assert.deepEqual(
    verdicts(p.skipRun.result, other),
    { 'web:src/a.ts': 'not-run:ruleUnsupported' },
    'a custom rule naming the adapter is not its rule',
  );
  const wrongScope = checks(family, 'repository', 'web', ['src/a.ts']);
  const s = await driver('pattern-semgrep').prepare(
    prepareContext(shippedRules('pattern').rules, u, wrongScope, tree, dir),
  );
  assert.deepEqual(verdicts(s.skipRun.result, wrongScope), { 'web:src/a.ts': 'not-run:scopeUnsupported' });
});

test('a pinned tool other than the engine’s image is refused', async (t) => {
  const dir = scratch(t);
  const tree = capturedTree(join(dir, 'tree'), { 'src/a.ts': { text: 'x\n' } });
  const ctx = prepareContext(
    shippedRules('pattern').rules,
    unit('w', 'web', tree),
    checks(PATTERN_SUPPORTED_RULES[0]!.familyId, 'source-file', 'web', ['src/a.ts']),
    tree,
    dir,
    { tools: [{ adapterId: 'pattern-semgrep', artifactDigest: sha('another image') }] },
  );
  await assert.rejects(
    driver('pattern-semgrep').prepare(ctx),
    (e: any) => e.code === 'sentinel.drivers.contextInvalid',
  );
});

test('no admitted advisory snapshot or checks bundle: nothing runs, each file not run for that reason', async (t) => {
  const dir = scratch(t);
  const lock = capturedTree(join(dir, 'lock'), { 'package-lock.json': 'trivy/k8s-not-a-manifest.fixture' });
  const osvChecks = checks(OSV_SUPPORTED_RULES[0]!.familyId, 'dependency-manifest', 'web', ['package-lock.json']);
  const o = await driver('advisories-osv').prepare(
    prepareContext(shippedRules('advisories').rules, unit('w-osv', 'web', lock), osvChecks, lock, dir),
  );
  assert.deepEqual(verdicts(o.skipRun.result, osvChecks), { 'web:package-lock.json': 'not-run:databaseMissing' });
  const iac = capturedTree(join(dir, 'iac'), { 'deploy/Dockerfile': 'trivy/dockerfile-root.fixture' });
  const trivyChecks = checks(TRIVY_SUPPORTED_RULES[0]!.familyId, 'infrastructure-config', 'web', ['deploy/Dockerfile']);
  const tr = await driver('iac-trivy').prepare(
    prepareContext(shippedRules('infrastructure').rules, unit('w-trivy', 'web', iac), trivyChecks, iac, dir),
  );
  assert.deepEqual(verdicts(tr.skipRun.result, trivyChecks), { 'web:deploy/Dockerfile': 'not-run:bundleMissing' });
  const ci = capturedTree(join(dir, 'ci'), { '.gitlab-ci.yml': { text: 'stages: [test]\n' } });
  const ciChecks = checks(ZIZMOR_SUPPORTED_RULES[0]!.familyId, 'ci-config', 'web', ['.gitlab-ci.yml']);
  const z = await driver('ci-zizmor').prepare(
    prepareContext(shippedRules('ci').rules, unit('w-ci', 'web', ci), ciChecks, ci, dir),
  );
  assert.deepEqual(
    verdicts(z.skipRun.result, ciChecks),
    { 'web:.gitlab-ci.yml': 'not-run:notCiConfiguration' },
    'zizmor does not read GitLab CI',
  );
  void IAC_FIXTURES;
});

test('every driver reason is a catalog word', () => {
  for (const code of [
    ...DRIVER_REASONS,
    'sentinel.drivers.contextInvalid',
    'sentinel.drivers.ruleBytesInvalid',
    'sentinel.drivers.rule.knownAdvisory',
    'sentinel.drivers.rule.workflowAudit',
    'sentinel.drivers.rule.misconfiguration',
    'sentinel.drivers.limitation.advisorySnapshot',
    'sentinel.drivers.limitation.onlineAudits',
    'sentinel.drivers.limitation.checksBundle',
  ]) {
    assert.ok(STRINGS[code]?.define, `${code} is in the catalog with a definition`);
  }
});

test('a check revision and the required unique tool pin must be exact', async (t) => {
  const dir = scratch(t);
  const tree = capturedTree(join(dir, 'tree'), { 'src/a.ts': { text: 'export const a = 1;\n' } });
  const rules = shippedRules('pattern').rules;
  const family = PATTERN_SUPPORTED_RULES[0]!.familyId;
  const cs = checks(family, 'source-file', 'web', ['src/a.ts']);
  const ctx = prepareContext(rules, unit('w', 'web', tree), cs, tree, dir);
  await assert.rejects(
    driver('pattern-semgrep').prepare({ ...ctx, tools: [] }),
    (e: any) => e.code === 'sentinel.drivers.contextInvalid',
  );
  await assert.rejects(
    driver('pattern-semgrep').prepare({ ...ctx, tools: [...ctx.tools, ...ctx.tools] }),
    (e: any) => e.code === 'sentinel.drivers.contextInvalid',
  );
  const changed = await driver('pattern-semgrep').prepare({
    ...ctx,
    checks: cs.map((c) => ({ ...c, ruleRevision: 2 })),
  });
  assert.ok(changed.skipRun);
  assert.deepEqual(changed.skipRun.result.coveredChecks, []);
});
