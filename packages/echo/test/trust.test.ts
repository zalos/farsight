import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { defaultConfig, initConfig, loadContext, saveConfig, trustConfig, validateConfig } from '../dist/config.js';
import { readConnection, writeConnection } from '../dist/installation.js';
import { resolveSecret } from '../dist/secrets.js';
import { pinCredentialOrigin, requireCredentialOrigin, trustDirectory } from '../dist/trust.js';

test('repository supplied settings and copied approvals cannot acquire user trust', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-trust-'));
  try {
    const first = join(root, 'a', 'settings.json'), second = join(root, 'b', 'settings.json');
    await mkdir(join(root, 'a')); await mkdir(join(root, 'b'));
    await writeFile(first, JSON.stringify(defaultConfig()));
    assert.throws(() => loadContext(first), /not trusted/);
    await trustConfig(first);
    assert.equal(loadContext(first).profileId, 'personal');
    await writeFile(second, await readFile(first));
    assert.throws(() => loadContext(second), /not trusted/);
    const changed = defaultConfig(); changed.profiles.personal!.model.baseUrl = 'https://unapproved.example.com';
    await writeFile(first, JSON.stringify(changed));
    assert.throws(() => loadContext(first), /not trusted/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Echo saves enroll exact settings; unrelated application credentials are never allowed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-trusted-save-'));
  try {
    const path = join(root, 'settings.json');
    await initConfig(path);
    const config = loadContext(path).config;
    config.profiles.personal!.model.model = 'changed-model';
    await saveConfig(path, config);
    assert.equal(loadContext(path).profile.model.model, 'changed-model');
    for (const ref of ['keychain:farsight/jira-example', 'keychain:echo/model', 'env:API_KEY']) {
      config.profiles.personal!.model.secretRef = ref;
      assert.throws(() => validateConfig(config), /keychain:farsight-echo/);
      let calls = 0;
      await assert.rejects(resolveSecret(ref, { origin: 'https://unapproved.example.com', runner: async () => { calls++; return 'unreachable'; } }));
      assert.equal(calls, 0);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('origin changes cannot redirect a saved Echo credential before keychain access', async () => {
  const ref = `keychain:farsight-echo/test-${randomUUID()}`;
  await pinCredentialOrigin(ref, 'https://models.example.com');
  let calls = 0;
  const runner = async () => { calls++; return 'synthetic-secret'; };
  await assert.rejects(resolveSecret(ref, { origin: 'https://other.example.com', runner }), /not approved/);
  await assert.rejects(resolveSecret(ref, { runner }), /not approved/);
  await assert.rejects(pinCredentialOrigin(ref, 'https://other.example.com'), /not approved/);
  assert.equal(calls, 0);
  assert.equal(await resolveSecret(ref, { origin: 'https://models.example.com', platform: 'darwin', runner }), 'synthetic-secret');
  assert.equal(calls, 1);
});

test('a repository cannot opt itself into a trusted global profile with a copied pointer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-connection-trust-'));
  try {
    const a = join(root, 'a'), b = join(root, 'b'), configPath = join(root, 'user', 'settings.json');
    await mkdir(a); await mkdir(join(b, '.echo'), { recursive: true });
    await initConfig(configPath);
    await writeConnection(a, { configPath, profileId: 'personal' });
    assert.equal(readConnection(a)?.profileId, 'personal');
    await writeFile(join(b, '.echo', 'connection.json'), await readFile(join(a, '.echo', 'connection.json')));
    assert.throws(() => readConnection(b), /not trusted/);
    await writeConnection(b, { configPath, profileId: 'personal' });
    assert.equal(readConnection(b)?.profileId, 'personal');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('duplicate origins and existing pin conflicts refuse the whole mapping without reserving earlier references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-pin-preflight-'));
  try {
    const shared = `keychain:farsight-echo/test-${randomUUID()}`;
    const config = defaultConfig();
    config.profiles.personal!.model.secretRef = shared;
    config.profiles.personal!.model.baseUrl = 'https://first.example.com';
    config.profiles.work!.model.secretRef = shared;
    config.profiles.work!.model.baseUrl = 'https://second.example.com';
    const path = join(root, 'settings.json');
    await assert.rejects(saveConfig(path, config));
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    await pinCredentialOrigin(shared, 'https://second.example.com');
    const fresh = `keychain:farsight-echo/test-${randomUUID()}`;
    config.profiles.personal!.model.secretRef = fresh;
    config.profiles.work!.model.baseUrl = 'https://third.example.com';
    await assert.rejects(saveConfig(path, config));
    await pinCredentialOrigin(fresh, 'https://fourth.example.com');
    requireCredentialOrigin(shared, 'https://second.example.com');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed exclusive initialization rolls back newly selected credentials and preserves prior pins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-pin-init-'));
  try {
    const path = join(root, 'settings.json');
    await initConfig(path);
    const before = await readFile(path, 'utf8');
    const existing = `keychain:farsight-echo/test-${randomUUID()}`;
    const fresh = `keychain:farsight-echo/test-${randomUUID()}`;
    await pinCredentialOrigin(existing, 'https://existing.example.com');
    const config = defaultConfig();
    config.profiles.personal!.model = { ...config.profiles.personal!.model, secretRef: fresh, baseUrl: 'https://first.example.com' };
    config.profiles.work!.model = { ...config.profiles.work!.model, secretRef: existing, baseUrl: 'https://existing.example.com' };
    await assert.rejects(initConfig(path, config), /already exist/);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.equal(loadContext(path).profile.model.secretRef, undefined);
    await pinCredentialOrigin(fresh, 'https://second.example.com');
    requireCredentialOrigin(existing, 'https://existing.example.com');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed settings approval write rolls back new pins and leaves the changed file untrusted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-pin-write-'));
  let receipt: string | undefined;
  try {
    const path = join(root, 'settings.json');
    await initConfig(path);
    const subject = await realpath(path);
    receipt = join(trustDirectory(), 'configs', `${createHash('sha256').update(subject).digest('hex')}.json`);
    await rm(receipt);
    await mkdir(receipt, { mode: 0o700 });
    const ref = `keychain:farsight-echo/test-${randomUUID()}`;
    const config = defaultConfig();
    config.profiles.personal!.model = { ...config.profiles.personal!.model, secretRef: ref, baseUrl: 'https://first.example.com' };
    await assert.rejects(saveConfig(path, config));
    assert.throws(() => loadContext(path), /not trusted/);
    await pinCredentialOrigin(ref, 'https://second.example.com');
  } finally {
    if (receipt) await rm(receipt, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent processes saving different settings files cannot claim the same credential for different origins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-pin-concurrent-'));
  try {
    const ref = `keychain:farsight-echo/test-${randomUUID()}`;
    const module = new URL('../dist/config.js', import.meta.url).href;
    const script = `
      import { defaultConfig, saveConfig } from ${JSON.stringify(module)};
      const config = defaultConfig();
      config.profiles.personal.model.baseUrl = process.argv[2];
      config.profiles.personal.model.secretRef = process.argv[3];
      try { await saveConfig(process.argv[1], config); process.stdout.write('saved'); }
      catch { process.stdout.write('refused'); }
    `;
    const origins = ['https://first.example.com', 'https://second.example.com'];
    const outcomes = await Promise.all(origins.map((origin, index) => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, join(root, String(index), 'settings.json'), origin, ref], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output += String(chunk); });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve(output) : reject(new Error('The settings writer failed unexpectedly.')));
    })));
    assert.deepEqual([...outcomes].sort(), ['refused', 'saved']);
    const winner = outcomes.indexOf('saved');
    requireCredentialOrigin(ref, origins[winner]);
    assert.equal(loadContext(join(root, String(winner), 'settings.json')).profile.model.baseUrl, origins[winner]);
    await assert.rejects(readFile(join(root, String(1 - winner), 'settings.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
