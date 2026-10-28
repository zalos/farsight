// The pinned application context (PR 19, ADR 38). A report places findings on screens, journeys and personas only
// through an application graph whose source identity is proven: the context document names every input file it was
// built from with the content id of the bytes it read, and pinning checks each against the snapshot's capture. A
// graph node located in a file the inputs do not name, an input whose bytes differ from the capture, or a captured
// configuration or design manifest the inputs leave out makes the binding `mismatched`; no context, or a graph with
// no journeys (a portable parser artifact), makes it `unavailable`. Matching input hashes prove only which bytes the
// context claims to describe, not that its relationships and labels are true, so a context is also authenticated: the
// owner must have confirmed exactly this context document for exactly this snapshot and source (the owner-only
// `context.pin` action, spent as a receipt). Without that it is `unavailable`. The verified graph is copied and frozen,
// so nothing the caller changes afterwards reaches a report. Either way an empty place says why; a current graph is
// never consulted in its stead, and nothing here enriches a graph or fetches anything.
import { createHash } from 'node:crypto';
import { canonicalJson } from '@farsight/graph';
import type { ActionIntent, ArtifactId, SnapshotEnvelope } from '../contracts/index.js';
import { intentDigest, receiptAuthority } from '../policy/receipts.js';

/**
 * The application graph a context pins: Farsight's graph.json nodes and edges, with the meta its journeys live in. Only
 * nodes located in the pinned repository are checked against the capture.
 */
export interface ContextGraph {
  readonly nodes: readonly {
    readonly id: string;
    readonly kind: string;
    readonly name?: string;
    readonly loc?: { readonly repo: string; readonly path: string; readonly line?: number } | undefined;
    readonly [k: string]: unknown;
  }[];
  readonly edges: readonly {
    readonly id?: string;
    readonly kind: string;
    readonly from: string;
    readonly to: string;
    readonly [k: string]: unknown;
  }[];
  readonly meta?: { readonly journeys?: unknown; readonly [k: string]: unknown };
}

/** One file a context was built from, with the content id of the bytes its builder read. */
export interface ContextInput {
  readonly relativePath: string;
  readonly content: ArtifactId;
}

/**
 * What `pinApplicationContext` checks: one snapshot source, the graph built from it, every file it was built from, and
 * the owner's spent `context.pin` receipt for exactly that document.
 */
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
  /** The owner's spent receipt for exactly `contextPinIntent(request)`; only `ReceiptBook.consume` makes one. */
  readonly authorization?: unknown;
}

/**
 * Why a finding, gap or context has no place, or a mismatched one: the closed set of `sentinel.place.*` catalog codes.
 */
export type PlaceReason =
  | 'sentinel.place.noContext'
  | 'sentinel.place.noJourneys'
  | 'sentinel.place.inputMismatch'
  | 'sentinel.place.inputNotCaptured'
  | 'sentinel.place.unboundNode'
  | 'sentinel.place.inputOmitted'
  | 'sentinel.place.nodeNotInContext'
  | 'sentinel.place.truncated'
  | 'sentinel.place.gapUnplaced'
  | 'sentinel.place.noAnchorSymbol'
  | 'sentinel.place.notOnScreen'
  | 'sentinel.place.notOwnerConfirmed'
  | 'sentinel.place.secretWithheld'
  | 'sentinel.place.contextMismatch';

/** The capture and source a placement consumer is producing evidence about. */
export interface ContextBinding {
  readonly snapshotId: string;
  readonly sourceId: string;
}

declare const pinnedContextBrand: unique symbol;
/**
 * A verified application context, or the reasons there is none. Only `pinApplicationContext` makes one; the graph is a
 * frozen copy, present only when `binding` is `matched`, and the receipt records what was verified either way.
 */
export interface PinnedContext {
  /** A pin is a runtime capability; copying its public fields does not copy its authority. */
  readonly [pinnedContextBrand]: true;
  readonly snapshotId: string;
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

// Only pinApplicationContext registers these identities after validating the real spent owner grant. Structural
// objects, copies and proxies are not capabilities. Keep the original authority beside its exact capture binding.
const provenance = new WeakMap<
  object,
  { snapshotId: string; sourceId: string; authority: ReturnType<typeof receiptAuthority> }
>();

/** Package-internal consuming boundary: public fields and serialized receipt bytes confer no authority. */
export function contextProblem(context: unknown, expected: ContextBinding | undefined): PlaceReason | undefined {
  const known = typeof context === 'object' && context !== null ? provenance.get(context) : undefined;
  if (!known) return 'sentinel.place.notOwnerConfirmed';
  if (!expected || expected.snapshotId !== known.snapshotId || expected.sourceId !== known.sourceId)
    return 'sentinel.place.contextMismatch';
  if ((context as PinnedContext).binding === 'matched' && !known.authority) return 'sentinel.place.notOwnerConfirmed';
  return undefined;
}

/** Artifact byte arrays cannot be frozen; hand out copies so callers cannot change the retained provenance. */
function retainedArtifact(id: ArtifactId, bytes: Uint8Array): { readonly id: ArtifactId; readonly bytes: Uint8Array } {
  const retained = Uint8Array.from(bytes);
  return Object.freeze({
    id,
    get bytes() {
      return Uint8Array.from(retained);
    },
  });
}

/** The placement projection's version, recorded in every source-binding receipt. */
const PROJECTION_VERSION = 'sentinel-place/draft-1';
export { PROJECTION_VERSION };
const idOf = (bytes: Uint8Array): ArtifactId => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const bytesOf = (v: unknown) => Buffer.from(canonicalJson(v), 'utf8');
/** Inputs that shape journeys and screens: if captured, a context must have read them. */
const SHAPING = /(^|\/)(farsight\.config\.json|screens\.json)$/;

/** A deep copy that no one can change: the verified context a report reads. */
function seal<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (v: unknown) => {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      for (const k of Object.keys(v)) freeze((v as Record<string, unknown>)[k]);
      Object.freeze(v);
    }
  };
  freeze(copy);
  return copy;
}

