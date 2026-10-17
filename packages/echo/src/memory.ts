import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { echoMemoryWord } from '@farsight/core/dist/strings-echo-memory.js';
import { containsCredentialShape } from '@farsight/core/dist/credential-shapes.js';
import { loadContext, submindSettings } from './config.js';
import { createResearchStore } from './research-store.js';
import { generateSubmind } from './models.js';
import { ModelBusyError, withModelOperation } from './model-gate.js';
import { createHookResearchRegistry, validateHookResearchInput, type HookBriefInput, type HookBriefResult, type HookPrepareInput, type HookWaitInput } from './hook-research.js';
import { research, expandMemory, validateResearchQuery, validateExpansion, type SubmindGenerator } from './submind.js';
import type { SubmindModelResponse, SubmindResult, ExpandResult, ResearchStore } from './submind-types.js';
import { backendRequest } from './runtime.js';
import { contextFingerprint } from './sessions.js';
import type { BackendConnection, EchoContext } from './types.js';
import { captureMemoryOrigin, readMemoryProvenance, saveMemoryProvenance, validProvenance, verifyMemoryOrigin, type MemoryOrigin, type MemoryProvenance } from './memory-provenance.js';

export interface RememberInput { content: string; topics?: string[] }
export interface RecallInput { query: string; limit?: number }
export interface RememberResult { id: string; createdAt: string }
export interface RecalledMemory { id: string; title: string; content: string; timestamp: string; provenance?: MemoryProvenance }
export interface RecallResult { memories: RecalledMemory[]; truncated: boolean }
export interface MemoryRequestOptions { timeoutMs?: number; signal?: AbortSignal }
type Operation = 'remember' | 'recall' | 'ask' | 'expand' | 'prepare' | 'brief' | 'cancel-brief';
type BridgeInput = RememberInput | RecallInput | { id: string; revision: string } | HookPrepareInput | HookWaitInput;
type BridgeResult = RememberResult | RecallResult | SubmindResult | ExpandResult | HookBriefResult;
type FailureCode = 'unavailable' | 'input' | 'credential' | 'stale' | 'ownership' | 'running' | 'response' | 'timeout' | 'externalReadOnly' | 'busy' | 'aborted';
const REQUEST_BYTES = 160_000;
// A 64k-character expansion can require six JSON bytes per character.
const RESPONSE_BYTES = 524_288;
const codes = new Set<FailureCode>(['unavailable', 'input', 'credential', 'stale', 'ownership', 'running', 'response', 'timeout', 'externalReadOnly', 'busy', 'aborted']);
class MemoryFailure extends Error {
  constructor(readonly code: FailureCode) { super(echoMemoryWord(code)); }
}
function fail(code: FailureCode): never { throw new MemoryFailure(code); }
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0');
const keys = (value: Record<string, unknown>, allowed: string[]): boolean => Object.keys(value).every(key => allowed.includes(key));

/** Short fixed-root paths fit macOS's Unix socket limit even in a deeply nested workspace. */
export function memorySocketPath(ctx: EchoContext): string {
  if (!process.getuid) fail('ownership');
  return join('/tmp', `farsight-echo-${process.getuid()}`, `${hash(`${ctx.configPath}\0${ctx.profileId}`).slice(0, 40)}.sock`);
}

async function checkDirectory(ctx: EchoContext, create = false): Promise<string> {
  const path = memorySocketPath(ctx);
  const directory = path.slice(0, path.lastIndexOf('/'));
  if (create) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') fail('ownership'); }
  }
  let stat;
  try { stat = await lstat(directory); } catch { fail(create ? 'ownership' : 'unavailable'); }
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700) fail('ownership');
  return path;
}

async function socketStat(path: string) {
  const stat = await lstat(path);
  if (!stat.isSocket() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600) fail('ownership');
  return stat;
}

