// Bounded observation algorithm controls, not native Linux runtime qualification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { cgroupMemoryFailure } from '../dist/execution/cgroup-memory.js';
import { kernel, pacedClock, record } from './cgroup-memory-fixture.ts';

function triggered(t: any) {
  const k = kernel(t),
    clock = pacedClock(t),
    w = k.start();
  w.arm();
  k.write(record(1));
  k.notify();
  return { k, clock, w };
}
const observation = (w: any) => w.observation() as any;
const facts = {
  ownerHeld: true,
  aborted: false,
  state: 'failed',
  code: 'sentinel.execution.workerExited',
  containerExit: 137,
  clientExit: 137,
  clientSignal: null,
};

test('burst reads a genuine later triple without a second notification, then closes immutable positive evidence', (t) => {
  const { k, clock, w } = triggered(t);
  assert.equal(clock.pending(), 1);
  k.write(record(2, 1, 1));
  clock.next();
  const e = w.finish();
  assert.ok(e);
  assert.equal(cgroupMemoryFailure(e, facts), e);
  assert.deepEqual(observation(w).firstSample, { maxDelta: '1', oomDelta: '0', oomKillDelta: '0' });
  assert.deepEqual(observation(w).burst, { triggered: true, reads: 1, endedBy: 'positive' });
  assert.equal(observation(w).attempts, 4);
  assert.equal(observation(w).samples, 1);
  assert.equal(clock.pending(), 0);
  assert.equal(k.held.size, 0);
});
test('pre-arm and kill-only samples never trigger a burst or classify diagnostic counters as evidence', (t) => {
  const k = kernel(t),
    clock = pacedClock(t),
    w = k.start();
  k.write(record(3));
  k.notify();
  w.arm();
  k.write(record(3, 0, 1));
  k.notify();
  assert.equal(clock.pending(), 0);
  assert.deepEqual(observation(w).firstSample, { maxDelta: '0', oomDelta: '0', oomKillDelta: '1' });
  assert.deepEqual(observation(w).burst, { triggered: false, reads: 0 });
  assert.equal(w.finish(), undefined);
  assert.equal(
    cgroupMemoryFailure(undefined, {
      ...facts,
      firstSample: { maxDelta: '3', oomDelta: '1', oomKillDelta: '1' },
    } as any),
    undefined,
  );
});
test('one paced burst stops at32 attempts, cannot restart, and notifications share the same total budget', (t) => {
  const { k, clock, w } = triggered(t);
  for (let i = 0; i < 32; i++) {
    assert.equal(clock.pending(), 1);
    clock.next();
  }
  assert.equal(clock.pending(), 0);
  assert.deepEqual(observation(w).burst, { triggered: true, reads: 32, endedBy: 'count' });
  for (let i = 0; i < 3; i++) k.notify();
  assert.equal(clock.pending(), 0);
  assert.equal(clock.maxPending(), 1);
  assert.equal(observation(w).attempts, 38);
  assert.equal(w.finish(), undefined);
});
test('50ms edge cancels a pending paced read without touching the kernel or restarting', (t) => {
  const { k, clock, w } = triggered(t),
    reads = k.eventReads();
  clock.next(50);
  assert.equal(k.eventReads(), reads);
  assert.deepEqual(observation(w).burst, { triggered: true, reads: 0, endedBy: 'time' });
  k.notify();
  assert.equal(clock.pending(), 0);
  assert.equal(w.finish(), undefined);
});
test('a full burst read crossing50ms cannot retain its otherwise valid triple', (t) => {
  const { k, clock, w } = triggered(t);
  k.write(record(2, 1, 1));
  k.afterRead((path) => {
    if (path.endsWith('memory.events.local')) clock.advance(50);
  });
  clock.next();
  assert.equal(observation(w).state, 'watching');
  assert.deepEqual(observation(w).burst, { triggered: true, reads: 1, endedBy: 'time' });
  k.afterRead(() => {});
  w.close();
  assert.equal(w.finish(), undefined);
});
test('global128 budget includes setup arm events burst and final; finish gets no extra attempt', (t) => {
  const { k, clock, w } = triggered(t);
  for (let i = 0; i < 120; i++) k.notify();
  assert.equal(observation(w).attempts, 123);
  for (let i = 0; i < 5; i++) clock.next();
  assert.equal(observation(w).attempts, 128);
  assert.equal(observation(w).state, 'exhausted');
  assert.equal(clock.pending(), 0);
  const reads = k.eventReads();
  assert.equal(w.finish(), undefined);
  assert.equal(k.eventReads(), reads);
  assert.equal(observation(w).attempts, 128);
});
test('notification and paced callbacks interleave with one timer and one unrefilled quota', (t) => {
  const { k, clock, w } = triggered(t);
  for (let i = 0; i < 5; i++) {
    k.notify();
    clock.next();
  }
  assert.equal(clock.maxPending(), 1);
  assert.equal(observation(w).attempts, 13);
  assert.equal(observation(w).samples, 6);
  assert.deepEqual(observation(w).burst, { triggered: true, reads: 5 });
  w.close();
});
for (const mode of ['finish', 'close'] as const)
  test(mode + ' clears the pending timer and a dequeued callback cannot touch closed FDs', (t) => {
    const { k, clock, w } = triggered(t);
    clock.dequeue();
    const reads = k.eventReads();
    if (mode === 'finish') assert.equal(w.finish(), undefined);
    else w.close();
    const after = k.eventReads();
    assert.equal(after, reads + (mode === 'finish' ? 1 : 0));
    k.write(record(2, 1, 1));
    clock.runDequeued();
    assert.equal(k.eventReads(), after);
    assert.equal(w.finish(), undefined);
    assert.equal(clock.pending(), 0);
    assert.deepEqual(observation(w).burst, { triggered: true, reads: 0, endedBy: mode });
  });
