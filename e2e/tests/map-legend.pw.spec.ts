// The map's legend, its lines between journeys, whole words and the business lens (map pass 2, lane L;
// docs/proposals/map-pass-2026-10-03.md §3 row L). The legend opens by itself once and lists only what the
// board draws; the lines between journeys run in the gutters with one label each that never covers a journey,
// measured on a twelve-journey board stubbed over the fixture's own answers (page.route, ADR 8); no title,
// chip, call or data name is cut; and the business lens prints no identifier and none of the contract's or
// the index's own words anywhere on the map.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';
import { stubStores } from './map-stores-stub';

const FLOW = 'invoice-app::flow::billing-cycle';
const STREET = '#/map/' + encodeURIComponent(FLOW);
const LIST_PAGE = 'invoice-app::page::/invoices';

/** Identifier-shaped tokens (the journey-numbers check). */
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
/** The contract's and the index's own words, which the business lens does not print (the swarm counted them). */
const DEV_WORDS = /\bspec-backed\b|\bimplied\b|\bedge confidence\b|\bMEDIUM\b|\bguards?\b|·\s*record\b/i;

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
async function lens(page: Page, l: 'business' | 'hybrid') {
  await page.locator('#lb-' + l).click();
  await expect(page.locator('body')).toHaveClass(new RegExp('lens-' + l));
}
/** Every district drawn and every walk landed. */
async function boardReady(page: Page, n: number) {
  await expect(page.locator('.map-district')).toHaveCount(n);
  await expect(page.locator('.map-district.loaded')).toHaveCount(n, { timeout: 20_000 });
}
async function openStreet(page: Page, flow = FLOW) {
  await go(page, '#/map/' + encodeURIComponent(flow) + '?plumb=1');
  await expect(page.locator(`.map-district[data-flow="${flow}"] .map-scr`)).toHaveCount(3);
  await expect(page.locator('.map-world')).toHaveClass(/lvl-st/);
  await expect(page.locator(`.map-pl[data-flow="${flow}"]`).first()).toBeVisible();
}
/** The words a reader can see inside `sel`, as written. */
async function visibleWords(page: Page, sel = '.map-stage'): Promise<string> {
  return page.evaluate((s) => {
    const out: string[] = [];
    const root = document.querySelector(s);
    if (!root) return '';
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = w.nextNode())) {
      const el = n.parentElement;
      if (!el || !n.textContent?.trim()) continue;
      if (el.checkVisibility({ visibilityProperty: true })) out.push(n.textContent);
    }
    return out.join('\n');
  }, sel);
}

// a twelve-journey board over the fixture: Billing cycle's walk, twelve times, with links that cross the board
const N = 12;
const SYN = (i: number) => 'invoice-app::flow::syn-' + i;
const NAMES = [
  'Send a reminder for an overdue invoice and record the answer',
  'Pay', 'Approve a correction request for a returned invoice from start to finish', 'Close the month',
  'Export the ledger', 'Invite a colleague to the billing team and agree their permissions',
  'Archive old drafts', 'Credit a customer', 'Merge two customers', 'Split an invoice into two',
  'Review the weekly consolidation of approved invoices before payment', 'Sign in',
];
const LINKS: Record<number, { leadsTo?: number[]; partOf?: number[] }> = {
  0: { leadsTo: [1, 7] }, 1: { leadsTo: [2] }, 2: { leadsTo: [3, 11] }, 3: { leadsTo: [4] }, 4: { leadsTo: [3, 5] },
  5: { leadsTo: [6, 1] }, 6: { leadsTo: [7], partOf: [0] }, 7: { leadsTo: [8] }, 8: { leadsTo: [9] }, 9: { leadsTo: [10] },
  10: { leadsTo: [11] }, 11: { partOf: [2] },
};
async function stubBoard(page: Page) {
  await page.route(/\/api\/design\?/, async (r) => {
    let d: any;
    try { d = await (await r.fetch()).json(); } catch { return; }
    const src = d.designs[0];
    const base = src.flows.find((f: any) => f.id === 'billing-cycle');
    src.flows = NAMES.map((name, i) => ({ ...base, nodeId: SYN(i), id: 'syn-' + i, name, description: base.description }));
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify(d) });
  });
  await page.route(/\/api\/journey\?entry=/, async (r) => {
    const entry = new URL(r.request().url()).searchParams.get('entry') || '';
    const m = /::flow::syn-(\d+)$/.exec(entry);
    if (!m) return r.continue();
    const i = Number(m[1]);
    let d: any;
    try { d = await (await r.fetch({ url: r.request().url().replace(/entry=[^&]*/, 'entry=' + encodeURIComponent(FLOW)) })).json(); } catch { return; }
    const l = LINKS[i] || {};
    d.summary.links = {
      requires: [],
      leadsTo: (l.leadsTo || []).map((k) => ({ id: SYN(k), name: NAMES[k] })),
      partOf: (l.partOf || []).map((k) => ({ id: SYN(k), name: NAMES[k] })),
    };
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify(d) });
  });
}

