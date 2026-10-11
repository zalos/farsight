// Compare two syncs on a storyline (round 2026-10-10, proposal 7): a workspace with two real syncs of the fixture —
// the second after a week of edits (e2e/fixture/second-sync.mjs) — served on its own port. The Map, on the invoice
// storyline with `?compare=1..2`, draws the later sync, carries a change chip per kind on the cards (the chain and the
// lanes), and lists every change beside the board as a sentence with its door; the count is a Counted over the
// storyline; Save draws the A → B picture with both syncs named. A sync the history does not hold is said so.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { Page } from '@playwright/test';
import { test, expect } from './support';
import { CLI, makeCompareWorkspace } from '../fixture/workspace.mjs';

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

test.describe('two syncs of the invoice storyline', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async () => {
    const ws = await makeCompareWorkspace();
    cleanup = ws.cleanup;
    const port = await freePort();
    server = spawn(process.execPath, [CLI, 'serve', ws.graph, '--port', String(port)], { cwd: ws.dir, stdio: 'ignore' });
    base = `http://localhost:${port}/`;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + 'api/version')).ok) return; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the compare workspace server never answered');
  });
  test.afterAll(() => {
    if (server?.pid) server.kill('SIGTERM');
    if (cleanup) cleanup();
  });

  const go = async (page: Page, hash: string) => {
    await page.goto(base + hash);
    await expect(page.locator('#stats')).not.toHaveText('loading…');
  };

  /**
   * @covers packages/server/public/app/surfaces/map-compare.js::comparePanelHtml
   * @covers packages/server/public/app/surfaces/map-compare.js::paintCompareCovers
   * @covers packages/server/public/app/lib/compare-model.js::chipsFor
   */
  test('the chain: a chip per kind on the cards, every change in the panel with its door, counted over the storyline', async ({ page }) => {
    await go(page, '#/map?storyline=invoice&compare=1..2');
    const panel = page.locator('.map-cmp');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.map-cmp-range')).toContainText('sync 1 → sync 2');
    await expect(panel.locator('.map-cmp-item')).toHaveCount(7);
    await expect(panel.locator('.map-cmp-count')).toContainText('7 changes');
    await expect(panel.locator('.map-cmp-count')).toContainText('over this storyline, between the two syncs');
    await expect(panel.locator('.map-cmp-count')).toContainText('built 1 · gate 2 · writer 1 · contract 1 · verdict 2');
    await expect(panel.locator('.map-cmp-item.k-built .map-cmp-say')).toHaveText('Discard draft is now built');
    await expect(panel.locator('.map-cmp-item.k-gate .map-cmp-say code').first()).toHaveText('requireScope (billing:admin)');
    // every change has its door
    await expect(panel.locator('.map-cmp-item .map-cmp-door')).toHaveCount(7);
    await expect(panel.locator('.map-cmp-item.k-contract a.map-cmp-door')).toHaveAttribute('href', /#\/apis\//);
    // the control names the range, and the link carries it
    await expect(page.locator('.map-cmp-cur')).toContainText('sync 1 → sync 2');
    expect(await page.evaluate(() => location.hash)).toContain('compare=1..2');
    // the cards: Billing cycle is now built, gained two gates and a writer, its contract moved and its verdict too
    const billing = page.locator('.map-dcover[data-enter="invoice-app::flow::billing-cycle"] .map-cmp-chip');
    await expect(billing).toHaveText(['now built · 3 of 3', '+2 gates', '+1 writer', 'contract · 1 changed', /→/]);
    await expect(page.locator('.map-dcover[data-enter="invoice-app::flow::new-invoice"] .map-cmp-chip')).toHaveText(['+1 gate', /→/]);
    // the board draws the later sync: no screen is waiting to be built
    const sum = await page.evaluate(async () => (await (await fetch('/api/journey?entry=invoice-app::flow::billing-cycle&steps=0')).json()).summary.counted.built);
    expect([sum.n, sum.of]).toEqual([3, 3]);
  });

  test('the business lens: the same changes in words, no identifier', async ({ page }) => {
    await go(page, '#/map?storyline=invoice&compare=1..2&lens=business');
    const panel = page.locator('.map-cmp');
    await expect(panel.locator('.map-cmp-item')).toHaveCount(7);
    await expect(panel.locator('.map-cmp-say code')).toHaveCount(0);
    await expect(panel.locator('.map-cmp-item.k-gate .map-cmp-say').first()).toHaveText('Discard draft gained a check: billing:admin');
    await expect(page.locator('.map-dcover[data-enter="invoice-app::flow::new-invoice"] .map-cmp-chip').first()).toHaveText('+1 check');
  });

  /** @covers packages/server/public/app/surfaces/map-compare.js::paintCompareLanes */
  test('the lanes carry the chips on their stage cards', async ({ page }) => {
    await go(page, '#/map?storyline=invoice&layout=lanes&compare=1..2');
    await expect(page.locator('.map-lanes .ln-stage')).toHaveCount(5);
    await expect(page.locator('.map-lanes .ln-stage .map-cmp-chip').first()).toBeVisible();
    await expect(page.locator('.map-lanes .ln-stage .map-cmp-chip', { hasText: 'now built' })).toHaveCount(2);
  });

  test('Save draws the A → B picture, both syncs named, every change under it', async ({ page }) => {
    await go(page, '#/map?storyline=invoice&compare=1..2');
    await expect(page.locator('.map-cmp-item')).toHaveCount(7);
    const out = await page.evaluate(async () => (window as any).farsightSave('map', 'png', { dataUrl: true }));
    expect(out.file).toMatch(/^farsight-map-.*invoice-sync1-to-sync2-sync2-\d{4}-\d{2}-\d{2}\.png$/);
    expect(out.footer).toContain('sync 1 → sync 2');
    expect(out.footer).toContain('Discard draft is now built');
    expect(out.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  test.describe('a sync the history does not hold', () => {
    test.use({ expectedHttpErrors: [/\/api\/compare\?/] });
    test('is said with the absence word, and nothing is drawn as changed', async ({ page }) => {
      await go(page, '#/map?storyline=invoice&compare=9..2');
      await expect(page.locator('.map-cmp .map-cmp-err')).toContainText('sync 9 is not indexed');
      await expect(page.locator('.map-cmp-chip')).toHaveCount(0);
    });
  });
});
