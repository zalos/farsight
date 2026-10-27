// Rule-guided review (PR 22): one session per planned check, over that check's scope files, with the check's pinned
// rule definition as the only rule text it may read. Its claims carry the planned rule family and revision; they are
// observations, never the check's coverage.
import type { Digest } from '../contracts/index.js';
import { canonicalDigest } from '../policy/digest.js';
import type { EvidenceLimits, PartitionMember, PathFact } from './evidence.js';
import { reviewFail } from './errors.js';
import { GUIDED_PROMPT, promptDigest } from './prompts.js';
import {
  runSession,
  type RunSessionOptions,
  type SessionBudget,
  type SessionResult,
  type SessionSpec,
} from './session.js';
import { REPLY_BOUNDS } from './validator.js';

export const GUIDED_ADAPTER_ID = 'sentinel.review.guided';

/** The adapter digest: prompt, reply grammar bounds and the module revision. */
export const GUIDED_ADAPTER_DIGEST = canonicalDigest({
  adapter: GUIDED_ADAPTER_ID,
  revision: 1,
  prompt: promptDigest(GUIDED_PROMPT),
  reply: REPLY_BOUNDS,
}) as Digest;

export interface GuidedCheck {
  readonly checkId: string;
  readonly familyId: string;
  readonly revisionDigest: Digest;
  /** The rule's definition text as pinned by the rule lock. */
  readonly ruleText: string;
  readonly files: readonly PartitionMember[];
  readonly paths?: readonly PathFact[];
}

export interface GuidedRequest {
  readonly runId: string;
  readonly attemptId: string;
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly check: GuidedCheck;
  readonly limits: EvidenceLimits;
  readonly budget: SessionBudget;
}

export function guidedSpec(req: GuidedRequest): SessionSpec {
  const c = req.check;
  if (!c.files.length) reviewFail('sentinel.review.invalidInput', 'a guided check names its scope files');
  if (typeof c.ruleText !== 'string' || !c.ruleText || c.ruleText.length > 64 * 1024)
    reviewFail('sentinel.review.invalidInput', 'a guided check carries its pinned rule text');
  return {
    // One session per run and check, whatever the attempt: a later attempt after a crash resumes its checkpoint.
    sessionId: `rv-g-${canonicalDigest({ run: req.runId, check: c.checkId }).slice(7, 31)}`,
    kind: 'guided',
    runId: req.runId,
    attemptId: req.attemptId,
    adapterId: GUIDED_ADAPTER_ID,
    adapterDigest: GUIDED_ADAPTER_DIGEST,
    prompt: GUIDED_PROMPT,
    scope: {
      snapshotId: req.snapshotId,
      sourceId: req.sourceId,
      files: c.files,
      rules: [{ familyId: c.familyId, revisionDigest: c.revisionDigest, text: c.ruleText }],
      paths: c.paths ?? [],
    },
    limits: req.limits,
    budget: req.budget,
    producerRuleId: c.familyId,
    rule: { familyId: c.familyId, revisionDigest: c.revisionDigest },
    tools: c.paths?.length ? ['list', 'read', 'rule', 'paths'] : ['list', 'read', 'rule'],
  };
}

export const guidedReview = (req: GuidedRequest, opts: RunSessionOptions): Promise<SessionResult> =>
  runSession(guidedSpec(req), opts);
