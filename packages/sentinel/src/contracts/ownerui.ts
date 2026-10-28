// Honest browser-owner provenance, separate from the unchanged owner CLI receipt schema.
import type { Digest, Id, Ordinal, Timestamp } from './common.js';
export interface OwnerUiIssuer {
  workspaceDigest: Digest;
  storeId: Id;
  ownerEpoch: Id;
  hostInstance: Id;
  sessionDigest: Digest;
  contextRevision: Ordinal;
}
export interface OwnerUiReceiptEnvelope {
  schema: 'sentinel-owneruireceipt/draft-1';
  id: Id;
  actor: { channel: 'owner-ui'; principal: 'human' };
  /**
   * The paired browser confirms capture and the run controls; with U-3, also the model envelopes of a composite start
   * (`paid.admit`, each bound to one envelope) and a pipeline file write (`settings.adopt`, bound to exactly the bytes
   * written; writing only, adoption stays the CLI owner's). It never confirms rules, acquisition, imports or disclosure.
   */
  action: 'capture.source' | 'run.start' | 'run.pause' | 'run.cancel' | 'paid.admit' | 'settings.adopt';
  intentDigest: Digest;
  stateDigest: Digest;
  policyRevision: Digest;
  issuer: OwnerUiIssuer;
  issuedAt: Timestamp;
  expiresAt: Timestamp;
}
export interface OwnerUiCapabilities {
  schema: 'sentinel-owneruicapabilities/draft-1';
  apiRevision: 1;
  storeId: Id;
  epoch: Id;
  operations: [
    'owner-ui.pair',
    'owner-ui.revoke',
    'owner-ui.context',
    'owner-ui.preview',
    'owner-ui.accept',
    'owner-ui.status',
    'owner-ui.resume',
    'owner-ui.cancel',
    'owner-ui.control-preview',
    'owner-ui.control',
  ];
  receiptSchema: 'sentinel-owneruireceipt/draft-1';
  settingsSave: false;
  modelAdmission: false;
  /** Bounded retained-run selection, process inspection and identity display; no extra effect authority. */
  processInspection?: true;
}
