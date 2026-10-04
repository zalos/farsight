// lib/codemap-model.js — the code map's projects and packages, as pure functions
// (no DOM, no store), so a node test holds them to the NX example.
//
// Everything here is a fold over the one graph the page already holds
// (docs/proposals/dependencies-and-nx.md §2.3): a node's project and its tags
// split by dimension (the same reading as core projects.ts `projectFacets`), the
// group a card falls in when the map is grouped by project or by a tag
// dimension, which choices a graph can offer at all, the cards a *depends on*
// filter keeps, the order an application's projects are drawn in, and the band
// a journey takes on the Map when it is banded by domain. No number is invented:
// a group's count is the cards it holds, split by kind, and the parts add up.

/** The dimensions every workspace starts with (core projects.ts DEFAULT_TAG_DIMENSIONS). */
export const DEFAULT_DIMENSIONS = [
  { key: 'domain', prefix: 'scope:', label: 'Domain' },
  { key: 'type', prefix: 'type:', label: 'Type' },
  { key: 'platform', prefix: 'platform:', label: 'Platform' },
];

/** Keys of the groups that are not a project or a tag value. */
export const NO_TAG = '\u0000no-tag';
export const NO_PROJECT = '\u0000no-project';
export const THIRD_PARTY = '\u0000third-party';

/** The source a node belongs to (store.js `repoOf`, restated so this module stays pure). */
export function repoOfNode(n) {
  return (n && (n.repo || (n.loc && n.loc.repo) || String(n.id || '').split('::')[0])) || '';
}

/** One source's `meta.projects`, or undefined. `metas` is the graph's `meta.projects` (keyed by source). */
function metaOf(metas, repo) {
  return metas && typeof metas === 'object' ? metas[repo] : undefined;
}

/** The tag dimensions a source groups by: its own, else the defaults. */
export function dimensionsOf(metas, repo) {
  const m = metaOf(metas, repo);
  return m && Array.isArray(m.tagDimensions) && m.tagDimensions.length ? m.tagDimensions : DEFAULT_DIMENSIONS;
}

