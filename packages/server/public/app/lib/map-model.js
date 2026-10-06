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
 *
 * `tree` is optional — the journeys organised persona → group (`/api/journeys`
 * or lib/journeys-model.js `treeFrom()`). With it every district carries where
 * it sits: `personaIds` (in the tree's persona order), `groupId` and `order`
 * under its first persona, and `places` — one `{ persona, group, rank }` per
 * persona, `rank` its position in that persona's list (group, then journey
 * order) — which the *Band by: persona* layout reads. The model also hands on
 * `personaOrder` and the persona and group names (`personas`, id → name).
 * @group Map
 */
export function neighbourhoodModel(designs, workByFlow, tree) {
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
  const at = placesFromTree(tree);
  const districts = rows.map((r, index) => {
    const places = at.places.get(r.id) || [];
    return {
      ...r, index, container: !!isContainer.get(r.id),
      personaIds: places.map((x) => x.persona),
      groupId: places.length ? places[0].group : null,
      order: places.length ? places[0].order : null,
      places,
    };
  });
  return { districts, personaOrder: at.personaOrder, personas: at.personas, groups: at.groups };
}

/**
 * Where each journey sits in the organised tree: flow node id → `[{ persona,
 * group, order, rank }]` in persona order, plus the persona order and names.
 * An empty answer without a tree.
 * @group Map
 */
export function placesFromTree(tree) {
  const places = new Map();
  const personaOrder = [];
  const personas = new Map();
  const groups = new Map();
  for (const p of (tree && tree.personas) || []) {
    personaOrder.push(p.id);
    // a trailing bucket (`key`) is named by the surface, in the register on screen
    personas.set(p.id, p.key ? '' : p.name || '');
    let rank = 0;
    for (const g of p.groups || []) {
      groups.set(p.id + '/' + g.id, g.key ? '' : g.name || '');
      for (const j of g.journeys || []) {
        if (!places.has(j.nodeId)) places.set(j.nodeId, []);
        const list = places.get(j.nodeId);
        if (!list.some((x) => x.persona === p.id)) list.push({ persona: p.id, group: g.id, order: typeof j.order === 'number' ? j.order : null, rank: rank++ });
      }
    }
  }
  return { places, personaOrder, personas, groups };
}

/**
 * Where every district sits on the board — the neighbourhood's layout rule,
 * pure so a test can hold it to 40 journeys.
 *
 * `items` are the districts in model order, each `{ id, repo, w, h }` in world
 * units — at the board altitude a cover's width (`boardWidth()`, the street's own
 * width clamped) and a cover's height; on the street the street's own size. The
 * rule:
 * - one **band** per source, stacked top to bottom, each headed by a label
 *   strip of `labelH`;
 * - inside a band, districts packed left to right in **rows** that wrap at one
 *   maximum row width shared by every band; every district of a band takes the
 *   band's tallest height, so rows line up;
 * - the row width is chosen among the widths the rows could break at, to bring
 *   the whole board's aspect nearest `aspect` (the viewport's width ÷ height) —
 *   a fit then uses the screen instead of a strip of it.
 * - each band is a **panel**: `{ x, y, w, h }` runs from its header strip (`labelH`, where the surface draws the
 *   band's name and count) to `pad` below its last row, `pad` either side of the districts, and every band's
 *   panel is as wide as the board's widest row, so the bands line up; `n` is how many slots it holds.
 * The band a district falls in is `opts.bandKey(item)` — by default its source
 * (`item.repo`); the Map's *Band by: domain* passes the journey's domain. Bands
 * keep the order their first district has in `items`.
 * Returns `{ rects: Map(id → {x, y, w, h}), bands: [{ repo, x, y, w, h }], size: {w, h}, rowW, echoes }` —
 * a band's `repo` is its key, whatever the key is.
 *
 * `bandKey: 'persona'` bands by the person a journey is for: each item's
 * `places` (`[{ persona, rank }]`, from `neighbourhoodModel()` with a tree)
 * puts it in one band per persona, the bands in `opts.personaOrder`, and inside
 * a band the items by `rank` (group, then journey order). A journey for two
 * people is laid out in each band: its first place keeps its id, every other
 * is an **echo** keyed `<id>\u0001<persona>`, and `echoes` maps each echo key
 * to the journey's id — the surface draws the street once and a card that leads
 * to it in the other bands, and counts the journey once. An item with no place
 * falls in a trailing band keyed ''. With `groupRows: true` a persona band reads
 * as its groups: each group's run of journeys starts on a row of its own after a
 * gutter of `subW` at the left, and `subs` lists each run — `{ band, key, x, y,
 * w, h, n }`, `key` the group id — where the surface writes the group's word.
 * A band with one group keeps no gutter. Any `subKey(item)` does the same for
 * any band.
 * @group Map
 */
