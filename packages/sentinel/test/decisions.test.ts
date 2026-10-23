import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as findingsPublic from '../dist/findings/index.js';
import { DecisionJournal, evaluateDecisions } from '../dist/findings/index.js';
import { approveForOwner } from '../dist/findings/dispositions.js';
import { ReceiptBook, stamp } from '../dist/policy/receipts.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { admit } from '../dist/policy/admission.js';
import { effectivePolicy, DEFAULT_SETTINGS } from '../dist/policy/settings.js';
import { validateEnvelope } from '../dist/validate.js';
import { D, NOW, WORKSPACE, policy, basis, input, actor } from './helpers/decision-fixture.ts';
const CHILD = fileURLToPath(new URL('./helpers/decision-child.ts', import.meta.url));
const later = (ms: number) => new Date(NOW.getTime() + ms);
function fixture(t: {after(fn:()=>void):void}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-decisions-'))); chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const book = new ReceiptBook(join(root, 'receipts')); mkdirSync(book.directory, { mode: 0o700 });
  const journal = new DecisionJournal(join(root, 'decisions'), WORKSPACE, book);
  const proposal = journal.propose(input, basis, actor, NOW);
  const confirm = (id = proposal.disposition.id, now = NOW, ttlMs = 600_000) => issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, journal.approvalBinding(id, policy().revision), { now, ttlMs });
  const apply = (id = proposal.disposition.id, now = NOW) => approveForOwner(journal, id, { policy: policy(), receiptId: confirm(id, now).id, now });
  const open = () => new DecisionJournal(join(root, 'decisions'), WORKSPACE, book);
  return { root, book, journal, proposal, confirm, apply, open };
}
const errorCode = (code: string) => (e: any) => e.code === code;
const evaluation = (decisions: ReturnType<DecisionJournal['approved']>, current = basis, at = stamp(NOW)) => evaluateDecisions(decisions, current, { workspace: WORKSPACE, at });

test('model proposal grants nothing; policy denied and waiting are explicit, owner receipt applies once and survives reopen', t => {
  const f = fixture(t), id = f.proposal.disposition.id;
  assert.equal(f.journal.approved().length, 0);
  assert.equal(approveForOwner(f.journal, id, { policy: policy(false), now: NOW }).outcome, 'denied');
  assert.equal(approveForOwner(f.journal, id, { policy: policy(), now: NOW, confirm: true } as any).outcome, 'awaiting-confirmation');
  const receipt = f.confirm();
  const result = approveForOwner(f.journal, id, { policy: policy(), receiptId: receipt.id, now: NOW });
  assert.equal(result.outcome, 'applied');
  assert.throws(() => approveForOwner(f.journal, id, { policy: policy(), receiptId: receipt.id, now: NOW }), errorCode('sentinel.decision.staleState'));
  assert.equal(f.open().approved()[0]!.disposition.actor.confirmationReceipt, result.outcome === 'applied' && result.decision.disposition.actor.confirmationReceipt);
  assert.deepEqual(evaluation(f.open().approved()).paths.map(p => p.state), ['accepted-risk', 'accepted-risk']);
  assert.equal(f.open().proposals()[0]!.disposition.state, 'proposed', 'approval did not rewrite proposal history');
});

test('untrusted transports cannot approve even if they claim human and have the owner receipt id', t => {
  const f = fixture(t), receipt = f.confirm(), b = f.journal.approvalBinding(f.proposal.disposition.id, policy().revision);
  for (const channel of ['mcp', 'http-bridge', 'model', 'local-service'] as const) {
    const result = admit({ ...b, requestedBy: { principal: 'human', channel }, policy: policy(), receipt: {book:f.book,id:receipt.id}, now:NOW,
      capability:()=>assert.fail('policy must deny first'), credential:()=>assert.fail('policy must deny first') });
    assert.equal(result.record.outcome, 'denied');
  }
  assert.equal(approveForOwner(f.journal, f.proposal.disposition.id, { policy:policy(),receiptId:receipt.id,now:NOW }).outcome, 'applied');
});

