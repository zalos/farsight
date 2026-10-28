// The native command gate reuses the existing package/isolation selector union and exact adapter pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectChecks, detectChecks } from '../ci-changes.mjs';
import { suiteFiles } from '../sentinel-tests.mjs';
const root = new URL('../../', import.meta.url);
// The sentinel-service job runs Sentinel's process suite, the files packages/sentinel/test/process-suite.txt lists.
const processSuite = suiteFiles('process');
// Files that must never skip on CI: the process suite (sentinel-service) and the unit suite's no-skip group (validate).
const noSkipSuite = suiteFiles('no-skip');
const neverSkips = (file) => processSuite.includes(file) || noSkipSuite.includes(file);
const serviceJob = () => {
  const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
  const service = ci.slice(ci.indexOf('    name: sentinel-service'), ci.indexOf('\n  e2e:'));
  assert.ok(service.includes('node ../../scripts/sentinel-tests.mjs --suite process'), 'the job runs the listed suite');
  return service;
};
const workflow = readFileSync(new URL('.github/workflows/sentinel-scanner-cli.yml', root), 'utf8');
const selected = (paths) => {
  const checks = selectChecks(paths);
  return checks.sentinel || checks.isolation;
};
test('scanner CLI acceptance selects source, captured inputs, owner gates, packs, helpers, packaging and build dependencies', () => {
  for (const path of [
    'packages/sentinel/src/service/canonical.ts',
    'packages/sentinel/src/service/scanner-assets.ts',
    'packages/sentinel/src/policy/admission.ts',
    'packages/sentinel/src/adapters/drivers/canonical.ts',
    'packages/sentinel/rules/pattern/sentinel-pack.json',
    'packages/sentinel/test/cli-scanners-helpers.ts',
    'packages/sentinel/test/scanner-admission.test.ts',
    'packages/sentinel/README.md',
    'packages/core/src/strings-sentinel-cli.ts',
    'packages/code-parser/src/index.ts',
    'packages/graph/src/index.ts',
    'scripts/npm-consumer.mjs',
    'scripts/pack-sentinel.mjs',
    'scripts/test-sentinel-scanner-consumer.mjs',
    '.github/workflows/sentinel-scanner-cli.yml',
    'pnpm-lock.yaml',
    '.nvmrc',
  ])
    assert.equal(selected([path]), true, path);
  for (const path of ['docs/VISION.md', 'docs/CI.md', 'AGENTS.md', 'e2e/tests/chrome.pw.spec.ts'])
    assert.equal(selected([path]), false, path);
  assert.equal(
    selected(['docs/VISION.md', 'packages/sentinel/test/cli-scanners-e2e.test.ts']),
    true,
    'mixed inputs retain the gate',
  );
  const fallback = detectChecks({ base: undefined, head: undefined, event: 'pull_request' }).checks;
  assert.equal(fallback.sentinel || fallback.isolation, true, 'unavailable ranges fail closed');
});
test('workflow image indexes and native manifests exactly match all five adapter source pins', () => {
  const engines = [
    ['pattern', 'PATTERN'],
    ['osv', 'OSV'],
    ['trivy', 'TRIVY'],
    ['zizmor', 'ZIZMOR'],
    ['gitleaks', 'GITLEAKS'],
  ];
  for (const [id, prefix] of engines) {
    const source = readFileSync(new URL(`packages/sentinel/src/adapters/${id}/adapter.ts`, root), 'utf8');
    const image = /\bimage: '([^']+)'/.exec(source)?.[1];
    const manifest = /architecture: 'amd64'[\s\S]*?manifest: '([^']+)'/.exec(source)?.[1];
    assert.ok(image);
    assert.ok(manifest);
    assert.equal(new RegExp(`^      ${prefix}_INDEX: (.+)$`, 'm').exec(workflow)?.[1], image, id);
    assert.equal(new RegExp(`^      ${prefix}_AMD64: (.+)$`, 'm').exec(workflow)?.[1], manifest, id);
  }
  assert.equal(
    // eslint-disable-next-line no-regex-spaces -- Match the provisioning shell command's exact ten-space workflow indentation.
    (workflow.match(/^          check "\$[A-Z]+_INDEX" "\$[A-Z]+_AMD64"$/gm) ?? []).length,
    5,
    'each exact image is explicitly provisioned',
  );
});
test('selection failure cannot skip the native gate, and selected tests cannot silently skip or run empty', () => {
  assert.match(workflow, /if: \$\{\{ !cancelled\(\) && needs\.changes\.outputs\.run != 'false' \}\}/);
  assert.match(workflow, /SENTINEL_ISOLATION: '1'/);
  assert.match(workflow, /--test-concurrency=1/);
  for (const counter of ['skipped', 'fail', 'cancelled'])
    assert.ok(workflow.includes(`grep -qx '# ${counter} 0' scanner-cli.tap`));
  assert.ok(workflow.includes("grep -Eq '^# tests [1-9][0-9]*$' scanner-cli.tap"));
  assert.ok(workflow.includes('node scripts/test-sentinel-scanner-consumer.mjs | tee scanner-consumer.log'));
  assert.doesNotMatch(workflow, /continue-on-error|docker (?:system prune|rm)|pkill|killall/);
});

