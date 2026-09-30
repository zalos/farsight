/**
 * Work items on the server (docs/proposals/work-items-sync.md §9, §10): the
 * sync side (the commit spine with its keys, work sources through the
 * @farsight/work engine, the join that makes `work` nodes and `tracks` edges)
 * and the `/api/work*` routes (the contract fixed with the HUD and MCP lanes).
 *
 * Secrets never pass through here: a work source in settings carries only a
 * `keychain:` reference, resolved in process by the engine.
 */
import type { IncomingMessage } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SnapshotDb, workToFragment, detectWorkKeysFallback, hunksOfPatch, nodesTouched, strongestLinks,
  itemsByState, itemSummaryOf, touchedCount, workFindings, filterWorkItems, flowNodeSet, counted, parseWorkNodeId,
  COMMIT_KEY_VIAS,
} from '@farsight/core';
import type {
  GraphStore, GraphIndex, GraphNode, KeyDetectOptions, KeyDetector, DetectedKey, WorkLinkFact, WorkLinkVia, WorkItemFacts,
  ConfidenceTier, WorkSourceFacts,
} from '@farsight/core';
import { gitLog, gitKnows, gitShowPatch, gitPrefix, commitInputsOf, GIT_ABSENT_WORD } from '@farsight/parsers';
import {
  WorkCache, WorkCacheUnavailable, workDbPath, providerFor, registerProvider, syncSource, connectSource, freshness,
  applyIntent, detectWorkKeys, evaluatePolicy, decide, attributed, STATE_CATEGORIES, WORK_ACTIONS,
} from '@farsight/work';
import type { SourceConfig, SyncReport, WorkItem, Intent, IntentPayload, WorkAction, Person, StateCategory, OutboxRow, ApplyOutcome } from '@farsight/work';
import { fixtureProvider } from '@farsight/work-fixture';
import { jiraProvider } from '@farsight/work-jira';
import { azdoProvider } from '@farsight/work-azdo';

// the providers this server ships — the same three the CLI registers (packages/cli/src/work.ts);
// @farsight/work cannot register its own plugins (they depend on it)
registerProvider(fixtureProvider);
registerProvider(jiraProvider);
registerProvider(azdoProvider);

/** Commits one sync reads per repository — bounded, so a history cannot slow a sync by much. */
export const SYNC_MAX_COMMITS = 500;
/** Keyed commits whose hunks one sync resolves to nodes, per repository. */
const SYNC_MAX_HUNK_COMMITS = 300;

// ── settings ───────────────────────────────────────────────────────────────

/** A settings source, structurally — the server's `Source` with the §10 work fields. */
export interface WorkSettingsSource {
  id: string;
  name?: string;
  type: string;
  path?: string;
  enabled?: boolean;
  provider?: string;
  site?: string;
  org?: string;
  scope?: { projects: string[]; areas?: string[] };
  mode?: 'read-only' | 'edit';
  auth?: SourceConfig['auth'];
  poll?: string;
  fields?: Record<string, string>;
  permissions?: SourceConfig['permissions'];
  status?: string;
}

/** The enabled work sources of a settings object, as the engine takes them (a fixture path resolved against the workspace). */
export function workSourcesOf(ws: string, sources: readonly WorkSettingsSource[]): SourceConfig[] {
  return sources
    .filter((s) => s.type === 'work' && s.enabled !== false)
    .map((s) => {
      const cfg = { mode: 'read-only', scope: { projects: [] }, ...s } as unknown as SourceConfig;
      if (cfg.path && !isAbsolute(cfg.path)) cfg.path = resolve(ws, cfg.path);
      return cfg;
    });
}

/** Jira-shaped keys and Azure DevOps ids: which shape a provider's keys take. */
function shapeOf(provider: string): 'jira' | 'azure-devops' {
  return provider === 'azure-devops' ? 'azure-devops' : 'jira';
}
const shapeOfKey = (key: string): 'jira' | 'azure-devops' => (/^\d+$/.test(key) ? 'azure-devops' : 'jira');

/** What the configured work sources make a key: their Jira projects, and whether any is Azure DevOps. */
export function keyOptionsOf(sources: readonly SourceConfig[]): KeyDetectOptions & { orgs: string[] } {
  const projects = new Set<string>();
  const orgs: string[] = [];
  for (const s of sources) {
    if (shapeOf(s.provider) === 'jira') for (const p of s.scope?.projects ?? []) projects.add(p.toUpperCase());
    else orgs.push(s.org ?? s.id);
  }
  return { projects: [...projects].sort(), ado: orgs.length > 0, orgs };
}

/**
 * The detector: @farsight/work's rules (brackets, `#KEY`, URLs on any host)
 * united with core's fallback (lower-case branch names, numeric ADO branch
 * prefixes), then held to the one rule that matters — a key is a work item
 * only when a configured source could hold it.
 */
export function keyDetector(orgs: readonly string[]): KeyDetector {
  return (text, where, opts) => {
    const projects = new Set((opts.projects ?? []).map((p) => p.toUpperCase()));
    const src = where === 'branch' ? text.toUpperCase().replace(/HTTPS?:\/\/\S+/g, ' ') : text;
    const fromWork: DetectedKey[] = detectWorkKeys(src, { ...(opts.ado ? { adoOrgs: [...orgs] } : {}), branch: where === 'branch' })
      .map((d) => ({ key: d.key.toUpperCase(), provider: d.provider, form: d.via === 'url' ? 'url' as const : 'key' as const }));
    const all = [...fromWork, ...detectWorkKeysFallback(text, where, opts)];
    const out = new Map<string, DetectedKey>();
    for (const d of all) {
      if (d.provider === 'azure-devops' ? !opts.ado : !projects.has(d.key.slice(0, d.key.lastIndexOf('-')) ) || /-0\d*$/.test(d.key)) continue;
      const k = `${d.provider}|${d.key}`;
      const prev = out.get(k);
      if (!prev || (d.form === 'url' && prev.form !== 'url')) out.set(k, d);
    }
    return [...out.values()];
  };
}

