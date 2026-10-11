// One address: a journey is read on the Map (lanes round 2026-10-10, proposal 1). The journey page's address
// (`#/journeys/<entry>?view=&step=&node=&band=&dock=`) retired; an old link is converted one way, by a pure function
// in `public/app/lib/route-url.js` that the shell calls with `location.hash` and this suite calls with a literal, so
// the test holds the shipped rule and not a restatement of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', 'public', 'app');
const { withParams, isOverlayAddress, overlayToMap, mapScreenHash, screenOrdinal, screenRowAt, partOrder } = await import(join(appDir, 'lib', 'route-url.js'));

const FLOW = '#/journeys/example-app%3A%3Aflow%3A%3Ainvoice-submission';
const MAPF = '#/map/example-app%3A%3Aflow%3A%3Ainvoice-submission';

test('an old journey link is the same place on the Map: step → screen, node → part, view → layout', () => {
  assert.equal(overlayToMap(FLOW + '?view=sheet&step=2&node=a%3A%3Ab'), MAPF + '?screen=2&part=a%3A%3Ab&layout=table');
  assert.equal(overlayToMap(FLOW + '?view=storyboard'), MAPF + '?layout=screens');
  assert.equal(overlayToMap(FLOW + '?view=timeline&step=3'), MAPF + '?screen=3&layout=table');
  assert.equal(overlayToMap(FLOW + '?view=drill&step=1'), MAPF + '?screen=1&layout=drill', 'the old drill opens the drill: its rail over the beats');
  assert.equal(overlayToMap(FLOW + '?view=drill&band=ladder'), MAPF + '?layout=ladder', 'the ladder band on the drill is the action\'s ladder');
  assert.equal(overlayToMap(FLOW + '?view=timeline&band=ladder'), MAPF + '?layout=table', 'a band alone does not move the stop');
  assert.equal(overlayToMap(FLOW), MAPF, 'a link that named no view names no layout: the register decides');
});

test('the dock rides with a part only; biz is dropped; every other parameter keeps its order', () => {
  assert.equal(overlayToMap(FLOW + '?view=sheet&step=2&node=x&dock=right'), MAPF + '?screen=2&part=x&layout=table&dock=right');
  assert.equal(overlayToMap(FLOW + '?view=sheet&dock=right&biz=gates'), MAPF + '?layout=table');
  assert.equal(overlayToMap(FLOW + '?lens=business&view=timeline&impact=example-app%3A%3Atable%3A%3Ainvoices&hops=2'),
    MAPF + '?lens=business&impact=example-app%3A%3Atable%3A%3Ainvoices&hops=2&layout=table');
});

test('the @sync pin survives the conversion — it sits before the query and must not be swallowed', () => {
  const out = overlayToMap(FLOW + '@sync:57?lens=business&view=sheet&step=2');
  assert.equal(out, MAPF + '@sync:57?lens=business&screen=2&layout=table');
  assert.equal((out.match(/\?/g) || []).length, 1);
});

test('a hash that is not an old journey link is handed back untouched — the front door stays', () => {
  for (const h of ['#/journeys', '#/journeys?storyline=invoice', '#/codemap?node=x', '#/map/x?screen=2', '', 'https://example.test/x']) {
    assert.equal(overlayToMap(h), h);
    assert.equal(isOverlayAddress(h), false);
  }
  assert.equal(isOverlayAddress(FLOW), true);
  assert.equal(isOverlayAddress(FLOW + '@sync:3'), true);
});

