// Nothing on the Map overflows (cleanup pass 2026-10-11): text wraps or folds to `+n` with a tip, never clips, and
// nothing scrolls the page sideways. On the fixture at 1440 and 1280: the table and the beats keep every element
// inside the stage (the stage scrolls, the page does not), the verdict chip on every street card is whole, the lanes'
// smallest text at the fit is at least 9 px on screen, and the document never scrolls horizontally.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';

const FLOW = 'invoice-app::flow::billing-cycle';
const STREET = '#/map/' + encodeURIComponent(FLOW);

async function mapOn(page: Page) {
  await gotoReady(page, '#/portfolio');
  await page.evaluate(() => {
    const S = (window as any).S;
    S.SETTINGS = Object.assign({}, S.SETTINGS, { flags: Object.assign({}, S.SETTINGS && S.SETTINGS.flags, { map: true }) });
  });
}
const go = (page: Page, hash: string) => page.evaluate((h) => { location.hash = h; }, hash);

/** The page never scrolls sideways. */
const pageOver = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

/**
 * Elements at a stop below the street that reach past the stage's right edge without a scroller of the stop carrying
 * them, or whose text spills past the cell that holds it — the names, for the failure message.
 */
const spills = (page: Page) => page.evaluate(() => {
  const host = document.querySelector('.map-table-host:not([hidden]), .map-act-host:not([hidden])');
  if (!host) return ['no stop drawn'];
  const stage = document.querySelector('.map-stage')!.getBoundingClientRect();
  const out: string[] = [];
  for (const el of host.querySelectorAll<HTMLElement>('*')) {
    const r = el.getBoundingClientRect();
    // a closed drawer (the forks, the cut list) waits off to the side, inert: it is not drawn text
    if (!r.width || !r.height || el.closest('[inert]')) continue;
    let scroller: Element | null = null;
    for (let p = el.parentElement; p && p !== host; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'auto' || o === 'scroll' || o === 'hidden') { scroller = p; break; }
    }
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent || '').trim());
    const cell = el.parentElement && el.parentElement.closest('.jrn-scell,.jrn-sbh,.jrn-dcell,.jrn-dbh,.jrn-dcap,.jrn-seam');
    const spill = hasText && cell && r.right > cell.getBoundingClientRect().right + 2;
    if ((!scroller && r.right > stage.right + 1) || spill) out.push((el.className || el.tagName) + ': ' + (el.textContent || '').trim().slice(0, 40));
  }
  return out;
});

