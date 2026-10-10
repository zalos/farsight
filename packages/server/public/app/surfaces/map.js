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

import { readinessDoorHtml } from '../lib/readiness-door.js';
import { S, esc, expose, currentLens, humanize, bizName, unCode } from '../store.js';
import { t, def, plainWords, unTick } from '../strings.js';
import { sym } from '../sym.js';
import { designThumbHtml } from '../lib/graph-render.js';
import { countedHtml, plainTip, countWords } from '../lib/counted.js';
import { tipAttrs, TIP_SELECTOR, hideTip, quietHoverTips } from '../lib/tooltip.js';
import { freshAttrs, freshSentence } from '../lib/freshness.js';
import { withParams, journeyStepHash, screenAtStep, stepOfNode } from '../lib/route-url.js';
import { doorsFor, doorsHtml, leadDoorHtml, storylineLineHtml } from '../lib/detail-doors.js';
import { flowWork, flowChipHtml } from '../work-chips.js';
import { mapCountChip, mapScreensChips, mapTestsChips, mapOwnerChip, mapErpChip, erpReached, mapEvidenceChip } from '../lib/map-chips.js';
import { neighbourhoodModel, streetModel, screensUsing, layoutDistricts, routeLinks, storesOf, boardWidth, MODE_ORDER, storylineModel, storeShownName, placeBranches, storylineEvidence, laneLayout, laneGeometry, LANE_K } from '../lib/map-model.js';
import { lanesHtml } from './map-lanes.js';
import { journeyDomain, canBandByDomain } from '../lib/codemap-model.js';
import { loadJourneyTree, jrnGroupName, screenThumbHtml } from '../lib/journeys-tree.js';
import { findStoryline, firstScreenOf } from '../lib/journeys-model.js';
import { attachCanvas, levelOf, LEVEL_NB, MAX_SCALE, SNAP_COVER, INV_MAX } from '../lib/map-canvas.js';
import { parseRoute } from '../shell.js';
import {
  onAffectedChange, affectedOn, affectedSpec, affectedHops, affectedParams, setAffected, setAffectedHops, clearAffected, resetAffected,
  paintDistrict, affectedBarHtml, screenChipReach, affectedFlows, affectedListHtml, affectedExport, affectedReady,
} from './map-affected.js';
import { shareLink } from '../share.js';
import { exportToolHtml, registerExport } from '../lib/export.js';

// ── geometry (world units) — the prototype's, so the agreed look carries over ──
// lane L widened the column (480 → 600) so a call's words and path and a data node's kind line show whole at the
// calls stop: a call wraps its name and path onto as many lines as they need (`callTextH`), never an ellipsis
const SW = 260, SH = 236, COL = 600, HEAD = 118, SY = HEAD + 36, PAD = 60;
const PL_TOP = SY + SH + 76, OPW = 250, DX = 280, DW = 280, ROW = 40, OPMIN = 68, OPGAP = 16;
/** A call node's text metrics (CSS `.map-pl`): characters per line of its name and of its path, and line heights — on the safe side, so the box is never shorter than its words. */
const CALL_NAME_CH = 31, CALL_PATH_CH = 35, CALL_NAME_LH = 16, CALL_PATH_LH = 13, CALL_CHROME_H = 36;
/** The folds (map-view.md, street fold): a call draws its first DATA_SHOWN data nodes, a screen its first CALLS_SHOWN
 * calls; the rest fold into one row — but only when that saves a row (a fold row standing in for one node does not). */
const DATA_SHOWN = 3, CALLS_SHOWN = 4, FOLD_H = 34;
const DMIN = 880;
/**
 * The board altitude draws a journey as a card, not its street (the 2026-10-04 clarity pass). The board has its own
 * layout, drawn in **board px** — the size a thing has on screen when the board fits a laptop's stage — times
 * BOARD_K world units: a card is CARD_BASE + CARD_SCREEN per screen wide, its screens clamped to two to four
 * (`boardWidth()`), and CARD_H tall — a name, one status chip and two marks — so the rows pack and the bands read
 * as bands. A cover's inside is drawn at `--map-cs` (`coverScale()`): board px at the fit, counter-scaled above it.
 */
const BOARD_K = 5;
const CARD_BASE = 48, CARD_SCREEN = 60, CARD_H = 58, COVER_MIN_SCREENS = 2, COVER_MAX_SCREENS = 4;
/** On a storyline's board, the room a card gives its first screen's picture (board px). */
const STORY_THUMB_H = 70;
/** The width a street of `n` screens takes. */
function streetW(n) { return PAD * 2 + n * COL - (COL - SW); }
/** Each altitude's layout spacing: the band header strip, the panel's inset, the gaps (world units). */
/** On a storyline's board, the room between a step's row and its branches' row: enough for the condition on the line (world units). */
const BRANCH_GAP_NB = 64 * BOARD_K;
const BAND_GEOM = {
  nb: { labelH: 30 * BOARD_K, pad: 10 * BOARD_K, bandGap: 14 * BOARD_K, colGap: 22 * BOARD_K, rowGap: 16 * BOARD_K, margin: 14 * BOARD_K },
  st: { labelH: 150, pad: 40, bandGap: 200 },
};
/** Banded by persona, each group's run of journeys starts a row after a gutter this wide, where its word sits (world units). */
const GROUP_W = { nb: 92 * BOARD_K, st: 420 };
/** The most a cover's words grow over their board px when the board is sparse (a few journeys fit large). */
const COVER_GROW_MAX = 1.25;
// the reading floor (§3.3): no word on a cover under 8 px on screen; a cover's chips are its smallest words, 10 board px
const FLOOR_PX = 8, COVER_MIN_PX = 10;
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
/** What the districts band by: `source` (the default), `domain` (docs/proposals/dependencies-and-nx.md §2.3) or `persona` (journey-organisation §4.4). */
const BAND_KEY = 'fs-map-band';
/** Set once the legend has opened by itself, so it does so on a reader's first visit only. */

/** The surface's own state. Nothing here is shared with the journey overlay. */
const MAP = {
  gen: 0,
  el: null, stage: null, board: null, world: null, links: null, cv: null,
  designs: null, failed: false,
  nb: { districts: [] },
  /** flow node id → { data, model } | { error: true } */
  journeys: new Map(),
  /** flow node id → { x, y, w, h } — the layout of the altitude on screen (`alt`) */
  geom: new Map(),
  size: { w: 0, h: 0 },
  /**
   * Which layout `geom` is: `'nb'` (the board — cards of a clamped width) or `'st'` (streets at their own width).
   * The board swaps between them where the level changes, keeping one journey still on the stage (`ensureAlt`).
   */
  alt: 'nb',
  /** both layouts, `{ nb, st }`, each `layoutDistricts()`'s answer */
  lay: null,
  /** while a programmatic move swaps the layout itself, the canvas's level does not swap it back */
  altHold: false,
  plumb: false,
  band: 'source',                   // 'source' | 'domain' | 'persona' — what the neighbourhood's bands are (persisted fs-map-band)
  /** the journeys organised persona → group (lib/journeys-tree.js), when the server or the fold answered */
  tree: null,
  /** every journey as a district — `nb` is this, or one storyline of it (`storylineModel()`) while a storyline is picked */
  nbAll: { districts: [] },
  /** the storyline the board draws (`?storyline=<id>`), or null for every journey */
  storyline: null,
  storyMenu: false,
  /** banded by persona: each group's run (`layoutDistricts()` `subs`) — where the group words sit */
  subs: [],
  /** banded by persona: echo slot id → the journey it leads to (a journey for two people, drawn once) */
  echoes: new Map(),
  focus: null,                      // the journey the street is on (the current journey: `journey` when one is open, else the nearest)
  /**
   * The journey the reader opened — a click on its cover, Enter, a deep link, ⌘K, h / l, a snap, a screen. It is
   * the current journey (crumb, ring, link, Fit, plumbing, edge cues, the Affected ring) until the reader leaves
   * it: Esc, another journey, zooming out to the board, or panning it wholly off the stage. Only while nothing is
   * open does the journey nearest the middle of the stage stand in (round 2: a wide journey opened at its fitted
   * floor has its middle off screen, and its neighbour used to win).
   */
  journey: null,
  autoFit: null,                    // a street entered from the route, refitted when its walk lands — until the reader moves
  prop: null,                       // { flow, index, host, handle }
  card: null,                       // { kind, nodeId, flow, el }
  fitted: false,
  route: null,
  /** the folds the reader opened while the board is mounted: `calls|<flow>|<si>`, `data|<flow>|<si>|<ci>` */
  open: new Set(),
  /** whether the legend panel is open */
  legend: false,
  /** how a storyline is drawn (`?layout=lanes`): `'chain'` — its journeys as cards — or `'lanes'` — swimlanes (round 2026-10-10 §2) */
  layout: 'chain',
  /** the reader went from the lanes into a journey's street: the lanes come back at the board */
  lanesAway: false,
  /** the lanes on the board: `{ model, G, size }` — `laneLayout()`, `laneGeometry()`, the size in world units */
  lanes: null,
};

