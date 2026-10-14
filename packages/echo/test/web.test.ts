import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { startWeb } from '../dist/web.js';
import { saveConfig } from '../dist/config.js';
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
    hooks: { claude: false, codex: false, vscode: false },
    skills: { directories: [] },
    budget: { briefMaxChars: 1200, modelMaxTokens: 256, timeoutMs: 10000 },
  };
  return { version: 1, defaultProfile: 'personal', profiles: {
    personal,
    work: { ...structuredClone(personal), identity: { individual: 'work-example', team: 'team-example', project: 'work-project' }, backend: { mode: 'managed', url: 'http://127.0.0.1:4711' }, web: { port: 4481 } },
  } };
}

async function setup(t: TestContext, checks?: Parameters<typeof startWeb>[1], config = fixture()) {
  const directory = await mkdtemp(join(tmpdir(), 'echo-web-'));
  const configPath = join(directory, 'config.json');
  await saveConfig(configPath, config);
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
  state.config.defaultProfile = 'work';
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
  assert.equal(again.running.profileId, 'personal');
  assert.equal(again.running.dataDirectory, view.ctx.dataDirectory);
  assert.equal(again.config.defaultProfile, 'work');
  assert.equal(again.config.profiles.personal.identity.project, 'next-project');
});

test('installation metadata is read-only, reports the opened path, and remains separate from edited profiles', async t => {
  const installation = { scope: 'global' as const, configPath: '/unused/settings.json' };
  const view = await setup(t, { installation });
  installation.configPath = '/changed-after-start/settings.json';
  const state = await (await fetch(`${view.url}/api/settings`)).json();
  assert.deepEqual(state.installation, { scope: 'global', configPath: view.configPath });
  assert.equal(state.config.installation, undefined);
  const result = await fetch(`${view.url}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': state.revision },
    body: JSON.stringify({ ...state.config, installation: { scope: 'workspace', configPath: '/other/settings.json' } }),
  });
  assert.equal(result.status, 400);
  assert.deepEqual(JSON.parse(await readFile(view.configPath, 'utf8')), view.config);
  const next = await (await fetch(`${view.url}/api/settings`)).json();
  assert.deepEqual(next.installation, state.installation);
  assert.equal(next.running.profileId, 'personal');
});

test('installation defaults to an explicit custom location and copies only supported metadata', async t => {
  const fallback = await setup(t);
  const state = await (await fetch(`${fallback.url}/api/settings`)).json();
  assert.deepEqual(state.installation, { scope: 'custom', configPath: fallback.configPath });
  const installation = { scope: 'workspace' as const, configPath: '/unused/settings.json', workspaceRoot: '/workspace/example', privateValue: 'not-public' };
  const local = await setup(t, { installation });
  installation.workspaceRoot = '/changed-after-start';
  const response = await (await fetch(`${local.url}/api/settings`)).text();
  assert.doesNotMatch(response, /not-public|changed-after-start/);
  assert.deepEqual(JSON.parse(response).installation, { scope: 'workspace', configPath: local.configPath, workspaceRoot: '/workspace/example' });
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


test('legacy settings expose off defaults without adding a policy on read', async t => {
  const view = await setup(t);
  const before = await readFile(view.configPath, 'utf8');
  const state = await (await fetch(`${view.url}/api/settings`)).json();
  assert.equal(state.config.profiles.personal.submind, undefined);
  assert.equal(state.running.submindMode, 'off');
  assert.deepEqual(state.defaults.submind, {
    mode: 'off', hookResearch: 'manual', maxSteps: 3, maxSearches: 3, maxCandidates: 12, evidenceMaxChars: 12000,
    inputMaxChars: 48000, lookbackDays: 90, timeoutMs: 30000, expandedMaxChars: 12000,
  });
  assert.equal(await readFile(view.configPath, 'utf8'), before);
});

test('sub-mind and remote model policies roundtrip without switching running mode', async t => {
  const view = await setup(t);
  const state = await (await fetch(`${view.url}/api/settings`)).json();
  const policy = { ...state.defaults.submind, mode: 'mock', maxSteps: 5, lookbackDays: 365, inputMaxChars: 64000 };
  state.config.profiles.personal.submind = policy;
  state.config.profiles.personal.model = { provider: 'ollama', baseUrl: 'http://192.168.1.20:11434', model: 'fixture-model', allowInsecureHttp: true };
  const response = await fetch(`${view.url}/api/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': state.revision }, body: JSON.stringify(state.config),
  });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.deepEqual(saved.config.profiles.personal.submind, policy);
  assert.deepEqual(saved.config.profiles.personal.model, state.config.profiles.personal.model);
  const current = await (await fetch(`${view.url}/api/settings`)).json();
  assert.equal(current.running.submindMode, 'off');
  assert.deepEqual(current.config.profiles.work, view.config.profiles.work);
  assert.deepEqual(JSON.parse(await readFile(view.configPath, 'utf8')).profiles.personal.submind, policy);
  const stale = await fetch(`${view.url}/api/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': state.revision }, body: JSON.stringify(state.config),
  });
  assert.equal(stale.status, 409);
});

test('private-network transport and research bounds are validated before settings writes', async t => {
  const view = await setup(t);
  const state = await (await fetch(`${view.url}/api/settings`)).json();
  for (const change of [
    (config: EchoConfig) => { config.profiles.personal!.model = { provider: 'ollama', baseUrl: 'http://192.168.1.20:11434', model: 'fixture' }; },
    (config: EchoConfig) => { config.profiles.personal!.model = { provider: 'ollama', baseUrl: 'http://192.168.1.20:11434', model: 'fixture', allowInsecureHttp: true, secretRef: 'keychain:farsight-echo/fixture-private' }; },
    (config: EchoConfig) => { config.profiles.personal!.submind = { ...state.defaults.submind, maxSearches: 9 }; },
  ]) {
    const config = structuredClone(state.config);
    change(config);
    const response = await fetch(`${view.url}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': state.revision }, body: JSON.stringify(config),
    });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(JSON.parse(await readFile(view.configPath, 'utf8')), view.config);
});

test('opening and saving model-mode settings never contacts the model or runs diagnostics', async t => {
  let modelRequests = 0;
  let checks = 0;
  const model = createServer((_req, res) => { modelRequests++; res.writeHead(500); res.end(); });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => model.close(error => error ? reject(error) : resolve())));
  const address = model.address();
  assert.ok(address && typeof address !== 'string');
  const config = fixture();
  config.profiles.personal!.model.baseUrl = `http://127.0.0.1:${address.port}`;
  const view = await setup(t, { checks: async () => { checks++; return []; } }, config);
  const state = await (await fetch(`${view.url}/api/settings`)).json();
  for (const path of ['/', '/app.js', '/style.css', '/api/strings']) assert.equal((await fetch(`${view.url}${path}`)).status, 200);
  state.config.profiles.personal.submind = { ...state.defaults.submind, mode: 'model' };
  const response = await fetch(`${view.url}/api/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': state.revision }, body: JSON.stringify(state.config),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).config.profiles.personal.submind.mode, 'model');
  assert.equal(checks, 0);
  assert.equal(modelRequests, 0);
});
