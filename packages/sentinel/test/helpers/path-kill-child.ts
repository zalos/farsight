// Own subprocess only: actual fixed paths execution stops itself at an existing durable publication seam.
// The request/plan was genuinely prepared by the owner fixture; this helper grants no caller capability.
import { openStore } from '../../dist/store/index.js';
import { scratchUnder, removeScratch } from '../lease-helpers.ts';
import { Coordinator } from '../../dist/execution/coordinator.js';
import { publicRegistry, scannerExecution } from '../../dist/service/scanner-profile.js';
const [path, trustDir, runId, boundary] = process.argv.slice(2),
  store = await openStore(path!),
  work = scratchUnder(store);
try {
  const registry = publicRegistry(trustDir!),
    assets = await scannerExecution(store, runId!, trustDir!, work, registry);
  const coordinator = await Coordinator.open({
    ...assets,
    store,
    runId: runId!,
    registry,
    scratchRoot: work,
    hooks: {
      at(b) {
        if (b === boundary) process.kill(process.pid, 'SIGKILL');
      },
    },
  });
  const done = await coordinator.run();
  process.stdout.write(JSON.stringify(done));
} finally {
  removeScratch(work);
  store.close();
}
