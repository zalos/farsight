// Genuine owner, retained accepted bootstrap and consumed owner receipts. No fake attempts or source execution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, lstatSync, existsSync } from 'node:fs';
import { normalizeImport } from '../dist/imports/normalize.js';
import { Coordinator } from '../dist/execution/coordinator.js';
import { retainedSourceForAdmission } from '../dist/execution/retained-source.js';
import { recoverStore, IntentFiles, WorkerFiles } from '../dist/execution/recovery.js';
import { prepareReportImport, reportImportBinding, authorizeReportImport, readEvidencePermit, EVIDENCE_LIMITS, checkEvidenceBounds } from '../dist/evidence/import-operation.js';
import { evidenceLedgerFor, bindEvidenceLedger } from '../dist/store/evidence-binding.js';
import { boundOwner } from '../dist/store/owner-binding.js';
import { openStore } from '../dist/store/index.js';
import { admit } from '../dist/policy/admission.js';
import { effectivePolicy, DEFAULT_SETTINGS } from '../dist/policy/settings.js';
import { ReceiptBook } from '../dist/policy/receipts.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { canonicalJson, digestOf } from '../dist/store/ledger-json.js';
import { retainedFixture } from './retained-analysis-helpers.ts';
import { needsStore } from './snapshot-helpers.ts';

const timing = () => ({ signal: new AbortController().signal });
const raw = Buffer.from(JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'original-synthetic' } }, results: [] }] }));
const manifest = Buffer.from(JSON.stringify({ schema: 'sentinel-import-manifest/draft-1', format: 'sarif-2.1.0', producer: { name: null, version: null },
  tested: { origins: ['https://example.test'], methods: ['GET'], properties: ['cookie-secure'], directions: ['outbound'] } }));
const refused = (e: any) => typeof e?.code === 'string' && e.code.startsWith('sentinel.');
async function fixture(t: any) {
  const s = await retainedFixture(t, { otherSource: true });
  const done = await (await Coordinator.open({ store: s.store, runId: s.run.id, registry: s.registry, scratchRoot: s.work })).run();
  assert.equal(done.state, 'completed', JSON.stringify(done.failures));
  const run = s.store.ledger.getRun(s.run.id)!;
  const ancestor = { runId: s.run.id, revision: run.planRevision, planDigest: s.store.ledger.getPlan(s.run.id, run.planRevision)!.digest, snapshotId: s.snapshot.id, sourceId: 'app' };
  const proof = await retainedSourceForAdmission(s.store, ancestor, timing());
  const currentPolicy = effectivePolicy({ trust: 'adopted', settings: { ...structuredClone(DEFAULT_SETTINGS), grants: [{ actions: ['evidence.import'], principals: ['human'], scope: { effects: ['local-artifacts'] } }] },
    settingsDigest: digestOf('current owner import settings'), repoConfig: null, repoConfigDigest: null });
  assert.notEqual(currentPolicy.revision, s.policy.revision, 'current admission policy intentionally differs from the historical run');
  return { ...s, ancestor, proof, currentPolicy, book: new ReceiptBook(join(s.dir, 'owner-receipts')) };
}
function prepared(s: any, report = raw) { return prepareReportImport(s.store, s.proof, s.ancestor, s.currentPolicy, timing(), report, manifest); }
function spend(s: any, p = prepared(s)) {
  const binding = reportImportBinding(p), now = new Date();
  const receipt = issueReceipt(s.book, { channel: 'owner-cli', principal: 'owner' }, binding, { now, ttlMs: 60000 });
  const admitted = admit({ intent: binding.intent, stateDigest: binding.stateDigest, policy: s.currentPolicy,
    requestedBy: { principal: 'human', channel: 'owner-cli' }, capability: () => ({ available: true, detail: 'local pending storage' }),
    credential: () => ({ basis: 'local-only', detail: 'no remote capability' }), receipt: { book: s.book, id: receipt.id }, now });
  assert.equal(admitted.record.outcome, 'admitted'); assert.ok(admitted.receipt);
  const consumed = admitted.receipt;
  return { p, consumed, permit: authorizeReportImport(p, consumed) };
}
function writes(store: any) {
  let objects = 0;
  const walk = (path: string) => { for (const n of readdirSync(path)) { const p = join(path, n); if (lstatSync(p).isDirectory()) walk(p); else objects++; } };
  walk(join(store.storePath, 'objects'));
  return { sequence: store.ledger.currentSequence(), objects };
}

