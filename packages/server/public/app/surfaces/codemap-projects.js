// surfaces/codemap-projects.js — the code map grouped and filtered by project
// and tag, packages drawn, and the two views (docs/proposals/dependencies-and-nx.md §2.3).
//
// One state bag, `S.cmap`: the GROUP choice (none · project · a tag dimension the
// graph has — `?group=`, kept in localStorage), the code map filters (projects,
// tag values, *depends on <package>*), the *hide packages* / *show files* chips,
// and the open view — **App and its related** (`?view=app&project=`) or **Where
// is <package> included** (`?view=package&package=`). graph-render.js asks this
// module two questions — is a node left off the map (`cmapHide`, which the status
// bar's breakdown counts), and is the map grouped (`cmapGrouping`) — and hands
// the grouped drawing to `renderGrouped()`: one box per group, small cards in
// rows, the box's parts as a count with its kinds. Every fact is a fold over the
// graph the page holds (lib/codemap-model.js) or an answer the server folds
// (`/api/projects`, `/api/deps/where`); nothing here is stored twice.

import { S, esc, jsArg, cssId, expose, humanize, inScope, currentLens, bizName } from '../store.js';
import { t } from '../strings.js';
import { sym } from '../sym.js';
import { tipAttrs } from '../lib/tooltip.js';
import { plainTip, countedHtml, countedAttrs, countedText } from '../lib/counted.js';
import { pickerHtml, focusPicker, resetPicker, pickerHasQuery } from '../lib/multi-pick.js';
import { render, select, renderNode, drawEdges, kindWord, NODE_W } from '../lib/graph-render.js';
import {
  foldGroups, projectOfItem, projectFacets, dimensionsOf,
  closureColumns, versionFor, repoOfNode, buildCodemapIndex, groupChoicesFor, passFor, projectClosure,
} from '../lib/codemap-model.js';

const GROUP_KEY = 'fs-cmap-group';
/** The project and tag filters, kept beside the GROUP choice (`{ projects: [key], values: { dim: [value] } }`). */
const FILTER_KEY = 'fs-cmap-filters';
const biz = () => currentLens() === 'business';
const metas = () => (S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.projects) || {};

/**
 * The code map's index of the graph the page holds (lib/codemap-model.js
 * `buildCodemapIndex`): one pass over nodes and edges, rebuilt only when
 * `S.GRAPH` is a different object (a sync reloads it). Every per-node question
 * this module answers — which project, which group, is it filtered, is it a
 * test file — is a lookup in it.
 */
let CMAP_INDEX = { graph: null, index: null };
function idx() {
  if (CMAP_INDEX.graph !== S.GRAPH || !CMAP_INDEX.index) {
    CMAP_INDEX = { graph: S.GRAPH, index: buildCodemapIndex((S.GRAPH && S.GRAPH.nodes) || [], (S.GRAPH && S.GRAPH.edges) || [], metas()) };
  }
  return CMAP_INDEX.index;
}
/** A project's facets as the index holds them (computed once per project), else folded once. */
function facetsOf(p) {
  const row = p && idx().projects.get(p.repo + '::' + p.name);
  return row ? row.facets : projectFacets(p, metas());
}

/** The state bag, made on first use. @group Code map */
export function cmap() {
  if (!S.cmap) {
    let group = 'none';
    try { group = localStorage.getItem(GROUP_KEY) || 'none'; } catch (e) { /* private window: none */ }
    S.cmap = { group, hidePackages: false, showModules: false, projects: new Set(), values: {}, dep: null, view: null, rev: 0, pass: null, passRev: -1, passGraph: null };
    try {
      const f = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null');
      if (f && Array.isArray(f.projects)) S.cmap.projects = new Set(f.projects.map(String));
      if (f && f.values && typeof f.values === 'object') for (const [d, vs] of Object.entries(f.values)) if (Array.isArray(vs) && vs.length) S.cmap.values[d] = new Set(vs.map(String));
    } catch (e) { /* private window or an unreadable value: no filters */ }
  }
  return S.cmap;
}
/** Keep the project and tag filters for the next visit. */
function saveFilters() {
  const c = cmap();
  const values = {};
  for (const [d, set] of Object.entries(c.values)) if (set.size) values[d] = [...set];
  try { localStorage.setItem(FILTER_KEY, JSON.stringify({ projects: [...c.projects], values })); } catch (e) { /* private window: this visit only */ }
}
/** Something the pass depends on moved: the next ask recomputes it. */
function bump() { cmap().rev++; }

// ── what is left off the map ─────────────────────────────────────────────
/** True when a filter or a view narrows the map. */
function narrowing() {
  const c = cmap();
  return !!(c.view || c.dep || c.projects.size || Object.values(c.values).some((v) => v.size));
}
/** The project key a filter ticks: `repo::name`. */
function projKey(p) { return p.repo + '::' + p.name; }

/**
 * The node ids a filter or the open view keeps, or null when nothing narrows the
 * map. Computed once per state change and graph.
 */
function passSet() {
  const c = cmap();
  if (!narrowing()) return null;
  if (c.pass && c.passRev === c.rev && c.passGraph === S.GRAPH) return c.pass;
  const index = idx();
  let keep;
  if (c.view && c.view.kind === 'package') {
    keep = c.view.id ? passFor(index, { dep: c.view.id }) : new Set();
  } else {
    // the app view is its own narrowing: the closure alone (the filters' chips are not shown while a view is open,
    // so a filter kept from before must not quietly empty the application's tree)
    if (c.view && c.view.kind === 'app') keep = passFor(index, { closure: { repo: c.view.repo, names: c.view.closure || new Set() } });
    else keep = passFor(index, { projects: c.projects, values: c.values, dep: c.dep || undefined });
  }
  Object.assign(c, { pass: keep, passRev: c.rev, passGraph: S.GRAPH });
  return keep;
}

/**
 * Why a node is not drawn by the code map's own controls, or null: `files` (a
 * file card, drawn only with *show files* — or in the package view, where the
 * files are the answer), `packages` (*hide packages*), `filtered` (a filter or
 * a view leaves it out). graph-render's `statsBreakdown` counts each reason.
 * @group Code map
 */
export function cmapHide(n) {
  const c = cmap();
  const pkgView = c.view && c.view.kind === 'package';
  if (n.kind === 'module' && !c.showModules && !pkgView) return 'files';
  // grouped, a test file's own cards are not parts of the project's code: like file cards, drawn with *show files* (round 2)
  if (!c.showModules && !pkgView && idx().testFiles.has(n.id) && cmapGrouping() !== 'none') return 'files';
  if (n.kind === 'package' && c.hidePackages && !pkgView) return 'packages';
  const keep = passSet();
  if (keep && !keep.has(n.id)) return 'filtered';
  return null;
}

/** What the map is grouped by: a view groups by project; else the reader's choice, when the graph offers it. @group Code map */
export function cmapGrouping() {
  const c = cmap();
  if (c.view) return 'project';
  if (c.group === 'none' || !S.GRAPH) return 'none';
  return choices().some((x) => x.key === c.group) ? c.group : 'none';
}
/** The GROUP choices this graph offers, over the sources in scope: from the index, cached per graph and scope. */
let CHOICES = { graph: null, scope: '', list: null };
function choices() {
  const scope = JSON.stringify(S.scope);
  if (CHOICES.graph !== S.GRAPH || CHOICES.scope !== scope || !CHOICES.list) {
    const repos = S.scope === 'all' || !S.scope.length ? null : new Set(S.scope);
    CHOICES = { graph: S.GRAPH, scope, list: groupChoicesFor(idx(), repos) };
  }
  return CHOICES.list;
}
/** A dimension's label, as the first source that defines it writes it. */
function dimLabel(key) {
  for (const r of Object.keys(metas())) {
    const d = dimensionsOf(metas(), r).find((x) => x.key === key);
    if (d) return d.label;
  }
  return humanize(key);
}

