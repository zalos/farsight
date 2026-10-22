// Review scope and evidence (PR 22).
//
// partitionInventory — the general review's scope: every included source file of one source, sorted by path and
// cut greedily into partitions bounded by file count and bytes. Its inputs are the captured inventory and the bounds
// only, never scanner or detector results, so a file with no hit is reviewed as readily as one with many. What it
// cannot review (uncaptured, too large, another language, an unlisted folder) is a gap with its reason, never dropped.
//
// EvidenceBroker — the only way a model sees source. It serves bounded line slices of captured files inside one fixed
// scope, rule definitions pinned in the task, and recorded call reachability when given. Every slice is read from
// the store by content id, hash-checked, and cited with exact UTF-8 byte offsets and a quote digest; served slices get
// stable evidence ids, which are the only citations a reply may use. A request outside the scope, over budget, for a
// withheld span (an opaque secret-location ref) or for an unknown tool is refused as data, and recorded.
import { createHash } from 'node:crypto';
import type { ArtifactId, CaptureEntry, Digest, ReviewPartition, ReviewPartitionMember, ReviewPartitionsEnvelope, ScopedReason, ServedCitation, SnapshotEnvelope, SourceEvidence } from '../contracts/index.js';
import { digestOf } from '../store/ledger-json.js';
import { validateEnvelope } from '../validate.js';
import { canonicalDigest } from '../policy/digest.js';
import { snapshot as snapshotFreeze } from '../policy/immutable.js';
import { reviewFail, type ReviewFrontierCode, type ToolRefusalCode } from './errors.js';

const sha = (b: Uint8Array | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const REVIEWABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|java)$/;

export interface PartitionBounds {
  readonly maxFiles: number;
  readonly maxBytes: number;
}

export type PartitionMember = ReviewPartitionMember;
export type Partition = ReviewPartition;
/** The general review's scope: the registered `sentinel-review-partitions/draft-1` envelope. */
export type PartitionPlan = ReviewPartitionsEnvelope;

const scopeOf = (sourceId: string, path: string) =>
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(path) ? `${sourceId}:#${sha(path).slice(7, 31)}` : `${sourceId}:${path}`;

/**
 * The fields of a withheld-location citation (`location: 'withheld'`, PR 11's secret-scan contract) the review reads,
 * typed structurally until that contract is integrated. It names a capture entry by index, never by path.
 */
export interface WithheldLocationView {
  readonly location: 'withheld';
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly entry: number;
  readonly content: string;
  readonly span: { readonly startByte: number; readonly endByte: number };
}

/**
 * The capture entries withheld citations name, checked against the snapshot: the same snapshot and source, an included
 * file, the same content. Anything that does not resolve refuses the review (fail closed), because a citation that
 * cannot be placed could be any file.
 */
export function withheldEntries(snapshot: Pick<SnapshotEnvelope, 'id' | 'entries'>, sourceId: string, withheld: readonly WithheldLocationView[]): ReadonlySet<number> {
  const out = new Set<number>();
  for (const w of withheld) {
    const e = Number.isSafeInteger(w.entry) && w.entry >= 0 ? snapshot.entries[w.entry] : undefined;
    if (w.location !== 'withheld' || w.snapshotId !== snapshot.id || w.sourceId !== sourceId || !e || e.sourceId !== sourceId
      || e.kind !== 'file' || e.disposition !== 'included' || e.content !== w.content) {
      reviewFail('sentinel.review.invalidInput', 'a withheld citation does not resolve to an included file of this snapshot and source');
    }
    out.add(w.entry);
  }
  return out;
}

/** The withheld scope for a gap: the entry's index, never its path. */
const withheldScope = (sourceId: string, entry: number) => `${sourceId}#entry:${entry}`;

/**
 * Partitions one source's captured inventory. Deterministic: inputs are the snapshot entries, the bounds and the
 * withheld citations. A file a withheld citation names leaves the scope whole (its path is not sent either) and is a
 * `withheld` gap named by its entry index.
 */
