import { createHash } from 'node:crypto';
import { readMemoryProvenance } from './memory-provenance.js';
import type { BackendConnection, EchoContext } from './types.js';
import type { ResearchCatalog, PortalMemory } from './portal-types.js';
import type { ResearchMemory, ResearchSearch } from './submind-types.js';

const RESPONSE_BYTES = 2_000_000;
const MAX_CANDIDATES = 100;
const MAX_EVIDENCE_CHARS = 256_000;
const REQUEST_TIMEOUT_MS = 10_000;
type FailureCode = 'input' | 'response' | 'unavailable' | 'timeout' | 'aborted' | 'oversized';

/** Internal machine codes only. Callers decide which catalog message to show. */
export class ResearchStoreFailure extends Error {
  constructor(readonly code: FailureCode) { super(code); this.name = 'ResearchStoreFailure'; }
}
function fail(code: FailureCode): never { throw new ResearchStoreFailure(code); }
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const idValid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(value);
const dateValid = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function bounded(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;
}
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) fail('aborted'); }

interface ScopedMemory { id: string; project: string; agentId: string; title: string; content: string; createdAt: string; concepts?: unknown }
function checkedMemory(value: unknown, expected: { project: string; agentId: string }): ScopedMemory {
  if (!object(value) || value.project !== expected.project || value.agentId !== expected.agentId
    || !idValid(value.id) || !dateValid(value.createdAt)
    || typeof value.title !== 'string' || value.title.length > 1_000_000 || value.title.includes('\0')
    || typeof value.content !== 'string' || !value.content.trim() || value.content.length > 1_000_000 || value.content.includes('\0')) fail('response');
  return value as unknown as ScopedMemory;
}

/** Matches memory.ts exactly: upstream supersession is project-scoped, so both fields are namespaced. */
function memoryScope(ctx: EchoContext): { project: string; agentId: string } {
  const identity = ctx.profile.identity;
  return {
    project: `echo:${hash(JSON.stringify([ctx.profileId, identity.individual, identity.team ?? null, identity.project]))}`,
    agentId: `echo:${hash(identity.individual)}`,
  };
}

/** This GET transport accepts only service-owned paths and never exposes credentials or backend error bodies. */
async function request(connection: Pick<BackendConnection, 'url' | 'secret'>, path: string, signal?: AbortSignal, missingAllowed = false, distinguishOversize = false): Promise<unknown> {
  checkAbort(signal);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetch(new URL(path, connection.url), {
      method: 'GET', headers: { accept: 'application/json', ...(connection.secret ? { authorization: `Bearer ${connection.secret}` } : {}) },
      signal: combined, redirect: 'error',
    });
    if (response.status === 404 && missingAllowed) { await response.body?.cancel(); return undefined; }
    if (!response.ok) { await response.body?.cancel(); fail('unavailable'); }
    if (!response.body) fail('response');
    const length = response.headers.get('content-length');
    if (length !== null && !/^\d+$/.test(length)) { await response.body.cancel(); fail('response'); }
    if (length !== null && Number(length) > RESPONSE_BYTES) {
      await response.body.cancel(); fail(distinguishOversize ? 'oversized' : 'response');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > RESPONSE_BYTES) { await reader.cancel(); fail(distinguishOversize ? 'oversized' : 'response'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    checkAbort(signal);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('response'); }
  } catch (error) {
    checkAbort(signal);
    if (timeout.aborted) fail('timeout');
    if (error instanceof ResearchStoreFailure) throw error;
    fail('unavailable');
  }
}

/** Large stored records can exceed the wire allowance before clipping. Shrink only that page,
 * preserving its exact cursor and selection. All attempts share one transport deadline. */
