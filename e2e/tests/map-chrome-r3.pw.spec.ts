// The round-3 swarm's chrome and layout (2026-10-11, lane C3), each at 1440 and 1280 on the fixture: the lanes keep
// their words (a name never breaks inside a word, a pill prints its record and its status whole, one journey's lanes
// count over the journey), the Affected bar is a third row so rows 1 and 2 never move, LIST THESE writes the tests out
// in the dock with their spec file and line, the lifecycle line folds to `+n` instead of losing its last statuses, a
// click closes the tip it opened, the level's last stop says LINES (only the register says CODE), the gate card
// scrolls to its tests, and the lifecycle table stacks in a narrow dock. READ-ONLY never folding is in chrome.pw.spec.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady, openJourneyAt } from './support';

const FLOW = 'invoice-app::flow::billing-cycle';
const STREET = '#/map/' + encodeURIComponent(FLOW);
const TABLE = 'invoice-app::table::invoices';
const GATE = 'invoice-app::guard::requireScope(billing:read)';

async function mapOn(page: Page) {
  await gotoReady(page, '#/portfolio');
  await page.evaluate(() => {
    const S = (window as any).S;
    S.SETTINGS = Object.assign({}, S.SETTINGS, { flags: Object.assign({}, S.SETTINGS && S.SETTINGS.flags, { map: true }) });
  });
}
const go = (page: Page, hash: string) => page.evaluate((h) => { location.hash = h; }, hash);
const box = async (page: Page, sel: string) => {
  const b = await page.locator(sel).first().boundingBox();
  return b ? [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] : null;
};

