// One number with its unit, scope, evidence and owner on the Map (docs/proposals/map-pass-2026-10-03.md §2,
// lane N). The swarm read one journey's 14 screens on the cover, "screen 4 of 10" in the footer and
// "stop 1 of 23" in the drill with nothing saying which was which; and test counts without their evidence
// class. Billing cycle's walk reaches all three screens it names, so the "fewer reached" case, the owner and
// the ERP are shaped over the fixture's own answers with page.route (ADR 8) — every other number is the
// fixture's, measured, never guessed.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';

const FLOW = 'invoice-app::flow::billing-cycle';
const STREET = '#/map/' + encodeURIComponent(FLOW);
const LIST_PAGE = 'invoice-app::page::/invoices';
const HEAD = `.map-district[data-flow="${FLOW}"] .map-dhead .agg`;

/** The journey-numbers identifier check, the bar every business view is held to. */
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

type AnyRec = Record<string, any>;

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
async function openStreet(page: Page) {
  await go(page, STREET);
  await expect(page.locator(`.map-district[data-flow="${FLOW}"] .map-scr`)).toHaveCount(3);
  await expect(page.locator(HEAD + ' .map-chip').first()).toBeVisible();
}

/**
 * Billing cycle as a journey whose design names a fourth screen the walk never reaches (planned, so its
 * absence word is *not built*), owned by a team, reaching an ERP — the shapes the reference app's journeys
 * carry. The counts are rewritten the way the core types them: the split adds up to the screens named.
 */
async function stubFewerReached(page: Page) {
  await page.route(/\/api\/design(\?|$)/, async (r) => {
    let d: AnyRec;
    try { d = await (await r.fetch()).json(); } catch { return; }
    for (const s of d.designs || []) for (const f of s.flows || []) if (f.nodeId === FLOW) f.owner = 'Billing team';
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify(d) }).catch(() => {});
  });
  await page.route(/\/api\/journey\?entry=invoice-app(%3A%3A|::)flow(%3A%3A|::)billing-cycle(&steps=0)?$/, async (r) => {
    let d: AnyRec;
    try { d = await (await r.fetch()).json(); } catch { return; }
    const s = d.summary;
    s.user.push({ id: 'invoice-app::page::/invoices/:param/approve', name: 'Approve invoice', kind: 'page', designStatus: 'design-only', hasImage: false, links: [], components: [] });
    const named = s.user.length;
    s.counted.screens = { ...s.counted.screens, n: named, breakdown: [{ key: 'count.part.screensReached', n: named - 1 }, { key: 'count.part.screensNotReached', n: 1 }] };
    s.counted.screensReached = { ...s.counted.screensReached, n: named - 1 };
    s.systems.push({ key: 'external:Example ERP', kind: 'external', externalKind: 'erp', label: 'Example ERP' });
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify(d) }).catch(() => {});
  });
}

/** The commits a screen's parts were changed by — the shape `/api/history/touching` answers. */
async function stubCommits(page: Page) {
  await page.route(/\/api\/history\/touching\?/, async (r) => {
    const u = new URL(r.request().url());
    const nodes = (u.searchParams.get('nodes') || '').split(',');
    const commits = [
      { sha: 'b2f6122cca9e2922dadfade2e801b4ede13dc447', at: '2026-10-02T09:00:00.000Z', author: 'Dev', subject: 'fix(ui): the invoice list separates number and total with a dot', keys: [], parts: [{ node: nodes[0], how: 'file' }] },
      { sha: 'd49c6180e3bddfcc117a3ad1f89d740abddd9184', at: '2026-09-30T09:00:00.000Z', author: 'Dev', subject: 'feat: the invoice app as first written', keys: [], parts: nodes.slice(0, 2).map((node) => ({ node, how: 'lines' })) },
    ];
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify({
      repo: 'invoice-app', read: 3, parts: nodes, commits,
      counted: { commits: { n: 2, unit: 'map.prop.changes.countCommits', bizUnit: 'map.prop.changes.countCommits', scope: 'journey.scopeHere', source: 'stub', breakdown: [{ key: 'count.part.commitLines', n: 1 }, { key: 'count.part.commitFile', n: 1 }] } },
    }) }).catch(() => {});
  });
}

