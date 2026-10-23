import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,unlinkSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {ownerFixture,input,timing} from './owner-decision-helpers.ts';
import {acceptedFindingBasisFor,acceptedFindingOf} from '../dist/findings/decision-basis.js';
import {prepareOwnerProposal,appendOwnerDecision} from '../dist/findings/owner-journal.js';
import {ownerContextOf} from '../dist/evidence/owner-context.js';
import {issueReceipt} from '../dist/policy/owner-receipts.js';
import {validateEnvelope} from '../dist/validate.js';
import {fullReport} from '../dist/service/full-report.js';
import {withStoreReadBudget} from '../dist/store/read-budget.js';
async function approved(s:any,finding=s.finding,proposalInput=input()){
 const b=await acceptedFindingBasisFor(s.store,s.ws,s.runId,finding.id,timing()),c=acceptedFindingOf(b).context,p=await prepareOwnerProposal(b,s.ws,proposalInput,new Date());
 await appendOwnerDecision(c,b,s.ws,p,'disposition.propose',new Date());
 const waiting=await appendOwnerDecision(c,b,s.ws,p,'disposition.approve',new Date());assert.ok('binding'in waiting);
 const book=ownerContextOf(c).receipts,receipt=issueReceipt(book,{principal:'human',channel:'owner-cli'},waiting.binding!,{now:new Date(),ttlMs:60000});
 assert.equal((await appendOwnerDecision(c,b,s.ws,p,'disposition.approve',new Date(),receipt.id)).status,'applied');
 return{p,book,receipt};
}
test('unverifiable optional owner audit cannot suppress independently valid current report',{timeout:60000},async t=>{
 const s=await ownerFixture(t),x=await approved(s);
 const files=readdirSync(x.book.directory).filter(f=>f.startsWith(x.receipt.id)&&!f.endsWith('.spent'));assert.ok(files.length);
 unlinkSync(join(x.book.directory,files[0]!));
 for(const disclosure of ['private','shareable'] as const){
  const r=await fullReport({store:s.store,workspace:s.ws.path,trustDir:s.ws.trustDir,runId:s.runId,disclosure,now:new Date()});
  assert.equal(r.document.counts.findings.n,1);assert.equal(r.document.decisions.length,0);
  assert.equal((r.document as any).decisionEvaluation.status,'unavailable');
  assert.equal(validateEnvelope('report',{...r.document,decisionEvaluation:{status:'complete',reasonCode:'sentinel.decision.section.unavailable'}}).ok,false);
  assert.equal(validateEnvelope('report',{...r.document,decisionEvaluation:{status:'unverified',reasonCode:'sentinel.decision.section.unavailable'}}).ok,false);
  assert.equal(validateEnvelope('report',{...r.document,decisionEvaluation:{status:'unavailable',reasonCode:'sentinel.decision.unavailable'}}).ok,false);
  for(const text of [r.json,r.markdown,r.html,JSON.stringify(r.sarif)])assert.ok(text.includes('decision')||text.includes('Decision'));
  assert.doesNotMatch(r.json,new RegExp(x.p.id+'|'+x.p.basisDigest));
 }
});
test('fifty genuine approved findings of one captured source share bounded report proof work',{timeout:240000},async t=>{
 const s=await ownerFixture(t,{findingCount:51});
 for(const f of s.findings.slice(0,50))await approved(s,f);
 const started=performance.now();
 const r=await withStoreReadBudget(s.store,{},()=>fullReport({store:s.store,workspace:s.ws.path,trustDir:s.ws.trustDir,runId:s.runId,disclosure:'private',now:new Date()}));
 assert.equal(r.value.document.decisions.length,50);assert.equal((r.value.document as any).decisionEvaluation.status,'complete');
 assert.ok(r.usage.reads<3000,`actual reads ${r.usage.reads}`);
 t.diagnostic(JSON.stringify({sameSourceApproved:50,elapsedMs:performance.now()-started,usage:r.usage}));
 await approved(s,s.findings[50]);
 const limited=await fullReport({store:s.store,workspace:s.ws.path,trustDir:s.ws.trustDir,runId:s.runId,disclosure:'private',now:new Date()});
 assert.equal(limited.document.decisions.length,50);assert.equal(limited.document.decisionEvaluation?.status,'partial');assert.equal(limited.document.decisionEvaluation?.reasonCode,'sentinel.decision.section.limit');
});

