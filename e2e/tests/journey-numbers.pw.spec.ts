// The journey's numbers and words (pass swarm 2026-09-25 → fix/journey-numbers-and-words):
// every header number carries a tip whose breakdown adds up to it, the business
// lane's `In words` counts the lines it draws, the business lens prints no
// identifier in any view, and the chrome answers the keyboard from inside a journey.
import type { Page } from '@playwright/test';
import { test, expect, openBillingCycle } from './support';

const tip = (page: Page) => page.locator('#fs-tip');

/** Identifier-shaped tokens: camelCase, PascalCase compounds, snake_case, paths, HTTP verbs, spec files, document ids. */
const IDENTIFIER = new RegExp([
  String.raw`\b[a-z]+[A-Z][A-Za-z0-9]*\b`,
  String.raw`\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b`,
  String.raw`\b[a-z0-9]+_[a-z0-9_]+\b`,
  String.raw`\b[A-Z0-9]+_[A-Z0-9_]+\b`,
  String.raw`(?:^|[\s(])\/[\w.:{}\-]+`,
  String.raw`\b(?:GET|POST|PUT|PATCH|DELETE)\b`,
  String.raw`\b[\w-]+\.(?:spec|test|pw)\b`,
  String.raw`\.(?:tsx?|jsx?|mjs|json)\b`,
  String.raw`\b(?:CON|INV|OPS)-\d+[a-z]?\b|\bPBI\s?#?\d+`,
].join('|'), 'g');

/**
 * The words the journey renders — as written, not as CSS upper-cases them — of
 * every text node a reader can see: a drawer parked off the edge does not count.
 */
async function visibleWords(page: Page): Promise<string> {
  return page.evaluate(() => {
    const out: string[] = [];
    const w = document.createTreeWalker(document.getElementById('journey')!, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = w.nextNode())) {
      const el = n.parentElement;
      if (!el || !n.textContent?.trim()) continue;
      if (el.closest('#jrn-forks:not(.open),#jrn-cutlist:not(.open)')) continue;
      if (el.checkVisibility({ visibilityProperty: true })) out.push(n.textContent);
    }
    return out.join('\n');
  });
}

async function openIn(page: Page, lens: 'business' | 'hybrid' | 'code', view: string) {
  await openBillingCycle(page);
  await page.locator('#lb-' + lens).click();
  await expect(page.locator('body')).toHaveClass(new RegExp('lens-' + lens));
  if (view === 'drill') {
    // the drill is behind a workspace flag the fixture does not set; the flag is read
    // client-side, so it is switched on for this page only (never written to the workspace)
    await page.evaluate(() => { const S = (window as any).S; S.SETTINGS = Object.assign({}, S.SETTINGS, { flags: Object.assign({}, S.SETTINGS && S.SETTINGS.flags, { journeyDrill: true }) }); });
  }
  await page.evaluate((v) => (window as any).jrnSetLayout(v), view);
  await expect(page).toHaveURL(new RegExp('view=' + view));
}

