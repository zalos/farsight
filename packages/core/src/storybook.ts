/**
 * Stories — a component shown on its own (docs/ARCHITECTURE.md ADR 9).
 *
 * Two halves, one set of ids. The stories pass (parsers/src/stories/) reads
 * `*.stories.*` files at ingest and puts a `StoryRef` on the component each
 * story renders, with the story id computed here the way Storybook computes
 * it. A running Storybook is only the renderer: `storybookLive()` probes the
 * URL the graph recorded, reads `/index.json` (index v5), and maps every entry
 * onto a node — by that same story id first, then by the entry's
 * `componentPath` resolved against the Storybook's root, then by its title —
 * and names every entry it could not place rather than guessing.
 *
 * Farsight never starts a Storybook. The viewer only frames a URL the graph
 * recorded (farsight.config.json, or a port read off the repo's scripts).
 */
import type { GraphNode, StoryRef, StorybookRef, StoriesMeta } from './graph.js';
import type { GraphIndex } from './query.js';
import { counted, type Counted } from './counts.js';

// ── Storybook's own id rules (@storybook/csf `sanitize`, `toId`, `storyNameFromExport`) ──

/** Storybook's `sanitize`: lower-case, punctuation and spaces to `-`, collapsed, trimmed. */
export function sanitizeStoryPart(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ ’–—―′¿'`~!@#$%^&*()_|+\-=?;:'",.<>{}[\]\\/]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/** Storybook's `storyNameFromExport`: `AsLink` → `As Link`, `with_icon` → `With Icon`. */
export function storyNameFromExport(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\./g, ' ')
    .replace(/([^\n])([A-Z])([a-z])/g, (_m, a: string, b: string, c: string) => `${a} ${b}${c}`)
    .replace(/([a-z])([A-Z])/g, (_m, a: string, b: string) => `${a} ${b}`)
    .replace(/([a-z])([0-9])/gi, (_m, a: string, b: string) => `${a} ${b}`)
    .replace(/([0-9])([a-z])/gi, (_m, a: string, b: string) => `${a} ${b}`)
    .replace(/(\s|^)(\w)/g, (_m, a: string, b: string) => `${a}${b.toUpperCase()}`)
    .replace(/ +/g, ' ')
    .trim();
}

/** The story id Storybook gives `export const <exportName>` under `title` (or a meta `id`). */
export function storyIdOf(titleOrMetaId: string, exportName: string): string {
  return `${sanitizeStoryPart(titleOrMetaId)}--${sanitizeStoryPart(storyNameFromExport(exportName))}`;
}

/**
 * The title Storybook derives when a file's default export names none: the path
 * under the stories glob's base, without the `.stories.*` extension, a trailing
 * `/index` dropped, and a last segment that repeats its folder dropped.
 */
export function autoTitleOf(fileUnderBase: string, prefix = ''): string {
  let p = fileUnderBase.replace(/\\/g, '/').replace(/\.(stories|story)\.[cm]?[jt]sx?$/, '').replace(/\.mdx$/, '');
  p = p.replace(/\/index$/, '');
  const parts = [...(prefix ? prefix.split('/') : []), ...p.split('/')].filter(Boolean);
  if (parts.length > 1 && parts[parts.length - 1]!.toLowerCase() === parts[parts.length - 2]!.toLowerCase()) parts.pop();
  return parts.join('/');
}

/** `http://localhost:6006/iframe.html?id=<id>&viewMode=story` — the one page the viewer frames. */
export function storyFrameUrl(base: string, id: string, viewMode: 'story' | 'docs' = 'story'): string {
  return `${base.replace(/\/+$/, '')}/iframe.html?id=${encodeURIComponent(id)}&viewMode=${viewMode}`;
}

/** Only http(s) origins on a loopback or named host are ever framed or fetched. */
export function isStorybookUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ── the running Storybook's index ──────────────────────────────────────────

/** One entry of Storybook's `/index.json` (index v5). */
export interface StorybookIndexEntry {
  id: string;
  title: string;
  name: string;
  type: 'story' | 'docs';
  importPath?: string;
  /** relative to the Storybook's root (`./src/lib/button.tsx`) — absent on docs entries */
  componentPath?: string;
  exportName?: string;
  tags?: string[];
}

/** How an index entry met a node, strongest first. */
export type StoryResolutionVia = 'story-id' | 'component-path' | 'component-path+title' | 'title' | 'docs-title';

