// The journeys organised persona → group → journeys
// (docs/proposals/journey-organisation-and-config-files.md §4.4): the Journeys front door, the Portfolio, the Map's
// persona band and the open journey's header, all drawn from one tree.
//
// The structure tests run on the fixture as it is — whatever the invoice-app manifest declares — and hold the order
// rule against the manifest on disk. The rest shape the fixture's `/api/design` answer with page.route (ADR 8): two
// declared personas, two groups and a journey for both people, the shapes the reference app carries; they also
// answer `/api/journeys` with a 404, the way an older server does, so the viewer's own fold draws the tree.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';

type AnyRec = Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(here, '..', '..', 'examples', 'invoice-app', 'docs', 'design', 'screens.json'), 'utf8'));
const FLOW = 'invoice-app::flow::billing-cycle';

/** The tree the page itself drew from — the same module instance the surfaces read. */
async function pageTree(page: Page): Promise<AnyRec> {
  return page.evaluate(async () => {
    const m = await import('/app/lib/journeys-tree.js' as string);
    return (await m.loadJourneyTree()).tree;
  });
}

/** Two declared personas and two groups over the fixture's three flows; billing-cycle is for both people. */
async function organise(page: Page) {
  await page.route(/\/api\/journeys(\?|$)/, (r) => r.fulfill({ status: 404, json: { error: 'an older server: no such route' } }));
  await page.route(/\/api\/design\?/, async (r) => {
    const res = await r.fetch();
    const j = await res.json();
    const d = j.designs[0];
    d.personas = [{ id: 'billing', name: 'Billing clerk', description: 'Drafts and sends the invoices.' }, { id: 'manager', name: 'Finance manager' }];
    d.groups = [{ id: 'drafts', name: 'Drafting' }, { id: 'cycle', name: 'Month end' }];
    const at: AnyRec = { 'new-invoice': ['billing', 'drafts', 2], 'draft-and-send': ['billing', 'drafts', 1], 'billing-cycle': [['billing', 'manager'], 'cycle', null] };
    for (const f of d.flows) if (at[f.id]) { f.persona = at[f.id][0]; f.group = at[f.id][1]; if (at[f.id][2] != null) f.order = at[f.id][2]; }
    await r.fulfill({ response: res, json: j });
  });
}

test.describe('journeys organised by persona and group', () => {
  /**
   * @covers packages/server/public/app/surfaces/journeys.js::jrnOrganisedHtml
   * @covers packages/server/public/app/lib/journeys-tree.js::loadJourneyTree
   * @covers packages/server/public/app/lib/journeys-model.js::treeFrom
   * @covers GET /api/design
   */
  test('the front door lists every journey under a persona heading, in the order the manifest declares', async ({ page }) => {
    await gotoReady(page, '#/journeys');
    const section = page.locator('.jrn-org');
    await expect(section.locator('.jrn-persona').first()).toBeVisible();
    const tree = await pageTree(page);
    // every flow of the manifest is listed, each under at least one persona
    const listed = new Set(tree.personas.flatMap((p: AnyRec) => p.groups.flatMap((g: AnyRec) => g.journeys.map((j: AnyRec) => j.id))));
    expect([...listed].sort()).toEqual(MANIFEST.flows.map((f: AnyRec) => f.id).sort());
    expect(tree.counts.journeys.n).toBe(MANIFEST.flows.length);
    // the page draws the tree's order, persona by persona
    const drawn = await section.locator('.jrn-persona').evaluateAll((ps) => ps.map((p) => ({
      persona: (p as HTMLElement).dataset['persona'],
      names: [...p.querySelectorAll('.dsg-flow-name')].map((n) => n.textContent),
    })));
    expect(drawn).toEqual(tree.personas.map((p: AnyRec) => ({ persona: p.id, names: p.groups.flatMap((g: AnyRec) => g.journeys.map((j: AnyRec) => j.name)) })));
    // the order rule, against the manifest on disk: inside a group, `order` ascending, ties and absences in manifest order
    const at = new Map(MANIFEST.flows.map((f: AnyRec, i: number) => [f.id, i]));
    for (const p of tree.personas) for (const g of p.groups) {
      const ids = g.journeys.map((j: AnyRec) => j.id);
      const want = ids.slice().sort((a: string, b: string) => {
        const fa = MANIFEST.flows[at.get(a) as number], fb = MANIFEST.flows[at.get(b) as number];
        const oa = typeof fa.order === 'number' ? fa.order : Infinity, ob = typeof fb.order === 'number' ? fb.order : Infinity;
        return (oa === ob ? 0 : oa < ob ? -1 : 1) || (at.get(a) as number) - (at.get(b) as number);
      });
      expect(ids, `${p.id}/${g.id} in declared order`).toEqual(want);
    }
    // declared personas keep the manifest's order, ahead of any undeclared one
    const declared = tree.personas.filter((p: AnyRec) => p.declared).map((p: AnyRec) => p.id);
    expect(declared).toEqual((MANIFEST.personas || []).map((p: AnyRec) => p.id).filter((id: string) => declared.includes(id)));
    // a group heading is drawn exactly where a persona has more than one group
    for (const p of tree.personas) {
      await expect(section.locator(`.jrn-persona[data-persona="${p.id}"] .jrn-ghead`)).toHaveCount(p.groups.length > 1 ? p.groups.length : 0);
    }
    // the per-manifest design card keeps its counts and screens, and no longer lists the flows
    await expect(page.locator('.dsg-card .api-count').first()).toBeVisible();
    await expect(page.locator('.dsg-card .dsg-flow')).toHaveCount(0);
  });

});

