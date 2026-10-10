// A read-only session, on every surface (round 2026-10-10, finding 3.1).
//
// `farsight serve --read-only` (and every `--as-of`) refuses settings, syncs and tracker writes (server
// `guard.ts refuseWrite`), and `/api/version` says so in `session`. The swarm still found live-looking write
// controls under the READ-ONLY chip — Work's *Sync now*, the item pane, Settings' *Sync & re-ingest* — because
// each surface had to remember to grey its own. Here it is one rule: every control that would change something
// the server owns carries `data-write`; in a read-only session each one, whenever it is drawn, looks disabled,
// says why and who to ask in its tip, and a press does nothing. Disabled, never hidden: a reader sees what the
// product can do and why it will not do it here.
import { S } from '../store.js';
import { t } from '../strings.js';
import { setTip, pinTip } from './tooltip.js';

/**
 * Why this session is read-only — `'flag'` (`serve --read-only`), `'as-of'` (a past sync) — or null when the
 * server takes changes. Read off `/api/version`'s `session`, the same fact the server enforces; an older server
 * that does not say is taken as writable, as it always was.
 */
export function readOnlyWhy() {
  const s = S.VERSION && S.VERSION.session;
  return s && s.readOnly ? (s.why === 'as-of' ? 'as-of' : 'flag') : null;
}

/** One write control greyed (or restored): buttons keep focus and their tip (`aria-disabled`), fields are disabled. */
function greyOne(el, ro) {
  if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'option') {
    el.classList.toggle('ro-off', ro);
    if (ro) { el.setAttribute('aria-disabled', 'true'); setTip(el, { text: t('sys.readonly.control') }); }
    else if (el.classList.contains('ro-off') || el.getAttribute('aria-disabled') === 'true') el.removeAttribute('aria-disabled');
  } else if ('disabled' in el) {
    el.disabled = ro;
  }
}

/** Grey every `[data-write]` control under `root` (the whole page by default) — or restore them when writable. */
export function applyReadOnly(root = document) {
  const ro = !!readOnlyWhy();
  const els = root.querySelectorAll ? root.querySelectorAll('[data-write]') : [];
  els.forEach((el) => greyOne(el, ro));
  if (root.matches && root.matches('[data-write]')) greyOne(root, ro);
  const banner = document.getElementById('set-ro');
  if (banner) { banner.hidden = !ro; banner.textContent = ro ? t('sys.readonly.banner') : ''; }
  if (ro) installReadOnly();
}

let installed = false;
/**
 * Once the session is known to be read-only: a control drawn later (a surface re-renders, the item pane opens,
 * a picker opens) is greyed as it arrives, and a press on any greyed write control is spent before its handler
 * runs — a handler that forgot to ask cannot send the write.
 */
export function installReadOnly() {
  if (installed || typeof MutationObserver === 'undefined') return;
  installed = true;
  new MutationObserver((records) => {
    if (!readOnlyWhy()) return;
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches('[data-write]') || n.querySelector('[data-write]')) applyReadOnly(n);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
  const spend = (e) => {
    if (!readOnlyWhy()) return;
    const el = e.target && e.target.closest && e.target.closest('[data-write]');
    if (!el) return;
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    // the press is answered: the tip says why nothing happened and who to ask
    if (e.type === 'click' || e.type === 'keydown') pinTip(el);
  };
  window.addEventListener('click', spend, true);
  window.addEventListener('keydown', spend, true);
  window.addEventListener('change', spend, true);
}
