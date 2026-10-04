/**
 * Projects and tags as facets, and the project graph (docs/proposals/dependencies-and-nx.md §2.2–§2.3).
 *
 * The projects pass (parsers/src/shared/projects.ts) stamps a `ProjectRef` on every node under a project
 * root and records, per source, the projects it read, the tag dimensions and the imports between project
 * files on `meta.projects`. Everything here is a fold over that one graph: the facets a lens groups by,
 * the project graph (projects, their node counts, project → project dependencies) and an application's
 * closure. Nothing is stored twice.
 */
import type { GraphNode, ProjectRef, ProjectsMeta, ProjectType, TagDimension, ProjectDecl } from './graph.js';
import type { GraphIndex } from './query.js';
import { counted, type Counted, type CountPart } from './counts.js';

/** The dimensions every workspace starts with; `farsight.config.json → projects.tagDimensions` adds or renames. */
export const DEFAULT_TAG_DIMENSIONS: readonly TagDimension[] = [
  { key: 'domain', prefix: 'scope:', label: 'Domain' },
  { key: 'type', prefix: 'type:', label: 'Type' },
  { key: 'platform', prefix: 'platform:', label: 'Platform' },
];

/**
 * The defaults with a config's dimensions laid over them: an entry with the key or the prefix of a
 * default replaces it in place, any other is added after them. A later config entry wins over an
 * earlier one with the same key.
 */
export function mergeTagDimensions(config?: readonly TagDimension[]): TagDimension[] {
  const out: TagDimension[] = DEFAULT_TAG_DIMENSIONS.map((d) => ({ ...d }));
  for (const c of config ?? []) {
    const at = out.findIndex((d) => d.key === c.key || d.prefix === c.prefix);
    if (at >= 0) out[at] = { ...c };
    else out.push({ ...c });
  }
  return out;
}

/** `data-access` → *Data access*, `billing` → *Billing*: the word for a tag value nobody gave one. */
function humanizeValue(v: string): string {
  const s = v.replace(/[-_]+/g, ' ').trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : v;
}

/** The word a lens prints for one tag value: the config's word, else the value humanized. */
export function tagValueWord(key: string, value: string, tagValues?: Record<string, Record<string, string>>): string {
  const own = tagValues?.[key];
  return own && Object.prototype.hasOwnProperty.call(own, value) ? own[value]! : humanizeValue(value);
}

/** One tag under one dimension: the value as written and the word a person reads. */
export interface FacetValue {
  value: string;
  word: string;
}

/** What a lens groups and filters a node by. `domain` · `type` · `platform` are the first value under each default dimension. */
export interface ProjectFacets {
  project: string;
  projectType?: ProjectType;
  domain?: string;
  type?: string;
  platform?: string;
  /** every dimension the source defines, keyed by dimension key; a dimension the project has no tag in is absent */
  byDimension: Record<string, FacetValue[]>;
  /** tags no dimension's prefix claims, as written */
  other: string[];
}

/** Split tags by dimension: `scope:billing` → domain billing; a tag without a known prefix lands in `other`. */
export function facetsOfTags(tags: readonly string[], dims: readonly TagDimension[], tagValues?: Record<string, Record<string, string>>): Pick<ProjectFacets, 'byDimension' | 'other'> {
  const byDimension: Record<string, FacetValue[]> = {};
  const other: string[] = [];
  for (const tag of tags) {
    // the longest prefix wins, so `scope:billing:` beside `scope:` is a dimension of its own
    let best: TagDimension | undefined;
    for (const d of dims) if (tag.startsWith(d.prefix) && tag.length > d.prefix.length && (!best || d.prefix.length > best.prefix.length)) best = d;
    if (!best) { other.push(tag); continue; }
    const value = tag.slice(best.prefix.length);
    (byDimension[best.key] ??= []).push({ value, word: tagValueWord(best.key, value, tagValues) });
  }
  return { byDimension, other };
}

/**
 * A node's project and its tags split by dimension — the lenses' one reading of `GraphNode.project`.
 * `meta` is the source's `meta.projects` (its dimensions and value words); without it the defaults apply.
 * Undefined for a node outside every project.
 */
