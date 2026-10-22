// Runtime validation for the draft envelopes: an exact version check first (never coerced), then the
// generated JSON schema, then invariants a JSON schema cannot express (cross-field and cross-record rules).
import { Ajv, type ValidateFunction } from 'ajv';
import schemas from './schemas.generated.js';
import { ENVELOPES, MAX_ENVELOPE_BYTES, type EnvelopeKind } from './contracts/index.js';
import type {
  AttemptEnvelope, CoverageEnvelope, DispositionEnvelope, ObservationEnvelope, PolicyResult, ProtocolMessage,
  ReportCount, ReportEnvelope, RunEnvelope, SnapshotEnvelope, WorkEnvelope, FindingPlace, HelloMessage,
  WelcomeMessage, RefuseMessage,
} from './contracts/index.js';

export interface EnvelopeTypes {
  snapshot: SnapshotEnvelope;
  run: RunEnvelope;
  work: WorkEnvelope;
  attempt: AttemptEnvelope;
  observation: ObservationEnvelope;
  coverage: CoverageEnvelope;
  disposition: DispositionEnvelope;
  report: ReportEnvelope;
  protocol: ProtocolMessage;
}

/** Stable error codes; message text is safe context, never raw input. */
export type ContractErrorCode =
  | 'sentinel.contract.unknownKind'
  | 'sentinel.contract.tooLarge'
  | 'sentinel.contract.malformedJson'
  | 'sentinel.contract.missingVersion'
  | 'sentinel.contract.wrongKind'
  | 'sentinel.contract.unsupportedVersion'
  | 'sentinel.contract.invalid'
  | 'sentinel.contract.invariant'
  | 'sentinel.contract.errorLimit';

export interface ContractError {
  code: ContractErrorCode;
  /** JSON pointer into the value, when the error has a location. */
  path: string;
  message: string;
  /** The versions this build reads, on a version error. */
  supported?: string[];
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: ContractError[] };

const VERSION = /^(sentinel-[a-z]+)\/(draft-[1-9][0-9]*|v[1-9][0-9]*)$/;
const versionField = (kind: EnvelopeKind) => (kind === 'protocol' ? 'protocol' : 'schema');

let ajv: Ajv | undefined;
const compiled = new Map<EnvelopeKind, ValidateFunction>();
function validatorFor(kind: EnvelopeKind): ValidateFunction {
  let fn = compiled.get(kind);
  if (!fn) {
    // allErrors: false bounds the work and the error list at the source: Ajv stops at the first failure
    // instead of materialising one error per bad element of a large array.
    ajv ??= new Ajv({ allErrors: false, strict: true, allowUnionTypes: true })
      .addFormat('date-time', { type: 'string', validate: isCalendarTimestamp });
    fn = ajv.compile((schemas as Record<EnvelopeKind, object>)[kind]);
    compiled.set(kind, fn);
  }
  return fn;
}

/** The published JSON schema for one envelope kind. */
export function schemaOf(kind: EnvelopeKind): object {
  return (schemas as Record<EnvelopeKind, object>)[kind];
}

/** A real UTC calendar instant: the schema pattern bounds each field, this refuses 2026-02-30 and friends. */
export function isCalendarTimestamp(value: string): boolean {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,9})?Z$/.exec(value);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
    && t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === se;
}

/**
 * A safe source-relative POSIX path, checked segment by segment (the schema pattern says the same; this is the
 * runtime check that does not depend on any regex dialect). A line break is a legal byte in a POSIX name and is
 * kept; what is refused is an empty, `.` or `..` segment, a leading or trailing slash, a backslash or a NUL.
 */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 4096 || path.includes('\\') || path.includes('\u0000')) return false;
  return path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

/** At most this many errors are reported; collection stops there rather than truncating afterwards. */
export const MAX_REPORTED_ERRORS = 100;

const LIMIT = Symbol('sentinel.contract.errorLimit');
class Bounded {
  readonly list: ContractError[] = [];
  full = false;
  add(e: ContractError): void {
    if (this.list.length >= MAX_REPORTED_ERRORS) { this.full = true; throw LIMIT; }
    this.list.push(e);
  }
}

