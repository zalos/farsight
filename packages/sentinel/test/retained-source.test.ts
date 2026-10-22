// The readonly retained-source admission proof over genuine accepted evidence: a real capture, real coordinator
// bootstrap operations and a real completed analysis run (retained-analysis-helpers), and a real canonical workspace
// with a selected child and grandchild. Faults remove or alter real stored objects; nothing is manufactured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../dist/execution/coordinator.js';
import { loadBootstrap } from '../dist/execution/bootstrap.js';
import { admitPlan, loadPlan } from '../dist/execution/plans.js';
import { retainedBytesOf, verifyRetainedAuxiliary } from '../dist/execution/retained-analysis.js';
import { RETAINED_PROOF_LIMITS, readRetainedSourceProof, retainedSourceForAdmission, retainedSourceProofUsage } from '../dist/execution/retained-source.js';
import { planAnalysis, plannerAnalysisFrom, plannerSnapshotFrom } from '../dist/planner/index.js';
import { openStore } from '../dist/store/index.js';
import { adoptedPolicy, adoptWorkspaceSettings, promoteRulePack, scratchUnder, removeScratch, workspaceOf } from '../dist/service/local.js';
import { executeRun, planWorkspaceCanonical, rerunRun } from '../dist/service/canonical.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { initWorkspace } from '../dist/cli/init.js';
import { needsStore, unlock } from './snapshot-helpers.ts';
import { retainedFixture } from './retained-analysis-helpers.ts';

const timing = (extra: Record<string, unknown> = {}) => ({ signal: new AbortController().signal, ...extra });
const unavailable = (reason?: string) => (e: any) => e.code === 'sentinel.execution.analysisUnavailable' && (reason === undefined || e.detail?.reason === reason || e.message.includes(reason));

/** A real completed analysis run over two captured sources; the proof is asked about `app`. */
async function completed(t: any, options: Record<string, unknown> = {}) {
  const s = await retainedFixture(t, { otherSource: true, ...options });
  const done = await (await Coordinator.open({ store: s.store, runId: s.run.id, registry: s.registry, scratchRoot: s.work })).run();
  assert.equal(done.state, 'completed', JSON.stringify(done.failures));
  const run = s.store.ledger.getRun(s.run.id)!;
  const ancestor = { runId: s.run.id, revision: run.planRevision, planDigest: s.store.ledger.getPlan(s.run.id, run.planRevision)!.digest, snapshotId: s.snapshot.id, sourceId: 'app' };
  return { ...s, ancestor };
}

/** Everything a write would leave: ledger events and stored object files. */
function writes(store: any) {
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (lstatSync(p).isDirectory()) walk(p); else files.push(p); } };
  walk(join(store.storePath, 'objects'));
  return JSON.stringify({ sequence: store.ledger.currentSequence(), files: files.sort() });
}

function objectCopies(store: any, id: string) {
  const hex = id.slice(7), dir = join(store.storePath, 'objects', 'sha256', hex.slice(0, 2));
  return readdirSync(dir).filter(n => n.startsWith(hex + '.')).map(n => join(dir, n));
}

