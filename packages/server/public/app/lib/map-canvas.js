// lib/map-canvas.js — the Map surface's board: pan, zoom, pinch, levels and snap.
//
// No data knowledge (docs/proposals/map-view.md §4): it moves one world element
// under a CSS `translate(tx,ty) scale(s)` inside one stage element, and tells
// its owner three things — the transform moved, the level crossed a threshold,
// and a gesture ended near something the owner said could be snapped to.
//
// - Pan: one pointer dragged, or a plain wheel / two-finger scroll.
// - Zoom: two pointers pinched, ⌘/Ctrl + wheel (a trackpad pinch arrives so),
//   Safari's gesture events, or the owner's buttons and keys (`zoomBy`).
// - Levels by scale: below 0.5 the neighbourhood, from 0.5 the street.
// - Snap: only when a gesture **ends** (pointer up, or 160 ms after the last
//   wheel event), above scale 1.6, with a target within 320 world units of the
//   viewport's centre. Nothing snaps mid-gesture.
// - Programmatic moves animate (450 ms, the `.anim` class; CSS turns it off
//   under prefers-reduced-motion); gestures never do.

/** Below this scale the board is the neighbourhood. */
export const LEVEL_NB = 0.5;
/** At or above this scale a gesture that ends near a screen opens it. */
export const LEVEL_SNAP = 1.6;
/** How close (world units) a snap target's centre must be to the viewport's centre. */
export const SNAP_RADIUS = 320;
export const MIN_SCALE = 0.08;
export const MAX_SCALE = 2.6;
const WHEEL_END_MS = 160;
const ANIM_MS = 450;
const DRAG_PX = 3;

/** The level a scale reads as: `'nb'` (neighbourhood) or `'st'` (street). */
export function levelOf(s) { return s < LEVEL_NB ? 'nb' : 'st'; }

/**
 * Make a board. `opts`:
 * - `onChange({tx, ty, s, level})` after every move;
 * - `onLevel(level, prev)` when the scale crosses 0.5;
 * - `snapTargets()` → elements inside the world a gesture may snap to;
 * - `onSnap(el)` when a gesture ends near one above 1.6;
 * - `onGestureEnd()` after every gesture, snapped or not.
 * @group Map
 */
export function createCanvas(stage, world, opts = {}) {
  const st = { tx: 0, ty: 0, s: 0.4, level: 'nb' };
  const ptrs = new Map();
  let pinch = null;
  let dragged = false;
  let downAt = null;
  let wheelT = null;
  let animT = null;
  let suppressClick = false;

  function apply(anim) {
    if (anim) {
      world.classList.add('anim');
      clearTimeout(animT);
      animT = setTimeout(() => world.classList.remove('anim'), ANIM_MS + 30);
    } else world.classList.remove('anim');
    world.style.transform = 'translate(' + st.tx + 'px,' + st.ty + 'px) scale(' + st.s + ')';
    const lvl = levelOf(st.s);
    const prev = st.level;
    st.level = lvl;
    if (opts.onChange) opts.onChange({ ...st });
    if (lvl !== prev && opts.onLevel) opts.onLevel(lvl, prev);
  }
  const clampS = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  const rect = () => stage.getBoundingClientRect();

  /** Zoom by `factor` keeping the stage point (px, py) fixed. */
  function zoomAt(px, py, factor, anim) {
    const ns = clampS(st.s * factor);
    const wx = (px - st.tx) / st.s, wy = (py - st.ty) / st.s;
    st.s = ns; st.tx = px - wx * ns; st.ty = py - wy * ns;
    apply(anim);
  }
  /** Zoom about the stage's centre (the buttons and the keys). */
  function zoomBy(factor, anim = true) {
    const r = rect();
    zoomAt(r.width / 2, r.height / 2, factor, anim);
    gestureEnd(anim ? ANIM_MS + 40 : 0);
  }
  /** Centre the world point (x, y) at scale s. */
  function centerOn(x, y, s, anim) {
    const r = rect();
    st.s = clampS(s);
    st.tx = r.width / 2 - x * st.s; st.ty = r.height / 2 - y * st.s;
    apply(anim);
  }
  /** Fit the world box into the stage, leaving `pad` px (and `top` more under the owner's chrome), never above `max`. */
  function fit(box, { pad = 40, top = 0, max = MAX_SCALE, anim = true } = {}) {
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
  /** An element's centre in world units. */
  function worldCenter(el) {
    const r = rect(), b = el.getBoundingClientRect();
    return { x: (b.left + b.width / 2 - r.left - st.tx) / st.s, y: (b.top + b.height / 2 - r.top - st.ty) / st.s };
  }
  /** The snap target nearest the viewport's centre, with its distance in world units. */
  function nearest() {
    const els = opts.snapTargets ? opts.snapTargets() : [];
    const c = viewCenter();
    let best = null, bd = Infinity;
    for (const el of els) {
      const p = worldCenter(el);
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d < bd) { bd = d; best = el; }
    }
    return { el: best, d: bd };
  }
  function maybeSnap() {
    if (st.s < LEVEL_SNAP || !opts.onSnap) return false;
    const n = nearest();
    if (n.el && n.d < SNAP_RADIUS) { opts.onSnap(n.el); return true; }
    return false;
  }
  let endT = null;
  function gestureEnd(delay = 10) {
    clearTimeout(endT);
    endT = setTimeout(() => { maybeSnap(); if (opts.onGestureEnd) opts.onGestureEnd(); }, delay);
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
      if (pinch.d > 0) zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / pinch.d, false);
      pinch.d = d;
    }
  }
  function onUp(e) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (ptrs.size === 0) {
      stage.classList.remove('drag');
      if (dragged) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); gestureEnd(10); }
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
    const r = rect();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * unit * 0.012), false);
    else { st.tx -= e.deltaX * unit; st.ty -= e.deltaY * unit; apply(false); }
    clearTimeout(wheelT);
    wheelT = setTimeout(() => gestureEnd(0), WHEEL_END_MS);
  }
  // ── Safari's trackpad pinch ─────────────────────────────────────
  let gScale = 1;
  function onGestureStart(e) { e.preventDefault(); gScale = 1; }
  function onGestureChange(e) {
    e.preventDefault();
    const r = rect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, e.scale / gScale, false);
    gScale = e.scale;
  }
  function onGestureEnd(e) { e.preventDefault(); gestureEnd(10); }

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
    state: () => ({ ...st }),
    level: () => st.level,
    set(tx, ty, s, anim) { st.tx = tx; st.ty = ty; st.s = clampS(s); apply(anim); },
    /** Shift the world by (dx, dy) screen px without animating — a relayout keeping something in place. */
    shift(dx, dy) { st.tx += dx; st.ty += dy; apply(false); },
    zoomAt, zoomBy, centerOn, fit, viewCenter, worldCenter, nearest,
    destroy,
  };
}
