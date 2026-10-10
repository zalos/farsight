// surfaces/map-stops.js — the Map's stops below the street and its one LAYOUT control (lanes round 2026-10-10,
// proposal 1 step 2; the design: one surface, five altitudes).
//
// ALL JOURNEYS → ONE JOURNEY → ONE SCREEN → ONE ACTION → CODE. The first three are the board, the street and the
// property (surfaces/map.js, surfaces/map-property.js). This module owns the last two and what changes per stop:
//
// - **the action stop**: one action's beats across the layers of the system — the journey drill's lanes, drawn by
//   the drill's own code (surfaces/journey-drill.js) into a host on the Map's stage — with a slim strip of the
//   journey's screens above (the one it is on lit) and the crumb carrying the place. ← / → walk the beats, − goes
//   back to the screen, + opens the code;
// - **the code stop**: not a zoom but the dock opening — the drill's inspector (DOCS · CODE · FORKS · TESTS · CHANGE
//   IMPACT, REQUEST / RESPONSE on a seam) placed IN PLACE · BOTTOM · RIGHT, remembered as the journey's dock is;
// - **the LAYOUT control**: one control whose choices are the stop's — `MAP_LAYOUTS` is its registration point
//   (`{ id, word, when, onPick? }`; `when` is a stop: `nb` · `st` · `act`). `chain` at the board, `screens · table` at
//   the journey (table = the Sheet on the stage in place of the street), `beats · ladder` at the action;
// - **the street head's facts** the journey header carried: the storyline position, the status lifecycle and Save.
//
// The journey's folds come from lib/journey-model.js; the drawing from the journey surfaces, which find their host
// through `S.JRN_HOST` while the overlay is closed. map.js binds this module once (`bindStops`) and calls it from a
// handful of small call sites, so the other lanes on the Map (lanes L, V, W, G) merge around it.

import { S, esc, currentLens } from '../store.js';
import { t } from '../strings.js';
import { sym } from '../sym.js';
import { tipAttrs } from '../lib/tooltip.js';
import { designThumbHtml } from '../lib/graph-render.js';
import { storylineOf } from '../lib/journeys-model.js';
import { sheetModel, screenActions, screenOfAction, actionOfMarker, beatOrder } from '../lib/journey-model.js';
import { storylineLineHtml } from '../lib/detail-doors.js';
import { exportToolHtml, registerExport } from '../lib/export.js';
import {
  jrnBuildTree, jrnSheetIndex, jrnSheetHtml, jrnResetFolds, jrnSelect, jrnLadderCellHtml, jrnDock, jrnSetDock,
  jrnLifecycleHtml, jrnMoLabel, journeyOpen,
} from './journeys.js';
import { jrnDrillIndex, jrnDrillStageHtml, jrnDrillMount } from './journey-drill.js';

// ── the layout control's registration point ─────────────────────────────────
/**
 * Every choice the LAYOUT control can offer, by the stop it belongs to. A lane adds a layout by pushing one entry
 * (`registerMapLayout({ id, word, when, onPick })` — `word` the catalog key of its name): the control draws the choices
 * of the stop on screen in this order, the first is the stop's default, and `onPick(id)` is called when it is picked
 * (the built-in choices have none — this module draws them). The choice on screen per stop is `layoutAt(when)`.
 * @group Map
 */
export const MAP_LAYOUTS = [
  { id: 'chain', word: 'map.layout.chain', when: 'nb' },
  { id: 'screens', word: 'map.layout.screens', when: 'st' },
  { id: 'table', word: 'map.layout.table', when: 'st' },
  { id: 'beats', word: 'map.layout.beats', when: 'act' },
  { id: 'ladder', word: 'map.layout.ladder', when: 'act' },
];
/** Add (or replace, by id and stop) one layout choice. @group Map */
export function registerMapLayout(choice) {
  const i = MAP_LAYOUTS.findIndex((x) => x.id === choice.id && x.when === choice.when);
  if (i >= 0) MAP_LAYOUTS[i] = choice; else MAP_LAYOUTS.push(choice);
}
const LAYOUT = {};
/** The layout on screen at a stop: the one picked, else the stop's first choice. @group Map */
export function layoutAt(when) {
  const list = MAP_LAYOUTS.filter((x) => x.when === when);
  return list.some((x) => x.id === LAYOUT[when]) ? LAYOUT[when] : (list[0] ? list[0].id : null);
}

