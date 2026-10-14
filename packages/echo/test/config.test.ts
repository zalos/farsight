import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, initConfig, loadContext, saveConfig, updateConfig, validateConfig, ollamaSettings, validateModelSettings } from '../dist/config.js';
import { contextFingerprint } from '../dist/sessions.js';
import type { EchoContext } from '../dist/types.js';
import { pinCredentialOrigin } from '../dist/trust.js';
import { parseKeychainRef, resolveSecret } from '../dist/secrets.js';

test('exact embedding origins and TLS hostnames survive canonical isolation checks', () => {
  const config = defaultConfig();
  config.profiles.personal!.web.farsightOrigin = 'http://localhost:4478';
  config.profiles.personal!.model.baseUrl = 'https://localhost:11434';
  config.profiles.work!.backend = { mode: 'external', url: 'https://localhost:5711' };
  const result = validateConfig(config);
  assert.equal(result.profiles.personal!.web.farsightOrigin, 'http://localhost:4478');
  assert.equal(result.profiles.personal!.model.baseUrl, 'https://localhost:11434');
  assert.equal(result.profiles.work!.backend.url, 'https://localhost:5711');
});

test('defaults are isolated and validate without credentials or selected models', () => {
  const config = validateConfig(defaultConfig());
  assert.equal(config.defaultProfile, 'personal');
  assert.equal(config.profiles.personal!.backend.url, 'http://127.0.0.1:4611');
  assert.equal(config.profiles.work!.backend.url, 'http://127.0.0.1:4711');
  assert.equal(config.profiles.personal!.model.model, '');
  assert.equal(config.profiles.personal!.model.baseUrl, config.profiles.work!.model.baseUrl);
  assert.notEqual(config.profiles.personal, defaultConfig().profiles.personal);
});

test('older settings retain their hook choices while VS Code defaults off', () => {
  const config = defaultConfig();
  delete config.profiles.personal!.hooks.vscode;
  config.profiles.personal!.hooks.claude = true;
  assert.deepEqual(validateConfig(config).profiles.personal!.hooks, { claude: true, codex: false, vscode: false });
  config.profiles.personal!.hooks.vscode = true;
  assert.equal(validateConfig(config).profiles.personal!.hooks.vscode, true);
  (config.profiles.personal!.hooks as any).vscode = 'true';
  assert.throws(() => validateConfig(config));
});

test('unknown fields, credential values, wildcard identities and unsafe profile names fail without echoing input', () => {
  const changes: ((value: any) => void)[] = [
    value => { value.profiles.personal.backend.apiKey = 'literal-private-value'; },
    value => { value.profiles.personal.backend.secretRef = 'literal-private-value'; },
    value => { value.profiles.personal.backend.secretRef = 'keychain:farsight-echo/managed'; },
    value => { value.profiles.personal.model.secretRef = 'env:OPENAI_API_KEY'; },
    value => { value.profiles.personal.identity.individual = '*'; },
    value => { value.profiles.personal.identity.team = 'team*'; },
    value => { value.profiles.personal.identity.project = ''; },
    value => { value.profiles.personal.skills.extra = true; },
    value => { value.profiles.personal.budget.timeoutMs = -1; },
    value => { value.profiles.personal.web.port = 4480.5; },
    value => { value.profiles['../work'] = value.profiles.work; },
    value => { value.profiles.constructor = value.profiles.work; },
    value => { value.defaultProfile = 'unknown'; },
  ];
  for (const change of changes) {
    const config = defaultConfig(); change(config);
    assert.throws(() => validateConfig(config), error => error instanceof Error && !error.message.includes('literal-private-value'));
  }
});

test('URL aliases cannot share a store; every managed service and settings port is reserved', () => {
  for (const url of ['http://localhost:4611/', 'http://LOCALHOST.:4611', 'http://127.1:4611', 'http://[::1]:4611']) {
    const config = defaultConfig(); config.profiles.work!.backend.url = url;
    assert.throws(() => validateConfig(config), /own memory address/);
  }
  for (const port of [4611, 4612, 4613, 50634, 4711, 4712, 4713, 50734, 4480]) {
    const config = defaultConfig(); config.profiles.work!.web.port = port;
    assert.throws(() => validateConfig(config), /own memory address/);
  }
  for (const port of [4612, 4613, 19400]) {
    const config = defaultConfig(); config.profiles.work!.backend.url = `http://127.0.0.1:${port}`;
    if (port === 19400) config.profiles.work!.web.port = 19402;
    assert.throws(() => validateConfig(config), /own memory address/);
  }
  const modelCollision = defaultConfig();
  modelCollision.profiles.personal!.model.baseUrl = 'http://localhost:4712';
  assert.throws(() => validateConfig(modelCollision), /own memory address/);
});