test('receipt is exact: another decision, evidence, journal state, policy, workspace or expiry cannot reuse it', t => {
  const f = fixture(t), receipt = f.confirm();
  const other = f.journal.propose({...input,rationale:'Different rationale',evidence:[D('different')]},basis,actor,NOW);
  assert.throws(()=>approveForOwner(f.journal, other.disposition.id, {policy:policy(),receiptId:receipt.id,now:NOW}), errorCode('sentinel.receipt.mismatch'));
  assert.throws(()=>approveForOwner(f.journal, f.proposal.disposition.id, {policy:policy(),receiptId:receipt.id,now:NOW}), errorCode('sentinel.receipt.mismatch'));
  const fresh = f.confirm(), changedPolicy = policy();
  const otherPolicy = effectivePolicy({ trust:'adopted', settings:{...DEFAULT_SETTINGS, grants:[{actions:['disposition.approve'],principals:['human'],confirm:'always'}]},settingsDigest:D('changed-policy'),repoConfig:null,repoConfigDigest:null });
  assert.throws(()=>approveForOwner(f.journal,f.proposal.disposition.id,{policy:otherPolicy,receiptId:fresh.id,now:NOW}),errorCode('sentinel.receipt.mismatch'));
  assert.throws(()=>approveForOwner(f.journal,f.proposal.disposition.id,{policy:{...changedPolicy} as any,receiptId:fresh.id,now:NOW}),errorCode('sentinel.policy.settingsInvalid'));
  assert.throws(()=>approveForOwner(f.journal,f.proposal.disposition.id,{policy:policy(),receiptId:fresh.id,now:later(600_000)}),errorCode('sentinel.receipt.expired'));
  const foreign = new DecisionJournal(join(f.root,'foreign'),D('foreign-workspace'),f.book);
  const p = foreign.propose(input,basis,actor,NOW);
  assert.throws(()=>approveForOwner(foreign,p.disposition.id,{policy:policy(),receiptId:fresh.id,now:NOW}),errorCode('sentinel.receipt.mismatch'));
  assert.equal(f.journal.approved().length,0);
});

test('authentic approval capability rejects spread, clone, proxy and foreign workspace at actual evaluation consumer',t=>{
  const f=fixture(t);f.apply(); const a=f.open().approved()[0]!;
  for(const forged of [{...a}, structuredClone(a),new Proxy(a,{})]) assert.throws(()=>evaluation([forged]),errorCode('sentinel.decision.unauthorized'));
  assert.throws(()=>evaluateDecisions([a],basis,{workspace:D('elsewhere'),at:stamp(NOW)}),errorCode('sentinel.decision.unauthorized'));
  assert.throws(()=>{(a.basis.paths[0] as any).controlDigest=D('changed')},TypeError);
  assert.equal(evaluation(f.open().approved()).paths[0]!.state,'accepted-risk');
});

test('route/control/resolution/framework changes, new bypass and removed surfaces affect only their own path',t=>{
  const f=fixture(t);f.apply();const a=f.open().approved();
  const changes=[['routeDigest','route-changed'],['controlDigest','control-changed'],['resolutionDigest','resolution-changed'],['frameworkDigest','framework-changed'],['resolution','resolution-changed']] as const;
  for(const [field,reason] of changes){const current=structuredClone(basis);(current.paths[0] as any)[field]=field==='resolution'?'partial':D('changed');
    const e=evaluation(a,current);assert.equal(e.paths[0]!.reason,reason);assert.equal(e.paths[0]!.state,'open');assert.equal(e.paths[1]!.state,'accepted-risk');}
  const newRoute=structuredClone(basis);newRoute.paths.push({...basis.paths[0]!,surfaceId:'app::route::GET /bypass',routeDigest:D('bypass')});
  assert.deepEqual(evaluation(a,newRoute).paths.map(p=>p.state),['accepted-risk','accepted-risk','open']);
  const removed={...basis,paths:[basis.paths[1]!]};assert.equal(evaluation(a,removed).paths.length,1);
  for(const [field,reason] of [['environmentDigest','environment-changed'],['deploymentDigest','deployment-changed'],['findingFingerprint','finding-changed'],['sourceId','source-changed']] as const){
    const current={...basis,[field]:field==='sourceId'?'other':D('changed')};assert.ok(evaluation(a,current).paths.every(p=>p.reason===reason));}
  assert.equal(evaluation(a,{...basis,snapshotId:'new-capture'}).paths[0]!.state,'accepted-risk','unchanged scoped dependencies can continue across captures');
});

