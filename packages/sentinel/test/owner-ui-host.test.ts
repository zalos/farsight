// Only owned loopback fixtures. No hosted endpoints, credentials, target code or image acquisition.
import{test}from'node:test';import assert from'node:assert/strict';import{createServer}from'node:http';import{ownerHost}from'../dist/owner-ui/host.js';
const instance='host-'+ 'a'.repeat(32);
async function host(t:any,reply:(req:any,res:any)=>void){const server=createServer(reply);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address()as any).port;t.after(()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()));});return`http://127.0.0.1:${port}`;}
test('fixed host probe reads the exact bounded instance/readOnly and refuses another owner instance',async t=>{
 const origin=await host(t,(req,res)=>{assert.equal(req.url,'/api/version');assert.equal(req.headers.cookie,undefined);res.end(JSON.stringify({session:{instance,readOnly:false}}));});assert.deepEqual(await ownerHost(origin,instance),{instance,readOnly:false});await assert.rejects(ownerHost(origin,'host-'+ 'b'.repeat(32)));
 const readonly=await host(t,(_req,res)=>res.end(JSON.stringify({session:{instance,readOnly:true}})));assert.equal((await ownerHost(readonly)).readOnly,true);
});
test('host probe never follows redirect or accepts missing legacy session identity',async t=>{
 let destination=0;const target=await host(t,(_req,res)=>{destination++;res.end(JSON.stringify({session:{instance,readOnly:false}}));});const redirect=await host(t,(_req,res)=>{res.writeHead(302,{location:target+'/api/version'});res.end();});await assert.rejects(ownerHost(redirect));assert.equal(destination,0);
 const legacy=await host(t,(_req,res)=>res.end(JSON.stringify({session:{readOnly:false}})));await assert.rejects(ownerHost(legacy));
});
test('host probe enforces original absolute timeout despite a slow response and refuses oversized bytes',async t=>{
 const origin=await host(t,(_req,res)=>{res.writeHead(200);res.write('{');const timer=setInterval(()=>res.write(' '),100);res.on('close',()=>clearInterval(timer));});const start=performance.now();await assert.rejects(ownerHost(origin));assert.ok(performance.now()-start<3000);
 const huge=await host(t,(_req,res)=>res.end('x'.repeat(16385)));await assert.rejects(ownerHost(huge));
 for(const invalid of ['https://127.0.0.1:1234','http://example.test:1234','http://127.0.0.1:1234/','http://user@127.0.0.1:1234'])await assert.rejects(ownerHost(invalid));
});
