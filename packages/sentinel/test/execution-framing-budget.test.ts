// The frame decoder's memory under hostile chunking. A worker controls how its stdout is split; however fine the
// split, the decoder must buffer at most one frame, decode exactly the messages a whole-buffer feed would, and
// apply every limit before decoding. Resource evidence is black-box: a child process with a small V8 heap must
// decode a frame at the limit fed a byte at a time, and a count of the byte-copying Buffer allocations made while
// pushing must stay proportional to one frame, not to the number of pushes. No test asserts on RSS or timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FrameDecoder, DEFAULT_MAX_FRAME_BYTES } from '../dist/execution/protocol.js';
import { isExecutionError } from '../dist/execution/errors.js';

const VALID = fileURLToPath(new URL('./contracts/valid/', import.meta.url));
const PROTOCOL_DIST = fileURLToPath(new URL('../dist/execution/protocol.js', import.meta.url));
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
  const longest = 3001;
  for (const [seed, max] of [[1, 1], [2, 2], [3, 3], [4, 7], [5, 64], [6, 4096], [7, 100_000]] as const) {
    const d = new FrameDecoder();
    const split = [...chunks(stream, seed, max)];
    const { result: out, allocations } = countingAllocations(() => split.flatMap(c => d.push(c)));
    d.end();
    assert.deepEqual(out, whole, `seed ${seed}, chunks of 1..${max} bytes`);
    const copied = allocations.reduce((a, b) => a + b, 0);
    assert.ok(copied <= 2 * Math.max(longest, 4096), `seed ${seed}: ${copied} bytes copied for a ${stream.length}-byte stream`);
  }
});

test('a frame at the limit, pushed one byte at a time, decodes within a 48 MB V8 heap', () => {
  // A child process with a small old-space limit, retaining nothing but the decoder and the one frame: per-push
  // Buffer objects or views would exhaust this heap long before the newline arrives (the pre-fix decoder does).
  const child = `
    const { FrameDecoder, DEFAULT_MAX_FRAME_BYTES } = await import(${JSON.stringify(PROTOCOL_DIST)});
    const text = ${JSON.stringify(JSON.stringify(unicode(0)))};
    const frame = Buffer.from(text + ' '.repeat(DEFAULT_MAX_FRAME_BYTES - Buffer.byteLength(text)) + '\\n');
    const d = new FrameDecoder();
    let messages = 0;
    for (let i = 0; i < frame.length; i++) messages += d.push(frame.subarray(i, i + 1)).length;
    d.end();
    process.stdout.write(JSON.stringify({ messages, pushes: frame.length }));
  `;
  const r = spawnSync(process.execPath, ['--max-old-space-size=48', '--input-type=module', '-e', child], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `the child must finish within its heap: signal ${r.signal} ${r.stderr.slice(-400)}`);
  assert.deepEqual(JSON.parse(r.stdout), { messages: 1, pushes: DEFAULT_MAX_FRAME_BYTES + 1 });
});

test('pushing one frame a byte at a time copies O(frame) bytes in O(log frame) allocations', () => {
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
  assert.ok(allocations.length <= 32, `${allocations.length} allocations for ${frame.length} pushes`);
  assert.ok(allocations.every(n => n <= maxFrameBytes), 'no buffer larger than one frame');
  assert.ok(allocations.reduce((a, b) => a + b, 0) <= 2 * maxFrameBytes, 'at most two frames copied in total');
});

test('the buffer is reused across frames: many large split frames add no allocation', () => {
  const frame = line(unicode(1), 200_000);
  const d = new FrameDecoder();
  const warm = countingAllocations(() => { d.push(frame.subarray(0, 10)); d.push(frame.subarray(10)); });
  assert.ok(warm.allocations.length > 0, 'the first split frame does need a buffer');
  const { result, allocations } = countingAllocations(() => {
    let out = 0;
    for (let k = 0; k < 20; k++) for (const c of chunks(frame, 100 + k, 37)) out += d.push(c).length;
    return out;
  });
  assert.equal(result, 20);
  assert.deepEqual(allocations, [], 'no new buffer for later frames');
});

test('a line over the limit is refused at the byte that crosses it, before any newline or decode', () => {
  const maxFrameBytes = 1024;
  const d = new FrameDecoder({ maxFrameBytes });
  const over = Buffer.alloc(maxFrameBytes + 1, 0x20);
  const { allocations } = countingAllocations(() => {
    for (let i = 0; i < maxFrameBytes; i++) d.push(over.subarray(i, i + 1));
    assert.throws(() => d.push(over.subarray(maxFrameBytes)), is('sentinel.execution.frameTooLarge'));
  });
  assert.ok(allocations.every(n => n <= maxFrameBytes), 'nothing past the limit was buffered');
  assert.throws(() => d.push(Buffer.from('\n')), is('sentinel.execution.frameTooLarge'), 'a failed decoder stays failed');
  // A whole line in one chunk is checked the same way, with no buffering at all.
  const fresh = new FrameDecoder({ maxFrameBytes });
  const whole = Buffer.concat([over, Buffer.from('\n')]);
  const none = countingAllocations(() => assert.throws(() => fresh.push(whole), is('sentinel.execution.frameTooLarge')));
  assert.deepEqual(none.allocations, [], 'an oversized complete line is refused without copying it');
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
  const mixed = Buffer.concat([a, b, c.subarray(0, 5)]);
  const { result: first, allocations } = countingAllocations(() => d.push(mixed));
  assert.deepEqual(first.map(m => (m as { seq: number }).seq), [4, 5]);
  assert.equal(allocations.length, 1, 'only the 5-byte tail is copied, the complete lines are decoded in place');
  assert.deepEqual(d.push(c.subarray(5)).map(m => (m as { seq: number }).seq), [6]);
  d.end();
});
