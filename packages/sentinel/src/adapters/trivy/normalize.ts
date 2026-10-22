// Reading one Trivy attempt's verified outputs, coordinator-side. The engine reports misconfigurations; this decides
// what they establish:
// - the run record must name the supplied job, the pinned bundle and the engine output it lists; a failed engine, a
//   truncated report, or a run without the engine's own evidence that it loaded the pinned bundle from disk (it falls
//   back silently to the checks compiled into the binary) counts nothing;
// - every target is re-hashed against the job from the attempt's sealed copy;
// - a finding is one check failing in one captured file (or Terraform module folder) at the lines the engine names,
//   checked against the captured bytes; only the check id, the bundle's severity and the configuration type are kept,
//   never the engine's message, which quotes the file; no graph node is created;
// - coverage is per file and needs positive evidence: the engine logged the file (or its module folder) as scanned.
//   A Dockerfile or Terraform file it did not log, at exit 0, is an omission gap, not a pass; YAML it did not log is
//   not a Kubernetes manifest. Inline ignore comments (which the engine honours), a remote module it could not load
//   and variable files it did not read leave a file partial.
import { createHash } from 'node:crypto';
import type { ArtifactId } from '../../contracts/common.js';
import type { WorkerOutcome } from '../../execution/supervisor.js';
import { canonicalDigest } from '../../policy/digest.js';
import { deepFreeze } from '../../policy/immutable.js';
import { TRIVY_CHECKS_BUNDLE, TRIVY_ENGINE, TRIVY_IMAGE_PLATFORMS, TRIVY_MAX_OUTPUT_BYTES, TRIVY_MEASURED_ARCHITECTURES, type TrivyConfigType } from './adapter.js';
import { trivyFail } from './errors.js';
import type { TrivyFileKind, TrivyJob, TrivyJobTarget } from './job.js';

export const TRIVY_COVERAGE_REASONS = [
  'sentinel.trivy.coverage.complete', 'sentinel.trivy.coverage.inlineIgnore', 'sentinel.trivy.coverage.remoteModuleUnresolved',
  'sentinel.trivy.coverage.variablesNotRead', 'sentinel.trivy.coverage.notReported', 'sentinel.trivy.coverage.parseFailed',
  'sentinel.trivy.coverage.notRecognized', 'sentinel.trivy.coverage.notConfiguration', 'sentinel.trivy.coverage.dependencyCache',
  'sentinel.trivy.coverage.variablesFile', 'sentinel.trivy.coverage.pathUnsupported', 'sentinel.trivy.coverage.tooLarge',
  'sentinel.trivy.coverage.tooMany', 'sentinel.trivy.coverage.bundleMissing', 'sentinel.trivy.coverage.bundleNotLoaded',
  'sentinel.trivy.coverage.inputMismatch', 'sentinel.trivy.coverage.attemptFailed', 'sentinel.trivy.coverage.attemptTimedOut',
  'sentinel.trivy.coverage.attemptCanceled', 'sentinel.trivy.coverage.engineFailed', 'sentinel.trivy.coverage.engineTimedOut',
  'sentinel.trivy.coverage.outputTruncated', 'sentinel.trivy.coverage.platformUnmeasured',
] as const;
export type TrivyCoverageReason = typeof TRIVY_COVERAGE_REASONS[number];
export const TRIVY_REFUSAL_REASONS = [
  'sentinel.trivy.refused.unknownTarget', 'sentinel.trivy.refused.notScanned', 'sentinel.trivy.refused.notFromBundle',
  'sentinel.trivy.refused.malformed', 'sentinel.trivy.refused.locationInvalid', 'sentinel.trivy.refused.inputMismatch',
] as const;
export type TrivyRefusalReason = typeof TRIVY_REFUSAL_REASONS[number];
export const TRIVY_ENGINE_FAILURES = ['sentinel.trivy.engine.engineError', 'sentinel.trivy.engine.killed', 'sentinel.trivy.engine.unknown'] as const;
export type TrivyEngineFailure = typeof TRIVY_ENGINE_FAILURES[number];
export const TRIVY_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const;
export type TrivySeverity = typeof TRIVY_SEVERITIES[number];

export type TrivyCoverageStatus = 'complete' | 'partial' | 'error' | 'not-applicable' | 'bundle-missing' | 'unsupported';

