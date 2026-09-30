// A stand-in for Lane D's /api/work routes (the contract in work-api.md), built
// from the JSON under e2e/fixture/work/. The WORK specs install it with
// `routeWork(page)`; the screenshot server imports the same class. It keeps
// state per instance, so an intent that is applied changes the item the next
// GET returns — the way the real cache replaces an item after a re-read.
//
// Where the real routes can produce a state with the fixture provider, a spec
// should prefer them; this stays for the states they cannot (an unreachable
// source, a conflict, a pending agent comment) and for faults.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixture', 'work');
const load = (f: string): Json => JSON.parse(readFileSync(join(DIR, f), 'utf8'));

const CATS = ['todo', 'in-progress', 'done', 'removed'] as const;
const PART: Record<string, string> = { todo: 'count.part.workTodo', 'in-progress': 'count.part.workInProgress', done: 'count.part.workDone', removed: 'count.part.workRemoved' };

/** A typed count the way core `counted()` builds one. */
function counted(n: number, unit: string, scope: string, source: string, breakdown?: Json[], bizUnit?: string): Json {
  return { n, unit, bizUnit: bizUnit ?? unit, scope, source, ...(breakdown && breakdown.length ? { breakdown } : {}) };
}
function byState(items: Json[], scope: string, unit = 'count.unit.workItems'): Json {
  const parts = CATS.map((c) => ({ key: PART[c], n: items.filter((i) => i.state.category === c).length })).filter((p) => p.n);
  return counted(items.length, unit, scope, 'items[].state.category', parts);
}

export class WorkStub {
  sources: Json[] = load('sources.json');
  items: Json[] = load('items.json');
  joins: Record<string, Json> = load('joins.json');
  diffs: Record<string, Json> = load('diffs.json');
  people: Record<string, Json[]> = load('people.json');
  states: Record<string, Json[]> = load('states.json');
  flows: Record<string, string[]> = load('flows.json');
  outbox: Json[] = load('outbox.json');
  /** every POST body the page sent, in order — what a spec asserts payloads on */
  posts: { path: string; body: Json }[] = [];
  private seq = 100;

  item(id: string): Json | undefined { return this.items.find((i) => i.id === id); }

  summary(i: Json): Json {
    const j = this.joins[i.id] || { links: [], commits: [] };
    return {
      id: i.id, key: i.key, url: i.url, source: i.source, provider: i.provider, type: i.type, title: i.title, state: i.state,
      ...(i.assignee ? { assignee: i.assignee } : {}), labels: i.labels, ...(i.parent ? { parent: i.parent } : {}), updated: i.updated,
      links: counted(j.links.length, 'count.unit.workLinks', 'count.scope.workItem', 'links[] (tracks edges)'),
      commits: counted(j.commits.length, 'work.hud.count.commits', 'count.scope.workItem', 'commits[]', undefined, 'work.hud.count.commitsBiz'),
    };
  }

  card(s: Json): Json {
    const mine = this.items.filter((i) => i.source === s.id);
    return { ...s, counts: { items: byState(mine, 'count.scope.workSource') } };
  }

  list(q: URLSearchParams): Json {
    let items = this.items.slice();
    const src = q.get('source'), state = q.get('state'), who = q.get('assignee'), text = (q.get('q') || '').toLowerCase();
    if (src) items = items.filter((i) => i.source === src);
    if (state) items = items.filter((i) => i.state.category === state);
    if (who) items = items.filter((i) => (who === 'none' ? !i.assignee : i.assignee && i.assignee.id === who));
    if (text) items = items.filter((i) => (i.key + ' ' + i.title + ' ' + i.labels.join(' ')).toLowerCase().includes(text));
    items.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    return {
      sources: this.sources.map((s) => this.card(s)),
      items: items.map((i) => this.summary(i)),
      counts: {
        items: byState(items, 'count.scope.workSources'),
        sources: counted(this.sources.length, 'work.hud.count.sources', 'count.scope.workspace', 'sources[]'),
      },
      generatedAt: '2026-09-30T10:00:00.000Z', sync: 1,
    };
  }

