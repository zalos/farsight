// Path matching for Express 4.21.2's routing (path-to-regexp 0.1.x, case-insensitive and non-strict by default), over
// the supported subset: literal segments and whole-segment `:name` parameters. A route's effective path is a
// template standing for every concrete request it can receive; a layer's pattern matches that template only when it
// matches every such request, does not match only when it matches none, and is unknown otherwise. A wildcard,
// optional or repeated parameter, regular expression, array of paths, trailing slash or empty segment is outside the
// subset and unknown, never approximated.

export type MatchResult = 'match' | 'no-match' | 'unknown';

type Segment = { readonly kind: 'literal'; readonly text: string } | { readonly kind: 'param'; readonly name: string };

/** Parses a path into the supported segments, or undefined when it is outside the subset. `/` is no segments. */
export function segments(path: string): Segment[] | undefined {
  if (!path.startsWith('/') || path.includes('//') || path.includes('\\')) return undefined;
  if (path === '/') return [];
  if (path.endsWith('/')) return undefined;
  const out: Segment[] = [];
  for (const p of path.slice(1).split('/')) {
    const param = /^:([A-Za-z0-9_]+)$/.exec(p);
    if (param) { out.push({ kind: 'param', name: param[1]! }); continue; }
    // Anything path-to-regexp 0.1.x gives a meaning beyond a literal (`*`, `?`, `+`, groups, a parameter inside a
    // segment) is outside the subset.
    if (p === '' || /[*?+()[\]:{}$^|]/.test(p)) return undefined;
    out.push({ kind: 'literal', text: p.toLowerCase() });
  }
  return out;
}

/** Joins a mount path and a path below it (`/api` + `/users` = `/api/users`; `/api` + `/` = `/api`). */
export function joinPaths(mount: string, path: string): string | undefined {
  const m = segments(mount);
  const p = segments(path);
  if (!m || !p) return undefined;
  const all = [...mount === '/' ? [] : mount.slice(1).split('/'), ...path === '/' ? [] : path.slice(1).split('/')];
  return all.length ? `/${all.join('/')}` : '/';
}

/**
 * Whether a layer's pattern matches every, no, or some of the requests a route template receives. `prefix` is a
 * `use` layer (it matches the path and everything below it); otherwise the whole path must match.
 */
export function matchPath(template: string, pattern: string, prefix: boolean): MatchResult {
  const t = segments(template);
  const p = segments(pattern);
  if (!t || !p) return 'unknown';
  if (p.length > t.length) return 'no-match';
  if (!prefix && p.length !== t.length) return 'no-match';
  let partial = false;
  for (let i = 0; i < p.length; i++) {
    const ps = p[i]!;
    const ts = t[i]!;
    if (ps.kind === 'param') continue;
    if (ts.kind === 'literal') { if (ts.text !== ps.text) return 'no-match'; } else partial = true;
  }
  return partial ? 'unknown' : 'match';
}

/** What a template looks like below a matched `use` prefix: the remaining segments, written as a path. */
export function stripPrefix(template: string, pattern: string): string | undefined {
  const t = segments(template);
  const p = segments(pattern);
  if (!t || !p || p.length > t.length) return undefined;
  const rest = template === '/' ? [] : template.slice(1).split('/').slice(p.length);
  return rest.length ? `/${rest.join('/')}` : '/';
}

/** HTTP methods a route method receives: a `get` route also answers HEAD. */
export function requestMethods(method: string): readonly string[] {
  return method === 'get' ? ['get', 'head'] : [method];
}

/** Whether a route layer registered for `layerMethods` handles every, no, or some of the route's requests. */
export function matchMethod(routeMethod: string, layerMethods: readonly string[] | 'all'): MatchResult {
  if (layerMethods === 'all') return 'match';
  const wanted = requestMethods(routeMethod);
  // An Express `get` route answers HEAD too.
  const handled = new Set(layerMethods.flatMap(m => requestMethods(m)));
  const hits = wanted.filter(m => handled.has(m)).length;
  return hits === wanted.length ? 'match' : hits === 0 ? 'no-match' : 'unknown';
}
