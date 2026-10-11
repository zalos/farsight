// A journey is read on the Map (lanes round 2026-10-10, proposal 1): one spec per view the journey page had, each
// re-addressed to the stop and layout it became — the storyboard is the street (the journey stop, `screens`), the
// timeline and the sheet are the table (the journey stop, `table`), the drill is the action stop (`beats`, its
// ladder the other layout), the code pane is the dock.
import { test, expect, gotoReady, openBillingCycle, openJourneyAt } from './support';

const FLOW = encodeURIComponent('invoice-app::flow::billing-cycle');

test.describe('a journey on the Map', () => {
  /**
   * @covers packages/server/public/app/surfaces/journeys.js::openJourney
   * @covers packages/server/public/app/surfaces/map-stops.js::registerView
   * @covers packages/server/public/app/lib/journey-draw.js::jrnHeaderHtml
   * @covers GET /api/journey
   */
  test('opens Billing cycle from the front door on the Map, at the hybrid register\'s table, with its counts', async ({ page }) => {
    await openBillingCycle(page);
    await expect(page).toHaveURL(/layout=table/);
    const head = page.locator('.map-jhead .jrn-count');
    await expect(head).toContainText('3 screens');
    await expect(head).toContainText('2 of 3 screens built');
  });

  /**
   * the storyboard → the street
   * @covers packages/server/public/app/lib/route-url.js::overlayToMap
   */
  test('an old storyboard link is the business street: the screens in order, each with its own sentence', async ({ page }) => {
    await gotoReady(page, '#/journeys/' + FLOW + '?view=storyboard&lens=business');
    await expect(page).toHaveURL(new RegExp('#/map/' + FLOW.replace(/%/g, '%')));
    await expect(page.locator('.map-layout [data-layout="screens"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.map-scr[data-flow="invoice-app::flow::billing-cycle"]')).toHaveCount(3);
    await expect(page.locator('.map-scr .say').first()).not.toBeEmpty();
  });

  /**
   * the timeline and the sheet → the table; `v` cycles the layout at the stop
   * @covers packages/server/public/app/surfaces/map-stops.js::cycleLayout
   */
  test('an old sheet or timeline link is the table, and v cycles the layout at the stop', async ({ page }) => {
    for (const view of ['sheet', 'timeline']) {
      await gotoReady(page, '#/journeys/' + FLOW + '?view=' + view + '&lens=hybrid');
      await expect(page.locator('.map-table .jrn-sheet')).toBeVisible();
      await expect(page).toHaveURL(/layout=table/);
    }
    await page.locator('.map-jhead .nm').click();
    await page.keyboard.press('v');
    await expect(page.locator('.map-table')).toHaveCount(0);
    await expect(page.locator('.map-scr').first()).toBeVisible();
  });

  /**
   * the drill → the action stop; the timeline's ladder band → the action's ladder layout
   * @covers packages/server/public/app/surfaces/map-stops.js::openScreenAction
   */
  test('an old drill link is the drill — the action rail over the beats — and its ladder is a layout there', async ({ page }) => {
    await gotoReady(page, '#/journeys/' + FLOW + '?view=drill&step=1&lens=hybrid');
    await expect(page.locator('.map-act')).toBeVisible();
    await expect(page.locator('.map-act .map-rail .jrn-stop.on')).toBeVisible();
    await expect(page).toHaveURL(/screen=1/);
    await expect(page).toHaveURL(/action=1/);
    await expect(page).toHaveURL(/layout=drill/);
    // v walks the action stop's layouts: beats, then the ladder
    await page.keyboard.press('v');
    await expect(page.locator('.map-act .map-rail')).toHaveCount(0);
    await page.keyboard.press('v');
    await expect(page.locator('.map-act .map-ladder')).toBeVisible();
    await expect(page).toHaveURL(/layout=ladder/);
  });

  /**
   * the code pane → the dock: j / k walk the table's parts, each opening its code; d moves the dock
   * @covers packages/server/public/app/surfaces/map-stops.js::tableKey
   * @covers packages/server/public/app/lib/journey-draw.js::jrnSetDock
   */
  test('on the table j opens a part\'s code in the dock, d moves the dock, and the address names the part', async ({ page }) => {
    await openJourneyAt(page, 'table');
    await page.locator('.map-jhead .nm').click();
    await page.keyboard.press('j');
    await expect(page.locator('#jrn-dock')).not.toHaveClass(/\bempty\b/);
    await expect(page).toHaveURL(/part=/);
    const was = await page.evaluate(() => (window as any).S.jrnDock);
    await page.keyboard.press('d');
    await expect.poll(() => page.evaluate(() => (window as any).S.jrnDock)).not.toBe(was);
    await expect(page).toHaveURL(new RegExp('dock=' + (await page.evaluate(() => (window as any).S.jrnDock))));
    // Esc closes the part's code first — the table stays, the address forgets the part
    await page.keyboard.press('Escape');
    await expect(page).not.toHaveURL(/part=/);
    await expect(page.locator('.map-table .jrn-sheet')).toBeVisible();
  });
});
