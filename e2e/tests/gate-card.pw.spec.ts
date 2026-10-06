// A gate answers its click (swarm-fixes round 2026-10-05, finding 4). Clicking a gate anywhere opens ONE card:
// the sentence, where it stands (the calls it guards, counted), its own code, the calls it guards with their
// doors and the tests that reach it — the doors on the card's head and on the row, never behind a ▸. The business
// register keeps the sentence, the scope and the tests and draws no door into code. The fixture's Billing cycle
// meets `requireScope(billing:read)` on its Invoice list (step 2), in front of GET /invoices and GET /invoices/:id.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';

const FLOW = 'invoice-app::flow::billing-cycle';
const GATE = 'invoice-app::guard::requireScope(billing:read)';
const enc = encodeURIComponent;

function card(page: Page) { return page.locator('.fs-tip .gc[data-gc="' + GATE + '"]'); }

/**
 * @covers packages/server/public/app/lib/gate-card.js::openGateCard
 * @covers packages/server/public/app/lib/gate-card-model.js::gateCardModel
 * @covers packages/server/public/app/surfaces/journeys.js::jrnGateRowHtml
 * @covers GET /api/gate
 * @covers GET /api/source
 */
test('a gate on the journey opens its card: sentence, scope, code, the calls it guards, the tests, the doors', async ({ page }) => {
  await gotoReady(page, '#/journeys/' + enc(FLOW) + '?step=2&biz=gates&dock=right&lens=hybrid');
  const row = page.locator('.jrn-gl-row[data-gate-card="' + GATE + '"]').first();
  // the doors are on the row itself
  await expect(row.locator('a.dd-door.editor')).toHaveAttribute('href', /^vscode:\/\/file\/.+src\/server\/routes\.ts:\d+$/);
  await row.locator('.jrn-gl-w').click();
  const c = card(page);
  await expect(c).toBeVisible();
  await expect(c.locator('.gc-kind')).toHaveText(/check/i);
  await expect(c.locator('.gc-says')).not.toBeEmpty();
  await expect(c.locator('.gc-counts')).toContainText(/2 of \d+ calls/);
  await expect(c.locator('.gc-code .gc-pre')).toContainText('requireScope');
  const calls = c.locator('[data-gc-sec="calls"] .gc-row');
  await expect(calls).toHaveCount(2);
  await expect(calls.first().locator('a.dd-door').first()).toHaveText('read the contract');
  await expect(c.locator('h4', { hasText: /the tests that reach it/i })).toBeVisible();
  await expect(c.locator('.gc-doors a.dd-door', { hasText: 'see it on the code map' })).toHaveAttribute('href', '#/codemap?node=' + enc(GATE));
  // Esc closes it
  await page.keyboard.press('Escape');
  await expect(c).toHaveCount(0);
});

/** @covers packages/server/public/app/lib/gate-card.js::gateKeydown */
test('Enter on a focused gate opens the card, Esc closes it and the focus comes back', async ({ page }) => {
  await gotoReady(page, '#/journeys/' + enc(FLOW) + '?step=2&biz=gates&dock=right&lens=hybrid');
  const row = page.locator('.jrn-gl-row[data-gate-card="' + GATE + '"]').first();
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(card(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await expect(row).toBeFocused();
});

/** @covers packages/server/public/app/lib/gate-card.js::gateCardHtml */
test('in the business register the card keeps the sentence, the scope and the tests, and no door into code', async ({ page }) => {
  await gotoReady(page, '#/journeys/' + enc(FLOW) + '?step=2&biz=gates&dock=right&lens=business');
  const row = page.locator('.jrn-gl-row[data-gate-card="' + GATE + '"]').first();
  await expect(row.locator('a.dd-door')).toHaveCount(0);
  await row.click();
  const c = card(page);
  await expect(c).toBeVisible();
  await expect(c.locator('.gc-says')).not.toBeEmpty();
  await expect(c.locator('.gc-counts')).toContainText(/2 of \d+ calls/);
  await expect(c.locator('h4', { hasText: /the tests that reach it/i })).toBeVisible();
  await expect(c.locator('.gc-code')).toHaveCount(0);
  await expect(c.locator('a.dd-door.editor')).toHaveCount(0);
  await expect(c.locator('a.dd-door', { hasText: 'see it on the code map' })).toHaveCount(0);
  await expect(c.locator('.gc-loc')).toHaveCount(0);
});

/** @covers packages/server/public/app/lib/graph-render.js::nodeCardHtml */
test('the code map: a gate in the inspector opens the same card', async ({ page }) => {
  await gotoReady(page, '#/codemap?node=' + enc('invoice-app::route::GET /invoices') + '&lens=hybrid');
  const rc = page.locator('#inspector .rulecard[data-gate-card="' + GATE + '"]').first();
  await expect(rc).toBeVisible();
  // the gate's name, not the card's centre: the centre can land on the row's ⧉ editor link (CI run 37461063645,
  // Linux fonts put it under the click), which opens the editor and is not the gate
  await rc.locator('.rc-n').click();
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('[data-gc-sec="calls"] .gc-row')).toHaveCount(2);
});

/**
 * A slow machine: the inspector draws again (a second select) while the card waits for /api/gate, and again while
 * the card is open. The card opens on the gate's new row and stays open across the redraw (CI run 37460360907).
 * @covers packages/server/public/app/lib/gate-card.js::openGateCard
 * @covers packages/server/public/app/lib/tooltip.js::onMutate
 */
test('the card survives the inspector drawing again under it', async ({ page }) => {
  const ROUTE = 'invoice-app::route::GET /invoices';
  await gotoReady(page, '#/codemap?node=' + enc(ROUTE) + '&lens=hybrid');
  await page.route('**/api/gate?*', async (r) => { await new Promise((res) => setTimeout(res, 900)); await r.continue(); });
  const rc = page.locator('#inspector .rulecard[data-gate-card="' + GATE + '"]').first();
  await expect(rc).toBeVisible();
  // the gate's name, not the card's centre: the centre can land on the row's ⧉ editor link (CI run 37461063645,
  // Linux fonts put it under the click), which opens the editor and is not the gate
  await rc.locator('.rc-n').click();
  // the inspector is redrawn before the answer lands: the row the reader clicked is gone
  await page.evaluate((id) => (window as any).select(id), ROUTE);
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('[data-gc-sec="calls"] .gc-row')).toHaveCount(2);
  // and once more with the card open
  await page.evaluate((id) => (window as any).select(id), ROUTE);
  await page.waitForTimeout(300);
  await expect(card(page)).toBeVisible();
});