export function layoutDistricts(items, opts = {}) {
  const o = { aspect: 1.6, colGap: 200, rowGap: 160, bandGap: 140, labelH: 240, pad: 60, margin: 80, ...opts };
  const echoes = new Map();
  if (o.bandKey === 'persona') {
    const order = Array.isArray(o.personaOrder) ? o.personaOrder : [];
    const slots = [];
    (Array.isArray(items) ? items : []).forEach((it, i) => {
      const places = Array.isArray(it.places) && it.places.length ? it.places : [{ persona: '\u0002', rank: i }];
      places.forEach((pl, k) => {
        const id = k === 0 ? it.id : it.id + '\u0001' + pl.persona;
        if (k > 0) echoes.set(id, it.id);
        // an echo is a card that leads to the street, not the street: `opts.echoW` narrows it
        const w = k > 0 && o.echoW > 0 ? Math.min(it.w, o.echoW) : it.w;
        slots.push({ ...it, id, w, band: pl.persona, sub: pl.group == null ? '' : String(pl.group), rank: typeof pl.rank === 'number' ? pl.rank : i, at: i });
      });
    });
    const bi = (k) => { const x = order.indexOf(k); return x < 0 ? order.length + (k === '\u0002' ? 1 : 0) : x; };
    slots.sort((a, b) => bi(a.band) - bi(b.band) || a.rank - b.rank || a.at - b.at);
    const L = layoutDistricts(slots, { ...o, bandKey: (it) => it.band, subKey: o.groupRows ? (it) => it.sub : null });
    L.echoes = echoes;
    return L;
  }
  const bandKey = typeof o.bandKey === 'function' ? o.bandKey : (it) => it.repo || '';
  const subKey = typeof o.subKey === 'function' ? o.subKey : null;
  const list = Array.isArray(items) ? items : [];
  const bands = [];
  const byKey = new Map();
  for (const it of list) {
    const key = bandKey(it) || '';
    let b = byKey.get(key);
    if (!b) { b = { repo: key, items: [], subs: new Set() }; bands.push(b); byKey.set(key, b); }
    b.items.push(it);
    if (subKey) b.subs.add(subKey(it) || '');
  }
  // a band whose items fall in two runs or more (its groups) starts each run on a row of its own, after a gutter
  // of `subW` at the left where the surface writes the run's word
  const runs = (b) => !!subKey && b.subs.size > 1;
  const widest = Math.max(0, ...list.map((i) => i.w));
  // every width a row could end at: the running sums of each band's districts
  const cands = new Set([widest]);
  for (const b of bands) {
    for (let i = 0; i < b.items.length; i++) {
      let w = 0;
      for (let j = i; j < b.items.length; j++) { w += b.items[j].w + (j > i ? o.colGap : 0); if (w >= widest) cands.add(w); }
    }
  }
  const subW = Number(o.subW) > 0 ? Number(o.subW) : 0;
  const place = (rowW) => {
    const rects = new Map();
    const out = [];
    const subs = [];
    let y = o.margin, maxW = 0;
    for (const b of bands) {
      const rowH = Math.max(0, ...b.items.map((i) => i.h));
      const top = y;
      const grouped = runs(b);
      const x0 = o.margin + (grouped ? subW : 0);
      let x = x0, rowY = y + o.labelH, bandW = 0, cur = null, run = null;
      for (const it of b.items) {
        const k = grouped ? subKey(it) || '' : null;
        // a new run (group) starts a new row; a row past the width wraps
        if (x > x0 && ((grouped && k !== cur) || x - x0 + it.w > rowW)) { x = x0; rowY += rowH + o.rowGap; }
        if (grouped && k !== cur) {
          cur = k;
          run = { band: b.repo, key: k, x: o.margin, y: rowY, w: subW, h: rowH, n: 0 };
          subs.push(run);
        }
        if (run) { run.n++; run.h = rowY + rowH - run.y; }
        rects.set(it.id, { x, y: rowY, w: it.w, h: rowH });
        x += it.w + o.colGap;
        bandW = Math.max(bandW, x - o.colGap - o.margin);
      }
      const h = rowY + rowH - top + o.pad;
      out.push({ repo: b.repo, x: o.margin - o.pad, y: top, w: bandW, h, n: b.items.length });
      maxW = Math.max(maxW, bandW);
      y = top + h + o.bandGap;
    }
    // every band's panel spans the board's widest row, so the bands line up as one column of panels
    for (const b of out) b.w = maxW + o.pad * 2;
    const size = { w: maxW + o.margin * 2, h: (bands.length ? y - o.bandGap : o.margin) + o.margin };
    return { rects, bands: out, size, rowW, subs };
  };
  let best = null, bestScore = Infinity;
  for (const w of [...cands].sort((a, b) => a - b)) {
    const r = place(w);
    const score = Math.abs(Math.log((r.size.w / r.size.h) / o.aspect));
    if (score < bestScore - 1e-9) { best = r; bestScore = score; }
  }
  if (best) best.echoes = echoes;
  return best || place(widest);
}

