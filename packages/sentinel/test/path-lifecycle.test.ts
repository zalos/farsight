// Deterministic real prepared-run lifecycle regressions, including the service's start/setup interleaving. Gates
// wrap only Coordinator.open in this test, never production timing or worker code; actual owner receipts are spent.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pathOwnerFixture} from './path-owner-helpers.ts';
import {needsStore} from './snapshot-helpers.ts';
import {scratchUnder,removeScratch} from './lease-helpers.ts';
import {openStore} from '../dist/store/index.js';
import {Coordinator} from '../dist/execution/coordinator.js';
import {publicRegistry,scannerExecution} from '../dist/service/scanner-profile.js';
import {OwnerService} from '../dist/service/owner-service.js';
import {confirmForService} from '../dist/service/local.js';
import {currentPlan} from '../dist/service/canonical.js';
import {loadPlan} from '../dist/execution/plans.js';
import {requestedByOf} from '../dist/cli/actor.js';
const by=requestedByOf({kind:'service-connection',granted:{principal:'agent',channel:'local-service'}});
for(const cancel of [false,true])test(`a genuine pending path pause before run ${cancel?'with cancel pending preserves cancellation precedence':'takes only legal transitions and launches nothing'}`,needsStore,async t=>{
 const f=await pathOwnerFixture(t),prepared=await f.call(true),id=prepared.facts.runId,store=await openStore(f.ws.storePath),work=scratchUnder(store);
 try{
  const before=store.ledger.getRun(id).envelope,registry=publicRegistry(f.ws.trustDir),assets=await scannerExecution(store,id,f.ws.trustDir,work,registry);
  const c=await Coordinator.open({...assets,store,runId:id,registry,scratchRoot:work});c.pause();if(cancel)c.cancel();
  const outcome=await c.run();assert.equal(outcome.state,cancel?'canceled':'paused');
  const after=store.ledger.getRun(id).envelope;assert.equal(after.createdAt,before.createdAt);assert.deepEqual(after.budgets,before.budgets);
  const admitted=await loadPlan(store,id,1);for(const unit of admitted.plan.units)assert.equal(store.ledger.countAttempts(unit),0);
 }finally{removeScratch(work);store.close()}
});

test('public service pause during genuine start setup pauses its prepared path run without launching a worker',needsStore,async t=>{
 const f=await pathOwnerFixture(t),prepared=await f.call(true),id=prepared.facts.runId,store=await openStore(f.ws.storePath),registry=publicRegistry(f.ws.trustDir),service=new OwnerService(store,f.ws,{registry});
 const original=Coordinator.open,entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let opens=0;
 const mock=t.mock.method(Coordinator,'open',async function(options:any){assert.equal(options.runId,id);opens++;entered.resolve();await release.promise;return original.call(Coordinator,options)});
 let start:Promise<any>|undefined;
 try{
  const receipt=async(action:'run.start'|'run.pause')=>{const r=confirmForService(f.ws,{command:action,action,plan:await currentPlan(store,id),planId:id,confirm:true,now:new Date(),storeId:store.storeId});assert.ok('receiptId'in r,JSON.stringify(r));return r.receiptId};
  start=service.handle('run.start',{planId:id,receiptId:await receipt('run.start')},by);
  await entered.promise;
  const pause:any=await service.handle('run.pause',{runId:id,receiptId:await receipt('run.pause')},by);assert.equal(pause.outcome,'requested');
  release.resolve();assert.equal((await start).outcome,'submitted');
  const waited:any=await service.handle('run.wait',{runId:id,timeoutMs:1000},by);assert.equal(waited.facts.state,'paused',JSON.stringify(waited));assert.equal(waited.facts.error,undefined);assert.equal(opens,1);
  const admitted=await loadPlan(store,id,1);for(const unit of admitted.plan.units)assert.equal(store.ledger.countAttempts(unit),0);
 }finally{release.resolve();if(start)await start;mock.mock.restore();store.close()}
});