/** `data-access` → *Data access*: the word for a tag value nobody gave one (core `tagValueWord`). */
export function tagValueWord(key, value, tagValues) {
  const own = tagValues && tagValues[key];
  if (own && Object.prototype.hasOwnProperty.call(own, value)) return own[value];
  const s = String(value).replace(/[-_]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : String(value);
}

/**
 * Tags split by dimension — the longest matching prefix wins, a tag no prefix
 * claims lands in `other` (core `facetsOfTags`).
 */
export function facetsOfTags(tags, dims, tagValues) {
  const byDimension = {};
  const other = [];
  for (const tag of tags || []) {
    let best = null;
    for (const d of dims) if (tag.startsWith(d.prefix) && tag.length > d.prefix.length && (!best || d.prefix.length > best.prefix.length)) best = d;
    if (!best) { other.push(tag); continue; }
    const value = tag.slice(best.prefix.length);
    (byDimension[best.key] = byDimension[best.key] || []).push({ value, word: tagValueWord(best.key, value, tagValues) });
  }
  return { byDimension, other };
}

/** The declared project a name names in one source, from `meta.projects`. */
export function projectDecl(metas, repo, name) {
  const m = metaOf(metas, repo);
  return m && Array.isArray(m.projects) ? m.projects.find((p) => p.name === name) : undefined;
}

/**
 * The project a card stands in: the node's own (`GraphNode.project`); for a
 * workspace package, the project it resolves to; for a file group, its first
 * member's. `{ repo, name, type, tags }` or null.
 */
export function projectOfItem(item, metas) {
  if (!item) return null;
  const repo = repoOfNode(item.members && item.members.length ? item.members[0] : item);
  const own = item.project || (item.members && item.members.length ? (item.members.find((m) => m.project) || {}).project : null);
  if (own && own.name) return { repo, name: own.name, type: own.type, tags: own.tags || [] };
  if (item.kind === 'package' && item.package && item.package.scope === 'workspace' && item.package.project) {
    const d = projectDecl(metas, repo, item.package.project);
    return { repo, name: item.package.project, type: d && d.type, tags: (d && d.tags) || [] };
  }
  return null;
}

/** A project's tags split by its source's dimensions, with the words its config gives. */
export function projectFacets(project, metas) {
  if (!project) return { byDimension: {}, other: [] };
  const m = metaOf(metas, project.repo);
  return facetsOfTags(project.tags || [], dimensionsOf(metas, project.repo), m && m.tagValues);
}

/**
 * What the GROUP control can offer for this graph: *none* always; *project*
 * when any node carries a project; each tag dimension only when some project
 * in view carries a value in it — a dimension the graph does not have is not
 * offered (a choice that would put everything under *no tag* is not a choice).
 * `nodes` are the nodes in scope.
 */
export function groupChoices(nodes, metas) {
  const out = [{ key: 'none' }];
  const projects = new Map();
  for (const n of nodes || []) {
    if (n.kind === 'module') continue;
    const p = projectOfItem(n, metas);
    if (p) projects.set(p.repo + '::' + p.name, p);
  }
  if (!projects.size) return out;
  out.push({ key: 'project' });
  const dims = [];
  for (const p of projects.values()) {
    for (const d of dimensionsOf(metas, p.repo)) {
      const f = projectFacets(p, metas);
      if (!(f.byDimension[d.key] || []).length) continue;
      if (!dims.some((x) => x.key === d.key)) dims.push({ key: d.key, label: d.label });
    }
  }
  // the order the sources list their dimensions in, the defaults first
  const order = (k) => { const i = DEFAULT_DIMENSIONS.findIndex((d) => d.key === k); return i < 0 ? 99 : i; };
  dims.sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key));
  return out.concat(dims);
}

/**
 * The group a card falls in. `by` is `project` or a dimension key. Returns
 * `{ key, word, kind, project? }` where kind is `project`, `value`, `noTag`,
 * `noProject` or `thirdParty`; a third-party package has no project of its own,
 * so it sits in a group of its own rather than under *no project*.
 */
export function groupOf(item, by, metas) {
  const p = projectOfItem(item, metas);
  if (!p) {
    if (item && item.kind === 'package') return { key: THIRD_PARTY, kind: 'thirdParty' };
    return { key: NO_PROJECT, kind: 'noProject' };
  }
  if (by === 'project') return { key: 'p::' + p.repo + '::' + p.name, word: p.name, kind: 'project', project: p };
  const vals = projectFacets(p, metas).byDimension[by] || [];
  if (!vals.length) return { key: NO_TAG, kind: 'noTag' };
  return { key: 'v::' + by + '::' + vals[0].value, word: vals[0].word, value: vals[0].value, kind: 'value' };
}

// ── the index: one pass over the graph, every per-node question answered by a lookup ──
/** A card from a test file (`*.spec.*`, `*.test.*`, or under a tests folder), by the file it lives in. */
export const TEST_FILE = /(?:\.(?:spec|test|e2e|cy)\.[cm]?[jt]sx?$)|(?:^|\/)(?:__tests__|e2e|tests?)\//;
/** True when a node (or a file group, by its first member) lives in a test file. */
export function isTestFileNode(n) {
  if (!n || n.kind === 'package') return false;
  const path = (n.loc && n.loc.path) || n.path || (n.members && n.members[0] && n.members[0].loc && n.members[0].loc.path) || '';
  return TEST_FILE.test(String(path));
}