  detail(id: string): Json {
    const i = this.item(id);
    if (!i) return null;
    const s = this.sources.find((x) => x.id === i.source);
    const j = this.joins[id] || { links: [], commits: [], findings: [] };
    const nodes = new Map<string, string>();
    for (const c of j.commits) for (const n of c.nodes) nodes.set(n, n.includes('::route::') ? 'route' : n.includes('::page::') ? 'page' : /\/[A-Z]\w+\.tsx::[A-Z]/.test(n) ? 'component' : 'function');
    const kinds: Record<string, number> = {};
    for (const k of nodes.values()) kinds[k] = (kinds[k] || 0) + 1;
    const edit = s.mode === 'edit';
    const allow = (policy: boolean, reason: string) => ({ policy: edit && policy, reason: edit ? reason : 'the source is read-only' });
    return {
      item: i,
      links: j.links.map((l: Json) => ({ ...l, kind: l.nodeId.includes('::route::') ? 'route' : l.nodeId.includes('::page::') ? 'page' : 'function', name: l.nodeId.split('::').pop() })),
      commits: j.commits,
      touched: counted(nodes.size, 'work.hud.count.touched', 'count.scope.workItem', 'commits[].nodes',
        Object.entries(kinds).map(([k, n]) => ({ key: 'work.hud.part.parts', n, label: k }))),
      findings: j.findings || [],
      freshness: s.freshness, mode: s.mode, capabilities: s.capabilities, previewable: !!(s.capabilities && s.capabilities.dryRun),
      allowed: {
        comment: allow(true, 'comments are granted to people'), assign: allow(true, 'assigning is granted to people, with a confirmation'),
        transition: allow(true, 'moving to in progress or done is granted to people'), edit: allow(true, 'title and description edits are granted to people'),
        label: allow(false, 'no grant names labels'), link: allow(false, 'no grant names links'),
      },
    };
  }

  verdicts(tracker = true, trackerReason = 'the item is open to this user'): Json {
    return {
      policy: { allowed: true, reason: 'your policy grants this to people' },
      tracker: { allowed: tracker, reason: trackerReason },
      credential: { allowed: true, reason: 'the API token can write work items' },
    };
  }

  /** What POST /api/work/intent answers, by action — one state each, so every render is reachable. */
  intent(body: Json): Json {
    const it = this.item(body.item);
    const intent = { id: 'int-' + ++this.seq, item: body.item, action: body.action, payload: body.payload, requestedBy: body.requestedBy, baseRevision: body.baseRevision };
    if (!it) return { intent, verdicts: this.verdicts(), status: 'failed', error: 'no such item' };
    // a dry run checks and saves nothing (Azure DevOps validateOnly)
    if (body.dryRun) return { intent, verdicts: this.verdicts(true, 'the rules of this type accept the change'), status: 'previewed', preview: { ok: true, reason: 'ok' } };
    if (body.action === 'comment') {
      it.comments = [...it.comments, { id: 'c' + this.seq, author: { id: body.requestedBy.id, name: 'Ada Okafor' }, created: '2026-09-30T10:01:00.000Z', body: { format: 'markdown', raw: body.payload.body, text: body.payload.body } }];
      return { intent, verdicts: this.verdicts(), status: 'applied', item: it };
    }
    if (body.action === 'assign') {
      const pending = { ...intent, key: it.key, status: 'pending', verdicts: this.verdicts() };
      this.outbox.unshift(pending);
      return { intent, verdicts: this.verdicts(), status: 'pending' };
    }
    if (body.action === 'transition') {
      if (it.key === 'INV-8') return { intent, verdicts: this.verdicts(false, 'the workflow has no transition out of Done for this user'), status: 'denied' };
      // the server reads `to` as a category when it is one, else as the tracker's state name
      const st = (this.states[it.source] || []).find((s: Json) => s.name === body.payload.to || s.category === body.payload.to);
      it.state = { name: st ? st.name : body.payload.to, category: st ? st.category : body.payload.to, since: '2026-09-30T10:01:00.000Z' };
      return { intent, verdicts: this.verdicts(), status: 'applied', item: it };
    }
    if (body.action === 'edit') {
      // the tracker moved on since the cache read it: a conflict, the tracker's copy beside the ask
      const theirs = { ...it, title: it.title + ' (edited in Jira)', revision: '2026-09-30T09:59:00.000Z' };
      const c = { ...intent, key: it.key, status: 'conflict', verdicts: this.verdicts(), theirs };
      this.outbox.unshift(c);
      return { intent, verdicts: this.verdicts(), status: 'conflict', item: theirs };
    }
    return { intent, verdicts: this.verdicts(), status: 'failed', error: 'not in the stub' };
  }

  settle(intentId: string, verb: string): Json {
    const o = this.outbox.find((x) => x.id === intentId);
    if (!o) return { status: 'failed', error: 'no such intent', verdicts: this.verdicts() };
    this.outbox = this.outbox.filter((x) => x !== o);
    const intent = { id: o.id, item: o.item, action: o.action, payload: o.payload, requestedBy: o.requestedBy };
    if (verb === 'drop') return { intent, verdicts: o.verdicts, status: 'failed', error: 'dropped — nothing was written' };
    const it = this.item(o.item);
    if (o.action === 'assign') {
      const p = Object.values(this.people).flat().find((x: Json) => x.id === o.payload.assignee);
      if (p) it.assignee = p; else delete it.assignee;
    }
    if (o.action === 'edit' && o.payload.title) it.title = o.payload.title;
    if (o.action === 'edit' && o.payload.description != null) it.body = { format: 'markdown', raw: o.payload.description, text: o.payload.description };
    if (o.action === 'comment') it.comments = [...it.comments, { id: 'c' + ++this.seq, author: { id: 'agent', name: 'Ada Okafor' }, created: '2026-09-30T10:02:00.000Z', requestedBy: o.requestedBy, body: { format: 'markdown', raw: 'via Farsight (agent): ' + o.payload.body, text: 'via Farsight (agent): ' + o.payload.body } }];
    it.updated = '2026-09-30T10:02:00.000Z';
    return { intent, verdicts: o.verdicts, status: 'applied', item: it };
  }

