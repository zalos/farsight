// The supported store facade end to end: the real owner lock, the real ledger and the real object store, with no
// stand-in. Synthetic records only; no repository, scanner, model or network is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, STORAGE_ERROR_CODES, type SentinelStore } from '../dist/store/index.js';
import * as root from '../dist/index.js';

const DIST = fileURLToPath(new URL('../dist/store/index.js', import.meta.url));
const VALID = fileURLToPath(new URL('./contracts/valid/', import.meta.url));
const load = (name: string) => JSON.parse(readFileSync(`${VALID}${name}.json`, 'utf8'));
const W1 = { id: 'work-pattern-api', revision: 1 };
const ENDED = '2026-10-21T12:01:00Z';
const coded = (code: string) => (e: unknown) => (e as { code?: unknown })?.code === code;

/** A canonical, private scratch folder; the store is created inside it. */
function scratch(t: { after(fn: () => void): void }): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-store-it-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'store');
}

const run = (epoch: string, over: Record<string, unknown> = {}) => ({ ...load('run-active'), coordinatorEpoch: epoch, ...over });
const work = (epoch: string, over: Record<string, unknown> = {}) =>
  ({ ...load('work-idle'), coordinatorEpoch: epoch, id: W1.id, state: 'ready', dependencies: [], ...over });
const attempt = (epoch: string, over: Record<string, unknown> = {}) => ({
  ...load('attempt-running'), coordinatorEpoch: epoch, work: W1,
  worker: { kind: 'owned-child', pid: 4242, processStartedAt: '2026-10-21T12:00:00Z' }, ...over,
});

/** Runs a script in a fresh Node process against the built facade; returns its parsed JSON line. */
function child(source: string, storePath: string): Record<string, unknown> {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
    `const { openStore } = await import(${JSON.stringify(DIST)}); const storePath = ${JSON.stringify(storePath)};\n${source}`],
  { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!);
}

/** A run, one ready work revision and its running attempt under the store's current epoch. */
function begin(store: SentinelStore, attemptId = 'att-1') {
  store.ledger.createRun(run(store.epoch) as never);
  store.ledger.createWork(work(store.epoch) as never);
  store.ledger.startAttempt(attempt(store.epoch, { id: attemptId, ordinal: 1 }) as never);
}