export function projectFacets(node: Pick<GraphNode, 'project'> | { project?: ProjectRef }, meta?: Pick<ProjectsMeta, 'tagDimensions' | 'tagValues'>): ProjectFacets | undefined {
  const p = node.project;
  if (!p) return undefined;
  const { byDimension, other } = facetsOfTags(p.tags ?? [], meta?.tagDimensions?.length ? meta.tagDimensions : DEFAULT_TAG_DIMENSIONS, meta?.tagValues);
  const first = (k: string) => byDimension[k]?.[0]?.value;
  return {
    project: p.name,
    ...(p.type ? { projectType: p.type } : {}),
    ...(first('domain') ? { domain: first('domain')! } : {}),
    ...(first('type') ? { type: first('type')! } : {}),
    ...(first('platform') ? { platform: first('platform')! } : {}),
    byDimension,
    other,
  };
}

// ── the project graph ────────────────────────────────────────────────────

/** One project → project dependency: imports read from the files, a declared `implicitDependencies` entry, NX's own project graph, or several. */
export interface ProjectDependency {
  repo: string;
  from: string;
  to: string;
  /** import statements in `from`'s files that resolve to a file of `to` (0 when only declared) */
  imports: number;
  /** files of `from` carrying at least one */
  files: number;
  /** the files with the most such imports, most first */
  top: { path: string; imports: number }[];
  /** NX `implicitDependencies` names `to` */
  implicit?: true;
  /** NX's own project graph (the file NX wrote, `meta.projects.dependencies`) records it too — or only it, when `imports` is 0 and it is not `implicit` */
  nx?: true;
  /** how NX's graph records it: `static` an import NX read, `dynamic` a lazy import, `implicit` declared */
  nxType?: 'static' | 'dynamic' | 'implicit';
  /** the import statements as a count, with what it counts over */
  count: Counted;
}

export interface ProjectRow {
  /** `${repo}::project::${name}` — a stable key, not a graph node id */
  id: string;
  repo: string;
  name: string;
  root: string;
  type?: ProjectType;
  tags: string[];
  via: ProjectDecl['via'];
  sourceRoot?: string;
  implicitDependencies?: string[];
  facets: Pick<ProjectFacets, 'byDimension' | 'other'>;
  /** the graph's nodes stamped with this project, by kind */
  nodes: Counted;
  /** the projects this one depends on / that depend on it, by name, sorted */
  dependsOn: string[];
  dependents: string[];
  /** the project's tree: itself, then every project it depends on directly or through another, nearest first — `appClosure().projects` */
  closure: string[];
}

export interface ProjectGraph {
  /** each source read, with the tool that described its projects and the dimensions it groups by */
  repos: { repo: string; tool: ProjectsMeta['tool']; tagDimensions: TagDimension[]; tagValues?: Record<string, Record<string, string>>; notes?: string[]; graphFile?: ProjectsMeta['graphFile'] }[];
  projects: ProjectRow[];
  dependencies: ProjectDependency[];
  counts: {
    /** projects, by type */
    projects: Counted;
    /** project → project dependencies, read from imports, only declared, or only in NX's project graph */
    dependencies: Counted;
    /** per dimension key: projects by the tag value they carry in it */
    byDimension: Record<string, Counted>;
  };
  /** implicitDependencies naming a project no source declares — said, never dropped */
  unknownImplicit: { repo: string; from: string; to: string }[];
}

const TYPE_PART: Record<string, string> = {
  application: 'count.part.projectsApp',
  library: 'count.part.projectsLib',
  e2e: 'count.part.projectsE2e',
  none: 'count.part.projectsUntyped',
};

function nodeOfRepo(n: GraphNode): string {
  return n.loc?.repo ?? n.id.split('::')[0]!;
}

// ── computed once per graph ──────────────────────────────────────────────
//
// A server loads a graph once (`loadJourneyGraph` memoizes the index by mtime) and answers many
// `/api/projects*` requests from it, so the fold — a walk over every node — runs once per index and
// is kept beside it. A different index (a re-ingest, a reload) folds again; the WeakMap lets an index
// nobody holds go. What comes back is shared: callers read it, never mutate it.

