// The release readiness brief (round 2026-10-10, proposal 6): `#/readiness/<storyline>` draws one row per
// step and per branch of the storyline, in the light theme whatever the reader's, prints without the dark
// ground, saves a light PDF on one A4 page, and is reached from the front door's storyline card.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, gotoReady } from './support';

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(here, '..', '..', 'examples', 'invoice-app', 'docs', 'design', 'screens.json'), 'utf8'));
const STORY = (MANIFEST.storylines || [])[0];
const entries = STORY.journeys as (string | { id: string; branchOf: string })[];
const STEPS = entries.filter((x) => typeof x === 'string').length;
const BRANCHES = entries.length - STEPS;

/**
 * @covers packages/server/public/app/surfaces/readiness.js::mountReadiness
 * @covers packages/core/src/readiness.ts::readiness
 */
test('the brief has one row per step and branch, in the light theme, and gives the theme back on leaving', async ({ page }) => {
  await gotoReady(page, '#/portfolio');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.evaluate((id) => { location.hash = '#/readiness/' + id; }, STORY.id);
  const rows = page.locator('.rd-steps tbody tr');
  await expect(rows).toHaveCount(STEPS + BRANCHES);
  await expect(page.locator('.rd-steps tbody tr.rd-branch')).toHaveCount(BRANCHES);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  // every row says ship or hold, and a hold says why
  for (const d of await page.locator('.rd-steps tbody tr').evaluateAll((els) => els.map((e) => ({ d: e.getAttribute('data-decision'), why: e.querySelector('.rd-why')?.textContent || '' })))) {
    expect(['ship', 'hold']).toContain(d.d);
    if (d.d === 'hold') expect(d.why.length).toBeGreaterThan(0);
  }
  await expect(page.locator('.rd-rules tbody tr').first()).toBeVisible();
  await expect(page.locator('.rd-prov')).toContainText('sync');
  await page.evaluate(() => { location.hash = '#/portfolio'; });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

/** @covers packages/server/public/app/surfaces/readiness.js::mountReadiness */
test('it prints without the dark ground or the chrome', async ({ page }) => {
  await gotoReady(page, '#/readiness/' + STORY.id);
  await expect(page.locator('.rd-steps tbody tr')).toHaveCount(STEPS + BRANCHES);
  await page.emulateMedia({ media: 'print' });
  const look = await page.evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor,
    sheet: getComputedStyle(document.querySelector('.rd-sheet')!).backgroundColor,
    frame: getComputedStyle(document.querySelector('.frame')!).display,
    tools: getComputedStyle(document.querySelector('.rd-tools')!).display,
  }));
  expect(look.body).toBe('rgb(255, 255, 255)');
  expect(look.sheet).toBe('rgb(255, 255, 255)');
  expect(look.frame).toBe('none');
  expect(look.tools).toBe('none');
  await page.emulateMedia({ media: 'screen' });
});

/**
 * @covers packages/server/public/app/lib/export.js::saveView
 * @covers packages/server/public/app/lib/export-model.js::pdfA4
 */
test('Save writes a light PDF on one A4 page, and a CSV with one line per row', async ({ page }) => {
  await gotoReady(page, '#/readiness/' + STORY.id);
  await expect(page.locator('.rd-steps tbody tr')).toHaveCount(STEPS + BRANCHES);
  const pdf = await page.evaluate(() => (window as any).farsightSave('readiness', 'pdf', { dataUrl: true }));
  const bytes = Buffer.from(pdf.dataUrl.split(',')[1], 'base64').toString('latin1');
  expect(bytes.startsWith('%PDF-1.4')).toBe(true);
  expect(bytes).toContain('/MediaBox [0 0 595.28 841.89]');
  expect(bytes).toContain('/Count 1');
  expect(pdf.file).toMatch(/^farsight-readiness-.*\.pdf$/);
  const csv = await page.evaluate(() => (window as any).farsightSave('readiness', 'csv', { dataUrl: true }));
  expect(csv.rows).toBe(STEPS + BRANCHES);
});

/** @covers packages/server/public/app/lib/readiness-door.js::readinessDoorHtml */
test('the front door\'s storyline card opens the brief', async ({ page }) => {
  await gotoReady(page, '#/journeys');
  const door = page.locator(`.jrn-story[data-storyline="${STORY.id}"] .rd-door`);
  await expect(door).toBeVisible();
  await door.click();
  await expect(page).toHaveURL(new RegExp('#/readiness/' + STORY.id));
  await expect(page.locator('.rd-steps tbody tr')).toHaveCount(STEPS + BRANCHES);
});

test.describe('an unknown storyline', () => {
  test.use({ expectedHttpErrors: [/\/api\/readiness\?storyline=nope/] });
  /** @covers packages/server/public/app/surfaces/readiness.js::mountReadiness */
  test('an unknown storyline is said so, with the ones there are', async ({ page }) => {
    await gotoReady(page, '#/readiness/nope');
    await expect(page.locator('.rd-unknown')).toContainText('nope');
    await expect(page.locator('.rd-known a')).toHaveCount((MANIFEST.storylines || []).length);
  });
});
