// Internal owner preparation over a genuine ended ancestor. A candidate is disclosure data plus the existing
// read-only proof, never execution authority. Admission retains the request/closure atomically; run.start is later.
import type { PathRequestEnvelope, RunEnvelope } from '../contracts/index.js';
import type { SentinelStore } from '../store/index.js';
import type { EffectivePolicy } from '../policy/index.js';
import { deepFreeze } from '../policy/immutable.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { admitPlan, loadPlan } from '../execution/plans.js';
import { unitIdentity } from '../execution/selection.js';
import { retainedSourceForAdmission, readRetainedSourceProof, assertRetainedSourceProof, RetainedBudget, retainedSourceProofUsage, type ProofTiming } from '../execution/retained-source.js';
import { pathRequestOf, pathRequestRunId } from '../analysis/paths/request.js';
import { requestAncestor, pathUnitsFor } from '../analysis/paths/admission.js';
import { PATHS_SUPPORTED_RULES } from '../analysis/paths/definitions.js';
import { planAnalysis, plannerSnapshotFrom, plannerAnalysisFrom, plannerLockFrom, plannerPolicyFrom } from '../planner/index.js';
import { validateEnvelope } from '../validate.js';
import { RuleLockBook } from './rule-locks.js';
import { publicRegistry, publicProfile } from './scanner-profile.js';
import { pathsAvailable, PATHS_ADAPTER_ID } from './path-adapter.js';
import { ServiceError } from './owner-service.js';
import { ExecutionError } from '../execution/errors.js';
import { digestOf } from '../store/ledger-json.js';

const same=(a:unknown,b:unknown)=>canonicalJsonBytes(a).equals(canonicalJsonBytes(b));
const invalid=(reason:string):never=>{throw new ExecutionError('sentinel.execution.planInvalid',{reason})};
const ended=(state:string|undefined)=>state==='completed'||state==='canceled';
export interface PathTaskTerms { readonly trustDir:string; readonly policy:EffectivePolicy; readonly now:Date }

/** Whole-source preparation has its own original deadline. Every awaited proof/read retains these same fences. */
export async function preparePathTask(store:SentinelStore,document:Readonly<PathRequestEnvelope>,terms:PathTaskTerms,timing:ProofTiming){
  const request=pathRequestOf(document),anchor=requestAncestor(request.value),book=new RuleLockBook(terms.trustDir),current=book.current();
  if(!current)throw new ServiceError('sentinel.service.noRuleLock');
  if(!PATHS_SUPPORTED_RULES.every(r=>terms.policy.rules.includes(r.familyId)))return invalid('the current owner policy does not select the shipped structural family');
  const packs=book.packsOf(current.lock);if(!pathsAvailable(current.lock,packs))return invalid('the current owner lock has no exact promoted structural pack');
  const checkTerms=()=>{store.assertHeld();timing.stillWithin?.();if(book.currentDigest()!==current.digest)return invalid('the owner lock changed during structural preparation')};
  const originalTiming={signal:timing.signal,deadlineAt:timing.deadlineAt,stillWithin:checkTerms};
  checkTerms();
  const proof=await retainedSourceForAdmission(store,anchor,originalTiming),source=readRetainedSourceProof(store,proof,anchor,originalTiming);
  const boundary=()=>{checkTerms();assertRetainedSourceProof(store,proof,anchor,originalTiming)};
  // Separate counted candidate-metadata pass, not a reset or extension of the original proof budget/deadline.
  const metadata=new RetainedBudget(store,{signals:[timing.signal],deadlineAt:timing.deadlineAt,stillWithin:[boundary]});
  const ancestor=await metadata.planLoader()(anchor.runId,anchor.revision);
  if(ancestor.plan.digest!==anchor.planDigest)return invalid('the candidate ancestor differs from its original proof');
  const closure=new Set(source.closure.map(c=>c.id));
  const inventory=ancestor.plan.reused.filter(r=>store.ledger.getPublication(r)?.outputs.some(o=>o.schema==='sentinel-bootstrap-inventory/draft-1'&&closure.has(o.id)));
  if(inventory.length!==1)return invalid('the candidate has no unique proven retained inventory');
  const snapshotBytes=await metadata.read(source.manifest,'metadata');
  let snapshotValue:unknown;try{snapshotValue=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(snapshotBytes))}catch{return invalid('the original snapshot manifest is malformed')}
  const snapshot=validateEnvelope('snapshot',snapshotValue);if(!snapshot.ok||snapshot.value.id!==anchor.snapshotId)return invalid('the candidate snapshot differs from the proven capture');
  boundary();
  const registry=publicRegistry(terms.trustDir),profile=publicProfile(registry,new Set([PATHS_ADAPTER_ID]),packs);
  if(!same(profile.record.parse,source.parse))return invalid('this installation cannot retain the original parse settings');
  const build=(runId:string)=>planAnalysis({runId,bootstrap:inventory,profile:profile.planner,snapshot:plannerSnapshotFrom(snapshot.value),
    analyses:[plannerAnalysisFrom({sourceId:source.sourceId,result:source.result.value,index:source.index.value,artifact:source.artifact.value})],
    lock:plannerLockFrom(current.lock,packs,current.digest),policy:plannerPolicyFrom(terms.policy),pathRequest:request.value});
  const provisional=build('run-structural-identity'),active=pathUnitsFor(provisional,request);
  const unitSet=provisional.units.filter(u=>active.has(u.id)).map(unitIdentity).sort();
  const ids={ruleLockDigest:current.digest,policyDigest:terms.policy.revision,profileDigest:profile.digest};
  let generation=0,runId='';
  for(;generation<10000;generation++){
    boundary();runId=pathRequestRunId(request.value,ids,generation,unitSet);
    const record=store.ledger.latestPlan(runId),run=store.ledger.getRun(runId);
    if(!record&&!run)break;
    if(!record||record.revision!==1)return invalid('the existing path generation has no exact first admission');
    if(!ended(run?.state))break;
  }
  if(generation===10000)return invalid('the structural generation search bound was exceeded');
  const plan=build(runId),units=pathUnitsFor(plan,request);
  if(!same(plan.units.filter(u=>units.has(u.id)).map(unitIdentity).sort(),unitSet))return invalid('the final path unit set differs from its disclosed identity');
  const latest=store.ledger.latestPlan(runId),existing=latest?await loadPlan(store,runId,1):null;
  if(existing&&(existing.plan.digest!==plan.digest||existing.selection||!same(existing.pathRequest,request.value)))return invalid('the admitted path generation differs from the exact current candidate');
  boundary();
  const child=store.ledger.getRun(runId);
  if(child&&(child.envelope.parentId!==anchor.runId||child.envelope.snapshotId!==anchor.snapshotId||child.planRevision!==1||ended(child.state)))return invalid('the active structural generation changed during preparation');
  const state={request:request.id,ancestor:request.value.ancestor,runId,generation,planDigest:plan.digest,unitSet,
    lock:current.digest,policy:terms.policy.revision,profile:profile.digest,store:store.storeId,child:child?{state:child.state,revision:child.planRevision}:null};
  const preview=deepFreeze({parentId:anchor.runId,ancestor:request.value.ancestor,request:request.id,queries:request.value.queries,bounds:request.value.bounds,
    selected:[...units].sort(),held:plan.units.filter(u=>!units.has(u.id)).map(u=>u.id).sort(),prerequisites:inventory,
    requiredHeld:plan.checks.filter(c=>c.required&&(c.state!=='planned'||!c.unit||!units.has(c.unit.id))).length+plan.ruleGaps.filter(g=>g.required).length});
  return {request,plan,profile,current,proof,timing:originalTiming,generation,stateDigest:digestOf(state),state,preview,existing:Boolean(existing),
    usage:{proof:retainedSourceProofUsage(proof),candidateMetadata:metadata.usage()},boundary};
}
export type PathTaskCandidate=Awaited<ReturnType<typeof preparePathTask>>;