test('failed full attempts are charged and a removed event file reports the burst failure phase', (t) => {
  const { k, clock, w } = triggered(t);
  fs.unlinkSync(join(k.leaf, 'memory.events.local'));
  clock.next();
  assert.equal(observation(w).attempts, 4);
  assert.deepEqual(observation(w).failure, { phase: 'burst', check: 'named-before' });
  assert.deepEqual(observation(w).burst, { triggered: true, reads: 1, endedBy: 'error' });
  assert.equal(w.finish(), undefined);
  assert.equal(k.held.size, 0);
});
test('a good burst counter read discarded by named-after loss stays negative and identifies only its phase', (t) => {
  const { k, clock, w } = triggered(t);
  k.write(record(2, 1, 1));
  k.afterRead((path) => {
    if (path.endsWith('memory.events.local')) fs.unlinkSync(join(k.leaf, 'memory.events.local'));
  });
  clock.next();
  assert.equal(w.finish(), undefined);
  assert.deepEqual(observation(w).failure, { phase: 'burst', check: 'named-after' });
  assert.deepEqual(observation(w).firstSample, { maxDelta: '1', oomDelta: '0', oomKillDelta: '0' });
  assert.equal(k.held.size, 0);
});
for (const [name, mutate, check] of [
  ['PID reuse', (k: any) => k.setProcess('78'), 'process'],
  ['changed limit', (k: any) => fs.writeFileSync(join(k.leaf, 'memory.max'), 'max\n'), 'limit'],
  ['malformed counter', (k: any) => k.write('max 2\noom 1\n'), 'counters'],
  ['decreased counter', (k: any) => k.write(record(0)), 'counters'],
] as const)
  test(name + ' during burst retains no positive and closes all resources', (t) => {
    const { k, clock, w } = triggered(t);
    mutate(k);
    clock.next();
    assert.equal(w.finish(), undefined);
    assert.deepEqual(observation(w).failure, { phase: 'burst', check });
    assert.equal(clock.pending(), 0);
    assert.equal(k.held.size, 0);
  });
