// Fixed external Copilot distribution. The native launcher alone does not pin its extracted JavaScript/native modules.
// No vendor bytes are distributed by Sentinel; a bounded verified copy supplies one exact private runtime.
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,lstat,realpath,opendir,mkdtemp,mkdir,chmod,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute,join,dirname,relative} from 'node:path';
import {COPILOT_CODE_MANIFEST} from './cli-copilot-manifest.js';
import {canonicalDigest} from '../../policy/digest.js';
import {fail,ProviderError} from './errors.js';
import type {NativeTiming} from './cli-native-profile.js';
export const COPILOT_NATIVE_PROFILE=Object.freeze({id:'copilot-1.0.103-darwin-arm64-seatbelt-v1',version:'1.0.103',model:'gpt-6-luna',
 executableDigest:'sha256:1c81150e4bd7805c8470f4718bc8cb3c3a20c2379086f36309f7ae823e32ace6',executableBytes:181807712,
 runtimeDigest:'sha256:3d0df03e4145ef5a61c6e208cc4c80c6e56159a87b078b49ff2c91607397cc41',runtimeBytes:212717731,runtimeFiles:265,
 auth:'vendor-native-keychain',wire:'sentinel-copilot-chat/v1',softAiCredits:30,contextReservation:272000});
export interface NativeCopilotRuntime {readonly profileId:string;readonly executableDigest:string;readonly runtimeDigest:string;readonly profileDigest:string}
interface FileIdentity {dev:number;ino:number;size:number;mtimeMs:number}
interface Member {path:string;bytes:number;digest:string}
const runtimes=new WeakMap<object,{executable:string;runtimeDir:string;identity:FileIdentity}>(),setups=new WeakMap<object,string>();
const q=(s:string)=>JSON.stringify(s);
const expectedMembers=new Map(COPILOT_CODE_MANIFEST.map(row=>[row.path,row]));
const expectedDirectories=new Set(COPILOT_CODE_MANIFEST.flatMap(row=>{const parts=row.path.split('/');return parts.slice(0,-1).map((_,i)=>parts.slice(0,i+1).join('/'))}));
export function copilotBoundary(t:NativeTiming){if(t.signal?.aborted)fail('sentinel.provider.canceled','Copilot setup canceled');if(!Number.isSafeInteger(t.deadlineAt)||Date.now()>=t.deadlineAt)fail('sentinel.provider.timeout','original Copilot deadline elapsed')}
const same=(a:FileIdentity,b:FileIdentity)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs;
async function checkedRoot(path:string){if(!isAbsolute(path)||(await realpath(path))!==path)fail('sentinel.provider.capabilityUntested','Copilot runtime path is not exact');const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink())fail('sentinel.provider.capabilityUntested','Copilot runtime directory refused');return s}
async function readMember(path:string,t:NativeTiming,ceiling:number,copyTo?:string){
 copilotBoundary(t);const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let out:Awaited<ReturnType<typeof open>>|undefined;
 try{const before=await f.stat();if(!before.isFile()||before.size>ceiling||before.nlink!==1)fail('sentinel.provider.capabilityUntested','Copilot code member bounds');if(copyTo)out=await open(copyTo,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o400);
  const hash=createHash('sha256'),buf=Buffer.alloc(1048576);let at=0;while(at<before.size){copilotBoundary(t);const {bytesRead}=await f.read(buf,0,Math.min(buf.length,before.size-at),at);if(!bytesRead)fail('sentinel.provider.capabilityUntested','Copilot code member ended early');hash.update(buf.subarray(0,bytesRead));if(out){let written=0;while(written<bytesRead){const r=await out.write(buf,written,bytesRead-written,at+written);if(!r.bytesWritten)fail('sentinel.provider.capabilityUntested','Copilot runtime copy ended early');written+=r.bytesWritten}}at+=bytesRead}
  const after=await f.stat(),named=await lstat(path);copilotBoundary(t);if(!same(before,after)||!same(before,named)||named.isSymbolicLink())fail('sentinel.provider.capabilityUntested','Copilot code identity changed');return {bytes:at,digest:'sha256:'+hash.digest('hex'),identity:after};
 }finally{await out?.close();await f.close()}
}
/** Fixed bounded manifest, never a caller-defined package or a user configuration directory. */
async function runtimeMembers(root:string,t:NativeTiming,copyRoot?:string):Promise<Member[]>{
 const original=await checkedRoot(root),rows:Member[]=[];let seen=0,total=0;
 const walk=async(path:string)=>{copilotBoundary(t);const before=await checkedRoot(path),dir=await opendir(path);try{for await(const e of dir){copilotBoundary(t);if(++seen>1024||!e.name||e.name==='.'||e.name==='..')fail('sentinel.provider.capabilityUntested','Copilot package enumeration bound');const absolute=join(path,e.name),s=await lstat(absolute),member=relative(root,absolute);if(s.isSymbolicLink())fail('sentinel.provider.capabilityUntested','Copilot package links refused');if(s.isDirectory()){if(!expectedDirectories.has(member))fail('sentinel.provider.capabilityUntested','unknown Copilot code directory');if(copyRoot)await mkdir(join(copyRoot,member),{mode:0o700});await walk(absolute)}else if(s.isFile()){const expected=expectedMembers.get(member);if(!expected||s.size!==expected.bytes)fail('sentinel.provider.capabilityUntested','unknown or changed Copilot code member');if(rows.length>=512||(total+=s.size)>268435456)fail('sentinel.provider.capabilityUntested','Copilot package byte/member bound');const value=await readMember(absolute,t,134217728,copyRoot?join(copyRoot,member):undefined);if(value.digest!==expected!.digest)fail('sentinel.provider.capabilityUntested','Copilot code content changed');rows.push({path:member.split('\\').join('/'),bytes:value.bytes,digest:value.digest})}else fail('sentinel.provider.capabilityUntested','Copilot package special member refused')}}finally{await dir.close().catch(()=>{})}if(!same(before,await lstat(path)))fail('sentinel.provider.capabilityUntested','Copilot package directory changed')};
 await walk(root);if(!same(original,await lstat(root)))fail('sentinel.provider.capabilityUntested','Copilot package root changed');rows.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const digest='sha256:'+createHash('sha256').update(rows.map(r=>r.path+'\0'+r.bytes+'\0'+r.digest+'\n').join('')).digest('hex');if(rows.length!==COPILOT_NATIVE_PROFILE.runtimeFiles||total!==COPILOT_NATIVE_PROFILE.runtimeBytes||digest!==COPILOT_NATIVE_PROFILE.runtimeDigest)fail('sentinel.provider.capabilityUntested','Copilot complete code closure is unavailable or changed');return rows;
}
async function readExecutable(path:string,t:NativeTiming){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size!==COPILOT_NATIVE_PROFILE.executableBytes)fail('sentinel.provider.capabilityUntested','Copilot executable size/type not pinned');return readMember(path,t,268435456)}
export async function qualifyNativeCopilot(executablePath:string,runtimeDir:string,t:NativeTiming):Promise<NativeCopilotRuntime>{
 copilotBoundary(t);if(process.platform!=='darwin'||process.arch!=='arm64'||!isAbsolute(executablePath))return fail('sentinel.provider.capabilityUntested','Copilot platform unavailable');
 try{const executable=await realpath(executablePath),code=await readExecutable(executable,t);if(code.bytes!==COPILOT_NATIVE_PROFILE.executableBytes||code.digest!==COPILOT_NATIVE_PROFILE.executableDigest)fail('sentinel.provider.capabilityUntested','Copilot executable is not pinned');await runtimeMembers(runtimeDir,t);const body={...COPILOT_NATIVE_PROFILE,securityd:'trusted-pinned-vendor-not-service-confinement',destinations:COPILOT_DESTINATIONS};const runtime=Object.freeze({profileId:body.id,executableDigest:body.executableDigest,runtimeDigest:body.runtimeDigest,profileDigest:canonicalDigest(body)});runtimes.set(runtime,{executable,runtimeDir,identity:code.identity});return runtime}catch(e){if(e instanceof ProviderError)throw e;return fail('sentinel.provider.capabilityUntested','Copilot pinned external runtime unavailable')}
}
export const COPILOT_DESTINATIONS=Object.freeze(['api.github.com','github.com','api.githubcopilot.com','api.individual.githubcopilot.com','api.business.githubcopilot.com','api.enterprise.githubcopilot.com','copilot-proxy.githubusercontent.com']);
/** Discovery reads code only. No command, login, credential/config file, alternate PATH candidate or download. */
export async function qualifyInstalledNativeCopilot(t:NativeTiming):Promise<NativeCopilotRuntime>{
 const path=process.env.PATH??'',dirs=path.split(':');if(path.length>8192||dirs.length>32||dirs.some(d=>!isAbsolute(d)))fail('sentinel.provider.capabilityUntested','Copilot discovery path bound');
 for(const dir of dirs){copilotBoundary(t);const candidate=join(dir,'copilot');try{await lstat(candidate)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;return fail('sentinel.provider.capabilityUntested','first Copilot candidate unavailable')}
  let executable=await realpath(candidate);if(executable.endsWith('/npm-loader.js'))executable=join(dirname(executable),'node_modules/@github/copilot-darwin-arm64/copilot');return qualifyNativeCopilot(executable,join(homedir(),'Library/Caches/copilot/pkg/darwin-arm64/1.0.103'),t)}return fail('sentinel.provider.capabilityUntested','Copilot is not installed');
}
export async function nativeCopilotSetup(runtime:NativeCopilotRuntime,proxyPort:number,t:NativeTiming){
 const held=runtimes.get(runtime);if(!held||!Number.isSafeInteger(proxyPort)||proxyPort<1||proxyPort>65535)return fail('sentinel.provider.notTrusted','Copilot setup requires genuine qualification');copilotBoundary(t);
 const before=await readExecutable(held.executable,t);if(before.digest!==runtime.executableDigest||!same(before.identity,held.identity))fail('sentinel.provider.capabilityUntested','Copilot executable changed');
 const ownedRoot=await realpath(await mkdtemp('/private/tmp/sentinel-copilot-'));
 try{for(const d of ['runtime','home','state','tmp'])await mkdir(join(ownedRoot,d),{mode:0o700});await runtimeMembers(held.runtimeDir,t,join(ownedRoot,'runtime'));
  const policy=['(version 1)(deny default)','(allow process-fork)',`(allow process-exec (literal ${q(held.executable)}))`,'(allow process-info* (target same-sandbox))(allow signal (target same-sandbox))(allow sysctl-read)',
   `(allow file-read* (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/Library/Apple") (literal ${q(held.executable)}) (subpath ${q(ownedRoot)}) (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))`,
   `(deny file-read* (subpath ${q(join(ownedRoot,'runtime/builtin-skills'))}) (subpath ${q(join(ownedRoot,'runtime/builtin'))}) (subpath ${q(join(ownedRoot,'runtime/plugins'))}))`,
   '(allow file-read-metadata (vnode-type DIRECTORY))',`(allow file-write* (subpath ${q(join(ownedRoot,'home'))}) (subpath ${q(join(ownedRoot,'state'))}) (subpath ${q(join(ownedRoot,'tmp'))}) (literal "/dev/null"))`,
   '(allow mach-priv-task-port (target same-sandbox))(allow user-preference-read)',
   // Native supported auth trusts this pinned vendor's use of securityd. This does NOT confine queries to one service.
   '(allow mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.logd") (global-name "com.apple.system.logger") (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.opendirectoryd.membership"))',
   '(allow file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))',`(allow network-outbound (remote ip "localhost:${proxyPort}"))`].join('\n');
  const env=Object.freeze({PATH:'/usr/bin:/bin',HOME:join(ownedRoot,'home'),COPILOT_HOME:join(ownedRoot,'state'),COPILOT_CLI_DIST_DIR:join(ownedRoot,'runtime'),TMPDIR:join(ownedRoot,'tmp'),XDG_CACHE_HOME:join(ownedRoot,'state'),CI:'1',TERM:'dumb',NO_COLOR:'1',COPILOT_AUTO_UPDATE:'false',USE_TGREP:'false',HTTPS_PROXY:`http://127.0.0.1:${proxyPort}`,HTTP_PROXY:`http://127.0.0.1:${proxyPort}`,NO_PROXY:''});
  const setup=Object.freeze({executable:held.executable,policy,env,ownedRoot});setups.set(setup,ownedRoot);return setup;
 }catch(e){await rm(ownedRoot,{recursive:true,force:true});throw e}
}
/** Recheck the complete private copy and executable immediately before process creation. */
export async function verifyNativeCopilotSetup(setup:object,t:NativeTiming){const root=setups.get(setup);if(!root)return fail('sentinel.provider.notAdmitted','Copilot setup is not genuine');await runtimeMembers(join(root,'runtime'),t);const code=await readExecutable((setup as {executable:string}).executable,t);if(code.digest!==COPILOT_NATIVE_PROFILE.executableDigest||code.bytes!==COPILOT_NATIVE_PROFILE.executableBytes)fail('sentinel.provider.capabilityUntested','Copilot executable changed before launch');copilotBoundary(t)}
export async function cleanupNativeCopilotSetup(setup:object){const root=setups.get(setup);if(!root)return;setups.delete(setup);await chmod(join(root,'runtime'),0o700).catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:0})}
