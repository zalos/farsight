import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { defaultConfig, loadContext, saveConfig, submindSettings } from '../dist/config.js';
import { createMemoryPortal, PortalFailure, validatePortalAsk, validatePortalBrowse, validatePortalExpand } from '../dist/portal.js';
import { startWeb } from '../dist/web.js';
import type { PortalCallbacks, ResearchCatalog, PortalBrowseResult } from '../dist/portal-types.js';
import type { EchoContext } from '../dist/types.js';
import type { SubmindResult } from '../dist/submind-types.js';

const connection = { url: 'http://127.0.0.1:1', secret: '', close: async () => {} };
const reference = { id: 'memory_1', revision: 'a'.repeat(64) };
const record = { ...reference, title: 'Shipping', content: 'Keep the container cold.', timestamp: '2026-10-01T00:00:00.000Z', truncated: false };
const unavailable = async (): Promise<never> => { throw new Error('Fixture operation unavailable'); };
const store = (browse: ResearchCatalog['browse']): ResearchCatalog => ({ browse, search: unavailable, read: unavailable });
const brief: SubmindResult = { schema: 'echo-memory/v1', requestId: 'fixture', status: 'empty', mode: 'mock', findings: [], actions: [], coverage: { exhaustive: false, since: '2026-01-01T00:00:00.000Z', inspected: 0, stopReason: 'no_matches', truncated: false }, usage: { modelCalls: 0, searches: 1, evidenceChars: 0, inputChars: 0, inputTokens: 0, outputTokens: 0, elapsedMs: 0 } };

