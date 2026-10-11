// lib/fold-row.js — nothing on the Map clips its text (cleanup pass 2026-10-11).
//
// A row of chips with no room folds its last ones into one `+n` whose tip lists them, by measurement — the card's
// box follows the zoom and the lens, so no count of chips is right everywhere. One chip is never folded: the one a
// row marks `keep` (the test verdict — *passed, by its own declaration · stale* — is the one chip that must always be
// whole; the others fold first). A path too long for its line keeps its two ends, breaks at `/`, and carries itself
// whole in its tip.
//
// `foldPlan()` and `midPath()` are pure (lib/fold-model.js, unit-tested in packages/server/test/fold-row.test.ts);
// `foldRow()` measures the row, applies the plan and checks it against the page.

import { esc } from '../store.js';
import { t } from '../strings.js';
import { plainTip } from './counted.js';
import { tipAttrs } from './tooltip.js';
import { foldPlan, midPath } from './fold-model.js';

export { foldPlan, midPath };

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
function moreChipHtml(n, hidden, o) {
  const rows = hidden.map((h) => [h.textContent.replace(/\s+/g, ' ').trim(), 1]).filter((r) => r[0]);
  return '<span class="fold-more ' + esc(o.moreCls || '') + '" data-fold-more="1"'
    + plainTip(n, o.of || 'fold.moreOf', o.scope || 'fold.scopeCard', '/api/journey', rows).replace(' tabindex="0"', '') + '>'
    + esc(t(o.moreKey || 'fold.more').replace('{n}', String(n))) + '</span>';
}

/**
 * Fold one wrapping row of chips to at most `opts.maxRows` rows (a number, or a function of the row's line height
 * for a row whose room is what its card has left). `opts.keep` is a selector for the chips that never fold,
 * `opts.moreCls` the `+n` chip's extra class; `opts.moreKey`, `opts.of` and `opts.scope` the catalog keys of its word,
 * of what it counts and of the scope it counts over (a card's chips, by default); `opts.fits(row)` the page's own check
 * after the plan (the row ends inside its card). Measured in layout px (offset sizes), so a counter-scaled or zoomed
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
  row.insertAdjacentHTML('beforeend', moreChipHtml(vis.length, [], opts));
  const probe = row.lastElementChild;
  const moreW = probe.offsetWidth;
  probe.remove();
  const items = vis.map((k) => ({ w: k.offsetWidth, rows: Math.max(1, Math.round(k.offsetHeight / lineH)), keep: !!(opts.keep && k.matches(opts.keep)) }));
  const plan = foldPlan(items, { rowW, gap, maxRows, moreW: () => moreW });
  if (!plan.hide.length && (!opts.fits || opts.fits(row))) return;
  const hidden = plan.hide.map((i) => vis[i]);
  const apply = () => {
    row.querySelectorAll(':scope > [data-fold-more]').forEach((x) => x.remove());
    hidden.forEach((h) => { h.hidden = true; h.dataset.folded = '1'; });
    if (hidden.length) hidden[0].insertAdjacentHTML('beforebegin', moreChipHtml(hidden.length, hidden, opts));
  };
  apply();
  // the plan is a measurement of widths; the page has the last word — a row that still does not fit (an item that
  // wrapped inside itself taller than its estimate) folds one more, never a kept one
  if (opts.fits) {
    const rest = items.map((it, i) => i).filter((i) => !items[i].keep && !plan.hide.includes(i)).reverse();
    for (const i of rest) {
      if (opts.fits(row)) break;
      hidden.push(vis[i]);
      hidden.sort((a, b) => vis.indexOf(a) - vis.indexOf(b));
      apply();
    }
    // …and the other way: an estimate that folded more than the page needed gives back, the row's first item first
    while (hidden.length && opts.fits(row)) {
      const back = hidden[0];
      hidden.shift();
      back.hidden = false;
      delete back.dataset.folded;
      apply();
      if (!opts.fits(row)) { hidden.unshift(back); apply(); break; }
    }
  }
}
