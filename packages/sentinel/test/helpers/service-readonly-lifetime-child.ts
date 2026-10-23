// Trusted test-process clock only: not packaged, persisted, request-addressable or an owner capability.
// Actual serveWorkspace, held store, default detached 15s idle policy and wire sockets remain unchanged.
import {performance} from 'node:perf_hooks';
import {serveWorkspace} from '../../dist/service/owner-service.js';
import {workspaceOf} from '../../dist/service/local.js';
const wall=Date.now.bind(Date),monotonic=performance.now.bind(performance);let elapsed=0;
Date.now=()=>wall()+elapsed;Object.defineProperty(performance,'now',{value:()=>monotonic()+elapsed});
const advance=(message:any)=>{if(message?.type!=='advance'||!Number.isSafeInteger(message.ms)||message.ms<0||message.ms>400000)return;elapsed+=message.ms;process.send?.({type:'advanced',serial:message.serial});};
process.on('message',advance);
try{await serveWorkspace(workspaceOf(process.argv[2]),{idleMs:15000,onListening:()=>process.send?.({type:'listening'})});process.send?.({type:'stopped'});}
finally{process.off('message',advance);process.disconnect?.();}