  flow(id: string): Json {
    const ids = this.flows[id] || [];
    const items = ids.map((x) => this.item(x)).filter(Boolean);
    return { flow: id, items: items.map((i) => this.summary(i)), counts: { items: byState(items, 'work.hud.scope.flow'), byState: byState(items, 'work.hud.scope.flow') }, findings: [] };
  }

  links(node: string): Json {
    const items = this.items.filter((i) => (this.joins[i.id]?.links || []).some((l: Json) => l.nodeId === node));
    return { node, items: items.map((i) => this.summary(i)), counts: { items: byState(items, 'work.hud.scope.node') } };
  }

  /** Answer one request: `{ status, json }`, or null for a path the contract does not name. */
  answer(method: string, pathAndQuery: string, body?: Json): { status: number; json: Json } | null {
    const u = new URL(pathAndQuery, 'http://stub');
    const p = u.pathname;
    const ok = (json: Json) => ({ status: 200, json });
    const nf = (what: string) => ({ status: 404, json: { error: 'unknown ' + what } });
    if (method === 'POST') this.posts.push({ path: p, body });
    if (method === 'GET' && p === '/api/work') return ok(this.list(u.searchParams));
    let m = /^\/api\/work\/item\/([^/]+)\/diff$/.exec(p);
    if (m && method === 'GET') { const d = this.diffs[u.searchParams.get('sha') || '']; return d ? ok(d) : ok({ error: 'no such commit in this source' }); }
    m = /^\/api\/work\/item\/([^/]+)$/.exec(p);
    if (m && method === 'GET') { const d = this.detail(decodeURIComponent(m[1])); return d ? ok(d) : nf('work item'); }
    if (p === '/api/work/links' && method === 'GET') return ok(this.links(u.searchParams.get('node') || ''));
    m = /^\/api\/work\/flow\/(.+)$/.exec(p);
    if (m && method === 'GET') return ok(this.flow(decodeURIComponent(m[1])));
    if (p === '/api/work/people') return ok({ people: this.people[u.searchParams.get('source') || ''] || [] });
    if (p === '/api/work/states') return ok({ states: this.states[u.searchParams.get('source') || ''] || [] });
    if (p === '/api/work/outbox') {
      const src = u.searchParams.get('source');
      return ok({ intents: this.outbox.filter((o) => !src || String(o.item).startsWith('work::' + src + '::')) });
    }
    if (p === '/api/work/audit') return ok({ rows: [] });
    if (p === '/api/work/sync' && method === 'POST') {
      for (const s of this.sources) if (s.freshness.state === 'synced') s.freshness = { ...s.freshness, ago: 0, syncNo: (s.freshness.syncNo || 0) + 1 };
      return ok({ reports: this.sources.map((s) => ({ source: s.id, ok: s.freshness.state === 'synced' })) });
    }
    if (p === '/api/work/intent' && method === 'POST') return ok(this.intent(body));
    m = /^\/api\/work\/intent\/([^/]+)\/(confirm|drop|rebase)$/.exec(p);
    if (m && method === 'POST') return ok(this.settle(decodeURIComponent(m[1]), m[2]));
    return null;
  }
}

/** Serve the stub to the page for every /api/work request. Returns the stub so a spec can read `posts`. */
export async function routeWork(page: Page, stub = new WorkStub()): Promise<WorkStub> {
  await page.route(/\/api\/work(\/|\?|$)/, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    let body: Json;
    try { body = req.postDataJSON(); } catch { body = undefined; }
    const a = stub.answer(req.method(), url.pathname + url.search, body);
    if (!a) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not in the stub' }) });
    return route.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.json) });
  });
  return stub;
}

/**
 * Add the fixture's two work sources to /api/settings, so the chips elsewhere
 * (Portfolio, the journey header, the inspector) know there is work to ask
 * about — a workspace with no work source asks nothing.
 */
export async function routeWorkSettings(page: Page, theme?: string): Promise<void> {
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const s = await res.json();
    if (theme) s.theme = theme;
    s.sources = [...(s.sources || []),
      { id: 'invoice-jira', name: 'invoice-jira', type: 'work', provider: 'jira', site: 'https://invoice-app.atlassian.net', scope: { projects: ['INV'] }, mode: 'edit', enabled: true },
      { id: 'invoice-azdo', name: 'invoice-azdo', type: 'work', provider: 'azure-devops', org: 'https://dev.azure.com/invoice-app', scope: { projects: ['Invoicing'] }, mode: 'read-only', enabled: true }];
    return route.fulfill({ response: res, json: s });
  });
}
