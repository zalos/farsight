// Internal path-task retention admission. Only the existing owner-bound read proof supplies closure links; a
// canonical request is source-derived data and cannot grant launch, select a parent publication or supply links.
import type { ArtifactId, PathRequestEnvelope } from '../../contracts/index.js';
import { canonicalArtifactId } from '../../planner/boundary.js';
import type { PlanEnvelope } from '../../contracts/plan.js';
import type { PlanRevision } from '../../planner/types.js';
import type { SentinelStore } from '../../store/index.js';
import { canonicalJsonBytes } from '../../store/objects.js';
import { ExecutionError } from '../../execution/errors.js';
import { readRetainedSourceProof, assertRetainedSourceProof, RetainedBudget, type ProofTiming, type RetainedSourceProof } from '../../execution/retained-source.js';
import type { ExecutionProfileRecord } from '../../execution/profile.js';
import { pathRequestOf, PATHS_ADAPTER_ID, PATHS_PROTOCOL_INPUT_LIMIT, PATHS_RESERVED_INPUTS, type CanonicalPathRequest } from './request.js';

export interface PathRequestAdmission {
  readonly document: PathRequestEnvelope;
  readonly proof: RetainedSourceProof;
  readonly timing: ProofTiming;
}
const refuse = (reason: string): never => { throw new ExecutionError('sentinel.execution.planInvalid', { reason }); };
const same = (a: unknown, b: unknown) => canonicalJsonBytes(a).equals(canonicalJsonBytes(b));
export const requestAncestor = (r: Readonly<PathRequestEnvelope>) => ({ ...r.ancestor, snapshotId:r.snapshotId, sourceId:r.sourceId });

/** Exact active unit set, derived from the immutable admitted plan and its authenticated request pin. */
export function pathUnitsFor(plan: Readonly<PlanEnvelope>, request: CanonicalPathRequest): Set<string> {
  const r=request.value;
  if(plan.kind!=='analysis'||plan.pins.pathRequest!==request.id||plan.pins.snapshotId!==r.snapshotId||plan.runId===r.ancestor.runId
    ||plan.pins.analyses.filter(a=>a.sourceId===r.sourceId).length!==1) return refuse('the path request differs from the admitted source and capture');
  const units=plan.units.filter(u=>u.adapterId===PATHS_ADAPTER_ID&&u.sourceId===r.sourceId);
  if(!units.length) return refuse('the requested source has no supported path unit');
  for(const u of units){
    if(u.inputs.length+PATHS_RESERVED_INPUTS>PATHS_PROTOCOL_INPUT_LIMIT) return refuse('the whole source exceeds the sealed path input protocol bound');
    if(u.stage!=='check'||u.scopes.length!==1||u.scopes[0]!==r.sourceId||u.dependencies.length!==1
      ||!plan.reused.some(x=>x.id===u.dependencies[0]!.id&&x.revision===u.dependencies[0]!.revision)
      ||u.checks.length===0||u.checks.some(id=>!plan.checks.some(c=>c.id===id&&c.state==='planned'&&c.sourceId===r.sourceId&&c.scopeKind==='repository'&&c.scopeId===r.sourceId&&c.familyId==='sentinel.paths.call-reachability'&&c.unit?.id===u.id&&c.unit.revision===u.revision))) {
      return refuse('path units require their exact repository assignment and retained bootstrap only');
    }
    const families=[...new Set(plan.checks.filter(c=>u.checks.includes(c.id)).map(c=>c.familyId))].sort();
    const expected=canonicalArtifactId({pathRequest:request.id,inventory:plan.pins.inventoryDigest,environment:plan.pins.environment,
      analysis:plan.pins.analyses.find(a=>a.sourceId===r.sourceId)!.analysisFingerprint,
      rules:families.map(f=>{const pin=plan.pins.rules.find(p=>p.familyId===f);if(!pin)return refuse('a path rule has no exact pin');return [pin.familyId,pin.revision,pin.definitionDigest,pin.packDigest]}),
      adapterId:u.adapterId,implementationDigest:u.implementationDigest,scopes:[...u.scopes].sort(),inputs:u.inputs.map(i=>[i.relativePath,i.content]),databases:[]});
    if(u.inputFingerprint!==expected) return refuse('the path unit fingerprint does not bind its exact request and inputs');
  }
  return new Set(units.map(u=>u.id));
}

