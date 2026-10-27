// Actual detached service, unchanged idle policy and private clock-only child from the read lifecycle controls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { preparationFixture } from './helpers/preparation-fixture.ts';
import { needsStore } from './snapshot-helpers.ts';
import { connectService } from '../dist/service/owner-service.js';
import { openStore } from '../dist/store/index.js';
import { publishOwnerCompanion } from '../dist/owner-ui/descriptor.js';
import { companionDirectory, companionWorkspaceDigest } from '@farsight/core/dist/sentinel-companion.js';
for (const end of ['expiry', 'revoke'] as const)
  test(
    `paired UI retains a detached owner beyond idle then releases at absolute ${end}`,
    { ...needsStore, timeout: 30000 },
    async (t) => {
      const f = await preparationFixture(t);
      f.store.close();
      const original = process.env.XDG_STATE_HOME;
      process.env.XDG_STATE_HOME = join(f.dir, 'owner');
      t.after(() => {
        if (original === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = original;
      });
      const instance = 'host-' + 'a'.repeat(32),
        nonce = 'b'.repeat(64),
        expiresAt = new Date(Date.now() + 3600000).toISOString(),
        descriptor = await publishOwnerCompanion(companionDirectory(), {
          schema: 'farsight-sentinel-companion/1',
          workspaceDigest: companionWorkspaceDigest(f.ws.path),
          farsightOrigin: 'http://127.0.0.1:4500',
          ownerOrigin: 'http://127.0.0.1:4501',
          hostInstance: instance,
          processNonce: nonce,
          expiresAt,
        });
      t.after(() => descriptor.close());
      const child = fork(
        fileURLToPath(new URL('./helpers/service-readonly-lifetime-child.ts', import.meta.url)),
        [f.ws.path],
        { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
      );
      let errors = '';
      child.stderr!.on('data', (b) => (errors += b));
      const exited = new Promise((resolve) => child.once('exit', resolve));
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
        child.once('exit', (c) => reject(Error('owner exited ' + c + ' ' + errors)));
      });
      const client = (await connectService(f.ws, 'owner-ui'))!;
      t.after(() => client.close());
      const pair: any = await client.request('owner-ui.pair', {
        farsightOrigin: 'http://127.0.0.1:4500',
        hostInstance: instance,
        processNonce: nonce,
      });
      await client.request('owner-ui.context', {
        proof: pair.proof,
        view: {
          frameNonce: 'frame-' + 'c'.repeat(32),
          documentId: 'document-' + 'd'.repeat(32),
          hostInstance: instance,
          revision: 1,
          mode: 'live',
          sync: null,
        },
      });
      let serial = 0;
      async function advance(ms: number) {
        const n = ++serial;
        await new Promise<void>((resolve) => {
          const ack = (m: any) => {
            if (m.type === 'advanced' && m.serial === n) {
              child.off('message', ack);
              resolve();
            }
          };
          child.on('message', ack);
          child.send({ type: 'advance', serial: n, ms });
        });
      }
      await advance(16000);
      await delay(300);
      assert.equal(child.exitCode, null, 'a genuinely paired UI retains service beyond ordinary detached idle cutoff');
      client.close();
      const reconnected = (await connectService(f.ws, 'owner-ui'))!;
      t.after(() => reconnected.close());
      assert.ok(await reconnected.request('service.owner-ui-capabilities', {}));
      if (end === 'revoke') {
        await reconnected.request('owner-ui.revoke', { proof: pair.proof });
        await advance(16000);
      } else {
        for (let i = 0; i < 8; i++) await advance(400000);
        await advance(384001);
      }
      assert.equal(await exited, 0, errors);
      assert.equal(reconnected.closed, true);
      const reopened = await openStore(f.ws.storePath);
      reopened.close();
      t.diagnostic(
        JSON.stringify({ paired: true, idleMs: 15000, absoluteSessionMs: 3600000, end, storeReleased: true }),
      );
    },
  );
