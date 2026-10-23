// The chrome (swarm-fixes round 2026-10-05, lane H): Settings named and in the ⋯ menu, a read-only session that
// greys out what its server refuses, the Map's toolbar fitting at 1440, the Sheet's Verified-by cell inside its
// column, the Experiments row readable, and the journey's landing view decided by the register.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { test, expect, gotoReady, openJourneyAt } from './support';
import { CLI, makeWorkspace } from '../fixture/workspace.mjs';
import { routeWork } from './work-stub';

test.describe('Settings is named', () => {
  /**
   * @covers packages/server/public/app/shell.js::renderChrome
   * @covers packages/server/public/app/shell.js::fitTopbar
   */
  test('the bar says Settings beside a cog, and the ⋯ menu always lists it', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await gotoReady(page, '#/portfolio');
    const gear = page.locator('.topbar > #gearbtn');
    await expect(gear).toBeVisible();
    await expect(gear).toHaveAccessibleName('Settings');
    await expect(gear.locator('.gearlbl')).toHaveText('Settings');
    // a narrow window folds controls into ⋯; Settings is a row there either way, and it opens the page
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.locator('#morebtn').click();
    const row = page.locator('#moremenu').getByRole('button', { name: 'Settings' });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator('#settings')).toHaveClass(/\bopen\b/);
  });

  /** @covers packages/server/public/app/shell.js::renderSettings */
  test('the Experiments read one flag per line, their sentence under them, never one word wide', async ({ page }) => {
    await gotoReady(page, '#/portfolio');
    await page.evaluate(() => (window as any).openSettings());
    // the Map and the action drill are no experiments since the journey page retired into the Map: one flag is left
    const notes = page.locator('.set-flagitem .set-note');
    await expect(notes).toHaveCount(1);
    for (const w of await notes.evaluateAll((ns) => ns.map((n) => n.getBoundingClientRect().width))) expect(w).toBeGreaterThan(300);
  });
});

test.describe('a writable session', () => {
  /**
   * @covers packages/server/public/app/lib/read-only.js::applyReadOnly
   * @covers packages/server/public/app/lib/read-only.js::readOnlyWhy
   */
  test('says nothing about read-only and leaves every write control live', async ({ page }) => {
    await gotoReady(page, '#/portfolio');
    await expect(page.locator('#readonly')).toBeHidden();
    await page.evaluate(() => (window as any).openSettings());
    await expect(page.locator('#savebtn')).not.toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#set-ro')).toBeHidden();
  });
});

// ── a read-only server (`serve --read-only`), started by this spec ──
let server: ChildProcess | null = null;
let base = '';
let cleanup: (() => void) | null = null;
async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => res(p)); });
  });
}

test.describe('a read-only session', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ expectedHttpErrors: [/\/api\/settings$/] });
  test.beforeAll(async () => {
    const ws = makeWorkspace('readonly');
    cleanup = ws.cleanup;
    const port = await freePort();
    server = spawn(process.execPath, [CLI, 'serve', ws.graph, '--port', String(port), '--read-only'], { cwd: ws.dir, stdio: 'ignore' });
    base = `http://localhost:${port}/`;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + 'api/version')).ok) return; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the read-only server never answered');
  });
  test.afterAll(() => {
    if (server?.pid) server.kill('SIGTERM');
    if (cleanup) cleanup();
  });

  /**
   * @covers packages/server/src/guard.ts::refuseWrite
   * @covers packages/server/public/app/lib/read-only.js::applyReadOnly
   */
  test('the chip says READ-ONLY, every write control is greyed with its reason, and the server refuses the write', async ({ page }) => {
    const v = await (await fetch(base + 'api/version')).json();
    expect(Object.keys(v.session).sort()).toEqual(['instance', 'readOnly', 'why']);
    expect(v.session).toEqual({ readOnly: true, why: 'flag', instance: expect.stringMatching(/^host-[a-f0-9]{32}$/) });
    const put = await fetch(base + 'api/settings', { method: 'PUT', body: '{}' });
    expect(put.status).toBe(403);
    const writes: string[] = [];
    page.on('request', (r) => { if (r.method() !== 'GET') writes.push(r.method() + ' ' + r.url()); });
    await page.goto(base + '#/portfolio');
    await expect(page.locator('#stats')).not.toHaveText('loading…');
    await expect.poll(() => page.evaluate(() => (window as any).readOnlyWhy())).toBe('flag');
    await page.evaluate(() => (window as any).openSettings());
    await expect(page.locator('#set-ro')).toBeVisible();
    for (const id of ['#savebtn', '#syncbtn']) {
      await expect(page.locator(id)).toHaveAttribute('aria-disabled', 'true');
      await expect(page.locator(id)).toHaveAttribute('data-tip-text', /read-only/);
    }
    await expect(page.locator('#src-name')).toBeDisabled();
    await expect(page.locator('#srcrows button.x').first()).toHaveAttribute('aria-disabled', 'true');
    // pressed anyway, nothing is sent
    await page.locator('#savebtn').click({ force: true });
    await page.locator('#syncbtn').click({ force: true });
    await page.waitForTimeout(300);
    expect(writes).toEqual([]);
  });

  /**
   * The round-3 swarm (five roles): at 1280 the READ-ONLY chip folded into ⋯ first — the one chip a reviewer must
   * always see. It never folds now; the search box gives up its word instead.
   * @covers packages/server/public/app/shell.js::fitTopbar
   */
  for (const [w, h] of [[1440, 900], [1280, 800]]) {
    test(`READ-ONLY stays in the bar at ${w}, on the Portfolio and the Map`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      for (const hash of ['#/portfolio', '#/map']) {
        await page.goto(base + hash);
        await expect(page.locator('#stats')).not.toHaveText('loading…');
        await expect.poll(() => page.evaluate(() => (window as any).readOnlyWhy())).toBe('flag');
        const chip = page.locator('.topbar > #readonly');
        await expect(chip).toBeVisible();
        const box = await chip.boundingBox();
        expect(box && box.x + box.width).toBeLessThanOrEqual(w);
        // the bar itself never scrolls sideways
        expect(await page.evaluate(() => { const b = document.querySelector('.topbar') as HTMLElement; return b.scrollWidth - b.clientWidth; })).toBeLessThanOrEqual(1);
      }
    });
  }
});

