import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadContext, saveConfig } from '../dist/config.js';
import { createHookResearchRegistry, validateHookResearchInput } from '../dist/hook-research.js';
import type { HookBriefInput, HookResearchBinding } from '../src/hook-research.js';
import { writeConnection, removeConnection } from '../dist/installation.js';
import { bindSession } from '../dist/sessions.js';
import { ModelBusyError } from '../dist/model-gate.js';
import type { SubmindResult } from '../src/submind-types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function result(mode: 'mock' | 'model' = 'mock'): SubmindResult {
  return {
    schema: 'echo-memory/v1',
    requestId: 'synthetic-research',
    status: 'ready',
    mode,
    findings: [
      {
        problem: 'Synthetic cold shipment',
        fix: 'Use insulation',
        why: 'Keeps it cold',
        citations: [{ id: 'mem_example', revision: 'a'.repeat(64) }],
      },
    ],
    actions: [
      { rel: 'read_more', operation: 'memory.expand', arguments: { id: 'mem_example', revision: 'a'.repeat(64) } },
    ],
    coverage: {
      exhaustive: false,
      since: '2026-01-01T00:00:00.000Z',
      inspected: 1,
      stopReason: 'complete',
      truncated: false,
    },
    usage: {
      modelCalls: mode === 'mock' ? 0 : 1,
      searches: 1,
      evidenceChars: 10,
      inputChars: 10,
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs: 1,
    },
  };
}
async function fixture(
  t: TestContext,
  dependencies: Parameters<typeof createHookResearchRegistry>[1],
  options: { mode?: 'off' | 'mock' | 'model'; policy?: 'manual' | 'background' | 'wait' } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'echo-hook-research-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const config = defaultConfig();
  config.profiles.personal!.hooks = { claude: true, codex: true, vscode: true };
  config.profiles.personal!.submind!.mode = options.mode ?? 'mock';
  config.profiles.personal!.submind!.hookResearch = options.policy ?? 'background';
  await saveConfig(join(directory, 'settings.json'), config);
  const ctx = loadContext(join(directory, 'settings.json'));
  await writeConnection(workspace, { configPath: ctx.configPath, profileId: ctx.profileId });
  const registry = createHookResearchRegistry(ctx, dependencies);
  const binding: HookResearchBinding = { workspace, host: 'claude', sessionId: 'synthetic-session' };
  t.after(async () => {
    registry.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, workspace, config, ctx, binding, registry };
}
async function settled(registry: ReturnType<typeof createHookResearchRegistry>, input: HookBriefInput) {
  for (let i = 0; i < 50; i++) {
    const answer = await registry.brief(input);
    if (answer.status !== 'pending') return answer;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('synthetic research did not settle');
}

test('background input is strict and cannot add arbitrary endpoints, identities, or malformed handles', () => {
  const binding = { workspace: '/example', host: 'claude', sessionId: 'session' };
  for (const input of [
    null,
    [],
    { ...binding, query: 'safe', endpoint: 'https://example.com' },
    { ...binding, query: 'safe', host: ['claude'] },
    { ...binding, query: 'safe', workspace: 'relative' },
    { ...binding, query: 'safe', sessionId: 'x'.repeat(513) },
    { ...binding, query: '' },
  ])
    assert.throws(() => validateHookResearchInput('prepare', input));
  for (const requestId of [null, '', 'x', '../path', 'x'.repeat(33)])
    assert.throws(() => validateHookResearchInput('brief', { ...binding, requestId }));
});

test('manual and off policies cannot start background research', async (t) => {
  let calls = 0;
  for (const options of [{ policy: 'manual' as const }, { mode: 'off' as const }]) {
    const f = await fixture(
      t,
      {
        research: async () => {
          calls++;
          return result();
        },
      },
      options,
    );
    assert.equal((await f.registry.prepare({ ...f.binding, query: 'synthetic' })).status, 'disabled');
  }
  assert.equal(calls, 0);
});

test('preparation deduplicates work, preserves cached poll handles, and polling never runs inference', async (t) => {
  let calls = 0;
  const entered = deferred(),
    release = deferred();
  const f = await fixture(t, {
    research: async () => {
      calls++;
      entered.resolve();
      await release.promise;
      return result();
    },
  });
  try {
    const first = await f.registry.prepare({ ...f.binding, query: 'synthetic' });
    await entered.promise;
    assert.equal(first.status, 'pending');
    assert.match(first.requestId!, /^[A-Za-z0-9_-]{32}$/);
    assert.deepEqual(
      first.actions.map((action) => action.operation),
      ['memory.brief', 'memory.cancel_brief'],
    );
    const input = first.actions[0]!.arguments;
    assert.equal((await f.registry.prepare({ ...f.binding, query: 'synthetic' })).requestId, first.requestId);
    for (let i = 0; i < 3; i++) assert.equal((await f.registry.brief(input)).status, 'pending');
    assert.equal(calls, 1);
    release.resolve();
    const done = await settled(f.registry, input);
    assert.equal(done.status, 'ready');
    assert.deepEqual(done.result, result());
    assert.deepEqual(done.actions, []);
    const cached = await f.registry.prepare({ ...f.binding, query: 'synthetic' });
    assert.equal(cached.requestId, first.requestId);
    assert.equal(cached.status, 'ready');
    assert.equal(cached.actions[0]!.operation, 'memory.brief');
    assert.equal(calls, 1);
    // Callers cannot rewrite the cached result by mutating their own copy.
    cached.result!.findings[0]!.fix = 'mutated';
    assert.equal((await f.registry.brief(input)).result!.findings[0]!.fix, 'Use insulation');
  } finally {
    release.resolve();
  }
});

test('opaque results are isolated by canonical workspace, host, and session', async (t) => {
  const f = await fixture(t, { research: async () => result() });
  const second = join(f.directory, 'other-workspace');
  await mkdir(second);
  await writeConnection(second, { configPath: f.ctx.configPath, profileId: f.ctx.profileId });
  const first = await f.registry.prepare({ ...f.binding, query: 'synthetic' });
  const input = first.actions[0]!.arguments;
  await settled(f.registry, input);
  for (const other of [
    { ...input, workspace: second },
    { ...input, host: 'codex' as const },
    { ...input, sessionId: 'other-session' },
  ]) {
    const response = await f.registry.brief(other);
    assert.equal(response.status, 'expired');
    assert.equal(response.result, undefined);
    assert.equal((await f.registry.cancel(other)).status, 'expired');
  }
  assert.equal((await f.registry.brief(input)).status, 'ready');
  const alias = join(f.directory, 'workspace-alias');
  await symlink(f.workspace, alias);
  assert.equal(
    (await f.registry.prepare({ ...f.binding, workspace: alias, query: 'synthetic' })).requestId,
    first.requestId,
  );
});

test('an unrelated stale session cannot cancel an active session in the same workspace', async (t) => {
  const release = deferred();
  let signal!: AbortSignal;
  const f = await fixture(t, {
    research: async (_query, received) => {
      signal = received;
      await release.promise;
      return result();
    },
  });
  const stale = structuredClone(f.ctx);
  stale.profile.model.model = 'old-selection';
  await bindSession(stale, 'claude', 'old-session', { workspace: f.workspace });
  try {
    const first = await f.registry.prepare({ ...f.binding, query: 'synthetic' });
    const rejected = await f.registry.prepare({ ...f.binding, sessionId: 'old-session', query: 'other' });
    assert.equal(rejected.status, 'unavailable');
    assert.equal(signal.aborted, false);
    release.resolve();
    assert.equal((await settled(f.registry, first.actions[0]!.arguments)).status, 'ready');
  } finally {
    release.resolve();
  }
});

test('competing sessions are busy and a newer prompt cancels without overlapping unfinished work', async (t) => {
  const release = deferred();
  let calls = 0,
    signal!: AbortSignal;
  const f = await fixture(t, {
    research: async (_query, received) => {
      calls++;
      signal = received;
      await release.promise;
      return result();
    },
  });
  try {
    const first = await f.registry.prepare({ ...f.binding, query: 'first' });
    assert.equal((await f.registry.prepare({ ...f.binding, sessionId: 'other', query: 'other' })).status, 'busy');
    assert.equal(signal.aborted, false);
    assert.equal((await f.registry.prepare({ ...f.binding, query: 'newer' })).status, 'busy');
    assert.equal(signal.aborted, true);
    assert.equal((await f.registry.brief(first.actions[0]!.arguments)).status, 'cancelled');
    assert.equal((await f.registry.prepare({ ...f.binding, query: 'newer' })).status, 'busy');
    assert.equal(calls, 1);
    release.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    const next = await f.registry.prepare({ ...f.binding, query: 'newer' });
    assert.notEqual(next.requestId, first.requestId);
    assert.equal(calls, 2);
    assert.equal((await settled(f.registry, next.actions[0]!.arguments)).status, 'ready');
  } finally {
    release.resolve();
  }
});

test('cancellation, expiry, shutdown, and retained byte/count limits bound transient work', async (t) => {
  let time = 0;
  const release = deferred();
  let signal!: AbortSignal;
  const active = await fixture(t, {
    now: () => time,
    ttlMs: 10000,
    research: async (_query, received) => {
      signal = received;
      await release.promise;
      return result();
    },
  });
  try {
    const first = await active.registry.prepare({ ...active.binding, query: 'synthetic' });
    time = 10001;
    assert.equal((await active.registry.brief(first.actions[0]!.arguments)).status, 'expired');
    assert.equal(signal.aborted, true);
    assert.equal((await active.registry.prepare({ ...active.binding, query: 'newer' })).status, 'busy');
    release.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    release.resolve();
  }
  const bounded = await fixture(t, { maxJobs: 2, research: async () => result() });
  const handles: HookBriefInput[] = [];
  for (const query of ['first', 'second', 'third']) {
    const prepared = await bounded.registry.prepare({ ...bounded.binding, query });
    handles.push(prepared.actions[0]!.arguments);
    await settled(bounded.registry, handles.at(-1)!);
  }
  assert.equal((await bounded.registry.brief(handles[0]!)).status, 'expired');
  assert.equal((await bounded.registry.brief(handles[2]!)).status, 'ready');
  assert.equal((await bounded.registry.cancel(handles[2]!)).status, 'cancelled');
  assert.equal((await bounded.registry.brief(handles[2]!)).result, undefined);
  const bytes = await fixture(t, {
    maxBytes: 2500,
    research: async () => {
      const large = result();
      large.findings[0]!.fix = '界'.repeat(5000);
      return large;
    },
  });
  const prepared = await bytes.registry.prepare({ ...bytes.binding, query: 'large' });
  const response = await settled(bytes.registry, prepared.actions[0]!.arguments);
  assert.equal(response.status, 'unavailable');
  assert.equal(response.result, undefined);
  bounded.registry.close();
  assert.equal((await bounded.registry.brief(handles[1]!)).status, 'unavailable');
});

test('connection or trusted settings changes cancel affected work without exposing old evidence', async (t) => {
  for (const change of ['connection', 'settings', 'untrusted'] as const) {
    const release = deferred();
    let signal!: AbortSignal;
    const f = await fixture(t, {
      research: async (_query, received) => {
        signal = received;
        await release.promise;
        return result();
      },
    });
    try {
      const first = await f.registry.prepare({ ...f.binding, query: 'synthetic' });
      if (change === 'connection') await removeConnection(f.workspace);
      else if (change === 'settings') {
        f.config.profiles.personal!.identity.project = 'changed';
        await saveConfig(f.ctx.configPath, f.config);
      } else await writeFile(f.ctx.configPath, '{"untrusted":"settings"}');
      const response = await f.registry.brief(first.actions[0]!.arguments);
      assert.equal(response.status, 'unavailable');
      assert.equal(response.result, undefined);
      assert.equal(signal.aborted, true);
      release.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await f.registry.prepare({ ...f.binding, query: 'newer' })).status, 'unavailable');
    } finally {
      release.resolve();
    }
  }
});

