// The map's property view (docs/proposals/map-view.md §1, §3.2): one screen up
// close, reached through the map surface's deep link. The fixture's Billing cycle
// has three screens — New invoice (built, a design image, stories on its form),
// Invoice list (built, an image, five calls) and Discard draft (designed, not
// built, a Figma frame with no render: the placeholder). The counts asserted
// here were measured on the fixture, never guessed: each is a `Counted` the
// journey summary carries, and a tab nothing types prints no number.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';

const FLOW = 'invoice-app::flow::billing-cycle';
const PAGE = {
  newInvoice: 'invoice-app::page::/invoices/new',
  list: 'invoice-app::page::/invoices',
  discard: 'invoice-app::page::/invoices/:param/discard',
};
const TABS = ['overview', 'gates', 'apis', 'ux', 'tests', 'route', 'work', 'changes'];

/** Identifier-shaped tokens — the same bar `journey-numbers.pw.spec.ts` holds the journey's business views to. */
const IDENTIFIER = new RegExp([
  String.raw`\b[a-z]+[A-Z][A-Za-z0-9]*\b`,
  String.raw`\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b`,
  String.raw`\b[a-z0-9]+_[a-z0-9_]+\b`,
  String.raw`\b[A-Z0-9]+_[A-Z0-9_]+\b`,
  String.raw`(?:^|[\s(])\/[\w.:{}\-]+`,
  String.raw`\b(?:GET|POST|PUT|PATCH|DELETE)\b`,
  String.raw`\b[\w-]+\.(?:spec|test|pw)\b`,
  String.raw`\.(?:tsx?|jsx?|mjs|json)\b`,
  String.raw`\b(?:CON|INV|OPS)-\d+[a-z]?\b|\bPBI\s?#?\d+|\bADR\s?\d+`,
].join('|'), 'g');

/**
 * Open one screen's property through the map. The fixture sets no flags, so the
 * map flag is switched on in this page only (never written to the workspace),
 * the way the journey specs switch on the drill.
 */
async function openProperty(page: Page, node: string, lens = 'hybrid') {
  await gotoReady(page, '#/portfolio?lens=' + lens);
  await page.evaluate(() => {
    const S = (window as any).S;
    S.SETTINGS = Object.assign({}, S.SETTINGS, { flags: Object.assign({}, S.SETTINGS && S.SETTINGS.flags, { map: true }) });
  });
  await page.evaluate(([flow, n]) => { location.hash = '#/map/' + encodeURIComponent(flow) + '?node=' + encodeURIComponent(n); }, [FLOW, node]);
  await expect(page.locator('.mp')).toBeVisible();
  await expect(page.locator('.mp')).toHaveAttribute('data-screen', node);
}

async function openTab(page: Page, tab: string) {
  await page.locator('#mp-tab-' + tab).click();
  await expect(page.locator('#mp-tab-' + tab)).toHaveAttribute('aria-selected', 'true');
}

/** The number on each tab, or '' where the tab prints none. */
async function tabCounts(page: Page) {
  return page.evaluate((tabs) => Object.fromEntries(tabs.map((tab) => {
    const n = document.querySelector('#mp-tab-' + tab + ' .mp-tabn');
    return [tab, n ? (n.textContent || '').trim() : ''];
  })), TABS);
}

/** Every text node a reader can see in the property, as written (not as CSS upper-cases it). */
async function visibleWords(page: Page): Promise<string> {
  return page.evaluate(() => {
    const out: string[] = [];
    const root = document.querySelector('.mp')!;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = w.nextNode())) {
      const el = n.parentElement;
      if (el && n.textContent?.trim() && el.checkVisibility({ visibilityProperty: true })) out.push(n.textContent);
    }
    return out.join('\n');
  });
}

