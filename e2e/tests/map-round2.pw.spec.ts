// The Map, round 2 of the map pass: what the second eight-persona swarm found and the fixes hold.
//
// 1. The journey the reader opened is the current one. On a twelve-journey board (the fixture's design and
//    Billing cycle's walk, stubbed with page.route — ADR 8) the first journey is fourteen screens wide: opened at
//    its fitted floor its middle is off the stage, and the journey nearest the middle used to take the crumb, the
//    ring and the link. Opened by a click, a link, or h / l and Enter, it keeps all three, and p and j act on it.
// 2. The keys keep their promises: j / k walk the covers on the board, Enter opens, and ? toggles the legend with
//    a cover focused instead of opening that cover's tip.
// 3. The Affected mode reads at board altitude: Fit frames what reaches the seed, lit covers carry a corner
//    badge, *list these* writes the answer out and copies it, and the seed survives every level change.
// 4. A zoom never opens a hover tip.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';

const BASE_FLOW = 'invoice-app::flow::billing-cycle';
const ZOD = 'invoice-app::package::zod';
const N = 12, WIDE = 14;
const SYN = (i: number) => 'invoice-app::flow::syn-' + i;
// sorted by name, the wide one comes first and the board's next row sits right under it
const NAMES = [
  'A long journey across fourteen screens', 'Pay', 'Approve a correction request', 'Close the month', 'Export the ledger',
  'Invite a colleague', 'Archive old drafts', 'Credit a customer', 'Merge two customers', 'Split an invoice',
  'Review the weekly consolidation', 'Sign in',
];
const WIDE_ID = SYN(0);

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
async function stubBoard(page: Page) {
  await page.route(/\/api\/design\?/, async (r) => {
    let d: any;
    try { d = await (await r.fetch()).json(); } catch { return; }
    const src = d.designs[0];
    const base = src.flows.find((f: any) => f.id === 'billing-cycle');
    src.flows = NAMES.map((name, i) => ({ ...base, nodeId: SYN(i), id: 'syn-' + i, name }));
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify(d) });
  });
  await page.route(/\/api\/journey\?entry=/, async (r) => {
    const m = /::flow::syn-(\d+)$/.exec(new URL(r.request().url()).searchParams.get('entry') || '');
    if (!m) return r.continue();
    const i = Number(m[1]);
    let d: any;
    try { d = await (await r.fetch({ url: r.request().url().replace(/entry=[^&]*/, 'entry=' + encodeURIComponent(BASE_FLOW)) })).json(); } catch { return; }
    d.summary.links = { requires: [], leadsTo: i < N - 1 ? [{ id: SYN(i + 1), name: NAMES[i + 1] }] : [], partOf: [] };
    if (i === 0) {
      const segs = d.summary.segments as any[];
      const withScreen = segs.filter((s) => s.screen);
      const out = segs.slice();
      for (let k = withScreen.length; k < WIDE; k++) {
        const src = withScreen[k % withScreen.length];
        out.push({ ...src, index: out.length, screen: { ...src.screen, id: src.screen.id + '#' + k, name: 'Step ' + (k + 1) } });
      }
      d.summary.segments = out;
    }
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify(d) });
  });
}
async function boardReady(page: Page) {
  await expect(page.locator('.map-dcover')).toHaveCount(N);
  await expect(page.locator(`.map-district[data-flow="${WIDE_ID}"] .map-scr`)).toHaveCount(WIDE);
  await expect(page.locator('.map-world')).toHaveClass(/lvl-nb/);
}
/** The crumb's journey, the ringed district, and the journey the link names — they must agree. */
async function current(page: Page) {
  return page.evaluate(() => ({
    crumb: (document.querySelector('.map-crumb b') as HTMLElement | null)?.textContent || '',
    ring: [...document.querySelectorAll('.map-district.focus')].map((d) => (d as HTMLElement).dataset.flow),
    hash: decodeURIComponent(location.hash),
  }));
}
async function expectCurrent(page: Page, id: string, name: string) {
  await expect.poll(async () => (await current(page)).crumb).toBe(name);
  const c = await current(page);
  expect(c.ring).toEqual([id]);
  expect(c.hash).toContain('#/map/' + id);
}
/** Screens of the journey drawn inside the board's box. */
async function screensOnStage(page: Page, id: string) {
  return page.evaluate((flow) => {
    const b = (document.querySelector('.map-board') as HTMLElement).getBoundingClientRect();
    return [...document.querySelectorAll(`.map-scr[data-flow="${flow}"]`)].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.right > b.left && r.left < b.right && r.bottom > b.top && r.top < b.bottom;
    }).length;
  }, id);
}
async function pAndJ(page: Page) {
  await page.keyboard.press('p');
  await expect(page.locator('.map-world')).not.toHaveClass(/no-plumb/);
  await page.waitForTimeout(500);
  await page.keyboard.press('j');
  await page.waitForTimeout(600);
  await expectCurrent(page, WIDE_ID, NAMES[0]);
  expect(await screensOnStage(page, WIDE_ID)).toBeGreaterThan(0);
  // the street's head is on the stage, not an empty band above it
  const headTop = await page.evaluate((flow) => {
    const b = (document.querySelector('.map-board') as HTMLElement).getBoundingClientRect();
    return (document.querySelector(`.map-district[data-flow="${flow}"] .map-dhead .nm`) as HTMLElement).getBoundingClientRect().top - b.top;
  }, WIDE_ID);
  expect(headTop).toBeGreaterThanOrEqual(-4);
  expect(headTop).toBeLessThan(120);
}