// ── sync: the commit spine ─────────────────────────────────────────────────

export interface CodeSourceRead { name: string; dir: string }

/**
 * Write one repository's commits (and the keys they name) into the spine, and
 * resolve each keyed commit's hunks to the nodes it changed. Returns words for
 * the source's status line, or '' when there is nothing to say. Never throws.
 */
export function writeSpine(db: SnapshotDb, store: GraphStore, src: CodeSourceRead, keys: ReturnType<typeof keyOptionsOf>): string {
  try {
    const detect = keyDetector(keys.orgs);
    const sig = JSON.stringify({ p: keys.projects, a: keys.ado });
    const newest = db.newestCommit(src.name);
    const incremental = newest && db.spineReadSig(src.name) === sig && gitKnows(src.dir, newest.sha);
    const wantKeys = (keys.projects?.length ?? 0) > 0 || keys.ado;
    const keyRefs = wantKeys ? (name: string) => detect(name, 'branch', keys).length > 0 : undefined;
    const log = gitLog(src.dir, { max: SYNC_MAX_COMMITS, ...(incremental ? { after: newest!.sha } : {}), ...(keyRefs ? { keyRefs } : {}) });
    if (!log.available) return `history not indexed: ${GIT_ABSENT_WORD[log.reason]}${log.detail ? ` (${log.detail})` : ''}`;
    db.writeCommits(src.name, commitInputsOf(log.commits, { opts: keys, detect }));
    db.markSpineRead(src.name, sig, new Date().toISOString());
    const resolved = resolveCommitNodes(db, store, src);
    const parts = [`history ${log.commits.length} commit${log.commits.length === 1 ? '' : 's'} read${log.truncated ? ` (capped at ${log.max})` : ''}`];
    if (resolved) parts.push(`${resolved} keyed commit${resolved === 1 ? '' : 's'} resolved to code`);
    return parts.join(' · ');
  } catch (err) {
    return `history not indexed: ${(err as Error).message.split('\n')[0]}`;
  }
}

/** The identity of the graph a commit's nodes were resolved against: the repo's source hash. */
function graphIdOf(store: GraphStore, repo: string): string {
  return store.repoMeta(repo)?.sourceHash ?? 'unknown';
}

/** Keyed commits of one repository whose nodes were not resolved against this graph yet → resolve them. */
export function resolveCommitNodes(db: SnapshotDb, store: GraphStore, src: CodeSourceRead): number {
  const graph = graphIdOf(store, src.name);
  const todo = db.keyedCommits().filter((c) => c.repo === src.name && db.commitNodes(c.repo, c.sha, graph) === null).slice(0, SYNC_MAX_HUNK_COMMITS);
  if (!todo.length) return 0;
  const nodes = store.allNodes().filter((n) => n.loc?.repo === src.name);
  const prefix = (() => { const p = gitPrefix(src.dir); return p.available ? p.prefix : ''; })();
  for (const c of todo) db.writeCommitNodes(src.name, c.sha, graph, commitNodesOf(db, src, c.sha, nodes, prefix));
  return todo.length;
}

/** One commit → the nodes its hunks changed, per file. Paths are repo-root-relative; nodes are source-root-relative. */
function commitNodesOf(db: SnapshotDb, src: CodeSourceRead, sha: string, nodes: readonly GraphNode[], prefix: string) {
  const files = db.filesForCommit(src.name, sha);
  if (!files.length) return [];
  const patch = gitShowPatch(src.dir, sha);
  const hunks = patch.available ? hunksOfPatch(patch.patch) : [];
  const rows: { node: string; path: string; fileOnly: boolean }[] = [];
  for (const f of files) {
    if (prefix && !f.path.startsWith(prefix)) continue; // outside this source's root
    const rel = prefix ? f.path.slice(prefix.length) : f.path;
    const h = hunks.find((x) => x.path === f.path);
    const r = nodesTouched(nodes, { path: rel, ranges: h?.ranges ?? [] });
    for (const n of r.nodes) rows.push({ node: n.id, path: f.path, fileOnly: r.fileOnly });
  }
  return rows;
}

// ── sync: work sources and the join ────────────────────────────────────────

export interface UnmatchedKey { key: string; where: string; reason: string }

export interface WorkSyncOutcome {
  /** per work source id: its status line */
  results: Record<string, string>;
  reports: SyncReport[];
  nodes: number;
  edges: number;
  unmatched: UnmatchedKey[];
}

/** Open the work cache, or say why not (node:sqlite missing: an honest degrade, ADR 7). */
export function openWorkCache(ws: string): WorkCache {
  return new WorkCache(workDbPath(ws));
}

/**
 * Run every work source through the engine, then join: declared links (a
 * `work:<KEY>` tag from screens.json or `@work`) and detected ones (a commit
 * naming the key → the nodes it changed), written to the cache's `link` table
 * with their provenance and into the store as `work` nodes and `tracks` edges.
 */
