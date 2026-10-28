// Bounded static call paths over one source's parser analysis (PR 18, ADR 36). One index is built per analysis
// artifact; a query walks the parser's call, http and render edges breadth-first from one node towards another within
// explicit bounds, and answers reached (with the shortest path and its captured call sites), not reached with nothing
// left unexplored, or not reached within the bounds (with the frontiers it met). Cycles terminate: each node is
// visited once, and strongly connected components are reported as call cycles. An unresolved edge, a node with more
// outgoing edges than the fan-out bound, the depth or visit bound and an incomplete parser analysis are frontiers, so
// absence is never claimed past them. A path is call reachability only: it never establishes data flow, taint,
// sanitization or protection, and guard, validation and test edges are not traversed at all.
import { canonicalJson, type GraphEdge, type GraphNode } from '@farsight/graph';
import type { AnalysisArtifact } from '@farsight/code-parser';
import type {
  CallCycle,
  CallPath,
  Digest,
  PathBounds,
  PathEdgeKind,
  PathEvidenceEnvelope,
  PathQueryResult,
  PathSite,
  PathStep,
  ScopedReason,
  SnapshotEnvelope,
} from '../../contracts/index.js';
import { validateEnvelope } from '../../validate.js';
import { digestOf } from '../../store/ledger-json.js';
import { sha256Id } from '../../kernel/digest.js';
import { SentinelError } from '../../kernel/errors.js';
import { localNames, scanBody } from './body.js';

/** The implementation every path evidence document names. */
export const PATHS_IMPLEMENTATION = 'sentinel-bounded-paths/draft-1';

/**
 * Why a path query stopped short or a step is only partly known: the closed set of `sentinel.paths.*` frontier codes.
 */
export const PATH_REASON_CODES = Object.freeze([
  'sentinel.paths.unresolvedCall',
  'sentinel.paths.fanoutLimit',
  'sentinel.paths.depthLimit',
  'sentinel.paths.visitLimit',
  'sentinel.paths.analysisIncomplete',
  'sentinel.paths.unknownNode',
  'sentinel.paths.inactiveEdge',
  'sentinel.paths.notDataFlow',
  'sentinel.paths.graphOnly',
  'sentinel.paths.deferredStep',
  'sentinel.paths.siteUnplaced',
  'sentinel.paths.unrecordedCall',
  'sentinel.paths.functionAsValue',
  'sentinel.paths.bodyUnread',
  'sentinel.paths.shadowedCall',
  'sentinel.paths.escapedIdentifier',
] as const);
/** One of `PATH_REASON_CODES`. */
export type PathReason = (typeof PATH_REASON_CODES)[number];

/**
 * The bounds a query runs under unless the request narrows them: call edges only, depth 12, fan-out 256, 50,000 nodes
 * visited.
 */
export const DEFAULT_PATH_BOUNDS: Readonly<PathBounds> = Object.freeze({
  edgeKinds: ['calls'] as PathEdgeKind[],
  maxDepth: 12,
  maxFanout: 256,
  maxVisited: 50_000,
});
const EDGE_KINDS: readonly PathEdgeKind[] = ['calls', 'http', 'renders'];
const MAX_QUERIES = 10_000;
const MAX_CYCLES = 1_000;
const MAX_SITES = 16;

/**
 * A path query refused: `sentinel.paths.invalidInput` for a request or bound out of range, `sentinel.paths.unbound`
 * for evidence that does not bind to its capture.
 */
export class PathError extends SentinelError<'sentinel.paths.invalidInput' | 'sentinel.paths.unbound'> {
  constructor(code: PathError['code'], message: string) {
    super(code, message);
    this.name = 'PathError';
  }
}

/** The parser evidence for one source, as `parseSnapshot` returns it. */
export interface PathAnalysis {
  readonly sourceId: string;
  readonly artifact: AnalysisArtifact;
  readonly index: {
    readonly snapshotId: string;
    readonly sourceId: string;
    readonly analysisFingerprint: string;
    readonly nodes: readonly {
      readonly nodeId: string;
      readonly path: string;
      readonly content: string;
      readonly endLine?: number;
      readonly byteSpan?: { readonly startByte: number; readonly endByte: number };
    }[];
    readonly occurrences: readonly {
      readonly occurrenceId: string;
      readonly edgeId: string;
      readonly path: string;
      readonly content: string;
      readonly byteSpan?: { readonly startByte: number; readonly endByte: number };
    }[];
  };
}

