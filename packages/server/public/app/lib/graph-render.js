// lib/graph-render.js — the existing node-card / lane / edge renderer,
// extracted from viewer.js. Renders the interim Code map surface (today's
// graph) and supplies nodeCardHtml/vsl to the Journeys surface so both speak
// one visual language. All chrome glyphs are drawn sprite symbols — no emoji.

import { S, expose, esc, jsArg, cssId, repoOf, bizLabel, bizName, humanize, effectiveGroup, scopedRepos, collSourceNames, currentLens } from '../store.js';
import { sym } from '../sym.js';
import { t, def } from '../strings.js';
import { setTip, tipSource, tipAttrs } from './tooltip.js';
import { storiesSecHtml } from '../stories.js';
import { defAttrs, plainTip, unCode } from './counted.js';
import { nodeWorkSecHtml } from '../work-chips.js';
import { cmapHide, cmapGrouping, renderGrouped, projectSecHtml, packageSecHtml, packageActionsHtml, pkgScopeWord } from '../surfaces/codemap-projects.js';

/** True in the business lens — the map and the inspector name things, never identify them. */
function biz() { return currentLens() === 'business'; }

/**
 * A node's kind as the lens reads it: the business lens says what the thing is
 * for a person (*screen*, *gate*, *record*), the others keep the graph's kind,
 * which is a developer's word they already read. Its tip says what the kind means.
 * @group Graph rendering
 */
export function kindWord(kind) {
  const key = 'surf.kind.' + (kind || 'unknown');
  return biz() && S.STRINGS && S.STRINGS[key] ? t(key) : (kind === 'unknown' ? '? ' + t('term.unresolved') : (kind || ''));
}
/** The tip attributes for a kind badge. @group Graph rendering */
function kindTip(kind) {
  const key = 'surf.kind.' + (kind || 'unknown');
  return S.STRINGS && S.STRINGS[key] ? defAttrs(key) : '';
}
/**
 * A group card's name in the business lens: the folder or file it stands for,
 * in words — never `Cx.spec` or `Coverage final.json`.
 * @group Graph rendering
 */
function groupWords(name) {
  return biz() ? humanize(String(name || '').replace(/\.(spec|test|stories)\b/gi, '').replace(/\.json$/i, '')) : name;
}

const LANES = [
  { label: 'UI', kinds: ['page', 'component'] },
  { label: 'Routes', kinds: ['api', 'route'] },
  { label: 'Logic', kinds: ['function', 'rule'] },
  { label: 'Data & Events', kinds: ['table', 'queue', 'external', 'unknown'] },
  // a file is drawn only with *show files* on (the code map's chip); a package always, unless hidden
  { key: 'codemap.lane.files', kinds: ['module'] },
  { key: 'codemap.lane.deps', kinds: ['package'] },
];
export const LANE_W = 256, NODE_W = 196, TOP = 54;
const GB_HEAD = 36, GB_ROW = 54, GB_PADX = 10, GAP = 14, COL_MAX = 980;

/** Build the display node list: guards become badges; grouped functions
 *  collapse — or, when expanded, stay inside a visual group container. */
/**
 * @group Graph rendering
 */
export function displayNodes() {
  // one pass, O(1) per node: the scope's sources read once, the code map's own reasons a lookup (cmapHide)
  const repos = scopedRepos();
  const raw = S.GRAPH.nodes.filter((n) => n.kind !== 'guard' && (!repos || repos.has(repoOf(n))) && (!S.focusSet || S.focusSet.has(n.id)) && !cmapHide(n));
  const out = [], groupMap = {}, tagSets = new Map();
  for (const n of raw) {
    const g = effectiveGroup(n);
    if (g) {
      if (!groupMap[g.key]) {
        groupMap[g.key] = { id: 'group::' + g.key, key: g.key, kind: 'group', laneKind: g.laneKind, expanded: S.expandedGroups.has(g.key),
          name: g.name, codename: g.codename, members: [], tags: [], repo: repoOf(n),
          loc: g.anchor && g.anchor.loc ? { path: g.anchor.loc.path, line: g.anchor.loc.line + 0.5 } : undefined };
        tagSets.set(groupMap[g.key], new Set());
        out.push(groupMap[g.key]);
      }
      groupMap[g.key].members.push(n);
      // one Set per group, made into the list once at the end (rebuilding the list per member was quadratic)
      const set = tagSets.get(groupMap[g.key]);
      for (const tag of n.tags || []) set.add(tag);
    } else out.push(n);
  }
  for (const [grp, set] of tagSets) grp.tags = [...set];
  return out.filter((n) => laneOf(n) >= 0);
}
/** Re-route edges to group nodes; drop guard edges (badges instead); dedupe. */
/**
 * @group Graph rendering
 */
export function displayEdges(visibleIds, memberToGroup) {
  const seen = new Set(), out = [];
  for (const e of S.GRAPH.edges) {
    if (e.kind === 'guards') continue;
    let from = memberToGroup[e.from] || e.from, to = memberToGroup[e.to] || e.to;
    if (from === to) continue;
    if (!visibleIds.has(from) || !visibleIds.has(to)) continue;
    const key = e.kind + '|' + from + '|' + to;
    if (seen.has(key)) continue; seen.add(key);
    out.push({ ...e, from, to });
  }
  return out;
}
/** @group Graph rendering */
export function laneOf(n) {
  const k = n.kind === 'group' ? (n.laneKind || 'function') : n.kind;
  return LANES.findIndex((l) => l.kinds.includes(k));
}

// ── render ──────────────────────────────────────────────────────
/**
 * @group Graph rendering
 */
export function itemHeight(n) {
  if (n.kind === 'group') return n.expanded ? GB_HEAD + n.members.length * GB_ROW + 10 : 100;
  let h = 64;
  if (n.loc || n.kind === 'package') h += 13;
  if ((S.guardsByTarget[n.id] || []).length || (S.validatesByTarget[n.id] || []).length) h += 24;
  return h;
}
/**
 * @group Graph rendering
 * @business Draws the whole system map: lanes, nodes, groups, and connections.
 */
