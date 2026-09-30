/**
 * Dependency impact — **what uses this node, by distance**, with the weakest
 * recorded resolution on each path showing.
 * docs/proposals/dependency-impact.md §3.
 *
 * One fold over the graph that already exists. It answers per hop and **never
 * sums**: `ImpactReport` deliberately carries no total, because the single
 * number is what turned the question a product owner actually asks ("what
 * breaks if we change the invoices table?") into a 388-line haystack.
 *
 * What it may claim, and what it may not (§2), is a property of this file and
 * not of its printers:
 *  - *n things use this directly* — one edge, with its kind, its call site and
 *    its resolution.
 *  - *n more reach it through those* — a path of length >= 2, with the weakest
 *    recorded tier on it and how many of its edges recorded nothing.
 *  - *n more lie behind what I did not walk* — a cut point, with a reason.
 *
 * It must never say a change **propagates**: reachability is not consequence.
 * The verb belongs to the edge (`reads` / `writes` / `calls` / `guards` /
 * `renders` / `http` / `publishes` / `consumes`), and nothing here promotes it
 * to *breaks* or *is affected by*. Field-level data flow (which columns of an
 * entity really travel to a third party) is a different pass, and this one
 * does not approximate it with call reachability.
 */
import type { ConfidenceTier, EdgeKind, EdgeResolution, GraphEdge, GraphNode, Loc, TestRef } from './graph.js';
import { type GraphIndex, isDeclaredOnly, journey, journeySummary, repoOf } from './query.js';
import { screensFor } from './design.js';
import { isCoverable, isPresentational, testsCovering, type CoveringTest } from './metrics.js';
import { toCoverageRef, type CoverageTestRef } from './coverage.js';
import type { TestsMatrixIdentity } from './tests.js';

/**
 * Which way the question runs. `upstream` = what uses this (the default, and
 * the only direction a business sentence is written for); `downstream` = what
 * this uses, which `journey()` answers *in order* and this answers as a set.
 */
export type ImpactDirection = 'upstream' | 'downstream';

/** Past this, "reaches it through four others" describes the application, not a dependency (§8). */
export const IMPACT_MAX_HOPS = 5;

export interface ImpactOptions {
  /** default 2. 0 is not a question and more than IMPACT_MAX_HOPS is refused — both throw. */
  hops?: number;
  direction?: ImpactDirection;
  /** the boot is not a dependent: `meta.origin: 'setup'` edges are reported apart (default false) */
  includeSetup?: boolean;
  /** later work is reported apart, never summed with request-time work (default false) */
  includeDeferred?: boolean;
  /** open plumbing and rendered primitives instead of stopping at them (default false) */
  expandShared?: boolean;
  /** attach the covering tests of every listed node */
  tests?: boolean;
  /** attach the journeys and actions every listed node appears in — one journey walk per flow */
  flows?: boolean;
  /** default 50; overflow becomes a `cap` cut point, never a silent drop */
  perHopCap?: number;
  /**
   * What the caller knows about the graph's provenance. `digestMatches: false`
   * makes the answer a floor on its own: impact over a stale graph is the one
   * place a wrong answer costs a missed regression (§8).
   */
  asOf?: { sync?: number; commit?: string; farsight?: string; digestMatches?: boolean };
}

/** The edge that reached a dependent, kept whole so a consumer never re-derives it. */
export interface ImpactEdgeRef {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  /** the call site: the file of the node that wrote the edge, at the line the adapter stamped */
  loc?: Loc;
  /** absent === the adapter recorded no technique for this edge — a state, never a tier (§3.4) */
  resolution?: EdgeResolution;
  deferred?: true;
  origin?: 'setup';
}

/**
 * How well the path from the seed is known. Deliberately a **pair**, not a
 * ladder: `tier` is the weakest tier actually recorded on the path (`null`
 * when nothing on it recorded one) and `unstamped` counts the edges that
 * recorded nothing.
 *
 * Collapsing the two would invent knowledge (§10.2). "Records nothing" ranges
 * from a call to a function literal written in place (certain, and no
 * technique names it) to a guard a route inherited from its handler — it is an
 * absence of provenance about the edge, not an absence of the edge, and never
 * a confidence level.
 */
export interface PathStrength {
  tier: ConfidenceTier | null;
  unstamped: number;
  /** the length of the path this strength describes — equal to the node's `hop` (see `impactOf`) */
  hops: number;
}

export interface ImpactNode {
  nodeId: string;
  name: string;
  kind: GraphNode['kind'];
  loc?: Loc;
  repo: string;
  group?: string;
  /** fewest edges from the seed, within the budget */
  hop: number;
  /** the last edge of the best-known shortest path */
  via: ImpactEdgeRef;
  /** seed ... this, the best-known shortest path, node ids */
  path: string[];
  strength: PathStrength;
  /**
   * The `via` edge resolved a call site to one implementer and set others
   * aside: the code picks at run time, so this dependent is **one of
   * several**. Never folded away and never counted as a certainty.
   */
  oneOf?: { chosen: string; alternatives: string[] };
  /** `opts.tests` — what covers this node, strongest evidence first */
  tests?: CoverageTestRef[];
  /** `opts.flows` — the journeys this node appears in, and the actions inside them */
  flows?: ImpactFlowRef[];
  /** the node is `plumbing` or a rendered primitive: it is listed, and not expanded (§3.3) */
  shared?: true;
  /** a route whose only evidence is a contract: *not built*, so nothing runs it and no test can */
  declaredOnly?: true;
}

