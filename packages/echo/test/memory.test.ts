import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultConfig, loadContext, saveConfig } from '../dist/config.js';
import { memoryRequest, memorySocketPath, startMemoryBridge } from '../dist/memory.js';
import { contextFingerprint } from '../dist/sessions.js';
import type { BackendConnection, EchoContext } from '../dist/types.js';

type Memory = {
  id: string;
  createdAt: string;
  title: string;
  content: string;
  project: string;
  agentId: string;
  concepts: string[];
};
async function fixture(
  fn: (
    ctx: EchoContext,
    connection: BackendConnection,
    state: {
      requests: Array<{ path: string; body: any }>;
      memories: Memory[];
      override?: (req: IncomingMessage, res: ServerResponse) => boolean;
    },
  ) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'echo-memory-test-'));
  const configPath = join(directory, 'settings.json');
  await saveConfig(configPath, defaultConfig());
  const ctx = loadContext(configPath);
  const state: {
    requests: Array<{ path: string; body: any }>;
    memories: Memory[];
    override?: (req: IncomingMessage, res: ServerResponse) => boolean;
  } = { requests: [], memories: [] };
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
      const memory: Memory = {
        ...body,
        id: `mem_fixture_${state.memories.length}`,
        createdAt: new Date().toISOString(),
        title: body.content.slice(0, 60),
      };
      state.memories.push(memory);
      res.end(JSON.stringify({ success: true, memory }));
    } else {
      assert.equal(url.pathname, '/agentmemory/memories');
      assert.equal(url.searchParams.get('latest'), 'true');
      const selected = state.memories.filter(
        (memory) =>
          memory.agentId === url.searchParams.get('agentId') &&
          memory.project === url.searchParams.get('project') &&
          memory.content.includes(url.searchParams.get('q')!),
      );
      res.end(
        JSON.stringify({
          memories: selected.slice(0, Number(url.searchParams.get('limit'))),
          total: selected.length,
          nextCursor: null,
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const connection = { url: `http://127.0.0.1:${address.port}`, secret: 'synthetic-secret', close: async () => {} };
  try {
    await fn(ctx, connection, state);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}

test('private bridge remembers published records, preserves source IDs and bounds recall without storing credentials', async () => {
  await fixture(async (ctx, connection, state) => {
    const bridge = await startMemoryBridge(ctx, connection);
    try {
      assert.equal(lstatSync(dirname(memorySocketPath(ctx))).mode & 0o777, 0o700);
      assert.equal(lstatSync(memorySocketPath(ctx)).mode & 0o777, 0o600);
      const saved = await memoryRequest(ctx, 'remember', {
        content: `Cold shipment ${'synthetic reference '.repeat(200)}`,
        topics: ['shipping'],
      });
      assert.equal(saved.id, 'mem_fixture_0');
      assert.ok(saved.createdAt);
      assert.deepEqual(state.memories[0]!.concepts, ['shipping']);
      assert.match(state.memories[0]!.agentId, /^echo:[a-f0-9]{64}$/);
      assert.match(state.memories[0]!.project, /^echo:[a-f0-9]{64}$/);
      const recalled = await memoryRequest(ctx, 'recall', { query: 'Cold shipment' });
      assert.equal(recalled.memories[0]!.id, saved.id);
      assert.equal(
        recalled.memories[0]!.provenance?.workspace,
        realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()),
      );
      assert.equal(
        recalled.memories[0]!.provenance?.commit,
        execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      );
      assert.ok(Date.parse(recalled.memories[0]!.provenance!.savedAt));
      assert.ok(recalled.memories[0]!.content.startsWith('Cold shipment'));
      assert.equal(recalled.truncated, true);
      assert.ok(
        recalled.memories.reduce((sum, memory) => sum + memory.content.length + memory.title.length, 0) <=
          ctx.profile.budget.briefMaxChars,
      );
      assert.ok(!readFileSync(ctx.configPath, 'utf8').includes(connection.secret));
    } finally {
      await bridge.close();
      await bridge.close();
    }
    assert.equal(existsSync(memorySocketPath(ctx)), false);
  });
});

test('credential shapes are refused before persistence on both the client and private bridge', async () => {
  await fixture(async (ctx, connection, state) => {
    const bridge = await startMemoryBridge(ctx, connection);
    try {
      const shapes = [
        'keychain:example/service',
        'env:SYNTHETIC_SECRET',
        `Bearer ${'a'.repeat(12)}`,
        `Basic ${'b'.repeat(12)}`,
        'c'.repeat(32),
      ];
      for (const value of shapes) {
        await assert.rejects(
          memoryRequest(ctx, 'remember', { content: `Synthetic ${value}` }),
          (error: Error) => /looks like a credential/.test(error.message) && !error.message.includes(value),
        );
        const reply = await directRequest(ctx, { operation: 'remember', input: { content: `Synthetic ${value}` } });
        assert.deepEqual(reply, { ok: false, code: 'credential' });
      }
      await assert.rejects(
        memoryRequest(ctx, 'remember', { content: 'Valid note', topics: [shapes[0]!] }),
        /looks like a credential/,
      );
      assert.equal(state.requests.length, 0);
    } finally {
      await bridge.close();
    }
  });
});

test('memory inputs cannot invent provenance and the bridge verifies reported roots and revisions', async () => {
  await fixture(async (ctx, connection, state) => {
    const bridge = await startMemoryBridge(ctx, connection);
    try {
      await assert.rejects(
        memoryRequest(ctx, 'remember', {
          content: 'Synthetic',
          provenance: { workspace: '/pretend', commit: 'a'.repeat(40), savedAt: '2000-01-01' },
        } as any),
        /invalid or too large/,
      );
      const actualRoot = realpathSync(
        execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
      );
      for (const origin of [
        undefined,
        { workspace: actualRoot, commit: '0'.repeat(40) },
        { workspace: actualRoot, commit: null },
        { workspace: actualRoot, commit: 'a'.repeat(40), savedAt: '2000-01-01' },
        { workspace: '/nonexistent-echo-test', commit: null },
      ]) {
        const reply = await directRequest(ctx, {
          operation: 'remember',
          input: { content: 'Synthetic origin' },
          origin,
        });
        assert.deepEqual(reply, { ok: false, code: 'input' });
      }
      assert.equal(state.requests.length, 0);
      await memoryRequest(ctx, 'remember', { content: 'Synthetic origin' });
      assert.equal(
        (await memoryRequest(ctx, 'recall', { query: 'Synthetic origin' })).memories[0]!.provenance?.workspace,
        actualRoot,
      );
      // Even a same-id backend replacement cannot inherit the original attribution.
      state.memories[0]!.content = 'Synthetic origin replaced';
      assert.equal(
        (await memoryRequest(ctx, 'recall', { query: 'Synthetic origin' })).memories[0]!.provenance,
        undefined,
      );
      state.memories[0]!.content = 'Synthetic origin';
      rmSync(join(ctx.dataDirectory, 'provenance'), { recursive: true });
      assert.equal(
        (await memoryRequest(ctx, 'recall', { query: 'Synthetic origin' })).memories[0]!.provenance,
        undefined,
      );
    } finally {
      await bridge.close();
    }
  });
});

function directRequest(ctx: EchoContext, request: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(memorySocketPath(ctx));
    let output = '';
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      output += chunk;
    });
    socket.once('end', () => resolve(JSON.parse(output)));
    socket.once('connect', () =>
      socket.write(`${JSON.stringify({ version: 1, fingerprint: contextFingerprint(ctx), ...request })}\n`),
    );
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
      const impostor = structuredClone(personal);
      impostor.profile.identity.project = 'other';
      await assert.rejects(memoryRequest(impostor, 'recall', { query: 'Synthetic scope marker' }), /settings changed/);
    } finally {
      await first.close();
      await second.close();
    }
  });
});