test('a process model gate refusal is visible and can be retried without a hidden queue', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    research: async () => {
      calls++;
      throw new ModelBusyError();
    },
  });
  const first = await f.registry.prepare({ ...f.binding, query: 'synthetic' });
  assert.equal((await settled(f.registry, first.actions[0]!.arguments)).status, 'busy');
  const retry = await f.registry.prepare({ ...f.binding, query: 'synthetic' });
  assert.notEqual(retry.requestId, first.requestId);
  assert.equal(calls, 2);
});

test('disabling a host stops new preparation while existing brief and cancellation stay accessible', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    research: async () => {
      calls++;
      return result();
    },
  });
  const first = await f.registry.prepare({ ...f.binding, query: 'synthetic' });
  await settled(f.registry, first.actions[0]!.arguments);
  f.config.profiles.personal!.hooks.claude = false;
  await saveConfig(f.ctx.configPath, f.config);
  assert.equal((await f.registry.prepare({ ...f.binding, query: 'newer' })).status, 'disabled');
  assert.equal((await f.registry.brief(first.actions[0]!.arguments)).status, 'ready');
  assert.equal((await f.registry.cancel(first.actions[0]!.arguments)).status, 'cancelled');
  assert.equal(calls, 1);
});

test('a repeated cached prompt cancels newer in-flight work before returning its existing brief', async (t) => {
  const release = deferred(),
    entered = deferred();
  let activeSignal!: AbortSignal,
    calls = 0;
  const f = await fixture(t, {
    research: async (query, signal) => {
      calls++;
      if (query === 'B') {
        activeSignal = signal;
        entered.resolve();
        await release.promise;
      }
      return result();
    },
  });
  try {
    const first = await f.registry.prepare({ ...f.binding, query: 'A' });
    await settled(f.registry, first.actions[0]!.arguments);
    const second = await f.registry.prepare({ ...f.binding, query: 'B' });
    await entered.promise;
    const repeated = await f.registry.prepare({ ...f.binding, query: 'A' });
    assert.equal(repeated.status, 'ready');
    assert.equal(repeated.requestId, first.requestId);
    assert.equal(repeated.actions[0]!.operation, 'memory.brief');
    assert.equal(activeSignal.aborted, true);
    assert.equal((await f.registry.brief(second.actions[0]!.arguments)).status, 'cancelled');
    assert.equal(calls, 2);
  } finally {
    release.resolve();
  }
});

