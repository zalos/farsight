#!/usr/bin/env node
// The project skills exist twice, once per assistant: `.claude/skills` (Claude Code) and `.agents/skills`
// (Codex and every other agent that reads AGENTS.md). Codex never scans `.claude/skills`, and a bridge-started
// Codex session is a fresh worktree, so an untracked copy is no copy at all — the mirror is tracked and every
// edit to one tree goes to the other in the same change. This check makes that mechanical: it is
// `diff -r .claude/skills .agents/skills` with a fixed output — every path that differs, then exit 1; exit 0
// when the trees are identical. The same script lives in Recall; keep the two in step.
//
//   node scripts/check-skills-mirror.mjs                      # the checkout this script is in
//   node scripts/check-skills-mirror.mjs --root <dir>         # another checkout
//
// Run by `pnpm test:scripts` (scripts/test/skills-mirror.test.mjs) inside CI's validate job, which a change under
// either skills tree selects (scripts/ci-changes.mjs). Compares bytes, file types and symbolic-link targets, never
// timestamps or modes. `.DS_Store` (macOS Finder's own file, gitignored) is not part of either tree.
// Zero dependencies (Node 24).
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The two trees, relative to the repository root. */
export const MIRROR = Object.freeze(['.claude/skills', '.agents/skills']);
/** Names that belong to neither tree (gitignored operating-system files). */
export const NOT_MIRRORED = Object.freeze(new Set(['.DS_Store']));

/** What a path is, for the comparison: `dir`, `file` (with its bytes) or `link` (with its target). */
function entry(file) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { kind: 'link', target: readlinkSync(file) };
  if (stat.isDirectory()) return { kind: 'dir' };
  if (stat.isFile()) return { kind: 'file', file };
  return { kind: 'other' };
}

const sameEntry = (a, b) => {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'link') return a.target === b.target;
  if (a.kind === 'file') return readFileSync(a.file).equals(readFileSync(b.file));
  return a.kind !== 'other';
};

const names = (dir) =>
  readdirSync(dir)
    .filter((name) => !NOT_MIRRORED.has(name))
    .sort();

/**
 * Every path (relative, `/`-separated) where tree `a` and tree `b` differ, in path order:
 * `{ path, only: 'a' | 'b' }` for a path one tree lacks (a missing directory is one entry, not its
 * contents), `{ path, differs: true }` for different bytes, types or link targets.
 */
export function compareTrees(a, b, rel = '') {
  const out = [];
  const here = (root) => (rel ? path.join(root, ...rel.split('/')) : root);
  const left = new Set(names(here(a)));
  const right = new Set(names(here(b)));
  for (const name of [...new Set([...left, ...right])].sort()) {
    const p = rel ? `${rel}/${name}` : name;
    if (!right.has(name)) {
      out.push({ path: p, only: 'a' });
      continue;
    }
    if (!left.has(name)) {
      out.push({ path: p, only: 'b' });
      continue;
    }
    const x = entry(path.join(here(a), name));
    const y = entry(path.join(here(b), name));
    if (x.kind === 'dir' && y.kind === 'dir') out.push(...compareTrees(a, b, p));
    else if (!sameEntry(x, y)) out.push({ path: p, differs: true });
  }
  return out;
}

/** The number of files and links under `dir` (the success line's count). */
export function countEntries(dir) {
  let n = 0;
  for (const name of names(dir)) {
    const e = entry(path.join(dir, name));
    n += e.kind === 'dir' ? countEntries(path.join(dir, name)) : 1;
  }
  return n;
}

/** The report for a list of differences between `trees[0]` and `trees[1]`. */
export function mirrorReport(differences, trees = MIRROR) {
  const [a, b] = trees;
  const lines = [
    `skills mirror: ${a} and ${b} differ at ${differences.length} path${differences.length === 1 ? '' : 's'}:`,
  ];
  for (const d of differences) {
    if (d.only === 'a') lines.push(`  only in ${a}: ${d.path}`);
    else if (d.only === 'b') lines.push(`  only in ${b}: ${d.path}`);
    else lines.push(`  differs: ${d.path}`);
  }
  lines.push(`skills mirror: make each edit in both trees (copy the changed files across), then run this check again.`);
  return lines;
}

/** `argv` → exit code: 0 identical, 1 different (or a tree missing), 2 a bad command line. */
export function main(argv, { cwd = process.cwd(), defaultRoot = cwd, out = console.log, err = console.error } = {}) {
  let root;
  try {
    const { values } = parseArgs({ args: argv, options: { root: { type: 'string' } } });
    root = values.root === undefined ? defaultRoot : path.resolve(cwd, values.root);
  } catch (error) {
    err(`skills mirror: ${error.message}`);
    err('usage: node scripts/check-skills-mirror.mjs [--root <repository root>]');
    return 2;
  }
  const [a, b] = MIRROR.map((tree) => path.join(root, tree));
  const missing = MIRROR.filter((_, i) => entry([a, b][i])?.kind !== 'dir');
  if (missing.length) {
    err(
      `skills mirror: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not a directory under ${root}.`,
    );
    return 1;
  }
  const differences = compareTrees(a, b);
  if (differences.length) {
    for (const line of mirrorReport(differences)) err(line);
    return 1;
  }
  out(`skills mirror: ${MIRROR[0]} and ${MIRROR[1]} are identical (${countEntries(a)} files).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), {
    defaultRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  });
}