test('stage before write, durable put, transactional accept; a new process reads the artifact back', async t => {
  const storePath = scratch(t);
  const store = await openStore(storePath, { build: 'store-integration' });
  let closed = false;
  t.after(() => { if (!closed) store.close(); });
  assert.equal(store.storePath, storePath);
  assert.match(store.epoch, /^epoch-/);
  assert.equal(store.migration.backupPath, null, 'a new ledger needs no backup');
  begin(store);

  const finding = { schema: 'sentinel-observation/draft-1', note: 'synthetic' };
  const quoted = Buffer.from('const token = read();\n');
  const findingId = store.objects.identifyCanonicalJson(finding);
  const quotedId = store.objects.identify(quoted);
  // The identities are pinned durably before a byte is written.
  store.ledger.registerStaging('stage-1', [
    { id: findingId.id, schema: 'sentinel-observation/draft-1', privacy: 'source-derived', links: [quotedId.id] },
    { id: quotedId.id, schema: 'text/plain', privacy: 'source' },
  ], { work: W1, attemptId: 'att-1' });
  assert.deepEqual(store.ledger.getPublication(W1), null);
  const pending = await store.inspect();
  assert.deepEqual([...pending.pendingStaged].sort(), [findingId.id, quotedId.id].sort(), 'staged and not yet written');

  await assert.rejects(store.objects.put(Buffer.from('other bytes'), { expect: quotedId }), coded('sentinel.object.digestMismatch'));
  const receipts = [
    await store.objects.putCanonicalJson(finding, { expect: findingId }),
    await store.objects.put(quoted, { expect: quotedId }),
  ];
  assert.equal(receipts[0]!.id, findingId.id);
  const accepted = store.ledger.publish({ work: W1, attemptId: 'att-1', stageId: 'stage-1', receipts, outputs: [findingId.id], endedAt: ENDED });
  assert.match(accepted.resultDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(store.ledger.getPublication(W1)!.outputs.map(o => o.id), [findingId.id]);
  assert.deepEqual(await store.readArtifact(quotedId.id), quoted);
  assert.deepEqual(store.checkIntegrity(), { integrity: 'ok', foreignKeyViolations: 0 });

  const report = await store.inspect();
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.deepEqual([...report.reachable].sort(), [findingId.id, quotedId.id].sort());
  const plan = await store.planPrune();
  assert.equal(plan.ok, true);
  assert.equal(plan.deleted, 0);
  assert.deepEqual(plan.candidates, []);

  const firstEpoch = store.epoch;
  store.close();
  closed = true;
  assert.equal(store.held, false);
  assert.ok(!existsSync(join(storePath, 'owner.json')), 'the holder removed its descriptor');

  const reopened = child(`
    const store = await openStore(storePath);
    const pub = store.ledger.getPublication(${JSON.stringify(W1)});
    const finding = JSON.parse((await store.readArtifact(pub.outputs[0].id)).toString('utf8'));
    let stale = null;
    try { store.ledger.createRun(${JSON.stringify(run(firstEpoch, { id: 'run-stale' }))}); } catch (e) { stale = e.code; }
    const integrity = store.checkIntegrity();
    store.close();
    console.log(JSON.stringify({ epoch: store.epoch, storeId: store.storeId, finding, stale, integrity }));
  `, storePath);
  assert.notEqual(reopened.epoch, firstEpoch, 'every acquisition has its own epoch');
  assert.equal(reopened.storeId, store.storeId, 'the store keeps its identity');
  assert.deepEqual(reopened.finding, finding);
  assert.equal(reopened.stale, 'sentinel.store.staleEpoch', 'a record from the earlier epoch is refused');
  assert.deepEqual(reopened.integrity, { integrity: 'ok', foreignKeyViolations: 0 });
});

test('an attempt started under an earlier owner cannot publish after a takeover', async t => {
  const storePath = scratch(t);
  const first = await openStore(storePath);
  begin(first);
  const bytes = Buffer.from('late result');
  const id = first.objects.identify(bytes);
  first.ledger.registerStaging('stage-late', [{ id: id.id, schema: 'text/plain', privacy: 'metadata' }], { work: W1, attemptId: 'att-1' });
  const receipt = await first.objects.put(bytes, { expect: id });
  first.close();

  const second = await openStore(storePath);
  t.after(() => second.close());
  assert.throws(() => second.ledger.publish({ work: W1, attemptId: 'att-1', stageId: 'stage-late', receipts: [receipt], outputs: [id.id], endedAt: ENDED }),
    coded('sentinel.store.staleEpoch'));
  assert.equal(second.ledger.getPublication(W1), null);
  // The closed handle refuses use instead of writing under a lock it no longer holds.
  assert.throws(() => first.ledger.createRun(run(first.epoch, { id: 'run-after-close' }) as never), coded('sentinel.store.closed'));
  assert.throws(() => first.assertHeld(), coded('sentinel.store.ownerClosed'));
});

test('a failed or lost write never yields an accepted reference', async t => {
  const storePath = scratch(t);
  const store = await openStore(storePath);
  t.after(() => store.close());
  begin(store);
  const bytes = Buffer.from('evidence that will not survive');
  const id = store.objects.identify(bytes);
  store.ledger.registerStaging('stage-lost', [{ id: id.id, schema: 'text/plain', privacy: 'source' }], { work: W1, attemptId: 'att-1' });
  const receipt = await store.objects.put(bytes, { expect: id });

  // The bytes disappear between the write and the accept (a crash, a disk fault, an operator).
  const shard = join(storePath, 'objects', 'sha256', id.id.slice(7, 9));
  for (const name of readdirSync(shard)) unlinkSync(join(shard, name));
  assert.throws(() => store.ledger.publish({ work: W1, attemptId: 'att-1', stageId: 'stage-lost', receipts: [receipt], outputs: [id.id], endedAt: ENDED }),
    coded('sentinel.store.objectMissing'));
  assert.equal(store.ledger.getPublication(W1), null);
  assert.deepEqual(store.ledger.objectsOf(id.id), [], 'no representation was recorded');
  await assert.rejects(store.readArtifact(id.id), coded('sentinel.store.notFound'));

  // A receipt for bytes that were never written is refused the same way, and the stage stays pinned.
  const forged = { ...receipt, storedSize: receipt.storedSize + 1 };
  assert.throws(() => store.ledger.publish({ work: W1, attemptId: 'att-1', stageId: 'stage-lost', receipts: [forged], outputs: [id.id], endedAt: ENDED }),
    (e: unknown) => ['sentinel.store.objectMissing', 'sentinel.store.invalidInput'].includes((e as { code?: string }).code ?? ''));
  const report = await store.inspect();
  assert.deepEqual(report.pendingStaged, [id.id]);
  assert.deepEqual(store.checkIntegrity(), { integrity: 'ok', foreignKeyViolations: 0 });
});

test('one owner at a time, and a failed open releases the lock', async t => {
  const storePath = scratch(t);
  const store = await openStore(storePath);
  await assert.rejects(openStore(storePath), coded('sentinel.store.ownedElsewhere'));
  const busy = child(`
    try { (await openStore(storePath, { waitMs: 0 })).close(); console.log(JSON.stringify({ code: null })); }
    catch (e) { console.log(JSON.stringify({ code: e.code })); }
  `, storePath);
  assert.equal(busy.code, 'sentinel.store.ownedElsewhere');
  store.close();
  store.close();

  // Replace the ledger with a database Sentinel did not write: the open refuses and releases the owner lock.
  rmSync(join(storePath, 'ledger.sqlite'));
  for (const suffix of ['-wal', '-shm']) rmSync(join(storePath, `ledger.sqlite${suffix}`), { force: true });
  const sqlite = await import('node:sqlite');
  const foreign = new sqlite.DatabaseSync(join(storePath, 'ledger.sqlite'));
  foreign.exec('CREATE TABLE unrelated (x INTEGER)');
  foreign.close();
  await assert.rejects(openStore(storePath), coded('sentinel.store.notLedger'));
  const after = child(`
    try { (await openStore(storePath, { waitMs: 0 })).close(); console.log(JSON.stringify({ code: null })); }
    catch (e) { console.log(JSON.stringify({ code: e.code })); }
  `, storePath);
  assert.equal(after.code, 'sentinel.store.notLedger', 'another process can take the lock the failed open released');
  rmSync(join(storePath, 'ledger.sqlite'));
  const fresh = await openStore(storePath);
  t.after(() => fresh.close());
  assert.ok(fresh.held);
});

test('the facade exposes domain operations only', async t => {
  const store = await openStore(scratch(t));
  t.after(() => store.close());
  assert.ok(Object.isFrozen(store) && Object.isFrozen(store.ledger) && Object.isFrozen(store.objects));
  for (const name of ['db', 'sqlite', 'owner', 'connection']) assert.ok(!(name in store), name);
  for (const name of ['close', 'gcSnapshot', 'path', 'checkIntegrity']) assert.ok(!(name in store.ledger), `ledger.${name}`);
  assert.equal(typeof store.runtime.sqlite, 'string', 'the SQLite release, not the module');
  assert.equal(root.openStore, openStore, 'the root export is the same facade');
  assert.equal(root.CAPABILITIES.find(c => c.id === 'ledger')?.state, 'available-draft');
  assert.ok(root.CAPABILITIES.filter(c => c.id !== 'ledger' && c.id !== 'contract-validation').every(c => c.state === 'unavailable'),
    'no scan capability is claimed');
});

test('every storage reason code is a catalog entry with both registers and a define', async () => {
  const { STRINGS } = await import('@farsight/core/dist/strings.js');
  const all = Object.values(STORAGE_ERROR_CODES).flat();
  assert.equal(new Set(all).size, all.length, 'no two modules share a code');
  for (const code of all) {
    const entry = STRINGS[code];
    assert.ok(entry?.hud && entry.professional && entry.define, `${code} needs both registers and a define`);
  }
  const { SENTINEL_STORAGE_ERROR_STRINGS } = await import('@farsight/core/dist/strings-sentinel-storage-errors.js');
  const { SENTINEL_STORE_STRINGS } = await import('@farsight/core/dist/strings-sentinel-store.js');
  assert.deepEqual(Object.keys(SENTINEL_STORAGE_ERROR_STRINGS).sort(),
    [...STORAGE_ERROR_CODES.ledger, ...STORAGE_ERROR_CODES.objects, ...STORAGE_ERROR_CODES.gc].sort(), 'no stale catalog entry');
  assert.deepEqual(Object.keys(SENTINEL_STORAGE_ERROR_STRINGS).filter(k => k in SENTINEL_STORE_STRINGS), [], 'no key shadows another module');
  assert.ok(STRINGS['sentinel.capability.draftStore']?.define);
});

test('importing the facade opens nothing', () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-store-import-')));
  try {
    const script = join(dir, 'probe.mjs');
    writeFileSync(script, `await import(${JSON.stringify(DIST)}); console.log(JSON.stringify(Object.keys(process.versions).includes('sqlite')));`);
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', cwd: dir, timeout: 10_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '', 'node:sqlite is not loaded at import, so no experimental warning');
    assert.deepEqual(readdirSync(dir), ['probe.mjs'], 'no file was created');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
