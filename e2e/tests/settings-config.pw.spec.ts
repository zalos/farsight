// The Config files list on the Settings page (docs/proposals/round-2026-10-05.md §6): read only, over
// GET /api/config. Two halves:
//  - on the suite's fixture (invoice-app: one root config) — one row, the whole source, the settings it
//    gives by name in the code lens and in words in the business lens, the count with its tip;
//  - on the NX example this spec serves itself — four files (the root and three scoped to a folder),
//    the ignored root-only setting, the glossary conflict and the note, in words.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';
import { CLI, REPO_ROOT, makeWorkspace, ingest } from '../fixture/workspace.mjs';

async function openSettings(page: Page): Promise<void> {
  if (!(await page.locator('#gearbtn').isVisible())) await page.locator('#morebtn').click();
  await page.locator('#gearbtn').click();
  await expect(page.locator('#settings')).toHaveClass(/open/);
  await expect(page.locator('#cfgrows .cfg-src').first()).toBeVisible();
}

test.describe('on the invoice-app fixture', () => {
  /**
   * @covers packages/server/public/app/surfaces/settings-config.js::configFilesHtml
   * @covers packages/server/public/app/surfaces/settings-config.js::renderConfigFiles
   * @covers GET /api/config
   */
  test('one root file: the whole source, its settings by name, the count with its tip', async ({ page }) => {
    await gotoReady(page, '#/journeys?lens=code');
    await openSettings(page);
    const src = page.locator('.cfg-src[data-repo="invoice-app"]');
    await expect(src.locator('.cfg-row')).toHaveCount(1);
    const row = src.locator('.cfg-row[data-path="farsight.config.json"]');
    await expect(row).toContainText('the whole source');
    await expect(row.locator('.cfg-gives code.cfg-field')).toContainText(['tests', 'externals', 'stores']);
    await expect(src.locator('.cfg-n-files')).toHaveText('1 config file');
    await expect(src.locator('.cfg-conflict')).toHaveCount(0);
    await src.locator('.cfg-n-files').click();
    await expect(page.locator('#fs-tip')).toContainText('in this source');
  });

  test('the business lens names the settings in words', async ({ page }) => {
    await gotoReady(page, '#/journeys?lens=business');
    await openSettings(page);
    const gives = page.locator('.cfg-row[data-path="farsight.config.json"] .cfg-gives');
    await expect(gives).toContainText('data stores');
    await expect(gives).toContainText('outside systems');
    await expect(gives.locator('code.cfg-field')).toHaveCount(0);
  });
});

// ── the NX example, served by this spec: three files scoped to a folder, a conflict and a note ──
let server: ChildProcess | null = null;
let base = '';
let dir = '';

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const p = typeof a === 'object' && a ? a.port : 0;
      s.close(() => res(p));
    });
  });
}

test.describe('on the NX example', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'farsight-e2e-config-'));
    cpSync(join(REPO_ROOT, 'examples', 'nx-workspace'), join(dir, 'nx-workspace'), { recursive: true });
    const graph = join(dir, 'graph.json');
    execFileSync(process.execPath, [CLI, 'ingest', 'nx-workspace', '--out', graph], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const port = await freePort();
    server = spawn(process.execPath, [CLI, 'serve', graph, '--port', String(port)], { cwd: dir, stdio: 'ignore' });
    base = `http://localhost:${port}/`;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + 'api/version')).ok) return;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the NX example server never answered');
  });
  test.afterAll(() => {
    if (server?.pid) server.kill('SIGTERM');
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * @covers packages/server/public/app/surfaces/settings-config.js::configFilesHtml
   * @covers GET /api/config
   */
  test('four files: the root and three scoped to a folder, the ignored setting, the conflict and the note', async ({
    page,
  }) => {
    await page.goto(base + '#/journeys?lens=hybrid');
    await expect(page.locator('#stats')).not.toHaveText('loading…');
    await openSettings(page);
    const src = page.locator('.cfg-src[data-repo="nx-workspace"]');
    await expect(src.locator('.cfg-row')).toHaveCount(4);
    await expect(src.locator('.cfg-n-files')).toHaveText('4 config files');
    await expect(src.locator('.cfg-n-conflicts')).toHaveText('1 conflict');
    await expect(src.locator('.cfg-row[data-path="libs/billing/data-access/farsight.config.json"]')).toContainText(
      'scoped to libs/billing/data-access/',
    );
    await expect(
      src.locator('.cfg-row[data-path="libs/billing/data-access/farsight.config.json"] .cfg-gives'),
    ).toContainText('stores');
    await expect(src.locator('.cfg-row[data-path="apps/ops-admin/farsight.config.json"] .cfg-ign')).toContainText(
      'tooling',
    );
    await expect(src.locator('.cfg-conflict[data-kind="glossary"]')).toContainText('Two words for InvoicesPage');
    await expect(src.locator('.cfg-note')).toContainText(['tooling is root-only']);
    // the count's tip splits it: one for the whole source, three for one folder
    await src.locator('.cfg-n-files').click();
    const tip = page.locator('#fs-tip');
    await expect(tip).toContainText('for the whole source');
    await expect(tip).toContainText('for one folder');
  });
});

