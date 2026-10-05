// The Map's zoom, stops, Fit, opening frame and chrome (docs/proposals/map-pass-2026-10-03.md §3 row Z).
//
// The engine (lib/map-canvas.js) must feel the same on every input: a mouse notch (⌘/Ctrl + wheel,
// |deltaY| 100), a trackpad (⌘/Ctrl + wheel, a few px per event, many events), a macOS pinch (a ctrlKey
// wheel with fractional deltas) and a Firefox mouse (deltaMode 1, three lines a notch) all settle on the same
// stops: the journey fitted, its calls readable (a data node's name at ≥ 11 px), one screen large with the
// *zoom in again to enter* hint — and only the gesture after that hint enters the screen.
//
// A street longer than the fixture's is shaped with page.route (ADR 8, the suite's pattern): Billing cycle's
// real answer with its screens repeated to fourteen, so the journey runs off the board and its fit is below
// the calls stop.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';

const FLOW = 'invoice-app::flow::billing-cycle';
const STREET = '#/map/' + encodeURIComponent(FLOW);
const WIDE = 14;

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
/** Billing cycle with its screens repeated to WIDE: each copy a screen of its own (its id suffixed), calls and all. */
async function stubWide(page: Page) {
  await page.route(/\/api\/journey\?entry=invoice-app(%3A%3A|::)flow(%3A%3A|::)billing-cycle(&steps=0)?$/, async (route) => {
    let data: any;
    try { data = await (await route.fetch()).json(); } catch { return; }
    const segs = data.summary.segments as any[];
    const withScreen = segs.filter((s) => s.screen);
    const out = segs.slice();
    for (let k = withScreen.length; k < WIDE; k++) {
      const src = withScreen[k % withScreen.length];
      out.push({ ...src, index: out.length, screen: { ...src.screen, id: src.screen.id + '#' + k, name: 'Step ' + (k + 1) } });
    }
    data.summary.segments = out;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
}
async function openStreet(page: Page, screens: number, plumb = true) {
  await go(page, STREET + (plumb ? '?plumb=1' : ''));
  await expect(page.locator(`.map-district[data-flow="${FLOW}"] .map-scr`)).toHaveCount(screens);
  await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
  // the open frame lands (it is refitted once the journey's walk arrives)
  await page.waitForTimeout(600);
}
const zoom = (page: Page) => page.locator('.map-zoomro').textContent().then((t) => Number(String(t).replace('×', '')));
/** The stops as the page computes them: the calls stop from the stylesheet, the enter stop from the stage. */
async function stops(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('.map-pd .nm') as HTMLElement;
    const board = document.querySelector('.map-board') as HTMLElement;
    // 236: a screen card's height (SH in surfaces/map.js; lane L made it 236 so a long name wraps)
    return { calls: 11 / parseFloat(getComputedStyle(el).fontSize), enter: (board.clientHeight * 0.64) / 236 };
  });
}
/** A data node's name in px on screen, measured. */
async function dataLabelPx(page: Page) {
  return page.evaluate(() => {
    const e = [...document.querySelectorAll('.map-pd .nm')].find((x) => (x as HTMLElement).offsetHeight) as HTMLElement;
    return parseFloat(getComputedStyle(e).fontSize) * e.getBoundingClientRect().height / e.offsetHeight;
  });
}

type Profile = { name: string; gesture: (page: Page) => Promise<void> };
const at = { x: 720, y: 560 };
/** Real wheel input, ⌘/Ctrl held: a mouse's notches, or a trackpad's many small steps. */
const ctrlWheel = (events: number, dy: number, gap: number) => async (page: Page) => {
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down('Control');
  for (let i = 0; i < events; i++) { await page.mouse.wheel(0, dy); if (gap) await page.waitForTimeout(gap); }
  await page.keyboard.up('Control');
};
/** A synthetic wheel the input layer cannot send: a pinch's fractional ctrlKey deltas, or Firefox's lines. */
const synthetic = (events: number, dy: number, mode: number) => async (page: Page) => {
  for (let i = 0; i < events; i++) {
    await page.dispatchEvent('.map-board', 'wheel', { deltaY: dy, deltaMode: mode, ctrlKey: true, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true });
  }
};
const PROFILES: Profile[] = [
  { name: 'mouse notches (⌘/Ctrl + wheel, 100 px)', gesture: ctrlWheel(5, -100, 30) },
  { name: 'trackpad steps (⌘/Ctrl + wheel, 4 px × 60)', gesture: ctrlWheel(60, -4, 0) },
  { name: 'pinch (ctrlKey wheel, 1.5 px × 80)', gesture: synthetic(80, -1.5, 0) },
  { name: 'mouse in lines (deltaMode 1, 3 lines × 5)', gesture: synthetic(5, -3, 1) },
];