/** The retention closure enumerated independently from ledger records, not from the proof. */
async function expectedClosure(store: any, runId: string, revisions: Array<[string, number]>, sourceId: string) {
  const out = new Set<string>();
  const add = (id: string | null | undefined, role: string) => { if (id) out.add(`${role}\u0000${id}`); };
  for (const [r, rev] of revisions) {
    const p = store.ledger.getPlan(r, rev)!;
    add(p.plan, 'plan'); add(p.profile, 'profile'); add(p.ruleLock, 'rule-lock'); add(p.policy, 'policy'); add(p.selection, 'selection');
  }
  const admitted = await loadPlan(store, runId, store.ledger.getRun(runId)!.planRevision);
  const inventory = admitted.plan.reused.find((r: any) => store.ledger.getPublication(r)?.outputs.some((o: any) => o.schema === 'sentinel-bootstrap-inventory/draft-1'))!;
  const owner = store.ledger.getWork(inventory)!;
  const boot = await loadPlan(store, owner.runId, owner.envelope.planRevision);
  const parse = boot.plan.units.find((u: any) => u.stage === 'parse' && u.sourceId === sourceId)!;
  for (const ref of [inventory, { id: parse.id, revision: parse.revision }]) {
    add(store.ledger.getWork(ref)!.envelope.influenceManifest, 'influence');
    const pub = store.ledger.getPublication(ref)!;
    add(store.ledger.getAttempt(pub.attemptId)!.envelope.invocation, 'invocation');
    for (const o of pub.outputs) add(o.id, 'output');
  }
  const record = JSON.parse((await store.readArtifact(store.ledger.getPublication(inventory)!.outputs[0].id)).toString());
  const a = record.analyses.find((x: any) => x.sourceId === sourceId);
  add(a.result, 'analysis-result'); add(a.index, 'analysis-index'); add(a.artifact, 'analysis-artifact');
  const snap = store.ledger.getSnapshot(record.snapshotId)!;
  add(snap.manifest, 'snapshot-manifest'); add(snap.materialization, 'snapshot-materialization');
  const manifest = JSON.parse((await store.readArtifact(snap.manifest)).toString());
  for (const e of manifest.entries) if (e.sourceId === sourceId && e.kind === 'file' && e.disposition === 'included') add(e.content, 'source-content');
  return { set: out, otherContents: manifest.entries.filter((e: any) => e.sourceId !== sourceId && e.content).map((e: any) => e.content) };
}

test('recorded completed ancestor: exact closure, source-only view, copies, no execution authority, no writes', needsStore, async t => {
  const s = await completed(t);
  const before = writes(s.store);
  const proof = await retainedSourceForAdmission(s.store, s.ancestor, timing());
  assert.equal(writes(s.store), before, 'the proof writes nothing');
  const view = readRetainedSourceProof(s.store, proof, s.ancestor, timing());
  const expected = await expectedClosure(s.store, s.run.id, [[s.run.id, 2], [s.run.id, 1]], 'app');
  assert.deepEqual(new Set(view.closure.map((c: any) => `${c.role}\u0000${c.id}`)), expected.set, 'closure equals the independently enumerated artifact ids');
  for (const c of view.closure) assert.match(c.id, /^sha256:[0-9a-f]{64}$/);
  assert.ok(view.closure.some((c: any) => c.role === 'snapshot-materialization') && view.closure.filter((c: any) => c.role === 'influence').length === 2);
  assert.equal(typeof view.manifest, 'string', 'manifest is an id only');
  const text = JSON.stringify({ ...view, result: { ...view.result, bytes: null }, index: { ...view.index, bytes: null }, artifact: { ...view.artifact, bytes: null } });
  assert.ok(!text.includes('"other"') && expected.otherContents.every((id: string) => !text.includes(id)), 'nothing of the other source leaks');
  assert.ok(view.entries.length > 0 && view.entries.every((e: any) => e.sourceId === 'app'));
  assert.ok(Object.isFrozen(view) && Object.isFrozen(view.result.value) && Object.isFrozen(view.entries));
  view.result.bytes.fill(0);
  assert.notDeepEqual(readRetainedSourceProof(s.store, proof, s.ancestor, timing()).result.bytes, view.result.bytes, 'bytes are fresh copies');
  // Neither the view nor the handle is retained execution evidence.
  for (const fake of [view, proof, { ...proof }, JSON.parse(JSON.stringify(proof)), Object.create(proof), new Proxy(proof, {}), structuredClone(proof)]) {
    assert.throws(() => retainedBytesOf(fake as any), unavailable());
  }
  assert.throws(() => verifyRetainedAuxiliary(view as any, []), unavailable());
  assert.throws(() => verifyRetainedAuxiliary(proof as any, []));
  for (const fake of [{ ...proof }, JSON.parse(JSON.stringify(proof)), Object.create(proof), new Proxy(proof, {}), structuredClone(proof)]) {
    assert.throws(() => readRetainedSourceProof(s.store, fake as any, s.ancestor, timing()), unavailable());
  }
  t.diagnostic(JSON.stringify({ fixture: 'two-source workspace store', usage: retainedSourceProofUsage(proof) }));
});