/** The whole fold of one index, plus the per-repo narrowings and each project's node ids by kind. */
interface Fold {
  metas: Record<string, ProjectsMeta> | undefined;
  whole: ProjectGraph;
  byRepo: Map<string, ProjectGraph>;
  /** `${repo}::project::${name}` → kind → node ids, sorted */
  nodeIds: Map<string, Record<string, string[]>>;
}
const foldCache = new WeakMap<GraphIndex, Fold>();

/** The adjacency a closure walks, built once per project graph, and every closure asked for so far. */
interface Walk {
  /** repo → its dependencies, in the graph's order (from, then to) */
  depsByRepo: Map<string, ProjectDependency[]>;
  /** `${repo}\0${from}` → the projects `from` depends on, in the graph's order */
  next: Map<string, string[]>;
  /** `${repo}\0${name}` → the closure, project first */
  closures: Map<string, string[]>;
}
const walkCache = new WeakMap<ProjectGraph, Walk>();

function walkOf(pg: ProjectGraph): Walk {
  let w = walkCache.get(pg);
  if (w) return w;
  w = { depsByRepo: new Map(), next: new Map(), closures: new Map() };
  for (const d of pg.dependencies) {
    const list = w.depsByRepo.get(d.repo);
    if (list) list.push(d); else w.depsByRepo.set(d.repo, [d]);
    const k = `${d.repo}\u0000${d.from}`;
    const out = w.next.get(k);
    if (out) out.push(d.to); else w.next.set(k, [d.to]);
  }
  walkCache.set(pg, w);
  return w;
}

/** Breadth first from `name`: the project, then what it depends on, nearest first; each once. */
function closureOf(w: Walk, repo: string, name: string): string[] {
  const key = `${repo}\u0000${name}`;
  const hit = w.closures.get(key);
  if (hit) return hit;
  const order = [name];
  const seen = new Set(order);
  for (let i = 0; i < order.length; i++) {
    for (const to of w.next.get(`${repo}\u0000${order[i]}`) ?? []) if (!seen.has(to)) { seen.add(to); order.push(to); }
  }
  w.closures.set(key, order);
  return order;
}

/**
 * The project graph of every source that recorded `meta.projects` (or the one `repo` names): each
 * project with its tags, facets, nodes by kind and closure, and project → project dependencies — the
 * imports between their files that ingest read, plus NX `implicitDependencies`, plus what NX's own
 * project graph file records. Counts arrive as `Counted`s.
 *
 * Folded once per index (and per `metas` object) and kept; `opts.repo` narrows the kept fold by rows.
 * The result is shared between callers — read it, never mutate it.
 */
export function projectGraph(index: GraphIndex, metas: Record<string, ProjectsMeta> | undefined, opts: { repo?: string } = {}): ProjectGraph {
  const f = foldOf(index, metas);
  if (!opts.repo) return f.whole;
  let narrowed = f.byRepo.get(opts.repo);
  if (!narrowed) {
    narrowed = narrow(f.whole, opts.repo);
    f.byRepo.set(opts.repo, narrowed);
  }
  return narrowed;
}

/**
 * The ids of the nodes stamped with one project, by kind, sorted — from the same kept fold, so a
 * route answers it as a lookup. A `module` node (a file's import list) is no part and is left out,
 * the way the node counts leave it out.
 */
export function projectNodeIds(index: GraphIndex, metas: Record<string, ProjectsMeta> | undefined, repo: string, name: string): Record<string, string[]> {
  return foldOf(index, metas).nodeIds.get(`${repo}::project::${name}`) ?? {};
}

function foldOf(index: GraphIndex, metas: Record<string, ProjectsMeta> | undefined): Fold {
  const hit = foldCache.get(index);
  if (hit && hit.metas === metas) return hit;
  const f = foldWhole(index, metas);
  foldCache.set(index, f);
  return f;
}

