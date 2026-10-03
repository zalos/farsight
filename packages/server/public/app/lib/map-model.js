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
 * Every journey as a district, in the order the canvas lays them out:
 * first the journeys that **contain** another (every screen of a smaller one is
 * one of theirs), so a whole cycle sits above its parts; then the rest in the
 * order the design says a person walks them (`leadsTo` on the flow's design
 * reference, read from `graphById` when given), then by size, then by name.
 * `workByFlow` is optional — a Map or object of `/api/work/flow/<id>` answers
 * keyed by flow node id.
 * @group Map
 */
export function neighbourhoodModel(designs, workByFlow, graphById) {
  const work = getter(workByFlow);
  const get = getter(graphById);
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
  // how far down the design's leads-to chain a journey sits (0 = nobody leads to it)
  const byDesignId = new Map(rows.map((r) => [r.flowId, r]));
  const next = new Map(rows.map((r) => {
    const n = get(r.id);
    const ids = (n && n.design && n.design.leadsTo) || [];
    return [r.id, ids.map((x) => byDesignId.get(x)).filter(Boolean).map((x) => x.id)];
  }));
  const depth = new Map();
  const visit = (id, dpt, path) => {
    if (path.has(id) || (depth.get(id) || 0) > dpt) return;
    if (dpt > (depth.get(id) || 0) || !depth.has(id)) depth.set(id, dpt);
    path.add(id);
    for (const n of next.get(id) || []) visit(n, dpt + 1, path);
    path.delete(id);
  };
  for (const r of rows) if (!depth.has(r.id)) visit(r.id, 0, new Set());
  rows.sort((a, b) => (Number(isContainer.get(b.id)) - Number(isContainer.get(a.id)))
    || (isContainer.get(a.id) ? 0 : (depth.get(a.id) || 0) - (depth.get(b.id) || 0))
    || (b.total - a.total) || a.name.localeCompare(b.name));
  return { districts: rows.map((r, index) => ({ ...r, index, container: !!isContainer.get(r.id) })) };
}

/** The read/write word for one data marker. A message published is written, one listened to is read. */
function dataMode(m) {
  const op = m.op || m.via || '';
  if (/read|subscribe|listen|consume|receive/.test(op)) return 'read';
  if (/write|publish|send|emit|enqueue/.test(op)) return 'write';
  // a third party reached with no direction recorded is a request sent to it
  return 'write';
}

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
      if (have) { if (have.mode !== mode) have.mode = 'both'; continue; }
      const node = get(m.nodeId);
      call.data.push({ kind: m.kind, nodeId: m.nodeId, name: m.name || (node && node.name) || m.nodeId, node, mode });
    }
  }

  return {
    journey: { id: entry.id || null, name: entry.name || '', business: entry.business || '' },
    services,
    screens,
    links: summary.links || { requires: [], leadsTo: [], partOf: [] },
  };
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
