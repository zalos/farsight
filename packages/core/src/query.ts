import type { GraphNode, GraphEdge, BranchPoint, ExternalKind, ResolutionTechnique, ConfidenceTier, StoreKind } from './graph.js';
import { withJourneyCoverage, type JourneyCoverage } from './coverage.js';
import { withJourneyCounted, type JourneyCounted, type SegmentCounted, type SegmentAbsence, type AbsenceKind, type AbsenceWord } from './journey-counted.js';

/**
 * Graph queries shared by every consumer — GUI lenses, the CLI, and the MCP
 * server that feeds agents. Pure functions over node/edge arrays so they move
 * to the Rust engine unchanged in Phase 2.
 */

export interface Subgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphIndex {
  byId: Map<string, GraphNode>;
  out: Map<string, GraphEdge[]>;
  in: Map<string, GraphEdge[]>;
}

export function buildIndex(nodes: GraphNode[], edges: GraphEdge[]): GraphIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e);
    if (!incoming.has(e.to)) incoming.set(e.to, []);
    incoming.get(e.to)!.push(e);
  }
  return { byId, out, in: incoming };
}

export interface SearchOptions {
  kind?: string;
  tag?: string;
  /** limit to one source/repo name (the id prefix when a node has no loc) */
  repo?: string;
  /** limit to one logical group (`@group`) — keeps a flow on topic when names collide across scripts */
  group?: string;
  limit?: number;
}

/** The repo a node belongs to: its loc, else the id prefix (`repo::…`). */
export function repoOf(node: GraphNode): string {
  return node.loc?.repo ?? node.id.split('::')[0]!;
}

/** Rank nodes by match quality against name, tags, docs, and path. */
export function search(index: GraphIndex, query: string, options: SearchOptions = {}): GraphNode[] {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const scored: { node: GraphNode; score: number }[] = [];
  for (const node of index.byId.values()) {
    if (options.kind && node.kind !== options.kind) continue;
    if (options.tag && !node.tags.includes(options.tag)) continue;
    if (options.repo && repoOf(node) !== options.repo) continue;
    if (options.group && node.group !== options.group) continue;
    let score = 0;
    const name = node.name.toLowerCase();
    const label = node.facets?.business?.label?.toLowerCase();
    const hay = `${name} ${label ?? ''} ${node.tags.join(' ')} ${node.docs ?? ''} ${node.loc?.path ?? ''}`.toLowerCase();
    // the whole query is this node's name or business label: a person typed exactly what they see
    if (name === q || label === q) score += 20;
    for (const term of terms) {
      if (name === term) score += 10;
      else if (name.includes(term)) score += 5;
      else if (node.tags.some((t) => t.toLowerCase().includes(term))) score += 4;
      else if (hay.includes(term)) score += 1;
    }
    if (score > 0) scored.push({ node, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, options.limit ?? 20).map((s) => s.node);
}

const RUNNABLE = new Set<string>(['function', 'component', 'route', 'page', 'flow']);

/**
 * One entry node for a journey from what a person or agent typed: an exact
 * node id wins; otherwise the best-ranked runnable search hit (function,
 * component, route, page), else the best hit of any kind. Shared by the HUD's
 * /api/journey and the MCP `journey` tool so both accept names, not just ids.
 */
export function resolveEntry(index: GraphIndex, query: string, options: Pick<SearchOptions, 'repo' | 'group'> = {}): GraphNode | undefined {
  const direct = index.byId.get(query);
  if (direct) return direct;
  const hits = search(index, query, { ...options, limit: 10 });
  return hits.find((h) => RUNNABLE.has(h.kind)) ?? hits[0];
}

export type Direction = 'downstream' | 'upstream' | 'both';

/**
 * Edges a traversal must not cross. `impact_of` passes one so the boot
 * (`meta.origin: 'setup'`) and work that runs later on its own
 * (`meta.deferred`) are reported apart instead of swamping hop 1
 * (01 §2.3.8).
 */
export interface TraversalOptions {
  skip?: (edge: GraphEdge) => boolean;
}

/**
 * Bounded reachability from seed nodes — the slice behind "show me the
 * invoice process" and behind an agent's trace() call.
 */
export function trace(index: GraphIndex, seedIds: string[], direction: Direction = 'both', depth = 3, opts: TraversalOptions = {}): Subgraph {
  const nodeIds = new Set<string>(seedIds.filter((id) => index.byId.has(id)));
  const edgeSet = new Set<GraphEdge>();
  let frontier = [...nodeIds];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const around: GraphEdge[] = [
        ...(direction !== 'upstream' ? index.out.get(id) ?? [] : []),
        ...(direction !== 'downstream' ? index.in.get(id) ?? [] : []),
      ];
      for (const e of around) {
        if (opts.skip?.(e)) continue;
        edgeSet.add(e);
        for (const other of [e.from, e.to]) {
          if (!nodeIds.has(other) && index.byId.has(other)) {
            nodeIds.add(other);
            next.push(other);
          }
        }
      }
    }
    frontier = next;
  }
  return {
    nodes: [...nodeIds].map((id) => index.byId.get(id)!),
    edges: [...edgeSet],
  };
}

/**
 * Everything that (transitively) depends on a node — change-impact analysis.
 * The third argument is the depth, or the options when the caller only wants
 * to skip edges (`impact(index, id, { skip })`).
 */
export function impact(index: GraphIndex, id: string, depth: number | TraversalOptions = 10, opts: TraversalOptions = {}): Subgraph {
  const d = typeof depth === 'number' ? depth : 10;
  const o = typeof depth === 'number' ? opts : depth;
  return trace(index, [id], 'upstream', d, o);
}

// ── journey: linearized execution walk ───────────────────────────

/**
 * What kind of decision a fork is, for the business band: `business` = a person
 * authored a `@business` label for it, `guard` = it refuses or checks access,
 * `technical` = everything else (an error path, a feature flag, a state test, a
 * plain branch). Only business + guard are drawn as decisions; the rest are
 * counted as untranslated so the band never claims `env.DATABASE_URL` is a
 * business rule.
 */
export type DecisionClass = 'business' | 'guard' | 'technical';

/** A condition the walk met that nobody put in plain language and that is never drawn as a decision. */
export interface UntranslatedCondition {
  stepOrder: number;
  category: BranchCategory;
  /** the caller whose fork it is */
  nodeId: string;
  name: string;
  line: number;
  /** the condition as the code writes it */
  requires: string;
}

/** A fork in a caller that gates one hop of a journey. */
export interface PathCondition {
  nodeId: string;
  name: string;              // the caller whose fork gates this hop
  path: string;
  line: number;              // fork location (caller's file)
  kind: BranchPoint['kind'];
  arm: string;               // arm label the call site sits in
  requires: string;          // condition that must hold to reach the call
  business?: string;         // plain-language label for the arm/fork (arm.business ?? branchPoint.business)
  /** what this condition means to a reader — see DecisionClass */
  class: DecisionClass;
  /** the raw fork category behind `class` (categorizeBranch), so untranslated ones can be counted by kind */
  category: BranchCategory;
}

/**
 * A step the contract commits to but no code implements yet — synthesized at
 * query time from a declared (spec-only) route's OpenAPI operation, never
 * stored as a node. `kind`: receives = the request payload · step = the
 * operation's own headline · returns = a response payload.
 */
export interface PlannedStep {
  /** calls = the design says this (unbuilt) screen uses this operation — the step's node is the real route */
  kind: 'calls' | 'receives' | 'step' | 'returns';
  label: string;            // "SubmissionCreate" · "Submit an invoice." · "Submission"
  detail?: string;          // "required" · "201" · …
}

/** One node in the ordered execution walk. */
export interface JourneyStep {
  order: number;            // 0..n position in the timeline
  depth: number;            // call-nesting level (indent)
  via: 'entry' | 'calls' | 'http' | 'renders' | 'publishes' | 'consumes' | 'reads' | 'writes' | 'planned';
  edgeId?: string;
  callSite?: { path: string; line: number };  // where the parent invoked this
  /** the node this step runs — for a planned step, the declared route whose contract produced it */
  nodeId: string;
  crossRepo: boolean;       // repo changed vs parent step
  /** guards/validates on this node; `planned` = the spec's security requirement on a declared route, not an enforced gate */
  gates: { id: string; kind: 'guard' | 'rule'; name: string; planned?: true }[];
  repeat: boolean;          // node already appeared earlier in this journey
  cycle: boolean;           // back-reference; traversal did not recurse
  conditions?: PathCondition[]; // forks enclosing THIS hop's call site (this hop only)
  /** present only on via:'planned' steps — what the contract says will happen here */
  planned?: PlannedStep;
  /**
   * the boot: this step is a setup root (`meta.origin: 'setup'` on the edge that
   * reached it — container construction). Printed once per journey and never
   * descended, so a request never reads as if it built the process (R3).
   */
  setup?: true;
  /**
   * this step was reached over a deferred edge (`meta.deferred`): a hook or a
   * callback that runs later, on its own. Named where it was registered, never
   * walked (R2).
   */
  deferred?: true;
  /** the hop that reached it was made inside a transaction callback (`meta.tx`) */
  tx?: true;
}

/**
 * A subtree the walk chose not to follow — the honest local alternative to a
 * global "truncated". `depth` = the child sat past `maxDepth`; `repeat` = the
 * node was past its re-visit budget (it is still emitted as a step, its
 * children are not); `steps` = the whole walk hit `maxSteps` here.
 */
export interface JourneyCutPoint {
  reason: 'depth' | 'steps' | 'repeat';
  /** the step whose subtree was cut (its order) */
  parentStep: number;
  /** the child that was not walked (or, for `steps`, the child that did not fit) */
  nodeId: string;
  edgeId?: string;
  /** the depth the child would have had */
  depth: number;
}

/** A depth-first, call-site-ordered execution walk from one entry node. */
export interface Journey {
  entryId: string;
  steps: JourneyStep[];
  edges: GraphEdge[];       // deduped flow edges among visited nodes
  /** the walk ended early: `maxSteps` reached (global). Depth and repeat exhaustion are LOCAL — see `cutPoints` */
  truncated: boolean;
  forkCount: number;        // Σ branches.length over unique step nodes
  /** steps synthesized from contracts (declared, not built) — counted apart so "9 steps" never claims code that is not there */
  plannedCount: number;
  /** subtrees the walk did not follow, each named where it happened (never a reason to stop the whole walk) */
  cutPoints: JourneyCutPoint[];
}

/**
 * The planned continuation of a declared route: what its contract commits to,
 * in the order it would happen — receives the request payload, does the thing
 * the summary names, returns each 2xx payload. Pure; shared by journey() and
 * any consumer that wants to show a spec-only operation's intent.
 */
export function plannedStepsOf(node: GraphNode): PlannedStep[] {
  const c = node.contract;
  if (!c) return [];
  const out: PlannedStep[] = [];
  if (c.requestBody?.schema) out.push({ kind: 'receives', label: c.requestBody.schema, ...(c.requestBody.required ? { detail: 'required' } : {}) });
  out.push({ kind: 'step', label: c.summary?.trim() || c.spec?.operationId || node.name });
  const seen = new Set<string>();
  for (const r of c.responses ?? []) {
    if (!r.schema || !/^2/.test(r.status) || seen.has(r.schema)) continue;
    seen.add(r.schema);
    out.push({ kind: 'returns', label: r.schema, detail: r.status });
  }
  return out;
}

/** Declared, not built: a route whose only evidence is a contract. */
export function isDeclaredOnly(node: GraphNode): boolean {
  return node.kind === 'route' && !node.loc && (node.contract?.status === 'spec-only' || node.contract?.status === 'declared');
}

export interface JourneyOptions {
  maxDepth?: number;    // default 20 — the reference app's ten flows exhaust between 15 and 20 hops once setup and deferred edges are skipped (2026-09-22)
  /**
   * default 1200 — the global stop, and the only one that sets `truncated`. Raised from 300, then 600, when
   * re-visits past the repeat budget became visible steps instead of vanishing: the reference app
   * submission flow is 426 steps, and a cap that hid its third screen would make the honest
   * walk read as *less* complete than the old silent one.
   */
  maxSteps?: number;
  renderDepth?: number; // default 2 — how deep to inline `renders` for page/component entries
  maxRepeats?: number;  // default 1 — extra re-visits of an already-walked node
}

const JOURNEY_FOLLOW = new Set<string>(['calls', 'http', 'renders', 'publishes', 'reads', 'writes']);

/**
 * The App Router's file convention: a handler named for its HTTP verb carries
 * no words of its own, so outside the code lens it borrows the title its route's
 * spec gives it (01 §2.3.6 c).
 */
