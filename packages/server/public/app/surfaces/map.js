// surfaces/map.js — the MAP surface (#/map): every journey on one zoomable board.
//
// docs/proposals/map-view.md is the brief; prototypes/map-view/ the agreed look.
// Three altitudes of one continuous board, the way Miro or Figma draw one:
//
//   #/map                               the neighbourhood — every journey as a district
//   #/map/<flowNodeId>                  the street — that journey's screens in step order
//   #/map/<flowNodeId>?node=<pageId>    the property — one screen up close (lane B's view)
//   …?plumb=1                           the street with its calls and data shown
//
// Behind the `flags.map` workspace flag (Settings → Experiments). The board reads
// what the server already answers — `/api/design` flows for the districts and one
// `/api/journey` per journey, fetched lazily one at a time under a generation and
// cached per sync — and never writes `S.JOURNEY` (the journey overlay's helpers read
// that global; the map keeps its own `MAP` state). The pan/zoom engine is
// `lib/map-canvas.js`, the data shapes `lib/map-model.js`, and the property is
// `surfaces/map-property.js`, reached through `openMapProperty(host, ctx)`.

import { S, esc, expose, currentLens, humanize, bizName, unCode } from '../store.js';
import { t, def, plainWords } from '../strings.js';
import { sym } from '../sym.js';
import { designThumbHtml } from '../lib/graph-render.js';
import { countedHtml, plainTip } from '../lib/counted.js';
import { tipAttrs, TIP_SELECTOR, hideTip } from '../lib/tooltip.js';
import { withParams } from '../lib/route-url.js';
import { flowWork, flowChipHtml } from '../work-chips.js';
import { neighbourhoodModel, streetModel, screensUsing, layoutDistricts, storesOf, MODE_ORDER } from '../lib/map-model.js';
import { attachCanvas, LEVEL_NB, MAX_SCALE, SNAP_COVER } from '../lib/map-canvas.js';
import { parseRoute } from '../shell.js';
import { shareLink } from '../share.js';

// ── geometry (world units) — the prototype's, so the agreed look carries over ──
const SW = 260, SH = 214, COL = 480, HEAD = 118, SY = HEAD + 36, PAD = 60;
const PL_TOP = SY + SH + 76, OPW = 200, DX = 230, DW = 210, ROW = 40, OPMIN = 68, OPGAP = 16;
/** The folds (map-view.md, street fold): a call draws its first DATA_SHOWN data nodes, a screen its first CALLS_SHOWN
 * calls; the rest fold into one row — but only when that saves a row (a fold row standing in for one node does not). */
const DATA_SHOWN = 3, CALLS_SHOWN = 4, FOLD_H = 34;
const DMIN = 880;
/** Where a street lands when it is entered or left: a district fits, never above this. */
const STREET_FIT_MAX = 0.95;
/** …and never below this: under LEVEL_NB the board draws covers, so a journey stop below it would not be a street. */
const STREET_FIT_MIN = LEVEL_NB + 0.02;
/** Screen px kept clear around a framed journey. */
const FRAME_PAD = 24;
/** The size, in px on screen, a data node's name reads at from the calls stop on. */
const READ_PX = 11;
/** The enter stop puts a screen at this share of the stage's height — a little over the engine's SNAP_COVER, so it arms. */
const ENTER_COVER = SNAP_COVER + 0.04;
/** Leaving a property lands on the street at this scale, centred on the screen. */
const STREET_SCALE = 1.0;
const PLUMB_KEY = 'fs-map-plumb';

/** The surface's own state. Nothing here is shared with the journey overlay. */
const MAP = {
  gen: 0,
  el: null, stage: null, board: null, world: null, links: null, cv: null,
  designs: null, failed: false,
  nb: { districts: [] },
  /** flow node id → { data, model } | { error: true } */
  journeys: new Map(),
  /** flow node id → { x, y, w, h } */
  geom: new Map(),
  size: { w: 0, h: 0 },
  plumb: false,
  focus: null,                      // the journey the street is on
  autoFit: null,                    // a street entered from the route, refitted when its walk lands — until the reader moves
  prop: null,                       // { flow, index, host, handle }
  card: null,                       // { kind, nodeId, flow, el }
  fitted: false,
  route: null,
  /** the folds the reader opened while the board is mounted: `calls|<flow>|<si>`, `data|<flow>|<si>|<ci>` */
  open: new Set(),
};

