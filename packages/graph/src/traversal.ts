import type { GraphEdge, GraphNode, EdgeKind } from './graph.js';

export interface GraphIndex {
  nodes: ReadonlyMap<string, GraphNode>;
  outgoing: ReadonlyMap<string, readonly GraphEdge[]>;
  incoming: ReadonlyMap<string, readonly GraphEdge[]>;
}

/** Pure structural index; no test refolding, persistence, or presentation behavior. */
export function indexGraph(graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] }): GraphIndex {
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const out = outgoing.get(edge.from) ?? [];
    out.push(edge);
    outgoing.set(edge.from, out);
    const into = incoming.get(edge.to) ?? [];
    into.push(edge);
    incoming.set(edge.to, into);
  }
  return { nodes: new Map(graph.nodes.map((n) => [n.id, n])), outgoing, incoming };
}

/** Breadth-first structural reachability. This does not prove a feasible execution path. */
export function reachable(
  index: GraphIndex,
  seeds: readonly string[],
  options: {
    direction?: 'outgoing' | 'incoming';
    kinds?: readonly EdgeKind[];
    maxDepth?: number;
  } = {},
): string[] {
  const depth = options.maxDepth ?? Infinity;
  if (depth < 0 || (depth !== Infinity && !Number.isInteger(depth)))
    throw new RangeError('maxDepth must be a nonnegative integer');
  const seen = new Set(seeds.filter((id) => index.nodes.has(id)));
  let frontier = [...seen];
  for (let hop = 0; frontier.length && hop < depth; hop++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const edge of index[options.direction ?? 'outgoing'].get(id) ?? []) {
        if (options.kinds && !options.kinds.includes(edge.kind)) continue;
        const target = options.direction === 'incoming' ? edge.from : edge.to;
        if (!seen.has(target) && index.nodes.has(target)) {
          seen.add(target);
          next.push(target);
        }
      }
    frontier = next;
  }
  return [...seen];
}
