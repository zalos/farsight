// Local owner executable only. No service/MCP JSON can select this module's actor or confirmation authority.
import { resolve } from 'node:path';
import { STRINGS } from '@farsight/core/dist/strings.js';
import type { DecisionPageEnvelope } from '../contracts/index.js';
import type { ParsedCommand } from '../cli/args.js';
import { result, type CommandResult } from '../cli/outcome.js';
import { assertMayConfirm } from '../cli/actor.js';
import { openStore, type SentinelStore } from '../store/index.js';
import { digestOf } from '../store/ledger-json.js';
import { importOwnerContext, ownerContextOf, currentImportPolicy } from '../evidence/owner-context.js';
import { OWNER, printed, type Workspace } from '../service/local.js';
import { admit } from '../policy/admission.js';
import { issueReceipt } from '../policy/owner-receipts.js';
import { readImportFile } from '../imports/bounded-file.js';
import { parseStrictJson } from '../imports/strict-json.js';
import { ImportBudget } from '../imports/types.js';
import { validateEnvelope } from '../validate.js';
import { acceptedFindingBasisFor, acceptedFindingOf, revalidateFindingRecord } from './decision-basis.js';
import { appendOwnerDecision, checkedOwnerInput, prepareOwnerProposal, readOwnerHistory, ownerHistoryOf, type OwnerProposal } from './owner-journal.js';
import { decisionProjection } from './owner-evaluation.js';

