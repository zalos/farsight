// Portable parser evidence for an admitted snapshot (PR 05). The public `@farsight/code-parser` runs its built-in
// TS/JS and Java adapters over a private materialization restored from the store alone, never over the original
// checkout, with explicit selection and limits. The parser has no reader hook, so integrity is checked around it:
// the materialized tree is fingerprinted before and after, and every recorded `analysis.inputs` row is reconciled by
// kind against that tree and the captured inventory. File outcomes are joined to the capture separately; the
// capture is never changed. No application ingestion, configuration enrichment, network or executable input.
import { canonicalJson } from '@farsight/graph';
import { sentinelParserWord } from '@farsight/core/dist/strings-sentinel-parser.js';
import type { AnalysisArtifact, InputFingerprint, ParserLimits } from '@farsight/code-parser';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { ArtifactId, CaptureEntry, SnapshotEnvelope, WorkRef } from '../contracts/index.js';
import type { ArtifactPrivacy, PublicationReceipt, SentinelStore, StagedArtifact } from '../store/index.js';
import { MAX_ARTIFACT_BYTES } from '../store/index.js';
import { openSnapshot, restoreSnapshot, type RestoreStore } from './materialize.js';
import type { Materialization } from './materialization.js';

export const PARSER_RESULT_SCHEMA = 'sentinel-parser-result/draft-1';
export const PARSER_INDEX_SCHEMA = 'sentinel-parser-index/draft-1';
/** The parser stage's identity, for the work unit that publishes this evidence. */
export const PARSER_STAGE_CONTRACT = 'sentinel.stage.parse';

