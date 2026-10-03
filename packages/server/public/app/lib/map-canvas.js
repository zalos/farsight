// lib/map-canvas.js — a zoomable board: pan, zoom, pinch, stops, levels and snap.
//
// No data knowledge (docs/proposals/map-view.md §4, map-pass-2026-10-03.md §3 row Z):
// it moves one world element under a CSS `translate(tx,ty) scale(s)` inside one stage
// element, and tells its owner what happened — the transform moved, the level
// changed, a gesture settled on a stop, a target is armed, a target was entered.
// The Map surface is its first owner; the code map can adopt it the same way
// (docs/MAP-VIEWER.md § MAP, "The engine").
//
// **Input, normalised.** Every wheel delta is turned into pixels first: `deltaMode`
// 1 (lines, Firefox's mouse wheel) is LINE_PX each, 2 (pages) the stage's height.
// - Pan: one pointer dragged, or a plain wheel / two-finger scroll (shift + wheel
//   pans sideways where the system does not already turn it into deltaX).
// - Zoom: ⌘/Ctrl + wheel (a macOS trackpad pinch arrives as a ctrlKey wheel),
//   two pointers pinched, Safari's gesture events, or `zoomStep` (keys, buttons).
//   A wheel event zooms by exp(-dy × ZOOM_RATE), never more than NOTCH_STEP per
//   event: a mouse notch (|dy| ≈ 100, or 3 lines) is one 1.25× step, and a trackpad
//   (a few px per event, many events) accumulates at the rate per pixel it had
//   before — 18.6 px of trackpad travel is one notch.
//
// **Stops.** The owner names its stops — `stops(anchor)` → `[{ id, s, frame? }]` —
// and they are soft detents: a gesture zooms continuously between them, but one
// that crosses a stop settles on it and swallows the rest of that gesture in the
// same direction (a gesture ends 160 ms after its last wheel event, or when the
// pointers lift). Reversing direction inside a gesture releases it. When a gesture
// settled on a stop that has a `frame(anchor, via)`, the owner frames it once the
// gesture ends (via `'gesture'`); `zoomStep(±1)` jumps stop to stop and frames each
// (via `'step'`), or zooms by KEY_STEP when no stop lies ahead.
//
// **Snap, earned.** A snap target is *armed* when its box covers the stage's
// centre and is at least `snapCover` (60 %) of the stage's height, and the scale
// is at least `armFrom()`. The owner hears `onArm(el | null)` and shows its hint.
// A target opens (`onSnap(el)`) only when a zoom-in gesture *ends* with the same
// target armed as when it began — so the hint was on screen before — or when
// `zoomStep(+1)` is pressed while one is armed. Nothing snaps mid-gesture.
//
// Programmatic moves animate (450 ms, the `.anim` class; CSS turns it off under
// prefers-reduced-motion); gestures never do.

/** Below this scale the Map board draws journeys as covers (its own levelOf). */
export const LEVEL_NB = 0.5;
export const MIN_SCALE = 0.08;
export const MAX_SCALE = 2.6;
/** The most `--map-inv` (1 ÷ scale) grows to — counter-scaled text stops growing past it. */
export const INV_MAX = 4;
/** Pixels in one wheel line (`deltaMode` 1). */
export const LINE_PX = 16;
/** ln(scale) per pixel of ⌘/Ctrl-wheel delta — a trackpad pinch's rate. */
export const ZOOM_RATE = 0.012;
/** The most one wheel event zooms: one mouse notch. */
export const NOTCH_STEP = 1.25;
/** What `zoomStep` zooms by when no stop lies ahead. */
export const KEY_STEP = 1.25;
/** How much of the stage's height an armed snap target covers. */
export const SNAP_COVER = 0.6;
/** Relative tolerance for "at a stop". */
export const STOP_EPS = 0.02;
const WHEEL_END_MS = 160;
const ANIM_MS = 450;
const DRAG_PX = 3;

/** The level a scale reads as on the Map: `'nb'` (neighbourhood) or `'st'` (street). */
export function levelOf(s) { return s < LEVEL_NB ? 'nb' : 'st'; }

/**
 * A wheel event's delta in pixels: lines and pages converted, and shift + a
 * vertical wheel read as sideways where the system did not already do so.
 * `pageH` is the stage's height (one page).
 */
