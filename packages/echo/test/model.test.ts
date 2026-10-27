import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defaultConfig } from '../dist/config.js';
import { listModels, summarize } from '../dist/models.js';
import type { EchoProfile } from '../dist/types.js';

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (profile: EchoProfile) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const profile = defaultConfig().profiles.personal!;
  profile.model.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  profile.model.model = 'existing-local-model';
  try {
    await run(profile);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('Ollama discovery lists installed models without downloading or inheriting credentials', async () => {
  const requests: string[] = [];
  await fixture(
    (request, response) => {
      requests.push(request.url!);
      assert.equal(request.headers.authorization, undefined);
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({ models: [{ name: 'zeta:latest' }, { name: 'alpha:latest' }, { name: 'alpha:latest' }] }),
      );
    },
    async (profile) => {
      assert.deepEqual(await listModels(profile), ['alpha:latest', 'zeta:latest']);
    },
  );
  assert.deepEqual(requests, ['/api/tags']);
});

test('summary calls are stateless with bounded input, generation and final output', async () => {
  const calls: any[] = [];
  await fixture(
    (request, response) => {
      assert.equal(request.url, '/api/chat');
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        calls.push(JSON.parse(raw));
        response.end(
          JSON.stringify({
            message: { content: JSON.stringify({ summary: 'x'.repeat(5000) }), thinking: 'not part of the brief' },
            done: true,
            done_reason: 'stop',
          }),
        );
      });
    },
    async (profile) => {
      profile.budget.briefMaxChars = 150;
      profile.budget.modelMaxTokens = 100;
      assert.equal((await summarize(profile, 'a'.repeat(50_000))).length, 150);
      assert.equal((await summarize(profile, 'second request')).length, 150);
    },
  );
  assert.equal(calls[0].messages[1].content.length, 24_000);
  assert.equal(calls[0].think, false);
  assert.equal(calls[0].stream, false);
  assert.equal(calls[0].options.num_predict, 100);
  assert.equal(calls[0].options.num_ctx, 4096);
  assert.equal(calls[0].keep_alive, 0);
  assert.deepEqual(calls[0].format.required, ['summary']);
  assert.equal(calls[0].format.additionalProperties, false);
  assert.equal(calls[1].messages.length, 2);
  assert.equal(calls[1].messages[1].content, 'second request');
});

test('OpenAI-compatible summaries use the configured origin and model with no hidden fallback', async () => {
  await fixture(
    (request, response) => {
      assert.equal(request.url, '/v1/chat/completions');
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        const body = JSON.parse(raw);
        assert.equal(body.model, 'explicit-model');
        assert.equal(body.max_tokens, 384);
        assert.equal(body.options, undefined);
        assert.equal(body.keep_alive, undefined);
        assert.equal(request.headers.authorization, undefined);
        response.end(JSON.stringify({ choices: [{ message: { content: 'A brief.' } }] }));
      });
    },
    async (profile) => {
      profile.model.provider = 'openai-compatible';
      profile.model.model = 'explicit-model';
      profile.model.ollama = { contextTokens: 8192, keepAliveSeconds: 120 };
      assert.equal(await summarize(profile, 'source text'), 'A brief.');
      await assert.rejects(listModels(profile), /available for Ollama/);
    },
  );
});

test('model requests time out and mask remote failures and oversized responses', async () => {
  await fixture(
    () => {},
    async (profile) => {
      profile.budget.timeoutMs = 100;
      const started = Date.now();
      await assert.rejects(summarize(profile, 'bounded wait'), /could not complete/);
      assert.ok(Date.now() - started < 2000);
    },
  );
  await fixture(
    (_request, response) => {
      response.writeHead(500);
      response.end('private-provider-value');
    },
    async (profile) => {
      await assert.rejects(
        summarize(profile, 'source'),
        (error) => error instanceof Error && !error.message.includes('private-provider-value'),
      );
    },
  );
  await fixture(
    (_request, response) => response.end(JSON.stringify({ message: { content: 'x'.repeat(1_100_000) } })),
    async (profile) => {
      await assert.rejects(summarize(profile, 'source'), /unusable response/);
    },
  );
});

test('missing selection, redirects and malformed model output are refused', async () => {
  let calls = 0;
  await fixture(
    (_request, response) => {
      calls++;
      response.writeHead(302, { Location: '/redirected' });
      response.end();
    },
    async (profile) => {
      profile.model.model = '';
      await assert.rejects(summarize(profile, 'source'), /Choose an installed model/);
      assert.equal(calls, 0);
      profile.model.model = 'explicit';
      await assert.rejects(summarize(profile, 'source'), /could not complete/);
      assert.equal(calls, 1);
    },
  );
  await fixture(
    (_request, response) => response.end('{"message":{"content":null}}'),
    async (profile) => {
      await assert.rejects(summarize(profile, 'source'), /unusable response/);
    },
  );
});

