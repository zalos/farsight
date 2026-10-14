import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defaultConfig } from '../dist/config.js';
import { generateSubmind, submindInputChars, listModels, summarize } from '../dist/models.js';
import type { EchoProfile } from '../dist/types.js';
import type { SubmindModelRequest } from '../dist/submind-types.js';

const input = (): SubmindModelRequest => ({
  messages: [{ role: 'system', content: 'Return a JSON finding with evidence.' }, { role: 'user', content: 'Saved reference material.' }],
  schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
});
const ollama = (extra: Record<string, unknown> = {}) => ({
  model: 'provider-reported-name', message: { content: '{"answer":"A supported fix"}', thinking: 'not returned' },
  done: true, done_reason: 'stop', prompt_eval_count: 41, eval_count: 12, ...extra,
});
const compatible = (extra: Record<string, unknown> = {}) => ({
  choices: [{ message: { content: '{"answer":"A supported fix"}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 45, completion_tokens: 14 }, ...extra,
});
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void, run: (profile: EchoProfile) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const profile = defaultConfig().profiles.personal!;
  profile.model.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  profile.model.model = 'configured-model';
  profile.submind!.mode = 'model';
  try { await run(profile); } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
async function body(req: IncomingMessage): Promise<any> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return JSON.parse(text);
}

test('sub-mind Ollama uses bounded schema JSON requests with usage and no hidden reasoning', async () => {
  const calls: any[] = [];
  await fixture((req, res) => {
    assert.equal(req.url, '/api/chat');
    assert.equal(req.headers.authorization, undefined);
    void body(req).then(value => { calls.push(value); res.end(JSON.stringify(ollama())); });
  }, async profile => {
    const result = await generateSubmind(profile, { ...input(), maxOutputTokens: 128 });
    assert.deepEqual(result, {
      content: { answer: 'A supported fix' }, model: 'configured-model', finishReason: 'stop',
      usage: { inputTokens: 41, outputTokens: 12 },
    });
    assert.equal(calls[0].options.num_predict, 128);
    assert.equal(calls[0].options.num_ctx, 4096);
    assert.equal(calls[0].keep_alive, 0);
    assert.deepEqual(calls[0].format, input().schema);
    assert.equal(calls[0].stream, false);
    assert.equal(calls[0].think, false);
    assert.deepEqual(calls[0].messages, input().messages);
  });
});

test('compatible sub-mind uses configured endpoint with JSON mode, schema instruction and usage', async () => {
  await fixture((req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    void body(req).then(value => {
      assert.deepEqual(value.response_format, { type: 'json_object' });
      assert.equal(value.max_tokens, 384);
      assert.equal(value.options, undefined);
      assert.equal(value.keep_alive, undefined);
      assert.equal(value.model, 'configured-model');
      assert.ok(value.messages[0].content.includes(JSON.stringify(input().schema)));
      assert.deepEqual(value.messages.slice(1), input().messages);
      res.end(JSON.stringify(compatible()));
    });
  }, async profile => {
    profile.model.provider = 'openai-compatible';
    profile.model.ollama = { contextTokens: 8192, keepAliveSeconds: 60 };
    const result = await generateSubmind(profile, input());
    assert.deepEqual(result.usage, { inputTokens: 45, outputTokens: 14 });
    assert.deepEqual(result.content, { answer: 'A supported fix' });
  });
});

test('unknown or invalid usage remains unknown instead of being presented as free', async () => {
  for (const provider of ['ollama', 'openai-compatible'] as const) {
    await fixture((_req, res) => res.end(JSON.stringify(provider === 'ollama'
      ? ollama({ prompt_eval_count: -1, eval_count: '42' })
      : compatible({ usage: { prompt_tokens: null, completion_tokens: 1.2 } }))), async profile => {
      profile.model.provider = provider;
      assert.deepEqual((await generateSubmind(profile, input())).usage, { inputTokens: null, outputTokens: null });
    });
  }
});

test('sub-mind rejects incomplete results, malformed JSON, nonobjects and refusal or tool content', async () => {
  for (const payload of [
    ollama({ done: false }), ollama({ done_reason: 'length' }), ollama({ done_reason: undefined }),
    ollama({ message: { content: '{"private-provider-value"' } }), ollama({ message: { content: 'null' } }),
    ollama({ message: { content: '[]' } }), ollama({ message: { content: '```json\n{}\n```' } }),
  ]) await fixture((_req, res) => res.end(JSON.stringify(payload)), async profile => {
    await assert.rejects(generateSubmind(profile, input()), error => error instanceof Error && !error.message.includes('private-provider-value'));
  });
  for (const choice of [
    { message: { content: '{}' }, finish_reason: 'length' },
    { message: { content: '{}' }, finish_reason: 'content_filter' },
    { message: { content: '{}' } },
    { message: { content: '{}', refusal: 'private-provider-value' }, finish_reason: 'stop' },
    { message: { content: '{}', tool_calls: [] }, finish_reason: 'stop' },
    { message: { content: '{' }, finish_reason: 'stop' },
  ]) await fixture((_req, res) => res.end(JSON.stringify(compatible({ choices: [choice] }))), async profile => {
    profile.model.provider = 'openai-compatible';
    await assert.rejects(generateSubmind(profile, input()), error => error instanceof Error && !error.message.includes('private-provider-value'));
  });
});

test('sub-mind input limits reject before request and cannot raise configured generation allowance', async () => {
  let calls = 0;
  await fixture((_req, res) => { calls++; res.end(JSON.stringify(ollama())); }, async profile => {
    for (const request of [
      { ...input(), messages: [] },
      { ...input(), messages: Array.from({ length: 65 }, () => ({ role: 'user', content: 'x' })) },
      { ...input(), messages: [{ role: 'user', content: 'x'.repeat(48_001) }] },
      { ...input(), maxOutputTokens: 385 }, { ...input(), maxOutputTokens: 0 },
      { ...input(), schema: { description: 'x'.repeat(32_769) } },
    ]) await assert.rejects(generateSubmind(profile, request as SubmindModelRequest), /configured limits/);
    assert.equal(calls, 0);
    profile.submind!.inputMaxChars = 1024;
    await assert.rejects(generateSubmind(profile, { ...input(), messages: [{ role: 'user', content: 'x'.repeat(1024) }] }), /configured limits/);
    profile.submind!.inputMaxChars = 256_000;
    await assert.rejects(generateSubmind(profile, { ...input(), messages: [{ role: 'user', content: '\u0000'.repeat(200_000) }] }), /configured limits/);
    assert.equal(calls, 0);
  });
});

test('direct model adapters enforce model transport without a configuration-loader bypass', async () => {
  const profile = defaultConfig().profiles.personal!;
  profile.model.model = 'selected';
  for (const model of [
    { ...profile.model, baseUrl: 'http://models.example.com' },
    { ...profile.model, baseUrl: 'http://192.168.1.25:11434' },
    { ...profile.model, baseUrl: 'http://8.8.8.8', allowInsecureHttp: true },
    { ...profile.model, baseUrl: 'http://192.168.1.25:11434', allowInsecureHttp: true, secretRef: 'keychain:farsight-echo/private-example' },
  ]) {
    profile.model = model;
    await assert.rejects(generateSubmind(profile, input()), /service address|encrypted model connection/);
    await assert.rejects(listModels(profile), /service address|encrypted model connection/);
    await assert.rejects(summarize(profile, 'material'), /service address|encrypted model connection/);
  }
});

test('sub-mind propagates cancellation before dispatch and during response reads without private reasons', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error('private-abort-reason'));
  await fixture((_req, res) => { calls++; res.end(JSON.stringify(ollama())); }, async profile => {
    await assert.rejects(generateSubmind(profile, { ...input(), signal: controller.signal }), error =>
      error instanceof Error && error.name === 'AbortError' && !error.message.includes('private-abort-reason'));
    assert.equal(calls, 0);
  });
  const running = new AbortController();
  await fixture((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{');
    setTimeout(() => running.abort(new Error('private-abort-reason')), 10);
  }, async profile => {
    const started = Date.now();
    await assert.rejects(generateSubmind(profile, { ...input(), signal: running.signal }), error =>
      error instanceof Error && error.name === 'AbortError' && !error.message.includes('private-abort-reason'));
    assert.ok(Date.now() - started < 2000);
  });
});

test('sub-mind deadline bounds header and body waits and provider failures never leak payloads', async () => {
  for (const stream of [false, true]) await fixture((_req, res) => {
    if (stream) { res.writeHead(200); res.write('{'); }
  }, async profile => {
    profile.submind!.timeoutMs = 100;
    const started = Date.now();
    await assert.rejects(generateSubmind(profile, input()), error => error instanceof Error && error.name === 'TimeoutError');
    assert.ok(Date.now() - started < 2000);
  });
  let calls = 0;
  await fixture((_req, res) => {
    calls++; res.writeHead(302, { Location: '/redirected' }); res.end('private-provider-value');
  }, async profile => {
    await assert.rejects(generateSubmind(profile, input()), /could not complete/);
    assert.equal(calls, 1);
  });
  await fixture((_req, res) => { res.writeHead(500); res.end('private-provider-value'); }, async profile => {
    await assert.rejects(generateSubmind(profile, input()), error => error instanceof Error && !error.message.includes('private-provider-value'));
  });
  await fixture((_req, res) => res.end(JSON.stringify(ollama({ message: { content: 'x'.repeat(1_100_000) } }))), async profile => {
    await assert.rejects(generateSubmind(profile, input()), /unusable response/);
  });
});


test('input measurement exactly matches serialized provider requests including schema and content escaping', async () => {
  for (const provider of ['ollama', 'openai-compatible'] as const) {
    const sample = input();
    sample.messages[1]!.content = 'A line\nwith "quotes", a tab\tand a slash\\.';
    sample.schema.description = 'Schema "quotes" and\nnewlines\\paths';
    let serialized = '';
    await fixture((req, res) => {
      req.setEncoding('utf8');
      req.on('data', chunk => { serialized += chunk; });
      req.on('end', () => res.end(JSON.stringify(provider === 'ollama' ? ollama() : compatible())));
    }, async profile => {
      profile.model.provider = provider;
      const measured = submindInputChars(profile, sample);
      await generateSubmind(profile, sample);
      assert.equal(measured, serialized.length);
      assert.ok(measured > JSON.stringify({ messages: sample.messages, schema: sample.schema }).length);
      if (provider === 'openai-compatible') {
        assert.ok(JSON.parse(serialized).messages[0].content.includes(JSON.stringify(sample.schema)));
      }
    });
  }
});

test('serialized input cap refuses escaped requests before dispatch and accepts the exact boundary', async () => {
  for (const provider of ['ollama', 'openai-compatible'] as const) {
    let calls = 0;
    await fixture((_req, res) => { calls++; res.end(JSON.stringify(provider === 'ollama' ? ollama() : compatible())); }, async profile => {
      profile.model.provider = provider;
      const sample = input();
      sample.messages[1]!.content = '\n'.repeat(1000);
      const measured = submindInputChars(profile, sample);
      profile.submind!.inputMaxChars = measured - 1;
      assert.equal(submindInputChars(profile, sample), measured, 'measurement remains available above the configured allowance');
      await assert.rejects(generateSubmind(profile, sample), /configured limits/);
      assert.equal(calls, 0);
      profile.submind!.inputMaxChars = measured;
      await generateSubmind(profile, sample);
      assert.equal(calls, 1);
    });
  }
});

test('input measurement needs neither a selected model nor a resolved credential', () => {
  const profile = defaultConfig().profiles.personal!;
  profile.model.baseUrl = 'https://models.example.com';
  profile.model.secretRef = 'keychain:farsight-echo/not-enrolled';
  assert.ok(submindInputChars(profile, input()) > 0);
  profile.model.provider = 'openai-compatible';
  assert.ok(submindInputChars(profile, input()) > 0);
});


test('native sub-mind requests honor resource limits and reject invalid values before dispatch', async () => {
  let calls = 0;
  await fixture((req, res) => {
    calls++;
    void body(req).then(value => {
      assert.equal(value.options.num_ctx, 16384);
      assert.equal(value.keep_alive, 300);
      res.end(JSON.stringify(ollama()));
    });
  }, async profile => {
    profile.model.ollama = { contextTokens: 16384, keepAliveSeconds: 300 };
    await generateSubmind(profile, input());
    assert.equal(calls, 1);
    profile.model.ollama.keepAliveSeconds = -1;
    await assert.rejects(generateSubmind(profile, input()));
    await assert.rejects(summarize(profile, 'source'));
    await assert.rejects(listModels(profile));
    assert.equal(calls, 1);
  });
});
