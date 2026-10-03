// The map's property view (docs/proposals/map-view.md §1, §3.2): one screen up
// close, reached through the map surface's deep link. The fixture's Billing cycle
// has three screens — New invoice (built, a design image, stories on its form),
// Invoice list (built, an image, five calls) and Discard draft (designed, not
// built, a Figma frame with no render: the placeholder). The counts asserted
// here were measured on the fixture, never guessed: each is a `Counted` the
// journey summary carries, and a tab nothing types prints no number.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';
import { stubStores } from './map-stores-stub';

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

/** A tall screenshot (1:3), the shape a real app's design export takes; served in place of the list's 16:10 design. */
const TALL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="2400" viewBox="0 0 800 2400"><rect width="800" height="2400" fill="#F6F8FB"/>'
  + '<rect width="800" height="120" fill="#2B6CDF"/><rect y="2280" width="800" height="120" fill="#E0457B"/></svg>';
const LONG_WORDS = 'The operator reviews the record and decides what happens next. '
  + Array.from({ length: 30 }, (_, i) => `Clause ${i + 1} adds a detail about who may act on this screen and what it shows them.`).join(' ');

/**
 * A real application's screen, synthesised over the fixture's own answers (the
 * suite's page.route pattern, never a bigger fixture): a 200-word description,
 * 25 gates, 273 cases, stories on five parts and five more journeys through the
 * screen. Counts move with the rows, so every number stays the answer's own.
 */
async function realShaped(page: Page) {
  await page.route(/\/api\/design\/image\?node=invoice-app%3A%3Apage%3A%3A%2Finvoices$/, (r) => r.fulfill({ contentType: 'image/svg+xml', body: TALL_SVG }));
  // A disposed response means the page moved on (the map keeps fetching in the
  // background); the stub then steps aside instead of failing the test at teardown.
  await page.route(/\/graph$/, async (r) => {
    let g: any;
    try { g = await (await r.fetch()).json(); } catch { return; }
    const parts = ['invoice-app::src/ui/InvoiceListPage.tsx::InvoiceListPage', 'invoice-app::src/ui/EditInvoiceDrawer.tsx::EditInvoiceDrawer', 'invoice-app::src/ui/fields.tsx::LineItemRow', PAGE.list];
    for (const n of g.nodes) if (parts.includes(n.id)) n.stories = [1, 2, 3, 4].map((k) => ({ id: `${n.id}--s${k}`, name: `State ${k}`, title: 'Parts', file: 'x.stories.tsx', line: k }));
    for (let i = 1; i <= 5; i++) {
      const id = `invoice-app::flow::other-${i}`;
      g.nodes.push({ id, kind: 'flow', name: `Another journey ${i} through the same screen`, repo: 'invoice-app', tags: [] });
      g.edges.push({ id: `renders|${id}|${PAGE.list}`, kind: 'renders', from: id, to: PAGE.list });
    }
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify(g) });
  });
  await page.route(/\/api\/journey\?/, async (r) => {
    if (!r.request().url().includes('billing-cycle')) return r.continue();
    let d: any;
    try { d = await (await r.fetch()).json(); } catch { return; }
    {
      const sg = d.summary.segments[1];
      sg.screen.business = LONG_WORDS;
      for (const sc of d.screens) if (sc.id === PAGE.list) sc.bizDescription = LONG_WORDS;
      const g0 = sg.gates;
      sg.gates = Array.from({ length: 25 }, (_, i) => ({ ...g0[i % g0.length], id: `${g0[i % g0.length].id}#${i}`, name: `requireScope: area ${i}`, kind: 'guard', stepOrder: i }));
      sg.counted.gates = { ...sg.counted.gates, n: 25, breakdown: [{ key: 'count.part.guards', n: 25 }, { key: 'count.part.rules', n: 0 }] };
      const cov = d.summary.coverage.segments[1];
      const t0 = cov.tests.find((x: { runLevel?: boolean }) => !x.runLevel);
      cov.tests = Array.from({ length: 273 }, (_, i) => ({ ...t0, id: `${t0.id} #${i}`, name: `case ${i + 1} of the screen` }));
      cov.counted.tests = { ...cov.counted.tests, n: 273, breakdown: [{ key: 'journey.testsUnit', n: 0 }, { key: 'journey.testsIntegration', n: 0 }, { key: 'journey.testsE2e', n: 273 }] };
    }
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify(d) }).catch(() => {});
  });
}

