// The address bar must name the view the reader is looking at.
//
// `v` and `l` changed the journey's picture without touching the hash, so a
// copied URL handed a colleague a different screen with nothing to say so. The
// rule now lives in one pure module (`public/app/lib/route-url.js`) that the
// viewer and this suite both call, so the test holds the shipped code and not
// a restatement of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', 'public', 'app');
const { withParams, isJourneyRoute, journeyViewHash } = await import(join(appDir, 'lib', 'route-url.js'));

const FLOW = '#/journeys/example-app%3A%3Aflow%3A%3Ainvoice-submission';

test('a view switch is written into the hash', () => {
  assert.equal(
    journeyViewHash(FLOW + '?lens=business&view=timeline', { view: 'drill', band: 'rows' }),
    FLOW + '?lens=business&view=drill&band=rows',
  );
});

test('the band is written too, and an absent parameter is appended not invented', () => {
  assert.equal(journeyViewHash(FLOW + '?lens=code', { view: 'timeline', band: 'ladder' }),
    FLOW + '?lens=code&view=timeline&band=ladder');
});

test('the @sync pin survives — it sits before the query and must not be swallowed', () => {
  // a naive `hash + '?view=…'` produced `…@sync:57?view=…`, which parseRoute
  // reads as a sync of "57?view=drill" — i.e. no sync at all
  const pinned = FLOW + '@sync:57?lens=business&view=sheet';
  const out = journeyViewHash(pinned, { view: 'drill', band: 'rows' });
  assert.equal(out, FLOW + '@sync:57?lens=business&view=drill&band=rows');
  assert.match(out, /@sync:57\?/);
  assert.equal((out.match(/\?/g) || []).length, 1);
});

test('the other parameters keep their order and their values', () => {
  const h = FLOW + '?lens=business&view=timeline&band=rows&dock=right&biz=gates&impact=example-app%3A%3Atable%3A%3Ainvoices&hops=2';
  const out = journeyViewHash(h, { view: 'sheet', band: 'ladder' });
  assert.equal(out, FLOW + '?lens=business&view=sheet&band=ladder&dock=right&biz=gates&impact=example-app%3A%3Atable%3A%3Ainvoices&hops=2');
});

test('a hash this grammar does not own is handed back untouched', () => {
  // never invent a route: the journeys list, the code map and a bare page are
  // not journeys, and a non-hash URL is not ours at all
  for (const h of ['#/journeys', '#/codemap?node=x', '#/tests', '', 'https://example.test/x']) {
    assert.equal(journeyViewHash(h, { view: 'drill', band: 'rows' }), h);
    assert.equal(isJourneyRoute(h), false);
  }
  assert.equal(isJourneyRoute(FLOW), true);
});

test('a null value removes a parameter; an empty query leaves no dangling ?', () => {
  assert.equal(withParams(FLOW + '?view=drill&hops=2', { hops: null }), FLOW + '?view=drill');
  assert.equal(withParams(FLOW + '?view=drill', { view: null }), FLOW);
});

test('a value is encoded once, so a node id round-trips', () => {
  const id = 'example-app::table::invoices';
  const out = withParams(FLOW, { impact: id });
  assert.equal(out, FLOW + '?impact=example-app%3A%3Atable%3A%3Ainvoices');
  assert.equal(decodeURIComponent(new URLSearchParams(out.split('?')[1]).get('impact') || ''), id);
});

test('the journey view writes the hash through this module and nothing else', () => {
  // a static guard on the call site: the rule above is only true of the shipped
  // viewer while `jrnSetLayout` and `jrnSetView` keep calling the writer
  const src = readFileSync(join(appDir, 'surfaces', 'journeys.js'), 'utf8');
  assert.match(src, /import \{ journeyViewHash, isJourneyRoute[\w, ]*\} from '\.\.\/lib\/route-url\.js';/);
  const writer = /function jrnWriteViewHash\(\)/;
  assert.match(src, writer);
  for (const fn of ['jrnSetLayout', 'jrnSetView']) {
    const body = src.slice(src.indexOf('export function ' + fn + '('));
    assert.ok(body.slice(0, 600).includes('jrnWriteViewHash()'), fn + ' must write the view into the hash');
  }
});

// ── the Map and the journey open each other (round 2026-10-05 §3.1) ──────────
const { journeyStepHash, mapScreenHash, stepOrdinal, stepIndex, screenAtStep, stepOfNode } = await import(join(appDir, 'lib', 'route-url.js'));
const FID = 'example-app::flow::billing-cycle';

test('journeyStepHash opens the timeline at a step, with a node when named', () => {
  assert.equal(journeyStepHash(FID, 2), '#/journeys/example-app%3A%3Aflow%3A%3Abilling-cycle?view=timeline&step=2');
  assert.equal(journeyStepHash(FID, 3, { node: 'a::b::GET /x', lens: 'business' }),
    '#/journeys/example-app%3A%3Aflow%3A%3Abilling-cycle?view=timeline&step=3&node=a%3A%3Ab%3A%3AGET%20%2Fx&lens=business');
  // a step that is not a 1-based ordinal names no step, and then no node either
  assert.equal(journeyStepHash(FID, 0, { node: 'x' }), '#/journeys/example-app%3A%3Aflow%3A%3Abilling-cycle?view=timeline');
  assert.equal(journeyStepHash('', 1), '');
});

