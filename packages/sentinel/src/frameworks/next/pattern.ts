// Next 14.2.25 middleware matcher semantics over request paths, for the selected static subset only (PR 14).
//
// Next turns each matcher `source` into a path-to-regexp pattern and tests it against the request pathname. This
// module never builds or runs that regular expression. It reads the subset of the pattern grammar whose meaning is
// whole path segments (literal segments and `:name`, `:name?`, `:name*`, `:name+` parameters) into a small segment
// automaton, reads an App Router file path into the set of request paths it serves, and decides by automaton product
// whether every, no or only some of those paths are matched. Anything outside the subset is `unsupported` with its
// reason, never approximated: custom regular-expression groups, `{}` groups, escapes, partial-segment parameters,
// encoded or non-ASCII literals.
//
// Soundness: a dynamic route segment is taken to serve every segment value, including values a sibling static route
// would win. That over-approximates the requests reaching the surface, so `all` and `none` stay true and only some
// `all`/`none` answers degrade to `some`.

/** One path-segment position: a literal segment, or a parameter over any one non-empty segment. */
export type SegmentItem =
  { readonly t: 'lit'; readonly s: string } | { readonly t: 'one' } | { readonly t: 'opt' } | { readonly t: 'star' };

/** A segment language: the union of these segment sequences. */
export type SegmentLanguage = readonly (readonly SegmentItem[])[];

export type PatternReason = 'unsupported' | 'invalid';

export type ParsedMatcherSource =
  | { readonly ok: true; readonly language: SegmentLanguage }
  | { readonly ok: false; readonly reason: PatternReason; readonly detail: string };

/** Literal segment characters the subset compares directly: unreserved URL characters only, so no encoding applies. */
const LITERAL = /^[A-Za-z0-9._~-]+$/;
const PARAM = /^:([A-Za-z0-9_]+)([?*+]?)$/;
/** Grammar characters outside the subset (custom patterns, groups, escapes, bare modifiers). */
const GRAMMAR = /[(){}\\*+?:]/;
/** Longest matcher source the subset reads; a longer one is unsupported, not truncated. */
export const MAX_SOURCE_LENGTH = 1024;

/**
 * Reads one matcher `source` (after Next's own validation that it is a string) into a segment language, or says
 * why not. `/` alone is Next's root form, which also matches `/index`.
 */
export function parseMatcherSource(source: string): ParsedMatcherSource {
  const no = (reason: PatternReason, detail: string) => ({ ok: false as const, reason, detail });
  if (source.length === 0 || source.length > MAX_SOURCE_LENGTH)
    return no('unsupported', 'the source is empty or longer than the subset reads');
  if (!source.startsWith('/')) return no('invalid', 'a matcher source must start with /');
  // Next appends `(/?index|/?index\.json)?` to the root source: `/` and `/index` are both matched.
  if (source === '/') return { ok: true, language: [[], [{ t: 'lit', s: 'index' }]] };
  if (source.endsWith('/')) return no('unsupported', 'a trailing slash changes the generated pattern');
  const items: SegmentItem[] = [];
  for (const seg of source.slice(1).split('/')) {
    if (seg === '') return no('unsupported', 'an empty segment');
    const param = PARAM.exec(seg);
    if (param) {
      const mod = param[2];
      if (mod === '') items.push({ t: 'one' });
      else if (mod === '?') items.push({ t: 'opt' });
      else if (mod === '*') items.push({ t: 'star' });
      else items.push({ t: 'one' }, { t: 'star' });
      continue;
    }
    if (GRAMMAR.test(seg)) {
      // A bare modifier or an unnamed parameter is a path-to-regexp parse error; the rest is valid grammar outside the subset.
      if (/^[*+?]/.test(seg) || /(^|[^A-Za-z0-9_]):([^A-Za-z0-9_]|$)/.test(seg))
        return no('invalid', `segment "${seg}" is not a valid pattern`);
      return no('unsupported', `segment "${seg}" uses pattern syntax outside the supported subset`);
    }
    if (!LITERAL.test(seg))
      return no('unsupported', `segment "${seg}" holds characters whose request encoding is not modelled`);
    items.push({ t: 'lit', s: seg });
  }
  return { ok: true, language: [items] };
}

/** Request paths an App Router route or page file serves, or why the subset cannot say. */
export type RouteLanguage =
  | { readonly ok: true; readonly items: readonly SegmentItem[]; readonly display: string }
  | { readonly ok: false; readonly reason: 'unsupported' | 'not-routable'; readonly detail: string };

/**
 * The request paths served by a route/page file, from its folder segments below the app directory (never from the
 * graph's display name, which folds every dynamic form to `:param`). Route groups `(x)` and parallel-route slots
 * `@x` are not URL segments; `[x]` is one segment, `[...x]` one or more, `[[...x]]` zero or more (last only).
 * Private folders `_x` are not routable. Intercepting routes and encoded literals are outside the subset.
 */
