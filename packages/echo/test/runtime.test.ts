import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, chmodSync, symlinkSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { defaultConfig, loadContext, saveConfig } from '../dist/config.js';
import { renderEngineConfig, workerEnvironment, backendRequest, startBackend, enginePath, installRuntime, runtimeInstalled, hasGlobalBackendConfig, ENGINE_VERSION, type RuntimeOptions } from '../dist/runtime.js';
import type { EchoContext } from '../dist/types.js';

async function fixture(fn: (ctx: EchoContext) => Promise<void>) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'echo-runtime-test-')));
  try {
    const configPath = join(directory, 'settings.json');
    await saveConfig(configPath, defaultConfig());
    await fn(loadContext(configPath));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('managed process configuration isolates all state and does not inherit model credentials', async () => {
  await fixture(async ctx => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'synthetic-test-credential';
    try {
      const env = workerEnvironment(ctx, 'ephemeral-test-secret');
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(env.AGENTMEMORY_AUTO_COMPRESS, 'false');
      assert.equal(env.AUTO_FORGET_ENABLED, 'false');
      assert.equal(env.LESSON_DECAY_ENABLED, 'false');
      assert.equal(env.INSIGHT_DECAY_ENABLED, 'false');
      assert.equal(env.AGENTMEMORY_RUNTIME_DIR, ctx.dataDirectory);
      assert.equal(env.AGENTMEMORY_SECRET, 'ephemeral-test-secret');
      const rendered = renderEngineConfig(ctx);
      assert.ok(!rendered.includes('ephemeral-test-secret'));
      const config = JSON.parse(rendered);
      assert.ok(config.workers.every((w: any) => !w.config.host || w.config.host === '127.0.0.1'));
      assert.ok(config.workers.filter((w: any) => w.config.adapter?.config?.file_path).every((w: any) => w.config.adapter.config.file_path.startsWith(ctx.dataDirectory)));
      assert.ok(!config.workers.some((w: any) => w.name === 'iii-exec'));
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = original;
    }
  });
});

function fakeRuntime(ctx: EchoContext): { options: RuntimeOptions; binary: string; marker: string } {
  const options = { home: ctx.directory, cacheRoot: join(ctx.directory, 'user-cache') };
  const binary = enginePath(ctx, options);
  mkdirSync(dirname(binary), { recursive: true, mode: 0o700 });
  const marker = join(ctx.directory, 'executed');
  const source = `#!/bin/sh\nprintf 'executed' > '${marker.replaceAll("'", "'\\''")}'\nprintf 'iii ${ENGINE_VERSION}\\n'\n`;
  writeFileSync(binary, source, { mode: 0o700 });
  writeFileSync(`${binary}.sha256.json`, JSON.stringify({ version: ENGINE_VERSION, platform: `${process.platform}-${process.arch}`, sha256: createHash('sha256').update(source).digest('hex') }), { mode: 0o600 });
  return { options, binary, marker };
}

test('checksum mismatch never installs or executes downloaded bytes', async () => {
  await fixture(async ctx => {
    const options: RuntimeOptions = { home: ctx.directory, fetch: async () => new Response('not the pinned release') };
    await assert.rejects(installRuntime(ctx, options), /archive did not match/);
    assert.equal(existsSync(enginePath(ctx, options)), false);
    assert.equal(existsSync(`${enginePath(ctx, options)}.sha256.json`), false);
  });
});

test('runtime ignores workspace executables and rejects linked or public caches', async () => {
  await fixture(async ctx => {
    const { options, binary, marker } = fakeRuntime(ctx);
    const local = join(ctx.directory, 'runtime', ENGINE_VERSION, 'iii');
    const localMarker = join(ctx.directory, 'workspace-executed');
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, `#!/bin/sh\ntouch '${localMarker}'\nprintf 'iii ${ENGINE_VERSION}\\n'\n`, { mode: 0o700 });
    assert.equal(enginePath(ctx), enginePath({ ...ctx, directory: join(ctx.directory, 'another-workspace') }));
    assert.equal(runtimeInstalled(ctx, options), true);
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(localMarker), false);
    chmodSync(dirname(binary), 0o755);
    rmSync(marker);
    assert.equal(runtimeInstalled(ctx, options), false);
    assert.equal(existsSync(marker), false);
    const linked = join(ctx.directory, 'linked-cache');
    symlinkSync(options.cacheRoot!, linked, 'dir');
    await assert.rejects(installRuntime(ctx, { ...options, cacheRoot: linked }), /runtime cache/);
    assert.equal(existsSync(localMarker), false);
  });
});

test('changed engine is refused before doctor version probe, reinstall verification and backend launch', async () => {
  await fixture(async ctx => {
    const { options, binary, marker } = fakeRuntime(ctx);
    assert.equal(runtimeInstalled(ctx, options), true);
    rmSync(marker);
    writeFileSync(binary, `${readFileSync(binary, 'utf8')}# changed\n`);
    assert.equal(runtimeInstalled(ctx, options), false);
    await assert.rejects(installRuntime(ctx, options), /verified fingerprint/);
    await assert.rejects(startBackend(ctx, options), /verified fingerprint/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(ctx.dataDirectory, 'echo-owner.json')), false);
  });
});