function fail<T>(errors: ContractError[]): ValidationResult<T> {
  return { ok: false, errors };
}

/**
 * Validates one decoded value as an envelope of `kind`. Version mismatch is explicit: a known envelope at a
 * version this build does not read is `unsupportedVersion` with the supported list, and is never upgraded,
 * downgraded or partially read. Unknown fields are refused rather than dropped.
 */
export function validateEnvelope<K extends EnvelopeKind>(kind: K, value: unknown): ValidationResult<EnvelopeTypes[K]> {
  if (!Object.hasOwn(ENVELOPES, kind)) {
    return fail([{ code: 'sentinel.contract.unknownKind', path: '', message: 'not a Sentinel envelope kind' }]);
  }
  const expected: string = ENVELOPES[kind].schema;
  const field = versionField(kind);
  const declared = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[field] : undefined;
  if (typeof declared !== 'string') {
    return fail([{ code: 'sentinel.contract.missingVersion', path: `/${field}`, message: `missing ${field} version string`, supported: [expected] }]);
  }
  if (declared !== expected) {
    const m = VERSION.exec(declared);
    const sameKind = m?.[1] === expected.split('/')[0];
    return fail([{
      code: sameKind ? 'sentinel.contract.unsupportedVersion' : 'sentinel.contract.wrongKind',
      path: `/${field}`,
      message: sameKind ? 'this build does not read that version' : 'not this kind of envelope',
      supported: [expected],
    }]);
  }
  const check = validatorFor(kind);
  if (!check(value)) {
    return fail((check.errors ?? []).map(e => ({
      code: 'sentinel.contract.invalid' as const,
      path: e.instancePath,
      message: `${e.keyword}: ${e.message ?? 'invalid'}`,
    })));
  }
  const out = new Bounded();
  try {
    INVARIANTS[kind](value as never, out);
  } catch (e) {
    if (e !== LIMIT) throw e;
  }
  if (out.full) out.list.push({ code: 'sentinel.contract.errorLimit', path: '', message: `stopped after ${MAX_REPORTED_ERRORS} errors` });
  if (out.list.length) return fail(out.list);
  return { ok: true, value: value as EnvelopeTypes[K] };
}

/** Decodes and validates serialized JSON, refusing oversized input before parsing it. */
export function parseEnvelope<K extends EnvelopeKind>(kind: K, text: string): ValidationResult<EnvelopeTypes[K]> {
  if (Buffer.byteLength(text, 'utf8') > MAX_ENVELOPE_BYTES) {
    return fail([{ code: 'sentinel.contract.tooLarge', path: '', message: `larger than ${MAX_ENVELOPE_BYTES} bytes` }]);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail([{ code: 'sentinel.contract.malformedJson', path: '', message: 'not valid JSON' }]);
  }
  return validateEnvelope(kind, value);
}

// ---------------------------------------------------------------------------------------------------------------
// Invariants

type Check<T> = (value: T, out: Bounded) => void;
const err = (path: string, message: string): ContractError => ({ code: 'sentinel.contract.invariant', path, message });
const after = (a: string, b: string) => Date.parse(a) >= Date.parse(b);

function duplicates<T>(items: readonly T[], key: (item: T) => string): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  items.forEach((item, i) => { const k = key(item); if (seen.has(k)) out.push(i); else seen.add(k); });
  return out;
}

const pathError = (out: Bounded, at: string, path: string) => {
  if (!isSafeRelativePath(path)) out.add(err(at, 'not a safe source-relative path'));
};

const snapshot: Check<SnapshotEnvelope> = (v, out) => {
  v.entries.forEach((e, i) => pathError(out, `/entries/${i}/relativePath`, e.relativePath));
  v.frameworkVersions.forEach((f, i) => { if (f.state === 'resolved') pathError(out, `/frameworkVersions/${i}/provenance/relativePath`, f.provenance.relativePath); });
  const sources = new Set(v.sources.map(s => s.sourceId));
  for (const i of duplicates(v.sources, s => s.sourceId)) out.add(err(`/sources/${i}/sourceId`, 'duplicate source'));
  for (const i of duplicates(v.entries, e => `${e.sourceId}\u0000${e.relativePath}`)) out.add(err(`/entries/${i}`, 'duplicate entry for one source path'));
  v.entries.forEach((e, i) => { if (!sources.has(e.sourceId)) out.add(err(`/entries/${i}/sourceId`, 'entry names a source the snapshot does not capture')); });
  v.frameworkVersions.forEach((f, i) => {
    if (f.state === 'resolved' && !sources.has(f.provenance.sourceId)) out.add(err(`/frameworkVersions/${i}/provenance/sourceId`, 'provenance names an uncaptured source'));
  });
};

