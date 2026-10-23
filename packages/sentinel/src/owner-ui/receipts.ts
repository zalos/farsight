// Separate honest UI book; cannot return a normal CLI consumed receipt or confirm paid/configuration actions.
import{randomUUID}from'node:crypto';import type{OwnerUiReceiptEnvelope}from'../contracts/ownerui.js';
import{ReceiptReader,STORE,stamp,intentDigest,type ReceiptBinding}from'../policy/receipts.js';import{canonicalDigest}from'../policy/digest.js';import{createPrivateFileOnce}from'../policy/user-state.js';import{validateEnvelope}from'../validate.js';import{policyFail}from'../policy/errors.js';import{assertOwnerUiProof,type OwnerUiProof}from'./authority.js';
export class OwnerUiReceiptBook extends ReceiptReader<OwnerUiReceiptEnvelope>{
 constructor(directory:string,readonly proof:OwnerUiProof){assertOwnerUiProof(proof);super(directory,'owneruireceipt');}
 protected override validateIssuer(receipt:OwnerUiReceiptEnvelope){assertOwnerUiProof(this.proof,receipt.action);if(canonicalDigest(receipt.issuer)!==canonicalDigest(this.proof.issuer))policyFail('sentinel.receipt.mismatch','the browser owner session or view changed');}
}
export function issueOwnerUiReceipt(book:OwnerUiReceiptBook,binding:ReceiptBinding,now:Date):OwnerUiReceiptEnvelope{
 assertOwnerUiProof(book.proof,binding.intent.action);const action=binding.intent.action;if(!['capture.source','run.start','run.pause','run.cancel'].includes(action))return policyFail('sentinel.receipt.ownerOnly','this owner UI cannot confirm this action');
 const receipt:OwnerUiReceiptEnvelope={schema:'sentinel-owneruireceipt/draft-1',id:`receipt-${randomUUID()}`,actor:{channel:'owner-ui',principal:'human'},action:action as OwnerUiReceiptEnvelope['action'],intentDigest:intentDigest(binding.intent),stateDigest:binding.stateDigest,policyRevision:binding.policyRevision,issuer:{...book.proof.issuer},issuedAt:stamp(now),expiresAt:stamp(new Date(now.getTime()+30000))};
 if(!validateEnvelope('owneruireceipt',receipt).ok)policyFail('sentinel.receipt.ownerOnly','invalid browser owner receipt');assertOwnerUiProof(book.proof,action);if(!createPrivateFileOnce(book.directory,`${receipt.id}.json`,Buffer.from(JSON.stringify(receipt)),STORE))policyFail(STORE,'a receipt with this id already exists');return Object.freeze(receipt);
}
