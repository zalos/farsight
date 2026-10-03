// lib/map-model.js — the Map surface's data, as pure functions (no DOM, no store).
//
// Two shapes, both read straight from answers the server already gives
// (docs/proposals/map-view.md §3): the neighbourhood from `/api/design`'s flow
// rows, and one street from one `/api/journey` response. Nothing here invents a
// fact: every number the surface prints is a `Counted` this module hands on
// untouched, and every name is either the words the summary carries or the
// node's own name — which register prints which is the surface's call.
//
// The surface (surfaces/map.js) owns geometry and words; lane B's property
// (surfaces/map-property.js) reads the same `MapScreen` rows.

/** Kinds of marker the plumbing draws beside a call. */
const DATA_KINDS = new Set(['record', 'message', 'external']);

/** A lookup over the graph's nodes, whether the caller holds a Map, a plain object or nothing. */
function getter(graphById) {
  if (!graphById) return () => null;
  if (typeof graphById.get === 'function') return (id) => graphById.get(id) || null;
  return (id) => graphById[id] || null;
}

/**
 * Every journey as a district, in the order the canvas lays them out: grouped
 * by source (`repo`, in the order the design answer names the sources); inside
 * a source, first the journeys that **contain** another (every screen of a
 * smaller one is one of theirs), then by name. `workByFlow` is optional — a Map
 * or object of `/api/work/flow/<id>` answers keyed by flow node id.
 * @group Map
 */
export function neighbourhoodModel(designs, workByFlow) {
  const work = getter(workByFlow);
  const rows = [];
  const seen = new Set();
  for (const d of Array.isArray(designs) ? designs : []) {
    for (const f of (d && d.flows) || []) {
      if (!f || !f.nodeId || seen.has(f.nodeId)) continue;
      seen.add(f.nodeId);
      rows.push({
        id: f.nodeId,
        flowId: f.id,
        name: f.name || f.id || f.nodeId,
        description: f.description || '',
        screens: (f.screens || []).slice(),
        built: typeof f.built === 'number' ? f.built : null,
        total: typeof f.total === 'number' ? f.total : (f.screens || []).length,
        status: f.status || null,
        persona: f.persona || null,
        owner: f.owner || null,
        repo: d.repo || null,
        work: work(f.nodeId),
      });
    }
  }
  // a container holds every screen of some other journey, and more
  const contains = (a, b) => b.screens.length > 0 && b.screens.length < a.screens.length && b.screens.every((x) => a.screens.includes(x));
  const isContainer = new Map(rows.map((r) => [r.id, rows.some((o) => o !== r && contains(r, o))]));
  // bands by source, in the order the design answer names them; inside a band the containers, then by name
  const bandOrder = [...new Set(rows.map((r) => r.repo || ''))];
  rows.sort((a, b) => (bandOrder.indexOf(a.repo || '') - bandOrder.indexOf(b.repo || ''))
    || (Number(isContainer.get(b.id)) - Number(isContainer.get(a.id)))
    || a.name.localeCompare(b.name));
  return { districts: rows.map((r, index) => ({ ...r, index, container: !!isContainer.get(r.id) })) };
}

/**
 * Where every district sits on the board — the neighbourhood's layout rule,
 * pure so a test can hold it to 40 journeys.
 *
 * `items` are the districts in model order, each `{ id, repo, w, h }` in world
 * units: `w` is the street's own width (so zooming in reveals the street in
 * place), `h` its height. The rule:
 * - one **band** per source, stacked top to bottom, each headed by a label
 *   strip of `labelH`;
 * - inside a band, districts packed left to right in **rows** that wrap at one
 *   maximum row width shared by every band; every district of a band takes the
 *   band's tallest height, so rows line up;
 * - the row width is chosen among the widths the rows could break at, to bring
 *   the whole board's aspect nearest `aspect` (the viewport's width ÷ height) —
 *   a fit then uses the screen instead of a strip of it.
 * Returns `{ rects: Map(id → {x, y, w, h}), bands: [{ repo, x, y, w, h }], size: {w, h}, rowW }`.
 * @group Map
 */