/** The exit code each policy result prints. 4 is reserved for awaiting confirmation before admission. */
export const POLICY_EXIT_CODES: Readonly<Record<PolicyResult, number>> = {
  'satisfied': 0,
  'finding-policy-failed': 1,
  'required-coverage-incomplete': 2,
  'configuration-failure': 3,
  'awaiting-confirmation': 4,
};

export interface PolicyFacts {
  configurationFailure: boolean;
  awaitingConfirmation: boolean;
  requiredCoverageIncomplete: boolean;
  findingPolicyFailed: boolean;
}

/**
 * Folds the recorded facts into one result: configuration failure (3), then coverage incomplete (2), then
 * findings (1), else satisfied (0). Awaiting confirmation (4) happens before admission, so no coverage or
 * finding fact can exist beside it; that combination is refused rather than ranked. Every fact stays in JSON.
 */
export function policyResultOf(facts: PolicyFacts): PolicyResult {
  if (facts.configurationFailure) return 'configuration-failure';
  if (facts.awaitingConfirmation) {
    if (facts.requiredCoverageIncomplete || facts.findingPolicyFailed) {
      throw new Error('sentinel.contract.invariant: awaiting confirmation precedes admission; no run facts can exist yet');
    }
    return 'awaiting-confirmation';
  }
  if (facts.requiredCoverageIncomplete) return 'required-coverage-incomplete';
  if (facts.findingPolicyFailed) return 'finding-policy-failed';
  return 'satisfied';
}

const run: Check<RunEnvelope> = (v, out) => {
  if (v.parentId === v.id) out.add(err('/parentId', 'a run cannot be its own parent'));
  if (v.baselineId === v.id) out.add(err('/baselineId', 'a run cannot be its own baseline'));
  if (v.state === 'completed' && !after(v.completedAt, v.createdAt)) out.add(err('/completedAt', 'completed before it was created'));
  if (v.policy && POLICY_EXIT_CODES[v.policy.result] !== v.policy.exitCode) out.add(err('/policy/exitCode', 'exit code does not match the policy result'));
  // Awaiting confirmation happens before admission: only a run that has not started can be waiting.
  if (v.policy?.result === 'awaiting-confirmation' && v.state !== 'planned') out.add(err('/policy/result', 'only a planned, unadmitted run can await confirmation'));
  if (v.policy) {
    const r = v.policy.result;
    // A run still in flight has no final policy result yet.
    if (['running', 'pausing', 'paused', 'canceling'].includes(v.state)) out.add(err('/policy', 'a run in progress has no final policy result'));
    // Before admission the only results are waiting for the owner or a configuration failure.
    if (v.state === 'planned' && r !== 'awaiting-confirmation' && r !== 'configuration-failure') out.add(err('/policy/result', 'a planned run has not run any check'));
    // A canceled run did not finish its required work, so it cannot satisfy the policy.
    if (v.state === 'canceled' && r === 'satisfied') out.add(err('/policy/result', 'a canceled run cannot satisfy the policy'));
    if (v.state === 'completed') {
      if (v.outcome === 'complete-coverage' && r === 'required-coverage-incomplete') out.add(err('/policy/result', 'complete coverage contradicts required coverage incomplete'));
      if (v.outcome === 'execution-failure' && (r === 'satisfied' || r === 'finding-policy-failed')) out.add(err('/policy/result', 'an execution failure leaves required coverage incomplete or a configuration failure'));
    }
  }
  if (v.budgets.maxCost !== null && !v.budgets.currency) out.add(err('/budgets/currency', 'a monetary budget needs its currency'));
  if (v.budgets.maxCost === null && v.budgets.currency) out.add(err('/budgets/currency', 'a currency without a monetary budget'));
};

