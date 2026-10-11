// One surface, five altitudes (lanes round 2026-10-10, proposal 1 steps 1–2): the Map keeps the frame and gains the
// two stops only the journey view had — an action's beats, and the code behind a beat — with one LAYOUT control whose
// choices change per stop. On the fixture: the storyline board → Billing cycle → Invoice list → an action → its beats
// → the code in the dock, the table layout at the journey stop, and the address that names every stop.
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
async function go(page: Page, hash: string) {
  await page.evaluate((h) => { location.hash = h; }, hash);
}
const hash = (page: Page) => page.evaluate(() => decodeURIComponent(location.hash));
const pressed = (page: Page, l: string) => page.locator(`.map-lvls button[data-l="${l}"]`);

test('one zoom from the storyline board to a beat\'s code, with no change of surface', async ({ page }) => {
  await mapOn(page);
  await go(page, '#/map?storyline=invoice');
  // the level control has five stops, the board's LAYOUT is its one choice (nothing to pick)
  await expect(page.locator('.map-lvls button')).toHaveCount(5);
  await page.locator(`.map-dcover[data-enter="${FLOW}"]`).click();
  await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
  await expect(page.locator('.map-layout [data-layout="table"]')).toBeVisible();
  // the crumb strip names the storyline and the journey's step in it
  await expect(page.locator('.map-crumb')).toContainText('An invoice, end to end');
  await expect(page.locator('.map-crumb b')).toHaveText('Billing cycle');
  // the screen, then + past it: its first action, drawn as the drill's lanes on the Map's own stage
  await page.locator(`.map-scr[data-flow="${FLOW}"][data-index="1"]`).click();
  await expect(page.locator('.mp')).toBeVisible();
  await page.keyboard.press('+');
  await expect(page.locator('.map-act .jrn-lanes')).toBeVisible();
  await expect(pressed(page, 'act')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.map-crumb')).toContainText('screen 2 of 3');
  await expect(page.locator('.map-crumb')).toContainText('action 1 of 6');
  // the caption under the screen strip counts what the crumb counts, with its scope (swarm round 3, one unit per panel)
  await expect(page.locator('#jrn-dcap')).toContainText('action 1 of 6 on this screen');
  await expect(page.locator('.map-act-scr.on')).toContainText('Invoice list');
  expect(await hash(page)).toContain('screen=2&action=1');
  // ← → walk the beats; the address follows
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => hash(page)).toContain('beat=3');
  await expect(page.locator('.map-act .jrn-dbh.on')).toHaveAttribute('data-beat', '2');
  // + opens the code: the drill's inspector in the Map's one dock, on its CODE tab
  await page.keyboard.press('+');
  await expect(page.locator('.map-act.code')).toBeVisible();
  await expect(page.locator('.map-dock #jrn-insp')).toBeVisible();
  await expect(pressed(page, 'code')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#jrn-insp .tabs button.on')).toHaveText('Code');
  await expect.poll(() => hash(page)).toMatch(/dock=(inline|bottom|right)/);
  // the dock's place is one switch in its pinned header, remembered as the journey's
  await page.locator('.map-dock .md-place [data-dock="bottom"]').click();
  await expect(page.locator('.map-act')).toHaveAttribute('data-dock', 'bottom');
  await expect(page.locator('.map-dock')).toHaveAttribute('data-place', 'bottom');
  expect(await page.evaluate(() => localStorage.getItem('fs-jrn-dock'))).toBe('bottom');
  // in place: the inspector goes back under the beats, the dock (holding nothing else) closes
  await page.locator('.map-dock .md-place [data-dock="inline"]').click();
  await expect(page.locator('.map-act #jrn-insp')).toBeVisible();
  await expect(page.locator('.map-dock')).toBeHidden();
  await page.evaluate(() => localStorage.setItem('fs-jrn-dock', 'right'));
  // − closes the code, − again goes back to the screen
  await page.keyboard.press('-');
  await expect(page.locator('.map-act')).not.toHaveClass(/code/);
  await page.keyboard.press('-');
  await expect(page.locator('.map-act-host')).toBeHidden();
  await expect(page.locator('.mp')).toBeVisible();
});

test('the action stop draws Finalize invoice as five beats, and the ladder is its other layout', async ({ page }) => {
  await mapOn(page);
  await go(page, STREET + '?screen=2&action=6');
  await expect(page.locator('.map-act .jrn-lanes')).toBeVisible();
  await expect(page.locator('.map-act .jrn-dbh[data-beat]')).toHaveCount(5);
  await expect(page.locator('.map-crumb')).toContainText('action 6 of 6');
  await expect(page.locator('.map-crumb b').last()).toHaveText('Finalize invoice');
  // the first draw of the stop is measured; on the fixture it is well under the round's 300 ms
  const ms = Number(await page.locator('.map-act-host').getAttribute('data-draw-ms'));
  expect(ms).toBeLessThan(300);
  await page.locator('.map-layout [data-layout="ladder"]').click();
  await expect(page.locator('.map-act .jrn-ladder')).toBeVisible();
  expect(await hash(page)).toContain('layout=ladder');
  await page.locator('.map-layout [data-layout="beats"]').click();
  await expect(page.locator('.map-act .jrn-lanes')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.mp')).toBeVisible();
});

test('a call card\'s door and a property call row open the action stop', async ({ page }) => {
  await mapOn(page);
  await go(page, STREET + '?plumb=1');
  const call = page.locator(`.map-pl[data-flow="${FLOW}"][data-si="1"]`).first();
  await call.click();
  await page.locator('.map-xcard .map-walk').click();
  await expect(page.locator('.map-act .jrn-lanes')).toBeVisible();
  await expect(page.locator('.map-crumb')).toContainText('screen 2 of 3');
  await page.keyboard.press('Escape');
  await expect(page.locator('.mp')).toBeVisible();
  await page.locator('.mp .mp-walk').first().click();
  await expect(page.locator('.map-act .jrn-lanes')).toBeVisible();
});

test('the table layout draws the Sheet in place of the street, and a column opens its beats', async ({ page }) => {
  await mapOn(page);
  await go(page, STREET + '?layout=screens');
  await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
  await page.locator('.map-layout [data-layout="table"]').click();
  await expect(page.locator('.map-table .jrn-sheet')).toBeVisible();
  await expect(page.locator('.map-table .jrn-sbh[data-col]')).toHaveCount(8);
  // the street head's facts come with it: the counts, the storyline position, the lifecycle, Save
  await expect(page.locator('.map-jhead .agg')).toContainText('3 screens');
  // Save is the toolbar's at every stop; below the board it saves the stop on screen
  await expect(page.locator('.map-chrome [data-export="street"]')).toBeVisible();
  await expect.poll(() => hash(page)).toContain('layout=table');
  // a reload of the link draws the table again
  await mapOn(page);
  await go(page, STREET + '?layout=table');
  await expect(page.locator('.map-table .jrn-sheet')).toBeVisible();
  await page.locator('.map-table .jrn-sbh[data-col="6"]').click();
  await expect(page.locator('.map-act .jrn-dbh[data-beat]')).toHaveCount(5);
  await expect(page.locator('.map-crumb')).toContainText('action 6 of 6');
  // back up two stops and switch the layout back: the street again
  await page.keyboard.press('Escape');
  await expect(page.locator('.mp')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.map-layout [data-layout="screens"]').click();
  await expect(page.locator('.map-table-host')).toBeHidden();
});

test('the address of every stop round-trips through route-url.js', async ({ page }) => {
  await mapOn(page);
  const out = await page.evaluate(async (flow) => {
    // a URL the browser resolves; typed loosely, the module is plain JS served by the viewer
    const url = '/app/lib/route-url.js';
    const R: any = await import(/* @vite-ignore */ url);
    const cases = [{ screen: 2, action: 6, beat: 4, dock: 'right' }, { screen: 1, action: 1 }, { layout: 'table' }, { screen: 2, action: 3, layout: 'ladder' }];
    return cases.map((o) => ({ o, back: R.mapStopOf(R.mapStopHash(flow, o)) }));
  }, FLOW);
  for (const { o, back } of out) {
    expect(back.screen).toBe((o as any).screen ?? null);
    expect(back.action).toBe((o as any).action ?? null);
    expect(back.layout).toBe((o as any).layout ?? null);
  }
  // and the Map lands on the stop the address names
  await go(page, STREET + '?screen=2&action=6&beat=4&dock=right');
  await expect(page.locator('.map-act.code')).toBeVisible();
  await expect(page.locator('.map-act')).toHaveAttribute('data-dock', 'right');
  await expect(page.locator('.map-act .jrn-dbh.on')).toHaveAttribute('data-beat', '3');
});

// ── the chrome holds still (cleanup pass 2026-10-11, lane P1) ────────────────────────────────────────────────────
// The owner's words: "the guided journey buttons should be fixed at the top, it's too difficult to know where the
// buttons are as they keep changing", and the head that rode over the first screen card in the sweep's shots.
type Box = { x: number; y: number; width: number; height: number };
const meets = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
const WIDTHS = [{ width: 1440, height: 900 }, { width: 1280, height: 800 }];

/**
 * @covers packages/server/public/app/surfaces/map.js::drawHead
 * @covers packages/server/public/app/surfaces/map.js::headBarHtml
 */
test('the journey head sits above the stage: the first screen card is never under it, in every register, at 1440 and 1280', async ({ page }) => {
  await mapOn(page);
  for (const size of WIDTHS) {
    await page.setViewportSize(size);
    for (const lens of ['business', 'hybrid', 'code']) {
      await go(page, STREET + '?layout=screens&lens=' + lens);
      const head = page.locator(`.map-jhead[data-flow="${FLOW}"]`);
      await expect(head).toBeVisible();
      const first = page.locator(`.map-district[data-flow="${FLOW}"] .map-scr`).first();
      await expect(first).toBeVisible();
      await page.waitForTimeout(500);
      const h = (await head.boundingBox())!, c = (await first.boundingBox())!, b = (await page.locator('.map-board').boundingBox())!;
      expect(meets(h, c), `${lens} at ${size.width}: the head and the first card`).toBe(false);
      // the head is chrome, not the world: the board starts under it
      expect(b.y).toBeGreaterThanOrEqual(h.y + h.height - 1);
      // what the first card's middle shows is the card
      const mid = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.map-scr'), [c.x + c.width / 2, c.y + Math.min(c.height / 2, 40)]);
      expect(mid).toBe(true);
    }
  }
});

/**
 * @covers packages/server/public/app/surfaces/map.js::chromeHtml
 * @covers packages/server/public/app/surfaces/map.js::fitChrome
 */
test('WALK keeps one place at the five stops, at 1440 and 1280', async ({ page }) => {
  await mapOn(page);
  for (const size of WIDTHS) {
    await page.setViewportSize(size);
    const walk = page.locator('.map-chrome .map-tb-walk');
    const boxes: Box[] = [];
    const at = async () => { await expect(walk).toBeVisible(); await page.waitForTimeout(250); boxes.push((await walk.boundingBox())!); };
    await go(page, '#/map?storyline=invoice');
    await expect(page.locator('.map-world')).toHaveClass(/lvl-nb/);
    await at();
    await go(page, STREET + '?layout=screens');
    await expect(pressed(page, 'st')).toHaveAttribute('aria-pressed', 'true');
    await at();
    await page.locator('.map-lvls [data-l="pr"]').click();
    await expect(page.locator('.mp')).toBeVisible();
    await expect(pressed(page, 'pr')).toHaveAttribute('aria-pressed', 'true');
    await at();
    await go(page, STREET + '?screen=2&action=1');
    await expect(pressed(page, 'act')).toHaveAttribute('aria-pressed', 'true');
    await at();
    await page.keyboard.press('+');
    await expect(pressed(page, 'code')).toHaveAttribute('aria-pressed', 'true');
    await at();
    for (const b of boxes.slice(1)) {
      expect(Math.abs(b.x - boxes[0].x), `x at ${size.width}`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(b.y - boxes[0].y), `y at ${size.width}`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(b.width - boxes[0].width)).toBeLessThanOrEqual(0.5);
    }
    // the right end of the toolbar's second row
    expect(boxes[0].x + boxes[0].width).toBeGreaterThan(size.width - 30);
  }
});

/**
 * @covers packages/server/public/app/lib/map-dock.js::openPanel
 * @covers packages/server/public/app/surfaces/map.js::onDockChange
 * @covers packages/server/public/app/lib/tour.js::openWalk
 */
test('the dock takes its own column: the walk, the code and a table part never draw over the stage', async ({ page }) => {
  await mapOn(page);
  for (const size of WIDTHS) {
    await page.setViewportSize(size);
    await page.evaluate(() => localStorage.setItem('fs-jrn-dock', 'right'));
    // the walk at the journey stop: its stop line on top, ASK at its foot
    await go(page, STREET + '?layout=screens');
    await expect(page.locator(`.map-district[data-flow="${FLOW}"] .map-scr`).first()).toBeVisible();
    await page.locator('.map-chrome .map-tb-walk').click();
    const dock = page.locator('.map-dock');
    await expect(dock.locator('.map-tour .tw-pin .tw-of')).toContainText(/stop 1 of/);
    await expect(dock.locator('.map-tour .tw-ask')).toBeVisible();
    const d1 = (await dock.boundingBox())!;
    expect(Math.round(d1.width)).toBe(size.width >= 1400 ? 360 : 320);
    expect(meets(d1, (await page.locator('.map-board').boundingBox())!)).toBe(false);
    // the walk at the table and at an action: it shows there too, and the stop keeps its own layout
    await go(page, STREET + '?layout=table');
    await expect(page.locator('.map-table .jrn-sheet')).toBeVisible();
    // the walk is still a tab of the dock (a part's code may have the front): it shows there too
    await dock.locator('.md-tab[data-panel="walk"]').click();
    await expect(dock.locator('.map-tour')).toBeVisible();
    expect(meets((await dock.boundingBox())!, (await page.locator('.map-table-host').boundingBox())!)).toBe(false);
    await go(page, STREET + '?screen=2&action=1');
    await expect(page.locator('.map-act .jrn-lanes')).toBeVisible();
    await dock.locator('.md-tab[data-panel="walk"]').click();
    await expect(dock.locator('.map-tour')).toBeVisible();
    // opened at an action, the walk starts at that action's screen and leaves the reader at the action stop
    await page.locator('.map-chrome .map-tb-walk').click();
    await expect(dock.locator('.map-tour')).toBeHidden();
    await page.locator('.map-chrome .map-tb-walk').click();
    await expect(dock.locator('.map-tour .tw-stop-title')).toContainText('Invoice list');
    await expect(page.locator('.map-act .jrn-lanes')).toBeVisible();
    // + the code: a second panel in the same dock, the same width
    await page.keyboard.press('+');
    await expect(dock.locator('.md-tab')).toHaveCount(2);
    await expect(dock.locator('#jrn-insp')).toBeVisible();
    const d2 = (await dock.boundingBox())!;
    expect(Math.abs(d2.width - d1.width)).toBeLessThanOrEqual(0.5);
    expect(meets(d2, (await page.locator('.map-act-host').boundingBox())!)).toBe(false);
    while (await dock.isVisible()) await page.locator('.map-dock .md-x').click();
    await expect(dock).toBeHidden();
  }
});

/**
 * @covers packages/server/public/app/surfaces/map-stops.js::layoutToolHtml
 * @covers packages/server/public/app/surfaces/journey-drill.js::jrnDrillRailHtml
 * @covers packages/server/public/app/surfaces/map.js::drawJourneyLanes
 */
test('the journey stop offers screens · lanes · table · drill: drill is the action rail over the beats, lanes the journey\'s lanes', async ({ page }) => {
  await mapOn(page);
  await go(page, STREET + '?layout=screens');
  await expect(page.locator('.map-layout .map-seg[data-layout]')).toHaveText(['screens', 'lanes', 'table', 'drill']);
  await page.locator('.map-layout [data-layout="lanes"]').click();
  await expect(page.locator('.map-jlanes-host .map-lanes .ln-stage').first()).toBeVisible();
  await expect(page.locator('.map-jlanes-host .ln-lane.persona')).not.toHaveCount(0);
  await expect.poll(() => hash(page)).toContain('layout=lanes');
  await page.locator('.map-layout [data-layout="drill"]').click();
  // the drill is the action stop with the rail in view: every action of the journey as a stop, the first one on
  const stops = page.locator('.map-act .map-rail .jrn-stop');
  await expect(stops).toHaveCount(8);
  await expect(stops.nth(0)).toHaveClass(/\bon\b/);
  await expect(page.locator('.map-act .map-rail .jrn-rscr')).not.toHaveCount(0);
  await expect(page.locator('.map-act .jrn-lanes')).toBeVisible();
  await expect(pressed(page, 'act')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => hash(page)).toContain('layout=drill');
  // ] moves along the rail; a click on a stop opens that action
  await page.keyboard.press(']');
  await expect(stops.nth(1)).toHaveClass(/\bon\b/);
  await stops.nth(5).click();
  await expect(page.locator('.map-act .map-rail .jrn-stop').nth(5)).toHaveClass(/\bon\b/);
  await expect(page.locator('.map-crumb')).toContainText('action');
  // ACTION and CODE are reachable from the journey stop: the first action, and the code in the dock
  await go(page, STREET + '?layout=screens');
  await pressed(page, 'code').click();
  await expect(page.locator('.map-dock #jrn-insp')).toBeVisible();
  await expect(pressed(page, 'code')).toHaveAttribute('aria-pressed', 'true');
});