export function layoutDistricts(items, opts = {}) {
  const o = { aspect: 1.6, colGap: 200, rowGap: 160, bandGap: 280, labelH: 120, margin: 80, ...opts };
  const list = Array.isArray(items) ? items : [];
  const bands = [];
  for (const it of list) {
    const key = it.repo || '';
    let b = bands.find((x) => x.repo === key);
    if (!b) { b = { repo: key, items: [] }; bands.push(b); }
    b.items.push(it);
  }
  const widest = Math.max(0, ...list.map((i) => i.w));
  // every width a row could end at: the running sums of each band's districts
  const cands = new Set([widest]);
  for (const b of bands) {
    for (let i = 0; i < b.items.length; i++) {
      let w = 0;
      for (let j = i; j < b.items.length; j++) { w += b.items[j].w + (j > i ? o.colGap : 0); if (w >= widest) cands.add(w); }
    }
  }
  const place = (rowW) => {
    const rects = new Map();
    const out = [];
    let y = o.margin, maxW = 0;
    for (const b of bands) {
      const rowH = Math.max(0, ...b.items.map((i) => i.h));
      const top = y;
      let x = o.margin, rowY = y + o.labelH, bandW = 0;
      for (const it of b.items) {
        if (x > o.margin && x - o.margin + it.w > rowW) { x = o.margin; rowY += rowH + o.rowGap; }
        rects.set(it.id, { x, y: rowY, w: it.w, h: rowH });
        x += it.w + o.colGap;
        bandW = Math.max(bandW, x - o.colGap - o.margin);
      }
      const h = rowY + rowH - top;
      out.push({ repo: b.repo, x: o.margin, y: top, w: bandW, h });
      maxW = Math.max(maxW, bandW);
      y = top + h + o.bandGap;
    }
    const size = { w: maxW + o.margin * 2, h: (bands.length ? y - o.bandGap : o.margin) + o.margin };
    return { rects, bands: out, size, rowW };
  };
  let best = null, bestScore = Infinity;
  for (const w of [...cands].sort((a, b) => a - b)) {
    const r = place(w);
    const score = Math.abs(Math.log((r.size.w / r.size.h) / o.aspect));
    if (score < bestScore - 1e-9) { best = r; bestScore = score; }
  }
  return best || place(widest);
}

/**
 * The read/write word for one data marker. A message published is written, one listened to is read.
 * When the walk recorded no direction (a third party reached through a call whose method is not a literal),
 * the word is `reached` — never *write* by default (docs/proposals/data-stores.md §3.3).
 */
function dataMode(m) {
  const op = m.op || m.via || '';
  if (/read|subscribe|listen|consume|receive/.test(op)) return 'read';
  if (/write|publish|send|emit|enqueue/.test(op)) return 'write';
  return 'reached';
}

/**
 * Two ways one call uses the same node, as one word: a known direction wins over `reached`,
 * and `both` comes only from a read and a write.
 * @group Map
 */
export function mergeMode(a, b) {
  if (!a || a === b) return b || a;
  if (a === 'reached') return b;
  if (b === 'reached') return a;
  return 'both';
}

/**
 * The store a data marker lives in: the node's own `store` (name, kind, engine, how it is known) when the graph
 * carries it, else the marker's `{ name, kind }`, else null. Nothing is guessed from a name.
 */
function storeOf(m, node) {
  const s = (node && node.store) || m.store || null;
  if (!s || !s.name) return null;
  const out = { name: String(s.name), kind: s.kind || 'other' };
  if (s.engine) out.engine = s.engine;
  if (s.via) out.via = s.via;
  if (s.ref) out.ref = s.ref;
  return out;
}

/** The order the street draws a call's data in, and the property lists its modes: writes, both, reads, reached. */
export const MODE_ORDER = ['write', 'both', 'read', 'reached'];

/** Method and path of a call: the marker's own fields, else read off its name (`GET /invoices`). */
function methodPath(m) {
  if (m.method || m.path) return { method: m.method || '', path: m.path || '' };
  const r = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/.exec(String(m.name || ''));
  return r ? { method: r[1], path: r[2] } : { method: '', path: '' };
}

/**
 * The evidence class of one call: *not built* for a planned step or a route the
 * spec declares and no code implements, *spec-backed* where the contract and the
 * code agree, *implied* where only the code says so.
 */
function callEvidence(m, route) {
  if (m.planned || m.via === 'planned') return 'not built';
  const st = route && route.contract && route.contract.status;
  if (st === 'spec-only') return 'not built';
  if (st === 'both') return 'spec-backed';
  return 'implied';
}

