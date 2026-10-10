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
  await expect(page.locator('.map-act-scr.on')).toContainText('Invoice list');
  expect(await hash(page)).toContain('screen=2&action=1');
  // ← → walk the beats; the address follows
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => hash(page)).toContain('beat=3');
  await expect(page.locator('.map-act .jrn-dbh.on')).toHaveAttribute('data-beat', '2');
  // + opens the code: the drill's inspector as the dock, on its CODE tab
  await page.keyboard.press('+');
  await expect(page.locator('.map-act.code #jrn-insp')).toBeVisible();
  await expect(pressed(page, 'code')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#jrn-insp .tabs button.on')).toHaveText('Code');
  await expect.poll(() => hash(page)).toMatch(/dock=(inline|bottom|right)/);
  // the dock's place is one switch, remembered as the journey's
  await page.locator('.map-act-dock [data-dock="right"]').click();
  await expect(page.locator('.map-act')).toHaveAttribute('data-dock', 'right');
  expect(await page.evaluate(() => localStorage.getItem('fs-jrn-dock'))).toBe('right');
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
  await go(page, STREET);
  await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
  await page.locator('.map-layout [data-layout="table"]').click();
  await expect(page.locator('.map-table .jrn-sheet')).toBeVisible();
  await expect(page.locator('.map-table .jrn-sbh[data-col]')).toHaveCount(8);
  // the street head's facts come with it: the counts, the storyline position, the lifecycle, Save
  await expect(page.locator('.map-table-head .agg')).toContainText('3 screens');
  await expect(page.locator('.map-table-head .facts [data-export="street"]')).toBeVisible();
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
