/**
 * Every `farsight.config.json` in a source, read once (docs/proposals/journey-organisation-and-config-files.md §5).
 *
 * The file at the source root is the root config and speaks for the whole source. Any other is a
 * scoped config: it speaks only for the code under its folder, and every path it names is relative
 * to that folder. Discovery uses `collectFiles`, so the workspace's `exclude` globs apply and
 * `node_modules`, `dist`, `.git` are skipped as everywhere else.
 *
 * Field by field (§5.2):
 * - node matchers (`tags`, `glossary`, `guards`, `entrypoints`, `setup`) are applied per file by
 *   `applyWorkspaceConfig` — the root first, then each nested file in depth order, each only to the
 *   nodes under its folder — so for a node under two files the nearer file's glossary word wins;
 * - path fields (`plumbing`, `design[]`, `openapi[]`, `tests`, `storybook`) are rebased (the folder
 *   is put in front) and unioned into `merged`, which the design, OpenAPI, tests and stories passes read;
 * - `externals[]` and `stores[]` are unioned; a second declaration of the same import or store name
 *   is a conflict and the first (the root's, when it has one) is kept;
 * - `projects` and `tooling` are root-only; a nested file's value is ignored with a note;
 * - `journeys` blocks stay per file: `journeysConfigFor` names the blocks that apply to one manifest.
 *
 * Nothing here throws: a file that cannot be read or is not valid JSON is a note with its path, and
 * a path that is absolute or climbs out of the source is dropped with a note. Nothing outside the
 * source is ever read.
 */
import { join, posix, relative } from 'node:path';
import type {
  ApplyConfigOptions, ConfigMeta, ExternalDecl, FarsightConfig, GraphEdge, GraphNode, JourneysConfig,
  StorybookConfig, StoreDecl, TestReportConfig, TestsConfigBlock,
} from '@farsight/core';
import { applyConfig, applyRouteGuards, readConfigFile, scopeOfDir, stringList, CONFIG_FIELDS, ROOT_ONLY_CONFIG_FIELDS } from '@farsight/core';
import { collectFiles } from './files.js';
import type { IngestOptions } from '../types.js';

/** The file name every config has, at the root or in any folder below it. */
export const CONFIG_FILE = 'farsight.config.json';

/** One config file of a source. `dir` is its folder, repo-relative and posix; `'.'` for the root. */
export interface ConfigFile { path: string; dir: string; config: FarsightConfig; root: boolean }

export interface WorkspaceConfig {
  /** the root file's config, or null when there is none (or it could not be read) */
  root: FarsightConfig | null;
  /** root first, then by folder depth, then by path — only the files that could be read */
  files: ConfigFile[];
  /** the root config with every scoped file's list fields unioned and rebased — what the design, OpenAPI, tests and stories passes read */
  merged: FarsightConfig;
  meta: ConfigMeta;
}

const LEVELS = ['unit', 'integration', 'e2e'] as const;

/** The config of a source with none: nothing merged, nothing to say. */
export function emptyWorkspaceConfig(): WorkspaceConfig {
  return { root: null, files: [], merged: {}, meta: { files: [], conflicts: [], notes: [] } };
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);
const depthOf = (dir: string) => (dir === '.' ? 0 : dir.split('/').length);

/**
 * Discover and read every config file of the source at `repoRoot`. With `options.config === false`
 * nothing is read and the result is empty — the one place that flag is honoured for every pass.
 */
export function loadWorkspaceConfig(repoRoot: string, options: IngestOptions = {}): WorkspaceConfig {
  const ws = emptyWorkspaceConfig();
  if (options.config === false) return ws;
  const { meta } = ws;

  // the root file is read whatever the excludes say, as it always was; the nested ones by discovery
  const paths: string[] = [CONFIG_FILE];
  let found: string[] = [];
  try {
    found = collectFiles(repoRoot, ['.json'], options, (base) => base !== CONFIG_FILE)
      .map((abs) => relative(repoRoot, abs).replace(/\\/g, '/'))
      .filter((rel) => rel !== CONFIG_FILE);
  } catch { /* an unreadable source has no nested configs to offer */ }
  found.sort((a, b) => depthOf(posix.dirname(a)) - depthOf(posix.dirname(b)) || a.localeCompare(b));
  paths.push(...found);

  for (const path of paths) {
    const root = path === CONFIG_FILE;
    const read = readConfigFile(join(repoRoot, path));
    if ('missing' in read) continue;
    if ('error' in read) { meta.notes.push(`${path} ${read.error}; it was not applied.`); continue; }
    const dir = root ? '.' : posix.dirname(path);
    const config = read.config;
    const fields: string[] = [];
    const ignored: string[] = [];
    for (const key of Object.keys(config)) {
      // `$schema`, `$comment` and the like are for editors, not for Farsight
      if (key.startsWith('$') || key.startsWith('//')) continue;
      if (!(CONFIG_FIELDS as readonly string[]).includes(key)) {
        ignored.push(key);
        meta.notes.push(`${JSON.stringify(key)} is not a farsight.config.json field; ${path}'s was ignored.`);
        continue;
      }
      if (!root && (ROOT_ONLY_CONFIG_FIELDS as readonly string[]).includes(key)) {
        ignored.push(key);
        meta.notes.push(`${key} is root-only; ${path}'s was ignored.`);
        delete (config as Record<string, unknown>)[key];
        continue;
      }
      fields.push(key);
    }
    for (const key of ignored) delete (config as Record<string, unknown>)[key];
    meta.files.push({ path, dir, root, fields, ignored });
    ws.files.push({ path, dir, config, root });
    if (root) ws.root = config;
  }

  ws.merged = mergeConfigs(ws.files, meta);
  meta.conflicts.push(...glossaryConflicts(ws.files));
  return ws;
}

