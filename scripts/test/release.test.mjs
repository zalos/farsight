// scripts/release.mjs: version arithmetic, and a real release against a throwaway repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextVersion, compareVersions } from '../release.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');

test('next versions', () => {
  assert.equal(nextVersion('0.1.0', { bump: 'patch' }), '0.1.1');
  assert.equal(nextVersion('0.1.3', { bump: 'minor' }), '0.2.0');
  assert.equal(nextVersion('0.1.3', { bump: 'major' }), '1.0.0');
  assert.equal(nextVersion('0.1.0', { bump: 'minor', prerelease: 'beta.1' }), '0.2.0-beta.1');
  assert.equal(nextVersion('1.0.0-beta.1', { bump: 'patch' }), '1.0.0', 'a bump finishes a prerelease');
  assert.equal(nextVersion('1.0.0-beta.1', { version: '1.0.0', prerelease: 'beta.2' }), '1.0.0-beta.2');
  assert.equal(nextVersion('0.1.0', { version: '2.3.4' }), '2.3.4');
  assert.throws(() => nextVersion('0.1.0', { bump: 'huge' }), /patch, minor or major/);
  assert.throws(() => nextVersion('0.1.0', { version: 'v1' }), /not a version/);
  assert.ok(compareVersions('1.0.0', '1.0.0-beta.2') > 0);
  assert.ok(compareVersions('1.0.0-beta.10', '1.0.0-beta.2') > 0);
  assert.ok(compareVersions('0.1.1', '0.1.0') > 0);
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-release-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'tag.gpgsign', 'false');
  mkdirSync(join(dir, 'scripts'));
  for (const f of ['release.mjs', 'changelog.mjs']) copyFileSync(join(SCRIPTS, f), join(dir, 'scripts', f));
  writeFileSync(join(dir, 'package.json'), '{\n  "name": "x",\n  "version": "0.1.0",\n  "private": true\n}\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'chore: start');
  const run = (...args) => execFileSync(process.execPath, ['scripts/release.mjs', '--repo-url', 'https://github.com/example/repo', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GITHUB_OUTPUT: '' } }).toString();
  return { dir, g, run, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a release bumps, writes the changelog, commits and tags — and does not push', () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, 'a.txt'), 'a');
    r.g('add', 'a.txt');
    r.g('commit', '-q', '-m', 'feat(cli): something new');

    const dry = r.run('--dry-run', '--bump', 'minor');
    assert.match(dry, /0\.1\.0 → 0\.2\.0/);
    assert.match(dry, /something new/);
    assert.equal(r.g('status', '--porcelain'), '', 'a dry run writes nothing');

    const notes = join(r.dir, '..', `${r.dir.split('/').pop()}-notes.md`);
    const out = r.run('--bump', 'minor', '--notes-out', notes, '--trailer', 'Co-Authored-By: Someone <someone@example.invalid>');
    assert.match(out, /released v0\.2\.0 locally/);
    assert.match(out, /git push --follow-tags origin main/);
    assert.equal(JSON.parse(readFileSync(join(r.dir, 'package.json'), 'utf8')).version, '0.2.0');
    assert.match(readFileSync(join(r.dir, 'package.json'), 'utf8'), /^\{\n  "name": "x",\n  "version": "0.2.0",\n  "private": true\n\}\n$/, 'formatting kept');
    assert.match(readFileSync(join(r.dir, 'CHANGELOG.md'), 'utf8'), /## \[Unreleased\][\s\S]*## \[0\.2\.0\] — \d{4}-\d\d-\d\d[\s\S]*something new/);
    assert.equal(r.g('log', '-1', '--format=%s'), 'chore(release): v0.2.0');
    assert.match(r.g('log', '-1', '--format=%b'), /^Co-Authored-By: Someone/m);
    assert.equal(r.g('cat-file', '-t', 'v0.2.0'), 'tag', 'annotated');
    const tagMessage = r.g('tag', '-l', '--format=%(contents)', 'v0.2.0');
    assert.match(tagMessage, /### Features/, 'Markdown headings survive in the tag message');
    assert.match(tagMessage, /releases\/download\/v0\.2\.0\/farsight-cli-0\.2\.0\.tgz/);
    assert.equal(readFileSync(notes, 'utf8').trim(), tagMessage.trim());
    rmSync(notes, { force: true });
    assert.equal(r.g('remote'), '', 'nothing to push to, and nothing pushed');

    // the next release starts at the tag and leaves the release commit out
    writeFileSync(join(r.dir, 'b.txt'), 'b');
    r.g('add', 'b.txt');
    r.g('commit', '-q', '-m', 'fix: a repair');
    const next = r.run('--dry-run', '--bump', 'patch');
    assert.match(next, /0\.2\.0 → 0\.2\.1 on main, 1 commit since v0\.2\.0/);
    assert.doesNotMatch(next, /- .*v0\.2\.0|something new/);
  } finally { r.done(); }
});

test('refuses a dirty tree, another branch, a used tag, and a version that does not move forward', () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, 'dirty.txt'), 'x');
    assert.throws(() => r.run('--bump', 'patch'), /working tree has changes/);
    assert.match(r.run('--dry-run', '--bump', 'patch'), /would refuse:[\s\S]*working tree has changes/);
    rmSync(join(r.dir, 'dirty.txt'));
    r.g('checkout', '-q', '-b', 'feat/x');
    assert.throws(() => r.run('--bump', 'patch'), /on branch feat\/x, not main/);
    r.g('tag', '-a', 'v0.1.1', '-m', 'taken');
    assert.throws(() => r.run('--bump', 'patch', '--allow-branch'), /tag v0\.1\.1 already exists/);
    assert.throws(() => r.run('--version', '0.1.0', '--allow-branch'), /not after the current version/);
    assert.match(r.run('--bump', 'minor', '--allow-branch', '--notes-out', join(r.dir, '..', `${r.dir.split('/').pop()}-n.md`)), /released v0\.2\.0/);
  } finally { r.done(); }
});
