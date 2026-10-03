// The Jira Cloud work provider (docs/proposals/work-items-sync.md §4, §6.1, §7.3, §8;
// the research appendix docs/proposals/work-items-sync/research-jira-cloud.md).
//
// It maps Jira into farsight-work v1 and owns paging, rate limits and retries.
// It never touches the cache and never decides a permission: `can()` reports
// Jira's own answer, in words, and nothing else.
//
// The client (and with it the secret) lives in a WeakMap keyed by the session,
// never on the session object — a session may be logged or serialised.
import { t } from '@farsight/core';
import { resolveSecret, resolveMaybeSecret, workItemId } from '@farsight/work';
import type {
  WorkProvider, Capabilities, Session, Schema, SchemaType, SchemaState, SchemaField, SchemaLinkType,
  PullPage, Cursor, Scope, SourceConfig, WorkItem, WorkAction, Intent, ApplyResult, ProviderVerdict,
  LinkKind, StateCategory,
} from '@farsight/work';
import { createJiraClient, JiraHttpError, type JiraClient, type Fetcher } from './http.js';
import { markdownToAdf } from './adf.js';
import {
  mapIssue, mapHistory, mapComment, fieldList, stateCategory, typeCategory, linkKind,
  type FieldMap, type JiraIssue, type JiraChangeHistory, type JiraComment, type MapContext,
} from './map.js';

const say = (key: string, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), t(key, 'professional'));

/** §4.4 for Jira. `create` is not built in v1, so it is not declared. */
export const JIRA_CAPABILITIES: Capabilities = {
  comments: { read: true, write: true, format: 'adf' },
  transitions: 'per-item',
  concurrency: 'compare-updated',
  permissionsProbe: 'per-item',
  deletesVisible: false,
  push: 'none',
  dryRun: false,
  actions: ['comment', 'edit', 'assign', 'transition', 'link', 'label'],
};

export const SPRINT_CUSTOM = 'com.pyxis.greenhopper.jira:gh-sprint';
/** the story-points type a Jira Software board creates when estimation is turned on (measured 2026-09-30) */
export const STORY_POINTS_CUSTOM = 'com.pyxis.greenhopper.jira:jsw-story-points';
const PERMISSIONS = ['BROWSE_PROJECTS', 'EDIT_ISSUES', 'ADD_COMMENTS', 'ASSIGN_ISSUES', 'TRANSITION_ISSUES', 'LINK_ISSUES'] as const;
type PermissionKey = typeof PERMISSIONS[number];
const PERM_WORD: Record<PermissionKey, string> = {
  BROWSE_PROJECTS: 'work.jira.perm.browse',
  EDIT_ISSUES: 'work.jira.perm.edit',
  ADD_COMMENTS: 'work.jira.perm.comment',
  ASSIGN_ISSUES: 'work.jira.perm.assign',
  TRANSITION_ISSUES: 'work.jira.perm.transition',
  LINK_ISSUES: 'work.jira.perm.link',
};

