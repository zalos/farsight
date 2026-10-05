// lib/journeys-model.js — the journeys organised persona → group → journeys, as
// pure functions (no DOM, no store).
//
// The server answers `/api/journeys` with a `JourneyTree` folded by core
// `journeyTree()` (packages/core/src/journeys.ts; proposal
// docs/proposals/journey-organisation-and-config-files.md §4.3). An older server
// has no such route: `treeFrom()` folds the same shape from `/api/design`'s
// answer, rule for rule, so the Journeys front door, the Portfolio and the Map
// draw the same tree whichever server answers:
//
// - a flow's `persona` is a string or an array; each value matches a declared
//   persona by id, else by name (case-insensitive, trimmed); a value nothing
//   declares is a persona of its own (`declared: false`, id = the value) after
//   the declared ones, alphabetically; a flow with no persona takes the shared
//   prefix of its screen ids (`derived`), else falls under the trailing persona
//   `_none` (`key: 'portfolio.noPersona'`);
// - a flow's `group` matches a declared group by id, else by name — a group
//   declared for another persona is not this one's; undeclared → a group of its
//   own after the declared ones, alphabetically; none (or another persona's) →
//   the trailing `_other` (`key: 'journeys.noGroup'`);
// - inside a group: journeys with an `order` first, ascending; then the config's
//   placement order; then manifest order;
// - per persona, the way in (of the journeys nothing requires, the one with
//   something built and the most screens) is `pinned`, and never moved.
//
// Every count is a `Counted` (core counts.ts): `{ n, of?, unit, bizUnit, scope, source }`.

/** The trailing persona and group ids — core's `JOURNEY_NO_PERSONA` / `JOURNEY_NO_GROUP`. */
export const JOURNEY_NO_PERSONA = '_none';
export const JOURNEY_NO_GROUP = '_other';
const SRC = 'treeFrom';

function counted(n, unit, scope, source, of) {
  // the units are people's words (journeys, built, personas, groups): the business lens prints them too
  const c = { n, unit, bizUnit: unit, scope, source };
  if (of != null) c.of = of;
  return c;
}

/** A name compared the way the proposal matches: trimmed, case-insensitive. */
function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** A journey is built when the code builds every screen it names. */
export function isBuilt(f) {
  const total = f && f.total != null ? f.total : ((f && f.screens) || []).length;
  return total > 0 && ((f && f.built) || 0) >= total;
}

/** The catalog key of a journey's one status word (core `flowStatusWord`). */
function statusKeyOf(built, total) {
  return total > 0 && built >= total ? 'journey.status.built' : built > 0 ? 'journey.status.partly' : 'journey.status.designedNotBuilt';
}

function groupCounts(rows, scope, where) {
  const built = rows.filter(isBuilt).length;
  return {
    journeys: counted(rows.length, 'count.unit.journeys', scope, SRC + ' → ' + where + '.journeys'),
    built: counted(built, 'count.unit.journeysBuilt', scope, SRC + ' → ' + where + '.journeys where every screen is built', rows.length),
  };
}

/**
 * Fold a `JourneyTree` from `/api/design`'s design sources.
 *
 * `metas` is the graph's `meta.journeys` (repo → `JourneysMeta`) when the graph
 * carries one: its declared personas and groups, and the config's placements by
 * flow id. `opts`:
 * - `nodeOf(nodeId)` → the flow's graph node, whose `design` carries what an
 *   older `/api/design` row leaves out (`requires`, `leadsTo`, `group`, `order`,
 *   a persona list);
 * - `ordinal(nodeId)` → the flow's position in its manifest (an older
 *   `/api/design` sorts flows by name; the graph keeps the manifest's order).
 * @group Journey view
 */
