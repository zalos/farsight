// Pure classification data only. No structural value here can grant execution authority; the coordinator uses its
// own trusted adapter/driver and genuine supervisor outcome. Tamper integration is tested in a separate serial file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closureRefusalOf, BUILTIN_WORKERS } from '../dist/execution/builtin-workers.js';
import { retryable, DEFAULT_RETRY } from '../dist/execution/scheduler.js';
import { SENTINEL_EXECUTION_STRINGS, sentinelExecutionWord } from '@farsight/core/dist/strings-sentinel-execution.js';

const digest = `sha256:${'a'.repeat(64)}`;
const adapter: any = { id: 'framework-controls', kind: 'built-in', isolation: 'child', digest };
const driver: any = { adapterId: adapter.id, implementationDigest: digest };
const outcome: any = { state: 'failed', code: 'sentinel.execution.workerExited', adapter: { id: adapter.id, digest },
  worker: { kind: 'owned-child', pid: 1 }, exit: { exitCode: 71, exitSignal: null }, protocol: { frames: 0, bytes: 0 }, outputs: [] };

test('only the exact framework startup refusal receives a nonretryable catalog classification; raw cause is untouched', () => {
  const before = structuredClone(outcome);
  assert.deepEqual(closureRefusalOf(adapter, driver, outcome), { code:'sentinel.execution.closureRefused', detail:{
    originalCode:'sentinel.execution.workerExited',exitCode:71,exitSignal:null,phase:'before-hello',adapter:{id:adapter.id,digest},
  } });
  assert.deepEqual(outcome, before);
  assert.equal(retryable('sentinel.execution.closureRefused', 1, DEFAULT_RETRY), false);
  assert.equal(retryable(outcome.code, 1, DEFAULT_RETRY), true);
  assert.equal(BUILTIN_WORKERS['framework-controls'].closureRefusalExit, 71);
  const words=SENTINEL_EXECUTION_STRINGS['sentinel.execution.closureRefused'];
  assert.match(words.professional,/startup verification refused/); assert.match(words.hud,/before checking anything/);
  assert.match(words.define,/entry point/); assert.match(sentinelExecutionWord('sentinel.execution.closureRefused'),/startup verification refused/);
  assert.doesNotMatch(JSON.stringify(words),/files (?:have )?changed|never started/i);
});

const negatives: [string, any, any, any][] = [
  ['no adapter', null, driver, outcome], ['external', {...adapter,kind:'external',isolation:'container'},driver,outcome],
  ['other id', {...adapter,id:'other-worker'},driver,outcome], ['inherited id', {...adapter,id:'toString'},driver,outcome],
  ['wrong isolation', {...adapter,isolation:'container'},driver,outcome], ['no driver',adapter,undefined,outcome],
  ['wrong driver id',adapter,{...driver,adapterId:'other'},outcome], ['wrong driver digest',adapter,{...driver,implementationDigest:`sha256:${'b'.repeat(64)}`},outcome],
  ['wrong outcome id',adapter,driver,{...outcome,adapter:{id:'other',digest}}], ['wrong outcome digest',adapter,driver,{...outcome,adapter:{id:adapter.id,digest:`sha256:${'b'.repeat(64)}`}}],
  ['canceled state',adapter,driver,{...outcome,state:'canceled'}], ['success state',adapter,driver,{...outcome,state:'succeeded'}],
  ['container worker',adapter,driver,{...outcome,worker:{kind:'owned-container'}}], ['no owned worker',adapter,driver,{...outcome,worker:undefined}],
  ['exit 70',adapter,driver,{...outcome,exit:{exitCode:70,exitSignal:null}}], ['signal',adapter,driver,{...outcome,exit:{exitCode:71,exitSignal:'SIGTERM'}}],
  ['missing signal observation',adapter,driver,{...outcome,exit:{exitCode:71}}], ['no exit',adapter,driver,{...outcome,exit:undefined}],
  ['after hello',adapter,driver,{...outcome,protocol:{frames:1,bytes:100}}], ['partial protocol bytes',adapter,driver,{...outcome,protocol:{frames:0,bytes:1}}],
  ['result present',adapter,driver,{...outcome,result:{}}], ['null result present',adapter,driver,{...outcome,result:null}],
  ['outputs present',adapter,driver,{...outcome,outputs:[{}]}],
  ...['deadlineExceeded','runDeadline','canceled','cleanupFailed','protocolViolation','frameMalformed','stdoutBudget','stderrBudget','outputMismatch'].map(code =>
    [`specific failure ${code}`,adapter,driver,{...outcome,code:`sentinel.execution.${code}`}] as [string,any,any,any]),
];
for (const [name,a,d,o] of negatives) test(`startup classification excludes ${name}`, () => assert.equal(closureRefusalOf(a,d,o),undefined));


test('the shipped bounded paths descriptor has the same exact startup refusal contract',()=>{
  const a={...adapter,id:'bounded-paths'},d={...driver,adapterId:a.id},o={...outcome,adapter:{id:a.id,digest}};
  assert.equal(BUILTIN_WORKERS[a.id].closureRefusalExit,71);
  assert.equal(closureRefusalOf(a,d,o)?.code,'sentinel.execution.closureRefused');
  assert.equal(closureRefusalOf(a,d,{...o,protocol:{frames:0,bytes:1}}),undefined);
});
