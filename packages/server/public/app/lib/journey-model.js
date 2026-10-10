// lib/journey-model.js — the journey's pure folds, out of the surfaces that draw them.
//
// One journey answer (`/api/journey`: `summary` + `steps`) is drawn as the Sheet, the ladder and the drill's
// lanes on the journey overlay, and as the Map's journey, screen and action stops. What each of those draws
// is decided here, once, from the answer alone: no DOM, no store, no catalog — a surface hands in the words
// (`t`, a row's label) and the lens-aware choices (which gates to draw, what folds as plumbing), and turns the
// plain objects that come back into its own markup. `surfaces/journeys.js` and `surfaces/journey-drill.js`
// re-export the old names as thin wrappers, so nothing that imported them changed (lanes round 2026-10-10,
// proposal 1 step 1).

const id = (k) => k;

/**
 * A segment's actions in the order its screen's manifest lists the operations, with anything the manifest does
 * not list after them in walk order. The array the fold hands out stays in walk order (the markers index into it
 * positionally), so the ordering is a display choice made here and nowhere else.
 */
export function rankOrder(sg) {
  const ms = ((sg && sg.moments) || []).slice();
  if (!ms.some((mo) => mo.rank != null)) return ms;
  return ms.sort((a, b) => (a.rank != null ? a.rank : a.index) - (b.rank != null ? b.rank : b.index));
}

/** The 1-based ordinal an action is printed with inside its screen: its place in `rankOrder`. */
export function momOrdinal(sg, mo) {
  const i = rankOrder(sg).findIndex((x) => x.index === mo.index);
  return (i < 0 ? mo.index : i) + 1;
}

/**
 * Parent / children / roots of the walk from the DFS pre-order depth sequence of its steps (the wire order of
 * `/api/journey`).
 */
export function buildTree(steps) {
  const list = steps || [];
  const parent = list.map(() => -1), children = list.map(() => []), roots = [], stack = [];
  list.forEach((s, i) => {
    const d = s.depth || 0;
    while (stack.length && (list[stack[stack.length - 1]].depth || 0) >= d) stack.pop();
    if (stack.length) { parent[i] = stack[stack.length - 1]; children[parent[i]].push(i); } else roots.push(i);
    stack.push(i);
  });
  return { parent, children, roots };
}

/**
 * The drill tree of one cell (a system row × an action): who hangs under whom, from the core's `under`, and which
 * markers are drawn by default — every root of the cell, plus tiers 0–1 that are not plumbing. Everything deeper
 * folds under the part it belongs to. The same node reached again inside the cell is one chip, its repeats folded
 * under its first visit. `helper(m)` says what folds as plumbing in the lens on screen (default: the core's
 * `helper` flag).
 */
export function cellTree(ms, helper) {
  const isHelper = helper || ((m) => !!m.helper);
  const list = ms || [];
  const here = new Set(list.map((m) => m.stepOrder));
  const kids = new Map();
  list.forEach((m) => {
    if (m.under == null || !here.has(m.under)) return;
    if (!kids.has(m.under)) kids.set(m.under, []);
    kids.get(m.under).push(m);
  });
  const all = list.filter((m) => m.under == null || !here.has(m.under) || (!isHelper(m) && (m.tier == null || m.tier <= 1)));
  const firstOf = new Map(), agains = new Map(), top = [];
  all.forEach((m) => {
    const seen = firstOf.get(m.nodeId);
    if (seen == null) { firstOf.set(m.nodeId, m.stepOrder); top.push(m); return; }
    if (!agains.has(seen)) agains.set(seen, []);
    agains.get(seen).push(m);
  });
  const drawn = new Set(all.map((m) => m.stepOrder));
  const drill = (o) => (kids.get(o) || []).filter((k) => !drawn.has(k.stepOrder));
  const again = (o) => agains.get(o) || [];
  return { top, drill, again };
}

