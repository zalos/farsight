// Diagnostic only: observe the real runner without changing results, limits, masks or owned cleanup.
import { constants as FS, openSync, readSync, closeSync, fstatSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runBounded } from '../../dist/execution/processes.js';
import type { DockerRunner } from '../../dist/execution/isolation.js';
const OWNER = 'org.farsight.sentinel.owner';
export const TRACE_LIMITS = Object.freeze({ bytes: 256 * 1024, records: 256, elapsedMs: 45_000, eventObservers: 1, earlyInspects: 4, eventLines: 64, frameBytes: 16 * 1024, frames: 16, cgroupSnapshots: 20, cgroupWindowMs: 200, cgroupIntervalMs: 10 });
const MAX = TRACE_LIMITS.bytes;
const status = (e: unknown) => (e as { code?: string })?.code ?? 'unavailable';
function boundedText(path: string, max = 16 * 1024): { text?: string; unavailable?: string } {
  let fd: number | undefined;
  try {
    fd = openSync(path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
    const bytes = Buffer.alloc(max + 1); let count = 0;
    while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n; }
    return count > max ? { unavailable: 'byte-limit' } : { text: bytes.subarray(0, count).toString('utf8') };
  } catch (e) { return { unavailable: status(e) }; }
  finally { if (fd !== undefined) closeSync(fd); }
}
const fields = (path: string, names: readonly string[]) => {
  const v = boundedText(path, 64 * 1024);
  return v.text === undefined ? v : Object.fromEntries(v.text.split('\n').flatMap(line => {
    const pair = /^([^:\s]+):?\s+(.*)$/.exec(line); return pair && names.includes(pair[1]!) ? [[pair[1], pair[2]]] : [];
  }));
};
export function hostFacts() {
  return { platform: process.platform, arch: process.arch, kernel: boundedText('/proc/sys/kernel/osrelease'),
    vmstat: fields('/proc/vmstat', ['oom_kill', 'pgmajfault']),
    memory: fields('/proc/meminfo', ['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree']),
    pressure: boundedText('/proc/pressure/memory'), selfCgroup: boundedText('/proc/self/cgroup'),
    dmesgRestrict: boundedText('/proc/sys/kernel/dmesg_restrict'),
    privilegedKernelLog: { unavailable: 'not requested; no elevated monitor' } };
}
const processStart = (value: {text?:string}) => value.text?.slice(value.text.lastIndexOf(')')+2).split(' ')[19];
// A PID can disappear or be reused between inspect and /proc. Never substitute the root or client cgroup.
export function processFacts(pid: number, expected: string, read = boundedText) {
  const base = `/proc/${pid}`, before = read(`${base}/stat`), cg = read(`${base}/cgroup`);
  const path = cg.text?.split('\n').find(line => line.startsWith('0::/'))?.slice(3);
  const exact = /^[0-9a-f]{64}$/.test(expected) && path?.startsWith('/') &&
    path.split('/').every(p => p !== '..' && p !== '.') &&
    path.split('/').some(p => p === expected || p === `docker-${expected}.scope`);
  const identity = { pid, stat: before, cgroup: cg };
  if (!exact || !processStart(before)) return { ...identity, unavailable: 'no stable cgroup-v2 identity naming this exact container' };
  const memory = Object.fromEntries(['memory.events', 'memory.events.local', 'memory.current', 'memory.max'].map(name =>
    [name, read(`/sys/fs/cgroup${path}/${name}`)]));
  const after = read(`${base}/stat`), afterCg = read(`${base}/cgroup`);
  if (processStart(before) !== processStart(after) || cg.text !== afterCg.text) return { ...identity, unavailable: 'PID/cgroup identity changed while sampling' };
  return { ...identity, memory, status: fields(`${base}/status`, ['Name', 'State', 'Pid', 'PPid', 'VmRSS', 'VmPeak', 'Threads']),
    oomScore: read(`${base}/oom_score`), oomScoreAdj: read(`${base}/oom_score_adj`) };
}

