import { test, expect } from './support';
import { startPortalDemo } from '../../packages/echo/dist/portal-demo.js';

// Real Echo HTTP/bridge/UI, synthetic in-memory evidence and deterministic mock research only.
test.describe('Echo memory portal', () => {
  test.describe.configure({ mode: 'serial' });
  let demo: Awaited<ReturnType<typeof startPortalDemo>>;
  test.beforeAll(async () => { demo = await startPortalDemo(0); });
  test.afterAll(async () => { await demo?.close(); });
  test.beforeEach(async ({ page }) => {
    await page.goto(demo.url);
    await expect(page.getByRole('tab', { name: 'Memories', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-memory-id]')).toHaveCount(3);
  });

  /** @covers packages/echo/src/web.ts::startWeb */
  test('scoped timeline, pagination, saved topics and literal evidence', async ({ page }) => {
    await expect(page.getByText('Synthetic preview', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Load more', exact: true }).click();
    await expect(page.locator('[data-memory-id]')).toHaveCount(6);
    await expect(page.getByRole('button', { name: 'Load more', exact: true })).toBeHidden();
    await page.getByLabel('Topics in loaded results', { exact: true }).selectOption('release');
    await expect(page.locator('[data-memory-id]')).toHaveCount(1);
    await page.locator('[data-memory-id="synthetic_build"]').click();
    await expect(page.getByRole('complementary', { name: 'Memory detail', exact: true })).toContainText('Generate the manifest before packaging');
    await expect(page.getByRole('complementary', { name: 'Memory detail', exact: true })).toContainText('/workspace/example/release');
  });

  /** @covers POST /api/memory/browse */
  test('search and dates do not invoke research; an empty page preserves continuation', async ({ page }) => {
    let research = 0;
    page.on('request', request => { if (request.url().endsWith('/api/memory/ask')) research++; });
    await page.getByLabel('Search memories', { exact: true }).fill('cold storage');
    await page.getByRole('button', { name: 'Search memories', exact: true }).click();
    await expect(page.locator('[data-memory-id]')).toHaveCount(1);
    await page.getByLabel('Search memories', { exact: true }).fill('');
    await page.getByLabel('Saved since (UTC)', { exact: true }).fill('2099-01-01');
    await page.getByRole('button', { name: 'Search memories', exact: true }).click();
    await expect(page.locator('[data-memory-id]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Load more', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Load more', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Load more', exact: true })).toBeHidden();
    expect(research).toBe(0);
  });

  /** @covers POST /api/memory/ask */
  test('explicit mock research offers a checked evidence expansion', async ({ page }) => {
    await page.getByLabel('What would you like to remember?', { exact: true }).fill('cold storage');
    const response = page.waitForResponse(response => response.url().endsWith('/api/memory/ask'));
    await page.getByRole('button', { name: 'Ask sub-mind', exact: true }).click();
    const result = await (await response).json();
    expect(result.mode).toBe('mock'); expect(result.usage.modelCalls).toBe(0);
    await expect(page.getByText('Use the blue insulated test container and attach the temperature log to the shipment record.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Read more', exact: true }).first().click();
    await expect(page.getByRole('complementary', { name: 'Memory detail', exact: true })).toContainText('Cold shipment');
  });

  /** @covers packages/echo/src/web.ts::startWeb */
  test('read-only preview settings stay separate from the running memory scope', async ({ page }) => {
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    await expect(page.locator('#individual')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeDisabled();
    await page.getByRole('tab', { name: 'Memories', exact: true }).click();
    await expect(page.locator('[data-memory-id]')).toHaveCount(3);
    await expect(page.getByText('synthetic-preview', { exact: true }).first()).toBeVisible();
  });

  /** @covers POST /api/memory/expand */
  test('untrusted memory text cannot become executable HTML', async ({ page }) => {
    await page.route('**/api/memory/expand', async route => {
      const response = await route.fetch(); const result = await response.json();
      result.memory.content = '<img src=x onerror="window.echoInjected=true"> Synthetic evidence';
      await route.fulfill({ response, json: result });
    });
    await page.locator('[data-memory-id]').first().click();
    const detail = page.getByRole('complementary', { name: 'Memory detail', exact: true });
    await expect(detail).toContainText('<img src=x');
    await expect(detail.locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).echoInjected)).toBeUndefined();
  });

  /** @covers packages/echo/public/portal.js::createPortal */
  test('cancelled research cannot publish a late result', async ({ page }) => {
    let release!: () => void;
    let intercepted!: () => void;
    let delivered!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { intercepted = resolve; });
    const settled = new Promise<void>(resolve => { delivered = resolve; });
    await page.route('**/api/memory/ask', async route => {
      const response = await route.fetch(); intercepted();
      await pending;
      try { await route.fulfill({ response }); } finally { delivered(); }
    });
    await page.getByLabel('What would you like to remember?', { exact: true }).fill('cold storage');
    await page.getByRole('button', { name: 'Ask sub-mind', exact: true }).click();
    await started;
    await page.getByRole('button', { name: 'Cancel research', exact: true }).click();
    release(); await settled;
    await expect(page.getByRole('button', { name: 'Ask sub-mind', exact: true })).toBeEnabled();
    await expect(page.locator('[data-testid="research-brief"] .finding')).toHaveCount(0);
  });

  /** @covers packages/echo/public/portal.js::createPortal */
  test('a late detail cannot replace a newer selection', async ({ page }) => {
    let release!: () => void;
    let intercepted!: () => void;
    let delivered!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { intercepted = resolve; });
    const settled = new Promise<void>(resolve => { delivered = resolve; });
    await page.route('**/api/memory/expand', async route => {
      const response = await route.fetch();
      if (route.request().postDataJSON().id === 'synthetic_cold') { intercepted(); await pending; }
      try { await route.fulfill({ response }); } finally { if (route.request().postDataJSON().id === 'synthetic_cold') delivered(); }
    });
    await page.locator('[data-memory-id="synthetic_cold"]').click(); await started;
    await page.locator('[data-memory-id="synthetic_build"]').click();
    const detail = page.getByRole('complementary', { name: 'Memory detail', exact: true });
    await expect(detail).toContainText('Generate the manifest before packaging');
    release(); await settled;
    await expect(detail).toContainText('Generate the manifest before packaging');
    await expect(detail).not.toContainText('blue insulated test container');
  });

  /** @covers packages/echo/src/web.ts::startWeb */
  test('phone layout keeps search, cards and evidence reachable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel('Search memories', { exact: true })).toBeVisible();
    await page.locator('[data-memory-id]').first().click();
    await expect(page.getByRole('complementary', { name: 'Memory detail', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
