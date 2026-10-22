// One-shot ownership probe for spawnSync: try to acquire without waiting, print the outcome, release, exit.
import { acquireStoreOwner } from '../../dist/store/owner.js';

try {
  const owner = await acquireStoreOwner(process.argv[2], { waitMs: 0 });
  process.stdout.write(JSON.stringify({ outcome: 'acquired', epoch: owner.epoch }));
  owner.close();
} catch (error) {
  process.stdout.write(JSON.stringify({ outcome: 'refused', code: error.code ?? 'unexpected' }));
}