function narrow(whole: ProjectGraph, repo: string): ProjectGraph {
  const repos = whole.repos.filter((r) => r.repo === repo);
  const projects = whole.projects.filter((p) => p.repo === repo);
  const dependencies = whole.dependencies.filter((d) => d.repo === repo);
  const pg: ProjectGraph = {
    repos, projects, dependencies,
    counts: countsOf(repos, projects, dependencies),
    unknownImplicit: whole.unknownImplicit.filter((u) => u.repo === repo),
  };
  // one repo's dependencies are the same rows in both, so the narrowing walks the whole graph's adjacency
  walkCache.set(pg, walkOf(whole));
  return pg;
}

function foldWhole(index: GraphIndex, metas: Record<string, ProjectsMeta> | undefined): Fold {
  const entries = Object.entries(metas ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const wanted = new Set(entries.map(([r]) => r));
  // nodes by repo → project → kind, counted and listed in one walk
  const nodeIds = new Map<string, Record<string, string[]>>();
  for (const n of index.byId.values()) {
    // a module node is a file's import list (the dependencies pass), not a part of the project
    if (!n.project || n.kind === 'module') continue;
    const repo = nodeOfRepo(n);
    if (!wanted.has(repo)) continue;
    const key = `${repo}::project::${n.project.name}`;
    let kinds = nodeIds.get(key);
    if (!kinds) nodeIds.set(key, (kinds = {}));
    (kinds[n.kind] ??= []).push(n.id);
  }
  for (const kinds of nodeIds.values()) for (const ids of Object.values(kinds)) ids.sort();
  const repos: ProjectGraph['repos'] = [];
  const projects: ProjectRow[] = [];
  const dependencies: ProjectDependency[] = [];
  const unknownImplicit: ProjectGraph['unknownImplicit'] = [];
  for (const [repo, meta] of entries) {
    const dims = meta.tagDimensions?.length ? meta.tagDimensions : [...DEFAULT_TAG_DIMENSIONS];
    repos.push({
      repo, tool: meta.tool, tagDimensions: dims,
      ...(meta.tagValues ? { tagValues: meta.tagValues } : {}),
      ...(meta.notes?.length ? { notes: meta.notes } : {}),
      ...(meta.graphFile ? { graphFile: meta.graphFile } : {}),
    });
    const names = new Set(meta.projects.map((p) => p.name));
    const deps = new Map<string, ProjectDependency>();
    const dep = (from: string, to: string): ProjectDependency => {
      const k = `${from}\u0000${to}`;
      let d = deps.get(k);
      if (!d) deps.set(k, (d = { repo, from, to, imports: 0, files: 0, top: [], count: importsCounted(0) }));
      return d;
    };
    for (const i of meta.imports ?? []) {
      if (!names.has(i.from) || !names.has(i.to) || i.from === i.to) continue;
      const d = dep(i.from, i.to);
      d.imports += i.imports; d.files += i.files; d.top = [...d.top, ...i.top].sort((a, b) => b.imports - a.imports || a.path.localeCompare(b.path)).slice(0, 5);
    }
    for (const p of meta.projects) {
      for (const to of p.implicitDependencies ?? []) {
        if (to === p.name) continue;
        if (!names.has(to)) { unknownImplicit.push({ repo, from: p.name, to }); continue; }
        dep(p.name, to).implicit = true;
      }
    }
    // NX's own graph augments what the files show; it never takes an import count away
    for (const x of meta.dependencies ?? []) {
      if (!names.has(x.from) || !names.has(x.to) || x.from === x.to) continue;
      const d = dep(x.from, x.to);
      d.nx = true;
      d.nxType ??= x.type;
    }
    const repoDeps = [...deps.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    for (const d of repoDeps) d.count = importsCounted(d.imports);
    dependencies.push(...repoDeps);
    const dependsOn = new Map<string, Set<string>>();
    const dependents = new Map<string, Set<string>>();
    for (const d of repoDeps) {
      (dependsOn.get(d.from) ?? dependsOn.set(d.from, new Set()).get(d.from)!).add(d.to);
      (dependents.get(d.to) ?? dependents.set(d.to, new Set()).get(d.to)!).add(d.from);
    }
    for (const p of [...meta.projects].sort((a, b) => a.name.localeCompare(b.name))) {
      const id = `${repo}::project::${p.name}`;
      const kinds = Object.entries(nodeIds.get(id) ?? {}).map(([kind, ids]) => [kind, ids.length] as const);
      const total = kinds.reduce((a, [, n]) => a + n, 0);
      const breakdown: CountPart[] = [...kinds].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([kind, n]) => ({ key: 'count.part.ofKind', n, label: kind }));
      projects.push({
        id, repo, name: p.name, root: p.root,
        ...(p.type ? { type: p.type } : {}),
        tags: [...p.tags], via: p.via,
        ...(p.sourceRoot ? { sourceRoot: p.sourceRoot } : {}),
        ...(p.implicitDependencies?.length ? { implicitDependencies: [...p.implicitDependencies] } : {}),
        facets: facetsOfTags(p.tags, dims, meta.tagValues),
        nodes: counted(total, 'count.unit.parts', 'count.scope.project', 'core projects.ts projectGraph · GraphNode.project', {
          bizUnit: 'count.unit.parts', ...(breakdown.length ? { breakdown } : {}),
        }),
        dependsOn: [...(dependsOn.get(p.name) ?? [])].sort(),
        dependents: [...(dependents.get(p.name) ?? [])].sort(),
        closure: [],
      });
    }
  }
  const whole: ProjectGraph = { repos, projects, dependencies, counts: countsOf(repos, projects, dependencies), unknownImplicit };
  // every project's tree, so one answer carries them all (the viewer draws an app without a second fetch)
  const w = walkOf(whole);
  for (const p of projects) p.closure = closureOf(w, p.repo, p.name);
  return { metas, whole, byRepo: new Map(), nodeIds };
}

/** The counts over the projects and dependencies listed: by type, by dependency evidence, per dimension. */
function countsOf(repos: ProjectGraph['repos'], projects: ProjectRow[], dependencies: ProjectDependency[]): ProjectGraph['counts'] {
  const typeParts = new Map<string, number>();
  for (const p of projects) typeParts.set(p.type ?? 'none', (typeParts.get(p.type ?? 'none') ?? 0) + 1);
  const projectsCount = counted(projects.length, 'count.unit.projects', 'count.scope.workspace', 'core projects.ts projectGraph · meta.projects', {
    bizUnit: 'count.unit.projects',
    ...(projects.length ? { breakdown: ['application', 'library', 'e2e', 'none'].filter((t) => typeParts.get(t)).map((t) => ({ key: TYPE_PART[t]!, n: typeParts.get(t)! })) } : {}),
  });
  // a partition: an import shows it · else a project's settings declare it · else only NX's graph records it
  const imported = dependencies.filter((d) => d.imports > 0).length;
  const declaredOnly = dependencies.filter((d) => d.imports === 0 && d.implicit).length;
  const nxOnly = dependencies.length - imported - declaredOnly;
  const depsCount = counted(dependencies.length, 'count.unit.projectDeps', 'count.scope.workspace', 'core projects.ts projectGraph · meta.projects.imports + implicitDependencies + dependencies (NX project graph)', {
    bizUnit: 'count.unit.projectDeps',
    ...(dependencies.length ? { breakdown: [
      ...(imported ? [{ key: 'count.part.depsImported', n: imported }] : []),
      ...(declaredOnly ? [{ key: 'count.part.depsDeclared', n: declaredOnly }] : []),
      ...(nxOnly ? [{ key: 'count.part.depsNxGraph', n: nxOnly }] : []),
    ] } : {}),
  });
  // per dimension: a project lands in the part named by its values in that dimension (joined when it has two), else "no tag"
  const byDimension: Record<string, Counted> = {};
  const dimKeys = new Map<string, true>();
  for (const r of repos) for (const d of r.tagDimensions) dimKeys.set(d.key, true);
  for (const key of dimKeys.keys()) {
    const parts = new Map<string, number>();
    let none = 0;
    for (const p of projects) {
      const vals = p.facets.byDimension[key];
      if (!vals?.length) { none++; continue; }
      const label = vals.map((v) => v.word).join(', ');
      parts.set(label, (parts.get(label) ?? 0) + 1);
    }
    if (!parts.size) continue;
    const breakdown: CountPart[] = [...parts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label, n]) => ({ key: 'count.part.withTag', n, label }));
    if (none) breakdown.push({ key: 'count.part.noTag', n: none });
    byDimension[key] = counted(projects.length, 'count.unit.projects', 'count.scope.workspace', `core projects.ts projectGraph · tags under ${key}`, { bizUnit: 'count.unit.projects', breakdown });
  }
  return { projects: projectsCount, dependencies: depsCount, byDimension };
}

