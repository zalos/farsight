// A refused native agent run's private inspection record. Its three byte artifacts are named by content handle;
// the owner-store persistence of this record and those bytes belongs to the retained-attempt store migration.
import type { ArtifactId, CatalogKey, Digest, RelativePath } from './common.js';
import type { AgentRunnerId, StageCost } from './pipeline.js';

export interface RetainedNativeProvenance {
  mode: 'native';
  runner: AgentRunnerId;
  runnerVersion: string | null;
  profileId: string;
  executableDigest: Digest | null;
  /** Private owner evidence: the installation category and resolved executable path that actually ran. */
  installation: { source: string; executablePath: string } | null;
  model: { requested: string; reported: string | null; identitySource: 'host-reported' };
  promptDigest: Digest | null;
  /** @maxItems 16 */
  skillDigests: Digest[];
  turns: number;
  tokens: { input: number | null; output: number | null; certainty: 'confirmed' | 'uncertain' };
  cost: StageCost;
  deadline: { grantedMs: number; usedMs: number | null };
  where: 'sandboxed-cli';
}

/** The sealed instruction record's identity and manifest; its exact instruction bytes are linked separately. */
export interface RetainedNativeInstructions {
  schema: 'sentinel-native-instructions/draft-1';
  disclosure: 'private-only';
  withholding: 'accepted-secret-fold-before-read';
  stage: string;
  instructions: { ref: string | null; digest: Digest };
  /** @maxItems 1024 */
  inputs: { relativePath: RelativePath; digest: Digest }[];
  task: { digest: Digest; text: string };
  /** @maxItems 16 */
  skills: { ref: string; digest: Digest; files: { path: RelativePath; digest: Digest }[] }[];
  /** @maxItems 256 */
  packs: { ref: string; digest: Digest }[];
}

/** sentinel-attempt-retained/draft-1: a failed native attempt, private source evidence, never stage output. */
export interface AttemptRetainedEnvelope {
  schema: 'sentinel-attempt-retained/draft-1';
  privacy: 'source';
  disclosure: 'private-only';
  withholding: 'accepted-secret-fold-before-read';
  failure: CatalogKey;
  completed: boolean;
  finalAnswer: string | null;
  /** @maxItems 1024 */
  filesRead: RelativePath[];
  /** @maxItems 4096 */
  tools: { tool: string; path: RelativePath | null }[];
  task: string;
  provenance: RetainedNativeProvenance;
  instructionRecord: RetainedNativeInstructions;
  transcript: ArtifactId;
  share: ArtifactId | null;
  instructions: ArtifactId;
  /** The artifact handles, in transcript, optional share, instructions order. */
  links: ArtifactId[];
}

/** In-memory handoff to the caller until the owner store can retain failed attempts. */
export interface AttemptRetainedDelivery {
  readonly record: AttemptRetainedEnvelope;
  readonly artifacts: readonly Readonly<{
    id: ArtifactId;
    schema: string;
    privacy: 'source';
    bytes: Uint8Array;
  }>[];
}