/** Every visible control that would write, and which of them are live — none may be, on a read-only server. */
async function liveWrites(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-write]')]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .filter((e) => !(e as HTMLButtonElement).disabled && e.getAttribute('aria-disabled') !== 'true')
    .map((e) => (e.id || e.className || e.tagName) + ': ' + (e.textContent || '').trim().slice(0, 30)));
}

test.describe('a read-only session, on every surface', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ expectedHttpErrors: [/\/api\/settings$/] });
  let srv: ChildProcess | null = null;
  let url = '';
  let done: (() => void) | null = null;
  test.beforeAll(async () => {
    const ws = makeWorkspace('readonly-all');
    done = ws.cleanup;
    const port = await freePort();
    srv = spawn(process.execPath, [CLI, 'serve', ws.graph, '--port', String(port), '--read-only'], { cwd: ws.dir, stdio: 'ignore' });
    url = `http://localhost:${port}/`;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(url + 'api/version')).ok) return; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the read-only server never answered');
  });
  test.afterAll(() => {
    if (srv?.pid) srv.kill('SIGTERM');
    if (done) done();
  });

  /**
   * @covers packages/server/public/app/lib/read-only.js::applyReadOnly
   * @covers packages/server/public/app/lib/read-only.js::installReadOnly
   * @covers packages/server/public/app/surfaces/work.js::workSync
   */
  test('Work, an item, Settings, the journey, the Map and the Portfolio: the chip, and no live write control', async ({ page }) => {
    const writes: string[] = [];
    page.on('request', (r) => { if (r.method() !== 'GET') writes.push(r.method() + ' ' + r.url()); });
    await routeWork(page);
    // the Map is a workspace flag: on for this walk, read from the settings the server serves
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const s = await res.json();
      s.flags = Object.assign({}, s.flags, { map: true });
      return route.fulfill({ response: res, json: s });
    });
    const walk: [string, string, string][] = [
      ['work', '#/work', '.wk-syncbtn'],
      ['an item', '#/work/' + encodeURIComponent('work::invoice-jira::INV-3'), '.wk-head'],
      ['settings', '#/settings', '#savebtn'],
      ['the journey', '#/map/' + encodeURIComponent('invoice-app::flow::billing-cycle') + '?layout=table', '.map-table .jrn-sheet'],
      ['the map', '#/map', '.map-district'],
      ['the portfolio', '#/portfolio', '.pf-wrap'],
    ];
    for (const [name, hash, ready] of walk) {
      await page.goto(url + hash);
      await expect(page.locator('#stats')).not.toHaveText('loading…');
      await expect(page.locator(ready).first(), name).toBeVisible();
      // the chip is drawn (in the bar, or in ⋯ when a long workspace name folds it there) and says so
      await expect(page.locator('#readonly'), name).not.toHaveAttribute('hidden', '');
      await expect(page.locator('#readonly'), name).toHaveText(/read-only/i);
      expect(await liveWrites(page), name).toEqual([]);
    }
    // Work says so before anything is tried, and its sync and the item's writes are greyed with a reason
    await page.goto(url + '#/work/' + encodeURIComponent('work::invoice-jira::INV-3'));
    await expect(page.locator('.wk-ro-pane')).toBeVisible();
    const edit = page.locator('.wk-ctl[data-action="edit"]').first();
    await expect(edit).toHaveAttribute('aria-disabled', 'true');
    await expect(edit).toHaveAttribute('data-tip-text', /read-only/);
    await edit.click({ force: true });
    await expect(page.locator('#wk-title-in')).toHaveCount(0);
    await page.goto(url + '#/work');
    await expect(page.locator('.wk-ro')).toBeVisible();
    await page.locator('.wk-syncbtn').click({ force: true });
    // the theme hint changes with the mode: a read-only server keeps no settings
    await page.goto(url + '#/settings');
    await page.locator('#set-theme').selectOption('light');
    await expect(page.locator('#set-theme-note')).toHaveText(/read-only server keeps no settings/);
    await page.waitForTimeout(300);
    expect(writes).toEqual([]);
  });
});