test('configuration changes refuse old and new fingerprints until the running bridge restarts', async () => {
  await fixture(async (ctx, connection, state) => {
    const bridge = await startMemoryBridge(ctx, connection);
    try {
      ctx.config.profiles.personal!.model.model = 'changed-model';
      await saveConfig(ctx.configPath, ctx.config);
      await assert.rejects(memoryRequest(ctx, 'recall', { query: 'Synthetic' }), /settings changed/);
      await assert.rejects(
        memoryRequest(loadContext(ctx.configPath), 'recall', { query: 'Synthetic' }),
        /settings changed/,
      );
      assert.equal(state.requests.length, 0);
    } finally {
      await bridge.close();
    }
  });
});

test('scope overrides, oversized requests, invalid limits and upstream identity mismatches never escape as memory', async () => {
  await fixture(async (ctx, connection, state) => {
    const bridge = await startMemoryBridge(ctx, connection);
    try {
      await assert.rejects(memoryRequest(ctx, 'remember', { content: 'x'.repeat(24_001) }), /invalid or too large/);
      await assert.rejects(memoryRequest(ctx, 'recall', { query: 'test', limit: 6 }), /invalid or too large/);
      await assert.rejects(
        memoryRequest(ctx, 'recall', { query: 'test', project: '*' } as any),
        /invalid or too large/,
      );
      // Also bypass the client validator to verify the server enforces the contract.
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = createConnection(memorySocketPath(ctx));
        let output = '';
        socket.once('error', reject);
        socket.on('data', (chunk) => {
          output += chunk;
        });
        socket.once('end', () => resolve(output));
        socket.once('connect', () =>
          socket.write(
            `${JSON.stringify({ version: 1, fingerprint: contextFingerprint(ctx), operation: 'remember', input: { content: 'test', agentId: '*' } })}\n`,
          ),
        );
      });
      assert.equal(JSON.parse(reply).code, 'input');
      assert.equal(state.requests.length, 0);
      state.override = (_, res) => {
        res.end(
          JSON.stringify({
            memories: [
              {
                id: 'mem_foreign',
                content: 'PRIVATE_SENTINEL',
                title: 'Foreign',
                createdAt: '2026-01-01',
                project: 'wrong',
                agentId: 'wrong',
              },
            ],
            nextCursor: null,
          }),
        );
        return true;
      };
      await assert.rejects(
        memoryRequest(ctx, 'recall', { query: 'test' }),
        (error: Error) => /invalid response/.test(error.message) && !error.message.includes('PRIVATE_SENTINEL'),
      );
    } finally {
      await bridge.close();
    }
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
    } finally {
      await bridge.close();
    }
    ctx.config.profiles.personal!.backend.mode = 'external';
    await saveConfig(ctx.configPath, ctx.config);
    const external = loadContext(ctx.configPath);
    bridge = await startMemoryBridge(external, connection);
    try {
      await assert.rejects(
        memoryRequest(external, 'remember', { content: 'Synthetic' }),
        /requires a managed Echo profile/,
      );
    } finally {
      await bridge.close();
    }
    assert.equal(state.requests.length, 0);
  });
});

