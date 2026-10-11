// lib/fold-row.js — nothing on the Map clips its text (cleanup pass 2026-10-11).
//
// A row of chips with no room folds its last ones into one `+n` whose tip lists them, by measurement — the card's
// box follows the zoom and the lens, so no count of chips is right everywhere. One chip is never folded: the one a
// row marks `keep` (the test verdict — *passed, by its own declaration · stale* — is the one chip that must always be
// whole; the others fold first). A path too long for its line keeps its two ends, breaks at `/`, and carries itself
// whole in its tip.
//
// `foldPlan()` and `midPath()` are pure and unit-tested (packages/server/test/fold-row.test.ts); `foldRow()` measures
// the row, applies the plan and checks it once against the page.

import { esc } from '../store.js';
import { t } from '../strings.js';
import { plainTip } from './counted.js';
import { tipAttrs } from './tooltip.js';

/**
 * Which items of a wrapping row to fold so it takes at most `maxRows` rows. `items` are `{ w, rows?, keep? }` in the
 * row's order (`rows`: how many line heights the item stands, for one that wraps inside itself); `rowW` the row's
 * width, `gap` the gap between items, `moreW(n)` the width of the `+n` chip. The last items that are not `keep` fold
 * first. Returns `{ hide: number[], rows }` — the indices folded and the rows the row then takes.
 */
export function foldPlan(items, { rowW, gap = 0, maxRows = 2, moreW = () => 24 } = {}) {
  const lay = (hidden) => {
    const shown = items.map((it, i) => ({ ...it, i })).filter((it) => !hidden.has(it.i));
    if (hidden.size) shown.push({ w: moreW(hidden.size), rows: 1 });
    let rows = 0, x = 0, tall = 0;
    for (const it of shown) {
      const w = Math.min(it.w, rowW);
      if (x > 0 && x + gap + w > rowW + 0.5) { rows += tall; x = 0; tall = 0; }
      x += (x > 0 ? gap : 0) + w;
      tall = Math.max(tall, it.rows || 1);
    }
    return rows + tall;
  };
  const hidden = new Set();
  const order = items.map((it, i) => i).filter((i) => !items[i].keep).reverse();
  let rows = lay(hidden);
  for (const i of order) {
    if (rows <= maxRows) break;
    hidden.add(i);
    rows = lay(hidden);
  }
  return { hide: [...hidden].sort((a, b) => a - b), rows };
}

/**
 * A path shortened in the middle: its first segment and its last `keep` segments, `…` between, so the two ends a
 * reader looks for stay (`apps/…/lib/api/ops-invoices.ts:18`). A path that is short enough comes back whole.
 */
export function midPath(path, max = 40, keep = 2) {
  const p = String(path || '');
  if (p.length <= max) return p;
  const parts = p.split('/');
  if (parts.length <= keep + 1) return p;
  for (let k = keep; k >= 1; k--) {
    const out = parts[0] + '/…/' + parts.slice(-k).join('/');
    if (out.length <= max || k === 1) return out;
  }
  return p;
}

/**
 * A path as HTML: shortened in the middle when long, a break opportunity after every `/`, the whole path in its tip.
 * `cls` is the span's class.
 */
export function pathHtml(path, opts = {}) {
  const p = String(path || '');
  const short = midPath(p, opts.max || 40, opts.keep || 2);
  const body = esc(short).split('/').join('/<wbr>');
  return '<span class="fold-path' + (opts.cls ? ' ' + esc(opts.cls) : '') + '"' + (short !== p ? tipAttrs({ text: p, noFocus: true }) : '') + '>' + body + '</span>';
}

/** The `+n` chip of a folded row: its tip lists what it folds, each by its own words. */
function moreChipHtml(n, hidden, cls, scope) {
  const rows = hidden.map((h) => [h.textContent.replace(/\s+/g, ' ').trim(), 1]).filter((r) => r[0]);
  return '<span class="fold-more ' + esc(cls || '') + '" data-fold-more="1"' + plainTip(n, 'fold.moreOf', scope || 'fold.scopeCard', '/api/journey', rows).replace(' tabindex="0"', '') + '>'
    + esc(t('fold.more').replace('{n}', String(n))) + '</span>';
}

/**
 * Fold one wrapping row of chips to at most `opts.maxRows` rows (a number, or a function of the row's line height
 * for a row whose room is what its card has left). `opts.keep` is a selector for the chips that never fold,
 * `opts.moreCls` the `+n` chip's extra class, `opts.scope` the catalog key of what the row is (a card's, by default). Measured in layout px (offset sizes), so a counter-scaled or zoomed
 * card folds the same way at every zoom. Safe to call again: it unfolds first.
 */
export function foldRow(row, opts = {}) {
  if (!row) return;
  row.querySelectorAll(':scope > [data-fold-more]').forEach((x) => x.remove());
  const kids = [...row.children];
  kids.forEach((k) => { if (k.dataset.folded) { k.hidden = false; delete k.dataset.folded; } });
  const rowW = row.clientWidth;
  if (!rowW || !kids.length) return;
  const cs = getComputedStyle(row);
  const gap = parseFloat(cs.columnGap) || 0;
  const vis = kids.filter((k) => !k.hidden && k.offsetWidth > 0);
  if (!vis.length) return;
  const lineH = Math.min(...vis.map((k) => k.offsetHeight).filter((h) => h > 0)) || 16;
  const maxRows = Math.max(1, typeof opts.maxRows === 'function' ? opts.maxRows(lineH) : (opts.maxRows || 2));
  // the `+n` chip's width, measured once with the widest count it could print
  row.insertAdjacentHTML('beforeend', moreChipHtml(vis.length, [], opts.moreCls, opts.scope));
  const probe = row.lastElementChild;
  const moreW = probe.offsetWidth;
  probe.remove();
  const items = vis.map((k) => ({ w: k.offsetWidth, rows: Math.max(1, Math.round(k.offsetHeight / lineH)), keep: !!(opts.keep && k.matches(opts.keep)) }));
  const plan = foldPlan(items, { rowW, gap, maxRows, moreW: () => moreW });
  if (!plan.hide.length) return;
  const hidden = plan.hide.map((i) => vis[i]);
  hidden.forEach((h) => { h.hidden = true; h.dataset.folded = '1'; });
  row.insertAdjacentHTML('beforeend', moreChipHtml(hidden.length, hidden, opts.moreCls, opts.scope));
}
