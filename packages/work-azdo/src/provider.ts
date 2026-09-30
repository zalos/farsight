// The Azure DevOps Services work provider (docs/proposals/work-items-sync.md §4, §6.1, §7.3, §8).
//
// Read: WIQL → workitemsbatch (200 a call) on the first pull; the reporting
// revisions feed (continuationToken = watermark) after; a WIQL ChangedDate
// poll when the feed cannot answer. Write: one JSON Patch per intent with
// `test /rev` first; comments through the comments API. Every write can be
// previewed with `validateOnly=true`, which Azure DevOps checks (rules,
// permissions, the rev test) without saving.
//
// The credential lives in a closure inside the HTTP client, which is held in
// a module-private WeakMap keyed by the session — never on the session itself.
import { t } from '@farsight/core';
import type {
  WorkProvider, Capabilities, Session, SourceConfig, Secret, Schema, SchemaState, PullPage, Cursor, Scope,
  WorkItem, WorkAction, Intent, ApplyResult, ProviderVerdict,
} from '@farsight/work';
import { createAzdoHttp, AzdoHttpError, type AzdoHttp, type Fetcher } from './http.js';
import { authorizerFor, type AuthOptions } from './auth.js';
import {
  typeInfo, schemaType, schemaLinkTypes, fieldMap, mapWorkItem, mapComment, mapUpdates,
  type TypeInfo, type MapContext,
} from './map.js';
import { buildPatch, type CurrentItem } from './patch.js';
import { markdownToHtml } from './html.js';

export const AZDO_CAPABILITIES: Capabilities = {
  comments: { read: true, write: true, format: 'markdown' },
  transitions: 'graph',
  concurrency: 'revision',
  permissionsProbe: 'per-area',
  deletesVisible: true,
  push: 'none',
  dryRun: true,
  actions: ['comment', 'edit', 'assign', 'transition', 'link', 'label'],
};

/** CSS (area path) security namespace and the bits used (read live from _apis/securitynamespaces). */
const CSS_NAMESPACE = '83e28ad4-2d72-4ceb-97b0-c7726d5502c3';
const CSS_WORK_ITEM_WRITE = 32;
const TAGGING_NAMESPACE = 'bb50f182-8e5e-40b8-bc21-e8752a1e7ae2';
const TAGGING_CREATE = 2;
const BATCH = 200;
const WIQL_TOP = 19_000; // under the silent 20,000-row truncation
const COMMENTS_PREVIEW = '7.2-preview.4';
const COMMENTS_71 = '7.1-preview.4';

const w = (key: string, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), t(key, 'professional'));

interface Internal {
  http: AzdoHttp;
  cfg: SourceConfig;
  org: string;
  apiVersion: string;
  commentsVersion: string;
  commentsMarkdown: boolean;
  projects: string[];
  projectIds: Map<string, string>;
  ctx?: MapContext;
  /** project → area path → chained security token */
  areaTokens: Map<string, Map<string, string>>;
  schema?: Schema;
}

const INTERNAL = new WeakMap<Session, Internal>();

function inner(s: Session): Internal {
  const i = INTERNAL.get(s);
  if (!i) throw new Error(`Azure DevOps session ${s.sourceId} was not made by this provider's connect()`);
  return i;
}

/** `https://{org}.visualstudio.com` and `https://dev.azure.com/{org}/` → `https://dev.azure.com/{org}`. */
export function normalizeOrg(org: string): string {
  const u = org.trim().replace(/\/+$/, '');
  const vs = /^https?:\/\/([^./]+)\.visualstudio\.com(\/.*)?$/i.exec(u);
  if (vs) return `https://dev.azure.com/${vs[1]}`;
  return u;
}

const keyOf = (workId: string) => workId.slice(workId.lastIndexOf('::') + 2);
const wiqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

interface CursorState { v: 1; p: Record<string, { t?: string; since: string }> }