/**
 * The board for one storyline (round-2026-10-05 §2.2): of `nb` (`neighbourhoodModel()`'s answer) only the
 * districts the storyline names, **in its order**, each with `step` (1-based) and `steps` (how many the board
 * shows); every other journey is left out. `story` is a `JourneyTree` storyline (`{ id, name, journeys }`, each
 * journey a row with `nodeId`). A step whose journey has no district here (another scope) is skipped, so the
 * steps the board numbers are the ones it draws. Returns `nb`'s shape plus `storyline: { id, name }` and
 * `then`: the links from each step to the next (`{ from, to, kind: 'then' }`). O(districts + steps).
 * @group Map
 */
export function storylineModel(nb, story) {
  const base = nb && Array.isArray(nb.districts) ? nb : { districts: [] };
  if (!story || !Array.isArray(story.journeys)) return { ...base, storyline: null, then: [] };
  const byId = new Map(base.districts.map((d) => [d.id, d]));
  const ids = [];
  for (const j of story.journeys) {
    const id = j && j.nodeId;
    if (id && byId.has(id) && !ids.includes(id)) ids.push(id);
  }
  const districts = ids.map((id, i) => ({ ...byId.get(id), index: i, step: i + 1, steps: ids.length }));
  // a chain reads on: each line leaves a journey east or south and arrives at the next one west or north
  const then = ids.slice(1).map((id, i) => ({ from: ids[i], to: id, kind: 'then', fromSides: ['e', 's'], toSides: ['w', 'n'] }));
  // the branches (swarm-fixes 2026-10-05 §6): each leaves a step it is drawn below, with its condition on the line,
  // and a dashed line back to the step it rejoins; a branch whose journey or step is not drawn here is left out
  const branches = [];
  for (const b of Array.isArray(story.branches) ? story.branches : []) {
    const id = b && b.nodeId;
    if (!id || !byId.has(id) || ids.includes(id) || branches.some((x) => x.id === id) || !ids.includes(b.branchOf)) continue;
    const rejoins = b.rejoins && ids.includes(b.rejoins) ? b.rejoins : null;
    branches.push({ id, of: b.branchOf, ofName: b.branchOfName || '', when: String(b.when || ''), rejoins, rejoinsName: rejoins ? b.rejoinsName || '' : '' });
  }
  const steps = ids.length;
  for (const b of branches) {
    districts.push({ ...byId.get(b.id), index: districts.length, steps, branch: { of: b.of, ofName: b.ofName, when: b.when, rejoins: b.rejoins, rejoinsName: b.rejoinsName, step: ids.indexOf(b.of) + 1 } });
  }
  // down from the step to the branch below it; back from the branch to the step it rejoins
  const branchLinks = branches.map((b) => ({ from: b.of, to: b.id, kind: 'branch', when: b.when, fromSides: ['s'], toSides: ['n'] }));
  const rejoinLinks = branches.filter((b) => b.rejoins).map((b) => ({ from: b.id, to: b.rejoins, kind: 'rejoin', fromSides: ['w', 'e'], toSides: ['w', 'e'] }));
  return { ...base, districts, storyline: { id: story.id, name: story.name || story.id }, then: then.concat(branchLinks, rejoinLinks), branches };
}

