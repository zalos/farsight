// The record's status lifecycle on the journey header (swarm-fixes round 2026-10-05, finding 7; round
// 2026-10-10 §3, one state machine, two views of it). The invoice-app example declares `InvoiceStatus` on its
// invoice row, three functions write the status, and its farsight.config.json gives Billing's words for the
// five statuses and one overlay (a ledger entry). Billing cycle is Billing's, so its header prints the
// statuses in Billing's words, and *what each one means* opens one table of the word, the constant and what
// moves it — every status, then the overlay.
import type { Page } from '@playwright/test';
import { test, expect, openBillingCycle } from './support';

const RECORD = 'invoice-app::table::invoices';
const strip = (page: Page) => page.locator(`#jrn-lifecycle .lc-strip[data-record="${RECORD}"]`);

// identifier-shaped tokens (the journey-numbers spec's list): a business reader never sees one on the strip
const IDENTIFIER = /\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b|\b[a-z0-9]+_[a-z0-9_]+\b|\b[A-Z0-9]+_[A-Z0-9_]+\b|\.(?:tsx?|jsx?|mjs|json)\b/g;

async function openIn(page: Page, lens: 'business' | 'hybrid' | 'code') {
  await openBillingCycle(page);
  await page.locator('#lb-' + lens).click();
  await expect(page.locator('body')).toHaveClass(new RegExp('lens-' + lens));
  await expect(strip(page)).toBeVisible();
}

test.describe('journey status lifecycle', () => {
  /**
   * @covers packages/server/public/app/surfaces/journeys.js::jrnLifecycleHtml
   * @covers packages/server/public/app/lib/lifecycle-strip.js::lifecycleStripHtml
   * @covers GET /api/journey
   */
  test('hybrid names the record and prints each status as the word and the constant, in declared order', async ({ page }) => {
    await openIn(page, 'hybrid');
    const s = strip(page);
    await expect(s.locator('.lc-rec')).toHaveText('invoices · status');
    await expect(s.locator('.lc-status .lc-w')).toHaveText(['Being drafted', 'Sent', 'Approved', 'Paid', 'Void (ended)']);
    await expect(s.locator('.lc-status .lc-c')).toHaveText(['draft', 'open', 'approved', 'paid', 'void']);
    await expect(s.locator('.lc-status.unwritten .lc-c')).toHaveText(['paid', 'void']);
    await expect(s.locator('.lc-counts')).toContainText('5 statuses');
    await expect(s.locator('.lc-counts')).toContainText('3 moves with a writer');
  });

  /**
   * @covers packages/server/public/app/lib/lifecycle-strip.js::lifecycleStripHtml
   * @covers packages/server/public/app/lib/lifecycle-model.js::stripItems
   */
  test('business prints the words only, no identifier, the counts in words and the constant in the tip', async ({ page }) => {
    await openIn(page, 'business');
    const s = strip(page);
    await expect(s.locator('.lc-status .lc-w')).toHaveText(['Being drafted', 'Sent', 'Approved', 'Paid', 'Void (ended)']);
    await expect(s.locator('.lc-status .lc-c')).toHaveCount(0);
    await expect(s.locator('.lc-counts')).toHaveText('5 statuses · 3 that the app moves · 2 nothing moves yet');
    await expect(s.locator('.lc-status.unwritten .lc-yet')).toHaveText(['no code moves it yet', 'no code moves it yet']);
    const text = (await s.locator('.lc-head, .lc-statuses').allInnerTexts()).join(' ');
    expect(text.match(IDENTIFIER) || [], 'identifier-shaped tokens on the business strip').toEqual([]);
    await s.locator('.lc-status').first().click();
    await expect(page.locator('#fs-tip')).toContainText('in the code: draft');
  });

  /**
   * @covers packages/server/public/app/lib/lifecycle-strip.js::lcToggle
   * @covers packages/server/public/app/lib/lifecycle-model.js::tableRows
   * @covers GET /api/lifecycle
   */
  test('what each one means: one row per status then per overlay, the writer a door to its screen', async ({ page, request }) => {
    const answer = await (await request.get(`/api/lifecycle?node=${encodeURIComponent(RECORD)}&flow=${encodeURIComponent('invoice-app::flow::billing-cycle')}`)).json();
    const view = answer.views[0];
    expect(view.persona.id).toBe('billing');
    await openIn(page, 'business');
    const s = strip(page);
    const toggle = s.locator('.lc-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const table = s.locator('.lc-table');
    await expect(table.locator('th')).toHaveText([/what Billing sees/i, /in the code/i, /what moves it/i]);
    // the rows are the lifecycle's statuses and then its overlays, nothing else
    await expect(table.locator('tbody tr')).toHaveCount(view.rows.length + view.overlays.length);
    await expect(table.locator('tbody tr.status .lc-tw')).toHaveText(view.rows.map((r: { word: string }) => r.word));
    await expect(table.locator('tbody tr.overlay .lc-tw')).toHaveText(view.overlays.map((o: { name: string }) => o.name));
    await expect(table.locator('tbody tr.status .lc-tc')).toHaveText(view.rows.map((r: { status: string }) => r.status));
    await expect(table.locator('tbody tr.unwritten .lc-tm')).toHaveText(['nothing in the code moves it yet', 'nothing in the code moves it yet']);
    // Sent is moved by the code the list screen runs: a door to that screen of the journey, that node selected
    const send = table.locator('tbody tr.status', { hasText: 'Sent' }).locator('a.lc-door');
    await expect(send).toHaveText('Finalize invoice');
    await expect(send).toHaveAttribute('href', /#\/journeys\/invoice-app%3A%3Aflow%3A%3Abilling-cycle\?view=timeline&step=2&node=invoice-app%3A%3Asrc%2Fserver%2FinvoiceService\.ts%3A%3AfinalizeInvoice/);
    await expect(s.locator('.lc-foot')).toContainText('statuses and moves read from the code');
    await send.click();
    await expect(page).toHaveURL(/view=timeline&step=2/);
  });
});
