// Owned loopback inputs only; no vendor process, authentication, DNS lookup or upstream model request.
import {test} from 'node:test';import assert from 'node:assert/strict';import {connect} from 'node:net';
import {openNativeCopilotProxy} from '../dist/review/providers/cli-copilot-proxy.js';
async function refusal(bytes:Buffer|string){const p=await openNativeCopilotProxy({deadlineAt:Date.now()+1000,maxUpstreamBytes:1024,maxDownstreamBytes:1024});try{await new Promise<void>(resolve=>{const s=connect(p.port,'127.0.0.1',()=>s.end(bytes));s.resume();s.on('error',()=>resolve());s.on('close',()=>resolve())});return p.observation()}finally{await p.close()}}
test('proxy diagnostics expose only closed public CONNECT shape and never supplied auth headers or unknown hosts',async()=>{
 const privateValue='original-private-header-value',host='original-private-host.invalid';
 for(const header of [`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nAuthorization: ${privateValue}\r\n\r\n`,`CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com:444\r\nProxy-Authorization: ${privateValue}\r\n\r\n`]){const value=await refusal(header);assert.equal(value.endedBy,header.includes(host)?'open':'refused');assert.equal(value.upstreamWireBytes,0);assert.equal(value.downstreamWireBytes,0);const text=JSON.stringify(value);assert.equal(text.includes(privateValue),false);assert.equal(text.includes(host),false);assert.ok(value.diagnostics.length<=24);assert.equal(value.diagnostics[0]!.phase,'connect');assert.ok(Object.isFrozen(value.diagnostics));}
});
test('TLS rejection diagnostics retain numeric record structure without payload bytes',async()=>{
 const secret=Buffer.from('original-private-tls-payload'),header=Buffer.from('CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com:443\r\n\r\n'),bad=Buffer.concat([Buffer.from([23,3,3,0,1,0]),secret]);
 const result=await refusal(Buffer.concat([header,bad]));assert.equal(result.endedBy,'refused');assert.equal(result.upstreamWireBytes,0);assert.equal(result.diagnostics.at(-1)!.reason,'tls-client-hello');assert.equal(result.diagnostics.at(-1)!.contentType,23);assert.equal(JSON.stringify(result).includes(secret.toString()),false);
});
test('an unlisted CONNECT closes only itself and cannot terminate an accepted allowlisted connection',async()=>{
 const p=await openNativeCopilotProxy({deadlineAt:Date.now()+5000,maxUpstreamBytes:1024,maxDownstreamBytes:1024});const allowed=connect(p.port,'127.0.0.1');allowed.on('error',()=>{});
 try{await new Promise<void>((resolve,reject)=>{allowed.once('connect',()=>allowed.write('CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com:443\r\n\r\n'));allowed.once('data',b=>{assert.match(b.toString(),/^HTTP\/1\.1 200/);resolve()});allowed.once('error',reject)});
  await new Promise<void>(resolve=>{const denied=connect(p.port,'127.0.0.1',()=>denied.end('CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n'));denied.resume();denied.on('error',()=>resolve());denied.on('close',()=>resolve())});
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(p.observation().endedBy,'open');assert.equal(allowed.destroyed,false);assert.equal(p.observation().connections,2);assert.equal(p.observation().upstreamWireBytes,0);assert.equal(p.observation().downstreamWireBytes,0);
  // The surviving connection still has to pass TLS identity checks; invalid TLS cannot escape through it.
  await new Promise<void>(resolve=>{allowed.once('close',()=>resolve());allowed.write(Buffer.from([23,3,3,0,1,0]))});assert.equal(p.observation().endedBy,'refused');assert.equal(p.observation().upstreamWireBytes,0);
 }finally{allowed.destroy();await p.close()}
});
test('closed unlisted connections still consume the original global twelve-connection ceiling',async()=>{
 const p=await openNativeCopilotProxy({deadlineAt:Date.now()+5000,maxUpstreamBytes:1024,maxDownstreamBytes:1024});try{for(let i=0;i<13;i++){await new Promise<void>(resolve=>{const s=connect(p.port,'127.0.0.1',()=>s.end('CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n'));s.resume();s.on('error',()=>resolve());s.on('close',()=>resolve())});assert.equal(p.observation().endedBy,i<12?'open':'refused')}
 assert.equal(p.observation().connections,13);assert.equal(p.observation().upstreamWireBytes,0);assert.equal(p.observation().downstreamWireBytes,0);assert.ok(p.observation().diagnostics.length<=24);
 }finally{await p.close()}
});
