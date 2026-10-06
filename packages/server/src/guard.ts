// Who may talk to the loopback server (docs/SECURITY.md).
//
// The server binds 127.0.0.1, which stops other machines — not other web pages.
// A page on any site can send a request to http://localhost:<port> from the
// reader's own browser, and two attacks follow from that:
//
//   DNS rebinding  a hostile domain re-points itself at 127.0.0.1, so its page
//                  is "same-origin" with the server and can READ /graph, the
//                  code slices and /api/settings. Its requests carry the hostile
//                  name in `Host`, so a loopback-only Host check stops it.
//   cross-site writes  a form or a no-cors `fetch` POST (text/plain needs no
//                  preflight, and the routes parse the body as JSON whatever its
//                  type) could start a sync or queue a tracker write. Browsers
//                  name the requesting page in `Origin` / `Sec-Fetch-Site`, so a
//                  state-changing request that says it came from another origin
//                  is refused.
//
// Non-browser clients (curl, the CLI, the MCP server, tests) send neither header
// and pass: anything that can run a process as this user is already inside the
// boundary this check draws.

/** The hostnames this server answers to: it binds loopback, so only loopback names. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface GuardRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

const header = (req: GuardRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** `localhost:4477` → `localhost`; `[::1]:4477` → `[::1]`. */
export function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  const colon = h.lastIndexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Null when the request may proceed; otherwise the reason it is refused (403).
 * A missing `Host` (HTTP/1.0) passes: a rebinding page always sends its own name.
 */
export function refuseRequest(req: GuardRequest): string | null {
  const host = header(req, 'host');
  if (host !== undefined && !LOOPBACK_HOSTS.has(hostnameOf(host))) {
    return `this server answers to localhost only (Host: ${host.slice(0, 80)})`;
  }
  if (SAFE_METHODS.has((req.method ?? 'GET').toUpperCase())) return null;
  const site = header(req, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return `a ${req.method} from another site is refused (Sec-Fetch-Site: ${site})`;
  }
  const origin = header(req, 'origin');
  if (origin !== undefined) {
    let ok = false;
    try {
      const o = new URL(origin);
      ok = o.protocol === 'http:' && host !== undefined && o.host === host.trim().toLowerCase();
    } catch { /* `null` or garbage: not this server */ }
    if (!ok) return `a ${req.method} from another origin is refused (Origin: ${origin.slice(0, 80)})`;
  }
  return null;
}


// ── a read-only session (`farsight serve --read-only`, and every `--as-of` serve) ──
//
// The viewer's top bar has always said READ-ONLY while Settings offered *Save*,
// *Sync & re-ingest* and *Add source* beside it (swarm 2026-10-05, six roles). A
// read-only server is now a fact the server holds and enforces: it refuses every
// request that changes something it owns — the workspace settings, the graph (a
// sync) and the work-item cache and trackers — and `/api/version` says so, so the
// viewer disables the same controls it would otherwise refuse. The two diff routes
// (`POST /api/design/diff`, `POST /api/apis/diff`) compare a proposal and persist
// nothing, so they stay open.

/** Why a server is read-only: started with `--read-only`, or serving an `--as-of` snapshot. */
export type ReadOnlyWhy = 'flag' | 'as-of';

/** True for a request that would change the workspace settings, the graph or the work items. */
export function isWriteRoute(method: string | undefined, url: string): boolean {
  const m = (method ?? 'GET').toUpperCase();
  if (SAFE_METHODS.has(m)) return false;
  const path = url.split('?')[0] ?? url;
  if (path === '/api/settings') return true;
  if (path === '/api/sync') return true;
  if (path === '/api/work' || path.startsWith('/api/work/')) return true;
  return false;
}

/** The refusal a read-only server sends for a write route (403), or null when the request may proceed. */
export function refuseWrite(readOnly: ReadOnlyWhy | null | undefined, method: string | undefined, url: string): string | null {
  if (!readOnly || !isWriteRoute(method, url)) return null;
  return readOnly === 'as-of'
    ? 'this server is read-only: it serves an --as-of snapshot, so settings, syncs and work-item writes are refused'
    : 'this server is read-only (started with --read-only): settings, syncs and work-item writes are refused';
}
