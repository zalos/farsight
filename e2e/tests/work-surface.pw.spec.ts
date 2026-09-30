// The WORK surface: the trackers' source cards, the item list and its filters,
// the board, the business register, a failing /api/work and a read-only source.
// The /api/work answers come from work-stub.ts (the work-api.md contract over the
// recorded invoice-app tracker) until the server lane's routes serve them.
import type { Page } from '@playwright/test';
import { test, expect } from './support';
import { routeWork, routeWorkSettings } from './work-stub';

const ID_RES = [
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g, // camelCase
  /\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/g, // snake_case
  /\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|ya?ml|spec|test)\b/gi, // file names
  /\b[\w.-]+\/[\w.-]+\/[\w./-]+/g, // paths
  /\b(?:GET|POST|PUT|PATCH|DELETE)\b/g, // HTTP methods
  /\b[A-Z][A-Z0-9]+-\d+\b/g, // a tracker's key (INV-6)
  /\bwork::/g, // a work item's node id
  /\b[0-9a-f]{7,40}\b/g, // a commit sha
];

/** The surface's visible text, joined — what a business reader actually sees. */
async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const out: string[] = [];
    const tw = document.createTreeWalker(document.getElementById('surface')!, NodeFilter.SHOW_TEXT);
    while (tw.nextNode()) {
      const n = tw.currentNode;
      const el = n.parentElement;
      if (!el || !n.textContent?.trim()) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue;
      out.push(n.textContent);
    }
    return out.join(' ');
  });
}
const identifiers = (text: string) => ID_RES.flatMap((re) => [...text.matchAll(re)].map((m) => m[0]));

