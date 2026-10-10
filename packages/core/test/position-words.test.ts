// One word per position (swarm 2026-10-05, finding 3, six roles): *step* meant the
// storyline's place (`step 2 of 6`), the drawer's walk index (`STEP 232`), the code
// register's walk count (`983 steps`) and, in the URL, a screen. Now:
//
//  - *step* is a journey's place in a storyline, and nothing else;
//  - a *stop* is one time the journey does something — a Sheet column, the drill's
//    rail, the storyboard's `stops 1–9`, the drawer's `stop n of t`;
//  - a *visit* is the walk's own unit (`983 visits`), never a position;
//  - a *beat* is one hop inside a stop, in request order (the drill).
//
// The Sheet's columns = the stops = actions + run again + declared only + nothing to
// call is pinned in counts.test.ts, on its three-screen fold.
//
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS } from '../dist/index.js';

/** Keys allowed to say *step*: the storyline's place, and the design manifest's own `steps[]` field. */
const STEP_KEYS: Record<string, string> = {
  'journeys.storyline.stepOf': 'the storyline position',
  'map.storyline.step': 'the storyline position',
  'affected.storyline.step': 'the storyline position, in the affected set',
  'readiness.col.step': 'the storyline position, the brief\'s first column',
  'tests.orphan.whySteps': 'quotes the design manifest field `steps[]` a @covers claim names',
  'tests.blind.claim': 'names a step id of the design manifest field `steps[]`',
};

test('the catalog says step only for a journey\'s place in a storyline (and the manifest\'s own field)', () => {
  const hits: string[] = [];
  for (const [key, e] of Object.entries(STRINGS)) {
    for (const field of ['hud', 'professional', 'define'] as const) {
      const v = e[field];
      if (v && /\bsteps?\b/i.test(v) && !(key in STEP_KEYS)) hits.push(`${key}.${field}: ${v.slice(0, 80)}`);
    }
  }
  assert.deepEqual(hits, [], 'step is the storyline\'s word — a walk position is a stop, a walk count is visits');
  for (const key of Object.keys(STEP_KEYS)) assert.ok(STRINGS[key], `${key} is still in the catalog`);
});

test('each position has its own word, in both registers', () => {
  const pro = (k: string) => STRINGS[k]!.professional;
  const hud = (k: string) => STRINGS[k]!.hud;
  for (const reg of [pro, hud]) {
    assert.match(reg('journeys.storyline.stepOf'), /^step \{n\} of \{m\}$/);
    assert.match(reg('journeys.storyline.bizStepOf'), /^journey \{n\} of \{m\}$/, 'the business register says journey n of m');
    // a stop: a Sheet column, the drill's rail, the storyboard, the drawer
    assert.match(reg('journey.sheetCorner'), /\bstop\b/);
    assert.match(reg('journey.biz.sheetCorner'), /\bstop\b/);
    assert.match(reg('journey.drill.actionOf'), /^stop \{n\} of \{t\} on this journey$/);
    assert.match(reg('journey.insp.stopOf'), /^stop \{n\} of \{t\}$/);
    assert.match(reg('journey.scene.actions'), /^stops /);
    assert.match(reg('journey.ledger.actionOf'), /^stop \{n\} of \{t\} on this screen/);
    assert.match(reg('journey.cutPoint.row'), /· stop \{a\} of /);
    // the walk's unit is a count, never a position
    assert.equal(reg('journey.countSteps'), '{n} visits');
    assert.equal(reg('journey.countStepsOne'), '1 visit');
    assert.equal(reg('journey.unit.step'), 'visit');
    // a beat is one hop inside a stop
    assert.equal(reg('journey.unit.beat'), 'beat');
    // a screen's place in its journey is a screen, as the Map's footer says
    assert.equal(reg('map.screen.ordinal'), 'screen');
  }
  // the header's count keeps its own word: what a person can do, once each
  assert.equal(pro('journey.countActions'), '{n} actions');
  assert.notEqual(STRINGS['journey.countActions']!.professional, STRINGS['count.unit.actionStops']!.professional);
  // a count that can be one has its singular
  for (const k of ['journey.cutPoints', 'map.prop.changes.partsMore', 'journey.countSteps', 'count.unit.actionStops']) {
    assert.ok(STRINGS[k + 'One'], `${k} has a singular`);
  }
});