/** Every drawn label against every cover and every other label, in screen pixels. */
async function labelOverlaps(page: Page) {
  return page.evaluate(() => {
    const hit = (a: DOMRect, b: DOMRect) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const labels = [...document.querySelectorAll('.map-links g[data-link]:not(.off) .lbl:not(.off) rect')].map((e) => e.getBoundingClientRect());
    const covers = [...document.querySelectorAll('.map-district')].map((e) => e.getBoundingClientRect());
    let onCover = 0, onLabel = 0;
    for (const l of labels) for (const c of covers) if (hit(l, c)) onCover++;
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) if (hit(labels[i], labels[j])) onLabel++;
    const perLine = [...document.querySelectorAll('.map-links g[data-link]')].map((g) => g.querySelectorAll('.lbl').length);
    const words = [...document.querySelectorAll('.map-links .lbl text')].map((t) => t.textContent || '');
    return { labels: labels.length, onCover, onLabel, most: Math.max(0, ...perLine), lines: perLine.length, words };
  });
}

test.describe('map — the legend', () => {
  test.use({ mapLegendSeen: false });
  /**
   * @covers packages/server/public/app/surfaces/map.js::toggleLegend
   * @covers packages/server/public/app/surfaces/map.js::drawLegend
   * @covers packages/server/public/app/surfaces/map.js::legendFacts
   */
  test('opens once on a first visit, lists the kinds the board draws, and comes back from ? and the key', async ({ page }) => {
    await stubStores(page);
    await mapOn(page);
    await go(page, '#/map');
    await boardReady(page, 3);
    const legend = page.locator('.map-legend');
    await expect(legend).toBeVisible();
    // the kinds present on the fixture board: its links, read and write, the database and the ERP, built and
    // designed-not-built screens, a call made again, the evidence words its journeys earned
    for (const kind of ['leadsTo', 'requires', 'partOf', 'read', 'write', 'store-sql', 'store-erp', 'built', 'planned', 'again']) {
      await expect(legend.locator(`[data-lg="${kind}"]`), kind).toHaveCount(1);
    }
    await expect(legend.locator('[data-lg^="evidence-"]').first()).toBeVisible();
    // every word in it carries its define
    expect(await legend.locator('.lg-row .w:not([data-tip])').count()).toBe(0);
    // what the board does not draw is not listed: no two journeys lead to each other on the fixture
    await expect(legend.locator('[data-lg="mutual"]')).toHaveCount(0);
    await legend.getByRole('button', { name: 'Close the legend' }).click();
    await expect(legend).toBeHidden();

    // a returning reader is not shown it again; the toolbar's ? and the ? key bring it back, Esc closes it
    await page.reload();
    await mapOn(page);
    await go(page, '#/map');
    await boardReady(page, 3);
    await expect(legend).toBeHidden();
    await page.locator('.map-tools [data-act="legend"]').click();
    await expect(legend).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(legend).toBeHidden();
    // (on a focused word with a tip, ? opens that tip — the tooltip grammar — so the key is pressed from the page)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('?');
    await expect(legend).toBeVisible();
    await expect(page.locator('#keymap')).not.toHaveClass(/\bopen\b/);
    await page.keyboard.press('?');
    await expect(legend).toBeHidden();
  });
});