export function render() {
  const stage = document.getElementById('stage'), svg = document.getElementById('edgesvg');
  clearStage(stage);
  svg.innerHTML = '';
  const nodes = displayNodes();
  S.displayCache = nodes;
  S.displayById = new Map(nodes.map((n) => [n.id, n]));
  const memberToGroup = {};
  nodes.forEach((n) => { if (n.kind === 'group' && !n.expanded) n.members.forEach((m) => (memberToGroup[m.id] = n.id)); });
  updateStats(nodes.length);
  // grouped by project or a tag dimension, or one of the two views: boxes of cards (surfaces/codemap-projects.js)
  if (cmapGrouping() !== 'none') { renderGrouped(nodes, memberToGroup); return; }

  // one sort key per card, compared with one collator (localeCompare per comparison was most of a large draw)
  const keyOf = new Map(nodes.map((n) => [n, (n.loc && n.loc.path) || n.codename || '']));
  nodes.sort((a, b) => COLLATE.compare(keyOf.get(a), keyOf.get(b)) || ((a.loc && a.loc.line) || 0) - ((b.loc && b.loc.line) || 0));
  const laneNodes = LANES.map(() => []);
  for (const n of nodes) { const i = laneOf(n); if (i >= 0) laneNodes[i].push(n); }
  const laneLabels = LANES.filter((l, i) => laneNodes[i].length).map((l) => (l.key ? t(l.key) : l.label));
  const head = document.createElement('div'); head.className = 'lanehead'; head.style.display = 'flex';
  S.positions = {};
  const items = [];
  let colOffset = 0, maxY = 0;
  laneNodes.filter((g) => g.length).forEach((group, gi) => {
    let sub = 0, y = TOP;
    group.forEach((n) => {
      const h = itemHeight(n);
      if (y + h > COL_MAX && y > TOP) { sub++; y = TOP; }
      const p = S.positions[n.id] = { x: (colOffset + sub) * LANE_W + (LANE_W - NODE_W) / 2, y };
      if (n.kind === 'group' && n.expanded) {
        items.push({ key: 'gbox:' + n.key, x: p.x - 6, y: p.y, w: NODE_W + 12, h, make: () => makeGroupBox(n) });
        n.members.forEach((m, i) => {
          const q = S.positions[m.id] = { x: p.x + GB_PADX, y: y + GB_HEAD + i * GB_ROW, w: NODE_W - GB_PADX * 2 };
          items.push({ key: m.id, x: q.x, y: q.y, w: q.w, h: GB_ROW, make: () => makeNode(m, true) });
        });
      } else items.push({ key: n.id, x: p.x, y: p.y, w: NODE_W, h, make: () => makeNode(n, false) });
      y += h + GAP; maxY = Math.max(maxY, y);
    });
    const subcols = sub + 1;
    head.insertAdjacentHTML('beforeend', '<span class="hud-label" style="width:' + (subcols * LANE_W) + 'px;text-align:center;flex-shrink:0">' + esc(laneLabels[gi]) + '</span>');
    colOffset += subcols;
  });
  stage.appendChild(head);
  stage.style.width = Math.max(colOffset, 1) * LANE_W + 'px';
  stage.style.height = (maxY + 40) + 'px';
  svg.setAttribute('width', Math.max(colOffset, 1) * LANE_W); svg.setAttribute('height', maxY + 40);
  stageItems(items, memberToGroup, nodes);
}
const COLLATE = new Intl.Collator();

// ── the windowed stage ──────────────────────────────────────────────
// A thousand-project workspace puts ~150k cards on the code map. The layout (every card's place) is
// computed for all of them — it is arithmetic — but only the cards and boxes near the viewport are
// elements: the stage is cut into cells, a scroll paints the cells in view (and one viewport around
// them) and lets go of the rest, and the arrows are drawn for the cards on the stage. Below
// WINDOW_AT drawables everything is drawn, as it always was.
const WINDOW_AT = 1500;
const CELL = 1024;
let PAINT = null;
let PAINT_RAF = 0;

/** Remove every card, box and lane head from the stage, drawn or not. @group Graph rendering */
export function clearStage(stage) {
  (stage || document.getElementById('stage')).querySelectorAll('.node,.lanehead,.groupbox').forEach((e) => e.remove());
  if (PAINT) PAINT.drawn.clear();
}

/**
 * Hand the stage its drawables — `{ key, x, y, w, h, make }`, boxes before the cards inside them — and
 * paint what is in view. `onPaint(added)` is told which drawables were just made (the grouped layout
 * measures their heights). @group Graph rendering
 */
export function stageItems(items, memberToGroup, display, onPaint) {
  const windowed = items.length >= WINDOW_AT;
  const grid = new Map();
  const byKey = new Map();
  items.forEach((it, i) => {
    byKey.set(it.key, it);
    if (!windowed) return;
    for (let cx = Math.floor(it.x / CELL); cx <= Math.floor((it.x + it.w) / CELL); cx++) {
      for (let cy = Math.floor(it.y / CELL); cy <= Math.floor((it.y + it.h) / CELL); cy++) {
        const k = cx + ',' + cy;
        const l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]);
      }
    }
  });
  const members = new Map();
  for (const n of display || []) if (n.kind === 'group' && !n.expanded) members.set(n.id, n.members);
  PAINT = { items, grid, byKey, windowed, drawn: new Map(), memberToGroup, members, onPaint };
  bindStageScroll();
  return paintStage();
}

/** Paint the drawables in view (all of them below the threshold); returns the ones just made. @group Graph rendering */
export function paintStage() {
  const P = PAINT;
  if (!P) return [];
  const stage = document.getElementById('stage');
  let want = P.items;
  if (P.windowed) {
    const wrap = stage.parentElement;
    const vw = (wrap && wrap.clientWidth) || 1400, vh = (wrap && wrap.clientHeight) || 900;
    const left = wrap ? wrap.scrollLeft : 0, top = wrap ? wrap.scrollTop : 0;
    const x0 = left - vw, x1 = left + 2 * vw, y0 = top - vh, y1 = top + 2 * vh;
    const idx = new Set();
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        for (const i of P.grid.get(cx + ',' + cy) || []) idx.add(i);
      }
    }
    want = [...idx].sort((a, b) => a - b).map((i) => P.items[i]).filter((it) => it.x < x1 && it.x + it.w > x0 && it.y < y1 && it.y + it.h > y0);
  }
  const keep = new Set();
  const frag = document.createDocumentFragment();
  const added = [];
  for (const it of want) {
    keep.add(it.key);
    if (P.drawn.has(it.key)) continue;
    const el = it.make();
    if (!el) continue;
    P.drawn.set(it.key, el);
    frag.appendChild(el);
    added.push(it);
  }
  for (const [k, el] of P.drawn) if (!keep.has(k)) { el.remove(); P.drawn.delete(k); }
  stage.appendChild(frag);
  if (P.onPaint && added.length) P.onPaint(added);
  if (PAINT === P) drawEdges(P.memberToGroup);
  return added;
}

function bindStageScroll() {
  const wrap = document.getElementById('stage') && document.getElementById('stage').parentElement;
  if (!wrap || wrap.dataset.paints) return;
  wrap.dataset.paints = '1';
  const later = () => {
    if (!PAINT || !PAINT.windowed || PAINT_RAF) return;
    PAINT_RAF = requestAnimationFrame(() => { PAINT_RAF = 0; paintStage(); });
  };
  wrap.addEventListener('scroll', later, { passive: true });
  window.addEventListener('resize', later);
}

/**
 * The element of a card or a box, painting it first when the stage is windowed and it is out of view:
 * the stage scrolls to it (centred) and paints. `key` is a node id, or `box:<group key>` for a box.
 * @group Graph rendering
 */
