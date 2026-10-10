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
import { type GraphIndex, type JourneyStep, journey, journeySummary } from './query.js';
import { screensFor } from './design.js';
import { counted, type Counted, type CountPart } from './counts.js';
import { impactOf, impactTestsReaching, IMPACT_MAX_HOPS, type ImpactReport } from './impact.js';
import { nodesTouched, type FileHunks } from './work-graph.js';
import { testsCovering } from './metrics.js';
import { toCoverageRef, evidenceFacts, type CoverageTestRef } from './coverage.js';
import { storylinePlacements, type JourneyTree } from './journeys.js';
import type { TestsMatrixIdentity } from './tests.js';

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

// ── a commit range or a pull request, placed on the journeys (round 2026-10-10, proposal 6) ─────────────
//
// `affectedReach()` answers for one seed the Map was asked about. A change is many seeds at once: every
// function a commit range's hunks land in (`nodesTouched`, the commit spine's own rule), each the hop-0 seed
// of one impact report. This fold unions those reports — a node keeps the fewest hop any seed met it at —
// and places the union on the journeys exactly as `affectedReach` does, then reads **the changed path**:
// the actions of a journey whose own steps run changed code, and what those actions meet on the way — the
// gates and rules, the records written (with the status a lifecycle says the writer moves), the contract
// operations. The tests are every case that reaches what changed or what uses it, **each once**, with its
// own last run; the verdict line is `testVerdict()` over them, the one verdict every surface prints.
//
// Frozen as `farsight-affected v1` (schemas/farsight-affected-v1.schema.json, docs/contracts/). What the
// document may claim is a property of this function: reachability, never consequence — *a test reaches
// it*, never *a test proves it*; and a hunk is credited to the definition it starts in or sits under (the
// graph records no end line), so the changed set is a floor and `bound` says so.

/** One changed file of a range, its path relative to the source root, with the new-side line ranges that changed. */
export interface RangeFile extends FileHunks {
  /** git's letter: A added · M modified · D deleted · R renamed · C copied (absent when the host does not say) */
  status?: string;
}
export interface RangeCommit { sha: string; subject: string; at: string; author?: string }
/** What was asked about: two commits, or a pull request of a code host. */
export type AffectedRangeSpec =
  | { kind: 'commits'; from: string; to: string }
  | { kind: 'pr'; number: number; title?: string; url?: string; base?: string; head?: string; host?: string };

export interface AffectedRangeInput {
  /** the graph source the change belongs to */
  repo: string;
  range: AffectedRangeSpec;
  /** the commits in the range, oldest first */
  commits: RangeCommit[];
  /** the range's net change (base → head), one entry per file */
  files: RangeFile[];
  /** commits on the head's history, newest first — counted after the tests' last run (`commits since`) */
  history?: { sha: string; at: string }[];
  /** how far out the impact reports look (default 2) */
  hops?: number;
  /** the journey tree, for each journey's storyline position (absent: none is printed) */
  tree?: JourneyTree;
  identity: TestsMatrixIdentity;
}

/** The closed sets `farsight-affected v1` prints — a consumer switches on these words, so v1 only adds. */
export const AFFECTED_RANGE_KINDS = ['commits', 'pr'] as const;
export const AFFECTED_GRANULARITY = ['lines', 'file', 'none'] as const;
export const AFFECTED_GATE_KINDS = ['guard', 'rule'] as const;
export const AFFECTED_CONTRACT_STATUS = ['both', 'spec-only', 'code-only', 'declared', null] as const;
export const AFFECTED_RUN_STATUS = ['passed', 'failed', 'skipped', 'flaky', 'unknown', null] as const;
export const AFFECTED_EVIDENCE = ['declared', 'reached', 'observed'] as const;
export const AFFECTED_VERDICT_CLASS = ['none', 'declared', 'reached', 'observed', 'stale'] as const;
export const AFFECTED_TEST_LEVELS = ['unit', 'integration', 'e2e'] as const;
export const AFFECTED_TEST_RUNNERS = ['vitest', 'jest', 'node:test', 'playwright', 'cypress', 'junit', 'other'] as const;