export const DECISION_CLI_LIMITS=Object.freeze({inputBytes:64*1024,outputBytes:32*1024*1024,defaultPage:50,maxPage:100,cursorBytes:512});
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DECISION=/^decision-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refused=(command:string,code:string)=>result(command,'refused',{reasonCode:'sentinel.decision.'+code});
export interface OwnerDecisionOutput {readonly result:CommandResult}
export function decisionWire(output:OwnerDecisionOutput,json:boolean):{result:CommandResult;text:string}{
  const encode=(r:CommandResult)=>json?JSON.stringify(r)+'\n':[
    r.reasonCode?(STRINGS as any)[r.reasonCode]?.professional:(STRINGS as any)['sentinel.outcome.'+r.outcome.replace(/-([a-z])/g,(_,c:string)=>c.toUpperCase())]?.professional,
    typeof r.facts.decisionId==='string'&&DECISION.test(r.facts.decisionId)?(STRINGS as any)['sentinel.decision.identifier'].professional.replace('{id}',r.facts.decisionId):undefined,
    r.facts.document?JSON.stringify(r.facts.document,null,2):undefined,
  ].filter(x=>x!==undefined).join('\n')+'\n';
  let r=output.result,text=encode(r);
  if(Buffer.byteLength(text)>DECISION_CLI_LIMITS.outputBytes){
    const facts:Record<string,unknown>={delivery:'refused'};for(const k of ['decisionId','publication'])if(Object.hasOwn(r.facts,k))facts[k]=r.facts[k];
    r=result(r.command,'delivery-failed',{reasonCode:'sentinel.decision.deliveryRefused',facts});text=encode(r);
  }
  return{result:r,text};
}
function page(context:ReturnType<typeof importOwnerContext>,runId:string,after:string|undefined,limit:number):DecisionPageEnvelope{
  const c=ownerContextOf(context),run=c.store.ledger.getRun(runId);if(!run||run.state!=='completed')throw Error('run unavailable');
  const history=readOwnerHistory(context),actual=ownerHistoryOf(history),binding=digestOf({storeId:c.store.storeId,workspace:c.workspaceDigest,runId,revision:run.planRevision,head:actual.head});
  let cursor:string|undefined;
  if(after!==undefined){
    if(after.length>DECISION_CLI_LIMITS.cursorBytes||!/^[A-Za-z0-9_-]+$/.test(after))throw Error('cursor invalid');
    const bytes=Buffer.from(after,'base64url');if(bytes.toString('base64url')!==after)throw Error('cursor invalid');const v=JSON.parse(bytes.toString('utf8'));
    if(!v||Object.keys(v).sort().join('|')!=='after|binding|schema'||v.schema!=='decision-page/1'||v.binding!==binding||!DECISION.test(v.after))throw Error('cursor invalid');cursor=v.after;
  }
  const all=[...actual.proposals.values()].filter(p=>p.basis.ancestor.runId===runId&&p.basis.ancestor.revision===run.planRevision).sort((a,b)=>a.id.localeCompare(b.id));
  if(cursor&&!all.some(p=>p.id===cursor))throw Error('cursor unavailable');const selected=all.filter(p=>!cursor||p.id>cursor).slice(0,limit+1),more=selected.length>limit,rows=selected.slice(0,limit);
  const doc:DecisionPageEnvelope={schema:'sentinel-decision-page/draft-1',authority:'metadata-only-not-evaluated',items:rows.map(p=>({id:p.id,findingId:p.basis.findingId,approval:actual.approved.has(p.id)?'approved':'proposed',availability:'not-evaluated'})),
    next:more?Buffer.from(JSON.stringify({schema:'decision-page/1',binding,after:rows.at(-1)!.id})).toString('base64url'):null,
    count:{n:rows.length,unit:'sentinel.decision.operations',scope:'sentinel.decision.pageScope',source:'bounded owner-decision metadata page',recheck:{cli:'farsight-sentinel decision list '+runId+' --json'}}};
  if(!validateEnvelope('decisionpage',doc).ok)throw Error('page unavailable');ownerHistoryOf(history);ownerContextOf(context);return doc;
}
/** Proposal reads follow current shared-policy preflight; busy/denied paths never read the caller's file. */
export async function ownerDecisionCommand(ws:Workspace,p:ParsedCommand):Promise<OwnerDecisionOutput>{
  const action=p.args.action,target=p.args.target,command='decision.'+action,val=(k:string)=>typeof p.flags[k]==='string'?p.flags[k] as string:undefined;
  const findingId=val('--finding'),baseline=val('--baseline'),file=val('--proposal'),confirm=p.flags['--confirm']===true;
  const limit=val('--limit')===undefined?DECISION_CLI_LIMITS.defaultPage:Number(val('--limit'));
  if(!target||!['propose','approve','read','list'].includes(action??'')||!ID.test(target)||(baseline!==undefined&&!ID.test(baseline))||!Number.isSafeInteger(limit)||limit<1||limit>DECISION_CLI_LIMITS.maxPage
    ||(action==='propose'&&(!file||!findingId||!/^finding\.[0-9a-f]{40}$/.test(findingId)))||((action==='approve'||action==='read')&&!DECISION.test(target)))return{result:refused(command,'inputRefused')};
  let store:SentinelStore;try{store=await openStore(ws.storePath)}catch(e){return{result:refused(command,(e as any)?.code==='sentinel.store.ownedElsewhere'?'ownerBusy':'unavailable')}}
  const timing={signal:new AbortController().signal,deadlineAt:performance.now()+120000};
  let metadata:Record<string,unknown>={publication:'not-established'};
  try{
    const preflight=importOwnerContext(store,ws,timing);
    if(action==='list')return{result:result(command,'read',{facts:{availability:'not-evaluated',document:page(preflight,target,val('--after'),limit)}})};
    let proposal:OwnerProposal,basis:Awaited<ReturnType<typeof acceptedFindingBasisFor>>;
    if(action==='propose'){
      const selectedRun=store.ledger.getRun(target);if(!selectedRun||selectedRun.state!=='completed')throw Error('run unavailable');
      const policy=currentImportPolicy(preflight),intent={action:'disposition.propose' as const,input:digestOf({preflight:'source-decision',runId:target,findingId}),effects:['local-artifacts' as const],budget:{maxTokens:null,maxCost:null,currency:null},scope:{profile:selectedRun.envelope.requestedScope.profile,provider:null,targets:[findingId!]}};
      const check=admit({intent,stateDigest:digestOf({preflight:true,storeId:store.storeId}),policy,now:new Date(),requestedBy:OWNER,
        capability:()=>({available:true,detail:'bounded local owner decision'}),credential:()=>({basis:'local-only',detail:'no provider or target is contacted'})});
      if(check.record.outcome==='denied')return{result:result(command,'refused',{reasonCode:check.record.verdicts.policy.reasonCode,verdicts:printed(check.record)})};
      ownerContextOf(preflight);const budget=new ImportBudget({rawBytes:DECISION_CLI_LIMITS.inputBytes});
      const input=checkedOwnerInput(parseStrictJson(readImportFile(resolve(file!),DECISION_CLI_LIMITS.inputBytes,budget),budget).value);ownerContextOf(preflight);
      basis=await acceptedFindingBasisFor(store,ws,target,findingId!,timing);
      proposal=await prepareOwnerProposal(basis,ws,input,new Date());
    }else{
      const h=readOwnerHistory(preflight),saved=ownerHistoryOf(h).proposals.get(target);if(!saved)throw Error('decision unavailable');proposal=saved;
      basis=await revalidateFindingRecord(store,ws,proposal.basis,timing);ownerHistoryOf(h);
    }
    const context=acceptedFindingOf(basis).context;
    if(action==='read'){
      const h=readOwnerHistory(context),document=await decisionProjection(h,basis,ws,proposal.id,new Date(),baseline);
      return{result:result(command,'read',{facts:{document,decisionId:proposal.id}})};
    }
    const operation=action==='propose'?'disposition.propose':'disposition.approve';
    metadata={decisionId:proposal.id,publication:'unknown'};
    let done=await appendOwnerDecision(context,basis,ws,proposal,operation,new Date());
    if(done.status==='denied')return{result:result(command,'refused',{reasonCode:done.admission.verdicts.policy.reasonCode,verdicts:printed(done.admission)})};
    if(done.status==='awaiting-confirmation'){
      if(!confirm)return{result:result(command,'awaiting-confirmation',{verdicts:printed(done.admission),facts:{authority:'owner-adjudication-of-accepted-source'}})};
      assertMayConfirm(OWNER);acceptedFindingOf(basis);
      const issued=issueReceipt(ownerContextOf(context).receipts,OWNER,done.binding,{now:new Date(),ttlMs:60000});
      metadata={decisionId:proposal.id,publication:'unknown'};
      done=await appendOwnerDecision(context,basis,ws,proposal,operation,new Date(),issued.id);
    }
    if(done.status!=='proposed'&&done.status!=='applied')throw Error('decision unavailable');
    metadata={decisionId:proposal.id,publication:'retained'};
    const document=await decisionProjection(readOwnerHistory(context),basis,ws,proposal.id,new Date(),baseline);
    return{result:result(command,done.status,{facts:{...metadata,reused:done.reused,document}})};
  }catch(error){
    const cause=(error as {code?:unknown})?.code;
    const allowed=['sentinel.decision.invalidInput','sentinel.decision.corruptHistory','sentinel.decision.staleState','sentinel.decision.notFound','sentinel.decision.scopeExceeded','sentinel.decision.unauthorized'];
    if(metadata.publication==='retained')return{result:result(command,'delivery-failed',{reasonCode:'sentinel.decision.deliveryRefused',facts:metadata})};
    const code=metadata.publication!=='not-established'?'sentinel.decision.publicationUncertain':typeof cause==='string'&&allowed.includes(cause)?cause:'sentinel.decision.unavailable';
    return{result:result(command,'refused',{reasonCode:code,facts:metadata})};
  }finally{try{store.close()}catch{/* Closing cannot roll back an appended owner record. */}}
}
