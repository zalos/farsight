// Actual npm public APIs and genuine capture, with a mock model only. Not public stage/CLI inference qualification.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { npmConsumer } from './npm-consumer.mjs';
const artifact = resolve(process.argv[2] ?? 'build/sentinel/farsight-sentinel-0.0.0-draft.1.tgz');
const consumer = await npmConsumer('sentinel-instructions-consumer-', [artifact]);
try {
  const script = join(consumer.dir, 'instructions.mjs');
  writeFileSync(
    script,
    `
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';import {createHash} from 'node:crypto';import {join} from 'node:path';
import {openStore} from 'farsight-sentinel/store';import {captureSnapshot} from 'farsight-sentinel/snapshot';
import {prepareInstructions,instructionManifest,renderedInstructions,guidedSpec,GUIDED_PROMPT,runSession,FileCheckpointStore,specDigest} from 'farsight-sentinel/review';
import {validateEnvelope} from 'farsight-sentinel';
const sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex'),root=process.argv[2],source=join(root,'source'),storePath=join(root,'store');mkdirSync(source);const text='export const original = "original captured source";\\n';writeFileSync(join(source,'original.ts'),text);
let store=await openStore(storePath);try{
 const {snapshot}=await captureSnapshot(store,{mode:'working-copy',sources:[{sourceId:'web',repositoryId:'original/fixture',root:source}]});const file=snapshot.entries.find(e=>e.kind==='file'&&e.disposition==='included');assert.ok(file);
 const instructions=prepareInstructions({prompt:GUIDED_PROMPT,skills:[{id:'owner.original',revision:2,text:'Original explicitly selected skill.\\n',resources:[{id:'owner.reference',revision:1,text:'Original reference café <&> \\u0060text\\u0060.\\n'}]}]});
 const spec={...guidedSpec({runId:'run-original',attemptId:'attempt-original',snapshotId:snapshot.id,sourceId:'web',check:{checkId:'check-original',familyId:'original.rule',revisionDigest:sha('original rule'),ruleText:'Original scoped rule.',files:[{relativePath:file.relativePath,content:file.content,bytes:file.bytes}]},limits:{maxSliceLines:10,maxSliceBytes:65536,maxToolCalls:10,maxServedBytes:262144},budget:{maxSteps:4,maxInvalidReplies:1,maxInputBytes:1048576,maxOutputTokens:64,deadlineMs:60000}}),instructions,segmentId:'segment-original'};
 const checkpoints=new FileCheckpointStore(join(root,'checkpoints'));let calls=0;const caller={kind:'mock',async call(req){calls++;assert.equal(req.messages[0].content,renderedInstructions(instructions));const last=JSON.parse(req.messages.at(-1).content);return{content:JSON.stringify(last.evidence?{action:'final',verdict:'no-finding',claims:[],inspected:['original.ts']}:{action:'read',path:'original.ts',startLine:1,endLine:1}),truncated:false,identity:{requestedModel:'mock-only',returnedModel:'mock-only',immutableRevision:null,source:'self-reported'},usage:{inputTokens:1,outputTokens:1}}}};
 const out=await runSession(spec,{caller,checkpoints,read:id=>store.readArtifact(id)});assert.equal(calls,2);assert.equal(out.record.callerKind,'mock');assert.equal(out.record.deterministicCoverage,false);assert.equal(out.record.instructions.digest,instructionManifest(instructions).digest);
 assert.equal(validateEnvelope('review',out.record).ok,true);for(const a of out.privateArtifacts){assert.equal(a.id,sha(a.bytes));if(a.schema==='sentinel-review-request/draft-1')assert.equal(validateEnvelope('reviewrequest',JSON.parse(Buffer.from(a.bytes))).ok,true)}
 rmSync(source,{recursive:true});store.close();store=await openStore(storePath);const replay=await runSession({...spec,attemptId:'attempt-reopened'},{caller:{kind:'mock',call:async()=>{throw Error('settled request must not repeat')}},checkpoints,read:id=>store.readArtifact(id)});assert.equal(calls,2);assert.equal(replay.record.specDigest,out.record.specDigest);assert.deepEqual(replay.record.operations,out.record.operations);
 const changed={...spec,instructions:prepareInstructions({prompt:GUIDED_PROMPT,skills:[{id:'owner.original',revision:3,text:'New instruction requires a new binding.'}]})};assert.notEqual(specDigest(changed),specDigest(spec));await assert.rejects(runSession(changed,{caller,checkpoints,read:id=>store.readArtifact(id)}));
 console.log(JSON.stringify({schema:'sentinel-instructions-consumer/draft-1',npmOnlyRuntime:true,mockModel:true,realInferenceQualified:false,capturedSource:true,exactRenderedBytes:true,retainedRequests:2,sourceRemoved:true,ownerReopened:true,noReplay:true,changedBindingRefused:true,privateArtifactsReturned:true,acceptedPublicationInConsumer:false}));
}finally{if(store.held)store.close()}
`,
  );
  const { stdout } = await consumer.exec(process.execPath, [script, realpathSync.native(consumer.scratch)], {
    cwd: consumer.dir,
    timeout: 120000,
  });
  process.stdout.write(stdout);
  console.log(JSON.stringify({ artifactSha256: createHash('sha256').update(readFileSync(artifact)).digest('hex') }));
} finally {
  consumer.cleanup();
}
