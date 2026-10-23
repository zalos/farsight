// Positive-only native kernel witness. This module never discovers a container, accepts caller paths, reads
// ancestors' counters, invokes a command or changes a grant. isolation.ts supplies its exact-owned inspect PID.
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,statfsSync,watch,type Stats} from 'node:fs';

/** Package-private fault seam; not exported by a package facade. Production always uses these real kernel APIs. */
export const cgroupMemoryIo={closeSync,fstatSync,lstatSync,openSync,readSync,statfsSync,watch,
  now:()=>performance.now(),setTimeout:(callback:()=>void,ms:number)=>setTimeout(callback,ms),clearTimeout:(timer:ReturnType<typeof setTimeout>)=>clearTimeout(timer)};
export const CGROUP_MEMORY_BOUNDS=Object.freeze({bytes:4096,pathBytes:2048,depth:16,attempts:128,burstReads:32,burstMs:50});
const CGROUP2=0x63677270,PROCFS=0x9fa0;
const FLAGS=constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
type Identity={device:string;inode:string};
type Counts={max:bigint;oom:bigint;oom_kill:bigint};
export interface CgroupMemoryEvidence {
  resource:'memory';witness:'cgroup-v2-local';detailKey:'sentinel.execution.memoryWitness.local';
  identity:Identity&{container:string;pid:number;processStart:string;cgroup:string};
  memoryMax:string;baseline:{max:string;oom:string;oom_kill:string};observed:{max:string;oom:string;oom_kill:string};
}
type Phase='notification'|'burst'|'final';
type Check='process'|'named-before'|'held'|'limit'|'read'|'counters'|'named-after'|'gone';
type BurstEnd='positive'|'count'|'time'|'error'|'finish'|'close';
export interface MemoryObservation {
  state:'watching'|'positive'|'unavailable'|'raced'|'exhausted'|'closed';samples:number;attempts:number;reason?:string;
  /** Fixed diagnostic data only; never read by cgroupMemoryFailure or used as affirmative evidence. */
  firstSample?:Readonly<{maxDelta:string;oomDelta:string;oomKillDelta:string}>;
  burst:Readonly<{triggered:boolean;reads:number;endedBy?:BurstEnd}>;
  failure?:Readonly<{phase:Phase;check:Check}>;
}
export interface CgroupMemoryWatch {
  /** Fresh baseline immediately before start. Failure grants no witness, and does not prevent normal execution. */
  arm():void;
  /** One final bounded read before Sentinel asks for any kill, then release every handle. */
  finish():Readonly<CgroupMemoryEvidence>|undefined;
  close():void;
  observation():Readonly<MemoryObservation>;
}
const id=(s:Stats):Identity=>{if(!Number.isSafeInteger(s.dev)||!Number.isSafeInteger(s.ino)||s.dev<0||s.ino<0)throw Error('inexact-kernel-identity');return {device:String(s.dev),inode:String(s.ino)}};
const same=(a:Identity,b:Identity)=>a.device===b.device&&a.inode===b.inode;
const decimal=(v:bigint)=>v.toString();
const counts=(v:Counts)=>Object.freeze({max:decimal(v.max),oom:decimal(v.oom),oom_kill:decimal(v.oom_kill)});
function owned(s:Stats){if(s.uid!==0||(s.mode&0o022)!==0||s.isSymbolicLink())throw Error('untrusted-kernel-object')}
function bounded(fd:number):string {
  const b=Buffer.alloc(CGROUP_MEMORY_BOUNDS.bytes+1),n=cgroupMemoryIo.readSync(fd,b,0,b.length,0);
  if(n<1||n>CGROUP_MEMORY_BOUNDS.bytes)throw Error('kernel-record-bound');
  const text=b.subarray(0,n).toString('utf8');if(!Buffer.from(text).equals(b.subarray(0,n)))throw Error('kernel-record-encoding');return text;
}
function text(path:string):string {
  const fd=cgroupMemoryIo.openSync(path,FLAGS);try{if(!cgroupMemoryIo.fstatSync(fd).isFile())throw Error('kernel-file-type');return bounded(fd)}finally{cgroupMemoryIo.closeSync(fd)}
}
function processIdentity(pid:number):{start:string;cgroup:string}|undefined {
  try{
    const stat=text(`/proc/${pid}/stat`),group=text(`/proc/${pid}/cgroup`),after=text(`/proc/${pid}/stat`),afterGroup=text(`/proc/${pid}/cgroup`);
    const startOf=(s:string)=>{if(!s.startsWith(pid+' ('))throw Error('pid-mismatch');const tick=s.slice(s.lastIndexOf(')')+2).split(' ')[19];if(!tick||!/^\d+$/.test(tick))throw Error('pid-start');return tick};
    const start=startOf(stat);if(start!==startOf(after)||group!==afterGroup)throw Error('pid-changed');
    return {start,cgroup:group};
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error}
}
function localCounts(s:string):Counts {
  const found=new Map<string,bigint>();
  for(const row of s.trimEnd().split('\n')){const m=/^([a-z_]+) ([0-9]+)$/.exec(row);if(!m||found.has(m[1]!))throw Error('counter-record');found.set(m[1]!,BigInt(m[2]!))}
  if(!['max','oom','oom_kill'].every(k=>found.has(k)))throw Error('counter-missing');
  return {max:found.get('max')!,oom:found.get('oom')!,oom_kill:found.get('oom_kill')!};
}