test('only brief accepts a bounded wait and generated actions retain their immediate binding contract', async (t) => {
  const input = { workspace: '/example', host: 'claude', sessionId: 'session', requestId: 'x'.repeat(32) };
  for (const waitMs of [0, 1, 20_000, 60_000])
    assert.equal(validateHookResearchInput('brief', { ...input, waitMs }).waitMs, waitMs);
  for (const waitMs of [-1, 60_001, 1.5, '20', null, Infinity, NaN])
    assert.throws(() => validateHookResearchInput('brief', { ...input, waitMs }));
  assert.throws(() => validateHookResearchInput('cancel-brief', { ...input, waitMs: 0 }));
  assert.throws(() =>
    validateHookResearchInput('prepare', {
      workspace: input.workspace,
      host: input.host,
      sessionId: input.sessionId,
      query: 'synthetic',
      waitMs: 0,
    }),
  );
  const f = await fixture(t, { research: async () => result() }, { policy: 'wait' });
  const receipt = await f.registry.prepare({ ...f.binding, query: 'synthetic' });
  assert.ok(receipt.requestId);
  for (const action of receipt.actions) assert.equal(Object.hasOwn(action.arguments, 'waitMs'), false);
  assert.equal((await f.registry.brief({ ...receipt.actions[0]!.arguments, waitMs: 1000 })).status, 'ready');
});