export interface ImpactFlowRef {
  flowId: string;
  name: string;
  actions: { screen: string; label: string; rank: number }[];
}

export type ImpactCutReason =
  | 'hops' //     the budget ended here
  | 'shared' //   plumbing or a rendered primitive: expanding it reports the application
  | 'setup' //    meta.origin === 'setup' — the boot is not a dependent
  | 'deferred' // meta.deferred — later work, reported apart
  | 'cap'; //     more dependents at this hop than perHopCap

/** Frozen with the contract: `farsight-impact-tests v1` prints these words. */
export const IMPACT_CUT_REASONS: readonly ImpactCutReason[] = ['hops', 'shared', 'setup', 'deferred', 'cap'];

export interface ImpactCut {
  reason: ImpactCutReason;
  /**
   * The node the walk stopped at. Absent for `cap`, which is a fact about a
   * **hop** and not about any one node.
   */
  nodeId?: string;
  name?: string;
  /**
   * How many further nodes sit behind this stop — everything upstream of it
   * the report does not already list; for `cap`, the dependents at this hop
   * that were not listed.
   *
   * **Never add two `behind` counts.** Two cut points routinely sit in front
   * of the same ancestors, so the sets overlap; each number answers "how much
   * more is behind *this* one", which is the question a reader asks.
   */
  behind: number;
  /**
   * The first ring only: unlisted nodes one edge behind this stop. `cx is
   * shared by 39` is this number; `everything behind cx` is `behind`. They are
   * different questions and a surface that prints one must not label it with
   * the other's words.
   */
  direct: number;
  hop: number;
}

/** One distance from the seed. `found` is what was discovered here; `nodes` is what is listed. */
export interface ImpactHop {
  hop: number;
  nodes: ImpactNode[];
  /** dependents discovered at this hop — equals `nodes.length` unless `perHopCap` cut it */
  found: number;
  /** every found dependent by kind and by repo, so a capped hop still says what it holds */
  byKind: Record<string, number>;
  byRepo: Record<string, number>;
}

export interface ImpactReport {
  seed: { id: string; name: string; kind: GraphNode['kind']; loc?: Loc; repo: string };
  direction: ImpactDirection;
  /**
   * One entry per hop, in order. There is deliberately **no total**: the type
   * cannot carry the number the brief says never to print.
   */
  hops: ImpactHop[];
  /** reached only across an edge the walk does not cross — named, never summed into a hop */
  excluded: { setup: ImpactNode[]; deferred: ImpactNode[] };
  cutPoints: ImpactCut[];
  /**
   * `floor` whenever anything was cut, capped, unstamped or `oneOf` — which on
   * today's graphs is always. `exact` is reachable only over a fully stamped,
   * uncut, unambiguous neighbourhood of a graph whose digest still matches the
   * checkout. Same vocabulary as `MetricValue`, on purpose.
   */
  bound: 'exact' | 'floor';
  uncertainty?: { note: string; affects: string[] };
  asOf: { sync?: number; commit?: string; farsight?: string; generatedAt: string };
}

