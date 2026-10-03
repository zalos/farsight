// lib/map-property-model.js — the facts of one screen of the map's property view
// (docs/proposals/map-view.md §3.2), pure: the /api/journey answer, the street
// model built from it (lib/map-model.js `streetModel`) and the graph by id in,
// a plain object out. No DOM, no catalog, no lens — the surface
// (surfaces/map-property.js) chooses the words and the register; this module
// only says what is true of the screen and which typed count each tab may print.
//
// Every number it hands out is a core `Counted` the answer already carries
// (`segment.counted`, `coverage.segments[i].counted`) or `null` — a tab whose
// subject nothing types prints no number (docs/COUNTS.md, the Map rows).

const OTHER_WAY_SKIP = new Set(['contains', 'covers', 'tracks']);

/** The segment's own index into `summary.segments`, which `coverage.segments` is aligned with. */
function segIndex(sum, seg) {
  if (seg && typeof seg.index === 'number') return seg.index;
  const i = ((sum && sum.segments) || []).indexOf(seg);
  return i >= 0 ? i : null;
}

/** A node from the graph, else from the answer's screens, else a stub carrying what the segment knows. */
function nodeOf(id, byId, data, fallback) {
  if (!id) return fallback || null;
  return byId[id] || ((data && data.screens) || []).find((s) => s && s.id === id) || fallback || { id, name: id.split('::').pop(), kind: 'component' };
}

/** What kind of picture the hero can draw: a file the server serves, a Figma frame it may render, or none declared. */
export function heroKind(node) {
  const img = node && node.design && node.design.image;
  if (!img) return 'none';
  return img.kind === 'figma' ? 'figma' : 'image';
}

/**
 * The components this screen draws, in the order the walk met them: the ones the
 * screen names, the component each action starts in, and every component a
 * `renders` step reached — each once, the page itself never.
 */
export function screenComponents(seg, byId, data) {
  const ids = [];
  const add = (id) => { if (id && !ids.includes(id)) ids.push(id); };
  ((seg && seg.screen && seg.screen.components) || []).forEach(add);
  ((seg && seg.moments) || []).forEach((mo) => add(mo && mo.component && mo.component.id));
  ((seg && seg.markers) || []).forEach((m) => {
    if (m && m.via === 'renders' && byId[m.nodeId] && byId[m.nodeId].kind === 'component') add(m.nodeId);
  });
  const page = seg && seg.screen && seg.screen.id;
  return ids.filter((id) => id !== page).map((id) => nodeOf(id, byId, data));
}

/**
 * The records, messages and third parties the calls reach, each once, with every way it is used and the store it
 * lives in (`store`, or null). A direction the walk did not record (`reached`) is kept only while nothing known
 * says which way the data flows.
 */
export function reachedData(calls) {
  const by = new Map();
  for (const c of calls || []) {
    for (const d of (c && c.data) || []) {
      if (!d || !d.nodeId) continue;
      const row = by.get(d.nodeId) || { nodeId: d.nodeId, name: d.name, kind: d.kind, modes: [], store: d.store || null };
      if (!row.store && d.store) row.store = d.store;
      const modes = d.mode === 'both' ? ['read', 'write'] : [d.mode];
      modes.forEach((m) => { if (m && !row.modes.includes(m)) row.modes.push(m); });
      by.set(d.nodeId, row);
    }
  }
  for (const row of by.values()) if (row.modes.length > 1) row.modes = row.modes.filter((m) => m !== 'reached');
  return [...by.values()];
}

/**
 * The reached data grouped by the store it lives in: named stores first, in the order the screen meets them, each
 * `{ store: { name, kind, … }, rows }`; then what no store names, one group per plain kind (`{ store: null, kind,
 * rows }`) in the order record · external · message.
 */
