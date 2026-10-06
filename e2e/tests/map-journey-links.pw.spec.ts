// The Map and the journey open each other at the same step, and every detail is
// a door (round 2026-10-05 §3). The fixture's Billing cycle has three screens —
// New invoice, Invoice list, Discard draft — one segment each, so step 2 is the
// Invoice list on both pictures. Its gates (`requireScope(billing:read)` met on the
// Invoice list) and its calls (`GET /invoices`, spec-backed by openapi.yaml) are
// the details the doors are asked about.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';

const FLOW = 'invoice-app::flow::billing-cycle';
const GATE = 'invoice-app::guard::requireScope(billing:read)';
const ROUTE = 'invoice-app::route::GET /invoices';
const enc = encodeURIComponent;

/** The fixture sets no flags: the map is switched on in this page only (never written to the workspace). */
async function mapOn(page: Page, lens = 'hybrid') {
  await gotoReady(page, '#/portfolio?lens=' + lens);
  await page.evaluate(() => {
    const S = (window as any).S;
    S.SETTINGS = Object.assign({}, S.SETTINGS, { flags: Object.assign({}, S.SETTINGS && S.SETTINGS.flags, { map: true }) });
  });
}
async function go(page: Page, hash: string) {
  await page.evaluate((h) => { location.hash = h; }, hash);
}

/**
 * @covers packages/server/public/app/lib/route-url.js::journeyStepHash
 * @covers packages/server/public/app/lib/route-url.js::mapScreenHash
 * @covers packages/server/public/app/surfaces/journeys.js::jrnApplyStep
 */
