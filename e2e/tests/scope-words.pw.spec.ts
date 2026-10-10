// Every test number carries its scope (round 2026-10-10, proposal 4; swarm round 2,
// findings 1.1–1.4, 1.6–1.11). One screen read *323 cases · passed* on the Map,
// *no test reaches this part · 125 reach the action* in the drawer, *2 tests* on
// impact and *16* on the gate card — four true numbers over four scopes, none named.
// This walk holds every surface to the rule: each test chip in view prints the words
// of the scope it counts over, the skips show whenever they are not zero, and a
// designed, not-built screen never wears *passed*.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';

const FLOW = 'invoice-app::flow::billing-cycle';
const PAGE = { list: 'invoice-app::page::/invoices', discard: 'invoice-app::page::/invoices/:param/discard' };

/** Every test chip in view, each with its scope words (or the not-built mark), its skip part and whether it says *passed*. */
async function chips(page: Page, within: string) {
  return page.locator(within + ' [data-tchip]').evaluateAll((els) => els
    .filter((el) => (el as HTMLElement).offsetParent !== null)
    .map((el) => ({
      text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      scope: (el.querySelector('.tc-scope') && (el.querySelector('.tc-scope')!.textContent || '').trim()) || '',
      notBuilt: el.hasAttribute('data-not-built'),
      skipped: el.querySelector('[data-run-part="skipped"]') ? (el.querySelector('[data-run-part="skipped"]')!.textContent || '').trim() : '',
    })));
}

/** A chip's scope, or the not-built mark; never a bare number. */
function heldToScope(list: { text: string; scope: string; notBuilt: boolean }[], where: string) {
  expect(list.length, `${where}: no test chip in view`).toBeGreaterThan(0);
  for (const c of list) {
    expect(c.notBuilt || /^over /.test(c.scope), `${where}: a test number without its scope — “${c.text}”`).toBe(true);
    if (c.notBuilt) expect(c.text, `${where}: a not-built screen wearing a verdict`).not.toMatch(/passed|verified/i);
  }
}

/** The skips each scope's fold counts, from the same answer the page drew. */
async function skippedBySegment(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const cov = (window as any).S.JOURNEY.summary.coverage;
    return cov.segments.map((s: any) => (s.verdict && s.verdict.skipped) || 0);
  });
}

