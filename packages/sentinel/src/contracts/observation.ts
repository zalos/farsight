import type { BoundedText, CatalogKey, Digest, Id, ShortText, SourceEvidence, Timestamp } from './common.js';
import type { IdentitySource } from './attempt.js';

/** A model's identity at the strength it is actually known, never inferred from response text. */
export interface ModelIdentity {
  /** @maxLength 256 */
  requestedModel: string;
  /** @maxLength 256 */
  returnedModel: string | null;
  /** @maxLength 256 */
  immutableRevision: string | null;
  source: IdentitySource;
}

/** @discriminator kind */
export type ObservationProducer =
  | {
      kind: 'scanner' | 'framework-pack';
      adapterId: Id;
      adapterDigest: Digest;
      attemptId: Id;
    }
  | {
      kind: 'model-review';
      adapterId: Id;
      adapterDigest: Digest;
      attemptId: Id;
      model: ModelIdentity;
      promptDigest: Digest;
    }
  | {
      /** Imported evidence never counts as a newly executed check. */
      kind: 'imported';
      provenanceArtifact: Digest;
    };

/** sentinel-observation/draft-1 — one producer's immutable original claim. Correlation never rewrites it. */
export interface ObservationEnvelope {
  schema: 'sentinel-observation/draft-1';
  id: Id;
  snapshotId: Id;
  producer: ObservationProducer;
  /**
   * The producer's own rule ID, kept as supplied.
   * @minLength 1
   * @maxLength 256
   */
  producerRuleId: string;
  /** The Sentinel rule family and revision this observation was planned under, when one exists. */
  rule?: { familyId: Id; revisionDigest: Digest };
  /** As the producer supplied it: never normalized in place. */
  originalSeverity: ShortText;
  originalConfidence?: ShortText;
  message: BoundedText;
  /** @maxItems 256 */
  evidence: SourceEvidence[];
  /** @maxItems 64 */
  limitationKeys: CatalogKey[];
  mappings?: {
    /** @maxItems 16 */
    cwe?: CweId[];
  };
  observedAt: Timestamp;
}

/** @pattern ^CWE-[1-9][0-9]{0,4}$ */
export type CweId = string;
