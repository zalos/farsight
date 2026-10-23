// Public dispatch composes the reviewed production drivers without changing them. Registered code is distinct from
// an available capability: only exact owner-promoted tools and held databases enable a planner fact.
import {REVIEW_ADAPTERS} from '../review/dispatch.js';
import {createAdapterRegistry,type AdapterRegistry,type AdapterDefinition} from '../execution/registry.js';
import {createCheckDriverRegistry} from '../execution/check-drivers.js';
import {createCapabilityTable,type CapabilityFact} from '../planner/index.js';
import {executionProfileRecord} from '../execution/profile.js';
import {productionDrivers} from '../adapters/drivers/index.js';
import {foundationRegistry,foundationProfile,RESOURCES,PARSE,profileDigest,type TrustedProfile} from './trusted-profile.js';
import {previewDriver} from './preview-driver.js';
import type {ValidatedPack} from '../rules/index.js';
import type {DatabaseRecord} from '../adapters/drivers/index.js';
import {frameworkAdapter,frameworkAvailable,shippedFrameworkPack,FRAMEWORK_CONTROLS_ADAPTER_ID} from './framework-adapter.js';
import {pathAdapter,pathsAvailable,shippedPathPack,PATHS_ADAPTER_ID} from './path-adapter.js';
import type {RuleLockEnvelope} from '../contracts/rules.js';
export const MAX_ADVISORY_AGE_MS=7*86400000;
export const externalDrivers=()=>productionDrivers({maxAdvisoryAgeMs:MAX_ADVISORY_AGE_MS});
const registries=new Map<string,AdapterRegistry>();
export function publicRegistry(trustDir?:string):AdapterRegistry{
 const key=trustDir??'';const framework=trustDir?frameworkAdapter(trustDir):null;const paths=trustDir?pathAdapter(trustDir):null;
 let registry=registries.get(key);
 if(!registry){const base=foundationRegistry();registry=createAdapterRegistry([...base.ids.map(id=>base.get(id) as AdapterDefinition),...REVIEW_ADAPTERS,...[...externalDrivers().values()].map(e=>e.definition),...(framework?[framework.definition]:[]),...(paths?[paths.definition]:[])]);registries.set(key,registry);}return registry;
}
/** The same availability terms are used for fresh planning and selected reruns. */
export async function publicAvailability(trustDir:string,lock:RuleLockEnvelope,packs:readonly ValidatedPack[],ids:readonly string[],scratch:string,wrapRunner?:(runner:import('../execution/isolation.js').DockerRunner)=>import('../execution/isolation.js').DockerRunner):Promise<Set<string>>{
 const {installedAdapters,heldDatabases}=await import('./scanner-assets.js');
 const available=new Set(await installedAdapters(trustDir,lock,ids,scratch,wrapRunner));
 if(ids.length)heldDatabases(trustDir,lock);
 if(frameworkAvailable(lock,packs))available.add(FRAMEWORK_CONTROLS_ADAPTER_ID);
 if(pathsAvailable(lock,packs))available.add(PATHS_ADAPTER_ID);
 return available;
}
export function publicProfile(registry:AdapterRegistry,available:ReadonlySet<string>,packs:readonly ValidatedPack[]):TrustedProfile{
 const facts:CapabilityFact[]=[...foundationProfile(registry).planner.capabilities.facts];
 for(const p of packs)for(const rule of p.manifest.rules){const id=rule.implementation.adapterId;if(!available.has(id)||(id===FRAMEWORK_CONTROLS_ADAPTER_ID&&!shippedFrameworkPack(p))||(id===PATHS_ADAPTER_ID&&!shippedPathPack(p)))continue;
  for(const capability of rule.requires)if(!facts.some(f=>f.adapterId===id&&f.capability===capability))facts.push({adapterId:id,capability,...(id===PATHS_ADAPTER_ID&&capability==='call-occurrence'?{perFileParse:true}:{}),evidence:id===PATHS_ADAPTER_ID?'exact owner-promoted shipped structural query pack; bounded original retained parser graph, never data flow':id===FRAMEWORK_CONTROLS_ADAPTER_ID?'exact owner-promoted shipped framework pack; trusted built-in child over original retained parser evidence':'exact owner-promoted installed pinned image and held offline assets; original shipped conformance fixtures'});}
 const planner={id:'static-scanners',registry,capabilities:createCapabilityTable(registry,facts),permits:[...new Set(facts.map(f=>f.capability))],operations:foundationProfile(registry).planner.operations};
 // An unavailable optional built-in is not a prerequisite of legacy preview/scanner plans. The executing
 // registry may contain extra registered code, while the admitted profile pins this adapter only when enabled.
 const recordedRegistry=createAdapterRegistry(registry.ids.filter(id=>![FRAMEWORK_CONTROLS_ADAPTER_ID,PATHS_ADAPTER_ID,...REVIEW_ADAPTERS.map(a=>a.id)].includes(id)||available.has(id)).map(id=>registry.get(id) as AdapterDefinition));
 const record=executionProfileRecord({...planner,registry:recordedRegistry},structuredClone(RESOURCES),structuredClone(PARSE));return{planner,registry,record,digest:profileDigest(record)};
}
export function publicDrivers(registry:AdapterRegistry,records:readonly DatabaseRecord[]=[],secretsSnapshot?:import('../adapters/gitleaks/job.js').SecretsSnapshot,trustDir?:string){
 const all=productionDrivers({maxAdvisoryAgeMs:MAX_ADVISORY_AGE_MS,databaseRecords:records,...(secretsSnapshot?{secretsSnapshot}:{})});
 const framework=registry.ids.includes(FRAMEWORK_CONTROLS_ADAPTER_ID)&&trustDir?frameworkAdapter(trustDir):null;
 const paths=registry.ids.includes(PATHS_ADAPTER_ID)&&trustDir?pathAdapter(trustDir):null;
 return createCheckDriverRegistry([...(paths?[paths.driver]:[]),...(framework?[framework.driver]:[]),...(registry.ids.includes('sentinel.preview.detector')?[previewDriver(registry)]:[]),...[...all.values()].filter(e=>registry.ids.includes(e.definition.id)).map(e=>e.driver)],registry);
}