export function routeLanguage(folders: readonly string[]): RouteLanguage {
  const items: SegmentItem[] = [];
  const shown: string[] = [];
  for (let i = 0; i < folders.length; i++) {
    const f = folders[i]!;
    if (f.startsWith('_')) return { ok: false, reason: 'not-routable', detail: `private folder "${f}"` };
    if (/^\(\.{1,3}\)/.test(f) || /^\(\.\.\)\(\.\.\)/.test(f))
      return { ok: false, reason: 'unsupported', detail: `intercepting route "${f}"` };
    if (/^\([^()]+\)$/.test(f) || f.startsWith('@')) continue;
    let m: RegExpExecArray | null;
    if ((m = /^\[\[\.\.\.([A-Za-z0-9_]+)\]\]$/.exec(f))) {
      if (i !== folders.length - 1)
        return { ok: false, reason: 'unsupported', detail: 'an optional catch-all that is not last' };
      items.push({ t: 'star' });
      shown.push(`[[...${m[1]}]]`);
      continue;
    }
    if ((m = /^\[\.\.\.([A-Za-z0-9_]+)\]$/.exec(f))) {
      if (i !== folders.length - 1) return { ok: false, reason: 'unsupported', detail: 'a catch-all that is not last' };
      items.push({ t: 'one' }, { t: 'star' });
      shown.push(`[...${m[1]}]`);
      continue;
    }
    if ((m = /^\[([A-Za-z0-9_]+)\]$/.exec(f))) {
      items.push({ t: 'one' });
      shown.push(`[${m[1]}]`);
      continue;
    }
    if (!LITERAL.test(f))
      return { ok: false, reason: 'unsupported', detail: `folder "${f}" is outside the modelled segment forms` };
    // Next appends `(.json)?` (an unescaped `.`) to every non-root source, so a literal ending in any character
    // followed by `json` can be matched by a shorter source. Leave such a route to the unknown side.
    if (/.json$/.test(f) && f.length > 4)
      return {
        ok: false,
        reason: 'unsupported',
        detail: `folder "${f}" ends in a form the generated .json suffix can reach`,
      };
    items.push({ t: 'lit', s: f });
    shown.push(f);
  }
  return { ok: true, items, display: '/' + shown.join('/') };
}

// ---- the automaton ----

const OTHER = '\u0000other';

interface Nfa {
  readonly n: number;
  readonly items: readonly SegmentItem[];
}

/** States 0..n; `star` loops at its own state, `opt`/`star` also skip by ε. */
const nfa = (items: readonly SegmentItem[]): Nfa => ({ n: items.length, items });

function closure(a: Nfa, states: Iterable<number>): Set<number> {
  const out = new Set<number>();
  const stack = [...states];
  while (stack.length) {
    const s = stack.pop()!;
    if (out.has(s)) continue;
    out.add(s);
    const it = a.items[s];
    if (it && (it.t === 'opt' || it.t === 'star')) stack.push(s + 1);
  }
  return out;
}

function step(a: Nfa, states: ReadonlySet<number>, sym: string): Set<number> {
  const next: number[] = [];
  for (const s of states) {
    const it = a.items[s];
    if (!it) continue;
    if (it.t === 'lit') {
      if (it.s === sym) next.push(s + 1);
    } else if (it.t === 'star') next.push(s);
    else next.push(s + 1);
  }
  return closure(a, next);
}

export type Coverage = 'all' | 'none' | 'some';

export interface Decision {
  readonly coverage: Coverage;
  /** A request path of the route the language matches, and one it does not, when they exist. */
  readonly matchedExample?: string;
  readonly unmatchedExample?: string;
}

const render = (syms: readonly string[]) => '/' + syms.map((s) => (s === OTHER ? '{segment}' : s)).join('/');

/**
 * Whether the language `m` matches every, none or only some request paths of route `r`. Exact product search over the
 * literal alphabet of both plus one symbol for every other segment value; `fold` compares literals case-folded.
 */
export function decide(r: readonly SegmentItem[], m: SegmentLanguage, fold = false): Decision {
  const norm = (s: string) => (fold ? s.toLowerCase() : s);
  const fix = (items: readonly SegmentItem[]) =>
    items.map((i) => (i.t === 'lit' ? { t: 'lit' as const, s: norm(i.s) } : i));
  const rA = nfa(fix(r));
  const mAs = m.map((seq) => nfa(fix(seq)));
  const alphabet = [
    ...new Set([...rA.items, ...mAs.flatMap((a) => a.items)].flatMap((i) => (i.t === 'lit' ? [i.s] : []))),
  ].sort();
  // The placeholder first, so a witness names a literal only where the decision turns on it.
  alphabet.unshift(OTHER);
  type State = { r: Set<number>; m: Set<number>[]; path: string[] };
  const key = (s: State) => [[...s.r].sort().join(','), ...s.m.map((x) => [...x].sort().join(','))].join('|');
  const start: State = { r: closure(rA, [0]), m: mAs.map((a) => closure(a, [0])), path: [] };
  const seen = new Set<string>([key(start)]);
  const queue: State[] = [start];
  let matched: string | undefined;
  let unmatched: string | undefined;
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.r.has(rA.n)) {
      const accepted = cur.m.some((ms, i) => ms.has(mAs[i]!.n));
      if (accepted) matched ??= render(cur.path);
      else unmatched ??= render(cur.path);
      if (matched !== undefined && unmatched !== undefined) break;
    }
    for (const sym of alphabet) {
      const r2 = step(rA, cur.r, sym);
      if (r2.size === 0) continue;
      const next: State = { r: r2, m: cur.m.map((ms, i) => step(mAs[i]!, ms, sym)), path: [...cur.path, sym] };
      const k = key(next);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push(next);
    }
  }
  const coverage: Coverage = matched === undefined ? 'none' : unmatched === undefined ? 'all' : 'some';
  return {
    coverage,
    ...(matched !== undefined ? { matchedExample: matched } : {}),
    ...(unmatched !== undefined ? { unmatchedExample: unmatched } : {}),
  };
}

/**
 * The same decision, refusing to answer when it depends on letter case: Next compiles the matcher to a pattern
 * whose case handling this subset does not take as settled, so a literal pair equal only case-folded is ambiguous.
 */
export function decideCaseStable(
  r: readonly SegmentItem[],
  m: SegmentLanguage,
): Decision & { readonly caseAmbiguous: boolean } {
  const exact = decide(r, m);
  const folded = decide(r, m, true);
  return { ...exact, caseAmbiguous: exact.coverage !== folded.coverage };
}