export function partitionInventory(snapshot: Pick<SnapshotEnvelope, 'id' | 'entries'>, sourceId: string, bounds: PartitionBounds,
  options: { readonly withheld?: readonly WithheldLocationView[] } = {}): PartitionPlan {
  if (!Number.isSafeInteger(bounds.maxFiles) || bounds.maxFiles < 1 || bounds.maxFiles > 1000
    || !Number.isSafeInteger(bounds.maxBytes) || bounds.maxBytes < 1 || bounds.maxBytes > 16 * 1024 * 1024) {
    reviewFail('sentinel.review.invalidInput', 'partition bounds are 1–1000 files and 1 byte–16 MiB');
  }
  const gaps: ScopedReason[] = [];
  const gap = (path: string, reasonCode: ReviewFrontierCode) => gaps.push({ scopeId: scopeOf(sourceId, path), reasonCode });
  const files: PartitionMember[] = [];
  const hidden = withheldEntries(snapshot, sourceId, options.withheld ?? []);
  for (const i of [...hidden].sort((a, b) => a - b)) gaps.push({ scopeId: withheldScope(sourceId, i), reasonCode: 'sentinel.review.frontier.withheld' });
  const entries = snapshot.entries.filter((e, i) => e.sourceId === sourceId && !hidden.has(i))
    .sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  for (const e of entries as CaptureEntry[]) {
    if (e.kind === 'directory-boundary') { gap(e.relativePath, 'sentinel.review.frontier.unknownScope'); continue; }
    if (!REVIEWABLE.test(e.relativePath)) continue;
    if (e.kind !== 'file' || e.disposition !== 'included') { gap(e.relativePath, 'sentinel.review.frontier.notCaptured'); continue; }
    if (e.bytes > bounds.maxBytes) { gap(e.relativePath, 'sentinel.review.frontier.tooLarge'); continue; }
    files.push({ relativePath: e.relativePath, content: e.content, bytes: e.bytes });
  }
  const partitions: { id: string; members: PartitionMember[]; bytes: number }[] = [];
  let cur: PartitionMember[] = [];
  let bytes = 0;
  const close = () => {
    if (!cur.length) return;
    const id = `part-${digestOf({ sourceId, members: cur.map(m => [m.relativePath, m.content]) }).slice(7, 31)}`;
    partitions.push({ id, members: cur, bytes });
    cur = []; bytes = 0;
  };
  for (const f of files) {
    if (cur.length >= bounds.maxFiles || bytes + f.bytes > bounds.maxBytes) close();
    cur.push(f);
    bytes += f.bytes;
  }
  close();
  if (partitions.length > 20000 || gaps.length > 20000) reviewFail('sentinel.review.invalidInput', 'the source has more partitions or gaps than one plan holds; partition a narrower scope');
  const body = { schema: 'sentinel-review-partitions/draft-1' as const, snapshotId: snapshot.id, sourceId, bounds: { maxFiles: bounds.maxFiles, maxBytes: bounds.maxBytes },
    partitions: partitions.map(p => ({ id: p.id, members: p.members.map(m => ({ relativePath: m.relativePath, content: m.content, bytes: m.bytes })), bytes: p.bytes })), gaps };
  const plan: PartitionPlan = { ...body, digest: digestOf(body) as Digest };
  const checked = validateEnvelope('partitions', plan);
  if (!checked.ok) reviewFail('sentinel.review.integrity', `the partition plan does not validate: ${checked.errors[0]?.path} ${checked.errors[0]?.message}`);
  return snapshotFreeze(plan);
}

// ---- the evidence broker ----

export interface EvidenceLimits {
  /** Lines one read may return. */
  readonly maxSliceLines: number;
  /** Bytes one read may return. */
  readonly maxSliceBytes: number;
  /** Tool calls one session may make. */
  readonly maxToolCalls: number;
  /** Bytes of evidence one session may be served in total. */
  readonly maxServedBytes: number;
}

/** A rule definition pinned in the task: the only rule text a model may read. */
export interface PinnedRule { readonly familyId: string; readonly revisionDigest: Digest; readonly text: string }

/** Recorded call reachability for a node, from PR 18's path evidence; structural, never data flow. */
export interface PathFact { readonly nodeId: string; readonly summary: string }

