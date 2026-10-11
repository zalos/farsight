// The journey's numbers and words (pass swarm 2026-09-25 → fix/journey-numbers-and-words), read on the Map since the
// journey page retired into it (lanes round 2026-10-10): every number on the table's head carries a tip whose
// breakdown adds up to it, the business register prints no identifier on the street, at any screen or at any action,
// one word per position, and the chrome answers the keyboard at the table.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady, openJourneyAt } from './support';

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

const FLOW = encodeURIComponent('invoice-app::flow::billing-cycle');

/**
 * The words a stop renders — as written, not as CSS upper-cases them — of every text node a reader can see inside
 * `root`: a drawer parked off the edge does not count.
 */
async function visibleWords(page: Page, root: string): Promise<string> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    for (const r of Array.from(document.querySelectorAll(sel))) {
      const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = w.nextNode())) {
        const el = n.parentElement;
        if (!el || !n.textContent?.trim()) continue;
        if (el.closest('#jrn-forks:not(.open),#jrn-cutlist:not(.open),[hidden]')) continue;
        if (el.checkVisibility({ visibilityProperty: true })) out.push(n.textContent);
      }
    }
    return out.join('\n');
  }, root);
}

test.describe('journey numbers', () => {
  /**
   * @covers packages/server/public/app/lib/journey-draw.js::jrnHeaderHtml
   * @covers packages/server/public/app/lib/journey-draw.js::jrnCountedTip
   * @covers packages/server/public/app/lib/journey-draw.js::jrnCountedHtml
   * @covers GET /api/journey
   */
  test('every number on the table\'s head carries a tip that says what it counts, and a breakdown that adds up to it', async ({ page }) => {
    // two registers × every tip on the head, each hovered and closed: the runs sentence and the build state added triggers
    test.setTimeout(75_000);
    for (const lens of ['hybrid', 'business'] as const) {
      await openJourneyAt(page, 'table', lens);
      // the freshness sentence is a trigger too, and not a number: its own spec is freshness.pw.spec.ts
      // a number folded into the head's `+n` is listed in that chip's tip (cleanup pass 2026-10-11): the ones on the line
      const nums = page.locator('.map-jhead .jrn-count [data-tip-id]:not(.fresh):not(.jh-more):visible');
      const n = await nums.count();
      expect(n, 'the head prints its numbers as tip triggers').toBeGreaterThanOrEqual(3);
      let split = 0;
      for (let i = 0; i < n; i++) {
        const el = nums.nth(i);
        const text = (await el.innerText()).trim();
        // on the Map a tip opens on hover
        await el.hover();
        await expect(tip(page)).toBeVisible();
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
        await page.mouse.move(2, 880);
        await expect(tip(page)).toBeHidden();
      }
      expect(split, 'at least one head number splits into parts').toBeGreaterThan(0);
      // the groups are separated by real text, so the line pastes into a ticket as it reads
      await expect(page.locator('.map-jhead .jrn-count')).toContainText(' · ');
    }
  });

  /**
   * the identifier-token walk: the business street, every screen stop, the table and every action stop
   * @covers packages/server/public/app/strings.js::plainWords
   * @covers packages/server/public/app/lib/journey-draw.js::jrnWords
   * @covers packages/server/public/app/lib/journey-draw.js::jrnMarkerText
   * @covers packages/server/public/app/surfaces/journey-drill.js::jrnDrillBoxHtml
   */
  test('the business register prints no identifier on the street, at any screen, on the table or at any action', async ({ page }) => {
    const found: Record<string, string[]> = {};
    const check = async (where: string, root: string) => {
      const hits = [...new Set((await visibleWords(page, root)).match(IDENTIFIER) || [])];
      if (hits.length) found[where] = hits;
    };
    // the street: the journey's head and its screens
    await openJourneyAt(page, 'screens', 'business');
    await check('street', '.map-district[data-flow="invoice-app::flow::billing-cycle"]');
    // every screen stop
    const screens = await page.locator('.map-scr[data-flow="invoice-app::flow::billing-cycle"]').count();
    for (let i = 1; i <= screens; i++) {
      await gotoReady(page, '#/map/' + FLOW + '?node=' + encodeURIComponent(await page.locator('.map-scr[data-flow="invoice-app::flow::billing-cycle"][data-index="' + (i - 1) + '"]').getAttribute('data-node') || '') + '&lens=business');
      await expect(page.locator('.mp')).toBeVisible();
      await check('screen ' + i, '.map-prop-host');
      if (i < screens) await openJourneyAt(page, 'screens', 'business');
    }
    // the table
    await openJourneyAt(page, 'table', 'business');
    await check('table', '.map-table');
    // every action, one at a time
    const cols = await page.evaluate(() => (window as any).S.JRN_SHEET.cols.map((c: any) => [c.sg.index, c.mo.index]));
    await gotoReady(page, '#/map/' + FLOW + '?screen=1&action=1&lens=business');
    await expect(page.locator('.map-act')).toBeVisible();
    for (let k = 0; k < cols.length; k++) {
      if (k) { await page.keyboard.press(']'); await expect.poll(() => page.evaluate(() => (window as any).S.jrnAction)).toBe(k); }
      await expect(page.locator('.map-act #jrn-dlanes .jrn-bx, .map-act #jrn-dlanes .jrn-seam').first()).toBeVisible();
      await check('action ' + (k + 1), '.map-act');
    }
    expect(found, 'identifier-shaped words in the business register').toEqual({});
  });
});

