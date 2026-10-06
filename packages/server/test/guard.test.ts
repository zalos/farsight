/**
 * The loopback server's request guard (src/guard.ts, docs/SECURITY.md): loopback
 * Host names only (DNS rebinding), no state change from another site (CSRF), and
 * PUT /api/settings refuses a shape the server cannot read or a secret value.
 *
 * Unit checks on the pure functions, then one real server on a free port in a
 * temp workspace. Nothing here touches the workspace graph or ports 4477/4478.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GraphStore } from '@farsight/core';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const dist = (f: string) => pathToFileURL(join(repoRoot, 'packages/server/dist', f)).href;
const { refuseRequest, hostnameOf } = await import(dist('guard.js'));
const { settingsProblem } = await import(dist('index.js'));

test('hostnameOf strips the port, keeps an IPv6 literal whole', () => {
  assert.equal(hostnameOf('localhost:4477'), 'localhost');
  assert.equal(hostnameOf('127.0.0.1'), '127.0.0.1');
  assert.equal(hostnameOf('[::1]:4477'), '[::1]');
  assert.equal(hostnameOf('Evil.Example:80'), 'evil.example');
});

test('refuseRequest: loopback Host names pass, any other name is refused', () => {
  for (const host of ['localhost:4477', '127.0.0.1:4477', '[::1]:4477', 'LOCALHOST:1']) {
    assert.equal(refuseRequest({ method: 'GET', headers: { host } }), null, host);
  }
  assert.equal(refuseRequest({ method: 'GET', headers: {} }), null, 'no Host (HTTP/1.0) passes');
  for (const host of ['evil.example:4477', 'localhost.evil.example', '127.0.0.2:4477', '0.0.0.0:4477']) {
    assert.match(refuseRequest({ method: 'GET', headers: { host } }) ?? '', /localhost only/, host);
  }
});

test('refuseRequest: a state change from another site or origin is refused', () => {
  const host = 'localhost:4477';
  const ok = (headers: Record<string, string>, method = 'POST') => refuseRequest({ method, headers: { host, ...headers } });
  assert.equal(ok({}), null, 'curl / CLI / MCP send neither header');
  assert.equal(ok({ origin: 'http://localhost:4477', 'sec-fetch-site': 'same-origin' }), null, 'the viewer itself');
  assert.equal(ok({ 'sec-fetch-site': 'none' }), null, 'typed by the user');
  assert.match(ok({ 'sec-fetch-site': 'cross-site' }) ?? '', /another site/);
  assert.match(ok({ 'sec-fetch-site': 'same-site' }) ?? '', /another site/, 'another localhost port is another origin');
  assert.match(ok({ origin: 'https://evil.example' }) ?? '', /another origin/);
  assert.match(ok({ origin: 'http://localhost:6006' }) ?? '', /another origin/);
  assert.match(ok({ origin: 'null' }) ?? '', /another origin/);
  assert.match(ok({ origin: 'https://evil.example' }, 'PUT') ?? '', /another origin/);
  assert.equal(ok({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, 'GET'), null, 'a read is left to CORS, which this server never opens');
});

test('settingsProblem: the shape the server reads, and never a secret value', () => {
  const src = { id: 'a', name: 'a', type: 'local', path: '.', enabled: true };
  assert.equal(settingsProblem({ sources: [src], collections: [] }), null);
  assert.equal(settingsProblem({ sources: [{ ...src, type: 'work', auth: { kind: 'api-token', user: 'dev@example.com', secret: 'keychain:farsight/jira-example' } }] }), null);
  assert.match(settingsProblem(null) ?? '', /JSON object/);
  assert.match(settingsProblem([]) ?? '', /JSON object/);
  assert.match(settingsProblem({}) ?? '', /sources must be an array/);
  assert.match(settingsProblem({ sources: [{ ...src, type: 'ftp' }] }) ?? '', /type must be one of/);
  assert.match(settingsProblem({ sources: [{ ...src, type: 'git', path: '--upload-pack=touch x' }] }) ?? '', /not a clone URL/);
  const pasted = 'not-a-reference-but-a-pasted-token';
  const why = settingsProblem({ sources: [{ ...src, type: 'work', auth: { secret: pasted } }] }) ?? '';
  assert.match(why, /keychain: or env: reference/);
  assert.ok(!why.includes(pasted), 'the refusal never echoes the value');
});

// ── one real server ────────────────────────────────────────────────────────

let work: string;
let port: number;
let child: ChildProcessWithoutNullStreams;
let log = '';

async function freePort(): Promise<number> {
  return new Promise<number>((res, rej) => {
    const probe = createServer();
    probe.once('error', rej);
    probe.listen(0, '127.0.0.1', () => {
      const a = probe.address();
      const p = typeof a === 'object' && a ? a.port : 0;
      probe.close(() => res(p));
    });
  });
}

/** node:http, because fetch will not let a caller set Host. */
function call(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((res, rej) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers: { host: `localhost:${port}`, ...headers } }, (resp) => {
      let text = '';
      resp.setEncoding('utf8');
      resp.on('data', (c) => (text += c));
      resp.on('end', () => res({ status: resp.statusCode ?? 0, text }));
    });
    r.on('error', rej);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'farsight-guard-'));
  new GraphStore().save(join(work, 'graph.json'));
  port = await freePort();
  const boot = `const { serveGraph } = await import(${JSON.stringify(dist('index.js'))});\n`
    + `serveGraph(${JSON.stringify(join(work, 'graph.json'))}, ${port}, ${JSON.stringify(work)});\n`;
  child = spawn(process.execPath, ['--input-type=module', '-e', boot], {
    cwd: work,
    env: { ...process.env, MODELHUB_DIR: join(work, 'modelhub'), FIGMA_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => { log += d; });
  child.stderr.on('data', (d: string) => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await call('GET', '/api/strings')).status === 200) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${log}`);
});

after(async () => {
  if (child && child.exitCode == null) {
    const gone = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  rmSync(work, { recursive: true, force: true });
});

test('server: a rebound Host cannot read the graph or the settings', async () => {
  assert.equal((await call('GET', '/graph')).status, 200);
  for (const path of ['/graph', '/api/settings', '/']) {
    const r = await call('GET', path, { host: `rebind.evil.example:${port}` });
    assert.equal(r.status, 403, path);
    assert.ok(!r.text.includes('"nodes"'), `${path} carries no graph`);
  }
});

test('server: a cross-site write is refused before it runs; the viewer and curl still write', async () => {
  const settings = JSON.stringify({ defaultLens: 'code', sources: [{ id: 'w', name: 'w', type: 'local', path: '.', enabled: true }], collections: [] });
  const file = join(work, '.farsight', 'settings.json');

  const cross = await call('PUT', '/api/settings', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, settings);
  assert.equal(cross.status, 403);
  assert.ok(!existsSync(file), 'nothing written');
  for (const path of ['/api/sync', '/api/work/intent', '/api/work/sync']) {
    assert.equal((await call('POST', path, { origin: 'https://evil.example', 'content-type': 'text/plain' }, '{}')).status, 403, path);
  }

  const viewer = await call('PUT', '/api/settings', { origin: `http://localhost:${port}`, 'sec-fetch-site': 'same-origin' }, settings);
  assert.equal(viewer.status, 200, viewer.text);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).defaultLens, 'code');

  const bad = await call('PUT', '/api/settings', {}, JSON.stringify({ sources: [{ id: 'j', name: 'j', type: 'work', auth: { secret: 'pasted-value' } }] }));
  assert.equal(bad.status, 400);
  assert.ok(!bad.text.includes('pasted-value'));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).defaultLens, 'code', 'a refused body leaves the file as it was');
});

test('refuseWrite: a read-only server refuses the routes that change settings, the graph or work items, and nothing else', async () => {
  const { refuseWrite, isWriteRoute } = await import(dist('guard.js'));
  for (const [m, u] of [['PUT', '/api/settings'], ['POST', '/api/sync'], ['POST', '/api/work/sync'], ['POST', '/api/work/intent'], ['POST', '/api/work/item/KAN-1/comment']]) {
    assert.equal(isWriteRoute(m, u), true, `${m} ${u}`);
    assert.match(refuseWrite('flag', m, u) ?? '', /read-only/, `${m} ${u}`);
    assert.match(refuseWrite('as-of', m, u) ?? '', /as-of/, `${m} ${u}`);
    assert.equal(refuseWrite(null, m, u), null, `writable: ${m} ${u}`);
  }
  // reads and the two diff routes (they compare a proposal and persist nothing) stay open
  for (const [m, u] of [['GET', '/api/settings'], ['GET', '/api/work?x=1'], ['POST', '/api/design/diff'], ['POST', '/api/apis/diff'], ['HEAD', '/api/sync']]) {
    assert.equal(refuseWrite('flag', m, u), null, `${m} ${u}`);
  }
});