export function normaliseWheel(e, pageH = 800) {
  const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? pageH : 1;
  let dx = (e.deltaX || 0) * unit, dy = (e.deltaY || 0) * unit;
  if (e.shiftKey && !dx && dy && !(e.ctrlKey || e.metaKey)) { dx = dy; dy = 0; }
  return { dx, dy };
}

/** The zoom factor of one ⌘/Ctrl-wheel event of `dy` px: exp(-dy × ZOOM_RATE), clamped to one notch either way. */
export function wheelFactor(dy) {
  const max = Math.log(NOTCH_STEP);
  const l = Math.max(-max, Math.min(max, -dy * ZOOM_RATE));
  return Math.exp(l);
}

/** Whether scale `s` is at `stop` (within STOP_EPS). */
export function atStop(stop, s) { return !!stop && Math.abs(s - stop.s) <= stop.s * STOP_EPS; }

/** The next stop past `s` going `dir` (+1 in, −1 out), skipping one `s` is already at; null when none. */
export function nextStop(stops, s, dir) {
  const list = (stops || []).filter((x) => x && x.s > 0);
  if (dir > 0) return list.filter((x) => x.s > s * (1 + STOP_EPS)).sort((a, b) => a.s - b.s)[0] || null;
  return list.filter((x) => x.s < s * (1 - STOP_EPS)).sort((a, b) => b.s - a.s)[0] || null;
}

/**
 * A move from scale `from` to `to` inside one gesture: the first stop it
 * reaches holds it there — except `skip`, the stop the gesture began at, which
 * it may leave. Returns `{ s, stop }`, `stop` null when no stop was reached.
 */
export function settle(stops, from, to, skip = null) {
  const dir = to > from ? 1 : to < from ? -1 : 0;
  if (!dir) return { s: to, stop: null };
  const keep = (x) => x && x.s > 0 && !(skip && x.id === skip.id && Math.abs(x.s - skip.s) <= skip.s * STOP_EPS);
  const hit = (stops || []).filter(keep)
    .filter((x) => (dir > 0 ? x.s > from && x.s <= to : x.s < from && x.s >= to))
    .sort((a, b) => (dir > 0 ? a.s - b.s : b.s - a.s))[0];
  return hit ? { s: hit.s, stop: hit } : { s: to, stop: null };
}

/**
 * Attach a board to `stage`, moving `world`. `opts`:
 * - `stops(anchor)` → `[{ id, s, frame?(anchor, via) }]` — the soft detents, asked
 *   with the stage point (`{x, y}`, stage px) the zoom is about;
 * - `min`, `max` — numbers or functions → numbers (the scale's bounds);
 * - `level(s)` → the level a scale reads as (default `levelOf`);
 * - `onChange({tx, ty, s, level})` after every move; `onLevel(level, prev)` when it changes;
 * - `onStop(stop, via)` after a gesture settled on a stop or a step reached one;
 * - `snapTargets()` → elements a zoom may enter; `snapCover` (0.6); `armFrom()` → the
 *   smallest scale at which one arms; `onArm(el | null)` when the armed target changes;
 *   `onSnap(el)` when one is entered;
 * - `onGestureEnd()` after every gesture or step; `holdWheel()` → true while wheel
 *   events should be swallowed (the owner finishing a gesture of its own).
 * Returns the board's handle (see the object at the bottom).
 * @group Map
 */