test('bridge refuses live duplicates and non-sockets, recovers a crashed owned socket and refuses widened permissions', async () => {
  await fixture(async (ctx, connection) => {
    let bridge = await startMemoryBridge(ctx, connection);
    const path = memorySocketPath(ctx);
    try {
      await assert.rejects(startMemoryBridge(ctx, connection), /already running/);
    } finally {
      await bridge.close();
    }
    writeFileSync(path, 'do not remove', { mode: 0o600 });
    try {
      await assert.rejects(startMemoryBridge(ctx, connection), /ownership/);
      assert.equal(readFileSync(path, 'utf8'), 'do not remove');
    } finally {
      rmSync(path);
    }
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'import {createServer} from "node:net"; import {chmodSync} from "node:fs"; createServer().listen(process.argv[1],()=>{chmodSync(process.argv[1],0o600);process.stdout.write("ready");});',
        path,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout!.once('data', () => resolve());
    });
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    assert.ok(existsSync(path));
    bridge = await startMemoryBridge(ctx, connection);
    try {
      chmodSync(path, 0o666);
      await assert.rejects(memoryRequest(ctx, 'recall', { query: 'Synthetic' }), /ownership/);
      chmodSync(path, 0o600);
    } finally {
      await bridge.close();
    }
  });
});

