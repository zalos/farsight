import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultConfig, initConfig, loadContext, saveConfig, trustConfig, validateConfig } from '../dist/config.js';
import { readConnection, writeConnection } from '../dist/installation.js';
import { resolveSecret } from '../dist/secrets.js';
import { pinCredentialOrigin } from '../dist/trust.js';

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
  pinCredentialOrigin(ref, 'https://models.example.com');
  let calls = 0;
  const runner = async () => { calls++; return 'synthetic-secret'; };
  await assert.rejects(resolveSecret(ref, { origin: 'https://other.example.com', runner }), /not approved/);
  await assert.rejects(resolveSecret(ref, { runner }), /not approved/);
  assert.throws(() => pinCredentialOrigin(ref, 'https://other.example.com'), /not approved/);
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
