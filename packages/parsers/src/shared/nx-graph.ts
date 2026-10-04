/**
 * NX's own project graph, read from the file NX wrote — never by running NX
 * (docs/proposals/dependencies-and-nx.md §2.2, addendum 2026-10-04).
 *
 * NX keeps its project graph on disk: `.nx/workspace-data/project-graph.json` (NX 17 and later),
 * `.nx/cache/project-graph.json` (older), `node_modules/.cache/nx/project-graph.json` (oldest); and
 * `nx graph --file=<path>.json` exports one, which `farsight.config.json → projects.graphFile` can
 * name. Both shapes are read: the export `{ graph: { nodes, dependencies } }` and the cache
 * `{ nodes, dependencies, externalNodes? }`.
 *
 * The file is input from the ingested repository, so it is treated as untrusted: read with
 * `readFileSync` only, after checking that it is a regular file inside the source (symlinks
 * resolved) and no larger than {@link NX_GRAPH_MAX_BYTES}; every field's type is checked; names
 * count only when discovery already found a project by that name, and the rest are said as a count.
 * Nothing is spawned, executed or installed (docs/SECURITY.md). Never throws.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep, isAbsolute } from 'node:path';
import type { NxProjectDependency, ProjectDecl, ProjectType } from '@farsight/core';
import { graphFilePath } from '@farsight/core';

/** Where NX writes its project graph, newest layout first (source-relative). */
export const NX_GRAPH_PATHS = [
  '.nx/workspace-data/project-graph.json',
  '.nx/cache/project-graph.json',
  'node_modules/.cache/nx/project-graph.json',
] as const;

/** The largest project-graph file parsed; a bigger one is set aside with a note. */
export const NX_GRAPH_MAX_BYTES = 20 * 1024 * 1024;

const NX_TYPES: Record<string, ProjectType> = { app: 'application', lib: 'library', e2e: 'e2e' };
const DEP_TYPES = new Set<NxProjectDependency['type']>(['static', 'dynamic', 'implicit']);
/** `static` beats `dynamic` beats `implicit` when NX records one pair twice. */
const DEP_RANK: Record<NxProjectDependency['type'], number> = { static: 0, dynamic: 1, implicit: 2 };

export interface NxGraphRead {
  /** project → project dependencies between discovered projects, one per pair, sorted */
  dependencies: NxProjectDependency[];
  /** the type NX gives each discovered project it lists (`app` → application, `lib` → library, `e2e`) */
  types: Map<string, ProjectType>;
  /** the file read, when one was: its source-relative path and what in it counted */
  graphFile?: { path: string; projects: number; dependencies: number };
  /** one sentence per thing set aside */
  notes: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The file to read: the configured one (checked), else the first NX cache path that exists. */
function locate(repoRoot: string, configured: string | undefined, notes: string[]): { abs: string; rel: string } | undefined {
  if (configured !== undefined) {
    const checked = graphFilePath(configured);
    if ('note' in checked) { notes.push(checked.note); return undefined; }
    return { abs: join(repoRoot, checked.path), rel: checked.path };
  }
  for (const rel of NX_GRAPH_PATHS) {
    try { if (statSync(join(repoRoot, rel)).isFile()) return { abs: join(repoRoot, rel), rel }; } catch { /* not written there */ }
  }
  return undefined;
}

/**
 * Read NX's project graph for a source whose projects discovery already found. Returns no
 * dependencies (and a note when something was named but could not be read) whenever the file is
 * missing, outside the source, too large, not JSON, or not the shape NX writes.
 */
export function readNxProjectGraph(repoRoot: string, projects: readonly ProjectDecl[], configured?: string): NxGraphRead {
  const out: NxGraphRead = { dependencies: [], types: new Map(), notes: [] };
  const where = locate(repoRoot, configured, out.notes);
  if (!where) return out;
  const { rel } = where;
  // the real path must stay inside the real source root: a symlink out of the repo is not followed
  let real: string;
  try {
    real = realpathSync(where.abs);
    const root = realpathSync(repoRoot);
    const inside = relative(root, real);
    if (!inside || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) {
      out.notes.push(`The NX project graph ${rel} resolves outside the source, so it is not read.`);
      return out;
    }
  } catch {
    if (configured !== undefined) out.notes.push(`The NX project graph ${rel} named in farsight.config.json was not found.`);
    return out;
  }
  let text: string;
  try {
    const st = statSync(real);
    if (!st.isFile()) { out.notes.push(`The NX project graph ${rel} is not a file, so it is not read.`); return out; }
    if (st.size > NX_GRAPH_MAX_BYTES) {
      out.notes.push(`The NX project graph ${rel} is ${(st.size / 1048576).toFixed(1)} MB, over the ${NX_GRAPH_MAX_BYTES / 1048576} MB Farsight reads, so it is not read.`);
      return out;
    }
    text = readFileSync(real, 'utf8');
  } catch (err) {
    out.notes.push(`The NX project graph ${rel} could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'}).`);
    return out;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (err) {
    out.notes.push(`The NX project graph ${rel} could not be read as JSON (${(err as Error).message.slice(0, 120)}).`);
    return out;
  }
  // `nx graph --file` wraps the graph in `{ graph }`; the cache writes it bare
  const g = isObject(parsed) && isObject(parsed.graph) ? parsed.graph : parsed;
  if (!isObject(g) || !isObject(g.nodes) || !isObject(g.dependencies)) {
    out.notes.push(`The NX project graph ${rel} has no nodes and dependencies objects, so it is not read.`);
    return out;
  }
  const known = new Set(projects.map((p) => p.name));
  const unknown = new Set<string>();
  let listed = 0;
  for (const name of Object.keys(g.nodes)) {
    if (!known.has(name)) { unknown.add(name); continue; }
    listed++;
    const node = g.nodes[name];
    const type = isObject(node) && typeof node.type === 'string' ? NX_TYPES[node.type] : undefined;
    if (type) out.types.set(name, type);
  }
  const pairs = new Map<string, NxProjectDependency>();
  let malformed = 0;
  for (const [source, list] of Object.entries(g.dependencies)) {
    if (!Array.isArray(list)) { malformed++; continue; }
    for (const d of list) {
      if (!isObject(d) || typeof d.target !== 'string' || typeof d.type !== 'string' || !DEP_TYPES.has(d.type as NxProjectDependency['type'])) { malformed++; continue; }
      const from = typeof d.source === 'string' ? d.source : source;
      const to = d.target;
      if (to.startsWith('npm:')) continue; // an npm package — the dependencies pass reads those from the imports
      if (!known.has(from)) { unknown.add(from); continue; }
      if (!known.has(to)) { unknown.add(to); continue; }
      if (from === to) continue;
      const type = d.type as NxProjectDependency['type'];
      const k = `${from}\u0000${to}`;
      const prior = pairs.get(k);
      if (!prior || DEP_RANK[type] < DEP_RANK[prior.type]) pairs.set(k, { from, to, type, via: 'nx-graph' });
    }
  }
  out.dependencies = [...pairs.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  out.graphFile = { path: rel, projects: listed, dependencies: out.dependencies.length };
  if (unknown.size) out.notes.push(`The NX project graph ${rel} names ${unknown.size} project${unknown.size === 1 ? '' : 's'} this source does not declare; their dependencies are left out.`);
  if (malformed) out.notes.push(`The NX project graph ${rel} has ${malformed} dependenc${malformed === 1 ? 'y' : 'ies'} of a shape Farsight does not read; they are left out.`);
  return out;
}