test('a prompt hook reports omitted matches even when no record is returned', async () => {
  await fixture(async (ctx, connection, state) => {
    ctx.profile.hooks.claude = true;
    ctx.config.profiles.personal!.hooks.claude = true;
    await saveConfig(ctx.configPath, ctx.config);
    state.override = (_req, res) => {
      res.end(JSON.stringify({ memories: [], nextCursor: 'more' }));
      return true;
    };
    const bridge = await startMemoryBridge(ctx, connection);
    try {
      const { fileURLToPath } = await import('node:url');
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('../dist/cli.js', import.meta.url)),
          'hook',
          '--config',
          ctx.configPath,
          '--host',
          'claude',
        ],
        { cwd: ctx.directory, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.stdin.end(
        JSON.stringify({
          session_id: 'omitted-matches',
          hook_event_name: 'UserPromptSubmit',
          prompt: 'Synthetic query',
        }),
      );
      assert.equal(await exited, 0, stderr);
      assert.equal(stderr, '');
      assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /More matched; not shown/);
    } finally {
      await bridge.close();
    }
  });
});

test('private bridge and CLI research mocked memories then expand exact evidence without model calls', async () => {
  await fixture(async (ctx, connection, state) => {
    const { submindSettings } = await import('../dist/config.js');
    ctx.config.profiles.personal!.submind = { ...submindSettings(ctx.profile), mode: 'mock', expandedMaxChars: 64000 };
    await saveConfig(ctx.configPath, ctx.config);
    const selected = loadContext(ctx.configPath);
    state.override = (req, res) => {
      if (!req.url?.startsWith('/agentmemory/memories/')) return false;
      const id = decodeURIComponent(req.url.split('/').at(-1)!);
      const memory = state.memories.find((m) => m.id === id);
      res.writeHead(memory ? 200 : 404);
      res.end(JSON.stringify({ memory }));
      return true;
    };
    let calls = 0;
    const bridge = await startMemoryBridge(selected, connection, {
      generate: async () => {
        calls++;
        throw new Error('model forbidden');
      },
    });
    try {
      const saved = await memoryRequest(selected, 'remember', {
        content:
          'Problem: Cold shipping needed a container. Fix: Use blue insulation. Why: The test kept the required temperature.',
      });
      const brief = await memoryRequest(selected, 'ask', { query: 'Cold shipping' });
      assert.equal(brief.mode, 'mock');
      assert.equal(brief.status, 'ready');
      assert.equal(brief.usage.modelCalls, 0);
      assert.equal(brief.actions[0]!.arguments.id, saved.id);
      const expanded = await memoryRequest(selected, 'expand', brief.actions[0]!.arguments);
      assert.equal(expanded.status, 'ready');
      assert.equal(expanded.memory?.content, state.memories[0]!.content);
      assert.ok(expanded.memory?.provenance);
      const { promisify } = await import('node:util');
      const { execFile } = await import('node:child_process');
      const { fileURLToPath } = await import('node:url');
      const run = promisify(execFile);
      const entry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
      const cli = await run(process.execPath, [entry, 'ask', '--config', ctx.configPath, '--query', 'Cold shipping']);
      assert.equal(JSON.parse(cli.stdout).mode, 'mock');
      const detail = await run(process.execPath, [
        entry,
        'expand',
        '--config',
        ctx.configPath,
        '--id',
        saved.id,
        '--revision',
        brief.actions[0]!.arguments.revision,
      ]);
      assert.equal(JSON.parse(detail.stdout).status, 'ready');
      state.memories[0]!.content = 'A newer correction';
      assert.equal((await memoryRequest(selected, 'expand', brief.actions[0]!.arguments)).status, 'changed');
      for (const character of ['中', '\u0001']) {
        state.memories[0]!.content = character.repeat(64000);
        const large = await memoryRequest(selected, 'expand', brief.actions[0]!.arguments);
        assert.equal(large.status, 'changed');
        assert.ok(Buffer.byteLength(JSON.stringify(large)) > 160000);
        assert.ok(large.memory!.content.length + large.memory!.title.length <= 64000);
      }
      state.memories[0]!.project = 'foreign-scope';
      assert.equal((await memoryRequest(selected, 'expand', brief.actions[0]!.arguments)).status, 'missing');
      assert.equal(calls, 0);
    } finally {
      await bridge.close();
    }
  });
});