/**
 * The Sheet's model: the columns — every action of every segment in journey order, the **stops** — and the layers:
 * *what the user sees* on top, the code layers (the repos and the API) in request order, *gates & business*, the
 * data layers (records, messages, third party), *verified by* at the foot. A system the journey never touches has
 * no row. `w.t(key)` words a catalog key; `w.rowLabel(row)` labels a records / messages / third-party row.
 */
export function sheetModel(sum, w = {}) {
  const t = w.t || id;
  const rowLabel = w.rowLabel || ((r) => ({ label: r.label || r.key, sub: '' }));
  const sysLayer = (r) => {
    if (r.kind === 'api') return { key: r.key, kind: 'api', row: r, label: t('journey.layer.api'), sub: r.planned ? t('journey.rowPlanned') : r.label, cls: 'api' };
    if (r.kind === 'repo') {
      const ux = r.side === 'ux';
      return { key: r.key, kind: 'repo', side: r.side, row: r, label: t(ux ? 'journey.layer.app' : 'journey.layer.server'),
        sub: r.label + ' · ' + t('journey.rowSub.' + (ux ? 'ux' : 'server')), cls: ux ? 'app' : 'srv' };
    }
    const lb = rowLabel(r);
    return { key: r.key, kind: r.kind, row: r, label: lb.label, sub: lb.sub, cls: r.kind === 'records' ? 'db' : r.kind === 'messages' ? 'msg' : 'ext' };
  };
  const cols = [];
  ((sum && sum.segments) || []).forEach((sg) => rankOrder(sg).forEach((mo, i) => cols.push({ index: cols.length, sg, mo, first: i === 0 })));
  const rows = (sum && sum.systems) || [];
  const layers = [{ key: 'user', kind: 'user', label: t('journey.layer.user'), sub: t('journey.layerSub.user'), cls: 'ui' }];
  rows.filter((r) => r.kind === 'repo' || r.kind === 'api').forEach((r) => layers.push(sysLayer(r)));
  layers.push({ key: 'gates', kind: 'gates', label: t('journey.layer.gates'), sub: t('journey.layerSub.gates'), cls: 'gate' });
  rows.filter((r) => r.kind !== 'repo' && r.kind !== 'api').forEach((r) => layers.push(sysLayer(r)));
  layers.push({ key: 'verified', kind: 'verified', label: t('journey.layer.verified'), sub: t('journey.layerSub.verified'), cls: 'test' });
  return { cols, layers };
}

/**
 * The stop a part of the walk sits in — its column on the Sheet, its stop on the drill's rail: `{ n, t }` (1-based,
 * of the journey's stops), or null when it belongs to no stop. A part the band does not draw takes the stop of the
 * nearest drawn part above it (`parent`, the walk's tree).
 */
export function stopOf(sum, order, parent) {
  if (!sum || order == null || order < 0) return null;
  const find = (o) => { for (const sg of sum.segments || []) { const m = (sg.markers || []).find((x) => x.stepOrder === o); if (m) return { sg, m }; } return null; };
  let cur = order, hit = find(cur);
  for (let guard = 0; !hit && parent && cur != null && cur >= 0 && guard < 64; guard++) { cur = parent[cur]; hit = cur != null && cur >= 0 ? find(cur) : null; }
  if (!hit || hit.m.moment == null) return null;
  const cols = sheetModel(sum).cols;
  const at = cols.findIndex((c) => c.sg === hit.sg && c.mo.index === hit.m.moment);
  return at < 0 ? null : { n: at + 1, t: cols.length };
}

/** The stop (a Sheet column, 0-based) a marker's action is, or -1. */
export function actionOfMarker(cols, stepOrder) {
  for (const c of cols || []) {
    if ((c.sg.markers || []).some((m) => m.stepOrder === stepOrder && m.moment === c.mo.index)) return c.index;
  }
  return -1;
}

