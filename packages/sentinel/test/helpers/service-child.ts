// A background service process for the detached-run tests: the real serveWorkspace(), socket, descriptor, receipts
// and coordinator, over the synthetic diamond plan (coordinator-helpers.ts) instead of the preview planner, so a run
// is slow enough to pause, cancel or kill. Prints `listening` once the descriptor is written; SIGTERM stops it.
//
//   node --experimental-strip-types service-child.ts <workspace> <adapter-root> <behaviour>
import { readPlanRecord, workspaceOf } from '../../dist/service/local.js';
import { serveWorkspace } from '../../dist/service/owner-service.js';
import { syntheticPlan } from '../coordinator-helpers.ts';
import { influenceManifest } from '../../dist/execution/plan.js';

const [workspacePath, root, behaviour] = process.argv.slice(2) as [string, string, string];
const ws = workspaceOf(workspacePath);
const plans = {
  record: (planId: string) => readPlanRecord(ws, planId),
  async prepare(_store: unknown, planId: string) {
    const s = syntheticPlan(root, { A: behaviour, B: behaviour, C: behaviour, D: behaviour }, { runId: planId });
    // Work ids are unique across a store, so each plan's units carry its tag: work-A-1, work-A-2, …
    const tag = (id: string) => `${id}-${planId.charAt(5)}`;
    const adapter = s.registry.get(`test-${behaviour}`);
    const works = s.plan.works.map((w: any) => {
      const tagged = { ...w, id: tag(w.id), dependencies: w.dependencies.map((d: any) => ({ ...d, id: tag(d.id) })) };
      return { ...tagged, influenceManifest: influenceManifest(tagged, adapter, s.plan.inputsFor(w).map((i: any) => i.id)).id };
    });
    return { boundary: { ...s.plan, works, adapterFor: () => `test-${behaviour}` }, registry: s.registry };
  },
};
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
await serveWorkspace(ws, { idleMs: 0, signal: stop.signal, service: { plans }, onListening: () => process.stdout.write('listening\n') });
