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
    for (const name of ['vendor-api', 'old-vendor'])
      writeFileSync(
        join(workspace.dir, 'invoice-app/docs', name + '.json'),
        JSON.stringify({
          openapi: '3.1.0',
          info: { title: name, version: '1' },
          paths: { ['/vendor/' + name]: { get: {} } },
        }),
      );
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
    saved.sources[0].openapi = [{ path: 'openapi.yaml', name: 'Invoice API', phase: 'live' }];
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
        { kind: 'external', name: 'Portal partner', business: 'Provides documents.' },
        { kind: 'queue', name: 'Portal events', loc: 'src/missing.ts:4' },
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
          if (form === 'patterns') {
            await pane(page, form).locator('[data-pattern-test]').first().click();
            await expect(pane(page, form).locator('[data-pattern-state]').first()).toHaveText(
              'This version was tested.',
            );
            await pane(page, form).locator('[data-pattern-result]').first().scrollIntoViewIfNeeded();
            await page.screenshot({
              path: info.outputPath(`patterns-result-${register}-${theme}.png`),
              fullPage: true,
            });
          }
          expect(pageErrors).toEqual([]);
        });
      }

  /**
   * @covers packages/server/public/app/surfaces/settings-forms.js::renderOverlayForm
   * @covers packages/server/public/app/surfaces/settings.js::saveSettings
   * @covers POST /api/patterns/test
   * @covers POST /api/sync
   */
  test('key edits preserve Tab and pointer focus, field paths, and stay on Settings while typing', async ({ page }) => {
    for (const [form, next] of [
      ['gates', 'label'],
      ['endpoints', 'method'],
      ['words', 'label'],
    ]) {
      await open(page, form);
      const row = pane(page, form).locator('[data-row]').first();
      const key = row.locator('[data-form-field="$key"]');
      const target = row.locator(`[data-form-field="${next}"]`);
      await key.fill('Renamed' + form);
      await key.press('Tab');
      await expect(target).toBeFocused();
      await expect(target).toHaveAttribute('data-field', new RegExp('Renamed' + form + '\\.' + next + '$'));
      await page.keyboard.type('t');
      await expect(page).toHaveURL(/#\/settings\/configuration/);
      await key.fill('Clicked' + form);
      await target.click();
      await expect(target).toBeFocused();
      await page.keyboard.type('t');
      await expect(page).toHaveURL(/#\/settings\/configuration/);
    }
  });

  test('shape changes keep focus on their selector and unchanged rules do not request a new test', async ({ page }) => {
    await open(page, 'patterns');
    const row = pane(page, 'patterns').locator('[data-row]').first();
    await expect(row.locator('[data-pattern-state]')).toHaveText('Unchanged saved rule; no new test is required.');
    const emit = row.locator('[data-form-field="emit.kind"]');
    await emit.selectOption('guard');
    await expect(emit).toBeFocused();
    await emit.press('Tab');
    await expect(row.locator('[data-form-field="emit.name"]')).toBeFocused();
    await expect(row.locator('[data-pattern-state]')).toContainText('Test each changed pattern');
    const matcher = row.locator('[data-form-field="$matcher"]');
    await matcher.selectOption('regex');
    await expect(matcher).toBeFocused();
    await matcher.press('Tab');
    await expect(row.locator('[data-form-field="match.regex"]')).toBeFocused();
    await card(page).locator('[data-overlay-form="nodes"]').click();
    const kind = pane(page, 'nodes').locator('[data-form-field="kind"]').first();
    await kind.selectOption('external');
    await expect(kind).toBeFocused();
  });

  test('an in-flight server check cannot hide a duplicate-key correction', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived = false;
    await page.route('**/api/settings/check', async (route) => {
      const response = await route.fetch();
      arrived = true;
      await held;
      await route.fulfill({ response });
    });
    await open(page);
    const gates = pane(page, 'gates');
    await gates.locator('[data-row-action="add"]').click();
    await expect.poll(() => arrived).toBe(true);
    const row = gates.locator('[data-row]').last();
    const key = row.locator('[data-form-field="$key"]');
    await key.fill('Policy');
    await key.press('Tab');
    await expect(row.locator('[data-key-problem]')).toContainText('Choose a different key');
    const completed = page.waitForResponse('**/api/settings/check');
    release();
    await completed;
    await expect(page.locator('#savebtn')).toBeEnabled();
    await expect(row.locator('[data-key-problem]')).toBeVisible();
    await key.fill('UniquePolicy');
    await expect(row.locator('[data-key-problem]')).toBeHidden();
    await key.press('Tab');
    await gates.locator('[data-row-action="add"]').click();
    const ids = await gates.locator('[id]').evaluateAll((elements) => elements.map((element) => element.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('matcher validation names the expression and workspace documents have a distinct heading', async ({ page }) => {
    await open(page, 'patterns');
    const row = pane(page, 'patterns').locator('[data-row]').first();
    const expression = row.locator('[data-form-field="match.call"]');
    await expression.fill('');
    await expect(expression).toHaveAttribute('aria-invalid', 'true');
    await expect(expression.locator('..').locator('[data-problem-for]')).toContainText('match.call');
    await expect(row.locator('[data-form-field="$matcher"]')).not.toHaveAttribute('aria-invalid', 'true');
    await open(page, 'openapi', writable, 'business');
    await expect(
      card(page).locator('.settings-overlay-form').getByText('Interface documents', { exact: true }),
    ).toHaveCount(1);
    await expect(pane(page, 'openapi').getByRole('heading', { name: 'Workspace documents' })).toBeVisible();
  });

  test('declared nodes expose only relevant fields and show each row’s last-sync audit', async ({ page }) => {
    await open(page, 'nodes');
    const nodes = pane(page, 'nodes');
    await expect(nodes.locator('[data-row]')).toHaveCount(4);
    const guard = nodes
      .locator('[data-row]')
      .filter({ has: page.locator('[data-form-field="name"][value="Portal session"]') });
    await expect(guard.locator('[data-form-field="requires"]')).toBeVisible();
    await expect(guard.locator('[data-form-field="handler"]')).toHaveCount(0);
    const route = nodes
      .locator('[data-row]')
      .filter({ has: page.locator('[data-form-field="name"][value="POST /manual"]') });
    await expect(route.locator('[data-form-field="tier"]')).toHaveCount(0);
    const queue = nodes
      .locator('[data-row]')
      .filter({ has: page.locator('[data-form-field="name"][value="Portal events"]') });
    const response = await page.request.get(writable + 'api/config');
    const report = (await response.json()).config['invoice-app'];
    const note = report.files
      .find((file: any) => file.from === 'workspace')
      .nodes.find((node: any) => node.kind === 'queue' && node.name === 'Portal events').notes[0];
    expect(note).toContain('missing.ts');
    await expect(queue.locator('.settings-form-audit')).toContainText(note);
    await expect(guard.locator('.settings-form-audit')).not.toContainText(note);
  });

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
    await expect(card(page).locator('.settings-export-json')).toContainText('draft-route');
    const exported = JSON.parse(await card(page).locator('.settings-export-json').innerText());
    expect(exported.patterns.at(-1).id).toBe('draft-route');
    expect(exported.openapi[0].name).toBe('Invoice API');
    const cliExport = JSON.parse(
      execFileSync(process.execPath, [CLI, 'config', 'export', 'invoice-source-id'], {
        cwd: workspace.dir,
        encoding: 'utf8',
      }),
    );
    expect(cliExport).toEqual(exported);
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

  test('Register and Dismiss refresh form rows and survive editing then Save', async ({ page }) => {
    await open(page, 'openapi');
    await pane(page, 'openapi').locator('[data-form-field="name"]').first().fill('Draft API name');
    const candidate = card(page).locator('.settings-overlay .cfg-openapi-row[data-path="docs/vendor-api.json"]');
    await candidate.locator('[data-openapi-action="register"]').click();
    await expect(candidate.locator('.cfg-openapi-actions')).toContainText('Saved');
    await expect(pane(page, 'openapi').locator('[data-form-field="$document"]')).toHaveCount(2);
    const dismissed = card(page).locator('.settings-overlay .cfg-openapi-row[data-path="docs/old-vendor.json"]');
    await dismissed.locator('[data-openapi-action="dismiss"]').click();
    await expect(dismissed.locator('.cfg-openapi-actions')).toContainText('Saved');
    await expect(pane(page, 'openapi').locator('[data-form-field="$value"]')).toHaveValue('docs/old-vendor.json');
    await pane(page, 'openapi').locator('[data-form-field="phase"]').first().fill('draft');
    await expect(page.locator('#savebtn')).toBeEnabled();
    await page.locator('#savebtn').click();
    await expect(page.locator('#savenote')).toHaveText('Saved.');
    expect(settings().sources[0].openapi).toEqual([
      { path: 'openapi.yaml', name: 'Draft API name', phase: 'draft' },
      { path: 'docs/vendor-api.json' },
    ]);
    expect(settings().sources[0].openapiIgnore).toEqual(['docs/old-vendor.json']);
  });

  test('all seven pattern output kinds can be created and saved without hidden invalid fields', async ({ page }) => {
    await open(page, 'patterns');
    const patterns = pane(page, 'patterns');
    for (const kind of ['route', 'guard', 'external', 'queue', 'rule', 'flag', 'entrypoint']) {
      await patterns.locator('[data-row-action="add"]').click();
      const row = patterns.locator('[data-row]').last();
      await row.locator('[data-form-field="id"]').fill('new-' + kind);
      await row.locator('[data-form-field="files"]').fill('src/forms.ts');
      await row.locator('[data-form-field="match.call"]').fill('portal.get');
      await row.locator('[data-form-field="emit.kind"]').selectOption(kind);
      await row.locator('[data-form-field="emit.name"]').fill('New part');
      if (kind === 'route') await row.locator('[data-form-field="emit.path"]').fill('/new');
      else await expect(row.locator('[data-form-field="emit.path"]')).toHaveCount(0);
      await row.locator('[data-pattern-untested]').click();
    }
    await expect(page.locator('#savebtn')).toBeEnabled();
    await page.locator('#savebtn').click();
    await expect(page.locator('#savenote')).toHaveText('Saved.');
    for (const rule of settings().sources[0].config.patterns.slice(1))
      expect(Object.values(rule.emit)).not.toContain('');
  });

  test('export follows the unsaved draft and a late response cannot replace the newer JSON', async ({ page }) => {
    const before = readFileSync(file(), 'utf8');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    await page.route('**/api/config/export', async (route) => {
      const first = ++requests === 1;
      const response = await route.fetch();
      if (first) await held;
      await route.fulfill({ response });
    });
    await open(page);
    await card(page).locator('.settings-export summary').click();
    await expect.poll(() => requests).toBe(1);
    await pane(page, 'gates').locator('[data-form-field="label"]').fill('Changed in this draft');
    await expect(card(page).locator('.settings-export-json')).toContainText('Changed in this draft');
    const delayed = page.waitForResponse('**/api/config/export');
    release();
    await delayed;
    await expect(card(page).locator('.settings-export-json')).toContainText('Changed in this draft');
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });

  test('a completed test of an earlier draft cannot acknowledge an edit made while it ran', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/patterns/test', async (route) => {
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    });
    await open(page, 'patterns');
    const rule = pane(page, 'patterns').locator('[data-row]').first();
    await rule.locator('[data-form-field="emit.path"]').fill('/first');
    await rule.locator('[data-pattern-test]').click();
    await expect(rule.locator('[data-pattern-state]')).toHaveText('Testing…');
    await rule.locator('[data-form-field="emit.path"]').fill('/second');
    const delayed = page.waitForResponse('**/api/patterns/test');
    release();
    await delayed;
    await expect(rule.locator('[data-pattern-state]')).toHaveText(
      'Test each changed pattern or choose Save untested in Source configuration.',
    );
    await expect(page.locator('#savebtn')).toBeDisabled();
    await rule.locator('[data-pattern-test]').click();
    await expect(rule.locator('[data-pattern-state]')).toHaveText('This version was tested.');
    await expect(page.locator('#savebtn')).toBeEnabled();
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
