// lib/map-lanes-model.js — the storyline as swimlanes (round 2026-10-10 §2), as pure functions (no DOM, no store).
//
// One storyline drawn as lanes of who acts: a lane per persona that owns a journey of the storyline (the tree's
// persona order) and one per store the storyline's calls write to; the storyline's screens in step order as columns;
// in a store lane the record's moves as pills, in the order its lifecycle declares them, each naming the code that
// makes it; arrows from a screen to the move it makes. Everything is read from answers the server already gives — the
// journey tree, `/api/design` and one `/api/journey` per journey — and the manifest's or the config's `lanes[]` and
// `handoffs[]` only name, order or add what the graph can find both ends of. Nothing is guessed: a *seen* arrow (a
// screen in another lane that reads the status) is drawn only from a hand-off the design names, because no walk says
// which status a screen branches on; a hand-off whose end the graph cannot find is a note, never an arrow.
//
// `laneLayout()` is the one entry; `laneGeometry()` places it (wrapping the columns into as many segments as bring the
// board nearest the stage's shape). surfaces/map-lanes.js draws it; tested in packages/server/test/map-lanes-model.test.ts.

/** The kinds of marker a store lane reads its writes from. */
const DATA_KINDS = new Set(['record', 'external']);
const SRC = 'laneLayout ← /api/journeys storyline + /api/journey per journey (segments · markers · lifecycles · coverage)'; // str:ok a Counted's source: where the number was read, for the tip's from line

function lookup(byId) {
  if (!byId) return () => null;
  if (typeof byId.get === 'function') return (id) => byId.get(id) || null;
  return (id) => byId[id] || null;
}
function answerOf(summaries, id) {
  if (!summaries) return null;
  const a = typeof summaries.get === 'function' ? summaries.get(id) : summaries[id];
  return a && a.summary ? a : a && a.data && a.data.summary ? a.data : null;
}
const keyOf = (s) => String(s == null ? '' : s).trim().toLowerCase();
/** A write or a read, from a data marker's op (the walk's `op`, else its `via`); anything else says nothing. */
function markerMode(m) {
  const op = String(m.op || m.via || '');
  if (/write|publish|send|emit|enqueue/.test(op)) return 'write';
  if (/read|subscribe|listen|consume|receive/.test(op)) return 'read';
  return '';
}
/** The store a data marker lives in: the node's own, else the marker's, else none — never guessed from a name. */
function storeOf(m, node) {
  const s = (node && node.store) || m.store || null;
  if (!s || !s.name) return null;
  const out = { name: String(s.name), kind: s.kind || 'other' };
  if (s.engine) out.engine = s.engine;
  if (s.via) out.via = s.via;
  return out;
}
const storeKey = (s) => keyOf(s.name) + '|' + (s.kind || 'other');
/** The first sentence of a screen's words, the stage card's sub-line (the whole is its tip). */
export function firstSentence(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  const m = /^(.+?[.!?:;])(\s|$)/.exec(s);
  return (m ? m[1] : s).replace(/[.:;]$/, '').trim();
}

/**
 * The swimlane model of one storyline.
 *
 * @param {object} storyline  a tree storyline (`/api/journeys` → `tree.storylines[k]`): `journeys` (steps, each a row
 *   with `nodeId`, `id`, `name`, `personaIds`, `screens`), `branches` (rows with `branchOf`, `when`), `counts`, and the
 *   names it declares, `lanes?` / `handoffs?`
 * @param {Array} designs     the `/api/design` sources — a screen's name and words before its journey is read
 * @param {object} tree       the journey tree — persona order, names and descriptions
 * @param {Map|object} summaries  flow node id → its `/api/journey` answer (or `{ data }`), for those read so far
 * @param {object} [config]   `{ lanes?, handoffs?, byId? }` — lists that replace the storyline's, and the graph's nodes
 * @returns the lanes, stages, pills, arrows, lifecycles, counts and notes (see the README of this module above)
 */
