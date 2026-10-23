import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publishedReadonly,requester} from './service-readonly-helpers.ts';
import {listenOwnerSocket,runtimeAddress,newOwnerNonce,connectOwnerSocket} from '../dist/transport/ipc.js';
import {READONLY_LIMITS} from '../dist/service/readonly.js';
const code=(c:string)=>(e:any)=>e?.code===c;
async function socketFor(t:any,f:any,observe?:(op:string,result:Promise<unknown>)=>void){
 const ownerNonce=newOwnerNonce(),address=runtimeAddress({storePath:f.store.storePath,ownerNonce,sources:[f.ws.path]});
 const socket=await listenOwnerSocket(address,{storeId:f.store.storeId,ownerNonce},(op,body,by,context)=>{const task=f.service.handle(op,body,by,context);observe?.(op,task);return task;});
 const clients:any[]=[];t.after(async()=>{for(const client of clients)client.close();await socket.close();});
 return async()=>{const client=await connectOwnerSocket(address,{storeId:f.store.storeId,ownerNonce},'mcp');clients.push(client);return client;};
}
test('a disconnected reader reconnects to the same channel and exact immutable view/delivery',async t=>{
 const f=await publishedReadonly(t),connect=await socketFor(t,f);let client=await connect();t.after(()=>client.close());
 const view:any=await client.request('run.inspect',{runId:f.runId});
 const m:any=await client.request('report.open',{runId:f.runId,format:'json'});
 const first=await client.request('delivery.read',{deliveryId:m.deliveryId,offset:0,maxBytes:50});client.close();
 client=await connect();assert.deepEqual(await client.request('delivery.read',{deliveryId:m.deliveryId,offset:0,maxBytes:50}),first);
 assert.equal((await client.request('view.page',{viewId:view.viewId,collection:'works'}) as any).viewId,view.viewId);
});
test('socket cancellation reaches genuine preparation and cannot evict a previously installed delivery',async t=>{
 const f=await publishedReadonly(t),held:any[]=[];for(let i=0;i<READONLY_LIMITS.deliveries;i++)held.push(await f.call('report.open',{runId:f.runId,format:'json'}));
 let settledResolve:(v:any)=>void=()=>{},observe=false;
 const settled=new Promise(resolve=>settledResolve=resolve),connect=await socketFor(t,f,(op,task)=>{if(observe&&op==='report.open')void task.then(v=>settledResolve({value:v}),e=>settledResolve({code:e.code}));});
 const client=await connect();t.after(()=>client.close());observe=true;
 const controller=new AbortController(),task=client.request('report.open',{runId:f.runId,format:'html'},{signal:controller.signal});controller.abort();
 await assert.rejects(task,code('sentinel.ipc.canceled'));assert.equal((await settled as any).code,'sentinel.execution.canceled');
 for(const m of held)assert.equal((await client.request('delivery.read',{deliveryId:m.deliveryId,offset:0}) as any).deliveryId,m.deliveryId);
});
test('server-observed disconnect aborts genuine unsettled read preparation without evicting deliveries',async t=>{
 let beganResolve:()=>void=()=>{},abortedResolve:()=>void=()=>{},settledResolve:(v:any)=>void=()=>{},settled=false;
 const began=new Promise<void>(r=>beganResolve=r),aborted=new Promise<void>(r=>abortedResolve=r),result=new Promise(r=>settledResolve=r);
 let observe=false;
 const f=await publishedReadonly(t,{now:()=>{if(observe)beganResolve();return new Date();}}),held:any[]=[];
 for(let i=0;i<READONLY_LIMITS.deliveries;i++)held.push(await f.call('report.open',{runId:f.runId,format:'json'}));
 const ownerNonce=newOwnerNonce(),address=runtimeAddress({storePath:f.store.storePath,ownerNonce,sources:[f.ws.path]});
 const socket=await listenOwnerSocket(address,{storeId:f.store.storeId,ownerNonce},(op,body,by,ctx)=>{
  if(observe&&op==='report.open')ctx?.signal.addEventListener('abort',()=>{assert.equal(settled,false,'server abort precedes preparation settlement');abortedResolve();},{once:true});
  const task=f.service.handle(op,body,by,ctx);if(observe&&op==='report.open')void task.then(v=>{settled=true;settledResolve({value:v});},e=>{settled=true;settledResolve({code:e.code});});return task;
 });
 const clients:any[]=[];t.after(async()=>{clients.forEach(c=>c.close());await socket.close();});
 const connect=async()=>{const c=await connectOwnerSocket(address,{storeId:f.store.storeId,ownerNonce},'mcp');clients.push(c);return c;};
 let client=await connect();observe=true;const task=client.request('report.open',{runId:f.runId,format:'html'});void task.catch(()=>undefined);
 await began;client.close();await aborted; // Server-observed end/close while real budgeted preparation is unsettled.
 await assert.rejects(task,code('sentinel.ipc.notListening'));assert.equal((await result as any).code,'sentinel.execution.canceled');
 observe=false;client=await connect();assert.equal((await client.request('service.capabilities',{}) as any).apiRevision,1);
 for(const m of held)assert.equal((await client.request('delivery.read',{deliveryId:m.deliveryId,offset:0}) as any).deliveryId,m.deliveryId);
 assert.equal(f.store.ledger.getRun(f.runId)?.state,'completed');
 assert.equal((await client.request('report.open',{runId:f.runId,format:'json'}) as any).schema,'sentinel-report-delivery/draft-1');
});
