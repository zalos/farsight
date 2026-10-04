// The code map grouped and filtered by project and tag, packages drawn, and the two views
// (docs/proposals/dependencies-and-nx.md §2.3). Two halves:
//  - on the suite's fixture (invoice-app alone: one project, no tags, eight packages) — packages
//    are drawn, the GROUP control offers no dimension the graph does not have, *depends on zod*
//    keeps only what imports zod, and *Where is zod included* is two clicks from the map;
//  - on a two-source workspace this spec serves itself (invoice-app + the NX example ingested into
//    one graph, on a free port) — group by project / domain / type, *App and its related* for
//    billing-web with its labelled arrows, *Where is shared-util included* by link, and the Map
//    banded by domain.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { test, expect, gotoReady } from './support';
import { CLI, makeProjectsWorkspace } from '../fixture/workspace.mjs';

const zod = 'invoice-app::package::zod';

test.describe('on the invoice-app fixture', () => {
  test('packages are drawn as their own kind, third-party and workspace told apart', async ({ page }) => {
    await gotoReady(page, '#/codemap?group=none');
    const card = page.locator('#nd-' + zod.replace(/[^a-zA-Z0-9_-]/g, '_'));
    await expect(card).toBeVisible();
    await expect(card).toHaveClass(/nk-package/);
    await expect(card).toHaveClass(/pkg-tp/);
    await expect(card.locator('.kind')).toContainText('third-party');
    await expect(page.locator('.node.nk-package.pkg-ws')).toHaveCount(1);
    // files stay off the map until asked for
    await expect(page.locator('.node.nk-module')).toHaveCount(0);
    await page.locator('#cm-files').click();
    await expect(page.locator('.node.nk-module').first()).toBeVisible();
    // hide packages takes them off, and the status bar's tip says so
    await page.locator('#cm-hidepkg').click();
    await expect(page.locator('.node.nk-package')).toHaveCount(0);
  });

  test('the GROUP control offers only what the graph has: no domain or type on an untagged source', async ({ page }) => {
    await gotoReady(page, '#/codemap');
    const opts = await page.locator('#cm-group option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(opts).toEqual(['none', 'project']);
  });

  test('depends on zod keeps what imports or uses zod, and zod', async ({ page }) => {
    await gotoReady(page, '#/codemap?group=none');
    await page.locator('#scopebtn').click();
    // Depends on is a searchable single-select picker: type, Enter
    await page.locator('[data-mp="cm-pick-dep"] .mpk-q').fill('zod');
    await page.keyboard.press('Enter');
    await expect(page.locator('#cm-filtered')).toBeVisible();
    const names = await page.locator('#stage .node .codename').allTextContents();
    expect(names.sort()).toEqual(['appEnvSchema', 'draftInvoiceSchema', 'updateInvoiceSchema', 'zod'].sort());
    await page.keyboard.press('Escape');
    await page.locator('#cm-filtered').click();
    await expect(page.locator('#stage .node').nth(10)).toBeVisible();
  });

  test('Where is zod included: the package card, then its action — every importer by project', async ({ page }) => {
    await gotoReady(page, '#/codemap?group=none');
    await page.locator('#nd-' + zod.replace(/[^a-zA-Z0-9_-]/g, '_')).click();
    await expect(page.locator('#cm-pkgsec')).toContainText('^3.23.8');
    await page.locator('#cm-where').click();
    await expect(page.locator('#cm-viewchip')).toContainText('Where is zod included');
    await expect(page).toHaveURL(/view=package&package=/);
    const imps = await page.locator('#inspector .cm-imp').allTextContents();
    expect(imps.map((s) => s.replace(/^zod/, ''))).toEqual(['src/server/config/env.ts:1', 'src/server/schemas.ts:1']);
    await page.locator('#cm-viewchip').click();
    await expect(page.locator('#cm-viewchip')).toHaveCount(0);
  });
});

// ── a two-source workspace with projects and tags, served by this spec ──
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

test.describe('on invoice-app and the NX example together', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async () => {
    const ws = makeProjectsWorkspace();
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

  const go = async (page: import('@playwright/test').Page, hash: string) => {
    await page.goto(base + hash);
    await expect(page.locator('#stats')).not.toHaveText('loading…');
  };
  const titles = (page: import('@playwright/test').Page) => page.locator('.cm-box .gname').allTextContents();

  test('group by project, by domain, by type — one box per value, the catch-alls last', async ({ page }) => {
    await go(page, '#/codemap?group=project&lens=hybrid');
    expect(await page.locator('#cm-group option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).toEqual(['none', 'project', 'domain', 'type']);
    expect(await titles(page)).toContain('billing-web');
    await page.locator('#cm-group').selectOption('domain');
    await expect(page).toHaveURL(/group=domain/);
    expect(await titles(page)).toEqual(['Billing', 'Operations', 'Shared', 'no tag', 'no project', 'third-party packages']);
    await page.locator('#cm-group').selectOption('type');
    expect((await titles(page)).slice(0, 5)).toEqual(['Application', 'Data access', 'Feature', 'UI', 'Utility']);
    // a box's count is its cards, split by kind
    const billing = page.locator('.cm-box', { hasText: 'Data access' }).first();
    await expect(billing.locator('.cm-chip')).toHaveText('5 parts shown');
  });

  test('App and its related: two clicks from the map, the closure in boxes with labelled arrows', async ({ page }) => {
    await go(page, '#/codemap?group=none&lens=hybrid');
    await page.locator('#cm-viewsbtn').click();
    await page.locator('#cm-viewsmenu .mpk-opt', { hasText: 'billing-web' }).first().click();
    await expect(page).toHaveURL(/view=app&project=billing-web/);
    await expect(page.locator('.cm-elabel').first()).toBeVisible();
    const boxes = (await titles(page)).filter((x) => x !== 'third-party packages').sort();
    expect(boxes).toEqual(['@nxw/shared-ui', 'billing-data-access', 'billing-feature-invoices', 'billing-ui', 'billing-web', 'shared-util']);
    expect(await page.locator('.cm-elabel').allTextContents()).toContain('1 import statement');
    // the inspector is the application's project, with what it depends on
    await expect(page.locator('#inspector h2')).toHaveText('billing-web');
    await expect(page.locator('#inspector')).toContainText('5 projects it depends on');
    await expect(page.locator('.cm-box .gname', { hasText: 'ops-admin' })).toHaveCount(0);
  });

  test('Where is shared-util included, by link: its importers grouped by project', async ({ page }) => {
    await go(page, '#/codemap?view=package&package=' + encodeURIComponent('nx-workspace::package::@nxw/shared/util'));
    await expect(page.locator('#cm-viewchip')).toContainText('@nxw/shared/util');
    expect((await titles(page)).sort()).toEqual(['billing-ui', 'billing-web', 'ops-admin']);
    await expect(page.locator('#inspector .cm-whead')).toHaveCount(3);
  });

  test('a project box opens its inspector; Show app and its related goes there', async ({ page }) => {
    await go(page, '#/codemap?group=project&lens=hybrid');
    await page.locator('.cm-box .gname', { hasText: /^ops-admin$/ }).click();
    await expect(page.locator('#inspector h2')).toHaveText('ops-admin');
    await page.locator('#cm-showapp').click();
    await expect(page).toHaveURL(/view=app&project=ops-admin/);
  });

  test('the Map bands by domain when asked, and says no domain for the rest', async ({ page }) => {
    await go(page, '#/map?lens=hybrid');
    // at 1440 px Band by is folded to its current value, the choices in its menu
    await page.locator('.map-band-cur').click();
    await page.locator('[data-act="band"][data-band="domain"]').click();
    await expect(page.locator('.map-band.dom .w')).toHaveText(['Billing', 'Operations', 'no domain']);
    await page.locator('.map-band-cur').click();
    await page.locator('[data-act="band"][data-band="source"]').click();
    await expect(page.locator('.map-band.dom')).toHaveCount(0);
  });
});
