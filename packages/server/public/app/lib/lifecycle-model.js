// lib/lifecycle-model.js — what a record's status-lifecycle strip draws (pure, no DOM; tested in
// packages/server/test/lifecycle-model.test.ts). lib/lifecycle-strip.js draws it.

/**
 * What one strip draws: the statuses with whether some code moves to each, and the moves in
 * declared order of their target, each with its writer and whether this journey runs it.
 * @param {{ nodeId: string, name: string, lifecycle: { field: string, statuses: string[], transitions: Array<{ from?: string, to: string, by: string, via: string, line?: number }> }, onJourney?: boolean[], writers?: Record<string,string> }} lc
 */
export function lifecycleStripModel(lc) {
  if (!lc || !lc.lifecycle) return null;
  const life = lc.lifecycle;
  const to = new Set(life.transitions.map((x) => x.to));
  return {
    nodeId: lc.nodeId,
    name: lc.name,
    field: life.field,
    statuses: life.statuses.map((s) => ({ s, written: to.has(s) })),
    moves: life.transitions.map((x, i) => ({
      from: x.from, to: x.to, by: x.by, via: x.via, line: x.line,
      byName: (lc.writers && lc.writers[x.by]) || String(x.by).split('::').pop(),
      here: !!(lc.onJourney && lc.onJourney[i]),
    })),
    provenance: life.provenance || [],
  };
}

/** The lifecycles of the records in `ids` (a screen's reached data), in the journey's order. */
export function lifecyclesFor(all, ids) {
  const keep = new Set(ids || []);
  return (all || []).filter((lc) => keep.has(lc.nodeId));
}