/** One query: the node a path starts from and the node it should reach. */
export interface PathQuery {
  readonly from: string;
  readonly to: string;
}

const sha = (v: unknown): Digest => sha256Id(typeof v === 'string' ? v : canonicalJson(v));

interface GraphIndex {
  readonly nodes: ReadonlyMap<string, GraphNode>;
  /** Outgoing edges per node, by kind, sorted by target then id so a search is deterministic. */
  readonly out: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly sites: ReadonlyMap<string, PathSite[]>;
  readonly graphDigest: Digest;
  /** Node → its strongly connected component id, for components that are cycles. */
  readonly cycleOf: ReadonlyMap<string, number>;
  readonly cycles: readonly string[][];
  /** Where each node's captured text is, when the parser placed it exactly over whole lines. */
  readonly bodies: ReadonlyMap<
    string,
    { path: string; content: string; startByte: number; endByte: number; hasEndLine: boolean }
  >;
  /** Distinct recorded call sites (byte starts of call-edge occurrences) per file. */
  readonly callSites: ReadonlyMap<string, readonly number[]>;
  readonly functionNames: ReadonlySet<string>;
  /** What the entry was built from, checked on every cache hit. */
  readonly stamp: string;
}

/** Per request: whether a node's text is accounted for by recorded calls, and the names it binds locally. */
type Accounted = Map<string, { reason: PathReason | null; locals: ReadonlySet<string>; opaque?: boolean }>;

const indexes = new WeakMap<object, WeakMap<object, Map<string, GraphIndex>>>();

/**
 * One index per (artifact, parser index) pair and edge-kind set. The pair is the identity: call sites and bodies come
 * from the parser index, so an index cached for one pair is never served for another.
 */
function indexOf(analysis: PathAnalysis, kinds: readonly PathEdgeKind[], control?: PathTraversalControl): GraphIndex {
  control?.boundary();
  let perIndex = indexes.get(analysis.artifact);
  if (!perIndex) indexes.set(analysis.artifact, (perIndex = new WeakMap()));
  let perArtifact = perIndex.get(analysis.index);
  if (!perArtifact) perIndex.set(analysis.index, (perArtifact = new Map()));
  const key = [...kinds].sort().join(',');
  // The cached entry is checked against what it was built from, so an object changed after it was cached is rebuilt.
  const stamp = `${analysis.artifact.analysis.fingerprint}\u0000${analysis.index.analysisFingerprint}\u0000${analysis.index.snapshotId}\u0000${analysis.artifact.graph.nodes.length}\u0000${analysis.artifact.graph.edges.length}\u0000${analysis.index.occurrences.length}\u0000${analysis.index.nodes.length}`;
  const hit = perArtifact.get(key);
  if (hit && hit.stamp === stamp) return hit;
  const graph = analysis.artifact.graph;
  const nodes = new Map(
    graph.nodes.map((n) => {
      control?.step();
      return [n.id, n] as const;
    }),
  );
  const out = new Map<string, GraphEdge[]>();
  const traversed = graph.edges.filter((e) => {
    control?.step();
    return (kinds as readonly string[]).includes(e.kind);
  });
  for (const e of traversed) {
    control?.step();
    const list = out.get(e.from) ?? [];
    list.push(e);
    out.set(e.from, list);
  }
  for (const list of out.values())
    list.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sites = new Map<string, PathSite[]>();
  for (const o of analysis.index.occurrences) {
    control?.step();
    if (!o.byteSpan) continue;
    const list = sites.get(o.edgeId) ?? [];
    if (list.length < MAX_SITES)
      list.push({
        relativePath: o.path,
        content: o.content,
        span: { startByte: o.byteSpan.startByte, endByte: o.byteSpan.endByte },
        occurrenceId: o.occurrenceId,
      });
    sites.set(o.edgeId, list);
  }
  // The graph read, canonically: node ids and the traversed edges with what a step reports about them.
  const graphDigest = sha({
    nodes: [...nodes.keys()].sort(),
    edges: traversed
      .map((e) => [e.id, e.kind, e.from, e.to, e.resolution?.status ?? null, !!e.meta?.deferred, !!e.meta?.inactive])
      .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
    complete: analysis.artifact.analysis.complete,
  });
  const { cycleOf, cycles } = stronglyConnected(nodes, out, control);
  const bodies = new Map<
    string,
    { path: string; content: string; startByte: number; endByte: number; hasEndLine: boolean }
  >();
  for (const n of analysis.index.nodes) {
    if (n.byteSpan)
      bodies.set(n.nodeId, {
        path: n.path,
        content: n.content,
        startByte: n.byteSpan.startByte,
        endByte: n.byteSpan.endByte,
        hasEndLine: n.endLine !== undefined,
      });
  }
  const callEdges = new Set(graph.edges.filter((e) => e.kind === 'calls').map((e) => e.id));
  const callSites = new Map<string, number[]>();
  for (const o of analysis.index.occurrences) {
    control?.step();
    if (!o.byteSpan || !callEdges.has(o.edgeId)) continue;
    const list = callSites.get(o.path) ?? [];
    if (!list.includes(o.byteSpan.startByte)) list.push(o.byteSpan.startByte);
    callSites.set(o.path, list);
  }
  const functionNames = new Set(
    graph.nodes
      .filter((n) => n.kind === 'function' || n.kind === 'component')
      .map((n) => n.id.split('::').pop()!.split('.').pop()!)
      .filter(Boolean),
  );
  const index = { nodes, out, sites, graphDigest, cycleOf, cycles, bodies, callSites, functionNames, stamp };
  perArtifact.set(key, index);
  return index;
}