const TIER_RANK: Record<ConfidenceTier, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/** The weaker of two recorded tiers; a path with nothing recorded keeps `null`. */
function weaker(a: ConfidenceTier | null, b: ConfidenceTier | null): ConfidenceTier | null {
  if (a === null) return b;
  if (b === null) return a;
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

interface Cand {
  tier: ConfidenceTier | null;
  unstamped: number;
  path: string[];
  via: GraphEdge;
}

/**
 * Which of two equally short paths to report — the widest-path rule (§3.2):
 * **the best of the weakest links**, because one well-recorded path means the
 * dependency is well recorded. Ties break toward fewer edges that recorded
 * nothing, then toward the path that sorts first, so the same graph always
 * produces the same answer.
 *
 * A path with no recorded tier at all loses to one that recorded something.
 * That is a choice about **which path to show**, never a claim that an
 * unrecorded edge is weaker than a `name-match` one — the pair is carried
 * whole (`{tier, unstamped}`) so a reader judges the edges and not a ladder.
 */
function better(a: Cand, b: Cand): Cand {
  const ta = a.tier ? TIER_RANK[a.tier] : 0;
  const tb = b.tier ? TIER_RANK[b.tier] : 0;
  if (ta !== tb) return ta > tb ? a : b;
  if (a.unstamped !== b.unstamped) return a.unstamped < b.unstamped ? a : b;
  const ja = a.path.join(' '), jb = b.path.join(' ');
  return ja <= jb ? a : b;
}

const isSetupEdge = (e: GraphEdge): boolean => e.meta?.origin === 'setup';
const isDeferredEdge = (e: GraphEdge): boolean => e.meta?.deferred === true;

/**
 * A node whose expansion would report the application rather than a
 * dependency: anything tagged `plumbing` (`farsight.config.json` -> plumbing)
 * or a rendered UI primitive.
 *
 * This reuses **the one coverable predicate**'s halves rather than inventing a
 * hub heuristic: the nodes a coverage denominator already excludes are exactly
 * the ones whose expansion destroys an impact answer. The ten highest-in-degree
 * nodes on the reference app are that set (`cx`, `getContainer`, `handle`, `apiInit`,
 * `Button`, `json`, `readJson`, `Card`, `StatusChip`, `requireContractorSession`).
 */
export function isSharedNode(index: GraphIndex, n: GraphNode): boolean {
  return (n.tags ?? []).includes('plumbing') || isPresentational(index, n);
}

function edgeRef(e: GraphEdge): ImpactEdgeRef {
  return {
    id: e.id, kind: e.kind, from: e.from, to: e.to,
    ...(e.resolution ? { resolution: e.resolution } : {}),
    ...(isDeferredEdge(e) ? { deferred: true as const } : {}),
    ...(isSetupEdge(e) ? { origin: 'setup' as const } : {}),
  };
}

/** Where the edge is written: the file of the node that made it, at the line the adapter stamped. */
function callSite(index: GraphIndex, e: GraphEdge): Loc | undefined {
  const writer = index.byId.get(e.from);
  if (!writer?.loc) return undefined;
  const line = typeof e.meta?.line === 'number' ? e.meta.line : undefined;
  return line != null ? { ...writer.loc, line } : writer.loc;
}

/**
 * The fold. Breadth-first over the in-edges (upstream) or out-edges
 * (downstream) of the seed, layer by layer, at most `hops` layers, with four
 * differences from `trace()` that are the whole point:
 *
 * 1. **`covers` edges are never followed.** A test is evidence about a node,
 *    not a dependent of it — 130 of the 395 nodes in today's `trace_flow`
 *    answer are test nodes. Tests reach an impact answer through `opts.tests`.
 *    `tracks` is never followed either, for the same reason: a work item is a
 *    fact about the code it names, never something that calls it.
 * 2. **Layers are kept.** `hop` is the fewest edges from the seed.
 * 3. **`strength` is relaxed, not a by-product of the first path found.** A
 *    node reached by several paths of the same length takes the best of the
 *    weakest links (`better`).
 * 4. **Every stop is named** — nothing is dropped silently.
 *
 * The relaxation runs over **shortest** paths only, which narrows §3.2's "a
 * node may be reached by several paths": the strength has to evidence the
 * claim being made, and the claim is the hop. A well-recorded three-hop route
 * does not make a direct dependency better recorded, and printing its tier
 * beside *uses it directly* would be the same fault this design exists to end.
 * `strength.hops` therefore equals `hop`; it is kept on the pair because a
 * consumer that has a `PathStrength` and no `ImpactNode` still needs it.
 */
export function impactOf(index: GraphIndex, id: string, opts: ImpactOptions = {}): ImpactReport {
  const seed = index.byId.get(id);
  // no made-up answers: an id this graph does not hold has no impact of any size
  if (!seed) throw new Error(`impactOf: no node with id ${JSON.stringify(id)} in this graph`);
  const hopBudget = opts.hops ?? 2;
  if (!Number.isInteger(hopBudget) || hopBudget < 1) {
    throw new RangeError(`impactOf: hops must be a whole number of at least 1 — 0 hops asks nothing (got ${String(opts.hops)})`);
  }
  if (hopBudget > IMPACT_MAX_HOPS) {
    throw new RangeError(`impactOf: ${hopBudget} hops is refused — past ${IMPACT_MAX_HOPS} hops, "reaches it through others" describes the application rather than a dependency (docs/proposals/dependency-impact.md §8)`);
  }
  const direction: ImpactDirection = opts.direction ?? 'upstream';
  const perHopCap = opts.perHopCap ?? 50;
  const skipSetup = !opts.includeSetup;
  const skipDeferred = !opts.includeDeferred;

  const neighbours = (nodeId: string): GraphEdge[] =>
    (direction === 'upstream' ? index.in.get(nodeId) : index.out.get(nodeId)) ?? [];
  const otherEnd = (e: GraphEdge): string => (direction === 'upstream' ? e.from : e.to);

  const best = new Map<string, Cand>();     // node id -> best-known shortest path
  const hopOf = new Map<string, number>();  // node id -> fewest edges from the seed
  const skipped: { edge: GraphEdge; hop: number; reason: 'setup' | 'deferred' }[] = [];
  const hops: ImpactHop[] = [];
  const cutPoints: ImpactCut[] = [];
  const cappedAtHop = new Map<number, number>();

  let frontier: string[] = [seed.id];
  for (let h = 1; h <= hopBudget && frontier.length; h++) {
    const layer: string[] = [];
    for (const u of frontier) {
      const parent: Cand | undefined = u === seed.id ? undefined : best.get(u);
      for (const e of neighbours(u)) {
        // a test is evidence about a node, not a dependent of it
        if (e.kind === 'covers' || e.kind === 'tracks') continue;
        if (skipSetup && isSetupEdge(e)) { skipped.push({ edge: e, hop: h, reason: 'setup' }); continue; }
        if (skipDeferred && isDeferredEdge(e)) { skipped.push({ edge: e, hop: h, reason: 'deferred' }); continue; }
        const other = otherEnd(e);
        if (other === seed.id || !index.byId.has(other)) continue;
        const known = hopOf.get(other);
        if (known != null && known < h) continue;  // already answered at a shorter distance
        const cand: Cand = {
          tier: weaker(parent?.tier ?? null, e.resolution?.confidence ?? null),
          unstamped: (parent?.unstamped ?? 0) + (e.resolution ? 0 : 1),
          path: [...(parent?.path ?? [seed.id]), other],
          via: e,
        };
        if (known == null) {
          hopOf.set(other, h);
          best.set(other, cand);
          layer.push(other);
        } else {
          best.set(other, better(best.get(other)!, cand));
        }
      }
    }

    if (!layer.length) break;
    const found = layer.map((nid) => index.byId.get(nid)!);
    found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const byKind: Record<string, number> = {};
    const byRepo: Record<string, number> = {};
    for (const n of found) {
      byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
      const r = repoOf(n);
      byRepo[r] = (byRepo[r] ?? 0) + 1;
    }
    const listed = found.length > perHopCap ? found.slice(0, perHopCap) : found;
    if (found.length > perHopCap) cappedAtHop.set(h, found.length - perHopCap);

    const nodes: ImpactNode[] = listed.map((n) => {
      const cand = best.get(n.id)!;
      const chosenId = cand.via.to;
      const alternatives = (cand.via.resolution?.alternatives ?? [])
        .map((aid) => index.byId.get(aid)?.name ?? aid.split('::').pop() ?? aid)
        .filter((nm) => nm !== index.byId.get(chosenId)?.name);
      const shared = isSharedNode(index, n);
      const site = callSite(index, cand.via);
      return {
        nodeId: n.id, name: n.name, kind: n.kind, repo: repoOf(n),
        ...(n.loc ? { loc: n.loc } : {}),
        ...(n.group ? { group: n.group } : {}),
        hop: h,
        via: { ...edgeRef(cand.via), ...(site ? { loc: site } : {}) },
        path: cand.path,
        strength: { tier: cand.tier, unstamped: cand.unstamped, hops: cand.path.length - 1 },
        ...(alternatives.length
          ? { oneOf: { chosen: index.byId.get(chosenId)?.name ?? chosenId, alternatives } }
          : {}),
        ...(shared ? { shared: true as const } : {}),
        ...(isDeclaredOnly(n) ? { declaredOnly: true as const } : {}),
      };
    });
    hops.push({ hop: h, nodes, found: found.length, byKind, byRepo });
    // a capped node is not listed, so it is not expanded either: what lies behind
    // the whole overflow is the `cap` cut's count
    frontier = nodes.filter((n) => opts.expandShared || !n.shared).map((n) => n.nodeId);
  }

  // what was not walked
  const reported = new Set<string>([seed.id, ...hops.flatMap((hp) => hp.nodes.map((n) => n.nodeId))]);
  const rules = { direction, skipSetup, skipDeferred, expandShared: !!opts.expandShared };
  const behind = (from: string): { behind: number; direct: number } => behindCount(index, from, rules, reported, seed.id);

  for (const hp of hops) {
    for (const n of hp.nodes) {
      const reason: ImpactCutReason | null =
        n.shared && !opts.expandShared ? 'shared' : hp.hop === hopBudget ? 'hops' : null;
      if (!reason) continue;
      const b = behind(n.nodeId);
      // a stop with nothing new behind it stopped nothing
      if (b.behind > 0) cutPoints.push({ reason, nodeId: n.nodeId, name: n.name, behind: b.behind, direct: b.direct, hop: n.hop });
    }
    const capped = cappedAtHop.get(hp.hop);
    // the overflow is the fact: every one of them is a dependent this hop found and did not list
    if (capped) cutPoints.push({ reason: 'cap', behind: capped, direct: capped, hop: hp.hop });
  }

  const excluded: ImpactReport['excluded'] = { setup: [], deferred: [] };
  const seenExcluded = new Set<string>();
  for (const sk of skipped) {
    const other = otherEnd(sk.edge);
    // a node the walk also reached on a path of its own is a dependent, not an aside
    if (reported.has(other) || seenExcluded.has(other) || !index.byId.has(other)) continue;
    const n = index.byId.get(other)!;
    seenExcluded.add(other);
    const parentId = direction === 'upstream' ? sk.edge.to : sk.edge.from;
    const parent = parentId === seed.id ? undefined : best.get(parentId);
    const site = callSite(index, sk.edge);
    excluded[sk.reason].push({
      nodeId: n.id, name: n.name, kind: n.kind, repo: repoOf(n),
      ...(n.loc ? { loc: n.loc } : {}),
      ...(n.group ? { group: n.group } : {}),
      hop: sk.hop,
      via: { ...edgeRef(sk.edge), ...(site ? { loc: site } : {}) },
      path: [...(parent?.path ?? [seed.id]), n.id],
      strength: {
        tier: weaker(parent?.tier ?? null, sk.edge.resolution?.confidence ?? null),
        unstamped: (parent?.unstamped ?? 0) + (sk.edge.resolution ? 0 : 1),
        hops: sk.hop,
      },
    });
  }
  for (const kind of ['setup', 'deferred'] as const) {
    excluded[kind].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const n of excluded[kind]) {
      const b = behind(n.nodeId);
      cutPoints.push({ reason: kind, nodeId: n.nodeId, name: n.name, behind: b.behind, direct: b.direct, hop: n.hop });
    }
  }

  // attachments
  if (opts.tests) {
    for (const hp of hops) {
      for (const n of hp.nodes) {
        const node = index.byId.get(n.nodeId);
        n.tests = testsCovering(index, n.nodeId).map((t) => toCoverageRef(index, t, node));
      }
    }
  }
  if (opts.flows) {
    const byNode = flowActions(index);
    for (const hp of hops) {
      for (const n of hp.nodes) {
        const rows = byNode.get(n.nodeId);
        if (rows?.length) n.flows = rows;
      }
    }
  }

  // the bound
  const listedNodes = hops.flatMap((hp) => hp.nodes);
  const unstampedNodes = listedNodes.filter((n) => n.strength.unstamped > 0);
  const ambiguous = listedNodes.filter((n) => n.oneOf);
  const staleDigest = opts.asOf?.digestMatches === false;
  const bound: ImpactReport['bound'] =
    cutPoints.length || unstampedNodes.length || ambiguous.length || staleDigest ? 'floor' : 'exact';

  let uncertainty: ImpactReport['uncertainty'];
  if (bound === 'floor') {
    const why: string[] = [];
    if (staleDigest) why.push('this graph no longer matches the checkout it was read from');
    if (cutPoints.length) {
      const per = new Map<ImpactCutReason, number>();
      for (const c of cutPoints) per.set(c.reason, (per.get(c.reason) ?? 0) + 1);
      // Name what each tally counts. `${n} ${r}` rendered a tally of cut points as
      // "14 hops", which reads as a hop count rather than "14 places the hop budget
      // stopped the walk" (found by the chunk that put this sentence on three surfaces).
      const CUT_PHRASE: Record<string, string> = {
        hops: 'reached the hop budget',
        cap: 'were over the cap',
        shared: 'are shared and were listed but not opened',
        setup: 'run once at start-up',
        deferred: 'run later, not on this path',
      };
      why.push(`something was not walked (${[...per]
        .map(([r, n]) => `${n} ${CUT_PHRASE[r] ?? String(r)}`)
        .join('; ')})`);
    }
    if (unstampedNodes.length) {
      why.push(unstampedNodes.length === listedNodes.length
        ? 'no edge on any of these paths records how it was resolved'
        : `${unstampedNodes.length} of these paths cross an edge that records nothing about how it was resolved`);
    }
    if (ambiguous.length) why.push(`${ambiguous.length} reach it through a call the code resolves at run time`);
    uncertainty = {
      note: `${why.join('; ')} — so every count here is a floor`,
      affects: [
        ...cutPoints.map((c) => c.nodeId).filter((x): x is string => !!x),
        ...unstampedNodes.map((n) => n.nodeId),
        ...ambiguous.map((n) => n.nodeId),
      ].filter((v, i, a) => a.indexOf(v) === i),
    };
  }

  return {
    seed: { id: seed.id, name: seed.name, kind: seed.kind, repo: repoOf(seed), ...(seed.loc ? { loc: seed.loc } : {}) },
    direction,
    hops,
    excluded,
    cutPoints,
    bound,
    ...(uncertainty ? { uncertainty } : {}),
    asOf: {
      ...(opts.asOf?.sync != null ? { sync: opts.asOf.sync } : {}),
      ...(opts.asOf?.commit ? { commit: opts.asOf.commit } : {}),
      ...(opts.asOf?.farsight ? { farsight: opts.asOf.farsight } : {}),
      generatedAt: new Date().toISOString(),
    },
  };
}