/**
 * The fields of PR 18's `sentinel-paths/draft-1` envelope the review reads, typed structurally so this module neither
 * imports nor restates that contract; a different schema version is refused.
 */
export interface PathEvidenceView {
  readonly schema: 'sentinel-paths/draft-1';
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly establishes: 'call-reachability';
  readonly results: readonly {
    readonly from: string; readonly to: string; readonly outcome: 'reached' | 'not-reached-complete' | 'not-reached-bounded';
    readonly paths: readonly { readonly steps: readonly { readonly from: string; readonly to: string }[] }[];
  }[];
}

/** Path facts for a review scope: one per `from` node, each result summarized; bounded, structural, never data flow. */
export function pathFactsFrom(view: PathEvidenceView, scope: { snapshotId: string; sourceId: string }, maxPerNode = 16): PathFact[] {
  if (view.schema !== 'sentinel-paths/draft-1' || view.establishes !== 'call-reachability') reviewFail('sentinel.review.invalidInput', 'not a sentinel-paths/draft-1 envelope');
  if (view.snapshotId !== scope.snapshotId || view.sourceId !== scope.sourceId) reviewFail('sentinel.review.invalidInput', 'the path evidence is for another snapshot or source');
  const byNode = new Map<string, string[]>();
  for (const r of view.results) {
    const line = r.outcome === 'reached'
      ? `reaches ${r.to} via ${[r.paths[0]?.steps[0]?.from ?? r.from, ...(r.paths[0]?.steps ?? []).map(s => s.to)].join(' -> ')}`
      : r.outcome === 'not-reached-complete' ? `does not reach ${r.to} in the parser's call graph` : `reach of ${r.to} unknown: the search was bounded`;
    const list = byNode.get(r.from) ?? [];
    if (list.length < maxPerNode) list.push(line);
    byNode.set(r.from, list);
  }
  return [...byNode].sort(([a], [b]) => (a < b ? -1 : 1)).map(([nodeId, lines]) => ({ nodeId, summary: lines.join('\n') }));
}

/** One served slice. `id` is what a reply cites; `citation` is the exact captured bytes. */
export interface EvidenceItem {
  readonly id: string;
  readonly relativePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly citation: SourceEvidence;
}

export type ToolRequest =
  | { readonly action: 'list' }
  | { readonly action: 'read'; readonly path: string; readonly startLine: number; readonly endLine: number }
  | { readonly action: 'rule'; readonly familyId: string }
  | { readonly action: 'paths'; readonly nodeId: string };

export type ToolResult =
  | { readonly ok: true; readonly tool: ToolRequest['action']; readonly data: unknown; readonly evidence: readonly EvidenceItem[] }
  | { readonly ok: false; readonly tool: string; readonly refused: ToolRefusalCode; readonly detail: string };

export interface EvidenceScope {
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly files: readonly PartitionMember[];
  readonly rules: readonly PinnedRule[];
  readonly paths: readonly PathFact[];
}

/**
 * Decides whether a span may be disclosed. Opaque secret-location refs (another lane's) plug in here: a withheld
 * span is refused, and the refusal is a frontier, never a silent omission.
 */
export type DisclosureFilter = (relativePath: string, span: { startByte: number; endByte: number }) => 'allow' | 'withhold';

export interface BrokerState {
  readonly toolCalls: number;
  readonly servedBytes: number;
  readonly served: readonly EvidenceItem[];
  readonly refusals: readonly { tool: string; code: ToolRefusalCode }[];
}

const LIMIT_CEILINGS: Readonly<EvidenceLimits> = Object.freeze({ maxSliceLines: 2000, maxSliceBytes: 256 * 1024, maxToolCalls: 1000, maxServedBytes: 16 * 1024 * 1024 });
const ID_TEXT = /^[^\u0000-\u001f\u007f]{1,1024}$/;

/** Line boundaries in UTF-8 bytes: line n (1-based) spans [starts[n-1], starts[n]). */
function lineStarts(bytes: Uint8Array): number[] {
  const out = [0];
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) out.push(i + 1);
  if (out[out.length - 1] !== bytes.length) out.push(bytes.length);
  return out;
}