/**
 * The segments a street screen stands for: its own, and the screenless segments before it that the street folds
 * into it (lib/map-model.js `streetModel`). `screens` are the street's rows (each with `segment.index`).
 */
export function screenSegments(screens, si) {
  const s = screens && screens[si];
  if (!s || !s.segment) return [];
  const prev = si > 0 && screens[si - 1] && screens[si - 1].segment ? screens[si - 1].segment.index : -1;
  const out = [];
  for (let i = prev + 1; i <= s.segment.index; i++) out.push(i);
  return out;
}

/** The stops (Sheet columns) of one street screen, in journey order. */
export function screenActions(cols, screens, si) {
  const segs = new Set(screenSegments(screens, si));
  return (cols || []).filter((c) => segs.has(c.sg.index));
}

/** The street screen (0-based) an action stop sits on, or -1. */
export function screenOfAction(cols, screens, ci) {
  const c = (cols || [])[ci];
  if (!c) return -1;
  for (let si = 0; si < (screens || []).length; si++) if (screenSegments(screens, si).includes(c.sg.index)) return si;
  return -1;
}

/**
 * The drill's rows: the Sheet's layers minus *verified by* (tests are an inspector tab there), plus the records ·
 * messages · third party rows when the walk reached none — an absent row says the core's word for the whole
 * journey instead of vanishing. `w.absentText(word)` words an absence word.
 */
export function drillLayers(sum, w = {}) {
  const t = w.t || id;
  const absentText = w.absentText || id;
  const layers = sheetModel(sum, w).layers.filter((l) => l.kind !== 'verified');
  const have = new Set(layers.map((l) => l.kind));
  [['records', 'db'], ['messages', 'msg'], ['external', 'ext']].forEach(([kind, cls]) => {
    if (have.has(kind)) return;
    const word = (sum && sum.absentKinds && sum.absentKinds[kind]) || 'noneIndexed';
    layers.push({ key: 'absent:' + kind, kind, label: t('journey.row.' + kind), sub: absentText(word) + ' · ' + t('journey.rowSub.' + kind), cls, absent: true, word });
  });
  return layers;
}

/** Which row a marker draws in: the user row for a component or page, else its system's row. */
export function drillLayerOf(m, byKey, steps) {
  const n = ((steps || [])[m.stepOrder] || {}).node || {};
  if (m.kind === 'step' && (n.kind === 'component' || n.kind === 'page') && byKey.user != null) return byKey.user;
  return byKey[m.system] != null ? byKey[m.system] : (byKey.user || 0);
}

/**
 * The beats of one action, in causal order: the screen (when it stayed open from an earlier action), then every
 * tier 0–1 part of the drill tree in step order — the action in the browser, the call across the seam, the handler
 * and the parts it calls. A minor part (no drill of its own, no data under it, no authored label) folds into the
 * beat before it as an *also*. The **answer** beat — the contract's responses — sits after the last server beat.
 * Records, messages and third parties land in the column of the part that reached them; gates and decisions in the
 * column of the step they sit on.
 *
 * `ctx`: `steps` (the walk, for the node behind a marker), `parent` (the walk's tree), `helper` (what folds as
 * plumbing), `gates` / `decs` (the action's gates and decisions **this lens draws**, the caller's choice). Returns
 * the beats, `colOf` (step order → beat), `cells` (`'<layer>:<beat>'` → boxes to draw, in order: `{ type: 'part' |
 * 'data' | 'screen' | 'answer' | 'gate' | 'dec', … }`), the `wires`, the transaction side of each column
 * (`txCols`), the action's own `call` and the cell `tree` its boxes fold with.
 */
