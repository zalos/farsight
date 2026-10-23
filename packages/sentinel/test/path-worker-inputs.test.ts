// Original inert sources are captured and parsed, never executed. These are byte/protocol tests; only the
// future admission seam can establish a genuine accepted producer chain for a worker invocation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {WorkerSession} from '../dist/execution/protocol.js';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '@farsight/graph';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { parseSnapshot } from '../dist/snapshot/parser.js';
import { inspectPathInputs, parsePathsJob, PATHS_JOB_SCHEMA } from '../dist/analysis/paths/protocol.js';
import { commitRepo, needsStore, openCaptureStore, scratch } from './snapshot-helpers.ts';
import { PATHS_APP } from './paths-fixtures.ts';
import { PathExecutionBudget, PATH_EXECUTION_LIMITS, PathBudgetError } from '../dist/analysis/paths/budget.js';
import { writeBuiltinClosureEntry } from '../dist/frameworks/controls/closure.js';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { createExecutionService } from '../dist/execution/service.js';
import { WorkerFiles } from '../dist/execution/recovery.js';

const hash = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
async function setup(t: any) {
  const dir = scratch(t);
  const root = join(dir, 'repo');
  commitRepo(root, PATHS_APP);
  const fx = await openCaptureStore(t, dir);
  const { snapshot } = await captureSnapshot(fx.store, { mode: 'working-copy', sources: [{ sourceId: 'app', repositoryId: 'example/app', root }] });
  const work = join(dir, 'work'); mkdirSync(work);
  const parsed = await parseSnapshot(fx.store, { snapshotId: snapshot.id, workDir: work,
    selection: { gitignore: true, testFiles: 'include' },
    limits: { maxFiles: 1000, maxFileBytes: 1 << 20, maxTotalBytes: 16 << 20, maxEntries: 10_000, maxDurationMs: 60_000 } });
  const source = parsed.sources[0]!;
  const values = new Map<string, Uint8Array>();
  const add = (value: unknown) => { const bytes = Buffer.from(canonicalJson(value)); const id = hash(bytes); values.set(id, bytes); return id; };
  for (const e of snapshot.entries) if (e.kind === 'file' && e.disposition === 'included') values.set(e.content, await fx.store.readArtifact(e.content));
  const artifact = add(source.artifact), index = add(source.index);
  const resultValue = { ...source.result, artifact, index };
  const requestValue = { schema: 'sentinel-path-request/draft-1',
    ancestor: { runId: 'retained-parent', revision: 2, planDigest: `sha256:${'1'.repeat(64)}` },
    snapshotId: snapshot.id, sourceId: 'app',
    queries: [{ from: 'app::src/routes.ts::getUser', to: 'app::src/db.ts::query' }],
    bounds: { edgeKinds: ['calls'], maxDepth: 12, maxFanout: 256, maxVisited: 50_000 } };
  const job = { schema: PATHS_JOB_SCHEMA, request: add(requestValue), snapshot: add(snapshot), analysis: { artifact, index, result: add(resultValue) } };
  const run = async (candidate: any = job, omit: string[] = [], reader?: (id: string) => Promise<Uint8Array>) => {
    const id = add(candidate), bytes = values.get(id)!;
    const inputs = [...values.keys()].filter(id => !omit.includes(id));
    return inspectPathInputs(bytes, inputs, reader ?? (async id => { const bytes = values.get(id); assert.ok(bytes); return bytes; }));
  };
  rmSync(root, { recursive: true });
  return { values, add, run, job, requestValue, resultValue, snapshot, dir, store: fx.store };
}

test('paths job is a closed bounded protocol without path, function or authority fields', () => {
  const id = `sha256:${'1'.repeat(64)}`;
  const job = { schema: PATHS_JOB_SCHEMA, request: id, snapshot: id, analysis: { artifact: id, result: id, index: id } };
  assert.deepEqual(parsePathsJob(Buffer.from(JSON.stringify(job))), job);
  for (const extra of [{ worker: '/tmp/other.mjs' }, { export: 'arbitrary' }, { confirmed: true }, { ancestor: {} }]) {
    assert.throws(() => parsePathsJob(Buffer.from(JSON.stringify({ ...job, ...extra }))));
  }
  assert.throws(() => parsePathsJob(Buffer.alloc(4097, 32)));
  assert.throws(() => parsePathsJob(Buffer.from([0xff])));
  return assert.rejects(inspectPathInputs(Buffer.from(JSON.stringify(job)), [], async () => { throw new Error('must not read'); }));
});

