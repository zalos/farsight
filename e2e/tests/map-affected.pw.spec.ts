// The Map's Affected mode (docs/proposals/map-pass-2026-10-03.md §4, lane I): pick a thing and the board
// dims to what reaches it, at every altitude. Measured on the fixture, never guessed: Billing cycle's
// New invoice and Invoice list call `POST /invoices`, Discard draft does not; the package `zod` reaches
// all three journeys through the rule that imports it (one link out); the invoices table reaches four
// screens and is used by six calls two links out. Every number is core affectedReach()'s Counted.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';
import { routeWork } from './work-stub';

const FLOW = 'invoice-app::flow::billing-cycle';
const STREET = '#/map/' + encodeURIComponent(FLOW);
const ROUTE = 'invoice-app::route::POST /invoices';
const TABLE = 'invoice-app::table::invoices';
const ZOD = 'invoice-app::package::zod';
const LIST_PAGE = 'invoice-app::page::/invoices';

/** Identifier-shaped tokens — the journey-numbers bar. */
const IDENTIFIER = new RegExp([
  String.raw`\b[a-z]+[A-Z][A-Za-z0-9]*\b`,
  String.raw`\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b`,
  String.raw`\b[a-z0-9]+_[a-z0-9_]+\b`,
  String.raw`\b[A-Z0-9]+_[A-Z0-9_]+\b`,
  String.raw`(?:^|[\s(])\/[\w.:{}\-]+`,
  String.raw`\b(?:GET|POST|PUT|PATCH|DELETE)\b`,
  String.raw`\b[\w-]+\.(?:spec|test|pw)\b`,
  String.raw`\.(?:tsx?|jsx?|mjs|json)\b`,
].join('|'), 'g');

async function mapOn(page: Page, lens = 'hybrid') {
  await gotoReady(page, '#/portfolio?lens=' + lens);
  await page.evaluate(() => {
    const S = (window as any).S;
    S.SETTINGS = Object.assign({}, S.SETTINGS, { flags: Object.assign({}, S.SETTINGS && S.SETTINGS.flags, { map: true }) });
  });
}
async function go(page: Page, hash: string) { await page.evaluate((h) => { location.hash = h; }, hash); }
const scr = (page: Page, index: number) => page.locator(`.map-scr[data-flow="${FLOW}"][data-index="${index}"]`);

