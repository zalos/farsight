// Jira issue → farsight-work v1, per docs/proposals/work-items-sync.md §3.
// Every category is decided here, once, from Jira's own category fields —
// never from a status or type name, except where §3 names the name (Bug, and
// Story / Task at hierarchy level 0).
import { workItemId } from '@farsight/work';
import type {
  WorkItem, WorkType, StateCategory, Person, Link, LinkKind, Change, Comment,
} from '@farsight/work';
import { adfBody } from './adf.js';

/** Site-specific field ids, resolved by discover() or pinned in settings. */
export interface FieldMap {
  /** the Sprint field (schema.custom com.pyxis.greenhopper.jira:gh-sprint) */
  sprint?: string;
  /** the board's estimation field */
  estimate?: string;
  /** canonical name → field id, pinned by the consumer (*declared by you*) */
  declared: Record<string, string>;
}

export interface JiraUser { accountId?: string; displayName?: string; emailAddress?: string | null }
export interface JiraStatus { name?: string; id?: string; statusCategory?: { key?: string } }
export interface JiraIssueType { name?: string; id?: string; subtask?: boolean; hierarchyLevel?: number }
export interface JiraLink {
  id?: string;
  type?: { name?: string; inward?: string; outward?: string };
  inwardIssue?: { key?: string };
  outwardIssue?: { key?: string };
}
export interface JiraSprint { id?: number; name?: string; state?: string; startDate?: string; endDate?: string }
export interface JiraIssue {
  id: string;
  key: string;
  fields: Record<string, unknown> & {
    summary?: string;
    description?: unknown;
    issuetype?: JiraIssueType;
    status?: JiraStatus;
    priority?: { name?: string; id?: string } | null;
    assignee?: JiraUser | null;
    reporter?: JiraUser | null;
    labels?: string[];
    components?: { name?: string }[];
    parent?: { key?: string; id?: string } | null;
    subtasks?: { key?: string }[];
    issuelinks?: JiraLink[];
    created?: string;
    updated?: string;
    resolutiondate?: string | null;
    statuscategorychangedate?: string | null;
    project?: { key?: string };
  };
}

/** The fields pull() asks for — explicit, because search/jql defaults to `id`. */
export const BASE_FIELDS = [
  'summary', 'description', 'issuetype', 'status', 'statuscategorychangedate', 'priority',
  'assignee', 'reporter', 'labels', 'components', 'parent', 'subtasks', 'issuelinks',
  'created', 'updated', 'resolutiondate', 'project',
] as const;

export function fieldList(map: FieldMap): string[] {
  const extra = [map.sprint, map.estimate, ...Object.values(map.declared)].filter((x): x is string => !!x);
  return [...new Set([...BASE_FIELDS, ...extra])];
}

/** §3: `statusCategory.key` new → todo · indeterminate → in-progress · done → done. The only rule. */
export function stateCategory(key: string | undefined): StateCategory {
  if (key === 'done') return 'done';
  if (key === 'indeterminate') return 'in-progress';
  // 'new', and Jira's own 'undefined' ("No Category", id 1) — a status nobody categorised has not started
  return 'todo';
}

/** §3: `hierarchyLevel` (epic ≥ 1; subtask → task; Bug → bug); level 0 Story/Task by name; else other. */
export function typeCategory(t: JiraIssueType | undefined): WorkType {
  if (!t) return 'other';
  const level = typeof t.hierarchyLevel === 'number' ? t.hierarchyLevel : undefined;
  if (level !== undefined && level >= 1) return 'epic';
  if (t.subtask || (level !== undefined && level < 0)) return 'task';
  const name = (t.name ?? '').trim().toLowerCase();
  if (name === 'bug') return 'bug';
  if (name === 'story') return 'story';
  if (name === 'task') return 'task';
  return 'other';
}

export function person(u: JiraUser | null | undefined): Person | undefined {
  if (!u?.accountId) return undefined;
  const p: Person = { id: u.accountId, name: u.displayName ?? u.accountId };
  if (u.emailAddress) p.email = u.emailAddress;
  return p;
}

