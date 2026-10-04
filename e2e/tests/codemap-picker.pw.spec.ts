// The project picker (lib/multi-pick.js): one searchable list wherever a project is picked —
// the scope menu's Projects, Tags and Depends on, the Views menu's App and its related and Where
// is a package included, and fast travel. On a two-source workspace this spec serves itself
// (invoice-app + the NX example ingested into one graph, on a free port): nine projects, two
// applications, five libraries, one end-to-end project and one untyped whole source.
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
  const ws = makeProjectsWorkspace('picker');
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
const proj = (page: Page) => page.locator('[data-mp="cm-pick-proj"]');
const titles = (page: Page) => page.locator('.cm-box .gname').allTextContents();

test('typing narrows the list, applications above libraries, the match count in words', async ({ page }) => {
  await go(page, '#/codemap?group=project&lens=hybrid');
  await page.locator('#scopebtn').click();
  const p = proj(page);
  await expect(p.locator('.mpk-list')).toHaveAttribute('aria-multiselectable', 'true');
  await expect(p.locator('.mpk-gh')).toHaveText(['Applications', 'Libraries', 'End-to-end tests', 'Other projects']);
  await expect(p.locator('.mpk-count')).toHaveText('9 of 9 projects');
  await p.locator('.mpk-q').fill('bill');
  await expect(p.locator('.mpk-count')).toHaveText('5 of 9 projects');
  await expect(p.locator('.mpk-gh')).toHaveText(['Applications', 'Libraries', 'End-to-end tests']);
  await expect(p.locator('.mpk-opt .mpk-word')).toHaveText(['billing-web', 'billing-data-access', 'billing-feature-invoices', 'billing-ui', 'billing-web-e2e']);
  // a tag word finds what the name does not: Operations is ops-admin's domain
  await p.locator('.mpk-q').fill('operations');
  await expect(p.locator('.mpk-opt .mpk-word')).toHaveText(['ops-admin']);
  // each option carries its type and tag words, and its parts of the code
  await expect(p.locator('.mpk-opt .mpk-sub')).toHaveText(/application · Operations/);
  await p.locator('.mpk-q').fill('zzz');
  await expect(p.locator('.mpk-none')).toHaveText('nothing matches');
  // Esc clears the words first; the menu stays open
  await page.keyboard.press('Escape');
  await expect(p.locator('.mpk-q')).toHaveValue('');
  await expect(page.locator('#scopemenu')).toHaveClass(/open/);
});

test('two projects picked filter the map and write ?project=; chips remove them', async ({ page }) => {
  await go(page, '#/codemap?group=project&lens=hybrid');
  await page.locator('#scopebtn').click();
  const p = proj(page);
  await p.locator('.mpk-opt', { hasText: 'ops-admin' }).click();
  await p.locator('.mpk-opt', { hasText: 'shared-util' }).click();
  await expect(page).toHaveURL(/project=ops-admin,shared-util/);
  await expect(p.locator('.mpk-chip')).toHaveText(['ops-admin✕', 'shared-util✕']);
  const boxes = await titles(page);
  expect(boxes).toContain('ops-admin');
  expect(boxes).toContain('shared-util');
  expect(boxes).not.toContain('billing-web');
  expect(boxes).not.toContain('invoice-app');
  // the toolbar shows them too, each a way to drop it
  await expect(page.locator('#cmapctl .cm-fchip')).toHaveText(['ops-admin ✕', 'shared-util ✕']);
  await p.locator('.mpk-chip', { hasText: 'ops-admin' }).click();
  await expect(page).toHaveURL(/project=shared-util(?!,)/);
  await page.keyboard.press('Escape');
  await page.locator('#cmapctl .cm-fchip', { hasText: 'shared-util' }).click();
  await expect(page.locator('#cm-filtered')).toHaveCount(0);
  await expect(page).not.toHaveURL(/project=/);
  expect(await titles(page)).toContain('billing-web');
});

test('the link restores the filters, and they are kept for the next visit', async ({ page }) => {
  await go(page, '#/codemap?group=project&lens=hybrid&project=billing-web&tag=domain:billing');
  await expect(page.locator('#cm-filtered')).toBeVisible();
  await expect(page.locator('#cmapctl .cm-fchip')).toHaveText(['billing-web ✕', 'Billing ✕']);
  expect(await titles(page)).not.toContain('ops-admin');
  // a plain link next time keeps what was picked, and writes it back
  await page.goto(base + '#/codemap?group=project&lens=hybrid');
  await page.reload();
  await expect(page.locator('#stats')).not.toHaveText('loading…');
  await expect(page.locator('#cmapctl .cm-fchip')).toHaveText(['billing-web ✕', 'Billing ✕']);
  await expect(page).toHaveURL(/project=billing-web&tag=domain:billing/);
  await page.locator('#cm-filtered').click();
  await expect(page).not.toHaveURL(/project=/);
});