test('bounded firstSample and burst diagnostics are independently frozen data, never authority', (t) => {
  const { clock, w } = triggered(t),
    o = observation(w);
  assert.ok(o.firstSample);
  assert.ok(o.burst);
  assert.equal(Object.isFrozen(o.firstSample), true);
  assert.equal(Object.isFrozen(o.burst), true);
  assert.throws(() => {
    o.firstSample.oomDelta = '1';
  });
  assert.throws(() => {
    o.burst.reads = 999;
  });
  assert.equal(cgroupMemoryFailure(undefined, { ...facts, memoryObservation: o } as any), undefined);
  w.close();
  assert.equal(clock.pending(), 0);
});
for (const mode of ['finish', 'close'] as const)
  test(mode + ' clears an actually pending paced timer without a late callback', (t) => {
    const { k, clock, w } = triggered(t);
    assert.equal(clock.pending(), 1);
    const reads = k.eventReads();
    if (mode === 'finish') w.finish();
    else w.close();
    assert.equal(clock.pending(), 0);
    assert.equal(k.eventReads(), reads + (mode === 'finish' ? 1 : 0));
    assert.deepEqual(observation(w).burst, { triggered: true, reads: 0, endedBy: mode });
    assert.equal(w.finish(), undefined);
  });
test('a valid paced positive before50ms is allowed and arming again never resets the baseline or quota', (t) => {
  const { k, clock, w } = triggered(t);
  w.arm();
  assert.equal(observation(w).attempts, 3);
  assert.equal(clock.pending(), 1);
  k.write(record(2, 1, 1));
  clock.next(49);
  assert.ok(w.finish());
  assert.equal(observation(w).attempts, 4);
  assert.equal(clock.pending(), 0);
});
test('the128th full attempt may be the final read, but repeated finish never obtains another', (t) => {
  const k = kernel(t),
    clock = pacedClock(t),
    w = k.start();
  w.arm();
  for (let i = 0; i < 125; i++) k.notify();
  assert.equal(observation(w).attempts, 127);
  assert.equal(clock.pending(), 0);
  k.write(record(2, 1, 1));
  assert.ok(w.finish());
  const reads = k.eventReads();
  assert.equal(observation(w).attempts, 128);
  w.finish();
  assert.equal(k.eventReads(), reads);
});
for (const [suffix, check] of [
  ['memory.max', 'limit'],
  ['memory.events.local', 'read'],
] as const)
  test('held ' + suffix + ' read ENODEV during burst cannot become evidence', (t) => {
    const { k, clock, w } = triggered(t);
    k.write(record(2, 1, 1));
    k.beforeRead((path) => {
      if (path.endsWith(suffix)) throw Object.assign(Error('gone'), { code: 'ENODEV' });
    });
    clock.next();
    assert.equal(w.finish(), undefined);
    assert.deepEqual(observation(w).failure, { phase: 'burst', check });
    assert.equal(observation(w).attempts, 4);
    assert.equal(k.held.size, 0);
    assert.equal(clock.pending(), 0);
  });
test('a discarded first triple never enters firstSample and cannot classify its failure diagnostics', (t) => {
  const k = kernel(t),
    clock = pacedClock(t),
    w = k.start();
  w.arm();
  k.write(record(2, 1, 1));
  k.afterRead((path) => {
    if (path.endsWith('memory.events.local')) fs.unlinkSync(join(k.leaf, 'memory.events.local'));
  });
  k.notify();
  assert.equal(w.finish(), undefined);
  assert.equal(observation(w).firstSample, undefined);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(observation(w).failure, { phase: 'notification', check: 'named-after' });
  assert.equal(cgroupMemoryFailure(undefined, { ...facts, memoryObservation: observation(w) } as any), undefined);
});