// A private copy of the invoice fixture: no shared suite or dogfood source is changed.
test.describe('OpenAPI registration from Settings', () => {
  test.describe.configure({ mode: 'serial' });
  let workspace: ReturnType<typeof makeWorkspace>;
  const servers: ChildProcess[] = [];
  let writable = '';
  let readonly = '';
  test.beforeAll(async () => {
    workspace = makeWorkspace('openapi-config');
    for (const name of ['vendor-api', 'old-vendor'])
      writeFileSync(
        join(workspace.dir, 'invoice-app', 'docs', name + '.json'),
        JSON.stringify({
          openapi: '3.1.0',
          info: { title: name, version: '1.0' },
          paths: { ['/vendor/' + name]: { get: {} } },
        }),
      );
    ingest(workspace.dir, workspace.graph);
    for (const ro of [false, true]) {
      const port = await freePort();
      const child = spawn(
        process.execPath,
        [CLI, 'serve', workspace.graph, '--port', String(port), ...(ro ? ['--read-only'] : [])],
        { cwd: workspace.dir, stdio: 'ignore' },
      );
      servers.push(child);
      const base = `http://localhost:${port}/`;
      if (ro) readonly = base;
      else writable = base;
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(base + 'api/version')).ok) {
            ready = true;
            break;
          }
        } catch {
          /* startup */
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!ready) throw new Error('OpenAPI fixture server never answered');
    }
  });
  test.afterAll(() => {
    for (const child of servers) child.kill('SIGTERM');
    workspace?.cleanup();
  });
  async function open(page: Page, base: string) {
    await page.goto(base + '#/settings?lens=code');
    await expect(page.locator('#stats')).not.toHaveText('loading…');
    await expect(page.locator('.cfg-n-candidates')).toHaveText('2 candidate documents');
  }

  /**
   * @covers packages/server/public/app/surfaces/settings-config.js::renderConfigFiles
   * @covers packages/server/public/app/lib/read-only.js::applyReadOnly
   */
  test('read-only greys both candidate doors and prevents keyboard writes', async ({ page }) => {
    await open(page, readonly);
    const before = readFileSync(join(workspace.dir, '.farsight/settings.json'), 'utf8');
    const register = page.locator('[data-openapi-action="register"]').first();
    const dismiss = page.locator('[data-openapi-action="dismiss"]').first();
    for (const button of [register, dismiss]) {
      await expect(button).toHaveAttribute('data-write', '');
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(button).toHaveClass(/ro-off/);
      await button.focus();
      await button.press('Enter');
    }
    expect(readFileSync(join(workspace.dir, '.farsight/settings.json'), 'utf8')).toBe(before);
  });

  /**
   * @covers packages/server/public/app/surfaces/settings-config.js::renderConfigFiles
   * @covers GET /api/config
   * @covers POST /api/sync
   */
  test('Register saves the workspace declaration; Settings sync applies its routes and origin', async ({ page }) => {
    await open(page, writable);
    const row = page.locator('.cfg-openapi-row[data-path="docs/vendor-api.json"]');
    await expect(row).toContainText('not registered');
    await page.locator('.cfg-n-candidates').scrollIntoViewIfNeeded();
    await expect(page.locator('.cfg-n-candidates')).toBeInViewport();
    await page.locator('.cfg-n-candidates').click();
    await expect(page.locator('#fs-tip')).toContainText('in this source');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: join(test.info().outputDir, 'openapi-candidates.png'), fullPage: true });
    await row.locator('[data-openapi-action="register"]').click();
    await expect(page.locator('.cfg-openapi-note')).toContainText('Saved.');
    const settings = JSON.parse(readFileSync(join(workspace.dir, '.farsight/settings.json'), 'utf8'));
    expect(settings.sources[0].openapi).toEqual([{ path: 'docs/vendor-api.json' }]);
    expect(
      JSON.parse(readFileSync(workspace.graph, 'utf8')).nodes.some(
        (n: { name: string }) => n.name === 'GET /vendor/vendor-api',
      ),
    ).toBe(false);
    await page.locator('#syncbtn').click();
    await expect(page.locator('.cfg-n-candidates')).toHaveText('1 candidate document');
    await expect(row).toContainText('registered in workspace');
    expect(
      JSON.parse(readFileSync(workspace.graph, 'utf8')).nodes.some(
        (n: { name: string }) => n.name === 'GET /vendor/vendor-api',
      ),
    ).toBe(true);
  });

  test('Dismiss persists the ignored path and removes it after sync', async ({ page }) => {
    await page.goto(writable + '#/settings?lens=code');
    const row = page.locator('.cfg-openapi-row[data-path="docs/old-vendor.json"]');
    await row.locator('[data-openapi-action="dismiss"]').click();
    await expect(page.locator('.cfg-openapi-note')).toContainText('Saved.');
    expect(
      JSON.parse(readFileSync(join(workspace.dir, '.farsight/settings.json'), 'utf8')).sources[0].openapiIgnore,
    ).toEqual(['docs/old-vendor.json']);
    await page.locator('#syncbtn').click();
    await expect(page.locator('.cfg-n-candidates')).toHaveText('0 candidate documents');
    await expect(row).toHaveCount(0);
  });
});