async function recoverStaleSocket(path: string): Promise<void> {
  let before;
  try { before = await socketStat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const stale = await new Promise<boolean>(resolve => {
    const socket = createConnection(path);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 300);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(false); });
    socket.once('error', error => { clearTimeout(timer); socket.destroy(); resolve((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'); });
  });
  if (!stale) fail('running');
  const after = await socketStat(path);
  if (before.ino !== after.ino || before.dev !== after.dev) fail('ownership');
  await unlink(path);
}

function inputFor(operation: Operation, input: unknown): BridgeInput {
  if (!object(input)) fail('input');
  if (operation === 'prepare' || operation === 'brief' || operation === 'cancel-brief') {
    try {
      if (operation === 'prepare') return validateHookResearchInput(operation, input);
      if (operation === 'brief') return validateHookResearchInput(operation, input);
      return validateHookResearchInput(operation, input);
    } catch { fail('input'); }
  }
  if (operation === 'ask') {
    if (!keys(input, ['query'])) fail('input');
    try { return { query: validateResearchQuery(input.query) }; } catch { fail('input'); }
  }
  if (operation === 'expand') {
    try { return validateExpansion(input); } catch { fail('input'); }
  }
  if (operation === 'remember') {
    if (!keys(input, ['content', 'topics']) || !text(input.content, 24_000)) fail('input');
    if (input.topics !== undefined && (!Array.isArray(input.topics) || input.topics.length > 20 || input.topics.some(topic => !text(topic, 80)))) fail('input');
    if (containsCredentialShape(input.content) || (input.topics as string[] | undefined)?.some(containsCredentialShape)) fail('credential');
    return { content: input.content, ...(input.topics === undefined ? {} : { topics: input.topics as string[] }) };
  }
  if (operation !== 'recall' || !keys(input, ['query', 'limit']) || !text(input.query, 8_000)) fail('input');
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 5)) fail('input');
  return { query: input.query, limit: input.limit === undefined ? 5 : Number(input.limit) };
}

function timeout(value: unknown, maximum = 30_000): number {
  if (value === undefined) return 10_000;
  if (!Number.isSafeInteger(value) || Number(value) < 50 || Number(value) > maximum) fail('input');
  return Number(value);
}

// agentmemory 0.9.30 truncates agentId at 128 chars and scopes supersession by
// project rather than agentId. Namespacing both fields preserves full identities
// and prevents one Echo profile from superseding another profile's memories.
function scope(ctx: EchoContext): { project: string; agentId: string } {
  const identity = ctx.profile.identity;
  return {
    project: `echo:${hash(JSON.stringify([ctx.profileId, identity.individual, identity.team ?? null, identity.project]))}`,
    agentId: `echo:${hash(identity.individual)}`,
  };
}

function checkedMemory(value: unknown, expected: { project: string; agentId: string }): Record<string, unknown> {
  if (!object(value) || !text(value.id, 256) || !text(value.createdAt, 64)
    || !text(value.content, 1_000_000) || typeof value.title !== 'string'
    || value.project !== expected.project || value.agentId !== expected.agentId) fail('response');
  return value;
}

async function execute(ctx: EchoContext, connection: BackendConnection, operation: Operation, input: RememberInput | RecallInput, timeoutMs: number, origin?: MemoryOrigin): Promise<RememberResult | RecallResult> {
  const expected = scope(ctx);
  if (operation === 'remember') {
    if (ctx.profile.backend.mode !== 'managed') fail('externalReadOnly');
    if (!origin) fail('input');
    const remember = input as RememberInput;
    const result = await backendRequest(connection, '/agentmemory/remember', {
      content: remember.content, concepts: remember.topics ?? [], type: 'fact', ...expected,
    }, timeoutMs);
    if (!object(result) || result.success !== true) fail('response');
    const memory = checkedMemory(result.memory, expected);
    if (memory.content !== remember.content) fail('response');
    await saveMemoryProvenance(ctx, memory.id as string, remember.content, origin);
    return { id: memory.id as string, createdAt: memory.createdAt as string };
  }
  const recall = input as RecallInput;
  // This published endpoint ranks by q and applies exact project + agent filters.
  // /search's observation conversion omits project and admits orphaned rows.
  const query = new URLSearchParams({ q: recall.query, ...expected, latest: 'true', limit: String(recall.limit ?? 5) });
  const result = await backendRequest(connection, `/agentmemory/memories?${query}`, undefined, timeoutMs);
  if (!object(result) || !Array.isArray(result.memories) || result.memories.length > (recall.limit ?? 5)) fail('response');
  let remaining = ctx.profile.budget.briefMaxChars;
  let truncated = result.nextCursor !== null && result.nextCursor !== undefined;
  const memories: RecalledMemory[] = [];
  const records = result.memories.map(memory => checkedMemory(memory, expected));
  for (let index = 0; index < records.length; index++) {
    const memory = records[index]!;
    if (remaining <= 0) { truncated = true; break; }
    const allowance = Math.floor(remaining / (records.length - index));
    const rawTitle = memory.title as string;
    const rawContent = memory.content as string;
    const title = rawTitle.slice(0, Math.min(120, Math.floor(allowance / 3)));
    const content = rawContent.slice(0, Math.max(0, allowance - title.length));
    remaining -= title.length + content.length;
    truncated ||= title.length < rawTitle.length || content.length < rawContent.length;
    const provenance = await readMemoryProvenance(ctx, memory.id as string, rawContent);
    memories.push({ id: memory.id as string, title, content, timestamp: memory.createdAt as string, ...(provenance ? { provenance } : {}) });
  }
  return { memories, truncated };
}

