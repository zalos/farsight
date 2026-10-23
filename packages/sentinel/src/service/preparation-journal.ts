// Private preparation data, not execution/admission authority. Creation is lazy and only the held owner writes.
// Only exact owned writer temporaries may be settled under the held owner. Unknown records/bundles remain;
// capacity requires explicit owner maintenance. A temporary name never becomes accepted captured state.
import { lstatSync, mkdirSync, opendirSync, realpathSync, openSync, closeSync, fstatSync, unlinkSync, constants as FS } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { SentinelStore } from '../store/index.js';
import { heldStoreRoot } from '../store/owner-binding.js';
import { identityOf } from '../store/paths.js';
import { syncDirectory } from '../execution/durability.js';
import { assertPrivateDir, readPrivateFile, writePrivateFileAtomic } from '../policy/user-state.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { publishOnce } from './publish-once.js';
import { PreparationError, type PreparationErrorCode } from './preparation-clock.js';
import { PREPARATION_BUNDLE_LIMIT } from './preparation-inputs.js';

export const PREPARATION_TERMINAL_LIMIT = 256;
const RECORD_LIMIT = 4096;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^prep-[a-f0-9]{32}$/;
const RUN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UID = process.getuid?.();
const UNSAFE = 'sentinel.receipt.storeUnsafe' as const;
export const PREPARATION_PHASES = ['admitting','resuming','accepted','discovering','capturing','captured','bootstrapping','prepared','interrupted','failed','canceled'] as const;
export type PreparationPhase = typeof PREPARATION_PHASES[number];
export interface PreparationRecord {
  schema: 'sentinel-preparation/1'; prepId: string; requestKeyDigest: string; requestDigest: string;
  storeId: string; workspaceIdentity: string; createdEpoch: string; ownerEpoch: string;
  recordRevision: number; phase: PreparationPhase; checkpoint: 'none' | 'captured' | 'bootstrapping';
  mode: 'workspace' | 'retry'; parentId: string | null; parentRevision: number | null; parentPlanDigest: string | null; parentSnapshotId: string | null;
  acceptedAt: string; deadlineAt: string; updatedAt: string; runDeadlineAt: string;
  configDigest: string; resolvedDigest: string | null; admissionDigest: string | null; resumeAdmissionDigest: string | null;
  snapshotId: string | null; runId: string | null; planRevision: number | null; planDigest: string | null;
  errorCode: string | null;
}
const KEYS = ('schema prepId requestKeyDigest requestDigest storeId workspaceIdentity createdEpoch ownerEpoch recordRevision phase checkpoint mode parentId parentRevision parentPlanDigest parentSnapshotId acceptedAt deadlineAt updatedAt runDeadlineAt configDigest resolvedDigest admissionDigest resumeAdmissionDigest snapshotId runId planRevision planDigest errorCode').split(' ');
const TERMINAL = new Set<PreparationPhase>(['prepared','interrupted','failed','canceled']);
const MOVES: Readonly<Record<PreparationPhase, readonly PreparationPhase[]>> = Object.freeze({
 admitting:['accepted','interrupted'], resuming:['captured','interrupted'], accepted:['discovering','interrupted','failed','canceled'],
 discovering:['capturing','captured','interrupted','failed','canceled'], capturing:['captured','interrupted','failed','canceled'],
 captured:['bootstrapping','interrupted','failed','canceled'], bootstrapping:['prepared','interrupted','failed','canceled'],
 prepared:[], interrupted:['captured','resuming'], failed:[], canceled:[],
});
const IMMUTABLE = ('schema prepId requestKeyDigest requestDigest storeId workspaceIdentity createdEpoch mode parentId parentRevision parentPlanDigest parentSnapshotId acceptedAt deadlineAt configDigest').split(' ') as Array<keyof PreparationRecord>;
const isDigest = (v:unknown):v is string => typeof v==='string' && DIGEST.test(v);
const isId = (v:unknown):v is string => typeof v==='string' && RUN.test(v);
const nullable = (v:unknown, check:(v:unknown)=>boolean) => v===null || check(v);
const time = (v:unknown):v is string => typeof v==='string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString()===v;
const ordinal = (v:unknown) => typeof v==='number' && Number.isSafeInteger(v) && v>=1 && v<=100_000;
const fail = (code:PreparationErrorCode='sentinel.preparation.invalid'):never => { throw new PreparationError(code); };
const hash = (b:Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
export const terminalPreparation = (r:PreparationRecord):boolean => TERMINAL.has(r.phase);
function checked(value:unknown):PreparationRecord {
 if(!value || typeof value!=='object' || Array.isArray(value)) return fail();
 const v=value as PreparationRecord, keys=Object.keys(v);
 if(keys.length!==KEYS.length || keys.some(k=>!KEYS.includes(k)) || v.schema!=='sentinel-preparation/1'
  || typeof v.prepId!=='string' || !ID.test(v.prepId) || !isDigest(v.requestKeyDigest) || !isDigest(v.requestDigest)
  || !isId(v.storeId) || !isDigest(v.workspaceIdentity) || !isId(v.createdEpoch) || !isId(v.ownerEpoch)
  || !ordinal(v.recordRevision) || !PREPARATION_PHASES.includes(v.phase) || !['none','captured','bootstrapping'].includes(v.checkpoint)
  || !['workspace','retry'].includes(v.mode) || !nullable(v.parentId,isId) || !nullable(v.parentRevision,ordinal)
  || !nullable(v.parentPlanDigest,isDigest) || !nullable(v.parentSnapshotId,isId)
  || ![v.acceptedAt,v.deadlineAt,v.updatedAt,v.runDeadlineAt].every(time)
  || !isDigest(v.configDigest) || !nullable(v.resolvedDigest,isDigest) || !nullable(v.admissionDigest,isDigest) || !nullable(v.resumeAdmissionDigest,isDigest)
  || !nullable(v.snapshotId,isId) || !nullable(v.runId,isId) || !nullable(v.planRevision,ordinal) || !nullable(v.planDigest,isDigest)
  || !nullable(v.errorCode,x=>typeof x==='string' && /^sentinel\.[A-Za-z][A-Za-z0-9.]{0,119}$/.test(x))) return fail();
 const start=Date.parse(v.acceptedAt), end=Date.parse(v.deadlineAt), updated=Date.parse(v.updatedAt), runEnd=Date.parse(v.runDeadlineAt);
 if(end<=start || end-start>600_000 || updated<start || runEnd>end || runEnd<=0) return fail();
 const parent=[v.parentId,v.parentRevision,v.parentPlanDigest,v.parentSnapshotId];
 if(v.mode==='workspace' ? parent.some(x=>x!==null) : parent.some(x=>x===null)) return fail();
 if(v.checkpoint!=='none' && (v.snapshotId===null || v.resolvedDigest===null)) return fail();
 if(['capturing','captured','bootstrapping','prepared'].includes(v.phase) && v.resolvedDigest===null) return fail();
 if(['captured','bootstrapping','prepared'].includes(v.phase) && (v.snapshotId===null || v.checkpoint==='none')) return fail();
 if(v.phase==='prepared' && (v.runId===null || v.planRevision===null || v.planDigest===null)) return fail();
 if(v.phase==='admitting' && (v.admissionDigest!==null || v.resumeAdmissionDigest!==null || v.checkpoint!=='none')) return fail();
 if(!['admitting','interrupted'].includes(v.phase) && v.admissionDigest===null) return fail();
 return Object.freeze(structuredClone(v));
}

export class PreparationJournal {
 readonly #store:SentinelStore;
 readonly #root:string;
 readonly #records:string;
 readonly #bundles:string;
 readonly #known=new Map<string,string>();
 constructor(store:SentinelStore) {
  const held=heldStoreRoot(store);if(!held) throw new PreparationError('sentinel.preparation.invalid');
  this.#store=store;this.#root=join(store.storePath,'preparation');
  this.#records=join(this.#root,'records');this.#bundles=join(this.#root,'bundles');
  this.#known.set(held.path,held.identity);
 }
 /** Startup only, while no preparation task exists. These names are writer-private and never worker inputs.
  * An unrenamed update is not accepted: keep the old canonical bytes and discard only its exact inert temp.
  * A create alias is removable only when the canonical name and this exact temp are the same private nlink2 inode. */
 recoverPublications():void {
  if(!this.#layout())return;
  for(const [directory,pattern,limit]of [[this.#records,/^\.([a-f0-9]{64}\.json)\.[a-f0-9]{16}\.tmp$/,RECORD_LIMIT],
   [this.#bundles,/^\.(prep-[a-f0-9]{32}\.(?:config|resolved)\.json)\.[a-f0-9]{16}\.tmp$/,PREPARATION_BUNDLE_LIMIT]]as const){
   const dir=opendirSync(directory);let visited=0;
   try{for(let ent=dir.readSync();ent;ent=dir.readSync()){
    this.#fence();if(++visited>PREPARATION_TERMINAL_LIMIT*4)return fail('sentinel.preparation.retentionRequired');
    const match=pattern.exec(ent.name);if(!match)continue;const path=join(directory,ent.name),canonical=join(directory,match[1]!);
    const fd=openSync(path,FS.O_RDONLY|FS.O_NOFOLLOW|FS.O_NONBLOCK);
    try{const st=fstatSync(fd,{bigint:true});if(!st.isFile()||st.isSymbolicLink()||Number(st.mode)&0o077||UID!==undefined&&Number(st.uid)!==UID||st.size>BigInt(limit)||![1n,2n].includes(st.nlink))return fail();
     let named;try{named=lstatSync(canonical,{bigint:true});}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
     const alias=named!==undefined&&identityOf(named)===identityOf(st);
     if(st.nlink===2n&&(!alias||!named!.isFile()||named!.isSymbolicLink()||named!.nlink!==2n||Number(named!.mode)&0o077||UID!==undefined&&Number(named!.uid)!==UID))return fail();
     if(st.nlink===1n&&alias)return fail();
     // Recheck all owned ancestors and the exact opened inode immediately before this one destructive operation.
     this.#fence();const latest=lstatSync(path,{bigint:true}),after=fstatSync(fd,{bigint:true});
     if(identityOf(latest)!==identityOf(st)||latest.isSymbolicLink()||after.nlink!==st.nlink||after.ctimeNs!==st.ctimeNs||after.size!==st.size)return fail();
     if(alias&&identityOf(lstatSync(canonical,{bigint:true}))!==identityOf(st))return fail();
     unlinkSync(path);this.#fence();syncDirectory(directory);this.#fence();
    }finally{closeSync(fd);}
   }}finally{dir.closeSync();}
  }
 }
 /** The path is private and used only by storage tests/owner diagnostics, never a transport projection. */
 get directory():string{return this.#root;}
 #fence():void {
  this.#store.assertHeld();
  for(const[path,identity]of this.#known){let st;try{st=lstatSync(path,{bigint:true});}catch{return fail();}
   if(!st.isDirectory()||st.isSymbolicLink()||identityOf(st)!==identity||Number(st.mode)&0o077||UID!==undefined&&Number(st.uid)!==UID)return fail();
  }
 }
 #directory(path:string,parent:string,create:boolean):boolean {
  this.#fence();let st;
  try{st=lstatSync(path,{bigint:true});}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')return fail();
   if(!create)return false;this.#fence();mkdirSync(path,{mode:0o700});st=lstatSync(path,{bigint:true});
  }
  if(st.isSymbolicLink()||!st.isDirectory()||realpathSync.native(path)!==path)return fail();
  assertPrivateDir(path,UNSAFE);const identity=identityOf(st),old=this.#known.get(path);if(old!==undefined&&old!==identity)return fail();
  this.#known.set(path,identity);this.#fence();
  if(create){this.#fence();syncDirectory(parent);this.#fence();}
  return true;
 }
 #layout(create=false):boolean {
  if(!this.#directory(this.#root,this.#store.storePath,create))return false;
  const records=this.#directory(this.#records,this.#root,create),bundles=this.#directory(this.#bundles,this.#root,create);
  if(records!==bundles)return fail();return records;
 }
 #file(requestKeyDigest:string):string {if(!isDigest(requestKeyDigest))return fail();return `${requestKeyDigest.slice(7)}.json`;}
 #record(bytes:Buffer):PreparationRecord {
  if(bytes.length>RECORD_LIMIT)return fail();let value:unknown;try{value=JSON.parse(bytes.toString('utf8'));}catch{return fail();}
  const record=checked(value);if(record.storeId!==this.#store.storeId||!canonicalJsonBytes(record).equals(bytes))return fail();return record;
 }
 read(requestKeyDigest:string):PreparationRecord|null {
  const name=this.#file(requestKeyDigest);if(!this.#layout())return null;
  this.#fence();const bytes=readPrivateFile(join(this.#records,name),RECORD_LIMIT,UNSAFE,{repairTemporaryAliases:false});this.#fence();
  if(!bytes)return null;const record=this.#record(bytes);if(record.requestKeyDigest!==requestKeyDigest)return fail();return record;
 }
 list():readonly PreparationRecord[] {
  if(!this.#layout())return Object.freeze([]);this.#fence();const records:PreparationRecord[]=[],dir=opendirSync(this.#records);let visited=0;
  try{for(let ent=dir.readSync();ent;ent=dir.readSync()){
   this.#fence();if(++visited>PREPARATION_TERMINAL_LIMIT+1)return fail('sentinel.preparation.retentionRequired');
   if(!/^[a-f0-9]{64}\.json$/.test(ent.name)||!ent.isFile())return fail();
   const record=this.read(`sha256:${ent.name.slice(0,-5)}`);if(!record)return fail();records.push(record);
  }}finally{dir.closeSync();}
  if(new Set(records.map(r=>r.prepId)).size!==records.length || records.filter(r=>!terminalPreparation(r)).length>1)return fail();
  return Object.freeze(records);
 }
 /** Only after real admission/check: first write admits data, not a capability. No caller transport can reach this. */
 create(given:PreparationRecord,initial:Uint8Array):PreparationRecord {
  const record=checked(given),bytes=canonicalJsonBytes(record);
  if(record.storeId!==this.#store.storeId || record.ownerEpoch!==this.#store.epoch || record.createdEpoch!==this.#store.epoch
   || record.recordRevision!==1 || !['admitting','accepted'].includes(record.phase) || record.checkpoint!=='none'
   || bytes.length>RECORD_LIMIT || initial.byteLength>PREPARATION_BUNDLE_LIMIT || hash(initial)!==record.configDigest)return fail();
  const all=this.list();if(all.some(r=>r.requestKeyDigest===record.requestKeyDigest||r.prepId===record.prepId))return fail('sentinel.preparation.changed');
  if(all.filter(terminalPreparation).length>=PREPARATION_TERMINAL_LIMIT)return fail('sentinel.preparation.retentionRequired');
  if(all.some(r=>!terminalPreparation(r)))return fail('sentinel.preparation.busy');
  this.#layout(true);this.#fence();
  if(!publishOnce(this.#records,this.#file(record.requestKeyDigest),bytes))return fail('sentinel.preparation.changed');
  this.#fence();this.#writeBundle(record,'config',initial);return this.read(record.requestKeyDigest)!;
 }
 update(given:PreparationRecord,expectedRevision:number):PreparationRecord {
  const next=checked(given),old=this.read(next.requestKeyDigest);if(!old||old.recordRevision!==expectedRevision||next.recordRevision!==expectedRevision+1)return fail('sentinel.preparation.changed');
  if(IMMUTABLE.some(k=>next[k]!==old[k]) || Date.parse(next.updatedAt)<Date.parse(old.updatedAt)
   || Date.parse(next.runDeadlineAt)>Date.parse(old.runDeadlineAt) || !MOVES[old.phase].includes(next.phase))return fail('sentinel.preparation.changed');
  for(const key of['resolvedDigest','snapshotId','runId','admissionDigest']as const)if(old[key]!==null&&next[key]!==old[key])return fail('sentinel.preparation.changed');
  if(old.phase==='interrupted'&&(old.checkpoint==='none'||next.checkpoint!==old.checkpoint
   ||(next.phase==='resuming'?next.resumeAdmissionDigest!==null:!next.resumeAdmissionDigest||next.resumeAdmissionDigest===old.resumeAdmissionDigest)))return fail();
  if(next.phase==='resuming'&&(next.checkpoint==='none'||next.resumeAdmissionDigest!==null))return fail();
  if(old.phase==='resuming'&&next.phase==='captured'&&!next.resumeAdmissionDigest)return fail();
  if(next.ownerEpoch!==this.#store.epoch)return fail();
  const bytes=canonicalJsonBytes(next);if(bytes.length>RECORD_LIMIT)return fail();this.#fence();
  writePrivateFileAtomic(this.#records,this.#file(next.requestKeyDigest),bytes,UNSAFE);this.#fence();return this.read(next.requestKeyDigest)!;
 }
 #bundleName(record:PreparationRecord,kind:'config'|'resolved'):string{return `${record.prepId}.${kind}.json`;}
 #writeBundle(record:PreparationRecord,kind:'config'|'resolved',bytes:Uint8Array):void {
  if(bytes.byteLength>PREPARATION_BUNDLE_LIMIT)return fail();this.#fence();
  if(!publishOnce(this.#bundles,this.#bundleName(record,kind),bytes)){
   const existing=readPrivateFile(join(this.#bundles,this.#bundleName(record,kind)),PREPARATION_BUNDLE_LIMIT,UNSAFE,{repairTemporaryAliases:false});
   if(!existing||!existing.equals(Buffer.from(bytes)))return fail('sentinel.preparation.changed');
  }this.#fence();
 }
 /** Resolve once BEFORE capture, then bind its exact bytes in the next journal transition. */
 writeResolved(record:PreparationRecord,bytes:Uint8Array):string {
  const actual=this.read(record.requestKeyDigest);if(!actual||actual.recordRevision!==record.recordRevision||actual.phase!=='discovering')return fail();
  this.#writeBundle(actual,'resolved',bytes);return hash(bytes);
 }
 readBundle(record:PreparationRecord,kind:'config'|'resolved'):Buffer {
  const actual=this.read(record.requestKeyDigest);if(!actual||actual.prepId!==record.prepId)return fail();
  const expected=kind==='config'?actual.configDigest:actual.resolvedDigest;if(expected===null)return fail();
  const bytes=readPrivateFile(join(this.#bundles,this.#bundleName(actual,kind)),PREPARATION_BUNDLE_LIMIT,UNSAFE,{repairTemporaryAliases:false});this.#fence();
  if(!bytes||hash(bytes)!==expected)return fail();return bytes;
 }
}