/** Per-sync cache of journey answers, keyed `flowId@sync` — a register flip never refetches. */
const JOURNEY_CACHE = new Map();
function syncKey() { return (S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.sync) || ''; }
function fetchJourney(flowId) {
  const key = flowId + '@' + syncKey();
  if (!JOURNEY_CACHE.has(key)) {
    // the summary without the walk's steps: nothing on the board reads them (lane X, perf round 2026-10-05)
    JOURNEY_CACHE.set(key, fetch('/api/journey?entry=' + encodeURIComponent(flowId) + '&steps=0')
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
function sentence(s) { return biz() ? plainWords(s) : unTick(s); }
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
  // the business lens says what it is in plain words: Invoice DB · database record, Example ERP · ERP record
  if (biz()) return (storeShownName(dd.store, true) ? storeShownName(dd.store, true) + ' · ' : '') + t(dataBizKey(dd));
  if (!dd.store) return kindWord(dd.kind);
  return dd.store.name + ' · ' + (dd.kind === 'record' ? kindWord('record') : t(storeKindKey(dd.store)));
}
/** A street legend's store name in the register on screen: the legend's rows carry name and kind only, so the
 * store's own ref (its engine, how it is known) is read off a data node of the street that lives in it. */
function legendStoreName(m, st) {
  if (!biz()) return st.name;
  for (const sc of m.screens) for (const c of sc.calls) for (const d of c.data) {
    if (d.store && d.store.name === st.name && d.store.kind === st.kind) return storeShownName(d.store, true);
  }
  return storeShownName(st, true);
}
/** The business lens's word for a data node: by its store's kind when it has one, else by its own kind. */
function dataBizKey(dd) {
  if (dd.store) return 'map.biz.kind.' + storeKind(dd.store);
  return dd.kind === 'message' ? 'map.biz.kind.message' : dd.kind === 'external' ? 'map.biz.kind.external' : 'map.biz.kind.record';
}
/** Whether a call's evidence word prints: never *spec-backed* on the street, and in the business lens only the absences (*declared, not called*, *not built*). */
function evShown(ev, onCard) {
  if (ev === 'spec-backed') return !!onCard && !biz();
  return !(biz() && ev === 'implied');
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
  MAP.band = readBand();
  MAP.storyline = (route && route.storyline) || null;
  MAP.layout = routeLayout(route);
  MAP.lanesAway = false;
  MAP.storyMenu = false;
  MAP.fitted = false;
  MAP.alt = 'nb';
  MAP.lay = null;
  el.innerHTML = stageHtml();
  MAP.stage = el.querySelector('.map-stage');
  MAP.board = el.querySelector('.map-board');
  MAP.world = el.querySelector('.map-world');
  MAP.links = el.querySelector('.map-links');
  MAP.world.classList.toggle('no-plumb', !MAP.plumb);
  MAP.cv = attachCanvas(MAP.board, MAP.world, {
    onChange: onCanvasChange,
    stops: (a) => (lanesShown() ? laneStops(a) : mapStops(a)),
    // on the lanes the board is one altitude: no gesture swaps it for the streets until a screen is entered
    level: (s) => (lanesShown() ? 'nb' : levelOf(s)),
    max: () => Math.max(MAX_SCALE, enterScale() * 1.25, lanesShown() ? laneEnterScale() * 2 : 0),
    // zoom-to-enter arms only past the calls stop, on the journey the street is on (on the lanes, near a screen's own stop)
    armFrom: () => (lanesShown() ? laneEnterScale() * 0.85 : callsScale()),
    // on the lanes the targets are unscaled stand-ins for the stage cards (the engine measures offsets, and the lanes
    // layer is scaled by LANE_K), each leading to its card
    snapTargets: () => (lanesShown() ? [...MAP.world.querySelectorAll('.map-lanes-snap .ln-snap')]
      : MAP.prop || !MAP.focus ? [] : [...MAP.world.querySelectorAll('.map-scr[data-flow="' + cssAttr(MAP.focus) + '"]')]),
    onArm: (el) => onArm(lanesCard(el)),
    onSnap: (scr) => (scr.classList.contains('ln-snap') ? enterStage(lanesCard(scr)) : openScreenEl(scr)),
    onGestureEnd: () => { MAP.autoFit = null; syncHashToBoard(); },
    // the rest of a pinch out that just left a screen does not keep zooming the street
    holdWheel: () => Date.now() < (MAP.holdWheelUntil || 0),
    // a drag never leaves the board on an empty grid: some of the journeys stay on the stage (round 2)
    bounds: () => (lanesShown() && MAP.lanes ? { x: 0, y: 0, w: MAP.lanes.size.w, h: MAP.lanes.size.h } : MAP.size.w ? { x: 0, y: 0, w: MAP.size.w, h: MAP.size.h } : null),
  });
  // the board starts under the chrome row, so nothing draws beneath the toolbar
  const chrome = MAP.stage.querySelector('.map-chrome');
  if (typeof ResizeObserver === 'function') {
    MAP.chromeRO = new ResizeObserver(() => { if (MAP.stage) MAP.stage.style.setProperty('--map-chrome-h', chrome.offsetHeight + 'px'); });
    MAP.chromeRO.observe(chrome);
  }
  MAP.stage.style.setProperty('--map-chrome-h', chrome.offsetHeight + 'px');
  // the Affected mode (lane I): the bar, the dimming, the card and the property follow it
  MAP.offAffected = onAffectedChange(onAffected);
  MAP.stage.addEventListener('click', onEdgeClick);
  MAP.board.addEventListener('click', onBoardClick);
  // a zoom or a pan slides triggers under a still pointer: no hover tip opens until it has settled (round 2)
  MAP.board.addEventListener('wheel', () => quietHoverTips(460), { capture: true, passive: true });
  MAP.board.addEventListener('keydown', onBoardKey);
  MAP.board.addEventListener('pointerover', onDistrictHot);
  MAP.board.addEventListener('focusin', onDistrictHot);
  MAP.board.addEventListener('focusin', onBoardFocus);
  // the board clips the world; a focus the browser scrolls into view would slide the clip, so the canvas moves instead
  for (const el of [MAP.board, MAP.stage]) el.addEventListener('scroll', () => { el.scrollTop = 0; el.scrollLeft = 0; });
  MAP.tabState = null;
  MAP.board.addEventListener('pointerleave', () => { MAP.hot = null; linkVisibility(); });
  // where the pointer is on the stage: a zoom that crosses the level keeps the journey under it still
  MAP.board.addEventListener('pointermove', (e) => { const r = MAP.board.getBoundingClientRect(); MAP.ptr = { x: e.clientX - r.left, y: e.clientY - r.top }; }, { passive: true });
  MAP.board.addEventListener('wheel', (e) => { const r = MAP.board.getBoundingClientRect(); MAP.ptr = { x: e.clientX - r.left, y: e.clientY - r.top }; }, { capture: true, passive: true });
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
    drawRisk();
    // a call's height follows its words in the lens, so the districts re-lay (the journey in view stays put)
    relayoutKeeping(() => renderAll());
    if (MAP.legend) drawLegend();
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
  // the back button or a link moved the storyline: the board redraws before going where the route says
  if ((route.storyline || null) !== (MAP.storyline || null) && MAP.designs) applyStoryline(route.storyline || null, { fromRoute: true });
  if (routeLayout(route) !== MAP.layout && MAP.designs) setLayout(routeLayout(route), { fromRoute: true });
  applyRouteTarget(route, true);
}

/** Leave: stop every listener, every fetch's effect and the property. @group Map */
export function unmountMap() {
  MAP.gen++;
  if (MAP.offAffected) { MAP.offAffected(); MAP.offAffected = null; }
  resetAffected();
  closeCard();
  closeProperty({ keepHash: true });
  if (MAP.cv) MAP.cv.destroy();
  if (MAP.chromeRO) { MAP.chromeRO.disconnect(); MAP.chromeRO = null; }
  window.removeEventListener('resize', onResize);
  document.removeEventListener('fullscreenchange', onFullscreen);
  document.removeEventListener('click', onDocClick, true);
  if (document.fullscreenElement && MAP.stage && MAP.stage.contains(document.fullscreenElement)) document.exitFullscreen().catch(() => {});
  MAP.el = MAP.stage = MAP.board = MAP.world = MAP.links = MAP.cv = null;
  MAP.lay = null;
  MAP.alt = 'nb';
}

/**
 * True when the districts are banded by domain: the reader chose it and the graph can — some
 * source names a domain dimension and some journey has a domain. Otherwise the bands are sources.
 */
function bandingByDomain() {
  return MAP.band === 'domain' && canBandByDomain(MAP.nb.districts, S.GRAPH && S.GRAPH.nodes, S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.projects);
}
/** True when the districts are banded by persona: the reader chose it and the tree names a persona. */
function bandingByPersona() {
  return MAP.band === 'persona' && canBandByPersona();
}
/** The tree says who the journeys are for — some district has a place under a persona. */
function canBandByPersona() {
  return !!(MAP.nb.personaOrder && MAP.nb.personaOrder.length && MAP.nb.districts.some((d) => d.places && d.places.length));
}
/** *Band by: source · domain · persona* — drawn when the graph has domains or the tree has personas to band by. */
function bandToolHtml() {
  // a storyline is its own band: the choice comes back with All
  if (MAP.nb.storyline) return '';
  const dom = canBandByDomain(MAP.nb.districts, S.GRAPH && S.GRAPH.nodes, S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.projects);
  const per = canBandByPersona();
  if (!dom && !per) return '';
  const on = bandingByDomain() ? 'domain' : bandingByPersona() ? 'persona' : 'source';
  const opt = (v, key) => '<button type="button" class="map-seg' + (on === v ? ' on' : '') + '" data-act="band" data-band="' + v + '" aria-pressed="' + (on === v) + '"'
    + tipAttrs({ key, noFocus: true }) + '>' + esc(t(key)) + '</button>';
  const opts = opt('source', 'map.band.source') + (dom ? opt('domain', 'map.band.domain') : '') + (per ? opt('persona', 'map.band.persona') : '');
  // one segmented control; under 1360 px it folds to its current value, the others in a menu under it
  return '<span class="map-band-pick' + (MAP.bandMenu ? ' open' : '') + '" role="group" aria-label="' + esc(t('map.band.by')) + '">'
    + '<span class="hud-label"' + tipAttrs({ key: 'map.band.by', noFocus: true }) + '>' + esc(t('map.band.by')) + '</span>'
    + '<button type="button" class="map-tb map-band-cur" data-act="band-menu" aria-haspopup="true" aria-expanded="' + !!MAP.bandMenu + '"'
    + tipAttrs({ key: 'map.band.' + on, noFocus: true }) + '>' + esc(t('map.band.' + on)) + '</button>'
    + '<span class="map-segs">' + opts + '</span></span>';
}
/** Band the districts by source, domain or persona, keep the choice, and lay the board out again. */
function setBand(v) {
  MAP.band = v === 'domain' || v === 'persona' ? v : 'source';
  try { localStorage.setItem(BAND_KEY, MAP.band); } catch { /* private window: the choice holds for this visit */ }
  layout();
  placeDistricts();
  drawLinks();
  redrawChrome();
  fitAll(false);
}
function readBand() {
  try { const v = localStorage.getItem(BAND_KEY); return v === 'domain' || v === 'persona' ? v : 'source'; } catch { return 'source'; }
}

// ── storylines (round-2026-10-05 §2.2) ───────────────────────────────────
/**
 * *Storyline: All · <name> · …* — drawn when the tree declares a storyline. One segmented control that folds to its
 * current value and a menu on a narrower window, the way *Band by* does. A storyline's tip is its own sentence.
 */
function storylineToolHtml() {
  const list = (MAP.tree && MAP.tree.storylines) || [];
  if (!list.length) return '';
  const on = MAP.nb.storyline ? MAP.nb.storyline.id : '';
  const opt = (id, words, tip) => '<button type="button" class="map-seg' + (on === id ? ' on' : '') + '" data-act="storyline" data-storyline="' + esc(id) + '" aria-pressed="' + (on === id) + '"'
    + tipAttrs({ ...tip, noFocus: true }) + '>' + esc(words) + '</button>';
  const opts = opt('', t('map.storyline.all'), { key: 'map.storyline.all' })
    + list.map((x) => opt(x.id, x.name, { text: x.name + (x.description ? ' · ' + sentence(x.description) : '') })).join('');
  const cur = list.find((x) => x.id === on);
  return '<span class="map-story-pick' + (MAP.storyMenu ? ' open' : '') + (cur ? ' on' : '') + '" role="group" aria-label="' + esc(t('map.storyline.pick')) + '">'
    + '<span class="hud-label"' + tipAttrs({ key: 'map.storyline.pick', noFocus: true }) + '>' + esc(t('map.storyline.pick')) + '</span>'
    + '<button type="button" class="map-tb map-story-cur" data-act="storyline-menu" aria-haspopup="true" aria-expanded="' + !!MAP.storyMenu + '"'
    + tipAttrs(cur ? { text: cur.name, noFocus: true } : { key: 'map.storyline.all', noFocus: true }) + '>' + esc(cur ? cur.name : t('map.storyline.all')) + '</button>'
    + '<span class="map-segs">' + opts + '</span></span>';
}
/** The board model for the storyline in `MAP.storyline` (a storyline the tree does not declare is none). */
function storylineBoard() {
  const story = MAP.storyline ? findStoryline(MAP.tree, MAP.storyline) : null;
  // a storyline nobody declares is said so — an empty board with a sentence and the ones there are — never every
  // journey drawn as though nothing was asked (swarm-fixes 2026-10-05 §6); the link keeps what was asked
  if (MAP.storyline && !story) return { ...MAP.nbAll, districts: [], storyline: null, then: [], unknown: MAP.storyline };
  MAP.storyline = story ? story.id : null;
  return story ? storylineModel(MAP.nbAll, story) : MAP.nbAll;
}
/** The sentence for a storyline nobody declares, with a door to each one there is and one to every journey. */
function unknownStorylineHtml(id) {
  const list = (MAP.tree && MAP.tree.storylines) || [];
  const door = (sid, words, tip) => '<button type="button" class="rel map-story-door" data-storyline="' + esc(sid) + '"' + tipAttrs({ ...tip, noFocus: true }) + '>' + esc(words) + '</button>';
  return '<span class="map-story-unknown"><span' + tipAttrs({ key: 'journeys.storyline.unknown' }) + '>' + esc(t('journeys.storyline.unknown').replace('{id}', id)) + '</span>'
    + '<span class="known">' + (list.length
      ? '<span class="hud-label"' + tipAttrs({ key: 'journeys.storyline.known', noFocus: true }) + '>' + esc(t('journeys.storyline.known')) + '</span>'
        + list.map((x) => door(x.id, x.name, { text: x.name + ' · ' + x.id + (x.description ? ' · ' + sentence(x.description) : '') })).join('')
      : '<span' + tipAttrs({ key: 'journeys.storyline.noneKnown', noFocus: true }) + '>' + esc(t('journeys.storyline.noneKnown')) + '</span>')
    + door('', t('map.storyline.all'), { key: 'map.storyline.all' }) + '</span></span>';
}
/**
 * Draw one storyline (its id) or, with null, every journey again: the board keeps only that storyline's journeys,
 * in its order, as one band, with a *then* line from each to the next; the link carries it (`?storyline=`).
 * The journeys it has not read yet are read now; the Affected mode, when on, paints what is drawn.
 */
function applyStoryline(id, opts = {}) {
  MAP.storyline = id || null;
  MAP.storyMenu = false;
  if (!MAP.designs) return;
  closeCard();
  if (MAP.prop) closeProperty({ keepHash: true });
  MAP.nb = storylineBoard();
  if (MAP.journey && !MAP.nb.districts.some((d) => d.id === MAP.journey)) MAP.journey = null;
  if (MAP.focus && !MAP.nb.districts.some((d) => d.id === MAP.focus)) MAP.focus = null;
  layout();
  renderAll();
  redrawChrome();
  if (MAP.legend) drawLegend();
  fitAll(false);
  if (!opts.fromRoute) writeHash(null, null);
  fillWork(MAP.gen);
  walk(MAP.gen);
}

// ── the storyline as swimlanes (round 2026-10-10 §2) ─────────────────────
// A storyline is drawn as a chain (its journeys as cards) or as lanes (surfaces/map-lanes.js over
// lib/map-lanes-model.js laneLayout). The lanes are the board altitude of a storyline: a click on a screen, or a zoom
// into it, enters that journey's street at that screen, and the board stop (Fit, Esc, zooming out) comes back to them.
/** The layout a link names: `?layout=lanes`, else the chain. */
function routeLayout(route) {
  return route && /(?:^|[?&])layout=lanes(?:&|$)/.test(String(route.raw || '')) ? 'lanes' : 'chain';
}
/** The reader asked for the lanes and a storyline is drawn. */
function lanesWanted() { return MAP.layout === 'lanes' && !!(MAP.nb && MAP.nb.storyline); }
/** The lanes are the board on screen (not left for a street). */
function lanesShown() { return lanesWanted() && !MAP.lanesAway; }
/** *Layout: chain · lanes* — drawn beside the storyline picker while a storyline is drawn. */
function layoutToolHtml() {
  if (!MAP.nb || !MAP.nb.storyline) return '';
  const on = MAP.layout === 'lanes' ? 'lanes' : 'chain';
  const opt = (v, key) => '<button type="button" class="map-seg' + (on === v ? ' on' : '') + '" data-act="layout" data-layout="' + v + '" aria-pressed="' + (on === v) + '"'
    + tipAttrs({ key, noFocus: true }) + '>' + esc(t(key)) + '</button>';
  return '<span class="map-layout-pick" role="group" aria-label="' + esc(t('map.layout.pick')) + '">'
    + '<span class="hud-label"' + tipAttrs({ key: 'map.layout.pick', noFocus: true }) + '>' + esc(t('map.layout.pick')) + '</span>'
    + '<span class="map-segs">' + opt('chain', 'map.layout.chain') + opt('lanes', 'map.layout.lanes') + '</span></span>';
}
/** Draw the storyline as `v` (`'chain'` or `'lanes'`); the link carries it. */
function setLayout(v, opts = {}) {
  MAP.layout = v === 'lanes' ? 'lanes' : 'chain';
  MAP.lanesAway = false;
  if (!MAP.world) return;
  closeCard();
  if (MAP.prop) closeProperty({ keepHash: true });
  drawLanes();
  redrawChrome();
  fitAll(false);
  if (!opts.fromRoute) writeHash(null, null);
}
/** The lanes layer: drawn from the storyline and the journeys read so far, or removed when the chain is drawn. */
function drawLanes() {
  if (!MAP.world) return;
  let el = MAP.world.querySelector('.map-lanes');
  if (!lanesWanted()) {
    if (el) el.remove();
    const snap = MAP.world.querySelector('.map-lanes-snap');
    if (snap) snap.remove();
    MAP.lanes = null;
    MAP.world.classList.remove('lanes-on');
    return;
  }
  const story = findStoryline(MAP.tree, MAP.nb.storyline.id);
  if (!story) return;
  const sums = new Map();
  for (const [id, j] of MAP.journeys) if (j && j.data) sums.set(id, j.data);
  const model = laneLayout(story, MAP.designs, MAP.tree, sums, { byId: S.BYID });
  const b = boardSize();
  const h = Math.max(1, b.h - riskTop());
  // under the lanes: the record's strip, the footer and the legend — measured below once drawn
  const extraH = 40 + (model.lifecycles.length ? 50 : 0);
  const aspect = b.w > 0 ? b.w / h : 1.6;
  let G = laneGeometry(model, { aspect, extraH });
  if (!el) { el = document.createElement('div'); el.className = 'map-lanes'; MAP.world.appendChild(el); }
  const had = el.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  const paint = () => {
    el.style.cssText = 'width:' + G.size.w + 'px;height:' + G.size.h + 'px;transform:scale(' + LANE_K + ')';
    el.innerHTML = lanesHtml(model, G, { evidenceHtml: storyEvidenceHtml(), doorHtml: readinessDoorHtml(story.id, 'map-story-ready', story.repo), sentence });
  };
  paint();
  // what is drawn under the lanes is measured (offset sizes are layout units, untouched by the scale): when it is not
  // the height the wrap was chosen for, choose again with the real one, so the board fits as large as it can
  let bottom = el.querySelector('.ln-bottom');
  const real = bottom ? bottom.offsetHeight + 12 : extraH;
  if (Math.abs(real - extraH) > 8) { G = laneGeometry(model, { aspect, extraH: real }); paint(); bottom = el.querySelector('.ln-bottom'); }
  const need = bottom ? bottom.offsetTop + bottom.offsetHeight + G.geom.margin : G.size.h;
  if (need > G.size.h) { G.size.h = need; el.style.height = need + 'px'; }
  // the snap targets: one unscaled box per stage card, in world units, for the canvas engine to measure
  let snap = MAP.world.querySelector('.map-lanes-snap');
  if (!snap) { snap = document.createElement('div'); snap.className = 'map-lanes-snap'; snap.setAttribute('aria-hidden', 'true'); MAP.world.appendChild(snap); }
  snap.innerHTML = model.stages.map((st) => {
    const r = G.rects.get(st.key);
    return r ? '<div class="ln-snap" data-key="' + esc(st.key) + '" style="left:' + r.x * LANE_K + 'px;top:' + r.y * LANE_K + 'px;width:' + r.w * LANE_K + 'px;height:' + r.h * LANE_K + 'px"></div>' : '';
  }).join('');
  const before = MAP.lanes;
  MAP.lanes = { model, G, size: { w: G.size.w * LANE_K, h: G.size.h * LANE_K } };
  MAP.world.classList.toggle('lanes-on', lanesShown());
  if (had) { const f = el.querySelector('.ln-stage[data-key="' + cssAttr(had) + '"]'); if (f) focusQuiet(f); }
  // the board was fitted to the lanes before this journey landed: it stays fitted
  if (lanesShown() && MAP.cv && (!before || MAP.lanesFitS == null || Math.abs(MAP.cv.state().s - MAP.lanesFitS) < 0.002)) fitLanes(false);
}
let lanesT = null;
function drawLanesSoon() {
  if (!lanesWanted()) return;
  clearTimeout(lanesT);
  lanesT = setTimeout(drawLanes, 40);
}
/** Fit the lanes board on the stage, under the risk headline. */
function fitLanes(anim) {
  if (!MAP.cv || !MAP.lanes) return;
  const sz = MAP.lanes.size;
  MAP.cv.fit({ x: 0, y: 0, w: sz.w, h: sz.h }, { pad: FRAME_PAD, top: riskTop(), max: 1, anim });
  const b = boardSize();
  MAP.lanesFitS = Math.min(1, (b.w - FRAME_PAD * 2) / sz.w, (b.h - FRAME_PAD * 2 - riskTop()) / sz.h);
  writeHash(null, null);
}
/** Back from a street to the lanes: the districts hide, the lanes show. */
function backToLanes() {
  MAP.lanesAway = false;
  MAP.journey = null;
  if (MAP.prop) closeProperty({ keepHash: true });
  if (!MAP.lanes) drawLanes();
  if (MAP.world) MAP.world.classList.toggle('lanes-on', lanesShown());
}
/** The scale at which a stage card is large enough to enter (the engine's 60 % rule arms). */
function laneEnterScale() {
  const b = boardSize();
  return b.h ? (b.h * ENTER_COVER) / ((MAP.lanes ? MAP.lanes.G.geom.cardH : 104) * LANE_K) : 2.4;
}
/** The stops on the lanes: the board fitted, and a screen large enough to enter. */
function laneStops() {
  if (!MAP.lanes || !MAP.cv) return [];
  const b = boardSize(), sz = MAP.lanes.size;
  const fit = Math.min(1, (b.w - FRAME_PAD * 2) / sz.w, (b.h - FRAME_PAD * 2 - riskTop()) / sz.h);
  return [{ id: 'board', s: fit, frame: () => fitLanes(true) }, { id: 'enter', s: laneEnterScale(), frame: (a) => frameStage(a, laneEnterScale()) }];
}
/** The lanes' enter stop: the screen nearest the zoom's point centred, large enough to arm, its hint on screen. */
function frameStage(anchor, s) {
  if (!MAP.cv || !MAP.lanes) return;
  const w = MAP.cv.toWorld(anchor.x, anchor.y);
  let best = null, bd = Infinity;
  for (const st of MAP.lanes.model.stages) {
    const r = MAP.lanes.G.rects.get(st.key);
    if (!r) continue;
    const c = { x: (r.x + r.w / 2) * LANE_K, y: (r.y + r.h / 2) * LANE_K };
    const d = Math.hypot(c.x - w.x, c.y - w.y);
    if (d < bd) { bd = d; best = c; }
  }
  if (best) MAP.cv.centerOn(best.x, best.y, s, true);
}
/** The stage card a lanes snap target stands in for (any other element is itself). */
function lanesCard(el) {
  if (!el || !el.classList || !el.classList.contains('ln-snap')) return el;
  return MAP.world.querySelector('.map-lanes .ln-stage[data-key="' + cssAttr(el.dataset.key) + '"]') || null;
}
/** A stage card opened (a click, Enter, a zoom into it): that journey's street, at that screen. */
function enterStage(el) {
  if (!el) return;
  const flow = el.dataset.flow, index = +el.dataset.index;
  if (!flow || !MAP.geom.has(flow)) return;
  closeCard();
  MAP.lanesAway = true;
  MAP.world.classList.remove('lanes-on');
  ensureJourney(flow).then((j) => {
    if (!j || !j.model || !MAP.lanesAway) return;
    const i = Math.max(0, Math.min(index, j.model.screens.length - 1));
    centreScreen(flow, i, STREET_SCALE, false);
    writeHash(flow, null);
    applyTabbing();
    focusQuiet(MAP.world && MAP.world.querySelector('.map-scr[data-flow="' + cssAttr(flow) + '"][data-index="' + i + '"]'));
  });
}
/** A street entered from the lanes, zoomed out to the board: the lanes again, fitted. True when it took the change. */
function lanesReturn(st) {
  if (!MAP.lanesAway || !lanesWanted() || MAP.altHold || MAP.prop || st.level !== 'nb') return false;
  backToLanes();
  requestAnimationFrame(() => fitLanes(true));
  return true;
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
    // the organised tree (persona → group) for the persona band; a failure leaves the other two bands
    return loadJourneyTree(MAP.designs).then((got) => got && got.tree, () => null);
  }).then((tree) => {
    if (gen !== MAP.gen || !MAP.designs) return;
    MAP.tree = tree || null;
    MAP.nbAll = neighbourhoodModel(MAP.designs, null, MAP.tree);
    MAP.nb = storylineBoard();
    layout();
    renderAll();
    // the band choice is offered only once the districts say whether there are domains to band by
    redrawChrome();
    // the legend stays closed until asked for (its button, or g): opened by itself it covered a third of the board on
    // every first visit, and six of eight reviewers met it before the journeys (swarm 2026-10-05)
    // the board takes the focus when the Map opens, so the first Tab lands on a journey, not on the header (QA,
    // swarm 2026-10-05) — only when nothing else holds it, never taken from a reader who is already somewhere
    focusBoardOnOpen();
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
  drawLanesSoon();
  if (MAP.legend) drawLegend();
  drawRisk();
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
      if (de) { tabDistrict(de); foldCoverChips(de); }
    });
  }
}
const cssAttr = (s) => String(s).replace(/["\\]/g, '\\$&');

// ── the route ────────────────────────────────────────────────────────────
function decode(s) { try { return decodeURIComponent(s); } catch { return s; } }
// a street is `#/map/<flow>`; `?j=<flow>` names the same street for a link written without the path (§3.1)
function routeFlow(route) { return route && route.param ? decode(route.param) : route && route.j ? route.j : null; }

/** Go where the route says: a journey's street, or one of its screens. */
async function applyRouteTarget(route, animate) {
  if (!MAP.world || !MAP.designs) return;
  routeAffected(route);
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
      openedJourney(flow);
      applyView(view, flow, animate && MAP.fitted);
    } else {
      MAP.autoFit = MAP.journeys.has(flow) ? null : flow;
      enterJourney(flow, animate && MAP.fitted);
    }
    MAP.fitted = true;
    // `?screen=<n>` (§3.1): the street with that step's screen framed — the journey's `step`, the same number
    if (route.screen && !view) {
      const j = await ensureJourney(flow);
      if (gen !== MAP.gen || !j || !j.model) return;
      const si = screenAtStep(j.model.screens, route.screen);
      if (si != null) {
        MAP.autoFit = null;
        centreScreen(flow, si, STREET_SCALE, false);
        focusQuiet(MAP.world && MAP.world.querySelector('.map-scr[data-flow="' + cssAttr(flow) + '"][data-index="' + si + '"]'));
      }
    }
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
  const v = node || lanesShown() ? null : viewParams(flow);
  h = withParams(base + query, {
    node: node || null, plumb: MAP.plumb ? '1' : null,
    z: v ? v.z : null, x: v ? v.x : null, y: v ? v.y : null,
    card: !node && MAP.card ? MAP.card.spec : null,
    // the link names the picture from here on: `screen` and `j` were how it was arrived at
    screen: null, j: null,
    // the storyline on the board is part of the picture
    storyline: MAP.storyline || null,
    layout: MAP.storyline && MAP.layout === 'lanes' ? 'lanes' : null,
    // the Affected mode is part of the picture (lane I)
    ...affectedParams(),
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
  if (!(Number.isFinite(z) && z > 0)) return null;
  // a link that names only the zoom (`?z=0.75`) is honoured as written: framed the way the journey (or board) opens, at that scale
  return Number.isFinite(x) && Number.isFinite(y) ? { z, x, y } : { z, x: null, y: null };
}
/** Put the board where a link says: the world point (x, y) — from the journey's corner on a street — at the middle, at scale z. */
function applyView(v, flow, anim) {
  if (!MAP.cv || !v) return;
  holdingAlt(() => viewAt(v, flow, anim));
}
function viewAt(v, flow, anim) {
  // the link's point is in the layout of the altitude it names
  ensureAlt(levelOf(v.z), flow || MAP.journey || MAP.focus);
  const g = flow && MAP.geom.get(flow);
  if (v.x == null) {
    const b = boardSize();
    if (g) {
      // the journey's opening frame (its head at the top, centred across when it fits, else from its first screen), at z
      const tx = g.w * v.z <= b.w - FRAME_PAD * 2 ? (b.w - g.w * v.z) / 2 - g.x * v.z : FRAME_PAD - g.x * v.z;
      MAP.cv.set(tx, FRAME_PAD - g.y * v.z, v.z, anim);
    } else MAP.cv.centerOn(MAP.size.w / 2, MAP.size.h / 2, v.z, anim);
    return;
  }
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
/** Lines a text takes at `per` characters a line, wrapping at spaces (a word longer than a line breaks anywhere). */
function textLines(text, per) {
  let lines = 1, col = 0;
  for (const w of String(text || '').split(/\s+/).filter(Boolean)) {
    const n = w.length;
    if (col && col + 1 + n > per) { lines++; col = 0; }
    if (n > per) { lines += Math.floor((col + n) / per); col = (col + n) % per; } else col += (col ? 1 : 0) + n;
  }
  return lines;
}
/** The height a call's words and path need in the lens on screen (the business lens prints no path). */
function callTextH(c) {
  const name = textLines(callWords(c), CALL_NAME_CH) * CALL_NAME_LH;
  const path = biz() ? 0 : textLines((c.method + ' ' + c.path).trim(), CALL_PATH_CH) * CALL_PATH_LH;
  return CALL_CHROME_H + name + path;
}
function callRowH(flow, si, ci, c) {
  const cd = callData(flow, si, ci, c);
  return Math.max(OPMIN, (cd.shown.length + (cd.fold ? 1 : 0)) * ROW - 4, callTextH(c));
}
/** A screen's pathway height as drawn now — folded unless the reader opened it. */
function stackH(flow, si, s) {
  const sc = screenCalls(flow, si, s);
  const h = sc.shown.reduce((a, { c, ci }) => a + callRowH(flow, si, ci, c), 0) + Math.max(0, sc.shown.length - 1) * OPGAP;
  return sc.fold ? h + OPGAP + FOLD_H : h;
}
function districtSize(d, alt) {
  const w = Math.max(DMIN, streetW(screenCount(d)));
  // the board: a card — the street's width clamped, one height for every cover
  if (alt === 'nb') {
    const card = (n) => (CARD_BASE + n * CARD_SCREEN) * BOARD_K;
    // on a storyline's board a card also holds its first screen's picture (and a branch its condition): taller
    const h = MAP.nb.storyline ? (CARD_H + STORY_THUMB_H + (d.branch ? 22 : 0)) * BOARD_K : CARD_H * BOARD_K;
    return { w: boardWidth(card(screenCount(d)), card(COVER_MIN_SCREENS), card(COVER_MAX_SCREENS)), h };
  }
  const j = MAP.journeys.get(d.id);
  const deepest = j && j.model ? Math.max(0, ...j.model.screens.map((s, si) => stackH(d.id, si, s))) : 0;
  // without plumbing a district is its head, its screens and room below them: tall enough that a cover
  // divided by --map-inv's cap (4) still holds a two-line name, a two-line sentence and two rows of chips
  const h = MAP.plumb && deepest ? PL_TOP + deepest + 70 : SY + SH + 160;
  return { w, h };
}
/**
 * Where the districts sit: `layoutDistricts()` (lib/map-model.js) — one band per
 * source (or domain, or persona), rows that wrap at the width that brings the
 * board's shape nearest the stage's. Laid out twice: the board's cards (`nb`) and
 * the streets at their own widths (`st`); `geom` is the altitude on screen.
 */
function layout() {
  const ds = MAP.nb.districts;
  // banded by domain: each journey's domain (its flow's project, else its screens' pages), the
  // bands in word order with *no domain* last; banded by source, the model's order as it was
  const byDomain = bandingByDomain();
  const bw = MAP.board ? MAP.board.clientWidth : 0, bh = MAP.board ? MAP.board.clientHeight : 0;
  const aspect = bw > 0 && bh > 0 ? bw / bh : 1.6;
  const lay = {};
  if (MAP.nb.storyline) {
    // one storyline: its journeys in its order as one band, named by the storyline; its branches each on a row of
    // their own under the step they leave from (placeBranches), with room on the line for the condition
    const key = 'story:' + MAP.nb.storyline.id;
    const steps = ds.filter((d) => !d.branch), branches = ds.filter((d) => d.branch);
    for (const alt of ['nb', 'st']) {
      const g = { colGap: 200, rowGap: 160, margin: 80, pad: 60, ...BAND_GEOM[alt] };
      const L = layoutDistricts(steps.map((d) => ({ id: d.id, repo: d.repo || '', ...districtSize(d, alt) })), { aspect, bandKey: () => key, ...BAND_GEOM[alt] });
      lay[alt] = placeBranches(L, branches.map((d) => ({ id: d.id, of: d.branch.of, ...districtSize(d, alt) })),
        { gap: alt === 'nb' ? BRANCH_GAP_NB : g.rowGap * 3, colGap: g.colGap, margin: g.margin, pad: g.pad });
    }
    MAP.bandWords = new Map([[key, MAP.nb.storyline.name]]);
  } else if (bandingByPersona()) {
    // banded by persona: the tree's persona order, inside a band its groups then journeys — each group's run on a row
    // of its own after its word; a journey for two people draws its street once (the first band) and an echo card in
    // each other band
    for (const alt of ['nb', 'st']) {
      lay[alt] = layoutDistricts(ds.map((d) => ({ id: d.id, repo: d.repo || '', places: d.places, ...districtSize(d, alt) })),
        { aspect, bandKey: 'persona', personaOrder: MAP.nb.personaOrder, echoW: DMIN, groupRows: true, subW: GROUP_W[alt], ...BAND_GEOM[alt] });
    }
    MAP.bandWords = new Map(lay.nb.bands.map((b) => [b.repo, (MAP.nb.personas && MAP.nb.personas.get(b.repo)) || t('portfolio.noPersona')]));
  } else {
    const dom = new Map(byDomain ? ds.map((d) => [d.id, journeyDomain(d, S.GRAPH.nodes, S.GRAPH.meta && S.GRAPH.meta.projects)]) : []);
    MAP.bandWords = new Map(byDomain ? [...dom.values()].map((v) => [v.key, v.word]) : []);
    for (const alt of ['nb', 'st']) {
      let items = ds.map((d) => ({ id: d.id, repo: d.repo || '', band: byDomain ? dom.get(d.id).key : (d.repo || ''), ...districtSize(d, alt) }));
      if (byDomain) {
        const rank = (k) => (k ? 0 : 1);
        items = items.slice().sort((a, b) => rank(a.band) - rank(b.band) || String(MAP.bandWords.get(a.band)).localeCompare(String(MAP.bandWords.get(b.band))));
      }
      // the empty key is a band too when banding by domain (*no domain*), so it is never folded into the source default
      lay[alt] = layoutDistricts(items, { aspect, bandKey: (it) => (byDomain ? (it.band || '\u0000') : it.band), ...BAND_GEOM[alt] });
    }
  }
  MAP.lay = lay;
  applyGeom();
}
/** Point `geom`, `bands`, `size` and `echoes` at the layout of the altitude on screen. */
function applyGeom() {
  const L = MAP.lay && MAP.lay[MAP.alt];
  if (!L) return;
  MAP.geom = L.rects;
  MAP.bands = L.bands;
  MAP.size = L.size;
  MAP.echoes = L.echoes || new Map();
  MAP.subs = L.subs || [];
}
/** A journey's street rect, whichever altitude is on screen — what a journey's stop and frame are measured on. */
function stRect(id) { return MAP.lay && MAP.lay.st ? MAP.lay.st.rects.get(id) : MAP.geom.get(id); }
/**
 * Swap the board to the layout of altitude `alt`, keeping the journey `keepId` where it is on the stage (its
 * corner stays put; its neighbours move). Returns true when the canvas was shifted for it. The level change is
 * the stop where a card becomes a street: zooming in reveals the street from the card's corner.
 */
function ensureAlt(alt, keepId) {
  if (!MAP.lay || MAP.alt === alt) return false;
  const before = keepId && MAP.geom.get(keepId);
  MAP.alt = alt;
  applyGeom();
  placeDistricts();
  drawLinks();
  const after = keepId && MAP.geom.get(keepId);
  if (!(before && after && MAP.cv)) return false;
  const s = MAP.cv.state().s;
  const hold = MAP.altHold;
  MAP.altHold = true;
  MAP.cv.shift((before.x - after.x) * s, (before.y - after.y) * s);
  MAP.altHold = hold;
  // the shift lands before any animated move starts from it
  void MAP.world.offsetWidth;
  return true;
}
/** Run a programmatic move that sets its own altitude first: the canvas's level does not swap it back meanwhile. */
function holdingAlt(fn) {
  const hold = MAP.altHold;
  MAP.altHold = true;
  try { return fn(); } finally { MAP.altHold = hold; }
}
/** The journey that stays still when a gesture crosses the level: the one under the pointer, else the open one, else the middle's. */
function altKeep() {
  if (MAP.cv && MAP.cv.inGesture() && MAP.ptr) return journeyAt(MAP.ptr);
  if (MAP.journey && MAP.geom.has(MAP.journey)) return MAP.journey;
  const b = boardSize();
  return journeyAt({ x: b.w / 2, y: b.h / 2 });
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
    // banded by domain, a band is named by the domain's word (the config's, else the tag in words), and *no domain* is named too
    const byStory = !!MAP.nb.storyline;
    const byDomain = !byStory && bandingByDomain();
    const byPersona = !byStory && bandingByPersona();
    const named = (MAP.bands || []).filter((b) => byStory || byDomain || byPersona || b.repo);
    const word = (b) => (byStory ? MAP.nb.storyline.name
      : byPersona ? (MAP.bandWords && MAP.bandWords.get(b.repo)) || t('portfolio.noPersona')
      : byDomain ? (b.repo === '\u0000' ? t('map.band.noDomain') : (MAP.bandWords && MAP.bandWords.get(b.repo)) || b.repo) : b.repo);
    // each band a faint panel the width of the board's widest row, so the bands line up; its header names it,
    // counts its journeys and — banded by persona — says who that person is, in the words the tree carries
    const html = named.map((b) => '<div class="map-band' + (byStory ? ' story' : byDomain ? ' dom' : byPersona ? ' per' : '') + '" data-band="' + esc(b.repo) + '"'
      + ' style="left:' + b.x + 'px;top:' + b.y + 'px;width:' + b.w + 'px;height:' + b.h + 'px">' + bandHeadHtml(b, word(b), byPersona) + '</div>').join('')
      // banded by persona, each group's word at the left of its run of journeys
      + (byPersona ? (MAP.subs || []).map(groupWordHtml).join('') : '');
    // under the lines between journeys and the districts: a panel is ground, not a thing on it
    if (html && MAP.links) MAP.links.insertAdjacentHTML('beforebegin', html);
    drawEchoes();
  }
  for (const [id, g] of MAP.geom) {
    if (MAP.echoes.has(id)) continue;
    const el = districtEl(id);
    if (el) el.style.cssText = 'left:' + g.x + 'px;top:' + g.y + 'px;width:' + g.w + 'px;height:' + g.h + 'px';
  }
  if (MAP.links) { MAP.links.setAttribute('width', MAP.size.w); MAP.links.setAttribute('height', MAP.size.h); }
  // the covers' boxes follow their districts' sizes: their chip rows fold again
  foldCoverChips();
}
/** A group's word in the gutter left of its run of journeys, in a persona band: the tree's group name, or *Other journeys* in the register on screen. */
function groupWordHtml(sub) {
  const p = MAP.tree && (MAP.tree.personas || []).find((x) => x.id === sub.band);
  const g = p && (p.groups || []).find((x) => x.id === sub.key);
  const word = g ? jrnGroupName(g) : t('journeys.noGroup');
  const desc = g && g.description ? ' · ' + sentence(g.description) : '';
  return '<div class="map-band-grp" data-band="' + esc(sub.band) + '" data-group="' + esc(sub.key) + '"'
    + ' style="left:' + sub.x + 'px;top:' + sub.y + 'px;width:' + sub.w + 'px;height:' + sub.h + 'px">'
    + '<span class="w"' + tipAttrs({ text: t('map.band.group') + ' · ' + word + desc, noFocus: true }) + '>' + esc(word) + '</span></div>';
}
/** A band's header: its word, how many journeys it holds (a count with its tip) and, for a person or a storyline, its sentence. */
function bandHeadHtml(b, word, byPersona) {
  const n = typeof b.n === 'number' ? b.n : 0;
  const p = byPersona && MAP.tree && (MAP.tree.personas || []).find((x) => x.id === b.repo);
  const story = MAP.nb.storyline && findStoryline(MAP.tree, MAP.nb.storyline.id);
  const desc = p && p.description ? sentence(p.description) : story && story.description ? sentence(story.description) : '';
  return '<div class="map-band-head"><span class="w">' + esc(word) + '</span>'
    + '<span class="n"' + plainTip(n, 'map.band.journeys', story ? 'count.scope.storyline' : 'map.band.scope', byPersona || story ? '/api/journeys' : '/api/design').replace(' tabindex="0"', '') + '>'
    + esc(countWords('map.band.journeys', n)) + '</span>'
    + (story ? '<span class="ev">' + storyEvidenceHtml() + '</span>' : '')
    // the door into the storyline's release readiness brief (lane A, round 2026-10-10 — this one call site)
    + (story ? readinessDoorHtml(story.id, 'map-story-ready', story.repo) : '')
    + (desc ? '<span class="d">' + esc(desc) + '</span>' : '') + '</div>';
}
/** The storyline band's test evidence: one Counted over its journeys (storylineEvidence), with its breakdown in the tip. */
function storyEvidenceHtml() {
  const ids = MAP.nb.districts.map((d) => d.id);
  const words = new Map();
  for (const id of ids) {
    const j = MAP.journeys.get(id);
    const cov = j && j.data && j.data.summary && j.data.summary.coverage && j.data.summary.coverage.journey;
    if (cov && (cov.verdict || cov.evidenceWord)) words.set(id, (cov.verdict && cov.verdict.word) || cov.evidenceWord);
    else if (j && j.data && !j.error) words.set(id, { cls: 'none' });
  }
  return countedHtml(storylineEvidence(ids, words), '/api/journey', { cls: 'map-ev-count' });
}
/** Redraw the band's evidence count as journeys are read (one element; the band itself stays). */
function fillStoryEvidence() {
  const el = MAP.world && MAP.world.querySelector('.map-band.story .map-band-head .ev');
  if (!el) return;
  const html = storyEvidenceHtml();
  if (el.innerHTML !== html) el.innerHTML = html;
}
/**
 * Banded by persona, a journey for two people draws its street once — in the first persona's band — and in
 * every other band a card that names it and leads there: the journey is one journey, counted once.
 */
function drawEchoes() {
  if (!MAP.world) return;
  MAP.world.querySelectorAll('.map-echo').forEach((el) => el.remove());
  if (!MAP.echoes || !MAP.echoes.size) return;
  let html = '';
  for (const [slot, id] of MAP.echoes) {
    const g = MAP.geom.get(slot), home = MAP.geom.get(id);
    const d = MAP.nb.districts.find((x) => x.id === id);
    if (!g || !d) continue;
    const band = (MAP.bands || []).find((b) => home && home.y >= b.y && home.y <= b.y + b.h);
    const where = band ? (MAP.bandWords.get(band.repo) || t('portfolio.noPersona')) : '';
    const words = t('map.band.echo').replace('{name}', where);
    html += '<div class="map-echo" role="button" tabindex="0" data-echo="' + esc(id) + '" aria-label="' + esc(nameWords(d.name) + ' · ' + words) + '"'
      + ' style="left:' + g.x + 'px;top:' + g.y + 'px;width:' + g.w + 'px;height:' + g.h + 'px"'
      + tipAttrs({ key: 'map.band.echo', noFocus: true }) + '><div class="map-echo-in"><div class="nm">' + esc(nameWords(d.name)) + '</div>'
      + '<div class="go">' + esc(words) + ' ›</div></div></div>';
  }
  if (html && MAP.links) MAP.links.insertAdjacentHTML('afterend', html);
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
  // measured on the board's own layout, whichever altitude is on screen
  const size = MAP.lay && MAP.lay.nb ? MAP.lay.nb.size : MAP.size;
  if (!size.w || !b.w || !b.h) return 0;
  // the same scale fitAll() lands on, the risk headline's row included — else + from the fit went to a board stop
  // a hair above the fit, whose frame fitted the board again, and the zoom never left it
  return Math.min(LEVEL_NB * 0.9, (b.w - FRAME_PAD * 2) / size.w, (b.h - FRAME_PAD * 2 - riskTop()) / size.h);
}
/**
 * What a cover's inside (and a band's header, at the board) is scaled by: board px are BOARD_K world units, so at
 * the fit its words are as large as the board fits them (never more than COVER_GROW_MAX of their board px), and
 * zoomed in past the fit they keep that size on screen while the card grows round them — counter-scaled.
 */
function coverScale(s) {
  const fit = boardScale();
  if (!(s > 0) || !(fit > 0)) return BOARD_K;
  // the floor (§3.3): a cover's smallest words (its chips, COVER_MIN_PX in board px) never draw under FLOOR_PX on
  // screen — past it the board stops shrinking them, the card clips, and the hint says *zoom in to read*
  return Math.max(Math.min(BOARD_K, Math.min(BOARD_K * fit, COVER_GROW_MAX) / s), FLOOR_PX / COVER_MIN_PX / s);
}
/** Whether the board's fit would draw a cover's smallest words under the floor at scale s. */
function underFloor(s) {
  const fit = boardScale();
  return s > 0 && fit > 0 && Math.min(BOARD_K * fit, COVER_GROW_MAX) / s * s * COVER_MIN_PX < FLOOR_PX - 0.01;
}
/** The row the risk headline takes over the top of the board, when it shows. */
function riskTop() {
  const risk = MAP.stage && MAP.stage.querySelector('.map-risk');
  if (!risk || risk.hidden || !MAP.board) return 0;
  // from the board's top edge to under the headline: it floats a little below the toolbar
  return Math.max(0, risk.getBoundingClientRect().bottom - MAP.board.getBoundingClientRect().top) + 8;
}
function fitAll(anim) {
  if (!MAP.cv || !MAP.size.w) return;
  if (lanesWanted()) { backToLanes(); fitLanes(anim); return; }
  holdingAlt(() => fitBoard(anim));
}
function fitBoard(anim) {
  // the board draws cards: its layout first, keeping the journey that was open where it is, so the move starts from it
  ensureAlt('nb', MAP.journey || MAP.focus);
  // the risk headline sits over the top of the board: the fit leaves it its row
  MAP.cv.fit({ x: 0, y: 0, w: MAP.size.w, h: MAP.size.h }, { pad: FRAME_PAD, top: riskTop(), max: LEVEL_NB * 0.9, anim });
}
/** The height a journey's frame holds: its head and screens, and its pathways when plumbing is on. */
function frameH(g) { return MAP.plumb ? g.h : SY + SH + 70; }
/**
 * One journey fitted — its stop: fitted to its width (and its height with plumbing), never above
 * STREET_FIT_MAX and never below STREET_FIT_MIN, so a long journey keeps the street and scrolls, with an
 * edge cue saying how many screens are past the edge.
 */
function journeyScale(id) {
  const g = stRect(id);
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
  // by + / −, the journey framed as it opens; by a gesture, the least move that frames it, so the point under the
  // pointer stays as near the pointer as the frame allows (round 2: the zoom anchor drifted)
  if (id && js) out.push({ id: 'journey', s: js, frame: (a, via) => (via === 'step' ? enterJourney(id, true) : settleJourney(id)) });
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
  if (!MAP.cv || !MAP.geom.has(id)) return;
  holdingAlt(() => {
    // the street's layout first, its card's corner kept where it was, so the zoom grows out of the card
    ensureAlt('st', id);
    const g = MAP.geom.get(id);
    if (!g) return;
    openedJourney(id);
    const s = journeyScale(id);
    const b = boardSize();
    const tx = g.w * s <= b.w - FRAME_PAD * 2 ? (b.w - g.w * s) / 2 - g.x * s : FRAME_PAD - g.x * s;
    MAP.cv.set(tx, FRAME_PAD - g.y * s, s, anim);
  });
  writeHash(id, null);
}
/**
 * A gesture settled on a journey's fitted stop: the journey becomes the open one and the board makes the least move
 * that frames it — the whole district across when it fits (else no gap past either end), its head and screens
 * down — never the jump `enterJourney` makes, so what was under the pointer stays near it.
 */
function settleJourney(id) {
  const g = MAP.geom.get(id);
  if (!g || !MAP.cv) return;
  openedJourney(id);
  const st = MAP.cv.state(), s = st.s, b = boardSize();
  const span = (lo0, hi0, v) => Math.min(Math.max(v, Math.min(lo0, hi0)), Math.max(lo0, hi0));
  // across: fits → the district wholly in view; wider → no empty stage past its first or last screen
  const tx = span(b.w - FRAME_PAD - (g.x + g.w) * s, FRAME_PAD - g.x * s, st.tx);
  // down: the head never above the top; the frame (head, screens, pathways with plumbing) in view when it fits
  const fh = frameH(g) * s;
  const ty = fh <= b.h - FRAME_PAD * 2 ? span(b.h - FRAME_PAD - (g.y * s + fh), FRAME_PAD - g.y * s, st.ty) : Math.min(st.ty, FRAME_PAD - g.y * s);
  if (Math.abs(tx - st.tx) > 0.5 || Math.abs(ty - st.ty) > 0.5) MAP.cv.set(tx, ty, s, true);
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
  if (!MAP.cv) return;
  holdingAlt(() => {
    ensureAlt(levelOf(scale), flow);
    const p = screenPos(flow, index);
    if (!p) return;
    openedJourney(flow);
    MAP.cv.centerOn(p.x, p.y + (MAP.plumb ? 200 : 0), scale, anim);
  });
}

/** A journey the reader opened becomes the current journey (see `MAP.journey`). */
function openedJourney(id) {
  if (!id) return;
  MAP.journey = id;
  MAP.focus = id;
}
/** Whether any of a journey's district is on the stage. */
function journeyInView(id) {
  const g = MAP.geom.get(id);
  if (!g || !MAP.cv) return false;
  const c = MAP.cv.viewCenter();
  return g.x < c.x + c.w / 2 && c.x - c.w / 2 < g.x + g.w && g.y < c.y + c.h / 2 && c.y - c.h / 2 < g.y + g.h;
}
/**
 * The current journey's name never leaves the stage: on the street its head's words slide right with the stage's
 * left edge (in world units), as far as the district's end allows — a wide journey zoomed at its far end still
 * says whose screens these are (round 2: the title was clipped at the left edge).
 */
function stickHead(st) {
  const prev = MAP.world.querySelectorAll('.map-dhead.stuck');
  const g = st.level === 'st' && !MAP.prop && MAP.focus ? MAP.geom.get(MAP.focus) : null;
  const head = g && districtEl(MAP.focus) && districtEl(MAP.focus).querySelector('.map-dhead');
  prev.forEach((h) => { if (h !== head) { h.classList.remove('stuck', 'stuck-y'); h.style.removeProperty('--head-x'); h.style.removeProperty('--head-y'); } });
  if (!head) return;
  const left = -st.tx / st.s + 12 / st.s - g.x;
  // the words' own width (the name is a block as wide as the district), measured once per name in world units
  const words = head.querySelector('.nm');
  if (words && !(+head.dataset.nmw > 0)) {
    // offset sizes are layout units, untouched by the world's transform or an animation in flight
    words.style.width = 'max-content';
    head.dataset.nmw = String(words.offsetWidth);
    words.style.width = '';
  }
  const room = g.w - Math.max(+head.dataset.nmw || 0, 320) - 44;
  const x = Math.max(0, Math.min(left, room));
  // down: the name line alone rides the stage's top edge (with a ground behind it), never below the district
  const top = -st.ty / st.s + 6 / st.s - g.y - 14;
  const y = Math.max(0, Math.min(top, g.h - 60));
  head.classList.toggle('stuck', x > 0 || y > 0);
  head.classList.toggle('stuck-y', y > 0);
  head.style.setProperty('--head-x', x.toFixed(1) + 'px');
  head.style.setProperty('--head-y', y.toFixed(1) + 'px');
}
function onCanvasChange(st) {
  if (!MAP.stage) return;
  if (lanesReturn(st)) return;
  // a gesture crossed the level: the other layout, the journey under the pointer kept still (its shift redraws all this)
  if (!MAP.altHold && MAP.lay && st.level !== MAP.alt) {
    const keep = altKeep();
    // zooming into a card opens that journey: the street that grows out of it is the one the stops frame
    if (st.level === 'st' && keep) openedJourney(keep);
    if (ensureAlt(st.level, keep)) return;
  }
  const lvl = MAP.prop ? 'pr' : st.level;
  MAP.world.style.setProperty('--map-cs', String(coverScale(st.s)));
  MAP.world.classList.toggle('lvl-nb', st.level === 'nb');
  MAP.world.classList.toggle('lvl-st', st.level !== 'nb');
  MAP.world.classList.toggle('floor', st.level === 'nb' && underFloor(st.s));
  MAP.stage.querySelectorAll('.map-lvls button').forEach((b) => {
    const on = b.dataset.l === lvl;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  // a drag or a pinch slides triggers under the pointer too
  if (MAP.cv && MAP.cv.inGesture()) quietHoverTips(300);
  const zr = MAP.stage.querySelector('.map-zoomro');
  if (zr) zr.textContent = '×' + st.s.toFixed(2);
  // the board is no journey's: whatever was open is left
  if (st.level === 'nb' && !MAP.prop) MAP.journey = null;
  // a journey the reader opened stays the current one while any of it is on the stage; panned wholly off, it is left
  if (st.level === 'st' && !MAP.prop && MAP.journey && !journeyInView(MAP.journey)) { MAP.leftJourney = MAP.journey; MAP.journey = null; }
  if (st.level === 'nb' || MAP.journey) MAP.leftJourney = null;
  if (st.level === 'st' && !MAP.prop && MAP.journey) MAP.focus = MAP.journey;
  // nothing open: the journey nearest the middle of the screen stands in
  else if (st.level === 'st' && !MAP.prop) {
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
  stickHead(st);
  linkVisibility();
  // the covers' boxes follow the counter-scale; their chip rows re-fold when it has moved
  const inv = Math.min(1 / st.s, INV_MAX);
  if (st.level === 'nb' && Math.abs(inv - (MAP.foldInv || 0)) > 0.08) { MAP.foldInv = inv; foldCoverChips(); }
  drawCrumb();
  drawHint(st);
  applyTabbing();
  drawEdges(st);
  const risk = MAP.stage.querySelector('.map-risk');
  if (risk) risk.classList.toggle('off', st.level !== 'nb' || !!MAP.prop);
}
/**
 * The risk headline above the board (round 2): how many journeys are stale, not fully built, or reach the ERP —
 * each a Counted from the facts the covers print, over every journey on the board, shown once every walk has landed.
 */
function riskCounteds() {
  const ds = MAP.nb.districts || [];
  if (!ds.length || ds.some((d) => !MAP.journeys.has(d.id))) return null;
  let stale = 0, notBuilt = 0, erp = 0;
  const why = new Map();
  for (const d of ds) {
    const j = MAP.journeys.get(d.id);
    const sum = j && j.data && j.data.summary;
    if (!sum) continue;
    const ew = sum.coverage && sum.coverage.journey && sum.coverage.journey.evidenceWord;
    if (ew && ew.cls === 'stale') {
      stale++;
      // the comparison behind each *stale*, by its sentence: said once on the bar when every one shares it
      const f = sum.coverage.journey.freshness;
      if (f && f.state === 'stale') why.set(d.id, f);
    }
    const b = sum.counted && sum.counted.built;
    if (b && b.of != null && b.n < b.of) notBuilt++;
    if (erpReached(sum)) erp++;
  }
  const src = 'surfaces/map.js riskCounteds ← each /api/journey summary (coverage.journey.evidenceWord · counted.built · systems)';
  const c = (n, unit) => ({ n, unit, bizUnit: unit, scope: 'count.scope.workspace', source: src });
  const out = [c(stale, 'count.unit.riskStale'), c(notBuilt, 'count.unit.riskNotBuilt'), c(erp, 'count.unit.riskErp')];
  // every stale journey compared with one code: name it once on the bar, with the newest run among them
  const facts = [...why.values()];
  const codes = new Set(facts.map((f) => (f.codeAt && f.codeAt.commit) || ''));
  if (facts.length && facts.length === stale && codes.size === 1 && !codes.has('') && facts[0].codeAt.sync != null) {
    const newest = facts.reduce((a, f) => (!a || (f.ranAt || '') > (a.ranAt || '') ? f : a), null);
    out[0].fresh = Object.assign({}, newest, { key: 'fresh.risk.against', biz: 'journey.biz.fresh.riskAgainst' });
  }
  return out;
}
function drawRisk() {
  const el = MAP.stage && MAP.stage.querySelector('.map-risk');
  if (!el) return;
  const k = riskCounteds();
  if (!k || !k.some((x) => x.n)) { el.hidden = true; el.innerHTML = ''; return; }
  el.innerHTML = '<span class="hud-label"' + tipAttrs({ key: 'map.risk.title', noFocus: true }) + '>' + esc(t('map.risk.title')) + '</span>'
    + k.filter((x) => x.n).map((x) => countedHtml(x, '/api/journey', { cls: 'map-chip k-warn' })
      // *stale* said once, with what it compares, when every stale journey shares one comparison
      + (x.fresh ? '<span class="map-risk-why"' + freshAttrs(x.fresh, { noFocus: true }) + '>' + esc(freshSentence(x.fresh)) + '</span>' : '')).join('<span class="sep">·</span>');
  const appeared = el.hidden;
  // whether the board sits at its fit — asked before the headline shows, since the fit then leaves it its row
  const at = appeared && MAP.cv && !MAP.prop && MAP.cv.level() === 'nb' ? MAP.cv.stopAt() : null;
  el.hidden = false;
  // it arrived over a board fitted without it: fit again, leaving it its row
  if (at && at.id === 'board') fitAll(false);
}
/** The screen a zoom in would enter, ringed and named in the hint first, so the snap is never a surprise. */
function onArm(el) {
  MAP.world.querySelectorAll('.map-scr.near,.ln-stage.near').forEach((n) => { if (n !== el) n.classList.remove('near'); });
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
  const backTo = e.target.closest && e.target.closest('.map-backto');
  if (backTo && backTo.dataset.flow) { e.stopPropagation(); MAP.leftJourney = null; enterJourney(backTo.dataset.flow, true); return; }
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
    + '<div class="map-risk" hidden></div>'
    + '<div class="map-hint" aria-live="polite"></div>'
    + '<button type="button" class="map-backto" hidden></button>'
    + '<div class="map-zoomro"' + tipAttrs({ key: 'map.zoom', noFocus: true }) + '></div>'
    + '<div class="map-legend" hidden role="dialog" aria-label="' + esc(t('map.legend.title')) + '"></div>'
    + '<div class="map-afflist" hidden role="dialog" data-map-wheel="own" aria-label="' + esc(t('map.affected.listTitle')) + '"></div>'
    + '<div class="map-toast" role="status" aria-live="polite" hidden></div>'
    + '<div class="map-prop-host" hidden></div>'
    + '</div><div class="map-xcard" hidden role="dialog"></div></div>';
}
function chromeHtml() {
  // under 1360 px a level button is its glyph and one word (the whole name stays its label and its tip)
  const lvl = (l, key, glyph) => '<button type="button" data-l="' + l + '" aria-pressed="false" aria-label="' + esc(t(key)) + '"' + tipAttrs({ key, noFocus: true }) + '>'
    + '<span class="lv-full">' + esc(t(key)) + '</span><span class="lv-short">' + sym(glyph) + esc(t(key + '.short')) + '</span></button>';
  const tool = (act, key, label, extra) => '<button type="button" class="map-tb' + (extra || '') + '" data-act="' + act + '" aria-label="' + esc(t(key)) + '"' + tipAttrs({ key, noFocus: true }) + '>' + label + '</button>';
  return '<div class="map-lvls" role="group" aria-label="' + esc(t('map.levels')) + '">'
    + lvl('nb', 'map.level.nb', 'interchange') + lvl('st', 'map.level.st', 'step') + lvl('pr', 'map.level.pr', 'screen') + '</div>'
    + '<div class="map-crumb"></div>'
    + '<span class="map-asof"></span>'
    + '<div class="map-tools">'
    + storylineToolHtml()
    + layoutToolHtml()
    + bandToolHtml()
    + tool('plumb', 'map.tool.plumb', esc(t('map.tool.plumb')), MAP.plumb ? ' on' : '')
    + tool('in', 'map.tool.zoomIn', '+')
    + tool('out', 'map.tool.zoomOut', '−')
    + tool('fit', 'map.tool.fit', esc(t('map.tool.fit')))
    + tool('full', 'map.tool.full', esc(t('map.tool.full')))
    + tool('link', 'map.tool.link', esc(t('map.tool.link')))
    + exportToolHtml('map', 'map-tb map-tb-save')
    // the legend has a glyph of its own — `?` is the keymap's, everywhere (swarm 2026-10-05: `?` had four jobs)
    + tool('legend', 'map.tool.legend', sym('legend'), MAP.legend ? ' on map-tb-legend' : ' map-tb-legend')
    + '</div>'
    // the Affected mode's bar, a row of its own under the toolbar (lane I)
    + affectedBarHtml();
}
function redrawChrome() {
  const c = MAP.stage && MAP.stage.querySelector('.map-chrome');
  if (!c) return;
  c.innerHTML = chromeHtml();
  if (MAP.cv) onCanvasChange(MAP.cv.state());
  fitChrome();
}
/**
 * Fold the toolbar until it fits its stage — measured, never a breakpoint. The
 * breakpoints it replaced were each true for one toolbar: at 1440 px with a
 * storyline picker, the as-of stamp and the full level names still showed and
 * the legend button fell off the right edge, while 1280 (past the next
 * breakpoint) fitted (swarm 2026-10-05, QA and exec). The rungs, least needed
 * first: the storyline picker and Band by fold to their current value and a
 * menu · the as-of stamp goes (its sync is in the header's chip) · the level
 * buttons shorten to a glyph and a word · and, only on a window too narrow for
 * all of that, the tools wrap to a second row.
 * @group Map
 */
const CHROME_FOLDS = ['f-story', 'f-band', 'f-asof', 'f-lvl', 'f-wrap'];
function fitChrome() {
  const c = MAP.stage && MAP.stage.querySelector('.map-chrome');
  if (!c) return;
  c.classList.remove(...CHROME_FOLDS);
  // the crumb is measured at its own width (it said *JOU* when it was the thing squeezed): a tool folds before
  // the trail that says where the reader is gives way; past the last rung its ellipsis and tip are the backstop
  const crumb = c.querySelector('.map-crumb');
  if (crumb) crumb.style.flexShrink = '0';
  // measured as one row: a chrome that may wrap (narrow windows, the Affected bar's own row) never overflows, so
  // its first row is measured with the wrap and the Affected bar set aside
  const aff = c.querySelector('.map-affbar');
  c.style.flexWrap = 'nowrap';
  if (aff) aff.style.display = 'none';
  const fits = () => c.scrollWidth <= c.clientWidth + 1;
  for (const f of CHROME_FOLDS) {
    if (fits()) break;
    c.classList.add(f);
  }
  c.style.flexWrap = c.classList.contains('f-wrap') ? 'wrap' : '';
  if (aff) aff.style.display = '';
  if (crumb) crumb.style.flexShrink = '';
  if (MAP.stage) MAP.stage.style.setProperty('--map-chrome-h', c.offsetHeight + 'px');
}
/** The board takes the focus on open when nothing else has it (a link's target or a reader's click keeps theirs). */
function focusBoardOnOpen() {
  if (!MAP.board) return;
  const a = document.activeElement;
  if (a && a !== document.body && a !== document.documentElement) return;
  if (!MAP.board.hasAttribute('tabindex')) MAP.board.setAttribute('tabindex', '-1');
  MAP.board.focus({ preventScroll: true });
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
  // on a narrow stage the journey's name may ellipsize: the trail is whole in its tip
  const whole = el.ownerDocument.createElement('div');
  whole.innerHTML = html;
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = '<span' + tipAttrs({ text: whole.textContent.replace(/›/g, ' › '), noFocus: true }) + '>' + html + '</span>';
    fitChrome();
  }
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
    // the stamp changed the toolbar's width: fold again
    fitChrome();
  }
}
function drawHint(st) {
  const el = MAP.stage && MAP.stage.querySelector('.map-hint');
  if (!el) return;
  let text;
  if (MAP.prop) text = t('map.hint.pr');
  else if (st.level === 'nb' && underFloor(st.s)) {
    // the board is past its reading floor: say how many journeys share it, and that zooming in reads them (§3.3)
    const n = (MAP.nb.districts || []).length;
    const words = t('map.floor.read').split('{n}');
    const html = esc(words[0]) + '<span class="n"' + plainTip(n, 'map.floor.read', 'map.floor.scope', '/api/design').replace(' tabindex="0"', '') + '>' + n + '</span>' + esc(words.slice(1).join(String(n)));
    if (el.dataset.floor !== html) { el.innerHTML = html; el.dataset.floor = html; }
    el.classList.add('floor');
    el.classList.remove('enter');
    return drawBackTo(st);
  }
  else if (st.level === 'nb') text = t(lanesShown() ? 'lanes.hint' : 'map.hint.nb');
  else if (MAP.near) text = t('map.hint.near').replace('{name}', MAP.near.dataset.name || '');
  else text = t('map.hint.st');
  if (el.textContent !== text || el.dataset.floor) el.textContent = text;
  delete el.dataset.floor;
  el.classList.remove('floor');
  // the snap is about to be possible: the hint says so in the accent before any zoom can enter
  el.classList.toggle('enter', !MAP.prop && st.level !== 'nb' && !!MAP.near);
  drawBackTo(st);
}
/** The journey the reader opened is wholly off the stage: a way back to it beside the hint (round 2). */
function drawBackTo(st) {
  const el = MAP.stage && MAP.stage.querySelector('.map-hint');
  if (!el) return;
  const back = MAP.stage.querySelector('.map-backto');
  const left = !MAP.prop && st.level !== 'nb' && MAP.leftJourney && MAP.nb.districts.find((x) => x.id === MAP.leftJourney);
  if (back) {
    back.hidden = !left;
    if (left) {
      const words = t('map.backTo').replace('{name}', nameWords(left.name));
      if (back.textContent !== words) back.textContent = words;
      back.dataset.flow = left.id;
      back.style.left = (el.offsetLeft + el.offsetWidth + 8) + 'px';
    }
  }
}

function onChromeClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.l) { goLevel(b.dataset.l); return; }
  switch (b.dataset.act) {
    case 'plumb': setPlumb(!MAP.plumb); break;
    case 'legend': toggleLegend(); break;
    case 'in': mapZoom(1.35); break;
    case 'out': mapZoom(1 / 1.35); break;
    case 'fit': mapFit(); break;
    case 'full': toggleFull(); break;
    case 'link': mapCopyLink(); break;
    case 'aff-clear': clearAffected(); break;
    case 'aff-fit': fitAffected(true); break;
    case 'aff-list': toggleAffList(); break;
    case 'aff-hops': setAffectedHops(+b.dataset.h); break;
    case 'band': MAP.bandMenu = false; setBand(b.dataset.band); break;
    case 'storyline': applyStoryline(b.dataset.storyline || null); break;
    case 'layout': setLayout(b.dataset.layout); break;
    case 'storyline-menu': MAP.storyMenu = !MAP.storyMenu; MAP.bandMenu = false; redrawChrome(); if (MAP.storyMenu) { const f = MAP.stage.querySelector('.map-story-pick .map-seg.on') || MAP.stage.querySelector('.map-story-pick .map-seg'); if (f) f.focus(); } break;
    case 'band-menu': MAP.bandMenu = !MAP.bandMenu; MAP.storyMenu = false; redrawChrome(); if (MAP.bandMenu) { const f = MAP.stage.querySelector('.map-band-pick .map-segs .map-seg'); if (f) f.focus(); } break;
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
  fitChrome();
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
  // the pathways grow downward: a journey whose head now sits below its framed place comes up to it, so the
  // stage never shows an empty band above the street (round 2)
  if (!MAP.prop && MAP.cv && MAP.cv.level() === 'st' && MAP.journey) {
    const g = MAP.geom.get(MAP.journey);
    const st = MAP.cv.state();
    if (g && g.y * st.s + st.ty > FRAME_PAD + 1) MAP.cv.shift(0, FRAME_PAD - (g.y * st.s + st.ty));
  }
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
    // the hint line is easy to miss: a toast by the tools says it too, in every path (round 2)
    toast(t(key));
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
  // while the board is dimmed around something, Fit frames what reaches it (round 2)
  if (!MAP.prop && fitAffected(true)) { closeCard(); return; }
  closeCard();
  const flow = MAP.prop ? MAP.prop.flow : MAP.cv.level() === 'st' ? MAP.focus : null;
  closeProperty({ keepHash: true });
  if (flow && MAP.geom.has(flow)) { enterJourney(flow, true); return; }
  fitAll(true);
  writeHash(null, null);
}

/**
 * Fit-to-affected: frame the districts of the journeys that reach the thing picked — at most the board's own stop,
 * so they draw as covers — and the link follows. False when the mode has no reached journey on the board.
 */
function fitAffected(anim) {
  if (!MAP.cv || !affectedReady()) return false;
  const flows = affectedFlows().filter((f) => MAP.geom.has(f));
  if (!flows.length) return false;
  // one journey reached: its own stop, the street; several: as large as covers allow
  if (flows.length === 1) { enterJourney(flows[0], anim); return true; }
  holdingAlt(() => {
    ensureAlt('nb', MAP.journey || MAP.focus);
    const rects = flows.map((f) => MAP.geom.get(f)).filter(Boolean);
    const x0 = Math.min(...rects.map((r) => r.x)), y0 = Math.min(...rects.map((r) => r.y));
    const x1 = Math.max(...rects.map((r) => r.x + r.w)), y1 = Math.max(...rects.map((r) => r.y + r.h));
    MAP.cv.fit({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, { pad: FRAME_PAD, max: LEVEL_NB * 0.9, anim });
  });
  writeHash(null, null);
  return true;
}

// ── the Affected list (round 2) ──────────────────────────────────────────
/** The board's words for a journey, for the list: its name in the lens, its owner. */
const affBoard = {
  owner: (f) => { const d = (MAP.nb.districts || []).find((x) => x.id === f); return (d && d.owner) || ''; },
  name: (f) => { const d = (MAP.nb.districts || []).find((x) => x.id === f); return d ? nameWords(d.name) : ''; },
};
function toggleAffList(force) {
  const box = MAP.stage && MAP.stage.querySelector('.map-afflist');
  if (!box) return;
  const open = force != null ? force : box.hidden;
  MAP.affList = open && affectedOn();
  if (!MAP.affList) { box.hidden = true; box.innerHTML = ''; return; }
  if (MAP.legend) closeLegend();
  drawAffList();
}
function drawAffList() {
  const box = MAP.stage && MAP.stage.querySelector('.map-afflist');
  if (!box || !MAP.affList) return;
  box.innerHTML = affectedListHtml(affBoard);
  box.hidden = false;
  box.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'aff-list-close') toggleAffList(false);
    else if (b.dataset.act === 'aff-copy') copyAffected(b.dataset.kind, box);
  };
}
/** Copy the list's rows as CSV or JSON: the clipboard, else a copy command, else a selected field in the panel. */
function copyAffected(kind, box) {
  const { text, n } = affectedExport(kind, affBoard);
  copyText(text, (how) => {
    const note = box.querySelector('.al-copied');
    if (how === 'field') {
      let f = box.querySelector('.al-field');
      if (!f) { f = document.createElement('textarea'); f.className = 'al-field'; f.readOnly = true; f.setAttribute('aria-label', t('map.affected.copyField')); box.appendChild(f); }
      f.value = text; f.focus(); f.select();
    }
    const words = how === 'none' ? t('map.affected.copyFailed') : how === 'field' ? t('map.affected.copyField') : t('map.affected.copiedRows').replace('{n}', String(n));
    if (note) note.textContent = words;
    toast(words);
  });
}
/**
 * Copy text: the clipboard, then `execCommand('copy')`, then — when neither takes it — the caller's own field.
 * `done(how)`: 'clipboard' · 'command' · 'field'.
 */
function copyText(text, done) {
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    done(ok ? 'command' : 'field');
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => done('clipboard'), fallback);
    else fallback();
  } catch { fallback(); }
}
let toastT = null;
/** A confirmation near the tools, on screen for 2 s, whatever path the copy took (round 2). */
function toast(words) {
  const el = MAP.stage && MAP.stage.querySelector('.map-toast');
  if (!el) return;
  el.textContent = words;
  el.hidden = false;
  el.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => { el.classList.remove('on'); el.hidden = true; }, 2000);
}

