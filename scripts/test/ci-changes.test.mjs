import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  changedPaths,
  detectChecks,
  selectChecks,
  sentinelIsolationInputs,
  sentinelPackageInputs,
} from '../ci-changes.mjs';
import { buildClosure } from '../pack-preflight.mjs';

const none = { validate: false, e2e: false, echo: false, sentinel: false, isolation: false, recovery: false };
const full = { validate: true, e2e: true, echo: true, sentinel: true, isolation: true, recovery: true };

test('ordinary docs skip runtime checks; packaged docs still check their tarball', () => {
  assert.deepEqual(
    selectChecks([
      'README.md',
      'docs/research/analysis-core-options-2026-10-17.md',
      'docs/ARCHITECTURE.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
      '.claude/skills/example/SKILL.md',
    ]),
    none,
  );
  assert.deepEqual(selectChecks(['docs/ECHO.md', 'packages/echo/README.md']), { ...none, echo: true });
});

test('e2e and unit test changes select their own check; mixed edits take the union', () => {
  assert.deepEqual(selectChecks(['e2e/tests/chrome.pw.spec.ts', 'scripts/e2e.mjs']), { ...none, e2e: true });
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
  assert.deepEqual(
    selectChecks(['packages/sentinel/README.md', 'scripts/pack-sentinel.mjs', 'scripts/test-sentinel-package.mjs']),
    { ...none, sentinel: true },
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

    git(['switch', 'docs']);
    renameSync(join(dir, 'packages/server/src/index.ts'), join(dir, 'docs/old-code.md'));
    const renamed = commit('docs: move code');
    assert.ok(changedPaths({ ...options, base, head: renamed }).includes('packages/server/src/index.ts'));
    assert.equal(detectChecks({ ...options, base, head: renamed }).checks.e2e, true);
    rmSync(join(dir, 'docs/old-code.md'));
    write('e2e/tests/new.pw.spec.ts');
    const head = commit('test(e2e): new check');
    assert.deepEqual(
      detectChecks({ base, head, event: 'push', cwd: dir }).checks,
      { ...none, validate: true, e2e: true, sentinel: true },
      'push range includes earlier commits and deleted code',
    );
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
      'validate=false\ne2e=false\necho=false\nsentinel=false\nisolation=false\nrecovery=false\n',
    );
    assert.match(readFileSync(summary, 'utf8'), /e2e: skip/);
    assert.match(readFileSync(summary, 'utf8'), /sentinel-package: skip/);
    assert.match(readFileSync(summary, 'utf8'), /sentinel-isolation: skip/);
    assert.match(readFileSync(summary, 'utf8'), /sentinel-recovery: skip/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
