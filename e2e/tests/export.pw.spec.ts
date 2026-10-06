// Export (round 2026-10-05, lane E): the Map's storyline board, the journey's
// storyboard and the Portfolio save as a PNG and a PDF drawn in the browser, with
// a footer of where and when the picture is true; the Portfolio also as a CSV; and
// the Share menu's pinned, dated link with the note a server at another sync shows.
// Every file arrives through Playwright's download event and is read back here.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Download, Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';

type AnyRec = Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(here, '..', '..', 'examples', 'invoice-app', 'docs', 'design', 'screens.json'), 'utf8'));
const STORY = (MANIFEST.storylines || [])[0] as AnyRec;
const FLOW = 'invoice-app::flow::billing-cycle';

/** The fixture sets no flags: the map is switched on in this page only. */
async function mapOn(page: Page) {
  await page.evaluate(() => {
    const S = (window as any).S;
    S.SETTINGS = Object.assign({}, S.SETTINGS, { flags: Object.assign({}, S.SETTINGS && S.SETTINGS.flags, { map: true }) });
  });
}

/** Width and height from a PNG's IHDR. */
function pngSize(b: Buffer) {
  expect(b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'a PNG signature').toBe(true);
  expect(b.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Open the surface's Save menu, pick a format, and read the file the browser was handed. */
async function save(page: Page, surface: string, fmt: 'png' | 'pdf' | 'csv'): Promise<{ d: Download; bytes: Buffer }> {
  await page.locator(`[data-export="${surface}"]`).click();
  const menu = page.getByRole('menu', { name: 'Save this view' });
  await expect(menu).toBeVisible();
  const [d] = await Promise.all([page.waitForEvent('download'), menu.locator(`[data-fx-fmt="${fmt}"]`).click()]);
  const path = await d.path();
  const bytes = readFileSync(path!);
  expect(bytes.length, 'the file is not empty').toBeGreaterThan(0);
  return { d, bytes };
}

/** The footer the control says the last file carries. */
async function footer(page: Page, surface: string) {
  const btn = page.locator(`[data-export="${surface}"]`);
  await expect(btn).toHaveAttribute('data-export-footer', /./);
  return (await btn.getAttribute('data-export-footer'))!;
}

/**
 * @covers packages/server/public/app/lib/export.js::saveView
 * @covers packages/server/public/app/surfaces/map.js::mapPicture
 * @covers packages/server/public/app/lib/export-model.js::pdfFromJpeg
 */
test('the Map saves its storyline board whole, as a picture and as a PDF, with the footer under it', async ({ page }) => {
  await gotoReady(page, '#/portfolio');
  await mapOn(page);
  await page.evaluate((id) => { location.hash = '#/map?storyline=' + id; }, STORY.id);
  await expect(page.locator('.map-band.story .w')).toHaveText([STORY.name]);
  // zoomed in on one corner: the picture is still the whole band, not the part on screen
  await page.locator('[data-act="in"]').click();
  await page.locator('[data-act="in"]').click();

  const { d, bytes } = await save(page, 'map', 'png');
  expect(d.suggestedFilename()).toMatch(new RegExp(`^farsight-map-[a-z0-9-]+-${STORY.id}(-sync\\d+)?(-\\d{4}-\\d{2}-\\d{2})?\\.png$`));
  const { width, height } = pngSize(bytes);
  const board = await page.evaluate(() => {
    const w = (document.querySelector('.map-world') as HTMLElement);
    const band = w.querySelector('.map-band.story') as HTMLElement;
    return { bandW: band.offsetWidth };
  });
  expect(width).toBeGreaterThan(1000);
  expect(height).toBeGreaterThan(200);
  expect(board.bandW).toBeGreaterThan(0);
  const f = await footer(page, 'map');
  expect(f).toContain(`Map · ${STORY.name}`);
  expect(f).toMatch(/hybrid words/);
  await expect(page.locator('[data-export="map"]')).toHaveAttribute('data-export-size', `${width}x${height}`);

  const pdf = await save(page, 'map', 'pdf');
  expect(pdf.d.suggestedFilename()).toMatch(/\.pdf$/);
  const text = pdf.bytes.toString('latin1');
  expect(text.startsWith('%PDF-1.4')).toBe(true);
  expect(text).toContain('/Subtype /Image');
  expect(text).toContain(`/Width ${width} /Height ${height}`);
  expect(text.trimEnd().endsWith('%%EOF')).toBe(true);

  // the same picture in-page, as a data URL: its size, and the footer facts it was drawn with
  const inPage = await page.evaluate(() => (window as any).farsightSave('map', 'png', { dataUrl: true }));
  expect(inPage.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  expect(inPage.dataUrl.length).toBeGreaterThan(20000);
  expect(inPage.footer).toBe(f);
});

/**
 * @covers packages/server/public/app/surfaces/journeys.js::jrnStoryPicture
 * @covers packages/server/public/app/lib/export.js::exportToolHtml
 */
test('a journey saves as its storyboard — switching to it first — with every screen in the picture', async ({ page }) => {
  await gotoReady(page, '#/journeys/' + encodeURIComponent(FLOW) + '?view=timeline&lens=business');
  const btn = page.locator('#jrn-export [data-export="storyboard"]');
  await expect(btn).toHaveText('Save');
  const { d, bytes } = await save(page, 'storyboard', 'png');
  expect(d.suggestedFilename()).toMatch(/^farsight-storyboard-.*billing-cycle.*\.png$/);
  await expect(page.locator('.jrn-layoutsw .jrn-viewbtn.on')).toHaveText(/storyboard/i);
  const { width, height } = pngSize(bytes);
  const story = await page.locator('#jrn-tl .jrn-story').boundingBox();
  // drawn at 2× or more: the picture is at least twice the storyboard's width
  expect(width).toBeGreaterThanOrEqual(Math.floor(story!.width * 2) - 2);
  expect(height).toBeGreaterThan(400);
  const f = await footer(page, 'storyboard');
  expect(f).toMatch(/^Storyboard · /);
  expect(f).toMatch(/business words/);
  const pdf = await save(page, 'storyboard', 'pdf');
  expect(pdf.bytes.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
});

/**
 * @covers packages/server/public/app/surfaces/portfolio.js::portfolioPicture
 * @covers packages/server/public/app/lib/export.js::tableRows
 * @covers packages/server/public/app/lib/export-model.js::toCsv
 */
test('the Portfolio saves as a picture, a PDF and a spreadsheet of its journey rows', async ({ page }) => {
  await gotoReady(page, '#/portfolio?lens=hybrid');
  await expect(page.locator('.pf-table').first()).toBeVisible();
  const { bytes } = await save(page, 'portfolio', 'png');
  const { width } = pngSize(bytes);
  expect(width).toBeGreaterThan(1000);
  expect(await footer(page, 'portfolio')).toMatch(/^Portfolio · /);
  const pdf = await save(page, 'portfolio', 'pdf');
  expect(pdf.bytes.toString('latin1').startsWith('%PDF-1.4')).toBe(true);

  const csv = await save(page, 'portfolio', 'csv');
  expect(csv.d.suggestedFilename()).toMatch(/^farsight-portfolio-.*\.csv$/);
  const lines = csv.bytes.toString('utf8').trim().split('\n');
  // the headings the table sits under, then its own six columns
  expect(lines[0]).toMatch(/^who,group,/);
  expect(lines[0].split(',')).toHaveLength(8);
  const rows = await page.locator('.pf-persona table.pf-table tbody tr').count();
  expect(lines.length - 1).toBe(rows);
  // the first row names a journey the table shows
  const first = (await page.locator('.pf-persona table.pf-table tbody tr td a').first().textContent())!.trim();
  expect(lines[1]).toContain(first);
});

/** @covers packages/server/public/app/lib/export.js::openExportMenu */
test('the Save menu is reached and left by the keyboard', async ({ page }) => {
  await gotoReady(page, '#/portfolio');
  const btn = page.locator('[data-export="portfolio"]');
  await btn.focus();
  await page.keyboard.press('Enter');
  const items = page.getByRole('menuitem');
  await expect(items).toHaveText(['save as picture (PNG)', 'save as PDF', 'save as spreadsheet (CSV)']);
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(btn).toBeFocused();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
});

/**
 * @covers packages/server/public/app/share.js::pinnedLink
 * @covers packages/server/public/app/share.js::drawPinNote
 */
test('the pinned link names the sync and the day, and a link pinned to another sync says so beside the chip', async ({ page }) => {
  await gotoReady(page, '#/portfolio');
  const served = await page.evaluate(() => {
    const S = (window as any).S;
    const v = S.VERSION && S.VERSION.graph;
    return v && v.sync != null ? v.sync : S.GRAPH.meta.sync ?? null;
  });
  // the fixture's ingest writes snapshot history, so its graph has a sync number to pin to
  expect(served, 'the fixture graph carries a sync number').not.toBeNull();
  await page.evaluate(() => (window as any).toggleShare());
  await expect(page.locator('#sharemenu')).toContainText('Copy pinned link');
  const link = await page.evaluate(async () => (await import('/app/share.js' as string)).pinnedLink());
  expect(link).toMatch(new RegExp(`#/portfolio@sync:${served}(\\?|$)`));
  await page.evaluate(() => (window as any).closeShare());
  await expect(page.locator('#pinnote')).toHaveCount(0);
  await page.evaluate((n) => { location.hash = '#/portfolio@sync:' + n + '?asof=2026-01-01'; }, served + 1);
  await expect(page.locator('#pinnote')).toHaveText(`pinned to sync ${served + 1} · this server shows sync ${served}`);
  await page.evaluate((n) => { location.hash = '#/portfolio@sync:' + n; }, served);
  await expect(page.locator('#pinnote')).toHaveCount(0);
});
