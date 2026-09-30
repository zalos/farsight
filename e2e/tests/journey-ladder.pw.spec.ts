// The ladder draws the systems a screen uses. The fixture's Billing cycle has
// three screens: *New invoice* reaches everything but the messages, *Invoice
// list* reaches every system, and *Discard draft* (0 actions — one planned
// call) reaches only the API. A screen's columns after the last one it uses
// fold into one end column that names each system with its absence word; a
// column it skips before or between the ones it uses stays in place, narrow.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';

const LADDER = '#/journeys/invoice-app::flow::billing-cycle?view=timeline&band=ladder&lens=hybrid';

/** The old ladder gave every system an equal share: 150 + 172 per system, minus the 32 px padding and the time column. */
const oldShare = (systems: number) => (150 + systems * 172 - 32 - 150) / systems;

async function headWidths(page: Page, seg: number) {
  return page.locator(`.jrn-laddercell[data-seg="${seg}"] .jrn-lhead > .lc`).evaluateAll((els) =>
    els.map((e) => ({ cls: e.className, w: e.getBoundingClientRect().width, text: (e.textContent || '').trim() })));
}

test.describe('journey ladder', () => {
  /**
   * @covers packages/server/public/app/surfaces/journeys.js::jrnLadderModel
   * @covers packages/server/public/app/surfaces/journeys.js::jrnLadderCellHtml
   * @covers packages/server/public/app/surfaces/journeys.js::jrnLadderColTip
   */
  test('a screen with no actions folds the systems it never reaches into one end column', async ({ page }) => {
    await gotoReady(page, LADDER);
    const full = page.locator('.jrn-laddercell[data-seg="1"]');
    await expect(full).toBeVisible();
    const systems = (await headWidths(page, 1)).length;
    expect(systems).toBe(5);

    const discard = page.locator('.jrn-laddercell[data-seg="2"]');
    const heads = await headWidths(page, 2);
    // the API column it uses, the browser column before it kept narrow, then one end column
    const used = heads.filter((h) => !/\b(skip|lend)\b/.test(h.cls));
    expect(used).toHaveLength(1);
    expect(heads.filter((h) => /\bskip\b/.test(h.cls))).toHaveLength(1);
    expect(heads.filter((h) => /\blend\b/.test(h.cls))).toHaveLength(1);
    await expect(discard.locator('.jrn-lhead .lend')).toHaveText(/stops here/i);
    // the used column gets the room the empty lanes had
    expect(used[0].w).toBeGreaterThanOrEqual(2 * oldShare(systems));
    // the end column names each system it folds, with the absence word
    const list = discard.locator('.lend-list .le');
    await expect(list).toHaveCount(3);
    await expect(discard.locator('.lend-list')).toContainText('Records');
    await expect(discard.locator('.lend-list')).toContainText('Messages');
    await expect(list.locator('.le-w')).toHaveText(['not involved', 'not involved', 'not involved']);
    // and its tip says what the column stands for
    // (scrolled there first: a tip closes when what holds its trigger scrolls)
    const end = discard.locator('.jrn-lhead .lend');
    await end.scrollIntoViewIfNeeded();
    await expect(end).toBeInViewport();
    await end.click();
    await expect(page.locator('#fs-tip')).toContainText('Folded into this column');
    await expect(page.locator('#fs-tip')).toContainText('Messages');
  });

  /** @covers packages/server/public/app/surfaces/journeys.js::jrnLadderCellHtml */
  test('a screen that reaches every system draws every column as before', async ({ page }) => {
    await gotoReady(page, LADDER);
    const heads = await headWidths(page, 1);
    expect(heads.map((h) => h.text)).toEqual([
      expect.stringMatching(/screen asks/i), expect.stringMatching(/^API/), expect.stringMatching(/service does/i),
      expect.stringMatching(/records/i), expect.stringMatching(/messages/i),
    ]);
    expect(heads.some((h) => /\b(skip|lend)\b/.test(h.cls))).toBe(false);
    for (const h of heads) expect(Math.abs(h.w - oldShare(heads.length))).toBeLessThan(2);
    // the rows band is untouched by the ladder's columns
    await page.locator('#jrn-title').click();
    await page.keyboard.press('l');
    await expect(page.locator('#jrn-tl .jrn-ladder')).toHaveCount(0);
    await expect(page.locator('#jrn-tl .jrn-momrow').first()).toBeVisible();
  });
});
