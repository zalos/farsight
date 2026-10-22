// Portable parser evidence for an admitted snapshot (PR 05). The public `@farsight/code-parser` runs its built-in
// TS/JS and Java adapters over a private materialization restored from the store alone, never over the original
// checkout, with explicit selection and limits. The parser has no reader hook, so integrity is checked around it:
// the materialized tree is fingerprinted before and after, and every recorded `analysis.inputs` row is reconciled by
// kind against that tree and the captured inventory. File outcomes are joined to the capture separately; the
// capture is never changed. No application ingestion, configuration enrichment, network or executable input.
import { canonicalJson } from '@farsight/graph';
import type * as CodeParser from '@farsight/code-parser';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { ArtifactId, CaptureEntry, SnapshotEnvelope, WorkRef } from '../contracts/index.js';
import type { ArtifactPrivacy, PublicationReceipt, SentinelStore, StagedArtifact } from '../store/index.js';
import { MAX_ARTIFACT_BYTES } from '../store/index.js';
import { restoreSnapshot, type RestoreStore } from './materialize.js';
import type { Materialization } from './materialization.js';

export const PARSER_RESULT_SCHEMA = 'sentinel-parser-result/draft-1';
export const PARSER_INDEX_SCHEMA = 'sentinel-parser-index/draft-1';
/** The parser stage's identity, for the work unit that publishes this evidence. */
export const PARSER_STAGE_CONTRACT = 'sentinel.stage.parse';

export const PARSER_ERROR_CODES = Object.freeze([
  'sentinel.parse.invalidRequest', 'sentinel.parse.integrity', 'sentinel.parse.artifactTooLarge',
] as const);
export type ParserErrorCode = typeof PARSER_ERROR_CODES[number];

/** At most this many integrity problems are carried on an error; the count is always exact. */
const MAX_PROBLEMS = 20;
/** At most this many index entries per source; the remainder is counted, never dropped silently. */
const MAX_INDEX_ENTRIES = 100_000;
/** At most this many unplaced locations are listed per source; the remainder is counted. */
const MAX_LISTED = 100;

export class ParserError extends Error {
  readonly code: ParserErrorCode;
  /** Bounded detail: the first problems found (paths and reasons), never file contents. */
  readonly problems: readonly string[];
  readonly problemCount: number;
  constructor(code: ParserErrorCode, message: string, problems: readonly string[] = []) {
    super(`${code}: ${message}${problems.length ? ` (${problems.length} shown)` : ''}`);
    this.name = 'ParserError';
    this.code = code;
    this.problemCount = problems.length;
    this.problems = Object.freeze(problems.slice(0, MAX_PROBLEMS));
  }
}

/**
 * Parser selection, stated in full: nothing defaults silently. Only syntax selection is accepted; application
 * enrichment switches (externals, plumbing, setup) are refused.
 */
export interface ParserSelection {
  readonly gitignore: boolean;
  readonly testFiles: 'include' | 'exclude';
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly testGlobs?: { readonly include?: readonly string[]; readonly exclude?: readonly string[] };
}

export interface ParseSnapshotRequest {
  readonly snapshotId: string;
  /** A canonical private folder this call may create its materialization in; removed afterwards. */
  readonly workDir: string;
  /** Sources to parse; default every captured source. */
  readonly sources?: readonly string[];
  readonly selection: ParserSelection;
  /** Every limit, explicitly. */
  readonly limits: ParserLimits;
  readonly signal?: AbortSignal;
}

/** How one recorded parser input reconciled. */
export type InputOutcome =
  | 'content-captured'
  | 'directory-listed'
  | 'metadata-matched'
  /** The path is absent from the captured tree and its parent was fully enumerated. */
  | 'missing-verified-absent'
  /** Present at capture but recorded without bytes (excluded, refused, unreadable, too large, a symlink). */
  | 'missing-recorded-refusal'
  /** Below a directory capture did not enumerate: unknown scope, not absence. */
  | 'missing-under-boundary'
  /** Inside a submodule this snapshot holds only as a link. */
  | 'missing-in-gitlink';

