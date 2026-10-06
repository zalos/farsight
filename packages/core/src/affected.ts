/**
 * What an impact answer reaches **on the journeys** — the Map's Affected mode
 * (docs/proposals/map-pass-2026-10-03.md §4).
 *
 * `impactOf()` answers *what uses this node, by distance*. A reader on the Map
 * asks the same question about the things the Map draws: which journeys, which
 * screens, which calls. This fold reads one report and places it on the
 * journeys' walks; it never walks the graph again and never adds two hops.
 *
 * A journey or a screen is **reached** when its walk (the steps a screen's
 * actions take, their gates, the screen itself) meets the seed or a node the
 * report lists. Two different facts, kept apart by `hop`:
 *
 *  - `hop: 0` — the walk meets the seed itself. That says the screen uses it,
 *    however many edges lie between the screen and the seed; it is not a
 *    distance, and the words for it never pretend it is one.
 *  - `hop: n` — the walk does not meet the seed, but meets something the report
 *    lists at distance n (a rule a package is imported into, a shared helper).
 *    The fewest such distance wins.
 *
 * Calls (`route` nodes) and data (records, messages, third parties) are reached
 * only by the report's own hop sets, or by being the seed. Every count here is
 * a set counted once, split by the distance at which each member was first met
 * — a partition, never a sum across hops of anything the report counts.
 */
import type { GraphNode } from './graph.js';
import { type GraphIndex, journey, journeySummary } from './query.js';
import { screensFor } from './design.js';
import { counted, type Counted, type CountPart } from './counts.js';
import { impactTestsReaching, type ImpactReport } from './impact.js';

/** The kinds the Map draws beside a call — its records, messages and third parties. */
const DATA_KINDS = new Set<GraphNode['kind']>(['table', 'queue', 'external']);

export interface AffectedJourney { flowId: string; name: string; hop: number; by: string }
export interface AffectedScreen {
  flowId: string;
  /** the journey summary's segment index of the screen (a lead segment with no screen folds into the next) */
  segment: number;
  /** the screen's node id (a page, or the design screen a planned one is) */
  screenId: string;
  name: string;
  hop: number;
  /** the node that met it: the seed, or the listed node met at `hop` */
  by: string;
}
export interface AffectedNode { nodeId: string; name: string; kind: GraphNode['kind']; hop: number }

export interface AffectedReach {
  seed: string;
  /** the budget the report was asked with — the distance the hop sets run to */
  hops: number;
  journeys: AffectedJourney[];
  screens: AffectedScreen[];
  /** routes: the seed (hop 0) and every route the report lists */
  calls: AffectedNode[];
  /** records, messages and third parties: the seed and every one the report lists */
  data: AffectedNode[];
  /** each a set counted once, broken down by the distance it was first met at (the parts sum to n) */
  counted: { journeys: Counted; screens: Counted; calls: Counted; tests: Counted };
}

interface FlowWalk {
  id: string;
  name: string;
  nodes: Set<string>;
  screens: { segment: number; screenId: string; name: string; nodes: Set<string> }[];
}

const walkCache = new WeakMap<GraphIndex, FlowWalk[]>();

/**
 * Every journey's walk as node sets, per journey and per screen — one
 * `journey()` + `journeySummary()` per flow, cached per graph index. The journey
 * set is the same one `journeysReaching()` (deps.ts) reads: steps, their gates,
 * the screens; a screen's set is the steps inside its segment's range.
 */