export function revealOnStage(key, domId) {
  const have = document.getElementById(domId);
  if (have || !PAINT || !PAINT.windowed) return have;
  const it = PAINT.byKey.get(key);
  const wrap = document.getElementById('stage').parentElement;
  if (!it || !wrap) return null;
  wrap.scrollLeft = Math.max(0, it.x + it.w / 2 - wrap.clientWidth / 2);
  wrap.scrollTop = Math.max(0, it.y + it.h / 2 - wrap.clientHeight / 2);
  paintStage();
  return document.getElementById(domId);
}
/** A card's element, painted into view first when the stage is windowed. @group Graph rendering */
export function revealCard(id) { return revealOnStage(id, 'nd-' + cssId(id)); }
/**
 * The arrows between the cards on the map, from where `render()` (or the
 * grouped layout) put them: every edge whose two ends are drawn, re-routed to
 * a folded group's card, the selected card's arrows lit.
 * @group Graph rendering
 */
export function drawEdges(memberToGroup) {
  const svg = document.getElementById('edgesvg');
  let layer = svg.querySelector('g.edge-layer');
  if (!layer) { layer = document.createElementNS('http://www.w3.org/2000/svg', 'g'); layer.setAttribute('class', 'edge-layer'); svg.insertBefore(layer, svg.firstChild); }
  const P = PAINT;
  let edges;
  if (P && P.windowed) {
    // the arrows of the cards on the stage: each drawn card's own edges (a folded group's are its members'),
    // re-routed to the cards they are drawn on — never every edge of the graph
    const seen = new Set();
    edges = [];
    for (const id of P.drawn.keys()) {
      for (const own of P.members.get(id) || [{ id }]) {
        for (const e of S.EDGES_OF.get(own.id) || []) {
          if (e.kind === 'guards') continue;
          const from = memberToGroup[e.from] || e.from, to = memberToGroup[e.to] || e.to;
          if (from === to || !S.positions[from] || !S.positions[to]) continue;
          const key = e.kind + '|' + from + '|' + to;
          if (seen.has(key)) continue; seen.add(key);
          edges.push({ kind: e.kind, from, to });
        }
      }
    }
  } else edges = displayEdges(new Set(Object.keys(S.positions)), memberToGroup);
  // every height read before anything is written: a read after a write is a layout per arrow
  const heights = new Map();
  const hOf = (id) => {
    if (!heights.has(id)) { const el = document.getElementById('nd-' + cssId(id)); heights.set(id, el ? el.offsetHeight : 50); }
    return heights.get(id);
  };
  let html = '';
  for (const e of edges) {
    const A = S.positions[e.from], B = S.positions[e.to]; if (!A || !B) continue;
    const hA = hOf(e.from), hB = hOf(e.to);
    const wA = A.w || NODE_W, wB = B.w || NODE_W;
    let x1 = A.x + wA, y1 = A.y + hA / 2, x2 = B.x, y2 = B.y + hB / 2;
    if (B.x <= A.x) { x1 = A.x; x2 = B.x + wB; }
    if (Math.abs(A.x - B.x) < LANE_W / 2) { x1 = A.x + wA; x2 = B.x + wB; }
    const mx = (x1 + x2) / 2;
    const bend = A.x === B.x ? ' C' + (x1 + 40) + ',' + y1 + ' ' + (x2 + 40) + ',' + y2 + ' ' + x2 + ',' + y2 : ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2;
    let cls = 'edge';
    if (e.kind === 'validates') cls += ' validates';
    if (S.selected && (e.from === S.selected || e.to === S.selected)) cls += ' hot';
    html += '<path d="M' + x1 + ',' + y1 + bend + '" class="' + cls + '"/>';
  }
  layer.innerHTML = html;
}
/**
 * Shared node-card body markup — kind color bar, biz name, codename, path,
 * gate badges — used by BOTH the main graph's renderNode and the journey
 * flow-map cards so the two surfaces speak one visual language.
 * @group Graph rendering
 */
export function nodeCardHtml(n, mini, name) {
  const guards = S.guardsByTarget[n.id] || [];
  const rules = (S.validatesByTarget[n.id] || []).length;
  const c = n.contract;
  const kw = name != null ? kindWord(n.kind) : (n.kind === 'unknown' ? '? ' + t('term.unresolved') : (n.kind || ''));
  // a package says which kind of package it is in words, beside the stripe that says it in shape
  const pkg = n.kind === 'package' ? ' · ' + esc(pkgScopeWord(n)) : '';
  const ver = n.kind === 'package' && !mini && !(name != null && biz()) && n.package && n.package.version ? '<div class="sub">' + esc(n.package.version) + '</div>' : '';
  return '<div class="kind k-' + esc(n.kind || '') + '">' + (n.kind === 'package' ? sym('package') + ' ' : '') + esc(kw) + pkg
    + (c && c.status !== 'both' ? ' · ' + esc(t(c.status === 'spec-only' ? 'apis.status.specOnly' : c.status === 'declared' ? 'apis.status.declared' : 'apis.status.codeOnly')) : '') + '</div>'
    + '<div class="name">' + esc(name != null ? name : bizLabel(n)) + '</div><div class="codename">' + esc(n.name || '') + '</div>'
    + (n.loc && !mini ? '<div class="sub">' + esc(n.loc.path) + ':' + n.loc.line + vsl(repoOf(n), n.loc.path, n.loc.line) + '</div>' : '') + ver
    + ((guards.length || rules) && !mini ? '<div class="gbadges">' + guards.map((g) => '<span class="gbadge">' + sym('lock') + ' ' + esc(name != null && biz() ? bizName(g) : g.name.replace(/^requireScope: /, '')) + '</span>').join('')
      + (rules ? '<span class="gbadge rule"' + plainTip(rules, 'count.part.rules', 'count.scope.node', '/graph') + '>' + sym('shield') + ' ' + esc(t(rules === 1 ? 'count.part.rulesOne' : 'count.part.rules').replace('{n}', rules)) + '</span>' : '') + '</div>' : '');
}
/**
 * @group Graph rendering
 */
export function renderNode(n, mini, extraCls) {
  const el = makeNode(n, mini, extraCls);
  if (el) document.getElementById('stage').appendChild(el);
}
/** A card's element at its place in `S.positions`, not yet on the stage. @group Graph rendering */
export function makeNode(n, mini, extraCls) {
  const p = S.positions[n.id]; if (!p) return null;
  const el = document.createElement('div');
  const isGroup = n.kind === 'group';
  el.className = 'node nk-' + cssId(n.kind || '') + (mini ? ' mini' : '') + (extraCls ? ' ' + extraCls : '')
    + (n.kind === 'package' ? (n.package && n.package.scope === 'workspace' ? ' pkg-ws' : ' pkg-tp') : '') + (isGroup ? ' grp' : '') + (S.selected === n.id || (S.selected && cardOf(S.selected) === n.id) ? ' sel' : '') + (S.activeTag && !(n.tags || []).includes(S.activeTag) ? ' faded' : '')
    + (n.contract && n.contract.status === 'spec-only' ? ' contract-spec-only' : '');
  el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
  if (p.w) el.style.width = p.w + 'px';
  el.id = 'nd-' + cssId(n.id); el.tabIndex = 0;
  el.innerHTML = isGroup
    ? '<div class="kind k-group"' + kindTip('group') + '>' + esc(kindWord('group')) + ' · ' + esc(repoOf(n)) + '</div><div class="name">' + esc(groupWords(n.name)) + '</div><div class="codename">' + esc(n.codename) + '</div>'
      + '<div class="count"><span' + membersTip(n) + '>⊞ ' + esc(t(n.members.length === 1 ? 'surf.membersOne' : 'surf.members').replace('{n}', n.members.length)) + '</span></div>'
      + '<span class="expander"' + tipAttrs({ key: 'surf.group.expand' }) + ' onclick="event.stopPropagation();toggleGroup(' + jsArg(groupKeyOfDisplay(n)) + ')">⊕</span>'
    : nodeCardHtml(n, mini, bizName(n));
  el.onclick = () => select(n.id);
  el.ondblclick = () => { if (isGroup) toggleGroup(groupKeyOfDisplay(n)); };
  el.oncontextmenu = (e) => { e.preventDefault(); openCtx(e, n); };
  el.onkeydown = (e) => { if (e.key === 'Enter') select(n.id); };
  return el;
}
/**
 * A group's member count, with what it counts and its split by kind — the
 * parts add up to the number on the card.
 * @group Graph rendering
 */
