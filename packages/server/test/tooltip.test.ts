// The tip primitive's pure parts: where a tip goes, and what its builders say.
//
// Every number is to carry a tip that says what it counts, the scope it counts
// over and where it came from (AGENTS.md invariants). The builders that write
// those tips are pure — they return HTML strings from the catalog and the lens —
// so this suite holds the shipped module (`public/app/lib/tooltip.js`) in both
// lenses and both registers, and the placement math at the widths reviewers use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', 'public', 'app');

// the viewer modules expect a browser: `expose()` writes to window, and the
// lens is read from the body's class — the smallest stand-ins that hold both
const g = globalThis as any;
g.window = g;
g.document = { body: { className: 'lens-hybrid surface-portfolio' } };

const { STRINGS } = await import(join(here, '..', '..', 'core', 'dist', 'strings.js'));
const { S } = await import(join(appDir, 'store.js'));
const tip = await import(join(appDir, 'lib', 'tooltip.js'));
const { placeTip, numberTip, tableTip, linksTip, defTip, simpleTipHtml, tipAttrs, tipSource, sourceText, TIP_HOVER_MS } = tip;

S.STRINGS = STRINGS;
S.GRAPH = { meta: { sync: 64 }, nodes: [], edges: [] };

function lens(l: string) { g.document.body.className = 'lens-' + l + ' surface-portfolio'; }
function register(r: string) { S.register = r; }

test('the hover delay is one constant, and a deliberate one', () => {
  // the brief's default is 2 s; tune it in one place — this only holds that a
  // tip never flashes open under a passing pointer, nor takes forever
  assert.ok(TIP_HOVER_MS >= 500 && TIP_HOVER_MS <= 5000, String(TIP_HOVER_MS));
});

test('below the trigger when it fits, flipped above when it does not', () => {
  const vp = { width: 1440, height: 900 };
  const tipSize = { width: 300, height: 200 };
  const high = { left: 600, right: 700, top: 100, bottom: 120, width: 100, height: 20 };
  const p = placeTip(high, tipSize, vp);
  assert.equal(p.side, 'bottom');
  assert.equal(p.top, 128);
  assert.equal(p.maxHeight, null);
  // the status bar sits on the bottom edge: its tip goes up
  const low = { left: 40, right: 240, top: 874, bottom: 890, width: 200, height: 16 };
  const q = placeTip(low, tipSize, vp);
  assert.equal(q.side, 'top');
  assert.equal(q.top, 874 - 8 - 200);
});

test('kept inside the viewport, with the arrow still on the trigger', () => {
  const vp = { width: 1440, height: 900 };
  // the ⋯ button at the right edge of the top bar
  const edge = { left: 1390, right: 1426, top: 8, bottom: 32, width: 36, height: 24 };
  const p = placeTip(edge, { width: 420, height: 180 }, vp);
  assert.equal(p.left + 420, 1440 - 8, 'flush with the right margin, never past it');
  const cx = edge.left + edge.width / 2;
  assert.equal(p.arrow, Math.round(cx - p.left), 'the arrow points at the trigger centre');
  // a phone: the tip is narrower than the viewport by both margins
  const narrow = placeTip({ left: 10, right: 60, top: 400, bottom: 420, width: 50, height: 20 }, { width: 440, height: 100 }, { width: 390, height: 800 });
  assert.equal(narrow.left, 8);
  assert.ok(narrow.arrow >= 12, 'the arrow never leaves the tip body');
});

test('a tip taller than both sides takes the roomier one and scrolls', () => {
  const p = placeTip({ left: 100, right: 200, top: 300, bottom: 320, width: 100, height: 20 }, { width: 300, height: 900 }, { width: 1440, height: 900 });
  assert.equal(p.side, 'bottom');
  assert.equal(p.maxHeight, 900 - 320 - 8 - 8);
});

test('numberTip says what it counts, over what, and from where — and links the book', () => {
  lens('hybrid'); register('professional');
  const html = numberTip({ count: 11, of: 'journey.countScreens', scope: 'journey.scopeAll', source: tipSource('/api/journey') });
  assert.match(html, /11 screens/);
  assert.ok(html.includes(STRINGS['journey.countScreens'].define.slice(0, 40).replace(/’/g, '’')), 'the define is what it counts');
  assert.ok(html.includes(STRINGS['journey.scopeAll'].professional), 'the scope, in words');
  assert.match(html, /\/api\/journey · sync 64/);
  assert.match(html, /href="#\/grammar\?key=journey\.countScreens"/);
  // the singular sibling is used for one
  assert.match(numberTip({ count: 1, of: 'journey.countScreens', scope: 'x' }), /1 screen</);
});

test('the business lens names the sync and never the endpoint', () => {
  lens('business');
  const src = tipSource('/api/journey');
  assert.equal(sourceText(src), 'sync 64');
  const html = numberTip({ count: 3, of: 'journey.countScreens', scope: 'journey.scopeAll', source: src });
  assert.ok(!html.includes('/api/journey'));
  lens('hybrid');
  assert.equal(sourceText(src), '/api/journey · sync 64');
});