test('a later merely-admitted revision neither revokes the recorded ancestor nor becomes authority', needsStore, async t => {
  const s = await completed(t);
  const proof = await retainedSourceForAdmission(s.store, s.ancestor, timing());
  const parent = await loadBootstrap(s.store, s.run.id, s.inventory);
  const future = planAnalysis({ runId: s.run.id, revision: 3, previous: s.analysis, bootstrap: s.analysis.reused, profile: s.profile,
    snapshot: plannerSnapshotFrom(s.snapshot), analyses: parent.analyses.map((a: any) => plannerAnalysisFrom(a)), lock: s.rules.view, policy: s.view });
  await admitPlan(s.store, { plan: future, ruleLock: s.rules.lock, policy: s.policy, profile: s.record });
  assert.equal(s.store.ledger.latestPlan(s.run.id)!.revision, 3);
  assert.equal(s.store.ledger.getRun(s.run.id)!.planRevision, 2);
  assert.ok(readRetainedSourceProof(s.store, proof, s.ancestor, timing()), 'the minted proof still reads');
  assert.ok(await retainedSourceForAdmission(s.store, s.ancestor, timing()), 'the recorded revision still proves');
  const before = writes(s.store);
  await assert.rejects(retainedSourceForAdmission(s.store, { ...s.ancestor, revision: 3, planDigest: future.digest }, timing()), unavailable('not the recorded terminal ancestor revision'));
  assert.equal(writes(s.store), before);
  // The ledger never advances an ended run, so the recorded terminal revision cannot move under a proof.
  assert.throws(() => s.store.ledger.advanceRunPlan(s.run.id, 3), (e: any) => e.code === 'sentinel.store.wrongState');
  assert.ok(readRetainedSourceProof(s.store, proof, s.ancestor, timing()));
});

test('ancestor key negatives refuse before any write', needsStore, async t => {
  const s = await completed(t);
  const before = writes(s.store);
  for (const bad of [{ revision: 1 }, { planDigest: `sha256:${'0'.repeat(64)}` }, { snapshotId: 'other-snapshot' }, { sourceId: 'missing' }, { runId: 'nope' }, { extra: 1 }]) {
    await assert.rejects(retainedSourceForAdmission(s.store, { ...s.ancestor, ...bad } as any, timing()), unavailable(), JSON.stringify(bad));
  }
  assert.throws(() => readRetainedSourceProof(s.store, {} as any, s.ancestor, timing()), unavailable());
  assert.equal(writes(s.store), before);
});

test('a running (not terminal) ancestor refuses', needsStore, async t => {
  const s = await retainedFixture(t);
  const ancestor = { runId: s.run.id, revision: 2, planDigest: s.analysis.digest, snapshotId: s.snapshot.id, sourceId: 'app' };
  await assert.rejects(retainedSourceForAdmission(s.store, ancestor, timing()), unavailable('not the recorded terminal ancestor revision'));
});