const ROUTE_VERBS = new Set<string>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * `operationId` → the route that implements (or declares) it, indexed lazily on
 * first use and kept for the life of the caller. One definition, so the walk and
 * the fold resolve a manifest's operation the same way.
 */
function makeRouteForOperation(index: GraphIndex): (op: string) => GraphNode | undefined {
  let opIndex: Map<string, GraphNode> | undefined;
  return (op: string): GraphNode | undefined => {
    if (!opIndex) {
      opIndex = new Map();
      for (const n of index.byId.values()) { const id = n.contract?.spec?.operationId; if (n.kind === 'route' && id && !opIndex.has(id)) opIndex.set(id, n); }
    }
    return opIndex.get(op);
  };
}

/**
 * Linearize "what runs, in what order" from an entry node — the query behind
 * the Journey view. Downstream DFS; a node's callees are ordered by call-site
 * line (meta.line), crossing the HTTP boundary and following queue publishes
 * to their consumers. Guards/rules attach as `gates`, never as steps. Pure over
 * the index, so it moves to the Rust engine unchanged.
 *
 * Exhaustion is local wherever it can be: a child past `maxDepth`, and a node
 * past its re-visit budget, each record a `cutPoint` and the walk carries on
 * with the next sibling — so a deep first screen never hides the second. Only
 * `maxSteps` ends the walk, and only that sets `truncated`.
 */
export function journey(index: GraphIndex, entryId: string, opts: JourneyOptions = {}): Journey {
  const maxDepth = opts.maxDepth ?? 20;
  // 1200: the reference app's flagship flow walks ~750 steps once guard functions (the submit transaction) are descended
  const maxSteps = opts.maxSteps ?? 1200;
  const maxRepeats = opts.maxRepeats ?? 1;

  const entry = index.byId.get(entryId);
  if (!entry) return { entryId, steps: [], edges: [], truncated: false, forkCount: 0, plannedCount: 0, cutPoints: [] };
  // a flow (a named set of screens from a design manifest) renders its screens in order, and each screen renders its tree
  const entryIsView = entry.kind === 'page' || entry.kind === 'component' || entry.kind === 'flow';
  // a journey that starts in the app never walks into tooling (config `tooling`, default
  // scripts/**): a script sharing a name with the runtime is not on a production path.
  // A journey that starts in a script walks as it always did.
  const entryIsTooling = !!entry.tags?.includes('tooling');
  const isTooling = (id: string): boolean => !entryIsTooling && !!index.byId.get(id)?.tags.includes('tooling');
  const renderDepth = opts.renderDepth ?? (entry.kind === 'flow' ? 3 : 2);

  const steps: JourneyStep[] = [];
  const stack = new Set<string>();      // nodeIds on the current DFS path (cycle guard)
  const visits = new Map<string, number>(); // total prior appearances (repeat budget)
  let order = 0;
  let truncated = false;
  let plannedCount = 0;
  const cutPoints: JourneyCutPoint[] = [];
  /** setup roots already printed on this walk — the boot is one step, however many requests reach it */
  const setupSeen = new Set<string>();
  /** the walk stops once, at the step budget — record that spot a single time */
  const cutAtCap = (parentStep: number, nodeId: string, depth: number, edge?: GraphEdge): void => {
    truncated = true;
    if (cutPoints.some((c) => c.reason === 'steps')) return;
    cutPoints.push({ reason: 'steps', parentStep, nodeId, ...(edge ? { edgeId: edge.id } : {}), depth });
  };

  const gatesOf = (id: string): JourneyStep['gates'] => {
    const gates: JourneyStep['gates'] = [];
    for (const e of index.in.get(id) ?? []) {
      if (e.kind !== 'guards' && e.kind !== 'validates') continue;
      const src = index.byId.get(e.from);
      if (!src) continue;
      // an env/config schema or a configured plumbing rule checks the process, not the
      // person: it is still a rule of the code (`rulesFor` and list_rules keep it) but it
      // is not a checkpoint on anyone's journey (01 §2.3.6 a)
      if (src.kind === 'rule' && (src.tags?.includes('env-schema') || src.tags?.includes('plumbing'))) continue;
      if ((src.kind === 'guard' || src.kind === 'rule') && !gates.some((g) => g.id === src.id)) {
        gates.push({ id: src.id, kind: src.kind, name: src.name });
      }
    }
    // a declared route's security requirement is a planned gate: the spec commits to it, no code enforces it yet.
    // Config-declared gates (tagged `declared`) already arrive above as real guards edges.
    const node = index.byId.get(id);
    if (node && isDeclaredOnly(node)) {
      for (const sec of node.contract?.security ?? []) {
        if (gates.some((g) => g.name === sec)) continue;
        gates.push({ id: `${id}#security:${sec}`, kind: 'guard', name: sec, planned: true });
      }
    }
    return gates;
  };

  // the planned continuation of a declared route: emitted in place of the children it has none of
  const pushPlanned = (node: GraphNode, depth: number, parentStep: number): void => {
    for (const p of plannedStepsOf(node)) {
      if (steps.length >= maxSteps) { cutAtCap(parentStep, node.id, depth); return; }
      steps.push({ order: order++, depth, via: 'planned', nodeId: node.id, crossRepo: false, gates: [], repeat: false, cycle: false, planned: p });
      plannedCount++;
    }
  };

  // call-site line ascending; un-lined edges keep insertion order, after lined ones
  const byLine = (a: GraphEdge, b: GraphEdge): number => {
    const la = typeof a.meta?.line === 'number' ? a.meta.line : undefined;
    const lb = typeof b.meta?.line === 'number' ? b.meta.line : undefined;
    if (la != null && lb != null) return la - lb;
    if (la != null) return -1;
    if (lb != null) return 1;
    return 0;
  };

  // arms of the parent's branches whose span contains the call-site line — the
  // conditions that must hold for this hop to run (sorted by fork line, cap 8)
  const conditionsAt = (parent: GraphNode, cs: { path: string; line: number }): PathCondition[] | undefined => {
    if (!parent.branches?.length || parent.loc?.path !== cs.path) return undefined;
    const out: PathCondition[] = [];
    for (const bp of parent.branches) {
      const category = categorizeBranch(bp);
      for (const arm of bp.arms) {
        if (cs.line < arm.line || cs.line > arm.endLine) continue;
        const business = arm.business ?? bp.business;
        // authored language makes it a business decision; an access/refusal check is a guard;
        // everything else is technical and is counted, never drawn as a diamond
        const cls: DecisionClass = business ? 'business' : category === 'access' || category === 'guard' ? 'guard' : 'technical';
        out.push({
          nodeId: parent.id, name: parent.name, path: cs.path, line: bp.line,
          kind: bp.kind, arm: arm.label, requires: arm.requires,
          ...(business ? { business } : {}),
          class: cls, category,
        });
      }
    }
    if (!out.length) return undefined;
    out.sort((a, b) => a.line - b.line);
    return out.slice(0, 8);
  };

  // operationId → route, built once, only when a design-only screen asks for it
  const routeForOperation = makeRouteForOperation(index);

  /**
   * One step for a setup root or a deferred hook: everything a step carries
   * except a subtree. It never touches `visits` or `stack`, so it neither
   * spends the re-visit budget nor makes a later real call read as a repeat.
   */
  const pushFlagged = (
    flag: 'setup' | 'deferred',
    c: { edge: GraphEdge; childId: string; via: JourneyStep['via'] },
    depth: number,
    callSite: JourneyStep['callSite'],
    parent: GraphNode,
    conditions: PathCondition[] | undefined,
  ): void => {
    const child = index.byId.get(c.childId);
    if (!child) return;
    steps.push({
      order: order++, depth, via: c.via, edgeId: c.edge.id,
      ...(callSite ? { callSite } : {}),
      nodeId: c.childId,
      crossRepo: !!parent.loc?.repo && !!child.loc?.repo && child.loc.repo !== parent.loc.repo,
      gates: gatesOf(c.childId), repeat: false, cycle: false,
      ...(conditions?.length ? { conditions } : {}),
      ...(c.edge.meta?.tx ? { tx: true as const } : {}),
      ...(flag === 'setup' ? { setup: true as const } : { deferred: true as const }),
    });
  };

  const walk = (
    nodeId: string,
    depth: number,
    via: JourneyStep['via'],
    edge: GraphEdge | undefined,
    callSite: JourneyStep['callSite'],
    parentRepo: string | undefined,
    conditions: PathCondition[] | undefined,
    planned?: PlannedStep,
  ): void => {
    if (truncated) return;
    const node = index.byId.get(nodeId);
    if (!node) return;
    const crossRepo = !!parentRepo && !!node.loc?.repo && node.loc.repo !== parentRepo;
    const selfOrder = order; // the order this step will take (push is called at most once per walk)
    const push = (cycle: boolean, repeat: boolean): void => {
      steps.push({
        order: order++, depth, via, ...(edge ? { edgeId: edge.id } : {}),
        ...(callSite ? { callSite } : {}), nodeId, crossRepo,
        gates: gatesOf(nodeId), repeat, cycle,
        ...(conditions?.length ? { conditions } : {}),
        ...(planned ? { planned } : {}),
        ...(edge?.meta?.tx ? { tx: true as const } : {}),
      });
      if (planned) plannedCount++;
    };

    if (steps.length >= maxSteps) { cutAtCap(-1, nodeId, depth, edge); return; }
    // a node already on the current path is a back-reference: emit once, don't recurse
    if (stack.has(nodeId)) { push(true, false); return; }

    const appearances = visits.get(nodeId) ?? 0;
    // leaf data steps (tables) never recurse — always emit; a read and a later
    // write to the same table are distinct ops, exempt from the re-visit budget
    if (node.kind === 'table') {
      visits.set(nodeId, appearances + 1);
      push(false, appearances >= 1);
      return;
    }
    if (appearances > maxRepeats) {
      // past the re-visit budget: the node still ran, so it is a step — but its subtree is a cut
      // point rather than a silent disappearance
      visits.set(nodeId, appearances + 1);
      push(false, true);
      cutPoints.push({ reason: 'repeat', parentStep: selfOrder, nodeId, ...(edge ? { edgeId: edge.id } : {}), depth });
      return;
    }
    visits.set(nodeId, appearances + 1);
    push(false, appearances >= 1);

    // gather ordered children
    let children: { edge: GraphEdge; childId: string; via: JourneyStep['via'] }[] = [];
    if (node.kind === 'queue') {
      // the async hop: a published topic continues through its consumers
      for (const e of index.in.get(nodeId) ?? []) {
        if (e.kind === 'consumes' && !isTooling(e.from)) children.push({ edge: e, childId: e.from, via: 'consumes' });
      }
    } else {
      const outs = (index.out.get(nodeId) ?? []).filter((e) => {
        if (!JOURNEY_FOLLOW.has(e.kind)) return false;
        if (isTooling(e.to)) return false;
        // renders only inline for view entries, and only within renderDepth
        if (e.kind === 'renders') return entryIsView && depth < renderDepth;
        // a guard that only checks (nothing runs under it) is a gate on this step, never a step of
        // its own; a guard that also works (writes, calls on) is walked like any function
        if (e.kind === 'calls' && e.meta?.via === 'guard') {
          const g = index.byId.get(e.to);
          if (g?.kind === 'guard' && !(index.out.get(e.to) ?? []).some((x) => JOURNEY_FOLLOW.has(x.kind))) return false;
        }
        return true;
      });
      children = [...outs].sort(byLine).map((e) => ({ edge: e, childId: e.to, via: e.kind as JourneyStep['via'] }));
    }
    // declared, not built, and nothing runs from it: show what the contract says will happen, marked planned
    if (!children.length && isDeclaredOnly(node) && depth + 1 <= maxDepth) pushPlanned(node, depth + 1, selfOrder);
    // a designed, unbuilt screen: the operations its design names are planned calls into the real routes,
    // which then continue as built steps or as their own planned steps
    const plannedCalls = !children.length && node.design?.status === 'design-only'
      ? (node.design.operations ?? []).map((op) => ({ op, route: routeForOperation(op) })).filter((x): x is { op: string; route: GraphNode } => !!x.route)
      : [];

    stack.add(nodeId);
    for (const c of children) {
      if (truncated || steps.length >= maxSteps) { cutAtCap(selfOrder, c.childId, depth + 1, c.edge); break; }
      // depth is a local cut: this child is not walked, the next sibling still is
      if (depth + 1 > maxDepth) { cutPoints.push({ reason: 'depth', parentStep: selfOrder, nodeId: c.childId, edgeId: c.edge.id, depth: depth + 1 }); continue; }
      const l = typeof c.edge.meta?.line === 'number' ? c.edge.meta.line : undefined;
      const cs = l != null && node.loc?.path ? { path: node.loc.path, line: l } : undefined;
      // the boot and the work that runs later are named where they were reached and left
      // there: one step, no subtree, outside the visit budget — so the second request does
      // not re-print the container, and a later genuine call to the same function is not a
      // re-visit of it (01 §2.3.3).
      const origin = c.edge.meta?.origin === 'setup' ? 'setup' : c.edge.meta?.deferred ? 'deferred' : undefined;
      if (origin) {
        if (origin === 'setup') {
          if (setupSeen.has(c.childId)) continue;
          setupSeen.add(c.childId);
        }
        pushFlagged(origin, c, depth + 1, cs, node, cs ? conditionsAt(node, cs) : undefined);
        continue;
      }
      walk(c.childId, depth + 1, c.via, c.edge, cs, node.loc?.repo, cs ? conditionsAt(node, cs) : undefined);
    }
    for (const pc of plannedCalls) {
      if (truncated || steps.length >= maxSteps) { cutAtCap(selfOrder, pc.route.id, depth + 1); break; }
      if (depth + 1 > maxDepth) { cutPoints.push({ reason: 'depth', parentStep: selfOrder, nodeId: pc.route.id, depth: depth + 1 }); continue; }
      walk(pc.route.id, depth + 1, 'planned', undefined, undefined, node.loc?.repo, undefined, { kind: 'calls', label: pc.op });
    }
    stack.delete(nodeId);
  };

  walk(entryId, 0, 'entry', undefined, undefined, undefined, undefined);

  // A route whose handler is a named function carries that handler's gates twice: once
  // mirrored onto the route (route-handler-attribution, `via: 'handler'`) and once on the
  // handler itself. Drop the route's copy only now that the walk is done and we know the
  // handler step was actually emitted — truncation (maxDepth/maxSteps) or a filter can end
  // the walk at the route, and a gate must never vanish because of where the walk stopped.
  const visited = new Set(steps.map((s) => s.nodeId));
  for (const step of steps) {
    const mirrored = new Set<string>();
    const direct = new Set<string>();
    for (const e of index.in.get(step.nodeId) ?? []) {
      if (e.kind !== 'guards' && e.kind !== 'validates') continue;
      if (e.meta?.via === 'handler' && typeof e.meta.handler === 'string' && visited.has(e.meta.handler)) mirrored.add(e.from);
      else direct.add(e.from);
    }
    // a gate that also reaches this node directly (middleware, say) is its own — keep it
    for (const id of direct) mirrored.delete(id);
    if (mirrored.size) step.gates = step.gates.filter((g) => !mirrored.has(g.id));
  }

  // flow edges: relevant edges whose endpoints both appear as steps, deduped
  const flowEdges: GraphEdge[] = [];
  const seenFlow = new Set<string>();
  for (const id of visited) {
    for (const e of index.out.get(id) ?? []) {
      if (!JOURNEY_FOLLOW.has(e.kind) && e.kind !== 'consumes') continue;
      if (!visited.has(e.to) || seenFlow.has(e.id)) continue;
      seenFlow.add(e.id);
      flowEdges.push(e);
    }
  }

  let forkCount = 0;
  for (const id of visited) forkCount += index.byId.get(id)?.branches?.length ?? 0;

  return { entryId, steps, edges: flowEdges, truncated, forkCount, plannedCount, cutPoints };
}