function pins(store: any): string[] {
  const db = new DatabaseSync(join(store.storePath, 'ledger.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT DISTINCT artifact_id FROM staging_artifacts ORDER BY artifact_id').all().map(r => String(r.artifact_id)); }
  finally { db.close(); }
}

test('source-gone preparation/confirmation has no store effects; only an exact genuine receipt opens and pins import bytes', needsStore, async t => {
  const s = await fixture(t), ops = evidenceLedgerFor(s.store), before = writes(s.store);
  assert.equal(existsSync(s.repo), false);
  const input = Buffer.from(raw), p = prepared(s, input), original = reportImportBinding(p);
  input.fill(0);
  assert.deepEqual(reportImportBinding(p), original, 'input mutation cannot change prepared identities');
  assert.deepEqual(writes(s.store), before, 'preparation and waiting for confirmation write nothing');
  for (const fake of [{}, { ...p }, structuredClone(p), new Proxy(p, {})]) assert.throws(() => reportImportBinding(fake as any), refused);
  const receipt = issueReceipt(s.book, { channel: 'owner-cli', principal: 'owner' }, original, { now: new Date(), ttlMs: 60000 });
  assert.throws(() => authorizeReportImport(p, { receipt, digest: digestOf(receipt) } as any), refused, 'issued-but-unspent JSON grants nothing');
  assert.deepEqual(writes(s.store), before);
  const spent = s.book.consume(receipt.id, original, new Date()), permit = authorizeReportImport(p, spent);
  for (const fake of [{}, { ...permit }, structuredClone(permit), new Proxy(permit, {})]) assert.throws(() => ops.begin(fake as any), refused);
  const opened = ops.begin(permit), stage = ops.stage(permit), identity = ops.operation(opened.operationId)!.identity;
  assert.equal(identity.receiptDigest, spent.digest);
  assert.equal(identity.candidateDigest, original.intent.input);
  assert.equal(identity.ancestor.sourceId, 'app');
  assert.ok(identity.closure.length > 0);
  assert.equal(writes(s.store).objects, before.objects, 'staging only pins; no imported object byte written yet');
  assert.equal(s.store.ledger.listOpenStages(500, { domain: 'evidence' })[0]!.stageId, stage.stageId);
  for (const a of identity.artifacts) assert.ok(pins(s.store).includes(a.id));
  assert.equal((s.store.ledger as any).beginEvidence, undefined);
  assert.equal((s.store as any).evidence, undefined);
  assert.throws(() => ops.begin(authorizeReportImport(p, spent)), refused, 'one genuine consumed receipt cannot open a second operation');
  ops.abort(permit);
  assert.equal(ops.operation(opened.operationId)!.state, 'aborted');
  assert.throws(() => ops.stage(permit), refused);
});

