// Internal admission over genuine accepted ancestors. No worker registration/launch or public command is claimed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retainedFixture } from './retained-analysis-helpers.ts';
import { needsStore } from './snapshot-helpers.ts';
import { lockedRules, policyView } from './planner-helpers.ts';
import { Coordinator } from '../dist/execution/coordinator.js';
import { loadBootstrap } from '../dist/execution/bootstrap.js';
import { admitPlan, loadPlan } from '../dist/execution/plans.js';
import { executablePlan } from '../dist/execution/plan.js';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { executionProfileRecord } from '../dist/execution/profile.js';
import { createCapabilityTable, planAnalysis, plannerSnapshotFrom, plannerAnalysisFrom } from '../dist/planner/index.js';
import { retainedSourceForAdmission, readRetainedSourceProof, assertRetainedSourceProof, retainedSourceProofUsage, RetainedBudget } from '../dist/execution/retained-source.js';
import { digestOf } from '../dist/store/ledger-json.js';
import { pathRequestOf } from '../dist/analysis/paths/request.js';
import { pathUnitsFor, verifyPathAdmission } from '../dist/analysis/paths/admission.js';

async function candidate(t:any, canceled=false) {
  const s=await retainedFixture(t,{otherSource:true});
  const coordinator=await Coordinator.open({store:s.store,runId:s.run.id,registry:s.registry,scratchRoot:s.work});
  if(canceled)coordinator.cancel();
  const completed=await coordinator.run();
  assert.equal(completed.state,canceled?'canceled':'completed');
  const ancestor={runId:s.run.id,revision:2,planDigest:s.analysis.digest,snapshotId:s.snapshot.id,sourceId:'app'};
  const timing={signal:new AbortController().signal,deadlineAt:performance.now()+60000};
  const proof=await retainedSourceForAdmission(s.store,ancestor,timing);
  const view=readRetainedSourceProof(s.store,proof,ancestor,timing);
  const request=pathRequestOf({schema:'sentinel-path-request/draft-1',ancestor:{runId:ancestor.runId,revision:ancestor.revision,planDigest:ancestor.planDigest},snapshotId:ancestor.snapshotId,sourceId:'app',
    queries:[{from:'app::src/app.ts::app',to:'app::src/other.ts::other'}],bounds:{edgeKinds:['calls'],maxDepth:12,maxFanout:256,maxVisited:50000}});
  const module=fileURLToPath(new URL('./fixtures/workers/hostile-worker.mjs',import.meta.url));
  const registry=createAdapterRegistry([
    {id:'bounded-paths',version:'test',kind:'built-in',isolation:'child',module},
    {id:'sentinel-pattern',version:'1',kind:'built-in',isolation:'child',module},
    ...(['capture','parse','inventory'] as const).map(operation=>({id:`retained-${operation}`,version:'1',kind:'operation' as const,operation})),
  ]);
  const facts=[{capability:'source-bytes',adapterId:'bounded-paths',evidence:'genuine retained source'},{capability:'call-occurrence',adapterId:'bounded-paths',evidence:'genuine retained parser',perFileParse:true},{capability:'pattern-match',adapterId:'sentinel-pattern',evidence:'unrelated held control'}];
  const profile={id:'path-admission-fixture',registry,capabilities:createCapabilityTable(registry,facts),permits:facts.map(f=>f.capability),operations:{capture:'retained-capture',parse:'retained-parse',inventory:'retained-inventory'}};
  const record=executionProfileRecord(profile as any,s.record.resources,s.record.parse);
  const rules=lockedRules([{familyId:'sentinel.paths.call-reachability',adapterId:'bounded-paths',scopeKind:'repository',requires:['source-bytes','call-occurrence']},{familyId:'sentinel.fixture.unrelated',adapterId:'sentinel-pattern',scopeKind:'repository',requires:['pattern-match']}],[]);
  const {policy,view:policyPlan}=policyView(rules.view.rules.map(r=>r.familyId));
  const bootstrap=await loadBootstrap(s.store,s.run.id,s.inventory);
  const plan=planAnalysis({runId:'run-request-admission',bootstrap:[s.inventory],profile,snapshot:plannerSnapshotFrom(s.snapshot),analyses:bootstrap.analyses.map(a=>plannerAnalysisFrom(a)),lock:rules.view,policy:policyPlan,pathRequest:request.value} as any);
  const admission={plan,ruleLock:rules.lock,policy,profile:record,pathRequest:{document:request.value,proof,timing}};
  const parentEvents=s.store.ledger.currentSequence();
  return {...s,parentTerms:{profile:s.profile,record:s.record,policy:s.policy,view:s.view,rules:s.rules},pathTerms:{profile,record,rules,policy,view:policyPlan},ancestor,timing,proof,view,request,registry,record,plan,admission,parentEvents};
}
const refused=(e:any)=>['sentinel.execution.analysisUnavailable','sentinel.execution.planInvalid'].includes(e.code);
function objectNames(store:any){const files:string[]=[];const walk=(p:string)=>{for(const n of readdirSync(p,{withFileTypes:true})){const f=join(p,n.name);if(n.isDirectory())walk(f);else files.push(f)}};walk(join(store.storePath,'objects'));return files.sort()}

