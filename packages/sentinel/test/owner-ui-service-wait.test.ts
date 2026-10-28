// The companion started beside a service that is still opening (lane L-UX U-4, the demo's dry run): it waits for the
// workspace's own service, says once what it waits for, and pairs when the service answers; after its bounded wait,
// still no service refuses as before. It never starts a service. A genuine completed scan, the real owner socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { listenOwnerSocket, runtimeAddress, newOwnerNonce } from '../dist/transport/ipc.js';
import { writePrivateFileAtomic } from '../dist/policy/user-state.js';
import { startOwnerUi, SERVICE_WAIT } from '../dist/owner-ui/server.js';
import { needsStore } from './snapshot-helpers.ts';
import { completedPreviewScan } from './helpers/read-model-fixture.ts';

test(
  'owner-ui waits a bounded time for the workspace service, says so once, and pairs when it answers',
  { ...needsStore, timeout: 120000 },
  async (t) => {
    const f = await completedPreviewScan(t);
    const instance = 'host-' + '8'.repeat(32),
      host = createServer((_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: { readOnly: false, instance } }));
      });
    await new Promise<void>((r) => host.listen(0, '127.0.0.1', r));
    t.after(() => new Promise<void>((r) => host.close(() => r())));
    const farsight = 'http://127.0.0.1:' + (host.address() as any).port;

    // No service, no wait: refused at once, nothing said.
    const said: number[] = [];
    await assert.rejects(startOwnerUi(f.ws, farsight, { onWaiting: (ms) => said.push(ms) }), {
      code: 'sentinel.service.operationUnavailable',
    });
    assert.deepEqual(said, []);

    // No service within the wait: said once, then refused as before, after the wait and not long after it.
    const began = Date.now();
    await assert.rejects(startOwnerUi(f.ws, farsight, { waitForServiceMs: 900, onWaiting: (ms) => said.push(ms) }), {
      code: 'sentinel.service.operationUnavailable',
    });
    const took = Date.now() - began;
    assert.deepEqual(said, [900], 'what it waits for is said once');
    assert.ok(took >= 900 - SERVICE_WAIT.everyMs && took < 900 + 5000, `waited ${took} ms`);

    // The service opens during the wait: the companion pairs with it.
    said.length = 0;
    let opened = false;
    const starting = startOwnerUi(f.ws, farsight, {
      waitForServiceMs: 30000,
      onWaiting: (ms) => {
        said.push(ms);
        // the owner starts `farsight-sentinel serve` now: its socket listens, then its descriptor is written
        setTimeout(async () => {
          const nonce = newOwnerNonce(),
            address = runtimeAddress({ storePath: f.store.storePath, ownerNonce: nonce, sources: [f.ws.path] }),
            socket = await listenOwnerSocket(
              address,
              { storeId: f.store.storeId, ownerNonce: nonce },
              (op, body, by, context) => f.service.handle(op, body, by, context),
            );
          t.after(() => socket.close());
          writePrivateFileAtomic(
            join(f.ws.trustDir, 'services'),
            createHash('sha256').update(f.ws.storePath).digest('hex').slice(0, 32) + '.json',
            Buffer.from(
              JSON.stringify({
                schema: 'sentinel-service/draft-1',
                storePath: f.ws.storePath,
                storeId: f.store.storeId,
                ownerNonce: nonce,
                address,
                pid: process.pid,
                startedAt: new Date().toISOString(),
              }),
            ),
            'sentinel.receipt.storeUnsafe',
          );
          opened = true;
        }, 600);
      },
    });
    const companion = await starting;
    t.after(() => companion.close());
    assert.equal(opened, true, 'it paired only once the service answered');
    assert.deepEqual(said, [30000]);
    assert.match(companion.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const boot = await fetch(companion.origin + '/bootstrap', { redirect: 'manual' });
    assert.equal(boot.status, 303, 'the paired companion serves its pairing door');
    assert.match(boot.headers.get('location') ?? '', /^\/frame#launch=/);
  },
);
