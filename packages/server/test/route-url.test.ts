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
  assert.match(src, /import \{ journeyViewHash, isJourneyRoute \} from '\.\.\/lib\/route-url\.js';/);
  const writer = /function jrnWriteViewHash\(\)/;
  assert.match(src, writer);
  for (const fn of ['jrnSetLayout', 'jrnSetView']) {
    const body = src.slice(src.indexOf('export function ' + fn + '('));
    assert.ok(body.slice(0, 600).includes('jrnWriteViewHash()'), fn + ' must write the view into the hash');
  }
});