test.describe('map — the lines between journeys', () => {
  /**
   * @covers packages/server/public/app/lib/map-model.js::routeLinks
   * @covers packages/server/public/app/surfaces/map.js::drawLinks
   * @covers packages/server/public/app/surfaces/map.js::linkVisibility
   */
  test('on a twelve-journey board every line has at most one label, and no label covers a journey', async ({ page }) => {
    await stubBoard(page);
    await mapOn(page);
    await go(page, '#/map');
    await boardReady(page, N);
    // the lines: every leads-to named above, the mutual pair (3 and 4) drawn once with two arrowheads
    await expect(page.locator('.map-links g[data-link="leadsTo"]')).toHaveCount(14);
    await expect(page.locator('.map-links g[data-both]')).toHaveCount(1);
    await expect(page.locator('.map-links g[data-both] .head')).toHaveCount(2);
    const fit = await labelOverlaps(page);
    expect(fit.most, 'a line with two labels').toBeLessThanOrEqual(1);
    expect(fit.onCover, 'labels over a journey at the fit').toBe(0);
    expect(fit.onLabel, 'labels over each other at the fit').toBe(0);
    expect(fit.labels, 'labels drawn at the fit').toBeGreaterThan(0);
    // a label is one word, never doubled into its neighbour
    for (const w of fit.words) expect(w).toMatch(/^(leads to|part of|lead to each other)$/i);
    // hovering a journey lights its lines, part of included, with their labels — still clear of every journey
    await page.locator(`.map-district[data-flow="${SYN(6)}"] .map-dcover`).hover();
    await expect(page.locator('.map-links g.hot').first()).toBeVisible();
    await expect(page.locator(`.map-links g[data-link="partOf"][data-to="${SYN(6)}"]`)).not.toHaveClass(/\boff\b/);
    const hot = await labelOverlaps(page);
    expect(hot.onCover, 'labels over a journey with a journey lit').toBe(0);
    // zoomed in, more labels fit; none lands on a journey
    await page.evaluate(() => (window as any).mapZoom(1.6));
    await page.waitForTimeout(600);
    const near = await labelOverlaps(page);
    expect(near.onCover, 'labels over a journey zoomed in').toBe(0);
    expect(near.onLabel).toBe(0);
  });
});

test.describe('map — whole words', () => {
  /**
   * @covers packages/server/public/app/surfaces/map.js::foldCoverChips
   * @covers packages/server/public/app/surfaces/map.js::callTextH
   */
  test('no title, chip, call, path or data name is cut, on the board or the street, in either lens', async ({ page }) => {
    await stubBoard(page);
    await stubStores(page);
    await mapOn(page);
    await go(page, '#/map');
    await boardReady(page, N);
    for (const l of ['hybrid', 'business'] as const) {
      await lens(page, l);
      await page.waitForTimeout(300);
      // the covers: a title wraps (two lines, then its tip has it whole); chips wrap or fold into +n — none is cut
      const board = await page.evaluate(() => {
        const out: string[] = [];
        document.querySelectorAll('.map-dcover').forEach((cv) => {
          const nm = cv.querySelector('.nm') as HTMLElement;
          if (nm.scrollWidth > nm.clientWidth + 1) out.push('title wider than its box: ' + nm.textContent);
          if (!(cv.getAttribute('data-tip-text') || '').includes(nm.textContent || '')) out.push('title not whole in the tip: ' + nm.textContent);
          const agg = cv.querySelector('.agg') as HTMLElement;
          const a = agg.getBoundingClientRect();
          agg.querySelectorAll(':scope > *').forEach((c) => {
            const el = c as HTMLElement;
            if (!el.checkVisibility()) return;
            const r = el.getBoundingClientRect();
            if (r.right > a.right + 1 || r.bottom > a.bottom + 1) out.push('chip cut: ' + el.textContent);
          });
        });
        return out;
      });
      expect(board, `cut words on the ${l} board`).toEqual([]);
      const more = page.locator('.map-dcover .map-more').first();
      if (await more.count()) await expect(more).toHaveAttribute('data-tip-id', 'number');
    }
    // the street of the journey with the longest name: Billing cycle's screens, calls and data
    await lens(page, 'hybrid');
    await openStreet(page, SYN(2));
    for (const l of ['hybrid', 'business'] as const) {
      await lens(page, l);
      await expect(page.locator(`.map-pl[data-flow="${SYN(2)}"]`).first()).toBeVisible();
      await page.waitForTimeout(300);
      const street = await page.evaluate((flow) => {
        const out: string[] = [];
        const d = document.querySelector(`.map-district[data-flow="${flow}"]`)!;
        const cut = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
        d.querySelectorAll('.map-scr .nm, .map-scr .route, .map-pl .nm, .map-pl .sub, .map-pd .nm, .map-pd .kd, .map-pl, .map-pd').forEach((e) => {
          const el = e as HTMLElement;
          if (!el.checkVisibility()) return;
          // the hybrid kind line ends with the identifier, which the card prints whole; it may give way, the words may not
          if (el.matches('.map-pd .kd') && el.querySelector('.map-code')?.checkVisibility()) {
            const words = el.firstChild?.textContent || '';
            const w = document.createElement('span');
            w.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:inherit;letter-spacing:inherit;text-transform:inherit';
            w.textContent = words;
            el.appendChild(w);
            const over = w.offsetWidth > el.clientWidth + 1;
            w.remove();
            if (over) out.push('kind words cut: ' + words);
            return;
          }
          if (cut(el)) out.push(el.className + ': ' + (el.textContent || '').trim().slice(0, 60));
        });
        return out;
      }, SYN(2));
      expect(street, `cut words on the ${l} street`).toEqual([]);
    }
  });

  /** @covers packages/server/public/app/surfaces/portfolio.js::mapSwitchHtml */
  test('the Portfolio switch reads Table and Board; the nav tab stays Map', async ({ page }) => {
    await mapOn(page);
    await go(page, '#/journeys');
    await go(page, '#/portfolio');
    await expect(page.locator('.pf-viewsw .jrn-viewbtn')).toHaveText(['Table', 'Board']);
    await page.locator('.pf-viewsw [data-go="map"]').click();
    await expect(page.locator('#nav .navtab.on')).toHaveText('Map');
    // one lens control: the header's; the map's toolbar has none of its own
    await expect(page.locator('.map-tools [data-act="lens"]')).toHaveCount(0);
  });
});

