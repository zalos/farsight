import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { defaultConfig, loadContext, saveConfig } from '../dist/config.js';
import { renderEngineConfig, workerEnvironment, backendRequest, startBackend } from '../dist/runtime.js';
import type { EchoContext } from '../dist/types.js';

async function fixture(fn: (ctx: EchoContext) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'echo-runtime-test-'));
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