export const PARSER_ERROR_CODES = Object.freeze([
  'sentinel.parse.invalidRequest', 'sentinel.parse.sourceUnsupported', 'sentinel.parse.integrity', 'sentinel.parse.artifactTooLarge',
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
  /** `detail` fills the catalog sentence; `problems` are the first paths and reasons found (never file contents). */
  constructor(code: ParserErrorCode, detail: string, problems: readonly string[] = []) {
    const shown = problems.slice(0, MAX_PROBLEMS);
    const listed = shown.length ? ` (${problems.length} found, ${shown.length} kept; first: ${shown.slice(0, 3).join('; ')})` : '';
    super(sentinelParserWord(code, { detail: `${detail}${listed}` }));
    this.name = 'ParserError';
    this.code = code;
    this.problemCount = problems.length;
    this.problems = Object.freeze(shown);
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
  readonly limits: Required<ParserLimits>;
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

/** The catalog word for each class (strings-sentinel-parser.ts). */
export const FILE_CLASS_KEYS: Readonly<Record<FileClass, string>> = Object.freeze({
  'parsed': 'sentinel.parseClass.parsed', 'parse-failed': 'sentinel.parseClass.parseFailed',
  'parser-skipped': 'sentinel.parseClass.parserSkipped', 'not-selected': 'sentinel.parseClass.notSelected',
  'not-captured': 'sentinel.parseClass.notCaptured', 'unknown-scope': 'sentinel.parseClass.unknownScope',
});

/** The catalog word for each reconciled input outcome (strings-sentinel-parser.ts). */
export const INPUT_OUTCOME_KEYS: Readonly<Record<InputOutcome, string>> = Object.freeze({
  'content-captured': 'sentinel.parseInput.contentCaptured', 'directory-listed': 'sentinel.parseInput.directoryListed',
  'metadata-matched': 'sentinel.parseInput.metadataMatched', 'missing-verified-absent': 'sentinel.parseInput.missingVerifiedAbsent',
  'missing-recorded-refusal': 'sentinel.parseInput.missingRecordedRefusal', 'missing-under-boundary': 'sentinel.parseInput.missingUnderBoundary',
  'missing-in-gitlink': 'sentinel.parseInput.missingInGitlink',
});

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
  /** Zero-based, half-open byte span into the captured bytes, computed from the raw bytes, never estimated. */
  readonly byteSpan?: { readonly startByte: number; readonly endByte: number };
  /** Why no byte span is given, when it is not. */
  readonly spanUnavailable?: SpanUnavailableReason;
}

/**
 * `invalidUtf8`: the file is not valid UTF-8, so the parser's character offsets do not map to its bytes.
 * `invalidLine`: the parser's line range is not inside the file. `invalidSpan`: its offsets are not whole numbers
 * inside the decoded text. `splitSurrogate`: an offset falls between the two halves of one character.
 */
export type SpanUnavailableReason = 'invalidUtf8' | 'invalidLine' | 'invalidSpan' | 'splitSurrogate';

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
  /** Indexed locations given without a byte span, by reason. */
  readonly spanUnavailable: Readonly<Record<SpanUnavailableReason, number>>;
}

export interface ParserResult {
  readonly schema: typeof PARSER_RESULT_SCHEMA;
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly parser: AnalysisArtifact['analysis']['parser'];
  readonly adapters: AnalysisArtifact['analysis']['adapters'];
  readonly selection: ParserSelection;
  readonly limits: Required<ParserLimits>;
  readonly analysisFingerprint: string;
  /** The parser's own flag: its selection completed. Never security coverage. */
  readonly parserComplete: boolean;
  /** Fingerprints of the materialized tree (paths, kinds, bytes or listings, modes) around the parse. */
  readonly tree: { readonly before: string; readonly after: string; readonly files: number; readonly directories: number };
  readonly inputs: readonly ReconciledInput[];
  readonly entries: readonly JoinedEntry[];
  /**
   * Tallies of this source's captured entries by class: each entry counted once, summing to the entries joined.
   * They count parser outcomes over the snapshot's inventory, never coverage or checks; a surface that prints them
   * wires them as Counted values with this scope. `unknownScopeDescendants` is null whenever any listed boundary has
   * an unknown number of descendants.
   */
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

// The public parser's own types, re-exported unchanged: the retained artifact is its portable `farsight-analysis`
// document, with no Sentinel restatement. The packed tarball carries these declarations (graph and code-parser are
// publishable libraries), so a typed consumer sees the full graph, resolution and occurrence fields.
export type { AnalysisArtifact, InputFingerprint, ParserLimits };

const sha256hex = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const UNAVAILABLE = sha256hex('unavailable');

// ---- request checks ----

const SELECTION_KEYS = new Set(['gitignore', 'testFiles', 'include', 'exclude', 'testGlobs']);
/** The accepted ceilings (PR 01's resource defaults and the capture bounds): a request may only lower them. */
export const PARSER_LIMIT_CEILINGS: Readonly<Required<ParserLimits>> = Object.freeze({
  maxFiles: 200_000, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024, maxEntries: 200_000, maxDurationMs: 120_000,
});
const LIMIT_KEYS = Object.keys(PARSER_LIMIT_CEILINGS) as (keyof ParserLimits)[];
const MAX_GLOBS = 256;
const MAX_GLOB_LENGTH = 1024;
const MAX_SOURCES = 64;

function checkRequest(req: ParseSnapshotRequest): void {
  const bad = (m: string) => new ParserError('sentinel.parse.invalidRequest', m);
  const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const globs = (v: unknown, what: string) => {
    if (v === undefined) return;
    if (!Array.isArray(v) || v.length > MAX_GLOBS) throw bad(`${what} must be a list of at most ${MAX_GLOBS} patterns`);
    for (const g of v) {
      if (typeof g !== 'string' || g.length < 1 || g.length > MAX_GLOB_LENGTH || g.includes('\u0000')) {
        throw bad(`${what} holds a pattern that is empty, too long or contains NUL`);
      }
    }
  };
  if (!plain(req)) throw bad('the request must be an object');
  if (typeof req.snapshotId !== 'string' || !req.snapshotId) throw bad('a snapshot id is required');
  if (typeof req.workDir !== 'string' || !isAbsolute(req.workDir)) throw bad('workDir must be absolute');
  let real: string;
  try { real = realpathSync.native(req.workDir); } catch { throw bad('workDir must exist'); }
  if (real !== req.workDir || !lstatSync(real).isDirectory()) throw bad('workDir must be a canonical folder');
  const s = req.selection;
  if (!plain(s)) throw bad('selection is required');
  for (const k of Object.keys(s)) if (!SELECTION_KEYS.has(k)) throw bad(`selection.${k} is not a syntax selection option`);
  if (typeof s.gitignore !== 'boolean') throw bad('selection.gitignore must be stated');
  if (s.testFiles !== 'include' && s.testFiles !== 'exclude') throw bad('selection.testFiles must be stated');
  globs(s.include, 'selection.include');
  globs(s.exclude, 'selection.exclude');
  if (s.testGlobs !== undefined) {
    if (!plain(s.testGlobs)) throw bad('selection.testGlobs must be an object');
    for (const k of Object.keys(s.testGlobs)) if (k !== 'include' && k !== 'exclude') throw bad(`selection.testGlobs.${k} is unknown`);
    globs(s.testGlobs.include, 'selection.testGlobs.include');
    globs(s.testGlobs.exclude, 'selection.testGlobs.exclude');
  }
  const l = req.limits;
  if (!plain(l)) throw bad('limits are required');
  for (const k of Object.keys(l)) if (!(LIMIT_KEYS as string[]).includes(k)) throw bad(`limits.${k} is unknown`);
  for (const k of LIMIT_KEYS) {
    const v = (l as Record<string, unknown>)[k];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > PARSER_LIMIT_CEILINGS[k]) {
      throw bad(`limits.${k} must be an integer from 1 to ${PARSER_LIMIT_CEILINGS[k]}`);
    }
  }
  if (req.sources !== undefined) {
    if (!Array.isArray(req.sources) || req.sources.length < 1 || req.sources.length > MAX_SOURCES) {
      throw bad(`sources must list 1 to ${MAX_SOURCES} source ids`);
    }
    if (req.sources.some(id => typeof id !== 'string' || !id) || new Set(req.sources).size !== req.sources.length) {
      throw bad('sources must be distinct source ids');
    }
  }
  if (req.signal !== undefined && !(req.signal instanceof AbortSignal)) throw bad('signal must be an AbortSignal');
}

/** The public parser names nodes `<sourceId>::<path>`, so it refuses a source id it cannot keep unambiguous. */
export const parserAcceptsSourceId = (id: string): boolean => id.length > 0 && !id.includes('::') && !/[\r\n/\\]/.test(id);

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

type Loc = { readonly repo: string; readonly path: string; readonly line: number; readonly endLine?: number };
type Candidate =
  | { readonly order: string; readonly type: 'node'; readonly nodeId: string; readonly kind: string; readonly loc: Loc }
  | { readonly order: string; readonly type: 'occurrence'; readonly occurrenceId: string; readonly edgeId: string; readonly loc: Loc;
      readonly span?: { readonly start: number; readonly end: number } };

/** One captured file's raw bytes, prepared once: line starts from 0x0A bytes, and the decoded text only if UTF-8 round-trips. */
class FileBytes {
  readonly raw: Buffer;
  readonly lineStarts: number[] = [0];
  private decoded: { readonly text: string } | null | undefined;
  constructor(raw: Buffer) {
    this.raw = raw;
    for (let i = 0; i < raw.length; i++) if (raw[i] === 0x0a) this.lineStarts.push(i + 1);
  }
  /** The line range's bytes. A 0x0A byte is never part of a multi-byte UTF-8 sequence, so this holds for any bytes. */
  lineSpan(line: number, endLine = line): { startByte: number; endByte: number } | undefined {
    const n = this.lineStarts.length;
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(endLine) || line < 1 || endLine < line || endLine > n) return undefined;
    return { startByte: this.lineStarts[line - 1]!, endByte: endLine < n ? this.lineStarts[endLine]! : this.raw.length };
  }
  /** The text the parser saw, when it is an exact image of the bytes; otherwise null. */
  text(): string | null {
    if (this.decoded === undefined) {
      const text = this.raw.toString('utf8');
      this.decoded = Buffer.byteLength(text, 'utf8') === this.raw.length && Buffer.from(text, 'utf8').equals(this.raw) ? { text } : null;
    }
    return this.decoded?.text ?? null;
  }
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Byte offsets of sorted UTF-16 offsets into `text`, in one pass. Offsets must already be validated. */
function byteOffsets(text: string, units: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  let unit = 0;
  let byte = 0;
  for (const target of units) {
    while (unit < target) {
      const c = text.charCodeAt(unit);
      if (isHigh(c) && unit + 1 < text.length && isLow(text.charCodeAt(unit + 1))) { byte += 4; unit += 2; }
      else { byte += c < 0x80 ? 1 : c < 0x800 ? 2 : 3; unit += 1; }
    }
    out.set(target, byte);
  }
  return out;
}

function spanProblem(text: string, span: { start: number; end: number }): SpanUnavailableReason | undefined {
  const { start, end } = span;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > text.length) return 'invalidSpan';
  const splits = (at: number) => at > 0 && at < text.length && isLow(text.charCodeAt(at)) && isHigh(text.charCodeAt(at - 1));
  return splits(start) || splits(end) ? 'splitSurrogate' : undefined;
}