const work: Check<WorkEnvelope> = (v, out) => {
  v.dependencies.forEach((d, i) => { if (d.id === v.id) out.add(err(`/dependencies/${i}`, 'work cannot depend on its own lineage')); });
  for (const i of duplicates(v.dependencies, d => `${d.id}#${d.revision}`)) out.add(err(`/dependencies/${i}`, 'duplicate dependency'));
  if (v.state === 'satisfied-by-reuse' && v.reuse.publication.id === v.id && v.reuse.publication.revision === v.revision) {
    out.add(err('/reuse/publication', 'reuse must point at an earlier publication, not itself'));
  }
};

const attempt: Check<AttemptEnvelope> = (v, out) => {
  if (v.state !== 'running' && !after(v.endedAt, v.startedAt)) out.add(err('/endedAt', 'ended before it started'));
  if (v.state === 'canceled-after-spend' && v.usage.certainty !== 'confirmed') out.add(err('/usage/certainty', 'canceled-after-spend requires confirmed usage; unknown usage is a separate fact'));
  const u = v.usage;
  if (u.certainty === 'not-applicable' && (u.inputTokens !== undefined || u.outputTokens !== undefined || u.monetaryCost !== undefined)) {
    out.add(err('/usage', 'not-applicable usage carries no amounts'));
  }
  if (u.monetaryCost !== undefined && !u.currency) out.add(err('/usage/currency', 'a cost needs its currency'));
};

const observation: Check<ObservationEnvelope> = (v, out) => {
  v.evidence.forEach((e, i) => {
    pathError(out, `/evidence/${i}/relativePath`, e.relativePath);
    if (e.span.endByte < e.span.startByte) out.add(err(`/evidence/${i}/span`, 'span ends before it starts'));
    if (e.snapshotId !== v.snapshotId) out.add(err(`/evidence/${i}/snapshotId`, 'evidence cites another snapshot'));
  });
};

const coverage: Check<CoverageEnvelope> = (v, out) => {
  if (v.status === 'complete' && v.skipped.length) out.add(err('/skipped', 'complete coverage cannot have skipped scope; it is partial'));
  if (v.status === 'complete' && v.basis.kind === 'unavailable') out.add(err('/basis', 'unavailable work cannot be complete coverage'));
  if (v.basis.kind === 'unavailable' && !['unsupported', 'not-run', 'error'].includes(v.status)) {
    out.add(err('/status', 'unavailable work is unsupported, not-run or error'));
  }
  if (v.basis.kind === 'reused' && v.basis.publication.id === v.workId && v.basis.publication.revision === v.workRevision) {
    out.add(err('/basis/publication', 'reuse points at an earlier publication, not this work revision'));
  }
};

const disposition: Check<DispositionEnvelope> = (v, out) => {
  if (v.supersedes === v.id) out.add(err('/supersedes', 'a decision cannot supersede itself'));
  if (v.expiresAt !== null && !(Date.parse(v.expiresAt) > Date.parse(v.createdAt))) out.add(err('/expiresAt', 'expires at or before creation'));
  if (v.decision === 'mitigated' && v.state === 'approved' && v.evidence.length === 0) {
    out.add(err('/evidence', 'an approved mitigation names the evidence it rests on; an assertion alone is not verification'));
  }
};

function countErrors(out: Bounded, path: string, c: ReportCount, expected?: number): void {
  if (c.of !== undefined && c.of < c.n) out.add(err(`${path}/of`, 'count exceeds its denominator'));
  if (c.breakdown && c.breakdown.reduce((s, p) => s + p.n, 0) !== c.n) out.add(err(`${path}/breakdown`, 'breakdown does not sum to the count'));
  if (expected !== undefined && c.n !== expected) out.add(err(`${path}/n`, 'count does not match the listed rows'));
}