test('the Map opens the journey at the same step, and the journey opens the Map back on it', async ({ page }) => {
  await mapOn(page);
  await go(page, '#/map/' + enc(FLOW) + '?screen=2');
  const second = page.locator('.map-scr[data-flow="' + FLOW + '"][data-index="1"]');
  await expect(second).toBeFocused();
  const door = second.locator('.map-tojrn a');
  await expect(door).toHaveText('open the journey here');
  await door.click();
  await expect(page.getByRole('dialog', { name: 'Journey', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/journeys\/invoice-app%3A%3Aflow%3A%3Abilling-cycle\?view=timeline&step=2/);
  await expect(page.locator('#jrn-sh-1')).toHaveClass(/\bon\b/);
  await expect(page.locator('.jrn-layoutsw .jrn-viewbtn.on')).toHaveText(/timeline/i);
  // and back: the header's door names the step on screen
  const back = page.locator('#jrn-tomap a');
  await expect(back).toHaveAttribute('href', /#\/map\/invoice-app%3A%3Aflow%3A%3Abilling-cycle\?screen=2/);
  await back.click();
  await expect(page.locator('.map-scr[data-flow="' + FLOW + '"][data-index="1"]')).toBeFocused();
});

/** @covers packages/server/public/app/surfaces/journeys.js::jrnApplyStep */
test('a link to a step and a node selects that part', async ({ page }) => {
  await gotoReady(page, '#/journeys/' + enc(FLOW) + '?step=2&node=' + enc(ROUTE) + '&dock=right&lens=hybrid');
  await expect(page.locator('#jrn-sh-1')).toHaveClass(/\bon\b/);
  await expect(page).toHaveURL(/node=invoice-app%3A%3Aroute%3A%3AGET%20%2Finvoices(&|$)/);
  await expect(page.locator('#jrn-dock .jrn-insp-doors a.dd-door').first()).toHaveText('read the contract');
});

/**
 * @covers packages/server/public/app/surfaces/journeys.js::jrnGateExpand
 * @covers GET /api/source
 */
test('a gate opens to its own lines and the editor in hybrid, and to its words alone in business', async ({ page }) => {
  await gotoReady(page, '#/journeys/' + enc(FLOW) + '?step=2&biz=gates&dock=right&lens=hybrid');
  const more = page.locator('.jrn-gl-more[data-gate="' + GATE + '"]').first();
  await more.click();
  const exp = page.locator('.jrn-gl-exp').first();
  await expect(exp.locator('.dd-pre')).toContainText('requireScope');
  await expect(exp.locator('a.dd-door.editor')).toHaveAttribute('href', /^vscode:\/\/file\/.+src\/server\/routes\.ts:\d+$/);
  await expect(exp.locator('a.dd-door', { hasText: 'see it on the code map' })).toHaveAttribute('href', '#/codemap?node=' + enc(GATE));
  await expect(more).toHaveAttribute('aria-expanded', 'true');

  await gotoReady(page, '#/journeys/' + enc(FLOW) + '?step=2&biz=gates&dock=right&lens=business');
  await page.locator('.jrn-gl-more[data-gate="' + GATE + '"]').first().click();
  const biz = page.locator('.jrn-gl-exp').first();
  await expect(biz.locator('.dd-words')).not.toBeEmpty();
  await expect(biz.locator('.dd-code')).toHaveCount(0);
  await expect(biz.locator('a.dd-door')).toHaveCount(0);
});

/** @covers packages/server/public/app/lib/detail-links.js::detailLinks */
test('a route call links to the APIs surface at its operation, its spec line and its handler', async ({ page }) => {
  await mapOn(page);
  await go(page, '#/map/' + enc(FLOW) + '?plumb=1&card=call:' + enc(ROUTE));
  const card = page.locator('.map-xcard');
  await expect(card).toBeVisible();
  const doors = card.locator('.acts a.dd-door');
  await expect(doors.first()).toHaveText('read the contract');
  await expect(doors.first()).toHaveAttribute('href', '#/apis/' + enc('invoice-app::api::openapi.yaml') + '?op=' + enc(ROUTE));
  await expect(card.locator('a.dd-door', { hasText: 'read the spec file' })).toHaveAttribute('href', /\?view=spec&line=\d+$/);
  await expect(card.locator('a.dd-door', { hasText: 'open the handler in the editor' })).toHaveAttribute('href', /^vscode:\/\/file\//);
  // where the journey stands in its storyline (the fixture's invoice storyline ends with Billing cycle)
  await expect(card.locator('.dd-story')).toHaveText('in storyline: An invoice, end to end · step 3 of 3');
  // the same part in the journey, selected
  await expect(card.locator('.tojrn a')).toHaveAttribute('href', /step=\d&node=invoice-app%3A%3Aroute%3A%3AGET%20%2Finvoices/);
  await doors.first().click();
  await expect(page).toHaveURL(/#\/apis\/invoice-app%3A%3Aapi%3A%3Aopenapi\.yaml\?op=invoice-app%3A%3Aroute%3A%3AGET%20%2Finvoices/);
});

/** @covers packages/server/public/app/lib/detail-doors.js::doorKeydown */
test('on the property a row opens to its doors, and Enter on it opens the first', async ({ page }) => {
  await mapOn(page);
  await go(page, '#/map/' + enc(FLOW) + '?node=' + enc('invoice-app::page::/invoices'));
  await expect(page.locator('.mp')).toBeVisible();
  await page.locator('#mp-tab-apis').click();
  const row = page.locator('.mp-row.has-doors[data-map-card="call"][data-id="' + ROUTE + '"]').first();
  await row.locator('.nm').click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(row.locator('.mp-exp a.dd-door').first()).toHaveText('read the contract');
  await expect(row.locator('.jrn-contract-card')).toBeVisible();
  await expect(page.locator('.mp-head .mp-story')).toContainText('step 3 of 3');
  // the head opens the same screen in the journey
  await expect(page.locator('.mp-tojrn a')).toHaveAttribute('href', /#\/journeys\/invoice-app%3A%3Aflow%3A%3Abilling-cycle\?view=timeline&step=2/);
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/apis\/.+\?op=invoice-app%3A%3Aroute%3A%3AGET%20%2Finvoices/);
});

/** @covers packages/server/public/app/surfaces/map.js::coverAggHtml */
test('the board marks stale quietly and not built in amber, each with its own word', async ({ page }) => {
  // the fixture's tests are fresh: one journey's evidence is made stale at the network, the rest is real
  await page.route('**/api/journey?*', async (r) => {
    const res = await r.fetch();
    const j = await res.json();
    const cov = j && j.summary && j.summary.coverage && j.summary.coverage.journey;
    if (cov && /billing-cycle/.test(r.request().url())) cov.evidenceWord = Object.assign({}, cov.evidenceWord, { cls: 'stale' });
    await r.fulfill({ response: res, json: j });
  });
  await mapOn(page);
  await go(page, '#/map');
  const card = page.locator('.map-district[data-flow="' + FLOW + '"] .map-dcover');
  const stale = card.locator('.map-mark.stale');
  const notBuilt = card.locator('.map-mark.notbuilt');
  await expect(stale).toHaveText('stale');
  await expect(notBuilt).toHaveText('not built');
  const color = (l: typeof stale) => l.evaluate((el) => getComputedStyle(el).color);
  expect(await color(stale)).not.toEqual(await color(notBuilt));
  await expect(card.locator('.map-mark.risk')).toHaveCount(0);
  // the Map fetches its journeys one at a time: a walk still in flight when the test ends must not fail the run
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

/**
 * A board too full to read at its fit: the fixture's design and Billing cycle's walk, stubbed into ninety
 * journeys with page.route (ADR 8), so the fit would draw a card's words under eight pixels.
 * @covers packages/server/public/app/surfaces/map.js::coverScale
 */
test('past the reading floor the board says so, and no card word draws under it', async ({ page }) => {
  const N = 90;
  await page.route(/\/api\/design\?/, async (r) => {
    let d: any;
    try { d = await (await r.fetch()).json(); } catch { return; }
    const src = d.designs[0];
    const base = src.flows.find((f: any) => f.id === 'billing-cycle');
    src.flows = Array.from({ length: N }, (_, i) => ({ ...base, nodeId: 'invoice-app::flow::many-' + i, id: 'many-' + i, name: 'Journey number ' + (i + 1) }));
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify(d) });
  });
  await page.route(/\/api\/journey\?entry=/, async (r) => {
    const url = r.request().url();
    if (!/many-\d+/.test(decodeURIComponent(url))) return r.continue();
    let d: any;
    try { d = await (await r.fetch({ url: url.replace(/entry=[^&]*/, 'entry=' + encodeURIComponent(FLOW)) })).json(); } catch { return; }
    d.summary.links = { requires: [], leadsTo: [], partOf: [] };
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify(d) });
  });
  await mapOn(page);
  await go(page, '#/map');
  await expect(page.locator('.map-dcover')).toHaveCount(N);
  const hint = page.locator('.map-hint');
  await expect(hint).toHaveClass(/\bfloor\b/);
  await expect(hint).toHaveText(N + ' journeys · zoom in to read');
  await expect(page.locator('.map-world')).toHaveClass(/\bfloor\b/);
  // no word on a card draws under 8 px on screen: the font size times the scale the card is drawn at — polled, since
  // the floor class lands a frame before the fit that applies it (a one-shot read failed under load)
  await expect.poll(() => page.locator('.map-dcover .map-chip').first().evaluate((el) => {
    const h = (el as HTMLElement).offsetHeight;
    return parseFloat(getComputedStyle(el).fontSize) * (h ? el.getBoundingClientRect().height / h : 1);
  })).toBeGreaterThanOrEqual(7.9);
});

/** @covers packages/server/public/app/surfaces/journeys.js::gotoJourney */
test('a storyline opens its journeys at their first step', async ({ page }) => {
  await gotoReady(page, '#/journeys?lens=hybrid');
  const card = page.locator('.jrn-story[data-storyline="invoice"]');
  await expect(card.locator('.jrn-story-step').first()).toHaveAttribute('href', /#\/journeys\/invoice-app%3A%3Aflow%3A%3Anew-invoice\?view=\w+&step=1$/);
  await card.getByRole('button', { name: 'open the first journey' }).click();
  await expect(page).toHaveURL(/#\/journeys\/invoice-app%3A%3Aflow%3A%3Anew-invoice\?view=\w+&step=1/);
  await expect(page.locator('#jrn-title')).toHaveText('Start a new invoice');
  // the header's arrow opens the next journey of the storyline at its first step too
  await page.locator('#jrn-storyline .jrn-story-nav').last().click();
  await expect(page).toHaveURL(/#\/journeys\/invoice-app%3A%3Aflow%3A%3Adraft-and-send\?view=\w+&step=1/);
});