/**
 * Indexes the artifact's node and call-site locations against the captured bytes. Files are processed one at a
 * time and released; byte offsets come from the raw bytes, and a span that cannot be computed exactly is given
 * without a byte span and with its reason, never estimated or clamped.
 */
export function buildIndex(artifact: AnalysisArtifact, snapshotId: string, sourceId: string, root: string,
  captured: ReadonlyMap<string, ArtifactId>): ParserIndex {
  const candidates: Candidate[] = [];
  for (const n of artifact.graph.nodes) {
    if (n.loc?.repo === sourceId) candidates.push({ order: `n\u0000${n.id}`, type: 'node', nodeId: n.id, kind: n.kind, loc: n.loc });
  }
  for (const e of artifact.graph.edges) {
    for (const o of e.occurrences ?? []) {
      if (o.loc.repo !== sourceId) continue;
      candidates.push({ order: `o\u0000${e.id}\u0000${o.id}`, type: 'occurrence', occurrenceId: o.id, edgeId: e.id, loc: o.loc,
        ...(o.span ? { span: o.span } : {}) });
    }
  }
  candidates.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  const unplaced = new Set<string>();
  let unplacedCount = 0;
  const placeable = candidates.filter(c => {
    if (captured.has(c.loc.path)) return true;
    unplacedCount++;
    if (unplaced.size < MAX_LISTED) unplaced.add(c.loc.path);
    return false;
  });
  const kept = placeable.slice(0, MAX_INDEX_ENTRIES);
  const omitted = placeable.length - kept.length;
  const byPath = new Map<string, Candidate[]>();
  for (const c of kept) { const list = byPath.get(c.loc.path); if (list) list.push(c); else byPath.set(c.loc.path, [c]); }
  const reasons: Record<SpanUnavailableReason, number> = { invalidUtf8: 0, invalidLine: 0, invalidSpan: 0, splitSurrogate: 0 };
  const located = new Map<Candidate, IndexedLocation>();
  for (const [path, list] of [...byPath].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const content = captured.get(path)!;
    const file = new FileBytes(readFileSync(join(root, ...path.split('/'))));
    const pending: { c: Candidate; span: { start: number; end: number } }[] = [];
    for (const c of list) {
      const base = { path, content, line: c.loc.line, ...(c.loc.endLine !== undefined ? { endLine: c.loc.endLine } : {}) };
      if (c.type === 'occurrence' && c.span) {
        const text = file.text();
        const problem = text === null ? 'invalidUtf8' : spanProblem(text, c.span);
        if (problem) { reasons[problem]++; located.set(c, { ...base, spanUnavailable: problem }); }
        else pending.push({ c, span: c.span });
        continue;
      }
      const span = file.lineSpan(c.loc.line, c.loc.endLine);
      if (span) located.set(c, { ...base, byteSpan: span });
      else { reasons.invalidLine++; located.set(c, { ...base, spanUnavailable: 'invalidLine' }); }
    }
    if (pending.length) {
      const text = file.text()!;
      const units = [...new Set(pending.flatMap(p => [p.span.start, p.span.end]))].sort((a, b) => a - b);
      const bytes = byteOffsets(text, units);
      for (const { c, span } of pending) {
        located.set(c, { path, content, line: c.loc.line, ...(c.loc.endLine !== undefined ? { endLine: c.loc.endLine } : {}),
          byteSpan: { startByte: bytes.get(span.start)!, endByte: bytes.get(span.end)! } });
      }
    }
  }
  const nodes: ParserIndex['nodes'][number][] = [];
  const occurrences: ParserIndex['occurrences'][number][] = [];
  for (const c of kept) {
    const at = located.get(c)!;
    if (c.type === 'node') nodes.push({ nodeId: c.nodeId, kind: c.kind, ...at });
    else occurrences.push({ occurrenceId: c.occurrenceId, edgeId: c.edgeId, ...at });
  }
  return {
    schema: PARSER_INDEX_SCHEMA, snapshotId, sourceId, analysisFingerprint: artifact.analysis.fingerprint,
    nodes, occurrences, omitted, unplaced: { count: unplacedCount, paths: [...unplaced].sort() }, spanUnavailable: reasons,
  };
}

