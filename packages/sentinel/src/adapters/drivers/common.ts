// What every check driver shares: binding a unit's pinned rules to the exact rule bytes a driver supports, mapping the
// plan's checks to file scopes, and assembling the canonical result from per-file evidence. Coverage is never claimed
// here: a check is listed as covered only when the driver's adapter reports its exact rule ran on its exact file;
// everything else is a not-run check with a fixed reason. The coordinator computes coverage records from the result.
import { sha256Id } from '../../kernel/digest.js';
import { SentinelError } from '../../kernel/errors.js';
import type { ArtifactId, ScopeId, ScopedReason } from '../../contracts/common.js';
import type { PlanCheck, PlanInput } from '../../contracts/plan.js';
import type { CoverageGranularity } from '../../contracts/coverage.js';
import type { ResultMessage } from '../../contracts/protocol.js';
import { canonicalDigest } from '../../policy/digest.js';
import type { ResolvedRule } from '../../rules/resolve.js';
import type { DriverRecord, DriverRules, ResultBinding, SupportedRule } from './types.js';

/** Why a driver did not run a check: each is a catalog key, and a check with one is never covered. */
export const DRIVER_REASONS = [
  'sentinel.drivers.ruleUnsupported',
  'sentinel.drivers.scopeUnsupported',
  'sentinel.drivers.inputMissing',
  'sentinel.drivers.databaseMissing',
  'sentinel.drivers.notReported',
  'sentinel.drivers.nothingApplicable',
] as const;
/** One of {@link DRIVER_REASONS}. */
export type DriverReason = (typeof DRIVER_REASONS)[number];

/** The codes a DriverError carries: a malformed context, rule bytes that are not the shipped ones, or a reason. */
export type DriverErrorCode = 'sentinel.drivers.contextInvalid' | 'sentinel.drivers.ruleBytesInvalid' | DriverReason;

/** A canonical driver refused its context, its rule bytes or a unit it cannot run; `code` is a catalog key. */
export class DriverError extends SentinelError<DriverErrorCode> {
  constructor(code: DriverErrorCode, message: string) {
    super(code, message);
    this.name = 'DriverError';
  }
}

/** The content address of bytes (the kernel's sha256Id), under the name the drivers have always used. */
export const sha256 = (b: Uint8Array): ArtifactId => sha256Id(b);
/** The plan's file scope for a captured input. */
export const fileScope = (input: Pick<PlanInput, 'sourceId' | 'relativePath'>): ScopeId =>
  `${input.sourceId}:${input.relativePath}`;

/**
 * The unit's rules this driver may run: a pin is runnable only when its adapter is this driver's and its family,
 * revision and definition digest are exactly one the driver supports, and the coordinator's resolution of it agrees.
 * Anything else, a custom or changed rule included, is refused here and its checks are never covered.
 */
export function bindRules(
  adapterId: string,
  supported: readonly SupportedRule[],
  rules: DriverRules,
  checks: readonly PlanCheck[],
): { runnable: readonly ResolvedRule[]; refused: ReadonlySet<string> } {
  const families = new Set(checks.map((c) => c.familyId));
  const runnable: ResolvedRule[] = [];
  const refused = new Set<string>();
  for (const familyId of families) {
    const pin = rules.pins.find((p) => p.familyId === familyId);
    const resolved = rules.resolved.find((r) => r.familyId === familyId);
    const revisions = new Set(checks.filter((c) => c.familyId === familyId).map((c) => c.ruleRevision));
    const ok =
      pin &&
      resolved &&
      revisions.size === 1 &&
      revisions.has(pin.revision) &&
      resolved.definition.familyId === familyId &&
      resolved.definition.revision === pin.revision &&
      pin.adapterId === adapterId &&
      resolved.definition.implementation.adapterId === adapterId &&
      resolved.revision === pin.revision &&
      resolved.definitionDigest === pin.definitionDigest &&
      resolved.packDigest === pin.packDigest &&
      supported.some(
        (s) => s.familyId === familyId && s.revision === pin.revision && s.definitionDigest === pin.definitionDigest,
      );
    if (ok) runnable.push(resolved);
    else refused.add(familyId);
  }
  return { runnable, refused };
}

/** A rule's implementation file bytes, checked against the pack's file digest. */
export function ruleFileBytes(rules: DriverRules, rule: ResolvedRule): Uint8Array {
  const file = rules.files.find((f) => f.path === rule.definition.implementation.rulePath);
  const bytes = file ? rules.bytesOf(file.digest) : undefined;
  if (!file || !bytes || sha256(bytes) !== file.digest || bytes.length !== file.size) {
    throw new DriverError(
      'sentinel.drivers.ruleBytesInvalid',
      `${rule.familyId}: the implementation bytes are not the pack's`,
    );
  }
  return bytes;
}

