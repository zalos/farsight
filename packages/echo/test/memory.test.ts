import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultConfig, loadContext, saveConfig } from '../dist/config.js';
import { memoryRequest, memorySocketPath, startMemoryBridge } from '../dist/memory.js';
import { contextFingerprint } from '../dist/sessions.js';
import type { BackendConnection, EchoContext } from '../dist/types.js';

type Memory = { id: string; createdAt: string; title: string; content: string; project: string; agentId: string; concepts: string[] };
async function fixture(fn: (ctx: EchoContext, connection: BackendConnection, state: { requests: Array<{ path: string; body: any }>; memories: Memory[]; override?: (req: IncomingMessage, res: ServerResponse) => boolean }) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'echo-memory-test-'));
  const configPath = join(directory, 'settings.json');
  await saveConfig(configPath, defaultConfig());
  const ctx = loadContext(configPath);
  const state: { requests: Array<{ path: string; body: any }>; memories: Memory[]; override?: (req: IncomingMessage, res: ServerResponse) => boolean } = { requests: [], memories: [] };
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer synthetic-secret');
    if (state.override?.(req, res)) return;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const url = new URL(req.url!, 'http://fixture');
    state.requests.push({ path: url.pathname, body });
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/agentmemory/remember') {
      const memory: Memory = { ...body, id: `mem_fixture_${state.memories.length}`, createdAt: new Date().toISOString(), title: body.content.slice(0, 60) };
      state.memories.push(memory);
      res.end(JSON.stringify({ success: true, memory }));
    } else {
      assert.equal(url.pathname, '/agentmemory/memories');
      assert.equal(url.searchParams.get('latest'), 'true');
      const selected = state.memories.filter(memory => memory.agentId === url.searchParams.get('agentId') && memory.project === url.searchParams.get('project') && memory.content.includes(url.searchParams.get('q')!));
      res.end(JSON.stringify({ memories: selected.slice(0, Number(url.searchParams.get('limit'))), total: selected.length, nextCursor: null }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const connection = { url: `http://127.0.0.1:${address.port}`, secret: 'synthetic-secret', close: async () => {} };
  try { await fn(ctx, connection, state); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
}

test('private bridge remembers published records, preserves source IDs and bounds recall without storing credentials', async () => {
  await fixture(async (ctx, connection, state) => {
    const bridge = await startMemoryBridge(ctx, connection);
    try {
      assert.equal(lstatSync(dirname(memorySocketPath(ctx))).mode & 0o777, 0o700);
      assert.equal(lstatSync(memorySocketPath(ctx)).mode & 0o777, 0o600);
      const saved = await memoryRequest(ctx, 'remember', { content: `Cold shipment ${'synthetic reference '.repeat(200)}`, topics: ['shipping'] });
      assert.equal(saved.id, 'mem_fixture_0');
      assert.ok(saved.createdAt);
      assert.deepEqual(state.memories[0]!.concepts, ['shipping']);
      assert.match(state.memories[0]!.agentId, /^echo:[a-f0-9]{64}$/);
      assert.match(state.memories[0]!.project, /^echo:[a-f0-9]{64}$/);
      const recalled = await memoryRequest(ctx, 'recall', { query: 'Cold shipment' });
      assert.equal(recalled.memories[0]!.id, saved.id);
      assert.equal(recalled.memories[0]!.provenance?.workspace, realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()));
      assert.equal(recalled.memories[0]!.provenance?.commit, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
      assert.ok(Date.parse(recalled.memories[0]!.provenance!.savedAt));
      assert.ok(recalled.memories[0]!.content.startsWith('Cold shipment'));
      assert.equal(recalled.truncated, true);
      assert.ok(recalled.memories.reduce((sum, memory) => sum + memory.content.length + memory.title.length, 0) <= ctx.profile.budget.briefMaxChars);
      assert.ok(!readFileSync(ctx.configPath, 'utf8').includes(connection.secret));
    } finally { await bridge.close(); await bridge.close(); }
    assert.equal(existsSync(memorySocketPath(ctx)), false);
  });
});

test('credential shapes are refused before persistence on both the client and private bridge', async () => {
  await fixture(async (ctx, connection, state) => {
    const bridge = await startMemoryBridge(ctx, connection);
    try {
      const shapes = ['keychain:example/service', 'env:SYNTHETIC_SECRET', `Bearer ${'a'.repeat(12)}`, `Basic ${'b'.repeat(12)}`, 'c'.repeat(32)];
      for (const value of shapes) {
        await assert.rejects(memoryRequest(ctx, 'remember', { content: `Synthetic ${value}` }), (error: Error) => /looks like a credential/.test(error.message) && !error.message.includes(value));
        const reply = await directRequest(ctx, { operation: 'remember', input: { content: `Synthetic ${value}` } });
        assert.deepEqual(reply, { ok: false, code: 'credential' });
      }
      await assert.rejects(memoryRequest(ctx, 'remember', { content: 'Valid note', topics: [shapes[0]!] }), /looks like a credential/);
      assert.equal(state.requests.length, 0);
    } finally { await bridge.close(); }
  });
});

test('memory inputs cannot invent provenance and the bridge verifies reported roots and revisions', async () => {
  await fixture(async (ctx, connection, state) => {
    const bridge = await startMemoryBridge(ctx, connection);
    try {
      await assert.rejects(memoryRequest(ctx, 'remember', { content: 'Synthetic', provenance: { workspace: '/pretend', commit: 'a'.repeat(40), savedAt: '2000-01-01' } } as any), /invalid or too large/);
      const actualRoot = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
      for (const origin of [undefined, { workspace: actualRoot, commit: '0'.repeat(40) }, { workspace: actualRoot, commit: null }, { workspace: actualRoot, commit: 'a'.repeat(40), savedAt: '2000-01-01' }, { workspace: '/nonexistent-echo-test', commit: null }]) {
        const reply = await directRequest(ctx, { operation: 'remember', input: { content: 'Synthetic origin' }, origin });
        assert.deepEqual(reply, { ok: false, code: 'input' });
      }
      assert.equal(state.requests.length, 0);
      await memoryRequest(ctx, 'remember', { content: 'Synthetic origin' });
      assert.equal((await memoryRequest(ctx, 'recall', { query: 'Synthetic origin' })).memories[0]!.provenance?.workspace, actualRoot);
      // Even a same-id backend replacement cannot inherit the original attribution.
      state.memories[0]!.content = 'Synthetic origin replaced';
      assert.equal((await memoryRequest(ctx, 'recall', { query: 'Synthetic origin' })).memories[0]!.provenance, undefined);
      state.memories[0]!.content = 'Synthetic origin';
      rmSync(join(ctx.dataDirectory, 'provenance'), { recursive: true });
      assert.equal((await memoryRequest(ctx, 'recall', { query: 'Synthetic origin' })).memories[0]!.provenance, undefined);
    } finally { await bridge.close(); }
  });
});

function directRequest(ctx: EchoContext, request: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(memorySocketPath(ctx)); let output = '';
    socket.once('error', reject);
    socket.on('data', chunk => { output += chunk; });
    socket.once('end', () => resolve(JSON.parse(output)));
    socket.once('connect', () => socket.write(`${JSON.stringify({ version: 1, fingerprint: contextFingerprint(ctx), ...request })}\n`));
  });
}

test('identity namespaces keep profiles and full-length individual identities apart on the same backend', async () => {
  await fixture(async (ctx, connection, state) => {
    const config = ctx.config;
    config.profiles.personal!.identity.individual = `${'a'.repeat(128)}one`;
    config.profiles.work!.identity.individual = `${'a'.repeat(128)}two`;
    await saveConfig(ctx.configPath, config);
    const personal = loadContext(ctx.configPath, 'personal');
    const work = loadContext(ctx.configPath, 'work');
    const first = await startMemoryBridge(personal, connection);
    const second = await startMemoryBridge(work, connection);
    try {
      await memoryRequest(personal, 'remember', { content: 'Synthetic scope marker' });
      await memoryRequest(work, 'remember', { content: 'Synthetic scope marker work' });
      assert.notEqual(state.memories[0]!.agentId, state.memories[1]!.agentId);
      assert.notEqual(state.memories[0]!.project, state.memories[1]!.project);
      assert.equal((await memoryRequest(personal, 'recall', { query: 'Synthetic scope marker' })).memories.length, 1);
      const impostor = structuredClone(personal); impostor.profile.identity.project = 'other';
      await assert.rejects(memoryRequest(impostor, 'recall', { query: 'Synthetic scope marker' }), /settings changed/);
    } finally { await first.close(); await second.close(); }
  });
});

test('configuration changes refuse old and new fingerprints until the running bridge restarts', async () => {
  await fixture(async (ctx, connection, state) => {
    const bridge = await startMemoryBridge(ctx, connection);
    try {
      ctx.config.profiles.personal!.model.model = 'changed-model';
      await saveConfig(ctx.configPath, ctx.config);
      await assert.rejects(memoryRequest(ctx, 'recall', { query: 'Synthetic' }), /settings changed/);
      await assert.rejects(memoryRequest(loadContext(ctx.configPath), 'recall', { query: 'Synthetic' }), /settings changed/);
      assert.equal(state.requests.length, 0);
    } finally { await bridge.close(); }
  });
});

test('scope overrides, oversized requests, invalid limits and upstream identity mismatches never escape as memory', async () => {
  await fixture(async (ctx, connection, state) => {
    const bridge = await startMemoryBridge(ctx, connection);
    try {
      await assert.rejects(memoryRequest(ctx, 'remember', { content: 'x'.repeat(24_001) }), /invalid or too large/);
      await assert.rejects(memoryRequest(ctx, 'recall', { query: 'test', limit: 6 }), /invalid or too large/);
      await assert.rejects(memoryRequest(ctx, 'recall', { query: 'test', project: '*' } as any), /invalid or too large/);
      // Also bypass the client validator to verify the server enforces the contract.
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = createConnection(memorySocketPath(ctx)); let output = '';
        socket.once('error', reject);
        socket.on('data', chunk => { output += chunk; });
        socket.once('end', () => resolve(output));
        socket.once('connect', () => socket.write(`${JSON.stringify({ version: 1, fingerprint: contextFingerprint(ctx), operation: 'remember', input: { content: 'test', agentId: '*' } })}\n`));
      });
      assert.equal(JSON.parse(reply).code, 'input');
      assert.equal(state.requests.length, 0);
      state.override = (_, res) => { res.end(JSON.stringify({ memories: [{ id: 'mem_foreign', content: 'PRIVATE_SENTINEL', title: 'Foreign', createdAt: '2026-01-01', project: 'wrong', agentId: 'wrong' }], nextCursor: null })); return true; };
      await assert.rejects(memoryRequest(ctx, 'recall', { query: 'test' }), (error: Error) => /invalid response/.test(error.message) && !error.message.includes('PRIVATE_SENTINEL'));
    } finally { await bridge.close(); }
  });
});