/** The services row for a system key, or null (drawn as `svc-none`). */
function serviceFor(services, key) {
  return services.find((s) => s.key === key) || null;
}

/**
 * One street: a journey's screens in step order, and per screen the calls it
 * makes with the records, messages and third parties each call reaches.
 *
 * Rules (map-view.md §3.1, with two corrections measured on the fixture):
 * - a moment with no call draws nothing in the plumbing;
 * - the same call made twice on one screen is drawn once (its data merged);
 *   a call the journey already made on an earlier screen keeps `repeat: true`;
 * - helpers never appear;
 * - a planned screen's calls are its **planned call markers** (`via: 'planned'`),
 *   with evidence *not built* and no data — `segment.declaredOnly` is something
 *   else: operations a *built* screen's design names that no code on it calls.
 *   Those are kept as `declared` rows (evidence `declared`, no data), drawn dashed.
 * @group Map
 */
export function streetModel(data, graphById) {
  const get = getter(graphById);
  const summary = (data && data.summary) || {};
  const entry = summary.entry || (data && data.entry) || {};
  const services = (summary.systems || []).filter((r) => r && r.kind === 'api')
    .map((r, index) => ({ key: r.key, label: r.label || r.key, index, planned: !!r.planned }));
  const fullScreens = new Map(((data && data.screens) || []).filter(Boolean).map((n) => [n.id, n]));
  const coverage = (summary.coverage && summary.coverage.segments) || [];
  const segments = summary.segments || [];

  // the entry segment that has no screen is folded into the first screen
  const lead = [];
  const screens = [];
  for (const seg of segments) {
    if (!seg.screen) { lead.push(seg); continue; }
    screens.push(screenRow(seg, screens.length, lead.splice(0)));
  }

  function screenRow(seg, index, folded) {
    const sc = seg.screen;
    const node = fullScreens.get(sc.id) || get(sc.id) || {
      id: sc.id, name: sc.name, kind: sc.kind,
      design: sc.designStatus ? { status: sc.designStatus, id: sc.designId } : undefined,
    };
    const routeName = node && node.kind === 'page' && /^\//.test(String(node.name || '')) ? node.name : '';
    const planned = sc.designStatus === 'design-only' || (!sc.loc && !(node && node.loc));
    const cov = coverage[seg.index] || null;
    const calls = [];
    for (const s of folded.concat([seg])) collectCalls(s, calls);
    for (const d of seg.declaredOnly || []) {
      if (calls.some((c) => c.nodeId === d.routeId)) continue;
      const route = d.routeId ? get(d.routeId) : null;
      const mp = methodPath(route || { name: '' });
      calls.push({
        nodeId: d.routeId || null,
        marker: null,
        moment: null,
        service: route && route.contract ? serviceFor(services, 'api:' + route.contract.apiId) : null,
        method: mp.method, path: mp.path,
        operationId: d.op || (route && route.contract && route.contract.spec && route.contract.spec.operationId) || '',
        summary: (route && route.contract && route.contract.summary) || d.label || '',
        label: d.label || (route && route.contract && route.contract.summary) || d.op || '',
        business: d.label || '',
        evidence: 'declared',
        repeat: false,
        data: [],
      });
    }
    return {
      index,
      ordinal: index + 1,
      node,
      id: sc.id,
      name: sc.name || (node && node.name) || sc.id,
      business: (node && (node.bizDescription || node.docs)) || sc.business || '',
      designId: sc.designId || null,
      route: routeName,
      state: planned ? 'planned' : 'built',
      chips: {
        calls: (seg.counted && seg.counted.actions) || null,
        gates: (seg.counted && seg.counted.gates) || null,
        tests: (cov && cov.counted && cov.counted.tests) || null,
        work: null,
      },
      calls,
      gates: seg.gates || [],
      decisions: seg.decisions || [],
      absent: seg.absent || null,
      segment: seg,
    };
  }

  function collectCalls(seg, calls) {
    const markers = (seg.markers || []).slice().sort((a, b) => a.stepOrder - b.stepOrder);
    const byOrder = new Map(markers.map((m) => [m.stepOrder, m]));
    const moments = seg.moments || [];
    const callOf = new Map();          // stepOrder of a call marker → its MapCall
    for (const m of markers) {
      if (m.kind !== 'call') continue;
      const route = get(m.nodeId);
      const moment = moments[m.moment] || null;
      const prior = calls.find((c) => c.nodeId === m.nodeId);
      if (prior) { callOf.set(m.stepOrder, prior); continue; }
      const mp = methodPath(m);
      const contract = (route && route.contract) || {};
      const label = m.title || contract.summary || (moment && moment.label) || m.name || '';
      const call = {
        nodeId: m.nodeId,
        marker: m,
        moment,
        service: serviceFor(services, m.system),
        method: mp.method, path: mp.path,
        operationId: (contract.spec && contract.spec.operationId) || '',
        summary: contract.summary || m.title || '',
        label,
        business: m.business || (moment && moment.business) || label,
        evidence: callEvidence(m, route),
        repeat: !!m.repeat,
        data: [],
      };
      calls.push(call);
      callOf.set(m.stepOrder, call);
    }
    // each data marker belongs to the nearest call above it (`under`), else its moment's call
    for (const m of markers) {
      if (!DATA_KINDS.has(m.kind)) continue;
      let call = null;
      let up = m.under;
      for (let guard = 0; up != null && guard < 64 && !call; guard++) {
        call = callOf.get(up) || null;
        const parent = byOrder.get(up);
        up = parent ? parent.under : null;
      }
      if (!call) {
        const mo = moments[m.moment];
        call = mo && mo.callStep != null ? callOf.get(mo.callStep) || null : null;
      }
      if (!call || call.evidence === 'not built') continue;
      const mode = dataMode(m);
      const have = call.data.find((d) => d.nodeId === m.nodeId);
      if (have) { have.mode = mergeMode(have.mode, mode); if (!have.store) have.store = storeOf(m, have.node); continue; }
      const node = get(m.nodeId);
      call.data.push({ kind: m.kind, nodeId: m.nodeId, name: m.name || (node && node.name) || m.nodeId, node, mode, store: storeOf(m, node) });
    }
  }

  return {
    journey: { id: entry.id || null, name: entry.name || '', business: entry.business || '' },
    services,
    screens,
    stores: journeyStores(summary, screens),
    links: summary.links || { requires: [], leadsTo: [], partOf: [] },
  };
}