/**
 * A storyline band's branches placed below the steps they leave from (swarm-fixes 2026-10-05 §6) — pure, on the
 * answer of `layoutDistricts()` for the steps alone. Under each row of steps that has a branch, a row of its own:
 * each branch at its step's x (pushed right past the branch before it), `gap` below the step row; every row under it
 * moves down by that row's height and gap, and the band and the board grow to hold it. `branches` are
 * `[{ id, of, w, h }]` (`of` the step's id). Returns a new layout (`rects`, `bands`, `size` copied); one whose
 * branches have no step in it is returned unchanged. O(districts + branches).
 * @group Map
 */
export function placeBranches(L, branches, opts = {}) {
  const list = (Array.isArray(branches) ? branches : []).filter((b) => b && L && L.rects && L.rects.has(b.of));
  if (!list.length) return L;
  const o = { gap: 160, colGap: 200, margin: 80, pad: 60, ...opts };
  const rects = new Map([...L.rects].map(([k, r]) => [k, { ...r }]));
  // the rows of steps, top to bottom, each with the branches that leave from it
  const rowTops = [...new Set([...rects.values()].map((r) => r.y))].sort((a, b) => a - b);
  let shift = 0;
  const placed = new Map();
  for (const top of rowTops) {
    const row = [...rects.entries()].filter(([, r]) => r.y === top);
    for (const [, r] of row) r.y = top + shift;
    const under = list.filter((b) => row.some(([k]) => k === b.of)).sort((a, b) => rects.get(a.of).x - rects.get(b.of).x);
    if (!under.length) continue;
    const rowH = Math.max(...row.map(([, r]) => r.h));
    const y = top + shift + rowH + o.gap;
    let right = -Infinity;
    let h = 0;
    for (const b of under) {
      const x = Math.max(rects.get(b.of).x, right + o.colGap);
      placed.set(b.id, { x, y, w: b.w, h: b.h });
      right = x + b.w;
      h = Math.max(h, b.h);
    }
    shift += h + o.gap;
  }
  for (const [k, r] of placed) rects.set(k, r);
  const right = Math.max(...[...rects.values()].map((r) => r.x + r.w));
  const bottom = Math.max(...[...rects.values()].map((r) => r.y + r.h));
  const bands = (L.bands || []).map((b) => ({ ...b, w: Math.max(b.w, right - b.x + o.pad), h: Math.max(b.h, bottom - b.y + o.pad), n: (b.n || 0) + placed.size }));
  const size = { w: Math.max(L.size.w, right + o.margin), h: Math.max(L.size.h, bottom + o.pad + o.margin) };
  return { ...L, rects, bands, size };
}

/**
 * The test evidence of a storyline's journeys, as one `Counted` (swarm-fixes 2026-10-05 §6): `n` the journeys a run
 * observed (their evidence class `observed` or `stale`), `of` every journey of the storyline, and a breakdown that
 * partitions them — with a run's evidence · declared or reached only · with no test · not read yet. `words` maps a
 * journey id to its evidence word (`{ cls }`, core `evidenceWord()`, read from each journey's summary) or nothing
 * while it has not been read. O(journeys).
 * @group Map
 */