test('bounded brief waits return completion or a pending handle without starting more research', async (t) => {
  const release = deferred();
  let calls = 0;
  const f = await fixture(t, {
    research: async () => {
      calls++;
      await release.promise;
      return result();
    },
  });
  const receipt = await f.registry.prepare({ ...f.binding, query: 'synthetic' });
  const input = receipt.actions[0]!.arguments;
  let releaseTimer: NodeJS.Timeout | undefined;
  try {
    assert.equal((await f.registry.brief(input)).status, 'pending');
    assert.equal((await f.registry.brief({ ...input, waitMs: 0 })).status, 'pending');
    const timedOut = await f.registry.brief({ ...input, waitMs: 20 });
    assert.equal(timedOut.status, 'pending');
    assert.equal(timedOut.actions[0]!.arguments.requestId, input.requestId);
    const waiting = f.registry.brief({ ...input, waitMs: 1000 });
    releaseTimer = setTimeout(release.resolve, 50);
    const done = await waiting;
    assert.equal(done.status, 'ready');
    assert.deepEqual(done.result, result());
    assert.equal(calls, 1);
    assert.equal(done.actions.length, 1);
    assert.equal(done.actions[0]!.operation, 'memory.brief');
    assert.deepEqual(done.actions[0]!.arguments, input);
    const retrieved = await f.registry.brief(done.actions[0]!.arguments);
    assert.deepEqual(retrieved.result, done.result);
    assert.deepEqual(retrieved.actions, []);
    assert.deepEqual((await f.registry.brief({ ...input, waitMs: 0 })).actions, []);
    assert.equal((await f.registry.brief({ ...input, waitMs: 60_000 })).status, 'ready');
    assert.equal(calls, 1);
  } finally {
    clearTimeout(releaseTimer);
    release.resolve();
  }
});

