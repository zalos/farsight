// Path matching for the supported subset, comparing a route's mapping template with a security pattern. Both are
// Spring path patterns; the route side is a template (`/items/{id}`) standing for every concrete request it can
// receive. The answer is `match` only when every such request matches, `no-match` only when none does, and
// `unknown` whenever the subset cannot tell. Supported segments: literals, `*` (one whole segment), `{name}` (one
// whole segment) and a trailing `**`. Anything else — `?`, partial wildcards, regex variables, `**` before the end —
// is unknown. A trailing slash is never trimmed: Spring Framework 6.2's path patterns do not treat `/x/` and `/x` as
// the same path by default, and a configuration can change that, so a pattern or route ending in `/` is unknown.

/** Whether a request path matches a pattern: yes, no, or not decidable within the supported subset. */
export type MatchResult = 'match' | 'no-match' | 'unknown';

type Segment = { kind: 'literal'; text: string } | { kind: 'one' } | { kind: 'rest' };

/** Parses a pattern into the supported segments, or undefined when it is outside the subset. */
export function segments(pattern: string): Segment[] | undefined {
  if (!pattern.startsWith('/') || pattern.includes('//') || pattern.includes('\\')) return undefined;
  if (pattern === '/') return [];
  if (pattern.endsWith('/')) return undefined;
  const parts = pattern.slice(1).split('/');
  const out: Segment[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === '**') {
      if (i !== parts.length - 1) return undefined;
      out.push({ kind: 'rest' });
      continue;
    }
    if (p === '*' || /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(p)) {
      out.push({ kind: 'one' });
      continue;
    }
    if (p === '' || /[*?{}]/.test(p)) return undefined;
    out.push({ kind: 'literal', text: p });
  }
  return out;
}

/** Does the security pattern match every / no request the route template receives? */
export function matchTemplate(route: string, security: string): MatchResult {
  const r = segments(route);
  const s = segments(security);
  if (!r || !s || r.some((x) => x.kind === 'rest')) return 'unknown';
  let partial = false;
  let i = 0;
  for (; i < s.length; i++) {
    const sp = s[i]!;
    if (sp.kind === 'rest') return partial ? 'unknown' : 'match';
    const rp = r[i];
    if (!rp) return 'no-match';
    if (sp.kind === 'one') continue;
    // A literal security segment: a literal route segment either equals it or not; a variable may or may not.
    if (rp.kind === 'literal') {
      if (rp.text !== sp.text) return 'no-match';
    } else partial = true;
  }
  if (r.length !== s.length) return 'no-match';
  return partial ? 'unknown' : 'match';
}
