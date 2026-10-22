// Reading one zizmor attempt's verified outputs, coordinator-side. The engine reports findings; this decides what
// they establish:
// - the run record must name the supplied job and the engine output it lists, and the engine's own banner must name
//   the pinned version; a failed engine or a truncated report counts nothing;
// - the audits skipped must be exactly the pinned online-only set: any other audit that did not load leaves every
//   file short of complete, and the online-only audits are always an explicit gap, never a pass;
// - the exit code must agree with the report (zizmor exits 11–14 by its highest finding, 0 with none): a report that
//   disagrees, at exit 0 or otherwise, counts nothing;
// - a finding keeps the audit, severity, confidence and byte spans at captured paths, checked against the captured
//   bytes; never the engine's annotations or quoted features; no graph node is created;
// - coverage is per file and needs the engine's own "completed" evidence; a file it collected but did not audit
//   (unparseable, or not valid for its kind) and one it never collected at all are both gaps.
import { createHash } from 'node:crypto';
import type { ArtifactId } from '../../contracts/common.js';
import type { WorkerOutcome } from '../../execution/supervisor.js';
import { canonicalDigest } from '../../policy/digest.js';
import { deepFreeze } from '../../policy/immutable.js';
import { ZIZMOR_ENGINE, ZIZMOR_IMAGE_PLATFORMS, ZIZMOR_MAX_OUTPUT_BYTES, ZIZMOR_MEASURED_ARCHITECTURES, ZIZMOR_ONLINE_AUDITS } from './adapter.js';
import { zizmorFail } from './errors.js';
import type { CiFileKind, ZizmorJob, ZizmorJobTarget } from './job.js';

export const ZIZMOR_COVERAGE_REASONS = [
  'sentinel.zizmor.coverage.complete', 'sentinel.zizmor.coverage.onlineAuditsSkipped', 'sentinel.zizmor.coverage.offlineDegraded',
  'sentinel.zizmor.coverage.auditNotLoaded', 'sentinel.zizmor.coverage.notAudited', 'sentinel.zizmor.coverage.notCollected',
  'sentinel.zizmor.coverage.notCiConfiguration', 'sentinel.zizmor.coverage.pathUnsupported', 'sentinel.zizmor.coverage.tooLarge',
  'sentinel.zizmor.coverage.tooMany', 'sentinel.zizmor.coverage.inputMismatch', 'sentinel.zizmor.coverage.reportInconsistent',
  'sentinel.zizmor.coverage.attemptFailed', 'sentinel.zizmor.coverage.attemptTimedOut', 'sentinel.zizmor.coverage.attemptCanceled',
  'sentinel.zizmor.coverage.engineFailed', 'sentinel.zizmor.coverage.engineTimedOut', 'sentinel.zizmor.coverage.outputTruncated',
  'sentinel.zizmor.coverage.platformUnmeasured',
] as const;
export type ZizmorCoverageReason = typeof ZIZMOR_COVERAGE_REASONS[number];
export const ZIZMOR_REFUSAL_REASONS = [
  'sentinel.zizmor.refused.unknownPath', 'sentinel.zizmor.refused.malformed', 'sentinel.zizmor.refused.locationInvalid',
  'sentinel.zizmor.refused.ignored', 'sentinel.zizmor.refused.notAudited',
] as const;
export type ZizmorRefusalReason = typeof ZIZMOR_REFUSAL_REASONS[number];
export const ZIZMOR_ENGINE_FAILURES = ['sentinel.zizmor.engine.engineError', 'sentinel.zizmor.engine.usage', 'sentinel.zizmor.engine.killed', 'sentinel.zizmor.engine.unknown'] as const;
export type ZizmorEngineFailure = typeof ZIZMOR_ENGINE_FAILURES[number];
export const ZIZMOR_SEVERITIES = ['High', 'Medium', 'Low', 'Informational'] as const;
export type ZizmorSeverity = typeof ZIZMOR_SEVERITIES[number];
const EXIT_OF: Record<ZizmorSeverity, number> = { High: 14, Medium: 13, Low: 12, Informational: 11 };