// ---- the parse ----

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
  // Sources are checked against the snapshot before anything is materialized.
  const opened = await openSnapshot(store, request.snapshotId);
  const wanted = request.sources ?? opened.snapshot.sources.map(s => s.sourceId);
  const known = new Set(opened.snapshot.sources.map(s => s.sourceId));
  const unknown = wanted.filter(s => !known.has(s));
  if (unknown.length) throw new ParserError('sentinel.parse.invalidRequest', 'a requested source is not in the snapshot', unknown);
  const unsupported = wanted.filter(s => !parserAcceptsSourceId(s));
  if (unsupported.length) {
    throw new ParserError('sentinel.parse.sourceUnsupported', 'name only sources whose ids the parser accepts', unsupported);
  }
  const base = mkdtempSync(join(request.workDir, 'parse-'));
  const target = join(base, 'tree');
  try {
    // A restore is read-only and never executable (files 0400, folders 0500); the sidecar keeps the original modes.
    const restored = await restoreSnapshot(store, request.snapshotId, target);
    if (restored.snapshot.id !== opened.snapshot.id) throw new ParserError('sentinel.parse.integrity', 'the snapshot changed between checks');
    // Loaded on first parse: the TS/JS adapter's native binding and the Java WASM grammar are never loaded at import.
    const [{ createParser }, { tsJsAdapter }, { javaAdapter }] = await Promise.all([
      import('@farsight/code-parser'), import('@farsight/code-parser/adapters/tsjs'), import('@farsight/code-parser/adapters/java'),
    ]);
    const parser = createParser({ adapters: [tsJsAdapter, javaAdapter] });
    const out: SourceAnalysis[] = [];
    for (const src of restored.sources.filter(s => wanted.includes(s.sourceId))) {
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
        const b = new Map(before.map(r => [r.path, canonicalJson(r)]));
        const a = new Map(after.map(r => [r.path, canonicalJson(r)]));
        const changed = [...new Set([...b.keys(), ...a.keys()])].filter(p => b.get(p) !== a.get(p)).sort();
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
  store: Pick<SentinelStore, 'objects' | 'ledger' | 'assertHeld'>, target: RetainTarget, analysis: SnapshotAnalysis,
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
  try {
    const receipts = [];
    for (const i of items.values()) receipts.push(await store.objects.putCanonicalJson(i.value, { expect: store.objects.identifyCanonicalJson(i.value) }));
    const receipt = store.ledger.publish({ work: target.work, attemptId: target.attemptId, stageId: target.stageId, receipts, outputs, endedAt: target.endedAt });
    return { receipt, sources };
  } catch (error) {
    // Release this call's own stage when the store is still held, so a retry can register it again. If the owner is
    // gone (or the abort is refused) the stage stays pinned for recovery. The original failure is what is reported.
    try { store.assertHeld(); store.ledger.abortStaging(target.stageId); } catch { /* keep the original error */ }
    throw error;
  }
}
