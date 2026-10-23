// Optional CI diagnostics: forwarding, bounded observation and identity controls only; no substitute native canaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnWorker } from '../dist/execution/processes.js';
import { diagnosticRunner, processFacts, TRACE_LIMITS, preserveDiagnosticOutcome, classifyJournal, journalArguments, preflightJournalQueries } from './helpers/isolation-diagnostic.ts';
const answer = { exitCode: 0, exitSignal: null, stdout: Buffer.from('same bytes'), stderr: Buffer.alloc(0),
  stdoutExceeded: false, stderrExceeded: false, timedOut: false, canceled: false, spawnError: null };

test('diagnostic runner forwards exact arguments, signal, results and errors without extra kill commands', async () => {
  const calls: unknown[] = [], failure = new Error('original reader failure'), signal = new AbortController().signal;
  const real: any = { run: async (args: unknown, s: unknown) => { calls.push({args,signal:s}); if((args as string[])[0]==='fail')throw failure;return answer; },
    runSync: () => answer, start: () => assert.fail('no worker') };
  const trace = diagnosticRunner(real), args = ['kill', 'a'.repeat(64)];
  assert.equal(await trace.runner.run(args,signal), answer);
  assert.deepEqual(calls[0], {args,signal});assert.equal((calls[0] as any).args,args);
  assert.equal(trace.runner.runSync(args),answer);
  await assert.rejects(trace.runner.run(['fail']),e=>e===failure);
  const report:any=await trace.finish();assert.equal(report.dropped,0);assert.equal(calls.length,2);
  assert.equal(await trace.finish(),report,'finish is idempotent and adds no observers');
});

test('diagnostic process tracing preserves bytes and flow mode while observing hello/start frames', async () => {
  let original:any, dataListeners=-1;
  const real:any={run:async()=>answer,runSync:()=>answer,start:()=>{
    original=spawnWorker(process.execPath,['-e',`process.stdout.write('{"type":"hello"}\\n');process.stdin.on('data',b=>{process.stdout.write(b);process.stderr.write('diagnostic-only')});process.stdin.on('end',()=>process.exit(0))`],{env:{}});
    dataListeners=original.child.stdout.listenerCount('data');return original;
  }};
  const trace=diagnosticRunner(real),proc=trace.runner.start('a'.repeat(64));
  assert.equal(proc.child,original.child);assert.equal(proc.exited,original.exited);
  assert.equal(proc.child.stdout.listenerCount('data'),dataListeners,'observer adds no data listener');
  const stdout:Buffer[]=[],stderr:Buffer[]=[];proc.child.stdout.on('data',b=>stdout.push(b));proc.child.stderr.on('data',b=>stderr.push(b));
  proc.child.stdin.write('{"type":"start"}\n');proc.child.stdin.end();
  assert.deepEqual(await proc.exited,{exitCode:0,exitSignal:null,spawnError:null});
  assert.equal(Buffer.concat(stdout).toString(),'{"type":"hello"}\n{"type":"start"}\n');
  assert.equal(Buffer.concat(stderr).toString(),'diagnostic-only');
  const report:any=await trace.finish();assert.equal(report.streams.helloSeen,true);assert.equal(report.streams.startSent,true);
  assert.equal(report.streams.stdoutBytes,Buffer.concat(stdout).length);assert.equal(report.streams.stderrBytes,Buffer.concat(stderr).length);
  assert.equal(report.records.filter(r=>r.type==='actual-client-kill').length,0);
});

test('diagnostic kill forwarding retains actual SIGKILL and the already-reaped no-op', async () => {
  const real:any={run:async()=>answer,runSync:()=>answer,start:()=>spawnWorker(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{}})};
  const trace=diagnosticRunner(real),proc=trace.runner.start('a'.repeat(64));proc.kill();
  const exit=await proc.exited;assert.equal(exit.exitSignal,'SIGKILL');assert.equal(exit.exitCode,null);proc.kill();
  const report:any=await trace.finish();assert.equal(report.records.filter(r=>r.type==='actual-client-kill').length,1);
  assert.equal(report.records.filter(r=>r.type==='worker-process-kill-request').length,2);
});

for(const kind of ['exact','substring','changed'] as const)test(`cgroup diagnostic ${kind} identity never falls back`,()=>{
  const id='a'.repeat(64),reads:string[]=[];let stats=0;
  const stat=(start:number)=>`999999 (node) ${Array.from({length:20},(_,i)=>i===19?start:'0').join(' ')}`;
  const report:any=processFacts(999999,id,(path:string)=>{
    reads.push(path);
    if(path.endsWith('/stat'))return {text:stat(++stats>1&&kind==='changed'?2:1)};
    if(path.endsWith('/cgroup'))return {text:`0::/system.slice/docker-${kind==='substring'?'b'+id:id}.scope\n`};
    return {text:'fixture bounded counter'};
  });
  if(kind==='exact'){assert.equal(report.unavailable,undefined);assert.equal(Object.keys(report.memory).length,4)}
  else{assert.ok(report.unavailable);assert.equal(report.memory,undefined)}
  if(kind==='substring')assert.ok(!reads.some(p=>p.startsWith('/sys/fs/cgroup')));
  assert.ok(!reads.includes('/sys/fs/cgroup/memory.events'),'no root cgroup substitution');
});

