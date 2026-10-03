/**
 * Work items in the graph (docs/proposals/work-items-sync.md §9).
 *
 * A work item from a tracker (a Jira issue, an Azure DevOps work item) becomes
 * a `work` node, and what it is about is reached by a `tracks` edge. Principle
 * 1 holds: the work adapter emits the same schema as every code adapter, and
 * every surface (HUD, MCP, CLI) is a fold over the same nodes and edges plus
 * the facts the work cache and the commit spine hold.
 *
 * Core does not depend on `@farsight/work` (that package depends on core), so
 * the record is read here through the structural {@link WorkItemFacts} — the
 * subset of `farsight-work v1`'s `WorkItem` the graph needs. A full WorkItem
 * satisfies it.
 *
 * How a link is known is part of the link, like every edge:
 *
 * | via | how | tier |
 * |---|---|---|
 * | `declared` | `work: [KEY]` on a flow or screen in `screens.json`, or `@work KEY` in a doc comment | HIGH |
 * | `commit` | the key is named in a commit subject or a merge subject; the commit's hunks → the nodes it changed | MEDIUM (LOW when only the file is known) |
 * | `branch` | the key is in the name of a branch that reaches the commit | MEDIUM (LOW file-only) |
 * | `url` | a tracker URL in the commit message | MEDIUM (LOW file-only) |
 */
import type { GraphEdge, GraphFragment, GraphNode, ConfidenceTier, NodeKind } from './graph.js';
import type { GraphIndex } from './query.js';
import { counted, type Counted, type CountPart, type CountScope } from './counts.js';
import { t, type Register } from './strings.js';

// ── closed sets ────────────────────────────────────────────────────────────

/** How a work item reaches a node. Closed: a surface switches on these four. */
export const WORK_LINK_VIAS = ['declared', 'commit', 'branch', 'url'] as const;
export type WorkLinkVia = typeof WORK_LINK_VIAS[number];

/** How a commit names a work item. Closed. */
export const COMMIT_KEY_VIAS = ['subject', 'branch', 'merge-subject', 'url'] as const;
export type CommitKeyVia = typeof COMMIT_KEY_VIAS[number];

/** State categories, in the order a surface lists them (farsight-work v1 STATE_CATEGORIES). */
export const WORK_STATE_ORDER = ['todo', 'in-progress', 'done', 'removed'] as const;
export type WorkStateCategory = typeof WORK_STATE_ORDER[number];

/** Type categories (farsight-work v1 WORK_TYPES). */
export const WORK_TYPE_ORDER = ['epic', 'feature', 'story', 'task', 'bug', 'other'] as const;
export type WorkTypeCategory = typeof WORK_TYPE_ORDER[number];

/** The finding kinds §9 names — where the tracker and the code disagree. Closed. */
export const WORK_FINDING_KINDS = ['done-not-built', 'todo-but-committed'] as const;
export type WorkFindingKind = typeof WORK_FINDING_KINDS[number];

// ── the record, structurally ───────────────────────────────────────────────

/** The part of a farsight-work v1 `WorkItem` the graph reads. A WorkItem is one. */
export interface WorkItemFacts {
  id: string;
  source: string;
  provider: string;
  key: string;
  url: string;
  type: { name: string; category: string };
  title: string;
  state: { name: string; category: string; since?: string };
  assignee?: { id: string; name: string };
  labels: string[];
  parent?: string;
  updated: string;
}

/** The graph node id of a work item — the same rule as farsight-work v1 `workItemId`. */
export function workNodeId(sourceId: string, key: string): string {
  return `work::${sourceId}::${key}`;
}

/** `work::<source>::<key>` → its parts, or null for any other id. */
export function parseWorkNodeId(id: string): { source: string; key: string } | null {
  const m = /^work::(.+?)::([^:]+)$/.exec(id);
  return m ? { source: m[1]!, key: m[2]! } : null;
}

/**
 * The `work` node for one item. No `loc` — a work item is not in any file.
 * The business label is the tracker's title; the key is the name (what people
 * say), and the tags carry the categories a filter reads.
 */