function membersTip(n) {
  const by = {};
  n.members.forEach((m) => { by[m.kind] = (by[m.kind] || 0) + 1; });
  return plainTip(n.members.length, 'surf.members', 'surf.scope.group', '/graph',
    Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, c]) => [kindWord(k), c]));
}
/**
 * @group Graph rendering
 */
export function renderGroupBox(n) {
  document.getElementById('stage').appendChild(makeGroupBox(n));
  n.members.forEach((m) => renderNode(m, true));
}
/** An opened file group's box (its members are cards of their own). @group Graph rendering */
export function makeGroupBox(n) {
  const p = S.positions[n.id];
  const box = document.createElement('div');
  box.className = 'groupbox';
  box.style.left = (p.x - 6) + 'px'; box.style.top = p.y + 'px';
  box.style.width = (NODE_W + 12) + 'px'; box.style.height = (GB_HEAD + n.members.length * GB_ROW + 8) + 'px';
  box.innerHTML = '<div class="ghead"' + tipAttrs({ key: 'surf.group.collapse', noFocus: true }) + '><span class="gname">' + esc(groupWords(n.name)) + '</span><span class="gpath">' + esc(n.codename) + '</span><span class="collapse">⊖</span></div>';
  box.querySelector('.ghead').onclick = () => toggleGroup(groupKeyOfDisplay(n));
  box.oncontextmenu = (e) => { e.preventDefault(); openCtx(e, n); };
  return box;
}
/** @group Graph rendering */
export function groupKeyOfDisplay(n) { return n.key; }
/**
 * @group Node actions
 */
export function toggleGroup(key) {
  S.expandedGroups.has(key) ? S.expandedGroups.delete(key) : S.expandedGroups.add(key);
  render();
}

// ── context menu & node actions ─────────────────────────────────
/**
 * vscode://file deep link for any repo-relative location, or null when the
 * repo's root isn't known (old graph.json without roots) — fail-soft.
 * @group Node actions
 */
export function vscodeHrefLoc(repo, path, line) {
  const root = S.ROOTS[repo];
  return root && path ? 'vscode://file/' + root + '/' + path + (line ? ':' + line : '') : null;
}
/**
 * @group Node actions
 */
export function vscodeHref(n) { return n.loc ? vscodeHrefLoc(repoOf(n), n.loc.path, n.loc.line) : null; }
/**
 * Inline anchor (drawn open-in-editor glyph) that opens a location in VS Code
 * — appended everywhere the UI shows a file:line so every code reference is
 * one click from the editor. Empty string when no root is known.
 * @group Node actions
 */
export function vsl(repo, path, line) {
  const h = vscodeHrefLoc(repo, path, line);
  return h ? '<a class="vsl" href="' + esc(h) + '" title="Open in VS Code" onclick="event.stopPropagation()">' + sym('open') + '</a>' : '';
}
/**
 * @group Node actions
 */
export function openCtx(e, n) {
  const menu = document.getElementById('ctxmenu');
  const isGroup = n.kind === 'group';
  const eg = !isGroup && effectiveGroup(n);
  const key = isGroup ? groupKeyOfDisplay(n) : (eg ? eg.key : null);
  const items = [];
  items.push('<button onclick="ctxDo(()=>focusOn(' + jsArg(n.id) + '))"><span class="ic">◎</span>Focus here</button>');
  if (!isGroup) items.push('<button onclick="ctxDo(()=>select(' + jsArg(n.id) + '))"><span class="ic">☰</span>Inspect</button>');
  if (!isGroup && ['function', 'component', 'route', 'page'].includes(n.kind))
    items.push('<button onclick="ctxDo(()=>openJourney(' + jsArg(n.id) + '))"><span class="ic">▶</span>Run journey</button>');
  if (!isGroup) items.push('<button onclick="ctxDo(()=>openImpact(' + jsArg(n.id) + '))"><span class="ic">' + sym('fork') + '</span>What does changing this affect?</button>');
  const href = !isGroup && vscodeHref(n);
  if (href) items.push('<button onclick="ctxDo(()=>window.location.href=' + jsArg(href) + ')"><span class="ic">' + sym('open') + '</span>Open in VS Code</button>');
  if (key) items.push('<button onclick="ctxDo(()=>toggleGroup(' + jsArg(key) + '))"><span class="ic">' + (S.expandedGroups.has(key) ? '⊖' : '⊕') + '</span>' + (S.expandedGroups.has(key) ? 'Collapse' : 'Expand') + ' group</button>');
  items.push('<button onclick="ctxDo(()=>navigator.clipboard.writeText(' + jsArg(n.id) + '))"><span class="ic">⌗</span>Copy node id</button>');
  menu.innerHTML = items.join('');
  menu.classList.add('open');
  const mw = 210, mh = items.length * 34;
  menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + 'px';
}
/**
 * @group Node actions
 */
export function ctxDo(fn) { closeCtx(); fn(); }
/**
 * @group Node actions
 */
export function closeCtx() { document.getElementById('ctxmenu').classList.remove('open'); }
/**
 * @group Graph rendering
 */
