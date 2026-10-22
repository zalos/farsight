// The frame decoder's memory under hostile chunking. A worker controls how its stdout is split; however fine the
// split, the decoder must buffer at most one frame, decode exactly the messages a whole-buffer feed would, and
// apply every limit before decoding. Resource evidence is the decoder's own reserved capacity and a count of its
// buffer allocations, both deterministic; no test asserts on RSS or timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FrameDecoder, DEFAULT_MAX_FRAME_BYTES } from '../dist/execution/protocol.js';
import { isExecutionError } from '../dist/execution/errors.js';

const VALID = fileURLToPath(new URL('./contracts/valid/', import.meta.url));
const fixture = (name: string) => JSON.parse(readFileSync(`${VALID}${name}.json`, 'utf8')) as Record<string, unknown>;
const is = (code: string) => (e: unknown) => isExecutionError(e) && e.code === code;

/** A valid diagnostic whose scope id carries 2-, 3- and 4-byte UTF-8 characters. */
const unicode = (i: number) => ({ ...fixture('protocol-diagnostic'), seq: i, scopeId: `api:src/é✓😀-${i}.ts` });
const line = (message: unknown, padTo = 0) => {
  const text = JSON.stringify(message);
  // JSON allows trailing whitespace, so a frame can be padded to an exact size and still decode.
  return Buffer.from(`${text}${' '.repeat(Math.max(0, padTo - Buffer.byteLength(text)))}\n`);
};

/** A deterministic PRNG (mulberry32), so every chunking is reproducible from its seed. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Splits bytes into chunks of 1..max bytes, each a view of the input (as a pipe delivers them). */
function* chunks(bytes: Buffer, seed: number, max: number) {
  const next = rng(seed);
  for (let at = 0; at < bytes.length;) {
    const size = 1 + Math.floor(next() * max);
    yield bytes.subarray(at, at + size);
    at += size;
  }
}

/**
 * Records every byte-copying Buffer allocation made while `body` runs: alloc, allocUnsafe, concat and a copying
 * Buffer.from (a view over an existing ArrayBuffer allocates no bytes and is not counted).
 */
function countingAllocations<T>(body: () => T): { result: T; allocations: number[] } {
  const saved = { alloc: Buffer.alloc, allocUnsafe: Buffer.allocUnsafe, concat: Buffer.concat, from: Buffer.from };
  const allocations: number[] = [];
  const record = <B extends Buffer>(b: B): B => { allocations.push(b.byteLength); return b; };
  Buffer.alloc = ((...a: Parameters<typeof Buffer.alloc>) => record(saved.alloc(...a))) as typeof Buffer.alloc;
  Buffer.allocUnsafe = ((size: number) => record(saved.allocUnsafe(size))) as typeof Buffer.allocUnsafe;
  Buffer.concat = ((...a: Parameters<typeof Buffer.concat>) => record(saved.concat(...a))) as typeof Buffer.concat;
  Buffer.from = ((...a: unknown[]) => {
    const b = (saved.from as (...x: unknown[]) => Buffer)(...a);
    return a[0] instanceof ArrayBuffer || a[0] instanceof SharedArrayBuffer ? b : record(b);
  }) as typeof Buffer.from;
  try { return { result: body(), allocations }; } finally { Object.assign(Buffer, saved); }
}

test('any chunking decodes the same messages as one whole buffer, including split UTF-8 characters', () => {
  const stream = Buffer.concat(Array.from({ length: 40 }, (_, i) => line(unicode(i), i % 5 === 0 ? 3000 : 0)));
  const whole = new FrameDecoder().push(stream);
  assert.equal(whole.length, 40);
  for (const [seed, max] of [[1, 1], [2, 2], [3, 3], [4, 7], [5, 64], [6, 4096], [7, 100_000]] as const) {
    const d = new FrameDecoder();
    const out = [...chunks(stream, seed, max)].flatMap(c => d.push(c));
    d.end();
    assert.deepEqual(out, whole, `seed ${seed}, chunks of 1..${max} bytes`);
    assert.ok(d.bufferedCapacity <= 4096, `seed ${seed}: small frames never reserve more than the initial buffer`);
  }
});

test('a frame at the limit, pushed one byte at a time, reserves at most one frame and grows by doubling', () => {
  const maxFrameBytes = DEFAULT_MAX_FRAME_BYTES;
  const frame = line(unicode(0), maxFrameBytes);
  assert.equal(frame.length - 1, maxFrameBytes, 'exactly the frame limit');
  const d = new FrameDecoder({ maxFrameBytes });
  const { result: messages, allocations } = countingAllocations(() => {
    let out = 0;
    for (let i = 0; i < frame.length; i++) out += d.push(frame.subarray(i, i + 1)).length;
    return out;
  });
  d.end();
  assert.equal(messages, 1);
  assert.equal(d.bufferedCapacity, maxFrameBytes, 'capacity is bounded by the frame limit');
  // 4 KiB doubling to 1 MiB: 9 allocations whatever the number of pushes (1,000,000+ here), not one per push.
  assert.deepEqual(allocations, [4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576]);
  assert.equal(allocations.reduce((a, b) => a + b, 0) < 2 * maxFrameBytes, true, 'total allocation below two frames');
});