test('aborting one brief waiter leaves the accepted job and another waiter running', async (t) => {
  const release = deferred();
  let signal!: AbortSignal,
    calls = 0;
  const f = await fixture(t, {
    research: async (_query, received) => {
      calls++;
      signal = received;
      await release.promise;
      return result();
    },
  });
  const receipt = await f.registry.prepare({ ...f.binding, query: 'synthetic' });
  const input = receipt.actions[0]!.arguments;
  const controller = new AbortController();
  let abortTimer: NodeJS.Timeout | undefined;
  try {
    const abandoned = f.registry.brief({ ...input, waitMs: 60_000 }, controller.signal);
    const checked = assert.rejects(abandoned, { name: 'AbortError' });
    const kept = f.registry.brief({ ...input, waitMs: 1000 });
    abortTimer = setTimeout(() => controller.abort(), 30);
    await checked;
    assert.equal(signal.aborted, false);
    assert.equal((await f.registry.brief(input)).status, 'pending');
    release.resolve();
    assert.equal((await kept).status, 'ready');
    assert.equal(calls, 1);
    await assert.rejects(f.registry.brief({ ...input, waitMs: 1000 }, controller.signal), { name: 'AbortError' });
  } finally {
    clearTimeout(abortTimer);
    release.resolve();
  }
});

test('cancellation, expiry, and shutdown wake waiters without waiting for provider settlement', async (t) => {
  for (const change of ['cancel', 'expire', 'close'] as const) {
    const release = deferred();
    let signal!: AbortSignal;
    const f = await fixture(t, {
      ...(change === 'expire' ? { ttlMs: 200 } : {}),
      research: async (_query, received) => {
        signal = received;
        await release.promise;
        return result();
      },
    });
    const receipt = await f.registry.prepare({ ...f.binding, query: 'synthetic' });
    const input = receipt.actions[0]!.arguments;
    let changeTimer: NodeJS.Timeout | undefined;
    try {
      const waiting = f.registry.brief({ ...input, waitMs: 1000 });
      if (change !== 'expire')
        changeTimer = setTimeout(() => {
          if (change === 'close') f.registry.close();
          else void f.registry.cancel(input);
        }, 30);
      const response = await waiting;
      assert.equal(
        response.status,
        change === 'cancel' ? 'cancelled' : change === 'expire' ? 'expired' : 'unavailable',
      );
      assert.equal(response.result, undefined);
      assert.equal(signal.aborted, true);
    } finally {
      clearTimeout(changeTimer);
      release.resolve();
    }
  }
});

test('wait completion rechecks settings and connection trust before exposing a result', async (t) => {
  for (const change of ['settings', 'connection'] as const) {
    const release = deferred();
    let signal!: AbortSignal;
    const f = await fixture(t, {
      research: async (_query, received) => {
        signal = received;
        await release.promise;
        return result();
      },
    });
    const receipt = await f.registry.prepare({ ...f.binding, query: 'synthetic' });
    try {
      const waiting = f.registry.brief({ ...receipt.actions[0]!.arguments, waitMs: 60 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (change === 'settings') {
        f.config.profiles.personal!.identity.project = 'changed';
        await saveConfig(f.ctx.configPath, f.config);
      } else await removeConnection(f.workspace);
      const response = await waiting;
      assert.equal(response.status, 'unavailable');
      assert.equal(response.result, undefined);
      assert.equal(signal.aborted, true);
    } finally {
      release.resolve();
    }
  }
});

test('brief waiter retention is bounded and aborted waiters release their slots', async (t) => {
  const release = deferred();
  let signal!: AbortSignal;
  const f = await fixture(t, {
    research: async (_query, received) => {
      signal = received;
      await release.promise;
      return result();
    },
  });
  const receipt = await f.registry.prepare({ ...f.binding, query: 'synthetic' });
  const input = receipt.actions[0]!.arguments;
  const controllers = Array.from({ length: 32 }, () => new AbortController());
  const waits = controllers.map((controller) =>
    f.registry.brief({ ...input, waitMs: 60_000 }, controller.signal).catch(() => undefined),
  );
  let guard: NodeJS.Timeout | undefined;
  try {
    const overflow = await Promise.race([
      ...waits,
      new Promise<never>((_resolve, reject) => {
        guard = setTimeout(() => reject(new Error('waiter bound not enforced')), 2000);
      }),
    ]);
    assert.equal(overflow?.status, 'pending');
    for (const controller of controllers) controller.abort();
    await Promise.all(waits);
    assert.equal(signal.aborted, false);
    const next = f.registry.brief({ ...input, waitMs: 1000 });
    release.resolve();
    assert.equal((await next).status, 'ready');
  } finally {
    clearTimeout(guard);
    for (const controller of controllers) controller.abort();
    release.resolve();
    await Promise.all(waits);
  }
});