export function treeFrom(designs, metas, opts = {}) {
  const nodeOf = typeof opts.nodeOf === 'function' ? opts.nodeOf : () => null;
  const ordinal = typeof opts.ordinal === 'function' ? opts.ordinal : () => null;
  const M = metas && typeof metas === 'object' ? metas : {};
  const sources = Array.isArray(designs) ? designs : [];
  const repos = [...new Set(sources.map((d) => d && d.repo).filter(Boolean))].sort();
  const inScope = repos.map((r) => [r, M[r]]).filter(([, m]) => !!m);

  // the declarations across the sources in scope (a design source may carry its own too)
  const pDecl = [], gDecl = [];
  const pById = new Map(), gById = new Map();
  const addP = (p) => { if (p && str(p.id) && !pById.has(norm(p.id))) { pById.set(norm(p.id), p); pDecl.push(p); } };
  const addG = (g) => { if (g && str(g.id) && !gById.has(norm(g.id))) { gById.set(norm(g.id), g); gDecl.push(g); } };
  for (const [, m] of inScope) { (m.personas || []).forEach(addP); (m.groups || []).forEach(addG); }
  for (const d of sources) { ((d && d.personas) || []).forEach(addP); ((d && d.groups) || []).forEach(addG); }
  const pByName = new Map(), gByName = new Map();
  for (const p of pDecl) if (!pByName.has(norm(p.name || p.id))) pByName.set(norm(p.name || p.id), p);
  for (const g of gDecl) if (!gByName.has(norm(g.name || g.id))) gByName.set(norm(g.name || g.id), g);
  const pIndex = new Map(pDecl.map((p, i) => [p.id, i]));
  const gIndex = new Map(gDecl.map((g, i) => [g.id, i]));

  // the flows, in manifest order
  const placed = [];
  const seen = new Set();
  let seq = 0;
  for (const d of sources) {
    const flows = ((d && d.flows) || []).map((f, i) => {
      const row = withNode(f, nodeOf);
      const ord = row.position != null ? row.position : ordinal(row.nodeId);
      return { row, i, ord: typeof ord === 'number' ? ord : Infinity };
    }).sort((a, b) => a.ord - b.ord || a.i - b.i).map((x) => x.row);
    for (const row0 of flows) {
      if (!row0 || !row0.nodeId || seen.has(row0.nodeId)) continue;
      seen.add(row0.nodeId);
      const row = { ...row0, repo: row0.repo || d.repo || '' };
      const ov = (M[row.repo] && M[row.repo].flows && M[row.repo].flows[row.id]) || null;
      const pick = (k) => (ov && ov[k] !== undefined ? ov[k] : row[k]);
      placed.push({
        row, designId: d.id || '', seq: seq++,
        persona: pick('persona'), group: pick('group'), order: pick('order'),
        cfgIndex: ov && typeof ov.index === 'number' ? ov.index : undefined,
        placedBy: ov ? ov.from : undefined,
      });
    }
  }

  const pBuckets = new Map();
  let derivedAny = false;
  const resolvePersona = (value) => {
    const d = pById.get(norm(value)) || pByName.get(norm(value));
    if (d) return { k: 'd:' + norm(d.id), id: d.id, name: d.name || d.id, description: d.description, declared: true };
    return { k: 'u:' + norm(value), id: value.trim(), name: value.trim(), declared: false };
  };
  for (const p of placed) {
    const values = typeof p.persona === 'string' ? [p.persona] : Array.isArray(p.persona) ? p.persona : [];
    const targets = [];
    for (const v of values) if (str(v)) targets.push(resolvePersona(v));
    if (!targets.length) {
      const prefixes = [...new Set((p.row.screens || []).map((x) => String(x).split('-')[0]).filter(Boolean))];
      if (prefixes.length === 1) targets.push({ k: 'u:' + norm(prefixes[0]), id: prefixes[0], name: prefixes[0], declared: false, derived: true });
      else targets.push({ k: 'none', id: JOURNEY_NO_PERSONA, name: '', declared: false, none: true });
    }
    const unique = [...new Map(targets.map((x) => [x.k, x])).values()];
    for (const tg of unique) {
      let pb = pBuckets.get(tg.k);
      if (!pb) { pb = { id: tg.id, name: tg.name, description: tg.description, declared: tg.declared, derived: false, none: !!tg.none, groups: new Map() }; pBuckets.set(tg.k, pb); }
      if (tg.derived) { pb.derived = true; derivedAny = true; }
      let gk = 'none';
      let gb = { id: JOURNEY_NO_GROUP, name: '', declared: false, none: true };
      const gv = str(p.group);
      if (gv) {
        const d = gById.get(norm(gv)) || gByName.get(norm(gv));
        if (d) {
          const owner = d.persona ? resolvePersona(d.persona).k : null;
          if (!owner || owner === tg.k) { gk = 'd:' + norm(d.id); gb = { id: d.id, name: d.name || d.id, description: d.description, declared: true, none: false }; }
        } else { gk = 'u:' + norm(gv); gb = { id: gv, name: gv, declared: false, none: false }; }
      }
      let g = pb.groups.get(gk);
      if (!g) { g = { ...gb, rows: [] }; pb.groups.set(gk, g); }
      g.rows.push(p);
    }
  }

  const alpha = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name);
  const rank = (list, at) => [
    ...list.filter((x) => x.declared).sort((a, b) => (at.get(a.id) || 0) - (at.get(b.id) || 0)),
    ...list.filter((x) => !x.declared && !x.none).sort(alpha),
    ...list.filter((x) => x.none),
  ];
  const num = (v, d) => (typeof v === 'number' ? v : d);
  const journeyOrder = (a, b) => {
    const ao = a.order != null ? 0 : 1, bo = b.order != null ? 0 : 1;
    return ao - bo || num(a.order, 0) - num(b.order, 0) || num(a.cfgIndex, Infinity) - num(b.cfgIndex, Infinity) || a.seq - b.seq;
  };
  const under = new Map();
  const personas = rank([...pBuckets.values()], pIndex).map((pb) => {
    const groups = rank([...pb.groups.values()], gIndex).map((gb) => {
      const journeys = gb.rows.slice().sort(journeyOrder).map((p) => {
        const r = {
          ...p.row, designId: p.designId, personaIds: [], personaNames: [], groupId: gb.id, pinned: false,
          statusKey: statusKeyOf(p.row.built || 0, p.row.total != null ? p.row.total : (p.row.screens || []).length),
          storylines: [],
          ...(p.placedBy ? { placedBy: p.placedBy } : {}),
        };
        if (p.persona !== undefined) r.persona = p.persona; else delete r.persona;
        if (p.group !== undefined) r.group = p.group; else delete r.group;
        if (p.order !== undefined) r.order = p.order; else delete r.order;
        const u = under.get(r.nodeId) || { ids: [], names: [] };
        if (!u.ids.includes(pb.id)) { u.ids.push(pb.id); u.names.push(pb.name); }
        under.set(r.nodeId, u);
        r.personaIds = u.ids;
        r.personaNames = u.names;
        return r;
      });
      return {
        id: gb.id, name: gb.name, ...(gb.description ? { description: gb.description } : {}), declared: gb.declared,
        ...(gb.none ? { key: 'journeys.noGroup' } : {}),
        journeys, counts: groupCounts(journeys, 'count.scope.group', pb.id + '/' + gb.id),
      };
    });
    const all = groups.flatMap((g) => g.journeys);
    const entries = all.filter((j) => !(j.requires || []).length);
    const pin = entries.filter((j) => (j.built || 0) > 0).reduce((best, j) => (!best || (j.total || 0) > (best.total || 0) ? j : best), undefined) || entries[0] || all[0];
    if (pin) pin.pinned = true;
    return {
      id: pb.id, name: pb.name, ...(pb.description ? { description: pb.description } : {}), declared: pb.declared,
      ...(pb.derived ? { derived: true } : {}), ...(pb.none ? { key: 'portfolio.noPersona' } : {}),
      groups, counts: groupCounts(all, 'count.scope.persona', pb.id),
    };
  });
  const uniq = new Set(personas.flatMap((p) => p.groups.flatMap((g) => g.journeys.map((j) => j.nodeId))));
  const sections = personas.reduce((n, p) => n + p.groups.length, 0);
  const multi = inScope.length > 1;
  const notes = inScope.flatMap(([repo, m]) => (m.notes || []).map((n) => (multi ? repo + ': ' + n : n)));
  const storylines = storylinesFold(personas, inScope, notes);
  return {
    storylines,
    personas,
    counts: {
      storylines: counted(storylines.length, 'count.unit.storylines', 'count.scope.workspace', SRC + ' → storylines'),
      journeys: counted(uniq.size, 'count.unit.journeys', 'count.scope.workspace', SRC + ' → distinct flow node ids'),
      personas: counted(personas.length, 'count.unit.personas', 'count.scope.workspace', SRC + ' → personas'),
      groups: counted(sections, 'count.unit.groups', 'count.scope.workspace', SRC + ' → personas[].groups (one per persona it is shown under)'),
    },
    derived: derivedAny,
    notes,
  };
}

