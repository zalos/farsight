// ⌘K fast travel: find a node by name and *arrive* where it can be seen.
//
// The pick used to select the node on the code map whatever surface the reader
// was on — from Journeys the map is hidden, so the only visible change was the
// search label. These specs press the real keys and assert the arrival itself:
// the surface the node lives on is on screen, with the node in view.
import { test, expect, gotoReady } from './support';
import type { Page } from '@playwright/test';

const TAX = 'invoice-app::src/server/taxEngine.ts::computeTax';
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ⌘K, type, and wait for the first result to be the one named. */
async function travel(page: Page, query: string, firstResult: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Search' });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('textbox')).toBeFocused();
  await page.keyboard.type(query);
  await expect(palette.locator('.presult').first()).toContainText(firstResult);
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
}

/**
 * The code map is the surface on screen, with this node's card selected, in
 * view, and open in the inspector — and **no focus filter**: arriving used to
 * focus the map on the card's neighbourhood, a filter the reader never chose,
 * which outlived the visit (pass swarm 2026-09-25).
 */
async function expectOnMap(page: Page, id: string, title: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp('#/codemap\\?node=' + reEsc(encodeURIComponent(id))));
  await expect(page.locator('body')).toHaveClass(/surface-graph/);
  await expect(page.getByRole('button', { name: 'Code map' })).toHaveClass(/\bon\b/);
  const card = page.locator('.node.sel');
  await expect(card).toHaveCount(1);
  await expect(card).toBeInViewport();
  await expect(card).toContainText(title);
  await expect(page.getByRole('button', { name: /exit focus/ })).toBeHidden();
  await expect(page.locator('#searchlabel')).not.toHaveText(/focus:/);
  await expect(page.locator('#inspector h2')).toHaveText(title);
}