test.describe('map — the Affected mode', () => {
  /**
   * @covers packages/server/public/app/surfaces/map-affected.js::setAffected
   * @covers packages/server/public/app/surfaces/map-affected.js::paintDistrict
   * @covers packages/server/public/app/surfaces/map-affected.js::affectedBarHtml
   * @covers packages/server/public/app/surfaces/map.js::mapEscape
   * @covers GET /api/impact
   */
  test('a call seeded from the explore card dims the screen that does not call it and badges the ones that do', async ({ page }) => {
    await mapOn(page);
    await go(page, STREET + '?plumb=1');
    await expect(scr(page, 2)).toBeVisible();
    await page.locator(`.map-pl[data-flow="${FLOW}"][data-si="0"][data-ci="0"] .nm`).click();
    await page.locator('.map-xcard [data-act="affected"]').click();
    const bar = page.locator('.map-affbar');
    await expect(bar).toBeVisible();
    await expect(bar.locator('.map-affname')).toHaveText('POST /invoices');
    await expect(bar).toContainText('in 3 journeys');
    await expect(scr(page, 2)).toHaveClass(/aff-dim/);
    for (const i of [0, 1]) {
      await expect(scr(page, i)).toHaveClass(/aff-hit/);
      await expect(scr(page, i).locator('.map-affb')).toHaveText('its path meets it');
    }
    // the seed itself is ringed on the street, wherever it is drawn
    await expect(page.locator(`.map-pl[data-flow="${FLOW}"][data-si="0"][data-ci="0"]`)).toHaveClass(/aff-seed/);
    // the card's on row speaks the mode's words
    await expect(page.locator('.map-xcard .where .map-chip.go').first()).toContainText('its path meets it');
    // the link carries the mode
    await expect(page).toHaveURL(/affected=invoice-app/);
    // Esc clears the mode before anything else (the card stays)
    await page.keyboard.press('Escape');
    await expect(bar).toHaveCount(0);
    await expect(page.locator('.map-xcard')).toBeVisible();
    await expect(scr(page, 2)).not.toHaveClass(/aff-dim/);
    await expect(page).not.toHaveURL(/affected=/);
  });

  /**
   * @covers packages/server/public/app/surfaces/map-affected.js::journeyReach
   * @covers packages/server/public/app/lib/map-affected-model.js::parseSeedSpec
   */
  test('a package seeded by link lights the journeys it reaches on the board, one link out', async ({ page }) => {
    await mapOn(page);
    await go(page, '#/map?affected=' + encodeURIComponent('package:' + ZOD));
    await expect(page.locator('.map-affbar .map-affname')).toHaveText('zod');
    const districts = page.locator('.map-district');
    await expect(districts).toHaveCount(3);
    await expect(page.locator('.map-district.aff-hit')).toHaveCount(3);
    for (const d of await districts.all()) await expect(d.locator('.map-dcover .map-affb')).toHaveText('reached at hop 1');
    await expect(page.locator('.map-affbar')).toContainText('in 3 journeys');
  });

  /**
   * @covers packages/server/public/app/surfaces/map-affected.js::affectedTabHtml
   * @covers packages/server/public/app/surfaces/map-affected.js::affectedTabCount
   * @covers packages/server/public/app/lib/map-affected-model.js::hopGroups
   */
  test('the property\'s Affected tab lists journeys, screens, calls and tests per distance, with the floor and the stops', async ({ page }) => {
    await mapOn(page);
    await go(page, STREET + '?node=' + encodeURIComponent(LIST_PAGE) + '&affected=' + encodeURIComponent(TABLE) + '&ahops=3');
    const tab = page.locator('#mp-tab-affected');
    await expect(tab).toBeVisible();
    // four screen rows on three journeys, two pages: a screen several journeys share is counted once (round 2)
    await expect(tab.locator('.mp-tabn')).toHaveText('2');
    await tab.click();
    const body = page.locator('#mp-body');
    await expect(body.locator('.mp-aff .mp-chips')).toContainText(['in 3 journeys']);
    await expect(body.locator('.mp-aff .mp-chips')).toContainText('6 calls reach it');
    await expect(body.locator('.mp-affbound')).toContainText('≥ a floor');
    // per distance: their own path meets it, then what uses it directly holds the first tests
    await expect(body.locator('.mp-affgroup[data-hop="0"] .mp-affhop')).toHaveText('its path meets it');
    await expect(body.locator('.mp-affgroup[data-hop="1"] .mp-affsub', { hasText: 'tests first met here' })).toBeVisible();
    await expect(body.locator('.mp-affgroup[data-hop="2"]')).toContainText('POST /invoices');
    await expect(body.locator('.mp-affstops')).toBeVisible();
    // the distance stepper rides in the link
    await expect(page).toHaveURL(/ahops=3/);
  });

  /** @covers packages/server/public/app/surfaces/map-affected.js::affectedTabHtml */
  test('the business register prints no identifier on the bar, the board or the Affected tab', async ({ page }) => {
    await mapOn(page, 'business');
    await go(page, STREET + '?plumb=1&affected=' + encodeURIComponent(TABLE));
    await expect(page.locator('.map-affbar .map-affname')).toBeVisible();
    await expect(scr(page, 0)).toHaveClass(/aff-hit/);
    const barText = await page.locator('.map-affbar').innerText();
    expect(barText.match(IDENTIFIER) || []).toEqual([]);
    await scr(page, 1).click();
    await page.locator('#mp-tab-affected').click();
    await expect(page.locator('#mp-body .mp-aff')).toBeVisible();
    const tabText = await page.locator('#mp-body').innerText();
    expect(tabText.match(IDENTIFIER) || []).toEqual([]);
    expect(tabText).not.toMatch(/\bhops?\b/i);
  });

  /** @covers packages/server/public/app/surfaces/map.js::writeHash */
  test('the link round-trips the mode: the same link opens the same dimmed picture at the same distance', async ({ page }) => {
    await mapOn(page);
    await go(page, STREET + '?plumb=1&affected=' + encodeURIComponent(ROUTE));
    await expect(scr(page, 2)).toHaveClass(/aff-dim/);
    await page.locator('.map-affhops button[data-h="4"]').click();
    await expect(page.locator('.map-affhops button[data-h="4"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/ahops=4/);
    const link = page.url();
    const fresh = await page.context().newPage();
    await gotoReady(fresh, '#/portfolio');
    await fresh.evaluate(() => {
      const S = (window as any).S;
      S.SETTINGS = Object.assign({}, S.SETTINGS, { flags: Object.assign({}, S.SETTINGS && S.SETTINGS.flags, { map: true }) });
    });
    await fresh.evaluate((h) => { location.hash = h; }, new URL(link).hash);
    await expect(fresh.locator('.map-affhops button[data-h="4"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(fresh.locator(`.map-scr[data-flow="${FLOW}"][data-index="2"]`)).toHaveClass(/aff-dim/);
    await fresh.close();
    // clear takes it out of the link
    await page.locator('.map-affbar [data-act="aff-clear"]').click();
    await expect(page).not.toHaveURL(/affected=/);
  });

  /**
   * The fixture has no work source: the work item's answer comes from the WORK stub (page.route), its
   * touched parts from the stub's join (a commit naming INV-2 changed the new-invoice form and service).
   * @covers packages/server/public/app/surfaces/map-affected.js::setAffected
   */
  test('a work item seeds the parts its commits touched, each asked on its own', async ({ page }) => {
    await routeWork(page);
    await mapOn(page);
    await go(page, STREET + '?affected=' + encodeURIComponent('work:INV-2'));
    const bar = page.locator('.map-affbar');
    await expect(bar.locator('.map-affname')).toContainText('INV-2');
    await expect(scr(page, 0)).toHaveClass(/aff-hit/);
    await expect(scr(page, 2)).toHaveClass(/aff-dim/);
    // several parts: a badge's tip names each part and how it reaches, never a sum
    await expect(bar.locator('.map-affn')).toHaveCount(0);
  });
});
