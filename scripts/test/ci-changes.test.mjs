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
  pnpmTestArgs,
  selectorOutput,
  selectTests,
  sentinelIsolationInputs,
  sentinelPackageInputs,
  testReach,
  workspaceGraph,
} from '../ci-changes.mjs';
import { buildClosure } from '../pack-preflight.mjs';

const none = {
  validate: false,
  e2e: false,
  echo: false,
  sentinel: false,
  isolation: false,
  recovery: false,
  service: false,
  scannerCli: false,
};
const full = {
  validate: true,
  e2e: true,
  echo: true,
  sentinel: true,
  isolation: true,
  recovery: true,
  service: true,
  scannerCli: true,
};
const every = { scope: 'all', packages: [], also: [] };
const some = (packages, also = []) => ({ scope: 'packages', packages, also });
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
    { ...none, e2e: true, validate: true, service: true },
    "the perf suite's synthetic workspace is also imported by the server's unit tests",
  );
  // a script change tests every package, Sentinel's process suite with them
  assert.deepEqual(selectChecks(['packages/core/test/coverage.test.ts', 'scripts/test/release.test.mjs']), {
    ...none,
    validate: true,
    service: true,
  });
  assert.deepEqual(selectChecks(['docs/CI.md', 'scripts/release.mjs', 'e2e/fixture/serve.mjs']), {
    ...none,
    validate: true,
    e2e: true,
    service: true,
  });
});