/** Recheck the exact disclosed active generation before its first write. A waiting receipt never reaches this. */
export async function acceptPathTask(store:SentinelStore,candidate:PathTaskCandidate,terms:PathTaskTerms){
  const c=candidate;c.boundary();
  const child=store.ledger.getRun(c.plan.runId);
  if(!same(child?{state:child.state,revision:child.planRevision}:null,c.state.child)||!same(terms.policy.revision,c.state.policy))return invalid('the disclosed structural state changed before admission');
  if(!c.existing)await admitPlan(store,{plan:c.plan,ruleLock:c.current.lock,policy:terms.policy,profile:c.profile.record,pathRequest:{document:c.request.value,proof:c.proof,timing:c.timing}});
  c.boundary();
  const admitted=await loadPlan(store,c.plan.runId,1);
  if(admitted.plan.digest!==c.plan.digest||!same(admitted.pathRequest,c.request.value))return invalid('the admitted structural candidate differs');
  c.boundary();
  // Recover the exact admission-before-run window from only its authenticated request/plan. No latest-plan advance.
  const run=store.ledger.getRun(c.plan.runId);
  if(!run){const parent=store.ledger.getRun(c.request.value.ancestor.runId)!;
    const envelope:RunEnvelope={schema:'sentinel-run/draft-1',id:c.plan.runId,parentId:parent.id,baselineId:null,snapshotId:c.request.value.snapshotId,planRevision:1,coordinatorEpoch:store.epoch,
      ruleLockDigest:c.plan.pins.ruleLockDigest!,toolLockDigest:c.plan.pins.ruleLockDigest!,policyRevisionDigest:c.plan.pins.policyDigest!,requestedScope:{sourceIds:[c.request.value.sourceId],profile:c.profile.record.id},
      budgets:structuredClone(parent.envelope.budgets),createdAt:admitted.record.admittedAt,state:'planned'};
    c.boundary();store.ledger.createRun(envelope);
  }
  return {outcome:c.existing?'kept' as const:'prepared' as const,runId:c.plan.runId,planDigest:c.plan.digest,request:c.request.id,generation:c.generation,preview:c.preview,usage:c.usage};
}
