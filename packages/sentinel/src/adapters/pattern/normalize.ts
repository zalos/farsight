// Reading one pattern attempt's verified outputs. The worker is transport; this is where results become findings and
// coverage, under the coordinator's own rules:
// - the run record must name the job this coordinator supplied, and the engine output it lists;
// - only rule ids of the job count, only on targets of the job, only in a language the rule declares;
// - every span is byte offsets checked against the captured bytes, line and column included;
// - a structural match is a locator; a taint-mode match is local-taint evidence at its sink, and names a source only
//   when the engine reports a trace inside the same file (Semgrep 1.181.0 OSS reported none in conformance);
//   anything that would claim a cross-file flow is refused, never credited;
// - finding identity is Sentinel's own digest of rule, revision, target and span; engine fingerprints are ignored;
// - no source text is kept: a finding carries its span and a digest of the quoted bytes;
// - coverage is per file: every applicable target is complete, partial, skipped, omitted (requested but neither
//   scanned nor skipped, even on exit zero) or in error; a file no rule language applies to is not applicable.
import { createHash } from 'node:crypto';
import type { ArtifactId } from '../../contracts/common.js';
import type { WorkerOutcome } from '../../execution/supervisor.js';
import { PATTERN_ENGINE } from './adapter.js';
import { patternFail } from './errors.js';
import { languageOf, type PatternEvidenceKind, type PatternJob, type PatternLanguage, type PatternRule } from './job.js';

export const PATTERN_COVERAGE_REASONS = [
  'sentinel.pattern.coverage.complete', 'sentinel.pattern.coverage.partialParse', 'sentinel.pattern.coverage.ruleTimeout',
  'sentinel.pattern.coverage.tooLarge', 'sentinel.pattern.coverage.engineSkipped', 'sentinel.pattern.coverage.omitted',
  'sentinel.pattern.coverage.noRuleLanguage', 'sentinel.pattern.coverage.ignoreFileExcluded',
  'sentinel.pattern.coverage.attemptFailed', 'sentinel.pattern.coverage.attemptTimedOut', 'sentinel.pattern.coverage.attemptCanceled',
  'sentinel.pattern.coverage.engineTimedOut', 'sentinel.pattern.coverage.outputTruncated', 'sentinel.pattern.coverage.engineFailed',
] as const;
export type PatternCoverageReason = typeof PATTERN_COVERAGE_REASONS[number];

export const PATTERN_REFUSAL_REASONS = [
  'sentinel.pattern.refused.unknownRule', 'sentinel.pattern.refused.unknownTarget', 'sentinel.pattern.refused.ruleLanguage',
  'sentinel.pattern.refused.spanInvalid', 'sentinel.pattern.refused.crossFile', 'sentinel.pattern.refused.malformed',
] as const;
export type PatternRefusalReason = typeof PATTERN_REFUSAL_REASONS[number];

export type CoverageStatus = 'complete' | 'partial' | 'skipped' | 'omitted' | 'error' | 'not-applicable' | 'excluded';

export interface PatternCoverage {
  readonly relativePath: string;
  readonly artifact: ArtifactId;
  readonly language: PatternLanguage | null;
  readonly status: CoverageStatus;
  readonly reasonCode: PatternCoverageReason;
  /** The rules this per-file status stands for (every rule whose language applies). */
  readonly rules: readonly string[];
}

export interface ByteSpanRef { readonly startByte: number; readonly endByte: number; readonly quoteDigest: string }

export type PatternEvidence =
  | { readonly kind: 'structural-locator' }
  | { readonly kind: 'local-taint'; readonly sink: ByteSpanRef; readonly source: ByteSpanRef | null; readonly trace: 'same-file' | 'not-reported' };

export interface PatternFinding {
  /** Sentinel's identity: digest of adapter, rule, revision, target and span. Never the engine's fingerprint. */
  readonly id: string;
  readonly familyId: string;
  readonly revision: number;
  readonly relativePath: string;
  readonly artifact: ArtifactId;
  readonly span: ByteSpanRef;
  readonly evidence: PatternEvidence;
}