test.describe('map — zoom stops, Fit, the opening frame and the chrome', () => {
  for (const p of PROFILES) {
    /**
     * @covers packages/server/public/app/lib/map-canvas.js::attachCanvas
     * @covers packages/server/public/app/lib/map-canvas.js::wheelFactor
     * @covers packages/server/public/app/lib/map-canvas.js::normaliseWheel
     * @covers packages/server/public/app/lib/map-canvas.js::settle
     * @covers packages/server/public/app/surfaces/map.js::mapStops
     */
    test(`${p.name}: settles on the calls stop, then one screen with the hint, and only then enters`, async ({ page }) => {
      await stubWide(page);
      await mapOn(page);
      await openStreet(page, WIDE);
      const s = await stops(page);
      const host = page.locator('.map-prop-host');
      const hint = page.locator('.map-hint');
      // one gesture from the journey: held at the calls stop, however many events it had
      await p.gesture(page);
      await expect.poll(() => zoom(page)).toBeCloseTo(s.calls, 1);
      expect(await dataLabelPx(page)).toBeGreaterThanOrEqual(11);
      await expect(host).toBeHidden();
      // the next: held at one screen large, and the hint says a zoom in would enter it
      await page.waitForTimeout(250);
      await p.gesture(page);
      await expect(hint).toHaveClass(/enter/);
      await expect.poll(() => zoom(page)).toBeCloseTo(s.enter, 1);
      await expect(host).toBeHidden();
      await expect(page.locator('.map-scr.near')).toHaveCount(1);
      // the one after the hint enters
      await page.waitForTimeout(700);
      await p.gesture(page);
      await expect(host).toBeVisible();
    });
  }

  /**
   * @covers packages/server/public/app/surfaces/map.js::mapZoom
   * @covers packages/server/public/app/surfaces/map.js::mapFit
   * @covers packages/server/public/app/surfaces/map.js::enterJourney
   * @covers packages/server/public/app/lib/map-canvas.js::nextStop
   */
  test('+ and − go stop to stop; − from inside a journey stops at it fitted before the board; Fit keeps the journey', async ({ page }) => {
    await stubWide(page);
    await mapOn(page);
    await openStreet(page, WIDE);
    const fitted = await zoom(page);
    const s = await stops(page);
    await page.mouse.move(at.x, at.y);
    await page.keyboard.press('+');
    await expect.poll(() => zoom(page)).toBeCloseTo(s.calls, 1);
    await page.keyboard.press('+');
    await expect.poll(() => zoom(page)).toBeCloseTo(s.enter, 1);
    await expect(page.locator('.map-hint')).toHaveClass(/enter/);
    // out: calls, then the journey fitted — the crumb keeps it the whole way
    await page.keyboard.press('-');
    await expect.poll(() => zoom(page)).toBeCloseTo(s.calls, 1);
    await page.keyboard.press('-');
    await expect.poll(() => zoom(page)).toBeCloseTo(fitted, 2);
    await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
    await expect(page.locator('.map-crumb')).toContainText('Billing cycle');
    // Fit from the calls stop fits the journey, never the board
    await page.locator('.map-tb[data-act="in"]').click();
    await expect.poll(() => zoom(page)).toBeCloseTo(s.calls, 1);
    await page.locator('.map-tb[data-act="fit"]').click();
    await expect.poll(() => zoom(page)).toBeCloseTo(fitted, 2);
    await expect(page.locator('.map-crumb')).toContainText('Billing cycle');
    await expect(page).toHaveURL(new RegExp('#/map/' + encodeURIComponent(FLOW)));
    await expect(page.locator('.map-lvls button[data-l="st"]')).toHaveClass(/on/);
    // − from the journey fitted is the board
    await page.keyboard.press('-');
    await expect(page.locator('.map-world')).toHaveClass(/lvl-nb/);
    await expect(page.locator('.map-lvls button[data-l="nb"]')).toHaveClass(/on/);
    // and Fit at the board fits every journey
    await page.keyboard.press('0');
    await expect(page.locator('.map-world')).toHaveClass(/lvl-nb/);
    await expect(page).toHaveURL(/#\/map(\?.*)?$/);
  });

  /**
   * @covers packages/server/public/app/surfaces/map.js::enterJourney
   * @covers packages/server/public/app/surfaces/map.js::journeyScale
   */
  test('a journey opens centred and fitted, its head at the top of the board with nothing above it', async ({ page }) => {
    await mapOn(page);
    await openStreet(page, 3, false);
    const f = await page.evaluate((flow) => {
      const b = document.querySelector('.map-board')!.getBoundingClientRect();
      const d = document.querySelector(`.map-district[data-flow="${flow}"]`)!.getBoundingClientRect();
      const others = [...document.querySelectorAll('.map-district')].filter((x) => (x as HTMLElement).dataset.flow !== flow)
        .map((x) => x.getBoundingClientRect()).filter((r) => r.bottom > b.top && r.top < d.top && r.right > b.left && r.left < b.right).length;
      return { left: d.left - b.left, right: b.right - d.right, top: d.top - b.top, others };
    }, FLOW);
    expect(Math.abs(f.left - f.right)).toBeLessThanOrEqual(2);
    expect(f.left).toBeGreaterThan(0);
    expect(f.top).toBeGreaterThanOrEqual(0);
    expect(f.top).toBeLessThanOrEqual(30);
    expect(f.others).toBe(0);
    // Billing cycle is short: fitted, its screens' names already read at ≥ 11 px
    const name = await page.evaluate(() => {
      const e = document.querySelector('.map-scr .nm') as HTMLElement;
      return parseFloat(getComputedStyle(e).fontSize) * e.getBoundingClientRect().height / e.offsetHeight;
    });
    expect(name).toBeGreaterThanOrEqual(11);
  });

  /**
   * @covers packages/server/public/app/surfaces/map.js::drawEdges
   * @covers packages/server/public/app/surfaces/map.js::onEdgeClick
   */
  test('screens past the edge are counted on an edge cue; a click slides the board to them', async ({ page }) => {
    await stubWide(page);
    await mapOn(page);
    await openStreet(page, WIDE);
    const right = page.locator('.map-edgecue.r');
    const left = page.locator('.map-edgecue.l');
    await expect(right).toBeVisible();
    await expect(left).toBeHidden();
    const n = Number(await right.locator('.n').textContent());
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(WIDE);
    await expect(right).toHaveText(new RegExp(n + ' more'));
    await expect(right.locator('.n')).toHaveAttribute('data-tip-id', 'number');
    // the count is the screens whose middle is past the right edge
    const past = await page.evaluate(() => {
      const b = document.querySelector('.map-board')!.getBoundingClientRect();
      return [...document.querySelectorAll('.map-district.focus .map-scr')].filter((e) => { const r = e.getBoundingClientRect(); return r.left + r.width / 2 > b.right; }).length;
    });
    expect(n).toBe(past);
    await right.click();
    await expect(left).toBeVisible();
    await expect.poll(async () => Number(await right.locator('.n').textContent().catch(() => '0')) || 0).toBeLessThan(n);
    // it never sits on a screen's name
    const clash = await page.evaluate(() => {
      const cue = document.querySelector('.map-edgecue.l')!.getBoundingClientRect();
      return [...document.querySelectorAll('.map-scr .nm')].some((e) => { const r = e.getBoundingClientRect(); return r.left < cue.right && cue.left < r.right && r.top < cue.bottom && cue.top < r.bottom; });
    });
    expect(clash).toBe(false);
  });

  /**
   * @covers packages/server/public/app/surfaces/map.js::mountMap
   */
  test('the toolbar is a band of its own: nothing on the board draws under it, at any zoom', async ({ page }) => {
    await stubWide(page);
    await mapOn(page);
    await openStreet(page, WIDE);
    for (let i = 0; i < 3; i++) {
      const r = await page.evaluate(() => {
        const chrome = document.querySelector('.map-chrome')!.getBoundingClientRect();
        const board = document.querySelector('.map-board')!.getBoundingClientRect();
        let under = 0;
        for (let x = 4; x < innerWidth; x += 12) {
          for (const y of [chrome.top + 3, chrome.top + chrome.height / 2, chrome.bottom - 2]) {
            const e = document.elementFromPoint(x, y);
            if (e && e.closest('.map-world')) under++;
          }
        }
        return { under, gap: board.top - chrome.bottom, bg: getComputedStyle(document.querySelector('.map-chrome')!).backgroundColor };
      });
      expect(r.under).toBe(0);
      expect(r.gap).toBeGreaterThanOrEqual(-1);
      expect(r.bg).not.toBe('rgba(0, 0, 0, 0)');
      await page.keyboard.press('+');
      await page.waitForTimeout(550);
    }
  });

  /**
   * @covers packages/server/public/app/lib/tooltip.js::initTips
   */
  test('on the map a tip opens on hover and a click does what its trigger sits on', async ({ page }) => {
    await mapOn(page);
    await openStreet(page, 3, false);
    const chip = page.locator(`.map-scr[data-flow="${FLOW}"][data-index="1"] .map-chip[data-tip-id]`).first();
    await chip.hover();
    const tip = page.locator('#fs-tip');
    await expect(tip).toBeVisible({ timeout: 1500 });
    // clear of what it describes
    const [a, b] = await Promise.all([chip.boundingBox(), tip.boundingBox()]);
    expect(a && b && (b.y >= a.y + a.height + 8 || b.y + b.height <= a.y - 8)).toBe(true);
    await chip.click();
    await expect(page.locator('.map-prop-host')).toBeVisible();
    await expect(page.locator('.map-prop-host')).toContainText('Invoice list');
  });
});
