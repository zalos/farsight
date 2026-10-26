// A scoped fold over genuine journal approvals. The source finding and its observations are never edited. An
// accepted risk remains visible, a deferral remains open, and an assertion without verified evidence closes no path.
import type { NodeId } from '../contracts/common.js';
import { canonicalDigest } from '../policy/digest.js';
import { snapshot } from '../policy/immutable.js';
import { compareTimestamps } from '../validate.js';
import { approvedDecisionAuthority, decisionHistoryAuthority, type ApprovedDecision } from './dispositions.js';
import { checkedBasis, fail, timestamp, validDigest, type DecisionBasis } from './decision-data.js';

export type DecisionPathReason =
  | 'no-decision'
  | 'expired'
  | 'finding-changed'
  | 'source-changed'
  | 'environment-changed'
  | 'deployment-changed'
  | 'new-surface'
  | 'route-changed'
  | 'control-changed'
  | 'resolution-changed'
  | 'framework-changed'
  | 'unresolved'
  | 'assertion-unverified'
  | 'accepted-risk'
  | 'false-positive'
  | 'deferred';
export interface EvaluatedDecisionPath {
  readonly surfaceId: NodeId;
  readonly dispositionId: string | null;
  readonly state: 'open' | 'accepted-risk' | 'false-positive';
  readonly validity: 'valid' | 'expired' | 'invalidated' | 'none';
  readonly reason: DecisionPathReason;
}
export interface DecisionEvaluation {
  readonly schema: 'sentinel-decision-evaluation/1';
  readonly workspace: string;
  readonly findingId: string;
  readonly findingFingerprint: string;
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly basisDigest: string;
  readonly journalHead: string | null;
  readonly evaluatedAt: string;
  readonly paths: readonly EvaluatedDecisionPath[];
}
const evaluations = new WeakMap<object, DecisionEvaluation>();
/** Only an evaluation made by this fold has provenance; serialization is an inert historical record. */
export const decisionEvaluationAuthority = (value: unknown): DecisionEvaluation | undefined =>
  value && typeof value === 'object' ? evaluations.get(value) : undefined;
export function evaluateDecisions(
  approvals: readonly ApprovedDecision[],
  basisInput: DecisionBasis,
  options: { workspace: string; at: string },
): DecisionEvaluation {
  const basis = checkedBasis(basisInput);
  if (!validDigest(options.workspace) || !timestamp(options.at))
    fail('sentinel.decision.invalidInput', 'evaluation needs exact workspace and time');
  const history = decisionHistoryAuthority(approvals);
  if (!history || history.workspace !== options.workspace)
    return fail('sentinel.decision.unauthorized', 'evaluation requires a complete current journal read');
  const authority = approvals.map((a) => {
    const actual = approvedDecisionAuthority(a);
    if (!actual || actual.workspace !== options.workspace)
      return fail('sentinel.decision.unauthorized', 'evaluation requires genuine approvals for this workspace');
    return actual;
  });
  const paths = basis.paths.map((path) => {
    const candidates = authority
      .filter(
        (a) =>
          a.value.basis.findingId === basis.findingId &&
          a.value.disposition.scope.surfaceIds.includes(path.surfaceId) &&
          compareTimestamps(a.approvedAt, options.at) <= 0,
      )
      .sort((a, b) => b.sequence - a.sequence);
    const selected = candidates[0];
    const out = (
      reason: DecisionPathReason,
      validity: EvaluatedDecisionPath['validity'] = 'invalidated',
      state: EvaluatedDecisionPath['state'] = 'open',
    ): EvaluatedDecisionPath => ({
      surfaceId: path.surfaceId,
      dispositionId: selected?.value.disposition.id ?? null,
      state,
      validity,
      reason,
    });
    if (!selected) return out('no-decision', 'none');
    const { disposition: d, basis: old } = selected.value;
    // A historical view cannot accidentally apply a decision made later.
    if (compareTimestamps(d.createdAt, options.at) > 0) return out('no-decision', 'none');
    if (d.expiresAt !== null && compareTimestamps(d.expiresAt, options.at) <= 0) return out('expired', 'expired');
    if (old.sourceId !== basis.sourceId) return out('source-changed');
    if (old.findingFingerprint !== basis.findingFingerprint) return out('finding-changed');
    if (old.environmentDigest !== basis.environmentDigest) return out('environment-changed');
    if (old.deploymentDigest !== basis.deploymentDigest) return out('deployment-changed');
    const before = old.paths.find((p) => p.surfaceId === path.surfaceId);
    if (!before) return out('new-surface');
    if (before.routeDigest !== path.routeDigest) return out('route-changed');
    if (before.controlDigest !== path.controlDigest) return out('control-changed');
    if (before.resolutionDigest !== path.resolutionDigest || before.resolution !== path.resolution)
      return out('resolution-changed');
    if (before.frameworkDigest !== path.frameworkDigest) return out('framework-changed');
    if (before.resolution !== 'exact' || path.resolution !== 'exact') return out('unresolved');
    if (d.decision === 'accepted-risk') return out('accepted-risk', 'valid', 'accepted-risk');
    if (d.decision === 'false-positive') return out('false-positive', 'valid', 'false-positive');
    if (d.decision === 'deferred') return out('deferred', 'valid');
    // Until the bounded importer establishes provenance, even a JSON runtime-observed label is unverified.
    return out('assertion-unverified');
  });
  const result = snapshot<DecisionEvaluation>({
    schema: 'sentinel-decision-evaluation/1',
    workspace: options.workspace,
    findingId: basis.findingId,
    findingFingerprint: basis.findingFingerprint,
    snapshotId: basis.snapshotId,
    sourceId: basis.sourceId,
    basisDigest: canonicalDigest(basis),
    journalHead: history.head,
    evaluatedAt: options.at,
    paths,
  });
  evaluations.set(result, result);
  return result;
}