/**
 * The tests that reach everything listed from hop 1 up to `upto`, **each test
 * counted once** — the union of the covering sets, never a sum of per-hop
 * counts. A test that covers a node at hop 1 and another at hop 3 is one test
 * here at every distance from 1 on, so the number can only stay level or grow
 * as `upto` grows: that is what makes *so far* true.
 *
 * It is the one fold behind every printed "tests reaching hop 1–N" — the CLI,
 * the MCP and the viewer (which mirrors it in `impact.js` `impTestsReaching`,
 * held to this function by packages/server/test/impact-view.test.ts). Needs a
 * report asked for with `tests: true`; without it every count is zero.
 *
 * This is a set of tests, not of dependents: the report still carries no total
 * of what uses the seed, and nothing here adds two hops' `found`.
 */
export interface ImpactTestsReaching {
  /** the hop this union runs up to (inclusive) */
  upto: number;
  /** distinct tests over hops 1..upto */
  total: number;
  /** that union by test level — the parts sum to `total` */
  byLevel: Record<string, number>;
  /** that union by evidence class — the parts sum to `total` */
  byEvidence: Record<string, number>;
  /** the tests themselves, strongest evidence first as the nodes listed them */
  tests: CoverageTestRef[];
}

export function impactTestsReaching(report: ImpactReport, upto: number): ImpactTestsReaching {
  const seen = new Map<string, CoverageTestRef>();
  for (const h of report.hops) {
    if (h.hop > upto) break;
    for (const n of h.nodes) for (const t of n.tests ?? []) if (!seen.has(t.id)) seen.set(t.id, t);
  }
  const tests = [...seen.values()];
  const tally = (key: (t: CoverageTestRef) => string): Record<string, number> =>
    tests.reduce<Record<string, number>>((a, t) => { const k = key(t); a[k] = (a[k] ?? 0) + 1; return a; }, {});
  return { upto, total: tests.length, byLevel: tally((t) => t.level), byEvidence: tally((t) => t.evidence), tests };
}

