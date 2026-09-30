import { test, expect } from '@playwright/test';

/**
 * Starting a new invoice, end to end. The header declares the flow and its
 * screen and the body opens nothing the graph can follow — so what the run
 * says is all there is: a case the report says passed counts as observed for
 * what it declares (*passed, by its own declaration*); the one it says failed
 * stays declared only.
 *
 * @covers new-invoice
 * @covers INV-02
 */

test.describe('new invoice', () => {
  test('a draft is saved for the picked customer', async ({ page }) => {
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('Draft saved')).toBeVisible();
  });

  test('a draft with no line items is refused', async ({ page }) => {
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('Add at least one line')).toBeVisible();
  });
});
