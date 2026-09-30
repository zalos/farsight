// The git history reader in `shared/git.ts`, against a real repository built here:
// a byte-identical rename, an edited rename, a delete, a binary file, a merge, an
// empty commit and a subject full of quotes and tabs. The point of every test is
// the same posture — an environment fact (no repository, no commits, a shallow
// clone, a detached HEAD) comes back as a value that says which, never as a throw
// and never as a silent empty list.
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  gitLog, gitTags, gitShallow, gitHeadRef, gitHead, gitPrefix, normalizeRepoPath, DEFAULT_MAX_COMMITS,
} from '../dist/shared/git.js';
import type { GitCommit, GitFileChange } from '../dist/shared/git.js';

// ---------------------------------------------------------------- the fixture

/** A throwaway directory that cleans itself up when the test process exits. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** git, with identity and signing pinned locally so this works on any machine. */
function git(dir: string, args: string[], at?: string): string {
  const env = { ...process.env, ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}) };
  return execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], {
    env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30_000,
  }).trim();
}

function write(dir: string, rel: string, body: string | Buffer): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

function commit(dir: string, subject: string, at: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', subject], at);
}

const T1 = '2026-01-01T00:00:00+0000';
const T2 = '2026-02-01T00:00:00+0000';
const T3 = '2026-02-02T00:00:00+0000';
const T4 = '2026-03-01T00:00:00+0000';
const T5 = '2026-04-01T00:00:00+0000';

