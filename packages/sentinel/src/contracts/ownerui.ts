// Honest browser-owner provenance, separate from the unchanged owner CLI receipt schema.
import type{Digest,Id,Ordinal,Timestamp}from'./common.js';
export interface OwnerUiIssuer{
 workspaceDigest:Digest;storeId:Id;ownerEpoch:Id;hostInstance:Id;sessionDigest:Digest;contextRevision:Ordinal;
}
export interface OwnerUiReceiptEnvelope{
 schema:'sentinel-owneruireceipt/draft-1';id:Id;actor:{channel:'owner-ui';principal:'human'};
 /** This channel cannot confirm settings, rules, acquisition, imports, disclosures or model spending. */
 action:'capture.source'|'run.start'|'run.pause'|'run.cancel';intentDigest:Digest;stateDigest:Digest;policyRevision:Digest;
 issuer:OwnerUiIssuer;issuedAt:Timestamp;expiresAt:Timestamp;
}
export interface OwnerUiCapabilities{
 schema:'sentinel-owneruicapabilities/draft-1';apiRevision:1;storeId:Id;epoch:Id;
 operations:['owner-ui.pair','owner-ui.revoke','owner-ui.context','owner-ui.preview','owner-ui.accept','owner-ui.status','owner-ui.resume','owner-ui.cancel','owner-ui.control-preview','owner-ui.control'];
 receiptSchema:'sentinel-owneruireceipt/draft-1';settingsSave:false;modelAdmission:false;
}