test('partial approval, supersession, expiry and later approval never retroactively alter pinned historical output',t=>{
  const f=fixture(t), partial=f.journal.propose({...input,surfaceIds:[input.surfaceIds[0]!],decision:'false-positive'},basis,actor,NOW);
  f.apply(partial.disposition.id); const history=f.open().approved(),historical=evaluation(history);const bytes=JSON.stringify(historical);
  assert.deepEqual(historical.paths.map(p=>p.state),['false-positive','open']);
  const replacement=f.journal.propose({...input,surfaceIds:[input.surfaceIds[0]!],supersedes:partial.disposition.id,decision:'deferred'},basis,actor,later(1000));
  f.apply(replacement.disposition.id,later(2000));
  assert.throws(()=>evaluation(history,basis,stamp(later(2000))),errorCode('sentinel.decision.staleState'),'an earlier journal snapshot cannot revive an approval after supersession');
  const today=evaluation(f.open().approved(),basis,stamp(later(2000)));assert.equal(today.paths[0]!.reason,'deferred');
  assert.throws(()=>evaluation([...f.open().approved()].reverse(),basis,stamp(later(2000))),errorCode('sentinel.decision.unauthorized'),'caller selection or order cannot hide a superseding decision');
  assert.equal(evaluation(f.open().approved(),basis,stamp(later(1500))).paths[0]!.state,'false-positive','proposal creation alone does not backdate approval');
  assert.equal(evaluation(f.open().approved(),basis,'2026-10-23T12:00:00.000000000Z').paths[0]!.reason,'expired');
  assert.equal(JSON.stringify(historical),bytes);assert.equal(evaluation(f.open().approved(),basis,stamp(NOW)).paths[0]!.state,'false-positive');
});

test('an owner-approved mitigation and runtime-observed label alone never verify either cookie direction',t=>{
  const f=fixture(t);const assertions=['inbound','outbound'].map((direction,i)=>({id:`cookie-${i}`,trust:'runtime-observed' as const,property:'cookie-integrity' as const,
    direction:direction as 'inbound'|'outbound',surfaceIds:input.surfaceIds,environmentDigest:basis.environmentDigest,deploymentDigest:basis.deploymentDigest,
    controlDigest:basis.paths[0]!.controlDigest,evidence:input.evidence,lastVerifiedAt:stamp(NOW),expiresAt:input.expiresAt}));
  const p=f.journal.propose({...input,decision:'mitigated'},basis,actor,NOW,assertions);f.apply(p.disposition.id);
  assert.ok(evaluation(f.open().approved()).paths.every(p=>p.state==='open'&&p.reason==='assertion-unverified'));
  assert.throws(()=>f.journal.propose({...input,surfaceIds:['app::route::GET /not-in-finding']},basis,actor,NOW));
  assert.throws(()=>f.journal.propose(input,basis,actor,NOW,[{...assertions[0]!,evidence:[D('not-approved')]}]));
});

test('copied approval JSON, removed receipt/spend, swapped record, sequence gap and foreign workspace fail closed on reopen',t=>{
  const f=fixture(t);f.apply();const file=join(f.root,'decisions','000000000002.json'), original=readFileSync(file);
  const v=JSON.parse(original.toString());v.approval.disposition.rationale='fabricated';writeFileSync(file,JSON.stringify(v),{mode:0o600});assert.throws(f.open);writeFileSync(file,original);
  const spent=readdirSync(f.book.directory).find(n=>n.endsWith('.spent'))!;const spentBytes=readFileSync(join(f.book.directory,spent));rmSync(join(f.book.directory,spent));assert.throws(f.open);writeFileSync(join(f.book.directory,spent),spentBytes,{mode:0o600});
  const first=join(f.root,'decisions','000000000001.json'), one=readFileSync(first);rmSync(first);assert.throws(f.open);writeFileSync(first,one,{mode:0o600});
  assert.throws(()=>new DecisionJournal(join(f.root,'decisions'),D('foreign'),f.book));assert.equal(f.open().approved().length,1);
});

test('actual concurrent approvals of two genuine receipts for one head commit exactly once by create-once CAS',async t=>{
  const f=fixture(t),a=f.confirm(),b=f.confirm();
  const run=(receipt:string,own:string)=>new Promise<{out:string;code:number|null}>((resolve,reject)=>{const c=spawn(process.execPath,['--disable-warning=ExperimentalWarning','--experimental-strip-types',CHILD,f.root,f.proposal.disposition.id,receipt,'race',own]);let out='';let err='';c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>err+=d);c.once('error',reject);c.once('close',code=>{if(err)reject(new Error(err));else resolve({out,code})});});
  const outcomes=await Promise.all([run(a.id,'a'),run(b.id,'b')]);assert.equal(outcomes.filter(o=>o.out==='applied').length,1,JSON.stringify(outcomes));
  assert.equal(outcomes.filter(o=>o.out==='sentinel.decision.staleState').length,1,JSON.stringify(outcomes));assert.equal(f.open().approved().length,1);
});

