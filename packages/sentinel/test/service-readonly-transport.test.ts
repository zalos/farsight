import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { publishedReadonly, requester } from './service-readonly-helpers.ts';
import {
  listenOwnerSocket,
  runtimeAddress,
  newOwnerNonce,
  connectOwnerSocket,
  encodeFrame,
  FrameDecoder,
} from '../dist/transport/ipc.js';
import { READONLY_LIMITS } from '../dist/service/readonly.js';
const code = (c: string) => (e: any) => e?.code === c;
async function socketFor(t: any, f: any, observe?: (op: string, result: Promise<unknown>) => void) {
  const ownerNonce = newOwnerNonce(),
    address = runtimeAddress({ storePath: f.store.storePath, ownerNonce, sources: [f.ws.path] });
  const socket = await listenOwnerSocket(address, { storeId: f.store.storeId, ownerNonce }, (op, body, by, context) => {
    const task = f.service.handle(op, body, by, context);
    observe?.(op, task);
    return task;
  });
  const clients: any[] = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await socket.close();
  });
  return async () => {
    const client = await connectOwnerSocket(address, { storeId: f.store.storeId, ownerNonce }, 'mcp');
    clients.push(client);
    return client;
  };
}
test('a disconnected reader reconnects to the same channel and exact immutable view/delivery', async (t) => {
  const f = await publishedReadonly(t),
    connect = await socketFor(t, f);
  let client = await connect();
  t.after(() => client.close());
  const view: any = await client.request('run.inspect', { runId: f.runId });
  const m: any = await client.request('report.open', { runId: f.runId, format: 'json' });
  const first = await client.request('delivery.read', { deliveryId: m.deliveryId, offset: 0, maxBytes: 50 });
  client.close();
  client = await connect();
  assert.deepEqual(await client.request('delivery.read', { deliveryId: m.deliveryId, offset: 0, maxBytes: 50 }), first);
  assert.equal(
    ((await client.request('view.page', { viewId: view.viewId, collection: 'works' })) as any).viewId,
    view.viewId,
  );
});
test('socket cancellation reaches genuine preparation and cannot evict a previously installed delivery', async (t) => {
  const f = await publishedReadonly(t),
    held: any[] = [];
  for (let i = 0; i < READONLY_LIMITS.deliveries; i++)
    held.push(await f.call('report.open', { runId: f.runId, format: 'json' }));
  let settledResolve: (v: any) => void = () => {},
    observe = false;
  const settled = new Promise((resolve) => (settledResolve = resolve)),
    connect = await socketFor(t, f, (op, task) => {
      if (observe && op === 'report.open')
        void task.then(
          (v) => settledResolve({ value: v }),
          (e) => settledResolve({ code: e.code }),
        );
    });
  const client = await connect();
  t.after(() => client.close());
  observe = true;
  const controller = new AbortController(),
    task = client.request('report.open', { runId: f.runId, format: 'html' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(task, code('sentinel.ipc.canceled'));
  assert.equal(((await settled) as any).code, 'sentinel.execution.canceled');
  for (const m of held)
    assert.equal(
      ((await client.request('delivery.read', { deliveryId: m.deliveryId, offset: 0 })) as any).deliveryId,
      m.deliveryId,
    );
});
test(
  'server-observed disconnect aborts genuine unsettled read preparation without evicting deliveries',
  { timeout: 60000 },
  async (t) => {
    let beganResolve: () => void = () => {},
      abortedResolve: () => void = () => {},
      settledResolve: (v: any) => void = () => {},
      settled = false;
    const began = new Promise<void>((r) => (beganResolve = r)),
      aborted = new Promise<void>((r) => (abortedResolve = r)),
      result = new Promise((r) => (settledResolve = r));
    let observe = false;
    const f = await publishedReadonly(t, {
        now: () => {
          if (observe) beganResolve();
          return new Date();
        },
      }),
      held: any[] = [];
    for (let i = 0; i < READONLY_LIMITS.deliveries; i++)
      held.push(await f.call('report.open', { runId: f.runId, format: 'json' }));
    const ownerNonce = newOwnerNonce(),
      address = runtimeAddress({ storePath: f.store.storePath, ownerNonce, sources: [f.ws.path] });
    const socket = await listenOwnerSocket(address, { storeId: f.store.storeId, ownerNonce }, (op, body, by, ctx) => {
      if (observe && op === 'report.open')
        ctx?.signal.addEventListener(
          'abort',
          () => {
            assert.equal(settled, false, 'server abort precedes preparation settlement');
            abortedResolve();
          },
          { once: true },
        );
      const task = f.service.handle(op, body, by, ctx);
      if (observe && op === 'report.open')
        void task.then(
          (v) => {
            settled = true;
            settledResolve({ value: v });
          },
          (e) => {
            settled = true;
            settledResolve({ code: e.code });
          },
        );
      return task;
    });
    const clients: any[] = [];
    t.after(async () => {
      clients.forEach((c) => c.close());
      await socket.close();
    });
    const connect = async () => {
      const c = await connectOwnerSocket(address, { storeId: f.store.storeId, ownerNonce }, 'mcp');
      clients.push(c);
      return c;
    };
    let client = await connect();
    observe = true;
    const task = client.request('report.open', { runId: f.runId, format: 'html' });
    void task.catch(() => undefined);
    await began;
    client.close();
    await aborted; // Server-observed end/close while real budgeted preparation is unsettled.
    await assert.rejects(task, code('sentinel.ipc.notListening'));
    assert.equal(((await result) as any).code, 'sentinel.execution.canceled');
    observe = false;
    client = await connect();
    assert.equal(((await client.request('service.capabilities', {})) as any).apiRevision, 1);
    for (const m of held)
      assert.equal(
        ((await client.request('delivery.read', { deliveryId: m.deliveryId, offset: 0 })) as any).deliveryId,
        m.deliveryId,
      );
    assert.equal(f.store.ledger.getRun(f.runId)?.state, 'completed');
    assert.equal(
      ((await client.request('report.open', { runId: f.runId, format: 'json' })) as any).schema,
      'sentinel-report-delivery/draft-1',
    );
  },
);

test(
  'duplicate in-flight read IDs cannot substitute a controller or reach the held handler twice',
  { timeout: 60000 },
  async (t) => {
    const f = await publishedReadonly(t),
      m: any = await f.call('report.open', { runId: f.runId, format: 'json' });
    const ownerNonce = newOwnerNonce(),
      address = runtimeAddress({ storePath: f.store.storePath, ownerNonce, sources: [f.ws.path] });
    let calls = 0,
      settle: (v: unknown) => void = () => {};
    const settled = new Promise((r) => (settle = r)),
      socket = await listenOwnerSocket(address, { storeId: f.store.storeId, ownerNonce }, (op, body, by, ctx) => {
        calls++;
        const task = f.service.handle(op, body, by, ctx);
        void task.then(
          (v) => settle(v),
          (e) => settle({ code: e.code }),
        );
        return task;
      });
    const raw = connect(address.socket);
    t.after(async () => {
      raw.destroy();
      await socket.close();
    });
    await new Promise((r) => raw.once('connect', r));
    const got: any[] = [],
      decoder = new FrameDecoder();
    const ended = new Promise<void>((r) => raw.once('end', () => r()));
    raw.on('data', (b) => got.push(...decoder.push(b)));
    raw.write(
      Buffer.concat([
        encodeFrame({ protocol: 'sentinel-service/draft-1', type: 'hello', client: 'mcp' }),
        encodeFrame({ type: 'cancel', id: 999 }),
        encodeFrame({ type: 'request', id: 1, op: 'report.open', body: { runId: f.runId, format: 'html' } }),
        encodeFrame({ type: 'request', id: 1, op: 'report.open', body: { runId: f.runId, format: 'html' } }),
      ]),
    );
    await ended;
    await settled;
    assert.equal(calls, 1);
    assert.ok(got.some((x) => x.type === 'error' && x.code === 'sentinel.ipc.frameMalformed'));
    assert.equal(
      ((await f.call('delivery.read', { deliveryId: m.deliveryId, offset: 0 })) as any).deliveryId,
      m.deliveryId,
    );
  },
);

test(
  'a cancellation with the same request ID on another real socket cannot cancel the original read',
  { timeout: 60000 },
  async (t) => {
    let armed = false,
      begin: () => void = () => {};
    const began = new Promise<void>((r) => (begin = r)),
      f = await publishedReadonly(t, {
        now: () => {
          if (armed) begin();
          return new Date();
        },
      }),
      connect = await socketFor(t, f),
      a = await connect(),
      b = await connect();
    armed = true;
    const first = a.request('report.open', { runId: f.runId, format: 'html' });
    await began;
    const controller = new AbortController(),
      other = b.request('report.open', { runId: f.runId, format: 'json' }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(other, code('sentinel.ipc.canceled'));
    const m: any = await first;
    assert.equal(
      ((await a.request('delivery.read', { deliveryId: m.deliveryId, offset: 0 })) as any).deliveryId,
      m.deliveryId,
    );
    assert.equal(f.store.ledger.getRun(f.runId)?.state, 'completed');
  },
);

test(
  'service shutdown aborts its unsettled read then closes only its own accepted socket',
  { timeout: 60000 },
  async (t) => {
    let armed = false,
      begin: () => void = () => {},
      settle: (v: any) => void = () => {};
    const began = new Promise<void>((r) => (begin = r)),
      settled = new Promise((r) => (settle = r));
    const f = await publishedReadonly(t, {
        now: () => {
          if (armed) begin();
          return new Date();
        },
      }),
      ownerNonce = newOwnerNonce(),
      address = runtimeAddress({ storePath: f.store.storePath, ownerNonce, sources: [f.ws.path] });
    const listener = await listenOwnerSocket(address, { storeId: f.store.storeId, ownerNonce }, (op, body, by, ctx) => {
      const p = f.service.handle(op, body, by, ctx);
      void p.then(
        (v) => settle({ value: v }),
        (e) => settle({ code: e.code }),
      );
      return p;
    });
    const client = await connectOwnerSocket(address, { storeId: f.store.storeId, ownerNonce }, 'mcp');
    t.after(async () => {
      client.close();
      await listener.close();
    });
    armed = true;
    const task = client.request('report.open', { runId: f.runId, format: 'html' });
    void task.catch(() => {});
    await began;
    await f.service.stop();
    await listener.close();
    await assert.rejects(task, (e: any) =>
      ['sentinel.ipc.notListening', 'sentinel.execution.canceled'].includes(e.code),
    );
    assert.equal(((await settled) as any).code, 'sentinel.execution.canceled');
    assert.equal(f.store.ledger.getRun(f.runId)?.state, 'completed');
  },
);
