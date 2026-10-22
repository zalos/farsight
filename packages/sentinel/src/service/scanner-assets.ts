// Explicit owner adoption of already-held pinned assets. Scans never acquire. Each immutable private copy and its
// provenance are bound to the spent promotion receipt, including a state digest over the exact metadata bytes.
import {createHash} from 'node:crypto';
import {constants as FS,closeSync,fstatSync,openSync,readSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import type {LockedDatabase,LockedTool,ReceiptEnvelope,RuleLockEnvelope} from '../contracts/index.js';
import {canonicalJsonBytes} from '../store/objects.js';
import {canonicalDigest} from '../policy/digest.js';
import {intentDigest,type ConsumedReceipt} from '../policy/receipts.js';
import {issueReceipt} from '../policy/owner-receipts.js';
import {admit} from '../policy/index.js';
import {validateEnvelope} from '../validate.js';
import {ContainerBackend} from '../execution/isolation.js';
import {candidateDigest,emptyLock,lockDigest,promote,promotionIntent,type PromotionCandidate} from '../rules/index.js';
import {TRIVY_CHECKS_BUNDLE} from '../adapters/trivy/adapter.js';
import {acquireAdvisorySnapshots, acquisitionIntent, MAX_ACQUISITION_BYTES} from '../adapters/osv/acquire.js';
import {acquireChecksBundle, checksAcquisitionIntent} from '../adapters/trivy/bundle.js';
import {dependencyKindOf,KIND_ECOSYSTEMS} from '../adapters/osv/job.js';
import type {PlanEnvelope} from '../contracts/plan.js';
import {adoptedPolicy,OWNER,printed,receiptBook,type Workspace} from './local.js';
import {assertMayConfirm} from '../cli/actor.js';
import {result,type CommandResult} from '../cli/outcome.js';
import {RuleLockBook} from './rule-locks.js';
import {ensureDurableDir,publishOnce,readPublished} from './publish-once.js';
import {externalDrivers} from './scanner-profile.js';
export class ScannerAssetError extends Error{constructor(readonly code:'sentinel.assets.invalid'|'sentinel.assets.missing'|'sentinel.assets.unsupported'){super(code);}}
const bad=():never=>{throw new ScannerAssetError('sentinel.assets.invalid');};
const digest=(bytes:Uint8Array)=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const MAX_ARCHIVE=512*1024*1024;
const stamp=(d:Date)=>d.toISOString().replace(/Z$/,'000000Z');
const validStamp=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{9}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v.slice(0,23)+'Z';
/** One bounded descriptor; links, special files, growth and short reads are refused without printing bytes. */
export function readAsset(path:string,max:number):Buffer{
 let fd:number;try{fd=openSync(path,FS.O_RDONLY|(FS.O_NOFOLLOW??0)|(FS.O_NONBLOCK??0));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw new ScannerAssetError('sentinel.assets.missing');return bad();}
 try{const st=fstatSync(fd);if(!st.isFile()||st.size<1||st.size>max)bad();const b=Buffer.alloc(st.size);let n=0;
  while(n<b.length){const got=readSync(fd,b,n,b.length-n,n);if(!got)bad();n+=got;}
  const after=fstatSync(fd);const tail=Buffer.alloc(1);if(after.size!==st.size||after.mtimeMs!==st.mtimeMs||readSync(fd,tail,0,1,n))bad();return b;
 }finally{closeSync(fd);}
}
interface HeldAsset{schema:'sentinel-held-asset/draft-1';kind:'tool'|'database';id:string;contentDigest:string;metadata:unknown;metadataDigest:string;candidate:PromotionCandidate;previousLock:string;receipt:ReceiptEnvelope}
function folder(trustDir:string,kind:string){const dir=join(trustDir,'assets',kind);ensureDurableDir(dir,dirname(trustDir));return dir;}
function recordFor(trustDir:string,entry:LockedTool|LockedDatabase):HeldAsset{
 const id=entry.promotion.receipt;if(!/^sha256:[a-f0-9]{64}$/.test(id))bad();const b=readPublished(folder(trustDir,'records'),id.slice(7)+'.json',256*1024);if(!b)throw new ScannerAssetError('sentinel.assets.missing');
 let r:HeldAsset;try{r=JSON.parse(b!.toString('utf8'));}catch{return bad();}
 const previous=new RuleLockBook(trustDir).read(r.previousLock);
 const kind='adapterId'in entry?'tool':'database';const idOf='adapterId'in entry?entry.adapterId:entry.databaseId;const content='artifactDigest'in entry?entry.artifactDigest:entry.snapshotDigest;
 const {promotion,...candidateEntry}=entry;const candidate=kind==='tool'?{kind,tool:candidateEntry}:{kind,database:candidateEntry};
 if(r.schema!=='sentinel-held-asset/draft-1'||r.kind!==kind||r.id!==idOf||r.contentDigest!==content||r.metadataDigest!==canonicalDigest(r.metadata)
  ||canonicalDigest(r.receipt)!==promotion.receipt||!validateEnvelope('receipt',r.receipt).ok||candidateDigest(r.candidate)!==candidateDigest(candidate as PromotionCandidate)
  ||r.receipt.action!=='tool.acquire'||r.receipt.intentDigest!==intentDigest(promotionIntent(previous,r.candidate))
  ||r.receipt.stateDigest!==canonicalDigest({lock:r.previousLock,metadata:r.metadataDigest}))bad();
 return r;
}
export function heldDatabases(trustDir:string,lock:RuleLockEnvelope){return lock.databases.map(entry=>{const held=recordFor(trustDir,entry);
 const path=join(folder(trustDir,'objects'),entry.snapshotDigest.slice(7));const b=readAsset(path,MAX_ARCHIVE);if(digest(b)!==entry.snapshotDigest)bad();
 return{databaseId:entry.databaseId,snapshotDigest:entry.snapshotDigest,path,record:held.metadata};});}
export async function installedAdapters(trustDir:string,lock:RuleLockEnvelope,ids:readonly string[],scratch:string):Promise<ReadonlySet<string>>{
 const all=externalDrivers();const selected=[...new Set(ids)].filter(id=>all.has(id));if(!selected.length)return new Set();
 const backend=await ContainerBackend.connect({privateDir:scratch});const out=new Set<string>();
 for(const id of selected){const def=all.get(id)!.definition;const tool=lock.tools.filter(t=>t.adapterId===id);
  if(tool.length!==1||tool[0]!.version!==def.version||tool[0]!.artifactDigest!==def.image.split('@')[1])throw new ScannerAssetError('sentinel.assets.missing');
  recordFor(trustDir,tool[0]!);const image=await backend.inspectImage(def.image);if(tool[0]!.platform!==`linux-${image.architecture}`)bad();
  if(id==='advisories-osv'&&!lock.databases.some(d=>d.databaseId==='osv:npm'||d.databaseId==='osv:Maven'))throw new ScannerAssetError('sentinel.assets.missing');
  if(id==='iac-trivy'&&!lock.databases.some(d=>d.databaseId==='trivy-checks'&&d.snapshotDigest===TRIVY_CHECKS_BUNDLE.layer))throw new ScannerAssetError('sentinel.assets.missing');
  out.add(id);
 }return out;
}
export function checkPlanDatabases(plan:PlanEnvelope,lock:RuleLockEnvelope){
 for(const unit of plan.units)if(unit.adapterId==='advisories-osv')for(const input of unit.inputs){const kind=dependencyKindOf(input.relativePath);if(!kind)continue;
  for(const ecosystem of KIND_ECOSYSTEMS[kind])if(!lock.databases.some(d=>d.databaseId===`osv:${ecosystem}`))throw new ScannerAssetError('sentinel.assets.missing');
 }
}
function metadataOf(id:string,metadata:unknown,bytes:Buffer,now:Date,license?:string):{candidate:PromotionCandidate;metadata:unknown}{
 const m=metadata as any;const hash=digest(bytes);
 if(id==='osv:npm'||id==='osv:Maven'){
  if(typeof license!=='string'||!/^[-A-Za-z0-9.:()+ ]{1,200}$/.test(license))bad();
  if(m?.schema!=='sentinel-advisory-snapshot/draft-1'||`osv:${m.ecosystem}`!==id||m.sha256!==hash||m.size!==bytes.length
   ||typeof m.md5!=='string'||createHash('md5').update(bytes).digest('base64')!==m.md5||typeof m.source!=='string'||m.source.length>2048
   ||!validStamp(m.acquiredAt)||Date.parse(m.acquiredAt)>now.getTime()||!(m.sourceLastModified===null||(validStamp(m.sourceLastModified)&&Date.parse(m.sourceLastModified)<=now.getTime()))
   ||!(m.etag===null||(typeof m.etag==='string'&&m.etag.length<=4096)))bad();
 }else if(id==='trivy-checks'){
  if(license!==undefined&&license!==TRIVY_CHECKS_BUNDLE.license)bad();
  if(m?.schema!=='sentinel-trivy-checks/draft-1'||hash!==TRIVY_CHECKS_BUNDLE.layer||m.layer!==hash||m.manifest!==TRIVY_CHECKS_BUNDLE.manifest
   ||m.size!==TRIVY_CHECKS_BUNDLE.size||bytes.length!==m.size||m.version!==TRIVY_CHECKS_BUNDLE.version||m.name!=='trivy-checks'||m.commit!==TRIVY_CHECKS_BUNDLE.commit
   ||m.repository!==TRIVY_CHECKS_BUNDLE.repository||m.created!==TRIVY_CHECKS_BUNDLE.created||!validStamp(m.acquiredAt))bad();
 }else throw new ScannerAssetError('sentinel.assets.unsupported');
 return{metadata:structuredClone(metadata),candidate:{kind:'database',database:{databaseId:id,snapshotDigest:hash,capturedAt:m.acquiredAt,rights:{spdx:id==='trivy-checks'?TRIVY_CHECKS_BUNDLE.license:license!,origin:'third-party',upstream:{name:id,revision:hash}}}}};
}
/** No network: explicitly adopt an existing image or an archive with its separately named provenance file. */
export async function adoptScannerAsset(ws:Workspace,options:{kind:'tool'|'database';id:string;archive?:string;manifest?:string;license?:string;confirm:boolean;now:Date}):Promise<CommandResult>{
 const adopted=adoptedPolicy(ws);if('refusal'in adopted)return adopted.refusal;const policy=adopted.policy;
 const book=new RuleLockBook(ws.trustDir);const selected=book.current();const previous=selected?.lock??emptyLock(options.now);const previousDigest=lockDigest(previous);
 // Decide the policy before inspecting a daemon or reading caller archives. This preflight grants no promotion:
 // the exact verified candidate and metadata still require the separate, receipt-bound admission below.
 const preflight=admit({intent:{action:'tool.acquire',input:canonicalDigest({kind:options.kind,id:options.id,phase:'local-asset-preflight'}),
  effects:['local-artifacts'],budget:{maxTokens:null,maxCost:null,currency:null},scope:{profile:null,provider:null,targets:[previousDigest]}},
  requestedBy:OWNER,policy,stateDigest:previousDigest,now:options.now,
  capability:()=>({available:true,detail:'policy preflight only; no external capability queried'}),credential:()=>({basis:'local-only',detail:'no provider contacted'})});
 if(!preflight.record.verdicts.policy.allowed)return result('assets','configuration-failure',{verdicts:printed(preflight.record),reasonCode:preflight.record.verdicts.policy.reasonCode,facts:{kind:options.kind,id:options.id,network:false}});
 let candidate:PromotionCandidate,metadata:unknown,bytes:Buffer|undefined;
 if(options.kind==='tool'){
  if(options.archive||options.manifest||options.license)bad();
  const def=externalDrivers().get(options.id)?.definition;if(!def)throw new ScannerAssetError('sentinel.assets.unsupported');
  // This is a bounded local inspect, never a pull or scanner execution, even when previewing the owner action.
  const parent=folder(ws.trustDir,'inspect');const scratch=mkdtempSync(join(parent,'inspect-'));
  let image;try{image=await(await ContainerBackend.connect({privateDir:scratch})).inspectImage(def.image);}finally{rmSync(scratch,{recursive:true,force:true});}
  metadata={schema:'sentinel-installed-image/draft-1',image:def.image,id:image.id,os:image.os,architecture:image.architecture};
  candidate={kind:'tool',tool:{adapterId:options.id,version:def.version,artifactDigest:def.image.split('@')[1]!,platform:`linux-${image.architecture}`,rights:{spdx:options.id==='pattern-semgrep'?'LGPL-2.1-only':['ci-zizmor','secrets-gitleaks'].includes(options.id)?'MIT':'Apache-2.0',origin:'third-party',upstream:{name:options.id,revision:def.version}}}};
 }else{
  if(!options.manifest||!options.archive)bad();let m:unknown;try{m=JSON.parse(readAsset(options.manifest!,65536).toString('utf8'));}catch{return bad();}
  bytes=readAsset(options.archive!,MAX_ARCHIVE);({candidate,metadata}=metadataOf(options.id,m,bytes,options.now,options.license));
 }
 const metadataDigest=canonicalDigest(metadata);const stateDigest=canonicalDigest({lock:previousDigest,metadata:metadataDigest});const intent=promotionIntent(previous,candidate);
 const facts={kind:options.kind,id:options.id,candidate:candidateDigest(candidate),metadataDigest,entry:candidate.kind==='tool'?candidate.tool:(candidate as Extract<PromotionCandidate,{kind:'database'}>).database,metadata,previousLock:previousDigest,network:false};
 const old=options.kind==='tool'?previous.tools.find(t=>t.adapterId===options.id):previous.databases.find(d=>d.databaseId===options.id);
 if(old){const held=recordFor(ws.trustDir,old);if(candidateDigest(held.candidate)===candidateDigest(candidate)&&held.metadataDigest===metadataDigest)return result('assets','kept',{facts:{...facts,lock:selected!.digest}});}
 const request={intent,requestedBy:OWNER,policy,stateDigest,now:options.now,capability:()=>({available:true,detail:'exact verified local asset; no download'}),credential:()=>({basis:'local-only' as const,detail:'no provider contacted'})};
 let decision=admit(request);if(decision.record.outcome==='denied')return result('assets','configuration-failure',{verdicts:printed(decision.record),facts,reasonCode:decision.record.verdicts.policy.reasonCode});
 if(!options.confirm)return result('assets','awaiting-confirmation',{verdicts:printed(decision.record),facts});
 assertMayConfirm(OWNER);const receipt=issueReceipt(receiptBook(ws),OWNER,{intent,stateDigest,policyRevision:policy.revision},{now:options.now,ttlMs:600000});decision=admit({...request,receipt:{book:receiptBook(ws),id:receipt.id}});
 if(!decision.receipt||decision.record.outcome!=='admitted')bad();const spent=decision.receipt as ConsumedReceipt;const next=promote(previous,candidate,spent,options.now);
 if(bytes){const objects=folder(ws.trustDir,'objects');const hash=digest(bytes);if(!publishOnce(objects,hash.slice(7),bytes)&&digest(readAsset(join(objects,hash.slice(7)),MAX_ARCHIVE))!==hash)bad();}
 const held:HeldAsset={schema:'sentinel-held-asset/draft-1',kind:options.kind,id:options.id,contentDigest:candidate.kind==='tool'?candidate.tool.artifactDigest:(candidate as Extract<PromotionCandidate,{kind:'database'}>).database.snapshotDigest,metadata,metadataDigest,candidate,previousLock:previousDigest,receipt:spent.receipt};
 const records=folder(ws.trustDir,'records');if(!publishOnce(records,spent.digest.slice(7)+'.json',canonicalJsonBytes(held)))bad();
 if(!selected)book.select(book.store(previous),null);const nextDigest=book.store(next);book.select(nextDigest,previousDigest);
 return result('assets','prepared',{verdicts:printed(decision.record),facts:{...facts,lock:nextDigest,receipt:spent.digest}});
}

/** Explicit bounded owner acquisition; the result is held data only and requires a separate adoption/promotion. */
export async function acquireScannerDatabase(ws:Workspace,options:{id:string;maxBytes?:number;confirm:boolean;now:Date}):Promise<CommandResult>{
 const adopted=adoptedPolicy(ws);if('refusal'in adopted)return adopted.refusal;
 const osv=options.id==='osv:npm'||options.id==='osv:Maven';if(!osv&&options.id!=='trivy-checks')throw new ScannerAssetError('sentinel.assets.unsupported');
 if(osv&&(!Number.isSafeInteger(options.maxBytes)||options.maxBytes!<1||options.maxBytes!>MAX_ACQUISITION_BYTES))bad();
 if(!osv&&options.maxBytes!==undefined)bad();
 const request={ecosystems:[options.id==='osv:npm'?'npm' as const:'Maven' as const],maxBytesPerEcosystem:options.maxBytes??1};
 const intent=osv?acquisitionIntent(request):checksAcquisitionIntent();
 const stateDigest=canonicalDigest({workspace:ws.path,request:intent});const policy=adopted.policy;
 const facts={id:options.id,network:true,maxBytes:osv?options.maxBytes:TRIVY_CHECKS_BUNDLE.size,targets:intent.scope.targets,adopted:false};
 const args={intent,requestedBy:OWNER,policy,stateDigest,now:options.now,capability:()=>({available:true,detail:'bounded allowlisted acquisition broker'}),credential:()=>({basis:'local-only' as const,detail:'public archive; no inherited credentials'})};
 let decision=admit(args);if(decision.record.outcome==='denied')return result('assets','configuration-failure',{facts,verdicts:printed(decision.record),reasonCode:decision.record.verdicts.policy.reasonCode});
 if(!options.confirm)return result('assets','awaiting-confirmation',{facts,verdicts:printed(decision.record)});
 assertMayConfirm(OWNER);const receipt=issueReceipt(receiptBook(ws),OWNER,{intent,stateDigest,policyRevision:policy.revision},{now:options.now,ttlMs:600000});decision=admit({...args,receipt:{book:receiptBook(ws),id:receipt.id}});
 if(decision.record.outcome!=='admitted'||!decision.receipt)bad();
 const dir=mkdtempSync(join(folder(ws.trustDir,'acquisitions'),'acquire-'));const signal=AbortSignal.timeout(120000);
 const record=osv?(await acquireAdvisorySnapshots(request,{dir,receipt:decision.receipt,signal}))[0]!:await acquireChecksBundle({dir,receipt:decision.receipt,signal});
 const hash='sha256'in record?record.sha256:record.layer;const archive=join(dir,hash.slice(7)+(osv?'.zip':'.tar.gz'));const manifest=join(dir,hash.slice(7)+'.json');
 return result('assets','prepared',{facts:{...facts,archive,manifest,digest:hash,receipt:decision.receipt!.digest},verdicts:printed(decision.record)});
}
