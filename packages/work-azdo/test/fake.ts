// A fake Azure DevOps over the recorded example-org fixtures, served through the
// provider's injectable fetcher (no network, no MSW — ADR 8). The responses were
// recorded from a real org on 2026-09-30 (read-only plus validateOnly dry runs,
// no credential in them), then re-synthesized: org, project, people, ids, titles
// and bodies are placeholders; fields, revs, paging and shapes are as recorded.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const FIX = join(here, 'fixtures', 'example-org');

/** A recorded response body. */
export function rec(name: string): any {
  return JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8')).body;
}
export function recStatus(name: string): number {
  return JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8')).status;
}

export interface Seen { method: string; path: string; query: URLSearchParams; body: any; auth: string | null }
export type Handler = (req: Seen) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

export interface FakeOptions {
  /** extra handlers tried before the defaults (first answer wins) */
  handlers?: Handler[];
  /** work items by id (raw ADO shape); defaults to the recorded four */
  items?: Map<number, any>;
}

export function fakeAdo(opts: FakeOptions = {}) {
  const seen: Seen[] = [];
  const items = opts.items ?? new Map<number, any>(rec('batch').value.map((v: any) => [v.id, structuredClone(v)]));
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const defaults: Handler = (r) => {
    const p = r.path;
    if (p === '/_apis/connectionData') return { body: rec('connectionData') };
    if (p === '/_apis/projects') return { body: rec('projects') };
    if (p === '/ExampleProject/_apis/wit/workitemtypes') return { body: rec('workitemtypes') };
    if (p === '/ExampleProject/_apis/wit/fields') return { body: rec('fields') };
    if (p === '/ExampleProject/_apis/work/teamsettings/iterations') return { body: rec('iterations') };
    if (p === '/ExampleProject/_apis/wit/classificationnodes/Areas') return { body: rec('classificationnodes').value[0] };
    if (p === '/_apis/wit/workitemrelationtypes') return { body: rec('relationtypes') };
    if (p === '/ExampleProject/_apis/wit/wiql' && r.method === 'POST') {
      const q: string = r.body.query;
      const after = Number(/\[System\.Id\] > (\d+)/.exec(q)?.[1] ?? 0);
      const top = Number(r.query.get('$top') ?? 20000);
      const ids = [...items.keys()].sort((a, b) => a - b).filter((id) => id > after).slice(0, top);
      return { body: { queryType: 'flat', asOf: '2026-09-30T22:31:39.617Z', workItems: ids.map((id) => ({ id })) } };
    }
    if (p === '/_apis/wit/workitemsbatch' && r.method === 'POST') {
      return { body: { count: r.body.ids.length, value: r.body.ids.map((id: number) => items.get(id) ?? null) } };
    }
    if (p === '/ExampleProject/_apis/wit/reporting/workitemrevisions') {
      // one recorded page; a token past it answers an empty last batch
      if (r.query.get('continuationToken')) return { body: { values: [], continuationToken: r.query.get('continuationToken'), isLastBatch: true } };
      return { body: rec('revisions-0') };
    }
    let m = /^\/_apis\/wit\/workitems\/(\d+)$/.exec(p);
    if (m && r.method === 'GET') {
      const it = items.get(Number(m[1]));
      return it ? { body: it } : { status: 404, body: { message: 'not found', typeKey: 'WorkItemNotFoundException' } };
    }
    if (m && r.method === 'PATCH') {
      const it = items.get(Number(m[1]));
      const test = r.body?.[0];
      if (test?.op === 'test' && test.path === '/rev' && test.value !== it.rev) {
        return { status: 412, body: { message: `VS403351: Test Operation for path /rev failed, value ${it.rev} was not equal to test value ${test.value}.`, typeKey: 'TestPatchOperationFailedException' } };
      }
      if (r.query.get('validateOnly') === 'true') return { body: it };
      it.rev += 1;
      return { body: it };
    }
    m = /^\/ExampleProject\/_apis\/wit\/workItems\/(\d+)\/updates$/.exec(p);
    if (m) return { body: rec(`updates-${m[1]}`) };
    m = /^\/ExampleProject\/_apis\/wit\/workItems\/(\d+)\/comments$/.exec(p);
    if (m && r.method === 'GET') return { body: rec(`comments72-${m[1]}`) };
    if (m && r.method === 'POST') {
      const it = items.get(Number(m[1]));
      it.rev += 1;
      return { body: { id: 1, workItemId: it.id, text: r.body.text, format: r.query.get('format') ?? undefined } };
    }
    if (p === '/_apis/security/permissionevaluationbatch') {
      return { body: { evaluations: r.body.evaluations.map((e: any) => ({ ...e, value: e.securityNamespaceId.startsWith('83e2') ? e.permissions !== 512 : e.permissions === 1 })) } };
    }
    return undefined;
  };
  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const headers = new Headers(init.headers as HeadersInit);
    const req: Seen = {
      method: String(init.method ?? 'GET'),
      path: decodeURIComponent(u.pathname.replace(/^\/example-org/, '')),
      query: u.searchParams,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.get('authorization'),
    };
    seen.push(req);
    if (!u.searchParams.get('api-version')) return json(400, { message: 'No api-version was supplied' });
    for (const h of [...(opts.handlers ?? []), defaults]) {
      const out = h(req);
      if (out) return json(out.status ?? 200, out.body, out.headers);
    }
    return json(404, { message: `fake: no route for ${req.method} ${req.path}` });
  };
  return { fetcher, seen, items };
}

export const ORG = 'https://dev.azure.com/example-org';
export const cfg = (extra: Record<string, unknown> = {}) => ({
  id: 'example-azdo', type: 'work' as const, provider: 'azure-devops', org: ORG,
  scope: { projects: ['ExampleProject'] }, auth: { kind: 'pat' as const, secret: 'keychain:farsight/ado-example' }, ...extra,
});
/** A stand-in PAT for fixture tests; never a real one. */
export const FAKE_PAT = 'fake-pat-for-tests';
export const noSleep = async () => {};