/** Where the storyline's evidence count comes from (a tip's *from* line). */
const EVIDENCE_SRC = ['storylineEvidence', '/api/journey', 'summary.coverage.journey.evidenceWord'].join(' → ');
export function storylineEvidence(ids, words) {
  const all = Array.isArray(ids) ? ids : [];
  const part = { run: 0, partly: 0, none: 0, unread: 0 };
  for (const id of all) {
    const w = words && typeof words.get === 'function' ? words.get(id) : null;
    const cls = w && w.cls;
    if (!cls) part.unread++;
    else if (cls === 'observed' || cls === 'stale') part.run++;
    else if (cls === 'declared' || cls === 'reached') part.partly++;
    else part.none++;
  }
  const breakdown = [
    { key: 'count.part.evRun', n: part.run },
    { key: 'count.part.evPartly', n: part.partly },
    { key: 'count.part.evNone', n: part.none },
    ...(part.unread ? [{ key: 'count.part.evUnread', n: part.unread }] : []),
  ];
  return { n: part.run, of: all.length, unit: 'count.unit.storylineObserved', bizUnit: 'count.unit.storylineObserved', scope: 'count.scope.storyline', source: EVIDENCE_SRC, breakdown };
}

/**
 * A journey's width on the board: its street's own width, clamped between `min` and `max` (the surface passes two
 * and four screens' worth). A cover is a card and a street is a street — the two no longer share a width, so a
 * fourteen-screen journey is not six times as wide as a one-screen one at the fit (the 2026-10-04 clarity pass).
 * @group Map
 */
export function boardWidth(streetW, min, max) {
  const w = Number(streetW) || 0;
  return Math.max(min, Math.min(max, w));
}

/**
 * The routes of the lines between journeys — pure, so a test can hold them to a
 * crowded board. Every line runs in the gutters between districts, never across
 * one: an orthogonal route over the grid of lanes that sit `margin` outside each
 * district's edges, found by a shortest-path search that charges `bend` for each
 * turn and a little for a lane another line already uses. A line leaves its
 * district from the middle of one side and arrives at the middle of a side.
 * Lines that share a lane are nudged apart (`spread`), and each label is placed
 * once, on the longest straight run of its own line where its box (`labelW` ×
 * `labelH` in world units, the size it reaches at the coarsest zoom) clears every
 * district and every label placed before it; a line with no such run carries no
 * label rather than one drawn over a cover.
 *
 * `links` are `{ from, to, kind, labelW, labelH, fromSides?, toSides? }` — the sides (`n e s w`) a link
 * may leave and arrive by, when it has a direction to read in (a route that cannot is routed freely); returns them in order with
 * `points` (`[{x, y}]`, from the edge of `from` to the edge of `to`) and `label`
 * (`{ x, y, w, h }`, its centre and size) or null. A link whose end has no rect is
 * left out.
 * @group Map
 */