const ST = { api: null, act: null, table: null, full: new Map(), gen: 0 };

/**
 * Hand this module the Map's own state and the moves it needs (map.js, once at load): `MAP`, `ensureJourney`,
 * `openProperty`, `closeProperty`, `closeCard`, `writeHash`, `refresh` (the chrome and the crumb after a stop moved),
 * `headHtml(flow)` (the street head's chip row), `nameWords`.
 * @group Map
 */
export function bindStops(api) { ST.api = api; }

/** The stop on screen: `nb` · `st` · `pr` · `act` · `code`. @group Map */
export function stopNow() {
  const M = ST.api && ST.api.MAP;
  if (!M || !M.cv) return 'nb';
  if (ST.act) return ST.act.code ? 'code' : 'act';
  if (M.prop) return 'pr';
  return M.cv.level();
}
/** The LAYOUT control for the stop on screen, or '' when the stop has one way to be drawn. @group Map */
export function layoutToolHtml() {
  const stop = stopNow();
  const when = stop === 'code' ? 'act' : stop;
  const list = MAP_LAYOUTS.filter((x) => x.when === when);
  if (list.length < 2) return '';
  const on = layoutAt(when);
  return '<span class="map-layout" role="group" aria-label="' + esc(t('map.layout')) + '">'
    + '<span class="hud-label"' + tipAttrs({ key: 'map.layout', noFocus: true }) + '>' + esc(t('map.layout')) + '</span><span class="map-segs">'
    + list.map((x) => '<button type="button" class="map-seg' + (x.id === on ? ' on' : '') + '" data-act="layout" data-layout="' + esc(x.id) + '" data-when="' + esc(when) + '"'
      + ' aria-pressed="' + (x.id === on ? 'true' : 'false') + '"' + tipAttrs({ key: x.word, noFocus: true }) + '>' + esc(t(x.word)) + '</button>').join('')
    + '</span></span>';
}
/** Redraw the LAYOUT control in its slot when the stop changed; true when it did (the toolbar folds again). @group Map */
export function drawLayoutTool() {
  const M = ST.api && ST.api.MAP;
  const slot = M && M.stage && M.stage.querySelector('.map-layout-slot');
  if (!slot) return false;
  // the board's own pickers (storyline, band by) act on the board: below it they step aside for the stop's controls
  const chrome = slot.closest('.map-chrome');
  const below = stopNow() !== 'nb';
  const was = chrome.classList.contains('below');
  chrome.classList.toggle('below', below);
  const html = layoutToolHtml();
  if (was !== below && slot.dataset.html === html) return true;
  if (slot.dataset.html === html) return false;
  slot.dataset.html = html;
  slot.innerHTML = html;
  return true;
}
/** Pick a layout at a stop: a registered choice's own hook, else the stop redraws. @group Map */
export function setLayout(when, id) {
  const c = MAP_LAYOUTS.find((x) => x.when === when && x.id === id);
  if (!c) return;
  LAYOUT[when] = id;
  if (c.onPick) c.onPick(id);
  else if (when === 'st') { syncTable(); ST.api.writeHash(); }
  else if (when === 'act' && ST.act) { drawAct(); selectBeat(ST.act.beat || 0); ST.api.writeHash(); }
  drawLayoutTool();
}
/** `v`: the next layout at the stop on screen. @group Map */
export function cycleLayout() {
  const stop = stopNow();
  const when = stop === 'code' ? 'act' : stop;
  const list = MAP_LAYOUTS.filter((x) => x.when === when);
  if (list.length < 2) return false;
  const i = list.findIndex((x) => x.id === layoutAt(when));
  setLayout(when, list[(i + 1) % list.length].id);
  return true;
}