for (const [name, pick] of [
  ['parse invocation', (c: any[]) => c.filter(x => x.role === 'invocation')],
  ['inventory influence manifest', (c: any[]) => c.filter(x => x.role === 'influence')],
  ['snapshot materialization', (c: any[]) => c.filter(x => x.role === 'snapshot-materialization')],
  ['bootstrap profile record', (c: any[]) => c.filter(x => x.role === 'profile')],
  ['analysis index', (c: any[]) => c.filter(x => x.role === 'analysis-index')],
] as const) {
  for (const mode of ['missing', 'same-size corruption', 'linked representation']) {
    test(`${mode} ${name} refuses before any write`, needsStore, async t => {
      const s = await completed(t);
      const view = readRetainedSourceProof(s.store, await retainedSourceForAdmission(s.store, s.ancestor, timing()), s.ancestor, timing());
      const targets = pick(view.closure as any[]);
      assert.ok(targets.length > 0);
      for (const target of targets.slice(-1)) for (const path of objectCopies(s.store, target.id)) {
        chmodSync(path, 0o600);
        if (mode === 'missing') unlinkSync(path);
        else if (mode === 'same-size corruption') { const b = readFileSync(path); b[b.length >> 1] ^= 0xff; writeFileSync(path, b); }
        else { const b = readFileSync(path), copy = path + '.elsewhere'; writeFileSync(copy, b); unlinkSync(path); symlinkSync(copy, path); }
      }
      const before = writes(s.store);
      await assert.rejects(retainedSourceForAdmission(s.store, s.ancestor, timing()), unavailable());
      assert.equal(writes(s.store), before);
    });
  }
}

for (const mode of ['missing', 'same-size corruption', 'linked representation']) {
  test(`${mode} captured source body refuses before any write (hash-read, not stat)`, needsStore, async t => {
    const s = await completed(t);
    const view = readRetainedSourceProof(s.store, await retainedSourceForAdmission(s.store, s.ancestor, timing()), s.ancestor, timing());
    const body = view.closure.find((c: any) => c.role === 'source-content')!;
    for (const path of objectCopies(s.store, body.id)) {
      chmodSync(path, 0o600);
      if (mode === 'missing') unlinkSync(path);
      else if (mode === 'same-size corruption') { const b = readFileSync(path); b[b.length >> 1] ^= 0xff; writeFileSync(path, b); }
      else { const b = readFileSync(path), copy = path + '.elsewhere'; writeFileSync(copy, b); unlinkSync(path); symlinkSync(copy, path); }
    }
    const before = writes(s.store);
    await assert.rejects(retainedSourceForAdmission(s.store, s.ancestor, timing()), unavailable());
    assert.equal(writes(s.store), before);
  });
}

test('identical bodies at two paths are read once; budgets refuse exactly one over and pass exactly at', needsStore, async t => {
  const s = await completed(t, { extraFiles: { 'src/copy-a.ts': 'export const same = 1;\n', 'src/copy-b.ts': 'export const same = 1;\n' } });
  const proof = await retainedSourceForAdmission(s.store, s.ancestor, timing());
  const usage = retainedSourceProofUsage(proof)!;
  const view = readRetainedSourceProof(s.store, proof, s.ancestor, timing());
  const bodies = view.closure.filter((c: any) => c.role === 'source-content');
  const paths = view.entries.filter((e: any) => e.kind === 'file' && e.disposition === 'included');
  assert.equal(bodies.length, new Set(paths.map((e: any) => e.content)).size);
  assert.ok(bodies.length < paths.length, 'the shared body is one closure entry');
  const exact = { ...RETAINED_PROOF_LIMITS, reads: usage.reads, sourceBytes: usage.sourceBytes, metadataBytes: usage.metadataBytes, retainedBytes: usage.retainedBytes };
  assert.ok(await retainedSourceForAdmission(s.store, s.ancestor, timing(), exact), 'exactly at every bound passes');
  const before = writes(s.store);
  for (const [key, reason] of [['reads', 'budget-reads'], ['sourceBytes', 'budget-source-bytes'], ['metadataBytes', 'budget-metadata-bytes'], ['retainedBytes', 'budget-retained']] as const) {
    await assert.rejects(retainedSourceForAdmission(s.store, s.ancestor, timing(), { ...exact, [key]: exact[key] - 1 }), unavailable(reason), key);
  }
  await assert.rejects(retainedSourceForAdmission(s.store, s.ancestor, timing(), { ...exact, depth: 0 }), unavailable('budget-depth'));
  assert.equal(writes(s.store), before);
});

