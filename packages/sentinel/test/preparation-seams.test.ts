// Actual owner files, real capture/store and the original clock. No scanner, target-code execution or fabricated publication.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,linkSync,mkdirSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {ReceiptBook,isConsumedReceipt} from '../dist/policy/receipts.js';
import {issueReceipt} from '../dist/policy/owner-receipts.js';
import {binding,NOW} from './helpers/receipt-fixture.ts';
import {captureWithBudget} from '../dist/snapshot/capture.js';
import {GitReadBudget} from '../dist/snapshot/git.js';
import {ObjectStore} from '../dist/store/objects.js';
import {preparationClock,checkPreparationClock} from '../dist/service/preparation-clock.js';
import {commitRepo,needsStore,openCaptureStore,scratch} from './snapshot-helpers.ts';

const owner={channel:'owner-cli',principal:'owner'};
const code=(c:string)=>(e:any)=>e?.code===c;
function files(dir:string){return readdirSync(dir).sort().map(name=>({name,bytes:readFileSync(join(dir,name)).toString('hex'),links:statSync(join(dir,name)).nlink}));}
test('receipt preflight is repeatable, returns no authority and changes no actual files',t=>{
 const dir=join(scratch(t),'receipts'),book=new ReceiptBook(dir),r=issueReceipt(book,owner,binding,{now:NOW,ttlMs:600000});
 const before=files(dir);assert.equal(book.check(r.id,binding,NOW),undefined);assert.equal(book.check(r.id,binding,NOW),undefined);
 assert.equal(isConsumedReceipt(book.check(r.id,binding,NOW)),false);assert.deepEqual(files(dir),before);
 const spent=book.consume(r.id,binding,NOW);assert.ok(isConsumedReceipt(spent));assert.throws(()=>book.check(r.id,binding,NOW),code('sentinel.receipt.alreadyUsed'));
 assert.throws(()=>book.consume(r.id,binding,NOW),code('sentinel.receipt.alreadyUsed'));
});
test('receipt preflight of unknown or denied bindings creates nothing; it shares all validation with consume',t=>{
 const root=scratch(t),missing=join(root,'missing'),book=new ReceiptBook(missing);
 assert.throws(()=>book.check('receipt-missing',binding,NOW),code('sentinel.receipt.unknown'));assert.equal(existsSync(missing),false);
 const dir=join(root,'receipts'),b=new ReceiptBook(dir),r=issueReceipt(b,owner,binding,{now:NOW,ttlMs:600000});const before=files(dir);
 for(const [given,now,expected] of [
  [{...binding,stateDigest:'sha256:'+'a'.repeat(64)},NOW,'sentinel.receipt.mismatch'],
  [{...binding,policyRevision:'sha256:'+'b'.repeat(64)},NOW,'sentinel.receipt.mismatch'],
  [{...binding,intent:{...binding.intent,input:'sha256:'+'c'.repeat(64)}},NOW,'sentinel.receipt.mismatch'],
  [binding,new Date(NOW.getTime()+600000),'sentinel.receipt.expired'],[binding,new Date(NOW.getTime()-1),'sentinel.receipt.mismatch'],
 ] as const){assert.throws(()=>b.check(r.id,given as any,now),code(expected));assert.throws(()=>b.consume(r.id,given as any,now),code(expected));}
 assert.deepEqual(files(dir),before);
});
test('receipt check refuses even an own pending publication alias without unlinking it',t=>{
 const dir=join(scratch(t),'receipts'),book=new ReceiptBook(dir),r=issueReceipt(book,owner,binding,{now:NOW,ttlMs:600000});
 linkSync(join(dir,`${r.id}.json`),join(dir,`.${r.id}.json.${'a'.repeat(16)}.tmp`));const before=files(dir);
 assert.throws(()=>book.check(r.id,binding,NOW),code('sentinel.receipt.storeUnsafe'));assert.deepEqual(files(dir),before);
});
for(const boundary of ['first walk','source write','second walk','manifest write','sidecar write'] as const)test(`capture refuses at ${boundary} with no late snapshot`,needsStore,async t=>{
 const dir=scratch(t),root=join(dir,'repo');commitRepo(root,{'a.ts':'export const a=1;','nested/b.ts':'export const b=2;'});
 const {store}=await openCaptureStore(t,dir);const original=ObjectStore.prototype.put;let writes=0,walkChecks=0,afterSources=0,stop=false,stageIds:string[]=[];
 const refusal=new Error(`original ${boundary} fence`);
 t.mock.method(ObjectStore.prototype,'put',async function(this:any,...args:any[]){const receipt=await (original as any).apply(this,args);writes++;if((boundary==='source write'&&writes===1)||(boundary==='manifest write'&&writes===3)||(boundary==='sidecar write'&&writes===4))stop=true;return receipt;});
 const request={mode:'working-copy' as const,sources:[{sourceId:'app',repositoryId:'fixture',root}],onStaged:(ids:readonly string[])=>{stageIds=[...ids];}};
 await assert.rejects(captureWithBudget(store,request,new GitReadBudget(),()=>{
  walkChecks++;if(boundary==='first walk'&&walkChecks===5)throw refusal;
  if(boundary==='second walk'&&writes===2&&++afterSources===3)throw refusal;
  if(stop)throw refusal;
 }),e=>e===refusal);
 const events=store.ledger.readEvents({after:0,limit:500}).events;
 assert.equal(events.filter(e=>e.kind==='snapshot-admitted').length,0);
 assert.equal(events.filter(e=>e.kind==='staging-aborted').length,stageIds.length,'all registered stages are aborted');
 if(boundary==='first walk')assert.equal(writes,0);
 if(boundary==='second walk')assert.equal(writes,2,'the first two original bodies were written, no manifest');
});
test('capture internal deadline includes awaited final body write and an actual wall expiry',needsStore,async t=>{
 const dir=scratch(t),root=join(dir,'repo');commitRepo(root,{'one.ts':'export const a=1;'});const{store}=await openCaptureStore(t,dir);
 const accepted=new Date(Date.now()-599000).toISOString(),deadline=new Date(Date.parse(accepted)+600000).toISOString();
 const clock=preparationClock(store,{acceptedAt:accepted,deadlineAt:deadline});const original=ObjectStore.prototype.put;let writes=0;
 t.mock.method(ObjectStore.prototype,'put',async function(this:any,...args:any[]){const receipt=await(original as any).apply(this,args);if(++writes===1)await new Promise(r=>setTimeout(r,1200));return receipt;});
 await assert.rejects(captureWithBudget(store,{mode:'working-copy',sources:[{sourceId:'app',repositoryId:'fixture',root}]},new GitReadBudget(),()=>clock.stillWithin()),code('sentinel.preparation.expired'));
 assert.equal(writes,1,'the real source body finished its awaited durable write');
 assert.equal(store.ledger.readEvents({after:0,limit:500}).events.some(e=>e.kind==='snapshot-admitted'),false);
});
test('the original clock cannot be copied, extended, reset on resume or used for a different held store',needsStore,async t=>{
 const dir=scratch(t),a=await openCaptureStore(t,dir,join(dir,'a')),b=await openCaptureStore(t,dir,join(dir,'b'));const now=Date.now();
 const terms={acceptedAt:new Date(now-599750).toISOString(),deadlineAt:new Date(now+250).toISOString()};const clock=preparationClock(a.store,terms);
 assert.equal(clock.runDeadlineAt,terms.deadlineAt);checkPreparationClock(a.store,clock);
 assert.throws(()=>checkPreparationClock(a.store,{...clock}),code('sentinel.preparation.invalid'));assert.throws(()=>checkPreparationClock(b.store,clock),code('sentinel.preparation.invalid'));
 assert.throws(()=>preparationClock(a.store,{...terms,deadlineAt:new Date(now+600001).toISOString()}),code('sentinel.preparation.invalid'));
 await new Promise(r=>setTimeout(r,300));assert.throws(()=>clock.stillWithin(),code('sentinel.preparation.expired'));
 assert.throws(()=>preparationClock(a.store,terms),code('sentinel.preparation.expired'));
});
test('cancel remains the first typed preparation failure, and a closed owner cannot continue',needsStore,async t=>{
 const dir=scratch(t),{store}=await openCaptureStore(t,dir);const now=Date.now(),signal=new AbortController();
 const clock=preparationClock(store,{acceptedAt:new Date(now).toISOString(),deadlineAt:new Date(now+600000).toISOString()},signal.signal);
 signal.abort();let first:any;try{clock.stillWithin();}catch(e){first=e;}assert.equal(first.code,'sentinel.preparation.canceled');store.close();assert.throws(()=>clock.stillWithin(),e=>e===first);
});

