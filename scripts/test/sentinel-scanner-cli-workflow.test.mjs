// The native command gate runs for the selector's scanner closure (scannerCli), with exact adapter pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computedLoadSites, scannerCliClosure, scannerLoadsText, selectChecks, detectChecks } from '../ci-changes.mjs';
import { suiteFiles } from '../sentinel-tests.mjs';
import { CONSUMERS } from '../test-sentinel-consumers.mjs';
// pnpm test:sentinel:package packs once and runs every installed consumer through the parallel runner.
const packageConsumer = (name) => {
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  assert.equal(
    manifest.scripts['test:sentinel:package'],
    'pnpm pack:sentinel && node scripts/test-sentinel-consumers.mjs',
  );
  return CONSUMERS.includes(name);
};
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
const selected = (paths) => selectChecks(paths).scannerCli;
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
  assert.equal(fallback.scannerCli, true, 'unavailable ranges fail closed');
  assert.match(
    workflow,
    /const run = process\.env\.GITHUB_EVENT_NAME === 'workflow_dispatch' \|\| checks\.scannerCli;/,
  );
});

test('the scanner workflow runs for what its steps execute: review dispatch and the owner service included', () => {
  // the scanner tests call publicRegistry(), which reads the review adapters through review/dispatch; the installed
  // consumer starts the owner service, which builds the owner UI operations
  for (const path of [
    'packages/sentinel/src/review/dispatch.ts',
    'packages/sentinel/src/service/review-adapter.ts',
    'packages/sentinel/src/owner-ui/operations.ts',
    'packages/sentinel/src/execution/coordinator.ts',
    'packages/sentinel/src/reports/html.ts',
    'packages/sentinel/src/findings/compare.ts',
    'packages/sentinel/src/kernel/digest.ts',
    'packages/sentinel/test/evidence-privacy.test.ts',
    'packages/sentinel/test/fixtures/workers/hostile-worker.mjs',
    'packages/sentinel/test/fixtures/advisories/README.md',
    'packages/core/src/counts.ts',
    'packages/code-parser/src/tsjs.ts',
    'packages/code-parser/src/java/index.ts',
    'packages/parsers/src/tsjs.ts',
    'examples/invoice-app/screens.json',
    'scripts/test-sentinel-evidence-consumer.mjs',
    'scripts/sentinel-evidence-provenance.mjs',
    // reached through the packer's and consumers' literal loads: the asset hooks, core's build identity, the
    // installed framework driver and the evidence consumer's private hooks
    'packages/sentinel/scripts/package-assets-drivers.mjs',
    'packages/core/src/version.ts',
    'packages/sentinel/src/frameworks/controls/driver.ts',
    'packages/sentinel/src/evidence/test-hooks.ts',
    // in the area of a load the walk cannot follow: Sentinel's sources and scripts (its Trivy checks script, its asset
    // hooks and the framework controls closure import computed paths) and its test fixtures (the test helpers' workers)
    'packages/sentinel/src/review/evaluation.ts',
    'packages/sentinel/src/review/providers/owner.ts',
    'packages/sentinel/test/fixtures/model-review/a.json',
  ])
    assert.equal(selected([path]), true, path);
  // what no step runs or imports: test files the workflow does not run, another package's tests, sources and scripts
  // no step loads (the parsers' files nothing imports, the release and e2e scripts), the viewer, the server, the CLI
  // and Echo, and the other examples
  for (const path of [
    'packages/parsers/src/lifecycle.ts',
    'scripts/test-sentinel-package.mjs',
    'scripts/release.mjs',
    'scripts/pack-echo.mjs',
    'scripts/test/release.test.mjs',
    'packages/sentinel/test/review-packs.test.ts',
    'packages/sentinel/test/cli-copilot-native.test.ts',
    'packages/sentinel/test/owner-ui-browser.test.ts',
    'packages/parsers/test/tsjs.test.ts',
    'packages/server/public/app/surfaces/sentinel.js',
    'packages/server/src/index.ts',
    'packages/cli/src/cli.ts',
    'packages/echo/src/cli.ts',
    'examples/nx-workspace/package.json',
  ])
    assert.equal(selected([path]), false, path);
  assert.equal(selected(['packages/server/src/index.ts', 'packages/sentinel/src/execution/x.ts']), true);
});

