// Azure DevOps → farsight-work v1, pure (docs/proposals/work-items-sync.md §3).
//
// Categories are decided from the tracker's own fields, never from a name:
//   state.category  ← workitemtypes/{type}.states[].category (Proposed · InProgress · Resolved · Completed · Removed)
//   type.category   ← the type's name per process (the one row §3 says names decide)
import type {
  WorkItem, WorkType, StateCategory, Person, Link, LinkKind, Comment, Change, Body, EstimateUnit,
  SchemaType, SchemaField, SchemaLinkType,
} from '@farsight/work';
import { workItemId } from '@farsight/work';
import { htmlToText } from './html.js';

/** ADO state category → farsight. *Resolved* is in-progress with the name kept (decided 2026-09-30). */
export const STATE_CATEGORY_MAP: Record<string, StateCategory> = {
  Proposed: 'todo',
  InProgress: 'in-progress',
  Resolved: 'in-progress',
  Completed: 'done',
  Removed: 'removed',
};

/** Work item type name → category (§3). Anything else is `other`. */
export const TYPE_CATEGORY_MAP: Record<string, WorkType> = {
  'Epic': 'epic',
  'Feature': 'feature',
  'User Story': 'story',
  'Product Backlog Item': 'story',
  'Requirement': 'story',
  'Task': 'task',
  'Bug': 'bug',
  'Issue': 'bug',
};

export function typeCategory(name: string): WorkType {
  return TYPE_CATEGORY_MAP[name] ?? 'other';
}

/** Relation reference name → link kind. Directions read from the item that carries the relation. */
export const LINK_KIND_MAP: Record<string, LinkKind> = {
  'System.LinkTypes.Hierarchy-Reverse': 'parent',
  'System.LinkTypes.Hierarchy-Forward': 'child',
  'System.LinkTypes.Related': 'relates',
  'System.LinkTypes.Dependency-Forward': 'blocks',     // the target is this item's successor
  'System.LinkTypes.Dependency-Reverse': 'blocked-by', // the target is this item's predecessor
  'System.LinkTypes.Duplicate-Reverse': 'duplicates',  // this item is a duplicate of the target
};

/** The relation a link kind is written as. `other` has none: the native name must be given. */
export const LINK_REL_FOR: Partial<Record<LinkKind, string>> = {
  parent: 'System.LinkTypes.Hierarchy-Reverse',
  child: 'System.LinkTypes.Hierarchy-Forward',
  relates: 'System.LinkTypes.Related',
  blocks: 'System.LinkTypes.Dependency-Forward',
  'blocked-by': 'System.LinkTypes.Dependency-Reverse',
  duplicates: 'System.LinkTypes.Duplicate-Reverse',
};

export function linkKind(rel: string): LinkKind {
  return LINK_KIND_MAP[rel] ?? (/^system\.linktypes\./i.test(rel) ? LINK_KIND_MAP[canonRel(rel)] ?? 'other' : 'other');
}
// the feed and older payloads spell `Dependency-forward` in lower case
function canonRel(rel: string): string {
  return rel.replace(/-(forward|reverse)$/i, (_, d: string) => '-' + d[0]!.toUpperCase() + d.slice(1).toLowerCase());
}

/** Canonical field names (§4.3) and the ADO reference names that can carry them, in preference order. */
export const CANONICAL_FIELDS: Record<string, { refs: string[]; unit?: EstimateUnit }> = {
  estimate: { refs: ['Microsoft.VSTS.Scheduling.StoryPoints', 'Microsoft.VSTS.Scheduling.Effort', 'Microsoft.VSTS.Scheduling.Size'], unit: 'points' },
  remaining: { refs: ['Microsoft.VSTS.Scheduling.RemainingWork'], unit: 'hours' },
  originalEstimate: { refs: ['Microsoft.VSTS.Scheduling.OriginalEstimate'], unit: 'hours' },
  completed: { refs: ['Microsoft.VSTS.Scheduling.CompletedWork'], unit: 'hours' },
  priority: { refs: ['Microsoft.VSTS.Common.Priority'] },
  severity: { refs: ['Microsoft.VSTS.Common.Severity'] },
  valueArea: { refs: ['Microsoft.VSTS.Common.ValueArea'] },
  acceptanceCriteria: { refs: ['Microsoft.VSTS.Common.AcceptanceCriteria'] },
  reproSteps: { refs: ['Microsoft.VSTS.TCM.ReproSteps'] },
  title: { refs: ['System.Title'] },
  description: { refs: ['System.Description'] },
  labels: { refs: ['System.Tags'] },
  area: { refs: ['System.AreaPath'] },
  iteration: { refs: ['System.IterationPath'] },
  assignee: { refs: ['System.AssignedTo'] },
  state: { refs: ['System.State'] },
  parent: { refs: ['System.Parent'] },
};

