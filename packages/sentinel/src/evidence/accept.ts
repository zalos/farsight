// Private trusted-local report-import pipeline. Public CLI/producer/deep/mitigation entrypoints remain absent.
import type { ActionIntent } from '../contracts/index.js';
import { retainedSourceForAdmission, type ProofTiming, type RetainedSourceAncestor } from '../execution/retained-source.js';
import { readImportFile } from '../imports/bounded-file.js';
import { ImportBudget, ImportRefusal } from '../imports/types.js';
import { admit } from '../policy/admission.js';
import type { Workspace } from '../service/local.js';
import type { SentinelStore } from '../store/index.js';
import { evidenceLedgerFor } from '../store/evidence-binding.js';
import { digestOf } from '../store/ledger-json.js';
import { admissionRequest, auditUnavailable, forecastAdmission } from './audit.js';
import { importOwnerContext, currentImportPolicy, ownerContextOf } from './owner-context.js';
import { prepareOwnedReportImport, reportImportBinding, draftReportPublication, sealReportPublication, publicationBytes, readEvidencePermit } from './import-operation.js';
import { validateAcceptedImport, reportImportView } from './reader.js';
import { evidencePoint } from './test-hooks.js';

/** Exact shape before hashing or policy lookup; none of the report's context claims fill this anchor. */
function ancestorOf(value:RetainedSourceAncestor):RetainedSourceAncestor {
  const keys=['runId','revision','planDigest','snapshotId','sourceId'];
  if(!value||typeof value!=='object'||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k))
    ||!Number.isSafeInteger(value.revision)||value.revision<1||!/^sha256:[0-9a-f]{64}$/.test(value.planDigest)) auditUnavailable();
  for(const v of [value.runId,value.snapshotId,value.sourceId]) if(typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)) auditUnavailable();
  return Object.freeze({runId:value.runId,revision:value.revision,planDigest:value.planDigest,snapshotId:value.snapshotId,sourceId:value.sourceId});
}
/** ws is the trusted existing Workspace selected by local/OwnerService, never any input report/root JSON. */
export async function acceptReportImportFiles(store:SentinelStore,ws:Workspace,ancestorIn:RetainedSourceAncestor,
  files:{reportPath:string;manifestPath:string},options:{timing:ProofTiming;receiptId?:string;predecessorId?:string;baselineRunId?:string}) {
  const context=importOwnerContext(store,ws,options.timing),c=ownerContextOf(context),ancestor=ancestorOf(ancestorIn),policy=currentImportPolicy(context);
  const run=store.ledger.getRun(ancestor.runId);if(!run) auditUnavailable();
  const preflight:ActionIntent={action:'evidence.import',input:digestOf({domain:'report-import-preflight',storeId:store.storeId,workspaceDigest:c.workspaceDigest,ancestor}),
    effects:['local-artifacts'],budget:{maxTokens:null,maxCost:null,currency:null},scope:{profile:run.envelope.requestedScope.profile,provider:null,targets:['report-import',ancestor.runId,`revision:${ancestor.revision}`,ancestor.sourceId]}};
  const before=admit(admissionRequest(context,{intent:preflight,stateDigest:policy.revision,policyRevision:policy.revision},new Date()));
  if(before.record.outcome==='denied') return {status:'denied' as const,admission:before.record};
  // Every confirmation call gets a fresh proof and frozen file read BEFORE consume. An older timed-out proof is
  // never extended, even when the candidate bytes happen to be unchanged.
  const proof=await retainedSourceForAdmission(store,ancestor,{signal:c.signal,deadlineAt:c.deadlineAt});ownerContextOf(context);
  let report:Buffer,manifest:Buffer;
  try {
    const budget=new ImportBudget();manifest=readImportFile(files.manifestPath,budget.limits.manifestBytes,budget);ownerContextOf(context);
    report=readImportFile(files.reportPath,budget.limits.rawBytes,budget);ownerContextOf(context);
  } catch(error) {if(error instanceof ImportRefusal) return {status:'refused' as const,code:error.code,pointer:error.pointer};throw error;}
  const prepared=prepareOwnedReportImport(context,proof,ancestor,report,manifest),binding=reportImportBinding(prepared),ops=evidenceLedgerFor(store);
  const existing=ops.acceptance(binding.intent.input);
  if(existing) {
    const accepted=await validateAcceptedImport(context,binding.intent.input),view=await reportImportView(accepted,{...(options.baselineRunId?{baselineRunId:options.baselineRunId}:{})});
    return {status:'accepted' as const,reused:true,candidateDigest:existing.candidateDigest,root:existing.root,view};
  }
  const head=ops.head(digestOf({domain:'report-import',storeId:store.storeId,ancestor}));
  if(head) await validateAcceptedImport(context,head);ownerContextOf(context);
  const now=new Date(),request=admissionRequest(context,binding,now),preview=admit(request);
  if(preview.record.outcome==='denied'||!options.receiptId) return {status:preview.record.outcome as 'denied'|'awaiting-confirmation',binding,admission:preview.record};
  const forecast=forecastAdmission(context,binding,options.receiptId,now),draft=draftReportPublication(prepared,forecast.receipt,forecast.admission);
  // No await/file read sits between the final owner/context/head recheck and shared admission spending.
  reportImportBinding(prepared);currentImportPolicy(context,binding.policyRevision);
  const admitted=admit({...request,receipt:{book:c.receipts,id:options.receiptId}});
  if(admitted.record.outcome!=='admitted'||!admitted.receipt) auditUnavailable();
  let operationId:string|undefined;
  try {
    evidencePoint('after-spend');
    const permit=sealReportPublication(draft,admitted.receipt,admitted.record),identity=readEvidencePermit(permit,c.owner);operationId=identity.id;
    if(options.predecessorId) ops.transfer(permit,options.predecessorId);else {ops.begin(permit);evidencePoint('after-operation');ops.stage(permit);}
    evidencePoint('after-stage');
    const payload=publicationBytes(permit),receipts=[];
    for(const [id,bytes] of payload) {
      currentImportPolicy(context,binding.policyRevision);
      const receipt=await store.objects.put(bytes,{expect:{id,rawSize:bytes.length}});ownerContextOf(context);currentImportPolicy(context,binding.policyRevision);
      const check=await store.objects.read(receipt);ownerContextOf(context);
      if(!check.equals(bytes)) auditUnavailable();receipts.push(receipt);
    }
    evidencePoint('after-objects');
    const publication=ops.publish(permit,receipts);evidencePoint('after-commit');
    const accepted=await validateAcceptedImport(context,publication.candidateDigest),view=await reportImportView(accepted,{...(options.baselineRunId?{baselineRunId:options.baselineRunId}:{})});
    currentImportPolicy(context,binding.policyRevision);evidencePoint('before-reply');ownerContextOf(context);
    return {status:'accepted' as const,reused:false,candidateDigest:publication.candidateDigest,root:publication.root,view};
  } catch {
    // Once spent, no retry can reconstruct a capability from receipt/staging JSON. If ownership or commit status
    // is uncertain, do not claim non-publication. A subsequent retained read may prove a committed acceptance.
    try {
      ownerContextOf(context);
      if(ops.acceptance(binding.intent.input)) return {status:'publicationUnknown' as const,candidateDigest:binding.intent.input,receiptDigest:admitted.receipt.digest};
      return {status:'spentNotPublished' as const,candidateDigest:binding.intent.input,receiptDigest:admitted.receipt.digest,...(operationId?{operationId}:{})};
    } catch {return {status:'publicationUnknown' as const,candidateDigest:binding.intent.input,receiptDigest:admitted.receipt.digest};}
  }
}
