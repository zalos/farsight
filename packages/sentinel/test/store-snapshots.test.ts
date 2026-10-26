// Snapshot admission in the ledger (PR 04): unbound stages accepted together in one transaction, the fence, the
// collection roots, immutability, and the schema upgrade that brought it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openLedger, type Ledger } from '../dist/store/ledger.js';
import { LEDGER_MIGRATIONS } from '../dist/store/migrations.js';
import { LedgerError } from '../dist/store/store-types.js';
import {
  FakeOwner,
  OBJECTS,
  attemptEnvelope,
  identityReceipt,
  runEnvelope,
  scratch,
  sha,
  unstoredReceipt,
  workEnvelope,
} from './store-helpers.ts';

const code = (c: string) => (e: unknown) => e instanceof LedgerError && e.code === c;
const DIGEST = `sha256:${'d'.repeat(64)}`;
let epochs = 0;

async function ledgerAt(t: { after(fn: () => void): void }, dir = scratch(t)) {
  const owner = new FakeOwner(dir, `epoch-snap-${++epochs}`);
  const ledger = await openLedger(owner, { objects: OBJECTS });
  t.after(() => {
    try {
      ledger.close();
    } catch {
      /* closed by the test */
    }
  });
  return { dir, owner, ledger };
}

/** Two content stages and a roots stage, the way capture registers them; returns what admission needs. */
function stageCapture(ledger: Ledger, tag: string) {
  const contents = [`${tag} a`, `${tag} b`, `${tag} c`];
  const manifestText = `${tag} manifest`;
  const sidecarText = `${tag} materialization`;
  ledger.registerStaging(
    `${tag}.stage-0`,
    contents.slice(0, 2).map((c) => ({ id: sha(c), schema: 'application/octet-stream', privacy: 'source' as const })),
  );
  ledger.registerStaging(
    `${tag}.stage-1`,
    contents.slice(2).map((c) => ({ id: sha(c), schema: 'application/octet-stream', privacy: 'source' as const })),
  );
  ledger.registerStaging(`${tag}.stage-2`, [
    { id: sha(manifestText), schema: 'sentinel-snapshot/draft-1', privacy: 'source-derived', links: contents.map(sha) },
    {
      id: sha(sidecarText),
      schema: 'sentinel-capture-materialization/draft-1',
      privacy: 'source',
      links: [sha(manifestText)],
    },
  ]);
  const receipts = [...contents, manifestText, sidecarText].map(identityReceipt);
  return {
    contents: contents.map(sha),
    input: {
      snapshotId: `snap-${tag}`,
      stageIds: [`${tag}.stage-0`, `${tag}.stage-1`, `${tag}.stage-2`],
      manifest: sha(manifestText),
      materialization: sha(sidecarText),
      inventoryDigest: DIGEST,
      receipts,
    },
  };
}

test('a snapshot is admitted from unbound stages in one transaction and becomes a collection root', async (t) => {
  const { ledger } = await ledgerAt(t);
  const { input, contents } = stageCapture(ledger, 'one');
  assert.ok(ledger.gcSnapshot().staged.includes(contents[0]!), 'pinned while staged');
  const record = ledger.admitSnapshot(input);
  assert.deepEqual(
    { ...record, admittedAt: undefined, sequence: undefined },
    {
      snapshotId: 'snap-one',
      manifest: input.manifest,
      materialization: input.materialization,
      inventoryDigest: DIGEST,
      admittedAt: undefined,
      sequence: undefined,
    },
  );
  assert.deepEqual(ledger.getSnapshot('snap-one'), record);
  assert.equal(ledger.getSnapshot('snap-none'), undefined);
  const gc = ledger.gcSnapshot();
  assert.deepEqual(gc.staged, [], 'every stage was released');
  assert.ok(gc.referenced.includes(input.manifest) && gc.referenced.includes(input.materialization));
  for (const c of contents)
    assert.ok(
      gc.links.some(([p, ch]) => p === input.manifest && ch === c),
      'content reachable through the manifest',
    );
  assert.equal(gc.sequence, record.sequence);
  const last = ledger.readEvents({ after: record.sequence - 1 }).events[0]!;
  assert.deepEqual([last.kind, last.payload], ['snapshot-admitted', { snapshotId: 'snap-one', artifacts: 5 }]);
  assert.deepEqual(ledger.checkIntegrity(), { integrity: 'ok', foreignKeyViolations: 0 });
});