export function updateStats(shown) {
  // what is drawn, out of what, and how much is not — a reader who sees "384
  // shown" should not have to guess whether the rest is filtered or missing
  const total = S.GRAPH.nodes.length;
  const el = document.getElementById('stats');
  el.textContent =
    (S.focusSet ? t('chrome.focusPrefix') + ' ' : '')
    + t('chrome.shownOf').replace('{n}', shown).replace('{t}', total).replace('{hidden}', Math.max(0, total - shown))
    + (S.scope !== 'all' ? ' · ' + t('chrome.scopePrefix') + ' ' + scopeLabel() : '');
  // …and *why* it is not: the tip splits the hidden number by reason, and the
  // reasons add up to it (the exemplar of a number tip with a breakdown)
  const b = statsBreakdown();
  setTip(el, { number: {
    count: shown, of: 'chrome.shownOf', vars: { t: total, hidden: Math.max(0, total - shown) },
    scope: 'tip.stats.scope', source: tipSource('/graph'),
    breakdown: { rows: [
      ['tip.stats.shown', shown],
      ...[['tip.stats.grouped', b.grouped], ['tip.stats.guards', b.guards], ['tip.stats.outOfScope', b.outOfScope],
        ['tip.stats.outOfFocus', b.outOfFocus], ['tip.stats.files', b.files], ['tip.stats.packages', b.packages],
        ['tip.stats.filtered', b.filtered], ['tip.stats.noLane', b.noLane]].filter((r) => r[1] > 0),
      ['tip.stats.total', total],
    ] },
  } });
}
/**
 * Why each thing the graph holds is, or is not, a card on the map — the same
 * filters `displayNodes()` applies, counted instead of applied. Every node
 * lands in exactly one bucket, so `shown + grouped + guards + outOfScope +
 * outOfFocus + files + packages + filtered + noLane` is the graph's total
 * (files: drawn only with *show files*; packages: *hide packages*; filtered: a
 * code map filter or view — surfaces/codemap-projects.js `cmapHide`).
 * @group Graph rendering
 */
export function statsBreakdown() {
  const out = { guards: 0, outOfScope: 0, outOfFocus: 0, files: 0, packages: 0, filtered: 0, grouped: 0, noLane: 0 };
  if (!S.GRAPH) return out;
  // one pass, O(1) per node: each node lands in its bucket, and a node that is drawn folds into its file group
  const repos = scopedRepos();
  const groups = {};
  const items = [];
  for (const n of S.GRAPH.nodes) {
    if (repos && !repos.has(repoOf(n))) { out.outOfScope++; continue; }
    if (n.kind === 'guard') { out.guards++; continue; }
    if (S.focusSet && !S.focusSet.has(n.id)) { out.outOfFocus++; continue; }
    const why = cmapHide(n);
    if (why) { out[why]++; continue; }
    const g = effectiveGroup(n);
    if (g) {
      if (!groups[g.key]) { groups[g.key] = { kind: 'group', laneKind: g.laneKind, members: 0 }; items.push(groups[g.key]); }
      groups[g.key].members++;
    } else items.push(n);
  }
  for (const it of items) {
    if (laneOf(it) < 0) out.noLane += it.kind === 'group' ? it.members : 1;
    else if (it.kind === 'group') out.grouped += it.members - 1;
  }
  return out;
}
/**
 * Recompute the footer's shown/hidden count without redrawing the map.
 *
 * That count is global chrome — the status bar is drawn on every surface — but
 * it is fed by the map's display list, so it moves when the scope moves no
 * matter which surface is open. The Code map's own refresh recomputes it on the
 * way through `render()`; every other surface asks for it here rather than
 * redrawing a map nobody is looking at.
 * @group Graph rendering
 */
export function refreshStats() {
  if (!S.GRAPH) return;
  updateStats(displayNodes().length);
}
/** @group Graph rendering */
export function scopeLabel() {
  if (S.scope === 'all' || !S.scope.length) return 'all';
  const match = (S.SETTINGS.collections || []).find((c) => {
    const names = collSourceNames(c);
    return names.length === S.scope.length && names.every((n) => S.scope.includes(n));
  });
  if (match) return match.name;
  return S.scope.length === 1 ? S.scope[0] : S.scope.length + ' sources';
}

/**
 * The card a node is seen on. A gate is drawn as a badge on what it guards,
 * never as a card of its own, so selecting one shows the card it sits on —
 * the first thing it guards — while the inspector stays on the gate itself.
 * Fast travel used to *replace* the pick with that card, so a reader who
 * picked a gate arrived on a route handler named `Post` and asked what uses
 * that (story swarm 2026-09-25).
 * @group Inspector
 */
export function cardOf(id) {
  const n = S.BYID[id];
  if (!n || n.kind !== 'guard') return id;
  // every card asks while one gate is selected: answer the scan once per gate and graph
  if (CARD_OF.id === id && CARD_OF.graph === S.GRAPH) return CARD_OF.card;
  const e = (S.GRAPH.edges || []).find((x) => x.kind === 'guards' && x.from === id && S.BYID[x.to] && S.BYID[x.to].kind !== 'guard');
  Object.assign(CARD_OF, { id, graph: S.GRAPH, card: e ? e.to : id });
  return CARD_OF.card;
}
const CARD_OF = { id: null, graph: null, card: null };

// ── inspector ───────────────────────────────────────────────────
/**
 * @group Inspector
 * @business The detail sidebar: what a thing is, its rules, data access, and source.
 */
