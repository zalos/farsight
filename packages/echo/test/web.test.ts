import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startWeb } from '../dist/web.js';
import type { EchoConfig, EchoContext } from '../src/types.js';

async function rawRequest(url: string, headers: Record<string, string>) {
  return new Promise<{ status: number | undefined; cors: unknown }>((resolve, reject) => {
    const req = request(url, { headers }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, cors: res.headers['access-control-allow-origin'] }));
    });
    req.on('error', reject);
    req.end();
  });
}

function fixture(): EchoConfig {
  const personal = {
    identity: { individual: 'person-example', project: 'project-example' },
    backend: { mode: 'managed' as const, url: 'http://127.0.0.1:4611' },
    model: { provider: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', model: 'fixture-model' },
    web: { port: 4480, farsightOrigin: 'http://127.0.0.1:4477' },
    hooks: { claude: false, codex: false },
    skills: { directories: [] },
    budget: { briefMaxChars: 1200, modelMaxTokens: 256, timeoutMs: 10000 },
  };
  return { version: 1, defaultProfile: 'personal', profiles: {
    personal,
    work: { ...structuredClone(personal), identity: { individual: 'work-example', team: 'team-example', project: 'work-project' }, backend: { mode: 'managed', url: 'http://127.0.0.1:4711' }, web: { port: 4481 } },
  } };
}

async function setup(t: TestContext, checks?: Parameters<typeof startWeb>[1]) {
  const directory = await mkdtemp(join(tmpdir(), 'echo-web-'));
  const configPath = join(directory, 'config.json');
  const config = fixture();
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const ctx: EchoContext = { configPath, config, profileId: 'personal', profile: structuredClone(config.profiles.personal!), directory, dataDirectory: join(directory, 'personal') };
  ctx.profile.web.port = 0;
  const view = await startWeb(ctx, checks);
  t.after(async () => { await view.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...view, ctx, configPath, config };
}

test('settings reads reject foreign hosts and browser origins, including foreign reads', async t => {
  const view = await setup(t);
  for (const headers of [
    { Host: 'attacker.example' },
    { Origin: 'https://attacker.example' },
    { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { Origin: 'http://127.0.0.1:4477' },
  ]) {
    // Native fetch normalizes Host; exercise the real HTTP boundary directly.
    const response = await rawRequest(`${view.url}/api/settings`, headers);
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.cors, undefined);
  }
  const response = await fetch(`${view.url}/api/settings`, { headers: { Origin: view.url, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('settings page permits only the exact configured local frame origin and serves fixed assets', async t => {
  const view = await setup(t);
  const response = await fetch(view.url);
  assert.equal(response.status, 200);
  const csp = response.headers.get('content-security-policy')!;
  assert.match(csp, /frame-ancestors 'self' http:\/\/127\.0\.0\.1:4477(?:;|$)/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline|\*/);
  assert.match(await response.text(), /<script type="module" src="\/app\.js">/);
  for (const asset of ['/app.js', '/style.css', '/api/strings']) assert.equal((await fetch(`${view.url}${asset}`)).status, 200);
  const navigation = { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' };
  assert.equal((await rawRequest(view.url, navigation)).status, 200);
  assert.equal((await rawRequest(`${view.url}/api/settings`, navigation)).status, 403);
  assert.equal((await fetch(`${view.url}/config.json`)).status, 404);
  const bad = structuredClone(view.ctx);
  bad.profile.web.farsightOrigin = 'https://attacker.example';
  await assert.rejects(() => startWeb(bad));
});

test('saving preserves other profiles and keeps the running context unchanged', async t => {
  const view = await setup(t);
  const get = await fetch(`${view.url}/api/settings`);
  const state = await get.json();
  assert.equal(state.revision, get.headers.get('etag'));
  state.config.profiles.personal.identity.project = 'next-project';
  state.config.profiles.personal.hooks.claude = true;
  const saved = await fetch(`${view.url}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': state.revision }, body: JSON.stringify(state.config) });
  assert.equal(saved.status, 200);
  const result = await saved.json();
  assert.equal(result.restartRequired, true);
  assert.notEqual(result.revision, state.revision);
  const disk = JSON.parse(await readFile(view.configPath, 'utf8'));
  assert.equal(disk.profiles.personal.identity.project, 'next-project');
  assert.deepEqual(disk.profiles.work, view.config.profiles.work);
  assert.equal(view.ctx.profile.identity.project, 'project-example');
  assert.equal(view.ctx.profile.hooks.claude, false);
  const again = await (await fetch(`${view.url}/api/settings`)).json();
  assert.equal(again.running.identity.project, 'project-example');
  assert.equal(again.config.profiles.personal.identity.project, 'next-project');
});

test('concurrent editors cannot overwrite a newer revision', async t => {
  const view = await setup(t);
  const state = await (await fetch(`${view.url}/api/settings`)).json();
  const send = (project: string) => {
    const config = structuredClone(state.config);
    config.profiles.personal.identity.project = project;
    return fetch(`${view.url}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': state.revision }, body: JSON.stringify(config) });
  };
  const outcomes = await Promise.all([send('first-edit'), send('second-edit')]);
  assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]);
  const winner = await outcomes.find(r => r.status === 200)!.json();
  const disk = JSON.parse(await readFile(view.configPath, 'utf8'));
  assert.equal(disk.profiles.personal.identity.project, winner.config.profiles.personal.identity.project);
});

test('writes require a revision, JSON content type, valid shape and a bounded body', async t => {
  const view = await setup(t);
  const state = await (await fetch(`${view.url}/api/settings`)).json();
  const put = (body: string, headers: Record<string, string>) => fetch(`${view.url}/api/settings`, { method: 'PUT', headers, body });
  assert.equal((await put('{}', { 'Content-Type': 'application/json' })).status, 428);
  assert.equal((await put('{}', { 'Content-Type': 'text/plain', 'If-Match': state.revision })).status, 415);
  assert.equal((await put('{', { 'Content-Type': 'application/json', 'If-Match': state.revision })).status, 400);
  assert.equal((await put(JSON.stringify({ text: 'x'.repeat(70 * 1024) }), { 'Content-Type': 'application/json', 'If-Match': state.revision })).status, 413);
  state.config.profiles.personal.model.secretRef = 'never-return-this-private-value';
  const invalid = await put(JSON.stringify(state.config), { 'Content-Type': 'application/json', 'If-Match': state.revision });
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(await invalid.text(), /never-return-this-private-value/);
  assert.deepEqual(JSON.parse(await readFile(view.configPath, 'utf8')), view.config);
});

test('malformed saved configuration and failing diagnostics never expose exception details', async t => {
  const view = await setup(t, { checks: async () => { throw new Error('never-return-this-private-value'); } });
  const checks = await fetch(`${view.url}/api/checks`);
  assert.equal(checks.status, 503);
  assert.doesNotMatch(await checks.text(), /never-return-this-private-value/);
  await writeFile(view.configPath, 'never-return-this-private-value');
  const settings = await fetch(`${view.url}/api/settings`);
  assert.equal(settings.status, 503);
  assert.doesNotMatch(await settings.text(), /never-return-this-private-value/);
});

test('diagnostics report availability explicitly', async t => {
  const view = await setup(t);
  assert.deepEqual(await (await fetch(`${view.url}/api/checks`)).json(), { available: false, checks: [] });
  const active = await setup(t, { checks: async () => [{ name: 'Ollama', ok: true, detail: 'Available' }] });
  assert.deepEqual(await (await fetch(`${active.url}/api/checks`)).json(), { available: true, checks: [{ name: 'Ollama', ok: true, detail: 'Available' }] });
});
