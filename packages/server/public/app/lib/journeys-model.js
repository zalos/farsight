// lib/journeys-model.js — the journeys organised persona → group → journeys, as
// pure functions (no DOM, no store).
//
// The server answers `/api/journeys` with a `JourneyTree` folded by core
// `journeyTree()` (docs/proposals/journey-organisation-and-config-files.md
// §4.3). An older server has no such route: `treeFrom()` folds the same shape
// from `/api/design`'s answer, so the Journeys front door, the Portfolio and the
// Map read one shape whichever server answers. The rules are the proposal's
// §4.1, written once here:
//
// - a flow's `persona` is a string or an array; each value matches a declared
//   persona by id, else by name (case-insensitive, trimmed); a value nothing
//   declares is a persona of its own (`declared: false`) after the declared
//   ones, alphabetically; a flow with no persona takes the shared prefix of its
//   screen ids (`derived`), else falls under the trailing *No persona* (id '');
// - a flow's `group` matches a declared group by id, else by name; undeclared →
//   a group of its own after the declared ones, alphabetically; none → the
//   persona's trailing *Other journeys* group (id '');
// - inside a group: `order` ascending, ties and absences in manifest order;
// - the pinned *way in* of each manifest (the first unrequired flow with
//   something built, the widest) is marked and never moved.
//
// Every count is a `Counted` (core counts.ts): `{ n, unit, scope, source, breakdown? }`.
// Names a person wrote are kept as written; the words for the two buckets
// (*No persona*, *Other journeys*) are the surface's, from the catalog.

const SRC = '/api/design flows';

/** `{ n, unit, bizUnit, scope, source }` — the shape core's `counted()` returns. */
function counted(n, unit, scope, source, breakdown) {
  // the units are people's words (journeys, built, personas, groups): the business lens prints them too
  const c = { n, unit, bizUnit: unit, scope, source };
  if (breakdown && breakdown.length) c.breakdown = breakdown;
  return c;
}

/** A name compared the way the proposal matches: trimmed, case-insensitive. */
function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

/** An id for a name nothing declared: lower case, words joined by `-`. */
export function slugOf(s) {
  return norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || norm(s);
}

/** A journey is built when the code builds every screen it names. */
export function isBuilt(f) {
  const total = f && f.total != null ? f.total : ((f && f.screens) || []).length;
  return total > 0 && ((f && f.built) || 0) >= total;
}

/** The persona values a flow names, as a list (a string, an array, or nothing). */
function personaValues(v) {
  const list = Array.isArray(v) ? v : v == null || v === '' ? [] : [v];
  return list.map((x) => String(x).trim()).filter(Boolean);
}

/** The pinned way in among `flows`: of those nothing requires, the widest with something built. */
export function pinnedOf(flows) {
  const entries = flows.filter((f) => !(f.requires || []).length);
  const p = entries.filter((f) => (f.built || 0) > 0).sort((a, b) => (b.total || 0) - (a.total || 0))[0] || entries[0] || flows[0];
  return p ? p.nodeId : null;
}

/**
 * Fold a `JourneyTree` from `/api/design`'s design sources.
 *
 * `metas` is the graph's `meta.journeys` (repo → `JourneysMeta`) when the graph
 * carries one: its declared personas and groups and its config overrides by
 * flow id. A design source may also carry `personas` / `groups` itself. `opts`:
 * - `nodeOf(nodeId)` → the flow's graph node, whose `design` carries what an
 *   older `/api/design` row leaves out (`requires`, `leadsTo`, `group`, `order`,
 *   a persona list);
 * - `ordinal(nodeId)` → the flow's position in its manifest (`/api/design`
 *   sorts flows by name; the graph keeps the manifest's order).
 * @group Journey view
 */