test('full-report native acceptance builds its context-ingestion dependency and retains every opted-in evidence suite', () => {
  assert.match(workflow, /pnpm --filter '@farsight\/sentinel\.\.\.' --filter '@farsight\/parsers\.\.\.' build/);
  assert.ok(workflow.includes('test/cli-full-report-e2e.test.ts'));
  for (const name of ['review', 'redaction-neighbors', 'short-production', 'exemptions'])
    assert.ok(workflow.includes(`test/sol-report-${name}.test.ts`), name);
  assert.ok(
    workflow.includes('test/report-redaction.test.ts'),
    'pure projection controls remain in the native union too',
  );
  for (const name of ['selected-rerun-containers', 'selected-rerun-secrets'])
    assert.ok(workflow.includes(`test/${name}.test.ts`), name);
});

test('framework inspection privacy and genuine installed delivery remain mandatory in native acceptance', () => {
  assert.ok(workflow.includes('test/framework-report-secrets.test.ts'));
  assert.ok(workflow.includes('node scripts/test-sentinel-framework-consumer.mjs'));
  assert.ok(workflow.includes('framework-delivery/clean.html'));
  assert.ok(workflow.includes('framework-delivery/secret.html'));
});

test('SDK run controls remain in the native service zero-skip list and installed package hook', () => {
  const service = serviceJob();
  for (const file of [
    'service-mcp-controls',
    'service-planned-pause',
    'preparation-seams',
    'preparation-admission',
    'preparation-receipt-admission',
    'preparation-journal',
    'preparation-profile',
    'preparation-service',
    'preparation-recovery',
    'preparation-publication-crash',
    'preparation-public',
  ])
    assert.ok(neverSkips(`test/${file}.test.ts`), `${file} runs where a skip fails CI`);
  // the ones that start the owner service or the CLI stay in the zero-skip native list
  for (const file of ['service-mcp-controls', 'service-planned-pause', 'preparation-service', 'preparation-public'])
    assert.ok(processSuite.includes(`test/${file}.test.ts`), file);
  for (const counter of ['skipped', 'fail', 'cancelled'])
    assert.ok(service.includes(`grep -qx '# ${counter} 0' service.tap`));
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  assert.ok(
    manifest.scripts['test:sentinel:package'].includes('&& node scripts/test-sentinel-mcp-controls-consumer.mjs'),
  );
  assert.ok(
    manifest.scripts['test:sentinel:package'].endsWith('&& node scripts/test-sentinel-preparation-consumer.mjs'),
  );
  assert.ok(workflow.includes('test/preparation-assets-native.test.ts'));
  assert.equal(selected(['scripts/test-sentinel-preparation-consumer.mjs']), true);
  assert.equal(
    selected(['scripts/test-sentinel-mcp-controls-consumer.mjs']),
    true,
    'changing the consumer selects package/native acceptance',
  );
});