export function laneLayout(storyline, designs, tree, summaries, config = {}) {
  const get = lookup(config.byId);
  const notes = [];
  const story = storyline || { journeys: [], branches: [] };
  const steps = Array.isArray(story.journeys) ? story.journeys : [];
  const branches = Array.isArray(story.branches) ? story.branches : [];
  const laneDecls = Array.isArray(config.lanes) ? config.lanes : Array.isArray(story.lanes) ? story.lanes : [];
  const handoffs = Array.isArray(config.handoffs) ? config.handoffs : Array.isArray(story.handoffs) ? story.handoffs : [];
  const personaRows = ((tree && tree.personas) || []).filter((p) => p && !p.key);
  const personaOrder = personaRows.map((p) => p.id);

  // the screens a design names, by design id — a stage's name and words before its journey is read
  const designScreens = new Map();
  for (const d of Array.isArray(designs) ? designs : []) {
    for (const s of (d && d.screens) || []) if (s && s.designId && !designScreens.has(s.designId)) designScreens.set(s.designId, s);
  }

  // ── the lanes of who acts: one per persona that owns a journey; a branch on its first persona other than its step's
  const laneOfJourney = new Map();
  const personaOf = (row, avoid) => {
    const ids = (row && row.personaIds && row.personaIds.length ? row.personaIds : row && row.persona ? [].concat(row.persona) : []).filter(Boolean);
    return ids.find((p) => p !== avoid) || ids[0] || '';
  };
  for (const j of steps) laneOfJourney.set(j.nodeId, 'p:' + personaOf(j));
  for (const b of branches) laneOfJourney.set(b.nodeId, 'p:' + personaOf(b, String(laneOfJourney.get(b.branchOf) || '').slice(2)));

  // ── the stages: the steps' screens in step order (a screen met again is the same stage), then each branch's screens
  // on its lane, from the column after the step it leaves
  const stages = [];
  const stageByScreen = new Map();
  const journeyStages = new Map();     // flow node id → its screens' stage keys, in its order
  const screensOf = (row) => {
    const a = answerOf(summaries, row.nodeId);
    if (a) {
      return (a.summary.segments || []).filter((s) => s && s.screen).map((seg, i) => ({ seg, index: i, a, key: seg.screen.designId || seg.screen.id }));
    }
    return (row.screens || []).map((id, i) => ({ seg: null, index: i, a: null, key: id }));
  };
  let col = 0;
  steps.forEach((j, si) => {
    const list = [];
    for (const sc of screensOf(j)) {
      let st = stageByScreen.get(sc.key);
      if (!st) {
        st = newStage(sc, j, laneOfJourney.get(j.nodeId), col++, { step: si + 1 });
        stageByScreen.set(sc.key, st);
        stages.push(st);
      } else if (sc.seg) st.segs.push({ seg: sc.seg, a: sc.a });
      list.push(st.key);
    }
    journeyStages.set(j.nodeId, list);
  });
  const mainCols = col;
  for (const b of branches) {
    const parent = journeyStages.get(b.branchOf) || [];
    const at = parent.length ? Math.max(...parent.map((k) => stages.find((s) => s.key === k).col)) + 1 : 0;
    const list = [];
    screensOf(b).forEach((sc, i) => {
      const st = newStage(sc, b, laneOfJourney.get(b.nodeId), at + i, { branch: { of: b.branchOf, ofName: b.branchOfName || '', when: String(b.when || ''), rejoins: b.rejoins || null, rejoinsName: b.rejoinsName || '' } });
      st.key = 'b:' + b.nodeId + '#' + i;
      stages.push(st);
      list.push(st.key);
    });
    journeyStages.set(b.nodeId, list);
  }

  function newStage(sc, row, lane, c, extra) {
    const seg = sc.seg;
    const screen = seg ? seg.screen : null;
    const ds = designScreens.get(sc.key) || null;
    const node = screen ? get(screen.id) : ds && ds.nodeId ? get(ds.nodeId) : null;
    const words = (screen && screen.business) || (node && (node.bizDescription || node.docs)) || (ds && ds.description) || '';
    const planned = screen ? (screen.designStatus === 'design-only' || !screen.loc) : !!(ds && ds.status === 'design-only');
    return {
      key: 's:' + sc.key, lane, col: c, row: 0,
      flowId: row.nodeId, journeyId: row.id || '', journeyName: row.name || '', screenIndex: sc.index,
      screenId: screen ? screen.id : (ds && ds.nodeId) || sc.key, designId: sc.key,
      name: (screen && screen.name) || (ds && (ds.title || ds.name)) || sc.key,
      words, sub: firstSentence(words),
      state: planned ? 'planned' : 'built',
      read: !!seg,
      segs: seg ? [{ seg, a: sc.a }] : [],
      ...extra,
    };
  }

  // the facts each stage's segments carry: its tests (the first segment's, the street's chip), its decisions, what it
  // writes and reads, and the code it runs
  for (const st of stages) {
    const first = st.segs[0];
    const cov = first ? (((first.a.summary.coverage || {}).segments) || [])[first.seg.index] || null : null;
    st.tests = (cov && cov.counted && cov.counted.tests) || null;
    st.evidence = cov;
    const seen = new Set();
    st.decisions = [];
    st.runs = new Set();
    st.writes = new Map();             // record node id → { store, name, writer }
    st.reads = new Set();              // record node ids
    for (const { seg } of st.segs) {
      for (const d of seg.decisions || []) {
        if (d && d.class === 'business' && d.label && !seen.has(d.label)) { seen.add(d.label); st.decisions.push(d.label); }
      }
      const byOrder = new Map((seg.markers || []).map((m) => [m.stepOrder, m]));
      for (const m of seg.markers || []) {
        if (m.nodeId) st.runs.add(m.nodeId);
        if (!DATA_KINDS.has(m.kind)) continue;
        const node = get(m.nodeId);
        const store = storeOf(m, node);
        const mode = markerMode(m);
        if (mode === 'read') st.reads.add(m.nodeId);
        if (mode !== 'write' || !store || st.writes.has(m.nodeId)) continue;
        const up = m.under != null ? byOrder.get(m.under) : null;
        st.writes.set(m.nodeId, { store, name: m.name || (node && node.name) || m.nodeId, kind: m.kind, writer: up && up.nodeId ? { id: up.nodeId, name: up.name || up.nodeId } : null });
      }
    }
  }

  // ── the store lanes: every store a stage writes to, in the order the columns first write to it
  const storeLanes = [];
  for (const st of [...stages].sort((a, b) => a.col - b.col)) {
    for (const w of st.writes.values()) {
      const have = storeLanes.find((s) => storeKey(s.store) === storeKey(w.store));
      if (!have) storeLanes.push({ store: w.store, firstCol: st.col });
      else if (!have.store.engine && w.store.engine) have.store = w.store;
    }
  }

  // the lifecycles the storyline's answers carry, one per record
  const lifeOf = new Map();
  for (const row of [...steps, ...branches]) {
    const a = answerOf(summaries, row.nodeId);
    for (const lc of (a && a.lifecycles) || []) if (lc && lc.lifecycle && !lifeOf.has(lc.nodeId)) lifeOf.set(lc.nodeId, lc);
  }

  // ── the pills: in each store lane a row per record it writes — a record whose statuses the code declares gets one
  // pill per status the storyline moves it into, in the lifecycle's order; any other record one *written* pill
  const pills = [];
  const lanesStore = storeLanes.map((sl) => {
    const recs = new Map();
    for (const st of stages) for (const [rid, w] of st.writes) if (storeKey(w.store) === storeKey(sl.store)) {
      if (!recs.has(rid)) recs.set(rid, { id: rid, name: w.name, kind: w.kind, writers: [] });
      recs.get(rid).writers.push({ stage: st, writer: w.writer });
    }
    const rows = [];
    for (const r of recs.values()) {
      const lc = lifeOf.get(r.id);
      if (lc) {
        const life = lc.lifecycle;
        const byTo = new Map();
        life.transitions.forEach((tr) => {
          const makers = stages.filter((s) => s.runs.has(tr.by));
          if (!makers.length) return;
          if (!byTo.has(tr.to)) byTo.set(tr.to, { to: tr.to, moves: [], stages: [] });
          const p = byTo.get(tr.to);
          p.moves.push({ from: tr.from, by: tr.by, byName: (lc.writers && lc.writers[tr.by]) || String(tr.by).split('::').pop(), via: tr.via, line: tr.line });
          for (const s of makers) if (!p.stages.includes(s)) p.stages.push(s);
        });
        const order = (s) => { const i = life.statuses.indexOf(s); return i < 0 ? life.statuses.length : i; };
        const list = [...byTo.values()].sort((a, b) => order(a.to) - order(b.to));
        if (list.length) rows.push({ record: r, lifecycle: lc, pills: list.map((p) => ({ ...p, created: p.to === life.statuses[0] && p.moves.every((x) => x.from == null) })) });
      }
      if (!lc || !rows.some((x) => x.record === r)) rows.push({ record: r, lifecycle: null, pills: [{ to: null, moves: r.writers.filter((w) => w.writer).map((w) => ({ by: w.writer.id, byName: w.writer.name })), stages: [...new Set(r.writers.map((w) => w.stage))] }] });
    }
    // the records whose moves the storyline makes first (the most moves first), then the others by where they are first written
    const firstCol = (row) => Math.min(...row.pills.flatMap((p) => p.stages.map((s) => s.col)));
    rows.sort((a, b) => (Number(!!b.lifecycle) - Number(!!a.lifecycle)) || (b.pills.length - a.pills.length) || (firstCol(a) - firstCol(b)) || a.record.name.localeCompare(b.record.name));
    // a lane draws its first `maxRows` records; the rest are folded into one line that names them (and still counted)
    const cap = config.maxRows > 0 ? config.maxRows : 2;
    const folded = rows.slice(cap).map((r) => ({ id: r.record.id, name: r.record.name, writes: r.pills.length }));
    return { ...sl, rows: rows.slice(0, cap), folded };
  });

  // ── the lanes, in order: persona lanes in the tree's order, then store lanes; a lane the config names takes its id,
  // its word and its second line, and the lanes it names come first in its order
  const usedPersonas = [...new Set([...laneOfJourney.values()])].map((x) => x.slice(2));
  const personaIndex = (p) => { const i = personaOrder.indexOf(p); return i < 0 ? personaOrder.length : i; };
  usedPersonas.sort((a, b) => personaIndex(a) - personaIndex(b));
  const lanes = [];
  for (const p of usedPersonas) {
    const row = personaRows.find((x) => x.id === p);
    lanes.push({ id: p || 'nobody', ref: 'p:' + p, kind: 'persona', persona: p, name: row ? row.name : '', description: row && row.description ? row.description : '', surface: '', declared: null });
  }
  for (const sl of lanesStore) lanes.push({ id: 'store:' + sl.store.name, ref: 'st:' + storeKey(sl.store), kind: 'store', store: sl.store, name: sl.store.name, description: '', surface: '', declared: null, rows: sl.rows, folded: sl.folded });
  laneDecls.forEach((d, i) => {
    const hit = lanes.find((l) => (d.persona && l.kind === 'persona' && keyOf(l.persona) === keyOf(d.persona))
      || (d.store && l.kind === 'store' && keyOf(l.store.name) === keyOf(d.store)));
    if (!hit) {
      notes.push(d.persona ? { key: 'lanes.note.persona', vars: { id: d.id, persona: d.persona } } : { key: 'lanes.note.store', vars: { id: d.id, store: d.store } });
      return;
    }
    hit.id = d.id;
    hit.declared = i;
    if (d.name) { hit.name = d.name; hit.declaredName = d.name; }
    if (d.surface) hit.surface = d.surface;
  });
  const rank = (l) => (l.declared == null ? 1e6 : l.declared);
  const pl = lanes.filter((l) => l.kind === 'persona').map((l, i) => ({ l, i })).sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i).map((x) => x.l);
  const sl2 = lanes.filter((l) => l.kind === 'store').map((l, i) => ({ l, i })).sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i).map((x) => x.l);
  const ordered = pl.concat(sl2);
  const laneByRef = new Map(ordered.map((l) => [l.ref, l]));
  for (const st of stages) st.lane = laneByRef.get(st.lane) ? laneByRef.get(st.lane).id : st.lane;

  // rows inside a persona lane: a stage whose column is taken in its lane goes on a row below
  const taken = new Set();
  for (const st of stages) {
    let r = 0;
    while (taken.has(st.lane + '|' + st.col + '|' + r)) r++;
    st.row = r;
    taken.add(st.lane + '|' + st.col + '|' + r);
  }
  // pills: at the column of the first stage that makes the move, never left of the pill before it in the row
  let maxCol = Math.max(0, ...stages.map((s) => s.col));
  for (const l of sl2) {
    l.rows.forEach((row, ri) => {
      let prev = -1;
      row.pills.forEach((p, pi) => {
        const c = Math.max(Math.min(...p.stages.map((s) => s.col)), prev + 1);
        prev = c;
        maxCol = Math.max(maxCol, c);
        const label = row.lifecycle ? (p.created ? 'created' : 'move') : 'written';
        pills.push({
          key: 'r:' + l.id + '|' + row.record.id + '|' + (p.to == null ? '*' : p.to), lane: l.id, row: ri, col: c,
          record: { id: row.record.id, name: row.record.name }, status: p.to, kind: label, first: pi === 0,
          moves: p.moves, writers: [...new Set(p.moves.map((m) => m.byName))], stages: p.stages.map((s) => s.key),
          checked: p.moves.length ? p.moves.every((m) => m.from != null) : null,
        });
      });
    });
    l.rowCount = l.rows.length;
  }
  for (const l of pl) l.rowCount = Math.max(1, ...stages.filter((s) => s.lane === l.id).map((s) => s.row + 1));

  // ── what each move needs (lane G's `moments[k].preconditions`): read from the first screen that makes the move — the
  // action's checks in tier order, and whether the code checks the status it moves from
  const stageObj = new Map(stages.map((s) => [s.key, s]));
  for (const p of pills) {
    if (p.kind === 'written') continue;
    const first = [...p.stages].map((k) => stageObj.get(k)).filter(Boolean).sort((a, b) => a.col - b.col)[0];
    if (!first) continue;
    let found = null;
    for (const { seg } of first.segs) {
      for (const mo of seg.moments || []) {
        const pre = mo && mo.preconditions;
        const mv = pre && (pre.moves || []).find((x) => (x.table === p.record.id || x.record === p.record.name) && x.to === p.status);
        if (mv) { found = { pre, mv }; break; }
      }
      if (found) break;
    }
    if (!found) continue;
    const list = found.pre.preconditions || [];
    const lc = lifeOf.get(p.record.id);
    const statuses = lc ? lc.lifecycle.statuses : [];
    const at = statuses.indexOf(p.status);
    // a move that does not check the status it leaves: the status before it in the lifecycle is the one it is meant to leave
    const unchecked = !found.mv.checked && !found.mv.creates;
    p.needs = {
      action: found.pre.action,
      counted: found.pre.counted || null,
      shown: list.filter((x) => x.tier !== 'technical').map((x) => ({ words: x.words, wordsFrom: x.wordsFrom, tier: x.tier, class: x.class, role: x.role || null, evidence: x.evidence || null, loc: x.loc || '', planned: !!x.planned })),
      technical: list.filter((x) => x.tier === 'technical').length,
      notChecked: unchecked ? { record: p.record.name, status: at > 0 ? statuses[at - 1] : (found.mv.fromAny || [])[0] || null } : null,
    };
  }

  // ── the arrows
  const arrows = [];
  // one arrow per pill, from the first screen that makes the move (the pill's tip names every screen that does)
  const stageCol = new Map(stages.map((s) => [s.key, s.col]));
  for (const p of pills) {
    const first = [...p.stages].sort((a, b) => stageCol.get(a) - stageCol.get(b))[0];
    if (first) arrows.push({ kind: 'moves', from: first, to: p.key });
  }
  const stageByKey = new Map(stages.map((s) => [s.key, s]));
  // then: a stage to the next one in its lane, on the main path and inside each branch
  const mainOrder = stages.filter((s) => !s.branch).sort((a, b) => a.col - b.col);
  for (let i = 1; i < mainOrder.length; i++) {
    if (mainOrder[i].lane === mainOrder[i - 1].lane) arrows.push({ kind: 'then', from: mainOrder[i - 1].key, to: mainOrder[i].key });
  }
  for (const b of branches) {
    const list = journeyStages.get(b.nodeId) || [];
    for (let i = 1; i < list.length; i++) arrows.push({ kind: 'then', from: list[i - 1], to: list[i] });
    const parent = journeyStages.get(b.branchOf) || [];
    const last = parent.map((k) => stageByKey.get(k)).sort((a, c) => c.col - a.col)[0];
    if (last && list.length) arrows.push({ kind: 'branch', from: last.key, to: list[0], label: String(b.when || '') });
  }
  // the hand-offs the design names, drawn only where the graph finds both ends
  const laneRef = (ref) => ordered.find((l) => keyOf(l.id) === keyOf(ref) || (l.kind === 'persona' && keyOf(l.persona) === keyOf(ref)) || (l.kind === 'store' && keyOf(l.store.name) === keyOf(ref)));
  const stageRef = (ref) => {
    const m = /^(.+)#(\d+)$/.exec(String(ref || ''));
    if (!m) return null;
    const row = [...steps, ...branches].find((j) => keyOf(j.id) === keyOf(m[1]));
    const list = row ? journeyStages.get(row.nodeId) || [] : [];
    return stageByKey.get(list[Number(m[2]) - 1]) || null;
  };
  for (const h of handoffs) {
    const say = (key, vars) => notes.push({ key: 'lanes.note.handoff', vars: { from: h.from, to: h.to }, why: { key, vars: vars || {} } });
    if (h.kind === 'moves') {
      const st = stageRef(h.from), lane = laneRef(h.to);
      if (!st) { say('lanes.why.noScreen', { ref: h.from }); continue; }
      if (!lane || lane.kind !== 'store') { say('lanes.why.noStoreLane', { ref: h.to }); continue; }
      const p = pills.find((x) => x.lane === lane.id && x.status != null && keyOf(x.status) === keyOf(h.status));
      if (!p) { say('lanes.why.noMove', { store: lane.name, status: h.status }); continue; }
      const have = arrows.find((a) => a.kind === 'moves' && a.from === st.key && a.to === p.key);
      if (have) { have.declared = true; if (h.when) have.label = h.when; } else arrows.push({ kind: 'moves', from: st.key, to: p.key, declared: true, label: h.when || '' });
    } else {
      const lane = laneRef(h.from), st = stageRef(h.to);
      if (!st) { say('lanes.why.noScreen', { ref: h.to }); continue; }
      if (!lane || lane.kind !== 'store') { say('lanes.why.noStoreLane', { ref: h.from }); continue; }
      if (!h.status) { say('lanes.why.noStatus'); continue; }
      const p = pills.find((x) => x.lane === lane.id && x.status != null && keyOf(x.status) === keyOf(h.status));
      if (!p) { say('lanes.why.noMove', { store: lane.name, status: h.status }); continue; }
      if (!st.reads.has(p.record.id)) { say('lanes.why.noRead', { screen: st.name, record: p.record.name }); continue; }
      if (st.lane === lane.id) { say('lanes.why.sameLane'); continue; }
      arrows.push({ kind: 'seen', from: p.key, to: st.key, declared: true, label: h.when || '', status: p.status });
    }
  }

  // ── the counts: lanes' own, and the footer's — every one with the scope it counts over
  for (const l of ordered) {
    if (l.kind === 'persona') {
      const mine = stages.filter((s) => s.lane === l.id);
      const branchN = mine.filter((s) => s.branch).length;
      l.count = { n: mine.length, unit: 'lanes.count.screens', bizUnit: 'lanes.count.screens', scope: 'lanes.scope.lane', source: SRC + ' → stages in this lane', // str:ok a Counted's source: where the number was read, for the tip's from line
        breakdown: [{ key: 'lanes.part.mainPath', n: mine.length - branchN }, { key: 'lanes.part.branch', n: branchN }] };
    } else {
      const mine = pills.filter((p) => p.lane === l.id);
      const foldedN = (l.folded || []).reduce((n, r) => n + r.writes, 0);
      const moves = mine.filter((p) => p.kind !== 'written').length;
      l.count = { n: mine.length + foldedN, unit: 'lanes.count.writes', bizUnit: 'lanes.count.writes', scope: 'count.scope.storyline', source: SRC + ' → write markers + lifecycles',
        breakdown: [{ key: 'lanes.part.statusMoves', n: moves }, { key: 'lanes.part.recordsWritten', n: mine.length - moves }, ...(foldedN ? [{ key: 'lanes.part.folded', n: foldedN }] : [])] };
    }
  }
  const distinct = new Map();
  for (const s of stages) if (!distinct.has(s.designId)) distinct.set(s.designId, s);
  const built = [...distinct.values()].filter((s) => s.state === 'built').length;
  const counts = {
    journeys: (story.counts && story.counts.journeys) || { n: steps.length + branches.length, unit: 'map.band.journeys', scope: 'count.scope.storyline', source: SRC },
    screens: { n: distinct.size, unit: 'lanes.count.distinctScreens', bizUnit: 'lanes.count.distinctScreens', scope: 'count.scope.storyline', source: SRC + ' → stages by screen', // str:ok a Counted's source: where the number was read, for the tip's from line
      breakdown: [{ key: 'lanes.part.built', n: built }, { key: 'lanes.part.notBuilt', n: distinct.size - built }] },
    built: { n: built, of: distinct.size, unit: 'lanes.count.built', bizUnit: 'lanes.count.built', scope: 'count.scope.storyline', source: SRC + ' → stages by screen · state' }, // str:ok a Counted's source: where the number was read, for the tip's from line
    branches: { n: branches.length, unit: 'lanes.count.branches', bizUnit: 'lanes.count.branches', scope: 'count.scope.storyline', source: 'laneLayout ← /api/journeys storyline.branches' },
  };
  const read = [...steps, ...branches].filter((j) => answerOf(summaries, j.nodeId)).length;

  return {
    storyline: { id: story.id || '', name: story.name || story.id || '', description: story.description || '' },
    ready: read === steps.length + branches.length,
    read, of: steps.length + branches.length, stepsOf: steps.length, firstFlow: steps.length ? steps[0].nodeId : '',
    lanes: ordered.map(({ rows, ref, declared, ...l }) => l),
    stages: stages.map(({ segs, runs, writes, reads, ...s }) => ({ ...s, reads: [...reads] })),
    needs: pills.some((p) => p.needs),
    pills, arrows,
    lifecycles: [...new Set(pills.filter((p) => p.kind !== 'written').map((p) => p.record.id))].map((id) => lifeOf.get(id)).filter(Boolean),
    columns: Math.max(mainCols, maxCol + 1),
    counts, notes,
  };
}

