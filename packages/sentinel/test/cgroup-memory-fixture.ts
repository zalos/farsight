// Explicit confined kernel stand-in: real private files/descriptors, simulated kernel ownership/types/notifications.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {watchOwnedCgroupMemory,cgroupMemoryIo} from '../dist/execution/cgroup-memory.js';
import {scratch} from './snapshot-helpers.ts';
export const ID='a'.repeat(64),PID=4242,LIMIT=67108864,GROUP='/system.slice/docker-'+ID+'.scope';
export const record=(max=0,oom=0,kill=0)=>`low 0\nhigh 0\nmax ${max}\noom ${oom}\noom_kill ${kill}\noom_group_kill 0\n`;
export function kernel(t:any){
 const root=scratch(t,'sentinel-memory-kernel-'),cg=join(root,'cgroup'),leaf=cg+GROUP,proc=join(root,'process');
 fs.mkdirSync(leaf,{recursive:true});fs.mkdirSync(proc);
 const setProcess=(start='77',group=GROUP)=>{fs.writeFileSync(join(proc,'stat'),PID+' (docker-init) '+['S',...Array(18).fill('0'),start,...Array(30).fill('0')].join(' ')+'\n');fs.writeFileSync(join(proc,'cgroup'),'0::'+group+'\n')};setProcess();
 const write=(body:string)=>fs.writeFileSync(join(leaf,'memory.events.local'),body);
 write(record());fs.writeFileSync(join(leaf,'memory.max'),String(LIMIT)+'\n');
 const held=new Map<number,string>(),opened:number[]=[];let callback=()=>{},watchError=(_error:Error)=>{},watchClosed=false,wrongUid=false,watchFailure=false,afterRead:(p:string)=>void=()=>{};
 let eventReads=0,beforeRead=(_path:string)=>{};
 const actual={...cgroupMemoryIo};
 const mapped=(p:any)=>{p=String(p);const fd=/^\/proc\/self\/fd\/(\d+)(.*)$/.exec(p);if(fd){const base=held.get(Number(fd[1]));assert.ok(base,'only an actually held descriptor is referenced');return base+fd[2]}
  if(p==='/sys/fs/cgroup'||p.startsWith('/sys/fs/cgroup/'))return cg+p.slice('/sys/fs/cgroup'.length);
  if(p.startsWith(`/proc/${PID}/`))return proc+p.slice(`/proc/${PID}`.length);
  throw Error('unexpected fixture kernel path '+p)};
 const stat=(s:any,p:string)=>Object.assign(Object.create(Object.getPrototypeOf(s)),s,{uid:wrongUid&&p===leaf?1001:0});
 Object.assign(cgroupMemoryIo,{
  openSync:(p:any,f:number)=>{const path=mapped(p),fd=fs.openSync(path,f);held.set(fd,path);opened.push(fd);return fd},
  closeSync:(fd:number)=>{assert.ok(held.has(fd));held.delete(fd);fs.closeSync(fd)},
  readSync:(fd:number,b:Buffer,off:number,len:number,pos:number)=>{const path=held.get(fd)!;if(path.endsWith('memory.events.local'))eventReads++;beforeRead(path);const n=fs.readSync(fd,b,off,len,pos);afterRead(path);return n},
  fstatSync:(fd:number)=>stat(fs.fstatSync(fd),held.get(fd)!),lstatSync:(p:any)=>{const path=mapped(p);return stat(fs.lstatSync(path),path)},
  statfsSync:(p:any)=>({type:p==='/proc'?0x9fa0:p==='/sys/fs/cgroup'?0x63677270:assert.fail('unexpected statfs')}),

 });
 (cgroupMemoryIo as any).watch=(_path:string,cb:()=>void)=>{if(watchFailure)throw Error('unsupported watcher');callback=cb;const emitter=new EventEmitter() as any;emitter.close=()=>{watchClosed=true};watchError=error=>{emitter.emit('error',error)};return emitter};
 t.after(()=>{Object.assign(cgroupMemoryIo,actual);assert.equal(held.size,0,'every opened kernel descriptor was closed')});
 return {root,cg,leaf,proc,held,opened,write,setProcess,notify:()=>callback(),watchError:(error:Error)=>watchError(error),watchClosed:()=>watchClosed,
  eventReads:()=>eventReads,beforeRead:(f:(p:string)=>void)=>{beforeRead=f},wrongUid:()=>{wrongUid=true},watchFailure:()=>{watchFailure=true},afterRead:(f:(p:string)=>void)=>{afterRead=f},
  start:()=>watchOwnedCgroupMemory(ID,PID,LIMIT)};
}


/** Deterministic paced timer seam. Running callbacks models the real compiled observer, not its algorithm. */
export function pacedClock(t:any){
 const io=cgroupMemoryIo as any,actual={now:io.now,setTimeout:io.setTimeout,clearTimeout:io.clearTimeout};
 let now=0,serial=0,maxPending=0;const pending=new Map<number,()=>void>(),queued:Array<()=>void>=[];
 io.now=()=>now;io.setTimeout=(f:()=>void,delay:number)=>{assert.equal(delay,1);const id=++serial;pending.set(id,f);maxPending=Math.max(maxPending,pending.size);return id};
 io.clearTimeout=(id:number)=>{pending.delete(id)};
 t.after(()=>{for(const [k,v] of Object.entries(actual)){if(v===undefined)delete io[k];else io[k]=v}assert.equal(pending.size,0,'no paced timer remains')});
 return {pending:()=>pending.size,maxPending:()=>maxPending,advance:(ms:number)=>{now+=ms},
  next:(advance=1)=>{const entry=pending.entries().next().value;assert.ok(entry,'one paced read is pending');pending.delete(entry[0]);now+=advance;entry[1]()},
  dequeue:()=>{const entry=pending.entries().next().value;assert.ok(entry);pending.delete(entry[0]);queued.push(entry[1])},runDequeued:()=>{while(queued.length)queued.shift()!()}};
}
