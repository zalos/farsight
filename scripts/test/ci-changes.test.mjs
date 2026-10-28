import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  OUTSIDE_VALIDATE,
  changedPaths,
  detectChecks,
  selectChecks,
  selectTests,
  sentinelIsolationInputs,
  sentinelPackageInputs,
  testReach,
  workspaceGraph,
} from '../ci-changes.mjs';
import { buildClosure } from '../pack-preflight.mjs';

const none = { validate: false, e2e: false, echo: false, sentinel: false, isolation: false, recovery: false };
const full = { validate: true, e2e: true, echo: true, sentinel: true, isolation: true, recovery: true };
const every = { base: '', also: [], packages: [] };
const BASE = 'a'.repeat(40);
const repoRoot = new URL('../../', import.meta.url).pathname;

test('ordinary docs skip runtime checks; packaged docs still check their tarball', () => {
  assert.deepEqual(
    selectChecks([
      'README.md',
      'docs/research/analysis-core-options-2026-10-17.md',
      'docs/ARCHITECTURE.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
      '.claude/agents/review-example.md',
    ]),
    none,
  );
  // the two skills trees are checked against each other, so an edit to either runs the script tests
  assert.deepEqual(selectChecks(['.claude/skills/example/SKILL.md']), { ...none, validate: true });
  assert.deepEqual(selectChecks(['.agents/skills/example/references/x.md']), { ...none, validate: true });
  assert.deepEqual(selectChecks(['docs/ECHO.md', 'packages/echo/README.md']), { ...none, echo: true });
});

test('e2e and unit test changes select their own check; mixed edits take the union', () => {
  assert.deepEqual(selectChecks(['e2e/tests/chrome.pw.spec.ts', 'scripts/e2e.mjs']), { ...none, e2e: true });
  assert.deepEqual(
    selectChecks(['scripts/synth-graph.mjs']),
    { ...none, e2e: true, validate: true },
    "the perf suite's synthetic workspace is also imported by the server's unit tests",
  );
  assert.deepEqual(selectChecks(['packages/core/test/coverage.test.ts', 'scripts/test/release.test.mjs']), {
    ...none,
    validate: true,
  });
  assert.deepEqual(selectChecks(['docs/CI.md', 'scripts/release.mjs', 'e2e/fixture/serve.mjs']), {
    ...none,
    validate: true,
    e2e: true,
  });
});

test('runtime, fixtures and shared build inputs retain their affected checks', () => {
  for (const path of [
    'packages/app/src/index.ts',
    'examples/nx-workspace/package.json',
    'schemas/farsight-affected-v1.schema.json',
  ]) {
    assert.deepEqual(selectChecks([path]), { ...none, validate: true, e2e: true }, path);
  }
  for (const path of [
    'packages/server/public/app/main.js',
    'packages/cli/src/cli.ts',
    'packages/mcp/src/run.ts',
    'packages/parsers/src/tsjs.ts',
    'packages/parsers/package.json',
    'packages/work/src/gate.ts',
    'packages/work-fixture/src/index.ts',
    'packages/work-jira/package.json',
    'packages/work-azdo/src/index.ts',
    'examples/invoice-app/docs/flow.md',
  ]) {
    assert.deepEqual(selectChecks([path]), { ...none, validate: true, e2e: true, sentinel: true }, path);
  }
  for (const path of [
    'packages/graph/src/graph.ts',
    'packages/core/src/graph.ts',
    'packages/core/package.json',
    'pnpm-lock.yaml',
    'package.json',
    'pnpm-workspace.yaml',
    '.nvmrc',
    '.github/workflows/ci.yml',
    'scripts/ci-changes.mjs',
    'new-build-input.json',
    'docs/fixture.json',
  ]) {
    assert.deepEqual(selectChecks([path]), full, path);
  }
  assert.deepEqual(
    selectChecks(['packages/code-parser/src/tsjs.ts']),
    { ...none, validate: true, e2e: true, sentinel: true, isolation: true, recovery: true },
    'the public parser now belongs to Sentinel’s own build closure',
  );
  assert.deepEqual(selectChecks(['scripts/pack-echo.mjs']), { ...none, echo: true });
  for (const path of [
    'scripts/pack.mjs',
    'scripts/pack-preflight.mjs',
    'scripts/npm-consumer.mjs',
    'scripts/test-farsight-package.mjs',
    'scripts/test-farsight-package-absent.mjs',
  ]) {
    assert.deepEqual(selectChecks([path]), full, `${path} is shared packaging`);
  }
});