test.describe('every test number carries its scope', () => {
  /**
   * @covers packages/server/public/app/lib/test-chip.js::testChipHtml
   * @covers packages/server/public/app/lib/test-chip.js::notBuiltChipHtml
   * @covers packages/server/public/app/lib/test-chip.js::distinctArgs
   * @covers packages/server/public/app/surfaces/journeys.js::jrnTestsFootHtml
   * @covers GET /api/journey
   */
  test('the journey header and the storyboard: a scope on every chip, the skips shown, the not-built screen never passed', async ({ page }) => {
    await gotoReady(page, '#/journeys/' + encodeURIComponent(FLOW) + '?view=storyboard&lens=hybrid');
    await expect(page.locator('#journey .jrn-htests')).toBeVisible();
    // the header: the journey's cases, *over this journey*, *distinct* beside the per-screen counts below it
    const head = page.locator('#journey .jrn-htests');
    await expect(head.locator('.tc-scope')).toHaveText('over this journey');
    await expect(head.locator('.tc-distinct')).toHaveText('distinct');
    await head.locator('.tc-distinct').click();
    await expect(page.locator('#fs-tip')).toContainText('per screen');
    await expect(page.locator('#fs-tip')).toContainText('test cases');
    await page.keyboard.press('Escape');
    heldToScope(await chips(page, '#journey .jrn-hg'), 'the header');
    // the storyboard's cards: each screen's cases over this screen, and the skips wherever its fold counts some
    const cards = await chips(page, '#journey .jrn-cfoot');
    heldToScope(cards, 'the storyboard');
    expect(cards.some((c) => c.scope === 'over this screen')).toBe(true);
    const skips = await skippedBySegment(page);
    const built = cards.filter((c) => !c.notBuilt);
    skips.filter((n, i) => i < built.length).forEach((n, i) => {
      if (n > 0) expect(built[i]!.skipped, `screen ${i + 1}: ${n} skipped hidden behind its word`).toBe(n + ' skipped');
    });
    // the designed, not-built screen: no verdict, the sentence that says why
    const nb = page.locator('#journey .jrn-cfoot [data-not-built]');
    await expect(nb).toHaveCount(1);
    await expect(nb).toContainText('designed, not built');
    await expect(nb).toContainText('no test can reach a screen with no code');
    await expect(nb).not.toContainText(/passed/i);
  });

  /**
   * @covers packages/server/public/app/surfaces/map-property.js::mountMapProperty
   * @covers packages/server/public/app/lib/map-property-model.js::testsScopeLine
   * @covers GET /api/journey
   */
  test('the Map property: the headline chip over this screen, one sentence of scopes, the case rows in the evidence words', async ({ page }) => {
    await gotoReady(page, '#/portfolio?lens=hybrid');
    await page.evaluate(() => {
      const S = (window as any).S;
      S.SETTINGS = Object.assign({}, S.SETTINGS, { flags: Object.assign({}, S.SETTINGS && S.SETTINGS.flags, { map: true }) });
    });
    const open = async (node: string) => {
      await page.evaluate(([flow, n]) => { location.hash = '#/map/' + encodeURIComponent(flow) + '?node=' + encodeURIComponent(n); }, [FLOW, node]);
      await expect(page.locator('.mp')).toHaveAttribute('data-screen', node);
      await page.locator('#mp-tab-tests').click();
      await expect(page.locator('#mp-tab-tests')).toHaveAttribute('aria-selected', 'true');
    };
    await open(PAGE.list);
    const list = await chips(page, '.mp-body');
    heldToScope(list, 'the property');
    expect(list[0]!.scope).toBe('over this screen');
    await expect(page.locator('.mp-body .mp-scope-line')).toContainText('over the page’s own code');
    // the not-built screen of the same journey is named as one no test is known to reach
    await expect(page.locator('.mp-body .mp-none-known')).toContainText('no test is known to reach');
    // the case rows print evidence words — never the tab's old labels
    const words = await page.locator('.mp-body .mp-row[data-map-card="test"] .mp-ev').allTextContents();
    expect(words.length).toBeGreaterThan(0);
    for (const w of words) expect(w.trim()).toMatch(/^(declared only|reached by tests|verified by a run|verified · stale|passed, by its own declaration( · stale)?|seen by a coverage run( · stale)?)$/i);
    await open(PAGE.discard);
    const nb = await chips(page, '.mp-body');
    heldToScope(nb, 'the not-built property');
    expect(nb.every((c) => c.notBuilt)).toBe(true);
  });

  /**
   * @covers packages/server/public/app/surfaces/tests.js::matrixHtml
   * @covers packages/server/public/app/surfaces/tests.js::evidenceCellHtml
   * @covers GET /api/tests
   * @covers GET /api/tests/matrix
   */
  test('the Tests page: every matrix cell over this journey, the level filter filters the rows, the CSV says the screen’s words', async ({ page, request }) => {
    await gotoReady(page, '#/tests?view=matrix');
    await expect(page.locator('.tst-table')).toBeVisible();
    heldToScope(await chips(page, '.tst-table'), 'the matrix');
    const all = await page.locator('.tst-table tbody tr').count();
    // unit: the rows are that level's — no e2e case behind any row's word — and the journeys no unit case reaches are left out and counted
    await gotoReady(page, '#/tests?view=matrix&level=unit');
    await expect(page.locator('.tst-table')).toBeVisible();
    const lv = await (await request.get('/api/tests?lean=1&level=unit')).json();
    expect(lv.journeys.length).toBeGreaterThan(0);
    for (const r of lv.journeys) expect(r.coverage.counted.e2e.n, `${r.name}: an e2e case under the unit filter`).toBe(0);
    await expect(page.locator('.tst-table tbody tr')).toHaveCount(lv.journeys.length);
    // the e2e column would say *no e2e* of every row: under a unit filter it is not drawn
    await expect(page.locator('.tst-table thead th', { hasText: /end-to-end evidence/i })).toHaveCount(0);
    if (lv.journeysLeftOut) await expect(page.locator('[data-left-out]')).toHaveAttribute('data-left-out', String(lv.journeysLeftOut));
    expect(lv.journeys.length + (lv.journeysLeftOut || 0)).toBe(all);
    // the CSV: the two appended columns are the screen's words
    const csv = await (await request.get('/api/tests/matrix?format=csv')).text();
    const [header, ...lines] = csv.split('\n');
    const cols = header!.split(',');
    expect(cols.slice(-2)).toEqual(['evidence_word', 'verdict']);
    expect(lines.some((l) => l.includes('passed, by its own declaration'))).toBe(true);
  });
});