export interface ReconciledInput {
  readonly path: string;
  readonly kind: InputFingerprint['kind'];
  readonly outcome: InputOutcome;
  /** The captured entry or boundary that explains a missing path. */
  readonly explainedBy?: { readonly path: string; readonly kind: CaptureEntry['kind'] | 'gitlink'; readonly disposition?: string; readonly reasonCode?: string };
}

/** One captured entry's parser outcome, joined without changing the capture. */
export type FileClass =
  | 'parsed'
  | 'parse-failed'
  | 'parser-skipped'
  /** Included and materialized, but the parser did not select it (unsupported, ignored, hidden, generated layout). */
  | 'not-selected'
  /** Recorded by capture without bytes; capture's disposition takes precedence. */
  | 'not-captured'
  /** A directory whose descendants capture did not enumerate. */
  | 'unknown-scope';

export interface JoinedEntry {
  readonly path: string;
  readonly captureKind: CaptureEntry['kind'];
  readonly disposition: CaptureEntry['disposition'];
  readonly generated?: boolean;
  readonly content?: ArtifactId;
  readonly class: FileClass;
  readonly parser?: { readonly status: string; readonly reason?: string; readonly adapter?: string };
  /** Diagnostics naming this path, by code. Lines are as the parser gave them; none is invented. */
  readonly diagnostics: number;
}

export interface IndexedLocation {
  readonly path: string;
  /** The captured file's artifact id, so evidence cites immutable bytes. */
  readonly content: ArtifactId;
  readonly line: number;
  readonly endLine?: number;
  /** Zero-based, half-open UTF-8 byte span, derived from the captured bytes. */
  readonly byteSpan?: { readonly startByte: number; readonly endByte: number };
}

export interface ParserIndex {
  readonly schema: typeof PARSER_INDEX_SCHEMA;
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly analysisFingerprint: string;
  readonly nodes: readonly ({ readonly nodeId: string; readonly kind: string } & IndexedLocation)[];
  readonly occurrences: readonly ({ readonly occurrenceId: string; readonly edgeId: string } & IndexedLocation)[];
  /** Entries beyond the index bound, counted. */
  readonly omitted: number;
  /** Locations naming a path that is not a captured, materialized file: counted, the first few listed. */
  readonly unplaced: { readonly count: number; readonly paths: readonly string[] };
}

export interface ParserResult {
  readonly schema: typeof PARSER_RESULT_SCHEMA;
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly parser: AnalysisArtifact['analysis']['parser'];
  readonly adapters: AnalysisArtifact['analysis']['adapters'];
  readonly selection: ParserSelection;
  readonly limits: ParserLimits;
  readonly analysisFingerprint: string;
  /** The parser's own flag: its selection completed. Never security coverage. */
  readonly parserComplete: boolean;
  /** Fingerprints of the materialized tree (paths, kinds, bytes or listings, modes) around the parse. */
  readonly tree: { readonly before: string; readonly after: string; readonly files: number; readonly directories: number };
  readonly inputs: readonly ReconciledInput[];
  readonly entries: readonly JoinedEntry[];
  readonly counts: Readonly<Record<FileClass, number>> & { readonly unknownScopeDescendants: null | number };
  /** Facts this artifact alone can never clear: it is syntax evidence, not enforcement or test evidence. */
  readonly clearsChecks: false;
}

export interface SourceAnalysis {
  readonly sourceId: string;
  readonly artifact: AnalysisArtifact;
  readonly result: ParserResult;
  readonly index: ParserIndex;
}

export interface SnapshotAnalysis {
  readonly snapshotId: string;
  readonly sources: readonly SourceAnalysis[];
}

// ---- the public parser's artifact, as Sentinel exposes it ----
// Declared here so the published declarations name no workspace package. The assignment below fails to compile if
// the parser's own types ever stop fitting these shapes.

/** One recorded read: a file's bytes, a folder listing, a kind, or an unavailable path (hex SHA-256 digests). */
export interface InputFingerprint {
  readonly path: string;
  readonly kind: 'content' | 'directory' | 'metadata' | 'missing';
  readonly digest: string;
}