for(const mode of ['before-link','after-link'])test(`real SIGKILL ${mode}: spent receipt cannot be replayed and only a published complete approval survives`,t=>{
  const f=fixture(t),receipt=f.confirm();const child=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--experimental-strip-types',CHILD,f.root,f.proposal.disposition.id,receipt.id,mode],{encoding:'utf8',timeout:20_000});
  assert.equal(child.signal,'SIGKILL',child.stderr);for(let i=0;i<3;i++)assert.equal(f.open().approved().length,mode==='after-link'?1:0);
  if(mode==='before-link')assert.throws(()=>approveForOwner(f.journal,f.proposal.disposition.id,{policy:policy(),receiptId:receipt.id,now:NOW}),errorCode('sentinel.receipt.alreadyUsed'));
  assert.ok(!readdirSync(join(f.root,'decisions')).some(n=>n.startsWith('.')&&mode==='after-link'),'published aliases are recovered');
});

test('failed publication directory fsync never acknowledges approval; repeat reopen failures retain the complete record',t=>{
  const f=fixture(t),receipt=f.confirm(),originalSync=fs.fsyncSync,originalLink=fs.linkSync;let linked=false;
  const journalStat=fs.statSync(join(f.root,'decisions'));
  fs.linkSync=function(a,b){originalLink(a,b);if(String(b)===join(f.root,'decisions','000000000002.json'))linked=true};
  fs.fsyncSync=function(fd){const st=fs.fstatSync(fd);if(linked&&st.isDirectory()&&st.ino===journalStat.ino&&st.dev===journalStat.dev)throw Object.assign(new Error('fixture EIO'),{code:'EIO'});return originalSync(fd)};syncBuiltinESMExports();
  try{assert.throws(()=>approveForOwner(f.journal,f.proposal.disposition.id,{policy:policy(),receiptId:receipt.id,now:NOW}));assert.ok(linked);assert.throws(f.open);assert.throws(f.open)}
  finally{fs.fsyncSync=originalSync;fs.linkSync=originalLink;syncBuiltinESMExports()}
  for(let i=0;i<3;i++)assert.equal(f.open().approved().length,1);
  assert.throws(()=>approveForOwner(f.journal,f.proposal.disposition.id,{policy:policy(),receiptId:receipt.id,now:NOW}),errorCode('sentinel.decision.staleState'));
});

test('invalid mitigation cannot poison the journal or spend a receipt and can be replaced by a valid proposal',t=>{
  const f=fixture(t),p=f.journal.propose({...input,decision:'mitigated',evidence:[]},basis,actor,NOW),r=f.confirm(p.disposition.id);
  assert.throws(()=>approveForOwner(f.journal,p.disposition.id,{policy:policy(),receiptId:r.id,now:NOW}),errorCode('sentinel.decision.invalidInput'));
  assert.ok(!readdirSync(f.book.directory).includes(`${r.id}.spent`));assert.equal(f.open().approved().length,0);
  assert.equal(f.apply().outcome,'applied');assert.equal(f.open().approved().length,1);
});

test('proposal inputs are sealed; malformed and duplicate scopes/assertions never append a journal record',t=>{
  const f=fixture(t),given=structuredClone(input),current=structuredClone(basis),p=f.journal.propose(given,current,actor,NOW);
  given.evidence[0]=D('mutated');current.paths[0]!.controlDigest=D('mutated');assert.equal(p.disposition.evidence[0],input.evidence[0]);assert.equal(p.basis.paths[0]!.controlDigest,basis.paths[0]!.controlDigest);
  const before=readdirSync(join(f.root,'decisions')).length;
  for(const bad of [{...input,surfaceIds:[]},{...input,surfaceIds:[input.surfaceIds[0]!,input.surfaceIds[0]!]},{...input,evidence:['bad']},{...input,expiresAt:'2026-02-30T00:00:00Z'},{...input,who:'human'}])assert.throws(()=>f.journal.propose(bad as any,basis,actor,NOW));
  assert.throws(()=>f.journal.propose(input,{...basis,paths:[basis.paths[0]!,basis.paths[0]!] },actor,NOW));
  assert.equal(readdirSync(join(f.root,'decisions')).length,before);
});

test('canonical route node IDs validate in disposition scope without weakening opaque ledger IDs',t=>{
  const f=fixture(t);assert.equal(validateEnvelope('disposition',f.proposal.disposition).ok,true);
  assert.equal(validateEnvelope('disposition',{...f.proposal.disposition,id:'bad/ledger id'}).ok,false);
});

test('public findings consumers cannot call the owner approval or provenance factories',()=>{
  for(const name of ['approveForOwner','approvedDecisionAuthority','decisionHistoryAuthority','issueReceipt'])assert.equal(name in findingsPublic,false,name);
  assert.equal('approve' in DecisionJournal.prototype,false);
});
