import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { defaultConfig, submindSettings } from '../dist/config.js';
import { research, expandMemory } from '../dist/submind.js';
import { submindDemo } from '../dist/submind-demo.js';
import type { ResearchMemory, ResearchStore, SubmindModelResponse } from '../dist/submind-types.js';

const item: ResearchMemory = { id: 'mem_fixture', revision: 'a'.repeat(64), title: 'Cold shipping', content: 'Problem: Medicine needed cold storage. Fix: Use the blue insulated container. Why: The temperature stayed within the target.', timestamp: '2026-10-01T00:00:00.000Z', truncated: false };
const now = () => Date.parse('2026-10-13T00:00:00.000Z');
function profile(mode: 'off' | 'mock' | 'model') {
  const p = defaultConfig().profiles.personal!;
  p.submind = { ...submindSettings(p), mode };
  return p;
}
function fixture(records = [item]) {
  const searches: any[] = [], reads: any[] = [];
  const store: ResearchStore = {
    async search(input) { searches.push(input); return { memories: records, inspected: records.length, truncated: false, exhaustive: false }; },
    async read(input) { reads.push(input); const memory = records.find(m => m.id === input.id); return memory ? { status: memory.revision === input.revision ? 'ready' : 'changed', memory } : { status: 'missing' }; },
  };
  return { store, searches, reads };
}
const answer = (citations = [{ id: item.id, revision: item.revision }]): SubmindModelResponse => ({
  content: { kind: 'answer', findings: [{ problem: 'Cold storage', fix: 'Use the blue container', why: null, citations }] },
  model: 'fixture', finishReason: 'stop', usage: { inputTokens: 120, outputTokens: 35 },
});

test('off performs no search or model request; mock researches with no model request', async () => {
  const f = fixture();
  let calls = 0;
  const generate = async () => { calls++; throw new Error('must never call'); };
  const disabled = await research(profile('off'), f.store, { query: 'cold shipping' }, { generate, now });
  assert.equal(disabled.status, 'disabled'); assert.equal(f.searches.length, 0); assert.equal(calls, 0);
  const mock = await research(profile('mock'), f.store, { query: 'cold shipping' }, { generate, now });
  assert.equal(mock.status, 'ready'); assert.equal(mock.mode, 'mock'); assert.equal(mock.usage.modelCalls, 0); assert.equal(calls, 0);
  assert.equal(mock.findings[0]?.fix, 'Use the blue insulated container.');
  assert.deepEqual(mock.actions[0]?.arguments, { id: item.id, revision: item.revision });
  assert.equal(mock.coverage.exhaustive, false);
  assert.equal(mock.findings[0]?.citations[0]?.timestamp, item.timestamp);
  assert.equal(mock.findings[0]?.citations[0]?.title, item.title);
  assert.equal(f.searches[0].since, '2026-07-15T00:00:00.000Z');
});

test('model can rephrase a search inside a fixed scope/window and return validated citations with usage', async () => {
  const f = fixture([]); let calls = 0;
  f.store.search = async input => {
    f.searches.push(input);
    return { memories: input.query === 'cold containers' ? [item] : [], inspected: input.query === 'cold containers' ? 1 : 0, truncated: false, exhaustive: false };
  };
  const result = await research(profile('model'), f.store, { query: 'shipment' }, { now, generate: async (_p, request) => {
    assert.ok(request.signal); assert.ok(request.schema); calls++;
    if (calls === 1) return { ...answer(), content: { kind: 'search', query: 'cold containers' } };
    assert.ok(request.messages[1]?.content.includes(item.revision)); return answer();
  } });
  assert.equal(result.status, 'ready'); assert.equal(calls, 2); assert.equal(result.usage.searches, 2);
  assert.equal(result.usage.inputTokens, 240); assert.equal(result.usage.outputTokens, 70);
  assert.equal(f.searches[0].since, f.searches[1].since);
  assert.ok(result.usage.inputChars > result.usage.evidenceChars);
  assert.equal(JSON.stringify(result).includes('http'), false);
});

test('invented citations and model-supplied actions are refused without returning their contents', async () => {
  for (const content of [
    answer([{ id: 'foreign', revision: 'b'.repeat(64) }]).content,
    { kind: 'search', query: 'shipping', scope: 'another-user' },
    { kind: 'answer', findings: [], command: 'PRIVATE_SENTINEL' },
  ]) {
    const result = await research(profile('model'), fixture().store, { query: 'shipping' }, { now, generate: async () => ({ ...answer(), content }) });
    assert.equal(result.status, 'unavailable'); assert.equal(result.coverage.stopReason, 'invalid_response');
    assert.deepEqual(result.actions, []); assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
  }
});

