import {test} from 'node:test';import assert from 'node:assert/strict';
import {rmSync,readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {preparationFixture} from './helpers/preparation-fixture.ts';import{needsStore}from'./snapshot-helpers.ts';
import {preparationClock}from'../dist/service/preparation-clock.js';
import {resolvePreparationInputs,preparationInputBytes,preparationResolvedBytes,restorePreparationInputs,checkPreparationProfile,preparationTerms,resolvePreparationRun}from'../dist/service/preparation-inputs.js';
import {discoverPreparationProfile}from'../dist/service/preparation-discovery.js';import{openScratchLease,releaseScratchLease}from'../dist/service/scratch-lease.js';
import{captureWithBudget}from'../dist/snapshot/capture.js';import{GitReadBudget}from'../dist/snapshot/git.js';import{planPreparedWorkspaceCanonical}from'../dist/service/canonical.js';import{loadPlan}from'../dist/execution/plans.js';
const code=(s:string)=>(e:any)=>e?.code===s;
function clockFor(store:any){const now=Date.now();return preparationClock(store,{acceptedAt:new Date(now-1000).toISOString(),deadlineAt:new Date(now+599000).toISOString()});}
test('genuine promoted tool with actual missing-image inspect remains a retained gap; corrupt provenance refuses',{
 ...needsStore,skip:process.env.SENTINEL_ISOLATION!=='1'&&'requires the already-present pinned local Gitleaks image; never acquires it',timeout:60000,
},async t=>{
 const f=await preparationFixture(t,'secrets'),{adoptScannerAsset}=await import('../dist/service/scanner-assets.js');
 assert.equal((await adoptScannerAsset(f.ws,{kind:'tool',id:'secrets-gitleaks',confirm:true,now:new Date()})).outcome,'prepared');
 const {ContainerBackend}=await import('../dist/execution/isolation.js'),original=ContainerBackend.prototype.inspectImage;
 const clock=clockFor(f.store),initial=resolvePreparationInputs(f.store,{workspace:f.ws.path,trustDir:f.ws.trustDir,registry:f.registry}),lease=openScratchLease(f.store);t.after(()=>releaseScratchLease(f.store,lease));
 const ready=await discoverPreparationProfile(f.store,initial,clock,lease);assert.equal(JSON.parse(preparationResolvedBytes(f.store,ready).toString()).availability[0].available,true,'real adopted local pin positive');
 // Fault only the target of the real local image query AFTER adoption. No successful capability/receipt is forged
 // and no shared image is deleted: Docker itself must report this nonexistent content pin missing, without pull.
 let queried=false;const mocked=t.mock.method(ContainerBackend.prototype,'inspectImage',async function(this:InstanceType<typeof ContainerBackend>,reference:string,signal?:AbortSignal){queried=true;return original.call(this,`${reference.slice(0,reference.indexOf('@'))}@sha256:${'0'.repeat(64)}`,signal);});
 const unavailable=await discoverPreparationProfile(f.store,initial,clock,lease);assert.equal(queried,true);
 assert.deepEqual(JSON.parse(preparationResolvedBytes(f.store,unavailable).toString()).availability,[{adapterId:'secrets-gitleaks',available:false,reasonCode:'sentinel.execution.imageMissing'}]);
 await assert.rejects(discoverPreparationProfile(f.store,ready,clock,lease),code('sentinel.preparation.unavailable'),'captured readiness cannot silently downgrade');
 mocked.mock.restore();const terms=preparationTerms(f.store,initial,()=>clock.stillWithin()),tool=terms.current.lock.tools.find(t=>t.adapterId==='secrets-gitleaks')!;
 const record=join(f.ws.trustDir,'assets','records',`${tool.promotion.receipt.slice(7)}.json`),originalRecord=readFileSync(record);rmSync(record);
 await assert.rejects(discoverPreparationProfile(f.store,initial,clock,lease),code('sentinel.assets.invalid'),'a pinned tool without genuine promotion provenance is not a readiness gap');
 writeFileSync(record,originalRecord,{mode:0o600});writeFileSync(record,'{}');
 await assert.rejects(discoverPreparationProfile(f.store,initial,clock,lease),code('sentinel.service.recordUnsafe'));
 assert.equal(f.store.ledger.readEvents({after:0,limit:500}).events.some(e=>e.kind==='snapshot-admitted'),false);
});
