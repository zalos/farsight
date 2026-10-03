// The Map by keyboard, by ⌘K and by link (docs/proposals/map-pass-2026-10-03.md §3 row K).
//
// Tab reaches every journey on the board and Enter walks into it; j / k walk the
// street's screens; the address carries the picture (zoom, place, open card) so a
// copied link opens the same view in a fresh page; ⌘K started on the Map arrives
// on the Map. The fixture's design names three journeys; Billing cycle has three
// screens. The map is a workspace experiment, switched on in the page only.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';

const FLOW = 'invoice-app::flow::billing-cycle';
const STREET = '#/map/' + encodeURIComponent(FLOW);
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function mapOn(page: Page) {
  await gotoReady(page, '#/portfolio');
  await page.evaluate(() => {
    const S = (window as any).S;
    S.SETTINGS = Object.assign({}, S.SETTINGS, { flags: Object.assign({}, S.SETTINGS && S.SETTINGS.flags, { map: true }) });
  });
}
async function go(page: Page, hash: string) {
  await page.evaluate((h) => { location.hash = h; }, hash);
}
/** What has the keyboard: its class and the journey, screen or tool it names. */
async function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a) return '';
    return (a.classList[0] || a.tagName) + ':' + (a.dataset.enter || a.dataset.name || a.dataset.act || a.dataset.l || a.dataset.kind || '');
  });
}
/** The board's transform as numbers. */
async function transform(page: Page): Promise<{ tx: number; ty: number; s: number }> {
  return page.evaluate(() => {
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/.exec((document.querySelector('.map-world') as HTMLElement).style.transform)!;
    return { tx: +m[1], ty: +m[2], s: +m[3] };
  });
}