// ── the legend (lane L) ──────────────────────────────────────────────────
/** Open or close the legend (the `?` tool). @group Map */
export function toggleLegend() { if (MAP.legend) closeLegend(); else openLegend(); }
function openLegend(opts = {}) {
  MAP.legend = true;
  MAP.legendAuto = !!opts.auto;
  MAP.legendCollapsed = !!opts.collapsed;
  if (MAP.affList) toggleAffList(false);
  drawLegend();
  const b = MAP.stage && MAP.stage.querySelector('[data-act="legend"]');
  if (b) { b.classList.add('on'); b.setAttribute('aria-expanded', 'true'); }
}
function closeLegend() {
  MAP.legend = false;
  const box = MAP.stage && MAP.stage.querySelector('.map-legend');
  if (box) { box.hidden = true; box.innerHTML = ''; }
  const b = MAP.stage && MAP.stage.querySelector('[data-act="legend"]');
  if (b) { b.classList.remove('on'); b.setAttribute('aria-expanded', 'false'); }
}
/** What the board has drawn so far, so the legend lists only that. */
function legendFacts() {
  const f = { links: new Set(), modes: new Set(), stores: new Map(), again: false, planned: false, built: false, times: false, ev: new Set(), evidence: new Map(), calls: false };
  if (MAP.links) MAP.links.querySelectorAll('g[data-link]').forEach((g) => f.links.add(g.dataset.both ? 'both' : g.dataset.link));
  for (const j of MAP.journeys.values()) {
    if (!j || !j.model) continue;
    for (const st of storesOf(j.model)) if (!f.stores.has(storeKind(st))) f.stores.set(storeKind(st), st);
    for (const s of j.model.screens) {
      if (s.state === 'planned') f.planned = true; else f.built = true;
      if ((s.gates || []).some((g) => g.count > 1)) f.times = true;
      for (const c of s.calls) {
        f.calls = true;
        if (c.repeat) f.again = true;
        if (c.evidence !== 'spec-backed') f.ev.add(c.evidence);
        for (const d of c.data) f.modes.add(d.mode);
      }
    }
    const ew = j.data && j.data.summary && j.data.summary.coverage && j.data.summary.coverage.journey && j.data.summary.coverage.journey.evidenceWord;
    if (ew && ew.key && !f.evidence.has(ew.key)) f.evidence.set(ew.key, ew);
  }
  return f;
}
/** One row: a swatch drawn with the board's own classes (so it cannot describe a line the board does not draw), its word, and a sentence. */
function lgRow(kind, swatch, key, sayKey) {
  return '<div class="lg-row" data-lg="' + esc(kind) + '"><span class="sw">' + swatch + '</span>'
    + '<span class="w"' + tipAttrs({ key, noFocus: true }) + '>' + esc(t(key)) + '</span>'
    + (sayKey ? '<span class="say">' + esc(t(sayKey)) + '</span>' : '') + '</div>';
}
function lgLine(kind, both) {
  const head = kind === 'partOf' ? '' : '<path class="head" d="M35 2 L41 6 L35 10"/>' + (both ? '<path class="head" d="M9 2 L3 6 L9 10"/>' : '');
  return '<svg class="map-links map-lgsw" viewBox="0 0 44 12" aria-hidden="true"><g data-link="' + kind + '" class="hot"><path class="ln' + (kind === 'partOf' ? ' contains' : '') + '" d="M3 6 L41 6"/>' + head + '</g></svg>';
}
function lgFlow(mode) {
  const cls = 'plumb ' + (mode === 'read' ? 'read' : mode === 'reached' ? 'reached' : 'write');
  const toCall = '<path class="' + cls + '" d="M9 2 L3 6 L9 10"/>', toData = '<path class="' + cls + '" d="M35 2 L41 6 L35 10"/>';
  return '<svg class="map-edges map-lgsw" viewBox="0 0 44 12" aria-hidden="true"><path class="' + cls + '" d="M3 6 L41 6"/>'
    + (mode === 'reached' ? '' : (mode !== 'write' ? toCall : '') + (mode !== 'read' ? toData : '')) + '</svg>';
}
function lgHead(key) { return '<div class="lg-h hud-label"' + tipAttrs({ key, noFocus: true }) + '>' + esc(t(key)) + '</div>'; }
function drawLegend() {
  const box = MAP.stage && MAP.stage.querySelector('.map-legend');
  if (!box || !MAP.legend) return;
  const f = legendFacts();
  let html = '<div class="lg-top"><span class="hud-label"' + tipAttrs({ key: 'map.legend.title', noFocus: true }) + '>' + esc(t('map.legend.title')) + '</span>'
    + (MAP.legendCollapsed ? '<button type="button" class="more" data-act="legend-expand"' + tipAttrs({ key: 'map.legend.expand', noFocus: true }) + '>' + esc(t('map.legend.expand')) + '</button>' : '')
    + '<button type="button" class="x" data-act="legend-close" aria-label="' + esc(t('map.legend.close')) + '">✕</button></div>';
  // between journeys: leads to (its mirror, requires, is the same line read backwards), each other, part of
  const between = [];
  if (f.links.has('leadsTo') || !f.links.size) between.push(lgRow('leadsTo', lgLine('leadsTo'), 'map.link.leadsTo') + lgRow('requires', lgLine('leadsTo'), 'map.link.requires', 'map.legend.requires'));
  if (f.links.has('both')) between.push(lgRow('mutual', lgLine('leadsTo', true), 'map.link.both'));
  if (f.links.has('partOf')) between.push(lgRow('partOf', lgLine('partOf'), 'map.link.partOf'));
  if (f.links.has('then')) between.push(lgRow('then', lgLine('then'), 'map.link.then'));
  html += '<section>' + lgHead('map.legend.between') + between.join('') + '</section>';
  // under each screen: what a call does to the data beside it, the stores by kind
  if (f.calls) {
    const modes = [['read', 'map.lane.reads'], ['write', 'map.lane.writes'], ['both', 'map.legend.both'], ['reached', 'map.mode.reached']]
      .filter(([m]) => m === 'read' || m === 'write' || f.modes.has(m));
    html += '<section>' + lgHead('map.legend.under') + modes.map(([m, k]) => lgRow(m, lgFlow(m), k)).join('')
      + [...f.stores.entries()].map(([kind, st]) => lgRow('store-' + kind, '<span class="mst st-' + kind + '"><i></i></span>', biz() ? 'map.biz.kind.' + kind : storeKindKey(st))).join('')
      + '</section>';
  }
  // on a screen: the stripes, AGAIN, the evidence words on a call (not in the business lens), the ×n mark
  const marks = [];
  if (f.built) marks.push(lgRow('built', '<span class="lg-stripe"></span>', 'map.legend.built'));
  if (f.planned) marks.push(lgRow('planned', '<span class="lg-stripe planned"></span>', 'map.screen.planned'));
  if (f.again) marks.push(lgRow('again', '<span class="lg-again">' + esc(t('map.call.again')) + '</span>', 'map.call.again', 'map.legend.againSay'));
  for (const ev of f.ev) if (!biz() || ev !== 'implied') marks.push(lgRow('ev-' + ev, '<span class="lg-call' + (ev === 'implied' ? '' : ' absent') + '" data-evidence="' + esc(ev) + '"></span>', evKey(ev)));
  if (f.times) marks.push(lgRow('times', '<span class="lg-times">' + esc(t('map.legend.times')) + '</span>', 'map.legend.timesSay'));
  html += '<section>' + lgHead('map.legend.screens') + marks.join('') + '</section>';
  // what proves a journey runs: the evidence words the journeys on the board earned
  if (f.evidence.size) {
    html += '<section>' + lgHead('map.legend.evidence') + [...f.evidence.entries()].map(([key, ew]) =>
      lgRow('evidence-' + (ew.cls || 'none'), '<span class="map-chip k-ev lg-evc ev-' + esc(ew.cls || 'none') + '">'
        + (ew.cls === 'observed' ? sym('live') : ew.cls === 'stale' ? sym('stale') : ew.cls === 'reached' ? sym('step') : '') + '</span>', key)).join('') + '</section>';
  }
  // while the board is dimmed around something, the badges it draws (round 2)
  if (affectedReady()) {
    const badge = (cls, words) => '<span class="map-affb ' + cls + '">' + esc(words) + '</span>';
    html += '<section>' + lgHead('map.affected.title')
      + lgRow('aff-seed', badge('seed', '◎'), 'map.affected.seed')
      + lgRow('aff-self', badge('self', '0'), 'map.affected.self')
      + (biz() ? lgRow('aff-biz1', badge('', '1'), 'map.affected.bizAt1') + lgRow('aff-biz2', badge('', '2'), 'map.affected.bizAt2')
        : lgRow('aff-at', badge('', 'n'), 'map.affected.at'))
      + lgRow('aff-not', badge('not', '–'), 'map.affected.not') + '</section>';
  }
  html += '<p class="lg-hint">' + esc(t('map.legend.hint')) + '</p>';
  box.innerHTML = html;
  box.hidden = false;
  box.classList.toggle('auto', !!MAP.legendAuto);
  box.classList.toggle('collapsed', !!MAP.legendCollapsed);
  box.onclick = (e) => {
    if (e.target.closest('[data-act="legend-close"]')) closeLegend();
    else if (e.target.closest('[data-act="legend-expand"]')) { MAP.legendCollapsed = false; MAP.legendAuto = false; drawLegend(); }
  };
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
    if (!note) {
      note = document.createElement('div');
      note.className = 'map-note';
      MAP.stage.appendChild(note);
      // the doors of an unknown storyline's sentence draw the one picked (or every journey)
      note.addEventListener('click', (e) => { const b = e.target.closest('button[data-storyline]'); if (b) applyStoryline(b.dataset.storyline || null); });
    }
    note.innerHTML = !MAP.failed && MAP.designs && MAP.nb.unknown ? unknownStorylineHtml(MAP.nb.unknown) : '<span' + tipAttrs({ key }) + '>' + esc(msg) + '</span>';
    return;
  }
  const note = MAP.stage.querySelector('.map-note');
  if (note) note.remove();
  MAP.world.innerHTML = MAP.nb.districts.map((d) => '<div class="map-district" data-flow="' + esc(d.id) + '"></div>').join('');
  MAP.world.insertBefore(svg, MAP.world.firstChild);
  for (const d of MAP.nb.districts) renderDistrict(d.id);
  placeDistricts();
  drawLinks();
  drawLanes();
  if (MAP.cv) onCanvasChange(MAP.cv.state());
}

