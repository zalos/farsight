// The storyline as swimlanes (round 2026-10-10 §2): on the fixture's storyline *An invoice, end to end* the Map's
// LAYOUT control draws lanes of who acts — Billing and Operations from the manifest's personas, and the Invoice DB
// because the storyline's code writes to it — the screens as columns, the record's moves in the store lane in the
// lifecycle's order, and the footer's counts. A click or a zoom into a screen enters that journey's street there; the
// board stop brings the lanes back; Save draws the lanes. The map is a workspace experiment: it is switched on in the
// page only.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';

const LANES = '#/map?storyline=invoice&layout=lanes';

async function mapOn(page: Page) {
  await gotoReady(page, '#/portfolio');
  await page.evaluate(() => {
    const S = (window as any).S;
    S.SETTINGS = Object.assign({}, S.SETTINGS, { flags: Object.assign({}, S.SETTINGS && S.SETTINGS.flags, { map: true }) });
  });
}
async function openLanes(page: Page) {
  await mapOn(page);
  await page.evaluate((h) => { location.hash = h; }, LANES);
  // every journey of the storyline read: the footer stops saying how many are left
  await expect(page.locator('.map-lanes .ln-stage')).toHaveCount(5);
  await expect(page.locator('.map-lanes .ln-foot .rd')).toHaveCount(0);
}

/**
 * @covers packages/server/public/app/lib/map-lanes-model.js::laneLayout
 * @covers packages/server/public/app/surfaces/map-lanes.js::lanesHtml
 * @covers packages/server/public/app/surfaces/map.js::drawLanes
 */