export interface ParserLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxEntries: number;
  readonly maxDurationMs: number;
}

export interface ParserLocation {
  readonly repo: string;
  readonly path: string;
  readonly line: number;
  readonly col?: number;
  readonly endLine?: number;
}

/** The portable graph, with the fields Sentinel reads named; every other field is kept verbatim at run time. */
export interface AnalysisGraph {
  readonly nodes: readonly ({ readonly id: string; readonly kind: string; readonly loc?: ParserLocation })[];
  readonly edges: readonly ({
    readonly id: string; readonly kind: string; readonly from: string; readonly to: string;
    readonly occurrences?: readonly ({ readonly id: string; readonly loc: ParserLocation; readonly span?: { readonly start: number; readonly end: number } })[];
  })[];
}

/** `farsight-analysis` from `@farsight/code-parser`, kept complete (occurrences included). */
export interface AnalysisArtifact {
  readonly format: 'farsight-analysis';
  readonly schemaVersion: number;
  readonly graph: AnalysisGraph;
  readonly analysis: {
    readonly fingerprint: string;
    readonly parser: { readonly name: '@farsight/code-parser'; readonly version: string };
    readonly adapters: readonly { readonly id: string; readonly version: string }[];
    readonly inputs: readonly InputFingerprint[];
    readonly files: readonly { readonly path: string; readonly status: 'analyzed' | 'skipped' | 'failed'; readonly reason?: string; readonly adapter?: string; readonly digest?: string }[];
    readonly diagnostics: readonly { readonly code: string; readonly severity: 'error' | 'warning'; readonly message: string; readonly path?: string; readonly adapter?: string; readonly line?: number; readonly nodeId?: string; readonly reason?: string }[];
    readonly complete: boolean;
    readonly capabilities: readonly string[];
    readonly limits: readonly string[];
  };
}

// Compile-time drift guards (not exported, so not in the published declarations).
const fitsArtifact = (a: CodeParser.AnalysisArtifact): AnalysisArtifact => a;
const fitsLimits = (l: ParserLimits): CodeParser.ParserLimits => l;
void fitsArtifact; void fitsLimits;

const sha256hex = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const UNAVAILABLE = sha256hex('unavailable');

// ---- request checks ----

const SELECTION_KEYS = new Set(['gitignore', 'testFiles', 'include', 'exclude', 'testGlobs']);
const LIMIT_KEYS = ['maxFiles', 'maxFileBytes', 'maxTotalBytes', 'maxEntries', 'maxDurationMs'] as const;

function checkRequest(req: ParseSnapshotRequest): void {
  const bad = (m: string) => new ParserError('sentinel.parse.invalidRequest', m);
  if (!req || typeof req.snapshotId !== 'string' || !req.snapshotId) throw bad('a snapshot id is required');
  if (typeof req.workDir !== 'string' || !isAbsolute(req.workDir)) throw bad('workDir must be absolute');
  let real: string;
  try { real = realpathSync.native(req.workDir); } catch { throw bad('workDir must exist'); }
  if (real !== req.workDir || !lstatSync(real).isDirectory()) throw bad('workDir must be a canonical folder');
  const s = req.selection;
  if (!s || typeof s !== 'object') throw bad('selection is required');
  for (const k of Object.keys(s)) if (!SELECTION_KEYS.has(k)) throw bad(`selection.${k} is not a syntax selection option`);
  if (typeof s.gitignore !== 'boolean') throw bad('selection.gitignore must be stated');
  if (s.testFiles !== 'include' && s.testFiles !== 'exclude') throw bad('selection.testFiles must be stated');
  const l = req.limits;
  if (!l || typeof l !== 'object') throw bad('limits are required');
  for (const k of Object.keys(l)) if (!(LIMIT_KEYS as readonly string[]).includes(k)) throw bad(`limits.${k} is unknown`);
  for (const k of LIMIT_KEYS) if (!Number.isSafeInteger(l[k]) || l[k] < 1) throw bad(`limits.${k} must be a positive integer`);
}

// ---- the materialized tree ----

