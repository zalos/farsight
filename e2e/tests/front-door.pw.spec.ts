// The front door: what a person meets before they touch anything.
import { test, expect, gotoReady } from './support';

test.describe('front door', () => {
  /**
   * @covers packages/server/public/app/shell.js::boot
   * @covers packages/server/public/app/shell.js::renderChrome
   * @covers GET /graph
   */
  test('loads the journeys picker with no page, console or HTTP errors', async ({ page }) => {
    await page.goto('/');
    // the hybrid register lands on Journeys (defaultSurface); a deep link would win
    await expect(page).toHaveURL(/#\/journeys$/);
    await expect(page.getByRole('heading', { name: 'Journeys', level: 1 })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Surfaces' });
    for (const tab of ['Portfolio', 'Journeys', 'Code map', 'APIs', 'Tests', 'Changes']) {
      await expect(nav.getByRole('button', { name: tab, exact: true })).toBeVisible();
    }
    // the fixture's design manifest reaches the picker: its flows, with the start-here one first
    await expect(page.getByText('Billing cycle', { exact: true }).first()).toBeVisible();
    await expect(page.locator('#stats')).toContainText('of 87');
  });

  /**
   * @covers GET /api/version
   * @covers packages/server/public/app/shell.js::syncChipHtml
   */
  test('the sync chip names the workspace build and graph sync, and /api/version agrees', async ({ page, request }) => {
    const version = await (await request.get('/api/version')).json();
    expect(version.farsight.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(version.currency.ok).toBe(true);
    await page.goto('/');
    const chip = page.locator('#syncchipwrap .syncchip');
    await expect(chip).toContainText('sync 1');
    await expect(chip).not.toHaveClass(/restart/);
    if (version.farsight.commit) await expect(chip).toContainText(String(version.farsight.commit).slice(0, 7));
  });

  /**
   * @covers packages/server/public/app/surfaces/journeys.js::jrnDesignCardHtml
   * @covers packages/server/public/app/surfaces/journeys.js::designDriftRows
   * @covers GET /api/design
   */
  test('the Designs card\'s drift explains itself: what it counts, over what, and by kind — the kinds add up to it', async ({ page, request }) => {
    // story swarm 2026-09-25: "18 DRIFT is the one number that won't explain itself" — it had a title, no tip
    const design = (await (await request.get('/api/design?scope=all')).json()).designs[0];
    const n = design.counts.drift as number;
    expect(n).toBeGreaterThan(0);
    await gotoReady(page, '#/journeys');
    const drift = page.locator('.dsg-card .api-count').filter({ hasText: /drift/ }).first();
    await expect(drift).toBeVisible();
    await expect(drift).not.toHaveAttribute('title', /./);
    await drift.click();
    const tip = page.locator('#fs-tip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText(n + ' drift');
    await expect(tip).toContainText('across this design manifest');
    await expect(tip).toContainText('/api/design');
    await expect(tip).toContainText('designed, not built');
    const parts = (await tip.locator('table td.n').allInnerTexts()).map(Number).filter((x) => !Number.isNaN(x));
    expect(parts.reduce((a, b) => a + b, 0)).toBe(n);
  });

  /**
   * @covers GET /api/version
   * @covers packages/server/public/app/shell.js::restartNeeded
   * @covers packages/server/public/app/shell.js::syncChipTip
   */
  test('RESTART is decided build to build by the server, and the tip names the running and the installed build', async ({ page, request }) => {
    // the server compares identities, not file dates: this build is the one on disk
    const v = await (await request.get('/api/version')).json();
    expect(v.install.basis).toBe('build');
    expect(v.install.newerInstalled).toBe(false);
    expect(v.install.installed.built).toBe(v.farsight.built);
    // a different build on disk, as the server would report it
    await page.route('**/api/version', async (route) => {
      const res = await route.fetch();
      const j = await res.json();
      j.install = { ...j.install, basis: 'build', newerInstalled: true, installed: { built: '2099-01-01T00:00:00.000Z', commit: 'fedcba9', codeCommit: 'fedcba9', dirty: false } };
      await route.fulfill({ response: res, json: j });
    });
    await gotoReady(page, '#/journeys');
    const chip = page.locator('#syncchipwrap .syncchip');
    await expect(chip).toHaveClass(/restart/);
    await chip.click();
    const tip = page.locator('#fs-tip');
    await expect(tip).toContainText('running build');
    await expect(tip).toContainText('installed build');
    await expect(tip).toContainText('fedcba9');
    await expect(tip).toContainText('RESTART');
  });

  /** @covers GET /graph */
  test('/graph serves the fixture graph the viewer draws', async ({ request }) => {
    const graph = await (await request.get('/graph')).json();
    expect(graph.nodes.length).toBe(87);
    expect(graph.nodes.some((n: { id: string }) => n.id === 'invoice-app::src/server/taxEngine.ts::computeTax')).toBe(true);
  });
});
