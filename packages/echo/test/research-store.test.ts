import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../dist/config.js';
import { createResearchStore, ResearchStoreFailure } from '../dist/research-store.js';
import { saveMemoryProvenance } from '../dist/memory-provenance.js';
import type { BackendConnection, EchoContext } from '../dist/types.js';
import type { ResearchCatalog } from '../dist/portal-types.js';

type Row = { id: string; createdAt: string; title: string; content: string; project: string; agentId: string };
type State = {
  rows: Row[]; requests: URL[]; extra?: Record<string, unknown>;
  handle?: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;
};
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const SINCE = '2026-01-01T00:00:00.000Z';
const search = { query: 'shipping', limit: 5, maxChars: 4000, since: SINCE };
const revision = '0'.repeat(64);
const code = (expected: string) => (error: unknown): boolean => error instanceof ResearchStoreFailure && error.code === expected && error.message === expected;

async function fixture(fn: (store: ResearchCatalog, ctx: EchoContext, state: State, connection: BackendConnection) => Promise<void>) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'echo-research-test-'));
  const config = defaultConfig();
  const ctx: EchoContext = { config, configPath: join(directory, 'settings.json'), profileId: 'personal', profile: config.profiles.personal!, directory, dataDirectory: join(directory, 'data') };
  const identity = ctx.profile.identity;
  const state: State = { rows: [{
    id: 'mem_fixture_1', createdAt: '2026-09-01T00:00:00.000Z', title: 'Shipping', content: 'Use an insulated container.',
    project: `echo:${hash(JSON.stringify([ctx.profileId, identity.individual, identity.team ?? null, identity.project]))}`,
    agentId: `echo:${hash(identity.individual)}`,
  }], requests: [] };
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer synthetic-secret');
    assert.equal(req.method, 'GET');
    const url = new URL(req.url!, 'http://fixture');
    state.requests.push(url);
    if (state.handle?.(req, res, url)) return;
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/agentmemory/memories') {
      res.end(JSON.stringify({ memories: state.rows, total: state.rows.length, nextCursor: null, ...state.extra }));
    } else {
      const row = state.rows.find(row => `/agentmemory/memories/${encodeURIComponent(row.id)}` === url.pathname);
      res.statusCode = row ? 200 : 404;
      res.end(JSON.stringify(row ? { memory: row } : { error: 'missing' }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const connection: BackendConnection = { url: `http://127.0.0.1:${address.port}`, secret: 'synthetic-secret', close: async () => {} };
  try { await fn(createResearchStore(ctx, connection), ctx, state, connection); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
}

test('research searches exact identity and reads content-bound evidence beyond the brief budget', async () => {
  await fixture(async (store, ctx, state) => {
    state.rows[0]!.content = 'synthetic reference '.repeat(100);
    ctx.profile.budget.briefMaxChars = 128;
    const original = state.rows[0]!;
    const result = await store.search(search);
    assert.equal(state.requests[0]!.pathname, '/agentmemory/memories');
    assert.deepEqual(Object.fromEntries(state.requests[0]!.searchParams), { q: search.query, project: original.project, agentId: original.agentId, latest: 'true', limit: '5' });
    assert.equal(result.exhaustive, false);
    assert.equal(result.inspected, 1);
    assert.equal(result.truncated, false);
    const memory = result.memories[0]!;
    assert.equal(memory.content, original.content);
    assert.match(memory.revision, /^[a-f0-9]{64}$/);
    assert.equal(memory.provenance, undefined);
    assert.equal(memory.timestamp, original.createdAt);
    const read = await store.read({ id: memory.id, revision: memory.revision, maxChars: 20 });
    assert.equal(read.status, 'ready');
    assert.equal(read.memory!.revision, memory.revision);
    assert.equal(read.memory!.truncated, true);
    assert.ok(read.memory!.title.length + read.memory!.content.length <= 20);
    assert.equal(state.requests[1]!.pathname, `/agentmemory/memories/${original.id}`);
  });
});

test('scope is snapshotted and foreign or orphaned search records fail closed even outside the date window', async () => {
  await fixture(async (store, ctx, state) => {
    ctx.profile.identity.individual = 'changed-after-start';
    assert.equal((await store.search(search)).memories.length, 1);
    const original = { ...state.rows[0]! };
    for (const patch of [{ project: 'foreign' }, { agentId: 'foreign' }, { agentId: undefined }]) {
      state.rows = [{ ...original, ...patch, createdAt: '2000-01-01T00:00:00.000Z' } as Row];
      await assert.rejects(store.search(search), code('response'));
      assert.deepEqual(await store.read({ id: original.id, revision, maxChars: 1000 }), { status: 'missing' });
    }
  });
});

test('a saved-content revision changes with title, content, or timestamp and never inherits unrelated provenance', async () => {
  await fixture(async (store, ctx, state) => {
    const original = { ...state.rows[0]! };
    await saveMemoryProvenance(ctx, original.id, original.content, { workspace: '/example/workspace', commit: 'a'.repeat(40) });
    const saved = (await store.search(search)).memories[0]!;
    assert.equal(saved.provenance!.workspace, '/example/workspace');
    assert.equal(saved.provenance!.commit, 'a'.repeat(40));
    for (const patch of [{ title: 'Corrected title' }, { content: 'Corrected evidence' }, { createdAt: '2026-09-02T00:00:00.000Z' }]) {
      state.rows[0] = { ...original, ...patch };
      const changed = await store.read({ id: saved.id, revision: saved.revision, maxChars: 4000 });
      assert.equal(changed.status, 'changed');
      assert.notEqual(changed.memory!.revision, saved.revision);
      if ('content' in patch) assert.equal(changed.memory!.provenance, undefined);
    }
    state.rows[0] = original;
    assert.equal((await store.read({ id: saved.id, revision: saved.revision, maxChars: 4000 })).status, 'ready');
    state.rows = [];
    assert.deepEqual(await store.read({ id: saved.id, revision: saved.revision, maxChars: 4000 }), { status: 'missing' });
  });
});

test('lookback is fixed to backend saved time and counts inspected rows rather than matches', async () => {
  await fixture(async (store, _ctx, state) => {
    const row = state.rows[0]!;
    state.rows = [
      { ...row, id: 'old', createdAt: '2025-12-31T23:59:59.999Z' },
      { ...row, id: 'boundary', createdAt: SINCE },
      { ...row, id: 'recent' },
    ];
    const result = await store.search(search);
    assert.deepEqual(result.memories.map(memory => memory.id), ['boundary', 'recent']);
    assert.equal(result.inspected, 3);
    assert.equal(result.truncated, false);
    assert.equal(result.exhaustive, false);
    const empty = await store.search({ ...search, since: '2027-01-01T00:00:00.000Z' });
    assert.deepEqual(empty.memories, []);
    assert.equal(empty.inspected, 3);
    assert.equal(empty.exhaustive, false);
  });
});

test('one bounded search page reports upstream omissions and never promises exhaustive absence', async () => {
  await fixture(async (store, _ctx, state) => {
    state.extra = { total: 500, nextCursor: 'opaque-offset' };
    const page = await store.search({ ...search, limit: 1 });
    assert.equal(page.inspected, 1);
    assert.equal(page.truncated, true);
    assert.equal(page.exhaustive, false);
    assert.equal(state.requests.length, 1);
    state.rows = [];
    state.extra = undefined;
    assert.deepEqual(await store.search(search), { memories: [], inspected: 0, truncated: false, exhaustive: false });
  });
});

test('evidence limits bound combined title and content and report skipped candidates', async () => {
  await fixture(async (store, _ctx, state) => {
    const row = state.rows[0]!;
    state.rows = [row, { ...row, id: 'second' }, { ...row, id: 'third' }];
    const tiny = await store.search({ ...search, maxChars: 1 });
    assert.equal(tiny.inspected, 3);
    assert.equal(tiny.memories.length, 1);
    assert.equal(tiny.memories[0]!.title.length + tiny.memories[0]!.content.length, 1);
    assert.equal(tiny.truncated, true);
    const fair = await store.search({ ...search, maxChars: 30 });
    assert.equal(fair.memories.length, 3);
    assert.ok(fair.memories.every(memory => memory.truncated));
    assert.ok(fair.memories.reduce((sum, memory) => sum + memory.title.length + memory.content.length, 0) <= 30);
  });
});

test('invalid queries, budgets, dates, and traversal-shaped IDs are rejected before network access', async () => {
  await fixture(async (store, _ctx, state) => {
    for (const patch of [
      { query: '' }, { query: 'x'.repeat(8001) }, { query: 'a\0b' }, { limit: 0 }, { limit: 101 }, { limit: 1.5 },
      { maxChars: 0 }, { maxChars: 256001 }, { maxChars: NaN }, { since: 'yesterday' }, { since: '2026-02-30T00:00:00.000Z' },
    ]) await assert.rejects(store.search({ ...search, ...patch }), code('input'));
    for (const id of ['', '../other', '%2e%2e', '/foreign', 'id?query', 'id#fragment', 'a/b', 'a\\b', 'x'.repeat(257)]) {
      await assert.rejects(store.read({ id, revision, maxChars: 1000 }), code('input'));
    }
    await assert.rejects(store.read({ id: 'valid', revision: '../other', maxChars: 1000 }), code('input'));
    await assert.rejects(store.read({ id: 'valid', revision, maxChars: Infinity }), code('input'));
    assert.equal(state.requests.length, 0);
  });
});

test('malformed and substituted backend records are refused rather than becoming citations', async () => {
  await fixture(async (store, _ctx, state) => {
    const original = state.rows[0]!;
    for (const patch of [{ id: '../other' }, { content: '' }, { title: null }, { createdAt: '2026-02-30T00:00:00.000Z' }]) {
      state.rows[0] = { ...original, ...patch } as Row;
      await assert.rejects(store.search(search), code('response'));
    }
    state.rows[0] = original;
    state.extra = { nextCursor: 1 };
    await assert.rejects(store.search(search), code('response'));
    state.extra = { total: -1 };
    await assert.rejects(store.search(search), code('response'));
    state.extra = { memories: [original, original] };
    await assert.rejects(store.search({ ...search, limit: 1 }), code('response'));
    state.handle = (_req, res) => { res.end(JSON.stringify({ memory: { ...original, id: 'substituted' } })); return true; };
    await assert.rejects(store.read({ id: original.id, revision, maxChars: 1000 }), code('response'));
  });
});

test('response limits apply to declared and chunked bodies and malformed/error bodies remain private', async () => {
  await fixture(async (store, _ctx, state) => {
    state.handle = (_req, res) => { res.writeHead(200, { 'content-length': '2000001' }); res.end(); return true; };
    await assert.rejects(store.search(search), code('response'));
    state.handle = (_req, res) => { res.writeHead(200, { 'transfer-encoding': 'chunked' }); res.write(' '.repeat(1_000_000)); res.end(' '.repeat(1_000_001)); return true; };
    await assert.rejects(store.search(search), code('response'));
    state.handle = (_req, res) => { res.end('synthetic-secret malformed body'); return true; };
    await assert.rejects(store.search(search), code('response'));
    state.handle = (_req, res) => { res.writeHead(500); res.end('synthetic-secret failure body'); return true; };
    await assert.rejects(store.search(search), code('unavailable'));
  });
});

test('redirects never forward backend credentials to another endpoint', async () => {
  let forwarded = false;
  const target = createServer((_req, res) => { forwarded = true; res.end('{}'); });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const address = target.address(); assert.ok(address && typeof address !== 'string');
  try {
    await fixture(async (store, _ctx, state) => {
      state.handle = (_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${address.port}/capture` }); res.end(); return true; };
      await assert.rejects(store.search(search), code('unavailable'));
      assert.equal(forwarded, false);
    });
  } finally { target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve())); }
});

test('caller cancellation stops pending requests and response streaming; pre-cancelled work never sends', async () => {
  await fixture(async (store, _ctx, state) => {
    await assert.rejects(store.search(search, AbortSignal.abort()), code('aborted'));
    assert.equal(state.requests.length, 0);
    const waiting = new AbortController();
    state.handle = () => { waiting.abort(); return true; };
    await assert.rejects(store.search(search, waiting.signal), code('aborted'));
    const streaming = new AbortController();
    state.handle = (_req, res) => { res.writeHead(200); res.write('{"memories":['); setTimeout(() => streaming.abort(), 10); return true; };
    await assert.rejects(store.read({ id: 'mem_fixture_1', revision, maxChars: 1000 }, streaming.signal), code('aborted'));
  });
});

test('a backend that stops sending its body is stopped by the adapter deadline', { timeout: 15_000 }, async () => {
  await fixture(async (store, _ctx, state) => {
    state.handle = (_req, res) => { res.writeHead(200); res.write('{"memories":['); return true; };
    await assert.rejects(store.search(search), code('timeout'));
  });
});


test('portal listing applies scope before pagination, preserves cursors across empty date pages, and omits upstream totals', async () => {
  await fixture(async (store, _ctx, state) => {
    const cursor = Buffer.from(JSON.stringify({ key: '2026-09-01', id: 'mem_fixture_1' })).toString('base64url');
    state.extra = { nextCursor: cursor, total: 9000, facets: { project: ['foreign'] } };
    const first = await store.browse({ query: '', since: '2026-10-01T00:00:00.000Z', until: null });
    assert.deepEqual(first, { memories: [], nextCursor: cursor, exhaustive: false, truncated: false });
    assert.equal(state.requests[0]!.searchParams.get('q'), null);
    assert.equal(state.requests[0]!.searchParams.get('facets'), null);
    assert.equal(state.requests[0]!.searchParams.get('latest'), 'true');
    assert.equal(state.requests[0]!.searchParams.get('limit'), '50');
    assert.equal(state.requests[0]!.searchParams.get('project'), state.rows[0]!.project);
    assert.equal(state.requests[0]!.searchParams.get('agentId'), state.rows[0]!.agentId);
    state.extra = { nextCursor: null };
    const last = await store.browse({ query: '', since: null, until: null, cursor });
    assert.equal(last.memories.length, 1);
    assert.equal(last.exhaustive, false);
    assert.equal(state.requests[1]!.searchParams.get('cursor'), cursor);
    assert.equal('total' in last, false);
    assert.equal('facets' in last, false);
    const searched = await store.browse({ query: 'shipping', since: null, until: null });
    assert.equal(searched.exhaustive, false);
    assert.equal(state.requests[2]!.searchParams.get('q'), 'shipping');
  });
});

test('portal pages recheck every row scope, including dates filtered out, and refuse malformed continuations', async () => {
  await fixture(async (store, _ctx, state) => {
    const original = { ...state.rows[0]! };
    state.rows = [{ ...original, project: 'foreign', createdAt: '2000-01-01T00:00:00.000Z' }];
    await assert.rejects(store.browse({ query: '', since: SINCE, until: null }), code('response'));
    state.rows = [original, original];
    await assert.rejects(store.browse({ query: '', since: null, until: null }), code('response'));
    state.rows = [original];
    for (const nextCursor of [42, '', 'bad/path', 'x'.repeat(4097)]) {
      state.extra = { nextCursor };
      await assert.rejects(store.browse({ query: '', since: null, until: null }), code('response'));
    }
    state.extra = { nextCursor: 'repeat' };
    await assert.rejects(store.browse({ query: '', since: null, until: null, cursor: 'repeat' }), code('response'));
  });
});

test('portal evidence and genuine concept labels stay bounded independently of huge source records', async () => {
  await fixture(async (store, _ctx, state) => {
    const original = state.rows[0]!;
    state.rows = Array.from({ length: 20 }, (_, index) => ({ ...original, id: `mem_${index}`, content: 'x'.repeat(20000), concepts: ['cold shipping', 'cold shipping', 'a'.repeat(1000), 'b'.repeat(1000)] }));
    const result = await store.browse({ query: '', since: null, until: null });
    assert.equal(result.memories.length, 20);
    assert.equal(result.truncated, true);
    assert.ok(result.memories.every(memory => memory.topics?.[0] === 'cold shipping'));
    assert.ok(result.memories.reduce((n, memory) => n + memory.title.length + memory.content.length + (memory.topics ?? []).join('').length, 0) <= 64000);
    state.rows = [{ ...original, createdAt: SINCE }];
    assert.equal((await store.browse({ query: '', since: SINCE, until: SINCE })).memories.length, 1);
  });
});

test('portal invalid input and cancellation fail before any backend request', async () => {
  await fixture(async (store, _ctx, state) => {
    const valid = { query: '', since: null, until: null };
    for (const patch of [{ query: 'a'.repeat(4001) }, { since: 'yesterday' }, { until: '2026-02-30T00:00:00.000Z' }, { cursor: '../other' }, { since: '2026-02-01T00:00:00.000Z', until: SINCE }]) {
      await assert.rejects(store.browse({ ...valid, ...patch }), code('input'));
    }
    await assert.rejects(store.browse(valid, AbortSignal.abort()), code('aborted'));
    assert.equal(state.requests.length, 0);
  });
});
