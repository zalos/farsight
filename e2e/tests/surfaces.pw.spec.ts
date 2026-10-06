// The surfaces lane (pass swarm 2026-09-25): every number says what it counts
// and over what, the business register carries no code words, the tables use
// the window, Esc closes the menu it is meant for, and the light theme can be
// looked at without writing anyone's settings.
import type { Locator, Page } from '@playwright/test';
import { test, expect, gotoReady, openBillingCycle } from './support';

const tip = (page: Page) => page.locator('#fs-tip');

/**
 * Open a number's tip with a click and read its breakdown: the parts' numbers
 * and the number the trigger prints. The breakdown must add up to it.
 */
async function breakdownOf(page: Page, trigger: Locator): Promise<{ shown: number; parts: number[] }> {
  const shown = Number(((await trigger.textContent()) || '').match(/\d+/)?.[0]);
  await trigger.click();
  await expect(tip(page)).toBeVisible();
  await expect(tip(page).locator('.tip-tbl')).toBeVisible();
  const parts = (await tip(page).locator('.tip-tbl td.n').allTextContents()).map(Number);
  return { shown, parts };
}

// identifier-shaped tokens: what a business reader must never see
const ID_RES = [
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g, // camelCase
  /\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/g, // snake_case
  /\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|ya?ml|spec|test)\b/gi, // file names
  /\b[\w.-]+\/[\w.-]+\/[\w./-]+/g, // paths
  /\b[a-z]+:[a-z][\w-]*/g, // runner:vitest
  /\b(?:GET|POST|PUT|PATCH|DELETE)\b/g, // HTTP methods
  /\{[^}]+\}/g, // {id} placeholders
  /\bapi v\d+\b/g, // a route humanized
];

/** Every visible text node of the surface (and, on the code map, the chips, the map and the inspector), joined by spaces. */
async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const roots: Element[] = [];
    const s = document.getElementById('surface');
    if (s && s.style.display !== 'none') roots.push(s);
    if (document.body.classList.contains('surface-graph')) {
      for (const id of ['chips', 'stage', 'inspector']) { const e = document.getElementById(id); if (e) roots.push(e); }
    }
    const out: string[] = [];
    for (const r of roots) {
      const tw = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      while (tw.nextNode()) {
        const n = tw.currentNode;
        const el = n.parentElement;
        if (!el || !n.textContent?.trim()) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue;
        out.push(n.textContent);
      }
    }
    return out.join(' ');
  });
}
function identifiers(text: string): string[] {
  return ID_RES.flatMap((re) => [...text.matchAll(re)].map((m) => m[0]));
}

test.describe('numbers carry their scope', () => {
  /**
   * @covers packages/server/public/app/surfaces/tests.js::kpisHtml
   * @covers packages/server/public/app/lib/counted.js::countedHtml
   * @covers GET /api/tests
   */
  test('the Tests header number opens a tip whose breakdown adds up to it', async ({ page }) => {
    await gotoReady(page, '#/tests');
    const cases = page.locator('.tst-kpi .v .cnt-n').nth(1);
    await expect(cases).toBeVisible();
    const { shown, parts } = await breakdownOf(page, cases);
    expect(shown).toBeGreaterThan(0);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(shown);
    // what it counts, over what, from where
    await expect(tip(page)).toContainText('test cases');
    // unfiltered, the scope is every source in scope; under a level it is the selection
    await expect(tip(page)).toContainText('across every source in scope');
    await expect(tip(page)).toContainText(/\/api\/tests · sync \d+/);
  });

  /**
   * @covers packages/server/public/app/surfaces/portfolio.js::testCountsHtml
   * @covers GET /api/tests
   */
  test('a Portfolio test count opens a tip whose breakdown adds up to it', async ({ page }) => {
    await gotoReady(page, '#/portfolio');
    // the Tested column's first count: its breakdown is the three evidence classes
    const count = page.locator('#pf-body tr td:nth-child(4) .pf-sub .cnt-n').first();
    await expect(count).toBeVisible({ timeout: 15_000 });
    const { shown, parts } = await breakdownOf(page, count);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(shown);
    await expect(tip(page)).toContainText('across this journey');
  });

  /**
   * @covers packages/server/public/app/surfaces/tests.js::countsLineHtml
   * @covers packages/server/public/app/surfaces/tests.js::sourcesHtml
   * @covers GET /api/tests
   */
  test('the E2E filter moves every count on the page, and says what the unfiltered total is', async ({ page, request }) => {
    const api = await (await request.get('/api/tests?scope=all&level=e2e')).json();
    const all = await (await request.get('/api/tests?scope=all')).json();
    await gotoReady(page, '#/tests?level=e2e');
    await expect(page.locator('.tst-kpis')).toBeVisible();
    const e2e = api.counts.cases as number;
    expect(e2e).toBeLessThan(all.counts.cases);
    // the strip, the tile and the cards all count the e2e selection
    await expect(page.locator('.tst-strip .counts').first()).toContainText(`${e2e} test cases`);
    await expect(page.locator('.tst-kpi .v .cnt-n').nth(1)).toHaveText(String(e2e));
    const cardCases = await page.locator('.tst-card .sub .cnt-n', { hasText: 'test cases' }).allTextContents();
    expect(cardCases.map((x) => Number(x.match(/\d+/)?.[0])).reduce((a, b) => a + b, 0)).toBe(e2e);
    // the one unfiltered number on a filtered page is named as such
    await expect(page.locator('.tst-strip .counts.all')).toHaveText(`of ${all.counts.cases} at every level`);
  });

  /**
   * @covers packages/server/public/app/surfaces/tests.js::verdictLineHtml
   * @covers packages/server/public/app/surfaces/tests.js::suitesHtml
   */
  test('a source card leads with whether it passed, and the suites carry their source', async ({ page }) => {
    await gotoReady(page, '#/tests?view=suites&level=e2e');
    const card = page.locator('.tst-card').first();
    await expect(card.locator('.tst-verdict')).toBeVisible();
    await expect(card.locator('.tst-verdict')).toContainText(/\d+ (passed|failed|flaky|skipped|with no run recorded)/);
    await expect(page.locator('.tst-suites th').first()).toHaveText(/source/i);
    await expect(page.locator('.tst-suites td.src').first()).toHaveText('invoice-app');
  });
});