for (const [w, h] of [[1440, 900], [1280, 800]]) {
  test.describe(`at ${w}`, () => {
    test.use({ viewport: { width: w, height: h } });

    /**
     * @covers packages/server/public/app/lib/journey-draw.js::jrnSheetHtml
     * @covers packages/server/public/app/lib/journey-draw.js::jrnMarkerHtml
     */
    test('the table: its columns scroll inside the stage, every cell keeps its text, the page does not scroll', async ({ page }) => {
      await mapOn(page);
      await go(page, STREET + '?layout=table');
      await expect(page.locator('.map-table .jrn-sheet')).toBeVisible();
      expect(await spills(page)).toEqual([]);
      expect(await pageOver(page)).toBeLessThanOrEqual(0);
      // the stop heads and the layer labels stay put while the columns scroll
      const scroll = page.locator('.map-table-scroll');
      const lane = page.locator('.map-table .jrn-slane:not(.corner):not(.scrlane)').first();
      const before = await lane.boundingBox();
      await scroll.evaluate((s) => { s.scrollLeft = 300; });
      expect((await lane.boundingBox())!.x).toBeCloseTo(before!.x, 0);
      // a folded cell's +n names what it folds
      const more = page.locator('.map-table .jrn-smore').first();
      if (await more.count()) expect(await more.getAttribute('data-tip-text')).toBeTruthy();
    });

    /**
     * @covers packages/server/public/app/surfaces/journey-drill.js::jrnDrillMount
     * @covers packages/server/public/app/lib/fold-row.js::foldRow
     */
    test('the beats: the grid scrolls inside the stage, the seam card keeps its paths, the legend is one line — with the dock too', async ({ page }) => {
      await mapOn(page);
      await go(page, STREET + '?screen=2&action=6');
      await expect(page.locator('.map-act .jrn-lanes')).toBeVisible();
      expect(await spills(page)).toEqual([]);
      expect(await pageOver(page)).toBeLessThanOrEqual(0);
      const legendRows = () => page.locator('#jrn-dcap .legend').evaluate((lg) => {
        // one line: every item's middle within a few px of the first's (the +n chip is a little taller)
        const mids = [...lg.children].map((c) => c as HTMLElement).filter((c) => c.offsetWidth > 0).map((c) => c.offsetTop + c.offsetHeight / 2);
        return mids.every((m) => Math.abs(m - mids[0]) < 6) ? 1 : 2;
      });
      expect(await legendRows()).toBe(1);
      // the dock opens on the right: the grid and the legend measure again
      await page.keyboard.press('+');
      await expect(page.locator('.map-act.code')).toBeVisible();
      await expect.poll(legendRows).toBe(1);
      expect(await spills(page)).toEqual([]);
      expect(await pageOver(page)).toBeLessThanOrEqual(0);
    });

    /** @covers packages/server/public/app/lib/map-chips.js::foldMapChips */
    test('the street: the verdict chip on every screen card is whole, in both registers', async ({ page }) => {
      await mapOn(page);
      for (const lens of ['hybrid', 'business']) {
        await go(page, STREET + '?layout=screens&lens=' + lens);
        await expect(page.locator('.map-scr').first()).toBeVisible();
        await page.waitForTimeout(400);
        const cut = await page.locator('.map-scr').evaluateAll((cards) => cards.flatMap((card) => {
          const c = card.getBoundingClientRect();
          return [...card.querySelectorAll<HTMLElement>('.tc-ev, .k-ev')].filter((ev) => ev.offsetWidth > 0).filter((ev) => {
            const r = ev.getBoundingClientRect();
            return ev.offsetWidth < ev.scrollWidth || r.right > c.right + 1 || r.bottom > c.bottom + 1;
          }).map((ev) => (ev.textContent || '').trim());
        }));
        expect(cut, lens).toEqual([]);
        expect(await pageOver(page)).toBeLessThanOrEqual(0);
      }
    });

    /** @covers packages/server/public/app/surfaces/map.js::fitLanes */
    test('the lanes: the smallest text at the fit draws at 9 px or more, and no verdict is cut', async ({ page }) => {
      await mapOn(page);
      await go(page, '#/map?storyline=invoice&layout=lanes');
      await expect(page.locator('.map-lanes .ln-stage')).toHaveCount(5);
      await page.waitForTimeout(400);
      const min = await page.evaluate(() => {
        let m = 99;
        for (const el of document.querySelectorAll<HTMLElement>('.map-lanes *')) {
          if (!el.checkVisibility() || !el.offsetHeight) continue;
          if (![...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent || '').trim())) continue;
          const px = parseFloat(getComputedStyle(el).fontSize) * (el.getBoundingClientRect().height / el.offsetHeight);
          m = Math.min(m, px);
        }
        return m;
      });
      expect(min).toBeGreaterThanOrEqual(9);
      const cut = await page.locator('.map-lanes .ln-stage').evaluateAll((cards) => cards.flatMap((card) => {
        const c = card.getBoundingClientRect();
        return [...card.querySelectorAll<HTMLElement>('.tc-ev')].filter((ev) => ev.getBoundingClientRect().bottom > c.bottom + 1).map((ev) => ev.textContent);
      }));
      expect(cut).toEqual([]);
      expect(await pageOver(page)).toBeLessThanOrEqual(0);
    });
  });
}
