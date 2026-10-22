// Imported deep-analysis results (PR 18). Sentinel ships no deep engine: no evaluated engine qualified for cross-file
// flow (E3), so none is selected, downloaded or run. A customer may run an analyzer they are licensed to use and import
// its flows here. The document is untrusted input: it must attest the tool's identity, licence terms and provenance,
// and bind its results to the exact captured source the analyzer read. Imported flows are the tool's claim within that
// stated scope; they never count as a check Sentinel executed.
import type { ArtifactId, ByteSpan, Digest, Id, RelativePath, ShortText, Timestamp } from './common.js';

export interface DeepImportLocation {
  relativePath: RelativePath;
  /** The captured content id of the file the analyzer read; it must equal the snapshot's. */
  content: ArtifactId;
  span: ByteSpan;
}

export interface DeepImportFile {
  relativePath: RelativePath;
  content: ArtifactId;
}

export interface DeepImportFlow {
  /**
   * The tool's own rule id, as supplied.
   * @minLength 1
   * @maxLength 256
   */
  toolRuleId: string;
  /** @maxLength 1000 */
  message: string;
  originalSeverity: ShortText;
  source: DeepImportLocation;
  sink: DeepImportLocation;
  /** @maxItems 254 */
  steps: DeepImportLocation[];
}

/**
 * sentinel-deep-import/draft-1 — a customer-supplied deep-analysis result with its attestation and source binding.
 */
export interface DeepImportEnvelope {
  schema: 'sentinel-deep-import/draft-1';
  tool: {
    name: ShortText;
    version: ShortText;
    /** Digest of the analyzer executable or distribution the customer ran. */
    distributionDigest: Digest;
  };
  attestation: {
    /** The terms the tool was used under: their digest is what the owner's policy accepts. */
    license: { identifier: ShortText; termsDigest: Digest; acceptedBy: ShortText; acceptedAt: Timestamp };
    provenance: { obtainedFrom: ShortText; attestedBy: ShortText; attestedAt: Timestamp };
  };
  binding: {
    snapshotId: Id;
    sourceId: Id;
    /**
     * Every file the analyzer read, with the captured content id it read.
     * @minItems 1
     * @maxItems 100000
     */
    files: DeepImportFile[];
    /** Digest of the analyzer's configuration and query or rule set. */
    configurationDigest: Digest;
    /** The analyzer's own name for how it ran; recorded, never interpreted as a capability. */
    mode: ShortText;
    /** Whether the analyzer built or ran the project; recorded as stated. */
    buildPerformed: boolean;
  };
  /** @maxItems 10000 */
  flows: DeepImportFlow[];
}