/**
 * How many further nodes sit behind a stop — what a reader would see if the
 * budget were unbounded, minus what the report already lists.
 *
 * It follows the same rules the walk would have: `covers` is never crossed,
 * the boot and deferred work stay out unless the caller asked for them, and a
 * shared node is counted where it was met and not opened.
 */
function behindCount(
  index: GraphIndex,
  from: string,
  rules: { direction: ImpactDirection; skipSetup: boolean; skipDeferred: boolean; expandShared: boolean },
  reported: Set<string>,
  seedId: string,
): { behind: number; direct: number } {
  const seen = new Set<string>([from]);
  let frontier = [from];
  let n = 0;
  let direct = 0;
  let ring = 0;
  while (frontier.length) {
    ring++;
    const next: string[] = [];
    for (const u of frontier) {
      const around = (rules.direction === 'upstream' ? index.in.get(u) : index.out.get(u)) ?? [];
      for (const e of around) {
        if (e.kind === 'covers' || e.kind === 'tracks') continue;
        if (rules.skipSetup && isSetupEdge(e)) continue;
        if (rules.skipDeferred && isDeferredEdge(e)) continue;
        const other = rules.direction === 'upstream' ? e.from : e.to;
        if (other === seedId || seen.has(other)) continue;
        const node = index.byId.get(other);
        if (!node) continue;
        seen.add(other);
        if (!reported.has(other)) { n++; if (ring === 1) direct++; }
        if (rules.expandShared || !isSharedNode(index, node)) next.push(other);
      }
    }
    frontier = next;
  }
  return { behind: n, direct };
}

