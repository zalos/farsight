// Actual owner CLI only. Connects to the existing service; never starts one or opens a competing local store.
// The private last key is data, persisted before acceptance so a lost ACK can be looked up without replay.
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {canonicalJsonBytes} from '../store/objects.js';
import {canonicalDigest} from '../policy/digest.js';
import {loadPolicyInputsReadOnly,workspaceIdentity} from '../policy/adoption.js';
import {effectivePolicy} from '../policy/settings.js';
import {admitRequiringReceipt} from '../policy/admission.js';
import {issueReceipt} from '../policy/owner-receipts.js';
import {ReceiptBook} from '../policy/receipts.js';
import {readPrivateFile,writePrivateFileAtomic} from '../policy/user-state.js';
import {assertMayConfirm} from '../cli/actor.js';
import {result,type CommandResult} from '../cli/outcome.js';
import type {PreparationConfirmation,PreparationOutcome} from '../contracts/preparation.js';
import {connectService} from './owner-service.js';
import {OWNER,printed,type Workspace} from './local.js';
import {preparationCapabilities,configurationPreview,preparationOutcome} from './preparation-projection.js';
import {PreparationError} from './preparation-clock.js';
import {preparationKeyLock} from './preparation-key-lock.js';
const KEY=/^[A-Za-z0-9_-]{16,128}$/;
const invalid=():never=>{throw new PreparationError('sentinel.preparation.invalid');};
const bookFor=(ws:Workspace)=>new ReceiptBook(join(ws.trustDir,'receipts'));
function savedPath(ws:Workspace,storeId:string):string{return`preparation-client-${canonicalDigest({workspace:workspaceIdentity(ws.path),storeId}).slice(7)}.json`;}
function savedKey(ws:Workspace,storeId:string):string|null{
 const bytes=readPrivateFile(join(ws.trustDir,savedPath(ws,storeId)),1024,'sentinel.receipt.storeUnsafe',{repairTemporaryAliases:false});if(!bytes)return null;
 let v:any;try{v=JSON.parse(bytes.toString('utf8'));}catch{return invalid();}
 if(!v||Object.keys(v).sort().join(',')!=='requestKey,savedAt,schema,storeId,workspaceIdentity'||v.schema!=='sentinel-preparation-client/1'||v.storeId!==storeId||v.workspaceIdentity!==workspaceIdentity(ws.path).digest
  ||typeof v.requestKey!=='string'||!KEY.test(v.requestKey)||typeof v.savedAt!=='string'||!Number.isFinite(Date.parse(v.savedAt))||!canonicalJsonBytes(v).equals(bytes))return invalid();return v.requestKey;
}
function saveKey(ws:Workspace,storeId:string,key:string):void{
 const bytes=canonicalJsonBytes({schema:'sentinel-preparation-client/1',storeId,workspaceIdentity:workspaceIdentity(ws.path).digest,requestKey:key,savedAt:new Date().toISOString()});
 if(bytes.length>1024)return invalid();writePrivateFileAtomic(ws.trustDir,savedPath(ws,storeId),bytes,'sentinel.receipt.storeUnsafe');
}
function project(value:PreparationOutcome,extra:Record<string,unknown>={}):CommandResult{
 return result('prepare',value.outcome,{verdicts:value.verdicts,...(value.reasonCode?{reasonCode:value.reasonCode}:{}),facts:{...(value.status??{}),...(value.joined===undefined?{}:{joined:value.joined}),...extra}});
}
function confirm(ws:Workspace,binding:PreparationConfirmation,enabled:boolean):{receiptId:string}|{refusal:CommandResult}{
 const inputs=loadPolicyInputsReadOnly({workspace:ws.path,trustDir:ws.trustDir});if(inputs.trust!=='adopted')throw new PreparationError('sentinel.preparation.unavailable');
 const policy=effectivePolicy(inputs);if(policy.revision!==binding.policyRevision)throw new PreparationError('sentinel.preparation.changed');
 const now=new Date(),decision=admitRequiringReceipt({intent:binding.intent,stateDigest:binding.stateDigest,policy,requestedBy:OWNER,now,
  capability:()=>({available:true,detail:'exact running owner service preparation binding'}),credential:()=>({basis:'local-only',detail:'no provider is used'})});
 if(decision.record.outcome==='denied')return{refusal:result('prepare','configuration-failure',{verdicts:printed(decision.record),reasonCode:decision.record.verdicts.policy.allowed?decision.record.verdicts.capability.reasonCode:decision.record.verdicts.policy.reasonCode})};
 if(!enabled)return{refusal:result('prepare','awaiting-confirmation',{verdicts:printed(decision.record)})};
 assertMayConfirm(OWNER);return{receiptId:issueReceipt(bookFor(ws),OWNER,binding,{now,ttlMs:600000}).id};
}
export async function prepareCommand(ws:Workspace,options:{action?:string;confirm:boolean;requestKey?:string;parentId?:string}):Promise<CommandResult>{
 const action=options.action??'accept';if(!['accept','preview','status','resume','cancel'].includes(action)||options.requestKey!==undefined&&!KEY.test(options.requestKey)
  ||['status','resume','cancel'].includes(action)&&options.parentId!==undefined||['preview','status'].includes(action)&&options.confirm)return invalid();
 const client=await connectService(ws,'cli');if(!client)return result('prepare','unavailable',{reasonCode:'sentinel.service.operationUnavailable'});
 let dispatched=false;let lock:Awaited<ReturnType<typeof preparationKeyLock>>|undefined;
 try{
  const offered=preparationCapabilities(await client.request('service.preparation-capabilities',{}));if(offered.storeId!==client.storeId)return invalid();
  // Only the explicit real owner confirmation path creates the mutex; unconfirmed preview remains read-only.
  // The mutex stores no approval, receipt or preparation data.
  if(action==='accept'&&options.confirm)lock=await preparationKeyLock(ws.trustDir,savedPath(ws,client.storeId));
  const key=options.requestKey??(['accept','preview'].includes(action)?`request-${randomBytes(16).toString('hex')}`:savedKey(ws,client.storeId));
  if(!key)throw new PreparationError('sentinel.preparation.unavailable');
  if(action==='accept'&&lock){
   const previous=savedKey(ws,client.storeId);
   if(previous){
    const old=preparationOutcome(await client.request('prepare.status',{requestKey:previous}));lock.assertHeld();
    if(!old.status?.found)throw new PreparationError('sentinel.preparation.unavailable');
    if(previous===key){if(options.parentId!==undefined)throw new PreparationError('sentinel.preparation.changed');return project({...old,outcome:'kept'},{requestKeySaved:true});}
    const status=old.status,linked=status.phase==='prepared'&&options.parentId!==undefined&&options.parentId===status.runId;
    if(!linked&&(status.captured||!['interrupted','failed','canceled'].includes(status.phase)))
     return project({...old,outcome:status.phase==='prepared'?'kept':'refused',reasonCode:status.phase==='prepared'?'sentinel.preparation.alreadyPrepared':'sentinel.preparation.busy'},{requestKeySaved:true});
   }
  }
  if(action==='status')return project(preparationOutcome(await client.request('prepare.status',{requestKey:key})));
  if(action==='resume'||action==='cancel'){
   const status=preparationOutcome(await client.request('prepare.status',{requestKey:key}),true);
   if(!status.status?.found)throw new PreparationError('sentinel.preparation.unavailable');
   const binding=status.status.confirmation?.[action];if(!binding)throw new PreparationError('sentinel.preparation.unavailable');
   const decided=confirm(ws,binding,options.confirm);if('refusal'in decided)return decided.refusal;
   dispatched=true;return project(preparationOutcome(await client.request(`prepare.${action}`,{requestKey:key,receiptId:decided.receiptId})),{requestKeySaved:options.requestKey===undefined});
  }
  const preview=configurationPreview(await client.request('configuration.preview',{requestKey:key,...(options.parentId?{parentId:options.parentId}:{})}),true);
  if(action==='preview')return result('prepare','answered',{facts:{preview:configurationPreview(preview),...(options.requestKey===undefined?{generatedRequestKey:key}:{})}});
  if(!preview.confirmation)return invalid();
  const decided=confirm(ws,preview.confirmation,options.confirm);if('refusal'in decided)return decided.refusal;
  // Owner explicitly confirmed this exact binding. Save discovery data before the write, not after its ACK.
  lock?.assertHeld();saveKey(ws,client.storeId,key);dispatched=true;
  return project(preparationOutcome(await client.request('prepare.accept',{previewId:preview.id,requestKey:key,receiptId:decided.receiptId})),{requestKeySaved:true});
 }catch(error){
  if(dispatched)return result('prepare','configuration-failure',{reasonCode:'sentinel.preparation.outcomeUnknown'});
  if(error instanceof PreparationError)return result('prepare','configuration-failure',{reasonCode:error.code});
  const code=(error as{code?:unknown})?.code;if(code==='sentinel.service.unknownOperation')return result('prepare','unavailable',{reasonCode:'sentinel.service.operationUnavailable'});throw error;
 }finally{try{lock?.close();}finally{client.close();}}
}
