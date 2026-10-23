// The genuine fixed driver and child retain the Coordinator's original unit boundary across preparation,
// normalization and durable object writes. A deterministic clock advance replaces waiting for the 120s ceiling;
// it changes no admission, plan, grant, worker code or timer. Separate files run in separate test processes.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pathOwnerFixture} from './path-owner-helpers.ts';
import {needsStore} from './snapshot-helpers.ts';
import {scratchUnder,removeScratch} from './lease-helpers.ts';
import {openStore} from '../dist/store/index.js';
import {loadPlan} from '../dist/execution/plans.js';
import {Coordinator} from '../dist/execution/coordinator.js';
import {publicRegistry,scannerExecution} from '../dist/service/scanner-profile.js';
import {pathAdapter} from '../dist/service/path-adapter.js';
import {createCheckDriverRegistry} from '../dist/execution/check-drivers.js';
for(const fence of ['prepare','normalize','objects','cancel-objects'])test(`genuine paths ${fence} boundary cannot publish after its original deadline or cancellation`,needsStore,async t=>{
 const f=await pathOwnerFixture(t),prepared:any=await f.call(true),id=prepared.facts.runId,store=await openStore(f.ws.storePath),work=scratchUnder(store);
 const registry=publicRegistry(f.ws.trustDir),assets=await scannerExecution(store,id,f.ws.trustDir,work,registry),base=pathAdapter(f.ws.trustDir).driver,plan=(await loadPlan(store,id,1)).plan,unit=plan.units.find(u=>u.adapterId==='bounded-paths')!;
 let advanced=0,fired=0,coordinator:any;const now=performance.now.bind(performance),clock=t.mock.method(performance,'now',()=>now()+advanced);
 const expire=()=>{const deadlineMs=store.ledger.getWork(unit).envelope.resources.deadlineMs;assert.ok(Number.isSafeInteger(deadlineMs));fired++;advanced+=deadlineMs+1};
 const driver={...base,async prepare(ctx:any){const result=await base.prepare(ctx);if(fence==='prepare')expire();return result},async normalize(ctx:any,verified:any){const result=await base.normalize(ctx,verified);if(fence==='normalize')expire();return result}};
 try{
  coordinator=await Coordinator.open({...assets,store,runId:id,registry,drivers:createCheckDriverRegistry([driver],registry),scratchRoot:work,hooks:{at(b){if(b==='after-objects'&&fence.endsWith('objects')){if(fence==='cancel-objects'){fired++;coordinator.cancel()}else expire()}}}});
  const done=await coordinator.run();assert.ok(fired>=1&&fired<=3,JSON.stringify(done));assert.equal(store.ledger.getPublication(unit),null);assert.equal(done.published,0);assert.notEqual(store.ledger.getWork(unit).state,'published');
  const events=store.ledger.readEvents({runId:id,limit:500}).events;assert.equal(events.filter(e=>e.kind==='work-published').length,0);
  if(fence==='cancel-objects')assert.equal(done.state,'canceled');else{assert.equal(fired,done.failures.length);assert.ok(done.failures.every(f=>f.code==='sentinel.execution.deadlineExceeded'),JSON.stringify(done));}
 }finally{clock.mock.restore();removeScratch(work);store.close()}
});
