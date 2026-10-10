// Gates a business reader cares about (gates lane, 2026-10-10). The journey header says the gates & rules as two
// numbers that partition them — *n that matter to the business · m technical checks*; the business register lists
// each action's checks by tier (who may · the record must be · policy) and folds the technical ones behind
// *+ n technical checks*; a precondition the parser read out of the code (the fixture's `updateInvoice` refuses an
// invoice that has left draft with a 409) opens the one gate card, which says its tier and why. Hybrid keeps the
// one list and chips each row with its tier.
import { test, expect, gotoReady } from './support';

const FLOW = 'invoice-app::flow::billing-cycle';
const PRE = 'invoice-app::precondition::src/server/invoiceService.ts::updateInvoice::invoices.status';
const enc = encodeURIComponent;

/**
 * @covers packages/server/public/app/surfaces/journeys.js::jrnGateTiersHtml
 * @covers packages/server/public/app/surfaces/journeys.js::jrnGateTiers
 * @covers packages/core/src/journey-counted.ts::journeyCounted
 */
test('the business register: two numbers in the header, the checks by tier, the technical ones folded', async ({ page }) => {
  await gotoReady(page, '#/journeys/' + enc(FLOW) + '?view=sheet&biz=gates&lens=business');
  await expect(page.locator('.jrn-num.jrn-gates-biz').first()).toHaveText(/^\d+ that matters? to the business$/);
  await expect(page.locator('.jrn-num.jrn-gates-tech').first()).toHaveText(/^\d+ technical checks?$/);
  const list = page.locator('.jrn-gatelist.tiers').first();
  await expect(list).toBeVisible();
  await expect(page.locator('.jrn-gatelist.tiers .jrn-gl-grp.who').first()).toBeVisible();
  // the precondition sits under *the record must be*, in the team's own words
  const rec = page.locator('.jrn-gatelist.tiers .jrn-gl-grp.record', { has: page.locator('[data-gate-card="' + PRE + '"]') }).first();
  await expect(rec.locator('.hud-label')).toHaveText(/the record must be/i);
  await expect(rec.locator('[data-gate-card="' + PRE + '"] .jrn-gl-w')).toHaveText('Reject edits once the invoice has left draft');
  // the technical checks are folded: counted on the summary, listed only when opened
  const fold = page.locator('details.jrn-gl-tech').first();
  await expect(fold.locator('summary')).toHaveText(/^\+ \d+ technical checks?$/);
  await expect(fold.locator('.jrn-gl-grp')).toBeHidden();
  await fold.locator('summary').click();
  await expect(fold.locator('.jrn-gl-grp')).toBeVisible();
});

/**
 * @covers packages/server/public/app/lib/gate-card.js::gateCardHtml
 * @covers packages/server/public/app/lib/gate-card-model.js::tierLine
 * @covers GET /api/gate
 */
test('a precondition opens the gate card with its tier and why, and what happens otherwise', async ({ page }) => {
  await gotoReady(page, '#/journeys/' + enc(FLOW) + '?view=sheet&biz=gates&lens=hybrid');
  const row = page.locator('.jrn-gl-row[data-gate-card="' + PRE + '"]').first();
  // hybrid keeps the one list, each row with its tier
  await expect(row.locator('.gate-tier.business')).toHaveText(/business/i);
  await row.locator('.jrn-gl-w').click();
  const c = page.locator('.fs-tip .gc[data-gc="' + PRE + '"]');
  await expect(c).toBeVisible();
  await expect(c.locator('.gc-kind')).toHaveText(/precondition/i);
  await expect(c.locator('.gc-name')).toHaveText('Reject edits once the invoice has left draft');
  const tier = c.locator('[data-gc-sec="tier"]');
  await expect(tier).toContainText(/business/i);
  await expect(tier).toContainText('a record must be in a state');
  await expect(tier).toContainText('invoices.status = draft');
  await expect(tier).toContainText('tier from the kind of check');
  await expect(c.locator('.gc-sec').filter({ hasText: /what it allows/i })).toContainText('Otherwise: 409 conflict');
  await page.keyboard.press('Escape');
  await expect(c).toHaveCount(0);
});
