import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { defaultConfig, submindSettings } from '../dist/config.js';
import { research, expandMemory } from '../dist/submind.js';
import { submindInputChars } from '../dist/models.js';
import { submindDemo } from '../dist/submind-demo.js';
import type { ResearchMemory, ResearchStore, SubmindModelResponse } from '../dist/submind-types.js';

const item: ResearchMemory = {
  id: 'mem_fixture',
  revision: 'a'.repeat(64),
  title: 'Cold shipping',
  content:
    'Problem: Medicine needed cold storage. Fix: Use the blue insulated container. Why: The temperature stayed within the target.',
  timestamp: '2026-10-01T00:00:00.000Z',
  truncated: false,
};
const now = () => Date.parse('2026-10-13T00:00:00.000Z');
function profile(mode: 'off' | 'mock' | 'model') {
  const p = defaultConfig().profiles.personal!;
  p.submind = { ...submindSettings(p), mode };
  return p;
}
function fixture(records = [item]) {
  const searches: any[] = [],
    reads: any[] = [];
  const store: ResearchStore = {
    async search(input) {
      searches.push(input);
      return { memories: records, inspected: records.length, truncated: false, exhaustive: false };
    },
    async read(input) {
      reads.push(input);
      const memory = records.find((m) => m.id === input.id);
      return memory
        ? { status: memory.revision === input.revision ? 'ready' : 'changed', memory }
        : { status: 'missing' };
    },
  };
  return { store, searches, reads };
}
const answer = (citations = [{ id: item.id, revision: item.revision }]): SubmindModelResponse => ({
  content: {
    kind: 'answer',
    findings: [{ problem: 'Cold storage', fix: 'Use the blue container', why: null, citations }],
  },
  model: 'fixture',
  finishReason: 'stop',
  usage: { inputTokens: 120, outputTokens: 35 },
});

test('off performs no search or model request; mock researches with no model request', async () => {
  const f = fixture();
  let calls = 0;
  const generate = async () => {
    calls++;
    throw new Error('must never call');
  };
  const disabled = await research(profile('off'), f.store, { query: 'cold shipping' }, { generate, now });
  assert.equal(disabled.status, 'disabled');
  assert.equal(f.searches.length, 0);
  assert.equal(calls, 0);
  const mock = await research(profile('mock'), f.store, { query: 'cold shipping' }, { generate, now });
  assert.equal(mock.status, 'ready');
  assert.equal(mock.mode, 'mock');
  assert.equal(mock.usage.modelCalls, 0);
  assert.equal(calls, 0);
  assert.equal(mock.findings[0]?.fix, 'Use the blue insulated container.');
  assert.deepEqual(mock.actions[0]?.arguments, { id: item.id, revision: item.revision });
  assert.equal(mock.coverage.exhaustive, false);
  assert.equal(mock.findings[0]?.citations[0]?.timestamp, item.timestamp);
  assert.equal(mock.findings[0]?.citations[0]?.title, item.title);
  assert.equal(f.searches[0].since, '2026-07-15T00:00:00.000Z');
});

test('model can rephrase a search inside a fixed scope/window and return validated citations with usage', async () => {
  const f = fixture([]);
  let calls = 0;
  f.store.search = async (input) => {
    f.searches.push(input);
    return {
      memories: input.query === 'cold containers' ? [item] : [],
      inspected: input.query === 'cold containers' ? 1 : 0,
      truncated: false,
      exhaustive: false,
    };
  };
  const result = await research(
    profile('model'),
    f.store,
    { query: 'shipment' },
    {
      now,
      generate: async (_p, request) => {
        assert.ok(request.signal);
        assert.ok(request.schema);
        calls++;
        const branches = request.schema.anyOf as any[];
        assert.equal(branches.length, 2);
        const search = branches.find((branch) => branch.properties.kind.enum[0] === 'search');
        const answerBranch = branches.find((branch) => branch.properties.kind.enum[0] === 'answer');
        assert.deepEqual(search.required, ['kind', 'query']);
        assert.deepEqual(Object.keys(search.properties).sort(), ['kind', 'query']);
        assert.equal(search.additionalProperties, false);
        assert.deepEqual(answerBranch.required, ['kind', 'findings']);
        assert.deepEqual(Object.keys(answerBranch.properties).sort(), ['findings', 'kind']);
        assert.equal(answerBranch.additionalProperties, false);
        assert.ok(request.messages[0]!.content.includes('{"kind":"search","query":'));
        assert.ok(request.messages[0]!.content.includes('{"kind":"answer","findings":'));
        if (calls === 1) return { ...answer(), content: { kind: 'search', query: 'cold containers' } };
        assert.ok(request.messages[1]?.content.includes(item.revision));
        return answer();
      },
    },
  );
  assert.equal(result.status, 'ready');
  assert.equal(calls, 2);
  assert.equal(result.usage.searches, 2);
  assert.equal(result.usage.inputTokens, 240);
  assert.equal(result.usage.outputTokens, 70);
  assert.equal(f.searches[0].since, f.searches[1].since);
  assert.ok(result.usage.inputChars > result.usage.evidenceChars);
  assert.equal(JSON.stringify(result).includes('http'), false);
});