/**
 * Every node of every journey, with the flow and the actions it appears in —
 * one `journey()` + `journeySummary()` walk per `flow` node, which is why it
 * sits behind `opts.flows`.
 *
 * An *action* is a moment of a segment: one client-side action and everything
 * it caused. The same node in two actions is two rows, because "in 19 actions"
 * counts places a person can point at, not nodes.
 */
export function flowActions(index: GraphIndex): Map<string, ImpactFlowRef[]> {
  const out = new Map<string, ImpactFlowRef[]>();
  for (const flow of index.byId.values()) {
    if (flow.kind !== 'flow') continue;
    let sum;
    try {
      sum = journeySummary(index, journey(index, flow.id), screensFor(index, flow.id));
    } catch {
      continue; // a flow that cannot be walked contributes nothing, and claims nothing
    }
    const perNode = new Map<string, { screen: string; label: string; rank: number }[]>();
    for (const seg of sum.segments) {
      const screen = seg.screen?.name ?? '';
      for (const m of seg.markers) {
        const moment = seg.moments[m.moment];
        if (!moment) continue;
        const ids = m.choice ? m.choice.candidates.map((c) => c.nodeId) : [m.nodeId];
        for (const nid of ids) {
          const rows = perNode.get(nid) ?? [];
          if (!rows.some((r) => r.screen === screen && r.label === moment.label)) {
            rows.push({ screen, label: moment.label, rank: moment.rank });
          }
          perNode.set(nid, rows);
        }
      }
    }
    for (const [nid, actions] of perNode) {
      const rows = out.get(nid) ?? [];
      rows.push({ flowId: flow.id, name: flow.name, actions });
      out.set(nid, rows);
    }
  }
  return out;
}

/** One changed range, `path` or `path:line` or `path:from-to`, resolved to the nodes defined inside it. */
export interface HunkSeed { node: GraphNode; hunk: string }

/**
 * Changed file ranges → the nodes whose definition **starts** inside them, at
 * file-and-line granularity. The graph records no end line, so a hunk in the
 * middle of a long function names nothing: the answer is a floor, and a
 * consumer says so. A path matches when either side is a suffix of the other
 * (`./src/a.ts`, `src/a.ts` and `repo/src/a.ts` all reach `src/a.ts`).
 *
 * One rule, read by `farsight impact --changed` and MCP `impact_of changed:`,
 * so a CI job and an agent resolve the same diff to the same seeds.
 */