/** Redraw one district — head, street and cover — from what is in hand for it. */
function renderDistrict(id) {
  const el = districtEl(id);
  const d = MAP.nb.districts.find((x) => x.id === id);
  if (!el || !d) return;
  const j = MAP.journeys.get(id);
  const g = stRect(id) || { w: DMIN, h: SY + SH + 70 };
  const agg = aggHtml(d, j);
  const desc = sentence(d.description);
  // a walk landing redraws the district under the keyboard: the focus comes back to the same thing
  const had = el.contains(document.activeElement) ? focusKey(document.activeElement) : null;
  const step = stepBadgeHtml(d);
  el.innerHTML = '<div class="map-dhead"><div class="nm">' + step + esc(nameWords(d.name)) + '</div>'
    + branchLineHtml(d)
    + (desc ? '<div class="desc">' + esc(desc) + '</div>' : '')
    + '<div class="agg">' + agg + '</div></div>'
    + '<div class="map-dstreet">' + streetHtml(d, j, g) + '</div>'
    // the cover is counter-scaled (--map-inv, set by the canvas) so its name reads at any zoom;
    // its whole sentence is the cover's tip
    + '<div class="map-dcover" role="button" tabindex="0" data-enter="' + esc(id) + '" aria-label="' + esc(t('map.cover.enter') + ' · ' + nameWords(d.name)) + '"'
    + tipAttrs({ text: nameWords(d.name) + (desc ? ' · ' + desc : ''), noFocus: true }) + '><div class="map-dcover-in">'
    + '<div class="nm">' + step + esc(nameWords(d.name)) + '</div>'
    + branchLineHtml(d)
    // the board altitude: a card — the name, one status chip and at most two marks; the sentence and every other
    // number are in the journey's header from the journey-fitted stop up (and the sentence in the cover's tip)
    + '<div class="agg">' + coverAggHtml(d, j) + '</div>' + storyThumbHtml(d) + '</div></div>';
  el.classList.toggle('loaded', !!(j && j.model));
  el.classList.toggle('branch', !!d.branch);
  if (MAP.nb.storyline) fillStoryEvidence();
  sizeDistrict(id);
  tabDistrict(el);
  paintDistrict(el, id, j && j.model);
  // a district drawn before it is placed has no size yet: placeDistricts() folds it once it has one
  if (el.style.width) foldCoverChips(el);
  if (had) focusQuiet(el.querySelector(had));
}
/** A branch in words: *branch of <step> · when <condition> · back to <step>* (or *does not come back*). */
function branchWords(b) {
  return t('journeys.storyline.branchOf').replace('{name}', nameWords(b.ofName || '')) + ' · ' + t('journeys.storyline.when').replace('{when}', b.when)
    + ' · ' + (b.rejoins ? t('journeys.storyline.rejoins').replace('{name}', nameWords(b.rejoinsName || '')) : t('journeys.storyline.noReturn'));
}
/** On a storyline's board, a branch's card says what it leaves from and when, in a line under its name. */
function branchLineHtml(d) {
  if (!d || !d.branch || !MAP.nb.storyline) return '';
  const b = d.branch;
  return '<div class="map-branch-when"><span' + tipAttrs({ key: 'journeys.storyline.branchOf', noFocus: true }) + '>' + esc(t('journeys.storyline.branchOf').replace('{name}', nameWords(b.ofName || ''))) + '</span>'
    + ' · <span' + tipAttrs({ key: 'journeys.storyline.when', noFocus: true }) + '>' + esc(t('journeys.storyline.when').replace('{when}', b.when)) + '</span></div>';
}
/**
 * On a storyline's board, the picture of a journey's first screen — the design manifest's image for it, served by
 * `/api/design/image` as the property's hero is — or, when the screen has none or it does not load, the placeholder:
 * the design glyph, the screen's name and the absence word. Never an empty box.
 */
