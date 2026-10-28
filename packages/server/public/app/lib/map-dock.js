// lib/map-dock.js — the Map's one dock (cleanup pass 2026-10-11, lane P1: "the chrome holds still").
//
// Everything the Map opens beside what it draws opens here, in one place: the guided walk (lib/tour.js), the code
// behind a beat (the drill's inspector — DOCS · CODE · FORKS · TESTS · CHANGE IMPACT), a table part's code, the
// lifecycle's *what each one means* table, the comparison of two syncs and the rest of a journey's description. The
// dock takes a column of its own — the stage beside it shrinks and is never drawn over — on the right by default, or
// along the bottom; *in place* puts the code back where it belongs (under the beats, under the table's row) while the
// other panels stay on the right. Its header is pinned (one tab per open panel, the place switch, ✕); each panel
// lays out its own body and foot (the walk keeps its stop line pinned on top and ASK pinned at the foot).
//
// The place is the journey's one dock setting (`fs-jrn-dock`, lib/journey-draw.js `jrnDock` / `jrnSetDock`), so the
// table's part pane, the action's inspector and the walk always agree on where they are.

import { esc } from '../store.js';
import { t } from '../strings.js';
import { tipAttrs } from './tooltip.js';
import { jrnDock, jrnSetDock } from './journey-draw.js';

const D = {
  el: null,
  /** panel id → { key, el, open, close, order } */
  panels: new Map(),
  /** the open panels, most recently opened last */
  stack: [],
  active: null,
  onChange: null,
};

/** The dock's markup, once, in the Map's stage. */
export function dockHtml() {
  return (
    '<aside class="map-dock" hidden data-map-wheel="own" aria-label="' +
    esc(t('map.dock.title')) +
    '">' +
    '<div class="md-head"><div class="md-tabs" role="tablist"></div><span class="md-place"></span>' +
    '<button type="button" class="md-x" data-md="close" aria-label="' +
    esc(t('map.dock.close')) +
    '"' +
    tipAttrs({ key: 'map.dock.close', noFocus: true }) +
    '>✕</button></div>' +
    '<div class="md-panels"></div></aside>'
  );
}

/** Bind the dock: its element, and what the Map does when it opens, closes or moves (`onChange({ open, place })`). */
export function bindDock(el, onChange) {
  D.el = el;
  D.onChange = onChange;
  D.panels = new Map();
  D.stack = [];
  D.active = null;
  if (!el) return;
  el.addEventListener('click', onClick);
}

/** Forget the dock (the Map unmounts). */
export function unbindDock() {
  if (D.el) D.el.removeEventListener('click', onClick);
  D.el = null;
  D.onChange = null;
  D.panels = new Map();
  D.stack = [];
  D.active = null;
}

/**
 * The element of panel `id`, made on first ask: `o.key` is its tab's catalog key, `o.close()` what ✕ (or the tab's
 * own close) does — the panel's owner closes what it shows, and the dock forgets it.
 */
export function dockPanel(id, o = {}) {
  if (!D.el) return null;
  let p = D.panels.get(id);
  if (!p) {
    const el = document.createElement('section');
    el.className = 'md-panel md-' + id;
    el.dataset.panel = id;
    el.setAttribute('role', 'tabpanel');
    el.hidden = true;
    D.el.querySelector('.md-panels').appendChild(el);
    p = { key: o.key || 'map.dock.title', el, open: false, close: o.close || null };
    D.panels.set(id, p);
  } else {
    if (o.key) p.key = o.key;
    if (o.close) p.close = o.close;
  }
  return p.el;
}

/** Open panel `id` and bring it to the front. */
export function openPanel(id) {
  const p = D.panels.get(id);
  if (!p) return;
  p.open = true;
  D.stack = D.stack.filter((x) => x !== id).concat(id);
  D.active = id;
  draw();
}

/**
 * Close panel `id`. `o.quiet` only forgets it (its owner already closed what it shows); otherwise its `close()` runs.
 */
export function closePanel(id, o = {}) {
  const p = D.panels.get(id);
  if (!p || !p.open) return;
  p.open = false;
  D.stack = D.stack.filter((x) => x !== id);
  if (D.active === id) D.active = D.stack.length ? D.stack[D.stack.length - 1] : null;
  draw();
  if (!o.quiet && p.close) p.close();
}

export function panelOpen(id) {
  const p = D.panels.get(id);
  return !!(p && p.open);
}
export function dockOpen() {
  return D.stack.length > 0;
}
export function activePanel() {
  return D.active;
}

/** Where the dock sits: `right` · `bottom` · `inline` (the code in place; the other panels on the right). */
export function dockPlace() {
  return jrnDock();
}
/** Move the dock; the Map moves what it holds and re-lays its stage. */
export function setDockPlace(p) {
  jrnSetDock(p);
  draw();
}

/** Redraw the header (the lens moved the words). */
export function redrawDock() {
  draw();
}

function draw() {
  const el = D.el;
  if (!el) return;
  const open = D.stack.length > 0;
  const place = jrnDock();
  el.hidden = !open;
  el.dataset.place = place === 'bottom' ? 'bottom' : 'right';
  const tabs = el.querySelector('.md-tabs');
  // the tabs in the order the panels were made (a stable row), the active one lit
  const ids = [...D.panels.keys()].filter((id) => D.panels.get(id).open);
  tabs.innerHTML = ids
    .map((id) => {
      const p = D.panels.get(id);
      const on = id === D.active;
      return (
        '<button type="button" class="md-tab' +
        (on ? ' on' : '') +
        '" role="tab" data-md="tab" data-panel="' +
        esc(id) +
        '" aria-selected="' +
        on +
        '"' +
        tipAttrs({ key: p.key, noFocus: true }) +
        '>' +
        esc(t(p.key)) +
        '</button>'
      );
    })
    .join('');
  for (const [id, p] of D.panels) p.el.hidden = !(p.open && id === D.active);
  const seg = (k, key) =>
    '<button type="button" class="map-seg' +
    (place === k ? ' on' : '') +
    '" data-md="place" data-dock="' +
    k +
    '" aria-pressed="' +
    (place === k) +
    '"' +
    tipAttrs({ key, noFocus: true }) +
    '>' +
    esc(t(key)) +
    '</button>';
  el.querySelector('.md-place').innerHTML =
    '<span class="map-segs" role="group" aria-label="' +
    esc(t('map.dock')) +
    '">' +
    seg('inline', 'journey.dock.inline') +
    seg('bottom', 'journey.dock.bottom') +
    seg('right', 'journey.dock.right') +
    '</span>';
  if (D.onChange) D.onChange({ open, place, active: D.active });
}

function onClick(e) {
  const b = e.target.closest('[data-md]');
  if (!b || !D.el.contains(b)) return;
  const act = b.dataset.md;
  if (act === 'tab') {
    D.active = b.dataset.panel;
    draw();
  } else if (act === 'close') {
    if (D.active) closePanel(D.active);
  } else if (act === 'place') setDockPlace(b.dataset.dock);
}
