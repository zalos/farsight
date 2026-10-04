// scripts/changelog.mjs against throwaway git repositories made here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommit, readCommits, resolveSince, changelog, prependSection, UNRELEASED_HEAD } from '../changelog.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'changelog.mjs');
const URL = 'https://github.com/example/repo';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-changelog-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'tag.gpgsign', 'false');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }, null, 2) + '\n');
  let n = 0;
  const commit = (message) => {
    writeFileSync(join(dir, `f${n++}.txt`), message);
    g('add', '-A');
    g('commit', '-q', '-m', message);
    return g('rev-parse', 'HEAD');
  };
  return { dir, g, commit, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('parses type, scope, bang and the BREAKING CHANGE footer', () => {
  assert.deepEqual(
    (({ group, scope, subject, breaking }) => ({ group, scope, subject, breaking }))(parseCommit({ sha: 'a', short: 'a', subject: 'feat(cli): add release' })),
    { group: 'feat', scope: 'cli', subject: 'add release', breaking: false },
  );
  assert.equal(parseCommit({ sha: 'a', short: 'a', subject: 'fix!: drop flag' }).group, 'breaking');
  const footer = parseCommit({ sha: 'a', short: 'a', subject: 'refactor(core): rename', body: 'Why.\n\nBREAKING CHANGE: graph.json v2 only' });
  assert.equal(footer.group, 'breaking');
  assert.equal(footer.breakingNote, 'graph.json v2 only');
  assert.equal(parseCommit({ sha: 'a', short: 'a', subject: 'ci: cache pnpm' }).group, 'chore');
  assert.equal(parseCommit({ sha: 'a', short: 'a', subject: 'KAN-5: not conventional' }).group, 'other');
  const squash = parseCommit({ sha: 'a', short: 'a', subject: 'feat(cli): a thing (#58)' });
  assert.equal(squash.subject, 'a thing', 'a squash subject loses its PR suffix');
  assert.equal(squash.pr, 58);
  assert.equal(parseCommit({ sha: 'a', short: 'a', subject: 'fix: no pr' }).pr, null);
  const rel = parseCommit({ sha: 'a', short: 'a', subject: 'chore(release): v0.2.1 (#38)' });
  assert.equal(rel.scope, 'release');
  assert.equal(rel.subject, 'v0.2.1', 'a squashed release commit is still a release commit');
  assert.equal(parseCommit({ sha: 'a', short: 'a', subject: 'Initial commit' }).subject, 'Initial commit');
});

test('groups a whole history, skips merges, links each commit', () => {
  const r = repo();
  try {
    r.commit('Initial commit');
    r.g('checkout', '-q', '-b', 'feat/x');
    r.commit('feat(cli): add the thing');
    r.commit('fix(core)!: stop guessing');
    r.g('checkout', '-q', 'main');
    r.commit('docs: explain');
    r.g('merge', '-q', '--no-ff', '-m', "Merge branch 'feat/x'", 'feat/x');
    r.commit('test(parsers): cover it\n\nBREAKING CHANGE: nothing really');
    const out = changelog(r.dir, { repoUrl: URL, date: '2026-01-02' });
    assert.equal(out.version, '0.1.0');
    assert.equal(out.since, null);
    assert.equal(out.commits.length, 5, 'the merge commit is skipped');
    const s = out.section;
    assert.match(s, /^## \[0\.1\.0\] — 2026-01-02\n/);
    const order = ['### Breaking', '### Features', '### Docs', '### Other'].map((h) => s.indexOf(h));
    assert.ok(order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), s);
    assert.doesNotMatch(s, /### Fixes/, 'a breaking fix is listed once, under Breaking');
    assert.match(s, /- \*\*core:\*\* stop guessing \(\[[0-9a-f]{7,}\]\(https:\/\/github\.com\/example\/repo\/commit\/[0-9a-f]{40}\)\)/);
    assert.match(s, /- \*\*parsers:\*\* cover it — nothing really/);
    assert.doesNotMatch(s, /Merge branch/);
    assert.match(out.notes, /### Install\n\n```sh\nnpm install -g https:\/\/github\.com\/example\/repo\/releases\/download\/v0\.1\.0\/farsight-cli-0\.1\.0\.tgz\nfarsight --version/);
    assert.match(out.notes, /docs\/GETTING-STARTED\.md/);
  } finally { r.done(); }
});

test('starts at the last tag, and drops release commits', () => {
  const r = repo();
  try {
    r.commit('feat: one');
    r.commit('chore(release): v0.1.0');
    r.g('tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
    r.commit('fix: two');
    r.commit('chore(deps): bump');
    assert.equal(resolveSince(r.dir), 'v0.1.0');
    const subjects = readCommits(r.dir, 'v0.1.0').map((c) => c.subject);
    assert.deepEqual(subjects, ['two', 'bump']);
    assert.deepEqual(changelog(r.dir, { since: r.g('rev-list', '--max-parents=0', 'HEAD') }).commits.map((c) => c.subject), ['two', 'bump'], 'an explicit --since wins, and the release commit is still dropped');
  } finally { r.done(); }
});

test('without a tag, starts after the commit that seeded the newest released section', () => {
  const r = repo();
  try {
    r.commit('feat: before the seed');
    writeFileSync(join(r.dir, 'CHANGELOG.md'), prependSection(null, '## [0.1.0] — 2026-01-01\n\n- seeded\n', '0.1.0'));
    r.g('add', 'CHANGELOG.md');
    r.g('commit', '-q', '-m', 'docs: seed the changelog');
    const seed = r.g('rev-parse', 'HEAD');
    r.commit('feat: after the seed');
    assert.equal(resolveSince(r.dir), seed);
    assert.deepEqual(changelog(r.dir, {}).commits.map((c) => c.subject), ['after the seed']);
  } finally { r.done(); }
});

test('--write keeps an [Unreleased] head above the new section; --notes writes the body; a repeat is refused', () => {
  const r = repo();
  try {
    r.commit('feat(cli): first');
    const run = (...args) => execFileSync(process.execPath, [SCRIPT, ...args], { cwd: r.dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    run('--version', '0.1.0', '--write', '--repo-url', URL, '--date', '2026-01-01');
    r.g('add', 'CHANGELOG.md');
    r.g('commit', '-q', '-m', 'chore(release): v0.1.0');
    r.g('tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
    r.commit('fix(core): second');
    const notes = join(r.dir, 'notes.md');
    run('--version', '0.1.1', '--write', '--notes', notes, '--repo-url', URL, '--date', '2026-01-02');
    const text = readFileSync(join(r.dir, 'CHANGELOG.md'), 'utf8');
    assert.ok(text.startsWith('# Changelog'));
    const at = (s) => text.indexOf(s);
    assert.ok(at(UNRELEASED_HEAD) > 0 && at(UNRELEASED_HEAD) < at('## [0.1.1]') && at('## [0.1.1]') < at('## [0.1.0]'), text);
    assert.equal(text.split(UNRELEASED_HEAD).length, 2, 'one Unreleased head');
    assert.match(text.slice(at('## [0.1.1]'), at('## [0.1.0]')), /second/);
    assert.doesNotMatch(text.slice(at('## [0.1.1]'), at('## [0.1.0]')), /first/);
    assert.match(readFileSync(notes, 'utf8'), /v0\.1\.1\/farsight-cli-0\.1\.1\.tgz/);
    assert.throws(() => run('--version', '0.1.1', '--write', '--repo-url', URL), /already has a section/);
    const dry = run('--dry-run', '--version', '0.1.2', '--repo-url', URL);
    assert.match(dry, /## \[0\.1\.2\]/);
    assert.match(dry, /### Install/);
  } finally { r.done(); }
});
