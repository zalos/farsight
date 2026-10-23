// Original boundary controls over genuinely captured, parsed and coordinator-published source evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RetainedBudget, RETAINED_PROOF_LIMITS, readRetainedSourceProof, retainedSourceForAdmission } from '../dist/execution/retained-source.js';
import { Coordinator } from '../dist/execution/coordinator.js';
import { retainedFixture } from './retained-analysis-helpers.ts';
import { needsStore } from './snapshot-helpers.ts';

const timing = () => ({ signal: new AbortController().signal });
const unavailable = (e: any) => e.code === 'sentinel.execution.analysisUnavailable';
const canceled = (e: any) => e.code === 'sentinel.execution.canceled';
const deadline = (e: any) => e.code === 'sentinel.execution.deadlineExceeded';
async function completed(t: any) {
  const s = await retainedFixture(t);
  const result = await (await Coordinator.open({ store: s.store, runId: s.run.id, registry: s.registry, scratchRoot: s.work })).run();
  assert.equal(result.state, 'completed', JSON.stringify(result.failures));
  const run = s.store.ledger.getRun(s.run.id)!;
  return { ...s, ancestor: { runId: run.id, revision: run.planRevision, planDigest: s.store.ledger.getPlan(run.id, run.planRevision)!.digest, snapshotId: s.snapshot.id, sourceId: 'app' } };
}

for (const key of Object.keys(RETAINED_PROOF_LIMITS)) {
  test(`budget ${key}: caller bounds cannot raise ceilings or contain malformed numbers`, needsStore, async t => {
    const s = await retainedFixture(t);
    for (const value of [NaN, Infinity, -Infinity, -1, 0.5, '1', null, undefined, RETAINED_PROOF_LIMITS[key] + 1]) {
      assert.throws(() => new RetainedBudget(s.store, { signals: [], limits: { ...RETAINED_PROOF_LIMITS, [key]: value } }), unavailable, `${key}=${String(value)}`);
    }
    const lower = { ...RETAINED_PROOF_LIMITS, [key]: 0 };
    const budget = new RetainedBudget(s.store, { signals: [], limits: lower });
    assert.equal(budget.limits[key], 0);
    assert.ok(Object.isFrozen(budget.limits));
    lower[key] = RETAINED_PROOF_LIMITS[key];
    assert.equal(budget.limits[key], 0, 'the caller cannot mutate an accepted lower bound');
    assert.notEqual(budget.limits, lower);
  });
}

test('absolute deadline validates malformed input; Infinity keeps the internal bound', needsStore, async t => {
  const s = await completed(t);
  for (const deadlineAt of [NaN, -Infinity, -1, '1', null]) {
    await assert.rejects(retainedSourceForAdmission(s.store, s.ancestor, { ...timing(), deadlineAt }), unavailable, String(deadlineAt));
  }
  const budget = new RetainedBudget(s.store, { signals: [], deadlineAt: Infinity });
  assert.ok(Number.isFinite(budget.deadlineAt));
  assert.equal(budget.deadlineAt - budget.started, RETAINED_PROOF_LIMITS.deadlineMs);
  const proof = await retainedSourceForAdmission(s.store, s.ancestor, { ...timing(), deadlineAt: Infinity });
  assert.ok(readRetainedSourceProof(s.store, proof, s.ancestor, { ...timing(), deadlineAt: Infinity }));
  assert.throws(() => readRetainedSourceProof(s.store, proof, s.ancestor, { ...timing(), deadlineAt: NaN }), unavailable);
});

