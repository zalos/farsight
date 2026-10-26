// Genuine detached process/socket/held-store lifetime. Only its private test clocks advance; no public TTL override.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { publishedReadonly } from './service-readonly-helpers.ts';
import { removeScratch } from './lease-helpers.ts';
import { connectService } from '../dist/service/owner-service.js';
import { openStore } from '../dist/store/index.js';
import { READONLY_LIMITS } from '../dist/service/readonly.js';
const helper = fileURLToPath(new URL('./helpers/service-readonly-lifetime-child.ts', import.meta.url));
for (const kind of ['view', 'delivery', 'connection-only'] as const)
  test(
    `detached owner ${kind} retention ends at absolute expiry even with an idle connected MCP`,
    { timeout: 60000 },
    async (t) => {
      const f = await publishedReadonly(t);
      await f.service.stop();
      removeScratch(f.work);
      f.store.close();
      const child = fork(helper, [f.ws.path], {
        env: { ...process.env, XDG_STATE_HOME: join(f.root, 'state') },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let err = '';
      child.stderr!.on('data', (b) => (err += b));
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await exited;
        }
      });
      await new Promise<void>((resolve, reject) => {
        child.on('message', (m: any) => {
          if (m.type === 'listening') resolve();
        });
        child.once('exit', (c) => reject(Error('owned service exited before listening ' + c + ' ' + err)));
      });
      const client = (await connectService(f.ws, 'mcp'))!;
      assert.ok(client);
      t.after(() => client.close());
      let serial = 0;
      const advance = async (ms: number) => {
        const n = ++serial;
        await new Promise<void>((resolve) => {
          const ack = (m: any) => {
            if (m.type === 'advanced' && m.serial === n) {
              child.off('message', ack);
              resolve();
            }
          };
          child.on('message', ack);
          child.send({ type: 'advance', ms, serial: n });
        });
      };
      let saved: any;
      if (kind === 'view') saved = await client.request('run.inspect', { runId: f.runId });
      if (kind === 'delivery') saved = await client.request('report.open', { runId: f.runId, format: 'json' });
      await advance(16000);
      if (kind !== 'connection-only') {
        await delay(300);
        assert.equal(
          child.exitCode,
          null,
          'a live absolute-TTL buffer retains the actual service beyond default detached idle cutoff',
        );
        // A read resets the ordinary request idle clock, but cannot move the original buffer expiry.
        if (kind === 'view')
          assert.equal(
            ((await client.request('view.page', { viewId: saved.viewId, collection: 'works' })) as any).viewId,
            saved.viewId,
          );
        else
          assert.equal(
            ((await client.request('delivery.read', { deliveryId: saved.deliveryId, offset: 0 })) as any).deliveryId,
            saved.deliveryId,
          );
        const ttl = kind === 'view' ? READONLY_LIMITS.viewTtlMs : READONLY_LIMITS.deliveryTtlMs;
        await advance(ttl - 16000 + 1);
      }
      assert.equal(await exited, 0, err);
      assert.equal(client.closed, true, 'listener shutdown closes only its own accepted idle sockets');
      const reopened = await openStore(f.ws.storePath);
      reopened.close();
      t.diagnostic(
        JSON.stringify({
          lifecycle: kind,
          detachedIdleMs: 15000,
          absoluteTtl:
            kind === 'view' ? READONLY_LIMITS.viewTtlMs : kind === 'delivery' ? READONLY_LIMITS.deliveryTtlMs : null,
          expiredStoreReleased: true,
        }),
      );
    },
  );
