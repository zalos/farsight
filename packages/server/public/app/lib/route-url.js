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

// ── one address: a journey is read on the Map (lanes round 2026-10-10, proposal 1 steps 3–4) ─────────────────
// The journey page (`#/journeys/<entry>?view=&step=&node=&band=&dock=`) retired; its views live on as stops and
// layouts of the Map. One unit of place is shared by every Map address below the board: the **screen**, the 1-based
// ordinal of a screen's segment in the journey's summary (`summary.segments[n - 1]`). *Step* is the storyline position
// only (`journey n of m`), so the Map's grammar says `screen=`; an incoming `step=` is read as `screen=` and the
// address is rewritten.

/** A 1-based ordinal from anything a link may carry, else null. @param {unknown} v */
export function screenOrdinal(v) {
  const n = typeof v === 'number' ? v : parseInt(String(v == null ? '' : v), 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** True for an address of the retired journey page with a journey in it (`#/journeys/<entry>…`) — the front door
 * `#/journeys` (with or without its own query) is not one. @param {string} hash */
export function isOverlayAddress(hash) {
  return /^#\/journeys\/[^?@]/.test(String(hash || ''));
}

/** What each retired view of the journey page became on the Map: a layout at the stop it described. */
const VIEW_LAYOUT = { storyboard: 'screens', timeline: 'table', sheet: 'table', drill: 'beats' };
/** The overlay's own parameters, which the converter reads and never carries over. */
const OVERLAY_ONLY = new Set(['view', 'step', 'node', 'band', 'dock', 'biz', 'screen', 'part', 'layout']);

/**
 * The Map address an old journey link names — one way, pure. `#/journeys/<entry>[@sync:N]?view=&step=&node=&band=&dock=`
 * becomes `#/map/<entry>[@sync:N]?screen=&part=&layout=&dock=`:
 * - `step=n` → `screen=n` (the same ordinal);
 * - `node=<id>` → `part=<id>`: the part that was selected, which the Map opens where the layout says (the table with
 *   that part's code in the dock, else the action stop holding it);
 * - `view=` → `layout=`: storyboard → `screens`, timeline and sheet → `table`, drill → `beats` (`band=ladder` on the
 *   drill, or on any link naming a part → `ladder`); a link that named no view names no layout, so the register's own
 *   choice applies;
 * - `dock=` survives only beside a part (the code opens there); `biz=` is dropped;
 * - every other parameter (`lens`, `scope`, `impact`, `hops`, …) is carried as it was, in its order.
 * A hash that is not an old journey address is handed back unchanged.
 *
 * @param {string} hash
 * @returns {string}
 */
export function overlayToMap(hash) {
  const h = String(hash || '');
  if (!isOverlayAddress(h)) return h;
  const qi = h.indexOf('?');
  const path = (qi >= 0 ? h.slice(0, qi) : h).slice('#/journeys/'.length);
  const q = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : '');
  const view = q.get('view') || '';
  const part = q.get('node') || null;
  let layout = VIEW_LAYOUT[view] || null;
  if (q.get('band') === 'ladder' && (view === 'drill' || (part && layout !== 'table'))) layout = 'ladder';
  const dock = part && /^(inline|bottom|right)$/.test(q.get('dock') || '') ? q.get('dock') : null;
  const screen = screenOrdinal(q.get('step') || q.get('screen'));
  let out = '#/map/' + path;
  const kept = [];
  if (qi >= 0) {
    for (const pair of h.slice(qi + 1).split('&')) {
      const k = pair.split('=')[0];
      if (k && !OVERLAY_ONLY.has(k)) kept.push(pair);
    }
  }
  if (kept.length) out += '?' + kept.join('&');
  return withParams(out, {
    screen: screen == null ? null : String(screen),
    part,
    layout,
    dock,
  });
}

/**
 * The Map's street with one screen framed: `#/map/<flowNodeId>?screen=<n>`, and —
 * with `node` — plumbing on and that node's explore card open
 * (`&plumb=1&card=<kind>:<id>`, the Map's own card grammar; `kind` is `call`
 * unless named). The flow rides in the path as every Map street link does.
 *
 * @param {string} flowId
 * @param {number} screen  1-based segment ordinal
 * @param {{node?:string|null, kind?:string|null, lens?:string|null}} [opts]
 * @returns {string}
 */
export function mapScreenHash(flowId, screen, opts = {}) {
  if (!flowId) return '';
  const n = screenOrdinal(screen);
  return withParams('#/map/' + encodeURIComponent(flowId), {
    screen: n == null ? null : String(n),
    plumb: opts.node ? '1' : null,
    card: opts.node ? (opts.kind || 'call') + ':' + opts.node : null,
    lens: opts.lens || null,
  });
}

/**
 * The Map's screen an ordinal lands on: the street's row whose segment is that
 * screen, else — a segment with no screen of its own, which the street folds into
 * the next screen — the first row after it, else the last row. A 0-based index
 * into `screens` (rows carry `segment.index`, lib/map-model.js), or null.
 * @param {Array<{segment?:{index:number}}>} screens @param {unknown} screen
 */
export function screenRowAt(screens, screen) {
  const n = screenOrdinal(screen);
  if (n == null || !screens || !screens.length) return null;
  const at = screens.findIndex((s) => s && s.segment && s.segment.index === n - 1);
  if (at >= 0) return at;
  const after = screens.findIndex((s) => s && s.segment && s.segment.index > n - 1);
  return after >= 0 ? after : screens.length - 1;
}


/**
 * The walk order of the part a link names on a screen: the marker for `nodeId` on that screen's segment (a gate met
 * there counts), else the first marker for it anywhere in the journey; null when the journey does not reach it.
 * @param {Array<{index:number, markers?:Array<{nodeId:string, stepOrder:number}>, gates?:Array<{id:string, stepOrder:number}>}>} segments
 * @param {number|null} screen  1-based, or null for anywhere
 * @param {string|null} nodeId
 */
export function partOrder(segments, screen, nodeId) {
  const segs = segments || [];
  if (!nodeId) return null;
  const n = screenOrdinal(screen);
  const sg = n != null ? segs.find((x) => x.index === n - 1) : null;
  const on = (x) => {
    if (!x) return null;
    const m = (x.markers || []).find((mm) => mm.nodeId === nodeId);
    if (m) return m.stepOrder;
    const g = (x.gates || []).find((gg) => gg.id === nodeId);
    return g ? g.stepOrder : null;
  };
  const here = on(sg);
  if (here != null) return here;
  for (const x of segs) { const o = on(x); if (o != null) return o; }
  return null;
}

// ── the Map's stops (lanes round 2026-10-10, proposal 1) ──────────────────────
// The Map is one zoom with five stops — ALL JOURNEYS · ONE JOURNEY · ONE SCREEN · ONE ACTION · CODE — and one LAYOUT
// control whose choices change per stop. Below the screen the address names the place the way the street does:
// `#/map/<flow>?screen=<n>&action=<k>[&beat=<b>][&layout=<l>][&dock=<d>]` — `screen` the 1-based screen (as above),
// `action` the 1-based action within that screen, `beat` the 1-based beat within the action, `layout` the layout at
// that stop (`table` at the journey, `ladder` at the action; the default is never written), `dock` where the code
// opens (`inline` · `bottom` · `right`) — present only at the CODE stop, because the code IS the dock opening.
// `part=<nodeId>` names one part of the walk: on the table it is the selected part (its code in the table's dock, so
// `dock` rides with it), at any other layout the Map opens the action that holds it and rewrites the address to
// `action` and `beat`.

const LAYOUTS = new Set(['chain', 'lanes', 'screens', 'table', 'beats', 'ladder']);
const ACTION_LAYOUTS = new Set(['beats', 'ladder']);
const DOCKS = new Set(['inline', 'bottom', 'right']);

/**
 * The address of one stop below the board. `o.screen` (1-based step) with no `o.action` is the street with that
 * screen framed (as `mapScreenHash`); with `o.action` it is the action stop; with `o.dock` too, the code stop.
 * `o.layout` is written as given; `o.part` names a part of the walk (with `o.dock` beside it on the table); `o.lens`
 * rides along.
 *
 * @param {string} flowId
 * @param {{screen?:number|null, action?:number|null, beat?:number|null, layout?:string|null, dock?:string|null, part?:string|null, lens?:string|null}} [o]
 * @returns {string}
 */
export function mapStopHash(flowId, o = {}) {
  if (!flowId) return '';
  const screen = screenOrdinal(o.screen);
  const action = screen != null ? screenOrdinal(o.action) : null;
  const beat = action != null ? screenOrdinal(o.beat) : null;
  const part = action == null && o.part ? String(o.part) : null;
  return withParams('#/map/' + encodeURIComponent(flowId), {
    screen: screen == null ? null : String(screen),
    action: action == null ? null : String(action),
    beat: beat == null ? null : String(beat),
    part,
    layout: o.layout && LAYOUTS.has(o.layout) ? o.layout : null,
    dock: (action != null || part) && o.dock && DOCKS.has(o.dock) ? o.dock : null,
    lens: o.lens || null,
  });
}

/**
 * Which stop a Map address names, read from its query (`route.raw` or a whole hash): `{ stop, screen, action, beat,
 * layout, dock, part }` — `stop` is `code` (an action and a dock), `action` (an action, or a part at an action's
 * layout), `screen` (`node=` names a screen), `journey` (a flow in the path) or `board`. An old `step=` reads as
 * `screen=`. Anything a link cannot mean is dropped, never guessed.
 *
 * @param {string} hashOrQuery
 */
export function mapStopOf(hashOrQuery) {
  const h = String(hashOrQuery || '');
  const qi = h.indexOf('?');
  const path = qi >= 0 ? h.slice(0, qi) : h;
  const q = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : (h.startsWith('#') ? '' : h));
  const screen = screenOrdinal(q.get('screen') || q.get('step'));
  const action = screen != null ? screenOrdinal(q.get('action')) : null;
  const beat = action != null ? screenOrdinal(q.get('beat')) : null;
  const layout = LAYOUTS.has(q.get('layout') || '') ? q.get('layout') : null;
  const part = action == null && q.get('part') ? q.get('part') : null;
  const dock = (action != null || part) && DOCKS.has(q.get('dock') || '') ? q.get('dock') : null;
  const flow = /^#\/map\/[^?@]/.test(path);
  const atAction = action != null || (part && ACTION_LAYOUTS.has(layout || ''));
  const stop = atAction ? (dock ? 'code' : 'action') : q.get('node') ? 'screen' : flow || screen != null ? 'journey' : 'board';
  return { stop, screen, action, beat, layout, dock, part };
}
