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

/** One project → project dependency: imports read from the files, a declared `implicitDependencies` entry, or both. */
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
}

export interface ProjectGraph {
  /** each source read, with the tool that described its projects and the dimensions it groups by */
  repos: { repo: string; tool: ProjectsMeta['tool']; tagDimensions: TagDimension[]; tagValues?: Record<string, Record<string, string>>; notes?: string[] }[];
  projects: ProjectRow[];
  dependencies: ProjectDependency[];
  counts: {
    /** projects, by type */
    projects: Counted;
    /** project → project dependencies, read from imports or only declared */
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

/**
 * The project graph of every source that recorded `meta.projects` (or the one `repo` names): each
 * project with its tags, facets and nodes by kind, and project → project dependencies — the imports
 * between their files that ingest read, plus NX `implicitDependencies`. Counts arrive as `Counted`s.
 */
export function projectGraph(index: GraphIndex, metas: Record<string, ProjectsMeta> | undefined, opts: { repo?: string } = {}): ProjectGraph {
  const entries = Object.entries(metas ?? {}).filter(([r]) => !opts.repo || r === opts.repo).sort(([a], [b]) => a.localeCompare(b));
  const wanted = new Set(entries.map(([r]) => r));
  // nodes by repo → project → kind
  const byProject = new Map<string, Map<string, number>>();
  for (const n of index.byId.values()) {
    if (!n.project) continue;
    const repo = nodeOfRepo(n);
    if (!wanted.has(repo)) continue;
    const key = `${repo}::project::${n.project.name}`;
    let kinds = byProject.get(key);
    if (!kinds) byProject.set(key, (kinds = new Map()));
    kinds.set(n.kind, (kinds.get(n.kind) ?? 0) + 1);
  }
  const repos: ProjectGraph['repos'] = [];
  const projects: ProjectRow[] = [];
  const dependencies: ProjectDependency[] = [];
  const unknownImplicit: ProjectGraph['unknownImplicit'] = [];
  for (const [repo, meta] of entries) {
    const dims = meta.tagDimensions?.length ? meta.tagDimensions : [...DEFAULT_TAG_DIMENSIONS];
    repos.push({ repo, tool: meta.tool, tagDimensions: dims, ...(meta.tagValues ? { tagValues: meta.tagValues } : {}), ...(meta.notes?.length ? { notes: meta.notes } : {}) });
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
    const repoDeps = [...deps.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    for (const d of repoDeps) d.count = importsCounted(d.imports);
    dependencies.push(...repoDeps);
    for (const p of [...meta.projects].sort((a, b) => a.name.localeCompare(b.name))) {
      const id = `${repo}::project::${p.name}`;
      const kinds = byProject.get(id) ?? new Map<string, number>();
      const total = [...kinds.values()].reduce((a, b) => a + b, 0);
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
        dependsOn: [...new Set(repoDeps.filter((d) => d.from === p.name).map((d) => d.to))].sort(),
        dependents: [...new Set(repoDeps.filter((d) => d.to === p.name).map((d) => d.from))].sort(),
      });
    }
  }
  // counts over every project listed
  const typeParts = new Map<string, number>();
  for (const p of projects) typeParts.set(p.type ?? 'none', (typeParts.get(p.type ?? 'none') ?? 0) + 1);
  const projectsCount = counted(projects.length, 'count.unit.projects', 'count.scope.workspace', 'core projects.ts projectGraph · meta.projects', {
    bizUnit: 'count.unit.projects',
    ...(projects.length ? { breakdown: ['application', 'library', 'e2e', 'none'].filter((t) => typeParts.get(t)).map((t) => ({ key: TYPE_PART[t]!, n: typeParts.get(t)! })) } : {}),
  });
  const imported = dependencies.filter((d) => d.imports > 0).length;
  const declaredOnly = dependencies.length - imported;
  const depsCount = counted(dependencies.length, 'count.unit.projectDeps', 'count.scope.workspace', 'core projects.ts projectGraph · meta.projects.imports + implicitDependencies', {
    bizUnit: 'count.unit.projectDeps',
    ...(dependencies.length ? { breakdown: [
      ...(imported ? [{ key: 'count.part.depsImported', n: imported }] : []),
      ...(declaredOnly ? [{ key: 'count.part.depsDeclared', n: declaredOnly }] : []),
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
  return { repos, projects, dependencies, counts: { projects: projectsCount, dependencies: depsCount, byDimension }, unknownImplicit };
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
 * (pass `repo`).
 */
export function appClosure(pg: ProjectGraph, name: string, repo?: string): ProjectClosure | undefined {
  const hit = findProject(pg, name, repo);
  if (!hit || Array.isArray(hit)) return undefined;
  const deps = pg.dependencies.filter((d) => d.repo === hit.repo);
  const order = [hit.name];
  const seen = new Set(order);
  for (let i = 0; i < order.length; i++) {
    for (const d of deps) if (d.from === order[i] && !seen.has(d.to)) { seen.add(d.to); order.push(d.to); }
  }
  return {
    project: hit,
    projects: order,
    dependencies: deps.filter((d) => seen.has(d.from) && seen.has(d.to)),
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
  return [`${tools} · ${pg.projects.length} projects${types ? ` (${types})` : ''} · ${pg.counts.dependencies.n} project dependencies`, ...dims].join(' — ');
}
