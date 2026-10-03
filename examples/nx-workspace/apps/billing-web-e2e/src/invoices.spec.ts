import { test, expect } from '@playwright/test';

test('the invoices page lists invoices', async ({ page }) => {
  await page.goto('/invoices');
  await expect(page.getByText('Invoices')).toBeVisible();
});
