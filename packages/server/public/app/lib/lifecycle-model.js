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


/**
 * The records a journey header shows: those whose moves this journey makes (a record the walk only
 * reads says nothing about this journey), the most moves first, at most `cap`; the rest counted.
 */
export function headerLifecycles(all, cap = 2) {
  const mine = (all || []).map((lc, i) => ({ lc, i, here: (lc.onJourney || []).filter(Boolean).length })).filter((x) => x.here > 0);
  mine.sort((a, b) => b.here - a.here || a.i - b.i);
  return { shown: mine.slice(0, cap).map((x) => x.lc), more: Math.max(0, mine.length - cap) };
}

/**
 * The records a screen shows: those its own calls reach, and those whose move a step of this
 * screen makes (a repeated call carries no data rows of its own, but its writer is still a step here).
 */
export function screenLifecycles(all, recordIds, stepIds) {
  const recs = new Set(recordIds || []);
  const steps = new Set(stepIds || []);
  return (all || []).filter((lc) => recs.has(lc.nodeId) || ((lc.lifecycle && lc.lifecycle.transitions) || []).some((x) => steps.has(x.by)));
}