async function browsePage(connection: Pick<BackendConnection, 'url' | 'secret'>, query: URLSearchParams, signal?: AbortSignal): Promise<{ result: unknown; limit: number }> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    for (const limit of [50, 10, 1]) {
      checkAbort(combined);
      query.set('limit', String(limit));
      try { return { result: await request(connection, `/agentmemory/memories?${query}`, combined, false, true), limit }; }
      catch (error) {
        if (!(error instanceof ResearchStoreFailure) || error.code !== 'oversized' || limit === 1) throw error;
      }
    }
    fail('response');
  } catch (error) {
    checkAbort(signal);
    if (timeout.aborted) fail('timeout');
    throw error;
  }
}

async function evidence(ctx: EchoContext, memory: ScopedMemory, maxChars: number, signal?: AbortSignal): Promise<ResearchMemory> {
  checkAbort(signal);
  // Hash complete source fields before clipping. This is a content identity, not upstream history retention.
  const revision = hash(JSON.stringify([memory.id, memory.project, memory.agentId, memory.title, memory.content, memory.createdAt]));
  const title = memory.title.slice(0, Math.min(240, Math.floor(maxChars / 3)));
  const content = memory.content.slice(0, maxChars - title.length);
  const provenance = await readMemoryProvenance(ctx, memory.id, memory.content);
  checkAbort(signal);
  return {
    id: memory.id, revision, title, content, timestamp: memory.createdAt,
    ...(provenance ? { provenance } : {}), truncated: title.length < memory.title.length || content.length < memory.content.length,
  };
}