test('diagnostic observation record and byte bounds are finite and dropping remains explicit',async()=>{
  const real:any={run:async()=>answer,runSync:()=>answer,start:()=>assert.fail('no worker')};const trace=diagnosticRunner(real);
  for(let i=0;i<TRACE_LIMITS.records;i++)await trace.runner.run(['inspect','not-a-container']);
  const report:any=await trace.finish();assert.ok(report.records.length<=TRACE_LIMITS.records);assert.ok(report.bytes<=TRACE_LIMITS.bytes);assert.ok(report.dropped>0);
});


test('diagnostic persistence failure cannot replace original success or failure and logs bounded detail',async()=>{
  let note='';const original=new Error('original outcome');
  const save=()=>Promise.reject(Object.assign(new Error('trace save failed'),{code:'EACCES'}));
  const success=async()=>{try{return answer}finally{await preserveDiagnosticOutcome(save,text=>{note=text})}};
  assert.equal(await success(),answer);assert.ok(note.includes('EACCES'));assert.ok(Buffer.byteLength(note)<=256);
  await preserveDiagnosticOutcome(()=>Promise.reject({code:'雪'.repeat(1000),name:'雪'.repeat(1000)}),text=>{note=text});assert.ok(Buffer.byteLength(note)<=256);
  await assert.rejects((async()=>{try{throw original}finally{await preserveDiagnosticOutcome(save,()=>{throw Error('diagnostic logger failed')})}})(),e=>e===original);
});


test('journal results distinguish matched, visible no-match and unavailable without absence claims', () => {
  const classify = (patch: object) => classifyJournal({ ...answer, ...patch });
  assert.equal(classify({}).classification, 'matched');
  for (const stdout of ['-- No entries --', '-- No entries --\n', '-- No entries --\r\n'])
    assert.equal(classify({ exitCode: 1, stdout: Buffer.from(stdout) }).classification, 'no-match-visible');
  for (const patch of [ { exitCode: 1 }, { exitCode: 1, stdout: Buffer.from('-- No entries --\n'), stderr: Buffer.from('permission denied') },
    { stdoutExceeded: true }, { stderrExceeded: true }, { timedOut: true }, { canceled: true }, { exitSignal: 'SIGKILL' }, { spawnError: 'ENOENT' } ])
    assert.equal(classify(patch).classification, 'unavailable');
  assert.match(classify({}).visibility, /not proof/);
});

test('journal preflight uses actual filtered argv and refuses diagnostic syntax defects', async () => {
  const calls: any[] = [];
  const run: any = async (file: string, args: string[], options: any) => {
    calls.push({ file, args, options }); return { ...answer, exitCode: 1, stdout: Buffer.from('-- No entries --\n') };
  };
  assert.equal((await preflightJournalQueries(run)).length, 2);
  assert.equal(calls[0].file, '/usr/bin/journalctl');assert.ok(calls[0].args.includes('--dmesg'));
  assert.ok(!calls.flatMap(c => c.args).includes('--kernel'));assert.ok(calls.every(c => c.args.includes('--grep=' + '0'.repeat(64))));
  assert.ok(calls.every(c => c.options.timeoutMs === 1000 && c.options.maxStdoutBytes === 8192));
  for (const stderr of ["unrecognized option '--kernel'", 'unknown option', 'invalid argument', '', 'permission denied; invalid option'])
    await assert.rejects(preflightJournalQueries((async () => ({ ...answer, exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(stderr) })) as any), /preflight failed/);
  await assert.rejects(preflightJournalQueries((async () => ({ ...answer, stderr: Buffer.from('unrecognized option') })) as any), (error: any) => {
    assert.match(error.message, /preflight failed/);assert.equal(error.journal.length, 2);
    assert.ok(error.journal.every((r: any) => r.argv.includes('--grep=' + '0'.repeat(64))));return true;
  });
  const limited = await preflightJournalQueries((async () => ({ ...answer, exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('Permission denied') })) as any);
  assert.ok(limited.every(r => r.classification === 'unavailable' && r.permissionLimited));
  assert.throws(() => journalArguments('kernel', 'invalid', new Date().toISOString(), 'a'.repeat(64)), /identity invalid/);
  assert.throws(() => journalArguments('kernel', new Date().toISOString(), new Date().toISOString(), 'alias'), /identity invalid/);
});
