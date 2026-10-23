import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {acceptFixture,imported,report,timing,confirm} from './evidence-acceptance-helpers.ts';
import {publicImportView,renderImportDocument,ownerEvidenceCommand} from '../dist/evidence/owner-cli.js';
import {acceptReportImportFiles} from '../dist/evidence/accept.js';
import {parseArgs} from '../dist/cli/args.js';
import {evidenceIo} from '../dist/evidence/test-hooks.js';
import {openStore} from '../dist/store/index.js';
import {evidenceLedgerFor} from '../dist/store/evidence-binding.js';
import {needsStore} from './snapshot-helpers.ts';

test('review: genuine accepted disclosure requests refuse with a fixed bounded code and no echoed flag value',needsStore,async t=>{
 const s=await acceptFixture(t),accepted=await imported(s);s.store.close();
 for(const action of ['import','read'])for(const value of ['private','shareable','original-private-value']){
  const args=action==='read'?['read',accepted.result.candidateDigest!]:['import',s.ancestor.runId,'--source','app','--report',s.files.reportPath,'--manifest',s.files.manifestPath];
  const r=spawnSync(process.execPath,[new URL('../dist/cli.js',import.meta.url).pathname,'evidence',...args,'--workspace',s.ws.path,'--disclosure',value,'--json'],{encoding:'utf8',env:{...process.env,XDG_STATE_HOME:s.dir+'/owner-state'}});
  assert.equal(r.status,3);assert.equal(JSON.parse(r.stdout).reasonCode,'sentinel.evidence.inputRefused');assert.equal((r.stdout+r.stderr).includes(value),false);
 }
});
test('review: genuine accepted Markdown preserves original data as readable inert code',needsStore,async t=>{
 const s=await acceptFixture(t),original='Original & <tag> > ``` </code><script>original</script>';
 writeFileSync(s.files.reportPath,JSON.stringify({...report,runs:[{...report.runs[0],tool:{driver:{name:original}}}]}));
 const accepted=await imported(s),doc=publicImportView(accepted.result.view!),md=renderImportDocument(doc,'md');
 const lines=md.split('\n'),code=lines.filter(line=>line.startsWith('    '));
 assert.ok(code.length>10,'bounded pretty JSON has readable lines');assert.deepEqual(JSON.parse(code.map(line=>line.slice(4)).join('\n')),doc);
 assert.equal(lines.filter(line=>!line.startsWith('    ')).join('\n').includes('<script>'),false);assert.ok(md.includes(original));assert.match(md,/owner-local/i);assert.equal(doc.disclosure,'owner-local');
 s.store.close();const out=join(s.dir,'actual-roundtrip.md'),r=spawnSync(process.execPath,[new URL('../dist/cli.js',import.meta.url).pathname,'evidence','read',doc.candidateDigest,'--format','md','--out',out,'--workspace',s.ws.path,'--json'],{encoding:'utf8',env:{...process.env,XDG_STATE_HOME:s.dir+'/owner-state'}});assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(readFileSync(out,'utf8').split('\n').filter(line=>line.startsWith('    ')).map(line=>line.slice(4)).join('\n')),doc);
});

test('review: actual executable transfers an exact old-epoch pending operation and accepts its candidate once',needsStore,async t=>{
 const s=await acceptFixture(t),prior=evidenceIo.after;let oldId='',candidate='';
 evidenceIo.after=point=>{if(point==='after-stage')throw Error('original controlled interruption')};
 try{const preview=await acceptReportImportFiles(s.store,s.ws,s.ancestor,s.files,{timing:timing()});assert.equal(preview.status,'awaiting-confirmation');candidate=preview.binding!.intent.input;
  const pending=await acceptReportImportFiles(s.store,s.ws,s.ancestor,s.files,{timing:timing(),receiptId:confirm(s,preview.binding)});assert.equal(pending.status,'spentNotPublished');oldId=(pending as any).operationId;
 }finally{evidenceIo.after=prior;}
 assert.equal(s.store.ledger.listOpenStages(100,{domain:'evidence'}).length,1);s.store.close();
 const r=spawnSync(process.execPath,[new URL('../dist/cli.js',import.meta.url).pathname,'evidence','import',s.ancestor.runId,'--source','app','--report',s.files.reportPath,'--manifest',s.files.manifestPath,'--predecessor',oldId,'--confirm','--json','--workspace',s.ws.path],{encoding:'utf8',timeout:20000,env:{...process.env,XDG_STATE_HOME:s.dir+'/owner-state'}});
 assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).facts.candidateDigest,candidate);
 const store=await openStore(s.ws.storePath);try{const ops=evidenceLedgerFor(store),accepted=ops.acceptance(candidate)!;assert.equal(ops.operation(oldId)!.state,'superseded');assert.notEqual(accepted.operationId,oldId);assert.equal(ops.operation(accepted.operationId)!.state,'accepted');assert.equal(store.ledger.listOpenStages(100,{domain:'evidence'}).length,0);}finally{store.close();}
});

test('review: retained read reports only allowlisted typed causes without exception text or facts',needsStore,async t=>{
 const s=await acceptFixture(t),accepted=await imported(s);s.store.close();const previous=evidenceIo.after;
 for(const code of ['sentinel.execution.deadlineExceeded','sentinel.execution.canceled','sentinel.execution.analysisUnavailable','original-unapproved-code']){
  evidenceIo.after=point=>{if(point==='after-payload-reads')throw Object.assign(Error('original-private-exception'),{code,facts:{reason:'original-private-fact'}})};
  try{const p=parseArgs(['evidence','read',accepted.result.candidateDigest!,'--json']);assert.ok(p.ok);const r=await ownerEvidenceCommand(s.ws,p.parsed);
   assert.equal(r.result.exitCode,3);assert.equal(r.result.facts.cause,code.startsWith('sentinel.execution.')?code:undefined);assert.equal(JSON.stringify(r).includes('original-'),false);
  }finally{evidenceIo.after=previous;}
 }
});
