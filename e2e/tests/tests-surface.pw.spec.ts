// The Tests surface: the journeys × tests matrix and the suites behind it.
import { test, expect } from './support';

test.describe('tests surface', () => {
  /**
   * @covers packages/server/public/app/surfaces/tests.js::mountTests
   * @covers GET /api/tests
   */
  test('the matrix has one row per journey with its end-to-end evidence', async ({ page }) => {
    await page.goto('/#/tests');
    const matrix = page.locator('#tst-body table').first();
    await expect(matrix).toBeVisible();
    // rows name the flow by id too; a row's text also names the flows it shares tests with
    for (const flow of ['billing-cycle', 'draft-and-send', 'new-invoice']) {
      await expect(matrix.getByRole('row').filter({ hasText: `invoice-app::flow::${flow}` })).toHaveCount(1);
    }
    // a declared e2e case the report says passed earns observed for what it declares, and says so
    await expect(matrix.getByRole('row').filter({ hasText: 'invoice-app::flow::billing-cycle' })).toContainText(/e2e observed/i);
    await expect(matrix.getByRole('row').filter({ hasText: 'invoice-app::flow::new-invoice' })).toContainText('passed, by its own declaration');
    // a flow whose only e2e case failed or was flaky keeps the body's rung
    await expect(matrix.getByRole('row').filter({ hasText: 'invoice-app::flow::draft-and-send' })).toContainText(/e2e reached/i);
    await expect(page.getByText('TESTS INDEXED', { exact: false }).first()).toBeVisible();
  });

  /** @covers packages/server/public/app/surfaces/tests.js::mountTests */
  test('Suites lists the spec files with their runner and last run; the e2e filter narrows to playwright', async ({ page }) => {
    await page.goto('/#/tests');
    await page.getByRole('button', { name: 'Suites', exact: true }).click();
    await expect(page).toHaveURL(/suites/);
    await expect(page.locator('#tst-body')).toContainText('e2e/billing.pw.spec.ts');
    await expect(page.locator('#tst-body')).toContainText('test/invoiceService.test.ts');
    await page.getByRole('button', { name: 'e2e', exact: true }).click();
    await expect(page.locator('#tst-body')).toContainText('e2e/billing.pw.spec.ts');
    await expect(page.locator('#tst-body')).not.toContainText('test/invoiceService.test.ts');
  });

  /**
   * @covers packages/server/public/app/surfaces/tests.js::declaredLineHtml
   * @covers GET /api/tests
   */
  test('the e2e source card says why its passed cases are not a journey\'s number', async ({ page, request }) => {
    // the fixture: new-invoice.pw.spec.ts declares new-invoice and INV-02; one case passed, one failed
    const d = await (await request.get('/api/tests?level=e2e')).json();
    const card = d.sources.find((s: { level: string }) => s.level === 'e2e');
    expect(card.runs.passed).toBe(1);
    expect(card.counted.passedByDeclaration.n).toBe(1);
    expect(card.counted.passedByDeclaration.breakdown.map((p: { key: string; n: number }) => [p.key, p.n])).toEqual([
      ['count.part.declaresKnown', 1], ['count.part.declaresUnmatched', 0], ['count.part.declaresNothing', 0],
    ]);
    const row = d.journeys.find((j: { flowId: string }) => j.flowId === 'invoice-app::flow::new-invoice');
    expect(row.coverage.observedBy).toBe('declaration');
    expect(row.coverage.evidenceWord.key).toBe('tests.evidence.declaredPassed');
    expect(row.coverage.counted.e2e.breakdown.find((p: { key: string }) => p.key === 'count.part.declaredPassed').n).toBe(1);
    // the failed case stays declared only
    expect(row.declared.map((t: { name: string }) => t.name)).toContain('a draft with no line items is refused');

    await page.goto('/#/tests?level=e2e');
    const decl = page.locator('.tst-card .tst-decl').first();
    await expect(decl).toContainText('1 passed in the report');
    await expect(decl).toContainText('1 declares something this workspace knows');
  });

  /** @covers GET /api/tests */
  test('/api/tests reports the fixture catalogue the surface draws', async ({ request }) => {
    const d = await (await request.get('/api/tests?scope=all')).json();
    expect(JSON.stringify(d)).toContain('billing.pw.spec.ts');
  });
});
