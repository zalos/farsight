import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { startWeb } from '../dist/web.js';
import { defaultConfig, saveConfig } from '../dist/config.js';
import { discoverSetupModels, ModelSetupFailure, testSetupModel } from '../dist/model-setup.js';
import type { ModelSetupDependencies } from '../src/model-setup-types.js';
import type { EchoConfig, EchoContext } from '../src/types.js';
import type { SubmindModelResponse } from '../src/submind-types.js';

const ready = (): SubmindModelResponse => ({
  content: { status: 'ready', evidenceId: 'echo-model-test' },
  model: 'untrusted-provider-model',
  finishReason: 'stop',
  usage: { inputTokens: 31, outputTokens: 12 },
});
function fixture(): EchoConfig {
  const config = defaultConfig();
  config.profiles.personal!.model.model = 'example-local';
  config.profiles.work!.model = {
    provider: 'openai-compatible',
    baseUrl: 'https://model.example',
    model: 'example-hosted',
  };
  return config;
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function setup(t: TestContext, options: Parameters<typeof startWeb>[1] = {}, config = fixture()) {
  const directory = await mkdtemp(join(tmpdir(), 'echo-model-setup-'));
  const configPath = join(directory, 'settings.json');
  await saveConfig(configPath, config);
  const ctx: EchoContext = {
    configPath,
    config,
    profileId: 'personal',
    profile: structuredClone(config.profiles.personal!),
    directory,
    dataDirectory: join(directory, 'personal'),
  };
  ctx.profile.web.port = 0;
  const service = await startWeb(ctx, options);
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await service.close();
    }
  };
  t.after(async () => {
    await close();
    await rm(directory, { recursive: true, force: true });
  });
  const state = async () => (await fetch(`${service.url}/api/settings`)).json();
  const post = async (action: string, revision: string, profileId = 'personal', signal?: AbortSignal) =>
    fetch(`${service.url}/api/model/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': revision },
      body: JSON.stringify({ profileId }),
      signal,
    });
  return { ...service, close, config, configPath, state, post };
}

test('setup discovery is explicit, bounded, and does not generate; compatible discovery is unsupported', async () => {
  const profile = fixture().profiles.personal!;
  let lists = 0,
    generations = 0;
  const dependencies: ModelSetupDependencies = {
    list: async (selected, options) => {
      lists++;
      assert.equal(selected, profile);
      assert.ok(options.signal);
      return ['z-model', 'a-model', 'z-model'];
    },
    generate: async () => {
      generations++;
      return ready();
    },
  };
  const found = await discoverSetupModels('personal', profile, new AbortController().signal, dependencies);
  assert.deepEqual(found, {
    schema: 'echo-model-setup/v1',
    profileId: 'personal',
    provider: 'ollama',
    origin: 'http://127.0.0.1:11434',
    model: 'example-local',
    status: 'ready',
    models: ['a-model', 'z-model'],
    truncated: false,
  });
  const unsupported = await discoverSetupModels(
    'work',
    fixture().profiles.work!,
    new AbortController().signal,
    dependencies,
  );
  assert.equal(unsupported.status, 'unsupported');
  assert.deepEqual(unsupported.models, []);
  assert.equal(lists, 1);
  assert.equal(generations, 0);
  const bounded = await discoverSetupModels('personal', profile, new AbortController().signal, {
    list: async () => Array.from({ length: 300 }, (_, i) => `example-${i}`),
  });
  assert.equal(bounded.models.length, 256);
  assert.equal(bounded.truncated, true);
});

test('explicit model test runs once over synthetic evidence even in off/mock mode, and returns only trusted identity', async () => {
  for (const mode of ['off', 'mock'] as const) {
    const profile = fixture().profiles.personal!;
    profile.submind!.mode = mode;
    let calls = 0;
    const result = await testSetupModel('personal', profile, new AbortController().signal, {
      generate: async (selected, input) => {
        calls++;
        assert.equal(selected.submind!.mode, mode);
        assert.equal(input.maxOutputTokens, profile.budget.modelMaxTokens);
        assert.ok(input.signal);
        assert.equal(input.schema.additionalProperties, false);
        assert.deepEqual(input.schema.required, ['status', 'evidenceId']);
        assert.equal(JSON.parse(input.messages[1]!.content).id, 'echo-model-test');
        assert.doesNotMatch(JSON.stringify(input), /local-memory|saved-user-content/);
        return ready();
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.model, 'example-local');
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.usage, { modelCalls: 1, inputTokens: 31, outputTokens: 12 });
    assert.ok(result.elapsedMs >= 0);
    assert.doesNotMatch(JSON.stringify(result), /untrusted-provider-model|evidenceId|secret/);
  }
});

test('synthetic model tests honor the saved output allowance without an extra ceiling or budget increase', async () => {
  for (const modelMaxTokens of [32, 128, 1024, 4096]) {
    const profile = fixture().profiles.work!;
    profile.budget.modelMaxTokens = modelMaxTokens;
    const original = structuredClone(profile);
    let calls = 0;
    await testSetupModel('work', profile, new AbortController().signal, {
      generate: async (selected, input) => {
        calls++;
        assert.equal(selected.budget.modelMaxTokens, modelMaxTokens);
        assert.equal(input.maxOutputTokens, modelMaxTokens);
        return ready();
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(profile, original);
  }
});

test('model setup validates strict structured replies and never propagates provider errors', async () => {
  const profile = fixture().profiles.personal!;
  for (const content of [
    null,
    [],
    {},
    { status: 'ready' },
    { status: 'ready', evidenceId: 'other' },
    { status: 'ready', evidenceId: 'echo-model-test', privateValue: 'private-provider-value' },
  ]) {
    await assert.rejects(
      testSetupModel('personal', profile, new AbortController().signal, {
        generate: async () => ({ ...ready(), content }),
      }),
      (error) => error instanceof ModelSetupFailure && error.code === 'invalid_response',
    );
  }
  await assert.rejects(
    testSetupModel('personal', profile, new AbortController().signal, {
      generate: async () => {
        throw new Error('private-provider-value');
      },
    }),
    (error) =>
      error instanceof ModelSetupFailure &&
      error.code === 'failed' &&
      !error.message.includes('private-provider-value'),
  );
  await assert.rejects(
    discoverSetupModels('personal', profile, new AbortController().signal, { list: async () => ['bad\nmodel'] }),
    (error) => error instanceof ModelSetupFailure && error.code === 'invalid_response',
  );
  const result = await testSetupModel('personal', profile, new AbortController().signal, {
    generate: async () => ({ ...ready(), usage: { inputTokens: -1, outputTokens: NaN } }),
  });
  assert.deepEqual(result.usage, { modelCalls: 1, inputTokens: null, outputTokens: null });
});

test('page reads and saving never contact models; running model stays fixed and restart reflects the startup profile', async (t) => {
  let calls = 0;
  const view = await setup(t, {
    modelSetup: {
      list: async () => {
        calls++;
        return [];
      },
      generate: async () => {
        calls++;
        return ready();
      },
    },
  });
  let state = await view.state();
  assert.equal(state.modelSetup.available, true);
  assert.equal(state.restartRequired, false);
  assert.deepEqual(state.running.model, {
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'example-local',
  });
  for (const path of ['/', '/app.js', '/api/strings']) assert.equal((await fetch(`${view.url}${path}`)).status, 200);
  const save = async () => {
    const response = await fetch(`${view.url}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': state.revision },
      body: JSON.stringify(state.config),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  state.config.defaultProfile = 'work';
  state.config.profiles.work.model.model = 'new-work-model';
  assert.equal((await save()).restartRequired, false);
  state = await view.state();
  state.config.profiles.personal.model.ollama = { contextTokens: 8192, keepAliveSeconds: 0 };
  state.config.profiles.personal.model.model = 'new-personal-model';
  assert.equal((await save()).restartRequired, true);
  state = await view.state();
  assert.equal(state.restartRequired, true);
  assert.equal(state.running.model.model, 'example-local');
  assert.deepEqual(state.config.profiles.personal.model.ollama, { contextTokens: 8192, keepAliveSeconds: 0 });
  assert.equal(calls, 0);
});

