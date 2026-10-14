import { test, expect } from './support';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWeb } from '../../packages/echo/dist/web.js';
import { saveConfig } from '../../packages/echo/dist/config.js';
import type { EchoConfig, EchoContext } from '../../packages/echo/src/types.js';
import type { ModelSetupDependencies } from '../../packages/echo/src/model-setup-types.js';

// Exercise real settings revision/trust and setup HTTP routes with synthetic providers only.
test.describe('Echo model settings', () => {
  test.describe.configure({ mode: 'serial' });
  let directory: string, configPath: string, previousState: string | undefined;
  let view: Awaited<ReturnType<typeof startWeb>>, ctx: EchoContext;
  let discoveryCalls = 0;
  let testedModels: string[] = [];
  let generate: NonNullable<ModelSetupDependencies['generate']>;
  let list: NonNullable<ModelSetupDependencies['list']>;
  const ready = () => ({ model: 'synthetic-fixture', content: { status: 'ready', evidenceId: 'echo-model-test' }, finishReason: 'stop' as const, usage: { inputTokens: 16, outputTokens: 12 } });

  test.beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'echo-model-ui-'));
    previousState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(directory, 'state');
  });
  test.afterAll(async () => {
    if (previousState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previousState;
    await rm(directory, { recursive: true, force: true });
  });
  test.beforeEach(async ({ page }) => {
    discoveryCalls = 0; testedModels = [];
    const profile = {
      identity: { individual: 'example-person', project: 'example-project' },
      backend: { mode: 'managed' as const, url: 'http://127.0.0.1:4621' },
      model: { provider: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', model: 'synthetic-original' },
      web: { port: 4480 }, hooks: { claude: false, codex: false, vscode: false },
      skills: { directories: [] }, budget: { briefMaxChars: 1200, modelMaxTokens: 256, timeoutMs: 10000 },
    };
    const config: EchoConfig = { version: 1, defaultProfile: 'personal', profiles: {
      personal: profile,
      work: { ...structuredClone(profile), identity: { individual: 'example-work', project: 'work-project' }, backend: { mode: 'managed', url: 'http://127.0.0.1:4721' }, model: { provider: 'openai-compatible', baseUrl: 'https://models.example.com', model: 'synthetic-hosted' }, web: { port: 4481 } },
    } };
    configPath = join(directory, 'settings.json');
    await saveConfig(configPath, config);
    ctx = { configPath, config, profileId: 'personal', profile: structuredClone(profile), directory, dataDirectory: join(directory, 'personal') };
    ctx.profile.web.port = 0;
    list = async () => { discoveryCalls++; return ['synthetic-original', 'synthetic-second']; };
    generate = async (selected, request) => {
      testedModels.push(selected.model.model);
      expect(request.messages).toHaveLength(2);
      expect(request.messages[1]!.content).toContain('echo-model-test');
      expect(request.messages[1]!.content).not.toContain('example-person');
      return ready();
    };
    view = await startWeb(ctx, { modelSetup: { list: (...args) => list(...args), generate: (...args) => generate(...args) } });
    await page.goto(view.url);
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Test model', exact: true })).toBeEnabled();
  });
  test.afterEach(async () => { await view?.close(); });

  /** @covers packages/echo/public/app.js::runModelSetup */
  test('discovery, save and explicit synthetic test stay separate from running settings', async ({ page }, testInfo) => {
    expect(discoveryCalls).toBe(0); expect(testedModels).toEqual([]);
    await page.getByRole('button', { name: 'Find installed models', exact: true }).click();
    await page.getByLabel('Choose an installed model', { exact: true }).selectOption('synthetic-second');
    await expect(page.getByLabel('Model name', { exact: true })).toHaveValue('synthetic-second');
    await expect(page.getByRole('button', { name: 'Test model', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Find installed models', exact: true })).toBeDisabled();
    await page.locator('#modelUrl').fill('http://127.0.0.1:11434/');
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Test model', exact: true })).toBeEnabled();
    await expect(page.locator('.runtime-model')).toContainText('synthetic-original');
    await expect(page.locator('.restart-required')).toBeVisible();
    expect(testedModels).toEqual([]);
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.profiles.personal.model).not.toHaveProperty('ollama');
    await page.getByRole('button', { name: 'Test model', exact: true }).click();
    await expect(page.getByText('Model test passed.', { exact: true })).toBeVisible();
    expect(discoveryCalls).toBe(1); expect(testedModels).toEqual(['synthetic-second']);
    await expect(page.locator('#modelUrl')).toHaveValue('http://127.0.0.1:11434');
    await expect(page.locator('.runtime-model')).toContainText('synthetic-original');
    await page.setViewportSize({ width: 1440, height: 1800 });
    await page.locator('.model-settings').screenshot({ path: testInfo.outputPath('model-settings-desktop.png') });
  });

  /** @covers packages/echo/public/app.js::captureForm */
  test('background prompt research is explicit, saved per profile and does not generate on save', async ({ page }) => {
    const choice = page.getByLabel('Prompt memory research', { exact: true });
    await expect(choice).toHaveValue('manual');
    await choice.selectOption('background');
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeDisabled();
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.profiles.personal.submind.hookResearch).toBe('background');
    expect(saved.profiles.work.submind).toBeUndefined();
    expect(testedModels).toEqual([]); expect(discoveryCalls).toBe(0);
    await page.reload();
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    await expect(choice).toHaveValue('background');
  });

  /** @covers packages/echo/public/app.js::captureForm */
  test('Ollama memory controls persist across provider changes without affecting compatibility', async ({ page }) => {
    await page.getByLabel('Ollama context allowance (tokens)', { exact: true }).fill('8192');
    await page.getByLabel('Keep model loaded (seconds)', { exact: true }).fill('30');
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeDisabled();
    await page.getByLabel('Provider', { exact: true }).selectOption('openai-compatible');
    await expect(page.getByLabel('Keep model loaded (seconds)', { exact: true })).toBeHidden();
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Test model', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Find installed models', exact: true })).toBeDisabled();
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.profiles.personal.model.ollama).toEqual({ contextTokens: 8192, keepAliveSeconds: 30 });
    await page.getByLabel('Provider', { exact: true }).selectOption('ollama');
    await expect(page.getByLabel('Ollama context allowance (tokens)', { exact: true })).toHaveValue('8192');
    await expect(page.getByLabel('Keep model loaded (seconds)', { exact: true })).toHaveValue('30');
  });

  /** @covers packages/echo/public/app.js::cancelModelSetup */
  test('switching profiles aborts the request and discards its late result', async ({ page }) => {
    let release!: () => void; let started!: () => void; let aborted = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { started = resolve; });
    generate = async (_profile, request) => {
      request.signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
      started(); await pending; return ready();
    };
    try {
      await page.getByRole('button', { name: 'Test model', exact: true }).click(); await began;
      await page.getByRole('button', { name: 'work', exact: true }).click();
      await expect.poll(() => aborted).toBe(true);
      release();
      await expect(page.getByText('Model test passed.', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Find installed models', exact: true })).toBeDisabled();
      await expect(page.getByLabel('Model name', { exact: true })).toHaveValue('synthetic-hosted');
    } finally { release(); }
  });

  /** @covers packages/echo/public/app.js::cancelModelSetup */
  test('leaving settings cancels a response already on its way to the page', async ({ page }) => {
    let release!: () => void; let intercepted!: () => void; let delivered!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { intercepted = resolve; });
    const settled = new Promise<void>(resolve => { delivered = resolve; });
    await page.route('**/api/model/test', async route => {
      const response = await route.fetch(); intercepted(); await pending;
      try { await route.fulfill({ response }); } finally { delivered(); }
    });
    try {
      await page.getByRole('button', { name: 'Test model', exact: true }).click(); await started;
      await page.getByRole('tab', { name: 'Memories', exact: true }).click();
      release(); await settled;
      await page.getByRole('tab', { name: 'Settings', exact: true }).click();
      await expect(page.getByText('Model test passed.', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Model request cancelled.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Test model', exact: true })).toBeEnabled();
    } finally { release(); }
  });

  /** @covers packages/echo/public/app.js::refreshModelActions */
  test('a read-only preview cannot discover or test a real model', async ({ page }) => {
    await view.close();
    view = await startWeb(ctx, { demo: true, modelSetup: { list: (...args) => list(...args), generate: (...args) => generate(...args) } });
    await page.goto(view.url);
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Find installed models', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Test model', exact: true })).toBeDisabled();
    await expect(page.getByLabel('Ollama context allowance (tokens)', { exact: true })).toBeDisabled();
    expect(discoveryCalls).toBe(0); expect(testedModels).toEqual([]);
  });

  /** @covers packages/echo/public/app.js::runModelSetup */
  test('model names remain literal and the settings fit a narrow display', async ({ page }, testInfo) => {
    list = async () => ['<img src=x onerror="window.echoInjected=true">'];
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Find installed models', exact: true }).click();
    const select = page.getByLabel('Choose an installed model', { exact: true });
    await expect(select.locator('option').last()).toHaveText('<img src=x onerror="window.echoInjected=true">');
    expect(await page.evaluate(() => (window as any).echoInjected)).toBeUndefined();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Keep the normal phone width while fitting the full card above the sticky save bar in its review image.
    await page.setViewportSize({ width: 390, height: 1600 });
    await page.locator('.model-settings').screenshot({ path: testInfo.outputPath('model-settings-mobile.png') });
  });
});
