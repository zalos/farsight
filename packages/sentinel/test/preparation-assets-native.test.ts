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

test('genuine owner-promoted historical Trivy checks pin is an explicit mismatch gap, while broken provenance still refuses',{
 ...needsStore,skip:process.env.SENTINEL_ISOLATION!=='1'&&'requires the already-present pinned local Trivy image; never acquires it',timeout:60000,
},async t=>{
 const f=await preparationFixture(t),{adoptScannerAsset}=await import('../dist/service/scanner-assets.js');const{promoteRulePack,adoptWorkspaceSettings}=await import('../dist/service/local.js'),{builtinPackDir}=await import('../dist/service/package-paths.js'),{TRIVY_SUPPORTED_RULES}=await import('../dist/adapters/drivers/index.js');
 assert.equal(promoteRulePack(f.ws,{packDir:builtinPackDir('infrastructure')!,confirm:true,now:new Date()}).outcome,'prepared');const settingsPath=join(f.ws.path,'.farsight/sentinel/settings.json'),settings=JSON.parse(readFileSync(settingsPath,'utf8'));settings.mandatoryRules=TRIVY_SUPPORTED_RULES.map(r=>r.familyId);writeFileSync(settingsPath,JSON.stringify(settings));assert.equal(adoptWorkspaceSettings(f.ws,{confirm:true,now:new Date()}).outcome,'prepared');
 assert.equal((await adoptScannerAsset(f.ws,{kind:'tool',id:'iac-trivy',confirm:true,now:new Date()})).outcome,'prepared');
 const{RuleLockBook}=await import('../dist/service/rule-locks.js'),{promotionIntent,promote}=await import('../dist/rules/index.js'),{canonicalDigest}=await import('../dist/policy/digest.js'),{ReceiptBook}=await import('../dist/policy/receipts.js'),{issueReceipt}=await import('../dist/policy/owner-receipts.js'),{admit}=await import('../dist/policy/admission.js'),{adoptedPolicy,OWNER}=await import('../dist/service/local.js'),{canonicalJsonBytes}=await import('../dist/store/objects.js'),{ensureDurableDir,publishOnce}=await import('../dist/service/publish-once.js'),{dirname}=await import('node:path');
 // Simulate an earlier owner's genuine promotion through the real one-use admission and promotion APIs.
 // No availability or engine result is fabricated: this incompatible fixture pin must NEVER reach execution.
 const book=new RuleLockBook(f.ws.trustDir),previous=book.current()!,now=new Date(),metadata={schema:'historical-checks-fixture/1',version:'obsolete'},candidate:any={kind:'database',database:{databaseId:'trivy-checks',snapshotDigest:canonicalDigest(metadata),capturedAt:now.toISOString().replace(/Z$/,'000000Z'),rights:{spdx:'MIT',origin:'third-party',upstream:{name:'trivy-checks',revision:'obsolete'}}}};
 const intent=promotionIntent(previous.lock,candidate),stateDigest=canonicalDigest({lock:previous.digest,metadata:canonicalDigest(metadata)}),adopted=adoptedPolicy(f.ws);assert.ok('policy'in adopted);const receipts=new ReceiptBook(join(f.ws.trustDir,'receipts')),binding={intent,stateDigest,policyRevision:adopted.policy.revision},receipt=issueReceipt(receipts,OWNER,binding,{now,ttlMs:600000});
 const decision=admit({intent,stateDigest,policy:adopted.policy,requestedBy:OWNER,now,capability:()=>({available:true,detail:'retaining an explicitly incompatible historical owner fixture pin only'}),credential:()=>({basis:'local-only',detail:'no engine or acquisition'}),receipt:{book:receipts,id:receipt.id}});assert.equal(decision.record.outcome,'admitted');assert.ok(decision.receipt);
 const next=promote(previous.lock,candidate,decision.receipt,now),records=join(f.ws.trustDir,'assets','records');ensureDurableDir(records,dirname(f.ws.trustDir));const name=decision.receipt.digest.slice(7)+'.json';
 assert.equal(publishOnce(records,name,canonicalJsonBytes({schema:'sentinel-held-asset/draft-1',kind:'database',id:'trivy-checks',contentDigest:candidate.database.snapshotDigest,metadata,metadataDigest:canonicalDigest(metadata),candidate,previousLock:previous.digest,receipt:decision.receipt.receipt})),true);book.select(book.store(next),previous.digest);
 const clock=clockFor(f.store),initial=resolvePreparationInputs(f.store,{workspace:f.ws.path,trustDir:f.ws.trustDir,registry:f.registry}),lease=openScratchLease(f.store);t.after(()=>releaseScratchLease(f.store,lease));
 const resolved=await discoverPreparationProfile(f.store,initial,clock,lease);assert.deepEqual(JSON.parse(preparationResolvedBytes(f.store,resolved).toString()).availability,[{adapterId:'iac-trivy',available:false,reasonCode:'sentinel.preparation.databaseMismatch'}]);
 rmSync(join(records,name));await assert.rejects(discoverPreparationProfile(f.store,initial,clock,lease),code('sentinel.assets.invalid'));
});