export interface JiraProviderOptions {
  fetcher?: Fetcher;
  /** ms slept between retries and under the per-issue write caps; injectable for tests */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** incremental overlap; default 3 minutes (search is eventually consistent) */
  overlapMs?: number;
  /** search page size asked for; Jira may return fewer */
  pageSize?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

/** A pull option the engine may pass on the scope: report which of these ids are gone. */
export interface ReconcileScope extends Scope {
  reconcile?: { known: string[] };
}

interface State {
  client: JiraClient;
  site: string;
  projects: string[];
  declared: Record<string, string>;
  fields?: FieldMap;
  fieldOrigin: Record<string, 'found' | 'declared'>;
  /** Jira issue ids Farsight wrote — sent as reconcileIssues on the next search */
  written: Set<string>;
  /** which changelog path the site answered: measured on first hydrate */
  changelogVia?: 'bulkfetch' | 'per-issue';
}

const states = new WeakMap<Session, State>();

function stateOf(s: Session): State {
  const st = states.get(s);
  if (!st) throw new Error(`Jira session ${s.sourceId} is not connected in this process`);
  return st;
}

export function keyOf(id: string): string {
  const i = id.lastIndexOf('::');
  return i >= 0 ? id.slice(i + 2) : id;
}

// ── the cursor: last `updated` seen (epoch ms) + what was seen inside the overlap ──
interface CursorDoc { v: 1; at: number; seen: string[] }

export function encodeCursor(c: CursorDoc): Cursor {
  return JSON.stringify(c);
}

export function decodeCursor(c: Cursor | null): CursorDoc | null {
  if (!c) return null;
  try {
    const j = JSON.parse(c) as CursorDoc;
    if (j && j.v === 1 && typeof j.at === 'number') return { v: 1, at: j.at, seen: Array.isArray(j.seen) ? j.seen : [] };
  } catch {
    // a bare ISO timestamp is accepted too
  }
  const at = Date.parse(c);
  return Number.isFinite(at) ? { v: 1, at, seen: [] } : null;
}

const jqlList = (xs: string[]) => xs.map((x) => `"${x.replace(/"/g, '\\"')}"`).join(', ');

/**
 * Bounded JQL. `updated` is compared as epoch milliseconds, unquoted — measured
 * on the live site to filter at sub-minute precision and without the user's time
 * zone, which the quoted "yyyy/MM/dd HH:mm" form needs (appendix §2).
 */
export function buildJql(projects: string[], opts: { since?: number; areas?: string[]; order?: 'updated' | 'key' } = {}): string {
  const parts = [`project in (${jqlList(projects)})`];
  if (opts.areas?.length) parts.push(`component in (${jqlList(opts.areas)})`);
  if (opts.since !== undefined) parts.push(`updated >= ${Math.max(0, Math.floor(opts.since))}`);
  return `${parts.join(' AND ')} ORDER BY ${opts.order === 'key' ? 'key' : 'updated'} ASC`;
}

interface SearchPage { issues?: JiraIssue[]; nextPageToken?: string | null; isLast?: boolean }

/** Per-issue write serialisation and Jira's per-issue write caps (20 / 2 s, 100 / 30 s). */
class WriteGate {
  private chains = new Map<string, Promise<unknown>>();
  private stamps = new Map<string, number[]>();
  constructor(private now: () => number, private sleep: (ms: number) => Promise<void>) {}

  run<T>(key: string, fn: (write: () => Promise<void>) => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => fn(() => this.slot(key)));
    this.chains.set(key, next.catch(() => undefined));
    return next;
  }

  /** wait until one more write on this issue stays under both caps, then count it */
  private async slot(key: string): Promise<void> {
    for (;;) {
      const t0 = this.now();
      const list = (this.stamps.get(key) ?? []).filter((x) => t0 - x < 30_000);
      const in2 = list.filter((x) => t0 - x < 2_000);
      if (in2.length < 20 && list.length < 100) {
        list.push(t0);
        this.stamps.set(key, list);
        return;
      }
      const waitFor = in2.length >= 20 ? 2_000 - (t0 - in2[0]!) : 30_000 - (t0 - list[0]!);
      await this.sleep(Math.max(10, waitFor));
    }
  }
}