export async function syncWork(
  ws: string,
  sources: readonly SourceConfig[],
  store: GraphStore,
  db: SnapshotDb | undefined,
  opts: { only?: string; pull?: boolean } = {},
): Promise<WorkSyncOutcome> {
  const out: WorkSyncOutcome = { results: {}, reports: [], nodes: 0, edges: 0, unmatched: [] };
  if (!sources.length) return out;
  let cache: WorkCache;
  try {
    cache = openWorkCache(ws);
  } catch (err) {
    const why = err instanceof WorkCacheUnavailable ? 'work cache unavailable' : `work cache unavailable: ${(err as Error).message.split('\n')[0]}`;
    for (const s of sources) out.results[s.id] = why;
    return out;
  }
  try {
    for (const cfg of sources) {
      if (opts.only && cfg.id !== opts.only) continue;
      // pull: false joins what the cache already holds (farsight ingest: no network, no tracker call)
      if (opts.pull === false) {
        const held = cache.listItems({ source: cfg.id }).length;
        out.results[cfg.id] = `ok: ${held} item${held === 1 ? '' : 's'} from the cache (not synced)`;
        continue;
      }
      const provider = providerFor(cfg.provider);
      if (!provider) { out.results[cfg.id] = `error: no provider "${cfg.provider}" is registered in this build`; continue; }
      const r = await syncSource(cfg, provider, cache);
      out.reports.push(r);
      const held = cache.listItems({ source: cfg.id }).length;
      out.results[cfg.id] = r.error
        ? `error: ${r.error} — showing the cache (${held} item${held === 1 ? '' : 's'})`
        : `ok: ${held} item${held === 1 ? '' : 's'} (sync ${r.syncNo}: ${r.pulled} sent, ${r.changed} changed, ${r.deleted} gone)`;
    }
    const joined = joinWork(cache, sources, store, db);
    out.unmatched = joined.unmatched;
    const frag = workToFragment(joined.items, joined.links, { known: (id) => !!store.nodeById(id) });
    store.addFragment(frag);
    out.nodes = frag.applied.nodes;
    out.edges = frag.applied.edges;
    for (const cfg of sources) {
      const linked = frag.edges.filter((e) => parseWorkNodeId(e.from)?.source === cfg.id).length;
      if (out.results[cfg.id]?.startsWith('ok')) out.results[cfg.id] += ` · ${linked} link${linked === 1 ? '' : 's'} to the graph`;
    }
  } finally {
    cache.close();
  }
  return out;
}

/** Items of the configured sources keyed by `<shape>|<KEY>`. */
function itemsByKey(items: readonly WorkItem[]): Map<string, WorkItem[]> {
  const m = new Map<string, WorkItem[]>();
  for (const i of items) {
    const k = `${shapeOf(i.provider)}|${i.key.toUpperCase()}`;
    m.set(k, [...(m.get(k) ?? []), i]);
  }
  return m;
}

const VIA_OF: Record<string, WorkLinkVia> = { subject: 'commit', 'merge-subject': 'commit', branch: 'branch', url: 'url' };

/** The join, pure over the cache, the store and the spine. Also rewrites the cache's `link` table. */
export function joinWork(cache: WorkCache, sources: readonly SourceConfig[], store: GraphStore, db: SnapshotDb | undefined) {
  const ids = new Set(sources.map((s) => s.id));
  const items = cache.listItems().filter((i) => ids.has(i.source));
  const byKey = itemsByKey(items);
  const keys = keyOptionsOf(sources);
  const projects = new Set(keys.projects);
  const links: WorkLinkFact[] = [];
  const unmatched: UnmatchedKey[] = [];

  // declared: work:<KEY> tags (screens.json work[] on a flow or screen, @work in a doc comment)
  for (const n of store.allNodes()) {
    for (const tag of n.tags) {
      if (!tag.startsWith('work:')) continue;
      const key = tag.slice(5).toUpperCase();
      const shape = shapeOfKey(key);
      const where = `${n.kind} ${n.name}${n.loc ? ` (${n.loc.path}:${n.loc.line})` : ''}`;
      const hit = byKey.get(`${shape}|${key}`);
      if (!hit?.length) {
        const project = key.slice(0, key.lastIndexOf('-'));
        const reason = shape === 'azure-devops'
          ? (keys.ado ? `no work item ${key} in the cache` : 'no Azure DevOps source is configured')
          : projects.has(project) ? `no work item ${key} in the cache` : `no work source reads project ${project}`;
        unmatched.push({ key, where, reason });
        continue;
      }
      const how = n.kind === 'flow' || n.design?.origin === 'manifest' ? 'the design manifest' : 'a @work tag';
      for (const it of hit) links.push({ work: it.id, node: n.id, via: 'declared', tier: 'HIGH', detail: `declared in ${how}` });
    }
  }

  // detected: commits naming the key → the nodes their hunks changed
  if (db) {
    for (const it of items) {
      for (const row of db.commitsForKey(it.key.toUpperCase(), { provider: shapeOf(it.provider) })) {
        const nodes = db.commitNodes(row.repo, row.sha) ?? [];
        for (const n of nodes) {
          if (!store.nodeById(n.node)) continue;
          const tier: ConfidenceTier = n.fileOnly ? 'LOW' : 'MEDIUM';
          links.push({ work: it.id, node: n.node, via: VIA_OF[row.via] ?? 'commit', tier, sha: row.sha, detail: `${row.sha.slice(0, 7)} ${n.path}${row.ref ? ` on ${row.ref}` : ''}` });
        }
      }
    }
  }

  replaceJoinLinks(cache, links);
  return { items, links, unmatched };
}

/**
 * Rewrite the join's rows of the cache's `link` table. @farsight/work's cache
 * has put/read and no delete yet, and a join that only ever adds would keep a
 * link whose commit or declaration is gone; until it grows `replaceLinks`, the
 * join clears its own provenances through the cache's connection.
 */