test('admission refuses mismatched receipts, unverifiable bytes, bound or foreign stages and a reused id', async (t) => {
  const { ledger, dir } = await ledgerAt(t);
  const { input } = stageCapture(ledger, 'two');
  const without = input.receipts.slice(1);
  assert.throws(() => ledger.admitSnapshot({ ...input, receipts: without }), code('sentinel.store.stagingMismatch'));
  assert.throws(
    () => ledger.admitSnapshot({ ...input, stageIds: input.stageIds.slice(1) }),
    code('sentinel.store.stagingMismatch'),
  );
  assert.throws(
    () => ledger.admitSnapshot({ ...input, manifest: sha('never staged') }),
    code('sentinel.store.stagingMismatch'),
  );
  const forged = [...input.receipts.slice(0, -1), unstoredReceipt('two materialization, never stored')];
  assert.throws(() => ledger.admitSnapshot({ ...input, receipts: forged }), code('sentinel.store.objectMissing'));
  assert.throws(
    () => ledger.admitSnapshot({ ...input, materialization: input.manifest }),
    code('sentinel.store.invalidInput'),
  );
  assert.throws(
    () => ledger.admitSnapshot({ ...input, stageIds: [...input.stageIds, input.stageIds[0]!] }),
    code('sentinel.store.invalidInput'),
  );
  // Nothing was accepted by the refusals.
  assert.ok(ledger.gcSnapshot().staged.length > 0);
  assert.equal(ledger.getSnapshot('snap-two'), undefined);
  ledger.admitSnapshot(input);
  const again = stageCapture(ledger, 'two-again');
  assert.throws(
    () => ledger.admitSnapshot({ ...again.input, snapshotId: 'snap-two' }),
    code('sentinel.store.conflict'),
  );

  // A stage bound to an attempt cannot be admitted as a snapshot.
  ledger.createRun(runEnvelope(ledger.epoch) as never);
  ledger.createWork(workEnvelope(ledger.epoch) as never);
  ledger.startAttempt(
    attemptEnvelope(ledger.epoch, { id: 'att-1', ordinal: 1, work: { id: 'work-pattern-api', revision: 1 } }) as never,
  );
  ledger.registerStaging('bound', [{ id: sha('bound x'), schema: 'text/plain', privacy: 'metadata' }], {
    work: { id: 'work-pattern-api', revision: 1 },
    attemptId: 'att-1',
  });
  identityReceipt('bound x');
  assert.throws(
    () =>
      ledger.admitSnapshot({
        ...again.input,
        stageIds: [...again.input.stageIds, 'bound'],
        receipts: [...again.input.receipts, identityReceipt('bound x')],
      }),
    code('sentinel.store.stagingMismatch'),
  );

  // An attempt's stage may not link to an artifact only another stage holds; an unbound stage may.
  ledger.registerStaging('loose', [{ id: sha('loose y'), schema: 'text/plain', privacy: 'metadata' }]);
  assert.throws(
    () =>
      ledger.registerStaging(
        'bound-link',
        [{ id: sha('bound z'), schema: 'text/plain', privacy: 'metadata', links: [sha('loose y')] }],
        { work: { id: 'work-pattern-api', revision: 1 }, attemptId: 'att-1' },
      ),
    code('sentinel.store.stagingMismatch'),
  );
  ledger.registerStaging('unbound-link', [
    { id: sha('unbound z'), schema: 'text/plain', privacy: 'metadata', links: [sha('loose y')] },
  ]);

  // A successor owner's epoch cannot admit stages a previous owner registered.
  ledger.close();
  const next = await openLedger(new FakeOwner(dir, `epoch-snap-${++epochs}`), { objects: OBJECTS });
  t.after(() => next.close());
  assert.throws(
    () => next.admitSnapshot({ ...again.input, snapshotId: 'snap-late' }),
    code('sentinel.store.stagingMismatch'),
  );
});