test.describe('map round 2 — the journey the reader opened', () => {
  /**
   * @covers packages/server/public/app/surfaces/map.js::openedJourney
   * @covers packages/server/public/app/surfaces/map.js::onCanvasChange
   * @covers packages/server/public/app/surfaces/map.js::enterJourney
   */
  test('the widest journey opened by a click keeps the crumb, the ring and the link; p and j act on it', async ({ page }) => {
    await stubBoard(page);
    await mapOn(page);
    await go(page, '#/map');
    await boardReady(page);
    await page.locator(`.map-dcover[data-enter="${WIDE_ID}"]`).click();
    await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
    await page.waitForTimeout(600);
    await expectCurrent(page, WIDE_ID, NAMES[0]);
    await pAndJ(page);
  });

  test('opened by a link, it is the current journey too', async ({ page }) => {
    await stubBoard(page);
    await mapOn(page);
    await go(page, '#/map');
    await boardReady(page);
    await go(page, '#/map/' + encodeURIComponent(WIDE_ID));
    await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
    await page.waitForTimeout(700);
    await expectCurrent(page, WIDE_ID, NAMES[0]);
    await pAndJ(page);
  });

  test('opened by h / l and Enter from the board, it is the current journey too', async ({ page }) => {
    await stubBoard(page);
    await mapOn(page);
    await go(page, '#/map');
    await boardReady(page);
    await page.keyboard.press('l');
    await page.keyboard.press('l');
    await page.keyboard.press('h');
    await expect(page.locator(`.map-dcover[data-enter="${WIDE_ID}"]`)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
    await page.waitForTimeout(700);
    await expectCurrent(page, WIDE_ID, NAMES[0]);
    // the keyboard landed on its first screen, not a neighbour's
    await expect(page.locator(`.map-scr[data-flow="${WIDE_ID}"][data-index="0"]`)).toBeFocused();
    await pAndJ(page);
  });
});

test.describe('map round 2 — keys', () => {
  /**
   * @covers packages/server/public/app/surfaces/map.js::mapKey
   * @covers packages/server/public/app/surfaces/map.js::enterCover
   * @covers packages/server/public/app/lib/tooltip.js::tipKeydown
   */
  test('j j Enter on the board opens the second journey; ? toggles the legend with a cover focused, never its tip', async ({ page }) => {
    await stubBoard(page);
    await mapOn(page);
    await go(page, '#/map');
    await boardReady(page);
    // exactly as the reviewer pressed them
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await expect(page.locator('.map-dcover').nth(0)).not.toBeFocused();
    const second = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.enter);
    expect(second).toBeTruthy();
    await page.keyboard.press('Enter');
    await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
    await expect(page).toHaveURL(new RegExp('#/map/' + encodeURIComponent(second!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '|#/map/' + second!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await page.keyboard.press('Escape');
    await expect(page.locator('.map-world')).toHaveClass(/lvl-nb/);
    // a cover has the focus (Esc lands on it): ? is the legend's, both ways
    await expect(page.locator('.map-dcover:focus')).toHaveCount(1);
    await page.keyboard.press('?');
    await expect(page.locator('.map-legend')).toBeVisible();
    await expect(page.locator('#fs-tip')).toBeHidden();
    await expect(page.locator('#keymap')).not.toHaveClass(/\bopen\b/);
    await page.keyboard.press('?');
    await expect(page.locator('.map-legend')).toBeHidden();
  });

  test.describe('first visit', () => {
    test.use({ mapLegendSeen: false });
    test('the legend that opens by itself takes no focus and leaves the toolbar\'s ? uncovered', async ({ page }) => {
      await mapOn(page);
      await go(page, '#/map');
      await expect(page.locator('.map-legend')).toBeVisible();
      expect(await page.evaluate(() => !!document.activeElement?.closest('.map-legend'))).toBe(false);
      const [q, lg] = await Promise.all([
        page.locator('.map-tools [data-act="legend"]').boundingBox(),
        page.locator('.map-legend').boundingBox(),
      ]);
      expect(lg!.y).toBeGreaterThanOrEqual(q!.y + q!.height);
    });
  });
});

test.describe('map round 2 — zoom', () => {
  /**
   * @covers packages/server/public/app/lib/tooltip.js::quietHoverTips
   * @covers packages/server/public/app/surfaces/map.js::settleJourney
   */
  test('a ⌘-wheel notch over a cover opens no tip, and the point under the pointer stays under it', async ({ page }) => {
    await stubBoard(page);
    await mapOn(page);
    await go(page, '#/map');
    await boardReady(page);
    const cov = (await page.locator(`.map-dcover[data-enter="${WIDE_ID}"]`).boundingBox())!;
    const at = { x: Math.min(cov.x + 400, 1300), y: cov.y + 50 };
    const worldAt = () => page.evaluate(([x, y]) => {
      const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/.exec((document.querySelector('.map-world') as HTMLElement).style.transform)!;
      const b = (document.querySelector('.map-board') as HTMLElement).getBoundingClientRect();
      return { x: (x - b.left - +m[1]) / +m[3], y: (y - b.top - +m[2]) / +m[3], s: +m[3] };
    }, [at.x, at.y]);
    const before = await worldAt();
    await page.mouse.move(at.x, at.y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await page.waitForTimeout(900);
    await expect(page.locator('#fs-tip')).toBeHidden();
    // more notches, one gesture each, through the journey stop: the world point under the pointer moves by at most
    // the stage's own padding (in screen px), never the jump to the journey's start
    for (let i = 0; i < 6; i++) {
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -100);
      await page.keyboard.up('Control');
      await page.waitForTimeout(260);
    }
    await page.waitForTimeout(700);
    const after = await worldAt();
    expect(after.s).toBeGreaterThan(0.5);
    expect(Math.abs(after.x - before.x) * after.s).toBeLessThan(80);
    await expect(page.locator('#fs-tip')).toBeHidden();
    // the open journey's name is on the stage
    const nm = (await page.locator(`.map-district[data-flow="${WIDE_ID}"] .map-dhead .nm`).boundingBox())!;
    const board = (await page.locator('.map-board').boundingBox())!;
    expect(nm.x).toBeGreaterThanOrEqual(board.x - 1);
    expect(nm.y).toBeGreaterThanOrEqual(board.y - 1);
  });

  test('a link naming only the zoom opens at that zoom', async ({ page }) => {
    await stubBoard(page);
    await mapOn(page);
    await go(page, '#/map');
    await boardReady(page);
    await go(page, '#/map/' + encodeURIComponent(WIDE_ID) + '?z=0.75');
    await expect(page.locator('.map-zoomro')).toHaveText('×0.75');
  });
});

test.describe('map round 2 — the Affected mode at board altitude', () => {
  /**
   * @covers packages/server/public/app/surfaces/map.js::fitAffected
   * @covers packages/server/public/app/surfaces/map-affected.js::affectedListHtml
   * @covers packages/server/public/app/surfaces/map-affected.js::affectedExport
   * @covers packages/server/public/app/surfaces/map-affected.js::paintDistrict
   */
  test('Fit frames what reaches the seed; lit covers carry a corner badge; the list writes it out and copies it', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mapOn(page);
    await go(page, '#/map?affected=' + encodeURIComponent('package:' + ZOD));
    await expect(page.locator('.map-affbar .map-affname')).toHaveText('zod');
    await expect(page.locator('.map-district.aff-hit')).toHaveCount(3);
    // (c) every lit journey carries one large badge on its corner, and the bar says what the counts are over
    await expect(page.locator('.map-district.aff-hit > .map-affb.corner')).toHaveCount(3);
    await expect(page.locator('.map-affbar')).toContainText('in 3 journeys');
    await expect(page.locator('.map-affbar')).toContainText('(reached by walks)');
    // (e) the seed survives the levels and the zoom's link write
    await page.locator('.map-lvls button[data-l="st"]').click();
    await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
    await expect(page.locator('.map-affbar')).toBeVisible();
    await expect(page).toHaveURL(/affected=package/);
    await page.locator('.map-lvls button[data-l="nb"]').click();
    await expect(page.locator('.map-world')).toHaveClass(/lvl-nb/);
    await expect(page.locator('.map-affbar')).toBeVisible();
    await expect(page).toHaveURL(/affected=package/);
    await page.mouse.move(700, 500);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await expect(page).toHaveURL(/z=.*affected=package|affected=package.*z=/);
    // (b) Fit frames the three reached districts, each wholly on the stage
    await page.locator('.map-tools [data-act="fit"]').click();
    await page.waitForTimeout(600);
    const inside = await page.evaluate(() => {
      const b = (document.querySelector('.map-board') as HTMLElement).getBoundingClientRect();
      return [...document.querySelectorAll('.map-district.aff-hit')].every((e) => {
        const r = e.getBoundingClientRect();
        return r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
      });
    });
    expect(inside).toBe(true);
    await expect(page).toHaveURL(/affected=package/);
    // (d) the list: journeys, screens once each, and the copy as CSV and JSON v0
    await page.locator('.map-affbar [data-act="aff-list"]').click();
    const list = page.locator('.map-afflist');
    await expect(list).toBeVisible();
    await expect(list.locator('.al-row[data-kind="journey"]')).toHaveCount(3);
    await expect(list.locator('.mp-affbound')).toBeVisible();
    await list.locator('[data-act="aff-copy"][data-kind="csv"]').click();
    await expect(page.locator('.map-toast')).toBeVisible();
    const csv = await page.evaluate(() => navigator.clipboard.readText());
    expect(csv.split('\n')[0]).toBe('seed,distance,kind,id,name,journeys,owner,evidence');
    await list.locator('[data-act="aff-copy"][data-kind="json"]').click();
    const json = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    expect([json.format, json.version, json.frozen]).toEqual(['farsight-affected', 0, false]);
    expect(json.rows.filter((r: any) => r.kind === 'journey')).toHaveLength(3);
    const screens = json.rows.filter((r: any) => r.kind === 'screen').map((r: any) => r.id);
    expect(new Set(screens).size).toBe(screens.length);
    // Esc closes the list first, then the mode
    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
    await expect(page.locator('.map-affbar')).toBeVisible();
  });

  test('a longer reach that finds nothing new says so', async ({ page }) => {
    await mapOn(page);
    await go(page, '#/map?affected=' + encodeURIComponent('package:' + ZOD) + '&ahops=4');
    await expect(page.locator('.map-district.aff-hit')).toHaveCount(3);
    await expect(page.locator('.map-affnomore')).toHaveText('nothing more past 1');
  });
});