/** Tarjan's algorithm, iterative; only components that are cycles are kept. */
function stronglyConnected(
  nodes: ReadonlyMap<string, GraphNode>,
  out: ReadonlyMap<string, readonly GraphEdge[]>,
  control?: PathTraversalControl,
) {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycleOf = new Map<string, number>();
  const cycles: string[][] = [];
  let counter = 0;
  const succ = (v: string) =>
    (out.get(v) ?? []).filter((e) => e.resolution?.status !== 'unresolved' && !e.meta?.inactive).map((e) => e.to);
  for (const root of [...nodes.keys()].sort()) {
    if (index.has(root)) continue;
    const work: { v: string; i: number; next: string[] }[] = [{ v: root, i: 0, next: succ(root) }];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      control?.step();
      const top = work[work.length - 1]!;
      if (top.i < top.next.length) {
        const w = top.next[top.i++]!;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0, next: succ(w) });
        } else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(top.v)!));
      if (low.get(top.v) === index.get(top.v)) {
        const members: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          members.push(w);
        } while (w !== top.v);
        const selfCall = members.length === 1 && succ(top.v).includes(top.v);
        if (members.length > 1 || selfCall) {
          for (const m of members) cycleOf.set(m, cycles.length);
          cycles.push(members.sort());
        }
      }
    }
  }
  return { cycleOf, cycles };
}

