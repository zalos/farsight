// The code map toolbar's Projects menu: the project picker and an application's tree one chip
// away, not only inside the scope menu and the Views menu. On a two-source workspace this spec
// serves itself (invoice-app + the NX example ingested into one graph, on a free port): the chip
// opens the menu, typing narrows, two picks filter the map and write ?project= (the same filter as
// the scope menu's), the kind chips narrow the list's groups, and Focus on an application draws the
// application and the projects it depends on.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { test, expect } from './support';
import { CLI, makeProjectsWorkspace } from '../fixture/workspace.mjs';

let server: ChildProcess | null = null;
let base = '';
let cleanup: (() => void) | null = null;

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => res(p)); });
  });
}

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  const ws = makeProjectsWorkspace('toolbar');
  cleanup = ws.cleanup;
  const port = await freePort();
  server = spawn(process.execPath, [CLI, 'serve', ws.graph, '--port', String(port)], { cwd: ws.dir, stdio: 'ignore' });
  base = `http://localhost:${port}/`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + 'api/version')).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the projects workspace server never answered');
});
test.afterAll(() => {
  if (server?.pid) server.kill('SIGTERM');
  if (cleanup) cleanup();
});

type Page = import('@playwright/test').Page;
const go = async (page: Page, hash: string) => {
  await page.goto(base + hash);
  await expect(page.locator('#stats')).not.toHaveText('loading…');
};
const bar = (page: Page) => page.locator('[data-mp="cm-pick-proj-bar"]');
const titles = (page: Page) => page.locator('.cm-box .gname').allTextContents();

test('the Projects chip opens a picker; typing narrows; two picks filter the map and write ?project=', async ({ page }) => {
  await go(page, '#/codemap?group=project&lens=hybrid');
  const btn = page.locator('#cm-projbtn');
  await expect(btn).toHaveText(/^Projects/);
  await expect(btn).toHaveAttribute('aria-haspopup', 'true');
  await btn.click();
  await expect(page.locator('#cm-projmenu')).toHaveClass(/open/);
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  const p = bar(page);
  await expect(p.locator('.mpk-q')).toBeFocused();
  await expect(p.locator('.mpk-count')).toHaveText('9 of 9 projects');
  await p.locator('.mpk-q').fill('ops');
  await expect(p.locator('.mpk-opt .mpk-word')).toHaveText(['ops-admin']);
  await page.keyboard.press('Enter');
  await p.locator('.mpk-q').fill('shared-util');
  await p.locator('.mpk-opt', { hasText: 'shared-util' }).click();
  await expect(page).toHaveURL(/project=ops-admin,shared-util/);
  // the menu stays open across the redraw, the chip counts the picks
  await expect(page.locator('#cm-projmenu')).toHaveClass(/open/);
  await expect(page.locator('#cm-projbtn')).toHaveText(/Projects · 2/);
  const boxes = await titles(page);
  expect(boxes).toContain('ops-admin');
  expect(boxes).toContain('shared-util');
  expect(boxes).not.toContain('billing-web');
  // the same filter as the scope menu's picker
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('#cm-projmenu')).not.toHaveClass(/open/);
  await page.locator('#scopebtn').click();
  await expect(page.locator('[data-mp="cm-pick-proj"] .mpk-chip')).toHaveText(['ops-admin✕', 'shared-util✕']);
  await page.keyboard.press('Escape');
  await page.locator('#cm-filtered').click();
  await expect(page).not.toHaveURL(/project=/);
});

test('the kind chips narrow the list to applications, libraries and the rest', async ({ page }) => {
  await go(page, '#/codemap?group=project&lens=hybrid');
  await page.locator('#cm-projbtn').click();
  const p = bar(page);
  await expect(p.locator('.mpk-gh')).toHaveText(['Applications', 'Libraries', 'End-to-end tests', 'Other projects']);
  const kinds = page.locator('#cm-projmenu .cm-type');
  await expect(kinds).toHaveText(['Applications', 'Libraries', 'End-to-end tests', 'Other projects']);
  await kinds.filter({ hasText: 'Applications' }).click();
  await expect(p.locator('.mpk-gh')).toHaveText(['Applications']);
  await expect(p.locator('.mpk-count')).toHaveText('2 of 2 projects');
  await kinds.filter({ hasText: 'Libraries' }).click();
  await expect(p.locator('.mpk-gh')).toHaveText(['Applications', 'Libraries']);
  await expect(kinds.filter({ hasText: 'Libraries' })).toHaveAttribute('aria-pressed', 'true');
  await kinds.filter({ hasText: 'Applications' }).click();
  await kinds.filter({ hasText: 'Libraries' }).click();
  await expect(p.locator('.mpk-count')).toHaveText('9 of 9 projects');
  // a click outside closes it
  await page.locator('#stage').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('#cm-projmenu')).not.toHaveClass(/open/);
});

test('Focus on an application draws it and the projects it depends on', async ({ page }) => {
  await go(page, '#/codemap?group=none&lens=hybrid');
  await page.locator('#cm-projbtn').click();
  const app = page.locator('[data-mp="cm-pick-app-bar"]');
  await expect(app.locator('.mpk-gh').first()).toHaveText('Applications');
  expect(await app.locator('.mpk-list').getAttribute('aria-multiselectable')).toBeNull();
  await app.locator('.mpk-q').fill('billing-web');
  await app.locator('.mpk-opt', { hasText: 'billing-web' }).first().click();
  await expect(page).toHaveURL(/view=app&project=billing-web/);
  await expect(page.locator('#cm-projmenu')).not.toHaveClass(/open/);
  await expect(page.locator('#cm-viewchip')).toContainText('billing-web');
  const boxes = (await titles(page)).filter((x) => x !== 'third-party packages').sort();
  expect(boxes).toEqual(['@nxw/shared-ui', 'billing-data-access', 'billing-feature-invoices', 'billing-ui', 'billing-web', 'shared-util']);
  await expect(page.locator('.cm-elabel').first()).toBeVisible();
  // the application's column is the first: its box stands left of every other project's
  const xs = await page.locator('.cm-box.cm-project').evaluateAll((els) => els.map((e) => ({ name: e.querySelector('.gname')?.textContent, x: (e as HTMLElement).offsetLeft })));
  const root = xs.find((b) => b.name === 'billing-web')!;
  for (const b of xs) if (b.name !== 'billing-web') expect(b.x).toBeGreaterThan(root.x);
});
