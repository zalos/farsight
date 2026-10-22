// Customer-provided deep-analysis results (PR 18, ADR 36). Sentinel has no deep engine: none qualified for cross-file
// flow in E3, so nothing is selected, downloaded, executed or claimed here. `importDeepAnalysis` reads a
// `sentinel-deep-import/draft-1` document that a customer produced with an analyzer they are licensed to use, and
// accepts its flows only when (1) the document validates, (2) the owner confirmed exactly this document for exactly
// this snapshot with a spent receipt (the owner-only `evidence.import` action, bound to the canonical digest of the
// whole document: tool, version, distribution, licence terms, provenance, configuration and flows), and (3) every file
// it says it read is a captured file with the same content, and every flow location is inside one of those files'
// bytes. Nothing the document says about itself, such as who attested it, is trusted on its own. A document failing
// (1) is refused; failing (2) yields nothing; a flow failing (3) is unknown, never an observation. Accepted flows become `imported` observations
// that carry the tool's claim and its stated scope only: they never count as a check Sentinel executed, and the
// analyzer's mode name is recorded, never read as a capability.
import { createHash } from 'node:crypto';
import { canonicalJson } from '@farsight/graph';
import type {
  ArtifactId, DeepImportEnvelope, DeepImportLocation, Digest, ObservationEnvelope, SnapshotEnvelope, SourceEvidence,
} from '../../contracts/index.js';
import { parseEnvelope, validateEnvelope } from '../../validate.js';
import { intentDigest, receiptAuthority } from '../../policy/receipts.js';
import type { ActionIntent } from '../../contracts/index.js';

export const DEEP_REASON_CODES = Object.freeze([
  'sentinel.deep.malformed', 'sentinel.deep.notOwnerConfirmed', 'sentinel.deep.unbound',
  'sentinel.deep.fileNotCaptured', 'sentinel.deep.contentMismatch', 'sentinel.deep.contentUnverified', 'sentinel.deep.locationOutOfRange', 'sentinel.deep.locationNotRead',
  'sentinel.deep.importedNotExecuted', 'sentinel.deep.toolScopeOnly', 'sentinel.deep.buildStated',
] as const);
export type DeepReason = typeof DEEP_REASON_CODES[number];

/** What this build supports for deep analysis: no engine. Deep checks stay unsupported; import is the only path. */
export const DEEP_ANALYSIS_SUPPORT = Object.freeze({
  engine: null,
  state: 'unsupported' as const,
  reasonCode: 'sentinel.capability.noQualifiedEngine',
  decision: 'docs/proposals/farsight-sentinel/feasibility-decisions.json#engine.crossFile',
  importContract: 'sentinel-deep-import/draft-1',
});

/**
 * The exact owner action an import needs: `evidence.import` of this document's canonical digest into this snapshot's
 * source. The owner's local CLI issues a receipt for it; the coordinator spends it with `ReceiptBook.consume` and hands
 * the spent receipt to `importDeepAnalysis`. A receipt for any other document, snapshot or source authorizes nothing.
 */
export function deepImportIntent(document: string | Uint8Array, snapshotId: string): ActionIntent | undefined {
  const text = typeof document === 'string' ? document : Buffer.from(document).toString('utf8');
  const parsed = parseEnvelope('deepimport', text);
  if (!parsed.ok) return undefined;
  const doc = parsed.value as DeepImportEnvelope;
  return {
    action: 'evidence.import', input: sha(canonicalJson(doc)), effects: ['local-artifacts'],
    budget: { maxTokens: null, maxCost: null, currency: null },
    scope: { profile: null, provider: null, targets: [`snapshot:${snapshotId}`, `source:${doc.binding.sourceId}`] },
  };
}