/** Per-sync cache of journey answers, keyed `flowId@sync` — a register flip never refetches. */
const JOURNEY_CACHE = new Map();
function syncKey() { return (S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.sync) || ''; }
function fetchJourney(flowId) {
  const key = flowId + '@' + syncKey();
  if (!JOURNEY_CACHE.has(key)) {
    JOURNEY_CACHE.set(key, fetch('/api/journey?entry=' + encodeURIComponent(flowId))
      .then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return JOURNEY_CACHE.get(key);
}

/** Whether the workspace turned the map on. Off: no tab, no Portfolio button, `#/map` reads as `#/portfolio`. */
export function mapEnabled() {
  const f = S.SETTINGS && S.SETTINGS.flags;
  return !!(f && f.map);
}
const biz = () => currentLens() === 'business';

// ── words in the lens on screen ───────────────────────────────────────────
/** A name somebody wrote; in the business lens a name that is code is said in words. */
function nameWords(s) {
  const v = String(s || '');
  return biz() && /[a-z][A-Z]|_|\/|\.[a-z]{2,4}\b/.test(v) ? unCode(v) : v;
}
/** A sentence somebody wrote; the business lens reads its plain words only. */
function sentence(s) { return biz() ? plainWords(s) : String(s || ''); }
/** A call's name in the lens: the words written for it, never its identifier in the business lens. */
function callWords(c) {
  if (!biz()) return c.label || (c.method + ' ' + c.path).trim();
  return plainWords(c.business) || plainWords(c.label) || plainWords(c.summary) || t('journey.biz.noWords');
}
/** A record, message or third party in words: the label a person gave it, else its name said as words. */
function dataWords(d) {
  const n = d.node || { name: d.name, kind: d.kind };
  const own = (n.facets && n.facets.business && n.facets.business.label) || n.bizLabel;
  if (own) return bizName(n);
  // a third party's name is the product's own (Example ERP): said as written unless it is code-shaped
  if (d.kind === 'external' && !/[a-z][A-Z]|_|\/|\.[a-z]/.test(String(d.name || ''))) return String(d.name);
  return humanize(String(d.name || '').replace(/\./g, ' '));
}
function kindWord(kind) {
  return t(kind === 'record' ? 'map.kind.record' : kind === 'message' ? 'map.kind.message' : kind === 'external' ? 'map.kind.external' : 'map.kind.call');
}
function modeKey(mode) {
  return mode === 'both' ? 'map.lane.both' : mode === 'read' ? 'map.lane.reads' : mode === 'reached' ? 'map.mode.reached' : 'map.lane.writes';
}
function modeWord(mode) { return t(modeKey(mode)); }
/** The kinds of store the map colours; anything else is drawn as `other`. */
const STORE_KINDS = ['sql', 'document', 'files', 'erp', 'other'];
function storeKind(st) { return st && STORE_KINDS.includes(st.kind) ? st.kind : 'other'; }
function storeKindKey(st) { return 'map.store.kind.' + storeKind(st); }
/**
 * A data node's kind line, in words: the store it lives in with what it is there — `Invoice DB · record` for a
 * record, `Example ERP · ERP` for an outside system used as a store — else the plain kind word. A store's name is
 * a product name or a word somebody wrote in the settings, so every register prints it.
 */
function dataKindWords(dd) {
  if (!dd.store) return kindWord(dd.kind);
  return dd.store.name + ' · ' + (dd.kind === 'record' ? kindWord('record') : t(storeKindKey(dd.store)));
}
function evKey(ev) {
  return ev === 'spec-backed' ? 'map.ev.specBacked' : ev === 'implied' ? 'map.ev.implied' : ev === 'declared' ? 'map.ev.declared' : 'journey.absent.notBuilt';
}
const ghost = (c) => c.evidence === 'not built' || c.evidence === 'declared';

// ── mount · refresh · unmount ─────────────────────────────────────────────
/**
 * Mount the board and start reading the journeys.
 * @group Map
 * @business Every journey of the application on one board you can zoom: all of them side by side, one journey's screens in order, one screen up close.
 */
export function mountMap(route, el) {
  MAP.el = el;
  MAP.route = route;
  MAP.plumb = route && /(?:^|[?&])plumb=1(?:&|$)/.test(String(route.raw || '')) ? true : readPlumb();
  MAP.fitted = false;
  el.innerHTML = stageHtml();
  MAP.stage = el.querySelector('.map-stage');
  MAP.board = el.querySelector('.map-board');
  MAP.world = el.querySelector('.map-world');
  MAP.links = el.querySelector('.map-links');
  MAP.world.classList.toggle('no-plumb', !MAP.plumb);
  MAP.cv = attachCanvas(MAP.board, MAP.world, {
    onChange: onCanvasChange,
    stops: mapStops,
    max: () => Math.max(MAX_SCALE, enterScale() * 1.25),
    // zoom-to-enter arms only past the calls stop, on the journey the street is on
    armFrom: () => callsScale(),
    snapTargets: () => (MAP.prop || !MAP.focus ? [] : [...MAP.world.querySelectorAll('.map-scr[data-flow="' + cssAttr(MAP.focus) + '"]')]),
    onArm: onArm,
    onSnap: (scr) => openScreenEl(scr),
    onGestureEnd: () => { MAP.autoFit = null; syncHashToBoard(); },
    // the rest of a pinch out that just left a screen does not keep zooming the street
    holdWheel: () => Date.now() < (MAP.holdWheelUntil || 0),
  });
  // the board starts under the chrome row, so nothing draws beneath the toolbar
  const chrome = MAP.stage.querySelector('.map-chrome');
  if (typeof ResizeObserver === 'function') {
    MAP.chromeRO = new ResizeObserver(() => { if (MAP.stage) MAP.stage.style.setProperty('--map-chrome-h', chrome.offsetHeight + 'px'); });
    MAP.chromeRO.observe(chrome);
  }
  MAP.stage.style.setProperty('--map-chrome-h', chrome.offsetHeight + 'px');
  MAP.stage.addEventListener('click', onEdgeClick);
  MAP.board.addEventListener('click', onBoardClick);
  MAP.board.addEventListener('keydown', onBoardKey);
  MAP.board.addEventListener('pointerover', onDistrictHot);
  MAP.board.addEventListener('focusin', onDistrictHot);
  MAP.board.addEventListener('focusin', onBoardFocus);
  // the board clips the world; a focus the browser scrolls into view would slide the clip, so the canvas moves instead
  for (const el of [MAP.board, MAP.stage]) el.addEventListener('scroll', () => { el.scrollTop = 0; el.scrollLeft = 0; });
  MAP.tabState = null;
  MAP.board.addEventListener('pointerleave', () => { MAP.hot = null; linkVisibility(); });
  MAP.stage.querySelector('.map-chrome').addEventListener('click', onChromeClick);
  const host = MAP.stage.querySelector('.map-prop-host');
  host.addEventListener('wheel', onPropWheel, { passive: false });
  host.addEventListener('pointerdown', onPropPointer);
  host.addEventListener('pointermove', onPropPointer);
  host.addEventListener('pointerup', onPropPointer);
  host.addEventListener('pointercancel', onPropPointer);
  window.addEventListener('resize', onResize);
  document.addEventListener('fullscreenchange', onFullscreen);
  document.addEventListener('click', onDocClick, true);
  start();
}

/**
 * Redraw after the lens, the register, the scope or a sync moved. Words only
 * (lens · register) redraw from what is in hand and keep the board where it is;
 * facts (scope · sync) ask again from the top.
 * @group Map
 */
export function mapRefresh(reason) {
  if (!MAP.el || !MAP.world) return;
  if (reason === 'lens' || reason === 'register') {
    redrawChrome();
    renderAll();
    if (MAP.card) reopenCard();
    if (MAP.prop && MAP.prop.handle && MAP.prop.handle.update) MAP.prop.handle.update(propCtx());
    return;
  }
  // a new graph: the cached walks describe the old one
  if (reason === 'sync') JOURNEY_CACHE.clear();
  closeCard();
  closeProperty({ keepHash: true });
  start();
}

/**
 * The route moved inside the surface — a link to another journey, a screen
 * opened from a shared link, the back button. The board stays; only what the
 * route names changes.
 * @group Map
 */
export function mapUpdate(route) {
  MAP.route = route;
  if (/(?:^|[?&])plumb=1(?:&|$)/.test(String(route.raw || ''))) setPlumb(true);
  applyRouteTarget(route, true);
}

/** Leave: stop every listener, every fetch's effect and the property. @group Map */
export function unmountMap() {
  MAP.gen++;
  closeCard();
  closeProperty({ keepHash: true });
  if (MAP.cv) MAP.cv.destroy();
  if (MAP.chromeRO) { MAP.chromeRO.disconnect(); MAP.chromeRO = null; }
  window.removeEventListener('resize', onResize);
  document.removeEventListener('fullscreenchange', onFullscreen);
  document.removeEventListener('click', onDocClick, true);
  if (document.fullscreenElement && MAP.stage && MAP.stage.contains(document.fullscreenElement)) document.exitFullscreen().catch(() => {});
  MAP.el = MAP.stage = MAP.board = MAP.world = MAP.links = MAP.cv = null;
}

function readPlumb() {
  try { return localStorage.getItem(PLUMB_KEY) === '1'; } catch { return false; }
}
function writePlumb(v) {
  try { localStorage.setItem(PLUMB_KEY, v ? '1' : '0'); } catch { /* private window: the switch still works for this visit */ }
}

/** Load the districts, then each journey one at a time under one generation. */
function start() {
  const gen = ++MAP.gen;
  MAP.journeys = new Map();
  MAP.open = new Set();
  MAP.designs = null;
  MAP.failed = false;
  renderAll();
  const scope = S.scope === 'all' || !S.scope || !S.scope.length ? 'all' : S.scope.join(',');
  fetch('/api/design?scope=' + encodeURIComponent(scope)).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then((design) => {
    if (gen !== MAP.gen) return;
    const sources = design.designs || design.sources || (Array.isArray(design) ? design : []);
    MAP.designs = Array.isArray(sources) ? sources : [];
    MAP.nb = neighbourhoodModel(MAP.designs, null);
    layout();
    renderAll();
    fillWork(gen);
    applyRouteTarget(MAP.route, false);
    walk(gen);
  }).catch(() => {
    if (gen !== MAP.gen) return;
    MAP.failed = true;
    renderAll();
  });
}

/** Read the journeys in order — the one the route names first — and draw each as it lands. */
async function walk(gen) {
  const want = routeFlow(MAP.route);
  const order = MAP.nb.districts.map((d) => d.id).sort((a, b) => (a === want ? -1 : b === want ? 1 : 0));
  for (const id of order) {
    if (gen !== MAP.gen) return;
    await ensureJourney(id, gen);
  }
}
/** One journey's answer, read once per sync; the district redraws when it lands. */
async function ensureJourney(id, gen = MAP.gen) {
  if (MAP.journeys.has(id)) return MAP.journeys.get(id);
  const data = await fetchJourney(id);
  if (gen !== MAP.gen) return null;
  if (MAP.journeys.has(id)) return MAP.journeys.get(id);
  const entry = data && data.summary ? { data, model: streetModel(data, S.BYID) } : { error: true };
  MAP.journeys.set(id, entry);
  relayoutKeeping(() => renderDistrict(id));
  if (MAP.autoFit === id && !MAP.prop) enterJourney(id, false);
  return entry;
}

/** The work chip of each district, from the per-sync work cache (nothing when no tracker is configured). */
function fillWork(gen) {
  for (const d of MAP.nb.districts) {
    flowWork(d.id).then((resp) => {
      if (gen !== MAP.gen || !resp || !MAP.world) return;
      d.work = resp;
      MAP.world.querySelectorAll('[data-work-for="' + cssAttr(d.id) + '"]').forEach((el) => { el.innerHTML = flowChipHtml(resp); });
      const de = districtEl(d.id);
      if (de) tabDistrict(de);
    });
  }
}
const cssAttr = (s) => String(s).replace(/["\\]/g, '\\$&');

// ── the route ────────────────────────────────────────────────────────────
function decode(s) { try { return decodeURIComponent(s); } catch { return s; } }
function routeFlow(route) { return route && route.param ? decode(route.param) : null; }

/** Go where the route says: a journey's street, or one of its screens. */
async function applyRouteTarget(route, animate) {
  if (!MAP.world || !MAP.designs) return;
  const flow = routeFlow(route);
  const node = route && route.node;
  const view = routeView(route);
  if (!flow) {
    if (MAP.prop) closeProperty({ keepHash: true });
    if (view) applyView(view, null, animate && MAP.fitted);
    else if (!MAP.fitted || animate) fitAll(animate && MAP.fitted);
    MAP.fitted = true;
    return;
  }
  if (!MAP.geom.has(flow)) { fitAll(false); MAP.fitted = true; return; }
  const gen = MAP.gen;
  if (!node) {
    if (MAP.prop) closeProperty({ keepHash: true });
    if (view) {
      // the link names the picture: put the board there, and never refit it when the walk lands
      MAP.autoFit = null;
      MAP.focus = flow;
      applyView(view, flow, animate && MAP.fitted);
    } else {
      MAP.autoFit = MAP.journeys.has(flow) ? null : flow;
      enterJourney(flow, animate && MAP.fitted);
    }
    MAP.fitted = true;
    if (route.card) {
      const j = await ensureJourney(flow);
      if (gen !== MAP.gen || !j || !j.model) return;
      if (!MAP.card || MAP.card.spec !== route.card) restoreCard(flow, route.card);
    } else if (MAP.card) closeCard();
    return;
  }
  const j = await ensureJourney(flow);
  if (gen !== MAP.gen || !j || !j.model) return;
  const index = j.model.screens.findIndex((s) => s.id === node);
  if (index < 0) { enterJourney(flow, false); MAP.fitted = true; return; }
  if (!MAP.fitted) { centreScreen(flow, index, STREET_SCALE, false); MAP.fitted = true; }
  openProperty(flow, index, { fromRoute: true });
}

/**
 * Write what the board shows into the address bar without a navigation — a
 * replace, so zooming does not fill the history, and a copied link opens here.
 */
function writeHash(flow, node) {
  // only while the map is the surface on screen: a card closing as the map unmounts must not rewrite another surface's link
  if (!MAP.stage || !/^#\/map(?:[/?@]|$)/.test(location.hash || '#/map')) return;
  let h = location.hash || '#/map';
  const qi = h.indexOf('?');
  const query = qi >= 0 ? h.slice(qi) : '';
  let base = '#/map' + (flow ? '/' + encodeURIComponent(flow) : '');
  // the link is the picture (§K): where the board is and which card is open, so the same link opens the same view
  const v = node ? null : viewParams(flow);
  h = withParams(base + query, {
    node: node || null, plumb: MAP.plumb ? '1' : null,
    z: v ? v.z : null, x: v ? v.x : null, y: v ? v.y : null,
    card: !node && MAP.card ? MAP.card.spec : null,
  });
  if (h !== location.hash) {
    history.replaceState(null, '', h);
    S.route = parseRoute();
    MAP.route = S.route;
  }
}
/** After a gesture: the hash names the journey the street is on, or none at the neighbourhood. */
function syncHashToBoard() {
  if (!MAP.cv || MAP.prop) return;
  writeHash(MAP.cv.level() === 'st' ? MAP.focus : null, null);
}

// ── the link is the picture (§K) ─────────────────────────────────────────
/**
 * Where the board is, as link parameters: `z` the scale, `x` `y` the world point at the middle of the stage, rounded.
 * On a street the point is measured from the journey's own corner, so the link survives the board re-laying itself
 * for another window's shape (the districts move, the journey's street does not change inside its district).
 */
function viewParams(flow) {
  if (!MAP.cv) return null;
  const c = MAP.cv.viewCenter();
  const g = flow && MAP.geom.get(flow);
  const ox = g ? g.x : 0, oy = g ? g.y : 0;
  return { z: String(Math.round(MAP.cv.state().s * 10000) / 10000), x: String(Math.round(c.x - ox)), y: String(Math.round(c.y - oy)) };
}
/** The view a link names, or null when it names none (or names one that cannot be read). */
function routeView(route) {
  if (!route) return null;
  const z = parseFloat(route.z), x = parseFloat(route.x), y = parseFloat(route.y);
  return Number.isFinite(z) && z > 0 && Number.isFinite(x) && Number.isFinite(y) ? { z, x, y } : null;
}
/** Put the board where a link says: the world point (x, y) — from the journey's corner on a street — at the middle, at scale z. */
function applyView(v, flow, anim) {
  if (!MAP.cv || !v) return;
  const g = flow && MAP.geom.get(flow);
  MAP.cv.centerOn(v.x + (g ? g.x : 0), v.y + (g ? g.y : 0), v.z, anim);
}
/** The explore card a link names (`card=<kind>:<nodeId>`): the first node on the journey's street that is that node. */
function restoreCard(flow, spec) {
  if (!spec || !MAP.world) return;
  const at = String(spec).indexOf(':');
  if (at < 0) return;
  const kind = spec.slice(0, at), id = spec.slice(at + 1);
  const j = MAP.journeys.get(flow);
  if (!j || !j.model) return;
  let found = null;
  j.model.screens.forEach((s, si) => s.calls.forEach((c, ci) => {
    if (found) return;
    if (kind === 'call' && c.nodeId === id) found = { si, ci, di: null };
    else if (kind !== 'call') { const di = c.data.findIndex((dd) => dd.nodeId === id && dd.kind === kind); if (di >= 0) found = { si, ci, di }; }
  }));
  if (!found) return;
  if (!MAP.plumb) setPlumb(true);
  const sel = '.map-' + (kind === 'call' ? 'pl' : 'pd') + '[data-flow="' + cssAttr(flow) + '"][data-si="' + found.si + '"][data-ci="' + found.ci + '"]' + (found.di != null ? '[data-di="' + found.di + '"]' : '');
  let el = MAP.world.querySelector(sel);
  if (!el) {
    // folded: open the folds that hold it, the way a reader would
    MAP.open.add('calls|' + flow + '|' + found.si);
    if (found.di != null) MAP.open.add('data|' + flow + '|' + found.si + '|' + found.ci);
    relayoutKeeping(() => renderDistrict(flow));
    el = MAP.world.querySelector(sel);
  }
  if (el) showCard(el);
}
let viewT = null;
/** A keyboard pan ends a moment after the last arrow: the link follows then, never once per key. */
function syncHashSoon() {
  clearTimeout(viewT);
  viewT = setTimeout(syncHashToBoard, 250);
}

// ── layout ───────────────────────────────────────────────────────────────
function screenCount(d) {
  const j = MAP.journeys.get(d.id);
  return Math.max(1, j && j.model ? j.model.screens.length : (d.total || (d.screens || []).length || 1));
}
/**
 * What a call draws beside it: its data, writes before reads (so the warm lines are never the folded ones),
 * the first DATA_SHOWN unless the reader opened it, and whether a fold row follows (`'more'` · `'less'` · null).
 * Each entry keeps its index in the model, which the explore card reads.
 */
function callData(flow, si, ci, c) {
  const rank = (m) => { const i = MODE_ORDER.indexOf(m); return i < 0 ? MODE_ORDER.length : i; };
  const all = c.data.map((dd, k) => ({ dd, k })).sort((a, b) => rank(a.dd.mode) - rank(b.dd.mode) || a.k - b.k);
  const foldable = all.length > DATA_SHOWN + 1;
  const open = MAP.open.has('data|' + flow + '|' + si + '|' + ci);
  if (!foldable) return { shown: all, fold: null, hidden: 0 };
  return open ? { shown: all, fold: 'less', hidden: 0 } : { shown: all.slice(0, DATA_SHOWN), fold: 'more', hidden: all.length - DATA_SHOWN };
}
/** What a screen draws under it: its first CALLS_SHOWN calls unless the reader opened it, and its fold row. */
function screenCalls(flow, si, s) {
  const all = s.calls.map((c, ci) => ({ c, ci }));
  const foldable = all.length > CALLS_SHOWN + 1;
  const open = MAP.open.has('calls|' + flow + '|' + si);
  if (!foldable) return { shown: all, fold: null, hidden: 0 };
  return open ? { shown: all, fold: 'less', hidden: 0 } : { shown: all.slice(0, CALLS_SHOWN), fold: 'more', hidden: all.length - CALLS_SHOWN };
}
function callRowH(flow, si, ci, c) {
  const cd = callData(flow, si, ci, c);
  return Math.max(OPMIN, (cd.shown.length + (cd.fold ? 1 : 0)) * ROW - 4);
}
/** A screen's pathway height as drawn now — folded unless the reader opened it. */
function stackH(flow, si, s) {
  const sc = screenCalls(flow, si, s);
  const h = sc.shown.reduce((a, { c, ci }) => a + callRowH(flow, si, ci, c), 0) + Math.max(0, sc.shown.length - 1) * OPGAP;
  return sc.fold ? h + OPGAP + FOLD_H : h;
}
function districtSize(d) {
  const w = Math.max(DMIN, PAD * 2 + screenCount(d) * COL - (COL - SW));
  const j = MAP.journeys.get(d.id);
  const deepest = j && j.model ? Math.max(0, ...j.model.screens.map((s, si) => stackH(d.id, si, s))) : 0;
  // without plumbing a district is its head, its screens and room below them: tall enough that a cover
  // divided by --map-inv's cap (4) still holds a two-line name, a two-line sentence and the chip row
  const h = MAP.plumb && deepest ? PL_TOP + deepest + 70 : SY + SH + 130;
  return { w, h };
}
/**
 * Where the districts sit: `layoutDistricts()` (lib/map-model.js) — one band per
 * source, rows that wrap at the width that brings the board's shape nearest the
 * stage's, every district keeping its street's width.
 */
function layout() {
  const ds = MAP.nb.districts;
  const items = ds.map((d) => ({ id: d.id, repo: d.repo || '', ...districtSize(d) }));
  const bw = MAP.board ? MAP.board.clientWidth : 0, bh = MAP.board ? MAP.board.clientHeight : 0;
  const L = layoutDistricts(items, { aspect: bw > 0 && bh > 0 ? bw / bh : 1.6 });
  MAP.geom = L.rects;
  MAP.bands = L.bands;
  MAP.size = L.size;
}
/** Re-lay the districts after one changed size, keeping the journey in view where it was on screen. */
function relayoutKeeping(draw) {
  const anchor = MAP.focus && MAP.geom.get(MAP.focus);
  const before = anchor ? { x: anchor.x, y: anchor.y } : null;
  layout();
  if (draw) draw();
  placeDistricts();
  drawLinks();
  const after = anchor && MAP.geom.get(MAP.focus);
  if (before && after && MAP.cv && (before.x !== after.x || before.y !== after.y)) {
    const s = MAP.cv.state().s;
    MAP.cv.shift((before.x - after.x) * s, (before.y - after.y) * s);
  }
}
function placeDistricts() {
  if (MAP.world) {
    // the band labels: the source each band of journeys comes from
    MAP.world.querySelectorAll('.map-band').forEach((el) => el.remove());
    const named = (MAP.bands || []).filter((b) => b.repo);
    const html = named.map((b) => '<div class="map-band" style="left:' + b.x + 'px;top:' + b.y + 'px;width:' + b.w + 'px"><span>' + esc(b.repo) + '</span></div>').join('');
    if (html && MAP.links) MAP.links.insertAdjacentHTML('afterend', html);
  }
  for (const [id, g] of MAP.geom) {
    const el = districtEl(id);
    if (el) el.style.cssText = 'left:' + g.x + 'px;top:' + g.y + 'px;width:' + g.w + 'px;height:' + g.h + 'px';
  }
  if (MAP.links) { MAP.links.setAttribute('width', MAP.size.w); MAP.links.setAttribute('height', MAP.size.h); }
}
function districtEl(id) {
  return MAP.world ? MAP.world.querySelector('.map-district[data-flow="' + cssAttr(id) + '"]') : null;
}

// ── moving the board ─────────────────────────────────────────────────────
// The board's stops (docs/MAP-VIEWER.md § MAP, "Levels and stops"): every journey fitted (the board), one
// journey fitted (the journey), its calls readable (calls), one screen large enough to enter (enter). The
// engine (lib/map-canvas.js) holds a gesture at the first stop it crosses; + and − go stop to stop.
function boardSize() {
  return { w: MAP.board ? MAP.board.clientWidth : 0, h: MAP.board ? MAP.board.clientHeight : 0 };
}
/** The scale at which every journey fits — the board stop. */
function boardScale() {
  const b = boardSize();
  if (!MAP.size.w || !b.w || !b.h) return 0;
  return Math.min(LEVEL_NB * 0.9, (b.w - FRAME_PAD * 2) / MAP.size.w, (b.h - FRAME_PAD * 2) / MAP.size.h);
}
function fitAll(anim) {
  if (!MAP.cv || !MAP.size.w) return;
  MAP.cv.fit({ x: 0, y: 0, w: MAP.size.w, h: MAP.size.h }, { pad: FRAME_PAD, max: LEVEL_NB * 0.9, anim });
}
/** The height a journey's frame holds: its head and screens, and its pathways when plumbing is on. */
function frameH(g) { return MAP.plumb ? g.h : SY + SH + 70; }
/**
 * One journey fitted — its stop: fitted to its width (and its height with plumbing), never above
 * STREET_FIT_MAX and never below STREET_FIT_MIN, so a long journey keeps the street and scrolls, with an
 * edge cue saying how many screens are past the edge.
 */
function journeyScale(id) {
  const g = MAP.geom.get(id);
  const b = boardSize();
  if (!g || !b.w || !b.h) return 0;
  const s = Math.min(STREET_FIT_MAX, (b.w - FRAME_PAD * 2) / g.w, (b.h - FRAME_PAD * 2) / frameH(g));
  return Math.max(STREET_FIT_MIN, s);
}
/**
 * Calls readable — the smallest scale at which a data node's name reads at READ_PX on screen, measured from
 * the stylesheet (a data node's name, else a call's, else a screen's), so a change of type size moves it.
 */
function callsScale() {
  const el = MAP.world && (MAP.world.querySelector('.map-pd .nm') || MAP.world.querySelector('.map-pl .nm') || MAP.world.querySelector('.map-scr .nm'));
  const px = el ? parseFloat(getComputedStyle(el).fontSize) : 12;
  return READ_PX / (px > 0 ? px : 12);
}
/** The enter stop: a screen ENTER_COVER of the stage's height, so it arms and the hint shows. */
function enterScale() {
  const b = boardSize();
  return b.h ? (b.h * ENTER_COVER) / SH : 2.4;
}
/** The journey a zoom about the stage point `anchor` is going into: the district under it, else the nearest. */
function journeyAt(anchor) {
  if (!MAP.cv || !MAP.geom.size) return MAP.focus;
  const w = MAP.cv.toWorld(anchor.x, anchor.y);
  let best = null, bd = Infinity;
  for (const [id, g] of MAP.geom) {
    const dx = Math.max(g.x - w.x, 0, w.x - (g.x + g.w)), dy = Math.max(g.y - w.y, 0, w.y - (g.y + g.h));
    const d = Math.hypot(dx, dy);
    if (d < bd) { bd = d; best = id; }
  }
  return best || MAP.focus;
}
/** The stops about a stage point, for the engine. None while a screen is open. */
function mapStops(anchor) {
  if (!MAP.cv || MAP.prop || !MAP.size.w) return [];
  const id = MAP.cv.level() === 'st' && MAP.focus ? MAP.focus : journeyAt(anchor);
  const js = journeyScale(id), cs = callsScale(), es = enterScale();
  const out = [{ id: 'board', s: boardScale(), frame: () => { fitAll(true); writeHash(null, null); } }];
  if (id && js) out.push({ id: 'journey', s: js, frame: () => enterJourney(id, true) });
  // a short journey is readable fitted: the calls stop folds into the journey's
  if (id && cs > js * 1.04) out.push({ id: 'calls', s: cs, frame: (a, via) => { if (via === 'step') frameCalls(id, cs); } });
  if (id && es > Math.max(js, cs) * 1.04) out.push({ id: 'enter', s: es, frame: (a) => frameEnter(id, a, es) });
  return out;
}
/**
 * Zoom to one journey — its frame, and where `#/map/<flow>` opens: at its stop, its head at the top of the
 * board (nothing above it), centred across when it fits, else starting at its first screen.
 */
function enterJourney(id, anim) {
  const g = MAP.geom.get(id);
  if (!g || !MAP.cv) return;
  MAP.focus = id;
  const s = journeyScale(id);
  const b = boardSize();
  const tx = g.w * s <= b.w - FRAME_PAD * 2 ? (b.w - g.w * s) / 2 - g.x * s : FRAME_PAD - g.x * s;
  MAP.cv.set(tx, FRAME_PAD - g.y * s, s, anim);
  writeHash(id, null);
}
/** The calls stop by key or button: the world point at the centre stays across, the journey's head at the top. */
function frameCalls(id, s) {
  const g = MAP.geom.get(id);
  if (!g || !MAP.cv) return;
  const c = MAP.cv.viewCenter();
  const b = boardSize();
  MAP.cv.set(b.w / 2 - c.x * s, FRAME_PAD - g.y * s, s, true);
}
/** The enter stop: the screen nearest the zoom's point centred, large enough to arm, its hint on screen. */
function frameEnter(id, anchor, s) {
  const j = MAP.journeys.get(id);
  if (!j || !j.model || !MAP.cv) return;
  const w = MAP.cv.toWorld(anchor.x, anchor.y);
  let best = -1, bd = Infinity;
  j.model.screens.forEach((_, i) => {
    const p = screenPos(id, i);
    const d = p ? Math.hypot(p.x - w.x, p.y - w.y) : Infinity;
    if (d < bd) { bd = d; best = i; }
  });
  const p = best >= 0 && screenPos(id, best);
  if (p) MAP.cv.centerOn(p.x, p.y, s, true);
}
function screenPos(flow, index) {
  const g = MAP.geom.get(flow);
  if (!g) return null;
  return { x: g.x + PAD + index * COL + SW / 2, y: g.y + SY + SH / 2 };
}
function centreScreen(flow, index, scale, anim) {
  const p = screenPos(flow, index);
  if (!p || !MAP.cv) return;
  MAP.focus = flow;
  MAP.cv.centerOn(p.x, p.y + (MAP.plumb ? 200 : 0), scale, anim);
}

function onCanvasChange(st) {
  if (!MAP.stage) return;
  const lvl = MAP.prop ? 'pr' : st.level;
  MAP.world.classList.toggle('lvl-nb', st.level === 'nb');
  MAP.world.classList.toggle('lvl-st', st.level !== 'nb');
  MAP.stage.querySelectorAll('.map-lvls button').forEach((b) => {
    const on = b.dataset.l === lvl;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const zr = MAP.stage.querySelector('.map-zoomro');
  if (zr) zr.textContent = '×' + st.s.toFixed(2);
  // at the street the focused journey is the one nearest the middle of the screen
  if (st.level === 'st' && !MAP.prop) {
    const c = MAP.cv ? MAP.cv.viewCenter() : null;
    if (c) {
      let best = null, bd = Infinity;
      for (const [id, g] of MAP.geom) {
        const dx = Math.max(g.x - c.x, 0, c.x - (g.x + g.w)), dy = Math.max(g.y - c.y, 0, c.y - (g.y + g.h));
        const d = Math.hypot(dx, dy);
        if (d < bd) { bd = d; best = id; }
      }
      if (best) MAP.focus = best;
    }
  }
  MAP.world.querySelectorAll('.map-district').forEach((d) => d.classList.toggle('focus', st.level === 'st' && d.dataset.flow === MAP.focus));
  linkVisibility();
  drawCrumb();
  drawHint(st);
  applyTabbing();
  drawEdges(st);
}
/** The screen a zoom in would enter, ringed and named in the hint first, so the snap is never a surprise. */
function onArm(el) {
  MAP.world.querySelectorAll('.map-scr.near').forEach((n) => { if (n !== el) n.classList.remove('near'); });
  if (el) el.classList.add('near');
  MAP.near = el;
  if (MAP.cv) drawHint(MAP.cv.state());
}

/**
 * The edge cues: screens of the journey in view that are past the left or right edge of the board, counted,
 * each cue a button that slides the board to them.
 */
function edgeCounts(st) {
  if (!MAP.cv || MAP.prop || st.level === 'nb' || !MAP.focus) return null;
  const g = MAP.geom.get(MAP.focus);
  const d = MAP.nb.districts.find((x) => x.id === MAP.focus);
  if (!g || !d) return null;
  const b = boardSize();
  const v0 = MAP.cv.toWorld(0, 0), v1 = MAP.cv.toWorld(b.w, b.h);
  // only while the screens' row is on the board
  if (g.y + SY + SH < v0.y || g.y + SY > v1.y) return null;
  const n = screenCount(d);
  let left = 0, right = 0;
  for (let i = 0; i < n; i++) {
    const cx = g.x + PAD + i * COL + SW / 2;
    if (cx < v0.x) left++; else if (cx > v1.x) right++;
  }
  // in the gap under the screens' row (above the pathways), so the cue never sits on a screen's name
  const y = Math.max(40, Math.min(b.h - 40, st.ty + (g.y + SY + SH + (PL_TOP - SY - SH) / 2) * st.s));
  return { left, right, y };
}
function edgeHtml(side, n) {
  const words = t('map.edge.more').split('{n}');
  const num = '<span class="n"' + plainTip(n, 'map.edge.more', 'map.edge.scope', '/api/journey').replace(' tabindex="0"', '') + '>' + n + '</span>';
  return (side === 'l' ? '◂ ' : '') + esc(words[0]) + num + esc(words.slice(1).join(String(n))) + (side === 'r' ? ' ▸' : '');
}
function drawEdges(st) {
  const ec = edgeCounts(st);
  for (const side of ['l', 'r']) {
    const el = MAP.stage.querySelector('.map-edgecue.' + side);
    if (!el) continue;
    const n = ec ? (side === 'l' ? ec.left : ec.right) : 0;
    el.hidden = !n;
    if (!n) continue;
    if (el.dataset.n !== String(n)) { el.innerHTML = edgeHtml(side, n); el.dataset.n = String(n); }
    el.style.top = (ec.y + (MAP.board ? MAP.board.offsetTop : 0)) + 'px';
  }
}
/** A cue slides the board about one board's width toward its side, never past the journey's end. */
function onEdgeClick(e) {
  const cue = e.target.closest && e.target.closest('.map-edgecue');
  if (!cue || !MAP.cv || !MAP.focus) return;
  e.stopPropagation();
  const g = MAP.geom.get(MAP.focus);
  if (!g) return;
  const st = MAP.cv.state();
  const b = boardSize();
  const page = Math.max(COL * st.s, b.w - FRAME_PAD * 2 - COL * st.s);
  let tx = st.tx;
  if (cue.classList.contains('r')) tx -= Math.min(page, (g.x + g.w) * st.s + st.tx - (b.w - FRAME_PAD));
  else tx += Math.min(page, FRAME_PAD - (g.x * st.s + st.tx));
  MAP.autoFit = null;
  MAP.cv.set(tx, st.ty, st.s, true);
  syncHashSoon();
}

// ── the stage and its chrome ─────────────────────────────────────────────
function stageHtml() {
  // the chrome comes first in the page so Tab meets the level pills and the tools before the board (§K);
  // tips on the map open on hover and stand clear of what they describe (lib/tooltip.js, data-tip-mode)
  return '<div class="map-surface" data-tip-mode="hover"><div class="map-stage">'
    + '<div class="map-chrome">' + chromeHtml() + '</div>'
    + '<div class="map-board"><div class="map-world lvl-nb"><svg class="map-links" aria-hidden="true"></svg></div></div>'
    + '<button type="button" class="map-edgecue l" hidden></button><button type="button" class="map-edgecue r" hidden></button>'
    + '<div class="map-hint" aria-live="polite"></div>'
    + '<div class="map-zoomro"' + tipAttrs({ key: 'map.zoom', noFocus: true }) + '></div>'
    + '<div class="map-prop-host" hidden></div>'
    + '</div><div class="map-xcard" hidden role="dialog"></div></div>';
}
function chromeHtml() {
  const lvl = (l, key) => '<button type="button" data-l="' + l + '" aria-pressed="false"' + tipAttrs({ key, noFocus: true }) + '>' + esc(t(key)) + '</button>';
  const lensOn = biz();
  const tool = (act, key, label, extra) => '<button type="button" class="map-tb' + (extra || '') + '" data-act="' + act + '" aria-label="' + esc(t(key)) + '"' + tipAttrs({ key, noFocus: true }) + '>' + label + '</button>';
  return '<div class="map-lvls" role="group" aria-label="' + esc(t('map.levels')) + '">'
    + lvl('nb', 'map.level.nb') + lvl('st', 'map.level.st') + lvl('pr', 'map.level.pr') + '</div>'
    + '<div class="map-crumb"></div>'
    + '<span class="map-asof"></span>'
    + '<div class="map-tools">'
    + tool('plumb', 'map.tool.plumb', esc(t('map.tool.plumb')), MAP.plumb ? ' on' : '')
    + tool('lens', 'map.tool.lens', esc(t('map.tool.lens')) + ' · ' + esc(t(lensOn ? 'chrome.lensBusiness' : currentLens() === 'code' ? 'chrome.lensCode' : 'chrome.lensHybrid')), lensOn ? ' on' : '')
    + tool('in', 'map.tool.zoomIn', '+')
    + tool('out', 'map.tool.zoomOut', '−')
    + tool('fit', 'map.tool.fit', esc(t('map.tool.fit')))
    + tool('full', 'map.tool.full', esc(t('map.tool.full')))
    + tool('link', 'map.tool.link', esc(t('map.tool.link')))
    + '</div>';
}
function redrawChrome() {
  const c = MAP.stage && MAP.stage.querySelector('.map-chrome');
  if (!c) return;
  c.innerHTML = chromeHtml();
  if (MAP.cv) onCanvasChange(MAP.cv.state());
}
function drawCrumb() {
  const el = MAP.stage && MAP.stage.querySelector('.map-crumb');
  if (!el || !MAP.cv) return;
  const lvl = MAP.prop ? 'pr' : MAP.cv.level();
  const d = MAP.focus && MAP.nb.districts.find((x) => x.id === MAP.focus);
  const sep = '<span class="sep">›</span>';
  let html = lvl === 'nb' || !d ? '<b>' + esc(t('map.crumb.root')) + '</b>' : esc(t('map.crumb.root')) + sep + (MAP.prop ? '' : '<b>') + esc(nameWords(d.name)) + (MAP.prop ? '' : '</b>');
  if (MAP.prop) {
    const sc = propScreen();
    if (sc) html += sep + '<b>' + esc(sc.name) + '</b>';
  }
  el.innerHTML = html;
  drawAsOf();
}
/**
 * The as-of stamp beside the crumb (§K): the sync this board is drawn from, its source commit (not in the business
 * lens) and the day it was taken, so a screenshot of the map says when it was true. The same facts the sync chip
 * carries, from the graph and `/api/version`.
 */
function drawAsOf() {
  const el = MAP.stage && MAP.stage.querySelector('.map-asof');
  if (!el) return;
  const meta = (S.GRAPH && S.GRAPH.meta) || {};
  const v = S.VERSION && S.VERSION.graph;
  const n = v && v.sync != null ? v.sync : meta.sync;
  if (n == null) { el.innerHTML = ''; return; }
  const when = meta.generatedAt ? new Date(meta.generatedAt) : null;
  const day = when && !isNaN(when) ? when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const commit = meta.commit ? String(meta.commit).slice(0, 7) : '';
  const html = esc(t('map.asOf').replace('{n}', String(n)))
    + (commit ? '<span class="map-code"> · ' + esc(commit) + '</span>' : '')
    + (day ? ' · ' + esc(day) : '');
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = '<span' + tipAttrs({ key: 'map.asOf', noFocus: true }) + '>' + html + '</span>';
  }
}
function drawHint(st) {
  const el = MAP.stage && MAP.stage.querySelector('.map-hint');
  if (!el) return;
  let text;
  if (MAP.prop) text = t('map.hint.pr');
  else if (st.level === 'nb') text = t('map.hint.nb');
  else if (MAP.near) text = t('map.hint.near').replace('{name}', MAP.near.dataset.name || '');
  else text = t('map.hint.st');
  el.textContent = text;
  // the snap is about to be possible: the hint says so in the accent before any zoom can enter
  el.classList.toggle('enter', !MAP.prop && st.level !== 'nb' && !!MAP.near);
}

function onChromeClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.l) { goLevel(b.dataset.l); return; }
  switch (b.dataset.act) {
    case 'plumb': setPlumb(!MAP.plumb); break;
    case 'lens': toggleLens(); break;
    case 'in': mapZoom(1.35); break;
    case 'out': mapZoom(1 / 1.35); break;
    case 'fit': mapFit(); break;
    case 'full': toggleFull(); break;
    case 'link': mapCopyLink(); break;
    default:
  }
}
/** The level pills: each goes to its height. */
function goLevel(l) {
  if (l === 'nb') { closeProperty(); fitAll(true); writeHash(null, null); return; }
  const flow = MAP.focus || (MAP.nb.districts[0] && MAP.nb.districts[0].id);
  if (!flow) return;
  if (l === 'st') { closeProperty(); enterJourney(flow, true); return; }
  ensureJourney(flow).then((j) => {
    if (!j || !j.model || !j.model.screens.length) return;
    const i = MAP.prop && MAP.prop.flow === flow ? MAP.prop.index : 0;
    centreScreen(flow, i, STREET_SCALE, false);
    openProperty(flow, i);
  });
}
function toggleLens() {
  const next = biz() ? 'hybrid' : 'business';
  if (typeof window.setLens === 'function') window.setLens(next);
}
function toggleFull() {
  if (!MAP.stage) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (MAP.stage.requestFullscreen) MAP.stage.requestFullscreen().catch(() => {});
}
function onFullscreen() {
  const b = MAP.stage && MAP.stage.querySelector('[data-act="full"]');
  if (b) b.classList.toggle('on', !!document.fullscreenElement);
}
let resizeT = null;
function onResize() {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    if (!MAP.cv || !MAP.designs) return;
    // the board's shape follows the stage's
    relayoutKeeping();
    if (MAP.cv.level() === 'nb' && !MAP.prop) fitAll(false);
  }, 120);
}

/**
 * Show or hide the calls and data under each screen (`p`, the Plumbing tool,
 * `?plumb=1`), remembered for this reader.
 * @group Map
 */
export function setPlumb(v) {
  if (!MAP.world) return;
  MAP.plumb = !!v;
  writePlumb(MAP.plumb);
  MAP.world.classList.toggle('no-plumb', !MAP.plumb);
  const b = MAP.stage.querySelector('[data-act="plumb"]');
  if (b) b.classList.toggle('on', MAP.plumb);
  relayoutKeeping(() => { for (const d of MAP.nb.districts) sizeDistrict(d.id); });
  if (!MAP.prop) writeHash(MAP.cv && MAP.cv.level() === 'st' ? MAP.focus : null, null);
}
/**
 * Copy the link to this picture — the *Copy link* tool and `y` on the map (§K). The address is brought up to date
 * first (where the board is, the open card or screen), then copied; where the clipboard is refused the link is put
 * in a field beside the tool, selected, for the reader to copy.
 * @group Map
 */
export function mapCopyLink() {
  if (!MAP.stage) return;
  clearTimeout(viewT);
  if (!MAP.prop) syncHashToBoard();
  const link = shareLink();
  const done = (key) => {
    const b = MAP.stage && MAP.stage.querySelector('[data-act="link"]');
    const hint = MAP.stage && MAP.stage.querySelector('.map-hint');
    if (hint) hint.textContent = t(key);
    if (b) { b.classList.add('on'); setTimeout(() => b.classList.remove('on'), 1500); }
  };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = link; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    if (ok) { done('map.link.copied'); return; }
    // nothing would copy: the link in a field, selected, beside the tool
    const tools = MAP.stage && MAP.stage.querySelector('.map-tools');
    if (!tools) return;
    let f = tools.querySelector('.map-linkfield');
    if (!f) { f = document.createElement('input'); f.className = 'map-linkfield'; f.readOnly = true; f.setAttribute('aria-label', t('map.tool.link')); tools.appendChild(f); }
    f.value = link; f.focus(); f.select();
    done('map.link.select');
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(() => done('map.link.copied'), fallback);
    else fallback();
  } catch { fallback(); }
}
/**
 * The ± tools and keys: a factor above 1 goes to the next stop in (or enters the armed screen), below 1 to
 * the next stop out — from a journey, its own fitted stop before the board.
 * @group Map
 */
export function mapZoom(f) { if (MAP.cv && !MAP.prop) { MAP.autoFit = null; MAP.cv.zoomStep(f > 1 ? 1 : -1); } }
/**
 * Fit what is in view (the Fit tool and `0`): the journey the street is on, plumbing included when it is on;
 * every journey only from the board. A screen that is open closes onto its journey.
 * @group Map
 */
export function mapFit() {
  if (!MAP.cv) return;
  closeCard();
  const flow = MAP.prop ? MAP.prop.flow : MAP.cv.level() === 'st' ? MAP.focus : null;
  closeProperty({ keepHash: true });
  if (flow && MAP.geom.has(flow)) { enterJourney(flow, true); return; }
  fitAll(true);
  writeHash(null, null);
}

// ── drawing ──────────────────────────────────────────────────────────────
function renderAll() {
  if (!MAP.world) return;
  const svg = MAP.links;
  if (MAP.failed || !MAP.designs || !MAP.nb.districts.length) {
    MAP.world.innerHTML = '';
    MAP.world.appendChild(svg);
    svg.innerHTML = '';
    const msg = MAP.failed ? t('map.failed') : !MAP.designs ? t('map.loading') : t('map.empty');
    const key = MAP.failed ? 'map.failed' : !MAP.designs ? 'map.loading' : 'map.empty';
    let note = MAP.stage.querySelector('.map-note');
    if (!note) { note = document.createElement('div'); note.className = 'map-note'; MAP.stage.appendChild(note); }
    note.innerHTML = '<span' + tipAttrs({ key }) + '>' + esc(msg) + '</span>';
    return;
  }
  const note = MAP.stage.querySelector('.map-note');
  if (note) note.remove();
  MAP.world.innerHTML = MAP.nb.districts.map((d) => '<div class="map-district" data-flow="' + esc(d.id) + '"></div>').join('');
  MAP.world.insertBefore(svg, MAP.world.firstChild);
  for (const d of MAP.nb.districts) renderDistrict(d.id);
  placeDistricts();
  drawLinks();
  if (MAP.cv) onCanvasChange(MAP.cv.state());
}

/** Redraw one district — head, street and cover — from what is in hand for it. */
function renderDistrict(id) {
  const el = districtEl(id);
  const d = MAP.nb.districts.find((x) => x.id === id);
  if (!el || !d) return;
  const j = MAP.journeys.get(id);
  const g = MAP.geom.get(id) || { w: DMIN, h: SY + SH + 70 };
  const agg = aggHtml(d, j);
  const desc = sentence(d.description);
  // a walk landing redraws the district under the keyboard: the focus comes back to the same thing
  const had = el.contains(document.activeElement) ? focusKey(document.activeElement) : null;
  el.innerHTML = '<div class="map-dhead"><div class="nm">' + esc(nameWords(d.name)) + '</div>'
    + (desc ? '<div class="desc">' + esc(desc) + '</div>' : '')
    + '<div class="agg">' + agg + '</div></div>'
    + '<div class="map-dstreet">' + streetHtml(d, j, g) + '</div>'
    // the cover is counter-scaled (--map-inv, set by the canvas) so its name reads at any zoom;
    // its whole sentence is the cover's tip
    + '<div class="map-dcover" role="button" tabindex="0" data-enter="' + esc(id) + '" aria-label="' + esc(t('map.cover.enter') + ' · ' + nameWords(d.name)) + '"'
    + (desc ? tipAttrs({ text: desc, noFocus: true }) : '') + '><div class="map-dcover-in">'
    + '<div class="nm">' + esc(nameWords(d.name)) + '</div>'
    + (desc ? '<div class="desc">' + esc(desc) + '</div>' : '')
    + '<div class="agg">' + agg + '</div></div></div>';
  el.classList.toggle('loaded', !!(j && j.model));
  sizeDistrict(id);
  tabDistrict(el);
  if (had) focusQuiet(el.querySelector(had));
}
/** A selector that finds the same board element after a redraw. */
function focusKey(a) {
  const own = a.closest && a.closest('.map-dcover,.map-scr,.map-pl,.map-pd,.map-fold');
  if (!own) return null;
  if (own.matches('.map-dcover')) return '.map-dcover';
  if (own.matches('.map-scr')) return '.map-scr[data-index="' + own.dataset.index + '"]';
  if (own.matches('.map-fold')) return '.map-fold[data-fold="' + cssAttr(own.dataset.fold) + '"]';
  return '.' + own.classList[0] + '[data-si="' + own.dataset.si + '"][data-ci="' + own.dataset.ci + '"]' + (own.dataset.di != null ? '[data-di="' + own.dataset.di + '"]' : '');
}
function sizeDistrict(id) {
  const el = districtEl(id);
  const g = MAP.geom.get(id);
  if (!el || !g) return;
  const svg = el.querySelector('.map-edges');
  if (svg) { svg.setAttribute('width', g.w); svg.setAttribute('height', g.h); }
}

/**
 * A journey's numbers at poster size: every one a `Counted` the summary typed,
 * with its tip; before the walk lands, a word that says it is being read —
 * never a number the design rows do not type.
 */
function aggHtml(d, j) {
  const work = '<span class="map-work" data-work-for="' + esc(d.id) + '">' + (d.work ? flowChipHtml(d.work) : '') + '</span>';
  if (!j) return '<span class="map-chip k-absent"' + tipAttrs({ key: 'map.cover.loading', noFocus: true }) + '>' + esc(t('map.cover.loading')) + '</span>' + work;
  if (j.error) return '<span class="map-chip k-absent"' + tipAttrs({ key: 'map.cover.failed', noFocus: true }) + '>' + esc(t('map.cover.failed')) + '</span>' + work;
  const sum = j.data.summary || {};
  const k = sum.counted || {};
  const cov = sum.coverage && sum.coverage.journey && sum.coverage.journey.counted;
  const chip = (c, cls) => countedHtml(c, '/api/journey', { cls: 'map-chip ' + cls });
  return [
    chip(k.screens, ''),
    k.built && k.built.of != null && k.built.n < k.built.of ? chip(k.built, 'k-warn') : chip(k.built, 'k-ok'),
    chip(k.actions, 'k-api'),
    chip(k.gates, 'k-gate'),
    // the stores the journey touches — the summary's own Counted (data-stores §5); not drawn at 0
    k.stores && k.stores.n ? chip(k.stores, 'k-store') : '',
    cov ? chip(cov.tests, 'k-test') : '',
    k.declaredNotCalled && k.declaredNotCalled.n ? chip(k.declaredNotCalled, 'k-absent') : '',
  ].join('') + work;
}

/** The street of one district: screens in step order, then — with plumbing on — each screen's pathway. */
function streetHtml(d, j, g) {
  if (!j || !j.model) return '<svg class="map-edges" aria-hidden="true"></svg>';
  const m = j.model;
  let paths = '';
  let html = '';
  const n = m.screens.length;
  m.screens.forEach((s, i) => {
    const x = PAD + i * COL, y = SY;
    html += screenHtml(d, m, s, x, y, n);
    if (i < n - 1) {
      const x1 = x + SW, x2 = x + COL, ym = y + SH / 2;
      paths += '<path class="step" d="M' + x1 + ' ' + ym + ' C ' + (x1 + 40) + ' ' + ym + ', ' + (x2 - 40) + ' ' + ym + ', ' + x2 + ' ' + ym + '"/>'
        + '<path class="step" d="M' + (x2 - 9) + ' ' + (ym - 6) + ' L' + x2 + ' ' + ym + ' L' + (x2 - 9) + ' ' + (ym + 6) + '"/>'
        + '<text class="then" x="' + ((x1 + x2) / 2 - 14) + '" y="' + (ym - 10) + '">' + esc(t('map.then')) + '</text>';
    }
  });
  // the plumbing: one pathway per screen, its calls stacked beneath it, what each reads and writes beside it
  if (m.screens.some((s) => s.calls.length)) {
    const stores = storesOf(m);
    const reached = m.screens.some((s) => s.calls.some((c) => c.data.some((x) => x.mode === 'reached')));
    html += '<div class="map-lane" style="top:' + (PL_TOP - 40) + 'px"><span class="lbl"' + tipAttrs({ key: 'map.lane.title', noFocus: true }) + '>' + esc(t('map.lane.title')) + '</span>'
      + '<span class="leg">' + m.services.map((sv) => '<span class="svc-' + (sv.index % 6) + '"><i></i>' + esc(sv.label) + '</span>').join('')
      + (m.screens.some((s) => s.calls.some((c) => !c.service)) ? '<span class="svc-none"' + tipAttrs({ key: 'map.lane.noService', noFocus: true }) + '><i></i>' + esc(t('map.lane.noService')) + '</span>' : '')
      + '<span class="rw"' + tipAttrs({ key: 'map.lane.reads', noFocus: true }) + '><b></b>' + esc(t('map.lane.reads')) + '</span>'
      + '<span class="rw"' + tipAttrs({ key: 'map.lane.writes', noFocus: true }) + '><b class="w"></b>' + esc(t('map.lane.writes')) + '</span>'
      + (reached ? '<span class="rw"' + tipAttrs({ key: 'map.mode.reached', noFocus: true }) + '><b class="r"></b>' + esc(t('map.mode.reached')) + '</span>' : '')
      + (stores.length ? '<span class="stores"><span class="sl"' + tipAttrs({ key: 'map.store.legend', noFocus: true }) + '>' + esc(t('map.store.legend')) + '</span>'
        + stores.map((st) => '<span class="mst st-' + storeKind(st) + '" data-store="' + esc(st.name) + '"' + tipAttrs({ key: storeKindKey(st), noFocus: true }) + '><i></i>'
          + esc(st.name) + ' · ' + esc(t(storeKindKey(st))) + '</span>').join('') + '</span>' : '')
      + '</span></div>';
  }
  m.screens.forEach((s, si) => {
    const x = PAD + si * COL;
    let y = PL_TOP;
    const tx = x + 100;
    const sc = screenCalls(d.id, si, s);
    sc.shown.forEach(({ c, ci }) => {
      const h = callRowH(d.id, si, ci, c);
      const cd = callData(d.id, si, ci, c);
      html += callHtml(d, s, c, si, ci, x, y, h);
      const cls0 = (mode) => 'plumb ' + (mode === 'read' ? 'read' : mode === 'reached' ? 'reached' : 'write');
      cd.shown.forEach(({ dd, k }, row) => {
        const dy = y + row * ROW;
        html += dataHtml(d, s, c, dd, si, ci, k, x + DX, dy);
        const my = dy + 18, x1 = x + OPW, x2 = x + DX;
        const cls = cls0(dd.mode);
        paths += '<path class="' + cls + '" d="M' + x1 + ' ' + my + ' L' + x2 + ' ' + my + '"/>';
        if (dd.mode === 'reached') return;          // the direction was not recorded: a plain line, no arrowhead
        if (dd.mode !== 'write') paths += '<path class="' + cls + '" d="M' + (x1 + 9) + ' ' + (my - 5) + ' L' + x1 + ' ' + my + ' L' + (x1 + 9) + ' ' + (my + 5) + '"/>';
        if (dd.mode !== 'read') paths += '<path class="' + cls + '" d="M' + (x2 - 9) + ' ' + (my - 5) + ' L' + x2 + ' ' + my + ' L' + (x2 - 9) + ' ' + (my + 5) + '"/>';
      });
      if (cd.fold) html += foldHtml(d.id, 'data|' + d.id + '|' + si + '|' + ci, cd.fold, cd.hidden, 'data', x + DX, y + cd.shown.length * ROW);
      y += h + OPGAP;
    });
    if (sc.fold) { html += foldHtml(d.id, 'calls|' + d.id + '|' + si, sc.fold, sc.hidden, 'calls', x, y); y += FOLD_H + OPGAP; }
    if (s.calls.length) {
      const allGhost = s.calls.every(ghost);
      paths = '<path class="plumb trunk' + (allGhost ? ' ghost' : '') + '" d="M' + tx + ' ' + (SY + SH) + ' L' + tx + ' ' + (y - OPGAP - 4) + '"/>' + paths;
    }
  });
  return '<svg class="map-edges" aria-hidden="true" width="' + g.w + '" height="' + g.h + '">' + paths + '</svg>' + html;
}

/** One screen card: its picture, its place, its name, its route (not in the business lens) and its numbers. */
function screenHtml(d, m, s, x, y, n) {
  const node = s.node;
  const thumb = node && node.design ? designThumbHtml(node, 'map') : '';
  const ph = '<div class="map-thumb ph">' + sym('screen') + '<span>' + esc(t('journey.absent.notIndexed')) + '</span></div>';
  const c = s.chips;
  const chip = (cn, cls) => (cn && (cn.n || biz() === false) ? countedHtml(cn, '/api/journey', { cls: 'map-chip ' + cls }) : '');
  const chips = [chip(c.calls, 'k-api'), chip(c.gates, 'k-gate'), chip(c.tests, 'k-test')].join('');
  return '<div class="map-scr' + (s.state === 'planned' ? ' planned' : '') + '" role="button" tabindex="0"'
    + ' data-flow="' + esc(d.id) + '" data-index="' + s.index + '" data-node="' + esc(s.id) + '" data-name="' + esc(s.name) + '"'
    + ' aria-label="' + esc(t('map.screen.open') + ' · ' + s.name) + '" style="left:' + x + 'px;top:' + y + 'px">'
    + '<div class="stripe"></div>'
    + '<div class="map-thumbwrap">' + (thumb || ph) + '</div>'
    + '<div class="body"><div class="ttl"><span class="ord"' + tipAttrs({ key: 'map.screen.ordinal', noFocus: true }) + '>' + s.ordinal + '</span>'
    + '<span class="nm">' + esc(s.name) + '</span></div>'
    + '<div class="route map-code">' + esc(s.route || '') + '</div>'
    + (s.state === 'planned' ? '<div class="state"><span class="map-chip k-warn"' + tipAttrs({ key: 'map.screen.planned', noFocus: true }) + '>' + sym('warning') + esc(t('map.screen.planned')) + '</span></div>' : '')
    + '<div class="map-chips">' + chips + '</div></div></div>';
}

/** One call on a screen's pathway: the service bar, its evidence where it is not spec-backed, its name and (not in the business lens) its method and path. */
function callHtml(d, s, c, si, ci, x, y, h) {
  const svc = c.service ? 'svc-' + (c.service.index % 6) : 'svc-none';
  const ev = c.evidence === 'spec-backed' ? '' : '<span class="map-ev"' + tipAttrs({ key: evKey(c.evidence), noFocus: true }) + '>' + esc(t(evKey(c.evidence))) + '</span>';
  const again = c.repeat ? '<span class="again"' + tipAttrs({ key: 'map.call.again', noFocus: true }) + '>' + esc(t('map.call.again')) + '</span>' : '';
  return '<div class="map-pl ' + svc + (ghost(c) ? ' absent' : '') + '" role="button" tabindex="0" data-kind="call"'
    + ' data-evidence="' + esc(c.evidence) + '" data-svc="' + esc(c.service ? c.service.label : '') + '"'
    + ' data-flow="' + esc(d.id) + '" data-si="' + si + '" data-ci="' + ci + '" style="left:' + x + 'px;top:' + y + 'px;height:' + h + 'px">'
    + '<div class="k"><span class="svc">' + esc(c.service ? c.service.label : t('map.lane.noService')) + '</span>' + again + ev + '</div>'
    + '<div class="nm">' + esc(callWords(c)) + '</div>'
    + '<div class="sub map-code">' + esc((c.method + ' ' + c.path).trim()) + '</div></div>';
}

/**
 * A fold row: `▸ n more` beside a call, `▸ n more calls` under a screen, or the way back (`▾ fewer`). The number
 * is the call's (or the screen's) own markers beyond those drawn, with its tip; the walk's counts never move.
 */
function foldHtml(flow, key, state, hidden, kind, x, y) {
  const w = kind === 'calls' ? OPW : DW;
  let label;
  if (state === 'more') {
    const wk = kind === 'calls' ? 'map.fold.calls' : 'map.fold.data';
    const words = t(wk).split('{n}');
    label = '▸ ' + esc(words[0]) + '<span class="n"' + plainTip(hidden, wk, kind === 'calls' ? 'map.fold.scopeScreen' : 'map.fold.scopeCall', '/api/journey').replace(' tabindex="0"', '') + '>' + hidden + '</span>' + esc(words.slice(1).join(String(hidden)));
  } else label = '▾ ' + esc(t(kind === 'calls' ? 'map.fold.lessCalls' : 'map.fold.less'));
  return '<button type="button" class="map-fold ' + kind + (state === 'less' ? ' on' : '') + '" data-fold="' + esc(key) + '" data-flow="' + esc(flow) + '"'
    + ' aria-expanded="' + (state === 'less' ? 'true' : 'false') + '" style="left:' + x + 'px;top:' + y + 'px;width:' + w + 'px">' + label + '</button>';
}
/** Open or close one fold; the district redraws and grows or shrinks downward. @group Map */
function toggleFold(key, flow) {
  if (MAP.open.has(key)) MAP.open.delete(key); else MAP.open.add(key);
  relayoutKeeping(() => renderDistrict(flow));
  const btn = MAP.world && MAP.world.querySelector('.map-fold[data-fold="' + cssAttr(key) + '"]');
  if (btn) btn.focus({ preventScroll: true });
}

/** One record, message or third party beside a call, with what the call does to it. */
function dataHtml(d, s, c, dd, si, ci, k, x, y) {
  // a store-like third party is drawn in the record anatomy; the left bar takes the colour of the store's kind
  const cls = dd.kind === 'message' ? 'msg' : dd.kind === 'external' && !dd.store ? 'ext' : 'rec' + (dd.store ? ' st-' + storeKind(dd.store) : '');
  return '<div class="map-pd ' + cls + (ghost(c) ? ' absent' : '') + '" role="button" tabindex="0" data-kind="' + esc(dd.kind) + '" data-mode="' + esc(dd.mode) + '"'
    + (dd.store ? ' data-store="' + esc(dd.store.name) + '" data-store-kind="' + esc(storeKind(dd.store)) + '"' : '')
    + ' data-flow="' + esc(d.id) + '" data-si="' + si + '" data-ci="' + ci + '" data-di="' + k + '" style="left:' + x + 'px;top:' + y + 'px">'
    // the kind line truncates (kind · identifier, then what the call does to it); the name has the node's width
    + '<span class="top"><span class="kd">' + esc(dataKindWords(dd)) + '<span class="map-code"> · ' + esc(dd.name) + '</span></span>'
    + '<span class="rw ' + esc(dd.mode) + '"' + tipAttrs({ key: modeKey(dd.mode), noFocus: true }) + '>' + esc(modeWord(dd.mode)) + '</span></span>'
    + '<span class="nm">' + esc(dataWords(dd)) + '</span></div>';
}

/**
 * The links between districts, from each journey's own `summary.links`: *leads
 * to* (and its mirror *requires*, drawn once) and *part of*. A link appears when
 * the walk that names it lands — never inferred here.
 */
function drawLinks() {
  if (!MAP.links) return;
  const seen = new Set();
  let out = '';
  const edge = (from, to, kind) => {
    const key = kind + ':' + from + '>' + to;
    if (seen.has(key) || from === to) return;
    const a = MAP.geom.get(from), b = MAP.geom.get(to);
    if (!a || !b) return;
    seen.add(key);
    out += linkPath(a, b, kind).replace('<g ', '<g data-from="' + esc(from) + '" data-to="' + esc(to) + '" ');
  };
  for (const [id, j] of MAP.journeys) {
    const l = j && j.model && j.model.links;
    if (!l) continue;
    for (const r of l.leadsTo || []) edge(id, r.id, 'leadsTo');
    for (const r of l.requires || []) edge(r.id, id, 'leadsTo');
    for (const r of l.partOf || []) edge(r.id, id, 'partOf');
  }
  MAP.links.innerHTML = out;
  linkVisibility();
}
/**
 * Which links show. *Leads to* is always drawn, dimmed. *Part of* is noise at
 * the fit: it shows only for the district under the pointer or the focus, or
 * at the street when both its ends are in view. The district under the pointer
 * or the focus brings all of its links up, with their words.
 */
function linkVisibility() {
  if (!MAP.links || !MAP.cv) return;
  const st = MAP.cv.state();
  const c = MAP.cv.viewCenter();
  const view = { x: c.x - c.w / 2, y: c.y - c.h / 2, w: c.w, h: c.h };
  const inView = (id) => { const g = MAP.geom.get(id); return !!g && g.x < view.x + view.w && view.x < g.x + g.w && g.y < view.y + view.h && view.y < g.y + g.h; };
  MAP.links.querySelectorAll('g[data-link]').forEach((g) => {
    const hot = !!MAP.hot && (g.dataset.from === MAP.hot || g.dataset.to === MAP.hot);
    const show = g.dataset.link !== 'partOf' || hot || (st.level === 'st' && inView(g.dataset.from) && inView(g.dataset.to));
    g.classList.toggle('off', !show);
    g.classList.toggle('hot', hot);
  });
}
function onDistrictHot(e) {
  const d = e.target && e.target.closest ? e.target.closest('.map-district') : null;
  const id = d ? d.dataset.flow : null;
  if (id === MAP.hot) return;
  MAP.hot = id;
  linkVisibility();
}
function linkPath(a, b, kind) {
  const cls = kind === 'partOf' ? ' class="contains"' : '';
  const word = esc(t(kind === 'partOf' ? 'map.link.partOf' : 'map.link.leadsTo'));
  const acx = a.x + a.w / 2, bcx = b.x + b.w / 2;
  let d, lx, ly, head = '', anchor = 'start';
  if (b.y >= a.y + a.h) {                       // below
    const x1 = Math.max(a.x + 60, Math.min(a.x + a.w - 60, bcx)), y1 = a.y + a.h, x2 = bcx, y2 = b.y;
    d = 'M' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + 110) + ', ' + x2 + ' ' + (y2 - 110) + ', ' + x2 + ' ' + y2;
    lx = (x1 + x2) / 2 + 12; ly = (y1 + y2) / 2;
    head = 'M' + (x2 - 10) + ' ' + (y2 - 16) + ' L' + x2 + ' ' + y2 + ' L' + (x2 + 10) + ' ' + (y2 - 16);
  } else if (a.y >= b.y + b.h) {                // above
    const x1 = acx, y1 = a.y, x2 = Math.max(b.x + 60, Math.min(b.x + b.w - 60, acx)), y2 = b.y + b.h;
    d = 'M' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 - 110) + ', ' + x2 + ' ' + (y2 + 110) + ', ' + x2 + ' ' + y2;
    lx = (x1 + x2) / 2 + 12; ly = (y1 + y2) / 2;
    head = 'M' + (x2 - 10) + ' ' + (y2 + 16) + ' L' + x2 + ' ' + y2 + ' L' + (x2 + 10) + ' ' + (y2 + 16);
  } else {                                      // beside
    const right = b.x >= a.x;
    const x1 = right ? a.x + a.w : a.x, y1 = a.y + Math.min(a.h, b.h) / 2, x2 = right ? b.x : b.x + b.w, y2 = b.y + Math.min(a.h, b.h) / 2;
    const k = right ? 60 : -60;
    d = 'M' + x1 + ' ' + y1 + ' C ' + (x1 + k) + ' ' + y1 + ', ' + (x2 - k) + ' ' + y2 + ', ' + x2 + ' ' + y2;
    lx = (x1 + x2) / 2; ly = Math.min(y1, y2) - 16; anchor = 'middle';
    head = right ? 'M' + (x2 - 16) + ' ' + (y2 - 10) + ' L' + x2 + ' ' + y2 + ' L' + (x2 - 16) + ' ' + (y2 + 10)
      : 'M' + (x2 + 16) + ' ' + (y2 - 10) + ' L' + x2 + ' ' + y2 + ' L' + (x2 + 16) + ' ' + (y2 + 10);
  }
  return '<g data-link="' + kind + '"><path' + cls + ' d="' + d + '"/>' + (kind === 'partOf' ? '' : '<path d="' + head + '"/>')
    + '<text x="' + lx + '" y="' + ly + '" text-anchor="' + anchor + '">' + word + '</text></g>';
}