function replaceJoinLinks(cache: WorkCache, links: readonly WorkLinkFact[]): void {
  const at = new Date().toISOString();
  const raw = (cache as unknown as { db?: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
  cache.tx(() => {
    raw?.prepare("DELETE FROM link WHERE kind = 'tracks' AND provenance IN ('declared','commit','branch','url')").run();
    for (const l of links) {
      cache.putLink({
        work: l.work, node: l.node, kind: 'tracks', provenance: l.via, tier: l.tier,
        detail: JSON.stringify({ ...(l.sha ? { sha: l.sha } : {}), ...(l.detail ? { what: l.detail } : {}) }), at,
      });
    }
  });
}

// ── the routes ─────────────────────────────────────────────────────────────

/**
 * The tracker user each source's credential acts as, learned from one
 * connect per server lifetime (fixture: at once; Jira/ADO: one call). An item
 * answer asks for it; a list answer only reports what is already known.
 */
const sessionUsers = new Map<string, Promise<{ id: string; name: string } | undefined>>();
function userOf(cfg: SourceConfig): Promise<{ id: string; name: string } | undefined> {
  const key = `${cfg.id}|${cfg.provider}|${cfg.site ?? cfg.org ?? cfg.path ?? ''}`;
  let p = sessionUsers.get(key);
  if (!p) {
    const provider = providerFor(cfg.provider);
    p = provider
      ? connectSource(cfg, provider).then((s) => s.user, () => undefined)
      : Promise.resolve(undefined);
    sessionUsers.set(key, p);
    // a failed connect is not remembered: the next request asks again
    void p.then((u) => { if (!u) sessionUsers.delete(key); });
  }
  return p;
}
const knownUser = async (cfg: SourceConfig) => {
  const key = `${cfg.id}|${cfg.provider}|${cfg.site ?? cfg.org ?? cfg.path ?? ''}`;
  return sessionUsers.has(key) ? sessionUsers.get(key) : undefined;
};

export interface WorkRouteContext {
  ws: string;
  graphPath: string;
  /** the current settings' sources */
  sources: () => WorkSettingsSource[];
  /** the graph index, or null when there is no graph yet */
  graph: () => { index: GraphIndex; roots: Record<string, string>; meta: { sync?: number } } | null;
  /** re-run the whole workspace sync (POST /api/work/sync without a source runs the work half only) */
  now?: () => Date;
}

export interface RouteAnswer { code: number; body: unknown }

const J = (code: number, body: unknown): RouteAnswer => ({ code, body });

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const c of req) body += c;
  if (!body.trim()) return {};
  return JSON.parse(body) as Record<string, unknown>;
}

function openHistoryDb(ws: string): SnapshotDb | undefined {
  try { return new SnapshotDb(join(ws, '.farsight', 'farsight.db')); } catch { return undefined; }
}

/** The link facts the graph holds: one per tracks edge (the strongest per pair). */
function graphLinks(index: GraphIndex | null): WorkLinkFact[] {
  if (!index) return [];
  const out: WorkLinkFact[] = [];
  for (const edges of index.out.values()) {
    for (const e of edges) {
      if (e.kind !== 'tracks') continue;
      out.push({
        work: e.from, node: e.to, via: (e.meta?.via as WorkLinkVia) ?? 'declared', tier: e.resolution?.confidence ?? 'LOW',
        ...(typeof e.meta?.sha === 'string' ? { sha: e.meta.sha } : {}),
      });
    }
  }
  return out;
}

async function sourceCard(cfg: SourceConfig, cache: WorkCache, items: readonly WorkItem[]): Promise<WorkSourceFacts & { counts: { items: ReturnType<typeof itemsByState> } }> {
  const user = await knownUser(cfg);
  const row = cache.getSource(cfg.id);
  const f = freshness(row);
  const provider = providerFor(cfg.provider);
  return {
    id: cfg.id,
    provider: cfg.provider,
    mode: cfg.mode ?? 'read-only',
    ...(cfg.site ? { site: cfg.site } : {}),
    ...(cfg.org ? { org: cfg.org } : {}),
    scope: cfg.scope ?? { projects: [] },
    ...(provider ? { capabilities: provider.capabilities } : {}),
    freshness: {
      state: f.state,
      ...(f.since ? { since: f.since } : {}),
      ...(f.ago != null ? { ago: Math.round(f.ago / 1000) } : {}),
      ...(row?.lastSync != null ? { syncNo: row.lastSync } : {}),
      ...(f.error ? { error: f.error } : {}),
    },
    counts: { items: itemsByState(items.filter((i) => i.source === cfg.id), 'count.scope.workSource', 'server work.ts sourceCard · cache.listItems') },
    ...(user ? { user } : {}),
  };
}

function nodeRef(index: GraphIndex | null, id: string) {
  const n = index?.byId.get(id);
  return {
    nodeId: id,
    kind: n?.kind ?? 'unknown',
    name: n?.name ?? id.split('::').pop() ?? id,
    ...(n?.facets?.business?.label ? { bizName: n.facets.business.label } : {}),
  };
}

/** Commit counts per item, from the spine: `<shape>|<KEY>` → distinct commits. */
function commitCounts(db: SnapshotDb | undefined): Map<string, number> {
  return db ? db.keyCommitCounts() : new Map();
}
const commitsOf = (counts: Map<string, number>, i: WorkItemFacts) => counts.get(`${shapeOf(i.provider)}|${i.key.toUpperCase()}`) ?? 0;

function linksOfItemFromCache(cache: WorkCache, id: string): WorkLinkFact[] {
  return cache.linksFor(id).filter((l) => l.work === id && l.kind === 'tracks').map((l) => {
    let d: { sha?: string; what?: string } = {};
    try { d = l.detail ? JSON.parse(l.detail) : {}; } catch { d = { what: l.detail }; }
    return { work: l.work, node: l.node, via: l.provenance as WorkLinkVia, tier: l.tier, ...(d.sha ? { sha: d.sha } : {}), ...(d.what ? { detail: d.what } : {}) };
  });
}

/** The findings of every item that tracks a set of nodes (a flow). */
function flowFindings(items: readonly WorkItem[], index: GraphIndex, links: readonly WorkLinkFact[], counts: Map<string, number>) {
  return items.flatMap((i) => workFindings(i, index, { links, commits: commitsOf(counts, i) }).map((f) => ({ item: i.id, ...f })));
}

