// The agentic review stage (PR 22). Model review is planned as its own work: one `sentinel-work/draft-1` unit per
// guided check or general partition, with `stage.kind: 'agentic'`, depending on the deterministic work it reviews.
// It covers no plan check and can never satisfy deterministic coverage: its units carry no checks, its records say
// `deterministicCoverage: false`, and `assertAgenticOnly` refuses any coverage record attributed to it. The run's
// required coverage is decided by deterministic work alone (planner/coverage.ts).
import type { CoverageEnvelope, Digest, ResourcePolicy, WorkEnvelope, WorkRef } from '../contracts/index.js';
import { canonicalDigest } from '../policy/digest.js';
import { validateEnvelope } from '../validate.js';
import { reviewFail } from './errors.js';
import { specDigest, type SessionSpec } from './session.js';

export const REVIEW_STAGE_CONTRACTS = Object.freeze({ guided: 'sentinel.stage.review.guided', general: 'sentinel.stage.review.general' } as const);

export interface ReviewWorkRequest {
  readonly runId: string;
  readonly planRevision: number;
  readonly coordinatorEpoch: string;
  readonly createdAt: string;
  /** The deterministic work the review reads (capture, parse, the checks it is guided by). */
  readonly dependencies: readonly WorkRef[];
  readonly resources: ResourcePolicy;
  readonly specs: readonly SessionSpec[];
}

export interface ReviewWorkUnit {
  readonly work: WorkEnvelope;
  /** The canonical influence manifest whose artifact id the work names; the coordinator stores it. */
  readonly manifest: { readonly spec: Digest; readonly kind: 'guided' | 'general'; readonly sessionId: string };
  readonly spec: SessionSpec;
}

/** One pending agentic work unit per session spec, validated as `sentinel-work/draft-1`. */
export function planReviewWork(req: ReviewWorkRequest): ReviewWorkUnit[] {
  if (req.specs.length > 10_000) reviewFail('sentinel.review.invalidInput', 'at most 10 000 review units per plan revision');
  const seen = new Set<string>();
  return req.specs.map(spec => {
    if (seen.has(spec.sessionId)) reviewFail('sentinel.review.invalidInput', 'two review units for one session');
    seen.add(spec.sessionId);
    const manifest = { spec: specDigest(spec), kind: spec.kind, sessionId: spec.sessionId };
    const work: WorkEnvelope = {
      schema: 'sentinel-work/draft-1', id: `work-review-${manifest.spec.slice(7, 31)}`, revision: 1, runId: req.runId, planRevision: req.planRevision,
      stage: { contract: REVIEW_STAGE_CONTRACTS[spec.kind], contractVersion: 'draft-1', kind: 'agentic', implementationDigest: spec.adapterDigest },
      inputFingerprint: manifest.spec, influenceManifest: canonicalDigest(manifest) as Digest, dependencies: req.dependencies.map(d => ({ ...d })),
      resources: { ...req.resources }, coordinatorEpoch: req.coordinatorEpoch, createdAt: req.createdAt, state: 'pending', activeAttemptId: null,
    };
    const checked = validateEnvelope('work', work);
    if (!checked.ok) reviewFail('sentinel.review.invalidInput', `a review work unit does not validate: ${checked.errors[0]?.path} ${checked.errors[0]?.message}`);
    return Object.freeze({ work, manifest, spec });
  });
}

/** True for work of the agentic review stage. */
export const isReviewWork = (w: Pick<WorkEnvelope, 'stage'>): boolean =>
  w.stage.kind === 'agentic' && (Object.values(REVIEW_STAGE_CONTRACTS) as string[]).includes(w.stage.contract);

/**
 * Refuses any coverage record attributed to agentic review work: model review is never coverage of a check. The
 * coordinator calls this before it accepts coverage; a test pins that review leaves required coverage unchanged.
 */
export function assertAgenticOnly(work: readonly Pick<WorkEnvelope, 'id' | 'stage'>[], coverage: readonly Pick<CoverageEnvelope, 'workId'>[]): void {
  const review = new Set(work.filter(isReviewWork).map(w => w.id));
  const bad = coverage.filter(c => review.has(c.workId));
  if (bad.length) reviewFail('sentinel.review.integrity', `${bad.length} coverage record(s) name agentic review work`);
}