/**
 * A path a nested file names, made repo-relative: the folder in front, `.` and `..` resolved. A URL is
 * kept as it is; an absolute path, or one that climbs out of the source, is refused with a note.
 * The root file's paths are repo-relative already and pass through untouched.
 */
export function rebasePath(dir: string, value: string, where: string, notes: string[]): string | undefined {
  if (dir === '.' || isUrl(value)) return value;
  const raw = value.trim().replace(/\\/g, '/');
  if (!raw) return undefined;
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.includes('\0')) {
    notes.push(`${where} ${JSON.stringify(value.slice(0, 200))} is an absolute path; a nested farsight.config.json names paths relative to its folder, so it was ignored.`);
    return undefined;
  }
  const joined = posix.normalize(`${dir}/${raw}`);
  if (joined === '..' || joined.startsWith('../')) {
    notes.push(`${where} ${JSON.stringify(value.slice(0, 200))} climbs out of the source with .., so it was ignored.`);
    return undefined;
  }
  return joined.replace(/^\.\//, '').replace(/\/$/, '') || '.';
}

/** The root config with every nested file's list fields rebased and unioned, conflicts recorded on `meta`. */
function mergeConfigs(files: ConfigFile[], meta: ConfigMeta): FarsightConfig {
  const rootFile = files.find((f) => f.root);
  const root = rootFile?.config ?? {};
  // the root's own fields, as written — a source with one file reads exactly as it did before nested files
  const merged: FarsightConfig = { ...root };
  const nested = files.filter((f) => !f.root);
  const notes = meta.notes;

  const list = (dir: string, values: string[] | undefined, where: string) =>
    (Array.isArray(values) ? values : []).filter((v): v is string => typeof v === 'string').map((v) => rebasePath(dir, v, where, notes)).filter((v): v is string => !!v);
  const union = (a: string[] | undefined, b: string[]) => [...new Set([...(a ?? []), ...b])];
  /** `results` / `coverage` / `report`: one string stays one string, a list stays a list */
  const rebaseOneOrMany = (dir: string, v: string | string[] | undefined, where: string): string | string[] | undefined => {
    if (v === undefined) return undefined;
    const out = stringList(v).map((x) => rebasePath(dir, x, where, notes)).filter((x): x is string => !!x);
    if (!out.length) return undefined;
    return Array.isArray(v) ? out : out[0];
  };

  // the first file to declare an import / a store name keeps it — the root's, when it has one
  const externals: ExternalDecl[] = [...(Array.isArray(root.externals) ? root.externals : [])];
  const stores: StoreDecl[] = [...(Array.isArray(root.stores) ? root.stores : [])];
  const externalFrom = new Map<string, string>(externals.map((e) => [e.import, rootFile!.path]));
  const storeFrom = new Map<string, string>(stores.map((s) => [s.name, rootFile!.path]));

  for (const f of nested) {
    const c = f.config;
    const where = (field: string) => `${f.path} → ${field}`;
    if (c.plumbing !== undefined) merged.plumbing = union(merged.plumbing, list(f.dir, c.plumbing, where('plumbing')));
    if (Array.isArray(c.design)) {
      const add = c.design.flatMap((d) => {
        if (!d || typeof d !== 'object') return [];
        const out = { ...d };
        for (const k of ['manifest', 'path'] as const) {
          if (typeof d[k] !== 'string') continue;
          const p = rebasePath(f.dir, d[k]!, where(`design.${k}`), notes);
          if (p) out[k] = p; else delete out[k];
        }
        return out.manifest || out.path || out.url ? [out] : [];
      });
      merged.design = dedupeBy([...(merged.design ?? []), ...add], (d) => d.url ?? d.manifest ?? d.path ?? '');
    }
    if (Array.isArray(c.openapi)) {
      const add = c.openapi.flatMap((d) => {
        if (!d || typeof d !== 'object') return [];
        const out = { ...d };
        if (typeof d.path === 'string') {
          const p = rebasePath(f.dir, d.path, where('openapi.path'), notes);
          if (p) out.path = p; else delete out.path;
        }
        return out.path || out.url ? [out] : [];
      });
      merged.openapi = dedupeBy([...(merged.openapi ?? []), ...add], (d) => d.url ?? d.path ?? '');
    }
    if (c.tests && typeof c.tests === 'object') {
      const t: TestsConfigBlock = { ...(merged.tests ?? {}) };
      if (c.tests.include !== undefined) t.include = union(t.include, list(f.dir, c.tests.include, where('tests.include')));
      if (c.tests.exclude !== undefined) t.exclude = union(t.exclude, list(f.dir, c.tests.exclude, where('tests.exclude')));
      for (const level of LEVELS) {
        const given = c.tests[level];
        const blocks = (Array.isArray(given) ? given : given ? [given] : []).filter((b): b is TestReportConfig => !!b && typeof b === 'object');
        if (!blocks.length) continue;
        const rebased = blocks.map((b) => {
          const out: TestReportConfig = { ...(b.runner ? { runner: b.runner } : {}) };
          for (const k of ['results', 'coverage', 'report'] as const) {
            const v = rebaseOneOrMany(f.dir, b[k], where(`tests.${level}.${k}`));
            if (v !== undefined) out[k] = v;
          }
          return out;
        });
        const had = t[level];
        const all = [...(Array.isArray(had) ? had : had ? [had] : []), ...rebased];
        t[level] = all.length === 1 ? all[0] : all;
      }
      merged.tests = t;
    }
    if (c.storybook && typeof c.storybook === 'object') {
      const given = (Array.isArray(c.storybook) ? c.storybook : [c.storybook]).filter((s): s is StorybookConfig => !!s && typeof s === 'object');
      const rebased = given.map((s) => {
        const out: StorybookConfig = { ...s };
        for (const k of ['configDir', 'root'] as const) {
          if (typeof s[k] !== 'string') continue;
          const p = rebasePath(f.dir, s[k]!, where(`storybook.${k}`), notes);
          if (p) out[k] = p; else delete out[k];
        }
        // a nested file's Storybook without a configDir is the one in its own folder
        if (out.configDir === undefined) out.configDir = `${f.dir}/.storybook`;
        return out;
      });
      const had = merged.storybook;
      merged.storybook = [...(Array.isArray(had) ? had : had ? [had] : []), ...rebased];
    }
    if (Array.isArray(c.externals)) {
      for (const e of c.externals) {
        if (!e || typeof e !== 'object' || typeof e.import !== 'string') continue;
        // `<path>::<Class>` names a file, so it is relative to the folder too; a bare package specifier is not a path
        const sep = e.import.indexOf('::');
        let imp = e.import;
        if (sep > 0) {
          const p = rebasePath(f.dir, e.import.slice(0, sep), where('externals.import'), notes);
          if (!p) continue;
          imp = `${p}${e.import.slice(sep)}`;
        }
        const first = externalFrom.get(imp);
        if (first) { addConflict(meta, 'external', imp, [first, f.path], first); continue; }
        externalFrom.set(imp, f.path);
        externals.push({ ...e, import: imp });
      }
    }
    if (Array.isArray(c.stores)) {
      for (const s of c.stores) {
        const first = storeFrom.get(s.name);
        if (first) { addConflict(meta, 'store', s.name, [first, f.path], first); continue; }
        storeFrom.set(s.name, f.path);
        stores.push(s);
      }
    }
  }
  if (externals.length || root.externals !== undefined) merged.externals = externals;
  if (stores.length || root.stores !== undefined) merged.stores = stores;
  return merged;
}

function dedupeBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((t) => {
    const k = key(t);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function addConflict(meta: ConfigMeta, kind: ConfigMeta['conflicts'][number]['kind'], key: string, files: string[], kept: string): void {
  const had = meta.conflicts.find((c) => c.kind === kind && c.key === key);
  if (had) { for (const f of files) if (!had.files.includes(f)) had.files.push(f); return; }
  meta.conflicts.push({ kind, key, files: [...new Set(files)], kept });
}

/** Does folder `inner` sit inside folder `outer` (the root holds every folder)? */
function within(inner: string, outer: string): boolean {
  return outer === '.' || inner === outer || inner.startsWith(`${outer}/`);
}

/**
 * A glossary key two files give different words for, where one file's folder holds the other's: for
 * the code under the inner folder the nearer (inner) file's word wins. Two sibling folders never
 * meet, so naming the same function differently there is not a conflict.
 */
function glossaryConflicts(files: ConfigFile[]): ConfigMeta['conflicts'] {
  const out: ConfigMeta['conflicts'] = [];
  const keys = new Set(files.flatMap((f) => Object.keys(f.config.glossary ?? {})));
  for (const key of [...keys].sort()) {
    const givers = files.filter((f) => f.config.glossary && Object.prototype.hasOwnProperty.call(f.config.glossary, key));
    for (let i = 0; i < givers.length; i++) {
      for (let j = i + 1; j < givers.length; j++) {
        const [a, b] = [givers[i]!, givers[j]!];
        // files are in depth order, so a can hold b but b cannot hold a
        if (!within(b.dir, a.dir)) continue;
        const wa = a.config.glossary![key]!;
        const wb = b.config.glossary![key]!;
        if (wa?.label === wb?.label && wa?.description === wb?.description) continue;
        const had = out.find((c) => c.key === key);
        if (had) {
          for (const p of [a.path, b.path]) if (!had.files.includes(p)) had.files.push(p);
          if (depthOf(b.dir) > depthOf(files.find((f) => f.path === had.kept)!.dir)) had.kept = b.path;
          continue;
        }
        out.push({ kind: 'glossary', key, files: [a.path, b.path], kept: b.path });
      }
    }
  }
  return out;
}

/**
 * Apply every file's node matchers to the merged fragment, in place: the root over every node, then
 * each nested file over the nodes under its folder, in depth order — so the nearer file's glossary
 * word is the last one written and wins, and its tags add. A function an earlier file already made a
 * guard is not renamed again by a later guard rule; that is recorded as a `guard` conflict.
 * Returns whether any file was applied.
 */
export function applyWorkspaceConfig(nodes: GraphNode[], edges: GraphEdge[], ws: WorkspaceConfig): boolean {
  // plumbing is a path glob: every file's, rebased into one list, tags the whole source once
  if (ws.merged.plumbing?.length) applyConfig(nodes, { plumbing: ws.merged.plumbing }, edges);
  const guardedBy = new Map<string, string>();
  for (const f of ws.files) {
    const opts: ApplyConfigOptions = {
      ...(f.root ? {} : { scope: scopeOfDir(f.dir) }),
      guarded: new Set(guardedBy.keys()),
      onGuardConflict: (node) => addConflict(ws.meta, 'guard', node.name.split(': ')[0]!, [guardedBy.get(node.id)!, f.path], guardedBy.get(node.id)!),
    };
    const { guarded } = applyConfig(nodes, matcherFields(f.config), edges, opts);
    for (const id of guarded) guardedBy.set(id, f.path);
  }
  return ws.files.length > 0;
}

/** Route-shaped guard matchers again, after the OpenAPI pass added its routes — each file over its own folder. */
export function applyWorkspaceRouteGuards(nodes: GraphNode[], edges: GraphEdge[], ws: WorkspaceConfig): void {
  for (const f of ws.files) applyRouteGuards(nodes, matcherFields(f.config), edges, f.root ? undefined : scopeOfDir(f.dir));
}

/** Only the node-matcher fields: plumbing is rebased into `merged` and applied once from there. */
function matcherFields(c: FarsightConfig): FarsightConfig {
  return {
    ...(c.tags ? { tags: c.tags } : {}), ...(c.glossary ? { glossary: c.glossary } : {}), ...(c.guards ? { guards: c.guards } : {}),
    ...(c.entrypoints ? { entrypoints: c.entrypoints } : {}), ...(c.setup ? { setup: c.setup } : {}),
  };
}

/**
 * The `journeys` blocks that apply to one design manifest (repo-relative path), in the order they
 * are applied: the root file's first (it applies to every manifest), then each nested file whose
 * folder holds the manifest, nearest last — so a nearer block's override is the one that stands.
 */
export function journeysConfigFor(ws: WorkspaceConfig, manifestPath: string): { from: string; dir: string; journeys: JourneysConfig }[] {
  const p = manifestPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return ws.files
    // a URL manifest sits in no folder, so only the root's block reaches it
    .filter((f) => !!f.config.journeys && (f.root || (!isUrl(p) && p.startsWith(`${f.dir}/`))))
    .map((f) => ({ from: f.path, dir: f.dir, journeys: f.config.journeys! }));
}
