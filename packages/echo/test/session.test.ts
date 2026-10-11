import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initConfig, loadContext, saveConfig } from '../dist/config.js';
import { bindSession } from '../dist/sessions.js';
import type { EchoContext } from '../dist/types.js';

async function fixture(run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'echo-sessions-test-'));
  const path = join(directory, 'settings.json');
  try { await initConfig(path); await run(path); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('sessions retain their profile binding after reloading settings and preserve only metadata', async () => fixture(async path => {
  const personal = loadContext(path, 'personal');
  await bindSession(personal, 'claude', 'a-session-private-identifier');
  await bindSession(loadContext(path, 'personal'), 'claude', 'a-session-private-identifier');
  await assert.rejects(bindSession(loadContext(path, 'work'), 'claude', 'a-session-private-identifier'), /already bound/);
  await bindSession(loadContext(path, 'work'), 'codex', 'a-session-private-identifier');
  const names = await readdir(join(personal.directory, 'sessions'));
  assert.equal(names.length, 2);
  for (const name of names) {
    assert.match(name, /^[a-f0-9]{64}\.json$/);
    const content = await readFile(join(personal.directory, 'sessions', name), 'utf8');
    assert.equal(content.includes('a-session-private-identifier'), false);
    assert.equal(content.includes('http://'), false);
  }
}));

test('simultaneous cross-profile first binds admit exactly one profile, including repeated callers', async () => fixture(async path => {
  const contexts = [loadContext(path, 'personal'), loadContext(path, 'work')];
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => bindSession(contexts[index % 2]!, 'codex', 'racing-session')));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 10);
  assert.equal(results.filter(result => result.status === 'rejected').length, 10);
  const retries = await Promise.allSettled(contexts.map(ctx => bindSession(ctx, 'codex', 'racing-session')));
  assert.equal(retries.filter(result => result.status === 'fulfilled').length, 1);
}));

test('identity, model, store and config selection changes require a new session', async () => fixture(async path => {
  const original = loadContext(path);
  await bindSession(original, 'claude', 'immutable-session');
  const changes: ((context: EchoContext) => void)[] = [
    context => { context.profile.identity.individual = 'another'; },
    context => { context.profile.identity.project = 'another'; },
    context => { context.profile.identity.team = 'another'; },
    context => { context.profile.model.model = 'another'; },
    context => { context.profile.model.baseUrl = 'https://models.example.com'; },
    context => { context.profile.backend.url = 'https://memory.example.com'; },
    context => { context.profile.backend.secretRef = 'keychain:echo/another'; },
    context => { context.configPath = `${context.directory}/other.json`; },
  ];
  for (const change of changes) {
    const context = structuredClone(original); change(context);
    await assert.rejects(bindSession(context, 'claude', 'immutable-session'), /already bound/);
  }
  const config = structuredClone(original.config);
  config.profiles.personal!.model.model = 'a-selected-model';
  await saveConfig(path, config);
  await assert.rejects(bindSession(loadContext(path), 'claude', 'immutable-session'), /already bound/);
  await bindSession(loadContext(path), 'claude', 'a-new-session');
}));

test('corrupt bindings and missing session identifiers fail closed', async () => fixture(async path => {
  const context = loadContext(path);
  for (const id of ['', '\n', 'x'.repeat(1025)]) await assert.rejects(bindSession(context, 'codex', id), /valid host/);
  await bindSession(context, 'codex', 'corrupt-session');
  const directory = join(context.directory, 'sessions');
  const [name] = await readdir(directory);
  await writeFile(join(directory, name!), '{');
  await assert.rejects(bindSession(context, 'codex', 'corrupt-session'), /could not be verified/);
}));
