// Decision inputs are inert data, copied once and bounded before any authority is requested. Current path facts
// are supplied by the trusted assessment producer; a caller's assertions alone never prove a mitigation.
import type { Digest, NodeId } from '../contracts/common.js';
import type { DispositionDecision } from '../contracts/disposition.js';
import { canonicalDigest } from '../policy/digest.js';
import { snapshot } from '../policy/immutable.js';
import { isCalendarTimestamp } from '../validate.js';

export class DecisionError extends Error {
  constructor(readonly code: 'sentinel.decision.invalidInput' | 'sentinel.decision.corruptHistory' | 'sentinel.decision.staleState'
    | 'sentinel.decision.notFound' | 'sentinel.decision.scopeExceeded' | 'sentinel.decision.unauthorized', detail: string) { super(detail); this.name = 'DecisionError'; }
}
export const fail = (code: DecisionError['code'], detail: string): never => { throw new DecisionError(code, detail); };
export const validDigest = (v: unknown): v is Digest => typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v);
export const validId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
export const validNode = (v: unknown): v is NodeId => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v);
export const timestamp = (v: unknown): v is string => typeof v === 'string' && isCalendarTimestamp(v);
export function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(k => !Object.hasOwn(value, k))
    || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) fail('sentinel.decision.invalidInput', 'a decision record has unexpected or missing fields');
}
export function list<T>(value: unknown, max: number, check: (v: unknown) => v is T): asserts value is T[] {
  if (!Array.isArray(value) || value.length > max || value.some(v => !check(v))) fail('sentinel.decision.invalidInput', 'a decision list is outside its bounds');
}
export const unique = (v: readonly string[]) => new Set(v).size === v.length;

export interface DecisionPathBasis {
  readonly surfaceId: NodeId;
  readonly routeDigest: Digest;
  readonly controlDigest: Digest;
  readonly resolutionDigest: Digest;
  readonly frameworkDigest: Digest;
  readonly resolution: 'exact' | 'partial' | 'unknown';
}
export interface DecisionBasis {
  readonly findingId: string;
  readonly findingFingerprint: Digest;
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly environmentDigest: Digest;
  readonly deploymentDigest: Digest;
  readonly paths: readonly DecisionPathBasis[];
}
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
  fields(b, ['findingId', 'findingFingerprint', 'snapshotId', 'sourceId', 'environmentDigest', 'deploymentDigest', 'paths']);
  if (!validId(b.findingId) || !validId(b.snapshotId) || !validId(b.sourceId) || ![b.findingFingerprint, b.environmentDigest, b.deploymentDigest].every(validDigest)) fail('sentinel.decision.invalidInput', 'a decision basis has no exact identity');
  list(b.paths, 256, (p): p is DecisionPathBasis => {
    fields(p, ['surfaceId', 'routeDigest', 'controlDigest', 'resolutionDigest', 'frameworkDigest', 'resolution']);
    return validNode(p.surfaceId) && [p.routeDigest, p.controlDigest, p.resolutionDigest, p.frameworkDigest].every(validDigest) && ['exact', 'partial', 'unknown'].includes(p.resolution);
  });
  if (!unique(b.paths.map(p => p.surfaceId))) fail('sentinel.decision.invalidInput', 'a surface appears twice');
  return snapshot(b) as unknown as DecisionBasis;
}
export function pathDigest(path: DecisionPathBasis): Digest { return canonicalDigest(path); }