function storyThumbHtml(d) {
  if (!MAP.nb.storyline || !d) return '';
  return screenThumbHtml(firstScreenOf(MAP.designs, d.id), 'map-thumb');
}
/** On a storyline's board, a journey's place in it: its number, with *step n of m* (*journey n of m* in the business lens) as its tip. */
function stepBadgeHtml(d) {
  if (d && d.branch && MAP.nb.storyline) {
    // a branch has no number of its own: the fork glyph, and what it leaves from and when as its tip
    const words = branchWords(d.branch);
    return '<span class="map-step branch" aria-label="' + esc(words) + '"' + tipAttrs({ text: words + ' · ' + MAP.nb.storyline.name, noFocus: true }) + '>' + sym('fork') + '</span>';
  }
  if (!d || !d.step || !MAP.nb.storyline) return '';
  const words = t(biz() ? 'map.storyline.bizStep' : 'map.storyline.step').split('{n}').join(String(d.step)).split('{m}').join(String(d.steps));
  return '<span class="map-step" aria-label="' + esc(words) + '"' + tipAttrs({ text: words + ' · ' + MAP.nb.storyline.name, noFocus: true }) + '>' + d.step + '</span>';
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
/**
 * A cover's chips wrap to a second row; past two rows the last ones fold into one `+n` chip whose tip lists them —
 * measured, because the cover's box follows the zoom (`--map-inv`). Run when a district draws and when the zoom
 * moves the counter-scale.
 */
function foldCoverChips(scope) {
  const aggs = scope ? scope.querySelectorAll('.map-dcover .agg') : MAP.world ? MAP.world.querySelectorAll('.map-dcover .agg') : [];
  aggs.forEach((agg) => {
    agg.querySelectorAll(':scope > .map-more').forEach((x) => x.remove());
    const kids = [...agg.children];
    kids.forEach((k) => { k.hidden = false; });
    const shown = () => kids.filter((k) => !k.hidden && k.offsetParent !== null && k.offsetWidth > 0);
    const vis = shown();
    if (!vis.length) return;
    const top0 = vis[0].offsetTop, rowH = vis[0].offsetHeight;
    const row = (el) => Math.round((el.offsetTop - top0) / (rowH + 4));
    if (vis.every((k) => row(k) <= 1)) return;
    const hidden = [];
    let more = null;
    for (let i = vis.length - 1; i > 0; i--) {
      vis[i].hidden = true;
      hidden.unshift(vis[i]);
      if (more) more.remove();
      const n = hidden.length;
      const rows = hidden.map((h) => [h.textContent.trim(), 1]);
      agg.insertAdjacentHTML('beforeend', '<span class="map-chip map-more"' + plainTip(n, 'map.cover.moreOf', 'map.fold.scopeJourney', '/api/journey', rows).replace(' tabindex="0"', '') + '>'
        + esc(t('map.cover.more').replace('{n}', String(n))) + '</span>');
      more = agg.lastElementChild;
      if (row(more) <= 1 && shown().every((k) => row(k) <= 1)) break;
    }
  });
}
function sizeDistrict(id) {
  const el = districtEl(id);
  const g = stRect(id);
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
  const cov = sum.coverage && sum.coverage.journey;
  const chip = mapCountChip;
  // the order is the poster's: what it is and how far built, what proves it runs, who owns it and
  // whether it reaches the ERP, then the code's numbers (a narrow cover clips from the end)
  return [
    // screens the journey names, and — when the walk reached fewer — how many it reached (lane N, one number one word)
    mapScreensChips(k),
    k.built && k.built.of != null && k.built.n < k.built.of ? chip(k.built, 'k-warn') : chip(k.built, 'k-ok'),
    // a count of tests never travels without its evidence word — the Portfolio's word for the same fold
    cov && cov.counted ? mapTestsChips(cov.counted.tests, cov) : '',
    // whether it reaches the ERP and who owns it — the Portfolio's columns, in its words
    mapErpChip(sum, k.built ? k.built.n : null),
    mapOwnerChip(d.owner),
    chip(k.actions, 'k-api'),
    chip(k.gates, 'k-gate'),
    // the stores the journey touches — the summary's own Counted (data-stores §5); not drawn at 0
    k.stores && k.stores.n ? chip(k.stores, 'k-store') : '',
    k.declaredNotCalled && k.declaredNotCalled.n ? chip(k.declaredNotCalled, 'k-absent') : '',
  ].join('') + work;
}

/**
 * What a cover carries at the board altitude: one status chip — *built*, *partly built · n of m* or *designed, not
 * built*, the summary's own `built` count with its tip — an *at risk* mark when the journey's evidence is stale or
 * not every screen is built (its tip says which), and `→ n`, how many journeys it leads to (filled by `drawLinks`).
 */
function coverAggHtml(d, j) {
  if (!j) return '<span class="map-chip k-absent"' + tipAttrs({ key: 'map.cover.loading', noFocus: true }) + '>' + esc(t('map.cover.loading')) + '</span>';
  if (j.error) return '<span class="map-chip k-absent"' + tipAttrs({ key: 'map.cover.failed', noFocus: true }) + '>' + esc(t('map.cover.failed')) + '</span>';
  const sum = j.data.summary || {};
  const b = sum.counted && sum.counted.built;
  const cov = sum.coverage && sum.coverage.journey;
  const ew = cov && cov.evidenceWord;
  const stale = !!(ew && ew.cls === 'stale');
  const partly = !!(b && b.of != null && b.n < b.of);
  let status = '';
  if (b && b.of != null) {
    const [key, cls] = b.n >= b.of ? ['map.cover.status.built', 'k-ok'] : b.n === 0 ? ['map.cover.status.none', 'k-absent'] : ['map.cover.status.partly', 'k-warn'];
    status = countedHtml(b, '/api/journey', { cls: 'map-chip k-status ' + cls, words: t(key).split('{n}').join(String(b.n)).split('{m}').join(String(b.of)) });
  }
  // two marks, not one (§3.3): *stale* quiet in the muted colour — the code moved under the tests — and *not built* in
  // amber — a screen is only designed; one or both, each with its own define
  const mark = (cls, key, glyph) => '<span class="map-mark ' + cls + '"' + tipAttrs({ key, noFocus: true }) + '>' + (glyph ? sym(glyph) : '') + esc(t(key)) + '</span>';
  // on a storyline's board the card says its test evidence with lane V's chip (the cell's one verdict, its word and its
  // tip); the word names a stale run itself, so the quiet *stale* mark is not said twice
  const ev = MAP.nb.storyline && cov ? (cov.counted && cov.counted.tests ? mapTestsChips(cov.counted.tests, cov) : mapEvidenceChip(cov)) : '';
  // *stale*'s tip is the comparison itself: the run's commit and the code's (finding 2)
  const staleMark = () => (cov && cov.freshness && cov.freshness.state === 'stale'
    ? '<span class="map-mark stale"' + freshAttrs(cov.freshness, { noFocus: true }) + '>' + sym('sync') + esc(t('map.cover.mark.stale')) + '</span>'
    : mark('stale', 'map.cover.mark.stale', 'sync'));
  const marks = (stale && !ev ? staleMark() : '') + (partly ? mark('notbuilt', 'map.cover.mark.notBuilt', 'warning') : '');
  return status + ev + marks + '<span class="map-mark leads" data-leads-for="' + esc(d.id) + '" hidden></span>';
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
          + (legendStoreName(m, st) ? esc(legendStoreName(m, st)) + ' · ' : '') + esc(t(storeKindKey(st))) + '</span>').join('') + '</span>' : '')
      + '</span></div>';
  }
  m.screens.forEach((s, si) => {
    const x = PAD + si * COL;
    let y = PL_TOP;
    const tx = x + OPW / 2;
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
  // the screen's tests travel with the screen's own evidence word (lane N)
  const chips = [chip(c.calls, 'k-api'), chip(c.gates, 'k-gate'), mapTestsChips(c.tests, c.evidence, { hideZero: biz() })].join('');
  return '<div class="map-scr' + (s.state === 'planned' ? ' planned' : '') + '" role="button" tabindex="0"'
    + ' data-flow="' + esc(d.id) + '" data-index="' + s.index + '" data-node="' + esc(s.id) + '" data-name="' + esc(s.name) + '"'
    + ' aria-label="' + esc(t('map.screen.open') + ' · ' + s.name) + '" style="left:' + x + 'px;top:' + y + 'px">'
    + '<div class="stripe"></div>'
    + '<div class="map-thumbwrap">' + (thumb || ph) + '</div>'
    + '<div class="body"><div class="ttl"><span class="ord"' + tipAttrs({ key: 'map.screen.ordinal', noFocus: true }) + '>' + s.ordinal + '</span>'
    + '<span class="nm">' + esc(s.name) + '</span></div>'
    + '<div class="route map-code">' + esc(s.route || '') + '</div>'
    + (s.state === 'planned' ? '<div class="state"><span class="map-chip k-warn"' + tipAttrs({ key: 'map.screen.planned', noFocus: true }) + '>' + sym('warning') + esc(t('map.screen.planned')) + '</span></div>' : '')
    // the numbers are this screen's part of this journey's walk: said, so two journeys printing two numbers for one
    // screen read as two scopes, not a contradiction (round 2) — plain words, so every lens prints them, with a tip
    + '<div class="map-chips">' + chips + (chips ? '<span class="map-scope"' + tipAttrs({ key: 'map.screen.onJourney', noFocus: true }) + '>' + esc(t('map.screen.onJourney')) + '</span>' : '') + '</div>'
    // the same screen in the journey's timeline (§3.1)
    + (s.segment ? '<div class="map-tojrn">' + leadDoorHtml('door.journey', journeyStepHash(d.id, s.segment.index + 1, { lens: currentLens() })) + '</div>' : '')
    + '</div></div>';
}

/** One call on a screen's pathway: the service bar, its evidence where it is not spec-backed, its name and (not in the business lens) its method and path. */
function callHtml(d, s, c, si, ci, x, y, h) {
  const svc = c.service ? 'svc-' + (c.service.index % 6) : 'svc-none';
  const ev = !evShown(c.evidence) ? '' : '<span class="map-ev"' + tipAttrs({ key: evKey(c.evidence), noFocus: true }) + '>' + esc(t(evKey(c.evidence))) + '</span>';
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
    + '<span class="top"><span class="kd"' + (biz() ? tipAttrs({ key: dataBizKey(dd), noFocus: true }) : '') + '>' + esc(dataKindWords(dd)) + '<span class="map-code"> · ' + esc(dd.name) + '</span></span>'
    + '<span class="rw ' + esc(dd.mode) + '"' + tipAttrs({ key: modeKey(dd.mode), noFocus: true }) + '>' + esc(modeWord(dd.mode)) + '</span></span>'
    + '<span class="nm">' + esc(dataWords(dd)) + '</span></div>';
}

/**
 * The links between districts, from each journey's own `summary.links`: *leads
 * to* (and its mirror *requires*, drawn once) and *part of*. A link appears when
 * the walk that names it lands — never inferred here. Two journeys that each
 * lead to the other are one line with an arrowhead at each end and one label.
 * The routes are `routeLinks()` (lib/map-model.js): orthogonal, in the gutters,
 * never across a district, each label once on its own line where it clears
 * every cover.
 */
function drawLinks() {
  if (!MAP.links) return;
  const byKey = new Map();
  const edge = (from, to, kind) => {
    if (from === to || !MAP.geom.has(from) || !MAP.geom.has(to)) return;
    const key = kind + ':' + from + '>' + to;
    if (byKey.has(key)) return;
    const back = byKey.get(kind + ':' + to + '>' + from);
    if (back && kind === 'leadsTo') { back.both = true; return; }
    byKey.set(key, { from, to, kind, both: false });
  };
  for (const [id, j] of MAP.journeys) {
    const l = j && j.model && j.model.links;
    if (!l) continue;
    for (const r of l.leadsTo || []) edge(id, r.id, 'leadsTo');
    for (const r of l.requires || []) edge(r.id, id, 'leadsTo');
    for (const r of l.partOf || []) edge(r.id, id, 'partOf');
  }
  // a storyline: a then line from each journey to the next, drawn at every altitude
  // and its branches: down from the step with the condition on the line, and a dashed line back to the step it rejoins
  for (const l of MAP.nb.then || []) {
    const kind = l.kind || 'then';
    edge(l.from, l.to, kind);
    const e = byKey.get(kind + ':' + l.from + '>' + l.to);
    if (e) { e.fromSides = l.fromSides; e.toSides = l.toSides; if (l.when) e.when = l.when; }
  }
  const list = [...byKey.values()].map((l) => {
    const word = l.kind === 'branch' ? t('journeys.storyline.when').replace('{when}', l.when || '') : t(linkWordKey(l));
    // a branch's condition is set in the body face, not the condensed capitals the probe measures
    const w = l.kind === 'branch' ? Math.ceil(word.length * 6.1) : labelWidth(word);
    return { ...l, word, labelW: w + LINK_LABEL_PAD * 2, labelH: LINK_LABEL_H };
  });
  // the board draws no labels and its gutters are narrower: the lanes sit closer to the cards
  const board = MAP.alt === 'nb';
  // (a branch keeps its condition at the board too: it is the one thing the line says)
  const routed = routeLinks(MAP.geom, board ? list.map((l) => (l.kind === 'branch' ? l : { ...l, labelW: 0, labelH: 0 })) : list, board ? { margin: 8 * BOARD_K } : {});
  MAP.links.innerHTML = routed.map(linkHtml).join('');
  fillLeadMarks(list);
  linkVisibility();
}
/**
 * Each cover's `→ n`: how many journeys it leads to, from the same lines the board draws (a pair that lead to each
 * other counts at both ends) — at the board the lines themselves show only for the journey under the pointer.
 */
function fillLeadMarks(list) {
  if (!MAP.world) return;
  const to = new Map();
  const add = (a, b) => { if (!to.has(a)) to.set(a, new Set()); to.get(a).add(b); };
  for (const l of list) {
    if (l.kind !== 'leadsTo') continue;
    add(l.from, l.to);
    if (l.both) add(l.to, l.from);
  }
  const name = (id) => { const d = MAP.nb.districts.find((x) => x.id === id); return d ? nameWords(d.name) : id; };
  MAP.world.querySelectorAll('.map-mark.leads[data-leads-for]').forEach((el) => {
    const set = to.get(el.dataset.leadsFor);
    const n = set ? set.size : 0;
    el.hidden = !n;
    if (!n) { el.innerHTML = ''; return; }
    const html = '<span' + plainTip(n, 'map.cover.leadsOf', 'map.fold.scopeJourney', '/api/journey', [...set].map((id) => [name(id), 1])).replace(' tabindex="0"', '') + '>'
      + esc(t('map.cover.leads').split('{n}').join(String(n))) + '</span>';
    if (el.innerHTML !== html) el.innerHTML = html;
  });
}
const LINK_LABEL_H = 18, LINK_LABEL_PAD = 7, LINK_CORNER = 26;
function linkWordKey(l) { return l.kind === 'rejoin' ? 'map.link.rejoin' : l.kind === 'branch' ? 'map.link.branch' : l.kind === 'then' ? 'map.link.then' : l.kind === 'partOf' ? 'map.link.partOf' : l.both ? 'map.link.both' : 'map.link.leadsTo'; }
/** A label's width at the counter-scale of 1, measured once per word on the links layer itself (so the HUD face counts). */
const LABEL_W = new Map();
function labelWidth(word) {
  if (LABEL_W.has(word)) return LABEL_W.get(word);
  let w = 0;
  try {
    const probe = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    probe.setAttribute('class', 'probe');
    probe.textContent = word;
    MAP.links.appendChild(probe);
    w = probe.getComputedTextLength();
    probe.remove();
  } catch { w = 0; }
  // before the face has loaded, or off the page: a generous estimate of the condensed capitals
  if (!(w > 0)) w = word.length * 8.6;
  w = Math.ceil(w + word.length * 0.6);
  LABEL_W.set(word, w);
  return w;
}
/** A polyline with its corners rounded. */
function roundedPath(pts) {
  let d = 'M' + pts[0].x + ' ' + pts[0].y;
  for (let k = 1; k < pts.length - 1; k++) {
    const a = pts[k - 1], b = pts[k], c = pts[k + 1];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y), l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(LINK_CORNER, l1 / 2, l2 / 2);
    const p = { x: b.x - ((b.x - a.x) / (l1 || 1)) * r, y: b.y - ((b.y - a.y) / (l1 || 1)) * r };
    const q = { x: b.x + ((c.x - b.x) / (l2 || 1)) * r, y: b.y + ((c.y - b.y) / (l2 || 1)) * r };
    d += ' L' + p.x + ' ' + p.y + ' Q' + b.x + ' ' + b.y + ' ' + q.x + ' ' + q.y;
  }
  const z = pts[pts.length - 1];
  return d + ' L' + z.x + ' ' + z.y;
}
/** An arrowhead at `at`, pointing from `from`; counter-scaled so it reads at any zoom. */
function arrowHtml(from, at) {
  const deg = Math.atan2(at.y - from.y, at.x - from.x) * 180 / Math.PI;
  return '<path class="head" d="M-10 -6 L0 0 L-10 6" style="transform:translate(' + at.x + 'px,' + at.y + 'px) rotate(' + deg.toFixed(1) + 'deg) scale(var(--map-inv,1))"/>';
}
function linkHtml(l) {
  const p = l.points, n = p.length;
  const heads = l.kind === 'partOf' ? '' : arrowHtml(p[n - 2], p[n - 1]) + (l.both ? arrowHtml(p[1], p[0]) : '');
  const lb = l.label;
  // the label is drawn once, on its own line, in a gap the line leaves for it; it shows from the zoom it fits at
  const label = lb ? '<g class="lbl" data-scale="' + lb.scale + '" style="transform:translate(' + lb.x + 'px,' + lb.y + 'px) scale(var(--map-inv,1))">'
    + '<rect x="' + (-l.labelW / 2) + '" y="' + (-l.labelH / 2) + '" width="' + l.labelW + '" height="' + l.labelH + '" rx="3"/>'
    + '<text x="0" y="0.5" text-anchor="middle" dominant-baseline="central">' + esc(l.word) + '</text></g>' : '';
  return '<g data-link="' + l.kind + '"' + (l.both ? ' data-both="1"' : '') + ' data-from="' + esc(l.from) + '" data-to="' + esc(l.to) + '">'
    + '<path class="ln' + (l.kind === 'partOf' || l.kind === 'rejoin' ? ' contains' : '') + '" d="' + roundedPath(p) + '" vector-effect="non-scaling-stroke"/>' + heads + label + '</g>';
}
/**
 * Which links show. At the **board** altitude (the covers) no line is drawn but the ones of the journey under the
 * pointer or holding the focus — both its ends lit, every other journey dimmed, as the Affected mode dims — and no
 * label at all: the cover's `→ n` says the lines exist. From the journey-fitted stop up (the streets) *leads to*
 * is always drawn, dimmed; *part of* only for the journey under the pointer or the focus, or when both its ends are
 * in view; the journey under the pointer brings all of its lines up; a label shows once the board is zoomed in far
 * enough for it to fit where it was placed.
 */
