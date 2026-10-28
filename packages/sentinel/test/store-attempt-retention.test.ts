import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../dist/store/index.js';
import { openLedger } from '../dist/store/ledger.js';
import { LEDGER_MIGRATIONS } from '../dist/store/migrations.js';
import { FakeOwner, FakeObjects, attemptEnvelope, runEnvelope, scratch, workEnvelope } from './store-helpers.ts';

const WORK = { id: 'work-pattern-api', revision: 1 };
const END = '2026-10-21T12:01:00Z';
const error = { code: 'sentinel.execution.workerExited', retryable: false };
const code = (wanted: string) => (e: any) => e?.code === wanted;

function seed(ledger: any, epoch: string, attemptId = 'attempt-retained') {
  ledger.createRun(runEnvelope(epoch) as never);
  ledger.createWork(workEnvelope(epoch) as never);
  ledger.startAttempt(attemptEnvelope(epoch, { id: attemptId, ordinal: 1, work: WORK }) as never);
}

test('a failed attempt keeps its private record and links after the source is gone; a prune dry run protects them', async (t) => {
  const dir = realpathSync.native(scratch(t));
  const source = join(dir, 'source.txt');
  writeFileSync(source, 'synthetic refused native source');
  let store = await openStore(join(dir, 'store'));
  t.after(() => store.close());
  store.ledger.createRun(runEnvelope(store.epoch) as never);
  const influenceBytes = Buffer.from('synthetic influence');
  const influence = store.objects.identify(influenceBytes);
  store.ledger.registerStaging('stage-influence', [
    { id: influence.id, schema: 'sentinel-influence/draft-1', privacy: 'metadata' },
  ]);
  const influenceReceipt = await store.objects.put(influenceBytes, { expect: influence });
  store.ledger.createWork(workEnvelope(store.epoch, { influenceManifest: influence.id }) as never, {
    records: { stageId: 'stage-influence', receipts: [influenceReceipt] },
  });
  const invocationBytes = Buffer.from('synthetic invocation');
  const invocation = store.objects.identify(invocationBytes);
  store.ledger.registerStaging('stage-invocation', [
    { id: invocation.id, schema: 'sentinel-invocation/draft-1', privacy: 'source' },
  ]);
  const invocationReceipt = await store.objects.put(invocationBytes, { expect: invocation });
  store.ledger.startAttempt(
    attemptEnvelope(store.epoch, {
      id: 'attempt-retained',
      ordinal: 1,
      work: WORK,
      invocation: invocation.id,
    }) as never,
    { records: { stageId: 'stage-invocation', receipts: [invocationReceipt] } },
  );

  const texts = ['synthetic transcript', 'synthetic share transcript', 'synthetic instructions'];
  const children = texts.map((text) => {
    const bytes = Buffer.from(text);
    return { bytes, ...store.objects.identify(bytes) };
  });
  const recordBody = {
    schema: 'sentinel-attempt-retained/draft-1',
    failure: error.code,
    completed: false,
    finalAnswer: null,
    filesRead: [],
    tools: [],
    task: { kind: 'synthetic' },
    provenance: { installationPath: '/synthetic/private/runner' },
    instructionRecord: { delivered: true },
    disclosure: 'owner-only',
    withholding: 'required',
    transcript: children[0]!.id,
    share: children[1]!.id,
    instructions: children[2]!.id,
  };
  const record = store.objects.identifyCanonicalJson(recordBody);
  store.ledger.registerStaging(
    'stage-retained',
    [
      { id: record.id, schema: recordBody.schema, privacy: 'source', links: children.map((c) => c.id) },
      ...children.map((c) => ({ id: c.id, schema: 'text/plain', privacy: 'source' as const })),
    ],
    { work: WORK, attemptId: 'attempt-retained' },
  );
  const receipts = [
    await store.objects.putCanonicalJson(recordBody, { expect: record }),
    ...(await Promise.all(children.map((c) => store.objects.put(c.bytes, { expect: c })))),
  ];
  const ended = store.ledger.endAttempt({
    work: WORK,
    attemptId: 'attempt-retained',
    state: 'failed',
    endedAt: END,
    workState: 'failed',
    error,
    retained: { stageId: 'stage-retained', receipts, record: record.id },
  });
  assert.equal(store.ledger.getAttempt('attempt-retained')!.envelope.error?.diagnostics, record.id);
  unlinkSync(source);
  store.close();
  store = await openStore(join(dir, 'store'));

  const kept = store.ledger.retainedOf('attempt-retained')!;
  assert.deepEqual(kept, {
    attemptId: 'attempt-retained',
    work: WORK,
    state: 'failed',
    code: error.code,
    record: { id: record.id, schema: recordBody.schema, privacy: 'source' },
    linked: children
      .map((c) => ({ id: c.id, schema: 'text/plain', privacy: 'source' }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    sequence: ended.sequence,
  });
  assert.equal(JSON.stringify(kept).includes('synthetic transcript'), false, 'the metadata read has no bytes');
  assert.deepEqual(JSON.parse((await store.readArtifact(record.id)).toString()), recordBody);
  const plan = await store.planPrune();
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  for (const id of [record.id, ...children.map((c) => c.id)]) {
    assert.ok(plan.report.reachable.includes(id));
    assert.equal(
      plan.candidates.some((c) => `sha256:${c.rawDigest}` === id),
      false,
    );
  }
});

test('a pre-attempt refusal keeps its catalog code and source-private detail after a store restart', async (t) => {
  const dir = realpathSync.native(scratch(t));
  let store = await openStore(join(dir, 'store'));
  t.after(() => store.close());
  store.ledger.createRun(runEnvelope(store.epoch) as never);
  store.ledger.createWork(workEnvelope(store.epoch, { state: 'pending' }) as never);
  const code = 'sentinel.provider.credentialUnavailable';
  const detail = { reason: 'native login is missing', provider: 'native' };
  assert.throws(
    () =>
      store.ledger.setWorkState(WORK, 'blocked', {
        reasonCode: code,
        refusalDetail: { credentialValue: 'synthetic credential' },
      }),
    (e: any) => e?.code === 'sentinel.store.invalidInput',
  );
  assert.equal(store.ledger.getWork(WORK)?.state, 'pending');
  const held = store.ledger.setWorkState(WORK, 'blocked', { reasonCode: code, refusalDetail: detail });
  assert.equal(store.ledger.countAttempts(WORK), 0, 'no attempt was fabricated');
  store.close();
  store = await openStore(join(dir, 'store'));
  assert.equal(store.ledger.getWork(WORK)?.reason, code);
  assert.deepEqual(store.ledger.refusalOf(WORK), {
    work: WORK,
    code,
    detail,
    privacy: 'source',
    sequence: held.sequence,
  });
  assert.throws(
    () =>
      store.ledger.setWorkState(WORK, 'ready', {
        refusalDetail: { reason: 'must remain blocked' },
      }),
    (e: any) => e?.code === 'sentinel.store.invalidInput',
  );
  store.ledger.setWorkState(WORK, 'ready');
  assert.equal(store.ledger.refusalOf(WORK), undefined, 'an old refusal is not the current reason');
  store.ledger.setWorkState(WORK, 'blocked', { reasonCode: code });
  assert.equal(store.ledger.refusalOf(WORK), undefined, 'an unannotated new hold does not reuse the old detail');
});

test('retention rolls back with the attempt end and refuses mismatched staging', async (t) => {
  const dir = scratch(t);
  const objects = new FakeObjects();
  const owner = new FakeOwner(dir, 'epoch-1');
  const ledger = await openLedger(owner, {
    objects,
    failpoint: (point) => {
      if (point === 'end:before-commit') throw new Error('simulated process death');
    },
  });
  t.after(() => ledger.close());
  seed(ledger, owner.epoch);
  const receipt = objects.put('private failed attempt record');
  ledger.registerStaging(
    'stage-retained',
    [{ id: receipt.id, schema: 'sentinel-attempt-retained/draft-1', privacy: 'source' }],
    {
      work: WORK,
      attemptId: 'attempt-retained',
    },
  );
  const input = {
    work: WORK,
    attemptId: 'attempt-retained',
    state: 'failed' as const,
    endedAt: END,
    workState: 'failed' as const,
    error,
    retained: { stageId: 'stage-retained', receipts: [receipt], record: receipt.id },
  };
  assert.throws(
    () => ledger.endAttempt({ ...input, retained: { ...input.retained, receipts: [] } }),
    code('sentinel.store.invalidInput'),
  );
  assert.throws(() => ledger.endAttempt({ ...input, error: undefined }), code('sentinel.store.invalidInput'));
  assert.throws(
    () => ledger.endAttempt({ ...input, retained: { ...input.retained, receipts: [receipt, receipt] } }),
    code('sentinel.store.invalidInput'),
  );
  assert.throws(
    () => ledger.endAttempt({ ...input, retained: { ...input.retained, receipts: [objects.put('not staged')] } }),
    code('sentinel.store.stagingMismatch'),
  );
  assert.throws(
    () => ledger.endAttempt({ ...input, retained: { ...input.retained, record: objects.put('unstaged').id } }),
    code('sentinel.store.stagingMismatch'),
  );
  assert.throws(
    () => ledger.endAttempt({ ...input, error: { ...error, diagnostics: objects.put('other').id } }),
    code('sentinel.store.invalidInput'),
  );
  assert.throws(() => ledger.endAttempt({ ...input, state: 'interrupted' }), code('sentinel.store.wrongState'));
  const foreignWork = { id: 'work-foreign', revision: 1 };
  ledger.createWork(workEnvelope(owner.epoch, { id: foreignWork.id }) as never);
  ledger.startAttempt(
    attemptEnvelope(owner.epoch, {
      id: 'attempt-foreign',
      ordinal: 1,
      work: foreignWork,
    }) as never,
  );
  const foreign = objects.put('foreign record');
  ledger.registerStaging(
    'stage-foreign',
    [{ id: foreign.id, schema: 'sentinel-attempt-retained/draft-1', privacy: 'source' }],
    { work: foreignWork, attemptId: 'attempt-foreign' },
  );
  assert.throws(
    () =>
      ledger.endAttempt({
        ...input,
        retained: { stageId: 'stage-foreign', receipts: [foreign], record: foreign.id },
      }),
    code('sentinel.store.stagingMismatch'),
  );
  assert.throws(() => ledger.endAttempt(input), /simulated process death/);
  assert.equal(ledger.getAttempt('attempt-retained')!.state, 'running');
  assert.equal(ledger.retainedOf('attempt-retained'), undefined);
  assert.deepEqual(ledger.objectsOf(receipt.id), []);
  assert.equal(
    ledger.listOpenStages().some((s) => s.stageId === 'stage-retained'),
    true,
  );
});

test('the retention table is append-only and refuses a running or succeeded attempt', async (t) => {
  const dir = scratch(t);
  const objects = new FakeObjects();
  const owner = new FakeOwner(dir, 'epoch-1');
  const ledger = await openLedger(owner, { objects });
  t.after(() => ledger.close());
  seed(ledger, owner.epoch);
  const receipt = objects.put('private retained record');
  ledger.registerStaging(
    'stage-retained',
    [{ id: receipt.id, schema: 'sentinel-attempt-retained/draft-1', privacy: 'source' }],
    {
      work: WORK,
      attemptId: 'attempt-retained',
    },
  );
  ledger.endAttempt({
    work: WORK,
    attemptId: 'attempt-retained',
    state: 'failed',
    endedAt: END,
    workState: 'ready',
    error,
    retained: { stageId: 'stage-retained', receipts: [receipt], record: receipt.id },
  });
  const db = new DatabaseSync(ledger.path);
  t.after(() => db.close());
  assert.throws(() => db.exec("UPDATE attempt_retained SET privacy = 'metadata'"), /appendOnly/);
  assert.throws(() => db.exec('DELETE FROM attempt_retained'), /appendOnly/);
  ledger.startAttempt(attemptEnvelope(owner.epoch, { id: 'attempt-next', ordinal: 2, work: WORK }) as never);
  const insert = db.prepare(`INSERT INTO attempt_retained
    (attempt_id, work_id, work_revision, artifact_id, role, schema, privacy, sequence)
    VALUES ('attempt-next', ?, 1, ?, 'linked', 'text/plain', 'source', ?)`);
  const sequence = ledger.currentSequence();
  assert.throws(() => insert.run(WORK.id, receipt.id, sequence), /wrongState/);
  const output = objects.put('published result');
  ledger.registerStaging('stage-published', [{ id: output.id, schema: 'text/plain', privacy: 'metadata' }], {
    work: WORK,
    attemptId: 'attempt-next',
  });
  ledger.publish({
    work: WORK,
    attemptId: 'attempt-next',
    stageId: 'stage-published',
    receipts: [output],
    outputs: [output.id],
    endedAt: END,
  });
  assert.throws(() => insert.run(WORK.id, receipt.id, ledger.currentSequence()), /wrongState/);
  assert.throws(
    () =>
      ledger.endAttempt({
        work: WORK,
        attemptId: 'attempt-next',
        state: 'failed',
        endedAt: END,
        workState: 'failed',
        error,
        retained: { stageId: 'stage-published', receipts: [output], record: output.id },
      }),
    code('sentinel.store.alreadyPublished'),
  );
});

test('a ledger below migration 7 refuses retention', async (t) => {
  const dir = scratch(t);
  const owner = new FakeOwner(dir, 'epoch-1');
  const ledger = await openLedger(owner, { migrations: LEDGER_MIGRATIONS.slice(0, 6) });
  t.after(() => ledger.close());
  assert.throws(
    () =>
      ledger.endAttempt({
        work: WORK,
        attemptId: 'missing',
        state: 'failed',
        endedAt: END,
        workState: 'failed',
        error,
        retained: { stageId: 'stage', receipts: [], record: `sha256:${'0'.repeat(64)}` },
      }),
    code('sentinel.store.wrongState'),
  );
  assert.equal(ledger.retainedOf('missing'), undefined);
});