// ── clicks on the board ──────────────────────────────────────────────────
function onBoardClick(e) {
  const tgt = e.target;
  // a number or a word with a tip shows it on hover (data-tip-mode="hover"); a click is for what it sits on
  if (tgt.closest('a[href]')) return;
  const fold = tgt.closest('.map-fold');
  if (fold && MAP.cv && MAP.cv.level() === 'st') { closeCard(); toggleFold(fold.dataset.fold, fold.dataset.flow); return; }
  const node = tgt.closest('.map-pl,.map-pd');
  if (node && MAP.cv && MAP.cv.level() === 'st') { showCard(node); return; }
  const scr = tgt.closest('.map-scr');
  if (scr && MAP.cv && MAP.cv.level() === 'st') { openScreenEl(scr); return; }
  const cover = tgt.closest('.map-dcover');
  if (cover && MAP.cv && MAP.cv.level() === 'nb') { closeCard(); enterJourney(cover.dataset.enter, true); return; }
  closeCard();
}
function onBoardKey(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const tgt = e.target;
  if (tgt.matches(TIP_SELECTOR) && !tgt.matches('.map-scr,.map-pl,.map-pd,.map-dcover')) return;
  if (tgt.matches('.map-pl,.map-pd')) { e.preventDefault(); showCard(tgt); return; }
  if (tgt.matches('.map-scr')) { e.preventDefault(); openScreenEl(tgt); return; }
  if (tgt.matches('.map-dcover')) {
    e.preventDefault();
    const flow = tgt.dataset.enter;
    enterJourney(flow, true);
    // the cover is not drawn on the street: the keyboard lands on the journey's first screen
    applyTabbing();
    const first = MAP.world && MAP.world.querySelector('.map-scr[data-flow="' + cssAttr(flow) + '"]');
    if (first) focusQuiet(first);
    else ensureJourney(flow).then(() => { if (MAP.focus === flow && MAP.cv && MAP.cv.level() === 'st') focusQuiet(MAP.world && MAP.world.querySelector('.map-scr[data-flow="' + cssAttr(flow) + '"]')); });
  }
}
function onDocClick(e) {
  if (!MAP.card) return;
  const card = MAP.el && MAP.el.querySelector('.map-xcard');
  if (card && card.contains(e.target)) return;
  if (e.target.closest && e.target.closest('.map-pl,.map-pd')) return;
  if (e.target.closest && e.target.closest('#fs-tip')) return;
  // copying the link copies the picture with its card: the card stays open
  if (e.target.closest && e.target.closest('.map-tb[data-act="link"]')) return;
  closeCard();
}
function openScreenEl(scr) {
  const flow = scr.dataset.flow, index = +scr.dataset.index;
  if (!flow || !(index >= 0)) return;
  openProperty(flow, index);
}