/**
 * The code map's index of one graph: ONE pass over the nodes and ONE over the
 * edges, so that grouping, filtering and counting the map are lookups and set
 * algebra rather than a fold over every node per node (21k nodes × a 7 ms fold
 * was minutes per draw). Rebuilt only when the page holds a different graph.
 *
 * - `projectKeyOf`  node id → `repo::name` (projectOfItem: a workspace package resolves to its project)
 * - `projects`      `repo::name` → `{ repo, name, type, tags, facets, parts }` — facets computed once per project;
 *                   `parts` counts its non-file nodes (what `groupChoices` folds over)
 * - `partOrder`     project keys in the order their first non-file node appears
 * - `nodesByProject` `repo::name` → Set of node ids
 * - `projectsByValue` dimension → value → Set of project keys
 * - `packageIds`    the package nodes · `importersOf` package id → Set of importer ids (`imports` edges)
 * - `validatesTo`   node id → how many `validates` edges point at it
 * - `testFiles`     node ids that live in a test file · `byRepo` repo → Set of project keys
 */
export function buildCodemapIndex(nodes, edges, metas) {
  const projectKeyOf = new Map();
  const projects = new Map();
  const partOrder = [];
  const nodesByProject = new Map();
  const projectsByValue = new Map();
  const packageIds = new Set();
  const importersOf = new Map();
  const validatesTo = new Map();
  const testFiles = new Set();
  const byRepo = new Map();
  for (const n of nodes || []) {
    if (n.kind === 'package') packageIds.add(n.id);
    else if (isTestFileNode(n)) testFiles.add(n.id);
    const p = projectOfItem(n, metas);
    if (!p) continue;
    const k = p.repo + '::' + p.name;
    projectKeyOf.set(n.id, k);
    let row = projects.get(k);
    if (!row) {
      row = { repo: p.repo, name: p.name, type: p.type, tags: p.tags || [], facets: projectFacets(p, metas), parts: 0 };
      projects.set(k, row);
      nodesByProject.set(k, new Set());
      if (!byRepo.has(p.repo)) byRepo.set(p.repo, new Set());
      byRepo.get(p.repo).add(k);
      for (const [dim, vals] of Object.entries(row.facets.byDimension)) {
        if (!projectsByValue.has(dim)) projectsByValue.set(dim, new Map());
        const m = projectsByValue.get(dim);
        for (const v of vals) { if (!m.has(v.value)) m.set(v.value, new Set()); m.get(v.value).add(k); }
      }
    }
    nodesByProject.get(k).add(n.id);
    if (n.kind !== 'module') { if (!row.parts) partOrder.push(k); row.parts++; }
  }
  for (const e of edges || []) {
    if (e.kind === 'imports' && packageIds.has(e.to)) {
      if (!importersOf.has(e.to)) importersOf.set(e.to, new Set());
      importersOf.get(e.to).add(e.from);
    } else if (e.kind === 'validates') validatesTo.set(e.to, (validatesTo.get(e.to) || 0) + 1);
  }
  return { projectKeyOf, projects, partOrder, nodesByProject, projectsByValue, packageIds, importersOf, validatesTo, testFiles, byRepo, metas };
}

/**
 * The GROUP choices from the index, over the projects of the sources in `repos`
 * (a Set, or null for every source): the same list `groupChoices()` gives for the
 * nodes of those sources, in O(projects).
 */
export function groupChoicesFor(index, repos) {
  const out = [{ key: 'none' }];
  const keys = index.partOrder.filter((k) => !repos || repos.has(index.projects.get(k).repo));
  if (!keys.length) return out;
  out.push({ key: 'project' });
  const dims = [];
  for (const k of keys) {
    const p = index.projects.get(k);
    for (const d of dimensionsOf(index.metas, p.repo)) {
      if (!(p.facets.byDimension[d.key] || []).length) continue;
      if (!dims.some((x) => x.key === d.key)) dims.push({ key: d.key, label: d.label });
    }
  }
  const order = (k) => { const i = DEFAULT_DIMENSIONS.findIndex((d) => d.key === k); return i < 0 ? 99 : i; };
  dims.sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key));
  return out.concat(dims);
}