test.describe('journey numbers', () => {
  /**
   * @covers packages/server/public/app/surfaces/journeys.js::jrnHeaderHtml
   * @covers packages/server/public/app/surfaces/journeys.js::jrnCountedTip
   * @covers packages/server/public/app/surfaces/journeys.js::jrnCountedHtml
   * @covers GET /api/journey
   */
  test('every header number carries a tip that says what it counts, and a breakdown that adds up to it', async ({ page }) => {
    for (const lens of ['hybrid', 'business'] as const) {
      await openIn(page, lens, 'timeline');
      // the freshness sentence is a trigger too, and not a number: its own spec is freshness.pw.spec.ts
      const nums = page.locator('#jrn-count [data-tip-id]:not(.fresh)');
      const n = await nums.count();
      expect(n, 'the header prints its numbers as tip triggers').toBeGreaterThanOrEqual(3);
      let split = 0;
      for (let i = 0; i < n; i++) {
        const el = nums.nth(i);
        const text = (await el.innerText()).trim();
        await el.click();
        await expect(tip(page)).toBeVisible();
        // what it counts, over what, and from where
        await expect(tip(page)).toContainText(/Counts|What it counts|seen|declared|reached|verified/i);
        const hasSplit = (await tip(page).locator('.tip-cap').first().count()) > 0
          && /split/i.test(await tip(page).locator('.tip-cap').first().innerText());
        if (hasSplit) {
          const parts = (await tip(page).locator('.tip-tbl').first().locator('td.n').allTextContents()).map(Number);
          const total = Number((/\d+/.exec(text) || ['NaN'])[0]);
          expect(parts.reduce((a, b) => a + b, 0), `the breakdown of "${text}" adds up to it`).toBe(total);
          split++;
        }
        if (lens === 'business') await expect(tip(page)).not.toContainText('/api/');
        await page.keyboard.press('Escape');
        await expect(tip(page)).toBeHidden();
      }
      expect(split, 'at least one header number splits into parts').toBeGreaterThan(0);
      // the groups are separated by real text, so the line pastes into a ticket as it reads
      await expect(page.locator('#jrn-count')).toContainText(' · ');
      await page.keyboard.press('Escape');
    }
  });

  /**
   * @covers packages/server/public/app/surfaces/journeys.js::jrnBizTabsHtml
   * @covers packages/server/public/app/surfaces/journeys.js::jrnBizCellHtml
   */
  test('the business lane\'s In words count is the lines it draws', async ({ page }) => {
    await openIn(page, 'business', 'timeline');
    const words = page.locator('#jrn-tl .jrn-bizrow .jrn-biztab').first();
    await expect(words).toHaveClass(/\bon\b/);
    const n = Number(await words.locator('.n').innerText());
    const lines = await page.locator('#jrn-tl .jrn-bizrow .jrn-fl-step').count()
      + await page.locator('#jrn-tl .jrn-bizrow .jrn-dec-chip').count();
    expect(n).toBeGreaterThan(0);
    expect(n).toBe(lines);
  });

  /**
   * @covers packages/server/public/app/strings.js::plainWords
   * @covers packages/server/public/app/surfaces/journeys.js::jrnWords
   * @covers packages/server/public/app/surfaces/journeys.js::jrnMarkerText
   * @covers packages/server/public/app/surfaces/journey-drill.js::jrnDrillBoxHtml
   */
  test('the business lens prints no identifier in any view of the journey', async ({ page }) => {
    for (const view of ['storyboard', 'timeline', 'sheet', 'drill']) {
      await openIn(page, 'business', view);
      await expect(page.locator('#jrn-tl')).toBeVisible();
      let text = await visibleWords(page);
      // every screen of the storyboard and every stop of the drill, not only the one open on arrival
      if (view === 'storyboard') {
        const stops = await page.evaluate(() => (window as any).S.JOURNEY.summary.segments.flatMap((sg: any) => (sg.moments || []).map((mo: any) => [sg.index, mo.index])));
        for (const [si, mi] of stops) { await page.evaluate(([a, b]) => (window as any).jrnStoryGo(a, b), [si, mi]); text += '\n' + await visibleWords(page); }
      }
      if (view === 'drill') {
        const cols = await page.evaluate(() => (window as any).S.JRN_DRILL.cols.length);
        for (let ci = 0; ci < cols; ci++) { await page.evaluate((c) => (window as any).jrnDrillGo(c), ci); text += '\n' + await visibleWords(page); }
      }
      const hits = [...new Set(text.match(IDENTIFIER) || [])];
      expect(hits, `identifier-shaped words in the business ${view}`).toEqual([]);
      await page.keyboard.press('Escape');
    }
  });
});

test.describe('one word per position', () => {
  /**
   * @covers packages/server/public/app/surfaces/journeys.js::jrnStopOf
   * @covers packages/server/public/app/surfaces/journeys.js::jrnStopText
   * @covers packages/server/public/app/surfaces/journey-drill.js::jrnInspHeadHtml
   * @covers packages/server/public/app/surfaces/journeys.js::jrnSheetHtml
   */
  test('the Sheet counts its columns as stops, and the drawer names the stop a part sits in — never a walk index', async ({ page }) => {
    // swarm 2026-10-05 (six roles): *5 actions* above six columns; the drawer's *STEP 232*
    await openIn(page, 'hybrid', 'sheet');
    const cols = await page.locator('#jrn-tl .jrn-sbh').count();
    expect(cols).toBeGreaterThan(0);
    const corner = page.locator('#jrn-tl .jrn-slane.corner');
    await expect(corner).toContainText(/stop/i);
    await expect(corner.locator('.sub')).toContainText(new RegExp('^' + cols + ' stops?$'));
    // open the first call: the drawer's head is `stop n of <cols> · call`
    const order = await page.evaluate(() => {
      const sum = (window as any).S.JOURNEY.summary;
      for (const sg of sum.segments) for (const m of sg.markers) if (m.kind === 'call') return m.stepOrder;
      return -1;
    });
    expect(order).toBeGreaterThanOrEqual(0);
    await page.evaluate((o) => (window as any).jrnSelect(o), order);
    const head = page.locator('#jrn-dock .sel .hud-label, #journey .jrn-insp .sel .hud-label').first();
    await expect(head).toHaveText(new RegExp('^stop \\d+ of ' + cols + ' · call$', 'i'));
    const words = await visibleWords(page);
    expect(words, 'no bare walk index').not.toMatch(/\bstep \d+\b(?! of)/i);
  });
});

