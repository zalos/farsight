// The ladder draws the systems an action uses — the action stop's `ladder` layout on the Map (lanes round 2026-10-10:
// the journey page's ladder band retired into it, one action at a time). The fixture's Billing cycle: *Invoice list*'s
// sixth action (change the line items again) reaches every system, and *Discard draft*'s one planned call reaches only
// the API. A screen's columns after the last one it uses
// fold into one end column that names each system with its absence word; a
// column it skips before or between the ones it uses stays in place, narrow.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';

const AT = (screen: number, action: number) => '#/map/' + encodeURIComponent('invoice-app::flow::billing-cycle') + '?screen=' + screen + '&action=' + action + '&layout=ladder&lens=hybrid';

async function headWidths(page: Page, seg: number) {
  return page.locator(`.jrn-laddercell[data-seg="${seg}"] .jrn-lhead > .lc`).evaluateAll((els) =>
    els.map((e) => ({ cls: e.className, w: e.getBoundingClientRect().width, text: (e.textContent || '').trim() })));
}

test.describe('journey ladder', () => {
  /**
   * @covers packages/server/public/app/lib/journey-model.js::ladderModel
   * @covers packages/server/public/app/lib/journey-draw.js::jrnLadderCellHtml
   * @covers packages/server/public/app/lib/journey-draw.js::jrnLadderColTip
   */
  test('an action that reaches one system folds the systems it never reaches into one end column', async ({ page }) => {
    await gotoReady(page, AT(3, 1));
    const discard = page.locator('.jrn-laddercell[data-seg="2"]');
    await expect(discard.locator('.jrn-lhead .lend')).toBeVisible();
    const heads = await headWidths(page, 2);
    // the API column it uses, the browser column before it kept narrow, then one end column
    const used = heads.filter((h) => !/\b(skip|lend)\b/.test(h.cls));
    expect(used).toHaveLength(1);
    expect(heads.filter((h) => /\bskip\b/.test(h.cls))).toHaveLength(1);
    expect(heads.filter((h) => /\blend\b/.test(h.cls))).toHaveLength(1);
    await expect(discard.locator('.jrn-lhead .lend')).toHaveText(/stops here/i);
    // the used column gets the room the empty lanes had
    expect(used[0].w).toBeGreaterThan(2 * heads.find((h) => /\blend\b/.test(h.cls))!.w);
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
    // on the Map a tip opens on hover (lib/tooltip.js, the Map's quick tips)
    await end.hover();
    await expect(page.locator('#fs-tip')).toContainText('Folded into this column');
    await expect(page.locator('#fs-tip')).toContainText('Messages');
  });

  /** @covers packages/server/public/app/lib/journey-draw.js::jrnLadderCellHtml */
  test('an action that reaches every system draws every column, equal, with nothing folded', async ({ page }) => {
    await gotoReady(page, AT(2, 6));
    // the ladder draws after the walk: read its columns once they are there
    await expect(page.locator('.jrn-laddercell[data-seg="1"] .jrn-lhead > .lc').first()).toBeVisible();
    const heads = await headWidths(page, 1);
    expect(heads.map((h) => h.text)).toEqual([
      expect.stringMatching(/screen asks/i), expect.stringMatching(/^API/), expect.stringMatching(/service does/i),
      expect.stringMatching(/records/i), expect.stringMatching(/messages/i),
    ]);
    expect(heads.some((h) => /\b(skip|lend)\b/.test(h.cls))).toBe(false);
    for (const h of heads) expect(Math.abs(h.w - heads[0].w)).toBeLessThan(2);
    // the beats are the stop's other layout, and the ladder leaves with them
    await page.keyboard.press('v');
    await expect(page.locator('.map-act .map-ladder')).toHaveCount(0);
    await expect(page.locator('.map-act #jrn-dlanes .jrn-bx').first()).toBeVisible();
  });
});