/** The picture is shown whole: inside its frame, at its own aspect. */
async function wholePicture(page: Page) {
  const img = page.locator('.mp-frame.img img');
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => {
    const i = document.querySelector('.mp-frame.img img') as HTMLImageElement;
    const f = document.querySelector('.mp-frame.img')!.getBoundingClientRect();
    const r = i.getBoundingClientRect();
    const inside = r.top >= f.top - 1 && r.bottom <= f.bottom + 1 && r.left >= f.left - 1 && r.right <= f.right + 1;
    const aspect = Math.abs(r.width / r.height - i.naturalWidth / i.naturalHeight) < 0.02;
    return inside && aspect;
  })).toBe(true);
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

    // the hero sizes from its own box, never from the rail: the same on every tab, and below its chip row
    const box = () => page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      return { chipsBottom: r('.mp-hero-chips').bottom, shot: [r('.mp-shot').top, r('.mp-shot').width, r('.mp-shot').height].map(Math.round) };
    });
    const onOverview = await box();
    expect(onOverview.shot[0]).toBeGreaterThanOrEqual(onOverview.chipsBottom);

    await openTab(page, 'apis');
    expect(await box()).toEqual(onOverview);
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
    await expect(page.locator('.mp-where')).toHaveText(/screen 1 of 3 reached · billing cycle/i);
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
  /**
   * @covers packages/server/public/app/surfaces/map-property.js::mountMapProperty
   * @covers packages/server/public/app/surfaces/map-property.js::capRows
   * @covers packages/server/public/app/surfaces/map-property.js::clampHtml
   */
  test('a real-sized screen: the tall picture whole, the description clamped, long lists capped with show all n', async ({ page }) => {
    await realShaped(page);
    await openProperty(page, PAGE.list);
    await wholePicture(page);
    expect(await tabCounts(page)).toMatchObject({ gates: '25', tests: '273' });

    // two sentences and a more, the rest one click away
    const what = page.locator('.mp-body .mp-biz .mp-clamp');
    await expect(what.locator('.short')).toBeVisible();
    await expect(what.locator('.full')).toBeHidden();
    await expect(what.locator('.short')).toHaveText('The operator reviews the record and decides what happens next. Clause 1 adds a detail about who may act on this screen and what it shows them.');
    await what.locator('.mp-more').click();
    await expect(page.locator('.mp-body .mp-biz .mp-clamp .full')).toBeVisible();
    await expect(page.locator('.mp-body .mp-biz .mp-clamp .full')).toContainText('Clause 30');
    await page.locator('.mp-body .mp-biz .mp-more').click();
    await expect(page.locator('.mp-body .mp-biz .mp-clamp .full')).toBeHidden();

    // story chips past three fold into one, which opens in place
    const fold = page.locator('.mp-hero-chips .mp-fold');
    await expect(fold).toHaveText(/19 stories on 5 parts/i);
    await fold.click();
    await expect(page.locator('.mp-hero-chips .sb-chip:not(.mp-fold)')).toHaveCount(5);

    // the other journeys: three chips and one for the rest
    await expect(page.locator('.mp-foot .mp-alsochip')).toHaveCount(3);
    await page.locator('.mp-foot .mp-fold').click();
    await expect(page.locator('.mp-foot .mp-alsochip')).toHaveCount(6);
    const foot = await page.locator('.mp-foot').boundingBox();
    expect(foot!.y + foot!.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));

    // Gates: ten rows, then show all 25 — the tab's own count — and every row once opened
    await openTab(page, 'gates');
    const gateRows = page.locator('.mp-body section').first().locator('.mp-row[data-map-card="gate"]');
    await expect(gateRows).toHaveCount(10);
    const allGates = page.locator('.mp-body .mp-all[data-list="gates"]');
    await expect(allGates).toHaveText(/show all 25/i);
    await allGates.click();
    await expect(gateRows).toHaveCount(25);

    // Tests: 273 cases are ten rows until asked
    await openTab(page, 'tests');
    const cases = page.locator('.mp-body .mp-row[data-map-card="test"]');
    await expect(cases).toHaveCount(10);
    await expect(page.locator('.mp-body .mp-all[data-list="cases"]')).toHaveText(/show all 273/i);
    await page.locator('.mp-body .mp-all[data-list="cases"]').click();
    await expect(cases).toHaveCount(273);
    await expect(page.locator('.mp-body .mp-all[data-list="cases"]')).toHaveText(/show the first 10 only/i);
  });

  /** @covers packages/server/public/app/surfaces/map-property.js::mountMapProperty */
  test('the fixture\'s 16:10 pictures are shown whole too', async ({ page }) => {
    for (const node of [PAGE.newInvoice, PAGE.list]) {
      await openProperty(page, node);
      await wholePicture(page);
    }
  });
});

test.describe('map property — data stores', () => {
  /**
   * @covers packages/server/public/app/surfaces/map-property.js::storeGroupHtml
   * @covers packages/server/public/app/lib/map-property-model.js::dataByStore
   */
  test('APIs: Data this screen reaches, grouped by store, the ERP with its mode, unnamed data last; the tab count unchanged', async ({ page }) => {
    await stubStores(page);
    await openProperty(page, PAGE.list);
    expect((await tabCounts(page)).apis).toBe('5');
    await openTab(page, 'apis');
    const body = page.locator('.mp-body');
    await expect(body).toContainText('Data this screen reaches');
    // named stores in the order the screen meets them (the list read reaches the ERP first), then the unnamed message
    await expect(body.locator('.mp-grp')).toHaveText(['Example ERP · ERP', 'Invoice DB · database', 'message']);
    const erp = body.locator('.mp-store', { has: page.locator('.mp-grp[data-store="Example ERP"]') });
    await expect(erp.locator('.mp-row')).toHaveCount(1);
    await expect(erp.locator('.mp-mode')).toHaveText('writes');
    await expect(body.locator('.mp-store', { has: page.locator('.mp-grp[data-store="Invoice DB"]') }).locator('.mp-row')).toHaveCount(3);
  });

  /** @covers packages/server/public/app/surfaces/map-property.js::storeGroupHtml */
  test('the business lens: store names print, no identifier on the APIs tab', async ({ page }) => {
    await stubStores(page);
    await openProperty(page, PAGE.list, 'business');
    await openTab(page, 'apis');
    const text = await visibleWords(page);
    expect(text).toContain('Invoice DB');
    expect(text).toContain('Example ERP');
    expect([...new Set(text.match(IDENTIFIER) || [])], 'identifier-shaped words on the business APIs tab').toEqual([]);
  });
});
