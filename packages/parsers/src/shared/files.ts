import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import type { IngestOptions } from '../types.js';

/** Build-output and vendored dirs no adapter should descend into ('target' = Maven/Rust). */
export const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', '.git', 'coverage']);

/** Glob → RegExp: `**` crosses directories, `*` stays within one segment. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}(/.*)?$`);
}

/**
 * Source files under root with one of `exts`, honoring exclude globs and
 * skipping build/vendor dirs. `skip` lets an adapter drop files by basename
 * that its extensions would otherwise match (e.g. `.d.ts`).
 */
export function collectFiles(
  root: string,
  exts: string[],
  options: IngestOptions,
  skip?: (basename: string) => boolean,
): string[] {
  const excludes = (options.exclude ?? []).map(globToRegExp);
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const rel = relative(root, abs);
      if (excludes.some((re) => re.test(rel))) continue;
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(entry) && !entry.startsWith('.')) visit(abs);
      } else if (exts.some((e) => entry.endsWith(e)) && !skip?.(entry)) {
        out.push(abs);
      }
    }
  };
  visit(root);
  return out;
}

/**
 * Freshness signal: how many files were parsed and a hash over their
 * paths+mtimes, so consumers can tell whether a snapshot still matches disk.
 */
export function freshnessMeta(root: string, files: string[]): { files: number; sourceHash: string } {
  const hash = createHash('sha1');
  for (const f of files) {
    let mtime = 0;
    try { mtime = statSync(f).mtimeMs; } catch { /* hash the path anyway */ }
    hash.update(`${relative(root, f)}:${mtime}\n`);
  }
  return { files: files.length, sourceHash: hash.digest('hex').slice(0, 12) };
}

/**
 * Content digest: a hash over what the files *say*, not when they were touched.
 * `freshnessMeta`'s sourceHash moves when a checkout is re-cloned or a formatter
 * rewrites a file byte-identically, so it cannot prove "unchanged since the test
 * run"; this can. Same file set and excludes as ingest (coverage/ and report
 * files are not in it, so stamping a report never changes the digest it records).
 *
 * sha1 over `${rel}\n${sha1(content)}` per file, paths sorted, 12 hex — so it is
 * deterministic across runs and independent of the absolute checkout path.
 */
export function contentDigest(root: string, files: string[]): string {
  const hash = createHash('sha1');
  for (const f of [...files].sort()) {
    let body: string;
    try { body = createHash('sha1').update(readFileSync(f)).digest('hex'); } catch { body = 'unreadable'; }
    hash.update(`${relative(root, f)}\n${body}\n`);
  }
  return hash.digest('hex').slice(0, 12);
}
