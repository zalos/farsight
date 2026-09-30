// share.js — Share menu. Today: the live link (real, copies the current
// deep-linkable URL — `y` does the same). Pinned @sync:N links, PNG/PDF
// export with the provenance footer, and the embed card ship in pass P5 on
// P1's snapshot ids; the menu says so instead of faking them.

import { S, expose, esc, currentLens } from './store.js';
import { t } from './strings.js';
import { sym } from './sym.js';

/**
 * The link this view is shared as. Everywhere but a journey that is the URL in
 * the bar; a journey link is written the way it is read — pinned to the sync
 * it was taken from (`@sync:N`) and carrying the three independent controls
 * the reader had on (`?lens=&view=storyboard|timeline|sheet|drill&band=&dock=&biz=`), so the person who opens it sees
 * the same picture.
 * @group Share
 * @business Writes the link to this journey so it opens on the same data, in the same words and the same shape.
 */
export function shareLink() {
  const hash = location.hash || '';
  if (!/^#\/journeys\/./.test(hash)) return location.href;
  let h = hash.slice(1), query = '';
  const qi = h.indexOf('?');
  if (qi >= 0) { query = h.slice(qi + 1); h = h.slice(0, qi); }
  h = h.replace(/@sync:\d+$/, '');
  const sync = S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.sync;
  const q = new URLSearchParams(query);
  q.set('lens', currentLens());
  // the visual the reader actually had; unset only before a journey has drawn,
  // and a link never names a view nobody was looking at
  if (S.jrnLayout) q.set('view', S.jrnLayout);
  q.set('band', S.jrnView || 'rows');
  if (S.jrnDock) q.set('dock', S.jrnDock);
  if (S.jrnBiz) q.set('biz', S.jrnBiz);
  return location.origin + location.pathname + '#' + h + (sync != null ? '@sync:' + sync : '') + '?' + q.toString();
}

/**
 * Copy the link to this view. Bound to `y` and to the Share menu's one real
 * action.
 * @group Share
 */
export function copyLiveLink() {
  try { navigator.clipboard.writeText(shareLink()); } catch (err) {}
  const note = document.getElementById('share-note');
  if (note) { note.textContent = t('share.copied'); setTimeout(() => { note.textContent = ''; }, 1500); }
}

/**
 * Toggle the Share popover: live link now; pinned link + export declared
 * honestly as P1/P5 work.
 * @group Share
 */
export function toggleShare(ev) {
  if (ev) ev.stopPropagation();
  const menu = document.getElementById('sharemenu');
  if (!menu) return;
  if (menu.classList.contains('open')) { menu.classList.remove('open'); return; }
  menu.innerHTML = '<button class="share-row" onclick="copyLiveLink()">' + sym('open') + ' ' + esc(t('share.liveLink'))
    + '<span class="share-sub">' + esc(t('share.liveLinkSub')) + '</span></button>'
    + '<span class="set-note" id="share-note"></span>'
    + '<div class="share-soon"><span class="hud-label">' + esc(t('share.pinned')) + ' · ' + esc(t('share.export')) + '</span>'
    + '<p>' + esc(t('share.notYet')) + '</p></div>';
  menu.classList.add('open');
}

/** Close the Share popover (outside click / Esc).
 * @group Share */
export function closeShare() {
  const menu = document.getElementById('sharemenu');
  if (menu) menu.classList.remove('open');
}

expose({ toggleShare, copyLiveLink, closeShare });
