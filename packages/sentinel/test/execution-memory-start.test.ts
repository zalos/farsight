// Actual protocol drive + owned synthetic child. This tests asynchronous gate ordering; it does NOT simulate
// a qualified container or grant a kernel witness. No target/application code or native container runs here.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {driveOwnedProtocol} from '../dist/execution/supervisor.js';
import {WorkerSession,encodeFrame} from '../dist/execution/protocol.js';
import {spawnWorker} from '../dist/execution/processes.js';
import {DEFAULT_ADAPTER_LIMITS} from '../dist/execution/registry.js';
import {boundOwner} from '../dist/store/owner-binding.js';
import {storeIn,removeScratch,scratch,work,WORKER} from './execution-helpers.ts';

async function runGate(t:any,mode:'complete'|'cancel'|'deadline'|'owner'|'early'|'coalesced'|'stderr'|'eof'|'unavailable'){
 const s=scratch('memory-start');t.after(()=>removeScratch(s.root));const store=await storeIn(s.root);t.after(()=>{try{store.close()}catch{}});
 const owner=boundOwner(store),controller=new AbortController();let release!:()=>void,prepared!:()=>void;
 const entered=new Promise<void>(r=>{prepared=r}),pending=new Promise<void>(r=>{release=r});let armed=0,closed=0,stops=0;
 const binding={attemptId:'attempt-start',work,coordinatorEpoch:store.epoch,adapterId:'test-gate',adapterDigest:'sha256:'+'a'.repeat(64),inputFingerprint:'sha256:'+'b'.repeat(64),inputs:[],deadlineAt:new Date(Date.now()+10000).toISOString()};
 const session=new WorkerSession(binding),limits={...DEFAULT_ADAPTER_LIMITS,timeoutMs:mode==='deadline'?500:5000,helloTimeoutMs:1000,cancelGraceMs:100,stderrBytes:1024};
 const hello={protocol:'sentinel-worker/draft-1',type:'hello',supported:['sentinel-worker/draft-1'],adapterId:binding.adapterId,adapterDigest:binding.adapterDigest};
 let source:string,argv:string[];
 if(['early','coalesced','stderr','eof'].includes(mode)){
  source=`process.stdout.write(${JSON.stringify(encodeFrame(hello as any).toString())});\nprocess.stdin.resume();\n`;
  if(mode==='eof')source=`process.stdout.write(${JSON.stringify(encodeFrame(hello as any).toString())});`;
  if(mode==='coalesced')source=`process.stdout.write(${JSON.stringify(encodeFrame(hello as any).toString()+'x')});process.stdin.resume();`;
  if(mode==='early')source+=`process.stdin.on('data',()=>{});setTimeout(()=>process.stdout.write('x'),30);`;
  if(mode==='stderr')source+=`setTimeout(()=>process.stderr.write('e'.repeat(2048)),30);`;
  argv=['-e',source];
 }else{source=readFileSync(WORKER,'utf8');argv=['--input-type=module','-e',source,'ok']}
 const proc=spawnWorker(process.execPath,argv,{env:{SENTINEL_INPUT:s.work,SENTINEL_OUTPUT:s.work,SENTINEL_ADAPTER_ID:binding.adapterId,SENTINEL_ADAPTER_DIGEST:binding.adapterDigest}});
 t.after(()=>proc.kill());const sent:any[]=[];const write=proc.child.stdin.write.bind(proc.child.stdin);
 proc.child.stdin.write=((bytes:any,...rest:any[])=>{for(const line of Buffer.from(bytes).toString().trim().split('\n'))if(line)sent.push(JSON.parse(line));return (write as any)(bytes,...rest)}) as any;
 const outcome:any={state:'failed',outputs:[],diagnostics:{bytes:0,truncated:false,text:''},protocol:{frames:0,bytes:0}};
 const start=performance.now();
 const drive=driveOwnedProtocol(proc,session,limits,s.work,outcome,controller.signal,async()=>{stops++;proc.kill()},
  {prepare:async()=>{prepared();if(mode==='unavailable')throw new Error('observer unavailable');await pending},start:()=>{owner.assertHeld();armed++}},()=>{closed++});
 await Promise.race([entered,drive]);
 if(mode==='complete'||mode==='unavailable'){release()}
 else if(mode==='cancel'){controller.abort()}
 else if(mode==='owner'){store.close();release()}
 // Deadline, early bytes, coalesced and stderr remain pending until their genuine terminal event wins.
 await drive;const exit=await proc.exited;
 release();await new Promise(r=>setImmediate(r)); // Late setup resolution must have no start or arm effect.
 return {outcome,sent,armed,closed,stops,exit,elapsedMs:performance.now()-start};
}

for(const mode of ['complete','unavailable'] as const)test(mode+' memory setup sends unchanged welcome/start in order and normal completion remains valid',async t=>{
 const r=await runGate(t,mode);assert.equal(r.outcome.state,'succeeded');assert.deepEqual(r.sent.map(m=>m.type),['welcome','start']);assert.equal(r.armed,1);assert.equal(r.closed,1);assert.equal(r.exit.exitCode,0);
});
for(const mode of ['cancel','deadline','owner','early','coalesced','stderr','eof'] as const)test(mode+' during pending setup closes before stop and cannot cause a late start',async t=>{
 const r=await runGate(t,mode);
 assert.notEqual(r.outcome.state,'succeeded');assert.equal(r.armed,0);assert.deepEqual(r.sent,[]);assert.equal(r.closed,1);assert.equal(r.stops,1);assert.deepEqual(r.outcome.outputs,[]);assert.equal(r.outcome.result,undefined);
 if(mode==='cancel')assert.equal(r.outcome.code,'sentinel.execution.canceled');
 if(mode==='deadline'){assert.equal(r.outcome.code,'sentinel.execution.deadlineExceeded');assert.ok(r.elapsedMs<2000,'original deadline ran during setup')}
 if(mode==='owner')assert.equal(r.outcome.detail.rule,'owner-lost-before-start');
 if(mode==='early'||mode==='coalesced')assert.equal(r.outcome.detail.rule,'worker-data-before-start');
 if(mode==='eof'){assert.equal(r.outcome.code,'sentinel.execution.workerExited');assert.equal(r.outcome.detail.exitCode,0)}
 if(mode==='stderr')assert.equal(r.outcome.code,'sentinel.execution.stderrBudget');
});
