// The Azure DevOps HTTP client — global fetch, nothing else.
//
// The credential never sits on an object: `authorization` is a closure the
// caller builds at connect time, called once per request, and its value goes
// straight into the request headers. Errors carry a status and a short reason
// in words — never a header, never a response body, never the credential.
// The server's own one-line message (e.g. `VS403351: Test Operation … failed`)
// is kept separately on `serverMessage` for the developer register.

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** An ADO call that did not succeed. `message` never carries a header, body or credential. */
export class AzdoHttpError extends Error {
  constructor(
    readonly status: number,
    /** short words: 'unauthorized' | 'forbidden' | 'conflict' | 'rule violation' | 'timeout' | 'unreachable' | … */
    readonly reason: string,
    /** the server's `typeKey` (TestPatchOperationFailedException, RuleValidationException, …) */
    readonly typeKey?: string,
    /** the server's own one-line `message`, clipped; ADO puts no secret in it */
    readonly serverMessage?: string,
  ) {
    super(`Azure DevOps answered ${status || 'nothing'}: ${reason}`);
    this.name = 'AzdoHttpError';
  }
}

export interface AzdoHttpOptions {
  /** org base URL, e.g. https://dev.azure.com/example-org (no trailing slash) */
  base: string;
  /** builds the Authorization header value at call time — `Basic …` / `Bearer …` */
  authorization: () => Promise<string> | string;
  fetcher?: Fetcher;
  timeoutMs?: number;
  /** attempts including the first (default 4) */
  attempts?: number;
  /** injectable for tests */
  sleep?: (ms: number) => Promise<void>;
  /** injectable for tests (jitter) */
  random?: () => number;
  now?: () => number;
}

export interface AzdoRequest {
  method?: 'GET' | 'POST' | 'PATCH';
  /** path under the org, starting with `/` (`/ExampleProject/_apis/wit/wiql`) */
  path: string;
  apiVersion: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  contentType?: string;
}

export interface AzdoResponse<T = any> {
  status: number;
  body: T;
  /** TSTU cost of this request, when the server said (`X-RateLimit-Cost`) */
  cost?: number;
}

const REASONS: Record<number, string> = {
  400: 'the request was refused',
  401: 'unauthorized — the credential was not accepted',
  403: 'forbidden — the credential may not do this',
  404: 'not found',
  409: 'conflict',
  412: 'conflict — the item changed since it was read',
  429: 'rate limited',
  500: 'server error',
  503: 'service unavailable',
};

const RETRYABLE = new Set([429, 503]);

export interface AzdoHttp {
  request<T = any>(req: AzdoRequest): Promise<AzdoResponse<T>>;
  /** the org base URL (no credential) */
  readonly base: string;
}

export function createAzdoHttp(opts: AzdoHttpOptions): AzdoHttp {
  const fetcher: Fetcher = opts.fetcher ?? ((u, i) => fetch(u, i));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  const attempts = Math.max(1, opts.attempts ?? 4);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const base = opts.base.replace(/\/+$/, '');
  // a Retry-After on a 200 (ADO sends one before it starts delaying) holds the next call
  let holdUntil = 0;

  function waitFor(res: Response, attempt: number): number {
    const ra = res.headers.get('retry-after');
    if (ra && /^\d+(\.\d+)?$/.test(ra.trim())) return Math.min(60_000, Number(ra) * 1000);
    const reset = res.headers.get('x-ratelimit-reset');
    if (reset && /^\d+$/.test(reset)) {
      const ms = Number(reset) * 1000 - now();
      if (ms > 0) return Math.min(60_000, ms);
    }
    return Math.min(30_000, 500 * 2 ** attempt);
  }

  async function request<T>(req: AzdoRequest): Promise<AzdoResponse<T>> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) q.set(k, String(v));
    q.set('api-version', req.apiVersion);
    const url = `${base}${req.path}?${q.toString()}`;
    for (let attempt = 0; ; attempt++) {
      const hold = holdUntil - now();
      if (hold > 0) await sleep(hold);
      let res: Response;
      try {
        const headers: Record<string, string> = { Accept: 'application/json', Authorization: await opts.authorization() };
        if (req.body !== undefined) headers['Content-Type'] = req.contentType ?? 'application/json';
        res = await fetcher(url, {
          method: req.method ?? 'GET',
          headers,
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const name = (err as Error)?.name;
        if (name === 'TimeoutError' || name === 'AbortError') throw new AzdoHttpError(0, 'timeout');
        if (attempt + 1 < attempts) { await sleep(Math.round(500 * 2 ** attempt * (0.5 + random()))); continue; }
        throw new AzdoHttpError(0, 'unreachable');
      }
      if (RETRYABLE.has(res.status) && attempt + 1 < attempts) {
        const ms = waitFor(res, attempt);
        await res.body?.cancel().catch(() => {});
        await sleep(Math.round(ms * (1 + 0.25 * random())));
        continue;
      }
      if (res.ok) {
        const ra = res.headers.get('retry-after');
        if (ra && /^\d+(\.\d+)?$/.test(ra.trim())) holdUntil = now() + Math.min(60_000, Number(ra) * 1000);
        const text = await res.text();
        let body: any = undefined;
        if (text) { try { body = JSON.parse(text); } catch { body = undefined; } }
        const costH = res.headers.get('x-ratelimit-cost');
        return { status: res.status, body, cost: costH ? Number(costH) : undefined };
      }
      let typeKey: string | undefined;
      let serverMessage: string | undefined;
      try {
        const j = JSON.parse(await res.text());
        if (typeof j?.typeKey === 'string') typeKey = j.typeKey;
        if (typeof j?.message === 'string') serverMessage = j.message.slice(0, 300);
      } catch { /* not JSON: nothing kept */ }
      let reason = REASONS[res.status] ?? `HTTP ${res.status}`;
      if (typeKey === 'TestPatchOperationFailedException') reason = REASONS[412]!;
      else if (typeKey === 'RuleValidationException') reason = 'rule violation — the work item type refused the change';
      throw new AzdoHttpError(res.status, reason, typeKey, serverMessage);
    }
  }

  return { request, base };
}

/** `Basic base64(':' + pat)` — built at call time by the caller's closure. */
export function basicPat(pat: string): string {
  return 'Basic ' + Buffer.from(':' + pat).toString('base64');
}
