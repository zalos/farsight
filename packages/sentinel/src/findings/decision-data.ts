// Decision inputs are inert data, copied once and bounded before any authority is requested. Current path facts
// are supplied by the trusted assessment producer; a caller's assertions alone never prove a mitigation.
import type { Digest, NodeId } from '../contracts/common.js';
import type { DispositionDecision } from '../contracts/disposition.js';
import { canonicalDigest } from '../policy/digest.js';
import { snapshot } from '../policy/immutable.js';
import { isCalendarTimestamp } from '../validate.js';

/**
 * A decision input, journal or evaluation that is refused, by code: `sentinel.decision.invalidInput` (malformed or out
 * of bounds), `sentinel.decision.corruptHistory` (a journal that does not replay), `sentinel.decision.staleState`
 * (state changed since it was read or confirmed), `sentinel.decision.notFound`, `sentinel.decision.scopeExceeded` (a
 * bound was reached) or `sentinel.decision.unauthorized` (no genuine authority).
 */
export class DecisionError extends Error {
  constructor(
    readonly code:
      | 'sentinel.decision.invalidInput'
      | 'sentinel.decision.corruptHistory'
      | 'sentinel.decision.staleState'
      | 'sentinel.decision.notFound'
      | 'sentinel.decision.scopeExceeded'
      | 'sentinel.decision.unauthorized',
    detail: string,
  ) {
    super(detail);
    this.name = 'DecisionError';
  }
}
/** Throws a `DecisionError` with this code and detail. */
export const fail = (code: DecisionError['code'], detail: string): never => {
  throw new DecisionError(code, detail);
};
/** True for a `sha256:` digest of 64 lowercase hex characters. */
export const validDigest = (v: unknown): v is Digest => typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v);
/** True for an identifier: an ASCII letter or digit, then at most 127 letters, digits or `._:-`. */
export const validId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
/** True for a graph node id: 1 to 1024 characters with no control character or line separator. */
export const validNode = (v: unknown): v is NodeId =>
  // eslint-disable-next-line no-control-regex -- Node identifiers must exclude control characters and line separators.
  typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v);
/** True for a calendar timestamp the contracts accept. */
export const timestamp = (v: unknown): v is string => typeof v === 'string' && isCalendarTimestamp(v);
/**
 * Asserts a non-array object that has every required key as an own property and whose enumerable own string keys are
 * all required or optional; otherwise `sentinel.decision.invalidInput`. Symbol and non-enumerable keys are not checked,
 * and a class instance passes.
 */
export function fields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, any> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    required.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => !required.includes(k) && !optional.includes(k))
  )
    fail('sentinel.decision.invalidInput', 'a decision record has unexpected or missing fields');
}
/** Asserts an array of at most `max` items that each pass `check`; otherwise `sentinel.decision.invalidInput`. */
export function list<T>(value: unknown, max: number, check: (v: unknown) => v is T): asserts value is T[] {
  if (!Array.isArray(value) || value.length > max || value.some((v) => !check(v)))
    fail('sentinel.decision.invalidInput', 'a decision list is outside its bounds');
}
/** True when no string repeats. */
export const unique = (v: readonly string[]) => new Set(v).size === v.length;

/**
 * The digests one surface's path to a finding had when a decision was made; a change to any of them invalidates the
 * decision for that surface.
 */
export interface DecisionPathBasis {
  readonly surfaceId: NodeId;
  readonly routeDigest: Digest;
  readonly controlDigest: Digest;
  readonly resolutionDigest: Digest;
  readonly frameworkDigest: Digest;
  readonly resolution: 'exact' | 'partial' | 'unknown';
}
/**
 * The exact finding, source, environment and deployment a decision was made against, with the path of every surface it
 * covers. The trusted assessment supplies it, never the caller's assertions.
 */
export interface DecisionBasis {
  readonly findingId: string;
  readonly findingFingerprint: Digest;
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly environmentDigest: Digest;
  readonly deploymentDigest: Digest;
  readonly paths: readonly DecisionPathBasis[];
}
/**
 * What an owner proposes about a finding: the decision, its rationale, the surfaces it covers, its evidence, an
 * optional expiry and the approved decision it supersedes.
 */
export interface DecisionProposalInput {
  readonly decision: DispositionDecision;
  readonly rationale: string;
  readonly surfaceIds: readonly NodeId[];
  readonly evidence: readonly Digest[];
  readonly expiresAt: string | null;
  readonly supersedes: string | null;
}
/** Rejects an unknown count or malformed path rather than interpreting it as an empty affected scope. */
export function checkedBasis(given: unknown): DecisionBasis {
  const b = snapshot(given);
  fields(b, [
    'findingId',
    'findingFingerprint',
    'snapshotId',
    'sourceId',
    'environmentDigest',
    'deploymentDigest',
    'paths',
  ]);
  if (
    !validId(b.findingId) ||
    !validId(b.snapshotId) ||
    !validId(b.sourceId) ||
    ![b.findingFingerprint, b.environmentDigest, b.deploymentDigest].every(validDigest)
  )
    fail('sentinel.decision.invalidInput', 'a decision basis has no exact identity');
  list(b.paths, 256, (p): p is DecisionPathBasis => {
    fields(p, ['surfaceId', 'routeDigest', 'controlDigest', 'resolutionDigest', 'frameworkDigest', 'resolution']);
    return (
      validNode(p.surfaceId) &&
      [p.routeDigest, p.controlDigest, p.resolutionDigest, p.frameworkDigest].every(validDigest) &&
      ['exact', 'partial', 'unknown'].includes(p.resolution)
    );
  });
  if (!unique(b.paths.map((p) => p.surfaceId))) fail('sentinel.decision.invalidInput', 'a surface appears twice');
  return snapshot(b) as unknown as DecisionBasis;
}
/** The canonical digest of one surface's path basis. */
export function pathDigest(path: DecisionPathBasis): Digest {
  return canonicalDigest(path);
}
