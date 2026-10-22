// Reading one secret-scan attempt. Pure over the supervised outcome, the verified output bytes and the sealed input
// copies the container saw; it never throws for anything the worker or the engine did.
//
// Redaction: an observation is built here from a closed field list — the detector (a rule ID the pinned default
// configuration defines), a captured file, a whole-line byte span, a fixed message and fixed limitation keys. The
// report it is read from carries only rule, lines and file by construction (the pinned template), and each line is
// checked against exactly that shape, so neither a report nor an observation can carry part of a value.
//
// Failure is never zero findings: a failed attempt, an unmeasured platform, a malformed or inconsistent record or
// report, an engine error, a missing or oversized report, an unknown rule or file, or lines a file does not have make
// the whole scan an `error` over every target, with a coded reason. Files not sent are skipped scopes (job.ts); with
// any of them the scan is `partial`.
import { createHash } from 'node:crypto';
import type { CatalogKey, Digest, Id, ScopedReason } from '../../contracts/common.js';
import type { ObservationEnvelope } from '../../contracts/observation.js';
import type { WorkerOutcome } from '../../execution/supervisor.js';
import { validateEnvelope } from '../../validate.js';
import { GITLEAKS_CONFIG_DIGEST, GITLEAKS_ENGINE, GITLEAKS_IMAGE_PLATFORMS, GITLEAKS_MEASURED_ARCHITECTURES } from './adapter.js';
import { SCANNER_PATH_PREFIX, type SecretsJob } from './job.js';
import { GITLEAKS_RULE_IDS } from './rules.js';

export const OBSERVATION_MESSAGE = 'A value shaped like a secret matched this detector. The value is withheld; open the cited lines in the captured source to review it.';
export const OBSERVATION_LIMITATIONS = Object.freeze(['sentinel.secrets.valueWithheld', 'sentinel.secrets.lineLocation'] as const);
export const MAX_SECRETS_OBSERVATIONS = 10_000;
export const RECORD_MEDIA_TYPE = 'application/vnd.sentinel.gitleaks-run+json';
export const REPORT_MEDIA_TYPE = 'application/vnd.sentinel.gitleaks-report';

export type SecretsScanStatus = 'complete' | 'partial' | 'error';

export interface SecretsAudit {
  readonly engine: string;
  readonly adapterId: Id;
  readonly adapterDigest: Digest;
  readonly image: string | null;
  readonly imageId: string | null;
  readonly architecture: string | null;
  readonly configDigest: Digest;
  readonly defaultRules: Digest;
  readonly worker: Digest;
  readonly job: Digest;
  readonly invocation: Digest;
  readonly exitCode: number | null;
  readonly stderrDigest: Digest | null;
  readonly report: Digest | null;
}

export interface SecretsScanResult {
  readonly status: SecretsScanStatus;
  /** Why the scan is an error. Absent for complete and partial. */
  readonly reasonCode?: CatalogKey;
  readonly observations: readonly ObservationEnvelope[];
  /** Scopes the engine read. Empty for an error: nothing is credited. */
  readonly scanned: readonly string[];
  /** Scopes not scanned, each with its reason. For an error, every target. */
  readonly skipped: readonly ScopedReason[];
  /** The image platform the engine ran on: measured, or a candidate only under an explicit qualification run. */
  readonly platform: { readonly architecture: string | null; readonly state: 'measured' | 'candidate' | 'refused' };
  readonly audit: SecretsAudit;
}

export interface NormalizeInput {
  readonly job: SecretsJob;
  readonly jobDigest: Digest;
  readonly outcome: WorkerOutcome;
  /** Bytes of a verified output, by id. */
  readonly outputBytes: (id: string) => Uint8Array | undefined;
  /** Bytes of a sealed input copy, by artifact id: the bytes the container saw. */
  readonly targetBytes: (artifact: string) => Uint8Array | undefined;
  readonly observedAt: string;
  /** Qualification only: an unmeasured platform of the pinned index whose results are marked candidate. */
  readonly qualifyingArchitecture?: string;
}

