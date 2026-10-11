import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, initConfig, loadContext, saveConfig, validateConfig } from '../dist/config.js';
import { parseKeychainRef, resolveSecret } from '../dist/secrets.js';

test('defaults are isolated and validate without credentials or selected models', () => {
  const config = validateConfig(defaultConfig());
  assert.equal(config.defaultProfile, 'personal');
  assert.equal(config.profiles.personal!.backend.url, 'http://127.0.0.1:4611');
  assert.equal(config.profiles.work!.backend.url, 'http://127.0.0.1:4711');
  assert.equal(config.profiles.personal!.model.model, '');
  assert.equal(config.profiles.personal!.model.baseUrl, config.profiles.work!.model.baseUrl);
  assert.notEqual(config.profiles.personal, defaultConfig().profiles.personal);
});

test('unknown fields, credential values, wildcard identities and unsafe profile names fail without echoing input', () => {
  const changes: ((value: any) => void)[] = [
    value => { value.profiles.personal.backend.apiKey = 'literal-private-value'; },
    value => { value.profiles.personal.backend.secretRef = 'literal-private-value'; },
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
});

test('service origins reject embedded credentials and unsafe transport, while remote HTTPS remains configurable', () => {
  for (const url of ['https://user:literal-private-value@example.com', 'http://example.com', 'http://0.0.0.0:4611', 'file:///tmp/store', 'http://localhost:4611/path', 'http://localhost:4611?x=1', 'http://localhost:4611#fragment']) {
    const config = defaultConfig(); config.profiles.personal!.backend.url = url;
    assert.throws(() => validateConfig(config), error => error instanceof Error && !error.message.includes('literal-private-value'));
  }
  const config = defaultConfig();
  config.profiles.work!.backend = { mode: 'external', url: 'https://memory.example.com/', secretRef: 'keychain:echo/work-example' };
  config.profiles.work!.model = { provider: 'openai-compatible', baseUrl: 'https://models.example.com', model: 'configured-model', secretRef: 'keychain:echo/model-example' };
  const validated = validateConfig(config);
  assert.equal(validated.profiles.work!.backend.url, 'https://memory.example.com');
  assert.equal(validated.profiles.work!.model.secretRef, 'keychain:echo/model-example');
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
    assert.equal(loadContext(join(directory, 'settings-alias.json')).configPath, loadContext(path).configPath);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('keychain access never inherits credentials or returns command diagnostics in an error', async () => {
  assert.equal(await resolveSecret(), '');
  assert.equal(parseKeychainRef('keychain:echo/provider/account')!.service, 'echo/provider');
  const calls: [string, string[]][] = [];
  const runner = async (command: string, args: string[]) => { calls.push([command, args]); return 'test-secret'; };
  assert.equal(await resolveSecret('keychain:echo/test', { platform: 'darwin', runner }), 'test-secret');
  assert.deepEqual(calls[0], ['security', ['find-generic-password', '-s', 'echo', '-a', 'test', '-w']]);
  await resolveSecret('keychain:echo/test', { platform: 'linux', runner });
  assert.equal(calls[1]![0], 'secret-tool');
  await assert.rejects(resolveSecret('keychain:echo/test', { platform: 'darwin', runner: async () => { throw new Error('secret-output-value'); } }), error => error instanceof Error && !error.message.includes('secret-output-value'));
  await assert.rejects(resolveSecret('literal-private-value'), error => error instanceof Error && !error.message.includes('literal-private-value'));
  await assert.rejects(resolveSecret('keychain:echo/test', { platform: 'win32', runner }), /does not yet/);
});
