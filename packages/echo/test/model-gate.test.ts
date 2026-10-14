import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadContext, saveConfig } from '../dist/config.js';
import { withModelOperation, ModelBusyError } from '../dist/model-gate.js';
import { memoryRequest, startMemoryBridge } from '../dist/memory.js';
import { startWeb } from '../dist/web.js';
import type { SubmindGenerator } from '../src/submind.js';
import type { ModelSetupDependencies } from '../src/model-setup-types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
const answer = () => ({ content: { kind: 'answer', findings: [] }, model: 'synthetic', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } });
const ready = () => ({ ...answer(), content: { status: 'ready', evidenceId: 'echo-model-test' } });
async function fixture(t: TestContext, generation: SubmindGenerator, setupGeneration: NonNullable<ModelSetupDependencies['generate']>, mode: 'off' | 'mock' | 'model' = 'model') {
  const directory = await mkdtemp(join(tmpdir(), 'echo-gate-'));
  const configPath = join(directory, 'settings.json');
  const config = defaultConfig();
  config.profiles.personal!.submind!.mode = mode;
  config.profiles.personal!.model.model = 'synthetic';
  await saveConfig(configPath, config);
  const ctx = loadContext(configPath);
  const store = {
    search: async () => ({ memories: [], truncated: false, exhaustive: false as const, inspected: 0 }),
    read: async () => ({ status: 'missing' as const }),
  };
  const bridge = await startMemoryBridge(ctx, { url: 'http://127.0.0.1:1', secret: 'unused-synthetic', close: async () => {} }, { store, generate: generation });
  const webContext = structuredClone(ctx); webContext.profile.web.port = 0;
  const web = await startWeb(webContext, { modelSetup: { generate: setupGeneration } });
  t.after(async () => { await web.close(); await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  const revision = (await (await fetch(`${web.url}/api/settings`)).json()).revision;
  const modelTest = (signal?: AbortSignal) => fetch(`${web.url}/api/model/test`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': revision }, body: JSON.stringify({ profileId: 'personal' }), signal,
  });
  return { ctx, modelTest };
}

test('process model ownership rejects overlap and releases after success or failure', async () => {
  const release = deferred();
  const active = withModelOperation(async () => { await release.promise; return 'done'; });
  try { await assert.rejects(withModelOperation(async () => 'overlap'), ModelBusyError); }
  finally { release.resolve(); }
  assert.equal(await active, 'done');
  await assert.rejects(withModelOperation(async () => { throw new Error('synthetic-failure'); }), /synthetic-failure/);
  assert.equal(await withModelOperation(async () => 'next'), 'next');
});

test('web model tests block private-bridge inference until cancelled underlying generation settles', async t => {
  const entered = deferred(), release = deferred(), cancelled = deferred();
  let researchCalls = 0;
  const service = await fixture(t, async () => { researchCalls++; return answer(); }, async (_profile, request) => {
    request.signal!.addEventListener('abort', cancelled.resolve, { once: true });
    entered.resolve(); await release.promise; return ready();
  });
  const controller = new AbortController();
  const pending = service.modelTest(controller.signal);
  const rejection = assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
  try {
    await entered.promise;
    await assert.rejects(memoryRequest(service.ctx, 'ask', { query: 'synthetic' }), /already researching/);
    assert.equal(researchCalls, 0);
    controller.abort(); await rejection; await cancelled.promise;
    await assert.rejects(memoryRequest(service.ctx, 'ask', { query: 'still blocked' }), /already researching/);
    assert.equal(researchCalls, 0);
    release.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await memoryRequest(service.ctx, 'ask', { query: 'synthetic' })).mode, 'model');
    assert.equal(researchCalls, 1);
  } finally { controller.abort(); release.resolve(); await rejection; }
});

test('private-bridge inference blocks web setup after client cancellation until the actual generator stops', async t => {
  const entered = deferred(), release = deferred(), cancelled = deferred();
  let setupCalls = 0;
  const service = await fixture(t, async (_profile, request) => {
    request.signal!.addEventListener('abort', cancelled.resolve, { once: true });
    entered.resolve(); await release.promise; return answer();
  }, async () => { setupCalls++; return ready(); });
  const controller = new AbortController();
  const pending = memoryRequest(service.ctx, 'ask', { query: 'synthetic' }, { signal: controller.signal });
  const rejection = assert.rejects(pending, /cancelled/);
  try {
    await entered.promise;
    let blocked = await service.modelTest();
    assert.equal(blocked.status, 409); assert.equal((await blocked.json()).code, 'busy');
    assert.equal(setupCalls, 0);
    controller.abort(); await rejection; await cancelled.promise;
    blocked = await service.modelTest();
    assert.equal(blocked.status, 409); assert.equal((await blocked.json()).code, 'busy');
    assert.equal(setupCalls, 0);
    release.resolve(); await new Promise(resolve => setImmediate(resolve));
    const next = await service.modelTest();
    assert.equal(next.status, 200); assert.equal((await next.json()).status, 'ready');
    assert.equal(setupCalls, 1);
  } finally { controller.abort(); release.resolve(); await rejection; }
});

for (const mode of ['off', 'mock'] as const) test(`${mode} private research never acquires the process model gate`, async t => {
  let calls = 0;
  const service = await fixture(t, async () => { calls++; throw new Error('model forbidden'); }, async () => ready(), mode);
  const release = deferred();
  const occupied = withModelOperation(async () => release.promise);
  try { assert.equal((await memoryRequest(service.ctx, 'ask', { query: 'synthetic' })).mode, mode); assert.equal(calls, 0); }
  finally { release.resolve(); await occupied; }
});