for(const fault of ['missing-proof','copied-proof','wrong-request','wrong-ancestor','deadline','canceled'] as const) test(`path admission ${fault} refuses before any staging or object write`,needsStore,async t=>{
  const s=await candidate(t),input:any={...s.admission,pathRequest:{...s.admission.pathRequest}};
  if(fault==='missing-proof')delete input.pathRequest;
  if(fault==='copied-proof')input.pathRequest.proof={...s.proof};
  if(fault==='wrong-request')input.pathRequest.document={...s.request.value,bounds:{...s.request.value.bounds,maxDepth:13}};
  if(fault==='wrong-ancestor')input.pathRequest.document={...s.request.value,ancestor:{...s.request.value.ancestor,revision:1}};
  if(fault==='deadline')input.pathRequest.timing={...s.timing,deadlineAt:performance.now()-1};
  if(fault==='canceled'){const c=new AbortController();c.abort();input.pathRequest.timing={...s.timing,signal:c.signal}}
  const before=s.store.ledger.currentSequence(),files=objectNames(s.store);
  await assert.rejects(admitPlan(s.store,input),fault==='deadline'||fault==='canceled'?(e:any)=>['sentinel.execution.deadlineExceeded','sentinel.execution.canceled'].includes(e.code):refused);
  assert.equal(s.store.ledger.currentSequence(),before);assert.deepEqual(objectNames(s.store),files);assert.equal(s.store.ledger.latestPlan(s.plan.runId),undefined);
});

test('one transaction retains the canonical request and complete proven closure; active units are exact and unrelated units held',needsStore,async t=>{
  const s=await candidate(t);const active=pathUnitsFor(s.plan,s.request);
  assert.equal(active.size,1);assert.ok(s.plan.units.some(u=>u.adapterId!=='bounded-paths'));
  const checked=await verifyPathAdmission(s.store,s.plan,s.admission.profile,s.admission.pathRequest);
  t.diagnostic(JSON.stringify({proof:retainedSourceProofUsage(s.proof),revalidation:checked.usage,separateBudgetPasses:true}));
  const record=await admitPlan(s.store,s.admission);const admitted=await loadPlan(s.store,s.plan.runId,1);
  assert.deepEqual(admitted.pathRequest,s.request.value);assert.equal(s.store.objects.identify(await s.store.readArtifact(s.request.id)).id,s.request.id);
  const reachable=(await s.store.inspect()).reachable;for(const id of [record.plan,s.request.id,...s.view.closure.map(c=>c.id)])assert.ok(reachable.includes(id),id);
  const sequence=s.store.ledger.currentSequence();assert.equal((await admitPlan(s.store,s.admission)).plan,record.plan);assert.equal(s.store.ledger.currentSequence(),sequence);
  const run={...s.run,id:s.plan.runId,parentId:s.run.id,planRevision:1,ruleLockDigest:s.plan.pins.ruleLockDigest,toolLockDigest:s.plan.pins.ruleLockDigest,policyRevisionDigest:s.plan.pins.policyDigest,requestedScope:{sourceIds:['app','other'],profile:s.record.id}};
  const executable=await executablePlan(s.store,admitted as any,run,1,s.registry,s.work);
  for(const work of executable.works)assert.equal(work.state==='disabled-by-policy',!active.has(work.id));
  assert.equal(s.store.ledger.getRun(s.plan.runId),null,'admission does not create or execute a run');
  assert.equal(s.store.ledger.currentSequence(),sequence,'validation of held units starts no work');
});