test('the buffer is reused across frames: many large split frames add no allocation', () => {
  const frame = line(unicode(1), 200_000);
  const d = new FrameDecoder();
  d.push(frame.subarray(0, 10)); d.push(frame.subarray(10)); // first frame reserves its capacity
  const reserved = d.bufferedCapacity;
  assert.ok(reserved >= 200_000 && reserved <= DEFAULT_MAX_FRAME_BYTES, `one reusable buffer of ${reserved} bytes`);
  const { result, allocations } = countingAllocations(() => {
    let out = 0;
    for (let k = 0; k < 20; k++) for (const c of chunks(frame, 100 + k, 37)) out += d.push(c).length;
    return out;
  });
  assert.equal(result, 20);
  assert.deepEqual(allocations, [], 'no new buffer for later frames');
  assert.equal(d.bufferedCapacity, reserved);
});

test('a line over the limit is refused at the byte that crosses it, before any newline or decode', () => {
  const maxFrameBytes = 1024;
  const d = new FrameDecoder({ maxFrameBytes });
  const over = Buffer.alloc(maxFrameBytes + 1, 0x20);
  for (let i = 0; i < maxFrameBytes; i++) d.push(over.subarray(i, i + 1));
  assert.throws(() => d.push(over.subarray(maxFrameBytes)), is('sentinel.execution.frameTooLarge'));
  assert.ok(d.bufferedCapacity <= maxFrameBytes, 'the refused byte was never buffered');
  assert.throws(() => d.push(Buffer.from('\n')), is('sentinel.execution.frameTooLarge'), 'a failed decoder stays failed');
  // A whole line in one chunk is checked the same way, with no buffering at all.
  const fresh = new FrameDecoder({ maxFrameBytes });
  assert.throws(() => fresh.push(Buffer.concat([over, Buffer.from('\n')])), is('sentinel.execution.frameTooLarge'));
  assert.equal(fresh.bufferedCapacity, 0);
});

test('invalid UTF-8 split across chunks is refused; an unterminated tail is malformed at end()', () => {
  const good = line(unicode(2));
  const bad = Buffer.from(good);
  bad[bad.indexOf(0xe2)] = 0xff; // break the 3-byte character
  const d = new FrameDecoder();
  assert.throws(() => { for (const c of chunks(bad, 9, 2)) d.push(c); }, is('sentinel.execution.frameMalformed'));
  const tail = new FrameDecoder();
  for (const c of chunks(good.subarray(0, good.length - 1), 10, 3)) tail.push(c);
  assert.throws(() => tail.end(), is('sentinel.execution.frameMalformed'));
  assert.throws(() => tail.end(), is('sentinel.execution.frameMalformed'), 'end() keeps failing');
});

test('frame-count and total-byte budgets hold under single-byte chunking', () => {
  const one = line(unicode(3));
  const frames = new FrameDecoder({ maxFrames: 3 });
  const four = Buffer.concat([one, one, one, one]);
  assert.throws(() => { for (let i = 0; i < four.length; i++) frames.push(four.subarray(i, i + 1)); }, is('sentinel.execution.stdoutBudget'));
  assert.equal(frames.frames, 4, 'the fourth frame is the one refused');
  const total = new FrameDecoder({ maxTotalBytes: one.length * 2 });
  const three = Buffer.concat([one, one, one]);
  let refusedAt = -1;
  try { for (let i = 0; i < three.length; i++) { refusedAt = i; total.push(three.subarray(i, i + 1)); } } catch (e) {
    assert.ok(is('sentinel.execution.stdoutBudget')(e));
  }
  assert.equal(refusedAt, one.length * 2, 'refused at the first byte past the total budget');
});

test('mixed chunks: complete lines are decoded in place, a following partial line is buffered alone', () => {
  const a = line(unicode(4)), b = line(unicode(5)), c = line(unicode(6));
  const d = new FrameDecoder();
  const first = d.push(Buffer.concat([a, b, c.subarray(0, 5)]));
  assert.deepEqual(first.map(m => (m as { seq: number }).seq), [4, 5]);
  assert.ok(d.bufferedCapacity > 0 && d.bufferedCapacity <= 4096);
  assert.deepEqual(d.push(c.subarray(5)).map(m => (m as { seq: number }).seq), [6]);
  d.end();
});
