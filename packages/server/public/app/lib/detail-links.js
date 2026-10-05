// lib/detail-links.js — every detail is a door (round 2026-10-05 §3.2).
//
// A detail that names something in the graph is a link to where that thing is
// best read: a gate to its code in the editor, a call to its contract on APIs,
// a record to its schema, a test to its cases, a work chip to its item and its
// tracker, a screen to its page and its design, a package to where it is
// included. The journey's marker expansions and the Map's property tabs, explore
// card and street draw the same doors because they ask this one builder.
//
// Pure: no DOM, no catalog, no imports. `word` is a catalog key the surface
// translates; `code: true` marks a door into code (the editor, the code map, a
// spec file), which the business register does not draw — the builder leaves
// those out itself when `ctx.lens` is `business`. A door the graph cannot name
// (no `loc`, no root, no spec, no tracker URL) is not returned, so the surface's
// absence word stays where it was. Every lookup is by id (`ctx.byId`) or
// through the per-node edge index (`ctx.edgesOf`, store.js `S.EDGES_OF`) —
// never a scan of the graph's edges per detail.

/**
 * @typedef {{ word: string, href: string, external?: boolean, code?: boolean, editor?: boolean }} Door
 * @typedef {{
 *   byId?: Record<string, any>,
 *   roots?: Record<string, string>,
 *   edgesOf?: Map<string, any[]> | Record<string, any[]>,
 *   flow?: string | null,
 *   lens?: string,
 *   handler?: { nodeId?: string, path?: string, line?: number, repo?: string } | null,
 * }} DoorCtx
 */

/** The kinds a caller may name, folded onto the rows of the door table. */
const KIND = {
  gate: 'gate', guard: 'gate', rule: 'gate',
  call: 'call', route: 'call',
  record: 'data', table: 'data', message: 'data', queue: 'data', external: 'data',
  test: 'test',
  work: 'work',
  screen: 'screen', page: 'screen', component: 'screen',
  package: 'package',
};

/** The repo a node belongs to: its location's, else the first part of its id. */
function repoOf(n) {
  return (n && n.loc && n.loc.repo) || (n && n.repo) || String((n && n.id) || '').split('::')[0];
}

/** A `vscode://file` address for a file and line, or null when the source's root is not known. */
export function editorHref(roots, repo, path, line) {
  const root = roots && repo ? roots[repo] : null;
  if (!root || !path || /^https?:/.test(path)) return null;
  return 'vscode://file/' + root + '/' + path + (line ? ':' + line : '');
}

function edgesOf(ctx, id) {
  const e = ctx && ctx.edgesOf;
  if (!e || !id) return [];
  return (typeof e.get === 'function' ? e.get(id) : e[id]) || [];
}

function codemap(id) { return '#/codemap?node=' + encodeURIComponent(id); }

/** The function a route hands its request to: the marker's own word for it, else the route's first `calls` edge. */
function handlerOf(route, ctx) {
  const h = ctx && ctx.handler;
  if (h && (h.path || h.nodeId)) {
    const hn = h.nodeId && ctx.byId ? ctx.byId[h.nodeId] : null;
    if (hn && hn.loc) return { repo: repoOf(hn), path: hn.loc.path, line: hn.loc.line };
    if (h.path) return { repo: h.repo || repoOf(route), path: h.path, line: h.line };
  }
  const by = (ctx && ctx.byId) || {};
  for (const e of edgesOf(ctx, route.id)) {
    if (e.kind !== 'calls' || e.from !== route.id) continue;
    const fn = by[e.to];
    if (fn && fn.loc) return { repo: repoOf(fn), path: fn.loc.path, line: fn.loc.line };
  }
  return null;
}

/** A link a person wrote on the node (`@see`, a tracker's item URL), the first that is a web address. */
function webLink(n) {
  const l = ((n && n.links) || []).find((x) => x && x.url && /^https?:\/\//.test(x.url));
  return l ? l.url : null;
}

/**
 * The doors of one detail, in the order a surface draws them — the first is the
 * one Enter opens; the editor door (if any) is the one `o` opens.
 *
 * @param {string} kind  gate · guard · rule · call · route · record · table · message · queue · external · test · work · screen · page · component · package (anything else: the node's code and its place on the code map)
 * @param {any} node     the graph node the detail names (a stub with an `id` is enough for some doors)
 * @param {DoorCtx} [ctx]
 * @returns {Door[]}
 */
export function detailLinks(kind, node, ctx = {}) {
  if (!node || !node.id) return [];
  const out = [];
  const add = (word, href, extra) => { if (href) out.push({ word, href, ...(extra || {}) }); };
  const roots = ctx.roots || {};
  const loc = node.loc;
  const atLoc = loc ? editorHref(roots, repoOf(node), loc.path, loc.line) : null;
  const inGraph = !!(ctx.byId && ctx.byId[node.id]);
  const row = KIND[kind] || 'code';

  if (row === 'gate') {
    add('door.editor', atLoc, { code: true, editor: true });
    if (inGraph) add('door.codemap', codemap(node.id), { code: true });
  } else if (row === 'call') {
    const c = node.contract || {};
    if (c.apiId && inGraph) add('door.contract', '#/apis/' + encodeURIComponent(c.apiId) + '?op=' + encodeURIComponent(node.id));
    if (c.apiId && c.spec && c.spec.path && c.spec.line && !/^https?:/.test(c.spec.path)) {
      add('door.spec', '#/apis/' + encodeURIComponent(c.apiId) + '?view=spec&line=' + c.spec.line, { code: true });
    }
    const h = handlerOf(node, ctx);
    add('door.handler', h ? editorHref(roots, h.repo, h.path, h.line) : null, { code: true, editor: true });
    if (inGraph) add('door.codemap', codemap(node.id), { code: true });
  } else if (row === 'data') {
    if (inGraph) add('door.codemap', codemap(node.id), { code: true });
    add('door.schema', atLoc, { code: true, editor: true });
  } else if (row === 'test') {
    if (ctx.flow) add('door.cases', '#/tests?flow=' + encodeURIComponent(ctx.flow));
    add('door.testFile', atLoc, { code: true, editor: true });
  } else if (row === 'work') {
    add('door.work', '#/work/' + encodeURIComponent(node.id));
    add('door.tracker', webLink(node), { external: true });
  } else if (row === 'screen') {
    if (inGraph && node.kind !== 'flow') add('door.page', codemap(node.id), { code: true });
    const d = node.design || {};
    const dn = d.designId && ctx.byId ? ctx.byId[d.designId] : null;
    add('door.design', dn && dn.loc ? editorHref(roots, repoOf(dn), dn.loc.path, dn.loc.line) : null, { code: true, editor: true });
    add('door.figma', d.url && /^https?:\/\/([\w-]+\.)*figma\.com\//.test(d.url) ? d.url : null, { external: true });
  } else if (row === 'package') {
    add('door.included', '#/codemap?view=package&package=' + encodeURIComponent(node.id));
  } else {
    add('door.editor', atLoc, { code: true, editor: true });
    if (inGraph) add('door.codemap', codemap(node.id), { code: true });
  }
  return ctx.lens === 'business' ? out.filter((d) => !d.code) : out;
}

/** The door `o` opens: the first into the editor, else null. @param {Door[]} doors */
export function editorDoor(doors) {
  return (doors || []).find((d) => d.editor) || null;
}