/** Canonical names that go into WorkItem.fields (the rest have their own WorkItem slot). */
const FIELDS_BAG = ['estimate', 'remaining', 'originalEstimate', 'completed', 'severity', 'valueArea', 'acceptanceCriteria', 'reproSteps'];

/**
 * The canonical → reference map for one project: what the project has (`found`),
 * overridden by the settings pin (`declared`).
 */
export function fieldMap(projectFields: { referenceName: string; name: string }[], pinned: Record<string, string> = {}): SchemaField[] {
  const have = new Map(projectFields.map((f) => [f.referenceName, f.name]));
  const out: SchemaField[] = [];
  for (const [canonical, def] of Object.entries(CANONICAL_FIELDS)) {
    if (pinned[canonical]) continue;
    for (const ref of def.refs) {
      if (have.has(ref)) { out.push({ id: ref, name: have.get(ref)!, canonical, origin: 'found' }); }
    }
  }
  for (const [canonical, ref] of Object.entries(pinned)) {
    out.push({ id: ref, name: have.get(ref) ?? ref, canonical, origin: 'declared' });
  }
  // every other project field, uncanonicalised, so a pin can name it
  for (const [ref, name] of have) if (!out.some((f) => f.id === ref)) out.push({ id: ref, name, origin: 'found' });
  return out;
}

/** An IdentityRef (or the feed's `Name <email>` string) → Person, keyed on descriptor. */
export function person(v: unknown): Person | undefined {
  if (!v) return undefined;
  if (typeof v === 'string') {
    const m = /^(.*?)\s*<([^>]+)>$/.exec(v);
    return m ? { id: m[2]!, name: m[1]!, email: m[2]! } : { id: v, name: v };
  }
  const r = v as { descriptor?: string; id?: string; displayName?: string; uniqueName?: string };
  const id = r.descriptor ?? r.id;
  if (!id) return undefined;
  const p: Person = { id, name: r.displayName ?? r.uniqueName ?? id };
  if (r.uniqueName && r.uniqueName.includes('@')) p.email = r.uniqueName;
  return p;
}

export function splitTags(v: unknown): string[] {
  if (typeof v !== 'string') return [];
  return v.split(';').map((s) => s.trim()).filter(Boolean);
}

export function joinTags(tags: string[]): string {
  return tags.join('; ');
}

/** The work item id at the end of an ADO work-item URL, if it is one. */
export function idFromUrl(url: string | undefined): string | undefined {
  const m = /\/_apis\/wit\/workItems\/(\d+)$/i.exec(url ?? '');
  return m ? m[1] : undefined;
}

export interface TypeInfo {
  name: string;
  category: WorkType;
  /** state name → ADO category string */
  states: Map<string, string>;
  transitions: Record<string, string[]>;
}

export function typeInfo(t: { name: string; states?: { name: string; category: string }[]; transitions?: Record<string, { to: string }[]> }): TypeInfo {
  const transitions: Record<string, string[]> = {};
  for (const [from, tos] of Object.entries(t.transitions ?? {})) transitions[from] = (tos ?? []).map((x) => x.to);
  return {
    name: t.name,
    category: typeCategory(t.name),
    states: new Map((t.states ?? []).map((s) => [s.name, s.category])),
    transitions,
  };
}

export function schemaType(ti: TypeInfo): SchemaType {
  return {
    name: ti.name,
    category: ti.category,
    states: [...ti.states].map(([name, cat]) => ({ name, category: STATE_CATEGORY_MAP[cat] ?? 'todo' })),
    transitions: ti.transitions,
  };
}

export function schemaLinkTypes(relTypes: { referenceName: string; attributes?: { usage?: string } }[]): SchemaLinkType[] {
  return relTypes.map((r) => ({ native: r.referenceName, kind: linkKind(r.referenceName) }));
}