export class EvidenceBroker {
  readonly #scope: EvidenceScope;
  readonly #limits: EvidenceLimits;
  readonly #read: (content: ArtifactId) => Promise<Uint8Array>;
  readonly #withhold: DisclosureFilter;
  readonly #files: Map<string, PartitionMember>;
  #toolCalls = 0;
  #servedBytes = 0;
  readonly #served = new Map<string, EvidenceItem>();
  readonly #refusals: { tool: string; code: ToolRefusalCode }[] = [];
  readonly #cache = new Map<string, Uint8Array>();

  constructor(scope: EvidenceScope, limits: EvidenceLimits, read: (content: ArtifactId) => Promise<Uint8Array>, withhold: DisclosureFilter = () => 'allow') {
    for (const k of Object.keys(LIMIT_CEILINGS) as (keyof EvidenceLimits)[]) {
      const v = limits[k];
      if (!Number.isSafeInteger(v) || v < 1 || v > LIMIT_CEILINGS[k]) reviewFail('sentinel.review.invalidInput', `evidence limit ${k} is 1–${LIMIT_CEILINGS[k]}`);
    }
    this.#scope = scope;
    this.#limits = limits;
    this.#read = read;
    this.#withhold = withhold;
    this.#files = new Map(scope.files.map(f => [f.relativePath, f]));
  }

