import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve as resolvePath } from 'node:path';

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Resolve a base path to an actual source file, trying extensions, /index files,
 * and TS-style `.js` → `.ts` remaps (NodeNext imports name the emitted file).
 */
export function resolveFileish(base: string): string | null {
  const bases = [base];
  const remapped = base.replace(/\.jsx$/, '.tsx').replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts');
  if (remapped !== base) bases.push(remapped);
  for (const b of bases) {
    for (const suffix of ['', ...EXTS, ...EXTS.map((e) => '/index' + e)]) {
      if (isFile(b + suffix)) return b + suffix;
    }
  }
  return null;
}

interface PathRule {
  pattern: string; // e.g. "@acme/*" — at most one `*`
  targets: string[]; // e.g. ["packages/*/src"]
  baseDir: string; // absolute dir the targets resolve against
}

interface TsconfigPaths {
  baseUrlDir: string | null;
  paths: PathRule[];
}

/**
 * Build a resolver for non-relative import specifiers: tsconfig `paths` aliases
 * (nearest tsconfig.json above the importer, following `extends`) with a
 * workspace-package fallback (npm/pnpm workspaces → package name → source dir).
 * Returns a repo-relative path, or null for anything it can't resolve inside the repo.
 */
export function createAliasResolver(repoRoot: string): (importerAbs: string, spec: string) => string | null {
  const tsconfigByDir = new Map<string, TsconfigPaths | null>();
  const workspaces = loadWorkspacePackages(repoRoot);

  const toRepoRelative = (abs: string): string | null => {
    const rel = relative(repoRoot, abs);
    return rel.startsWith('..') ? null : rel; // edges outside the repo aren't addressable
  };

  const nearestTsconfig = (dir: string): TsconfigPaths | null => {
    if (tsconfigByDir.has(dir)) return tsconfigByDir.get(dir)!;
    let result: TsconfigPaths | null = null;
    for (const name of ['tsconfig.json', 'tsconfig.base.json']) {
      if (isFile(join(dir, name))) { result = loadTsconfig(join(dir, name), new Set()); break; }
    }
    if (!result && dir !== repoRoot && dir.startsWith(repoRoot)) result = nearestTsconfig(dirname(dir));
    tsconfigByDir.set(dir, result);
    return result;
  };

  return (importerAbs, spec) => {
    // 1. tsconfig paths
    const cfg = nearestTsconfig(dirname(importerAbs));
    if (cfg) {
      for (const candidate of matchPaths(spec, cfg.paths)) {
        const hit = resolveFileish(candidate);
        if (hit) return toRepoRelative(hit);
      }
      if (cfg.baseUrlDir) {
        const hit = resolveFileish(join(cfg.baseUrlDir, spec));
        if (hit) return toRepoRelative(hit);
      }
    }
    // 2. workspace package name (longest match wins: @x/y before @x/y-utils never collides)
    let bestName = '';
    let best: { dir: string; main?: string } | null = null;
    for (const [name, info] of workspaces) {
      if ((spec === name || spec.startsWith(name + '/')) && name.length > bestName.length) {
        bestName = name;
        best = info;
      }
    }
    if (best) {
      const sub = spec.slice(bestName.length).replace(/^\//, '');
      const candidates = sub
        ? [join(best.dir, sub), join(best.dir, 'src', sub)]
        : [
            join(best.dir, 'src/index'),
            join(best.dir, 'index'),
            // main usually points at dist (not ingested) — prefer the src twin
            ...(best.main ? [join(best.dir, best.main.replace(/^(\.\/)?dist\//, 'src/')), join(best.dir, best.main)] : []),
          ];
      for (const c of candidates) {
        const hit = resolveFileish(c);
        if (hit) return toRepoRelative(hit);
      }
    }
    return null;
  };
}

/** Load a tsconfig, following relative `extends` chains; child compilerOptions override wholesale. */
function loadTsconfig(file: string, seen: Set<string>): TsconfigPaths | null {
  if (seen.has(file)) return null;
  seen.add(file);
  let raw: unknown;
  try {
    raw = parseJsonc(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const cfg = raw as { extends?: string | string[]; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  const out: TsconfigPaths = { baseUrlDir: null, paths: [] };
  const bases = Array.isArray(cfg.extends) ? cfg.extends : cfg.extends ? [cfg.extends] : [];
  for (const ext of bases) {
    if (!ext.startsWith('.')) continue; // package-based extends carries no repo aliases
    let target = resolvePath(dirname(file), ext);
    if (!target.endsWith('.json')) target += '.json';
    const base = loadTsconfig(target, seen);
    if (base) {
      if (base.baseUrlDir) out.baseUrlDir = base.baseUrlDir;
      if (base.paths.length) out.paths = base.paths;
    }
  }
  const co = cfg.compilerOptions;
  if (co?.baseUrl) out.baseUrlDir = resolvePath(dirname(file), co.baseUrl);
  if (co?.paths) {
    // paths resolve against baseUrl if set, else the declaring tsconfig's dir (TS 4.1+)
    const baseDir = out.baseUrlDir ?? dirname(file);
    out.paths = Object.entries(co.paths).map(([pattern, targets]) => ({ pattern, targets: targets ?? [], baseDir }));
  }
  return out;
}

/** Expand a spec against path rules; supports at most one `*` per pattern (TS's rule). */
function matchPaths(spec: string, rules: PathRule[]): string[] {
  const out: string[] = [];
  for (const { pattern, targets, baseDir } of rules) {
    const star = pattern.indexOf('*');
    let matched: string | null = null;
    if (star < 0) {
      if (spec === pattern) matched = '';
    } else {
      const pre = pattern.slice(0, star);
      const post = pattern.slice(star + 1);
      if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length) {
        matched = spec.slice(pre.length, spec.length - post.length);
      }
    }
    if (matched === null) continue;
    for (const t of targets) out.push(resolvePath(baseDir, t.replace('*', matched)));
  }
  return out;
}

/** npm `workspaces` + pnpm-workspace.yaml → package name → { dir, main }. */
function loadWorkspacePackages(repoRoot: string): Map<string, { dir: string; main?: string }> {
  const patterns: string[] = [];
  const rootPkg = readJson(join(repoRoot, 'package.json')) as { workspaces?: string[] | { packages?: string[] } } | null;
  const ws = rootPkg?.workspaces;
  if (Array.isArray(ws)) patterns.push(...ws);
  else if (ws && Array.isArray(ws.packages)) patterns.push(...ws.packages);
  try {
    const yaml = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
    for (const m of yaml.matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)) patterns.push(m[1]!);
  } catch { /* no pnpm workspace file */ }

  const map = new Map<string, { dir: string; main?: string }>();
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    for (const dir of expandWorkspaceGlob(repoRoot, pattern)) {
      const pkg = readJson(join(dir, 'package.json')) as { name?: string; main?: string } | null;
      if (pkg && typeof pkg.name === 'string') {
        map.set(pkg.name, { dir, ...(typeof pkg.main === 'string' ? { main: pkg.main } : {}) });
      }
    }
  }
  return map;
}

/** Workspace globs in the wild are `packages/*`-shaped; expand one directory level. */
function expandWorkspaceGlob(root: string, pattern: string): string[] {
  const clean = pattern.replace(/\/$/, '');
  if (clean.endsWith('/*') || clean.endsWith('/**')) {
    const base = join(root, clean.replace(/\/\*\*?$/, ''));
    try {
      return readdirSync(base)
        .map((e) => join(base, e))
        .filter((d) => isDir(d));
    } catch {
      return [];
    }
  }
  const dir = join(root, clean);
  return isDir(dir) ? [dir] : [];
}

/** JSON-with-comments (tsconfig dialect): strip block/line comments + trailing commas. */
function parseJsonc(text: string): unknown {
  const cleaned = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