export interface MapContext {
  sourceId: string;
  /** org base URL, e.g. https://dev.azure.com/example-org */
  org: string;
  /** project name → type name → TypeInfo */
  types: Map<string, Map<string, TypeInfo>>;
  /** project name → iteration path → dates */
  iterations?: Map<string, Map<string, { start?: string; end?: string }>>;
  /** canonical → ref (resolved field map, declared pins winning) */
  fields: Map<string, string[]>;
}

/** ADO work item (workitemsbatch / workitems, `$expand=relations`) → WorkItem. */
export function mapWorkItem(raw: any, ctx: MapContext): WorkItem {
  const f: Record<string, any> = raw.fields ?? {};
  const key = String(raw.id);
  const project = String(f['System.TeamProject'] ?? '');
  const typeName = String(f['System.WorkItemType'] ?? '');
  const ti = ctx.types.get(project)?.get(typeName);
  const stateName = String(f['System.State'] ?? '');
  const adoCat = ti?.states.get(stateName);
  // a state its type does not define (left behind by a process change): ADO
  // refuses every change until it is fixed. The category is not guessed from
  // the name — it is marked, and `todo` stands in until the contract has a word.
  const stateCategory: StateCategory = adoCat ? STATE_CATEGORY_MAP[adoCat] ?? 'todo' : 'todo';
  const fields: Record<string, unknown> = {};
  if (!adoCat) fields.stateUndefinedByType = true;

  const pick = (canonical: string): { ref: string; value: unknown } | undefined => {
    for (const ref of ctx.fields.get(canonical) ?? CANONICAL_FIELDS[canonical]?.refs ?? []) {
      if (f[ref] !== undefined && f[ref] !== null && f[ref] !== '') return { ref, value: f[ref] };
    }
    return undefined;
  };
  for (const c of FIELDS_BAG) {
    const hit = pick(c);
    if (hit) fields[c] = hit.value;
  }
  for (const [ref, value] of Object.entries(f)) if (ref.startsWith('Custom.')) fields[ref] = value;

  const links: Link[] = [];
  let parent: string | undefined;
  for (const r of (raw.relations ?? []) as { rel: string; url: string; attributes?: any }[]) {
    const kind = linkKind(r.rel);
    const targetId = idFromUrl(r.url);
    const target = targetId ? workItemId(ctx.sourceId, targetId) : r.url;
    links.push({ kind, target, native: r.rel });
    if (kind === 'parent' && !parent) parent = target;
  }
  if (!parent && f['System.Parent'] !== undefined && f['System.Parent'] !== null) parent = workItemId(ctx.sourceId, String(f['System.Parent']));

  const est = pick('estimate');
  let estimate: WorkItem['estimate'];
  if (est && typeof est.value === 'number') estimate = { value: est.value, unit: 'points' };
  else {
    const rem = pick('remaining');
    if (rem && typeof rem.value === 'number') estimate = { value: rem.value, unit: 'hours' };
  }

  const iterPath = f['System.IterationPath'] as string | undefined;
  let iteration: WorkItem['iteration'];
  if (iterPath) {
    iteration = { name: iterPath };
    const d = ctx.iterations?.get(project)?.get(iterPath);
    if (d?.start) iteration.start = d.start;
    if (d?.end) iteration.end = d.end;
  }

  const descFormat = String(raw.multilineFieldsFormat?.['System.Description'] ?? 'html').toLowerCase();
  let body: Body | undefined;
  if (typeof f['System.Description'] === 'string' && f['System.Description']) {
    const d = f['System.Description'] as string;
    body = descFormat === 'markdown'
      ? { format: 'markdown', raw: d, text: d }
      : { format: 'html', raw: d, text: htmlToText(d) };
  }

  const prio = f['Microsoft.VSTS.Common.Priority'];
  const item: WorkItem = {
    id: workItemId(ctx.sourceId, key),
    source: ctx.sourceId,
    provider: 'azure-devops',
    key,
    url: raw._links?.html?.href ?? `${ctx.org}/${encodeURIComponent(project)}/_workitems/edit/${key}`,
    type: { name: typeName, category: ti?.category ?? typeCategory(typeName) },
    title: String(f['System.Title'] ?? ''),
    state: { name: stateName, category: stateCategory },
    labels: splitTags(f['System.Tags']),
    links,
    created: iso(f['System.CreatedDate']),
    updated: iso(f['System.ChangedDate']),
    revision: String(raw.rev ?? f['System.Rev'] ?? ''),
    comments: [],
    history: [],
    fields,
    raw,
  };
  if (body) item.body = body;
  const since = f['Microsoft.VSTS.Common.StateChangeDate'];
  if (since) item.state.since = iso(since);
  if (prio !== undefined && prio !== null) item.priority = { name: String(prio), rank: typeof prio === 'number' ? prio : undefined };
  const assignee = person(f['System.AssignedTo']);
  if (assignee) item.assignee = assignee;
  const reporter = person(f['System.CreatedBy']);
  if (reporter) item.reporter = reporter;
  if (f['System.AreaPath']) item.area = String(f['System.AreaPath']);
  if (iteration) item.iteration = iteration;
  if (parent) item.parent = parent;
  if (estimate) item.estimate = estimate;
  const resolved = f['Microsoft.VSTS.Common.ClosedDate'] ?? f['Microsoft.VSTS.Common.ResolvedDate'];
  if (resolved) item.resolved = iso(resolved);
  return item;
}