async function preparationFixture(t:any){
 const {initWorkspace}=await import('../dist/cli/init.js');
 const {workspaceOf,adoptWorkspaceSettings,promoteRulePack}=await import('../dist/service/local.js');
 const {builtinPackDir}=await import('../dist/service/package-paths.js');
 const {publicRegistry}=await import('../dist/service/scanner-profile.js');
 const dir=scratch(t),root=join(dir,'workspace');commitRepo(root,{'src/one.ts':'export const one=1;'});
 const ws=workspaceOf(root,{...process.env,XDG_STATE_HOME:join(dir,'owner')});initWorkspace({workspace:root});
 assert.equal(adoptWorkspaceSettings(ws,{confirm:true,now:new Date()}).outcome,'prepared');
 assert.equal(promoteRulePack(ws,{packDir:builtinPackDir('foundation-preview')!,confirm:true,now:new Date()}).outcome,'prepared');
 const {store}=await openCaptureStore(t,dir,ws.storePath),registry=publicRegistry();
 return{dir,ws,store,registry};
}
function treeFiles(dir:string):any[]{return readdirSync(dir).sort().flatMap(name=>{const p=join(dir,name),st=statSync(p);return st.isDirectory()?[{name,dir:true},...treeFiles(p).map(x=>({...x,name:`${name}/${x.name}`}))]:[{name,bytes:readFileSync(p).toString('hex'),links:st.nlink,mode:st.mode}];});}
test('pure policy loading never creates a missing trust directory or repairs an adoption alias',needsStore,async t=>{
 const {loadPolicyInputsReadOnly}=await import('../dist/policy/adoption.js');
 const root=join(scratch(t),'workspace');mkdirSync(root);const missing=join(scratch(t),'missing');
 assert.throws(()=>loadPolicyInputsReadOnly({workspace:root,trustDir:missing}));assert.equal(existsSync(missing),false);
 const f=await preparationFixture(t);assert.equal(loadPolicyInputsReadOnly({workspace:f.ws.path,trustDir:f.ws.trustDir}).trust,'adopted');
 const name=readdirSync(f.ws.trustDir).find(n=>n.startsWith('adoption-'))!;
 linkSync(join(f.ws.trustDir,name),join(f.ws.trustDir,`.${name}.${'a'.repeat(16)}.tmp`));const before=treeFiles(f.ws.trustDir);
 assert.throws(()=>loadPolicyInputsReadOnly({workspace:f.ws.path,trustDir:f.ws.trustDir}));assert.deepEqual(treeFiles(f.ws.trustDir),before);
});
test('full preparation input proof is pure, copied on read and rejects structural/store/configuration substitution',needsStore,async t=>{
 const {resolvePreparationInputs,preparationInputBytes,assertPreparationInputs}=await import('../dist/service/preparation-inputs.js');
 const {writeFileSync}=await import('node:fs');
 const f=await preparationFixture(t),before=treeFiles(f.ws.trustDir),sequence=f.store.ledger.currentSequence();
 const inputs=resolvePreparationInputs(f.store,{workspace:f.ws.path,trustDir:f.ws.trustDir,registry:f.registry});
 assert.deepEqual(treeFiles(f.ws.trustDir),before);assert.equal(f.store.ledger.currentSequence(),sequence);
 const bytes=preparationInputBytes(f.store,inputs),original=Buffer.from(bytes);bytes.fill(0);assert.deepEqual(preparationInputBytes(f.store,inputs),original);
 assertPreparationInputs(f.store,inputs,()=>{});assert.throws(()=>assertPreparationInputs(f.store,{...inputs},()=>{}),code('sentinel.preparation.changed'));
 const other=await openCaptureStore(t,f.dir,join(f.dir,'other'));assert.throws(()=>assertPreparationInputs(other.store,inputs,()=>{}),code('sentinel.preparation.changed'));
 writeFileSync(join(f.ws.path,'sentinel.config.json'),JSON.stringify({schema:'sentinel-repoconfig/draft-1',requestedRules:['sentinel.preview.sql-string-concat'],disabledRules:[],thresholds:{},suppressions:[],providers:[]}));
 assert.throws(()=>assertPreparationInputs(f.store,inputs,()=>{}));assert.equal(f.store.ledger.currentSequence(),sequence,'no staging/admission on changed full input');
});
test('pure lock resolution refuses a pending alias without unlinking or admitting anything',needsStore,async t=>{
 const {resolvePreparationInputs}=await import('../dist/service/preparation-inputs.js');const f=await preparationFixture(t);
 const rules=join(f.ws.trustDir,'rules'),name='first';linkSync(join(rules,name),join(rules,`.${name}.${'c'.repeat(16)}.tmp`));
 const before=treeFiles(f.ws.trustDir),sequence=f.store.ledger.currentSequence();
 assert.throws(()=>resolvePreparationInputs(f.store,{workspace:f.ws.path,trustDir:f.ws.trustDir,registry:f.registry}));
 assert.deepEqual(treeFiles(f.ws.trustDir),before);assert.equal(f.store.ledger.currentSequence(),sequence);
});
test('plan admission rechecks its original fence after an actual durable write and accepts no late plan',needsStore,async t=>{
 const {admitPlan}=await import('../dist/execution/plans.js'),{planBootstrap}=await import('../dist/planner/index.js');
 const {foundationProfile}=await import('../dist/service/trusted-profile.js');const dir=scratch(t),{store}=await openCaptureStore(t,dir),profile=foundationProfile();
 const plan=planBootstrap({runId:'run-preparation-plan-fence',sourceIds:['workspace'],profile:profile.planner});
 const original=ObjectStore.prototype.putCanonicalJson;let wrote=false;const error=new Error('original plan deadline');
 t.mock.method(ObjectStore.prototype,'putCanonicalJson',async function(this:any,...args:any[]){const result=await(original as any).apply(this,args);wrote=true;return result;});
 await assert.rejects(admitPlan(store,{plan,ruleLock:null,policy:null,profile:profile.record},()=>{if(wrote)throw error;}),e=>e===error);
 assert.equal(store.ledger.getPlan(plan.runId,1),undefined);assert.equal(store.ledger.listOpenStages().length,0);
 assert.equal(store.ledger.readEvents({after:0,limit:500}).events.filter(e=>e.kind==='staging-aborted').length,1);
});
test('genuinely admitted bootstrap starts at original preparation time; existing rows are not overwritten',needsStore,async t=>{
 const {resolvePreparationInputs,preparationTerms,resolvePreparationRun,recordPreparationBootstrap}=await import('../dist/service/preparation-inputs.js');
 const {admitPlan,loadPlan}=await import('../dist/execution/plans.js'),{planBootstrap,planAnalysis,plannerSnapshotFrom,plannerAnalysisFrom,plannerLockFrom,plannerPolicyFrom}=await import('../dist/planner/index.js');
 const {captureSnapshot}=await import('../dist/snapshot/index.js'),{Coordinator}=await import('../dist/execution/coordinator.js');
 const {scratchUnder}=await import('./lease-helpers.ts'),{loadBootstrap}=await import('../dist/execution/bootstrap.js');
 const f=await preparationFixture(t),acceptedAt=new Date(Date.now()-2000).toISOString(),clock=preparationClock(f.store,{acceptedAt,deadlineAt:new Date(Date.parse(acceptedAt)+600000).toISOString()});
 const proof=resolvePreparationInputs(f.store,{workspace:f.ws.path,trustDir:f.ws.trustDir,registry:f.registry},()=>clock.stillWithin());
 const {snapshot}=await captureSnapshot(f.store,{mode:'working-copy',sources:[{sourceId:'workspace',repositoryId:'local-workspace',root:f.ws.path}]});
 const identity=await resolvePreparationRun(f.store,proof,snapshot.id,clock),terms=preparationTerms(f.store,proof,()=>clock.stillWithin());
 const boot=planBootstrap({runId:identity.runId,sourceIds:['workspace'],profile:terms.profile.planner});
 await admitPlan(f.store,{plan:boot,ruleLock:null,policy:null,profile:terms.profile.record},()=>clock.stillWithin());
 assert.deepEqual(await recordPreparationBootstrap(f.store,identity),{runDeadlineAt:clock.deadlineAt});
 const original=f.store.ledger.getRun(identity.runId)!.envelope;assert.equal(original.createdAt,acceptedAt);assert.equal(original.state,'planned');
 const sequence=f.store.ledger.currentSequence();await recordPreparationBootstrap(f.store,identity);assert.equal(f.store.ledger.currentSequence(),sequence);assert.deepEqual(f.store.ledger.getRun(identity.runId)!.envelope,original);
 const c=await Coordinator.open({store:f.store,runId:identity.runId,registry:f.registry,scratchRoot:scratchUnder(f.store)});const summary=await c.run();
 assert.equal(summary.kind,'bootstrap');assert.equal(summary.published,boot.units.length,JSON.stringify(summary));assert.equal(f.store.ledger.getRun(identity.runId)!.envelope.createdAt,acceptedAt,'legacy Coordinator preserves the preexisting row');
 // Genuine published bootstrap parent, canceled before analysis; a later admitted analysis is not its current revision.
 c.cancel();assert.equal((await c.run()).state,'canceled');const inventory=boot.units.find(u=>u.stage==='inventory')!,evidence=await loadBootstrap(f.store,identity.runId,{id:inventory.id,revision:inventory.revision});
 const analysis=planAnalysis({runId:identity.runId,revision:2,previous:boot,bootstrap:[{id:inventory.id,revision:inventory.revision}],profile:terms.profile.planner,
 snapshot:plannerSnapshotFrom(evidence.snapshot),analyses:evidence.analyses.map(a=>plannerAnalysisFrom(a as never)),lock:plannerLockFrom(terms.current.lock,terms.packs,terms.current.digest),policy:plannerPolicyFrom(terms.policy)});
 await admitPlan(f.store,{plan:analysis,ruleLock:terms.current.lock,policy:terms.policy,profile:terms.profile.record});
 const parent={runId:identity.runId,revision:1,planDigest:boot.digest,snapshotId:snapshot.id};
 assert.equal(f.store.ledger.getRun(identity.runId)!.planRevision,1);assert.equal(f.store.ledger.latestPlan(identity.runId)!.revision,2);
 const child=await resolvePreparationRun(f.store,proof,snapshot.id,clock,parent);assert.notEqual(child.runId,parent.runId);
 await assert.rejects(resolvePreparationRun(f.store,proof,snapshot.id,clock,{...parent,revision:2,planDigest:analysis.digest}),code('sentinel.preparation.changed'));
 assert.equal((await loadPlan(f.store,parent.runId,1)).plan.digest,boot.digest);
});