test('internal deadline with a no-op caller callback, caller deadline, cancellation and a final boundary after construction', needsStore, async t => {
  const s = await completed(t);
  const deadline = (e: any) => e.code === 'sentinel.execution.deadlineExceeded';
  await assert.rejects(retainedSourceForAdmission(s.store, s.ancestor, timing({ stillWithin: () => {} }), { ...RETAINED_PROOF_LIMITS, deadlineMs: 0 }), deadline);
  await assert.rejects(retainedSourceForAdmission(s.store, s.ancestor, timing({ deadlineAt: performance.now() })), deadline);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(retainedSourceForAdmission(s.store, s.ancestor, { signal: aborted.signal }), (e: any) => e.code === 'sentinel.execution.canceled');
  // Count the boundaries of a successful proof; failing at the very last one (after construction) mints nothing.
  let calls = 0;
  assert.ok(await retainedSourceForAdmission(s.store, s.ancestor, timing({ stillWithin: () => { calls++; } })));
  let n = 0;
  await assert.rejects(retainedSourceForAdmission(s.store, s.ancestor, timing({ stillWithin: () => { if (++n === calls) throw Object.assign(new Error('late'), { code: 'late' }); } })), unavailable());
  assert.equal(n, calls, 'the refusal came from the final boundary after construction');
  // The accessor checks again after copying, and can only tighten the minted deadline and cancellation.
  const minted = new AbortController();
  const proof = await retainedSourceForAdmission(s.store, s.ancestor, { signal: minted.signal, deadlineAt: performance.now() + 60_000 });
  let m = 0;
  assert.throws(() => readRetainedSourceProof(s.store, proof, s.ancestor, timing({ stillWithin: () => { if (++m === 2) throw new Error('late'); } })), /late/);
  assert.throws(() => readRetainedSourceProof(s.store, proof, s.ancestor, timing({ deadlineAt: performance.now() })), deadline);
  assert.ok(readRetainedSourceProof(s.store, proof, s.ancestor, timing({ deadlineAt: performance.now() + 3_600_000 })));
  minted.abort();
  assert.throws(() => readRetainedSourceProof(s.store, proof, s.ancestor, timing()), (e: any) => e.code === 'sentinel.execution.canceled', 'a fresh signal cannot lift the original cancellation');
  const short = await retainedSourceForAdmission(s.store, s.ancestor, timing({ deadlineAt: performance.now() + 50 }));
  await new Promise(r => setTimeout(r, 80));
  assert.throws(() => readRetainedSourceProof(s.store, short, s.ancestor, timing({ deadlineAt: performance.now() + 3_600_000 })), deadline, 'a later deadline cannot extend the minted one');
});

test('a closed or reopened store refuses mint and read', needsStore, async t => {
  const s = await completed(t);
  const proof = await retainedSourceForAdmission(s.store, s.ancestor, timing());
  const path = s.store.storePath;
  // The owner lost mid-proof: the next boundary refuses and nothing is minted.
  let k = 0;
  await assert.rejects(retainedSourceForAdmission(s.store, s.ancestor, timing({ stillWithin: () => { if (++k === 3) s.store.close(); } })));
  assert.equal(s.store.held, false);
  assert.throws(() => readRetainedSourceProof(s.store, proof, s.ancestor, timing()));
  const reopened = await openStore(path);
  t.after(() => { try { reopened.close(); } catch { /* closed */ } });
  assert.throws(() => readRetainedSourceProof(reopened, proof, s.ancestor, timing()), unavailable('not a retained-source proof for this store'));
  assert.ok(await retainedSourceForAdmission(reopened, s.ancestor, timing()), 'a fresh proof under the new owner');
  const view = { ledger: reopened.ledger, readArtifact: (id: string) => reopened.readArtifact(id), storeId: reopened.storeId, epoch: reopened.epoch, assertHeld: () => reopened.assertHeld() };
  await assert.rejects(retainedSourceForAdmission(view as any, s.ancestor, timing()), /not a store opened by openStore/);
});

