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

test.describe('journeys organised by persona and group, as the fixture declares them', () => {
  // the fixture's manifest: personas Billing and Operations, groups Invoices and Review and send; Billing cycle (order 1)
  // and Start a new invoice (order 2) under Billing › Invoices; Draft and send for both, moved to Review and send by
  // the config's placement

  /**
   * @covers packages/server/public/app/lib/journeys-tree.js::jrnOrgCountsHtml
   * @covers packages/server/public/app/surfaces/journeys.js::jrnToggleGroup
   * @covers GET /api/journeys
   */
  test('groups fold and stay folded; a journey for two people is under each, counted once in the total', async ({ page }) => {
    await gotoReady(page, '#/journeys');
    const billing = page.locator('.jrn-persona[data-persona="billing"]');
    await expect(billing.locator('.jrn-pname')).toHaveText('Billing');
    await expect(billing.locator('.jrn-gname')).toHaveText(['Invoices', 'Review and send']);
    // order 1 before order 2; the config's placement moved Draft and send out of Invoices
    await expect(billing.locator('.jrn-group[data-group="invoices"] .dsg-flow-name')).toHaveText(['Billing cycle', 'Start a new invoice']);
    await expect(billing.locator('.jrn-group[data-group="review"] .dsg-flow-name')).toHaveText(['Draft and send an invoice']);
    // Operations has one group: no group heading, the card straight under the persona
    const ops = page.locator('.jrn-persona[data-persona="ops"]');
    await expect(ops.locator('.jrn-ghead')).toHaveCount(0);
    await expect(ops.locator('.dsg-flow-name')).toHaveText(['Draft and send an invoice']);
    await expect(ops.locator('.dsg-flow')).toContainText('also for Billing');
    // counts: the tree once, each persona its own; every number carries its tip
    await expect(page.locator('.jrn-org > .set-note .jrn-org-n')).toHaveText(['3 journeys', '2 personas', '3 groups']);
    await expect(billing.locator('.jrn-pcount')).toHaveText('3 journeys · 1 of 3 journeys built');
    await expect(ops.locator('.jrn-pcount .jrn-org-n').first()).toHaveText('1 journey');
    // scrolled there first: a tip closes when what holds its trigger scrolls (the storylines above push it below the fold)
    const count = billing.locator('.jrn-pcount .jrn-org-n').first();
    await count.scrollIntoViewIfNeeded();
    await expect(count).toBeInViewport();
    await count.click();
    const tip = page.locator('#fs-tip');
    await expect(tip).toContainText('for this persona');
    await expect(tip).toContainText('/api/journeys');
    await page.keyboard.press('Escape');
    // fold a group: hidden, and still folded after a reload
    const toggle = billing.locator('.jrn-group[data-group="invoices"] .jrn-gtoggle');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(billing.locator('.jrn-group[data-group="invoices"] .jrn-gbody')).toBeHidden();
    await page.reload();
    await expect(page.locator('.jrn-persona[data-persona="billing"] .jrn-group[data-group="invoices"] .jrn-gtoggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.jrn-persona[data-persona="billing"] .jrn-group[data-group="review"] .jrn-gbody')).toBeVisible();
  });

  /** @covers packages/server/public/app/lib/journeys-tree.js::jrnOrgCountsHtml */
  test('the business lens prints the same counts, in people\'s words, with no endpoint', async ({ page }) => {
    await gotoReady(page, '#/journeys?lens=business');
    await expect(page.locator('.jrn-org > .set-note .jrn-org-n')).toHaveText(['3 journeys', '2 personas', '3 groups']);
    await expect(page.locator('.jrn-persona[data-persona="billing"] .jrn-pcount')).toHaveText('3 journeys · 1 of 3 journeys built');
    // the count sits below the state of play now: scroll it in first, so the scroll's own event cannot close the tip
    const n = page.locator('.jrn-org > .set-note .jrn-org-n').first();
    await n.scrollIntoViewIfNeeded();
    await expect(async () => {
      if (await page.locator('#fs-tip').isHidden()) await n.click();
      await expect(page.locator('#fs-tip')).toContainText('across every source in scope', { timeout: 1000 });
    }).toPass();
    await expect(page.locator('#fs-tip')).not.toContainText('/api/');
  });

  /** @covers packages/server/public/app/lib/journeys-model.js::filterTree */
  test('?persona= and ?group= in the link narrow the section, and a link shows everyone again', async ({ page }) => {
    await gotoReady(page, '#/journeys?persona=billing&group=review');
    await expect(page.locator('.jrn-persona')).toHaveCount(1);
    await expect(page.locator('.jrn-persona .dsg-flow')).toHaveCount(1);
    await expect(page.locator('.jrn-org-filter')).toContainText('Billing · Review and send');
    await page.locator('.jrn-org-filter a').click();
    await expect(page.locator('.jrn-persona')).toHaveCount(2);
    // a persona's heading is the link that narrows to it
    await page.locator('.jrn-persona[data-persona="ops"] .jrn-pname').click();
    await expect(page).toHaveURL(/#\/journeys\?persona=ops$/);
    await expect(page.locator('.jrn-persona')).toHaveCount(1);
  });

  /** @covers packages/server/public/app/surfaces/journeys.js::jrnFillOrg */
  test('the open journey\'s header says who it is for and its group', async ({ page }) => {
    await gotoReady(page, '#/journeys/' + encodeURIComponent('invoice-app::flow::draft-and-send'));
    const org = page.locator('#jrn-orgline .g-org');
    await expect(org).toContainText('For Billing · Review and send');
    await expect(org).toContainText('also for Operations');
    await gotoReady(page, '#/journeys/' + encodeURIComponent(FLOW));
    await expect(page.locator('#jrn-orgline .g-org')).toHaveText('For Billing · Invoices');
  });

  /** @covers packages/server/public/app/surfaces/portfolio.js::render */
  test('the Portfolio draws one table per persona and group, in the same order, with the same pin', async ({ page }) => {
    await gotoReady(page, '#/portfolio');
    const sections = page.locator('.pf-persona');
    await expect(sections).toHaveCount(2);
    await expect(sections.locator('h2')).toContainText(['Billing', 'Operations']);
    const billing = sections.nth(0);
    await expect(billing.locator('.pf-group')).toHaveCount(2);
    await expect(billing.locator('table')).toHaveCount(2);
    await expect(billing.locator('table').nth(0).locator('td:first-child a')).toHaveText(['Billing cycle', 'Start a new invoice']);
    // the pin is the tree's, one per persona: Billing cycle for Billing, the one journey for Operations
    await expect(billing.locator('tr.pinned td:first-child a')).toHaveText(['Billing cycle']);
    await expect(sections.nth(1).locator('tr.pinned td:first-child a')).toHaveText(['Draft and send an invoice']);
    await expect(sections.nth(1).locator('.pf-group')).toHaveCount(0);
  });

  /**
   * @covers packages/server/public/app/lib/map-model.js::layoutDistricts
   * @covers packages/server/public/app/surfaces/map.js::drawEchoes
   */
  test('the Map bands by persona: the tree\'s order, the shared journey drawn once with a card in the other band', async ({ page }) => {
    await gotoReady(page, '#/portfolio');
    await page.evaluate(() => {
      const S = (window as any).S;
      S.SETTINGS = Object.assign({}, S.SETTINGS, { flags: Object.assign({}, S.SETTINGS && S.SETTINGS.flags, { map: true }) });
    });
    await page.evaluate(() => { location.hash = '#/map'; });
    // at 1440 px Band by is folded to its current value: its menu holds the choices
    await page.locator('.map-band-cur').click();
    await expect(page.locator('.map-band-cur')).toHaveAttribute('aria-expanded', 'true');
    const persona = page.locator('.map-band-pick [data-band="persona"]');
    await persona.click();
    await expect(persona).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.map-band-cur')).toHaveText('persona');
    await expect(page.locator('.map-band-cur')).toHaveAttribute('aria-expanded', 'false');
    // each band a panel headed by the person, how many journeys and who they are
    await expect(page.locator('.map-band.per .w')).toHaveText(['Billing', 'Operations']);
    await expect(page.locator('.map-band.per .n')).toHaveText(['3 journeys', '1 journey']);
    await expect(page.locator('.map-band.per .d').first()).not.toBeEmpty();
    // one street per journey, counted once; the second band holds a card that leads to it
    await expect(page.locator('.map-district')).toHaveCount(3);
    const shared = 'invoice-app::flow::draft-and-send';
    const echo = page.locator(`.map-echo[data-echo="${shared}"]`);
    await expect(echo).toHaveCount(1);
    await expect(echo).toContainText('walk it under Billing');
    await echo.click();
    await expect(page.locator(`.map-district[data-flow="${shared}"]`)).toHaveClass(/focus/);
  });
});

test.describe('storylines', () => {
  const STORY = (MANIFEST.storylines || [])[0] as AnyRec;
  // the steps are the bare ids; an entry written as { id, branchOf, when } is a branch (swarm-fixes 2026-10-05 §6)
  const STEPS = (STORY.journeys as (string | AnyRec)[]).filter((e) => typeof e === 'string' || !e.branchOf).map((e) => `invoice-app::flow::${typeof e === 'string' ? e : e.id}`);
  const BRANCHES = (STORY.journeys as (string | AnyRec)[]).filter((e): e is AnyRec => typeof e !== 'string' && !!e.branchOf);
  const NAME = (id: string) => MANIFEST.flows.find((f: AnyRec) => `invoice-app::flow::${f.id}` === id).name;
  async function mapOn(page: Page): Promise<void> {
    await page.evaluate(() => {
      const S = (window as any).S;
      S.SETTINGS = Object.assign({}, S.SETTINGS, { flags: Object.assign({}, S.SETTINGS && S.SETTINGS.flags, { map: true }) });
    });
  }

  /**
   * @covers packages/server/public/app/surfaces/journeys.js::jrnStorylinesHtml
   * @covers GET /api/journeys
   */
  test('the front door draws a Storylines section above the personas: the journeys numbered in order, the Map and the first journey', async ({ page }) => {
    await gotoReady(page, '#/portfolio');
    await mapOn(page);
    await page.evaluate(() => { location.hash = '#/journeys'; });
    const card = page.locator(`.jrn-story[data-storyline="${STORY.id}"]`);
    await expect(card).toBeVisible();
    await expect(card.locator('.dsg-flow-name')).toHaveText(STORY.name);
    await expect(card.locator('.jrn-story-steps .jrn-story-step')).toHaveText(STEPS.map((id, i) => `${i + 1}${NAME(id)}`));
    await expect(card.locator('.jrn-pcount')).toContainText(`${STEPS.length + BRANCHES.length} journeys`);
    // above the personas
    const above = await page.evaluate(() => {
      const a = document.querySelector('.jrn-stories'), b = document.querySelector('.jrn-org');
      return !!(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    expect(above).toBe(true);
    await expect(card.locator('.jrn-story-map')).toHaveAttribute('href', `#/map?storyline=${STORY.id}`);
    await card.getByRole('button', { name: 'open the first journey' }).click();
    await expect(page.locator('#jrn-title')).toHaveText(NAME(STEPS[0]!));
  });

  /** @covers packages/server/public/app/surfaces/journeys.js::jrnFillStoryline */
  test('the journey header says storyline · step n of m, and ‹ › open the journeys before and after it', async ({ page }) => {
    await gotoReady(page, '#/journeys/' + encodeURIComponent(STEPS[0]!));
    const line = page.locator('#jrn-storyline .jrn-story-line');
    await expect(line).toContainText(STORY.name);
    await expect(line).toContainText(`step 1 of ${STEPS.length}`);
    await line.getByRole('button', { name: new RegExp(`after this one.*${NAME(STEPS[1]!)}`) }).click();
    await expect(page.locator('#jrn-title')).toHaveText(NAME(STEPS[1]!));
    await expect(page.locator('#jrn-storyline .jrn-story-line')).toContainText(`step 2 of ${STEPS.length}`);
    await page.locator('#jrn-storyline').getByRole('button', { name: /before this one/ }).click();
    await expect(page.locator('#jrn-title')).toHaveText(NAME(STEPS[0]!));
  });

  /**
   * @covers packages/server/public/app/surfaces/map.js::storylineToolHtml
   * @covers packages/server/public/app/surfaces/map.js::applyStoryline
   * @covers packages/server/public/app/lib/map-model.js::storylineModel
   */
  test('the Map draws one storyline as one band in its order, numbered, with then lines at the board, and the link carries it', async ({ page }) => {
    await gotoReady(page, '#/portfolio');
    await mapOn(page);
    await page.evaluate(() => { location.hash = '#/map'; });
    await expect(page.locator('.map-district')).toHaveCount(MANIFEST.flows.length);
    // at 1440 px the picker is folded to its current value: its menu holds the storylines
    await page.locator('.map-story-cur').click();
    await page.locator(`.map-story-pick [data-storyline="${STORY.id}"]`).click();
    await expect(page.locator('.map-story-cur')).toHaveText(STORY.name);
    await expect(page).toHaveURL(new RegExp(`[?&]storyline=${STORY.id}(&|$)`));
    await expect(page.locator('.map-band.story .w')).toHaveText([STORY.name]);
    await expect(page.locator('.map-band.story .n')).toHaveText(`${STEPS.length + BRANCHES.length} journeys`);
    // only its journeys, in its order, numbered (a branch draws after the steps, with no number of its own)
    await expect(page.locator('.map-district')).toHaveCount(STEPS.length + BRANCHES.length);
    expect(await page.locator('.map-district').evaluateAll((ds) => ds.map((d) => (d as HTMLElement).dataset['flow']))).toEqual(STEPS.concat(BRANCHES.map((b) => `invoice-app::flow::${b.id}`)));
    await expect(page.locator('.map-dcover .map-step:not(.branch)')).toHaveText(STEPS.map((_, i) => String(i + 1)));
    // at the board altitude the then lines are drawn without a hover — one from each step to the next
    await expect(page.locator('.map-world')).toHaveClass(/lvl-nb/);
    const then = page.locator('.map-links g[data-link="then"]');
    await expect(then).toHaveCount(STEPS.length - 1);
    for (let i = 0; i < STEPS.length - 1; i++) {
      const g = page.locator(`.map-links g[data-link="then"][data-from="${STEPS[i]}"][data-to="${STEPS[i + 1]}"]`);
      await expect(g).toHaveCount(1);
      await expect(g).not.toHaveClass(/\boff\b/);
      await expect(g).not.toHaveCSS('display', 'none');
      // a straight line has no height of its own: its arrowhead is what shows it is drawn
      await expect(g.locator('path.head')).toBeVisible();
    }
    // the link round-trips: a fresh page on it draws the same band
    const url = page.url();
    const fresh = await page.context().newPage();
    await fresh.goto('/' + '#/portfolio');
    await expect(fresh.locator('#stats')).not.toHaveText('loading…');
    await mapOn(fresh);
    await fresh.evaluate((h) => { location.hash = h; }, url.slice(url.indexOf('#')));
    await expect(fresh.locator('.map-band.story .w')).toHaveText([STORY.name]);
    await expect(fresh.locator('.map-district')).toHaveCount(STEPS.length + BRANCHES.length);
    await fresh.close();
    // All restores every journey and drops the parameter
    await page.locator('.map-story-cur').click();
    await page.locator('.map-story-pick [data-storyline=""]').click();
    await expect(page.locator('.map-district')).toHaveCount(MANIFEST.flows.length);
    await expect(page.locator('.map-band.story')).toHaveCount(0);
    await expect(page).not.toHaveURL(/storyline=/);
  });

  /**
   * @covers packages/server/public/app/lib/map-model.js::placeBranches
   * @covers packages/server/public/app/surfaces/map.js::branchLineHtml
   * @covers packages/server/public/app/surfaces/journeys.js::jrnStorylinesHtml
   * @covers packages/server/public/app/surfaces/journeys.js::jrnFillStoryline
   */
  test('a declared branch draws off its step: below it on the Map with its condition on the line, indented on the front door, and in the header', async ({ page }) => {
    const B = BRANCHES[0]!;
    expect(B, 'the example manifest declares a branch').toBeTruthy();
    const id = `invoice-app::flow::${B.id}`, of = `invoice-app::flow::${B.branchOf}`;
    await gotoReady(page, '#/portfolio');
    await mapOn(page);
    await page.evaluate((s) => { location.hash = '#/map?storyline=' + s; }, STORY.id);
    const card = page.locator(`.map-district[data-flow="${id}"]`);
    await expect(card).toHaveClass(/\bbranch\b/);
    await expect(card.locator('.map-dcover .map-branch-when')).toContainText(`when ${B.when}`);
    // below the step it leaves from
    const [a, b] = await Promise.all([page.locator(`.map-district[data-flow="${of}"]`).boundingBox(), card.boundingBox()]);
    expect(b!.y).toBeGreaterThan(a!.y + a!.height);
    // the line down carries the condition at the board; a dashed line goes back to the step it rejoins
    const down = page.locator(`.map-links g[data-link="branch"][data-from="${of}"][data-to="${id}"]`);
    await expect(down).toHaveCount(1);
    await expect(down.locator('.lbl')).not.toHaveClass(/\boff\b/);
    await expect(down.locator('text')).toHaveText(`when ${B.when}`);
    await expect(page.locator(`.map-links g[data-link="rejoin"][data-from="${id}"][data-to="invoice-app::flow::${B.rejoins}"]`)).toHaveCount(1);
    // the band's evidence: one count over its journeys
    await expect(page.locator('.map-band.story .map-band-head .ev')).toContainText(`of ${STEPS.length + BRANCHES.length} journeys with a run`);
    // every card carries a picture or the placeholder, never an empty box
    const thumbs = page.locator('.map-dcover .map-thumb');
    await expect(thumbs).toHaveCount(STEPS.length + BRANCHES.length);
    // the front door: indented under the chain, with its condition and its way back
    await page.evaluate(() => { location.hash = '#/journeys'; });
    const row = page.locator(`.jrn-story[data-storyline="${STORY.id}"] .jrn-story-branch[data-branch="${B.id}"]`);
    await expect(row).toContainText(`branch of ${NAME(of)}`);
    await expect(row.locator('.when')).toHaveText(`when ${B.when}`);
    await expect(row.locator('.back')).toContainText(`back to ${NAME(`invoice-app::flow::${B.rejoins}`)}`);
    await expect(page.locator(`.jrn-story[data-storyline="${STORY.id}"] .jrn-story-thumb`)).toHaveCount(1);
    // the journey header names what it branches off and when; ‹ opens that step
    await row.locator('a.jrn-story-step').click();
    await expect(page.locator('#jrn-title')).toHaveText(NAME(id));
    const line = page.locator('#jrn-storyline .jrn-story-line');
    await expect(line.locator('.jrn-story-at')).toHaveText(`branch of ${NAME(of)} · when ${B.when}`);
    await line.getByRole('button', { name: /before this one/ }).click();
    await expect(page.locator('#jrn-title')).toHaveText(NAME(of));
  });

  /** @covers packages/server/public/app/surfaces/map.js::unknownStorylineHtml */
  test('a storyline nobody declares is said so, with the ones there are as doors — never every journey', async ({ page }) => {
    await gotoReady(page, '#/portfolio');
    await mapOn(page);
    await page.evaluate(() => { location.hash = '#/map?storyline=nope'; });
    const note = page.locator('.map-note .map-story-unknown');
    await expect(note).toContainText('No storyline called “nope” is declared here.');
    await expect(page.locator('.map-district')).toHaveCount(0);
    await note.locator(`button[data-storyline="${STORY.id}"]`).click();
    await expect(page.locator('.map-band.story .w')).toHaveText([STORY.name]);
    await expect(page).toHaveURL(new RegExp(`[?&]storyline=${STORY.id}(&|$)`));
  });

  /** @covers packages/server/public/app/lib/search-model.js::storylineTravelItems */
  test('fast travel finds the storyline and lands on the Map drawing it', async ({ page }) => {
    await gotoReady(page, '#/portfolio');
    await mapOn(page);
    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('#pinput').fill(STORY.name);
    const first = page.locator('#presults .presult').first();
    await expect(first).toHaveClass(/presult-story/);
    await expect(first.locator('.pname')).toContainText(STORY.name);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`#/map\\?storyline=${STORY.id}$`));
    await expect(page.locator('.map-band.story .w')).toHaveText([STORY.name]);
  });
});

test.describe('journeys organised, on a server with no /api/journeys', () => {
  // an older server (or an older global install) answers 404: the viewer folds the tree itself
  test.use({ expectedHttpErrors: [/\/api\/journeys/] });

  /**
   * @covers packages/server/public/app/lib/journeys-tree.js::loadJourneyTree
   * @covers packages/server/public/app/lib/journeys-model.js::treeFrom
   */
  test('the fallback fold draws the front door exactly as the route does', async ({ page }) => {
    await gotoReady(page, '#/journeys');
    const section = page.locator('.jrn-org');
    await expect(section.locator('.jrn-persona')).toHaveCount(2);
    const live = await section.innerText();
    await page.route(/\/api\/journeys(\?|$)/, (r) => r.fulfill({ status: 404, json: { error: 'an older server: no such route' } }));
    await page.reload();
    await expect(section.locator('.jrn-persona')).toHaveCount(2);
    expect(await section.innerText()).toBe(live);
  });
});
