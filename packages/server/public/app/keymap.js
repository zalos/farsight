// keymap.js — every keyboard binding in one place, one keymap for the one surface a journey is read on (lanes round
// 2026-10-10: the journey page's own keys retired with it). ⌘K · ? · y · t · b · f everywhere; on the Map, asked of
// surfaces/map.js mapKey first: + / − move a stop (every journey · one journey · one screen · one action · the code),
// v cycles the layout at the stop, d the dock, j / k the parts at the stop, [ ] the screens or the actions, ← → an
// action's beats, h / l the journeys, p · w · g · 0 · arrows; Esc goes up one stop.
// `?` has one job everywhere — this keymap (swarm 2026-10-05: it had four)
// plus the published keymap panel. Keys are the fast path, never the only
// path: each action here also has a visible button somewhere in the chrome.

import { S, expose, esc } from './store.js';
import { t } from './strings.js';
import { openPalette, closePalette, paletteNav, clearFocus, focusOn, closeSettings, settingsOpen, closeModelHub, modelHubOpen, closeMore, moreOpen, closeScopeMenu } from './shell.js';
import { jrnOpenTests, jrnOpenImpact } from './surfaces/journey-drill.js';
import { actionOpen, tableOpen } from './surfaces/map-stops.js';
import { openImpact, closeImpact, impactOpen } from './impact.js';
import { mapOpen, mapEscape, mapKey, mapSelected, mapCopyLink } from './surfaces/map.js';
import { copyLiveLink, closeShare } from './share.js';
import { trapTab } from './lib/focus-trap.js';
import { tipKeydown } from './lib/tooltip.js';
import { doorKeydown } from './lib/detail-doors.js';
import { gateKeydown } from './lib/gate-card.js';

/** The published keymap — the panel renders from this table, nothing else. */
const KEYS = [
  { keys: '⌘K', desc: 'key.cmdk' },
  { keys: '+ / − / 0', desc: 'key.mapZoom' },
  { keys: 'v', desc: 'key.mapLayout' },
  { keys: 'd', desc: 'key.d' },
  { keys: 'j / k', desc: 'key.mapJk' },
  { keys: '[ / ]', desc: 'key.mapStep' },
  { keys: '← / →', desc: 'key.mapBeats' },
  { keys: 'h / l', desc: 'key.mapHl' },
  { keys: '← ↑ → ↓', desc: 'key.mapArrows' },
  { keys: 'tab · enter', desc: 'key.mapTab' },
  { keys: 'p', desc: 'key.mapPlumb' },
  { keys: 'w', desc: 'key.mapLanes' },
  { keys: 'g', desc: 'key.mapLegend' },
  { keys: 'a', desc: 'key.walk' },
  { keys: 't', desc: 'key.t' },
  { keys: 'b', desc: 'key.b' },
  { keys: 'enter · o', desc: 'key.doors' },
  { keys: 'f', desc: 'key.f' },
  { keys: 'y', desc: 'key.y' },
  { keys: '?', desc: 'key.help' },
  { keys: 'click · enter', desc: 'key.tip' },
  { keys: 'esc', desc: 'key.esc' },
];

/** Whether the toolbar's scope menu is open — read off the page, since the menu is the shell's.
 * @group Keymap */
function scopeMenuOpen() {
  const m = document.getElementById('scopemenu');
  return !!m && m.classList.contains('open');
}
/** @group Keymap */
export function keymapPanelOpen() {
  const p = document.getElementById('keymap');
  return !!p && p.classList.contains('open');
}
/**
 * Render + toggle the keymap panel (`?` and the chrome's ⌨ button).
 * @group Keymap
 */
export function toggleKeymapPanel(force) {
  const p = document.getElementById('keymap');
  if (!p) return;
  const open = (force === true || force === false) ? force : !p.classList.contains('open');
  if (open) {
    p.innerHTML = '<div class="km-head"><span class="hud-label">' + esc(t('keymap.title')) + '</span>'
      + '<button class="x" onclick="toggleKeymapPanel(false)" aria-label="Close">✕</button></div>'
      + '<p class="km-sub">' + esc(t('keymap.sub')) + '</p>'
      + KEYS.map((k) => '<div class="km-row"><kbd>' + esc(k.keys) + '</kbd><span>' + esc(t(k.desc)) + '</span></div>').join('')
      + '<div class="km-row km-link"><a href="#/grammar" onclick="toggleKeymapPanel(false)">' + esc(t('nav.grammar')) + '</a></div>';
  }
  p.classList.toggle('open', open);
}