export function drillBeats(col, layers, ctx = {}) {
  const { sg, mo } = col;
  const steps = ctx.steps || [];
  const parent = ctx.parent || null;
  const byKey = {};
  layers.forEach((l, li) => { byKey[l.key] = li; });
  const ms = (sg.markers || []).filter((m) => m.moment === mo.index);
  const tree = cellTree(ms, ctx.helper);
  const here = new Map(ms.map((m) => [m.stepOrder, m]));
  const reach = new Set();
  ms.forEach((m) => {
    if (m.kind !== 'record' && m.kind !== 'message' && m.kind !== 'external') return;
    for (let u = m.under; u != null && here.has(u); u = here.get(u).under) reach.add(u);
  });
  const beats = [], colOf = {}, cells = {};
  const owns = (o, bi) => { colOf[o] = bi; tree.again(o).forEach((r) => { colOf[r.stepOrder] = bi; }); };
  const put = (li, bi, box) => { (cells[li + ':' + bi] = cells[li + ':' + bi] || []).push(box); };
  const layerOf = (m) => drillLayerOf(m, byKey, steps);
  const isUx = (li) => layers[li] && (layers[li].kind === 'user' || (layers[li].kind === 'repo' && layers[li].side === 'ux'));
  const isServer = (li) => layers[li] && layers[li].kind === 'repo' && layers[li].side === 'server';
  const isMinor = (m) => {
    if (m.kind !== 'step' || m.business || m.tier == null || m.tier < 1) return false;
    if (reach.has(m.stepOrder)) return false;
    return !tree.drill(m.stepOrder).some((k) => !k.helper);
  };
  const colOfStep = (o) => {
    for (let cur = o, n = 0; cur != null && cur >= 0 && n < 64; n++) {
      if (colOf[cur] != null) return colOf[cur];
      const m = here.get(cur);
      cur = m && m.under != null ? m.under : (parent ? parent[cur] : -1);
    }
    return null;
  };
  if (mo.component && mo.component.stepOrder < mo.from && byKey.user != null) {
    beats.push({ kind: 'screen', order: mo.component.stepOrder, layer: byKey.user, open: true, comp: mo.component, also: [] });
    colOf[mo.component.stepOrder] = 0;
  }
  const calls = ms.filter((m) => m.kind === 'call');
  const call = (mo.callStep != null && calls.find((m) => m.stepOrder === mo.callStep)) || calls[0] || null;
  const callNode = call ? ((steps[call.stepOrder] || {}).node || {}) : {};
  const answer = call && callNode.contract && (callNode.contract.responses || []).length ? { call, contract: callNode.contract } : null;
  let last = -1, lastServer = -1, answerAt = -1;
  const pushAnswer = () => {
    beats.push({ kind: 'answer', layer: byKey[call.system] != null ? byKey[call.system] : 0, answer, also: [] });
    answerAt = beats.length - 1;
  };
  tree.top.forEach((m) => {
    if (m.kind === 'record' || m.kind === 'message' || m.kind === 'external') {
      let bi = colOfStep(m.stepOrder);
      if (bi == null) bi = last >= 0 ? last : 0;
      if (!beats.length) { beats.push({ kind: 'data', layer: layerOf(m), m, also: [] }); bi = 0; }
      owns(m.stepOrder, bi);
      put(layerOf(m), bi, { type: 'data', m, layer: layerOf(m) });
      return;
    }
    const li = layerOf(m);
    if (isMinor(m) && last >= 0 && m.under != null && colOf[m.under] === last && beats[last].m
      && (beats[last].m.tx || null) === (m.tx || null)) {
      beats[last].also.push(m); owns(m.stepOrder, last);
      return;
    }
    if (answer && answerAt < 0 && lastServer >= 0 && isUx(li)) pushAnswer();
    beats.push({ kind: m.kind === 'call' ? 'seam' : 'part', layer: li, m, also: [] });
    last = beats.length - 1; owns(m.stepOrder, last);
    if (isServer(li)) lastServer = last;
  });
  if (answer && answerAt < 0 && (lastServer >= 0 || colOf[call.stepOrder] != null)) pushAnswer();
  beats.forEach((b, bi) => {
    if (b.kind === 'screen') put(b.layer, bi, { type: 'screen', comp: b.comp, sg });
    else if (b.kind === 'answer') put(b.layer, bi, { type: 'answer', answer: b.answer });
    else if (b.kind !== 'data') put(b.layer, bi, { type: 'part', m: b.m, layer: b.layer, also: b.also });
  });
  const gates = ctx.gates || [], decs = ctx.decs || [];
  if (byKey.gates != null) {
    gates.forEach((g, k) => { const bi = colOfStep(g.stepOrder); if (bi != null) put(byKey.gates, bi, { type: 'gate', g, bi, k }); });
    decs.forEach((d, k) => { const bi = colOfStep(d.order); if (bi != null) put(byKey.gates, bi, { type: 'dec', d, bi, k }); });
  }
  const txCols = beats.map(() => null);
  ms.forEach((m) => {
    if (!m.tx) return;
    const bi = colOf[m.stepOrder] != null ? colOf[m.stepOrder] : colOfStep(m.stepOrder);
    if (bi == null || bi < 0 || bi >= txCols.length) return;
    txCols[bi] = txCols[bi] == null || txCols[bi] === m.tx ? m.tx : 'straddles';
  });
  const wires = [];
  const boxId = (b) => (b.kind === 'answer' ? 'jrn-ans' : b.kind === 'screen' ? 'jrn-bx-' + b.order : 'jrn-bx-' + b.m.stepOrder);
  beats.forEach((b, bi) => {
    if (!bi) return;
    const prev = beats[bi - 1];
    if (b.kind === 'answer') wires.push({ a: boxId(lastServer >= 0 ? beats[lastServer] : prev), b: 'jrn-ans', cls: 'dash' });
    else wires.push({ a: boxId(prev), b: boxId(b), cls: (prev.kind === 'answer' || (b.m && b.m.planned)) ? 'dash' : '' });
  });
  ms.forEach((m) => {
    if (m.kind !== 'record' && m.kind !== 'message' && m.kind !== 'external') return;
    const bi = colOf[m.stepOrder];
    if (bi == null || !beats[bi] || beats[bi].kind === 'data') return;
    wires.push({ a: boxId(beats[bi]), b: 'jrn-bx-' + m.stepOrder, cls: m.kind === 'record' ? 'violet' : m.kind === 'message' ? 'q' : 'grey' });
  });
  gates.forEach((g, k) => { const bi = colOfStep(g.stepOrder); if (bi != null && beats[bi] && beats[bi].kind !== 'data') wires.push({ a: boxId(beats[bi]), b: 'jrn-bg-' + bi + '-' + k, cls: 'gate' }); });
  return { beats, colOf, cells, wires, call, txCols, tree, ms };
}