/** Rough meaning of a fork, for grouping/summaries. Shared by server + MCP so the viewer stays heuristic-free. */
export type BranchCategory = 'error' | 'flag' | 'access' | 'guard' | 'state' | 'branch';

export function categorizeBranch(bp: BranchPoint): BranchCategory {
  if (bp.kind === 'catch') return 'error';
  if (/flag|feature|toggle|enabl/i.test(bp.condition)) return 'flag';
  if (/auth|session|role|scope|perm|token|admin|tenant/i.test(bp.condition)) return 'access';
  if (bp.exits) return 'guard';
  if (bp.kind === 'switch' || /status|state|kind|type|mode|phase/i.test(bp.condition)) return 'state';
  return 'branch';
}

/**
 * Business-lens one-liner for a node: authored `@business` description, else
 * the OpenAPI operation `summary` when the node carries a contract (the
 * headline the API's authors wrote for its consumers — `description` is the
 * long form and lands in `docs`), else the first sentence of the doc prose
 * (same `split(/[.!?]\s/)` idiom viewer.js uses), else undefined.
 * Callers add their own `humanize(name)` fallback where they show one.
 */
export function businessSummary(node: GraphNode): string | undefined {
  const authored = node.facets?.business?.description;
  if (authored) return authored;
  const summary = node.contract?.summary?.trim();
  if (summary) return summary;
  const docs = node.docs?.trim();
  if (docs) {
    const first = docs.split(/[.!?]\s/)[0]!.trim();
    if (first) {
      // re-attach the terminal punctuation the split stripped, if the doc had one
      const punct = docs.slice(first.length, first.length + 1);
      return /[.!?]/.test(punct) ? first + punct : first;
    }
  }
  return undefined;
}

/** Rule/guard/flag nodes attached to any node of a subgraph. */
export function rulesFor(index: GraphIndex, subgraph: Subgraph): { rule: GraphNode; appliesTo: GraphNode }[] {
  const results: { rule: GraphNode; appliesTo: GraphNode }[] = [];
  const inSlice = new Set(subgraph.nodes.map((n) => n.id));
  for (const node of subgraph.nodes) {
    for (const e of index.in.get(node.id) ?? []) {
      const source = index.byId.get(e.from);
      if (!source) continue;
      if ((e.kind === 'guards' || e.kind === 'validates') && (source.kind === 'guard' || source.kind === 'rule' || source.kind === 'flag')) {
        results.push({ rule: source, appliesTo: node });
      }
    }
    void inSlice;
  }
  return results;
}

// ── journeySummary: the three-band blueprint, one truth for HUD + MCP ────

/** One item on the system timeline — steps, gates, decisions, records and messages are first-class rows (P5 §1). */
export interface TimelineItem {
  order: number;
  depth: number;
  kind: 'screen' | 'step' | 'call' | 'gate' | 'decision' | 'record' | 'message' | 'external' | 'planned' | 'setup' | 'deferred';
  nodeId: string;
  name: string;
  via: JourneyStep['via'];
  /** the step this item hangs off (gates/decisions belong to a step) */
  stepOrder: number;
  planned?: PlannedStep | true;
  business?: string;
  repo?: string;
}

/** Which system a timeline marker lands in — one row per system on the blueprint timeline (proposal §7, option C). */
export interface SystemRow {
  /** stable row key: `repo:<name>:ux` · `repo:<name>:server` · `api:<apiId>` · `api:repo:<name>` · `records` · `messages` · `external:<name>` · `afterwards` */
  key: string;
  kind: 'repo' | 'api' | 'records' | 'messages' | 'external' | 'afterwards';
  /** which half of a repo this row is: the browser code that asks, or the server code that answers */
  side?: 'ux' | 'server';
  /** what the row is called: the repo, the spec's title, "records", "messages", the host */
  label: string;
  /** rows whose every marker is planned (declared, not built) */
  planned: boolean;
  /** external rows: the system's kind, so a consumer can say "the ERP" without reading the name (R4) */
  externalKind?: ExternalKind;
  /**
   * the data store this row is (docs/proposals/data-stores.md §3.2): on a store-like external's row, that
   * system; on the `records` row, the one store every record marker of the journey lives in — absent when
   * the records live in several stores or in none the graph names (then each marker says its own).
   */
  store?: MarkerStore;
}

/** A data store as a journey surface prints it: the name and the kind. How it was known stays on the node (`GraphNode.store`). */
export interface MarkerStore {
  name: string;
  kind: StoreKind;
}

/** The store words of a table, or of an external used as a store — undefined when the graph names none. */
export function markerStoreOf(n: GraphNode | undefined): MarkerStore | undefined {
  return n?.store ? { name: n.store.name, kind: n.store.kind } : undefined;
}

/**
 * The direction an HTTP method moves data, read from the store's side: GET/HEAD read from it,
 * POST/PUT/PATCH/DELETE write to it. Anything else, or no method recorded, is no claim.
 */
export function opOfMethod(method: unknown): 'reads' | 'writes' | undefined {
  const m = typeof method === 'string' ? method.toUpperCase() : '';
  if (m === 'GET' || m === 'HEAD') return 'reads';
  if (m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') return 'writes';
  return undefined;
}

/** One end of the HTTP seam a call crosses: where the UX made it, or where the API starts. */
export interface SeamEnd {
  nodeId: string;
  name: string;
  repo: string;
  path: string;
  line: number;
}

/**
 * One written call that the code resolves when it runs: several classes
 * implement the declared type, the parser drew an edge to each, and **which
 * one runs is a run-time fact Farsight does not have**. Folded here so a
 * single call site is drawn once, with its candidates named, instead of one
 * step per implementation in a row a reader cannot tell from a sequence
 * (swarm 2026-09-23, blocker 3).
 *
 * Nothing is dropped: every candidate keeps its own step in the walk (the
 * spliced code view and `full:true` still show them all) and its own node in
 * the coverage scope. It is the band that draws one place instead of three.
 */
export interface JourneyChoice {
  /** identity of the call site — every candidate of one call shares it */
  id: string;
  /** the declared type the call went through, when the resolution named one */
  iface?: string;
  /** the member the source names at that line — `send` */
  member: string;
  /** what a consumer prints instead of one implementation's name — `EmailTransport.send` */
  label: string;
  /** the same call in plain words, for a register that prints no identifiers — `Email transport · Send` */
  words: string;
  /** where the call is written: the caller and its line, the one location that is certainly on the path */
  at?: { nodeId: string; name: string; path: string; line: number };
  /**
   * the implementations the walk drew, in walk order; the first is the marker that carries
   * the fold. `words` is the implementation in plain words for a register that prints no
   * identifiers — the member is already in the group's name, so only the owner is spelled.
   */
  candidates: { nodeId: string; name: string; words: string; stepOrder: number; title?: string }[];
  /** implementations the resolution knew of and did not draw (in-memory / mock twins), by name */
  setAside: string[];
  technique?: ResolutionTechnique;
  confidence?: ConfidenceTier;
}

/**
 * Every run-time choice on a walk, keyed by **each** candidate's step order
 * (so a step-printing consumer can ask about any of them) and shared by
 * reference inside a group.
 *
 * A group is one caller, one line, one declared type and one member, with
 * more than one implementation drawn. The parser stamps exactly that on the
 * edge (`meta.via: 'interface'`, `meta.iface`, `resolution.alternatives`), so
 * this reads what A1.6 already recorded and invents no resolution of its own.
 */
export function journeyChoices(index: GraphIndex, j: Journey): Map<number, JourneyChoice> {
  const out = new Map<number, JourneyChoice>();
  const stepById = new Map(j.steps.map((st) => [st.order, st] as const));
  const parentOf = new Map<number, number>();
  {
    const chain: number[] = [];
    for (const s of j.steps) { chain[s.depth] = s.order; parentOf.set(s.order, s.depth > 0 ? (chain[s.depth - 1] ?? -1) : -1); }
  }
  const memberOf = (name: string): string => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1) : name; };
  type Row = { step: JourneyStep; node: GraphNode; edge: GraphEdge };
  const groups = new Map<string, Row[]>();
  for (const s of j.steps) {
    // the boot and the work that runs later are named where they were reached, never
    // walked — they are not a call site anyone is reading down
    if (!s.edgeId || s.setup || s.deferred || s.planned) continue;
    const p = parentOf.get(s.order) ?? -1;
    const parent = p >= 0 ? stepById.get(p) : undefined;
    if (!parent) continue;
    const edge = (index.out.get(parent.nodeId) ?? []).find((e) => e.id === s.edgeId);
    // an ambiguity the parser recorded is the only thing that makes a fan-out: two calls
    // written on one line are a sequence, and must keep reading as one
    if (!edge?.resolution?.alternatives?.length) continue;
    const line = typeof edge.meta?.line === 'number' ? edge.meta.line : undefined;
    if (line == null) continue;
    const node = index.byId.get(s.nodeId);
    if (!node) continue;
    const iface = typeof edge.meta?.iface === 'string' ? edge.meta.iface : undefined;
    const key = `${p}|${line}|${iface ?? edge.resolution.technique}|${memberOf(node.name)}`;
    const have = groups.get(key);
    if (have) have.push({ step: s, node, edge });
    else groups.set(key, [{ step: s, node, edge }]);
  }
  for (const [key, rows] of groups) {
    if (rows.length < 2) continue;                 // one implementation is not a choice
    const first = rows[0]!;
    const p = parentOf.get(first.step.order) ?? -1;
    const parentNode = p >= 0 ? index.byId.get(stepById.get(p)!.nodeId) : undefined;
    const line = Number(first.edge.meta?.line);
    const iface = typeof first.edge.meta?.iface === 'string' ? first.edge.meta.iface : undefined;
    const member = memberOf(first.node.name);
    const drawn = new Set(rows.map((r) => r.node.id));
    const setAside: string[] = [];
    for (const r of rows) {
      for (const id of r.edge.resolution?.alternatives ?? []) {
        if (drawn.has(id)) continue;
        const n = index.byId.get(id);
        // a set-aside implementer need not be a node this walk knows: its id still carries the symbol
        const nm = n?.name ?? id.split('::').pop() ?? id;
        if (!setAside.includes(nm)) setAside.push(nm);
      }
    }
    const choice: JourneyChoice = {
      id: `${parentNode?.id ?? key}#${line}`,
      ...(iface ? { iface } : {}),
      member,
      label: iface ? `${iface}.${member}` : member,
      words: iface ? `${humanizeName(iface)} · ${humanizeName(member)}` : humanizeName(member),
      ...(parentNode?.loc ? { at: { nodeId: parentNode.id, name: parentNode.name, path: parentNode.loc.path, line } } : {}),
      candidates: rows.map((r) => {
        const title = r.node.facets?.business?.label ?? businessSummary(r.node);
        const dot = r.node.name.lastIndexOf('.');
        return {
          nodeId: r.node.id, name: r.node.name,
          words: humanizeName(dot > 0 ? r.node.name.slice(0, dot) : r.node.name),
          stepOrder: r.step.order, ...(title ? { title } : {}),
        };
      }),
      setAside,
      ...(first.edge.resolution?.technique ? { technique: first.edge.resolution.technique } : {}),
      ...(first.edge.resolution?.confidence ? { confidence: first.edge.resolution.confidence } : {}),
    };
    for (const r of rows) out.set(r.step.order, choice);
  }
  return out;
}

