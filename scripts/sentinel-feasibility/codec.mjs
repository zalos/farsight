// Fixed synthetic inputs only. No source capture, providers, acquisition or default-policy selection.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { cpus, release, totalmem } from 'node:os';
import * as zlib from 'node:zlib';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_BYTES = 2 * 1024 * 1024;

/** Size and identity controls for individual prototype objects, not an archive-import validator. */
export function decodeArtifact({ codec, bytes, expectedRawHash, expectedEncodedHash, maxDecodedBytes }) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) throw new Error('ENCODED_SIZE_LIMIT');
  if (!Number.isInteger(maxDecodedBytes) || maxDecodedBytes < 1 || maxDecodedBytes > MAX_BYTES) throw new Error('INVALID_DECODE_LIMIT');
  if (hash(bytes) !== expectedEncodedHash) throw new Error('ENCODED_HASH_MISMATCH');
  let decoded;
  if (codec === 'raw') {
    if (bytes.length > maxDecodedBytes) throw new Error('DECODED_SIZE_LIMIT');
    decoded = Buffer.from(bytes);
  } else if (codec === 'gzip') decoded = zlib.gunzipSync(bytes, { maxOutputLength: maxDecodedBytes });
  else if (codec === 'zstd' && typeof zlib.zstdDecompressSync === 'function') decoded = zlib.zstdDecompressSync(bytes, { maxOutputLength: maxDecodedBytes });
  else throw new Error('CODEC_UNAVAILABLE');
  if (decoded.length > maxDecodedBytes) throw new Error('DECODED_SIZE_LIMIT');
  if (hash(decoded) !== expectedRawHash) throw new Error('RAW_HASH_MISMATCH');
  return decoded;
}

function inputs() {
  const binary = Buffer.alloc(65_536);
  let state = 0x12345678;
  for (let i = 0; i < binary.length; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    binary[i] = state & 255;
  }
  return [
    { id: 'binary', bytes: binary, encoding: 'raw bytes including invalid UTF-8' },
    { id: 'utf8', bytes: Buffer.from('Synthetic source: café / 東京 / 🔐\r\nconst allowed = true;\n'.repeat(1024)), encoding: 'UTF-8 with CRLF and multibyte characters' },
  ];
}

