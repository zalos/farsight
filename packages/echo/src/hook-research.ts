import { createHash, randomBytes } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { loadContext, submindSettings } from './config.js';
import { readConnection } from './installation.js';
import { ModelBusyError } from './model-gate.js';
import { bindSession, contextFingerprint } from './sessions.js';
import { validateResearchQuery } from './submind.js';
import type { SubmindResult } from './submind-types.js';
import type { EchoContext } from './types.js';

export interface HookResearchBinding { workspace: string; host: 'claude' | 'codex' | 'vscode'; sessionId: string }
export interface HookPrepareInput extends HookResearchBinding { query: string }
export interface HookBriefInput extends HookResearchBinding { requestId: string }
export interface HookBriefAction {
  rel: 'poll' | 'cancel';
  operation: 'memory.brief' | 'memory.cancel_brief';
  arguments: HookBriefInput;
}
export interface HookBriefResult {
  schema: 'echo-hook-brief/v1';
  requestId: string | null;
  status: 'pending' | 'ready' | 'empty' | 'busy' | 'expired' | 'unavailable' | 'disabled' | 'cancelled';
  result?: SubmindResult;
  actions: HookBriefAction[];
}
export interface HookResearchRegistry {
  prepare(input: HookPrepareInput): Promise<HookBriefResult>;
  brief(input: HookBriefInput): Promise<HookBriefResult>;
  cancel(input: HookBriefInput): Promise<HookBriefResult>;
  close(): void;
}
interface Dependencies {
  research(query: string, signal: AbortSignal): Promise<SubmindResult>;
  now?: () => number;
  /** Smaller deterministic limits for isolated tests; production always uses these defaults. */
  ttlMs?: number;
  maxJobs?: number;
  maxBytes?: number;
}
interface Job {
  id: string;
  key: string;
  binding: HookResearchBinding;
  queryHash: string;
  expires: number;
  status: HookBriefResult['status'];
  controller: AbortController;
  timer: NodeJS.Timeout;
  result?: SubmindResult;
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validText = (value: unknown, limit: number): value is string => typeof value === 'string' && !!value.trim() && value === value.trim() && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/.test(value);
const envelope = (status: HookBriefResult['status'], requestId: string | null = null): HookBriefResult => ({ schema: 'echo-hook-brief/v1', requestId, status, actions: [] });

/** Client and bridge share strict input validation; browser/provider values cannot add an endpoint or identity override. */
export function validateHookResearchInput(operation: 'prepare', input: unknown): HookPrepareInput;
export function validateHookResearchInput(operation: 'brief' | 'cancel-brief', input: unknown): HookBriefInput;
export function validateHookResearchInput(operation: 'prepare' | 'brief' | 'cancel-brief', input: unknown): HookPrepareInput | HookBriefInput {
  if (!object(input) || Object.keys(input).some(key => !['workspace', 'host', 'sessionId', operation === 'prepare' ? 'query' : 'requestId'].includes(key))
    || !validText(input.workspace, 4096) || !isAbsolute(input.workspace) || typeof input.host !== 'string' || !['claude', 'codex', 'vscode'].includes(input.host)
    || !validText(input.sessionId, 512)) throw new Error('input');
  const binding = { workspace: input.workspace, host: input.host as HookResearchBinding['host'], sessionId: input.sessionId };
  if (operation === 'prepare') return { ...binding, query: validateResearchQuery(input.query) };
  if (!validId(input.requestId)) throw new Error('input');
  return { ...binding, requestId: input.requestId };
}

/** Transient, session-scoped research only. Submission socket lifetime never owns accepted work. */
export function createHookResearchRegistry(ctx: EchoContext, dependencies: Dependencies): HookResearchRegistry {
  const startup = structuredClone(ctx);
  const fingerprint = contextFingerprint(startup);
  const settings = submindSettings(startup.profile);
  const enabled = settings.hookResearch === 'background' && settings.mode !== 'off';
  const now = dependencies.now ?? Date.now;
  const ttlMs = Math.min(300_000, Math.max(1, dependencies.ttlMs ?? 300_000));
  const maxJobs = Math.min(16, Math.max(1, dependencies.maxJobs ?? 16));
  const maxBytes = Math.min(262_144, Math.max(256, dependencies.maxBytes ?? 262_144));
  const jobs = new Map<string, Job>();
  let active: Job | undefined;
  let closed = false;

  const keyFor = (binding: HookResearchBinding): string => hash(JSON.stringify([fingerprint, binding.workspace, binding.host, binding.sessionId]));
  function stop(job: Job, status: 'cancelled' | 'expired' | 'unavailable'): void {
    job.status = status; job.result = undefined; job.controller.abort();
  }
  function forget(job: Job): void { clearTimeout(job.timer); jobs.delete(job.id); }
  function bytes(): number {
    let size = 0;
    for (const job of jobs.values()) size += Buffer.byteLength(JSON.stringify({ id: job.id, key: job.key, binding: job.binding, queryHash: job.queryHash, expires: job.expires, status: job.status, result: job.result }));
    return size;
  }
  function prune(): void {
    for (const job of jobs.values()) if (job.expires <= now()) { stop(job, 'expired'); forget(job); }
    while (jobs.size > maxJobs || bytes() > maxBytes) {
      const removable = [...jobs.values()].find(job => job !== active);
      if (!removable) break;
      forget(removable);
    }
    if (bytes() > maxBytes && active) { stop(active, 'unavailable'); forget(active); }
  }
  function read(job: Job, receipt = false): HookBriefResult {
    if (job.status === 'pending' || receipt) {
      const arguments_ = { ...job.binding, requestId: job.id };
      return { ...envelope(job.status, job.id), ...(job.result ? { result: structuredClone(job.result) } : {}), actions: [
        { rel: 'poll', operation: 'memory.brief', arguments: arguments_ },
        ...(job.status === 'pending' ? [{ rel: 'cancel' as const, operation: 'memory.cancel_brief' as const, arguments: { ...arguments_ } }] : []),
      ] };
    }
    return { ...envelope(job.status, job.id), ...(job.result ? { result: structuredClone(job.result) } : {}) };
  }
  function current(): void {
    if (contextFingerprint(loadContext(startup.configPath, startup.profileId)) !== fingerprint) throw new Error('stale');
  }
  function checkConnection(workspace: string): void {
    const connection = readConnection(workspace);
    if (!connection || connection.profileId !== startup.profileId || contextFingerprint(loadContext(connection.configPath, connection.profileId)) !== fingerprint) throw new Error('connection');
  }
  async function bindingFor(input: HookResearchBinding): Promise<HookResearchBinding | undefined> {
    let workspace: string | undefined;
    try {
      current();
      workspace = await realpath(input.workspace);
      if (!(await lstat(workspace)).isDirectory()) throw new Error('workspace');
      const binding = { workspace, host: input.host, sessionId: input.sessionId };
      checkConnection(workspace);
      await bindSession(startup, input.host, input.sessionId, { workspace });
      current(); checkConnection(workspace);
      return binding;
    } catch {
      // A settings change invalidates every job. A disconnected workspace invalidates only its own jobs.
      let all = false; try { current(); } catch { all = true; }
      let connectionChanged = false;
      if (workspace) { try { checkConnection(workspace); } catch { connectionChanged = true; } }
      for (const job of jobs.values()) if (all || connectionChanged && workspace === job.binding.workspace) stop(job, 'unavailable');
      return;
    }
  }
  async function complete(job: Job, query: string): Promise<void> {
    try {
      const result = await dependencies.research(query, job.controller.signal);
      if (job.status !== 'pending' || job.controller.signal.aborted || closed) return;
      if (!await bindingFor(job.binding)) { stop(job, 'unavailable'); return; }
      if (job.status !== 'pending' || job.controller.signal.aborted || closed) return;
      job.result = structuredClone(result);
      job.status = result.status === 'empty' ? 'empty' : result.status === 'unavailable' ? 'unavailable' : result.status === 'disabled' ? 'disabled' : 'ready';
      if (Buffer.byteLength(JSON.stringify({ binding: job.binding, result: job.result })) + 512 > maxBytes) { job.result = undefined; job.status = 'unavailable'; }
    } catch (error) {
      if (job.status === 'pending') job.status = error instanceof ModelBusyError ? 'busy' : 'unavailable';
    } finally {
      if (active === job) active = undefined;
      prune();
    }
  }
  async function prepare(raw: HookPrepareInput): Promise<HookBriefResult> {
    const input = validateHookResearchInput('prepare', raw);
    if (closed) return envelope('unavailable');
    if (!enabled) return envelope('disabled');
    const binding = await bindingFor(input);
    if (!binding || closed) return envelope('unavailable');
    try { if (!loadContext(startup.configPath, startup.profileId).profile.hooks[binding.host]) return envelope('disabled'); } catch { return envelope('unavailable'); }
    prune();
    const key = keyFor(binding), queryHash = hash(input.query);
    // The newest prompt supersedes this session's active work even when a cached
    // brief can answer it immediately. Retain model ownership until that work settles.
    if (active?.key === key && active.queryHash !== queryHash) stop(active, 'cancelled');
    const same = [...jobs.values()].find(job => job.key === key && job.queryHash === queryHash && !['busy', 'cancelled', 'expired'].includes(job.status));
    if (same) return read(same, true);
    if (active) return envelope('busy');
    // No queued work: a competing prompt receives busy and can explicitly retry later.
    const id = randomBytes(24).toString('base64url');
    const controller = new AbortController();
    const job: Job = { id, key, binding, queryHash, expires: now() + ttlMs, status: 'pending', controller,
      timer: setTimeout(() => { stop(job, 'expired'); forget(job); }, ttlMs) };
    job.timer.unref();
    jobs.set(id, job); active = job; prune();
    if (!jobs.has(id)) { active = undefined; return envelope('unavailable'); }
    void complete(job, input.query);
    return read(job, true);
  }
  async function selected(raw: HookBriefInput, cancel: boolean): Promise<HookBriefResult> {
    const input = validateHookResearchInput(cancel ? 'cancel-brief' : 'brief', raw);
    if (closed) return envelope('unavailable');
    if (!enabled) return envelope('disabled');
    const binding = await bindingFor(input);
    if (!binding || closed) return envelope('unavailable');
    prune();
    const job = jobs.get(input.requestId);
    if (!job || job.key !== keyFor(binding)) return envelope('expired', input.requestId);
    if (cancel) stop(job, 'cancelled');
    return read(job);
  }
  return {
    prepare, brief: input => selected(input, false), cancel: input => selected(input, true),
    close() { closed = true; for (const job of jobs.values()) { stop(job, 'cancelled'); forget(job); } },
  };
}