// ── the explore card (§5: one anatomy, every kind) ─────────────────────────
function cardTarget(el) {
  const j = MAP.journeys.get(el.dataset.flow);
  const s = j && j.model && j.model.screens[+el.dataset.si];
  const c = s && s.calls[+el.dataset.ci];
  if (!c) return null;
  if (el.dataset.kind === 'call') return { kind: 'call', flow: el.dataset.flow, model: j.model, screen: s, call: c };
  const dd = c.data[+el.dataset.di];
  return dd ? { kind: dd.kind, flow: el.dataset.flow, model: j.model, screen: s, call: c, data: dd } : null;
}
function showCard(el) {
  const tg = cardTarget(el);
  if (!tg) return;
  const nodeId = tg.kind === 'call' ? tg.call.nodeId : tg.data.nodeId;
  MAP.card = { el, tg, spec: tg.kind + ':' + nodeId, key: el.dataset.flow + '|' + el.dataset.si + '|' + el.dataset.ci + '|' + (el.dataset.di || '') + '|' + el.dataset.kind };
  drawCard();
  // the open card is part of the picture the link carries
  writeHash(el.dataset.flow, null);
}
function reopenCard() {
  if (!MAP.card || !MAP.world) return;
  const [flow, si, ci, di, kind] = MAP.card.key.split('|');
  const sel = '.map-' + (kind === 'call' ? 'pl' : 'pd') + '[data-flow="' + cssAttr(flow) + '"][data-si="' + si + '"][data-ci="' + ci + '"]' + (di ? '[data-di="' + di + '"]' : '');
  const el = MAP.world.querySelector(sel);
  if (!el) { closeCard(); return; }
  MAP.card.el = el;
  MAP.card.tg = cardTarget(el);
  drawCard();
}
function drawCard() {
  const box = MAP.el && MAP.el.querySelector('.map-xcard');
  if (!box || !MAP.card || !MAP.card.tg) return;
  const tg = MAP.card.tg;
  const nodeId = tg.kind === 'call' ? tg.call.nodeId : tg.data.nodeId;
  let head, ev = '', name, code, store = '', links = [];
  if (tg.kind === 'call') {
    const c = tg.call;
    const modes = [...new Set(c.data.map((x) => x.mode).filter((x) => x !== 'reached'))];
    const dir = modes.length ? (modes.includes('both') || (modes.includes('read') && modes.includes('write')) ? t('map.lane.both') : modeWord(modes[0])) : '';
    head = esc(c.service ? c.service.label : t('map.lane.noService')) + (dir ? ' · ' + esc(dir) : '');
    ev = '<span class="map-ev"' + tipAttrs({ key: evKey(c.evidence) }) + '>' + esc(t(evKey(c.evidence))) + '</span>';
    name = callWords(c);
    const handler = c.marker && c.marker.handler ? c.marker.handler.name : '';
    code = [(c.method + ' ' + c.path).trim(), c.operationId, handler ? t('map.card.handler') + ' ' + handler : ''].filter(Boolean).join(' · ');
    const route = nodeId && S.BYID[nodeId];
    const apiId = route && route.contract && route.contract.apiId;
    if (apiId) links.push(['#/apis/' + encodeURIComponent(apiId) + '?op=' + encodeURIComponent(nodeId), t('map.card.openApis')]);
    if (route) links.push(['#/codemap?node=' + encodeURIComponent(nodeId), t('map.card.openCode')]);
  } else {
    const dd = tg.data;
    head = esc(dataKindWords(dd)) + ' · ' + esc(modeWord(dd.mode));
    name = dataWords(dd);
    const n = dd.node;
    code = [dd.name, n && n.loc ? n.loc.path + (n.loc.line ? ':' + n.loc.line : '') : ''].filter(Boolean).join(' · ');
    // the store, and — outside the business register — how it is known
    if (dd.store) {
      const via = dd.store.via ? 'map.store.via.' + dd.store.via : '';
      store = '<div class="store"><span class="mst st-' + storeKind(dd.store) + '"' + tipAttrs({ key: storeKindKey(dd.store) }) + '><i></i>'
        + esc(dd.store.name) + ' · ' + esc(t(storeKindKey(dd.store))) + '</span>'
        + (via && t(via) !== via ? '<span class="map-code via"><span class="hud-label"' + tipAttrs({ key: 'map.store.known', noFocus: true }) + '>' + esc(t('map.store.known')) + '</span> '
          + '<span' + tipAttrs({ key: via, noFocus: true }) + '>' + esc(t(via)) + '</span>' + (dd.store.ref ? ' · <code>' + esc(dd.store.ref) + '</code>' : '') + '</span>' : '')
        + '</div>';
    }
    if (n) links.push(['#/codemap?node=' + encodeURIComponent(dd.nodeId), t('map.card.openCode')]);
  }
  const on = screensUsing(tg.model, tg.kind === 'call' ? 'call' : tg.kind, nodeId);
  box.innerHTML = '<div class="k"><span class="hud-label">' + head + '</span>' + ev
    + '<button type="button" class="x" data-act="close" aria-label="' + esc(t('map.card.close')) + '">✕</button></div>'
    + '<div class="nm">' + esc(name) + '</div>'
    + store
    + (code ? '<div class="sent map-code">' + esc(code) + '</div>' : '')
    + '<div class="where"><span class="hud-label"' + tipAttrs({ key: 'map.card.on', noFocus: true }) + '>' + esc(t('map.card.on')) + '</span>'
    + (on.length ? on.map((s) => '<button type="button" class="map-chip go" data-go="' + s.index + '" data-flow="' + esc(tg.flow) + '">' + esc(s.name) + '</button>').join('')
      : '<span class="map-chip k-absent">' + esc(t('map.card.onNone')) + '</span>') + '</div>'
    + (links.length ? '<div class="acts">' + links.slice(0, 2).map(([h, w], i) => '<a class="map-tb' + (i === 0 ? ' on' : '') + '" href="' + esc(h) + '">' + esc(w) + '</a>').join('') + '</div>' : '');
  box.setAttribute('aria-label', name);
  box.hidden = false;
  box.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'close') { closeCard(); return; }
    if (b.dataset.go != null) { const f = b.dataset.flow, i = +b.dataset.go; closeCard(); openProperty(f, i); }
  };
  // beside its node, kept on screen
  const r = MAP.card.el.getBoundingClientRect();
  const W = box.offsetWidth, H = box.offsetHeight;
  let x = r.left, y = r.bottom + 8;
  if (x + W > innerWidth - 16) x = innerWidth - 16 - W;
  if (y + H > innerHeight - 40) y = Math.max(96, r.top - H - 8);
  box.style.left = Math.max(16, x) + 'px';
  box.style.top = y + 'px';
}
/** Close the explore card. @group Map */
export function closeCard() {
  const had = !!MAP.card;
  MAP.card = null;
  const box = MAP.el && MAP.el.querySelector('.map-xcard');
  if (box) { box.hidden = true; box.innerHTML = ''; }
  if (had && !MAP.prop && MAP.cv) writeHash(MAP.cv.level() === 'st' ? MAP.focus : null, null);
}

