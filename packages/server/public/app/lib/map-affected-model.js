// lib/map-affected-model.js — the Map's Affected mode, as pure functions
// (docs/proposals/map-pass-2026-10-03.md §4). No DOM, no catalog, no fetch: the
// link grammar of a seed, how several seeds' answers are laid over one board
// (each kept apart — never summed), the words key for a distance, and one
// answer read per distance for the Affected tab. surfaces/map-affected.js owns
// the state and the requests; packages/server/test/map-affected-model.test.ts
// holds these.

/** The distance the mode asks first — the code map's IMPACT default. */
export const AFF_HOPS = 2;
/** As far as the impact fold answers. */
export const AFF_MAX_HOPS = 5;
/** A change touching more parts than this asks about the first ones and names the rest as not asked. */
export const AFF_MAX_SEEDS = 8;

const TYPES = ['package', 'work', 'commit'];

/**
 * Read a seed from the link: `<nodeId>` · `package:<nodeId>` · `work:<KEY or item id>` · `commit:<sha>`.
 * A node id holds `::`, so a bare id is never read as one of the typed forms.
 * @param {string} spec
 * @returns {{ type: 'node'|'package'|'work'|'commit', id: string, spec: string } | null}
 */
export function parseSeedSpec(spec) {
  const s = String(spec == null ? '' : spec).trim();
  if (!s) return null;
  const at = s.indexOf(':');
  const head = at > 0 ? s.slice(0, at) : '';
  if (TYPES.includes(head) && s.charAt(at + 1) !== ':') {
    const id = s.slice(at + 1).trim();
    if (!id) return null;
    if (head === 'commit' && !/^[0-9a-f]{4,40}$/i.test(id)) return null;
    return { type: head, id, spec: s };
  }
  return { type: 'node', id: s, spec: s };
}

/** The seed's link form. */
export function seedSpec(type, id) {
  return type === 'node' ? String(id) : type + ':' + id;
}

/** Clamp a distance from a link to 1..AFF_MAX_HOPS, else the default. */
export function hopsOf(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= AFF_MAX_HOPS ? n : AFF_HOPS;
}

/** Which parts of a change to ask about first: screens and calls before the code behind them, then by name. */
const KIND_RANK = { page: 0, route: 1, component: 2, function: 3, guard: 4, rule: 5, table: 6, queue: 7, external: 8, package: 9, module: 10 };
export function pickSeeds(nodes, max = AFF_MAX_SEEDS) {
  const uniq = [];
  const seen = new Set();
  for (const n of nodes || []) if (n && n.id && !seen.has(n.id)) { seen.add(n.id); uniq.push(n); }
  uniq.sort((a, b) => (KIND_RANK[a.kind] ?? 20) - (KIND_RANK[b.kind] ?? 20) || String(a.name).localeCompare(String(b.name)));
  return { seeds: uniq.slice(0, max), more: Math.max(0, uniq.length - max) };
}

/**
 * Lay several seeds' reach over one board. Each place keeps every seed that
 * reaches it with its own distance (`by`), and its `hop` is the nearest of
 * them — what the badge says. Nothing is counted across seeds.
 * @param {{ seed: string, reach: any }[]} entries
 */
export function combineReaches(entries) {
  const journeys = new Map();
  const screens = new Map();
  const nodes = new Map();
  const put = (map, key, seed, hop) => {
    const cur = map.get(key);
    if (!cur) { map.set(key, { hop, by: [{ seed, hop }] }); return; }
    cur.by.push({ seed, hop });
    if (hop < cur.hop) cur.hop = hop;
  };
  for (const { seed, reach } of entries || []) {
    if (!reach) continue;
    for (const j of reach.journeys || []) put(journeys, j.flowId, seed, j.hop);
    for (const s of reach.screens || []) put(screens, s.flowId + '|' + s.screenId, seed, s.hop);
    for (const c of (reach.calls || []).concat(reach.data || [])) put(nodes, c.nodeId, seed, c.hop);
  }
  return { journeys, screens, nodes, seeds: new Set((entries || []).map((e) => e.seed)) };
}

/**
 * The catalog key for how a place is reached. Hop 0 is not a distance — the
 * place's own path meets the thing picked — and the business words count no links.
 */
export function reachKey(hop, business) {
  if (hop == null) return 'map.affected.not';
  if (hop <= 0) return 'map.affected.self';
  if (!business) return 'map.affected.at';
  return hop === 1 ? 'map.affected.bizAt1' : hop === 2 ? 'map.affected.bizAt2' : 'map.affected.bizFar';
}

/**
 * One answer read one distance at a time, for the Affected tab: the journeys,
 * screens and calls first met at each distance (0 = their path meets the seed
 * itself), and the tests first met there — each test once, at its nearest
 * distance, the same union the reach's tests count partitions.
 * @param {any} report an `/api/impact` answer asked with `tests=1&reach=1`
 * @returns {{ hop: number, journeys: any[], screens: any[], calls: any[], tests: any[] }[]}
 */
export function hopGroups(report) {
  const reach = (report && report.reach) || {};
  const budget = (report && report.hops && report.hops.length) || 0;
  const groups = [];
  for (let h = 0; h <= budget; h++) groups.push({ hop: h, journeys: [], screens: [], calls: [], tests: [] });
  const at = (h) => groups[Math.max(0, Math.min(budget, h))];
  for (const j of reach.journeys || []) at(j.hop).journeys.push(j);
  for (const s of reach.screens || []) at(s.hop).screens.push(s);
  for (const c of reach.calls || []) at(c.hop).calls.push(c);
  const seen = new Set();
  for (const hp of (report && report.hops) || []) {
    for (const n of hp.nodes || []) {
      for (const x of n.tests || []) {
        if (seen.has(x.id)) continue;
        seen.add(x.id);
        at(hp.hop).tests.push(x);
      }
    }
  }
  return groups.filter((g) => g.journeys.length || g.screens.length || g.calls.length || g.tests.length);
}

/** The catalog key of a test's evidence word — the three classes, said as the Tests page says them. */
export function testEvidenceKey(x) {
  if (!x) return 'journey.evidence.declared';
  if (x.evidence === 'declared') return 'journey.evidence.declared';
  if (x.evidence === 'static') return 'journey.evidence.reached';
  if (x.runLevel) return x.stale ? 'tests.evidence.runSeenStale' : 'tests.evidence.runSeen';
  if (x.observedVia === 'declaration') return 'tests.evidence.declaredPassed';
  return x.stale ? 'journey.evidence.stale' : 'journey.evidence.observed';
}