/** Past this many changed parts the reports stop being asked and `bound` is a floor (a sweeping rename is not a review). */
export const AFFECTED_MAX_SEEDS = 400;

export interface AffectedTestRow {
  id: string;
  title: string;
  file: string;
  line: number | null;
  level: typeof AFFECTED_TEST_LEVELS[number];
  runner: typeof AFFECTED_TEST_RUNNERS[number];
  project: string;
  evidence_class: typeof AFFECTED_EVIDENCE[number];
  /** the case's own last run; null when no run names it */
  status: typeof AFFECTED_RUN_STATUS[number];
  at: string | null;
  /** 0 = it reaches a changed part itself (or its own file changed) · n = it reaches what uses one, n hops out */
  hop: number;
  /** `.skip` / `.todo`: listed, and it proves nothing */
  inactive: boolean;
}

export interface AffectedV1 {
  schema: 'farsight-affected v1';
  identity: TestsMatrixIdentity;
  range: {
    kind: typeof AFFECTED_RANGE_KINDS[number];
    repo: string;
    from: string | null;
    to: string | null;
    pr: { number: number; title: string | null; url: string | null; base: string | null; head: string | null; host: string | null } | null;
  };
  commits: { sha: string; subject: string; at: string; author: string | null }[];
  files: { path: string; status: string | null; parts: number; granularity: typeof AFFECTED_GRANULARITY[number] }[];
  /** hop 0: the parts the hunks landed in */
  changed: { id: string; name: string; kind: string; file: string; line: number | null }[];
  journeys: {
    id: string; name: string; hop: number; by: string;
    storylines: { id: string; name: string; step: number; of: number; branch_of: string | null; when: string | null }[];
    screens: { id: string; name: string; segment: number; hop: number }[];
  }[];
  /** the gates and rules on the changed path: on an action that runs changed code, or changed themselves */
  gates: { id: string; name: string; kind: typeof AFFECTED_GATE_KINDS[number]; tier: string | null; changed: boolean; journeys: string[] }[];
  /** records written on the changed path, the writer, and the status moves its lifecycle records for that writer */
  writes: { id: string; name: string; store: string | null; writer: string; writer_name: string; moves: { from: string | null; to: string }[]; journeys: string[] }[];
  /** contract operations on the changed path, or changed themselves */
  contracts: { id: string; name: string; method: string | null; path: string | null; contract: typeof AFFECTED_CONTRACT_STATUS[number]; changed: boolean }[];
  /** every case that reaches a changed part or what uses it, each once — nearest first */
  tests: AffectedTestRow[];
  /** whole-run coverage reports that reach the change: evidence, but no case to run */
  run_level: number;
  verdict: {
    class: typeof AFFECTED_VERDICT_CLASS[number];
    /** the catalog key of the evidence word (`testVerdict().word.key`) */
    word: string;
    passed: number; failed: number; skipped: number; flaky: number; no_run: number;
    last_run: string | null;
    /** commits on the head after the last run; null when the history or a run is not known */
    commits_since: number | null;
  };
  /** what a CI job can run: active cases with a file, by runner (the `farsight-impact-tests v1` shape) */
  select: Record<string, { file: string; title: string; project: string }[]>;
  counted: {
    commits: Counted; files: Counted; changed: Counted; journeys: Counted; screens: Counted;
    gates: Counted; writes: Counted; contracts: Counted; tests: Counted;
  };
  /** `floor` whenever a hunk could only be credited by file, a file matched nothing, a report was cut, or seeds were capped */
  bound: 'exact' | 'floor';
  notes: string[];
}

/** The node → fewest-hop map a set of reports puts on the graph (seeds at 0). */
function hopsOf(seeds: Iterable<string>, reports: ImpactReport[]): Map<string, number> {
  const hopOf = new Map<string, number>();
  for (const s of seeds) hopOf.set(s, 0);
  for (const r of reports) for (const h of r.hops) for (const n of h.nodes) {
    const have = hopOf.get(n.nodeId);
    if (have == null || h.hop < have) hopOf.set(n.nodeId, h.hop);
  }
  return hopOf;
}