test('accepted imports have a zero-skip genuine privacy gate and npm-only public owner consumer', () => {
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  assert.ok(manifest.scripts['test:sentinel:package'].includes('node scripts/test-sentinel-evidence-consumer.mjs'));
  assert.equal(selected(['scripts/test-sentinel-evidence-consumer.mjs']), true);
  assert.ok(workflow.includes('test/owner-decision-privacy.test.ts'));
  assert.ok(workflow.includes('test/evidence-privacy.test.ts'));
  assert.ok(workflow.includes('node scripts/test-sentinel-evidence-consumer.mjs | tee evidence-consumer.log'));
  assert.ok(workflow.includes(`grep -q '"nativePrivacy":true' evidence-consumer.log`));
});

test('structural paths retain installed workflow, native privacy and explicit offline browser gates', () => {
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
  assert.ok(manifest.scripts['test:sentinel:package'].includes('node scripts/test-sentinel-paths-consumer.mjs'));
  assert.equal(selected(['scripts/test-sentinel-paths-consumer.mjs']), true);
  assert.ok(workflow.includes('test/path-report-secrets.test.ts'));
  assert.ok(workflow.includes('node scripts/test-sentinel-paths-consumer.mjs | tee paths-consumer.log'));
  assert.ok(ci.includes('packages/sentinel/test/path-report-browser.test.ts'));
  for (const line of ['tests 1', 'pass 1', 'fail 0', 'cancelled 0', 'skipped 0'])
    assert.ok(ci.includes("grep -qx '# " + line + "' sentinel-paths-browser.tap"));
});

test('owner decisions retain installed command and native privacy acceptance', () => {
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  assert.ok(manifest.scripts['test:sentinel:package'].includes('node scripts/test-sentinel-decisions-consumer.mjs'));
  assert.equal(selected(['scripts/test-sentinel-decisions-consumer.mjs']), true);
  assert.ok(workflow.includes('test/owner-decision-privacy.test.ts'));
  assert.ok(workflow.includes('node scripts/test-sentinel-decisions-consumer.mjs | tee decisions-consumer.log'));
  assert.ok(workflow.includes(`grep -q '"nativePrivacy":true' decisions-consumer.log`));
});

