// Sentinel-visible instructions only. Vendor hidden prompts, credentials and private reasoning are unobserved.
import type {ArtifactId,Digest,Id} from './common.js';

export interface InstructionContent {
  id:Id;
  /**
   * @asType integer
   * @minimum 1
   * @maximum 1000000
   */
  revision:number;
  content:ArtifactId;
  digest:Digest;
  /**
   * @asType integer
   * @minimum 0
   * @maximum 65536
   */
  bytes:number;
}
export interface SelectedSkill extends InstructionContent {
  /** @maxItems 32 */
  resources:InstructionContent[];
  /** Every selected skill is rendered in this version. No vendor discovery occurs. */
  rendered:true;
}
/** Exact ordered owner-selected instruction inputs and the bytes Sentinel assembled. Data, not execution authority. */
export interface ReviewInstructionsEnvelope {
  schema:'sentinel-review-instructions/draft-1';
  assembly:'sentinel.review.instructions/1';
  prompt:InstructionContent;
  /**
   * Selection order is semantically significant.
   * @maxItems 16
   */
  skills:SelectedSkill[];
  assembled:{content:ArtifactId;digest:Digest;bytes:AssembledInstructionBytes};
  vendorInstructions:'unobserved';
  vendorSkillDiscovery:'not-performed';
  digest:Digest;
}
/** One exact Sentinel request sent to the caller. Its identity is the request bytes, not a claim about vendor internals. */
export interface ReviewProviderSelection {providerId:Id;modelId:Id;bindingDigest:Digest}
export interface ReviewInstructionBinding {manifest:ArtifactId;digest:Digest;assembled:ArtifactId;sourcePacket:ArtifactId;segmentId:Id;selection?:ReviewProviderSelection}
export interface NativeReviewWire {encoding:'sentinel-claude-chat/v1';
/** @maxLength 4194304 */
system:string;
/** @maxLength 4194304 */
stdin:string;
/** @maxLength 200 */
requestedModel:string}
export interface ReviewRequestEnvelope {
  schema:'sentinel-review-request/draft-1';
  sessionId:Id;runId:Id;attemptId:Id;snapshotId:Id;sourceId:Id;segmentId:Id;
  operationId:Id;specDigest:Digest;instructionDigest:Digest;
  /** Digest of the selected captured scope, including every content id. */
  scopeDigest:Digest;
  selection?:ReviewProviderSelection;
  wire?:(NativeReviewWire & {digest:Digest});
  /**
   * @minItems 2
   * @maxItems 1024
   */
  messages:InstructionMessage[];
  digest:Digest;
}

export interface InstructionMessage {
 role:'system'|'user'|'assistant';
 /** @maxLength 4194304 */
 content:string;
}

/**
 * @asType integer
 * @minimum 0
 * @maximum 524288
 */
export type AssembledInstructionBytes=number;