test('the invoice storyline as lanes: two persona lanes and one store lane, the record\'s moves in lifecycle order, true counts', async ({ page }) => {
  await openLanes(page);
  await expect(page.locator('.map-world')).toHaveClass(/lanes-on/);
  // the layout control says lanes, and the link carries it
  await expect(page.locator('.map-layout-pick .map-seg[data-layout="lanes"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => location.hash)).toContain('layout=lanes');
  // the lanes: Billing, Operations (persona), Invoice DB (store) — one panel each in the one segment
  const lanes = page.locator('.map-lanes .ln-lane');
  await expect(lanes).toHaveCount(3);
  await expect(page.locator('.map-lanes .ln-lane.persona .ln-head .nm')).toHaveText(['Billing', 'Operations']);
  await expect(page.locator('.map-lanes .ln-lane.store .ln-head .nm')).toHaveText(['Invoice DB']);
  // the screens: three on Billing's lane (the main path), the branch's two on Operations'
  await expect(page.locator('.map-lanes .ln-stage:not(.branch)')).toHaveCount(3);
  await expect(page.locator('.map-lanes .ln-stage.branch')).toHaveCount(2);
  await expect(page.locator('.map-lanes .ln-stage.planned')).toHaveCount(2);
  // the record lane reads in the lifecycle's order: created (draft), then status → open
  const inv = page.locator('.map-lanes .ln-pill[data-record="invoice-app::table::invoices"]');
  await expect(inv).toHaveCount(2);
  expect(await inv.evaluateAll((els) => els.map((e) => [e.getAttribute('data-status'), Math.round(e.getBoundingClientRect().left)])
    .sort((a, b) => (a[1] as number) - (b[1] as number)).map((x) => x[0]))).toEqual(['draft', 'open']);
  // the footer: 3 journeys · 3 screens · 2 of 3 built · 1 branch — as the journey tree and the design say
  const foot = page.locator('.map-lanes .ln-foot');
  await expect(foot).toContainText('3 journeys');
  await expect(foot).toContainText('3 screens');
  await expect(foot).toContainText('2 of 3 built');
  await expect(foot).toContainText('1 branch');
  const tree = await page.evaluate(async () => (await (await fetch('/api/journeys')).json()).tree.storylines.find((s: any) => s.id === 'invoice'));
  expect(tree.counts.journeys.n).toBe(3);
  expect(tree.branches.length).toBe(1);
  // each move carries what its action needs; finalize never checks the status it leaves, and says so
  await expect(page.locator('.map-lanes .ln-pill[data-status="draft"] .nd')).toContainText('needs 2');
  await expect(page.locator('.map-lanes .ln-pill[data-status="draft"] .nd .nc')).toHaveCount(0);
  await expect(page.locator('.map-lanes .ln-pill[data-status="open"] .nd .nc')).toHaveCount(1);
  // the lifecycle strip under the lanes, and the legend
  await expect(page.locator('.map-lanes .ln-life .lc-strip')).toHaveCount(1);
  await expect(page.locator('.map-lanes .ln-legend .lg')).not.toHaveCount(0);
});

/**
 * @covers packages/server/public/app/surfaces/map.js::enterStage
 * @covers packages/server/public/app/surfaces/map.js::laneStops
 */
test('a screen on the lanes enters its journey\'s street at that screen; zooming in on one by + does too; Esc comes back to the lanes', async ({ page }) => {
  await openLanes(page);
  // click: Invoice list (billing-cycle's second screen) — the street of Billing cycle, that screen framed
  await page.locator('.map-lanes .ln-stage[data-key="s:INV-01"]').click();
  await expect(page.locator('.map-world')).not.toHaveClass(/lanes-on/);
  await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
  await expect.poll(() => page.evaluate(() => location.hash)).toContain(encodeURIComponent('invoice-app::flow::billing-cycle'));
  await expect(page.locator('.map-scr[data-flow="invoice-app::flow::billing-cycle"][data-index="1"]')).toBeFocused();
  // Esc from the street is the board: the lanes again, fitted
  await page.keyboard.press('Escape');
  await expect(page.locator('.map-world')).toHaveClass(/lanes-on/);
  // and Fit on the lanes fits the lanes
  await page.locator('[data-act="fit"]').click();
  await expect(page.locator('.map-world')).toHaveClass(/lanes-on/);
  // zoom in by the keys: + goes to the stop where the screen nearest the middle is large enough to enter, framed and
  // ringed; the next + enters it (the same rule as a zoom gesture that ends on an armed screen, without its timing)
  await page.locator('.map-board').focus();
  await page.keyboard.press('+');
  await expect(page.locator('.map-lanes .ln-stage.near')).toHaveCount(1);
  await page.keyboard.press('+');
  await expect(page.locator('.map-world')).not.toHaveClass(/lanes-on/, { timeout: 8000 });
  await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
});

/** @covers packages/server/public/app/surfaces/map.js::setLayout */
test('the layout control and w switch between the chain and the lanes; the chain draws as before', async ({ page }) => {
  await openLanes(page);
  await page.locator('.map-layout-pick .map-seg[data-layout="chain"]').click();
  await expect(page.locator('.map-world')).not.toHaveClass(/lanes-on/);
  await expect(page.locator('.map-lanes')).toHaveCount(0);
  await expect(page.locator('.map-band.story')).toHaveCount(1);
  expect(await page.evaluate(() => location.hash)).not.toContain('layout=');
  await page.locator('.map-board').focus();
  await page.keyboard.press('w');
  await expect(page.locator('.map-world')).toHaveClass(/lanes-on/);
  // with no storyline drawn there is no layout to pick
  await page.evaluate(() => { location.hash = '#/map'; });
  await expect(page.locator('.map-layout-pick')).toHaveCount(0);
});

/**
 * @covers packages/server/public/app/surfaces/map.js::mapPicture
 */
test('Save draws the lanes board whole, as a PNG with the provenance footer', async ({ page }) => {
  await openLanes(page);
  const shot = await page.evaluate(() => (window as any).farsightSave('map', 'png', { dataUrl: true }));
  expect(shot.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  expect(shot.dataUrl.length).toBeGreaterThan(20000);
  expect(shot.footer).toContain('An invoice, end to end');
  const [w, h] = (await page.locator('[data-export="map"]').getAttribute('data-export-size'))!.split('x').map(Number);
  expect(w).toBeGreaterThan(600);
  expect(h).toBeGreaterThan(300);
});

test('the business register prints words on the lanes: no status constants or table names on a pill', async ({ page }) => {
  await openLanes(page);
  await page.locator('#lb-business').click();
  await expect(page.locator('body')).toHaveClass(/lens-business/);
  await expect(page.locator('.map-lanes .ln-pill .by')).toHaveCount(0);
  const words = await page.locator('.map-lanes .ln-pill .mv').allInnerTexts();
  for (const w of words) expect(w).not.toMatch(/\b[a-z]+_[a-z_]+\b|\binvoices\b/);
});
