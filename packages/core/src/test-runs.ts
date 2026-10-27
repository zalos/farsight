/**
 * The fold over a case's runs, one per project (`TestRef.runs` → `TestRef.run`). A case is as green as its worst
 * project **where it ran**: a fail or a flake on any project stays the case's status; otherwise a case that passed on
 * any project passed, and a project that skipped it by its own written condition is kept beside the fold, never
 * folded into it. Before this a skip ranked below a pass, and the reference app's storyline-wide case — passed on
 * `desktop-1440`, skipped on `mobile-390` by `test.skip(viewport < 1024, '…designed for desktop…')` — read *skipped*,
 * which held every journey it declares in the readiness brief (outsider demo 2026-10-13, F3). A case skipped on
 * every project stays skipped, with each reason.
 */
import type { TestRun, TestRunProject, GraphNode } from './graph.js';

/** Weakest first, for the statuses that decide a case wherever they happened. */
const DECIDING: TestRun['status'][] = ['failed', 'flaky'];
/** Weakest first, for a case no project passed or failed. */
const STATUS_RANK: TestRun['status'][] = ['failed', 'flaky', 'skipped', 'unknown', 'passed'];

const rank = (s: TestRun['status']) => STATUS_RANK.indexOf(s);

export function foldRuns(runs: TestRun[]): TestRun | undefined {
  if (!runs.length) return undefined;
  if (runs.length === 1) {
    const one = { ...runs[0]! };
    delete one.projects;
    return one;
  }
  const deciding = runs.filter((r) => DECIDING.includes(r.status));
  const passed = runs.filter((r) => r.status === 'passed');
  const pool = deciding.length ? deciding : passed.length ? passed : runs;
  const pick = [...pool].sort((a, b) => rank(a.status) - rank(b.status))[0]!;
  const latest = runs.reduce((a, b) => (b.at > a.at ? b : a));
  const fold: TestRun = { ...pick, at: latest.at };
  delete fold.project;
  delete fold.reason;
  delete fold.projects;
  const named = runs.filter((r) => r.project);
  if (new Set(named.map((r) => r.project)).size > 1) {
    fold.projects = named.map((r): TestRunProject => ({
      project: r.project!,
      status: r.status,
      ...(r.reason ? { reason: r.reason } : {}),
    }));
  }
  return fold;
}

/**
 * A graph an older build wrote carries `run` as the weakest status over its projects; the index re-folds it from
 * `runs[]` so every consumer that reads `run` reads the fold above, without a re-ingest. Idempotent.
 */
export function refoldRuns(nodes: Iterable<GraphNode>): void {
  for (const n of nodes) {
    const ref = n.test;
    if (n.kind !== 'test' || !ref?.runs || ref.runs.length < 2) continue;
    ref.run = foldRuns(ref.runs);
  }
}