// Diagnostic persistence must never replace an original success, failure or assertion with an observer error.
export async function preserveDiagnosticOutcome(save:()=>Promise<void>, note:(message:string)=>void):Promise<void> {
  try { await save(); } catch(error) {
    const e=error as {code?:unknown;name?:unknown};
    const message=JSON.stringify({code:typeof e?.code==='string'?e.code.replace(/[^\x20-\x7e]/g,'?').slice(0,80):'unavailable',name:typeof e?.name==='string'?e.name.replace(/[^\x20-\x7e]/g,'?').slice(0,80):'Error'});
    try { note(message.slice(0,256)); } catch { /* even a failed diagnostic logger cannot replace the outcome */ }
  }
}

// A persistent parent is useful across child removal only when its identity comes from a live known process.
// The daemon PID file and dockerd comm/start/cgroup are checked twice; no guessed system.slice/root path is used.
function knownDaemonParent() {
  const raw=boundedText('/run/docker.pid',64).text?.trim();
  if(!raw||!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<1)return {unavailable:'no exact daemon PID file'} as const;
  const pid=Number(raw),base=`/proc/${pid}`,before=boundedText(`${base}/stat`),cg=boundedText(`${base}/cgroup`);
  if(boundedText(`${base}/comm`,64).text?.trim()!=='dockerd'||!processStart(before))return {unavailable:'daemon PID identity unavailable'} as const;
  const path=cg.text?.split('\n').find(line=>line.startsWith('0::/'))?.slice(3);
  if(!path?.startsWith('/')||path.split('/').some(p=>p==='..'||p==='.')||!path.includes('/'))return {unavailable:'daemon cgroup identity unavailable'} as const;
  const parent=path.slice(0,path.lastIndexOf('/'));
  if(!parent||parent==='/')return {unavailable:'known daemon has no non-root parent with memory counters'} as const;
  let fd:number|undefined;
  try {
    fd=openSync(`/sys/fs/cgroup${parent}`,FS.O_RDONLY|FS.O_DIRECTORY|FS.O_NOFOLLOW|FS.O_NONBLOCK);
    const held=fstatSync(fd,{bigint:true}),named=lstatSync(`/sys/fs/cgroup${parent}`,{bigint:true});
    if(!held.isDirectory()||held.dev!==named.dev||held.ino!==named.ino||
      processStart(before)!==processStart(boundedText(`${base}/stat`))||cg.text!==boundedText(`${base}/cgroup`).text||
      boundedText(`${base}/comm`,64).text?.trim()!=='dockerd')return {unavailable:'daemon/parent identity changed while opening'} as const;
    const accepted=fd;fd=undefined;
    return {fd:accepted,pid,daemonCgroup:path,parent,device:String(held.dev),inode:String(held.ino),
      scope:'parent of the observed daemon cgroup only; concurrent activity is not attributable to this container'} as const;
  }catch(error){return {unavailable:status(error)} as const}
  finally{if(fd!==undefined)closeSync(fd)}
}