export interface StoryEntryResolution {
  id: string;
  title: string;
  name: string;
  type: 'story' | 'docs';
  nodeId?: string;
  via?: StoryResolutionVia;
  /** unresolved only: why */
  reason?: 'no-node-at-path' | 'ambiguous' | 'no-match' | 'docs-no-story';
  /** the repo path the entry's componentPath resolved to */
  path?: string;
  /** ambiguous only: the nodes it could have been */
  candidates?: string[];
}

/** One story as every consumer draws it: the graph's StoryRef and/or the running index's entry. */
export interface LiveStory {
  id: string;
  name: string;
  title?: string;
  type: 'story' | 'docs';
  repo: string;
  /** the Storybook's config dir — which catalogue it belongs to */
  storybook?: string;
  /** the author's sentence (graph StoryRef docs) */
  docs?: string;
  file?: string;
  line?: number;
  /** read from the story file at ingest */
  inGraph: boolean;
  /** listed by the running Storybook's index right now */
  live: boolean;
  /** the iframe page to frame — present only when the Storybook was reached and lists the story */
  frame?: string;
  via?: StoryResolutionVia;
}

export interface StorybookStatus {
  repo: string;
  configDir: string;
  root: string;
  name?: string;
  url?: string;
  urlFrom?: StorybookRef['urlFrom'];
  command?: string;
  source: StorybookRef['source'];
  reachable: boolean;
  /** why it was not reached: refused / timeout / http <status> / not an index / no url */
  error?: string;
  checkedAt: string;
  /** the index's counts — present only when reached */
  counts?: { stories: number; docs: number; resolved: number; unresolved: number; via: Partial<Record<StoryResolutionVia, number>> };
  /** `resolved` of `stories + docs`, typed — the breakdown says how many of each were matched (docs/COUNTS.md) */
  counted?: { matched: Counted };
  unresolved?: StoryEntryResolution[];
  /** stories the graph read from files that this running index does not list (renamed since the ingest, or outside its globs) */
  notListed?: string[];
  /** stories the stories pass read, for this Storybook */
  inGraph: number;
}

export interface StoriesAnswer {
  storybooks: StorybookStatus[];
  /** node id → its stories, graph and live merged, in file order then index order */
  byNode: Record<string, LiveStory[]>;
}

/** The Storybooks a graph recorded, per repo, with any per-source URL override applied. */
export function storybooksOf(
  meta: Record<string, StoriesMeta> | undefined,
  overrides: Record<string, { url?: string; command?: string }> = {},
): { repo: string; ref: StorybookRef }[] {
  const out: { repo: string; ref: StorybookRef }[] = [];
  for (const [repo, m] of Object.entries(meta ?? {}).sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const ref of m.storybooks ?? []) {
      const o = overrides[repo];
      out.push({ repo, ref: o?.url ? { ...ref, url: o.url, urlFrom: 'config', ...(o.command ? { command: o.command } : {}) } : ref });
    }
  }
  return out;
}

type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const PROBE_CACHE = new Map<string, { at: number; result: ProbeResult }>();
const PROBE_TTL_MS = 3000;

export interface ProbeResult {
  reachable: boolean;
  entries?: StorybookIndexEntry[];
  error?: string;
  checkedAt: string;
}

/**
 * Read a running Storybook's `/index.json`. Fail-soft: a refused connection, a
 * timeout, a non-200 or a body that is not an index each come back as
 * `reachable: false` with the reason — never a throw. Cached for a few seconds
 * so an inspector click does not re-read a 200 KB index.
 */
export async function probeStorybook(url: string, opts: { timeoutMs?: number; fresh?: boolean; fetcher?: Fetcher } = {}): Promise<ProbeResult> {
  const now = Date.now();
  const hit = PROBE_CACHE.get(url);
  if (!opts.fresh && hit && now - hit.at < PROBE_TTL_MS) return hit.result;
  const checkedAt = new Date(now).toISOString();
  let result: ProbeResult;
  if (!isStorybookUrl(url)) {
    result = { reachable: false, error: 'not an http(s) url', checkedAt };
  } else {
    const f: Fetcher = opts.fetcher ?? (globalThis.fetch as unknown as Fetcher);
    try {
      const res = await f(`${url.replace(/\/+$/, '')}/index.json`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 1500) });
      if (!res.ok) result = { reachable: false, error: `http ${res.status}`, checkedAt };
      else {
        const doc = (await res.json()) as { entries?: Record<string, StorybookIndexEntry>; stories?: Record<string, StorybookIndexEntry> };
        const entries = doc?.entries ?? doc?.stories;
        result = entries && typeof entries === 'object'
          ? { reachable: true, entries: Object.values(entries).filter((e) => e && typeof e.id === 'string'), checkedAt }
          : { reachable: false, error: 'not a Storybook index', checkedAt };
      }
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string }; message?: string };
      const why = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout'
        : e?.cause?.code === 'ECONNREFUSED' ? 'refused' : (e?.cause?.code ?? e?.message ?? 'unreachable');
      result = { reachable: false, error: String(why), checkedAt };
    }
  }
  PROBE_CACHE.set(url, { at: now, result });
  return result;
}

