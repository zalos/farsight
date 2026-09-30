// Work-item keys on the commit spine (docs/proposals/work-items-sync.md §9):
// gitLog reads message bodies and key-bearing branches; commitInputsOf turns
// them into commit_key rows with how each key was found. A real `git init`
// repository in a temp directory. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { gitLog, gitShowPatch, commitInputsOf, ingestRepo } from '../dist/index.js';
import { parseDoc as parseDocShared } from '../dist/shared/docs.js';
import { hunksOfPatch } from '@farsight/core';

function git(dir: string, args: string[], at?: string): string {
  const env = { ...process.env, ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}) };
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function write(dir: string, rel: string, body: string) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
}
function commit(dir: string, message: string, at: string): string {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', message], at);
  return git(dir, ['rev-parse', 'HEAD']);
}

/**
 * main:  KAN-1 subject · URL in a body · SHA-256 and #12 negatives · a --no-ff merge of feature/KAN-3-merged
 * feature/KAN-2-open: one unmerged commit with a plain subject (only its branch names the key)
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-work-keys-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Fixture']);
  git(dir, ['config', 'user.email', 'f@example.com']);
  const sha: Record<string, string> = {};
  write(dir, 'src/a.ts', 'export function one() {\n  return 1;\n}\n');
  sha.root = commit(dir, 'initial', '2026-01-01T00:00:00Z');
  write(dir, 'src/a.ts', 'export function one() {\n  return 11;\n}\n\nexport function two() {\n  return 2;\n}\n');
  sha.subject = commit(dir, 'KAN-1: add two', '2026-01-02T00:00:00Z');
  write(dir, 'src/b.ts', 'export const b = 1;\n');
  sha.url = commit(dir, 'tidy b\n\nRefs https://example.atlassian.net/browse/KAN-5 for context', '2026-01-03T00:00:00Z');
  write(dir, 'src/c.ts', 'export const c = 1;\n');
  sha.negatives = commit(dir, 'bump SHA-256 helper, fix #12, screen INV-01', '2026-01-04T00:00:00Z');

  git(dir, ['checkout', '-q', '-b', 'feature/KAN-3-merged']);
  write(dir, 'src/d.ts', 'export const d = 1;\n');
  sha.merged = commit(dir, 'work on d', '2026-01-05T00:00:00Z');
  git(dir, ['checkout', '-q', 'main']);
  git(dir, ['merge', '-q', '--no-ff', '--no-edit', 'feature/KAN-3-merged'], '2026-01-06T00:00:00Z');
  sha.merge = git(dir, ['rev-parse', 'HEAD']);

  git(dir, ['checkout', '-q', '-b', 'feature/kan-2-open']);
  write(dir, 'src/e.ts', 'export const e = 1;\n');
  sha.open = commit(dir, 'start e', '2026-01-07T00:00:00Z');
  git(dir, ['checkout', '-q', 'main']);
  return { dir, sha };
}

const opts = { projects: ['KAN'] };
const keep = (name: string) => /kan-\d+/i.test(name);

test('gitLog reads bodies, walks key-bearing branches, and attributes branch and merge commits', () => {
  const { dir, sha } = fixture();
  const log = gitLog(dir, { keyRefs: keep });
  assert.equal(log.available, true);
  if (!log.available) return;
  const by = new Map(log.commits.map((c) => [c.sha, c]));
  assert.ok(by.has(sha.open!), 'an unmerged key-bearing branch is walked, not only HEAD');
  assert.match(by.get(sha.url!)!.body, /browse\/KAN-5/);
  assert.deepEqual(by.get(sha.open!)!.branches, [{ ref: 'feature/kan-2-open', via: 'branch' }]);
  assert.deepEqual(by.get(sha.merged!)!.branches, [{ ref: 'feature/KAN-3-merged', via: 'merge' }]);
  assert.deepEqual(log.branchBase, { ref: 'main' });
});

test('a local main ahead of its remote keeps its own commits: a branch cut from it is measured against every default branch', () => {
  const { dir, sha } = fixture();
  // a clone whose origin lacks the newest main commit (not pushed yet), and a key branch cut after it
  const clone = mkdtempSync(join(tmpdir(), 'farsight-work-keys-clone-'));
  process.on('exit', () => rmSync(clone, { recursive: true, force: true }));
  git(clone, ['clone', '-q', dir, '.']);
  git(clone, ['config', 'user.name', 'F']);
  git(clone, ['config', 'user.email', 'f@example.com']);
  write(clone, 'src/z.ts', 'export const z = 1;\n');
  const local = commit(clone, 'KAN-1: local only', '2026-02-01T00:00:00Z');
  git(clone, ['checkout', '-q', '-b', 'feature/KAN-8-x']);
  write(clone, 'src/y.ts', 'export const y = 1;\n');
  const own = commit(clone, 'branch work', '2026-02-02T00:00:00Z');
  git(clone, ['checkout', '-q', 'main']);
  const log = gitLog(clone, { keyRefs: keep });
  assert.ok(log.available);
  if (!log.available) return;
  const by = new Map(log.commits.map((c) => [c.sha, c]));
  assert.equal(by.get(local)!.branches, undefined, 'local main is a default branch too — its commit is not the branch\'s');
  assert.deepEqual(by.get(own)!.branches, [{ ref: 'feature/KAN-8-x', via: 'branch' }]);
  assert.ok(sha.root);
  assert.equal(by.get(sha.merge!)!.files.length, 0, 'the merge commit itself carries no files — which is why its branch commits are attributed');
});

test('commitInputsOf: every key with how it was found — and SHA-256, #12 and a screen name are not keys', () => {
  const { dir, sha } = fixture();
  const log = gitLog(dir, { keyRefs: keep });
  assert.ok(log.available);
  if (!log.available) return;
  const inputs = new Map(commitInputsOf(log.commits, { opts }).map((c) => [c.sha, c]));
  const keys = (s: string) => (inputs.get(s)!.keys ?? []).map((k) => `${k.key}:${k.via}${k.ref ? `@${k.ref}` : ''}`);
  assert.deepEqual(keys(sha.subject!), ['KAN-1:subject']);
  assert.deepEqual(keys(sha.url!), ['KAN-5:url']);
  assert.deepEqual(keys(sha.negatives!), [], 'no ADO source, no INV project: nothing here is a work item');
  assert.deepEqual(keys(sha.merge!), ['KAN-3:merge-subject@feature/KAN-3-merged']);
  assert.deepEqual(keys(sha.merged!), ['KAN-3:merge-subject@feature/KAN-3-merged']);
  assert.deepEqual(keys(sha.open!), ['KAN-2:branch@feature/kan-2-open']);
  assert.deepEqual(inputs.get(sha.open!)!.branches, ['feature/kan-2-open']);
  // with an Azure DevOps source configured, #12 becomes a key; without keys asked for, none are claimed
  const ado = commitInputsOf(log.commits, { opts: { ...opts, ado: true } }).find((c) => c.sha === sha.negatives)!;
  assert.deepEqual(ado.keys!.map((k) => k.key), ['12']);
  assert.equal(commitInputsOf(log.commits).find((c) => c.sha === sha.subject)!.keys, undefined, 'a plain read claims nothing about keys');
});

test('gitLog after: an incremental read walks only what is new', () => {
  const { dir, sha } = fixture();
  const log = gitLog(dir, { after: sha.negatives });
  assert.ok(log.available);
  if (!log.available) return;
  assert.ok(!log.commits.some((c) => c.sha === sha.subject), 'already-read commits are not walked again');
  assert.ok(log.commits.some((c) => c.sha === sha.merge));
});

test('gitShowPatch: the patch a commit made, zero context, and its hunks', () => {
  const { dir, sha } = fixture();
  const p = gitShowPatch(dir, sha.subject!);
  assert.ok(p.available);
  if (!p.available) return;
  assert.match(p.patch, /\+\+\+ b\/src\/a\.ts/);
  const hunks = hunksOfPatch(p.patch);
  assert.equal(hunks[0]!.path, 'src/a.ts');
  assert.ok(hunks[0]!.ranges.length >= 1);
  const bad = gitShowPatch(dir, 'not-a-sha; rm -rf');
  assert.equal(bad.available, false);
});

test('@work is the sixth Farsight tag: work:<KEY> tags on the node, a stray word refused', () => {
  const d = parseDocShared('Submit the invoice.\n@work KAN-3, AB#40 not-a-key\n@business Sends it.');
  assert.deepEqual(d.work, ['KAN-3']);
  assert.ok(d.tags.includes('work:KAN-3'));
  assert.equal(d.business, 'Sends it.');
});

test('@work reaches the graph through ingest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-work-tag-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'package.json', '{"name":"w"}');
  write(dir, 'src/submit.ts', '/**\n * Submit.\n * @work KAN-3\n */\nexport function submit() { return 1; }\n');
  const f = await ingestRepo(dir, { repoName: 'w' });
  const n = f.nodes.find((x) => x.name === 'submit')!;
  assert.ok(n.tags.includes('work:KAN-3'), JSON.stringify(n.tags));
});