/**
 * The lanes board's geometry in *board px*: the surface draws the board at LANE_K world units a board px (the way the
 * chain board draws its cards at BOARD_K), so the stylesheet's ordinary type sizes read at the fit.
 */
export const LANE_K = 2;
export const LANE_GEOM = Object.freeze({
  head: 124, col: 158, cardW: 144, cardH: 116, rowGap: 10, pad: 8, pillH: 44, pillRow: 50,
  laneGap: 6, segGap: 34, top: 44, margin: 16, storeMinH: 66,
});

/**
 * Where every lane, stage and pill sits. The columns wrap into `k` segments, each with the lanes again, `k` chosen to
 * bring the board's shape nearest the stage's (`opts.aspect`, width ÷ height, with `opts.extraH` world units under
 * the lanes for the lifecycle strip and the footer) so the fit is as large as it can be. Pure; O(stages + pills).
 */
export function laneGeometry(model, opts = {}) {
  const g = { ...LANE_GEOM, ...(opts.geom || {}) };
  const cols = Math.max(1, model.columns || 1);
  const laneH = model.lanes.map((l) => (l.kind === 'store'
    ? Math.max(g.storeMinH, g.pad * 2 + Math.max(1, l.rowCount || 1) * g.pillRow - (g.pillRow - g.pillH))
    : g.pad * 2 + Math.max(1, l.rowCount || 1) * (g.cardH + g.rowGap) - g.rowGap));
  const lanesH = laneH.reduce((a, b) => a + b, 0) + g.laneGap * Math.max(0, laneH.length - 1);
  const extraH = opts.extraH || 0;
  const aspect = opts.aspect > 0 ? opts.aspect : 1.6;
  let best = null;
  const maxK = Math.max(1, Math.ceil(cols / 2));
  for (let k = opts.k || 1; k <= (opts.k || maxK); k++) {
    const per = Math.ceil(cols / k);
    if (!opts.k && k > 1 && Math.ceil(cols / (k - 1)) === per) continue;
    const w = g.margin * 2 + g.head + per * g.col;
    const h = g.top + k * lanesH + (k - 1) * g.segGap + extraH + g.margin;
    // the fit scale on a unit-height stage of this aspect: the larger, the more readable
    const fit = Math.min(aspect / w, 1 / h);
    if (!best || fit > best.fit * 1.0001) best = { k, per, w, h, fit };
  }
  const { k, per } = best;
  const segH = lanesH;
  const laneY = [];
  let y = 0;
  laneH.forEach((h) => { laneY.push(y); y += h + g.laneGap; });
  const segments = [];
  for (let i = 0; i < k; i++) segments.push({ index: i, x: g.margin, y: g.top + i * (segH + g.segGap), w: g.head + per * g.col, h: segH, from: i * per, to: Math.min(cols, (i + 1) * per) - 1 });
  const laneRects = [];
  segments.forEach((sg) => model.lanes.forEach((l, li) => laneRects.push({ lane: l.id, segment: sg.index, x: sg.x, y: sg.y + laneY[li], w: sg.w, h: laneH[li] })));
  const laneIndex = new Map(model.lanes.map((l, i) => [l.id, i]));
  const at = (lane, c) => {
    const sg = segments[Math.min(k - 1, Math.floor(c / per))];
    const li = laneIndex.get(lane) || 0;
    return { sg, x: sg.x + g.head + (c - sg.index * per) * g.col + (g.col - g.cardW) / 2, y: sg.y + laneY[li] + g.pad };
  };
  const rects = new Map();
  for (const s of model.stages) {
    const p = at(s.lane, s.col);
    rects.set(s.key, { x: p.x, y: p.y + s.row * (g.cardH + g.rowGap), w: g.cardW, h: g.cardH, segment: p.sg.index });
  }
  for (const p of model.pills) {
    const a = at(p.lane, p.col);
    rects.set(p.key, { x: a.x, y: a.y + p.row * g.pillRow, w: g.cardW, h: g.pillH, segment: a.sg.index });
  }
  const lanesBottom = segments[k - 1].y + segH;
  return { k, per, segments, laneRects, rects, lanesBottom, size: { w: best.w, h: lanesBottom + extraH + g.margin }, geom: g };
}
