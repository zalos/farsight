// A gate at every action it guards, the card named by the app's words, register parity, and who may do what
// (outsider round 2026-10-13, worklist F2 + F4). The outsiders read the reference app's approve column as having no
// role control: the guard sat only on the first action that met it, and its card said *a check nobody has put in
// words* though the team had written one. These specs pin the viewer's side over the fixture graph.
import { test, expect, gotoReady } from './support';

const FLOW = 'invoice-app::flow::billing-cycle';
const enc = encodeURIComponent;

/** Every gate id the gates cells of the table hold, per column: drawn, folded into another wording, or not in words. */
async function gateIdsByColumn(page: import('@playwright/test').Page, lens: string): Promise<Record<string, string[]>> {
  await gotoReady(page, '#/map/' + enc(FLOW) + '?layout=table&lens=' + lens);
  await expect(page.locator('.jrn-sheet .jrn-sbh').first()).toBeVisible();
  return page.$$eval('.jrn-scell[data-sys="gates"]', (cells) => {
    const out: Record<string, string[]> = {};
    for (const c of cells) {
      const ids = new Set<string>();
      c.querySelectorAll('[data-gate-ids]').forEach((g) => (g.getAttribute('data-gate-ids') || '').split(' ').filter(Boolean).forEach((x) => ids.add(x)));
      out[c.getAttribute('data-col')!] = [...ids].sort();
    }
    return out;
  });
}

/**
 * @covers packages/server/public/app/lib/journey-draw.js::jrnChecksHtml
 * @covers packages/server/public/app/lib/journey-draw.js::jrnGateTiersHtml
 * @covers packages/server/public/app/lib/journey-model.js::jrnGatesIn
 */
test('register parity: every gate a column holds in hybrid it holds in business — a row, a folded wording or the technical fold', async ({ page }) => {
  const hybrid = await gateIdsByColumn(page, 'hybrid');
  const business = await gateIdsByColumn(page, 'business');
  const cols = Object.keys(hybrid);
  expect(cols.length).toBeGreaterThan(0);
  expect(cols.some((c) => hybrid[c]!.length > 0), 'the fixture has gates on its actions').toBe(true);
  for (const c of cols) expect(business[c] ?? [], 'column ' + c).toEqual(hybrid[c]);
});

/** @covers packages/server/public/app/lib/journey-draw.js::jrnGateInWords */
test('a gate whose @guard label is code is named by its @business sentence, never as unnamed', async ({ page }) => {
  await gotoReady(page, '#/journeys');
  const words = await page.evaluate(async () => {
    const m = await import('/app/lib/journey-draw.js' as string);
    return [
      m.jrnGateInWords({ id: 'x::requireOpsRole', kind: 'guard', name: 'requireOpsRole: entraSession role', facets: { business: { description: 'Refuses a console action the signed-in operator’s role does not allow.' } } }),
      m.jrnGateInWords({ id: 'x::requireOpsRole', kind: 'guard', name: 'requireOpsRole: entraSession role' }),
      m.jrnGateInWords({ id: 'x::g', kind: 'guard', name: 'g: approver role', facets: { business: { description: 'Someone wrote this.' } } }),
    ];
  });
  expect(words[0]).toBe('Refuses a console action the signed-in operator’s role does not allow.');
  expect(words[1], 'no words written: still nothing in the business register').toBe('');
  expect(words[2], 'a label in words stays first').toBe('approver role');
});

/** @covers packages/server/public/app/lib/gate-card.js::openGateCard */
test('a gate card opened from the rightmost column of the table opens inside the window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoReady(page, '#/map/' + enc(FLOW) + '?layout=table&lens=business');
  await expect(page.locator('.jrn-sheet .jrn-sbh').first()).toBeVisible();
  const gates = page.locator('.jrn-scell[data-sys="gates"] [data-gate-card]');
  await expect(gates.first()).toBeVisible();
  // the gate furthest right on the page
  const n = await gates.count();
  let best = 0, x = -1;
  for (let i = 0; i < n; i++) {
    const b = await gates.nth(i).boundingBox();
    if (b && b.x > x && b.x + 20 < 1280) { x = b.x; best = i; }
  }
  await gates.nth(best).click();
  const tip = page.locator('.fs-tip.gc-tip');
  await expect(tip).toBeVisible();
  const box = (await tip.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1280);
});

/**
 * @covers packages/server/public/app/surfaces/roles.js::mountRoles
 * @covers GET /api/roles
 */
test('#/roles answers from the server: the counts, a row per guarded action or the empty sentence, and its exports', async ({ page }) => {
  const api = await (await page.request.get('/api/roles')).json();
  expect(api.counted.actions.n).toBe(api.rows.length);
  const csv = await (await page.request.get('/api/roles?format=csv')).text();
  expect(csv.split('\n')[0]).toMatch(/^action,method,path,roles,/);
  await gotoReady(page, '#/roles?lens=hybrid');
  await expect(page.locator('#rl-sheet h2')).toHaveText(/who may do what/i);
  if (api.rows.length) await expect(page.locator('.rl-table tbody tr')).toHaveCount(api.rows.length);
  else await expect(page.locator('#rl-sheet .set-note')).toContainText(/No role check/);
  await expect(page.locator('.rl-save a[download="farsight-roles.csv"]')).toHaveAttribute('href', /format=csv/);
  // reached from the front door's state of play
  await gotoReady(page, '#/journeys');
  await expect(page.locator('a.sop-roles')).toHaveAttribute('href', '#/roles');
});