export interface TrivyCoverage {
  readonly relativePath: string;
  readonly artifact: ArtifactId;
  readonly kind: TrivyFileKind | null;
  readonly status: TrivyCoverageStatus;
  readonly reasonCode: TrivyCoverageReason;
  /** Every limitation that applies, the status's reason first. */
  readonly limitations: readonly TrivyCoverageReason[];
}

/** One failing check at a captured location. A configuration fact: a path, never a graph node. */
export interface TrivyFinding {
  /** The assessment: check, location and the bundle that judged it. */
  readonly id: string;
  /** Check and location alone. */
  readonly key: string;
  readonly checkId: string;
  readonly severity: TrivySeverity;
  readonly configType: TrivyConfigType;
  readonly relativePath: string;
  /** Null for a finding the engine reports against a Terraform module folder rather than one file. */
  readonly artifact: ArtifactId | null;
  /** 1-based, inclusive; null when the engine names no lines (a whole-file or whole-module finding). */
  readonly lines: { readonly start: number; readonly end: number } | null;
  readonly bundle: string;
}

export interface TrivyRunResult {
  readonly adapter: string;
  readonly engine: string;
  readonly checks: string;
  readonly mode: 'misconfiguration-only';
  readonly attempt: WorkerOutcome['state'] | 'not-run';
  readonly platform: { readonly architecture: string | null; readonly state: 'measured' | 'candidate' | 'refused' | 'not-run' };
  readonly engineExit: number | null;
  readonly engineFailure: TrivyEngineFailure | null;
  readonly bundle: { readonly layer: string; readonly checksLoaded: number | null } | null;
  readonly findings: readonly TrivyFinding[];
  readonly coverage: readonly TrivyCoverage[];
  readonly refused: readonly { readonly reasonCode: TrivyRefusalReason; readonly relativePath: string | null }[];
}

export interface TrivyNormalizeInput {
  job: TrivyJob;
  jobDigest: ArtifactId;
  outcome: WorkerOutcome;
  outputBytes: (id: ArtifactId) => Uint8Array;
  /** The sealed input copy of a target, by artifact id. */
  targetBytes: (artifact: ArtifactId) => Uint8Array | undefined;
  qualifyingArchitecture?: string;
}

const CHECK_ID = /^[A-Z][A-Z0-9]{0,15}-[0-9A-Z]{1,8}$/;
const PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$|^\.$/;
const INLINE_IGNORE = /(?:trivy|tfsec):ignore/;
const REMOTE_SOURCE = /^\s*source\s*=\s*"(?!\.\.?\/)[^"]*"/m;
const sha256 = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');

const UNSENT: Record<string, { status: TrivyCoverageStatus; reason: TrivyCoverageReason }> = {
  'not-configuration': { status: 'not-applicable', reason: 'sentinel.trivy.coverage.notConfiguration' },
  'dependency-cache': { status: 'not-applicable', reason: 'sentinel.trivy.coverage.dependencyCache' },
  'variables-file': { status: 'not-applicable', reason: 'sentinel.trivy.coverage.variablesFile' },
  'path-unsupported': { status: 'unsupported', reason: 'sentinel.trivy.coverage.pathUnsupported' },
  'too-large': { status: 'unsupported', reason: 'sentinel.trivy.coverage.tooLarge' },
  'too-many': { status: 'unsupported', reason: 'sentinel.trivy.coverage.tooMany' },
  'bundle-missing': { status: 'bundle-missing', reason: 'sentinel.trivy.coverage.bundleMissing' },
};

/**
 * Trivy 0.76.1 reads a YAML file as Kubernetes only when one of its documents has the keys apiVersion, kind and
 * metadata (pkg/iac/detection/detect.go). YAML can encode those keys as BOM-marked UTF-16 LE or BE, so decode
 * those forms before proving a word absent. Malformed encoding or an escaped key cannot prove absence; anything
 * else the engine did not log is an omission.
 */