/**
 * The one keydown listener: ⌘K fast travel, the Escape cascade (the top panel, then on the Map up one stop), palette
 * list-nav, the Map's keys (surfaces/map.js mapKey), t (the open part's tests at an action, the Tests surface
 * elsewhere), and the b / f / y / ? bindings. Never fires plain letters while the user is typing in a field.
 * @group Keymap
 */
function onKeydown(e) {
  // a tip is the top-most thing on screen: Esc closes it before anything else,
  // `?` on a focused trigger opens its tip rather than this keymap, and Tab
  // walks into a rich tip's links (lib/tooltip.js)
  if (tipKeydown(e)) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openPalette(); return; }
  // `inert` on what an open dialog covers already removes the page's stops; this
  // puts back into the dialog the focus a redraw dropped. The chrome stays live.
  if (e.key === 'Tab' && trapTab(e)) return;
  const palOpen = document.getElementById('palette').classList.contains('open');
  if (e.key === 'Escape') {
    if (palOpen) closePalette();
    else if (keymapPanelOpen()) toggleKeymapPanel(false);
    else if (document.getElementById('sharemenu') && document.getElementById('sharemenu').classList.contains('open')) closeShare();
    else if (moreOpen()) closeMore();
    // the scope menu drops over an open journey from the toolbar: it is on top, so
    // it leaves first — Esc used to close the journey under it and leave the menu
    // hanging open over the Journeys list (pass swarm 2026-09-25, onboarding blocker)
    else if (scopeMenuOpen()) { closeScopeMenu(); const b = document.getElementById('scopebtn'); if (b) b.focus({ preventScroll: true }); }
    else if (impactOpen()) closeImpact();
    // Settings and the Model Hub are on top of the surface, so they leave first
    else if (modelHubOpen()) closeModelHub();
    else if (settingsOpen()) closeSettings();
    // on the map Esc backs out one level: a drawer or the open part's code, the explore card, the action, the screen,
    // the journey
    else if (mapOpen() && mapEscape()) { /* used */ }
    else if (S.focusSet) clearFocus();
    return;
  }
  if (palOpen) { paletteNav(e); return; }
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // every detail is a door (round 2026-10-05 §3.2): Enter on a focused detail opens its first door, o the editor
  // a gate answers its key the way it answers its click: Enter or Space opens the gate card (swarm-fixes 2026-10-05)
  if (gateKeydown(e)) return;
  if (doorKeydown(e)) { e.preventDefault(); return; }
  // the map's own keys — the stops, the layout, the dock, the parts, the beats, plumbing, the legend
  if (mapOpen() && mapKey(e)) { e.preventDefault(); return; }
  // t asks one question — what proves this runs? At an action, or on the table
  // with a part open, that is the open part's tests list; everywhere else it is
  // the Tests surface. One key, two contexts, never two keys for one question.
  const atAction = mapOpen() && S.JOURNEY && (actionOpen() || (tableOpen() && S.journeyActive >= 0));
  if (e.key === 't') { e.preventDefault(); if (atAction) jrnOpenTests(); else location.hash = '#/tests'; return; }
  if (e.key === '?') { e.preventDefault(); toggleKeymapPanel(); return; }
  // on the map the link is brought up to date with the picture first (§K)
  if (e.key === 'y') { if (mapOpen()) mapCopyLink(); else copyLiveLink(); return; }
  // b asks one question — what else uses this? At an action (or the table's open
  // part) that is the open part's impact answer, everywhere else the drawer on the selected card. One
  // key, two contexts: the proposal's key `i` is declined (§10.1), because two
  // names for one question is the fault an earlier review told us to stop.
  if (atAction && e.key === 'b') { e.preventDefault(); jrnOpenImpact(); return; }
  // on the map, the thing whose explore card is open is the one asked about
  if (e.key === 'b') { openImpact((mapOpen() && mapSelected()) || S.selected); return; }
  if (e.key === 'f') { if (S.focusSet) clearFocus(); else if (S.selected) focusOn(S.selected); return; }
}

/** Attach the central listener (called once from the shell's boot).
 * @group Keymap */
export function initKeymap() {
  document.addEventListener('keydown', onKeydown);
}

expose({ toggleKeymapPanel });