test('mapScreenHash frames a screen on the street, and a node opens its card with plumbing on', () => {
  assert.equal(mapScreenHash(FID, 2), '#/map/example-app%3A%3Aflow%3A%3Abilling-cycle?screen=2');
  assert.equal(mapScreenHash(FID, '1', { node: 'r::GET /a' }), '#/map/example-app%3A%3Aflow%3A%3Abilling-cycle?screen=1&plumb=1&card=call%3Ar%3A%3AGET%20%2Fa');
  assert.equal(mapScreenHash(FID, 1, { node: 't::invoices', kind: 'record' }), '#/map/example-app%3A%3Aflow%3A%3Abilling-cycle?screen=1&plumb=1&card=record%3At%3A%3Ainvoices');
});

test('the step and the screen are one ordinal, read back the same way', () => {
  assert.equal(stepOrdinal('3'), 3);
  assert.equal(stepOrdinal('x'), null);
  assert.equal(stepOrdinal(-1), null);
  assert.equal(stepIndex('2', 3), 1);
  assert.equal(stepIndex('9', 3), 2, 'clamped to the last screen');
  assert.equal(stepIndex('1', 0), null);
});

test('screenAtStep finds the street row of a step; a step folded into the next screen lands there', () => {
  // the street folds an entry segment with no screen (index 0) into the first screen (segment 1)
  const screens = [{ segment: { index: 1 } }, { segment: { index: 2 } }, { segment: { index: 4 } }];
  assert.equal(screenAtStep(screens, 2), 0);
  assert.equal(screenAtStep(screens, 3), 1);
  assert.equal(screenAtStep(screens, 1), 0, 'the folded entry lands on the first screen');
  assert.equal(screenAtStep(screens, 4), 2, 'a step with no row of its own lands on the next one');
  assert.equal(screenAtStep(screens, 9), 2);
  assert.equal(screenAtStep([], 1), null);
});

test('stepOfNode prefers the screen the reader is on, else the first step whose markers include it', () => {
  const segs = [
    { index: 0, markers: [{ nodeId: 'a' }] },
    { index: 1, markers: [{ nodeId: 'b' }, { nodeId: 'a' }] },
    { index: 2, markers: [] },
  ];
  assert.equal(stepOfNode(segs, 1, 'a'), 2);
  assert.equal(stepOfNode(segs, 2, 'a'), 1);
  assert.equal(stepOfNode(segs, 2, 'zz'), 3, 'a node no step holds: the screen the reader is on');
  assert.equal(stepOfNode(segs, null, 'zz'), null);
});

// ── the Map's stops (lanes round 2026-10-10, proposal 1) ──────────────────────
const stops = await import(join(appDir, 'lib', 'route-url.js'));
const F = 'invoice-app::flow::billing-cycle';

test('a stop below the screen is an address: screen, action, beat, layout and dock, the dock only at the code', () => {
  const h = stops.mapStopHash(F, { screen: 2, action: 6, beat: 4, dock: 'right' });
  assert.equal(h, '#/map/invoice-app%3A%3Aflow%3A%3Abilling-cycle?screen=2&action=6&beat=4&dock=right');
  assert.deepEqual(stops.mapStopOf(h), { stop: 'code', screen: 2, action: 6, beat: 4, layout: null, dock: 'right' });
  assert.equal(stops.mapStopOf(stops.mapStopHash(F, { screen: 2, action: 1 })).stop, 'action');
  assert.equal(stops.mapStopOf(stops.mapStopHash(F, { screen: 2, action: 1, layout: 'ladder' })).layout, 'ladder');
  // an action needs its screen; a dock needs its action; a beat needs its action
  assert.equal(stops.mapStopHash(F, { action: 3, dock: 'right', beat: 2 }), '#/map/invoice-app%3A%3Aflow%3A%3Abilling-cycle');
});

test('the address round-trips, and the existing grammar reads as it did', () => {
  for (const o of [{ screen: 1 }, { screen: 3, action: 2 }, { screen: 2, action: 6, beat: 5, layout: 'ladder', dock: 'bottom' }, { layout: 'table' }]) {
    const back = stops.mapStopOf(stops.mapStopHash(F, o));
    assert.equal(back.screen, o.screen ?? null);
    assert.equal(back.action, (o as any).action ?? null);
    assert.equal(back.layout, (o as any).layout ?? null);
  }
  assert.equal(stops.mapStopOf('#/map').stop, 'board');
  assert.equal(stops.mapStopOf('#/map/' + encodeURIComponent(F) + '?z=0.8&x=1&y=2').stop, 'journey');
  assert.equal(stops.mapStopOf('#/map/' + encodeURIComponent(F) + '?node=x').stop, 'screen');
  assert.equal(stops.mapStopOf(stops.mapScreenHash(F, 2)).stop, 'journey', 'a screen framed on the street is the journey stop');
  // what a link cannot mean is dropped, never guessed
  const odd = stops.mapStopOf('#/map/x?screen=0&action=2&layout=spiral&dock=left');
  assert.deepEqual([odd.screen, odd.action, odd.layout, odd.dock], [null, null, null, null]);
  assert.equal(stops.mapStopOf('?screen=2&action=1').stop, 'action', 'a bare query reads too (route.raw is the whole hash)');
});