export function dataByStore(rows) {
  const named = [];
  const plain = new Map();
  for (const r of rows || []) {
    if (r.store && r.store.name) {
      let g = named.find((x) => x.store.name === r.store.name && x.store.kind === r.store.kind);
      if (!g) { g = { store: r.store, kind: null, rows: [] }; named.push(g); }
      g.rows.push(r);
    } else {
      const k = r.kind || 'record';
      if (!plain.has(k)) plain.set(k, { store: null, kind: k, rows: [] });
      plain.get(k).rows.push(r);
    }
  }
  const order = ['record', 'external', 'message'];
  const rest = [...plain.values()].sort((a, b) => (order.indexOf(a.kind) + 1 || 9) - (order.indexOf(b.kind) + 1 || 9));
  return named.concat(rest);
}

/** Other flows that show this page: `renders` edges from a flow other than the one on screen. */
export function alsoInFlows(pageId, flowId, byId, edges) {
  const out = [];
  for (const e of edges || []) {
    if (!e || e.kind !== 'renders' || e.to !== pageId || e.from === flowId) continue;
    const f = byId[e.from];
    if (!f || f.kind !== 'flow' || out.some((x) => x.id === f.id)) continue;
    out.push({ id: f.id, name: f.bizLabel || f.name || f.id });
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * Other ways a user arrives at this page: edges into it that are not the
 * design containing it, a test covering it, a tracker naming it, or a journey
 * listing it — from the journey's own edges and the graph's.
 */
export function otherWaysIn(pageId, byId, edgeLists) {
  const seen = new Set();
  const out = [];
  for (const list of edgeLists) {
    for (const e of list || []) {
      if (!e || e.to !== pageId || OTHER_WAY_SKIP.has(e.kind)) continue;
      const from = byId[e.from];
      if (from && from.kind === 'flow') continue;
      const key = e.from + '|' + e.kind;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ nodeId: e.from, kind: e.kind, node: from || null });
    }
  }
  return out;
}

/** The test cases a screen's coverage names, each once, in the order the fold listed them. */
export function screenCases(cov) {
  const by = new Map();
  for (const x of (cov && cov.tests) || []) if (x && x.id && !by.has(x.id)) by.set(x.id, x);
  return [...by.values()];
}

/** The number on the APIs tab: the distinct operations the code calls, or — for a screen not built — the stops its design declares. */
function apisCount(screen, seg) {
  const c = (seg && seg.counted) || {};
  if (screen && screen.state === 'planned') return c.actionStops || null;
  return c.actions || null;
}

/**
 * The property of one screen: `screen`, `prev`/`next` (street screens or null),
 * `alsoIn`, the `hero`, the eight tabs' facts and the tab strip's numbers.
 * `opts.edges` is the graph's edge list (other journeys, other ways in).
 * Returns null when the street has no screen at that index.
 */
