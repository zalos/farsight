// lib/fold-model.js — the pure half of lib/fold-row.js (cleanup pass 2026-10-11, nothing on the Map clips): which
// chips of a wrapping row fold into one `+n`, never a kept one, and a long path shortened in the middle. No DOM, no
// store — unit-tested in packages/server/test/fold-row.test.ts.

/**
 * Which items of a wrapping row to fold so it takes at most `maxRows` rows. `items` are `{ w, rows?, keep? }` in the
 * row's order (`rows`: how many line heights the item stands, for one that wraps inside itself); `rowW` the row's
 * width, `gap` the gap between items, `moreW(n)` the width of the `+n` chip, which stands where the first folded item
 * stood. The last items that are not `keep` fold first. Returns `{ hide: number[], rows }` — the indices folded and the rows the row then takes.
 */
export function foldPlan(items, { rowW, gap = 0, maxRows = 2, moreW = () => 24 } = {}) {
  // the `+n` stands where the first folded item stood, so a kept chip after it keeps its own line
  const lay = (hidden) => {
    const shown = [];
    const first = hidden.size ? Math.min(...hidden) : -1;
    items.forEach((it, i) => {
      if (i === first) shown.push({ w: moreW(hidden.size), rows: 1 });
      if (!hidden.has(i)) shown.push(it);
    });
    let rows = 0,
      x = 0,
      tall = 0;
    for (const it of shown) {
      const w = Math.min(it.w, rowW);
      if (x > 0 && x + gap + w > rowW + 0.5) {
        rows += tall;
        x = 0;
        tall = 0;
      }
      x += (x > 0 ? gap : 0) + w;
      tall = Math.max(tall, it.rows || 1);
    }
    return rows + tall;
  };
  const hidden = new Set();
  const order = items
    .map((it, i) => i)
    .filter((i) => !items[i].keep)
    .reverse();
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