test.describe('journeys organised by persona and group, as the manifest of §4.1 declares them', () => {
  // the fold answers for a server with no /api/journeys route: its 404 is the shape under test
  test.use({ expectedHttpErrors: [/\/api\/journeys/] });

  /**
   * @covers packages/server/public/app/lib/journeys-tree.js::jrnOrgCountsHtml
   * @covers packages/server/public/app/surfaces/journeys.js::jrnToggleGroup
   */
  test('groups fold and stay folded; a journey for two people is under each, counted once in the total', async ({ page }) => {
    await organise(page);
    await gotoReady(page, '#/journeys');
    const billing = page.locator('.jrn-persona[data-persona="billing"]');
    await expect(billing.locator('.jrn-ghead')).toHaveCount(2);
    await expect(billing.locator('.jrn-gname')).toHaveText(['Drafting', 'Month end']);
    // order 1 before order 2, whatever the names
    await expect(billing.locator('.jrn-group[data-group="drafts"] .dsg-flow-name')).toHaveText(['Draft and send an invoice', 'Start a new invoice']);
    // the manager has one group: no group heading, the card straight under the persona
    const manager = page.locator('.jrn-persona[data-persona="manager"]');
    await expect(manager.locator('.jrn-ghead')).toHaveCount(0);
    await expect(manager.locator('.dsg-flow-name')).toHaveText(['Billing cycle']);
    await expect(manager.locator('.dsg-flow')).toContainText('also for Billing clerk');
    // counts: the tree once, each persona its own; every number carries its tip
    const total = page.locator('.jrn-org > .set-note .jrn-org-n').first();
    await expect(total).toHaveText('3 journeys');
    await expect(billing.locator('.jrn-pcount .jrn-org-n').first()).toHaveText('3 journeys');
    await expect(manager.locator('.jrn-pcount .jrn-org-n').first()).toHaveText('1 journey');
    await billing.locator('.jrn-pcount .jrn-org-n').first().click();
    const tip = page.locator('#fs-tip');
    await expect(tip).toContainText('for this person');
    await expect(tip).toContainText('/api/journeys');
    const parts = (await tip.locator('table td.n').allInnerTexts()).map(Number).filter((x) => !Number.isNaN(x));
    expect(parts.reduce((a, b) => a + b, 0)).toBe(3);
    await page.keyboard.press('Escape');
    // fold a group: hidden, and still folded after a reload
    const toggle = billing.locator('.jrn-group[data-group="drafts"] .jrn-gtoggle');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(billing.locator('.jrn-group[data-group="drafts"] .jrn-gbody')).toBeHidden();
    await page.reload();
    await expect(page.locator('.jrn-persona[data-persona="billing"] .jrn-group[data-group="drafts"] .jrn-gtoggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.jrn-persona[data-persona="billing"] .jrn-group[data-group="cycle"] .jrn-gbody')).toBeVisible();
  });

  /** @covers packages/server/public/app/lib/journeys-model.js::filterTree */
  test('?persona= and ?group= in the link narrow the section, and a link shows everyone again', async ({ page }) => {
    await organise(page);
    await gotoReady(page, '#/journeys?persona=billing&group=drafts');
    await expect(page.locator('.jrn-persona')).toHaveCount(1);
    await expect(page.locator('.jrn-persona .dsg-flow')).toHaveCount(2);
    await expect(page.locator('.jrn-org-filter')).toContainText('Billing clerk · Drafting');
    await page.locator('.jrn-org-filter a').click();
    await expect(page.locator('.jrn-persona')).toHaveCount(2);
    // a persona's heading is the link that narrows to it
    await page.locator('.jrn-persona[data-persona="manager"] .jrn-pname').click();
    await expect(page).toHaveURL(/#\/journeys\?persona=manager$/);
    await expect(page.locator('.jrn-persona')).toHaveCount(1);
  });

  /** @covers packages/server/public/app/surfaces/journeys.js::jrnFillOrg */
  test('the open journey\'s header says who it is for and its group', async ({ page }) => {
    await organise(page);
    await gotoReady(page, '#/journeys/' + encodeURIComponent(FLOW));
    const org = page.locator('#jrn-orgline .g-org');
    await expect(org).toContainText('For Billing clerk · Month end');
    await expect(org).toContainText('also for Finance manager');
  });

  /** @covers packages/server/public/app/surfaces/portfolio.js::render */
  test('the Portfolio draws one table per persona and group, in the same order, with the same pin', async ({ page }) => {
    await organise(page);
    await gotoReady(page, '#/portfolio');
    const sections = page.locator('.pf-persona');
    await expect(sections).toHaveCount(2);
    await expect(sections.locator('h2')).toContainText(['Billing clerk', 'Finance manager']);
    const billing = sections.nth(0);
    await expect(billing.locator('.pf-group')).toHaveCount(2);
    await expect(billing.locator('table')).toHaveCount(2);
    await expect(billing.locator('table').nth(0).locator('td:first-child a')).toHaveText(['Draft and send an invoice', 'Start a new invoice']);
    // the pin is the front door's: the widest built way in, wherever its group puts it
    await expect(page.locator('#pf-body tr.pinned td:first-child a').first()).toHaveText('Billing cycle');
    await expect(sections.nth(1).locator('.pf-group')).toHaveCount(0);
  });

  /**
   * @covers packages/server/public/app/lib/map-model.js::layoutDistricts
   * @covers packages/server/public/app/surfaces/map.js::drawEchoes
   */
  test('the Map bands by persona: the tree\'s order, the shared journey drawn once with a card in the other band', async ({ page }) => {
    await organise(page);
    await gotoReady(page, '#/portfolio');
    await page.evaluate(() => {
      const S = (window as any).S;
      S.SETTINGS = Object.assign({}, S.SETTINGS, { flags: Object.assign({}, S.SETTINGS && S.SETTINGS.flags, { map: true }) });
    });
    await page.evaluate(() => { location.hash = '#/map'; });
    const persona = page.locator('.map-band-pick [data-band="persona"]');
    await persona.click();
    await expect(persona).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.map-band.per span')).toHaveText(['Billing clerk', 'Finance manager']);
    // one street per journey, counted once; the second band holds a card that leads to it
    await expect(page.locator('.map-district')).toHaveCount(3);
    const echo = page.locator(`.map-echo[data-echo="${FLOW}"]`);
    await expect(echo).toHaveCount(1);
    await expect(echo).toContainText('walk it under Billing clerk');
    await echo.click();
    await expect(page.locator(`.map-district[data-flow="${FLOW}"]`)).toHaveClass(/focus/);
  });
});
