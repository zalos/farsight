// Every number and every detail carries a tip (lib/tooltip.js): a pointer that
// rests opens it after TIP_HOVER_MS, a click opens it at once and pins it, the
// keyboard opens it with `?`, and Esc closes it before anything else closes.
// The four exemplar spots — the sync chip, the status bar's count, the ⋯
// overflow count and the journey header's `N screens` — are what the next
// lanes copy, so they are what this spec drives.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady, openBillingCycle } from './support';

const tip = (page: Page) => page.locator('#fs-tip');

/** The hover delay, read from the module the page runs — never hardcoded here. */
async function hoverDelay(page: Page): Promise<number> {
  return page.evaluate(async () => (await import('/app/lib/tooltip.js' as string)).TIP_HOVER_MS as number);
}

test.describe('tips', () => {
  /**
   * @covers packages/server/public/app/lib/tooltip.js::initTips
   * @covers packages/server/public/app/lib/graph-render.js::updateStats
   */
  test('a resting pointer opens the tip only after the delay', async ({ page }) => {
    await gotoReady(page, '#/portfolio');
    const delay = await hoverDelay(page);
    expect(delay).toBeGreaterThanOrEqual(500);
    const stats = page.locator('#stats');
    const t0 = Date.now();
    await stats.hover();
    // well inside the delay nothing has opened, and the marker says one is coming
    await page.waitForTimeout(Math.min(400, delay / 3));
    await expect(tip(page)).toBeHidden();
    await expect(stats).toHaveClass(/tip-pending/);
    await expect(tip(page)).toBeVisible({ timeout: delay + 3000 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(delay - 50);
    // what it counts, over what, and from where — the three facts every number owes
    await expect(tip(page)).toContainText('shown of');
    await expect(tip(page)).toContainText('the code map, in the current scope');
    await expect(tip(page)).toContainText(/\/graph · sync \d+/);
    // and the breakdown adds up to the total it splits
    const nums = await tip(page).locator('.tip-tbl td.n').allTextContents();
    const values = nums.map(Number);
    const total = values[values.length - 1];
    expect(values.slice(0, -1).reduce((a, b) => a + b, 0)).toBe(total);
    // leaving the trigger and the tip closes an unpinned tip
    await page.mouse.move(700, 400);
    await expect(tip(page)).toBeHidden();
  });

  /** @covers packages/server/public/app/shell.js::syncChipTip */
  test('a click opens the sync chip\'s table at once, pinned, and Esc closes it', async ({ page }) => {
    await gotoReady(page, '#/portfolio');
    await page.locator('.syncchip').click();
    const dialog = page.getByRole('dialog', { name: 'This graph' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('table.tip-tbl')).toContainText('sync');
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();
    // pinned: the pointer wandering off does not close it
    await page.mouse.move(700, 600);
    await page.waitForTimeout(500);
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  /**
   * @covers packages/server/public/app/lib/tooltip.js::numberTip
   * @covers packages/server/public/app/shell.js::parseRoute
   */
  test('a rich tip\'s Grammar Book link navigates to the entry', async ({ page }) => {
    await gotoReady(page, '#/portfolio');
    await page.locator('#stats').click();
    await expect(tip(page)).toBeVisible();
    await tip(page).getByRole('link', { name: 'In the Grammar Book' }).click();
    await expect(page).toHaveURL(/#\/grammar\?key=chrome\.shownOf/);
    await expect(page.locator('tr.gb-hit')).toBeVisible();
    await expect(page.locator('tr.gb-hit')).toContainText('chrome.shownOf');
    await expect(tip(page)).toBeHidden();
  });

  /**
   * @covers packages/server/public/app/lib/tooltip.js::tipKeydown
   * @covers packages/server/public/app/keymap.js::onKeydown
   */
  test('the keyboard opens a tip with ?, Tabs into its links, and Esc hands focus back', async ({ page }) => {
    await gotoReady(page, '#/portfolio');
    await page.locator('#stats').focus();
    await page.keyboard.press('?');
    await expect(tip(page)).toBeVisible();
    await expect(page.locator('#keymap')).not.toHaveClass(/open/);
    await page.keyboard.press('Tab');
    const inTip = await page.evaluate(() => !!document.activeElement?.closest('#fs-tip'));
    expect(inTip).toBe(true);
    await page.keyboard.press('Escape');
    await expect(tip(page)).toBeHidden();
    await expect(page.locator('#stats')).toBeFocused();
  });

  /**
   * @covers packages/server/public/app/surfaces/journeys.js::jrnScreensTip
   * @covers packages/server/public/app/keymap.js::onKeydown
   */
  test('inside a journey: the screens tip lists the screens, and Esc closes the tip before the journey', async ({ page }) => {
    await openBillingCycle(page);
    await page.locator('#lb-hybrid').click();
    const journey = page.getByRole('dialog', { name: 'Journey', exact: true });
    const screens = page.locator('#jrn-count .jrn-screens');
    await expect(screens).toHaveText('3 screens');
    await screens.click();
    await expect(tip(page)).toBeVisible();
    await expect(tip(page)).toContainText('/api/journey · sync');
    // the split (built · not built) adds up to the count; the screens follow as a list
    const split = await tip(page).locator('.tip-tbl').first().locator('td.n').allTextContents();
    expect(split.map(Number).reduce((a, b) => a + b, 0)).toBe(3);
    await expect(tip(page).locator('.tip-tbl').last().locator('tbody tr')).toHaveCount(3);
    await page.keyboard.press('Escape');
    await expect(tip(page)).toBeHidden();
    await expect(journey).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(journey).toBeHidden();
  });

  /** @covers packages/server/public/app/surfaces/journeys.js::jrnScreensTip */
  test('the business lens reads the same tip without the endpoint', async ({ page }) => {
    await openBillingCycle(page);
    await page.locator('#lb-business').click();
    const screens = page.locator('#jrn-count .jrn-screens');
    await expect(screens).toHaveText('3 screens');
    await screens.click();
    await expect(tip(page)).toBeVisible();
    await expect(tip(page)).toContainText('3 screens');
    await expect(tip(page)).toContainText(/sync \d+/);
    await expect(tip(page)).not.toContainText('/api/');
  });

  /**
   * @covers packages/server/public/app/surfaces/journeys.js::jrnUntrListTip
   * @covers packages/server/public/app/surfaces/journeys.js::jrnCountedTip
   */
  test('the conditions not in plain language are listed behind their number, in every lens, in words', async ({ page }) => {
    await openBillingCycle(page);
    for (const lens of ['business', 'hybrid', 'code']) {
      await page.locator('#lb-' + lens).click();
      const n = page.locator('#jrn-count .jrn-untrn');
      await expect(n).toBeVisible();
      const count = Number(((await n.textContent()) || '').match(/\d+/)![0]);
      expect(count).toBeGreaterThan(0);
      await n.click();
      await expect(tip(page)).toBeVisible();
      // the caption sits beside the table, not inside it — read the table that follows it
      const cap = tip(page).locator('.tip-cap', { hasText: 'where each one sits' });
      await expect(cap).toBeVisible();
      const table = cap.locator('xpath=following-sibling::table[1]');
      if (lens === 'business') {
        // folded by place and kind; the counts add up to the number, and no condition (code) is printed
        const ns = (await table.locator('td.n').allTextContents()).map(Number);
        expect(ns.reduce((a, b) => a + b, 0)).toBe(count);
      } else {
        await expect(table.locator('tbody tr')).toHaveCount(count);
      }
      // a define is read by people: no backticks, no markdown, no catalog key
      const text = (await tip(page).innerText());
      expect(text).not.toMatch(/`/);
      expect(text).not.toMatch(/\*\S[^*]*\*/);
      expect(text).not.toMatch(/\b(journey|count|tests|surf|tip)\.[a-zA-Z.]+/);
      await page.keyboard.press('Escape');
      await expect(tip(page)).toBeHidden();
    }
  });

  /**
   * @covers packages/server/public/app/lib/tooltip.js::initTips
   * @covers packages/server/public/app/strings.js::toggleRegister
   */
  test('a tip survives its trigger being redrawn, and speaks the new register', async ({ page }) => {
    await gotoReady(page, '#/portfolio');
    const register = () => page.evaluate(() => (window as any).S.register as string);
    if ((await register()) !== 'professional') await page.evaluate(() => (window as any).toggleRegister());
    await page.locator('.syncchip').click();
    const dialog = page.getByRole('dialog', { name: 'This graph' });
    await expect(dialog.getByRole('link', { name: 'Changes' })).toBeVisible();
    // the register flip redraws the chrome, sync chip included
    await page.evaluate(() => (window as any).toggleRegister());
    expect(await register()).toBe('hud');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Patch Notes' })).toBeVisible();
    await page.evaluate(() => (window as any).toggleRegister());
  });

  /** @covers packages/server/public/app/shell.js::fitTopbar */
  test('the ⋯ count names the controls it folded', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await gotoReady(page, '#/portfolio');
    const btn = page.locator('#morebtn');
    await expect(btn).toBeVisible();
    const n = Number(await btn.locator('.cnt').textContent());
    expect(n).toBeGreaterThan(0);
    await btn.focus();
    await page.keyboard.press('?');
    await expect(tip(page)).toBeVisible();
    await expect(tip(page)).toContainText(n + ' controls folded');
    await expect(tip(page).locator('.tip-tbl tbody tr')).toHaveCount(n);
    // the button itself still opens its menu; the tip gives way to it
    await page.keyboard.press('Escape');
    await btn.click();
    await expect(page.locator('#moremenu')).toHaveClass(/open/);
    await expect(tip(page)).toBeHidden();
  });

  /**
   * @covers packages/server/public/app/lib/tooltip.js::showTip
   * @covers packages/server/public/app/keymap.js::onKeydown
   */
  test('over the ⌘K palette a tip sits on top, and Esc closes it before the palette', async ({ page }) => {
    await gotoReady(page, '#/journeys');
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Search' });
    await expect(palette).toBeVisible();
    // the imperative form, for what a declarative trigger cannot express
    await page.evaluate(() => (window as any).showTip(document.getElementById('pinput'), '<div class="tip-h">x</div>', { pinned: true }));
    await expect(tip(page)).toBeVisible();
    const onTop = await page.evaluate(() => {
      const r = document.getElementById('fs-tip')!.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && !!hit.closest('#fs-tip');
    });
    expect(onTop, 'the tip is drawn above the palette').toBe(true);
    await page.keyboard.press('Escape');
    await expect(tip(page)).toBeHidden();
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
  });
});
