import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXPERIMENTS, parseArgs, validateManifest, validateProbeResult, runHarness, runHasFailures } from '../sentinel-feasibility.mjs';
import { sha256 } from '../sentinel-feasibility/parser.mjs';

function manifest() {return {format:'sentinel-feasibility-manifest/draft-1',fixtureRoot:'fixtures',candidates:[['@farsight/graph','0.3.1'],['@farsight/code-parser','0.3.1'],['oxc-parser','0.138.0'],['@vscode/tree-sitter-wasm','0.3.1']].map(([id,version])=>({id,version})),effects:{network:false,sourceExecution:false,providerDisclosure:false,acquisition:false},prerequisites:[],experiments:EXPERIMENTS.map(id=>({id,probe:({E1:'parser',E4:'storage',E8:'codec'})[id]??null,decision:'deferred',reason:'Test only',prerequisites:[]}))};}
async function scratch(t) {const root=await fs.mkdtemp(resolve(tmpdir(),'sentinel-harness-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('preview is the default and explicit run needs selection and fresh destination',()=>{
  assert.equal(parseArgs([]).run,false);
  assert.deepEqual(parseArgs(['--run','--experiment','E1,E4,E8','--out','/tmp/new']).experiments,['E1','E4','E8']);
  for(const args of [['--run'],['--run','--out','/tmp/new'],['--experiment','E9'],['--experiment','E1,E1'],['--out','/tmp/new'],['--command','sh']]) assert.throws(()=>parseArgs(args));
});
test('manifest rejects unknown stages, wrong pins, mutable versions and effects',()=>{
  assert.equal(validateManifest(manifest()).experiments.length,8);
  for(const mutate of [m=>m.format='wrong',m=>m.experiments.pop(),m=>m.experiments[0].id='E9',m=>m.experiments[1].id='E1',m=>m.experiments[0].probe='/tmp/evil.mjs',m=>m.effects.network=true,m=>m.effects.acquisition=true,m=>m.candidates[0].version='latest',m=>m.candidates[1].version='0.3.2',m=>m.fixtureRoot='../outside',m=>m.experiments[0].prerequisites=['invented']]) {const m=manifest();mutate(m);assert.throws(()=>validateManifest(m));}
});
test('measured evidence requires checks, correct identity and retained artifact hashes',async t=>{
  const root=await scratch(t),bytes=Buffer.from('retained original evidence\n');await fs.writeFile(resolve(root,'raw.json'),bytes);
  const result={experiment:'E1',status:'measured',checks:[{id:'negative-control',passed:false,evidence:{actual:'unsupported'}}],metrics:{},limitations:['No enforcement claim'],artifacts:[{path:'raw.json',sha256:sha256(bytes),bytes:bytes.length}]};
  assert.equal((await validateProbeResult(result,'E1',root)).status,'measured');
  for(const change of [r=>r.experiment='E4',r=>r.checks=[],r=>r.artifacts=[],r=>r.artifacts[0].bytes=1.5,r=>r.artifacts[0].path='missing.json',r=>r.artifacts=Array.from({length:1025},()=>r.artifacts[0]),r=>r.artifacts[0].sha256='0'.repeat(64),r=>r.artifacts[0].path='../elsewhere',r=>r.metrics={path:'/Users/private/source'},r=>r.checks[0].evidence=undefined]) {const changed=structuredClone(result);change(changed);await assert.rejects(validateProbeResult(changed,'E1',root));}
  await fs.writeFile(resolve(root,'raw.json'),'tampered');await assert.rejects(validateProbeResult(result,'E1',root),/identity mismatch/);
});
test('measured negative checks fail the selected CLI verdict without changing execution status',()=>{
  const row={selected:true,status:'measured',checks:[{id:'gap',passed:false,evidence:'observed'}]};
  assert.equal(runHasFailures({experiments:[row]}),true);
  assert.equal(row.status,'measured');
  assert.equal(runHasFailures({experiments:[{...row,selected:false}]}),false);
  assert.equal(runHasFailures({experiments:[{...row,checks:[{passed:true}]}]}),false);
});
test('artifact symlinks are refused',async t=>{
  const root=await scratch(t);await fs.writeFile(resolve(root,'actual'),'text');await fs.symlink('actual',resolve(root,'link'));
  await assert.rejects(validateProbeResult({experiment:'E1',status:'measured',checks:[{id:'a',passed:true,evidence:1}],metrics:{},limitations:[],artifacts:['link']},'E1',root),/symlink/);
});
test('preview performs no corpus reads or writes; requested future stages are blocked',async t=>{
  const root=await scratch(t),path=resolve(root,'manifest.json');await fs.writeFile(path,JSON.stringify(manifest()));
  const preview=await runHarness({manifest:path,run:false,experiments:['E1']},{repoRoot:root});
  assert.equal(preview.format,'sentinel-feasibility-plan/draft-1');assert.deepEqual(await fs.readdir(root),['manifest.json']);
  await fs.mkdir(resolve(root,'fixtures'));await fs.writeFile(resolve(root,'fixtures/cases.json'),JSON.stringify({schemaVersion:'sentinel-feasibility-corpus-v1',cases:[{id:'one',gates:['E1'],files:[]}]}));
  const out=resolve(root,'out');const result=await runHarness({manifest:path,run:true,experiments:['E5'],out},{repoRoot:root});
  assert.equal(result.experiments.length,8);assert.ok(result.experiments.filter(row=>!row.selected).every(row=>row.status==='deferred'));assert.equal(result.experiments.find(row=>row.selected).status,'blocked');assert.equal(runHasFailures(result),true);assert.equal(result.experiments.find(row=>row.experiment==='E5').selected,true);
  assert.equal(JSON.parse(await fs.readFile(resolve(out,'results.json'))).manifest.sha256,sha256(await fs.readFile(path)));
  await assert.rejects(runHarness({manifest:path,run:true,experiments:['E5'],out},{repoRoot:root}),/EEXIST/);
});
test('manifest available=true cannot waive an unknown runtime prerequisite',async t=>{
  const root=await scratch(t),m=manifest();m.prerequisites=[{id:'made-up',required:true,available:true}];m.experiments[0].prerequisites=['made-up'];
  await fs.mkdir(resolve(root,'fixtures'));await fs.writeFile(resolve(root,'fixtures/cases.json'),JSON.stringify({schemaVersion:'sentinel-feasibility-corpus-v1',cases:[{id:'one',gates:['E1'],files:[]}]}));
  const path=resolve(root,'manifest.json');await fs.writeFile(path,JSON.stringify(m));
  const result=await runHarness({manifest:path,run:true,experiments:['E1'],out:resolve(root,'out')},{repoRoot:root});
  assert.equal(result.experiments[0].status,'blocked');assert.equal(result.experiments[0].checks.length,0);
});

test('requesting an unavailable E2 probe returns an actual nonzero CLI status',async t=>{
  const root=await scratch(t),m=manifest();m.fixtureRoot='packages/sentinel/test/fixtures/feasibility';
  const path=resolve(root,'manifest.json');await fs.writeFile(path,JSON.stringify(m));
  const run=spawnSync(process.execPath,[fileURLToPath(new URL('../sentinel-feasibility.mjs',import.meta.url)),'--manifest',path,'--run','--experiment','E2','--out',resolve(root,'out')],{encoding:'utf8'});
  assert.equal(run.status,1,run.stderr);
  const result=JSON.parse(await fs.readFile(resolve(root,'out/results.json')));
  assert.equal(result.experiments.find(row=>row.experiment==='E2').status,'blocked');
  assert.ok(result.experiments.filter(row=>!row.selected).every(row=>row.status==='deferred'));
});
