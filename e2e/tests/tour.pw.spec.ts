// Walk me through it, and ask (round 2026-10-10, proposal 8): the guided walk beside the Map and a question answered
// from the graph. The walk opens on the fixture's storyline, its stops move the Map, the mock's question is answered
// with its skipped proof said honestly, and the business register prints no identifier in the panel at any stop.
import { test, expect, gotoReady } from './support';

/** Identifier-shaped tokens — the journey-numbers spec's list: camelCase, PascalCase compounds, snake_case, paths, HTTP verbs, spec files, document ids. */
const IDENTIFIER = new RegExp([
  String.raw`\b[a-z]+[A-Z][A-Za-z0-9]*\b`,
  String.raw`\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b`,
  String.raw`\b[a-z0-9]+_[a-z0-9_]+\b`,
  String.raw`\b[A-Z0-9]+_[A-Z0-9_]+\b`,
  String.raw`(?:^|[\s(])\/[\w.:{}\-]+`,
  String.raw`\b(?:GET|POST|PUT|PATCH|DELETE)\b`,
  String.raw`\b[\w-]+\.(?:spec|test|pw)\b`,
  String.raw`\.(?:tsx?|jsx?|mjs|json)\b`,
  String.raw`\b(?:CON|INV|OPS)-\d+[a-z]?\b|\bPBI\s?#?\d+`,
].join('|'), 'g');

const panel = '.map-tour';

test.describe('walk me through it', () => {
  /**
   * @covers packages/server/public/app/lib/tour.js::openWalk
   * @covers packages/server/public/app/lib/tour.js::go
   * @covers packages/server/public/app/lib/ask.js::askNow
   * @covers GET /api/tour
   * @covers GET /api/ask
   */
  test('the walk opens on the storyline, its stops move the Map, and Ask says the skipped proof as it is', async ({ page }) => {
    await gotoReady(page, '#/map?storyline=invoice&walk=1');
    const p = page.locator(panel);
    await expect(p.locator('.tw-stop-title')).toHaveText('New invoice');
    await expect(p.locator('.tw-n')).toHaveText(/stop 1 of 6/i);
    await expect(p.locator('.tw-derived')).toContainText('nothing is inferred by a model');
    // every clause cites what it was read from: a chip or the cases door on each line but the persona's
    const lines = p.locator('.tw-cl');
    expect(await lines.count()).toBeGreaterThan(4);
    // the Map moved to the stop's journey
    await expect(page).toHaveURL(/#\/map\/invoice-app%3A%3Aflow%3A%3Anew-invoice/);
    // stop 2: the hand-off that creates the draft
    await p.locator('.tw-next').click();
    await expect(p.locator('.tw-stop-title')).toHaveText(/The invoice becomes draft/);
    await expect(p.locator('.tw-kind')).toHaveText(/hand-off/i);
    // stops 3 and 4: the list, then the move to open that nothing checks — and the Map moved with them
    await p.locator('.tw-next').click();
    await expect(p.locator('.tw-stop-title')).toHaveText('Invoice list');
    await expect(page).toHaveURL(/billing-cycle/);
    await p.locator('.tw-next').click();
    await expect(p.locator('.tw-stop-title')).toHaveText(/The invoice becomes open/);
    await expect(p.locator('.tw-cl.warn')).toContainText('Not checked by the code');
    await expect(page).toHaveURL(/card=call%3Ainvoice-app%3A%3Aroute%3A%3APOST/);
    // ← goes back a stop when the panel has the focus
    await p.locator('.tw-body').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(p.locator('.tw-stop-title')).toHaveText('Invoice list');

    // the mock's question, asked in the panel
    await p.locator('.ask-q').fill('where is an invoice set to open, and what must be true first?');
    await p.locator('.ask-go').click();
    const card = p.locator('.ask-card');
    await expect(card.locator('.ask-derived')).toHaveText(/derived · no model/i);
    await expect(card.locator('.ask-lead').first()).toContainText('open is written by finalizeInvoice');
    await expect(card.locator('.ask-row.warn')).toContainText('Not checked by the code');
    // derived, so honest: the one case that proves the writer was skipped on its last run
    await expect(card.locator('.ask-sec').filter({ hasText: /proven by/i })).toContainText('skipped');
    await expect(card.locator('.ask-sec').filter({ hasText: /path/i })).toContainText(/in \d+ hops/);
  });

  /**
   * @covers packages/server/public/app/lib/tour.js::walkDoorHtml
   * @covers packages/server/public/app/lib/ask.js::askCardHtml
   */
  test('the business register prints no identifier in the walk, at any stop', async ({ page }) => {
    await gotoReady(page, '#/map?storyline=invoice&walk=1&lens=business');
    const p = page.locator(panel);
    await expect(p.locator('.tw-stop-title')).toHaveText('New invoice');
    const found: Record<string, string[]> = {};
    // six stops: the fifth is the customer's bank paying, which the design says is done outside the code
    for (let i = 0; i < 6; i++) {
      await expect(p.locator('.tw-n')).toHaveText(new RegExp(`stop ${i + 1} of 6`, 'i'));
      const words = (await p.locator('.tw-body').innerText());
      const hits = [...new Set(words.match(IDENTIFIER) || [])];
      if (hits.length) found[`stop ${i + 1}`] = hits;
      if (i < 5) await p.locator('.tw-next').click();
    }
    expect(found, 'identifier-shaped words in the business walk').toEqual({});
    // a status in the persona's words: the move to open reads Sent
    await p.locator('.tw-dot').nth(3).click();
    await expect(p.locator('.tw-stop-title')).toHaveText('The invoice becomes Sent');
  });

  /** @covers packages/server/public/app/lib/tour.js::toggleWalk */
  test('WALK opens and closes the panel; the front door and the storyline card carry the door', async ({ page }) => {
    await gotoReady(page, '#/map?storyline=invoice');
    await page.locator('.map-tb-walk').click();
    await expect(page.locator(panel)).toBeVisible();
    await expect(page.locator(panel + ' .tw-n')).toHaveText(/stop 1 of 6/i);
    await page.locator(panel + ' .tw-x').click();
    await expect(page.locator(panel)).toBeHidden();
    await gotoReady(page, '#/journeys');
    await expect(page.locator('.jrn-story-walk').first()).toHaveAttribute('href', /walk=1/);
    await expect(page.locator('.jrn-ask .ask-q')).toBeVisible();
    await page.locator('.jrn-ask .ask-q').fill('what guards Finalize invoice');
    await page.locator('.jrn-ask .ask-go').click();
    await expect(page.locator('.jrn-ask .ask-card')).toContainText(/What guards Finalize invoice/);
  });
});