test.describe('the business register', () => {
  // each surface, and the element that says it has drawn its answer
  const SURFACES: [string, string][] = [
    ['#/portfolio', '#pf-body table'], ['#/apis', '.api-card'], ['#/tests', '.tst-kpis'], ['#/tests?view=suites', '.tst-suites'],
    ['#/changes', '.ch-table'], ['#/codemap?node=invoice-app%3A%3Asrc%2Fserver%2FtaxEngine.ts%3A%3AcomputeTax', '#inspector h2'],
  ];
  for (const [hash, ready] of SURFACES) {
    /**
     * @covers packages/server/public/app/store.js::bizName
     * @covers packages/server/public/app/store.js::unCode
     */
    test(`no identifier on ${hash} in business`, async ({ page }) => {
      await gotoReady(page, hash + (hash.includes('?') ? '&' : '?') + 'lens=business');
      await expect(page.locator('body')).toHaveClass(/lens-business/);
      await expect(page.locator(ready).first()).toBeVisible({ timeout: 15_000 });
      // let the progressive fills land (Portfolio's per-flow cells, the measured difference)
      await expect(page.locator('#surface')).not.toContainText('reading…', { timeout: 15_000 });
      const found = identifiers(await visibleText(page));
      expect(found, 'identifier-shaped tokens a business reader would see').toEqual([]);
    });
  }

  /**
   * The front door's persona, group and journey descriptions are words somebody wrote:
   * the business register reads them through plainWords (swarm 2026-10-05, the product owner).
   * @covers packages/server/public/app/strings.js::proseHtml
   * @covers packages/server/public/app/strings.js::plainWords
   */
  test('no identifier in the front door\'s descriptions in business', async ({ page }) => {
    await gotoReady(page, '#/journeys?lens=business');
    await expect(page.locator('body')).toHaveClass(/lens-business/);
    await expect(page.locator('.dsg-flow-desc').first()).toBeVisible({ timeout: 15_000 });
    const text = (await page.locator('.dsg-flow-desc').allInnerTexts()).join(' ');
    expect(identifiers(text), 'identifier-shaped tokens in a description').toEqual([]);
    expect(text, 'no raw backticks').not.toContain('`');
  });

  /**
   * @covers packages/server/public/app/shell.js::searchNodes
   * @covers packages/server/public/app/shell.js::renderPalette
   * @covers packages/server/public/app/shell.js::travelTarget
   */
  test('⌘K matches an exact identifier, shows the business name, and arrives', async ({ page }) => {
    await gotoReady(page, '#/portfolio?lens=business');
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Search' });
    await page.keyboard.type('approveInvoice');
    const first = palette.locator('.presult').first();
    // a gate: the palette used to leave gates out, so its exact name found nothing
    await expect(first).toContainText('Approver role');
    await expect(first).not.toContainText('approveInvoice');
    await page.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    // the gate is a badge on the route it guards, which the business register reads as a journey
    await expect(page).toHaveURL(/#\/journeys\/invoice-app%3A%3Aroute%3A%3APOST/);
    await expect(page.getByRole('button', { name: /exit focus/ })).toBeHidden();
  });

  /**
   * @covers packages/server/public/app/shell.js::searchNodes
   * @covers packages/server/public/app/shell.js::renderPalette
   */
  test('⌘K keeps both names in hybrid: the business name and the identifier', async ({ page }) => {
    await gotoReady(page, '#/portfolio');
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('approveInvoice');
    const first = page.getByRole('dialog', { name: 'Search' }).locator('.presult').first();
    await expect(first.locator('.pname')).toContainText('Approver role');
    await expect(first.locator('.pid')).toContainText('approveInvoice');
  });
});

test.describe('the window', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });
  for (const [hash, sel] of [['#/portfolio', '#pf-body table'], ['#/apis', '.api-grid'], ['#/changes', '.ch-table'], ['#/tests', '.tst-table']] as const) {
    /**
     * @covers packages/server/public/app/surfaces/portfolio.js::mountPortfolio
     * @covers packages/server/public/app/surfaces/apis.js::mountApis
     * @covers packages/server/public/app/surfaces/changes.js::mountChanges
     */
    test(`${hash} takes at least 90% of a 1920 window`, async ({ page }) => {
      await gotoReady(page, hash);
      await expect(page.locator(sel).first()).toBeVisible({ timeout: 15_000 });
      // polled: the Portfolio redraws its table as each flow's cells fill in
      await expect.poll(async () => (await page.locator(sel).first().boundingBox())?.width || 0).toBeGreaterThanOrEqual(0.9 * 1920);
    });
  }

  /** @covers packages/server/public/app/surfaces/changes.js::spineRowHtml */
  test('the Changes WHEN column never breaks a timestamp', async ({ page }) => {
    await gotoReady(page, '#/changes');
    const when = page.locator('.ch-table td.when').first();
    await expect(when).toBeVisible();
    // one line box for the whole timestamp: it used to break as `2026-09-25 05:0` / `3`
    const lines = await when.evaluate((e) => { const r = document.createRange(); r.selectNodeContents(e); return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size; });
    expect(lines).toBe(1);
  });
});

