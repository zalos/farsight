import { createHash } from 'node:crypto';
import schema from './schema.js';
import { Ajv } from 'ajv';
import type { EdgeOccurrence, GraphEdge, GraphFragment } from './graph.js';
import type { GraphDocument, GraphSource, PortableGraph } from './document.js';

export const GRAPH_SCHEMA_VERSION = 1 as const;
export const graphSchema = schema;
let compiled: ReturnType<Ajv['compile']> | undefined;
const validator = () =>
  (compiled ??= new Ajv({ allErrors: true, strict: true, allowUnionTypes: true }).compile<GraphDocument>(graphSchema));

/** Sort object keys only; array order is significant unless a contract explicitly calls it a set. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, sort(item)]),
      );
    return v;
  };
  return JSON.stringify(sort(value));
}

export function occurrenceId(edge: Pick<GraphEdge, 'kind' | 'from' | 'to'>, site: Omit<EdgeOccurrence, 'id'>): string {
  return (
    'site:' +
    createHash('sha256')
      .update(
        canonicalJson({
          kind: edge.kind,
          from: edge.from,
          to: edge.to,
          loc: site.loc,
          span: site.span,
        }),
      )
      .digest('hex')
  );
}

export function mergeOccurrences(...lists: (readonly EdgeOccurrence[] | undefined)[]): EdgeOccurrence[] | undefined {
  const sites = new Map<string, EdgeOccurrence>();
  for (const list of lists) for (const site of list ?? []) sites.set(site.id, site);
  return sites.size ? [...sites.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) : undefined;
}

/** Re-identify evidence after configuration or stitching changes a relationship's endpoints/kind. */
export function retargetOccurrences(edge: GraphEdge): EdgeOccurrence[] | undefined {
  return mergeOccurrences(edge.occurrences?.map((site) => ({ ...site, id: occurrenceId(edge, site) })));
}

export function validateGraph(value: unknown): { valid: boolean; errors: string[] } {
  const validate = validator();
  if (!validate(value))
    return { valid: false, errors: (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`) };
  const document = value as GraphDocument;
  const errors: string[] = [];
  const sources = new Set<string>();
  for (const source of document.sources ?? []) {
    if (sources.has(source.repo)) errors.push(`Duplicate source: ${source.repo}`);
    sources.add(source.repo);
  }
  const nodes = new Set<string>();
  for (const node of document.graph.nodes) {
    if (nodes.has(node.id)) errors.push(`Duplicate node: ${node.id}`);
    nodes.add(node.id);
  }
  const edges = new Set<string>();
  for (const edge of document.graph.edges) {
    if (edges.has(edge.id)) errors.push(`Duplicate edge: ${edge.id}`);
    edges.add(edge.id);
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) errors.push(`Dangling edge: ${edge.id}`);
    const sites = new Set<string>();
    for (const site of edge.occurrences ?? []) {
      if (sites.has(site.id)) errors.push(`Duplicate occurrence: ${site.id}`);
      sites.add(site.id);
      if (
        site.loc.line < 1 ||
        !Number.isInteger(site.loc.line) ||
        (site.loc.col != null && (site.loc.col < 1 || !Number.isInteger(site.loc.col)))
      )
        errors.push(`Invalid location: ${site.id}`);
      if (
        site.span &&
        (site.span.start < 0 ||
          site.span.end < site.span.start ||
          !Number.isInteger(site.span.start) ||
          !Number.isInteger(site.span.end))
      )
        errors.push(`Invalid span: ${site.id}`);
    }
  }
  for (const node of document.graph.nodes)
    if (node.loc && (node.loc.line < 1 || !Number.isInteger(node.loc.line)))
      errors.push(`Invalid location: ${node.id}`);
  return { valid: errors.length === 0, errors };
}

export function assertGraph(value: unknown): asserts value is GraphDocument {
  const result = validateGraph(value);
  if (!result.valid) throw new TypeError(`Invalid farsight-graph v1: ${result.errors.join('; ')}`);
}

export function graphDocument(graph: GraphFragment | PortableGraph, sources?: readonly GraphSource[]): GraphDocument {
  const copy = JSON.parse(JSON.stringify(graph)) as GraphFragment;
  if (copy.meta) delete (copy.meta as Partial<NonNullable<GraphFragment['meta']>>).sourceHash;
  copy.nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  copy.edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const edge of copy.edges) if (edge.occurrences) edge.occurrences = retargetOccurrences(edge);
  const doc: GraphDocument = { format: 'farsight-graph', schemaVersion: GRAPH_SCHEMA_VERSION, graph: copy };
  if (sources)
    doc.sources = (JSON.parse(JSON.stringify(sources)) as GraphSource[]).sort((a, b) =>
      a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0,
    );
  assertGraph(doc);
  return doc;
}

export function serializeGraph(graph: GraphFragment | PortableGraph): string {
  return canonicalJson(graphDocument(graph));
}

export function deserializeGraph(json: string): GraphDocument {
  const value: unknown = JSON.parse(json);
  assertGraph(value);
  return value;
}
