/**
 * The freshness fact — *stale* said once, and only when true (swarm-fixes
 * 2026-10-05, finding 2).
 *
 * *Stale* is a comparison, so it is never printed alone: the fact carries both
 * sides — the run (when, on which commit) and the code (which commit, which
 * sync) — and the catalog key of the one sentence that names them. A run with
 * no recorded digest is not stale: it is *no source digest* (the comparison
 * cannot be made), with the recipe that makes it one. A scope whose runs speak
 * for the code as it is says so (*current as of sync N*) instead of saying
 * nothing.
 *
 * One function decides the state for any list of runs — a journey's observing
 * refs, a source card's cases, a screen's tests — so the chip tip, the journey
 * header, the Portfolio row, the Tests page cards and the Map's *at risk* tip
 * print the same sentence from the same fact.
 *
 * The rule follows the evidence chip's (`coverage.ts chipOf`): the scope is
 * **stale** only when every run that observed it is older than its code; any
 * run whose digest still matches makes it **current**; otherwise a run that
 * recorded no digest makes the answer **no source digest**, never *stale*.
 */
import type { TestRun } from './graph.js';
import type { GraphIndex } from './query.js';
import type { GraphMeta } from './store.js';

export type FreshnessState = 'current' | 'stale' | 'no-digest' | 'none';

/** One run, as much of it as freshness reads. `repo` names whose code it ran on. */
export interface FreshnessRun {
  freshness: TestRun['freshness'];
  changedBy?: TestRun['changedBy'];
  at?: string;
  /** the commit the report's stamp recorded */
  commit?: string;
  repo?: string;
}

/** The code side of the comparison for one repository: the commit it was read at, and the sync that read it. */
export interface CodeAt {
  commit?: string;
  sync?: number;
}

export interface FreshnessFact {
  state: FreshnessState;
  /** the newest run on the side the state is about (the stale runs when stale, the matching ones when current) */
  ranAt?: string;
  /** the commit that run's stamp recorded, when it recorded one */
  ranOn?: { commit?: string };
  /** the code it is compared with: its commit, the sync that read it, and whether only the working tree moved */
  codeAt?: { commit?: string; sync?: number; workingTree?: boolean };
  /** `stale` only: a new commit, or the same commit with a working tree that differs from HEAD */
  changedBy?: TestRun['changedBy'];
  /** how many of the runs read fall on each side — sums to the runs read */
  runs: { current: number; stale: number; noDigest: number };
  /** the state's word (`fresh.state.*`) */
  word: string;
  /** the sentence that names both sides (`fresh.sentence.*`) — fill it with {@link freshnessVars} */
  key: string;
  /** the same sentence in the business register (`journey.biz.fresh.*`) */
  biz: string;
  /** what makes it current, when something would (`fresh.recipe.*`) */
  recipe?: string;
}

const short = (sha?: string): string => (sha ? sha.slice(0, 7) : '');

/**
 * The fact for a list of runs. `code` is the code side for the runs' repository
 * (see {@link codeAtFor}); without it the sentence says the code moved without
 * naming the commit, never a commit it does not know.
 */
