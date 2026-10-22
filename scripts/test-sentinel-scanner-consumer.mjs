#!/usr/bin/env node
// An npm-only installed CLI performs every owner/planner/service/report action. The test harness supplies only
// original inert source and a tiny synthetic advisory archive; existing pinned images/checks are never pulled.
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync,realpathSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {npmConsumer} from './npm-consumer.mjs';
import {scannerFixture} from '../packages/sentinel/test/cli-scanners-helpers.ts';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(readFileSync(join(root,'packages/sentinel/package.json'),'utf8'));
const artifact=resolve(process.argv[2]??join(root,'build/sentinel',`farsight-sentinel-${manifest.version}.tgz`));
assert.equal(process.env.SENTINEL_ISOLATION,'1','qualification requires existing local pinned images, never a pull');assert.ok(existsSync(artifact));
const consumer=await npmConsumer('sentinel-scanners-consumer-',[artifact]);
let env;
async function stopOwnService(){if(!env)return;const dir=join(env.XDG_STATE_HOME,'farsight','sentinel','trust','services');if(!existsSync(dir))return;
 for(const name of readdirSync(dir).filter(n=>n.endsWith('.json'))){const descriptor=JSON.parse(readFileSync(join(dir,name),'utf8'));const pid=descriptor.pid;
  assert.ok(Number.isSafeInteger(pid)&&pid>1);try{process.kill(pid,'SIGTERM');}catch{continue;}
  for(let i=0;i<200;i++){try{process.kill(pid,0);}catch{break;}await new Promise(r=>setTimeout(r,50));}
 }
}
try{
 const f=scannerFixture(realpathSync.native(consumer.scratch));const bin=consumer.bin('farsight-sentinel');env={...consumer.env,PATH:dirname(process.execPath)+':/usr/bin:/bin',XDG_STATE_HOME:join(realpathSync.native(consumer.scratch),'owner-state')};
 const installed=join(consumer.dir,'node_modules/farsight-sentinel');assert.ok(!readdirSync(join(consumer.dir,'node_modules')).includes('@farsight'));
 assert.ok(!readdirSync(installed,{recursive:true}).map(String).some(p=>/\.(zip|tar\.gz)$/.test(p)),'no database or checks bundle is shipped');
 const cli=async(...args)=>{try{const r=await consumer.exec(bin,[...args,'--json'],{cwd:f.ws,env});return{status:0,body:JSON.parse(r.stdout)};}catch(e){if(typeof e.code!=='number')throw e;return{status:e.code,body:JSON.parse(e.stdout)};}};
 assert.equal((await cli('init','--profile','scanners')).status,0);const settings=readFileSync(join(f.ws,'.farsight/sentinel/settings.json'));assert.equal((await cli('init')).body.outcome,'kept');assert.deepEqual(readFileSync(join(f.ws,'.farsight/sentinel/settings.json')),settings);
 assert.equal((await cli('settings','adopt')).status,4);const adoption=await cli('settings','adopt','--confirm');assert.equal(adoption.status,0,JSON.stringify(adoption.body));
 for(const pack of ['pattern','advisories','infrastructure','ci'])assert.equal((await cli('rules','promote','builtin:'+pack,'--confirm')).status,0);
 const missing=await cli('plan');assert.deepEqual([missing.status,missing.body.reasonCode],[3,'sentinel.assets.missing']);
 for(const id of ['pattern-semgrep','advisories-osv','iac-trivy','ci-zizmor']){assert.equal((await cli('assets','adopt-tool',id)).status,4);assert.equal((await cli('assets','adopt-tool',id,'--confirm')).status,0);}
 assert.equal((await cli('assets','adopt-database','osv:npm','--license','MIT','--manifest',f.manifest,'--archive',f.db.path,'--confirm')).status,0);
 const trivy=await cli('assets','adopt-database','trivy-checks','--manifest',f.trivyManifest,'--archive',f.checks.path,'--confirm');assert.equal(trivy.status,0);assert.equal(trivy.body.facts.entry.rights.spdx,'MIT');
 const planned=await cli('plan');assert.equal(planned.status,0,JSON.stringify(planned.body));assert.equal(planned.body.facts.label,'deterministic');const id=planned.body.facts.runId;
 assert.equal((await cli('run',id,'--detach')).status,4);const start=await cli('run',id,'--detach','--confirm');assert.deepEqual([start.status,start.body.outcome],[0,'submitted'],JSON.stringify(start.body));
 const joined=await cli('run',id,'--detach','--confirm');assert.equal(joined.body.facts.runId,id);
 const waited=await cli('wait',id);assert.equal(waited.status,2,JSON.stringify(waited.body));assert.equal(waited.body.facts.state,'completed');assert.ok(waited.body.facts.observations>0);assert.equal(waited.body.facts.requiredCoverageComplete,false);
 const report=(await cli('report',id)).body.facts.report;assert.equal(report.schema,'sentinel-scanner-report/draft-1');const adapters=new Set(report.observations.map(o=>o.value.adapter));for(const adapter of ['pattern-semgrep','advisories-osv','iac-trivy','ci-zizmor'])assert.ok(adapters.has(adapter));
 for(const path of Object.keys(f.files))rmSync(join(f.ws,path),{force:true});await stopOwnService();
 const regenerated=(await cli('report',id)).body.facts.report;assert.deepEqual(regenerated.observations,report.observations);assert.deepEqual(regenerated.coverage,report.coverage);assert.equal(regenerated.ledgerSequence,report.ledgerSequence);
 console.log('sentinel scanner consumer ok: npm-only init twice, adoption, exact original packs, missing-asset refusal, owner-receipted tool/database adoption, plan, detach/join/wait through four real pinned containers, retained report after service restart and source removal; incomplete required coverage stays exit 2');
}finally{await stopOwnService();consumer.cleanup();}
