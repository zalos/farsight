import type { BoundedText, CatalogKey, Digest, Id, Timestamp } from './common.js';
import type { DispositionDecision } from './disposition.js';
import type { ReportCount } from './report.js';

// Serialized projections are inert data. Only private held-owner/source/receipt capabilities authorize writes.
/** An owner adjudication of one accepted source finding, never proof of a deployed control. */
export interface OwnerDecisionInput {
  schema: 'sentinel-decision-input/draft-1';
  decision: DispositionDecision;
  rationale: BoundedText;
  /** @maxItems 256 */
  evidence: Digest[];
  expiresAt: Timestamp | null;
  supersedes: Id | null;
}
export interface OwnerDecisionProjection {
  id: Id;
  findingId: Id;
  basisDigest: Digest | null;
  decision: DispositionDecision;
  scope: { kind: 'finding-source'; findingId: Id };
  approval: 'proposed' | 'approved';
  state: 'open' | 'accepted-risk' | 'false-positive';
  validity: 'none' | 'valid' | 'expired' | 'invalidated';
  reasonCode: CatalogKey;
  expiresAt: Timestamp | null;
  rationale: BoundedText | null;
}
export interface DecisionViewEnvelope {
  schema: 'sentinel-decision-view/draft-1';
  evaluator: 'sentinel-decision-evaluation/2';
  authority: 'owner-adjudication-of-accepted-source';
  disclosure: 'owner-local';
  evaluatedAt: Timestamp;
  journalHead: Digest | null;
  withheld: boolean;
  limitationKey: 'sentinel.decision.sourceOnly';
  decision: OwnerDecisionProjection;
}
export interface DecisionPageEnvelope {
  schema: 'sentinel-decision-page/draft-1';
  authority: 'metadata-only-not-evaluated';
  /** @maxItems 100 */
  items: Array<{ id: Id; findingId: Id; approval: 'proposed' | 'approved'; availability: 'not-evaluated' }>;
  /** @maxLength 512 */
  next: string | null;
  count: ReportCount;
}