test('saved listener settings require restart without changing the running memory selection', async (t) => {
  const view = await setup(t);
  const changed = structuredClone(view.config);
  changed.profiles.personal!.web = { port: 4880, farsightOrigin: 'http://127.0.0.1:4777' };
  await saveConfig(view.configPath, changed);
  assert.equal((await view.state()).restartRequired, true);
  await saveConfig(view.configPath, view.config);
  assert.equal((await view.state()).restartRequired, false);
});

test('setup actions select only trusted saved profiles and require matching revisions and strict body shape', async (t) => {
  let calls = 0;
  const view = await setup(t, {
    modelSetup: {
      generate: async (profile) => {
        calls++;
        assert.equal(profile.model.model, 'example-hosted');
        return ready();
      },
    },
  });
  const state = await view.state();
  const result = await view.post('test', state.revision, 'work');
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await result.json()).provider, 'openai-compatible');
  assert.equal(calls, 1);
  assert.equal((await view.post('test', 'stale', 'work')).status, 409);
  assert.equal((await view.post('test', state.revision, '__proto__')).status, 400);
  const send = (body: unknown, headers: Record<string, string> = {}, path = 'test') =>
    fetch(`${view.url}/api/model/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': state.revision, ...headers },
      body: JSON.stringify(body),
    });
  for (const input of [
    [],
    null,
    {},
    { profileId: 1 },
    { profileId: 'work', baseUrl: 'https://attacker.example' },
    { profileId: 'work', messages: [] },
  ])
    assert.equal((await send(input)).status, 400);
  assert.equal((await send({ profileId: 'work' }, {}, 'test?baseUrl=https://attacker.example')).status, 400);
  assert.equal((await send({ profileId: 'work' }, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await send({ profileId: 'work' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await send({ profileId: 'work' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await send({ profileId: 'x'.repeat(70_000) })).status, 413);
  assert.equal(
    (
      await fetch(`${view.url}/api/model/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"profileId":"work"}',
      })
    ).status,
    428,
  );
  assert.equal(calls, 1);
  await writeFile(view.configPath, JSON.stringify(state.config));
  assert.equal((await view.post('test', state.revision, 'work')).status, 503);
  assert.equal(calls, 1);
});