test('research bridge rejects concurrent inference and aborts work when the caller disconnects', async () => {
  await fixture(async (ctx, connection) => {
    const { submindSettings } = await import('../dist/config.js');
    ctx.config.profiles.personal!.submind = { ...submindSettings(ctx.profile), mode: 'model' };
    await saveConfig(ctx.configPath, ctx.config);
    const selected = loadContext(ctx.configPath);
    let started!: () => void, aborted!: () => void;
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const bridge = await startMemoryBridge(selected, connection, {
      generate: async (_profile, request) => {
        started();
        return new Promise((_, reject) =>
          request.signal!.addEventListener(
            'abort',
            () => {
              aborted();
              reject(new Error('cancelled'));
            },
            { once: true },
          ),
        );
      },
    });
    try {
      const pending = assert.rejects(memoryRequest(selected, 'ask', { query: 'shipping' }, { timeoutMs: 500 }));
      await reached;
      await assert.rejects(memoryRequest(selected, 'ask', { query: 'another question' }), /already researching/);
      await pending;
      await Promise.race([
        stopped,
        new Promise((_, reject) => setTimeout(() => reject(new Error('abort not propagated')), 1500)),
      ]);
    } finally {
      await bridge.close();
    }
  });
});

test('a browser-style abort cancels its private research request and reaches the provider', async () => {
  await fixture(async (ctx, connection) => {
    ctx.profile.submind = {
      mode: 'model',
      hookResearch: 'manual',
      hookWaitMs: 20000,
      maxSteps: 3,
      maxSearches: 3,
      maxCandidates: 12,
      evidenceMaxChars: 12000,
      inputMaxChars: 48000,
      lookbackDays: 90,
      timeoutMs: 10000,
      expandedMaxChars: 12000,
    };
    ctx.config.profiles[ctx.profileId] = ctx.profile;
    await saveConfig(ctx.configPath, ctx.config);
    let started!: () => void, cancelled!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    let calls = 0;
    const bridge = await startMemoryBridge(ctx, connection, {
      store: {
        async search() {
          return { memories: [], inspected: 0, truncated: false, exhaustive: false };
        },
        async read() {
          return { status: 'missing' };
        },
      },
      generate: async (_profile, input) => {
        calls++;
        started();
        return new Promise((_resolve, reject) =>
          input.signal!.addEventListener(
            'abort',
            () => {
              cancelled();
              reject(new Error('synthetic cancellation'));
            },
            { once: true },
          ),
        );
      },
    });
    try {
      const pre = new AbortController();
      pre.abort();
      await assert.rejects(
        memoryRequest(ctx, 'ask', { query: 'synthetic shipping' }, { signal: pre.signal }),
        /cancelled/,
      );
      assert.equal(calls, 0);
      const abort = new AbortController();
      const pending = memoryRequest(ctx, 'ask', { query: 'synthetic shipping' }, { signal: abort.signal });
      await Promise.race([
        ready,
        pending.then(() => {
          throw new Error('research finished before synthetic provider');
        }),
      ]);
      abort.abort();
      await assert.rejects(pending, /cancelled/);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          stopped,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('provider did not receive cancellation')), 1000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      assert.equal(calls, 1);
    } finally {
      await bridge.close();
    }
  });
});

