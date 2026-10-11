// Nothing on the Map clips (cleanup pass 2026-10-11): `foldPlan()` decides which chips of a wrapping row fold into
// one `+n`, never the kept one (the test verdict), and `midPath()` keeps a long path's two ends. The module is the one
// the viewer imports, so this tests the shipped code; `foldRow()` (the DOM half) is covered by the e2e overflow spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { foldPlan, midPath } = await import(join(here, '..', 'public', 'app', 'lib', 'fold-model.js'));

const chip = (w: number, keep = false, rows = 1) => ({ w, keep, rows });

test('a row that fits folds nothing', () => {
  assert.deepEqual(foldPlan([chip(60), chip(60), chip(60)], { rowW: 200, gap: 5, maxRows: 1 }), { hide: [], rows: 1 });
});

test('the last chips fold first, and the +n is counted where it stands', () => {
  // 3 × 60 + gaps on a 150 row: two rows; one row asks for the last folded behind a 20 px +n
  const p = foldPlan([chip(60), chip(60), chip(60)], { rowW: 150, gap: 5, maxRows: 1, moreW: () => 20 });
  assert.deepEqual(p.hide, [2]);
  assert.equal(p.rows, 1);
});

test('the kept chip is never folded — the others go before it, whatever their order', () => {
  const p = foldPlan([chip(80), chip(80), chip(200, true, 2), chip(70)], { rowW: 200, gap: 4, maxRows: 3, moreW: () => 24 });
  assert.ok(!p.hide.includes(2), 'the verdict stays');
  assert.deepEqual(p.hide, [1, 3]);
  assert.equal(p.rows, 3);
});

test('a kept chip taller than the room keeps its place; everything else folds', () => {
  const p = foldPlan([chip(50), chip(190, true, 4), chip(40)], { rowW: 190, gap: 4, maxRows: 2, moreW: () => 24 });
  assert.deepEqual(p.hide, [0, 2]);
  assert.ok(p.rows > 2, 'the plan reports the rows it could not save');
});

test('midPath keeps the first segment and the last two, and leaves a short path whole', () => {
  assert.equal(midPath('apps/web/src/lib/api/ops-invoices.ts:18', 30), 'apps/…/api/ops-invoices.ts:18');
  assert.equal(midPath('src/a.ts:3', 30), 'src/a.ts:3');
  // too long even with two: one kept segment
  assert.equal(midPath('apps/x/y/z/a-very-long-folder-name/and-a-long-file-name.tsx:9', 30), 'apps/…/and-a-long-file-name.tsx:9');
});
