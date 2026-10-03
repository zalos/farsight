/**
 * Work items over MCP (docs/proposals/work-items-sync.md §10): an agent reads a
 * Jira / Azure DevOps item's content and context, sees what it changed in the
 * code, and — only where a source grants it — writes to it.
 *
 * Every read goes through the local cache (`.farsight/work.db` beside the
 * graph), opened fail-soft: no work source, or a runtime without node:sqlite,
 * is one honest line, never a throw. The facts are the ones `/api/work*`
 * serves (the route contract Lane D implements); here they are printed as
 * text, with every number a `Counted` said by `countedLine`, and the source's
 * freshness sentence at the top of every answer.
 *
 * The commit spine (which commits name a key, and what their hunks touched) is
 * read from `farsight.db` when this build's SnapshotDb carries it; an older
 * spine says *history not indexed* instead of guessing.
 *
 * Writes: a `work_<action>` tool exists only when some edit-mode source grants
 * that action to principal `agent`. Each builds an Intent asked for by this MCP
 * session and runs the engine's `applyIntent` — three verdicts, then applied /
 * pending / conflict / denied / failed, in words.
 */
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as core from '@farsight/core';
import {
  t, counted, countedLine, countedText, impactOf, nodesInHunks, SnapshotDb,
  type Counted, type CountPart, type GraphIndex, type ImpactReport,
} from '@farsight/core';
import {
  WorkCache, WorkCacheUnavailable, workDbPath, loadWorkSources, providerFor, registerProvider, listProviders,
  syncSource, connectSource, applyIntent, freshness, freshnessText, stateWord, workItemsCounted, syncCounted,
  itemCounted, WORK_SCHEMA, STATE_CATEGORIES, WORK_ACTIONS,
  type SourceConfig, type WorkItem, type WorkListDocument, type StateCategory, type WorkAction, type Intent,
  type IntentPayload, type ApplyOutcome, type Verdicts, type LinkKind,
} from '@farsight/work';
import { fixtureProvider } from '@farsight/work-fixture';
import { jiraProvider } from '@farsight/work-jira';
import { azdoProvider } from '@farsight/work-azdo';

const R = 'professional' as const;
const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

// ── providers ────────────────────────────────────────────────────────────────
// The providers this MCP ships — one line each, as packages/cli/src/work.ts does.
registerProvider(fixtureProvider);
registerProvider(jiraProvider);
registerProvider(azdoProvider);

// ── the spine, structurally (Lane D's SnapshotDb methods; absent on older builds) ──

interface KeyCommitRow { repo: string; sha: string; via: string; ref?: string; at: string; author: string; subject: string; merge?: boolean }
interface SpineDb {
  commitsForKey(key: string, opts?: { repo?: string; provider?: string }): KeyCommitRow[];
  filesForCommit?(repo: string, sha: string): { path: string; status: string; oldPath?: string }[];
  commitNodes?(repo: string, sha: string, graph?: string): { node: string; path: string; fileOnly: boolean }[] | null;
  branchesForCommit?(repo: string, sha: string): string[];
  keyCommitCounts?(): Map<string, number>;
  close(): void;
}

/** A commit that names an item, once, with every way it named it. */
interface ItemCommit {
  repo: string; sha: string; at: string; author: string; subject: string;
  vias: string[]; refs: string[];
  files: { path: string; status: string }[];
  /** node ids its hunks touched; `null` when never computed and not computable here */
  nodes: string[] | null;
  /** how `nodes` was known */
  nodesFrom: 'spine' | 'diff-now' | 'none';
}

const COMMIT_VIA_WORDS: Record<string, string> = {
  subject: 'named in the commit subject', branch: 'on a branch named for it', 'merge-subject': 'named in a merge subject', url: 'a tracker link in the commit message',
};
const LINK_VIA_WORDS: Record<string, string> = {
  declared: 'declared (screens.json work: or @work)', commit: 'a commit that names it changed this', branch: 'a branch named for it changed this', url: 'a commit linking to it changed this',
};

/** A catalog word exists in this build (t() returns the key for an unknown one). */
const hasWord = (key: string) => t(key, R) !== key;

export interface WorkToolsContext {
  server: McpServer;
  graphPath: string;
  index: () => GraphIndex;
  roots: () => Record<string, string>;
}

export interface WorkTools {
  /** `## work items` for graph_overview — silent when no work source is configured */
  overviewLines(): string[];
  /** findings for `## keeping current`: a stale or failing source, and the tool that fixes it */
  currencyFindings(): string[];
  /** the write tools this server registered (for graph_overview and the tests) */
  writeTools: string[];
}

const WRITE_TOOL: Partial<Record<WorkAction, string>> = {
  comment: 'work_comment', assign: 'work_assign', transition: 'work_transition', edit: 'work_edit', label: 'work_label', link: 'work_link',
};

