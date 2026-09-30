// lib/route-url.js — the hash grammar, as pure string functions.
//
// No imports, no DOM: the viewer calls these with `location.hash` and the
// server's test suite calls them with a literal, so the rule the address bar
// obeys is the rule a test can hold. Everything here is the read side of
// shell.js's `parseRoute()` grammar:
//
//   #/<surface>[/<param>][@sync:N][?k=v&…]
//
// The `@sync:N` pin sits **before** the query, so a naive `hash + '?view=x'`
// would produce `#/journeys/x?lens=b@sync:57?view=x`. Splitting on the first
// `?` is the only safe way to touch a parameter, and it is done once, here.

/**
 * Set (or, with a null value, remove) query parameters on a viewer hash.
 *
 * Returns the new hash, or the hash unchanged when it is not a viewer route —
 * a caller must never invent a route for a URL this grammar does not own.
 * Parameters keep their existing order; a new one is appended.
 *
 * @param {string} hash  e.g. `#/journeys/example-app::flow::x@sync:57?lens=business`
 * @param {Record<string,string|null|undefined>} params
 * @returns {string}
 */
export function withParams(hash, params) {
  const h = String(hash || '');
  if (!h.startsWith('#/')) return h;
  const qi = h.indexOf('?');
  const base = qi >= 0 ? h.slice(0, qi) : h;
  const pairs = [];
  if (qi >= 0) {
    for (const part of h.slice(qi + 1).split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      pairs.push(eq >= 0 ? [part.slice(0, eq), part.slice(eq + 1)] : [part, '']);
    }
  }
  for (const [k, v] of Object.entries(params)) {
    const at = pairs.findIndex((p) => p[0] === k);
    if (v == null) { if (at >= 0) pairs.splice(at, 1); continue; }
    const enc = encodeURIComponent(String(v));
    if (at >= 0) pairs[at][1] = enc; else pairs.push([k, enc]);
  }
  const qs = pairs.map(([k, v]) => (v === '' ? k : k + '=' + v)).join('&');
  return base + (qs ? '?' + qs : '');
}

/** True for a hash that names one open journey (`#/journeys/<entry>`), which is
 * the only route whose view and band are part of the address.
 * @param {string} hash */
export function isJourneyRoute(hash) {
  return /^#\/journeys\/./.test(String(hash || ''));
}

/**
 * The address a journey should be showing, given the controls the reader has on.
 *
 * The `y` share link has always reconstructed the full state; the address bar
 * did not, so `v` and `l` changed the picture while the URL kept naming the
 * one the reader had left. Copying the address bar is the universal sharing
 * gesture — it must name what is on the screen.
 *
 * @param {string} hash
 * @param {{view?:string, band?:string}} state
 * @returns {string}
 */
export function journeyViewHash(hash, state) {
  if (!isJourneyRoute(hash)) return String(hash || '');
  const p = {};
  if (state && state.view) p.view = state.view;
  if (state && state.band) p.band = state.band;
  return withParams(hash, p);
}
