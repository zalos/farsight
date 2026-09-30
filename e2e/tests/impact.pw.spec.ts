// Change impact: how far the answer walks, and the tests it counts per distance.
//
// The story swarm (2026-09-25) found the drawer's test line labelled *everything
// listed so far* while it printed only the tests new at each distance — on the
// fixture's invoices table that read 4 · 1 · none · none where the union is
// 4 · 5 · 5 · 5 — and no way to change the distance but editing `hops=` in the URL.
import { test, expect, gotoReady } from './support';
import type { Page } from '@playwright/test';

const TABLE = 'invoice-app::table::invoices';
const hash = (hops: number) => '#/codemap?node=' + encodeURIComponent(TABLE) + '&impact=' + encodeURIComponent(TABLE) + '&hops=' + hops;

/** The number at the head of each "tests reaching" line's tip — its total, from the line's own words. */
async function testLines(page: Page): Promise<string[]> {
  return page.locator('#impact .imp-tests').allInnerTexts();
}

/** The union of tests over hops 1..n, computed here from the same `/api/impact` answer. */
function unionUpTo(report: { hops: { hop: number; nodes: { tests?: { id: string }[] }[] }[] }, n: number): number {
  const ids = new Set<string>();
  for (const h of report.hops) if (h.hop <= n) for (const x of h.nodes) for (const t of x.tests ?? []) ids.add(t.id);
  return ids.size;
}
const total = (line: string) => [...line.matchAll(/(\d+) (?:e2e|unit|integration)/g)].reduce((a, m) => a + Number(m[1]), 0);

test.describe('change impact', () => {
  /**
   * @covers packages/server/public/app/impact.js::impTestsReaching
   * @covers packages/server/public/app/impact.js::impactBodyHtml
   * @covers packages/server/public/app/impact.js::impScopeHtml
   * @covers GET /api/impact
   */
  test('each distance counts the tests reaching everything up to it, each once — never fewer than the line above', async ({ page, request }) => {
    const report = await (await request.get('/api/impact?node=' + encodeURIComponent(TABLE) + '&hops=4&tests=1')).json();
    await gotoReady(page, hash(4));
    await expect(page.locator('#impact.open .imp-hop').first()).toBeVisible();
    const lines = await testLines(page);
    expect(lines.length).toBe(report.hops.length);
    const totals = lines.map(total);
    expect(totals).toEqual(report.hops.map((h: { hop: number }) => unionUpTo(report, h.hop)));
    for (let i = 1; i < totals.length; i++) expect(totals[i]).toBeGreaterThanOrEqual(totals[i - 1]!);
    // the panel names what it counts over, as the journey's tests feet do
    await expect(page.locator('#impact .imp-scope [data-scope="impact.scope"]')).toHaveText(/on what uses this part/i);
    // past hop 1 the words say it is a union up to that distance
    expect(lines[1]).toContain('hops 1–2, each test once');
    expect(lines[lines.length - 1]).not.toContain('none indexed');
  });

  /**
   * @covers packages/server/public/app/impact.js::impactSetHops
   * @covers packages/server/public/app/impact.js::impactHash
   */
  test('HOW FAR walks another distance, and the link carries it', async ({ page }) => {
    await gotoReady(page, hash(2));
    const ctl = page.getByRole('group', { name: /how far|range/i });
    await expect(ctl).toBeVisible();
    await expect(ctl.getByRole('button', { name: 'walk 2 links out' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#impact .imp-hop:not(.imp-notwalked)')).toHaveCount(2);

    await ctl.getByRole('button', { name: 'walk 3 links out' }).click();
    await expect(page).toHaveURL(/[?&]hops=3\b/);
    await expect(page.locator('#impact .imp-hop:not(.imp-notwalked)')).toHaveCount(3);
    await expect(page.getByRole('group', { name: /how far|range/i }).getByRole('button', { name: 'walk 3 links out' })).toHaveAttribute('aria-pressed', 'true');

    await ctl.getByRole('button', { name: 'walk 1 link out' }).click();
    await expect(page).toHaveURL(/[?&]hops=1\b/);
    await expect(page.locator('#impact .imp-hop:not(.imp-notwalked)')).toHaveCount(1);
  });

  /** @covers packages/server/public/app/impact.js::impactFromRoute */
  test('a shared link opens on the distance it names', async ({ page }) => {
    await gotoReady(page, hash(4));
    await expect(page.getByRole('group', { name: /how far|range/i }).getByRole('button', { name: 'walk 4 links out' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#impact .imp-hop:not(.imp-notwalked)')).toHaveCount(4);
  });

  /** @covers packages/server/public/app/impact.js::impactBizHtml */
  test('the business register has no distance control — it counts no distances', async ({ page }) => {
    await gotoReady(page, hash(2).replace('#/codemap?', '#/codemap?lens=business&'));
    await expect(page.locator('#impact.open .imp-biz')).toBeVisible();
    await expect(page.getByRole('group', { name: /how far|range/i })).toHaveCount(0);
    await expect(page.locator('#impact .imp-scope [data-scope="impact.scope"]')).toHaveText(/on what uses this part/i);
  });
});