export interface TreeRow {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  /** Hex: a file's bytes, or a folder's sorted names as canonical JSON (the parser's own encodings). */
  readonly digest: string;
  readonly mode: number;
}

/** Every entry under `root` ('.' is the root itself). Any link or special file fails integrity. */
export function fingerprintTree(root: string): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (abs: string, rel: string) => {
    const names = readdirSync(abs).sort();
    rows.push({ path: rel, kind: 'directory', digest: sha256hex(canonicalJson(names)), mode: lstatSync(abs).mode & 0o7777 });
    for (const name of names) {
      const childAbs = join(abs, name);
      const child = rel === '.' ? name : `${rel}/${name}`;
      const st = lstatSync(childAbs);
      if (st.isDirectory()) walk(childAbs, child);
      else if (st.isFile()) rows.push({ path: child, kind: 'file', digest: sha256hex(readFileSync(childAbs)), mode: st.mode & 0o7777 });
      else throw new ParserError('sentinel.parse.integrity', 'the materialization holds a link or special file', [child]);
    }
  };
  walk(root, '.');
  return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export const treeDigest = (rows: readonly TreeRow[]): string => sha256hex(canonicalJson(rows));

/** The parser reads only non-executable, read-only files: the snapshot's sidecar keeps the original modes. */
export function assertParserInputSafe(rows: readonly TreeRow[]): void {
  const bad = rows.filter(r => (r.kind === 'file' ? (r.mode & 0o333) !== 0 : (r.mode & 0o222) !== 0)).map(r => r.path);
  if (bad.length) throw new ParserError('sentinel.parse.integrity', 'a parser input is writable or executable', bad);
}

// ---- reconciliation ----

