// Replays recorded Jira responses (test/fixtures/*.json) through the provider's
// injectable fetcher. A request is matched to the first unused recording with the
// same method and path (and the same JSON body, when the recording has one).
import { readFileSync } from 'node:fs';

export interface Recorded {
  method: string;
  path: string;
  body?: unknown;
  status: number;
  headers?: Record<string, string>;
  response: unknown;
}

export interface Call { method: string; path: string; body?: unknown; auth: boolean }

export const load = (name: string): Recorded[] =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Recorded[];

// reconcileIssues depends on what this session wrote before; it is asserted where it matters
const norm = (x: unknown) => {
  if (!x || typeof x !== 'object') return x;
  const { reconcileIssues: _r, ...rest } = x as Record<string, unknown>;
  return rest;
};
const same = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

export function replay(...tapes: Recorded[][]) {
  const entries = tapes.flat().map((r) => ({ r, used: false }));
  const calls: Call[] = [];
  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const path = u.pathname + u.search;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method, path, ...(body !== undefined ? { body } : {}), auth: typeof headers.Authorization === 'string' });
    const hit = entries.find((e) => !e.used && e.r.method === method && e.r.path === path && (e.r.body === undefined || same(e.r.body, body)));
    if (!hit) throw new Error(`no recording for ${method} ${path} ${body ? JSON.stringify(body).slice(0, 200) : ''}`);
    hit.used = true;
    const nullBody = [204, 205, 304].includes(hit.r.status);
    return new Response(nullBody ? null : JSON.stringify(hit.r.response), { status: hit.r.status, headers: hit.r.headers ?? {} });
  };
  return { fetcher, calls, unused: () => entries.filter((e) => !e.used).map((e) => `${e.r.method} ${e.r.path}`) };
}

export const SOURCE = {
  id: 'jira-example',
  type: 'work' as const,
  provider: 'jira',
  site: 'https://example.atlassian.net',
  scope: { projects: ['KAN', 'SAM1'] },
  auth: { kind: 'api-token' as const, user: 'dev@example.com', secret: 'env:UNUSED' },
};

/** A made-up token: fixtures never held the real one, and tests pass this one in. */
export const FAKE_TOKEN = 'fake-token-for-replay-0000';
