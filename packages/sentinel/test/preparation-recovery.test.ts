// Genuine accepted tasks and owner loss; faults affect only terminal data writes, never admission/publication.
import {test} from 'node:test';import assert from 'node:assert/strict';import{join}from'node:path';
import{OwnerService}from'../dist/service/owner-service.js';import{PreparationJournal}from'../dist/service/preparation-journal.js';
import{PreparationError}from'../dist/service/preparation-clock.js';import{canonicalDigest}from'../dist/policy/digest.js';
import{ReceiptBook}from'../dist/policy/receipts.js';import{issueReceipt}from'../dist/policy/owner-receipts.js';import{OWNER}from'../dist/service/local.js';import{openStore}from'../dist/store/index.js';
import{preparationFixture}from'./helpers/preparation-fixture.ts';import{needsStore}from'./snapshot-helpers.ts';
const cli={principal:'agent' as const,channel:'local-service' as const},key='recovery_request_original_0001';
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function accept(f:any,service:OwnerService,k=key){const p:any=await service.handle('configuration.preview',{requestKey:k},cli),r=issueReceipt(new ReceiptBook(join(f.ws.trustDir,'receipts')),OWNER,p.confirmation,{now:new Date(),ttlMs:600000});return await service.handle('prepare.accept',{requestKey:k,previewId:p.id,receiptId:r.id},cli)as any;}
async function settled(service:OwnerService){for(let i=0;i<1000&&service.busy;i++)await wait(10);assert.equal(service.busy,false);}
function record(f:any){return new PreparationJournal(f.store).read(canonicalDigest({requestKey:key}))!;}
test('settled same-epoch failed terminal publication is durably interrupted before a new admission', {...needsStore,timeout:60000},async t=>{
 const f=await preparationFixture(t),service=new OwnerService(f.store,f.ws,{registry:f.registry});t.after(()=>service.stop());const update=PreparationJournal.prototype.update;
 let refused=0;const fault=t.mock.method(PreparationJournal.prototype,'update',function(this:PreparationJournal,r:any,...args:any[]){if(['prepared','failed'].includes(r.phase)){refused++;throw new PreparationError('sentinel.preparation.invalid');}return(update as any).call(this,r,...args);});
 const accepted=await accept(f,service);await settled(service);fault.mock.restore();assert.equal(refused,2);const before=record(f);assert.equal(before.phase,'bootstrapping');assert.equal(before.ownerEpoch,f.store.epoch);assert.ok(before.runId);
 const next=await accept(f,service,'recovery_request_next_0002');assert.equal(next.outcome,'submitted');const after=record(f);assert.equal(after.phase,'interrupted');assert.equal(after.snapshotId,before.snapshotId);assert.equal(after.acceptedAt,accepted.facts.acceptedAt);assert.equal(after.runDeadlineAt,before.runDeadlineAt);assert.equal(after.admissionDigest,before.admissionDigest);
});
test('new held-owner startup durably interrupts old acceptance without recapture or automatic resume', {...needsStore,timeout:60000},async t=>{
 const f=await preparationFixture(t),old=new OwnerService(f.store,f.ws,{registry:f.registry});const accepted=await accept(f,old);const before=record(f);assert.equal(before.phase,'accepted');f.store.close();await old.stop();
 const reopened=await openStore(f.ws.storePath);t.after(()=>reopened.close());const service=new OwnerService(reopened,f.ws,{registry:f.registry});t.after(()=>service.stop());
 const actual=new PreparationJournal(reopened).read(before.requestKeyDigest)!;assert.equal(actual.phase,'interrupted');assert.equal(actual.acceptedAt,accepted.facts.acceptedAt);assert.equal(actual.checkpoint,'none');assert.equal(actual.snapshotId,null);assert.equal(actual.ownerEpoch,reopened.epoch);
 assert.equal(reopened.ledger.readEvents({after:0,limit:100}).events.some(e=>e.kind==='snapshot-admitted'),false);const next=await accept(f,service,'recovery_request_next_0003');assert.equal(next.outcome,'submitted');
});
test('failed interruption write refuses a fresh admission and leaves old checkpoint exact', {...needsStore,timeout:60000},async t=>{
 const f=await preparationFixture(t),service=new OwnerService(f.store,f.ws,{registry:f.registry});t.after(()=>service.stop());const update=PreparationJournal.prototype.update;
 const fault=t.mock.method(PreparationJournal.prototype,'update',function(this:PreparationJournal,r:any,...args:any[]){if(['prepared','failed','interrupted'].includes(r.phase))throw new PreparationError('sentinel.preparation.invalid');return(update as any).call(this,r,...args);});
 await accept(f,service);await settled(service);const before=record(f),seq=f.store.ledger.currentSequence();await assert.rejects(accept(f,service,'recovery_request_next_0004'));assert.deepEqual(record(f),before);assert.equal(f.store.ledger.currentSequence(),seq);fault.mock.restore();
});