function iso(v: unknown): string {
  if (typeof v !== 'string' || !v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

/** Comments API → Comment. `format` is absent on 7.1-preview (HTML). */
export function mapComment(c: any): Comment {
  const fmt = String(c.format ?? 'html').toLowerCase();
  const text = String(c.text ?? '');
  const body: Body = fmt === 'markdown'
    ? { format: 'markdown', raw: text, text }
    : { format: 'html', raw: text, text: htmlToText(text) };
  const out: Comment = {
    id: String(c.id),
    author: person(c.createdBy) ?? { id: 'unknown', name: 'unknown' },
    created: iso(c.createdDate),
    body,
  };
  if (c.modifiedDate && c.modifiedDate !== c.createdDate) out.updated = iso(c.modifiedDate);
  return out;
}

/** Bookkeeping fields every revision moves; they are not changes a person made. */
const NOISE = new Set([
  'System.Rev', 'System.AuthorizedDate', 'System.RevisedDate', 'System.ChangedDate', 'System.Watermark',
  'System.AuthorizedAs', 'System.PersonId', 'System.ChangedBy', 'System.CommentCount',
  'System.AreaId', 'System.IterationId', 'System.NodeName', 'System.IsDeleted',
]);
const HTML_FIELDS = new Set(['System.Description', 'System.History', 'Microsoft.VSTS.Common.AcceptanceCriteria', 'Microsoft.VSTS.TCM.ReproSteps']);

function show(ref: string, v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'object') return person(v)?.name ?? JSON.stringify(v);
  if (HTML_FIELDS.has(ref) && typeof v === 'string') return htmlToText(v);
  return String(v);
}

/** `workItems/{id}/updates` → Change[], oldest first. */
export function mapUpdates(updates: any[]): Change[] {
  const out: Change[] = [];
  for (const u of [...updates].sort((a, b) => (a.rev ?? 0) - (b.rev ?? 0))) {
    const at = iso(u.fields?.['System.ChangedDate']?.newValue ?? u.revisedDate);
    const by = person(u.revisedBy);
    for (const [ref, d] of Object.entries((u.fields ?? {}) as Record<string, { oldValue?: unknown; newValue?: unknown }>)) {
      if (NOISE.has(ref) || /^WEF_/.test(ref)) continue;
      const c: Change = { at, field: ref };
      if (by) c.by = by;
      const from = show(ref, d.oldValue);
      const to = show(ref, d.newValue);
      if (from !== undefined) c.from = from;
      if (to !== undefined) c.to = to;
      out.push(c);
    }
    const rel = u.relations as { added?: any[]; removed?: any[]; updated?: any[] } | undefined;
    for (const [verb, list] of [['added', rel?.added], ['removed', rel?.removed]] as const) {
      for (const r of list ?? []) {
        const c: Change = { at, field: 'relations' };
        if (by) c.by = by;
        const label = `${r.rel} ${idFromUrl(r.url) ?? r.attributes?.name ?? r.url}`;
        if (verb === 'added') c.to = label; else c.from = label;
        out.push(c);
      }
    }
  }
  return out;
}
