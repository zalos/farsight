// Exact internal retained admission seam, then real process death before run creation. No receipt or serialized
// proof is fabricated. Public confirmation/launch separation is qualified independently by path-owner.test.ts.
import { openStore } from '../../dist/store/index.js';
import { adoptedPolicy, workspaceOf } from '../../dist/service/local.js';
import { readPathRequestFile } from '../../dist/service/path-request-file.js';
import { preparePathTask } from '../../dist/service/path-task.js';
import { admitPlan } from '../../dist/execution/plans.js';
const [workspace, ownerState, requestFile] = process.argv.slice(2),
  ws = workspaceOf(workspace!, { ...process.env, XDG_STATE_HOME: ownerState! }),
  policy = adoptedPolicy(ws);
if (!('policy' in policy)) throw Error('fixture owner policy absent');
const store = await openStore(ws.storePath),
  timing = { signal: new AbortController().signal, deadlineAt: performance.now() + 60000 };
const request = readPathRequestFile(requestFile!, () => store.assertHeld());
const c = await preparePathTask(
  store,
  request.value,
  { trustDir: ws.trustDir, policy: policy.policy, now: new Date() },
  timing,
);
await admitPlan(store, {
  plan: c.plan,
  ruleLock: c.current.lock,
  policy: policy.policy,
  profile: c.profile.record,
  pathRequest: { document: c.request.value, proof: c.proof, timing: c.timing },
});
process.kill(process.pid, 'SIGKILL');