const WORKER_CODE = /^sentinel-gitleaks-worker\/1 (sentinel\.secrets\.[a-z][A-Za-z]*)\n$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const sha = (b: string | Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const FAILURES: Readonly<Record<string, CatalogKey>> = {
  engineError: 'sentinel.secrets.toolFailed', killed: 'sentinel.secrets.toolTimedOut',
  reportMissing: 'sentinel.secrets.reportMissing', reportTooLarge: 'sentinel.secrets.reportTooLarge',
};

class Refused extends Error { constructor(readonly code: CatalogKey) { super(code); } }
const refuse = (code: CatalogKey): never => { throw new Refused(code); };

interface RunRecord { job: string; exitCode: number; failure: string | null; report: string | null; reportBytes: number; stderrDigest: string }

function readRecord(bytes: Uint8Array | undefined): RunRecord {
  if (!bytes) return refuse('sentinel.secrets.outputRefused');
  let v: Record<string, unknown>;
  try { v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return refuse('sentinel.secrets.outputRefused'); }
  if (!v || typeof v !== 'object' || Object.keys(v).join(',') !== 'schema,job,exitCode,failure,report,reportBytes,stderrDigest'
    || v.schema !== 'sentinel-gitleaks-run/draft-1' || typeof v.job !== 'string' || !DIGEST.test(v.job)
    || !Number.isSafeInteger(v.exitCode) || (v.exitCode as number) < 0 || (v.exitCode as number) > 255
    || !(v.failure === null || (typeof v.failure === 'string' && v.failure in FAILURES))
    || !(v.report === null || (typeof v.report === 'string' && DIGEST.test(v.report)))
    || !Number.isSafeInteger(v.reportBytes) || (v.reportBytes as number) < 0
    || typeof v.stderrDigest !== 'string' || !DIGEST.test(v.stderrDigest)) return refuse('sentinel.secrets.outputRefused');
  return v as unknown as RunRecord;
}

interface ReportLine { rule: string; start: number; end: number; path: string }

/** Each line is exactly `F<TAB>rule<TAB>start<TAB>end<TAB>file`, the rule a pinned rule ID, the file a sent path. */
export function readReport(text: string, sent: ReadonlySet<string>): ReportLine[] {
  if (text === '') return [];
  if (!text.endsWith('\n')) refuse('sentinel.secrets.reportMalformed');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > MAX_SECRETS_OBSERVATIONS) refuse('sentinel.secrets.tooManyFindings');
  return lines.map(line => {
    const parts = line.split('\t');
    if (parts.length < 5 || parts[0] !== 'F') refuse('sentinel.secrets.reportMalformed');
    const [, rule, s, e] = parts as [string, string, string, string];
    const file = parts.slice(4).join('\t');
    if (!GITLEAKS_RULE_IDS.has(rule) || !/^[1-9][0-9]{0,9}$/.test(s) || !/^[1-9][0-9]{0,9}$/.test(e) || Number(e) < Number(s)) refuse('sentinel.secrets.reportMalformed');
    if (!file.startsWith(SCANNER_PATH_PREFIX) || !sent.has(file.slice(SCANNER_PATH_PREFIX.length))) refuse('sentinel.secrets.unknownFile');
    return { rule, start: Number(s), end: Number(e), path: file.slice(SCANNER_PATH_PREFIX.length) };
  });
}

/** Byte span of whole lines [start, end] (1-based, inclusive), line break excluded; never a part of a line. */
export function lineSpan(bytes: Uint8Array, startLine: number, endLine: number): { startByte: number; endByte: number } {
  let line = 1, startByte = startLine === 1 ? 0 : -1, i = 0;
  for (; i < bytes.length; i++) {
    if (bytes[i] !== 0x0a) continue;
    if (line === endLine) break;
    line++;
    if (line === startLine) startByte = i + 1;
  }
  if (startByte < 0 || line < endLine) refuse('sentinel.secrets.locationOutOfRange');
  let endByte = i;
  if (endByte > startByte && bytes[endByte - 1] === 0x0d) endByte--;
  return { startByte, endByte };
}

export const scopeOf = (sourceId: string, path: string) => `${sourceId}:${path}`;

