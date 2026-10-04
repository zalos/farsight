/**
 * The projects pass: which workspace project each node belongs to (docs/proposals/dependencies-and-nx.md §2.2).
 *
 * Runs once in `ingestRepo`, over every adapter's nodes at once, the way the store pass does.
 *
 * Discovery, the subset of NX's rules that can be read without running NX:
 * - `nx.json` at the source root → `tool: 'nx'`. Projects come from every `project.json` (name = its `name`,
 *   else the `name` of a `package.json` beside it, else the directory name; `projectType`, `tags`,
 *   `implicitDependencies`, `sourceRoot`) and from every `package.json` that carries an `nx` key or sits in
 *   a directory the root `package.json` `workspaces` globs (or `pnpm-workspace.yaml`) match — NX infers a
 *   project there (name from `name`, tags from `nx.tags`). A `project.json` and a `package.json` in one
 *   directory are one project: the `project.json` wins and the tags are merged.
 * - No `nx.json` but `workspaces` globs → `tool: 'workspaces'`: one project per matched `package.json`, no tags.
 * - Neither → `tool: 'none'`: one project, the source itself (`name` = source name, root `.`).
 * `node_modules`, build output and hidden directories are never read.
 *
 * Stamping: every node whose file lies under a project root gets `node.project` (the longest root wins).
 * A record, queue, flag, rule or gate placed without a file gets the project of what it is joined to, when
 * that is one project.
 * Project → project imports are read from the import statements of each project's files and resolved the
 * way the TS/JS adapter resolves them (relative paths, tsconfig `paths`, workspace package names), so a
 * type-only import or a constant counts too — the graph's own edges carry calls, not imports.
 * For an NX source, the project graph NX wrote to disk is read too (`nx-graph.ts`, never by running NX):
 * its project → project dependencies land on `meta.projects.dependencies`, and a project no manifest
 * typed takes NX's type before the nodes are stamped.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { GraphFragment, GraphNode, ProjectDecl, ProjectImports, ProjectsMeta, ProjectType, ProjectsConfig } from '@farsight/core';
import { globToRegExp, mergeTagDimensions } from '@farsight/core';
import type { IngestOptions } from '../types.js';
import { collectFiles } from './files.js';
import { createAliasResolver, resolveFileish } from '../aliases.js';
import { readNxProjectGraph } from './nx-graph.js';

/** Kinds an adapter may place without a file whose project is read from what they are joined to. */
const PLACELESS_KINDS = new Set<GraphNode['kind']>(['table', 'queue', 'flag', 'rule', 'guard']);

const MANIFESTS = new Set(['project.json', 'package.json']);
const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

function readJson(abs: string): { value?: Record<string, unknown>; error?: string } {
  let text: string;
  try { text = readFileSync(abs, 'utf8'); } catch { return {}; }
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? { value: v as Record<string, unknown> } : { error: 'not an object' };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : []);

