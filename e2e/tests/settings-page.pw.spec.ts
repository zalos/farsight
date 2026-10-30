// The real Settings page on a private two-source workspace, including concurrent writers.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './support';
import { CLI, makeProjectsWorkspace } from '../fixture/workspace.mjs';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

test.describe('sectioned Settings', () => {
  test.describe.configure({ mode: 'serial' });
  let workspace: ReturnType<typeof makeProjectsWorkspace>;
  let initial: string;
  let writable = '';
  let readonly = '';
  const servers: ChildProcess[] = [];
  const file = () => join(workspace.dir, '.farsight/settings.json');
  const settings = () => JSON.parse(readFileSync(file(), 'utf8'));
  test.beforeAll(async () => {
    workspace = makeProjectsWorkspace('settings-page');
    initial = readFileSync(file(), 'utf8');
    writeFileSync(
      join(workspace.dir, 'invoice-app/docs/concurrent.json'),
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Concurrent API', version: '1' },
        paths: { '/concurrent': { get: {} } },
      }),
    );
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
          /* starting */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!ready) throw new Error('Settings fixture server did not start');
    }
  });
  test.beforeEach(() => writeFileSync(file(), initial));
  test.afterAll(() => {
    for (const server of servers) server.kill('SIGTERM');
    workspace?.cleanup();
  });

  /** @covers packages/server/public/app/surfaces/settings.js::mountSettings */
  for (const section of ['workspace', 'sources', 'collections', 'configuration', 'agents']) {
    for (const register of ['hud', 'professional']) {
      for (const theme of ['dark', 'light']) {
        for (const ro of [false, true]) {
          test(`${section}, ${register}, ${theme}, ${ro ? 'read-only' : 'writable'}: fits 1280px and renders without errors`, async ({
            page,
          }, info) => {
            await page.setViewportSize({ width: 1280, height: 900 });
            await page.addInitScript((value) => localStorage.setItem('fs-register', value), register);
            const before = settings();
            before.theme = theme;
            if (ro) {
              before.collections = [{ name: 'Billing', sourceIds: ['invoice-app'] }];
              before.lessons = [{ text: 'Read the gates', pinned: true }];
            }
            writeFileSync(file(), JSON.stringify(before));
            await page.goto(
              (ro ? readonly : writable) +
                `#/settings/${section}?lens=${register === 'professional' ? 'business' : 'code'}`,
            );
            await expect(page.locator('.settings-rail [aria-current]')).toHaveAttribute(
              'href',
              '#/settings/' + section,
            );
            await expect(page.locator('#settings-section-title')).toBeVisible();
            if (section === 'configuration') await expect(page.locator('.cfg-src').first()).toBeVisible();
            await expect(page.locator('#settings-savebar')).toBeHidden();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            expect(
              await page.locator('.settings-content').evaluate((el) => el.getBoundingClientRect().width),
            ).toBeLessThanOrEqual(880);
            await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
            await expect(page.locator('.settings-rail a')).toHaveText(
              register === 'professional'
                ? ['Workspace', 'Systems', 'Collections', 'What the code means', 'Agents']
                : ['Workspace', 'Sources', 'Collections', 'Source configuration', 'Agents'],
            );
            await page.screenshot({
              path: info.outputPath(`${section}-${register}-${theme}-${ro ? 'readonly' : 'writable'}.png`),
              fullPage: true,
            });
          });
        }
      }
    }
  }

  /**
   * @covers packages/server/public/app/surfaces/settings.js::saveSettings
   * @covers packages/server/public/app/lib/settings-model.js::mergeSettings
   * @covers POST /api/settings/check
   */
  test('one draft spans sections; save retains a concurrent OpenAPI registration and untouched source', async ({
    page,
    request,
  }) => {
    await page.goto(writable + '#/settings/workspace');
    await page.locator('#set-theme').selectOption('light');
    await expect(page.locator('#settings-savebar')).toBeVisible();
    await page.locator('.settings-rail a[href="#/settings/agents"]').click();
    await page.locator('[data-field="mcp.budget"]').fill('400');
    await expect(page.locator('[data-problem-for="mcp.budget"]')).toHaveText(
      'settings.mcp.budget must be a whole number of tokens, 500 or more',
    );
    await expect(page.locator('#savebtn')).toBeDisabled();
    await expect(page.locator('#settings-check')).toHaveText('');
    await page.locator('.settings-rail a[href="#/settings/sources"]').click();
    await expect(page.locator('#settings-check')).toHaveText(
      'settings.mcp.budget must be a whole number of tokens, 500 or more',
    );
    await expect(page.locator('#settings-check')).toBeInViewport();
    await page.locator('.settings-rail a[href="#/settings/agents"]').click();
    await page.locator('[data-field="mcp.budget"]').fill('1200');
    const registration = await request.post(writable + 'api/sources/invoice-app/openapi', {
      data: { path: 'docs/concurrent.json' },
    });
    expect(registration.ok()).toBe(true);
    const other = settings().sources[1];
    await expect(page.locator('#savebtn')).toBeEnabled();
    await page.locator('#savebtn').click();
    await expect(page.locator('#savenote')).toHaveText('Saved.');
    const saved = settings();
    expect(saved.theme).toBe('light');
    expect(saved.mcp.budget).toBe(1200);
    expect(saved.sources[0].openapi).toEqual([{ path: 'docs/concurrent.json' }]);
    expect(saved.sources[1]).toEqual(other);
    await expect(page.locator('#settings-draft-actions')).toBeHidden();
    await expect(page.locator('#savenote')).toBeInViewport();
    await page.reload();
    await expect(page.locator('[data-field="mcp.budget"]')).toHaveValue('1200');
  });

  /** @covers packages/server/public/app/surfaces/settings-sources.js::renderSources */
  test('work source form refuses a literal secret before any request and saves a reference with permissions', async ({
    page,
  }, info) => {
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.postData() || ''));
    await page.goto(writable + '#/settings/sources');
    await page.locator('#source-add').click();
    await page.locator('#source-add-type').selectOption('work');
    await page.locator('[data-source-create]').click();
    const card = page.locator('.settings-source').last();
    await card.locator('[data-field$=".name"]').fill('Work example');
    await card.locator('[data-field$=".site"]').fill('https://example.atlassian.net');
    await card.locator('[data-field$=".scope.projects"]').fill('EXAMPLE');
    const secret = card.locator('[data-field$=".auth.secret"]');
    const pasted = 'do-not-send-this-pasted-credential';
    await secret.fill(pasted);
    await expect(secret).toHaveValue('');
    await expect(card.locator('[data-problem-for$=".auth.secret"]')).toHaveText(
      'sources[2].auth.secret must be a keychain: or env: reference — secrets never go in settings',
    );
    expect(await page.content()).not.toContain(pasted);
    expect(
      await page.locator('input').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
    ).not.toContain(pasted);
    expect(requests.join('\n')).not.toContain(pasted);
    await expect(page.locator('#savebtn')).toBeDisabled();
    await secret.evaluate((input, value) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', value);
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    }, pasted);
    await expect(secret).toHaveValue('');
    await secret.pressSequentially('invalid-reference');
    await card.locator('[data-field$=".name"]').focus();
    await expect(secret).toHaveValue('');
    expect(requests.join('\n')).not.toContain('invalid-reference');
    await secret.pressSequentially('keychain:farsight/example');
    await expect(secret).toHaveValue('keychain:farsight/example');
    await expect(secret).toHaveAttribute('type', 'text');
    await card.locator('[data-permissions] [data-row-action="add"]').click();
    await card.locator('[data-principal="agent"]').check();
    await expect(page.locator('#savebtn')).toBeEnabled();
    await page.locator('#savebtn').click();
    await expect(page.locator('#savenote')).toHaveText('Saved.');
    const source = settings().sources[2];
    expect(source.id).toBe('work-example');
    expect(source.auth.secret).toBe('keychain:farsight/example');
    expect(source.scope.projects).toEqual(['EXAMPLE']);
    expect(source.permissions.grants[0].principals).toEqual(['human', 'agent']);
    await page.screenshot({ path: info.outputPath('work-grants.png'), fullPage: true });
    await expect(page.locator('#syncbtn')).toBeVisible();
  });

  /** @covers packages/server/public/app/surfaces/settings-collections.js::renderCollections */
  test('collections use the member picker and row editor; Discard restores all sections', async ({ page }, info) => {
    const absent = settings();
    delete absent.collections;
    writeFileSync(file(), JSON.stringify(absent));
    await page.goto(writable + '#/settings/collections');
    await expect(page.locator('#settings-savebar')).toBeHidden();
    await page.locator('[data-row-action="add"]').click();
    await page.locator('[data-field="collections[0].name"]').fill('Billing systems');
    await page.locator('[data-mp-opt="invoice-app"]').click();
    await expect(page.locator('#savebtn')).toBeEnabled();
    await page.locator('#savebtn').click();
    await expect(page.locator('#savenote')).toHaveText('Saved.');
    expect(settings().collections).toEqual([{ name: 'Billing systems', sourceIds: ['invoice-app'] }]);
    await page.screenshot({ path: info.outputPath('collection-members.png'), fullPage: true });
    await page.locator('[data-row-action="add"]').click();
    await page.locator('[data-field="collections[1].name"]').fill('Second');
    await page.locator('[data-row="1"] [data-row-action="up"]').click();
    await expect(page.locator('[data-field="collections[0].name"]')).toHaveValue('Second');
    await expect(page.locator('.settings-collection-help')).toBeVisible();
    await expect(page.locator('[role="gridcell"][tabindex="0"]')).toHaveCount(1);
    await page.locator('.settings-rail a[href="#/settings/workspace"]').click();
    await page.locator('#set-theme').selectOption('light');
    await page.locator('#discardbtn').click();
    await expect(page.locator('#set-theme')).toHaveValue('dark');
    await page.locator('.settings-rail a[href="#/settings/collections"]').click();
    await expect(page.locator('[data-row]')).toHaveCount(1);
    await expect(page.locator('[data-field="collections[0].name"]')).toHaveValue('Billing systems');
  });

  /** @covers packages/server/public/app/lib/read-only.js::applyReadOnly */
  test('read-only disables every write field and button in every section', async ({ page }) => {
    const populated = settings();
    populated.collections = [{ name: 'Billing', sourceIds: ['invoice-app'] }];
    populated.lessons = [{ text: 'Read the gates', pinned: true }];
    const original = JSON.stringify(populated);
    writeFileSync(file(), original);
    const writes: string[] = [];
    page.on('request', (request) => {
      if (['POST', 'PUT', 'DELETE'].includes(request.method())) writes.push(request.url());
    });
    for (const section of ['workspace', 'sources', 'collections', 'configuration', 'agents']) {
      await page.goto(readonly + '#/settings/' + section);
      await expect(page.locator('#set-ro')).toBeVisible();
      if (section === 'configuration') await expect(page.locator('.cfg-src').first()).toBeVisible();
      await page.evaluate(async () => {
        const path = '/app/shell.js';
        const shell = await import(path);
        shell.setLens('business');
        shell.renderChrome();
      });
      const controls = page.locator('#settings [data-write]');
      const states = await controls.evaluateAll((elements) =>
        elements.map((el) => ({
          tag: el.tagName,
          disabled: 'disabled' in el && el.disabled,
          aria: el.getAttribute('aria-disabled'),
        })),
      );
      expect(states.every((s) => s.aria === 'true' || s.disabled)).toBe(true);
    }
    await page.goto(readonly + '#/settings/workspace');
    await page.locator('#set-theme').selectOption('light');
    await expect(page.locator('#set-theme-note')).toContainText('preview');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('#settings-savebar')).toBeHidden();
    expect(writes).toEqual([]);
    expect(readFileSync(file(), 'utf8')).toBe(original);
  });

  test('a late validation answer cannot overwrite the current draft check', async ({ page }) => {
    let release: () => void = () => {};
    let received: () => void = () => {};
    const firstSeen = new Promise<void>((resolve) => {
      received = resolve;
    });
    const delay = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    await page.route('**/api/settings/check', async (route) => {
      if (++calls === 1) {
        received();
        await delay;
        await route.fulfill({
          json: { ok: false, problem: 'settings.mcp.budget must be a whole number of tokens, 500 or more' },
        });
      } else await route.continue();
    });
    await page.goto(writable + '#/settings/agents');
    await page.locator('[data-field="mcp.budget"]').fill('400');
    await firstSeen;
    await page.locator('[data-field="mcp.budget"]').fill('1500');
    await expect(page.locator('#savebtn')).toBeEnabled();
    release();
    await expect(page.locator('[data-problem-for="mcp.budget"]')).toBeHidden();
    await page.locator('#savebtn').click();
    await expect(page.locator('#savenote')).toHaveText('Saved.');
    expect(settings().mcp.budget).toBe(1500);
  });

  test('unsupported overlay fields are visible, disabled and preserved', async ({ page }) => {
    const current = settings();
    current.sources[0].config = { glossary: { App: { label: 'Application' } } };
    writeFileSync(file(), JSON.stringify(current));
    await page.route('**/api/version', async (route) => {
      const response = await route.fetch();
      const value = await response.json();
      value.overlayFields = value.overlayFields.filter((field: string) => field !== 'glossary');
      await route.fulfill({ response, json: value });
    });
    await page.goto(writable + '#/settings/configuration?lens=code');
    await expect(page.locator('[data-unsupported]')).toBeDisabled();
    await expect(page.locator('[data-unsupported]')).toHaveValue('Not in this build');
    await page.locator('.settings-rail a[href="#/settings/workspace"]').click();
    await page.locator('#set-theme').selectOption('light');
    await expect(page.locator('#savebtn')).toBeEnabled();
    await page.locator('#savebtn').click();
    await expect(page.locator('#savenote')).toHaveText('Saved.');
    expect(settings().sources[0].config).toEqual(current.sources[0].config);
  });

  test('section memory and g s are discoverable in the keymap', async ({ page }) => {
    await page.goto(writable + '#/settings/agents');
    await page.locator('#settings-back').click();
    await expect(page.locator('#settings')).toBeHidden();
    await page.keyboard.press('g');
    await page.keyboard.press('s');
    await expect(page.locator('.settings-rail [aria-current]')).toHaveAttribute('href', '#/settings/agents');
    await expect(page).toHaveURL(/#\/settings\/agents/);
    await page.locator('#settings-section-title').click();
    await page.keyboard.press('?');
    await expect(page.locator('#keymap')).toContainText('g s');
    await expect(page.locator('#keymap')).toContainText('Open Settings');
  });

  test('blank sources are refused; a local source round trip, both sync doors and removal work', async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(writable + '#/settings/sources');
    await page.locator('#source-add').click();
    await page.locator('[data-source-create]').click();
    const card = page.locator('.settings-source').last();
    await expect(card.locator('[data-problem-for$=".name"]')).toHaveText('sources[2].name must be a non-empty string');
    await expect(page.locator('#savebtn')).toBeDisabled();
    await card.locator('[data-field$=".name"]').fill('Extra app');
    await expect(card.locator('[data-problem-for$=".path"]')).toHaveText('sources[2].path must be a non-empty string');
    await card.locator('[data-field$=".path"]').fill('invoice-app');
    await card.locator('[data-field$=".exclude"]').fill('**/*.{test,spec}.ts dist/**');
    await expect(page.locator('#savebtn')).toBeEnabled();
    await page.locator('#savebtn').click();
    await expect(page.locator('#savenote')).toHaveText('Saved.');
    await expect(page.locator('#syncbtn')).toBeInViewport();
    expect(settings().sources[2].id).toBe('extra-app');
    expect(settings().sources[2].exclude).toEqual(['**/*.{test,spec}.ts', 'dist/**']);
    await page.locator('#syncbtn').click();
    await expect(page.locator('#savenote')).toHaveText('Sync complete.');
    await page.locator('[data-sync]').first().click();
    await expect(page.locator('#savenote')).toHaveText('Sync complete.');
    await page.route('**/api/sync', (route) => route.fulfill({ json: { error: 'Example source is unavailable' } }));
    await page.locator('[data-sync]').first().click();
    await expect(page.locator('#savenote')).toContainText('Example source is unavailable');
    await page.unroute('**/api/sync');
    await page.locator('[data-source-card="extra-app"] [data-source-remove]').click();
    await expect(page.locator('#savebtn')).toBeEnabled();
    await page.locator('#savebtn').click();
    await expect(page.locator('#savenote')).toHaveText('Saved.');
    expect(settings().sources.map((source: { id: string }) => source.id)).not.toContain('extra-app');
  });

  test('unset confirmation and type-specific fields retain their meaning', async ({ page }) => {
    const current = settings();
    current.sources.push({
      id: 'work-example',
      name: 'Work example',
      type: 'work',
      enabled: true,
      provider: 'jira',
      site: 'https://example.atlassian.net',
      auth: { secret: 'env:EXAMPLE' },
      permissions: { grants: [{ actions: ['edit'], principals: ['agent'] }] },
    });
    writeFileSync(file(), JSON.stringify(current));
    await page.goto(writable + '#/settings/sources');
    const card = page.locator('[data-source-card="work-example"]');
    await expect(card.locator('[data-field$=".confirm"]')).toHaveValue('');
    await expect(card.locator('[data-field$=".path"]')).toHaveCount(0);
    await expect(card.locator('[data-field$=".org"]')).toHaveCount(0);
    await page.locator('.settings-rail a[href="#/settings/agents"]').click();
    await expect(page.locator('.settings-access')).toContainText('Mode: Read-only');
    await expect(page.locator('.settings-access')).toContainText('Confirmation: Not set (agents per Agent writes)');
    await page.locator('.settings-rail a[href="#/settings/sources"]').click();
    await card.locator('[data-field$=".provider"]').selectOption('azure-devops');
    await expect(card.locator('[data-field$=".site"]')).toHaveCount(0);
    await expect(card.locator('[data-field$=".org"]')).toBeVisible();
    await card.locator('[data-field$=".type"]').selectOption('local');
    await card.locator('[data-field$=".path"]').fill('invoice-app');
    await expect(page.locator('#savebtn')).toBeEnabled();
    await page.locator('#savebtn').click();
    await expect(page.locator('#savenote')).toHaveText('Saved.');
    expect(settings().sources[2].auth).toBeUndefined();
    expect(settings().sources[2].permissions).toBeUndefined();
  });

  test('g s suppresses the Map legend; a lone g opens it after the chord window', async ({ page }) => {
    await page.goto(writable + '#/map');
    await expect(page.locator('#stats')).not.toHaveText('loading…');
    await page.keyboard.press('g');
    await page.keyboard.press('s');
    await expect(page).toHaveURL(/#\/settings\/workspace/);
    await page.locator('#settings-back').click();
    await expect(page.locator('.map-legend')).toBeHidden();
    await page.keyboard.press('g');
    await expect(page.locator('.map-legend')).toBeVisible();
  });
});
