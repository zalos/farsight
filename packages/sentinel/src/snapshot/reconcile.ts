// Inventory reconciliation (E1): every path an independent walk of a source finds must be accounted for by the
// snapshot, either by its own entry or by a recorded boundary above it whose contents are unknown, never zero.
import type { CaptureEntry, SnapshotEnvelope } from '../contracts/index.js';

export interface Reconciliation {
  /** Paths with an entry of their own, by disposition. */
  readonly byDisposition: Readonly<Record<string, number>>;
  /** Paths inside a recorded boundary (excluded, refused or unreadable folder; descendants unknown). */
  readonly insideBoundary: number;
  /** Paths the snapshot does not account for at all. Must be empty. */
  readonly unaccounted: readonly string[];
  /** Entries the walk did not find (a capture-time file since removed, or an entry the walk could not see). */
  readonly notObserved: readonly string[];
}

/**
 * `observed` lists every non-folder path (and every folder the walker could not open) under the source root,
 * `/`-separated and relative to it.
 */
export function reconcileInventory(snapshot: SnapshotEnvelope, sourceId: string, observed: Iterable<string>): Reconciliation {
  const entries = new Map<string, CaptureEntry>();
  const boundaries = new Set<string>();
  for (const e of snapshot.entries) {
    if (e.sourceId !== sourceId) continue;
    entries.set(e.relativePath, e);
    if (e.kind === 'directory-boundary') boundaries.add(e.relativePath);
  }
  const byDisposition: Record<string, number> = {};
  const unaccounted: string[] = [];
  const seen = new Set<string>();
  let insideBoundary = 0;
  for (const path of observed) {
    const own = entries.get(path);
    if (own) {
      seen.add(path);
      byDisposition[own.disposition] = (byDisposition[own.disposition] ?? 0) + 1;
      continue;
    }
    const parts = path.split('/');
    let covered = false;
    for (let i = parts.length - 1; i >= 1 && !covered; i--) {
      const prefix = parts.slice(0, i).join('/');
      if (boundaries.has(prefix)) { covered = true; seen.add(prefix); }
    }
    if (covered) insideBoundary++;
    else unaccounted.push(path);
  }
  const notObserved = [...entries.keys()].filter(p => !seen.has(p)).sort();
  return Object.freeze({ byDisposition: Object.freeze(byDisposition), insideBoundary, unaccounted: Object.freeze(unaccounted.sort()),
    notObserved: Object.freeze(notObserved) });
}