test.describe('one word per position', () => {
  /**
   * @covers packages/server/public/app/lib/journey-draw.js::jrnStopOf
   * @covers packages/server/public/app/lib/journey-draw.js::jrnStopText
   * @covers packages/server/public/app/lib/journey-draw.js::jrnSheetHtml
   */
  test('the table counts its columns as stops, and the dock names the stop a part sits in — never a walk index', async ({ page }) => {
    // swarm 2026-10-05 (six roles): *5 actions* above six columns; the drawer's *STEP 232*
    await openJourneyAt(page, 'table', 'hybrid');
    const cols = await page.locator('.map-table .jrn-sbh').count();
    expect(cols).toBeGreaterThan(0);
    const corner = page.locator('.map-table .jrn-slane.corner');
    await expect(corner).toContainText(/stop/i);
    await expect(corner.locator('.sub')).toContainText(new RegExp('^' + cols + ' stops?$'));
    // open the first call: the dock's head is `stop n of <cols> · call`
    const order = await page.evaluate(() => {
      const sum = (window as any).S.JOURNEY.summary;
      for (const sg of sum.segments) for (const m of sg.markers) if (m.kind === 'call') return m.stepOrder;
      return -1;
    });
    expect(order).toBeGreaterThanOrEqual(0);
    await page.evaluate((o) => (window as any).jrnSelect(o), order);
    const head = page.locator('#jrn-dock .sel .hud-label').first();
    await expect(head).toHaveText(new RegExp('^stop \\d+ of ' + cols + ' · call$', 'i'));
    const words = await visibleWords(page, '.map-table');
    expect(words, 'no bare walk index').not.toMatch(/\bstep \d+\b(?! of)/i);
  });
});