test.describe('fast travel', () => {
  /**
   * @covers packages/server/public/app/shell.js::openPalette
   * @covers packages/server/public/app/shell.js::paletteNav
   * @covers packages/server/public/app/shell.js::pick
   * @covers packages/server/public/app/shell.js::arriveAt
   */
  test('⌘K, a name and Enter select the node on the code map and open it in the inspector', async ({ page }) => {
    await gotoReady(page, '#/codemap');
    await travel(page, 'computeTax', 'computeTax');
    await expectOnMap(page, TAX, 'Compute tax');
    await expect(page.locator('#inspector')).toContainText('src/server/taxEngine.ts');
  });

  /**
   * @covers packages/server/public/app/shell.js::pick
   * @covers packages/server/public/app/shell.js::travelTarget
   * @covers packages/server/public/app/surfaces/codemap.js::mountCodemap
   */
  test('from Journeys, a function arrives on the code map — selected and in view, not behind the page', async ({ page }) => {
    await gotoReady(page, '#/journeys');
    await expect(page.locator('body')).toHaveClass(/surface-journeys/);
    await travel(page, 'computeTax', 'Compute tax');
    await expectOnMap(page, TAX, 'Compute tax');
    await expect(page.locator('body')).not.toHaveClass(/surface-journeys/);
  });

  /**
   * @covers packages/server/public/app/shell.js::pick
   * @covers packages/server/public/app/shell.js::travelTarget
   * @covers packages/server/public/app/shell.js::renderPalette
   */
  test('in the business register a flow arrives as its journey, and the palette names things without code', async ({ page }) => {
    await gotoReady(page, '#/journeys?lens=business');
    await expect(page.locator('body')).toHaveClass(/lens-business/);
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Search' });
    await page.keyboard.type('computeTax');
    const first = palette.locator('.presult').first();
    await expect(first).toContainText('Compute tax');
    await expect(first).toContainText('Code map');
    await expect(first).not.toContainText('computeTax');
    await expect(first).not.toContainText('taxEngine');
    await expect(first).not.toContainText(/function/i);
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();

    await travel(page, 'billing cycle', 'Billing cycle');
    await expect(page).toHaveURL(/#\/journeys\/invoice-app%3A%3Aflow%3A%3Abilling-cycle/);
    await expect(page.getByRole('dialog', { name: 'Journey', exact: true })).toBeVisible();
    await expect(page.locator('#jrn-title')).toHaveText('Billing cycle');
  });

  /**
   * @covers packages/server/public/app/shell.js::pick
   * @covers packages/server/public/app/shell.js::arriveAt
   */
  test('in the business register a function arrives on the map by its name, its identifier and file kept out', async ({ page }) => {
    await gotoReady(page, '#/journeys?lens=business');
    await travel(page, 'compute tax', 'Compute tax');
    await expectOnMap(page, TAX, 'Compute tax');
    await expect(page.locator('#inspector .insp-head .codename')).toBeHidden();
    await expect(page.locator('#inspector .insp-head .path')).toBeHidden();
  });

  /**
   * @covers packages/server/public/app/shell.js::pick
   * @covers packages/server/public/app/shell.js::travelTarget
   */
  test('from the Tests surface, a function arrives on the code map too', async ({ page }) => {
    await gotoReady(page, '#/tests');
    await expect(page.locator('#tst-body')).toBeVisible();
    await travel(page, 'computeTax', 'Compute tax');
    await expectOnMap(page, TAX, 'Compute tax');
  });

  /**
   * @covers packages/server/public/app/shell.js::renderPalette
   * @covers packages/server/public/app/shell.js::ownerLines
   * @covers packages/server/public/app/shell.js::pick
   */
  test('two results with one name say which is which, and the one picked is the one arrived at', async ({ page }) => {
    // story swarm 2026-09-25: a dozen `Post`s, and a pick that arrived somewhere else
    const CLIENT = 'invoice-app::src/api/client.ts::finalizeInvoice';
    const SERVICE = 'invoice-app::src/server/invoiceService.ts::finalizeInvoice';
    await gotoReady(page, '#/codemap');
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Search' });
    await page.keyboard.type('finalizeInvoice');
    const rows = palette.locator('.presult');
    const client = palette.locator(`.presult[data-id="${CLIENT}"]`);
    const service = palette.locator(`.presult[data-id="${SERVICE}"]`);
    await expect(client).toHaveCount(1);
    await expect(service).toHaveCount(1);
    // the same name, told apart on a second line by where each one lives
    await expect(client.locator('.powner')).toHaveText('client.ts');
    await expect(service.locator('.powner')).toHaveText('invoiceService.ts');
    // pick the one that is not first, by keyboard: the row on screen is the one taken
    const ids = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id));
    const target = ids.indexOf(SERVICE) > ids.indexOf(CLIENT) ? SERVICE : CLIENT;
    for (let i = 0; i < ids.indexOf(target); i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp('#/codemap\\?node=' + reEsc(encodeURIComponent(target)) + '$'));
    await expect(page.locator('#inspector .path')).toContainText(target === SERVICE ? 'src/server/invoiceService.ts' : 'src/api/client.ts');
    // and a click takes the other one, by its id
    const other = target === SERVICE ? CLIENT : SERVICE;
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('finalizeInvoice');
    await palette.locator(`.presult[data-id="${other}"]`).click();
    await expect(page).toHaveURL(new RegExp('#/codemap\\?node=' + reEsc(encodeURIComponent(other)) + '$'));
    await expect(page.locator('#inspector .path')).toContainText(other === SERVICE ? 'src/server/invoiceService.ts' : 'src/api/client.ts');
  });

  /**
   * @covers packages/server/public/app/shell.js::travelTarget
   * @covers packages/server/public/app/shell.js::arriveAt
   * @covers packages/server/public/app/lib/graph-render.js::cardOf
   */
  test('a gate arrives as itself: the card it sits on in view, the inspector and `b` on the gate', async ({ page }) => {
    // The reference app's `submitDraftInvoice: submit readiness` arrived on the route handler `Post`,
    // and change impact then answered for `Post` (story swarm 2026-09-25, onboarding)
    const GATE = 'invoice-app::src/server/approvals.ts::approveInvoice';
    const ROUTE = 'invoice-app::route::POST /invoices/:id/approve';
    await gotoReady(page, '#/codemap');
    await travel(page, 'approveInvoice', 'approveInvoice: approver role');
    await expect(page).toHaveURL(new RegExp('#/codemap\\?node=' + reEsc(encodeURIComponent(GATE)) + '$'));
    await expect(page.locator('#inspector h2')).toHaveText(/approver role/i);
    await expect(page.locator('#inspector')).toContainText('guards');
    const card = page.locator('.node.sel');
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('id', 'nd-' + ROUTE.replace(/[^a-zA-Z0-9_-]/g, '_'));
    await expect(card).toBeInViewport();
    await page.keyboard.press('b');
    await expect(page.locator('#impact.open .imp-node')).toContainText(/guard/i);
    await expect(page.locator('#impact.open .imp-node')).toContainText(/approver role/i);
  });

  /** @covers packages/server/public/app/shell.js::paletteNav */
  test('arrow keys move the highlighted result and Esc closes the palette without travelling', async ({ page }) => {
    await gotoReady(page, '#/journeys');
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Search' });
    await palette.getByRole('textbox').fill('invoice');
    const results = palette.locator('.presult');
    await expect(results.nth(1)).toBeVisible();
    await expect(results.nth(0)).toHaveClass(/hot/);
    await page.keyboard.press('ArrowDown');
    await expect(results.nth(1)).toHaveClass(/hot/);
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    await expect(page).toHaveURL(/#\/journeys$/);
    await expect(page.getByRole('button', { name: /exit focus/ })).toBeHidden();
  });
});