/** The step order a beat stands on — what selecting it selects: its part, the screen it kept open, the call it answers. */
export function beatOrder(b) {
  if (!b) return null;
  if (b.kind === 'answer') return b.answer.call.stepOrder;
  if (b.kind === 'screen') return b.order;
  return b.m ? b.m.stepOrder : null;
}

// The ladder's widths. A column a screen uses is never narrower than twice the share it had when every system drew a
// full lane (172 px) and grows to what it holds; a column it skips between two it uses keeps its place, narrow; the
// columns after the last one it uses fold into one end column.
export const LADDER = { TIME: 150, COL: 172, USED: 344, MAX: 520, SKIP: 34, END: 210, PAD: 32 };

/**
 * One segment's ladder before it is drawn: its lines — each a `time` (`{ mo }` where an action starts, else
 * `{ n }`, the step) and its `cells` by system key as plain descriptors (`caller` · `seam` · `out` · `marker` ·
 * `part`) — which systems those lines use, and the columns that follow from that: every system up to the last one
 * used, each `used` or `skip`, then the systems after it folded into one `end` list, with their widths.
 * `ctx.text(m)` is a marker's printed words (they size the column); `ctx.steps` the walk; `ctx.word(key)` the
 * absence word of a system this screen leaves empty.
 */
