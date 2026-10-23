// Owner executable only. No IPC/MCP handler calls this module, and request JSON cannot select its actor.
import { resolve } from 'node:path';
import type { ImportViewEnvelope, ImportPageEnvelope, ReportCount } from '../contracts/index.js';
import type { ParsedCommand } from '../cli/args.js';
import { result, type CommandResult } from '../cli/outcome.js';
import { assertMayConfirm } from '../cli/actor.js';
import { openStore, type SentinelStore } from '../store/index.js';
import { evidenceLedgerFor } from '../store/evidence-binding.js';
import { digestOf } from '../store/ledger-json.js';
import { issueReceipt } from '../policy/owner-receipts.js';
import { loadPlan } from '../execution/plans.js';
import type { ProofTiming, RetainedSourceAncestor } from '../execution/retained-source.js';
import { OWNER, receiptBook, printed, type Workspace } from '../service/local.js';
import { writeNewFile } from '../service/full-report.js';
import { validateEnvelope } from '../validate.js';
import { sentinelServiceWord } from '@farsight/core/dist/strings-sentinel-service.js';
import { sentinelWord, SENTINEL_CLI_STRINGS } from '@farsight/core/dist/strings-sentinel-cli.js';
import { acceptReportImportFiles } from './accept.js';
import { abandonReportImport } from './abandon.js';
import { readAcceptedReportImport } from './reader.js';
import { importOwnerContext, ownerContextOf } from './owner-context.js';