export type ZizmorCoverageStatus = 'complete' | 'partial' | 'error' | 'not-applicable' | 'unsupported';
export interface ZizmorCoverage {
  readonly relativePath: string;
  readonly artifact: ArtifactId;
  readonly kind: CiFileKind | null;
  readonly status: ZizmorCoverageStatus;
  readonly reasonCode: ZizmorCoverageReason;
  readonly limitations: readonly ZizmorCoverageReason[];
}
export interface ZizmorLocation {
  readonly relativePath: string;
  readonly artifact: ArtifactId;
  /** UTF-8 byte offsets in the captured file, half-open. */
  readonly span: { readonly startByte: number; readonly endByte: number };
  readonly kind: 'primary' | 'related';
}
/** One audit finding at captured CI configuration: paths and spans, never a graph node. */
export interface ZizmorFinding {
  readonly id: string;
  readonly key: string;
  readonly audit: string;
  readonly severity: ZizmorSeverity;
  readonly confidence: 'High' | 'Medium' | 'Low';
  readonly primary: ZizmorLocation;
  readonly related: readonly ZizmorLocation[];
}
export interface ZizmorRunResult {
  readonly adapter: string;
  readonly engine: string;
  readonly mode: 'offline';
  readonly attempt: WorkerOutcome['state'] | 'not-run';
  readonly platform: { readonly architecture: string | null; readonly state: 'measured' | 'candidate' | 'refused' | 'not-run' };
  readonly engineExit: number | null;
  readonly engineFailure: ZizmorEngineFailure | null;
  /** The audits the engine reported skipping: the pinned online-only set, and any other that failed to load. */
  readonly skippedAudits: readonly string[];
  readonly findings: readonly ZizmorFinding[];
  readonly coverage: readonly ZizmorCoverage[];
  readonly refused: readonly { readonly reasonCode: ZizmorRefusalReason; readonly relativePath: string | null }[];
}
export interface ZizmorNormalizeInput {
  job: ZizmorJob;
  jobDigest: ArtifactId;
  outcome: WorkerOutcome;
  outputBytes: (id: ArtifactId) => Uint8Array;
  targetBytes: (artifact: ArtifactId) => Uint8Array | undefined;
  qualifyingArchitecture?: string;
}

const ROOT = '/tmp/sentinel-zizmor/src/';
const AUDIT = /^[a-z][a-z0-9-]{0,63}$/;
const PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const sha256 = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const UNSENT: Record<string, { status: ZizmorCoverageStatus; reason: ZizmorCoverageReason }> = {
  'not-ci-configuration': { status: 'not-applicable', reason: 'sentinel.zizmor.coverage.notCiConfiguration' },
  'path-unsupported': { status: 'unsupported', reason: 'sentinel.zizmor.coverage.pathUnsupported' },
  'too-large': { status: 'unsupported', reason: 'sentinel.zizmor.coverage.tooLarge' },
  'too-many': { status: 'unsupported', reason: 'sentinel.zizmor.coverage.tooMany' },
};
const unsentRows = (job: ZizmorJob): ZizmorCoverage[] => job.unsent.map(u => {
  const m = UNSENT[u.reason]!;
  return { relativePath: u.relativePath, artifact: u.artifact, kind: u.kind, status: m.status, reasonCode: m.reason, limitations: [m.reason] };
});
const engineName = `${ZIZMOR_ENGINE.name} ${ZIZMOR_ENGINE.version}`;

export function notRunZizmor(job: ZizmorJob, adapterId: string): ZizmorRunResult {
  return deepFreeze({ adapter: adapterId, engine: engineName, mode: 'offline' as const, attempt: 'not-run' as const, platform: { architecture: null, state: 'not-run' as const },
    engineExit: null, engineFailure: null, skippedAudits: [], findings: [], refused: [], coverage: unsentRows(job) });
}