function boundsOf(input: Partial<PathBounds> | undefined): PathBounds {
  const b = { ...DEFAULT_PATH_BOUNDS, ...input };
  const kinds = [...new Set(b.edgeKinds)];
  const int = (v: unknown, lo: number, hi: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  if (
    !kinds.length ||
    kinds.some((k) => !EDGE_KINDS.includes(k)) ||
    !int(b.maxDepth, 1, 64) ||
    !int(b.maxFanout, 1, 4096) ||
    !int(b.maxVisited, 1, 1_000_000)
  ) {
    throw new PathError(
      'sentinel.paths.invalidInput',
      'bounds must name call, http or render edges and stay within their limits',
    );
  }
  return { edgeKinds: kinds.sort(), maxDepth: b.maxDepth, maxFanout: b.maxFanout, maxVisited: b.maxVisited };
}

/** Kinds whose text is code a request runs; others (records, packages, documents) are not read as bodies. */
const CODE_KINDS = new Set(['function', 'component', 'page', 'route', 'class']);

/**
 * Whether the graph accounts for every call a visited node's text could make: null when it does, otherwise the
 * frontier. Exactly placed whole-line text is read lexically (body.ts) and compared with the recorded call sites in
 * the same bytes.
 */
async function accountedFor(
  ix: GraphIndex,
  accounted: Accounted,
  id: string,
  read: (content: string) => Promise<Uint8Array>,
): Promise<{ reason: PathReason | null; locals: ReadonlySet<string>; opaque?: boolean }> {
  const known = accounted.get(id);
  if (known !== undefined) return known;
  const node = ix.nodes.get(id)!;
  let reason: PathReason | null = null;
  let locals: ReadonlySet<string> = new Set();
  if (CODE_KINDS.has(node.kind)) {
    const body = ix.bodies.get(id);
    if (!body || !body.hasEndLine) reason = 'sentinel.paths.bodyUnread';
    else {
      const bytes = Buffer.from(await read(body.content));
      if (body.endByte > bytes.length) reason = 'sentinel.paths.bodyUnread';
      else {
        const text = bytes.subarray(body.startByte, body.endByte).toString('utf8');
        const own = id.split('::').pop()!.split('.').pop();
        // A Unicode escape can spell any identifier (`\u0073ink` is `sink`): a lexical reading cannot tell which
        // names such a function calls, binds or hands on, so none of its edges is followed and absence is not claimed.
        if (/\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})/.test(text)) {
          const result = {
            reason: 'sentinel.paths.escapedIdentifier' as PathReason,
            locals: new Set<string>(),
            opaque: true,
          };
          accounted.set(id, result);
          return result;
        }
        const scan = scanBody(text, ix.functionNames, own);
        locals = localNames(text, own);
        const recorded = (ix.callSites.get(body.path) ?? []).filter(
          (b) => b >= body.startByte && b < body.endByte,
        ).length;
        if (scan.callSites > recorded) reason = 'sentinel.paths.unrecordedCall';
        else if (scan.valueReferences) reason = 'sentinel.paths.functionAsValue';
      }
    }
  }
  const result = { reason, locals };
  accounted.set(id, result);
  return result;
}

/** The name a call edge's target is called by: the last segment of its id (`path::Class.method` → `method`). */
const calleeName = (id: string) => id.split('::').pop()!.split('.').pop()!;

async function search(
  ix: GraphIndex,
  accounted: Accounted,
  q: PathQuery,
  bounds: PathBounds,
  complete: boolean,
  read: (content: string) => Promise<Uint8Array>,
  control?: PathTraversalControl,
): Promise<{ result: PathQueryResult; reasons: Set<PathReason> }> {
  const reasons = new Set<PathReason>();
  if (!complete) reasons.add('sentinel.paths.analysisIncomplete');
  if (!ix.nodes.has(q.from) || !ix.nodes.has(q.to)) {
    reasons.add('sentinel.paths.unknownNode');
    return {
      result: {
        from: q.from,
        to: q.to,
        outcome: 'not-reached-bounded',
        paths: [],
        frontierReasons: [...reasons].sort(),
        visited: 0,
      },
      reasons,
    };
  }
  control?.visit();
  const parent = new Map<string, GraphEdge | null>([[q.from, null]]);
  let frontier = [q.from];
  let depth = 0;
  let found = false;
  while (frontier.length && !found) {
    if (depth >= bounds.maxDepth) {
      reasons.add('sentinel.paths.depthLimit');
      break;
    }
    const next: string[] = [];
    for (const v of frontier) {
      control?.boundary();
      const body = await accountedFor(ix, accounted, v, read);
      control?.boundary();
      if (body.reason) reasons.add(body.reason);
      if (body.opaque) continue;
      const edges = ix.out.get(v) ?? [];
      if (edges.length > bounds.maxFanout) reasons.add('sentinel.paths.fanoutLimit');
      for (const e of edges.slice(0, bounds.maxFanout)) {
        control?.step();
        if (e.meta?.inactive) {
          reasons.add('sentinel.paths.inactiveEdge');
          continue;
        }
        // An unresolved call could reach anything: the search cannot continue through it, and absence is unknown.
        if (e.resolution?.status === 'unresolved' || !ix.nodes.has(e.to)) {
          reasons.add('sentinel.paths.unresolvedCall');
          continue;
        }
        // A local binding of the callee's name (a parameter, a local function) may be what is really called: the
        // parser's edge to a top-level function of that name is not followed, and absence is not claimed past it.
        if (e.kind === 'calls' && e.to !== v && body.locals.has(calleeName(e.to))) {
          reasons.add('sentinel.paths.shadowedCall');
          continue;
        }
        if (parent.has(e.to)) continue;
        if (parent.size >= bounds.maxVisited) {
          reasons.add('sentinel.paths.visitLimit');
          break;
        }
        control?.visit();
        parent.set(e.to, e);
        if (e.to === q.to) {
          found = true;
          break;
        }
        next.push(e.to);
      }
      if (found || reasons.has('sentinel.paths.visitLimit')) break;
    }
    frontier = next;
    depth++;
  }
  const visited = parent.size;
  if (!found) {
    const frontierReasons = [...reasons].sort();
    return {
      result: {
        from: q.from,
        to: q.to,
        outcome: frontierReasons.length ? 'not-reached-bounded' : 'not-reached-complete',
        paths: [],
        frontierReasons,
        visited,
      },
      reasons,
    };
  }
  const edges: GraphEdge[] = [];
  for (let v = q.to; parent.get(v); v = parent.get(v)!.from) edges.unshift(parent.get(v)!);
  const steps: PathStep[] = edges.map((e) => ({
    edgeId: e.id,
    from: e.from,
    to: e.to,
    kind: e.kind as PathEdgeKind,
    resolution: e.resolution?.status === 'heuristic' ? 'heuristic' : 'resolved',
    deferred: !!e.meta?.deferred,
    sites: ix.sites.get(e.id) ?? [],
  }));
  const nodes = [q.from, ...edges.map((e) => e.to)];
  const path: CallPath = {
    id: digestOf({ nodes, edges: edges.map((e) => e.id) }) as Digest,
    steps,
    cyclic: nodes.filter((n) => ix.cycleOf.has(n)),
  };
  return {
    result: { from: q.from, to: q.to, outcome: 'reached', paths: [path], frontierReasons: [], visited },
    reasons,
  };
}

