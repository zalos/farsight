import {test} from 'node:test';import assert from 'node:assert/strict';
import {rmSync,readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {preparationFixture} from './helpers/preparation-fixture.ts';import{needsStore}from'./snapshot-helpers.ts';
import {preparationClock}from'../dist/service/preparation-clock.js';
import {resolvePreparationInputs,preparationInputBytes,preparationResolvedBytes,restorePreparationInputs,checkPreparationProfile,preparationTerms,resolvePreparationRun}from'../dist/service/preparation-inputs.js';
import {discoverPreparationProfile}from'../dist/service/preparation-discovery.js';import{openScratchLease,releaseScratchLease}from'../dist/service/scratch-lease.js';
import{captureWithBudget}from'../dist/snapshot/capture.js';import{GitReadBudget}from'../dist/snapshot/git.js';import{planPreparedWorkspaceCanonical}from'../dist/service/canonical.js';import{loadPlan}from'../dist/execution/plans.js';
const code=(s:string)=>(e:any)=>e?.code===s;
function clockFor(store:any){const now=Date.now();return preparationClock(store,{acceptedAt:new Date(now-1000).toISOString(),deadlineAt:new Date(now+599000).toISOString()});}
test('genuine prepared canonical continuation preserves original time and completes bootstrap using one frozen profile',needsStore,async t=>{
 const f=await preparationFixture(t),clock=clockFor(f.store),initial=resolvePreparationInputs(f.store,{workspace:f.ws.path,trustDir:f.ws.trustDir,registry:f.registry});
 const lease=openScratchLease(f.store);t.after(()=>releaseScratchLease(f.store,lease));
 const resolved=await discoverPreparationProfile(f.store,initial,clock,lease),before=preparationInputBytes(f.store,initial),bytes=preparationResolvedBytes(f.store,resolved);
 assert.deepEqual(preparationInputBytes(f.store,resolved),before);const restored=restorePreparationInputs(f.store,{workspace:f.ws.path,trustDir:f.ws.trustDir,registry:f.registry},before,bytes,clock);
 assert.deepEqual(preparationResolvedBytes(f.store,restored),bytes);assert.equal(preparationTerms(f.store,restored,()=>clock.stillWithin()).resolved,true);
 const {snapshot}=await captureWithBudget(f.store,{mode:'working-copy',sources:[{sourceId:'workspace',repositoryId:'local-workspace',root:f.ws.path}]},new GitReadBudget(),()=>clock.stillWithin());
 const identity=await resolvePreparationRun(f.store,resolved,snapshot.id,clock);rmSync(join(f.ws.path,'src'),{recursive:true});
 const result=await planPreparedWorkspaceCanonical(f.store,identity,{scratchRoot:lease.path,wrapRunner:lease.wrapRunner});assert.equal(result.outcome,'prepared');
 const run=f.store.ledger.getRun(identity.runId)!;assert.equal(run.envelope.createdAt,clock.acceptedAt);assert.equal(run.planRevision,2);assert.equal(run.envelope.snapshotId,snapshot.id);
 assert.equal(Date.parse(run.envelope.createdAt)+run.envelope.budgets.deadlineMs,Date.parse(clock.runDeadlineAt));
 const admitted=await loadPlan(f.store,identity.runId,2);assert.deepEqual(admitted.profile,JSON.parse(bytes.toString()).profile);
 await assert.rejects(planPreparedWorkspaceCanonical(f.store,{...identity},{scratchRoot:lease.path}),code('sentinel.preparation.changed'));
});
test('missing requested scanner becomes an explicit retained gap, not disabled rules or an entire preparation refusal',needsStore,async t=>{
 const f=await preparationFixture(t,'secrets');
 // Both requested and required rules survive readiness; the tool has never been acquired/promoted.
 const config=join(f.ws.path,'sentinel.config.json'),parsed={schema:'sentinel-repoconfig/draft-1',requestedRules:[] as string[],disabledRules:[],thresholds:{},suppressions:[],providers:[]};
 const {RuleLockBook}=await import('../dist/service/rule-locks.js');const book=new RuleLockBook(f.ws.trustDir),current=book.current()!;const rules=book.packsOf(current.lock).flatMap(p=>p.manifest.rules.map(r=>r.familyId));
 parsed.requestedRules=rules;writeFileSync(config,JSON.stringify(parsed));
 const {adoptWorkspaceSettings}=await import('../dist/service/local.js');assert.equal(adoptWorkspaceSettings(f.ws,{confirm:true,now:new Date()}).outcome,'prepared');
 const clock=clockFor(f.store),initial=resolvePreparationInputs(f.store,{workspace:f.ws.path,trustDir:f.ws.trustDir,registry:f.registry}),lease=openScratchLease(f.store);t.after(()=>releaseScratchLease(f.store,lease));
 const resolved=await discoverPreparationProfile(f.store,initial,clock,lease),data=JSON.parse(preparationResolvedBytes(f.store,resolved).toString());
 assert.deepEqual(data.availability,[{adapterId:'secrets-gitleaks',available:false,reasonCode:'sentinel.assets.missing'}]);assert.equal(f.registry.ids.includes('secrets-gitleaks'),true,'execution registry remains full');
 const terms=preparationTerms(f.store,resolved,()=>clock.stillWithin());assert.equal(terms.profile.planner.registry.ids.includes('secrets-gitleaks'),false);assert.deepEqual(terms.policy.rules,[...rules].sort());
 const {snapshot}=await captureWithBudget(f.store,{mode:'working-copy',sources:[{sourceId:'workspace',repositoryId:'local-workspace',root:f.ws.path}]},new GitReadBudget(),()=>clock.stillWithin());
 const identity=await resolvePreparationRun(f.store,resolved,snapshot.id,clock),result=await planPreparedWorkspaceCanonical(f.store,identity,{scratchRoot:lease.path,wrapRunner:lease.wrapRunner});
 const admitted=await loadPlan(f.store,identity.runId,2);assert.ok(result.disclosure.checks.unsupported>0);assert.equal(admitted.plan.units.filter(u=>u.stage==='check').length,0);assert.equal(admitted.plan.pins.rules.length,rules.length);assert.ok(admitted.plan.checks.some(g=>g.state==='unsupported'&&g.reasonCode==='sentinel.plan.adapterNotRegistered'));
 // Retained unavailability never silently becomes newly available on resume or accepts changed profile bytes.
 const altered={...data,availability:[{adapterId:'secrets-gitleaks',available:true,reasonCode:null}]};
 assert.throws(()=>restorePreparationInputs(f.store,{workspace:f.ws.path,trustDir:f.ws.trustDir,registry:f.registry},preparationInputBytes(f.store,resolved),Buffer.from(JSON.stringify(altered)),clock),code('sentinel.preparation.changed'));
 assert.throws(()=>checkPreparationProfile(f.store,resolved,new Set(['secrets-gitleaks']),clock),code('sentinel.preparation.changed'));
});

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
 writeFileSync(join(f.ws.trustDir,'assets','records',`${tool.promotion.receipt.slice(7)}.json`),'{}');
 await assert.rejects(discoverPreparationProfile(f.store,initial,clock,lease),code('sentinel.service.recordUnsafe'));
 assert.equal(f.store.ledger.readEvents({after:0,limit:500}).events.some(e=>e.kind==='snapshot-admitted'),false);
});