test('the release scripts select their own checks: the acceptance runs in sentinel-package, the rest are script tests', () => {
  assert.deepEqual(selectChecks(['scripts/npm-acceptance.mjs']), { ...none, validate: true, sentinel: true });
  for (const path of [
    'scripts/release-manifest.mjs',
    'scripts/verify-release.mjs',
    'scripts/release.mjs',
    'scripts/changelog.mjs',
  ]) {
    assert.deepEqual(selectChecks([path]), { ...none, validate: true }, path);
  }
  assert.deepEqual(
    selectChecks(['scripts/test/helpers/acceptance-standins.mjs']),
    { ...none, validate: true },
    'a test helper is a script test',
  );
  for (const path of [
    '.github/workflows/release.yml',
    '.github/workflows/publish.yml',
    '.github/workflows/verify-release.yml',
  ]) {
    assert.deepEqual(selectChecks([path]), full, `${path} is a workflow`);
  }
});

test("every package in farsight-cli's real build closure selects sentinel-package", () => {
  const closure = buildClosure(process.cwd(), '@farsight/cli').closure.map((p) => p.dir.split('/').pop());
  assert.ok(closure.length >= 10 && closure.includes('parsers') && closure.includes('work-azdo'), closure.join(', '));
  const inputs = sentinelPackageInputs();
  for (const dir of closure) {
    assert.ok(inputs.has(dir), dir);
    assert.equal(selectChecks([`packages/${dir}/src/x.ts`]).sentinel, true, dir);
    assert.equal(selectChecks([`packages/${dir}/package.json`]).sentinel, true, dir);
  }
  assert.ok(!inputs.has('echo') && !inputs.has('app'), 'packages outside both closures do not select it');
  // a CLI dependency added later joins the set from the manifests alone
  assert.equal(selectChecks(['packages/new-dep/src/x.ts'], { packageInputs: new Set(['new-dep']) }).sentinel, true);
  assert.deepEqual(selectChecks(['docs/x.md'], { packageInputs: undefined }), none);
});

test('sentinel-isolation runs for Sentinel and its own build closure only', () => {
  assert.deepEqual([...sentinelIsolationInputs()].sort(), ['code-parser', 'core', 'graph']);
  for (const path of [
    'packages/sentinel/src/execution/supervisor.ts',
    'packages/sentinel/test/execution-isolation.test.ts',
    'packages/sentinel/test/fixtures/workers/hostile-worker.mjs',
    'packages/core/src/strings-sentinel-execution.ts',
    'packages/code-parser/src/tsjs.ts',
  ]) {
    assert.equal(selectChecks([path]).isolation, true, path);
  }
  for (const path of [
    'packages/parsers/src/tsjs.ts',
    'packages/echo/src/cli.ts',
    'e2e/tests/chrome.pw.spec.ts',
    'docs/CI.md',
    'packages/sentinel/README.md',
  ]) {
    assert.equal(selectChecks([path]).isolation, false, path);
  }
  assert.equal(selectChecks(['packages/new-dep/src/x.ts'], { isolationInputs: new Set(['new-dep']) }).isolation, true);
  assert.equal(selectChecks(['.github/workflows/ci.yml']).isolation, true, 'workflow edits run everything');
  assert.equal(
    selectChecks(['packages/sentinel/src/execution/coordinator.ts']).recovery,
    true,
    'the recovery smoke follows the same inputs',
  );
  assert.equal(selectChecks(['packages/parsers/src/tsjs.ts']).recovery, false);
});

