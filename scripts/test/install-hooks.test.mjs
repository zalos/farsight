import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

test('hook installer resolves the absolute common hooks directory of a linked worktree', () => {
  const temp = mkdtempSync(join(tmpdir(), 'farsight-hooks-'));
  const repo = join(temp, 'repo'), tree = join(temp, 'tree');
  const git = (args, cwd = repo) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  try {
    mkdirSync(repo);
    git(['init', '-b', 'main']);
    mkdirSync(join(repo, '.githooks')); mkdirSync(join(repo, 'scripts'));
    copyFileSync(new URL('../install-hooks.mjs', import.meta.url), join(repo, 'scripts/install-hooks.mjs'));
    writeFileSync(join(repo, '.githooks', 'commit-msg'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(repo, '.gitmessage'), '# subject\n');
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=dev@example.com', 'commit', '-m', 'chore: fixture']);
    git(['worktree', 'add', '-b', 'feature', tree]);
    execFileSync(process.execPath, [join(tree, 'scripts/install-hooks.mjs')], { cwd: tree, env: { ...process.env, CI: '' }, stdio: 'pipe' });
    const hooks = resolve(tree, git(['rev-parse', '--git-path', 'hooks'], tree).toString().trim());
    assert.equal(readFileSync(join(hooks, 'commit-msg'), 'utf8'), '#!/bin/sh\nexit 0\n');
    assert.equal(existsSync(join(tree, hooks)), false, 'must not nest the absolute hooks path inside the worktree');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
