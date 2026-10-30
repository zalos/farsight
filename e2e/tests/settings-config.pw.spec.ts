// The Config files list on the Settings page (docs/proposals/round-2026-10-05.md §6): read only, over
// GET /api/config. Two halves:
//  - on the suite's fixture (invoice-app: one root config) — one row, the whole source, the settings it
//    gives by name in the code lens and in words in the business lens, the count with its tip;
//  - on the NX example this spec serves itself — four files (the root and three scoped to a folder),
//    the ignored root-only setting, the glossary conflict and the note, in words.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, gotoReady } from './support';
import { CLI, REPO_ROOT, makeWorkspace } from '../fixture/workspace.mjs';

async function openSettings(page: Page): Promise<void> {
  if (!(await page.locator('#gearbtn').isVisible())) await page.locator('#morebtn').click();
  await page.locator('#gearbtn').click();
  await expect(page.locator('#settings')).toHaveClass(/open/);
  await page.locator('.settings-rail a[href="#/settings/configuration"]').click();
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
  const sourceBlock = (page: Page) => page.locator('.cfg-src[data-repo="invoice-app"]');
  const otherBlock = (page: Page) => page.locator('.cfg-src[data-repo="other-app"]');
  const settings = () => JSON.parse(readFileSync(join(workspace.dir, '.farsight/settings.json'), 'utf8'));
  const sourceSettings = (id: string) => {
    const source = settings().sources.find((source: { id: string }) => source.id === id);
    // Sync updates its runtime status; the source's saved configuration must stay intact.
    delete source.status;
    return source;
  };
  let otherSettings: unknown;
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
    // The first settings entry is a decoy with the same candidate path. The
    // requested source also has an id that differs from its graph/repository name.
    mkdirSync(join(workspace.dir, 'other-app', 'docs'), { recursive: true });
    writeFileSync(join(workspace.dir, 'other-app', 'app.ts'), 'export const other = true;');
    writeFileSync(
      join(workspace.dir, 'other-app', 'docs', 'vendor-api.json'),
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Other vendor', version: '1' },
        paths: { '/other-vendor': { get: {} } },
      }),
    );
    const initial = settings();
    initial.sources[0].id = 'invoice-source-id';
    initial.sources.unshift({
      id: 'other-source-id',
      name: 'other-app',
      type: 'local',
      path: 'other-app',
      enabled: true,
    });
    writeFileSync(join(workspace.dir, '.farsight/settings.json'), JSON.stringify(initial));
    otherSettings = sourceSettings('other-source-id');
    execFileSync(process.execPath, [CLI, 'ingest', 'other-app', 'invoice-app', '--out', workspace.graph], {
      cwd: workspace.dir,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
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
    await page.goto(base + '#/settings/configuration?lens=code');
    await expect(page.locator('#stats')).not.toHaveText('loading…');
    await expect(sourceBlock(page).locator('.cfg-n-candidates')).toHaveText('2 candidate documents');
    await expect(otherBlock(page).locator('.cfg-n-candidates')).toHaveText('1 candidate document');
  }

  /**
   * @covers packages/server/public/app/surfaces/settings-config.js::renderConfigFiles
   * @covers packages/server/public/app/lib/read-only.js::applyReadOnly
   */
  test('read-only greys both candidate doors and prevents keyboard writes', async ({ page }) => {
    await open(page, readonly);
    const before = readFileSync(join(workspace.dir, '.farsight/settings.json'), 'utf8');
    const register = sourceBlock(page).locator('[data-openapi-action="register"]').first();
    const dismiss = sourceBlock(page).locator('[data-openapi-action="dismiss"]').first();
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
    const source = sourceBlock(page);
    const row = source.locator('.cfg-openapi-row[data-path="docs/vendor-api.json"]');
    await expect(row).toContainText('not registered');
    await source.locator('.cfg-n-candidates').scrollIntoViewIfNeeded();
    await expect(source.locator('.cfg-n-candidates')).toBeInViewport();
    await source.locator('.cfg-n-candidates').click();
    await expect(page.locator('#fs-tip')).toContainText('in this source');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: join(test.info().outputDir, 'openapi-candidates.png'), fullPage: true });
    await row.locator('[data-openapi-action="register"]').click();
    await expect(source.locator('.cfg-openapi-note')).toContainText('Saved.');
    expect(sourceSettings('invoice-source-id').openapi).toEqual([{ path: 'docs/vendor-api.json' }]);
    expect(sourceSettings('other-source-id')).toEqual(otherSettings);
    expect(
      JSON.parse(readFileSync(workspace.graph, 'utf8')).nodes.some(
        (n: { name: string }) => n.name === 'GET /vendor/vendor-api',
      ),
    ).toBe(false);
    await page.locator('#syncbtn').click();
    await expect(source.locator('.cfg-n-candidates')).toHaveText('1 candidate document');
    await expect(otherBlock(page).locator('.cfg-n-candidates')).toHaveText('1 candidate document');
    await expect(row).toContainText('registered in workspace');
    expect(
      JSON.parse(readFileSync(workspace.graph, 'utf8')).nodes.some(
        (n: { name: string }) => n.name === 'GET /vendor/vendor-api',
      ),
    ).toBe(true);
    expect(sourceSettings('other-source-id')).toEqual(otherSettings);
    expect(
      JSON.parse(readFileSync(workspace.graph, 'utf8')).nodes.some(
        (n: { name: string }) => n.name === 'GET /other-vendor',
      ),
    ).toBe(false);
  });

  test('Dismiss persists the ignored path and removes it after sync', async ({ page }) => {
    await page.goto(writable + '#/settings/configuration?lens=code');
    const source = sourceBlock(page);
    const row = source.locator('.cfg-openapi-row[data-path="docs/old-vendor.json"]');
    await row.locator('[data-openapi-action="dismiss"]').click();
    await expect(source.locator('.cfg-openapi-note')).toContainText('Saved.');
    expect(sourceSettings('invoice-source-id').openapiIgnore).toEqual(['docs/old-vendor.json']);
    await page.locator('#syncbtn').click();
    await expect(source.locator('.cfg-n-candidates')).toHaveText('0 candidate documents');
    await expect(row).toHaveCount(0);
    expect(sourceSettings('other-source-id')).toEqual(otherSettings);
    await expect(otherBlock(page).locator('.cfg-openapi-row[data-path="docs/vendor-api.json"]')).toContainText(
      'not registered',
    );
  });
});