  get scope(): EvidenceScope { return this.#scope; }

  state(): BrokerState {
    return { toolCalls: this.#toolCalls, servedBytes: this.#servedBytes, served: [...this.#served.values()], refusals: [...this.#refusals] };
  }

  /** Re-checks a served item's quote against the hash-verified captured bytes this broker holds. */
  verifyServed(id: string): boolean {
    const item = this.#served.get(id);
    const bytes = item && this.#cache.get(item.citation.content);
    if (!item || !bytes) return false;
    return sha(bytes.subarray(item.citation.span.startByte, item.citation.span.endByte)) === item.citation.quoteDigest;
  }

  /** The item a citation names, if this broker served it. */
  served(id: string): EvidenceItem | undefined { return this.#served.get(id); }

  /** Restores slices served before a checkpoint, re-reading and re-verifying their bytes. */
  async restore(items: readonly ServedCitation[], toolCalls: number): Promise<void> {
    for (const item of items) {
      const f = this.#files.get(item.citation.relativePath);
      if (!f || f.content !== item.citation.content) reviewFail('sentinel.review.checkpoint', 'a checkpointed slice is outside this scope');
      const again = await this.#slice(f!, item.startLine, item.endLine);
      if (again.id !== item.id || again.citation.quoteDigest !== item.citation.quoteDigest) reviewFail('sentinel.review.checkpoint', 'a checkpointed slice no longer matches the captured bytes');
      this.#served.set(item.id, again);
      this.#servedBytes += Buffer.byteLength(again.text);
    }
    this.#toolCalls = toolCalls;
  }

  async #bytes(f: PartitionMember): Promise<Uint8Array> {
    const hit = this.#cache.get(f.content);
    if (hit) return hit;
    const b = await this.#read(f.content);
    if (sha(b) !== f.content || b.byteLength !== f.bytes) reviewFail('sentinel.review.integrity', `${f.relativePath}: the bytes read are not the captured content`);
    this.#cache.set(f.content, b);
    return b;
  }

  async #slice(f: PartitionMember, startLine: number, endLine: number): Promise<EvidenceItem> {
    const bytes = await this.#bytes(f);
    const starts = lineStarts(bytes);
    const lines = starts.length - 1;
    const s = Math.min(startLine, Math.max(lines, 1));
    const e = Math.min(endLine, lines);
    const span = { startByte: starts[s - 1] ?? 0, endByte: starts[e] ?? bytes.length };
    const quote = bytes.subarray(span.startByte, span.endByte);
    const quoteDigest = sha(quote) as Digest;
    const citation: SourceEvidence = { snapshotId: this.#scope.snapshotId, sourceId: this.#scope.sourceId, relativePath: f.relativePath,
      content: f.content, span, quoteDigest };
    const id = `ev-${canonicalDigest({ path: f.relativePath, content: f.content, span }).slice(7, 23)}`;
    return Object.freeze({ id, relativePath: f.relativePath, startLine: s, endLine: e, text: new TextDecoder('utf-8', { fatal: false }).decode(quote), citation: Object.freeze(citation) });
  }

  /** Runs one tool request. Never throws for the model's mistakes: a refusal is a result. */
  async run(req: ToolRequest): Promise<ToolResult> {
    const refuse = (code: ToolRefusalCode, detail: string): ToolResult => {
      this.#refusals.push({ tool: req.action, code });
      return { ok: false, tool: req.action, refused: code, detail };
    };
    if (this.#toolCalls >= this.#limits.maxToolCalls) return refuse('sentinel.review.tool.budget', 'the session used every tool call it may make');
    this.#toolCalls++;
    switch (req.action) {
      case 'list':
        return { ok: true, tool: 'list', data: { files: this.#scope.files.map(f => ({ path: f.relativePath, bytes: f.bytes })) }, evidence: [] };
      case 'rule': {
        const r = this.#scope.rules.find(x => x.familyId === req.familyId);
        if (!r) return refuse('sentinel.review.tool.outOfScope', 'not a rule of this task');
        return { ok: true, tool: 'rule', data: { familyId: r.familyId, definition: r.text }, evidence: [] };
      }
      case 'paths': {
        const p = this.#scope.paths.find(x => x.nodeId === req.nodeId);
        if (!p) return refuse('sentinel.review.tool.outOfScope', 'no recorded paths for this node in this task');
        return { ok: true, tool: 'paths', data: { nodeId: p.nodeId, reachability: p.summary, establishes: 'call-reachability, not data flow' }, evidence: [] };
      }
      case 'read': {
        const f = this.#files.get(req.path);
        if (!f) return refuse('sentinel.review.tool.outOfScope', 'not a file of this scope');
        const { startLine: a, endLine: b } = req;
        if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < a) return refuse('sentinel.review.tool.invalidArgs', 'lines are 1-based and ordered');
        if (b - a + 1 > this.#limits.maxSliceLines) return refuse('sentinel.review.tool.invalidArgs', `at most ${this.#limits.maxSliceLines} lines per read`);
        const item = await this.#slice(f, a, b);
        if (this.#withhold(item.relativePath, item.citation.span) === 'withhold') return refuse('sentinel.review.tool.withheld', 'this span is withheld from disclosure');
        const size = Buffer.byteLength(item.text);
        if (size > this.#limits.maxSliceBytes) return refuse('sentinel.review.tool.budget', 'the slice is larger than one read may return');
        if (!this.#served.has(item.id)) {
          if (this.#servedBytes + size > this.#limits.maxServedBytes) return refuse('sentinel.review.tool.budget', 'the session was served all the evidence it may be');
          this.#servedBytes += size;
          this.#served.set(item.id, item);
        }
        return { ok: true, tool: 'read', data: { path: item.relativePath, startLine: item.startLine, endLine: item.endLine }, evidence: [item] };
      }
      default:
        return refuse('sentinel.review.tool.unknown', 'not a tool of this session');
    }
  }
}

export const isIdText = (v: unknown): v is string => typeof v === 'string' && ID_TEXT.test(v);

/**
 * A guided check's files without those withheld citations name: the remaining files, and one `withheld` gap per removed
 * entry, by index. Use it before `guidedSpec`, so a withheld file's path never reaches a model.
 */
export function withoutWithheld(snapshot: Pick<SnapshotEnvelope, 'id' | 'entries'>, sourceId: string, files: readonly PartitionMember[],
  withheld: readonly WithheldLocationView[]): { files: PartitionMember[]; gaps: ScopedReason[] } {
  const hidden = withheldEntries(snapshot, sourceId, withheld);
  const byPath = new Map<string, number>();
  snapshot.entries.forEach((e, i) => { if (hidden.has(i)) byPath.set(e.relativePath, i); });
  return { files: files.filter(f => !byPath.has(f.relativePath)),
    gaps: files.filter(f => byPath.has(f.relativePath)).map(f => ({ scopeId: withheldScope(sourceId, byPath.get(f.relativePath)!), reasonCode: 'sentinel.review.frontier.withheld' })) };
}