// ── the property — lane B's view, through one hook ─────────────────────────
function propScreen() {
  if (!MAP.prop) return null;
  const j = MAP.journeys.get(MAP.prop.flow);
  return j && j.model ? j.model.screens[MAP.prop.index] || null : null;
}
/**
 * What the property is handed: the journey answer, its street model, which
 * screen, the lens, and the three ways back into the board.
 */
function propCtx() {
  const p = MAP.prop;
  const j = p && MAP.journeys.get(p.flow);
  return {
    data: j && j.data,
    model: j && j.model,
    screenIndex: p ? p.index : 0,
    screen: propScreen(),
    flow: p ? p.flow : null,
    lens: currentLens(),
    onClose: () => closeProperty(),
    onStep: (delta) => stepProperty(delta),
    onOpenScreen: (index) => { if (MAP.prop) openProperty(MAP.prop.flow, index); },
  };
}
/**
 * Open one screen as its property. `host` is a full-stage overlay inside the
 * surface; lane B's `surfaces/map-property.js` draws into it
 * (`mountMapProperty(host, ctx) → { update(ctx), destroy() }`), and until it
 * answers a minimal panel says which screen is open and how to go back.
 * @group Map
 */
export function openMapProperty(host, ctx) {
  const holder = { handle: null, gone: false };
  import('./map-property.js')
    .then((m) => {
      if (holder.gone) return;
      if (!m || typeof m.mountMapProperty !== 'function') throw new Error('mountMapProperty'); // str:ok an error nobody reads — the catch draws the stand-in
      holder.handle = m.mountMapProperty(host, ctx);
    })
    .catch(() => { if (!holder.gone) holder.handle = fallbackProperty(host, ctx); });
  return {
    update(c) { if (holder.handle && holder.handle.update) holder.handle.update(c); else if (!holder.handle) ctx = c; },
    destroy() { holder.gone = true; if (holder.handle && holder.handle.destroy) holder.handle.destroy(); host.innerHTML = ''; },
  };
}
/** The property before its own view exists: the screen's name, its sentence, its picture and the way back. */
function fallbackProperty(host, ctx0) {
  let ctx = ctx0;
  const draw = () => {
    const s = ctx.screen || (ctx.model && ctx.model.screens[ctx.screenIndex]);
    if (!s) { host.innerHTML = ''; return; }
    const n = ctx.model ? ctx.model.screens.length : 0;
    const thumb = s.node && s.node.design ? designThumbHtml(s.node, 'lg') : '';
    const words = sentence(s.business);
    host.innerHTML = '<div class="map-propfb" data-map-wheel="own">'
      + '<div class="head"><button type="button" class="map-tb" data-act="back">' + esc(t('map.prop.back')) + '</button>'
      + '<span class="hud-label">' + esc(t('map.level.pr')) + '</span></div>'
      + '<h2>' + esc(s.name) + '</h2>'
      + '<div class="route map-code">' + esc(s.route || '') + '</div>'
      + (words ? '<p class="biz">' + esc(words) + '</p>' : '')
      + (thumb ? '<div class="pic">' + thumb + '</div>' : '')
      + '<div class="steps"><button type="button" class="map-tb" data-act="prev"' + (ctx.screenIndex > 0 ? '' : ' disabled') + '>' + esc(t('map.prop.prev')) + '</button>'
      + '<button type="button" class="map-tb" data-act="next"' + (ctx.screenIndex < n - 1 ? '' : ' disabled') + '>' + esc(t('map.prop.next')) + '</button></div></div>';
    host.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'back') ctx.onClose();
      else if (b.dataset.act === 'prev') ctx.onStep(-1);
      else if (b.dataset.act === 'next') ctx.onStep(1);
    };
    const back = host.querySelector('[data-act="back"]');
    if (back) back.focus({ preventScroll: true });
  };
  draw();
  return { update(c) { ctx = c; draw(); }, destroy() { host.innerHTML = ''; host.onclick = null; } };
}