export function ladderModel(sum, sg, ctx = {}) {
  const steps = ctx.steps || [];
  const text = ctx.text || ((m) => String(m.name || ''));
  const systems = (sum && sum.systems) || [];
  const uxKey = (systems.find((r) => r.kind === 'repo' && r.side === 'ux') || {}).key;
  const svKey = (systems.find((r) => r.kind === 'repo' && r.side === 'server') || {}).key;
  const momStart = new Map();
  (sg.moments || []).forEach((mo) => { const first = sg.markers.find((m) => m.moment === mo.index); if (first) momStart.set(first.stepOrder, mo); });
  const want = {};
  const need = (key, px) => { want[key] = Math.max(want[key] || 0, px); };
  const MONO = 6.3;
  const lines = (sg.markers || []).map((m) => {
    const mo = momStart.get(m.stepOrder);
    const time = mo ? { mo } : { n: m.stepOrder + 1 };
    const cells = {};
    if (m.kind === 'call') {
      if (uxKey && m.caller) {
        const at = m.caller.path + ':' + m.caller.line;
        cells[uxKey] = { type: 'caller', at };
        need(uxKey, 30 + (at.length + 2) * MONO);
      }
      cells[m.system] = { type: 'seam', m };
      need(m.system, 70 + text(m).length * MONO);
    } else if (m.kind === 'record' || m.kind === 'message' || m.kind === 'external') {
      if (svKey) { cells[svKey] = { type: 'out' }; need(svKey, 40); }
      cells[m.system] = { type: 'marker', m };
      need(m.system, 44 + text(m).length * MONO);
    } else {
      const tier = m.tier != null ? m.tier : (m.helper ? 1 : 0);
      const node = m.nodeId && steps[m.stepOrder] && steps[m.stepOrder].node;
      const loc = node && node.loc ? node.loc.path + ':' + node.loc.line : '';
      cells[m.system] = { type: 'part', m, tier, loc };
      need(m.system, 40 + tier * 16 + text(m).length * MONO + (loc ? 8 + Math.min(loc.length, 30) * 5.9 : 0));
    }
    return { m, time, cells };
  });
  const used = new Set();
  lines.forEach((l) => Object.keys(l.cells).forEach((k) => used.add(k)));
  let last = -1;
  systems.forEach((r, i) => { if (used.has(r.key)) last = i; });
  const cols = systems.slice(0, last + 1).map((r) => ({ r, state: used.has(r.key) ? 'used' : 'skip' }));
  const end = systems.slice(last + 1);
  const full = !end.length && cols.every((c) => c.state === 'used');
  const L = LADDER;
  const widths = cols.map((c) => (c.state === 'skip' ? L.SKIP : Math.round(Math.max(L.USED, Math.min(L.MAX, want[c.r.key] || 0)))));
  const oldW = L.TIME + systems.length * L.COL;
  const nUsed = cols.filter((c) => c.state === 'used').length, nSkip = cols.length - nUsed;
  const rest = L.PAD + L.TIME + nSkip * L.SKIP + (end.length ? L.END : 0);
  const width = full ? oldW
    : Math.min(Math.max(oldW, rest + nUsed * L.COL), rest + widths.reduce((a, b) => a + b, 0) - nSkip * L.SKIP);
  const word = ctx.word || (() => 'notInvolved');
  return { lines, cols, end, full, widths, width, word };
}

/**
 * The ladder of one **action** (the Map's action stop, layout *ladder*): the segment's ladder kept to the lines of
 * that action's markers, the columns and widths recomputed for what those lines use.
 */
export function actionLadderModel(sum, col, ctx = {}) {
  const sg = col.sg;
  const only = Object.assign({}, sg, { markers: (sg.markers || []).filter((m) => m.moment === col.mo.index), moments: [col.mo] });
  return ladderModel(sum, only, ctx);
}
