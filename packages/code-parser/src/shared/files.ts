import { readdirSync, readFileSync, statSync } from '../repository.js';
import { createHash } from 'node:crypto';
import { join, relative as platformRelative } from 'node:path';
import { currentRead, ReportedReadError } from '../repository.js';
import { testGlobToRegExp } from './file-kinds.js';
import type { IngestOptions } from '../types.js';
import ignore, { type Ignore } from 'ignore';

const relative = (from: string, to: string): string => platformRelative(from, to).replaceAll('\\', '/');

/** Build-output and vendored dirs no adapter should descend into ('target' = Maven/Rust). */
export const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', '.git', 'coverage']);

/** Glob → RegExp: `**` crosses directories, `*` stays within one segment. */
export function globToRegExp(glob: string): RegExp {
  return testGlobToRegExp(glob);
}

/**
 * Source files under root with one of `exts`, honoring exclude globs and
 * skipping build/vendor dirs. `skip` lets an adapter drop files by basename
 * that its extensions would otherwise match (e.g. `.d.ts`).
 */
export function collectFiles(
  root: string,
  exts: readonly string[],
  options: IngestOptions,
  skip?: (basename: string) => boolean,
): string[] {
  const includes = options.include?.map(globToRegExp);
  const scope = currentRead();
  const excludes = (options.exclude ?? []).map(globToRegExp);
  const out: string[] = [];
  const visit = (dir: string, parents: { dir: string; rules: Ignore }[] = []) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (error) {
      if (!scope) throw new Error('Unable to read directory');
      if (scope.stopped || error instanceof ReportedReadError) return;
      scope.report({
        code: 'read-error',
        severity: 'error',
        path: scope.path(dir),
        message: 'Directory could not be read.',
      });
      return;
    }
    let rules = parents;
    if (options.gitignore !== false && entries.includes('.gitignore')) {
      try {
        rules = [
          ...parents,
          { dir, rules: ignore({ ignorecase: false }).add(readFileSync(join(dir, '.gitignore'), 'utf8')) },
        ];
      } catch (error) {
        if (!scope) throw new Error(`Unable to read ${relative(root, dir) || '.'}/.gitignore`);
        if (!(error instanceof ReportedReadError) && !scope.stopped) {
          scope.report({
            code: 'read-error',
            severity: 'error',
            path: scope.path(join(dir, '.gitignore')),
            message: 'Git ignore rules could not be read.',
          });
        }
        // An unreadable rule file cannot safely select this subtree.
        return;
      }
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      const rel = relative(root, abs).replaceAll('\\', '/');
      if (excludes.some((re) => re.test(rel))) continue;
      let st;
      try {
        st = statSync(abs);
      } catch (error) {
        if (!scope) continue;
        if (scope.stopped) return;
        scope.files.set(rel, {
          path: rel,
          status: 'skipped',
          reason: error instanceof ReportedReadError ? error.reason : 'unreadable',
        });
        if (error instanceof ReportedReadError) continue;
        scope.report({ code: 'read-error', severity: 'error', path: rel, message: 'Input could not be inspected.' });
        continue;
      }
      let ignored = false;
      for (const layer of rules) {
        const result = layer.rules.test(relative(layer.dir, abs) + (st.isDirectory() ? '/' : ''));
        if (result.ignored) ignored = true;
        else if (result.unignored) ignored = false;
      }
      if (ignored) continue;
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(entry) && !entry.startsWith('.')) visit(abs, rules);
      } else if (st.isFile() && exts.some((e) => entry.endsWith(e))) {
        if (scope?.selectionReady && !scope.selected.has(abs)) continue;
        if (skip?.(entry) || (includes && !includes.some((re) => re.test(rel)))) {
          if (scope && !scope.selectionReady)
            scope.files.set(rel, {
              path: rel,
              status: 'skipped',
              reason: skip?.(entry) ? 'declaration-file' : 'include',
            });
          continue;
        }
        out.push(abs);
      } else if (
        scope?.discoveringSources &&
        !scope.selectionReady &&
        (!includes || includes.some((re) => re.test(rel))) &&
        !scope.discoveryExtensions.some((ext) => entry.endsWith(ext)) &&
        /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|java|py|go|rs|cs|rb|php|kt|swift|c|cpp)$/.test(entry)
      ) {
        scope.files.set(rel, { path: rel, status: 'skipped', reason: 'unsupported' });
        scope.report({
          code: 'unsupported',
          severity: 'warning',
          path: rel,
          message: 'No registered adapter supports this source file.',
        });
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
    try {
      mtime = statSync(f).mtimeMs;
    } catch {
      /* hash the path anyway */
    }
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
    try {
      body = createHash('sha1').update(readFileSync(f)).digest('hex');
    } catch {
      body = 'unreadable';
    }
    hash.update(`${relative(root, f)}\n${body}\n`);
  }
  return hash.digest('hex').slice(0, 12);
}
