// Genuine owner projection and bounded DAG behavior; no invented accepted artifacts or receipts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { loadPlan } from '../dist/execution/plans.js';
import { processLayout } from '../dist/owner-ui/process-layout.js';
import { OwnerService } from '../dist/service/owner-service.js';
import { publishOwnerCompanion } from '../dist/owner-ui/descriptor.js';
import { companionDirectory, companionWorkspaceDigest } from '@farsight/core/dist/sentinel-companion.js';
import { preparationFixture } from './helpers/preparation-fixture.ts';
import { needsStore } from './snapshot-helpers.ts';
const by = { principal: 'agent' as const, channel: 'owner-ui' as const },
  wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const row = (workKey: string, prerequisites: any[] = []) => ({ workKey, prerequisites });
const dep = (workKey: string, binding = 'in-view') => ({ workKey, binding });
test('process levels preserve real parallel prerequisites and omit reference-only fake nodes', () => {
  assert.deepEqual(
    processLayout([
      row('capture'),
      row('parse', [dep('capture')]),
      row('inventory', [dep('parse')]),
      row('a', [dep('inventory')]),
      row('b', [dep('inventory'), dep('prior', 'reference-only')]),
      row('join', [dep('a'), dep('b')]),
    ]),
    [['capture'], ['parse'], ['inventory'], ['a', 'b'], ['join']],
  );
  assert.throws(() => processLayout([row('a', [dep('b')]), row('b', [dep('a')])]));
  assert.throws(() => processLayout([row('a', [dep('absent')])]));
  assert.throws(() => processLayout([row('a'), row('a')]));
  assert.throws(() => processLayout(Array.from({ length: 2001 }, (_, i) => row(String(i)))));
  assert.throws(() =>
    processLayout([
      row(
        'a',
        Array.from({ length: 10001 }, () => dep('outside', 'reference-only')),
      ),
    ]),
  );
});
test(
  'paired owner sees genuine retained runs, bounded private handles, original grants and source-gone graph I/O',
  { ...needsStore, timeout: 60000 },
  async (t) => {
    const f = await preparationFixture(t),
      prior = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(f.dir, 'owner');
    t.after(() => {
      if (prior === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prior;
    });
    const service = new OwnerService(f.store, f.ws, { registry: f.registry });
    t.after(() => service.stop());
    const hostInstance = 'host-' + '1'.repeat(32),
      descriptor = await publishOwnerCompanion(companionDirectory(), {
        schema: 'farsight-sentinel-companion/1',
        workspaceDigest: companionWorkspaceDigest(f.ws.path),
        ownerOrigin: 'http://127.0.0.1:4501',
        farsightOrigin: 'http://127.0.0.1:4500',
        hostInstance,
        processNonce: '2'.repeat(64),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
    t.after(() => descriptor.close());
    const pair = async () => {
      const p: any = await service.handle(
        'owner-ui.pair',
        { farsightOrigin: 'http://127.0.0.1:4500', hostInstance, processNonce: '2'.repeat(64) },
        by,
      );
      await service.handle(
        'owner-ui.context',
        {
          proof: p.proof,
          view: {
            frameNonce: 'frame-' + '3'.repeat(32),
            documentId: 'document-' + '4'.repeat(32),
            revision: 1,
            hostInstance,
            mode: 'live',
            sync: null,
          },
        },
        by,
      );
      return (op: string, body: any = {}) => service.handle(op, { proof: p.proof, revision: 1, ...body }, by);
    };
    const call = await pair(),
      key = 'genuine_graph_prepare_00001',
      preview: any = await call('owner-ui.preview', { requestKey: key });
    assert.equal(
      ((await call('owner-ui.accept', { requestKey: key, previewId: preview.id })) as any).outcome,
      'submitted',
    );
    for (let i = 0; i < 1000 && service.busy; i++) await wait(10);
    const status: any = await call('owner-ui.status', { requestKey: key }),
      runId = status.facts.runId;
    assert.equal(status.facts.phase, 'prepared');
    rmSync(join(f.ws.path, 'src'), { recursive: true });
    const sequence = f.store.ledger.currentSequence(),
      runs: any = await call('owner-ui.runs');
    assert.equal(runs.more, false);
    assert.ok(runs.runs.length);
    assert.ok(runs.runs.every((r: any) => /^h[a-f0-9]{32}$/.test(r.key) && !('id' in r) && !('runId' in r)));
    const chosen: any = await call('owner-ui.select', { key: runs.runs[0].key });
    assert.equal(chosen.runId, runId);
    await assert.rejects(call('owner-ui.select', { key: runId }));
    const details: any = await call('owner-ui.process', { runId });
    assert.equal(details.scheduler.history, 'unrecorded');
    assert.deepEqual(details.review, { status: 'unavailable', reviews: [] });
    assert.equal(details.grants.length, 4);
    const view: any = await service.handle('run.inspect', { runId, planRevision: 1 }, by),
      page: any = await service.handle('view.page', { viewId: view.viewId, collection: 'works' }, by);
    assert.ok(processLayout(page.rows).length > 1);
    const plan = await loadPlan(f.store, runId, 1);
    for (const row of page.rows) {
      const unit = plan.plan.units.find((u) => u.stage === row.stage),
        raw = unit ? f.store.ledger.getWork(unit) : null;
      if (raw) assert.deepEqual(row.resources, raw.envelope.resources);
    }
    const current: any = await service.handle('run.inspect', { runId }, by),
      currentPage: any = await service.handle('view.page', { viewId: current.viewId, collection: 'works' }, by),
      work = currentPage.rows.find((r: any) => r.inputCount > 0);
    assert.ok(work);
    const inputs: any = await service.handle(
      'view.page',
      { viewId: current.viewId, collection: 'inputs', workKey: work.workKey },
      by,
    );
    assert.ok(inputs.rows.length);
    assert.ok(inputs.rows.every((r: any) => r.workKey === work.workKey));
    assert.equal(f.store.ledger.currentSequence(), sequence);
    assert.throws(() => f.store.ledger.listRuns(129));
    assert.throws(() => f.store.ledger.listRuns(0));
    await call('owner-ui.runs');
    await assert.rejects(call('owner-ui.select', { key: runs.runs[0].key }));
    const other = await pair();
    await assert.rejects(other('owner-ui.select', { key: runs.runs[0].key }));
  },
);