test('runtime, fixtures and shared build inputs retain their affected checks', () => {
  assert.deepEqual(selectChecks(['packages/app/src/index.ts']), { ...none, validate: true, e2e: true });
  for (const path of ['examples/nx-workspace/package.json', 'schemas/farsight-affected-v1.schema.json']) {
    assert.deepEqual(selectChecks([path]), { ...none, validate: true, e2e: true, service: true }, path);
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
    // validate tests Sentinel (so sentinel-service runs) for the parsers, whose dist its report tests ingest through,
    // and for examples/ (every package)
    const service = /^(?:packages\/parsers|examples)\//.test(path);
    // the scanner workflow ingests through the parsers' dist, so their code (not the CLI's) reaches it too
    const scannerCli = path.startsWith('packages/parsers/');
    assert.deepEqual(
      selectChecks([path]),
      { ...none, validate: true, e2e: true, sentinel: true, service, scannerCli },
      path,
    );
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
    {
      ...none,
      validate: true,
      e2e: true,
      sentinel: true,
      isolation: true,
      recovery: true,
      service: true,
      scannerCli: true,
    },
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
  assert.deepEqual(selectChecks(['scripts/npm-acceptance.mjs']), {
    ...none,
    validate: true,
    sentinel: true,
    service: true,
  });
  for (const path of [
    'scripts/release-manifest.mjs',
    'scripts/verify-release.mjs',
    'scripts/release.mjs',
    'scripts/changelog.mjs',
  ]) {
    assert.deepEqual(selectChecks([path]), { ...none, validate: true, service: true }, path);
  }
  assert.deepEqual(
    selectChecks(['scripts/test/helpers/acceptance-standins.mjs']),
    { ...none, validate: true, service: true },
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
      {
        ...none,
        validate: true,
        e2e: true,
        sentinel: true,
        isolation: true,
        recovery: true,
        service: true,
        scannerCli: true,
      },
      path,
    );
  }
  assert.deepEqual(
    selectChecks([
      'packages/sentinel/test/reports.test.ts',
      'packages/sentinel/test/contracts.test.ts',
      'packages/sentinel/test/fixtures/feasibility/a.ts',
    ]),
    { ...none, validate: true, e2e: true, isolation: true, recovery: true, service: true, scannerCli: true },
  );
  assert.deepEqual(selectChecks(['packages/sentinel/README.md']), { ...none, sentinel: true, scannerCli: true });
  assert.deepEqual(selectChecks(['scripts/test-sentinel-package.mjs']), { ...none, sentinel: true });
  assert.deepEqual(
    selectChecks(['scripts/pack-sentinel.mjs']),
    { ...none, validate: true, sentinel: true, service: true, scannerCli: true },
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

    // a PR tests the packages its own commits change, not the base branch's newer ones (core, here)
    git(['switch', '-c', 'sentinel', base]);
    write('packages/sentinel/src/x.ts');
    const sentinelHead = commit('feat(sentinel): x');
    const pr = detectChecks({ base: main, head: sentinelHead, event: 'pull_request', cwd: dir });
    assert.deepEqual(pr.tests, some(['@farsight/sentinel']));

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
    assert.deepEqual(pushed.tests, some(['@farsight/cli', '@farsight/mcp', '@farsight/server'], ['@farsight/mcp']));
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
      'validate=false\ne2e=false\necho=false\nsentinel=false\nisolation=false\nrecovery=false\nservice=false\n' +
        'scannerCli=false\ntestScope=all\ntestPackages=\n',
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
    assert.match(
      readFileSync(output, 'utf8'),
      /\ntestScope=packages\ntestPackages=@farsight\/cli @farsight\/mcp @farsight\/server\n$/,
    );
    assert.match(
      readFileSync(summary, 'utf8'),
      /validate tests: @farsight\/cli, @farsight\/mcp, @farsight\/server \(the changed packages and their dependents, with @farsight\/mcp, whose tests read a reached package's files\)/,
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
    writeFileSync(join(dir, 'packages', name, 'package.json'), JSON.stringify({ name: `@farsight/${name}` }));
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
  const sentinelOnly = selectTests(['packages/sentinel/src/execution/supervisor.ts']);
  assert.deepEqual(sentinelOnly, some(['@farsight/sentinel']));
  for (const skipped of ['@farsight/echo', '@farsight/parsers', '@farsight/work'])
    assert.ok(!sentinelOnly.packages.includes(skipped), skipped);
  assert.deepEqual(selectTests(['packages/sentinel/test/fixtures/workers/hostile-worker.mjs']).packages, [
    '@farsight/sentinel',
  ]);

  const viewer = selectTests(['packages/server/public/app/surfaces/sentinel.js', 'docs/MAP-VIEWER.md']);
  assert.deepEqual(viewer, some(['@farsight/cli', '@farsight/mcp', '@farsight/server'], ['@farsight/mcp']));

  const core = selectTests(['packages/core/src/counts.ts']);
  assert.equal(core.packages.length, 12, core.packages.join(', '));
  assert.ok(!core.packages.includes('@farsight/graph') && !core.packages.includes('@farsight/code-parser'));
  assert.deepEqual(selectTests(['packages/parsers/src/tsjs.ts']).also, ['@farsight/core', '@farsight/sentinel']);
  assert.deepEqual(selectTests(['packages/cli/src/cli.ts']).also, ['@farsight/mcp', '@farsight/server']);
  assert.deepEqual(
    selectTests(['packages/echo/src/cli.ts', 'e2e/tests/chrome.pw.spec.ts', 'packages/sentinel/README.md']).packages,
    ['@farsight/echo'],
    'paths validate does not test leave the set alone',
  );
  assert.deepEqual(
    selectTests(['.claude/skills/git-pr-flow/SKILL.md', '.agents/skills/git-pr-flow/SKILL.md']),
    { scope: 'none', packages: [], also: [] },
    'the skills trees select validate for its script tests only, and say so',
  );
});

test('a change outside the packages or an unreadable workspace tests every package', () => {
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
    assert.deepEqual(selectTests(['packages/server/src/index.ts', path]), every, path);
  }
  const empty = mkdtempSync(join(tmpdir(), 'farsight-ci-noworkspace-'));
  try {
    assert.deepEqual(selectTests(['packages/server/src/index.ts'], { root: empty }), every, 'no manifests');
    mkdirSync(join(empty, 'packages/server/test'), { recursive: true });
    writeFileSync(join(empty, 'packages/server/package.json'), JSON.stringify({ name: '@farsight/server' }));
    writeFileSync(join(empty, 'packages/server/test/unreadable.test.ts'), '');
    const inputs = { root: empty, packageInputs: new Set(), isolationInputs: new Set() };
    assert.deepEqual(selectTests(['packages/server/src/index.ts'], inputs), some(['@farsight/server']));
    chmodSync(join(empty, 'packages/server/test/unreadable.test.ts'), 0o000);
    if (process.getuid?.() !== 0)
      assert.deepEqual(selectTests(['packages/server/src/index.ts'], inputs), every, 'an unreadable test folder');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  assert.deepEqual(detectChecks({}).tests, every, 'an unavailable range tests every package');
});

test('the pnpm arguments: one filter per selected package, nothing only for an explicit none, else every package', () => {
  const members = new Set(['@farsight/server', '@farsight/cli', '@farsight/core']);
  assert.deepEqual(pnpmTestArgs('packages', '@farsight/server @farsight/cli', members), [
    '-r',
    '--filter',
    '@farsight/server',
    '--filter',
    '@farsight/cli',
    'test',
  ]);
  assert.equal(pnpmTestArgs('none', ''), null, 'only the skills trees changed');
  assert.equal(pnpmTestArgs('none', undefined), null);
  // a lost or emptied package list never reads as "no packages": a core change whose list is lost tests everything
  for (const packages of ['', '   ', '\n', undefined, null])
    assert.deepEqual(pnpmTestArgs('packages', packages, members), ['-r', 'test'], JSON.stringify(packages));
  assert.deepEqual(pnpmTestArgs('none', '@farsight/core', members), ['-r', 'test'], 'none with names is not none');
  for (const scope of ['all', '', undefined, 'Packages', 'packages ', 'NONE'])
    assert.deepEqual(pnpmTestArgs(scope, '@farsight/server', members), ['-r', 'test'], `missing or other: ${scope}`);
  for (const name of [
    '--filter=...',
    '@farsight/x;rm',
    '...@farsight/core',
    '@farsight/core...',
    '../core',
    '@other/x',
  ])
    assert.throws(() => pnpmTestArgs('packages', `@farsight/server ${name}`, members), /Unexpected package name/, name);
  assert.throws(
    () => pnpmTestArgs('packages', '@farsight/server @farsight/not-a-workspace-package', members),
    /Not a workspace package: @farsight\/not-a-workspace-package/,
  );
});

test('the outputs carry only strict values; a package name that could add a record selects every check', () => {
  const checks = { ...none, validate: true };
  assert.equal(
    selectorOutput(checks, { scope: 'packages', packages: ['@farsight/cli', '@farsight/server'], also: [] }),
    'validate=true\ne2e=false\necho=false\nsentinel=false\nisolation=false\nrecovery=false\nservice=false\n' +
      'scannerCli=false\ntestScope=packages\ntestPackages=@farsight/cli @farsight/server\n',
  );
  assert.match(selectorOutput(checks, { scope: 'none', packages: [], also: [] }), /\ntestScope=none\ntestPackages=\n$/);
  const everything =
    'validate=true\ne2e=true\necho=true\nsentinel=true\nisolation=true\nrecovery=true\nservice=true\n' +
    'scannerCli=true\ntestScope=all\ntestPackages=\n';
  for (const tests of [
    { scope: 'packages', packages: ['@farsight/x\nvalidate=false\ne2e=false'], also: [] },
    { scope: 'packages', packages: ['@farsight/cli', '@farsight/x testScope=none'], also: [] },
    { scope: 'packages', packages: [], also: [] },
    { scope: 'none', packages: ['@farsight/cli'], also: [] },
    { scope: 'all\nvalidate=false', packages: [], also: [] },
    { scope: 'packages', packages: '@farsight/cli', also: [] },
    undefined,
  ])
    assert.equal(selectorOutput(checks, tests), everything, JSON.stringify(tests));
  assert.equal(
    selectorOutput({ ...checks, validate: 'false\ninjected=true' }, { scope: 'all', packages: [] }),
    everything,
  );

  // a workspace package named with an embedded newline: refused when the graph is read, so every check runs
  const dir = mkdtempSync(join(tmpdir(), 'farsight-ci-names-'));
  try {
    for (const [folder, name] of [
      ['cli', '@farsight/cli'],
      ['evil', '@farsight/evil\nvalidate=false'],
    ]) {
      mkdirSync(join(dir, 'packages', folder), { recursive: true });
      writeFileSync(join(dir, 'packages', folder, 'package.json'), JSON.stringify({ name }));
    }
    assert.throws(() => workspaceGraph(dir), /Unexpected workspace package name: "@farsight\/evil\\nvalidate=false"/);
    assert.deepEqual(selectTests(['packages/evil/src/x.ts'], { root: dir }), every);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const detected = detectChecks({ base: head, head, event: 'push', cwd: repoRoot, root: dir });
    assert.deepEqual(detected.checks, full);
    assert.deepEqual(detected.tests, every);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// pnpm 9's own changed-since filter diffs with git's rename detection on and sees only a rename's destination; the
// selector's --no-renames diff sees both sides. The set validate hands to pnpm is the selector's, so a package's file
// moved out to documentation still tests that package and its dependents.
test('a file renamed out of a package still tests it: the pnpm arguments validate runs, from a real range', () => {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-ci-rename-'));
  const stub = mkdtempSync(join(tmpdir(), 'farsight-ci-pnpm-'));
  const git = (args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (message) => {
    git(['add', '-A']);
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
  const recorded = join(stub, 'args');
  writeFileSync(join(stub, 'pnpm'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${recorded}'\nexit "\${STUB_EXIT:-0}"\n`);
  chmodSync(join(stub, 'pnpm'), 0o755);
  const runTests = (env) =>
    execFileSync(process.execPath, [new URL('../ci-changes.mjs', import.meta.url).pathname, '--run-tests'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${stub}:${process.env.PATH}`,
        TEST_SCOPE: undefined,
        TEST_PACKAGES: undefined,
        ...env,
      },
    });
  const pnpmArgs = () => readFileSync(recorded, 'utf8').trim().split('\n');
  try {
    git(['init', '-b', 'main']);
    mkdirSync(join(dir, 'packages/core/test/fixtures'), { recursive: true });
    writeFileSync(
      join(dir, 'packages/core/test/fixtures/ask-corpus.json'),
      JSON.stringify({ questions: [1, 2, 3] }, null, 2),
    );
    writeFileSync(join(dir, 'README.md'), 'fixture\n');
    const base = commit('chore: initial');
    mkdirSync(join(dir, 'docs'));
    git(['mv', 'packages/core/test/fixtures/ask-corpus.json', 'docs/ask-corpus.md']);
    const head = commit('docs: move the corpus');
    assert.deepEqual(
      git(['-c', 'diff.renames=true', 'diff', '--name-only', base, head]).split('\n'),
      ['docs/ask-corpus.md'],
      'what a rename-detecting diff (pnpm 9 changed-since) sees',
    );

    const core = selectTests(['packages/core/src/counts.ts']).packages;
    assert.equal(core.length, 12);
    const range = { BASE_SHA: base, HEAD_SHA: head, GITHUB_EVENT_NAME: 'pull_request' };
    for (const event of ['pull_request', 'push']) {
      rmSync(recorded, { force: true });
      runTests({ ...range, GITHUB_EVENT_NAME: event });
      assert.deepEqual(pnpmArgs(), ['-r', ...core.flatMap((name) => ['--filter', name]), 'test'], event);
    }

    // the workflow's handover: the selector's outputs, missing ones, an explicit none, and pnpm's exit status
    rmSync(recorded, { force: true });
    runTests({ TEST_SCOPE: 'packages', TEST_PACKAGES: '@farsight/sentinel' });
    assert.deepEqual(pnpmArgs(), ['-r', '--filter', '@farsight/sentinel', 'test']);
    runTests({ TEST_SCOPE: '', TEST_PACKAGES: '' });
    assert.deepEqual(pnpmArgs(), ['-r', 'test'], 'a missing selector output tests every package');
    for (const lost of [{ TEST_PACKAGES: undefined }, { TEST_PACKAGES: '' }, { TEST_PACKAGES: ' \t ' }]) {
      rmSync(recorded, { force: true });
      runTests({ TEST_SCOPE: 'packages', ...lost });
      assert.deepEqual(pnpmArgs(), ['-r', 'test'], `only testPackages missing: ${JSON.stringify(lost)}`);
    }
    rmSync(recorded, { force: true });
    assert.match(runTests({ TEST_SCOPE: 'none', TEST_PACKAGES: '' }), /No package is reached/);
    assert.throws(() => readFileSync(recorded), /ENOENT/, 'pnpm is not started for an explicit none');
    assert.throws(
      () => runTests({ TEST_SCOPE: 'packages', TEST_PACKAGES: '@farsight/core @farsight/not-a-workspace-package' }),
      (error) => error.status !== 0 && /Not a workspace package/.test(error.stderr),
      'a well-formed name that is not a workspace package is refused',
    );
    assert.throws(() => readFileSync(recorded), /ENOENT/, 'and pnpm is not started for it');
    assert.throws(
      () => runTests({ TEST_SCOPE: 'packages', TEST_PACKAGES: '@farsight/core', STUB_EXIT: '3' }),
      (error) => error.status === 3,
      "pnpm's failure is the step's",
    );
    assert.throws(
      () => runTests({ TEST_SCOPE: 'packages', TEST_PACKAGES: '--filter=...[HEAD~1]' }),
      (error) => error.status !== 0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stub, { recursive: true, force: true });
  }
});

test("sentinel-service runs exactly when validate tests Sentinel, since it runs Sentinel's process suite", () => {
  for (const paths of [
    ['packages/sentinel/src/execution/supervisor.ts'],
    ['packages/sentinel/test/cli-prework.test.ts'],
    ['packages/sentinel/test/process-suite.txt'],
    ['packages/sentinel/package.json'],
    ['packages/core/src/counts.ts'],
    ['packages/code-parser/src/tsjs.ts'],
    ['packages/parsers/src/tsjs.ts'],
    ['scripts/sentinel-tests.mjs'],
    ['scripts/test/release.test.mjs'],
    ['pnpm-lock.yaml'],
    ['packages/server/public/app/shell.js'],
    ['packages/cli/src/cli.ts'],
    ['packages/echo/src/cli.ts'],
    ['packages/work/src/gate.ts'],
    ['.claude/skills/git-pr-flow/SKILL.md'],
    ['packages/sentinel/README.md'],
    ['e2e/tests/chrome.pw.spec.ts'],
    ['docs/CI.md'],
  ]) {
    const checks = selectChecks(paths);
    const tests = selectTests(paths);
    const testsSentinel = checks.validate && (tests.scope === 'all' || tests.packages.includes('@farsight/sentinel'));
    assert.equal(checks.service, testsSentinel, paths.join(', '));
  }
  assert.equal(selectChecks(['packages/server/public/app/shell.js']).service, false, 'a viewer change');
  assert.equal(selectChecks(['packages/sentinel/test/cli-prework.test.ts']).service, true, 'a process test itself');
  assert.equal(selectChecks(['packages/sentinel/README.md']).service, false, 'packaging alone');
});