// ── the journey with its walk ────────────────────────────────────────────────
function syncKey() { return String((S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.sync) || ''); }
/** The journey answer with its walk (the board reads it without: `steps=0`), once per journey per sync. */
function fetchFull(flow) {
  const key = flow + '@' + syncKey();
  if (!ST.full.has(key)) {
    ST.full.set(key, fetch('/api/journey?entry=' + encodeURIComponent(flow)).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return ST.full.get(key);
}
/** Forget the walks (a new sync). @group Map */
export function forgetWalks() { ST.full.clear(); }
/** Make this answer the journey the shared drawing code reads, and give it this host. */
function useJourney(data, host) {
  if (S.JOURNEY !== data) {
    S.JOURNEY = data;
    S.JRN_TREE = jrnBuildTree(data.steps || []);
    S.journeyActive = -1;
    S.jrnStep = null;
  }
  // one drawing of a journey on the page at a time: the closed overlay's ids must not answer for the Map's
  const tl = document.getElementById('jrn-tl');
  if (tl && !journeyOpen()) tl.innerHTML = '';
  S.JRN_HOST = host;
  S.JRN_STORY = null;
}

// ── the action stop ─────────────────────────────────────────────────────────
/** Whether an action is open on the Map (its stop, or the code over it). @group Map */
export function actionOpen() { return !!ST.act; }
/** The open action, for the address and the crumb: `{ flow, ci, si, beat, code }` or null. @group Map */
export function actionState() {
  if (!ST.act) return null;
  if (S.JRN_DRILL && S.jrnAction != null) ST.act.ci = S.jrnAction;
  return ST.act;
}

/**
 * Open one action of a journey (its Sheet column `ci`, the drill's stop) as the Map's action stop. `o.order` selects
 * that part of the walk, `o.beat` that beat (0-based), `o.code` opens the dock over it, `o.dock` places it.
 * @group Map
 * @business Opens one thing a person does on a screen into its beats: the screen, the call, what the service did and what came back.
 */
export async function openAction(flow, ci, o = {}) {
  const api = ST.api;
  const M = api && api.MAP;
  if (!M || !M.stage) return;
  const gen = ++ST.gen;
  const j = await api.ensureJourney(flow);
  if (gen !== ST.gen || !M.stage || !j || !j.model) return;
  const host = M.stage.querySelector('.map-act-host');
  if (!ST.act) { host.hidden = false; host.innerHTML = '<div class="map-act-wait">' + esc(t('map.act.loading')) + '</div>'; }
  const data = await fetchFull(flow);
  if (gen !== ST.gen || !M.stage || !data || !data.summary || !(data.summary.segments || []).length) {
    if (gen === ST.gen && !ST.act) host.hidden = true;
    return;
  }
  const t0 = performance.now();
  api.closeCard();
  if (M.prop) api.closeProperty({ keepHash: true, quiet: true });
  closeTable();
  useJourney(data, host);
  jrnDrillIndex(data.summary, false);
  const cols = S.JRN_DRILL.cols;
  if (!cols.length) return;
  S.jrnAction = Math.max(0, Math.min(cols.length - 1, ci));
  if (o.dock && o.dock !== jrnDock()) jrnSetDock(o.dock);
  ST.act = { flow, ci: S.jrnAction, si: screenOfAction(cols, j.model.screens, S.jrnAction), beat: 0, code: !!o.code, host, model: j.model };
  M.act = ST.act;
  host.hidden = false;
  M.stage.classList.add('in-act');
  drawAct();
  if (o.order != null && S.JRN_MARK && S.JRN_MARK[o.order]) {
    jrnSelect(o.order, true);
    ST.act.beat = beatOfSelection();
  } else selectBeat(o.beat || 0);
  if (ST.act.code) openCodeTab();
  // the first draw of the stop, for the measurement the round asks for (the e2e and the lane's report read it)
  host.dataset.drawMs = String(Math.round(performance.now() - t0));
  api.writeHash();
  api.refresh();
}
/** Open the action a part of the walk belongs to (a call card's door, a property row). @group Map */
export async function openActionAt(flow, order) {
  const j = await ST.api.ensureJourney(flow);
  if (!j || !j.data) return;
  const ci = actionOfMarker(sheetModel(j.data.summary).cols, order);
  if (ci >= 0) openAction(flow, ci, { order });
}
/** Open the first action of a street screen (`+` past the screen, the ACTION button). @group Map */
export async function openScreenAction(flow, si, o = {}) {
  const j = await ST.api.ensureJourney(flow);
  if (!j || !j.model || !j.data) return false;
  const acts = screenActions(sheetModel(j.data.summary).cols, j.model.screens, si);
  const k = o.action != null ? Math.max(0, Math.min(acts.length - 1, o.action)) : 0;
  if (!acts.length) { ST.api.toast(t('map.act.none')); return false; }
  await openAction(flow, acts[k].index, o);
  return true;
}
/**
 * Leave the action stop. By default back one stop — the screen it is on, as its property; `o.quiet` leaves without
 * going anywhere (another stop is about to be drawn).
 * @group Map
 */
export function closeAction(o = {}) {
  if (!ST.act) return;
  const { flow, si, host } = ST.act;
  ST.gen++;
  ST.act = null;
  const M = ST.api.MAP;
  M.act = null;
  if (S.jrnDrillRO) { S.jrnDrillRO.disconnect(); S.jrnDrillRO = null; }
  host.hidden = true;
  host.innerHTML = '';
  if (S.JRN_HOST === host) S.JRN_HOST = null;
  S.JRN_DRILL = null;
  if (M.stage) M.stage.classList.remove('in-act');
  if (!o.quiet && si >= 0) ST.api.openProperty(flow, si);
  else ST.api.refresh();
}

/** The beat the selection sits in, else 0. */
function beatOfSelection() {
  const dr = S.JRN_DRILL;
  const bi = dr && dr.colOf && S.journeyActive >= 0 ? dr.colOf[S.journeyActive] : null;
  return bi != null ? bi : 0;
}
/** Select one beat: its part (a screen kept open from an earlier action is lit, not walked back into). */
function selectBeat(bi) {
  const dr = S.JRN_DRILL;
  if (!ST.act || !dr || !dr.beats) return;
  const n = dr.beats.length;
  if (!n) return;
  const at = Math.max(0, Math.min(n - 1, bi));
  ST.act.beat = at;
  const b = dr.beats[at];
  const order = beatOrder(b);
  if (b.kind !== 'screen' && order != null) jrnSelect(order, true);
  ST.act.host.querySelectorAll('.jrn-dbh[data-beat]').forEach((el) => el.classList.toggle('on', +el.dataset.beat === at));
  const box = ST.act.host.querySelector(b.kind === 'answer' ? '#jrn-ans' : '#jrn-bx-' + order);
  if (box && box.scrollIntoView) box.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
/** ← / →: the previous or next beat; the code follows when it is open. @group Map */
export function walkBeat(d) {
  if (!ST.act) return;
  selectBeat(beatOfSelection() + d);
  if (ST.act.code) openCodeTab();
  ST.api.writeHash();
}
/** The inspector on its code tab (DOCS in the business lens, which reads no code). */
function openCodeTab() {
  // the code is a part's: a screen kept open from an earlier action has none here, so the next beat that is a part opens
  const dr = S.JRN_DRILL;
  const sel = S.journeyActive != null && S.journeyActive >= 0 && dr && dr.colOf && dr.colOf[S.journeyActive] === ST.act.beat;
  if (!sel && dr && dr.beats) {
    const from = ST.act.beat || 0;
    const at = dr.beats.findIndex((b, i) => i >= from && b.kind !== 'screen');
    selectBeat(at >= 0 ? at : from);
  }
  const tab = currentLens() === 'business' ? 'docs' : 'code';
  if (S.jrnInspTab !== tab && typeof window.jrnDrillInspTab === 'function') window.jrnDrillInspTab(tab);
}
/** `+` at an action: the code behind the beat opens in the dock. @group Map */
export function openCode() {
  if (!ST.act) return;
  ST.act.code = true;
  ST.act.host.querySelector('.map-act').classList.add('code');
  hintLine();
  openCodeTab();
  ST.api.writeHash();
  ST.api.refresh();
}
/** The keys line under the stop, for the action or the code over it. */
function hintLine() {
  const el = ST.act && ST.act.host.querySelector('.map-act-foot');
  if (!el) return;
  const key = ST.act.code ? 'map.code.hint' : 'map.act.hint';
  el.innerHTML = '<span class="map-hintline"' + tipAttrs({ key, noFocus: true }) + '>' + esc(t(key)) + '</span>';
}
/** `−` with the code open: the dock closes, the beats stay. @group Map */
export function closeCode() {
  if (!ST.act) return;
  ST.act.code = false;
  ST.act.host.querySelector('.map-act').classList.remove('code');
  hintLine();
  ST.api.writeHash();
  ST.api.refresh();
}
/** Place the dock — in place, bottom, right — remembered as the journey's is. @group Map */
export function setActDock(d) {
  jrnSetDock(d);
  const el = ST.act && ST.act.host.querySelector('.map-act');
  if (el) { el.dataset.dock = jrnDock(); el.querySelector('.map-act-dock').innerHTML = dockSwitchHtml(); }
  if (ST.act) ST.api.writeHash();
}

/**
 * `+` / `−` below the street (the tools and the keys): at the property `+` opens its first action and `−` the street;
 * at an action `+` opens the code and `−` the screen; with the code open `−` closes it. True when it used the step.
 * @group Map
 */
export function stopZoom(dir) {
  const M = ST.api && ST.api.MAP;
  if (!M) return false;
  if (ST.act) {
    if (dir > 0) { if (!ST.act.code) openCode(); return true; }
    if (ST.act.code) closeCode(); else closeAction();
    return true;
  }
  if (M.prop) {
    if (dir > 0) openScreenAction(M.prop.flow, M.prop.index);
    else ST.api.closeProperty();
    return true;
  }
  if (ST.table && dir > 0) { ST.api.openProperty(ST.table.flow, 0); return true; }
  return false;
}
/** The keys at an action: ← → the beats, [ ] the actions of the journey, d the dock, t its tests. True when used. @group Map */
export function actionKey(e) {
  if (!ST.act) return false;
  const k = e.key;
  if (k === 'ArrowLeft' || k === 'ArrowRight') { walkBeat(k === 'ArrowRight' ? 1 : -1); return true; }
  if (k === '[' || k === ']') {
    const n = S.JRN_DRILL ? S.JRN_DRILL.cols.length : 0;
    const next = (S.jrnAction || 0) + (k === ']' ? 1 : -1);
    if (next >= 0 && next < n) openAction(ST.act.flow, next, { code: ST.act.code });
    return true;
  }
  if (k === 'd' || k === 'D') { const order = ['inline', 'bottom', 'right']; setActDock(order[(order.indexOf(jrnDock()) + 1) % order.length]); return true; }
  if (k === 't' && ST.act.code && typeof window.jrnDrillInspTab === 'function') { window.jrnDrillInspTab('tests'); return true; }
  return false;
}

/** The dock's three places, the journey's own words (`journey.dock.*`). */
function dockSwitchHtml() {
  const v = jrnDock();
  const b = (k, key) => '<button type="button" class="map-seg' + (v === k ? ' on' : '') + '" data-dock="' + k + '" aria-pressed="' + (v === k ? 'true' : 'false') + '"'
    + tipAttrs({ key, noFocus: true }) + '>' + esc(t(key)) + '</button>';
  return '<span class="map-segs" role="group" aria-label="' + esc(t('map.dock')) + '">' + b('inline', 'journey.dock.inline') + b('bottom', 'journey.dock.bottom') + b('right', 'journey.dock.right') + '</span>';
}
/** The journey's screens as a slim strip, the one the action is on lit with *action n of m*. */
function stripHtml() {
  const a = ST.act, model = a.model, cols = S.JRN_DRILL ? S.JRN_DRILL.cols : [];
  const acts = screenActions(cols, model.screens, a.si);
  const k = acts.findIndex((c) => c.index === S.jrnAction);
  return '<div class="map-act-strip" role="group" aria-label="' + esc(t('map.act.strip')) + '">'
    + '<span class="hud-label"' + tipAttrs({ key: 'map.act.strip', noFocus: true }) + '>' + esc(t('map.act.strip')) + '</span>'
    + model.screens.map((s, i) => {
      const on = i === a.si;
      const thumb = s.node && s.node.design && currentLens() !== 'code' ? designThumbHtml(s.node, 'sheet') : '<span class="ph">' + sym('screen') + '</span>';
      const sub = on && k >= 0 ? t('map.crumb.action').replace('{n}', k + 1).replace('{m}', acts.length)
        : s.state === 'planned' ? t('map.screen.planned') : '';
      return '<button type="button" class="map-act-scr' + (on ? ' on' : '') + (s.state === 'planned' ? ' planned' : '') + '" data-si="' + i + '"'
        + ' aria-current="' + (on ? 'step' : 'false') + '">' + thumb
        + '<span class="t"><span class="o">' + s.ordinal + '</span>' + esc(s.name) + (sub ? '<span class="s">' + esc(sub) + '</span>' : '') + '</span></button>';
    }).join('') + '</div>';
}
/** Draw the action stop: the strip, the drill (or its ladder), the dock and the hint. */
function drawAct() {
  const a = ST.act;
  if (!a) return;
  const layout = layoutAt('act');
  a.host.innerHTML = '<div class="map-act' + (a.code ? ' code' : '') + '" data-dock="' + esc(jrnDock()) + '" data-layout="' + esc(layout) + '" data-map-wheel="own">'
    + '<div class="map-act-top">' + stripHtml() + '<span class="map-act-dock">' + dockSwitchHtml() + '</span></div>'
    + jrnDrillStageHtml()
    + '<div class="map-act-foot"><span class="map-hintline"' + tipAttrs({ key: a.code ? 'map.code.hint' : 'map.act.hint', noFocus: true }) + '>' + esc(t(a.code ? 'map.code.hint' : 'map.act.hint')) + '</span></div></div>';
  jrnDrillMount();
  if (layout === 'ladder') {
    const col = S.JRN_DRILL.cols[S.jrnAction];
    const sg = Object.assign({}, col.sg, { markers: col.sg.markers.filter((m) => m.moment === col.mo.index), moments: [col.mo] });
    const lanes = a.host.querySelector('#jrn-dlanes');
    jrnResetFolds();
    lanes.innerHTML = '<div class="map-ladder">' + jrnLadderCellHtml(S.JOURNEY.summary, sg) + '</div>';
  }
  if (!a.wired) {
    a.wired = true;
    a.host.addEventListener('click', onActClick);
  }
}
function onActClick(e) {
  if (!ST.act) return;
  const scr = e.target.closest('.map-act-scr');
  if (scr) { const flow = ST.act.flow, si = +scr.dataset.si; closeAction({ quiet: true }); ST.api.openProperty(flow, si); return; }
  const d = e.target.closest('[data-dock]');
  if (d && d.closest('.map-act-dock')) { setActDock(d.dataset.dock); return; }
  // a box, a fold or the still-open screen moved the selection (or the action): the place follows
  setTimeout(() => {
    if (!ST.act) return;
    const moved = S.jrnAction !== ST.act.ci;
    ST.act.ci = S.jrnAction;
    ST.act.beat = beatOfSelection();
    if (moved) {
      ST.act.si = screenOfAction(S.JRN_DRILL.cols, ST.act.model.screens, ST.act.ci);
      const strip = ST.act.host.querySelector('.map-act-strip');
      if (strip) strip.outerHTML = stripHtml();
    }
    ST.api.writeHash();
    ST.api.refresh();
  }, 0);
}

/** The address of the open action: `screen` (the journey's step), `action` within it, `beat`, layout, dock. @group Map */
export function actionParams() {
  const a = actionState();
  if (!a) return null;
  const sc = a.model.screens[a.si];
  const acts = screenActions(S.JRN_DRILL ? S.JRN_DRILL.cols : [], a.model.screens, a.si);
  const k = acts.findIndex((c) => c.index === a.ci);
  return {
    screen: sc && sc.segment ? String(sc.segment.index + 1) : null,
    action: k >= 0 ? String(k + 1) : null,
    beat: a.beat ? String(a.beat + 1) : null,
    layout: layoutAt('act') !== 'beats' ? layoutAt('act') : null,
    dock: a.code ? jrnDock() : null,
  };
}

// ── the crumb ───────────────────────────────────────────────────────────────
/**
 * The trail under the toolbar: `storyline › journey · step n of m › screen · screen n of m › action n of m · name`,
 * each part as far down as the stop on screen. The bold part is where the reader is.
 * @group Map
 */
export function crumbHtml(o) {
  const sep = '<span class="sep">›</span>';
  const pos = (s) => '<span class="pos">' + esc(s) + '</span>';
  const lvl = o.lvl;
  const story = o.story;
  const at = !story && o.flow ? storylineOf(o.tree, o.flow).find((x) => !x.branch) : null;
  const rootWord = story ? story.name : at ? at.storyline.name : t('map.crumb.root');
  if (lvl === 'nb' || !o.d) return '<b>' + esc(rootWord) + '</b>';
  const stepKey = currentLens() === 'business' ? 'journeys.storyline.bizStepOf' : 'journeys.storyline.stepOf';
  const step = o.d.step ? t(stepKey).replace('{n}', o.d.step).replace('{m}', o.d.steps)
    : at ? t(stepKey).replace('{n}', at.step).replace('{m}', at.of) : '';
  const top = lvl === 'st';
  let html = esc(rootWord) + sep + (top ? '<b>' : '') + esc(o.nameWords(o.d.name)) + (top ? '</b>' : '') + (step ? ' ' + pos(step) : '');
  const model = o.model;
  const si = ST.act ? ST.act.si : o.propIndex;
  if ((lvl === 'pr' || ST.act) && model && model.screens[si]) {
    const s = model.screens[si];
    const sPos = t('map.crumb.screen').replace('{n}', si + 1).replace('{m}', model.screens.length);
    html += sep + (ST.act ? '' : '<b>') + esc(s.name) + (ST.act ? '' : '</b>') + ' ' + pos(sPos);
  }
  if (ST.act && S.JRN_DRILL) {
    const acts = screenActions(S.JRN_DRILL.cols, model.screens, ST.act.si);
    const k = acts.findIndex((c) => c.index === S.jrnAction);
    const col = S.JRN_DRILL.cols[S.jrnAction];
    html += sep + (k >= 0 ? pos(t('map.crumb.action').replace('{n}', k + 1).replace('{m}', acts.length)) + ' · ' : '') + '<b>' + esc(col ? jrnMoLabel(col.mo) : '') + '</b>';
  }
  return html;
}

// ── the table layout at the journey stop ─────────────────────────────────────
/** Whether the Sheet is drawn in place of the street. @group Map */
export function tableOpen() { return !!ST.table; }
/**
 * Draw or take away the table layout after the board moved: on at the journey stop with *table* picked, for the
 * journey the street is on; off anywhere else.
 * @group Map
 */
export function syncTable() {
  const M = ST.api && ST.api.MAP;
  if (!M || !M.cv || !M.stage) return;
  const want = layoutAt('st') === 'table' && M.cv.level() === 'st' && !M.prop && !ST.act && M.focus ? M.focus : null;
  if (!want) { closeTable(); return; }
  if (ST.table && ST.table.flow === want) return;
  drawTable(want);
}
function closeTable() {
  if (!ST.table) return;
  const { host } = ST.table;
  ST.table = null;
  host.hidden = true;
  host.innerHTML = '';
  if (S.JRN_HOST === host) S.JRN_HOST = null;
  S.JRN_SHEET = null;
  const M = ST.api.MAP;
  if (M.stage) M.stage.classList.remove('in-table');
}
async function drawTable(flow) {
  const M = ST.api.MAP;
  const host = M.stage.querySelector('.map-table-host');
  ST.table = { flow, host };
  host.hidden = false;
  M.stage.classList.add('in-table');
  host.innerHTML = '<div class="map-act-wait">' + esc(t('map.act.loading')) + '</div>';
  const [j, data] = await Promise.all([ST.api.ensureJourney(flow), fetchFull(flow)]);
  if (!ST.table || ST.table.flow !== flow) return;
  if (!data || !data.summary || !j) { closeTable(); return; }
  drawTableNow(j, data);
}
function drawTableNow(j, data) {
  const { flow, host } = ST.table;
  useJourney(data, host);
  S.JRN_DRILL = null;
  jrnSheetIndex(data.summary);
  jrnResetFolds();
  // the head scrolls with the table: it is the journey header's facts, and a header that stays put is the one the
  // reviewers lost the first card under at 1280
  host.innerHTML = '<div class="map-table" data-map-wheel="own"><div class="map-table-scroll">'
    + '<div class="map-table-head" data-flow="' + esc(flow) + '">' + ST.api.headHtml(flow) + '</div>'
    + '<div class="map-table-wrap">' + jrnSheetHtml(data.summary) + '</div></div>'
    + '<div class="map-act-foot"><span class="map-hintline"' + tipAttrs({ key: 'map.table.hint', noFocus: true }) + '>' + esc(t('map.table.hint')) + '</span></div></div>';
  if (!ST.table.wired) { ST.table.wired = true; host.addEventListener('click', onTableClick, true); }
}
/** On the table a column — its head, or a part in one of its cells — opens that action's beats. */
function onTableClick(e) {
  if (!ST.table) return;
  if (e.target.closest('a[href], .jrn-smore, .jrn-foldbtn, .map-table-head, [data-export]')) return;
  const head = e.target.closest('.jrn-sbh[data-col]');
  const cell = e.target.closest('.jrn-scell[data-col]');
  const part = e.target.closest('[data-order]');
  if (!head && !(cell && part)) return;
  e.preventDefault();
  e.stopPropagation();
  const ci = +((head || cell).dataset.col);
  openAction(ST.table.flow, ci, part && cell ? { order: +part.dataset.order } : {});
}

/** Redraw the stop on screen in the lens or register now on (words only). @group Map */
export function redrawStops() {
  if (ST.act) { const bi = ST.act.beat; drawAct(); selectBeat(bi); if (ST.act.code) openCodeTab(); }
  if (ST.table && S.JOURNEY) {
    const j = ST.api.MAP.journeys.get(ST.table.flow);
    if (j) drawTableNow(j, S.JOURNEY);
  }
}
/** Leave everything below the street (the Map unmounts, or a new sync). @group Map */
export function closeStops() {
  closeAction({ quiet: true });
  closeTable();
}

// ── the street head's facts ─────────────────────────────────────────────────
/**
 * What the journey header carried besides its counts, on the street's head: where the journey stands in a storyline,
 * the status lifecycle of the records it moves (lib/lifecycle-strip.js, through the journey's own call) and Save —
 * the stop on screen as a picture.
 * @group Map
 */
export function streetFactsHtml(flow, j, tree) {
  if (!j || !j.data) return '';
  const story = storylineLineHtml(tree, flow);
  const lc = jrnLifecycleHtml(j.data);
  return '<div class="facts">' + (story ? '<span class="story">' + story + '</span>' : '')
    + (lc ? '<span class="lc"' + tipAttrs({ key: 'map.head.lifecycle', noFocus: true }) + '>' + lc + '</span>' : '')
    + exportToolHtml('street', 'map-tb map-tb-save') + '</div>';
}

/**
 * What Save draws at a stop below the board: the action's beats with the dock as it is, the table, or the journey's
 * district — what is in view, whole.
 * @group Map
 * @business Saves the stop on screen — one action's beats, the journey as a table, or its street — as one picture.
 */
async function stopPicture() {
  const M = ST.api && ST.api.MAP;
  if (!M) return null;
  const subject = (id) => String(id || '').split('::').pop();
  if (ST.act) return { el: ST.act.host.querySelector('.map-act'), title: t('map.level.act'), subject: subject(ST.act.flow) };
  if (ST.table) return { el: ST.table.host.querySelector('.map-table'), title: t('map.layout.table'), subject: subject(ST.table.flow) };
  const el = M.focus && M.world && M.world.querySelector('.map-district[data-flow="' + CSS.escape(M.focus) + '"]');
  return el ? { el, title: t('map.level.st'), subject: subject(M.focus) } : null;
}
registerExport('street', stopPicture);
