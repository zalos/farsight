// The record's status lifecycle on the journey header (swarm-fixes round 2026-10-05, finding 7):
// the invoice-app example declares `InvoiceStatus` on its invoice row and three functions write
// the status, so Billing cycle's header carries the invoices strip — the statuses in declared
// order, the two the code never moves to dashed, each move a door to its writer.
import { test, expect, openBillingCycle } from './support';

test.describe('journey status lifecycle', () => {
  /**
   * @covers packages/server/public/app/surfaces/journeys.js::jrnLifecycleHtml
   * @covers packages/server/public/app/lib/lifecycle-strip.js::lifecycleStripHtml
   * @covers GET /api/journey
   */
  test('the header names the record, its statuses in order and the moves with their writers', async ({ page }) => {
    await openBillingCycle(page);
    const strip = page.locator('#jrn-lifecycle .lc-strip[data-record="invoice-app::table::invoices"]');
    await expect(strip).toBeVisible();
    await expect(strip.locator('.lc-rec')).toHaveText('invoices · status');
    await expect(strip.locator('.lc-status')).toHaveText(['draft', 'open', 'approved', 'paid', 'void']);
    await expect(strip.locator('.lc-status.unwritten')).toHaveText(['paid', 'void']);
    await expect(strip.locator('.lc-counts')).toContainText('5 statuses');
    await expect(strip.locator('.lc-counts')).toContainText('3 moves with a writer');
    // a move this journey makes is lit, and it opens its writer
    const send = strip.locator('.lc-move', { hasText: '→ open' });
    await expect(send).toContainText('by finalizeInvoice');
    await expect(send).toHaveClass(/\bhere\b/);
    await expect(send).toHaveAttribute('href', /.+/);
  });
});
