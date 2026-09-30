// The sync engine (docs/proposals/work-items-sync.md §6). It owns what a
// provider must not: the cache, the cursor, the sync numbers and the source's
// freshness. Providers own paging, rate limits and retries.
import type { WorkItem } from './contract.js';
import type { WorkProvider, SourceConfig, Session, Cursor, Schema, Scope } from './provider.js';
import type { WorkCache, SourceRow } from './cache.js';
import { resolveSecret, resolveMaybeSecret, SecretUnavailable, type ResolveOptions } from './secrets.js';

export interface SyncReport {
  sourceId: string;
  syncNo: number;
  /** records the tracker sent this sync (pages + hydration, each item once) */
  pulled: number;
  /** items whose cached record changed (new or different) */
  changed: number;
  /** items the tracker says are gone */
  deleted: number;
  cursor: Cursor | null;
  durationMs: number;
  /** words, never a secret; absent when the sync succeeded */
  error?: string;
  errorKind?: 'unreachable' | 'credential' | 'other';
}

export interface EngineOptions {
  now?: () => Date;
  secrets?: ResolveOptions;
  /** re-run discover() even when the source row holds a schema */
  rediscover?: boolean;
  /** how long a cached discover() result stays good; overrides `SourceConfig.rediscoverAfter` (default 1 day) */
  schemaTtlMs?: number;
}

export const DEFAULT_RECONCILE_EVERY = 10;
export const DEFAULT_REDISCOVER_AFTER_MS = 24 * 3600_000;

/** `rediscoverAfter` → ms: a number is ms; '90s' · '30m' · '12h' · '1d'; anything else → the default. */
export function parseDuration(v: number | string | undefined, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  const m = typeof v === 'string' ? /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(v.trim()) : null;
  if (!m) return fallback;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3600_000, d: 86400_000 }[m[2] as 'ms' | 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * unit;
}

/** A provider error that looks like the tracker's schema moved under a cached discover() (a field or type gone). */
function smellsLikeSchemaChange(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 400 || status === 404 || status === 410;
}

