// One admitted Copilot invocation. Native supported keychain authentication remains inside the pinned vendor process.
import {spawn} from 'node:child_process';
import {open,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {nativeCopilotSetup,cleanupNativeCopilotSetup,verifyNativeCopilotSetup,copilotBoundary} from './cli-copilot-profile.js';
import {openNativeCopilotProxy} from './cli-copilot-proxy.js';
import {NativeCopilotDecoder} from './cli-copilot-wire.js';
import {beginCopilotCall,finishCopilotCall,type CopilotCallAuthority} from './broker.js';
import {ProviderError} from './errors.js';
import type {ParsedReply} from './kinds.js';
export async function nativeCopilotCall(authority:CopilotCallAuthority):Promise<ParsedReply>{
 const {runtime,wire,limits}=beginCopilotCall(authority);copilotBoundary(limits);
 const proxy=await openNativeCopilotProxy({...limits,maxUpstreamBytes:4194304,maxDownstreamBytes:4194304});let setup:Awaited<ReturnType<typeof nativeCopilotSetup>>|undefined,possibleSpend=false;
 try{setup=await nativeCopilotSetup(runtime,proxy.port,limits);const current=setup,usagePath=current.ownedRoot+'/state/usage.json';
  // Owner-created fixed settings only. No copied login/settings/permissions/configuration; no vendor discovery.
  await writeFile(current.ownedRoot+'/state/settings.json',JSON.stringify({disableAllHooks:true,memory:false,continueOnAutoMode:false,storeTokenPlaintext:false,extensions:{mode:'disabled'},skills:{disabled:['*']}}),{flag:'wx',mode:0o600});copilotBoundary(limits);await verifyNativeCopilotSetup(current,limits);
  const decoder=new NativeCopilotDecoder(limits.maxResponseBytes,wire.requestedModel);
  await new Promise<void>((resolve,reject)=>{
   const command='ulimit -H -c 0 && ulimit -S -c 0 && exec /usr/bin/sandbox-exec "$@"';
   // Piped stdin is the supported programmatic prompt path. Supplying -p would cause Copilot to ignore stdin.
   const args=['-c',command,'sentinel-copilot','-p',current.policy,current.executable,'--no-auto-update','--model',wire.requestedModel,'--context','default','--reasoning-effort','minimal','--output-format','json','--stream','off','--usage-output-file',usagePath,
    '--available-tools=','--deny-tool','shell','--deny-tool','write','--disable-builtin-mcps','--no-custom-instructions','--no-ask-user','--disable-client-telemetry','--sync-session=off','--no-experimental','--no-bash-env','--disallow-temp-dir','--log-level','none','--no-color','--max-ai-credits','30'];
   let failure:ProviderError|undefined,stderr=0,spawned=false;const child=spawn('/bin/sh',args,{cwd:current.ownedRoot+'/home',env:{...current.env},detached:true,stdio:['pipe','pipe','pipe']});possibleSpend=child.pid!==undefined;
   const stop=(e:ProviderError)=>{failure??=e;if(child.pid)try{process.kill(-child.pid,'SIGKILL')}catch{}};
   const cancel=()=>stop(new ProviderError('sentinel.provider.canceled','Copilot invocation canceled','possible'));
   const timer=setTimeout(()=>stop(new ProviderError('sentinel.provider.timeout','original Copilot deadline elapsed','possible')),Math.max(1,limits.deadlineAt-Date.now()));limits.signal?.addEventListener('abort',cancel,{once:true});
   child.stdout.on('data',(b:Buffer)=>{if(!failure)try{decoder.push(b)}catch(e){stop(e instanceof ProviderError?e:new ProviderError('sentinel.provider.malformedResponse','Copilot stream refused','possible'))}});
   child.stderr.on('data',(b:Buffer)=>{stderr+=b.length;if(stderr>4096)stop(new ProviderError('sentinel.provider.responseTooLarge','Copilot stderr bound','possible'))});
   child.stdin.on('error',()=>stop(new ProviderError('sentinel.provider.unreachable','Copilot input delivery failed','possible')));
   child.once('spawn',()=>{spawned=true;if(limits.signal?.aborted)return cancel();if(Date.now()>=limits.deadlineAt)return stop(new ProviderError('sentinel.provider.timeout','original Copilot deadline elapsed','possible'));child.stdin.end(wire.stdin)});
   child.once('error',()=>{failure??=new ProviderError('sentinel.provider.unreachable','Copilot native process unavailable',spawned?'possible':'none')});
   child.once('close',(code,signal)=>{clearTimeout(timer);limits.signal?.removeEventListener('abort',cancel);if(limits.signal?.aborted)failure=new ProviderError('sentinel.provider.canceled','Copilot invocation canceled','possible');else if(Date.now()>=limits.deadlineAt)failure=new ProviderError('sentinel.provider.timeout','original Copilot deadline elapsed','possible');if(failure)return reject(failure);if(code!==0||signal!==null||!spawned)return reject(new ProviderError('sentinel.provider.malformedResponse','Copilot exited without accepted completion','possible'));resolve()});
   if(limits.signal?.aborted)cancel();
  });
  copilotBoundary(limits);const fd=await open(usagePath,constants.O_RDONLY|constants.O_NOFOLLOW);try{const before=await fd.stat();if(!before.isFile()||before.nlink!==1||before.size>limits.maxResponseBytes-decoder.bytes)throw new ProviderError('sentinel.provider.responseTooLarge','Copilot usage file bound','possible');const bytes=await fd.readFile(),after=await fd.stat();copilotBoundary(limits);if(before.dev!==after.dev||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||before.size!==after.size)throw new ProviderError('sentinel.provider.malformedResponse','Copilot usage identity changed','possible');return decoder.finish(bytes)}finally{await fd.close()}
 }catch(e){if(e instanceof ProviderError)throw possibleSpend&&e.spend==='none'?new ProviderError(e.code,'Copilot dispatched invocation did not produce an accepted reply','possible'):e;throw new ProviderError('sentinel.provider.malformedResponse','Copilot output unavailable',possibleSpend?'possible':'none')}
 finally{finishCopilotCall(authority);await proxy.close();if(setup)await cleanupNativeCopilotSetup(setup)}
}