test('pure policy loader refuses a source FIFO without waiting, creating state or evaluating source code',needsStore,async t=>{
 const {execFileSync,spawnSync}=await import('node:child_process'),{fileURLToPath}=await import('node:url');
 const f=await preparationFixture(t),before=treeFiles(f.ws.trustDir),path=join(f.ws.path,'sentinel.config.json');
 execFileSync('mkfifo',[path]);
 const module=fileURLToPath(new URL('../dist/policy/adoption.js',import.meta.url));
 const child=spawnSync(process.execPath,['--input-type=module','-e',`const {loadPolicyInputsReadOnly}=await import(${JSON.stringify(module)});try{loadPolicyInputsReadOnly(${JSON.stringify({workspace:f.ws.path,trustDir:f.ws.trustDir})});process.exitCode=2;}catch(e){process.stdout.write(e.code??'unknown');}`],{encoding:'utf8',timeout:3000});
 assert.ifError(child.error);assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'sentinel.policy.settingsUnreadable');assert.deepEqual(treeFiles(f.ws.trustDir),before);
});
test('an admitted noncanonical bootstrap cannot create a preparation run, even with the right profile and run ID',needsStore,async t=>{
 const {resolvePreparationInputs,preparationTerms,resolvePreparationRun,recordPreparationBootstrap}=await import('../dist/service/preparation-inputs.js');
 const {admitPlan}=await import('../dist/execution/plans.js'),{planBootstrap}=await import('../dist/planner/index.js'),{captureSnapshot}=await import('../dist/snapshot/index.js');
 const f=await preparationFixture(t),now=Date.now(),clock=preparationClock(f.store,{acceptedAt:new Date(now).toISOString(),deadlineAt:new Date(now+600000).toISOString()});
 const inputs=resolvePreparationInputs(f.store,{workspace:f.ws.path,trustDir:f.ws.trustDir,registry:f.registry}),terms=preparationTerms(f.store,inputs,()=>clock.stillWithin());
 const {snapshot}=await captureSnapshot(f.store,{mode:'working-copy',sources:[{sourceId:'workspace',repositoryId:'local-workspace',root:f.ws.path}]});
 const identity=await resolvePreparationRun(f.store,inputs,snapshot.id,clock),boot=planBootstrap({runId:identity.runId,sourceIds:['foreign'],profile:terms.profile.planner});
 await admitPlan(f.store,{plan:boot,ruleLock:null,policy:null,profile:terms.profile.record});const before=f.store.ledger.currentSequence();
 await assert.rejects(recordPreparationBootstrap(f.store,identity),code('sentinel.preparation.changed'));assert.equal(f.store.ledger.getRun(identity.runId),null);assert.equal(f.store.ledger.currentSequence(),before);
 await assert.rejects(recordPreparationBootstrap(f.store,{...identity}),code('sentinel.preparation.changed'));
});

