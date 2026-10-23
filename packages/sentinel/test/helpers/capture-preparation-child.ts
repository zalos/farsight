// Trusted test-only service driver: genuine canonical source evidence is prepared, then this process waits before
// returning a job. The parent kills only this recorded service PID; no target source is executed.
import {writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {workspaceOf} from '../../dist/service/local.js';
import {serveWorkspace} from '../../dist/service/owner-service.js';
import {publicRegistry} from '../../dist/service/scanner-profile.js';
import {frameworkAdapter} from '../../dist/service/framework-adapter.js';
import {createCheckDriverRegistry} from '../../dist/execution/check-drivers.js';
const ws=workspaceOf(process.argv[2]!);
const registry=publicRegistry(ws.trustDir),base=frameworkAdapter(ws.trustDir).driver;
const drivers=createCheckDriverRegistry([{...base,async prepare(ctx){
 await base.prepare(ctx); // Real original retained evidence and auxiliary bytes, before job publication.
 writeFileSync(join(ctx.workDir,'preparation-in-progress'),'original inert preparation marker',{mode:0o600});
 process.stdout.write(JSON.stringify({phase:'preparing',path:ctx.workDir,lease:dirname(ctx.workDir)})+'\n');
 await new Promise(()=>{});
 throw new Error('unreachable preparation gate');
}}],registry);
const stop=new AbortController();process.once('SIGTERM',()=>stop.abort());
await serveWorkspace(ws,{idleMs:0,signal:stop.signal,service:{registry,drivers},onListening(){process.stdout.write(JSON.stringify({phase:'listening'})+'\n')}});
