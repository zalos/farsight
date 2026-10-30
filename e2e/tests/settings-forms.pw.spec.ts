// Overlay forms use a real two-source workspace; every screenshot gets a fresh page.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
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
const formNames = ['gates', 'endpoints', 'patterns', 'nodes', 'openapi', 'words', 'externals'];

test.describe('workspace overlay forms', () => {
  test.describe.configure({ mode: 'serial' });
  let workspace: ReturnType<typeof makeProjectsWorkspace>;
  let initial: string;
  let writable = '';
  let readonly = '';
  const servers: ChildProcess[] = [];
  const file = () => join(workspace.dir, '.farsight/settings.json');
  const settings = () => JSON.parse(readFileSync(file(), 'utf8'));
  const card = (page: Page) => page.locator('.cfg-src[data-repo="invoice-app"]');
  const pane = (page: Page, form: string) => card(page).locator(`[data-form="${form}"]`);
  test.beforeAll(async () => {
    workspace = makeProjectsWorkspace('settings-forms');
    writeFileSync(
      join(workspace.dir, 'invoice-app/src/forms.ts'),
      `export function submitForm() {}\nportal.get('/forms', submitForm);\nportal.get('/unresolved', missingHandler);`,
    );
    const saved = settings();
    saved.sources[0].id = 'invoice-source-id';
    saved.sources[0].config = {
      frameworks: {
        spring: {
          security: { Policy: { label: '$action on $resource', tier: 'policy', requires: '$action' } },
          mappings: { ApiRoute: { method: 'pair:method', path: 'arg:0' } },
          delegates: ['*ApiDelegate'],
        },
      },
      patterns: [
        {
          id: 'portal',
          files: ['src/forms.ts'],
          match: { call: 'portal.get', args: { path: 0, handler: -1 } },
          emit: { kind: 'route', method: 'GET', path: '$path', handler: '$handler' },
        },
      ],
      glossary: { submitForm: { label: 'Submit request', description: 'Send the completed request.' } },
      tags: { portal: ['submitForm'] },
      entrypoints: { Portal: ['submitForm'] },
      externals: [{ name: 'Document service', import: '@example/documents', kind: 'files', store: true }],
      stores: [{ name: 'Portal records', kind: 'sql', engine: 'postgres', tables: ['Request'] }],
    };
    saved.sources[0].openapi = [{ path: 'docs/openapi.yaml', name: 'Invoice API', phase: 'live' }];
    writeFileSync(file(), JSON.stringify(saved));
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
      await expect
        .poll(async () => {
          try {
            return (await fetch(base + 'api/version')).ok;
          } catch {
            return false;
          }
        })
        .toBe(true);
    }
    const version = await (await fetch(writable + 'api/version')).json();
    if (version.configFields.includes('nodes')) {
      saved.sources[0].config.nodes = [
        { kind: 'guard', name: 'Portal session', tier: 'policy', business: 'A signed-in user.' },
        {
          kind: 'route',
          name: 'POST /manual',
          handler: 'src/forms.ts::submitForm',
          guards: ['Portal session'],
          business: 'Send a request.',
        },
      ];
      writeFileSync(file(), JSON.stringify(saved));
    }
    expect((await fetch(writable + 'api/sync', { method: 'POST' })).ok).toBe(true);
    initial = readFileSync(file(), 'utf8');
  });
  test.beforeEach(() => writeFileSync(file(), initial));
  test.afterAll(() => {
    for (const child of servers) child.kill('SIGTERM');
    workspace?.cleanup();
  });

  async function open(page: Page, form = 'gates', base = writable, lens = 'code') {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(base + '#/settings/configuration?lens=' + lens);
    await expect(page.locator('#stats')).not.toHaveText('loading…');
    await card(page).locator('[data-config-tab="workspace"]').click();
    await card(page).locator(`[data-overlay-form="${form}"]`).click();
    await expect(pane(page, form)).toBeVisible();
  }

  /** @covers packages/server/public/app/surfaces/settings-forms.js::renderOverlayForm */
  for (const form of formNames)
    for (const register of ['hud', 'professional'])
      for (const theme of ['dark', 'light']) {
        test(`${form}, ${register}, ${theme}: fits 1280px with no browser errors`, async ({
          page,
          pageErrors,
        }, info) => {
          const saved = settings();
          saved.theme = theme;
          writeFileSync(file(), JSON.stringify(saved));
          await page.addInitScript((register) => localStorage.setItem('fs-register', register), register);
          await open(page, form, writable, register === 'professional' ? 'business' : 'code');
          await expect(pane(page, form).locator('[role="grid"]')).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          expect(await pane(page, form).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
          await expect(page.locator('#settings-savebar')).toBeHidden();
          if (register === 'professional') {
            await expect(pane(page, form).locator('[data-form-json]')).toHaveCount(0);
            await expect(card(page).locator('.settings-export')).toHaveCount(0);
          } else {
            await pane(page, form).locator('[data-form-json]').click();
            await expect(pane(page, form).locator('.settings-form-json')).toBeVisible();
            await pane(page, form).locator('[data-form-json]').click();
          }
          await pane(page, form).scrollIntoViewIfNeeded();
          await page.screenshot({ path: info.outputPath(`${form}-${register}-${theme}.png`), fullPage: true });
          expect(pageErrors).toEqual([]);
        });
      }

  /**
   * @covers packages/server/public/app/surfaces/settings-forms.js::renderOverlayForm
   * @covers packages/server/public/app/surfaces/settings.js::saveSettings
   * @covers POST /api/patterns/test
   * @covers POST /api/sync
   */
  test('a gate and pattern are edited, tested, saved, exported and recorded after sync', async ({ page }) => {
    const other = settings().sources[1];
    await open(page);
    const gates = pane(page, 'gates');
    await gates.locator('[data-row-action="add"]').click();
    const gate = gates.locator('[data-row]').last();
    await gate.locator('[data-form-field="$key"]').fill('ApprovalPolicy');
    await gate.locator('[data-form-field="label"]').fill('$action on $resource');
    await expect(gate.locator('output')).toHaveText('approve on invoice');
    await card(page).locator('[data-overlay-form="patterns"]').click();
    const patterns = pane(page, 'patterns');
    await patterns.locator('[data-row-action="add"]').click();
    const rule = patterns.locator('[data-row]').last();
    await rule.locator('[data-form-field="id"]').fill('draft-route');
    await rule.locator('[data-form-field="files"]').fill('src/forms.ts');
    await rule.locator('[data-form-field="match.call"]').fill('portal.get');
    await rule.locator('[data-form-field="match.args"]').fill('path=0\nhandler=-1');
    await rule.locator('[data-form-field="emit.path"]').fill('$path');
    await rule.locator('[data-form-field="emit.handler"]').fill('$handler');
    await expect(page.locator('#savebtn')).toBeDisabled();
    await rule.locator('[data-pattern-test]').click();
    await expect(rule.locator('[data-pattern-state]')).toHaveText('This version was tested.');
    await expect(rule.locator('[data-pattern-result] li').first()).toContainText('unresolved');
    await expect(rule.locator('[data-pattern-result]')).toContainText('2 matches');
    await expect(page.locator('#savebtn')).toBeEnabled();
    await page.locator('#savebtn').click();
    await expect(page.locator('#savenote')).toHaveText('Saved.');
    expect(settings().sources[0].config.frameworks.spring.security.ApprovalPolicy.label).toBe('$action on $resource');
    expect(settings().sources[0].config.patterns.at(-1).id).toBe('draft-route');
    expect(settings().sources[1]).toEqual(other);
    await card(page).locator('.settings-export summary').click();
    const exported = JSON.parse(await card(page).locator('.settings-export-json').innerText());
    expect(exported.patterns.at(-1).id).toBe('draft-route');
    expect(exported.openapi[0].name).toBe('Invoice API');
    const cliExport = JSON.parse(
      execFileSync(process.execPath, [CLI, 'config', 'export', 'invoice-source-id'], {
        cwd: workspace.dir,
        encoding: 'utf8',
      }),
    );
    expect(cliExport.patterns.at(-1).id).toBe('draft-route');
    await page.locator('#syncbtn').click();
    await expect(page.locator('#savenote')).toHaveText('Sync complete.');
    await expect(pane(page, 'patterns').locator('[data-form-field="id"]').last()).toHaveValue('draft-route');
    await card(page).locator('[data-config-tab="repository"]').click();
    await expect(card(page).locator('.cfg-row[data-path*="sources[invoice-source-id].config"]')).toContainText(
      'patterns',
    );
    await expect(card(page).locator('.cfg-pattern-row').last()).toContainText('draft-route');
    await card(page).locator('[data-config-tab="workspace"]').click();
    await expect(pane(page, 'patterns').locator('[data-form-field="id"]').last()).toHaveValue('draft-route');
  });

  test('the server sentence is printed beside the invalid field and save stays disabled', async ({ page }) => {
    await open(page, 'endpoints');
    const method = pane(page, 'endpoints').locator('[data-form-field="method"]').first();
    const check = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/settings/check') &&
        response.request().postData()?.includes('INVALID_METHOD') === true,
    );
    await method.fill('INVALID_METHOD');
    const response = await check;
    const result = await response.json();
    expect(result.ok).toBe(false);
    await expect(method.locator('..').locator('[data-problem-for]')).toHaveText(result.problem);
    await expect(method).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#savebtn')).toBeDisabled();
  });

  test('editing invalidates a test across sections; Save untested permits only the current version', async ({
    page,
  }) => {
    await open(page, 'patterns');
    const name = pane(page, 'patterns').locator('[data-form-field="id"]').first();
    await name.fill('changed');
    await pane(page, 'patterns').locator('[data-pattern-test]').first().click();
    await expect(pane(page, 'patterns').locator('[data-pattern-state]').first()).toHaveText('This version was tested.');
    await name.fill('changed-again');
    await page.locator('.settings-rail a[href="#/settings/workspace"]').click();
    await expect(page.locator('#savebtn')).toBeDisabled();
    await page.locator('#settings-pattern-warning a').click();
    await pane(page, 'patterns').locator('[data-pattern-untested]').first().click();
    await expect(page.locator('#savebtn')).toBeEnabled();
    await page.locator('#savebtn').click();
    await expect(page.locator('#savenote')).toHaveText('Saved.');
    expect(settings().sources[0].config.patterns[0].id).toBe('changed-again');
  });

  test('read-only greys every form write control and preserves the settings', async ({ page }) => {
    const before = readFileSync(file(), 'utf8');
    await open(page, 'gates', readonly);
    for (const form of formNames) {
      await card(page).locator(`[data-overlay-form="${form}"]`).click();
      const controls = pane(page, form).locator('[data-write]');
      for (const control of await controls.all()) {
        if (await control.evaluate((el) => el.tagName === 'BUTTON'))
          await expect(control).toHaveAttribute('aria-disabled', 'true');
        else await expect(control).toBeDisabled();
      }
      const add = pane(page, form).locator('[data-row-action="add"]');
      if (await add.isEnabled()) {
        await add.focus();
        await add.press('Enter');
      }
    }
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });

  test('an older build disables unsupported declarations and preserves them', async ({ page }) => {
    await page.route('**/api/version', async (route) => {
      const response = await route.fetch();
      const version = await response.json();
      version.configFields = version.configFields.filter((field: string) => field !== 'nodes');
      await route.fulfill({ response, json: version });
    });
    await open(page, 'nodes');
    await expect(pane(page, 'nodes').locator('[data-row-action="add"]')).toBeDisabled();
    await expect(pane(page, 'nodes').locator('.settings-form-add option')).toContainText('Not in this build');
    await expect(page.locator('#settings-savebar')).toBeHidden();
  });
});
