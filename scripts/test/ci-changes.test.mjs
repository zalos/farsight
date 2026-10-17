import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { changedPaths, detectChecks, selectChecks } from '../ci-changes.mjs';

const none = { validate: false, e2e: false, echo: false };
const full = { validate: true, e2e: true, echo: true };

test('ordinary docs skip runtime checks; packaged docs still check their tarball', () => {
  assert.deepEqual(selectChecks(['README.md', 'docs/research/analysis-core-options-2026-10-17.md',
    'docs/ARCHITECTURE.md', '.github/PULL_REQUEST_TEMPLATE.md', '.claude/skills/example/SKILL.md']), none);
  assert.deepEqual(selectChecks(['docs/ECHO.md', 'packages/echo/README.md']), { ...none, echo: true });
});

test('e2e and unit test changes select their own check; mixed edits take the union', () => {
  assert.deepEqual(selectChecks(['e2e/tests/chrome.pw.spec.ts', 'scripts/e2e.mjs']), { ...none, e2e: true });
  assert.deepEqual(selectChecks(['packages/core/test/coverage.test.ts', 'scripts/test/release.test.mjs']), { ...none, validate: true });
  assert.deepEqual(selectChecks(['docs/CI.md', 'scripts/release.mjs', 'e2e/fixture/serve.mjs']), { ...none, validate: true, e2e: true });
});

test('runtime, fixtures and shared build inputs retain their affected checks', () => {
  for (const path of ['packages/server/public/app/main.js', 'packages/parsers/src/tsjs.ts',
    'examples/invoice-app/docs/flow.md', 'schemas/farsight-affected-v1.schema.json']) {
    assert.deepEqual(selectChecks([path]), { validate: true, e2e: true, echo: false }, path);
  }
  for (const path of ['packages/core/src/graph.ts', 'packages/core/package.json', 'packages/echo/src/cli.ts',
    'pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', '.nvmrc', '.github/workflows/ci.yml',
    'scripts/ci-changes.mjs', 'new-build-input.json', 'docs/fixture.json']) {
    assert.deepEqual(selectChecks([path]), full, path);
  }
  assert.deepEqual(selectChecks(['scripts/pack-echo.mjs']), { ...none, echo: true });
});

test('unavailable ranges run everything, including missing/zero SHAs and unknown events', () => {
  for (const options of [{}, { base: '0'.repeat(40), head: '1'.repeat(40), event: 'push' },
    { base: '1'.repeat(40), head: '2'.repeat(40), event: 'push' },
    { base: '1'.repeat(40), head: '2'.repeat(40), event: 'unknown' }]) {
    assert.deepEqual(detectChecks(options).checks, full);
  }
});

test('real git ranges handle PR branch points, multiple push commits, deletion and renames into docs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-ci-'));
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, text = 'fixture\n') => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  const commit = message => {
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=dev@example.com', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', message]);
    return git(['rev-parse', 'HEAD']);
  };
  try {
    git(['init', '-b', 'main']);
    write('README.md'); write('packages/server/src/index.ts');
    const base = commit('chore: initial');
    git(['switch', '-c', 'docs']);
    write('docs/notes with spaces\nand newline.md');
    const docs = commit('docs: notes');
    git(['switch', 'main']); write('packages/core/src/graph.ts');
    const main = commit('feat(core): unrelated main change');
    const options = { base: main, head: docs, event: 'pull_request', cwd: dir };
    assert.deepEqual(changedPaths(options), ['docs/notes with spaces\nand newline.md']);
    assert.deepEqual(detectChecks(options).checks, none, 'base-branch changes must not count as PR changes');

    git(['switch', 'docs']);
    renameSync(join(dir, 'packages/server/src/index.ts'), join(dir, 'docs/old-code.md'));
    const renamed = commit('docs: move code');
    assert.ok(changedPaths({ ...options, base, head: renamed }).includes('packages/server/src/index.ts'));
    assert.equal(detectChecks({ ...options, base, head: renamed }).checks.e2e, true);
    rmSync(join(dir, 'docs/old-code.md')); write('e2e/tests/new.pw.spec.ts');
    const head = commit('test(e2e): new check');
    assert.deepEqual(detectChecks({ base, head, event: 'push', cwd: dir }).checks,
      { validate: true, e2e: true, echo: false }, 'push range includes earlier commits and deleted code');
    assert.deepEqual(detectChecks({ base: head, head, event: 'push', cwd: dir }).checks, none);

    const output = join(dir, 'output'), summary = join(dir, 'summary');
    execFileSync(process.execPath, [new URL('../ci-changes.mjs', import.meta.url).pathname], {
      cwd: dir, env: { ...process.env, BASE_SHA: base, HEAD_SHA: docs, GITHUB_EVENT_NAME: 'push', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(readFileSync(output, 'utf8'), 'validate=false\ne2e=false\necho=false\n');
    assert.match(readFileSync(summary, 'utf8'), /e2e: skip/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
