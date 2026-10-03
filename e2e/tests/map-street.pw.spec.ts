// The MAP surface (docs/proposals/map-view.md, lane A): every journey on one
// zoomable board. The fixture's design names three journeys; Billing cycle has
// three screens — New invoice, Invoice list, and Discard draft (designed, not
// built, its one call planned). The map is a workspace experiment: the fixture
// sets no flags, so each test turns `flags.map` on in the page (never in the
// workspace) the way journey-numbers turns on the drill.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';
import { stubStores } from './map-stores-stub';

const FLOW = 'invoice-app::flow::billing-cycle';
const STREET = '#/map/' + encodeURIComponent(FLOW);
const LIST_PAGE = 'invoice-app::page::/invoices';

/** Identifier-shaped tokens (the journey-numbers check): camelCase, PascalCase compounds, snake_case, paths, HTTP verbs, spec files, document ids. */
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

/** Switch the map on for this page only — the flag is read client-side. */
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
/** Open Billing cycle's street (plumbing on or off) and wait until its screens are drawn. */
async function openStreet(page: Page, plumb = false) {
  await go(page, STREET + (plumb ? '?plumb=1' : ''));
  await expect(page.locator(`.map-district[data-flow="${FLOW}"] .map-scr`)).toHaveCount(3);
  await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
}
/** The words a reader can see on the board, as written. */
async function visibleWords(page: Page): Promise<string> {
  return page.evaluate(() => {
    const out: string[] = [];
    const w = document.createTreeWalker(document.querySelector('.map-stage')!, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = w.nextNode())) {
      const el = n.parentElement;
      if (!el || !n.textContent?.trim()) continue;
      if (el.checkVisibility({ visibilityProperty: true })) out.push(n.textContent);
    }
    return out.join('\n');
  });
}