/**
 * The stores the journey touches, in the order the summary lists them (`summary.system.stores`) — else, for an
 * answer from before that field, in the order the street meets them on its data. Each `{ name, kind, ops }`;
 * `ops` holds `'reads'` / `'writes'` as the summary does. The surface draws them; it never counts them — a number
 * of stores is the summary's own `counted.stores` or nothing.
 */
function journeyStores(summary, screens) {
  const listed = summary && summary.system && Array.isArray(summary.system.stores) ? summary.system.stores : null;
  if (listed) return listed.filter((s) => s && s.name).map((s) => ({ name: String(s.name), kind: s.kind || 'other', ops: (s.ops || []).slice() }));
  const out = [];
  for (const sc of screens) {
    for (const c of sc.calls) {
      for (const d of c.data) {
        if (!d.store) continue;
        let row = out.find((r) => r.name === d.store.name && r.kind === d.store.kind);
        if (!row) { row = { name: d.store.name, kind: d.store.kind, ops: [] }; out.push(row); }
        const ops = d.mode === 'both' ? ['reads', 'writes'] : d.mode === 'read' ? ['reads'] : d.mode === 'write' ? ['writes'] : [];
        for (const o of ops) if (!row.ops.includes(o)) row.ops.push(o);
      }
    }
  }
  return out;
}

/**
 * The stores a street touches — `streetModel(...).stores`, for the legend and the property.
 * @group Map
 */
export function storesOf(model) {
  return (model && Array.isArray(model.stores)) ? model.stores : [];
}

/**
 * The screens on a street that use one call or one data node — the explore
 * card's *on* row. `kind` is `'call'` or a data kind; `nodeId` the node.
 * @group Map
 */
export function screensUsing(model, kind, nodeId) {
  return ((model && model.screens) || []).filter((s) => s.calls.some((c) => (kind === 'call'
    ? c.nodeId === nodeId
    : c.data.some((d) => d.nodeId === nodeId))));
}