test('candidate, state, policy, source and foreign-store receipt/proof substitutions refuse before events', needsStore, async t => {
  const s = await fixture(t), other = await fixture(t), p = prepared(s), changed = prepared(s, Buffer.from(raw.toString().replace('original-synthetic', 'different-synthetic')));
  const { consumed } = spend(s, p), before = writes(s.store);
  assert.throws(() => authorizeReportImport(changed, consumed), refused);
  assert.throws(() => authorizeReportImport(p, structuredClone(consumed)), refused);
  assert.throws(() => prepareReportImport(other.store, s.proof, s.ancestor, s.currentPolicy, timing(), raw, manifest), refused);
  assert.throws(() => prepareReportImport(s.store, s.proof, { ...s.ancestor, sourceId: 'other' }, s.currentPolicy, timing(), raw, manifest), refused);
  for (const policy of [{ ...s.currentPolicy }, JSON.parse(JSON.stringify(s.currentPolicy)), new Proxy(s.currentPolicy, {})]) {
    assert.throws(() => prepareReportImport(s.store, s.proof, s.ancestor, policy as any, timing(), raw, manifest), refused);
  }
  const historical = { ...reportImportBinding(p), policyRevision: s.policy.revision }, historicalNow = new Date();
  const staleReceipt = issueReceipt(s.book, { channel: 'owner-cli', principal: 'owner' }, historical, { now: historicalNow, ttlMs: 60000 });
  assert.throws(() => authorizeReportImport(p, s.book.consume(staleReceipt.id, historical, historicalNow)), refused, 'genuine historical-policy receipt cannot authorize current-policy import');
  assert.equal(reportImportBinding(p).policyRevision, s.currentPolicy.revision);
  const wrong = reportImportBinding(p);
  for (const field of ['stateDigest','policyRevision'] as const) {
    const binding = { ...wrong, [field]: digestOf(field) }, now = new Date();
    const r = issueReceipt(s.book, { channel: 'owner-cli', principal: 'owner' }, binding, { now, ttlMs: 60000 });
    assert.throws(() => authorizeReportImport(p, s.book.consume(r.id, binding, now)), refused);
  }
  const { permit } = spend(other);
  assert.throws(() => evidenceLedgerFor(s.store).begin(permit), refused);
  assert.throws(() => evidenceLedgerFor({ ...s.store }), TypeError);
  assert.deepEqual(writes(s.store), before);
});

test('generic/evidence stage domains and cross-operation capabilities cannot be mixed', needsStore, async t => {
  const s = await fixture(t), ops = evidenceLedgerFor(s.store), a = spend(s), b = spend(s, prepared(s, Buffer.from(raw.toString().replace('original-synthetic', 'other-original-synthetic'))));
  const oa = ops.begin(a.permit), ob = ops.begin(b.permit), stage = ops.stage(a.permit);
  const identity = ops.operation(oa.operationId)!.identity;
  assert.throws(() => s.store.ledger.abortStaging(stage.stageId), refused);
  const foreign = identity.candidateDigest;
  assert.throws(() => s.store.ledger.registerStaging('generic-links-evidence', [{ id: digestOf('generic-root'), schema: 'text/plain', privacy: 'metadata', links: [foreign] }]), refused);
  // Callers cannot add arbitrary staged IDs/links to an evidence stage: stage has no JSON descriptor argument.
  const forged = { ...readEvidencePermit(b.permit, boundOwner(s.store)), artifacts: [{ id: digestOf('foreign'), schema: 'text/plain', privacy: 'metadata', links: [foreign] }] };
  assert.throws(() => ops.stage(forged as any), refused);
  assert.equal(ops.operation(ob.operationId)!.state, 'open');
  assert.equal(s.store.ledger.listOpenStages(500, { domain: 'evidence' }).length, 1);
  const bi = ops.operation(ob.operationId)!.identity as any;
  bi.artifacts[bi.artifacts.length - 1].links.push(foreign);
  ops.stage(b.permit);
  const db = new DatabaseSync(join(s.store.storePath, 'ledger.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM staging_links WHERE stage_id = ? AND child_id = ?').get(`evidence-stage-${bi.nonce}`, foreign)!.n, 0, 'editing a retained JSON view cannot add a cross-operation link'); }
  finally { db.close(); }
  // Real stored receipts reach the generic admission's domain guard, rather than failing at missing-byte checks.
  const norm = normalizeImport(raw, manifest); assert.equal(norm.status, 'normalized'); if (norm.status !== 'normalized') throw new Error('fixture');
  const candidate = { schema: 'sentinel-report-import-candidate/1', domain: 'report-import', storeId: s.store.storeId,
    ancestor: s.ancestor, sourceClosure: identity.closure, adapter: norm.document.adapter, raw: norm.document.input.rawDigest,
    manifest: norm.document.input.manifestDigest, normalized: norm.digest, authority: 'owner-associated-imported-claims' };
  const receipts = [];
  for (const bytes of [raw, manifest, Buffer.from(norm.canonical), Buffer.from(canonicalJson(candidate))]) receipts.push(await s.store.objects.put(bytes));
  assert.deepEqual(new Set(receipts.map(r => r.id)), new Set(identity.artifacts.map(a => a.id)));
  const seq = s.store.ledger.currentSequence();
  assert.throws(() => s.store.ledger.admitSnapshot({ snapshotId: 'snapshot-cannot-import-evidence', stageIds: [stage.stageId],
    manifest: receipts[0]!.id, materialization: receipts[1]!.id, inventoryDigest: digestOf('not-source'), receipts }), e => e?.code === 'sentinel.store.stagingMismatch');
  const prior = s.store.ledger.getPlan(s.run.id, 2)!;
  assert.throws(() => s.store.ledger.admitPlan({ runId: s.run.id, revision: 3, kind: 'analysis', digest: digestOf('not-a-plan'), previous: prior.digest,
    plan: receipts[3]!.id, profile: receipts[1]!.id, ruleLock: receipts[0]!.id, policy: receipts[2]!.id, snapshotId: s.snapshot.id,
    stageIds: [stage.stageId], receipts }), e => e?.code === 'sentinel.store.stagingMismatch');
  assert.equal(s.store.ledger.currentSequence(), seq, 'generic admission rolls back even its event');

  // Generic-to-generic staged links continue to work, preserving existing capture semantics.
  const generic = digestOf('unaccepted-generic');
  s.store.ledger.registerStaging('generic-child', [{ id: generic, schema: 'text/plain', privacy: 'metadata' }]);
  s.store.ledger.registerStaging('generic-parent', [{ id: digestOf('generic-parent'), schema: 'text/plain', privacy: 'metadata', links: [generic] }]);
  ops.abort(a.permit); ops.abort(b.permit);
});

