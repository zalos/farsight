// Export's pure half (round 2026-10-05, lane E): the saved file's name, the
// footer under a picture, the Portfolio's CSV, the PDF a picture becomes, and the
// pinned, dated link. The module is the one the viewer imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const m = await import(join(here, '..', 'public', 'app', 'lib', 'export-model.js'));

/** A stand-in catalog: the real words, so a test reads the footer a reader would. */
const WORDS: Record<string, string> = {
  'export.footer.what': '{surface} · {title}',
  'export.footer.facts': '{source} · sync {n} · source {commit} · as of {date} · {lens}',
  'export.footer.drawn': 'drawn by Farsight {build} · saved {saved}',
  'export.footer.lens.business': 'business words',
  'export.footer.lens.hybrid': 'hybrid words',
  'export.footer.lens.code': 'code words',
  'export.surface.map': 'Map',
  'export.surface.storyboard': 'Storyboard',
  'export.surface.portfolio': 'Portfolio',
};
const t = (k: string) => WORDS[k] ?? k;

test('the file name: surface, source, subject, sync and day — a part the graph lacks is left out, never invented', () => {
  assert.equal(m.exportFilename({ surface: 'map', source: 'Example App', subject: 'invoice', sync: 57, date: '2026-10-05', ext: 'png' }),
    'farsight-map-example-app-invoice-sync57-2026-10-05.png');
  assert.equal(m.exportFilename({ surface: 'portfolio', source: '', sync: null, date: '', ext: '.csv' }), 'farsight-portfolio.csv');
  assert.equal(m.exportFilename({ surface: 'storyboard', source: 'x', sync: 3, date: 'yesterday', ext: 'pdf' }), 'farsight-storyboard-x-sync3.pdf');
  assert.equal(m.slug('Ünïcode — Café / ops'), 'unicode-cafe-ops');
});

test('the footer facts are the sync chip’s: the server’s sync first, the graph’s second; the day is the local day the sync was taken', () => {
  const meta = { workspace: 'example', sync: 5, commit: 'abcdef1234567', generatedAt: '2026-10-05T12:00:00' , farsight: { commit: 'f00' } };
  const f = m.footerFacts({ meta, version: { graph: { sync: 6 }, farsight: { commit: 'b1d' } }, lens: 'business', surface: 'map', title: 'An invoice', today: new Date(2026, 9, 7) });
  assert.deepEqual(f, { surface: 'map', title: 'An invoice', source: 'example', sync: 6, commit: 'abcdef1', date: '2026-10-05', lens: 'business', build: 'b1d', saved: '2026-10-07' });
  assert.equal(m.footerFacts({ meta: {}, surface: 'map' }).sync, null);
  assert.equal(m.dayOf('not a time'), '', 'an unreadable time is no day, never today');
});

test('the footer lines: a missing fact drops its whole part, never an empty slot or a placeholder', () => {
  const f = m.footerFacts({ meta: { workspace: 'example', sync: 5, generatedAt: '2026-10-05T12:00:00' }, surface: 'portfolio', title: 'every journey', lens: 'hybrid', today: new Date(2026, 9, 5) });
  const lines = m.footerLines(f, t);
  assert.deepEqual(lines, ['Portfolio · every journey', 'example · sync 5 · as of 2026-10-05 · hybrid words', 'saved 2026-10-05']);
  for (const l of lines) assert.doesNotMatch(l, /\{|\}| · · |^ · | · $/);
  assert.equal(m.fill('a {x} · b {y} · c', { x: 1 }), 'a 1 · c');
});

test('CSV: quoted only when it must be, the header first, the Tests matrix’s line ending', () => {
  assert.equal(m.toCsv(['flow', 'tested'], [['Sign in', 'passed, by its own declaration'], ['A "quoted" one', 'x\ny']]),
    'flow,tested\nSign in,"passed, by its own declaration"\n"A ""quoted"" one","x\ny"\n');
  assert.equal(m.cellWords('passed\n   57 e2e  ·  221 unit\n\n52 of the tests'), 'passed · 57 e2e · 221 unit · 52 of the tests');
});

test('a PNG’s size is read from its header; anything else is not a PNG', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x0c, 0x80, 0, 0, 0x06, 0x79, 8, 6, 0, 0, 0]);
  assert.deepEqual(m.pngSize(png), { width: 3200, height: 1657 });
  assert.equal(m.pngSize(new Uint8Array(30)), null);
});