export function workNodeOf(item: WorkItemFacts): GraphNode {
  return {
    id: item.id || workNodeId(item.source, item.key),
    kind: 'work',
    name: item.key,
    tags: [
      'work',
      `provider:${item.provider}`,
      `state:${item.state.category}`,
      `type:${item.type.category}`,
      `source:${item.source}`,
    ],
    signature: `${item.type.name} · ${item.state.name}${item.assignee ? ` · ${item.assignee.name}` : ''}`,
    ...(item.url ? { links: [{ kind: 'see' as const, url: item.url }] } : {}),
    facets: { business: { label: item.title } },
  };
}

/** One link from a work item to a graph node, with how it is known. */
export interface WorkLinkFact {
  /** work node id */
  work: string;
  /** graph node id */
  node: string;
  via: WorkLinkVia;
  tier: ConfidenceTier;
  /** the commit that carried it (commit/branch/url) */
  sha?: string;
  /** words: where the declaration is, or which hunk / branch */
  detail?: string;
}

/** A `tracks` edge for one link. Declared links resolve by annotation; detected ones by the key. */
export function tracksEdgeOf(link: WorkLinkFact): GraphEdge {
  const declared = link.via === 'declared';
  return {
    id: `tracks|${link.work}|${link.node}`,
    kind: 'tracks',
    from: link.work,
    to: link.node,
    meta: { via: link.via, ...(link.sha ? { sha: link.sha } : {}), ...(link.detail ? { detail: link.detail } : {}) },
    resolution: {
      status: declared ? 'resolved' : 'heuristic',
      technique: declared ? 'annotation-scan' : 'work-key',
      confidence: link.tier,
    },
  };
}

const TIER_RANK: Record<ConfidenceTier, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
const VIA_RANK: Record<WorkLinkVia, number> = { declared: 4, commit: 3, branch: 2, url: 1 };

/**
 * The strongest link per (work, node) — one `tracks` edge per pair, since the
 * store keys edges by kind|from|to. A declared link beats a detected one; among
 * detected ones the higher tier wins, then the more direct via.
 */
export function strongestLinks(links: readonly WorkLinkFact[]): WorkLinkFact[] {
  const best = new Map<string, WorkLinkFact>();
  for (const l of links) {
    const k = `${l.work}|${l.node}`;
    const cur = best.get(k);
    if (!cur || TIER_RANK[l.tier] > TIER_RANK[cur.tier] || (TIER_RANK[l.tier] === TIER_RANK[cur.tier] && VIA_RANK[l.via] > VIA_RANK[cur.via])) best.set(k, l);
  }
  return [...best.values()];
}

/**
 * Write work items and their links into a fragment (the design.ts pattern):
 * a `work` node per item and a `tracks` edge per linked node. A link to a node
 * `known` does not hold is dropped and counted, never drawn to nowhere.
 * Mutates in place.
 */