export interface DeepImportRequest {
  /** The raw document bytes or text: untrusted, parsed and validated here. */
  readonly document: string | Uint8Array;
  readonly snapshot: Pick<SnapshotEnvelope, 'id' | 'entries'>;
  /** The owner's spent receipt for exactly `deepImportIntent(document, snapshot.id)`; only `ReceiptBook.consume` makes one. */
  readonly authorization: unknown;
  readonly readContent: (id: ArtifactId) => Promise<Uint8Array>;
  /** When the import happened, for the observations' timestamp. */
  readonly importedAt: string;
}

export type DeepImportResult =
  | { readonly status: 'refused'; readonly reasonCode: DeepReason; readonly detail: string }
  | { readonly status: 'untrusted'; readonly reasonCode: DeepReason; readonly documentDigest: Digest }
  | { readonly status: 'unbound'; readonly reasonCode: DeepReason; readonly documentDigest: Digest; readonly files: readonly { readonly relativePath: string; readonly reasonCode: DeepReason }[] }
  | {
      readonly status: 'imported';
      readonly documentDigest: Digest;
      readonly observations: readonly ObservationEnvelope[];
      /** Flows not accepted, by index, with why. */
      readonly unknown: readonly { readonly flow: number; readonly reasonCode: DeepReason }[];
      /** The scope the tool's claim holds over: exactly the files it read. */
      readonly scope: { readonly sourceId: string; readonly files: readonly string[]; readonly configurationDigest: Digest; readonly mode: string; readonly buildPerformed: boolean };
      readonly limitationKeys: readonly DeepReason[];
    };

const sha = (b: string | Uint8Array): Digest => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