for (const [W, H] of [[1440, 900], [1280, 800]]) {
  test.describe(`round-3 chrome at ${W}`, () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: W, height: H }); });

    /**
     * @covers packages/server/public/app/surfaces/map-lanes.js::fitLaneText
     * @covers packages/server/public/app/surfaces/map-lanes.js::lanesHtml
     * @covers packages/server/public/app/lib/map-lanes-model.js::laneLayout
     */
    test('lanes keep their words: no name breaks inside a word, no pill ellipsizes, one journey counts over the journey', async ({ page }) => {
      await mapOn(page);
      await go(page, '#/map?storyline=invoice&layout=lanes');
      await expect(page.locator('.map-lanes .ln-stage')).toHaveCount(5);
      await expect(page.locator('.map-lanes .ln-foot .rd')).toHaveCount(0);
      const broken = await page.evaluate(() => {
        const c = document.createElement('canvas').getContext('2d')!;
        return [...document.querySelectorAll<HTMLElement>('.map-lanes .ln-stage .nm')].filter((el) => {
          const cs = getComputedStyle(el); c.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
          const ls = parseFloat(cs.letterSpacing) || 0;
          return el.textContent!.split(/\s+/).some((w) => c.measureText(w.toUpperCase()).width + ls * w.length > el.clientWidth + 1);
        }).map((el) => el.textContent);
      });
      expect(broken).toEqual([]);
      // a pill's record, move and writer never ellipsize, and the pill holds them all
      const cut = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.map-lanes .ln-pill')]
        .filter((p) => p.scrollHeight > p.clientHeight + 1 || [...p.querySelectorAll<HTMLElement>('.rec,.w,.by')].some((x) => x.scrollWidth > x.clientWidth + 1))
        .map((p) => p.textContent));
      expect(cut).toEqual([]);
      await expect(page.locator('.map-lanes .ln-lane.store .ln-head .sc').first()).toHaveText(/in this storyline/);
      // one journey's lanes: its counts are over the journey, never a storyline
      await go(page, STREET + '?layout=lanes');
      await expect(page.locator('.map-jlanes-host .ln-stage').first()).toBeVisible();
      const scopes = await page.locator('.map-jlanes-host .ln-head .sc').allTextContents();
      expect(scopes.join(' ')).not.toMatch(/storyline/);
      await expect(page.locator('.map-jlanes-host .ln-lane.store .ln-head .d').first()).toContainText('written by this journey');
    });

    /**
     * @covers packages/server/public/app/surfaces/map.js::chromeHtml
     * @covers packages/server/public/app/surfaces/map-affected.js::affectedBarHtml
     */
    test('the Affected bar is a third row: the levels, the tools, the crumb and WALK do not move', async ({ page }) => {
      await mapOn(page);
      await go(page, STREET);
      await expect(page.locator('.map-scr').first()).toBeVisible();
      const before = { walk: await box(page, '.map-crumbs .map-tb-walk'), tools: await box(page, '.map-row1 .map-tools'), crumb: await box(page, '.map-crumbs') };
      await go(page, STREET + '?affected=' + encodeURIComponent(TABLE) + '&ahops=3');
      await expect(page.locator('.map-affbar')).toBeVisible();
      await expect(page.locator('.map-affbar [data-act="aff-list"]')).toBeEnabled();
      expect(await box(page, '.map-crumbs .map-tb-walk')).toEqual(before.walk);
      expect(await box(page, '.map-row1 .map-tools')).toEqual(before.tools);
      expect((await box(page, '.map-crumbs'))![1]).toBe(before.crumb![1]);
      // the bar sits under the crumb and nothing in the chrome is wider than the window
      const r = await page.evaluate(() => {
        const c = document.querySelector('.map-chrome')!;
        const bar = c.querySelector('.map-affbar')!.getBoundingClientRect();
        const crumbs = c.querySelector('.map-crumbs')!.getBoundingClientRect();
        return { under: bar.top >= crumbs.bottom - 1, wide: [...c.querySelectorAll<HTMLElement>('.map-row1,.map-crumbs,.map-affbar')].some((e) => e.getBoundingClientRect().right > innerWidth + 1 || e.scrollWidth > e.clientWidth + 1) };
      });
      expect(r).toEqual({ under: true, wide: false });
    });

    /**
     * @covers packages/server/public/app/surfaces/map-affected.js::affectedListHtml
     * @covers packages/server/public/app/lib/map-affected-model.js::affectedTests
     */
    test('LIST THESE writes the tests out in the dock, each at its spec file and line with its own last run, and copies them', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await mapOn(page);
      await go(page, STREET + '?affected=' + encodeURIComponent(TABLE) + '&ahops=3');
      await expect(page.locator('.map-affbar [data-act="aff-list"]')).toBeEnabled();
      await page.locator('.map-affbar [data-act="aff-list"]').click();
      const list = page.locator('.map-dock .map-afflist');
      await expect(list).toBeVisible();
      await expect(page.locator('.map-dock .md-tab.on')).toHaveText(/as a list/i);
      const tests = list.locator('.al-tests .al-row[data-kind="test"]');
      expect(await tests.count()).toBeGreaterThan(0);
      // a case written in a spec carries its file and line
      const locs = await list.locator('.al-tests .al-row .loc').allTextContents();
      expect(locs.length).toBeGreaterThan(0);
      for (const l of locs) expect(l).toMatch(/:\d+$/);
      // the list is inside the dock, beside the stage — never under the screen or the board
      const inDock = await page.evaluate(() => {
        const d = document.querySelector('.map-dock')!.getBoundingClientRect();
        const l = document.querySelector('.map-dock .map-afflist')!.getBoundingClientRect();
        return l.left >= d.left - 1 && l.right <= d.right + 1;
      });
      expect(inDock).toBe(true);
      await list.locator('[data-act="aff-copy"][data-kind="json"]').click();
      const json = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
      const row = json.rows.find((x: any) => x.kind === 'test' && x.spec);
      expect(row).toBeTruthy();
      expect(row.line).not.toBe('');
      // Esc closes the list, then the mode
      await page.keyboard.press('Escape');
      await expect(list).toBeHidden();
      await expect(page.locator('.map-affbar')).toBeVisible();
    });

    /**
     * @covers packages/server/public/app/lib/lifecycle-strip.js::foldLifecycleStrips
     */
    test('a lifecycle line with no room folds its last statuses into +n, never cut off', async ({ page }) => {
      await openJourneyAt(page, 'screens');
      const strip = page.locator('.map-jhead .jh-lc .lc-statuses').first();
      await expect(strip).toBeVisible();
      const clipped = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.map-jhead .jh-lc .lc-statuses')]
        .filter((s) => s.scrollWidth > s.clientWidth + 1).length);
      expect(await clipped()).toBe(0);
      // squeezed: the line folds, says how many, and its tip lists them
      await page.setViewportSize({ width: 900, height: H });
      await expect.poll(clipped).toBe(0);
      await expect(page.locator('.map-jhead .jh-lc .lc-foldmore')).toBeVisible();
      await expect(page.locator('.map-jhead .jh-lc .lc-foldmore')).toHaveText(/^\+\d+$/);
    });

    /** @covers packages/server/public/app/lib/tooltip.js::initTips */
    test('a click closes the tip it rests on, and it does not open again under a still pointer', async ({ page }) => {
      await mapOn(page);
      await go(page, STREET);
      await expect(page.locator('.map-scr').first()).toBeVisible();
      const lanes = page.locator('.map-layout-slot .map-seg[data-layout="table"]');
      await lanes.hover();
      await expect(page.locator('#fs-tip')).toBeVisible();
      await lanes.click();
      await expect(page.locator('.map-table .jrn-sheet')).toBeVisible();
      await page.waitForTimeout(1200);
      await expect(page.locator('#fs-tip')).toBeHidden();
    });

    /** @covers packages/server/public/app/surfaces/map.js::chromeHtml */
    test('the level\'s last stop says LINES: on the Map only the register says CODE', async ({ page }) => {
      await mapOn(page);
      await go(page, STREET);
      await expect(page.locator('.map-lvls [data-l="code"]')).toHaveText(/^lines$/i);
      const code = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button')]
        .filter((b) => b.getClientRects().length && /^code$/i.test(b.textContent!.trim())).map((b) => (b.closest('.lens-switch') ? 'lens' : b.className)));
      expect(code).toEqual(['lens']);
    });

    /**
     * @covers packages/server/public/app/lib/gate-card.js::openGateCard
     * @covers packages/server/public/app/lib/tooltip.js::repositionTip
     */
    test('the gate card scrolls inside itself to its tests, never past the window', async ({ page }) => {
      await page.setViewportSize({ width: W, height: 520 });
      await gotoReady(page, STREET + '?layout=table&lens=hybrid');
      const row = page.locator('.map-table .jrn-gl-row[data-gate-card="' + GATE + '"]').first();
      await row.locator('.jrn-gl-w').click();
      const c = page.locator('.fs-tip .gc[data-gc="' + GATE + '"]');
      await expect(c).toBeVisible();
      await expect(c.locator('.gc-code .gc-pre')).toBeVisible();
      const r = await page.evaluate(() => {
        const tip = document.getElementById('fs-tip')!;
        const body = tip.querySelector<HTMLElement>('.tip-body')!;
        body.scrollTop = body.scrollHeight;
        const secs = tip.querySelectorAll('.gc-sec');
        const last = secs[secs.length - 1].getBoundingClientRect();
        return { bottom: tip.getBoundingClientRect().bottom <= innerHeight + 1, top: tip.getBoundingClientRect().top >= -1, testsInView: last.top < innerHeight && last.bottom > 0 };
      });
      expect(r).toEqual({ bottom: true, top: true, testsInView: true });
      await expect(c.locator('h4', { hasText: /the tests that reach it/i })).toBeInViewport();
    });

    /** @covers packages/server/public/app/lib/lifecycle-strip.js::lifecycleTableInto */
    test('the lifecycle table in a right-hand dock stacks each status: the word, its constant, what moves it', async ({ page }) => {
      await openJourneyAt(page, 'screens');
      await page.locator('.map-jhead .lc-toggle').first().click();
      const tbl = page.locator('.map-dock .lc-table');
      await expect(tbl).toBeVisible();
      const r = await page.evaluate(() => {
        const t = document.querySelector('.map-dock .lc-table')!;
        const tr = t.querySelector('tbody tr')!;
        const [a, b, c] = [...tr.children].map((x) => x.getBoundingClientRect());
        return { stacked: a.bottom <= b.top + 1 && b.bottom <= c.top + 1, fits: t.scrollWidth <= t.parentElement!.clientWidth + 1 };
      });
      expect(r).toEqual({ stacked: true, fits: true });
    });
  });
}