async function openProperty(flow, index, opts = {}) {
  if (!MAP.stage) return;
  const gen = MAP.gen;
  const j = await ensureJourney(flow);
  if (gen !== MAP.gen || !MAP.stage || !j || !j.model || !j.model.screens[index]) return;
  closeCard();
  hideTip();
  const host = MAP.stage.querySelector('.map-prop-host');
  const same = MAP.prop && MAP.prop.handle;
  MAP.prop = Object.assign(MAP.prop || {}, { flow, index, host });
  MAP.focus = flow;
  host.hidden = false;
  MAP.stage.classList.add('in-prop');
  const ctx = propCtx();
  if (same) MAP.prop.handle.update(ctx);
  else MAP.prop.handle = openMapProperty(host, ctx);
  // the street underneath stays centred on this screen, so leaving lands on it
  centreScreen(flow, index, 1.2, false);
  if (!opts.fromRoute || routeFlow(MAP.route) !== flow || (MAP.route && MAP.route.node) !== j.model.screens[index].id) writeHash(flow, j.model.screens[index].id);
  if (MAP.cv) onCanvasChange(MAP.cv.state());
}
function stepProperty(delta) {
  if (!MAP.prop) return;
  const j = MAP.journeys.get(MAP.prop.flow);
  const i = MAP.prop.index + delta;
  if (!j || !j.model || i < 0 || i >= j.model.screens.length) return;
  openProperty(MAP.prop.flow, i);
}
/**
 * Leave the property: back on the street at scale 1.0, centred on the screen
 * that was open, so the eye has somewhere to go.
 * @group Map
 */