/** Register the work tools on `server`; read tools always, write tools only where granted. */
export function registerWorkTools(ctx: WorkToolsContext): WorkTools {
  const { server, graphPath } = ctx;
  const workspace = dirname(graphPath);
  const sessionId = `mcp-${randomUUID()}`;

  const sources = (): SourceConfig[] => {
    try { return loadWorkSources(workspace); } catch { return []; }
  };

  /** Open the cache, run `fn`, close. The two honest refusals are sentences. */
  function withCache(fn: (cache: WorkCache, srcs: SourceConfig[]) => string | Promise<string>, opts: { needSources?: boolean } = {}): Promise<string> | string {
    const srcs = sources();
    if (opts.needSources !== false && !srcs.length) {
      return `${t('sys.work.noSources', R)} (looked in ${join(workspace, '.farsight', 'settings.json')}).`;
    }
    let cache: WorkCache;
    try {
      cache = new WorkCache(workDbPath(workspace));
    } catch (err) {
      return err instanceof WorkCacheUnavailable ? err.message : `work-item cache could not be opened: ${(err as Error).message}`;
    }
    const done = (s: string) => { try { cache.close(); } catch { /* closed */ } return s; };
    try {
      const out = fn(cache, srcs);
      return out instanceof Promise ? out.then(done, (e) => { done(''); throw e; }) : done(out);
    } catch (err) {
      done('');
      throw err;
    }
  }

  const modeWord = (s: SourceConfig) => t(s.mode === 'edit' ? 'work.mode.edit' : 'work.mode.readOnly', R);
  const freshLine = (cache: WorkCache, s: SourceConfig) => `${s.id} · ${s.provider} · ${modeWord(s)} · ${freshnessText(freshness(cache.getSource(s.id)), R)}`;

  /** Key or node id → item, or a sentence saying why not. */
  function findItem(cache: WorkCache, keyOrId: string, source?: string): WorkItem | string {
    if (keyOrId.startsWith('work::')) return cache.getItem(keyOrId) ?? `no work item ${keyOrId} in the local copy — work_sync first, or check the id with work_items`;
    const found = cache.findByKey(keyOrId, source);
    if (!found.length) return t('sys.work.notFound', R).replace('{key}', keyOrId).replace('run farsight work sync first', 'call work_sync first');
    if (found.length > 1) return `${keyOrId} is in more than one work source (${found.map((i) => i.source).join(', ')}): pass source`;
    return found[0]!;
  }

  // ── the graph join: tracks edges + cache links ─────────────────────────────

  interface NodeLink { node: string; via: string; tier: string; sha?: string; detail?: string }

  /** Graph nodes an item reaches: `tracks` edges out of its work node, then the cache's links, strongest per node. */
  function linksOf(cache: WorkCache, item: WorkItem): NodeLink[] {
    const index = ctx.index();
    const out = new Map<string, NodeLink>();
    const rank = (tier: string) => (tier === 'HIGH' ? 3 : tier === 'MEDIUM' ? 2 : 1);
    const put = (l: NodeLink) => { const had = out.get(l.node); if (!had || rank(l.tier) > rank(had.tier)) out.set(l.node, l); };
    for (const e of index.out.get(item.id) ?? []) {
      if ((e.kind as string) !== 'tracks') continue;
      const meta = (e.meta ?? {}) as { via?: string; sha?: string; detail?: string };
      put({ node: e.to, via: meta.via ?? 'declared', tier: e.resolution?.confidence ?? 'MEDIUM', ...(meta.sha ? { sha: meta.sha } : {}), ...(meta.detail ? { detail: meta.detail } : {}) });
    }
    for (const l of cache.linksFor(item.id)) {
      if (l.work !== item.id) continue;
      put({ node: l.node, via: l.provenance, tier: l.tier, ...(l.detail ? { detail: l.detail } : {}) });
    }
    return [...out.values()];
  }

  /** Items tracking a node: `tracks` edges into it, plus the cache's links. */
  function itemsTracking(cache: WorkCache, nodeIds: string[]): Map<string, { item: WorkItem; via: string; node: string }> {
    const index = ctx.index();
    const out = new Map<string, { item: WorkItem; via: string; node: string }>();
    for (const id of nodeIds) {
      for (const e of index.in.get(id) ?? []) {
        if ((e.kind as string) !== 'tracks' || out.has(e.from)) continue;
        const item = cache.getItem(e.from);
        if (item) out.set(item.id, { item, via: ((e.meta ?? {}) as { via?: string }).via ?? 'declared', node: id });
      }
      for (const l of cache.linksFor(id)) {
        if (l.node !== id || out.has(l.work)) continue;
        const item = cache.getItem(l.work);
        if (item) out.set(item.id, { item, via: l.provenance, node: id });
      }
    }
    return out;
  }

  /** A flow and the screens it renders — what "the items on a flow" are tracked through. */
  function flowNodes(flowId: string): string[] {
    const index = ctx.index();
    return [flowId, ...(index.out.get(flowId) ?? []).filter((e) => e.kind === 'renders').map((e) => e.to)];
  }

  // ── the spine ──────────────────────────────────────────────────────────────

  const historyDb = () => join(workspace, '.farsight', 'farsight.db');

  /** Open the spine, or say why it cannot answer. */
  function openSpine(): SpineDb | string {
    if (!existsSync(historyDb())) return `history not indexed — no ${historyDb()} beside this graph (every ingest and server sync writes one)`;
    let db: SnapshotDb;
    try { db = new SnapshotDb(historyDb()); } catch (err) { return `history not indexed — ${(err as Error).message}`; }
    const spine = db as unknown as Partial<SpineDb>;
    if (typeof spine.commitsForKey !== 'function') {
      try { db.close(); } catch { /* closed */ }
      return 'history not indexed — this build\'s commit spine does not record which commits name a work item';
    }
    return spine as SpineDb;
  }

  const spineProvider = (item: WorkItem) => (item.provider === 'jira' || item.provider === 'azure-devops' ? item.provider : undefined);

  /** Hunk specs (`path:from-to`) of one commit, read with git from the source root. */
  function hunkSpecs(root: string, sha: string): string[] | null {
    const r = spawnSync('git', ['-C', root, 'show', '--format=', '--unified=0', '--relative', '--no-color', sha, '--', '.'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) return null;
    const specs: string[] = [];
    let path: string | null = null;
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('+++ ')) { path = line === '+++ /dev/null' ? null : line.replace(/^\+\+\+ b\//, ''); continue; }
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m && path) {
        const from = Number(m[1]);
        const len = m[2] === undefined ? 1 : Number(m[2]);
        specs.push(len <= 1 ? `${path}:${from}` : `${path}:${from}-${from + len - 1}`);
        if (len === 0) specs[specs.length - 1] = `${path}:${Math.max(1, from)}`;
      }
    }
    return specs;
  }

  /** The commits naming an item, once each, with files and touched nodes. `string` = why there are none to show. */
  function commitsOf(item: WorkItem): ItemCommit[] | string {
    const spine = openSpine();
    if (typeof spine === 'string') return spine;
    try {
      const rows = spine.commitsForKey(item.key, { ...(spineProvider(item) ? { provider: spineProvider(item) } : {}) });
      // no key on any commit at all is "not read", never "none name it"
      if (!rows.length && spine.keyCommitCounts && spine.keyCommitCounts().size === 0) {
        return 'history not indexed — the commit spine records no work-item key on any commit yet (keys are read when the workspace syncs its sources)';
      }
      // one entry per commit (by sha alone): sources reading one checkout each record it under
      // their own repo name, and their nodes are unioned below (KAN-8)
      const by = new Map<string, ItemCommit>();
      const reposOf = new Map<string, string[]>();
      for (const r of rows) {
        const had = by.get(r.sha);
        if (had) {
          if (!had.vias.includes(r.via)) had.vias.push(r.via);
          if (r.ref && !had.refs.includes(r.ref)) had.refs.push(r.ref);
          if (!reposOf.get(r.sha)!.includes(r.repo)) reposOf.get(r.sha)!.push(r.repo);
          continue;
        }
        by.set(r.sha, { repo: r.repo, sha: r.sha, at: r.at, author: r.author, subject: r.subject, vias: [r.via], refs: r.ref ? [r.ref] : [], files: [], nodes: null, nodesFrom: 'none' });
        reposOf.set(r.sha, [r.repo]);
      }
      const index = ctx.index();
      for (const c of by.values()) {
        const files = new Map<string, { path: string; status: string }>();
        const nodes = new Set<string>();
        let from: ItemCommit['nodesFrom'] = 'none';
        for (const repo of reposOf.get(c.sha)!) {
          for (const f of spine.filesForCommit?.(repo, c.sha) ?? []) if (!files.has(f.path)) files.set(f.path, { path: f.path, status: f.status });
          const recorded = spine.commitNodes?.(repo, c.sha) ?? null;
          if (recorded) { for (const x of recorded) nodes.add(x.node); if (from === 'none') from = 'spine'; continue; }
          // never computed against this graph: compute now from the diff, with core's one rule for hunks → nodes
          const root = ctx.roots()[repo];
          const specs = root && existsSync(root) ? hunkSpecs(root, c.sha) : null;
          if (specs) {
            const nodesOfRepo = [...index.byId.values()].filter((n) => n.loc?.repo === repo);
            for (const s of nodesInHunks(nodesOfRepo, specs).seeds) nodes.add(s.node.id);
            from = 'diff-now';
          }
        }
        c.files = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
        if (from !== 'none') { c.nodes = [...nodes]; c.nodesFrom = from; }
      }
      return [...by.values()].sort((a, b) => b.at.localeCompare(a.at));
    } finally {
      try { spine.close(); } catch { /* closed */ }
    }
  }

  /** How many distinct commits name each item — one pass over the spine, or null when it cannot say. */
  function commitCounts(): Map<string, number> | null {
    const spine = openSpine();
    if (typeof spine === 'string') return null;
    try { return spine.keyCommitCounts?.() ?? null; } finally { try { spine.close(); } catch { /* closed */ } }
  }
  const commitCountOf = (counts: Map<string, number> | null, item: WorkItem): number | null => {
    if (!counts) return null;
    const p = spineProvider(item);
    if (p) return counts.get(`${p}|${item.key}`) ?? 0;
    let n = 0;
    for (const [k, v] of counts) if (k.endsWith(`|${item.key}`)) n += v;
    return n;
  };

  // ── Counteds ───────────────────────────────────────────────────────────────

  const commitsCounted = (n: number, scope: 'count.scope.workItem' = 'count.scope.workItem'): Counted | undefined =>
    hasWord('work.count.commits') ? counted(n, 'work.count.commits', scope, 'farsight.db commit_key (commitsForKey)', { bizUnit: 'work.count.commits' }) : undefined;

  const PART: Record<StateCategory, string> = { todo: 'count.part.workTodo', 'in-progress': 'count.part.workInProgress', done: 'count.part.workDone', removed: 'count.part.workRemoved' };
  /** Items by state category, over a scope the list names (a node, or a whole journey). */
  function itemsByState(items: WorkItem[], scope: 'count.scope.node' | 'journey.scopeAll', source: string): Counted {
    const breakdown: CountPart[] = STATE_CATEGORIES.map((c) => ({ key: PART[c], n: items.filter((i) => i.state.category === c).length })).filter((p) => p.n);
    return counted(items.length, 'count.unit.workItems', scope, source, { bizUnit: 'count.unit.workItems', breakdown });
  }

  /** Touched nodes of a set of commits, counted once over the scope of one item (the kinds are said beside it by kindsText). */
  function touchedCounted(nodeIds: Iterable<string>): Counted | undefined {
    if (!hasWord('work.count.touched')) return undefined;
    const index = ctx.index();
    const ids = [...new Set(nodeIds)].filter((id) => index.byId.has(id));
    return counted(ids.length, 'work.count.touched', 'count.scope.workItem', 'farsight.db commit_node · nodesInHunks', { bizUnit: 'work.count.touched' });
  }
  const kindsText = (nodeIds: string[]) => {
    const index = ctx.index();
    const by = new Map<string, number>();
    for (const id of nodeIds) { const k = index.byId.get(id)?.kind; if (k) by.set(k, (by.get(k) ?? 0) + 1); }
    return [...by.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ');
  };

  // ── findings (core's fold when this build has it) ──────────────────────────

  type Finding = { kind: string; text: string; provenances: { source: string; what: string }[] };
  const coreFindings = (core as unknown as Record<string, unknown>).workFindings as
    | ((item: WorkItem, index: GraphIndex | null, join: { links: { work: string; node: string; via: string; tier: string; sha?: string }[]; commits: number }, register?: string) => Finding[])
    | undefined;
  function findingsOf(cache: WorkCache, item: WorkItem, commits: number): Finding[] | null {
    if (!coreFindings) return null;
    const links = linksOf(cache, item).map((l) => ({ work: item.id, node: l.node, via: l.via, tier: l.tier, ...(l.sha ? { sha: l.sha } : {}) }));
    try { return coreFindings(item, ctx.index(), { links, commits }, R); } catch { return null; }
  }
  const findingLines = (fs: Finding[]) => fs.flatMap((f) => [`⚠ ${f.kind}: ${f.text}`, ...f.provenances.map((p) => `    ${p.source}: ${p.what}`)]);

  // ── rendering ──────────────────────────────────────────────────────────────

  const when = (iso?: string) => (iso ? iso.slice(0, 16).replace('T', ' ') : '?');
  const stateText = (i: WorkItem) => `${i.state.name} · ${stateWord(i.state.category, R)}`;
  const nodeName = (id: string) => {
    const n = ctx.index().byId.get(id);
    return n ? `${n.kind} ${n.facets?.business?.label && n.facets.business.label !== n.name ? `${n.name} — ${n.facets.business.label}` : n.name}` : `(not in this graph) ${id}`;
  };

  function itemRow(cache: WorkCache, i: WorkItem, counts: Map<string, number> | null): string {
    const links = linksOf(cache, i).length;
    const commits = commitCountOf(counts, i);
    const nums = [
      countedText(itemCounted(i, links).links, { scope: false }),
      commits == null ? 'commits not indexed' : (commitsCounted(commits) ? countedText(commitsCounted(commits)!, { scope: false }) : `${commits} commit(s)`),
    ].join(' · ');
    return `- ${i.key} · ${i.type.name} · ${stateText(i)} · ${i.title} — ${i.assignee?.name ?? t('work.label.unassigned', R)} · updated ${when(i.updated)} · ${nums} \`${i.id}\``;
  }

  // ── read tools ─────────────────────────────────────────────────────────────

  server.registerTool('work_items', {
    title: 'Work items — Jira / Azure DevOps stories, bugs, tasks',
    description: 'The work items (Jira issues, Azure DevOps work items) the workspace\'s work sources hold, read from the local copy the last sync made — each with the tracker\'s status name beside its category (to do · in progress · done · removed), assignee, when it was last updated, how many graph nodes it links to and how many commits name it. Every answer starts with each source\'s freshness sentence. Filter by source, state category, assignee, updated_since, free text q, or the flow / node the items track. Use to see the open work around a feature before changing it, or to find the key to pass to work_item. format:"json" is the frozen farsight-work v1 list document.',
    inputSchema: {
      source: z.string().optional().describe('one work source id (see graph_overview ## work items)'),
      state: z.enum(STATE_CATEGORIES).optional().describe('state category: todo | in-progress | done | removed'),
      assignee: z.string().optional().describe('person id, or part of a name (case-insensitive)'),
      updated_since: z.string().optional().describe('ISO date or time — only items the tracker updated at or after it'),
      q: z.string().optional().describe('free text matched against key, title, description and labels'),
      flow: z.string().optional().describe('a flow node id — the items tracking it or one of its screens'),
      node: z.string().optional().describe('any graph node id — the items tracking it'),
      format: z.enum(['text', 'json']).optional().describe('text (default) · json = farsight-work v1 list document'),
    },
  }, async ({ source, state, assignee, updated_since, q, flow, node, format }) => text(await withCache((cache, all) => {
    const srcs = source ? all.filter((s) => s.id === source) : all;
    if (!srcs.length) return t('sys.work.unknownSource', R).replace('{source}', source ?? '');
    let items = srcs.flatMap((s) => cache.listItems({ source: s.id, ...(state ? { state } : {}), ...(assignee ? { assignee } : {}) }));
    if (updated_since) {
      const since = Date.parse(updated_since);
      if (Number.isNaN(since)) return `updated_since expects an ISO date or time (got "${updated_since}")`;
      items = items.filter((i) => Date.parse(i.updated) >= since);
    }
    if (q) {
      const needle = q.toLowerCase();
      items = items.filter((i) => [i.key, i.title, i.body?.text ?? '', ...i.labels].some((s) => s.toLowerCase().includes(needle)));
    }
    if (flow || node) {
      const ids = flow ? flowNodes(flow) : [node!];
      if (!ctx.index().byId.has(ids[0]!)) return `no node ${ids[0]} in this graph — search_graph finds its id`;
      const tracking = itemsTracking(cache, ids);
      items = items.filter((i) => tracking.has(i.id));
    }
    if (format === 'json') {
      const doc: WorkListDocument = { schema: WORK_SCHEMA, generatedAt: new Date().toISOString(), sources: srcs.map((s) => s.id), items };
      return JSON.stringify(doc, null, 2);
    }
    const counts = commitCounts();
    const filters = [state && `state ${state}`, assignee && `assignee ${assignee}`, updated_since && `updated since ${updated_since}`, q && `matching "${q}"`, flow && `tracking flow ${flow}`, node && `tracking ${node}`].filter(Boolean);
    const lines = [
      ...srcs.map((s) => freshLine(cache, s)),
      countedLine([workItemsCounted(items, srcs.length === 1 ? 'count.scope.workSource' : 'count.scope.workSources')], { zeroes: true }) + (filters.length ? ` — filtered: ${filters.join(', ')}` : ''),
    ];
    if (!items.length) lines.push(t('work.none', R));
    const CAP = 80;
    for (const i of items.slice(0, CAP)) lines.push(itemRow(cache, i, counts));
    if (items.length > CAP) lines.push(`… +${items.length - CAP} more — narrow with state, assignee, q or source, or format:"json" for all`);
    lines.push('', 'work_item <key> for one item in full · work_changes <key> for the code its commits touched');
    return lines.join('\n');
  })));

  server.registerTool('work_item', {
    title: 'One work item in full — content, discussion, history, code',
    description: 'One work item by key (INV-5, ACME-123, 4711) or node id (work::<source>::<key>): title, status in words beside the tracker\'s own name, type, assignee, reporter, labels, parent, iteration, the description text, every comment with its author and time, the field-change history, the graph nodes it links to and how each link is known (declared, or a commit / branch that names it), and the commits that name it with subject, author, when, how, files and the nodes they touched. Ends with the findings where the tracker and the code disagree (done but not built, to do but already committed). Use to read a story before implementing it, or to check what was really done for it.',
    inputSchema: {
      key: z.string().describe('the item key (INV-5) or its node id (work::<source>::<key>)'),
      source: z.string().optional().describe('work source id, when the key is in more than one'),
    },
  }, async ({ key, source }) => text(await withCache((cache, srcs) => {
    const item = findItem(cache, key, source);
    if (typeof item === 'string') return item;
    const cfg = srcs.find((s) => s.id === item.source);
    const links = linksOf(cache, item);
    const c = itemCounted(item, links.length);
    const lines = [
      cfg ? freshLine(cache, cfg) : `${item.source} · ${freshnessText(freshness(cache.getSource(item.source)), R)} (no longer configured)`,
      `# ${item.key} · ${item.type.name} · ${stateText(item)}${item.state.since ? ` since ${when(item.state.since)}` : ''}`,
      item.title,
      item.url,
      `${t('work.label.assignee', R)}: ${item.assignee?.name ?? t('work.label.unassigned', R)}`,
      ...(item.reporter ? [`${t('work.label.reporter', R)}: ${item.reporter.name}`] : []),
      ...(item.priority ? [`priority: ${item.priority.name}`] : []),
      ...(item.parent ? [`${t('work.label.parent', R)}: ${cache.getItem(item.parent)?.key ?? item.parent}${cache.getItem(item.parent) ? ` — ${cache.getItem(item.parent)!.title}` : ''}`] : []),
      ...(item.labels.length ? [`${t('work.label.labels', R)}: ${item.labels.join(', ')}`] : []),
      ...(item.area ? [`${t('work.label.area', R)}: ${item.area}`] : []),
      ...(item.iteration ? [`${t('work.label.iteration', R)}: ${item.iteration.name}${item.iteration.start ? ` (${item.iteration.start.slice(0, 10)} → ${item.iteration.end?.slice(0, 10) ?? '?'})` : ''}`] : []),
      ...(item.estimate ? [`${t('work.label.estimate', R)}: ${item.estimate.value} ${item.estimate.unit}`] : []),
      `created ${when(item.created)} · ${t('work.label.updated', R).toLowerCase()} ${when(item.updated)}${item.resolved ? ` · resolved ${when(item.resolved)}` : ''}`,
    ];
    const children = cache.listItems({ parent: item.id });
    if (children.length) lines.push(`children: ${children.map((ch) => `${ch.key} (${stateWord(ch.state.category, R)})`).join(' · ')}`);
    if (item.links.length) lines.push(`tracker links: ${item.links.map((l) => `${l.native} ${cache.getItem(l.target)?.key ?? l.target}`).join(' · ')}`);
    lines.push('', '## description', item.body?.text?.trim() || '(no description)');
    lines.push('', `## ${t('work.label.comments', R).toLowerCase()} — ${countedLine([c.comments], { zeroes: true })}`);
    for (const cm of item.comments) lines.push(`- ${when(cm.created)} · ${cm.author.name}${cm.updated && cm.updated !== cm.created ? ` (edited ${when(cm.updated)})` : ''}: ${cm.body.text.trim().replace(/\n+/g, ' ⏎ ')}`);
    lines.push('', `## ${t('work.label.history', R).toLowerCase()} — ${countedLine([c.changes], { zeroes: true })}`);
    for (const h of item.history) lines.push(`- ${when(h.at)}${h.by ? ` · ${h.by.name}` : ''} · ${h.field}: ${h.from ?? '∅'} → ${h.to ?? '∅'}`);
    lines.push('', `## in the code — ${countedLine([c.links], { zeroes: true })}`);
    if (!links.length) lines.push(t('work.noLinks', R));
    for (const l of links) lines.push(`- ${nodeName(l.node)} — ${LINK_VIA_WORDS[l.via] ?? l.via} (${l.tier}${l.sha ? ` · ${l.sha.slice(0, 7)}` : ''}${l.detail ? ` · ${l.detail}` : ''}) \`${l.node}\``);
    const commits = commitsOf(item);
    lines.push('', '## commits that name it');
    let nCommits = 0;
    if (typeof commits === 'string') lines.push(commits);
    else {
      nCommits = commits.length;
      const cc = commitsCounted(commits.length);
      const touched = touchedCounted(commits.flatMap((x) => x.nodes ?? []));
      lines.push(cc ? countedLine([cc, touched], { zeroes: true }) : `${commits.length} commit(s)`);
      for (const cm of commits.slice(0, 20)) {
        lines.push(`- ${cm.sha.slice(0, 10)} · ${when(cm.at)} · ${cm.author} · ${cm.subject} — ${cm.vias.map((v) => COMMIT_VIA_WORDS[v] ?? v).join(', ')}${cm.refs.length ? ` (${cm.refs.join(', ')})` : ''} · ${cm.repo}`);
        if (cm.files.length) lines.push(`    files: ${cm.files.slice(0, 8).map((f) => `${f.status} ${f.path}`).join(' · ')}${cm.files.length > 8 ? ` · +${cm.files.length - 8} more` : ''}`);
        if (cm.nodes === null) lines.push('    touched nodes: not computed (the source root is not a git checkout here)');
        else lines.push(`    touched nodes: ${cm.nodes.length ? kindsText(cm.nodes) : 'none in this graph (the hunks fall outside every indexed definition)'}${cm.nodesFrom === 'diff-now' ? ' — computed now from the diff' : ''}`);
      }
      if (commits.length > 20) lines.push(`… +${commits.length - 20} more — work_changes lists them all`);
    }
    const fs = findingsOf(cache, item, nCommits);
    if (fs?.length) lines.push('', '## where the tracker and the code disagree', ...findingLines(fs));
    lines.push('', `work_changes ${item.key} for the impact of those commits per hop${cfg?.mode === 'edit' ? ' · writes: see graph_overview for the work_* tools this server grants' : ''}`);
    return lines.join('\n');
  })));

  server.registerTool('work_links', {
    title: 'Work items on a node or a flow',
    description: 'The reverse question: given a graph node id, which work items track it and how each link is known (declared on a flow or screen, or a commit / branch that names the item changed it); given a flow id, the items on the flow and its screens, their count by state category, and the findings where the tracker and the code disagree (done but not built, to do but already committed). Use before changing a part of the system, to see whose story it belongs to and whether that story is still open.',
    inputSchema: {
      node_id: z.string().describe('a node id (any kind) or a flow id'),
    },
  }, async ({ node_id }) => text(await withCache((cache, srcs) => {
    const n = ctx.index().byId.get(node_id);
    if (!n) return `no node ${node_id} in this graph — search_graph finds its id`;
    const isFlow = n.kind === 'flow';
    const tracking = [...itemsTracking(cache, isFlow ? flowNodes(node_id) : [node_id]).values()];
    const items = tracking.map((x) => x.item);
    const involved = [...new Set(items.map((i) => i.source))];
    const lines = [
      ...srcs.filter((s) => !involved.length || involved.includes(s.id)).map((s) => freshLine(cache, s)),
      `# ${nodeName(node_id)}`,
      countedLine([itemsByState(items, isFlow ? 'journey.scopeAll' : 'count.scope.node', isFlow ? 'graph tracks edges into the flow and the screens it renders · work.db' : 'graph tracks edges into the node · work.db')], { zeroes: true }),
    ];
    if (!items.length) lines.push(`no work item tracks it — links come from \`work: [KEY]\` in screens.json, \`@work KEY\` in a doc comment, or a commit that names a key and changes it`);
    const counts = commitCounts();
    for (const x of tracking) {
      lines.push(itemRow(cache, x.item, counts));
      lines.push(`    ${LINK_VIA_WORDS[x.via] ?? x.via}${x.node !== node_id ? ` · on ${nodeName(x.node)}` : ''}`);
    }
    if (isFlow) {
      const fs = tracking.flatMap((x) => findingsOf(cache, x.item, commitCountOf(counts, x.item) ?? 0) ?? []);
      if (fs.length) lines.push('', '## where the tracker and the code disagree', ...findingLines(fs));
      else if (!coreFindings) lines.push('', 'findings: not computed by this build');
    }
    return lines.join('\n');
  })));

  server.registerTool('work_changes', {
    title: 'What a work item changed in the code',
    description: 'What a work item changed: the commits that name its key (in a subject, a merge subject, a branch or a tracker link), and per commit the nodes its hunks touched by kind, then the impact of those nodes per hop — what uses them one edge away, two, … — counted once per hop and never summed, a floor when anything was cut. Or with sha, one commit\'s diff text read with git from its source root (confined to that root, capped with the cap stated). Use to review what was really done for a story, to find the tests and callers a story\'s change reaches, or to read one commit\'s patch.',
    inputSchema: {
      key: z.string().optional().describe('the item key (INV-5) or node id — or pass sha'),
      sha: z.string().optional().describe('a commit sha (≥7 hex): return its diff text'),
      repo: z.string().optional().describe('the source/repo the sha is in (default: every recorded root is tried)'),
      source: z.string().optional().describe('work source id, when the key is in more than one'),
      hops: z.number().int().min(1).max(5).optional().describe('impact hops, default 2'),
    },
  }, async ({ key, sha, repo, source, hops }) => {
    if (sha) return text(diffOf(sha, repo));
    if (!key) return text('work_changes needs key (a work item) or sha (a commit).');
    return text(await withCache((cache, srcs) => {
      const item = findItem(cache, key, source);
      if (typeof item === 'string') return item;
      const cfg = srcs.find((s) => s.id === item.source);
      const lines = [cfg ? freshLine(cache, cfg) : `${item.source} (no longer configured)`, `# ${item.key} · ${stateText(item)} · ${item.title}`];
      const commits = commitsOf(item);
      if (typeof commits === 'string') { lines.push(commits); return lines.join('\n'); }
      const cc = commitsCounted(commits.length);
      const all = [...new Set(commits.flatMap((c) => c.nodes ?? []))];
      lines.push(cc ? countedLine([cc, touchedCounted(all)], { zeroes: true }) : `${commits.length} commit(s)`);
      if (!commits.length) { lines.push(`no commit on the history spine names ${item.key}`); return lines.join('\n'); }
      const index = ctx.index();
      const budget = hops ?? 2;
      for (const c of commits) {
        lines.push('', `## ${c.sha.slice(0, 10)} · ${when(c.at)} · ${c.author} · ${c.subject}`, `${c.vias.map((v) => COMMIT_VIA_WORDS[v] ?? v).join(', ')} · ${c.repo}${c.files.length ? ` · ${c.files.length} file(s)` : ''}`);
        if (c.nodes === null) { lines.push('touched nodes: not computed (no git checkout at the source root)'); continue; }
        const seeds = c.nodes.filter((id) => index.byId.has(id));
        if (!seeds.length) { lines.push('touched nodes: none in this graph'); continue; }
        lines.push(`touched: ${kindsText(seeds)}${c.nodesFrom === 'diff-now' ? ' (computed now from the diff)' : ''}`);
        for (const id of seeds.slice(0, 12)) lines.push(`  ${nodeName(id)} \`${id}\``);
        if (seeds.length > 12) lines.push(`  … +${seeds.length - 12} more`);
        lines.push(...impactLines(index, seeds, budget));
      }
      lines.push('', 'impact_of <node> for one node\'s dependents with call sites and tests · work_changes sha:<sha> for one commit\'s patch');
      return lines.join('\n');
    }));
  });

  /** Per hop, what uses these seeds — each dependent once at its nearest hop, the seeds themselves excluded, never summed across hops. */
  function impactLines(index: GraphIndex, seeds: string[], budget: number): string[] {
    const hopOf = new Map<string, number>();
    const seedSet = new Set(seeds);
    let floor = false;
    const reports: ImpactReport[] = [];
    for (const id of seeds.slice(0, 40)) {
      try { reports.push(impactOf(index, id, { hops: budget, direction: 'upstream', perHopCap: 200, tests: false, flows: false })); } catch { /* a seed the graph lost */ }
    }
    for (const r of reports) {
      if (r.bound === 'floor') floor = true;
      for (const h of r.hops) for (const n of h.nodes) {
        if (seedSet.has(n.nodeId)) continue;
        const had = hopOf.get(n.nodeId);
        if (had === undefined || h.hop < had) hopOf.set(n.nodeId, h.hop);
      }
    }
    const per: string[] = [];
    for (let h = 1; h <= budget; h++) {
      const ids = [...hopOf.entries()].filter(([, x]) => x === h).map(([id]) => id);
      per.push(`hop ${h}: ${ids.length}${ids.length ? ` (${kindsText(ids)})` : ''}`);
    }
    return [
      `impact, upstream — what uses the touched nodes, each once at its nearest hop, not summed: ${per.join(' · ')}${floor ? ' — a floor: something was cut or capped (impact_of on a node says what)' : ''}${seeds.length > 40 ? ` — from the first 40 of ${seeds.length} touched nodes` : ''}`,
    ];
  }

  const DIFF_CAP_LINES = 400;
  const DIFF_CAP_CHARS = 40_000;
  /** One commit's patch, read with git from a recorded source root, confined to it. */
  function diffOf(sha: string, repo?: string): string {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return `sha expects 7–40 hex characters (got "${sha}")`;
    const roots = Object.entries(ctx.roots()).filter(([r, root]) => r && (!repo || r === repo) && existsSync(root));
    if (!roots.length) return repo ? `no recorded source root for repo ${repo} on this machine` : 'the graph records no source root on this machine to read a commit from';
    for (const [r, root] of roots) {
      const has = spawnSync('git', ['-C', root, 'cat-file', '-e', `${sha}^{commit}`], { encoding: 'utf8' });
      if (has.status !== 0) continue;
      // --relative + `-- .`: only what changed inside this source root, paths relative to it
      const show = spawnSync('git', ['-C', root, 'show', '--no-color', '--relative', '--stat', '--patch', '--format=commit %H%nauthor %an%ndate %aI%n%n    %s%n', sha, '--', '.'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      if (show.status !== 0) return `git could not show ${sha} in ${r}: ${show.stderr.trim().split('\n')[0]}`;
      let out = show.stdout;
      const allLines = out.split('\n');
      let capped = '';
      if (allLines.length > DIFF_CAP_LINES || out.length > DIFF_CAP_CHARS) {
        out = allLines.slice(0, DIFF_CAP_LINES).join('\n').slice(0, DIFF_CAP_CHARS);
        capped = `\n… capped at ${DIFF_CAP_LINES} lines / ${DIFF_CAP_CHARS} characters of ${allLines.length} lines — read the rest with git show ${sha.slice(0, 10)} in ${root}`;
      }
      return `${r} · ${root} (only paths inside this source root)\n${out}${capped}`;
    }
    return `no commit ${sha} in ${roots.map(([r]) => r).join(', ')}`;
  }

  // ── work_sync ──────────────────────────────────────────────────────────────

  server.registerTool('work_sync', {
    title: 'Sync work items from the tracker',
    description: 'Pull the work sources (Jira, Azure DevOps, the recorded fixture) into the local copy the work_* tools read: one source by id, or every enabled source. Reports per source what the tracker sent, what changed and what is gone, the item count by state category after the sync, and the freshness sentence — or the failure in words (unreachable, credential expired) while the previous copy stays readable. Use when graph_overview says a work source is stale, or before reading items another person just changed. Graph links to the items refresh on the workspace server\'s next sync.',
    inputSchema: {
      source: z.string().optional().describe('one work source id (default: every enabled work source)'),
    },
  }, async ({ source }) => {
    return text(await withCache(async (cache, all) => {
      const srcs = source ? all.filter((s) => s.id === source) : all;
      if (!srcs.length) return t('sys.work.unknownSource', R).replace('{source}', source ?? '');
      const lines: string[] = [];
      for (const cfg of srcs) {
        const provider = providerFor(cfg.provider);
        if (!provider) { lines.push(`${t('sys.work.unknownProvider', R).replace('{provider}', cfg.provider).replace('{source}', cfg.id)} (registered: ${listProviders().join(', ')})`); continue; }
        const r = await syncSource(cfg, provider, cache);
        const c = syncCounted(r);
        lines.push(`${cfg.id} · sync ${r.syncNo} · ${freshnessText(freshness(cache.getSource(cfg.id)), R)}`);
        if (r.error) lines.push(`  ⚠ ${t('sys.work.syncFailed', R).replace('{source}', cfg.id).replace('{error}', r.error)} — the previous copy is still what the work_* tools read`);
        lines.push(`  ${countedLine([c.pulled, c.changed, c.gone], { zeroes: true })}`);
        lines.push(`  ${countedLine([workItemsCounted(cache.listItems({ source: cfg.id }), 'count.scope.workSource')], { zeroes: true })}`);
      }
      return lines.join('\n');
    }));
  });

  // ── write tools, registered only when granted ──────────────────────────────

  /** Actions some edit-mode source grants to principal agent, with the sources granting each. */
  const granted = new Map<WorkAction, string[]>();
  for (const s of sources()) {
    if (s.mode !== 'edit') continue;
    for (const g of s.permissions?.grants ?? []) {
      if (!(g.principals ?? ['human']).includes('agent')) continue;
      for (const a of g.actions) {
        if (!WRITE_TOOL[a]) continue;
        const list = granted.get(a) ?? [];
        if (!list.includes(s.id)) list.push(s.id);
        granted.set(a, list);
      }
    }
  }

  const verdictLines = (v?: Verdicts) => (v ? [
    `policy: ${v.policy.allowed ? 'yes' : 'no'} — ${v.policy.reason}`,
    `tracker: ${v.tracker.allowed ? 'yes' : 'no'} — ${v.tracker.reason}`,
    `credential: ${v.credential.allowed ? 'yes' : 'no'} — ${v.credential.reason}`,
  ] : ['verdicts: not reached']);

  const briefItem = (i: WorkItem) => [
    `${i.key} · ${stateText(i)} · ${i.title}`,
    `${t('work.label.assignee', R)}: ${i.assignee?.name ?? t('work.label.unassigned', R)} · labels: ${i.labels.join(', ') || '—'} · revision ${i.revision} · updated ${when(i.updated)}`,
    ...(i.comments.length ? [`last comment: ${i.comments.at(-1)!.author.name}: ${i.comments.at(-1)!.body.text.trim().slice(0, 300)}`] : []),
  ];

  function outcomeLines(tool: string, o: ApplyOutcome, cachedBefore: WorkItem): string[] {
    const head = `${tool} ${cachedBefore.key} · intent ${o.intent.id}`;
    const v = verdictLines(o.verdicts);
    switch (o.state) {
      case 'confirmed':
        return [head, ...v, 'outcome: applied — the item as the tracker now has it:', ...(o.item ? briefItem(o.item).map((l) => `  ${l}`) : ['  (the tracker did not return the item after the write — work_sync re-reads it)'])];
      case 'queued':
        return [head, ...v, 'outcome: pending — waiting for a person to confirm in the HUD — nothing was written. The request is in the outbox; the tracker is not touched until someone presses apply.'];
      case 'conflict':
        return [head, ...v,
          `outcome: conflict — the item changed on the tracker since it was read (the request was made against revision ${o.intent.baseRevision ?? '?'}); nothing was written.`,
          'the tracker\'s current version:', ...(o.item ? briefItem(o.item).map((l) => `  ${l}`) : ['  (not returned)']),
          `your request: ${o.intent.action} ${JSON.stringify(o.intent.payload)}`,
          'read it again (work_item) and ask again if the request still stands.'];
      case 'denied':
        return [head, ...v, 'outcome: denied — nothing was written; every "no" above is a reason.'];
      default:
        if (o.result?.conflict) {
          return [head, ...v, `outcome: conflict — the tracker refused the write on concurrency (${o.result.error ?? 'its version moved'}); nothing was written. Read it again (work_item) and ask again if the request still stands.`];
        }
        return [head, ...v, `outcome: failed — ${o.reason ?? o.result?.error ?? 'unknown'}; nothing was written.`];
    }
  }

  async function write(tool: string, action: WorkAction, key: string, source: string | undefined, payload: IntentPayload): Promise<string> {
    return withCache(async (cache, srcs) => {
      const item = findItem(cache, key, source);
      if (typeof item === 'string') return item;
      const cfg = srcs.find((s) => s.id === item.source);
      if (!cfg) return `${item.key} came from ${item.source}, which is no longer a configured work source`;
      const provider = providerFor(cfg.provider);
      if (!provider) return t('sys.work.unknownProvider', R).replace('{provider}', cfg.provider).replace('{source}', cfg.id);
      let session;
      try { session = await connectSource(cfg, provider); } catch (err) {
        return `${freshLine(cache, cfg)}\ncould not connect to ${cfg.id}: ${(err as Error).message} — nothing was written`;
      }
      const intent: Intent = { id: `intent-${randomUUID()}`, item: item.id, action, payload, requestedBy: { kind: 'agent', id: sessionId, tool } };
      const o = await applyIntent(intent, { cfg, provider, session, cache });
      return [freshLine(cache, cfg), ...outcomeLines(tool, o, item)].join('\n');
    });
  }

  const KEY_INPUTS = {
    key: z.string().describe('the item key (INV-5) or node id'),
    source: z.string().optional().describe('work source id, when the key is in more than one'),
  };
  const GATE_WORDS = 'Three verdicts decide it — the workspace policy, the tracker\'s own answer, the credential\'s scope — and all three are printed. Under the policy\'s confirm rule the answer is *pending*: nothing is written until a person presses apply in the HUD. A stale copy is a conflict, never an overwrite.';
  const grantedBy = (a: WorkAction) => `Granted to agents by: ${granted.get(a)!.join(', ')}.`;

  if (granted.has('comment')) {
    server.registerTool('work_comment', {
      title: 'Comment on a work item',
      description: `Add a comment to a work item on its tracker, as this agent (prefixed "via Farsight (agent)" unless the policy says attribution: none). ${GATE_WORDS} Use to tell the story's people what was built, with the node ids or commits that show it. ${grantedBy('comment')}`,
      inputSchema: { ...KEY_INPUTS, body: z.string().min(1).describe('the comment, markdown') },
    }, async ({ key, source, body }) => text(await write('work_comment', 'comment', key, source, { body })));
  }
  if (granted.has('assign')) {
    server.registerTool('work_assign', {
      title: 'Assign a work item',
      description: `Assign a work item to a person (their tracker id), or unassign it with null. ${GATE_WORDS} Use when the policy lets an agent route work, e.g. to hand a story back to its reporter. ${grantedBy('assign')}`,
      inputSchema: { ...KEY_INPUTS, assignee: z.string().nullable().describe('the person\'s tracker id (Jira accountId, ADO descriptor), or null to unassign') },
    }, async ({ key, source, assignee }) => text(await write('work_assign', 'assign', key, source, { assignee })));
  }
  if (granted.has('transition')) {
    server.registerTool('work_transition', {
      title: 'Move a work item to another state',
      description: `Move a work item to a state category (todo · in-progress · done · removed), optionally naming the tracker's own status. ${GATE_WORDS} Use to move a story once its code is in — the policy may limit which states an agent may move to. ${grantedBy('transition')}`,
      inputSchema: { ...KEY_INPUTS, to: z.enum(STATE_CATEGORIES).describe('target state category'), to_name: z.string().optional().describe('the tracker\'s status name, when the category has several') },
    }, async ({ key, source, to, to_name }) => text(await write('work_transition', 'transition', key, source, { to, ...(to_name ? { toName: to_name } : {}) })));
  }
  if (granted.has('edit')) {
    server.registerTool('work_edit', {
      title: 'Edit a work item\'s fields',
      description: `Edit a work item's fields by canonical name (title, description, estimate, …) — the policy may limit which fields an agent may touch. ${GATE_WORDS} Use to correct a title or description to the as-built behaviour. ${grantedBy('edit')}`,
      inputSchema: {
        ...KEY_INPUTS,
        title: z.string().optional().describe('new title'),
        description: z.string().optional().describe('new description, markdown'),
        fields: z.record(z.unknown()).optional().describe('other canonical fields → values'),
      },
    }, async ({ key, source, title, description, fields }) => {
      const f: Record<string, unknown> = { ...(fields ?? {}), ...(title !== undefined ? { title } : {}), ...(description !== undefined ? { description } : {}) };
      if (!Object.keys(f).length) return text('work_edit needs title, description or fields.');
      return text(await write('work_edit', 'edit', key, source, { fields: f }));
    });
  }
  if (granted.has('label')) {
    server.registerTool('work_label', {
      title: 'Add or remove labels on a work item',
      description: `Add or remove labels (Jira labels, Azure DevOps tags) on a work item. ${GATE_WORDS} Use to mark a story the code shows is built, blocked or needs a look. ${grantedBy('label')}`,
      inputSchema: { ...KEY_INPUTS, add: z.array(z.string()).optional().describe('labels to add'), remove: z.array(z.string()).optional().describe('labels to remove') },
    }, async ({ key, source, add, remove }) => {
      if (!add?.length && !remove?.length) return text('work_label needs add or remove.');
      return text(await write('work_label', 'label', key, source, { ...(add ? { add } : {}), ...(remove ? { remove } : {}) }));
    });
  }
  if (granted.has('link')) {
    const kinds = ['parent', 'child', 'relates', 'blocks', 'blocked-by', 'duplicates', 'other'] as const satisfies readonly LinkKind[];
    server.registerTool('work_link', {
      title: 'Link a work item to another',
      description: `Link a work item to another item on the same tracker (relates, blocks, blocked-by, duplicates, parent, child). ${GATE_WORDS} Use to record a dependency the code shows between two stories. ${grantedBy('link')}`,
      inputSchema: { ...KEY_INPUTS, target: z.string().describe('the other item\'s key'), kind: z.enum(kinds).describe('how they relate') },
    }, async ({ key, source, target, kind }) => text(await write('work_link', 'link', key, source, { target, kind })));
  }

  const writeTools = [...granted.keys()].map((a) => WRITE_TOOL[a]!).sort();

  // ── graph_overview ─────────────────────────────────────────────────────────

  function overviewLines(): string[] {
    const srcs = sources();
    if (!srcs.length) return [];
    let cache: WorkCache;
    try { cache = new WorkCache(workDbPath(workspace)); } catch (err) {
      return ['', '## work items', err instanceof WorkCacheUnavailable ? err.message : `work-item cache could not be opened: ${(err as Error).message}`];
    }
    try {
      const out = ['', '## work items'];
      for (const s of srcs) {
        out.push(freshLine(cache, s));
        out.push(`  ${countedLine([workItemsCounted(cache.listItems({ source: s.id }), 'count.scope.workSource')], { zeroes: true })}`);
      }
      out.push(writeTools.length
        ? `agent writes: ${writeTools.join(', ')} — each prints three verdicts and may answer pending until a person confirms`
        : 'agent writes: none — no work source grants an agent any action, so no work_* write tool is registered');
      out.push('work_items lists them · work_item reads one · work_links from a node or flow · work_changes for what a story changed');
      return out;
    } finally {
      try { cache.close(); } catch { /* closed */ }
    }
  }

  const pollMs = (poll?: string): number => {
    const m = /^(\d+)\s*([smhd])$/.exec(poll ?? '');
    if (!m) return 3600_000;
    return Number(m[1]) * { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  };

  function currencyFindings(): string[] {
    const srcs = sources();
    if (!srcs.length) return [];
    let cache: WorkCache;
    try { cache = new WorkCache(workDbPath(workspace)); } catch { return []; }
    try {
      const out: string[] = [];
      for (const s of srcs) {
        const f = freshness(cache.getSource(s.id));
        // stale: never synced, failing, or older than twice the source's poll (an hour when none is set)
        if (f.state !== 'synced' || (f.ago ?? 0) > 2 * pollMs(s.poll)) {
          out.push(`work source ${s.id}: ${freshnessText(f, R)} — call work_sync${f.state === 'credential-expired' ? ' after renewing the credential' : ''}`);
        }
      }
      return out;
    } finally {
      try { cache.close(); } catch { /* closed */ }
    }
  }

  return { overviewLines, currencyFindings, writeTools };
}

/** The action set, re-exported for the tests' pin. */
export const WORK_WRITE_TOOLS = Object.fromEntries(WORK_ACTIONS.filter((a) => WRITE_TOOL[a]).map((a) => [a, WRITE_TOOL[a]!])) as Record<string, string>;