test('sealed retained bytes produce the original call-path evidence after source removal', needsStore, async t => {
  const { run, job, values } = await setup(t);
  const out = await run();
  assert.equal(out.request, job.request);
  assert.equal(out.ancestor.revision, 2);
  assert.equal(out.evidence.establishes, 'call-reachability');
  assert.equal(out.evidence.results[0].outcome, 'reached');
  assert.deepEqual(out.evidence.results[0].paths[0].steps.map(s => s.to.split('::').pop()), ['findUser', 'query']);
  assert.ok(out.evidence.limitationKeys.includes('sentinel.paths.notDataFlow'));
  assert.equal('coveredChecks' in out, false);
  assert.ok(out.actualReadSet.every(id => values.has(id)));
  assert.ok(out.actualReadSet.includes(job.analysis.result));
});

test('unsealed, substituted and malformed retained inputs refuse rather than return empty paths', needsStore, async t => {
  const { run, job, values, add } = await setup(t);
  await assert.rejects(run(job, [job.analysis.artifact]));
  await assert.rejects(run(job, [], async id => id === job.analysis.index ? Buffer.from('{}') : values.get(id)!));
  const broken = add({ schema: 'sentinel-parser-index/draft-1' });
  await assert.rejects(run({ ...job, analysis: { ...job.analysis, index: broken } }));
  const body = [...values.entries()].find(([, bytes]) => Buffer.from(bytes).toString().startsWith('import { findUser }'))!;
  await assert.rejects(run(job, [body[0]]));
  await assert.rejects(run(job, [], async id => id === body[0] ? Buffer.from('different captured body') : values.get(id)!));
});

test('job/request/result/source crossbinding is exact even when every substituted object has a valid digest', needsStore, async t => {
  const { run, job, add, requestValue, resultValue, snapshot } = await setup(t);
  for (const changed of [{ ...requestValue, snapshotId: 'another-capture' }, { ...requestValue, sourceId: 'other' }]) {
    await assert.rejects(run({ ...job, request: add(changed) }));
  }
  for (const changed of [{ ...resultValue, sourceId: 'other' }, { ...resultValue, snapshotId: 'other' },
    { ...resultValue, index: job.analysis.artifact }, { ...resultValue, analysisFingerprint: 'foreign-analysis' }]) {
    await assert.rejects(run({ ...job, analysis: { ...job.analysis, result: add(changed) } }));
  }
  await assert.rejects(run({ ...job, snapshot: add({ ...snapshot, entries: [] }) }));
});


test('a changed request is reported exactly and an unknown endpoint stays a bounded frontier', needsStore, async t => {
  const { run, job, add, requestValue } = await setup(t);
  const changed = { ...requestValue, queries: [{ from: 'app::src/routes.ts::getUser', to: 'app::src/missing.ts::unknown' }] };
  const request = add(changed);
  const out = await run({ ...job, request });
  assert.equal(out.request, request);
  assert.notEqual(out.request, job.request);
  assert.deepEqual(out.ancestor, requestValue.ancestor);
  assert.equal(out.evidence.results[0].to, changed.queries[0].to);
  assert.equal(out.evidence.results[0].outcome, 'not-reached-bounded');
  assert.ok(out.evidence.results[0].frontierReasons.includes('sentinel.paths.unknownNode'));
  assert.equal('clearedChecks' in out, false);
});

test('whole-source sealed input limit matches the real start protocol and refuses before reads',needsStore,async t=>{
  const {values,add,job}=await setup(t),id=add(job),bytes=values.get(id)!;
  const input=[...values.keys()];while(input.length<1024)input.push(id);
  assert.equal((await inspectPathInputs(bytes,input,async key=>values.get(key)!)).request,job.request);
  let reads=0;
  await assert.rejects(inspectPathInputs(bytes,[...input,id],async key=>{reads++;return values.get(key)!}));
  assert.equal(reads,0,'an oversized protocol set is refused before the first body read');
});


const budgetFailure = (reason: string) => (error: unknown) => error instanceof PathBudgetError && error.reason === reason;
test('worker budgets copy lower-only finite integer limits and preserve absolute cancellation/deadline fences', () => {
  for (const value of [NaN, Infinity, -Infinity, -1, 0.5, PATH_EXECUTION_LIMITS.reads + 1]) {
    assert.throws(() => new PathExecutionBudget({limits: {...PATH_EXECUTION_LIMITS, reads: value}}), budgetFailure('invalid-limits'));
  }
  for (const deadlineAt of [NaN, -Infinity, -1, 'later', null]) {
    assert.throws(() => new PathExecutionBudget({deadlineAt: deadlineAt as any}), budgetFailure('invalid-limits'));
  }
  const limits = {...PATH_EXECUTION_LIMITS, reads: 1};
  const budget = new PathExecutionBudget({limits, deadlineAt: Infinity});
  limits.reads = 100; budget.read(); assert.throws(() => budget.read(), budgetFailure('reads'));
  const c = new AbortController(), canceled = new PathExecutionBudget({signal: c.signal});
  c.abort(); assert.throws(() => canceled.boundary(), budgetFailure('canceled'));
  assert.throws(() => new PathExecutionBudget({deadlineAt: 0}), budgetFailure('deadline'));
});