test.describe('chrome', () => {
  /**
   * @covers packages/server/public/app/shell.js::scopeMenuKey
   * @covers packages/server/public/app/shell.js::toggleScopeMenu
   */
  test('Esc with the scope menu open closes the menu, and only the menu', async ({ page }) => {
    await openBillingCycle(page);
    const journey = page.getByRole('dialog', { name: 'Journey', exact: true });
    await page.locator('#scopebtn').click();
    await expect(page.locator('#scopemenu')).toHaveClass(/open/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#scopemenu')).not.toHaveClass(/open/);
    await expect(journey).toBeVisible();
    await expect(page.locator('#scopebtn')).toHaveAttribute('aria-expanded', 'false');
    // the next Esc is the journey's again
    await page.keyboard.press('Escape');
    await expect(journey).toBeHidden();
  });

  /**
   * @covers packages/server/public/app/shell.js::applyRoute
   * @covers packages/server/public/app/shell.js::dropFocus
   */
  test('closing a journey leaves no focus behind on the surface it returns to', async ({ page }) => {
    await openBillingCycle(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Journey', exact: true })).toBeHidden();
    await expect(page).toHaveURL(/#\/journeys$/);
    // it used to read `focus: …` in the search box, wear an *exit focus* chip and cut the status bar
    await expect(page.getByRole('button', { name: /exit focus/ })).toBeHidden();
    await expect(page.locator('#searchlabel')).not.toHaveText(/focus:/);
    await expect(page.locator('#stats')).not.toHaveText(/focus:/);
  });

  /**
   * @covers packages/server/public/app/shell.js::previewTheme
   * @covers packages/server/public/app/shell.js::applyTheme
   */
  test('the light theme can be previewed without writing the shared settings', async ({ page }) => {
    const writes: string[] = [];
    await page.route('**/*', (r) => {
      if (r.request().method() !== 'GET') { writes.push(r.request().method() + ' ' + r.request().url()); return r.abort(); }
      return r.continue();
    });
    await gotoReady(page, '#/portfolio');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.evaluate(() => (window as unknown as { openSettings: () => void }).openSettings());
    await page.locator('#set-theme').selectOption('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('#set-theme-note')).toContainText('previewing');
    expect(writes).toEqual([]);
  });

  /** @covers packages/server/public/app/shell.js::applyTheme */
  test('with no theme saved, the viewer follows the system\'s colour scheme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.route('**/api/settings', async (r) => {
      const res = await r.fetch();
      const s = await res.json();
      delete s.theme;
      await r.fulfill({ response: res, json: s });
    });
    await gotoReady(page, '#/portfolio');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
