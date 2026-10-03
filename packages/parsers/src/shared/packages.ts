import { readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import type { PackageDeclaration } from '@farsight/core';
import type { AliasHit } from '../aliases.js';

/**
 * Package facts every adapter shares (docs/proposals/dependencies-and-nx.md §2.1): which
 * specifiers are packages at all, what a specifier's package is, and where a package is
 * declared. Pure functions over the filesystem; the TS/JS adapter calls them per import,
 * and the NX lane reads the same package.json walk.
 */

/**
 * The runtime's own modules — never a package node. One list, read from the running Node
 * (`fs`, `fs/promises`, `path` …), so `node:fs` and `fs` are the same fact. Prefix-only
 * modules (`node:test`, `node:sqlite`) are covered by the `node:` rule in `isBuiltin`.
 */
export const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));

/** Is this specifier one of the runtime's built-ins (`node:fs`, `fs`, `fs/promises`)? */
export function isBuiltin(spec: string): boolean {
  if (spec.startsWith('node:')) return true;
  return NODE_BUILTINS.has(spec) || NODE_BUILTINS.has(spec.split('/')[0]!);
}

// one npm name segment: what `validate-npm-package-name` accepts, plus the upper case old packages still carry
const NAME_SEGMENT = /^[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;

/**
 * The package a bare specifier names, and the subpath after it: `lodash/fp` → `lodash` + `fp`,
 * `@scope/pkg/sub` → `@scope/pkg` + `sub`. Null for anything that is not a bare package
 * specifier — relative and absolute paths, URLs and other `scheme:` specifiers, package
 * `imports` (`#internal`), and app aliases that are no valid package name (`@/x`, `~/x`).
 */
export function packageOf(spec: string): { name: string; subpath?: string } | null {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return null; // node:, http:, virtual:, data: …
  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    if (parts.length < 2) return null;
    const scope = parts[0]!.slice(1);
    if (!NAME_SEGMENT.test(scope) || !NAME_SEGMENT.test(parts[1]!)) return null;
    const sub = parts.slice(2).join('/');
    return { name: `${parts[0]}/${parts[1]}`, ...(sub ? { subpath: sub } : {}) };
  }
  if (!NAME_SEGMENT.test(parts[0]!)) return null;
  const sub = parts.slice(1).join('/');
  return { name: parts[0]!, ...(sub ? { subpath: sub } : {}) };
}

/**
 * The workspace library an alias hit names, or null when the alias is app-internal:
 * - a workspace package name (`@acme/money` from a pnpm/npm workspace) → that name
 * - a `paths` pattern with no `*` (`"@acme/money": ["libs/money/src/index.ts"]`, NX's shape) → the pattern
 * - a `paths` pattern `@scope/*` → `@scope/<first segment of the match>`
 * Anything else — `@/*`, `~/*`, `src/*`, a `baseUrl` lookup — is a path inside one app, never a
 * package: the file edge the adapter already resolves is the whole fact.
 */
export function workspacePackageOf(hit: AliasHit, repoRoot: string): { name: string; root?: string } | null {
  const rel = (abs: string): string | undefined => {
    const r = relative(repoRoot, abs);
    return r.startsWith('..') ? undefined : r || '.';
  };
  if (hit.via === 'workspace' && hit.workspace) return { name: hit.workspace.name, ...(rel(hit.workspace.dir) ? { root: rel(hit.workspace.dir) } : {}) };
  if (hit.via !== 'paths' || !hit.pattern) return null;
  if (!hit.pattern.includes('*')) {
    const root = hit.target && hit.baseDir ? rel(dirname(resolvePath(hit.baseDir, hit.target))) : undefined;
    return { name: hit.pattern, ...(root ? { root } : {}) };
  }
  const scoped = /^(@[^/@*]+\/)\*$/.exec(hit.pattern);
  if (!scoped || !hit.star) return null;
  const first = hit.star.split('/')[0]!;
  if (!first) return null;
  const tpl = hit.target ?? '';
  const root = hit.baseDir && tpl.includes('*') ? rel(resolvePath(hit.baseDir, tpl.slice(0, tpl.indexOf('*')) + first)) : undefined;
  return { name: `${scoped[1]}${first}`, ...(root ? { root } : {}) };
}

const FIELDS: PackageDeclaration['field'][] = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * Where packages are declared: the nearest `package.json` above an importing file that names
 * the package, walking up to the source root and no further. Each file is read once.
 */
export class PackageJsonIndex {
  private readonly byDir = new Map<string, Record<string, string>[] | null>();

  constructor(private readonly repoRoot: string) {}

  /** The declaration an importer sees: the first package.json walking up from its directory that names `name`. */
  declarationFor(importerAbs: string, name: string): PackageDeclaration | null {
    let dir = dirname(importerAbs);
    const root = resolvePath(this.repoRoot);
    for (;;) {
      const fields = this.fieldsOf(dir);
      if (fields) {
        for (let i = 0; i < FIELDS.length; i++) {
          const range = fields[i]![name];
          if (typeof range === 'string') return { path: relative(root, join(dir, 'package.json')) || 'package.json', range, field: FIELDS[i]! };
        }
      }
      if (dir === root || !dir.startsWith(root + '/')) return null;
      dir = dirname(dir);
    }
  }

  private fieldsOf(dir: string): Record<string, string>[] | null {
    if (this.byDir.has(dir)) return this.byDir.get(dir)!;
    let out: Record<string, string>[] | null = null;
    const file = join(dir, 'package.json');
    try {
      if (statSync(file).isFile()) {
        const pkg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        out = FIELDS.map((f) => (pkg[f] && typeof pkg[f] === 'object' ? (pkg[f] as Record<string, string>) : {}));
      }
    } catch { /* no package.json here, or one that does not parse: nothing declared */ }
    this.byDir.set(dir, out);
    return out;
  }
}
