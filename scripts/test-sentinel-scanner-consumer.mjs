#!/usr/bin/env node
// An npm-only installed CLI performs every owner/planner/service/report action. The test harness supplies only
// original inert source and a tiny synthetic advisory archive; existing pinned images/checks are never pulled.
import assert from 'node:assert/strict';
import {cpSync,existsSync,mkdirSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {npmConsumer} from './npm-consumer.mjs';
import {scannerFixture} from '../packages/sentinel/test/cli-scanners-helpers.ts';
import {VALUE,GENERIC_VALUE,absent} from '../packages/sentinel/test/secrets-helpers.ts';
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
 // The fifth engine's synthetic secrets: a value in content, identical bytes in two files, and a source file whose name
 // is the value (the pattern scanner flags its code too). No command's output may carry either value.
 const secretFiles={'service.env':`SENTINEL_SYNTHETIC_TOKEN=${VALUE}\n`,'first.txt':`api_key = "${GENERIC_VALUE}"\n`,'second.txt':`api_key = "${GENERIC_VALUE}"\n`,
  [`src/${VALUE}.ts`]:'export function named(id: string) { return db.query("SELECT * FROM named WHERE id = " + id); }\n'};
 for(const [p,text] of Object.entries(secretFiles))writeFileSync(join(f.ws,p),text);
 const clean=(text,where)=>{for(const v of [VALUE,GENERIC_VALUE])absent(text??'',where,v);};
 const cli=async(...args)=>{try{const r=await consumer.exec(bin,[...args,'--json'],{cwd:f.ws,env});clean(r.stdout,`${args[0]} stdout`);clean(r.stderr,`${args[0]} stderr`);return{status:0,body:JSON.parse(r.stdout)};}catch(e){if(typeof e.code!=='number')throw e;clean(e.stdout,`${args[0]} stdout`);clean(e.stderr,`${args[0]} stderr`);return{status:e.code,body:JSON.parse(e.stdout)};}};
 assert.equal((await cli('init','--profile','scanners')).status,0);const settings=readFileSync(join(f.ws,'.farsight/sentinel/settings.json'));assert.equal((await cli('init')).body.outcome,'kept');assert.deepEqual(readFileSync(join(f.ws,'.farsight/sentinel/settings.json')),settings);
 assert.equal((await cli('settings','adopt')).status,4);const adoption=await cli('settings','adopt','--confirm');assert.equal(adoption.status,0,JSON.stringify(adoption.body));
 for(const pack of ['pattern','advisories','infrastructure','ci','secrets'])assert.equal((await cli('rules','promote','builtin:'+pack,'--confirm')).status,0);
 const missing=await cli('plan');assert.deepEqual([missing.status,missing.body.reasonCode],[3,'sentinel.assets.missing']);
 for(const id of ['pattern-semgrep','advisories-osv','iac-trivy','ci-zizmor','secrets-gitleaks']){assert.equal((await cli('assets','adopt-tool',id)).status,4);assert.equal((await cli('assets','adopt-tool',id,'--confirm')).status,0);}
 assert.equal((await cli('assets','adopt-database','osv:npm','--license','MIT','--manifest',f.manifest,'--archive',f.db.path,'--confirm')).status,0);
 const trivy=await cli('assets','adopt-database','trivy-checks','--manifest',f.trivyManifest,'--archive',f.checks.path,'--confirm');assert.equal(trivy.status,0);assert.equal(trivy.body.facts.entry.rights.spdx,'MIT');
 const planned=await cli('plan');assert.equal(planned.status,0,JSON.stringify(planned.body));assert.equal(planned.body.facts.label,'deterministic');const id=planned.body.facts.runId;
 assert.equal((await cli('run',id,'--detach')).status,4);const start=await cli('run',id,'--detach','--confirm');assert.deepEqual([start.status,start.body.outcome],[0,'submitted'],JSON.stringify(start.body));
 const joined=await cli('run',id,'--detach','--confirm');assert.equal(joined.body.facts.runId,id);
 const waited=await cli('wait',id);assert.equal(waited.status,2,JSON.stringify(waited.body));assert.equal(waited.body.facts.state,'completed');assert.ok(waited.body.facts.observations>0);assert.equal(waited.body.facts.requiredCoverageComplete,false);
 const report=(await cli('report',id)).body.facts.report;assert.equal(report.schema,'sentinel-scanner-report/draft-1');const adapters=new Set(report.observations.map(o=>o.value.adapter));for(const adapter of ['pattern-semgrep','advisories-osv','iac-trivy','ci-zizmor','secrets-gitleaks'])assert.ok(adapters.has(adapter),adapter);
 // A second genuine installed run changes only the original SQL fixture. Stop only this consumer's service before
 // planning, then replay both retained captures after removing the checkout; no caller report JSON is a baseline.
 await stopOwnService();writeFileSync(join(f.ws,'src/bad.ts'),f.files['src/good.ts']);
 const nextPlan=await cli('plan');assert.equal(nextPlan.status,0,'second installed canonical plan');const nextId=nextPlan.body.facts.runId;assert.notEqual(nextId,id);
 assert.equal((await cli('run',nextId,'--detach','--confirm')).status,0);assert.equal((await cli('wait',nextId)).status,2);
 for(const path of [...Object.keys(f.files),...Object.keys(secretFiles)])rmSync(join(f.ws,path),{force:true});await stopOwnService();
 const regenerated=(await cli('report',id)).body.facts.report;assert.deepEqual(regenerated.observations,report.observations);assert.deepEqual(regenerated.coverage,report.coverage);assert.equal(regenerated.ledgerSequence,report.ledgerSequence);
 // The full report from the installed command alone, with the source deleted and the service stopped: shareable and
 // private offline HTML and the JSON document, each written once to a new file; a second write to a path is refused.
 const delivered=join(realpathSync.native(consumer.scratch),'delivered');mkdirSync(delivered,{mode:0o700});
 const full=await cli('report',id,'--full');assert.equal(full.status,0,JSON.stringify(full.body));assert.equal(full.body.facts.completeness,'partial');assert.ok(full.body.facts.findings>0&&full.body.facts.gaps>0);
 for(const [name,extra] of [['shareable.html',[]],['private.html',['--disclosure','private']],['report.json',['--format','json']],['report.sarif',['--format','sarif']]]){
  const args=['report',id,'--full',...(name.endsWith('.html')?['--format','html']:[]),...extra,'--out',join(delivered,name)];
  assert.equal((await cli(...args)).status,0,name);assert.equal((await cli(...args)).body.reasonCode,'sentinel.report.outExists',name);
 }
 const doc=JSON.parse(readFileSync(join(delivered,'report.json'),'utf8'));assert.equal(doc.schema,'sentinel-report/draft-1');assert.equal(doc.disclosure.profile,'shareable');
 const shareable=readFileSync(join(delivered,'shareable.html'),'utf8');const priv=readFileSync(join(delivered,'private.html'),'utf8');
 for(const name of ['shareable.html','private.html','report.json','report.sarif'])clean(readFileSync(join(delivered,name),'utf8'),name);
 const secretFindings=doc.findings.filter(x=>x.ruleFamilyId.startsWith('sentinel.secrets.'));
 assert.ok(secretFindings.length>=4&&secretFindings.every(x=>x.evidence.every(e=>e.state==='withheld'&&!e.location)),'secret findings are reported, their locations withheld');
 assert.ok(secretFindings.length>new Set(secretFindings.flatMap(x=>x.evidence.map(e=>e.content))).size,'identical bytes in two files stay two findings');
 for(const html of [shareable,priv]){assert.match(html,/Content-Security-Policy/);assert.match(html,/@media print/);assert.doesNotMatch(html,/<script|src="http|href="http|@import/i);}
 // The run has accepted secret matches, so no profile embeds source text, and both say why.
 assert.ok(!shareable.includes('SELECT * FROM users WHERE id = ')&&!priv.includes('SELECT * FROM users WHERE id = '),'no source excerpt while the run has secret matches');
 for(const html of [shareable,priv])assert.match(html,/secret scan matched values in this run/);
 const comparison=await cli('compare',nextId,id);assert.equal(comparison.status,0,'installed retained-capture comparison');
 assert.ok(comparison.body.facts.comparison.current.length>0&&comparison.body.facts.comparison.historical.length>0,'both actual accepted runs contribute comparison evidence');
 const comparedPath=join(delivered,'comparison.json');assert.equal((await cli('compare',nextId,id,'--format','json','--out',comparedPath)).status,0);
 assert.equal((await cli('compare',nextId,id,'--format','json','--out',comparedPath)).body.reasonCode,'sentinel.report.outExists');
 clean(readFileSync(comparedPath,'utf8'),'comparison');const compared=JSON.parse(readFileSync(comparedPath,'utf8'));assert.equal(compared.baseline.reportId,doc.id);
 if(process.env.SENTINEL_SARIF_SCHEMA){
  writeFileSync(join(consumer.dir,'official-sarif.json'),readFileSync(process.env.SENTINEL_SARIF_SCHEMA));
  writeFileSync(join(consumer.dir,'validate-sarif.mjs'),`import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; import {Ajv} from 'ajv';
   const check=new Ajv({strict:false,validateFormats:false,unicodeRegExp:false}).compile(JSON.parse(readFileSync('official-sarif.json','utf8')));
   assert.equal(check(JSON.parse(readFileSync(${JSON.stringify(join(delivered,'report.sarif'))},'utf8'))),true,'actual installed five-engine SARIF fits the official schema');`);
  await consumer.exec(process.execPath,['validate-sarif.mjs']);
 }
 if(process.env.SENTINEL_REPORT_DELIVERY)cpSync(delivered,process.env.SENTINEL_REPORT_DELIVERY,{recursive:true});
 console.log('sentinel scanner consumer ok: npm-only init twice, adoption, exact original packs, missing-asset refusal, owner-receipted tool/database adoption, plan, detach/join/wait through five real pinned containers, retained report after service restart and source removal; full report (five engines, secret values and secret-shaped names absent from every output) written once as shareable and private offline HTML and JSON, plus comparison of two genuine retained captures after source removal, from the installed command alone; incomplete required coverage stays exit 2');
}finally{await stopOwnService();consumer.cleanup();}
