// A real coordinator process for the kill matrix: it runs the synthetic plan against the store under <root> and,
// when told, sends itself SIGKILL at one boundary for one unit. Without a kill target it runs (or recovers and
// finishes) the run and prints its summary as the last line of stdout.
import { Coordinator } from '../../dist/execution/coordinator.js';
import { storeIn } from '../execution-helpers.ts';
import { syntheticPlan } from '../coordinator-helpers.ts';
import { join } from 'node:path';

const [root, killAt, unit, behaviourB] = process.argv.slice(2);
const store = await storeIn(root!);
const { plan, registry } = syntheticPlan(root!, behaviourB ? { B: behaviourB } : {});
const hooks = killAt && killAt !== 'none'
  ? { at: (b: string, ctx: { work: { id: string } }) => { if (b === killAt && ctx.work.id === unit) process.kill(process.pid, 'SIGKILL'); } }
  : undefined;
const c = await Coordinator.open({ store, plan, registry, scratchRoot: join(root!, 'work'), ...(hooks ? { hooks } : {}) });
const summary = await c.run();
store.close();
process.stdout.write(`${JSON.stringify({ state: summary.state, published: summary.published, clean: summary.clean, recovery: summary.recovery })}\n`);
