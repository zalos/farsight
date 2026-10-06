// One test verdict per cell (swarm 2026-10-05, finding 1): the word a test
// cell prints is computed once in core (`testVerdict`) and every surface prints
// it — the journey header, the Sheet's *Verified by*, the chip's tip, the Tests
// matrix and the Tests page a door opens. The swarm met *passed, by its own
// declaration* beside *their own last run: skipped* and a tip saying *verdict:
// unknown* on one action, and two doors to the tests that dropped their scope.
import { test, expect, gotoReady } from './support';

const FLOW = 'invoice-app::flow::new-invoice';
const tip = (page: import('@playwright/test').Page) => page.locator('#fs-tip');

test.describe('one test verdict per cell', () => {
  /**
   * @covers packages/server/public/app/surfaces/journeys.js::jrnTestsFootHtml
   * @covers packages/server/public/app/surfaces/journeys.js::jrnRunLineHtml
   * @covers packages/server/public/app/surfaces/tests.js::evidenceCellHtml
   * @covers packages/server/public/app/surfaces/tests.js::runsLineHtml
   * @covers GET /api/journey
   * @covers GET /api/tests
   */
  test('the journey\'s chip, its tip and the Tests matrix row say one verdict, and no run status sits beside it', async ({ page, request }) => {
    const j = await (await request.get('/api/journey?entry=' + encodeURIComponent(FLOW))).json();
    const verdict = j.summary.coverage.journey.verdict;
    expect(verdict.word.key).toBe('tests.evidence.declaredPassed');
    expect(verdict.status).toBe('passed');
    const t = await (await request.get('/api/tests?lean=1')).json();
    const row = t.journeys.find((r: { flowId: string }) => r.flowId === FLOW);
    // one fold: the matrix row's verdict is the journey's
    expect(row.coverage.verdict.word).toEqual(verdict.word);
    expect(row.coverage.verdict.runs.n).toBe(verdict.runs.n);

    await gotoReady(page, '#/journeys/' + encodeURIComponent(FLOW) + '?view=sheet');
    const head = page.locator('.jrn-e2e').first();
    await expect(head).toBeVisible();
    const word = (await head.textContent())!.trim();
    // the tip under the word names the run behind it — and that run's verdict is the word's
    await head.click();
    await expect(tip(page)).toBeVisible();
    await expect(tip(page)).toContainText(word);
    await expect(tip(page).locator('.tip-tbl')).toContainText('passed');
    await expect(tip(page).locator('.tip-tbl')).not.toContainText('unknown');
    await page.keyboard.press('Escape');

    // every Verified-by cell prints its word and a count of its cases' runs — never a run status beside the word
    const feet = page.locator('.jrn-scell .jrn-tfoot');
    expect(await feet.count()).toBeGreaterThan(0);
    await expect(page.locator('.jrn-tfoot .st')).toHaveCount(0);
    // the runs number is a count whose tip's parts add up to it
    const runs = page.locator('.jrn-runs .jrn-num').first();
    await runs.scrollIntoViewIfNeeded();
    const n = Number(((await runs.textContent()) ?? '').match(/\d+/)![0]);
    await runs.click();
    await expect(tip(page)).toBeVisible();
    const parts = (await tip(page).locator('.tip-tbl td.n').allTextContents()).map(Number);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(n);
    await page.keyboard.press('Escape');

    // the Tests matrix prints the same word for this journey, and no weakest-run chip beside it
    await page.goto('/#/tests');
    const mrow = page.locator('#tst-body table tbody tr').filter({ has: page.locator(`a[href="#/journeys/${encodeURIComponent(FLOW)}"]`) });
    await expect(mrow).toHaveCount(1);
    await expect(mrow.locator('td').nth(2).locator('.ev').first()).toHaveText(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    await expect(mrow.locator('td').nth(2).locator('.st')).toHaveCount(0);
  });

  /**
   * @covers packages/server/public/app/surfaces/journeys.js::jrnCasesHref
   * @covers packages/server/public/app/surfaces/tests.js::scopedHtml
   * @covers GET /api/tests
   */
  test('a cell\'s *open the list* keeps its scope: the Tests page opens on that cell\'s cases, with the cell\'s word', async ({ page, request }) => {
    await gotoReady(page, '#/journeys/' + encodeURIComponent(FLOW) + '?view=sheet');
    const foot = page.locator('.jrn-scell .jrn-tfoot').filter({ has: page.locator('.jrn-cases a') }).first();
    await foot.scrollIntoViewIfNeeded();
    const cellWord = (await foot.locator('.ev').first().textContent())!.trim();
    const href = (await foot.locator('.jrn-cases a').getAttribute('href'))!;
    expect(href).toMatch(/^#\/tests\?flow=[^&]+&seg=\d+&action=\d+$/);
    await foot.locator('.jrn-cases a').click();
    await expect(page).toHaveURL(/#\/tests\?flow=/);
    const scoped = page.locator('.tst-scoped');
    await expect(scoped).toBeVisible();
    await expect(scoped.locator('.ev').first()).toHaveText(cellWord);
    // the cases listed are the cases the cell counted
    const api = await (await request.get('/api/tests' + href.slice('#/tests'.length))).json();
    await expect(scoped.locator('li[data-case]')).toHaveCount(Math.min(200, api.cases.length));
    expect(api.coverage.verdict.runs.n).toBe(api.cases.filter((c: { runLevel: boolean }) => !c.runLevel).length);
    // and the matrix under it is that journey alone
    await expect(page.locator('#tst-body table.tst-table tbody tr')).toHaveCount(1);
    // the way back to every journey drops the scope
    await scoped.getByRole('link', { name: /every journey/i }).click();
    await expect(page.locator('.tst-scoped')).toHaveCount(0);
  });
});