test('the shell rewrites an old link with one replace before it routes, so Back leaves the way the reader came', () => {
  const src = readFileSync(join(appDir, 'shell.js'), 'utf8');
  assert.match(src, /if \(isOverlayAddress\(location\.hash\)\) history\.replaceState\(null, '', overlayToMap\(location\.hash\)\);/);
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

// ── the screen: one ordinal for every Map address ──────────
const FID = 'example-app::flow::billing-cycle';

test('mapScreenHash frames a screen on the street, and a node opens its card with plumbing on', () => {
  assert.equal(mapScreenHash(FID, 2), '#/map/example-app%3A%3Aflow%3A%3Abilling-cycle?screen=2');
  assert.equal(mapScreenHash(FID, '1', { node: 'r::GET /a' }), '#/map/example-app%3A%3Aflow%3A%3Abilling-cycle?screen=1&plumb=1&card=call%3Ar%3A%3AGET%20%2Fa');
  assert.equal(mapScreenHash(FID, 1, { node: 't::invoices', kind: 'record' }), '#/map/example-app%3A%3Aflow%3A%3Abilling-cycle?screen=1&plumb=1&card=record%3At%3A%3Ainvoices');
});

test('a screen is a 1-based ordinal; anything else names none', () => {
  assert.equal(screenOrdinal('3'), 3);
  assert.equal(screenOrdinal('x'), null);
  assert.equal(screenOrdinal(-1), null);
  assert.equal(screenOrdinal(0), null);
});

test('screenRowAt finds the street row of a screen; a segment folded into the next screen lands there', () => {
  // the street folds an entry segment with no screen (index 0) into the first screen (segment 1)
  const screens = [{ segment: { index: 1 } }, { segment: { index: 2 } }, { segment: { index: 4 } }];
  assert.equal(screenRowAt(screens, 2), 0);
  assert.equal(screenRowAt(screens, 3), 1);
  assert.equal(screenRowAt(screens, 1), 0, 'the folded entry lands on the first screen');
  assert.equal(screenRowAt(screens, 4), 2, 'a segment with no row of its own lands on the next one');
  assert.equal(screenRowAt(screens, 9), 2);
  assert.equal(screenRowAt([], 1), null);
});

test('partOrder finds the part a link names on its screen first, else anywhere, gates included', () => {
  const segs = [
    { index: 0, markers: [{ nodeId: 'a', stepOrder: 2 }] },
    { index: 1, markers: [{ nodeId: 'b', stepOrder: 5 }, { nodeId: 'a', stepOrder: 7 }], gates: [{ id: 'g', stepOrder: 6 }] },
  ];
  assert.equal(partOrder(segs, 2, 'a'), 7, 'the screen named first');
  assert.equal(partOrder(segs, 1, 'a'), 2);
  assert.equal(partOrder(segs, null, 'a'), 2, 'no screen: the first one that holds it');
  assert.equal(partOrder(segs, 1, 'b'), 5, 'not on the screen named: anywhere');
  assert.equal(partOrder(segs, 2, 'g'), 6, 'a gate met there');
  assert.equal(partOrder(segs, 2, 'zz'), null);
  assert.equal(partOrder(segs, 2, null), null);
});

// ── the Map's stops (lanes round 2026-10-10, proposal 1) ──────────────────────
const stops = await import(join(appDir, 'lib', 'route-url.js'));
const F = 'invoice-app::flow::billing-cycle';

test('a stop below the screen is an address: screen, action, beat, layout and dock, the dock only at the code', () => {
  const h = stops.mapStopHash(F, { screen: 2, action: 6, beat: 4, dock: 'right' });
  assert.equal(h, '#/map/invoice-app%3A%3Aflow%3A%3Abilling-cycle?screen=2&action=6&beat=4&dock=right');
  assert.deepEqual(stops.mapStopOf(h), { stop: 'code', screen: 2, action: 6, beat: 4, layout: null, dock: 'right', part: null });
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

test('a part is an address too: the table with that part selected, or the action that holds it', () => {
  const h = stops.mapStopHash(F, { screen: 2, part: 'a::b', layout: 'table', dock: 'right' });
  assert.equal(h, '#/map/invoice-app%3A%3Aflow%3A%3Abilling-cycle?screen=2&part=a%3A%3Ab&layout=table&dock=right');
  assert.deepEqual(stops.mapStopOf(h), { stop: 'journey', screen: 2, action: null, beat: null, layout: 'table', dock: 'right', part: 'a::b' });
  assert.equal(stops.mapStopOf('#/map/x?screen=2&part=p&layout=beats').stop, 'action', 'at an action\'s layout a part names the action');
  assert.equal(stops.mapStopHash(F, { screen: 2, action: 1, part: 'p' }), '#/map/invoice-app%3A%3Aflow%3A%3Abilling-cycle?screen=2&action=1', 'an action names its own place');
});

test('an old step= reads as screen= — step is the storyline position only', () => {
  assert.equal(stops.mapStopOf('#/map/x?step=3').screen, 3);
  assert.equal(stops.mapStopOf('#/map/x?step=3&action=2').stop, 'action');
  const shell = readFileSync(join(appDir, 'shell.js'), 'utf8');
  assert.match(shell, /screen: q\.get\('screen'\) \|\| q\.get\('step'\)/, 'the route reads an old step as the screen');
  const map = readFileSync(join(appDir, 'surfaces', 'map.js'), 'utf8');
  assert.match(map, /step: null/, 'and the Map writes the address without it');
});