test.describe('the Map toolbar', () => {
  /** @covers packages/server/public/app/surfaces/map.js::fitChrome */
  for (const [w, h] of [[1440, 900], [1280, 800]]) {
    test(`fits at ${w}: nothing past the right edge, the legend button on screen`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await gotoReady(page, '#/portfolio');
      await page.evaluate(() => {
        const S = (window as any).S;
        S.SETTINGS = Object.assign({}, S.SETTINGS, { flags: Object.assign({}, S.SETTINGS && S.SETTINGS.flags, { map: true }) });
        location.hash = '#/map';
      });
      const chrome = page.locator('.map-chrome');
      await expect(chrome).toBeVisible();
      await expect(page.locator('.map-district').first()).toBeVisible();
      await expect.poll(() => chrome.evaluate((c) => c.scrollWidth <= c.clientWidth + 1)).toBe(true);
      const b = await page.locator('.map-tools [data-act="legend"]').boundingBox();
      expect(b!.x + b!.width).toBeLessThanOrEqual(w);
    });
  }
});

test.describe('the journey', () => {
  /** @covers packages/server/public/app/lib/journey-draw.js::jrnSheetVerifiedHtml */
  test('the table\'s Verified-by cell keeps its words inside its column', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openJourneyAt(page, 'table');
    await expect(page.locator('.jrn-scell .jrn-tfoot').first()).toBeVisible();
    const over = await page.evaluate(() => {
      const out: string[] = [];
      for (const cell of document.querySelectorAll('.jrn-scell')) {
        if (!cell.querySelector('.jrn-tfoot')) continue;
        const r = cell.getBoundingClientRect();
        for (const e of cell.querySelectorAll('.jrn-tfoot *')) {
          const q = e.getBoundingClientRect();
          if (q.width && q.right > r.right + 1) out.push((e.textContent || '').slice(0, 40));
        }
      }
      return out;
    });
    expect(over).toEqual([]);
  });

  /**
   * @covers packages/server/public/app/surfaces/map-stops.js::registerView
   * @covers packages/server/public/app/surfaces/map-stops.js::setLayout
   */
  test('the register decides where a journey opens on the Map, and each register remembers its own choice', async ({ page }) => {
    const door = (lens: string) => gotoReady(page, '#/journeys?lens=' + lens)
      .then(() => page.locator('.dsg-flow.pinned').first().getByRole('button', { name: 'Open journey' }).click());
    // hybrid: the table
    await door('hybrid');
    await expect(page.locator('.map-table .jrn-sheet')).toBeVisible();
    // business: the street, the storyboard's look
    await door('business');
    await expect(page.locator('.map-scr .say').first()).toBeVisible();
    await expect(page.locator('.map-table')).toHaveCount(0);
    // code: the first action's beats with the code open
    await door('code');
    await expect(page.locator('.map-act.code')).toBeVisible();
    // the business reader picks the table: remembered for business, and hybrid keeps its own
    await door('business');
    await page.locator('.map-layout [data-layout="table"]').click();
    await expect(page.locator('.map-table .jrn-sheet')).toBeVisible();
    await door('business');
    await expect(page.locator('.map-table .jrn-sheet')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('fs-map-view.business'))).toBe('table');
    expect(await page.evaluate(() => localStorage.getItem('fs-map-view.hybrid'))).toBeNull();
  });
});