test.describe('map property', () => {
  /**
   * @covers packages/server/public/app/surfaces/map-property.js::mountMapProperty
   * @covers packages/server/public/app/lib/map-property-model.js::propertyModel
   * @covers GET /api/journey
   */
  test('Invoice list: the design image is the hero, eight tabs carry the typed counts, APIs lists its calls by service', async ({ page }) => {
    await openProperty(page, PAGE.list);
    const img = page.locator('.mp-frame.img img');
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    await expect(page.locator('.mp-tab')).toHaveCount(8);
    // gates 5 (3 guards + 2 rules), APIs 5 distinct operations, tests 5 cases; nothing types the rest
    expect(await tabCounts(page)).toEqual({ overview: '', gates: '5', apis: '5', ux: '', tests: '5', route: '', work: '', changes: '' });
    // a tab's number is a tip trigger that says what it counts
    await page.locator('#mp-tab-gates .mp-tabn [data-tip-id]').click();
    await expect(page.locator('#fs-tip')).toContainText(/gates/i);

    await openTab(page, 'apis');
    const calls = page.locator('.mp-body .mp-row[data-map-card="call"]');
    await expect(calls).toHaveCount(5);
    await expect(calls.locator('.mp-svc')).toHaveText(Array(5).fill(/billing api/i));
    await expect(calls.first()).toContainText('List every invoice, newest first.');
    await expect(calls.first()).toContainText('GET /invoices');
    // the records its calls reach, each once
    await expect(page.locator('.mp-body .mp-row[data-map-card="record"]')).toHaveCount(3);
    await expect(page.locator('.mp-body .mp-row[data-map-card="message"]')).toHaveCount(1);

    await openTab(page, 'tests');
    await expect(page.locator('.mp-body .ev')).toHaveText(/seen by a coverage run/i);
    await expect(page.locator('.mp-body .mp-row[data-map-card="test"]')).toHaveCount(6);

    await openTab(page, 'work');
    await expect(page.locator('.mp-body')).toContainText('No work source is connected');
    await openTab(page, 'changes');
    // one ingest: there is no earlier sync to measure a change against, and the tab says so
    await expect(page.locator('.mp-body')).toContainText('no earlier sync to compare against');
  });

  /** @covers packages/server/public/app/surfaces/map-property.js::mountMapProperty */
  test('New invoice: the Tests tab names a case verified by its own declaration', async ({ page }) => {
    await openProperty(page, PAGE.newInvoice);
    expect(await tabCounts(page)).toMatchObject({ gates: '2', apis: '1', tests: '4' });
    await openTab(page, 'tests');
    await expect(page.locator('.mp-body .ev')).toHaveText(/passed, by its own declaration/i);
    const verified = page.locator('.mp-body .mp-row[data-map-card="test"]').filter({ has: page.locator('.mp-ev.byDeclaration') });
    await expect(verified).toHaveCount(1);
    await expect(verified).toContainText('a draft is saved for the picked customer');
    await openTab(page, 'ux');
    await expect(page.locator('.mp-body .sb-chip')).toContainText(/3 stories/);
  });

  /** @covers packages/server/public/app/surfaces/map-property.js::mountMapProperty */
  test('Discard draft: the placeholder names the screen, its route and why there is no picture; APIs says not built', async ({ page }) => {
    await openProperty(page, PAGE.discard);
    const ph = page.locator('.mp-frame.ph [data-hero="placeholder"]');
    await expect(ph).toBeVisible();
    await expect(ph.locator('.t')).toHaveText('Discard draft');
    await expect(ph).toContainText('/invoices/:param/discard');
    await expect(ph).toContainText('no render — open the design');
    await expect(ph).toContainText('no components found');
    await openTab(page, 'apis');
    await expect(page.locator('.mp-body .mp-warn')).toContainText('Not built');
    await expect(page.locator('.mp-body .mp-row[data-map-card="call"] .mp-evc')).toHaveText(['not built']);
  });

  /** @covers packages/server/public/app/surfaces/map-property.js::mountMapProperty */
  test('the step bar walks the journey: after → Invoice list → Discard draft, and back', async ({ page }) => {
    await openProperty(page, PAGE.newInvoice);
    const after = page.locator('.mp-step.next');
    const before = page.locator('.mp-step.prev');
    await expect(before).toBeDisabled();
    await expect(page.locator('.mp-where')).toHaveText(/screen 1 of 3 in billing cycle/i);
    await expect(after).toContainText('Invoice list');
    await after.click();
    await expect(page.locator('.mp')).toHaveAttribute('data-screen', PAGE.list);
    await expect(after).toContainText('Discard draft');
    await after.click();
    await expect(page.locator('.mp')).toHaveAttribute('data-screen', PAGE.discard);
    await expect(after).toBeDisabled();
    await before.click();
    await expect(page.locator('.mp')).toHaveAttribute('data-screen', PAGE.list);
    // the dots go straight to a screen, and the other journeys this screen is in are links onto the map
    await page.locator('.mp-dot').nth(0).click();
    await expect(page.locator('.mp')).toHaveAttribute('data-screen', PAGE.newInvoice);
    await expect(page.locator('.mp-alsochip')).toHaveText(['Start a new invoice']);
  });

  /** @covers packages/server/public/app/surfaces/map-property.js::mountMapProperty */
  test('the business lens prints no identifier on any tab of any screen', async ({ page }) => {
    for (const node of [PAGE.newInvoice, PAGE.list, PAGE.discard]) {
      await openProperty(page, node, 'business');
      await expect(page.locator('body')).toHaveClass(/lens-business/);
      for (const tab of TABS) {
        await openTab(page, tab);
        await expect(page.locator('.mp-loading')).toHaveCount(0);
        const hits = [...new Set((await visibleWords(page)).match(IDENTIFIER) || [])];
        expect(hits, `identifier-shaped words on ${node} · ${tab}`).toEqual([]);
      }
    }
  });
});