export function cannotBeKubernetes(bytes: Uint8Array): boolean {
  const input = Buffer.from(bytes);
  let text: string;
  if ((input[0] === 0xff && input[1] === 0xfe) || (input[0] === 0xfe && input[1] === 0xff)) {
    try { text = new TextDecoder(input[0] === 0xff ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(input); }
    catch { return false; }
  } else text = input.toString('latin1');
  if (text.includes('\\') || text.includes('\0')) return false;
  return !['apiVersion', 'kind', 'metadata'].every(word => text.includes(word));
}

const lineCount = (b: Uint8Array) => { let n = 1; for (const c of b) if (c === 0x0a) n++; return b.length && b[b.length - 1] === 0x0a ? n - 1 : n; };

/** The coverage of a job that never ran (no bundle, or nothing to send): unsent rows only. */
export function notRunResult(job: TrivyJob, adapterId: string): TrivyRunResult {
  return deepFreeze({
    adapter: adapterId, engine: `${TRIVY_ENGINE.name} ${TRIVY_ENGINE.version}`, checks: `${TRIVY_CHECKS_BUNDLE.name} ${TRIVY_CHECKS_BUNDLE.version}`,
    mode: 'misconfiguration-only' as const, attempt: 'not-run' as const, platform: { architecture: null, state: 'not-run' as const },
    engineExit: null, engineFailure: null, bundle: null, findings: [], refused: [], coverage: unsentRows(job),
  });
}

function unsentRows(job: TrivyJob): TrivyCoverage[] {
  return job.unsent.map(u => { const m = UNSENT[u.reason]!; return { relativePath: u.relativePath, artifact: u.artifact, kind: u.kind, status: m.status, reasonCode: m.reason, limitations: [m.reason] }; });
}

export function normalizeTrivyRun(input: TrivyNormalizeInput): TrivyRunResult {
  const { job, outcome } = input;
  const unsent = unsentRows(job);
  const sentRow = (t: TrivyJobTarget, status: TrivyCoverageStatus, reasonCode: TrivyCoverageReason, extra: TrivyCoverageReason[] = []): TrivyCoverage =>
    ({ relativePath: t.relativePath, artifact: t.artifact, kind: t.kind, status, reasonCode, limitations: status === 'complete' ? [] : [reasonCode, ...extra.filter(r => r !== reasonCode)] });
  const allError = (reason: TrivyCoverageReason) => [...job.targets.map(t => sentRow(t, 'error', reason)), ...unsent];
  const base = {
    adapter: outcome.adapter.id, engine: `${TRIVY_ENGINE.name} ${TRIVY_ENGINE.version}`, checks: `${TRIVY_CHECKS_BUNDLE.name} ${TRIVY_CHECKS_BUNDLE.version}`,
    mode: 'misconfiguration-only' as const, attempt: outcome.state,
  };
  const empty = { findings: [], refused: [], bundle: null };

  if (outcome.state !== 'succeeded') {
    const reason: TrivyCoverageReason = outcome.state === 'timed-out' ? 'sentinel.trivy.coverage.attemptTimedOut' : outcome.state === 'canceled' ? 'sentinel.trivy.coverage.attemptCanceled' : 'sentinel.trivy.coverage.attemptFailed';
    return deepFreeze({ ...base, ...empty, platform: { architecture: outcome.container?.image?.architecture ?? null, state: 'refused' as const }, engineExit: null, engineFailure: null, coverage: allError(reason) });
  }
  const architecture = outcome.container?.image?.architecture ?? null;
  const candidate = architecture !== null && architecture === input.qualifyingArchitecture && TRIVY_IMAGE_PLATFORMS.some(p => p.architecture === architecture && p.state === 'unmeasured');
  if (!architecture || (!TRIVY_MEASURED_ARCHITECTURES.has(architecture) && !candidate)) {
    return deepFreeze({ ...base, ...empty, platform: { architecture, state: 'refused' as const }, engineExit: null, engineFailure: null, coverage: allError('sentinel.trivy.coverage.platformUnmeasured') });
  }
  const platform = { architecture, state: candidate ? 'candidate' as const : 'measured' as const };

  const parse = (bytes: Uint8Array, limit: number, what: string): any => {
    if (bytes.byteLength > limit) trivyFail('sentinel.trivy.outputInvalid', `${what} exceeds ${limit} bytes`);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return trivyFail('sentinel.trivy.outputInvalid', `${what} is not UTF-8 JSON`); }
  };
  const recordOut = outcome.outputs.find(o => o.mediaType === 'application/vnd.sentinel.trivy-run+json');
  if (!recordOut) return trivyFail('sentinel.trivy.outputInvalid', 'no run record');
  const record = parse(input.outputBytes(recordOut.id), 512 * 1024, 'the run record');
  if (record?.schema !== 'sentinel-trivy-run/draft-1' || record.job !== input.jobDigest) trivyFail('sentinel.trivy.outputInvalid', 'the run record names another job');
  if (record.bundle?.layer !== job.bundle?.layer) trivyFail('sentinel.trivy.outputInvalid', 'the run record names another checks bundle');
  const engineOut = outcome.outputs.find(o => o.mediaType === 'application/vnd.trivy.report+json');
  if (!engineOut || engineOut.id !== record.engineOutput) return trivyFail('sentinel.trivy.outputInvalid', 'the engine output is not the one the run record names');
  const exit = Number.isSafeInteger(record.exitCode) ? record.exitCode as number : null;
  if (exit !== 0) {
    const c = `sentinel.trivy.engine.${typeof record.failure?.category === 'string' ? record.failure.category : 'unknown'}`;
    const engineFailure = (TRIVY_ENGINE_FAILURES as readonly string[]).includes(c) ? c as TrivyEngineFailure : 'sentinel.trivy.engine.unknown';
    const reason = record.timedOut === true ? 'sentinel.trivy.coverage.engineTimedOut' : 'sentinel.trivy.coverage.engineFailed';
    return deepFreeze({ ...base, ...empty, platform, engineExit: exit, engineFailure, coverage: allError(reason) });
  }
  if (record.stdoutTruncated === true) return deepFreeze({ ...base, ...empty, platform, engineExit: exit, engineFailure: null, coverage: allError('sentinel.trivy.coverage.outputTruncated') });
  const checksLoaded = Number.isSafeInteger(record.bundle?.checks) ? record.bundle.checks as number : null;
  const bundle = { layer: job.bundle!.layer, checksLoaded };
  // The engine's own evidence that it evaluated the pinned bundle, not the checks compiled into the binary.
  if (record.bundle?.fromDisk !== true || record.bundle?.fellBack !== false || !checksLoaded) {
    return deepFreeze({ ...base, findings: [], refused: [], bundle, platform, engineExit: exit, engineFailure: null, coverage: allError('sentinel.trivy.coverage.bundleNotLoaded') });
  }
  const engine = parse(input.outputBytes(engineOut.id), TRIVY_MAX_OUTPUT_BYTES, 'the engine output');
  if (engine?.SchemaVersion !== 2 || engine?.Trivy?.Version !== TRIVY_ENGINE.version || !(engine.Results === undefined || Array.isArray(engine.Results))) {
    trivyFail('sentinel.trivy.outputInvalid', 'the engine output is not a Trivy 0.76.1 report');
  }

  const paths = (v: unknown) => new Set((Array.isArray(v) ? v : []).filter((p): p is string => typeof p === 'string' && PATH.test(p)));
  const scanned = paths(record.scanned), unparsed = paths(record.unparsed), moduleFailed = paths(record.moduleFailed);
  const refused: { reasonCode: TrivyRefusalReason; relativePath: string | null }[] = [];
  const verified = new Map<string, Uint8Array>();
  for (const t of job.targets) { const b = input.targetBytes(t.artifact); if (b && sha256(b) === t.artifact) verified.set(t.relativePath, b); }
  const byPath = new Map(job.targets.map(t => [t.relativePath, t]));
  const folders = new Set(job.targets.filter(t => t.type === 'terraform').map(t => dirOf(t.relativePath)));
  const variableFolders = new Set(job.unsent.filter(u => u.reason === 'variables-file').map(u => dirOf(u.relativePath)));

  const findings = new Map<string, TrivyFinding>();
  for (const result of engine.Results ?? []) {
    // The worker scans below one fixed folder, t/: the engine's targets are relative to the folder above it.
    const raw = typeof result?.Target === 'string' ? result.Target : '';
    const target = raw === 't' ? '.' : raw.startsWith('t/') ? raw.slice(2) : '';
    const file = byPath.get(target);
    const folder = !file && folders.has(target) ? target : null;
    if (!file && folder === null) { refused.push({ reasonCode: 'sentinel.trivy.refused.unknownTarget', relativePath: null }); continue; }
    if (!scanned.has(target)) { refused.push({ reasonCode: 'sentinel.trivy.refused.notScanned', relativePath: target }); continue; }
    const bytes = file ? verified.get(target) : undefined;
    if (file && !bytes) { refused.push({ reasonCode: 'sentinel.trivy.refused.inputMismatch', relativePath: target }); continue; }
    const type = result?.Type;
    if (result?.Class !== 'config' || !['dockerfile', 'kubernetes', 'terraform'].includes(type) || (file && file.type !== type) || (folder !== null && type !== 'terraform')) {
      refused.push({ reasonCode: 'sentinel.trivy.refused.malformed', relativePath: target }); continue;
    }
    for (const m of Array.isArray(result.Misconfigurations) ? result.Misconfigurations : []) {
      if (m?.Status !== 'FAIL') continue;
      if (typeof m.ID !== 'string' || !CHECK_ID.test(m.ID) || !(TRIVY_SEVERITIES as readonly string[]).includes(m.Severity)) {
        refused.push({ reasonCode: 'sentinel.trivy.refused.malformed', relativePath: target }); continue;
      }
      if (typeof m.Namespace !== 'string' || !m.Namespace.startsWith('builtin.')) { refused.push({ reasonCode: 'sentinel.trivy.refused.notFromBundle', relativePath: target }); continue; }
      const start = m.CauseMetadata?.StartLine, end = m.CauseMetadata?.EndLine;
      let lines: TrivyFinding['lines'] = null;
      if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0) {
        if (!bytes || end < start || end > lineCount(bytes)) { refused.push({ reasonCode: 'sentinel.trivy.refused.locationInvalid', relativePath: target }); continue; }
        lines = { start, end };
      } else if (!((start === 0 || start === undefined) && (end === 0 || end === undefined))) {
        refused.push({ reasonCode: 'sentinel.trivy.refused.locationInvalid', relativePath: target }); continue;
      }
      const key = `${m.ID}|${target}|${lines ? `${lines.start}-${lines.end}` : '-'}`;
      const id = `trivy-${canonicalDigest({ key, artifact: file?.artifact ?? null, bundle: bundle.layer }).slice(7, 39)}`;
      findings.set(key, { id, key, checkId: m.ID, severity: m.Severity, configType: type, relativePath: target, artifact: file?.artifact ?? null, lines, bundle: bundle.layer });
    }
  }

  const coverage: TrivyCoverage[] = job.targets.map(t => {
    const bytes = verified.get(t.relativePath);
    if (!bytes) return sentRow(t, 'error', 'sentinel.trivy.coverage.inputMismatch');
    if (unparsed.has(t.relativePath)) return sentRow(t, 'error', 'sentinel.trivy.coverage.parseFailed');
    const seen = scanned.has(t.relativePath) || (t.type === 'terraform' && scanned.has(dirOf(t.relativePath)));
    if (!seen) {
      // At exit 0, a file the engine did not report scanning is an omission, never a pass, unless its bytes prove the
      // engine's own Kubernetes rule cannot match it (see cannotBeKubernetes).
      return t.kind === 'kubernetes-candidate' && cannotBeKubernetes(bytes)
        ? sentRow(t, 'not-applicable', 'sentinel.trivy.coverage.notRecognized') : sentRow(t, 'error', 'sentinel.trivy.coverage.notReported');
    }
    const limits: TrivyCoverageReason[] = [];
    if (INLINE_IGNORE.test(Buffer.from(bytes).toString('latin1'))) limits.push('sentinel.trivy.coverage.inlineIgnore');
    if (t.type === 'terraform') {
      if (moduleFailed.has(t.relativePath) || REMOTE_SOURCE.test(Buffer.from(bytes).toString('latin1'))) limits.push('sentinel.trivy.coverage.remoteModuleUnresolved');
      if (variableFolders.has(dirOf(t.relativePath))) limits.push('sentinel.trivy.coverage.variablesNotRead');
    }
    return limits.length ? sentRow(t, 'partial', limits[0]!, limits) : sentRow(t, 'complete', 'sentinel.trivy.coverage.complete');
  });
  const sorted = [...findings.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return deepFreeze({ ...base, platform, engineExit: exit, engineFailure: null, bundle, findings: sorted, coverage: [...coverage, ...unsent], refused });
}
