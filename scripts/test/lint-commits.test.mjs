// scripts/lint-commits.mjs: the subject rules, and a range against a throwaway repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintSubject, lintRange, SCOPES, TYPES } from '../lint-commits.mjs';

test('conforming subjects pass', () => {
  for (const s of [
    'feat(cli): a thing',
    'fix(server): the picker waits for its document',
    'docs: handoff at session close',
    'chore(release): v0.2.0',
    'chore(release): v0.2.1 (#38)',
    'feat(core)!: drop the v0 shape',
    'test(e2e): the project picker',
    'ci: lint PR titles',
    'revert: feat(cli): a thing',
    `feat(parsers): ${'x'.repeat(80)} (#12)`,
  ]) assert.deepEqual(lintSubject(s), [], s);
});

test("git's own subjects are skipped", () => {
  for (const s of ['Merge pull request #9 from x/y', 'Merge origin/main into fix/x', 'Revert "feat(cli): a thing"', 'fixup! feat(cli): a thing']) {
    assert.deepEqual(lintSubject(s), [], s);
  }
});

test('the failures name the rule', () => {
  assert.match(lintSubject('Added a thing')[0], /not a conventional commit/);
  assert.match(lintSubject('Fix: a thing').join('\n'), /lower-case/);
  assert.match(lintSubject('fix:a thing').join('\n'), /one space/);
  assert.match(lintSubject('feature(cli): a thing')[0], /unknown type `feature`/);
  assert.match(lintSubject('fix(viewer-thing): a thing')[0], /unknown scope `viewer-thing`/);
  assert.match(lintSubject('fix(cli): a thing.')[0], /no full stop/);
  assert.match(lintSubject('fix(cli): wip')[0], /says nothing/);
  assert.match(lintSubject(`fix(cli): ${'y'.repeat(130)}`)[0], /characters/);
  assert.deepEqual(lintSubject('fix(anything): a thing', { scopes: null }), [], '--any-scope accepts any scope');
  assert.deepEqual(lintSubject('fix(cli): a thing\n\nA body.\n\nCo-Authored-By: X <x@example.invalid>'), [], 'only the first line is judged');
  assert.ok(SCOPES.includes('core') && TYPES.includes('feat'));
});

test('a range reports the commits that fail, merges excluded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-lint-commits-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  try {
    g('init', '-q', '-b', 'main');
    g('config', 'user.name', 'Test'); g('config', 'user.email', 'test@example.invalid'); g('config', 'commit.gpgsign', 'false');
    const commit = (msg) => { writeFileSync(join(dir, `${Math.random()}.txt`), msg); g('add', '-A'); g('commit', '-q', '-m', msg); };
    commit('chore: start');
    const base = g('rev-parse', 'HEAD');
    g('switch', '-q', '-c', 'feat/x');
    commit('feat(cli): good');
    commit('oops forgot');
    g('switch', '-q', 'main'); commit('docs: on main'); g('switch', '-q', 'feat/x');
    g('merge', '-q', '--no-ff', '-m', 'Merge main into feat/x', 'main');
    const bad = lintRange(dir, `${base}..HEAD`);
    assert.equal(bad.length, 1, JSON.stringify(bad));
    assert.equal(bad[0].subject, 'oops forgot');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