test.describe('the table from the keyboard', () => {
  /**
   * @covers packages/server/public/app/keymap.js::onKeydown
   * @covers packages/server/public/app/surfaces/map.js::mapEscape
   */
  test('Esc with the scope menu open closes the menu, not the table — then up a stop to the board, no hidden filter', async ({ page }) => {
    await openJourneyAt(page, 'table');
    const table = page.locator('.map-table .jrn-sheet');
    await page.getByRole('button', { name: 'Source scope' }).click();
    const menu = page.getByRole('menu', { name: 'Sources and groups' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(table).toBeVisible();
    await expect(page.getByRole('button', { name: 'Source scope' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(table).toHaveCount(0);
    await expect(page).toHaveURL(/#\/map(\?|$)/);
    await expect(page.locator('#focuschip')).toBeHidden();
  });

  /** @covers packages/server/public/app/lib/journey-draw.js::jrnToggleForks */
  test('a drawer parked off the edge takes no Tab stops', async ({ page }) => {
    await openJourneyAt(page, 'table', 'code');
    await expect(page.locator('#jrn-forks')).toHaveAttribute('inert', '');
    await page.locator('.map-jhead .nm').click();
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
// (`summary.segments[].absent`), and every stop prints it: the table and the action's beats.

type Cells = Record<string, { w: string; text: string }>;

/** Every empty (screen, action, layer) cell the table draws, with its word and its text. */
async function absentCells(page: Page): Promise<Cells> {
  return page.evaluate(() => {
    const out: Record<string, { w: string; text: string }> = {};
    document.querySelectorAll('.map-table .jrn-scell[data-sys]').forEach((cell) => {
      const el = cell as HTMLElement;
      const mk = el.querySelector('.jrn-mk.none[data-absent]') as HTMLElement | null;
      if (!mk) return;
      out[el.dataset.seg + ':' + el.dataset.mo + ':' + el.dataset.sys] = { w: mk.dataset.absent!, text: mk.textContent!.trim() };
    });
    return out;
  });
}

test.describe('journey absence words', () => {
  /**
   * @covers packages/server/public/app/lib/journey-draw.js::jrnAbsentWord
   * @covers packages/server/public/app/lib/journey-draw.js::jrnAbsentHtml
   * @covers packages/server/public/app/lib/journey-draw.js::jrnSheetCellHtml
   * @covers GET /api/journey
   */
  test('the table prints the core\'s absence word for every empty cell, in both registers', async ({ page }) => {
    const words: Record<string, Cells> = {};
    for (const lens of ['hybrid', 'business'] as const) {
      await openJourneyAt(page, 'table', lens);
      words[lens] = await absentCells(page);
      // the word is the core's, not a view's own: the fixture's Messages row is present in the journey, so an action
      // that sends nothing takes no part — the Sheet used to print *none indexed* here
      const msgs = Object.keys(words[lens]!).filter((k) => k.endsWith(':messages'));
      expect(msgs.length).toBeGreaterThan(0);
      for (const k of msgs) expect(words[lens]![k]!.w).toBe('notInvolved');
    }
    // the same fact in both registers, spelt as the business sibling in business
    const keys = Object.keys(words.hybrid!);
    expect(keys.length).toBeGreaterThan(3);
    for (const k of keys) expect(words.business![k]!.w, k).toBe(words.hybrid![k]!.w);
    const msg = keys.find((k) => k.endsWith(':messages'))!;
    expect(words.business![msg]!.text).not.toBe('not involved');
  });

  /**
   * @covers packages/server/public/app/lib/journey-draw.js::jrnTestsFootHtml
   * @covers packages/server/public/app/lib/journey-draw.js::jrnStepActionFacts
   * @covers packages/server/public/app/surfaces/journey-drill.js::jrnInspHeadHtml
   * @covers GET /api/journey
   */
  test('a step no test reaches names its own scope and the action\'s number beside it — never a bare contradiction', async ({ page }) => {
    await openJourneyAt(page, 'table', 'hybrid');
    // the Verified-by cell names the scope it counts over, on the chip itself (round 2026-10-10)
    const verified = page.locator('.jrn-scell.test').first();
    await expect(verified.locator('[data-tchip]').first()).toHaveAttribute('data-scope', 'count.scope.action');
    await expect(verified.locator('.tc-scope').first()).toHaveText('over this action');
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
          if (mk) return { order: mk.stepOrder, n, node: mk.nodeId, screen: sg.index + 1 };
        }
      }
      return null;
    });
    expect(pick, 'the fixture has a step no test reaches inside an action tests reach').not.toBeNull();
    // the action that holds it, at its beats, the code open: the inspector's foot names both scopes
    await gotoReady(page, '#/map/' + FLOW + '?screen=' + pick!.screen + '&part=' + encodeURIComponent(pick!.node) + '&layout=beats&dock=right&lens=hybrid');
    await expect(page.locator('.map-act')).toBeVisible();
    await page.evaluate((o) => (window as any).jrnSelect(o), pick!.order);
    const head = page.locator('.jrn-tfoot').filter({ hasText: 'no test is known to reach this part' }).first();
    await expect(head).toBeVisible();
    const wider = head.locator('.jrn-twider');
    await expect(wider).toHaveAttribute('data-scope', 'count.scope.action');
    await expect(wider).toContainText(String(pick!.n));
    await expect(wider).toContainText('over the action it belongs to');
  });
});
