// What an agent gets, in the HUD (round 2026-10-10, proposal 9): every record carries *copy as MCP call · curl ·
// CLI* with its full id (the gate card, the code map inspector, the front door's numbers), a press shows a
// *copied* chip for two seconds, the business register draws none; the Settings page holds the owner's
// lessons for agents and refuses one shaped like a credential before it is sent; an empty surface names what
// fills it.
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';

const FLOW = 'invoice-app::flow::billing-cycle';
const GATE = 'invoice-app::guard::requireScope(billing:read)';
const enc = encodeURIComponent;

async function openGate(page: Page, lens: string) {
  // a journey's gates are read on the Map's table (the journey page retired into it)
  await gotoReady(page, '#/map/' + enc(FLOW) + '?layout=table&lens=' + lens);
  await page
    .locator('.map-table .jrn-gl-row[data-gate-card="' + GATE + '"]')
    .first()
    .locator('.jrn-gl-w')
    .click();
  const c = page.locator('.fs-tip .gc[data-gc="' + GATE + '"]');
  await expect(c).toBeVisible();
  return c;
}

/**
 * @covers packages/server/public/app/lib/copy-doors.js::copyDoors
 * @covers packages/server/public/app/lib/detail-doors.js::copyDoorsHtml
 * @covers packages/server/public/app/lib/gate-card.js::gateCardHtml
 */
test('the gate card copies the MCP call, the curl and the CLI line with the full id, and says copied for two seconds', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const c = await openGate(page, 'hybrid');
  const row = c.locator('.gc-copy .dd-copy');
  await expect(row.locator('button.dd-door.copy')).toHaveText(['copy as MCP call', 'copy as curl', 'copy as CLI']);
  await row.locator('button[data-via="mcp"]').click();
  const chip = row.locator('.dd-copied');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText(`copied gate {"node_id":"${GATE}"}`);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`gate {"node_id":"${GATE}"}`);
  await expect(row.locator('button[data-via="curl"]')).toHaveAttribute(
    'data-copy',
    new RegExp(`/api/gate\\?node=${enc(GATE).replace(/[()]/g, '\\$&')}'$`),
  );
  await expect(row.locator('button[data-via="cli"]')).toHaveAttribute('data-copy', `farsight impact '${GATE}' --tests`);
  await expect(chip).toBeHidden({ timeout: 4000 });
});

/** @covers packages/server/public/app/lib/detail-doors.js::copyDoorsHtml */
test("the business register draws no copy doors: MCP, curl and CLI are a developer's (swarm round 3)", async ({
  page,
}) => {
  const c = await openGate(page, 'business');
  await expect(c.locator('.gc-head, .gc-h, h3, .gc').first()).toBeVisible();
  await expect(c.locator('button.dd-door.copy')).toHaveCount(0);
});

/** @covers packages/server/public/app/lib/graph-render.js::select */
test('the code map inspector carries the copy doors of the selected part', async ({ page }) => {
  await gotoReady(page, '#/codemap?node=' + enc(GATE) + '&lens=code');
  const row = page.locator('#inspector .insp-copy .dd-copy');
  await expect(row.locator('button[data-via="mcp"]')).toHaveAttribute('data-copy', `gate {"node_id":"${GATE}"}`);
});

/** @covers packages/server/public/app/lib/state-of-play.js::stateOfPlayHtml */
test("the front door's numbers copy their re-check as an MCP call, a curl and a CLI line", async ({ page }) => {
  await gotoReady(page, '#/journeys?lens=hybrid');
  const first = page.locator('#sop-card .sop-col li .dd-copy.compact').first();
  await expect(first.locator('button')).toHaveText(['MCP', 'curl', 'CLI']);
  await expect(first.locator('button[data-via="cli"]')).toHaveAttribute('data-copy', /^farsight /);
});

async function openSettings(page: Page): Promise<void> {
  if (!(await page.locator('#gearbtn').isVisible())) await page.locator('#morebtn').click();
  await page.locator('#gearbtn').click();
  await expect(page.locator('#settings')).toHaveClass(/open/);
  await page.locator('.settings-rail a[href="#/settings/agents"]').click();
}

/**
 * @covers packages/server/public/app/surfaces/settings-agents.js::renderAgents
 * @covers packages/server/src/index.ts::lessonsProblem
 */
test('Settings: lessons for agents — the empty state, a lesson added and pinned, a credential refused (here and by the server)', async ({
  page,
  request,
}) => {
  await gotoReady(page, '#/journeys?lens=hybrid');
  await openSettings(page);
  const sec = page.locator('#set-lessons');
  await expect(sec.locator('#set-lessons-title')).toHaveText('Lessons for agents');
  await expect(sec).toContainText('No lessons yet.');
  await sec.locator('[data-row-action="add"]').click();
  const text = sec.locator('[data-field="lessons[0].text"]');
  await text.fill('use keychain:farsight/jira-example for the tracker');
  await expect(sec.locator('[data-problem-for="lessons[0].text"]')).toContainText('looks like a credential');
  await expect(page.locator('#savebtn')).toBeDisabled();
  await text.fill('The e2e card is Playwright; the unit card is node:test.');
  await expect(page.locator('#savebtn')).toBeEnabled();
  await expect(sec.locator('[data-row]')).toHaveCount(1);
  await expect(text).toHaveValue('The e2e card is Playwright; the unit card is node:test.');
  await expect(sec.locator('[data-field="lessons[0].pinned"]')).toBeChecked();
  await expect(sec.locator('#lessons-count')).toHaveText('1 lesson · 1 pinned');
  await sec.locator('[data-row-action="remove"]').click();
  await expect(sec.locator('[data-row]')).toHaveCount(0);
  // the server refuses the same shape without echoing it — nothing is written
  const current = await (await request.get('/api/settings')).json();
  const bad = await request.put('/api/settings', {
    data: { ...current, lessons: [{ text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' }] },
  });
  expect(bad.status()).toBe(400);
  expect(await bad.text()).not.toContain('ghp_');
});