/**
 * What a path search reads: one snapshot, a reader of its captured bytes, one source's parser evidence, the queries and
 * optional narrower bounds.
 */
export interface PathRequest {
  /** The snapshot the parser evidence is for: every location the index cites must be one of its captured files. */
  readonly snapshot: Pick<SnapshotEnvelope, 'id' | 'entries'>;
  /** Reads a captured file's bytes by content id (the store's `readArtifact`): visited bodies are checked against them. */
  readonly readContent: (id: string) => Promise<Uint8Array>;
  readonly analysis: PathAnalysis;
  readonly queries: readonly PathQuery[];
  readonly bounds?: Partial<PathBounds>;
}

/** Bounded call paths for each query, as a validated `sentinel-paths/draft-1` envelope. */
export async function boundedCallPaths(request: PathRequest): Promise<PathEvidenceEnvelope> {
  return callPaths(request);
}

/** Internal worker observer only, deliberately absent from the public analysis facade. Creates no authority. */
export interface PathTraversalControl {
  boundary(): void;
  step(): void;
  visit(): void;
  result(value: unknown): void;
}
/**
 * `boundedCallPaths` under a worker's `control`, which is told every boundary, step, visit and result so the shared
 * budget can refuse the invocation.
 */
export async function controlledCallPaths(
  request: PathRequest,
  control: PathTraversalControl,
): Promise<PathEvidenceEnvelope> {
  return callPaths(request, control);
}
async function callPaths(request: PathRequest, control?: PathTraversalControl): Promise<PathEvidenceEnvelope> {
  control?.boundary();
  const { analysis } = request;
  if (!analysis?.artifact?.graph || !analysis.index)
    throw new PathError('sentinel.paths.invalidInput', 'the parser evidence for one source is required');
  // The paths are about one snapshot's source: the parser evidence must be for exactly that snapshot and source.
  const snapshotId = request.snapshot?.id;
  if (typeof snapshotId !== 'string' || !Array.isArray(request.snapshot.entries))
    throw new PathError('sentinel.paths.invalidInput', 'the snapshot is required');
  if (analysis.index.snapshotId !== snapshotId || analysis.index.sourceId !== analysis.sourceId) {
    throw new PathError('sentinel.paths.unbound', 'the parser evidence is for another snapshot or source');
  }
  // The index and the artifact must be one analysis: the envelope names the artifact's own fingerprint.
  const fingerprint = (analysis.artifact.analysis as { fingerprint?: unknown }).fingerprint;
  if (typeof fingerprint !== 'string' || fingerprint !== analysis.index.analysisFingerprint) {
    throw new PathError('sentinel.paths.unbound', 'the index and the artifact are not the same parser analysis');
  }
  // Every location the index cites is a captured file of this snapshot's source, with the same content.
  const captured = new Map<string, string>();
  for (const e of request.snapshot.entries)
    if (e.sourceId === analysis.sourceId && e.kind === 'file' && e.disposition === 'included')
      captured.set(e.relativePath, e.content);
  for (const l of [...analysis.index.nodes, ...analysis.index.occurrences]) {
    if (captured.get(l.path) !== l.content)
      throw new PathError('sentinel.paths.unbound', 'the parser index cites bytes this snapshot did not capture');
  }
  if (!Array.isArray(request.queries) || request.queries.length > MAX_QUERIES)
    throw new PathError('sentinel.paths.invalidInput', `at most ${MAX_QUERIES} queries`);
  const bounds = boundsOf(request.bounds);
  const ix = indexOf(analysis, bounds.edgeKinds, control);
  const complete = analysis.artifact.analysis.complete === true;
  if (typeof request.readContent !== 'function')
    throw new PathError('sentinel.paths.invalidInput', 'readContent is required');
  const cache = new Map<string, Promise<Uint8Array>>();
  // Bytes are checked against their content id: a reader for another store cannot supply a body.
  const read = (content: string) => {
    let p = cache.get(content);
    if (!p)
      cache.set(
        content,
        (p = request.readContent(content).then((bytes) => {
          if (sha256Id(bytes) !== content)
            throw new PathError('sentinel.paths.unbound', 'the reader returned bytes that are not the cited content');
          return bytes;
        })),
      );
    return p;
  };
  const accounted: Accounted = new Map();
  const frontiers: ScopedReason[] = [];
  const results: PathQueryResult[] = [];
  const limitations = new Set<PathReason>(['sentinel.paths.notDataFlow', 'sentinel.paths.graphOnly']);
  const cyclesMet = new Set<number>();
  for (const q of request.queries) {
    control?.step();
    if (typeof q?.from !== 'string' || typeof q?.to !== 'string' || !q.from || !q.to || q.from === q.to)
      throw new PathError('sentinel.paths.invalidInput', 'each query names two different node ids');
    const { result, reasons } = await search(ix, accounted, q, bounds, complete, read, control);
    control?.boundary();
    control?.result(result);
    results.push(result);
    for (const r of reasons) if (frontiers.length < 10_000) frontiers.push({ scopeId: q.from, reasonCode: r });
    for (const p of result.paths) {
      if (p.steps.some((s) => s.deferred)) limitations.add('sentinel.paths.deferredStep');
      if (p.steps.some((s) => !s.sites.length)) limitations.add('sentinel.paths.siteUnplaced');
      for (const n of p.cyclic) cyclesMet.add(ix.cycleOf.get(n)!);
    }
  }
  const cycles: CallCycle[] = [...cyclesMet]
    .sort((a, b) => a - b)
    .slice(0, MAX_CYCLES)
    .map((i) => ({ members: ix.cycles[i]!.slice(0, 1000) }));
  const envelope: PathEvidenceEnvelope = {
    schema: 'sentinel-paths/draft-1',
    snapshotId,
    sourceId: analysis.sourceId,
    analysisFingerprint: fingerprint,
    graphDigest: ix.graphDigest,
    bounds,
    boundsDigest: digestOf(bounds) as Digest,
    establishes: 'call-reachability',
    results,
    cycles,
    limitationKeys: [...limitations].sort(),
    frontiers,
    producer: {
      implementation: PATHS_IMPLEMENTATION,
      digest: sha({ implementation: PATHS_IMPLEMENTATION, reasons: PATH_REASON_CODES }),
    },
  };
  const valid = validateEnvelope('paths', envelope);
  if (!valid.ok)
    throw new PathError(
      'sentinel.paths.invalidInput',
      `the paths do not fit their contract: ${valid.errors[0]?.code} at ${valid.errors[0]?.path}`,
    );
  control?.boundary();
  return valid.value as PathEvidenceEnvelope;
}