test('an admission replays under its idempotency key and refuses a different request with it', async (t) => {
  const { ledger } = await ledgerAt(t);
  const { input } = stageCapture(ledger, 'idem');
  const idempotency = { clientId: 'capture', key: 'k-1' };
  const first = ledger.admitSnapshot({ ...input, idempotency });
  assert.deepEqual(ledger.admitSnapshot({ ...input, idempotency }), first, 'the same request replays its result');
  assert.throws(
    () => ledger.admitSnapshot({ ...input, inventoryDigest: `sha256:${'e'.repeat(64)}`, idempotency }),
    code('sentinel.store.idempotencyConflict'),
  );
});

test('snapshot rows are immutable', async (t) => {
  const { ledger } = await ledgerAt(t);
  ledger.admitSnapshot(stageCapture(ledger, 'imm').input);
  ledger.close();
  const db = new DatabaseSync(ledger.path);
  t.after(() => db.close());
  assert.throws(
    () => db.exec("UPDATE snapshots SET inventory_digest = inventory_digest WHERE id = 'snap-imm'"),
    /appendOnly: snapshots/,
  );
  assert.throws(() => db.exec("DELETE FROM snapshots WHERE id = 'snap-imm'"), /appendOnly: snapshots/);
  assert.throws(() => db.exec('DELETE FROM events'), /appendOnly: events/, 'the rebuilt event log keeps its triggers');
});

test('a foundation-schema ledger upgrades in place: every event and its references survive, keys are enforced again', async (t) => {
  const dir = scratch(t);
  const owner = new FakeOwner(dir, `epoch-snap-${++epochs}`);
  const old = await openLedger(owner, { objects: OBJECTS, migrations: LEDGER_MIGRATIONS.slice(0, 1) });
  old.createRun(runEnvelope(old.epoch) as never);
  old.createWork(workEnvelope(old.epoch) as never);
  old.startAttempt(
    attemptEnvelope(old.epoch, { id: 'att-1', ordinal: 1, work: { id: 'work-pattern-api', revision: 1 } }) as never,
  );
  const out = identityReceipt('upgrade output');
  old.registerStaging('s-1', [{ id: out.id, schema: 'text/plain', privacy: 'metadata' }], {
    work: { id: 'work-pattern-api', revision: 1 },
    attemptId: 'att-1',
  });
  old.publish({
    work: { id: 'work-pattern-api', revision: 1 },
    attemptId: 'att-1',
    stageId: 's-1',
    receipts: [out],
    outputs: [out.id],
    endedAt: '2026-10-21T12:01:00Z',
  });
  const before = old.readEvents({ after: 0, limit: 500 }).events;
  old.close();

  const upgraded = await openLedger(new FakeOwner(dir, `epoch-snap-${++epochs}`), { objects: OBJECTS });
  t.after(() => upgraded.close());
  assert.deepEqual(
    { from: upgraded.migration.from, to: upgraded.migration.to },
    { from: 1, to: LEDGER_MIGRATIONS.length },
  );
  assert.ok(upgraded.migration.backupPath, 'a verified backup was taken first');
  const after = upgraded.readEvents({ after: 0, limit: 500 }).events;
  assert.deepEqual(after.slice(0, before.length), before, 'every event, sequence and payload is unchanged');
  assert.equal(upgraded.getPublication({ id: 'work-pattern-api', revision: 1 })!.attemptId, 'att-1');
  assert.deepEqual(upgraded.checkIntegrity(), { integrity: 'ok', foreignKeyViolations: 0 });
  const record = upgraded.admitSnapshot(stageCapture(upgraded, 'upg').input);
  assert.ok(record.sequence > before.at(-1)!.sequence, 'sequences continue after the copied rows');
  upgraded.close();
  const db = new DatabaseSync(upgraded.path);
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  assert.throws(
    () => db.exec(`INSERT INTO reports (id, run_id, sequence, created_at) VALUES ('r', 'run-1', 999999, 'x')`),
    /FOREIGN KEY/,
  );
});

