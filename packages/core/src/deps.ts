/**
 * Dependencies — packages as nodes, folded (docs/proposals/dependencies-and-nx.md §2.1, §2.3).
 *
 * Two folds over the one graph, never a second store:
 *  - `packagesOf()` — every `package` node in scope, with the ranges its package.json files
 *    declare, how many files import it and how many journeys reach it.
 *  - `importersOf()` — every file that imports one package, grouped by project (when the graph
 *    carries projects) or source, each with the line and the specifier it wrote, and the
 *    functions in that file whose bodies use it.
 *
 * *Journeys reached* is an impact question asked of the package node: the code that uses it, up to
 * `hops` uses away (`impactOf`, the same walk `impact_of` answers with — plumbing is listed and not
 * opened), and every journey whose walk passes through one of those nodes or one of their gates.
 */
import type { GraphNode, PackageDeclaration } from './graph.js';
import { type GraphIndex, journey, repoOf } from './query.js';
import { screensFor } from './design.js';
import { impactOf } from './impact.js';
import { counted, type Counted, type CountPart } from './counts.js';

export type PackageScope = 'third-party' | 'workspace';

/** One package.json's range for a package, and the project or source it belongs to. */
export interface DepsVersion {
  /** the project the declaring package.json sits in, else its directory, else the source name */
  where: string;
  range: string;
  /** repo-relative path of the package.json */
  declaredIn: string;
  field: PackageDeclaration['field'];
}

export interface DepsRow {
  id: string;
  name: string;
  repo: string;
  scope: PackageScope;
  /** the range when every declaration agrees (else the root-most one; `versions` keeps them all) */
  version?: string;
  dev?: true;
  project?: string;
  root?: string;
  externalId?: string;
  note?: string;
  versions: DepsVersion[];
  /** files with an `imports` edge to the package */
  importers: Counted;
  /** journeys whose walk passes through code that uses it */
  journeys: Counted;
  /** the journeys themselves, by id and name */
  journeyRefs: { id: string; name: string }[];
}

export interface DepsOptions {
  repo?: string;
  /** a project name: packages a file of that project imports, or the workspace package that is that project */
  project?: string;
  scope?: PackageScope;
  /** how many uses away from the package the journeys question looks (default 2 — `impact_of`'s default) */
  hops?: number;
}

export interface DepsList {
  rows: DepsRow[];
  /** the packages listed, split third-party · workspace — a partition */
  packages: Counted;
}

/** The project a node belongs to, when the graph carries projects (the projects pass stamps `node.project`). */
function projectOf(n: GraphNode | undefined): string | undefined {
  return n?.project?.name;
}

