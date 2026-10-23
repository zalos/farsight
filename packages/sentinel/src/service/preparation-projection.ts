// Closed presentation only. No new admission, verdict fold, artifact access or owner identity is minted here.
import {STRINGS} from '@farsight/core/dist/strings.js';
import {validateEnvelope} from '../validate.js';
import type {ConfigurationPreview,PreparationCapabilities,PreparationOutcome,PreparationStatus} from '../contracts/preparation.js';
import {controlOutcome} from './controls.js';
import {externalDrivers} from './scanner-profile.js';
import {FRAMEWORK_CONTROLS_ADAPTER_ID} from '../frameworks/controls/definitions.js';
const invalid=():never=>{throw Object.assign(new Error('sentinel.preparation.invalid'),{code:'sentinel.preparation.invalid'});};
const catalog=(v:unknown):void=>{if(typeof v!=='string'||!Object.hasOwn(STRINGS,v))return invalid();};
const adapters=new Set([...externalDrivers().keys(),FRAMEWORK_CONTROLS_ADAPTER_ID]);
const outcomes=new Set(['submitted','requested','kept','answered','configuration-failure','awaiting-confirmation','unavailable','refused']);
export function preparationCapabilities(value:unknown):PreparationCapabilities{
 const checked=validateEnvelope('preparationcapabilities',value);if(!checked.ok)return invalid();return checked.value;
}
export function configurationPreview(value:unknown,ownerData=false):ConfigurationPreview{
 // Socket bytes are ordinary JSON data, never an authority token. Unexpected fields still fail the schema.
 if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
 const safe={...value as Record<string,unknown>};if(!ownerData)delete safe.confirmation;
 const checked=validateEnvelope('configurationpreview',safe);if(!checked.ok)return invalid();
 for(const [name,count] of Object.entries(checked.value.counts)){
  const source=name==='selectedRules'?'PreparationController.preview.effectivePolicy.rules':'PreparationController.preview.adoptedSettings.mandatoryRules';
  if(count.unit!==`sentinel.preparation.count.${name}`||count.bizUnit!==count.unit||count.scope!=='sentinel.preparation.scope.configuration'||count.source!==source||Object.keys(count).some(k=>!['n','unit','bizUnit','scope','source'].includes(k)))return invalid();
  catalog(count.unit);catalog(count.scope);
 }
 if(checked.value.confirmation?.intent.action!=='capture.source'&&checked.value.confirmation)return invalid();
 return checked.value;
}
export function preparationStatus(value:unknown,ownerData=false):PreparationStatus{
 if(!value||typeof value!=='object'||Array.isArray(value))return invalid();const safe={...value as Record<string,unknown>};if(!ownerData)delete safe.confirmation;
 const checked=validateEnvelope('preparationstatus',safe);if(!checked.ok)return invalid();const v=checked.value;
 if(v.found){
  if(v.runId!==null&&!/^run-[a-f0-9]{32}$/.test(v.runId))return invalid();
  if(v.reasonCode)catalog(v.reasonCode);
  for(const a of v.availability){if(!adapters.has(a.adapterId))return invalid();if(a.reasonCode)catalog(a.reasonCode);}
  if(v.confirmation&&(v.confirmation.cancel.intent.action!=='run.cancel'||v.confirmation.resume&&v.confirmation.resume.intent.action!=='capture.source'))return invalid();
 }
 return v;
}
/** Reuse the existing canonical command projection; preparation only copies its safe fields/status. */
export function preparationOutcome(value:any,ownerData=false):PreparationOutcome{
 const command=controlOutcome(value);if(!outcomes.has(command.outcome))return invalid();
 const projected={schema:'sentinel-preparation-outcome/draft-1',outcome:command.outcome,exitCode:command.exitCode,verdicts:command.verdicts,
  ...(command.reasonCode?{reasonCode:command.reasonCode}:{}),status:typeof value?.facts?.found==='boolean'?preparationStatus(Object.fromEntries(Object.entries(value.facts).filter(([key])=>key!=='joined')),ownerData):null,
  ...(typeof value?.facts?.joined==='boolean'?{joined:value.facts.joined}:{})};
 // joined is a command property, never an extra status field. The source command may also carry unrelated facts;
 // only the explicitly selected status is projected, not a raw controls envelope.
 const checked=validateEnvelope('preparationoutcome',projected);if(!checked.ok)return invalid();return checked.value;
}

export const PREPARATION_OPERATIONS = Object.freeze(['configuration.preview','prepare.accept','prepare.status','prepare.resume','prepare.cancel'] as const);
export const PREPARATION_WRITES = Object.freeze(['prepare.accept','prepare.resume','prepare.cancel'] as const);
/** Advertised SDK schemas do not enforce runtime arguments. No actor, receipt, path or arbitrary recipe passes. */
export function checkPreparationArguments(op:string,value:unknown):void {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(new Error('sentinel.service.requestInvalid'),{code:'sentinel.service.requestInvalid'});
 const v=value as Record<string,unknown>,keys=Object.keys(v),allowed=op==='configuration.preview'?['requestKey','parentId']:op==='prepare.accept'?['requestKey','previewId']:['requestKey'];
 const bad=()=>{throw Object.assign(new Error('sentinel.service.requestInvalid'),{code:'sentinel.service.requestInvalid'});};
 if(!PREPARATION_OPERATIONS.includes(op as any)||keys.some(k=>!allowed.includes(k))||typeof v.requestKey!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(v.requestKey))bad();
 if(op==='prepare.accept'&&(typeof v.previewId!=='string'||!/^prepare-preview-[a-f0-9]{32}$/.test(v.previewId)))bad();
 if(v.parentId!==undefined&&(typeof v.parentId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v.parentId)))bad();
}