// ── words ────────────────────────────────────────────────────────────────
/** A project's name as the lens reads it: the name in the hybrid and code lenses, in words in business. */
export function projectWord(name) { return biz() ? humanize(String(name || '').replace(/^@[^/]+\//, '').replace(/\//g, ' ')) : String(name || ''); }
/** A project type in words. */
function typeWord(type) { return type ? t('codemap.ptype.' + type) : ''; }
/** A package's kind in words: third-party, or of this workspace. @group Code map */
export function pkgScopeWord(n) { return t(n && n.package && n.package.scope === 'workspace' ? 'codemap.pkg.workspace' : 'codemap.pkg.thirdParty'); }
/** A group's title in the lens on screen. */
function groupWord(g) {
  if (g.kind === 'noTag') return t('codemap.group.noTag');
  if (g.kind === 'noProject') return t('codemap.group.noProject');
  if (g.kind === 'thirdParty') return t('codemap.group.thirdParty');
  if (g.kind === 'project') return projectWord(g.project.name);
  return g.word;
}
const CATCH_ALL = { noTag: 'codemap.group.noTag', noProject: 'codemap.group.noProject', thirdParty: 'codemap.group.thirdParty' };

// ── the grouped drawing ──────────────────────────────────────────────────
const ROW_H = 54, HEAD_H = 78, PAD = 10, GAP = 26, ROWS_MAX = 10, TOP_Y = 18, COL_GAP = 120;
/** A card's row height in a box: a folded file group carries its members line under its name. */
const GROUP_ROW_H = 108;
/** …and a part with a check or a rule badge carries a row of badges under its name. */
const BADGE_ROW_H = 76;
let BADGED = null;
function badged() {
  if (BADGED && BADGED.graph === S.GRAPH) return BADGED.set;
  const set = new Set(Object.keys(S.guardsByTarget || {}).filter((k) => (S.guardsByTarget[k] || []).length));
  for (const k of idx().validatesTo.keys()) set.add(k);
  BADGED = { graph: S.GRAPH, set };
  return set;
}
/** Measured card heights, by node id, for the lens and graph they were measured in. */
const MEASURED = new Map();
let MEASURED_FOR = '';
function cardH(n) {
  if (!n) return ROW_H;
  const sig = currentLens() + '|' + ((S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.sync) || '');
  if (sig !== MEASURED_FOR) { MEASURED.clear(); MEASURED_FOR = sig; }
  if (MEASURED.has(n.id)) return Math.max(MEASURED.get(n.id), ROW_H);
  if (n.kind === 'group' && !n.expanded) return GROUP_ROW_H;
  return badged().has(n.id) ? BADGE_ROW_H : ROW_H;
}

/**
 * Draw the map as boxes: one per group, each a header (its word, what it is,
 * its parts as a count split by kind) over small cards in columns of at most
 * ten. Grouped by project or a dimension, the boxes wrap in rows across the
 * stage; in *App and its related* they stand in columns from the application
 * rightward, every dependency arrow pointing right and labelled with its
 * import statements; in *Where is <package> included* the package stands on
 * the left and its importers' projects on the right.
 * @group Code map
 */
export function renderGrouped(nodes, memberToGroup, again = false) {
  const stage = document.getElementById('stage');
  const c = cmap();
  const by = cmapGrouping();
  // an opened file group is its members, each a card of its own; a folded one stays one card
  const items = [];
  nodes.forEach((n) => { if (n.kind === 'group' && n.expanded) n.members.forEach((x) => items.push(x)); else items.push(n); });
  // a folded group whose parts live in several projects is drawn once per project, each with its own parts (round 2:
  // a project's box counted another project's functions, so its card read far above the inspector's count)
  for (let i = items.length - 1; i >= 0; i--) {
    const n = items[i];
    if (n.kind !== 'group' || !n.members || n.members.length < 2) continue;
    const parts = new Map();
    for (const m of n.members) {
      const k = m.project ? idx().projectKeyOf.get(m.id) || '' : '';
      if (!parts.has(k)) parts.set(k, []);
      parts.get(k).push(m);
    }
    if (parts.size < 2) continue;
    const anchorMember = n.members.find((m) => m.project);
    const anchorKey = anchorMember ? idx().projectKeyOf.get(anchorMember.id) || '' : '';
    const split = [...parts.entries()].map(([k, ms]) => {
      const g = { ...n, members: ms, id: k === anchorKey ? n.id : n.id + '@' + k };
      if (memberToGroup) for (const m of ms) if (memberToGroup[m.id]) memberToGroup[m.id] = g.id;
      return g;
    });
    items.splice(i, 1, ...split);
  }
  const pkgView = c.view && c.view.kind === 'package';
  const seed = pkgView ? items.find((n) => n.id === c.view.id) : null;
  const groups = foldGroups(items.filter((n) => n !== seed), by, idx());
  S.positions = {};
  const boxes = groups.map((g) => {
    const m = g.members.length;
    const cols = Math.ceil(m / ROWS_MAX) || 1;
    // a folded file group's card is taller than a part's (its members line): each column is as tall as its cards (round 2)
    const colH = [];
    g.members.forEach((n, i) => { const k = Math.floor(i / ROWS_MAX); colH[k] = (colH[k] || 0) + cardH(n); });
    return { g, rows: Math.min(m, ROWS_MAX) || 1, cols, w: PAD + cols * (NODE_W + PAD), h: HEAD_H + (Math.max(ROW_H, ...colH.filter(Boolean)) || ROW_H) + PAD };
  });
  let maxX = 0, maxY = 0;
  const place = (b, x, y) => { b.x = x; b.y = y; maxX = Math.max(maxX, x + b.w); maxY = Math.max(maxY, y + b.h); };
  if (c.view && c.view.kind === 'app' && c.view.data) {
    // columns from the application rightward; the projects outside the closure's order (third-party packages) last
    const colOf = closureColumns(c.view.data.projects, c.view.data.deps);
    const last = Math.max(0, ...colOf.values()) + 1;
    const cols = [];
    for (const b of boxes) {
      const k = b.g.kind === 'project' && colOf.has(b.g.project.name) ? colOf.get(b.g.project.name) : last;
      (cols[k] = cols[k] || []).push(b);
    }
    let x = 20;
    for (const col of cols) {
      if (!col) continue;
      let y = TOP_Y;
      col.sort((a, b) => (c.view.data.projects.indexOf(a.g.project ? a.g.project.name : '') - c.view.data.projects.indexOf(b.g.project ? b.g.project.name : '')));
      for (const b of col) { place(b, x, y); y += b.h + GAP; }
      x += Math.max(...col.map((b) => b.w)) + COL_GAP;
    }
  } else if (pkgView) {
    let x = 20;
    if (seed) { S.positions[seed.id] = { x, y: TOP_Y + HEAD_H }; maxY = TOP_Y + HEAD_H + 100; x += NODE_W + COL_GAP; }
    let y = TOP_Y;
    for (const b of boxes) { place(b, x, y); y += b.h + GAP; }
  } else {
    // packed into columns as wide as the stage (never narrower than four): each box, in order,
    // goes where the columns it spans end highest, so a short box fills the gap beside a tall one
    const wrapEl = stage.parentElement;
    const unit = NODE_W + PAD * 2 + GAP;
    const lanes = Math.max(4, Math.floor(((wrapEl ? wrapEl.clientWidth : 1200) - 40 + GAP) / unit));
    const bottom = new Array(Math.max(lanes, ...boxes.map((b) => b.cols))).fill(TOP_Y);
    for (const b of boxes) {
      let best = 0, bestY = Infinity;
      // a box wider than the stage starts at the left edge; every other one stays inside the stage's columns
      const limit = b.cols <= lanes ? lanes : b.cols;
      for (let l = 0; l + b.cols <= limit; l++) {
        const y = Math.max(...bottom.slice(l, l + b.cols));
        if (y < bestY) { best = l; bestY = y; }
      }
      place(b, 20 + best * unit, bestY);
      for (let l = best; l < best + b.cols; l++) bottom[l] = bestY + b.h + GAP;
    }
  }
  // the members' cards, column by column inside their box
  for (const b of boxes) {
    let y = 0;
    b.g.members.forEach((n, i) => {
      const col = Math.floor(i / ROWS_MAX);
      if (i % ROWS_MAX === 0) y = 0;
      S.positions[n.id] = { x: b.x + PAD + col * (NODE_W + PAD), y: b.y + HEAD_H + y, w: NODE_W };
      y += cardH(n);
    });
  }
  stage.style.width = (maxX + 60) + 'px';
  stage.style.height = (maxY + 60) + 'px';
  const svg = document.getElementById('edgesvg');
  svg.setAttribute('width', maxX + 60); svg.setAttribute('height', maxY + 60);
  stage.querySelectorAll('.cm-elabel').forEach((e) => e.remove());
  for (const b of boxes) stage.appendChild(boxEl(b));
  for (const b of boxes) b.g.members.forEach((n) => renderNode(n, true, 'cm-m'));
  // a card's height follows its words (a long name wraps, a badge row): measured once drawn, and when any card is
  // taller than the row it was given the boxes are laid out again with the measured heights (round 2: cards overlapped)
  let taller = false;
  for (const b of boxes) for (const n of b.g.members) {
    const el = document.getElementById('nd-' + cssId(n.id));
    if (!el) continue;
    const h = el.offsetHeight + 6;
    if (h > cardH(n)) taller = true;
    MEASURED.set(n.id, h);
  }
  if (taller && !again) {
    stage.querySelectorAll('.node,.lanehead,.groupbox').forEach((e) => e.remove());
    renderGrouped(nodes, memberToGroup, true);
    return;
  }
  if (seed) renderNode(seed, false);
  drawEdges(memberToGroup);
  if (c.view && c.view.kind === 'app' && c.view.data) drawProjectArrows(boxes);
}

/** One group's box: its header and its count; the members are cards drawn over it. */
function boxEl(b) {
  const g = b.g;
  const box = document.createElement('div');
  box.className = 'groupbox cm-box cm-' + g.kind + (cmap().view && cmap().view.kind === 'app' && g.project && g.project.name === cmap().view.project ? ' cm-root' : '');
  box.id = 'cmbox-' + cssId(g.key);
  box.style.left = b.x + 'px'; box.style.top = b.y + 'px'; box.style.width = b.w + 'px'; box.style.height = b.h + 'px';
  box.dataset.group = g.key;
  const sub = [];
  if (g.kind === 'project') {
    if (g.project.type) sub.push(typeWord(g.project.type));
    const f = facetsOf(g.project);
    for (const d of dimensionsOf(metas(), g.project.repo)) for (const v of f.byDimension[d.key] || []) if (d.key !== 'type' || !g.project.type || v.word.toLowerCase() !== typeWord(g.project.type).toLowerCase()) sub.push(v.word);
    if (Object.keys(metas()).length > 1 && !biz()) sub.push(g.project.repo);
  } else if (g.kind === 'value') sub.push(dimLabel(cmapGrouping()));
  const pv = cmap().view && cmap().view.kind === 'package' && cmap().view.data ? versionFor(cmap().view.data.package.versions, g.project ? g.project.name : '') : null;
  if (pv && !biz()) sub.push(pv.range);
  const rows = Object.entries(g.byKind).sort((a, b2) => b2[1] - a[1]).map(([k, n]) => [kindWord(k), n]);
  const inspectable = g.kind === 'project' || g.kind === 'value';
  const tip = CATCH_ALL[g.kind] ? tipAttrs({ key: CATCH_ALL[g.kind], noFocus: true }) : tipAttrs({ key: 'codemap.group.inspect', noFocus: true });
  box.innerHTML = '<div class="ghead cm-ghead' + (inspectable ? ' cm-click' : '') + '"' + tip + '>'
    + (g.kind === 'thirdParty' ? sym('package') : '')
    + '<span class="gname">' + esc(groupWord(g)) + '</span></div><div class="cm-gsub">' + esc(sub.join(' · ')) + '</div>'
    + '<div class="cm-gchips"><span class="cm-chip"' + plainTip(g.parts, 'codemap.group.parts', 'codemap.group.scope', '/graph', rows) + '>'
    + esc(t(g.parts === 1 ? 'codemap.group.partsOne' : 'codemap.group.parts').replace('{n}', g.parts)) + '</span></div>';
  if (inspectable) box.querySelector('.ghead').onclick = () => (g.kind === 'project' ? inspectProject(g.project.repo, g.project.name) : inspectValue(g));
  return box;
}

/** The project → project arrows of the app view, each labelled with its import statements (a `Counted` with its tip). */
function drawProjectArrows(boxes) {
  const c = cmap();
  const svg = document.getElementById('edgesvg'), stage = document.getElementById('stage');
  const at = new Map(boxes.filter((b) => b.g.kind === 'project').map((b) => [b.g.project.name, b]));
  const api = '/api/projects?repo=' + encodeURIComponent(c.view.repo);
  (c.view.data.deps || []).forEach((d, i) => {
    const A = at.get(d.from), B = at.get(d.to);
    if (!A || !B || A === B) return;
    const x1 = A.x + A.w, y1 = A.y + 22 + (i % 3) * 8, x2 = B.x, y2 = B.y + 22;
    const back = x2 <= x1;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const mx = (x1 + x2) / 2;
    path.setAttribute('d', back
      ? 'M' + x1 + ',' + y1 + ' C' + (x1 + 80) + ',' + (y1 - 60) + ' ' + (x2 - 80) + ',' + (y2 - 60) + ' ' + x2 + ',' + y2
      : 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2);
    path.setAttribute('class', 'edge cm-pedge' + (d.imports ? '' : ' declared'));
    svg.appendChild(path);
    // drawn from the page's graph first: the import-statement count is a `Counted` the server folds, labelled when it answers
    if (d.imports && !d.count) return;
    const lbl = document.createElement('div');
    lbl.className = 'cm-elabel' + (d.imports ? '' : ' declared');
    lbl.style.left = (back ? mx : mx) + 'px'; lbl.style.top = ((y1 + y2) / 2 - (back ? 50 : 0)) + 'px';
    lbl.innerHTML = d.imports
      ? '<span' + countedAttrs(d.count, api) + '>' + esc(countedText(d.count, 'hybrid')) + '</span>'
      : '<span' + tipAttrs({ key: 'codemap.view.declared', noFocus: true }) + '>' + esc(t('codemap.view.declared')) + '</span>';
    stage.appendChild(lbl);
  });
}

// ── the controls: GROUP, the two chips, the views, the view's bar ─────────
/**
 * The code map's own controls in the toolbar (shown on the code map only): the
 * GROUP choice with the dimensions this graph has, *hide packages* and *show
 * files* where the graph has packages and files, the Views menu, a *filtered*
 * chip that drops the filters, and the open view's name with the way back.
 * @group Code map
 */
export function buildCmapControls() {
  const el = document.getElementById('cmapctl');
  if (!el || !S.GRAPH) return;
  const c = cmap();
  const ch = choices();
  const by = cmapGrouping();
  // one casing for every choice: the catalog's words are lower case, and so are the dimensions' labels here (round 2)
  const word = (x) => (x.key === 'none' ? t('codemap.group.none') : x.key === 'project' ? t('codemap.group.project') : String(x.label || '').toLowerCase());
  const inScopeNodes = S.GRAPH.nodes.filter((n) => inScope(n));
  const hasPkgs = inScopeNodes.some((n) => n.kind === 'package');
  const hasFiles = inScopeNodes.some((n) => n.kind === 'module');
  let html = '';
  if (ch.length > 1) {
    html += '<label class="cm-lbl hud-label" for="cm-group"' + tipAttrs({ key: 'codemap.group.label', noFocus: true }) + '>' + esc(t('codemap.group.label')) + '</label>'
      + '<select id="cm-group" class="cm-select" onchange="cmapSetGroup(this.value)"' + (c.view ? ' disabled' : '') + '>'
      + ch.map((x) => '<option value="' + esc(x.key) + '"' + (x.key === by ? ' selected' : '') + '>' + esc(word(x)) + '</option>').join('') + '</select>';
  }
  if (hasPkgs) html += '<button class="chip' + (c.hidePackages ? ' on' : '') + '" id="cm-hidepkg" onclick="cmapTogglePackages()"' + tipAttrs({ key: 'codemap.pkg.hide', noFocus: true }) + '>' + esc(t('codemap.pkg.hide')) + '</button>';
  if (hasFiles) html += '<button class="chip' + (c.showModules ? ' on' : '') + '" id="cm-files" onclick="cmapToggleFiles()"' + tipAttrs({ key: 'codemap.pkg.files', noFocus: true }) + '>' + esc(t('codemap.pkg.files')) + '</button>';
  // the project picker and an application's tree, one chip away (not only inside the scope menu and Views)
  if (appProjects().length > 1) {
    const n = c.projects.size;
    html += '<div class="cm-views cm-projbar"><button class="chip' + (n ? ' on' : '') + '" id="cm-projbtn" onclick="cmapProjMenu(event)" aria-haspopup="true" aria-expanded="' + (c.projMenu ? 'true' : 'false') + '"'
      + tipAttrs({ key: 'codemap.bar.projects', noFocus: true }) + '>' + esc(n ? t('codemap.bar.projectsN').replace('{n}', String(n)) : t('codemap.bar.projects')) + ' ▾</button>'
      + '<div class="cm-menu cm-projmenu" id="cm-projmenu" role="group" aria-label="' + esc(t('codemap.bar.projects')) + '" onclick="event.stopPropagation()"></div></div>';
  }
  html += '<div class="cm-views"><button class="chip" id="cm-viewsbtn" onclick="cmapViewsMenu(event)" aria-haspopup="true" aria-expanded="false"' + tipAttrs({ key: 'codemap.view.menu', noFocus: true }) + '>' + esc(t('codemap.view.menu')) + ' ▾</button>'
    + '<div class="cm-menu" id="cm-viewsmenu" role="group" aria-label="' + esc(t('codemap.view.menu')) + '" onclick="event.stopPropagation()"></div></div>';
  if (narrowing() && !c.view) html += '<button class="chip on" id="cm-filtered" onclick="cmapClearFilters()"' + tipAttrs({ key: 'codemap.filter.active', noFocus: true }) + '>' + esc(t('codemap.filter.active')) + ' ✕</button>'
    + filterChipsHtml();
  if (c.view) {
    const name = c.view.kind === 'app' ? projectWord(c.view.project) : (c.view.id && S.BYID[c.view.id] ? (biz() ? bizName(S.BYID[c.view.id]) : S.BYID[c.view.id].name) : c.view.ref);
    const key = c.view.kind === 'app' ? 'codemap.view.appOf' : 'codemap.view.packageOf';
    const state = c.view.failed ? ' · ' + t('codemap.view.failed') : c.view.loading ? ' · ' + t('codemap.view.loading') : '';
    html += '<button class="chip on cm-viewchip" id="cm-viewchip" onclick="cmapCloseView()"' + tipAttrs({ key, noFocus: true }) + '>' + esc(t(key).replace('{name}', name) + state) + ' ✕</button>';
  }
  el.innerHTML = html;
  // a pick in the Projects menu redraws the toolbar: the menu stays open, its pickers keep their words (lib/multi-pick.js)
  if (c.projMenu) fillProjMenu();
}

// ── the toolbar's Projects menu ──────────────────────────────────────────
/**
 * Open or close the Projects menu: type chips that narrow which kinds of
 * project the list shows, the multi-select project picker (the scope menu's
 * Projects, the same filter), and *Focus on an application* — one pick draws
 * the application and every project it depends on.
 */
function cmapProjMenu(ev) {
  if (ev) ev.stopPropagation();
  const c = cmap();
  if (c.projMenu) { closeProjMenu(); return; }
  closeViewsMenu();
  c.projMenu = true;
  fillProjMenu();
  focusPicker('cm-pick-proj-bar');
  document.removeEventListener('click', projMenuOutside);
  setTimeout(() => document.addEventListener('click', projMenuOutside), 0);
  window.addEventListener('keydown', projMenuKey, true);
}
/** A click outside the menu closes it (a click on a picker the menu just redrew is still inside). */
function projMenuOutside(e) {
  const menu = document.getElementById('cm-projmenu');
  if (!e.target.isConnected || (menu && menu.contains(e.target))) return;
  closeProjMenu();
}
/**
 * Esc closes the open menu wherever focus is — on the window in the capture
 * phase, ahead of the keymap (as the scope menu's Esc does), so nothing else
 * unwinds on an Esc meant for the menu. A picker with words typed clears them first.
 */
function projMenuKey(e) {
  if (e.key !== 'Escape' || !cmap().projMenu || pickerHasQuery(e)) return;
  e.preventDefault(); e.stopImmediatePropagation();
  closeProjMenu(true);
}
function closeProjMenu(refocus) {
  const c = cmap();
  c.projMenu = false;
  document.removeEventListener('click', projMenuOutside);
  window.removeEventListener('keydown', projMenuKey, true);
  const menu = document.getElementById('cm-projmenu');
  if (menu) menu.classList.remove('open');
  const btn = document.getElementById('cm-projbtn');
  if (btn) { btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus({ preventScroll: true }); }
  resetPicker('cm-pick-proj-bar'); resetPicker('cm-pick-app-bar');
}
/** The project types a reader can narrow the list to, in the pickers' order, each only when some project has it. */
function barTypes() {
  const have = new Set(projectOptions().map((o) => o.group));
  return PROJECT_GROUPS().filter((g) => have.has(g.key));
}
/** Draw the menu's body into the open menu. */
function fillProjMenu() {
  const menu = document.getElementById('cm-projmenu');
  if (!menu) return;
  const c = cmap();
  const types = c.barTypes || (c.barTypes = new Set());
  const all = projectOptions();
  const options = types.size ? all.filter((o) => types.has(o.group)) : all;
  const groups = PROJECT_GROUPS().filter((g) => !types.size || types.has(g.key));
  const onClose = () => closeProjMenu(true);
  const kinds = barTypes();
  menu.innerHTML = (kinds.length > 1 ? '<div class="cm-types" role="group" aria-label="' + esc(t('codemap.bar.types')) + '">'
      + '<span class="cm-sublbl hud-label"' + tipAttrs({ key: 'codemap.bar.types', noFocus: true }) + '>' + esc(t('codemap.bar.types')) + '</span>'
      + kinds.map((g) => '<button type="button" class="chip cm-type' + (types.has(g.key) ? ' on' : '') + '" data-type="' + esc(g.key) + '" aria-pressed="' + (types.has(g.key) ? 'true' : 'false') + '"'
        + ' onclick="cmapBarType(' + jsArg(g.key) + ')"' + tipAttrs({ key: 'codemap.pick.group.' + g.key, noFocus: true }) + '>' + esc(g.word) + '</button>').join('') + '</div>' : '')
    + '<div class="cm-pickrow">' + pickerHtml('cm-pick-proj-bar', {
      multi: true, label: t('codemap.pick.projects'), placeholder: t('codemap.pick.findProject'), countKey: 'codemap.pick.countProjects',
      options, groups, selected: c.projects,
      // the toolbar redraws under the menu: the field keeps the keyboard
      onChange: (ids) => { cmap().projects = new Set(ids); filtered(); focusPicker('cm-pick-proj-bar'); },
      onClose,
    }) + '</div>'
    + '<div class="cm-mhead hud-label"' + tipAttrs({ key: 'codemap.bar.focus', noFocus: true }) + '>' + esc(t('codemap.bar.focus')) + '</div>'
    + '<div class="cm-pickrow">' + pickerHtml('cm-pick-app-bar', {
      multi: false, label: t('codemap.bar.focus'), placeholder: t('codemap.pick.findProject'), countKey: 'codemap.pick.countProjects',
      options: all, groups: PROJECT_GROUPS(), selected: c.view && c.view.kind === 'app' ? [c.view.repo + '::' + c.view.project] : [],
      onChange: (ids) => { const k = ids[0]; if (!k) return; closeProjMenu(); const i = k.indexOf('::'); cmapOpenApp(k.slice(i + 2), k.slice(0, i)); },
      onClose,
    }) + '</div>';
  menu.classList.add('open');
  const btn = document.getElementById('cm-projbtn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
}
/** A type chip: narrow the list to that kind of project, or widen it again (none on = every kind). */
function cmapBarType(key) {
  const c = cmap();
  const s = c.barTypes || (c.barTypes = new Set());
  s.has(key) ? s.delete(key) : s.add(key);
  fillProjMenu();
}

/** Toolbar chips in the toolbar before the rest fold into `+n filters`. */
const BAR_CHIPS = 3;
/**
 * The project and tag filters as chips beside *filtered*, each one dropping that
 * filter; past three, `+n filters` opens the scope menu where all of them are.
 */
function filterChipsHtml() {
  const c = cmap();
  const byKey = new Map(allProjects().map((p) => [projKey(p), p]));
  const chips = [...c.projects].map((k) => ({ word: projectWord(byKey.has(k) ? byKey.get(k).name : k.split('::').pop()), act: 'cmapDropFilter(' + jsArg('p') + ',' + jsArg(k) + ')', id: 'p:' + k }));
  for (const [d, set] of Object.entries(c.values)) {
    for (const v of set) {
      const p = allProjects().find((x) => (facetsOf(x).byDimension[d] || []).some((f) => f.value === v));
      const w = p ? (facetsOf(p).byDimension[d] || []).find((f) => f.value === v).word : v;
      chips.push({ word: w, act: 'cmapDropFilter(' + jsArg(d) + ',' + jsArg(v) + ')', id: d + ':' + v });
    }
  }
  const tip = tipAttrs({ key: 'codemap.pick.dropFilter', noFocus: true });
  return chips.slice(0, BAR_CHIPS).map((x) => '<button class="chip cm-fchip" data-filter="' + esc(x.id) + '" onclick="' + x.act + '"' + tip
    + ' aria-label="' + esc(t('codemap.pick.remove').replace('{name}', x.word)) + '">' + esc(x.word) + ' ✕</button>').join('')
    + (chips.length > BAR_CHIPS ? '<button class="chip cm-fchip cm-fmore" onclick="toggleScopeMenu(event)"' + tipAttrs({ key: 'codemap.pick.moreFilters', noFocus: true }) + '>'
      + esc(t('codemap.pick.moreFilters').replace('{n}', String(chips.length - BAR_CHIPS))) + '</button>' : '');
}
/** Drop one filter from its toolbar chip: a project (`p`, its key) or a tag value (its dimension, the value). */
function cmapDropFilter(dim, v) {
  const c = cmap();
  if (dim === 'p') c.projects.delete(v);
  else if (c.values[dim]) c.values[dim].delete(v);
  filtered();
}

/**
 * The projects of the sources in scope as fast-travel results (⌘K): not graph
 * nodes, so each is a small record of its own — kind `project`, the project's
 * name, its words, its type and tags to match on, and where Enter goes.
 * @group Code map
 */
export function projectTravelItems() {
  if (!S.GRAPH) return [];
  const multi = Object.keys(metas()).length > 1;
  return appProjects().map((p) => ({
    id: 'project::' + projKey(p), kind: 'project', name: p.name, repo: p.repo, type: p.type, tags: p.tags,
    bizLabel: nameWords(p.name), words: nameWords(p.name),
    tagWords: Object.values(facetsOf(p).byDimension).flat().map((v) => v.word),
    sub: [typeWord(p.type), multi && !biz() ? p.repo : ''].filter(Boolean).join(' · '),
    hash: '#/codemap?group=project&box=' + encodeURIComponent(projectToken(projKey(p))),
  }));
}

/** Applications first (the projects that say so), then every other project of the sources in scope. */
function appProjects() {
  const out = [];
  for (const [repo, m] of Object.entries(metas())) {
    if (S.scope !== 'all' && !S.scope.includes(repo)) continue;
    for (const p of m.projects || []) out.push({ repo, name: p.name, type: p.type, tags: p.tags || [] });
  }
  const rank = (p) => (p.type === 'application' ? 0 : p.type === 'library' ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
/** The packages of the sources in scope, by name. */
function packagesInScope() {
  return S.GRAPH.nodes.filter((n) => n.kind === 'package' && inScope(n)).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * Open or close the Views menu: an application (or a library) to draw with its
 * related projects, or a package to find — each a searchable single-select picker,
 * the first one's field focused so the keyboard can type and press Enter.
 */
function cmapViewsMenu(ev) {
  if (ev) ev.stopPropagation();
  const menu = document.getElementById('cm-viewsmenu');
  if (!menu) return;
  if (menu.classList.contains('open')) { closeViewsMenu(); return; }
  if (cmap().projMenu) closeProjMenu();
  const apps = appProjects();
  const pkgs = packagesInScope();
  const onClose = () => { closeViewsMenu(); const b = document.getElementById('cm-viewsbtn'); if (b) b.focus({ preventScroll: true }); };
  menu.innerHTML = '<div class="cm-mhead hud-label"' + tipAttrs({ key: 'codemap.view.app', noFocus: true }) + '>' + esc(t('codemap.view.app')) + '</div>'
    + (apps.length ? '<div class="cm-pickrow">' + pickerHtml('cm-pick-app', {
      multi: false, label: t('codemap.view.app'), placeholder: t('codemap.pick.findProject'), countKey: 'codemap.pick.countProjects',
      options: projectOptions(), groups: PROJECT_GROUPS(), selected: cmap().view && cmap().view.kind === 'app' ? [cmap().view.repo + '::' + cmap().view.project] : [],
      onChange: (ids) => { const k = ids[0]; if (!k) return; const i = k.indexOf('::'); cmapOpenApp(k.slice(i + 2), k.slice(0, i)); },
      onClose,
    }) + '</div>' : '<div class="cm-mnone">' + esc(t('codemap.view.noApps')) + '</div>')
    + '<div class="cm-mhead hud-label"' + tipAttrs({ key: 'codemap.view.package', noFocus: true }) + '>' + esc(t('codemap.view.package')) + '</div>'
    + (pkgs.length ? '<div class="cm-pickrow">' + pickerHtml('cm-pick-pkg', {
      multi: false, label: t('codemap.view.package'), placeholder: t('codemap.pick.findPackage'), countKey: 'codemap.pick.countPackages',
      options: packageOptions(pkgs), groups: PACKAGE_GROUPS(), selected: cmap().view && cmap().view.kind === 'package' && cmap().view.id ? [cmap().view.id] : [],
      onChange: (ids) => { if (ids[0]) cmapOpenPackage(ids[0]); },
      onClose,
    }) + '</div>' : '<div class="cm-mnone">' + esc(t('codemap.view.noPackages')) + '</div>');
  menu.classList.add('open');
  const btn = document.getElementById('cm-viewsbtn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  focusPicker(apps.length ? 'cm-pick-app' : 'cm-pick-pkg');
  const close = (e) => { if (menu.contains(e.target)) return; closeViewsMenu(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
}
/** Close the Views menu and forget what was typed in it. */
function closeViewsMenu() {
  const menu = document.getElementById('cm-viewsmenu');
  if (menu) menu.classList.remove('open');
  const btn = document.getElementById('cm-viewsbtn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  resetPicker('cm-pick-app'); resetPicker('cm-pick-pkg');
}

/** Redraw the map and the controls after the state moved, keeping the selection. */
function redraw() {
  bump();
  render();
  if (S.selected && S.BYID[S.selected]) select(S.selected);
  buildCmapControls();
}
/**
 * Write the code map's link (`group`, `view`, `project`, `package`, `repo`, and
 * outside a view the filters: `project=a,b` and `tag=domain:billing,type:ui`)
 * without remounting. A project is written by its name, or `repo::name` when two
 * sources have a project of that name.
 */
function writeHash() {
  const c = cmap();
  const q = new URLSearchParams();
  const r = S.route || {};
  if (r.lens) q.set('lens', r.lens);
  if (c.view && c.view.kind === 'app') { q.set('view', 'app'); q.set('project', c.view.project); if (c.view.repo) q.set('repo', c.view.repo); }
  else if (c.view && c.view.kind === 'package') { q.set('view', 'package'); q.set('package', c.view.id || c.view.ref); }
  else {
    if (c.group && c.group !== 'none') q.set('group', c.group);
    if (c.projects.size) q.set('project', [...c.projects].map(projectToken).join(','));
    const tags = [];
    for (const [d, set] of Object.entries(c.values)) for (const v of set) tags.push(d + ':' + v);
    if (tags.length) q.set('tag', tags.join(','));
  }
  // the lists stay readable in the address bar: a comma between names, a colon inside a tag
  const qs = q.toString().replace(/%2C/gi, ',').replace(/%3A/gi, ':');
  const h = '#/codemap' + (qs ? '?' + qs : '');
  if (location.hash !== h) history.replaceState(null, '', h);
}
/** Every project of every source the graph records, scope or not: `[{ repo, name, type, tags }]`. */
function allProjects() {
  const out = [];
  for (const [repo, m] of Object.entries(metas())) for (const p of m.projects || []) out.push({ repo, name: p.name, type: p.type, tags: p.tags || [] });
  return out;
}
/** A filter's project in the link: its name, or `repo::name` when another source has one of that name. */
function projectToken(key) {
  const i = key.indexOf('::');
  const name = i >= 0 ? key.slice(i + 2) : key;
  return allProjects().filter((p) => p.name === name).length > 1 ? key : name;
}
/** The project keys a link's `project=` names: `repo::name` as written, a bare name every source's project of that name. */
function projectsFromLink(v) {
  const all = allProjects();
  const out = new Set();
  for (const tok of String(v || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (tok.includes('::')) { if (all.some((p) => projKey(p) === tok)) out.add(tok); continue; }
    for (const p of all) if (p.name === tok) out.add(projKey(p));
  }
  return out;
}
/** The tag values a link's `tag=dim:value,…` names. */
function valuesFromLink(v) {
  const out = {};
  for (const tok of String(v || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = tok.indexOf(':');
    if (i <= 0) continue;
    (out[tok.slice(0, i)] = out[tok.slice(0, i)] || new Set()).add(tok.slice(i + 1));
  }
  return out;
}

/** The GROUP choice: kept, and written to the link. */
function cmapSetGroup(v) {
  const c = cmap();
  c.group = v || 'none';
  try { localStorage.setItem(GROUP_KEY, c.group); } catch (e) { /* private window: this visit only */ }
  writeHash();
  redraw();
}
function cmapTogglePackages() { cmap().hidePackages = !cmap().hidePackages; redraw(); }
function cmapToggleFiles() { cmap().showModules = !cmap().showModules; redraw(); }

// ── the two views ────────────────────────────────────────────────────────
/** Open *App and its related* for a project. */
function cmapOpenApp(name, repo) { openView({ kind: 'app', project: name, repo }); }
/** Open *Where is <package> included*. */
function cmapOpenPackage(ref) { openView({ kind: 'package', ref }); }
/** Leave the view: the whole map again. */
function cmapCloseView() {
  cmap().view = null;
  writeHash();
  redraw();
  if (S.selected && !S.BYID[S.selected]) document.getElementById('inspector').innerHTML = '';
}

/** Resolve a package ref (id or name) to its node id in the graph the page holds, or null. */
function packageId(ref, repo) {
  if (S.BYID[ref] && S.BYID[ref].kind === 'package') return ref;
  const hits = S.GRAPH.nodes.filter((n) => n.kind === 'package' && n.name === ref && (!repo || repoOfNode(n) === repo) && inScope(n));
  return hits.length ? hits[0].id : null;
}

/** Open a view: draw at once from the graph, then fill in what the server folds. */
async function openView(v) {
  const c = cmap();
  closeViewsMenu();
  if (v.kind === 'package') v.id = packageId(v.ref, v.repo);
  if (v.kind === 'app') {
    // the application's tree is drawn at once from the graph the page holds; the server adds the counts after
    v.repo = v.repo || (appProjects().find((p) => p.name === v.project) || {}).repo;
    const cl = v.repo ? projectClosure(metas(), v.repo, v.project) : { projects: [] };
    if (cl.projects.length) {
      v.closure = new Set(cl.projects);
      v.data = { projects: cl.projects, deps: cl.dependencies, project: null };
    }
  }
  v.loading = true;
  c.view = v;
  writeHash();
  redraw();
  const mine = v;
  try {
    if (v.kind === 'app') {
      const repo = v.repo || (appProjects().find((p) => p.name === v.project) || {}).repo;
      v.repo = repo;
      const q = repo ? '?repo=' + encodeURIComponent(repo) : '';
      const [one, all] = await Promise.all([
        fetch('/api/projects/' + encodeURIComponent(v.project) + q).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))),
        fetch('/api/projects' + q).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))),
      ]);
      if (cmap().view !== mine) return;
      const names = (one.closure && one.closure.projects) || [v.project];
      v.repo = one.project ? one.project.repo : repo;
      v.closure = new Set(names);
      v.data = { projects: names, deps: (all.dependencies || []).filter((d) => d.repo === v.repo && names.includes(d.from) && names.includes(d.to)), project: one };
    } else {
      if (!v.id) throw new Error('no package');
      const r = await fetch('/api/deps/where?package=' + encodeURIComponent(v.id));
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      if (cmap().view !== mine) return;
      v.data = data;
    }
    v.loading = false;
  } catch (e) {
    if (cmap().view !== mine) return;
    v.loading = false; v.failed = true;
  }
  redraw();
  // the inspector answers the view: the application's project, or where the package is included
  if (v.kind === 'app' && v.data) inspectProject(v.repo, v.project);
  else if (v.kind === 'package' && v.data) inspectWhere(v);
}

/** Read the route's group and view when the code map mounts. @group Code map */
export function cmapFromRoute(route) {
  const c = cmap();
  if (c.projMenu) closeProjMenu();
  if (route && route.group) {
    c.group = route.group;
    try { localStorage.setItem(GROUP_KEY, c.group); } catch (e) { /* private window */ }
  }
  const want = route && route.view === 'app' && route.project ? { kind: 'app', project: route.project, repo: route.repo || undefined }
    : route && route.view === 'package' && route.package ? { kind: 'package', ref: route.package, repo: route.repo || undefined } : null;
  const same = want && c.view && c.view.kind === want.kind && (want.kind === 'app' ? c.view.project === want.project : (c.view.ref === want.ref || c.view.id === want.ref));
  if (!want) {
    if (c.view) { c.view = null; bump(); }
    // the filters a link names win over the ones kept from the last visit; a link that names none keeps those
    if (route && (route.project || route.tag)) {
      c.projects = route.project ? projectsFromLink(route.project) : new Set();
      c.values = route.tag ? valuesFromLink(route.tag) : {};
      saveFilters();
    }
    // a kept filter for a project this graph no longer has would hide everything: dropped
    const known = new Set(allProjects().map(projKey));
    const stale = [...c.projects].filter((k) => !known.has(k));
    if (stale.length) { stale.forEach((k) => c.projects.delete(k)); saveFilters(); }
    // ⌘K to a project (`?group=project&box=<name>`): the map grouped by project, that project's box in view
    if (route && route.box) c.group = 'project';
    // a link to one card that the kept filters hide drops them: an arrival is always visible
    if (route && route.node && S.BYID[route.node]) {
      bump();
      if (cmapHide(S.BYID[route.node]) === 'filtered') { c.projects = new Set(); c.values = {}; c.dep = null; saveFilters(); }
    }
  } else if (!same) { openView(want); return; }
  bump();
  buildCmapControls();
}

/**
 * After the code map drew: a link that names a project box (`box=<name|repo::name>`,
 * fast travel's arrival) scrolls it into view, marks it and opens its inspector; a
 * link that lands on a card the kept filters hide drops them, so the arrival is
 * visible; the filters kept from the last visit are written into the link.
 * @group Code map
 */
export function cmapArrive(route) {
  const c = cmap();
  if (!route || c.view) return;
  if (route.box) {
    const key = [...projectsFromLink(route.box)][0];
    const find = () => key && document.getElementById('cmbox-' + cssId('p::' + key));
    // a kept filter that leaves the project out gives way: the arrival is the project
    if (key && !find() && narrowing()) { c.projects = new Set(); c.values = {}; c.dep = null; saveFilters(); redraw(); }
    const el = find();
    if (el) {
      document.querySelectorAll('.cm-box.cm-arrived').forEach((x) => x.classList.remove('cm-arrived'));
      el.classList.add('cm-arrived');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const i = key.indexOf('::');
      inspectProject(key.slice(0, i), key.slice(i + 2));
    }
  }
  if (!route.node && !route.box && narrowing() && !route.project && !route.tag) writeHash();
}

// ── the scope menu's code map sections ───────────────────────────────────
/**
 * The scope menu's sections on the code map: Projects, one section per tag
 * dimension the graph has (its values, tickable), and *Depends on* (a package).
 * They act on the code map only and compose with the sources above.
 * @group Code map
 */
export function cmapScopeHtml() {
  if (!S.GRAPH || !(S.route && S.route.surface === 'codemap')) return '';
  const c = cmap();
  const projects = appProjects();
  const pkgs = packagesInScope();
  if (!projects.length && !pkgs.length) return '';
  let html = '<div class="sc-group cm-scope"><div class="sc-plain hud-label"' + tipAttrs({ key: 'codemap.filter.title', noFocus: true }) + '>' + esc(t('codemap.filter.title')) + '</div>';
  if (projects.length > 1) {
    html += '<div class="sc-plain cm-sub"' + tipAttrs({ key: 'codemap.pick.projects', noFocus: true }) + '>' + esc(t('codemap.pick.projects')) + '</div>'
      + '<div class="cm-pickrow">' + pickerHtml('cm-pick-proj', {
        multi: true, label: t('codemap.pick.projects'), placeholder: t('codemap.pick.findProject'), countKey: 'codemap.pick.countProjects',
        options: projectOptions(), groups: PROJECT_GROUPS(), selected: c.projects,
        onChange: (ids) => { cmap().projects = new Set(ids); filtered(); },
      }) + '</div>';
  }
  const tagOpts = tagOptions(projects);
  if (tagOpts.options.length) {
    html += '<div class="sc-plain cm-sub"' + tipAttrs({ key: 'codemap.pick.tags', noFocus: true }) + '>' + esc(t('codemap.pick.tags')) + '</div>'
      + '<div class="cm-pickrow">' + pickerHtml('cm-pick-tags', {
        multi: true, label: t('codemap.pick.tags'), placeholder: t('codemap.pick.findTag'), countKey: 'codemap.pick.countTags',
        options: tagOpts.options, groups: tagOpts.groups,
        selected: Object.entries(c.values).flatMap(([d, set]) => [...set].map((v) => d + '=' + v)),
        onChange: (ids) => {
          const values = {};
          for (const id of ids) { const i = id.indexOf('='); (values[id.slice(0, i)] = values[id.slice(0, i)] || new Set()).add(id.slice(i + 1)); }
          cmap().values = values;
          filtered();
        },
      }) + '</div>';
  }
  if (pkgs.length) {
    html += '<div class="sc-plain cm-sub"' + tipAttrs({ key: 'codemap.filter.dependsOn', noFocus: true }) + '>' + esc(t('codemap.filter.dependsOn')) + '</div>'
      + '<div class="cm-pickrow" id="cm-dep">' + pickerHtml('cm-pick-dep', {
        multi: false, chips: true, label: t('codemap.filter.dependsOn'), placeholder: t('codemap.pick.findPackage'), countKey: 'codemap.pick.countPackages',
        options: packageOptions(pkgs), groups: PACKAGE_GROUPS(), selected: c.dep ? [c.dep] : [],
        onChange: (ids) => cmapSetDep(ids[0] || null),
      }) + '</div>';
  }
  if (narrowing() && !c.view) html += '<button class="sc-all cm-clear" onclick="cmapClearFilters()">✕ ' + esc(t('codemap.filter.clear')) + '</button>';
  return html + '</div>';
}

// ── the options the pickers list ─────────────────────────────────────────
/** The project groups, in the order a picker lists them: applications, libraries, end-to-end, the rest. */
const PROJECT_GROUPS = () => ['application', 'library', 'e2e', 'other'].map((k) => ({ key: k, word: t('codemap.pick.group.' + k) }));
const PACKAGE_GROUPS = () => ['workspace', 'thirdParty'].map((k) => ({ key: k, word: t('codemap.pick.group.' + k) }));
/** A project's name in words, whatever the lens: what a reader who types words finds it by. */
const nameWords = (name) => humanize(String(name || '').replace(/^@[^/]+\//, '').replace(/\//g, ' '));
/** A number in a picker's row: its tip, but no tab stop of its own (the field holds the keyboard). */
const rowNumber = (n, attrs) => '<span class="cnt"' + attrs.replace(' tabindex="0"', '') + ' tabindex="-1">' + n + '</span>';

/** The graph's parts of each project, by kind, keyed `repo::name` — `ProjectRow.nodes` folded on the page. */
let PARTS = null;
function partsByProject() {
  if (PARTS && PARTS.graph === S.GRAPH) return PARTS.map;
  const map = new Map();
  for (const n of (S.GRAPH && S.GRAPH.nodes) || []) {
    if (!n.project || n.kind === 'module') continue;
    const k = repoOfNode(n) + '::' + n.project.name;
    const e = map.get(k) || { n: 0, kinds: {} };
    e.n++; e.kinds[n.kind] = (e.kinds[n.kind] || 0) + 1;
    map.set(k, e);
  }
  PARTS = { graph: S.GRAPH, map };
  return map;
}

/**
 * Every project of the sources in scope as a picker option: grouped by type, its
 * words, its type and tag words as the sub line, its parts of the code as a number
 * with its tip, and matched on its name, its words and its tags.
 * @group Code map
 */
export function projectOptions() {
  const multi = Object.keys(metas()).length > 1;
  const parts = partsByProject();
  return appProjects().map((p) => {
    const k = projKey(p);
    const f = facetsOf(p);
    const words = [];
    for (const d of dimensionsOf(metas(), p.repo)) for (const v of f.byDimension[d.key] || []) if (d.key !== 'type' || !p.type || v.word.toLowerCase() !== typeWord(p.type).toLowerCase()) words.push(v.word);
    const c = parts.get(k) || { n: 0, kinds: {} };
    const rows = Object.entries(c.kinds).sort((a, b) => b[1] - a[1]).map(([kind, n]) => [kindWord(kind), n]);
    return {
      id: k,
      word: projectWord(p.name),
      group: p.type === 'application' || p.type === 'library' || p.type === 'e2e' ? p.type : 'other',
      sub: [typeWord(p.type), ...words, multi && !biz() ? p.repo : ''].filter(Boolean).join(' · '),
      countHtml: rowNumber(c.n, plainTip(c.n, 'count.unit.parts', 'count.scope.project', '/graph', rows)),
      match: [p.name, nameWords(p.name), ...(p.tags || []), ...Object.values(f.byDimension).flat().map((v) => v.word)],
    };
  });
}
/** Every tag value the projects in scope carry, one option per dimension and value, grouped by dimension. */
function tagOptions(projects) {
  const groups = [], options = [];
  for (const ch of choices().filter((x) => x.key !== 'none' && x.key !== 'project')) {
    const vals = new Map();
    for (const p of projects) for (const v of facetsOf(p).byDimension[ch.key] || []) {
      const e = vals.get(v.value) || { word: v.word, n: 0 };
      e.n++; vals.set(v.value, e);
    }
    if (!vals.size) continue;
    groups.push({ key: ch.key, word: ch.label });
    for (const [v, e] of [...vals].sort((a, b) => a[1].word.localeCompare(b[1].word))) {
      options.push({ id: ch.key + '=' + v, word: e.word, group: ch.key, match: [v, ch.label],
        countHtml: rowNumber(e.n, plainTip(e.n, 'count.unit.projects', 'count.scope.workspace', '/graph')) });
    }
  }
  return { groups, options };
}
/** The packages in scope as options: workspace libraries, then third-party. */
function packageOptions(pkgs) {
  const multi = Object.keys(metas()).length > 1;
  return pkgs.map((n) => ({
    id: n.id,
    word: biz() ? bizName(n) : n.name,
    group: n.package && n.package.scope === 'workspace' ? 'workspace' : 'thirdParty',
    sub: multi && !biz() ? repoOfNode(n) : '',
    match: [n.name, bizName(n)],
  }));
}

/** After a filter moved: keep it, write it to the link, redraw, and rebuild the scope menu, which stays open. */
function filtered() {
  saveFilters();
  if (!cmap().view) writeHash();
  redraw();
  if (window.buildScope) window.buildScope();
}
function cmapToggleProject(repo, name) {
  const s = cmap().projects, k = repo + '::' + name;
  s.has(k) ? s.delete(k) : s.add(k);
  filtered();
}
function cmapToggleValue(dim, value) {
  const c = cmap();
  const s = c.values[dim] = c.values[dim] || new Set();
  s.has(value) ? s.delete(value) : s.add(value);
  filtered();
}
function cmapSetDep(id) { cmap().dep = id || null; filtered(); }
/** Keep only what depends on one package (from its inspector). */
function cmapKeepDep(id) { cmap().dep = id; filtered(); }
function cmapClearFilters() {
  const c = cmap();
  c.projects = new Set(); c.values = {}; c.dep = null;
  filtered();
}

// ── the inspector ────────────────────────────────────────────────────────
/**
 * A part's project, in words: the project (a button to the project's own
 * inspector), its type, its value under each tag dimension, and — outside the
 * business lens — the tags as written. Nothing for a part outside every project.
 * @group Code map
 */
export function projectSecHtml(n) {
  if (!n || n.kind === 'package') return '';
  const p = projectOfItem(n, metas());
  if (!p) return '';
  const f = facetsOf(p);
  const dims = dimensionsOf(metas(), p.repo).filter((d) => (f.byDimension[d.key] || []).length);
  return '<div class="insp-sec cm-psec"><span class="hud-label"' + tipAttrs({ key: 'codemap.insp.project', noFocus: true }) + '>' + esc(t('codemap.insp.project')) + '</span>'
    + '<button class="rel" onclick="cmapInspectProject(' + jsArg(p.repo) + ',' + jsArg(p.name) + ')"><span class="rk">' + esc(typeWord(p.type)) + '</span>' + esc(projectWord(p.name)) + '</button>'
    + (dims.length ? '<div class="cm-facets">' + dims.map((d) => '<span class="cm-facet"><span class="hud-label">' + esc(d.label) + '</span> ' + esc(f.byDimension[d.key].map((v) => v.word).join(', ')) + '</span>').join('') + '</div>' : '')
    + ((p.tags || []).length && !biz() ? '<div class="tagrow">' + p.tags.map((x) => '<span class="tag">' + esc(x) + '</span>').join('') + '</div>' : '')
    + '</div>';
}

/** The package inspector's two actions: where it is included, and keep what depends on it. @group Code map */
export function packageActionsHtml(n) {
  if (!n || n.kind !== 'package') return '';
  return '<button class="btn" id="cm-where" onclick="cmapOpenPackage(' + jsArg(n.id) + ')"' + tipAttrs({ key: 'codemap.pkg.where', noFocus: true }) + '>' + sym('package') + ' ' + esc(t('codemap.pkg.where')) + '</button>'
    + '<button class="btn" onclick="cmapKeepDep(' + jsArg(n.id) + ')"' + tipAttrs({ key: 'codemap.pkg.keep', noFocus: true }) + '>' + esc(t('codemap.pkg.keep')) + '</button>';
}

/** Per-sync cache of `/api/deps/where` answers, by package id. */
const WHERE = new Map();
function whereOf(id) {
  const key = id + '@' + ((S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.generatedAt) || '');
  if (!WHERE.has(key)) WHERE.set(key, fetch('/api/deps/where?package=' + encodeURIComponent(id)).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return WHERE.get(key);
}

/**
 * A package's inspector section: which kind of package, the version each
 * declaring manifest writes (by project), the files that import it and the
 * journeys that reach it (both `Counted`s), the outside system it also is, and
 * the library it resolves to. Filled when `/api/deps/where` answers.
 * @group Code map
 */
export function packageSecHtml(n) {
  if (!n || n.kind !== 'package') return '';
  whereOf(n.id).then((d) => {
    const el = document.getElementById('cm-pkgsec');
    if (!el || el.dataset.id !== n.id) return;
    el.innerHTML = d && d.package ? packageBody(n, d) : '<p>' + esc(t('codemap.view.failed')) + '</p>';
  });
  return '<div class="insp-sec" id="cm-pkgsec" data-id="' + esc(n.id) + '"><span class="hud-label">' + esc(t('codemap.view.loading')) + '</span></div>';
}
function packageBody(n, d) {
  const row = d.package;
  const api = '/api/deps/where';
  const own = projectOfItem(n, metas());
  const ext = row.externalId && S.BYID[row.externalId];
  let html = '<span class="hud-label"' + tipAttrs({ key: 'codemap.pkg.title', noFocus: true }) + '>' + esc(t('codemap.pkg.title')) + '</span>'
    + '<div class="tagrow" style="margin-bottom:6px"><span class="api-chip"' + tipAttrs({ key: row.scope === 'workspace' ? 'codemap.pkg.workspace' : 'codemap.pkg.thirdParty', noFocus: true }) + '>' + sym('package') + esc(pkgScopeWord(n)) + '</span></div>'
    + '<div class="rd cm-counts">' + countedHtml(row.importers, api) + (countedText(row.importers) && countedText(row.journeys) ? ' · ' : '') + countedHtml(row.journeys, api) + '</div>';
  if (!biz()) {
    html += '<div class="cm-sublbl hud-label"' + tipAttrs({ key: 'codemap.pkg.versions', noFocus: true }) + '>' + esc(t('codemap.pkg.versions')) + '</div>'
      + (row.versions && row.versions.length
        ? row.versions.map((v) => '<div class="rd cm-ver"><b>' + esc(v.range) + '</b> · ' + esc(v.where) + ' <span class="cm-mdim">' + esc(v.declaredIn) + '</span></div>').join('')
        : '<div class="rd"' + tipAttrs({ key: 'codemap.pkg.noDecl', noFocus: true }) + '>' + esc(t('codemap.pkg.noDecl')) + '</div>');
  }
  if (own) html += '<div class="cm-sublbl hud-label"' + tipAttrs({ key: 'codemap.pkg.resolves', noFocus: true }) + '>' + esc(t('codemap.pkg.resolves')) + '</div>'
    + '<button class="rel" onclick="cmapInspectProject(' + jsArg(own.repo) + ',' + jsArg(own.name) + ')"><span class="rk">' + esc(typeWord(own.type)) + '</span>' + esc(projectWord(own.name)) + '</button>';
  if (ext) html += '<div class="cm-sublbl hud-label"' + tipAttrs({ key: 'codemap.pkg.external', noFocus: true }) + '>' + esc(t('codemap.pkg.external')) + '</div>'
    + '<button class="rel" onclick="select(' + jsArg(ext.id) + ')"><span class="rk">' + esc(kindWord(ext.kind)) + '</span>' + esc(bizName(ext)) + '</button>';
  if ((row.journeyRefs || []).length) html += '<div class="cm-sublbl hud-label"' + tipAttrs({ key: 'codemap.pkg.journeys', noFocus: true }) + '>' + esc(t('codemap.pkg.journeys')) + '</div>'
    + row.journeyRefs.map((j) => '<a class="rel" href="#/journeys/' + encodeURIComponent(j.id) + '">' + esc(S.BYID[j.id] ? bizName(S.BYID[j.id]) : j.name) + '</a>').join('');
  if (row.note && !biz()) html += '<p class="cm-mdim">' + esc(row.note) + '</p>';
  return html;
}

/** The inspector of the package view: where the package is included, by project, each importer a way to its card. */
function inspectWhere(v) {
  const insp = document.getElementById('inspector');
  const d = v.data, n = S.BYID[v.id];
  if (!insp || !d || !n) return;
  S.selected = null;
  const api = '/api/deps/where';
  insp.innerHTML = '<div class="insp-head"><span class="kind k-package hud-label">' + sym('package') + ' ' + esc(kindWord('package')) + ' · ' + esc(pkgScopeWord(n)) + '</span>'
    + '<h2>' + esc(t('codemap.view.packageOf').replace('{name}', biz() ? bizName(n) : n.name)) + '</h2>'
    + '<div class="rd">' + countedHtml(d.importers, api) + '</div></div>'
    + '<div class="actions"><button class="btn primary" onclick="select(' + jsArg(n.id) + ')">' + esc(kindWord('package')) + '</button>'
    + '<button class="btn" onclick="cmapCloseView()">' + esc(t('codemap.view.close')) + '</button></div>'
    + '<div class="insp-sec"><span class="hud-label"' + tipAttrs({ key: 'codemap.insp.importers', noFocus: true }) + '>' + esc(t('codemap.insp.importers')) + '</span>'
    + (d.groups || []).map((g) => {
      const ver = versionFor(d.package.versions, g.key);
      return '<div class="cm-wgroup"><div class="cm-whead"><b>' + esc(g.by === 'project' ? projectWord(g.key) : g.key) + '</b> '
        + (ver && !biz() ? '<span class="cm-mdim">' + esc(ver.range) + '</span> ' : '') + countedHtml(g.count, api) + '</div>'
        + g.importers.map((r) => '<button class="rel cm-imp" onclick="select(' + jsArg(r.id) + ')"><span class="rk">' + esc(biz() ? '' : r.specifier) + '</span>'
          + esc(biz() ? humanize(r.path.split('/').pop()) : r.path + ':' + r.line) + '</button>'
          + r.users.map((u) => '<button class="rel cm-user" onclick="select(' + jsArg(u.id) + ')"><span class="rk"' + tipAttrs({ key: 'codemap.insp.used', noFocus: true }) + '>' + esc(t('codemap.insp.used')) + '</span>'
            + esc(S.BYID[u.id] ? bizName(S.BYID[u.id]) : u.name) + '</button>').join('')).join('') + '</div>';
    }).join('') + '</div>';
}

/**
 * A project's inspector (a box's title, or the project line of a part): its
 * type and tags in words, *Show app and its related*, what it depends on and
 * what depends on it with their import statements, and its parts by kind —
 * every number a `Counted` from `/api/projects/<name>`.
 * @group Code map
 */
export async function inspectProject(repo, name) {
  const insp = document.getElementById('inspector');
  if (!insp) return;
  S.selected = null;
  const p = { repo, name, ...(((metas()[repo] || {}).projects || []).find((x) => x.name === name) || {}) };
  const f = facetsOf(p);
  const dims = dimensionsOf(metas(), repo).filter((d) => (f.byDimension[d.key] || []).length);
  const head = '<div class="insp-head"><span class="kind k-group hud-label"' + tipAttrs({ key: 'codemap.insp.project', noFocus: true }) + '>' + esc(t('codemap.insp.project')) + (biz() ? '' : ' · ' + esc(repo)) + '</span>'
    + '<h2>' + esc(projectWord(name)) + '</h2><div class="codename">' + esc(typeWord(p.type)) + '</div>'
    + (dims.length ? '<div class="cm-facets">' + dims.map((d) => '<span class="cm-facet"><span class="hud-label">' + esc(d.label) + '</span> ' + esc(f.byDimension[d.key].map((v) => v.word).join(', ')) + '</span>').join('') + '</div>' : '')
    + ((p.tags || []).length && !biz() ? '<div class="tagrow" style="margin-top:6px">' + p.tags.map((x) => '<span class="tag">' + esc(x) + '</span>').join('') + '</div>' : '') + '</div>'
    + '<div class="actions"><button class="btn primary" id="cm-showapp" onclick="cmapOpenApp(' + jsArg(name) + ',' + jsArg(repo) + ')"' + tipAttrs({ key: 'codemap.insp.showApp', noFocus: true }) + '>' + esc(t('codemap.insp.showApp')) + '</button>'
    + (cmap().view ? '<button class="btn" onclick="cmapCloseView()">' + esc(t('codemap.view.close')) + '</button>' : '') + '</div>';
  insp.innerHTML = head + '<div class="insp-sec" id="cm-projsec"><span class="hud-label">' + esc(t('codemap.view.loading')) + '</span></div>';
  const api = '/api/projects/' + encodeURIComponent(name) + '?repo=' + encodeURIComponent(repo);
  const d = await fetch(api).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const sec = document.getElementById('cm-projsec');
  if (!sec) return;
  if (!d || !d.project) { sec.innerHTML = '<p>' + esc(t('codemap.view.failed')) + '</p>'; return; }
  const depRow = (x, other) => '<button class="rel" onclick="cmapInspectProject(' + jsArg(repo) + ',' + jsArg(other) + ')"><span class="rk">'
    + (x.imports ? '<span' + countedAttrs(x.count, api) + '>' + esc(countedText(x.count, 'hybrid')) + '</span>' : '<span' + tipAttrs({ key: 'codemap.view.declared', noFocus: true }) + '>' + esc(t('codemap.view.declared')) + '</span>')
    + '</span>' + esc(projectWord(other)) + '</button>';
  const parts = d.project.nodes;
  sec.outerHTML = '<div class="insp-sec"><span class="hud-label"' + tipAttrs({ key: 'codemap.insp.parts', noFocus: true }) + '>' + esc(t('codemap.insp.parts')) + ' · ' + countedHtml(parts, api) + '</span>'
    + '<div class="tagrow">' + (parts.breakdown || []).map((b) => '<span class="tag">' + esc(kindWord(b.label)) + ' · ' + b.n + '</span>').join('') + '</div></div>'
    + '<div class="insp-sec"><span class="hud-label"' + tipAttrs({ key: 'codemap.insp.dependsOn', noFocus: true }) + '>' + esc(t('codemap.insp.dependsOn')) + ' · <span class="cnt"' + countedAttrs(d.closure.count, api) + '>' + esc(countedText(d.closure.count)) + '</span></span>'
    + (d.dependencies || []).map((x) => depRow(x, x.to)).join('') + '</div>'
    + '<div class="insp-sec"><span class="hud-label"' + tipAttrs({ key: 'codemap.insp.dependents', noFocus: true }) + '>' + esc(t('codemap.insp.dependents')) + ' · '
    + '<span class="cnt"' + plainTip((d.dependents || []).length, 'count.unit.projects', 'count.scope.project', api) + '>' + (d.dependents || []).length + '</span></span>'
    + (d.dependents || []).map((x) => depRow(x, x.from)).join('') + '</div>';
}

/** A tag value's box in the inspector: the projects that carry it, each a way to its own inspector. */
function inspectValue(g) {
  const insp = document.getElementById('inspector');
  if (!insp) return;
  S.selected = null;
  const dim = cmapGrouping();
  const projects = appProjects().filter((p) => (facetsOf(p).byDimension[dim] || []).some((v) => v.value === g.value));
  insp.innerHTML = '<div class="insp-head"><span class="kind k-group hud-label">' + esc(dimLabel(dim)) + '</span><h2>' + esc(g.word) + '</h2>'
    + '<div class="rd"><span' + plainTip(g.parts, 'codemap.group.parts', 'codemap.group.scope', '/graph', Object.entries(g.byKind).map(([k, n]) => [kindWord(k), n])) + '>'
    + esc(t(g.parts === 1 ? 'codemap.group.partsOne' : 'codemap.group.parts').replace('{n}', g.parts)) + '</span></div></div>'
    + '<div class="insp-sec"><span class="hud-label"' + tipAttrs({ key: 'codemap.insp.inBox', noFocus: true }) + '>' + esc(t('codemap.insp.inBox')) + ' · '
    + '<span class="cnt"' + plainTip(projects.length, 'count.unit.projects', 'count.scope.workspace', '/graph') + '>' + projects.length + '</span></span>'
    + projects.map((p) => '<button class="rel" onclick="cmapInspectProject(' + jsArg(p.repo) + ',' + jsArg(p.name) + ')"><span class="rk">' + esc(typeWord(p.type)) + '</span>' + esc(projectWord(p.name)) + '</button>').join('') + '</div>';
}

expose({
  cmapSetGroup, cmapTogglePackages, cmapToggleFiles, cmapViewsMenu, cmapOpenApp, cmapOpenPackage, cmapCloseView,
  cmapToggleProject, cmapToggleValue, cmapSetDep, cmapKeepDep, cmapClearFilters, cmapDropFilter, cmapInspectProject: inspectProject,
  cmapProjMenu, cmapBarType,
});
