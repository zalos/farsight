// Explicit, receipt-bound release of one older pending import. No source proof, sweep or physical deletion.
import type { ActionIntent, AdmissionEnvelope, ReceiptEnvelope } from '../contracts/index.js';
import type { ProofTiming } from '../execution/retained-source.js';
import { admit } from '../policy/admission.js';
import { receiptAuthority, type ConsumedReceipt, type ReceiptBinding } from '../policy/receipts.js';
import { deepFreeze } from '../policy/immutable.js';
import type { Workspace } from '../service/local.js';
import type { SentinelStore } from '../store/index.js';
import type { LedgerOwner } from '../store/store-types.js';
import { evidenceLedgerFor } from '../store/evidence-binding.js';
import { canonicalJson, digestOf } from '../store/ledger-json.js';
import { admissionRequest, auditUnavailable, boundedAudit, forecastAdmission, verifyRetainedAudit } from './audit.js';
import { currentImportPolicy, importOwnerContext, ownerContextOf, type ImportOwnerContext } from './owner-context.js';
import { evidencePoint } from './test-hooks.js';

declare const brand: unique symbol;
export interface AbandonPermit { readonly [brand]: true }
export interface AbandonAudit {
  readonly domain: 'report-import'; readonly action: 'evidence.abandon'; readonly operationId: string; readonly storeId: string;
  readonly workspaceDigest: string; readonly epoch: string; readonly oldEpoch: string; readonly identityDigest: string;
  readonly stageDigest: string; readonly stages: readonly string[]; readonly receipt: ReceiptEnvelope; readonly receiptDigest: string;
  readonly intent: ActionIntent; readonly stateDigest: string; readonly policyRevision: string; readonly admission: AdmissionEnvelope;
}
const permits = new WeakMap<object, {context:ImportOwnerContext;audit:AbandonAudit;receipt:ConsumedReceipt}>();
export function readAbandonPermit(value: AbandonPermit, owner: LedgerOwner): AbandonAudit {
  const p=permits.get(value); if(!p) auditUnavailable();
  const c=ownerContextOf(p.context); currentImportPolicy(p.context,p.audit.policyRevision);
  const authority=receiptAuthority(p.receipt);
  if(c.owner!==owner || p.audit.epoch!==owner.epoch || p.audit.storeId!==owner.storeId || authority?.action!=='evidence.abandon'
    || authority.digest!==p.audit.receiptDigest || authority.intentDigest!==p.audit.receipt.intentDigest) auditUnavailable();
  return p.audit;
}
export function abandonCommitBoundary(value:AbandonPermit,owner:LedgerOwner):void {
  const p=permits.get(value); if(!p || ownerContextOf(p.context,false).owner!==owner) auditUnavailable();
  currentImportPolicy(p.context,p.audit.policyRevision,false);
}
/** Private trusted-local entrypoint. ws comes from OwnerService/local, never the report/request body. */
export async function abandonReportImport(store:SentinelStore,ws:Workspace,operationId:string,options:{timing:ProofTiming;receiptId?:string}) {
  const context=importOwnerContext(store,ws,options.timing),c=ownerContextOf(context),policy=currentImportPolicy(context);
  const target=evidenceLedgerFor(store).abandonTarget(operationId),identityDigest=digestOf(target.identity);
  const intent:ActionIntent={action:'evidence.abandon',input:digestOf({domain:'report-import',storeId:store.storeId,workspaceDigest:c.workspaceDigest,
    operationId,oldEpoch:target.epoch,identityDigest,stageDigest:target.stageDigest}),effects:['local-artifacts'],budget:{maxTokens:null,maxCost:null,currency:null},
    scope:{profile:target.identity.intent.scope.profile,provider:null,targets:['report-import-abandon',store.storeId,operationId]}};
  const binding:ReceiptBinding={intent,stateDigest:digestOf({storeId:store.storeId,epoch:store.epoch,operationId,oldEpoch:target.epoch,identityDigest,stageDigest:target.stageDigest,state:'open'}),policyRevision:policy.revision};
  const now=new Date(),request=admissionRequest(context,binding,now),preview=admit(request);
  if(preview.record.outcome==='denied' || !options.receiptId) return {status:preview.record.outcome as 'denied'|'awaiting-confirmation',binding,admission:preview.record};
  const forecast=forecastAdmission(context,binding,options.receiptId,now);
  const audit:AbandonAudit=deepFreeze({domain:'report-import',action:'evidence.abandon',operationId,storeId:store.storeId,workspaceDigest:c.workspaceDigest,
    epoch:store.epoch,oldEpoch:target.epoch,identityDigest,stageDigest:target.stageDigest,stages:target.stages.map(s=>s.stageId),
    receipt:forecast.receipt,receiptDigest:digestOf(forecast.receipt),intent,stateDigest:binding.stateDigest,policyRevision:policy.revision,admission:forecast.admission});
  boundedAudit(audit); // Complete original authority, never a truncated payload; measured before spending.
  currentImportPolicy(context,policy.revision);
  const current=evidenceLedgerFor(store).abandonTarget(operationId);
  if(current.stageDigest!==target.stageDigest || digestOf(current.identity)!==identityDigest) auditUnavailable();
  const admitted=admit({...request,receipt:{book:c.receipts,id:options.receiptId}});
  if(admitted.record.outcome!=='admitted'||!admitted.receipt||canonicalJson(admitted.record)!==canonicalJson(forecast.admission)) auditUnavailable();
  const token=Object.freeze({}) as AbandonPermit;permits.set(token,{context,audit,receipt:admitted.receipt});
  try {
    evidencePoint('after-spend');
    const result=evidenceLedgerFor(store).abandon(token);
    return {status:'abandoned' as const,operationId:result.operationId,sequence:result.sequence,receiptDigest:audit.receiptDigest};
  } catch {
    // A failed transaction never reconstitutes authority from stored receipt JSON. Fresh confirmation is needed.
    try {
      ownerContextOf(context);
      const retained=evidenceLedgerFor(store).operation(operationId);
      if(retained?.state==='open') return {status:'spentNotApplied' as const,operationId,receiptDigest:audit.receiptDigest};
    } catch { /* Ownership or terminal status is uncertain: no claim of non-application. */ }
    return {status:'applicationUnknown' as const,operationId,receiptDigest:audit.receiptDigest};
  }
}
export function readAbandonedReportImport(store:SentinelStore,ws:Workspace,operationId:string,timing:ProofTiming) {
  const context=importOwnerContext(store,ws,timing),c=ownerContextOf(context),record=evidenceLedgerFor(store).operation(operationId);
  if(!record||record.state!=='aborted'||record.terminal?.kind!=='evidence-abandoned') auditUnavailable();
  const a=record.terminal.payload as AbandonAudit;
  if(a?.action!=='evidence.abandon'||a.domain!=='report-import'||a.operationId!==operationId||a.storeId!==store.storeId||a.workspaceDigest!==c.workspaceDigest
    ||a.epoch!==record.terminal.epoch||a.oldEpoch!==record.epoch||a.identityDigest!==digestOf(record.identity)||!Array.isArray(a.stages)||a.stages.length>1) auditUnavailable();
  const expected=a.stages.map(stageId=>({stageId,epoch:record.epoch,artifacts:record.identity.artifacts.map(v=>({id:v.id,schema:v.schema,privacy:v.privacy,links:[...(v.links??[])].sort()})).sort((x,y)=>x.id<y.id?-1:1)}));
  if(a.stages.some(id=>id!==`evidence-stage-${record.identity.nonce}`)||digestOf(expected)!==a.stageDigest) auditUnavailable();
  const input=digestOf({domain:'report-import',storeId:store.storeId,workspaceDigest:c.workspaceDigest,operationId,oldEpoch:a.oldEpoch,identityDigest:a.identityDigest,stageDigest:a.stageDigest});
  const intent:ActionIntent={action:'evidence.abandon',input,effects:['local-artifacts'],budget:{maxTokens:null,maxCost:null,currency:null},
    scope:{profile:record.identity.intent.scope.profile,provider:null,targets:['report-import-abandon',store.storeId,operationId]}};
  if(canonicalJson(intent)!==canonicalJson(a.intent)||a.stateDigest!==digestOf({storeId:store.storeId,epoch:a.epoch,operationId,oldEpoch:a.oldEpoch,identityDigest:a.identityDigest,stageDigest:a.stageDigest,state:'open'})) auditUnavailable();
  verifyRetainedAudit(context,a); ownerContextOf(context);
  return Object.freeze({status:'abandoned' as const,operationId,sequence:record.terminal.sequence,receiptDigest:a.receiptDigest,auditBytes:Buffer.byteLength(canonicalJson(a))});
}