export function normalizeZizmorRun(input: ZizmorNormalizeInput): ZizmorRunResult {
  const { job, outcome } = input;
  const unsent = unsentRows(job);
  const sentRow = (t: ZizmorJobTarget, status: ZizmorCoverageStatus, reasonCode: ZizmorCoverageReason, extra: ZizmorCoverageReason[] = []): ZizmorCoverage =>
    ({ relativePath: t.relativePath, artifact: t.artifact, kind: t.kind, status, reasonCode, limitations: status === 'complete' ? [] : [reasonCode, ...extra.filter(r => r !== reasonCode)] });
  const allError = (reason: ZizmorCoverageReason) => [...job.targets.map(t => sentRow(t, 'error', reason)), ...unsent];
  const base = { adapter: outcome.adapter.id, engine: engineName, mode: 'offline' as const, attempt: outcome.state };
  const empty = { findings: [], refused: [], skippedAudits: [] };

  if (outcome.state !== 'succeeded') {
    const reason: ZizmorCoverageReason = outcome.state === 'timed-out' ? 'sentinel.zizmor.coverage.attemptTimedOut' : outcome.state === 'canceled' ? 'sentinel.zizmor.coverage.attemptCanceled' : 'sentinel.zizmor.coverage.attemptFailed';
    return deepFreeze({ ...base, ...empty, platform: { architecture: outcome.container?.image?.architecture ?? null, state: 'refused' as const }, engineExit: null, engineFailure: null, coverage: allError(reason) });
  }
  const architecture = outcome.container?.image?.architecture ?? null;
  const candidate = architecture !== null && architecture === input.qualifyingArchitecture && ZIZMOR_IMAGE_PLATFORMS.some(p => p.architecture === architecture && p.state === 'unmeasured');
  if (!architecture || (!ZIZMOR_MEASURED_ARCHITECTURES.has(architecture) && !candidate)) {
    return deepFreeze({ ...base, ...empty, platform: { architecture, state: 'refused' as const }, engineExit: null, engineFailure: null, coverage: allError('sentinel.zizmor.coverage.platformUnmeasured') });
  }
  const platform = { architecture, state: candidate ? 'candidate' as const : 'measured' as const };
  const parse = (bytes: Uint8Array, limit: number, what: string): any => {
    if (bytes.byteLength > limit) zizmorFail('sentinel.zizmor.outputInvalid', `${what} exceeds ${limit} bytes`);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return zizmorFail('sentinel.zizmor.outputInvalid', `${what} is not UTF-8 JSON`); }
  };
  const recordOut = outcome.outputs.find(o => o.mediaType === 'application/vnd.sentinel.zizmor-run+json');
  if (!recordOut) return zizmorFail('sentinel.zizmor.outputInvalid', 'no run record');
  const record = parse(input.outputBytes(recordOut.id), 512 * 1024, 'the run record');
  if (record?.schema !== 'sentinel-zizmor-run/draft-1' || record.job !== input.jobDigest) zizmorFail('sentinel.zizmor.outputInvalid', 'the run record names another job');
  const engineOut = outcome.outputs.find(o => o.mediaType === 'application/vnd.zizmor.findings+json');
  if (!engineOut || engineOut.id !== record.engineOutput) return zizmorFail('sentinel.zizmor.outputInvalid', 'the engine output is not the one the run record names');
  const exit = Number.isSafeInteger(record.exitCode) ? record.exitCode as number : null;
  if (exit === null || ![0, 3, 11, 12, 13, 14].includes(exit)) {
    const c = `sentinel.zizmor.engine.${typeof record.failure?.category === 'string' ? record.failure.category : 'unknown'}`;
    const engineFailure = (ZIZMOR_ENGINE_FAILURES as readonly string[]).includes(c) ? c as ZizmorEngineFailure : 'sentinel.zizmor.engine.unknown';
    const reason = record.timedOut === true ? 'sentinel.zizmor.coverage.engineTimedOut' : 'sentinel.zizmor.coverage.engineFailed';
    return deepFreeze({ ...base, ...empty, platform, engineExit: exit, engineFailure, coverage: allError(reason) });
  }
  if (record.version !== ZIZMOR_ENGINE.version) zizmorFail('sentinel.zizmor.outputInvalid', 'the engine did not report the pinned version');
  if (record.stdoutTruncated === true) return deepFreeze({ ...base, ...empty, platform, engineExit: exit, engineFailure: null, coverage: allError('sentinel.zizmor.coverage.outputTruncated') });
  const report = exit === 3 ? [] : parse(input.outputBytes(engineOut.id), ZIZMOR_MAX_OUTPUT_BYTES, 'the engine output');
  if (!Array.isArray(report)) zizmorFail('sentinel.zizmor.outputInvalid', 'the engine output is not a list of findings');
  const skippedAudits: string[] = [...new Set<string>((Array.isArray(record.skippedAudits) ? record.skippedAudits : []).filter((a: unknown): a is string => typeof a === 'string' && AUDIT.test(a)))].sort();
  const paths = (v: unknown) => new Set((Array.isArray(v) ? v : []).filter((p): p is string => typeof p === 'string' && PATH.test(p)));
  const registered = paths(record.registered), completed = paths(record.completed);

  const verified = new Map<string, Uint8Array>();
  for (const t of job.targets) { const b = input.targetBytes(t.artifact); if (b && sha256(b) === t.artifact) verified.set(t.relativePath, b); }
  const byPath = new Map(job.targets.map(t => [t.relativePath, t]));
  const refused: { reasonCode: ZizmorRefusalReason; relativePath: string | null }[] = [];
  const findings = new Map<string, ZizmorFinding>();
  let highest = 0;
  for (const f of report) {
    const audit = f?.ident, sev = f?.determinations?.severity, conf = f?.determinations?.confidence;
    if (typeof audit !== 'string' || !AUDIT.test(audit) || !(ZIZMOR_SEVERITIES as readonly string[]).includes(sev) || !['High', 'Medium', 'Low'].includes(conf) || !Array.isArray(f.locations)) {
      refused.push({ reasonCode: 'sentinel.zizmor.refused.malformed', relativePath: null }); continue;
    }
    highest = Math.max(highest, EXIT_OF[sev as ZizmorSeverity]);
    if (f.ignored !== false) { refused.push({ reasonCode: 'sentinel.zizmor.refused.ignored', relativePath: null }); continue; }
    const locations: ZizmorLocation[] = [];
    let bad: ZizmorRefusalReason | null = null;
    let at: string | null = null;
    for (const l of f.locations) {
      const raw = l?.symbolic?.key?.Local?.verbatim_path;
      const rel = typeof raw === 'string' && raw.startsWith(ROOT) ? raw.slice(ROOT.length) : null;
      const target = rel ? byPath.get(rel) : undefined;
      if (!target) { bad = 'sentinel.zizmor.refused.unknownPath'; break; }
      at = target.relativePath;
      const bytes = verified.get(target.relativePath);
      if (!bytes) { bad = 'sentinel.zizmor.refused.locationInvalid'; break; }
      if (!completed.has(target.relativePath)) { bad = 'sentinel.zizmor.refused.notAudited'; break; }
      const s = l?.concrete?.location?.offset_span;
      if (!Number.isSafeInteger(s?.start) || !Number.isSafeInteger(s?.end) || s.start < 0 || s.end < s.start || s.end > bytes.length) { bad = 'sentinel.zizmor.refused.locationInvalid'; break; }
      // zizmor 1.31.1's three location kinds; a hidden one only spans the finding for ignore comments, which are off.
      const kind = l?.symbolic?.kind === 'Primary' ? 'primary' : l?.symbolic?.kind === 'Related' ? 'related' : l?.symbolic?.kind === 'Hidden' ? 'hidden' : null;
      if (!kind) { bad = 'sentinel.zizmor.refused.malformed'; break; }
      if (kind === 'hidden') continue;
      locations.push({ relativePath: target.relativePath, artifact: target.artifact, span: { startByte: s.start, endByte: s.end }, kind });
    }
    const primaries = locations.filter(l => l.kind === 'primary');
    if (!bad && primaries.length !== 1) bad = 'sentinel.zizmor.refused.malformed';
    if (bad) { refused.push({ reasonCode: bad, relativePath: at }); continue; }
    const primary = primaries[0]!;
    const key = `${audit}|${primary.relativePath}|${primary.span.startByte}-${primary.span.endByte}`;
    const id = `zizmor-${canonicalDigest({ key, artifact: primary.artifact, engine: engineName }).slice(7, 39)}`;
    findings.set(key, { id, key, audit, severity: sev, confidence: conf, primary, related: locations.filter(l => l.kind === 'related') });
  }
  // The exit code is the engine's own summary of its report: they must agree.
  const expected = exit === 3 ? 3 : highest;
  if (exit !== expected || (exit === 3 && registered.size > 0)) {
    return deepFreeze({ ...base, findings: [], refused: [], skippedAudits, platform, engineExit: exit, engineFailure: null, coverage: allError('sentinel.zizmor.coverage.reportInconsistent') });
  }
  const online = new Set<string>(ZIZMOR_ONLINE_AUDITS);
  const onlineSkipped = ZIZMOR_ONLINE_AUDITS.every(a => skippedAudits.includes(a));
  const otherSkipped = skippedAudits.some(a => !online.has(a));
  if (!onlineSkipped) {
    // An online audit loaded in a run that was meant to be offline: the run's mode is not what was asked for.
    return deepFreeze({ ...base, findings: [], refused: [], skippedAudits, platform, engineExit: exit, engineFailure: null, coverage: allError('sentinel.zizmor.coverage.reportInconsistent') });
  }
  const coverage: ZizmorCoverage[] = job.targets.map(t => {
    if (!verified.has(t.relativePath)) return sentRow(t, 'error', 'sentinel.zizmor.coverage.inputMismatch');
    if (!completed.has(t.relativePath)) return sentRow(t, 'error', registered.has(t.relativePath) ? 'sentinel.zizmor.coverage.notAudited' : 'sentinel.zizmor.coverage.notCollected');
    const limits: ZizmorCoverageReason[] = [];
    if (otherSkipped) limits.push('sentinel.zizmor.coverage.auditNotLoaded');
    if (t.kind !== 'dependabot') limits.push('sentinel.zizmor.coverage.onlineAuditsSkipped', 'sentinel.zizmor.coverage.offlineDegraded');
    return limits.length ? sentRow(t, 'partial', limits[0]!, limits) : sentRow(t, 'complete', 'sentinel.zizmor.coverage.complete');
  });
  const sorted = [...findings.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return deepFreeze({ ...base, platform, engineExit: exit, engineFailure: null, skippedAudits, findings: sorted, coverage: [...coverage, ...unsent], refused });
}