function linkVisibility() {
  if (!MAP.links || !MAP.cv) return;
  const st = MAP.cv.state();
  const board = st.level === 'nb';
  const inv = Math.min(1 / st.s, INV_MAX);
  const c = MAP.cv.viewCenter();
  const view = { x: c.x - c.w / 2, y: c.y - c.h / 2, w: c.w, h: c.h };
  const inView = (id) => { const g = MAP.geom.get(id); return !!g && g.x < view.x + view.w && view.x < g.x + g.w && g.y < view.y + view.h && view.y < g.y + g.h; };
  const ends = new Set();
  MAP.links.querySelectorAll('g[data-link]').forEach((g) => {
    const hot = !!MAP.hot && (g.dataset.from === MAP.hot || g.dataset.to === MAP.hot);
    // a storyline's then line is the one the board draws unhovered, at every altitude
    const story = g.dataset.link === 'then' || g.dataset.link === 'branch' || g.dataset.link === 'rejoin';
    const show = story || (board ? hot : g.dataset.link !== 'partOf' || hot || (inView(g.dataset.from) && inView(g.dataset.to)));
    g.classList.toggle('off', !show);
    g.classList.toggle('hot', hot);
    if (hot) { ends.add(g.dataset.from); ends.add(g.dataset.to); }
    const lb = g.querySelector('.lbl');
    if (lb) lb.classList.toggle('off', (board && g.dataset.link !== 'branch') || inv > Number(lb.dataset.scale) + 1e-6);
  });
  // the board: a journey with lines under the pointer lights its ends and dims the rest
  const lit = board && ends.size > 0;
  MAP.world.classList.toggle('links-lit', lit);
  MAP.world.querySelectorAll('.map-district').forEach((d) => d.classList.toggle('link-end', lit && ends.has(d.dataset.flow)));
}
function onDistrictHot(e) {
  const d = e.target && e.target.closest ? e.target.closest('.map-district') : null;
  const id = d ? d.dataset.flow : null;
  if (id === MAP.hot) return;
  MAP.hot = id;
  linkVisibility();
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
  const stage = tgt.closest('.ln-stage');
  if (stage && lanesShown()) { enterStage(stage); return; }
  const cover = tgt.closest('.map-dcover');
  if (cover && MAP.cv && MAP.cv.level() === 'nb') { closeCard(); enterJourney(cover.dataset.enter, true); return; }
  const echo = tgt.closest('.map-echo');
  if (echo) { closeCard(); enterJourney(echo.dataset.echo, true); return; }
  closeCard();
}
function onBoardKey(e) {
  // Tab from the board itself (it holds the focus when the Map opens) goes to the first journey's cover. Left to the
  // browser it landed on the first tabbable in the board — a band header's count, which the first walk landing
  // redraws, so the focus fell to <body> about one time in ten (e2e map-round2, 2026-10-06). A cover keeps its
  // focus through a redraw (`focusKey`), so it is the one stop that is always there.
  if (e.key === 'Tab' && !e.shiftKey && e.target === MAP.board) {
    const first = MAP.world && [...MAP.world.querySelectorAll(lanesShown() ? '.ln-stage' : '.map-dcover')].find((c) => !c.closest('[inert]') && c.offsetParent !== null);
    if (first) { e.preventDefault(); first.focus({ preventScroll: true }); }
    return;
  }
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const tgt = e.target;
  if (tgt.matches(TIP_SELECTOR) && !tgt.matches('.map-scr,.map-pl,.map-pd,.map-dcover,.map-echo,.ln-stage')) return;
  if (tgt.matches('.map-pl,.map-pd')) { e.preventDefault(); showCard(tgt); return; }
  if (tgt.matches('.map-scr')) { e.preventDefault(); openScreenEl(tgt); return; }
  if (tgt.matches('.ln-stage')) { e.preventDefault(); enterStage(tgt); return; }
  if (tgt.matches('.map-dcover')) {
    e.preventDefault();
    enterCover(tgt);
    return;
  }
  if (tgt.matches('.map-echo')) {
    e.preventDefault();
    closeCard();
    enterJourney(tgt.dataset.echo, true);
  }
}
/** Walk into a cover's journey from the keyboard: the street, with the focus on its first screen. */
function enterCover(tgt) {
  const flow = tgt.dataset.enter;
  closeCard();
  enterJourney(flow, true);
  // the cover is not drawn on the street: the keyboard lands on the journey's first screen
  applyTabbing();
  const first = MAP.world && MAP.world.querySelector('.map-scr[data-flow="' + cssAttr(flow) + '"]');
  if (first) focusQuiet(first);
  else ensureJourney(flow).then(() => { if (MAP.focus === flow && MAP.cv && MAP.cv.level() === 'st') focusQuiet(MAP.world && MAP.world.querySelector('.map-scr[data-flow="' + cssAttr(flow) + '"]')); });
}
function onDocClick(e) {
  // the folded *Band by* menu closes on a click anywhere else
  if (MAP.bandMenu && !(e.target.closest && e.target.closest('.map-band-pick'))) { MAP.bandMenu = false; redrawChrome(); }
  if (MAP.storyMenu && !(e.target.closest && e.target.closest('.map-story-pick'))) { MAP.storyMenu = false; redrawChrome(); }
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
  // a card opened on a journey makes it the current one: the link the card writes names it
  openedJourney(el.dataset.flow);
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
  let head, ev = '', name, code, store = '', doors = [];
  if (tg.kind === 'call') {
    const c = tg.call;
    const modes = [...new Set(c.data.map((x) => x.mode).filter((x) => x !== 'reached'))];
    const dir = modes.length ? (modes.includes('both') || (modes.includes('read') && modes.includes('write')) ? t('map.lane.both') : modeWord(modes[0])) : '';
    head = esc(c.service ? c.service.label : t('map.lane.noService')) + (dir ? ' · ' + esc(dir) : '');
    ev = evShown(c.evidence, true) ? '<span class="map-ev"' + tipAttrs({ key: evKey(c.evidence) }) + '>' + esc(t(evKey(c.evidence))) + '</span>' : '';
    name = callWords(c);
    const h = c.marker && c.marker.handler;
    // a handler is often named for its verb (a function called GET): its file and line stand beside the name (round 2)
    const hn = h && S.BYID[h.nodeId];
    const hloc = (hn && hn.loc) || (h && h.path ? { path: h.path, line: h.line } : null);
    const handler = h ? h.name + (hloc && hloc.path ? ' (' + hloc.path + (hloc.line ? ':' + hloc.line : '') + ')' : '') : '';
    code = [(c.method + ' ' + c.path).trim(), c.operationId, handler ? t('map.card.handler') + ' ' + handler : ''].filter(Boolean).join(' · ');
    // every detail is a door (§3.2): the contract, the spec line, the handler, the card on the code map
    const route = nodeId && S.BYID[nodeId];
    if (route) doors = doorsFor('call', route, { handler: (c.marker && c.marker.handler) || null, flow: tg.flow });
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
        + (storeShownName(dd.store, biz()) ? esc(storeShownName(dd.store, biz())) + ' · ' : '') + esc(t(storeKindKey(dd.store))) + '</span>'
        + (via && t(via) !== via ? '<span class="map-code via"><span class="hud-label"' + tipAttrs({ key: 'map.store.known', noFocus: true }) + '>' + esc(t('map.store.known')) + '</span> '
          + '<span' + tipAttrs({ key: via, noFocus: true }) + '>' + esc(t(via)) + '</span>' + (dd.store.ref ? ' · <code>' + esc(dd.store.ref) + '</code>' : '') + '</span>' : '')
        + '</div>';
    }
    const dn = S.BYID[dd.nodeId] || n;
    if (dn) doors = doorsFor(dd.kind, dn, { flow: tg.flow });
  }
  const on = screensUsing(tg.model, tg.kind === 'call' ? 'call' : tg.kind, nodeId);
  // the same part in the journey's timeline, at the step whose markers include it, selected (§3.1)
  const jd = MAP.journeys.get(tg.flow);
  const segs = (jd && jd.data && jd.data.summary && jd.data.summary.segments) || [];
  const step = nodeId ? stepOfNode(segs, tg.screen && tg.screen.segment ? tg.screen.segment.index : null, nodeId) : null;
  const toJrn = step ? leadDoorHtml('door.journey', journeyStepHash(tg.flow, step, { node: nodeId, lens: currentLens() })) : '';
  box.innerHTML = '<div class="k"><span class="hud-label">' + head + '</span>' + ev
    + '<button type="button" class="x" data-act="close" aria-label="' + esc(t('map.card.close')) + '">✕</button></div>'
    + '<div class="nm">' + esc(name) + '</div>'
    // where this journey stands in a storyline (lane S), when it is a step of one
    + (storylineLineHtml(MAP.tree, tg.flow) ? '<div class="story">' + storylineLineHtml(MAP.tree, tg.flow) + '</div>' : '')
    + store
    + (code ? '<div class="sent map-code">' + esc(code) + '</div>' : '')
    + '<div class="where"><span class="hud-label"' + tipAttrs({ key: 'map.card.on', noFocus: true }) + '>' + esc(t('map.card.on')) + '</span>'
    + (on.length ? on.map((s) => '<button type="button" class="map-chip go" data-go="' + s.index + '" data-flow="' + esc(tg.flow) + '">' + esc(s.name) + screenChipReach(tg.flow, s.id) + '</button>').join('')
      : '<span class="map-chip k-absent">' + esc(t('map.card.onNone')) + '</span>') + '</div>'
    + '<div class="acts">' + (nodeId ? '<button type="button" class="map-tb aff' + (affectedSpec() === nodeId ? ' on' : '') + '" data-act="affected"' + tipAttrs({ key: 'map.affected.action', noFocus: true }) + '>' + esc(t('map.affected.action')) + '</button>' : '')
    + doorsHtml(doors) + '</div>'
    + (toJrn ? '<div class="tojrn">' + toJrn + '</div>' : '');
  box.setAttribute('aria-label', name);
  box.setAttribute('data-doors', '');
  box.hidden = false;
  box.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'close') { closeCard(); return; }
    if (b.dataset.act === 'affected') { setAffected(nodeId, { origin: { flow: tg.flow } }); return; }
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
    // the journeys tree, for *in storyline: <name> · step n of m* on the head
    tree: MAP.tree,
    onClose: () => closeProperty(),
    onStep: (delta) => stepProperty(delta),
    onOpenScreen: (index) => { if (MAP.prop) openProperty(MAP.prop.flow, index); },
    // the property's seed actions — its head, its Work and Changes rows (lane I)
    onAffected: (spec) => setAffected(spec, { origin: p ? { flow: p.flow } : null }),
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
  openedJourney(flow);
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
  // across only: the screen comes to the middle and the board keeps its height, so the street does not drop and
  // leave an empty band above it; a screen row off the stage brings the journey's head to the top (round 2)
  const s0 = Math.max(MAP.cv.state().s, LEVEL_NB + 0.02);
  const p = screenPos(flow, next), g = MAP.geom.get(flow), b = boardSize(), st = MAP.cv.state();
  if (p && g) {
    openedJourney(flow);
    let ty = s0 === st.s ? st.ty : FRAME_PAD - g.y * s0;
    const rowTop = (g.y + SY) * s0 + ty, rowBottom = (g.y + SY + SH) * s0 + ty;
    if (rowTop < 0 || rowBottom > b.h) ty = FRAME_PAD - g.y * s0;
    MAP.cv.set(b.w / 2 - p.x * s0, ty, s0, true);
  }
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
 * `?` on the map opens its legend and closes it again, whatever has the focus — a focused word's tip is not opened
 * by it here (lib/tooltip.js leaves `?` to a hover-mode surface), and the keymap sheet stays the header's `?` and
 * `?` everywhere else. Over an open screen the key does nothing rather than open a sheet the map did not promise.
 */