export interface PatternRefusal { readonly reasonCode: PatternRefusalReason; readonly familyId: string | null; readonly relativePath: string | null }

export interface PatternRunResult {
  readonly adapter: string;
  readonly engine: string;
  readonly granularity: 'per-file';
  readonly attempt: WorkerOutcome['state'];
  readonly engineExit: number | null;
  readonly findings: readonly PatternFinding[];
  readonly coverage: readonly PatternCoverage[];
  readonly refused: readonly PatternRefusal[];
}

export interface NormalizeInput {
  job: PatternJob;
  jobDigest: ArtifactId;
  rules: readonly PatternRule[];
  outcome: WorkerOutcome;
  /** The verified outputs' bytes by artifact id (the supervisor re-hashed them). */
  outputBytes: (id: ArtifactId) => Uint8Array;
  /** The captured bytes of a job target. */
  targetBytes: (relativePath: string) => Uint8Array;
}

const TREE = '/tmp/sentinel-pattern/tree/';
const MAX_ENGINE_JSON = 3_145_728;
const MAX_RUN_RECORD = 65_536;
const sha256 = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); }
  return v;
}

function parseJson(bytes: Uint8Array, limit: number, what: string): any {
  if (bytes.byteLength > limit) patternFail('sentinel.pattern.outputInvalid', `${what} exceeds ${limit} bytes`);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return patternFail('sentinel.pattern.outputInvalid', `${what} is not UTF-8 JSON`); }
}

/** The span [start, end) of the bytes, if the engine's line/column/offset positions agree with them. */
function spanOf(bytes: Uint8Array, start: any, end: any): ByteSpanRef | null {
  if (!start || !end || !int(start.offset) || !int(end.offset) || !int(start.line) || !int(start.col) || !int(end.line) || !int(end.col)) return null;
  if (start.offset >= end.offset || end.offset > bytes.byteLength) return null;
  const position = (offset: number) => {
    let line = 1, lineStart = 0;
    for (let i = 0; i < offset; i++) if (bytes[i] === 0x0a) { line++; lineStart = i + 1; }
    return { line, col: offset - lineStart + 1 };
  };
  const s = position(start.offset), e = position(end.offset);
  if (s.line !== start.line || s.col !== start.col || e.line !== end.line || e.col !== end.col) return null;
  return { startByte: start.offset, endByte: end.offset, quoteDigest: sha256(bytes.subarray(start.offset, end.offset)) };
}

/** A trace's location inside the same file as the result, as Semgrep writes it (`["CliLoc", [{path,start,end}, text]]`). */
function traceLoc(node: unknown): { path: string; start: unknown; end: unknown } | null {
  if (!Array.isArray(node) || node[0] !== 'CliLoc' || !Array.isArray(node[1])) return null;
  const loc = node[1][0];
  return loc && typeof loc.path === 'string' ? loc : null;
}