/** 20 lines, so a one-line edit renames at a high-but-not-perfect similarity. */
const LINES = (tag: string) => Array.from({ length: 20 }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';
/** Real NUL bytes, which is how git itself decides a file is binary. */
const BINARY = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n'), Buffer.alloc(64), Buffer.from([1, 2, 3, 0, 255])]);
/** A subject that would shift a field in any whitespace- or line-delimited format. */
const NASTY = 'feat(x): "quoted"\tand\ttabbed — ünïcode %s %H | a|pipe';

/**
 * Five commits and a merge:
 *   c1  adds src/a.ts, src/b.ts, src/gone.ts, assets/logo.png, "docs/notes and more.md"
 *   c2  renames a.ts byte-identically, renames b.ts with one line changed,
 *       deletes gone.ts, edits the notes, rewrites the binary
 *   side (branched off c1) adds one file        → merged back with --no-ff
 *   c5  an empty commit
 */
function fixture(): string {
  const dir = tempDir('farsight-git-');
  git(dir, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(dir, ['config', 'user.email', 'fixture@farsight.test']);
  git(dir, ['config', 'user.name', 'Farsight Fixture']);

  write(dir, 'src/a.ts', LINES('a'));
  write(dir, 'src/b.ts', LINES('b'));
  write(dir, 'src/gone.ts', '// nothing like the other files\nexport const gone = true;\n');
  write(dir, 'assets/logo.png', BINARY);
  write(dir, 'docs/notes and more.md', 'one\ntwo\n');
  write(dir, '.github/workflows/ci.yml', 'name: ci\n'); // a dotfile: a leading dot is a real path, not a spelling to strip
  commit(dir, 'feat: the first commit', T1);
  const c1 = git(dir, ['rev-parse', 'HEAD']);

  mkdirSync(join(dir, 'src/moved'), { recursive: true }); // git mv needs the destination to exist
  git(dir, ['mv', 'src/a.ts', 'src/moved/a.ts']);
  git(dir, ['mv', 'src/b.ts', 'src/moved/b.ts']);
  write(dir, 'src/moved/b.ts', LINES('b').replace('export const b7 = 7;', 'export const b7 = 70; // edited'));
  git(dir, ['rm', '-q', 'src/gone.ts']);
  write(dir, 'docs/notes and more.md', 'one\ntwo\nthree\nfour\n');
  write(dir, 'assets/logo.png', Buffer.concat([BINARY, Buffer.alloc(16, 7)]));
  commit(dir, NASTY, T2);

  git(dir, ['checkout', '-q', '-b', 'side', c1]);
  write(dir, 'src/side.ts', 'export const side = 1;\n');
  commit(dir, 'feat: the side branch', T3);
  git(dir, ['checkout', '-q', 'main']);
  git(dir, ['merge', '-q', '--no-ff', '-m', 'merge: the side branch', 'side'], T4);

  git(dir, ['commit', '-q', '--allow-empty', '-m', 'chore: an empty commit'], T5);

  git(dir, ['tag', '1.0.0', c1]);                                    // lightweight, bare semver
  git(dir, ['tag', '-a', 'v1.1.0', '-m', 'release 1.1.0'], T5);      // annotated, v-prefixed
  git(dir, ['tag', 'nightly']);                                      // neither scheme
  return dir;
}

const REPO = fixture();

/** The commits, by the subject each was made with — index would be brittle. */
function commits(dir = REPO, opts: Parameters<typeof gitLog>[1] = {}): Map<string, GitCommit> {
  const log = gitLog(dir, opts);
  assert.equal(log.available, true, `gitLog should be available: ${JSON.stringify(log)}`);
  assert.ok(log.available);
  return new Map(log.commits.map((c) => [c.subject, c]));
}

function fileAt(c: GitCommit, path: string): GitFileChange {
  const row = c.files.find((f) => f.path === path);
  assert.ok(row, `${path} missing from ${c.subject}: ${c.files.map((f) => f.path).join(', ')}`);
  return row;
}

// ------------------------------------------------------------------ the walk

test('gitLog: commits carry identity, author time, parents and the merge flag', () => {
  const all = commits();
  assert.deepEqual(
    [...all.keys()],
    ['chore: an empty commit', 'merge: the side branch', 'feat: the side branch', NASTY, 'feat: the first commit'],
    'newest first, and the nasty subject survived the NUL-delimited format intact',
  );
  const first = all.get('feat: the first commit')!;
  assert.match(first.sha, /^[0-9a-f]{40}$/);
  assert.deepEqual(first.parents, [], 'a root commit has no parents');
  assert.equal(first.merge, false);
  assert.equal(first.at, Date.parse(T1) / 1000, 'author time in unix seconds');
  assert.equal(first.author, 'Farsight Fixture');
  assert.equal(first.email, 'fixture@farsight.test');

  const merge = all.get('merge: the side branch')!;
  assert.equal(merge.parents.length, 2);
  assert.equal(merge.merge, true);
  assert.deepEqual(merge.files, [], 'git shows no diff for a merge, so the file list is honestly empty');
});

test('gitLog: an empty commit is an empty file list, not a failure', () => {
  const empty = commits().get('chore: an empty commit')!;
  assert.equal(empty.merge, false);
  assert.deepEqual(empty.files, []);
});

test('gitLog: a byte-identical rename scores 100 and keeps its old path', () => {
  const row = fileAt(commits().get(NASTY)!, 'src/moved/a.ts');
  assert.equal(row.status, 'R');
  assert.equal(row.oldPath, 'src/a.ts');
  assert.equal(row.similarity, 100, 'the R100 case: the same file under a new path');
  assert.equal(row.added, 0);
  assert.equal(row.deleted, 0);
  assert.equal(row.binary, false);
});

test('gitLog: an edited rename keeps its old path and scores below 100', () => {
  const row = fileAt(commits().get(NASTY)!, 'src/moved/b.ts');
  assert.equal(row.status, 'R');
  assert.equal(row.oldPath, 'src/b.ts');
  assert.ok(row.similarity! >= 50 && row.similarity! < 100, `similarity ${row.similarity} should be a real score`);
  assert.equal(row.added, 1, 'the one line that changed');
  assert.equal(row.deleted, 1);
});

test('gitLog: a delete is D with the lines it removed and nothing added', () => {
  const row = fileAt(commits().get(NASTY)!, 'src/gone.ts');
  assert.equal(row.status, 'D');
  assert.equal(row.oldPath, undefined, 'a delete is not a rename, so it has no old path');
  assert.equal(row.similarity, undefined);
  assert.equal(row.added, 0);
  assert.equal(row.deleted, 2);
});

test('gitLog: an add and a modify carry their counts', () => {
  const added = fileAt(commits().get('feat: the first commit')!, 'src/a.ts');
  assert.equal(added.status, 'A');
  assert.equal(added.added, 20);
  assert.equal(added.deleted, 0);

  // A path with spaces: `-z` means it is never quoted, so it needs no unescaping.
  const edited = fileAt(commits().get(NASTY)!, 'docs/notes and more.md');
  assert.equal(edited.status, 'M');
  assert.equal(edited.added, 2);
  assert.equal(edited.deleted, 0);
});

test('gitLog: a binary file reports that its counts are unknowable, not zero', () => {
  for (const [subject, status] of [['feat: the first commit', 'A'], [NASTY, 'M']] as const) {
    const row = fileAt(commits().get(subject)!, 'assets/logo.png');
    assert.equal(row.status, status);
    assert.equal(row.binary, true, 'numstat said `-`');
    assert.equal(row.added, undefined, 'a binary file must not report 0 added — 0 is a measurement');
    assert.equal(row.deleted, undefined);
  }
});

test('gitLog: paths are repo-root-relative even when read from a subdirectory', () => {
  // The monorepo trap (§8): a source rooted at a subdirectory must still get
  // repo-root-relative paths, or the join onto `loc.path` is silently wrong.
  const fromSub = commits(join(REPO, 'src'));
  const row = fileAt(fromSub.get('feat: the first commit')!, 'docs/notes and more.md');
  assert.equal(row.status, 'A');
  for (const c of fromSub.values()) {
    for (const f of c.files) {
      assert.doesNotMatch(f.path, /^\//, `${f.path} must not be absolute`);
      assert.doesNotMatch(f.path, /^\.\//, `${f.path} must not be prefixed with ./`);
      assert.doesNotMatch(f.path, /\\/, 'forward slashes only, so it can join loc.path');
      assert.notEqual(f.path, '', 'a rename never leaves numstat\'s empty path field behind');
    }
  }
  // A dotfile is a legitimate repo-relative path and must survive untouched.
  assert.equal(fileAt(fromSub.get('feat: the first commit')!, '.github/workflows/ci.yml').status, 'A');
});

// ------------------------------------------------------------------ the bounds

test('gitLog: max bounds the walk and truncated is exact at the boundary', () => {
  const two = gitLog(REPO, { max: 2 });
  assert.ok(two.available);
  assert.equal(two.commits.length, 2);
  assert.equal(two.truncated, true, 'older commits exist and were not read');
  assert.equal(two.max, 2);

  const all = gitLog(REPO, { max: 5 });
  assert.ok(all.available);
  assert.equal(all.commits.length, 5);
  assert.equal(all.truncated, false, 'exactly as many commits as the cap is not truncation');

  const defaulted = gitLog(REPO);
  assert.ok(defaulted.available);
  assert.equal(defaulted.max, DEFAULT_MAX_COMMITS, 'the default is bounded, never the whole history');
  assert.equal(defaulted.truncated, false);
});

test('gitLog: since bounds the walk by date', () => {
  const recent = gitLog(REPO, { since: '2026-03-15T00:00:00+0000' });
  assert.ok(recent.available);
  assert.deepEqual(recent.commits.map((c) => c.subject), ['chore: an empty commit']);
});

// ------------------------------------------------------- the absences, by name

test('gitLog: a directory that is not a repository says so and does not throw', () => {
  const dir = tempDir('farsight-notrepo-');
  const log = gitLog(dir);
  assert.equal(log.available, false);
  assert.ok(!log.available);
  assert.equal(log.reason, 'not-a-repo');
  assert.match(log.detail ?? '', /not a git repository/, "git's own words, so a surface can quote them");
});

test('gitLog: a directory that does not exist is an absence, not a crash', () => {
  const log = gitLog(join(tempDir('farsight-missing-'), 'nope', 'nope'));
  assert.equal(log.available, false);
  assert.ok(!log.available);
  assert.equal(log.reason, 'not-a-repo');
});

test('gitLog: a repository with no commits reads no-commits, not an empty history', () => {
  const dir = tempDir('farsight-empty-');
  git(dir, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  const log = gitLog(dir);
  assert.equal(log.available, false);
  assert.ok(!log.available);
  assert.equal(log.reason, 'no-commits', 'distinguishable from "no repository" and from "zero commits touched this"');
  assert.equal(gitTags(dir).available, false, 'there is no tag to read either');
  // Shallowness is knowable without a commit, so this one deliberately answers.
  const shallow = gitShallow(dir);
  assert.ok(shallow.available);
  assert.equal(shallow.shallow, false);
});

test('gitLog: a missing git binary is its own reason, not a failed repository', () => {
  const path = process.env['PATH'];
  try {
    process.env['PATH'] = ''; // the binary cannot be found at all
    const log = gitLog(REPO);
    assert.equal(log.available, false);
    assert.ok(!log.available);
    assert.equal(log.reason, 'no-git', 'the tool is missing — the repository is fine');
    assert.equal(gitHead(REPO), undefined, 'and the cli.ts contract still returns a value');
  } finally {
    if (path === undefined) delete process.env['PATH']; else process.env['PATH'] = path;
  }
});

// ------------------------------------------------------------------- the tags

test('gitTags: annotated and lightweight tags both dereference to commits, with the scheme each spells', () => {
  const tags = gitTags(REPO);
  assert.ok(tags.available);
  const by = new Map(tags.tags.map((t) => [t.name, t]));
  assert.deepEqual([...by.keys()].sort(), ['1.0.0', 'nightly', 'v1.1.0']);

  const bare = by.get('1.0.0')!;
  assert.equal(bare.annotated, false);
  assert.equal(bare.scheme, 'bare-semver');
  assert.equal(bare.sha, commits().get('feat: the first commit')!.sha, 'the commit it names');
  assert.equal(bare.at, Date.parse(T1) / 1000);

  const annotated = by.get('v1.1.0')!;
  assert.equal(annotated.annotated, true);
  assert.equal(annotated.scheme, 'v-prefixed', 'a real repository carries both schemes at once — hence a declared release');
  assert.equal(annotated.sha, commits().get('chore: an empty commit')!.sha, 'dereferenced past the tag object');
  assert.notEqual(annotated.sha, git(REPO, ['rev-parse', 'v1.1.0']), 'the tag object sha is not the commit sha');

  assert.equal(by.get('nightly')!.scheme, 'other');
});

// -------------------------------------------------------- shallow and the head

test('gitShallow: a full repository is not shallow, a --depth 1 clone is', () => {
  const full = gitShallow(REPO);
  assert.ok(full.available);
  assert.equal(full.shallow, false);

  const dest = join(tempDir('farsight-shallow-'), 'clone');
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${REPO}`, dest], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  });
  const shallow = gitShallow(dest);
  assert.ok(shallow.available);
  assert.equal(shallow.shallow, true, 'so "first seen in" can only be a floor: at or before this sha');
  const log = gitLog(dest);
  assert.ok(log.available);
  assert.equal(log.commits.length, 1, 'the clone holds one commit and the reader does not pretend otherwise');

  const none = gitShallow(tempDir('farsight-notrepo2-'));
  assert.equal(none.available, false);
});

test('gitHeadRef: a branch, and a detached HEAD that still has a sha', () => {
  const on = gitHeadRef(REPO);
  assert.ok(on.available);
  assert.equal(on.ref, 'main');
  assert.equal(on.detached, false);
  assert.equal(on.sha, commits().get('chore: an empty commit')!.sha);

  // Detach in a clone so the fixture every other test reads stays on its branch.
  const dest = join(tempDir('farsight-detached-'), 'clone');
  execFileSync('git', ['clone', '-q', `file://${REPO}`, dest], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  const first = commits().get('feat: the first commit')!.sha;
  git(dest, ['checkout', '-q', first]);
  const off = gitHeadRef(dest);
  assert.ok(off.available);
  assert.equal(off.detached, true, 'no symbolic ref: the walk is one ancestry, and titles must say so');
  assert.equal(off.ref, undefined);
  assert.equal(off.sha, first, 'a sync can still record the commit it looked at');

  const none = gitHeadRef(tempDir('farsight-notrepo3-'));
  assert.equal(none.available, false);
  assert.ok(!none.available);
  assert.equal(none.reason, 'not-a-repo');
});

test('gitHead: the cli.ts contract is unchanged — a sha, or undefined, never a throw', () => {
  assert.equal(gitHead(REPO), commits().get('chore: an empty commit')!.sha);
  assert.equal(gitHead(tempDir('farsight-notrepo4-')), undefined);
  assert.equal(gitHead(join(REPO, 'src')), gitHead(REPO), 'a subdirectory reports the repository it is in');
});

// ------------------------------------------------------------------- the paths

test('normalizeRepoPath: repo-relative, forward slashes, no leading dot', () => {
  assert.equal(normalizeRepoPath('./src/a.ts'), 'src/a.ts');
  assert.equal(normalizeRepoPath('src\\win\\a.ts'), 'src/win/a.ts');
  assert.equal(normalizeRepoPath('  src//a.ts \n'), 'src/a.ts');
  assert.equal(normalizeRepoPath('docs/notes and more.md'), 'docs/notes and more.md');
});

test('gitPrefix: where a source sits inside its repository — the monorepo join, or the absence that says why', () => {
  // The other half of the §8 trap. `gitLog` hands back repo-root-relative paths
  // (the test above), so a source rooted at a subdirectory needs this prefix or
  // the join onto `loc.path` finds nothing and prints an empty commit list — a
  // claim ("nothing touched this file") it has no evidence for.
  const top = gitPrefix(REPO);
  assert.ok(top.available);
  assert.equal(top.prefix, '', 'the repository root has no prefix');

  const sub = gitPrefix(join(REPO, 'src'));
  assert.ok(sub.available);
  assert.equal(sub.prefix, 'src/', "git's own spelling, trailing slash and all");
  // it composes exactly as the attribution join needs it to
  assert.equal(`${sub.prefix}a.ts`.replace(/\/{2,}/g, '/'), 'src/a.ts');

  const nowhere = gitPrefix(tempDir('farsight-git-noprefix-'));
  assert.equal(nowhere.available, false);
  assert.equal(nowhere.available === false && nowhere.reason, 'not-a-repo');
});