test('invented citations and model-supplied actions are refused without returning their contents', async () => {
  for (const content of [
    answer([{ id: 'foreign', revision: 'b'.repeat(64) }]).content,
    { kind: 'search', query: 'shipping', scope: 'another-user' },
    { kind: 'search', query: 'shipping', findings: [] },
    { kind: 'answer' },
    { kind: 'answer', query: 'shipping', findings: [] },
    { kind: 'answer', findings: [], command: 'PRIVATE_SENTINEL' },
  ]) {
    const result = await research(
      profile('model'),
      fixture().store,
      { query: 'shipping' },
      { now, generate: async () => ({ ...answer(), content }) },
    );
    assert.equal(result.status, 'unavailable');
    assert.equal(result.coverage.stopReason, 'invalid_response');
    assert.deepEqual(result.actions, []);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
  }
});

test('a repeated query switches to final synthesis without rerunning the lookup', async () => {
  const p = profile('model');
  const f = fixture();
  let calls = 0;
  const result = await research(
    p,
    f.store,
    { query: 'shipping' },
    {
      now,
      generate: async (_p, request) => {
        calls++;
        const context = JSON.parse(request.messages[1]!.content);
        if (calls === 1) {
          assert.equal(context.canSearch, true);
          assert.deepEqual(context.remaining, {
            modelCalls: 3,
            searches: 2,
            candidates: 11,
            evidenceChars: 12000 - item.title.length - item.content.length,
            inputChars: 48000,
          });
          return { ...answer(), content: { kind: 'search', query: ' SHIPPING ' } };
        }
        assert.equal(context.canSearch, false);
        assert.equal(context.remaining.modelCalls, 2);
        assert.equal(context.remaining.searches, 2);
        assert.ok(context.remaining.inputChars < 48000);
        assert.deepEqual(context.previousQueries, ['shipping']);
        assert.deepEqual(context.evidence, [item]);
        assert.equal(request.schema.anyOf, undefined);
        assert.deepEqual((request.schema.properties as any).kind.enum, ['answer']);
        assert.ok(request.messages[0]!.content.includes('This is the final synthesis.'));
        return answer();
      },
    },
  );
  assert.equal(result.status, 'ready');
  assert.equal(result.coverage.stopReason, 'complete');
  assert.equal(calls, 2);
  assert.equal(result.usage.modelCalls, 2);
  assert.equal(f.searches.length, 1);
  assert.deepEqual(result.actions[0]!.arguments, { id: item.id, revision: item.revision });
});

test('exhausted search, candidate or evidence allowances still permit a sourced final answer', async () => {
  for (const limit of ['searches', 'candidates', 'evidenceChars'] as const) {
    const p = profile('model');
    const f = fixture();
    if (limit === 'searches') p.submind!.maxSearches = 1;
    if (limit === 'candidates') p.submind!.maxCandidates = 1;
    if (limit === 'evidenceChars') p.submind!.evidenceMaxChars = item.title.length + item.content.length;
    const result = await research(
      p,
      f.store,
      { query: 'shipping' },
      {
        now,
        generate: async (_p, request) => {
          const context = JSON.parse(request.messages[1]!.content);
          assert.equal(context.canSearch, false);
          assert.equal(context.remaining[limit], 0);
          assert.deepEqual((request.schema.properties as any).kind.enum, ['answer']);
          return answer();
        },
      },
    );
    assert.equal(result.status, 'ready');
    assert.equal(result.usage.modelCalls, 1);
    assert.equal(f.searches.length, 1);
    assert.ok(result.usage.searches <= p.submind!.maxSearches);
    assert.ok(result.coverage.inspected <= p.submind!.maxCandidates);
    assert.ok(result.usage.evidenceChars <= p.submind!.evidenceMaxChars);
  }
});

