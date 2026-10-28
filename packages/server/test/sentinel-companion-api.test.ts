/**
 * `GET /api/sentinel/companion` — which owner companion the Sentinel view may frame (ADR 48).
 *
 * A companion pairs with one exact Farsight origin. When the page was opened at this same server under its other
 * loopback spelling (`localhost` ⇄ `127.0.0.1`, same port), the lookup says where the companion is
 * (`pairedWith`) and still frames nothing: the content security policy keeps naming no owner origin. The serve line
 * prints the origin the server binds, `http://127.0.0.1:<port>`.
 *
 * Serves an empty graph on an ephemeral loopback port with its own state folder; a companion descriptor is written
 * there by hand for the server's own host instance. Nothing here touches ports 4477 / 4478 or the owner's state.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GraphStore } from '@farsight/core';
import { companionFilename, companionWorkspaceDigest } from '@farsight/core/dist/sentinel-companion.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const serverDist = pathToFileURL(join(repoRoot, 'packages/server/dist/index.js')).href;

let work: string;
let companions: string;
let port: number;
let child: ChildProcessWithoutNullStreams;
let childLog = '';

/** An OS-picked loopback port. 4477 / 4478 are live servers — never borrow them. */
async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const picked = await new Promise<number>((res, rej) => {
      const probe = createServer();
      probe.once('error', rej);
      probe.listen(0, '127.0.0.1', () => {
        const a = probe.address();
        const p = typeof a === 'object' && a ? a.port : 0;
        probe.close(() => res(p));
      });
    });
    if (picked > 1024 && picked !== 4477 && picked !== 4478) return picked;
  }
  throw new Error('no free loopback port after 20 tries');
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A GET to this server under the Host the browser would send; fetch cannot set Host. */
function get(path: string, host: string): Promise<{ status: number; headers: any; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitReady(): Promise<void> {
  const deadline = Date.now() + 20_000;
  let last = 'nothing answered';
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`the server exited with code ${child.exitCode}:\n${childLog}`);
    try {
      const r = await get('/api/version', `127.0.0.1:${port}`);
      if (r.status === 200) return;
      last = `HTTP ${r.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the server never answered on port ${port} (${last}):\n${childLog}`);
}

before(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-companion-api-')));
  const state = join(work, 'state');
  companions = join(state, 'farsight', 'companions');
  mkdirSync(companions, { recursive: true, mode: 0o700 });
  chmodSync(companions, 0o700);
  const graphPath = join(work, 'graph.json');
  new GraphStore().save(graphPath);
  port = await freePort();
  const boot =
    `const { serveGraph } = await import(${JSON.stringify(serverDist)});\n` +
    `serveGraph(${JSON.stringify(graphPath)}, ${port}, ${JSON.stringify(work)});\n`;
  child = spawn(process.execPath, ['--input-type=module', '-e', boot], {
    cwd: work,
    env: { ...process.env, XDG_STATE_HOME: state, MODELHUB_DIR: join(work, 'modelhub'), FIGMA_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => (childLog += d));
  child.stderr.on('data', (d: string) => (childLog += d));
  await waitReady();
});

after(async () => {
  if (child && child.exitCode == null) {
    const gone = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* a temp dir that outlives the run is not a failure */
  }
});

/** A companion descriptor for this server's host instance, paired with `farsightOrigin`. */
async function pair(farsightOrigin: string, ownerOrigin: string): Promise<string> {
  const version = JSON.parse((await get('/api/version', `127.0.0.1:${port}`)).body);
  const workspaceDigest = companionWorkspaceDigest(work);
  const path = join(companions, companionFilename(workspaceDigest, farsightOrigin));
  writeFileSync(
    path,
    JSON.stringify({
      schema: 'farsight-sentinel-companion/1',
      workspaceDigest,
      farsightOrigin,
      hostInstance: version.session.instance,
      ownerOrigin,
      processNonce: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { mode: 0o600 },
  );
  return path;
}

const lookup = async (host: string) => {
  const r = await get('/api/sentinel/companion', host);
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  return JSON.parse(r.body);
};

test('the serve line prints the origin the server binds, 127.0.0.1', () => {
  assert.match(childLog, new RegExp(`farsight: http://127\\.0\\.0\\.1:${port} `));
  assert.doesNotMatch(childLog, /farsight: http:\/\/localhost:/);
});

test('no companion: unavailable, with nothing to point at', async () => {
  assert.deepEqual(await lookup(`127.0.0.1:${port}`), { available: false, reasonCode: 'sentinel.ownerUi.launch' });
  assert.deepEqual(await lookup(`localhost:${port}`), { available: false, reasonCode: 'sentinel.ownerUi.launch' });
});

test('a companion paired with 127.0.0.1 is framed there only; under localhost the lookup points at it', async () => {
  const owner = 'http://127.0.0.1:45991';
  const path = await pair(`http://127.0.0.1:${port}`, owner);
  try {
    assert.deepEqual(await lookup(`127.0.0.1:${port}`), { available: true, ownerOrigin: owner });
    assert.deepEqual(await lookup(`localhost:${port}`), {
      available: false,
      reasonCode: 'sentinel.ownerUi.launch',
      pairedWith: `http://127.0.0.1:${port}`,
    });
    // the exact origin stays the only one framed: the page under localhost names no owner origin in frame-src
    const exact = await get('/', `127.0.0.1:${port}`);
    assert.match(String(exact.headers['content-security-policy']), new RegExp(`frame-src[^;]*${owner}`));
    const other = await get('/', `localhost:${port}`);
    assert.doesNotMatch(String(other.headers['content-security-policy']), /45991/);
    // another port is not this server under another name
    assert.deepEqual(await lookup(`localhost:${port + 1}`), {
      available: false,
      reasonCode: 'sentinel.ownerUi.launch',
    });
  } finally {
    rmSync(path, { force: true });
  }
});

test('and the other way round: paired with localhost, a page under 127.0.0.1 is pointed there', async () => {
  const owner = 'http://127.0.0.1:45992';
  const path = await pair(`http://localhost:${port}`, owner);
  try {
    assert.deepEqual(await lookup(`localhost:${port}`), { available: true, ownerOrigin: owner });
    assert.deepEqual(await lookup(`127.0.0.1:${port}`), {
      available: false,
      reasonCode: 'sentinel.ownerUi.launch',
      pairedWith: `http://localhost:${port}`,
    });
    // [::1] is neither spelling the companion could be under here (the server binds 127.0.0.1): nothing to point at
    assert.deepEqual(await lookup(`[::1]:${port}`), { available: false, reasonCode: 'sentinel.ownerUi.launch' });
  } finally {
    rmSync(path, { force: true });
  }
});