test('a dangling proof closure member is refused before staging even if removed after mint',needsStore,async t=>{
  const s=await candidate(t),id=s.view.artifact.id,hex=id.slice(7),dir=join(s.store.storePath,'objects/sha256',hex.slice(0,2));
  const originals=readdirSync(dir).filter(n=>n.startsWith(hex+'.')).map(n=>({path:join(dir,n),bytes:readFileSync(join(dir,n))}));assert.ok(originals.length);
  for(const o of originals)unlinkSync(o.path);
  const sequence=s.store.ledger.currentSequence(),files=objectNames(s.store);
  try{await assert.rejects(admitPlan(s.store,s.admission));assert.equal(s.store.ledger.currentSequence(),sequence);assert.deepEqual(objectNames(s.store),files)}
  finally{for(const o of originals)writeFileSync(o.path,o.bytes)}
});


test('genuine canceled ancestor retains accepted parse authority without granting launch',needsStore,async t=>{
  const s=await candidate(t,true);assert.equal(s.store.ledger.getRun(s.run.id)!.state,'canceled');
  const before=s.store.ledger.currentSequence();await admitPlan(s.store,s.admission);
  assert.ok(s.store.ledger.currentSequence()>before);assert.equal(s.store.ledger.getRun(s.plan.runId),null);
  assert.deepEqual((await loadPlan(s.store,s.plan.runId,1)).pathRequest,s.request.value);
});

test('a merely admitted future ancestor revision does not replace the recorded proof or permit a request to that future',needsStore,async t=>{
  const s=await candidate(t),boot=await loadBootstrap(s.store,s.run.id,s.inventory);
  const future=planAnalysis({runId:s.run.id,revision:3,previous:s.analysis,bootstrap:[s.inventory],profile:s.parentTerms.profile,
    snapshot:plannerSnapshotFrom(s.snapshot),analyses:boot.analyses.map(a=>plannerAnalysisFrom(a)),lock:s.parentTerms.rules.view,policy:s.parentTerms.view});
  await admitPlan(s.store,{plan:future,ruleLock:s.parentTerms.rules.lock,policy:s.parentTerms.policy,profile:s.parentTerms.record});
  assert.equal(s.store.ledger.latestPlan(s.run.id)!.revision,3);assert.equal(s.store.ledger.getRun(s.run.id)!.planRevision,2);
  await admitPlan(s.store,s.admission);
  const before=s.store.ledger.currentSequence();
  await assert.rejects(retainedSourceForAdmission(s.store,{...s.ancestor,revision:3,planDigest:future.digest},s.timing),refused);
  assert.equal(s.store.ledger.currentSequence(),before);
});

test('a canceled path task proves only its exact accepted request ancestry; parentId alone cannot replace that edge',needsStore,async t=>{
  const s=await candidate(t);await admitPlan(s.store,s.admission);
  const run={...s.run,id:s.plan.runId,parentId:s.run.id,planRevision:1,ruleLockDigest:s.plan.pins.ruleLockDigest,toolLockDigest:s.plan.pins.ruleLockDigest,
    policyRevisionDigest:s.plan.pins.policyDigest,requestedScope:{sourceIds:['app','other'],profile:s.admission.profile.id}};
  const coordinator=await Coordinator.open({store:s.store,runId:s.plan.runId,run:run as any,registry:s.registry,scratchRoot:s.work});coordinator.cancel();
  assert.equal((await coordinator.run()).state,'canceled');
  const ancestor={...s.ancestor,runId:s.plan.runId,revision:1,planDigest:s.plan.digest};
  const proof=await retainedSourceForAdmission(s.store,ancestor,s.timing),view=readRetainedSourceProof(s.store,proof,ancestor,s.timing);
  assert.ok(view.closure.some(c=>c.role==='path-request'&&c.id===s.request.id));
  const next=pathRequestOf({...s.request.value,ancestor:{runId:ancestor.runId,revision:1,planDigest:s.plan.digest}});
  const bootstrap=await loadBootstrap(s.store,s.run.id,s.inventory);
  // Reconstruct under the exact same trusted profile from the admitted candidate, without invoking a worker.
  const admitted=await loadPlan(s.store,s.plan.runId,1);
  const child=planAnalysis({runId:'run-request-grandchild',bootstrap:[s.inventory],profile:s.pathTerms.profile,snapshot:plannerSnapshotFrom(s.snapshot),analyses:bootstrap.analyses.map(a=>plannerAnalysisFrom(a)),lock:s.pathTerms.rules.view,policy:s.pathTerms.view,pathRequest:next.value} as any);
  assert.equal(child.pins.ruleLockDigest,admitted.plan.pins.ruleLockDigest);assert.equal(child.pins.policyDigest,admitted.plan.pins.policyDigest);
  await admitPlan(s.store,{...s.admission,plan:child,pathRequest:{document:next.value,proof,timing:s.timing}});
  assert.ok((await s.store.inspect()).reachable.includes(next.id));
});