test('unreadable workspace manifests select every check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-ci-manifests-'));
  try {
    assert.throws(() => sentinelPackageInputs(dir), /CLI closure unreadable/);
    mkdirSync(join(dir, 'packages/cli'), { recursive: true });
    writeFileSync(join(dir, 'packages/cli/package.json'), '{ not json');
    assert.throws(() => sentinelPackageInputs(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Sentinel code and tests select offline report delivery in the browser job; packaging alone stays separate', () => {
  for (const path of [
    'packages/sentinel/src/index.ts',
    'packages/sentinel/schemas/report.schema.json',
    'packages/sentinel/package.json',
    'packages/sentinel/tsconfig.json',
  ]) {
    assert.deepEqual(
      selectChecks([path]),
      { ...none, validate: true, e2e: true, sentinel: true, isolation: true, recovery: true },
      path,
    );
  }
  assert.deepEqual(
    selectChecks([
      'packages/sentinel/test/reports.test.ts',
      'packages/sentinel/test/contracts.test.ts',
      'packages/sentinel/test/fixtures/feasibility/a.ts',
    ]),
    { ...none, validate: true, e2e: true, isolation: true, recovery: true },
  );
  assert.deepEqual(selectChecks(['packages/sentinel/README.md', 'scripts/test-sentinel-package.mjs']), {
    ...none,
    sentinel: true,
  });
  assert.deepEqual(
    selectChecks(['scripts/pack-sentinel.mjs']),
    { ...none, validate: true, sentinel: true },
    "Sentinel's review-package unit test packs the tarball too",
  );
  assert.deepEqual(selectChecks(['packages/core/src/counts.ts']), full, 'core feeds Echo and Sentinel');
  assert.deepEqual(selectChecks(['packages/graph/src/graph.ts']), full);
  assert.deepEqual(selectChecks(['packages/echo/src/cli.ts']), { ...none, validate: true, e2e: true, echo: true });
});

test('unavailable ranges run everything, including missing/zero SHAs and unknown events', () => {
  for (const options of [
    {},
    { base: '0'.repeat(40), head: '1'.repeat(40), event: 'push' },
    { base: '1'.repeat(40), head: '2'.repeat(40), event: 'push' },
    { base: '1'.repeat(40), head: '2'.repeat(40), event: 'unknown' },
  ]) {
    assert.deepEqual(detectChecks(options).checks, full);
  }
});

test('real git ranges handle PR branch points, multiple push commits, deletion and renames into docs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-ci-'));
  const git = (args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, text = 'fixture\n') => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (message) => {
    git(['add', '.']);
    git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=dev@example.com',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      message,
    ]);
    return git(['rev-parse', 'HEAD']);
  };
  try {
    git(['init', '-b', 'main']);
    write('README.md');
    write('packages/server/src/index.ts');
    const base = commit('chore: initial');
    git(['switch', '-c', 'docs']);
    write('docs/notes with spaces\nand newline.md');
    const docs = commit('docs: notes');
    git(['switch', 'main']);
    write('packages/core/src/graph.ts');
    const main = commit('feat(core): unrelated main change');
    const options = { base: main, head: docs, event: 'pull_request', cwd: dir };
    assert.deepEqual(changedPaths(options), ['docs/notes with spaces\nand newline.md']);
    assert.deepEqual(detectChecks(options).checks, none, 'base-branch changes must not count as PR changes');

    // a PR filters its package tests from its merge base, not from the base branch's newer head
    git(['switch', '-c', 'sentinel', base]);
    write('packages/sentinel/src/x.ts');
    const sentinelHead = commit('feat(sentinel): x');
    const pr = detectChecks({ base: main, head: sentinelHead, event: 'pull_request', cwd: dir });
    assert.equal(pr.tests.base, base);
    assert.deepEqual(pr.tests.packages, ['@farsight/sentinel']);

    git(['switch', 'docs']);
    renameSync(join(dir, 'packages/server/src/index.ts'), join(dir, 'docs/old-code.md'));
    const renamed = commit('docs: move code');
    assert.ok(changedPaths({ ...options, base, head: renamed }).includes('packages/server/src/index.ts'));
    assert.equal(detectChecks({ ...options, base, head: renamed }).checks.e2e, true);
    rmSync(join(dir, 'docs/old-code.md'));
    write('e2e/tests/new.pw.spec.ts');
    const head = commit('test(e2e): new check');
    const pushed = detectChecks({ base, head, event: 'push', cwd: dir });
    assert.deepEqual(
      pushed.checks,
      { ...none, validate: true, e2e: true, sentinel: true },
      'push range includes earlier commits and deleted code',
    );
    assert.deepEqual(pushed.tests, {
      base,
      also: ['@farsight/mcp'],
      packages: ['@farsight/cli', '@farsight/mcp', '@farsight/server'],
    });
    assert.deepEqual(detectChecks({ base: head, head, event: 'push', cwd: dir }).checks, none);

    const output = join(dir, 'output'),
      summary = join(dir, 'summary');
    execFileSync(process.execPath, [new URL('../ci-changes.mjs', import.meta.url).pathname], {
      cwd: dir,
      env: {
        ...process.env,
        BASE_SHA: base,
        HEAD_SHA: docs,
        GITHUB_EVENT_NAME: 'push',
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    assert.equal(
      readFileSync(output, 'utf8'),
      'validate=false\ne2e=false\necho=false\nsentinel=false\nisolation=false\nrecovery=false\ntestBase=\ntestAlso=\n',
    );
    assert.match(readFileSync(summary, 'utf8'), /e2e: skip/);
    assert.match(readFileSync(summary, 'utf8'), /sentinel-package: skip/);
    assert.match(readFileSync(summary, 'utf8'), /sentinel-isolation: skip/);
    assert.match(readFileSync(summary, 'utf8'), /sentinel-recovery: skip/);
    assert.doesNotMatch(readFileSync(summary, 'utf8'), /validate tests/, 'a skipped validate names no tests');

    for (const file of [output, summary]) rmSync(file);
    execFileSync(process.execPath, [new URL('../ci-changes.mjs', import.meta.url).pathname], {
      cwd: dir,
      env: {
        ...process.env,
        BASE_SHA: base,
        HEAD_SHA: head,
        GITHUB_EVENT_NAME: 'push',
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    assert.match(readFileSync(output, 'utf8'), new RegExp(`\\ntestBase=${base}\\ntestAlso=@farsight/mcp\\n$`));
    assert.match(
      readFileSync(summary, 'utf8'),
      /validate tests: the packages changed since `[0-9a-f]{12}` and their dependents, plus @farsight\/mcp .*from these paths: @farsight\/cli, @farsight\/mcp, @farsight\/server/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the workspace graph pnpm walks: dependents from every dependency field of the manifests', () => {
  const graph = workspaceGraph();
  assert.equal(graph.get('core').name, '@farsight/core');
  for (const dependent of ['server', 'cli', 'parsers', 'sentinel', 'echo', 'work'])
    assert.ok(graph.get('core').dependents.has(dependent), dependent);
  assert.deepEqual([...graph.get('server').dependents], ['cli']);
  assert.deepEqual([...graph.get('sentinel').dependents], [], 'no workspace package depends on Sentinel (ADR 18)');
  assert.throws(() => workspaceGraph(mkdtempSync(join(tmpdir(), 'farsight-ci-empty-'))), /No workspace packages/);
});

test('package tests that read another package without depending on it are found from the test folders', () => {
  const reach = testReach();
  const has = (consumer, provider) => reach.get(consumer)?.has(provider) ?? false;
  assert.ok(has('core', 'parsers'), "core's ask corpus ingests through the parsers' dist");
  assert.ok(has('sentinel', 'parsers'), "Sentinel's report tests ingest through the parsers' dist");
  assert.ok(has('mcp', 'cli'), "the MCP tests spawn the CLI's dist");
  assert.ok(has('server', 'cli'), 'the storyline diff test spawns the CLI');
  assert.ok(!has('sentinel', 'cli'), 'the owner UI browser journey reads the CLI only outside validate');
  assert.ok(!has('core', 'server'), 'a whole-line comment naming another package is not a read');
  for (const [file, { packages, gate }] of Object.entries(OUTSIDE_VALIDATE)) {
    const source = readFileSync(join(repoRoot, file), 'utf8');
    assert.ok(source.includes(gate), `${file} still keeps its reads of ${packages.join(', ')} out of validate`);
  }
});

test('the reference scan reads the three path forms, skips comments and its own package, and fails loudly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-ci-reach-'));
  const pkg = (name, files = {}) => {
    mkdirSync(join(dir, 'packages', name), { recursive: true });
    writeFileSync(join(dir, 'packages', name, 'package.json'), JSON.stringify({ name: `@x/${name}` }));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, 'packages', name, path)), { recursive: true });
      writeFileSync(join(dir, 'packages', name, path), text);
    }
  };
  try {
    pkg('a', {
      'test/one.test.ts': "await import('../../b/dist/index.js');\nawait import('../dist/own.js');\n",
      'test/helpers/two.mjs': "const cli = join(repoRoot, 'packages/c/dist/cli.js');\n",
      'test/fixtures/three.ts': "join(here, '..', '..', 'd', 'src', 'x.ts');\n// packages/e/dist is only named here\n",
      'test/data.json': '"packages/f/dist/x.js"',
      'src/not-a-test.ts': "import '../../g/dist/x.js';",
    });
    for (const name of ['b', 'c', 'd', 'e', 'f', 'g']) pkg(name);
    const graph = workspaceGraph(dir);
    assert.deepEqual([...testReach(dir, graph)], [['a', new Set(['b', 'c', 'd'])]]);
    rmSync(join(dir, 'packages/a/test/helpers/two.mjs'));
    mkdirSync(join(dir, 'packages/a/test/helpers/two.mjs'));
    writeFileSync(join(dir, 'packages/a/test/unreadable.ts'), '');
    chmodSync(join(dir, 'packages/a/test/unreadable.ts'), 0o000);
    if (process.getuid?.() !== 0) assert.throws(() => testReach(dir, graph), /EACCES/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate tests the packages a change reaches: pnpm's changed-since set plus the readers it cannot see", () => {
  const sentinelOnly = selectTests(['packages/sentinel/src/execution/supervisor.ts'], BASE);
  assert.deepEqual(sentinelOnly, { base: BASE, also: [], packages: ['@farsight/sentinel'] });
  for (const skipped of ['@farsight/echo', '@farsight/parsers', '@farsight/work'])
    assert.ok(!sentinelOnly.packages.includes(skipped), skipped);
  assert.deepEqual(selectTests(['packages/sentinel/test/fixtures/workers/hostile-worker.mjs'], BASE).packages, [
    '@farsight/sentinel',
  ]);

  const viewer = selectTests(['packages/server/public/app/surfaces/sentinel.js', 'docs/MAP-VIEWER.md'], BASE);
  assert.deepEqual(viewer, {
    base: BASE,
    also: ['@farsight/mcp'],
    packages: ['@farsight/cli', '@farsight/mcp', '@farsight/server'],
  });

  const core = selectTests(['packages/core/src/counts.ts'], BASE);
  assert.equal(core.packages.length, 12, core.packages.join(', '));
  assert.ok(!core.packages.includes('@farsight/graph') && !core.packages.includes('@farsight/code-parser'));
  assert.deepEqual(selectTests(['packages/parsers/src/tsjs.ts'], BASE).also, ['@farsight/core', '@farsight/sentinel']);
  assert.deepEqual(selectTests(['packages/cli/src/cli.ts'], BASE).also, ['@farsight/mcp', '@farsight/server']);
  assert.deepEqual(
    selectTests(['packages/echo/src/cli.ts', 'e2e/tests/chrome.pw.spec.ts', 'packages/sentinel/README.md'], BASE)
      .packages,
    ['@farsight/echo'],
    'paths validate does not test leave the set alone',
  );
  assert.deepEqual(
    selectTests(['.claude/skills/git-pr-flow/SKILL.md', '.agents/skills/git-pr-flow/SKILL.md'], BASE),
    { base: BASE, also: [], packages: [] },
    'the skills trees select validate for its script tests only',
  );
});

test('a change outside the packages, an unusable base or an unreadable workspace tests every package', () => {
  for (const path of [
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.base.json',
    'scripts/release.mjs',
    'scripts/test/ci-changes.test.mjs',
    'scripts/npm-acceptance.mjs',
    'scripts/pack-sentinel.mjs',
    'scripts/synth-graph.mjs',
    'schemas/farsight-affected-v1.schema.json',
    'examples/invoice-app/src/app.ts',
    '.github/workflows/ci.yml',
    'packages/no-manifest/src/x.ts',
  ]) {
    assert.deepEqual(selectTests(['packages/server/src/index.ts', path], BASE), every, path);
  }
  for (const base of ['', undefined, '0'.repeat(40), 'HEAD', '--output=x', 'a'.repeat(39)])
    assert.deepEqual(selectTests(['packages/server/src/index.ts'], base), every, String(base));
  const empty = mkdtempSync(join(tmpdir(), 'farsight-ci-noworkspace-'));
  try {
    assert.deepEqual(selectTests(['packages/server/src/index.ts'], BASE, { root: empty }), every, 'no manifests');
    mkdirSync(join(empty, 'packages/server/test'), { recursive: true });
    writeFileSync(join(empty, 'packages/server/package.json'), JSON.stringify({ name: '@farsight/server' }));
    writeFileSync(join(empty, 'packages/server/test/unreadable.test.ts'), '');
    const inputs = { root: empty, packageInputs: new Set(), isolationInputs: new Set() };
    assert.deepEqual(selectTests(['packages/server/src/index.ts'], BASE, inputs), {
      base: BASE,
      also: [],
      packages: ['@farsight/server'],
    });
    chmodSync(join(empty, 'packages/server/test/unreadable.test.ts'), 0o000);
    if (process.getuid?.() !== 0)
      assert.deepEqual(selectTests(['packages/server/src/index.ts'], BASE, inputs), every, 'an unreadable test folder');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  assert.deepEqual(detectChecks({}).tests, every, 'an unavailable range tests every package');
});
