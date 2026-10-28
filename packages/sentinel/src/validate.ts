// Runtime validation for the draft envelopes: an exact version check first (never coerced), then the
// generated JSON schema, then invariants a JSON schema cannot express (cross-field and cross-record rules).
import { Ajv, type ValidateFunction } from 'ajv';
import { MAX_PATH_REQUEST_BYTES } from './contracts/pathrequest.js';
import schemas from './schemas.generated.js';
import { ENVELOPES, MAX_ENVELOPE_BYTES, type EnvelopeKind } from './contracts/index.js';
import type {
  OwnerUiReceiptEnvelope,
  OwnerUiCapabilities,
  AttemptEnvelope,
  CoverageEnvelope,
  DispositionEnvelope,
  ObservationEnvelope,
  PolicyResult,
  ProtocolMessage,
  ReportCount,
  ReportEnvelope,
  RunEnvelope,
  SnapshotEnvelope,
  WorkEnvelope,
  FindingPlace,
  HelloMessage,
  WelcomeMessage,
  RefuseMessage,
  RulePackManifest,
  RuleLockEnvelope,
  SettingsEnvelope,
  RepoConfigEnvelope,
  EffectivePolicyEnvelope,
  AdoptionEnvelope,
  ReceiptEnvelope,
  AdmissionEnvelope,
  ControlFactsEnvelope,
  Rights,
  Budget,
  PlanEnvelope,
  PathEvidenceEnvelope,
  DeepImportEnvelope,
  ServiceCapabilities,
  RunInspection,
  InspectionPage,
  ReportDelivery,
  DeliveryChunk,
  ControlCapabilities,
  ControlOutcome,
  ImportViewEnvelope,
  ImportPageEnvelope,
  OwnerDecisionInput,
  DecisionViewEnvelope,
  DecisionPageEnvelope,
  PathRequestEnvelope,
  PreparationCapabilities,
  ConfigurationPreview,
  PreparationStatus,
  PreparationOutcome,
  ReviewPartitionsEnvelope,
  ReviewCheckpointEnvelope,
  ReviewRecordEnvelope,
  ReviewInstructionsEnvelope,
  ReviewRequestEnvelope,
  PipelineDefinition,
  PipelineAdoptionEnvelope,
} from './contracts/index.js';
import { digestOf } from './store/ledger-json.js';
import { bootstrapUnitIdOf, checkIdOf, checkUnitIdOf, reviewUnitIdOf, scriptUnitIdOf } from './planner/identity.js';
import { OWNER_ACTIONS } from './contracts/index.js';

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
  rulepack: RulePackManifest;
  rulelock: RuleLockEnvelope;
  settings: SettingsEnvelope;
  repoconfig: RepoConfigEnvelope;
  policy: EffectivePolicyEnvelope;
  adoption: AdoptionEnvelope;
  receipt: ReceiptEnvelope;
  owneruireceipt: OwnerUiReceiptEnvelope;
  owneruicapabilities: OwnerUiCapabilities;
  admission: AdmissionEnvelope;
  controls: ControlFactsEnvelope;
  plan: PlanEnvelope;
  paths: PathEvidenceEnvelope;
  pathrequest: PathRequestEnvelope;
  deepimport: DeepImportEnvelope;
  servicecapabilities: ServiceCapabilities;
  runinspection: RunInspection;
  inspectionpage: InspectionPage;
  reportdelivery: ReportDelivery;
  deliverychunk: DeliveryChunk;
  controlcapabilities: ControlCapabilities;
  controloutcome: ControlOutcome;
  preparationcapabilities: PreparationCapabilities;
  configurationpreview: ConfigurationPreview;
  preparationstatus: PreparationStatus;
  preparationoutcome: PreparationOutcome;

  decisioninput: OwnerDecisionInput;
  decisionview: DecisionViewEnvelope;
  decisionpage: DecisionPageEnvelope;
  importview: ImportViewEnvelope;
  importpage: ImportPageEnvelope;
  partitions: ReviewPartitionsEnvelope;
  checkpoint: ReviewCheckpointEnvelope;
  review: ReviewRecordEnvelope;
  instructions: ReviewInstructionsEnvelope;
  reviewrequest: ReviewRequestEnvelope;
  // The declared pipeline (contracts/pipeline.ts). Its cross-stage checks are app/pipeline.ts's checkPipeline.
  pipeline: PipelineDefinition;
  pipelineadoption: PipelineAdoptionEnvelope;
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

const VERSION = /^(sentinel-[a-z]+(?:-[a-z]+)*)\/(draft-[1-9][0-9]*|v[1-9][0-9]*)$/;
const versionField = (kind: EnvelopeKind) => (kind === 'protocol' ? 'protocol' : 'schema');

let ajv: Ajv | undefined;
const compiled = new Map<EnvelopeKind, ValidateFunction>();
function validatorFor(kind: EnvelopeKind): ValidateFunction {
  let fn = compiled.get(kind);
  if (!fn) {
    // allErrors: false bounds the work and the error list at the source: Ajv stops at the first failure
    // instead of materialising one error per bad element of a large array.
    ajv ??= new Ajv({ allErrors: false, strict: true, allowUnionTypes: true }).addFormat('date-time', {
      type: 'string',
      validate: isCalendarTimestamp,
    });
    fn = ajv.compile((schemas as Record<EnvelopeKind, object>)[kind]);
    compiled.set(kind, fn);
  }
  return fn;
}

/** The published JSON schema for one envelope kind. */
export function schemaOf(kind: EnvelopeKind): object {
  return (schemas as Record<EnvelopeKind, object>)[kind];
}

const TIMESTAMP = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?Z$/;

/**
 * A real UTC calendar instant: the schema pattern bounds each field, this refuses a day the month does not have.
 * Years are proleptic Gregorian ISO 8601 years 0000–9999 (0000 is a leap year), computed by rule rather than
 * through `Date.UTC`, which would read years 0–99 as 1900–1999. Leap seconds are refused.
 */
export function isCalendarTimestamp(value: string): boolean {
  const m = TIMESTAMP.exec(value);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= days;
}

/**
 * Orders two schema-valid timestamps at their full nanosecond precision: -1, 0 or 1. Every field is fixed width,
 * so padding the fraction to nine digits makes the strings compare in time order. `Date.parse` is never used:
 * it truncates to milliseconds.
 */