test("the scanner closure is derived from the workflow's steps and their imports, not a list of folders", () => {
  const closure = scannerCliClosure();
  // the entries the steps name: the tests they run, the scripts, the packer and the package's command
  for (const file of [
    'packages/sentinel/test/cli-scanners-e2e.test.ts',
    'scripts/test-sentinel-scanner-consumer.mjs',
    'scripts/pack-sentinel.mjs',
    'packages/sentinel/src/cli.ts',
  ])
    assert.ok(closure.files.has(file), file);
  // reached through workspace exports, the published name, and dist paths named as strings (workers and gates)
  for (const file of [
    'packages/code-parser/src/support.ts',
    'packages/sentinel/src/reports/index.ts',
    'packages/sentinel/src/execution/launch-gate.ts',
  ])
    assert.ok(closure.files.has(file), file);
  assert.ok(closure.dirs.has('examples/invoice-app'), 'the example application the full-report tests ingest');
  assert.ok(![...closure.dirs].some((dir) => /^packages\/[^/]+$/.test(dir)), 'a package root is a base path, not data');
  assert.deepEqual([...closure.packages].sort(), ['code-parser', 'core', 'graph', 'parsers', 'sentinel']);
  // more than the five folders the build step names: the closure is files, so it is wider in places and narrower
  assert.ok(closure.files.size > 400 && closure.files.size < 700, String(closure.files.size));

  const empty = mkdtempSync(join(tmpdir(), 'farsight-scanner-closure-'));
  try {
    assert.throws(() => scannerCliClosure(empty), /ENOENT/);
    const checks = selectChecks(['docs/VISION.md'], {
      root: empty,
      packageInputs: new Set(),
      isolationInputs: new Set(),
    });
    assert.equal(checks.scannerCli, true, 'an unreadable workflow selects every check');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
test('the load detector reads a computed load across lines, generated code included, and nothing else', () => {
  const sites = (text) => computedLoadSites(text).map(({ line, expression }) => [line, expression]);
  // computed, each on one line or split over several
  assert.deepEqual(sites('const u = new URL(`../dist/${p}`, import.meta.url);'), [[1, '`../dist/${p}`']]);
  assert.deepEqual(sites('const a = 1;\nconst u = new URL(\n  `../dist/${p}`,\n  import.meta.url,\n);\n'), [
    [2, '`../dist/${p}`'],
  ]);
  assert.deepEqual(sites('await import(\n  join(dir, name),\n);'), [[1, 'join(dir, name)']]);
  assert.deepEqual(sites('const m = require(\n  name\n);'), [[1, 'name']]);
  assert.deepEqual(sites('require.resolve(spec)'), [[1, 'spec']]);
  // generated in a template: a dynamic import, a static import and a bare one, wrappers taken off
  assert.deepEqual(
    sites(
      'const code = `import {a} from ${JSON.stringify(first)};\\nimport ${JSON.stringify(second)};\\nawait import(${JSON.stringify("file://" + third)});`;',
    ),
    [
      [1, 'first'],
      [1, 'second'],
      [1, 'third'],
    ],
  );
  // a brace that does not close is still a load, with no expression to resolve
  assert.deepEqual(sites('await import(join(a, b'), [[1, null]]);
  // not loads: literals the walk follows (one line or several), a URL with another base, prose, comments
  for (const text of [
    "await import('./x.js');",
    "new URL(\n  '../dist/x.js',\n  import.meta.url\n);",
    'new URL(path, base);',
    'const words = `accepted report import ${digest}`;',
    'const words = `an integer from ${min} to ${max}`;',
    'a lazy `import()` in a description',
    '// await import(name)',
    ' * await import(name)',
  ])
    assert.deepEqual(sites(text), [], text);
});

test('a computed load whose target is one literal is followed, not given an area', () => {
  const fake = mkdtempSync(join(tmpdir(), 'farsight-scanner-literal-'));
  const write = (path, text) => {
    mkdirSync(join(fake, path, '..'), { recursive: true });
    writeFileSync(join(fake, path), text);
  };
  const manifest = (name) => JSON.stringify({ name, version: '0.0.0', main: './dist/index.js' });
  try {
    write('.github/workflows/sentinel-scanner-cli.yml', 'run: node scripts/consumer.mjs\n');
    write('packages/sentinel/package.json', manifest('@farsight/sentinel'));
    write('packages/parsers/package.json', manifest('@farsight/parsers'));
    for (const name of ['index', 'url-target', 'driver', 'unreached'])
      write(`packages/sentinel/src/${name}.ts`, 'export {};\n');
    write(
      'scripts/consumer.mjs',
      [
        // a URL against the module, wrapped
        "await import(pathToFileURL(fileURLToPath(new URL('../packages/sentinel/dist/url-target.js', import.meta.url))).href);",
        "await import(new URL('../packages/sentinel/dist/index.js', import.meta.url).href);",
        // a resolved specifier (a third party: nothing in the repository)
        "await import(pathToFileURL(require.resolve('some-sdk/client.js')).href);",
        // a file of the installed tarball by its dist/ path, in generated code
        'const code = `await import(${JSON.stringify("file://" + join(installed, "dist/driver.mjs"))});`;',
        // a module this script writes from a literal
        "writeFileSync(join(c.dir, 'public.mjs'), \"export * from 'farsight-sentinel';\\n\");",
        "await import(pathToFileURL(join(c.dir, 'public.mjs')).href);",
      ].join('\n'),
    );
    const closure = scannerCliClosure(fake);
    assert.deepEqual(closure.unresolved, [], 'every load names its target');
    for (const file of ['url-target', 'index', 'driver'])
      assert.ok(closure.files.has(`packages/sentinel/src/${file}.ts`), file);
    assert.ok(!closure.files.has('packages/sentinel/src/unreached.ts'));
    const reaches = (path) =>
      selectChecks([path], { root: fake, packageInputs: new Set(), isolationInputs: new Set(), scannerInputs: closure })
        .scannerCli;
    assert.equal(reaches('packages/sentinel/src/unreached.ts'), false, 'no area: an unreached source stays out');

    // the same script writing a different module than it loads, or loading a dist/ file no package has, gets an area
    write(
      'scripts/consumer.mjs',
      "writeFileSync(join(c.dir, 'other.mjs'), '');\nawait import(pathToFileURL(join(c.dir, 'public.mjs')).href);\nawait import(pathToFileURL(join(installed, 'dist/chunks/x.mjs')).href);\n",
    );
    assert.deepEqual(
      scannerCliClosure(fake).unresolved.map(({ site }) => site),
      ['scripts/consumer.mjs:2', 'scripts/consumer.mjs:3'],
    );
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
});

test('a load the walk cannot follow selects its whole area and is listed with its importer', () => {
  const fake = mkdtempSync(join(tmpdir(), 'farsight-scanner-computed-'));
  const write = (path, text) => {
    mkdirSync(join(fake, path, '..'), { recursive: true });
    writeFileSync(join(fake, path), text);
  };
  const manifest = (name) => JSON.stringify({ name, version: '0.0.0', main: './dist/index.js' });
  const closureOf = (test) => {
    write('.github/workflows/sentinel-scanner-cli.yml', 'run: node --test test/scan.test.ts\n');
    write('packages/sentinel/package.json', manifest('@farsight/sentinel'));
    write('packages/parsers/package.json', manifest('@farsight/parsers'));
    write('packages/sentinel/src/index.ts', 'export {};\n');
    write('packages/sentinel/src/hidden.ts', 'export const hidden = true;\n');
    write('packages/server/src/index.ts', 'export {};\n');
    write('packages/sentinel/test/scan.test.ts', test);
    return scannerCliClosure(fake);
  };
  const reaches = (closure, path) =>
    selectChecks([path], { root: fake, packageInputs: new Set(), isolationInputs: new Set(), scannerInputs: closure })
      .scannerCli;
  try {
    // hidden.ts is reached only through an import whose path is built from a variable
    const computed = closureOf("const name = 'hidden';\nawait import(`../dist/${name}.js`);\n");
    assert.ok(!computed.files.has('packages/sentinel/src/hidden.ts'), 'the walk cannot follow it');
    assert.deepEqual(computed.unresolved, [
      {
        site: 'packages/sentinel/test/scan.test.ts:2',
        area: ['packages/sentinel/src/', 'packages/sentinel/test/fixtures/'],
      },
    ]);
    assert.equal(reaches(computed, 'packages/sentinel/src/hidden.ts'), true, 'an edit to it selects the workflow');
    assert.equal(reaches(computed, 'packages/server/src/index.ts'), false, 'outside the area');
    assert.match(scannerLoadsText(computed.unresolved), /packages\/sentinel\/test\/scan\.test\.ts:2 select /);

    // the same test with a literal import: nothing is unresolved, and hidden.ts is outside the closure
    const literal = closureOf("await import('../dist/index.js');\n// await import(`${name}`) in a comment\n");
    assert.deepEqual(literal.unresolved, []);
    assert.equal(reaches(literal, 'packages/sentinel/src/hidden.ts'), false);
    assert.equal(scannerLoadsText(literal.unresolved), '- sentinel-scanner-cli: no computed loads in its closure');
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
  // the real closure lists the loads its steps make today, by importer and line, the Trivy checks script among them
  const { unresolved } = scannerCliClosure();
  const trivy = unresolved.find(({ site }) => site.startsWith('packages/sentinel/scripts/acquire-trivy-checks.mjs:'));
  assert.deepEqual(trivy?.area, ['packages/sentinel/src/', 'packages/sentinel/scripts/']);
  // no root script loads a computed path any more: the packer's and consumers' loads are literal
  assert.deepEqual(
    unresolved.filter(({ site }) => site.startsWith('scripts/')),
    [],
  );
  const { scannerLoads } = detectChecks({ base: undefined, head: undefined, event: 'pull_request' });
  assert.deepEqual(scannerLoads, [], 'an unavailable range selects every check and lists nothing');
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
    assert.ok(service.includes(`grep -qx '# ${counter} 0' service-summary.txt`));
  assert.ok(packageConsumer('test-sentinel-mcp-controls-consumer'));
  assert.ok(packageConsumer('test-sentinel-preparation-consumer'));
  assert.ok(workflow.includes('test/preparation-assets-native.test.ts'));
  assert.equal(selected(['scripts/test-sentinel-preparation-consumer.mjs']), true);
  assert.equal(
    selected(['scripts/test-sentinel-mcp-controls-consumer.mjs']),
    true,
    'changing the consumer selects package/native acceptance',
  );
});

test('accepted imports have a zero-skip genuine privacy gate and npm-only public owner consumer', () => {
  assert.ok(packageConsumer('test-sentinel-evidence-consumer'));
  assert.equal(selected(['scripts/test-sentinel-evidence-consumer.mjs']), true);
  assert.ok(workflow.includes('test/owner-decision-privacy.test.ts'));
  assert.ok(workflow.includes('test/evidence-privacy.test.ts'));
  assert.ok(workflow.includes('node scripts/test-sentinel-evidence-consumer.mjs | tee evidence-consumer.log'));
  assert.ok(workflow.includes(`grep -q '"nativePrivacy":true' evidence-consumer.log`));
});

test('structural paths retain installed workflow, native privacy and explicit offline browser gates', () => {
  const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
  assert.ok(packageConsumer('test-sentinel-paths-consumer'));
  assert.equal(selected(['scripts/test-sentinel-paths-consumer.mjs']), true);
  assert.ok(workflow.includes('test/path-report-secrets.test.ts'));
  assert.ok(workflow.includes('node scripts/test-sentinel-paths-consumer.mjs | tee paths-consumer.log'));
  assert.ok(ci.includes('packages/sentinel/test/path-report-browser.test.ts'));
  for (const line of ['tests 1', 'pass 1', 'fail 0', 'cancelled 0', 'skipped 0'])
    assert.ok(ci.includes("grep -qx '# " + line + "' sentinel-paths-browser.tap"));
});

test('owner decisions retain installed command and native privacy acceptance', () => {
  assert.ok(packageConsumer('test-sentinel-decisions-consumer'));
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
  // the files whose clock and SIGKILL races failed on CI at core-count concurrency run one at a time
  const { serialSuite } = await import('../sentinel-tests.mjs');
  for (const name of ['preparation-admission', 'preparation-publication-crash'])
    assert.ok(serialSuite().includes(`test/${name}.test.ts`), name);
  for (const file of serialSuite()) assert.ok(every.includes(file), file);
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
  assert.match(
    validate,
    /SENTINEL_TEST_SUITE: unit\n(?:\s+SENTINEL_TEST_LAUNCHES: .*\n)?\s+run: node scripts\/ci-changes\.mjs --run-tests/,
  );
  assert.match(serviceJob(), /if: \$\{\{ !cancelled\(\) && needs\.changes\.outputs\.service != 'false' \}\}/);

  assert.deepEqual(parseArgs([], {}), {
    suite: 'all',
    concurrency: undefined,
    list: false,
    launches: false,
    summary: undefined,
    extra: [],
  });
  assert.equal(parseArgs(['--summary', 'x.txt']).summary, 'x.txt');
  assert.equal(parseArgs(['--launches']).launches, true);
  assert.equal(parseArgs([], { SENTINEL_TEST_SUITE: 'unit' }).suite, 'unit');
  assert.equal(parseArgs(['--suite', 'process'], { SENTINEL_TEST_SUITE: 'unit' }).suite, 'process');
  assert.deepEqual(parseArgs(['--concurrency', '3', '--', '--test-timeout=1', '--test-reporter=tap']), {
    suite: 'all',
    concurrency: 3,
    list: false,
    launches: false,
    summary: undefined,
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

test('the launch rule: an unlisted unit launcher or an idle process file fails a passing run', async () => {
  const { launchVerdict, unitLaunchers, runSuite } = await import('../sentinel-tests.mjs');
  for (const file of unitLaunchers()) assert.ok(suiteFiles('unit').includes(file), `${file} is a unit file`);
  for (const name of ['store-integration', 'store-runtime', 'review-operation', 'service-full-report-authority'])
    assert.ok(unitLaunchers().includes(`test/${name}.test.ts`), name);
  assert.ok(unitLaunchers().includes('test/review-packs.test.ts'), "#223's opted-in launcher is named");
  const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
  assert.match(ci, /SENTINEL_TEST_LAUNCHES: '1'/, 'validate enforces the rule over the unit suite');
  assert.match(serviceJob(), /--suite process --launches --summary service-summary\.txt/, 'and the service job');

  const dir = mkdtempSync(join(tmpdir(), 'farsight-sentinel-launches-'));
  try {
    mkdirSync(join(dir, 'test'));
    const write = (name, text) => writeFileSync(join(dir, 'test', name), text);
    const spawner =
      "import { test } from 'node:test';\nimport { execFileSync } from 'node:child_process';\n" +
      "test('starts node', () => { execFileSync(process.execPath, ['-e', '0']); });\n";
    const quiet = "import { test } from 'node:test';\ntest('in process', () => {});\n";
    write('launcher.test.ts', spawner);
    write('allowed.test.ts', spawner);
    write('listed.test.ts', spawner);
    write('plain.test.ts', quiet);
    write('process-suite.txt', 'test/listed.test.ts\n');
    write('no-skip-suite.txt', 'test/plain.test.ts\n');
    write('serial-suite.txt', '');
    write('unit-launchers.txt', 'test/allowed.test.ts\n');
    const counts = new Map([
      ['test/launcher.test.ts', 1],
      ['test/allowed.test.ts', 1],
    ]);
    const verdict = launchVerdict(
      counts,
      ['test/launcher.test.ts', 'test/allowed.test.ts', 'test/listed.test.ts'],
      dir,
    );
    assert.deepEqual([verdict.unlisted, verdict.idle], [['test/launcher.test.ts'], ['test/listed.test.ts']]);
    const errors = [];
    const run = (suite) =>
      runSuite(
        { suite, concurrency: 2, launches: true },
        { dir, out: () => {}, err: (m) => errors.push(m), stdio: 'ignore' },
      );
    assert.equal(run('unit'), 1, 'an unlisted launcher in the unit suite');
    assert.match(errors.join('\n'), /the process suite is out of date/);
    write('unit-launchers.txt', 'test/allowed.test.ts\ntest/launcher.test.ts\n');
    assert.equal(run('unit'), 0, 'every unit launcher is named');
    assert.equal(run('process'), 0, 'the listed file starts one');
    write('no-skip-suite.txt', 'test/allowed.test.ts\n');
    write('process-suite.txt', 'test/listed.test.ts\ntest/plain.test.ts\n');
    assert.equal(run('process'), 1, 'a process file that starts none');
    write('unit-launchers.txt', 'test/listed.test.ts\n');
    assert.throws(() => unitLaunchers(dir), /unit-launchers\.txt lists process-suite files: test\/listed\.test\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  const {
    noSkipSuite: listedNoSkip,
    runSuite,
    suiteGroups,
    summaryText,
    tapCounts,
    tapSkips,
  } = await import('../sentinel-tests.mjs');
  const tap = (skipped, fail = 0) =>
    `TAP version 13\n# tests 3\n# suites 0\n# pass ${3 - skipped - fail}\n# fail ${fail}\n# cancelled 0\n` +
    `# skipped ${skipped}\n# todo 0\n# duration_ms 5\n`;
  assert.deepEqual(tapSkips(tap(1)), { skipped: 1, todo: 0 });
  assert.deepEqual(tapSkips(tap(0)), { skipped: 0, todo: 0 });
  assert.equal(tapSkips('# tests 3\n# skipped 0\n'), null, 'a partial summary is not a pass');
  assert.equal(
    summaryText([tapCounts(tap(0)), tapCounts(tap(1, 1))]),
    '# tests 6\n# suites 0\n# pass 4\n# fail 1\n# cancelled 0\n# skipped 1\n# todo 0\n',
    'a summary sums every run, so one grep line covers the serial and the parallel run',
  );
  const dir = mkdtempSync(join(tmpdir(), 'farsight-sentinel-noskip-'));
  try {
    mkdirSync(join(dir, 'test'));
    const write = (name, text) => writeFileSync(join(dir, 'test', name), text);
    write('passes.test.ts', "import { test } from 'node:test';\ntest('passes', () => {});\n");
    write('skips.test.ts', "import { test } from 'node:test';\ntest('skips', { skip: 'by design' }, () => {});\n");
    write('process.test.ts', "import { test } from 'node:test';\ntest('a process file', () => {});\n");
    write('process-suite.txt', 'test/process.test.ts\n');
    write('serial-suite.txt', '# none yet\n');
    write('no-skip-suite.txt', 'test/process.test.ts\n');
    assert.throws(() => listedNoSkip(dir), /lists process-suite files: test\/process\.test\.ts/);
    write('no-skip-suite.txt', '# guarded\ntest/passes.test.ts\n');
    assert.deepEqual(
      suiteGroups('unit', dir).map(({ files, noSkips, serial }) => [files, noSkips, serial]),
      [
        [[], true, true],
        [['test/passes.test.ts'], true, false],
        [[], false, true],
        [['test/skips.test.ts'], false, false],
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

    // the serial files run first, one at a time, in whichever group they belong to; the summary sums every run
    write('no-skip-suite.txt', 'test/passes.test.ts\n');
    write('serial-suite.txt', 'test/passes.test.ts\ntest/process.test.ts\n');
    assert.deepEqual(
      suiteGroups('process', dir).map(({ files, noSkips, serial }) => [files, noSkips, serial]),
      [
        [['test/process.test.ts'], true, true],
        [[], true, false],
      ],
      'the process suite runs its serial files first and refuses skips',
    );
    const lines = [];
    const summary = join(dir, 'summary.txt');
    const quiet = { dir, out: (m) => lines.push(m), err: () => {}, stdio: 'ignore' };
    assert.equal(runSuite({ suite: 'unit', concurrency: 3, summary }, quiet), 0);
    assert.deepEqual(lines, [
      'Sentinel unit suite, no-skip files, serial: 1 files, --test-concurrency=1',
      'Sentinel unit suite, the rest: 1 files, --test-concurrency=3',
    ]);
    assert.equal(
      readFileSync(summary, 'utf8'),
      '# tests 2\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n',
      'the serial run and the parallel run are summed',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