/** Contract payload → the engine's canonical IntentPayload. */
function toPayload(action: WorkAction, p: Record<string, unknown>): IntentPayload {
  switch (action) {
    case 'transition': {
      const to = String(p.to ?? '');
      return (STATE_CATEGORIES as readonly string[]).includes(to) ? { to: to as StateCategory } : { toName: to };
    }
    case 'edit': {
      const fields: Record<string, unknown> = {};
      if (p.title !== undefined) fields.title = p.title;
      if (p.description !== undefined) fields.description = p.description;
      const labels = p.labels as { add?: string[]; remove?: string[] } | undefined;
      return { fields, ...(labels?.add ? { add: labels.add } : {}), ...(labels?.remove ? { remove: labels.remove } : {}) };
    }
    case 'assign': return { assignee: (p.assignee as string | null | undefined) ?? null };
    case 'comment': return { body: String(p.body ?? '') };
    case 'label': return { ...(p.add ? { add: p.add as string[] } : {}), ...(p.remove ? { remove: p.remove as string[] } : {}) };
    case 'link': return { target: String(p.target ?? ''), ...(p.kind ? { kind: p.kind as IntentPayload['kind'] } : {}) };
    default: return p as IntentPayload;
  }
}

/** The engine's outcome → the contract's status word. */
function statusOf(o: ApplyOutcome): 'applied' | 'conflict' | 'denied' | 'pending' | 'failed' {
  if (o.pending) return 'pending';
  if (o.state === 'confirmed') return 'applied';
  if (o.state === 'conflict') return 'conflict';
  if (o.state === 'denied') return 'denied';
  return 'failed';
}

const NOT_ASKED = { allowed: false, reason: 'not asked' };

/**
 * Handle `/api/work*`, or return null when the url is not one of them.
 * Every answer is JSON; 404 for unknown ids; 503 when the work cache cannot
 * open; a conflict is a 200 with `status: 'conflict'`.
 */
