// Faults injected at the network with page.route — the real server stays up and
// answers everything else. This is the only place the suite mocks (ADR 8).
import { test, expect } from './support';

test.describe('faults', () => {
  test.describe('a failing /api/tests', () => {
    test.use({ expectedHttpErrors: [/\/api\/tests\?/] });

    /**
     * @covers packages/server/public/app/surfaces/tests.js::testsRetry
     * @covers GET /api/tests
     */
    test('the Tests surface says it could not load, shows the status, and recovers on retry', async ({ page }) => {
      await page.route('**/api/tests?*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'injected by e2e' }) }));
      await page.goto('/#/tests');
      const body = page.locator('#tst-body');
      await expect(body).toContainText('Could not load the tests surface.');
      await expect(body).toContainText('500');
      await expect(body).toContainText('injected by e2e');
      // nothing on the page is kept from the failure — the matrix is not drawn
      await expect(page.locator('#tst-body table')).toHaveCount(0);
      await page.unroute('**/api/tests?*');
      await body.getByRole('button', { name: /ask again/i }).click();
      await expect(page.locator('#tst-body table').first()).toBeVisible();
    });
  });

  /**
   * @covers packages/server/public/app/shell.js::syncChipHtml
   * @covers GET /api/version
   */
  test('a newer build on disk than the server runs puts RESTART on the sync chip', async ({ page }) => {
    await page.route('**/api/version', async (route) => {
      const res = await route.fetch();
      const v = await res.json();
      v.install = { ...v.install, newerInstalled: true };
      await route.fulfill({ response: res, json: v });
    });
    await page.goto('/');
    const chip = page.locator('#syncchipwrap .syncchip');
    await expect(chip).toHaveClass(/restart/);
    await expect(chip).toContainText('RESTART');
  });

  test.describe('a slow journey', () => {
    /** @covers GET /api/journey */
    test('opening a journey while /api/journey is slow still lands on it, with no error', async ({ page }) => {
      await page.route('**/api/journey?*', async (route) => {
        await new Promise((r) => setTimeout(r, 1_500));
        await route.continue();
      });
      await page.goto('/#/journeys');
      await page.locator('.dsg-flow.pinned').first().getByRole('button', { name: 'Open journey' }).click();
      await expect(page.locator('#jrn-title')).toHaveText('Billing cycle');
      await expect(page.locator('#jrn-count')).toContainText('3 screens', { timeout: 10_000 });
    });
  });
});