const SAFE = (p: unknown): p is string => typeof p === 'string' && p.length > 0 && p.length <= 4096
  && (p === '.' || (!p.startsWith('/') && !p.includes('\\') && !p.includes('\u0000')
    && p.split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..')));

const parentsOf = (p: string): string[] => {
  const parts = p.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
};

/**
 * Reconciles each recorded parser input against the materialized tree (before the parse) and the captured inventory.
 * Returns the outcomes, or throws `sentinel.parse.integrity` with every unexplained input (bounded detail).
 */
export function reconcileAnalysisInputs(
  inputs: readonly InputFingerprint[], tree: readonly TreeRow[], sourceId: string,
  snapshot: Pick<SnapshotEnvelope, 'entries'>, materialization: Pick<Materialization, 'sources'>,
): ReconciledInput[] {
  const rows = new Map(tree.map(r => [r.path, r]));
  const entries = new Map(snapshot.entries.filter(e => e.sourceId === sourceId).map(e => [e.relativePath, e]));
  const boundaries = [...entries.values()].filter(e => e.kind === 'directory-boundary');
  const gitlinks = materialization.sources.find(s => s.sourceId === sourceId)?.gitlinks ?? [];
  const problems: string[] = [];
  const out: ReconciledInput[] = [];
  for (const input of inputs) {
    if (!SAFE(input.path)) { problems.push(`escaping or malformed input path (${input.kind})`); continue; }
    const row = rows.get(input.path);
    const fail = (why: string) => problems.push(`${input.path} (${input.kind}): ${why}`);
    switch (input.kind) {
      case 'content': {
        const entry = entries.get(input.path);
        if (row?.kind !== 'file') { fail('not a captured file'); break; }
        if (row.digest !== input.digest) { fail('bytes differ from the materialization'); break; }
        if (entry?.kind !== 'file' || entry.disposition !== 'included' || entry.content !== `sha256:${input.digest}`) {
          fail('not the captured bytes'); break;
        }
        out.push({ path: input.path, kind: input.kind, outcome: 'content-captured' });
        break;
      }
      case 'directory':
        if (row?.kind !== 'directory') fail('not a listed folder');
        else if (row.digest !== input.digest) fail('listing differs from the materialization');
        else out.push({ path: input.path, kind: input.kind, outcome: 'directory-listed' });
        break;
      case 'metadata':
        if (!row) fail('not in the materialization');
        else if (sha256hex(row.kind) !== input.digest) fail('kind differs from the materialization');
        else out.push({ path: input.path, kind: input.kind, outcome: 'metadata-matched' });
        break;
      case 'missing': {
        if (input.digest !== UNAVAILABLE) { fail('not the parser\'s unavailable encoding'); break; }
        if (row) { fail('recorded missing but present in the materialization'); break; }
        const outcome = explainMissing(input.path, rows, entries, boundaries, gitlinks);
        if (!outcome) fail('absence cannot be verified from the captured inventory');
        else out.push({ path: input.path, kind: input.kind, ...outcome });
        break;
      }
      default:
        problems.push(`${input.path}: unknown input kind`);
    }
  }
  if (problems.length) throw new ParserError('sentinel.parse.integrity', 'parser inputs do not reconcile with the snapshot', problems);
  return out;
}

function explainMissing(
  path: string, rows: Map<string, TreeRow>, entries: Map<string, CaptureEntry>,
  boundaries: readonly CaptureEntry[], gitlinks: readonly { path: string }[],
): Pick<ReconciledInput, 'outcome' | 'explainedBy'> | undefined {
  const link = gitlinks.find(g => path === g.path || path.startsWith(`${g.path}/`));
  if (link) return { outcome: 'missing-in-gitlink', explainedBy: { path: link.path, kind: 'gitlink' } };
  const boundary = boundaries.find(b => path === b.relativePath || path.startsWith(`${b.relativePath}/`));
  if (boundary) {
    return { outcome: 'missing-under-boundary', explainedBy: { path: boundary.relativePath, kind: boundary.kind,
      disposition: boundary.disposition, reasonCode: 'reasonCode' in boundary ? boundary.reasonCode : undefined } };
  }
  // The first component that is absent from the materialized tree: either capture recorded it without bytes, or
  // its parent folder was enumerated in full and it was not there.
  for (const candidate of [...parentsOf(path), path]) {
    if (rows.get(candidate)?.kind === 'directory') continue;
    if (rows.get(candidate)?.kind === 'file') return undefined; // a file used as a folder: present, not absent
    const entry = entries.get(candidate);
    if (entry && !(entry.kind === 'file' && entry.disposition === 'included')) {
      return { outcome: 'missing-recorded-refusal', explainedBy: { path: candidate, kind: entry.kind, disposition: entry.disposition,
        reasonCode: 'reasonCode' in entry ? entry.reasonCode : undefined } };
    }
    if (entry) return undefined; // included but not materialized: the restore would already have failed
    const parent = candidate.includes('/') ? candidate.slice(0, candidate.lastIndexOf('/')) : '.';
    return rows.get(parent)?.kind === 'directory' ? { outcome: 'missing-verified-absent' } : undefined;
  }
  return undefined;
}

// ---- the join ----

const emptyCounts = (): Record<FileClass, number> => ({
  'parsed': 0, 'parse-failed': 0, 'parser-skipped': 0, 'not-selected': 0, 'not-captured': 0, 'unknown-scope': 0,
});

export function joinFileOutcomes(artifact: AnalysisArtifact, sourceId: string, snapshot: Pick<SnapshotEnvelope, 'entries'>):
  { entries: JoinedEntry[]; counts: ParserResult['counts'] } {
  const files = new Map(artifact.analysis.files.map(f => [f.path, f]));
  const diagnostics = new Map<string, number>();
  for (const d of artifact.analysis.diagnostics) if (d.path) diagnostics.set(d.path, (diagnostics.get(d.path) ?? 0) + 1);
  const mine = snapshot.entries.filter(e => e.sourceId === sourceId);
  const included = new Set(mine.filter(e => e.kind === 'file' && e.disposition === 'included').map(e => e.relativePath));
  const problems = [...files.keys()].filter(p => !included.has(p)).map(p => `${p}: the parser reported a file the snapshot did not capture`);
  if (problems.length) throw new ParserError('sentinel.parse.integrity', 'parser file outcomes do not reconcile with the snapshot', problems);
  const counts = emptyCounts();
  let unknown: number | null = 0;
  const entries = mine.map((e): JoinedEntry => {
    const base = { path: e.relativePath, captureKind: e.kind, disposition: e.disposition, diagnostics: diagnostics.get(e.relativePath) ?? 0,
      ...(e.kind === 'file' ? { generated: e.generated } : {}) };
    let cls: FileClass;
    let parser: JoinedEntry['parser'];
    if (e.kind === 'directory-boundary') {
      cls = 'unknown-scope';
      unknown = e.knownDescendants === null || unknown === null ? null : unknown + e.knownDescendants;
    } else if (e.kind !== 'file' || e.disposition !== 'included') {
      cls = 'not-captured';
    } else {
      const f = files.get(e.relativePath);
      parser = f ? { status: f.status, ...(f.reason ? { reason: f.reason } : {}), ...(f.adapter ? { adapter: f.adapter } : {}) } : undefined;
      cls = !f ? 'not-selected' : f.status === 'analyzed' ? 'parsed' : f.reason === 'parse-error' ? 'parse-failed'
        : f.status === 'failed' ? 'parse-failed' : 'parser-skipped';
    }
    counts[cls]++;
    return { ...base, ...(e.kind === 'file' && e.disposition === 'included' ? { content: e.content } : {}), class: cls, ...(parser ? { parser } : {}) };
  });
  return { entries, counts: { ...counts, unknownScopeDescendants: unknown } };
}

// ---- the index ----

/** UTF-8 byte offset of a UTF-16 code-unit offset in `text` (clamped; a split surrogate counts its whole code point). */
function byteOffset(text: string, unit: number): number {
  return Buffer.byteLength(text.slice(0, Math.max(0, Math.min(unit, text.length))), 'utf8');
}

function lineSpan(lineStarts: number[], text: string, line: number, endLine?: number): { startByte: number; endByte: number } | undefined {
  const first = line - 1;
  const last = (endLine ?? line) - 1;
  if (first < 0 || first >= lineStarts.length || last < first) return undefined;
  const start = lineStarts[first]!;
  const end = last + 1 < lineStarts.length ? lineStarts[last + 1]! : text.length;
  return { startByte: byteOffset(text, start), endByte: byteOffset(text, end) };
}

export function buildIndex(artifact: AnalysisArtifact, snapshotId: string, sourceId: string, root: string,
  captured: ReadonlyMap<string, ArtifactId>): ParserIndex {
  const texts = new Map<string, { text: string; starts: number[] } | null>();
  const textOf = (path: string) => {
    if (!texts.has(path)) {
      const id = captured.get(path);
      if (!id) { texts.set(path, null); } else {
        const text = readFileSync(join(root, ...path.split('/'))).toString('utf8');
        const starts = [0];
        for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
        texts.set(path, { text, starts });
      }
    }
    return texts.get(path)!;
  };
  const unplaced = new Set<string>();
  let unplacedCount = 0;
  let omitted = 0;
  const nodes: ParserIndex['nodes'][number][] = [];
  const occurrences: ParserIndex['occurrences'][number][] = [];
  const room = () => nodes.length + occurrences.length < MAX_INDEX_ENTRIES;
  const place = (loc: { repo: string; path: string; line: number; endLine?: number } | undefined): IndexedLocation | undefined => {
    if (!loc || loc.repo !== sourceId) return undefined;
    const content = captured.get(loc.path);
    const t = content ? textOf(loc.path) : null;
    if (!content || !t) {
      unplacedCount++;
      if (unplaced.size < MAX_LISTED) unplaced.add(loc.path);
      return undefined;
    }
    const span = lineSpan(t.starts, t.text, loc.line, loc.endLine);
    return { path: loc.path, content, line: loc.line, ...(loc.endLine ? { endLine: loc.endLine } : {}), ...(span ? { byteSpan: span } : {}) };
  };
  for (const n of [...artifact.graph.nodes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const at = place(n.loc);
    if (!at) continue;
    if (!room()) { omitted++; continue; }
    nodes.push({ nodeId: n.id, kind: n.kind, ...at });
  }
  for (const e of [...artifact.graph.edges].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    for (const o of e.occurrences ?? []) {
      const at = place(o.loc);
      if (!at) continue;
      if (!room()) { omitted++; continue; }
      const t = textOf(at.path)!;
      const byteSpan = o.span ? { startByte: byteOffset(t.text, o.span.start), endByte: byteOffset(t.text, o.span.end) } : at.byteSpan;
      occurrences.push({ occurrenceId: o.id, edgeId: e.id, ...at, ...(byteSpan ? { byteSpan } : {}) });
    }
  }
  return {
    schema: PARSER_INDEX_SCHEMA, snapshotId, sourceId, analysisFingerprint: artifact.analysis.fingerprint,
    nodes, occurrences, omitted, unplaced: { count: unplacedCount, paths: [...unplaced].sort() },
  };
}

// ---- the parse ----

function makeNonExecutable(root: string): void {
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) chmodSync(p, 0o400);
    }
    chmodSync(abs, 0o500);
  };
  walk(root);
}