test('the final allowed model call is reserved for an answer, including a one-call policy', async () => {
  for (const maxSteps of [1, 2]) {
    const p = profile('model');
    p.submind!.maxSteps = maxSteps;
    const f = fixture();
    let calls = 0;
    const result = await research(
      p,
      f.store,
      { query: 'shipping' },
      {
        now,
        generate: async (_p, request) => {
          calls++;
          const context = JSON.parse(request.messages[1]!.content);
          if (calls < maxSteps) {
            assert.equal(context.canSearch, true);
            return { ...answer(), content: { kind: 'search', query: 'containers' } };
          }
          assert.equal(context.canSearch, false);
          assert.equal(context.remaining.modelCalls, 1);
          assert.deepEqual((request.schema.properties as any).kind.enum, ['answer']);
          return answer();
        },
      },
    );
    assert.equal(result.status, 'ready');
    assert.equal(result.usage.modelCalls, maxSteps);
    assert.equal(f.searches.length, maxSteps);
  }
});

test('answer-only replies still reject extra searches and fabricated citations', async () => {
  for (const response of [
    { ...answer(), content: { kind: 'search', query: 'another query' } },
    answer([{ id: 'foreign', revision: 'b'.repeat(64) }]),
  ]) {
    const p = profile('model');
    p.submind!.maxSteps = 1;
    const f = fixture();
    const result = await research(p, f.store, { query: 'shipping' }, { now, generate: async () => response });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.coverage.stopReason, 'invalid_response');
    assert.equal(result.usage.modelCalls, 1);
    assert.equal(f.searches.length, 1);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.actions, []);
  }
  const p = profile('model');
  p.submind!.maxSearches = 1;
  const empty = await research(
    p,
    fixture([]).store,
    { query: 'shipping' },
    { now, generate: async () => ({ ...answer(), content: { kind: 'answer', findings: [] } }) },
  );
  assert.equal(empty.status, 'empty');
  assert.equal(empty.coverage.stopReason, 'no_matches');
});

