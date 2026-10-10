// keymap.js — every keyboard binding in one place (b · j/k · l · v · d · [ ] · f · t · ⌘K · y · ?;
// on the Map also h/l · arrows · p · + − 0 · g the legend · v the stop's layout · ← → an action's beats, asked of
// surfaces/map.js mapKey first).
// `?` has one job everywhere — this keymap (swarm 2026-10-05: it had four)
// plus the published keymap panel. Keys are the fast path, never the only
// path: each action here also has a visible button somewhere in the chrome.

import { S, expose, esc } from './store.js';
import { t } from './strings.js';
import { openPalette, closePalette, paletteNav, clearFocus, focusOn, closeSettings, settingsOpen, closeModelHub, modelHubOpen, closeMore, moreOpen, closeScopeMenu } from './shell.js';
import { journeyOpen, forksOpen, closeForks, cutsOpen, closeCuts, closeJourney, jrnNav, jrnToggleView, jrnCycleLayout, jrnCycleDock, expandedOpen, closeExpanded, jrnActionStep } from './surfaces/journeys.js';
import { jrnOpenTests, jrnOpenImpact } from './surfaces/journey-drill.js';
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
  { keys: 'j / k', desc: 'key.jk' },
  { keys: 'l', desc: 'key.l' },
  { keys: 'v', desc: 'key.v' },
  { keys: 'd', desc: 'key.d' },
  { keys: 't', desc: 'key.t' },
  { keys: '[ / ]', desc: 'key.brackets' },
  { keys: 'b', desc: 'key.b' },
  { keys: 'tab · enter', desc: 'key.mapTab' },
  { keys: 'j / k', desc: 'key.mapJk' },
  { keys: 'h / l', desc: 'key.mapHl' },
  { keys: '← ↑ → ↓', desc: 'key.mapArrows' },
  { keys: 'p', desc: 'key.mapPlumb' },
  { keys: 'w', desc: 'key.mapLanes' },
  { keys: '+ / − / 0', desc: 'key.mapZoom' },
  { keys: '[ / ]', desc: 'key.mapStep' },
  { keys: '← / →', desc: 'key.mapBeats' },
  { keys: 'v', desc: 'key.mapLayout' },
  { keys: 'y', desc: 'key.mapLink' },
  { keys: 'g', desc: 'key.mapLegend' },
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
 * The one keydown listener: ⌘K fast travel, the Escape cascade, palette
 * list-nav, journey j/k, l (rows ↔ ladder), v (timeline ↔ sheet) and d (the code pane's dock), t (the
 * open step's tests list inside a journey, the Tests surface outside one), and the b / f / y / ? bindings. Never fires plain letters while the user is typing in a field.
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
  const jOpen = journeyOpen();
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
    // Settings and the Model Hub open over a journey (the gear and the hub
    // button stay live beside it), so they are on top and leave first
    else if (modelHubOpen()) closeModelHub();
    else if (settingsOpen()) closeSettings();
    // the cut list sits above the forks drawer, so it leaves first — Esc unwinds
    // what is on top, never the overlay while something is still covering it
    else if (jOpen) { if (cutsOpen()) closeCuts(); else if (forksOpen()) closeForks(); else if (expandedOpen()) closeExpanded(); else escCloseJourney(); }
    // on the map Esc backs out one level: the explore card, the screen, the street
    else if (mapOpen() && mapEscape()) { /* used */ }
    else if (S.focusSet) clearFocus();
    return;
  }
  if (escArmed && e.key !== 'Shift') { escArmed = 0; escToast(false); }
  if (palOpen) { paletteNav(e); return; }
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // every detail is a door (round 2026-10-05 §3.2): Enter on a focused detail opens its first door, o the editor
  // a gate answers its key the way it answers its click: Enter or Space opens the gate card (swarm-fixes 2026-10-05)
  if (gateKeydown(e)) return;
  if (doorKeydown(e)) { e.preventDefault(); return; }
  // the map's own keys — p plumbing, + − 0 zoom, [ ] the screens of an open screen's journey
  if (mapOpen() && mapKey(e)) { e.preventDefault(); return; }
  if (jOpen && S.JOURNEY && (e.key === 'j' || e.key === 'k')) { e.preventDefault(); jrnNav(e.key === 'j' ? 1 : -1); return; }
  if (jOpen && S.JOURNEY && e.key === 'l') { e.preventDefault(); jrnToggleView(); return; }
  if (jOpen && S.JOURNEY && e.key === 'v') { e.preventDefault(); jrnCycleLayout(); return; }
  if (jOpen && S.JOURNEY && e.key === 'd') { e.preventDefault(); jrnCycleDock(); return; }
  if (jOpen && S.JOURNEY && (e.key === '[' || e.key === ']')) { e.preventDefault(); jrnActionStep(e.key === ']' ? 1 : -1); return; }
  // t asks one question — what proves this runs? Inside a journey that is the
  // open step's tests list (pass B4 binds it there); everywhere else it is the
  // Tests surface. One key, two contexts, never two keys for one question.
  if (jOpen && S.JOURNEY && e.key === 't') { e.preventDefault(); jrnOpenTests(); return; }
  if (e.key === 't' && !jOpen) { e.preventDefault(); location.hash = '#/tests'; return; }
  if (e.key === '?') { e.preventDefault(); toggleKeymapPanel(); return; }
  // on the map the link is brought up to date with the picture first (§K)
  if (e.key === 'y') { if (mapOpen()) mapCopyLink(); else copyLiveLink(); return; }
  // b asks one question — what else uses this? Inside a journey that is the open
  // step's impact answer, everywhere else the drawer on the selected card. One
  // key, two contexts: the proposal's key `i` is declined (§10.1), because two
  // names for one question is the fault an earlier review told us to stop.
  if (jOpen && S.JOURNEY && e.key === 'b') { e.preventDefault(); jrnOpenImpact(); return; }
  // on the map, the thing whose explore card is open is the one asked about
  if (e.key === 'b') { openImpact((mapOpen() && mapSelected()) || S.selected); return; }
  if (e.key === 'f') { if (S.focusSet) clearFocus(); else if (S.selected) focusOn(S.selected); return; }
}

/** How long the first Esc on an open journey waits for the second. */
const ESC_AGAIN_MS = 2500;
let escArmed = 0, escToastT = null;
/**
 * Esc on a journey with nothing inside it open: the first press says what a
 * second would do, the second (within 2.5 s) closes the journey. One Esc used
 * to drop a reader who had only meant to dismiss something onto the Journeys
 * list, their place lost (swarm 2026-10-05, the onboarding developer).
 * @group Keymap
 */
function escCloseJourney() {
  const now = Date.now();
  if (escArmed && now - escArmed < ESC_AGAIN_MS) { escArmed = 0; escToast(false); closeJourney(); return; }
  escArmed = now;
  escToast(true);
}
/** The quiet note the first Esc shows, in the page's live region. */
function escToast(on) {
  let el = document.getElementById('esc-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'esc-toast'; el.className = 'esc-toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  clearTimeout(escToastT);
  el.textContent = on ? t('journey.escAgain') : '';
  el.classList.toggle('on', on);
  if (on) escToastT = setTimeout(() => { el.classList.remove('on'); el.textContent = ''; escArmed = 0; }, ESC_AGAIN_MS);
}

/** Attach the central listener (called once from the shell's boot).
 * @group Keymap */
export function initKeymap() {
  document.addEventListener('keydown', onKeydown);
}

expose({ toggleKeymapPanel });
