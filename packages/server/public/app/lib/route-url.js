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

// ── the Map and the journey open each other (round 2026-10-05 §3.1) ───────────
// Both pictures of one journey share one unit of place: the **step**, the
// 1-based ordinal of a screen's segment in the journey's summary
// (`summary.segments[n - 1]`). The journey calls it `step`, the Map's street
// calls it `screen` — the same number, so a link from either side lands on the
// same screen of the other.

/** A 1-based ordinal from anything a link may carry, else null. @param {unknown} v */
export function stepOrdinal(v) {
  const n = typeof v === 'number' ? v : parseInt(String(v == null ? '' : v), 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * The journey opened at one screen: `#/journeys/<flowNodeId>?view=timeline&step=<n>`
 * — the blueprint timeline with step n's segment selected and in view — and,
 * with `node`, that node's marker selected (`&node=<id>`). A lens rides along
 * when given, so a link copied in one register opens in it.
 *
 * @param {string} flowId  the flow's node id
 * @param {number} step    1-based segment ordinal
 * @param {{node?:string|null, lens?:string|null, view?:string|null}} [opts]
 * @returns {string}
 */
export function journeyStepHash(flowId, step, opts = {}) {
  if (!flowId) return '';
  const n = stepOrdinal(step);
  return withParams('#/journeys/' + encodeURIComponent(flowId), {
    view: opts.view || 'timeline',
    step: n == null ? null : String(n),
    node: n != null && opts.node ? opts.node : null,
    lens: opts.lens || null,
  });
}

/**
 * The Map's street with one screen framed: `#/map/<flowNodeId>?screen=<n>`, and —
 * with `node` — plumbing on and that node's explore card open
 * (`&plumb=1&card=<kind>:<id>`, the Map's own card grammar; `kind` is `call`
 * unless named). The flow rides in the path as every Map street link does.
 *
 * @param {string} flowId
 * @param {number} screen  1-based segment ordinal (the journey's `step`)
 * @param {{node?:string|null, kind?:string|null, lens?:string|null}} [opts]
 * @returns {string}
 */
export function mapScreenHash(flowId, screen, opts = {}) {
  if (!flowId) return '';
  const n = stepOrdinal(screen);
  return withParams('#/map/' + encodeURIComponent(flowId), {
    screen: n == null ? null : String(n),
    plumb: opts.node ? '1' : null,
    card: opts.node ? (opts.kind || 'call') + ':' + opts.node : null,
    lens: opts.lens || null,
  });
}

/**
 * Which segment a link's `step` (or `screen`) names, as a 0-based index into
 * `segments`, clamped to what the journey has; null when the link names none or
 * the journey has no segments.
 * @param {unknown} step @param {number} count
 */
export function stepIndex(step, count) {
  const n = stepOrdinal(step);
  if (n == null || !(count > 0)) return null;
  return Math.min(n, count) - 1;
}

/**
 * The Map's screen a step lands on: the street's row whose segment is that
 * step, else — a step with no screen of its own, which the street folds into
 * the next screen — the first row after it, else the last row. A 0-based index
 * into `screens` (rows carry `segment.index`, lib/map-model.js), or null.
 * @param {Array<{segment?:{index:number}}>} screens @param {unknown} step
 */
export function screenAtStep(screens, step) {
  const n = stepOrdinal(step);
  if (n == null || !screens || !screens.length) return null;
  const at = screens.findIndex((s) => s && s.segment && s.segment.index === n - 1);
  if (at >= 0) return at;
  const after = screens.findIndex((s) => s && s.segment && s.segment.index > n - 1);
  return after >= 0 ? after : screens.length - 1;
}

/**
 * The step (1-based) whose markers include `nodeId`: the preferred segment's
 * when it has the node, else the first segment that does, else the preferred
 * segment itself; null when there is nothing to name.
 * @param {Array<{index:number, markers?:Array<{nodeId:string}>}>} segments
 * @param {number|null} prefer  a 0-based segment index (the screen the reader is on)
 * @param {string|null} nodeId
 */
export function stepOfNode(segments, prefer, nodeId) {
  const segs = segments || [];
  const has = (sg) => !!(sg && nodeId && (sg.markers || []).some((m) => m.nodeId === nodeId));
  const p = prefer != null ? segs.find((sg) => sg.index === prefer) : null;
  if (has(p)) return p.index + 1;
  const any = segs.find(has);
  if (any) return any.index + 1;
  return p ? p.index + 1 : null;
}

// ── the Map's stops (lanes round 2026-10-10, proposal 1) ──────────────────────
// The Map is one zoom with five stops — ALL JOURNEYS · ONE JOURNEY · ONE SCREEN · ONE ACTION · CODE — and one LAYOUT
// control whose choices change per stop. Below the screen the address names the place the way the street does:
// `#/map/<flow>?screen=<n>&action=<k>[&beat=<b>][&layout=<l>][&dock=<d>]` — `screen` the journey's step (as above),
// `action` the 1-based action within that screen, `beat` the 1-based beat within the action, `layout` the layout at
// that stop (`table` at the journey, `ladder` at the action; the default is never written), `dock` where the code
// opens (`inline` · `bottom` · `right`) — present only at the CODE stop, because the code IS the dock opening.

const LAYOUTS = new Set(['chain', 'lanes', 'screens', 'table', 'beats', 'ladder']);
const DOCKS = new Set(['inline', 'bottom', 'right']);

/**
 * The address of one stop below the board. `o.screen` (1-based step) with no `o.action` is the street with that
 * screen framed (as `mapScreenHash`); with `o.action` it is the action stop; with `o.dock` too, the code stop.
 * `o.layout` is written as given; `o.lens` rides along.
 *
 * @param {string} flowId
 * @param {{screen?:number|null, action?:number|null, beat?:number|null, layout?:string|null, dock?:string|null, lens?:string|null}} [o]
 * @returns {string}
 */
export function mapStopHash(flowId, o = {}) {
  if (!flowId) return '';
  const screen = stepOrdinal(o.screen);
  const action = screen != null ? stepOrdinal(o.action) : null;
  const beat = action != null ? stepOrdinal(o.beat) : null;
  return withParams('#/map/' + encodeURIComponent(flowId), {
    screen: screen == null ? null : String(screen),
    action: action == null ? null : String(action),
    beat: beat == null ? null : String(beat),
    layout: o.layout && LAYOUTS.has(o.layout) ? o.layout : null,
    dock: action != null && o.dock && DOCKS.has(o.dock) ? o.dock : null,
    lens: o.lens || null,
  });
}

/**
 * Which stop a Map address names, read from its query (`route.raw` or a whole hash): `{ stop, screen, action, beat,
 * layout, dock }` — `stop` is `code` (an action and a dock), `action`, `screen` (`node=` names a screen), `journey`
 * (a flow in the path) or `board`. Anything a link cannot mean is dropped, never guessed.
 *
 * @param {string} hashOrQuery
 */
export function mapStopOf(hashOrQuery) {
  const h = String(hashOrQuery || '');
  const qi = h.indexOf('?');
  const path = qi >= 0 ? h.slice(0, qi) : h;
  const q = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : (h.startsWith('#') ? '' : h));
  const screen = stepOrdinal(q.get('screen'));
  const action = screen != null ? stepOrdinal(q.get('action')) : null;
  const beat = action != null ? stepOrdinal(q.get('beat')) : null;
  const layout = LAYOUTS.has(q.get('layout') || '') ? q.get('layout') : null;
  const dock = action != null && DOCKS.has(q.get('dock') || '') ? q.get('dock') : null;
  const flow = /^#\/map\/[^?@]/.test(path);
  const stop = action != null ? (dock ? 'code' : 'action') : q.get('node') ? 'screen' : flow || screen != null ? 'journey' : 'board';
  return { stop, screen, action, beat, layout, dock };
}