export async function handleWorkRoute(req: IncomingMessage, url: string, ctx: WorkRouteContext): Promise<RouteAnswer | null> {
  if (!url.startsWith('/api/work')) return null;
  const u = new URL(url, 'http://localhost');
  const path = decodeURIComponent(u.pathname);
  const method = req.method ?? 'GET';
  const sources = workSourcesOf(ctx.ws, ctx.sources() as WorkSettingsSource[]);
  const cfgOf = (id: string) => sources.find((s) => s.id === id);

  let cache: WorkCache;
  try {
    cache = openWorkCache(ctx.ws);
  } catch (err) {
    return J(503, { error: `work cache unavailable: ${(err as Error).message.split('\n')[0]}` });
  }
  const db = openHistoryDb(ctx.ws);
  try {
    const g = ctx.graph();
    const index = g?.index ?? null;
    const configured = new Set(sources.map((s) => s.id));
    const allItems = () => cache.listItems().filter((i) => configured.has(i.source));

    // GET /api/work
    if (path === '/api/work' && method === 'GET') {
      const items = allItems();
      const links = graphLinks(index);
      const counts = commitCounts(db);
      const f = Object.fromEntries(['source', 'state', 'assignee', 'q', 'flow', 'node', 'repo'].flatMap((k) => (u.searchParams.get(k) ? [[k, u.searchParams.get(k)!]] : [])));
      const shown = filterWorkItems(items, links, f, index);
      return J(200, {
        sources: await Promise.all(sources.map((s) => sourceCard(s, cache, items))),
        items: shown.map((i) => itemSummaryOf(i, { links, commits: commitsOf(counts, i) })),
        counts: {
          items: itemsByState(shown, 'count.scope.workSources', 'server /api/work · cache.listItems, filtered'),
          sources: counted(sources.length, 'work.count.sources', 'count.scope.workspace', 'server /api/work · settings sources[type=work]', { bizUnit: 'work.count.sources' }),
        },
        generatedAt: (ctx.now?.() ?? new Date()).toISOString(),
        sync: g?.meta.sync ?? null,
      });
    }

    // GET /api/work/links?node=
    if (path === '/api/work/links' && method === 'GET') {
      const node = u.searchParams.get('node');
      if (!node) return J(400, { error: 'missing ?node=<node id>' });
      const links = graphLinks(index);
      const counts = commitCounts(db);
      const items = filterWorkItems(allItems(), links, { node }, index);
      return J(200, {
        node,
        items: items.map((i) => itemSummaryOf(i, { links, commits: commitsOf(counts, i) })),
        counts: { items: itemsByState(items, 'count.scope.node', 'server /api/work/links · tracks edges into the node') },
      });
    }

    // GET /api/work/flow/<flowId>
    if (path.startsWith('/api/work/flow/') && method === 'GET') {
      const flow = path.slice('/api/work/flow/'.length);
      if (!index?.byId.has(flow) || index.byId.get(flow)!.kind !== 'flow') return J(404, { error: `no flow ${flow} in the graph` });
      const links = graphLinks(index);
      const counts = commitCounts(db);
      const reach = flowNodeSet(index, flow);
      const items = filterWorkItems(allItems(), links, { flow }, index);
      return J(200, {
        flow,
        items: items.map((i) => itemSummaryOf(i, { links, commits: commitsOf(counts, i) })),
        counts: {
          items: itemsByState(items, 'journey.scopeAll', 'server /api/work/flow · tracks edges into the flow and the screens it renders'),
          byState: itemsByState(items, 'journey.scopeAll', 'server /api/work/flow · tracks edges into the flow and the screens it renders'),
        },
        findings: flowFindings(items, index, links.filter((l) => reach.has(l.node)), counts),
      });
    }

    // GET /api/work/item/<id>[/diff]
    if (path.startsWith('/api/work/item/') && method === 'GET') {
      const rest = path.slice('/api/work/item/'.length);
      const isDiff = rest.endsWith('/diff');
      const id = isDiff ? rest.slice(0, -'/diff'.length) : rest;
      const item = cache.getItem(id, { includeDeleted: true });
      if (!item || !configured.has(item.source)) return J(404, { error: `no work item ${id} in the cache` });
      const cfg = cfgOf(item.source)!;
      const shape = shapeOf(item.provider);
      const rows = db ? db.commitsForKey(item.key.toUpperCase(), { provider: shape }) : [];

      if (isDiff) return J(200, diffAnswer(ctx, db, rows, u.searchParams.get('sha') ?? ''));

      const cached = linksOfItemFromCache(cache, id);
      const links = cached.length ? cached : graphLinks(index).filter((l) => l.work === id);
      const bySha = new Map<string, typeof rows>();
      for (const r of rows) bySha.set(`${r.repo} ${r.sha}`, [...(bySha.get(`${r.repo} ${r.sha}`) ?? []), r]);
      const rank = (v: string) => COMMIT_KEY_VIAS.indexOf(v as never);
      const commits = [...bySha.values()].map((rs) => {
        const r = [...rs].sort((a, b) => rank(a.via) - rank(b.via))[0]!;
        const nodes = db?.commitNodes(r.repo, r.sha) ?? [];
        const branch = rs.find((x) => x.ref)?.ref ?? db?.branchesForCommit(r.repo, r.sha)[0];
        return {
          repo: r.repo, sha: r.sha, at: r.at, author: r.author, subject: r.subject,
          ...(branch ? { branch } : {}),
          via: r.via, vias: [...new Set(rs.map((x) => x.via))],
          files: (db?.filesForCommit(r.repo, r.sha) ?? []).map((f) => ({ path: f.path, status: f.status })),
          nodes: [...new Set(nodes.map((n) => n.node))],
          ...(nodes.length ? { resolved: nodes.some((n) => n.fileOnly) ? 'file' : 'hunk' } : {}),
        };
      });
      const touchedIds = commits.flatMap((c) => c.nodes).filter((n) => !index || index.byId.has(n));
      const f = freshness(cache.getSource(cfg.id));
      const allowed = Object.fromEntries(
        (['comment', 'assign', 'transition', 'edit', 'label', 'link'] as WorkAction[]).map((action) => {
          const probe: Intent = { id: 'probe', item: id, action, payload: {}, requestedBy: { kind: 'human', id: 'viewer' } };
          const d = evaluatePolicy(cfg.permissions, probe, item, { mode: cfg.mode });
          return [action, { policy: d.verdict.allowed, reason: d.verdict.reason }];
        }),
      );
      const provider = providerFor(cfg.provider);
      const user = await userOf(cfg);
      return J(200, {
        item: withWriters(item, cache),
        links: strongestLinks(links).map((l) => ({
          ...nodeRef(index, l.node), via: l.via, tier: l.tier, ...(l.sha ? { sha: l.sha } : {}),
          provenance: l.detail ?? (l.via === 'declared' ? 'declared' : l.sha ? `commit ${l.sha.slice(0, 7)}` : l.via),
        })),
        commits,
        touched: touchedCount(index, touchedIds),
        findings: workFindings(item, index, { links, commits: commits.length }),
        freshness: {
          state: f.state, ...(f.since ? { since: f.since } : {}), ...(f.ago != null ? { ago: Math.round(f.ago / 1000) } : {}),
          ...(cache.getSource(cfg.id)?.lastSync != null ? { syncNo: cache.getSource(cfg.id)!.lastSync } : {}), ...(f.error ? { error: f.error } : {}),
        },
        mode: cfg.mode ?? 'read-only',
        allowed,
        ...(provider ? { capabilities: provider.capabilities } : {}),
        previewable: !!(provider?.preview && provider.capabilities.dryRun),
        ...(user ? { user } : {}),
      });
    }

    // POST /api/work/sync { source? }
    if (path === '/api/work/sync' && method === 'POST') {
      const body = await readBody(req);
      const only = typeof body.source === 'string' ? body.source : undefined;
      if (only && !cfgOf(only)) return J(404, { error: `no work source ${only} in settings` });
      cache.close();
      const reports: SyncReport[] = [];
      const c2 = openWorkCache(ctx.ws);
      try {
        for (const cfg of sources) {
          if (only && cfg.id !== only) continue;
          const provider = providerFor(cfg.provider);
          if (!provider) { reports.push({ sourceId: cfg.id, syncNo: 0, pulled: 0, changed: 0, deleted: 0, cursor: null, durationMs: 0, error: `no provider "${cfg.provider}" is registered in this build`, errorKind: 'other' }); continue; }
          reports.push(await syncSource(cfg, provider, c2));
        }
      } finally {
        c2.close();
      }
      cache = openWorkCache(ctx.ws);
      return J(200, { reports });
    }

    // POST /api/work/intent
    if (path === '/api/work/intent' && method === 'POST') {
      const body = await readBody(req);
      const action = String(body.action ?? '') as WorkAction;
      if (!(WORK_ACTIONS as readonly string[]).includes(action)) return J(400, { error: `unknown action ${action}` });
      const item = cache.getItem(String(body.item ?? ''));
      if (!item || !configured.has(item.source)) return J(404, { error: `no work item ${String(body.item)} in the cache` });
      const rb = (body.requestedBy ?? {}) as { kind?: string; id?: string };
      const intent: Intent = {
        id: `intent-${randomUUID()}`, item: item.id, action,
        payload: toPayload(action, (body.payload ?? {}) as Record<string, unknown>),
        requestedBy: { kind: rb.kind === 'agent' ? 'agent' : 'human', id: rb.id ?? 'viewer' },
        // the revision the person was shown, when the viewer sends it — a write against what they saw
        baseRevision: typeof body.baseRevision === 'string' && body.baseRevision ? body.baseRevision : item.revision,
      };
      if (body.dryRun === true) return J(200, await previewIntent(intent, cfgOf(item.source)!, cache));
      return J(200, await runIntent(intent, cfgOf(item.source)!, cache, false));
    }

    // POST /api/work/intent/<id>/confirm | /drop | /rebase
    const im = /^\/api\/work\/intent\/([^/]+)\/(confirm|drop|rebase)$/.exec(path);
    if (im && method === 'POST') {
      const row = cache.getIntent(im[1]!);
      if (!row) return J(404, { error: `no intent ${im[1]} in the outbox` });
      const cfg = cfgOf(row.source);
      if (!cfg) return J(404, { error: `the intent's source ${row.source} is no longer in settings` });
      const at = (ctx.now?.() ?? new Date()).toISOString();
      if (im[2] === 'drop') {
        cache.updateIntent(row.intent.id, { state: 'failed', result: { ok: false, error: 'dropped by a person' }, at });
        cache.audit({ at, source: row.source, intent: row.intent.id, item: row.intent.item, action: row.intent.action, requestedBy: row.intent.requestedBy, outcome: 'dropped' });
        return J(200, { intent: row.intent, verdicts: row.verdicts ?? { policy: NOT_ASKED, tracker: NOT_ASKED, credential: NOT_ASKED }, status: 'failed', error: 'dropped by a person' });
      }
      if (im[2] === 'rebase') {
        // the conflict re-read the item into the cache: the same request against what the tracker now says
        const current = cache.getItem(row.intent.item);
        if (!current) return J(404, { error: `no work item ${row.intent.item} in the cache` });
        cache.updateIntent(row.intent.id, { state: 'failed', result: { ok: false, error: 'rebased onto the tracker’s current revision' }, at });
        cache.audit({ at, source: row.source, intent: row.intent.id, item: row.intent.item, action: row.intent.action, requestedBy: row.intent.requestedBy, outcome: 'rebased' });
        const next: Intent = { ...row.intent, id: `intent-${randomUUID()}`, baseRevision: current.revision };
        return J(200, await runIntent(next, cfg, cache, true));
      }
      return J(200, await runIntent(row.intent, cfg, cache, true));
    }

    // GET /api/work/outbox[?source=]
    if (path === '/api/work/outbox' && method === 'GET') {
      const source = u.searchParams.get('source') ?? undefined;
      return J(200, {
        intents: cache.listOutbox(source ? { source } : {}).map((r: OutboxRow) => ({
          ...r.intent, source: r.source, state: r.state, status: r.state,
          key: cache.getItem(r.intent.item, { includeDeleted: true })?.key ?? r.intent.item,
          ...(r.verdicts ? { verdicts: r.verdicts } : {}), ...(r.result ? { result: r.result } : {}),
          // a conflict re-read the item into the cache: what the tracker says now, beside the request
          ...(r.state === 'conflict' ? { theirs: cache.getItem(r.intent.item, { includeDeleted: true }) } : {}),
          created: r.created, updated: r.updated,
        })),
      });
    }

    // GET /api/work/audit?item=
    if (path === '/api/work/audit' && method === 'GET') {
      const item = u.searchParams.get('item') ?? undefined;
      const source = u.searchParams.get('source') ?? undefined;
      return J(200, { rows: cache.listAudit({ ...(item ? { item } : {}), ...(source ? { source } : {}) }) });
    }

    // GET /api/work/people?source=
    if (path === '/api/work/people' && method === 'GET') {
      const source = u.searchParams.get('source') ?? undefined;
      if (source && !cfgOf(source)) return J(404, { error: `no work source ${source} in settings` });
      const people = new Map<string, Person>();
      for (const i of cache.listItems(source ? { source } : {})) {
        if (!configured.has(i.source)) continue;
        for (const p of [i.assignee, i.reporter, ...i.comments.map((c) => c.author)]) if (p && !people.has(p.id)) people.set(p.id, { id: p.id, name: p.name });
      }
      return J(200, { people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name)) });
    }

    // GET /api/work/states?source=&type=
    if (path === '/api/work/states' && method === 'GET') {
      const source = u.searchParams.get('source');
      if (!source || !cfgOf(source)) return J(404, { error: `no work source ${source ?? ''} in settings` });
      const schema = cache.getSource(source)?.schema;
      const type = u.searchParams.get('type');
      const states = type
        ? schema?.types.find((t) => t.name === type || t.category === type)?.states ?? schema?.states ?? []
        : schema?.states ?? [];
      return J(200, { states: states.map((s) => ({ name: s.name, category: s.category })) });
    }

    return J(404, { error: 'not found' });
  } finally {
    cache.close();
    db?.close();
  }
}