/** Root `package.json` `workspaces` (array or `{ packages }`) plus `pnpm-workspace.yaml` packages — the globs, exclusions left out. */
export function workspaceGlobs(repoRoot: string): string[] {
  const out: string[] = [];
  const root = readJson(join(repoRoot, 'package.json')).value;
  const ws = root?.workspaces;
  if (Array.isArray(ws)) out.push(...strings(ws));
  else if (ws && typeof ws === 'object') out.push(...strings((ws as { packages?: unknown }).packages));
  try {
    const yaml = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
    for (const m of yaml.matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)) out.push(m[1]!.trim());
  } catch { /* no pnpm workspace file */ }
  return [...new Set(out.filter((g) => !g.startsWith('!')).map((g) => g.replace(/^\.\//, '').replace(/\/$/, '')))];
}

/** NX's layout dirs: `nx.json → workspaceLayout`, default `apps` / `libs`. */
function layoutOf(nx: Record<string, unknown> | undefined): { apps: string; libs: string } {
  const wl = (nx?.workspaceLayout ?? {}) as Record<string, unknown>;
  return {
    apps: typeof wl.appsDir === 'string' ? wl.appsDir.replace(/\/$/, '') : 'apps',
    libs: typeof wl.libsDir === 'string' ? wl.libsDir.replace(/\/$/, '') : 'libs',
  };
}

/**
 * The project type: what the settings say; else the NX layout folder it sits in (`apps/` · `libs/`).
 * An application whose name ends in `-e2e`, or that carries a `type:e2e` tag, is an end-to-end project.
 */
function typeOf(declared: unknown, root: string, name: string, tags: string[], layout: { apps: string; libs: string } | null): ProjectType | undefined {
  let t: ProjectType | undefined = declared === 'application' || declared === 'library' ? declared : undefined;
  if (!t && layout) {
    if (root === layout.apps || root.startsWith(`${layout.apps}/`)) t = 'application';
    else if (root === layout.libs || root.startsWith(`${layout.libs}/`)) t = 'library';
  }
  if ((t === 'application' || !t) && (name.endsWith('-e2e') || tags.includes('type:e2e'))) t = 'e2e';
  return t;
}

/** Read a source's projects. Pure over the files on disk; never throws. */
export function discoverProjects(repoRoot: string, repo: string, options: IngestOptions = {}): { tool: ProjectsMeta['tool']; projects: ProjectDecl[]; notes: string[] } {
  const notes: string[] = [];
  const nxFile = readJson(join(repoRoot, 'nx.json'));
  const isNx = !!nxFile.value || !!nxFile.error;
  if (nxFile.error) notes.push(`nx.json could not be read as JSON (${nxFile.error}); the workspace is still read as NX.`);
  const globs = workspaceGlobs(repoRoot);
  const globRes = globs.map((g) => globToRegExp(g));
  // a workspaces glob matches a directory, never what is below it (`packages/*` is not `packages/a/b`)
  const inWorkspaces = (dir: string) => dir !== '' && globs.some((g, i) => {
    if (g.includes('**')) return globRes[i]!.test(dir);
    const depth = g.split('/').length;
    return dir.split('/').length === depth && globRes[i]!.test(dir);
  });
  if (!isNx && !globs.length) return { tool: 'none', projects: [{ name: repo, root: '.', tags: [], via: 'source' }], notes };

  const files = collectFiles(repoRoot, [...MANIFESTS], options, (base) => !MANIFESTS.has(base)).sort();
  const byDir = new Map<string, { project?: Record<string, unknown>; pkg?: Record<string, unknown> }>();
  for (const abs of files) {
    const rel = relative(repoRoot, abs);
    const dir = dirname(rel) === '.' ? '' : dirname(rel);
    const { value, error } = readJson(abs);
    if (error) { notes.push(`${rel} could not be read as JSON (${error}), so it names no project.`); continue; }
    if (!value) continue;
    const slot = byDir.get(dir) ?? {};
    if (rel.endsWith('project.json')) slot.project = value; else slot.pkg = value;
    byDir.set(dir, slot);
  }
  const layout = isNx ? layoutOf(nxFile.value) : null;
  const projects: ProjectDecl[] = [];
  for (const [dir, { project, pkg }] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
    const root = dir || '.';
    const pkgNx = pkg && pkg.nx && typeof pkg.nx === 'object' ? (pkg.nx as Record<string, unknown>) : undefined;
    const pkgName = typeof pkg?.name === 'string' && pkg.name.trim() ? pkg.name.trim() : undefined;
    const dirName = dir ? dir.split('/').pop()! : repo;
    if (isNx && project) {
      const name = typeof project.name === 'string' && project.name.trim() ? project.name.trim() : (pkgNx && typeof pkgNx.name === 'string' ? pkgNx.name : undefined) ?? pkgName ?? dirName;
      const tags = [...new Set([...strings(project.tags), ...strings(pkgNx?.tags)])];
      const implicit = [...new Set([...strings(project.implicitDependencies), ...strings(pkgNx?.implicitDependencies)])].filter((d) => !d.startsWith('!'));
      const type = typeOf(project.projectType ?? pkgNx?.projectType, root, name, tags, layout);
      projects.push({
        name, root, ...(type ? { type } : {}), tags,
        ...(implicit.length ? { implicitDependencies: implicit } : {}),
        ...(typeof project.sourceRoot === 'string' ? { sourceRoot: project.sourceRoot } : {}),
        via: 'project.json',
      });
      continue;
    }
    if (!pkg) continue;
    // a package.json is a project under NX when it carries an `nx` key or a workspaces glob matches its directory;
    // without NX only the workspaces glob counts. The root package.json is the workspace, not a project, unless it says `nx`.
    const listed = inWorkspaces(dir);
    if (isNx ? !(pkgNx || listed) || (!dir && !pkgNx) : !listed) continue;
    const name = (pkgNx && typeof pkgNx.name === 'string' ? pkgNx.name : undefined) ?? pkgName ?? dirName;
    const tags = isNx ? strings(pkgNx?.tags) : [];
    const implicit = isNx ? strings(pkgNx?.implicitDependencies).filter((d) => !d.startsWith('!')) : [];
    const type = typeOf(pkgNx?.projectType, root, name, tags, layout);
    projects.push({
      name, root, ...(type ? { type } : {}), tags,
      ...(implicit.length ? { implicitDependencies: implicit } : {}),
      ...(pkgNx && typeof pkgNx.sourceRoot === 'string' ? { sourceRoot: pkgNx.sourceRoot } : {}),
      via: 'package.json',
    });
  }
  // two projects with one name: NX refuses the workspace; the graph keeps the first and says so
  const seen = new Map<string, string>();
  const kept: ProjectDecl[] = [];
  for (const p of projects) {
    const prior = seen.get(p.name);
    if (prior) { notes.push(`Two projects are named ${p.name} (${prior} and ${p.root}); the one at ${prior} is kept.`); continue; }
    seen.set(p.name, p.root);
    kept.push(p);
  }
  return { tool: isNx ? 'nx' : 'workspaces', projects: kept, notes };
}

/** The project whose root holds `path` (source-relative); the longest root wins. */
export function projectOfPath(path: string, projects: readonly ProjectDecl[]): ProjectDecl | undefined {
  let best: ProjectDecl | undefined;
  for (const p of projects) {
    const under = p.root === '.' || path === p.root || path.startsWith(`${p.root}/`);
    if (!under) continue;
    if (!best || best.root === '.' || (p.root !== '.' && p.root.length > best.root.length)) best = p;
  }
  return best;
}

/** Every module specifier one file imports, re-exports, `import()`s or `require()`s. A text scan: comments can add a stray one. */
export function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"\n]+)['"]|\bimport\s*['"]([^'"\n]+)['"]|\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
  for (const m of source.matchAll(re)) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}

/** Imports from one project's files into another's, resolved like the TS/JS adapter resolves them. */
export function projectImports(repoRoot: string, projects: readonly ProjectDecl[], options: IngestOptions = {}): ProjectImports[] {
  if (projects.length < 2) return [];
  const resolveAlias = createAliasResolver(repoRoot);
  const files = collectFiles(repoRoot, SOURCE_EXTS, options, (name) => name.endsWith('.d.ts')).sort();
  const pairs = new Map<string, { from: string; to: string; imports: number; byFile: Map<string, number> }>();
  for (const abs of files) {
    const rel = relative(repoRoot, abs);
    const from = projectOfPath(rel, projects);
    if (!from) continue;
    let source: string;
    try { source = readFileSync(abs, 'utf8'); } catch { continue; }
    for (const spec of importSpecifiers(source)) {
      let target: string | null;
      if (spec.startsWith('.')) {
        const hit = resolveFileish(join(dirname(abs), spec));
        target = hit ? relative(repoRoot, hit) : null;
        if (target?.startsWith('..')) target = null;
      } else {
        target = resolveAlias(abs, spec);
      }
      if (!target) continue;
      const to = projectOfPath(target, projects);
      if (!to || to.name === from.name) continue;
      const key = `${from.name}\u0000${to.name}`;
      let pair = pairs.get(key);
      if (!pair) pairs.set(key, (pair = { from: from.name, to: to.name, imports: 0, byFile: new Map() }));
      pair.imports++;
      pair.byFile.set(rel, (pair.byFile.get(rel) ?? 0) + 1);
    }
  }
  return [...pairs.values()]
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .map((p) => ({
      from: p.from, to: p.to, imports: p.imports, files: p.byFile.size,
      top: [...p.byFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([path, imports]) => ({ path, imports })),
    }));
}

/**
 * Discover the source's projects, stamp `project` on every node under a project root, and return
 * what `fragment.meta.projects` records. Never throws.
 */
export function applyProjects(fragment: GraphFragment, repoRoot: string, options: IngestOptions, config: ProjectsConfig | undefined): ProjectsMeta {
  const repo = fragment.repo;
  const { tool, projects, notes } = discoverProjects(repoRoot, repo, options);
  // NX's own project graph, when NX wrote one: dependencies it knows, and the type of a project no manifest typed
  const nx = tool === 'nx' ? readNxProjectGraph(repoRoot, projects, config?.graphFile) : undefined;
  if (nx) {
    for (const p of projects) if (!p.type && nx.types.has(p.name)) p.type = nx.types.get(p.name)!;
    notes.push(...nx.notes);
  } else if (config?.graphFile !== undefined) {
    notes.push(`projects.graphFile is set, but this source is not an NX workspace (no nx.json), so it is not read.`);
  }
  for (const n of fragment.nodes) {
    const path = n.loc?.path;
    if (!path || (n.loc!.repo && n.loc!.repo !== repo)) continue;
    const p = projectOfPath(path, projects);
    if (!p) continue;
    n.project = { name: p.name, root: p.root, ...(p.type ? { type: p.type } : {}), ...(p.tags.length ? { tags: [...p.tags] } : {}) };
  }
  // a record, queue, flag, rule or gate the adapter placed without a file (`db.invoices` read through a
  // client object) belongs to a project only when everything joined to it is in that one project
  const byId = new Map(fragment.nodes.map((n) => [n.id, n]));
  const neighbours = new Map<string, Set<string>>();
  for (const e of fragment.edges) {
    for (const [a, b] of [[e.from, e.to], [e.to, e.from]] as const) {
      const set = neighbours.get(a);
      if (set) set.add(b); else neighbours.set(a, new Set([b]));
    }
  }
  for (const n of fragment.nodes) {
    if (n.project || n.loc?.path || !PLACELESS_KINDS.has(n.kind)) continue;
    const names = new Set<string>();
    let first: GraphNode['project'];
    for (const id of neighbours.get(n.id) ?? []) {
      const p = byId.get(id)?.project;
      if (!p) { names.add('\u0000none'); continue; }
      names.add(p.name);
      first ??= p;
    }
    if (names.size === 1 && first) n.project = { ...first, ...(first.tags ? { tags: [...first.tags] } : {}) };
  }
  const imports = projectImports(repoRoot, projects, options);
  return {
    tool, projects,
    tagDimensions: mergeTagDimensions(config?.tagDimensions),
    ...(config?.tagValues ? { tagValues: config.tagValues } : {}),
    ...(imports.length ? { imports } : {}),
    ...(notes.length ? { notes } : {}),
    ...(nx?.dependencies.length ? { dependencies: nx.dependencies } : {}),
    ...(nx?.graphFile ? { graphFile: nx.graphFile } : {}),
  };
}