function unlockTree(root: string): void {
  try { chmodSync(root, 0o700); } catch { return; }
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const st = lstatSync(p);
    if (st.isDirectory()) unlockTree(p); else chmodSync(p, 0o600);
  }
}

/**
 * Parses an admitted snapshot's sources with the public parser over a private, read-only, non-executable
 * materialization restored from the store. Throws `sentinel.parse.integrity` when the tree changes during the parse,
 * a recorded input cannot be reconciled, or the parser reports a file the snapshot did not capture.
 */
export async function parseSnapshot(store: RestoreStore, request: ParseSnapshotRequest): Promise<SnapshotAnalysis> {
  checkRequest(request);
  const base = mkdtempSync(join(request.workDir, 'parse-'));
  const target = join(base, 'tree');
  try {
    const restored = await restoreSnapshot(store, request.snapshotId, target, { readOnly: false });
    const wanted = request.sources ?? restored.snapshot.sources.map(s => s.sourceId);
    const known = new Set(restored.snapshot.sources.map(s => s.sourceId));
    const unknown = wanted.filter(s => !known.has(s));
    if (unknown.length) throw new ParserError('sentinel.parse.invalidRequest', 'a requested source is not in the snapshot', unknown);
    // Loaded on first parse: the TS/JS adapter's native binding and the Java WASM grammar are never loaded at import.
    const [{ createParser }, { tsJsAdapter }, { javaAdapter }] = await Promise.all([
      import('@farsight/code-parser'), import('@farsight/code-parser/adapters/tsjs'), import('@farsight/code-parser/adapters/java'),
    ]);
    const parser = createParser({ adapters: [tsJsAdapter, javaAdapter] });
    const out: SourceAnalysis[] = [];
    for (const src of restored.sources.filter(s => wanted.includes(s.sourceId))) {
      makeNonExecutable(src.root);
      const before = fingerprintTree(src.root);
      assertParserInputSafe(before);
      const { include, exclude, testGlobs, gitignore, testFiles } = request.selection;
      const artifact = await parser.parseRepository({
        root: src.root, sourceId: src.sourceId, gitignore, testFiles,
        ...(include ? { include: [...include] } : {}), ...(exclude ? { exclude: [...exclude] } : {}),
        ...(testGlobs ? { testGlobs: { ...(testGlobs.include ? { include: [...testGlobs.include] } : {}), ...(testGlobs.exclude ? { exclude: [...testGlobs.exclude] } : {}) } } : {}),
        limits: { ...request.limits }, ...(request.signal ? { signal: request.signal } : {}),
      });
      const after = fingerprintTree(src.root);
      if (treeDigest(before) !== treeDigest(after)) {
        const a = new Map(after.map(r => [r.path, canonicalJson(r)]));
        const changed = [...new Set([...before.map(r => r.path), ...after.map(r => r.path)])]
          .filter(p => canonicalJson(before.find(r => r.path === p)) !== (a.get(p) ?? canonicalJson(undefined)));
        throw new ParserError('sentinel.parse.integrity', 'the materialization changed during the parse', changed);
      }
      const inputs = reconcileAnalysisInputs(artifact.analysis.inputs, before, src.sourceId, restored.snapshot, restored.materialization);
      const { entries, counts } = joinFileOutcomes(artifact, src.sourceId, restored.snapshot);
      const captured = new Map(restored.snapshot.entries
        .filter(e => e.sourceId === src.sourceId && e.kind === 'file' && e.disposition === 'included')
        .map(e => [e.relativePath, (e as { content: ArtifactId }).content]));
      const index = buildIndex(artifact, restored.snapshot.id, src.sourceId, src.root, captured);
      const result: ParserResult = {
        schema: PARSER_RESULT_SCHEMA, snapshotId: restored.snapshot.id, sourceId: src.sourceId,
        parser: artifact.analysis.parser, adapters: artifact.analysis.adapters,
        selection: request.selection, limits: { ...request.limits }, analysisFingerprint: artifact.analysis.fingerprint,
        parserComplete: artifact.analysis.complete,
        tree: { before: treeDigest(before), after: treeDigest(after), files: before.filter(r => r.kind === 'file').length,
          directories: before.filter(r => r.kind === 'directory').length },
        inputs, entries, counts, clearsChecks: false,
      };
      out.push({ sourceId: src.sourceId, artifact, result, index });
    }
    return { snapshotId: restored.snapshot.id, sources: out };
  } finally {
    unlockTree(base);
    rmSync(base, { recursive: true, force: true });
  }
}

