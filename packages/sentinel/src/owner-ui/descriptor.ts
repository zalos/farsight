// Explicit owner launch only. This private descriptor is lookup data, never a human receipt or ledger.
// A qualified SQLite EXCLUSIVE mutex is never unlinked or recovered by PID/time; OS death releases its hold.
import{join}from'node:path';import{openSync,closeSync,fsyncSync,unlinkSync}from'node:fs';
import{checkedCompanion,companionRecord,companionFilename,readCompanion}from'@farsight/core/dist/sentinel-companion.js';
import{checkSqliteRuntime}from'../store/runtime.js';import{prepareStoreRoot,preparePrivateFile,assertPrivateFileIfPresent,hasIdentity}from'../store/paths.js';import{isSqliteBusy}from'../store/errors.js';
import{readPrivateFile,writePrivateFileAtomic}from'../policy/user-state.js';import{OwnerUiError}from'./session.js';
// Keep private package declarations independent of Farsight workspace imports. Runtime validation is shared.
export interface OwnerCompanionDescriptor{schema:'farsight-sentinel-companion/1';ownerOrigin:string;farsightOrigin:string;workspaceDigest:string;processNonce:string;hostInstance:string;expiresAt:string;}
const held=new Set<string>();
async function descriptorLock(directory:string,name:string){
 if(!/^[a-f0-9]{64}\.json$/.test(name))throw new OwnerUiError();const runtime=await checkSqliteRuntime(),root=prepareStoreRoot(directory),path=join(root.path,name+'.mutex.sqlite');
 if(held.has(path))throw new OwnerUiError('sentinel.ownerUi.busy');const file=preparePrivateFile(path);if(held.has(file.identity))throw new OwnerUiError('sentinel.ownerUi.busy');
 const sidecars=()=>{for(const suffix of['-journal','-wal','-shm'])assertPrivateFileIfPresent(path+suffix);};sidecars();let db:InstanceType<typeof runtime.sqlite.DatabaseSync>|undefined,closed=false;
 const assertHeld=()=>{if(closed||!hasIdentity(root.path,root.identity)||!hasIdentity(path,file.identity)||!db?.isTransaction)throw new OwnerUiError();preparePrivateFile(path,{create:false});sidecars();};
 const close=()=>{if(closed)return;closed=true;try{if(db?.isTransaction)db.exec('ROLLBACK');}finally{try{db?.close();}finally{held.delete(path);held.delete(file.identity);}}};
 try{db=new runtime.sqlite.DatabaseSync(path);db.exec('PRAGMA busy_timeout=0');if((db.prepare('PRAGMA journal_mode=DELETE').get()as{journal_mode:string}).journal_mode!=='delete')throw new OwnerUiError();db.exec('PRAGMA synchronous=FULL; BEGIN EXCLUSIVE');held.add(path);held.add(file.identity);assertHeld();return{assertHeld,close};}
 catch(error){close();if(isSqliteBusy(error))throw new OwnerUiError('sentinel.ownerUi.busy');throw new OwnerUiError();}
}
/** No arbitrary filename/origin update endpoint: the launcher retains this exact frozen process identity. */
export async function publishOwnerCompanion(directory:string,given:OwnerCompanionDescriptor){
 const value:OwnerCompanionDescriptor=checkedCompanion(given,given);const name=companionFilename(value.workspaceDigest,value.farsightOrigin),path=join(directory,name),lock=await descriptorLock(directory,name);
 try{
  const previous=readPrivateFile(path,1024,'sentinel.receipt.storeUnsafe',{repairTemporaryAliases:false});if(previous)companionRecord(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(previous)),value);
  const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>1024)throw new OwnerUiError();lock.assertHeld();writePrivateFileAtomic(directory,name,bytes,'sentinel.receipt.storeUnsafe');lock.assertHeld();
 }finally{lock.close();}
 let closed=false;
 const assertCurrent=()=>{if(closed)throw new OwnerUiError('sentinel.ownerUi.expired');const actual=readCompanion(directory,value);if(!actual||actual.processNonce!==value.processNonce||actual.ownerOrigin!==value.ownerOrigin||actual.expiresAt!==value.expiresAt)throw new OwnerUiError('sentinel.ownerUi.replaced');};assertCurrent();
 return{value,assertCurrent,async close(){if(closed)return;closed=true;const lock=await descriptorLock(directory,name);try{const bytes=readPrivateFile(path,1024,'sentinel.receipt.storeUnsafe',{repairTemporaryAliases:false});if(!bytes)return;const actual=companionRecord(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),value);if(actual.processNonce!==value.processNonce)return;lock.assertHeld();unlinkSync(path);lock.assertHeld();const fd=openSync(directory,'r');try{fsyncSync(fd);}finally{closeSync(fd);}lock.assertHeld();}finally{lock.close();}}};
}