test('closed owner views/capabilities never revive across reopened epochs; only exact new receipt dual-pin transfer succeeds', needsStore, async t => {
  const s = await fixture(t), oldOps = evidenceLedgerFor(s.store), old = spend(s), opened = oldOps.begin(old.permit), oldStage = oldOps.stage(old.permit);
  const beforeIds = [...pins(s.store)].sort(), path = s.store.storePath;
  assert.throws(() => bindEvidenceLedger(boundOwner(s.store), oldOps, () => false), refused, 'duplicate binding is refused');
  s.store.close();
  assert.throws(() => oldOps.operation(opened.operationId), refused);
  const store = await openStore(path); t.after(() => store.close());
  assert.throws(() => oldOps.head(digestOf('anything')), refused);
  const ops = evidenceLedgerFor(store);
  assert.throws(() => ops.stage(old.permit), refused);
  assert.throws(() => prepareReportImport(store, s.proof, s.ancestor, s.currentPolicy, timing(), raw, manifest), refused);
  const proof = await retainedSourceForAdmission(store, s.ancestor, timing()), current = { ...s, store, proof };
  const fresh = spend(current);
  const rejectAfterDualPin = new DatabaseSync(join(path, 'ledger.sqlite'));
  rejectAfterDualPin.exec(`CREATE TRIGGER test_dual_pin_abort AFTER INSERT ON staging_artifacts
    WHEN (SELECT count(DISTINCT evidence_operation_id) FROM staging WHERE evidence_operation_id IS NOT NULL) = 2
      AND (SELECT count(*) FROM staging_artifacts WHERE stage_id = NEW.stage_id) = 4
    BEGIN SELECT RAISE(ABORT, 'test failure after dual pin'); END;`);
  rejectAfterDualPin.close();
  const failed = writes(store);
  assert.throws(() => ops.transfer(fresh.permit, opened.operationId), refused, 'actual SQLite abort after both pins rolls back the entire transfer');
  assert.deepEqual(writes(store), failed);
  assert.equal(ops.operation(opened.operationId)!.state, 'open');
  assert.deepEqual(pins(store), beforeIds);
  const removeTestTrigger = new DatabaseSync(join(path, 'ledger.sqlite')); removeTestTrigger.exec('DROP TRIGGER test_dual_pin_abort'); removeTestTrigger.close();
  const transferred = ops.transfer(fresh.permit, opened.operationId);
  assert.equal(ops.operation(opened.operationId)!.state, 'superseded');
  assert.equal(ops.operation(transferred.operationId)!.state, 'open');
  assert.equal(s.store.epoch === store.epoch, false);
  assert.deepEqual([...pins(store)].sort(), beforeIds, 'old pins replaced atomically by equivalent current pins');
  assert.equal(store.ledger.listOpenStages(500, { domain: 'evidence' }).some(x => x.stageId === oldStage.stageId), false);
  assert.equal(store.ledger.listOpenStages(500, { domain: 'evidence' })[0]!.epoch, store.epoch);
  assert.throws(() => ops.transfer(spend(current).permit, opened.operationId), refused);
});

