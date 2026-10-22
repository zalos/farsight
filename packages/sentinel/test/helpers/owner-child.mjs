// A real, independent owner process for the store tests. The parent drives it over IPC so races are
// barriers, not sleeps: `ready` → (go) → `acquired` | `refused`; then `assert`, `release` or a SIGKILL.
import { acquireStoreOwner } from '../../dist/store/owner.js';

const [storePath, waitMs = '250'] = process.argv.slice(2);
let owner;
const send = message => process.send(message);
process.on('message', async message => {
  try {
    if (message.type === 'go') {
      try {
        owner = await acquireStoreOwner(storePath, { waitMs: Number(waitMs) });
        send({ type: 'acquired', epoch: owner.epoch, storeId: owner.storeId, pid: process.pid });
      } catch (error) {
        send({ type: 'refused', code: error.code ?? 'unexpected', message: String(error.message) });
      }
    } else if (message.type === 'assert') {
      try { owner.assertHeld(); send({ type: 'held' }); } catch (error) { send({ type: 'not-held', code: error.code }); }
    } else if (message.type === 'release') {
      owner?.close();
      send({ type: 'released' });
    } else if (message.type === 'exit') {
      process.disconnect();
    }
  } catch (error) {
    send({ type: 'error', code: error.code ?? 'unexpected', message: String(error.message) });
  }
});
send({ type: 'ready' });
