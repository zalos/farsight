// The Map uses its space (cleanup pass 2026-10-11, lane S — the owner's "the header is now taking up 1/3 of the screen
// height" and "the lanes view is not a good use of space"): the chrome and the journey head together stay within 170 px
// at 1920, 1440 and 1280 in every register; the lanes draw at the street's density, at ×1.0 at most, and the invoice
// storyline fits a 1440×900 window whole; the legend lies flat; under the street's reading floor every card keeps its
// picture and a one-line verdict; the action stop's screen strip is one line.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady, openJourneyAt } from './support';

const FLOW = 'invoice-app::flow::billing-cycle';
const STREET = '#/map/' + encodeURIComponent(FLOW);
const CHROME_BUDGET = 170;

/** The chrome rows and the journey head, measured from the stage's top to the head's bottom. */
const chromeHeight = (page: Page) => page.evaluate(() => {
  const st = document.querySelector('.map-stage')!.getBoundingClientRect();
  const hd = document.querySelector<HTMLElement>('.map-jhead')!;
  return Math.round(hd.getBoundingClientRect().bottom - st.top);
});

for (const [W, H] of [[1920, 1050], [1440, 900], [1280, 800]]) {
  test.describe(`the Map's space at ${W}`, () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: W, height: H }); });

    /**
     * @covers packages/server/public/app/surfaces/map.js::headBarHtml
     * @covers packages/server/public/app/surfaces/map.js::foldHead
     */
    test('the chrome and the journey head take at most 170 px, in every register; line 1 is one line', async ({ page }) => {
      for (const lens of ['business', 'hybrid', 'code']) {
        for (const layout of ['screens', 'table'] as const) {
          if (lens === 'code' && layout === 'table') continue;
          await openJourneyAt(page, layout, lens);
          const head = page.locator('.map-jhead');
          await expect(head).toBeVisible();
          await expect(head.locator('.agg .k-test, .agg .jrn-htests').first()).toBeVisible();
          expect(await chromeHeight(page), `${lens} ${layout}`).toBeLessThanOrEqual(CHROME_BUDGET);
          // line 1 never wraps, and nothing on it runs off its left edge
          const l1 = await page.evaluate(() => {
            const el = document.querySelector<HTMLElement>('.map-jhead .jh-l1')!;
            const r = el.getBoundingClientRect();
            const kids = [...el.querySelectorAll<HTMLElement>('.nm, .agg > *, .jrn-count > *')].filter((k) => k.offsetWidth);
            return { h: r.height, left: kids.filter((k) => k.getBoundingClientRect().left < r.left - 1).length };
          });
          expect(l1.h).toBeLessThan(30);
          expect(l1.left).toBe(0);
        }
      }
    });
  });
}

/**
 * @covers packages/server/public/app/surfaces/map.js::openAbout
 * @covers packages/server/public/app/surfaces/map.js::foldHead
 */
test('the head\'s +n lists what it folded, and its click opens the whole row in the dock', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openJourneyAt(page, 'screens');
  const more = page.locator('.map-jhead .jh-more');
  await expect(more).toHaveText(/^\+\d+$/);
  const n = Number((await more.textContent())!.slice(1));
  await more.click();
  const row = page.locator('.map-dock .md-about-chips');
  await expect(row).toBeVisible();
  // the dock's row holds every chip the head's line 1 holds, and the ones it folded
  const headShown = await page.locator('.map-jhead .agg > .map-chip:visible:not(.jh-more)').count();
  expect(await row.locator(':scope > .map-chip').count()).toBeGreaterThanOrEqual(headShown + n);
});