/** Package-internal output qualification against original parser identities. This checks reported graph, paths,
 * sites and cycles; it does not rerun queries or turn a structural document into accepted producer authority. */
export function assertPathEvidence(
  evidence: PathEvidenceEnvelope,
  analysis: PathAnalysis,
  control: PathTraversalControl,
): void {
  const refuse = () => {
    throw new PathError('sentinel.paths.unbound', 'reported paths differ from original retained parser evidence');
  };
  control.boundary();
  const ix = indexOf(analysis, evidence.bounds.edgeKinds, control);
  if (
    evidence.graphDigest !== ix.graphDigest ||
    evidence.boundsDigest !== digestOf(evidence.bounds) ||
    evidence.producer.implementation !== PATHS_IMPLEMENTATION ||
    evidence.producer.digest !== sha({ implementation: PATHS_IMPLEMENTATION, reasons: PATH_REASON_CODES }) ||
    !evidence.limitationKeys.includes('sentinel.paths.notDataFlow') ||
    !evidence.limitationKeys.includes('sentinel.paths.graphOnly') ||
    evidence.limitationKeys.some((r) => !PATH_REASON_CODES.includes(r as PathReason))
  )
    return refuse();
  const queryFrom = new Set(evidence.results.map((r) => r.from));
  if (
    evidence.frontiers.some((f) => !queryFrom.has(f.scopeId) || !PATH_REASON_CODES.includes(f.reasonCode as PathReason))
  )
    return refuse();
  const cyclesMet = new Set<number>();
  for (const result of evidence.results) {
    control.step();
    if (
      result.visited > evidence.bounds.maxVisited ||
      result.frontierReasons.some((r) => !PATH_REASON_CODES.includes(r as PathReason))
    )
      return refuse();
    if (
      result.outcome === 'reached'
        ? result.paths.length !== 1 || result.frontierReasons.length !== 0
        : result.paths.length !== 0
    )
      return refuse();
    if (
      result.outcome === 'not-reached-complete' &&
      (!ix.nodes.has(result.from) ||
        !ix.nodes.has(result.to) ||
        analysis.artifact.analysis.complete !== true ||
        result.frontierReasons.length !== 0)
    )
      return refuse();
    if (result.outcome === 'not-reached-bounded' && result.frontierReasons.length === 0) return refuse();
    for (const path of result.paths) {
      if (path.steps.length > evidence.bounds.maxDepth) return refuse();
      const nodes = [result.from];
      for (const step of path.steps) {
        control.step();
        const edge = (ix.out.get(step.from) ?? []).find((e) => e.id === step.edgeId);
        if (
          !edge ||
          nodes[nodes.length - 1] !== step.from ||
          edge.to !== step.to ||
          edge.kind !== step.kind ||
          edge.resolution?.status === 'unresolved' ||
          edge.meta?.inactive ||
          step.resolution !== (edge.resolution?.status === 'heuristic' ? 'heuristic' : 'resolved') ||
          step.deferred !== !!edge.meta?.deferred ||
          canonicalJson(step.sites) !== canonicalJson(ix.sites.get(edge.id) ?? [])
        )
          return refuse();
        nodes.push(step.to);
      }
      if (
        nodes[nodes.length - 1] !== result.to ||
        path.id !== digestOf({ nodes, edges: path.steps.map((s) => s.edgeId) }) ||
        canonicalJson(path.cyclic) !== canonicalJson(nodes.filter((n) => ix.cycleOf.has(n)))
      )
        return refuse();
      for (const n of path.cyclic) cyclesMet.add(ix.cycleOf.get(n)!);
    }
  }
  const cycles = [...cyclesMet]
    .sort((a, b) => a - b)
    .slice(0, MAX_CYCLES)
    .map((i) => ({ members: ix.cycles[i]!.slice(0, 1000) }));
  if (canonicalJson(evidence.cycles) !== canonicalJson(cycles)) return refuse();
  control.boundary();
}