/** Read-only research over agentmemory 0.9.30. No models, engine startup, persistence, or backend mutation. */
export function createResearchStore(ctx: EchoContext, connection: BackendConnection): ResearchCatalog {
  const snapshot = structuredClone(ctx);
  const expected = memoryScope(snapshot);
  const backend = { url: connection.url, secret: connection.secret };
  return {
    async browse(input, signal) {
      if (!object(input) || typeof input.query !== 'string' || input.query.length > 4000 || input.query.includes('\0')
        || input.since !== null && !dateValid(input.since) || input.until !== null && !dateValid(input.until)
        || input.since !== null && input.until !== null && input.since > input.until
        || input.cursor !== undefined && (typeof input.cursor !== 'string' || !/^[a-zA-Z0-9_-]{1,4096}$/.test(input.cursor))) fail('input');
      checkAbort(signal);
      const query = new URLSearchParams({ ...expected, latest: 'true', limit: '50' });
      if (input.query) query.set('q', input.query);
      if (input.cursor) query.set('cursor', input.cursor);
      // Unqueried listing scopes before pagination. Search still ranks only 500 global candidates.
      // Never request facets: upstream computes them before exact identity scope filtering.
      const { result, limit } = await browsePage(backend, query, signal);
      if (!object(result) || !Array.isArray(result.memories) || result.memories.length > limit
        || result.nextCursor != null && (typeof result.nextCursor !== 'string' || !/^[a-zA-Z0-9_-]{1,4096}$/.test(result.nextCursor))
        || result.nextCursor != null && result.nextCursor === input.cursor) fail('response');
      const records = result.memories.map(value => checkedMemory(value, expected));
      if (new Set(records.map(memory => memory.id)).size !== records.length) fail('response');
      const eligible = records.filter(memory => (!input.since || memory.createdAt >= input.since) && (!input.until || memory.createdAt <= input.until));
      const memories: PortalMemory[] = [];
      let remaining = 64000;
      let truncated = false;
      for (let index = 0; index < eligible.length; index++) {
        const record = eligible[index]!;
        const allowance = Math.floor(remaining / (eligible.length - index));
        // Concepts are source data. Keep their text inside the page evidence allowance too.
        let topics: string[] | undefined;
        let topicsTruncated = false;
        let topicChars = 0;
        if (record.concepts !== undefined) {
          if (!Array.isArray(record.concepts) || record.concepts.some(value => typeof value !== 'string')) fail('response');
          const sourceTopics = [...new Set(record.concepts as string[])];
          topics = [];
          let topicAllowance = Math.min(256, Math.floor(allowance / 3));
          for (const sourceTopic of sourceTopics.slice(0, 20)) {
            if (sourceTopic.length > 120 || sourceTopic.length > topicAllowance) { topicsTruncated = true; continue; }
            if (sourceTopic) topics.push(sourceTopic);
            topicChars += sourceTopic.length;
            topicAllowance -= sourceTopic.length;
          }
          topicsTruncated ||= sourceTopics.length > 20;
        }
        const memory: PortalMemory = await evidence(snapshot, record, allowance - topicChars, signal);
        if (topics) memory.topics = topics;
        memory.truncated ||= topicsTruncated;
        remaining -= memory.title.length + memory.content.length + topicChars;
        truncated ||= memory.truncated;
        memories.push(memory);
      }
      const nextCursor = typeof result.nextCursor === 'string' ? result.nextCursor : null;
      // Pagination is not a snapshot: earlier pages can change while a caller browses.
      return { memories, nextCursor, exhaustive: false, truncated };
    },
    async search(input, signal): Promise<ResearchSearch> {
      if (!object(input) || typeof input.query !== 'string' || !input.query.trim() || input.query.length > 8000 || input.query.includes('\0')
        || !bounded(input.limit, MAX_CANDIDATES) || !bounded(input.maxChars, MAX_EVIDENCE_CHARS) || !dateValid(input.since)) fail('input');
      checkAbort(signal);
      const query = new URLSearchParams({ q: input.query, ...expected, latest: 'true', limit: String(input.limit) });
      // The pinned endpoint ranks at most 500 records globally, then intersects exact scope.
      // No cursor can recover scoped records omitted by that ranking. Do not call an empty page exhaustive.
      const result = await request(backend, `/agentmemory/memories?${query}`, signal);
      if (!object(result) || !Array.isArray(result.memories) || result.memories.length > input.limit
        || result.nextCursor !== undefined && result.nextCursor !== null && (typeof result.nextCursor !== 'string' || result.nextCursor.length > 4096)
        || result.total !== undefined && (typeof result.total !== 'number' || !Number.isSafeInteger(result.total) || result.total < result.memories.length)) fail('response');
      // Check all returned records, including those outside the chosen date window, before using any evidence.
      const records = result.memories.map(value => checkedMemory(value, expected));
      // This initial adapter dates records by createdAt (saved time), not by inferred event dates.
      const eligible = records.filter(memory => Date.parse(memory.createdAt) >= Date.parse(input.since));
      let remaining = input.maxChars;
      let truncated = result.nextCursor !== undefined && result.nextCursor !== null || typeof result.total === 'number' && result.total > records.length;
      const memories: ResearchMemory[] = [];
      for (let index = 0; index < eligible.length; index++) {
        checkAbort(signal);
        if (!remaining) { truncated = true; break; }
        const allowance = Math.max(1, Math.floor(remaining / (eligible.length - index)));
        const memory = await evidence(snapshot, eligible[index]!, allowance, signal);
        memories.push(memory);
        remaining -= memory.title.length + memory.content.length;
        truncated ||= memory.truncated;
      }
      return { memories, truncated, exhaustive: false, inspected: records.length };
    },
    async read(input, signal) {
      if (!object(input) || !idValid(input.id) || typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision)
        || !bounded(input.maxChars, MAX_EVIDENCE_CHARS)) fail('input');
      const result = await request(backend, `/agentmemory/memories/${encodeURIComponent(input.id)}`, signal, true);
      if (result === undefined) return { status: 'missing' };
      if (!object(result) || !object(result.memory)) fail('response');
      // Upstream's exact-id endpoint has no identity filtering. Foreign/moved records appear absent.
      if (result.memory.project !== expected.project || result.memory.agentId !== expected.agentId) return { status: 'missing' };
      const record = checkedMemory(result.memory, expected);
      if (record.id !== input.id) fail('response');
      const memory = await evidence(snapshot, record, input.maxChars, signal);
      return { status: memory.revision === input.revision ? 'ready' : 'changed', memory };
    },
  };
}
