import type { BoundedText, Digest, Id, NodeId, ShortText, Timestamp } from './common.js';

/** An accepted risk remains a risk; a mitigation is only as strong as the evidence it names. */
export type DispositionDecision = 'accepted-risk' | 'false-positive' | 'mitigated' | 'deferred';

/**
 * Where a decision came from. Only a trusted local owner action approves; MCP, HTTP, model output and any client of
 * the owner's local service (`local-service`, the owner's own CLI included when it talks to the service) propose.
 */
export type DecisionChannel = 'owner-cli' | 'mcp' | 'http-bridge' | 'model' | 'local-service';

/** Assertion provenance, kept apart from graph evidence classes. */
export type AssertionTrust = 'asserted' | 'imported-config' | 'runtime-observed';

export interface DeploymentAssertionRef {
  id: Id;
  trust: AssertionTrust;
  environmentDigest: Digest;
  /** @maxItems 64 */
  evidence: Digest[];
  lastVerifiedAt: Timestamp | null;
  expiresAt: Timestamp | null;
}

interface DispositionBase {
  schema: 'sentinel-disposition/draft-1';
  id: Id;
  findingGroupId: Id;
  /** Never wider than the finding's own scope; partial path coverage leaves the other paths open. */
  scope: {
    /** @maxItems 1024 */
    surfaceIds: NodeId[];
    environmentDigest: Digest;
  };
  decision: DispositionDecision;
  rationale: BoundedText;
  /** @maxItems 256 */
  evidence: Digest[];
  /** @maxItems 64 */
  assertions: DeploymentAssertionRef[];
  createdAt: Timestamp;
  expiresAt: Timestamp | null;
  supersedes: Id | null;
}

/** A proposal from any channel. A claimed human name in the body grants nothing. */
export interface ProposedDisposition extends DispositionBase {
  state: 'proposed';
  actor: { channel: DecisionChannel; principal: ShortText };
}

/** An approval, which only the owner's local CLI flow can record. */
export interface ApprovedDisposition extends DispositionBase {
  state: 'approved';
  actor: { channel: 'owner-cli'; principal: ShortText; confirmationReceipt: Digest };
}

/**
 * sentinel-disposition/draft-1 — an append-only, scoped, expiring decision about one finding group.
 * @discriminator state
 */
export type DispositionEnvelope = ProposedDisposition | ApprovedDisposition;