test.describe('map — the business lens finishes', () => {
  /**
   * @covers packages/server/public/app/surfaces/map.js::dataKindWords
   * @covers packages/server/public/app/surfaces/map-property.js::gateRow
   * @covers packages/server/public/app/surfaces/map-property.js::dedupeGates
   * @covers packages/server/public/app/surfaces/map-property.js::evChip
   */
  test('board, legend, street with plumbing, card and every property tab: no identifier, no contract or index words', async ({ page }) => {
    await stubStores(page);
    await mapOn(page);
    await lens(page, 'business');
    await go(page, '#/map');
    await boardReady(page, 3);
    await page.locator('.map-tools [data-act="legend"]').click();
    await expect(page.locator('.map-legend')).toBeVisible();
    let text = await visibleWords(page);
    await page.keyboard.press('Escape');
    await openStreet(page);
    text += '\n' + await visibleWords(page);
    // a data node says its store and a plain word
    const kd = await page.locator(`.map-pd[data-flow="${FLOW}"][data-store="Invoice DB"] .kd`).first().evaluate((e) => e.firstChild!.textContent);
    expect(kd).toBe('Invoice DB · database record');
    await page.locator(`.map-pd[data-flow="${FLOW}"][data-si="1"]`).first().click();
    await expect(page.locator('.map-xcard')).toBeVisible();
    text += '\n' + await visibleWords(page, '.map-xcard');
    await page.keyboard.press('Escape');
    await go(page, STREET + '?node=' + encodeURIComponent(LIST_PAGE));
    await expect(page.locator('.mp')).toBeVisible();
    for (const tab of ['overview', 'gates', 'apis', 'ux', 'tests', 'route', 'work', 'changes']) {
      await page.locator(`.mp-tab[data-tab="${tab}"]`).click();
      await expect(page.locator('.mp-body .mp-loading')).toHaveCount(0);
      text += '\n' + await visibleWords(page);
    }
    expect([...new Set(text.match(IDENTIFIER) || [])], 'identifier-shaped words on the business map').toEqual([]);
    expect(text.match(DEV_WORDS), 'contract or index words on the business map').toBeNull();
    // a checkpoint is a check or a rule, in words; the same words are one row
    await page.locator('.mp-tab[data-tab="gates"]').click();
    const gates = await page.locator('.mp-body .mp-row.card[data-map-card="gate"] .nm').allTextContents();
    expect(new Set(gates).size, 'a checkpoint said in the same words twice').toBe(gates.length);
    await expect(page.locator('.mp-body .mp-row.card[data-map-card="gate"] .sub').first()).toHaveText(/^(check|rule)/);
  });
});