/**
 * Where a step sits relative to a transaction its caller opened — the one
 * decision every surface reads, so the band, the drill and the agent cannot
 * word this differently (blocker 8, 2026-09-23).
 *
 * `inside` is the parser's own record: the call is **written** inside a
 * callback passed to a transaction opener (`withOps` · `withTenant` · `withTx`
 * · `transaction` · `$transaction`), stamped on the edge as `meta.tx` in pass
 * 1 and carried onto the step by `journey()`. `after` is the other half of the
 * same fact: the same caller opened one earlier and this call is written
 * outside it.
 *
 * Three things this deliberately does NOT say, because the flag does not carry
 * them:
 *  - **which** transaction. The flag is per call site, not per callback, so two
 *    neighbouring `inside` steps may sit in different transactions. Nothing here
 *    counts transactions or claims a run of them is one.
 *  - that it **committed**. A boundary is where the code puts one, not what a
 *    run did inside it.
 *  - that an `after` step **failed**, or is a rollback. It is simply not in the
 *    transaction above it.
 *
 * The boot and work that runs later take no side at all: a hook registered
 * inside a transaction callback runs on its own, afterwards, and marking it
 * `inside` would be the same class of falsehood this fold exists to end.
 */
export type TxSide = 'inside' | 'after';

/**
 * The transaction facts of one walk: whether this graph records boundaries at
 * all, and the side each step takes.
 *
 * `known` is a fact about the **graph**, not the walk — an older graph, written
 * before the parser stamped `meta.tx`, records none, and so does a codebase
 * that opens none. Absent is not "everything is outside" and not "everything is
 * inside": consumers that would otherwise draw nothing say so in words.
 */
export function journeyTransactions(index: GraphIndex, j: Journey): { known: boolean; sideOf: Map<number, TxSide> } {
  const sideOf = new Map<number, TxSide>();
  let known = false;
  for (const edges of index.out.values()) {
    if (edges.some((e) => e.meta?.tx)) { known = true; break; }
  }
  if (!known) return { known, sideOf };
  const parentOf = new Map<number, number>();
  {
    const chain: number[] = [];
    for (const s of j.steps) { chain[s.depth] = s.order; parentOf.set(s.order, s.depth > 0 ? (chain[s.depth - 1] ?? -1) : -1); }
  }
  // the hops one caller makes, in the order the code makes them
  const kids = new Map<number, JourneyStep[]>();
  for (const s of j.steps) {
    // the boot and the work that runs later are named where they were reached, never
    // sequenced with the caller's own hops — `meta.tx` on a deferred edge says the
    // *registration* was inside a transaction, not the work
    if (s.setup || s.deferred) continue;
    const p = parentOf.get(s.order) ?? -1;
    if (p < 0) continue;
    const list = kids.get(p);
    if (list) list.push(s); else kids.set(p, [s]);
  }
  for (const list of kids.values()) {
    let opened = false;
    for (const s of list) {
      if (s.tx) { sideOf.set(s.order, 'inside'); opened = true; }
      else if (opened) sideOf.set(s.order, 'after');
    }
  }
  return { known, sideOf };
}

/** One marker on a segment's time axis: a step, call, record, message or external, placed in its system's row. */
export interface SegmentMarker {
  stepOrder: number;
  depth: number;
  nodeId: string;
  name: string;
  kind: 'step' | 'call' | 'record' | 'message' | 'external' | 'setup' | 'deferred';
  via: JourneyStep['via'];
  system: string;           // SystemRow.key
  /** index into the owning segment's `moments[]` — one client-side action and everything it caused */
  moment: number;
  planned?: boolean;
  /** the node already ran earlier in this journey (the walk's `repeat`) */
  repeat?: boolean;
  /** plumbing: a function called by another function on the same side of the seam, not by the action or the handler */
  helper?: boolean;
  /** the part this one hangs under — the nearest ancestor marker in this segment that is not a helper (the drill tree) */
  under?: number;
  /**
   * how deep inside its cell of the band this marker sits: 0 = the handler under the route or the
   * action in the browser (its `under` is on another row, in another moment, or is the moment's
   * component), 1 = a part they call, 2+ = a drill-down under that part. Helpers sit one tier
   * under the marker that used them. Consumers draw tiers 0–1 and fold the rest.
   */
  tier?: number;
  /** subtrees hanging off this marker's step the reader has not seen — depth/steps cuts only, never a re-visit */
  cut?: number;
  /**
   * this marker is one written call with several possible implementations
   * (`journeyChoices`). The marker's `name` is then the call as the source
   * writes it (`EmailTransport.send`), `nodeId` is the first candidate — the
   * one whose step the timeline is anchored on — and `choice.at` is the call
   * site, the only location certainly on the path. The other candidates carry
   * no marker of their own: a consumer draws this one place and names them.
   */
  choice?: JourneyChoice;
  /**
   * which side of a transaction boundary this marker sits on (`journeyTransactions`):
   * `inside` = the call is written inside a transaction callback, `after` = its caller
   * opened one earlier and this call is written outside it. Absent = no claim — either
   * nothing here is transactional or this graph records no boundaries (`summary.txKnown`).
   * Never a count: the flag is per call site, so neighbours may sit in different
   * transactions, and no run is known to have committed.
   */
  tx?: TxSide;
  /** call markers only: the fetch line in the browser code that made this call */
  caller?: SeamEnd;
  /** call markers only: where the API starts — the handler registration, else the route itself */
  handler?: SeamEnd;
  business?: string;
  /**
   * the words a non-code register prints for this marker: the authored `@business`
   * label, else — for a handler named for its HTTP verb — the summary its route's
   * spec gives it, else the first sentence a person wrote. Absent = print the
   * identifier; nothing here is ever a humanized guess (R7c).
   */
  title?: string;
  /**
   * where `title` came from, so a surface can decide how much room the words
   * need without re-deriving the rule: `label` = a short name a person authored
   * (`@business`), `route` = the identifier is only an HTTP verb and the words
   * are its route's, `docs` = a sentence out of the documentation.
   * Absent when `title` is — and on a run-time choice, whose words are the
   * sentence every candidate shares: no single node's provenance speaks for the group.
   */
  titleFrom?: 'label' | 'route' | 'docs';
  /** for a route: the HTTP method + path the contract or the code names */
  method?: string;
  /**
   * call markers only: the code that made this call names no method, several routes serve its path,
   * and the GET one was assumed (`meta.methodAssumed` on the edge) — `method` is the route's, not the code's
   */
  methodAssumed?: 'GET';
  path?: string;
  /**
   * which way data moved: a record marker from its reads/writes edge; an external marker from the
   * HTTP method on the edge that reached it (`opOfMethod`) — absent when the method was not recorded,
   * never a default
   */
  op?: 'reads' | 'writes';
  /** record markers and store-like external markers: the data store, when the graph names it */
  store?: MarkerStore;
}

/**
 * One moment of a screen: a single client-side action (the call the UX makes)
 * and everything it caused, down to the tables it touched. Moments are the
 * sub-columns of a segment — a column reads down as one transaction.
 */
export interface JourneyMoment {
  index: number;
  /** the action as a headline: its `@business` label / spec summary, else its name in words */
  label: string;
  /** the longer sentence behind the headline, when the code carries one */
  business?: string;
  /** inclusive step-order range inside the segment */
  from: number; to: number;
  /** the browser-side function that starts the moment (the screen's step when nothing calls out) */
  actionStep: number;
  /** the `http`/planned step that crosses the seam, when there is one */
  callStep?: number;
  /** the component the action lives in — `stepOrder` before `from` means it stayed open from an earlier moment */
  component?: { id: string; name: string; label: string; stepOrder: number };
  /** the call was already made earlier in this journey */
  repeat: boolean;
  /**
   * display order: the screen manifest's `operations[]` rank of this action's
   * operationId, else after every listed one, in walk order. `moments[]` itself
   * stays in walk order — consumers sort by `rank` (R6).
   */
  rank: number;
  /** the screen's manifest lists this action's operation */
  declared: boolean;
  /** deferred work registered inside this action — the Afterwards row (R2) */
  afterwards: { stepOrder: number; nodeId: string; name: string; title?: string; hostStep: number }[];
  counts: { markers: number; calls: number; planned: number; records: number; messages: number; helpers: number };
}

/**
 * One vertical segment of the blueprint timeline: a screen and everything the
 * walk does until the next screen. Segment 0 may have no screen (the steps
 * before the first screen: a route entry, a queue consumer).
 */
export interface JourneySegment {
  index: number;
  screen: JourneySummary['user'][number] | null;
  /** inclusive step-order range on the journey */
  from: number; to: number;
  markers: SegmentMarker[];
  /** the segment's sub-columns: one per client-side action, in execution order */
  moments: JourneyMoment[];
  /** deduped by name within the segment; count = how many steps met it */
  gates: { id: string; kind: 'guard' | 'rule'; name: string; planned?: true; count: number; stepOrder: number }[];
  /** translated decisions only (class business | guard) — the diamonds the business band draws */
  decisions: JourneySummary['business']['decisions'];
  /** technical conditions inside this segment that were not translated (never drawn, always counted) */
  untranslated: number;
  /** system row keys touched, first-seen order */
  systems: string[];
  /** operations the screen's manifest lists that no action in this segment made: dotted stops (R6) */
  declaredOnly: { op: string; routeId?: string; label: string }[];
  /** this segment's cut points as a list, each named where it happened (R24) */
  cutPoints: { parentStep: number; nodeId: string; name: string; reason: JourneyCutPoint['reason']; moment: number }[];
  /**
   * `gates` = distinct checkpoints, `checks` = how many times the walk met one
   * (Σ gate counts); `setup`/`deferred` = the boot and the later work named here.
   */
  counts: { markers: number; calls: number; planned: number; gates: number; checks: number; decisions: number; records: number; messages: number; cutPoints: number; repeats: number; setup: number; deferred: number };
  /** this screen's numbers as typed counts, scoped `on this screen` (core/journey-counted.ts, docs/COUNTS.md) */
  counted?: SegmentCounted;
  /**
   * the absence word of every empty cell on this screen, decided once
   * (`journeyAbsence`, core/journey-counted.ts): every view prints this word for
   * the same (action, layer) fact and never chooses its own. Always set by
   * `journeySummary()`; optional only so an older summary still type-checks.
   */
  absent?: SegmentAbsence;
}

