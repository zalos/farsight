// A real coordinator over real containers for the container recovery tests. Faults are injected around the real
// Docker client (package-internal wrapRunner seam) and end this process with SIGKILL at a chosen moment:
//   lost-reply   the daemon creates work-B's container, then this process dies before reading the reply
//   before-create  this process dies after journaling work-B's create intent, before sending the create
//   cancel       the run is set canceling once work-A's container runs, then this process dies
//   none         run (or recover and finish) normally; prints the summary as the last stdout line
import { join } from 'node:path';
import { Coordinator } from '../../dist/execution/coordinator.js';
import { LABELS } from '../../dist/execution/isolation.js';
import { loadPlan } from '../../dist/execution/plans.js';
import { storeIn } from '../execution-helpers.ts';
import { containerRegistry, syntheticPlan, unitIdsOf } from '../coordinator-helpers.ts';

const [root, scenario, waitMs] = process.argv.slice(2);
const store = await storeIn(root!);
// The recovering run (none-cancel) executes the same admitted plan as the one that crashed, under the same registry.
const behaviours = scenario === 'cancel' || scenario === 'none-cancel' ? { A: 'hang' } : {};
const registry = await containerRegistry(behaviours);
const runId = 'run-e4';
const admitted = store.ledger.latestPlan(runId);
const setup = admitted ? null : await syntheticPlan(store, root!, behaviours, { runId, registry, adapterPrefix: 'canary' });
const ids = setup?.ids ?? unitIdsOf((await loadPlan(store, runId, admitted!.revision)).plan);
const wrapRunner = (real: any) => ({
  ...real,
  run: async (args: readonly string[], signal?: AbortSignal) => {
    if (args[0] === 'create' && scenario === 'before-create' && attemptOf(args) === bAttempt()) process.kill(process.pid, 'SIGKILL');
    const r = await real.run(args, signal);
    if (args[0] === 'create' && scenario === 'lost-reply' && attemptOf(args) === bAttempt()) process.kill(process.pid, 'SIGKILL');
    return r;
  },
});
let b: string | undefined;
const bAttempt = () => b;
const attemptOf = (args: readonly string[]) => args.find(a => a.startsWith(`${LABELS.attempt}=`))?.slice(LABELS.attempt.length + 1);
const hooks = {
  at: (boundary: string, ctx: { work: { id: string }; attemptId: string }) => {
    if (ctx.work.id === ids.B && boundary === 'before-spawn') b = ctx.attemptId;
    if (scenario === 'cancel' && ctx.work.id === ids.A && boundary === 'after-attempt-start') {
      store.ledger.setRunState(runId, 'canceling');
      process.kill(process.pid, 'SIGKILL');
    }
  },
};
const c = await Coordinator.open({ store, runId, ...(setup ? { run: setup.run } : {}), registry, scratchRoot: join(root!, 'work'), containers: true, hooks,
  cleanupWaitMs: Number(waitMs ?? 30_000), backendOptions: { wrapRunner } });
const summary = await c.run();
store.close();
process.stdout.write(`${JSON.stringify({ ids, state: summary.state, published: summary.published, clean: summary.clean, blocked: summary.blockedByCleanup, recovery: summary.recovery })}\n`);