export function treeFrom(designs, metas, opts = {}) {
  const nodeOf = typeof opts.nodeOf === 'function' ? opts.nodeOf : () => null;
  const ordinal = typeof opts.ordinal === 'function' ? opts.ordinal : () => null;
  const M = metas && typeof metas === 'object' ? metas : {};
  const declaredP = [];          // { id, name, description?, declared: true }
  const declaredG = [];          // { id, name, description?, persona?, declared: true }
  const addP = (p) => {
    if (!p || !p.id) return;
    const had = declaredP.find((x) => x.id === p.id);
    if (had) { if (!had.description && p.description) had.description = p.description; return; }
    declaredP.push({ id: String(p.id), name: String(p.name || p.id), ...(p.description ? { description: String(p.description) } : {}), declared: true });
  };
  const addG = (g) => {
    if (!g || !g.id) return;
    const pk = g.persona ? String(g.persona) : '';
    const had = declaredG.find((x) => x.id === g.id && (x.persona || '') === pk);
    if (had) { if (!had.description && g.description) had.description = g.description; return; }
    declaredG.push({ id: String(g.id), name: String(g.name || g.id), ...(g.description ? { description: String(g.description) } : {}), ...(pk ? { persona: pk } : {}), declared: true });
  };
  const notes = [];
  const sources = Array.isArray(designs) ? designs : [];
  // the config's order is the order: meta first (it folds config over manifest), then a source's own
  for (const d of sources) {
    const m = d && M[d.repo];
    if (m) { (m.personas || []).forEach(addP); (m.groups || []).forEach(addG); }
  }
  for (const d of sources) { ((d && d.personas) || []).forEach(addP); ((d && d.groups) || []).forEach(addG); }
  for (const m of Object.values(M)) for (const n of (m && m.notes) || []) if (!notes.includes(n)) notes.push(n);

  // the rows: every flow once, with what the older answer leaves out read from its node
  const rows = [];
  const seen = new Set();
  sources.forEach((d, di) => {
    const pinned = pinnedOf(((d && d.flows) || []).map((f) => withNode(f, nodeOf)));
    ((d && d.flows) || []).forEach((f0, fi) => {
      if (!f0 || !f0.nodeId || seen.has(f0.nodeId)) return;
      seen.add(f0.nodeId);
      const f = withNode(f0, nodeOf);
      const over = (M[d.repo] && M[d.repo].flows && M[d.repo].flows[f.id]) || null;
      const ord = ordinal(f.nodeId);
      rows.push({
        ...f,
        repo: f.repo || d.repo || '',
        persona: over && over.persona != null ? over.persona : f.persona,
        group: over && over.group != null ? over.group : f.group,
        order: over && over.order != null ? over.order : f.order,
        pinned: f.nodeId === pinned,
        _at: di * 1e6 + (typeof ord === 'number' ? ord : 1e5 + fi),
      });
    });
  });

  const pById = new Map(declaredP.map((p) => [p.id, p]));
  const pByName = new Map(declaredP.map((p) => [norm(p.name), p]));
  const undeclaredP = new Map();  // id → persona
  let derived = false;
  /** the personas a row is listed under, as persona ids ('' = no persona) */
  const personaIdsOf = (r) => {
    let vals = personaValues(r.persona);
    if (!vals.length) {
      const prefixes = [...new Set((r.screens || []).map((x) => String(x).split('-')[0]).filter(Boolean))];
      if (prefixes.length === 1) { derived = true; vals = [prefixes[0]]; r.personaDerived = true; }
    }
    if (!vals.length) return [''];
    const out = [];
    for (const v of vals) {
      const p = pById.get(v) || pByName.get(norm(v));
      let id;
      if (p) id = p.id;
      else {
        id = slugOf(v);
        if (pById.has(id)) id = id + '~';     // a free name never captures a declared id
        if (!undeclaredP.has(id)) undeclaredP.set(id, { id, name: v, declared: false });
      }
      if (!out.includes(id)) out.push(id);
    }
    return out;
  };
  for (const r of rows) r.personaIds = personaIdsOf(r);

  // the persona sections, in order: declared · undeclared alphabetically · no persona
  const personaOrder = [
    ...declaredP,
    ...[...undeclaredP.values()].sort((a, b) => a.name.localeCompare(b.name)),
    { id: '', name: '', declared: false },
  ];
  const groupKeys = new Set();
  const personas = [];
  for (const p of personaOrder) {
    const list = rows.filter((r) => r.personaIds.includes(p.id));
    if (!list.length) continue;
    // the groups this persona can hold: scoped to it, or to nobody
    const gHere = declaredG.filter((g) => !g.persona || g.persona === p.id);
    const gById = new Map();
    for (const g of gHere) if (!gById.has(g.id) || g.persona) gById.set(g.id, g);
    const gByName = new Map([...gById.values()].map((g) => [norm(g.name), g]));
    const undeclaredG = new Map();
    const groupOf = (r) => {
      const v = r.group == null ? '' : String(r.group).trim();
      if (!v) return '';
      const g = gById.get(v) || gByName.get(norm(v));
      if (g) return g.id;
      // a group declared for another persona, named by a journey that is also this one's: the same group
      const other = declaredG.find((x) => x.id === v) || declaredG.find((x) => norm(x.name) === norm(v));
      if (other) { gById.set(other.id, other); return other.id; }
      let id = slugOf(v);
      if (gById.has(id)) id = id + '~';
      if (!undeclaredG.has(id)) undeclaredG.set(id, { id, name: v, declared: false });
      return id;
    };
    const byGroup = new Map();
    for (const r of list) {
      const gid = groupOf(r);
      if (!byGroup.has(gid)) byGroup.set(gid, []);
      byGroup.get(gid).push(r);
    }
    const gOrder = [
      ...[...gById.values()].sort((a, b) => declaredG.indexOf(a) - declaredG.indexOf(b)),
      ...[...undeclaredG.values()].sort((a, b) => a.name.localeCompare(b.name)),
      { id: '', name: '', declared: false },
    ];
    const groups = [];
    for (const g of gOrder) {
      const js = byGroup.get(g.id);
      if (!js || !js.length) continue;
      groupKeys.add(g.id);
      const journeys = js.slice().sort((a, b) => {
        const oa = typeof a.order === 'number' ? a.order : Infinity;
        const ob = typeof b.order === 'number' ? b.order : Infinity;
        return (oa === ob ? 0 : oa < ob ? -1 : 1) || a._at - b._at;
      }).map(rowOut);
      const built = journeys.filter(isBuilt).length;
      groups.push({
        id: g.id, name: g.name, ...(g.description ? { description: g.description } : {}), declared: !!g.declared,
        journeys,
        counts: {
          journeys: counted(journeys.length, 'count.unit.journeys', 'count.scope.group', SRC),
          built: counted(built, 'count.unit.journeysBuilt', 'count.scope.group', SRC + ' · built of total'),
        },
      });
    }
    const n = groups.reduce((a, g) => a + g.journeys.length, 0);
    const built = groups.reduce((a, g) => a + g.counts.built.n, 0);
    // a persona's journeys, by group: the groups partition them (a journey sits in one group)
    const parts = groups.map((g) => ({ key: 'count.unit.journeys', n: g.journeys.length, label: g.name || '' }));
    personas.push({
      id: p.id, name: p.name, ...(p.description ? { description: p.description } : {}), declared: !!p.declared,
      groups,
      counts: {
        journeys: counted(n, 'count.unit.journeys', 'count.scope.persona', SRC, groups.length > 1 ? parts : null),
        built: counted(built, 'count.unit.journeysBuilt', 'count.scope.persona', SRC + ' · built of total'),
      },
    });
  }
  return {
    personas,
    counts: {
      journeys: counted(rows.length, 'count.unit.journeys', 'count.scope.workspace', SRC),
      personas: counted(personas.length, 'count.unit.personas', 'count.scope.workspace', SRC),
      groups: counted(groupKeys.size, 'count.unit.groups', 'count.scope.workspace', SRC),
    },
    derived,
    notes,
  };
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
  };
}

/** A `JourneyRow` as the tree hands it out: the row without the fold's own bookkeeping. */
function rowOut(r) {
  const { _at, personaIds, ...rest } = r;
  return { ...rest, personaIds: personaIds.slice() };
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
