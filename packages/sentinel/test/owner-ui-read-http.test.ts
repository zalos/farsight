// The read model over the companion's actual loopback HTTP origin (lane L-UX U-1): a genuine completed scan, the real
// owner socket and companion, the paired session's read pass. Reads answer the exact paired Farsight origin only;
// every write method is refused on every read route; the capability is not a read pass; nothing reaches the ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { listenOwnerSocket, runtimeAddress, newOwnerNonce } from '../dist/transport/ipc.js';
import { writePrivateFileAtomic } from '../dist/policy/user-state.js';
import { startOwnerUi } from '../dist/owner-ui/server.js';
import { needsStore } from './snapshot-helpers.ts';
import { completedPreviewScan } from './helpers/read-model-fixture.ts';

test(
  'the companion serves the read model to the paired origin with a read pass, and refuses every write',
  { ...needsStore, timeout: 120000 },
  async (t) => {
    const f = await completedPreviewScan(t);
    const instance = 'host-' + '9'.repeat(32),
      host = createServer((_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: { readOnly: true, instance } }));
      });
    await new Promise<void>((r) => host.listen(0, '127.0.0.1', r));
    t.after(() => new Promise<void>((r) => host.close(() => r())));
    const farsight = 'http://127.0.0.1:' + (host.address() as any).port;
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
    const companion = await startOwnerUi(f.ws, farsight);
    t.after(() => companion.close());
    const launch = new URL(
      (await fetch(companion.origin + '/bootstrap', { redirect: 'manual' })).headers.get('location')!,
      companion.origin,
    ).hash.slice(8);
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
    const session: any = await (
      await post('/session', {
        kind: 'launch',
        secret: launch,
        view: {
          hostInstance: instance,
          frameNonce: 'frame-' + 'c'.repeat(32),
          documentId: 'document-' + 'd'.repeat(32),
          revision: 1,
          mode: 'unavailable',
          sync: null,
        },
      })
    ).json();
    assert.match(session.capability, /^[a-f0-9]{64}$/);
    const minted = await post('/viewer-pass', {}, session.capability);
    assert.equal(minted.status, 200);
    const { pass } = (await minted.json()) as any;
    assert.match(pass, /^[a-f0-9]{64}$/);
    assert.notEqual(pass, session.capability);
    const sequence = f.store.ledger.currentSequence();
    const read = (path: string, init: { method?: string; origin?: string; bearer?: string | null } = {}) =>
      fetch(companion.origin + path, {
        method: init.method ?? 'GET',
        headers: {
          origin: init.origin ?? farsight,
          ...(init.bearer === null ? {} : { authorization: 'Bearer ' + (init.bearer ?? pass) }),
        },
      });

    // A read on a read-only host: the paired origin may read it, cross-origin.
    const list = await read('/api/sentinel/scans');
    assert.equal(list.status, 200);
    assert.equal(list.headers.get('access-control-allow-origin'), farsight);
    assert.equal(list.headers.get('access-control-allow-credentials'), null);
    assert.equal(list.headers.get('cache-control'), 'no-store');
    const scans: any = await list.json();
    assert.equal(scans.scans[0].number, 1);
    assert.equal(scans.scans[0].id, f.runId, 'a scan is addressed by its run id');
    assert.deepEqual(scans.page, { before: null, older: null });
    // The list pages backwards by number: below 2 is scan 1, below 1 is nothing.
    const paged: any = await (await read('/api/sentinel/scans/before/2')).json();
    assert.deepEqual(
      paged.scans.map((r: any) => r.id),
      [f.runId],
    );
    assert.equal(((await (await read('/api/sentinel/scans/before/1')).json()) as any).scans.length, 0);
    const at = `/api/sentinel/scans/${f.runId}`;
    const scan: any = await (await read(at)).json();
    assert.equal(scan.stages.length, 4);
    const stageId = encodeURIComponent(scan.stages[3].id);
    const stage = await read(`${at}/stages/${stageId}`);
    assert.equal(stage.status, 200);
    assert.equal(((await stage.json()) as any).stage.id, scan.stages[3].id);
    const unit = await read(`${at}/stages/${stageId}/units/1`);
    assert.equal(unit.status, 200);
    const opened: any = await unit.json();
    assert.equal(opened.schema, 'sentinel-viewer-unit/draft-1');
    assert.equal(opened.invocation.isolation, 'child');
    assert.equal((await read(`${at}/stages/${stageId}/units/2`)).status, 404);

    // The report renderings, whole and checked against their digest.
    for (const [path, type] of [
      [`${at}/report`, /^text\/markdown/],
      [`${at}/report/html`, /^text\/html/],
      [`${at}/report/json`, /^application\/json/],
    ] as const) {
      const r = await read(path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers.get('content-type')!, type);
      assert.match(r.headers.get('content-disposition')!, /^attachment; filename="sentinel-scan-1\./);
      assert.match(r.headers.get('content-security-policy')!, /sandbox/);
      const bytes = Buffer.from(await r.arrayBuffer());
      assert.equal(
        r.headers.get('x-sentinel-format-digest'),
        'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      );
    }

    // Preflight: the paired origin only.
    const preflight = await read('/api/sentinel/scans', { method: 'OPTIONS', bearer: null });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET');
    assert.equal(preflight.headers.get('access-control-allow-headers'), 'authorization');
    assert.equal((await read('/api/sentinel/scans', { method: 'OPTIONS', origin: 'http://127.0.0.1:1' })).status, 401);

    // Another origin gets no CORS grant, so its page cannot read the answer.
    const foreign = await read('/api/sentinel/scans', { origin: 'http://127.0.0.1:1' });
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);

    // No pass, the capability, or an unknown pass: refused.
    for (const bearer of [null, session.capability, 'f'.repeat(64)]) {
      const r = await read('/api/sentinel/scans', { bearer });
      assert.equal(r.status, 401, String(bearer));
      assert.equal(((await r.json()) as any).error, 'sentinel.viewer.notPaired');
    }

    // Every write method on every read route is refused, with the paired pass in hand.
    for (const path of [
      '/api/sentinel/scans',
      '/api/sentinel/scans/before/2',
      at,
      `${at}/stages/${stageId}`,
      `${at}/stages/${stageId}/units/1`,
      `${at}/report`,
    ])
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const r = await read(path, { method });
        assert.equal(r.status, 405, `${method} ${path}`);
        assert.equal(((await r.json()) as any).error, 'sentinel.viewer.readOnly');
      }

    // Unknown scans and stages say so; an address the model does not name is not read.
    assert.equal((await read('/api/sentinel/scans/run-' + '0'.repeat(32))).status, 404);
    assert.equal((await read(`${at}/stages/sentinel.stage.absent`)).status, 404);
    assert.equal((await read('/api/sentinel/scans/1')).status, 404, 'a display number is not an address');
    assert.equal((await read('/api/sentinel/runs')).status, 400);

    // A new pass replaces the old one; the session's end ends both.
    const second: any = await (await post('/viewer-pass', {}, session.capability)).json();
    assert.equal((await read('/api/sentinel/scans')).status, 401);
    assert.equal((await read('/api/sentinel/scans', { bearer: second.pass })).status, 200);
    assert.equal(f.store.ledger.currentSequence(), sequence, 'no read wrote to the ledger');
    await companion.close();
  },
);
