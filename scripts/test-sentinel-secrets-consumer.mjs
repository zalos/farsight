#!/usr/bin/env node
// An npm-only installed CLI runs the current-tree secret scan end to end: init with the secrets profile, owner
// adoption, the exact original pack, a missing-asset refusal, owner-receipted tool adoption, plan, run through the real
// pinned Gitleaks container (already installed locally; never pulled, no host fallback), report, and the retained
// report after the source is removed. Inputs are original inert synthetic values assembled at run time. No output,
// diagnostic or metadata-level artifact may carry a value or a secret-shaped file name.
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {npmConsumer} from './npm-consumer.mjs';
import {VALUE,GENERIC_VALUE} from '../packages/sentinel/test/secrets-helpers.ts';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(readFileSync(join(root,'packages/sentinel/package.json'),'utf8'));
const artifact=resolve(process.argv[2]??join(root,'build/sentinel',`farsight-sentinel-${manifest.version}.tgz`));
assert.equal(process.env.SENTINEL_ISOLATION,'1','qualification requires the existing local pinned image, never a pull');assert.ok(existsSync(artifact));
const absent=(text,where)=>{for(const v of [VALUE,GENERIC_VALUE])assert.ok(!String(text).includes(v),`${where} carries a synthetic value`);};
const consumer=await npmConsumer('sentinel-secrets-consumer-',[artifact]);
let env;
async function stopOwnService(){if(!env)return;const dir=join(env.XDG_STATE_HOME,'farsight','sentinel','trust','services');if(!existsSync(dir))return;
 for(const name of readdirSync(dir).filter(n=>n.endsWith('.json'))){const pid=JSON.parse(readFileSync(join(dir,name),'utf8')).pid;
  assert.ok(Number.isSafeInteger(pid)&&pid>1);try{process.kill(pid,'SIGTERM');}catch{continue;}
  for(let i=0;i<200;i++){try{process.kill(pid,0);}catch{break;}await new Promise(r=>setTimeout(r,50));}}}
try{
 const scratch=realpathSync.native(consumer.scratch);const ws=join(scratch,'workspace');mkdirSync(ws);mkdirSync(join(ws,'skipped.png'));
 const files={'.env':`token=${VALUE}\n`,'safe.txt':'this contains no credential\n','first.txt':`api_key = "${GENERIC_VALUE}"\n`,[GENERIC_VALUE]:'ordinary safe content\n','skipped.png/file.env':`token=${VALUE}\n`};
 for(const[path,text]of Object.entries(files))writeFileSync(join(ws,path),text);
 const bin=consumer.bin('farsight-sentinel');env={...consumer.env,PATH:dirname(process.execPath)+':/usr/bin:/bin',XDG_STATE_HOME:join(scratch,'owner-state')};
 const cli=async(...args)=>{let r;try{r=await consumer.exec(bin,[...args,'--json'],{cwd:ws,env});r={status:0,stdout:r.stdout,stderr:r.stderr};}catch(e){if(typeof e.code!=='number')throw e;r={status:e.code,stdout:e.stdout,stderr:e.stderr};}
  absent(r.stdout,'public output');absent(r.stderr,'public diagnostics');return{status:r.status,body:JSON.parse(r.stdout)};};
 assert.equal((await cli('init','--profile','secrets')).status,0);assert.equal((await cli('settings','adopt','--confirm')).status,0);
 assert.equal((await cli('rules','promote','builtin:secrets','--confirm')).status,0);
 const missing=await cli('plan');assert.deepEqual([missing.status,missing.body.reasonCode],[3,'sentinel.assets.missing']);
 assert.equal((await cli('assets','adopt-tool','secrets-gitleaks')).status,4);assert.equal((await cli('assets','adopt-tool','secrets-gitleaks','--confirm')).status,0);
 const planned=await cli('plan');assert.equal(planned.status,0,JSON.stringify(planned.body));const id=planned.body.facts.runId;
 const ran=await cli('run',id,'--confirm');assert.equal(ran.status,2,JSON.stringify(ran.body));assert.equal(ran.body.facts.state,'completed');assert.ok(ran.body.facts.observations>=2);
 const report=(await cli('report',id)).body.facts.report;
 const scan=report.reports.find(r=>r.value.adapter==='secrets-gitleaks').value;assert.equal(scan.status,'partial');
 assert.ok(scan.skipped.some(r=>r.reasonCode==='sentinel.secrets.toolAllowlisted'),'an engine-pruned folder is an explicit omission');
 assert.ok(scan.scanned.every(s=>/^workspace#entry:\d+$/.test(s)),'scanned scopes are opaque capture entries');
 assert.ok(report.observations.filter(o=>o.value.adapter==='secrets-gitleaks').every(o=>o.value.evidence.every(e=>e.location==='withheld'&&!('relativePath'in e))));
 for(const path of Object.keys(files))rmSync(join(ws,path),{recursive:true,force:true});await stopOwnService();
 const regenerated=(await cli('report',id)).body.facts.report;assert.deepEqual(regenerated.observations,report.observations);assert.deepEqual(regenerated.coverage,report.coverage);
 console.log('sentinel secrets consumer ok: npm-only init, adoption, exact original pack, missing-asset refusal, owner-receipted tool adoption, plan and run through the real pinned Gitleaks container, withheld locations and explicit omissions, retained report after source removal; no value in any public output');
}finally{await stopOwnService();consumer.cleanup();}