export function nodesInHunks(nodes: Iterable<GraphNode>, specs: string[]): { seeds: HunkSeed[]; unmatched: string[] } {
  const all = [...nodes];
  const seeds: HunkSeed[] = [];
  const unmatched: string[] = [];
  for (const spec of specs) {
    const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(spec);
    const path = (m?.[1] ?? spec).replace(/^\.\//, '');
    const from = m ? Number(m[2]) : undefined;
    const to = m ? Number(m[3] ?? m[2]) : undefined;
    const hit = all.filter((n) => n.loc && (n.loc.path === path || n.loc.path.endsWith(`/${path}`) || path.endsWith(`/${n.loc.path}`))
      && (from == null || (n.loc.line >= from && n.loc.line <= to!)));
    if (!hit.length) { unmatched.push(spec); continue; }
    for (const n of hit) seeds.push({ node: n, hunk: m ? `${path}:${from}-${to}` : path });
  }
  return { seeds, unmatched };
}

// ── farsight-impact-tests v1 ───────────────────────────────────────────────
// The machine-readable half: which tests a CI job can run for a change, and
// when it must not trust the list. Prose contract:
// docs/contracts/farsight-impact-tests-v1.md · schema:
// schemas/farsight-impact-tests-v1.schema.json.

/**
 * Why a node of the answer has no test a job could name and run. Closed: a
 * consumer switches on these four words, so v1 may add a member and never
 * repurposes one.
 *
 * `run-level only` exists because of a measured fact, not a hypothetical: a
 * coverage report proves a run reached the code, and cannot name a case to
 * re-run. Selecting nothing for such a node would be a silent under-run.
 */
export type ImpactUnselectableReason = 'no covers edge' | 'declared only' | 'inactive' | 'run-level only';

export const IMPACT_UNSELECTABLE_REASONS: readonly ImpactUnselectableReason[] =
  ['no covers edge', 'declared only', 'inactive', 'run-level only'];

/** The printed evidence vocabulary — the graph stores `static`, every consumer reads *reached*. */
export type ImpactEvidenceClass = 'declared' | 'reached' | 'observed';

export interface ImpactTestsSeed {
  id: string;
  name: string;
  kind: GraphNode['kind'];
  /** `node` = a node was named; `hunk` = a changed file range resolved to it */
  from: 'node' | 'hunk';
  /** `path:line-line`, when the seed came from a diff */
  hunk?: string;
}

export interface ImpactTestsRef {
  id: string;
  title: string;
  file: string;
  /** `null` for a run-level node: a report has no line */
  line: number | null;
  level: TestRef['level'];
  runner: TestRef['runner'];
  /** `''` when the runner records none */
  project: string;
  evidence_class: ImpactEvidenceClass;
  technique: string | null;
  confidence: ConfidenceTier | null;
  /** the edge came from a coverage report with no per-test attribution */
  run_level: boolean;
  /** `.skip`/`.todo`: listed, and it lifts nothing */
  inactive: boolean;
}

export interface ImpactTestsNode {
  id: string;
  name: string;
  kind: GraphNode['kind'];
  file: string;
  line: number | null;
  /** the edge that reached it, and how it was resolved — `null` where nothing was recorded */
  edge: { kind: EdgeKind; technique: string | null; confidence: ConfidenceTier | null };
  strength: { tier: ConfidenceTier | null; unstamped: number; hops: number };
  one_of: { chosen: string; alternatives: string[] } | null;
  tests: ImpactTestsRef[];
}

export interface ImpactTestsSelectEntry { file: string; title: string; project: string }

export interface ImpactTestsV1 {
  schema: 'farsight-impact-tests v1';
  /** the `farsight-tests-matrix v1` identity block, verbatim */
  identity: TestsMatrixIdentity;
  seeds: ImpactTestsSeed[];
  hops: { hop: number; nodes: ImpactTestsNode[] }[];
  /** one key per runner seen (`vitest`, `playwright`, …) — a runner this graph has none of has no key */
  select: Record<string, ImpactTestsSelectEntry[]>;
  unselectable: { node: string; name: string; reason: ImpactUnselectableReason }[];
  /** `"run-all"` or `null`; never implied, never omitted */
  fallback: 'run-all' | null;
  /** the sentence behind `fallback` — `null` when there is none */
  fallback_reason: string | null;
  excluded: { setup: string[]; deferred: string[] };
  cut: { reason: ImpactCutReason; node?: string; name?: string; behind: number; direct: number; hop: number }[];
  /**
   * `floor` from the reports. **`select` is a floor too when this says so**: a
   * selection computed over a cut, unstamped or ambiguous neighbourhood is not
   * a complete set, and a CI job may not treat it as one.
   */
  bound: 'exact' | 'floor';
}

export interface ImpactTestsInput {
  report: ImpactReport;
  from?: 'node' | 'hunk';
  hunk?: string;
}

const EVIDENCE: Record<CoveringTest['evidence'], ImpactEvidenceClass> =
  { declared: 'declared', static: 'reached', observed: 'observed' };

function testRefs(index: GraphIndex, nodeId: string): ImpactTestsRef[] {
  return testsCovering(index, nodeId).map((t) => ({
    id: t.id,
    title: t.name,
    file: t.loc?.path ?? '',
    line: t.runLevel ? null : t.loc?.line ?? null,
    level: t.level,
    runner: t.runner,
    project: t.project ?? '',
    evidence_class: EVIDENCE[t.evidence],
    technique: t.technique ?? null,
    confidence: t.confidence ?? null,
    run_level: t.runLevel,
    inactive: !!t.inactive,
  }));
}

/** A test a job can actually name and run: an active case, with a file, that is not a whole-run report. */
const runnable = (t: ImpactTestsRef): boolean => !t.run_level && !t.inactive && !!t.file;

/**
 * Why this node yields nothing to run, or `null` when it does — and `null`
 * also for a node **no test could cover**: the gate asks whether a testable
 * thing is tested, and a table, a queue or a third party is not one. That is
 * the one coverable predicate, reused, so the gate and the coverage
 * denominator cannot disagree about what counts as a gap.
 *
 * The order is the order a reader would say them in: a route that is not
 * built cannot be tested at all; then no evidence; then evidence that names no
 * case to re-run.
 */
function unselectableReason(index: GraphIndex, node: GraphNode | undefined, tests: ImpactTestsRef[]): ImpactUnselectableReason | null {
  if (node && isDeclaredOnly(node)) return 'declared only';
  if (!node || !isCoverable(index, node)) return null;
  if (!tests.length) return 'no covers edge';
  if (tests.some(runnable)) return null;
  if (tests.every((t) => t.run_level)) return 'run-level only';
  if (tests.every((t) => t.inactive || t.run_level)) return 'inactive';
  return 'run-level only';
}

/**
 * The CI document: one or more impact reports folded into the frozen envelope.
 *
 * Several seeds fold into **one** hop list — a node at hop 1 of one seed and
 * hop 2 of another is listed at hop 1, because the nearest claim is the one
 * that must be evidenced. The gate the SDET asked for is
 * `unselectable[] | length == 0`, computed over the seeds and their **direct**
 * dependents: it says every changed thing has at least one runnable test, and
 * nothing more.
 *
 * The tests are read from the graph here rather than taken from the reports,
 * so a caller who did not pass `tests: true` still gets a correct document.
 */
export function impactTestsV1(
  index: GraphIndex,
  inputs: ImpactTestsInput[],
  identity: TestsMatrixIdentity,
  opts: { digestMatches?: boolean } = {},
): ImpactTestsV1 {
  const seeds: ImpactTestsSeed[] = inputs.map(({ report, from, hunk }) => ({
    id: report.seed.id, name: report.seed.name, kind: report.seed.kind,
    from: from ?? 'node',
    ...(hunk ? { hunk } : {}),
  }));

  // one node, its nearest hop
  const at = new Map<string, { hop: number; n: ImpactNode }>();
  for (const { report } of inputs) {
    for (const hp of report.hops) {
      for (const n of hp.nodes) {
        const have = at.get(n.nodeId);
        if (!have || n.hop < have.hop) at.set(n.nodeId, { hop: n.hop, n });
      }
    }
  }
  const seedIds = new Set(seeds.map((s) => s.id));
  const testsOf = new Map<string, ImpactTestsRef[]>();
  const nodeRow = (n: ImpactNode): ImpactTestsNode => {
    const tests = testsOf.get(n.nodeId) ?? testRefs(index, n.nodeId);
    testsOf.set(n.nodeId, tests);
    return {
      id: n.nodeId, name: n.name, kind: n.kind,
      file: n.loc?.path ?? '', line: n.loc?.line ?? null,
      edge: {
        kind: n.via.kind,
        technique: n.via.resolution?.technique ?? null,
        confidence: n.via.resolution?.confidence ?? null,
      },
      strength: n.strength,
      one_of: n.oneOf ?? null,
      tests,
    };
  };

  const byHop = new Map<number, ImpactTestsNode[]>();
  for (const { hop, n } of at.values()) {
    if (seedIds.has(n.nodeId)) continue;      // a seed is not its own dependent
    const rows = byHop.get(hop) ?? [];
    rows.push(nodeRow(n));
    byHop.set(hop, rows);
  }
  const hops = [...byHop.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hop, nodes]) => ({ hop, nodes: nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) }));

  // what a job can run: every node in the document, and the seeds themselves
  const select: Record<string, ImpactTestsSelectEntry[]> = {};
  const seen = new Set<string>();
  const addSelect = (tests: ImpactTestsRef[]): void => {
    for (const t of tests) {
      if (!runnable(t)) continue;
      const key = `${t.runner}|${t.file}|${t.title}|${t.project}`;
      if (seen.has(key)) continue;
      seen.add(key);
      (select[t.runner] ??= []).push({ file: t.file, title: t.title, project: t.project });
    }
  };
  const seedTests = new Map<string, ImpactTestsRef[]>();
  for (const s of seeds) {
    const refs = testRefs(index, s.id);
    seedTests.set(s.id, refs);
    addSelect(refs);
  }
  for (const hp of hops) for (const n of hp.nodes) addSelect(n.tests);
  for (const rows of Object.values(select)) {
    rows.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  }

  // the gate: the seeds and their direct dependents
  const unselectable: ImpactTestsV1['unselectable'] = [];
  for (const s of seeds) {
    const reason = unselectableReason(index, index.byId.get(s.id), seedTests.get(s.id) ?? []);
    if (reason) unselectable.push({ node: s.id, name: s.name, reason });
  }
  for (const n of hops.find((h) => h.hop === 1)?.nodes ?? []) {
    const reason = unselectableReason(index, index.byId.get(n.id), n.tests);
    if (reason) unselectable.push({ node: n.id, name: n.name, reason });
  }

  const cut = inputs.flatMap(({ report }) => report.cutPoints.map((c) => ({
    reason: c.reason,
    ...(c.nodeId ? { node: c.nodeId } : {}),
    ...(c.name ? { name: c.name } : {}),
    behind: c.behind, direct: c.direct, hop: c.hop,
  })));
  const hopCutAtOne = cut.some((c) => c.reason === 'hops' && c.hop === 1);

  const why: string[] = [];
  if (unselectable.length) {
    why.push(`${unselectable.length} of the changed things and their direct dependents have no test a job could name and run`);
  }
  if (hopCutAtOne) why.push('the walk ended at hop 1, so the direct dependents are not all known');
  if (opts.digestMatches === false) why.push('this graph no longer matches the working tree');

  const uniq = (ids: string[]): string[] => [...new Set(ids)].sort();

  return {
    schema: 'farsight-impact-tests v1',
    identity,
    seeds,
    hops,
    select,
    unselectable,
    fallback: why.length ? 'run-all' : null,
    fallback_reason: why.length ? `run the whole suite: ${why.join('; ')}` : null,
    excluded: {
      setup: uniq(inputs.flatMap(({ report }) => report.excluded.setup.map((n) => n.nodeId))),
      deferred: uniq(inputs.flatMap(({ report }) => report.excluded.deferred.map((n) => n.nodeId))),
    },
    cut,
    bound: inputs.some(({ report }) => report.bound === 'floor') ? 'floor' : 'exact',
  };
}