/**
 * The storylines of the sources in scope — core `journeyTree()`'s fold, rule for rule: per source in
 * source order, each declared storyline once by id (a second source's is a note), its journeys the
 * steps in order (a journey not drawn in this scope is a note), each step its first row in the tree
 * with `stepIndex`; every row learns the storylines it is a step of. O(journeys + steps).
 */
function storylinesFold(personas, inScope, notes) {
  const firstRow = new Map();
  const rowsOf = new Map();
  for (const p of personas) for (const g of p.groups) for (const j of g.journeys) {
    if (!firstRow.has(j.nodeId)) firstRow.set(j.nodeId, j);
    if (!rowsOf.has(j.nodeId)) rowsOf.set(j.nodeId, []);
    rowsOf.get(j.nodeId).push(j);
  }
  const declared = [];
  const seen = new Map();
  for (const [repo, m] of inScope) {
    for (const s of (m && m.storylines) || []) {
      if (!s || !str(s.id)) continue;
      const k = norm(s.id);
      if (seen.has(k)) { notes.push('storyline "' + s.id + '" is declared by ' + seen.get(k) + ' and ' + repo + '; the one in ' + seen.get(k) + ' is kept'); continue; }
      seen.set(k, repo);
      const own = [...(s.notes || [])];
      const nodeIds = [];
      for (const fid of s.journeys || []) {
        const nodeId = repo + '::flow::' + fid;
        if (!firstRow.has(nodeId)) { own.push('journey "' + fid + '" is not drawn in this scope — it is not a step here'); continue; }
        if (!nodeIds.includes(nodeId)) nodeIds.push(nodeId);
      }
      declared.push({ repo, s, nodeIds, own });
    }
  }
  const memberOf = new Map();
  for (const d of declared) for (const nodeId of d.nodeIds) {
    if (!memberOf.has(nodeId)) memberOf.set(nodeId, []);
    const list = memberOf.get(nodeId);
    if (!list.includes(d.s.id)) list.push(d.s.id);
  }
  for (const [nodeId, list] of memberOf) for (const r of rowsOf.get(nodeId) || []) r.storylines = list;
  return declared.map(({ repo, s, nodeIds, own }) => {
    const journeys = nodeIds.map((nodeId, i) => ({ ...firstRow.get(nodeId), stepIndex: i }));
    const built = journeys.filter(isBuilt).length;
    return {
      id: s.id, name: s.name || s.id, ...(s.description ? { description: s.description } : {}),
      repo, from: s.from || '',
      journeys,
      counts: {
        journeys: counted(journeys.length, 'count.unit.journeys', 'count.scope.storyline', SRC + ' → storylines[' + s.id + '].journeys'),
        built: counted(built, 'count.unit.journeysBuilt', 'count.scope.storyline', SRC + ' → storylines[' + s.id + '].journeys where every screen is built', journeys.length),
      },
      notes: own,
    };
  });
}