/**
 * The tracker's dry run alone (`dryRun: true`): the three verdicts, then the
 * provider's preview against the current revision — nothing is written, nothing
 * queued; one audit row says it was asked.
 */
async function previewIntent(intent: Intent, cfg: SourceConfig, cache: WorkCache) {
  const provider = providerFor(cfg.provider);
  if (!provider) return { intent, verdicts: { policy: NOT_ASKED, tracker: NOT_ASKED, credential: NOT_ASKED }, status: 'failed', error: `no provider "${cfg.provider}" is registered in this build` };
  const item = cache.getItem(intent.item)!;
  const at = new Date().toISOString();
  try {
    const session = await connectSource(cfg, provider);
    const d = await decide(intent, { cfg, provider, session, item });
    if (!d.allowed) return { intent, verdicts: d.verdicts, status: 'denied' };
    if (!provider.preview || !provider.capabilities.dryRun) {
      return { intent, verdicts: d.verdicts, status: 'failed', error: 'this source has no dry run' };
    }
    const p = await provider.preview(session, attributed(intent, cfg.permissions));
    const preview = { ok: p.ok, reason: p.ok ? 'ok' : p.error ?? 'the tracker would refuse it' };
    cache.audit({ at, source: cfg.id, intent: intent.id, item: intent.item, action: intent.action, requestedBy: intent.requestedBy, verdicts: d.verdicts, preview, outcome: 'previewed', detail: p.error });
    return { intent, verdicts: d.verdicts, preview, status: 'previewed', ...(p.ok ? {} : { error: preview.reason }) };
  } catch (err) {
    return { intent, verdicts: { policy: NOT_ASKED, tracker: NOT_ASKED, credential: NOT_ASKED }, status: 'failed', error: (err as Error).message.split('\n')[0] };
  }
}

