// No scanner or network. The owner's explicitly adopted local bytes and metadata must remain exact after source
// changes, and a changed private record cannot inherit a lock's spent receipt.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync,readdirSync,openSync,ftruncateSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initWorkspace} from '../dist/cli/init.js';
import {workspaceOf,adoptWorkspaceSettings} from '../dist/service/local.js';
import {adoptScannerAsset,acquireScannerDatabase,heldDatabases,readAsset} from '../dist/service/scanner-assets.js';
import {RuleLockBook} from '../dist/service/rule-locks.js';
import {syntheticSnapshot} from './osv-helpers.ts';
import {needsStore,unlock} from './snapshot-helpers.ts';
function fixture(t:any){const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'sentinel-owned-assets-')));t.after(()=>{unlock(dir);rmSync(dir,{recursive:true,force:true});});const root=join(dir,'workspace');mkdirSync(root);const ws=workspaceOf(root,{XDG_STATE_HOME:join(dir,'state')});initWorkspace({workspace:root});adoptWorkspaceSettings(ws,{confirm:true,now:new Date()});const db=syntheticSnapshot(join(dir,'db'),'npm',[1],'2026-10-21T00:00:00.000000000Z');const manifest=join(dir,'manifest.json');writeFileSync(manifest,JSON.stringify(db.snapshot));return{dir,ws,db,manifest};}

test('local database adoption: preview writes no asset, confirmation retains exact independent bytes and metadata',needsStore,async t=>{
 const f=fixture(t);const options={kind:'database' as const,id:'osv:npm',license:'MIT',manifest:f.manifest,archive:f.db.path,confirm:false,now:new Date()};
 const before=await adoptScannerAsset(f.ws,options);assert.equal(before.exitCode,4);assert.equal(new RuleLockBook(f.ws.trustDir).current(),null);
 await assert.rejects(adoptScannerAsset(f.ws,{...options,license:undefined,confirm:true}),(e:any)=>e.code==='sentinel.assets.invalid','an archive license must be explicitly stated');
 const adopted=await adoptScannerAsset(f.ws,{...options,confirm:true});assert.equal(adopted.exitCode,0);const lock=new RuleLockBook(f.ws.trustDir).current()!.lock;
 const held=heldDatabases(f.ws.trustDir,lock);assert.equal(held[0]!.snapshotDigest,f.db.snapshot.sha256);assert.deepEqual(held[0]!.record,f.db.snapshot);const bytes=readFileSync(held[0]!.path);
 writeFileSync(f.db.path,'changed original archive');writeFileSync(f.manifest,'{}');assert.deepEqual(readFileSync(held[0]!.path),bytes);assert.deepEqual(heldDatabases(f.ws.trustDir,lock)[0]!.record,f.db.snapshot);
});

test('local database adoption: changed provenance cannot retain the lock receipt even with a recomputed metadata digest',needsStore,async t=>{
 const f=fixture(t);await adoptScannerAsset(f.ws,{kind:'database',id:'osv:npm',license:'MIT',manifest:f.manifest,archive:f.db.path,confirm:true,now:new Date()});
 const lock=new RuleLockBook(f.ws.trustDir).current()!.lock;const dir=join(f.ws.trustDir,'assets','records');const path=join(dir,readdirSync(dir)[0]!);const value=JSON.parse(readFileSync(path,'utf8'));
 value.metadata.sourceLastModified='2026-10-22T00:00:00.000000000Z';const{canonicalDigest}=await import('../dist/policy/digest.js');value.metadataDigest=canonicalDigest(value.metadata);writeFileSync(path,JSON.stringify(value));
 assert.throws(()=>heldDatabases(f.ws.trustDir,lock),(e:any)=>e.code==='sentinel.assets.invalid');
});

test('local database adoption: mismatched bytes, impossible dates, unsafe files and bounded acquisition previews refuse safely',needsStore,async t=>{
 const f=fixture(t);const options={kind:'database' as const,id:'osv:npm',license:'MIT',manifest:f.manifest,archive:f.db.path,confirm:true,now:new Date()};
 writeFileSync(f.manifest,JSON.stringify({...f.db.snapshot,sourceLastModified:'2026-02-31T00:00:00.000000000Z'}));await assert.rejects(adoptScannerAsset(f.ws,options),(e:any)=>e.code==='sentinel.assets.invalid');
 writeFileSync(f.manifest,JSON.stringify({...f.db.snapshot,sha256:'sha256:'+'0'.repeat(64)}));await assert.rejects(adoptScannerAsset(f.ws,options),(e:any)=>e.code==='sentinel.assets.invalid');
 const large=join(f.dir,'oversize');const fd=openSync(large,'w',0o600);ftruncateSync(fd,513*1024*1024);closeSync(fd);assert.throws(()=>readAsset(large,512*1024*1024),(e:any)=>e.code==='sentinel.assets.invalid');
 assert.equal((await acquireScannerDatabase(f.ws,{id:'osv:npm',maxBytes:1024,confirm:false,now:new Date()})).exitCode,4);
 await assert.rejects(acquireScannerDatabase(f.ws,{id:'osv:npm',maxBytes:513*1024*1024,confirm:true,now:new Date()}),(e:any)=>e.code==='sentinel.assets.invalid');
 assert.equal(new RuleLockBook(f.ws.trustDir).current(),null);
});