for(const pass of[1,2])test(`a fence immediately after enumeration ${pass} closes every real Git reservation`,needsStore,async t=>{
 const{Inventory}=await import('../dist/snapshot/inventory.js'),{git}=await import('./snapshot-helpers.ts');
 const dir=scratch(t),root=join(dir,'repo');commitRepo(root,{'src/one.ts':'export const one=1;'.repeat(50)});git(root,['gc','--quiet','--prune=now']);
 const{store}=await openCaptureStore(t,dir),budget=new GitReadBudget(),original=Inventory.prototype.refuseCaseCollisions;let enumerations=0,held=false;
 t.mock.method(Inventory.prototype,'refuseCaseCollisions',function(this:any){const result=original.call(this);enumerations++;return result;});
 const error=new Error(`original after-enumeration ${pass}`);
 await assert.rejects(captureWithBudget(store,{mode:'working-copy',sources:[{sourceId:'app',repositoryId:'fixture',root}]},budget,()=>{
  if(enumerations===pass){held=budget.usedBytes>0;throw error;}
 }),e=>e===error);
 assert.equal(held,true,'actual packed Git data was retained when the boundary fired');
 assert.deepEqual([budget.usedBytes,budget.usedObjects],[0,0]);assert.equal(store.ledger.listOpenStages().length,0);
 assert.equal(store.ledger.readEvents({after:0,limit:500}).events.some(e=>e.kind==='snapshot-admitted'),false);
});