export function createJiraProvider(opts: JiraProviderOptions = {}): WorkProvider {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const overlap = opts.overlapMs ?? 3 * 60_000;
  const pageSize = opts.pageSize ?? 100;
  const gate = new WriteGate(now, sleep);

  const ctxOf = (s: Session, st: State): MapContext => ({
    sourceId: s.sourceId, site: st.site, projects: st.projects, fields: st.fields ?? { declared: st.declared },
  });

  /** Sprint by schema.custom; estimate by the board's estimation field, else the story-points type; pins win. */
  async function resolveFields(st: State): Promise<{ map: FieldMap; all: { id: string; name: string; custom?: string }[] }> {
    const all = await st.client.get<{ id: string; name: string; schema?: { custom?: string; type?: string } }[]>('/rest/api/3/field');
    const map: FieldMap = { declared: { ...st.declared } };
    const origin: Record<string, 'found' | 'declared'> = {};
    const sprint = all.find((f) => f.schema?.custom === SPRINT_CUSTOM);
    if (sprint) { map.sprint = sprint.id; origin.iteration = 'found'; }
    // the board's estimation field, for boards in scope
    for (const p of st.projects) {
      if (map.estimate) break;
      const boards = await st.client.get<{ values?: { id: number }[] }>(`/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(p)}`, { allow: [400, 403, 404] }).catch(() => undefined);
      for (const b of boards?.values ?? []) {
        const cfg = await st.client.get<{ estimation?: { field?: { fieldId?: string } } }>(`/rest/agile/1.0/board/${b.id}/configuration`, { allow: [400, 403, 404] }).catch(() => undefined);
        const id = cfg?.estimation?.field?.fieldId;
        if (id) { map.estimate = id; origin.estimate = 'found'; break; }
      }
    }
    if (!map.estimate) {
      const sp = all.find((f) => f.schema?.custom === STORY_POINTS_CUSTOM)
        ?? all.find((f) => /:float$/.test(f.schema?.custom ?? '') && /point/i.test(f.name));
      if (sp) { map.estimate = sp.id; origin.estimate = 'found'; }
    }
    for (const canonical of Object.keys(st.declared)) origin[canonical] = 'declared';
    if (st.declared.iteration) map.sprint = st.declared.iteration;
    if (st.declared.estimate) map.estimate = st.declared.estimate;
    st.fields = map;
    st.fieldOrigin = origin;
    return { map, all: all.map((f) => ({ id: f.id, name: f.name, ...(f.schema?.custom ? { custom: f.schema.custom } : {}) })) };
  }

  async function ensureFields(st: State): Promise<FieldMap> {
    return st.fields ?? (await resolveFields(st)).map;
  }

  async function search(st: State, jql: string, fields: string[], token?: string, reconcile?: string[]): Promise<SearchPage> {
    const body: Record<string, unknown> = { jql, fields, maxResults: pageSize };
    if (token) body.nextPageToken = token;
    if (reconcile?.length) body.reconcileIssues = reconcile.slice(0, 50).map(Number).filter(Number.isFinite);
    return st.client.post<SearchPage>('/rest/api/3/search/jql', body, { idempotent: true });
  }

  async function readIssue(st: State, key: string, fields: string[], expand?: string): Promise<JiraIssue> {
    const q = new URLSearchParams({ fields: fields.join(',') });
    if (expand) q.set('expand', expand);
    return st.client.get<JiraIssue>(`/rest/api/3/issue/${encodeURIComponent(key)}?${q}`);
  }

  async function comments(st: State, key: string): Promise<JiraComment[]> {
    const out: JiraComment[] = [];
    for (let startAt = 0; ;) {
      const page = await st.client.get<{ comments?: JiraComment[]; total?: number; maxResults?: number; isLast?: boolean }>(
        `/rest/api/3/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=100&orderBy=created`);
      const got = page.comments ?? [];
      out.push(...got);
      startAt += got.length;
      if (!got.length || page.isLast === true || (page.total !== undefined && startAt >= page.total)) break;
    }
    return out;
  }

  async function changelogPerIssue(st: State, key: string): Promise<JiraChangeHistory[]> {
    const out: JiraChangeHistory[] = [];
    for (let startAt = 0; ;) {
      const page = await st.client.get<{ values?: JiraChangeHistory[]; total?: number; isLast?: boolean }>(
        `/rest/api/3/issue/${encodeURIComponent(key)}/changelog?startAt=${startAt}&maxResults=100`);
      const got = page.values ?? [];
      out.push(...got);
      startAt += got.length;
      if (!got.length || page.isLast === true || (page.total !== undefined && startAt >= page.total)) break;
    }
    return out;
  }

  /** changelogs by Jira issue id — bulkfetch (≤1000 issues, token paging), else per issue */
  async function changelogs(st: State, issues: JiraIssue[]): Promise<Map<string, JiraChangeHistory[]>> {
    const out = new Map<string, JiraChangeHistory[]>(issues.map((i) => [i.id, []]));
    if (st.changelogVia !== 'per-issue') {
      try {
        let token: string | undefined;
        do {
          const body: Record<string, unknown> = { issueIdsOrKeys: issues.map((i) => i.id), maxResults: 1000 };
          if (token) body.nextPageToken = token;
          const page = await st.client.post<{ issueChangeLogs?: { issueId: string; changeHistories?: JiraChangeHistory[] }[]; nextPageToken?: string }>(
            '/rest/api/3/changelog/bulkfetch', body, { idempotent: true });
          for (const l of page.issueChangeLogs ?? []) out.get(String(l.issueId))?.push(...(l.changeHistories ?? []));
          token = page.nextPageToken ?? undefined;
        } while (token);
        st.changelogVia = 'bulkfetch';
        return out;
      } catch (err) {
        if (!(err instanceof JiraHttpError) || ![404, 405].includes(err.status)) throw err;
        st.changelogVia = 'per-issue';
      }
    }
    for (const i of issues) out.set(i.id, await changelogPerIssue(st, i.key));
    return out;
  }

  async function bulkIssues(st: State, keys: string[], fields: string[]): Promise<JiraIssue[]> {
    const out: JiraIssue[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      const page = await st.client.post<{ issues?: JiraIssue[] }>('/rest/api/3/issue/bulkfetch',
        { issueIdsOrKeys: keys.slice(i, i + 100), fields }, { idempotent: true });
      out.push(...(page.issues ?? []));
    }
    return out;
  }

  const provider: WorkProvider = {
    id: 'jira',
    capabilities: JIRA_CAPABILITIES,

    async connect(cfg: SourceConfig, secret: string | undefined): Promise<Session> {
      if (!cfg.site) throw new Error(say('work.jira.error.noSite', { source: cfg.id }));
      const user = await resolveMaybeSecret(cfg.auth?.user);
      if (!user) throw new Error(say('work.jira.error.noUser', { source: cfg.id }));
      const token = secret ?? (cfg.auth?.secret ? await resolveSecret(cfg.auth.secret) : undefined);
      if (!token) throw new Error(say('work.jira.error.noSecret', { source: cfg.id }));
      const client = createJiraClient({
        site: cfg.site, user, secret: token,
        ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
        ...(opts.random ? { random: opts.random } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
        now,
      });
      const me = await client.get<{ accountId: string; displayName?: string; timeZone?: string }>('/rest/api/3/myself');
      // cloudId: answered without authentication (measured), and only a nicety — fail-soft
      const tenant = await client.get<{ cloudId?: string }>('/_edge/tenant_info', { anonymous: true, timeoutMs: 5_000, allow: [401, 403, 404] }).catch(() => undefined);

      const projects = cfg.scope.projects;
      const perProject: string[] = [];
      let read = projects.length > 0;
      let write = projects.length > 0;
      for (const p of projects) {
        const q = new URLSearchParams({ permissions: PERMISSIONS.join(','), projectKey: p });
        const r = await client.request<{ permissions?: Record<string, { havePermission?: boolean }> }>('GET', `/rest/api/3/mypermissions?${q}`, { allow: [400, 404] });
        const perms = r.status === 200 ? r.body.permissions ?? {} : {};
        const have = PERMISSIONS.filter((k) => perms[k]?.havePermission);
        if (!have.includes('BROWSE_PROJECTS')) read = false;
        if (!have.some((k) => k !== 'BROWSE_PROJECTS')) write = false;
        perProject.push(say('work.jira.credential.project', {
          project: p,
          list: have.length ? have.map((k) => t(PERM_WORD[k], 'professional')).join(', ') : t('work.jira.perm.none', 'professional'),
        }));
      }
      const session: Session = {
        sourceId: cfg.id,
        provider: 'jira',
        endpoint: client.site,
        user: { id: me.accountId, name: me.displayName ?? me.accountId },
        credentialScope: { read, write, detail: perProject.join(' · ') },
        apiVersion: '3',
        projects,
        ...(tenant?.cloudId ? { cloudId: tenant.cloudId } : {}),
        ...(me.timeZone ? { timeZone: me.timeZone } : {}),
      };
      states.set(session, {
        client, site: client.site, projects, declared: { ...(cfg.fields ?? {}) }, fieldOrigin: {}, written: new Set(),
      });
      return session;
    },

    async discover(s: Session): Promise<Schema> {
      const st = stateOf(s);
      const schemaProjects: Schema['projects'] = [];
      const types = new Map<string, SchemaType>();
      const stateList: SchemaState[] = [];
      const stateSeen = new Set<string>();
      for (const key of st.projects) {
        const p = await st.client.get<{ id: string; key: string; name: string; issueTypes?: { name: string; subtask?: boolean; hierarchyLevel?: number }[] }>(
          `/rest/api/3/project/${encodeURIComponent(key)}`);
        schemaProjects.push({ key: p.key, name: p.name, id: p.id });
        for (const it of p.issueTypes ?? []) {
          if (!types.has(it.name)) types.set(it.name, { name: it.name, category: typeCategory(it), states: [] });
        }
        const byType = await st.client.get<{ name: string; statuses?: { name: string; statusCategory?: { key?: string } }[] }[]>(
          `/rest/api/3/project/${encodeURIComponent(key)}/statuses`);
        for (const bt of byType) {
          const type = types.get(bt.name) ?? { name: bt.name, category: 'other' as const, states: [] };
          types.set(bt.name, type);
          for (const x of bt.statuses ?? []) {
            const ss: SchemaState = { name: x.name, category: stateCategory(x.statusCategory?.key) };
            if (!type.states!.some((y) => y.name === ss.name)) type.states!.push(ss);
            if (!stateSeen.has(ss.name)) { stateSeen.add(ss.name); stateList.push(ss); }
          }
        }
      }
      const { map, all } = await resolveFields(st);
      const fields: SchemaField[] = [];
      const push = (canonical: string, id: string | undefined) => {
        if (!id) return;
        const f = all.find((x) => x.id === id);
        fields.push({ id, name: f?.name ?? id, canonical, origin: st.fieldOrigin[canonical] ?? 'found' });
      };
      push('iteration', map.sprint);
      push('estimate', map.estimate);
      for (const [canonical, id] of Object.entries(st.declared)) {
        if (canonical !== 'iteration' && canonical !== 'estimate') push(canonical, id);
      }
      const lt = await st.client.get<{ issueLinkTypes?: { name: string }[] }>('/rest/api/3/issueLinkType');
      const linkTypes: SchemaLinkType[] = (lt.issueLinkTypes ?? []).map((x) => ({ native: x.name, kind: linkKind(x.name, 'outward') }));
      return { projects: schemaProjects, types: [...types.values()], states: stateList, fields, linkTypes, bodyFormat: 'adf' };
    },

    async *pull(s: Session, cursor: Cursor | null, scope: Scope): AsyncIterable<PullPage> {
      const st = stateOf(s);
      const fm = await ensureFields(st);
      const projects = scope.projects.length ? scope.projects : st.projects;
      const prev = decodeCursor(cursor);
      const jql = buildJql(projects, { ...(prev ? { since: prev.at - overlap } : {}), ...(scope.areas?.length ? { areas: scope.areas } : {}) });
      const fields = fieldList(fm);
      const ctx = ctxOf(s, st);
      const seenBefore = new Set(prev?.seen ?? []);
      const seenNow = new Map<string, number>();
      let at = prev?.at ?? 0;
      const reconcileIds = [...st.written];
      st.written.clear();
      const reconcile = (scope as ReconcileScope).reconcile;

      const cursorNow = (): Cursor => {
        const floor = at - overlap;
        const keep = [...seenNow].filter(([, u]) => u >= floor).map(([k]) => k);
        for (const k of seenBefore) {
          const u = Number(k.slice(k.lastIndexOf('@') + 1));
          if (u >= floor && !seenNow.has(k)) keep.push(k);
        }
        return encodeCursor({ v: 1, at, seen: keep });
      };

      let token: string | undefined;
      let first = true;
      for (;;) {
        const page = await search(st, jql, fields, token, first ? reconcileIds : undefined);
        first = false;
        const items: WorkItem[] = [];
        for (const issue of page.issues ?? []) {
          const u = Date.parse(String(issue.fields?.updated ?? ''));
          const mark = `${issue.id}@${Number.isFinite(u) ? u : 0}`;
          if (seenBefore.has(mark) || seenNow.has(mark)) continue;
          seenNow.set(mark, Number.isFinite(u) ? u : 0);
          if (Number.isFinite(u) && u > at) at = u;
          items.push(mapIssue(issue, ctx));
        }
        token = page.nextPageToken ?? undefined;
        const last = !token || page.isLast === true;
        if (last && !reconcile) {
          yield { items, cursor: cursorNow(), isLast: true };
          return;
        }
        yield { items, cursor: cursorNow(), isLast: false };
        if (last) break;
      }

      // key-only reconcile scan: which known ids are no longer in scope (deleted or moved away)
      const present = new Set<string>();
      const scanJql = buildJql(projects, { ...(scope.areas?.length ? { areas: scope.areas } : {}), order: 'key' });
      let scanToken: string | undefined;
      do {
        const body: Record<string, unknown> = { jql: scanJql, fields: ['key'], maxResults: 5000 };
        if (scanToken) body.nextPageToken = scanToken;
        const page = await st.client.post<SearchPage>('/rest/api/3/search/jql', body, { idempotent: true });
        for (const i of page.issues ?? []) present.add(workItemId(s.sourceId, i.key));
        scanToken = page.nextPageToken ?? undefined;
      } while (scanToken);
      const deleted = reconcile!.known.filter((id) => !present.has(id));
      yield { items: [], cursor: cursorNow(), isLast: true, deleted };
    },

    async hydrate(s: Session, ids: string[]): Promise<WorkItem[]> {
      const st = stateOf(s);
      if (!ids.length) return [];
      const fm = await ensureFields(st);
      const issues = await bulkIssues(st, ids.map(keyOf), fieldList(fm));
      const logs = await changelogs(st, issues);
      const ctx = ctxOf(s, st);
      const byId = new Map<string, WorkItem>();
      for (const issue of issues) {
        const item = mapIssue(issue, ctx);
        item.history = mapHistory(logs.get(issue.id) ?? []);
        item.comments = (await comments(st, issue.key)).map(mapComment);
        byId.set(item.id, item);
      }
      // a moved issue answers with its new key: keep the order asked for, found ones only
      return ids.map((id) => byId.get(id) ?? byId.get(workItemId(s.sourceId, keyOf(id)))).filter((x): x is WorkItem => !!x);
    },

    async can(s: Session, item: WorkItem, action: WorkAction): Promise<ProviderVerdict> {
      const st = stateOf(s);
      if (!JIRA_CAPABILITIES.actions!.includes(action)) return { allowed: false, reason: say('work.jira.says.cannot', { action }) };
      const key = keyOf(item.id);
      let issue: JiraIssue & { transitions?: unknown[]; editmeta?: { fields?: Record<string, unknown> } };
      try {
        issue = await readIssue(st, key, ['status', 'labels'], 'editmeta,transitions,operations') as typeof issue;
      } catch (err) {
        if (err instanceof JiraHttpError && err.status === 404) return { allowed: false, reason: say('work.jira.says.notVisible', { key }) };
        throw err;
      }
      const q = new URLSearchParams({ permissions: PERMISSIONS.join(','), issueKey: key });
      const perms = (await st.client.get<{ permissions?: Record<string, { havePermission?: boolean }> }>(`/rest/api/3/mypermissions?${q}`)).permissions ?? {};
      const has = (p: PermissionKey) => perms[p]?.havePermission === true;
      const lacks = (p: PermissionKey): ProviderVerdict => ({ allowed: false, reason: say('work.jira.says.lacks', { permission: t(PERM_WORD[p], 'professional'), key }) });
      const yes: ProviderVerdict = { allowed: true, reason: say('work.jira.says.yes') };
      const editable = (f: string) => !!issue.editmeta?.fields?.[f];
      switch (action) {
        case 'comment': return has('ADD_COMMENTS') ? yes : lacks('ADD_COMMENTS');
        case 'assign': return has('ASSIGN_ISSUES') ? yes : lacks('ASSIGN_ISSUES');
        case 'link': return has('LINK_ISSUES') ? yes : lacks('LINK_ISSUES');
        case 'transition':
          if (!has('TRANSITION_ISSUES')) return lacks('TRANSITION_ISSUES');
          return (issue.transitions ?? []).length ? yes : { allowed: false, reason: say('work.jira.says.noTransition', { state: issue.fields?.status?.name ?? item.state.name }) };
        case 'label':
          if (!has('EDIT_ISSUES')) return lacks('EDIT_ISSUES');
          return editable('labels') ? yes : { allowed: false, reason: say('work.jira.says.notEditable', { field: 'labels', key }) };
        case 'edit':
          if (!has('EDIT_ISSUES')) return lacks('EDIT_ISSUES');
          return Object.keys(issue.editmeta?.fields ?? {}).length ? yes : { allowed: false, reason: say('work.jira.says.notEditable', { field: 'fields', key }) };
        default:
          return { allowed: false, reason: say('work.jira.says.cannot', { action }) };
      }
    },

    async apply(s: Session, intent: Intent): Promise<ApplyResult> {
      const st = stateOf(s);
      const key = keyOf(intent.item);
      if (!JIRA_CAPABILITIES.actions!.includes(intent.action)) return { ok: false, error: say('work.jira.says.cannot', { action: intent.action }) };
      return gate.run(key, async (write) => {
        try {
          // compare-before-write: Jira has no ETag (appendix §3); re-GET `updated`
          const before = await readIssue(st, key, ['updated', 'labels', 'status']);
          const current = String(before.fields?.updated ?? '');
          if (intent.baseRevision !== undefined && intent.baseRevision !== current) {
            return { ok: false, conflict: true, revision: current, error: say('work.jira.conflict', { key }) };
          }
          const p = intent.payload;
          const path = `/rest/api/3/issue/${encodeURIComponent(key)}`;
          let response: unknown;
          switch (intent.action) {
            case 'comment': {
              await write();
              response = await st.client.post(`${path}/comment`, { body: markdownToAdf(String(p.body ?? '')) });
              break;
            }
            case 'assign': {
              await write();
              response = await st.client.put(`${path}/assignee`, { accountId: p.assignee ?? null });
              break;
            }
            case 'label': {
              const ops = [...(p.add ?? []).map((l) => ({ add: l })), ...(p.remove ?? []).map((l) => ({ remove: l }))];
              if (!ops.length) return { ok: false, error: say('work.jira.error.emptyLabels') };
              await write();
              response = await st.client.put(path, { update: { labels: ops } });
              break;
            }
            case 'edit': {
              const fm = await ensureFields(st);
              const fields: Record<string, unknown> = {};
              const update: Record<string, unknown[]> = {};
              for (const [name, value] of Object.entries(p.fields ?? {})) {
                if (name === 'title') fields.summary = String(value);
                else if (name === 'description' || name === 'body') fields.description = value === null ? null : markdownToAdf(String(value));
                else if (name === 'labels') {
                  const want = new Set((value as string[] | null) ?? []);
                  const have = new Set(before.fields?.labels ?? []);
                  const ops = [...[...want].filter((l) => !have.has(l)).map((l) => ({ add: l })), ...[...have].filter((l) => !want.has(l)).map((l) => ({ remove: l }))];
                  if (ops.length) update.labels = ops;
                } else if (name === 'estimate' && (fm.declared.estimate ?? fm.estimate)) fields[(fm.declared.estimate ?? fm.estimate)!] = value === null ? null : Number(value);
                else if (fm.declared[name]) fields[fm.declared[name]!] = value;
                else return { ok: false, error: say('work.jira.error.unknownField', { field: name }) };
              }
              if (!Object.keys(fields).length && !Object.keys(update).length) return { ok: true, revision: current };
              await write();
              response = await st.client.put(path, { ...(Object.keys(fields).length ? { fields } : {}), ...(Object.keys(update).length ? { update } : {}) });
              break;
            }
            case 'transition': {
              const tr = await st.client.get<{ transitions?: { id: string; name: string; to?: { name?: string; statusCategory?: { key?: string } }; fields?: Record<string, { required?: boolean; hasDefaultValue?: boolean; name?: string }> }[] }>(
                `${path}/transitions?expand=transitions.fields`);
              const list = tr.transitions ?? [];
              const fromName = before.fields?.status?.name ?? '';
              const wantName = p.toName?.toLowerCase();
              const pick = wantName
                ? list.find((x) => x.to?.name?.toLowerCase() === wantName) ?? list.find((x) => x.name.toLowerCase() === wantName)
                : list.find((x) => stateCategory(x.to?.statusCategory?.key) === (p.to as StateCategory) && x.to?.name !== fromName);
              // a named target must also be the category asked for: the gate's `to` grant checked the category,
              // so `{ to: 'in-progress', toName: 'Done' }` must not move the item to Done
              const off = pick && p.toName && p.to && stateCategory(pick.to?.statusCategory?.key) !== p.to;
              if (!pick || off) return { ok: false, error: say('work.jira.says.noTransitionTo', { from: fromName, to: off ? `${p.toName} (${p.to})` : p.toName ?? p.to ?? '' }) };
              const screen = pick.fields ?? {};
              const given = (p.fields ?? {}) as Record<string, unknown>;
              const missing = Object.entries(screen).filter(([id, f]) => f.required && !f.hasDefaultValue && given[id] === undefined).map(([id, f]) => f.name ?? id);
              if (missing.length) return { ok: false, error: say('work.jira.error.transitionNeeds', { fields: missing.join(', ') }) };
              const onScreen = Object.fromEntries(Object.entries(given).filter(([id]) => id in screen));
              await write();
              response = await st.client.post(`${path}/transitions`, { transition: { id: pick.id }, ...(Object.keys(onScreen).length ? { fields: onScreen } : {}) });
              break;
            }
            case 'link': {
              const kind = (p.kind ?? 'relates') as LinkKind;
              const target = keyOf(String(p.target ?? ''));
              if (!target) return { ok: false, error: say('work.jira.error.noTarget') };
              const native = typeof p.native === 'string' ? p.native
                : kind === 'blocks' || kind === 'blocked-by' ? 'Blocks'
                : kind === 'duplicates' ? 'Duplicate' : kind === 'relates' ? 'Relates' : undefined;
              if (!native) return { ok: false, error: say('work.jira.error.linkKind', { kind }) };
              // measured: inwardIssue is the one that [outward phrase]s — `inward KAN-1, outward KAN-2` reads *KAN-1 blocks KAN-2*
              const [a, b] = kind === 'blocked-by' ? [target, key] : [key, target];
              await write();
              response = await st.client.post('/rest/api/3/issueLink', { type: { name: native }, inwardIssue: { key: a }, outwardIssue: { key: b } });
              break;
            }
            default:
              return { ok: false, error: say('work.jira.says.cannot', { action: intent.action }) };
          }
          // re-read and hand back what the tracker now says
          const fm = await ensureFields(st);
          const after = await readIssue(st, key, fieldList(fm));
          st.written.add(after.id);
          const item = mapIssue(after, ctxOf(s, st));
          return { ok: true, revision: item.revision, item, raw: { response: response ?? null } };
        } catch (err) {
          if (err instanceof JiraHttpError) {
            if (err.status === 409) return { ok: false, conflict: true, error: say('work.jira.conflict409', { key, reason: err.reason }) };
            return { ok: false, error: say('work.jira.error.refused', { status: err.status, reason: err.reason }) };
          }
          throw err;
        }
      });
    },
  };
  return provider;
}

export const jiraProvider: WorkProvider = createJiraProvider();

/** For tests and diagnostics: which changelog path a connected session measured, and the field origins. */
export function sessionFacts(s: Session): { changelogVia?: string; fields?: FieldMap; fieldOrigin: Record<string, string> } {
  const st = stateOf(s);
  return { ...(st.changelogVia ? { changelogVia: st.changelogVia } : {}), ...(st.fields ? { fields: st.fields } : {}), fieldOrigin: { ...st.fieldOrigin } };
}
