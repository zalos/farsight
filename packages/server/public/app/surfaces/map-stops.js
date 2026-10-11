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

import { S, esc, currentLens, expose } from '../store.js';
import { t } from '../strings.js';
import { sym } from '../sym.js';
import { tipAttrs } from '../lib/tooltip.js';
import { designThumbHtml } from '../lib/graph-render.js';
import { storylineOf, placesOf } from '../lib/journeys-model.js';
import { jrnPersonaName, jrnGroupName } from '../lib/journeys-tree.js';
import { sheetModel, screenActions, screenOfAction, actionOfMarker, beatOrder, segmentActionOf } from '../lib/journey-model.js';
import { storylineLineHtml } from '../lib/detail-doors.js';
import { registerExport } from '../lib/export.js';
import {
  jrnBuildTree, jrnSheetIndex, jrnSheetHtml, jrnResetFolds, jrnSelect, jrnLadderCellHtml, jrnDock, jrnSetDock,
  jrnLifecycleHtml, jrnMoLabel, jrnMarkerAt, jrnNav, jrnApplyDock, jrnCollectForks, jrnForksPanelHtml, jrnToggleForks,
  jrnForksBtnHtml, jrnImpactRings, jrnCutChip, jrnHeaderHtml, jrnToggleCuts, cutsOpen, forksOpen, expandedOpen, closeExpanded, jrnScrollTo,
} from '../lib/journey-draw.js';
import { partOrder, screenRowAt } from '../lib/route-url.js';
import { jrnDrillIndex, jrnDrillStageHtml, jrnDrillMount, jrnDrillRailHtml, jrnInspHostHtml } from './journey-drill.js';
import { dockPanel, openPanel, closePanel, panelOpen, dockPlace } from '../lib/map-dock.js';

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
  // the one journey as swimlanes (surfaces/map.js draws them, through the storyline lanes' own model)
  { id: 'lanes', word: 'map.layout.journeyLanes', when: 'st' },
  { id: 'table', word: 'map.layout.table', when: 'st' },
  // the drill (cleanup pass 2026-10-11): the action stop entered with the journey's action rail shown — at the journey
  // stop it opens the first action that way; at the action stop it is the rail over the beats
  { id: 'drill', word: 'map.layout.drill', when: 'st' },
  { id: 'beats', word: 'map.layout.beats', when: 'act' },
  { id: 'ladder', word: 'map.layout.ladder', when: 'act' },
  { id: 'drill', word: 'map.layout.drill', when: 'act' },
];
/** Add (or replace, by id and stop) one layout choice. @group Map */
export function registerMapLayout(choice) {
  const i = MAP_LAYOUTS.findIndex((x) => x.id === choice.id && x.when === choice.when);
  if (i >= 0) MAP_LAYOUTS[i] = choice; else MAP_LAYOUTS.push(choice);
}
const LAYOUT = {};

// ── the register's own view of a journey (lanes round 2026-10-10, one address) ──────────────────────────────
// A journey opened by a door that names no place lands where its register reads best: the business register on the
// screens (the street, big pictures and the screen's own sentence — the storyboard's look), the hybrid register on the
// table, the code register on the first action's beats with the code open. What a reader picks with the LAYOUT
// control (or `v`) at the journey or the action stop is remembered for their register (`fs-map-view.<lens>`, which
// replaces the journey page's `fs-jrn-layout.<lens>`); a link that names a layout wins for the visit it opened.
const VIEWS = ['screens', 'lanes', 'table', 'beats', 'ladder', 'drill'];
const VIEW_DEFAULT = { business: 'screens', hybrid: 'table', code: 'beats' };
/** The view a journey opens at in this register: what the reader last picked here, else the register's default. @group Map */
export function registerView(lens = currentLens()) {
  let v = null;
  try { v = localStorage.getItem('fs-map-view.' + lens); } catch (e) { v = null; }
  return VIEWS.includes(v) ? v : (VIEW_DEFAULT[lens] || 'screens');
}
/** Remember the view the reader picked, for their register. */
function rememberView(v) {
  if (!VIEWS.includes(v)) return;
  try { localStorage.setItem('fs-map-view.' + currentLens(), v); } catch (e) { /* private mode: the default stays */ }
}
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
  // the control keeps its slot at every stop (the chrome holds still): a stop drawn one way says so, quietly
  if (list.length < 2) {
    const only = list[0];
    return '<span class="map-layout one" role="group" aria-label="' + esc(t('map.layout')) + '">'
      + '<span class="hud-label"' + tipAttrs({ key: 'map.layout', noFocus: true }) + '>' + esc(t('map.layout')) + '</span><span class="map-segs">'
      + '<span class="map-seg on" aria-disabled="true"' + tipAttrs({ key: only ? only.word : 'map.layout.one', noFocus: true }) + '>' + esc(t(only ? only.word : 'map.layout.one')) + '</span></span></span>';
  }
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
/**
 * Pick a layout at a stop: a registered choice's own hook, else the stop redraws. `o.remember` (the reader's own pick —
 * the control or `v`) keeps it as the register's view of a journey.
 * @group Map
 */