export function select(id) {
  S.selected = id; render();
  const n = (S.displayById && S.displayById.get(id)) || S.BYID[id];
  if (!n) return;
  const insp = document.getElementById('inspector');
  if (n.kind === 'group') {
    const key = groupKeyOfDisplay(n);
    insp.innerHTML = '<div class="insp-head"><span class="kind k-group hud-label"' + kindTip('group') + '>' + esc(kindWord('group')) + ' · ' + esc(repoOf(n)) + '</span>'
      + '<h2>' + esc(groupWords(n.name)) + '</h2><div class="codename">' + esc(n.codename) + '</div>'
      + '<div class="rd"><span' + membersTip(n) + '>' + esc(t(n.members.length === 1 ? 'surf.membersOne' : 'surf.members').replace('{n}', n.members.length)) + '</span></div></div>'
      + '<div class="actions"><button class="btn primary" onclick="toggleGroup(' + jsArg(key) + ')">' + (n.expanded ? '⊖ Collapse' : '⊕ Expand') + '</button>'
      + '<button class="btn" onclick="focusOn(' + jsArg(n.members[0].id) + ')">◎ Focus</button></div>'
      + '<div class="insp-sec"><span class="hud-label">What this group does</span>'
      + '<p>' + esc(n.members.map((m) => m.docs || (m.facets && m.facets.business && m.facets.business.description) || '').filter(Boolean).slice(0, 3).map((d) => d.split(/[.!?]\s/)[0]).join('. ') || 'No docs found — add JSDoc to the members.') + '.</p></div>'
      + '<div class="insp-sec"><span class="hud-label">Members</span>'
      + n.members.map((m) => '<button class="rel" onclick="expandAndSelect(' + jsArg(groupKeyOfDisplay(n)) + ',' + jsArg(m.id) + ')"><span class="rk">' + esc(kindWord(m.kind)) + '</span>' + esc(bizName(m))
        + (biz() ? '' : ' <span style="font-family:var(--mono);font-size:10px;color:var(--dim)">' + esc(m.name) + '</span>') + '</button>').join('') + '</div>';
    return;
  }
  const guards = S.guardsByTarget[n.id] || [];
  const validates = (S.validatesByTarget[n.id] || []).map((e) => S.BYID[e.from]).filter(Boolean);
  // the edges touching this node, in graph order, from the index (store.js indexGuards) — never a scan of every edge
  const touching = S.EDGES_OF.get(n.id) || [];
  const dataEdges = touching.filter((e) => e.kind === 'reads' || e.kind === 'writes');
  const business = biz();
  // a gate's own inspector lists what it protects: those edges are the only ones it has
  const relEdges = touching.filter((e) => (e.kind !== 'guards' || (n.kind === 'guard' && e.from === n.id)) && e.kind !== 'validates' && e.kind !== 'reads' && e.kind !== 'writes');
  const rels = relEdges.map((e) => {
    const otherId = e.from === n.id ? e.to : e.from;
    const other = S.BYID[otherId] || S.GRAPH.nodes.find((x) => x.id === otherId);
    const dir = e.from === n.id ? '→' : '←';
    // the edge's kind is the graph's word; the business lens says which way it points
    const rk = business ? t(e.kind === 'guards' ? 'surf.rel.guards' : e.from === n.id ? 'surf.rel.uses' : 'surf.rel.usedBy') : e.kind + ' ' + dir;
    return other ? '<button class="rel" onclick="select(' + jsArg(otherId) + ')"><span class="rk">' + esc(rk) + '</span>' + esc(bizName(other)) + '</button>' : '';
  }).join('');
  const bizText = (n.facets && n.facets.business && n.facets.business.description) || (n.docs ? n.docs.split(/[.!?]\s/)[0] : '');
  const lens = currentLens();
  const href = vscodeHref(n);
  // each section's count, with what it counts and how it splits by kind
  const byKind = (edges) => {
    const by = {};
    edges.forEach((e) => { const k = business ? t(e.kind === 'guards' ? 'surf.rel.guards' : e.from === n.id ? 'surf.rel.uses' : 'surf.rel.usedBy') : e.kind + (e.from === n.id ? ' →' : ' ←'); by[k] = (by[k] || 0) + 1; });
    return Object.entries(by).sort((a, b) => b[1] - a[1]);
  };
  const secCount = (list, of) => ' · <span class="cnt"' + plainTip(list.length, of, 'count.scope.node', '/graph', byKind(list)) + '>' + list.length + '</span>';
  const gateCount = (guards.length + validates.length)
    ? ' · <span class="cnt"' + plainTip(guards.length + validates.length, 'surf.gatesRules', 'count.scope.node', '/graph',
      [[t('count.part.guards').replace('{n}', '').trim(), guards.length], [t('count.part.rules').replace('{n}', '').trim(), validates.length]]) + '>' + (guards.length + validates.length) + '</span>' : '';
  insp.innerHTML =
    '<div class="insp-head"><span class="kind k-' + n.kind + ' hud-label" style="color:inherit"' + kindTip(n.kind) + '>' + esc(kindWord(n.kind)) + ' · ' + esc(repoOf(n)) + '</span>'
    + '<h2>' + esc(bizName(n)) + '</h2><div class="codename">' + esc(n.name) + (n.signature ? '' : '') + '</div>'
    + (n.loc ? '<div class="path">' + esc(n.loc.path) + ':' + n.loc.line + vsl(repoOf(n), n.loc.path, n.loc.line) + '</div>' : '') + '</div>'
    + '<div class="actions"><button class="btn primary" onclick="focusOn(' + jsArg(n.id) + ')">◎ Focus</button>'
    + (['function', 'component', 'route', 'page'].includes(n.kind) && n.loc ? '<button class="btn" onclick="openJourney(' + jsArg(n.id) + ')">▶ Journey</button>' : '')
    + (n.kind === 'api' ? '<a class="btn" style="text-decoration:none;display:flex;align-items:center;justify-content:center;gap:5px" href="#/apis/' + encodeURIComponent(n.id) + '">' + sym('api') + ' ' + esc(t('nav.apis')) + '</a>' : '')
    + (n.contract ? '<a class="btn" style="text-decoration:none;display:flex;align-items:center;justify-content:center;gap:5px" href="#/apis/' + encodeURIComponent(n.contract.apiId) + '?op=' + encodeURIComponent(n.id) + '">' + sym('api') + ' ' + esc(t('apis.contractLink')) + '</a>' : '')
    + '<button class="btn" onclick="openImpact(' + jsArg(n.id) + ')"' + tipAttrs({ key: 'surf.insp.impact', noFocus: true }) + '>' + sym('fork') + ' ' + esc(t('surf.insp.impactBtn')) + '</button>'
    + packageActionsHtml(n)
    // the editor is a developer's door; the business lens has no use for it
    + (href && !business ? '<a class="btn" style="text-decoration:none;display:flex;align-items:center;justify-content:center;gap:5px" href="' + esc(href) + '">' + sym('open') + ' VS Code</a>' : '') + '</div>'
    + (bizText ? '<div class="insp-sec"><span class="hud-label">' + esc(t('surf.insp.summary')) + '</span><p>' + esc(business ? unCode(bizText) : bizText) + '</p></div>' : '')
    + projectSecHtml(n)
    + packageSecHtml(n)
    + storiesSecHtml(n)
    + (n.design ? designSecHtml(n) : '')
    + (n.contract ? contractSecHtml(n) : '')
    + (n.docs && !business ? '<div class="insp-sec"><span class="hud-label">' + esc(t('surf.insp.docs')) + '</span><p>' + esc(n.docs) + '</p></div>' : '')
    + linksSecHtml(n)
    // the work items a tracker links to this part: filled when /api/work/links answers, nothing when none
    + nodeWorkSecHtml(n)
    + ((guards.length || validates.length) ? '<div class="insp-sec"><span class="hud-label">' + esc(t('surf.insp.gates')) + gateCount + '</span>'
      + guards.map((g) => '<div class="rulecard auth">' + sym('lock') + ' ' + esc(business ? bizName(g) : g.name) + (g.loc && !business ? '<div class="rd">' + esc(g.loc.path) + ':' + g.loc.line + vsl(repoOf(g), g.loc.path, g.loc.line) + '</div>' : '') + '</div>').join('')
      + validates.map((v) => '<div class="rulecard">' + sym('shield') + ' ' + esc(business ? bizName(v) : v.name) + (v.signature && !business ? '<div class="rd">' + esc(v.signature.slice(0, 90)) + '…</div>' : '') + (v.loc && !business ? '<div class="rd">' + esc(v.loc.path) + ':' + v.loc.line + vsl(repoOf(v), v.loc.path, v.loc.line) + '</div>' : '') + '</div>').join('') + '</div>' : '')
    + (dataEdges.length ? '<div class="insp-sec"><span class="hud-label">' + esc(t('surf.insp.data')) + secCount(dataEdges, 'surf.insp.dataCount') + '</span>'
      + dataEdges.map((e) => {
        const me = e.from === n.id, other = S.BYID[me ? e.to : e.from];
        const rk = business ? t(e.kind === 'writes' ? (me ? 'surf.rel.writes' : 'surf.rel.writtenBy') : (me ? 'surf.rel.reads' : 'surf.rel.readBy')) : e.kind + (me ? ' →' : ' ←');
        return '<button class="rel" onclick="select(' + jsArg(me ? e.to : e.from) + ')"><span class="rk">' + esc(rk) + '</span>' + esc(other ? (business ? bizName(other) : other.name) : '')
          + (e.meta && e.meta.code && !business ? '<span class="qcode">' + esc(e.meta.code) + '</span>' : '') + '</button>';
      }).join('') + '</div>' : '')
    + (n.snippet && lens !== 'business' ? '<div class="insp-sec"><span class="hud-label">Source (truth)</span><div class="code snippet">' + esc(n.snippet) + '</div></div>' : '')
    + (n.signature && !n.snippet && lens !== 'business' ? '<div class="insp-sec"><span class="hud-label">Definition</span><div class="code">' + esc(n.signature) + '</div></div>' : '')
    // tags are the code's own labels (`runner:vitest`, `test:unit`): not the business lens's words
    + ((n.tags || []).length && !business ? '<div class="insp-sec"><span class="hud-label">' + esc(t('surf.insp.tags')) + '</span><div class="tagrow">' + n.tags.map((x) => '<span class="tag' + (x === 'deprecated' ? ' tag-deprecated' : '') + '">' + esc(x) + '</span>').join('') + '</div></div>' : '')
    + (rels ? '<div class="insp-sec"><span class="hud-label">' + esc(t('surf.insp.connections')) + secCount(relEdges, 'surf.insp.connCount') + '</span>' + rels + '</div>' : '');
}
/**
 * Inspector section for a route's API contract: status in words, drift, the
 * spec line ⧉, and the link into the APIs surface. Facts come from the node;
 * nothing is computed here.
 * @group Inspector
 */