function importsCounted(n: number): Counted {
  return counted(n, 'count.unit.importStatements', 'count.scope.project', 'core projects.ts projectGraph · meta.projects.imports');
}

/** Find one project by name (and repo, when two sources share a name). */
export function findProject(pg: ProjectGraph, name: string, repo?: string): ProjectRow | ProjectRow[] | undefined {
  const hits = pg.projects.filter((p) => p.name === name && (!repo || p.repo === repo));
  if (!hits.length) return undefined;
  return hits.length === 1 ? hits[0]! : hits;
}

export interface ProjectClosure {
  project: ProjectRow;
  /** the project first, then every project it depends on directly or through another, nearest first */
  projects: string[];
  /** the dependencies between the projects of the closure */
  dependencies: ProjectDependency[];
  /** the projects it depends on, each once (the project itself not counted) */
  count: Counted;
}

/**
 * An application (or any project) plus the transitive closure of its project dependencies — the
 * code map's *App and its related* view. Undefined when the name matches no project, or several
 * (pass `repo`). The walk runs over an adjacency built once per project graph and each closure is
 * kept, so asking again is a lookup.
 */
export function appClosure(pg: ProjectGraph, name: string, repo?: string): ProjectClosure | undefined {
  const hit = findProject(pg, name, repo);
  if (!hit || Array.isArray(hit)) return undefined;
  const w = walkOf(pg);
  const order = closureOf(w, hit.repo, hit.name);
  const seen = new Set(order);
  return {
    project: hit,
    projects: [...order],
    dependencies: (w.depsByRepo.get(hit.repo) ?? []).filter((d) => seen.has(d.from) && seen.has(d.to)),
    count: counted(order.length - 1, 'count.unit.projectsDependedOn', 'count.scope.project', 'core projects.ts appClosure · projectGraph dependencies', { bizUnit: 'count.unit.projectsDependedOn' }),
  };
}

