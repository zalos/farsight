// General review (PR 22): one session per deterministic partition of the inventory (evidence.ts partitionInventory),
// reviewed whether or not any detector reported anything there. Its scope coverage is the session record's own
// inspection ledger, kept apart from formal rule checks; its claims are observations under `sentinel.review.general`.
import type { Digest } from '../contracts/index.js';
import { canonicalDigest } from '../policy/digest.js';
import type { EvidenceLimits, Partition, PartitionPlan, PathFact } from './evidence.js';
import { reviewFail } from './errors.js';
import { GENERAL_PROMPT, promptDigest } from './prompts.js';
import { runSession, type RunSessionOptions, type SessionBudget, type SessionResult, type SessionSpec } from './session.js';
import { REPLY_BOUNDS } from './validator.js';

export const GENERAL_ADAPTER_ID = 'sentinel.review.general';
export const GENERAL_ADAPTER_DIGEST = canonicalDigest({ adapter: GENERAL_ADAPTER_ID, revision: 1, prompt: promptDigest(GENERAL_PROMPT), reply: REPLY_BOUNDS }) as Digest;

export interface GeneralRequest {
  readonly runId: string;
  readonly attemptId: string;
  readonly plan: PartitionPlan;
  readonly partitionId: string;
  readonly limits: EvidenceLimits;
  readonly budget: SessionBudget;
  readonly paths?: readonly PathFact[];
}

export function generalSpec(req: GeneralRequest): SessionSpec {
  const part: Partition | undefined = req.plan.partitions.find(p => p.id === req.partitionId);
  if (!part) return reviewFail('sentinel.review.invalidInput', 'the partition is not in the plan');
  return {
    sessionId: `rv-p-${canonicalDigest({ run: req.runId, plan: req.plan.digest, partition: part.id, attempt: req.attemptId }).slice(7, 31)}`,
    kind: 'general', runId: req.runId, attemptId: req.attemptId, adapterId: GENERAL_ADAPTER_ID, adapterDigest: GENERAL_ADAPTER_DIGEST,
    prompt: GENERAL_PROMPT,
    scope: { snapshotId: req.plan.snapshotId, sourceId: req.plan.sourceId, files: part.members, rules: [], paths: req.paths ?? [] },
    limits: req.limits, budget: req.budget, producerRuleId: GENERAL_ADAPTER_ID,
    tools: req.paths?.length ? ['list', 'read', 'paths'] : ['list', 'read'],
  };
}

export const generalReview = (req: GeneralRequest, opts: RunSessionOptions): Promise<SessionResult> => runSession(generalSpec(req), opts);

/**
 * Every partition of the plan, in plan order, each its own session; a stopped session never hides the next. The plan's
 * gaps stay gaps: they are returned with the records, not reviewed.
 */
export async function reviewAllPartitions(req: Omit<GeneralRequest, 'partitionId'>, opts: RunSessionOptions) {
  const results: SessionResult[] = [];
  for (const p of req.plan.partitions) results.push(await generalReview({ ...req, partitionId: p.id }, opts));
  return { results, gaps: req.plan.gaps };
}
