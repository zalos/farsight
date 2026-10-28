import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { rmSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { publishedReadonly, requester } from './service-readonly-helpers.ts';
import { fullReport, renderingOf } from '../dist/service/full-report.js';
import { validateEnvelope } from '../dist/validate.js';
import { READONLY_LIMITS, deliveryBuffer } from '../dist/service/readonly.js';
import { loadPlan } from '../dist/execution/plans.js';
const code = (c: string) => (e: any) => e?.code === c;
async function delivery(f: any, manifest: any) {
  let offset = 0;
  const chunks = [];
  for (;;) {
    const c = await f.call('delivery.read', { deliveryId: manifest.deliveryId, offset, maxBytes: 37 });
    assert.ok(validateEnvelope('deliverychunk', c).ok);
    chunks.push(Buffer.from(c.base64, 'base64'));
    if (c.nextOffset === null) break;
    offset = c.nextOffset;
  }
  return Buffer.concat(chunks);
}

test('held service advertises additive readonly schemas and rejects all extra caller authority', async (t) => {
  const f = await publishedReadonly(t),
    caps: any = await f.call('service.capabilities');
  assert.ok(validateEnvelope('servicecapabilities', caps).ok);
  assert.equal(caps.controlsSupported, false);
  assert.equal(caps.features.find((x: any) => x.id === 'model-review').library, 'unavailable');
  for (const body of [
    { runId: f.runId, receiptId: 'receipt' },
    { runId: f.runId, planRevision: '2' },
    { runId: f.runId, planRevision: 999 },
  ])
    await assert.rejects(f.call('run.inspect', body));
  assert.equal(f.store.ledger.getRun(f.runId)?.state, 'completed');
});

test('immutable paged view is source-free, privately handles digests and returns independent copies', async (t) => {
  const f = await publishedReadonly(t),
    view: any = await f.call('run.inspect', { runId: f.runId });
  assert.ok(validateEnvelope('runinspection', view).ok);
  const plan = await loadPlan(f.store, f.runId, view.planRevision);
  const pages: any[] = [];
  for (const collection of ['works', 'attempts', 'inputs', 'outputs']) {
    let cursor: unknown;
    do {
      const page: any = await f.call('view.page', {
        viewId: view.viewId,
        collection,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      assert.ok(validateEnvelope('inspectionpage', page).ok);
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor);
  }
  const text = JSON.stringify({ view, pages });
  for (const raw of [f.runId, plan.record.plan, ...plan.plan.units.map((u: any) => u.id), 'PRIVATE-FILE', 'sha256:'])
    assert.equal(text.includes(raw), false, raw);
  assert.equal(pages.filter((p) => p.collection === 'attempts').flatMap((p) => p.rows).length, view.counts.attempts.n);
  const inputs = pages.filter((p) => p.collection === 'inputs').flatMap((p) => p.rows);
  assert.equal(inputs.length, view.counts.inputs.n);
  assert.ok(inputs.length >= 4);
  const first: any = await f.call('view.page', { viewId: view.viewId, collection: 'inputs', limit: 1 });
  first.rows[0].inputKey = 'mutated';
  assert.notEqual(
    ((await f.call('view.page', { viewId: view.viewId, collection: 'inputs', limit: 1 })) as any).rows[0].inputKey,
    'mutated',
  );
  await assert.rejects(
    f.service.handle(
      'view.page',
      { viewId: view.viewId, collection: 'works' },
      { principal: 'agent', channel: 'http-bridge' },
    ),
    code('sentinel.service.viewInvalid'),
  );
  await assert.rejects(
    f.call('view.page', {
      viewId: view.viewId,
      collection: pages.find((p) => p.nextCursor)?.collection === 'inputs' ? 'works' : 'inputs',
      cursor: pages.find((p) => p.nextCursor)?.nextCursor,
    }),
    code('sentinel.service.viewInvalid'),
  );
});

test('all delivered formats equal the canonical same-evaluation report after source removal; chunks preserve raw bytes', async (t) => {
  const now = new Date(),
    f = await publishedReadonly(t, { now: () => now });
  rmSync(join(f.ws.path, 'src'), { recursive: true });
  const legacy = await fullReport({
    store: f.store,
    runId: f.runId,
    workspace: f.ws.path,
    trustDir: f.ws.trustDir,
    disclosure: 'shareable',
    now,
  });
  for (const format of ['json', 'md', 'html', 'sarif'] as const) {
    const manifest: any = await f.call('report.open', { runId: f.runId, format });
    assert.ok(validateEnvelope('reportdelivery', manifest).ok, JSON.stringify(manifest));
    const bytes = await delivery(f, manifest);
    assert.equal(bytes.toString(), renderingOf(legacy, format));
    assert.equal(manifest.formatBytes, bytes.length);
    assert.equal(manifest.formatDigest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    assert.equal(manifest.evaluatedAt, legacy.document.evaluatedAt);
    await assert.rejects(
      f.service.handle(
        'delivery.read',
        { deliveryId: manifest.deliveryId, offset: 0 },
        { principal: 'agent', channel: 'http-bridge' },
      ),
      code('sentinel.service.deliveryInvalid'),
    );
  }
});

test('absolute monotonic expiry explicitly invalidates handles without sliding on reads', async (t) => {
  const f = await publishedReadonly(t),
    view: any = await f.call('run.inspect', { runId: f.runId }),
    manifest: any = await f.call('report.open', { runId: f.runId, format: 'json' });
  const later = performance.now() + READONLY_LIMITS.deliveryTtlMs + 1;
  t.mock.method(performance, 'now', () => later);
  await assert.rejects(
    f.call('view.page', { viewId: view.viewId, collection: 'works' }),
    code('sentinel.service.viewExpired'),
  );
  await assert.rejects(
    f.call('delivery.read', { deliveryId: manifest.deliveryId, offset: 0 }),
    code('sentinel.service.deliveryExpired'),
  );
});

test('the real raw-byte delivery buffer enforces limit minus one, exact limit and plus one', () => {
  assert.equal(deliveryBuffer('a'.repeat(READONLY_LIMITS.deliveryBytes - 1)).length, READONLY_LIMITS.deliveryBytes - 1);
  assert.equal(deliveryBuffer('a'.repeat(READONLY_LIMITS.deliveryBytes)).length, READONLY_LIMITS.deliveryBytes);
  assert.throws(
    () => deliveryBuffer('a'.repeat(READONLY_LIMITS.deliveryBytes + 1)),
    code('sentinel.service.deliveryLimit'),
  );
  assert.throws(
    () => deliveryBuffer('é'.repeat(READONLY_LIMITS.deliveryBytes / 2) + 'a'),
    code('sentinel.service.deliveryLimit'),
  );
});

test('cancel after successful A1 return prevents final buffer install and does not evict any prior delivery', async (t) => {
  let calls = 0,
    armed = false;
  const controller = new AbortController();
  const f = await publishedReadonly(t, {
    now: () => {
      if (armed && ++calls === 2) controller.abort();
      return new Date();
    },
  });
  const held = [];
  for (let i = 0; i < READONLY_LIMITS.deliveries; i++)
    held.push(await f.call('report.open', { runId: f.runId, format: 'json' }));
  armed = true;
  await assert.rejects(
    f.service.handle('report.open', { runId: f.runId, format: 'html' }, requester, { signal: controller.signal }),
    code('sentinel.execution.canceled'),
  );
  assert.equal(calls, 2);
  for (const m of held as any[])
    assert.equal(
      ((await f.call('delivery.read', { deliveryId: m.deliveryId, offset: 0 })) as any).deliveryId,
      m.deliveryId,
    );
});

test('pages remain at one frozen revision while a genuine child worker finishes', async (t) => {
  const f = await publishedReadonly(t);
  const { rerunRun, executeRun } = await import('../dist/service/canonical.js');
  const child: any = await rerunRun(f.store, f.runId, [], {
    workspace: f.ws.path,
    trustDir: f.ws.trustDir,
    policy: f.policy,
    scratchRoot: f.work,
    now: new Date(),
  });
  assert.ok(!('reasonCode' in child));
  const id = child.disclosure.runId,
    view: any = await f.call('run.inspect', { runId: id });
  const run = executeRun(f.store, id, { scratchRoot: f.work, trustDir: f.ws.trustDir });
  const before: any = await f.call('view.page', { viewId: view.viewId, collection: 'works' });
  assert.ok(before.rows.every((r: any) => r.recordedWork === null));
  assert.ok(
    before.rows.some((r: any) => r.prerequisites.some((d: any) => d.binding === 'reference-only')),
    'retained bootstrap references are labeled without expanding ancestor rows',
  );
  assert.equal((await run).state, 'completed');
  assert.deepEqual(await f.call('view.page', { viewId: view.viewId, collection: 'works' }), before);
  const fresh: any = await f.call('run.inspect', { runId: id });
  assert.equal(fresh.status, 'completed');
  assert.ok(fresh.counts.attempts.n > view.counts.attempts.n);
});

test('nested original read-budget/cancel/owner refusals cannot install or evict report deliveries', async (t) => {
  const f = await publishedReadonly(t),
    held: any[] = [];
  for (let i = 0; i < READONLY_LIMITS.deliveries; i++)
    held.push(await f.call('report.open', { runId: f.runId, format: 'json' }));
  const { withStoreReadBudget } = await import('../dist/store/read-budget.js');
  for (const limits of [{ reads: 0 }, { decodedBytes: 0 }, { encodedBytes: 0 }])
    await assert.rejects(
      withStoreReadBudget(f.store, limits, () => f.call('report.open', { runId: f.runId, format: 'html' })),
      code('sentinel.object.tooLarge'),
    );
  await assert.rejects(
    withStoreReadBudget(f.store, { durationMs: 1 }, () => {
      const end = performance.now() + 5;
      while (performance.now() < end) {
        // Intentionally spend this synchronous read budget before opening the report.
      }
      return f.call('report.open', { runId: f.runId, format: 'json' });
    }),
    code('sentinel.execution.deadlineExceeded'),
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    f.service.handle('report.open', { runId: f.runId, format: 'json' }, requester, { signal: abort.signal }),
    code('sentinel.execution.canceled'),
  );
  for (const m of held)
    assert.equal(
      ((await f.call('delivery.read', { deliveryId: m.deliveryId, offset: 0 })) as any).deliveryId,
      m.deliveryId,
    );
  const task = f.call('report.open', { runId: f.runId, format: 'json' });
  f.store.close();
  await assert.rejects(task, (e: any) => ['sentinel.store.closed', 'sentinel.store.ownerClosed'].includes(e.code));
});

test('complete serialized page limit includes handles and cursor overhead at minus one/exact/plus one', async () => {
  const { checkInspectionPageBytes } = await import('../dist/service/readonly.js');
  const h = 'h' + '1'.repeat(32),
    page: any = {
      schema: 'sentinel-inspection-page/draft-1',
      viewId: 'v',
      sequence: 1,
      collection: 'works',
      rows: [],
      nextCursor: 'cursor.' + '2'.repeat(32),
    };
  let row: any;
  while (Buffer.byteLength(JSON.stringify(page), 'utf8') < READONLY_LIMITS.pageBytes - 127) {
    if (!row || row.prerequisites.length === 1024) {
      row = {
        kind: 'work',
        workKey: h,
        stage: 'check',
        revision: 1,
        prerequisites: [],
        disposition: 'planned',
        recordedWork: null,
        inputCount: 0,
        implementationKey: h,
      };
      page.rows.push(row);
    }
    row.prerequisites.push({ workKey: h, revision: 1, binding: 'reference-only' });
  }
  const fill = READONLY_LIMITS.pageBytes - Buffer.byteLength(JSON.stringify(page), 'utf8');
  page.viewId += 'x'.repeat(fill);
  assert.ok(validateEnvelope('inspectionpage', page).ok);
  assert.equal(Buffer.byteLength(JSON.stringify(page), 'utf8'), READONLY_LIMITS.pageBytes);
  checkInspectionPageBytes(page);
  page.viewId += 'x';
  assert.ok(validateEnvelope('inspectionpage', page).ok);
  assert.throws(() => checkInspectionPageBytes(page), code('sentinel.service.projectionLimit'));
  page.viewId = page.viewId.slice(0, -2);
  assert.equal(Buffer.byteLength(JSON.stringify(page), 'utf8'), READONLY_LIMITS.pageBytes - 1);
  checkInspectionPageBytes(page);
});

test('exact final original deadline refuses after allocation without installing or evicting any delivery', async (t) => {
  let calls = 0,
    armed = false,
    clock = 0;
  const f = await publishedReadonly(t, {
    now: () => {
      if (armed && ++calls === 2) clock = READONLY_LIMITS.reportMs;
      return new Date();
    },
  });
  const held: any[] = [];
  for (let i = 0; i < READONLY_LIMITS.deliveries; i++)
    held.push(await f.call('report.open', { runId: f.runId, format: 'json' }));
  t.mock.method(performance, 'now', () => clock);
  armed = true;
  await assert.rejects(
    f.call('report.open', { runId: f.runId, format: 'html' }),
    code('sentinel.execution.deadlineExceeded'),
  );
  assert.equal(calls, 2);
  for (const m of held)
    assert.equal(
      ((await f.call('delivery.read', { deliveryId: m.deliveryId, offset: 0 })) as any).deliveryId,
      m.deliveryId,
    );
});

test('one active generation refuses a second reader; a busy worker returns a coherent view or a bounded retry hint', async (t) => {
  const f = await publishedReadonly(t),
    { rerunRun } = await import('../dist/service/canonical.js');
  const child: any = await rerunRun(f.store, f.runId, [], {
    workspace: f.ws.path,
    trustDir: f.ws.trustDir,
    policy: f.policy,
    scratchRoot: f.work,
    now: new Date(),
  });
  assert.ok(!('reasonCode' in child));
  const { publicRegistry, scannerExecution } = await import('../dist/service/scanner-profile.js'),
    { Coordinator } = await import('../dist/execution/coordinator.js');
  const registry = publicRegistry(f.ws.trustDir),
    assets = await scannerExecution(f.store, child.disclosure.runId, f.ws.trustDir, f.work, registry);
  let task: Promise<unknown> | undefined,
    started = 0,
    publication: any;
  const coordinator = await Coordinator.open({
    ...assets,
    store: f.store,
    runId: child.disclosure.runId,
    registry,
    scratchRoot: f.work,
    hooks: {
      async at(boundary, ctx) {
        if (boundary === 'after-objects' && !task) {
          publication = ctx;
          started = performance.now();
          task = f.call('report.open', { runId: f.runId, format: 'json' });
          void task.catch(() => {});
          await assert.rejects(
            f.call('report.open', { runId: f.runId, format: 'html' }),
            code('sentinel.service.deliveryBusy'),
          );
        }
      },
    },
  });
  assert.equal((await coordinator.run()).state, 'completed');
  assert.ok(task && publication);
  assert.ok(f.store.ledger.getPublication(publication.work));
  let m: any,
    busyOutcome = 'coherent';
  try {
    m = await task;
    assert.ok(m.generationSequence <= f.store.ledger.currentSequence());
  } catch (e: any) {
    assert.equal(e.code, 'sentinel.report.viewChanged');
    assert.equal(e.retryable, true);
    assert.equal(e.facts.generations, 2);
    busyOutcome = 'viewChanged';
  }
  const busyMs = performance.now() - started,
    stableStart = performance.now();
  m = await f.call('report.open', { runId: f.runId, format: 'json' });
  assert.equal(m.generationSequence, f.store.ledger.currentSequence());
  const doc = JSON.parse((await delivery(f, m)).toString());
  assert.equal(doc.run.id, f.runId);
  t.diagnostic(
    JSON.stringify({
      measurement: 'service-report-during-genuine-unrelated-worker-publication',
      busyOutcome,
      busyMs,
      stableMs: performance.now() - stableStart,
      formatBytes: m.formatBytes,
      sequence: m.generationSequence,
    }),
  );
});

test('damaged actual accepted report bytes refuse without a partial install or eviction', async (t) => {
  const f = await publishedReadonly(t),
    held: any[] = [];
  for (let i = 0; i < READONLY_LIMITS.deliveries; i++)
    held.push(await f.call('report.open', { runId: f.runId, format: 'json' }));
  const plan = await loadPlan(f.store, f.runId),
    unit = plan.plan.units[0],
    publication = f.store.ledger.getPublication(unit)!;
  assert.ok(publication);
  const output = publication.outputs.find((o) => o.schema === 'application/json')!;
  assert.ok(output);
  const ref = f.store.ledger.objectsOf(output.id)[0],
    hex = output.id.slice(7),
    path = join(f.store.storePath, 'objects/sha256', hex.slice(0, 2), hex + (ref.codec === 'gzip' ? '.gzip' : '.raw')),
    original = readFileSync(path);
  chmodSync(path, 0o600);
  writeFileSync(path, Buffer.alloc(original.length));
  try {
    await assert.rejects(
      f.call('report.open', { runId: f.runId, format: 'html' }),
      code('sentinel.report.evidenceUnbound'),
    );
  } finally {
    writeFileSync(path, original);
    chmodSync(path, 0o400);
  }
  for (const m of held)
    assert.equal(
      ((await f.call('delivery.read', { deliveryId: m.deliveryId, offset: 0 })) as any).deliveryId,
      m.deliveryId,
    );
});

test('an explicit historical admitted revision labels its rows and retains current recorded run status', async (t) => {
  const f = await publishedReadonly(t),
    v: any = await f.call('run.inspect', { runId: f.runId, planRevision: 1 });
  assert.equal(v.historical, true);
  assert.equal(v.planRevision, 1);
  assert.equal(v.status, 'completed');
  const page: any = await f.call('view.page', { viewId: v.viewId, collection: 'works' });
  assert.ok(validateEnvelope('inspectionpage', page).ok);
  assert.ok(page.rows.length > 0);
});

test('a simultaneous genuine inspection returns retryable inspectBusy without installing another view', async (t) => {
  const f = await publishedReadonly(t),
    first = f.call('run.inspect', { runId: f.runId });
  await assert.rejects(
    f.call('run.inspect', { runId: f.runId }),
    (e: any) => e.code === 'sentinel.service.inspectBusy' && e.retryable === true,
  );
  const v: any = await first;
  assert.ok(validateEnvelope('runinspection', v).ok);
  assert.equal(((await f.call('view.page', { viewId: v.viewId, collection: 'works' })) as any).viewId, v.viewId);
});
