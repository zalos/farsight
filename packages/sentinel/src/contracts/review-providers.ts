// Owner-adopted model choices for agentic review. Deterministic stages have no model selection.
import type { Id } from './common.js';

export type ReviewModelStage = 'guided' | 'general';

export interface ReviewStageModelSelection {
  stage: ReviewModelStage;
  providerId: Id;
  modelId: Id;
}

export interface ReviewSegmentModelSelection extends ReviewStageModelSelection {
  /** Exact prepared review segment identity; never a filesystem path or wildcard. */
  segmentId: Id;
}

/** Stage defaults and exact segment overrides. Selection requests do not admit or launch a model. */
export interface ReviewModelsSettings {
  /** @maxItems 2 */
  stages: ReviewStageModelSelection[];
  /** @maxItems 10000 */
  segments: ReviewSegmentModelSelection[];
}