// Fault injection into the final actual Buffer copy, calibrated by a genuine successful proof. This is a boundary
// control, not a claim that captured project bytes can invoke callbacks in the owner process.
async function countCopies(work: () => Promise<unknown>, onCopy?: (n: number) => void) {
  const original = Buffer.from;
  let copies = 0;
  Buffer.from = function (...args: any[]) {
    const bytes = Reflect.apply(original, Buffer, args);
    copies++;
    onCopy?.(copies);
    return bytes;
  } as typeof Buffer.from;
  try { await work(); return copies; } finally { Buffer.from = original; }
}
for (const fault of ['abort', 'deadline', 'owner-close'] as const) {
  test(`final proof-state copy ${fault}: no proof is returned after the last allocation`, needsStore, async t => {
    const s = await completed(t);
    const controller = new AbortController();
    const grant = { signal: controller.signal };
    let mints = 0;
    const set = WeakMap.prototype.set;
    t.mock.method(WeakMap.prototype, 'set', function (key: any, value: any) {
      if (value?.store === s.store && value?.ancestor && value?.view) mints++;
      return set.call(this, key, value);
    });
    const count = await countCopies(async () => {
      const proof = await retainedSourceForAdmission(s.store, s.ancestor, grant);
      assert.ok(proof);
    });
    assert.ok(count > 0);
    assert.equal(mints, 1, 'the positive control minted one genuine proof');
    const originalNow = performance.now.bind(performance);
    let late = false, triggered = false;
    t.mock.method(performance, 'now', () => originalNow() + (late ? 120_001 : 0));
    await assert.rejects(countCopies(() => retainedSourceForAdmission(s.store, s.ancestor, grant), n => {
      if (n !== count) return;
      triggered = true;
      if (fault === 'abort') controller.abort();
      if (fault === 'deadline') late = true;
      if (fault === 'owner-close') s.store.close();
    }), fault === 'abort' ? canceled : fault === 'deadline' ? deadline : (e: any) => ['sentinel.store.closed', 'sentinel.store.ownerClosed', 'sentinel.store.ownerNotHeld'].includes(e.code));
    assert.ok(triggered, 'the same final allocation was reached');
    assert.equal(mints, 1, 'the failed final boundary minted no additional proof');
  });
}

test('proof accessor performs a final boundary after copying and cannot erase an expired deadline with NaN', needsStore, async t => {
  const s = await completed(t);
  const grant = { ...timing(), deadlineAt: performance.now() + 10_000 };
  const proof = await retainedSourceForAdmission(s.store, s.ancestor, grant);
  const count = await countCopies(async () => { assert.ok(readRetainedSourceProof(s.store, proof, s.ancestor, timing())); });
  const originalNow = performance.now.bind(performance);
  let late = false;
  t.mock.method(performance, 'now', () => originalNow() + (late ? 120_001 : 0));
  assert.ok(readRetainedSourceProof(s.store, proof, s.ancestor, timing()));
  await assert.rejects(countCopies(async () => { readRetainedSourceProof(s.store, proof, s.ancestor, timing()); }, n => { if (n === count) late = true; }), deadline);
  assert.throws(() => readRetainedSourceProof(s.store, proof, s.ancestor, { ...timing(), deadlineAt: NaN }));
});

for (const phase of ['inventory-invocation', 'snapshot-materialization'] as const) {
  for (const fault of ['abort', 'deadline', 'read-budget'] as const) {
    test(`${phase} ${fault}: the first typed refusal survives nested readers`, needsStore, async t => {
      const s = await completed(t);
      const target = phase === 'snapshot-materialization'
        ? s.store.ledger.getSnapshot(s.snapshot.id)!.materialization
        : s.store.ledger.getAttempt(s.store.ledger.getPublication(s.inventory)!.attemptId)!.envelope.invocation;
      assert.ok(target);
      const controller = new AbortController();
      const originalNow = performance.now.bind(performance);
      let late = false, fired = false;
      t.mock.method(performance, 'now', () => originalNow() + (late ? 120_001 : 0));
      const read = RetainedBudget.prototype.read;
      t.mock.method(RetainedBudget.prototype, 'read', function (id: any, kind: any) {
        if (id === target && !fired) {
          fired = true;
          if (fault === 'abort') controller.abort();
          if (fault === 'deadline') late = true;
          if (fault === 'read-budget') this.reads = this.limits.reads;
        }
        return read.call(this, id, kind);
      });
      const sequence = s.store.ledger.currentSequence();
      await assert.rejects(retainedSourceForAdmission(s.store, s.ancestor, { signal: controller.signal }),
        fault === 'abort' ? canceled : fault === 'deadline' ? deadline : (e: any) => unavailable(e) && e.detail?.reason === 'budget-reads');
      assert.ok(fired);
      assert.equal(s.store.ledger.currentSequence(), sequence, 'refusal writes no ledger records');
    });
  }
}

test('the original mint signal survives mutation of the caller timing object during a read', needsStore, async t => {
  const s = await completed(t);
  const original = new AbortController();
  const grant = { signal: original.signal };
  const read = RetainedBudget.prototype.read;
  let changed = false;
  t.mock.method(RetainedBudget.prototype, 'read', function (id: any, kind: any) {
    if (!changed) { changed = true; grant.signal = new AbortController().signal; }
    return read.call(this, id, kind);
  });
  const proof = await retainedSourceForAdmission(s.store, s.ancestor, grant);
  assert.ok(readRetainedSourceProof(s.store, proof, s.ancestor, timing()));
  original.abort();
  assert.throws(() => readRetainedSourceProof(s.store, proof, s.ancestor, timing()), canceled);
});