export function flowWalks(index: GraphIndex): FlowWalk[] {
  const hit = walkCache.get(index);
  if (hit) return hit;
  const out: FlowWalk[] = [];
  for (const flow of index.byId.values()) {
    if (flow.kind !== 'flow') continue;
    try {
      const j = journey(index, flow.id);
      const designed = screensFor(index, flow.id);
      const sum = journeySummary(index, j, designed);
      const nodes = new Set<string>();
      for (const s of j.steps) {
        nodes.add(s.nodeId);
        for (const g of s.gates) nodes.add(g.id);
      }
      for (const sc of designed) nodes.add(sc.id);
      const screens: FlowWalk['screens'] = [];
      let lead = new Set<string>();
      for (const seg of sum.segments) {
        const own = new Set<string>(lead);
        for (const s of j.steps) {
          if (s.order < seg.from || s.order > seg.to) continue;
          own.add(s.nodeId);
          for (const g of s.gates) own.add(g.id);
        }
        for (const g of seg.gates) own.add(g.id);
        for (const g of seg.configChecks ?? []) own.add(g.id);
        for (const m of seg.markers) {
          own.add(m.nodeId);
          for (const c of m.choice?.candidates ?? []) own.add(c.nodeId);
        }
        if (!seg.screen) { lead = own; continue; }
        lead = new Set<string>();
        own.add(seg.screen.id);
        screens.push({ segment: seg.index, screenId: seg.screen.id, name: seg.screen.name, nodes: own });
        for (const id of own) nodes.add(id);
      }
      out.push({ id: flow.id, name: flow.name, nodes, screens });
    } catch {
      continue; // a flow that cannot be walked contributes nothing, and claims nothing
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  walkCache.set(index, out);
  return out;
}

/** The part key a member first met at `hop` is counted under. */
export function reachPartKey(hop: number): string {
  return hop <= 0 ? 'count.part.reachSelf' : hop === 1 ? 'count.part.reachDirect' : hop === 2 ? 'count.part.reachThrough' : 'count.part.reachFar';
}
const PART_ORDER = ['count.part.reachSelf', 'count.part.reachDirect', 'count.part.reachThrough', 'count.part.reachFar'];

/** A set's members by the distance each was first met at, as a partition in the catalog's order (zero parts left out). */
function byDistance(hops: number[]): CountPart[] {
  const n = new Map<string, number>();
  for (const h of hops) n.set(reachPartKey(h), (n.get(reachPartKey(h)) ?? 0) + 1);
  return PART_ORDER.filter((k) => n.get(k)).map((k) => ({ key: k, n: n.get(k)! }));
}

/**
 * Place one impact report on the journeys. Needs the report asked with
 * `tests: true` for the tests count to be anything but zero.
 */
export function affectedReach(index: GraphIndex, report: ImpactReport): AffectedReach {
  const seed = report.seed.id;
  const hopOf = new Map<string, number>([[seed, 0]]);
  for (const h of report.hops) for (const n of h.nodes) if (!hopOf.has(n.nodeId)) hopOf.set(n.nodeId, h.hop);

  /** The fewest hop at which a set meets the seed or a listed node, and the node that does. */
  const meet = (set: Set<string>): { hop: number; by: string } | null => {
    if (set.has(seed)) return { hop: 0, by: seed };
    let best: { hop: number; by: string } | null = null;
    for (const [id, hop] of hopOf) {
      if (hop === 0 || !set.has(id)) continue;
      if (!best || hop < best.hop || (hop === best.hop && id < best.by)) best = { hop, by: id };
    }
    return best;
  };

  const journeys: AffectedJourney[] = [];
  const screens: AffectedScreen[] = [];
  for (const f of flowWalks(index)) {
    const j = meet(f.nodes);
    if (!j) continue;
    journeys.push({ flowId: f.id, name: f.name, ...j });
    for (const s of f.screens) {
      const m = meet(s.nodes);
      if (m) screens.push({ flowId: f.id, segment: s.segment, screenId: s.screenId, name: s.name, ...m });
    }
  }

  const calls: AffectedNode[] = [];
  const data: AffectedNode[] = [];
  for (const [id, hop] of hopOf) {
    const n = index.byId.get(id);
    if (!n) continue;
    if (n.kind === 'route') calls.push({ nodeId: id, name: n.name, kind: n.kind, hop });
    else if (DATA_KINDS.has(n.kind)) data.push({ nodeId: id, name: n.name, kind: n.kind, hop });
  }
  const order = (a: AffectedNode, b: AffectedNode) => a.hop - b.hop || a.name.localeCompare(b.name);
  calls.sort(order);
  data.sort(order);

  // tests: the union the CLI and the drawer print for hops 1..budget, split by where each test is first met
  const budget = report.hops.length ? report.hops[report.hops.length - 1]!.hop : 0;
  const reaching = impactTestsReaching(report, budget);
  const firstAt = new Map<string, number>();
  for (const h of report.hops) for (const n of h.nodes) for (const t of n.tests ?? []) if (!firstAt.has(t.id)) firstAt.set(t.id, h.hop);

  const src = 'core affected.ts affectedReach';
  // screens counted once each, by the page they show: a page four journeys share is one screen (round 2 — it read as
  // four), met at the fewest hop any of its journeys meets it; the list keeps one row per journey, as the Map draws it
  const screenHop = new Map<string, number>();
  for (const x of screens) screenHop.set(x.screenId, Math.min(x.hop, screenHop.get(x.screenId) ?? Infinity));
  return {
    seed,
    hops: budget,
    journeys,
    screens,
    calls,
    data,
    counted: {
      journeys: counted(journeys.length, 'count.unit.affectedJourneys', 'count.scope.affected', `${src} → journeys whose walk meets the seed or a listed node`,
        { bizUnit: 'count.unit.affectedJourneys', breakdown: byDistance(journeys.map((x) => x.hop)) }),
      screens: counted(screenHop.size, 'count.unit.affectedScreens', 'count.scope.affected', `${src} → distinct pages of those journeys whose own part of a walk meets them`,
        { bizUnit: 'count.unit.affectedScreens', breakdown: byDistance([...screenHop.values()]) }),
      calls: counted(calls.length, 'count.unit.affectedCalls', 'count.scope.affected', `${src} → route nodes in the hop sets, and the seed when it is one`,
        { breakdown: byDistance(calls.map((x) => x.hop)) }),
      tests: counted(reaching.total, 'count.unit.affectedTests', 'count.scope.affected', `${src} → impactTestsReaching(report, ${budget})`,
        { bizUnit: 'count.unit.affectedTests', breakdown: byDistance(reaching.tests.map((t) => firstAt.get(t.id) ?? budget)) }),
    },
  };
}