test('service origins reject embedded credentials and unsafe transport, while remote HTTPS remains configurable', () => {
  for (const url of ['https://user:literal-private-value@example.com', 'http://example.com', 'http://0.0.0.0:4611', 'file:///tmp/store', 'http://localhost:4611/path', 'http://localhost:4611/..', 'http://localhost:4611?x=1', 'http://localhost:4611#fragment', 'https://localhost:4611']) {
    const config = defaultConfig(); config.profiles.personal!.backend.url = url;
    assert.throws(() => validateConfig(config), error => error instanceof Error && !error.message.includes('literal-private-value'));
  }
  const config = defaultConfig();
  config.profiles.work!.backend = { mode: 'external', url: 'https://memory.example.com/', secretRef: 'keychain:farsight-echo/work-example' };
  config.profiles.work!.model = { provider: 'openai-compatible', baseUrl: 'https://models.example.com', model: 'configured-model', secretRef: 'keychain:farsight-echo/model-example' };
  const validated = validateConfig(config);
  assert.equal(validated.profiles.work!.backend.url, 'https://memory.example.com');
  assert.equal(validated.profiles.work!.model.secretRef, 'keychain:farsight-echo/model-example');
});

test('configuration writes are private and atomic; initialization cannot overwrite under concurrency', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'echo-config-test-'));
  const path = join(directory, '.echo', 'settings.json');
  try {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => initConfig(path)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, '.echo'))).mode & 0o777, 0o700);
    const config = defaultConfig(); config.profiles.work!.skills.directories = ['../skills'];
    await saveConfig(path, config);
    const context = loadContext(path, 'work');
    assert.equal(context.profile.skills.directories[0], join(await realpath(directory), 'skills'));
    assert.equal(context.config.profiles.work!.skills.directories[0], '../skills');
    assert.equal(context.dataDirectory, join(await realpath(directory), '.echo', 'profiles', 'work'));
    const original = await readFile(path, 'utf8');
    config.profiles.work!.identity.project = '*';
    await assert.rejects(saveConfig(path, config));
    assert.equal(await readFile(path, 'utf8'), original);
    await assert.rejects(initConfig(path), /already exist/);
    await symlink(path, join(directory, 'settings-alias.json'));
    assert.throws(() => loadContext(join(directory, 'settings-alias.json')), /could not be read/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('keychain access never inherits credentials or returns command diagnostics in an error', async () => {
  assert.equal(await resolveSecret(), '');
  assert.equal(parseKeychainRef('keychain:farsight-echo/provider/account'), null);
  assert.equal(parseKeychainRef('keychain:farsight/jira-example'), null);
  await pinCredentialOrigin('keychain:farsight-echo/test', 'https://models.example.com');
  const calls: [string, string[]][] = [];
  const runner = async (command: string, args: string[]) => { calls.push([command, args]); return 'test-secret'; };
  assert.equal(await resolveSecret('keychain:farsight-echo/test', { platform: 'darwin', runner, origin: 'https://models.example.com' }), 'test-secret');
  assert.deepEqual(calls[0], ['security', ['find-generic-password', '-s', 'farsight-echo', '-a', 'test', '-w']]);
  await resolveSecret('keychain:farsight-echo/test', { platform: 'linux', runner, origin: 'https://models.example.com' });
  assert.equal(calls[1]![0], 'secret-tool');
  await assert.rejects(resolveSecret('keychain:farsight-echo/test', { platform: 'darwin', origin: 'https://models.example.com', runner: async () => { throw new Error('secret-output-value'); } }), error => error instanceof Error && !error.message.includes('secret-output-value'));
  await assert.rejects(resolveSecret('literal-private-value'), error => error instanceof Error && !error.message.includes('literal-private-value'));
  await assert.rejects(resolveSecret('keychain:farsight-echo/test', { platform: 'win32', runner, origin: 'https://models.example.com' }), /does not yet/);
});

test('concurrent shared settings updates merge fresh values and failed edits release the writer lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'echo-shared-settings-'));
  const path = join(directory, 'settings.json');
  try {
    await initConfig(path);
    await Promise.all(['claude', 'codex', 'vscode'].map(host => updateConfig(path, async config => {
      await new Promise(resolve => setTimeout(resolve, 20));
      config.profiles.personal!.hooks[host as 'claude' | 'codex' | 'vscode'] = true;
      return config;
    })));
    assert.deepEqual(loadContext(path).profile.hooks, { claude: true, codex: true, vscode: true });
    await assert.rejects(updateConfig(path, () => { throw new Error('synthetic edit failure'); }), /synthetic edit failure/);
    await updateConfig(path, config => { config.profiles.personal!.model.model = 'selected'; return config; });
    assert.equal(loadContext(path).profile.model.model, 'selected');
    await assert.rejects(stat(join(directory, '.echo-settings.lock')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('sub-mind defaults keep legacy profiles off and normalize bounded partial policies', async () => {
  const { submindSettings } = await import('../dist/config.js');
  const config = defaultConfig();
  const profile = config.profiles.personal!;
  assert.equal(profile.submind!.mode, 'off');
  delete profile.submind;
  const legacy = validateConfig(config).profiles.personal!;
  assert.equal(legacy.submind, undefined);
  assert.equal(submindSettings(legacy).mode, 'off');
  (profile as any).submind = { mode: 'mock', maxSteps: 2 };
  assert.deepEqual(validateConfig(config).profiles.personal!.submind, {
    mode: 'mock', hookResearch: 'manual', hookWaitMs: 20000, maxSteps: 2, maxSearches: 3, maxCandidates: 12, evidenceMaxChars: 12_000,
    inputMaxChars: 48_000, lookbackDays: 90, timeoutMs: 30_000, expandedMaxChars: 12_000,
  });
  for (const [key, value] of Object.entries({ mode: 'unknown', hookResearch: 'unknown', hookWaitMs: 60001, maxSteps: 9, maxSearches: 0, maxCandidates: 51,
    evidenceMaxChars: 127, inputMaxChars: 256_001, lookbackDays: 3651, timeoutMs: 99, expandedMaxChars: 64_001 })) {
    (profile as any).submind = { [key]: value };
    assert.throws(() => validateConfig(config));
  }
  for (const submind of [null, [], { mode: null }, { hookResearch: null }, { maxSteps: 1.5 }, { unexpected: true }]) {
    (profile as any).submind = submind;
    assert.throws(() => validateConfig(config));
  }
});

test('private network model transport requires explicit opt-in, literal private IPv4 and no credential', () => {
  for (const baseUrl of ['http://10.0.0.2:11434', 'http://172.16.0.2:11434', 'http://172.31.255.254:11434', 'http://192.168.1.25:11434']) {
    const config = defaultConfig();
    config.profiles.personal!.model.baseUrl = baseUrl;
    assert.throws(() => validateConfig(config));
    config.profiles.personal!.model.allowInsecureHttp = true;
    assert.equal(validateConfig(config).profiles.personal!.model.baseUrl, baseUrl);
    config.profiles.personal!.model.secretRef = 'keychain:farsight-echo/example-model';
    assert.throws(() => validateConfig(config), /encrypted model connection/);
  }
  for (const baseUrl of ['http://8.8.8.8', 'http://172.15.0.2', 'http://172.32.0.2', 'http://169.254.169.254',
    'http://100.64.0.1', 'http://0.0.0.0', 'http://desktop.local:11434', 'http://models.example.com',
    'http://10.1', 'http://0x0a000001', 'http://167772161', 'http://010.0.0.1', 'http://[fd00::1]:11434']) {
    const config = defaultConfig();
    config.profiles.personal!.model = { provider: 'ollama', baseUrl, model: 'example', allowInsecureHttp: true };
    assert.throws(() => validateConfig(config), /service address/);
  }
  const config = defaultConfig();
  (config.profiles.personal!.model as any).allowInsecureHttp = 'true';
  assert.throws(() => validateConfig(config));
  config.profiles.personal!.model = { provider: 'ollama', baseUrl: 'https://desktop.example.com', model: 'example' };
  assert.equal(validateConfig(config).profiles.personal!.model.baseUrl, 'https://desktop.example.com');
  config.profiles.personal!.backend = { mode: 'external', url: 'http://192.168.1.25:4611' };
  assert.throws(() => validateConfig(config), /service address/, 'model exception never changes backend transport');
});


test('native Ollama resources are bounded and effective defaults leave legacy configuration unchanged', () => {
  const config = defaultConfig();
  const original = JSON.stringify(config);
  const normalized = validateConfig(config);
  assert.deepEqual(ollamaSettings(normalized.profiles.personal!.model), { contextTokens: 4096, keepAliveSeconds: 0 });
  assert.equal(normalized.profiles.personal!.model.ollama, undefined);
  assert.equal(JSON.stringify(config), original);
  for (const settings of [
    { contextTokens: 2048, keepAliveSeconds: 0 },
    { contextTokens: 131_072, keepAliveSeconds: 3600 },
  ]) {
    config.profiles.personal!.model.ollama = settings;
    assert.deepEqual(validateConfig(config).profiles.personal!.model.ollama, settings);
    config.profiles.personal!.model.provider = 'openai-compatible';
    assert.deepEqual(validateConfig(config).profiles.personal!.model.ollama, settings, 'preserves inactive settings when switching providers');
  }
  for (const settings of [
    null, [], {}, { contextTokens: 4096 }, { keepAliveSeconds: 0 },
    { contextTokens: 2047, keepAliveSeconds: 0 }, { contextTokens: 131_073, keepAliveSeconds: 0 },
    { contextTokens: 4096.5, keepAliveSeconds: 0 }, { contextTokens: '4096', keepAliveSeconds: 0 },
    { contextTokens: 4096, keepAliveSeconds: -1 }, { contextTokens: 4096, keepAliveSeconds: 3601 },
    { contextTokens: 4096, keepAliveSeconds: 0.5 }, { contextTokens: 4096, keepAliveSeconds: '0' },
    { contextTokens: 4096, keepAliveSeconds: 0, extra: 'private-invalid-setting' },
  ]) {
    (config.profiles.personal!.model as any).ollama = settings;
    assert.throws(() => validateConfig(config), error => error instanceof Error && !error.message.includes('private-invalid-setting'));
    assert.throws(() => validateModelSettings(config.profiles.personal!.model), 'dispatch validation matches settings validation');
  }
});

test('session fingerprint treats omitted Ollama resources as defaults and detects resource changes', () => {
  const config = defaultConfig();
  const ctx: EchoContext = {
    config, profileId: 'personal', profile: config.profiles.personal!, configPath: '/example/.echo/settings.json',
    directory: '/example/.echo', dataDirectory: '/example/.echo/profiles/personal',
  };
  const legacy = contextFingerprint(ctx);
  ctx.profile.model.ollama = { contextTokens: 4096, keepAliveSeconds: 0 };
  assert.equal(contextFingerprint(ctx), legacy);
  ctx.profile.model.ollama.contextTokens = 8192;
  assert.notEqual(contextFingerprint(ctx), legacy);
  ctx.profile.model.ollama = { contextTokens: 4096, keepAliveSeconds: 60 };
  assert.notEqual(contextFingerprint(ctx), legacy);
});


test('background prompt research requires a saved explicit policy', async () => {
  const { submindSettings } = await import('../dist/config.js');
  const config = defaultConfig();
  assert.equal(submindSettings(config.profiles.personal!).hookResearch, 'manual');
  config.profiles.personal!.submind!.hookResearch = 'background';
  assert.equal(validateConfig(config).profiles.personal!.submind!.hookResearch, 'background');
  assert.equal(submindSettings(config.profiles.work!).hookResearch, 'manual');
});


test('prompt wait policy has a bounded limit independent of the model deadline', async () => {
  const { submindSettings } = await import('../dist/config.js');
  const config = defaultConfig();
  const profile = config.profiles.personal!;
  assert.equal(submindSettings(profile).hookWaitMs, 20000);
  profile.submind!.hookResearch = 'wait'; profile.submind!.hookWaitMs = 60000;
  assert.equal(validateConfig(config).profiles.personal!.submind!.hookWaitMs, 60000);
  for (const limit of [0, 99, 60001, 1.5, '20000', null]) {
    (profile.submind as any).hookWaitMs = limit;
    assert.throws(() => validateConfig(config));
  }
});
