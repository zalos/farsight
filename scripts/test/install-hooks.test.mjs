import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const legacy = '#!/bin/sh\n'
  + '# Installed into .git/hooks by `node scripts/install-hooks.mjs` (run by `pnpm install`\'s prepare).\n'
  + '# The subject must be a Conventional Commit; CI checks the same rule on the PR title and commits.\n'
  + 'exec node "$(git rev-parse --show-toplevel)/scripts/lint-commits.mjs" --file "$1" --any-scope\n';

test('lefthook migrates a linked worktree without changing any LFS hooks', () => {
  const temp = mkdtempSync(join(tmpdir(), 'farsight-hooks-'));
  const repo = join(temp, 'repo');
  const tree = join(temp, 'tree');
  const git = (args, cwd = repo) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const install = () => execFileSync(process.execPath, [join(tree, 'scripts/install-hooks.mjs')], {
    cwd: tree, env: { ...process.env, CI: '', LEFTHOOK: '1' }, stdio: 'pipe',
  });
  try {
    mkdirSync(repo);
    git(['init', '-b', 'main']);
    mkdirSync(join(repo, 'scripts'));
    copyFileSync(join(root, 'scripts/install-hooks.mjs'), join(repo, 'scripts/install-hooks.mjs'));
    copyFileSync(join(root, 'lefthook.yml'), join(repo, 'lefthook.yml'));
    writeFileSync(join(repo, '.gitmessage'), '# subject\n');
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=dev@example.com', 'commit', '-m', 'chore: fixture']);
    git(['worktree', 'add', '-b', 'feature', tree]);
    symlinkSync(join(root, 'node_modules'), join(tree, 'node_modules'), 'dir');
    const hooks = resolve(tree, git(['rev-parse', '--git-path', 'hooks'], tree).toString().trim());
    const lfs = new Map(['pre-push', 'post-checkout', 'post-commit', 'post-merge'].map((name) => [name, `#!/bin/sh\n# LFS ${name}\nexit 0\n`]));
    for (const [name, content] of lfs) writeFileSync(join(hooks, name), content);
    writeFileSync(join(hooks, 'commit-msg'), legacy);
    install();
    const installed = readFileSync(join(hooks, 'commit-msg'), 'utf8');
    assert.match(installed, /lefthook/);
    assert.match(readFileSync(join(hooks, 'pre-commit'), 'utf8'), /lefthook/);
    assert.equal(existsSync(join(hooks, 'commit-msg.old')), false, 'the legacy hook must be removed, not backed up');
    assert.equal(existsSync(join(tree, hooks)), false, 'must not nest the absolute hooks path inside the worktree');
    assert.equal(git(['config', '--local', 'commit.template']).toString().trim(), '.gitmessage');
    assert.throws(() => git(['config', '--local', '--get', 'blame.ignoreRevsFile']));
    writeFileSync(join(tree, '.git-blame-ignore-revs'), '# formatting commits\n');
    install();
    assert.equal(git(['config', '--local', 'blame.ignoreRevsFile']).toString().trim(), '.git-blame-ignore-revs');
    assert.equal(readFileSync(join(hooks, 'commit-msg'), 'utf8'), installed, 'reinstallation is stable');
    for (const [name, content] of lfs) assert.equal(readFileSync(join(hooks, name), 'utf8'), content);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('the installer is a no-op in CI and outside a Git checkout', () => {
  const temp = mkdtempSync(join(tmpdir(), 'farsight-hooks-noop-'));
  try {
    mkdirSync(join(temp, 'scripts'));
    copyFileSync(join(root, 'scripts/install-hooks.mjs'), join(temp, 'scripts/install-hooks.mjs'));
    for (const ci of ['', 'true']) {
      const output = execFileSync(process.execPath, [join(temp, 'scripts/install-hooks.mjs')], {
        cwd: temp, env: { ...process.env, CI: ci }, encoding: 'utf8',
      });
      assert.match(output, ci ? /CI, nothing to install/ : /not a git checkout, nothing to install/);
      assert.equal(existsSync(join(temp, '.git')), false);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