/** One line for an agent or a terminal: the tool, how many projects of each type, and the projects per tag value of each dimension. */
export function projectsSummaryLine(pg: ProjectGraph): string {
  if (!pg.projects.length) return '';
  const tools = [...new Set(pg.repos.map((r) => r.tool))].join(' · ');
  const types = (pg.counts.projects.breakdown ?? []).map((p) => `${p.n} ${{ 'count.part.projectsApp': 'applications', 'count.part.projectsLib': 'libraries', 'count.part.projectsE2e': 'e2e', 'count.part.projectsUntyped': 'untyped' }[p.key] ?? p.key}`).join(' · ');
  const labelOf = new Map<string, string>();
  for (const r of pg.repos) for (const d of r.tagDimensions) if (!labelOf.has(d.key)) labelOf.set(d.key, d.label);
  const dims = Object.entries(pg.counts.byDimension).map(([key, c]) =>
    `${labelOf.get(key) ?? key}: ${(c.breakdown ?? []).map((p) => `${p.label ?? 'no tag'} ${p.n}`).join(' · ')}`);
  const nxRead = pg.repos.reduce((a, r) => a + (r.graphFile?.dependencies ?? 0), 0);
  const nx = pg.repos.some((r) => r.graphFile) ? ` · nx graph: ${nxRead} dependencies read` : '';
  return [`${tools} · ${pg.projects.length} projects${types ? ` (${types})` : ''} · ${pg.counts.dependencies.n} project dependencies${nx}`, ...dims].join(' — ');
}