test('synthetic portal refuses model setup and hides its availability', async (t) => {
  let calls = 0;
  const view = await setup(t, {
    demo: true,
    modelSetup: {
      list: async () => {
        calls++;
        return [];
      },
      generate: async () => {
        calls++;
        return ready();
      },
    },
  });
  const state = await view.state();
  assert.equal(state.modelSetup.available, false);
  for (const action of ['models', 'test']) assert.equal((await view.post(action, state.revision)).status, 403);
  assert.equal(calls, 0);
});

test('in-flight setup results are rejected after any saved configuration revision changes', async (t) => {
  const entered = deferred(),
    release = deferred();
  const view = await setup(t, {
    modelSetup: {
      list: async () => {
        entered.resolve();
        await release.promise;
        return ['private-old-selection'];
      },
    },
  });
  const state = await view.state();
  const pending = view.post('models', state.revision);
  await entered.promise;
  const changed = structuredClone(view.config);
  changed.profiles.work!.hooks.claude = true;
  await saveConfig(view.configPath, changed);
  release.resolve();
  const result = await pending;
  assert.equal(result.status, 409);
  assert.doesNotMatch(await result.text(), /private-old-selection/);
});

test('cancelled tests keep the model lease until their underlying work settles and exclude portal research', async (t) => {
  const entered = deferred(),
    release = deferred(),
    cancelled = deferred();
  const view = await setup(t, {
    modelSetup: {
      generate: async (_profile, input) => {
        input.signal!.addEventListener('abort', () => cancelled.resolve(), { once: true });
        entered.resolve();
        await release.promise;
        return ready();
      },
    },
    portal: {
      browse: async () => {
        throw new Error('unused');
      },
      expand: async () => {
        throw new Error('unused');
      },
      ask: async () => {
        throw new Error('must not overlap');
      },
    },
  });
  const state = await view.state();
  const controller = new AbortController();
  const pending = view.post('test', state.revision, 'personal', controller.signal);
  const rejection = assert.rejects(pending, (error) => error instanceof Error && error.name === 'AbortError');
  await entered.promise;
  const busy = await view.post('test', state.revision);
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).code, 'busy');
  const research = await fetch(`${view.url}/api/memory/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'example' }),
  });
  assert.equal(research.status, 409);
  assert.equal((await research.json()).code, 'busy');
  controller.abort();
  await rejection;
  await cancelled.promise;
  assert.equal((await view.post('test', state.revision)).status, 409);
  release.resolve();
  // The failed request has already ended; a later turn observes the settled lease.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await view.post('test', state.revision)).status, 200);
});

test('model discovery cancels on disconnect and service close', async (t) => {
  for (const close of [false, true]) {
    const entered = deferred(),
      cancelled = deferred();
    const view = await setup(t, {
      modelSetup: {
        list: async (_profile, options) =>
          new Promise((_resolve, reject) => {
            options.signal!.addEventListener(
              'abort',
              () => {
                cancelled.resolve();
                reject(new Error('private-abort-reason'));
              },
              { once: true },
            );
            entered.resolve();
          }),
      },
    });
    const state = await view.state();
    const controller = new AbortController();
    const pending = view.post('models', state.revision, 'personal', controller.signal);
    const outcome = pending.then(
      (response) => response.text(),
      (error) => String(error.name),
    );
    await entered.promise;
    if (close) await view.close();
    else controller.abort();
    await cancelled.promise;
    assert.doesNotMatch(await outcome, /private-abort-reason/);
  }
});

test('model setup has a server deadline and exposes only safe failure codes', async (t) => {
  const config = fixture();
  config.profiles.personal!.budget.timeoutMs = 100;
  const cancelled = deferred();
  const view = await setup(
    t,
    {
      modelSetup: {
        generate: async (_profile, input) =>
          new Promise((_resolve, reject) => {
            input.signal!.addEventListener(
              'abort',
              () => {
                cancelled.resolve();
                reject(new Error('private-timeout-details'));
              },
              { once: true },
            );
          }),
      },
    },
    config,
  );
  const state = await view.state();
  const result = await view.post('test', state.revision);
  assert.equal(result.status, 504);
  const body = await result.text();
  assert.equal(JSON.parse(body).code, 'timeout');
  assert.doesNotMatch(body, /private-timeout-details/);
  await cancelled.promise;
  const failed = await setup(t, {
    modelSetup: {
      generate: async () => {
        throw new Error('private-provider-body');
      },
    },
  });
  const failure = await failed.post('test', (await failed.state()).revision);
  assert.equal(failure.status, 503);
  assert.equal((await failure.json()).code, 'failed');
});

test('actual adapter timeouts on a stalled synthetic endpoint retain the timeout status', async (t) => {
  const server = createServer((req) => {
    req.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const config = fixture();
  config.profiles.personal!.model.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  config.profiles.personal!.budget.timeoutMs = 100;
  const view = await setup(t, {}, config);
  const state = await view.state();
  for (const action of ['models', 'test']) {
    const result = await view.post(action, state.revision);
    assert.equal(result.status, 504);
    assert.equal((await result.json()).code, 'timeout');
  }
});
