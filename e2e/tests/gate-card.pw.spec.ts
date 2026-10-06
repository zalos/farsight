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
  const rc = page.locator('.rulecard[data-gate-card="' + GATE + '"]').first();
  await rc.click();
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('[data-gc-sec="calls"] .gc-row')).toHaveCount(2);
});