test('repeated searches, step limits and total input budgets stop independently of the model', async () => {
  const p = profile('model'); const f = fixture();
  let calls = 0;
  const repeat = await research(p, f.store, { query: 'shipping' }, { now, generate: async () => { calls++; return { ...answer(), content: { kind: 'search', query: 'shipping' } }; } });
  assert.equal(repeat.coverage.stopReason, 'budget'); assert.equal(repeat.status, 'partial'); assert.equal(calls, 1); assert.equal(f.searches.length, 1);
  p.submind!.inputMaxChars = 1024;
  const limited = await research(p, f.store, { query: 'shipping' }, { now, generate: async () => { throw new Error('not reached'); } });
  assert.equal(limited.usage.modelCalls, 0); assert.equal(limited.coverage.stopReason, 'budget');
  p.submind!.inputMaxChars = 48000; p.submind!.maxSteps = 1;
  const step = await research(p, fixture().store, { query: 'shipping' }, { now, generate: async () => ({ ...answer(), content: { kind: 'search', query: 'another query' } }) });
  assert.equal(step.usage.modelCalls, 1); assert.equal(step.usage.searches, 1); assert.equal(step.coverage.stopReason, 'budget');
});

test('brief size includes full action and citation overhead; tiny limits omit whole findings', async () => {
  const p = profile('model'); p.budget.briefMaxChars = 700;
  const verbose = answer(); (verbose.content as any).findings[0].fix = 'Detailed evidence '.repeat(200);
  const result = await research(p, fixture().store, { query: 'shipping' }, { now, generate: async () => verbose });
  assert.equal(result.status, 'partial'); assert.equal(result.actions.length, 1);
  assert.ok(JSON.stringify({ findings: result.findings, actions: result.actions }).length <= 700);
  p.budget.briefMaxChars = 128;
  const tiny = await research(p, fixture().store, { query: 'shipping' }, { now, generate: async () => answer() });
  assert.equal(tiny.status, 'partial'); assert.deepEqual(tiny.findings, []); assert.deepEqual(tiny.actions, []);
});

test('unknown usage remains unknown, model failure differs from no match, and errors stay private', async () => {
  const p = profile('model');
  const result = await research(p, fixture().store, { query: 'shipping' }, { now, generate: async () => ({ ...answer(), usage: { inputTokens: null, outputTokens: null } }) });
  assert.equal(result.usage.inputTokens, null); assert.equal(result.usage.outputTokens, null);
  const failed = await research(p, fixture().store, { query: 'shipping' }, { now, generate: async () => { throw new Error('PRIVATE_SENTINEL'); } });
  assert.equal(failed.coverage.stopReason, 'model_unavailable'); assert.ok(!JSON.stringify(failed).includes('PRIVATE_SENTINEL'));
  const empty = await research(profile('mock'), fixture([]).store, { query: 'nothing' }, { now });
  assert.equal(empty.status, 'empty'); assert.equal(empty.coverage.exhaustive, false);
});

test('aborted research never dispatches a model request and expansion never generates', async () => {
  const control = new AbortController(); control.abort(); let calls = 0;
  const result = await research(profile('model'), fixture().store, { query: 'shipping' }, { signal: control.signal, generate: async () => { calls++; return answer(); } });
  assert.equal(result.coverage.stopReason, 'timeout'); assert.equal(calls, 0);
  const f = fixture(); const p = profile('off');
  const expanded = await expandMemory(p, f.store, { id: item.id, revision: item.revision });
  assert.equal(expanded.status, 'ready'); assert.deepEqual(expanded.actions, []); assert.equal(expanded.memory?.content, item.content); assert.equal(f.searches.length, 0);
  assert.equal((await expandMemory(p, f.store, { id: item.id, revision: 'c'.repeat(64) })).status, 'changed');
  assert.equal((await expandMemory(p, f.store, { id: 'unknown', revision: item.revision })).status, 'missing');
  await assert.rejects(expandMemory(p, f.store, { id: '../foreign', revision: item.revision }));
});

test('synthetic demo works through the standalone CLI with no configuration or services', async () => {
  const demo = await submindDemo();
  assert.equal(demo.synthetic, true); assert.equal(demo.brief.mode, 'mock'); assert.equal(demo.brief.usage.modelCalls, 0);
  assert.equal(demo.expanded?.status, 'ready');
  const run = promisify(execFile);
  const path = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const { stdout } = await run(process.execPath, [path, 'submind-demo'], { cwd: '/tmp', env: { ...process.env, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1' } });
  assert.equal(JSON.parse(stdout).brief.usage.modelCalls, 0);
  await assert.rejects(run(process.execPath, [path, 'submind-demo', '--config', '/not-used']));
});


test('a later failed generation makes cumulative provider usage unknown', async () => {
  let calls = 0;
  const result = await research(profile('model'), fixture().store, { query: 'shipping' }, { now, generate: async () => {
    calls++;
    if (calls === 1) return { ...answer(), content: { kind: 'search', query: 'container' } };
    throw new Error('unreported provider failure');
  } });
  assert.equal(result.usage.modelCalls, 2); assert.equal(result.usage.inputTokens, null); assert.equal(result.usage.outputTokens, null);
});

test('controller deadline holds even if a provider ignores cancellation', async () => {
  const p = profile('model'); p.submind!.timeoutMs = 100;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const start = Date.now();
    const result = await research(p, fixture().store, { query: 'shipping' }, { generate: async () => new Promise(() => {}) });
    assert.equal(result.coverage.stopReason, 'timeout'); assert.ok(Date.now() - start < 900);
  } finally { clearTimeout(keepAlive); }
});