test('final synthesis cannot exceed the cumulative model input allowance', async () => {
  const p = profile('model');
  let firstSize = 0;
  await research(
    p,
    fixture().store,
    { query: 'shipping' },
    {
      now,
      generate: async (selected, request) => {
        firstSize = submindInputChars(selected, request);
        return answer();
      },
    },
  );
  p.submind!.inputMaxChars = firstSize + 100;
  const f = fixture();
  let calls = 0;
  const result = await research(
    p,
    f.store,
    { query: 'shipping' },
    {
      now,
      generate: async () => {
        calls++;
        return { ...answer(), content: { kind: 'search', query: 'shipping' } };
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(f.searches.length, 1);
  assert.equal(result.status, 'partial');
  assert.equal(result.coverage.stopReason, 'budget');
  assert.ok(result.usage.inputChars <= p.submind!.inputMaxChars);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.actions, []);
  p.submind!.inputMaxChars = 1024;
  const limited = await research(
    p,
    fixture().store,
    { query: 'shipping' },
    {
      now,
      generate: async () => {
        throw new Error('not reached');
      },
    },
  );
  assert.equal(limited.usage.modelCalls, 0);
  assert.equal(limited.coverage.stopReason, 'budget');
});

test('final synthesis remains subject to the original research deadline', async () => {
  const p = profile('model');
  p.submind!.timeoutMs = 100;
  const f = fixture();
  let calls = 0;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const started = Date.now();
    const result = await research(
      p,
      f.store,
      { query: 'shipping' },
      {
        generate: async (_p, request) => {
          calls++;
          if (calls === 1) return { ...answer(), content: { kind: 'search', query: 'shipping' } };
          assert.equal(JSON.parse(request.messages[1]!.content).canSearch, false);
          return new Promise(() => {});
        },
      },
    );
    assert.equal(result.status, 'unavailable');
    assert.equal(result.coverage.stopReason, 'timeout');
    assert.equal(calls, 2);
    assert.equal(f.searches.length, 1);
    assert.ok(Date.now() - started < 900);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.actions, []);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('brief size includes full action and citation overhead; tiny limits omit whole findings', async () => {
  const p = profile('model');
  p.budget.briefMaxChars = 700;
  const verbose = answer();
  (verbose.content as any).findings[0].fix = 'Detailed evidence '.repeat(200);
  const result = await research(p, fixture().store, { query: 'shipping' }, { now, generate: async () => verbose });
  assert.equal(result.status, 'partial');
  assert.equal(result.actions.length, 1);
  assert.ok(JSON.stringify({ findings: result.findings, actions: result.actions }).length <= 700);
  p.budget.briefMaxChars = 128;
  const tiny = await research(p, fixture().store, { query: 'shipping' }, { now, generate: async () => answer() });
  assert.equal(tiny.status, 'partial');
  assert.deepEqual(tiny.findings, []);
  assert.deepEqual(tiny.actions, []);
});

test('unknown usage remains unknown, model failure differs from no match, and errors stay private', async () => {
  const p = profile('model');
  const result = await research(
    p,
    fixture().store,
    { query: 'shipping' },
    { now, generate: async () => ({ ...answer(), usage: { inputTokens: null, outputTokens: null } }) },
  );
  assert.equal(result.usage.inputTokens, null);
  assert.equal(result.usage.outputTokens, null);
  const failed = await research(
    p,
    fixture().store,
    { query: 'shipping' },
    {
      now,
      generate: async () => {
        throw new Error('PRIVATE_SENTINEL');
      },
    },
  );
  assert.equal(failed.coverage.stopReason, 'model_unavailable');
  assert.ok(!JSON.stringify(failed).includes('PRIVATE_SENTINEL'));
  const empty = await research(profile('mock'), fixture([]).store, { query: 'nothing' }, { now });
  assert.equal(empty.status, 'empty');
  assert.equal(empty.coverage.exhaustive, false);
});

test('aborted research never dispatches a model request and expansion never generates', async () => {
  const control = new AbortController();
  control.abort();
  let calls = 0;
  const result = await research(
    profile('model'),
    fixture().store,
    { query: 'shipping' },
    {
      signal: control.signal,
      generate: async () => {
        calls++;
        return answer();
      },
    },
  );
  assert.equal(result.coverage.stopReason, 'timeout');
  assert.equal(calls, 0);
  const f = fixture();
  const p = profile('off');
  const expanded = await expandMemory(p, f.store, { id: item.id, revision: item.revision });
  assert.equal(expanded.status, 'ready');
  assert.deepEqual(expanded.actions, []);
  assert.equal(expanded.memory?.content, item.content);
  assert.equal(f.searches.length, 0);
  assert.equal((await expandMemory(p, f.store, { id: item.id, revision: 'c'.repeat(64) })).status, 'changed');
  assert.equal((await expandMemory(p, f.store, { id: 'unknown', revision: item.revision })).status, 'missing');
  await assert.rejects(expandMemory(p, f.store, { id: '../foreign', revision: item.revision }));
});

test('synthetic demo works through the standalone CLI with no configuration or services', async () => {
  const demo = await submindDemo();
  assert.equal(demo.synthetic, true);
  assert.equal(demo.brief.mode, 'mock');
  assert.equal(demo.brief.usage.modelCalls, 0);
  assert.equal(demo.expanded?.status, 'ready');
  const run = promisify(execFile);
  const path = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const { stdout } = await run(process.execPath, [path, 'submind-demo'], {
    cwd: '/tmp',
    env: { ...process.env, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1' },
  });
  assert.equal(JSON.parse(stdout).brief.usage.modelCalls, 0);
  await assert.rejects(run(process.execPath, [path, 'submind-demo', '--config', '/not-used']));
});

test('a later failed generation makes cumulative provider usage unknown', async () => {
  let calls = 0;
  const result = await research(
    profile('model'),
    fixture().store,
    { query: 'shipping' },
    {
      now,
      generate: async () => {
        calls++;
        if (calls === 1) return { ...answer(), content: { kind: 'search', query: 'container' } };
        throw new Error('unreported provider failure');
      },
    },
  );
  assert.equal(result.usage.modelCalls, 2);
  assert.equal(result.usage.inputTokens, null);
  assert.equal(result.usage.outputTokens, null);
});

test('controller deadline holds even if a provider ignores cancellation', async () => {
  const p = profile('model');
  p.submind!.timeoutMs = 100;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const start = Date.now();
    const result = await research(
      p,
      fixture().store,
      { query: 'shipping' },
      { generate: async () => new Promise(() => {}) },
    );
    assert.equal(result.coverage.stopReason, 'timeout');
    assert.ok(Date.now() - start < 900);
  } finally {
    clearTimeout(keepAlive);
  }
});

for (const mode of ['mock', 'model'] as const) {
  test(`${mode} brief clipping keeps whole, nonempty code points or omits the finding`, async () => {
    const memory = { ...item, id: 'm', title: 'title', content: '😀 fix' };
    const p = profile(mode);
    const minimal = {
      problem: '😀',
      fix: '😀',
      why: null,
      citations: [{ id: memory.id, revision: memory.revision, title: memory.title, timestamp: memory.timestamp }],
    };
    const action = {
      rel: 'read_more',
      operation: 'memory.expand',
      arguments: { id: memory.id, revision: memory.revision },
    };
    const minimumBudget = JSON.stringify({ findings: [minimal], actions: [action] }).length;
    let calls = 0;
    const generate = async () => {
      calls++;
      assert.equal(mode, 'model');
      return {
        ...answer(),
        content: {
          kind: 'answer',
          findings: [
            {
              problem: '  😀 problem  ',
              fix: '  😀 fix  ',
              why: null,
              citations: [{ id: memory.id, revision: memory.revision }],
            },
          ],
        },
      };
    };
    for (const budget of [368, minimumBudget - 1, minimumBudget, 800]) {
      p.budget.briefMaxChars = budget;
      const result = await research(p, fixture([memory]).store, { query: '😀 problem' }, { now, generate });
      assert.ok(JSON.stringify({ findings: result.findings, actions: result.actions }).length <= budget);
      if (budget < minimumBudget) {
        assert.deepEqual(result.findings, []);
        assert.deepEqual(result.actions, []);
        assert.equal(result.coverage.stopReason, 'budget');
      } else {
        assert.equal(result.findings.length, 1);
        for (const field of [result.findings[0]!.problem, result.findings[0]!.fix]) {
          assert.ok(field.trim());
          assert.ok(field.startsWith('😀'));
          assert.ok(field.isWellFormed());
          assert.equal(field, field.trim());
        }
        if (budget === minimumBudget) assert.deepEqual(result.findings[0], minimal);
        if (budget === 800) assert.equal(result.findings[0]!.fix, '😀 fix');
      }
    }
    assert.equal(calls, mode === 'mock' ? 0 : 4);
  });
}

test('native research works with a provider that refuses large grammar repetitions', async (t) => {
  let calls = 0;
  const hasLargeRepetition = (value: unknown): boolean =>
    !!value &&
    typeof value === 'object' &&
    ((typeof (value as Record<string, unknown>).maxLength === 'number' &&
      Number((value as Record<string, unknown>).maxLength) >= 2000) ||
      Object.values(value).some(hasLargeRepetition));
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
    });
    req.on('end', () => {
      calls++;
      assert.equal(req.url, '/api/chat');
      const request = JSON.parse(text);
      // Reproduces the native grammar compiler failure seen before inference.
      if (hasLargeRepetition(request.format)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Failed to initialize samplers: failed to parse grammar' }));
        return;
      }
      res.end(
        JSON.stringify({
          done: true,
          done_reason: 'stop',
          message: { content: JSON.stringify(answer().content) },
          prompt_eval_count: 100,
          eval_count: 35,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const p = profile('model');
  p.model = {
    provider: 'ollama',
    model: 'synthetic-provider',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
  const result = await research(p, fixture().store, { query: 'cold shipping' }, { now });
  assert.equal(calls, 1);
  assert.equal(result.status, 'ready');
  assert.equal(result.findings[0]!.fix, 'Use the blue container');
  assert.deepEqual(result.actions[0]!.arguments, { id: item.id, revision: item.revision });
});

test('research rejects overlong fields and follow-up queries independently of provider grammar constraints', async () => {
  for (const field of ['problem', 'fix', 'why'] as const) {
    const response = answer();
    (response.content as any).findings[0][field] = 'x'.repeat(4001);
    const result = await research(
      profile('model'),
      fixture().store,
      { query: 'cold shipping' },
      { now, generate: async () => response },
    );
    assert.equal(result.status, 'unavailable');
    assert.equal(result.coverage.stopReason, 'invalid_response');
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.actions, []);
  }
  const f = fixture();
  const result = await research(
    profile('model'),
    f.store,
    { query: 'cold shipping' },
    { now, generate: async () => ({ ...answer(), content: { kind: 'search', query: 'x'.repeat(4001) } }) },
  );
  assert.equal(result.coverage.stopReason, 'invalid_response');
  assert.equal(f.searches.length, 1);
});