export async function runCodecProbe({ artifactDir, maxDecodedBytes = 1_048_576 } = {}) {
  const result = { experiment: 'E8', status: 'measured', checks: [], metrics: { node: process.versions.node, platform: process.platform, arch: process.arch }, limitations: [
    'Two fixed synthetic objects and one synchronous trial per codec; no representative corpus or performance ranking. Decode timing includes digest verification.',
    'RSS before/after is a process snapshot. maxRSS is the process lifetime high-water mark in KiB, not a per-codec peak or allocation attribution.',
    'No provider calls, token/cost observations, scanner limits, admission defaults, retention defaults or /graph payload measurement.',
    'Experimental built-in zstd availability on this runtime does not establish cross-host portability or select a production codec.',
    'Individual object bounds/hashes do not validate archive paths, symlinks, object count or a full import protocol.',
  ], artifacts: [] };
  const check = (id, passed, evidence) => result.checks.push({ id, passed, evidence });
  try {
    if (Number(process.versions.node.split('.')[0]) < 24) {
      result.status = 'blocked'; check('node24-runtime', false, { node: process.versions.node, reason: 'Node 24 or later required' }); return result;
    }
    if (!artifactDir || !Number.isInteger(maxDecodedBytes) || maxDecodedBytes < 1 || maxDecodedBytes > MAX_BYTES) throw new Error('INVALID_PROBE_OPTIONS');
    await mkdir(artifactDir, { recursive: true, mode: 0o700 });
    const codecs = [
      { id: 'raw', encode: bytes => Buffer.from(bytes) },
      { id: 'gzip', encode: bytes => zlib.gzipSync(bytes, { level: 6 }) },
    ];
    const zstdAvailable = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function';
    if (zstdAvailable) codecs.push({ id: 'zstd', encode: bytes => zlib.zstdCompressSync(bytes) });
    else result.limitations.push('zstd comparison unavailable: this runtime does not expose both built-in synchronous APIs.');
    const measurements = [];
    for (const input of inputs()) {
      for (const codec of codecs) {
        const rssBeforeBytes = process.memoryUsage().rss;
        const maxRssBeforeKiB = process.resourceUsage().maxRSS;
        const cpuBefore = process.cpuUsage();
        const start = performance.now();
        const encoded = codec.encode(input.bytes);
        const encodedAt = performance.now();
        let decoded;
        let decodeOutcome = 'roundtrip';
        try {
          decoded = decodeArtifact({ codec: codec.id, bytes: encoded, expectedRawHash: hash(input.bytes), expectedEncodedHash: hash(encoded), maxDecodedBytes });
        } catch (error) {
          // Budget exhaustion is an observed gap, not success or an infrastructure failure.
          if (input.bytes.length <= maxDecodedBytes) throw error;
          decodeOutcome = 'decoded-size-budget-exhausted';
        }
        const finished = performance.now();
        const cpu = process.cpuUsage(cpuBefore);
        const rssAfterBytes = process.memoryUsage().rss;
        const maxRssAfterKiB = process.resourceUsage().maxRSS;
        const name = `E8-${input.id}.${codec.id}`;
        await writeFile(join(artifactDir, name), encoded, { mode: 0o600 });
        result.artifacts.push({ path: name, sha256: hash(encoded), bytes: encoded.length });
        measurements.push({ input: input.id, codec: codec.id, inputBytes: input.bytes.length, rawSha256: hash(input.bytes), encodedBytes: encoded.length,
          encodedSha256: hash(encoded), compressionMs: encodedAt - start, decodeMs: finished - encodedAt,
          cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system, rssBeforeBytes, rssAfterBytes,
          maxRssBeforeKiB, maxRssAfterKiB, decodeOutcome });
        check(`${input.id}-${codec.id}-roundtrip`, Boolean(decoded?.equals(input.bytes)), { inputBytes: input.bytes.length,
          rawSha256: hash(input.bytes), outcome: decodeOutcome, encoding: input.encoding });
        const rejects = (bytes, limit, rawHash = hash(input.bytes), encodedHash = hash(bytes)) => {
          try { decodeArtifact({ codec: codec.id, bytes, maxDecodedBytes: limit, expectedRawHash: rawHash, expectedEncodedHash: encodedHash }); return false; } catch { return true; }
        };
        const corrupt = Buffer.from(encoded); corrupt[Math.floor(corrupt.length / 2)] ^= 0xff;
        check(`${input.id}-${codec.id}-corrupt-rejected`, rejects(corrupt, MAX_BYTES), { control: 'changed encoded byte; recomputed encoded hash; original raw hash' });
        check(`${input.id}-${codec.id}-truncated-rejected`, rejects(encoded.subarray(0, Math.floor(encoded.length / 2)), MAX_BYTES), { control: 'half encoded bytes; recomputed encoded hash; original raw hash' });
        check(`${input.id}-${codec.id}-oversize-rejected`, rejects(encoded, 32), { maxDecodedBytes: 32, inputBytes: input.bytes.length });
        check(`${input.id}-${codec.id}-encoded-hash-rejected`, rejects(encoded, MAX_BYTES, hash(input.bytes), '0'.repeat(64)), { control: 'wrong compressed/object digest' });
      }
    }
    result.metrics = { node: process.versions.node, zlib: process.versions.zlib, zstd: process.versions.zstd ?? null,
      platform: process.platform, arch: process.arch, hardware: { osRelease: release(), cpuModel: cpus()[0]?.model ?? 'unavailable', logicalCpus: cpus().length, totalMemoryBytes: totalmem() }, maxDecodedBytes, encodedLimitBytes: MAX_BYTES, zstdAvailable,
      trialsPerInputCodec: 1, codecOptions: { raw: 'identity', gzip: { level: 6 }, zstd: zstdAvailable ? 'runtime default' : 'unavailable' }, measurements };
  } catch (error) {
    result.status = 'failed';
    check('probe-completed', false, { reason: /^[A-Z_]+$/.test(error.message) ? error.message : 'CODEC_PROBE_FAILURE', code: error.code ?? null });
  }
  return result;
}