test('the picture scale: at least 2×, the long side brought to the target, never past the canvas limits', () => {
  assert.equal(m.pictureScale(800, 400), 4);
  assert.equal(m.pictureScale(1440, 3000), 2);
  assert.ok(m.pictureScale(10000, 10000) * 10000 <= 16000);
  assert.ok(m.pictureScale(4000, 30000) ** 2 * 4000 * 30000 <= 120e6 + 1);
});

test('the picture’s selectors: :root, html and body become the copy’s own wrappers, nothing else moves', () => {
  assert.equal(m.pictureSelector(':root'), '.fx-root');
  assert.equal(m.pictureSelector('html, body'), '.fx-html, .fx-body');
  assert.equal(m.pictureSelector('body.lens-business .jrn-story'), '.fx-body.lens-business .jrn-story');
  assert.equal(m.pictureSelector('[data-theme="light"] body.lens-business'), '[data-theme="light"] .fx-body.lens-business');
  assert.equal(m.pictureSelector('.body-row, .htmlish'), '.body-row, .htmlish');
});

test('the PDF: one page, the JPEG inside as it is, an xref that points at every object', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const page = m.pdfPage(1600, 900);
  assert.ok(Math.max(page.w, page.h) <= 1191);
  assert.equal(Math.round((page.w / page.h) * 100), Math.round((1600 / 900) * 100), 'the page keeps the picture’s shape');
  const bytes: Uint8Array = m.pdfFromJpeg(jpeg, 3200, 1800, { page, title: 'Map · An invoice (end to end)', created: new Date(Date.UTC(2026, 9, 5)) });
  const text = Buffer.from(bytes).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/Width 3200 \/Height 1800 .*\/Filter \/DCTDecode \/Length 9/);
  assert.match(text, /\/Title \(Map \? An invoice \\\(end to end\\\)\)/);
  assert.ok(Buffer.from(bytes).includes(Buffer.from(jpeg)), 'the JPEG’s bytes are in the file unchanged');
  // every xref offset lands on its own "n 0 obj"
  const xref = text.slice(text.lastIndexOf('\nxref\n'));
  const offs = [...xref.matchAll(/^(\d{10}) 00000 n $/gm)].map((x) => +x[1]);
  assert.equal(offs.length, 6);
  offs.forEach((o, i) => assert.ok(text.startsWith(`${i + 1} 0 obj`, o), `object ${i + 1} at ${o}`));
  const start = +text.slice(text.lastIndexOf('startxref\n') + 10).split('\n')[0];
  assert.ok(text.startsWith('xref', start));
});

test('the pinned link: @sync:N before the query and asof= in it, an earlier pin replaced, a foreign hash untouched', () => {
  assert.equal(m.pinnedHash('#/map?storyline=invoice&z=0.4', 106, '2026-10-05'), '#/map@sync:106?storyline=invoice&z=0.4&asof=2026-10-05');
  assert.equal(m.pinnedHash('#/journeys/a::flow::x@sync:57?lens=business&asof=2026-01-01', 58, '2026-10-05'), '#/journeys/a::flow::x@sync:58?lens=business&asof=2026-10-05');
  assert.equal(m.pinnedHash('#/portfolio', 3, ''), '#/portfolio@sync:3');
  assert.equal(m.pinnedHash('https://x', 3, '2026-10-05'), 'https://x');
  assert.deepEqual(m.pinMismatch(57, 106), { pinned: 57, served: 106 });
  assert.equal(m.pinMismatch(106, 106), null);
  assert.equal(m.pinMismatch(null, 106), null);
  assert.equal(m.pinMismatch(57, null), null);
});

test('the kept rows: everything down to the last drawn row, plus the margin', () => {
  const w = 4, h = 10, px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = 10; px[i + 1] = 13; px[i + 2] = 20; px[i + 3] = 255; }
  px[(5 * w + 2) * 4] = 200; // one drawn pixel on row 5
  assert.equal(m.keptRows(px, w, h, [10, 13, 20], 2), 8);
  assert.equal(m.keptRows(px, w, h, [10, 13, 20], 20), 10);
});