async function context(t: TestContext): Promise<EchoContext> {
  const directory = await mkdtemp(join(tmpdir(), 'echo-portal-'));
  const configPath = join(directory, 'settings.json');
  const config = defaultConfig();
  const profile = config.profiles.personal!;
  profile.submind = { ...submindSettings(profile), mode: 'mock', timeoutMs: 100 };
  await saveConfig(configPath, config);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return loadContext(configPath, 'personal');
}
function callbacks(ctx: EchoContext): PortalCallbacks {
  return { ...createMemoryPortal(ctx, connection, store(async () => ({ memories: [record], nextCursor: null, exhaustive: true, truncated: false }))), expand: async () => ({ schema: 'echo-memory/v1', status: 'ready', memory: record, actions: [] }), ask: async () => brief };
}
async function web(t: TestContext, options: { portal?: PortalCallbacks; demo?: boolean } = {}, ctx?: EchoContext) {
  ctx ??= await context(t);
  ctx.profile.web.port = 0;
  const view = await startWeb(ctx, options);
  t.after(() => view.close());
  const post = (operation: string, body: unknown, headers = {}) => fetch(`${view.url}/api/memory/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { ...view, ctx, post };
}

test('portal validates body allowlists, exact dates and references before invoking a service', () => {
  assert.deepEqual(validatePortalBrowse({ query: ' cold ' }), { query: 'cold' });
  for (const value of [null, [], { profileId: 'other' }, { query: 1 }, { query: 'x'.repeat(4001) }, { query: 'a\0b' }, { since: '2026-10-01' }, { since: '2026-02-30T00:00:00.000Z' }, { until: null }, { since: '2026-10-02T00:00:00.000Z', until: '2026-10-01T00:00:00.000Z' }, { cursor: '' }]) assert.throws(() => validatePortalBrowse(value), PortalFailure);
  for (const value of [{ ...reference, scope: 'other' }, { id: '../secret', revision: reference.revision }, { id: reference.id, revision: 'old' }]) assert.throws(() => validatePortalExpand(value), PortalFailure);
  for (const value of [{ query: '' }, { query: '  ' }, { query: 'cold', model: 'override' }]) assert.throws(() => validatePortalAsk(value), PortalFailure);
});

test('portal signs opaque continuations to one startup profile and normalized query/date selection', async t => {
  const ctx = await context(t);
  const inputs: unknown[] = [];
  const catalog = store(async input => { inputs.push(input); return { memories: [], nextCursor: input.cursor ? null : 'upstream_cursor', exhaustive: false, truncated: false }; });
  const portal = createMemoryPortal(ctx, connection, catalog);
  const first = await portal.browse({ query: ' cold ' });
  assert.equal(first.schema, 'echo-portal/v1');
  assert.equal(first.counts.shown.n, 0);
  assert.equal(first.counts.shown.source, 'echo.portal.browse.memories');
  assert.equal(first.query, 'cold');
  assert.ok(first.nextCursor);
  assert.notEqual(first.nextCursor, 'upstream_cursor');
  await portal.browse({ query: 'cold', cursor: first.nextCursor });
  assert.deepEqual(inputs[1], { query: 'cold', since: null, until: null, cursor: 'upstream_cursor' });
  for (const input of [{ query: 'different', cursor: first.nextCursor }, { query: 'cold', since: '2026-10-01T00:00:00.000Z', cursor: first.nextCursor }, { query: 'cold', cursor: `${first.nextCursor}x` }, { cursor: 'upstream_cursor' }]) await assert.rejects(portal.browse(input), PortalFailure);
  const restarted = createMemoryPortal(ctx, connection, catalog);
  await assert.rejects(restarted.browse({ query: 'cold', cursor: first.nextCursor }), PortalFailure);
  assert.equal(inputs.length, 2);
});

test('maximum query and upstream continuation remain within the bounded browser cursor', async t => {
  const ctx = await context(t);
  const portal = createMemoryPortal(ctx, connection, store(async () => ({ memories: [], nextCursor: 'a'.repeat(4096), exhaustive: false, truncated: false })));
  const page = await portal.browse({ query: '界'.repeat(4000) });
  assert.ok(page.nextCursor!.length <= 8192);
});

test('memory APIs report availability and route browse, expand and explicit mock research without startup calls', async t => {
  const ctx = await context(t);
  let asks = 0;
  const portal = callbacks(ctx);
  portal.ask = async input => { asks++; assert.equal(input.query, 'cold'); return brief; };
  const view = await web(t, { portal }, ctx);
  const settings = await (await fetch(`${view.url}/api/settings`)).json();
  assert.deepEqual(settings.portal, { available: true, synthetic: false });
  assert.equal(settings.readOnly, false);
  assert.equal(asks, 0);
  const listing = await view.post('browse', {});
  assert.equal(listing.status, 200);
  assert.equal(listing.headers.get('cache-control'), 'no-store');
  const page = await listing.json() as PortalBrowseResult;
  assert.equal(page.memories[0]!.content, record.content);
  assert.equal(page.counts.shown.n, 1);
  assert.equal((await view.post('expand', reference)).status, 200);
  assert.equal(asks, 0);
  assert.deepEqual(await (await view.post('ask', { query: 'cold' })).json(), brief);
  assert.equal(asks, 1);
  const strings = await (await fetch(`${view.url}/api/strings`)).json();
  assert.ok(strings['echo.portal.memories']);
});

test('portal refuses absent services, extra fields, cross-origin requests and unsafe content types', async t => {
  const absent = await web(t);
  assert.equal((await absent.post('browse', {})).status, 503);
  assert.deepEqual((await (await fetch(`${absent.url}/api/settings`)).json()).portal, { available: false, synthetic: false });
  const ctx = await context(t);
  let calls = 0;
  const portal = callbacks(ctx);
  portal.ask = async () => { calls++; return brief; };
  const view = await web(t, { portal }, ctx);
  for (const operation of ['browse', 'ask', 'expand']) {
    assert.equal((await view.post(operation, { profileId: 'foreign' })).status, 400);
    assert.equal((await view.post(operation, {}, { Origin: 'http://attacker.example' })).status, 403);
    assert.equal((await view.post(operation, {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await view.post(operation, {}, { 'content-type': 'text/plain' })).status, 415);
  }
  assert.equal(calls, 0);
  assert.equal((await view.post('browse', { query: 'x'.repeat(70000) })).status, 413);
});

test('portal refuses trusted changes to selection before and during memory work and sanitizes service errors', async t => {
  const ctx = await context(t);
  const portal = callbacks(ctx);
  portal.browse = async () => { throw new Error('synthetic-private-value'); };
  const view = await web(t, { portal }, ctx);
  const failed = await view.post('browse', {});
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /synthetic-private-value/);
  portal.ask = async () => { const next = structuredClone(ctx.config); next.profiles.personal!.identity.project = 'changed-during-request'; await saveConfig(ctx.configPath, next); return brief; };
  const changed = await view.post('ask', { query: 'cold' });
  assert.equal(changed.status, 409);
  assert.doesNotMatch(await changed.text(), /findings|synthetic-private/);
  let calls = 0;
  portal.ask = async () => { calls++; return brief; };
  assert.equal((await view.post('ask', { query: 'cold' })).status, 409);
  assert.equal(calls, 0);
});

test('memory API deadlines abort mock work even when its promise ignores cancellation', async t => {
  const ctx = await context(t);
  let signal: AbortSignal | undefined;
  const portal = callbacks(ctx);
  portal.ask = async (_input, incoming) => { signal = incoming; return new Promise(() => {}); };
  const view = await web(t, { portal }, ctx);
  const response = await view.post('ask', { query: 'cold' });
  assert.equal(response.status, 504);
  assert.equal(signal?.aborted, true);
});

test('a disconnected browser aborts its pending mock research', async t => {
  const ctx = await context(t);
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  let aborted!: () => void;
  const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const portal = callbacks(ctx);
  portal.ask = async (_input, signal) => { signal!.addEventListener('abort', aborted, { once: true }); started(); return new Promise(() => {}); };
  const view = await web(t, { portal }, ctx);
  const req = request(`${view.url}/api/memory/ask`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  req.on('error', () => {});
  req.end(JSON.stringify({ query: 'cold' }));
  await waiting;
  req.destroy();
  await cancelled;
});

test('synthetic demo exposes read-only status and refuses settings writes', async t => {
  const ctx = await context(t);
  const view = await web(t, { portal: callbacks(ctx), demo: true }, ctx);
  const settings = await (await fetch(`${view.url}/api/settings`)).json();
  assert.equal(settings.readOnly, true);
  assert.deepEqual(settings.portal, { available: true, synthetic: true });
  const response = await fetch(`${view.url}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': settings.revision }, body: JSON.stringify(settings.config) });
  assert.equal(response.status, 403);
  assert.equal((await view.post('browse', {})).status, 200);
});