test('recall deadlines release callers; external profiles refuse writes before contacting the backend', async () => {
  await fixture(async (ctx, connection, state) => {
    state.override = () => true;
    let bridge = await startMemoryBridge(ctx, connection);
    try {
      const start = Date.now();
      await assert.rejects(memoryRequest(ctx, 'recall', { query: 'Synthetic' }, { timeoutMs: 100 }));
      assert.ok(Date.now() - start < 1000);
    } finally { await bridge.close(); }
    ctx.config.profiles.personal!.backend.mode = 'external';
    await saveConfig(ctx.configPath, ctx.config);
    const external = loadContext(ctx.configPath);
    bridge = await startMemoryBridge(external, connection);
    try { await assert.rejects(memoryRequest(external, 'remember', { content: 'Synthetic' }), /requires a managed Echo profile/); }
    finally { await bridge.close(); }
    assert.equal(state.requests.length, 0);
  });
});

test('bridge refuses live duplicates and non-sockets, recovers a crashed owned socket and refuses widened permissions', async () => {
  await fixture(async (ctx, connection) => {
    let bridge = await startMemoryBridge(ctx, connection);
    const path = memorySocketPath(ctx);
    try { await assert.rejects(startMemoryBridge(ctx, connection), /already running/); }
    finally { await bridge.close(); }
    writeFileSync(path, 'do not remove', { mode: 0o600 });
    try { await assert.rejects(startMemoryBridge(ctx, connection), /ownership/); assert.equal(readFileSync(path, 'utf8'), 'do not remove'); }
    finally { rmSync(path); }
    const child = spawn(process.execPath, ['--input-type=module', '-e', 'import {createServer} from "node:net"; import {chmodSync} from "node:fs"; createServer().listen(process.argv[1],()=>{chmodSync(process.argv[1],0o600);process.stdout.write("ready");});', path], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout!.once('data', () => resolve()); });
    child.kill('SIGKILL');
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    assert.ok(existsSync(path));
    bridge = await startMemoryBridge(ctx, connection);
    try {
      chmodSync(path, 0o666);
      await assert.rejects(memoryRequest(ctx, 'recall', { query: 'Synthetic' }), /ownership/);
      chmodSync(path, 0o600);
    } finally { await bridge.close(); }
  });
});
