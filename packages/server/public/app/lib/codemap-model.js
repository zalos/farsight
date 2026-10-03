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

const KIND_RANK = { page: 0, component: 1, api: 2, route: 3, function: 4, rule: 5, group: 4, table: 6, queue: 7, external: 8, unknown: 9, module: 10, package: 11 };
const TAIL = { noTag: 1, noProject: 2, thirdParty: 3 };

/**
 * Cards folded into groups: each group with its members (in kind order, then
 * name), the count of each kind among them, and — for a project group — the
 * project. Groups are sorted by word, the three catch-alls last.
 */
export function foldGroups(items, by, metas) {
  const groups = new Map();
  for (const it of items || []) {
    const g = groupOf(it, by, metas);
    let row = groups.get(g.key);
    if (!row) groups.set(g.key, (row = { ...g, members: [], byKind: {} }));
    row.members.push(it);
    const k = it.kind === 'group' ? (it.laneKind || 'function') : it.kind;
    row.byKind[k] = (row.byKind[k] || 0) + (it.kind === 'group' ? (it.members || []).length : 1);
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
