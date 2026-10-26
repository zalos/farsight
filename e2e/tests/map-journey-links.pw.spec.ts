// One address (lanes round 2026-10-10): a journey is read on the Map, an old journey link is the same place there,
// and every detail is a door (round 2026-10-05 §3). The fixture's Billing cycle has three screens — New invoice,
// Invoice list, Discard draft — one segment each, so screen 2 is the Invoice list. Its gates (`requireScope(billing:read)` met on the
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
    S.SETTINGS = Object.assign({}, S.SETTINGS, {
      flags: Object.assign({}, S.SETTINGS && S.SETTINGS.flags, { map: true }),
    });
  });
}
async function go(page: Page, hash: string) {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
}

/**
 * @covers packages/server/public/app/lib/route-url.js::overlayToMap
 * @covers packages/server/public/app/lib/route-url.js::screenRowAt
 * @covers packages/server/public/app/shell.js::applyRoute
 */
test('an old link to a step is the same screen on the Map — one replace, no history entry, no door back to a second page', async ({
  page,
}) => {
  await mapOn(page);
  const before = await page.evaluate(() => history.length);
  await go(page, '#/journeys/' + enc(FLOW) + '?step=2');
  await expect(page).toHaveURL(/#\/map\/invoice-app%3A%3Aflow%3A%3Abilling-cycle/);
  const second = page.locator('.map-scr[data-flow="' + FLOW + '"][data-index="1"]');
  await expect(second).toBeFocused();
  // the Map is where the journey is read: no screen carries a door to another picture of it
  await expect(page.locator('.map-tojrn')).toHaveCount(0);
  // the hash moved once (the reader's own navigation); the redirect replaced it, so Back leaves the Map
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await page.goBack();
  await expect(page).toHaveURL(/#\/portfolio/);
});

/**
 * @covers packages/server/public/app/lib/route-url.js::partOrder
 * @covers packages/server/public/app/surfaces/map-stops.js::openActionAt
 */
test('an old link to a step and a node opens the action that holds the part, its code in the dock it named', async ({
  page,
}) => {
  await gotoReady(page, '#/journeys/' + enc(FLOW) + '?step=2&node=' + enc(ROUTE) + '&dock=right&lens=hybrid');
  await expect(page.locator('.map-act')).toBeVisible();
  await expect(page).toHaveURL(/#\/map\/invoice-app%3A%3Aflow%3A%3Abilling-cycle\?(.*&)?screen=2&(.*&)?action=1(&|$)/);
  await expect(page).toHaveURL(/dock=right/);
  await expect(page.locator('.map-act')).toHaveAttribute('data-dock', 'right');
  await expect(page.locator('#jrn-insp a.dd-door').first()).toHaveText('read the contract');
});

// a gate's click — its code, its doors, the calls it guards and the tests that reach it — is gate-card.pw.spec.ts

/** @covers packages/server/public/app/lib/detail-links.js::detailLinks */
test('a route call links to the APIs surface at its operation, its spec line and its handler', async ({ page }) => {
  await mapOn(page);
  await go(page, '#/map/' + enc(FLOW) + '?plumb=1&card=call:' + enc(ROUTE));
  const card = page.locator('.map-xcard');
  await expect(card).toBeVisible();
  const doors = card.locator('.acts a.dd-door');
  await expect(doors.first()).toHaveText('read the contract');
  await expect(doors.first()).toHaveAttribute(
    'href',
    '#/apis/' + enc('invoice-app::api::openapi.yaml') + '?op=' + enc(ROUTE),
  );
  await expect(card.locator('a.dd-door', { hasText: 'read the spec file' })).toHaveAttribute(
    'href',
    /\?view=spec&line=\d+$/,
  );
  await expect(card.locator('a.dd-door', { hasText: 'open the handler in the editor' })).toHaveAttribute(
    'href',
    /^vscode:\/\/file\//,
  );
  // where the journey stands in its storyline (the fixture's invoice storyline ends with Billing cycle)
  await expect(card.locator('.dd-story')).toHaveText('in storyline: An invoice, end to end · step 2 of 2');
  // one stop down is on this surface: the call's action, never a second page
  await expect(card.locator('.tojrn a')).toHaveCount(0);
  await expect(card.locator('[data-act="beats"]')).toBeVisible();
  await doors.first().click();
  await expect(page).toHaveURL(
    /#\/apis\/invoice-app%3A%3Aapi%3A%3Aopenapi\.yaml\?op=invoice-app%3A%3Aroute%3A%3AGET%20%2Finvoices/,
  );
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
  await expect(page.locator('.mp-head .mp-story')).toContainText('step 2 of 2');
  // the property is the screen stop: no door to a second picture of it
  await expect(page.locator('.mp-tojrn')).toHaveCount(0);
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
    if (cov && /billing-cycle/.test(r.request().url()))
      cov.evidenceWord = Object.assign({}, cov.evidenceWord, { cls: 'stale' });
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
    try {
      d = await (await r.fetch()).json();
    } catch {
      return;
    }
    const src = d.designs[0];
    const base = src.flows.find((f: any) => f.id === 'billing-cycle');
    src.flows = Array.from({ length: N }, (_, i) => ({
      ...base,
      nodeId: 'invoice-app::flow::many-' + i,
      id: 'many-' + i,
      name: 'Journey number ' + (i + 1),
    }));
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify(d) });
  });
  await page.route(/\/api\/journey\?entry=/, async (r) => {
    const url = r.request().url();
    if (!/many-\d+/.test(decodeURIComponent(url))) return r.continue();
    let d: any;
    try {
      d = await (await r.fetch({ url: url.replace(/entry=[^&]*/, 'entry=' + encodeURIComponent(FLOW)) })).json();
    } catch {
      return;
    }
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
  await expect
    .poll(() =>
      page
        .locator('.map-dcover .map-chip')
        .first()
        .evaluate((el) => {
          const h = (el as HTMLElement).offsetHeight;
          return parseFloat(getComputedStyle(el).fontSize) * (h ? el.getBoundingClientRect().height / h : 1);
        }),
    )
    .toBeGreaterThanOrEqual(7.9);
});

/** @covers packages/server/public/app/surfaces/journeys.js::openJourney */
test('a storyline opens its journeys on the Map, the first one by its own door', async ({ page }) => {
  await gotoReady(page, '#/journeys?lens=hybrid');
  const card = page.locator('.jrn-story[data-storyline="invoice"]');
  await expect(card.locator('.jrn-story-step').first()).toHaveAttribute(
    'href',
    '#/map/invoice-app%3A%3Aflow%3A%3Anew-invoice',
  );
  await expect(card.locator('.jrn-story-map')).toHaveAttribute('href', '#/map?storyline=invoice');
  await card.getByRole('button', { name: 'open the first journey' }).click();
  await expect(page).toHaveURL(/#\/map\/invoice-app%3A%3Aflow%3A%3Anew-invoice/);
  // the hybrid register reads a journey as its table, the journey's name at its head
  await expect(page.locator('.map-jhead .nm')).toContainText('Start a new invoice');
  // the crumb says where it stands in the storyline
  await expect(page.locator('.map-crumbs')).toContainText('step 1 of 2');
});