export function routeLinks(rects, links, opts = {}) {
  const o = { margin: 70, bend: 600, reuse: 40, spread: 14, pad: 8, scales: [4, 3, 2, 1.5, 1], ...opts };
  const R = [...rects.values()];
  const m = o.margin;
  const sides = (r) => [
    { side: 'n', port: { x: r.x + r.w / 2, y: r.y }, exit: { x: r.x + r.w / 2, y: r.y - m }, dir: 0 },
    { side: 'e', port: { x: r.x + r.w, y: r.y + r.h / 2 }, exit: { x: r.x + r.w + m, y: r.y + r.h / 2 }, dir: 1 },
    { side: 's', port: { x: r.x + r.w / 2, y: r.y + r.h }, exit: { x: r.x + r.w / 2, y: r.y + r.h + m }, dir: 2 },
    { side: 'w', port: { x: r.x, y: r.y + r.h / 2 }, exit: { x: r.x - m, y: r.y + r.h / 2 }, dir: 3 },
  ];
  // the lanes: every district edge pushed out by the margin, and every port's line
  const xs = new Set(), ys = new Set();
  for (const r of R) {
    xs.add(r.x - m); xs.add(r.x + r.w + m); xs.add(r.x + r.w / 2);
    ys.add(r.y - m); ys.add(r.y + r.h + m); ys.add(r.y + r.h / 2);
  }
  const X = [...xs].sort((a, b) => a - b), Y = [...ys].sort((a, b) => a - b);
  const NX = X.length, NY = Y.length;
  // a lane crossing is open unless it lies inside some district's margin: each district closes the crossings
  // inside its own box (a binary search into the sorted lanes), instead of every crossing asking every district
  // (lanes² × districts was most of a board's draw at 300 journeys)
  const ok = new Uint8Array(NX * NY).fill(1);
  const firstAbove = (A, v) => { let lo = 0, hi = A.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (A[mid] > v) hi = mid; else lo = mid + 1; } return lo; };
  for (const r of R) {
    const x0 = r.x - m + 0.5, x1 = r.x + r.w + m - 0.5, y0 = r.y - m + 0.5, y1 = r.y + r.h + m - 0.5;
    const i0 = firstAbove(X, x0), j0 = firstAbove(Y, y0);
    for (let j = j0; j < NY && Y[j] < y1; j++) for (let i = i0; i < NX && X[i] < x1; i++) ok[j * NX + i] = 0;
  }
  const xi = new Map(X.map((v, i) => [v, i])), yi = new Map(Y.map((v, j) => [v, j]));
  const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
  const used = new Map();                      // lane segment → how many lines run on it
  const segKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

  const route = (ra, rb, only, onlyTo) => {
    const dOnly = onlyTo === undefined ? only : onlyTo;
    const src = sides(ra).filter((x) => !only || only.includes(x.side)), dst = sides(rb).filter((x) => !dOnly || dOnly.includes(x.side));
    const dist = new Float64Array(NX * NY * 4).fill(Infinity);
    const prev = new Int32Array(NX * NY * 4).fill(-1);
    const heap = [];
    const push = (c, s) => {
      heap.push([c, s]);
      let i = heap.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let k = i;
          if (l < heap.length && heap[l][0] < heap[k][0]) k = l;
          if (r < heap.length && heap[r][0] < heap[k][0]) k = r;
          if (k === i) break;
          [heap[k], heap[i]] = [heap[i], heap[k]]; i = k;
        }
      }
      return top;
    };
    for (const s of src) {
      const i = xi.get(s.exit.x), j = yi.get(s.exit.y);
      if (i == null || j == null || !ok[j * NX + i]) continue;
      const st = (j * NX + i) * 4 + s.dir;
      if (dist[st] > 0) { dist[st] = 0; prev[st] = -2 - src.indexOf(s); push(0, st); }
    }
    const goal = new Map();
    for (const d of dst) {
      const i = xi.get(d.exit.x), j = yi.get(d.exit.y);
      if (i != null && j != null && ok[j * NX + i]) goal.set(j * NX + i, d);
    }
    let best = Infinity, bestSt = -1, bestDst = null;
    while (heap.length) {
      const [c, st] = pop();
      if (c > dist[st] || c >= best) continue;
      const node = st >> 2, dir = st & 3;
      const g = goal.get(node);
      if (g) {
        const inward = (g.dir + 2) & 3;
        const tot = c + (dir === inward ? 0 : o.bend);
        if (tot < best) { best = tot; bestSt = st; bestDst = g; }
      }
      const i = node % NX, j = (node - i) / NX;
      for (let nd = 0; nd < 4; nd++) {
        if (nd === ((dir + 2) & 3)) continue;
        const ni = i + DX[nd], nj = j + DY[nd];
        if (ni < 0 || nj < 0 || ni >= NX || nj >= NY || !ok[nj * NX + ni]) continue;
        const len = Math.abs(X[ni] - X[i]) + Math.abs(Y[nj] - Y[j]);
        const k = segKey(node, nj * NX + ni);
        const nc = c + len + (nd === dir ? 0 : o.bend) + (used.get(k) || 0) * o.reuse;
        const ns = (nj * NX + ni) * 4 + nd;
        if (nc < dist[ns]) { dist[ns] = nc; prev[ns] = st; push(nc, ns); }
      }
    }
    if (bestSt < 0) return null;
    const cells = [];
    let st = bestSt, first = null;
    while (st >= 0) { cells.push(st >> 2); const p = prev[st]; if (p < -1) first = src[-2 - p]; st = p; }
    cells.reverse();
    for (let c = 1; c < cells.length; c++) { const k = segKey(cells[c - 1], cells[c]); used.set(k, (used.get(k) || 0) + 1); }
    const pts = [first.port, ...cells.map((n) => ({ x: X[n % NX], y: Y[Math.floor(n / NX)] })), bestDst.port];
    // keep the corners only
    const out = [pts[0]];
    for (let c = 1; c < pts.length - 1; c++) {
      const a = out[out.length - 1], b = pts[c], n = pts[c + 1];
      if ((a.x === b.x && b.x === n.x) || (a.y === b.y && b.y === n.y)) continue;
      out.push(b);
    }
    out.push(pts[pts.length - 1]);
    return out.map((p) => ({ x: p.x, y: p.y }));
  };

  const offRects = (bx) => !R.some((r) => bx.x - bx.w / 2 < r.x + r.w + o.pad && r.x - o.pad < bx.x + bx.w / 2 && bx.y - bx.h / 2 < r.y + r.h + o.pad && r.y - o.pad < bx.y + bx.h / 2);
  const hasRoom = (pts, w, h) => {
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      if (a.y !== b.y || Math.abs(a.x - b.x) < w + 2 * o.pad) continue;
      if (offRects({ x: (a.x + b.x) / 2, y: a.y, w, h })) return true;
    }
    return false;
  };
  const routed = [];
  for (const l of links || []) {
    const a = rects.get(l.from), b = rects.get(l.to);
    if (!a || !b || l.from === l.to) continue;
    // a link may name the sides it leaves and arrives by (a storyline's then reads on: out east or south, in west or north)
    let points = (l.fromSides || l.toSides ? route(a, b, l.fromSides || null, l.toSides || null) : null) || route(a, b);
    // a line with no straight run long enough for its label at the coarsest zoom goes round by the gutters
    // above or below instead (two journeys side by side are joined over the top), when that gives it one
    const big = Math.max(...o.scales);
    if (points && l.labelW && !hasRoom(points, l.labelW * big, l.labelH * big)) {
      const alt = route(a, b, ['n', 's']);
      if (alt && hasRoom(alt, l.labelW * big, l.labelH * big)) points = alt;
    }
    if (points) routed.push({ ...l, points, label: null });
  }

  // lines that share a lane are spread apart; a run that touches a district's edge stays put
  for (const axis of ['y', 'x']) {
    const other = axis === 'y' ? 'x' : 'y';
    const lanes = new Map();
    routed.forEach((l, li) => {
      for (let k = 1; k < l.points.length - 2; k++) {
        const a = l.points[k], b = l.points[k + 1];
        if (a[axis] !== b[axis]) continue;
        const key = a[axis];
        if (!lanes.has(key)) lanes.set(key, []);
        lanes.get(key).push({ li, k, lo: Math.min(a[other], b[other]), hi: Math.max(a[other], b[other]) });
      }
    });
    for (const runs of lanes.values()) {
      if (runs.length < 2) continue;
      // runs that overlap along the lane share it; each line takes its own track
      const tracks = [];
      for (const r of runs.sort((p, q) => p.lo - q.lo)) {
        let t = tracks.findIndex((tr) => tr.every((x) => x.hi <= r.lo || x.lo >= r.hi || x.li === r.li));
        if (t < 0) { tracks.push([]); t = tracks.length - 1; }
        tracks[t].push(r);
        r.track = t;
      }
      if (tracks.length < 2) continue;
      for (const r of runs) {
        const off = (r.track - (tracks.length - 1) / 2) * o.spread;
        const pts = routed[r.li].points;
        pts[r.k] = { ...pts[r.k], [axis]: pts[r.k][axis] + off };
        pts[r.k + 1] = { ...pts[r.k + 1], [axis]: pts[r.k + 1][axis] + off };
      }
    }
  }

  // one label per line, on its longest clear straight run
  const boxes = [];
  const clear = (bx) => offRects(bx)
    && !boxes.some((b) => bx.x - bx.w / 2 < b.x + b.w / 2 && b.x - b.w / 2 < bx.x + bx.w / 2 && bx.y - bx.h / 2 < b.y + b.h / 2 && b.y - b.h / 2 < bx.y + bx.h / 2);
  for (const l of routed) {
    if (!l.labelW || !l.labelH) continue;
    // the label grows with the counter-scale up to the largest of `scales`; it is placed at the largest it fits at,
    // and drawn only while the board is zoomed in at least that far (`label.scale`)
    for (const sc of [...o.scales].sort((p, q) => q - p)) {
      const placed = placeLabel(l, l.labelW * sc, l.labelH * sc);
      if (placed) { placed.scale = sc; boxes.push(placed); l.label = placed; break; }
    }
  }
  return routed;

  function placeLabel(l, w, h) {
    const runs = [];
    for (let k = 0; k < l.points.length - 1; k++) {
      const a = l.points[k], b = l.points[k + 1];
      const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      runs.push({ a, b, len, flat: a.y === b.y });
    }
    runs.sort((p, q) => Number(q.flat) - Number(p.flat) || q.len - p.len);
    let placed = null;
    for (const r of runs) {
      const room = r.flat ? w : h;
      if (r.len < room + 2 * o.pad) continue;
      // the middle first, then towards either end
      for (const f of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const bx = { x: r.a.x + (r.b.x - r.a.x) * f, y: r.a.y + (r.b.y - r.a.y) * f, w, h };
        const lo = r.flat ? Math.min(r.a.x, r.b.x) : Math.min(r.a.y, r.b.y), hi = r.flat ? Math.max(r.a.x, r.b.x) : Math.max(r.a.y, r.b.y);
        const c = r.flat ? bx.x : bx.y;
        if (c - room / 2 < lo + o.pad || c + room / 2 > hi - o.pad) continue;
        if (clear(bx)) { placed = bx; break; }
      }
      if (placed) break;
    }
    return placed;
  }
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
        // the screen's coverage fold — its evidence word travels with its tests count
        evidence: cov,
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
 * The stores the journey touches, in the order the summary lists them (`summary.system.stores`), then any store a
 * data node on the street names that the summary does not (an answer from before that field lists none) — in the
 * order the street meets them, so the legend explains every swatch drawn. Each `{ name, kind, ops }`; `ops` holds
 * `'reads'` / `'writes'` as the summary does. The surface draws them; it never counts them — a number of stores is
 * the summary's own `counted.stores` or nothing.
 */