export function contractSecHtml(n) {
  const c = n.contract;
  const statusKey = c.status === 'both' ? 'apis.status.both' : c.status === 'spec-only' ? 'apis.status.specOnly' : c.status === 'declared' ? 'apis.status.declared' : 'apis.status.codeOnly';
  const cls = c.status === 'both' ? 'ok' : c.status === 'spec-only' ? 'stub' : c.status === 'declared' ? '' : 'warn';
  return '<div class="insp-sec"><span class="hud-label">' + esc(t('apis.contractLink')) + '</span>'
    + '<div class="tagrow" style="margin-bottom:6px"><span class="api-chip ' + cls + '">' + esc(t(statusKey)) + '</span>'
    + (c.deprecated ? '<span class="api-chip warn">' + esc(t('apis.chip.deprecated')) + '</span>' : '') + '</div>'
    + (c.summary && c.summary !== bizLabel(n) ? '<p>' + esc(biz() ? unCode(c.summary) : c.summary) + '</p>' : '')
    + (c.spec && !biz() ? '<div class="rd" style="font-family:var(--mono);font-size:9.5px;color:var(--dim)">' + esc(c.spec.path) + (c.spec.line != null ? ':' + c.spec.line + (/^https?:/.test(c.spec.path) ? '' : vsl(repoOf(n), c.spec.path, c.spec.line)) : '') + '</div>' : '')
    + (c.drift || []).filter((d) => d.kind !== 'spec-only' && d.kind !== 'code-only').map((d) => '<div class="api-drift" style="margin-top:6px">' + sym('warning') + '<div><b>' + esc(t('apis.drift.' + d.kind)) + '</b>' + esc(biz() ? unCode(d.message) : d.message) + '</div></div>').join('')
    + '</div>';
}
/**
 * External anchor for a harvested link (`@see <url>`, a design deep link):
 * the ⧉ glyph + the URL's host, opening in a new tab. Text of the URL is
 * untrusted display data → esc(); only http(s) targets render.
 * @group Inspector
 */