// Browser checks use the already provisioned e2e browser, while pure validate never launches one.
test('owner UI service and installed browser acceptance stay explicitly selected with no skips', () => {
  const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
  serviceJob();
  for (const name of ['session', 'host', 'descriptor', 'service', 'model-start', 'lifecycle', 'process'])
    assert.ok(neverSkips(`test/owner-ui-${name}.test.ts`), name);
  for (const name of ['service', 'lifecycle']) assert.ok(processSuite.includes(`test/owner-ui-${name}.test.ts`), name);
  assert.ok(ci.includes("SENTINEL_OWNER_UI_BROWSER: '1'"));
  assert.ok(ci.includes('packages/sentinel/test/owner-ui-browser.test.ts'));
  assert.ok(ci.includes("grep -q '^# skipped 0$' sentinel-owner-ui.tap"));
  assert.ok(ci.includes('node scripts/test-sentinel-owner-ui-consumer.mjs'));
  const source = readFileSync(new URL('scripts/test-sentinel-owner-ui-consumer.mjs', root), 'utf8');
  assert.ok(source.includes('npmConsumer('));
  assert.doesNotMatch(source, /packages\/sentinel\/dist|from[\s]*['"](?:\.\.\/)?packages\//);
  assert.equal(selected(['scripts/test-sentinel-owner-ui-consumer.mjs']), true);
});

test("Sentinel's two suites partition its test files; validate runs the unit suite, sentinel-service the process suite", async () => {
  const { nodeArgs, parseArgs, processSuite: listed, sentinelDir } = await import('../sentinel-tests.mjs');
  const unit = suiteFiles('unit');
  const every = suiteFiles('all');
  assert.ok(processSuite.length >= 80, `${processSuite.length} files in the process suite`);
  assert.deepEqual([...unit, ...processSuite].sort(), every, 'every test file is in exactly one suite');
  assert.deepEqual(unit.slice(0, noSkipSuite.length), noSkipSuite, 'the unit suite runs its no-skip group first');
  assert.ok(!noSkipSuite.some((file) => processSuite.includes(file)), 'no file is in both lists');
  // the twelve in-process files that left sentinel-service's zero-skip list keep the guarantee in validate
  for (const name of [
    'owner-ui-descriptor',
    'owner-ui-host',
    'owner-ui-model-start',
    'owner-ui-process',
    'owner-ui-session',
    'preparation-admission',
    'preparation-journal',
    'preparation-profile',
    'preparation-receipt-admission',
    'service-policy',
    'store-read-budget',
    'trusted-profile',
  ])
    assert.ok(noSkipSuite.includes(`test/${name}.test.ts`), name);
  assert.equal(new Set([...unit, ...processSuite]).size, every.length);
  assert.deepEqual(listed(), processSuite);
  // the service job requires zero skips, so no Docker-gated file belongs in its suite; they stay in the unit suite
  for (const file of processSuite)
    assert.doesNotMatch(readFileSync(join(sentinelDir(), file), 'utf8'), /SENTINEL_ISOLATION/, file);

  const manifest = JSON.parse(readFileSync(new URL('packages/sentinel/package.json', root), 'utf8'));
  assert.equal(manifest.scripts.test, 'node ../../scripts/sentinel-tests.mjs', 'pnpm -r test runs both suites');
  assert.equal(manifest.scripts['test:unit'], 'node ../../scripts/sentinel-tests.mjs --suite unit');
  assert.equal(manifest.scripts['test:process'], 'node ../../scripts/sentinel-tests.mjs --suite process');
  const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
  const validate = ci.slice(ci.indexOf('    name: validate'), ci.indexOf('\n  # Required when selected'));
  assert.match(validate, /SENTINEL_TEST_SUITE: unit\n\s+run: node scripts\/ci-changes\.mjs --run-tests/);
  assert.match(serviceJob(), /if: \$\{\{ !cancelled\(\) && needs\.changes\.outputs\.service != 'false' \}\}/);

  assert.deepEqual(parseArgs([], {}), {
    suite: 'all',
    concurrency: undefined,
    list: false,
    launches: false,
    extra: [],
  });
  assert.equal(parseArgs(['--launches']).launches, true);
  assert.equal(parseArgs([], { SENTINEL_TEST_SUITE: 'unit' }).suite, 'unit');
  assert.equal(parseArgs(['--suite', 'process'], { SENTINEL_TEST_SUITE: 'unit' }).suite, 'process');
  assert.deepEqual(parseArgs(['--concurrency', '3', '--', '--test-timeout=1', '--test-reporter=tap']), {
    suite: 'all',
    concurrency: 3,
    list: false,
    launches: false,
    extra: ['--test-timeout=1', '--test-reporter=tap'],
  });
  assert.throws(() => parseArgs(['--suites', 'unit']), /Unknown option/);
  assert.throws(() => suiteFiles('units'), /Unknown suite/);
  assert.deepEqual(nodeArgs(['test/a.test.ts'], { concurrency: 4, extra: ['--test-timeout=9'] }), [
    '--disable-warning=ExperimentalWarning',
    '--experimental-strip-types',
    '--test',
    '--test-concurrency=4',
    '--test-timeout=9',
    'test/a.test.ts',
  ]);
  assert.deepEqual(nodeArgs(['test/a.test.ts'], { concurrency: 2, preload: 'file:///hook.mjs' }).slice(2, 5), [
    '--import',
    'file:///hook.mjs',
    '--test',
  ]);
  assert.throws(() => nodeArgs([], { concurrency: 0 }), /Bad concurrency/);
  assert.throws(() => nodeArgs([], { concurrency: Number('x') }), /Bad concurrency/);
});

test('the launch report counts Node.js and package-manager starts per test file, not git or other tools', async () => {
  const { launchCounts } = await import('../sentinel-tests.mjs');
  const log = [
    '/w/packages/sentinel/test/cli-rules.test.ts\tnode',
    '/w/packages/sentinel/test/cli-rules.test.ts\tnode',
    '/w/packages/sentinel/test/review-package.test.ts\tpnpm',
    '/w/packages/sentinel/test/review-package.test.ts\ttar',
    '/w/packages/sentinel/test/snapshot-capture.test.ts\tgit',
    '/w/packages/sentinel/test/imports-readers.test.ts\tmkfifo',
    'C:\\w\\packages\\sentinel\\test\\path-owner.test.ts\tnode',
    '\tnode',
    '',
  ].join('\n');
  assert.deepEqual(
    [...launchCounts(log)],
    [
      ['test/cli-rules.test.ts', 2],
      ['test/review-package.test.ts', 2],
      ['test/path-owner.test.ts', 1],
    ],
  );
});

test('the process suite list fails loudly: a missing file, a duplicate, a bad line or an empty list', async () => {
  const { processSuite: listed } = await import('../sentinel-tests.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'farsight-sentinel-suites-'));
  try {
    mkdirSync(join(dir, 'test'));
    for (const name of ['a', 'b']) writeFileSync(join(dir, 'test', `${name}.test.ts`), '');
    const list = (text) => writeFileSync(join(dir, 'test', 'process-suite.txt'), text);
    list('# header\n\ntest/a.test.ts\n  test/b.test.ts  \n');
    assert.deepEqual(listed(dir), ['test/a.test.ts', 'test/b.test.ts']);
    list('test/a.test.ts\ntest/gone.test.ts\n');
    assert.throws(() => listed(dir), /process-suite\.txt:2: no such file: test\/gone\.test\.ts/);
    list('test/a.test.ts\ntest/a.test.ts\n');
    assert.throws(() => listed(dir), /process-suite\.txt:2: listed twice/);
    list('test/a.test.ts --test-only\n');
    assert.throws(() => listed(dir), /not a test\/<name>\.test\.ts path/);
    list('../other/test/a.test.ts\n');
    assert.throws(() => listed(dir), /not a test\/<name>\.test\.ts path/);
    list('# only a comment\n');
    assert.throws(() => listed(dir), /lists no files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the unit suite fails when a no-skip file skips, and the rest of it may skip', async () => {
  const { noSkipSuite: listedNoSkip, runSuite, suiteGroups, tapSkips } = await import('../sentinel-tests.mjs');
  assert.deepEqual(tapSkips('TAP version 13\n# tests 3\n# skipped 1\n# todo 0\n'), { skipped: 1, todo: 0 });
  assert.deepEqual(tapSkips('# skipped 0\n# todo 0\n'), { skipped: 0, todo: 0 });
  assert.equal(tapSkips('# tests 3\n'), null, 'no summary is not a pass');
  const dir = mkdtempSync(join(tmpdir(), 'farsight-sentinel-noskip-'));
  try {
    mkdirSync(join(dir, 'test'));
    const write = (name, text) => writeFileSync(join(dir, 'test', name), text);
    write('passes.test.ts', "import { test } from 'node:test';\ntest('passes', () => {});\n");
    write('skips.test.ts', "import { test } from 'node:test';\ntest('skips', { skip: 'by design' }, () => {});\n");
    write('process.test.ts', "import { test } from 'node:test';\ntest('a process file', () => {});\n");
    write('process-suite.txt', 'test/process.test.ts\n');
    write('no-skip-suite.txt', 'test/process.test.ts\n');
    assert.throws(() => listedNoSkip(dir), /lists process-suite files: test\/process\.test\.ts/);
    write('no-skip-suite.txt', '# guarded\ntest/passes.test.ts\n');
    assert.deepEqual(
      suiteGroups('unit', dir).map(({ files, noSkips }) => [files, noSkips]),
      [
        [['test/passes.test.ts'], true],
        [['test/skips.test.ts'], false],
      ],
    );
    const errors = [];
    const run = () =>
      runSuite({ suite: 'unit', concurrency: 2 }, { dir, out: () => {}, err: (m) => errors.push(m), stdio: 'ignore' });
    assert.equal(run(), 0, 'a skip outside the no-skip group is allowed');
    assert.deepEqual(errors, []);
    write('no-skip-suite.txt', 'test/passes.test.ts\ntest/skips.test.ts\n');
    assert.equal(run(), 1, 'a skip in the no-skip group fails the suite');
    assert.match(errors.join('\n'), /no-skip files must not skip \(no-skip-suite\.txt\): 1 skipped, 0 todo/);
    assert.equal(
      runSuite({ suite: 'no-skip', concurrency: 2 }, { dir, out: () => {}, err: () => {}, stdio: 'ignore' }),
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