test('background preparation survives the short request socket and holds model ownership through cancellation', async () => {
  await fixture(async (ctx, connection, state) => {
    const { mkdir } = await import('node:fs/promises');
    const { writeConnection } = await import('../dist/installation.js');
    ctx.config.profiles.personal!.submind!.mode = 'model';
    ctx.config.profiles.personal!.submind!.hookResearch = 'background';
    ctx.config.profiles.personal!.hooks.claude = true;
    await saveConfig(ctx.configPath, ctx.config);
    const selected = loadContext(ctx.configPath);
    const workspace = join(ctx.directory, 'hook-workspace');
    await mkdir(workspace);
    await writeConnection(workspace, { configPath: selected.configPath, profileId: selected.profileId });
    const binding = { workspace, host: 'claude' as const, sessionId: 'background-session' };
    let started!: () => void,
      release!: () => void,
      calls = 0;
    let signal!: AbortSignal;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = await startMemoryBridge(selected, connection, {
      store: {
        search: async () => ({ memories: [], exhaustive: false, truncated: false, inspected: 0 }),
        read: async () => ({ status: 'missing' }),
      },
      generate: async (_profile, input) => {
        calls++;
        signal = input.signal!;
        started();
        await waiting;
        return {
          content: { kind: 'answer', findings: [] },
          model: 'synthetic',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    try {
      const prepared = await memoryRequest(
        selected,
        'prepare',
        { ...binding, query: 'synthetic' },
        { timeoutMs: 1800 },
      );
      assert.equal(prepared.status, 'pending');
      await entered;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(signal.aborted, false, 'closing the submission socket does not cancel accepted work');
      const input = prepared.actions.find((action) => action.rel === 'poll')!.arguments;
      assert.equal(
        (await memoryRequest(selected, 'prepare', { ...binding, query: 'synthetic' })).requestId,
        prepared.requestId,
      );
      assert.equal((await memoryRequest(selected, 'brief', input)).status, 'pending');
      await assert.rejects(memoryRequest(selected, 'ask', { query: 'overlap' }), /already researching/);
      assert.equal(calls, 1);
      assert.equal((await memoryRequest(selected, 'cancel-brief', input)).status, 'cancelled');
      assert.equal(signal.aborted, true);
      await assert.rejects(memoryRequest(selected, 'ask', { query: 'still overlap' }), /already researching/);
      release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await memoryRequest(selected, 'ask', { query: 'after settlement' })).mode, 'model');
      assert.equal(calls, 2);
      assert.equal(state.requests.length, 0, 'the supplied synthetic store is the only evidence source');
    } finally {
      release();
      await bridge.close();
    }
  });
});

test('bridge cancels background work on saved selection changes but not a mismatched caller', async () => {
  await fixture(async (ctx, connection) => {
    const { mkdir } = await import('node:fs/promises');
    const { writeConnection } = await import('../dist/installation.js');
    ctx.config.profiles.personal!.submind!.mode = 'model';
    ctx.config.profiles.personal!.submind!.hookResearch = 'background';
    ctx.config.profiles.personal!.hooks.claude = true;
    await saveConfig(ctx.configPath, ctx.config);
    const selected = loadContext(ctx.configPath);
    const workspace = join(ctx.directory, 'changing-workspace');
    await mkdir(workspace);
    await writeConnection(workspace, { configPath: selected.configPath, profileId: selected.profileId });
    let started!: () => void, release!: () => void;
    let signal!: AbortSignal;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = await startMemoryBridge(selected, connection, {
      store: {
        search: async () => ({ memories: [], exhaustive: false, truncated: false, inspected: 0 }),
        read: async () => ({ status: 'missing' }),
      },
      generate: async (_profile, input) => {
        signal = input.signal!;
        started();
        await waiting;
        return {
          content: { kind: 'answer', findings: [] },
          model: 'synthetic',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    try {
      const prepared = await memoryRequest(selected, 'prepare', {
        workspace,
        host: 'claude',
        sessionId: 'selection-session',
        query: 'synthetic',
      });
      await entered;
      const input = prepared.actions.find((action) => action.rel === 'poll')!.arguments;
      const mismatch = structuredClone(selected);
      mismatch.profile.model.model = 'caller-only-change';
      await assert.rejects(memoryRequest(mismatch, 'brief', input), /settings changed/);
      assert.equal(signal.aborted, false);
      assert.equal((await memoryRequest(selected, 'brief', input)).status, 'pending');
      const waiting = assert.rejects(
        memoryRequest(selected, 'brief', { ...input, waitMs: 60_000 }),
        /settings changed/,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      selected.config.profiles.personal!.model.model = 'saved-change';
      await saveConfig(selected.configPath, selected.config);
      const updated = loadContext(selected.configPath);
      await assert.rejects(memoryRequest(updated, 'brief', input), /settings changed/);
      await waiting;
      assert.equal(signal.aborted, true);
    } finally {
      release();
      await bridge.close();
    }
  });
});

test('brief waits use the requested deadline and disconnects do not cancel accepted research', async () => {
  await fixture(async (ctx, connection, state) => {
    const { mkdir } = await import('node:fs/promises');
    const { writeConnection } = await import('../dist/installation.js');
    ctx.config.profiles.personal!.submind!.mode = 'model';
    ctx.config.profiles.personal!.submind!.hookResearch = 'wait';
    ctx.config.profiles.personal!.hooks.claude = true;
    await saveConfig(ctx.configPath, ctx.config);
    const selected = loadContext(ctx.configPath);
    const workspace = join(ctx.directory, 'waiting-workspace');
    await mkdir(workspace);
    await writeConnection(workspace, { configPath: selected.configPath, profileId: selected.profileId });
    let release!: () => void,
      calls = 0;
    let signal!: AbortSignal;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = await startMemoryBridge(selected, connection, {
      store: {
        search: async () => ({ memories: [], exhaustive: false, truncated: false, inspected: 0 }),
        read: async () => ({ status: 'missing' }),
      },
      generate: async (_profile, input) => {
        signal = input.signal!;
        calls++;
        await held;
        return {
          content: { kind: 'answer', findings: [] },
          model: 'synthetic',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const receipt = await memoryRequest(selected, 'prepare', {
        workspace,
        host: 'claude',
        sessionId: 'wait-session',
        query: 'synthetic',
      });
      const input = receipt.actions.find((action) => action.rel === 'poll')!.arguments;
      assert.equal((await memoryRequest(selected, 'brief', { ...input, waitMs: 20 })).status, 'pending');
      assert.equal(calls, 1);
      // A long wait is legal at both ends; a short explicit transport deadline only
      // abandons this waiter, while the server-owned job retains its model lease.
      await assert.rejects(
        memoryRequest(selected, 'brief', { ...input, waitMs: 60_000 }, { timeoutMs: 50 }),
        /did not respond in time/,
      );
      assert.equal(signal.aborted, false);
      const abort = new AbortController();
      const abandoned = memoryRequest(selected, 'brief', { ...input, waitMs: 60_000 }, { signal: abort.signal });
      const rejected = assert.rejects(abandoned, /cancelled/);
      timer = setTimeout(() => abort.abort(), 30);
      await rejected;
      clearTimeout(timer);
      assert.equal(signal.aborted, false);
      const completed = memoryRequest(selected, 'brief', { ...input, waitMs: 60_000 });
      timer = setTimeout(release, 40);
      const response = await completed;
      assert.equal(response.status, 'empty');
      assert.equal(response.result!.usage.modelCalls, 1);
      assert.equal(calls, 1);
      assert.equal(state.requests.length, 0);
      await assert.rejects(memoryRequest(selected, 'cancel-brief', { ...input, waitMs: 0 } as any), /invalid/i);
      await assert.rejects(memoryRequest(selected, 'brief', { ...input, waitMs: 60_001 }), /invalid/i);
    } finally {
      clearTimeout(timer);
      release();
      await bridge.close();
    }
  });
});