function mapToggleLegend() { if (!MAP.stage) return false; if (!MAP.prop) toggleLegend(); return true; }

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
  // the Affected list closes first, then the mode leaves before anything else (lane I)
  if (MAP.affList) { toggleAffList(false); return true; }
  if (MAP.bandMenu) { MAP.bandMenu = false; redrawChrome(); const c = MAP.stage.querySelector('.map-band-cur'); if (c) c.focus(); return true; }
  if (MAP.storyMenu) { MAP.storyMenu = false; redrawChrome(); const c = MAP.stage.querySelector('.map-story-cur'); if (c) c.focus(); return true; }
  if (affectedOn()) { clearAffected(); return true; }
  if (document.fullscreenElement && MAP.stage.contains(document.fullscreenElement) && !MAP.card && !MAP.prop && !MAP.legend) return false;
  if (MAP.card) { closeCard(); return true; }
  if (MAP.legend) { closeLegend(); return true; }
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
  // `?` is the keymap's everywhere (keymap.js); the legend is g — its own key, beside its own glyph
  if (k === 'g' || k === 'G') return mapToggleLegend();
  // the open screen and the explore card keep their own keys; the board's walk keys are the board's
  const inPanel = e.target && e.target.closest && e.target.closest('.map-prop-host,.map-xcard');
  if (!MAP.prop && !inPanel) {
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') { panBy(k, e.shiftKey); return true; }
    if ((k === 'j' || k === 'k') && MAP.cv && MAP.cv.level() === 'st') { stepScreen(k === 'j' ? 1 : -1); return true; }
    // on the board j / k walk the covers the way h / l do, so a reader who starts with j is not ignored (round 2)
    if (k === 'h' || k === 'l' || ((k === 'j' || k === 'k') && MAP.cv && MAP.cv.level() === 'nb')) { stepJourney(k === 'l' || k === 'j' ? 1 : -1); return true; }
    // Enter with nothing on the board focused opens the journey the keys last walked to (its cover is ringed)
    if (k === 'Enter' && MAP.cv && MAP.cv.level() === 'nb' && MAP.focus && !(e.target && e.target.closest && e.target.closest('button,a[href],input,select,textarea,[role="button"],.map-board'))) {
      const cover = MAP.world && MAP.world.querySelector('.map-dcover[data-enter="' + cssAttr(MAP.focus) + '"]');
      if (cover) { enterCover(cover); return true; }
    }
  }
  if ((k === 'w' || k === 'W') && MAP.nb.storyline && !MAP.prop) { setLayout(MAP.layout === 'lanes' ? 'chain' : 'lanes'); return true; }
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

