// Public dispatch composes the reviewed production drivers without changing them. Registered code is distinct from
// an available capability: only exact owner-promoted tools and held databases enable a planner fact.
import {createAdapterRegistry,type AdapterRegistry,type AdapterDefinition} from '../execution/registry.js';
import {createCheckDriverRegistry} from '../execution/check-drivers.js';
import {createCapabilityTable,type CapabilityFact} from '../planner/index.js';
import {executionProfileRecord} from '../execution/profile.js';
import {productionDrivers} from '../adapters/drivers/index.js';
import {foundationRegistry,foundationProfile,RESOURCES,PARSE,profileDigest,type TrustedProfile} from './trusted-profile.js';
import {previewDriver} from './preview-driver.js';
import type {ValidatedPack} from '../rules/index.js';
import type {DatabaseRecord} from '../adapters/drivers/index.js';
export const MAX_ADVISORY_AGE_MS=7*86400000;
export const externalDrivers=()=>productionDrivers({maxAdvisoryAgeMs:MAX_ADVISORY_AGE_MS});
let registry:AdapterRegistry|undefined;
export function publicRegistry():AdapterRegistry{
 if(!registry){const base=foundationRegistry();registry=createAdapterRegistry([...base.ids.map(id=>base.get(id) as AdapterDefinition),...[...externalDrivers().values()].map(e=>e.definition)]);}return registry;
}
export function publicProfile(registry:AdapterRegistry,available:ReadonlySet<string>,packs:readonly ValidatedPack[]):TrustedProfile{
 const facts:CapabilityFact[]=[...foundationProfile(registry).planner.capabilities.facts];
 for(const p of packs)for(const rule of p.manifest.rules){const id=rule.implementation.adapterId;if(!available.has(id))continue;
  for(const capability of rule.requires)if(!facts.some(f=>f.adapterId===id&&f.capability===capability))facts.push({adapterId:id,capability,evidence:'exact owner-promoted installed pinned image and held offline assets; original shipped conformance fixtures'});}
 const planner={id:'static-scanners',registry,capabilities:createCapabilityTable(registry,facts),permits:[...new Set(facts.map(f=>f.capability))],operations:foundationProfile(registry).planner.operations};
 const record=executionProfileRecord(planner,structuredClone(RESOURCES),structuredClone(PARSE));return{planner,registry,record,digest:profileDigest(record)};
}
export function publicDrivers(registry:AdapterRegistry,records:readonly DatabaseRecord[]=[]){
 const all=productionDrivers({maxAdvisoryAgeMs:MAX_ADVISORY_AGE_MS,databaseRecords:records});
 return createCheckDriverRegistry([...(registry.ids.includes('sentinel.preview.detector')?[previewDriver(registry)]:[]),...[...all.values()].filter(e=>registry.ids.includes(e.definition.id)).map(e=>e.driver)],registry);
}

/** Build a coordinator's execution context entirely from the plan's admitted lock, never the latest lock. */
export async function scannerExecution(store:import('../store/index.js').SentinelStore,runId:string,trustDir:string|undefined,scratch:string,registry:AdapterRegistry=publicRegistry()){
 const {loadPlan}=await import('../execution/plans.js');
 const revision=store.ledger.getRun(runId)?.planRevision??store.ledger.latestPlan(runId)?.revision;
 if(revision===undefined)return{drivers:publicDrivers(registry)};
 const admitted=await loadPlan(store,runId,revision);const lock=admitted.ruleLock;
 const ids=[...new Set(admitted.plan.units.flatMap(u=>u.adapterId?[u.adapterId]:[]))].filter(id=>externalDrivers().has(id));
 if(!ids.length)return{drivers:publicDrivers(registry)};
 const {RuleLockBook}=await import('./rule-locks.js');const {heldDatabases,installedAdapters,checkPlanDatabases,ScannerAssetError}=await import('./scanner-assets.js');
 if(!lock||!trustDir)throw new ScannerAssetError('sentinel.assets.missing');
 await installedAdapters(trustDir,lock,ids,scratch);checkPlanDatabases(admitted.plan,lock);
 const dbs=heldDatabases(trustDir,lock);const book=new RuleLockBook(trustDir);
 return{drivers:publicDrivers(registry,dbs.map(d=>({databaseId:d.databaseId,snapshotDigest:d.snapshotDigest,record:d.record}))),
  packs:book.packsOf(lock).map(pack=>({pack,files:book.readPackFiles(pack.entry.packDigest)})),databases:dbs,containers:true};
}