test.describe('journey chrome from the keyboard', () => {
  /**
   * @covers packages/server/public/app/keymap.js::onKeydown
   * @covers packages/server/public/app/surfaces/journeys.js::closeJourney
   */
  test('Esc with the scope menu open closes the menu, not the journey — and closing leaves no hidden filter', async ({ page }) => {
    await openBillingCycle(page);
    const journey = page.getByRole('dialog', { name: 'Journey', exact: true });
    await page.getByRole('button', { name: 'Source scope' }).click();
    const menu = page.getByRole('menu', { name: 'Sources and groups' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(journey).toBeVisible();
    await expect(page.getByRole('button', { name: 'Source scope' })).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(journey).toBeHidden();
    await expect(page).toHaveURL(/#\/journeys$/);
    await expect(page.locator('#focuschip')).toBeHidden();
  });

  /**
   * @covers packages/server/public/app/surfaces/journeys.js::jrnSkipLink
   * @covers packages/server/public/app/surfaces/journeys.js::jrnSkipToChrome
   */
  test('the journey\'s first stop is a skip link to the top bar, and the journey stays open', async ({ page }) => {
    await openBillingCycle(page);
    const journey = page.getByRole('dialog', { name: 'Journey', exact: true });
    const skip = page.getByRole('button', { name: 'Skip to the top bar' });
    await page.keyboard.press('Tab');
    await expect(skip).toBeFocused();
    const box = await skip.boundingBox();
    expect(box && box.width > 20 && box.height > 10, 'the link shows itself while it has the keyboard').toBe(true);
    await page.keyboard.press('Enter');
    const inTopbar = await page.evaluate(() => !!document.activeElement?.closest('.topbar'));
    expect(inTopbar).toBe(true);
    await expect(journey).toBeVisible();
  });

  /** @covers packages/server/public/app/surfaces/journeys.js::jrnToggleForks */
  test('a drawer parked off the edge takes no Tab stops', async ({ page }) => {
    await openBillingCycle(page);
    await expect(page.locator('#jrn-forks')).toHaveAttribute('inert', '');
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const inDrawer = await page.evaluate(() => !!document.activeElement?.closest('#jrn-forks,#jrn-cutlist'));
      expect(inDrawer, `Tab ${i + 1} walked into a closed drawer`).toBe(false);
    }
  });
});

// ── one absence word per fact (story swarm 2026-09-25, finding 4) ──────────
// On the reference app's submission flow 43 of 60 empty cells read *not involved* on the
// Timeline and *none indexed* on the Sheet. The word is the core's now
// (`summary.segments[].absent`), and every view prints it.

type Cells = Record<string, { w: string; text: string }>;

/** Every empty (screen, action, layer) cell the open view draws, with its word and its text. */
async function absentCells(page: Page, view: 'timeline' | 'sheet'): Promise<Cells> {
  return page.evaluate((v) => {
    const out: Record<string, { w: string; text: string }> = {};
    const sel = v === 'sheet' ? '.jrn-scell[data-sys]' : '.jrn-syscell[data-seg] .jrn-momcol[data-sys]';
    document.querySelectorAll(sel).forEach((cell) => {
      const el = cell as HTMLElement;
      const mk = el.querySelector('.jrn-mk.none[data-absent]') as HTMLElement | null;
      if (!mk) return;
      const seg = el.dataset.seg ?? (el.closest('.jrn-syscell') as HTMLElement).dataset.seg;
      out[seg + ':' + el.dataset.mo + ':' + el.dataset.sys] = { w: mk.dataset.absent!, text: mk.textContent!.trim() };
    });
    return out;
  }, view);
}

test.describe('journey absence words', () => {
  /**
   * @covers packages/server/public/app/surfaces/journeys.js::jrnAbsentWord
   * @covers packages/server/public/app/surfaces/journeys.js::jrnAbsentHtml
   * @covers packages/server/public/app/surfaces/journeys.js::jrnSysCellHtml
   * @covers packages/server/public/app/surfaces/journeys.js::jrnSheetCellHtml
   * @covers GET /api/journey
   */
  test('the Timeline and the Sheet print the same absence word for the same cell, in both registers', async ({ page }) => {
    for (const lens of ['hybrid', 'business'] as const) {
      await openIn(page, lens, 'timeline');
      await page.evaluate(() => (window as any).jrnSetView('rows'));
      const tl = await absentCells(page, 'timeline');
      await page.evaluate(() => (window as any).jrnSetLayout('sheet'));
      await expect(page).toHaveURL(/view=sheet/);
      const sh = await absentCells(page, 'sheet');
      const shared = Object.keys(tl).filter((k) => k in sh);
      expect(shared.length, 'the two views draw empty cells for the same actions and layers').toBeGreaterThan(3);
      for (const k of shared) {
        expect(sh[k]!.w, `${lens} · ${k}: Timeline says ${tl[k]!.w}, Sheet says ${sh[k]!.w}`).toBe(tl[k]!.w);
        expect(sh[k]!.text).toBe(tl[k]!.text);
      }
      // the word is the core's, not a view's own: the fixture's Messages row is
      // present in the journey, so an action that sends nothing takes no part —
      // the Sheet used to print *none indexed* here
      const msgs = shared.filter((k) => k.endsWith(':messages'));
      expect(msgs.length).toBeGreaterThan(0);
      for (const k of msgs) expect(tl[k]!.w).toBe('notInvolved');
      // and the business register spells it as the business sibling, in both views alike
      if (lens === 'business') expect(tl[msgs[0]!]!.text).not.toBe('not involved');
    }
  });

  /**
   * @covers packages/server/public/app/surfaces/journeys.js::jrnTestsFootHtml
   * @covers packages/server/public/app/surfaces/journeys.js::jrnStepActionFacts
   * @covers packages/server/public/app/surfaces/journey-drill.js::jrnInspHeadHtml
   * @covers GET /api/journey
   */
  test('a step no test reaches names its own scope and the action\'s number beside it — never a bare contradiction', async ({ page }) => {
    await openIn(page, 'hybrid', 'sheet');
    // the Verified-by cell names the scope it counts over
    const verified = page.locator('.jrn-scell.test').first();
    await expect(verified.locator('.jrn-tscope')).toHaveAttribute('data-scope', 'count.scope.action');
    // a step no test reaches, inside an action tests do reach
    const pick = await page.evaluate(() => {
      const J = (window as any).S.JOURNEY;
      const cov = J.summary.coverage;
      for (const sg of J.summary.segments) {
        for (let k = 0; k < sg.moments.length; k++) {
          const mo = sg.moments[k];
          const n = cov.moments[sg.index][k].counted.tests.n;
          if (!n) continue;
          const mk = sg.markers.find((m: any) => m.moment === mo.index && (m.tier ?? 0) <= 1 && m.kind === 'step'
            && !((J.steps[m.stepOrder].coverage || {}).tests || []).length && !(J.steps[m.stepOrder].coverageVia || []).length);
          if (mk) return { order: mk.stepOrder, n };
        }
      }
      return null;
    });
    expect(pick, 'the fixture has a step no test reaches inside an action tests reach').not.toBeNull();
    await page.evaluate(() => { const S = (window as any).S; S.SETTINGS = Object.assign({}, S.SETTINGS, { flags: { journeyDrill: true } }); });
    await page.evaluate(() => (window as any).jrnSetLayout('drill'));
    await page.evaluate((o) => (window as any).jrnSelect(o), pick!.order);
    const head = page.locator('.jrn-tfoot').filter({ hasText: 'no test reaches this part' }).first();
    await expect(head).toBeVisible();
    const wider = head.locator('.jrn-twider');
    await expect(wider).toHaveAttribute('data-scope', 'count.scope.action');
    await expect(wider).toContainText(String(pick!.n));
    await expect(wider).toContainText('reach the action it belongs to');
  });
});
