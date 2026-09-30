// A journey: open one from the picker and read it in each of its views.
import { test, expect, openBillingCycle } from './support';

test.describe('journey views', () => {
  /**
   * @covers packages/server/public/app/surfaces/journeys.js::openJourney
   * @covers packages/server/public/app/surfaces/journeys.js::renderJourney
   * @covers GET /api/journey
   */
  test('opens Billing cycle from the picker with its counts and a deep link', async ({ page }) => {
    await openBillingCycle(page);
    await expect(page).toHaveURL(/#\/journeys\/invoice-app%3A%3Aflow%3A%3Abilling-cycle/);
    await expect(page.locator('#jrn-count')).toContainText('3 screens');
    await expect(page.locator('#jrn-count')).toContainText('2 of 3 built');
  });

  /**
   * @covers packages/server/public/app/surfaces/journeys.js::jrnSetLayout
   * @covers packages/server/public/app/surfaces/journeys.js::jrnCycleLayout
   */
  test('the view switch draws the storyboard, the timeline and the sheet, and the URL follows', async ({ page }) => {
    await openBillingCycle(page);
    const views = page.getByRole('group', { name: 'View' });
    const body = page.locator('#jrn-tl');
    const cases: [string, RegExp, string][] = [
      ['Storyboard', /view=storyboard/, '.jrn-story'],
      ['Timeline', /view=timeline/, '.jrn-userrow'],
      ['Sheet', /view=sheet/, '.jrn-sheet'],
    ];
    for (const [name, url, drawn] of cases) {
      await views.getByRole('button', { name, exact: true }).click();
      await expect(views.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page).toHaveURL(url);
      await expect(body.locator(drawn).first()).toBeVisible();
    }
    // `v` cycles the same axis from the keyboard
    await page.locator('#jrn-title').click();
    await page.keyboard.press('v');
    await expect(page).not.toHaveURL(/view=sheet/);
  });

  /** @covers packages/server/public/app/surfaces/journeys.js::jrnToggleView */
  test('in the timeline, `l` turns the system band into a ladder and back', async ({ page }) => {
    await openBillingCycle(page);
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Timeline', exact: true }).click();
    await expect(page.locator('#jrn-tl .jrn-userrow').first()).toBeVisible();
    await page.keyboard.press('l');
    await expect(page.locator('#jrn-tl .jrn-ladder').first()).toBeVisible();
    await expect(page).toHaveURL(/band=ladder/);
    await page.keyboard.press('l');
    await expect(page.locator('#jrn-tl .jrn-ladder')).toHaveCount(0);
  });

  /** @covers packages/server/public/app/surfaces/journeys.js::jrnSetDock */
  test('the code pane dock moves between bottom, right and in place', async ({ page }) => {
    await openBillingCycle(page);
    const dock = page.getByRole('group', { name: 'Code pane' });
    for (const name of ['Right', 'In place', 'Bottom']) {
      await dock.getByRole('button', { name, exact: true }).click();
      await expect(dock.getByRole('button', { name, exact: true })).toHaveClass(/\bon\b/);
    }
  });
});
