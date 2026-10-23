// Private owner-CLI key mutex only, never a ledger or approval book. The file is never unlinked.
// A qualified SQLite EXCLUSIVE transaction releases on death; no PID/time-based takeover or stale deletion.
import {join} from 'node:path';
import {checkSqliteRuntime} from '../store/runtime.js';
import {prepareStoreRoot,preparePrivateFile,assertPrivateFileIfPresent,hasIdentity} from '../store/paths.js';
import {isSqliteBusy} from '../store/errors.js';
import {PreparationError} from './preparation-clock.js';
const held=new Set<string>();
export async function preparationKeyLock(directory:string,name:string):Promise<{assertHeld():void;close():void}>{
 if(!/^preparation-client-[a-f0-9]{64}\.json$/.test(name))throw new PreparationError('sentinel.preparation.invalid');
 const runtime=await checkSqliteRuntime(),root=prepareStoreRoot(directory,{create:false}),path=join(root.path,name+'.mutex.sqlite');
 // Never open a second descriptor on an inode locked by this process (POSIX close hazard).
 if(held.has(path))throw new PreparationError('sentinel.preparation.busy');
 const file=preparePrivateFile(path);if(held.has(file.identity))throw new PreparationError('sentinel.preparation.busy');
 const sidecars=()=>{for(const suffix of ['-journal','-wal','-shm'])assertPrivateFileIfPresent(path+suffix);};sidecars();
 let db:InstanceType<typeof runtime.sqlite.DatabaseSync>|undefined,closed=false;
 const check=()=>{if(closed||!hasIdentity(root.path,root.identity)||!hasIdentity(path,file.identity)||!db?.isTransaction)throw new PreparationError('sentinel.preparation.invalid');preparePrivateFile(path,{create:false});sidecars();};
 const close=()=>{if(closed)return;closed=true;try{if(db?.isTransaction)db.exec('ROLLBACK');}finally{try{db?.close();}finally{held.delete(path);held.delete(file.identity);}}};
 try{
  db=new runtime.sqlite.DatabaseSync(path);db.exec('PRAGMA busy_timeout=0');
  if((db.prepare('PRAGMA journal_mode=DELETE').get()as{journal_mode:string}).journal_mode!=='delete')throw new PreparationError('sentinel.preparation.invalid');
  db.exec('PRAGMA synchronous=FULL; BEGIN EXCLUSIVE');held.add(path);held.add(file.identity);check();
  return{assertHeld:check,close};
 }catch(error){close();if(isSqliteBusy(error))throw new PreparationError('sentinel.preparation.busy');if(error instanceof PreparationError)throw error;throw new PreparationError('sentinel.preparation.invalid');}
}