/** Jira timestamps carry the user's offset (`2026-09-30T18:32:46.656-0400`) or are epoch ms; the contract is ISO UTC. */
export function isoUtc(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * A link type's direction → the closed kind. `outwardIssue` present on an issue
 * means *this issue [outward phrase] target* (measured: a Blocks link read on
 * the blocker carries `outwardIssue`, and the changelog says *blocks*).
 */
export function linkKind(typeName: string | undefined, direction: 'outward' | 'inward'): LinkKind {
  const n = (typeName ?? '').trim().toLowerCase();
  if (n === 'blocks') return direction === 'outward' ? 'blocks' : 'blocked-by';
  if (n === 'duplicate') return direction === 'outward' ? 'duplicates' : 'other';
  if (n === 'relates') return 'relates';
  return 'other';
}

/** The sprint an item is in now: the active one, else the last listed. */
export function currentSprint(v: unknown): WorkItem['iteration'] {
  if (!Array.isArray(v) || !v.length) return undefined;
  const sprints = v as JiraSprint[];
  const s = sprints.find((x) => x.state === 'active') ?? sprints.at(-1)!;
  if (!s?.name) return undefined;
  const out: NonNullable<WorkItem['iteration']> = { name: s.name };
  const start = isoUtc(s.startDate);
  const end = isoUtc(s.endDate);
  if (start) out.start = start;
  if (end) out.end = end;
  return out;
}

export interface MapContext {
  sourceId: string;
  site: string;
  /** project keys in scope — a link target inside them is a WorkItem id, else the Jira key */
  projects: string[];
  fields: FieldMap;
}

function targetOf(ctx: MapContext, key: string): string {
  const project = key.split('-')[0] ?? '';
  return ctx.projects.includes(project) ? workItemId(ctx.sourceId, key) : key;
}

export function mapIssue(issue: JiraIssue, ctx: MapContext): WorkItem {
  const f = issue.fields ?? {};
  const links: Link[] = [];
  if (f.parent?.key) links.push({ kind: 'parent', target: targetOf(ctx, f.parent.key), native: 'parent' });
  for (const st of f.subtasks ?? []) if (st.key) links.push({ kind: 'child', target: targetOf(ctx, st.key), native: 'subtask' });
  for (const l of f.issuelinks ?? []) {
    const native = l.type?.name ?? 'link';
    if (l.outwardIssue?.key) links.push({ kind: linkKind(native, 'outward'), target: targetOf(ctx, l.outwardIssue.key), native });
    if (l.inwardIssue?.key) links.push({ kind: linkKind(native, 'inward'), target: targetOf(ctx, l.inwardIssue.key), native });
  }

  const fields: Record<string, unknown> = {};
  if (ctx.fields.sprint && f[ctx.fields.sprint] != null) fields.iteration = f[ctx.fields.sprint];
  if (ctx.fields.estimate && f[ctx.fields.estimate] != null) fields.estimate = f[ctx.fields.estimate];
  for (const [canonical, id] of Object.entries(ctx.fields.declared)) {
    if (f[id] !== undefined) fields[canonical] = f[id];
  }

  const item: WorkItem = {
    id: workItemId(ctx.sourceId, issue.key),
    source: ctx.sourceId,
    provider: 'jira',
    key: issue.key,
    url: `${ctx.site}/browse/${issue.key}`,
    type: { name: f.issuetype?.name ?? 'Issue', category: typeCategory(f.issuetype) },
    title: f.summary ?? '',
    state: { name: f.status?.name ?? '', category: stateCategory(f.status?.statusCategory?.key) },
    labels: [...(f.labels ?? [])],
    links,
    created: isoUtc(f.created) ?? '',
    updated: isoUtc(f.updated) ?? '',
    revision: String(f.updated ?? ''),
    comments: [],
    history: [],
    fields,
    raw: issue,
  };
  const body = adfBody(f.description);
  if (body) item.body = body;
  const since = isoUtc(f.statuscategorychangedate);
  if (since) item.state.since = since;
  if (f.priority?.name) item.priority = { name: f.priority.name };
  const assignee = person(f.assignee);
  if (assignee) item.assignee = assignee;
  const reporter = person(f.reporter);
  if (reporter) item.reporter = reporter;
  const area = f.components?.[0]?.name;
  if (area) item.area = area;
  const sprintField = ctx.fields.declared.iteration ?? ctx.fields.sprint;
  const iteration = sprintField ? currentSprint(f[sprintField]) : undefined;
  if (iteration) item.iteration = iteration;
  if (f.parent?.key) item.parent = workItemId(ctx.sourceId, f.parent.key);
  const estField = ctx.fields.declared.estimate ?? ctx.fields.estimate;
  const est = estField ? f[estField] : undefined;
  if (typeof est === 'number' && Number.isFinite(est)) item.estimate = { value: est, unit: 'points' };
  const resolved = isoUtc(f.resolutiondate);
  if (resolved) item.resolved = resolved;
  return item;
}

// ── hydration shapes ───────────────────────────────────────────────────────

export interface JiraChangeHistory {
  id?: string;
  author?: JiraUser;
  /** ISO with offset from /issue/{key}/changelog; epoch ms from /changelog/bulkfetch (measured) */
  created?: string | number;
  items?: { field?: string; fieldId?: string; from?: string | null; fromString?: string | null; to?: string | null; toString?: string | null }[];
}

export function mapHistory(histories: JiraChangeHistory[]): Change[] {
  const out: Change[] = [];
  for (const h of histories) {
    const at = isoUtc(h.created) ?? '';
    const by = person(h.author);
    for (const it of h.items ?? []) {
      const c: Change = { at, field: it.field ?? it.fieldId ?? 'field' };
      if (by) c.by = by;
      const from = it.fromString ?? it.from;
      const to = it.toString ?? it.to;
      if (from !== null && from !== undefined) c.from = String(from);
      if (to !== null && to !== undefined) c.to = String(to);
      out.push(c);
    }
  }
  // newest last; bulkfetch returns newest first (measured), the per-issue changelog oldest first
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

export interface JiraComment { id: string; author?: JiraUser; created?: string; updated?: string; body?: unknown }

export function mapComment(c: JiraComment): Comment {
  const out: Comment = {
    id: c.id,
    author: person(c.author) ?? { id: 'unknown', name: 'unknown' },
    created: isoUtc(c.created) ?? '',
    body: adfBody(c.body) ?? { format: 'adf', raw: null, text: '' },
  };
  const updated = isoUtc(c.updated);
  if (updated && updated !== out.created) out.updated = updated;
  return out;
}
