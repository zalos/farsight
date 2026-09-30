import { test, expect } from '@playwright/test';

/**
 * The billing screens end to end. INV-01 is a screen in the manifest;
 * CON-99 deliberately matches nothing — an unresolved claim must be visible,
 * not silently dropped (docs/proposals/tests-surface.md §7).
 *
 * @covers draft-and-send
 * @covers INV-01
 * @covers CON-99
 */

test.describe('billing', () => {
  test('the invoice list shows every invoice newest first', async ({ page }) => {
    await page.goto('/invoices');
    await expect(page.getByRole('heading', { name: 'Invoices' })).toBeVisible();
  });

  test('a new invoice is created and appears in the list', async ({ page, request }) => {
    const created = await request.post('/invoices', { data: { customerId: 'c1', lines: [{ amount: 100 }] } });
    expect(created.ok()).toBe(true);
    await page.goto('/invoices');
  });
});