test.describe('map — neighbourhood and street', () => {
  /**
   * @covers packages/server/public/app/shell.js::applyRoute
   * @covers packages/server/public/app/shell.js::navTabs
   * @covers packages/server/public/app/surfaces/map.js::mapEnabled
   */
  test('with the flag off there is no Map tab and a map link reads as the Portfolio', async ({ page }) => {
    await gotoReady(page, '#/map');
    await expect(page).toHaveURL(/#\/portfolio$/);
    await expect(page.locator('#nav .navtab')).not.toContainText(['Map']);
    await expect(page.locator('.pf-viewsw')).toHaveCount(0);
  });

  /**
   * @covers packages/server/public/app/surfaces/map.js::mountMap
   * @covers packages/server/public/app/lib/map-model.js::neighbourhoodModel
   * @covers packages/server/public/app/lib/map-model.js::layoutDistricts
   * @covers packages/server/public/app/lib/map-model.js::streetModel
   * @covers packages/server/public/app/lib/map-canvas.js::attachCanvas
   * @covers packages/server/public/app/surfaces/portfolio.js::mapSwitchHtml
   * @covers GET /api/design
   * @covers GET /api/journey
   */
  test('the three journeys as districts; entering Billing cycle walks its three screens in order', async ({ page }) => {
    await mapOn(page);
    // the Portfolio's door, drawn once the flag is on
    await go(page, '#/journeys');
    await go(page, '#/portfolio');
    await expect(page.locator('.pf-viewsw [data-go="map"]')).toBeVisible();
    await page.locator('.pf-viewsw [data-go="map"]').click();
    await expect(page).toHaveURL(/#\/map$/);
    await expect(page.locator('#nav .navtab.on')).toHaveText('Map');

    const districts = page.locator('.map-district');
    await expect(districts).toHaveCount(3);
    await expect(page.locator('.map-world')).toHaveClass(/lvl-nb/);
    for (const name of ['Billing cycle', 'Start a new invoice', 'Draft and send an invoice']) {
      await expect(page.locator('.map-dcover .nm', { hasText: name })).toBeVisible();
    }
    // every journey's numbers arrive as typed counts with their tips
    await expect(page.locator(`.map-district[data-flow="${FLOW}"] .map-dcover .map-chip[data-tip-id="number"]`).first()).toBeVisible();
    // the containing journey draws its parts' links
    await expect(page.locator('.map-links [data-link="partOf"]')).toHaveCount(2);
    await expect(page.locator('.map-links [data-link="leadsTo"]')).toHaveCount(1);
    // at the fit: one band for the one source, no two districts overlap, every cover's name reads at ≥ 12 px
    // and draws inside its district; part-of links wait for a hover
    await expect(page.locator('.map-band')).toHaveText(['invoice-app']);
    const fit = await page.evaluate(() => {
      const ds = [...document.querySelectorAll('.map-district')].map((d) => d.getBoundingClientRect());
      let overlaps = 0;
      for (let i = 0; i < ds.length; i++) for (let j = i + 1; j < ds.length; j++) {
        const a = ds[i], b = ds[j];
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps++;
      }
      let spill = 0;
      document.querySelectorAll('.map-district').forEach((d) => {
        const r = d.getBoundingClientRect();
        d.querySelectorAll('.map-dcover-in > *').forEach((c) => { const q = c.getBoundingClientRect(); if (q.right > r.right + 1 || q.bottom > r.bottom + 1) spill++; });
      });
      const names = [...document.querySelectorAll('.map-dcover .nm')].map((e) => parseFloat(getComputedStyle(e).fontSize) * e.getBoundingClientRect().height / (e as HTMLElement).offsetHeight);
      return { overlaps, spill, minName: Math.min(...names) };
    });
    expect(fit.overlaps).toBe(0);
    expect(fit.spill).toBe(0);
    expect(fit.minName).toBeGreaterThanOrEqual(12);
    await expect(page.locator('.map-links [data-link="partOf"].off')).toHaveCount(2);
    await page.locator(`.map-dcover[data-enter="${FLOW}"]`).hover();
    await expect(page.locator('.map-links [data-link="partOf"]:not(.off)')).toHaveCount(2);

    await page.locator(`.map-dcover[data-enter="${FLOW}"]`).click();
    await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
    await expect(page).toHaveURL(new RegExp('#/map/' + encodeURIComponent(FLOW)));
    const screens = page.locator(`.map-district[data-flow="${FLOW}"] .map-scr`);
    await expect(screens).toHaveCount(3);
    await expect(screens.locator('.ord')).toHaveText(['1', '2', '3']);
    await expect(screens.locator('.nm')).toHaveText(['New invoice', 'Invoice list', 'Discard draft']);
    await expect(screens.nth(2)).toHaveClass(/planned/);
    await expect(page.locator('.map-crumb')).toContainText('Billing cycle');
  });

  /**
   * @covers packages/server/public/app/surfaces/map.js::setPlumb
   * @covers packages/server/public/app/surfaces/map.js::mapKey
   * @covers packages/server/public/app/lib/map-model.js::streetModel
   */
  test('plumbing: each screen\'s calls with a service bar and what they read and write; the planned call is dashed', async ({ page }) => {
    await mapOn(page);
    await openStreet(page, true);
    await expect(page.locator('.map-world')).not.toHaveClass(/no-plumb/);
    const list = page.locator(`.map-pl[data-flow="${FLOW}"][data-si="1"]`);
    await expect(list).toHaveCount(5);
    for (let i = 0; i < 5; i++) {
      await expect(list.nth(i)).toHaveAttribute('data-svc', 'Billing API');
      await expect(list.nth(i)).toHaveClass(/svc-0/);
    }
    // the service bar is the call's top border, in the service's colour
    const bar = await list.first().evaluate((el) => getComputedStyle(el).borderTopWidth);
    expect(parseFloat(bar)).toBeGreaterThanOrEqual(3);
    await expect(page.locator(`.map-district[data-flow="${FLOW}"] .map-lane .leg`)).toContainText('Billing API');
    const writes = page.locator(`.map-pd[data-flow="${FLOW}"][data-si="1"][data-mode="write"]`);
    expect(await writes.count()).toBeGreaterThanOrEqual(1);
    await expect(writes.first()).toBeVisible();
    await expect(page.locator(`.map-pd[data-flow="${FLOW}"][data-si="1"][data-mode="both"]`).first()).toContainText('reads · writes');
    // Discard draft: one call, planned — dashed, not built, nothing beside it
    const discard = page.locator(`.map-pl[data-flow="${FLOW}"][data-si="2"]`);
    await expect(discard).toHaveCount(1);
    await expect(discard).toHaveClass(/absent/);
    await expect(discard).toHaveAttribute('data-evidence', 'not built');
    await expect(discard).toContainText('not built');
    await expect(page.locator(`.map-pd[data-flow="${FLOW}"][data-si="2"]`)).toHaveCount(0);
    const dashed = await discard.evaluate((el) => getComputedStyle(el).borderLeftStyle);
    expect(dashed).toBe('dashed');

    // p hides it again, and the address bar forgets it
    await page.locator('.map-board').click({ position: { x: 20, y: 300 } });
    await page.keyboard.press('p');
    await expect(page.locator('.map-world')).toHaveClass(/no-plumb/);
    await expect(page).not.toHaveURL(/plumb=1/);
    await expect(list.first()).toBeHidden();
  });

  /**
   * @covers packages/server/public/app/surfaces/map.js::openMapProperty
   * @covers packages/server/public/app/surfaces/map.js::closeProperty
   * @covers packages/server/public/app/surfaces/map.js::mapEscape
   */
  test('a screen opens its property through the hook, [ ] walk the journey, Esc lands back on the street', async ({ page }) => {
    await mapOn(page);
    await openStreet(page);
    await page.locator(`.map-scr[data-flow="${FLOW}"][data-index="1"] .nm`).click();
    const host = page.locator('.map-prop-host');
    await expect(host).toBeVisible();
    await expect(host).toContainText('Invoice list');
    await expect(page).toHaveURL(new RegExp('node=' + encodeURIComponent(LIST_PAGE).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await page.keyboard.press(']');
    await expect(host).toContainText('Discard draft');
    await page.keyboard.press('[');
    await expect(host).toContainText('Invoice list');
    await page.keyboard.press('Escape');
    await expect(host).toBeHidden();
    await expect(page).not.toHaveURL(/node=/);
    await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
    // a shared link opens the same screen straight away
    await go(page, '#/journeys');
    await go(page, STREET + '?node=' + encodeURIComponent(LIST_PAGE));
    await expect(host).toBeVisible();
    await expect(host).toContainText('Invoice list');
  });

  /**
   * @covers packages/server/public/app/lib/map-canvas.js::attachCanvas
   * @covers packages/server/public/app/surfaces/map.js::mapZoom
   * @covers packages/server/public/app/surfaces/map.js::mapFit
   */
  test('+ goes stop to stop and enters only after the hint; zooming out of a screen lands on the street; 0 fits the journey, Esc the board', async ({ page }) => {
    await mapOn(page);
    await openStreet(page);
    const world = page.locator('.map-world');
    // a plain scroll pans: the board moves, the scale does not
    const before = await world.evaluate((el) => el.style.transform);
    await page.mouse.move(700, 600);
    await page.mouse.wheel(120, 0);
    await expect.poll(() => world.evaluate((el) => el.style.transform)).not.toBe(before);
    await page.mouse.wheel(-120, 0);
    // + from the journey: Billing cycle is readable fitted, so the next stop is one screen large, named first
    const host = page.locator('.map-prop-host');
    const hint = page.locator('.map-hint');
    await page.keyboard.press('+');
    await expect(hint).toHaveClass(/enter/);
    await expect(hint).toContainText(/Zoom in again to enter/);
    await expect(host).toBeHidden();
    await page.keyboard.press('+');
    await expect(host).toBeVisible();
    // a pinch out (⌘/Ctrl + scroll out) over the screen leaves it
    await page.keyboard.down('Control');
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 60);
    await page.keyboard.up('Control');
    await expect(host).toBeHidden();
    await expect(page.locator('.map-zoomro')).toHaveText('×1.00');
    // 0 fits the journey the street is on, and keeps it
    await page.keyboard.press('0');
    await expect(world).toHaveClass(/lvl-st/);
    await expect(page.locator('.map-crumb')).toContainText('Billing cycle');
    await expect(page).toHaveURL(new RegExp('#/map/' + encodeURIComponent(FLOW)));
    // Esc backs out to every journey
    await page.keyboard.press('Escape');
    await expect(world).toHaveClass(/lvl-nb/);
    // the neighbourhood names no journey; the link carries where the board is (§K)
    await expect(page).toHaveURL(/#\/map(\?z=[\d.]+&x=-?\d+&y=-?\d+)?$/);
  });

  /**
   * @covers packages/server/public/app/surfaces/map.js::closeCard
   * @covers packages/server/public/app/lib/map-model.js::screensUsing
   */
  test('a call opens the explore card: what it is, where it is drawn, and a door to its own surface', async ({ page }) => {
    await mapOn(page);
    await openStreet(page, true);
    await page.locator(`.map-pl[data-flow="${FLOW}"][data-si="0"][data-ci="0"] .nm`).click();
    const card = page.locator('.map-xcard');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Billing API');
    await expect(card).toContainText('spec-backed');
    await expect(card.locator('.where .map-chip.go')).toHaveText(['New invoice', 'Invoice list']);
    await expect(card.locator('.acts a').first()).toHaveAttribute('href', /#\/apis\//);
    // Esc closes the card before anything else
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();
    await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
    // and a screen on the card travels there
    await page.locator(`.map-pd[data-flow="${FLOW}"][data-si="1"][data-mode="write"]`).first().click();
    await expect(card).toBeVisible();
    await card.locator('.where .map-chip.go', { hasText: 'Invoice list' }).click();
    await expect(page.locator('.map-prop-host')).toContainText('Invoice list');
  });

  /**
   * @covers packages/server/public/app/surfaces/map.js::mapRefresh
   * @covers packages/server/public/app/strings.js::plainWords
   */
  test('the business lens on the street prints no identifier, plumbing included', async ({ page }) => {
    await mapOn(page);
    await page.locator('#lb-business').click();
    await expect(page.locator('body')).toHaveClass(/lens-business/);
    await openStreet(page, true);
    await expect(page.locator(`.map-pl[data-flow="${FLOW}"]`).first()).toBeVisible();
    const text = await visibleWords(page);
    expect(text).toContain('Invoice list');
    const hits = [...new Set(text.match(IDENTIFIER) || [])];
    expect(hits, 'identifier-shaped words on the business street').toEqual([]);
    // the explore card too
    await page.locator(`.map-pl[data-flow="${FLOW}"][data-si="1"][data-ci="0"] .nm`).click();
    await expect(page.locator('.map-xcard')).toBeVisible();
    const cardText = await page.locator('.map-xcard').evaluate((el) => [...el.querySelectorAll('*')]
      .filter((e) => e.childNodes.length && [...e.childNodes].some((c) => c.nodeType === 3 && c.textContent!.trim()) && (e as HTMLElement).checkVisibility())
      .map((e) => [...e.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join('')).join('\n'));
    expect([...new Set(cardText.match(IDENTIFIER) || [])], 'identifier-shaped words on the business card').toEqual([]);
  });
});

/**
 * A street longer than the fixture's: the real Billing cycle answer with one
 * call made on Invoice list and given eight records (five read, three written),
 * so the screen makes six calls — the suite's own pattern of shaping an answer
 * with `page.route` (ADR 8), never a second fixture.
 */
async function stubLongStreet(page: Page) {
  await page.route(/\/api\/journey\?entry=invoice-app(%3A%3A|::)flow(%3A%3A|::)billing-cycle$/, async (route) => {
    const res = await route.fetch();
    const data = await res.json();
    const seg = data.summary.segments[1];
    const api = data.summary.systems.find((r: { kind: string }) => r.kind === 'api').key;
    let order = 9000;
    const call = { stepOrder: ++order, depth: 4, nodeId: 'invoice-app::route::POST /invoices/:id/remind', name: 'POST /invoices/:id/remind', kind: 'call', via: 'http', system: api, moment: 0, title: 'Remind the customer about an open invoice.', business: 'Remind the customer about an open invoice.', method: 'POST', path: '/invoices/:id/remind', tier: 0 };
    const records = Array.from({ length: 8 }, (_, i) => ({ stepOrder: ++order, depth: 5, nodeId: 'invoice-app::table::customer_reminder_log_' + i, name: 'customer_reminder_log_' + i, kind: 'record', via: i < 5 ? 'reads' : 'writes', op: i < 5 ? 'reads' : 'writes', system: 'records', moment: 0, under: call.stepOrder, tier: 0 }));
    seg.markers = [...seg.markers, call, ...records];
    await route.fulfill({ response: res, json: data });
  });
}

test.describe('map — the street folds a long pathway', () => {
  /**
   * @covers packages/server/public/app/surfaces/map.js::toggleFold
   * @covers packages/server/public/app/surfaces/map.js::streetHtml
   */
  test('a screen draws its first four calls and a call its first three data nodes, writes first; each fold opens in place without overlap', async ({ page }) => {
    await stubLongStreet(page);
    await mapOn(page);
    await openStreet(page, true);
    const calls = page.locator(`.map-pl[data-flow="${FLOW}"][data-si="1"]`);
    await expect(calls).toHaveCount(4);
    const moreCalls = page.locator(`.map-fold.calls[data-fold="calls|${FLOW}|1"]`);
    await expect(moreCalls).toHaveText(/2 more calls/);
    await expect(moreCalls.locator('.n')).toHaveAttribute('data-tip-id', 'number');
    // the other screens are short enough to draw whole
    await expect(page.locator('.map-fold.calls')).toHaveCount(1);

    await moreCalls.click();
    await expect(calls).toHaveCount(6);
    await expect(page.locator(`.map-fold.calls[data-fold="calls|${FLOW}|1"]`)).toHaveText(/fewer calls/);
    // the sixth call: three of its eight records drawn — the three it writes — and five folded
    const data = page.locator(`.map-pd[data-flow="${FLOW}"][data-si="1"][data-ci="5"]`);
    await expect(data).toHaveCount(3);
    await expect(data.locator('.rw')).toHaveText(['writes', 'writes', 'writes']);
    const moreData = page.locator(`.map-fold.data[data-fold="data|${FLOW}|1|5"]`);
    await expect(moreData).toHaveText(/5 more/);
    await moreData.click();
    await expect(data).toHaveCount(8);
    // the data node's name reads whole at the street (23 characters: Customer reminder log 0)
    const clipped = await data.locator('.nm').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
    expect(clipped).toBe(0);

    // nothing on the street overlaps after both folds opened, and the district holds it all
    const report = await page.evaluate((flow) => {
      const dist = document.querySelector(`.map-district[data-flow="${flow}"]`)!.getBoundingClientRect();
      const boxes = [...document.querySelectorAll(`.map-district[data-flow="${flow}"] :is(.map-scr,.map-pl,.map-pd,.map-fold)`)].map((e) => e.getBoundingClientRect());
      let overlaps = 0, outside = 0;
      for (let i = 0; i < boxes.length; i++) {
        const a = boxes[i];
        if (a.right > dist.right + 1 || a.bottom > dist.bottom + 1) outside++;
        for (let j = i + 1; j < boxes.length; j++) {
          const b = boxes[j];
          if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlaps++;
        }
      }
      return { overlaps, outside, n: boxes.length };
    }, FLOW);
    expect(report.overlaps).toBe(0);
    expect(report.outside).toBe(0);
    // no district overlaps its neighbours either, though this one grew
    const districts = await page.evaluate(() => {
      const ds = [...document.querySelectorAll('.map-district')].map((d) => d.getBoundingClientRect());
      let n = 0;
      for (let i = 0; i < ds.length; i++) for (let j = i + 1; j < ds.length; j++) {
        const a = ds[i], b = ds[j];
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) n++;
      }
      return n;
    });
    expect(districts).toBe(0);
    // and folding back returns to three
    await page.locator(`.map-fold.data[data-fold="data|${FLOW}|1|5"]`).click();
    await expect(data).toHaveCount(3);
  });
});

test.describe('map — data stores on the street', () => {
  /**
   * @covers packages/server/public/app/surfaces/map.js::dataHtml
   * @covers packages/server/public/app/surfaces/map.js::streetHtml
   * @covers packages/server/public/app/lib/map-model.js::storesOf
   */
  test('a record names its store, the ERP is drawn as a store with its mode, reached when no method was recorded, the legend lists the stores', async ({ page }) => {
    await stubStores(page);
    await mapOn(page);
    await openStreet(page, true);
    const pd = (si: number) => page.locator(`.map-pd[data-flow="${FLOW}"][data-si="${si}"]`);
    // New invoice writes invoices: the kind line names the store in words, the bar is the database's violet
    const inv = pd(0).filter({ hasText: 'Invoices' }).first();
    await expect(inv.locator('.kd')).toContainText('Invoice DB · record');
    await expect(inv).toHaveAttribute('data-store', 'Invoice DB');
    await expect(inv).toHaveAttribute('data-store-kind', 'sql');
    // finalize writes the ERP: a store, in the record anatomy, amber, with the write word from op
    const erpWrite = pd(1).and(page.locator('[data-kind="external"][data-mode="write"]'));
    await expect(erpWrite).toHaveCount(1);
    await expect(erpWrite.locator('.kd')).toContainText('Example ERP · ERP');
    await expect(erpWrite.locator('.rw')).toHaveText('writes');
    await expect(erpWrite).toHaveClass(/\brec\b/);
    const bars = await page.evaluate(() => {
      const c = (sel: string) => getComputedStyle(document.querySelector(sel)!).borderLeftColor;
      const probe = (v: string) => { const d = document.createElement('div'); d.style.color = `var(${v})`; document.body.appendChild(d); const x = getComputedStyle(d).color; d.remove(); return x; };
      return { erp: c('.map-pd[data-store-kind="erp"]'), sql: c('.map-pd[data-store-kind="sql"]'), amber: probe('--amber'), tbl: probe('--tbl') };
    });
    expect(bars.erp).toBe(bars.amber);
    expect(bars.sql).toBe(bars.tbl);
    // the list read reaches the ERP with no method recorded: reached, never writes
    const erpReached = pd(1).and(page.locator('[data-kind="external"][data-mode="reached"]'));
    await expect(erpReached).toHaveCount(1);
    await expect(erpReached.locator('.rw')).toHaveText('reached');
    // the legend: the stores this journey touches, and the reached swatch because a node uses it
    const leg = page.locator(`.map-district[data-flow="${FLOW}"] .map-lane .leg`);
    await expect(leg.locator('.mst')).toHaveText(['Invoice DB · database', 'Example ERP · ERP']);
    await expect(leg).toContainText('reached');
    // the head's stores chip is the summary's own Counted (one store from the fixture's config; the stub's ERP is not
    // in the server's count), with its tip
    const chip = page.locator(`.map-district[data-flow="${FLOW}"] .map-dhead .map-chip.k-store`);
    await expect(chip).toHaveText(/1 data store/);
    await expect(chip).toHaveAttribute('data-tip-id', 'number');
  });

  /**
   * @covers packages/server/public/app/surfaces/map.js::drawCard
   * @covers packages/server/public/app/surfaces/map.js::dataKindWords
   */
  test('the explore card names the store and, outside the business register, how it is known', async ({ page }) => {
    await stubStores(page);
    await mapOn(page);
    await openStreet(page, true);
    await page.locator(`.map-pd[data-flow="${FLOW}"][data-si="0"][data-store="Invoice DB"]`).first().click();
    const card = page.locator('.map-xcard');
    await expect(card).toBeVisible();
    await expect(card.locator('.store .mst')).toHaveText('Invoice DB · database');
    await expect(card.locator('.store .via')).toBeVisible();
    await expect(card.locator('.store .via')).toContainText('known from the workspace settings');
  });

  /** @covers packages/server/public/app/surfaces/map.js::drawCard */
  test('the business street with stores prints no identifier: store names in words, how it is known hidden', async ({ page }) => {
    await stubStores(page);
    await mapOn(page);
    await page.locator('#lb-business').click();
    await expect(page.locator('body')).toHaveClass(/lens-business/);
    await openStreet(page, true);
    await expect(page.locator(`.map-pd[data-flow="${FLOW}"][data-store="Example ERP"]`).first()).toBeVisible();
    const text = await visibleWords(page);
    expect(text).toContain('Invoice DB');
    expect(text).toContain('Example ERP');
    expect([...new Set(text.match(IDENTIFIER) || [])], 'identifier-shaped words on the business street').toEqual([]);
    await page.locator(`.map-pd[data-flow="${FLOW}"][data-si="1"][data-store="Example ERP"]`).first().click();
    const card = page.locator('.map-xcard');
    await expect(card.locator('.store .mst')).toBeVisible();
    await expect(card.locator('.store .via')).toBeHidden();
    const words = await card.evaluate((el) => (el as HTMLElement).innerText);
    expect(words).toContain('Example ERP');
    expect([...new Set(words.match(IDENTIFIER) || [])], 'identifier-shaped words on the business card').toEqual([]);
  });
});
