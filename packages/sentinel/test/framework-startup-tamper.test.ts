// Isolated real-child controls: mutate only this worktree's compiled bytes (or its private generated entry), after
// registration and before spawn. Run separately from suites that register the same build; always restore in finally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frameworkFixture } from './framework-canonical-helpers.ts';
import { needsStore } from './snapshot-helpers.ts';
import { ORDER } from './express-fixtures.ts';
import { Coordinator } from '../dist/execution/coordinator.js';
import { publicRegistry, scannerExecution } from '../dist/service/scanner-profile.js';
import { createExecutionService } from '../dist/execution/service.js';
import { releaseWorkDir } from '../dist/execution/supervisor.js';
import { openStore } from '../dist/store/index.js';
import { WorkerFiles } from '../dist/execution/recovery.js';

for (const part of ['worker', 'imported-module', 'manifest'] as const) test(`genuine ${part} startup tamper is final, raw cause stays workerExited and restored identity is unchanged`, needsStore, async t => {
  const f=await frameworkFixture(t,ORDER,{run:false});
  const registry=publicRegistry(f.ws.trustDir),adapter=registry.get('framework-controls');
  const assets=await scannerExecution(f.store,f.runId,f.ws.trustDir,f.work,registry);
  const module=(adapter as any).module,entry=readFileSync(module),digest=adapter.digest;
  const target=part==='manifest'?module:fileURLToPath(new URL(part==='worker'?'../dist/frameworks/controls/worker.js':'../dist/frameworks/express/effects.js',import.meta.url));
  const original=readFileSync(target);
  const mutate=()=>{
    if(part==='manifest'){
      const source=original.toString(),match=/const CLOSURE = (.*);/.exec(source);assert.ok(match);
      const closure=JSON.parse(match[1]),file=closure.find((e:any)=>e[1]==='file');assert.ok(file);file[2]='0'.repeat(64);
      writeFileSync(target,source.replace(match[0],`const CLOSURE = ${JSON.stringify(closure)};`));
    }else writeFileSync(target,Buffer.concat([original,Buffer.from('\n// isolated startup verification control\n')]));
  };
  const workers=new WorkerFiles(f.store.storePath);
  const service=await createExecutionService(f.store,{scratchRoot:f.work,registry,containers:false});
  let raw:any;
  try { raw=await service.run({adapterId:adapter.id,attemptId:`raw-${part}`,work:{id:'raw-startup-control',revision:1},inputs:[],workers,hooks:{at(b){if(b==='before-spawn')mutate()}}}); }
  finally {writeFileSync(target,original)}
  assert.equal(raw.state,'failed');assert.equal(raw.code,'sentinel.execution.workerExited');
  assert.deepEqual(raw.exit,{exitCode:71,exitSignal:null});assert.deepEqual(raw.protocol,{frames:0,bytes:0});
  assert.equal(raw.result,undefined);assert.deepEqual(raw.outputs,[]);releaseWorkDir(raw.workDir);
  let spawns=0;
  let done:any;
  try {
    done=await(await Coordinator.open({...assets,store:f.store,runId:f.runId,registry,scratchRoot:f.work,hooks:{at(b){if(b==='before-spawn'){spawns++;mutate()}}}})).run();
  }finally{writeFileSync(target,original)}
  const unit=f.admitted.plan.units[0];assert.equal(spawns,1,'startup refusal is not retried');
  assert.equal(done.outcome,'execution-failure');assert.equal(done.published,0);assert.equal(done.coverageRecords,0);
  assert.equal(f.store.ledger.getPublication(unit),null);
  const attempts=f.store.ledger.listAttempts(unit);assert.equal(attempts.length,1);
  const recorded=f.store.ledger.getAttempt(attempts[0].id)!;
  assert.equal(recorded.envelope.error?.code,'sentinel.execution.closureRefused');assert.equal(recorded.envelope.error?.retryable,false);
  assert.deepEqual(recorded.errorDetail,{originalCode:'sentinel.execution.workerExited',exitCode:71,exitSignal:null,phase:'before-hello',adapter:{id:adapter.id,digest}});
  assert.deepEqual(workers.list().records,[]);
  assert.ok(readFileSync(module).equals(entry));assert.equal(registry.get(adapter.id).digest,digest);
  const entries=join(f.ws.trustDir,'adapters/framework-controls');assert.equal(readdirSync(entries).filter(n=>n.endsWith('.mjs')).length,1,'no identity refresh');
  assert.equal(publicRegistry(f.ws.trustDir).get(adapter.id).digest,digest,'restored bytes retain identity');
  const storePath=f.store.storePath;f.store.close();const reopened=await openStore(storePath);
  try { assert.deepEqual(reopened.ledger.getAttempt(attempts[0].id)!.errorDetail,recorded.errorDetail);assert.equal(reopened.ledger.getRun(f.runId)!.outcome,'execution-failure'); }
  finally{reopened.close()}
  assert.equal(createHash('sha256').update(readFileSync(target)).digest('hex'),createHash('sha256').update(original).digest('hex'));
});