/** @covers packages/server/public/app/surfaces/map-lanes.js::lanesHtml */
test('the invoice storyline\'s lanes fit 1440×900 at ×1.0 whole, and the legend lies flat', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoReady(page, '#/map?storyline=invoice&layout=lanes');
  await expect(page.locator('.map-lanes .ln-stage').first()).toBeVisible();
  await expect(page.locator('.map-zoomro')).toHaveText('×1.00');
  const fit = await page.evaluate(() => {
    const board = document.querySelector('.map-board')!.getBoundingClientRect();
    const lanes = document.querySelector('.map-lanes')!.getBoundingClientRect();
    const leg = document.querySelector('.map-lanes .ln-legend')!.getBoundingClientRect();
    return { inside: lanes.top >= board.top - 1 && lanes.bottom <= board.bottom + 1 && lanes.left >= board.left - 1 && lanes.right <= board.right + 1, leg: [leg.width, leg.height] };
  });
  expect(fit.inside).toBe(true);
  expect(fit.leg[0]).toBeGreaterThan(fit.leg[1]);
  // a stage card's name is one line, at the street card's size
  const names = await page.locator('.map-lanes .ln-stage .nm').evaluateAll((els) => els.map((e) => [e.getBoundingClientRect().height, parseFloat(getComputedStyle(e).fontSize)]));
  for (const [h, fs] of names) { expect(h).toBeLessThan(fs * 1.8); expect(fs).toBeLessThanOrEqual(13); }
});

/**
 * @covers packages/server/public/app/surfaces/map.js::drawJourneyLanes
 * @covers packages/server/public/app/surfaces/map-lanes.js::lanesHtml
 */
test('one journey\'s lanes draw at ×1.0 under the head with no scroll, the lifecycle not drawn twice', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoReady(page, STREET + '?layout=lanes');
  const host = page.locator('.map-jlanes-host');
  await expect(host.locator('.ln-stage').first()).toBeVisible();
  const m = await host.evaluate((h) => ({
    scroll: h.scrollHeight > h.clientHeight + 1 || h.scrollWidth > h.clientWidth + 1,
    scale: (h.querySelector<HTMLElement>('.map-lanes')!.style.transform.match(/scale\(([\d.]+)\)/) || [])[1],
  }));
  expect(m.scroll).toBe(false);
  expect(Number(m.scale)).toBe(1);
  // the head prints the record's strip; the lanes do not print it again
  await expect(page.locator('.map-jhead .lc-strip')).toHaveCount(1);
  await expect(host.locator('.ln-life')).toHaveCount(0);
});

/** @covers packages/server/public/app/surfaces/map.js::onCanvasChange */
test('under the street\'s reading floor every card keeps its picture and a verdict on one line', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoReady(page, STREET + '?layout=screens&plumb=1');
  await expect(page.locator('.map-scr').first()).toBeVisible();
  const box = (await page.locator('.map-board').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.4);
  // a pinch out, a little at a time, until the street is under its reading floor (×0.6) and still the street
  for (let i = 0; i < 120; i++) {
    if (await page.locator('.map-world.st-floor').count()) break;
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 3);
    await page.keyboard.up('Control');
    await page.waitForTimeout(60);
  }
  await expect(page.locator('.map-world')).toHaveClass(/\bst-floor\b/);
  await expect.poll(async () => {
    const r = await page.evaluate(() => {
      const ev = [...document.querySelectorAll<HTMLElement>('.map-world.st-floor .map-scr .tc-ev, .map-world.st-floor .map-scr .tc-nb')].filter((e) => e.offsetHeight);
      const thumbs = [...document.querySelectorAll<HTMLElement>('.map-world.st-floor .map-scr .map-thumbwrap')].map((e) => e.getBoundingClientRect().height);
      return {
        n: ev.length,
        wrapped: ev.filter((e) => e.offsetHeight >= 2 * parseFloat(getComputedStyle(e).fontSize) * 1.3).length,
        thumb: Math.min(...thumbs),
      };
    });
    return r.n > 0 && r.wrapped === 0 && r.thumb >= 48;
  }).toBe(true);
});

/** @covers packages/server/public/app/surfaces/map-stops.js::stripHtml */
test('the action stop\'s screen strip is one line of numbered names, the picture in each one\'s tip', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoReady(page, STREET + '?screen=2&action=1');
  const strip = page.locator('.map-act-strip');
  await expect(strip).toBeVisible();
  expect((await strip.boundingBox())!.height).toBeLessThan(32);
  await expect(strip.locator('.map-act-scr .dsg-thumb')).toHaveCount(0);
  await expect(strip.locator('.map-act-scr.on')).toContainText('Invoice list');
  await strip.locator('.map-act-scr').first().hover();
  await expect(page.locator('#fs-tip .map-act-tip')).toBeVisible({ timeout: 5000 });
});