// ── the Affected mode (lane I) — surfaces/map-affected.js holds it, the board follows ──
/** The link names a mode (`?affected=<seed>&ahops=N`) or none: the mode follows the link it was opened from. */
function routeAffected(route) {
  const spec = route && route.affected;
  if (spec) setAffected(spec, { hops: route.ahops });
  else if (affectedOn() && route && route.raw && !/[?&]affected=/.test(route.raw)) clearAffected();
}
/** The mode moved: the bar, every district, the open card and the open screen redraw, and the link follows. */
function onAffected() {
  if (!MAP.stage) return;
  redrawChrome();
  for (const d of MAP.nb.districts || []) {
    const el = districtEl(d.id);
    const j = MAP.journeys.get(d.id);
    if (el) { paintDistrict(el, d.id, j && j.model); if (el.style.width) foldCoverChips(el); }
  }
  if (MAP.card) drawCard();
  if (MAP.affList) { if (affectedOn()) drawAffList(); else toggleAffList(false); }
  if (MAP.legend) drawLegend();
  if (MAP.prop && MAP.prop.handle && MAP.prop.handle.update) MAP.prop.handle.update(propCtx());
  if (MAP.prop) { const sc = propScreen(); if (sc) writeHash(MAP.prop.flow, sc.id); }
  else if (MAP.cv) writeHash(MAP.cv.level() === 'st' ? MAP.focus : null, null);
}
/** The distance the mode is asked at, for the e2e and the keys. @group Map */
export function mapAffectedHops() { return affectedOn() ? affectedHops() : null; }

/** The node the explore card is open on — what `b` asks *what uses this?* about on the map. @group Map */
export function mapSelected() {
  if (!MAP.card || !MAP.card.tg) return null;
  return MAP.card.tg.kind === 'call' ? MAP.card.tg.call.nodeId : MAP.card.tg.data.nodeId;
}

/**
 * What the Map's Save control draws (lib/export.js): the whole board at the fit — every band, or the one storyline
 * drawn — never only the part on screen. The board is fitted first, the way *Fit* does, so the reader sees what is
 * saved; a property or a street open is closed back to the board.
 * @group Map
 * @business Saves the board — the storyline or every journey — as one picture, whatever part is on screen.
 */
async function mapPicture() {
  if (!MAP.world || !MAP.cv || !MAP.size.w) return null;
  if (MAP.prop) closeProperty();
  fitAll(false);
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  const story = MAP.nb && MAP.nb.storyline;
  if (lanesShown() && MAP.lanes) return { world: MAP.world, size: MAP.lanes.size, scale: MAP.cv.state().s, title: story.name, subject: story.id + '-lanes' };
  return { world: MAP.world, size: MAP.size, scale: MAP.cv.state().s, title: story ? story.name : t('export.board.all'), subject: story ? story.id : '' };
}
registerExport('map', mapPicture);

expose({ mapFit, mapZoom });
