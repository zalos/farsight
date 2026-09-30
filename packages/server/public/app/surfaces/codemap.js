// surfaces/codemap.js — the Code map surface. Interim content: today's graph
// view (lanes + inspector), honestly labeled as such; the real repo-altitude
// view (group cards, keyboard-first, supply toggle with per-edge confidence)
// ships in pass P4. Route: #/codemap?repo=x&view=map|supply — repo/view are
// parsed and carried in the store even where not yet consumed (P4 consumes).

import { S, esc, cssId } from '../store.js';
import { t } from '../strings.js';
import { render, select, cardOf } from '../lib/graph-render.js';

/**
 * Mount the Code map: view=map (default) shows the interim graph with an
 * honest interim note; view=supply shows the honest P4 placeholder.
 * @group Code map
 */
export function mountCodemap(route, el) {
  // a fast-travel pick bound here is spent by this mount, whichever view it draws
  const pending = S.pendingFocus;
  S.pendingFocus = null;
  if (route.view === 'supply') {
    document.body.classList.remove('surface-graph');
    el.innerHTML = '<div class="set-wrap"><h1>' + esc(t('nav.codemap')) + '</h1>'
      + '<div class="set-sec ph-sec"><h2>' + esc(t('ph.supply.title')) + '</h2>'
      + '<p class="ph-body">' + esc(t('ph.supply.body')) + '</p></div></div>';
    return;
  }
  // interim: the existing graph frame is the surface (stage + inspector)
  document.body.classList.add('surface-graph');
  const note = document.getElementById('codemap-note');
  if (note) { note.textContent = t('ph.codemap.note'); note.style.display = ''; }
  render();
  // #/codemap?node=<id> — land on one card (the APIs surface and journeys link here)
  if (route.node && S.BYID[route.node]) {
    // ⌘K fast travel from another surface arrives here: the card it named,
    // selected and in view, with no focus filter the reader did not choose
    // (window.arriveAt — shell.js imports this module, so not the other way round)
    if (pending === route.node) window.arriveAt(route.node);
    else select(route.node);
    // a gate has no card of its own: the one it sits on is the one in view
    const el = document.getElementById('nd-' + cssId(cardOf(route.node)));
    if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
  }
}

/**
 * Redraw the map after the scope or the register moved.
 *
 * The map is drawn from the graph the page already holds, so both reasons are
 * one redraw — `render()` re-reads the scope through `inScope()` and the lens
 * through the body class, and the selection is restored because `render()`
 * rebuilds every card. The supply placeholder has no map to redraw and is
 * re-mounted for its words.
 * @group Code map
 */
export function codemapRefresh(reason, route) {
  if (route && route.view === 'supply') {
    const el = document.getElementById('surface');
    if (el) mountCodemap(route, el);
    return;
  }
  render();
  if (S.selected) select(S.selected);
}

/** Leaving the Code map: hide the graph frame + interim note.
 * @group Code map */
export function unmountCodemap() {
  document.body.classList.remove('surface-graph');
  const note = document.getElementById('codemap-note');
  if (note) note.style.display = 'none';
}