/**
 * Where one journey stands in the storylines: `[{ storyline, step, of, prev, next }]`, one per storyline it is a
 * step of, in the tree's storyline order — `step` 1-based, `prev` / `next` the neighbouring steps' rows (null at
 * an end). `flowId` is the flow's node id (`repo::flow::id`) or its bare id. The explore card, the property head
 * and the journey header print *in storyline: <name> · step n of m* from it. O(steps).
 * @group Journey view
 */
export function storylineOf(tree, flowId) {
  const out = [];
  if (!flowId) return out;
  const want = String(flowId);
  for (const s of (tree && tree.storylines) || []) {
    const i = (s.journeys || []).findIndex((j) => j.nodeId === want || j.id === want);
    if (i < 0) continue;
    out.push({ storyline: s, step: i + 1, of: s.journeys.length, prev: i > 0 ? s.journeys[i - 1] : null, next: i < s.journeys.length - 1 ? s.journeys[i + 1] : null });
  }
  return out;
}

/**
 * One storyline of the tree by id (or name, trimmed and case-insensitive) — `?storyline=` on the Map — else null.
 * @group Journey view
 */
export function findStoryline(tree, id) {
  if (id == null || id === '') return null;
  const list = (tree && tree.storylines) || [];
  return list.find((s) => s.id === id) || list.find((s) => norm(s.id) === norm(id) || norm(s.name) === norm(id)) || null;
}

