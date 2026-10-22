// A background service process for the detached-run tests: the real serveWorkspace(), socket, descriptor, receipts
// and coordinator. Before it serves, each named run is admitted (once) through the real plan admission: the synthetic
// four-unit plan (coordinator-helpers.ts) under the workspace's own adopted policy, run by slow built-in workers so a
// run can be paused, canceled or killed. Each run is recorded by its first execution; its envelope is kept in a test
// file so a restarted service can record a run its predecessor never started. Prints `listening`; SIGTERM stops it.
//
//   node --experimental-strip-types service-child.ts <workspace> <root> <behaviour> <runId>...
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adoptedPolicy, workspaceOf } from '../../dist/service/local.js';
import { serveWorkspace } from '../../dist/service/owner-service.js';
import { openStore } from '../../dist/store/index.js';
import { registryFor, syntheticPlan, syntheticServiceDrivers } from '../coordinator-helpers.ts';

const [workspacePath, root, behaviour, ...runIds] = process.argv.slice(2) as [string, string, string, ...string[]];
const ws = workspaceOf(workspacePath);
const adopted = adoptedPolicy(ws);
if (!('policy' in adopted)) throw new Error('the test workspace has no adopted policy');
const behaviours = { A: behaviour, B: behaviour, C: behaviour, D: behaviour };
const registry = registryFor(root, behaviours);
const envelopes = join(root, 'run-envelopes.json');
const runs: Record<string, unknown> = existsSync(envelopes) ? JSON.parse(readFileSync(envelopes, 'utf8')) : {};
const store = await openStore(ws.storePath);
let drivers;
try {
  for (const runId of runIds) {
    if (store.ledger.latestPlan(runId)) continue;
    const planned = await syntheticPlan(store, root, behaviours, { runId, policy: adopted.policy, registry });
    runs[runId] = planned.run;
  }
  drivers = await syntheticServiceDrivers(store, registry, runIds[0]!);
} finally { store.close(); }
writeFileSync(envelopes, JSON.stringify(runs));

const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
await serveWorkspace(ws, { idleMs: 0, signal: stop.signal, service: { registry, drivers, runEnvelope: (id: string) => runs[id] as never },
  onListening: () => process.stdout.write('listening\n') });