test.describe('map — keyboard, fast travel and links', () => {
  /**
   * @covers packages/server/public/app/surfaces/map.js::applyTabbing
   * @covers packages/server/public/app/surfaces/map.js::tabDistrict
   * @covers packages/server/public/app/surfaces/map.js::onBoardFocus
   * @covers packages/server/public/app/keymap.js::onKeydown
   */
  test('Tab walks the level pills, the tools, then one stop per journey; Enter walks into it', async ({ page }) => {
    await mapOn(page);
    await go(page, '#/map');
    await expect(page.locator('.map-dcover')).toHaveCount(3);
    await expect(page.locator('.map-world')).toHaveClass(/lvl-nb/);
    // start from the level pills: the chrome comes before the board
    await page.locator('.map-lvls button[data-l="nb"]').focus();
    const seen: string[] = [];
    for (let i = 0; i < 20 && seen.filter((x) => x.startsWith('map-dcover')).length < 3; i++) {
      await page.keyboard.press('Tab');
      seen.push(await focused(page));
    }
    const firstCover = seen.findIndex((x) => x.startsWith('map-dcover'));
    // the tools come before any journey, and nothing on the ghosted streets is a stop
    expect(seen.slice(0, firstCover)).toContain('map-tb:link');
    expect(seen.slice(0, firstCover)).toContain('map-tb:fit');
    expect(seen.filter((x) => /^map-(scr|pl|pd)/.test(x))).toEqual([]);
    const covers = seen.filter((x) => x.startsWith('map-dcover'));
    expect(covers).toEqual([
      'map-dcover:invoice-app::flow::billing-cycle',
      'map-dcover:invoice-app::flow::draft-and-send',
      'map-dcover:invoice-app::flow::new-invoice',
    ]);
    // the last journey reached by Tab is on screen, with a visible ring
    const last = page.locator('.map-dcover[data-enter="invoice-app::flow::new-invoice"]');
    await expect(last).toBeFocused();
    await expect(last).toBeInViewport();
    expect(await last.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    // h steps back a journey, Enter walks into it and the keyboard lands on its first screen
    await page.keyboard.press('h');
    await expect(page.locator('.map-dcover[data-enter="invoice-app::flow::draft-and-send"]')).toBeFocused();
    await page.keyboard.press('h');
    await page.keyboard.press('Enter');
    await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
    await expect(page).toHaveURL(new RegExp('#/map/' + reEsc(encodeURIComponent(FLOW))));
    await expect(page.locator(`.map-scr[data-flow="${FLOW}"][data-index="0"]`)).toBeFocused();
    // Esc backs out to the board and the keyboard lands on the journey's cover
    await page.keyboard.press('Escape');
    await expect(page.locator('.map-world')).toHaveClass(/lvl-nb/);
    await expect(page.locator(`.map-dcover[data-enter="${FLOW}"]`)).toBeFocused();
  });

  /**
   * @covers packages/server/public/app/surfaces/map.js::stepScreen
   * @covers packages/server/public/app/surfaces/map.js::mapKey
   * @covers packages/server/public/app/surfaces/map.js::panBy
   */
  test('j / k walk the street\'s screens; Enter opens one; Tab reaches a call and Enter opens its card; arrows pan', async ({ page }) => {
    await mapOn(page);
    await go(page, STREET + '?plumb=1');
    await expect(page.locator(`.map-district[data-flow="${FLOW}"] .map-scr`)).toHaveCount(3);
    await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
    const scr = (i: number) => page.locator(`.map-scr[data-flow="${FLOW}"][data-index="${i}"]`);
    await scr(0).focus();
    await page.keyboard.press('j');
    await expect(scr(1)).toBeFocused();
    await page.keyboard.press('j');
    await expect(scr(2)).toBeFocused();
    await page.keyboard.press('j');
    await expect(scr(2)).toBeFocused();
    await page.keyboard.press('k');
    await expect(scr(1)).toBeFocused();
    await expect(scr(1)).toBeInViewport();
    // Enter opens the screen, Esc lands the keyboard back on it
    await page.keyboard.press('Enter');
    await expect(page.locator('.map-prop-host')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.map-prop-host')).toBeHidden();
    await expect(scr(1)).toBeFocused();
    // Tab goes on from the screens to the calls under them
    let at = '';
    for (let i = 0; i < 30 && !at.startsWith('map-pl'); i++) { await page.keyboard.press('Tab'); at = await focused(page); }
    expect(at).toBe('map-pl:call');
    await page.keyboard.press('Enter');
    await expect(page.locator('.map-xcard')).toBeVisible();
    await expect(page).toHaveURL(/[?&]card=call%3A/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.map-xcard')).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]card=/);
    // arrows pan the board, and the link follows once the keys stop
    await page.locator('.map-lvls button[data-l="st"]').focus();
    const before = await transform(page);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    const after = await transform(page);
    expect(after.tx - before.tx).toBeCloseTo(160, 0);
    expect(after.ty).toBeCloseTo(before.ty, 3);
    await expect.poll(() => page.evaluate(() => new URLSearchParams(location.hash.split('?')[1]).get('x'))).not.toBeNull();
  });

  /**
   * @covers packages/server/public/app/surfaces/map.js::viewParams
   * @covers packages/server/public/app/surfaces/map.js::applyView
   * @covers packages/server/public/app/surfaces/map.js::restoreCard
   * @covers packages/server/public/app/surfaces/map.js::mapCopyLink
   * @covers packages/server/public/app/share.js::shareLink
   * @covers packages/server/public/app/shell.js::parseRoute
   */
  test('the link is the picture: pan, zoom and a card, copy the link, a fresh page opens the same view', async ({ page, context, browser }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mapOn(page);
    await go(page, STREET + '?plumb=1');
    await expect(page.locator(`.map-district[data-flow="${FLOW}"] .map-scr`)).toHaveCount(3);
    // a zoom with the tool, a drag, then a card
    await page.locator('.map-tb[data-act="in"]').click();
    const board = page.locator('.map-board');
    const box = (await board.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 6 });
    await page.mouse.up();
    await page.locator(`.map-pl[data-flow="${FLOW}"][data-si="1"][data-ci="0"] .nm`).click();
    await expect(page.locator('.map-xcard')).toBeVisible();
    await page.locator('.map-tb[data-act="link"]').click();
    await expect(page.locator('.map-hint')).toHaveText(/link copied/i);
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toMatch(/[?&]z=[\d.]+/);
    expect(link).toMatch(/[?&]x=-?\d+/);
    expect(link).toMatch(/[?&]y=-?\d+/);
    expect(link).toMatch(/[?&]card=call%3A/);
    expect(link).toMatch(/[?&]lens=hybrid/);
    const want = await transform(page);
    const cardName = await page.locator('.map-xcard .nm').textContent();

    // a fresh page, the same window size, the link opened from outside
    const fresh = await browser.newPage({ viewport: page.viewportSize()! });
    const errors: string[] = [];
    fresh.on('pageerror', (e) => errors.push(e.message));
    await fresh.goto('/#/portfolio');
    await expect(fresh.locator('#stats')).not.toHaveText('loading…');
    await mapOn(fresh);
    await go(fresh, link.slice(link.indexOf('#')));
    await expect(fresh.locator('.map-xcard')).toBeVisible();
    await expect(fresh.locator('.map-xcard .nm')).toHaveText(cardName!);
    // every walk lands without moving the picture
    await expect(fresh.locator('.map-district.loaded')).toHaveCount(3);
    const got = await transform(fresh);
    expect(Math.abs(got.s - want.s)).toBeLessThan(0.001);
    expect(Math.abs(got.tx - want.tx)).toBeLessThanOrEqual(1);
    expect(Math.abs(got.ty - want.ty)).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
    await fresh.close();
  });

  /**
   * @covers packages/server/public/app/shell.js::travelTarget
   * @covers packages/server/public/app/shell.js::renderPalette
   * @covers packages/server/public/app/surfaces/map.js::mapTravel
   */
  test('⌘K started on the Map arrives on the Map: a journey is its street, a screen opens on its journey', async ({ page }) => {
    await mapOn(page);
    await go(page, '#/map');
    await expect(page.locator('.map-dcover')).toHaveCount(3);
    await expect(page.locator('.map-district.loaded')).toHaveCount(3);
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Search' });
    await expect(palette).toBeVisible();
    await page.keyboard.type('Draft and send');
    const first = palette.locator('.presult').first();
    await expect(first).toContainText('Draft and send');
    // the row names where Enter goes
    await expect(first.locator('.pdest')).toHaveText(/map/i);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp('#/map/' + reEsc(encodeURIComponent('invoice-app::flow::draft-and-send')) + '(\\?|$)'));
    await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
    await expect(page.locator('.map-crumb')).toContainText('Draft and send');
    // a screen: its journey's street with the screen open
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('Invoice list');
    await expect(palette.locator('.presult').first()).toContainText('Invoice list');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/map\/[^?]+\?(.*&)?node=invoice-app%3A%3Apage%3A%3A%2Finvoices(&|$)/);
    await expect(page.locator('.map-prop-host')).toBeVisible();
  });

  /** @covers packages/server/public/app/shell.js::travelTarget */
  test('⌘K away from the Map keeps its old arrival: a journey opens on Journeys', async ({ page }) => {
    await mapOn(page);
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Search' });
    await page.keyboard.type('Draft and send');
    await expect(palette.locator('.presult').first()).toContainText('Draft and send');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/journeys\//);
  });

  /**
   * @covers packages/server/public/app/surfaces/map.js::drawAsOf
   */
  test('the crumb carries the as-of stamp: the sync and the day the board was drawn from', async ({ page }) => {
    await mapOn(page);
    await go(page, '#/map');
    await expect(page.locator('.map-asof')).toHaveText(/as of sync \d+ · \w+/i);
  });
});