export function propertyModel(data, screenIndex, graphById, model, opts) {
  const byId = graphById || {};
  const screens = (model && model.screens) || [];
  const screen = screens[screenIndex];
  if (!screen) return null;
  const sum = (data && data.summary) || {};
  const seg = screen.segment || {};
  const si = segIndex(sum, seg);
  const cov = si != null && sum.coverage && sum.coverage.segments ? sum.coverage.segments[si] || null : null;
  const pageId = (screen.node && screen.node.id) || (seg.screen && seg.screen.id) || null;
  const node = screen.node || nodeOf(pageId, byId, data, null);
  const flowId = (model && model.journey && model.journey.id) || (sum.entry && sum.entry.id) || null;
  const graphEdges = (opts && opts.edges) || [];
  const calls = screen.calls || [];
  const gates = (seg.gates || []).slice().sort((a, b) => (a.stepOrder || 0) - (b.stepOrder || 0));
  const components = screenComponents(seg, byId, data);
  const design = (node && node.design) || null;
  const designNode = design && design.designId ? byId[design.designId] || null : null;
  const c = seg.counted || {};
  const testsCount = (cov && cov.counted && cov.counted.tests) || null;
  return {
    screen,
    index: screenIndex,
    total: screens.length,
    segIndex: si,
    node,
    prev: screens[screenIndex - 1] || null,
    next: screens[screenIndex + 1] || null,
    alsoIn: pageId ? alsoInFlows(pageId, flowId, byId, graphEdges) : [],
    hero: { kind: heroKind(node), node, components, planned: screen.state === 'planned' },
    tabs: {
      overview: {
        business: screen.business || (seg.screen && seg.screen.business) || '',
        glance: [apisCount(screen, seg), c.gates, c.decisions, testsCount].filter(Boolean),
        // the screen's coverage fold: its evidence word is printed beside the tests count, never apart (lane N)
        evidence: testsCount && testsCount.n ? cov : null,
        calls,
        gates,
        work: 'lazy',
      },
      gates: {
        guards: gates.filter((g) => g.kind === 'guard'),
        rules: gates.filter((g) => g.kind !== 'guard'),
        rows: gates,
        decisions: seg.decisions || [],
        counted: c.gates || null,
        decisionsCounted: c.decisions || null,
      },
      apis: {
        calls,
        records: reachedData(calls),
        groups: dataByStore(reachedData(calls)),
        planned: screen.state === 'planned',
      },
      ux: { page: node, components, built: screen.state !== 'planned' },
      tests: { facts: cov, cases: screenCases(cov).filter((x) => !x.runLevel), reports: screenCases(cov).filter((x) => x.runLevel) },
      route: {
        route: (node && node.name) || screen.route || '',
        status: screen.state === 'planned' ? 'planned' : 'built',
        design,
        declaredIn: designNode ? { id: designNode.id, name: designNode.name, path: designNode.loc && designNode.loc.path } : null,
        codeAt: (seg.screen && seg.screen.loc) || null,
        journeyLinks: sum.links || { requires: [], leadsTo: [], partOf: [] },
        otherWays: pageId ? otherWaysIn(pageId, byId, [data && data.edges, graphEdges]) : [],
      },
      work: 'lazy',
      changes: 'lazy',
    },
    // the footer's units (lane N): the screens the walk reached — the street's screens — and the ones the
    // journey names that it did not reach, each with the absence word that says why
    place: placeOf(sum, screens.length),
    // the parts the Changes tab keeps a change for: the page, its components, the handlers its calls reach
    changeIds: [pageId].concat(components.map((x) => x.id), handlerIds(seg)).filter(Boolean),
    counts: { gates: c.gates || null, apis: apisCount(screen, seg), ux: null, tests: testsCount, work: null, changes: null },
  };
}

/**
 * Where a screen sits, in typed units: `reached` is the summary's `counted.screensReached` (the street's
 * screens, distinct) when it counts the street's rows, `declared` its `counted.screens`, and `notReached`
 * the named screens no segment opens on, each `{ id, name, word }` — `notBuilt` for a screen the design
 * names and the code does not serve, else `notReached` (two of the six absence words, never a seventh).
 */
export function placeOf(sum, streetLength) {
  const k = (sum && sum.counted) || {};
  const reachedIds = new Set(((sum && sum.segments) || []).map((sg) => sg && sg.screen && sg.screen.id).filter(Boolean));
  const notReached = ((sum && sum.user) || []).filter((u) => u && !reachedIds.has(u.id)).map((u) => ({
    id: u.id, name: u.name, word: u.designStatus === 'design-only' || (!u.designStatus && !u.loc) ? 'notBuilt' : 'notReached',
  }));
  const reached = k.screensReached && k.screensReached.n === streetLength ? k.screensReached : null;
  return { reached, declared: k.screens || null, notReached };
}

/** The handler of each call on the screen (`marker.handler.nodeId`) and the route itself. */
function handlerIds(seg) {
  const out = [];
  for (const m of (seg && seg.markers) || []) {
    if (!m || m.kind !== 'call') continue;
    if (m.nodeId && !out.includes(m.nodeId)) out.push(m.nodeId);
    const h = m.handler && m.handler.nodeId;
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}