test.describe('work surface', () => {
  test.beforeEach(async ({ page }) => {
    await routeWorkSettings(page);
    await routeWork(page);
  });

  /**
   * @covers packages/server/public/app/surfaces/work.js::mountWork
   * @covers GET /api/work
   */
  test('the list draws every item with its state, the source cards and the counts', async ({ page }) => {
    await page.goto('/#/work');
    await expect(page.locator('.wk-table tbody tr')).toHaveCount(11);
    await expect(page.locator('.wk-card')).toHaveCount(2);
    await expect(page.locator('.wk-strip .counts')).toContainText('11 work items');
    await expect(page.locator('.wk-strip .counts')).toContainText('2 trackers');
    // the colour never stands alone: the category word and the tracker's own name sit beside it
    const erp = page.locator('tr[data-item="work::invoice-azdo::4711"]');
    await expect(erp.locator('.wk-state')).toContainText('in progress');
    await expect(erp.locator('.wk-state')).toContainText('Active');
    // the freshness sentence, never a bare timestamp
    await expect(page.locator('.wk-card[data-source="invoice-jira"]')).toContainText('synced 3 minutes ago');
    await expect(page.locator('.wk-card[data-source="invoice-azdo"]')).toContainText(/source unreachable since .* showing the cache/);
    await expect(page.locator('.wk-card[data-source="invoice-azdo"] .wk-mode')).toHaveText(/read-only/i);
  });

  /** @covers packages/server/public/app/surfaces/work.js::workFilter */
  test('filters ask the server again and the link carries them', async ({ page }) => {
    await page.goto('/#/work');
    await expect(page.locator('.wk-table tbody tr')).toHaveCount(11);
    const asked = page.waitForRequest((r) => /\/api\/work\?.*state=done/.test(r.url()));
    await page.locator('.wk-cats').getByRole('button', { name: 'done', exact: true }).click();
    await asked;
    await expect(page).toHaveURL(/#\/work\?state=done/);
    await expect(page.locator('.wk-table tbody tr')).toHaveCount(4);
    await expect(page.locator('.wk-table .wk-state.done')).toHaveCount(4);

    await page.goto('/#/work?source=invoice-azdo');
    await expect(page.locator('.wk-table tbody tr')).toHaveCount(2);

    await page.goto('/#/work');
    await expect(page.locator('.wk-table tbody tr')).toHaveCount(11);
    await page.getByRole('searchbox', { name: 'search titles and keys' }).fill('tax');
    await expect(page.locator('.wk-table tbody tr')).toHaveCount(1);
    await expect(page).toHaveURL(/q=tax/);
    await expect(page.getByRole('searchbox', { name: 'search titles and keys' })).toBeFocused();
  });

  /** @covers packages/server/public/app/surfaces/work.js::mountWork */
  test('the board puts every item in the column of where it stands', async ({ page }) => {
    await page.goto('/#/work?view=board');
    await expect(page.locator('.wk-col')).toHaveCount(4);
    await expect(page.locator('.wk-col[data-cat="done"] .wk-tile')).toHaveCount(4);
    await expect(page.locator('.wk-col[data-cat="todo"] .wk-tile')).toHaveCount(3);
    await page.locator('.wk-col[data-cat="done"] .wk-tile').first().click();
    await expect(page).toHaveURL(/#\/work\/work/);
    await expect(page.locator('.wk-pane')).toBeVisible();
  });

  /** @covers packages/server/public/app/surfaces/work.js::mountWork */
  test('the business register prints titles and tracker words — no key, id, sha or identifier', async ({ page }) => {
    for (const hash of ['#/work?lens=business', '#/work?view=board&lens=business', '#/work?view=sources&lens=business',
      '#/work/' + encodeURIComponent('work::invoice-jira::INV-2') + '?lens=business', '#/work/' + encodeURIComponent('work::invoice-jira::INV-6') + '?lens=business']) {
      await page.goto('/' + hash);
      await expect(page.locator('.wk-table, .wk-board, .wk-pane, .wk-sec').first()).toBeVisible();
      await page.waitForTimeout(150);
      expect(identifiers(await visibleText(page)), `identifier-shaped tokens on ${hash}`).toEqual([]);
    }
    // the hybrid register adds the key
    await page.goto('/#/work?lens=hybrid');
    await expect(page.locator('tr[data-item="work::invoice-jira::INV-6"] .wk-key')).toHaveText('INV-6');
  });

  /** @covers packages/server/public/app/surfaces/work.js::workSync */
  test('sync now posts to the work sync and reads the page again', async ({ page }) => {
    await page.goto('/#/work');
    await expect(page.locator('.wk-table tbody tr')).toHaveCount(11);
    const post = page.waitForRequest((r) => r.url().endsWith('/api/work/sync') && r.method() === 'POST');
    await page.locator('.wk-strip .wk-syncbtn').click();
    await post;
    await expect(page.locator('.wk-card[data-source="invoice-jira"]')).toContainText('synced just now');
  });

  /** @covers packages/server/public/app/surfaces/work.js::paneHtml */
  test('a read-only source draws no edit controls and says read-only once', async ({ page }) => {
    await page.goto('/#/work/' + encodeURIComponent('work::invoice-azdo::4711'));
    await expect(page.locator('.wk-pane')).toBeVisible();
    await expect(page.locator('#wk-readonly')).toHaveCount(1);
    await expect(page.locator('[data-action]')).toHaveCount(0);
    await expect(page.locator('#wk-comment-in')).toHaveCount(0);
  });

  /** @covers packages/server/public/app/surfaces/work.js::workTravel */
  test('⌘K sends a work item to its pane', async ({ page }) => {
    await page.goto('/#/work');
    await expect(page.locator('.wk-table')).toBeVisible();
    const hash = await page.evaluate(() => (window as unknown as { travelTarget: (n: object) => { hash: string } })
      .travelTarget({ kind: 'work', id: 'work::invoice-jira::INV-2', name: 'Start a new invoice' }).hash);
    expect(hash).toBe('#/work/' + encodeURIComponent('work::invoice-jira::INV-2'));
  });
});

test.describe('a failing /api/work', () => {
  test.use({ expectedHttpErrors: [/\/api\/work\?|\/api\/work$/] });

  /**
   * @covers packages/server/public/app/surfaces/work.js::workRetry
   * @covers GET /api/work
   */
  test('the surface says it could not load, shows the status, and recovers on retry', async ({ page }) => {
    await routeWorkSettings(page);
    await routeWork(page);
    const fail = /\/api\/work$/;
    await page.route(fail, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'injected by e2e' }) }));
    await page.goto('/#/work');
    const err = page.locator('.wk-err');
    await expect(err).toContainText('Could not load the work items.');
    await expect(err).toContainText('500');
    await expect(err).toContainText('injected by e2e');
    await expect(page.locator('.wk-table')).toHaveCount(0);
    await page.unroute(fail);
    await err.getByRole('button', { name: 'ask again' }).click();
    await expect(page.locator('.wk-table tbody tr')).toHaveCount(11);
  });
});