export function closeProperty(opts = {}) {
  if (!MAP.prop) return;
  const { flow, index, host, handle } = MAP.prop;
  MAP.prop = null;
  if (handle) handle.destroy();
  if (host) { host.hidden = true; host.innerHTML = ''; }
  if (MAP.stage) MAP.stage.classList.remove('in-prop');
  if (MAP.cv) {
    centreScreen(flow, index, STREET_SCALE, false);
    onCanvasChange(MAP.cv.state());
  }
  if (!opts.keepHash) writeHash(flow, null);
  const scr = MAP.world && MAP.world.querySelector('.map-scr[data-flow="' + cssAttr(flow) + '"][data-index="' + index + '"]');
  if (scr && !opts.keepHash) scr.focus({ preventScroll: true });
}

/**
 * Zooming out over the property leaves it, as the prototype agreed: a ⌘/Ctrl
 * scroll out past a small budget lands back on the street. A plain scroll is
 * the property's own.
 */
let outBudget = 0;
function onPropWheel(e) {
  if (!MAP.prop || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  outBudget += e.deltaY > 0 ? e.deltaY : e.deltaY * 0.5;
  if (outBudget > 140) { outBudget = 0; MAP.holdWheelUntil = Date.now() + 400; closeProperty(); }
  if (outBudget < 0) outBudget = 0;
}

/** A two-finger pinch out over the property leaves it too (touch screens). */
const propPtrs = new Map();
let propPinch = null;
function onPropPointer(e) {
  if (e.type === 'pointerdown') {
    propPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (propPtrs.size === 2) { const [a, b] = [...propPtrs.values()]; propPinch = Math.hypot(a.x - b.x, a.y - b.y); }
    return;
  }
  if (e.type === 'pointermove') {
    if (!propPtrs.has(e.pointerId)) return;
    propPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (propPtrs.size === 2 && propPinch) {
      const [a, b] = [...propPtrs.values()];
      if (Math.hypot(a.x - b.x, a.y - b.y) / propPinch < 0.78) { propPinch = null; propPtrs.clear(); closeProperty(); }
    }
    return;
  }
  propPtrs.delete(e.pointerId);
  if (propPtrs.size < 2) propPinch = null;
}

// ── keyboard reach (§K) ──────────────────────────────────────────────────
//
// Tab walks the level pills, the tools, then the board in reading order: at the
// neighbourhood one stop per journey (its cover); at the street every screen, then
// each screen's calls with their data, journey after journey. What the level does
// not show is `inert` — the ghosted streets under the covers, the covers on the
// street, the board under an open screen — so Tab never lands on something hidden.

/** One district's stops for the level on screen. The numbers on a cover are read on the street, not tabbed through on the cover. */
function tabDistrict(el) {
  const nb = !MAP.cv || MAP.cv.level() === 'nb';
  const street = el.querySelector('.map-dstreet'), head = el.querySelector('.map-dhead');
  if (street) street.inert = nb;
  if (head) head.inert = nb;
  // a tip trigger without a tabindex gets one from the tooltip's observer: set it first, so it is never a stop here
  const cover = el.querySelector('.map-dcover-in');
  if (cover) cover.querySelectorAll('[tabindex],a,button,' + TIP_SELECTOR).forEach((x) => { x.tabIndex = -1; });
}
/** The stops follow the level and the open screen; redone only when either changed. */
function applyTabbing() {
  if (!MAP.world || !MAP.cv) return;
  const state = MAP.cv.level() + (MAP.prop ? '|pr' : '');
  if (state === MAP.tabState) return;
  MAP.tabState = state;
  MAP.world.querySelectorAll('.map-district').forEach(tabDistrict);
  if (MAP.board) MAP.board.inert = !!MAP.prop;
}
/** Focus an element on the board without the canvas following it — a move the map made itself. */
function focusQuiet(el) {
  if (!el) return;
  MAP.quietFocus = true;
  try { el.focus({ preventScroll: true }); } finally { MAP.quietFocus = false; }
}
/**
 * Tab moved onto something on the board: if it is off the stage (or under the chrome), the board pans until it is
 * in view, so Tab can reach the last journey of eighteen and the reader sees where the focus is.
 */
function onBoardFocus(e) {
  if (MAP.quietFocus || !MAP.cv || MAP.prop) return;
  const el = e.target.closest && e.target.closest('.map-dcover,.map-scr,.map-pl,.map-pd,.map-fold');
  if (el) revealEl(el);
}
function revealEl(el) {
  if (!MAP.cv || !MAP.board) return;
  const b = MAP.board.getBoundingClientRect(), r = el.getBoundingClientRect();
  const m = 32, top = b.top + m, bottom = b.bottom - m - 24, left = b.left + m, right = b.right - m;
  let dx = 0, dy = 0;
  if (r.width > right - left || r.left < left) dx = left - r.left; else if (r.right > right) dx = right - r.right;
  if (r.height > bottom - top || r.top < top) dy = top - r.top; else if (r.bottom > bottom) dy = bottom - r.bottom;
  if (!dx && !dy) return;
  const st = MAP.cv.state();
  MAP.cv.set(st.tx + dx, st.ty + dy, st.s, true);
  syncHashSoon();
}
/** The districts in reading order — the layout packs them in the model's order, band by band, row by row. */
function journeyIds() { return (MAP.nb.districts || []).map((d) => d.id); }
/** `h` / `l`: the previous or next journey. On the neighbourhood its cover takes the focus; on the street the board walks to its street. */
function stepJourney(delta) {
  const ids = journeyIds();
  if (!ids.length || !MAP.cv) return;
  const a = document.activeElement;
  const fromCover = a && a.matches && a.matches('.map-dcover') ? a.dataset.enter : null;
  const cur = fromCover || (a && a.closest && a.closest('.map-district') ? a.closest('.map-district').dataset.flow : null) || MAP.focus;
  const at = ids.indexOf(cur);
  const next = ids[at < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, at + delta))];
  if (!next) return;
  if (MAP.cv.level() === 'nb') {
    const cover = MAP.world && MAP.world.querySelector('.map-dcover[data-enter="' + cssAttr(next) + '"]');
    if (cover) { cover.focus({ preventScroll: true }); revealEl(cover); }
    MAP.focus = next;
    return;
  }
  closeCard();
  enterJourney(next, true);
  focusQuiet(MAP.world && MAP.world.querySelector('.map-scr[data-flow="' + cssAttr(next) + '"]'));
}
/** `j` / `k` on the street: the next or previous screen of the journey, focused and brought to the middle at the zoom the reader chose. */
function stepScreen(delta) {
  if (!MAP.cv || !MAP.world) return;
  const a = document.activeElement;
  const own = a && a.closest && a.closest('.map-scr,.map-pl,.map-pd');
  let flow = MAP.focus, index = -1;
  if (own && own.dataset.flow) { flow = own.dataset.flow; index = own.matches('.map-scr') ? +own.dataset.index : +own.dataset.si; }
  else if (MAP.near) { flow = MAP.near.dataset.flow; index = +MAP.near.dataset.index; }
  const j = flow && MAP.journeys.get(flow);
  if (!j || !j.model || !j.model.screens.length) return;
  if (index < 0) {
    // nothing focused on this street: the screen nearest the middle is where the walk starts
    const c = MAP.cv.viewCenter();
    let best = 0, bd = Infinity;
    j.model.screens.forEach((_, i) => { const p = screenPos(flow, i); const d = p ? Math.abs(p.x - c.x) : Infinity; if (d < bd) { bd = d; best = i; } });
    index = best - (delta > 0 ? 1 : -1);
  }
  const next = Math.max(0, Math.min(j.model.screens.length - 1, index + delta));
  const el = MAP.world.querySelector('.map-scr[data-flow="' + cssAttr(flow) + '"][data-index="' + next + '"]');
  closeCard();
  centreScreen(flow, next, Math.max(MAP.cv.state().s, LEVEL_NB + 0.02), true);
  focusQuiet(el);
  syncHashSoon();
}
const PAN_STEP = 80;
/** Arrow keys pan the board; with Shift a longer step. */
function panBy(key, big) {
  if (!MAP.cv) return;
  const d = PAN_STEP * (big ? 3 : 1);
  const dx = key === 'ArrowLeft' ? d : key === 'ArrowRight' ? -d : 0;
  const dy = key === 'ArrowUp' ? d : key === 'ArrowDown' ? -d : 0;
  MAP.autoFit = null;
  MAP.cv.shift(dx, dy);
  syncHashSoon();
}
/**
 * `?` on the map opens its legend. TODO(lane L): the legend panel is lane L's; when it merges this calls its toggle
 * and returns true. Until then it returns false and `?` opens the keymap panel, as everywhere else.
 */