test('every admitted artifact must be reachable from the manifest or the materialization', async (t) => {
  const { ledger } = await ledgerAt(t);
  // An extra artifact in a selected stage that no root links to is refused, atomically.
  const { input } = stageCapture(ledger, 'reach');
  ledger.registerStaging('reach.extra', [{ id: sha('orphan bytes'), schema: 'text/plain', privacy: 'source' }]);
  const withOrphan = {
    ...input,
    stageIds: [...input.stageIds, 'reach.extra'],
    receipts: [...input.receipts, identityReceipt('orphan bytes')],
  };
  const before = ledger.currentSequence();
  assert.throws(() => ledger.admitSnapshot(withOrphan), code('sentinel.store.stagingMismatch'));
  assert.equal(ledger.currentSequence(), before, 'nothing committed');
  assert.equal(ledger.getSnapshot('snap-reach'), undefined);
  assert.ok(ledger.gcSnapshot().staged.includes(sha('orphan bytes')), 'the stages stay pinned');
  // Without the orphan stage the same capture is admitted, and nothing it admitted is a prune candidate.
  ledger.admitSnapshot(input);
  const gc = ledger.gcSnapshot();
  const reachable = new Set([input.manifest, input.materialization]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [p, c] of gc.links)
      if (reachable.has(p) && !reachable.has(c)) {
        reachable.add(c);
        grew = true;
      }
  }
  for (const r of input.receipts) assert.ok(reachable.has(r.id), r.id);

  // A cycle among staged artifacts terminates; a link to an artifact staged in a stage not selected is refused.
  const a = 'cycle a',
    b = 'cycle b',
    m = 'cycle manifest',
    z = 'cycle sidecar';
  ledger.registerStaging('cycle.held', [{ id: sha('held elsewhere'), schema: 'text/plain', privacy: 'source' }]);
  ledger.registerStaging('cycle.0', [
    { id: sha(a), schema: 'text/plain', privacy: 'source', links: [sha(b)] },
    { id: sha(b), schema: 'text/plain', privacy: 'source', links: [sha(a)] },
    {
      id: sha(m),
      schema: 'sentinel-snapshot/draft-1',
      privacy: 'source-derived',
      links: [sha(a), sha('held elsewhere')],
    },
    { id: sha(z), schema: 'sentinel-capture-materialization/draft-1', privacy: 'source', links: [sha(m)] },
  ]);
  const cycle = {
    snapshotId: 'snap-cycle',
    stageIds: ['cycle.0'],
    manifest: sha(m),
    materialization: sha(z),
    inventoryDigest: DIGEST,
    receipts: [a, b, m, z].map(identityReceipt),
  };
  assert.throws(
    () => ledger.admitSnapshot(cycle),
    code('sentinel.store.stagingMismatch'),
    'a link into an unselected stage dangles',
  );
  identityReceipt('held elsewhere');
  const record = ledger.admitSnapshot({
    ...cycle,
    stageIds: ['cycle.0', 'cycle.held'],
    receipts: [...cycle.receipts, identityReceipt('held elsewhere')],
  });
  assert.equal(record.snapshotId, 'snap-cycle');

  // A link to content an earlier snapshot already accepted is allowed without staging it again.
  ledger.registerStaging('reuse.0', [
    {
      id: sha('reuse manifest'),
      schema: 'sentinel-snapshot/draft-1',
      privacy: 'source-derived',
      links: [sha('reach a')],
    },
    {
      id: sha('reuse sidecar'),
      schema: 'sentinel-capture-materialization/draft-1',
      privacy: 'source',
      links: [sha('reuse manifest')],
    },
  ]);
  ledger.admitSnapshot({
    snapshotId: 'snap-reuse',
    stageIds: ['reuse.0'],
    manifest: sha('reuse manifest'),
    materialization: sha('reuse sidecar'),
    inventoryDigest: DIGEST,
    receipts: ['reuse manifest', 'reuse sidecar'].map(identityReceipt),
  });
  assert.deepEqual(ledger.checkIntegrity(), { integrity: 'ok', foreignKeyViolations: 0 });
});
