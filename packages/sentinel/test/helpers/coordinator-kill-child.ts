// A real coordinator process for the kill matrix: it runs the synthetic admitted plan against the store under
// <root> and, when told, sends itself SIGKILL at one boundary for one unit (by letter: work-B is the diamond's B).
// The first process captures and admits the plan; a later one opens the recorded run by its id. Without a kill
// target it runs (or recovers and finishes) the run and prints its summary as the last line of stdout.
import { Coordinator } from '../../dist/execution/coordinator.js';
import { loadPlan } from '../../dist/execution/plans.js';
import { storeIn } from '../execution-helpers.ts';
import { registryFor, syntheticPlan, unitIdsOf } from '../coordinator-helpers.ts';
import { join } from 'node:path';

const [root, killAt, unit, behaviourB] = process.argv.slice(2);
const store = await storeIn(root!);
const behaviours = behaviourB ? { B: behaviourB } : {};
const runId = 'run-e4';
const admitted = store.ledger.latestPlan(runId);
const setup = admitted ? null : await syntheticPlan(store, root!, behaviours, { runId });
const registry = setup?.registry ?? registryFor(root!, behaviours);
const ids = setup?.ids ?? unitIdsOf((await loadPlan(store, runId, admitted!.revision)).plan);
const target = ids[(unit ?? 'work-B').slice('work-'.length)];
const hooks = killAt && killAt !== 'none'
  ? { at: (b: string, ctx: { work: { id: string } }) => { if (b === killAt && ctx.work.id === target) process.kill(process.pid, 'SIGKILL'); } }
  : undefined;
const c = await Coordinator.open({ store, runId, ...(setup ? { run: setup.run } : {}), registry, scratchRoot: join(root!, 'work'), ...(hooks ? { hooks } : {}) });
const summary = await c.run();
store.close();
process.stdout.write(`${JSON.stringify({ state: summary.state, published: summary.published, clean: summary.clean, recovery: summary.recovery })}\n`);