export function linkHtml(url, label) {
  if (!/^https?:\/\//i.test(url || '')) return '';
  let host = url;
  try { host = new URL(url).host; } catch (e) { /* keep the raw text */ }
  return '<a class="ext" href="' + esc(url) + '" target="_blank" rel="noopener" title="' + esc(url) + '">' + sym('open') + ' ' + esc(label || host) + '</a>';
}
/**
 * Inspector section listing the node's `@see` links as anchors (design links
 * render in their own section). Nothing when the node has none.
 * @group Inspector
 */
export function linksSecHtml(n) {
  const sees = (n.links || []).filter((l) => l && l.kind === 'see');
  if (!sees.length) return '';
  return '<div class="insp-sec"><span class="hud-label">' + esc(t('insp.links')) + '</span>'
    + sees.map((l) => l.url ? '<div class="rd">' + linkHtml(l.url) + '</div>' : '<div class="rd">' + esc(l.ref || '') + '</div>').join('') + '</div>';
}
/**
 * Inspector section for a screen's design reference: status in words
 * (designed + built / designed, not built / built, not designed), the docs'
 * id and name, freshness with its origin, the operations the design says it
 * uses, drift, and the ⧉ deep link into the design tool.
 * @group Inspector
 */
export function designSecHtml(n) {
  const d = n.design;
  const statusKey = d.status === 'both' ? 'design.status.both' : d.status === 'design-only' ? 'design.status.designOnly' : 'design.status.codeOnly';
  const cls = d.status === 'both' ? 'ok' : d.status === 'design-only' ? 'stub' : 'warn';
  // a flow renders its screens in order (graph edges, not the DesignRef) and
  // points at the product docs that specify it
  const screens = n.kind === 'flow'
    ? (S.GRAPH.edges || []).filter((e) => e.kind === 'renders' && e.from === n.id)
      .map((e) => S.GRAPH.nodes.find((x) => x.id === e.to)).filter(Boolean) : [];
  const docs = n.kind === 'flow' ? (n.links || []).filter((l) => l && l.kind === 'doc') : [];
  return '<div class="insp-sec"><span class="hud-label">' + esc(t('insp.design')) + '</span>'
    + designThumbHtml(n, 'insp')
    + '<div class="tagrow" style="margin-bottom:6px"><span class="api-chip ' + cls + '">' + esc(t(statusKey)) + '</span>'
    + (d.phase ? '<span class="api-chip">' + esc(t('design.phase')) + ' ' + esc(d.phase) + '</span>' : '') + '</div>'
    // a document id (SCR-07) is the docs' handle on the screen; the business lens reads its name
    + ((d.id || d.name) ? '<p>' + esc([biz() ? '' : d.id, d.name].filter(Boolean).join(' · ')) + '</p>' : '')
    + (d.lastModified ? '<div class="rd">' + esc(t('design.modified')) + ' ' + esc(d.lastModified) + ' · ' + esc(d.freshness === 'figma' ? t('design.freshFigma') : t('design.freshManifest')) + '</div>' : '')
    + (d.operations && d.operations.length ? '<div class="rd">' + esc(t('design.uses')) + ' ' + esc(biz() ? d.operations.map(unCode).join(', ') : d.operations.join(', ')) + '</div>' : '')
    + (screens.length ? '<div class="rd" style="margin-top:6px">' + esc(t('design.flowScreens')) + '</div>'
      + screens.map((s, i) => '<button class="rel" onclick="select(' + jsArg(s.id) + ')"><span class="rk">' + (i + 1) + '</span>' + esc(bizLabel(s)) + '</button>').join('') : '')
    + (docs.length ? '<div class="rd" style="margin-top:6px">' + esc(t('design.docs')) + ' '
      + docs.map((l) => l.url ? linkHtml(l.url) : (esc(String(l.ref || '').split('/').pop()) + vsl(repoOf(n), l.ref, 1))).join(' ') + '</div>' : '')
    + (d.drift || []).map((x) => '<div class="api-drift" style="margin-top:6px">' + sym('warning') + '<div><b>' + esc(t('design.drift.' + x.kind)) + '</b>' + esc(biz() ? unCode(x.message) : x.message) + '</div></div>').join('')
    + (d.url ? '<div class="rd" style="margin-top:6px">' + linkHtml(d.url, t('insp.designOpen')) + '</div>' : '')
    + '</div>';
}

// ── design references (docs/proposals/design-source.md) ─────────
/** Screens whose design reference is on screen, keyed by node id — the
 *  lightbox is opened from an inline onclick, which can only carry an id.
 *  @group Inspector */
const DESIGN_REFS = {};

/**
 * Design chip row for a screen's DesignRef: the drawn design glyph with the
 * status in words, the id the docs use ("INV-01"), and freshness with its
 * origin and date. Shared by the inspector, the journey screen band and the
 * lightbox so one screen reads the same wherever it appears.
 * @group Inspector
 */
export function designChipHtml(d) {
  if (!d) return '';
  const statusKey = d.status === 'both' ? 'design.status.both' : d.status === 'design-only' ? 'design.status.designOnly' : 'design.status.codeOnly';
  const cls = d.status === 'both' ? 'ok' : d.status === 'design-only' ? 'stub' : 'warn';
  const fresh = d.freshness === 'figma' ? t('design.freshFigma') : t('design.freshManifest');
  return '<span class="api-chip ' + cls + '">' + sym('design') + esc(t(statusKey)) + (d.id ? ' · ' + esc(d.id) : '') + '</span>'
    + (d.lastModified ? '<span class="api-chip">' + esc(fresh) + ' · ' + esc(String(d.lastModified).slice(0, 10)) + '</span>' : '');
}
/**
 * Thumbnail of the screen as it was designed — the manifest's image or a
 * Figma render, served by /api/design/image. `cls` sizes it for the surface
 * ('lg' business band, 'insp' inspector, none = the 200px default); the code
 * lens hides it in CSS. Nothing renders when the reference carries no image,
 * and when the bytes don't resolve the image hides itself and the deep link
 * takes its place — never a broken-image icon.
 * @group Inspector
 */
export function designThumbHtml(n, cls) {
  const d = n && n.design;
  if (!d || !n.id) return '';
  // the design declares no render at all: an empty slot would read as "no design",
  // so the slot says what is true — this is outside what Farsight indexed
  if (!d.image) {
    return '<div class="dsg-thumb none' + (cls ? ' ' + cls : '') + '" title="' + esc(t('journey.absent.notIndexed')) + '">'
      + '<div class="dsg-thumb-fail">' + sym('design') + '<span class="w">' + esc(t('journey.absent.notIndexed')) + '</span>'
      + (d.url ? '<br>' + linkHtml(d.url, t('insp.designOpen')) : '') + '</div></div>';
  }
  DESIGN_REFS[n.id] = n;
  return '<div class="dsg-thumb' + (cls ? ' ' + cls : '') + '" onclick="event.stopPropagation();openDesignLightbox(' + jsArg(n.id) + ')" title="' + esc(t('insp.designOpen')) + '">'
    + '<img src="/api/design/image?node=' + encodeURIComponent(n.id) + '" alt="' + esc(d.name || bizLabel(n)) + '" onerror="designImgFail(this)"/>'
    + '<div class="dsg-thumb-fail" style="display:none">' + sym('design') + '<span class="w">' + esc(t('design.noImage')) + '</span>'
    + (d.url ? '<br>' + linkHtml(d.url, t('insp.designOpen')) : '') + '</div></div>';
}
/**
 * The design image did not resolve (no bytes on disk, or a Figma frame with
 * no FIGMA_TOKEN): hide it and reveal the honest fallback beside it.
 * @group Inspector
 */
export function designImgFail(img) {
  img.style.display = 'none';
  const box = img.parentElement;
  if (!box) return;
  const fb = box.querySelector('.dsg-thumb-fail,.dsg-lb-fail');
  if (fb) fb.style.display = '';
  if (box.classList.contains('dsg-thumb')) { box.onclick = null; box.removeAttribute('onclick'); box.style.cursor = 'default'; }
}
/**
 * Lightbox for one screen's design: the render at up to 90vw/85vh with the
 * screen's name, its design chip and the deep link. Esc or a click outside
 * closes it; the element is created on demand and removed on close, so the
 * central keymap needs no binding of its own.
 * @group Inspector
 */
export function openDesignLightbox(nodeId) {
  const n = DESIGN_REFS[nodeId];
  if (!n) return;
  const d = n.design || {};
  closeDesignLightbox();
  const el = document.createElement('div');
  el.id = 'dsg-lb'; el.className = 'dsg-lb';
  el.innerHTML = '<div class="dsg-lb-inner" onclick="event.stopPropagation()">'
    + '<div class="dsg-lb-head">' + sym('design') + '<span class="dsg-lb-name">' + esc(d.name || bizLabel(n)) + '</span>'
    + designChipHtml(d) + (d.url ? linkHtml(d.url, t('insp.designOpen')) : '')
    + '<button class="x" onclick="closeDesignLightbox()" aria-label="' + esc(t('design.lightboxClose')) + '" title="' + esc(t('design.lightboxClose')) + '">✕</button></div>'
    + '<img src="/api/design/image?node=' + encodeURIComponent(n.id) + '" alt="' + esc(d.name || bizLabel(n)) + '" onerror="designImgFail(this)"/>'
    + '<div class="dsg-lb-fail" style="display:none">' + esc(t('design.noImage')) + '</div></div>';
  el.onclick = closeDesignLightbox;
  document.body.appendChild(el);
  document.addEventListener('keydown', designLightboxKey, true);
}
/** Esc closes the lightbox before the central keymap sees the key (capture).
 *  @group Inspector */
function designLightboxKey(e) {
  if (e.key !== 'Escape') return;
  e.stopPropagation(); e.preventDefault();
  closeDesignLightbox();
}
/** Tear the lightbox down and drop its key listener.
 *  @group Inspector */
export function closeDesignLightbox() {
  const el = document.getElementById('dsg-lb');
  if (el) el.remove();
  document.removeEventListener('keydown', designLightboxKey, true);
}
/**
 * @group Inspector
 */
export function expandAndSelect(key, id) { S.expandedGroups.add(key); S.selected = id; render(); select(id); }

expose({ select, expandAndSelect, toggleGroup, ctxDo, closeCtx, openCtx, openDesignLightbox, closeDesignLightbox, designImgFail });