// A real canonical workspace: parent run, then a selected child and grandchild.
test('genuine selected child and grandchild ancestors prove through exact selection edges', needsStore, async t => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-retained-source-')));
  t.after(() => { unlock(dir); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'ws');
  for (const [p, text] of Object.entries({ 'src/users.ts': 'export const find = (id: string) => db.query("SELECT * FROM users WHERE id = " + id);\n', 'src/orders.ts': 'export const all = () => 1;\n' })) {
    mkdirSync(join(path, p, '..'), { recursive: true }); writeFileSync(join(path, p), text);
  }
  const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
  initWorkspace({ workspace: path });
  adoptWorkspaceSettings(ws, { confirm: true, now: new Date() });
  promoteRulePack(ws, { packDir: realpathSync.native(builtinPackDir('foundation-preview')!), confirm: true, now: new Date() });
  const adopted = adoptedPolicy(ws);
  assert.ok('policy' in adopted);
  const store = await openStore(ws.storePath);
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const work = scratchUnder(ws);
  t.after(() => removeScratch(work));
  const terms = { workspace: path, trustDir: ws.trustDir, policy: adopted.policy, scratchRoot: work, now: new Date() };
  const planned = await planWorkspaceCanonical(store, terms);
  const parentId = planned.disclosure.runId;
  assert.equal((await executeRun(store, parentId, { scratchRoot: work })).state, 'completed');
  rmSync(join(path, 'src'), { recursive: true });
  const keyOf = (runId: string) => {
    const run = store.ledger.getRun(runId)!, rec = store.ledger.getPlan(runId, run.planRevision)!;
    return { runId, revision: run.planRevision, planDigest: rec.digest, snapshotId: run.envelope.snapshotId, sourceId: '' };
  };
  const parentPlan = (await loadPlan(store, parentId, store.ledger.getRun(parentId)!.planRevision)).plan;
  const sourceId = parentPlan.pins.analyses[0]!.sourceId;
  let id = parentId, chosen = parentPlan.units[0]!.id;
  const lineage: string[] = [parentId];
  for (let generation = 0; generation < 2; generation++) {
    const child: any = await rerunRun(store, id, [chosen], terms);
    id = child.disclosure.runId;
    assert.equal((await executeRun(store, id, { scratchRoot: work })).state, 'completed');
    lineage.push(id);
    chosen = (await loadPlan(store, id, 1)).selection!.selected[0]!.unit;
  }
  for (const runId of lineage) {
    const ancestor = { ...keyOf(runId), sourceId };
    const before = writes(store);
    const proof = await retainedSourceForAdmission(store, ancestor, timing());
    assert.equal(writes(store), before);
    const view = readRetainedSourceProof(store, proof, ancestor, timing());
    const revisions: Array<[string, number]> = [];
    for (const r of lineage.slice(0, lineage.indexOf(runId) + 1).reverse()) {
      revisions.push([r, store.ledger.getRun(r)!.planRevision]);
      revisions.push([r, 1]);
    }
    const bootRun = store.ledger.getWork((await loadPlan(store, parentId, store.ledger.getRun(parentId)!.planRevision)).plan.reused[0]!)!;
    revisions.push([bootRun.runId, bootRun.envelope.planRevision]);
    const expected = await expectedClosure(store, runId, revisions, sourceId);
    assert.deepEqual(new Set(view.closure.map((c: any) => `${c.role}\u0000${c.id}`)), expected.set, `closure of ${runId}`);
    t.diagnostic(JSON.stringify({ fixture: `canonical ${['parent', 'selected child', 'selected grandchild'][lineage.indexOf(runId)]}`, usage: retainedSourceProofUsage(proof) }));
  }
});
