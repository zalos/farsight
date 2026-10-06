// Esc unwinds what is on top, one layer at a time; Tab stays inside an open dialog.
import { test, expect, gotoReady, openBillingCycle } from './support';

test.describe('escape and focus', () => {
  /** @covers packages/server/public/app/keymap.js::onKeydown */
  test('Esc closes the palette over a journey before it closes the journey', async ({ page }) => {
    await openBillingCycle(page);
    const journey = page.getByRole('dialog', { name: 'Journey', exact: true });
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('dialog', { name: 'Search' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Search' })).toBeHidden();
    await expect(journey).toBeVisible();
    // with nothing inside the journey open, the first Esc says what a second does; the second closes it
    await page.keyboard.press('Escape');
    await expect(page.locator('#esc-toast')).toHaveText('Esc again closes this journey');
    await expect(journey).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(journey).toBeHidden();
  });

  /** @covers packages/server/public/app/keymap.js::onKeydown */
  test('`?` opens the keymap panel and Esc closes it', async ({ page }) => {
    await gotoReady(page, '#/journeys');
    await page.keyboard.press('?');
    await expect(page.locator('#keymap')).toHaveClass(/open/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#keymap')).not.toHaveClass(/open/);
  });

  /**
   * @covers packages/server/public/app/lib/focus-trap.js::trapTab
   * @covers packages/server/public/app/surfaces/journeys.js::closeJourney
   */
  test('Tab stays inside an open journey, and closing it returns focus to the page', async ({ page }) => {
    await openBillingCycle(page);
    const journey = page.getByRole('dialog', { name: 'Journey', exact: true });
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => !!document.activeElement?.closest('#journey'));
      expect(inside, `focus left the journey after ${i + 1} Tab presses`).toBe(true);
    }
    await journey.getByRole('button', { name: 'Close journey' }).click();
    await expect(journey).toBeHidden();
    // the opener is re-found after the surface re-mounts (focus-trap.js releaseFocus watches it),
    // so where the focus lands is an eventually-true fact: poll it, never read it once
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('#journey'))).toBe(false);
    await expect.poll(() => page.evaluate(() => document.activeElement !== document.body && !!document.activeElement?.closest('#surface'))).toBe(true);
  });
});