/** Build a coordinator's execution context entirely from the plan's admitted lock, never the latest lock. */
export async function scannerExecution(store:import('../store/index.js').SentinelStore,runId:string,trustDir:string|undefined,scratch:string,registry:AdapterRegistry=publicRegistry(trustDir),wrapRunner?:(runner:import('../execution/isolation.js').DockerRunner)=>import('../execution/isolation.js').DockerRunner){
 const {loadPlan}=await import('../execution/plans.js');
 const revision=store.ledger.getRun(runId)?.planRevision??store.ledger.latestPlan(runId)?.revision;
 if(revision===undefined)return{drivers:publicDrivers(registry,[],undefined,trustDir)};
 const admitted=await loadPlan(store,runId,revision);const lock=admitted.ruleLock;
 const ids=[...new Set(admitted.plan.units.flatMap(u=>u.adapterId?[u.adapterId]:[]))].filter(id=>externalDrivers().has(id));
 const inspection=admitted.plan.units.some(u=>u.adapterId===FRAMEWORK_CONTROLS_ADAPTER_ID);
 const paths=admitted.plan.units.some(u=>u.adapterId===PATHS_ADAPTER_ID)&&Boolean(admitted.pathRequest);
 if(!ids.length&&!inspection&&!paths)return{drivers:publicDrivers(registry,[],undefined,trustDir)};
 const {RuleLockBook}=await import('./rule-locks.js');const {heldDatabases,installedAdapters,checkPlanDatabases,ScannerAssetError}=await import('./scanner-assets.js');
 if(!lock||!trustDir)throw new ScannerAssetError('sentinel.assets.missing');
 if(ids.length){await installedAdapters(trustDir,lock,ids,scratch,wrapRunner);checkPlanDatabases(admitted.plan,lock);}
 const dbs=ids.length?heldDatabases(trustDir,lock):[];const book=new RuleLockBook(trustDir);
 const packs=book.packsOf(lock);if((inspection&&!frameworkAvailable(lock,packs))||(paths&&!pathsAvailable(lock,packs)))throw new ScannerAssetError('sentinel.assets.missing');
 const secretsSnapshot=ids.includes('secrets-gitleaks')?(await(await import('../snapshot/materialize.js')).openSnapshot(store,admitted.plan.pins.snapshotId!)).snapshot:undefined;
 return{drivers:publicDrivers(registry,dbs.map(d=>({databaseId:d.databaseId,snapshotDigest:d.snapshotDigest,record:d.record})),secretsSnapshot,trustDir),
  packs:packs.map(pack=>({pack,files:book.readPackFiles(pack.entry.packDigest)})),databases:dbs,containers:ids.length>0};
}