test('pre-spend expired approval keeps its exact typed cause and never claims uncertain publication',{timeout:60000},async t=>{
 const s=await ownerFixture(t),b=await acceptedFindingBasisFor(s.store,s.ws,s.runId,s.finding.id,timing()),c=acceptedFindingOf(b).context;
 const p=await prepareOwnerProposal(b,s.ws,input('accepted-risk',{expiresAt:new Date(Date.now()+1000).toISOString()}),new Date());
 await appendOwnerDecision(c,b,s.ws,p,'disposition.propose',new Date());const receiptDir=ownerContextOf(c).receipts.directory,before=readdirSync(receiptDir).sort();
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1100);s.store.close();
 const r=s.command('decision','approve',p.id,'--confirm');assert.equal(r.value.reasonCode,'sentinel.decision.staleState');assert.equal(r.value.facts.publication,'not-established');
 assert.deepEqual(readdirSync(receiptDir).sort(),before);
});
test('new journal admission refuses wall-clock rollback before any new spend or append',{timeout:60000},async t=>{
 const s=await ownerFixture(t),b=await acceptedFindingBasisFor(s.store,s.ws,s.runId,s.finding.id,timing()),c=acceptedFindingOf(b).context;
 const a=await prepareOwnerProposal(b,s.ws,input(),new Date(Date.now()-3000)),other=await prepareOwnerProposal(b,s.ws,input('deferred'),new Date(Date.now()-3000));
 await appendOwnerDecision(c,b,s.ws,a,'disposition.propose',new Date());
 const {readOwnerHistory}=await import('../dist/findings/owner-journal.js'),head=readOwnerHistory(c).head;
 t.mock.timers.enable({apis:['Date'],now:Date.now()-1000});
 await assert.rejects(appendOwnerDecision(c,b,s.ws,other,'disposition.propose',new Date()),(e:any)=>e.code==='sentinel.decision.staleState');
 assert.equal(readOwnerHistory(c).head,head);
});
test('private library fault after genuine retained append returns delivery failure with readable retained ID',{timeout:60000},async t=>{
 const s=await ownerFixture(t),file=join(s.root,'proposal.json');writeFileSync(file,JSON.stringify(input()));s.store.close();
 const {setOwnerDecisionAppendFailureForTest}=await import('../dist/findings/owner-decision-test-hooks.js');
 const {ownerDecisionCommand}=await import('../dist/findings/owner-cli.js'),{parseArgs}=await import('../dist/cli/args.js');
 const parsed=parseArgs(['decision','propose',s.runId,'--finding',s.finding.id,'--proposal',file,'--json']);assert.ok(parsed.ok);
 setOwnerDecisionAppendFailureForTest(()=>{throw Error('original synthetic delivery fault')});t.after(()=>setOwnerDecisionAppendFailureForTest(undefined));
 let output;try{output=await ownerDecisionCommand(s.ws,parsed.parsed)}finally{setOwnerDecisionAppendFailureForTest(undefined)}
 assert.equal(output.result.outcome,'delivery-failed');assert.equal(output.result.facts.publication,'retained');const id=output.result.facts.decisionId;assert.equal(typeof id,'string');
 assert.equal(s.command('decision','read',id as string).value.outcome,'read');assert.doesNotMatch(JSON.stringify(output),/original synthetic delivery fault/);
});
test('optional decisions never swallow active whole-report read limits or cancellation',{timeout:60000},async t=>{
 const s=await ownerFixture(t);await approved(s);
 await assert.rejects(withStoreReadBudget(s.store,{reads:0},()=>fullReport({store:s.store,workspace:s.ws.path,trustDir:s.ws.trustDir,runId:s.runId,disclosure:'private',now:new Date()})),(e:any)=>e.code==='sentinel.object.tooLarge');
 const c=new AbortController();c.abort();await assert.rejects(withStoreReadBudget(s.store,{signal:c.signal},()=>fullReport({store:s.store,workspace:s.ws.path,trustDir:s.ws.trustDir,runId:s.runId,disclosure:'private',now:new Date()})),(e:any)=>e.code==='sentinel.execution.canceled');
});

