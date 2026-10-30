// The real Settings page on a private two-source workspace, including concurrent writers.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
        test(`${section}, ${register}, ${theme}: fits 1280px and renders without errors`, async ({ page }, info) => {
          await page.setViewportSize({ width: 1280, height: 900 });
          await page.addInitScript((value) => localStorage.setItem('fs-register', value), register);
          const before = settings();
          before.theme = theme;
          writeFileSync(file(), JSON.stringify(before));
          await page.goto(writable + `#/settings/${section}?lens=${register === 'professional' ? 'business' : 'code'}`);
          await expect(page.locator('.settings-rail [aria-current]')).toHaveAttribute('href', '#/settings/' + section);
          await expect(page.locator('#settings-section-title')).toBeVisible();
          if (section === 'configuration') await expect(page.locator('.cfg-src').first()).toBeVisible();
          await expect(page.locator('#settings-savebar')).toBeHidden();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          expect(
            await page.locator('.settings-content').evaluate((el) => el.getBoundingClientRect().width),
          ).toBeLessThanOrEqual(880);
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          mkdirSync('build/settings-shots', { recursive: true });
          await page.screenshot({ path: `build/settings-shots/${section}-${register}-${theme}.png`, fullPage: true });
          await page.screenshot({ path: info.outputPath(`${section}-${register}-${theme}.png`), fullPage: true });
        });
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
    await expect(page.locator('#settings-savebar')).toBeHidden();
    await page.reload();
    await expect(page.locator('[data-field="mcp.budget"]')).toHaveValue('1200');
  });

  /** @covers packages/server/public/app/surfaces/settings-sources.js::renderSources */
  test('work source form refuses a literal secret before any request and saves a reference with permissions', async ({
    page,
  }) => {
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
    await card.locator('[data-secret-prefix="keychain:"]').click();
    await secret.pressSequentially('farsight/example');
    await card.locator('[data-permissions] [data-row-action="add"]').click();
    await card.locator('[data-principal="agent"]').check();
    await expect(page.locator('#savebtn')).toBeEnabled();
    await page.locator('#savebtn').click();
    await expect(page.locator('#savenote')).toHaveText('Saved.');
    const source = settings().sources[2];
    expect(source.auth.secret).toBe('keychain:farsight/example');
    expect(source.scope.projects).toEqual(['EXAMPLE']);
    expect(source.permissions.grants[0].principals).toEqual(['human', 'agent']);
    await page.screenshot({ path: 'build/settings-shots/work-grants.png', fullPage: true });
    await expect(page.locator('#syncbtn')).toBeVisible();
  });

  /** @covers packages/server/public/app/surfaces/settings-collections.js::renderCollections */
  test('collections use the member picker and row editor; Discard restores all sections', async ({ page }) => {
    await page.goto(writable + '#/settings/collections');
    await page.locator('[data-row-action="add"]').click();
    await page.locator('[data-field="collections[0].name"]').fill('Billing systems');
    await page.locator('[data-mp-opt="invoice-app"]').click();
    await expect(page.locator('#savebtn')).toBeEnabled();
    await page.locator('#savebtn').click();
    await expect(page.locator('#savenote')).toHaveText('Saved.');
    expect(settings().collections).toEqual([{ name: 'Billing systems', sourceIds: ['invoice-app'] }]);
    await page.screenshot({ path: 'build/settings-shots/collection-members.png', fullPage: true });
    await page.locator('[data-row-action="add"]').click();
    await page.locator('[data-field="collections[1].name"]').fill('Second');
    await page.locator('[data-row="1"] [data-row-action="up"]').click();
    await expect(page.locator('[data-field="collections[0].name"]')).toHaveValue('Second');
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
    const writes: string[] = [];
    page.on('request', (request) => {
      if (['POST', 'PUT', 'DELETE'].includes(request.method())) writes.push(request.url());
    });
    for (const section of ['workspace', 'sources', 'collections', 'configuration', 'agents']) {
      await page.goto(readonly + '#/settings/' + section);
      await expect(page.locator('#set-ro')).toBeVisible();
      if (section === 'configuration') await expect(page.locator('.cfg-src').first()).toBeVisible();
      const controls = page.locator('#settings [data-write]');
      const states = await controls.evaluateAll((elements) =>
        elements.map((el) => ({
          tag: el.tagName,
          disabled: 'disabled' in el && el.disabled,
          aria: el.getAttribute('aria-disabled'),
        })),
      );
      expect(states.every((s) => (s.tag === 'BUTTON' ? s.aria === 'true' : s.disabled))).toBe(true);
    }
    expect(writes).toEqual([]);
    expect(readFileSync(file(), 'utf8')).toBe(initial);
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
    await page.locator('#settings-section-title').click();
    await page.keyboard.press('?');
    await expect(page.locator('#keymap')).toContainText('g s');
    await expect(page.locator('#keymap')).toContainText('Open Settings');
  });
});
