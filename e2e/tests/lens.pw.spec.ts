// Lens and register: the two switches that decide who the screen is written for.
import { test, expect, gotoReady } from './support';

const AMBER = 'rgb(240, 180, 78)'; // quest-amber #F0B44E — business lens
const CYAN = 'rgb(91, 200, 221)'; // signal-cyan #5BC8DD — code / hybrid lens

test.describe('lens and register', () => {
  /**
   * @covers packages/server/public/app/shell.js::setLens
   * @covers packages/server/public/app/shell.js::renderChrome
   */
  test('business warms the chrome to amber, code cools it to cyan', async ({ page }) => {
    await gotoReady(page, '');
    const logo = page.locator('.logo');
    const tabs = page.getByRole('navigation', { name: 'Surfaces' }).getByRole('button');
    const order = await tabs.allTextContents();
    await expect(page.locator('body')).toHaveClass(/lens-hybrid/);
    await expect(logo).toHaveCSS('color', CYAN);

    await page.getByRole('button', { name: 'Business', exact: true }).click();
    await expect(page.locator('body')).toHaveClass(/lens-business/);
    await expect(page.locator('#lb-business')).toHaveClass(/\bon\b/);
    await expect(logo).toHaveCSS('color', AMBER);
    await expect(page.locator('#lens-status')).toHaveText('lens: business');

    await page.getByRole('button', { name: 'Code', exact: true }).click();
    await expect(page.locator('body')).toHaveClass(/lens-code/);
    await expect(logo).toHaveCSS('color', CYAN);
    // one tab order in every register: the first tab always means Portfolio, so a
    // reader who clicks by position lands where they did before the switch
    await expect(tabs.first()).toHaveText(/portfolio/i);
    await expect(tabs).toHaveText(order);
  });

  /**
   * @covers packages/server/public/app/strings.js::toggleRegister
   */
  test('the register toggle swaps professional words for HUD words and back', async ({ page }) => {
    await gotoReady(page, '');
    const toggle = page.locator('#regtoggle');
    const search = page.locator('#searchlabel');
    // at 1440 the bar overflows and fitTopbar moves the toggle into the ⋯ menu
    const openMore = async () => { if (await page.locator('#morewrap').isVisible()) await page.locator('#morebtn').click(); };
    await expect(toggle).toContainText(/Professional terms/i);
    await expect(search).toHaveText('search…');
    await openMore();
    await toggle.click();
    await expect(search).toHaveText('fast travel…');
    await openMore();
    await toggle.click();
    await expect(search).toHaveText('search…');
  });
});