/** Every node a journey's walk passes through, gates included — computed once per index and reused. */
const journeyNodeCache = new WeakMap<GraphIndex, { id: string; name: string; nodes: Set<string> }[]>();
function journeyNodeSets(index: GraphIndex): { id: string; name: string; nodes: Set<string> }[] {
  const hit = journeyNodeCache.get(index);
  if (hit) return hit;
  const out: { id: string; name: string; nodes: Set<string> }[] = [];
  for (const flow of index.byId.values()) {
    if (flow.kind !== 'flow') continue;
    const nodes = new Set<string>();
    try {
      for (const s of journey(index, flow.id).steps) {
        nodes.add(s.nodeId);
        for (const g of s.gates) nodes.add(g.id);
      }
      for (const sc of screensFor(index, flow.id)) nodes.add(sc.id);
    } catch {
      continue; // a flow that cannot be walked contributes nothing, and claims nothing
    }
    out.push({ id: flow.id, name: flow.name, nodes });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  journeyNodeCache.set(index, out);
  return out;
}

/** The journeys that reach a package: the code that uses it, `hops` uses deep, met by each journey's walk. */
export function journeysReaching(index: GraphIndex, packageId: string, hops = 2): { id: string; name: string }[] {
  if (!index.byId.has(packageId)) return [];
  const users = new Set<string>();
  const report = impactOf(index, packageId, { hops });
  for (const hp of report.hops) for (const n of hp.nodes) users.add(n.nodeId);
  if (!users.size) return [];
  return journeyNodeSets(index).filter((j) => [...users].some((u) => j.nodes.has(u))).map((j) => ({ id: j.id, name: j.name }));
}

/** The files that import a package (its `module` importers), as node ids. */
function importerModules(index: GraphIndex, packageId: string): GraphNode[] {
  const out = new Map<string, GraphNode>();
  for (const e of index.in.get(packageId) ?? []) {
    if (e.kind !== 'imports') continue;
    const from = index.byId.get(e.from);
    if (from?.kind === 'module') out.set(from.id, from);
  }
  return [...out.values()];
}

function versionsOf(n: GraphNode, index: GraphIndex): DepsVersion[] {
  const repo = repoOf(n);
  const modules = importerModules(index, n.id);
  return (n.package?.declarations ?? []).map((d) => {
    const dir = d.path.includes('/') ? d.path.slice(0, d.path.lastIndexOf('/')) : '';
    // the project of a file that sits beside the declaring package.json, when projects are known
    const proj = projectOf(modules.find((m) => m.loc && (dir === '' || m.loc.path.startsWith(dir + '/'))));
    return { where: proj ?? (dir ? `${repo}/${dir}` : repo), range: d.range, declaredIn: d.path, field: d.field };
  });
}

/** One package node as a row. */
export function depsRowOf(index: GraphIndex, n: GraphNode, hops = 2): DepsRow {
  const p = n.package ?? { scope: 'third-party' as const };
  const modules = importerModules(index, n.id);
  const journeys = journeysReaching(index, n.id, hops);
  return {
    id: n.id, name: n.name, repo: repoOf(n), scope: p.scope,
    ...(p.version ? { version: p.version } : {}),
    ...(p.dev ? { dev: true as const } : {}),
    ...(p.project ? { project: p.project } : {}),
    ...(p.root ? { root: p.root } : {}),
    ...(p.externalId ? { externalId: p.externalId } : {}),
    ...(p.note ? { note: p.note } : {}),
    versions: versionsOf(n, index),
    importers: counted(modules.length, 'count.unit.importers', 'count.scope.package', 'core deps.ts depsRowOf → module nodes with an imports edge to the package'),
    journeys: counted(journeys.length, 'count.unit.journeysReached', 'count.scope.package', `core deps.ts journeysReaching → impactOf(package, ${hops} hops) met by each journey's walk`,
      { bizUnit: 'count.unit.journeysReached' }),
    journeyRefs: journeys,
  };
}

/** Every package in scope, as rows, sorted by name then source. */
export function packagesOf(index: GraphIndex, opts: DepsOptions = {}): DepsList {
  const rows: DepsRow[] = [];
  for (const n of index.byId.values()) {
    if (n.kind !== 'package') continue;
    if (opts.repo && repoOf(n) !== opts.repo) continue;
    if (opts.scope && (n.package?.scope ?? 'third-party') !== opts.scope) continue;
    if (opts.project && n.package?.project !== opts.project
      && !importerModules(index, n.id).some((m) => projectOf(m) === opts.project)) continue;
    rows.push(depsRowOf(index, n, opts.hops));
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.repo.localeCompare(b.repo));
  const third = rows.filter((r) => r.scope === 'third-party').length;
  const parts: CountPart[] = [
    { key: 'count.part.packagesThirdParty', n: third },
    { key: 'count.part.packagesWorkspace', n: rows.length - third },
  ];
  return {
    rows,
    packages: counted(rows.length, 'count.unit.packages', 'count.scope.workspace', 'core deps.ts packagesOf → package nodes in scope', { breakdown: parts }),
  };
}

/** One file that imports a package. */
export interface DepsImporter {
  /** the module node */
  id: string;
  path: string;
  line: number;
  specifier: string;
  subpath?: string;
  typeOnly?: true;
  form?: string;
  /** the functions, components, schemas and tables in this file whose code uses the package */
  users: { id: string; name: string; kind: GraphNode['kind']; line?: number }[];
}

export interface DepsWhere {
  package: DepsRow;
  /** importers grouped by project (when the graph carries projects) or by source */
  groups: { key: string; by: 'project' | 'repo'; importers: DepsImporter[]; count: Counted }[];
  /** the files, all groups together — the groups partition it */
  importers: Counted;
}

/** Every file that imports one package, grouped, with the line, the specifier and the code in it that uses the package. */
export function importersOf(index: GraphIndex, packageId: string, opts: { hops?: number } = {}): DepsWhere | undefined {
  const pkg = index.byId.get(packageId);
  if (!pkg || pkg.kind !== 'package') return undefined;
  const usersByFile = new Map<string, DepsImporter['users']>();
  const rows: DepsImporter[] = [];
  for (const e of index.in.get(packageId) ?? []) {
    if (e.kind !== 'imports') continue;
    const from = index.byId.get(e.from);
    if (!from) continue;
    if (from.kind !== 'module') {
      const path = from.loc?.path;
      if (!path) continue;
      const list = usersByFile.get(path) ?? [];
      list.push({ id: from.id, name: from.name, kind: from.kind, ...(typeof e.meta?.line === 'number' ? { line: e.meta.line } : {}) });
      usersByFile.set(path, list);
      continue;
    }
    rows.push({
      id: from.id, path: from.loc?.path ?? from.name,
      line: typeof e.meta?.line === 'number' ? e.meta.line : 1,
      specifier: String(e.meta?.specifier ?? pkg.name),
      ...(e.meta?.subpath ? { subpath: String(e.meta.subpath) } : {}),
      ...(e.meta?.typeOnly ? { typeOnly: true as const } : {}),
      ...(e.meta?.form ? { form: String(e.meta.form) } : {}),
      users: [],
    });
  }
  for (const r of rows) r.users = (usersByFile.get(r.path) ?? []).sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.name.localeCompare(b.name));
  const grouped = new Map<string, { by: 'project' | 'repo'; importers: DepsImporter[] }>();
  for (const r of rows) {
    const m = index.byId.get(r.id);
    const proj = projectOf(m);
    const key = proj ?? (m ? repoOf(m) : repoOf(pkg));
    const g = grouped.get(key) ?? { by: proj ? 'project' as const : 'repo' as const, importers: [] };
    g.importers.push(r);
    grouped.set(key, g);
  }
  const groups = [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([key, g]) => {
    g.importers.sort((a, b) => a.path.localeCompare(b.path));
    return { key, by: g.by, importers: g.importers,
      count: counted(g.importers.length, 'count.unit.importers', 'count.scope.package', 'core deps.ts importersOf → module nodes of this group') };
  });
  return {
    package: depsRowOf(index, pkg, opts.hops),
    groups,
    importers: counted(rows.length, 'count.unit.importers', 'count.scope.package', 'core deps.ts importersOf → module nodes with an imports edge to the package',
      { breakdown: groups.map((g) => ({ key: 'count.unit.importers', n: g.importers.length, label: g.key })) }),
  };
}

/**
 * A package by id, or by name (`zod`, `@scope/pkg`) — `hit` when exactly one package node answers,
 * else every candidate id so the caller can say which sources carry it.
 */
export function resolvePackage(index: GraphIndex, ref: string, repo?: string): { hit?: GraphNode; candidates: string[] } {
  const direct = index.byId.get(ref);
  if (direct?.kind === 'package') return { hit: direct, candidates: [direct.id] };
  const hits = [...index.byId.values()].filter((n) => n.kind === 'package' && n.name === ref && (!repo || repoOf(n) === repo));
  return hits.length === 1 ? { hit: hits[0], candidates: [hits[0]!.id] } : { candidates: hits.map((n) => n.id).sort() };
}