/** Internal data observer, called only after isolation.ts has verified the full container identity and labels. */
export function watchOwnedCgroupMemory(container:string,pid:number,memoryBytes:number):CgroupMemoryWatch {
  let directory:number|undefined,events:number|undefined,maximum:number|undefined,watcher:ReturnType<typeof watch>|undefined;
  let armed=false,closed=false,finishing=false,samples=0,attempts=0,notifications=0,baseline:Counts|undefined,last:Counts|undefined,evidence:Readonly<CgroupMemoryEvidence>|undefined;
  let state:MemoryObservation['state']='unavailable',reason:string|undefined;
  let firstSample:MemoryObservation['firstSample'],failure:MemoryObservation['failure'],check:Check='process';
  let burstUsed=false,burstReads=0,burstUntil=0,burstEnded:BurstEnd|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  function endBurst(why:BurstEnd){
    if(timer!==undefined){cgroupMemoryIo.clearTimeout(timer);timer=undefined}
    if(burstUsed&&burstEnded===undefined)burstEnded=why;
  }
  let association:{start:string;cgroup:string},path:string,chain:Array<{path:string;identity:Identity}>,directoryId:Identity,eventId:Identity,maxId:Identity;
  function close(){
    if(closed)return;closed=true;endBurst('close');try{watcher?.close()}catch{/* no new evidence from a watcher close failure */}watcher=undefined;
    for(const fd of [events,maximum,directory])if(fd!==undefined)try{cgroupMemoryIo.closeSync(fd)}catch{/* no new evidence from a failed close */}
    events=maximum=directory=undefined;if(state==='watching')state='closed';
  }
  function unavailable(error:unknown,phase?:Phase){
    if(closed)return;
    const code=(error as {code?:string}).code;
    if(phase)failure=Object.freeze({phase,check});endBurst('error');
    state=armed&&notifications>0?'raced':'unavailable';reason=code==='ENOENT'||code==='ENODEV'?'kernel-object-gone':'identity-or-read-unavailable';close();
  }
  function verifyProcess(requireLive:boolean){
    const current=processIdentity(pid);
    if(!current){if(requireLive)throw Error('process-gone-before-start');return}
    if(current.start!==association.start||current.cgroup!==association.cgroup)throw Error('pid-reused-or-moved');
  }
  function snapshot(requireLive:boolean):Counts|undefined {
    // Every full attempt is charged, including setup, arm, failure and the final read. No extra final allowance.
    if(attempts>=CGROUP_MEMORY_BOUNDS.attempts){state='exhausted';reason='sample-bound';endBurst('count');close();return}
    attempts++;check='process';verifyProcess(requireLive);
    check='named-before';
    for(const link of chain){const s=cgroupMemoryIo.lstatSync(link.path);owned(s);if(!s.isDirectory()||!same(id(s),link.identity))throw Error('cgroup-path-changed')}
    check='held';if(!same(id(cgroupMemoryIo.fstatSync(directory!)),directoryId))throw Error('held-cgroup-changed');
    for(const [fd,name,expected] of [[events!,'memory.events.local',eventId],[maximum!,'memory.max',maxId]] as const){
      check='held';const held=cgroupMemoryIo.fstatSync(fd);owned(held);
      if(!held.isFile()||!same(id(held),expected))throw Error('cgroup-file-changed');
      check='named-before';const named=cgroupMemoryIo.lstatSync(path+'/'+name);owned(named);
      if(!named.isFile()||!same(id(named),expected))throw Error('cgroup-file-changed');
    }
    check='limit';if(bounded(maximum!).trim()!==String(memoryBytes))throw Error('memory-limit-changed');
    check='read';const raw=bounded(events!);check='counters';const value=localCounts(raw);
    check='process';verifyProcess(requireLive);
    // These post-read named checks remain mandatory: even a good counter read can be discarded by teardown.
    check='named-after';
    for(const link of chain){const s=cgroupMemoryIo.lstatSync(link.path);owned(s);if(!s.isDirectory()||!same(id(s),link.identity))throw Error('cgroup-path-changed')}
    for(const [name,expected] of [['memory.events.local',eventId],['memory.max',maxId]] as const){const s=cgroupMemoryIo.lstatSync(path+'/'+name);owned(s);if(!same(id(s),expected))throw Error('cgroup-file-changed')}
    return value;
  }
  function queueBurst(){
    if(closed||finishing||!armed||!burstUsed||burstEnded!==undefined||timer!==undefined)return;
    if(burstReads>=CGROUP_MEMORY_BOUNDS.burstReads){endBurst('count');return}
    if(cgroupMemoryIo.now()>=burstUntil){endBurst('time');return}
    timer=cgroupMemoryIo.setTimeout(()=>{
      timer=undefined;
      if(closed||finishing||!armed||burstEnded!==undefined)return;
      if(cgroupMemoryIo.now()>=burstUntil){endBurst('time');return}
      sample('burst');queueBurst();
    },1);
  }
  function sample(phase:Phase){
    if(closed||!armed||(finishing&&phase!=='final'))return;
    if(phase==='burst'){
      if(burstReads>=CGROUP_MEMORY_BOUNDS.burstReads||attempts>=CGROUP_MEMORY_BOUNDS.attempts){endBurst('count');return}
      if(cgroupMemoryIo.now()>=burstUntil){endBurst('time');return}
      burstReads++;
    }
    try{
      const value=snapshot(false);if(!value)return;if(phase==='notification')samples++;
      check='counters';
      if(last&&(['max','oom','oom_kill'] as const).some(k=>value[k]<last![k]))throw Error('counter-decreased');last=value;
      // A paced read may itself cross its cooperative time edge. It cannot supply late burst evidence.
      if(phase==='burst'&&cgroupMemoryIo.now()>=burstUntil){endBurst('time');return}
      if(!firstSample)firstSample=Object.freeze({maxDelta:decimal(value.max-baseline!.max),oomDelta:decimal(value.oom-baseline!.oom),oomKillDelta:decimal(value.oom_kill-baseline!.oom_kill)});
      // oom_kill alone also counts global OOM kills. The triple establishes own-limit activity AND an observed
      // OOM kill, not a causally paired local killer and victim. Diagnostics never supply this evidence.
      if(baseline&&value.max>baseline.max&&value.oom>baseline.oom&&value.oom_kill>baseline.oom_kill){
        evidence=Object.freeze({resource:'memory',witness:'cgroup-v2-local',detailKey:'sentinel.execution.memoryWitness.local',
          identity:Object.freeze({...directoryId,container,pid,processStart:association.start,cgroup:path.slice('/sys/fs/cgroup'.length)}),
          memoryMax:String(memoryBytes),baseline:counts(baseline),observed:counts(value)});state='positive';endBurst('positive');close();return;
      }
      if(phase==='notification'&&!burstUsed&&baseline&&value.max>baseline.max){
        burstUsed=true;burstUntil=cgroupMemoryIo.now()+CGROUP_MEMORY_BOUNDS.burstMs;queueBurst();
      }
      if(attempts>=CGROUP_MEMORY_BOUNDS.attempts){state='exhausted';reason='sample-bound';endBurst('count');close()}
    }catch(error){unavailable(error,phase)}
  }
  const result:CgroupMemoryWatch={
    arm(){if(closed||armed)return;try{const value=snapshot(true);if(value){baseline=last=value;armed=true}}catch(error){unavailable(error)}},
    finish(){if(!closed){finishing=true;endBurst('finish');sample('final');close()}return evidence},close,
    observation:()=>Object.freeze({state,samples,attempts,...(reason?{reason}:{}),...(firstSample?{firstSample}:{}),
      burst:Object.freeze({triggered:burstUsed,reads:burstReads,...(burstEnded?{endedBy:burstEnded}:{})}),...(failure?{failure}:{})}),
  };
  try{
    if(!/^[0-9a-f]{64}$/.test(container)||!Number.isSafeInteger(pid)||pid<=0||!Number.isSafeInteger(memoryBytes)||memoryBytes<=0)throw Error('identity-input');
    if(cgroupMemoryIo.statfsSync('/proc').type!==PROCFS||cgroupMemoryIo.statfsSync('/sys/fs/cgroup').type!==CGROUP2)throw Error('kernel-filesystem');
    association=processIdentity(pid)!;if(!association)throw Error('no-owned-pid');
    const lines=association.cgroup.trimEnd().split('\n');if(lines.length!==1||!lines[0]!.startsWith('0::/'))throw Error('not-unified-cgroup');
    const relative=lines[0]!.slice(3),parts=relative.slice(1).split('/');
    if(Buffer.byteLength(relative)>CGROUP_MEMORY_BOUNDS.pathBytes||parts.length>CGROUP_MEMORY_BOUNDS.depth||parts.some(p=>!p||p==='.'||p==='..'||!/^[A-Za-z0-9_.:-]+$/.test(p))
      ||![container,`docker-${container}.scope`].includes(parts.at(-1)!))throw Error('not-exact-container-leaf');
    path='/sys/fs/cgroup'+relative;chain=[];
    let current='/sys/fs/cgroup';
    for(const part of ['',...parts]){if(part)current+='/'+part;const s=cgroupMemoryIo.lstatSync(current);owned(s);if(!s.isDirectory())throw Error('cgroup-directory');chain.push({path:current,identity:id(s)})}
    directory=cgroupMemoryIo.openSync(path,FLAGS|constants.O_DIRECTORY);directoryId=id(cgroupMemoryIo.fstatSync(directory));
    if(!same(directoryId,chain.at(-1)!.identity))throw Error('directory-open-changed');
    events=cgroupMemoryIo.openSync(`/proc/self/fd/${directory}/memory.events.local`,FLAGS);eventId=id(cgroupMemoryIo.fstatSync(events));
    maximum=cgroupMemoryIo.openSync(`/proc/self/fd/${directory}/memory.max`,FLAGS);maxId=id(cgroupMemoryIo.fstatSync(maximum));
    snapshot(true);if(closed)return result;state='watching';
    watcher=cgroupMemoryIo.watch(`/proc/self/fd/${events}`,()=>{if(closed||finishing||!armed)return;notifications++;sample('notification')});
    watcher.on('error',error=>{check='gone';unavailable(error,armed?'notification':undefined)});
  }catch(error){unavailable(error)}
  return result;
}

/** Classification data only. The supervisor supplies its genuine observer and current owned lifecycle facts. */
export function cgroupMemoryFailure(evidence:Readonly<CgroupMemoryEvidence>|undefined, facts:{
  ownerHeld:boolean;aborted:boolean;state:string;code?:string;containerExit?:number|null;clientExit:number|null;clientSignal:NodeJS.Signals|null;
}):Readonly<CgroupMemoryEvidence>|undefined {
  return evidence&&facts.ownerHeld&&!facts.aborted&&facts.state==='failed'&&facts.code==='sentinel.execution.workerExited'
    &&facts.containerExit===137&&facts.clientExit===137&&facts.clientSignal===null?evidence:undefined;
}