test('a breakdown is a table; its code column and code rows leave the business lens', () => {
  const input = {
    columns: ['tip.screens.col.screen', { label: 'tip.syncChip.commit', code: true }],
    rows: [['Program landing', 'abc1234'], { cells: ['graph file', '/tmp/graph.json'], code: true }],
  };
  lens('hybrid');
  const hy = tableTip(input);
  assert.match(hy, /<table class="tip-tbl">/);
  assert.match(hy, /abc1234/);
  assert.match(hy, /\/tmp\/graph\.json/);
  lens('business');
  const biz = tableTip(input);
  assert.match(biz, /Program landing/);
  assert.ok(!biz.includes('abc1234'), 'a code column is dropped whole');
  assert.ok(!biz.includes('/tmp/graph.json'), 'a code row is dropped');
  assert.ok(!biz.includes(STRINGS['tip.syncChip.commit'].professional), 'and so is its heading');
  lens('hybrid');
});

test('headings and labels speak the register on screen when the tip opens', () => {
  lens('hybrid');
  register('hud');
  const hud = tableTip({ columns: ['nav.portfolio'], rows: [['x']] });
  assert.ok(hud.includes(STRINGS['nav.portfolio'].hud));
  register('professional');
  const pro = tableTip({ columns: ['nav.portfolio'], rows: [['x']] });
  assert.ok(pro.includes(STRINGS['nav.portfolio'].professional));
  assert.notEqual(hud, pro);
});

test('links: internal routes and VS Code links pass, anything else is dropped', () => {
  lens('hybrid');
  const html = linksTip([
    { label: 'nav.changes', href: '#/changes' },
    { label: 'open', href: 'vscode://file/x.ts:3', code: true },
    { label: 'bad', href: 'javascript:alert(1)' },
  ]);
  assert.match(html, /href="#\/changes"/);
  assert.match(html, /vscode:\/\/file\/x\.ts:3/);
  assert.ok(!html.includes('javascript:'));
  lens('business');
  assert.ok(!linksTip([{ label: 'open', href: 'vscode://file/x.ts:3', code: true }]).includes('vscode'), 'a code link is not in the business lens');
  lens('hybrid');
});

test('a simple tip is the entry\'s words and its define; a placeholder word is left out', () => {
  const html = simpleTipHtml('chrome.sync');
  assert.ok(html.includes('SYNC'));
  assert.ok(html.includes(STRINGS['chrome.sync'].define.slice(0, 30)));
  const counted = simpleTipHtml('journey.countScreens');
  assert.ok(!counted.includes('{n}'), 'no raw placeholder in a tip');
  assert.ok(defTip('chrome.sync').includes('#/grammar?key=chrome.sync'));
});

test('tipAttrs writes escaped, focusable trigger attributes', () => {
  assert.equal(tipAttrs({ key: 'chrome.sync' }), ' data-tip="chrome.sync" tabindex="0"');
  const a = tipAttrs({ number: { count: 2, of: 'journey.countScreens', scope: 'a "quoted" scope' } });
  assert.match(a, /data-tip-id="number"/);
  assert.ok(!/scope": "a "/.test(a), 'quotes inside the JSON are escaped');
  assert.match(a, /&quot;/);
  assert.equal(tipAttrs({ id: 'syncChip', noFocus: true }), ' data-tip-id="syncChip"');
});

test('every tip.* word is in the catalog in both registers', () => {
  const keys = Object.keys(STRINGS).filter((k) => k.startsWith('tip.'));
  assert.ok(keys.length >= 20);
  for (const k of keys) {
    assert.ok(STRINGS[k].hud && STRINGS[k].professional, k);
  }
  for (const k of ['tip.counts', 'tip.scope', 'tip.source', 'tip.grammar', 'tip.marker']) assert.ok(STRINGS[k].define, k + ' is defined');
});

test('a heading built at runtime never prints an unfilled placeholder — every catalog key, as a definition tip', () => {
  // the owner tip printed `owner · {owner}` (swarm round 2, finding 3.7): defTip heads with the catalog word,
  // which carries placeholders the trigger fills — or, when it passes none, the heading drops them
  const raw: string[] = [];
  for (const key of Object.keys(STRINGS)) {
    const head = /<div class="tip-h">([^<]*)<\/div>/.exec(defTip(key))?.[1] ?? '';
    if (/\{\w+\}/.test(head)) raw.push(`${key}: ${head}`);
  }
  assert.deepEqual(raw, []);
  assert.match(defTip('map.cover.owner', { owner: 'Billing team' }), /owner · Billing team/);
  assert.match(defTip('map.cover.owner'), /<div class="tip-h">owner<\/div>/);
});