export function applyWorkToFragment(
  fragment: GraphFragment,
  items: readonly WorkItemFacts[],
  links: readonly WorkLinkFact[],
  opts: { known?: (id: string) => boolean } = {},
): { nodes: number; edges: number; dropped: number } {
  const have = new Set(fragment.nodes.map((n) => n.id));
  const workIds = new Set<string>();
  let nodes = 0;
  for (const item of items) {
    const n = workNodeOf(item);
    workIds.add(n.id);
    if (have.has(n.id)) continue;
    fragment.nodes.push(n);
    have.add(n.id);
    nodes++;
  }
  const known = opts.known ?? ((id: string) => have.has(id));
  const edgeKeys = new Set(fragment.edges.map((e) => `${e.kind}|${e.from}|${e.to}`));
  let edges = 0;
  let dropped = 0;
  for (const l of strongestLinks(links)) {
    if (!workIds.has(l.work) || !known(l.node)) { dropped++; continue; }
    const e = tracksEdgeOf(l);
    const key = `${e.kind}|${e.from}|${e.to}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    fragment.edges.push(e);
    edges++;
  }
  return { nodes, edges, dropped };
}

/** A fragment holding only work nodes and their `tracks` edges (repo `work`, no meta — it carries no files). */
export function workToFragment(
  items: readonly WorkItemFacts[],
  links: readonly WorkLinkFact[],
  opts: { known?: (id: string) => boolean } = {},
): GraphFragment & { applied: { nodes: number; edges: number; dropped: number } } {
  const fragment: GraphFragment = { repo: 'work', nodes: [], edges: [] };
  const applied = applyWorkToFragment(fragment, items, links, opts);
  return { ...fragment, applied };
}

// ── key detection ──────────────────────────────────────────────────────────
// A fallback copy of what `@farsight/work` keys.ts owns; the server prefers
// that module's detector when it is present and passes it in (KeyDetector).

export interface KeyDetectOptions {
  /** Jira project keys the configured sources pull (KAN, SAM1). Empty = no Jira-shaped key is read at all. */
  projects?: readonly string[];
  /** an Azure DevOps source is configured — only then do `#123`, `AB#123` and numeric branch prefixes count */
  ado?: boolean;
}

export interface DetectedKey {
  key: string;
  provider: 'jira' | 'azure-devops';
  /** found as a key, or inside a tracker URL */
  form: 'key' | 'url';
}

/** Detect work-item keys in a piece of text. `where` changes the rules a branch name is read by. */
export type KeyDetector = (text: string, where: 'subject' | 'body' | 'branch', opts: KeyDetectOptions) => DetectedKey[];

/** Upper-case words shaped like a Jira key that are never one: SHA-256, UTF-8, ISO-8601, RFC-9110 … */
const FALSE_FRIENDS = new Set(['SHA', 'UTF', 'ISO', 'RFC', 'HTTP', 'TLS', 'SSL', 'AES', 'RSA', 'MD', 'UTC', 'GMT', 'CVE', 'ES', 'EC', 'IPV', 'X', 'WCAG', 'PEP', 'ECMA', 'NODE', 'V', 'H']);
const JIRA_URL = /https?:\/\/[^\s/]+\/browse\/([A-Z][A-Z0-9_]+-\d+)/gi;
const ADO_URL = /https?:\/\/(?:dev\.azure\.com\/[^\s/]+|[^\s/.]+\.visualstudio\.com)(?:\/[^\s/]+)*?\/_workitems\/edit\/(\d+)/gi;

export const detectWorkKeysFallback: KeyDetector = (text, where, opts) => {
  const out: DetectedKey[] = [];
  const seen = new Set<string>();
  const push = (key: string, provider: DetectedKey['provider'], form: DetectedKey['form']) => {
    const k = `${provider}|${key}|${form}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ key, provider, form });
  };
  let rest = text;
  // URLs first, and blanked out, so a key inside a URL is read once, as a URL
  for (const m of text.matchAll(JIRA_URL)) push(m[1]!.toUpperCase(), 'jira', 'url');
  if (opts.ado) for (const m of text.matchAll(ADO_URL)) push(m[1]!, 'azure-devops', 'url');
  rest = rest.replace(JIRA_URL, ' ').replace(ADO_URL, ' ');

  const projects = new Set((opts.projects ?? []).map((p) => p.toUpperCase()));
  // a branch name is usually lower case (feature/kan-3-login); the project must be configured anyway
  const caseless = where === 'branch';
  const re = caseless ? /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9_]{0,9})-(\d+)(?![0-9])/g : /(?<![A-Za-z0-9])([A-Z][A-Z0-9_]{0,9})-(\d+)(?![0-9])/g;
  for (const m of rest.matchAll(re)) {
    const project = m[1]!.toUpperCase();
    // only a configured source's project is a key: a design screen named INV-01 or a
    // SHA-256 is not a work item. A tracker never numbers an issue with a leading zero.
    if (!projects.has(project) || FALSE_FRIENDS.has(project) || m[2]!.startsWith('0')) continue;
    push(`${project}-${m[2]}`, 'jira', 'key');
  }
  if (opts.ado) {
    if (where === 'branch') {
      // users/jared/4711-fix · feature/4711_login · 4711-x
      for (const m of rest.matchAll(/(?:^|\/)(\d{1,7})(?=[-_]|$)/g)) push(m[1]!, 'azure-devops', 'key');
    } else {
      // AB#4711 (the Azure Boards convention) and a bare #4711
      for (const m of rest.matchAll(/(?<![A-Za-z0-9&])(?:AB)?#(\d{1,7})(?![0-9])/g)) push(m[1]!, 'azure-devops', 'key');
    }
  }
  return out;
};

/** A merge subject's branch: `Merge branch 'feature/KAN-1-x'` · `Merge pull request #12 from org/KAN-1-x` · `Merged PR 7: …`. */
export function mergeSubjectBranch(subject: string): string | undefined {
  const a = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject);
  if (a) return a[1];
  const b = /^Merge pull request #\d+ from (\S+)/.exec(subject);
  if (b) return b[1];
  return undefined;
}

export interface CommitKeyFact {
  key: string;
  provider: DetectedKey['provider'];
  via: CommitKeyVia;
  /** the branch it came from (via branch / merge-subject) */
  ref?: string;
}

/**
 * Every key one commit names, and how: its subject, its message body (keys
 * count as the subject does; tracker URLs as `url`), a merge subject's branch,
 * each key-bearing branch that reaches it (`branch`), and each branch a merge
 * naming it brought the commit in from (`merge-subject` — the branch's own
 * commits carry the files; the merge commit itself carries none). Deduplicated
 * on key + via.
 */
export function commitKeysOf(
  commit: { subject: string; body?: string; merge?: boolean },
  refs: readonly (string | { ref: string; via: 'branch' | 'merge' })[],
  opts: KeyDetectOptions,
  detect: KeyDetector = detectWorkKeysFallback,
): CommitKeyFact[] {
  const out: CommitKeyFact[] = [];
  const seen = new Set<string>();
  const add = (d: DetectedKey, via: CommitKeyVia, ref?: string) => {
    const v: CommitKeyVia = d.form === 'url' ? 'url' : via;
    const k = `${d.provider}|${d.key}|${v}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ key: d.key, provider: d.provider, via: v, ...(ref ? { ref } : {}) });
  };
  const mergeRef = mergeSubjectBranch(commit.subject);
  if (mergeRef) {
    // the PR number in "Merge pull request #12" is GitHub's, never a work item
    for (const d of detect(mergeRef, 'branch', opts)) add(d, 'merge-subject', mergeRef);
  } else {
    // a trailing "(#58)" is the PR number GitHub appends to a squash merge, never a work item —
    // with an Azure DevOps source configured it would otherwise read as work item 58
    for (const d of detect(commit.subject.replace(/\s*\(#\d+\)\s*$/, ''), 'subject', opts)) add(d, 'subject');
  }
  if (commit.body) for (const d of detect(commit.body, 'body', opts)) add(d, 'subject');
  for (const r of refs) {
    const ref = typeof r === 'string' ? r : r.ref;
    const via: CommitKeyVia = typeof r === 'string' || r.via === 'branch' ? 'branch' : 'merge-subject';
    for (const d of detect(ref, 'branch', opts)) add(d, via, ref);
  }
  return out;
}

// ── commit → the nodes it changed ──────────────────────────────────────────

/** Changed line ranges of one file in one commit (new-side, from `git show --unified=0`). */
export interface FileHunks {
  path: string;
  /** [from, to] inclusive, new-side lines; empty for a deletion or a binary file */
  ranges: [number, number][];
}

/** `@@ -a,b +c,d @@` headers of a unified diff → changed ranges per file (new side). */
export function hunksOfPatch(patch: string): FileHunks[] {
  const out: FileHunks[] = [];
  let cur: FileHunks | undefined;
  for (const line of patch.split('\n')) {
    const f = /^\+\+\+ (?:b\/)?(.*)$/.exec(line);
    if (f) {
      cur = f[1] === '/dev/null' ? undefined : { path: f[1]!.replace(/\t.*$/, ''), ranges: [] };
      if (cur) out.push(cur);
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && cur) {
      const from = Number(h[1]);
      const len = h[2] == null ? 1 : Number(h[2]);
      // a pure deletion (len 0) sits between from and from+1 on the new side
      cur.ranges.push(len === 0 ? [Math.max(1, from), Math.max(1, from)] : [from, from + len - 1]);
    }
  }
  return out;
}

const CODE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['function', 'class', 'component', 'page', 'route', 'table', 'queue', 'rule', 'guard', 'flag']);

/**
 * The nodes one commit's hunks changed in one file. The graph records where a
 * definition starts and not where it ends, so a changed line is credited to
 * every definition that starts inside the hunk **and** to the nearest
 * definition that starts above it (the one it most likely sits in). With no
 * ranges (a binary file, a hunk-less read) every code node of the file is
 * named, and `fileOnly` says the answer is file-granular.
 */
export function nodesTouched(
  nodes: readonly GraphNode[],
  hunks: FileHunks,
): { nodes: GraphNode[]; fileOnly: boolean } {
  const path = hunks.path.replace(/^\.\//, '');
  const inFile = nodes
    .filter((n) => n.loc && CODE_KINDS.has(n.kind) && (n.loc.path === path || n.loc.path.endsWith(`/${path}`) || path.endsWith(`/${n.loc.path}`)))
    .sort((a, b) => a.loc!.line - b.loc!.line);
  if (!inFile.length) return { nodes: [], fileOnly: false };
  if (!hunks.ranges.length) return { nodes: inFile, fileOnly: true };
  const hit = new Map<string, GraphNode>();
  for (const [from, to] of hunks.ranges) {
    let above: GraphNode | undefined;
    for (const n of inFile) {
      const line = n.loc!.line;
      if (line >= from && line <= to) hit.set(n.id, n);
      else if (line < from) above = n;
    }
    if (above) hit.set(above.id, above);
  }
  return { nodes: [...hit.values()], fileOnly: false };
}

// ── the folds the API, the MCP and the CLI print ───────────────────────────

/** A work source as a surface lists it. `freshness` is the engine's fact (§6.2); the words are the catalog's. */
export interface WorkSourceFacts {
  id: string;
  provider: string;
  mode: 'read-only' | 'edit';
  site?: string;
  org?: string;
  scope: { projects: string[]; areas?: string[] };
  capabilities?: unknown;
  freshness: { state: 'synced' | 'unreachable' | 'credential-expired' | 'never'; since?: string; ago?: number; syncNo?: number; error?: string };
  user?: { id: string; name: string };
}

/** What the cache and the commit spine know about one item beyond its record. */
export interface WorkItemJoin {
  links: readonly WorkLinkFact[];
  /** distinct commits that name it */
  commits: number;
}

// the item counts and their state parts are @farsight/work's words (one concept, one number)
const STATE_PART: Record<string, string> = {
  todo: 'count.part.workTodo',
  'in-progress': 'count.part.workInProgress',
  done: 'count.part.workDone',
  removed: 'count.part.workRemoved',
};
const TYPE_PART: Record<string, string> = {
  epic: 'work.count.type.epic', feature: 'work.count.type.feature', story: 'work.count.type.story',
  task: 'work.count.type.task', bug: 'work.count.type.bug', other: 'work.count.type.other',
};
const VIA_PART: Record<WorkLinkVia, string> = {
  declared: 'work.count.via.declared', commit: 'work.count.via.commit', branch: 'work.count.via.branch', url: 'work.count.via.url',
};

function partition<T>(list: readonly T[], keyOf: (x: T) => string, parts: Record<string, string>, order: readonly string[]): CountPart[] {
  const n = new Map<string, number>();
  for (const x of list) n.set(keyOf(x), (n.get(keyOf(x)) ?? 0) + 1);
  const out: CountPart[] = [];
  for (const k of order) if (n.get(k)) out.push({ key: parts[k]!, n: n.get(k)! });
  // a category a provider returned outside the closed set still counts, as `other`
  const stray = [...n].filter(([k]) => !order.includes(k)).reduce((a, [, v]) => a + v, 0);
  if (stray) {
    const other = out.find((p) => p.key === parts.other);
    if (other) other.n += stray; else out.push({ key: parts.other ?? parts[order[order.length - 1]!]!, n: stray });
  }
  return out;
}

/** Items counted by state category — the breakdown every work list prints. */
export function itemsByState(items: readonly WorkItemFacts[], scope: CountScope, source: string): Counted {
  return counted(items.length, 'count.unit.workItems', scope, source, {
    bizUnit: 'count.unit.workItems',
    breakdown: partition(items, (i) => i.state.category, { ...STATE_PART, other: STATE_PART.todo! }, WORK_STATE_ORDER),
  });
}

/** Items counted by type category. */
export function itemsByType(items: readonly WorkItemFacts[], scope: CountScope, source: string): Counted {
  return counted(items.length, 'count.unit.workItems', scope, source, {
    bizUnit: 'count.unit.workItems',
    breakdown: partition(items, (i) => i.type.category, TYPE_PART, WORK_TYPE_ORDER),
  });
}

/** The ItemSummary of `/api/work` (docs: scratchpad work-api.md, frozen with Lane E/F). */
export interface WorkItemSummary {
  id: string;
  key: string;
  url: string;
  source: string;
  provider: string;
  type: { name: string; category: string };
  title: string;
  state: { name: string; category: string; since?: string };
  assignee?: { id: string; name: string };
  labels: string[];
  parent?: string;
  updated: string;
  /** tracks edges out of it, by via */
  links: Counted;
  /** distinct commits that name it */
  commits: Counted;
}

export function itemSummaryOf(item: WorkItemFacts, join: WorkItemJoin): WorkItemSummary {
  const links = strongestLinks(join.links.filter((l) => l.work === item.id));
  return {
    id: item.id, key: item.key, url: item.url, source: item.source, provider: item.provider,
    type: item.type, title: item.title, state: item.state,
    ...(item.assignee ? { assignee: { id: item.assignee.id, name: item.assignee.name } } : {}),
    labels: item.labels, ...(item.parent ? { parent: item.parent } : {}), updated: item.updated,
    links: counted(links.length, 'count.unit.workLinks', 'count.scope.workItem', 'core work-graph.ts itemSummaryOf · links', {
      bizUnit: 'count.unit.workLinks',
      breakdown: partition(links, (l) => l.via, VIA_PART as Record<string, string>, WORK_LINK_VIAS),
    }),
    commits: counted(join.commits, 'work.count.commits', 'count.scope.workItem', 'core work-graph.ts itemSummaryOf · commit_key', { bizUnit: 'work.count.commits' }),
  };
}

/** The nodes a set of commits touched, counted once each, broken down by node kind (labelled parts). */
export function touchedCount(index: GraphIndex | null, nodeIds: Iterable<string>): Counted {
  const ids = [...new Set(nodeIds)];
  const byKind = new Map<string, number>();
  for (const id of ids) {
    const kind = index?.byId.get(id)?.kind ?? 'unknown';
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }
  const breakdown: CountPart[] = [...byKind].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, n]) => ({ key: 'work.count.touchedKind', n, label: kind }));
  return counted(ids.length, 'work.count.touched', 'count.scope.workItem', 'core work-graph.ts touchedCount · commit_node', {
    bizUnit: 'work.count.touched', ...(breakdown.length ? { breakdown } : {}),
  });
}

export interface WorkFinding {
  kind: WorkFindingKind;
  /** the catalog key the text is filled from, and its values — a surface re-fills it in its own register */
  key: string;
  vars: Record<string, string | number>;
  text: string;
  provenances: { source: 'tracker' | 'code'; what: string }[];
}

function fill(key: string, vars: Record<string, string | number>, register: Register): string {
  let s = t(key, register);
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/**
 * Where the tracker and the code disagree about one item (§9), with both
 * provenances: *done, but its screen is not built* · *to do, but N commits
 * name it*.
 */
export function workFindings(item: WorkItemFacts, index: GraphIndex | null, join: WorkItemJoin, register: Register = 'professional'): WorkFinding[] {
  const out: WorkFinding[] = [];
  const tracker = { source: 'tracker' as const, what: `${item.key} · ${item.state.name} (${item.state.category})` };
  if (item.state.category === 'done' && index) {
    for (const l of strongestLinks(join.links.filter((x) => x.work === item.id))) {
      const n = index.byId.get(l.node);
      if (!n || !['page', 'component', 'flow'].includes(n.kind)) continue;
      if (n.design?.status !== 'design-only') continue;
      const screen = n.facets?.business?.label ?? n.name;
      const vars = { key: item.key, screen };
      out.push({
        kind: 'done-not-built', key: 'work.finding.doneNotBuilt', vars, text: fill('work.finding.doneNotBuilt', vars, register),
        provenances: [tracker, { source: 'code', what: `${screen} · ${n.design.id ?? n.name}: designed, no code found (${l.via})` }],
      });
    }
  }
  if (item.state.category === 'todo' && join.commits > 0) {
    const vars = { key: item.key, n: join.commits };
    const key = join.commits === 1 ? 'work.finding.todoButCommittedOne' : 'work.finding.todoButCommitted';
    out.push({
      kind: 'todo-but-committed', key, vars, text: fill(key, vars, register),
      provenances: [tracker, { source: 'code', what: `${join.commits} commit${join.commits === 1 ? ' on the history spine names' : 's on the history spine name'} ${item.key}` }],
    });
  }
  return out;
}

/** The filter `/api/work` and MCP `work_items` share. */
export interface WorkFilter {
  source?: string;
  state?: string;
  assignee?: string;
  q?: string;
  /** a flow id: items tracking the flow, its screens, or anything its journey renders */
  flow?: string;
  node?: string;
  repo?: string;
}

/** Filter items. `flow`/`node`/`repo` read the links; `q` matches key, title and labels, case-insensitively. */
export function filterWorkItems<T extends WorkItemFacts>(items: readonly T[], links: readonly WorkLinkFact[], f: WorkFilter, index: GraphIndex | null): T[] {
  const byWork = new Map<string, WorkLinkFact[]>();
  for (const l of links) byWork.set(l.work, [...(byWork.get(l.work) ?? []), l]);
  const flowNodes = f.flow && index ? flowNodeSet(index, f.flow) : null;
  const q = f.q?.toLowerCase();
  return items.filter((i) => {
    if (f.source && i.source !== f.source) return false;
    if (f.state && i.state.category !== f.state) return false;
    if (f.assignee && i.assignee?.id !== f.assignee && !i.assignee?.name.toLowerCase().includes(f.assignee.toLowerCase())) return false;
    if (q && !`${i.key} ${i.title} ${i.labels.join(' ')}`.toLowerCase().includes(q)) return false;
    const ls = byWork.get(i.id) ?? [];
    if (f.node && !ls.some((l) => l.node === f.node)) return false;
    if (flowNodes && !ls.some((l) => flowNodes.has(l.node))) return false;
    if (f.repo && !ls.some((l) => (index?.byId.get(l.node)?.loc?.repo ?? l.node.split('::')[0]) === f.repo)) return false;
    return true;
  });
}

/** A flow, the screens it renders, and those screens' own renders one level down — what "work on this flow" reaches. */
export function flowNodeSet(index: GraphIndex, flowId: string): Set<string> {
  const out = new Set<string>([flowId]);
  for (const e of index.out.get(flowId) ?? []) {
    if (e.kind !== 'renders') continue;
    out.add(e.to);
  }
  return out;
}