export function freshnessFact(runs: readonly FreshnessRun[], code?: CodeAt | ((repo?: string) => CodeAt | undefined)): FreshnessFact {
  const current = runs.filter((r) => r.freshness === 'unchanged');
  const stale = runs.filter((r) => r.freshness === 'changed');
  const noDigest = runs.filter((r) => r.freshness !== 'unchanged' && r.freshness !== 'changed');
  const counts = { current: current.length, stale: stale.length, noDigest: noDigest.length };
  const newest = (list: readonly FreshnessRun[]): FreshnessRun | undefined =>
    list.filter((r) => r.at).sort((a, b) => (a.at! < b.at! ? 1 : a.at! > b.at! ? -1 : 0))[0] ?? list[0];
  const codeOf = (r?: FreshnessRun): CodeAt | undefined => (typeof code === 'function' ? code(r?.repo) : code);

  if (!runs.length) {
    return { state: 'none', runs: counts, word: 'fresh.state.none', key: 'fresh.sentence.none', biz: 'journey.biz.fresh.none' };
  }
  if (current.length) {
    const r = newest(current)!;
    const c = codeOf(r);
    return {
      state: 'current', runs: counts,
      ...(r.at ? { ranAt: r.at } : {}),
      ...(r.commit ? { ranOn: { commit: r.commit } } : {}),
      ...(c ? { codeAt: { ...(c.commit ? { commit: c.commit } : {}), ...(c.sync != null ? { sync: c.sync } : {}) } } : {}),
      word: 'fresh.state.current',
      key: c?.sync != null ? 'fresh.sentence.current' : 'fresh.sentence.currentNoSync',
      biz: 'journey.biz.fresh.current',
    };
  }
  if (noDigest.length) {
    const r = newest(noDigest)!;
    return {
      state: 'no-digest', runs: counts,
      ...(r.at ? { ranAt: r.at } : {}),
      word: 'fresh.state.noDigest',
      key: stale.length ? 'fresh.sentence.noDigestSome' : 'fresh.sentence.noDigest',
      biz: 'journey.biz.fresh.noDigest',
      recipe: 'fresh.recipe.stamp',
    };
  }
  // every run is older than the code it ran on
  const r = newest(stale)!;
  const c = codeOf(r);
  // the fold's own rule (coverage.ts changedByOfRefs): one run on another commit makes it a commit change
  const changedBy: TestRun['changedBy'] = stale.some((x) => x.changedBy === 'commit') ? 'commit'
    : stale.every((x) => x.changedBy === 'working-tree') ? 'working-tree' : undefined;
  const tree = changedBy === 'working-tree';
  const key = tree ? 'fresh.sentence.staleTree'
    : r.commit && c?.commit && r.commit !== c.commit ? 'fresh.sentence.staleCommit'
      : c?.commit ? 'fresh.sentence.staleCode'
        : 'fresh.sentence.staleBare';
  return {
    state: 'stale', runs: counts,
    ...(r.at ? { ranAt: r.at } : {}),
    ...(r.commit ? { ranOn: { commit: r.commit } } : {}),
    codeAt: { ...(c?.commit ? { commit: c.commit } : {}), ...(c?.sync != null ? { sync: c.sync } : {}), ...(tree ? { workingTree: true } : {}) },
    ...(changedBy ? { changedBy } : {}),
    word: 'fresh.state.stale',
    key,
    biz: tree ? 'journey.biz.fresh.staleTree' : 'journey.biz.fresh.stale',
    recipe: 'fresh.recipe.rerun',
  };
}

/**
 * The placeholders a fact's sentence takes — `{ranAt}` (a date), `{ran}` and
 * `{code}` (short commits), `{sync}`, `{noDigest}` (runs with no digest). Every
 * printer fills the sentence from this, so two surfaces cannot word it apart.
 */
export function freshnessVars(f: Pick<FreshnessFact, 'ranAt' | 'ranOn' | 'codeAt' | 'runs'>): Record<string, string> {
  return {
    ranAt: (f.ranAt ?? '').slice(0, 10),
    ran: short(f.ranOn?.commit),
    code: short(f.codeAt?.commit),
    sync: f.codeAt?.sync != null ? String(f.codeAt.sync) : '',
    noDigest: String(f.runs.noDigest),
    stale: String(f.runs.stale),
  };
}

/** Fill a sentence's `{name}` placeholders — the same substitution the viewer's `fill()` does. */
export function fillFreshness(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
}

/**
 * The code side for a repository, from the graph's meta: the commit the tests
 * pass read HEAD at (`meta.tests[repo].head`), else — a one-source graph — the
 * commit the sync recorded; and the sync number. Undefined parts stay
 * undefined: a multi-source graph's workspace commit is not a source's commit.
 */
export function codeAtFor(meta: GraphMeta | undefined, repo?: string): CodeAt | undefined {
  if (!meta) return undefined;
  const repos = Object.keys(meta.repos ?? meta.tests ?? {});
  const head = repo ? meta.tests?.[repo]?.head?.sha : undefined;
  const commit = head ?? (repos.length <= 1 ? meta.commit : undefined);
  const out: CodeAt = { ...(commit ? { commit } : {}), ...(meta.sync != null ? { sync: meta.sync } : {}) };
  return out.commit || out.sync != null ? out : undefined;
}

/**
 * The code side every fold over an index reads — registered once where the
 * index is built (the server, MCP, the CLI), because `GraphIndex` carries no
 * meta. Without it a fact still says *stale* with its run's side and *the code
 * has changed since*; it never names a commit it was not given.
 */
const CODE_AT = new WeakMap<GraphIndex, GraphMeta>();
export function setFreshnessMeta(index: GraphIndex, meta: GraphMeta | undefined): void {
  if (meta) CODE_AT.set(index, meta);
  else CODE_AT.delete(index);
}
export function codeAtOfIndex(index: GraphIndex): (repo?: string) => CodeAt | undefined {
  const meta = CODE_AT.get(index);
  return (repo) => codeAtFor(meta, repo);
}