test('new epoch refuses startup if the interruption write fails, and a later genuine reopen recovers', {...needsStore,timeout:60000},async t=>{
 const f=await preparationFixture(t),old=new OwnerService(f.store,f.ws,{registry:f.registry});await accept(f,old);const before=record(f);f.store.close();await old.stop();const reopened=await openStore(f.ws.storePath);t.after(()=>reopened.close());
 const update=PreparationJournal.prototype.update,fault=t.mock.method(PreparationJournal.prototype,'update',function(this:PreparationJournal,r:any,...args:any[]){if(r.phase==='interrupted')throw new PreparationError('sentinel.preparation.invalid');return(update as any).call(this,r,...args);});
 assert.throws(()=>new OwnerService(reopened,f.ws,{registry:f.registry}),(e:any)=>e.code==='sentinel.preparation.invalid');assert.deepEqual(new PreparationJournal(reopened).read(before.requestKeyDigest),before);fault.mock.restore();
 const next=new OwnerService(reopened,f.ws,{registry:f.registry});t.after(()=>next.stop());assert.equal(new PreparationJournal(reopened).read(before.requestKeyDigest)!.phase,'interrupted');
});
test('private CLI mutex refuses reentry and unsafe link/sidecar identities without releasing another hold',needsStore,async t=>{
 const{preparationKeyLock}=await import('../dist/service/preparation-key-lock.js'),{symlinkSync,linkSync,rmSync,writeFileSync}=await import('node:fs');const f=await preparationFixture(t),name=`preparation-client-${'a'.repeat(64)}.json`,path=join(f.ws.trustDir,name+'.mutex.sqlite');
 const first=await preparationKeyLock(f.ws.trustDir,name);try{await assert.rejects(preparationKeyLock(f.ws.trustDir,name),(e:any)=>e.code==='sentinel.preparation.busy');first.assertHeld();}finally{first.close();}
 const second=await preparationKeyLock(f.ws.trustDir,name);second.close();linkSync(path,path+'.alias');await assert.rejects(preparationKeyLock(f.ws.trustDir,name));rmSync(path+'.alias');
 rmSync(path);writeFileSync(path+'.target','',{mode:0o600});symlinkSync(path+'.target',path);await assert.rejects(preparationKeyLock(f.ws.trustDir,name));rmSync(path);writeFileSync(path,'',{mode:0o600});symlinkSync(path+'.target',path+'-journal');await assert.rejects(preparationKeyLock(f.ws.trustDir,name));rmSync(path+'-journal');
 const final=await preparationKeyLock(f.ws.trustDir,name);final.close();
});

test('a genuinely active captured task cannot be retired by a second acceptance', {...needsStore,timeout:60000},async t=>{
 const f=await preparationFixture(t),service=new OwnerService(f.store,f.ws,{registry:f.registry});t.after(()=>service.stop());const{ObjectStore}=await import('../dist/store/objects.js'),read=ObjectStore.prototype.read;let saw!:()=>void,release!:()=>void,once=false;const observed=new Promise<void>(r=>saw=r),held=new Promise<void>(r=>release=r);
 const mock=t.mock.method(ObjectStore.prototype,'read',async function(this:any,...args:any[]){const bytes=await(read as any).apply(this,args);if(!once&&bytes.toString('utf8').includes('sentinel-snapshot/draft-1')){once=true;saw();await held;}return bytes;});
 try{await accept(f,service);await observed;const before=record(f);assert.equal(before.phase,'captured');await assert.rejects(accept(f,service,'recovery_active_request_0002'),(e:any)=>e.code==='sentinel.preparation.busy');assert.deepEqual(record(f),before);assert.equal(service.busy,true);}finally{release();mock.mock.restore();}
});
