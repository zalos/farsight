// Shared fixtures for the viewer specs.
//
// `pageErrors` is automatic: every viewer test fails if the page threw, logged a
// console error, or got an HTTP error it did not ask for. That count is the
// cheapest real check there is (AGENTS.md, screenshot practice). A spec that
// injects a fault on purpose lists the paths it expects to fail with
// `test.use({ expectedHttpErrors: [...] })`.
import { test as base, expect, type Page } from '@playwright/test';

/**
 * Known noise, kept visible rather than hidden: a screen the design manifest
 * declares with a Figma node but no local image (INV-03 in the fixture) asks
 * `/api/design/image`, which answers 404 when no FIGMA_TOKEN is set. The viewer
 * falls back to its placeholder, but the browser still logs the 404.
 */
const KNOWN_HTTP_NOISE: RegExp[] = [/\/api\/design\/image\?/];

type Fixtures = {
  expectedHttpErrors: RegExp[];
  pageErrors: string[];
  /** The map's legend opens by itself on a reader's first visit; specs start as a returning reader unless they set this false. */
  mapLegendSeen: boolean;
  mapLegendInit: void;
};

export const test = base.extend<Fixtures>({
  expectedHttpErrors: [[], { option: true }],
  mapLegendSeen: [true, { option: true }],
  mapLegendInit: [async ({ page, mapLegendSeen }, use) => {
    if (mapLegendSeen) await page.addInitScript(() => { try { localStorage.setItem('fs-map-legend-seen', '1'); } catch { /* no storage: the legend opens */ } });
    await use();
  }, { auto: true }],
  pageErrors: [async ({ page, expectedHttpErrors }, use) => {
    const errors: string[] = [];
    const allowed = [...KNOWN_HTTP_NOISE, ...expectedHttpErrors];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      // a failed fetch is judged by its response below, where the URL is known
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`);
    });
    page.on('response', (r) => {
      if (r.status() >= 400 && !allowed.some((re) => re.test(r.url()))) errors.push(`http ${r.status()}: ${r.url()}`);
    });
    await use(errors);
    expect(errors, 'page errors, console errors and unexpected HTTP errors').toEqual([]);
  }, { auto: true }],
});

export { expect };

/**
 * Go to a route and wait until the shell has booted — the status bar leaves
 * `loading…` once the graph is drawn and the keymap listener is attached, so a
 * key pressed after this lands (a ⌘K pressed earlier is silently lost).
 */
export async function gotoReady(page: Page, hash = '#/journeys'): Promise<void> {
  await page.goto('/' + hash);
  await expect(page.locator('#stats')).not.toHaveText('loading…');
}

/** Open the first journey on the picker (the fixture's `Billing cycle`, marked start here) and wait for its header. */
export async function openBillingCycle(page: Page): Promise<void> {
  await gotoReady(page, '#/journeys');
  await page.getByRole('button', { name: 'Open journey' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Journey', exact: true })).toBeVisible();
  await expect(page.locator('#jrn-title')).toHaveText('Billing cycle');
}
