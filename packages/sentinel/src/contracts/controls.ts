// The shared framework control-fact contract (PR 06, consumed by PRs 14–17). A framework pack says, for one
// surface of the application graph, which control applies at which position of the evaluated chain, with the
// evidence that establishes it. It never says a surface is "protected": a verdict is about one property, one
// surface and one environment, and anything the pack cannot resolve is `unknown` with its reason. Surfaces are
// canonical graph identities; the application graph is read, never forked.
import type { CatalogKey, Count, Digest, Id, NodeId, ScopedReason, ShortText, SourceEvidence } from './common.js';
import type { FrameworkId } from './rules.js';

/** The security property a control fact is about. There is no catch-all property. */
export type ControlProperty =
  | 'authentication' | 'authorization' | 'csrf' | 'input-validation' | 'rate-limit' | 'security-headers' | 'cors';

/** Whether the control takes effect for the surface. `unknown` is never rounded to either side. */
export type ControlVerdict = 'applies' | 'does-not-apply' | 'unknown';

export interface ControlFact {
  id: Id;
  property: ControlProperty;
  /** The route, handler or page the fact is about. */
  surfaceId: NodeId;
  /** Zero-based position of the control in the chain the framework evaluates for this surface. */
  order: Count;
  verdict: ControlVerdict;
  /** The control's own graph identity, when it has one. */
  controlId?: NodeId;
  /**
   * Required for `applies` and `does-not-apply`: the registration, configuration or matcher bytes that establish it.
   * @maxItems 64
   */
  evidence: SourceEvidence[];
  /** Required for `unknown`: why the pack could not resolve it. */
  reasonCode?: CatalogKey;
}

/**
 * sentinel-controls/draft-1 — one framework pack's control facts for one snapshot and environment. Keyed by the
 * resolved framework version, the environment, the registration/configuration bytes and the pack digest; a change
 * to any of them invalidates the facts.
 */
export interface ControlFactsEnvelope {
  schema: 'sentinel-controls/draft-1';
  snapshotId: Id;
  framework: { id: FrameworkId; version: ShortText | null };
  packDigest: Digest;
  environmentDigest: Digest;
  registrationDigest: Digest;
  /** The capability these facts provide to checks that require it. */
  capability: 'framework-order';
  /** @maxItems 100000 */
  facts: ControlFact[];
  /**
   * Registrations the pack met and could not follow (a dynamic mount, a runtime factory).
   * @maxItems 10000
   */
  frontiers: ScopedReason[];
}