function journeyStores(summary, screens) {
  const listed = summary && summary.system && Array.isArray(summary.system.stores) ? summary.system.stores : [];
  const out = listed.filter((s) => s && s.name).map((s) => ({ name: String(s.name), kind: s.kind || 'other', ops: (s.ops || []).slice() }));
  const fromSummary = new Set(out.map((r) => r.name + '|' + r.kind));
  for (const sc of screens) {
    for (const c of sc.calls) {
      for (const d of c.data) {
        if (!d.store) continue;
        const key = d.store.name + '|' + d.store.kind;
        let row = out.find((r) => r.name + '|' + r.kind === key);
        if (!row) { row = { name: d.store.name, kind: d.store.kind, ops: [] }; out.push(row); }
        if (fromSummary.has(key)) continue;   // the summary's own ops stand
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

/**
 * The name a store is printed under in a register, or `''` for none. A store's name
 * is a product name or a word somebody wrote in the settings, so hybrid and code
 * always print it; the business register leaves out a database engine the parser
 * read off a driver (`Postgres` from `pg`) — a developer's word for where a table
 * lives, which a product owner would have to look up (swarm 2026-10-05) — and says
 * the kind instead (*database record*). A name the settings declare stays.
 * @param {{name?:string, engine?:string, via?:string}|null|undefined} st
 * @param {boolean} business
 * @returns {string}
 */
export function storeShownName(st, business) {
  if (!st || !st.name) return '';
  if (business && st.engine && st.via !== 'config') return '';
  return String(st.name);
}