function readCursor(c: Cursor | null): CursorState | null {
  if (!c) return null;
  try {
    const j = JSON.parse(c);
    if (j && j.v === 1 && typeof j.p === 'object') return j as CursorState;
  } catch { /* fall through */ }
  throw new Error('the Azure DevOps cursor is not one this provider wrote — pull again from the start');
}

export interface AzdoProviderOptions extends AuthOptions {
  fetcher?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  now?: () => number;
}

export function createAzdoProvider(opts: AzdoProviderOptions = {}): WorkProvider & {
  /** the write, checked by Azure DevOps with validateOnly=true and not saved */
  preview(s: Session, intent: Intent): Promise<ApplyResult>;
} {
  const now = opts.now ?? Date.now;

  async function connect(cfg: SourceConfig, secret: Secret | undefined): Promise<Session> {
    if (!cfg.org) throw new Error(`source ${cfg.id}: an Azure DevOps source names its org URL (org)`);
    const org = normalizeOrg(cfg.org);
    const auth = await authorizerFor(cfg, secret, opts);
    const http = createAzdoHttp({ base: org, authorization: auth.header, fetcher: opts.fetcher, sleep: opts.sleep, timeoutMs: opts.timeoutMs, now: opts.now });

    // version probe: the newest connectionData the server answers caps the rest
    let cd: any;
    let probed = '';
    for (const v of ['7.1-preview.1', '7.0-preview.1', '6.0-preview.1', '5.0-preview.1']) {
      try { cd = (await http.request({ path: '/_apis/connectionData', apiVersion: v })).body; probed = v; break; }
      catch (err) {
        if (err instanceof AzdoHttpError && (err.status === 400 || err.status === 404)) continue;
        throw err;
      }
    }
    if (!cd) throw new AzdoHttpError(400, 'no API version this provider knows was accepted');
    const hosted = cd.deploymentType === 'hosted';
    const apiVersion = hosted ? '7.1' : probed.replace(/-preview.*$/, '');
    const commentsMarkdown = hosted;
    const commentsVersion = hosted ? COMMENTS_PREVIEW : apiVersion === '7.1' ? COMMENTS_71 : `${apiVersion}-preview.3`;

    const projects = cfg.scope?.projects ?? [];
    if (!projects.length) throw new Error(`source ${cfg.id}: scope.projects names at least one Azure DevOps project`);
    const internal: Internal = { http, cfg, org, apiVersion, commentsVersion, commentsMarkdown, projects, projectIds: new Map(), areaTokens: new Map() };

    const u = cd.authenticatedUser ?? {};
    const session: Session = {
      sourceId: cfg.id,
      provider: 'azure-devops',
      endpoint: org,
      user: { id: u.subjectDescriptor ?? u.id ?? 'unknown', name: u.providerDisplayName ?? u.customDisplayName ?? 'unknown' },
      apiVersion,
      commentsApiVersion: commentsVersion,
      deploymentType: cd.deploymentType,
      authKind: auth.kind,
    };
    INTERNAL.set(session, internal);
    session.credentialScope = await credentialScope(internal, cfg.mode === 'edit');
    return session;
  }

  /** §7.3 verdict 3. Read: a WIQL answered. Write: a validateOnly no-op patch was accepted. */
  async function credentialScope(i: Internal, probeWrite: boolean): Promise<Session['credentialScope']> {
    const p = i.projects[0]!;
    let ids: number[];
    try {
      const r = await i.http.request({ method: 'POST', path: `/${encodeURIComponent(p)}/_apis/wit/wiql`, apiVersion: i.apiVersion, query: { $top: 5 },
        body: { query: 'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ORDER BY [System.ChangedDate] DESC' } });
      ids = (r.body?.workItems ?? []).map((x: any) => x.id);
    } catch (err) {
      if (err instanceof AzdoHttpError && (err.status === 401 || err.status === 403)) return { read: false, write: false, detail: err.message };
      throw err;
    }
    if (!probeWrite) return { read: true, write: false, detail: w('work.azdo.cred.notChecked') };
    for (const id of ids) {
      try {
        const cur = (await i.http.request({ path: `/_apis/wit/workitems/${id}`, apiVersion: i.apiVersion, query: { fields: 'System.Title' } })).body;
        await i.http.request({ method: 'PATCH', path: `/_apis/wit/workitems/${id}`, apiVersion: i.apiVersion, query: { validateOnly: true },
          contentType: 'application/json-patch+json',
          body: [{ op: 'test', path: '/rev', value: cur.rev }, { op: 'replace', path: '/fields/System.Title', value: cur.fields?.['System.Title'] ?? '' }] });
        return { read: true, write: true, detail: w('work.azdo.cred.canWrite', { key: id }) };
      } catch (err) {
        if (err instanceof AzdoHttpError && (err.status === 401 || err.status === 403)) return { read: true, write: false, detail: w('work.azdo.cred.readOnly', { key: id }) };
        // a rule failure on this item (e.g. a state its type lacks) says nothing about the credential: try the next
      }
    }
    return { read: true, write: false, detail: w('work.azdo.cred.unknown') };
  }

  async function ensureContext(s: Session): Promise<MapContext> {
    const i = inner(s);
    if (!i.ctx) await discover(s);
    return i.ctx!;
  }

  async function discover(s: Session): Promise<Schema> {
    const i = inner(s);
    const { http, apiVersion } = i;
    const all = (await http.request({ path: '/_apis/projects', apiVersion, query: { $top: 500 } })).body?.value ?? [];
    const projects: Schema['projects'] = [];
    const types = new Map<string, Map<string, TypeInfo>>();
    const iterations = new Map<string, Map<string, { start?: string; end?: string }>>();
    const fieldRefs = new Map<string, string[]>();
    const schemaTypes = new Map<string, ReturnType<typeof schemaType>>();
    const states = new Map<string, SchemaState>();
    let schemaFields: Schema['fields'] = [];
    for (const name of i.projects) {
      const pr = all.find((x: any) => x.name.toLowerCase() === name.toLowerCase());
      if (!pr) throw new AzdoHttpError(404, `the project ${name} is not in ${i.org} or this account cannot see it`);
      projects.push({ key: pr.name, name: pr.name, id: pr.id });
      i.projectIds.set(pr.name, pr.id);
      const P = `/${encodeURIComponent(pr.name)}`;
      const tv = (await http.request({ path: `${P}/_apis/wit/workitemtypes`, apiVersion })).body?.value ?? [];
      const tmap = new Map<string, TypeInfo>();
      for (const ty of tv) {
        const ti = typeInfo(ty);
        tmap.set(ti.name, ti);
        const st = schemaType(ti);
        schemaTypes.set(ti.name, st);
        for (const x of st.states ?? []) states.set(`${x.name}|${x.category}`, x);
      }
      types.set(pr.name, tmap);
      const fv = (await http.request({ path: `${P}/_apis/wit/fields`, apiVersion })).body?.value ?? [];
      const fm = fieldMap(fv, i.cfg.fields ?? {});
      for (const f of fm) {
        if (!f.canonical) continue;
        const list = fieldRefs.get(f.canonical) ?? [];
        if (!list.includes(f.id)) (f.origin === 'declared' ? list.unshift(f.id) : list.push(f.id));
        fieldRefs.set(f.canonical, list);
      }
      schemaFields = mergeFields(schemaFields, fm);
      // iterations of the project's default team → dates by path (best effort: a team may be unset)
      const imap = new Map<string, { start?: string; end?: string }>();
      try {
        const iv = (await http.request({ path: `${P}/_apis/work/teamsettings/iterations`, apiVersion })).body?.value ?? [];
        for (const it of iv) imap.set(it.path, { start: it.attributes?.startDate ?? undefined, end: it.attributes?.finishDate ?? undefined });
      } catch { /* no default team settings: iterations keep their names only */ }
      iterations.set(pr.name, imap);
      // area classification nodes → chained CSS tokens by area path
      const tokens = new Map<string, string>();
      try {
        const root = (await http.request({ path: `${P}/_apis/wit/classificationnodes/Areas`, apiVersion, query: { $depth: 14 } })).body;
        const walk = (n: any, path: string, chain: string) => {
          const token = chain ? `${chain}:vstfs:///Classification/Node/${n.identifier}` : `vstfs:///Classification/Node/${n.identifier}`;
          tokens.set(path, token);
          for (const c of n.children ?? []) walk(c, `${path}\\${c.name}`, token);
        };
        if (root?.identifier) walk(root, root.name, '');
      } catch { /* permission check falls back to "could not ask" */ }
      i.areaTokens.set(pr.name, tokens);
    }
    const rel = (await http.request({ path: '/_apis/wit/workitemrelationtypes', apiVersion })).body?.value ?? [];
    i.ctx = { sourceId: s.sourceId, org: i.org, types, iterations, fields: fieldRefs };
    i.schema = {
      projects,
      types: [...schemaTypes.values()],
      states: [...states.values()],
      fields: schemaFields,
      linkTypes: schemaLinkTypes(rel),
      bodyFormat: 'html',
    };
    return i.schema;
  }

  function mergeFields(a: Schema['fields'], b: Schema['fields']): Schema['fields'] {
    const seen = new Set(a.map((f) => `${f.id}|${f.canonical ?? ''}`));
    return [...a, ...b.filter((f) => !seen.has(`${f.id}|${f.canonical ?? ''}`))];
  }

  function areaClause(scope: Scope): string {
    const areas = scope.areas ?? [];
    if (!areas.length) return '';
    return ` AND (${areas.map((a) => `[System.AreaPath] UNDER ${wiqlString(a)}`).join(' OR ')})`;
  }

  function inAreas(item: WorkItem, scope: Scope): boolean {
    const areas = scope.areas ?? [];
    if (!areas.length) return true;
    const a = (item.area ?? '').toLowerCase();
    return areas.some((x) => a === x.toLowerCase() || a.startsWith(x.toLowerCase() + '\\'));
  }

  async function batch(i: Internal, ids: number[]): Promise<{ found: any[]; missing: number[] }> {
    const found: any[] = [];
    const missing: number[] = [];
    for (let k = 0; k < ids.length; k += BATCH) {
      const chunk = ids.slice(k, k + BATCH);
      const r = await i.http.request({ method: 'POST', path: '/_apis/wit/workitemsbatch', apiVersion: i.apiVersion,
        body: { ids: chunk, $expand: 'relations', errorPolicy: 'omit' } });
      const vals: any[] = r.body?.value ?? [];
      vals.forEach((v, n) => { if (v) found.push(v); else missing.push(chunk[n]!); });
    }
    return { found, missing };
  }

  /** Drain the reporting feed to its end; returns the watermark and what moved. */
  async function drainFeed(i: Internal, project: string, token: string | undefined): Promise<{ token: string; changed: Set<number>; deleted: Set<number> }> {
    const changed = new Set<number>();
    const deleted = new Set<number>();
    let t = token;
    for (let guard = 0; guard < 10_000; guard++) {
      const r = await i.http.request({ path: `/${encodeURIComponent(project)}/_apis/wit/reporting/workitemrevisions`, apiVersion: i.apiVersion,
        query: { continuationToken: t, includeDeleted: true, includeLatestOnly: true, fields: 'System.Id,System.IsDeleted,System.Rev' } });
      for (const v of r.body?.values ?? []) {
        const id = Number(v.id ?? v.fields?.['System.Id']);
        if (!Number.isFinite(id)) continue;
        if (v.fields?.['System.IsDeleted'] === true) { deleted.add(id); changed.delete(id); }
        else { changed.add(id); deleted.delete(id); }
      }
      if (r.body?.continuationToken) t = r.body.continuationToken;
      if (r.body?.isLastBatch !== false) break;
    }
    if (!t) throw new AzdoHttpError(0, 'the revisions feed answered without a watermark');
    return { token: t, changed, deleted };
  }

  async function wiqlIds(i: Internal, project: string, where: string, timePrecision = false): Promise<{ ids: number[]; asOf?: string }> {
    const ids: number[] = [];
    let last = 0;
    let asOf: string | undefined;
    for (;;) {
      const r = await i.http.request({ method: 'POST', path: `/${encodeURIComponent(project)}/_apis/wit/wiql`, apiVersion: i.apiVersion,
        query: { $top: WIQL_TOP, timePrecision: timePrecision || undefined },
        body: { query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project${where} AND [System.Id] > ${last} ORDER BY [System.Id] ASC` } });
      asOf ??= r.body?.asOf;
      const page: number[] = (r.body?.workItems ?? []).map((x: any) => x.id);
      ids.push(...page);
      if (page.length < WIQL_TOP) break;
      last = page.at(-1)!;
    }
    return { ids, asOf };
  }

  async function* pull(s: Session, cursor: Cursor | null, scope: Scope): AsyncIterable<PullPage> {
    const i = inner(s);
    const ctx = await ensureContext(s);
    const prior = readCursor(cursor);
    const next: CursorState = { v: 1, p: {} };
    const projects = scope.projects?.length ? scope.projects : i.projects;
    let pending: PullPage | null = null;
    const deletedAll: string[] = [];
    const emit = function* (items: WorkItem[]): Generator<PullPage> {
      if (pending) yield pending;
      pending = { items, cursor: null, isLast: false };
    };
    for (const project of projects) {
      const was = prior?.p[project];
      let ids: number[] = [];
      let since = new Date(now()).toISOString();
      if (!was) {
        // the watermark first, then the ids: anything changed between the two is fetched twice, never missed
        let token: string | undefined;
        try { token = (await drainFeed(i, project, undefined)).token; } catch (err) { if (isAuth(err)) throw err; }
        const q = await wiqlIds(i, project, areaClause(scope));
        ids = q.ids;
        if (q.asOf) since = q.asOf;
        next.p[project] = { t: token, since };
      } else {
        let fedBy = 'feed';
        if (was.t) {
          try {
            const f = await drainFeed(i, project, was.t);
            ids = [...f.changed];
            for (const d of f.deleted) deletedAll.push(`work::${s.sourceId}::${d}`);
            next.p[project] = { t: f.token, since };
          } catch (err) { if (isAuth(err)) throw err; fedBy = 'wiql'; }
        } else fedBy = 'wiql';
        if (fedBy === 'wiql') {
          // fallback: no hard deletes seen this way, and a query is the rate-limit trigger Microsoft names
          const q = await wiqlIds(i, project, `${areaClause(scope)} AND [System.ChangedDate] > ${wiqlString(was.since)}`, true);
          ids = q.ids;
          next.p[project] = { since: q.asOf ?? since };
        }
      }
      for (let k = 0; k < ids.length; k += BATCH) {
        const { found, missing } = await batch(i, ids.slice(k, k + BATCH));
        for (const m of missing) deletedAll.push(`work::${s.sourceId}::${m}`);
        const items: WorkItem[] = [];
        for (const raw of found) {
          const item = mapWorkItem(raw, ctx);
          if (inAreas(item, scope)) items.push(item);
          else if (was) deletedAll.push(item.id); // moved out of the scoped areas
        }
        yield* emit(items);
      }
    }
    const last: PullPage = pending ?? { items: [], cursor: null, isLast: false };
    last.cursor = JSON.stringify(next);
    last.isLast = true;
    if (deletedAll.length) last.deleted = [...new Set(deletedAll)];
    yield last;
  }

  async function comments(i: Internal, project: string, id: string): Promise<any[]> {
    const out: any[] = [];
    let token: string | undefined;
    for (let guard = 0; guard < 1000; guard++) {
      let r;
      try {
        r = await i.http.request({ path: `/${encodeURIComponent(project)}/_apis/wit/workItems/${id}/comments`, apiVersion: i.commentsVersion,
          query: { continuationToken: token, $top: 200 } });
      } catch (err) {
        // a retired preview: fall back to 7.1-preview.4 (text only) once
        if (err instanceof AzdoHttpError && err.status === 400 && i.commentsVersion !== COMMENTS_71) {
          i.commentsVersion = COMMENTS_71; i.commentsMarkdown = false; continue;
        }
        throw err;
      }
      out.push(...(r.body?.comments ?? []));
      token = r.body?.continuationToken;
      if (!token) break;
    }
    return out;
  }

  async function updates(i: Internal, project: string, id: string): Promise<any[]> {
    const out: any[] = [];
    for (let skip = 0; ; skip += 200) {
      const r = await i.http.request({ path: `/${encodeURIComponent(project)}/_apis/wit/workItems/${id}/updates`, apiVersion: i.apiVersion, query: { $top: 200, $skip: skip || undefined } });
      const v: any[] = r.body?.value ?? [];
      out.push(...v);
      if (v.length < 200) break;
    }
    return out;
  }

  async function hydrate(s: Session, ids: string[]): Promise<WorkItem[]> {
    const i = inner(s);
    const ctx = await ensureContext(s);
    const nums = ids.map(keyOf).map(Number).filter(Number.isFinite);
    const { found } = await batch(i, nums);
    const out: WorkItem[] = [];
    for (const raw of found) {
      const item = mapWorkItem(raw, ctx);
      const project = String(raw.fields?.['System.TeamProject']);
      item.history = mapUpdates(await updates(i, project, item.key));
      item.comments = (await comments(i, project, item.key)).filter((c) => !c.isDeleted).map(mapComment);
      out.push(item);
    }
    return out;
  }

  async function can(s: Session, item: WorkItem, action: WorkAction): Promise<ProviderVerdict> {
    const i = inner(s);
    const ctx = await ensureContext(s);
    if (!AZDO_CAPABILITIES.actions!.includes(action)) return { allowed: false, reason: w('work.azdo.says.cannotCreate') };
    const project = String((item.raw as any)?.fields?.['System.TeamProject'] ?? i.projects[0]);
    const ti = ctx.types.get(project)?.get(item.type.name);
    if (item.fields?.stateUndefinedByType || (ti && !ti.states.has(item.state.name))) {
      return { allowed: false, reason: w('work.azdo.says.stateUndefined', { state: item.state.name, type: item.type.name }) };
    }
    if (action === 'transition' && ti) {
      const reachable = (ti.transitions[item.state.name] ?? []).filter((x) => x !== item.state.name);
      if (!reachable.length) return { allowed: false, reason: w('work.azdo.says.noMove', { type: item.type.name, state: item.state.name }) };
    }
    const areaToken = i.areaTokens.get(project)?.get(item.area ?? project);
    if (!areaToken) return { allowed: true, reason: w('work.azdo.says.unasked', { why: 'the area is not known' }) };
    const evaluations = [{ securityNamespaceId: CSS_NAMESPACE, token: areaToken, permissions: CSS_WORK_ITEM_WRITE }];
    const pid = i.projectIds.get(project);
    if (action === 'label' && pid) evaluations.push({ securityNamespaceId: TAGGING_NAMESPACE, token: `/${pid}`, permissions: TAGGING_CREATE });
    let values: boolean[];
    try {
      const r = await i.http.request({ method: 'POST', path: '/_apis/security/permissionevaluationbatch', apiVersion: i.apiVersion,
        body: { alwaysAllowAdministrators: false, evaluations } });
      values = (r.body?.evaluations ?? []).map((e: any) => e.value === true);
    } catch (err) {
      return { allowed: true, reason: w('work.azdo.says.unasked', { why: err instanceof AzdoHttpError ? err.reason : 'no answer' }) };
    }
    if (!values[0]) return { allowed: false, reason: w('work.azdo.says.notOnArea', { area: item.area ?? project }) };
    if (action === 'label' && values[1] === false) return { allowed: true, reason: w('work.azdo.says.existingTagsOnly') };
    return { allowed: true, reason: w('work.azdo.says.yes') };
  }

  async function write(s: Session, intent: Intent, validateOnly: boolean): Promise<ApplyResult> {
    const i = inner(s);
    const ctx = await ensureContext(s);
    const id = keyOf(intent.item);
    if (!/^\d+$/.test(id)) return { ok: false, error: `${intent.item} is not an Azure DevOps work item` };
    if (intent.action === 'create') return { ok: false, error: w('work.azdo.says.cannotCreate') };
    let cur: any;
    try {
      cur = (await i.http.request({ path: `/_apis/wit/workitems/${id}`, apiVersion: i.apiVersion })).body;
    } catch (err) { return failed(err); }
    const base = intent.baseRevision;
    if (base !== undefined && String(cur.rev) !== String(base)) {
      return { ok: false, conflict: true, revision: String(cur.rev), error: w('work.azdo.conflict', { base, now: cur.rev }) };
    }
    const project = String(cur.fields?.['System.TeamProject']);

    if (intent.action === 'comment') {
      const text = String(intent.payload?.body ?? '');
      if (!text.trim()) return { ok: false, error: 'a comment has words' };
      if (validateOnly) return { ok: true, revision: String(cur.rev), raw: { checked: 'revision only', note: w('work.azdo.dryRun.comment') } };
      try {
        const md = i.commentsMarkdown;
        const r = await i.http.request({ method: 'POST', path: `/${encodeURIComponent(project)}/_apis/wit/workItems/${id}/comments`,
          apiVersion: i.commentsVersion, query: md ? { format: 'markdown' } : {},
          body: { text: md ? text : markdownToHtml(text) } });
        const after = (await i.http.request({ path: `/_apis/wit/workitems/${id}`, apiVersion: i.apiVersion, query: { fields: 'System.Rev' } })).body;
        return { ok: true, revision: String(after?.rev ?? ''), raw: r.body };
      } catch (err) { return failed(err); }
    }

    const current: CurrentItem = { id, rev: cur.rev, fields: cur.fields ?? {}, multilineFieldsFormat: cur.multilineFieldsFormat };
    const built = buildPatch(intent, current, {
      org: i.org,
      type: ctx.types.get(project)?.get(String(cur.fields?.['System.WorkItemType'])),
      fieldRef: (c) => ctx.fields.get(c)?.find((ref) => ref in (cur.fields ?? {})) ?? ctx.fields.get(c)?.[0],
    });
    if ('error' in built) return { ok: false, error: built.error };
    try {
      const r = await i.http.request({ method: 'PATCH', path: `/_apis/wit/workitems/${id}`, apiVersion: i.apiVersion,
        query: validateOnly ? { validateOnly: true } : {}, contentType: 'application/json-patch+json', body: built.ops });
      if (validateOnly) return { ok: true, revision: String(cur.rev), raw: { validateOnly: true, ops: built.ops } };
      // re-read after the write: the engine replaces the cached item with what the tracker now says
      const after = (await i.http.request({ path: `/_apis/wit/workitems/${id}`, apiVersion: i.apiVersion, query: { fields: 'System.Rev' } })).body;
      return { ok: true, revision: String(after?.rev ?? r.body?.rev ?? ''), raw: r.body };
    } catch (err) { return failed(err); }
  }

  function failed(err: unknown): ApplyResult {
    if (err instanceof AzdoHttpError) {
      const conflict = err.status === 412 || err.typeKey === 'TestPatchOperationFailedException';
      const r: ApplyResult = { ok: false, error: err.serverMessage ? `${err.reason}: ${err.serverMessage}` : err.message };
      if (conflict) r.conflict = true;
      r.raw = { status: err.status, typeKey: err.typeKey };
      return r;
    }
    return { ok: false, error: (err as Error)?.name === 'AzdoAuthUnavailable' ? (err as Error).message : 'the write did not complete' };
  }

  return {
    id: 'azure-devops',
    capabilities: AZDO_CAPABILITIES,
    connect,
    discover,
    pull,
    hydrate,
    can,
    apply: (s, intent) => write(s, intent, false),
    preview: (s, intent) => write(s, intent, true),
  };
}

function isAuth(err: unknown): boolean {
  return err instanceof AzdoHttpError && (err.status === 401 || err.status === 403);
}

/** The provider with the process's real fetch and keychain. */
export const azdoProvider = createAzdoProvider();
