// The pinned application context (PR 19, ADR 38). A report places findings on screens, journeys and personas only
// through an application graph whose source identity is proven: the context document names every input file it was
// built from with the content id of the bytes it read, and pinning checks each against the snapshot's capture. A
// graph node located in a file the inputs do not name, an input whose bytes differ from the capture, or a captured
// configuration or design manifest the inputs leave out makes the binding `mismatched`; no context, or a graph with
// no journeys (a portable parser artifact), makes it `unavailable`. Either way the place is empty with its reason; a
// current graph is never consulted in its stead, and nothing here enriches a graph or fetches anything.
import { createHash } from 'node:crypto';
import { canonicalJson } from '@farsight/graph';
import type { ArtifactId, SnapshotEnvelope } from '../contracts/index.js';

export interface ContextGraph {
  readonly nodes: readonly { readonly id: string; readonly kind: string; readonly name?: string; readonly loc?: { readonly repo: string; readonly path: string; readonly line?: number } | undefined; readonly [k: string]: unknown }[];
  readonly edges: readonly { readonly id?: string; readonly kind: string; readonly from: string; readonly to: string; readonly [k: string]: unknown }[];
  readonly meta?: { readonly journeys?: unknown; readonly [k: string]: unknown };
}

export interface ContextInput { readonly relativePath: string; readonly content: ArtifactId }

export interface ContextRequest {
  readonly snapshot: Pick<SnapshotEnvelope, 'id' | 'entries'>;
  /** The snapshot source the context describes. */
  readonly sourceId: string;
  /** The repository name the graph's node ids and locations use for that source. */
  readonly repo: string;
  /** The retained enriched application graph, or undefined when none was retained. */
  readonly graph?: ContextGraph;
  /** Every file the graph was built from, with the content id of the bytes read. */
  readonly inputs?: readonly ContextInput[];
  /** Who built the graph (recorded in the receipt, never trusted for the binding). */
  readonly producer?: { readonly tool: string; readonly version: string };
}

export type PlaceReason =
  | 'sentinel.place.noContext' | 'sentinel.place.noJourneys' | 'sentinel.place.inputMismatch' | 'sentinel.place.inputNotCaptured'
  | 'sentinel.place.unboundNode' | 'sentinel.place.inputOmitted' | 'sentinel.place.nodeNotInContext' | 'sentinel.place.truncated'
  | 'sentinel.place.gapUnplaced' | 'sentinel.place.noAnchorSymbol' | 'sentinel.place.notOnScreen';

export interface PinnedContext {
  readonly binding: 'matched' | 'mismatched' | 'unavailable';
  readonly reasons: readonly PlaceReason[];
  readonly sourceId: string;
  readonly repo: string;
  /** The context document's canonical bytes and id, when there was a graph. */
  readonly artifact?: { readonly id: ArtifactId; readonly bytes: Uint8Array };
  /** The source-binding receipt: what was verified and the verdict. Always produced. */
  readonly receipt: { readonly id: ArtifactId; readonly bytes: Uint8Array };
  /** Present only when the binding matched. */
  readonly graph?: ContextGraph;
}

const PROJECTION_VERSION = 'sentinel-place/draft-1';
export { PROJECTION_VERSION };
const idOf = (bytes: Uint8Array): ArtifactId => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const bytesOf = (v: unknown) => Buffer.from(canonicalJson(v), 'utf8');
/** Inputs that shape journeys and screens: if captured, a context must have read them. */
const SHAPING = /(^|\/)(farsight\.config\.json|screens\.json)$/;

export function pinApplicationContext(request: ContextRequest): PinnedContext {
  const { snapshot, sourceId, repo, graph, inputs } = request;
  const reasons = new Set<PlaceReason>();
  let artifact: PinnedContext['artifact'];
  let verified = 0;
  let checkedNodes = 0;
  let binding: PinnedContext['binding'];
  if (!graph || !inputs) {
    binding = 'unavailable';
    reasons.add('sentinel.place.noContext');
  } else {
    const doc = { schema: 'sentinel-app-context/draft-1', sourceId, repo, graph, inputs: [...inputs].sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1)) };
    const bytes = bytesOf(doc);
    artifact = { id: idOf(bytes), bytes };
    const captured = new Map<string, string>();
    for (const e of snapshot.entries) if (e.sourceId === sourceId && e.kind === 'file' && e.disposition === 'included') captured.set(e.relativePath, e.content);
    const read = new Map<string, string>();
    for (const i of inputs) {
      const c = captured.get(i.relativePath);
      if (c === undefined) reasons.add('sentinel.place.inputNotCaptured');
      else if (c !== i.content) reasons.add('sentinel.place.inputMismatch');
      else { verified++; read.set(i.relativePath, i.content); }
    }
    for (const path of captured.keys()) if (SHAPING.test(path) && !read.has(path)) reasons.add('sentinel.place.inputOmitted');
    for (const n of graph.nodes) {
      if (n.loc?.repo !== repo) continue;
      checkedNodes++;
      if (!read.has(n.loc.path)) reasons.add('sentinel.place.unboundNode');
    }
    if (reasons.size) binding = 'mismatched';
    else if (!graph.nodes.some(n => n.kind === 'flow')) { binding = 'unavailable'; reasons.add('sentinel.place.noJourneys'); }
    else binding = 'matched';
  }
  const receiptDoc = {
    schema: 'sentinel-context-receipt/draft-1', snapshotId: snapshot.id, sourceId, repo, projectionVersion: PROJECTION_VERSION,
    context: artifact?.id ?? null, binding, reasons: [...reasons].sort(), verifiedInputs: verified, checkedNodes,
    producer: request.producer ?? null,
  };
  const receiptBytes = bytesOf(receiptDoc);
  return {
    binding, reasons: [...reasons].sort(), sourceId, repo,
    ...(artifact ? { artifact } : {}), receipt: { id: idOf(receiptBytes), bytes: receiptBytes },
    ...(binding === 'matched' ? { graph: graph! } : {}),
  };
}