export const IMPORT_CLI_LIMITS=Object.freeze({ackBytes:16*1024,outputBytes:32*1024*1024,defaultPage:50,maxPage:100,cursorBytes:512});
class OutputLimitError extends Error {constructor(){super('import output too large')}}
const DIGEST=/^sha256:[0-9a-f]{64}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const generatedOperation=/^evidence-[0-9a-f-]{36}$/;
type Phase='preflight'|'proof'|'input'|'receipt'|'operation'|'stage'|'object'|'publication'|'readback'|'abandon';
const reason=(name:string)=>`sentinel.evidence.${name}`;
function refused(command:string,code:string,phase:Phase='preflight',facts:Record<string,unknown>={}):CommandResult {
  return result(command,'refused',{reasonCode:reason(code),facts:{phase,...facts}});
}
function count(n:number,unit:string):ReportCount{return{n,unit,scope:'sentinel.evidence.countScope',source:'accepted report-import normalized projection'}}
export function publicImportView(view:Awaited<ReturnType<typeof readAcceptedReportImport>>):ImportViewEnvelope {
  const doc:ImportViewEnvelope={...view,kind:'imported-report',authority:'owner-associated-imported-claims',disclosure:'owner-local',limitation:view.limitation as ImportViewEnvelope['limitation'],schema:'sentinel-import-view/draft-1',limitationKey:'sentinel.evidence.importedClaims',
    counts:{claims:count(view.counts.claims,'sentinel.evidence.claims'),exchanges:count(view.counts.exchanges,'sentinel.evidence.exchanges'),cookies:count(view.counts.cookies,'sentinel.evidence.cookies')}};
  for(const c of Object.values(doc.counts)){c.source=`accepted report import ${doc.candidateDigest}`;c.recheck={cli:`farsight-sentinel evidence read ${doc.candidateDigest} --json`};}
  if(!validateEnvelope('importview',doc).ok)throw Error('import projection unavailable');return doc;
}
/** Bounded readable JSON. Expansion is counted while constructing, before delivery or export. */
function prettyJson(value:unknown):string {
  const parts:string[]=[];let bytes=0;
  const add=(text:string)=>{bytes+=Buffer.byteLength(text);if(bytes>IMPORT_CLI_LIMITS.outputBytes)throw new OutputLimitError();parts.push(text)};
  const visit=(v:any,depth:number)=>{
    if(depth>96)throw new OutputLimitError();
    if(v===null||typeof v!=='object'){add(JSON.stringify(v).replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029'));return;}
    const array=Array.isArray(v),keys=array?v.map((_:unknown,i:number)=>i):Object.keys(v);
    add(array?'[':'{');
    for(let n=0;n<keys.length;n++){add((n?',':'')+'\n'+'  '.repeat(depth+1));const key=keys[n]!;if(!array)add(JSON.stringify(key)+': ');visit(v[key],depth+1);}
    if(keys.length)add('\n'+'  '.repeat(depth));add(array?']':'}');
  };
  visit(value,0);return parts.join('');
}
/** Called only after exact retained authority/privacy validation. These are owner-local projections. */
export function renderImportDocument(document:ImportViewEnvelope|ImportPageEnvelope,format:'json'|'md'):string {
  const raw=prettyJson(document);if(format==='json')return raw;
  const counts='counts'in document?Object.values(document.counts):[document.count];
  const tips=counts.map(c=>`${sentinelWord(c.unit,{n:c.n})} (${sentinelWord(c.scope)}). ${SENTINEL_CLI_STRINGS[c.unit]!.define}`).join('\n');
  const parts=[`${sentinelWord('sentinel.evidence.importedClaims')}\n\n${tips}\n\n`];let size=Buffer.byteLength(parts[0]!);
  // CommonMark indented code is inert; entity escaping here would corrupt the retained strings.
  for(const line of raw.split('\n')){const part='    '+line+'\n';size+=Buffer.byteLength(part);if(size>IMPORT_CLI_LIMITS.outputBytes)throw new OutputLimitError();parts.push(part);}
  return parts.join('');
}
async function ancestorFor(store:SentinelStore,runId:string,sourceId:string):Promise<RetainedSourceAncestor>{
  const run=store.ledger.getRun(runId);
  if(!run||run.state!=='completed'||!run.envelope.requestedScope.sourceIds.includes(sourceId))throw Error('source unavailable');
  const {plan}=await loadPlan(store,runId,run.planRevision);
  const retained=store.ledger.getPlan(runId,run.planRevision);
  if(!retained||plan.pins.snapshotId!==run.envelope.snapshotId||plan.digest!==retained.digest)throw Error('source unavailable');
  return{runId,revision:run.planRevision,planDigest:retained.digest,snapshotId:run.envelope.snapshotId,sourceId};
}
function bindingDigest(store:SentinelStore,ancestor:RetainedSourceAncestor){return digestOf({domain:'report-import',storeId:store.storeId,ancestor})}
function decodeCursor(text:string|undefined,binding:string):string|null {
  if(text===undefined)return null;
  if(text.length>IMPORT_CLI_LIMITS.cursorBytes||!/^[A-Za-z0-9_-]+$/.test(text))throw Error('cursor refused');
  const decoded=Buffer.from(text,'base64url');if(decoded.toString('base64url')!==text)throw Error('cursor refused');
  const v=JSON.parse(decoded.toString('utf8'));
  if(!v||Object.keys(v).sort().join('|')!=='after|binding|schema'||v.schema!=='evidence-page/1'||v.binding!==binding||typeof v.after!=='string'||!generatedOperation.test(v.after))throw Error('cursor refused');
  return v.after;
}
function page(store:SentinelStore,ancestor:RetainedSourceAncestor,after:string|undefined,limit:number):ImportPageEnvelope {
  const binding=bindingDigest(store,ancestor),cursor=decodeCursor(after,binding),rows=evidenceLedgerFor(store).page(binding,cursor,limit+1),more=rows.length>limit;
  const selected=rows.slice(0,limit);
  if(selected.some(r=>!generatedOperation.test(r.operationId)))throw Error('page unavailable');
  const doc:ImportPageEnvelope={schema:'sentinel-import-page/draft-1',authority:'metadata-only-not-evaluated',items:selected.map(r=>({...r,availability:'not-evaluated'})),
    next:more?Buffer.from(JSON.stringify({schema:'evidence-page/1',binding,after:selected.at(-1)!.operationId})).toString('base64url'):null,
    count:{...count(selected.length,'sentinel.evidence.operations'),scope:'sentinel.evidence.pageScope',source:'bounded report-import metadata page'}};
  if(!validateEnvelope('importpage',doc).ok)throw Error('page unavailable');return doc;
}
function ack(command:string,outcome:Parameters<typeof result>[1],facts:Record<string,unknown>,reasonCode?:string):CommandResult {
  const value=result(command,outcome,{facts,...(reasonCode?{reasonCode:reason(reasonCode)}:{})});
  if(Buffer.byteLength(JSON.stringify(value))>IMPORT_CLI_LIMITS.ackBytes)throw Error('ack unavailable');return value;
}
export interface EvidenceCliOutput {readonly result:CommandResult;readonly text?:string}
/** The actual wire bytes, including wrapper/heading/newline, share ONE output cap. No pretty-print expansion. */
export function evidenceWire(output:EvidenceCliOutput,json:boolean):{result:CommandResult;text:string} {
  const serialize=(r:CommandResult,body?:string)=>{
    if(json)return JSON.stringify(r)+'\n';
    const head=sentinelServiceWord(`sentinel.outcome.${r.outcome.replace(/-([a-z])/g,(_,c:string)=>c.toUpperCase())}`);
    const candidate=typeof r.facts.candidateDigest==='string'&&DIGEST.test(r.facts.candidateDigest)?sentinelWord('sentinel.evidence.candidate',{candidate:r.facts.candidateDigest}):undefined;
    return [body,head+(r.reasonCode?': '+sentinelWord(r.reasonCode):''),candidate].filter(v=>v!==undefined).join('\n')+'\n';
  };
  let r=output.result,text=serialize(r,output.text);
  if(Buffer.byteLength(text)>IMPORT_CLI_LIMITS.outputBytes){
    const facts:Record<string,unknown>={delivery:'refused'};
    // These are metadata previously derived by the genuine writer/reader, not arbitrary input/report fields.
    for(const k of ['phase','acceptance','candidateDigest','root','reused','operationId'])if(Object.hasOwn(r.facts,k))facts[k]=r.facts[k];
    r=ack(r.command,'delivery-failed',facts,'outputTooLarge');text=serialize(r);
  }
  if(Buffer.byteLength(text)>IMPORT_CLI_LIMITS.outputBytes)throw Error('bounded acknowledgement unavailable');
  return{result:r,text};
}
/** Only the trusted owner CLI supplies ws. Same-account application code remains outside this boundary. */
export async function ownerEvidenceCommand(ws:Workspace,p:ParsedCommand):Promise<EvidenceCliOutput> {
  const action=p.args.action,target=p.args.target,command=`evidence.${action}`,value=(key:string)=>typeof p.flags[key]==='string'?p.flags[key] as string:undefined;
  const confirm=p.flags['--confirm']===true,format=value('--format')??'json',out=value('--out'),baselineRunId=value('--baseline'),sourceId=value('--source'),expect=value('--expect-candidate');
  if(!target||!['import','read','list','abandon'].includes(action??'')||!['json','md'].includes(format)||
    Object.hasOwn(p.flags,'--disclosure')||
    (baselineRunId!==undefined&&!ID.test(baselineRunId))||(expect!==undefined&&!DIGEST.test(expect))||(value('--predecessor')!==undefined&&!generatedOperation.test(value('--predecessor')!))||
    ((action==='import'||action==='list')&&(!sourceId||!ID.test(sourceId)||!ID.test(target)))||
    (action==='read'&&!DIGEST.test(target))||(action==='abandon'&&!generatedOperation.test(target))||
    (action==='import'&&(!value('--report')||!value('--manifest')||(out&&!confirm))))return{result:refused(command,'inputRefused')};
  const limit=value('--limit')===undefined?IMPORT_CLI_LIMITS.defaultPage:Number(value('--limit'));
  if(!Number.isSafeInteger(limit)||limit<1||limit>IMPORT_CLI_LIMITS.maxPage)return{result:refused(command,'inputRefused')};
  let store:SentinelStore;
  try{store=await openStore(ws.storePath)}catch(e){return{result:refused(command,(e as{code?:string})?.code==='sentinel.store.ownedElsewhere'?'ownerBusy':'storageRefused')}}
  const timing:ProofTiming={signal:new AbortController().signal,deadlineAt:performance.now()+120000};
  let phase:Phase='preflight';
  let metadata:Record<string,unknown>={acceptance:'not-established'},document:ImportViewEnvelope|ImportPageEnvelope|undefined,success:CommandResult;
  try {
    if(action==='read'){
      phase='readback';
      metadata={phase:'readback',acceptance:'not-established'};
      document=publicImportView(await readAcceptedReportImport(store,ws,target,{timing,...(baselineRunId?{baselineRunId}:{})}));
      metadata={...metadata,acceptance:'retained',candidateDigest:document.candidateDigest,root:document.root};success=ack(command,'read',metadata);
    }else if(action==='list'){
      phase='readback';
      const context=importOwnerContext(store,ws,timing),ancestor=await ancestorFor(store,target,sourceId!);ownerContextOf(context);
      document=page(store,ancestor,value('--after'),limit);ownerContextOf(context);
      success=ack(command,'read',{phase:'readback',availability:'not-evaluated'});
    }else if(action==='abandon'){
      phase='receipt';
      let preview=await abandonReportImport(store,ws,target,{timing});
      if(preview.status==='denied')return{result:result(command,'refused',{reasonCode:reason('denied'),verdicts:printed(preview.admission)})};
      if(preview.status!=='awaiting-confirmation')throw Error('abandon preview unavailable');
      if(!confirm)return{result:result(command,'awaiting-confirmation',{verdicts:printed(preview.admission),facts:{phase:'receipt',operationId:target}})};
      if(!preview.binding)throw Error('abandon unavailable');assertMayConfirm(OWNER);
      const issued=issueReceipt(receiptBook(ws),OWNER,preview.binding,{now:new Date(),ttlMs:60000});
      phase='abandon';
      const done=await abandonReportImport(store,ws,target,{timing,receiptId:issued.id});
      if(done.status!=='abandoned')return{result:refused(command,done.status==='spentNotApplied'?'spentNotApplied':'applicationUncertain','abandon',{operationId:target})};
      return{result:ack(command,'abandoned',{phase:'abandon',operationId:target,pinsReleased:true,objectBytesDeleted:false})};
    }else{
      phase='proof';
      const ancestor=await ancestorFor(store,target,sourceId!),files={reportPath:value('--report')!,manifestPath:value('--manifest')!};
      const options={timing,...(baselineRunId?{baselineRunId}:{}),...(expect?{expectCandidate:expect}:{})};
      phase='input';
      let done=await acceptReportImportFiles(store,ws,ancestor,files,options);
      if(done.status==='confirmationStale')return{result:refused(command,'confirmationStale','receipt',{candidateDigest:done.candidateDigest})};
      if(done.status==='denied')return{result:result(command,'refused',{reasonCode:reason('denied'),verdicts:printed(done.admission)})};
      if(done.status==='refused')return{result:refused(command,'inputRefused','input')};
      if(done.status==='awaiting-confirmation'){
        const candidateDigest=done.binding!.intent.input;
        if(!confirm)return{result:result(command,'awaiting-confirmation',{verdicts:printed(done.admission),facts:{phase:'receipt',candidateDigest,authority:'owner-associated-imported-claims'}})};
        phase='receipt';
        assertMayConfirm(OWNER);const issued=issueReceipt(receiptBook(ws),OWNER,done.binding!,{now:new Date(),ttlMs:60000});
        phase='publication';
        done=await acceptReportImportFiles(store,ws,ancestor,files,{...options,expectCandidate:candidateDigest,receiptId:issued.id,...(value('--predecessor')?{predecessorId:value('--predecessor')!}:{})});
      }
      if(done.status==='confirmationStale')return{result:refused(command,'confirmationStale','receipt',{candidateDigest:done.candidateDigest})};
      if(done.status!=='accepted')return{result:refused(command,done.status==='spentNotPublished'?'spentNotPublished':done.status==='publicationUnknown'&&done.acceptanceRecorded?'acceptedReadbackUnverified':'publicationUncertain','publication',
        {...('candidateDigest'in done?{candidateDigest:done.candidateDigest}:{}),...('operationId'in done?{operationId:done.operationId}:{}),acceptance:done.status==='publicationUnknown'&&done.acceptanceRecorded?'recorded-unverified':'unknown'})};
      metadata={phase:'readback',acceptance:'accepted',candidateDigest:done.candidateDigest,root:done.root,reused:done.reused};
      document=publicImportView(done.view);success=ack(command,'accepted',metadata);
    }
    let text:string;
    try{
      text=renderImportDocument(document,format as'json'|'md');
      const combined=result(success.command,success.outcome,{...('reasonCode'in success?{reasonCode:success.reasonCode}:{}),verdicts:success.verdicts,facts:{...success.facts,document}});
      // Acknowledgement has a separate small cap; fully serialized document+wrapper has the output cap.
      if(evidenceWire({result:combined,...(!p.json?{text}:{})},p.json).result.outcome==='delivery-failed')throw new OutputLimitError();
      if(out){writeNewFile(resolve(out),text);return{result:ack(command,success.outcome,{...success.facts,delivery:'written'})}}
      return{result:combined,...(!p.json?{text}:{})};
    }catch(error){return{result:ack(command,'delivery-failed',{...success.facts,delivery:'refused'},error instanceof OutputLimitError?'outputTooLarge':'deliveryRefused')}}
  }catch(error){const cause=(error as{code?:unknown})?.code;const facts=typeof cause==='string'&&['sentinel.execution.canceled','sentinel.execution.deadlineExceeded','sentinel.execution.analysisUnavailable','sentinel.receipt.expired','sentinel.receipt.mismatch','sentinel.receipt.alreadyUsed'].includes(cause)?{...metadata,cause}:metadata;return{result:metadata.acceptance==='accepted'?ack(command,'delivery-failed',{...metadata,delivery:'refused'},'deliveryRefused'):refused(command,'sourceUnavailable',phase,facts)}}
  finally{try{store.close()}catch{/* A close failure cannot roll back a verified publication or expose raw errors. */}}
}