test('global backend environment file refuses managed startup before executing the engine', async () => {
  await fixture(async ctx => {
    const { options, marker } = fakeRuntime(ctx);
    mkdirSync(join(ctx.directory, '.agentmemory'));
    writeFileSync(join(ctx.directory, '.agentmemory', '.env'), 'SYNTHETIC_PRIVATE_CONFIG=true');
    assert.equal(hasGlobalBackendConfig(options), true);
    await assert.rejects(startBackend(ctx, options), /global agentmemory configuration/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(ctx.dataDirectory, 'echo-owner.json')), false);
  });
});

test('occupied managed port is refused without stopping the listener or retaining a writer lock', async () => {
  await fixture(async ctx => {
    const { options } = fakeRuntime(ctx);
    const server = createServer();
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    ctx.profile.backend.url = `http://127.0.0.1:${address.port}`;
    try {
      await assert.rejects(startBackend(ctx, options), new RegExp(`Port ${address.port} is already in use`));
      assert.equal(server.listening, true);
      assert.equal(existsSync(join(ctx.dataDirectory, 'echo-owner.json')), false);
    } finally { await new Promise<void>(r => server.close(() => r())); }
  });
});

test('only a verified dead owner lock is recovered; live, malformed and linked locks survive refusal', async () => {
  await fixture(async ctx => {
    const { options } = fakeRuntime(ctx);
    mkdirSync(ctx.dataDirectory, { recursive: true, mode: 0o700 });
    const lock = join(ctx.dataDirectory, 'echo-owner.json');
    const server = createServer();
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    ctx.profile.backend.url = `http://127.0.0.1:${address.port}`;
    try {
      for (const value of [{ pid: process.pid }, { pid: -1 }, { pid: 2147483647, nonce: 'invalid' }]) {
        const text = JSON.stringify(value);
        writeFileSync(lock, text, { mode: 0o600 });
        await assert.rejects(startBackend(ctx, options), /profile is locked/);
        assert.equal(readFileSync(lock, 'utf8'), text);
        rmSync(lock);
      }
      const target = join(ctx.directory, 'lock-target');
      writeFileSync(target, JSON.stringify({ pid: 2147483647 }), { mode: 0o600 });
      symlinkSync(target, lock);
      await assert.rejects(startBackend(ctx, options), /profile is locked/);
      assert.equal(lstatSync(lock).isSymbolicLink(), true);
      rmSync(lock);
      assert.throws(() => process.kill(2147483647, 0), { code: 'ESRCH' });
      writeFileSync(lock, JSON.stringify({ pid: 2147483647 }), { mode: 0o600 });
      await assert.rejects(startBackend(ctx, options), /already in use/);
      assert.equal(existsSync(lock), false);
      assert.equal(server.listening, true);
    } finally { await new Promise<void>(r => server.close(() => r())); }
  });
});

test('backend adapter authenticates requests and refuses credential-bearing redirects', async () => {
  let authorization: string | undefined;
  const server = createServer((req, res) => {
    authorization = req.headers.authorization;
    if (req.url === '/redirect') { res.writeHead(302, { location: '/other' }); res.end(); return; }
    if (req.url === '/failure') { res.writeHead(401); res.end('sensitive response content'); return; }
    if (req.url === '/invalid') { res.end('synthetic-private-response'); return; }
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const connection = { url: `http://127.0.0.1:${address.port}`, secret: 'synthetic-secret', close: async () => {} };
  try {
    assert.deepEqual(await backendRequest(connection, '/good'), { ok: true });
    assert.equal(authorization, 'Bearer synthetic-secret');
    await assert.rejects(backendRequest(connection, '/redirect'));
    await assert.rejects(backendRequest(connection, '/failure'), (error: Error) => !error.message.includes('sensitive') && error.message.includes('401'));
    await assert.rejects(backendRequest(connection, '/invalid'), (error: Error) => !error.message.includes('synthetic-private-response'));
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

test('external backend close never stops its server', async () => {
  await fixture(async ctx => {
    let compatible = false;
    const server = createServer((_, res) => { res.setHeader('content-type', 'application/json'); res.end(compatible ? '{"status":"healthy","service":"agentmemory","version":"0.9.30"}' : '{"status":"ok"}'); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    ctx.profile.backend = { mode: 'external', url: `http://127.0.0.1:${address.port}` };
    try {
      await assert.rejects(startBackend(ctx));
      compatible = true;
      const connection = await startBackend(ctx);
      await connection.close();
      assert.ok(server.listening);
      assert.equal(existsSync(join(ctx.dataDirectory, 'echo-owner.json')), false);
    } finally { await new Promise<void>(r => server.close(() => r())); }
  });
});