/** Another journey this one is joined to — a flow, by declaration or derived from a longer flow's screen order. */
export interface JourneyLinkRef {
  id: string;
  name: string;
  designId?: string;
  screens: number;
  built: number;
  how: 'declared' | 'derived';
}

/** The blueprint summary of a journey: what the user sees · the business · what the system does · records & messages. */
export interface JourneySummary {
  entry: { id: string; kind: GraphNode['kind']; name: string; business?: string };
  /** what tests verify this journey and each segment (core/coverage.ts) — absent when the graph has no test nodes */
  coverage?: JourneyCoverage;
  /** band 1 — screens in order (the entry when it is a screen; a flow's screens; else the pages upstream) */
  user: { id: string; name: string; kind: GraphNode['kind']; business?: string; designId?: string; designStatus?: string; hasImage: boolean; links: NonNullable<GraphNode['links']>; components: string[]; loc?: GraphNode['loc'] }[];
  /** band 2 — the plain-language story: description, documents, the rules and gates in force, the decisions along the way */
  business: {
    description?: string;
    docs: NonNullable<GraphNode['links']>;
    gates: { id: string; name: string; planned?: true; appliesTo: string }[];
    rules: { id: string; name: string; appliesTo: string }[];
    /** translated decisions only: class business | guard, in walk order, deduped by fork + arm */
    decisions: { nodeId: string; line: number; label: string; arm: string; class: DecisionClass; stepOrder: number }[];
    /**
     * what was NOT translated, counted by branch category — never drawn as a diamond.
     * `guardsUnlabelled` = guard-class decisions nobody wrote a `@business` label for:
     * the business register folds those into the same sentence (R11), and counts them
     * here so the HUD and MCP print one number.
     */
    untranslated: {
      count: number; byCategory: Partial<Record<BranchCategory, number>>; guardsUnlabelled: number;
      /**
       * The technical conditions themselves, one each, in walk order — the list the
       * "not in plain language" sentence promises is behind it. `name` is the caller
       * whose fork it is; `requires` is code and never printed in the business lens.
       * The gate conditions nobody labelled are the `decisions` of class guard.
       */
      items: UntranslatedCondition[];
    };
  };
  /** band 3 — the system timeline in execution order, plus what it produces */
  system: {
    timeline: TimelineItem[];
    /** `store` when the graph names the store the record lives in */
    records: { id: string; name: string; ops: ('reads' | 'writes')[]; store?: MarkerStore }[];
    messages: { id: string; name: string }[];
    /** `ops` from the HTTP methods of the edges that reached it (`opOfMethod`); `store` when it is used as a data store */
    externals: { id: string; name: string; ops: ('reads' | 'writes')[]; store?: MarkerStore }[];
    /**
     * the data stores the journey touches, each once by name, first-seen order: `records` = distinct
     * record nodes that live in it, `externals` = store-like external nodes that are it (an ERP is 1),
     * `ops` = the union of their directions. Records with no named store are not here.
     */
    stores: { name: string; kind: StoreKind; records: number; externals: number; ops: ('reads' | 'writes')[] }[];
    /** work registered on this journey that runs later, on its own — named, never walked (R2) */
    afterwards: { id: string; name: string }[];
    repos: string[];
  };
  /** the timeline as segments (one per screen) over the system rows — the layout the HUD draws and the MCP prints */
  segments: JourneySegment[];
  /** every system the journey touches, first-seen order — the rows of the blueprint timeline */
  systems: SystemRow[];
  /** journeys this one is joined to: what must happen before, what follows, what it is part of */
  links: { requires: JourneyLinkRef[]; leadsTo: JourneyLinkRef[]; partOf: JourneyLinkRef[] };
  /**
   * counts.gates = distinct gates by name (what the header prints), not gate edges,
   * and counts.checks = how many times the walk met one (Σ segment gate counts);
   * counts.setup / counts.deferred = the boot printed once and the work named as
   * running afterwards;
   * counts.decisions = translated only; counts.cutPoints = what the reader has NOT seen
   * (depth + steps), and counts.repeats = re-visits the walk did not re-walk — those were
   * drawn earlier, so they never inflate the cut-point number.
   *
   * counts.called / counts.declaredNotCalled = the flow's operations split by
   * whether **code** makes the call, each operation counted **once** however
   * many screens reach it. An action whose own call step is a `via:'planned'`
   * continuation of a declared route is declared, not called — no code performs
   * it — and it joins the operations a screen's manifest lists that no action
   * made at all (`segment.declaredOnly`). Counting every action as *called* is
   * how a flow with nothing built came to print `7 called` (swarm 2026-09-23,
   * blocker 1); counting every *occurrence* is how one flow printed `31` where
   * another surface printed `15` (visual swarm 2026-09-24). An action with no
   * call step at all — the placeholder a screen without an API call gets — is
   * neither.
   *
   * counts.again = how many of those calls the journey makes a second time, on a
   * later screen: the ↺ the band draws and the *actions n–m again* card the
   * storyboard draws, as a number. `called + again` is the occurrence total, so
   * nothing is lost by counting the operation once — and neither number is ever
   * printed under the other's word.
   *
   * counts.choices = call sites where several implementations sit behind one
   * written call (`journeyChoices`). Those candidates are steps of the walk —
   * `counts.steps` counts every one of them, as it counts every re-visit — but
   * the band draws one place per call site, and this is the number that says
   * how many of those places there are.
   */
  /**
   * whether this graph records transaction boundaries at all (any edge stamped
   * `meta.tx`). False = unknown, never "there are none": a graph written before
   * the parser recorded them and a codebase that opens none read the same here,
   * and a consumer must say so rather than guess a side.
   */
  txKnown: boolean;
  counts: { screens: number; steps: number; planned: number; gates: number; checks: number; decisions: number; records: number; messages: number; segments: number; cutPoints: number; repeats: number; setup: number; deferred: number; called: number; again: number; declaredNotCalled: number; choices: number };
  /**
   * Every number the header, the lane's tabs and the drill print, as typed
   * counts: the number, its words in each lens, the scope it counts over and
   * the field it came from (core/journey-counted.ts, docs/COUNTS.md). Always
   * set by `journeySummary()`; optional only so a summary from an older build
   * still type-checks.
   */
  counted?: JourneyCounted;
  /** the layers the whole journey has none of, with their word (`noneIndexed`) — the drill's always-present rows */
  absentKinds?: Partial<Record<AbsenceKind, AbsenceWord>>;
}

/** A flow's screens in the order a person meets them (its `renders` edges by meta.line). */
export function flowScreenIds(index: GraphIndex, flowId: string): string[] {
  return (index.out.get(flowId) ?? [])
    .filter((e) => e.kind === 'renders')
    .sort((a, b) => (Number(a.meta?.line) || 0) - (Number(b.meta?.line) || 0))
    .map((e) => e.to);
}