test('keyboard only: find, arrow, Space, Enter, Command A; chips fold past six', async ({ page }) => {
  await go(page, '#/codemap?group=project&lens=hybrid');
  await page.locator('#scopebtn').click();
  const p = proj(page);
  await p.locator('.mpk-q').focus();
  await page.keyboard.type('billing');
  await page.keyboard.press('ArrowDown');
  await expect(p.locator('.mpk-opt.hot .mpk-word')).toHaveText('billing-web');
  await expect(p.locator('.mpk-q')).toHaveAttribute('aria-activedescendant', /billing-web/);
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(p.locator('.mpk-opt[aria-selected="true"] .mpk-word')).toHaveText(['billing-web', 'billing-data-access']);
  await expect(p.locator('.mpk-q')).toBeFocused();
  // Command A picks every option shown; past six the chips fold into +n
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+a');
  await expect(p.locator('.mpk-opt[aria-selected="true"]')).toHaveCount(9);
  await expect(p.locator('.mpk-chip:not(.mpk-more)')).toHaveCount(6);
  await expect(p.locator('.mpk-more')).toHaveText('+3');
  await p.locator('.mpk-more').click();
  await expect(p.locator('.mpk-chip:not(.mpk-more)')).toHaveCount(9);
  await p.locator('.mpk-act[data-mp-act="clear"]').click();
  await expect(p.locator('.mpk-chip')).toHaveCount(0);
});

test('the tag lists are one picker grouped by dimension', async ({ page }) => {
  await go(page, '#/codemap?group=project&lens=hybrid');
  await page.locator('#scopebtn').click();
  const tags = page.locator('[data-mp="cm-pick-tags"]');
  await expect(tags.locator('.mpk-gh')).toHaveText(['Domain', 'Type']);
  await tags.locator('.mpk-q').fill('oper');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/tag=domain:ops/);
  const boxes = await titles(page);
  expect(boxes).toContain('ops-admin');
  expect(boxes).not.toContain('billing-web');
});

test('App and its related is single-select: one pick opens the view', async ({ page }) => {
  await go(page, '#/codemap?group=none&lens=hybrid');
  await page.locator('#cm-viewsbtn').click();
  const app = page.locator('[data-mp="cm-pick-app"]');
  await expect(app.locator('.mpk-q')).toBeFocused();
  expect(await app.locator('.mpk-list').getAttribute('aria-multiselectable')).toBeNull();
  await expect(app.locator('.mpk-box')).toHaveCount(0);
  await expect(app.locator('.mpk-gh').first()).toHaveText('Applications');
  await expect(page.locator('[data-mp="cm-pick-pkg"] .mpk-gh')).toHaveText(['From this workspace', 'Third-party']);
  await page.keyboard.type('ops');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/view=app&project=ops-admin/);
  await expect(page.locator('#cm-viewsmenu')).not.toHaveClass(/open/);
  await expect(page.locator('#cm-viewchip')).toContainText('ops-admin');
});

test('fast travel to a project lands on the code map grouped by project, its box in view', async ({ page }) => {
  await go(page, '#/portfolio?lens=hybrid');
  await page.keyboard.press('ControlOrMeta+k');
  await page.locator('#pinput').fill('ops-admin');
  const row = page.locator('#presults .presult-project').first();
  await expect(row).toContainText('project');
  await expect(row).toContainText('ops-admin');
  await expect(row).toContainText('code map, by project');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/codemap\?group=project&box=ops-admin/);
  await expect(page.locator('#cm-group')).toHaveValue('project');
  const box = page.locator('.cm-box.cm-arrived');
  await expect(box.locator('.gname')).toHaveText('ops-admin');
  await expect(box).toBeInViewport();
  await expect(page.locator('#inspector h2')).toHaveText('ops-admin');
});

test('at equal score fast travel lists the application above the library', async ({ page }) => {
  await go(page, '#/codemap?lens=hybrid');
  await page.keyboard.press('ControlOrMeta+k');
  await page.locator('#pinput').fill('billing');
  const projects = await page.locator('#presults .presult-project .pname').allTextContents();
  expect(projects[0]).toContain('billing-web');
});