/** Accumulates the canonical coverage facts of one attempt. */
export class ResultFacts {
  readonly #covered = new Set<string>();
  readonly #scanned = new Set<ScopeId>();
  readonly #read = new Set<ScopeId>();
  readonly #skipped = new Map<string, ScopedReason>();
  readonly #frontiers = new Map<string, ScopedReason>();

  /** The check's exact rule ran on its exact scope; `limits` are the reasons it is not complete. */
  ran(check: PlanCheck, limits: readonly string[] = []): void {
    this.#covered.add(check.id);
    this.#scanned.add(check.scopeId);
    this.#read.add(check.scopeId);
    for (const reasonCode of limits)
      this.#skipped.set(`${check.scopeId}\u0000${reasonCode}`, { scopeId: check.scopeId, reasonCode });
  }

  /** The check did not run; the scope is recorded as skipped with its reason. */
  notRun(check: PlanCheck, reasonCode: string): void {
    this.#skipped.set(`${check.scopeId}\u0000${reasonCode}`, { scopeId: check.scopeId, reasonCode });
  }

  frontier(scopeId: ScopeId, reasonCode: string): void {
    this.#frontiers.set(`${scopeId}\u0000${reasonCode}`, { scopeId, reasonCode });
  }
  read(scopeId: ScopeId): void {
    this.#read.add(scopeId);
  }

  /** The coverage facts of a result, without its attempt binding. The normalized report is every covered check's artifact. */
  facts(
    granularity: CoverageGranularity,
    report: DriverRecord,
    observations: readonly DriverRecord[],
  ): Omit<ResultMessage, keyof ResultBinding> {
    const reportId = canonicalDigest(report.value);
    const sort = <T>(xs: Iterable<T>, key: (x: T) => string) =>
      [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    return {
      granularity,
      artifacts: [],
      observations: observations.map((o) => canonicalDigest(o.value)),
      coveredChecks: sort(this.#covered, (x) => x).map((checkId) => ({ checkId, coverage: reportId })),
      scannedSet: sort(this.#scanned, (x) => x),
      actualReadSet: sort(this.#read, (x) => x),
      skipped: sort(this.#skipped.values(), (x) => `${x.scopeId}\u0000${x.reasonCode}`),
      unresolvedFrontiers: sort(this.#frontiers.values(), (x) => `${x.scopeId}\u0000${x.reasonCode}`),
      diagnostics: [],
    };
  }

  /** The canonical result: the worker's binding and artifacts kept as they are, its coverage facts replaced. */
  result(
    worker: ResultMessage,
    granularity: CoverageGranularity,
    report: DriverRecord,
    observations: readonly DriverRecord[],
  ): ResultMessage {
    return {
      ...this.facts(granularity, report, observations),
      protocol: worker.protocol,
      type: 'result',
      attemptId: worker.attemptId,
      work: worker.work,
      coordinatorEpoch: worker.coordinatorEpoch,
      seq: worker.seq,
      inputFingerprint: worker.inputFingerprint,
      artifacts: worker.artifacts,
      diagnostics: worker.diagnostics,
    };
  }
}

/** A unit with nothing to run: every check not run, with its family's reason (or `fallback`). */
export function nothingToRun(
  adapterId: string,
  granularity: CoverageGranularity,
  checks: readonly PlanCheck[],
  notRun: Readonly<Record<string, string>>,
  fallback: string,
  detail: Readonly<Record<string, unknown>> = {},
): { artifacts: []; context: null; skipRun: { result: Omit<ResultMessage, keyof ResultBinding> } } {
  const facts = new ResultFacts();
  for (const c of checks) facts.notRun(c, notRun[c.familyId] ?? fallback);
  const report: DriverRecord = {
    schema: 'sentinel-driver-report/draft-1',
    value: { adapter: adapterId, ran: false, notRun, ...detail },
  };
  return { artifacts: [], context: null, skipRun: { result: facts.facts(granularity, report, []) } };
}

/** Index of a unit's checks by family and scope. */
export function checksByFamilyAndScope(checks: readonly PlanCheck[]): Map<string, PlanCheck> {
  return new Map(checks.map((c) => [`${c.familyId}\u0000${c.scopeId}`, c]));
}
