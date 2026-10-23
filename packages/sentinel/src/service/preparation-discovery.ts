// Admitted readiness resolution only: no acquisition or engine scan. Every client uses the held store's lease.
import type { SentinelStore } from '../store/index.js';
import type { ScratchLease } from './scratch-lease.js';
import type { DockerRunner } from '../execution/isolation.js';
import { externalDrivers } from './scanner-profile.js';
import { installedAdapters, heldDatabases } from './scanner-assets.js';
import { FRAMEWORK_CONTROLS_ADAPTER_ID, frameworkAvailable } from './framework-adapter.js';
import { checkPreparationClock, PreparationError, type PreparationClock } from './preparation-clock.js';
import { preparationTerms, preparationInputBytes, preparationResolvedBytes, checkPreparationProfile,
 type PreparationInputs, type PreparationAvailability } from './preparation-inputs.js';

const MISSING = new Set(['sentinel.assets.missing','sentinel.execution.imageMissing','sentinel.execution.isolationUnavailable','sentinel.execution.backendUnqualified']);
/** Error details and producer text never become journal/readiness metadata. */
const absent = (error:unknown):string|null => {
 const code=(error as{code?:unknown})?.code;return typeof code==='string'&&MISSING.has(code)?code:null;
};
export async function discoverPreparationProfile(store:SentinelStore,inputs:PreparationInputs,clock:PreparationClock,lease:ScratchLease,
 signal?:AbortSignal):Promise<PreparationInputs>{
 checkPreparationClock(store,clock);
 const terms=preparationTerms(store,inputs,()=>clock.stillWithin());
 const requested=JSON.parse(preparationInputBytes(store,inputs).toString('utf8')).recipe.requestedAdapters as string[];
 const retained:PreparationAvailability[]|null=terms.resolved?JSON.parse(preparationResolvedBytes(store,inputs).toString('utf8')).availability:null;
 const answers:PreparationAvailability[]=[],available=new Set<string>();
 const wrapRunner=(runner:DockerRunner):DockerRunner=>{
  const owned=lease.wrapRunner(runner);
  return{runSync(){throw new PreparationError('sentinel.preparation.invalid');},start(){throw new PreparationError('sentinel.preparation.invalid');},async run(args,callerSignal){clock.stillWithin();const signals=[signal,callerSignal].filter((s):s is AbortSignal=>s!==undefined);
   const result=await owned.run(args,signals.length?AbortSignal.any(signals):undefined);clock.stillWithin();return result;}};
 };
 for(const adapterId of requested){
  clock.stillWithin();const before=retained?.find(a=>a.adapterId===adapterId);
  // Historical unavailable stages stay gaps after capture, even if new local assets appeared. No silent upgrade.
  if(before?.available===false){answers.push(before);continue;}
  let reason:string|null=null;
  if(adapterId===FRAMEWORK_CONTROLS_ADAPTER_ID){
   if(!frameworkAvailable(terms.current.lock,terms.packs)||!terms.registry.ids.includes(adapterId))reason='sentinel.assets.missing';
  }else{
   const definition=externalDrivers().get(adapterId)?.definition;
   const pin=terms.current.lock.tools.find(t=>t.adapterId===adapterId);
   if(!definition||!pin)reason='sentinel.assets.missing';
   else if(pin.version!==definition.version||pin.artifactDigest!==definition.image.split('@')[1])reason='sentinel.plan.toolMismatch';
   else{
    // Before the source is captured there is no honest ecosystem-specific scope. This fixed recipe requires the
    // shipped OSV stage's complete two-ecosystem offline inputs; partial installations are recorded as a stage gap.
    const databaseIds=adapterId==='advisories-osv'?['osv:npm','osv:Maven']:adapterId==='iac-trivy'?['trivy-checks']:[];
    if(databaseIds.some(id=>!terms.current.lock.databases.some(d=>d.databaseId===id)))reason='sentinel.assets.missing';
    else try{
     await installedAdapters(terms.trustDir,terms.current.lock,[adapterId],lease.path,wrapRunner,signal);clock.stillWithin();
     if(databaseIds.length)heldDatabases(terms.trustDir,{...terms.current.lock,databases:terms.current.lock.databases.filter(d=>databaseIds.includes(d.databaseId))});
     clock.stillWithin();
    }catch(error){clock.stillWithin();const missing=absent(error);if(!missing)throw error;reason=missing;}
   }
  }
  if(before?.available&&reason!==null)throw new PreparationError('sentinel.preparation.unavailable');
  if(reason===null)available.add(adapterId);
  answers.push(Object.freeze({adapterId,available:reason===null,reasonCode:reason}));
 }
 clock.stillWithin();
 return checkPreparationProfile(store,inputs,available,clock,answers);
}