/** Index of `needle` as a contiguous run inside `hay`, or -1. */
function runIndex(hay: string[], needle: string[]): number {
  if (!needle.length || needle.length > hay.length) return -1;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

function linkRef(index: GraphIndex, flow: GraphNode, how: JourneyLinkRef['how']): JourneyLinkRef {
  const ids = flowScreenIds(index, flow.id);
  const built = ids.filter((id) => !!index.byId.get(id)?.loc).length;
  return { id: flow.id, name: flow.facets?.business?.label ?? flow.name, ...(flow.design?.id ? { designId: flow.design.id } : {}), screens: ids.length, built, how };
}

/**
 * The journeys this entry is joined to. Declared: the manifest's
 * `flows[].requires` / `flows[].leadsTo` (flow ids). Derived: a longer flow
 * that contains this flow's screens as a run — the flow whose screens end just
 * before the run is a prerequisite, the one whose screens start just after it
 * is what follows, and the container itself is what this is part of. A screen
 * entry is part of every flow that renders it. Nothing is invented: no
 * declaration and no containing flow → no links.
 */
export function journeyLinks(index: GraphIndex, entryId: string): JourneySummary['links'] {
  const entry = index.byId.get(entryId);
  const out: JourneySummary['links'] = { requires: [], leadsTo: [], partOf: [] };
  if (!entry) return out;
  const repo = repoOf(entry);
  const flows = [...index.byId.values()].filter((n) => n.kind === 'flow' && n.id !== entryId && repoOf(n) === repo);
  const add = (list: JourneyLinkRef[], flow: GraphNode, how: JourneyLinkRef['how']) => {
    if (!list.some((l) => l.id === flow.id)) list.push(linkRef(index, flow, how));
  };
  const byDesignId = new Map(flows.map((f) => [f.design?.id?.toLowerCase() ?? '', f] as const));
  for (const id of entry.design?.requires ?? []) { const f = byDesignId.get(id.toLowerCase()); if (f) add(out.requires, f, 'declared'); }
  for (const id of entry.design?.leadsTo ?? []) { const f = byDesignId.get(id.toLowerCase()); if (f) add(out.leadsTo, f, 'declared'); }
  const mine = entry.kind === 'flow' ? flowScreenIds(index, entryId) : (entry.kind === 'page' || entry.kind === 'component') ? [entryId] : [];
  if (!mine.length) return out;
  const screensOf = new Map(flows.map((f) => [f.id, flowScreenIds(index, f.id)] as const));
  for (const container of flows) {
    const cs = screensOf.get(container.id)!;
    const at = runIndex(cs, mine);
    if (at < 0 || cs.length === mine.length) continue; // not inside, or the same journey under another name
    add(out.partOf, container, 'derived');
    const before = at > 0 ? cs[at - 1] : undefined, after = cs[at + mine.length];
    for (const other of flows) {
      if (other.id === container.id) continue;
      const os = screensOf.get(other.id)!;
      if (!os.length) continue;
      if (before && os[os.length - 1] === before && runIndex(cs, os) >= 0) add(out.requires, other, 'derived');
      if (after && os[0] === after && runIndex(cs, os) >= 0) add(out.leadsTo, other, 'derived');
    }
  }
  return out;
}

/** "GET /api/v1/x" → { method, path } for a route marker; undefined when the name has no method. */
function routeMethodPath(name: string): { method: string; path: string } | undefined {
  const m = /^([A-Z]+)\s+(\S+)/.exec(name || '');
  return m ? { method: m[1]!, path: m[2]! } : undefined;
}

/**
 * The system row a timeline node belongs to (see SystemRow). A repo splits in
 * two at the HTTP seam — the browser code that asks and the server code that
 * answers are two systems at runtime, and duplicate function names stop being
 * ambiguous once the row says which side. Every route lands on an API row,
 * spec-backed or implied, so every call gets a seam card.
 */
function systemOf(index: GraphIndex, n: GraphNode, kind: TimelineItem['kind'], side: 'ux' | 'server'): Omit<SystemRow, 'planned'> {
  if (kind === 'record') return { key: 'records', kind: 'records', label: 'records' };
  if (kind === 'message') return { key: 'messages', kind: 'messages', label: 'messages' };
  if (kind === 'external') {
    // mail and queues ARE messages to a reader — one node, a lens choice in the fold;
    // every other third party keeps its own row, and says what kind of system it is
    const ext = n.external?.kind;
    if (ext === 'email' || ext === 'queue') return { key: 'messages', kind: 'messages', label: 'messages' };
    const store = markerStoreOf(n);
    return { key: `external:${n.name}`, kind: 'external', label: n.name, ...(ext ? { externalKind: ext } : {}), ...(store ? { store } : {}) };
  }
  // the boot belongs to the process that runs it, never to the browser that waited for it
  if (kind === 'setup') { const repo = repoOf(n); return { key: `repo:${repo}:server`, kind: 'repo', side: 'server', label: repo }; }
  if (kind === 'deferred') return { key: 'afterwards', kind: 'afterwards', label: 'afterwards' };
  if (n.kind === 'route') {
    if (n.contract?.apiId) {
      const api = index.byId.get(n.contract.apiId);
      return { key: `api:${n.contract.apiId}`, kind: 'api', label: api?.name ?? n.contract.apiId };
    }
    const repo = repoOf(n);
    return { key: `api:repo:${repo}`, kind: 'api', label: `${repo} · routes` };
  }
  const repo = repoOf(n);
  return { key: `repo:${repo}:${side}`, kind: 'repo', side, label: repo };
}

/** The stores a journey touches, each once by name, in first-seen order (records first, then externals). */
function storesOf(
  records: Map<string, JourneySummary['system']['records'][number]>,
  externals: Map<string, JourneySummary['system']['externals'][number]>,
): JourneySummary['system']['stores'] {
  const out = new Map<string, JourneySummary['system']['stores'][number]>();
  const add = (store: MarkerStore | undefined, ops: ('reads' | 'writes')[], field: 'records' | 'externals') => {
    if (!store) return;
    const have = out.get(store.name) ?? { name: store.name, kind: store.kind, records: 0, externals: 0, ops: [] };
    have[field]++;
    for (const op of ops) if (!have.ops.includes(op)) have.ops.push(op);
    out.set(store.name, have);
  };
  for (const r of records.values()) add(r.store, r.ops, 'records');
  for (const x of externals.values()) add(x.store, x.ops, 'externals');
  return [...out.values()];
}

/** The `records` row names a store only when every record marker of the journey lives in that one store. */
function withRecordsStore(rows: SystemRow[], segments: JourneySegment[]): SystemRow[] {
  const row = rows.find((r) => r.key === 'records');
  if (!row) return rows;
  const marks = segments.flatMap((sg) => sg.markers).filter((m) => m.system === 'records');
  const names = new Set(marks.map((m) => m.store?.name ?? ''));
  if (marks.length && names.size === 1 && !names.has('')) row.store = marks[0]!.store!;
  return rows;
}

/** The request path read downward: what the screen asks → the contract → what the service does → what it touched. */
const SYSTEM_RANK: Record<string, number> = { ux: 0, api: 1, server: 2, records: 3, messages: 4, external: 5, afterwards: 6 };

/** Where a system row sits on the request path (see SYSTEM_RANK). */
function systemRank(r: SystemRow): number {
  return SYSTEM_RANK[r.kind === 'repo' ? (r.side ?? 'server') : r.kind] ?? 9;
}

/**
 * The words a bare identifier reads as — `listInvoices` → `List invoices`,
 * `GET /invoices` → `View invoices`. The same rewrite the HUD applies, kept
 * here so a moment label reads the same in the HUD, the CLI and MCP.
 */
export function humanizeName(name: string): string {
  const VERBS: Record<string, string> = { GET: 'View ', POST: 'Submit ', PATCH: 'Update ', PUT: 'Replace ', DELETE: 'Remove ' };
  return String(name || '')
    .replace(/^(GET|POST|PATCH|PUT|DELETE) /, (m) => VERBS[m.trim()] ?? m)
    .replace(/\/:param/g, '').replace(/^\//, '').replace(/\//g, ' ')
    .replace(/\.[tj]sx?$/, '').replace(/.*\bsrc /, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()
    .toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

/**
 * Fold a journey into the three bands the blueprint draws (and the MCP prints):
 * pure over the index + the journey, so the HUD and the agent surface never
 * disagree about what a feature is made of. Screens come from `screens`
 * (screensFor); everything else is derived from the steps.
 */
export function journeySummary(index: GraphIndex, j: Journey, screens: GraphNode[]): JourneySummary {
  return withJourneyCoverage(index, j, withJourneyCounted(j, buildJourneySummary(index, j, screens)));
}

function buildJourneySummary(index: GraphIndex, j: Journey, screens: GraphNode[]): JourneySummary {
  const entry = index.byId.get(j.entryId);
  const nameOf = (n: GraphNode) => n.facets?.business?.label ?? n.name;
  const timeline: TimelineItem[] = [];
  const gates = new Map<string, JourneySummary['business']['gates'][number]>();
  const rules = new Map<string, JourneySummary['business']['rules'][number]>();
  const decisions: JourneySummary['business']['decisions'] = [];
  const seenDecision = new Set<string>();
  /** the technical conditions the business band refuses to draw: where they were, and what kind they are */
  const untranslated: UntranslatedCondition[] = [];
  const records = new Map<string, JourneySummary['system']['records'][number]>();
  const messages = new Map<string, { id: string; name: string }>();
  const externals = new Map<string, JourneySummary['system']['externals'][number]>();
  /** the edge a step arrived over — its meta carries the HTTP method an external marker reads its direction from */
  const edgeOfStep = (s: JourneyStep, n: GraphNode): GraphEdge | undefined =>
    s.edgeId ? (index.in.get(n.id) ?? []).find((e) => e.id === s.edgeId) : undefined;
  /** deferred work: named where it was registered, never walked */
  const afterwards = new Map<string, { id: string; name: string }>();
  const repos = new Set<string>();
  const routeFor = makeRouteForOperation(index);

  // ── the seam: which step called which, and which side of the HTTP boundary each runs on ──
  // Pre-order guarantees a parent is emitted before its children, so a stack indexed by
  // depth always holds the running parent chain.
  const stepById = new Map(j.steps.map((st) => [st.order, st] as const));
  const nodeAt = (order: number): GraphNode | undefined => index.byId.get(stepById.get(order)?.nodeId ?? '');
  const parentOf = new Map<number, number>();
  {
    const chain: number[] = [];
    for (const s of j.steps) { chain[s.depth] = s.order; parentOf.set(s.order, s.depth > 0 ? (chain[s.depth - 1] ?? -1) : -1); }
  }
  // a step is server-side when it (or anything above it) crossed an http/consumes edge or is a
  // route; a journey that does not start on a screen is server-side end to end (no browser row).
  const entryIsScreen = !!entry && (entry.kind === 'page' || entry.kind === 'component' || entry.kind === 'flow');
  const serverSide = new Map<number, boolean>();
  for (const s of j.steps) {
    const n = index.byId.get(s.nodeId);
    const p = parentOf.get(s.order) ?? -1;
    const above = p >= 0 ? (serverSide.get(p) ?? false) : !entryIsScreen;
    serverSide.set(s.order, above || s.via === 'http' || s.via === 'consumes' || n?.kind === 'route');
  }
  const sideOf = (order: number): 'ux' | 'server' => (serverSide.get(order) ? 'server' : 'ux');
  /** One end of the seam from a step: its node, and where the code sits (its call site, else its own loc). */
  const seamEnd = (order: number, at?: { path: string; line: number }): SeamEnd | undefined => {
    const st = stepById.get(order);
    const n = st && index.byId.get(st.nodeId);
    if (!st || !n) return undefined;
    const where = at ?? (n.loc ? { path: n.loc.path, line: n.loc.line } : undefined);
    if (!where) return undefined;
    return { nodeId: n.id, name: nameOf(n), repo: repoOf(n), path: where.path, line: where.line };
  };

  // ── run-time choices: one written call, several implementations ─────────
  // The walk drew a step per implementer (they are all reachable code). The band
  // draws the call **once**: the first candidate carries the marker, the rest are
  // named on it, and whatever they reached hangs under it. Their steps stay in the
  // walk, so the code view and the coverage scope are unchanged.
  const choiceAt = journeyChoices(index, j);
  // the transaction boundary: one decision, read by the band, the drill and the agent alike
  const tx = journeyTransactions(index, j);
  /** candidate step orders that do not get a marker of their own */
  const absorbed = new Set<number>();
  /** an absorbed candidate's step order → the step that carries the fold */
  const headOf = new Map<number, number>();
  for (const [order, ch] of choiceAt) {
    const head = ch.candidates[0]!.stepOrder;
    if (order === head) continue;
    absorbed.add(order);
    headOf.set(order, head);
  }

  // Does anything under this node leave the code? A call, a table, a queue or a third party is
  // what a reader came for; a function whose whole subtree stays inside the code is plumbing.
  // Judged per node over the whole walk, so a re-visit (whose subtree was not walked again)
  // folds or stays exactly as its first appearance did. Pre-order means a step's subtree is
  // the run of deeper steps after it.
  const reachesOut = new Set<string>();
  {
    const own = j.steps.map((s) => {
      const n = index.byId.get(s.nodeId);
      return !!n && (s.via === 'http' || n.kind === 'route' || n.kind === 'table' || n.kind === 'queue' || n.kind === 'external' || n.kind === 'unknown');
    });
    for (let i = 0; i < j.steps.length; i++) {
      for (let k = i + 1; k < j.steps.length && j.steps[k]!.depth > j.steps[i]!.depth; k++) {
        if (own[k]) { reachesOut.add(j.steps[i]!.nodeId); break; }
      }
    }
  }

  for (const s of j.steps) {
    const n = index.byId.get(s.nodeId);
    if (!n) continue;
    const repo = repoOf(n);
    if (n.loc) repos.add(repo);
    const business = businessSummary(n);
    const base = { order: s.order, depth: s.depth, nodeId: n.id, via: s.via, stepOrder: s.order, ...(business ? { business } : {}), repo };
    if (s.planned && s.planned.kind !== 'calls') {
      timeline.push({ ...base, kind: 'planned', name: s.planned.label, planned: s.planned });
      continue;
    }
    // decisions gating this hop come before the step they gate
    for (const c of s.conditions ?? []) {
      const key = `${c.nodeId}:${c.line}:${c.arm}`;
      if (seenDecision.has(key)) continue;
      seenDecision.add(key);
      // a condition nobody translated is counted, never drawn: `env.DATABASE_URL` is not a business rule.
      // (`class` is absent only on a journey produced by an older build — read that as technical.)
      const cls: DecisionClass = c.class ?? 'technical';
      if (cls === 'technical') { untranslated.push({ stepOrder: s.order, category: c.category ?? 'branch', nodeId: c.nodeId, name: c.name, line: c.line, requires: c.requires }); continue; }
      const label = c.business ?? c.requires;
      decisions.push({ nodeId: c.nodeId, line: c.line, label, arm: c.arm, class: cls, stepOrder: s.order });
      timeline.push({ order: s.order, depth: s.depth, kind: 'decision', nodeId: c.nodeId, name: label, via: s.via, stepOrder: s.order, ...(c.business ? { business: c.business } : {}) });
    }
    for (const g of s.gates) {
      if (g.kind === 'guard') gates.set(g.id, { id: g.id, name: g.name, ...(g.planned ? { planned: true as const } : {}), appliesTo: n.id });
      else rules.set(g.id, { id: g.id, name: g.name, appliesTo: n.id });
      timeline.push({ order: s.order, depth: s.depth, kind: 'gate', nodeId: g.id, name: g.name, via: s.via, stepOrder: s.order, ...(g.planned ? { planned: true as const } : {}) });
    }
    let kind: TimelineItem['kind'] = 'step';
    // the boot and the work that runs afterwards are named as themselves: neither is a
    // record this request wrote, nor a message it sent (01 §2.3.7)
    if (s.setup) kind = 'setup';
    else if (s.deferred) { kind = 'deferred'; afterwards.set(n.id, { id: n.id, name: nameOf(n) }); }
    else if (n.kind === 'page' || n.kind === 'component' || n.kind === 'flow') kind = 'screen';
    else if (n.kind === 'table') {
      kind = 'record';
      const store = markerStoreOf(n);
      const r = records.get(n.id) ?? { id: n.id, name: nameOf(n), ops: [], ...(store ? { store } : {}) };
      if ((s.via === 'reads' || s.via === 'writes') && !r.ops.includes(s.via)) r.ops.push(s.via);
      records.set(n.id, r);
    }
    else if (n.kind === 'queue') { kind = 'message'; messages.set(n.id, { id: n.id, name: nameOf(n) }); }
    else if (n.kind === 'external' || n.kind === 'unknown') {
      kind = 'external';
      const store = markerStoreOf(n);
      const x = externals.get(n.id) ?? { id: n.id, name: nameOf(n), ops: [], ...(store ? { store } : {}) };
      const op = s.via === 'http' ? opOfMethod(edgeOfStep(s, n)?.meta?.method) : undefined;
      if (op && !x.ops.includes(op)) x.ops.push(op);
      externals.set(n.id, x);
    }
    else if (s.via === 'http' || n.kind === 'route') kind = 'call';
    timeline.push({ ...base, kind, name: nameOf(n), ...(s.planned ? { planned: s.planned } : {}) });
  }

  const user = screens.map((n) => ({
    id: n.id, name: nameOf(n), kind: n.kind,
    ...(businessSummary(n) ? { business: businessSummary(n)! } : {}),
    ...(n.design?.id ? { designId: n.design.id } : {}),
    ...(n.design ? { designStatus: n.design.status } : {}),
    hasImage: !!n.design?.image,
    links: n.links ?? [],
    components: (index.out.get(n.id) ?? []).filter((e) => e.kind === 'renders').map((e) => e.to).filter((id) => index.byId.get(id)?.kind === 'component'),
    ...(n.loc ? { loc: n.loc } : {}),
  }));

  // ── segments: one per screen, over the system rows (the blueprint timeline) ──
  const userById = new Map(user.map((u) => [u.id, u] as const));
  const systemRows = new Map<string, SystemRow>();
  const segments: JourneySegment[] = [];
  const newSegment = (screen: JourneySummary['user'][number] | null, from: number): JourneySegment =>
    ({ index: segments.length, screen, from, to: from, markers: [], moments: [], gates: [], decisions: [], untranslated: 0, systems: [], declaredOnly: [], cutPoints: [], counts: { markers: 0, calls: 0, planned: 0, gates: 0, checks: 0, decisions: 0, records: 0, messages: 0, cutPoints: 0, repeats: 0, setup: 0, deferred: 0 } });
  let seg: JourneySegment | null = null;
  for (const row of timeline) {
    const n = index.byId.get(row.nodeId);
    // a screen row opens a segment when it is one of the journey's screens (a flow's screens, or the
    // entry screen); a component rendered inside a screen is a moment of that screen — a marker in the
    // repo row, not a new segment. The flow entry row is the journey itself, not a screen.
    if (row.kind === 'screen' && n && n.kind !== 'flow' && userById.has(row.nodeId)) {
      if (seg) segments.push(seg);
      seg = newSegment(userById.get(row.nodeId) ?? { id: row.nodeId, name: row.name, kind: n.kind, hasImage: !!n.design?.image, links: n.links ?? [], components: [], ...(row.business ? { business: row.business } : {}), ...(n.design?.id ? { designId: n.design.id } : {}), ...(n.design ? { designStatus: n.design.status } : {}), ...(n.loc ? { loc: n.loc } : {}) }, row.stepOrder);
      continue;
    }
    if (row.kind === 'screen' && n && n.kind === 'flow') continue; // the flow entry row
    if (!seg) seg = newSegment(null, row.stepOrder);
    seg.to = Math.max(seg.to, row.stepOrder);
    if (row.kind === 'gate') {
      const st = stepById.get(row.stepOrder);
      const g = st?.gates.find((x) => x.id === row.nodeId);
      const kind: 'guard' | 'rule' = g?.kind === 'rule' ? 'rule' : 'guard';
      const have = seg.gates.find((x) => x.name === row.name && x.kind === kind);
      if (have) have.count++;
      else seg.gates.push({ id: row.nodeId, kind, name: row.name, ...(row.planned ? { planned: true as const } : {}), count: 1, stepOrder: row.stepOrder });
      continue;
    }
    if (row.kind === 'decision') {
      const d = decisions.find((x) => x.nodeId === row.nodeId && x.label === row.name);
      seg.decisions.push(d ?? { nodeId: row.nodeId, line: 0, label: row.name, arm: '', class: 'business', stepOrder: row.stepOrder });
      continue;
    }
    if (row.kind === 'planned') continue; // receives / does / returns hang off their call in the drawer
    if (!n) continue;
    // a candidate of a run-time choice that is not the one carrying the fold: no marker
    // of its own, so no surface can draw one call site as a row of steps
    if (absorbed.has(row.stepOrder)) continue;
    const kind: SegmentMarker['kind'] = row.kind === 'call' ? 'call' : row.kind === 'record' ? 'record' : row.kind === 'message' ? 'message'
      : row.kind === 'external' ? 'external' : row.kind === 'setup' ? 'setup' : row.kind === 'deferred' ? 'deferred' : 'step';
    const side = sideOf(row.stepOrder);
    const sys = systemOf(index, n, row.kind, side);
    const planned = !!row.planned;
    const had = systemRows.get(sys.key);
    if (!had) systemRows.set(sys.key, { ...sys, planned });
    else if (!planned) had.planned = false;
    if (!seg.systems.includes(sys.key)) seg.systems.push(sys.key);
    const st = stepById.get(row.stepOrder);
    const parent = parentOf.get(row.stepOrder) ?? -1;
    // both ends of the seam, read off the neighbouring steps: the fetch line in the browser
    // (this step's call site, inside the client function above it) and where the API starts
    // (the next step when the route calls straight into it, else the route's own registration).
    let caller: SeamEnd | undefined, handler: SeamEnd | undefined;
    if (kind === 'call') {
      if (parent >= 0 && st?.callSite) caller = seamEnd(parent, st.callSite);
      const next = stepById.get(row.stepOrder + 1);
      if (next && next.depth === row.depth + 1 && next.via === 'calls') handler = seamEnd(next.order, next.callSite);
      else if (n.loc) handler = { nodeId: n.id, name: row.name, repo: repoOf(n), path: n.loc.path, line: n.loc.line };
    }
    // the words a non-code register prints: what a person authored, else the spec summary a
    // verb-named handler borrows from its route, else the first sentence of its docs (R7c)
    const parentNode = parent >= 0 ? nodeAt(parent) : undefined;
    const routeWords = ROUTE_VERBS.has(n.name) && parentNode?.kind === 'route'
      ? (parentNode.contract?.summary?.trim() || parentNode.name) : undefined;
    const title = n.facets?.business?.label ?? routeWords ?? businessSummary(n);
    // which of the three it is — a short authored name, the route's words standing
    // in for a meaningless identifier, or a sentence out of the docs
    const titleFrom: SegmentMarker['titleFrom'] | undefined = title === undefined ? undefined
      : n.facets?.business?.label !== undefined ? 'label' : routeWords !== undefined ? 'route' : 'docs';
    const choice = choiceAt.get(row.stepOrder);
    // a choice is drawn as the call the source writes, never as one implementation's
    // name; the authored words survive only where every candidate says the same thing
    // — one implementation's sentence must not speak for the others
    const choiceTitle = choice && choice.candidates.every((c) => c.title && c.title === choice.candidates[0]!.title)
      ? choice.candidates[0]!.title : undefined;
    const m: SegmentMarker = {
      stepOrder: row.stepOrder, depth: row.depth, nodeId: n.id, name: choice ? choice.label : row.name, kind, via: row.via, system: sys.key, moment: 0,
      ...(choice ? { choice } : {}),
      ...((choice ? choiceTitle : title) ? { title: (choice ? choiceTitle : title)!, ...(choice ? {} : { titleFrom: titleFrom! }) } : {}),
      ...(planned ? { planned: true } : {}),
      ...(st?.repeat ? { repeat: true } : {}),
      // `helper` / `under` need the moments to exist (the ux action is a moment's actionStep) — set below
      ...(caller ? { caller } : {}),
      ...(handler ? { handler } : {}),
      // same rule as `title`: one candidate's prose may not stand for the group
      ...(tx.sideOf.get(row.stepOrder) ? { tx: tx.sideOf.get(row.stepOrder)! } : {}),
      ...(row.business && !choice ? { business: row.business } : {}),
      ...(n.kind === 'route' && routeMethodPath(n.name) ? routeMethodPath(n.name) : {}),
      ...(st && (st.via === 'reads' || st.via === 'writes') ? { op: st.via } : {}),
      // an external's direction is the HTTP method on the edge that reached it — unknown stays unsaid
      ...(kind === 'external' && st?.via === 'http' && opOfMethod(edgeOfStep(st, n)?.meta?.method)
        ? { op: opOfMethod(edgeOfStep(st, n)?.meta?.method)! } : {}),
      ...((kind === 'record' || kind === 'external') && markerStoreOf(n) ? { store: markerStoreOf(n)! } : {}),
      ...(kind === 'call' && st?.via === 'http' && edgeOfStep(st, n)?.meta?.methodAssumed === 'GET' ? { methodAssumed: 'GET' as const } : {}),
    };
    seg.markers.push(m);
    seg.counts.markers++;
    if (kind === 'call') seg.counts.calls++;
    if (planned) seg.counts.planned++;
    if (kind === 'record') seg.counts.records++;
    if (kind === 'message') seg.counts.messages++;
    if (kind === 'setup') seg.counts.setup++;
    if (kind === 'deferred') seg.counts.deferred++;
  }
  if (seg) segments.push(seg);
  // `?? []` so a journey deserialized from an older build still folds
  const all = j.cutPoints ?? [];
  // a re-visit hides nothing — its subtree was drawn the first time round — so it is counted
  // apart and never called a cut point
  const cuts = all.filter((c) => c.reason !== 'repeat');
  const repeats = all.filter((c) => c.reason === 'repeat');
  const cutsAt = new Map<number, number>();
  // a cut under an absorbed candidate belongs to the call site that carries the fold —
  // otherwise it would be counted on a marker no surface draws, and silently vanish
  const cutParent = (order: number): number => headOf.get(order) ?? order;
  for (const c of cuts) { const at = cutParent(c.parentStep); cutsAt.set(at, (cutsAt.get(at) ?? 0) + 1); }
  const inSeg = (c: JourneyCutPoint, sg: JourneySegment) => c.parentStep >= sg.from && c.parentStep <= sg.to;
  for (const sg of segments) {
    sg.counts.gates = sg.gates.length;
    // a checkpoint met three times is one gate and three checks — "18 gates · 54 checks"
    sg.counts.checks = sg.gates.reduce((a, g) => a + g.count, 0);
    sg.counts.decisions = sg.decisions.length;
    sg.untranslated = untranslated.filter((u) => u.stepOrder >= sg.from && u.stepOrder <= sg.to).length;
    sg.counts.cutPoints = cuts.filter((c) => inSeg(c, sg)).length;
    sg.counts.repeats = repeats.filter((c) => inSeg(c, sg)).length;
    for (const mk of sg.markers) { const n = cutsAt.get(mk.stepOrder); if (n) mk.cut = n; }
  }

  // ── moments: the sub-columns of a segment ────────────────────────────────
  // Every call that crosses the seam opens a moment at the client-side action that made it —
  // the topmost run of browser functions above it, and the component they live in when no
  // earlier moment already claimed it. The moment runs until the next one starts, so a column
  // reads down as one transaction: what the screen asked → the contract → the handler → the tables.
  // a moment stop is a headline, not a paragraph: the authored `@business` label, else the
  // contract summary a route's authors wrote, else the name in words. The full doc sentence
  // travels beside it as `business`.
  /** a string only when a person actually wrote one — an empty or blank field is an absence */
  const nonEmpty = (x: string | undefined): string | undefined => { const v = x?.trim(); return v || undefined; };
  const shortLabel = (n: GraphNode | undefined): string =>
    n ? (n.facets?.business?.label ?? n.contract?.summary?.trim() ?? humanizeName(n.name)) : '';
  for (const sg of segments) {
    const claimed = new Set<number>();
    const opens: { from: number; actionStep: number; callStep: number }[] = [];
    for (const mk of sg.markers) {
      const st = stepById.get(mk.stepOrder);
      if (!st) continue;
      if (!(st.via === 'http' || (st.via === 'planned' && st.planned?.kind === 'calls'))) continue;
      // a third party the server reached (BcClient.request → Business Central) is a marker of the
      // action that caused it, never a client-side action of its own — only a call that crosses
      // the seam into this repo's API opens a moment
      if (mk.kind === 'external') continue;
      const chain: number[] = [];
      for (let p = parentOf.get(mk.stepOrder) ?? -1; p >= sg.from && !serverSide.get(p) && !claimed.has(p); p = parentOf.get(p) ?? -1) {
        const pn = nodeAt(p);
        if (!pn) break;
        if (pn.kind === 'function') { chain.push(p); continue; }
        if (pn.kind === 'component') { chain.push(p); }
        break;
      }
      const fns = chain.filter((o) => nodeAt(o)?.kind === 'function');
      const actionStep = fns.length ? fns[fns.length - 1]! : mk.stepOrder;
      let from = chain.length ? chain[chain.length - 1]! : mk.stepOrder;
      if (opens.length && from <= opens[opens.length - 1]!.from) from = mk.stepOrder;
      for (const o of chain) claimed.add(o);
      claimed.add(from);
      opens.push({ from, actionStep, callStep: mk.stepOrder });
    }
    const zero = () => ({ markers: 0, calls: 0, planned: 0, records: 0, messages: 0, helpers: 0 });
    // the operations the screen's own manifest says it uses: they rank the actions, and the
    // ones no action made are the segment's dotted stops (R6)
    const listedOps = (sg.screen ? index.byId.get(sg.screen.id)?.design?.operations : undefined) ?? [];
    const opOf = (order?: number): string | undefined => (order == null ? undefined : nodeAt(order)?.contract?.spec?.operationId);
    const moments: JourneyMoment[] = opens.map((o, i) => {
      const an = nodeAt(o.actionStep), cn = nodeAt(o.callStep);
      const opId = opOf(o.callStep);
      const at = opId ? listedOps.indexOf(opId) : -1;
      let component: JourneyMoment['component'];
      for (let p = parentOf.get(o.actionStep) ?? -1; p >= 0; p = parentOf.get(p) ?? -1) {
        const pn = nodeAt(p);
        if (!pn || pn.kind === 'page' || pn.kind === 'flow') break;
        if (pn.kind === 'component') { component = { id: pn.id, name: pn.name, label: shortLabel(pn), stepOrder: p }; break; }
      }
      // the headline a person wrote wins; then the summary the API's authors wrote for this
      // operation — a spec sentence beats a humanized client identifier (R6)
      const label = nonEmpty(an?.facets?.business?.label)
        ?? nonEmpty(cn?.contract?.summary)
        ?? nonEmpty(cn?.facets?.business?.label)
        ?? (an ? humanizeName(an.name) : shortLabel(cn));
      const prose = (an && businessSummary(an)) || (cn && businessSummary(cn)) || undefined;
      return {
        index: i, label,
        from: o.from, to: o.from, actionStep: o.actionStep, callStep: o.callStep,
        ...(component ? { component } : {}),
        ...(prose && prose !== label ? { business: prose } : {}),
        repeat: !!stepById.get(o.callStep)?.repeat,
        rank: at >= 0 ? at : listedOps.length + i, declared: at >= 0, afterwards: [], counts: zero(),
      };
    });
    if (!moments.length) {
      moments.push({ index: 0, label: sg.screen?.name ?? (entry ? nameOf(entry) : ''), from: sg.from, to: sg.to, actionStep: sg.from, repeat: false, rank: 0, declared: false, afterwards: [], counts: zero() });
    } else {
      moments.forEach((mo, i) => { mo.to = i + 1 < moments.length ? moments[i + 1]!.from - 1 : sg.to; });
      moments[0]!.from = Math.min(moments[0]!.from, sg.from);
    }
    sg.moments = moments;
    // an operation the manifest lists that no action made: declared, not reached here
    const made = new Set(moments.map((mo) => opOf(mo.callStep)).filter((x): x is string => !!x));
    sg.declaredOnly = listedOps.filter((op) => !made.has(op)).map((op) => {
      const rt = routeFor(op);
      return { op, ...(rt ? { routeId: rt.id } : {}), label: nonEmpty(rt?.contract?.summary) ?? op };
    });
    for (const mk of sg.markers) {
      let at = 0;
      for (let k = moments.length - 1; k >= 0; k--) if (mk.stepOrder >= moments[k]!.from) { at = k; break; }
      mk.moment = at;
      const c = moments[at]!.counts;
      c.markers++;
      if (mk.kind === 'call') c.calls++;
      if (mk.planned) c.planned++;
      if (mk.kind === 'record') c.records++;
      if (mk.kind === 'message') c.messages++;
      // deferred work is listed against the action that registered it, with the step that did
      if (mk.kind === 'deferred') {
        moments[at]!.afterwards.push({
          stepOrder: mk.stepOrder, nodeId: mk.nodeId, name: mk.name,
          ...(mk.title ? { title: mk.title } : {}),
          hostStep: parentOf.get(mk.stepOrder) ?? -1,
        });
      }
    }
    // the same cuts the chip counts, as a list a reader can open (R24)
    sg.cutPoints = cuts.filter((c) => inSeg(c, sg)).map((c) => ({
      parentStep: cutParent(c.parentStep), nodeId: c.nodeId,
      name: index.byId.get(c.nodeId) ? nameOf(index.byId.get(c.nodeId)!) : c.nodeId,
      reason: c.reason,
      moment: sg.markers.find((mk) => mk.stepOrder === cutParent(c.parentStep))?.moment ?? 0,
    }));

    // ── the helper fold: plumbing folds under the thing that used it ──────
    // A step marker is plumbing when another function on the same side of the seam called it,
    // it is not the action that opened the moment (nor the handler under the route), nobody
    // wrote business text for it, and nothing under it leaves the code. So `apiBase ·
    // readJson · assertOk` fold, while a function that reads a table — or that a person
    // labelled or described — stays a step, with its own helpers folded beneath it.
    // Authored prose counts, not just a glossary label, because a repo whose data layer the
    // parser has not resolved yet (the reference app: no table or queue nodes at all, so nothing below
    // the seam can "reach outside") would otherwise fold its whole service into the route.
    // Calls, records, messages and externals are never folded; they hang off their nearest
    // non-helper ancestor so a table a helper wrote still shows in the records row.
    const markerAt = new Map(sg.markers.map((mk) => [mk.stepOrder, mk] as const));
    for (const mk of sg.markers) {
      if (mk.kind !== 'step') continue;
      const p = parentOf.get(mk.stepOrder) ?? -1;
      // the part above it may be a function or a walked guard (a @guard with a body is
      // both the checkpoint and the work — the reference app's submitDraftInvoice); a route, page or
      // component above a step is the action itself, never a part whose plumbing folds
      const pk = nodeAt(p)?.kind;
      if (p < 0 || (pk !== 'function' && pk !== 'guard')) continue;
      if (sideOf(p) !== sideOf(mk.stepOrder)) continue;
      if (moments[mk.moment]?.actionStep === mk.stepOrder) continue;
      // declared plumbing (farsight.config.json → plumbing) is a helper whatever it says about
      // itself and whatever it reaches: the transport a repo wrote once is not a step of anyone's
      // journey (R7b). What it reached still hangs under the part that used it.
      // a choice marker stands for every candidate: it is plumbing only when all of them
      // are, it is authored when any of them is, and it reaches out when any of them does
      const own = mk.choice ? mk.choice.candidates.map((c) => index.byId.get(c.nodeId)) : [nodeAt(mk.stepOrder)];
      if (own.every((x) => x?.tags?.includes('plumbing'))) { mk.helper = true; moments[mk.moment]!.counts.helpers++; continue; }
      if (own.some((x) => x?.facets?.business?.label || x?.facets?.business?.description)) continue; // a person named or described it: not plumbing
      if (own.some((x) => x && reachesOut.has(x.id))) continue; // it reaches a call, a table, a queue, a third party
      mk.helper = true;
      moments[mk.moment]!.counts.helpers++;
    }
    // ── the drill tree: every marker hangs under the part that used it ────
    // `under` is the nearest ancestor marker that is not a helper (a helper's own callees hang
    // under whatever used the helper, so one chip opens all the plumbing at once). `tier` counts
    // those hops inside one cell of the band — the same system row, the same moment, stopping at
    // the moment's component, which is the cell's span header — so tier 0 is the handler under
    // the route or the action in the browser, tier 1 the parts they call (a service, a store,
    // a formatter), and anything deeper is a drill-down under its part. Nothing is dropped:
    // a consumer draws the top two tiers and folds the rest under the marker they belong to,
    // while the spliced code view still shows the whole subtree in order.
    for (const mk of sg.markers) {
      for (let p = parentOf.get(mk.stepOrder) ?? -1; p >= sg.from; p = parentOf.get(p) ?? -1) {
        const anc = markerAt.get(p);
        if (!anc || anc.helper) continue;             // skip steps with no marker, and helpers themselves
        mk.under = anc.stepOrder;
        break;
      }
    }
    const tierOf = new Map<number, number>();
    const tierFor = (mk: SegmentMarker): number => {
      const have = tierOf.get(mk.stepOrder);
      if (have != null) return have;
      const up = mk.under != null ? markerAt.get(mk.under) : undefined;
      const root = !up || up.system !== mk.system || up.moment !== mk.moment || moments[mk.moment]?.component?.stepOrder === up.stepOrder;
      const t = root ? 0 : tierFor(up) + 1;
      tierOf.set(mk.stepOrder, t);
      return t;
    };
    for (const mk of sg.markers) mk.tier = tierFor(mk);
  }
  const distinctGates = new Set([...gates.values()].map((g) => `guard:${g.name}`).concat([...rules.values()].map((r) => `rule:${r.name}`)));

  const entryBusiness = entry ? businessSummary(entry) : undefined;
  return {
    entry: { id: j.entryId, kind: entry?.kind ?? 'unknown', name: entry ? nameOf(entry) : j.entryId, ...(entryBusiness ? { business: entryBusiness } : {}) },
    user,
    business: {
      ...(entryBusiness ? { description: entryBusiness } : {}),
      docs: [...(entry?.links ?? []), ...screens.flatMap((s) => s.links ?? [])].filter((l, i, arr) => arr.findIndex((x) => (x.url ?? x.ref) === (l.url ?? l.ref)) === i),
      gates: [...gates.values()], rules: [...rules.values()], decisions,
      untranslated: {
        count: untranslated.length,
        byCategory: untranslated.reduce<Partial<Record<BranchCategory, number>>>((acc, u) => { acc[u.category] = (acc[u.category] ?? 0) + 1; return acc; }, {}),
        // a guard-class decision is drawn only where its predicate is the point (code, hybrid);
        // the business register folds it into the "not translated" sentence, from this number
        guardsUnlabelled: decisions.filter((d) => d.class === 'guard').length,
        items: untranslated,
      },
    },
    system: { timeline, records: [...records.values()], messages: [...messages.values()], externals: [...externals.values()], stores: storesOf(records, externals), afterwards: [...afterwards.values()], repos: [...repos] },
    segments,
    // rank first (the request path read downward), first-seen inside a rank
    systems: withRecordsStore([...systemRows.values()], segments).sort((a, b) => systemRank(a) - systemRank(b)),
    links: journeyLinks(index, j.entryId),
    txKnown: tx.known,
    counts: {
      screens: user.length, steps: j.steps.length - j.plannedCount, planned: j.plannedCount,
      gates: distinctGates.size, checks: segments.reduce((a, sg) => a + sg.counts.checks, 0),
      decisions: decisions.length, records: records.size, messages: messages.size, segments: segments.length,
      cutPoints: cuts.length, repeats: repeats.length,
      // Count call SITES, not markers. `choiceAt` is keyed by step order, so one call
      // site the walk reaches twice yielded two objects and the header said "4 places"
      // where the source has 2 — the same fault (counting the wrong thing and giving it
      // a confident noun) that this phase fixed on the front door, inside the chunk that
      // fixed the fan-out. `JourneyChoice.id` is the call site's own identity.
      choices: new Set([...choiceAt.values()].map((c) => c.id)).size,
      setup: j.steps.filter((st) => st.setup).length, deferred: j.steps.filter((st) => st.deferred).length,
      ...operationCounts(j, segments),
    },
  };
}

/**
 * The flow's operations split by who performs them, each counted **once**:
 * *called* = an operation real code calls, *declared, not called* = one whose
 * only call step is the planned continuation of a declared route, plus every
 * operation a screen's manifest lists that no action made. One number may never
 * absorb the other — they are different claims about the product (blocker 1).
 *
 * The identity is the operation, not the occurrence. An action is *one call to
 * the API and the work behind it* (`journey.unit.action`), so the call names the
 * action: the same operation reached again on a later screen is the same thing a
 * person can do, which the walk already marks `repeat` and the band already
 * draws with ↺ and *already run earlier*. Counting occurrences is how the
 * submission flow's header came to say `19 things the user can do` above nine
 * cards captioned *actions 1–9 again*, and how a POC flow read `31` on one
 * surface and `15` on another (visual swarm 2026-09-24). Those occurrences are
 * not thrown away: `again` counts them, and `again + called` is the occurrence
 * total any older reading printed.
 *
 * `declaredNotCalled` deduplicates across screens for the same reason — two
 * screens declaring one operation declare one operation.
 */
function operationCounts(j: Journey, segments: JourneySegment[]): { called: number; again: number; declaredNotCalled: number } {
  const stepAt = new Map(j.steps.map((st) => [st.order, st] as const));
  const withCall = segments.flatMap((sg) => sg.moments).filter((mo) => mo.callStep != null);
  const real = withCall.filter((mo) => stepAt.get(mo.callStep!)?.via !== 'planned');
  const called = new Set(real.map((mo) => stepAt.get(mo.callStep!)!.nodeId));
  // a planned continuation performs nothing, and a manifest operation no action made
  // is the same claim from the other side: both are declared. Identity is the route
  // node where the spec resolved one, the operationId where it did not.
  const notCalled = new Set([
    ...withCall.filter((mo) => !real.includes(mo)).map((mo) => stepAt.get(mo.callStep!)!.nodeId),
    ...segments.flatMap((sg) => sg.declaredOnly.map((d) => d.routeId ?? d.op)),
  ].filter((id) => !called.has(id)));
  return {
    called: called.size,
    again: real.filter((mo) => mo.repeat).length,
    declaredNotCalled: notCalled.size,
  };
}