export function normalizeSecretsRun(input: NormalizeInput): SecretsScanResult {
  const { job, outcome } = input;
  const targets = [...job.files.map(f => f.relativePath), ...job.unsent.map(u => u.relativePath)].map(p => scopeOf(job.sourceId, p));
  let record: RunRecord | undefined;
  const audit = (): SecretsAudit => ({
    engine: `${GITLEAKS_ENGINE.name} ${GITLEAKS_ENGINE.version}`, adapterId: outcome.adapter.id, adapterDigest: outcome.adapter.digest,
    image: outcome.container?.image.reference ?? null, imageId: outcome.container?.image.id ?? null,
    architecture: outcome.container?.image.architecture ?? null, configDigest: GITLEAKS_CONFIG_DIGEST,
    defaultRules: GITLEAKS_ENGINE.defaultConfig, worker: job.worker, job: input.jobDigest, invocation: outcome.invocation.digest,
    exitCode: record?.exitCode ?? null, stderrDigest: record?.stderrDigest ?? null, report: record?.report ?? null,
  });
  const architecture = outcome.container?.image.architecture ?? null;
  const listed = GITLEAKS_IMAGE_PLATFORMS.some(p => p.architecture === architecture);
  const platform = Object.freeze({ architecture, state: architecture !== null && GITLEAKS_MEASURED_ARCHITECTURES.has(architecture) ? 'measured' as const
    : listed && architecture === input.qualifyingArchitecture ? 'candidate' as const : 'refused' as const });
  const error = (reasonCode: CatalogKey): SecretsScanResult => Object.freeze({
    status: 'error' as const, reasonCode, observations: [], scanned: [],
    skipped: targets.map(scopeId => ({ scopeId, reasonCode })), platform, audit: audit(),
  });
  if (outcome.state !== 'succeeded' || !outcome.result) {
    const coded = WORKER_CODE.exec(outcome.diagnostics.text)?.[1];
    return error((coded ?? (outcome.state === 'timed-out' ? 'sentinel.secrets.toolTimedOut' : outcome.code) ?? 'sentinel.secrets.workerError') as CatalogKey);
  }
  if (platform.state === 'refused') return error('sentinel.secrets.platformUnmeasured');
  try {
    const records = outcome.outputs.filter(o => o.mediaType === RECORD_MEDIA_TYPE);
    const reports = outcome.outputs.filter(o => o.mediaType === REPORT_MEDIA_TYPE);
    if (records.length !== 1 || reports.length > 1 || records.length + reports.length !== outcome.outputs.length) refuse('sentinel.secrets.outputRefused');
    record = readRecord(input.outputBytes(records[0]!.id));
    if (record.job !== input.jobDigest) refuse('sentinel.secrets.outputRefused');
    if (record.failure) refuse(FAILURES[record.failure]!);
    if (record.exitCode !== 0 && record.exitCode !== 2) refuse('sentinel.secrets.toolFailed');
    if (!record.report || reports.length !== 1 || reports[0]!.id !== record.report || reports[0]!.bytes !== record.reportBytes) refuse('sentinel.secrets.reportMissing');
    const reportBytes = input.outputBytes(record.report!);
    if (!reportBytes || sha(reportBytes) !== record.report) refuse('sentinel.secrets.reportMissing');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(reportBytes); } catch { return refuse('sentinel.secrets.reportMalformed'); }
    const byPath = new Map(job.files.map(f => [f.relativePath, f]));
    const lines = readReport(text, new Set(byPath.keys()));
    // The exit code and the report must agree: "leaks found" with no lines, or the reverse, is not trusted.
    if ((record.exitCode === 2) !== (lines.length > 0)) refuse('sentinel.secrets.reportInconsistent');
    const producer = { kind: 'scanner' as const, adapterId: outcome.adapter.id, adapterDigest: outcome.adapter.digest, attemptId: outcome.attemptId };
    const observations = new Map<string, ObservationEnvelope>();
    for (const l of lines) {
      const file = byPath.get(l.path)!;
      const bytes = input.targetBytes(file.artifact);
      if (!bytes || bytes.length !== file.bytes || sha(bytes) !== file.artifact) refuse('sentinel.secrets.inputInvalid');
      const span = lineSpan(bytes!, l.start, l.end);
      const key = JSON.stringify([l.rule, l.path, l.start, l.end]);
      if (observations.has(key)) continue;
      const body = {
        schema: 'sentinel-observation/draft-1' as const, snapshotId: job.snapshotId, producer, producerRuleId: l.rule,
        originalSeverity: 'unrated', message: OBSERVATION_MESSAGE,
        evidence: [{ snapshotId: job.snapshotId, sourceId: job.sourceId, relativePath: l.path, content: file.artifact, span }],
        limitationKeys: [...OBSERVATION_LIMITATIONS], observedAt: input.observedAt,
      };
      // The ID is derived from what identifies the finding in this attempt, so reading the attempt twice names it the same.
      const id = `obs-${sha(JSON.stringify([outcome.attemptId, job.snapshotId, job.sourceId, l.rule, l.path, l.start, l.end])).slice(7, 47)}`;
      const valid = validateEnvelope('observation', { id, ...body });
      if (!valid.ok) refuse('sentinel.secrets.outputRefused');
      observations.set(key, (valid as { value: ObservationEnvelope }).value);
    }
    const skipped = job.unsent.map(u => ({ scopeId: scopeOf(job.sourceId, u.relativePath), reasonCode: u.reasonCode }));
    return Object.freeze({
      status: skipped.length ? 'partial' as const : 'complete' as const, observations: [...observations.values()],
      scanned: job.files.map(f => scopeOf(job.sourceId, f.relativePath)), skipped, platform, audit: audit(),
    });
  } catch (e) {
    return error(e instanceof Refused ? e.code : 'sentinel.secrets.outputRefused');
  }
}
