// The map canvas's input normalisation and stops (docs/proposals/map-pass-2026-10-03.md §3 row Z): the pure
// parts of the module the viewer imports (`public/app/lib/map-canvas.js`), so this tests the shipped code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { normaliseWheel, wheelFactor, nextStop, settle, atStop, clampPan, LINE_PX, NOTCH_STEP, ZOOM_RATE } = await import(join(here, '..', 'public', 'app', 'lib', 'map-canvas.js'));

const STOPS = [{ id: 'board', s: 0.13 }, { id: 'journey', s: 0.52 }, { id: 'calls', s: 0.92 }, { id: 'enter', s: 2.2 }];

test('wheel deltas become px: lines are LINE_PX, pages the stage height; shift + wheel pans sideways', () => {
  assert.deepEqual(normaliseWheel({ deltaX: 0, deltaY: 3, deltaMode: 1 }), { dx: 0, dy: 3 * LINE_PX });
  assert.deepEqual(normaliseWheel({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 700), { dx: 0, dy: 700 });
  assert.deepEqual(normaliseWheel({ deltaX: 0, deltaY: 40, deltaMode: 0, shiftKey: true }), { dx: 40, dy: 0 });
  // shift with ⌘/Ctrl is still a zoom
  assert.deepEqual(normaliseWheel({ deltaX: 0, deltaY: 40, deltaMode: 0, shiftKey: true, ctrlKey: true }), { dx: 0, dy: 40 });
});

test('one wheel event zooms at most one notch: a mouse notch and three lines are both 1.25×; a trackpad step keeps its rate', () => {
  assert.equal(wheelFactor(-100), NOTCH_STEP);
  assert.equal(wheelFactor(-3 * LINE_PX), NOTCH_STEP);
  assert.equal(wheelFactor(100), 1 / NOTCH_STEP);
  assert.ok(Math.abs(wheelFactor(-4) - Math.exp(4 * ZOOM_RATE)) < 1e-12);
  // the travel that equals one notch
  const px = Math.log(NOTCH_STEP) / ZOOM_RATE;
  assert.ok(px > 18 && px < 19);
});

test('nextStop skips the stop the scale is at and returns null past the last', () => {
  assert.equal(nextStop(STOPS, 0.52, 1).id, 'calls');
  assert.equal(nextStop(STOPS, 0.6, -1).id, 'journey');
  // within STOP_EPS of a stop is at it
  assert.equal(nextStop(STOPS, 0.53, -1).id, 'board');
  assert.equal(nextStop(STOPS, 0.52, -1).id, 'board');
  assert.equal(nextStop(STOPS, 2.2, 1), null);
  assert.ok(atStop(STOPS[2], 0.925));
});

test('settle holds a move at the first stop it reaches, but lets the gesture leave the stop it began at', () => {
  assert.deepEqual(settle(STOPS, 0.52, 3), { s: 0.92, stop: STOPS[2] });
  assert.deepEqual(settle(STOPS, 0.95, 3), { s: 2.2, stop: STOPS[3] });
  assert.deepEqual(settle(STOPS, 0.6, 0.7), { s: 0.7, stop: null });
  assert.deepEqual(settle(STOPS, 0.9, 0.05), { s: 0.52, stop: STOPS[1] });
  // a small step that lands just under a stop is not "at" it: the next step is still held there
  assert.deepEqual(settle(STOPS, 2.17, 2.21), { s: 2.2, stop: STOPS[3] });
  // the stop it began at is left
  assert.deepEqual(settle(STOPS, 0.92, 1.1, STOPS[2]), { s: 1.1, stop: null });
});

test('a pan keeps some of the world on the stage: never more than the margin of it past an edge', () => {
  const box = { x: 0, y: 0, w: 1000, h: 500 };
  // dragged far right: the world's left edge stops at w − margin
  assert.deepEqual(clampPan(5000, 0, 1, box, 800, 600, 120), { tx: 680, ty: 0 });
  // dragged far left and up: its right edge stops at margin, its bottom at margin
  assert.deepEqual(clampPan(-5000, -5000, 1, box, 800, 600, 120), { tx: 120 - 1000, ty: 120 - 500 });
  // inside the range, nothing moves; at a small scale a box smaller than the margin keeps all of itself on
  assert.deepEqual(clampPan(10, 20, 1, box, 800, 600, 120), { tx: 10, ty: 20 });
  const tiny = clampPan(-900, 0, 0.1, box, 800, 600, 120);
  assert.equal(tiny.tx, 0, 'a 100 px wide world stays wholly on');
});
