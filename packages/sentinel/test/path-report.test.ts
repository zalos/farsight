// Malformed normalized records are injected only by a test trusted-driver wrapper before the real coordinator's
// canonical hashing and acceptance. They are not normal producer output, imported reports or synthetic authority.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pathOwnerFixture} from './path-owner-helpers.ts';
import {needsStore} from './snapshot-helpers.ts';
import {scratchUnder,removeScratch} from './lease-helpers.ts';
import {openStore} from '../dist/store/index.js';
import {Coordinator} from '../dist/execution/coordinator.js';
import {publicRegistry,scannerExecution} from '../dist/service/scanner-profile.js';
import {pathAdapter} from '../dist/service/path-adapter.js';
import {createCheckDriverRegistry} from '../dist/execution/check-drivers.js';
import {fullReport,withholdSecretRun} from '../dist/service/full-report.js';
import {validateEnvelope} from '../dist/validate.js';
import {PATHS_TASK_REPORT_SCHEMA} from '../dist/analysis/paths/definitions.js';
import {renderMarkdown} from '../dist/reports/markdown.js';
import {renderHtml} from '../dist/reports/html.js';
import {toSarif} from '../dist/reports/sarif.js';
for(const mode of ['missing','duplicate','foreign-job','wrong-source','wrong-graph','finding','coverage'] as const)test(`genuine accepted path publication with ${mode} normalized record refuses report readback`,needsStore,async t=>{
 const f=await pathOwnerFixture(t),prepared=await f.call(true),store=await openStore(f.ws.storePath),work=scratchUnder(store);
 try{
  const id=prepared.facts.runId,registry=publicRegistry(f.ws.trustDir),assets=await scannerExecution(store,id,f.ws.trustDir,work,registry),base=pathAdapter(f.ws.trustDir).driver;
  let faults=0;
  const driver={...base,async normalize(ctx:any,verified:any){const n=await base.normalize(ctx,verified);return{...n,...(mode==='coverage'?{coverage:{...n.coverage,coveredChecks:ctx.checks.map(c=>({checkId:c.id})),scannedSet:[...ctx.unit.scopes],actualReadSet:[...ctx.unit.scopes],skipped:[]}}:{}),records:n.records.flatMap(r=>{
   if(r.schema!==PATHS_TASK_REPORT_SCHEMA)return[r];faults++;const value=structuredClone(r.value) as any;
   if(mode==='missing')return[];if(mode==='duplicate')return[r,{...r,value:{...value,unexpected:true}}];if(mode==='finding')return[r,{value:{kind:'invented'},schema:'sentinel-driver-finding/draft-1',privacy:'source-derived'}];
   if(mode==='foreign-job')value.job=`sha256:${'f'.repeat(64)}`;if(mode==='wrong-source')value.sourceId='foreign';if(mode==='wrong-graph')value.evidence.graphDigest=`sha256:${'f'.repeat(64)}`;
   return[{...r,value}];
  })}}};
  const done=await(await Coordinator.open({...assets,store,runId:id,registry,drivers:createCheckDriverRegistry([driver],registry),scratchRoot:work})).run();assert.equal(done.state,'completed');assert.equal(done.published,1,JSON.stringify(done));assert.equal(faults,1);
  await assert.rejects(fullReport({store,runId:id,workspace:f.ws.path,trustDir:f.ws.trustDir,disclosure:'shareable',now:new Date()}),(e:any)=>e.code==='sentinel.report.evidenceUnbound');
 }finally{removeScratch(work);store.close()}
});

test('coarse structural privacy preserves typed outcomes/counts but removes endpoints, edges, sites and spans before every rendering',needsStore,async t=>{
 const f=await pathOwnerFixture(t),prepared=await f.call(true),store=await openStore(f.ws.storePath),work=scratchUnder(store);
 try{
  const id=prepared.facts.runId,{executeRun}=await import('../dist/service/canonical.js');assert.equal((await executeRun(store,id,{scratchRoot:work,trustDir:f.ws.trustDir})).published,1);
  const clean=await fullReport({store,runId:id,workspace:f.ws.path,trustDir:f.ws.trustDir,disclosure:'private',now:new Date()}),section=clean.document.structuralPaths[0];assert.ok(section.evidence.results[0].paths[0].steps.some(s=>s.sites.length));
  const changed=structuredClone(clean.document);changed.counts.pathQueries.n++;changed.counts.pathQueries.breakdown[0].n++;assert.equal(validateEnvelope('report',changed).ok,false);
  const missing=structuredClone(clean.document);delete missing.counts.pathQueries;assert.equal(validateEnvelope('report',missing).ok,false);
  const wrongOutcome=structuredClone(clean.document);wrongOutcome.counts.pathQueries.breakdown[0].n=0;wrongOutcome.counts.pathQueries.breakdown[1].n=1;assert.equal(validateEnvelope('report',wrongOutcome).ok,false);
  const withheld=withholdSecretRun(clean.document,new Map());assert.equal(validateEnvelope('report',withheld).ok,true);
  assert.equal(withheld.counts.pathQueries.n,1);assert.equal(withheld.structuralPaths[0].evidence.results[0].outcome,'reached');assert.equal(withheld.structuralPaths[0].detailLoss,'sentinel.report.withheld.secretRun');
  for(const rendered of [JSON.stringify(withheld),renderMarkdown(withheld),renderHtml(withheld),JSON.stringify(toSarif(withheld))])for(const forbidden of ['workspace::src/routes.ts::getUser','workspace::src/db.ts::query','src/routes.ts','src/service.ts','occurrenceId','startByte'])assert.equal(rendered.includes(forbidden),false,forbidden);
 }finally{removeScratch(work);store.close()}
});