/** A filesystem-private bridge; backend credentials stay in the owning process. */
export async function startMemoryBridge(ctx: EchoContext, connection: BackendConnection, dependencies: { store?: ResearchStore; generate?: SubmindGenerator } = {}): Promise<{ close(): Promise<void> }> {
  const snapshot = structuredClone(ctx);
  const fingerprint = contextFingerprint(snapshot);
  const store = dependencies.store ?? createResearchStore(snapshot, connection);
  let researching = false;
  const runResearch = async (query: string, signal: AbortSignal): Promise<SubmindResult> => {
    if (submindSettings(snapshot.profile).mode !== 'model') return research(snapshot.profile, store, { query }, { signal, generate: dependencies.generate });
    return withModelOperation(async () => {
      let generation: Promise<SubmindModelResponse> | undefined;
      try {
        return await research(snapshot.profile, store, { query }, {
          signal,
          generate: (profile, request) => {
            generation = Promise.resolve().then(() => (dependencies.generate ?? generateSubmind)(profile, request));
            return generation;
          },
        });
      } finally {
        // Cancellation can finish research before its adapter stops; retain model ownership.
        await generation?.catch(() => {});
      }
    });
  };
  const background = createHookResearchRegistry(snapshot, { research: runResearch });
  const path = await checkDirectory(snapshot, true);
  await recoverStaleSocket(path);
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    if (sockets.size >= 32) { socket.destroy(); return; }
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let received = false;
    const abort = new AbortController();
    let timer = setTimeout(() => socket.destroy(), 3000);
    socket.once('close', () => { abort.abort(); clearTimeout(timer); sockets.delete(socket); });
    socket.on('error', () => {});
    socket.on('data', raw => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (received) { socket.destroy(); return; }
      if (buffer.byteLength + chunk.byteLength > REQUEST_BYTES) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      received = true;
      clearTimeout(timer);
      void (async () => {
        try {
          if (newline !== buffer.length - 1) fail('input');
          const request: unknown = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
          if (!object(request) || !keys(request, ['version', 'fingerprint', 'operation', 'input', 'timeoutMs', 'origin']) || request.version !== 1) fail('input');
          let currentSelection = false;
          try { currentSelection = contextFingerprint(loadContext(snapshot.configPath, snapshot.profileId)) === fingerprint; } catch {}
          // Saved selection changes invalidate server-owned work even when the caller
          // already has the new fingerprint. A mismatched client alone cannot cancel it.
          if (!currentSelection) { background.close(); fail('stale'); }
          if (request.fingerprint !== fingerprint) fail('stale');
          if (typeof request.operation !== 'string' || !['remember', 'recall', 'ask', 'expand', 'prepare', 'brief', 'cancel-brief'].includes(request.operation)) fail('input');
          const operation = request.operation as Operation;
          const input = inputFor(operation, request.input);
          const origin = request.operation === 'remember' ? await verifyMemoryOrigin(request.origin) : undefined;
          if (request.operation === 'remember' && !origin || request.operation !== 'remember' && request.origin !== undefined) fail('input');
          const waiting = operation === 'brief' && Number((input as HookWaitInput).waitMs) > 0;
          const deadline = timeout(request.timeoutMs, operation === 'ask' || operation === 'expand' ? 301_000 : waiting ? 61_000 : 30_000);
          timer = setTimeout(() => socket.destroy(), deadline);
          let result: BridgeResult;
          if (operation === 'ask') {
            if (researching) fail('busy');
            researching = true;
            try { result = await runResearch((input as RecallInput).query, abort.signal); }
            finally { researching = false; }
          } else if (operation === 'prepare') {
            result = await background.prepare(input as HookPrepareInput);
          } else if (operation === 'brief') {
            result = await background.brief(input as HookWaitInput, abort.signal);
          } else if (operation === 'cancel-brief') {
            result = await background.cancel(input as HookBriefInput);
          } else if (operation === 'expand') {
            result = await expandMemory(snapshot.profile, store, input as { id: string; revision: string }, abort.signal);
          } else result = await execute(snapshot, connection, operation, input as RememberInput | RecallInput, deadline, origin);
          if (contextFingerprint(loadContext(snapshot.configPath, snapshot.profileId)) !== fingerprint) fail('stale');
          const reply = `${JSON.stringify({ ok: true, result })}\n`;
          if (Buffer.byteLength(reply) > RESPONSE_BYTES) fail('response');
          if (!socket.destroyed) socket.end(reply);
        } catch (error) {
          const code = error instanceof MemoryFailure ? error.code : error instanceof ModelBusyError ? 'busy' : 'unavailable';
          if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: false, code })}\n`);
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
  try { await chmod(path, 0o600); } catch { await new Promise<void>(resolve => server.close(() => resolve())); fail('ownership'); }
  const owned = await socketStat(path);
  let closing: Promise<void> | undefined;
  return { close() {
    closing ??= (async () => {
      background.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      // Node usually removes its own socket. Never remove a replacement.
      try { const current = await socketStat(path); if (current.ino === owned.ino && current.dev === owned.dev) await unlink(path); } catch {}
    })();
    return closing;
  } };
}

export function memoryRequest(ctx: EchoContext, operation: 'remember', input: RememberInput, options?: MemoryRequestOptions): Promise<RememberResult>;
export function memoryRequest(ctx: EchoContext, operation: 'recall', input: RecallInput, options?: MemoryRequestOptions): Promise<RecallResult>;
export function memoryRequest(ctx: EchoContext, operation: 'ask', input: { query: string }, options?: MemoryRequestOptions): Promise<SubmindResult>;
export function memoryRequest(ctx: EchoContext, operation: 'expand', input: { id: string; revision: string }, options?: MemoryRequestOptions): Promise<ExpandResult>;
export function memoryRequest(ctx: EchoContext, operation: 'prepare', input: HookPrepareInput, options?: MemoryRequestOptions): Promise<HookBriefResult>;
export function memoryRequest(ctx: EchoContext, operation: 'brief', input: HookWaitInput, options?: MemoryRequestOptions): Promise<HookBriefResult>;
export function memoryRequest(ctx: EchoContext, operation: 'cancel-brief', input: HookBriefInput, options?: MemoryRequestOptions): Promise<HookBriefResult>;
export async function memoryRequest(ctx: EchoContext, operation: Operation, input: BridgeInput, options: MemoryRequestOptions = {}): Promise<BridgeResult> {
  if (options.signal?.aborted) fail('aborted');
  const validated = inputFor(operation, input);
  const origin = operation === 'remember' ? await captureMemoryOrigin().catch(() => fail('input')) : undefined;
  const extended = operation === 'ask' || operation === 'expand';
  const waitMs = operation === 'brief' ? (validated as HookWaitInput).waitMs ?? 0 : 0;
  const deadline = timeout(options.timeoutMs ?? (extended ? submindSettings(ctx.profile).timeoutMs + 1000 : waitMs ? waitMs + 1000 : undefined), extended ? 301_000 : waitMs ? 61_000 : 30_000);
  const path = await checkDirectory(ctx);
  try { await socketStat(path); } catch (error) { if (error instanceof MemoryFailure) throw error; fail('unavailable'); }
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: FailureCode, result?: BridgeResult) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); socket.destroy();
      if (error) reject(new MemoryFailure(error)); else resolve(result!);
    };
    const onAbort = () => finish('aborted');
    const timer = setTimeout(() => finish('timeout'), deadline);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) { finish('aborted'); return; }
    socket.once('connect', () => socket.write(`${JSON.stringify({ version: 1, fingerprint: contextFingerprint(ctx), operation, input: validated, timeoutMs: deadline, ...(origin ? { origin } : {}) })}\n`));
    socket.on('error', () => finish('unavailable'));
    socket.once('close', () => finish('unavailable'));
    socket.on('data', raw => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (buffer.byteLength + chunk.byteLength > RESPONSE_BYTES) { finish('response'); return; }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      try {
        if (newline !== buffer.length - 1) fail('response');
        const reply: unknown = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
        if (!object(reply)) fail('response');
        if (reply.ok === false && codes.has(reply.code as FailureCode)) { finish(reply.code as FailureCode); return; }
        if (reply.ok !== true || !object(reply.result)) fail('response');
        const result = reply.result;
        if (operation === 'prepare' || operation === 'brief' || operation === 'cancel-brief') {
          if (result.schema !== 'echo-hook-brief/v1' || !['pending', 'ready', 'empty', 'busy', 'expired', 'unavailable', 'disabled', 'cancelled'].includes(String(result.status))
            || result.requestId !== null && (typeof result.requestId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(result.requestId))
            || !Array.isArray(result.actions) || result.actions.length > 2) fail('response');
          for (const action of result.actions) {
            if (!object(action) || !keys(action, ['rel', 'operation', 'arguments'])
              || !(action.rel === 'poll' && action.operation === 'memory.brief' || action.rel === 'cancel' && action.operation === 'memory.cancel_brief')) fail('response');
            let args: HookBriefInput;
            try { args = validateHookResearchInput('cancel-brief', action.arguments); } catch { fail('response'); }
            if (args.requestId !== result.requestId || args.host !== (validated as HookPrepareInput).host || args.sessionId !== (validated as HookPrepareInput).sessionId) fail('response');
          }
          if (result.result !== undefined) {
            const brief = result.result;
            if (!object(brief) || brief.schema !== 'echo-memory/v1' || !['ready', 'partial', 'empty', 'disabled', 'unavailable'].includes(String(brief.status))
              || brief.mode !== submindSettings(ctx.profile).mode || !Array.isArray(brief.findings) || !Array.isArray(brief.actions)
              || !object(brief.coverage) || !object(brief.usage)) fail('response');
            if (brief.findings.length && JSON.stringify({ findings: brief.findings, actions: brief.actions }).length > ctx.profile.budget.briefMaxChars) fail('response');
          }
        } else if (operation === 'remember') {
          if (!text(result.id, 256) || !text(result.createdAt, 64)) fail('response');
        } else if (operation === 'ask') {
          if (result.schema !== 'echo-memory/v1' || !['ready', 'partial', 'empty', 'disabled', 'unavailable'].includes(String(result.status))
            || result.mode !== submindSettings(ctx.profile).mode || !Array.isArray(result.findings) || !Array.isArray(result.actions)
            || !object(result.coverage) || !object(result.usage)) fail('response');
          if (result.findings.length && JSON.stringify({ findings: result.findings, actions: result.actions }).length > ctx.profile.budget.briefMaxChars) fail('response');
        } else if (operation === 'expand') {
          if (result.schema !== 'echo-memory/v1' || !['ready', 'changed', 'missing'].includes(String(result.status)) || !Array.isArray(result.actions)) fail('response');
          if (result.memory !== undefined && (!object(result.memory) || typeof result.memory.content !== 'string' || typeof result.memory.title !== 'string'
            || result.memory.content.length + result.memory.title.length > submindSettings(ctx.profile).expandedMaxChars)) fail('response');
        } else {
          if (!Array.isArray(result.memories) || result.memories.length > 5 || typeof result.truncated !== 'boolean') fail('response');
          let length = 0;
          for (const memory of result.memories) {
            if (!object(memory) || !text(memory.id, 256) || !text(memory.timestamp, 64) || typeof memory.title !== 'string' || typeof memory.content !== 'string') fail('response');
            if (memory.provenance !== undefined && !validProvenance(memory.provenance)) fail('response');
            length += memory.title.length + memory.content.length;
          }
          if (length > ctx.profile.budget.briefMaxChars) fail('response');
        }
        finish(undefined, result as unknown as BridgeResult);
      } catch { finish('response'); }
    });
  });
}
