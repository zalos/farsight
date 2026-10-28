// /2 is source-only owner adjudication. It has NO qualified cookie basis consumer and cannot say mitigated.
import type { DecisionViewEnvelope, OwnerDecisionProjection } from '../contracts/index.js';
import { compareTimestamps, validateEnvelope } from '../validate.js';
import { deepFreeze } from '../policy/immutable.js';
import { stamp } from '../policy/receipts.js';
import { ownerContextOf } from '../evidence/owner-context.js';
import { digestOf, canonicalJson } from '../store/ledger-json.js';
import type { Workspace } from '../service/local.js';
import {
  acceptedFindingOf,
  findingSecretPrivacy,
  acceptedFindingDigest,
  readOwnerSupport,
  revalidateFindingRecord,
  type AcceptedFindingBasis,
  type FindingReadSession,
} from './decision-basis.js';
import { ownerHistoryOf, type OwnerHistory, type OwnerProposal } from './owner-journal.js';
import { fail } from './decision-data.js';

/**
 * Projects one owner decision on an accepted finding at `now`. Its historical basis is derived again and its support
 * read again; the decision is valid only while approved, unexpired, not superseded and over the same source evidence,
 * and a mitigation is never valid, since this is source-only adjudication. The rationale and basis digest are withheld
 * when the current, baseline or historical ancestry has accepted secret matches. Refuses `sentinel.decision.notFound`
 * for an unknown decision, `sentinel.decision.invalidInput` for a time before the proposal,
 * `sentinel.decision.unauthorized` when its support changed, and `sentinel.decision.staleState` when the history or the
 * finding changed.
 */
export async function decisionProjection(
  history: OwnerHistory,
  basis: AcceptedFindingBasis,
  ws: Workspace,
  id: string,
  now: Date,
  baselineRunId?: string,
  session?: FindingReadSession,
): Promise<DecisionViewEnvelope> {
  const actual = ownerHistoryOf(history),
    s = acceptedFindingOf(basis),
    c = ownerContextOf(s.context),
    p = actual.proposals.get(id);
  if (!p) return fail('sentinel.decision.notFound', 'decision not found');
  // Historical proposal basis is independently replayed, never authorized by its JSON schema label.
  const historical = await revalidateFindingRecord(
    c.store,
    ws,
    p.basis,
    { signal: c.signal, deadlineAt: c.deadlineAt },
    session,
  );
  acceptedFindingOf(basis);
  ownerHistoryOf(history);
  const at = stamp(now);
  if (compareTimestamps(at, p.createdAt) < 0)
    return fail('sentinel.decision.invalidInput', 'evaluation predates the proposal');
  const support = await readOwnerSupport(historical, ws, p.input.evidence, baselineRunId, session);
  if (canonicalJson(support) !== canonicalJson(p.support))
    return fail('sentinel.decision.unauthorized', 'support identity changed');
  acceptedFindingOf(basis);
  ownerHistoryOf(history);
  const approval = actual.approved.get(id),
    sameSource = dependency(p) === dependencyOf(s.record);
  const expired = p.input.expiresAt !== null && compareTimestamps(p.input.expiresAt, at) <= 0;
  const superseded = [...actual.proposals.values()].some(
    (x) =>
      x.input.supersedes === p.id &&
      actual.approved.has(x.id) &&
      compareTimestamps(actual.approved.get(x.id)!.admission.decidedAt, at) <= 0,
  );
  const effective = !!approval && compareTimestamps(approval.admission.decidedAt, at) <= 0 && !superseded;
  let reason = 'proposed',
    state: OwnerDecisionProjection['state'] = 'open',
    validity: OwnerDecisionProjection['validity'] = 'none';
  if (effective) {
    validity = expired ? 'expired' : sameSource ? 'valid' : 'invalidated';
    reason = expired
      ? 'expired'
      : !sameSource
        ? 'sourceChanged'
        : p.input.decision === 'mitigated'
          ? 'assertionUnverified'
          : p.input.decision;
    if (validity === 'valid' && p.input.decision === 'accepted-risk') state = 'accepted-risk';
    if (validity === 'valid' && p.input.decision === 'false-positive') state = 'false-positive';
    if (p.input.decision === 'mitigated' && validity === 'valid') validity = 'invalidated';
  } else if (superseded) {
    reason = 'superseded';
    validity = 'invalidated';
  }
  const privacy =
    (await findingSecretPrivacy(basis, ws, baselineRunId, session)) ||
    (canonicalJson(p.basis.ancestor) !== canonicalJson(s.record.ancestor) &&
      (await findingSecretPrivacy(historical, ws, baselineRunId, session)));
  acceptedFindingOf(basis);
  acceptedFindingOf(historical);
  ownerHistoryOf(history);
  const projection: OwnerDecisionProjection = {
    id: p.id,
    findingId: s.record.findingId,
    basisDigest: privacy ? null : acceptedFindingDigest(basis),
    decision: p.input.decision,
    scope: { kind: 'finding-source', findingId: s.record.findingId },
    approval: approval && compareTimestamps(approval.admission.decidedAt, at) <= 0 ? 'approved' : 'proposed',
    state,
    validity,
    reasonCode: 'sentinel.decision.reason.' + reason.replace(/-([a-z])/g, (_, x: string) => x.toUpperCase()),
    expiresAt: p.input.expiresAt,
    rationale: privacy ? null : p.input.rationale,
  };
  const view: DecisionViewEnvelope = {
    schema: 'sentinel-decision-view/draft-1',
    evaluator: 'sentinel-decision-evaluation/2',
    authority: 'owner-adjudication-of-accepted-source',
    disclosure: 'owner-local',
    evaluatedAt: at,
    journalHead: actual.head,
    withheld: privacy,
    limitationKey: 'sentinel.decision.sourceOnly',
    decision: projection,
  };
  if (!validateEnvelope('decisionview', view).ok) fail('sentinel.decision.invalidInput', 'invalid decision projection');
  return deepFreeze(view);
}
function dependency(p: OwnerProposal) {
  return dependencyOf(p.basis);
}
function dependencyOf(r: ReturnType<typeof acceptedFindingOf>['record']) {
  return digestOf({
    sourceId: r.ancestor.sourceId,
    findingId: r.findingId,
    fingerprint: r.fingerprint,
    familyId: r.familyId,
    citations: r.citations,
    checks: r.publications.flatMap((p) => p.checks),
  });
}