// ---- retention ----

export interface RetainTarget {
  readonly work: WorkRef;
  readonly attemptId: string;
  readonly stageId: string;
  readonly endedAt: string;
}

export interface RetainedSource {
  readonly sourceId: string;
  readonly artifact: ArtifactId;
  readonly index: ArtifactId;
  readonly result: ArtifactId;
}

/**
 * Stores every source's complete analysis artifact (occurrences included), its index and its result through one
 * staged publication of the given attempt. Outputs are the result records, one per source; each links its artifact
 * and index. Anything over the store's object cap is refused before a byte is written.
 */
export async function retainSnapshotAnalysis(
  store: Pick<SentinelStore, 'objects' | 'ledger'>, target: RetainTarget, analysis: SnapshotAnalysis,
): Promise<{ receipt: PublicationReceipt; sources: readonly RetainedSource[] }> {
  type Item = { value: unknown; schema: string; privacy: ArtifactPrivacy; links: ArtifactId[] };
  const items = new Map<ArtifactId, Item>();
  const add = (value: unknown, schema: string, privacy: ArtifactPrivacy, links: ArtifactId[] = []): ArtifactId => {
    const id = store.objects.identifyCanonicalJson(value);
    if (id.rawSize > MAX_ARTIFACT_BYTES) {
      throw new ParserError('sentinel.parse.artifactTooLarge', `${schema} exceeds the store's object cap`, [`${id.rawSize} bytes`]);
    }
    if (!items.has(id.id)) items.set(id.id, { value, schema, privacy, links });
    return id.id;
  };
  const sources: RetainedSource[] = [];
  const outputs: ArtifactId[] = [];
  for (const s of analysis.sources) {
    // The graph can carry implementation previews, so the artifact is as private as source.
    const artifact = add(s.artifact, 'farsight-analysis', 'source');
    const index = add(s.index, PARSER_INDEX_SCHEMA, 'source-derived');
    const result = add({ ...s.result, artifact, index }, PARSER_RESULT_SCHEMA, 'source-derived', [artifact, index]);
    sources.push({ sourceId: s.sourceId, artifact, index, result });
    if (!outputs.includes(result)) outputs.push(result);
  }
  const staged: StagedArtifact[] = [...items].map(([id, i]) => ({ id, schema: i.schema, privacy: i.privacy, links: i.links }));
  store.ledger.registerStaging(target.stageId, staged, { work: target.work, attemptId: target.attemptId });
  const receipts = [];
  for (const i of items.values()) receipts.push(await store.objects.putCanonicalJson(i.value, { expect: store.objects.identifyCanonicalJson(i.value) }));
  const receipt = store.ledger.publish({ work: target.work, attemptId: target.attemptId, stageId: target.stageId, receipts, outputs, endedAt: target.endedAt });
  return { receipt, sources };
}