export async function importDeepAnalysis(request: DeepImportRequest): Promise<DeepImportResult> {
  const bytes = typeof request.document === 'string' ? Buffer.from(request.document, 'utf8') : Buffer.from(request.document);
  if (bytes.length > MAX_DOCUMENT_BYTES) return { status: 'refused', reasonCode: 'sentinel.deep.malformed', detail: 'the document is larger than the import bound' };
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return { status: 'refused', reasonCode: 'sentinel.deep.malformed', detail: 'the document is not valid UTF-8' };
  const parsed = parseEnvelope('deepimport', text);
  if (!parsed.ok) return { status: 'refused', reasonCode: 'sentinel.deep.malformed', detail: `${parsed.errors[0]?.code ?? 'invalid'} at ${parsed.errors[0]?.path ?? '/'}` };
  const doc = parsed.value as DeepImportEnvelope;
  const documentDigest = sha(canonicalJson(doc));

  // (2) Trust is the owner's confirmation of this exact document and snapshot, held in a spent receipt that only this
  // package's receipt book can produce; nothing the document asserts about itself counts.
  const authority = receiptAuthority(request.authorization);
  const intent = deepImportIntent(text, request.snapshot.id)!;
  if (!authority || authority.action !== 'evidence.import' || authority.intentDigest !== intentDigest(intent)) {
    return { status: 'untrusted', reasonCode: 'sentinel.deep.notOwnerConfirmed', documentDigest };
  }

  // (3) The binding: this snapshot, a captured source, and every file read identical to the capture.
  if (doc.binding.snapshotId !== request.snapshot.id) return { status: 'unbound', reasonCode: 'sentinel.deep.unbound', documentDigest, files: [] };
  const captured = new Map<string, { content: ArtifactId; bytes: number }>();
  let sourceKnown = false;
  for (const e of request.snapshot.entries) {
    if (e.sourceId !== doc.binding.sourceId) continue;
    sourceKnown = true;
    if (e.kind === 'file' && e.disposition === 'included') captured.set(e.relativePath, { content: e.content, bytes: e.bytes });
  }
  if (!sourceKnown) return { status: 'unbound', reasonCode: 'sentinel.deep.unbound', documentDigest, files: [] };
  const fileProblems: { relativePath: string; reasonCode: DeepReason }[] = [];
  const read = new Map<string, ArtifactId>();
  for (const f of doc.binding.files) {
    const c = captured.get(f.relativePath);
    if (!c) fileProblems.push({ relativePath: f.relativePath, reasonCode: 'sentinel.deep.fileNotCaptured' });
    else if (c.content !== f.content) fileProblems.push({ relativePath: f.relativePath, reasonCode: 'sentinel.deep.contentMismatch' });
    else if (read.has(f.relativePath)) fileProblems.push({ relativePath: f.relativePath, reasonCode: 'sentinel.deep.unbound' });
    else read.set(f.relativePath, f.content);
  }
  // The analyzer read something other than this capture: none of its results are about this source.
  if (fileProblems.length) return { status: 'unbound', reasonCode: 'sentinel.deep.unbound', documentDigest, files: fileProblems.slice(0, 1000) };

  // A location is checked against the captured bytes themselves: the reader's bytes must hash to the content id and
  // have the captured length, so a reader returning other or longer bytes cannot widen what a span may cover.
  const capturedBytes = new Map([...captured.values()].map(c => [c.content, c.bytes]));
  const lengths = new Map<string, Promise<number | undefined>>();
  const lengthOf = (content: ArtifactId) => {
    let p = lengths.get(content);
    if (!p) lengths.set(content, p = request.readContent(content).then(bytes => {
      const ok = sha(bytes) === content && bytes.length === capturedBytes.get(content);
      return ok ? bytes.length : undefined;
    }, () => undefined));
    return p;
  };
  const locate = async (l: DeepImportLocation): Promise<DeepReason | SourceEvidence> => {
    const content = read.get(l.relativePath);
    if (!content) return 'sentinel.deep.locationNotRead';
    if (content !== l.content) return 'sentinel.deep.contentMismatch';
    const length = await lengthOf(content);
    if (length === undefined) return 'sentinel.deep.contentUnverified';
    if (!(l.span.startByte < l.span.endByte && l.span.endByte <= length)) return 'sentinel.deep.locationOutOfRange';
    return { snapshotId: request.snapshot.id, sourceId: doc.binding.sourceId, relativePath: l.relativePath, content, span: { startByte: l.span.startByte, endByte: l.span.endByte } };
  };

  const observations: ObservationEnvelope[] = [];
  const unknown: { flow: number; reasonCode: DeepReason }[] = [];
  const limitationKeys: DeepReason[] = ['sentinel.deep.importedNotExecuted', 'sentinel.deep.toolScopeOnly', ...(doc.binding.buildPerformed ? ['sentinel.deep.buildStated' as const] : [])];
  for (let i = 0; i < doc.flows.length; i++) {
    const flow = doc.flows[i]!;
    const located = await Promise.all([flow.source, ...flow.steps, flow.sink].map(locate));
    const problem = located.find((x): x is DeepReason => typeof x === 'string');
    if (problem) { unknown.push({ flow: i, reasonCode: problem }); continue; }
    const evidence = located as SourceEvidence[];
    const observation: ObservationEnvelope = {
      schema: 'sentinel-observation/draft-1',
      id: `deep.${sha(`${documentDigest}\u0000${i}`).slice(7, 47)}`,
      snapshotId: request.snapshot.id,
      producer: { kind: 'imported', provenanceArtifact: documentDigest },
      producerRuleId: flow.toolRuleId,
      originalSeverity: flow.originalSeverity,
      message: `${doc.tool.name} ${doc.tool.version}: ${flow.message}`.slice(0, 4000),
      evidence: evidence.slice(0, 256),
      limitationKeys: [...limitationKeys],
      observedAt: request.importedAt,
    };
    const valid = validateEnvelope('observation', observation);
    if (!valid.ok) { unknown.push({ flow: i, reasonCode: 'sentinel.deep.malformed' }); continue; }
    observations.push(valid.value);
  }
  return {
    status: 'imported', documentDigest, observations, unknown,
    scope: { sourceId: doc.binding.sourceId, files: [...read.keys()].sort(), configurationDigest: doc.binding.configurationDigest, mode: doc.binding.mode, buildPerformed: doc.binding.buildPerformed },
    limitationKeys,
  };
}
