// The server's folds, kept beside the index they were folded from (the pattern core `projectGraph()` uses).
//
// A server loads a graph once (`loadJourneyGraph` memoizes the index by mtime) and answers many requests
// from it. A fold over every node — the tests catalogue, the design surface, the organised journeys — is
// the same answer for the same index and the same question, so it is computed once and kept in a WeakMap
// keyed by the index: a re-ingest or a reload is a different index and folds again, and an index nobody
// holds lets its folds go. A few answers per fold are kept (the most recently asked), because a
// thousand-project tests catalogue is a few hundred megabytes of objects. What comes back is shared:
// callers read it, never mutate it.
import type { GraphIndex } from '@farsight/core';

const cache = new WeakMap<GraphIndex, Map<string, Map<string, unknown>>>();

/** The answer `fold()` gave for this index, fold name and key — computed on the first ask. */
export function folded<T>(index: GraphIndex, name: string, key: string, fold: () => T, keep = 4): T {
  let byName = cache.get(index);
  if (!byName) cache.set(index, (byName = new Map()));
  let answers = byName.get(name);
  if (!answers) byName.set(name, (answers = new Map()));
  if (answers.has(key)) {
    const hit = answers.get(key) as T;
    // most recently asked last, so the oldest is the one dropped
    answers.delete(key);
    answers.set(key, hit);
    return hit;
  }
  const value = fold();
  answers.set(key, value);
  while (answers.size > keep) answers.delete(answers.keys().next().value as string);
  return value;
}

/** A scope as a cache key: `all`, or the sorted source names. */
export function scopeKey(scope: Set<string> | null | undefined): string {
  return scope ? [...scope].sort().join(',') : 'all';
}

// ── the tests page's lean answer (`/api/tests?lean=1`) ─────────────────────────────────────────────
// The tests page prints counts, words and metrics; the per-node lists behind them — a metric's `evidence`
// and `gaps` (every coverable node), its `uncertainty.affects`, a journey's `scope.nodeIds`, its `tests`
// and its declared / inferred / observed cases — are what the full answer, `/api/tests/<id>` and the frozen
// matrix carry. On a thousand-project workspace those lists are ~240 MB of the ~243 MB answer, so the page
// asks for the lean one: the same fold, the same numbers, each list replaced by its length (`<name>Count`).
type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => !!x && typeof x === 'object' && !Array.isArray(x);

/** A metric with its per-node lists replaced by their lengths. */
export function leanMetric(m: unknown): unknown {
  if (!isRec(m)) return m;
  const out: Rec = { ...m };
  for (const k of ['evidence', 'gaps'] as const) if (Array.isArray(m[k])) { delete out[k]; out[k + 'Count'] = (m[k] as unknown[]).length; }
  if (isRec(m['uncertainty'])) {
    const u = m['uncertainty'];
    const { affects, ...rest } = u;
    out['uncertainty'] = Array.isArray(affects) ? { ...rest, affectsCount: affects.length } : u;
  }
  if (isRec(m['scope']) && Array.isArray(m['scope']['nodeIds'])) {
    const { nodeIds, ...rest } = m['scope'];
    out['scope'] = { ...rest, nodeIdsCount: (nodeIds as unknown[]).length };
  }
  return out;
}

/** A journey's coverage with its test list replaced by its length and its metric lean. */
export function leanCoverage(c: unknown): unknown {
  if (!isRec(c)) return c;
  const out: Rec = { ...c, metric: leanMetric(c['metric']) };
  if (Array.isArray(c['tests'])) { delete out['tests']; out['testsCount'] = (c['tests'] as unknown[]).length; }
  return out;
}

/** A tests-page journey row, lean: its case lists as counts (`declaredCount` · `inferredCount` · `observedCount`). */
export function leanJourneyRow(r: unknown): unknown {
  if (!isRec(r)) return r;
  const out: Rec = { ...r, coverage: leanCoverage(r['coverage']) };
  for (const k of ['declared', 'inferred', 'observed'] as const) if (Array.isArray(r[k])) { delete out[k]; out[k + 'Count'] = (r[k] as unknown[]).length; }
  return out;
}