/** A design row with what its graph node carries and the row does not. */
function withNode(f, nodeOf) {
  const n = nodeOf(f.nodeId);
  const d = (n && n.design) || {};
  return {
    ...f,
    requires: f.requires || d.requires || [],
    leadsTo: f.leadsTo || d.leadsTo || [],
    persona: f.persona != null ? f.persona : d.persona,
    group: f.group != null ? f.group : d.group,
    order: f.order != null ? f.order : d.order,
    position: f.position != null ? f.position : d.position,
  };
}

/**
 * The tree narrowed to one persona and/or one group (`?persona=` · `?group=`).
 * Counts are the tree's own — a filter hides sections, it never recounts them.
 * @group Journey view
 */
export function filterTree(tree, persona, group) {
  if (!tree) return tree;
  const p = persona == null || persona === '' ? null : String(persona);
  const g = group == null || group === '' ? null : String(group);
  if (p == null && g == null) return tree;
  const personas = tree.personas
    .filter((x) => p == null || x.id === p || norm(x.name) === norm(p))
    .map((x) => ({ ...x, groups: x.groups.filter((y) => g == null || y.id === g || norm(y.name) === norm(g)) }))
    .filter((x) => x.groups.length);
  return { ...tree, personas };
}

/**
 * Where one journey sits: `[{ persona, group }]`, one per persona it is listed
 * under, in tree order — the open journey's header line reads the first.
 * @group Journey view
 */
export function placesOf(tree, nodeId) {
  const out = [];
  for (const p of (tree && tree.personas) || []) {
    for (const g of p.groups) if (g.journeys.some((j) => j.nodeId === nodeId)) out.push({ persona: p, group: g });
  }
  return out;
}

/**
 * The journeys in tree order, each once, with every persona and the group it
 * sits in — what the Map's persona band and the Portfolio read.
 * @group Journey view
 */
export function journeysInOrder(tree) {
  const out = new Map();
  for (const p of (tree && tree.personas) || []) {
    p.groups.forEach((g) => {
      g.journeys.forEach((j) => {
        if (!out.has(j.nodeId)) out.set(j.nodeId, { row: j, places: [] });
        out.get(j.nodeId).places.push({ personaId: p.id, groupId: g.id });
      });
    });
  }
  return [...out.values()];
}