test('missing accepted support yields explicit partial section without hiding independently assessed finding',{timeout:60000},async t=>{
 const s=await ownerFixture(t),{acceptReportImportFiles}=await import('../dist/evidence/accept.js');
 const b=await acceptedFindingBasisFor(s.store,s.ws,s.runId,s.finding.id,timing()),c=acceptedFindingOf(b).context,ancestor=acceptedFindingOf(b).record.ancestor;
 const reportPath=join(s.root,'support.json'),manifestPath=join(s.root,'manifest.json');
 writeFileSync(reportPath,JSON.stringify({version:'2.1.0',runs:[{tool:{driver:{name:'original bounded support'}},results:[{ruleId:'original-import',message:{text:'caller-stated imported support'}}]}]}));
 writeFileSync(manifestPath,JSON.stringify({schema:'sentinel-import-manifest/draft-1',format:'sarif-2.1.0',producer:{name:null,version:null},tested:{origins:['https://example.test'],methods:['GET'],properties:['cookie-secure'],directions:['outbound']}}));
 const preview=await acceptReportImportFiles(s.store,s.ws,ancestor,{reportPath,manifestPath},{timing:timing()});assert.ok('binding'in preview);
 const receipt=issueReceipt(ownerContextOf(c).receipts,{principal:'human',channel:'owner-cli'},preview.binding!,{now:new Date(),ttlMs:60000});
 const accepted=await acceptReportImportFiles(s.store,s.ws,ancestor,{reportPath,manifestPath},{timing:timing(),receiptId:receipt.id});assert.ok('candidateDigest'in accepted&&'root'in accepted);
 const x=await approved(s,s.finding,input('accepted-risk',{evidence:[accepted.candidateDigest]}));
 const root=JSON.parse((await s.store.readArtifact(accepted.root as never)).toString('utf8')),{objectRelPath}=await import('../dist/store/objects.js');
 for(const stored of s.store.ledger.objectsOf(root.roles.normalized))unlinkSync(join(s.ws.storePath,objectRelPath(root.roles.normalized.slice(7),stored.codec)));
 const r=await fullReport({store:s.store,workspace:s.ws.path,trustDir:s.ws.trustDir,runId:s.runId,disclosure:'private',now:new Date()});
 assert.equal(r.document.counts.findings.n,1);assert.equal(r.document.decisions.length,0);assert.equal(r.document.decisionEvaluation?.status,'partial');
 for(const text of [r.json,r.markdown,r.html,JSON.stringify(r.sarif)])assert.doesNotMatch(text,new RegExp(x.p.id+'|'+x.p.basisDigest));
});
test('real consumed receipt failure before write is spent and not a publication attempt',{timeout:60000},async t=>{
 const s=await ownerFixture(t);let spentPath='';
 const b=await acceptedFindingBasisFor(s.store,s.ws,s.runId,s.finding.id,{...timing(),stillWithin:()=>{if(spentPath&&existsSync(spentPath))throw Error('original post-spend boundary fault')}}),c=acceptedFindingOf(b).context;
 const p=await prepareOwnerProposal(b,s.ws,input(),new Date());await appendOwnerDecision(c,b,s.ws,p,'disposition.propose',new Date());
 const waiting=await appendOwnerDecision(c,b,s.ws,p,'disposition.approve',new Date());assert.ok('binding'in waiting);
 const receipt=issueReceipt(ownerContextOf(c).receipts,{principal:'human',channel:'owner-cli'},waiting.binding!,{now:new Date(),ttlMs:60000});spentPath=join(ownerContextOf(c).receipts.directory,receipt.id+'.spent');
 const {ownerDecisionFailurePhase,readOwnerHistory}=await import('../dist/findings/owner-journal.js');
 await assert.rejects(appendOwnerDecision(c,b,s.ws,p,'disposition.approve',new Date(),receipt.id),(e:any)=>ownerDecisionFailurePhase(e)==='spent');
 assert.equal(existsSync(spentPath),true);spentPath='';assert.equal(readOwnerHistory(c).approved.has(p.id),false);
});