test('a rehashed plan cannot detach a path unit fingerprint from its request',needsStore,async t=>{
  const s=await candidate(t),plan=structuredClone(s.plan),unit=plan.units.find(u=>u.adapterId==='bounded-paths')!;
  unit.inputFingerprint=`sha256:${'f'.repeat(64)}`;const{digest:_old,...body}=plan;plan.digest=digestOf(body);
  const sequence=s.store.ledger.currentSequence(),files=objectNames(s.store);
  await assert.rejects(admitPlan(s.store,{...s.admission,plan}),refused);
  assert.equal(s.store.ledger.currentSequence(),sequence);assert.deepEqual(objectNames(s.store),files);
});


test('non-copying assertion keeps original proof bounds while the accessor still copies and checks',needsStore,async t=>{
  const s=await candidate(t);const from=Buffer.from;let copies=0;
  const mock=t.mock.method(Buffer,'from',function(value:any,...rest:any[]){if(value instanceof Uint8Array)copies++;return (from as any).call(Buffer,value,...rest)});
  assertRetainedSourceProof(s.store,s.proof,s.ancestor,s.timing);assert.equal(copies,0);
  readRetainedSourceProof(s.store,s.proof,s.ancestor,s.timing);assert.ok(copies>=3,'accessor retains independent returned buffers');mock.mock.restore();
  const c=new AbortController();const proof=await retainedSourceForAdmission(s.store,s.ancestor,{...s.timing,signal:c.signal});c.abort();
  assert.throws(()=>assertRetainedSourceProof(s.store,proof,s.ancestor,{signal:new AbortController().signal,deadlineAt:Infinity}),(e:any)=>e.code==='sentinel.execution.canceled');
  const deadlineAt=performance.now()+1000,expired=await retainedSourceForAdmission(s.store,s.ancestor,{signal:new AbortController().signal,deadlineAt});
  const clock=t.mock.method(performance,'now',()=>deadlineAt+1);
  try{assert.throws(()=>assertRetainedSourceProof(s.store,expired,s.ancestor,{signal:new AbortController().signal,deadlineAt:Infinity}),(e:any)=>e.code==='sentinel.execution.deadlineExceeded')}finally{clock.mock.restore()}
});

test('a path pin with a legacy rerun selection refuses explicitly before staging',needsStore,async t=>{
  const s=await candidate(t),unit=s.plan.units.find(u=>u.adapterId==='bounded-paths')!;
  const selection={schema:'sentinel-rerun-selection/draft-1',parent:{...s.request.value.ancestor,snapshotId:s.snapshot.id},selected:[{unit:unit.id,parentUnit:'fabricated-parent-unit'}],downstream:[],held:s.plan.units.filter(u=>u.id!==unit.id).map(u=>({unit:u.id,parentUnit:null})),reused:s.plan.reused};
  const before=s.store.ledger.currentSequence(),files=objectNames(s.store);
  await assert.rejects(admitPlan(s.store,{...s.admission,selection} as any),(e:any)=>e.code==='sentinel.execution.planInvalid'&&e.detail.reason.includes('separately authenticated'));
  assert.equal(s.store.ledger.currentSequence(),before);assert.deepEqual(objectNames(s.store),files);
});

test('revalidation stops at the original proof deadline after an awaited read even with a later caller deadline',needsStore,async t=>{
  const s=await candidate(t),read=RetainedBudget.prototype.read,before=s.store.ledger.currentSequence(),files=objectNames(s.store);
  let readBudget:any,expired=false;
  const now=performance.now.bind(performance);
  const clock=t.mock.method(performance,'now',()=>expired?s.timing.deadlineAt+1:now());
  const reader=t.mock.method(RetainedBudget.prototype,'read',async function(id:any,kind:any){
    readBudget=this;const bytes=await read.call(this,id,kind);expired=true;return bytes;
  });
  try{
    await assert.rejects(admitPlan(s.store,{...s.admission,pathRequest:{...s.admission.pathRequest,timing:{signal:new AbortController().signal,deadlineAt:Infinity}}}),
      (e:any)=>e.code==='sentinel.execution.deadlineExceeded');
    assert.equal(readBudget.reads,1,'the original fence prevents starting another actual revalidation read');
    assert.equal(s.store.ledger.currentSequence(),before);assert.deepEqual(objectNames(s.store),files);
  }finally{reader.mock.restore();clock.mock.restore()}
});