/** Validate every retained link before staging, then return only internally derived accepted identities. */
export async function verifyPathAdmission(store: SentinelStore, plan: PlanRevision, profile: ExecutionProfileRecord, supplied: PathRequestAdmission) {
  const { document, proof, timing: callerTiming }=supplied;
  const { signal, deadlineAt, stillWithin }=callerTiming;
  const timing: ProofTiming=Object.freeze({signal,...(deadlineAt!==undefined?{deadlineAt}:{}),...(stillWithin?{stillWithin}:{})});
  const request=pathRequestOf(document),ancestor=requestAncestor(request.value);
  const childBoundary=()=>{
    const child=store.ledger.getRun(plan.runId);
    if(child&&(child.envelope.parentId!==ancestor.runId||child.envelope.snapshotId!==ancestor.snapshotId)) return refuse('the recorded path task parent or capture differs from the proven request ancestor');
  };
  childBoundary();
  const view=readRetainedSourceProof(store,proof,ancestor,timing);
  const units=pathUnitsFor(plan,request);
  if(!same(profile.parse,view.parse)||plan.pins.analyses.find(a=>a.sourceId===view.sourceId)?.analysisFingerprint!==view.analysisFingerprint) {
    return refuse('the path task must retain the original admitted parse settings and source analysis');
  }
  // Every revalidation read retains the mint's original fences even if this caller supplies a later deadline.
  const originalBoundary=()=>{childBoundary();assertRetainedSourceProof(store,proof,ancestor,timing)};
  const budget=new RetainedBudget(store,{signals:[timing.signal],...(timing.deadlineAt!==undefined?{deadlineAt:timing.deadlineAt}:{}),stillWithin:[originalBoundary]});
  const closure=new Set(view.closure.map(c=>c.id));
  const parent=await budget.planLoader()(ancestor.runId,ancestor.revision);
  if(!closure.has(parent.record.plan)||parent.plan.digest!==ancestor.planDigest) return refuse('the request ancestor is not the proven plan');
  const inventories=parent.plan.reused.filter(ref=>store.ledger.getPublication(ref)?.outputs.some(o=>o.schema==='sentinel-bootstrap-inventory/draft-1'&&closure.has(o.id)));
  if(inventories.length!==1||plan.reused.length!==1||!same(plan.reused[0],inventories[0])) return refuse('a path task reuses only its proven ancestor inventory');
  const expected=view.entries.flatMap(e=>e.kind==='file'&&e.disposition==='included'?[{sourceId:e.sourceId,relativePath:e.relativePath,content:e.content}]:[]).sort((a,b)=>a.relativePath.localeCompare(b.relativePath));
  for(const u of plan.units.filter(u=>units.has(u.id))) {
    if(!same([...u.inputs].sort((a,b)=>a.relativePath.localeCompare(b.relativePath)),expected)) return refuse('a path unit must seal every included body of its proven source');
  }
  if(closure.has(request.id)) return refuse('a request cannot retain itself as ancestor evidence');
  const source=new Set(view.closure.filter(c=>c.role==='source-content').map(c=>c.id));
  for(const id of closure) await budget.read(id,source.has(id)?'source':'metadata');
  assertRetainedSourceProof(store,proof,ancestor,timing);
  return {request,links:[...closure].sort() as ArtifactId[],usage:budget.usage(),boundary:()=>{
    budget.boundary();originalBoundary();
  }};
}