export function setLayout(when, id, o = {}) {
  const c = MAP_LAYOUTS.find((x) => x.when === when && x.id === id);
  if (!c) return;
  if (when === 'st' && id === 'drill') {
    // the drill is the action stop with the rail in view: the journey stop keeps the layout it had (its way back up)
    if (o.remember) rememberView('drill');
    LAYOUT.act = 'drill';
    if (o.open !== false) openDrill();
    drawLayoutTool();
    return;
  }
  LAYOUT[when] = id;
  if (o.remember && (when === 'st' || when === 'act')) rememberView(id);
  if (c.onPick) c.onPick(id);
  else if (when === 'st') { syncTable(); if (ST.api.syncJourneyLanes) ST.api.syncJourneyLanes(); ST.api.writeHash(); }
  else if (when === 'act' && ST.act) { drawAct(); selectBeat(ST.act.beat || 0); ST.api.writeHash(); }
  drawLayoutTool();
}
/** Open the drill: the journey on screen (the table's screen, else the first) at its first action, the rail over it. */
function openDrill() {
  const M = ST.api && ST.api.MAP;
  if (!M) return;
  const flow = ST.table ? ST.table.flow : M.prop ? M.prop.flow : M.focus;
  if (!flow) return;
  const ts = tableScreen();
  ST.api.ensureJourney(flow).then((j) => {
    if (!j || !j.model) return;
    const si = ts != null ? screenRowAt(j.model.screens, ts) : M.prop && M.prop.flow === flow ? M.prop.index : 0;
    if (j.model.screens.length) openScreenAction(flow, si != null ? si : 0);
    else openAction(flow, 0);
  });
}
/** `v`: the next layout at the stop on screen. @group Map */
export function cycleLayout() {
  const stop = stopNow();
  const when = stop === 'code' ? 'act' : stop;
  const list = MAP_LAYOUTS.filter((x) => x.when === when);
  if (list.length < 2) return false;
  const i = list.findIndex((x) => x.id === layoutAt(when));
  setLayout(when, list[(i + 1) % list.length].id, { remember: true });
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
/** A part was selected on the stop (a click, j / k, a door): the address follows it. */
function onSelect() {
  if (ST.api && (ST.table || ST.act)) { ST.api.writeHash(); if (ST.table) ST.api.refresh(); }
}
/** The drawing asked for the stop to be drawn again (a business tab of the checks lane moved). */
function onRedraw() { redrawStops(); }
/** Make this answer the journey the shared drawing code reads, and give it this host. */
function useJourney(data, host) {
  if (S.JOURNEY !== data) {
    S.JOURNEY = data;
    S.JRN_TREE = jrnBuildTree(data.steps || []);
    S.journeyActive = -1;
  }
  S.JRN_HOST = host;
  // a part selected on the stop moves the address with it (the table's `part=`, the action's `beat=`)
  S.JRN_ON_SELECT = onSelect;
  S.JRN_REDRAW = onRedraw;
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
  if (o.dock && o.dock !== jrnDock()) { jrnSetDock(o.dock); if (ST.api.dockMoved) ST.api.dockMoved(); }
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
/** Open the action a part of the walk belongs to (a call card's door, a property row, a link's `part=`). @group Map */
export async function openActionAt(flow, order, o = {}) {
  const j = await ST.api.ensureJourney(flow);
  if (!j || !j.data) return;
  const ci = actionOfMarker(sheetModel(j.data.summary).cols, order);
  if (ci >= 0) await openAction(flow, ci, { ...o, order });
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
  inspHost(false);
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
  if (dockPlace() !== 'inline') { inspHost(true); openPanel('code'); }
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
  closePanel('code', { quiet: true });
  hintLine();
  ST.api.writeHash();
  ST.api.refresh();
}
/** Place the dock — in place, bottom, right — remembered as the journey's is. @group Map */
export function setActDock(d) {
  jrnSetDock(d);
  // the Map's dock redraws its switch and, seeing the place moved, calls stopsDockMoved() — the one way it moves
  if (ST.api && ST.api.dockMoved) ST.api.dockMoved(); else stopsDockMoved();
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

/**
 * The inspector's host in the Map's dock: made (and the drill's own column left out) when the code is docked beside
 * or below; emptied and closed when it is docked in place, so the page never holds two `#jrn-insp`.
 */
function inspHost(inDock) {
  const el = dockPanel('code', { key: 'map.dock.code', close: () => { if (ST.act && ST.act.code) closeCode(); } });
  if (!el) return null;
  if (!inDock) { closePanel('code', { quiet: true }); el.innerHTML = ''; return null; }
  if (!el.querySelector('#jrn-insp')) el.innerHTML = jrnInspHostHtml();
  return el;
}
/**
 * The dock moved (right · bottom · in place): the code at an action and a table part's pane go where it now is.
 * @group Map
 */
export function stopsDockMoved() {
  if (ST.act) { const bi = ST.act.beat; drawAct(); selectBeat(bi); if (ST.act.code) openCodeTab(); }
  if (ST.table) { placePartPane(); jrnApplyDock(); }
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
  // the code opens in the Map's one dock (lib/map-dock.js) unless it is docked in place, under the beats
  const inPlace = dockPlace() === 'inline';
  inspHost(!inPlace);
  // the drill: the journey's action rail across the top in place of the street's strip (the owner's older drill view)
  const top = layout === 'drill' ? jrnDrillRailHtml(S.JOURNEY.summary, S.JRN_DRILL.cols, S.jrnAction) : stripHtml();
  a.host.innerHTML = '<div class="map-act' + (a.code ? ' code' : '') + '" data-dock="' + esc(jrnDock()) + '" data-layout="' + esc(layout) + '" data-map-wheel="own">'
    + '<div class="map-act-top' + (layout === 'drill' ? ' rail' : '') + '">' + top + '</div>'
    + jrnDrillStageHtml({ insp: inPlace })
    + '<div class="map-act-foot"><span class="map-hintline"' + tipAttrs({ key: a.code ? 'map.code.hint' : 'map.act.hint', noFocus: true }) + '>' + esc(t(a.code ? 'map.code.hint' : 'map.act.hint')) + '</span></div></div>';
  jrnDrillMount();
  if (layout === 'drill') {
    const on = a.host.querySelector('.jrn-stop.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  if (a.code && !inPlace) openPanel('code');
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
  // the rail: a stop opens that action; a screen over it, the screen's first action
  const stop = e.target.closest('.map-rail .jrn-stop[data-col]');
  if (stop) { openAction(ST.act.flow, +stop.dataset.col, { code: ST.act.code }); return; }
  const seg = e.target.closest('.map-rail .jrn-rscr[data-seg]');
  if (seg) {
    const col = (S.JRN_DRILL ? S.JRN_DRILL.cols : []).find((c) => c.sg.index === +seg.dataset.seg);
    if (col) openAction(ST.act.flow, col.index, { code: ST.act.code });
    return;
  }
  const scr = e.target.closest('.map-act-scr');
  if (scr) { const flow = ST.act.flow, si = +scr.dataset.si; closeAction({ quiet: true }); ST.api.openProperty(flow, si); return; }
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
      const rail = ST.act.host.querySelector('.map-rail');
      if (rail) rail.outerHTML = jrnDrillRailHtml(S.JOURNEY.summary, S.JRN_DRILL.cols, S.jrnAction);
    }
    ST.api.writeHash();
    ST.api.refresh();
  }, 0);
}

/** The address of the open action: `screen` (the journey's step), `action` within it, `beat`, layout, dock. @group Map */
export function actionParams() {
  const a = actionState();
  if (!a) return null;
  // the action's own segment and its place among that segment's actions — the unit the Tests page scopes by
  const at = segmentActionOf(S.JRN_DRILL ? S.JRN_DRILL.cols : [], a.ci);
  return {
    screen: at ? String(at.screen) : null,
    action: at ? String(at.action) : null,
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
  // the table at a screen (`screen=`) names it too, as the property and the action do
  const ts = !ST.act && lvl === 'st' && model ? tableScreen() : null;
  const tsi = ts != null ? screenRowAt(model.screens, ts) : null;
  const si = ST.act ? ST.act.si : tsi != null ? tsi : o.propIndex;
  if ((lvl === 'pr' || ST.act || tsi != null) && model && model.screens[si]) {
    const s = model.screens[si];
    const sPos = t('map.crumb.screen').replace('{n}', si + 1).replace('{m}', model.screens.length);
    const bold = !ST.act;
    html += sep + (bold ? '<b>' : '') + esc(s.name) + (bold ? '</b>' : '') + ' ' + pos(sPos);
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
  S.journeyActive = -1;
  S.jrnForksOpen = false;
  S.jrnCutsOpen = false;
  const M = ST.api.MAP;
  if (M.stage) M.stage.classList.remove('in-table');
  if (ST.partMO) ST.partMO.disconnect();
  const panel = dockPanel('part');
  closePanel('part', { quiet: true });
  if (panel) panel.innerHTML = '';
}
async function drawTable(flow) {
  const M = ST.api.MAP;
  const host = M.stage.querySelector('.map-table-host');
  ST.table = { flow, host, part: ST.tablePart && ST.tablePart.flow === flow ? ST.tablePart : null,
    screen: ST.tableScreen && ST.tableScreen.flow === flow ? ST.tableScreen.screen : null };
  ST.tablePart = null;
  ST.tableScreen = null;
  host.hidden = false;
  M.stage.classList.add('in-table');
  host.innerHTML = '<div class="map-act-wait">' + esc(t('map.act.loading')) + '</div>';
  // an action opened while the walk was on its way (a link to a stop below) wins: the table it left must not draw,
  // nor write its address over the action's
  const gen = ST.gen;
  const [j, data] = await Promise.all([ST.api.ensureJourney(flow), fetchFull(flow)]);
  if (!ST.table || ST.table.flow !== flow || gen !== ST.gen) return;
  if (!data || !data.summary || !j) { closeTable(); return; }
  drawTableNow(j, data, { first: true });
}
function drawTableNow(j, data, o = {}) {
  const { flow, host } = ST.table;
  const keep = S.JOURNEY === data && S.journeyActive >= 0 ? S.journeyActive : -1;
  useJourney(data, host);
  S.JRN_DRILL = null;
  jrnSheetIndex(data.summary);
  jrnResetFolds();
  const forks = jrnCollectForks();
  // the journey's head is the Map's own bar above the stage (surfaces/map.js drawHead — it prints the table's count
  // line, `tableCountHtml`, at this layout), so it never scrolls over the first card (cleanup pass 2026-10-11). What
  // only the table has stays with it on one slim row: the forks the walk met (the code register) and the places the
  // walk stopped short, each opening its drawer. The table, a part's code (`j` / `k` walk the parts, `d` moves the
  // dock — beside it in the Map's dock, or in place) and the two drawers share one body.
  ST.table.count = '<span class="jrn-count map-table-count">' + jrnHeaderHtml(data, data.summary, (data.summary && data.summary.counts) || {}, currentLens()) + '</span>';
  host.innerHTML = '<div class="map-table" data-map-wheel="own"><div class="jrn-body map-table-body" id="jrn-body"><div class="map-table-scroll">'
    + '<div class="map-table-tools" data-flow="' + esc(flow) + '">' + jrnForksBtnHtml(data, forks)
    + (data.truncated ? '<span class="jrn-trunc"' + tipAttrs({ key: 'journey.truncated', noFocus: true }) + '>' + sym('warning') + esc(t('journey.truncated').replace('{cap}', String((data.steps || []).length))) + '</span>' : '')
    + '<button type="button" class="jrn-cuts" id="jrn-cuts" style="display:none" aria-expanded="false" onclick="jrnToggleCuts()"></button></div>'
    + '<div class="map-table-wrap">' + jrnSheetHtml(data.summary) + '</div></div>'
    + '<div class="jrn-dock" id="jrn-dock" style="display:none" role="region" aria-label="' + esc(t('map.dock')) + '"></div>'
    + '<div class="jrn-forks" id="jrn-forks" role="dialog" aria-label="' + esc(t('journey.forks.title')) + '" inert>' + jrnForksPanelHtml(forks) + '</div>'
    + '<div class="jrn-cutlist" id="jrn-cutlist" role="dialog" inert></div></div>'
    + '<div class="map-act-foot"><span class="map-hintline"' + tipAttrs({ key: 'map.table.hint', noFocus: true }) + '>' + esc(t('map.table.hint')) + '</span></div></div>';
  jrnCutChip(data, (data.summary && data.summary.counts) || {});
  jrnToggleForks(false);
  jrnApplyDock();
  placePartPane();
  if (!ST.table.wired) { ST.table.wired = true; host.addEventListener('click', onTableClick, true); }
  // the part a link names (`part=`), else the one selected before a redraw, opens with its code in the dock
  const want = ST.table.part;
  ST.table.part = null;
  ST.table.data = data;
  const order = want ? partOrder(data.summary.segments, want.screen, want.node) : keep;
  if (order != null && order >= 0 && S.JRN_MARK[order]) jrnSelect(order);
  else { jrnImpactRings(); showTableScreen(); }
  // the address and the crumb follow the table now that it has drawn the first time (a write before the walk landed
  // knew no part); a redraw for the register writes nothing — a link that moved the register may name another stop
  if (o.first) { ST.api.writeHash(); ST.api.refresh(); }
}
/**
 * The table's count line for the journey head (surfaces/map.js), once the table has drawn for `flow`; else null and
 * the head prints the street's chips.
 * @group Map
 */
export function tableCountHtml(flow) {
  return ST.table && ST.table.flow === flow && ST.table.count ? ST.table.count : null;
}
/**
 * A table part's pane (`#jrn-dock`: its contract or code) sits in the Map's dock when the dock is beside or below,
 * open while a part is selected; docked in place it goes back into the table's body, under the part's row.
 */
function placePartPane() {
  const pane = document.getElementById('jrn-dock');
  if (!pane || !ST.table) return;
  const body = ST.table.host.querySelector('#jrn-body');
  if (dockPlace() === 'inline') {
    if (body && pane.parentNode !== body) body.appendChild(pane);
    closePanel('part', { quiet: true });
    return;
  }
  const panel = dockPanel('part', { key: 'map.dock.part', close: () => { if (expandedOpen()) { closeExpanded(); onSelect(); } } });
  if (!panel) return;
  if (pane.parentNode !== panel) { panel.innerHTML = ''; panel.appendChild(pane); }
  if (!ST.partMO && typeof MutationObserver === 'function') ST.partMO = new MutationObserver(syncPartPanel);
  if (ST.partMO) { ST.partMO.disconnect(); ST.partMO.observe(pane, { attributes: true, attributeFilter: ['class'] }); }
  syncPartPanel();
}
/** The part panel is open while the pane holds a part (not its one-line hint). */
function syncPartPanel() {
  const pane = document.getElementById('jrn-dock');
  const want = !!(ST.table && pane && !pane.classList.contains('empty') && dockPlace() !== 'inline');
  if (want && !panelOpen('part')) openPanel('part');
  else if (!want && panelOpen('part')) closePanel('part', { quiet: true });
}
/** Bring the screen the address names (`screen=`) to the table's left edge, its columns marked. */
function showTableScreen() {
  const n = ST.table && ST.table.screen;
  if (!n || !S.JRN_SHEET) return;
  const cols = S.JRN_SHEET.cols.filter((c) => c.sg.index === n - 1).map((c) => c.index);
  const host = ST.table.host;
  host.querySelectorAll('.jrn-sbh[data-col]').forEach((el) => el.classList.toggle('at', cols.includes(+el.dataset.col)));
  const first = cols.length ? host.querySelector('.jrn-sbh[data-col="' + cols[0] + '"]') : null;
  const scroll = host.querySelector('.map-table-scroll');
  const lane = host.querySelector('.jrn-slane');
  if (first && scroll) scroll.scrollLeft += first.getBoundingClientRect().left - scroll.getBoundingClientRect().left - (lane ? lane.getBoundingClientRect().width : 0) - 8;
}
/**
 * Open the table at one screen (`screen=n`, a 1-based segment — an old link's `step=`): its columns come to the left
 * edge and the crumb names the screen; the address keeps `screen` while no part is selected.
 * @group Map
 */
export function tableAtScreen(flow, screen) {
  ST.tableScreen = screen ? { flow, screen } : null;
  if (ST.table && ST.table.flow === flow && ST.tableScreen) { ST.table.screen = screen; ST.tableScreen = null; showTableScreen(); }
}
/** The screen the table is at (1-based segment), or null. @group Map */
export function tableScreen() {
  if (!ST.table || S.JRN_DRILL) return null;
  if (S.JOURNEY && S.JOURNEY === ST.table.data && S.journeyActive >= 0) {
    const sg = (S.JOURNEY.summary.segments || []).find((x) => S.journeyActive >= x.from && S.journeyActive <= x.to);
    if (sg) return sg.index + 1;
  }
  return ST.table.screen || null;
}
/**
 * Open the table for a journey with one part of its walk selected (`part=` — an old link's `node=`, a lifecycle
 * writer's door): the table draws, the part's column scrolls into view and its code opens in the dock.
 * @group Map
 */
export function tableAtPart(flow, node, screen) {
  ST.tablePart = node ? { flow, node, screen } : null;
  if (ST.table && ST.table.flow === flow && S.JOURNEY && ST.tablePart) {
    const order = partOrder(S.JOURNEY.summary.segments, screen, node);
    ST.tablePart = null;
    if (order != null && S.JRN_MARK[order]) jrnSelect(order);
  }
}
/** The table's part of the address: the part selected and where its code opens. @group Map */
export function tableParams() {
  if (!ST.table || S.JRN_DRILL) return null;
  // no part selected (or the walk not landed yet): the screen the table was opened at, when the address named one
  const mk = S.JOURNEY && S.JOURNEY === ST.table.data && S.journeyActive >= 0 ? jrnMarkerAt(S.journeyActive) : null;
  if (!mk || !mk.nodeId) return ST.table.screen ? { part: null, screen: String(ST.table.screen), dock: null } : null;
  const sg = (S.JOURNEY.summary.segments || []).find((x) => S.journeyActive >= x.from && S.journeyActive <= x.to);
  return { part: mk.nodeId, screen: sg ? String(sg.index + 1) : null, dock: jrnDock() };
}
/** The keys at the table: j / k walk its parts (each opening its code), d moves the dock. True when used. @group Map */
export function tableKey(e) {
  if (!ST.table || !S.JOURNEY || S.JRN_DRILL) return false;
  const k = e.key;
  if (k === 'j' || k === 'k') { jrnNav(k === 'j' ? 1 : -1); return true; }
  if (k === 'd' || k === 'D') { const order = ['inline', 'bottom', 'right']; setActDock(order[(order.indexOf(jrnDock()) + 1) % order.length]); onSelect(); return true; }
  return false;
}
/** Esc at the table closes what is on top of it first — the cut list, the forks, a part's code. True when it did. @group Map */
export function tableEscape() {
  if (!ST.table) return false;
  if (cutsOpen()) { jrnToggleCuts(false); return true; }
  if (forksOpen()) { jrnToggleForks(false); return true; }
  if (expandedOpen()) { closeExpanded(); onSelect(); return true; }
  return false;
}
/** On the table a column — its head, or a part in one of its cells — opens that action's beats. */
function onTableClick(e) {
  if (!ST.table) return;
  if (e.target.closest('a[href], .jrn-smore, .jrn-foldbtn, .map-table-head, [data-export], .jrn-dock, .jrn-forks, .jrn-cutlist, .jrn-sexp')) return;
  const head = e.target.closest('.jrn-sbh[data-col]');
  const cell = e.target.closest('.jrn-scell[data-col]');
  const part = e.target.closest('[data-order]');
  if (!head && !(cell && part)) return;
  e.preventDefault();
  e.stopPropagation();
  const ci = +((head || cell).dataset.col);
  openAction(ST.table.flow, ci, part && cell ? { order: +part.dataset.order } : {});
}

/**
 * Show one part of the journey's walk (its step order) where the reader is: selected in place on the table or at the
 * action, else the action that holds it opened from the street or the screen. False when no journey is on the Map
 * (the caller does what it does elsewhere). The gate card's *show it in the journey* and the impact list's rows.
 * @group Map
 */
export function mapShowPart(order) {
  const M = ST.api && ST.api.MAP;
  if (!M || !M.stage || !S.JOURNEY || !(order >= 0)) return false;
  if ((ST.table || ST.act) && S.JRN_HOST && S.JRN_HOST.isConnected) { jrnScrollTo(order); return true; }
  const flow = M.prop ? M.prop.flow : M.focus;
  const id = S.JOURNEY.entry && S.JOURNEY.entry.id;
  if (!flow || flow !== id) return false;
  openActionAt(flow, order);
  return true;
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
 * Where the journey stands in a storyline, with ‹ › to the journeys before and after it — the journey head's first
 * line (surfaces/map.js drawHead). '' when the journey is in no storyline.
 * @group Map
 */
export function storyNavLineHtml(tree, flow) {
  const story = storylineLineHtml(tree, flow);
  return story ? '<span class="story">' + storyNavHtml(tree, flow, 'prev') + story + storyNavHtml(tree, flow, 'next') + '</span>' : '';
}

/**
 * Who the journey is for and its group, from the organised tree (the journey page's header said it):
 * *For <persona> · <group>*, a journey for two people naming the rest. '' when the tree does not place it. Drawn at
 * the end of the head's chip row, so the head grows by no line.
 * @group Map
 */
export function forLineHtml(tree, flow) {
  const places = placesOf(tree, flow);
  if (!places.length) return '';
  const p = places[0];
  const others = [...new Set(places.slice(1).map((x) => x.persona))].filter((x) => x !== p.persona);
  return '<span class="for g-org"><span' + tipAttrs({ key: 'journeys.persona.for', noFocus: true }) + '>' + esc(t('journeys.persona.for')) + '</span> '
    + '<a href="' + esc('#/journeys?persona=' + encodeURIComponent(p.persona.id)) + '">' + esc(jrnPersonaName(p.persona)) + '</a>'
    + ' · <span>' + esc(jrnGroupName(p.group)) + '</span>'
    + (others.length ? ' <span' + tipAttrs({ key: 'journeys.persona.alsoUnder', noFocus: true }) + '>' + esc(t('journeys.persona.alsoUnder').replace('{names}', others.map(jrnPersonaName).join(' · '))) + '</span>' : '')
    + '</span>';
}
/** ‹ or › beside the storyline: the journey before or after this one in it, on the Map. '' at an end or in none. */
function storyNavHtml(tree, flow, dir) {
  const a = storylineOf(tree, flow)[0];
  const j = a && (dir === 'prev' ? a.prev : a.next);
  const key = dir === 'prev' ? 'journeys.storyline.prev' : 'journeys.storyline.next';
  const glyph = dir === 'prev' ? '‹' : '›';
  if (!j) return '';
  return '<a class="map-story-nav ' + dir + '" href="' + esc('#/map/' + encodeURIComponent(j.nodeId)) + '" aria-label="' + esc(t(key) + ' · ' + (j.name || j.id)) + '"'
    + tipAttrs({ text: t(key) + ' · ' + (j.name || j.id), noFocus: true }) + '>' + glyph + '</a>';
}

/**
 * What Save draws at a stop below the board: the action's beats with the dock as it is, the table, or the journey's
 * district — what is in view, whole.
 * @group Map
 * @business Saves the stop on screen — one action's beats, the journey as a table, or its street — as one picture.
 */
export async function stopPicture() {
  const M = ST.api && ST.api.MAP;
  if (!M) return null;
  const subject = (id) => String(id || '').split('::').pop();
  if (ST.act) return { el: ST.act.host.querySelector('.map-act'), title: t('map.level.act'), subject: subject(ST.act.flow) };
  if (ST.table) return { el: ST.table.host.querySelector('.map-table'), title: t('map.layout.table'), subject: subject(ST.table.flow) };
  const el = M.focus && M.world && M.world.querySelector('.map-district[data-flow="' + CSS.escape(M.focus) + '"]');
  return el ? { el, title: t('map.level.st'), subject: subject(M.focus) } : null;
}
registerExport('street', stopPicture);

expose({ mapShowPart });
