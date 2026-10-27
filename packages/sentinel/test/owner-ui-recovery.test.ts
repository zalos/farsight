// Genuine service and companion HTTP boundary; duplicate pairing documents grant no new authority.
import { ownerUiRecoveryHtml } from '../dist/owner-ui/view.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { OwnerService } from '../dist/service/owner-service.js';
import { listenOwnerSocket, runtimeAddress, newOwnerNonce } from '../dist/transport/ipc.js';
import { writePrivateFileAtomic } from '../dist/policy/user-state.js';
import { startOwnerUi } from '../dist/owner-ui/server.js';
import { preparationFixture } from './helpers/preparation-fixture.ts';
import { needsStore } from './snapshot-helpers.ts';
test(
  'used bootstrap document explains recovery without renewing or revoking the original paired session',
  { ...needsStore, timeout: 20000 },
  async (t) => {
    const f = await preparationFixture(t),
      previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(f.dir, 'owner');
    t.after(() => {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
    });
    const instance = 'host-' + 'a'.repeat(32),
      host = createServer((_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: { readOnly: false, instance } }));
      });
    await new Promise<void>((r) => host.listen(0, '127.0.0.1', r));
    t.after(() => new Promise<void>((r) => host.close(() => r())));
    const hostOrigin = 'http://127.0.0.1:' + (host.address() as any).port;
    const service = new OwnerService(f.store, f.ws, { registry: f.registry });
    t.after(() => service.stop());
    const nonce = newOwnerNonce(),
      address = runtimeAddress({ storePath: f.store.storePath, ownerNonce: nonce, sources: [f.ws.path] }),
      socket = await listenOwnerSocket(
        address,
        { storeId: f.store.storeId, ownerNonce: nonce },
        (op, body, by, context) => service.handle(op, body, by, context),
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
    const companion = await startOwnerUi(f.ws, hostOrigin);
    t.after(() => companion.close());
    const first = await fetch(companion.origin + '/bootstrap', { redirect: 'manual' });
    assert.equal(first.status, 303);
    const launch = new URL(first.headers.get('location')!, companion.origin).hash.slice(8),
      sequence = f.store.ledger.currentSequence();
    const duplicate = await fetch(companion.origin + '/bootstrap', { redirect: 'manual' }),
      html = await duplicate.text();
    assert.equal(duplicate.status, 400);
    assert.match(duplicate.headers.get('content-type')!, /^text\/html/);
    assert.equal(duplicate.headers.get('cache-control'), 'no-store');
    assert.match(duplicate.headers.get('content-security-policy')!, /default-src 'none'/);
    assert.match(html, /pairing link has already been used/);
    assert.match(html, /paired tab/);
    assert.doesNotMatch(html, /<script|launch=|sentinel\.ownerUi\.expired/);
    assert.equal(html.includes(launch), false);
    assert.equal(f.store.ledger.currentSequence(), sequence);
    const post = (path: string, body: any, cap?: string) =>
      fetch(companion.origin + path, {
        method: 'POST',
        headers: {
          origin: companion.origin,
          'content-type': 'application/json',
          ...(cap ? { authorization: 'Bearer ' + cap } : {}),
        },
        body: JSON.stringify(body),
      });
    const active = await post('/session', {
      kind: 'launch',
      secret: launch,
      view: {
        hostInstance: instance,
        frameNonce: 'frame-' + 'c'.repeat(32),
        documentId: 'document-' + 'd'.repeat(32),
        revision: 1,
        mode: 'live',
        sync: null,
      },
    });
    assert.equal(active.status, 200);
    const paired: any = await active.json();
    assert.equal(
      (await post('/status', {}, paired.capability)).status,
      200,
      'duplicate document did not revoke the original launch',
    );
    const invalid = await post('/session', { kind: 'launch', secret: launch, view: {} });
    assert.equal(invalid.status, 400);
    assert.match(invalid.headers.get('content-type')!, /^application\/json/);
    assert.equal(f.store.ledger.currentSequence(), sequence);
  },
);

test('recovery document escapes all supplied copy and has no executable page content', () => {
  const html = ownerUiRecoveryHtml('<script>bad</script>', '&<img src=x onerror="bad">');
  assert.doesNotMatch(html, /<script|<img|onerror="bad"/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;&lt;img/);
});