const contextDocument = (sourceId: string, repo: string, graph: ContextGraph, inputs: readonly ContextInput[]) => ({
  schema: 'sentinel-app-context/draft-1',
  sourceId,
  repo,
  graph,
  inputs: [...inputs].sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1)),
});

/** The exact owner action that authenticates a context: `context.pin` of this document for this snapshot and source. */
export function contextPinIntent(
  request: Pick<ContextRequest, 'snapshot' | 'sourceId' | 'repo' | 'graph' | 'inputs'>,
): ActionIntent | undefined {
  if (!request.graph || !request.inputs) return undefined;
  return {
    action: 'context.pin',
    input: idOf(bytesOf(contextDocument(request.sourceId, request.repo, request.graph, request.inputs))),
    effects: ['local-artifacts'],
    budget: { maxTokens: null, maxCost: null, currency: null },
    scope: {
      profile: null,
      provider: null,
      targets: [`snapshot:${request.snapshot.id}`, `source:${request.sourceId}`],
    },
  };
}

/**
 * Pins an application graph to one snapshot source. `matched` needs every input to be a captured included file with the
 * same content id, every node located in `repo` to sit in an input, every captured `farsight.config.json` and
 * `screens.json` to be an input, at least one journey (`flow`) node, and the owner's spent `context.pin` receipt for
 * exactly this document. A failed input check is `mismatched` (`sentinel.place.inputNotCaptured`,
 * `sentinel.place.inputMismatch`, `sentinel.place.inputOmitted`, `sentinel.place.unboundNode`). No graph is
 * `unavailable` with `sentinel.place.noContext`, as is a graph with no journeys (`sentinel.place.noJourneys`) or
 * without that receipt (`sentinel.place.notOwnerConfirmed`). A context that does not bind is reported in the binding
 * and its reasons, not thrown; nothing here reads a file or fetches anything.
 */
export function pinApplicationContext(request: ContextRequest): PinnedContext {
  const { snapshot, sourceId, repo } = request;
  const snapshotId = snapshot.id;
  const authority = receiptAuthority(request.authorization);
  // Everything is read from a sealed copy: a caller's later change to its own objects reaches nothing here.
  const graph = request.graph ? seal(request.graph) : undefined;
  const inputs = request.inputs ? seal(request.inputs) : undefined;
  const reasons = new Set<PlaceReason>();
  let artifact: PinnedContext['artifact'];
  let verified = 0;
  let checkedNodes = 0;
  let binding: PinnedContext['binding'];
  if (!graph || !inputs) {
    binding = 'unavailable';
    reasons.add('sentinel.place.noContext');
  } else {
    const bytes = bytesOf(contextDocument(sourceId, repo, graph, inputs));
    artifact = { id: idOf(bytes), bytes };
    const captured = new Map<string, string>();
    for (const e of snapshot.entries)
      if (e.sourceId === sourceId && e.kind === 'file' && e.disposition === 'included')
        captured.set(e.relativePath, e.content);
    const read = new Map<string, string>();
    for (const i of inputs) {
      const c = captured.get(i.relativePath);
      if (c === undefined) reasons.add('sentinel.place.inputNotCaptured');
      else if (c !== i.content) reasons.add('sentinel.place.inputMismatch');
      else {
        verified++;
        read.set(i.relativePath, i.content);
      }
    }
    for (const path of captured.keys())
      if (SHAPING.test(path) && !read.has(path)) reasons.add('sentinel.place.inputOmitted');
    for (const n of graph.nodes) {
      if (n.loc?.repo !== repo) continue;
      checkedNodes++;
      if (!read.has(n.loc.path)) reasons.add('sentinel.place.unboundNode');
    }
    const intent = contextPinIntent({
      snapshot: { id: snapshotId, entries: snapshot.entries },
      sourceId,
      repo,
      graph,
      inputs,
    })!;
    if (reasons.size) binding = 'mismatched';
    else if (!graph.nodes.some((n) => n.kind === 'flow')) {
      binding = 'unavailable';
      reasons.add('sentinel.place.noJourneys');
    } else if (!authority || authority.action !== 'context.pin' || authority.intentDigest !== intentDigest(intent)) {
      binding = 'unavailable';
      reasons.add('sentinel.place.notOwnerConfirmed');
    } else binding = 'matched';
  }
  const receiptDoc = {
    schema: 'sentinel-context-receipt/draft-1',
    snapshotId,
    sourceId,
    repo,
    projectionVersion: PROJECTION_VERSION,
    context: artifact?.id ?? null,
    binding,
    reasons: [...reasons].sort(),
    verifiedInputs: verified,
    checkedNodes,
    producer: request.producer ?? null,
  };
  const receiptBytes = bytesOf(receiptDoc);
  const pinned = Object.freeze({
    snapshotId,
    binding,
    reasons: Object.freeze([...reasons].sort()),
    sourceId,
    repo,
    ...(artifact ? { artifact: retainedArtifact(artifact.id, artifact.bytes) } : {}),
    receipt: retainedArtifact(idOf(receiptBytes), receiptBytes),
    ...(binding === 'matched' ? { graph: graph! } : {}),
  }) as PinnedContext;
  provenance.set(pinned, { snapshotId, sourceId, authority });
  return pinned;
}