export function compareTimestamps(a: string, b: string): -1 | 0 | 1 {
  const key = (t: string) => {
    const m = TIMESTAMP.exec(t);
    if (!m) throw new Error('sentinel.contract.invalid: not a Sentinel timestamp');
    return `${t.slice(0, 19)}.${(m[7] ?? '').padEnd(9, '0')}`;
  };
  const x = key(a);
  const y = key(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * A safe source-relative POSIX path, checked segment by segment (the schema pattern says the same; this is the
 * runtime check that does not depend on any regex dialect). A line break is a legal byte in a POSIX name and is
 * kept; what is refused is an empty, `.` or `..` segment, a leading or trailing slash, a backslash or a NUL.
 */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 4096 || path.includes('\\') || path.includes('\u0000')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** At most this many errors are reported; collection stops there rather than truncating afterwards. */
export const MAX_REPORTED_ERRORS = 100;

const LIMIT = Symbol('sentinel.contract.errorLimit');
class Bounded {
  readonly list: ContractError[] = [];
  full = false;
  add(e: ContractError): void {
    if (this.list.length >= MAX_REPORTED_ERRORS) {
      this.full = true;
      throw LIMIT;
    }
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
  const declared =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)[field]
      : undefined;
  if (typeof declared !== 'string') {
    return fail([
      {
        code: 'sentinel.contract.missingVersion',
        path: `/${field}`,
        message: `missing ${field} version string`,
        supported: [expected],
      },
    ]);
  }
  if (declared !== expected) {
    const m = VERSION.exec(declared);
    const sameKind = m?.[1] === expected.split('/')[0];
    return fail([
      {
        code: sameKind ? 'sentinel.contract.unsupportedVersion' : 'sentinel.contract.wrongKind',
        path: `/${field}`,
        message: sameKind ? 'this build does not read that version' : 'not this kind of envelope',
        supported: [expected],
      },
    ]);
  }
  const check = validatorFor(kind);
  if (!check(value)) {
    return fail(
      (check.errors ?? []).map((e) => ({
        code: 'sentinel.contract.invalid' as const,
        path: e.instancePath,
        message: `${e.keyword}: ${e.message ?? 'invalid'}`,
      })),
    );
  }
  const out = new Bounded();
  try {
    INVARIANTS[kind](value as never, out);
  } catch (e) {
    if (e !== LIMIT) throw e;
  }
  if (out.full)
    out.list.push({
      code: 'sentinel.contract.errorLimit',
      path: '',
      message: `stopped after ${MAX_REPORTED_ERRORS} errors`,
    });
  if (out.list.length) return fail(out.list);
  return { ok: true, value: value as EnvelopeTypes[K] };
}

/** Decodes and validates serialized JSON, refusing oversized input before parsing it. */
export function parseEnvelope<K extends EnvelopeKind>(kind: K, text: string): ValidationResult<EnvelopeTypes[K]> {
  const maxBytes = kind === 'pathrequest' ? MAX_PATH_REQUEST_BYTES : MAX_ENVELOPE_BYTES;
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return fail([{ code: 'sentinel.contract.tooLarge', path: '', message: `larger than ${maxBytes} bytes` }]);
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
const after = (a: string, b: string) => compareTimestamps(a, b) >= 0;

function duplicates<T>(items: readonly T[], key: (item: T) => string): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  items.forEach((item, i) => {
    const k = key(item);
    if (seen.has(k)) out.push(i);
    else seen.add(k);
  });
  return out;
}

const pathError = (out: Bounded, at: string, path: string) => {
  if (!isSafeRelativePath(path)) out.add(err(at, 'not a safe source-relative path'));
};

const snapshot: Check<SnapshotEnvelope> = (v, out) => {
  v.entries.forEach((e, i) => pathError(out, `/entries/${i}/relativePath`, e.relativePath));
  v.frameworkVersions.forEach((f, i) => {
    if (f.state === 'resolved')
      pathError(out, `/frameworkVersions/${i}/provenance/relativePath`, f.provenance.relativePath);
  });
  const sources = new Set(v.sources.map((s) => s.sourceId));
  for (const i of duplicates(v.sources, (s) => s.sourceId)) out.add(err(`/sources/${i}/sourceId`, 'duplicate source'));
  for (const i of duplicates(v.entries, (e) => `${e.sourceId}\u0000${e.relativePath}`))
    out.add(err(`/entries/${i}`, 'duplicate entry for one source path'));
  v.entries.forEach((e, i) => {
    if (!sources.has(e.sourceId))
      out.add(err(`/entries/${i}/sourceId`, 'entry names a source the snapshot does not capture'));
  });
  v.frameworkVersions.forEach((f, i) => {
    if (f.state === 'resolved' && !sources.has(f.provenance.sourceId))
      out.add(err(`/frameworkVersions/${i}/provenance/sourceId`, 'provenance names an uncaptured source'));
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
      throw new Error(
        'sentinel.contract.invariant: awaiting confirmation precedes admission; no run facts can exist yet',
      );
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
  if (v.state === 'completed' && !after(v.completedAt, v.createdAt))
    out.add(err('/completedAt', 'completed before it was created'));
  if (v.policy && POLICY_EXIT_CODES[v.policy.result] !== v.policy.exitCode)
    out.add(err('/policy/exitCode', 'exit code does not match the policy result'));
  // Awaiting confirmation happens before admission: only a run that has not started can be waiting.
  if (v.policy?.result === 'awaiting-confirmation' && v.state !== 'planned')
    out.add(err('/policy/result', 'only a planned, unadmitted run can await confirmation'));
  if (v.policy) {
    const r = v.policy.result;
    // A run still in flight has no final policy result yet.
    if (['running', 'pausing', 'paused', 'canceling'].includes(v.state))
      out.add(err('/policy', 'a run in progress has no final policy result'));
    // Before admission the only results are waiting for the owner or a configuration failure.
    if (v.state === 'planned' && r !== 'awaiting-confirmation' && r !== 'configuration-failure')
      out.add(err('/policy/result', 'a planned run has not run any check'));
    // A canceled run did not finish its required work, so it cannot satisfy the policy.
    if (v.state === 'canceled' && r === 'satisfied')
      out.add(err('/policy/result', 'a canceled run cannot satisfy the policy'));
    if (v.state === 'completed') {
      if (v.outcome === 'complete-coverage' && r === 'required-coverage-incomplete')
        out.add(err('/policy/result', 'complete coverage contradicts required coverage incomplete'));
      if (v.outcome === 'execution-failure' && (r === 'satisfied' || r === 'finding-policy-failed'))
        out.add(
          err('/policy/result', 'an execution failure leaves required coverage incomplete or a configuration failure'),
        );
    }
  }
  if (v.budgets.maxCost !== null && !v.budgets.currency)
    out.add(err('/budgets/currency', 'a monetary budget needs its currency'));
  if (v.budgets.maxCost === null && v.budgets.currency)
    out.add(err('/budgets/currency', 'a currency without a monetary budget'));
};

const work: Check<WorkEnvelope> = (v, out) => {
  v.dependencies.forEach((d, i) => {
    if (d.id === v.id) out.add(err(`/dependencies/${i}`, 'work cannot depend on its own lineage'));
  });
  for (const i of duplicates(v.dependencies, (d) => `${d.id}#${d.revision}`))
    out.add(err(`/dependencies/${i}`, 'duplicate dependency'));
  if (
    v.state === 'satisfied-by-reuse' &&
    v.reuse.publication.id === v.id &&
    v.reuse.publication.revision === v.revision
  ) {
    out.add(err('/reuse/publication', 'reuse must point at an earlier publication, not itself'));
  }
};

const attempt: Check<AttemptEnvelope> = (v, out) => {
  if (v.state !== 'running' && !after(v.endedAt, v.startedAt)) out.add(err('/endedAt', 'ended before it started'));
  if (v.state === 'canceled-after-spend' && v.usage.certainty !== 'confirmed')
    out.add(err('/usage/certainty', 'canceled-after-spend requires confirmed usage; unknown usage is a separate fact'));
  const u = v.usage;
  if (
    u.certainty === 'not-applicable' &&
    (u.inputTokens !== undefined || u.outputTokens !== undefined || u.monetaryCost !== undefined)
  ) {
    out.add(err('/usage', 'not-applicable usage carries no amounts'));
  }
  if (u.monetaryCost !== undefined && !u.currency) out.add(err('/usage/currency', 'a cost needs its currency'));
};

const observation: Check<ObservationEnvelope> = (v, out) => {
  v.evidence.forEach((e, i) => {
    // A withheld location carries no path to check; an ordinary citation's path is checked as everywhere.
    if (!('location' in e)) pathError(out, `/evidence/${i}/relativePath`, e.relativePath);
    if (e.span.endByte < e.span.startByte) out.add(err(`/evidence/${i}/span`, 'span ends before it starts'));
    if (e.snapshotId !== v.snapshotId) out.add(err(`/evidence/${i}/snapshotId`, 'evidence cites another snapshot'));
  });
};

const coverage: Check<CoverageEnvelope> = (v, out) => {
  if (v.status === 'complete' && v.skipped.length)
    out.add(err('/skipped', 'complete coverage cannot have skipped scope; it is partial'));
  if (v.status === 'complete' && v.basis.kind === 'unavailable')
    out.add(err('/basis', 'unavailable work cannot be complete coverage'));
  if (v.basis.kind === 'unavailable' && !['unsupported', 'not-run', 'error'].includes(v.status)) {
    out.add(err('/status', 'unavailable work is unsupported, not-run or error'));
  }
  if (
    v.basis.kind === 'reused' &&
    v.basis.publication.id === v.workId &&
    v.basis.publication.revision === v.workRevision
  ) {
    out.add(err('/basis/publication', 'reuse points at an earlier publication, not this work revision'));
  }
};

const disposition: Check<DispositionEnvelope> = (v, out) => {
  if (v.supersedes === v.id) out.add(err('/supersedes', 'a decision cannot supersede itself'));
  if (v.expiresAt !== null && compareTimestamps(v.expiresAt, v.createdAt) <= 0)
    out.add(err('/expiresAt', 'expires at or before creation'));
  if (v.decision === 'mitigated' && v.state === 'approved' && v.evidence.length === 0) {
    out.add(
      err('/evidence', 'an approved mitigation names the evidence it rests on; an assertion alone is not verification'),
    );
  }
};

function countErrors(out: Bounded, path: string, c: ReportCount, expected?: number): void {
  if (c.of !== undefined && c.of < c.n) out.add(err(`${path}/of`, 'count exceeds its denominator'));
  if (c.breakdown && c.breakdown.reduce((s, p) => s + p.n, 0) !== c.n)
    out.add(err(`${path}/breakdown`, 'breakdown does not sum to the count'));
  if (expected !== undefined && c.n !== expected) out.add(err(`${path}/n`, 'count does not match the listed rows'));
}

function placeErrors(out: Bounded, path: string, p: FindingPlace): void {
  countErrors(out, `${path}/counts/screens`, p.counts.screens, new Set(p.screens.map((s) => s.id)).size);
  countErrors(out, `${path}/counts/journeys`, p.counts.journeys, new Set(p.journeys.map((j) => j.id)).size);
  countErrors(out, `${path}/counts/personas`, p.counts.personas, new Set(p.personas.map((s) => s.id)).size);
  if (p.binding !== 'matched' && (p.screens.length || p.journeys.length || p.personas.length)) {
    out.add(err(`${path}/binding`, 'an unbound context cannot place on screens, journeys or personas'));
  }
  if (p.binding !== 'matched' && p.limitationKeys.length === 0)
    out.add(err(`${path}/limitationKeys`, 'an empty place says why'));
  if (p.binding === 'matched' && !p.context)
    out.add(err(`${path}/context`, 'a matched place names its pinned context'));
}

const report: Check<ReportEnvelope> = (v, out) => {
  countErrors(out, '/counts/findings', v.counts.findings, v.findings.length);
  countErrors(out, '/counts/coverageGaps', v.counts.coverageGaps, v.gaps.length);
  countErrors(
    out,
    '/counts/observations',
    v.counts.observations,
    new Set(v.findings.flatMap((f) => f.observationIds)).size,
  );
  countErrors(out, '/counts/plannedChecks', v.counts.plannedChecks);
  countErrors(out, '/counts/seenByNoStage', v.counts.seenByNoStage);
  countErrors(out, '/counts/unknownScopeBoundaries', v.counts.unknownScopeBoundaries);
  const pathQueries = (v.structuralPaths ?? []).flatMap((p) => p.evidence.results);
  if (pathQueries.length && !v.counts.pathQueries)
    out.add(err('/counts/pathQueries', 'structural queries are counted separately'));
  if (v.counts.pathQueries) {
    countErrors(out, '/counts/pathQueries', v.counts.pathQueries, pathQueries.length);
    const parts = [
      ['sentinel.paths.count.reached', 'reached'],
      ['sentinel.paths.count.notReachedComplete', 'not-reached-complete'],
      ['sentinel.paths.count.notReachedBounded', 'not-reached-bounded'],
    ] as const;
    const breakdown = v.counts.pathQueries.breakdown ?? [];
    if (
      breakdown.length !== parts.length ||
      parts.some(
        ([key, outcome]) =>
          breakdown.filter((p) => p.key === key && p.n === pathQueries.filter((q) => q.outcome === outcome).length)
            .length !== 1,
      )
    )
      out.add(err('/counts/pathQueries/breakdown', 'structural outcome parts match the reported queries'));
  }
  if (v.completeness === 'complete' && v.gaps.length)
    out.add(err('/completeness', 'a report with coverage gaps is partial'));
  if (v.completeness === 'complete' && (v.counts.seenByNoStage.n > 0 || v.counts.unknownScopeBoundaries.n > 0))
    out.add(err('/completeness', 'a report with unread files or unlisted folders is partial'));
  for (const i of duplicates(v.findings, (f) => f.id)) out.add(err(`/findings/${i}/id`, 'duplicate finding'));
  const findings = new Set(v.findings.map((f) => f.id));
  v.findings.forEach((f, i) => {
    placeErrors(out, `/findings/${i}/place`, f.place);
    for (const j of duplicates(f.evidence, (e) => e.id))
      out.add(err(`/findings/${i}/evidence/${j}`, 'duplicate evidence'));
  });
  v.gaps.forEach((g, i) => placeErrors(out, `/gaps/${i}/place`, g.place));
  if (v.decisionEvaluation) {
    const section = v.decisionEvaluation,
      allowed =
        section.status === 'complete'
          ? ['sentinel.decision.section.complete']
          : section.status === 'unavailable'
            ? ['sentinel.decision.section.unavailable']
            : ['sentinel.decision.section.partial', 'sentinel.decision.section.limit'];
    if (!allowed.includes(section.reasonCode))
      out.add(err('/decisionEvaluation/reasonCode', 'decision availability and reason disagree'));
    if (section.status === 'unavailable' && v.decisions.some((d) => d.evaluator === 'sentinel-decision-evaluation/2'))
      out.add(err('/decisions', 'unavailable source decisions cannot carry decision credit'));
  }
  v.decisions.forEach((d, i) => {
    if (!findings.has(d.findingId))
      out.add(err(`/decisions/${i}/findingId`, 'decision about a finding the report does not contain'));
    // Validity is as of the report's pinned clock. Invalidation is the service's own finding and stays as recorded.
    const expired = d.expiresAt !== null && compareTimestamps(d.expiresAt, v.evaluatedAt) <= 0;
    if (d.evaluator === 'sentinel-decision-evaluation/2' && d.state !== 'open' && d.validity !== 'valid')
      out.add(err(`/decisions/${i}/state`, 'only a valid source decision changes state'));
    if (d.validity === 'valid' && expired)
      out.add(err(`/decisions/${i}/validity`, 'the decision had expired at the report time'));
    if (d.validity === 'expired' && !expired)
      out.add(err(`/decisions/${i}/validity`, 'the decision had not expired at the report time'));
  });
  for (const i of duplicates(v.artifactClosure, (a) => a)) out.add(err(`/artifactClosure/${i}`, 'duplicate artifact'));
  if (v.baseline?.reportId === v.id) out.add(err('/baseline', 'a report cannot be its own baseline'));
  if (v.baseline === null && v.findings.some((f) => f.comparison !== undefined))
    out.add(err('/findings', 'comparison labels need a baseline'));
  const historical = v.historical ?? [];
  if (v.baseline === null && historical.length) out.add(err('/historical', 'historical findings need a baseline'));
  if (historical.length && !v.counts.historical) out.add(err('/counts/historical', 'historical findings are counted'));
  if (v.counts.historical) countErrors(out, '/counts/historical', v.counts.historical, historical.length);
  for (const i of duplicates(historical, (h) => h.baselineFindingId))
    out.add(err(`/historical/${i}`, 'each baseline finding is listed once'));
  historical.forEach((h, i) => placeErrors(out, `/historical/${i}/place`, h.place));
  v.findings.forEach((f, i) => {
    if (f.match && !f.comparison) out.add(err(`/findings/${i}/match`, 'a match is part of a comparison'));
    // Only an exact pairing may say an issue persists unchanged.
    if (f.comparison === 'persistent' && f.match && f.match.kind !== 'exact')
      out.add(err(`/findings/${i}/comparison`, 'persistent needs an exact match'));
    for (const e of f.evidence)
      if (e.location) {
        pathError(out, `/findings/${i}/evidence/location`, e.location.relativePath);
        if (e.location.startByte >= e.location.endByte || e.location.startLine > e.location.endLine)
          out.add(err(`/findings/${i}/evidence`, 'a location is a non-empty span'));
      }
  });
  for (const i of duplicates(v.definitions ?? [], (d) => d.key))
    out.add(err(`/definitions/${i}`, 'each word is defined once'));
};

const protocol: Check<ProtocolMessage> = (v, out) => {
  if (v.type === 'progress' && v.completed > v.planned) out.add(err('/completed', 'more completed than planned'));
  if (v.type === 'hello' && new Set(v.supported).size !== v.supported.length)
    out.add(err('/supported', 'duplicate version'));
};

const rightsErrors = (out: Bounded, at: string, r: Rights) => {
  if (r.origin === 'third-party' && !r.upstream)
    out.add(err(`${at}/upstream`, 'third-party content names its upstream'));
  if (r.origin === 'sentinel-original' && r.upstream)
    out.add(err(`${at}/upstream`, 'original content has no upstream'));
  if (r.licenseFile !== undefined) pathError(out, `${at}/licenseFile`, r.licenseFile);
};

const budgetErrors = (out: Bounded, at: string, b: Budget) => {
  if (b.maxCost !== null && !b.currency) out.add(err(`${at}/currency`, 'a monetary budget needs its currency'));
  if (b.maxCost === null && b.currency) out.add(err(`${at}/currency`, 'a currency without a monetary budget'));
};

const rulepack: Check<RulePackManifest> = (v, out) => {
  rightsErrors(out, '/rights', v.rights);
  for (const i of duplicates(v.rules, (r) => r.familyId))
    out.add(err(`/rules/${i}/familyId`, 'a pack defines each rule family once'));
  v.rules.forEach((r, i) => {
    pathError(out, `/rules/${i}/implementation/rulePath`, r.implementation.rulePath);
    r.fixtures.positive.forEach((f, j) => pathError(out, `/rules/${i}/fixtures/positive/${j}`, f));
    r.fixtures.negative.forEach((f, j) => pathError(out, `/rules/${i}/fixtures/negative/${j}`, f));
    const positive = new Set(r.fixtures.positive);
    r.fixtures.negative.forEach((f, j) => {
      if (positive.has(f))
        out.add(err(`/rules/${i}/fixtures/negative/${j}`, 'a fixture cannot be both positive and negative'));
    });
    for (const j of duplicates(r.requires, (c) => c)) out.add(err(`/rules/${i}/requires/${j}`, 'duplicate capability'));
  });
};

const rulelock: Check<RuleLockEnvelope> = (v, out) => {
  if ((v.revision === 1) !== (v.previous === null))
    out.add(err('/previous', 'only the first lock revision has no predecessor'));
  for (const i of duplicates(v.packs, (p) => p.packId))
    out.add(err(`/packs/${i}/packId`, 'a lock pins each pack once'));
  for (const i of duplicates(
    v.packs.flatMap((p) => p.rules),
    (r) => r.familyId,
  ))
    out.add(err('/packs', `a rule family is locked once (entry ${i})`));
  v.packs.forEach((p, i) => {
    rightsErrors(out, `/packs/${i}/rights`, p.rights);
    p.files.forEach((f, j) => pathError(out, `/packs/${i}/files/${j}/path`, f.path));
    for (const j of duplicates(p.files, (f) => f.path)) out.add(err(`/packs/${i}/files/${j}`, 'duplicate file'));
  });
  for (const i of duplicates(v.tools, (t) => `${t.adapterId}\u0000${t.platform}`))
    out.add(err(`/tools/${i}`, 'a lock pins one tool per adapter and platform'));
  v.tools.forEach((t, i) => rightsErrors(out, `/tools/${i}/rights`, t.rights));
  for (const i of duplicates(v.databases, (d) => d.databaseId))
    out.add(err(`/databases/${i}/databaseId`, 'duplicate database'));
  v.databases.forEach((d, i) => rightsErrors(out, `/databases/${i}/rights`, d.rights));
};

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?$/;
const OWNER: ReadonlySet<string> = new Set(OWNER_ACTIONS);

const settings: Check<SettingsEnvelope> = (v, out) => {
  for (const i of duplicates(v.mandatoryRules, (r) => r)) out.add(err(`/mandatoryRules/${i}`, 'duplicate rule'));
  for (const i of duplicates(v.providers, (p) => p.id)) out.add(err(`/providers/${i}/id`, 'duplicate provider'));
  const providers = new Set(v.providers.map((p) => p.id));
  v.providers.forEach((p, i) => {
    if (p.endpoint.startsWith('http:') && !LOOPBACK.test(p.endpoint))
      out.add(err(`/providers/${i}/endpoint`, 'plain http is accepted only on the loopback interface'));
    budgetErrors(out, `/providers/${i}/budget`, p.budget);
    const models = p.models ?? [];
    for (const j of duplicates(models, (m) => m.id)) out.add(err(`/providers/${i}/models/${j}/id`, 'duplicate model'));
    models.forEach((m, j) => {
      const at = `/providers/${i}/models/${j}`;
      if (m.limits.maxOutputTokens >= m.limits.contextTokens)
        out.add(err(`${at}/limits/maxOutputTokens`, 'the output allowance must leave room for input in the context'));
      if (m.pricing.kind === 'no-fee' && p.disclosure !== 'local-only')
        out.add(err(`${at}/pricing`, 'only a local-only provider may declare no fee'));
      if (m.pricing.kind === 'rates' && m.pricing.currency !== p.budget.currency)
        out.add(err(`${at}/pricing/currency`, 'the rate currency must be the provider budget\u2019s'));
      if (p.disclosure === 'hosted' && m.terms === null)
        out.add(err(`${at}/terms`, 'a hosted provider\u2019s model needs its recorded terms'));
      const c = m.capability;
      if (c && (c.kind !== p.kind || c.origin !== p.endpoint || c.model !== m.model))
        out.add(err(`${at}/capability`, 'the capability record is for another kind, origin or model'));
    });
  });
  v.grants.forEach((g, i) => {
    if ((g.principals ?? ['human']).includes('agent') && g.actions.some((a) => OWNER.has(a))) {
      out.add(err(`/grants/${i}`, 'an owner action cannot be granted to an agent'));
    }
    g.scope?.providers?.forEach((p, j) => {
      if (!providers.has(p))
        out.add(err(`/grants/${i}/scope/providers/${j}`, 'the grant names a provider the settings do not define'));
    });
  });
};

const repoconfig: Check<RepoConfigEnvelope> = (v, out) => {
  for (const i of duplicates(v.requestedRules, (r) => r)) out.add(err(`/requestedRules/${i}`, 'duplicate rule'));
  for (const i of duplicates(v.disabledRules, (r) => r)) out.add(err(`/disabledRules/${i}`, 'duplicate rule'));
};

const policy: Check<EffectivePolicyEnvelope> = (v, out) => {
  for (const i of duplicates(v.rules, (r) => r.familyId)) out.add(err(`/rules/${i}`, 'duplicate rule'));
  if ((v.settingsTrust === 'adopted') !== (v.settingsDigest !== null))
    out.add(err('/settingsDigest', 'only adopted settings have a digest in effect'));
};

const adoption: Check<AdoptionEnvelope> = (v, out) => {
  if (!v.workspacePath.startsWith('/')) out.add(err('/workspacePath', 'the workspace path is absolute'));
};

/** The longest a receipt may live: a confirmation is for this action, now. */
export const MAX_RECEIPT_TTL_MS = 60 * 60 * 1000;

/** Nanoseconds since the epoch of a schema-valid timestamp, exact (whole seconds through Date.UTC, years ≥ 1970 only matter here). */
function nanos(t: string): bigint {
  const m = TIMESTAMP.exec(t)!;
  const seconds = BigInt(Date.parse(`${t.slice(0, 19)}Z`)) / 1000n;
  return seconds * 1_000_000_000n + BigInt((m[7] ?? '').padEnd(9, '0'));
}

const receipt: Check<Pick<ReceiptEnvelope, 'issuedAt' | 'expiresAt'>> = (v, out) => {
  if (compareTimestamps(v.expiresAt, v.issuedAt) <= 0) out.add(err('/expiresAt', 'expires at or before issue'));
  else if (nanos(v.expiresAt) - nanos(v.issuedAt) > BigInt(MAX_RECEIPT_TTL_MS) * 1_000_000n)
    out.add(err('/expiresAt', 'a receipt lives at most one hour'));
};

const admission: Check<AdmissionEnvelope> = (v, out) => {
  const { policy: p, capability: c, credential: k } = v.verdicts;
  for (const [name, x] of [
    ['policy', p],
    ['capability', c],
    ['credential', k],
  ] as const) {
    if (!x.asked && x.allowed) out.add(err(`/verdicts/${name}`, 'a verdict that was not asked cannot allow'));
  }
  if (!p.asked) out.add(err('/verdicts/policy/asked', 'policy is always asked first'));
  if (!p.allowed && (c.asked || k.asked)) out.add(err('/verdicts', 'nothing is asked after the policy denies'));
  if ((k.basis === 'not-asked') !== !k.asked)
    out.add(err('/verdicts/credential/basis', 'basis not-asked exactly when the credential was not asked'));
  if (k.basis === 'unknown' && k.allowed) out.add(err('/verdicts/credential', 'an unknown credential scope denies'));
  const all = p.allowed && c.allowed && k.allowed;
  if (v.outcome === 'denied' && all) out.add(err('/outcome', 'all three verdicts allowed'));
  if (v.outcome !== 'denied' && !all) out.add(err('/outcome', 'admission needs all three verdicts'));
  if (v.outcome === 'admitted' && OWNER.has(v.action) && v.receipt === null)
    out.add(err('/receipt', 'an owner action is admitted only with a receipt'));
  if (v.outcome !== 'admitted' && v.receipt !== null)
    out.add(err('/receipt', 'only an admitted action uses a receipt'));
  if (OWNER.has(v.action) && v.requestedBy.principal === 'agent' && p.allowed)
    out.add(err('/verdicts/policy', 'an agent is never allowed an owner action'));
};

const controls: Check<ControlFactsEnvelope> = (v, out) => {
  for (const i of duplicates(v.facts, (f) => f.id)) out.add(err(`/facts/${i}/id`, 'duplicate fact'));
  for (const i of duplicates(v.facts, (f) => `${f.surfaceId}\u0000${f.property}\u0000${f.order}`))
    out.add(err(`/facts/${i}`, 'one fact per surface, property and position'));
  v.facts.forEach((f, i) => {
    if (f.verdict === 'unknown') {
      if (!f.reasonCode) out.add(err(`/facts/${i}/reasonCode`, 'an unknown verdict says why'));
    } else {
      if (f.evidence.length === 0)
        out.add(err(`/facts/${i}/evidence`, 'a resolved verdict names the evidence that establishes it'));
      if (v.framework.version === null)
        out.add(err(`/facts/${i}/verdict`, 'an unresolved framework version leaves every fact unknown'));
      if (f.reasonCode) out.add(err(`/facts/${i}/reasonCode`, 'only an unknown verdict carries a reason'));
    }
    f.evidence.forEach((e, j) => {
      pathError(out, `/facts/${i}/evidence/${j}/relativePath`, e.relativePath);
      if (e.span.endByte < e.span.startByte)
        out.add(err(`/facts/${i}/evidence/${j}/span`, 'span ends before it starts'));
      if (e.snapshotId !== v.snapshotId)
        out.add(err(`/facts/${i}/evidence/${j}/snapshotId`, 'evidence cites another snapshot'));
    });
  });
};

const BOOTSTRAP_STAGES: ReadonlySet<string> = new Set(['capture', 'parse', 'inventory']);

/**
 * A plan revision is internally consistent: checks and work agree exactly (no unplanned check is covered, no planned
 * check is uncovered or covered twice), the work graph is acyclic over the plan and the work it reuses, the tallies
 * recount, and the digest is the canonical digest of everything else, so any edit after sealing is refused.
 */
const plan: Check<PlanEnvelope> = (v, out) => {
  if ((v.revision === 1) !== (v.previous === null))
    out.add(err('/previous', "only a run's first revision has no predecessor"));
  const analysis = v.kind === 'analysis';
  if (!analysis && v.pins.pathRequest !== undefined)
    out.add(err('/pins/pathRequest', 'a bootstrap revision pins no structural request'));
  for (const field of ['snapshotId', 'inventoryDigest', 'environment', 'ruleLockDigest', 'policyDigest'] as const) {
    if ((v.pins[field] === null) === analysis)
      out.add(
        err(
          `/pins/${field}`,
          analysis ? 'an analysis revision pins it' : 'a bootstrap revision has nothing to pin here',
        ),
      );
  }
  if (!analysis && (v.checks.length || v.ruleGaps.length || v.pins.rules.length))
    out.add(err('/checks', 'a bootstrap revision plans no checks'));
  for (let i = 1; i < v.checks.length; i++)
    if (v.checks[i]!.id <= v.checks[i - 1]!.id) out.add(err(`/checks/${i}/id`, 'checks are sorted by id, each once'));
  for (let i = 1; i < v.units.length; i++)
    if (v.units[i]!.id <= v.units[i - 1]!.id && analysis)
      out.add(err(`/units/${i}/id`, 'work is sorted by id, each once'));
  for (const i of duplicates(v.units, (w) => w.id)) out.add(err(`/units/${i}/id`, 'duplicate work'));
  for (const i of duplicates(v.ruleGaps, (g) => g.familyId)) out.add(err(`/ruleGaps/${i}`, 'duplicate rule gap'));
  const work = new Map(v.units.map((w) => [w.id, w]));
  const pinnedAdapters = new Map(v.pins.adapters.map((a) => [a.adapterId, a.digest]));
  for (const i of duplicates(v.pins.adapters, (a) => a.adapterId))
    out.add(err(`/pins/adapters/${i}`, 'duplicate adapter pin'));
  const covered = new Map<string, string>();
  v.units.forEach((w, i) => {
    const reviewing = w.stage === 'review-guided' || w.stage === 'review-general';
    // A unit of a declared script stage carries that stage's id, the script runner it is pinned to, and no check.
    const declared = !reviewing && w.stage !== 'check' && !BOOTSTRAP_STAGES.has(w.stage);
    if (
      reviewing &&
      (!w.review ||
        !w.sourceId ||
        w.adapterId !== `sentinel.review.${w.stage.slice(7)}` ||
        w.checks.length ||
        w.scopes.length !== 1 ||
        w.scopes[0] !== w.sourceId ||
        w.inputFingerprint !== w.review.specDigest)
    )
      out.add(err(`/units/${i}/review`, 'a review binds one exact source/segment/spec and no deterministic checks'));
    if (!reviewing && w.review !== undefined)
      out.add(err(`/units/${i}/review`, 'only review work carries model inputs'));
    if (analysis !== (w.stage === 'check' || reviewing || declared))
      out.add(
        err(
          `/units/${i}/stage`,
          analysis
            ? 'an analysis revision schedules checks only'
            : 'a bootstrap revision schedules capture, parse and inventory',
        ),
      );
    if (!analysis && !BOOTSTRAP_STAGES.has(w.stage)) out.add(err(`/units/${i}/stage`, 'unknown bootstrap stage'));
    if (w.stage === 'check' && w.adapterId === null)
      out.add(err(`/units/${i}/adapterId`, 'check work names its registered adapter'));
    if (declared && (w.adapterId === null || w.contract !== 'sentinel.stage.script.host'))
      out.add(err(`/units/${i}/adapterId`, 'a declared stage unit runs the script runner its plan pins'));
    if (w.stage !== 'check' && !reviewing && !declared) {
      const op = v.pins.operations[w.stage as 'capture' | 'parse' | 'inventory'];
      if (
        (op?.adapterId ?? null) !== w.adapterId ||
        (op !== null && op !== undefined && op.digest !== w.implementationDigest)
      ) {
        out.add(
          err(`/units/${i}/adapterId`, 'a bootstrap unit runs the operation the plan binds to its stage, or none'),
        );
      }
    } else if (w.adapterId !== null && pinnedAdapters.get(w.adapterId) !== w.implementationDigest) {
      out.add(err(`/units/${i}/implementationDigest`, 'a check unit runs a pinned adapter at its pinned digest'));
    }
    if (w.inputSetDigest !== digestOf(w.inputs))
      out.add(err(`/units/${i}/inputSetDigest`, 'the input set digest is the digest of exactly the inputs'));
    if (w.stage === 'check' && w.checks.length === 0)
      out.add(err(`/units/${i}/checks`, 'a check unit covers at least one check'));
    if (w.stage !== 'check' && !reviewing && (w.checks.length || w.scopes.length || w.inputs.length))
      out.add(err(`/units/${i}/checks`, 'a bootstrap unit covers no check'));
    for (const id of w.checks) {
      if (covered.has(id)) out.add(err(`/units/${i}/checks`, `check ${id} is covered twice`));
      covered.set(id, w.id);
    }
    w.inputs.forEach((p, j) => pathError(out, `/units/${i}/inputs/${j}/relativePath`, p.relativePath));
  });
  // The pin graph: every id follows from its content, every check names a pinned rule and analysed source, and every
  // check unit runs the adapter its checks' rules name.
  const ruleKey = (f: string, r: number) => `${f}\u0000${r}`;
  for (const i of duplicates(v.pins.rules, (r) => r.familyId))
    out.add(err(`/pins/rules/${i}/familyId`, 'a plan pins each rule family once'));
  const pinnedRules = new Map(v.pins.rules.map((r) => [ruleKey(r.familyId, r.revision), r]));
  v.ruleGaps.forEach((g, i) => {
    if (v.pins.rules.some((r) => r.familyId === g.familyId))
      out.add(err(`/ruleGaps/${i}`, 'a pinned rule is not a rule gap'));
  });
  const analysed = new Set(v.pins.analyses.map((a) => a.sourceId));
  if (analysis && analysed.size === 0)
    out.add(err('/pins/analyses', 'an analysis revision pins the parser evidence it planned over'));
  const ruleOf = new Map<string, string>();
  v.checks.forEach((c, i) => {
    const rule = pinnedRules.get(ruleKey(c.familyId, c.ruleRevision));
    if (!rule) out.add(err(`/checks/${i}/familyId`, 'a check names a rule revision the plan pins'));
    else ruleOf.set(c.id, rule.adapterId);
    if (!analysed.has(c.sourceId))
      out.add(err(`/checks/${i}/sourceId`, 'a check names a source whose analysis the plan pins'));
    if (c.environment === v.pins.environment && c.id !== checkIdOf(c))
      out.add(err(`/checks/${i}/id`, 'a check id is the digest of its scope, rule revision and environment'));
  });
  v.units.forEach((w, i) => {
    if (w.stage === 'check') {
      if (
        w.sourceId === null ||
        w.adapterId === null ||
        w.id !==
          checkUnitIdOf({
            runId: v.runId,
            revision: v.revision,
            adapterId: w.adapterId,
            sourceId: w.sourceId,
            checks: w.checks,
          })
      ) {
        out.add(
          err(`/units/${i}/id`, 'a check unit id is the digest of its run, revision, adapter, source and checks'),
        );
      }
      if (w.checks.some((id) => ruleOf.has(id) && ruleOf.get(id) !== w.adapterId))
        out.add(err(`/units/${i}/adapterId`, "a unit runs the adapter its checks' rules name"));
    } else if (w.review) {
      if (
        w.sourceId === null ||
        w.id !==
          reviewUnitIdOf({
            runId: v.runId,
            revision: v.revision,
            stage: w.stage,
            sourceId: w.sourceId!,
            segmentId: w.review.segmentId,
            specDigest: w.review.specDigest,
          })
      )
        out.add(err(`/units/${i}/id`, 'review id binds its exact admitted segment and spec'));
    } else if (w.contract === 'sentinel.stage.script.host') {
      if (
        w.sourceId !== null ||
        w.id !==
          scriptUnitIdOf({ runId: v.runId, revision: v.revision, stage: w.stage, inputFingerprint: w.inputFingerprint })
      )
        out.add(err(`/units/${i}/id`, 'a script unit id is the digest of its run, revision, stage and fingerprint'));
    } else if (
      w.id !== bootstrapUnitIdOf({ runId: v.runId, revision: v.revision, stage: w.stage, sourceId: w.sourceId })
    ) {
      out.add(err(`/units/${i}/id`, 'a bootstrap unit id is the digest of its run, revision, stage and source'));
    }
  });
  if (!analysis) {
    // The canonical bootstrap: one capture, one parse per source after it, one inventory after every parse.
    const ref = (w: { id: string; revision: number }) => `${w.id}@${w.revision}`;
    const captures = v.units.filter((w) => w.stage === 'capture');
    const parses = v.units.filter((w) => w.stage === 'parse');
    const inventories = v.units.filter((w) => w.stage === 'inventory');
    const shape =
      captures.length === 1 &&
      inventories.length === 1 &&
      parses.length >= 1 &&
      v.units.length === parses.length + 2 &&
      captures[0]!.sourceId === null &&
      captures[0]!.dependencies.length === 0 &&
      inventories[0]!.sourceId === null &&
      parses.every(
        (p) => p.sourceId !== null && p.dependencies.length === 1 && ref(p.dependencies[0]!) === ref(captures[0]!),
      ) &&
      new Set(parses.map((p) => p.sourceId)).size === parses.length &&
      inventories[0]!.dependencies.map(ref).sort().join() === parses.map(ref).sort().join();
    if (!shape)
      out.add(
        err(
          '/units',
          'a bootstrap revision is one capture, one parse per source after it and one inventory after every parse',
        ),
      );
  }
  const tally: Record<string, number> = {
    'planned': 0,
    'unsupported': 0,
    'applicability-unknown': 0,
    'scope-unavailable': 0,
    'scope-unknown': 0,
  };
  let required = 0,
    requiredNotPlanned = 0;
  const checkIds = new Set<string>();
  v.checks.forEach((c, i) => {
    checkIds.add(c.id);
    tally[c.state]!++;
    if (c.required) {
      required++;
      if (c.state !== 'planned') requiredNotPlanned++;
    }
    if (c.environment !== v.pins.environment)
      out.add(err(`/checks/${i}/environment`, "a check names the plan's environment"));
    if (c.state === 'planned') {
      if (c.reasonCode !== undefined) out.add(err(`/checks/${i}/reasonCode`, 'a planned check carries no reason'));
      const w = c.unit === undefined ? undefined : work.get(c.unit.id);
      if (!w || covered.get(c.id) !== c.unit!.id || w.revision !== c.unit!.revision)
        out.add(err(`/checks/${i}/unit`, 'a planned check is covered by the unit it names'));
      else {
        if (w.sourceId !== c.sourceId) out.add(err(`/checks/${i}/sourceId`, 'a unit covers checks of its own source'));
        if (!w.scopes.includes(c.scopeId))
          out.add(err(`/checks/${i}/scopeId`, "the covering unit lists the check's scope"));
      }
    } else {
      if (c.reasonCode === undefined) out.add(err(`/checks/${i}/reasonCode`, 'a check that is not planned says why'));
      if (c.unit !== undefined || covered.has(c.id))
        out.add(err(`/checks/${i}/unit`, 'a check that is not planned is covered by no work'));
    }
  });
  for (const id of covered.keys())
    if (!checkIds.has(id)) out.add(err('/units', `work covers ${id}, which is not a check of this plan`));
  const scopeOf = new Map(v.checks.map((c) => [c.id, c.scopeId]));
  v.units.forEach((w, i) => {
    const scopes = new Set(w.checks.map((id) => scopeOf.get(id)));
    if (!w.review && (w.scopes.length !== scopes.size || w.scopes.some((s) => !scopes.has(s))))
      out.add(err(`/units/${i}/scopes`, 'a unit lists exactly the scopes of its checks'));
  });
  requiredNotPlanned += v.ruleGaps.filter((g) => g.required).length;
  for (const [state, n] of Object.entries(tally))
    if (v.tallies.checks[state as keyof PlanEnvelope['tallies']['checks']] !== n)
      out.add(err(`/tallies/checks/${state}`, 'tallies recount the checks'));
  if (
    v.tallies.required !== required ||
    v.tallies.requiredNotPlanned !== requiredNotPlanned ||
    v.tallies.units !== v.units.length
  )
    out.add(err('/tallies', 'tallies recount the checks and work'));
  if (v.requiredCoverageAchievable !== (requiredNotPlanned === 0))
    out.add(err('/requiredCoverageAchievable', 'achievable exactly when every required check is planned'));
  // The work graph: dependencies inside the plan or among reused work, and no cycle.
  const key = (r: { id: string; revision: number }) => `${r.id}@${r.revision}`;
  const inPlan = new Set(v.units.map(key));
  const reused = new Set(v.reused.map(key));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  v.units.forEach((w, i) => {
    let n = 0;
    w.dependencies.forEach((d, j) => {
      const k = key(d);
      if (inPlan.has(k)) {
        n++;
        (dependents.get(k) ?? dependents.set(k, []).get(k)!).push(key(w));
      } else if (!reused.has(k))
        out.add(err(`/units/${i}/dependencies/${j}`, 'a dependency names work in the plan or work it reuses'));
    });
    indegree.set(key(w), n);
  });
  const ready = [...indegree].filter(([, n]) => n === 0).map(([k]) => k);
  let done = 0;
  while (ready.length) {
    const k = ready.pop()!;
    done++;
    for (const d of dependents.get(k) ?? []) {
      const n = indegree.get(d)! - 1;
      indegree.set(d, n);
      if (n === 0) ready.push(d);
    }
  }
  if (done !== v.units.length) out.add(err('/units', 'the work graph has a cycle'));
  const { digest, ...rest } = v;
  if (digest !== digestOf(rest)) out.add(err('/digest', 'the digest is not the canonical digest of the revision'));
};

/** A path is call reachability over one graph: its answer, steps and identities agree, and it never claims flow. */
const paths: Check<PathEvidenceEnvelope> = (v, out) => {
  for (const key of ['sentinel.paths.notDataFlow', 'sentinel.paths.graphOnly']) {
    if (!v.limitationKeys.includes(key)) out.add(err('/limitationKeys', `${key} is always stated`));
  }
  if (v.boundsDigest !== digestOf(v.bounds))
    out.add(err('/boundsDigest', 'the bounds digest is the canonical digest of the bounds'));
  for (const i of duplicates(v.results, (r) => `${r.from}\u0000${r.to}`))
    out.add(err(`/results/${i}`, 'one result per query'));
  v.results.forEach((r, i) => {
    if (r.from === r.to) out.add(err(`/results/${i}`, 'a query has two different ends'));
    if ((r.outcome === 'reached') !== (r.paths.length === 1))
      out.add(err(`/results/${i}/paths`, 'exactly a reached query carries its path'));
    if (r.outcome === 'not-reached-complete' && r.frontierReasons.length)
      out.add(err(`/results/${i}/frontierReasons`, 'a complete search met no frontier'));
    if (r.outcome === 'not-reached-bounded' && !r.frontierReasons.length)
      out.add(err(`/results/${i}/frontierReasons`, 'a bounded search names its frontier'));
    for (const p of r.paths) {
      if (p.steps.length > v.bounds.maxDepth)
        out.add(err(`/results/${i}/paths/0/steps`, 'a path is within the depth bound'));
      if (p.steps[0]?.from !== r.from || p.steps[p.steps.length - 1]?.to !== r.to)
        out.add(err(`/results/${i}/paths/0/steps`, "a path runs from the query's start to its end"));
      p.steps.forEach((s, j) => {
        if (j > 0 && p.steps[j - 1]!.to !== s.from)
          out.add(err(`/results/${i}/paths/0/steps/${j}`, 'consecutive steps join'));
        if (!v.bounds.edgeKinds.includes(s.kind))
          out.add(err(`/results/${i}/paths/0/steps/${j}/kind`, 'a step follows a bounded edge kind'));
        s.sites.forEach((x, k) =>
          pathError(out, `/results/${i}/paths/0/steps/${j}/sites/${k}/relativePath`, x.relativePath),
        );
      });
      const nodes = [r.from, ...p.steps.map((s) => s.to)];
      if (new Set(nodes).size !== nodes.length) out.add(err(`/results/${i}/paths/0`, 'a path visits each node once'));
      if (p.id !== digestOf({ nodes, edges: p.steps.map((s) => s.edgeId) }))
        out.add(err(`/results/${i}/paths/0/id`, 'the path id is the digest of its nodes and edges'));
    }
  });
};

/** An import binds each file it read once, and every flow points into a file it read. */
const pathrequest: Check<PathRequestEnvelope> = (v, out) => {
  if (Buffer.byteLength(JSON.stringify(v), 'utf8') > MAX_PATH_REQUEST_BYTES)
    out.add(err('', 'a structural request exceeds its 1 MiB bound'));
  for (let i = 0; i < v.queries.length; i++) {
    const q = v.queries[i]!;
    if (q.from === q.to) out.add(err(`/queries/${i}`, 'a query names two different nodes'));
    if (i) {
      const p = v.queries[i - 1]!;
      if (p.from > q.from || (p.from === q.from && p.to >= q.to))
        out.add(err(`/queries/${i}`, 'queries are sorted exact tuples, each once'));
    }
  }
  for (let i = 1; i < v.bounds.edgeKinds.length; i++)
    if (v.bounds.edgeKinds[i - 1]! >= v.bounds.edgeKinds[i]!)
      out.add(err(`/bounds/edgeKinds/${i}`, 'edge kinds are sorted, each once'));
};

const deepimport: Check<DeepImportEnvelope> = (v, out) => {
  for (const i of duplicates(v.binding.files, (f) => f.relativePath))
    out.add(err(`/binding/files/${i}`, 'each file read is listed once'));
  v.binding.files.forEach((f, i) => pathError(out, `/binding/files/${i}/relativePath`, f.relativePath));
  const read = new Map(v.binding.files.map((f) => [f.relativePath, f.content]));
  v.flows.forEach((f, i) => {
    [f.source, ...f.steps, f.sink].forEach((l, j) => {
      pathError(out, `/flows/${i}/locations/${j}/relativePath`, l.relativePath);
      if (read.get(l.relativePath) !== l.content)
        out.add(err(`/flows/${i}/locations/${j}`, 'a flow location is in a file the tool read, with the same content'));
      if (l.span.startByte >= l.span.endByte)
        out.add(err(`/flows/${i}/locations/${j}/span`, 'a location is a non-empty span'));
    });
  });
};

const decisioninput: Check<OwnerDecisionInput> = (v, out) => {
  if (new Set(v.evidence).size !== v.evidence.length) out.add(err('/evidence', 'evidence is unique'));
};
const decisionview: Check<DecisionViewEnvelope> = (v, out) => {
  if (v.decision.scope.findingId !== v.decision.findingId)
    out.add(err('/decision/scope', 'scope names another finding'));
  if (v.withheld && (v.decision.rationale !== null || v.decision.basisDigest !== null))
    out.add(err('/decision/rationale', 'withheld source metadata must be absent'));
  if (
    v.decision.state !== 'open' &&
    (v.decision.approval !== 'approved' || v.decision.validity !== 'valid' || v.decision.state !== v.decision.decision)
  )
    out.add(err('/decision/state', 'only a valid matching owner adjudication changes source state'));
  if (v.decision.approval === 'proposed' && v.decision.state !== 'open')
    out.add(err('/decision/state', 'proposal grants no adjudication'));
};
const decisionpage: Check<DecisionPageEnvelope> = (v, out) => {
  countErrors(out, '/count', v.count, v.items.length);
  if (v.count.n !== v.items.length || new Set(v.items.map((i) => i.id)).size !== v.items.length)
    out.add(err('/items', 'page count or identity mismatch'));
};
const importview: Check<ImportViewEnvelope> = (v, out) => {
  if (v.withheld !== (v.document === null) || v.withheld !== (v.limitation !== null))
    out.add(err('/withheld', 'withholding removes the complete imported document'));
  if (v.document)
    for (const k of ['claims', 'exchanges', 'cookies'] as const)
      if (v.counts[k].n !== v.document[k].length)
        out.add(err('/counts', 'counts describe the retained normalized document'));
};
const importpage: Check<ImportPageEnvelope> = (v, out) => {
  if (v.count.n !== v.items.length) out.add(err('/count', 'page count counts returned metadata rows only'));
  for (const i of duplicates(v.items, (x) => x.operationId)) out.add(err(`/items/${i}`, 'one row per operation'));
};
// Exact public timestamp arithmetic keeps fractions that Date.parse truncates.
const timestampNanos = (value: string): bigint | null => {
  if (!isCalendarTimestamp(value)) return null;
  const millis = Date.parse(value.slice(0, 19) + 'Z');
  if (!Number.isSafeInteger(millis)) return null;
  const whole = BigInt(millis) * 1_000_000n;
  const fraction = value.slice(19, -1).replace(/^\./, '');
  return whole + BigInt(fraction.padEnd(9, '0'));
};

const partitions: Check<ReviewPartitionsEnvelope> = (v, out) => {
  const seen = new Set<string>();
  let previous = '';
  v.partitions.forEach((p, i) => {
    let bytes = 0;
    p.members.forEach((m, j) => {
      pathError(out, `/partitions/${i}/members/${j}/relativePath`, m.relativePath);
      if (seen.has(m.relativePath)) out.add(err(`/partitions/${i}/members/${j}`, 'a file is in two partitions'));
      if (m.relativePath <= previous) out.add(err(`/partitions/${i}/members/${j}`, 'members are in path order'));
      seen.add(m.relativePath);
      previous = m.relativePath;
      bytes += m.bytes;
    });
    if (p.members.length > v.bounds.maxFiles || bytes > v.bounds.maxBytes)
      out.add(err(`/partitions/${i}`, 'the partition is over its bounds'));
    if (bytes !== p.bytes) out.add(err(`/partitions/${i}/bytes`, 'the bytes do not sum its members'));
    if (
      p.id !==
      `part-${digestOf({ sourceId: v.sourceId, members: p.members.map((m) => [m.relativePath, m.content]) }).slice(7, 31)}`
    ) {
      out.add(err(`/partitions/${i}/id`, 'the id is not the digest of the partition\u2019s source and members'));
    }
  });
  for (const i of duplicates(v.gaps, (g) => g.scopeId)) out.add(err(`/gaps/${i}`, 'duplicate gap'));
  const { digest, ...rest } = v;
  if (digest !== digestOf(rest)) out.add(err('/digest', 'the digest is not the canonical digest of the plan'));
};

const assessmentErrors = (
  out: Bounded,
  at: string,
  a: { verdict: string; claims: { citations: string[] }[]; inspected: string[] },
  served: ReadonlySet<string>,
  read: ReadonlySet<string>,
) => {
  if (a.verdict === 'finding' && a.claims.length === 0) out.add(err(`${at}/claims`, 'a finding needs a cited claim'));
  a.claims.forEach((c, i) =>
    c.citations.forEach((id, j) => {
      if (!served.has(id)) out.add(err(`${at}/claims/${i}/citations/${j}`, 'cites evidence the session never served'));
    }),
  );
  a.inspected.forEach((p, i) => {
    pathError(out, `${at}/inspected/${i}`, p);
    if (!read.has(p)) out.add(err(`${at}/inspected/${i}`, 'names a file the session never served'));
  });
};

const instructions: Check<ReviewInstructionsEnvelope> = (v, out) => {
  const { digest, ...body } = v;
  if (digest !== digestOf(body)) out.add(err('/digest', 'instruction manifest digest differs'));
  for (const item of [v.prompt, v.assembled, ...v.skills.flatMap((s) => [s, ...s.resources])])
    if (item.content !== item.digest) out.add(err('/content', 'instruction bytes and digest differ'));
  for (const i of duplicates(v.skills, (s) => s.id)) out.add(err(`/skills/${i}`, 'duplicate selected skill'));
  v.skills.forEach((s, i) => {
    for (const j of duplicates(s.resources, (r) => r.id))
      out.add(err(`/skills/${i}/resources/${j}`, 'duplicate included resource'));
  });
  if (
    v.prompt.bytes + v.skills.reduce((n, s) => n + s.bytes + s.resources.reduce((m, r) => m + r.bytes, 0), 0) >
    524288
  )
    out.add(err('/skills', 'instruction inputs exceed their aggregate bound'));
  if (v.skills.reduce((n, s) => n + s.resources.length, 0) > 32)
    out.add(err('/skills', 'included resource count exceeds its bound'));
  if (v.assembled.bytes > 524288) out.add(err('/assembled/bytes', 'assembled instructions exceed their bound'));
};
const reviewrequest: Check<ReviewRequestEnvelope> = (v, out) => {
  const { digest, ...body } = v;
  if (digest !== digestOf(body)) out.add(err('/digest', 'request digest differs'));
  if (v.wire) {
    const { digest: wireDigest, ...wire } = v.wire;
    if (wireDigest !== digestOf(wire) || wire.system !== v.messages[0]?.content)
      out.add(err('/wire', 'native wire differs from its exact semantic instructions'));
  }
  if (!v.messages.length || v.messages[0]!.role !== 'system')
    out.add(err('/messages', 'a request starts with the exact assembled instructions'));
};
const checkpoint: Check<ReviewCheckpointEnvelope> = (v, out) => {
  if ((v.instructions === undefined) !== (v.requests === undefined))
    out.add(err('/requests', 'instruction-bound checkpoints retain their request list'));
  if (v.instructions) {
    instructions(v.instructions, out);
    if (v.requests!.length < v.operations.length || v.requests!.length > v.operations.length + 1)
      out.add(err('/requests', 'at most one prepared request has unknown outcome'));
    v.requests!.forEach((r, i) => {
      reviewrequest(r, out);
      if (
        r.sessionId !== v.sessionId ||
        r.specDigest !== v.specDigest ||
        r.instructionDigest !== v.instructions!.digest ||
        r.operationId !== `${v.sessionId}.op${i + 1}`
      )
        out.add(err(`/requests/${i}`, 'request binding differs'));
      if (v.operations[i]?.state === 'settled' && !v.operations[i]!.identity)
        out.add(err(`/operations/${i}/identity`, 'a bound settled reply retains its reported identity'));
      if (v.operations[i] && v.operations[i]!.request !== digestOf(r))
        out.add(err(`/operations/${i}/request`, 'operation does not name its exact request'));
    });
  }
  if (v.messages[0]!.role !== 'system') out.add(err('/messages/0/role', 'a session starts with its fixed prompt'));
  for (const i of duplicates(v.served, (x) => x.id)) out.add(err(`/served/${i}/id`, 'duplicate evidence id'));
  const snapshots = new Set(v.served.map((x) => x.citation.snapshotId));
  if (snapshots.size > 1) out.add(err('/served', 'served evidence cites more than one snapshot'));
  v.served.forEach((x, i) => {
    pathError(out, `/served/${i}/citation/relativePath`, x.citation.relativePath);
    if (x.endLine < x.startLine) out.add(err(`/served/${i}/endLine`, 'the range ends before it starts'));
    if (x.citation.span.endByte < x.citation.span.startByte)
      out.add(err(`/served/${i}/citation/span`, 'span ends before it starts'));
    if (!x.citation.quoteDigest)
      out.add(err(`/served/${i}/citation/quoteDigest`, 'a served slice carries its quote digest'));
  });
  v.operations.forEach((o, i) => {
    if (o.operationId !== `${v.sessionId}.op${i + 1}`)
      out.add(err(`/operations/${i}/operationId`, 'operations are numbered in order under the session'));
    if ((o.state === 'settled') !== (o.usage !== undefined))
      out.add(err(`/operations/${i}`, 'exactly the settled operations carry usage'));
  });
  if (v.final && v.stopped) out.add(err('/stopped', 'a session either concluded or stopped'));
  if (v.final) {
    const last = v.operations[v.operations.length - 1];
    if (!last || last.outcome !== 'final') out.add(err('/final', 'the last operation is the final assessment'));
    assessmentErrors(
      out,
      '/final',
      v.final,
      new Set(v.served.map((x) => x.id)),
      new Set(v.served.map((x) => x.citation.relativePath)),
    );
  }
  if (v.operations.some((o) => o.state === 'unsettled') && !v.stopped)
    out.add(err('/stopped', 'an unsettled call stops the session'));
};

const review: Check<ReviewRecordEnvelope> = (v, out) => {
  if ((v.outcome === 'completed') !== (v.verdict !== null))
    out.add(err('/verdict', 'exactly a completed review has a verdict'));
  if (v.observations.length && v.verdict !== 'finding')
    out.add(err('/observations', 'only a finding yields observations'));
  const inspected = new Set<string>();
  v.inspected.forEach((x, i) => {
    pathError(out, `/inspected/${i}/relativePath`, x.relativePath);
    if (inspected.has(x.relativePath)) out.add(err(`/inspected/${i}`, 'duplicate inspected file'));
    inspected.add(x.relativePath);
    x.ranges.forEach(([a, b], j) => {
      if (b < a) out.add(err(`/inspected/${i}/ranges/${j}`, 'the range ends before it starts'));
    });
  });
  v.notInspected.forEach((p, i) => {
    pathError(out, `/notInspected/${i}`, p);
    if (inspected.has(p)) out.add(err(`/notInspected/${i}`, 'a file is both inspected and not'));
  });
  for (const p of v.notInspected) {
    if (
      !v.frontiers.some(
        (f) => f.scopeId === `${v.sourceId}:${p}` && f.reasonCode === 'sentinel.review.frontier.notInspected',
      )
    ) {
      out.add(err('/frontiers', 'every file not inspected is a frontier'));
      break;
    }
  }
  const unsettled = v.operations.some((o) => o.state === 'unsettled');
  if ((v.totals.usage === 'unknown') !== unsettled)
    out.add(err('/totals/usage', 'usage is unknown exactly when a call is unsettled'));
  if (v.totals.steps !== v.operations.length) out.add(err('/totals/steps', 'steps count the operations'));
  if (v.model === null && v.operations.some((o) => o.state === 'settled'))
    out.add(err('/model', 'a settled reply names its model'));
  const { digest, ...rest } = v;
  if (digest !== digestOf(rest)) out.add(err('/digest', 'the digest is not the canonical digest of the record'));
};

const INVARIANTS: { [K in EnvelopeKind]: Check<EnvelopeTypes[K]> } = {
  snapshot,
  run,
  work,
  attempt,
  observation,
  coverage,
  disposition,
  report,
  protocol,
  partitions,
  checkpoint,
  review,
  rulepack,
  rulelock,
  settings,
  repoconfig,
  policy,
  adoption,
  receipt,
  owneruireceipt: receipt,
  owneruicapabilities: () => [],
  admission,
  controls,
  plan,
  paths,
  pathrequest,
  deepimport,
  importview,
  importpage,
  decisioninput,
  decisionview,
  decisionpage,
  servicecapabilities: () => [],
  runinspection: () => [],
  inspectionpage: () => [],
  reportdelivery: () => [],
  deliverychunk: () => [],
  preparationcapabilities: () => [],
  configurationpreview: (v, out) => {
    const end = timestampNanos(v.expiresAt),
      start = timestampNanos(v.createdAt);
    if (end === null || start === null || end <= start || end - start > 30_000_000_000n)
      out.add(err('/expiresAt', 'preview expiry exceeds its original bound'));
  },
  preparationstatus: (v, out) => {
    if (!v.found) return;
    const end = timestampNanos(v.deadlineAt),
      start = timestampNanos(v.acceptedAt),
      runEnd = timestampNanos(v.runDeadlineAt);
    if (
      end === null ||
      start === null ||
      runEnd === null ||
      end <= start ||
      end - start > 600_000_000_000n ||
      runEnd > end
    )
      out.add(err('/deadlineAt', 'preparation timing must preserve the original bound'));
    if (v.phase === 'prepared' && (!v.runId || v.preparedRevision === null || v.preparedRevision < 2))
      out.add(err('/preparedRevision', 'prepared requires an actual analysis revision'));
    for (const [i, a] of v.availability.entries())
      if (a.available ? a.reasonCode !== null : a.reasonCode === null)
        out.add(err(`/availability/${i}`, 'readiness answer and reason differ'));
  },
  preparationoutcome: (v, out) => {
    const exits = {
      submitted: 0,
      requested: 0,
      kept: 0,
      answered: 0,
      'configuration-failure': 3,
      'awaiting-confirmation': 4,
      unavailable: 3,
      refused: 3,
    };
    if (v.status) {
      const nested = new Bounded();
      INVARIANTS.preparationstatus(v.status, nested);
      for (const error of nested.list) out.add({ ...error, path: '/status' + error.path });
    }
    if (v.exitCode !== exits[v.outcome])
      out.add(err('/exitCode', 'exit code differs from the canonical command outcome'));
    if (['submitted', 'requested', 'kept'].includes(v.outcome) && (!v.status || !v.status.found))
      out.add(err('/status', 'an accepted preparation outcome requires its actual retained status'));
  },
  controlcapabilities: () => [],
  controloutcome: (v, out) => {
    const exits = {
      ...POLICY_EXIT_CODES,
      submitted: 0,
      requested: 0,
      unavailable: 3,
      prepared: 0,
      kept: 0,
      answered: 0,
      refused: 3,
    };
    if (v.exitCode !== exits[v.outcome])
      out.add(err('/exitCode', 'exit code does not match the canonical command outcome'));
  },

  instructions,
  reviewrequest,
  pipeline: () => [],
  pipelineadoption: (v, out) => {
    if (!v.workspacePath.startsWith('/')) out.add(err('/workspacePath', 'the workspace path is absolute'));
  },
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
