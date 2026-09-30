// With a journey open, the chrome above it must still work.
//
// EXPECTED TO FAIL until the header-clickability fix merges (another lane,
// 2026-09-24). Opening a journey makes everything behind the overlay `inert`
// for the focus trap — including the top bar, which stays *visible* above the
// overlay (the overlay starts at 84px). The nav tabs, the lens switch and the
// scope filter look live but swallow real pointer clicks. These tests use real
// clicks on purpose (no `force`, no `dispatchEvent`) and are deliberately NOT
// `test.fixme`/`test.fail`: a red result here is the bug, visible, and it turns
// green on its own when the fix lands.
import { test, expect, openBillingCycle } from './support';

test.describe('journey open — header and filters stay clickable', () => {
  /**
   * @covers packages/server/public/app/shell.js::renderChrome
   * @covers packages/server/public/app/surfaces/journeys.js::openJourney
   */
  test('a nav tab click leaves the journey for that surface', async ({ page }) => {
    await openBillingCycle(page);
    await page.getByRole('navigation', { name: 'Surfaces' }).getByRole('button', { name: 'Tests', exact: true }).click({ timeout: 5_000 });
    await expect(page).toHaveURL(/#\/tests/);
  });

  /** @covers packages/server/public/app/shell.js::setLens */
  test('the lens switch still switches the lens', async ({ page }) => {
    await openBillingCycle(page);
    await page.getByRole('button', { name: 'Business', exact: true }).click({ timeout: 5_000 });
    await expect(page.locator('body')).toHaveClass(/lens-business/);
  });

  /** @covers packages/server/public/app/shell.js::toggleScopeMenu */
  test('the scope filter still opens', async ({ page }) => {
    await openBillingCycle(page);
    await page.getByRole('button', { name: 'Source scope' }).click({ timeout: 5_000 });
    await expect(page.getByRole('menu', { name: 'Sources and groups' })).toBeVisible();
  });
});