export function attachCanvas(stage, world, opts = {}) {
  const levelFn = opts.level || levelOf;
  const st = { tx: 0, ty: 0, s: 0.4, level: levelFn(0.4) };
  const ptrs = new Map();
  let pinch = null;
  let dragged = false;
  let downAt = null;
  let wheelT = null;
  let animT = null;
  let endT = null;
  let suppressClick = false;
  /** The gesture in progress: `{ kind, anchor, held, heldDir, armedAt, net }`. */
  let g = null;
  let armed = null;
  const val = (v, d) => (typeof v === 'function' ? v() : v != null ? v : d);
  const minS = () => val(opts.min, MIN_SCALE);
  const maxS = () => Math.max(minS(), val(opts.max, MAX_SCALE));
  const clampS = (s) => Math.min(maxS(), Math.max(minS(), s));
  const rect = () => stage.getBoundingClientRect();
  const centre = () => { const r = rect(); return { x: r.width / 2, y: r.height / 2 }; };
  const stopsAt = (anchor) => {
    const list = opts.stops ? opts.stops(anchor || centre()) || [] : [];
    return list.filter((x) => x && x.s > 0).map((x) => ({ ...x, s: clampS(x.s) })).sort((a, b) => a.s - b.s);
  };

  function apply(anim) {
    if (anim) {
      world.classList.add('anim');
      clearTimeout(animT);
      animT = setTimeout(() => world.classList.remove('anim'), ANIM_MS + 30);
    } else world.classList.remove('anim');
    world.style.transform = 'translate(' + st.tx + 'px,' + st.ty + 'px) scale(' + st.s + ')';
    // what an owner's counter-scaled content multiplies by to keep a steady size on screen (capped)
    world.style.setProperty('--map-inv', String(Math.min(1 / st.s, INV_MAX)));
    const lvl = levelFn(st.s);
    const prev = st.level;
    st.level = lvl;
    if (opts.onChange) opts.onChange({ ...st });
    if (lvl !== prev && opts.onLevel) opts.onLevel(lvl, prev);
    // from the transform the world is going to, not the one mid-flight, so a quick key after an animated
    // move never acts on what was armed before it
    rearm();
  }

  // ── snap: armed when one target covers the centre and is large ───────
  function armedNow() {
    if (!opts.snapTargets || st.s < val(opts.armFrom, 0)) return null;
    const r = rect();
    if (!r.height) return null;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const cover = opts.snapCover != null ? opts.snapCover : SNAP_COVER;
    // the box the world will have once an animation lands, not the one mid-flight
    const k = st.s;
    for (const el of opts.snapTargets() || []) {
      const b = boxOf(el);
      if (!b) continue;
      const left = r.left + st.tx + b.x * k, top = r.top + st.ty + b.y * k, w = b.w * k, h = b.h * k;
      if (left <= cx && left + w >= cx && top <= cy && top + h >= cy && h >= cover * r.height) return el;
    }
    return null;
  }
  /** An element's box in world units, from its offsets up to the world (transforms on the way ignored). */
  function boxOf(el) {
    let x = 0, y = 0, n = el;
    while (n && n !== world) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    if (n !== world) return null;
    return { x, y, w: el.offsetWidth, h: el.offsetHeight };
  }
  function rearm() {
    const a = armedNow();
    if (a !== armed) { armed = a; if (opts.onArm) opts.onArm(a); }
  }

  /** Put the stage point (px, py) at scale ns without moving the world point under it. */
  function zoomTo(px, py, ns, anim) {
    ns = clampS(ns);
    const wx = (px - st.tx) / st.s, wy = (py - st.ty) / st.s;
    st.s = ns; st.tx = px - wx * ns; st.ty = py - wy * ns;
    apply(anim);
  }
  /** Zoom by `factor` keeping the stage point (px, py) fixed — no stops, no gesture. */
  function zoomAt(px, py, factor, anim) { zoomTo(px, py, st.s * factor, anim); }

  // ── gestures: one zoom gesture at a time, held by the first stop it crosses ──
  function begin(kind, anchor) {
    if (!g) g = { kind, anchor, held: null, heldDir: 0, armedAt: armed, net: 0, from: stopsAt(anchor).find((x) => atStop(x, st.s)) || null };
    g.anchor = anchor;
    return g;
  }
  /** One zoom move inside the current gesture, about the stage point (px, py). */
  function gestureZoom(kind, px, py, factor) {
    const gs = begin(kind, { x: px, y: py });
    const dir = factor > 1 ? 1 : factor < 1 ? -1 : 0;
    if (!dir) return;
    gs.net += Math.log(factor);
    if (gs.held) {
      if (dir === gs.heldDir) return;
      gs.from = gs.held; gs.held = null; gs.heldDir = 0;
    }
    const want = clampS(st.s * factor);
    // the stop the gesture began at (or was last held at, before it reversed) may be left
    const r = settle(stopsAt(gs.anchor), st.s, want, gs.from);
    gs.from = null;
    if (r.stop) { gs.held = r.stop; gs.heldDir = dir; }
    zoomTo(px, py, r.s, false);
  }
  function endGesture(delay = 10) {
    clearTimeout(endT);
    endT = setTimeout(() => {
      const gs = g;
      g = null;
      if (gs) {
        rearm();
        if (gs.net > 0 && gs.armedAt && armed === gs.armedAt && opts.onSnap) {
          opts.onSnap(armed);
        } else if (gs.held) {
          if (gs.held.frame) gs.held.frame(gs.anchor, 'gesture');
          if (opts.onStop) opts.onStop(gs.held, 'gesture');
        }
      }
      if (opts.onGestureEnd) opts.onGestureEnd();
    }, delay);
  }

  /**
   * The keys' and the buttons' zoom: `dir` +1 enters the armed target if there
   * is one, else goes to the next stop in (framing it); −1 to the next stop out.
   * Past the last stop it zooms by KEY_STEP about the centre.
   */
  function zoomStep(dir, anim = true) {
    if (dir > 0 && armed && opts.onSnap) { opts.onSnap(armed); return; }
    const c = centre();
    const n = nextStop(stopsAt(c), st.s, dir);
    if (n) {
      if (n.frame) n.frame(c, 'step'); else zoomTo(c.x, c.y, n.s, anim);
      if (opts.onStop) opts.onStop(n, 'step');
    } else zoomTo(c.x, c.y, st.s * (dir > 0 ? KEY_STEP : 1 / KEY_STEP), anim);
    clearTimeout(endT);
    endT = setTimeout(() => { if (opts.onGestureEnd) opts.onGestureEnd(); }, anim ? ANIM_MS + 40 : 0);
  }
  /** Zoom about the stage's centre by a factor, no stops (for owners that want a plain zoom). */
  function zoomBy(factor, anim = true) {
    const c = centre();
    zoomAt(c.x, c.y, factor, anim);
    clearTimeout(endT);
    endT = setTimeout(() => { if (opts.onGestureEnd) opts.onGestureEnd(); }, anim ? ANIM_MS + 40 : 0);
  }
  /** Centre the world point (x, y) at scale s. */
  function centerOn(x, y, s, anim) {
    const r = rect();
    st.s = clampS(s);
    st.tx = r.width / 2 - x * st.s; st.ty = r.height / 2 - y * st.s;
    apply(anim);
  }
  /** Fit the world box into the stage, leaving `pad` px (and `top` more at the top), never above `max`. */
  function fit(box, { pad = 40, top = 0, max = maxS(), anim = true } = {}) {
    const r = rect();
    if (!box || !box.w || !box.h || !r.width || !r.height) return;
    const s = clampS(Math.min(max, (r.width - pad * 2) / box.w, (r.height - pad * 2 - top) / box.h));
    st.s = s;
    st.tx = r.width / 2 - (box.x + box.w / 2) * s;
    st.ty = top + (r.height - top) / 2 - (box.y + box.h / 2) * s;
    apply(anim);
  }
  /** The world point at the viewport's centre, and the viewport in world units. */
  function viewCenter() {
    const r = rect();
    return { x: (r.width / 2 - st.tx) / st.s, y: (r.height / 2 - st.ty) / st.s, w: r.width / st.s, h: r.height / st.s };
  }
  /** A stage point (px) in world units. */
  function toWorld(px, py) { return { x: (px - st.tx) / st.s, y: (py - st.ty) / st.s }; }
  /** An element's centre in world units. */
  function worldCenter(el) {
    const r = rect(), b = el.getBoundingClientRect();
    return { x: (b.left + b.width / 2 - r.left - st.tx) / st.s, y: (b.top + b.height / 2 - r.top - st.ty) / st.s };
  }

  // ── pointers: one drags, two pinch ───────────────────────────────
  function onDown(e) {
    if (e.button != null && e.button !== 0 && e.pointerType === 'mouse') return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) { dragged = false; downAt = { x: e.clientX, y: e.clientY }; }
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
      dragged = true;
    }
  }
  function onMove(e) {
    if (!ptrs.has(e.pointerId)) return;
    const prev = ptrs.get(e.pointerId);
    const cur = { x: e.clientX, y: e.clientY };
    ptrs.set(e.pointerId, cur);
    if (ptrs.size === 1) {
      if (!dragged && downAt && Math.abs(cur.x - downAt.x) + Math.abs(cur.y - downAt.y) > DRAG_PX) {
        dragged = true;
        // captured only once a drag starts, so a plain click still lands on what was clicked
        try { stage.setPointerCapture(e.pointerId); } catch { /* the pointer already left */ }
        stage.classList.add('drag');
      }
      if (dragged) { st.tx += cur.x - prev.x; st.ty += cur.y - prev.y; apply(false); }
    } else if (ptrs.size === 2 && pinch) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const r = rect();
      if (pinch.d > 0) gestureZoom('pinch', (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / pinch.d);
      pinch.d = d;
    }
  }
  function onUp(e) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (ptrs.size === 0) {
      stage.classList.remove('drag');
      if (dragged) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); endGesture(10); }
      downAt = null;
    }
  }
  // a drag ends in a click on whatever was under the pointer; it is not one
  function onClickCapture(e) {
    if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; }
  }

  // ── wheel: plain scrolls pan, ⌘/Ctrl zooms ───────────────────────
  function onWheel(e) {
    // a scrollable panel inside the stage (the explore card, the property) keeps its own wheel
    if (e.target && e.target.closest && e.target.closest('[data-map-wheel="own"]')) return;
    e.preventDefault();
    // the owner may be finishing a gesture of its own (a pinch out that just left a screen)
    if (opts.holdWheel && opts.holdWheel()) return;
    const r = rect();
    const { dx, dy } = normaliseWheel(e, r.height);
    if (e.ctrlKey || e.metaKey) gestureZoom('wheel', e.clientX - r.left, e.clientY - r.top, wheelFactor(dy));
    else { st.tx -= dx; st.ty -= dy; apply(false); begin('wheel', { x: e.clientX - r.left, y: e.clientY - r.top }); }
    clearTimeout(wheelT);
    wheelT = setTimeout(() => endGesture(0), WHEEL_END_MS);
  }
  // ── Safari's trackpad pinch ─────────────────────────────────────
  let gScale = 1;
  function onGestureStart(e) { e.preventDefault(); gScale = 1; }
  function onGestureChange(e) {
    e.preventDefault();
    const r = rect();
    gestureZoom('gesture', e.clientX - r.left, e.clientY - r.top, e.scale / gScale);
    gScale = e.scale;
  }
  function onGestureEnd(e) { e.preventDefault(); endGesture(10); }

  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
  stage.addEventListener('click', onClickCapture, true);
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('gesturestart', onGestureStart);
  stage.addEventListener('gesturechange', onGestureChange);
  stage.addEventListener('gestureend', onGestureEnd);

  function destroy() {
    clearTimeout(wheelT); clearTimeout(animT); clearTimeout(endT);
    stage.removeEventListener('pointerdown', onDown);
    stage.removeEventListener('pointermove', onMove);
    stage.removeEventListener('pointerup', onUp);
    stage.removeEventListener('pointercancel', onUp);
    stage.removeEventListener('click', onClickCapture, true);
    stage.removeEventListener('wheel', onWheel);
    stage.removeEventListener('gesturestart', onGestureStart);
    stage.removeEventListener('gesturechange', onGestureChange);
    stage.removeEventListener('gestureend', onGestureEnd);
  }

  return {
    /** `{ tx, ty, s, level }`, a copy. */
    state: () => ({ ...st }),
    level: () => st.level,
    /** The target a zoom in would enter now, or null. */
    armed: () => armed,
    /** The stops about a stage point (default the centre), ascending, clamped to the bounds. */
    stops: (anchor) => stopsAt(anchor),
    /** The stop the scale is at (within STOP_EPS), or null. */
    stopAt: (anchor) => stopsAt(anchor).find((x) => atStop(x, st.s)) || null,
    /** True while a zoom or pan gesture is in progress. */
    inGesture: () => !!g,
    set(tx, ty, s, anim) { st.tx = tx; st.ty = ty; st.s = clampS(s); apply(anim); },
    /** Shift the world by (dx, dy) screen px without animating — a relayout keeping something in place. */
    shift(dx, dy) { st.tx += dx; st.ty += dy; apply(false); },
    /** Re-ask which target is armed (after the owner redrew what `snapTargets` returns). */
    rearm,
    zoomAt, zoomTo, zoomBy, zoomStep, centerOn, fit, viewCenter, toWorld, worldCenter,
    destroy,
  };
}

/** The first name of `attachCanvas`, kept for owners written against it. */
export const createCanvas = attachCanvas;
