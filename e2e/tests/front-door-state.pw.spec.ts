// The front door opens with the state of play (round 2026-10-10, lane H): READ THIS IF beside STATE OF PLAY —
// three columns, every number with its tip and its re-check — the one history sentence, the glossary strip
// (its absence said on the fixture, which gives no glossary); Settings as an address under the top bar; and an
// address with nothing at it says so instead of dropping the reader on the front door.
import { test, expect, gotoReady } from './support';

test.describe('the state of play', () => {
  /**
   * @covers packages/server/public/app/lib/state-of-play.js::stateOfPlayHtml
   * @covers packages/server/public/app/lib/state-of-play.js::mountStateOfPlay
   * @covers packages/core/src/state-of-play.ts::stateOfPlay
   */
  test('three columns, every number with a tip and a re-check, the history sentence with both halves', async ({ page }) => {
    await gotoReady(page, '#/journeys');
    const card = page.locator('#sop-card');
    await expect(card.locator('.sop-col')).toHaveCount(3);
    await expect(card.locator('.sop-col h3')).toHaveText([/built and walkable/i, /validated by a run/i, /still open/i]);
    await expect(page.locator('.jrn-readthis h2')).toHaveText(/read this if/i);
    // the fixture's own numbers, as the design and API surfaces count them
    await expect(card).toContainText('1 of 3 journeys built');
    await expect(card).toContainText('2 of 3 screens built');
    await expect(card).toContainText('6 of 7 operations implemented');
    await expect(card).toContainText('1 screen designed, not built');
    await expect(card.locator('.sop-names')).toHaveText('(Discard draft)');
    // every number carries its tip — what it counts, over what, from where
    const ns = card.locator('.sop-n');
    expect(await ns.count()).toBeGreaterThan(8);
    for (const n of await ns.all()) await expect(n).toHaveAttribute('data-tip-id', 'number');
    // the history: one sentence, both halves
    await expect(card.locator('.sop-hist')).toContainText(/\d+ commits? read into history · \d+ ingested by a sync · \d+ not yet/);
    // a re-check door names its command in its tip
    const re = card.locator('.sop-re').first();
    await expect(re).toHaveAttribute('data-cmd', /^farsight /);
    await expect(re).toHaveAttribute('data-tip-text', /^farsight /);
    // no glossary in the fixture's config: the strip says so with an absence word
    await expect(page.locator('#sop-gloss')).toContainText(/none indexed/);
  });

  /** @covers packages/server/public/app/lib/state-of-play.js::stateOfPlayHtml */
  test('the business register keeps the numbers and drops the commands', async ({ page }) => {
    await gotoReady(page, '#/journeys?lens=business');
    const card = page.locator('#sop-card');
    await expect(card.locator('.sop-col')).toHaveCount(3);
    await expect(card).toContainText('2 of 3 screens built');
    await expect(card.locator('.sop-re')).toHaveCount(0);
    await expect(card.locator('.sop-cmd')).toHaveCount(0);
  });
});

test.describe('addresses', () => {
  /**
   * @covers packages/server/public/app/shell.js::openSettings
   * @covers packages/server/public/app/shell.js::closeSettings
   */
  test('Settings is #/settings, under the top bar, and Back returns to where it was opened', async ({ page }) => {
    await gotoReady(page, '#/portfolio');
    await page.evaluate(() => (window as any).openSettings());
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page.locator('#settings')).toBeVisible();
    await expect(page.locator('#nav')).toBeVisible();
    await expect(page.locator('#gearbtn')).toHaveClass(/\bon\b/);
    await page.locator('#settings').getByRole('button', { name: 'Back' }).click();
    await expect(page).toHaveURL(/#\/portfolio$/);
    // a link straight to it opens it too
    await gotoReady(page, '#/settings');
    await expect(page.locator('#settings')).toBeVisible();
  });

  /** @covers packages/server/public/app/shell.js::applyRoute */
  test('an address with nothing at it says so, with a door to the front door', async ({ page }) => {
    await gotoReady(page, '#/code');
    const line = page.locator('.nowhere');
    await expect(line).toContainText('There is nothing at this address');
    await expect(line.locator('code')).toHaveText('#/code');
    await expect(page).toHaveURL(/#\/code$/);
    await line.locator('.nowhere-door').click();
    await expect(page).toHaveURL(/#\/journeys/);
    await expect(page.locator('#sop-card')).toBeVisible();
  });
});
