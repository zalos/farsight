// The round-3 swarm's words, numbers and verdicts (2026-10-11), on the fixture: build state wins a partly built
// journey's verdict wherever it is printed, the runs line is one sentence, the readiness header says distinct with the
// rows beside it, Ask answers *did you mean*, and the AT RISK bar names the scope it counts over.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';

const FLOW = 'invoice-app::flow::billing-cycle';
const enc = encodeURIComponent;

async function mapOn(page: Page) {
  await gotoReady(page, '#/portfolio');
  await page.evaluate(() => {
    const S = (window as any).S;
    S.SETTINGS = Object.assign({}, S.SETTINGS, { flags: Object.assign({}, S.SETTINGS && S.SETTINGS.flags, { map: true }) });
  });
}
const go = (page: Page, hash: string) => page.evaluate((h) => { location.hash = h; }, hash);

/**
 * @covers packages/server/public/app/lib/test-chip.js::builtOnlyHtml
 * @covers packages/server/public/app/lib/test-chip.js::runsSentenceHtml
 * @covers packages/core/src/coverage.ts::coverageFor
 */
test('a partly built journey says so before its word, on its head and on the storyline card', async ({ page }) => {
  await gotoReady(page, '#/map/' + enc(FLOW) + '?layout=table&lens=hybrid');
  const head = page.locator('.map-jhead .jrn-htests');
  await expect(head).toBeVisible();
  await expect(head.locator('.tc-pb')).toHaveText(/partly built · 2 of 3/i);
  await expect(head.locator('.tc-pba')).toHaveText('over the 2 built screens');
  await expect(head.locator('.tc-ev')).toHaveClass(/builtonly/);
  // the storyline board: the same journey's card carries the build state before its word
  await mapOn(page);
  await go(page, '#/map?storyline=invoice');
  const card = page.locator(`.map-dcover[data-enter="${FLOW}"]`);
  await expect(card.locator('.tc-pb')).toHaveText(/partly built · 2 of 3/i);
  // the front door counts it apart, never under a word
  await gotoReady(page, '#/journeys');
  await expect(page.locator('#sop-card')).toContainText(/not fully built, so no journey verdict/);
});

/** @covers packages/server/public/app/surfaces/readiness.js::sheetHtml */
test('the readiness header says distinct, with each row’s own count in its tip', async ({ page }) => {
  await gotoReady(page, '#/readiness/invoice');
  const tile = page.locator('.rd-distinct[data-distinct="skipped"]');
  await expect(tile).toHaveText('distinct');
  await tile.hover();
  await expect(page.locator('#fs-tip')).toContainText('rows added up');
  await expect(page.locator('#fs-tip')).toContainText('distinct over the storyline');
});

/**
 * @covers packages/server/public/app/lib/ask.js::askCardHtml
 * @covers packages/core/src/ask.ts::suggestQuestions
 */
test('Ask answers a plain question with did you mean, and a click asks it', async ({ page }) => {
  await gotoReady(page, '#/journeys');
  const box = page.locator('.jrn-ask .ask-wrap').first();
  await expect(box.locator('.ask-q')).toBeVisible();
  // the example is this graph's own
  await expect.poll(() => box.locator('.ask-q').getAttribute('placeholder')).toMatch(/^where is .+ set to .+, and what must be true first\?$/);
  await box.locator('.ask-q').fill('who opens an invoice');
  await box.locator('.ask-go').click();
  const sugg = box.locator('.ask-suggest .ask-sugg').first();
  await expect(sugg).toHaveText('where is invoice set to open, and what must be true first?');
  await sugg.click();
  await expect(box.locator('.ask-card')).toHaveAttribute('data-shape', 'set');
});

/** @covers packages/server/public/app/surfaces/map.js::drawRisk */
test('the AT RISK bar names the scope it counts over, and the address decides it', async ({ page }) => {
  await mapOn(page);
  await go(page, '#/map');
  await expect(page.locator('.map-risk .map-risk-scope')).toHaveText('across every source in scope');
  await go(page, '#/map?storyline=invoice');
  await expect(page.locator('.map-risk .map-risk-scope')).toHaveText('in this storyline');
});