/** The fewest hop at which a walk's node set meets the map, and the node that does (ties: the id that sorts first). */
function meetIn(set: Set<string>, hopOf: Map<string, number>): { hop: number; by: string } | null {
  let best: { hop: number; by: string } | null = null;
  for (const [id, hop] of hopOf) {
    if (!set.has(id)) continue;
    if (!best || hop < best.hop || (hop === best.hop && id < best.by)) best = { hop, by: id };
  }
  return best;
}

const repoOfNode = (n: GraphNode): string => n.loc?.repo ?? n.id.split('::')[0] ?? '';
const METHOD_PATH = /^([A-Z]+)\s+(\S+)/;

/** The node a `writes` step hangs under: the nearest earlier step one level up. */
function writerOf(steps: JourneyStep[], i: number): JourneyStep | undefined {
  const d = steps[i]!.depth;
  for (let k = i - 1; k >= 0; k--) if (steps[k]!.depth < d) return steps[k];
  return undefined;
}

/**
 * A commit range or a pull request → the frozen `farsight-affected v1` document. Pure over the graph and
 * the inputs: the caller reads the commits and the diff (git, or the code host's API) and passes them in.
 */
export function affectedRange(index: GraphIndex, input: AffectedRangeInput): AffectedV1 {
  const hops = Math.max(1, Math.min(IMPACT_MAX_HOPS, input.hops ?? 2));
  const notes: string[] = [];
  let floor = false;
  const src = 'core affected.ts affectedRange';

  // ── hop 0: the parts the hunks land in (the commit spine's rule, nodesTouched) ──
  const repoNodes: GraphNode[] = [];
  const testNodes: GraphNode[] = [];
  for (const n of index.byId.values()) {
    if (repoOfNode(n) !== input.repo) continue;
    if (n.kind === 'test') testNodes.push(n); else repoNodes.push(n);
  }
  const changed = new Map<string, GraphNode>();
  const files: AffectedV1['files'] = [];
  const changedTests = new Map<string, GraphNode>();
  for (const f of input.files) {
    const path = f.path.replace(/^\.\//, '');
    const touched = f.status === 'D' ? { nodes: [] as GraphNode[], fileOnly: false } : nodesTouched(repoNodes, { path, ranges: f.ranges });
    // a changed spec file: its cases are selected as they are, at hop 0
    const specs = testNodes.filter((t) => t.loc && !t.test?.runLevel && (t.loc.path === path || t.loc.path.endsWith('/' + path) || path.endsWith('/' + t.loc.path)));
    for (const t of specs) changedTests.set(t.id, t);
    for (const n of touched.nodes) changed.set(n.id, n);
    const granularity = touched.nodes.length ? (touched.fileOnly ? 'file' : 'lines') : 'none';
    if (granularity === 'file') floor = true;
    files.push({ path, status: f.status ?? null, parts: touched.nodes.length, granularity });
  }
  const unmatched = files.filter((f) => f.granularity === 'none' && !f.path.match(/\.(md|json|ya?ml|lock|txt|svg|png)$/i) && f.status !== 'D').length;
  if (unmatched) { floor = true; notes.push(`${unmatched} changed file(s) define nothing this graph indexed`); }

  let seeds = [...changed.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (seeds.length > AFFECTED_MAX_SEEDS) {
    floor = true;
    notes.push(`${seeds.length} parts changed; the first ${AFFECTED_MAX_SEEDS} were asked about`);
    seeds = seeds.slice(0, AFFECTED_MAX_SEEDS);
  }
  const seedIds = new Set(seeds.map((n) => n.id));

  // ── what uses them: one impact report per seed, folded by fewest hop ──
  const reports = seeds.map((n) => impactOf(index, n.id, { hops, tests: true }));
  if (reports.some((r) => r.bound === 'floor')) floor = true;
  const hopOf = hopsOf(seedIds, reports);

  // ── on the journeys: the same placement affectedReach makes, over the union ──
  const flows: AffectedV1['journeys'] = [];
  for (const f of flowWalks(index)) {
    const j = meetIn(f.nodes, hopOf);
    if (!j) continue;
    const screens: AffectedV1['journeys'][number]['screens'] = [];
    for (const s of f.screens) {
      const m = meetIn(s.nodes, hopOf);
      if (m) screens.push({ id: s.screenId, name: s.name, segment: s.segment, hop: m.hop });
    }
    const storylines = input.tree ? storylinePlacements(input.tree, f.id).map((p) => ({
      id: p.id, name: p.name, step: p.step, of: p.of, branch_of: p.branch?.of ?? null, when: p.branch?.when ?? null,
    })) : [];
    flows.push({ id: f.id, name: f.name, hop: j.hop, by: j.by, storylines, screens });
  }
  flows.sort((a, b) => a.hop - b.hop || a.name.localeCompare(b.name));

  // ── the changed path: the actions of a journey whose own steps run changed code ──
  const gates = new Map<string, AffectedV1['gates'][number]>();
  const writes = new Map<string, AffectedV1['writes'][number]>();
  const contracts = new Map<string, AffectedV1['contracts'][number]>();
  const tierOf = (n: GraphNode): string | null => {
    const x = (n as unknown as { tier?: unknown; meta?: { tier?: unknown } }).tier ?? (n as unknown as { meta?: { tier?: unknown } }).meta?.tier;
    return typeof x === 'string' ? x : null;
  };
  const addGate = (id: string, flowId: string | null): void => {
    const n = index.byId.get(id);
    if (!n || (n.kind !== 'guard' && n.kind !== 'rule')) return;
    const g = gates.get(id) ?? { id, name: n.name, kind: n.kind, tier: tierOf(n), changed: seedIds.has(id), journeys: [] };
    if (flowId && !g.journeys.includes(flowId)) g.journeys.push(flowId);
    gates.set(id, g);
  };
  const addContract = (id: string): void => {
    const n = index.byId.get(id);
    if (!n || n.kind !== 'route' || contracts.has(id)) return;
    const m = METHOD_PATH.exec(n.name);
    contracts.set(id, { id, name: n.name, method: m?.[1] ?? null, path: m?.[2] ?? null, contract: n.contract?.status ?? null, changed: seedIds.has(id) });
  };
  for (const n of seeds) { addGate(n.id, null); addContract(n.id); }
  for (const f of flows) {
    if (f.hop !== 0) continue;
    let j, sum;
    try {
      j = journey(index, f.id);
      sum = journeySummary(index, j, screensFor(index, f.id));
    } catch { continue; }
    const byOrder = new Map(j.steps.map((s, i) => [s.order, i]));
    for (const seg of sum.segments) {
      for (const m of seg.moments) {
        const idx: number[] = [];
        for (let o = m.from; o <= m.to; o++) { const i = byOrder.get(o); if (i != null) idx.push(i); }
        const runsChanged = idx.some((i) => { const s = j.steps[i]!; return seedIds.has(s.nodeId) || s.gates.some((g) => seedIds.has(g.id)); });
        if (!runsChanged) continue;
        for (const i of idx) {
          const s = j.steps[i]!;
          for (const g of s.gates) if (!g.config && !g.planned) addGate(g.id, f.id);
          const node = index.byId.get(s.nodeId);
          if (!node) continue;
          if (node.kind === 'route') addContract(node.id);
          if (s.via === 'writes' && node.kind === 'table') {
            const w = writerOf(j.steps, i);
            const writer = w ? index.byId.get(w.nodeId) : undefined;
            if (!writer) continue;
            const key = node.id + '|' + writer.id;
            const row = writes.get(key) ?? {
              id: node.id, name: node.name, store: node.store?.name ?? null, writer: writer.id, writer_name: writer.name,
              moves: (node.lifecycle?.transitions ?? []).filter((x) => x.by === writer.id).map((x) => ({ from: x.from ?? null, to: x.to })),
              journeys: [],
            };
            if (!row.journeys.includes(f.id)) row.journeys.push(f.id);
            writes.set(key, row);
          }
        }
      }
    }
  }

  // ── the tests: every case that reaches a changed part or what uses it, each once, nearest first ──
  const refAt = new Map<string, { ref: CoverageTestRef; hop: number }>();
  const take = (ref: CoverageTestRef, hop: number): void => {
    const have = refAt.get(ref.id);
    if (!have || hop < have.hop) refAt.set(ref.id, { ref, hop });
  };
  for (const n of seeds) for (const t of testsCovering(index, n.id)) take(toCoverageRef(index, t, n), 0);
  for (const t of changedTests.values()) {
    take(toCoverageRef(index, {
      id: t.id, name: t.name, level: t.test!.level, runner: t.test!.runner, evidence: 'declared', runLevel: false,
      ...(t.test!.inactive ? { inactive: true } : {}), ...(t.loc ? { loc: t.loc } : {}), ...(t.test!.run ? { run: t.test!.run } : {}),
      ...(t.test!.run?.project ? { project: t.test!.run.project } : t.test!.project ? { project: t.test!.project } : {}),
    }, t), 0);
  }
  for (const r of reports) for (const h of r.hops) for (const n of h.nodes) for (const t of n.tests ?? []) take(t, h.hop);
  const all = [...refAt.values()];
  const caseRows = all.filter((x) => !x.ref.runLevel);
  const runLevel = all.length - caseRows.length;
  const evidenceOf = (e: CoverageTestRef['evidence']): AffectedTestRow['evidence_class'] => (e === 'static' ? 'reached' : e);
  const tests: AffectedTestRow[] = caseRows.map(({ ref, hop }) => ({
    id: ref.id, title: ref.name, file: ref.loc?.path ?? '', line: ref.loc?.line ?? null,
    level: ref.level, runner: ref.runner, project: ref.project ?? '',
    evidence_class: evidenceOf(ref.evidence),
    status: (ref.status ?? null) as AffectedTestRow['status'], at: ref.at ?? null, hop, inactive: !!ref.inactive,
  })).sort((a, b) => a.hop - b.hop || a.level.localeCompare(b.level) || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.title.localeCompare(b.title));

  // ── the verdict: testVerdict() over the cases, the one verdict every surface prints ──
  const facts = evidenceFacts(all.map((x) => x.ref), 'count.scope.affected', `${src}().tests`);
  const part = (k: string) => facts.verdict.runs.breakdown?.find((p) => p.key === `count.part.${k}`)?.n ?? 0;
  const lastRun = caseRows.map((x) => x.ref.at).filter((x): x is string => !!x).sort().pop() ?? null;
  const commitsSince = lastRun && input.history ? input.history.filter((c) => c.at > lastRun).length : null;

  const select: AffectedV1['select'] = {};
  const seen = new Set<string>();
  for (const t of tests) {
    if (t.inactive || !t.file) continue;
    const key = `${t.runner}|${t.file}|${t.title}|${t.project}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (select[t.runner] ??= []).push({ file: t.file, title: t.title, project: t.project });
  }

  const screenHop = new Map<string, number>();
  for (const f of flows) for (const s of f.screens) screenHop.set(s.id, Math.min(s.hop, screenHop.get(s.id) ?? Infinity));
  const gateList = [...gates.values()].sort((a, b) => Number(b.changed) - Number(a.changed) || a.name.localeCompare(b.name));
  const writeList = [...writes.values()].sort((a, b) => a.name.localeCompare(b.name) || a.writer_name.localeCompare(b.writer_name));
  const contractList = [...contracts.values()].sort((a, b) => Number(b.changed) - Number(a.changed) || a.name.localeCompare(b.name));
  const changedRows = seeds.map((n) => ({ id: n.id, name: n.name, kind: n.kind, file: n.loc?.path ?? '', line: n.loc?.line ?? null }));
  const byStatus = (s: string) => files.filter((f) => (f.status ?? 'M') === s).length;
  const r = input.range;
  return {
    schema: 'farsight-affected v1',
    identity: input.identity,
    range: {
      kind: r.kind, repo: input.repo,
      from: r.kind === 'commits' ? r.from : r.base ?? null,
      to: r.kind === 'commits' ? r.to : r.head ?? null,
      pr: r.kind === 'pr' ? { number: r.number, title: r.title ?? null, url: r.url ?? null, base: r.base ?? null, head: r.head ?? null, host: r.host ?? null } : null,
    },
    commits: input.commits.map((c) => ({ sha: c.sha, subject: c.subject, at: c.at, author: c.author ?? null })),
    files,
    changed: changedRows,
    journeys: flows,
    gates: gateList,
    writes: writeList,
    contracts: contractList,
    tests,
    run_level: runLevel,
    verdict: {
      class: facts.verdict.word.cls, word: facts.verdict.word.key,
      passed: part('passed'), failed: part('failed'), skipped: part('skipped'), flaky: part('flaky'), no_run: part('noRun'),
      last_run: lastRun, commits_since: commitsSince,
    },
    select,
    counted: {
      commits: counted(input.commits.length, 'count.unit.affectedCommits', 'count.scope.affected', `${src} → the commits in the range`),
      files: counted(files.length, 'count.unit.affectedFiles', 'count.scope.affected', `${src} → files changed base → head`, {
        breakdown: [{ key: 'count.part.fileAdded', n: byStatus('A') }, { key: 'count.part.fileModified', n: files.length - byStatus('A') - byStatus('D') }, { key: 'count.part.fileDeleted', n: byStatus('D') }],
      }),
      changed: counted(changedRows.length, 'count.unit.affectedChanged', 'count.scope.affected', `${src} → nodesTouched over the files' hunks`, {
        breakdown: [{ key: 'count.part.commitLines', n: files.filter((f) => f.granularity === 'lines').reduce((a, f) => a + f.parts, 0) }, { key: 'count.part.commitFile', n: files.filter((f) => f.granularity === 'file').reduce((a, f) => a + f.parts, 0) }],
      }),
      journeys: counted(flows.length, 'count.unit.affectedJourneys', 'count.scope.affected', `${src} → journeys whose walk meets a changed part or a listed node`,
        { bizUnit: 'count.unit.affectedJourneys', breakdown: byDistance(flows.map((x) => x.hop)) }),
      screens: counted(screenHop.size, 'count.unit.affectedScreens', 'count.scope.affected', `${src} → distinct pages whose own part of a walk meets one`,
        { bizUnit: 'count.unit.affectedScreens', breakdown: byDistance([...screenHop.values()]) }),
      gates: counted(gateList.length, 'count.unit.affectedGates', 'count.scope.affected', `${src} → gates and rules on an action that runs changed code, or changed`, {
        bizUnit: 'count.unit.affectedGates',
        breakdown: [{ key: 'count.part.gateChanged', n: gateList.filter((g) => g.changed).length }, { key: 'count.part.gateOnPath', n: gateList.filter((g) => !g.changed).length }],
      }),
      writes: counted(writeList.length, 'count.unit.affectedWrites', 'count.scope.affected', `${src} → (record, writer) pairs written on the changed path`, { bizUnit: 'count.unit.affectedWrites' }),
      contracts: counted(contractList.length, 'count.unit.affectedContracts', 'count.scope.affected', `${src} → route nodes on the changed path, or changed`, {
        breakdown: [{ key: 'count.part.gateChanged', n: contractList.filter((c) => c.changed).length }, { key: 'count.part.gateOnPath', n: contractList.filter((c) => !c.changed).length }],
      }),
      tests: counted(tests.length, 'count.unit.affectedCases', 'count.scope.affected', `${src} → distinct cases reaching a changed part (hop 0) or what uses it`, {
        bizUnit: 'count.unit.affectedCases',
        breakdown: facts.verdict.runs.breakdown,
      }),
    },
    bound: floor ? 'floor' : 'exact',
    notes,
  };
}
