// The owner panel's half of the PIPELINE stop's edit mode (lane L-UX U-3): the workspace's declared pipeline read for
// the viewer, an edited copy checked and previewed by the service's own pipeline.write with nothing written, and the
// write confirmed in the panel with one settings.adopt owner-UI receipt for exactly those bytes over exactly the file
// the page read. Writing is not adopting: the adopted pipeline is untouched. A genuine workspace, store and owner
// service; no process, model or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { OwnerService } from '../dist/service/owner-service.js';
import { publishOwnerCompanion } from '../dist/owner-ui/descriptor.js';
import { loadPipeline } from '../dist/app/pipeline-adoption.js';
import { companionDirectory, companionWorkspaceDigest } from '@farsight/core/dist/sentinel-companion.js';
import { preparationFixture } from './helpers/preparation-fixture.ts';
import { needsStore } from './snapshot-helpers.ts';

// The companion's connection, as the socket names it: an agent principal on the owner-ui channel (the live paired proof,
// not the connection, is what lets the panel confirm).
const UI = { principal: 'agent' as const, channel: 'owner-ui' as const };
const text = (pipeline: unknown) => JSON.stringify(pipeline, null, 2) + '\n';

async function paired(t: any) {
  const f = await preparationFixture(t),
    previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(f.dir, 'owner');
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  });
  const service = new OwnerService(f.store, f.ws),
    hostInstance = 'host-' + 'b'.repeat(32),
    nonce = 'c'.repeat(64),
    descriptor = await publishOwnerCompanion(companionDirectory(), {
      schema: 'farsight-sentinel-companion/1',
      workspaceDigest: companionWorkspaceDigest(f.ws.path),
      ownerOrigin: 'http://127.0.0.1:4501',
      farsightOrigin: 'http://127.0.0.1:4500',
      hostInstance,
      processNonce: nonce,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
  t.after(async () => {
    await service.stop();
    await descriptor.close();
  });
  const pair: any = await service.handle(
    'owner-ui.pair',
    { farsightOrigin: 'http://127.0.0.1:4500', hostInstance, processNonce: nonce },
    UI,
  );
  const view = (revision: number, mode = 'live', sync: number | null = null) =>
    service.handle(
      'owner-ui.context',
      {
        proof: pair.proof,
        view: {
          frameNonce: 'frame-' + 'd'.repeat(32),
          documentId: 'document-' + 'e'.repeat(32),
          revision,
          hostInstance,
          mode,
          sync,
        },
      },
      UI,
    );
  await view(1);
  const ui = (op: string, body: Record<string, unknown> = {}, revision = 1) =>
    service.handle(op, { proof: pair.proof, revision, ...body }, UI) as Promise<any>;
  return { f, service, ui, view, path: join(f.ws.path, '.farsight', 'sentinel', 'pipeline.json') };
}

test(
  'the panel reads the declared pipeline, checks an edit without writing, and writes it once on its own receipt, adopting nothing',
  needsStore,
  async (t) => {
    const { f, ui, path } = await paired(t);
    const read = await ui('owner-ui.pipeline');
    assert.equal(read.schema, 'sentinel-viewer-pipeline/draft-1');
    assert.ok(read.pipeline && Array.isArray(read.pipeline.stages) && read.pipeline.stages.length > 0);
    assert.match(read.fileDigest, /^sha256:[a-f0-9]{64}$/);
    const before = readFileSync(path);
    const adoptedBefore = loadPipeline({ workspace: f.ws.path, trustDir: f.ws.trustDir, readOnly: true });

    // An edit: one stage gets a time ceiling. Checking it writes nothing and names what would run again.
    const edited = structuredClone(read.pipeline);
    const last = edited.stages[edited.stages.length - 1];
    last.budget = { ...(last.budget ?? {}), seconds: 120 };
    const checked = await ui('owner-ui.pipeline-preview', { pipeline: edited, expectDigest: read.fileDigest });
    assert.equal(checked.unavailable, undefined, JSON.stringify(checked));
    assert.match(checked.id, /^owner-preview-[a-f0-9]{32}$/);
    assert.ok(Array.isArray(checked.problems));
    assert.ok(
      checked.preview.stages.some((s: any) => s.id === last.id),
      'the edited stage is in the preview',
    );
    assert.deepEqual(readFileSync(path), before, 'checking writes nothing');

    // Confirmed in the panel: exactly those bytes, once, on the panel's own settings.adopt receipt.
    const receipts = () => readdirSync(join(f.ws.trustDir, 'receipts')).filter((n) => n.endsWith('.json'));
    const issued = receipts().length;
    const written = await ui('owner-ui.pipeline-write', { previewId: checked.id });
    assert.equal(written.outcome, 'prepared', JSON.stringify(written));
    assert.equal(written.facts.written, true);
    assert.equal(written.facts.receiptIssuer, 'owner-ui');
    assert.equal(readFileSync(path, 'utf8'), text(edited));
    assert.equal(receipts().length, issued + 1, 'one owner-UI receipt for the write');
    const dir = join(f.ws.trustDir, 'receipts');
    const panel = receipts()
      .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')))
      .filter((r) => r.schema === 'sentinel-owneruireceipt/draft-1' && r.action === 'settings.adopt');
    assert.equal(panel.length, 1, 'the write is confirmed by one settings.adopt receipt from the panel');
    assert.ok(existsSync(join(dir, `${panel[0].id}.spent`)), 'and the service spent it');
    // Writing is not adopting: what a scan runs has not changed.
    const after = loadPipeline({ workspace: f.ws.path, trustDir: f.ws.trustDir, readOnly: true });
    assert.notEqual(after.trust, 'adopted');
    assert.equal(after.read?.fileDigest, written.facts.fileDigest);
    if (adoptedBefore.trust === 'adopted') assert.equal(after.trust, 'changed');

    // The preview is spent with the write: the same confirmation writes nothing twice.
    await assert.rejects(
      ui('owner-ui.pipeline-write', { previewId: checked.id }),
      (e: any) => e?.code === 'sentinel.ownerUi.changed',
    );
    // A preview over a file that has moved on since: the write refuses, nothing written.
    const stale = await ui('owner-ui.pipeline-preview', { pipeline: edited, expectDigest: read.fileDigest });
    const refusedStale = await ui('owner-ui.pipeline-write', { previewId: stale.id });
    assert.equal(refusedStale.reasonCode, 'sentinel.pipeline.changed', JSON.stringify(refusedStale));
    assert.equal(readFileSync(path, 'utf8'), text(edited));
  },
);

test(
  'a pipeline the service refuses is answered with its problems and offers no confirmation',
  needsStore,
  async (t) => {
    const { ui, path } = await paired(t);
    const read = await ui('owner-ui.pipeline');
    const before = readFileSync(path);
    const twice = structuredClone(read.pipeline);
    twice.stages.push(structuredClone(twice.stages[0]));
    const answer = await ui('owner-ui.pipeline-preview', { pipeline: twice, expectDigest: read.fileDigest });
    assert.equal(answer.unavailable, true);
    assert.equal(answer.id, undefined);
    assert.equal(answer.reasonCode, 'sentinel.pipeline.duplicateStage');
    assert.deepEqual(readFileSync(path), before);
    for (const body of [
      { pipeline: [], expectDigest: read.fileDigest },
      { pipeline: twice, expectDigest: 'sha256:short' },
      { pipeline: twice },
    ])
      await assert.rejects(ui('owner-ui.pipeline-preview', body), (e: any) => typeof e?.code === 'string');
  },
);

test('a historical or read-only view of the page cannot check or write the pipeline', needsStore, async (t) => {
  const { ui, view } = await paired(t);
  const read = await ui('owner-ui.pipeline');
  await view(2, 'historical', 7);
  await assert.rejects(
    ui('owner-ui.pipeline-preview', { pipeline: read.pipeline, expectDigest: read.fileDigest }, 2),
    (e: any) => e?.code === 'sentinel.ownerUi.readOnly',
  );
  // reading stays open
  assert.equal((await ui('owner-ui.pipeline', {}, 2)).schema, 'sentinel-viewer-pipeline/draft-1');
});