/** Classify a failure for the freshness sentence. Never reads or returns a secret. */
export function classifyError(err: unknown): 'unreachable' | 'credential' | 'other' {
  if (err instanceof SecretUnavailable) return 'credential';
  const e = err as { status?: number; code?: string; name?: string; cause?: { code?: string }; message?: string };
  if (e?.status === 401 || e?.status === 403) return 'credential';
  // provider auth errors (AzdoAuthUnavailable, …) and any error that says it is about the credential
  if (e?.name && /AuthUnavailable$|^SecretUnavailable$/.test(e.name)) return 'credential';
  if (e?.code === 'credential' || e?.code === 'auth') return 'credential';
  const code = e?.code ?? e?.cause?.code;
  if (code && ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return 'unreachable';
  if (/fetch failed|network|unreachable/i.test(e?.message ?? '')) return 'unreachable';
  return 'other';
}

/** Resolve the source's secret references and connect. The secret lives only in this call. */
export async function connectSource(
  cfg: SourceConfig,
  provider: WorkProvider,
  opts: { secrets?: ResolveOptions; schema?: Schema | null; schemaAt?: string | null } = {},
): Promise<Session> {
  const secret = cfg.auth?.secret ? await resolveSecret(cfg.auth.secret, opts.secrets) : undefined;
  const user = await resolveMaybeSecret(cfg.auth?.user, opts.secrets);
  const resolved: SourceConfig = user !== undefined && cfg.auth ? { ...cfg, auth: { ...cfg.auth, user } } : cfg;
  const ctx = opts.schema ? { schema: opts.schema, ...(opts.schemaAt ? { schemaAt: opts.schemaAt } : {}) } : undefined;
  const session = await provider.connect(resolved, secret, ctx);
  if (opts.schema && !session.schema) session.schema = opts.schema;
  return session;
}

/** One sync of one source: connect → discover (cached) → pull from the cursor → hydrate changed → replace → deletes → cursor. */
export async function syncSource(cfg: SourceConfig, provider: WorkProvider, cache: WorkCache, opts: EngineOptions = {}): Promise<SyncReport> {
  const now = opts.now ?? (() => new Date());
  const started = now();
  cache.upsertSource(cfg);
  const syncNo = cache.beginSync(cfg.id, started.toISOString());
  const before = cache.getSource(cfg.id)!;
  let pulled = 0;
  let changed = 0;
  let deleted = 0;
  let cursor: Cursor | null = before.cursor;

  try {
    const ttl = opts.schemaTtlMs ?? parseDuration(cfg.rediscoverAfter, DEFAULT_REDISCOVER_AFTER_MS);
    const stale = !before.schema || !before.schemaAt || started.getTime() - Date.parse(before.schemaAt) > ttl;
    const cached = opts.rediscover || stale ? null : before.schema;
    const session = await connectSource(cfg, provider, { ...opts, schema: cached, schemaAt: cached ? before.schemaAt : null });
    const rediscover = async () => {
      const schema = await provider.discover(session);
      session.schema = schema;
      cache.setSchema(cfg.id, schema, now().toISOString());
    };
    if (!cached) await rediscover();

    // every Nth pull of an incremental source is a reconcile: the provider is told what the cache holds
    const every = cfg.reconcileEvery ?? DEFAULT_RECONCILE_EVERY;
    const nth = cache.countSyncs(cfg.id, 'pull');
    const scope: Scope = every > 0 && before.cursor !== null && nth % every === 0
      ? { ...cfg.scope, reconcile: { known: cache.listItems({ source: cfg.id }).map((i) => i.id) } }
      : cfg.scope;

    const fromPages = new Map<string, WorkItem>();
    const gone = new Set<string>();
    let finalCursor: Cursor | null = before.cursor;
    const pullAll = async () => {
      for await (const page of provider.pull(session, before.cursor, scope)) {
        for (const it of page.items) { fromPages.set(it.id, it); gone.delete(it.id); }
        for (const d of page.deleted ?? []) { gone.add(d); fromPages.delete(d); }
        if (page.cursor !== null) finalCursor = page.cursor;
        if (page.isLast) break;
      }
    };
    try {
      await pullAll();
    } catch (err) {
      // a 4xx under a cached schema may mean the tracker's fields or types moved: discover once and retry
      if (!cached || !smellsLikeSchemaChange(err)) throw err;
      fromPages.clear(); gone.clear(); finalCursor = before.cursor;
      await rediscover();
      await pullAll();
    }

    // hydrate only what moved since the cache last agreed (new, or a different revision)
    const moved = [...fromPages.values()].filter((it) => cache.getItem(it.id)?.revision !== it.revision).map((it) => it.id);
    const full = new Map<string, WorkItem>();
    for (let i = 0; i < moved.length; i += 100) {
      for (const it of await provider.hydrate(session, moved.slice(i, i + 100))) full.set(it.id, it);
    }
    pulled = fromPages.size;
    for (const it of fromPages.values()) {
      if (cache.replaceItem(cfg.id, full.get(it.id) ?? it, syncNo)) changed++;
    }
    for (const id of gone) if (cache.markDeleted(id, syncNo)) deleted++;
    cursor = finalCursor;

    const durationMs = now().getTime() - started.getTime();
    cache.finishSync(cfg.id, syncNo, { at: now().toISOString(), pulled, changed, deleted, cursor, durationMs });
    return { sourceId: cfg.id, syncNo, pulled, changed, deleted, cursor, durationMs };
  } catch (err) {
    const errorKind = classifyError(err);
    // SecretUnavailable names the reference only; provider errors are expected to carry no secret either
    const error = err instanceof Error ? err.message : String(err);
    const durationMs = now().getTime() - started.getTime();
    cache.finishSync(cfg.id, syncNo, { at: now().toISOString(), pulled, changed, deleted, cursor: before.cursor, durationMs, error, errorKind });
    return { sourceId: cfg.id, syncNo, pulled, changed, deleted, cursor: before.cursor, durationMs, error, errorKind };
  }
}

export type FreshnessState = 'synced' | 'unreachable' | 'credential-expired' | 'never';

export interface Freshness {
  state: FreshnessState;
  /** synced: when the cache last agreed with the tracker · failing: since when · never: null */
  since: string | null;
  /** ms from `since` to now; null when `since` is */
  ago: number | null;
  /** the last good sync, when there was one (the cache the surface is showing) */
  lastOkAt: string | null;
  /** the failure in words, when failing */
  error?: string;
}

/** Facts for the §6.2 freshness sentence; the words come from the catalog. */
export function freshness(row: SourceRow | null, now: Date = new Date()): Freshness {
  const ago = (t: string | null) => (t ? Math.max(0, now.getTime() - Date.parse(t)) : null);
  if (!row) return { state: 'never', since: null, ago: null, lastOkAt: null };
  if (row.lastError) {
    const since = row.failingSince ?? row.lastAttemptAt;
    return {
      state: row.lastErrorKind === 'credential' ? 'credential-expired' : 'unreachable',
      since, ago: ago(since), lastOkAt: row.lastOkAt, error: row.lastError,
    };
  }
  if (!row.lastOkAt) return { state: 'never', since: null, ago: null, lastOkAt: null };
  return { state: 'synced', since: row.lastOkAt, ago: ago(row.lastOkAt), lastOkAt: row.lastOkAt };
}