/** The intersection of two Sets, iterating the smaller. */
function intersect(a, b) {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  const out = new Set();
  for (const x of small) if (big.has(x)) out.add(x);
  return out;
}

/**
 * The node ids a code map filter keeps, or null when nothing narrows — set
 * algebra over the index, never a predicate per node:
 * - the projects that pass: the picked `projects` ∩ (per tag dimension, the union
 *   of the projects carrying a picked value) ∩ the app `closure` (`{ repo, names }`);
 * - the kept nodes: the union of those projects' nodes (a workspace package
 *   stands in its project), plus each package a kept node imports;
 * - `dep` (a package id) intersects with its importers and itself; `nodeIds`
 *   (a Set) intersects too.
 * With no project-shaped narrowing every node passes before `dep` / `nodeIds`.
 */
export function passFor(index, { projects, values, closure, dep, nodeIds } = {}) {
  const picked = projects && projects.size ? projects : null;
  const dims = Object.entries(values || {}).filter(([, set]) => set && set.size);
  const projectish = !!(closure || picked || dims.length);
  if (!projectish && !dep && !nodeIds) return null;
  let keep = null;
  if (projectish) {
    let pass = null;
    const narrow = (set) => { pass = pass ? intersect(pass, set) : set; };
    if (closure) {
      const set = new Set();
      for (const name of closure.names || []) { const k = closure.repo + '::' + name; if (index.projects.has(k)) set.add(k); }
      narrow(set);
    }
    if (picked) narrow(new Set([...picked].filter((k) => index.projects.has(k))));
    for (const [dim, vals] of dims) {
      const m = index.projectsByValue.get(dim);
      const set = new Set();
      if (m) for (const v of vals) for (const k of m.get(v) || []) set.add(k);
      narrow(set);
    }
    keep = new Set();
    for (const k of pass) for (const id of index.nodesByProject.get(k) || []) keep.add(id);
    // a package a kept part imports stays: packages × their importers, never every edge
    for (const pkg of index.packageIds) {
      if (keep.has(pkg)) continue;
      for (const id of index.importersOf.get(pkg) || []) if (keep.has(id)) { keep.add(pkg); break; }
    }
  }
  if (dep) {
    const d = new Set(index.importersOf.get(dep) || []);
    d.add(dep);
    keep = keep ? intersect(keep, d) : d;
  }
  if (nodeIds) keep = keep ? intersect(keep, nodeIds) : new Set(nodeIds);
  return keep;
}

/**
 * The group a card falls in, from the index — the same `{ key, word, kind,
 * project?, value? }` as `groupOf`, in O(1): the node's project key (a file
 * group's first member with a project), then its facets as the index holds them.
 */
export function groupKeyOf(item, by, index) {
  let k = item ? index.projectKeyOf.get(item.id) : undefined;
  if (!k && item && item.members && item.members.length) {
    const m = item.members.find((x) => x.project) || null;
    if (m) k = index.projectKeyOf.get(m.id);
  }
  const p = k && index.projects.get(k);
  if (!p) {
    if (item && item.kind === 'package') return { key: THIRD_PARTY, kind: 'thirdParty' };
    return { key: NO_PROJECT, kind: 'noProject' };
  }
  const project = { repo: p.repo, name: p.name, type: p.type, tags: p.tags };
  if (by === 'project') return { key: 'p::' + k, word: p.name, kind: 'project', project };
  const vals = p.facets.byDimension[by] || [];
  if (!vals.length) return { key: NO_TAG, kind: 'noTag' };
  return { key: 'v::' + by + '::' + vals[0].value, word: vals[0].word, value: vals[0].value, kind: 'value' };
}

/** True when the argument is an index from `buildCodemapIndex` (not a graph's `meta.projects`). */
function isIndex(x) { return !!(x && x.projectKeyOf instanceof Map); }

