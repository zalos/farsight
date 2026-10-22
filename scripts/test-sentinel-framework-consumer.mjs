#!/usr/bin/env node
// Public npm-only framework inspection: original inert source, owner promotion and retained evidence. The worker
// executes Sentinel's trusted code, never this application's code. Set FARSIGHT_NPM_OFFLINE_CACHE for offline use.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmConsumer } from './npm-consumer.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(readFileSync(join(root,'packages/sentinel/package.json'))).version;
const artifact=resolve(process.argv[2]??join(root,'build/sentinel',`farsight-sentinel-${version}.tgz`));
assert.ok(existsSync(artifact),'pack Sentinel first');
const c=await npmConsumer('sentinel-framework-', [artifact]);
try {
 const scratch=realpathSync.native(c.scratch);
 const ws=join(scratch,'workspace');mkdirSync(join(ws,'src'),{recursive:true});
 writeFileSync(join(ws,'package.json'),JSON.stringify({name:'original-inspection-example',version:'1.0.0',dependencies:{express:'4.21.2'}}));
 writeFileSync(join(ws,'package-lock.json'),JSON.stringify({name:'original-inspection-example',lockfileVersion:3,packages:{'':{dependencies:{express:'4.21.2'}},'node_modules/express':{version:'4.21.2',resolved:'https://registry.npmjs.org/express/-/express-4.21.2.tgz'}}}));
 writeFileSync(join(ws,'src/routes.ts'),"import express from 'express'; const app=express(); app.get('/original', (_req,res)=>res.send('example'));\n");
 const env={...c.env,HOME:join(scratch,'home'),XDG_STATE_HOME:join(scratch,'owner')};mkdirSync(env.HOME);
 const bin=c.bin('farsight-sentinel');
 const call=async(...args)=>{try{const r=await c.exec(bin,[...args,'--json'],{cwd:ws,env});return{status:0,body:JSON.parse(r.stdout)}}catch(e){if(typeof e.code!=='number')throw e;return{status:e.code,body:JSON.parse(e.stdout)}}};
 assert.equal((await call('init')).status,0);
 const settings=join(ws,'.farsight/sentinel/settings.json');
 writeFileSync(settings,JSON.stringify({...JSON.parse(readFileSync(settings)),mandatoryRules:['sentinel.controls.authentication','sentinel.controls.authorization','sentinel.controls.input-validation']}));
 const adopted=await call('settings','adopt','--confirm');assert.equal(adopted.status,0,JSON.stringify(adopted));
 assert.equal((await call('rules','promote','builtin:framework-controls','--confirm')).status,0);
 const plan=await call('plan');assert.equal(plan.status,0,JSON.stringify(plan));
 const id=plan.body.facts.planId;assert.equal(plan.body.facts.unitIds.length,1);
 const full=async(run,format)=>{try{return(await c.exec(bin,['report',run,'--full','--format',format],{cwd:ws,env})).stdout}catch(e){if(![0,2].includes(e.code))throw e;return e.stdout}};
 const started=performance.now();const run=await call('run',id);
 assert.equal(run.status,2,JSON.stringify(run));assert.equal(run.body.facts.state,'completed');
 const cleanJson=await full(id,'json'),cleanHtml=await full(id,'html');
 if(process.env.FARSIGHT_FRAMEWORK_EVIDENCE){mkdirSync(process.env.FARSIGHT_FRAMEWORK_EVIDENCE,{recursive:true});writeFileSync(join(process.env.FARSIGHT_FRAMEWORK_EVIDENCE,'clean.json'),cleanJson,{mode:0o600});writeFileSync(join(process.env.FARSIGHT_FRAMEWORK_EVIDENCE,'clean.html'),cleanHtml,{mode:0o600});}
 const before=JSON.parse(cleanJson);assert.equal(before.inspections.length,1);assert.equal(before.findings.length,0);assert.equal(before.inspections[0].assessment,'none');
 assert.match(await full(id,'md'),/Framework control inspection/);assert.match(await full(id,'html'),/Framework control inspection/);const sarif=JSON.parse(await full(id,'sarif'));assert.deepEqual(sarif.runs[0].properties.inspections,before.inspections);assert.equal(sarif.runs[0].results.length,0);
 const entries=join(env.XDG_STATE_HOME,'farsight/sentinel/trust/adapters/framework-controls');
 const names=readdirSync(entries).filter(n=>n.endsWith('.mjs'));assert.equal(names.length,1);
 const name=names[0],entry=readFileSync(join(entries,name));
 assert.equal(name,`framework-controls-${createHash('sha256').update(entry).digest('hex')}.mjs`);
 const closure=JSON.parse(/const CLOSURE = (.*);/.exec(entry.toString())[1]);
 const installed=join(realpathSync.native(c.dir),'node_modules/farsight-sentinel');
 const files=[];const walk=p=>{for(const n of readdirSync(p,{withFileTypes:true})){const f=join(p,n.name);if(n.isDirectory())walk(f);else files.push(f)}};walk(join(installed,'dist'));
 for(const p of files)assert.ok(closure.some(([f,k])=>f===p&&k==='file'),`entire emitted dist file pinned: ${p}`);
 assert.equal(closure.some(([p,k])=>k==='file'&&p===join(realpathSync.native(c.dir),'package.json')),false,'consumer package is outside the pinned installation');
 const changed=files.find(p=>p.includes('/chunks/')&&p.endsWith('.mjs'));assert.ok(changed);const original=readFileSync(changed);
 writeFileSync(changed,Buffer.concat([original,Buffer.from('\n// installed drift probe\n')]));
 try{const refused=await c.exec(process.execPath,[join(entries,name)],{cwd:ws,env}).then(r=>({code:0,...r}),e=>e);assert.equal(refused.code,71);assert.equal(refused.stdout,'','no protocol before closure refusal')}finally{writeFileSync(changed,original)}
 const dependency=join(realpathSync.native(c.dir),'node_modules/ajv/dist/compile/index.js'),depOriginal=readFileSync(dependency);writeFileSync(dependency,Buffer.concat([depOriginal,Buffer.from('\n// transitive drift probe\n')]));
 try{const refused=await c.exec(process.execPath,[join(entries,name)],{cwd:ws,env}).then(r=>({code:0,...r}),e=>e);assert.equal(refused.code,71);assert.equal(refused.stdout,'')}finally{writeFileSync(dependency,depOriginal)}
 const status=await call('status',id);assert.equal(status.body.facts.state,'completed',JSON.stringify(status));
 assert.deepEqual(readdirSync(entries).filter(n=>n.endsWith('.mjs')),names,'same installed build in a second process reuses exact entry');
 renameSync(join(ws,'src'),join(scratch,'source-away'));
 const child=await call('rerun',id,'--stage',plan.body.facts.unitIds[0]);assert.equal(child.status,0,JSON.stringify(child));
 const reran=await call('run',child.body.facts.runId);assert.equal(reran.body.facts.state,'completed',JSON.stringify(reran));
 const replay=JSON.parse(await full(id,'json'));assert.deepEqual({...replay,evaluatedAt:null},{...before,evaluatedAt:null},'read-only source-removed parent replay');
 const childReport=JSON.parse(await full(child.body.facts.runId,'json'));assert.deepEqual(childReport.inspections[0].rows,before.inspections[0].rows);
 console.log(JSON.stringify({consumer:'framework',distFiles:files.length,closureEntries:closure.length,entryBytes:entry.length,runMs:Math.round(performance.now()-started),sourceRemovedSelected:true}));
}finally{c.cleanup()}