function mapToggleLegend() { return false; }

// ── keys (keymap.js asks these, only on #/map) ────────────────────────────
/** Whether the map is the surface on screen. @group Map */
export function mapOpen() { return !!MAP.stage; }
/**
 * Esc on the map backs out one level: the card, then the property, then the
 * street, then nothing. Returns true when it used the key.
 * @group Map
 */
export function mapEscape() {
  if (!MAP.stage) return false;
  if (document.fullscreenElement && MAP.stage.contains(document.fullscreenElement) && !MAP.card && !MAP.prop) return false;
  if (MAP.card) { closeCard(); return true; }
  if (MAP.prop) { closeProperty(); return true; }
  if (MAP.cv && MAP.cv.level() === 'st') {
    const flow = MAP.focus;
    fitAll(true);
    writeHash(null, null);
    // the street is not drawn on the neighbourhood: the keyboard lands on the journey's cover
    applyTabbing();
    focusQuiet(flow && MAP.world && MAP.world.querySelector('.map-dcover[data-enter="' + cssAttr(flow) + '"]'));
    return true;
  }
  return false;
}
/**
 * The map's own keys: `p` plumbing, `+` / `-` zoom, `0` fit, `[` / `]` the
 * previous or next screen while one is open. Returns true when it used the key.
 * @group Map
 */
export function mapKey(e) {
  if (!MAP.stage) return false;
  const k = e.key;
  if (k === '?') return mapToggleLegend();
  // the open screen and the explore card keep their own keys; the board's walk keys are the board's
  const inPanel = e.target && e.target.closest && e.target.closest('.map-prop-host,.map-xcard');
  if (!MAP.prop && !inPanel) {
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') { panBy(k, e.shiftKey); return true; }
    if ((k === 'j' || k === 'k') && MAP.cv && MAP.cv.level() === 'st') { stepScreen(k === 'j' ? 1 : -1); return true; }
    if (k === 'h' || k === 'l') { stepJourney(k === 'l' ? 1 : -1); return true; }
  }
  if (k === 'p' || k === 'P') { setPlumb(!MAP.plumb); return true; }
  if (k === '+' || k === '=') { mapZoom(1.35); return true; }
  if (k === '-' || k === '_') { mapZoom(1 / 1.35); return true; }
  if (k === '0') { mapFit(); return true; }
  if (MAP.prop && (k === '[' || k === ']')) { stepProperty(k === ']' ? 1 : -1); return true; }
  return false;
}
/**
 * Where ⌘K arrives on the Map for a node (§K), or null when the board does not draw it: a flow is its street, a
 * page (or a route drawn as a screen) the street of a journey that shows it with the screen open — the journey on
 * screen first — and a route one of the journeys calls, that street with the call's card open.
 * @group Map
 */
export function mapTravel(n) {
  if (!MAP.stage || !n) return null;
  const street = (flow) => '#/map/' + encodeURIComponent(flow);
  const ds = MAP.nb.districts || [];
  if (n.kind === 'flow') return ds.some((d) => d.id === n.id) ? street(n.id) : null;
  if (n.kind !== 'page' && n.kind !== 'route') return null;
  // the journey on screen first, then the board's order
  const order = ds.map((d) => d.id).sort((a, b) => (a === MAP.focus ? -1 : b === MAP.focus ? 1 : 0));
  for (const id of order) {
    const j = MAP.journeys.get(id);
    if (j && j.model && j.model.screens.some((sc) => sc.id === n.id)) return street(id) + '?node=' + encodeURIComponent(n.id);
  }
  // a journey not walked yet: its design rows name its screens by design id
  const designId = designIdOf(n.id);
  if (designId) {
    for (const id of order) {
      const d = ds.find((x) => x.id === id);
      if (d && d.screens.includes(designId)) return street(id) + '?node=' + encodeURIComponent(n.id);
    }
  }
  for (const id of order) {
    const j = MAP.journeys.get(id);
    if (j && j.model && j.model.screens.some((sc) => sc.calls.some((c) => c.nodeId === n.id))) {
      return withParams(street(id), { plumb: '1', card: 'call:' + n.id });
    }
  }
  return null;
}
function designIdOf(nodeId) {
  for (const d of MAP.designs || []) {
    const sc = (d.screens || []).find((x) => x.nodeId === nodeId);
    if (sc && sc.designId) return sc.designId;
  }
  return null;
}

/** The node the explore card is open on — what `b` asks *what uses this?* about on the map. @group Map */
export function mapSelected() {
  if (!MAP.card || !MAP.card.tg) return null;
  return MAP.card.tg.kind === 'call' ? MAP.card.tg.call.nodeId : MAP.card.tg.data.nodeId;
}

expose({ mapFit, mapZoom });