export function normalizePatternRun(input: NormalizeInput): PatternRunResult {
  const { job, outcome } = input;
  const rules = new Map(input.rules.map(r => [r.familyId, r]));
  if (job.ruleIds.some(id => !rules.has(id)) || rules.size !== job.ruleIds.length) patternFail('sentinel.pattern.ruleInvalid', 'the rules given are not the job’s rules');
  const targets = new Map(job.targets.map(t => [t.path, t]));
  const applicable = (path: string) => {
    const language = languageOf(path) ?? null;
    return { language, rules: language ? job.ruleIds.filter(id => rules.get(id)!.languages.includes(language)) : [] };
  };
  const everyTarget = (status: CoverageStatus, reasonCode: PatternCoverageReason): PatternCoverage[] => job.targets.map(t => {
    const a = applicable(t.path);
    return a.rules.length
      ? { relativePath: t.path, artifact: t.artifact, language: a.language, status, reasonCode, rules: a.rules }
      : { relativePath: t.path, artifact: t.artifact, language: a.language, status: 'not-applicable', reasonCode: 'sentinel.pattern.coverage.noRuleLanguage', rules: [] };
  });
  const base = { adapter: outcome.adapter.id, engine: `${PATTERN_ENGINE.name} ${PATTERN_ENGINE.version}`, granularity: 'per-file' as const, attempt: outcome.state };

  if (outcome.state !== 'succeeded') {
    const reason: PatternCoverageReason = outcome.state === 'timed-out' ? 'sentinel.pattern.coverage.attemptTimedOut'
      : outcome.state === 'canceled' ? 'sentinel.pattern.coverage.attemptCanceled' : 'sentinel.pattern.coverage.attemptFailed';
    return deepFreeze({ ...base, engineExit: null, findings: [], coverage: everyTarget('error', reason), refused: [] });
  }

  const recordOut = outcome.outputs.find(o => o.mediaType === 'application/vnd.sentinel.pattern-run+json');
  if (!recordOut) return patternFail('sentinel.pattern.outputInvalid', 'no run record');
  const record = parseJson(input.outputBytes(recordOut.id), MAX_RUN_RECORD, 'the run record');
  if (record?.schema !== 'sentinel-pattern-run/draft-1' || record.job !== input.jobDigest) patternFail('sentinel.pattern.outputInvalid', 'the run record names another job');
  const engineOut = outcome.outputs.find(o => o.mediaType === 'application/vnd.semgrep.result+json');
  if (!engineOut || engineOut.id !== record.engineOutput) return patternFail('sentinel.pattern.outputInvalid', 'the engine output is not the one the run record names');
  const exit = int(record.exitCode) ? record.exitCode : null;
  const excluded = new Set<string>(Array.isArray(record.excluded) ? record.excluded.filter((p: unknown) => typeof p === 'string') : []);
  if (record.timedOut === true) return deepFreeze({ ...base, engineExit: exit, findings: [], coverage: everyTarget('error', 'sentinel.pattern.coverage.engineTimedOut'), refused: [] });
  if (record.stdoutTruncated === true) return deepFreeze({ ...base, engineExit: exit, findings: [], coverage: everyTarget('error', 'sentinel.pattern.coverage.outputTruncated'), refused: [] });

  const engine = parseJson(input.outputBytes(engineOut.id), MAX_ENGINE_JSON, 'the engine output');
  if (engine?.version !== PATTERN_ENGINE.version) patternFail('sentinel.pattern.outputInvalid', 'the engine output is from another engine version');
  if (engine.engine_requested !== undefined && engine.engine_requested !== 'OSS') patternFail('sentinel.pattern.outputInvalid', 'the engine ran other than its open-source engine');
  if (!Array.isArray(engine.results) || !Array.isArray(engine.errors) || !engine.paths || !Array.isArray(engine.paths.scanned)) {
    patternFail('sentinel.pattern.outputInvalid', 'the engine output lacks results, errors or scanned paths');
  }
  const rel = (p: unknown): string | null => (typeof p === 'string' && p.startsWith(TREE) && targets.has(p.slice(TREE.length)) ? p.slice(TREE.length) : null);

  // Coverage, per file.
  const scanned = new Set<string>(engine.paths.scanned.map(rel).filter(Boolean));
  const skipped = new Map<string, string>();
  for (const s of Array.isArray(engine.paths.skipped) ? engine.paths.skipped : []) { const r = rel(s?.path); if (r && typeof s.reason === 'string') skipped.set(r, s.reason); }
  const partial = new Map<string, PatternCoverageReason>();
  for (const e of engine.errors) {
    const kind = Array.isArray(e?.type) ? e.type[0] : e?.type;
    const r = rel(e?.path);
    if (!r) continue;
    if (kind === 'Timeout') partial.set(r, 'sentinel.pattern.coverage.ruleTimeout');
    else if (!partial.has(r)) partial.set(r, 'sentinel.pattern.coverage.partialParse');
  }
  const failed = exit !== 0;
  const coverage: PatternCoverage[] = job.targets.map(t => {
    const a = applicable(t.path);
    const row = (status: CoverageStatus, reasonCode: PatternCoverageReason): PatternCoverage =>
      ({ relativePath: t.path, artifact: t.artifact, language: a.language, status, reasonCode, rules: a.rules });
    if (excluded.has(t.path)) return row('excluded', 'sentinel.pattern.coverage.ignoreFileExcluded');
    if (!a.rules.length) return { ...row('not-applicable', 'sentinel.pattern.coverage.noRuleLanguage'), rules: [] };
    if (failed) return row('error', 'sentinel.pattern.coverage.engineFailed');
    const skip = skipped.get(t.path);
    if (skip === 'exceeded_size_limit') return row('skipped', 'sentinel.pattern.coverage.tooLarge');
    if (scanned.has(t.path)) {
      if (partial.has(t.path)) return row('partial', partial.get(t.path)!);
      if (skip) return row('partial', 'sentinel.pattern.coverage.partialParse');
      return row('complete', 'sentinel.pattern.coverage.complete');
    }
    if (skip) return row('skipped', 'sentinel.pattern.coverage.engineSkipped');
    return row('omitted', 'sentinel.pattern.coverage.omitted');
  });

  // Findings.
  const findings = new Map<string, PatternFinding>();
  const refused: PatternRefusal[] = [];
  const refuse = (reasonCode: PatternRefusalReason, familyId: string | null, relativePath: string | null) => { refused.push({ reasonCode, familyId, relativePath }); };
  for (const r of engine.results) {
    const familyId = typeof r?.check_id === 'string' ? r.check_id : null;
    const rule = familyId ? rules.get(familyId) : undefined;
    if (!rule) { refuse('sentinel.pattern.refused.unknownRule', null, null); continue; }
    const path = rel(r.path);
    if (!path) { refuse('sentinel.pattern.refused.unknownTarget', familyId, null); continue; }
    const language = languageOf(path);
    if (!language || !rule.languages.includes(language)) { refuse('sentinel.pattern.refused.ruleLanguage', familyId, path); continue; }
    const bytes = input.targetBytes(path);
    const span = spanOf(bytes, r.start, r.end);
    if (!span) { refuse('sentinel.pattern.refused.spanInvalid', familyId, path); continue; }
    let evidence: PatternEvidence;
    if (rule.kind === 'structural-locator') {
      evidence = { kind: 'structural-locator' };
    } else {
      const trace = r.extra?.dataflow_trace;
      if (trace === undefined || trace === null) {
        evidence = { kind: 'local-taint', sink: span, source: null, trace: 'not-reported' };
      } else {
        const loc = traceLoc(trace.taint_source);
        if (!loc) { refuse('sentinel.pattern.refused.malformed', familyId, path); continue; }
        if (rel(loc.path) !== path) { refuse('sentinel.pattern.refused.crossFile', familyId, path); continue; }
        const source = spanOf(bytes, loc.start, loc.end);
        if (!source) { refuse('sentinel.pattern.refused.spanInvalid', familyId, path); continue; }
        evidence = { kind: 'local-taint', sink: span, source, trace: 'same-file' };
      }
    }
    const target = targets.get(path)!;
    const id = sha256(Buffer.from(canonical({ kind: 'sentinel-pattern-finding/1', adapter: outcome.adapter.id, familyId, revision: rule.revision, path, artifact: target.artifact, startByte: span.startByte, endByte: span.endByte })));
    if (!findings.has(id)) findings.set(id, { id, familyId: familyId!, revision: rule.revision, relativePath: path, artifact: target.artifact, span, evidence });
  }
  const sorted = [...findings.values()].sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : a.span.startByte - b.span.startByte || (a.familyId < b.familyId ? -1 : 1)));
  return deepFreeze({ ...base, engineExit: exit, findings: sorted, coverage, refused });
}

export type { PatternEvidenceKind };
