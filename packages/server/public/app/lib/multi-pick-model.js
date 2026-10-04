// lib/multi-pick-model.js — what a picker's query leaves and in which order (lib/multi-pick.js).
//
// No imports, no DOM: the viewer's picker calls these and the server's test suite holds
// them (packages/server/test/multi-pick-model.test.ts).

/** Lower case, accents dropped: what a query and a word are compared as. */
export function fold(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * How well an option answers a query: -1 not at all; else 2 when a word it lists starts
 * with the whole query, 1 when every term starts a word, 0 when every term is inside one.
 * Pure — the unit test holds it.
 */
export function matchScore(option, query) {
  const q = fold(query).trim();
  if (!q) return 0;
  const hay = [option.word, option.id, ...(option.match || [])].map(fold).filter(Boolean);
  const terms = q.split(/\s+/).filter(Boolean);
  if (!terms.every((term) => hay.some((h) => h.includes(term)))) return -1;
  if (hay.some((h) => h.startsWith(q))) return 2;
  const starts = (h, term) => h.split(/[^a-z0-9]+/).some((w) => w.startsWith(term));
  if (terms.every((term) => hay.some((h) => starts(h, term)))) return 1;
  return 0;
}

/**
 * The options a query leaves, in the order they are shown: the groups in their fixed
 * order, inside each the better matches first, then the order the host gave. Pure.
 */
export function shownOptions(options, groups, query) {
  const order = new Map((groups || []).map((g, i) => [g.key, i]));
  const rank = (o) => (order.has(o.group) ? order.get(o.group) : order.size);
  return options.map((o, i) => ({ o, i, s: matchScore(o, query) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => rank(a.o) - rank(b.o) || b.s - a.s || a.i - b.i)
    .map((x) => x.o);
}