test('report session requires genuine owner binding and final full history fence',{timeout:60000},async t=>{
 const s=await ownerFixture(t),{findingReadSessionFor,finishFindingReadSession,findingSecretPrivacy}=await import('../dist/findings/decision-basis.js');
 const {readOwnerReportHistory,finishOwnerReportHistory}=await import('../dist/findings/owner-journal.js');
 const session=findingReadSessionFor(s.store,s.ws,timing());
 for(const fake of [{},Object.assign({},session),new Proxy(session,{})])await assert.rejects(acceptedFindingBasisFor(s.store,s.ws,s.runId,s.finding.id,timing(),fake as any));
 const b=await acceptedFindingBasisFor(s.store,s.ws,s.runId,s.finding.id,timing(),session),c=acceptedFindingOf(b).context,h=readOwnerReportHistory(c);
 assert.equal(await findingSecretPrivacy(b,s.ws,undefined,session),false);
 for(const fake of [{},Object.assign({},session),new Proxy(session,{})])await assert.rejects(findingSecretPrivacy(b,s.ws,undefined,fake as any));
 await assert.rejects(findingSecretPrivacy(b,{...s.ws},undefined,session));
 const p=await prepareOwnerProposal(b,s.ws,input(),new Date());await appendOwnerDecision(c,b,s.ws,p,'disposition.propose',new Date());
 assert.throws(()=>finishOwnerReportHistory(h),(e:any)=>e.code==='sentinel.decision.staleState');
 await s.reopen();await assert.rejects(finishFindingReadSession(session));
});

test('malformed optional journal is unavailable without suppressing independently verified current findings',{timeout:60000},async t=>{
 const s=await ownerFixture(t);await approved(s);
 const root=join(s.ws.trustDir,'decisions-v2'),folder=readdirSync(root)[0]!,journal=join(root,folder,readdirSync(join(root,folder)).filter(f=>f.endsWith('.json'))[0]!);
 writeFileSync(journal,'{',{mode:0o600});
 const r=await fullReport({store:s.store,workspace:s.ws.path,trustDir:s.ws.trustDir,runId:s.runId,disclosure:'private',now:new Date()});
 assert.equal(r.document.counts.findings.n,1);assert.equal(r.document.decisions.length,0);assert.equal(r.document.decisionEvaluation?.status,'unavailable');
});

test('a genuinely derived source report rejects invalidated nonopen decision credit', {timeout:60000}, async t=>{
 const s=await ownerFixture(t);await approved(s);
 const r=await fullReport({store:s.store,workspace:s.ws.path,trustDir:s.ws.trustDir,runId:s.runId,disclosure:'private',now:new Date()});
 assert.equal(r.document.decisions[0]!.state,'accepted-risk');assert.equal(validateEnvelope('report',r.document).ok,true);
 for(const validity of ['none','expired','invalidated'] as const){const bad=structuredClone(r.document);bad.decisions[0]!.validity=validity;assert.equal(validateEnvelope('report',bad).ok,false);}
 const open=structuredClone(r.document);open.decisions[0]!.state='open';open.decisions[0]!.validity='invalidated';assert.equal(validateEnvelope('report',open).ok,true);
});

// The body is genuinely captured and hash-read by the retained source proof, never skipped or caller-claimed.
test('report session does not reread a source body already verified by its genuine retained proof',{timeout:60000},async t=>{
 const s=await ownerFixture(t,{paddingBytes:8*1024*1024});await approved(s);s.sourceGone();
 const r=await withStoreReadBudget(s.store,{decodedBytes:12*1024*1024},()=>fullReport({store:s.store,workspace:s.ws.path,trustDir:s.ws.trustDir,runId:s.runId,disclosure:'private',now:new Date()}));
 assert.equal(r.value.document.decisions.length,1);assert.equal(r.value.document.decisionEvaluation?.status,'complete');assert.ok(r.usage.decodedBytes>=8*1024*1024);assert.ok(r.usage.decodedBytes<12*1024*1024);
 t.diagnostic(JSON.stringify({capturedBodyBytes:8*1024*1024,actualReadUsage:r.usage,sourceRemoved:true}));
});
