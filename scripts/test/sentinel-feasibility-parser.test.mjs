import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory, loadCorpus, reconcileInputs, runParserProbe, sha256 } from '../sentinel-feasibility/parser.mjs';
const REPO=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
async function scratch(t) {const root=await fs.mkdtemp(resolve(tmpdir(),'sentinel-parser-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('independent inventory never follows symbolic links and hashes hidden files',async t=>{
  const root=await scratch(t);await fs.writeFile(resolve(root,'.hidden'),'inert');await fs.symlink('../outside',resolve(root,'link'));
  const rows=await inventory(root);assert.equal(rows.find(row=>row.path==='.hidden').digest,sha256('inert'));assert.equal(rows.find(row=>row.path==='link').kind,'symlink');assert.equal(rows.length,3);
});
test('input-kind reconciliation rejects digest and kind confusion',()=>{
  const rows=[{path:'a.ts',kind:'file',digest:sha256('bytes')},{path:'dir',kind:'directory',digest:sha256('[]')},{path:'link',kind:'symlink'}];
  const inputs=[{path:'a.ts',kind:'content',digest:sha256('bytes')},{path:'a.ts',kind:'metadata',digest:sha256('file')},{path:'dir',kind:'directory',digest:sha256('[]')},{path:'absent',kind:'missing',digest:sha256('unavailable')},{path:'link',kind:'missing',digest:sha256('unavailable')}];
  assert.ok(reconcileInputs(rows,{inputs}).every(row=>row.matched));
  assert.equal(reconcileInputs(rows,{inputs:[{path:'a.ts',kind:'missing',digest:sha256('unavailable')} ]})[0].matched,false);
  assert.equal(reconcileInputs(rows,{inputs:[{path:'a.ts',kind:'content',digest:'0'.repeat(64)} ]})[0].matched,false);
});
test('corpus tampering and source symlinks are refused before materialization',async t=>{
  const root=await scratch(t);await fs.writeFile(resolve(root,'input.fixture'),'bytes');
  const value={schemaVersion:'sentinel-feasibility-corpus-v1',cases:[{id:'one',gates:['E1'],files:[{path:'a.ts',source:'input.fixture',sha256:sha256('bytes')}]}]};
  const path=resolve(root,'cases.json');await fs.writeFile(path,JSON.stringify(value));await loadCorpus(root);
  await fs.writeFile(resolve(root,'input.fixture'),'tampered');await assert.rejects(loadCorpus(root),/digest mismatch/);
  await fs.unlink(resolve(root,'input.fixture'));await fs.symlink('other',resolve(root,'input.fixture'));await assert.rejects(loadCorpus(root),/symlink/);
  value.cases[0].files[0].path='../escape';await fs.writeFile(path,JSON.stringify(value));await assert.rejects(loadCorpus(root),/safe relative/);
});
test('actual public TS and Java probe retains independent inventories and negative controls',async t=>{
  const root=await scratch(t),result=await runParserProbe({fixtureRoot:resolve(REPO,'packages/sentinel/test/fixtures/feasibility'),workDir:resolve(root,'work'),artifactDir:resolve(root,'artifacts')});
  assert.equal(result.status,'measured');assert.equal(result.experiment,'E1');assert.equal(result.metrics.parserVersion,'0.3.1');
  for(const id of ['ignored-complete-trap','gitignore-change','symlink-refused','oversize-not-clean','missing-recorded']) assert.equal(result.checks.find(row=>row.id===id)?.passed,true,id);
  assert.ok(result.metrics.cases.some(row=>row.id==='java-injection-pair'));
  assert.ok(result.metrics.cases.some(row=>row.complete&&row.omittedFiles.length));
  for(const row of result.artifacts) {const bytes=await fs.readFile(resolve(root,'artifacts',row.path));assert.equal(sha256(bytes),row.sha256);assert.equal(bytes.length,row.bytes);}
  assert.ok(result.checks.filter(row=>row.id.endsWith(':source-unchanged')).every(row=>row.passed));
  assert.ok(result.checks.filter(row=>row.id.endsWith(':input-digests')).every(row=>row.passed));
});

test('corpus and inventory refuse a symlinked root before reading outside it',async t=>{
  const root=await scratch(t),outside=resolve(root,'outside'),alias=resolve(root,'alias');
  await fs.mkdir(outside);await fs.writeFile(resolve(outside,'cases.json'),'not a corpus');await fs.symlink(outside,alias);
  await assert.rejects(loadCorpus(alias),/directory symlink refused/);
  await assert.rejects(inventory(alias),/directory symlink refused/);
});
test('corpus refuses a symlinked index before parsing its target',async t=>{
  const root=await scratch(t),fixtures=resolve(root,'fixtures');await fs.mkdir(fixtures);
  const outside=resolve(root,'external.json');await fs.writeFile(outside,'not a corpus');await fs.symlink(outside,resolve(fixtures,'cases.json'));
  await assert.rejects(loadCorpus(fixtures),/index symlink refused/);
});
