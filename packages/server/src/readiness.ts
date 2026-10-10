// The release readiness brief, served and printed (round 2026-10-10, proposal 6): core `readiness()` with
// its commits read from the workspace's commit spine (.farsight/farsight.db). One helper, so
// `GET /api/readiness` and `farsight readiness` cannot disagree.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { SnapshotDb, readiness, type GraphIndex, type JourneyTree, type Readiness } from '@farsight/core';

/** The brief, with commits since each row's last green run from the spine when the workspace has one. */
export function readinessOf(index: GraphIndex, tree: JourneyTree, storyline: string, ws: string, repo?: string): { brief: Readiness | undefined; spine: 'read' | 'none' } {
  const path = join(ws, '.farsight', 'farsight.db');
  let db: SnapshotDb | undefined;
  try { if (existsSync(path)) db = new SnapshotDb(path); } catch { db = undefined; }
  try {
    const brief = readiness(index, tree, storyline, {
      ...(repo ? { repo } : {}),
      ...(db ? { commitsSince: (r: string, parts: { node: string; path?: string }[], since: string) => (db!.commitCount(r) ? db!.commitsTouching(r, parts).filter((c) => c.at > since).length : null) } : {}),
    });
    return { brief, spine: db ? 'read' : 'none' };
  } finally {
    db?.close();
  }
}
