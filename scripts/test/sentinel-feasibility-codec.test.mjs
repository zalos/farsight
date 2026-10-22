import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { decodeArtifact, runCodecProbe } from '../sentinel-feasibility/codec.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('fixed binary and UTF-8 objects roundtrip with retained raw/gzip and available zstd evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sentinel-codec-test-'));
  try {
    const result = await runCodecProbe({ artifactDir: root });
    assert.equal(result.status, 'measured', JSON.stringify(result));
    assert.equal(result.experiment, 'E8');
    assert.deepEqual(result.checks.filter(check => !check.passed), []);
    const expectedCodecs = typeof zstdCompressSync === 'function' ? 3 : 2;
    assert.equal(result.metrics.measurements.length, 2 * expectedCodecs);
    assert.equal(result.checks.length, 2 * expectedCodecs * 5);
    for (const measurement of result.metrics.measurements) {
      assert.ok(measurement.inputBytes > 32 && measurement.encodedBytes > 0);
      assert.ok(measurement.compressionMs >= 0 && measurement.decodeMs >= 0);
      assert.ok(measurement.rssBeforeBytes > 0 && measurement.rssAfterBytes > 0);
      const artifact = result.artifacts.find(item => item.path === `E8-${measurement.input}.${measurement.codec}`);
      const encoded = await readFile(join(root, artifact.path));
      assert.equal(encoded.length, artifact.bytes);
      assert.equal(hash(encoded), artifact.sha256);
      const decoded = decodeArtifact({ codec: measurement.codec, bytes: encoded,
        expectedRawHash: measurement.rawSha256, expectedEncodedHash: measurement.encodedSha256, maxDecodedBytes: 1_048_576 });
      assert.equal(hash(decoded), measurement.rawSha256);
      if (measurement.input === 'binary') assert.notDeepEqual(Buffer.from(decoded.toString('utf8')), decoded);
      else assert.deepEqual(Buffer.from(decoded.toString('utf8')), decoded);
    }
    assert.ok(result.limitations.some(text => text.includes('not a per-codec peak')));
    assert.ok(!JSON.stringify(result).includes(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('budget exhaustion is a measured gap with explicit failed roundtrips', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sentinel-codec-budget-'));
  try {
    const result = await runCodecProbe({ artifactDir: root, maxDecodedBytes: 32 });
    assert.equal(result.status, 'measured');
    const gaps = result.checks.filter(check => !check.passed);
    assert.equal(gaps.length, result.metrics.measurements.length);
    assert.ok(gaps.every(check => check.id.endsWith('-roundtrip') && check.evidence.outcome === 'decoded-size-budget-exhausted'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('decoder independently enforces content identity, expansion and encoded bounds', () => {
  const raw = Buffer.alloc(65_536, 'x');
  const bytes = gzipSync(raw);
  const options = { codec: 'gzip', bytes, expectedRawHash: hash(raw), expectedEncodedHash: hash(bytes), maxDecodedBytes: 1_048_576 };
  assert.deepEqual(decodeArtifact(options), raw);
  assert.throws(() => decodeArtifact({ ...options, maxDecodedBytes: 32 }));
  assert.throws(() => decodeArtifact({ ...options, expectedRawHash: hash('different') }), /RAW_HASH_MISMATCH/);
  const truncated = bytes.subarray(0, bytes.length - 4);
  assert.throws(() => decodeArtifact({ ...options, bytes: truncated, expectedEncodedHash: hash(truncated) }));
  assert.throws(() => decodeArtifact({ ...options, expectedEncodedHash: '0'.repeat(64) }), /ENCODED_HASH_MISMATCH/);
  assert.throws(() => decodeArtifact({ ...options, bytes: Buffer.alloc(2 * 1024 * 1024 + 1) }), /ENCODED_SIZE_LIMIT/);
  assert.throws(() => decodeArtifact({ ...options, maxDecodedBytes: 0 }), /INVALID_DECODE_LIMIT/);
  assert.throws(() => decodeArtifact({ ...options, codec: 'unknown' }), /CODEC_UNAVAILABLE/);
});

test('an unexpected decoder failure above the budget remains a probe failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sentinel-codec-unexpected-'));
  const mutableZlib = createRequire(import.meta.url)('node:zlib');
  const original = mutableZlib.gunzipSync;
  try {
    mutableZlib.gunzipSync = () => { throw new Error('UNEXPECTED_DECODER_FAILURE'); };
    syncBuiltinESMExports();
    const result = await runCodecProbe({ artifactDir: root, maxDecodedBytes: 32 });
    assert.equal(result.status, 'failed');
    assert.equal(result.checks.find(check => check.id === 'probe-completed')?.evidence.reason, 'UNEXPECTED_DECODER_FAILURE');
    assert.ok(!result.checks.some(check => check.id === 'binary-gzip-roundtrip'));
  } finally {
    mutableZlib.gunzipSync = original; syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