function placeErrors(out: Bounded, path: string, p: FindingPlace): void {
  countErrors(out, `${path}/counts/screens`, p.counts.screens, new Set(p.screens.map(s => s.id)).size);
  countErrors(out, `${path}/counts/journeys`, p.counts.journeys, new Set(p.journeys.map(j => j.id)).size);
  countErrors(out, `${path}/counts/personas`, p.counts.personas, new Set(p.personas.map(s => s.id)).size);
  if (p.binding !== 'matched' && (p.screens.length || p.journeys.length || p.personas.length)) {
    out.add(err(`${path}/binding`, 'an unbound context cannot place on screens, journeys or personas'));
  }
  if (p.binding !== 'matched' && p.limitationKeys.length === 0) out.add(err(`${path}/limitationKeys`, 'an empty place says why'));
  if (p.binding === 'matched' && !p.context) out.add(err(`${path}/context`, 'a matched place names its pinned context'));
}

const report: Check<ReportEnvelope> = (v, out) => {
  countErrors(out, '/counts/findings', v.counts.findings, v.findings.length);
  countErrors(out, '/counts/coverageGaps', v.counts.coverageGaps, v.gaps.length);
  countErrors(out, '/counts/observations', v.counts.observations, new Set(v.findings.flatMap(f => f.observationIds)).size);
  countErrors(out, '/counts/plannedChecks', v.counts.plannedChecks);
  countErrors(out, '/counts/seenByNoStage', v.counts.seenByNoStage);
  countErrors(out, '/counts/unknownScopeBoundaries', v.counts.unknownScopeBoundaries);
  if (v.completeness === 'complete' && v.gaps.length) out.add(err('/completeness', 'a report with coverage gaps is partial'));
  for (const i of duplicates(v.findings, f => f.id)) out.add(err(`/findings/${i}/id`, 'duplicate finding'));
  const findings = new Set(v.findings.map(f => f.id));
  v.findings.forEach((f, i) => {
    placeErrors(out, `/findings/${i}/place`, f.place);
    for (const j of duplicates(f.evidence, e => e.id)) out.add(err(`/findings/${i}/evidence/${j}`, 'duplicate evidence'));
  });
  v.gaps.forEach((g, i) => placeErrors(out, `/gaps/${i}/place`, g.place));
  const at = Date.parse(v.evaluatedAt);
  v.decisions.forEach((d, i) => {
    if (!findings.has(d.findingId)) out.add(err(`/decisions/${i}/findingId`, 'decision about a finding the report does not contain'));
    // Validity is as of the report's pinned clock. Invalidation is the service's own finding and stays as recorded.
    const expired = d.expiresAt !== null && Date.parse(d.expiresAt) <= at;
    if (d.validity === 'valid' && expired) out.add(err(`/decisions/${i}/validity`, 'the decision had expired at the report time'));
    if (d.validity === 'expired' && !expired) out.add(err(`/decisions/${i}/validity`, 'the decision had not expired at the report time'));
  });
  for (const i of duplicates(v.artifactClosure, a => a)) out.add(err(`/artifactClosure/${i}`, 'duplicate artifact'));
  if (v.baseline?.reportId === v.id) out.add(err('/baseline', 'a report cannot be its own baseline'));
  if (v.baseline === null && v.findings.some(f => f.comparison !== undefined)) out.add(err('/findings', 'comparison labels need a baseline'));
};

const protocol: Check<ProtocolMessage> = (v, out) => {
  if (v.type === 'progress' && v.completed > v.planned) out.add(err('/completed', 'more completed than planned'));
  if (v.type === 'hello' && new Set(v.supported).size !== v.supported.length) out.add(err('/supported', 'duplicate version'));
};

const INVARIANTS: { [K in EnvelopeKind]: Check<EnvelopeTypes[K]> } = {
  snapshot, run, work, attempt, observation, coverage, disposition, report, protocol,
};

/**
 * The coordinator's answer to a worker hello: the one shared version, or an explicit refusal naming what
 * this build speaks. There is no fallback to a "close enough" version.
 */
export function negotiateProtocol(hello: HelloMessage): WelcomeMessage | RefuseMessage {
  const ours = ENVELOPES.protocol.schema;
  return hello.supported.includes(ours)
    ? { protocol: ours, type: 'welcome', selected: ours }
    : { protocol: ours, type: 'refuse', reasonCode: 'sentinel.protocol.noSharedVersion', supported: [ours] };
}
