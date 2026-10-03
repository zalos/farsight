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