/**
 * An application's closure from the graph the page holds: the project first,
 * then each project it depends on nearest-first, deduplicated — the same reading
 * as core `appClosure` (project → project imports, `implicitDependencies` and the
 * dependencies NX's own project graph records, sorted by from then to). `{ projects: [name], dependencies: [{ repo, from, to,
 * imports, implicit? }] }`; empty when the source declares no such project.
 */
export function projectClosure(metas, repo, name) {
  const m = metaOf(metas, repo);
  const list = m && Array.isArray(m.projects) ? m.projects : [];
  const names = new Set(list.map((p) => p.name));
  if (!names.has(name)) return { projects: [], dependencies: [] };
  const deps = new Map();
  const dep = (from, to) => {
    const k = from + '\u0000' + to;
    if (!deps.has(k)) deps.set(k, { repo, from, to, imports: 0 });
    return deps.get(k);
  };
  for (const i of m.imports || []) {
    if (!names.has(i.from) || !names.has(i.to) || i.from === i.to) continue;
    dep(i.from, i.to).imports += i.imports || 0;
  }
  for (const p of list) for (const to of p.implicitDependencies || []) {
    if (to === p.name || !names.has(to)) continue;
    dep(p.name, to).implicit = true;
  }
  // NX's own project graph, when the workspace wrote one: it augments, never takes an import count away
  for (const x of m.dependencies || []) {
    if (!names.has(x.from) || !names.has(x.to) || x.from === x.to) continue;
    const d = dep(x.from, x.to);
    d.nx = true;
    if (!d.nxType) d.nxType = x.type;
  }
  const all = [...deps.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const order = [name];
  const seen = new Set(order);
  for (let i = 0; i < order.length; i++) for (const d of all) if (d.from === order[i] && !seen.has(d.to)) { seen.add(d.to); order.push(d.to); }
  return { projects: order, dependencies: all.filter((d) => seen.has(d.from) && seen.has(d.to)) };
}

const KIND_RANK = { page: 0, component: 1, api: 2, route: 3, function: 4, rule: 5, group: 4, table: 6, queue: 7, external: 8, unknown: 9, module: 10, package: 11 };
const TAIL = { noTag: 1, noProject: 2, thirdParty: 3 };

/**
 * Cards folded into groups: each group with its members (in kind order, then
 * name), the count of each kind among them, and — for a project group — the
 * project. Groups are sorted by word, the three catch-alls last. The third
 * argument is the graph's `meta.projects`, or (on the page) the index from
 * `buildCodemapIndex`, which makes each card's group a lookup.
 */
export function foldGroups(items, by, metas) {
  const groups = new Map();
  // given the index, each card's group is a lookup; given `meta.projects`, a fold per card (small graphs, tests)
  const at = isIndex(metas) ? (it) => groupKeyOf(it, by, metas) : (it) => groupOf(it, by, metas);
  for (const it of items || []) {
    const g = at(it);
    let row = groups.get(g.key);
    if (!row) groups.set(g.key, (row = { ...g, members: [], byKind: {} }));
    row.members.push(it);
    // a folded group counts each part it folds under that part's own kind (round 2: a file's functions were all
    // counted under the file's lane, so a component file's twenty functions read as twenty components)
    if (it.kind === 'group') for (const m of it.members || []) { const k = m.kind || it.laneKind || 'function'; row.byKind[k] = (row.byKind[k] || 0) + 1; }
    else row.byKind[it.kind] = (row.byKind[it.kind] || 0) + 1;
  }
  const name = (n) => String((n && (n.name || n.codename)) || '');
  const list = [...groups.values()];
  for (const g of list) {
    g.members.sort((a, b) => ((KIND_RANK[a.kind === 'group' ? a.laneKind : a.kind] ?? 9) - (KIND_RANK[b.kind === 'group' ? b.laneKind : b.kind] ?? 9)) || name(a).localeCompare(name(b)));
    g.parts = Object.values(g.byKind).reduce((s, n) => s + n, 0);
  }
  list.sort((a, b) => (TAIL[a.kind] || 0) - (TAIL[b.kind] || 0) || String(a.word || '').localeCompare(String(b.word || '')) || a.key.localeCompare(b.key));
  return list;
}

/**
 * The cards a *depends on <package>* filter keeps: every node with an
 * `imports` edge into the package (a file's import, or a function's use of an
 * imported name), and the package itself.
 */
export function dependsOnIds(edges, packageId) {
  const out = new Set([packageId]);
  for (const e of edges || []) if (e.kind === 'imports' && e.to === packageId) out.add(e.from);
  return out;
}

/**
 * The column each project of an application's closure is drawn in: the
 * application first, then each project one column right of the furthest
 * project that depends on it — so every dependency arrow points right. A cycle
 * cannot push a project past the closure's size.
 */
export function closureColumns(projects, dependencies) {
  const names = Array.isArray(projects) ? projects : [];
  const col = new Map(names.map((n, i) => [n, i === 0 ? 0 : 1]));
  const deps = (dependencies || []).filter((d) => col.has(d.from) && col.has(d.to) && d.from !== d.to && d.to !== names[0]);
  for (let pass = 0; pass < names.length; pass++) {
    let moved = false;
    for (const d of deps) {
      const want = Math.min(col.get(d.from) + 1, names.length - 1);
      if (want > col.get(d.to)) { col.set(d.to, want); moved = true; }
    }
    if (!moved) break;
  }
  return col;
}

/**
 * The version a group's projects declare for a package: the declaration whose
 * project is the group's, else the one nearest the source root. `versions` are
 * `/api/deps` rows' `versions` (`{ where, range, declaredIn }`).
 */
export function versionFor(versions, groupKey) {
  const list = Array.isArray(versions) ? versions : [];
  if (!list.length) return null;
  const own = list.find((v) => v.where === groupKey);
  if (own) return own;
  return list.slice().sort((a, b) => String(a.declaredIn).split('/').length - String(b.declaredIn).split('/').length || String(a.declaredIn).localeCompare(String(b.declaredIn)))[0];
}

/**
 * The domain a journey is banded under on the Map: its flow node's project's
 * value in the `domain` dimension; else the most common domain among the pages
 * its screens are (a tie goes to the word first in order); else none.
 * `district` is a neighbourhood row (`{ id, repo, screens: [screen ids] }`),
 * `nodes` the graph's nodes. Returns `{ key, word }` — key `''` for no domain.
 */
export function journeyDomain(district, nodes, metas, dim = 'domain') {
  const byId = new Map((nodes || []).map((n) => [n.id, n]));
  const flow = byId.get(district && district.id);
  const valueOf = (n) => {
    const p = projectOfItem(n, metas);
    if (!p) return null;
    const v = (projectFacets(p, metas).byDimension[dim] || [])[0];
    return v || null;
  };
  const own = flow && valueOf(flow);
  if (own) return { key: own.value, word: own.word };
  const screens = new Set((district && district.screens) || []);
  const repo = district && district.repo;
  const tally = new Map();
  for (const n of nodes || []) {
    if (n.kind !== 'page' || !n.design || !screens.has(n.design.id)) continue;
    if (repo && repoOfNode(n) !== repo) continue;
    const v = valueOf(n);
    if (!v) continue;
    const t = tally.get(v.value) || { key: v.value, word: v.word, n: 0 };
    t.n++;
    tally.set(v.value, t);
  }
  const best = [...tally.values()].sort((a, b) => b.n - a.n || a.word.localeCompare(b.word))[0];
  return best ? { key: best.key, word: best.word } : { key: '', word: '' };
}

/** True when the Map can band by domain: some source names a domain dimension and some journey has a domain. */
export function canBandByDomain(districts, nodes, metas) {
  const has = Object.keys(metas || {}).some((r) => dimensionsOf(metas, r).some((d) => d.key === 'domain'));
  if (!has) return false;
  return (districts || []).some((d) => journeyDomain(d, nodes, metas).key);
}
