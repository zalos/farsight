// Esc unwinds what is on top, one layer at a time — and on the Map, one stop at a time.
import { test, expect, gotoReady, openBillingCycle, openJourneyAt } from './support';

test.describe('escape and focus', () => {
  /** @covers packages/server/public/app/keymap.js::onKeydown */
  test('Esc closes the palette over a journey before it goes up a stop', async ({ page }) => {
    await openBillingCycle(page);
    const table = page.locator('.map-table .jrn-sheet');
    await expect(table).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('dialog', { name: 'Search' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Search' })).toBeHidden();
    await expect(table).toBeVisible();
  });

  /** @covers packages/server/public/app/keymap.js::onKeydown */
  test('`?` opens the keymap panel and Esc closes it', async ({ page }) => {
    await gotoReady(page, '#/journeys');
    await page.keyboard.press('?');
    await expect(page.locator('#keymap')).toHaveClass(/open/);
    // one keymap: each key once
    const keys = await page.locator('#keymap .km-row kbd').allInnerTexts();
    expect(new Set(keys).size, 'a key listed twice').toBe(keys.length);
    await page.keyboard.press('Escape');
    await expect(page.locator('#keymap')).not.toHaveClass(/open/);
  });

  /**
   * @covers packages/server/public/app/surfaces/map.js::mapEscape
   * @covers packages/server/public/app/surfaces/map-stops.js::tableEscape
   */
  test('Esc goes up one stop at a time: the code, the action, the screen, the journey', async ({ page }) => {
    await openJourneyAt(page, 'screens');
    const flow = encodeURIComponent('invoice-app::flow::billing-cycle');
    await page.evaluate((f) => { location.hash = '#/map/' + f + '?screen=2&action=1&dock=bottom'; }, flow);
    await expect(page.locator('.map-act.code')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.map-act')).toBeVisible();
    await expect(page.locator('.map-act.code')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.map-act')).toHaveCount(0);
    await expect(page.locator('.map-prop-host')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.map-prop-host')).toBeHidden();
    await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
  });
});