test('fixed cooperative artifact/byte/closure/link caps accept the exact bound and refuse one above', () => {
  const l = EVIDENCE_LIMITS;
  checkEvidenceBounds(l.artifacts, l.bytes, l.closure, l.links);
  for (const i of [0,1,2,3]) {
    const a = [l.artifacts, l.bytes, l.closure, l.links]; a[i]++;
    assert.throws(() => checkEvidenceBounds(a[0]!, a[1]!, a[2]!, a[3]!), refused);
  }
  for (const n of [NaN, Infinity, -1, 1.5]) assert.throws(() => checkEvidenceBounds(n, 0, 0, 0), refused);
});

test('actual SQLite open-operation and per-binding history caps accept exact bounds and refuse +1', needsStore, async t => {
  const s = await fixture(t), ops = evidenceLedgerFor(s.store), p = prepared(s), pending: any[] = [];
  for (let i = 0; i < EVIDENCE_LIMITS.openOperations; i++) { const x = spend(s, p); ops.begin(x.permit); pending.push(x); }
  const before = writes(s.store);
  assert.throws(() => ops.begin(spend(s, p).permit), refused);
  assert.deepEqual(writes(s.store), before);
  for (const x of pending) ops.abort(x.permit);
  for (let i = pending.length; i < EVIDENCE_LIMITS.historyPerBinding; i++) { const x = spend(s, p); ops.begin(x.permit); ops.abort(x.permit); }
  const full = writes(s.store);
  assert.throws(() => ops.begin(spend(s, p).permit), refused);
  assert.deepEqual(writes(s.store), full);
});

test('recovery SQL filters/page cursor cover >500 mixed epoch/domain stages without dropping evidence pins', needsStore, async t => {
  const s = await fixture(t), old = spend(s), opened = evidenceLedgerFor(s.store).begin(old.permit), evidence = evidenceLedgerFor(s.store).stage(old.permit);
  const artifact = digestOf('generic-pending');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2999-01-01T00:00:00Z') });
  for (let i = 0; i < 603; i++) s.store.ledger.registerStaging(`z-old-${String(i).padStart(4,'0')}`, [{ id: artifact, schema: 'text/plain', privacy: 'metadata' }]);
  t.mock.timers.reset();
  const path = s.store.storePath; s.store.close();
  const store = await openStore(path); t.after(() => store.close());
  for (let i = 0; i < 507; i++) store.ledger.registerStaging(`a-current-${String(i).padStart(4,'0')}`, [{ id: artifact, schema: 'text/plain', privacy: 'metadata' }]);
  // The simulated backward clock puts current rows before the old generic rows in the legacy page.
  assert.ok(store.ledger.listOpenStages(500).every(s => !s.stageId.startsWith('z-old-')), 'legacy first page hides all 603 old generic rows');
  const report = await recoverStore(store, { workers: new WorkerFiles(path), intents: new IntentFiles(path) });
  assert.equal(report.abortedStages.length, 603);
  assert.equal(store.ledger.listOpenStages(500, { epochNot: store.epoch, domain: 'generic' }).length, 0);
  const left = store.ledger.listOpenStages(500, { domain: 'evidence' });
  assert.deepEqual(left.map(s => s.stageId), [evidence.stageId]);
  assert.equal(evidenceLedgerFor(store).operation(opened.operationId)!.state, 'open');
  const first = store.ledger.listOpenStages(500, { domain: 'generic' }), second = store.ledger.listOpenStages(500, { domain: 'generic', after: first.at(-1)!.stageId });
  assert.equal(first.length, 500); assert.equal(second.length, 7);
});