test('aggregate unique reads and decoded/cache byte exact limits hold across the entire retained job', needsStore, async t => {
  const {values,add,job}=await setup(t), id=add(job), inputs=[...values.keys()];
  const invoke = (budget: PathExecutionBudget, reader = async (key: string) => values.get(key)!) => inspectPathInputs(values.get(id)!, inputs, reader, budget);
  const out = await invoke(new PathExecutionBudget());
  for (const key of ['reads', 'decodedBytes', 'cacheBytes'] as const) {
    const limits={...PATH_EXECUTION_LIMITS,[key]:out.usage[key]};
    assert.equal((await invoke(new PathExecutionBudget({limits}))).evidence.results[0].outcome,'reached');
    await assert.rejects(invoke(new PathExecutionBudget({limits:{...limits,[key]:limits[key]-1}})),budgetFailure(key));
  }
  let reads=0;
  await assert.rejects(invoke(new PathExecutionBudget({limits:{...PATH_EXECUTION_LIMITS,reads:0}}),async key=>{reads++;return values.get(key)!}),budgetFailure('reads'));
  assert.equal(reads,0);
  assert.equal(out.usage.reads,out.actualReadSet.length,'every unique object is charged once, including the selected job');
});

test('all queries share traversal/result budgets and exhaustion returns no partial result', needsStore, async t => {
  const {values,add,job,requestValue}=await setup(t);
  const queries=[...requestValue.queries,{from:'app::src/service.ts::findUser',to:'app::src/db.ts::query'}].sort((a,b)=>a.from.localeCompare(b.from)||a.to.localeCompare(b.to));
  const request=add({...requestValue,queries}), candidate={...job,request}, id=add(candidate), inputs=[...values.keys()];
  const invoke=(limits=PATH_EXECUTION_LIMITS)=>inspectPathInputs(values.get(id)!,inputs,async key=>values.get(key)!,new PathExecutionBudget({limits}));
  const combined=await invoke();
  assert.equal(combined.evidence.results.length,2);
  for(const key of ['visited','steps'] as const){
    assert.equal((await invoke({...PATH_EXECUTION_LIMITS,[key]:combined.usage[key]})).evidence.results.length,2);
    await assert.rejects(invoke({...PATH_EXECUTION_LIMITS,[key]:combined.usage[key]-1}),budgetFailure(key));
  }
  const singleId=add(job);
  const single=await inspectPathInputs(values.get(singleId)!,[...values.keys()],async key=>values.get(key)!);
  assert.ok(combined.usage.visited>single.usage.visited,'the second query consumes additional visits');
  await assert.rejects(invoke({...PATH_EXECUTION_LIMITS,visited:single.usage.visited}),budgetFailure('visited'));
  await assert.rejects(invoke({...PATH_EXECUTION_LIMITS,outputBytes:combined.usage.resultBytes-1}),budgetFailure('outputBytes'));
});

async function fixedChild(t:any,options:any={}){
  const fx=await setup(t),job=fx.add(fx.job),inputDir=join(fx.dir,'sealed'),entryDir=join(fx.dir,'entry'),scratchRoot=join(fx.dir,'exec');
  for(const dir of [inputDir,entryDir,scratchRoot])mkdirSync(dir,{mode:0o700});
  const inputs=[...fx.values].map(([id,bytes])=>{const path=join(inputDir,id.slice(7));writeFileSync(path,bytes,{mode:0o600});return{id,path}});
  const entry=writeBuiltinClosureEntry(entryDir,'bounded-paths');
  const registry=createAdapterRegistry([{id:'bounded-paths',version:'0.1.0',kind:'built-in',isolation:'child',module:entry.module}]);
  const service=await createExecutionService(fx.store,{scratchRoot,registry,containers:false});
  return service.run({adapterId:'bounded-paths',attemptId:'attempt-path',work:{id:'path-work',revision:1},workers:new WorkerFiles(fx.store.storePath),inputs,job,...options});
}
test('the actual fixed built-in path child reads sealed retained bytes after source removal', needsStore, async t => {
  const outcome=await fixedChild(t);
  assert.equal(outcome.state,'succeeded',JSON.stringify({code:outcome.code,detail:outcome.detail}));
  assert.equal(outcome.worker?.kind,'owned-child');
  assert.match(outcome.invocation.record.job,/^sha256:[0-9a-f]{64}$/);
  assert.equal(outcome.outputs.length,1);
  const output=JSON.parse(readFileSync(outcome.outputs[0].path,'utf8'));
  assert.equal(output.job,outcome.invocation.record.job);
  assert.equal(output.evidence.results[0].outcome,'reached');
  assert.equal(output.evidence.establishes,'call-reachability');
  for(const key of ['coveredChecks','actualReadSet','scannedSet','observations'])assert.deepEqual(outcome.result[key],[]);
  assert.ok(outcome.exit,'the owned child was reaped');
});