test('only structured Ollama summary text is returned; reasoning, extra fields and incomplete generations are refused', async () => {
  await fixture(
    (_request, response) =>
      response.end(
        JSON.stringify({
          message: {
            content: JSON.stringify({ summary: 'The shipment arrived on time.' }),
            thinking: 'hidden reasoning',
          },
          done: true,
          done_reason: 'stop',
        }),
      ),
    async (profile) => {
      assert.equal(await summarize(profile, 'The shipment arrived on time.'), 'The shipment arrived on time.');
    },
  );
  for (const payload of [
    { message: { content: 'First I need to think about this request.' }, done: true },
    { message: { content: JSON.stringify({ summary: 'A brief.', reasoning: 'extra content' }) }, done: true },
    { message: { content: JSON.stringify({ summary: 'A brief.' }) }, done: true, done_reason: 'length' },
    { message: { content: JSON.stringify({ summary: 'A brief.' }) }, done: false },
  ])
    await fixture(
      (_request, response) => response.end(JSON.stringify(payload)),
      async (profile) => {
        await assert.rejects(summarize(profile, 'source'));
      },
    );
  await fixture(
    (_request, response) =>
      response.end(
        JSON.stringify({
          choices: [{ message: { content: 'A cut-off brief' }, finish_reason: 'length' }],
        }),
      ),
    async (profile) => {
      profile.model.provider = 'openai-compatible';
      await assert.rejects(summarize(profile, 'source'), /stopped before completing/);
    },
  );
});

test('native Ollama summaries honor explicit resource settings', async () => {
  await fixture(
    (request, response) => {
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        const body = JSON.parse(raw);
        assert.equal(body.options.num_ctx, 8192);
        assert.equal(body.keep_alive, 120);
        response.end(
          JSON.stringify({ message: { content: '{"summary":"A bounded brief."}' }, done: true, done_reason: 'stop' }),
        );
      });
    },
    async (profile) => {
      profile.model.ollama = { contextTokens: 8192, keepAliveSeconds: 120 };
      assert.equal(await summarize(profile, 'source text'), 'A bounded brief.');
    },
  );
});

test('model discovery supports cancellation before dispatch and while waiting for headers or body', async () => {
  const secretReason = 'private-discovery-abort';
  const isCancelled = (error: unknown) =>
    error instanceof Error && error.name === 'AbortError' && !error.message.includes(secretReason);
  let calls = 0;
  await fixture(
    (_request, response) => {
      calls++;
      response.end('{"models":[]}');
    },
    async (profile) => {
      const controller = new AbortController();
      controller.abort(new Error(secretReason));
      await assert.rejects(listModels(profile, { signal: controller.signal }), isCancelled);
      assert.equal(calls, 0);
    },
  );
  for (const stream of [false, true]) {
    const controller = new AbortController();
    await fixture(
      (_request, response) => {
        if (stream) {
          response.writeHead(200);
          response.write('{');
        }
        setTimeout(() => controller.abort(new Error(secretReason)), 10);
      },
      async (profile) => {
        const started = Date.now();
        await assert.rejects(listModels(profile, { signal: controller.signal }), isCancelled);
        assert.ok(Date.now() - started < 2000);
      },
    );
  }
});

test('large summary allowances avoid unsupported grammar repetitions and still clip complete code points', async () => {
  await fixture(
    (request, response) => {
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        const body = JSON.parse(raw);
        assert.equal(body.options.num_predict, 1024);
        if (body.format.properties.summary.maxLength >= 2000) {
          response.writeHead(400);
          response.end(JSON.stringify({ error: 'Failed to initialize samplers: failed to parse grammar' }));
          return;
        }
        response.end(
          JSON.stringify({
            message: { content: JSON.stringify({ summary: 'x'.repeat(4095) + '😀 trailing text' }) },
            done: true,
            done_reason: 'stop',
          }),
        );
      });
    },
    async (profile) => {
      profile.budget.briefMaxChars = 4096;
      profile.budget.modelMaxTokens = 1024;
      const summary = await summarize(profile, 'Synthetic source text.');
      assert.equal(summary, 'x'.repeat(4095));
      assert.equal(summary.isWellFormed(), true);
    },
  );
});
