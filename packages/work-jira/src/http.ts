// A small Jira Cloud REST client over global fetch. There is no shared HTTP
// client in the workspace (core/src/storybook.ts is the fail-soft precedent);
// this one adds what a tracker needs: basic auth, per-call timeouts, and
// retries with jitter on 429/503 that honour Retry-After and X-RateLimit-Reset.
//
// The secret is held in this module's closure only. The Authorization header
// is built at call time and never stored on an object, logged, or put in an
// error: JiraHttpError carries a status and a reason in words, and the reason
// is scrubbed of the secret and the encoded header before it is kept.

/** Injectable for tests (the storybook.ts Fetcher pattern). */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Why a call failed, in words. Never carries headers, and never the secret. */
export class JiraHttpError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly method: string,
    readonly path: string,
  ) {
    super(`Jira ${method} ${path} → ${status || 'no answer'}: ${reason}`);
    this.name = 'JiraHttpError';
  }
}

/** What the last response said about rate limits (for diagnostics; never secret). */
export interface RateLimitState {
  limit?: number;
  remaining?: number;
  nearLimit?: boolean;
  reason?: string;
}

export interface RequestOptions {
  body?: unknown;
  /** per-call timeout; default the client's */
  timeoutMs?: number;
  /** safe to repeat after a 503 (reads and searches); a 429 is always retried */
  idempotent?: boolean;
  /** send without the Authorization header (e.g. /_edge/tenant_info) */
  anonymous?: boolean;
  /** statuses returned as `{status, body}` rather than thrown */
  allow?: number[];
}

export interface JiraResponse<T> {
  status: number;
  body: T;
}

export interface JiraClient {
  readonly site: string;
  request<T = unknown>(method: string, path: string, opts?: RequestOptions): Promise<JiraResponse<T>>;
  get<T = unknown>(path: string, opts?: RequestOptions): Promise<T>;
  post<T = unknown>(path: string, body: unknown, opts?: RequestOptions): Promise<T>;
  put<T = unknown>(path: string, body: unknown, opts?: RequestOptions): Promise<T>;
  rateLimit(): RateLimitState;
}

export interface ClientOptions {
  /** https://<site>.atlassian.net — no trailing slash needed */
  site: string;
  /** the account email for basic auth */
  user: string;
  /** the API token. Kept in the closure below and nowhere else. */
  secret: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
  maxRetries?: number;
  /** ms; injectable so tests do not wait */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const MAX_WAIT_MS = 60_000;

/** Parse Retry-After (seconds or an HTTP date) and X-RateLimit-Reset (ISO) into a wait in ms. */
export function retryDelay(headers: Headers, attempt: number, now: number, random: () => number): number {
  const jitter = Math.floor(random() * 250);
  const ra = headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.min(MAX_WAIT_MS, Math.max(0, secs) * 1000 + jitter);
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.min(MAX_WAIT_MS, Math.max(0, at - now) + jitter);
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset) {
    const at = Date.parse(reset);
    if (Number.isFinite(at)) return Math.min(MAX_WAIT_MS, Math.max(0, at - now) + jitter);
  }
  return Math.min(MAX_WAIT_MS, 500 * 2 ** attempt + jitter);
}

function readRateLimit(h: Headers): RateLimitState {
  const num = (k: string) => {
    const v = h.get(k);
    return v !== null && Number.isFinite(Number(v)) ? Number(v) : undefined;
  };
  const out: RateLimitState = {};
  const limit = num('x-ratelimit-limit');
  const remaining = num('x-ratelimit-remaining');
  if (limit !== undefined) out.limit = limit;
  if (remaining !== undefined) out.remaining = remaining;
  if (h.get('x-ratelimit-nearlimit') === 'true') out.nearLimit = true;
  const reason = h.get('ratelimit-reason');
  if (reason) out.reason = reason;
  return out;
}

/** Jira's error body in words: errorMessages + errors, nothing else. */
function reasonFrom(text: string, status: number): string {
  let words = '';
  try {
    const j = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string>; message?: string };
    const parts = [...(j.errorMessages ?? []), ...Object.entries(j.errors ?? {}).map(([k, v]) => `${k}: ${v}`)];
    if (j.message) parts.push(j.message);
    words = parts.join('; ');
  } catch {
    // an HTML error page or empty body — say only the status
  }
  if (!words) {
    words = status === 401 ? 'the credential was refused'
      : status === 403 ? 'not permitted'
      : status === 404 ? 'not found, or not visible to this account'
      : status === 429 ? 'rate limited'
      : status >= 500 ? 'Jira had a server error'
      : 'the request was refused';
  }
  return words.slice(0, 400);
}

export function createJiraClient(opts: ClientOptions): JiraClient {
  const site = opts.site.replace(/\/+$/, '');
  const fetcher: Fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxRetries = opts.maxRetries ?? 4;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  // the closure: these two never leave this function
  const user = opts.user;
  const secret = opts.secret;
  const authHeader = () => `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;
  const scrub = (s: string) => {
    let out = s;
    if (secret) out = out.split(secret).join('[redacted]');
    const enc = Buffer.from(`${user}:${secret}`).toString('base64');
    out = out.split(enc).join('[redacted]');
    return out;
  };
  let lastRate: RateLimitState = {};

  async function request<T>(method: string, path: string, o: RequestOptions = {}): Promise<JiraResponse<T>> {
    const url = path.startsWith('http') ? path : `${site}${path}`;
    const shortPath = path.split('?')[0]!;
    const idempotent = o.idempotent ?? method === 'GET';
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (!o.anonymous) headers.Authorization = authHeader();
      if (o.body !== undefined) headers['Content-Type'] = 'application/json';
      let res: Response;
      try {
        res = await fetcher(url, {
          method,
          headers,
          ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
          signal: AbortSignal.timeout(o.timeoutMs ?? timeoutMs),
        });
      } catch (err) {
        const e = err as { name?: string; code?: string; cause?: { code?: string } };
        const code = e.cause?.code ?? e.code;
        const why = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : code ? `unreachable (${code})` : 'unreachable';
        if (idempotent && attempt < maxRetries && why !== 'timeout') {
          await sleep(Math.min(MAX_WAIT_MS, 500 * 2 ** attempt + Math.floor(random() * 250)));
          continue;
        }
        const out = new JiraHttpError(0, why, method, shortPath);
        if (code) (out as unknown as { code: string }).code = code;
        throw out;
      }
      lastRate = readRateLimit(res.headers);
      // a gateway error is as transient as a 503; a 500 is Jira's own answer and is not retried
      const retryable = res.status === 429 || ([502, 503, 504].includes(res.status) && idempotent);
      if (retryable && attempt < maxRetries) {
        await res.body?.cancel().catch(() => undefined);
        await sleep(retryDelay(res.headers, attempt, now(), random));
        continue;
      }
      const text = await res.text();
      if (res.ok || o.allow?.includes(res.status)) {
        let body: unknown = undefined;
        if (text) {
          try { body = JSON.parse(text); } catch { body = text; }
        }
        return { status: res.status, body: body as T };
      }
      throw new JiraHttpError(res.status, scrub(reasonFrom(text, res.status)), method, shortPath);
    }
  }

  return {
    site,
    request,
    get: async <T>(path: string, o?: RequestOptions) => (await request<T>('GET', path, o)).body,
    post: async <T>(path: string, body: unknown, o?: RequestOptions) => (await request<T>('POST', path, { ...o, body })).body,
    put: async <T>(path: string, body: unknown, o?: RequestOptions) => (await request<T>('PUT', path, { ...o, body })).body,
    rateLimit: () => ({ ...lastRate }),
  };
}