/** The Portfolio's evidence word for one flow row, once its tests have arrived. */
async function portfolioWord(page: Page, name: string): Promise<string> {
  await go(page, '#/portfolio');
  const cell = page.locator('#pf-body tr', { has: page.locator('a', { hasText: new RegExp('^' + name + '$') }) }).locator('td').nth(3);
  await expect(cell.locator('.jrn-mk.cov')).toBeVisible();
  return ((await cell.locator('.jrn-mk.cov').textContent()) || '').trim();
}

test.describe('map — one number, one word', () => {
  /**
   * @covers packages/server/public/app/lib/map-chips.js::mapScreensChips
   * @covers packages/server/public/app/lib/map-chips.js::mapTestsChips
   * @covers packages/server/public/app/lib/map-chips.js::mapEvidenceChip
   * @covers GET /api/journey
   */
  test('the head says its units: screens with the reached split in the tip, every tests count beside the Portfolio\'s evidence word', async ({ page }) => {
    await mapOn(page);
    const word = await portfolioWord(page, 'Billing cycle');
    expect(word).not.toBe('');
    await openStreet(page);
    const head = page.locator(HEAD);
    // all three named screens are reached: one screens chip, no second number to reconcile
    await expect(head.locator('.map-chip').first()).toHaveText('3 screens');
    await expect(head.locator('.map-chip', { hasText: /reached$/ })).toHaveCount(0);
    // the journey opens with its head at the top of the board (lane Z); a map tip opens on hover
    await head.locator('.map-chip').first().hover();
    await expect(page.locator('#fs-tip')).toContainText(/reached by the walk through the code/i);
    await expect(page.locator('#fs-tip')).toContainText(/across this journey/i);
    // the evidence chip is the Portfolio's word, right after the tests count
    await expect(head.locator('.map-chip.k-ev')).toHaveText(word);
    expect(await head.locator('.map-chip.k-test').evaluate((el) => el.nextElementSibling?.classList.contains('k-ev'))).toBe(true);
    // every screen card that counts tests carries its own evidence word beside them
    const cards = await page.locator(`.map-district[data-flow="${FLOW}"] .map-scr`).evaluateAll((els) => els.map((el) => {
      const test = el.querySelector('.map-chip.k-test');
      const n = test ? parseInt(test.textContent || '0', 10) : 0;
      return { n, ev: !!(test && test.nextElementSibling && test.nextElementSibling.classList.contains('k-ev')) };
    }));
    expect(cards.filter((c) => c.n > 0).length).toBeGreaterThan(0);
    for (const c of cards) expect(c.ev, 'a screen\'s tests without their evidence word').toBe(c.n > 0);
  });

  /**
   * @covers packages/server/public/app/lib/map-chips.js::mapOwnerChip
   * @covers packages/server/public/app/lib/map-chips.js::mapErpChip
   * @covers packages/server/public/app/lib/map-property-model.js::placeOf
   */
  test('a journey whose walk reaches fewer screens than it names says both; the footer counts the reached; owner and ERP on the cover', async ({ page }) => {
    await stubFewerReached(page);
    await mapOn(page);
    await openStreet(page);
    const head = page.locator(HEAD);
    await expect(head.locator('.map-chip').nth(0)).toHaveText('4 screens');
    await expect(head.locator('.map-chip').nth(1)).toHaveText('3 reached');
    await expect(head.locator('.map-chip.k-erp')).toHaveText('reaches the ERP · Example ERP');
    await expect(head.locator('.map-chip.k-owner')).toHaveText('owner · Billing team');

    await go(page, STREET + '?node=' + encodeURIComponent(LIST_PAGE));
    await expect(page.locator('.mp')).toHaveAttribute('data-screen', LIST_PAGE);
    await expect(page.locator('.mp-where')).toHaveText(/^screen 2 of 3 reached · billing cycle$/i);
    await expect(page.locator('.mp-declared')).toHaveText('4 declared, 1 not reached');
    // the second number names the screen and why: designed, never built
    await page.locator('.mp-declared .n').nth(1).hover();
    await expect(page.locator('#fs-tip')).toContainText(/Approve invoice · not built/);
  });

  /** @covers packages/server/public/app/surfaces/map-property.js::mountMapProperty */
  test('the footer says reached, and nothing more when the journey names no screen the walk missed', async ({ page }) => {
    await mapOn(page);
    await go(page, STREET + '?node=' + encodeURIComponent(LIST_PAGE));
    await expect(page.locator('.mp')).toHaveAttribute('data-screen', LIST_PAGE);
    await expect(page.locator('.mp-where')).toHaveText(/^screen 2 of 3 reached · billing cycle$/i);
    await expect(page.locator('.mp-declared')).toHaveCount(0);
    await page.locator('.mp-where .n').hover();
    await expect(page.locator('#fs-tip')).toContainText(/walk through the code reached/i);
  });

  /**
   * @covers packages/server/public/app/surfaces/map-property.js::mountMapProperty
   * @covers GET /api/history/touching
   */
  test('Changes: the commit group first — on the fixture, which is no git checkout, the line that says no history was read', async ({ page }) => {
    await mapOn(page);
    await go(page, STREET + '?node=' + encodeURIComponent(LIST_PAGE));
    await page.locator('#mp-tab-changes').click();
    const groups = page.locator('.mp-body .mp-sec');
    await expect(groups.nth(0).locator('h3')).toContainText(/commits that touched this screen/i);
    await expect(groups.nth(0)).toContainText('no commit history has been read for this source');
    await expect(groups.nth(1).locator('h3')).toContainText(/what the index changed/i);
    await expect(groups.nth(1)).toContainText('no earlier sync to compare against');
  });

  /** @covers packages/server/public/app/surfaces/map-property.js::mountMapProperty */
  test('Changes lists the application\'s commits with how each touched the screen; the business register prints no identifier', async ({ page }) => {
    await stubCommits(page);
    await mapOn(page);
    await go(page, STREET + '?node=' + encodeURIComponent(LIST_PAGE));
    await page.locator('#mp-tab-changes').click();
    const rows = page.locator('.mp-body .mp-commits .mp-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('fix(ui): the invoice list separates number and total with a dot');
    await expect(rows.nth(0)).toContainText('2026-10-02');
    await expect(rows.nth(0)).toContainText('b2f6122');
    await expect(rows.nth(0).locator('.api-chip')).toHaveText('its file');
    await expect(rows.nth(1).locator('.api-chip')).toHaveText('these lines');
    await expect(page.locator('.mp-body .mp-commits h3 .mp-hcount')).toHaveText('2');

    await page.locator('#lb-business').click();
    await expect(page.locator('body')).toHaveClass(/lens-business/);
    await expect(rows.nth(0)).toContainText('the invoice list separates number and total with a dot');
    await expect(rows.nth(0)).not.toContainText('fix(ui)');
    await expect(rows.nth(0)).not.toContainText('b2f6122');
    const words = await page.locator('.mp-body').innerText();
    expect([...new Set(words.match(IDENTIFIER) || [])], 'identifier-shaped words on the business Changes tab').toEqual([]);
  });

  /** @covers packages/server/public/app/surfaces/map.js::mountMap */
  test('the business street prints no identifier with the new chips on', async ({ page }) => {
    await stubFewerReached(page);
    await mapOn(page, 'business');
    await openStreet(page);
    const text = await page.locator(`.map-district[data-flow="${FLOW}"] .map-dhead`).innerText();
    expect(text).toContain('owner · Billing team');
    expect([...new Set(text.match(IDENTIFIER) || [])], 'identifier-shaped words on the business head').toEqual([]);
  });
});
