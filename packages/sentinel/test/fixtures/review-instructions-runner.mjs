// Fixed test worker: runs the actual private operation against a local fixture provider; never target code.
import {BudgetLedger,ModelBroker,bindProvider} from '../../dist/review/providers/index.js';
import {createModelReviewOperation,planReviewWork,guidedSpec,prepareInstructions,GUIDED_PROMPT} from '../../dist/review/index.js';
import {trustedPolicy,D,NOW} from '../provider-helpers.ts';
process.once('message',async input=>{let ledger;try{
 const policy=trustedPolicy({ollama:input.origin}),binding=bindProvider(policy,'local-review','review');ledger=await BudgetLedger.open(input.ledger);
 const broker=new ModelBroker({ledger,credentials:async()=>{throw Error('credentials must not be requested')},epoch:input.epoch,now:()=>NOW});
 const envelope=await broker.openEnvelope({binding,policy,runId:input.runId,budget:{maxTokens:100000,maxCost:'0',currency:'USD'},requestedBy:{principal:'human',channel:'owner-cli'},stateDigest:D('instruction-fixture')});
 const spec={...guidedSpec(input.request),instructions:prepareInstructions({prompt:GUIDED_PROMPT,skills:input.skills}),segmentId:'segment-original',requestedSelection:{providerId:binding.providerId,modelId:binding.modelId,bindingDigest:binding.digest}};
 const [unit]=planReviewWork({...input.plan,specs:[spec]});
 const operation=createModelReviewOperation({broker,ledger,envelope,binding:()=>bindProvider(policy,'local-review','review'),now:()=>NOW});
 const result=await operation.run({work:unit.work,spec,attemptId:input.request.attemptId,epoch:input.epoch,read:async id=>{if(!Object.hasOwn(input.contents,id))throw Error('outside captured scope');return Buffer.from(input.contents[id],'base64')}});
 process.send({ok:true,records:result.records,coverage:result.coverage,artifacts:result.privateArtifacts.map(a=>({...a,bytes:Buffer.from(a.bytes).toString('base64')}))},()=>{ledger.close();process.disconnect()});
}catch(e){if(ledger)ledger.close();process.send({ok:false,code:typeof e?.code==='string'?e.code:'bounded-test-failure'},()=>process.disconnect())}});
