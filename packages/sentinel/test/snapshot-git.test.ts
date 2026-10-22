// The pure TypeScript Git object reader against repositories the git CLI built: loose and packed objects, deltas,
// both object formats, refs, tags, linked worktrees, missing and corrupt objects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { GitReadError, GitRepository } from '../dist/snapshot/git.js';
import { commitRepo, git, gitBytes, scratch, writeTree } from './snapshot-helpers.ts';

/** Every path → blob bytes in a commit, read by our reader. */
function readAll(repo: GitRepository, commit: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string, oid: string) => {
    for (const e of repo.readTree(oid)!) {
      const path = rel ? `${rel}/${e.name.toString('utf8')}` : e.name.toString('utf8');
      if (e.mode === '40000') walk(path, e.oid);
      else out.set(path, repo.readObject(e.oid, 1 << 24)!.data.toString('base64'));
    }
  };
  walk('', repo.treeOf(commit));
  return out;
}

/** The same, from git itself. */
function gitAll(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of git(root, ['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean)) {
    const [meta, path] = line.split('\t') as [string, string];
    const oid = meta.split(' ')[2]!;
    out.set(path, gitBytes(root, ['cat-file', 'blob', oid]).toString('base64'));
  }
  return out;
}

function history(root: string): string {
  // Several versions of one large file so a repack stores deltas.
  const base = Array.from({ length: 400 }, (_, i) => `line ${i} of a synthetic source file\n`).join('');
  commitRepo(root, { 'src/big.ts': base, 'README.md': '# fixture\n', 'bin/data.bin': Buffer.from([0, 255, 13, 10, 128]) });
  for (let v = 1; v <= 4; v++) {
    writeTree(root, { 'src/big.ts': base.replace(`line ${v * 10} `, `line ${v * 10} changed `) + `tail ${v}\n` });
    git(root, ['commit', '--quiet', '-am', `v${v}`]);
  }
  return git(root, ['rev-parse', 'HEAD']).trim();
}

test('loose objects read exactly as git stores them', t => {
  const root = join(scratch(t), 'repo');
  const head = history(root);
  const repo = GitRepository.open(root);
  assert.equal(repo.algorithm, 'sha1');
  assert.equal(repo.resolveCommit(), head);
  assert.equal(repo.resolveCommit('refs/heads/main'), head);
  assert.equal(repo.resolveCommit(head), head);
  assert.deepEqual(readAll(repo, head), gitAll(root));
  repo.close();
});

test('packed objects and delta chains read identically, packed-refs resolve, annotated tags peel', t => {
  const root = join(scratch(t), 'repo');
  const head = history(root);
  git(root, ['tag', '-a', 'v1', '-m', 'release']);
  git(root, ['repack', '-a', '-d', '-f', '--depth=10', '--window=10', '--quiet']);
  git(root, ['pack-refs', '--all']);
  git(root, ['prune']);
  assert.equal(readdirSync(join(root, '.git/objects')).filter(n => /^[0-9a-f]{2}$/.test(n)).length, 0, 'every object is packed');
  const verify = git(root, ['verify-pack', '-v', ...readdirSync(join(root, '.git/objects/pack')).filter(n => n.endsWith('.idx')).map(n => join(root, '.git/objects/pack', n))]);
  assert.match(verify, /chain length = [1-9]/, 'the pack holds deltas');
  const repo = GitRepository.open(root);
  assert.equal(repo.resolveCommit('refs/heads/main'), head, 'from packed-refs');
  assert.equal(repo.resolveCommit('refs/tags/v1'), head, 'the annotated tag peels to its commit');
  assert.deepEqual(readAll(repo, head), gitAll(root));
  // Every historical version reads through its delta chain.
  for (const rev of git(root, ['rev-list', 'HEAD']).trim().split('\n')) assert.deepEqual(readAll(repo, rev).size, 3);
  repo.close();
});

test('a SHA-256 repository reads with 64-character ids', t => {
  const root = join(scratch(t), 'repo');
  const head = commitRepo(root, { 'a.ts': 'export const a = 1;\n', 'dir/b.java': 'class B {}\n' }, { objectFormat: 'sha256' });
  assert.equal(head.length, 64);
  const repo = GitRepository.open(root);
  assert.equal(repo.algorithm, 'sha256');
  assert.deepEqual(readAll(repo, repo.resolveCommit()), gitAll(root));
  git(root, ['gc', '--quiet', '--prune=now']);
  const packed = GitRepository.open(root);
  assert.deepEqual(readAll(packed, head), gitAll(root));
});

test('missing and corrupt objects are reported, never fetched or trusted', t => {
  const root = join(scratch(t), 'repo');
  const head = commitRepo(root, { 'keep.ts': 'keep\n', 'gone.ts': 'gone\n', 'bad.ts': 'bad\n' });
  const oid = (path: string) => git(root, ['rev-parse', `HEAD:${path}`]).trim();
  const loose = (o: string) => join(root, '.git/objects', o.slice(0, 2), o.slice(2));
  rmSync(loose(oid('gone.ts')));
  const bad = loose(oid('bad.ts'));
  chmodSync(bad, 0o600);
  writeFileSync(bad, readFileSync(loose(oid('keep.ts'))));    // a valid object, but not the one named
  const repo = GitRepository.open(root);
  assert.equal(repo.readObject(oid('keep.ts'), 1024)!.data.toString(), 'keep\n');
  assert.equal(repo.readObject(oid('gone.ts'), 1024), undefined);
  assert.equal(repo.objectHeader(oid('gone.ts')), undefined);
  assert.throws(() => repo.readObject(oid('bad.ts'), 1024), (e: unknown) => e instanceof GitReadError && e.code === 'corrupt');
  assert.throws(() => repo.readObject(oid('keep.ts'), 2), (e: unknown) => e instanceof GitReadError && e.code === 'corrupt', 'the size bound applies before trust');
  assert.throws(() => repo.resolveCommit('HEAD~1'), (e: unknown) => e instanceof GitReadError && e.code === 'unsupported');
  assert.throws(() => repo.resolveCommit('refs/heads/nope'), (e: unknown) => e instanceof GitReadError && e.code === 'unresolved');
  void head;
});

test('a linked worktree\'s Git directory is used only when explicitly permitted', t => {
  const dir = scratch(t);
  const main = join(dir, 'main');
  const head = commitRepo(main, { 'a.ts': 'a\n' });
  git(main, ['worktree', 'add', '--quiet', join(dir, 'linked')]);
  assert.throws(() => GitRepository.open(join(dir, 'linked')), (e: unknown) => e instanceof GitReadError && e.code === 'unsupported');
  const gitDir = join(main, '.git/worktrees/linked');
  const repo = GitRepository.open(join(dir, 'linked'), { gitDir });
  assert.equal(repo.resolveCommit(), head, 'HEAD from the worktree, objects from the common directory');
  assert.equal(repo.readObject(git(main, ['rev-parse', 'HEAD:a.ts']).trim(), 64)!.data.toString(), 'a\n');
});

test('unsupported repositories are refused rather than guessed', t => {
  const root = join(scratch(t), 'repo');
  commitRepo(root, { 'a.ts': 'a\n' });
  writeFileSync(join(root, '.git/config'), readFileSync(join(root, '.git/config'), 'utf8') + '[extensions]\n\trefStorage = reftable\n');
  assert.throws(() => GitRepository.open(root), (e: unknown) => e instanceof GitReadError && e.code === 'unsupported');
  assert.throws(() => GitRepository.open(scratch(t)), (e: unknown) => e instanceof GitReadError && e.code === 'notRepository');
});