// Trusted CI-host diagnosis only. These filtered, unprivileged observations never establish absence.
type CommandAnswer = Awaited<ReturnType<typeof runBounded>>;
export function journalArguments(kind: 'kernel' | 'oomd', since: string, until: string, containerId: string): string[] {
  if (!/^[0-9a-f]{64}$/.test(containerId) || !Number.isFinite(Date.parse(since)) || !Number.isFinite(Date.parse(until)))
    throw Error('diagnostic query identity invalid');
  return [...(kind === 'kernel' ? ['--dmesg', '--boot'] : ['--unit=systemd-oomd.service', '--boot']),
    '--no-pager', '--output=short-monotonic', '--since', since, '--until', until, '--lines=128', `--grep=${containerId}`];
}
export function classifyJournal(answer: CommandAnswer) {
  const stdout = answer.stdout.toString('utf8'), stderr = answer.stderr.toString('utf8');
  const intact = !answer.spawnError && !answer.timedOut && !answer.canceled && !answer.exitSignal &&
    !answer.stdoutExceeded && !answer.stderrExceeded;
  const classification = intact && answer.exitCode === 0 ? 'matched' :
    intact && answer.exitCode === 1 && /^-- No entries --\r?\n?$/.test(stdout) && stderr === '' ? 'no-match-visible' : 'unavailable';
  return { classification, status: answer.exitCode, signal: answer.exitSignal, spawnError: answer.spawnError,
    timedOut: answer.timedOut, canceled: answer.canceled, truncated: answer.stdoutExceeded || answer.stderrExceeded,
    visibility: 'unprivileged visibility only; no-match-visible is not proof no kill occurred',
    permissionLimited: /permission|not seeing|access denied/i.test(stderr), stdout, stderr };
}
async function queryJournal(kind: 'kernel' | 'oomd', since: string, until: string, id: string, run = runBounded) {
  const argv = journalArguments(kind, since, until, id);
  return { argv, ...classifyJournal(await run('/usr/bin/journalctl', argv,
    { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeoutMs: 1000, maxStdoutBytes: 8192, maxStderrBytes: 2048 })) };
}
// Execute the SAME argv on the actual runner before canaries. Unknown failures are not silently accepted as
// missing visibility: only recognized permission/journal-availability failures can pass this syntax preflight.
export async function preflightJournalQueries(run = runBounded) {
  const until = new Date().toISOString(), since = new Date(Date.now() - 1000).toISOString();
  const results = await Promise.all((['kernel', 'oomd'] as const).map(kind => queryJournal(kind, since, until, '0'.repeat(64), run)));
  for (const result of results) {
    if (/unrecognized|unknown option|invalid option|invalid argument|requires an argument|failed to parse/i.test(result.stderr))
      throw Object.assign(Error('diagnostic journal argv preflight failed'), { journal: results });
    const visibilityOnly = result.classification === 'unavailable' && result.status === 1 && !result.signal &&
      !result.spawnError && !result.timedOut && !result.canceled && !result.truncated &&
      /permission|not seeing|access denied|no journal files were found|failed to open.*journal.*no such file/i.test(result.stderr) &&
      !/unrecognized|unknown option|invalid option|invalid argument|requires an argument|failed to parse/i.test(result.stderr);
    if (result.classification === 'unavailable' && !visibilityOnly) throw Object.assign(Error('diagnostic journal argv preflight failed'), { journal: results });
  }
  return results;
}
export async function diagnosticProvenance() {
  if (process.platform !== 'linux') throw Error('diagnostic preflight requires native Linux');
  const env = { PATH: '/usr/bin:/bin', LANG: 'C' };
  const docker = await runBounded('/usr/bin/docker', ['version', '--format', '{{json .}}'],
    { env, timeoutMs: 5000, maxStdoutBytes: 32 * 1024, maxStderrBytes: 2048 });
  const kernel = boundedText('/proc/sys/kernel/osrelease', 256);
  if (docker.exitCode !== 0 || docker.spawnError || docker.timedOut || docker.canceled || docker.stdoutExceeded || docker.stderrExceeded || !kernel.text)
    throw Error('diagnostic runtime provenance unavailable');
  const version = JSON.parse(docker.stdout.toString('utf8'));
  const components = version.Server?.Components;
  if (!version.Client?.Version || !version.Server?.Version || !Array.isArray(components) ||
      !['containerd', 'runc'].every(name => components.some(c => c.Name === name && typeof c.Version === 'string')))
    throw Error('diagnostic runtime component provenance unavailable');
  const image = Object.fromEntries(['ImageOS', 'ImageVersion'].map(name => {
    const value = process.env[name];
    if (!value || Buffer.byteLength(value) > 256) throw Error('diagnostic runner image provenance unavailable');
    return [name, value];
  }));
  return { image, kernel, docker: version, journal: await preflightJournalQueries(),
    scope: 'runner identity and unprivileged visibility preflight only; no termination attribution' };
}
async function kernelFacts(since: string, until: string, containerId: string) {
  return { since, until, exactContainerFilter: containerId, unprivileged: true,
    kernel: await queryJournal('kernel', since, until, containerId), oomd: await queryJournal('oomd', since, until, containerId) };
}
export function diagnosticRunner(real: DockerRunner) {
  const started = performance.now(), startedAt = new Date().toISOString(); let bytes = 0, dropped = 0, id = '', pid = 0;
  const records: Array<{atMs:number;type:string;value:any}> = [];
  const eventTasks: Promise<unknown>[] = [], probes: Promise<void>[] = [];
  let sampledCgroup = false;
  let daemonParent:ReturnType<typeof knownDaemonParent>|undefined;
  const releaseParent=()=>{if(daemonParent&&'fd' in daemonParent){const fd=daemonParent.fd;daemonParent={unavailable:'observer descriptor released'};try{closeSync(fd)}catch{}}};
  const parentFacts=()=>{
    if(!daemonParent||!('fd' in daemonParent))return daemonParent??{unavailable:'no observed daemon parent'};
    try{const held=fstatSync(daemonParent.fd,{bigint:true});if(String(held.dev)!==daemonParent.device||String(held.ino)!==daemonParent.inode)return {unavailable:'held daemon parent identity changed'};
      const {fd,...identity}=daemonParent;return {...identity,memory:Object.fromEntries(['memory.events','memory.events.local','memory.current','memory.max'].map(name=>[name,boundedText(`/proc/self/fd/${fd}/${name}`)]))};
    }catch(error){return {unavailable:status(error)}}
  };
  const observer = new AbortController(); let owner = '', labels: Record<string,string> = {}, finished: Promise<unknown> | undefined;
  const streams = { stdoutBytes: 0, stderrBytes: 0, stdinBytes: 0, stdoutFrames: 0, stdinFrames: 0, helloSeen: false, startSent: false };
  const timer=setTimeout(()=>{observer.abort();releaseParent()}, TRACE_LIMITS.elapsedMs); timer.unref();
  const record = (type: string, value: unknown) => {
    const item = { atMs: Math.round(performance.now() - started), type, value };
    const size = Buffer.byteLength(JSON.stringify(item));
    if (performance.now()-started > TRACE_LIMITS.elapsedMs || bytes + size > MAX || records.length >= TRACE_LIMITS.records) { dropped++; return; }
    bytes += size; records.push(item);
  };
  const command = (args: readonly string[]) => args.map(arg => arg.length <= 200 ? arg :
    { bytes: Buffer.byteLength(arg), sha256: createHash('sha256').update(arg).digest('hex') });
  const result = (answer: any) => ({ exitCode: answer.exitCode, exitSignal: answer.exitSignal,
    canceled: answer.canceled, timedOut: answer.timedOut, spawnError: answer.spawnError,
    stdoutBytes: answer.stdout.length, stderrBytes: answer.stderr.length,
    stdoutExceeded: answer.stdoutExceeded, stderrExceeded: answer.stderrExceeded });
  // Keep the exact original cgroup directory open across the short exit window. A vanished PID never switches
  // this observer to a reused PID, enclosing group or root counters. Missing kernel files stay unavailable.
  const sampleCgroup = (observed: ReturnType<typeof processFacts>) => {
    if (sampledCgroup || observer.signal.aborted || observed.unavailable) return;
    sampledCgroup = true;
    const path = observed.cgroup.text!.split('\n').find(line=>line.startsWith('0::/'))!.slice(3);
    let fd: number | undefined;
    try {
      fd = openSync(`/sys/fs/cgroup${path}`, FS.O_RDONLY|FS.O_DIRECTORY|FS.O_NOFOLLOW|FS.O_NONBLOCK);
      const directory = fstatSync(fd,{bigint:true}), named = lstatSync(`/sys/fs/cgroup${path}`,{bigint:true});
      const checked = processFacts(observed.pid,id);
      if (!directory.isDirectory() || directory.dev!==named.dev || directory.ino!==named.ino || checked.unavailable ||
        checked.cgroup.text!==observed.cgroup.text || processStart(checked.stat)!==processStart(observed.stat)) {
        record('cgroup-window-unavailable','PID/cgroup identity changed while opening directory');return;
      }
      const held = fd;fd=undefined;
      const identity={device:String(directory.dev),inode:String(directory.ino)}, sampleStarted=performance.now();
      probes.push((async()=>{
        try {
          for(let i=0;i<TRACE_LIMITS.cgroupSnapshots && !observer.signal.aborted && performance.now()-sampleStarted<TRACE_LIMITS.cgroupWindowMs;i++){
            const current=fstatSync(held,{bigint:true});
            if(current.dev!==directory.dev||current.ino!==directory.ino){record('cgroup-window-unavailable','held directory identity changed');break}
            const memory=Object.fromEntries(['memory.events','memory.events.local','memory.current','memory.max'].map(name=>
              [name,boundedText(`/proc/self/fd/${held}/${name}`)]));
            record('owned-cgroup-window',{id,pid:observed.pid,path,identity,snapshot:i,atWindowMs:Math.round(performance.now()-sampleStarted),memory});
            await new Promise(resolve=>setTimeout(resolve,Math.min(TRACE_LIMITS.cgroupIntervalMs,Math.max(0,TRACE_LIMITS.cgroupWindowMs-(performance.now()-sampleStarted)))));
          }
        }catch(error){record('cgroup-window-unavailable',status(error))}
        finally{closeSync(held)}
      })());
    }catch(error){record('cgroup-window-unavailable',status(error))}
    finally{if(fd!==undefined)closeSync(fd)}
  };
  const inspect = (args: readonly string[], answer: any, purpose: string) => {
    if (performance.now()-started>=TRACE_LIMITS.elapsedMs) return;
    if (args[0] !== 'inspect' || !args.includes('--format') || answer.exitCode !== 0) return;
    let c: any; try { c = JSON.parse(answer.stdout.toString('utf8')); } catch { record('inspect-unreadable', purpose); return; }
    if (!id || c.Id !== id || !owner || Object.entries(labels).some(([key,value])=>c.Config?.Labels?.[key]!==value)) { record('foreign-inspect', { purpose, id: c.Id }); return; }
    if (Number.isInteger(c.State?.Pid) && c.State.Pid > 0) pid = c.State.Pid;
    record('raw-inspect', { purpose, id: c.Id, image: c.Image, state: c.State,
      limits: { memory: c.HostConfig?.Memory, memorySwap: c.HostConfig?.MemorySwap, pids: c.HostConfig?.PidsLimit,
        nanoCpus: c.HostConfig?.NanoCpus, network: c.HostConfig?.NetworkMode }, labels: c.Config?.Labels });
    if (pid > 0) { const observed=processFacts(pid,c.Id);record('container-host-facts',observed);sampleCgroup(observed); }
  };
  const runner: DockerRunner = {
    run: async (args, signal) => {
      record('command-begin', command(args));
      if (args[0] === 'create' && !owner && !observer.signal.aborted) {
        record('host-before-create', hostFacts());
        daemonParent=knownDaemonParent();record('known-daemon-parent-before-create',parentFacts());
        const label = args.find(arg => arg.startsWith(`${OWNER}=`));
        if (label) {
          owner=label.slice(OWNER.length+1);
          labels=Object.fromEntries(args.filter(arg=>arg.startsWith('org.farsight.sentinel.')&&arg.includes('=')).map(arg=>{const i=arg.indexOf('=');return [arg.slice(0,i),arg.slice(i+1)]}));
          // Start the bounded listener before create; --since also covers events before subscription finishes.
          const since = startedAt, until = new Date(Date.now() + TRACE_LIMITS.elapsedMs).toISOString();
          const task = real.run(['events', '--since', since, '--until', until, '--filter', `label=${label}`, '--format', '{{json .}}'], observer.signal)
            .then(answer => ({ bounds: { since, until, maxReturnedBytes: 4 * 1024 * 1024 }, result: result(answer),
              events: answer.stdout.toString('utf8').split('\n').filter(Boolean).slice(0, TRACE_LIMITS.eventLines).map(line => {
                try { const e = JSON.parse(line); if (!id || e.Actor?.ID!==id || e.Actor?.Attributes?.[OWNER]!==owner) return { excluded: 'not exact owned container' };
                return { id: e.Actor?.ID, action: e.Action, timeNano: e.timeNano,
                  signal: e.Actor?.Attributes?.signal, exitCode: e.Actor?.Attributes?.exitCode }; }
                catch { return { malformed: true }; }
              }) })).catch(e => ({ unavailable: status(e) }));
          eventTasks.push(task);
        } else record('events-unavailable', 'create had no exact owner label');
      }
      if (args[0] === 'rm' && id && args.includes(id) && performance.now()-started<TRACE_LIMITS.elapsedMs) {
        record('host-before-owned-remove', hostFacts());
        record('process-before-owned-remove', pid > 0 ? processFacts(pid, id) : { unavailable: 'no running PID observed' });
      }
      let answer;
      try { answer = await real.run(args, signal); } catch (error) { record('command-error', {command:args[0],status:status(error)}); throw error; }
      record('command-end', { command: args[0], ...result(answer) });
      if (args[0] === 'create' && !id && /^[0-9a-f]{64}$/.test(answer.stdout.toString('utf8').trim())) id = answer.stdout.toString('utf8').trim();
      inspect(args, answer, 'production-before-any-mask');
      return answer;
    },
    runSync: args => { record('sync-command-begin', command(args)); const answer = real.runSync(args); record('sync-command-end', result(answer)); return answer; },
    start: container => {
      if(performance.now()-started>=TRACE_LIMITS.elapsedMs)return real.start(container);
      record('start-attached', { id: container, exactOwned: Boolean(owner)&&container===id });
      const proc = real.start(container);
      record('docker-client', { pid: proc.child.pid, spawnfile: proc.child.spawnfile, args: proc.child.spawnargs });
      if (proc.child.pid) record('client-host-facts', processFacts(proc.child.pid, container));
      // Observe existing emissions, never add a data listener or switch a stream into flowing mode.
      const watch=(direction: 'stdout'|'stdin', chunk: any)=>{
        if(performance.now()-started>=TRACE_LIMITS.elapsedMs)return;
        const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk); streams[`${direction}Bytes`]+=b.length;
        let state=frameState[direction];
        if(state.seen>=TRACE_LIMITS.frameBytes)return;
        const keep=b.subarray(0,TRACE_LIMITS.frameBytes-state.seen);state.seen+=keep.length;state.pending+=keep.toString('utf8');
        for(let nl;(nl=state.pending.indexOf('\n'))>=0;){
          const line=state.pending.slice(0,nl);state.pending=state.pending.slice(nl+1);streams[`${direction}Frames`]++;
          if(streams[`${direction}Frames`]>TRACE_LIMITS.frames)continue;
          let type='unreadable';try{const value=JSON.parse(line);type=typeof value.type==='string'?value.type.slice(0,32):'missing'}catch{}
          if(direction==='stdout'&&type==='hello')streams.helloSeen=true;
          if(direction==='stdin'&&type==='start')streams.startSent=true;
          record('frame-observed',{direction,type,bytes:Buffer.byteLength(line)+1});
        }
      };
      const frameState={stdout:{seen:0,pending:''},stdin:{seen:0,pending:''}};
      for(const direction of ['stdout','stderr'] as const){
        const stream=proc.child[direction],emit=stream.emit;
        stream.emit=function(event: string|symbol,...args: any[]){
          if(event==='data'){if(direction==='stdout')watch('stdout',args[0]);else streams.stderrBytes+=Buffer.byteLength(args[0])}
          return Reflect.apply(emit,this,[event,...args]);
        };
      }
      const write=proc.child.stdin.write;
      proc.child.stdin.write=function(...args: any[]){watch('stdin',args[0]);return Reflect.apply(write,this,args)} as typeof write;
      const kill = proc.child.kill.bind(proc.child);
      proc.child.kill = (signal?: any) => { record('actual-client-kill', { signal: signal ?? 'SIGTERM', exitCode: proc.child.exitCode, signalCode: proc.child.signalCode }); return kill(signal); };
      proc.child.once('exit', (code, signal) => record('client-exit', { code, signal }));
      proc.child.once('close', (code, signal) => record('client-close', { code, signal }));
      proc.child.stdout.once('end', () => record('client-stdout-end', {}));
      proc.child.stderr.once('end', () => record('client-stderr-end', {}));
      const end = proc.child.stdin.end.bind(proc.child.stdin);
      proc.child.stdin.end = (...args: any[]) => { record('client-stdin-end', { exitCode: proc.child.exitCode, signalCode: proc.child.signalCode }); return (end as any)(...args); };
      // A small independent early sample, never returned to state() or counted as delayed-mask observations.
      probes.push((async () => {
        for (let i = 0; i < TRACE_LIMITS.earlyInspects && container===id && owner && !observer.signal.aborted; i++) {
          const args = ['inspect', '--type', 'container', '--format', '{{json .}}', container];
          try { const answer = await real.run(args, AbortSignal.any([observer.signal,AbortSignal.timeout(1000)])); inspect(args, answer, 'diagnostic-early-sample'); }
          catch (e) { record('early-sample-unavailable', status(e)); }
          if (pid > 0) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      })());
      return { ...proc, kill: () => { record('worker-process-kill-request', { exitCode: proc.child.exitCode, signalCode: proc.child.signalCode }); proc.kill(); } };
    },
  };
  return { runner, finish() {
    return finished??=(async()=>{
    clearTimeout(timer);record('event-observer-stop-request',{reason:'attempt settled; stop diagnostic client only'});observer.abort();
    try{await Promise.all(probes)}catch(error){record('probe-unavailable',status(error))}
    for (const task of eventTasks) record('bounded-daemon-events', await task);
    if(performance.now()-started<TRACE_LIMITS.elapsedMs){record('host-after-cleanup', hostFacts());record('known-daemon-parent-after-cleanup',parentFacts())}
    releaseParent();
    if(owner&&id&&performance.now()-started<TRACE_LIMITS.elapsedMs-3000){
      const until=new Date().toISOString();
      try{const answer=await real.run(['events','--since',startedAt,'--until',until,'--filter',`container=${id}`,'--filter',`label=${OWNER}=${owner}`,'--format','{{json .}}'],AbortSignal.timeout(1000));
        const events=answer.stdout.toString('utf8').split('\n').filter(Boolean).slice(0,TRACE_LIMITS.eventLines).flatMap(line=>{try{const e=JSON.parse(line);return e.Actor?.ID===id&&e.Actor?.Attributes?.[OWNER]===owner?[{action:e.Action,timeNano:e.timeNano,signal:e.Actor?.Attributes?.signal,exitCode:e.Actor?.Attributes?.exitCode}]:[]}catch{return [{malformed:true}]}});
        record('bounded-daemon-event-history',{result:result(answer),events});
      }catch(e){record('event-history-unavailable',status(e))}
      record('filtered-host-kernel',await kernelFacts(startedAt,new Date().toISOString(),id));
    }
    const phase=(type:string,predicate:(value:any)=>boolean=()=>true)=>records.find(r=>r.type===type&&predicate(r.value))?.atMs??null;
    return { startedAt, finishedAt: new Date().toISOString(), records, dropped, bytes, limits: TRACE_LIMITS,
      phaseMs: { create:phase('command-begin',a=>a[0]==='create'), attached:phase('start-attached'),
        hello:phase('frame-observed',v=>v.direction==='stdout'&&v.type==='hello'),
        start:phase('frame-observed',v=>v.direction==='stdin'&&v.type==='start'), clientExit:phase('client-exit'),
        remove:phase('command-begin',a=>a[0]==='rm'), finish:Math.round(performance.now()-started) },
      observationExpired:performance.now()-started>=TRACE_LIMITS.elapsedMs, containerId: id, ownershipLabels: labels, streams };
    })();
  } };
}