test('genuine coalesced start and cancel accepts no path result or outputs',needsStore,async t=>{
 const c=new AbortController(),receive=WorkerSession.prototype.receive,spawn=childProcess.spawn;let starts=0,owned:any,held:Buffer|undefined,coalesced=0;
 const spawned=t.mock.method(childProcess,'spawn',function(...args:any[]){const child=(spawn as any).apply(childProcess,args);if(args[2]?.env?.SENTINEL_ADAPTER_ID==='bounded-paths'){assert.equal(owned,undefined);owned=child;const write=child.stdin.write.bind(child.stdin);child.stdin.write=(chunk:any,...rest:any[])=>{let frame:any;try{frame=JSON.parse(Buffer.from(chunk).toString())}catch{}if(frame?.type==='start'){held=Buffer.from(chunk);return true}if(frame?.type==='cancel'&&held){const together=Buffer.concat([held,Buffer.from(chunk)]);assert.ok(together.length<4096);coalesced++;held=undefined;return write(together,...rest)}return write(chunk,...rest)}}return child});syncBuiltinESMExports();
 const mock=t.mock.method(WorkerSession.prototype,'receive',function(message:any){const step=receive.call(this,message);if(message.type==='hello'&&message.adapterId==='bounded-paths'&&step.send.some(m=>m.type==='start')){starts++;queueMicrotask(()=>c.abort())}return step});
 try{const outcome=await fixedChild(t,{signal:c.signal});assert.equal(starts,1);assert.equal(coalesced,1);assert.equal(outcome.state,'canceled',JSON.stringify({code:outcome.code,detail:outcome.detail,exit:outcome.exit,diagnostics:outcome.diagnostics}));assert.equal(outcome.result,undefined);assert.deepEqual(outcome.outputs,[]);assert.ok(outcome.exit,'the actual owned child was reaped')}finally{mock.mock.restore();spawned.mock.restore();syncBuiltinESMExports()}
});

test('actual fixed child EOF exits zero without a result; the supervisor never accepts that as success',needsStore,async t=>{
 const spawn=childProcess.spawn,receive=WorkerSession.prototype.receive;let owned:any,hellos=0;
 const spawned=t.mock.method(childProcess,'spawn',function(...args:any[]){const child=(spawn as any).apply(childProcess,args);if(args[2]?.env?.SENTINEL_ADAPTER_ID==='bounded-paths'){assert.equal(owned,undefined);owned=child}return child});syncBuiltinESMExports();
 const received=t.mock.method(WorkerSession.prototype,'receive',function(message:any){const step=receive.call(this,message);if(message.type==='hello'&&message.adapterId==='bounded-paths'){hellos++;assert.ok(owned?.pid);setImmediate(()=>owned.stdin.end());return{...step,send:step.send.filter(m=>m.type!=='start')}}return step});
 try{const outcome=await fixedChild(t);assert.equal(hellos,1);assert.equal(outcome.state,'failed');assert.equal(outcome.code,'sentinel.execution.workerExited');assert.equal(outcome.exit.exitCode,0);assert.equal(outcome.exit.exitSignal,null);assert.equal(outcome.result,undefined);assert.deepEqual(outcome.outputs,[])}
 finally{received.mock.restore();spawned.mock.restore();syncBuiltinESMExports()}
});


test('genuine fixed child cancellation before start accepts no result or output',needsStore,async t=>{
 const c=new AbortController();let owned=0;
 const outcome=await fixedChild(t,{signal:c.signal,onWorker(){owned++;c.abort()}});
 assert.equal(owned,1);assert.equal(outcome.state,'canceled');assert.equal(outcome.result,undefined);assert.deepEqual(outcome.outputs,[]);assert.ok(outcome.exit);
});
