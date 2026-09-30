// Work chips on other surfaces: a Portfolio row and a journey header read
// /api/work/flow/<id>, the inspector reads /api/work/links?node=. A workspace with
// no work source asks for none of them.
import { test, expect } from './support';
import { routeWork, routeWorkSettings } from './work-stub';

test.describe('work chips', () => {
  /**
   * @covers packages/server/public/app/work-chips.js::flowChipHtml
   * @covers GET /api/work/flow/:id
   */
  test('a Portfolio row carries its work as a count whose breakdown adds up', async ({ page }) => {
    await routeWorkSettings(page);
    await routeWork(page);
    await page.goto('/#/portfolio');
    const chip = page.locator('.pf-table .wk-chip[data-flow="invoice-app::flow::new-invoice"]');
    await expect(chip).toContainText('3 work items');
    await expect(chip).toContainText('1 in progress · 2 done');
    await chip.locator('[data-tip-id="number"]').click();
    const tip = page.locator('#fs-tip');
    await expect(tip).toBeVisible();
    const parts = (await tip.locator('.tip-tbl td.n').allTextContents()).map(Number);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(3);
    // a flow nothing tracks draws no chip — never a 0
    await expect(page.locator('.pf-table .wk-chip[data-flow="invoice-app::flow::billing-cycle"]')).toHaveCount(0);
  });

  /** @covers packages/server/public/app/work-chips.js::fillJourneyWork */
  test('a journey header carries the same chip, and it opens the work filtered to the journey', async ({ page }) => {
    await routeWorkSettings(page);
    await routeWork(page);
    await page.goto('/#/journeys/' + encodeURIComponent('invoice-app::flow::draft-and-send'));
    const chip = page.locator('#jrn-work .wk-chip');
    await expect(chip).toContainText('3 work items');
    await chip.getByRole('link').click();
    await expect(page).toHaveURL(/#\/work\?flow=/);
    await expect(page.locator('.wk-filters .wk-chip')).toBeVisible();
  });

  /**
   * @covers packages/server/public/app/work-chips.js::nodeWorkSecHtml
   * @covers GET /api/work/links
   */
  test('the inspector says which work item tracks a part', async ({ page }) => {
    await routeWorkSettings(page);
    await routeWork(page);
    await page.goto('/#/codemap?node=' + encodeURIComponent('invoice-app::src/server/taxEngine.ts::computeTax'));
    const sec = page.locator('#insp-work');
    await expect(sec).toBeVisible();
    await expect(sec).toContainText('tracked by INV-6 Tax rounds the wrong way on multi-line invoices (done, invoice-jira)');
    await sec.getByRole('link').first().click();
    await expect(page).toHaveURL(/#\/work\/work/);
  });

  /** @covers packages/server/public/app/work-chips.js::workSourcesConfigured */
  test('a workspace with no work source asks for no work', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => { if (/\/api\/work/.test(r.url())) asked.push(r.url()); });
    await page.goto('/#/portfolio');
    await expect(page.locator('.pf-table').first()).toBeVisible();
    await page.goto('/#/codemap?node=' + encodeURIComponent('invoice-app::src/server/taxEngine.ts::computeTax'));
    await expect(page.locator('#inspector h2')).toBeVisible();
    await page.waitForTimeout(300);
    expect(asked).toEqual([]);
    await expect(page.locator('.wk-chip')).toHaveCount(0);
  });
});