const STORY_KINDS = new Set(['component', 'page']);

const leafOf = (title: string): string => (title.split('/').pop() ?? title).replace(/\s+/g, '').toLowerCase();

/** posix `join` + `normalize` for repo-relative paths (core stays free of node:path semantics per platform). */
export function joinRepoPath(root: string, rel: string): string {
  const parts: string[] = [];
  for (const seg of `${root}/${rel}`.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Map a running index onto graph nodes. Pure: the caller hands it the entries,
 * the Storybook's root and the repo's nodes.
 *
 * 1. `story-id` — a StoryRef the stories pass read carries the same id.
 * 2. `component-path` — the entry's componentPath, joined to the Storybook's
 *    root, is a file holding exactly one component; `component-path+title` —
 *    it holds several and exactly one is named like the title's last segment.
 * 3. `title` — no path to go on: exactly one component in the repo is named
 *    like the title's last segment.
 * Docs entries carry no componentPath; they go where a story of the same
 * title went (`docs-title`). Anything else is returned with its reason.
 */
export function mapStoryIndex(
  entries: StorybookIndexEntry[],
  sb: { root: string },
  repo: string,
  nodes: GraphNode[],
): StoryEntryResolution[] {
  const repoNodes = nodes.filter((n) => n.loc?.repo === repo || n.id.startsWith(`${repo}::`));
  const byStoryId = new Map<string, string>();
  for (const n of repoNodes) for (const s of n.stories ?? []) byStoryId.set(s.id, n.id);
  const atPath = new Map<string, GraphNode[]>();
  for (const n of repoNodes) {
    if (!n.loc?.path) continue;
    if (!atPath.has(n.loc.path)) atPath.set(n.loc.path, []);
    atPath.get(n.loc.path)!.push(n);
  }
  const components = repoNodes.filter((n) => STORY_KINDS.has(n.kind));

  const out: StoryEntryResolution[] = [];
  const titleNode = new Map<string, string>();
  const base = (e: StorybookIndexEntry): StoryEntryResolution => ({ id: e.id, title: e.title, name: e.name, type: e.type === 'docs' ? 'docs' : 'story' });
  for (const e of entries) {
    if (e.type === 'docs') continue;
    const r = base(e);
    const known = byStoryId.get(e.id);
    if (known) {
      Object.assign(r, { nodeId: known, via: 'story-id' });
    } else if (e.componentPath) {
      const path = joinRepoPath(sb.root, e.componentPath);
      r.path = path;
      const here = atPath.get(path) ?? [];
      const comps = here.filter((n) => STORY_KINDS.has(n.kind));
      const leaf = leafOf(e.title);
      const named = (list: GraphNode[]) => list.filter((n) => n.name.replace(/\s+/g, '').toLowerCase() === leaf);
      if (comps.length === 1) Object.assign(r, { nodeId: comps[0]!.id, via: 'component-path' });
      else if (named(comps).length === 1) Object.assign(r, { nodeId: named(comps)[0]!.id, via: 'component-path+title' });
      else if (!comps.length && named(here).length === 1) Object.assign(r, { nodeId: named(here)[0]!.id, via: 'component-path+title' });
      else if (comps.length > 1) Object.assign(r, { reason: 'ambiguous', candidates: comps.map((n) => n.id) });
      else Object.assign(r, { reason: 'no-node-at-path' });
    } else {
      const leaf = leafOf(e.title);
      const hits = components.filter((n) => n.name.replace(/\s+/g, '').toLowerCase() === leaf);
      if (hits.length === 1) Object.assign(r, { nodeId: hits[0]!.id, via: 'title' });
      else if (hits.length > 1) Object.assign(r, { reason: 'ambiguous', candidates: hits.map((n) => n.id) });
      else r.reason = 'no-match';
    }
    if (r.nodeId && !titleNode.has(e.title)) titleNode.set(e.title, r.nodeId);
    out.push(r);
  }
  for (const e of entries) {
    if (e.type !== 'docs') continue;
    const r = base(e);
    const nodeId = titleNode.get(e.title);
    if (nodeId) Object.assign(r, { nodeId, via: 'docs-title' });
    else r.reason = 'docs-no-story';
    out.push(r);
  }
  return out;
}

/**
 * The whole live answer every consumer reads (server `/api/stories`, MCP
 * `stories` + `describe_node`, CLI `farsight stories`): each Storybook the
 * graph recorded, whether it answered, how its index mapped, and every
 * component's stories with graph and live merged.
 */
export async function storybookLive(
  nodes: GraphNode[],
  meta: Record<string, StoriesMeta> | undefined,
  opts: { overrides?: Record<string, { url?: string; command?: string }>; fresh?: boolean; timeoutMs?: number; fetcher?: Fetcher; repos?: Set<string> | null } = {},
): Promise<StoriesAnswer> {
  const byNode: Record<string, LiveStory[]> = {};
  const books = storybooksOf(meta, opts.overrides).filter((b) => !opts.repos || opts.repos.has(b.repo));

  // a story no glob placed belongs to its repo's Storybook when the repo has exactly one
  const soleBook = new Map<string, string>();
  for (const [repo, m] of Object.entries(meta ?? {})) if (m.storybooks?.length === 1) soleBook.set(repo, m.storybooks[0]!.configDir);
  // the graph's own stories first: they exist whether or not anything runs
  const graphIds = new Map<string, Set<string>>(); // repo|configDir → story ids
  for (const n of nodes) {
    if (!n.stories?.length) continue;
    const repo = n.loc?.repo ?? n.id.split('::')[0]!;
    if (opts.repos && !opts.repos.has(repo)) continue;
    byNode[n.id] = n.stories.map((s: StoryRef) => {
      const book = s.storybook ?? soleBook.get(repo);
      const key = `${repo}|${book ?? ''}`;
      if (!graphIds.has(key)) graphIds.set(key, new Set());
      graphIds.get(key)!.add(s.id);
      return {
        id: s.id, name: s.name, type: 'story', repo, inGraph: true, live: false,
        ...(s.title ? { title: s.title } : {}), ...(book ? { storybook: book } : {}),
        ...(s.docs ? { docs: s.docs } : {}), file: s.file, line: s.line,
      };
    });
  }

  const storybooks: StorybookStatus[] = [];
  for (const { repo, ref } of books) {
    const inGraphIds = graphIds.get(`${repo}|${ref.configDir}`) ?? new Set<string>();
    const status: StorybookStatus = {
      repo, configDir: ref.configDir, root: ref.root, source: ref.source, reachable: false,
      checkedAt: new Date().toISOString(), inGraph: inGraphIds.size,
      ...(ref.name ? { name: ref.name } : {}), ...(ref.url ? { url: ref.url } : {}),
      ...(ref.urlFrom ? { urlFrom: ref.urlFrom } : {}), ...(ref.command ? { command: ref.command } : {}),
    };
    if (!ref.url) { status.error = 'no url'; storybooks.push(status); continue; }
    const probe = await probeStorybook(ref.url, { fresh: opts.fresh, timeoutMs: opts.timeoutMs, fetcher: opts.fetcher });
    status.checkedAt = probe.checkedAt;
    if (!probe.reachable || !probe.entries) { status.error = probe.error ?? 'unreachable'; storybooks.push(status); continue; }
    status.reachable = true;
    const resolved = mapStoryIndex(probe.entries, ref, repo, nodes);
    const via: Partial<Record<StoryResolutionVia, number>> = {};
    const listed = new Set<string>();
    for (const r of resolved) {
      listed.add(r.id);
      if (!r.nodeId || !r.via) continue;
      via[r.via] = (via[r.via] ?? 0) + 1;
      const list = (byNode[r.nodeId] ??= []);
      const have = list.find((s) => s.id === r.id);
      const frame = storyFrameUrl(ref.url, r.id, r.type === 'docs' ? 'docs' : 'story');
      if (have) Object.assign(have, { live: true, frame, via: r.via, storybook: have.storybook ?? ref.configDir });
      else list.push({ id: r.id, name: r.name, title: r.title, type: r.type, repo, storybook: ref.configDir, inGraph: false, live: true, frame, via: r.via });
    }
    const unresolved = resolved.filter((r) => !r.nodeId);
    status.counts = {
      stories: resolved.filter((r) => r.type === 'story').length,
      docs: resolved.filter((r) => r.type === 'docs').length,
      resolved: resolved.length - unresolved.length,
      unresolved: unresolved.length,
      via,
    };
    const matchedStories = resolved.filter((r) => r.nodeId && r.type === 'story').length;
    status.counted = {
      matched: counted(resolved.length - unresolved.length, 'count.unit.indexEntries', 'count.scope.storybook', 'storybookLive().storybooks[].counts.resolved', {
        of: resolved.length,
        bizUnit: 'count.unit.indexEntries',
        breakdown: [
          { key: 'stories.count', n: matchedStories },
          { key: 'count.unit.docsPages', n: resolved.length - unresolved.length - matchedStories },
        ],
      }),
    };
    status.unresolved = unresolved;
    status.notListed = [...inGraphIds].filter((id) => !listed.has(id)).sort();
    storybooks.push(status);
  }
  return { storybooks, byNode };
}

// ── the stories block's numbers (docs/COUNTS.md) ────────────────────────────

/**
 * A node's stories as typed counts. The inspector said `NONE INDEXED · No
 * story renders this component` and then drew twelve chips — the stories of
 * the parts the page renders, unlabelled — and a panel read `STORIES · 3`
 * above four tabs, the fourth a docs page (pass swarm 2026-09-25). Three
 * numbers, three names:
 *
 * - `own` — stories that render this node itself (graph and live merged).
 * - `docs` — docs pages the running Storybook lists for it: tabs, never stories.
 * - `parts` — stories of the parts it renders, up to two `renders` hops down,
 *   skipping any part tagged `plumbing` — broken down by part, named.
 *
 * `tabs = own + docs` is what the tab strip draws.
 */
export interface StoryCounts {
  own: Counted;
  docs: Counted;
  parts: Counted;
  /** the parts behind `parts`, in first-met order — the chips a surface draws */
  partIds: string[];
}

/** The parts a screen or component renders that carry stories — the rule the inspector's chips use. */
export function storyParts(index: GraphIndex, nodeId: string, hops = 2): string[] {
  const seen = new Set<string>([nodeId]);
  const out: string[] = [];
  let frontier = [nodeId];
  for (let h = 0; h < hops; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of index.out.get(id) ?? []) {
        if (e.kind !== 'renders' || seen.has(e.to)) continue;
        seen.add(e.to);
        next.push(e.to);
        const n = index.byId.get(e.to);
        if (n?.stories?.length && !n.tags?.includes('plumbing')) out.push(e.to);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * The three counts for one node. `byNode` is `storybookLive().byNode` when a
 * Storybook answered — then the live list (stories and docs pages merged with
 * the graph's) is counted; without it the graph's own stories are.
 */
export function storyCounts(index: GraphIndex, nodeId: string, byNode?: Record<string, LiveStory[]>): StoryCounts {
  const listOf = (id: string): { stories: number; docs: number } => {
    const live = byNode?.[id];
    if (live) return { stories: live.filter((x) => x.type === 'story').length, docs: live.filter((x) => x.type === 'docs').length };
    return { stories: index.byId.get(id)?.stories?.length ?? 0, docs: 0 };
  };
  const own = listOf(nodeId);
  const partIds = storyParts(index, nodeId);
  const parts = partIds.map((id) => ({ id, n: listOf(id).stories })).filter((p) => p.n > 0);
  const src = byNode ? 'storybookLive().byNode' : 'GraphNode.stories';
  return {
    own: counted(own.stories, 'stories.count', 'count.scope.component', `${src} (type story)`, { bizUnit: 'stories.count' }),
    docs: counted(own.docs, 'count.unit.docsPages', 'count.scope.component', `${src} (type docs)`, { bizUnit: 'count.unit.docsPages' }),
    parts: counted(parts.reduce((a, p) => a + p.n, 0), 'count.unit.partStories', 'count.scope.parts', `storyParts() → ${src}`, {
      bizUnit: 'count.unit.partStories',
      breakdown: parts.map((p) => {
        const n = index.byId.get(p.id);
        return { key: 'stories.count', n: p.n, label: n?.facets?.business?.label ?? n?.name ?? p.id };
      }),
    }),
    partIds: parts.map((p) => p.id),
  };
}
