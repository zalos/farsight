// The chrome (swarm-fixes round 2026-10-05, lane H): Settings named and in the ⋯ menu, a read-only session that
// greys out what its server refuses, the Map's toolbar fitting at 1440, the Sheet's Verified-by cell inside its
// column, the Experiments row readable, and the journey's landing view decided by the register.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { test, expect, gotoReady, openBillingCycle } from './support';
import { CLI, makeWorkspace } from '../fixture/workspace.mjs';

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
    const notes = page.locator('.set-flagitem .set-note');
    await expect(notes).toHaveCount(3);
    for (const w of await notes.evaluateAll((ns) => ns.map((n) => n.getBoundingClientRect().width))) expect(w).toBeGreaterThan(300);
  });
});

test.describe('a writable session', () => {
  /**
   * @covers packages/server/public/app/shell.js::applyReadOnly
   * @covers packages/server/public/app/shell.js::readOnlyWhy
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
   * @covers packages/server/public/app/shell.js::applyReadOnly
   */
  test('the chip says READ-ONLY, every write control is greyed with its reason, and the server refuses the write', async ({ page }) => {
    const v = await (await fetch(base + 'api/version')).json();
    expect(v.session).toEqual({ readOnly: true, why: 'flag' });
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
  /** @covers packages/server/public/app/surfaces/journeys.js::jrnSheetVerifiedHtml */
  test('the Sheet\'s Verified-by cell keeps its words inside its column', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBillingCycle(page);
    await page.locator('.jrn-viewbtn', { hasText: /^sheet$/i }).click();
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
   * @covers packages/server/public/app/surfaces/journeys.js::jrnLayout
   * @covers packages/server/public/app/surfaces/journeys.js::jrnSetLayout
   */
  test('the register decides the landing view, and each register remembers its own choice', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('fs-jrn-layout.hybrid', 'sheet'); } catch { /* no storage */ } });
    await openBillingCycle(page);
    await page.locator('#lb-hybrid').click();
    const on = page.locator('.jrn-layoutsw .jrn-viewbtn.on');
    await expect(on).toHaveText(/sheet/i);
    // the business reader lands on the Storyboard, whatever hybrid chose
    await page.locator('#lb-business').click();
    await expect(on).toHaveText(/storyboard/i);
    await page.locator('.jrn-viewbtn', { hasText: /^timeline$/i }).click();
    await page.locator('#lb-hybrid').click();
    await expect(on).toHaveText(/sheet/i);
    await page.locator('#lb-business').click();
    await expect(on).toHaveText(/timeline/i);
  });
});
