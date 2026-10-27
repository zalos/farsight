import test from 'node:test';
import assert from 'node:assert/strict';
import { startPortalDemo } from '../dist/portal-demo.js';

test('synthetic portal browses, pages, researches and expands without any external request or writable settings', async () => {
  const previous = process.env.XDG_STATE_HOME;
  const originalFetch = globalThis.fetch;
  let origin = '';
  let requests = 0;
  globalThis.fetch = ((input: string | URL | Request, options?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input);
    assert.equal(new URL(target).origin, origin, 'the synthetic preview must not request any model or backend');
    requests++;
    return originalFetch(input, options);
  }) as typeof fetch;
  let demo: Awaited<ReturnType<typeof startPortalDemo>> | undefined;
  try {
    demo = await startPortalDemo(0);
    origin = demo.url;
    const post = async (path: string, body: object) => {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const state = await (await fetch(`${origin}/api/settings`)).json();
    assert.equal(state.readOnly, true);
    assert.equal(state.portal.synthetic, true);
    assert.equal(state.running.submindMode, 'mock');
    const first = await post('/api/memory/browse', {});
    assert.equal(first.memories.length, 3);
    assert.equal(first.counts.shown.n, 3);
    assert.ok(first.nextCursor);
    const second = await post('/api/memory/browse', { cursor: first.nextCursor });
    assert.equal(second.memories.length, 3);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.memories, ...second.memories].map((row) => row.id)).size, 6);
    const searched = await post('/api/memory/browse', { query: 'cold storage' });
    assert.equal(searched.memories[0].id, 'synthetic_cold');
    const empty = await post('/api/memory/browse', { since: '2099-01-01T00:00:00.000Z' });
    assert.equal(empty.memories.length, 0);
    assert.ok(empty.nextCursor);
    const brief = await post('/api/memory/ask', { query: 'cold storage' });
    assert.equal(brief.mode, 'mock');
    assert.equal(brief.usage.modelCalls, 0);
    assert.equal(brief.status, 'ready');
    const expanded = await post('/api/memory/expand', brief.actions[0].arguments);
    assert.equal(expanded.status, 'ready');
    assert.ok(expanded.memory.content.includes('blue insulated test container'));
    const saved = await fetch(`${origin}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': state.revision },
      body: JSON.stringify(state.config),
    });
    assert.equal(saved.status, 403);
    await assert.rejects(startPortalDemo(0));
    assert.equal(requests, 8);
  } finally {
    await demo?.close();
    globalThis.fetch = originalFetch;
  }
  assert.equal(process.env.XDG_STATE_HOME, previous);
});