/**
 * Comments Farsight wrote carry who asked (the intent's requestedBy, from the
 * outbox and audit), so attribution does not rest on a text prefix. A comment
 * is Farsight's when a confirmed comment intent on this item sent that body.
 */
function withWriters(item: WorkItem, cache: WorkCache): WorkItem {
  const sent = cache.listOutbox({ item: item.id }).filter((r) => r.intent.action === 'comment' && r.state === 'confirmed');
  if (!sent.length) return item;
  const confirmed = new Set(cache.listAudit({ item: item.id }).filter((a) => a.outcome === 'confirmed' && a.intent).map((a) => a.intent!));
  const bodies = sent.filter((r) => confirmed.has(r.intent.id)).map((r) => ({ body: String(r.intent.payload.body ?? ''), by: r.intent.requestedBy }));
  return {
    ...item,
    comments: item.comments.map((c) => {
      const hit = bodies.find((b) => b.body && (c.body.text.trim() === b.body.trim() || c.body.text.trim().endsWith(b.body.trim())));
      return hit ? { ...c, requestedBy: hit.by } as typeof c : c;
    }),
  };
}

async function runIntent(intent: Intent, cfg: SourceConfig, cache: WorkCache, confirmed: boolean) {
  const provider = providerFor(cfg.provider);
  if (!provider) return { intent, verdicts: { policy: NOT_ASKED, tracker: NOT_ASKED, credential: NOT_ASKED }, status: 'failed', error: `no provider "${cfg.provider}" is registered in this build` };
  try {
    // connected only once the policy allows the write: a denied request calls no tracker
    const o = await applyIntent(intent, { cfg, provider, session: () => connectSource(cfg, provider), cache, confirmed });
    return {
      intent: o.intent,
      verdicts: o.verdicts ?? { policy: NOT_ASKED, tracker: NOT_ASKED, credential: NOT_ASKED },
      status: statusOf(o),
      ...(o.preview ? { preview: o.preview } : {}),
      ...(o.item ? { item: withWriters(o.item, cache) } : {}),
      ...(o.reason && statusOf(o) !== 'applied' ? { error: o.reason } : {}),
    };
  } catch (err) {
    return { intent, verdicts: { policy: NOT_ASKED, tracker: NOT_ASKED, credential: NOT_ASKED }, status: 'failed', error: (err as Error).message.split('\n')[0] };
  }
}

/** The checkout a repository's commits can be shown from: the graph's recorded root, confined to a real directory. */
function rootOf(ctx: WorkRouteContext, repo: string): string | undefined {
  const r = ctx.graph()?.roots[repo];
  if (r && existsSync(r) && statSync(r).isDirectory()) return r;
  const src = ctx.sources().find((s) => s.type === 'local' && (s.name === repo || s.id === repo));
  if (!src?.path) return undefined;
  const abs = resolve(ctx.ws, src.path);
  return existsSync(abs) ? abs : undefined;
}

/**
 * One commit's diff, per file, with the nodes in its hunks. Only a commit that
 * names this item is served (the sha must be one of its rows), read with git in
 * that repository's own checkout; paths come from the recorded file list, so no
 * request can name a file outside it. Fail-soft: `{ error }` in words.
 */
function diffAnswer(ctx: WorkRouteContext, db: SnapshotDb | undefined, rows: { repo: string; sha: string; at: string; author: string; subject: string }[], sha: string) {
  if (!/^[0-9a-f]{7,64}$/.test(sha)) return { error: `?sha= must be a commit id (got "${sha}")` };
  const row = rows.find((r) => r.sha === sha || r.sha.startsWith(sha));
  if (!row) return { error: `commit ${sha} does not name this work item in the indexed history` };
  const root = rootOf(ctx, row.repo);
  if (!root) return { sha: row.sha, subject: row.subject, at: row.at, author: row.author, files: [], error: `the checkout of ${row.repo} is not on this machine` };
  const files = db?.filesForCommit(row.repo, row.sha) ?? [];
  const nodes = db?.commitNodes(row.repo, row.sha) ?? [];
  const patch = gitShowPatch(root, row.sha, { context: 3 });
  if (!patch.available) return { sha: row.sha, subject: row.subject, at: row.at, author: row.author, files: [], error: `git could not show ${row.sha.slice(0, 7)}: ${GIT_ABSENT_WORD[patch.reason]}${patch.detail ? ` (${patch.detail})` : ''}` };
  const byFile = splitPatch(patch.patch);
  return {
    sha: row.sha, subject: row.subject, at: row.at, author: row.author,
    files: files.map((f) => ({
      path: f.path, status: f.status,
      patch: byFile.get(f.path) ?? '',
      nodes: [...new Set(nodes.filter((n) => n.path === f.path).map((n) => n.node))],
    })),
  };
}

/** A multi-file unified diff → the text of each file's section, keyed by its new path. */
function splitPatch(patch: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = patch.split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git '));
  for (const p of parts) {
    const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(p)?.[1];
    const minus = /^--- (?:a\/)?(.+)$/m.exec(p)?.[1];
    const head = /^diff --git a\/(.+?) b\/(.+)$/m.exec(p);
    const path = plus && plus !== '/dev/null' ? plus : minus && minus !== '/dev/null' ? minus : head?.[2];
    if (path) out.set(path.replace(/\t.*$/, ''), p);
  }
  return out;
}

export type { SourceConfig };
