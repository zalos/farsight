// share.js — Share menu: the live link (copies the current deep-linkable URL —
// `y` does the same) and the pinned, dated link (the same view with the sync it
// was read at, `@sync:N`, and its day, `asof=`). A server that draws another
// sync than the one a link was pinned to says so beside its sync chip (the pin
// note). Saving a view as a picture, a PDF or a spreadsheet is each surface's
// own Save control (lib/export.js); the menu points there.

import { S, expose, esc, currentLens } from './store.js';
import { t, def } from './strings.js';
import { sym } from './sym.js';
import { withParams } from './lib/route-url.js';
import { tipAttrs } from './lib/tooltip.js';
import { pinnedHash, pinMismatch, dayOf, fill } from './lib/export-model.js';

/**
 * The link this view is shared as: the URL in the bar. On the Map — where a journey is read — the address already
 * names the picture (the stop, its layout, the screen, the action, the dock), and the link adds the register it was
 * read in.
 * @group Share
 * @business Writes the link to this view so it opens on the same picture, in the same words.
 */
export function shareLink() {
  const hash = location.hash || '';
  // the Map writes its picture into the address as it moves (zoom, place, the open card); the link adds the words it was read in
  if (/^#\/map(?:[/?@]|$)/.test(hash)) return location.origin + location.pathname + withParams(hash, { lens: currentLens() });
  return location.href;
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

/** The sync this graph was drawn from, and its day — what a pinned link names. */
function servedSync() {
  const meta = (S.GRAPH && S.GRAPH.meta) || {};
  const v = S.VERSION && S.VERSION.graph;
  const n = v && v.sync != null ? v.sync : meta.sync;
  return { n: n != null && Number.isFinite(+n) ? +n : null, day: dayOf(meta.generatedAt) };
}

/**
 * The pinned, dated link to this view: the live link with the sync it was read
 * at (`@sync:N`, the grammar parseRoute reads) and the day (`asof=YYYY-MM-DD`).
 * Null when the graph carries no sync number to pin to.
 * @group Share
 * @business A link to this view that names the sync and the day it was read, so whoever opens it knows which facts they are looking at.
 */
export function pinnedLink() {
  const { n, day } = servedSync();
  if (n == null) return null;
  const live = shareLink();
  const at = live.indexOf('#');
  if (at < 0) return live.replace(/#.*$/, '') + pinnedHash('#/' + (S.route && S.route.surface || ''), n, day);
  return live.slice(0, at) + pinnedHash(live.slice(at), n, day);
}

/**
 * Copy the pinned link (the Share menu's second row).
 * @group Share
 */
export function copyPinnedLink() {
  const link = pinnedLink();
  if (!link) return;
  try { navigator.clipboard.writeText(link); } catch (err) {}
  const note = document.getElementById('share-note');
  if (note) { note.textContent = t('share.copied'); setTimeout(() => { note.textContent = ''; }, 1500); }
}

/**
 * Toggle the Share popover: the live link, the pinned and dated link, and
 * where saving a picture lives.
 * @group Share
 */
export function toggleShare(ev) {
  if (ev) ev.stopPropagation();
  const menu = document.getElementById('sharemenu');
  if (!menu) return;
  if (menu.classList.contains('open')) { menu.classList.remove('open'); return; }
  const { n, day } = servedSync();
  const pinned = n != null
    ? '<button class="share-row" onclick="copyPinnedLink()"' + tipAttrs({ key: 'share.pinnedLink', noFocus: true }) + '>' + sym('open') + ' ' + esc(t('share.pinnedLink'))
      + '<span class="share-sub">' + esc(fill(t('share.pinnedLinkSub'), { n, date: day })) + '</span></button>'
    : '<p class="set-note"' + tipAttrs({ key: 'share.pinnedNone', noFocus: true }) + '>' + esc(t('share.pinnedNone')) + '</p>';
  menu.innerHTML = '<button class="share-row" onclick="copyLiveLink()">' + sym('open') + ' ' + esc(t('share.liveLink'))
    + '<span class="share-sub">' + esc(t('share.liveLinkSub')) + '</span></button>'
    + pinned
    + '<span class="set-note" id="share-note"></span>'
    + '<div class="share-soon"><span class="hud-label">' + sym('save') + ' ' + esc(t('share.saveHere')) + '</span>'
    + '<p>' + esc(def('share.saveHere')) + '</p></div>';
  menu.classList.add('open');
}

/** The sync a link in the address is pinned to (`@sync:N` before the query), or null. */
function pinOfHash(hash) {
  const h = String(hash || '');
  const q = h.indexOf('?');
  const m = (q >= 0 ? h.slice(0, q) : h).match(/@sync:(\d+)$/);
  return m ? +m[1] : null;
}

/**
 * The pin note beside the sync chip: shown only when the address is pinned to
 * a sync and this server draws another — *pinned to sync N · this server shows
 * sync M*. The server draws its own latest sync; it cannot draw a pinned one
 * (the person who serves the graph can, by starting it as of that sync), so the
 * note says the difference rather than pretending the numbers are the old ones.
 * @group Share
 * @business Says when a shared link was taken at another sync than the one on screen, so a number that moved is not a surprise.
 */
export function drawPinNote() {
  const chip = document.getElementById('syncchipwrap');
  if (!chip || !chip.parentNode) return;
  let el = document.getElementById('pinnote');
  const diff = pinMismatch(pinOfHash(location.hash), servedSync().n);
  if (!diff) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('span');
    el.id = 'pinnote';
    el.className = 'pinnote';
    el.setAttribute('role', 'status');
    chip.parentNode.insertBefore(el, chip.nextSibling);
  }
  const words = t('pin.note').replace('{n}', String(diff.pinned)).replace('{m}', String(diff.served));
  if (el.dataset.words !== words) {
    el.dataset.words = words;
    el.dataset.pinned = String(diff.pinned);
    el.dataset.served = String(diff.served);
    el.innerHTML = sym('warning') + '<span' + tipAttrs({ key: 'pin.note', noFocus: true }) + '>' + esc(words) + '</span>';
  }
}
// the chip is redrawn by the shell whenever the chrome is (a load, a sync, a register flip): the note follows it
if (typeof window.addEventListener === 'function') window.addEventListener('hashchange', drawPinNote);
(function watchChip() {
  if (typeof document.getElementById !== 'function' || typeof MutationObserver === 'undefined') return;
  const chip = document.getElementById('syncchipwrap');
  if (!chip) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchChip, { once: true }); return; }
  new MutationObserver(drawPinNote).observe(chip, { childList: true, subtree: true, characterData: true });
  drawPinNote();
})();

/** Close the Share popover (outside click / Esc).
 * @group Share */
export function closeShare() {
  const menu = document.getElementById('sharemenu');
  if (menu) menu.classList.remove('open');
}

expose({ toggleShare, copyLiveLink, copyPinnedLink, closeShare });
