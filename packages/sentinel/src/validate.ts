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
  | 'sentinel.contract.invariant';

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
    ajv ??= new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
    fn = ajv.compile((schemas as Record<EnvelopeKind, object>)[kind]);
    compiled.set(kind, fn);
  }
  return fn;
}

/** The published JSON schema for one envelope kind. */
export function schemaOf(kind: EnvelopeKind): object {
  return (schemas as Record<EnvelopeKind, object>)[kind];
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
  const invariants = INVARIANTS[kind](value as never);
  if (invariants.length) return fail(invariants);
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

type Check<T> = (value: T) => ContractError[];
const err = (path: string, message: string): ContractError => ({ code: 'sentinel.contract.invariant', path, message });
const after = (a: string, b: string) => Date.parse(a) >= Date.parse(b);

function duplicates<T>(items: readonly T[], key: (item: T) => string): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  items.forEach((item, i) => { const k = key(item); if (seen.has(k)) out.push(i); else seen.add(k); });
  return out;
}

const snapshot: Check<SnapshotEnvelope> = v => {
  const out: ContractError[] = [];
  const sources = new Set(v.sources.map(s => s.sourceId));
  for (const i of duplicates(v.sources, s => s.sourceId)) out.push(err(`/sources/${i}/sourceId`, 'duplicate source'));
  for (const i of duplicates(v.entries, e => `${e.sourceId}\u0000${e.relativePath}`)) out.push(err(`/entries/${i}`, 'duplicate entry for one source path'));
  v.entries.forEach((e, i) => { if (!sources.has(e.sourceId)) out.push(err(`/entries/${i}/sourceId`, 'entry names a source the snapshot does not capture')); });
  v.frameworkVersions.forEach((f, i) => {
    if (f.state === 'resolved' && !sources.has(f.provenance.sourceId)) out.push(err(`/frameworkVersions/${i}/provenance/sourceId`, 'provenance names an uncaptured source'));
  });
  return out;
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

const run: Check<RunEnvelope> = v => {
  const out: ContractError[] = [];
  if (v.parentId === v.id) out.push(err('/parentId', 'a run cannot be its own parent'));
  if (v.baselineId === v.id) out.push(err('/baselineId', 'a run cannot be its own baseline'));
  if (v.state === 'completed' && !after(v.completedAt, v.createdAt)) out.push(err('/completedAt', 'completed before it was created'));
  if (v.policy && POLICY_EXIT_CODES[v.policy.result] !== v.policy.exitCode) out.push(err('/policy/exitCode', 'exit code does not match the policy result'));
  if (v.budgets.maxCost !== null && !v.budgets.currency) out.push(err('/budgets/currency', 'a monetary budget needs its currency'));
  if (v.budgets.maxCost === null && v.budgets.currency) out.push(err('/budgets/currency', 'a currency without a monetary budget'));
  return out;
};

const work: Check<WorkEnvelope> = v => {
  const out: ContractError[] = [];
  v.dependencies.forEach((d, i) => { if (d.id === v.id) out.push(err(`/dependencies/${i}`, 'work cannot depend on its own lineage')); });
  for (const i of duplicates(v.dependencies, d => `${d.id}#${d.revision}`)) out.push(err(`/dependencies/${i}`, 'duplicate dependency'));
  if (v.state === 'satisfied-by-reuse' && v.reuse.publication.id === v.id && v.reuse.publication.revision === v.revision) {
    out.push(err('/reuse/publication', 'reuse must point at an earlier publication, not itself'));
  }
  return out;
};

const attempt: Check<AttemptEnvelope> = v => {
  const out: ContractError[] = [];
  if (v.state !== 'running' && !after(v.endedAt, v.startedAt)) out.push(err('/endedAt', 'ended before it started'));
  if (v.state === 'canceled-after-spend' && v.usage.certainty !== 'confirmed') out.push(err('/usage/certainty', 'canceled-after-spend requires confirmed usage; unknown usage is a separate fact'));
  const u = v.usage;
  if (u.certainty === 'not-applicable' && (u.inputTokens !== undefined || u.outputTokens !== undefined || u.monetaryCost !== undefined)) {
    out.push(err('/usage', 'not-applicable usage carries no amounts'));
  }
  if (u.monetaryCost !== undefined && !u.currency) out.push(err('/usage/currency', 'a cost needs its currency'));
  return out;
};

const observation: Check<ObservationEnvelope> = v => {
  const out: ContractError[] = [];
  v.evidence.forEach((e, i) => {
    if (e.span.endByte < e.span.startByte) out.push(err(`/evidence/${i}/span`, 'span ends before it starts'));
    if (e.snapshotId !== v.snapshotId) out.push(err(`/evidence/${i}/snapshotId`, 'evidence cites another snapshot'));
  });
  return out;
};

const coverage: Check<CoverageEnvelope> = v => {
  const out: ContractError[] = [];
  if (v.status === 'complete' && v.skipped.length) out.push(err('/skipped', 'complete coverage cannot have skipped scope; it is partial'));
  if (v.status === 'complete' && v.basis.kind === 'unavailable') out.push(err('/basis', 'unavailable work cannot be complete coverage'));
  if (v.basis.kind === 'unavailable' && !['unsupported', 'not-run', 'error'].includes(v.status)) {
    out.push(err('/status', 'unavailable work is unsupported, not-run or error'));
  }
  if (v.basis.kind === 'reused' && v.basis.publication.id === v.workId && v.basis.publication.revision === v.workRevision) {
    out.push(err('/basis/publication', 'reuse points at an earlier publication, not this work revision'));
  }
  return out;
};

const disposition: Check<DispositionEnvelope> = v => {
  const out: ContractError[] = [];
  if (v.supersedes === v.id) out.push(err('/supersedes', 'a decision cannot supersede itself'));
  if (v.expiresAt !== null && !(Date.parse(v.expiresAt) > Date.parse(v.createdAt))) out.push(err('/expiresAt', 'expires at or before creation'));
  if (v.decision === 'mitigated' && v.state === 'approved' && v.evidence.length === 0) {
    out.push(err('/evidence', 'an approved mitigation names the evidence it rests on; an assertion alone is not verification'));
  }
  return out;
};

function countErrors(path: string, c: ReportCount, expected?: number): ContractError[] {
  const out: ContractError[] = [];
  if (c.of !== undefined && c.of < c.n) out.push(err(`${path}/of`, 'count exceeds its denominator'));
  if (c.breakdown && c.breakdown.reduce((s, p) => s + p.n, 0) !== c.n) out.push(err(`${path}/breakdown`, 'breakdown does not sum to the count'));
  if (expected !== undefined && c.n !== expected) out.push(err(`${path}/n`, 'count does not match the listed rows'));
  return out;
}

function placeErrors(path: string, p: FindingPlace): ContractError[] {
  const out: ContractError[] = [];
  out.push(...countErrors(`${path}/counts/screens`, p.counts.screens, new Set(p.screens.map(s => s.id)).size));
  out.push(...countErrors(`${path}/counts/journeys`, p.counts.journeys, new Set(p.journeys.map(j => j.id)).size));
  out.push(...countErrors(`${path}/counts/personas`, p.counts.personas, new Set(p.personas.map(s => s.id)).size));
  if (p.binding !== 'matched' && (p.screens.length || p.journeys.length || p.personas.length)) {
    out.push(err(`${path}/binding`, 'an unbound context cannot place on screens, journeys or personas'));
  }
  if (p.binding !== 'matched' && p.limitationKeys.length === 0) out.push(err(`${path}/limitationKeys`, 'an empty place says why'));
  if (p.binding === 'matched' && !p.context) out.push(err(`${path}/context`, 'a matched place names its pinned context'));
  return out;
}

const report: Check<ReportEnvelope> = v => {
  const out: ContractError[] = [];
  out.push(...countErrors('/counts/findings', v.counts.findings, v.findings.length));
  out.push(...countErrors('/counts/coverageGaps', v.counts.coverageGaps, v.gaps.length));
  out.push(...countErrors('/counts/observations', v.counts.observations, new Set(v.findings.flatMap(f => f.observationIds)).size));
  out.push(...countErrors('/counts/plannedChecks', v.counts.plannedChecks));
  if (v.counts.seenByNoStage.n === null && !v.counts.seenByNoStage.unknownScope) out.push(err('/counts/seenByNoStage', 'an unknown count is unknown scope'));
  if (v.completeness === 'complete' && v.gaps.length) out.push(err('/completeness', 'a report with coverage gaps is partial'));
  for (const i of duplicates(v.findings, f => f.id)) out.push(err(`/findings/${i}/id`, 'duplicate finding'));
  const findings = new Set(v.findings.map(f => f.id));
  v.findings.forEach((f, i) => {
    out.push(...placeErrors(`/findings/${i}/place`, f.place));
    for (const j of duplicates(f.evidence, e => e.id)) out.push(err(`/findings/${i}/evidence/${j}`, 'duplicate evidence'));
  });
  v.gaps.forEach((g, i) => out.push(...placeErrors(`/gaps/${i}/place`, g.place)));
  v.decisions.forEach((d, i) => { if (!findings.has(d.findingId)) out.push(err(`/decisions/${i}/findingId`, 'decision about a finding the report does not contain')); });
  for (const i of duplicates(v.artifactClosure, a => a)) out.push(err(`/artifactClosure/${i}`, 'duplicate artifact'));
  if (v.baseline?.reportId === v.id) out.push(err('/baseline', 'a report cannot be its own baseline'));
  if (v.baseline === null && v.findings.some(f => f.comparison !== undefined)) out.push(err('/findings', 'comparison labels need a baseline'));
  return out;
};

const protocol: Check<ProtocolMessage> = v => {
  const out: ContractError[] = [];
  if (v.type === 'progress' && v.completed > v.planned) out.push(err('/completed', 'more completed than planned'));
  if (v.type === 'hello' && new Set(v.supported).size !== v.supported.length) out.push(err('/supported', 'duplicate version'));
  return out;
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
