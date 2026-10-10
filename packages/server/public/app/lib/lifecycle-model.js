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

// ── one state machine, two views of it (round 2026-10-10 §3) ────────────────
// `/api/journey`'s `lifecycles[].views` (core `lifecycleViews`): one view per persona the journey is for,
// each status with the word that persona uses (config, else the constant humanized), the constant, and
// what moves a record into it. These folds pick what the strip and the table draw for a lens.

/** The view a surface draws: the first persona's whose words config gave, else the first view. */
export function pickView(lc) {
  const views = (lc && lc.views) || [];
  return views.find((v) => v.declared) || views[0] || null;
}

/**
 * The strip's items, in declared order. `sep` before each item after the first: `→` when some code moves a
 * record into it straight from the one before (a move from that status, or a move that checks no prior
 * status while the one before is itself reached), else `·` — an arrow is only drawn where the code moves.
 * `text` is what the lens prints: business the word, hybrid the word and the constant, code the constant.
 * @param {object} view  one `LifecycleView`
 * @param {'business'|'hybrid'|'code'} lens
 */
export function stripItems(view, lens) {
  if (!view) return [];
  const rows = view.rows || [];
  return rows.map((r, i) => {
    const prev = i > 0 ? rows[i - 1] : null;
    const arrow = !!prev && r.written && (r.movers || []).some((m) => m.from === prev.status || (m.from == null && (prev.written || i === 1)));
    return {
      status: r.status, word: r.word, declared: !!r.declared, written: !!r.written,
      sep: i === 0 ? '' : arrow ? '→' : '·',
      main: lens === 'code' ? r.status : r.word,
      constant: lens === 'hybrid' && r.word !== r.status ? r.status : '',
    };
  });
}

/** The counts the strip prints for a lens: business says how many the app moves; code and hybrid the moves with a writer. */
export function stripCounts(lc, view, lens) {
  const c = (lc && lc.counts) || {};
  const v = (view && view.counts) || {};
  return lens === 'business' ? [v.statuses || c.statuses, v.moved, v.unmoved] : [c.statuses, c.transitions, c.unwritten];
}

/**
 * The table's rows: every status then every overlay, each with its movers. A mover's `door` is the journey
 * link to its screen (built by the caller through route-url.js), `null` when no journey reaches it.
 * @param {object} view
 * @param {(m:object) => string|null} doorOf
 */
export function tableRows(view, doorOf) {
  if (!view) return [];
  const mv = (m) => ({ by: m.by, name: m.name, words: m.words, at: m.at || null, door: m.at ? doorOf(m) : null });
  return [
    ...(view.rows || []).map((r) => ({ kind: 'status', word: r.word, declared: !!r.declared, code: r.status, written: !!r.written, movers: (r.movers || []).map(mv) })),
    ...(view.overlays || []).map((o) => ({ kind: 'overlay', word: o.name, declared: true, code: o.tableName, when: o.when, written: (o.movers || []).length > 0, movers: (o.movers || []).map(mv) })),
  ];
}

/** Merge a `/api/lifecycle` answer's placements into the journey's view (same rows, same order): the answer wins. */
export function placedView(view, answer) {
  if (!answer || !answer.views || !answer.views.length) return view;
  const want = view && view.persona ? view.persona.id : null;
  return answer.views.find((v) => (v.persona ? v.persona.id : null) === want) || answer.views[0];
}
