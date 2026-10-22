// Trusted experiment child; never loads captured source or scanner-selected code.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const [input, output, codec] = process.argv.slice(2);
if (!['raw', 'gzip', 'zstd'].includes(codec)) throw new Error('INVALID_CODEC');
const bytes = await readFile(input);
if (bytes.length > 16 * 1024 * 1024) throw new Error('INPUT_LIMIT');
if (codec === 'zstd' && (typeof zlib.zstdCompressSync !== 'function' || typeof zlib.zstdDecompressSync !== 'function')) {
  console.log(JSON.stringify({ state: 'unavailable', codec, reason: 'NODE_ZSTD_API_UNAVAILABLE' }));
} else {
  const rssBeforeBytes = process.memoryUsage().rss, begin = performance.now();
  const encoded = codec === 'raw' ? Buffer.from(bytes) : codec === 'gzip' ? zlib.gzipSync(bytes, { level: 6 }) : zlib.zstdCompressSync(bytes);
  const encodedAt = performance.now();
  const decoded = codec === 'raw' ? Buffer.from(encoded) : codec === 'gzip' ? zlib.gunzipSync(encoded, { maxOutputLength: 16 * 1024 * 1024 }) : zlib.zstdDecompressSync(encoded, { maxOutputLength: 16 * 1024 * 1024 });
  const decodedAt = performance.now();
  await writeFile(output, encoded, { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ state: decoded.equals(bytes) ? 'measured' : 'failed', codec, rawBytes: bytes.length,
    encodedBytes: encoded.length, rawSha256: sha(bytes), encodedSha256: sha(encoded), encodeMs: encodedAt - begin,
    decodeMs: decodedAt - encodedAt, rssBeforeBytes, rssAfterBytes: process.memoryUsage().rss,
    childLifetimeMaxRssKiB: process.resourceUsage().maxRSS,
    memoryProvenance: 'Node resourceUsage.maxRSS: fresh child lifetime high-water including startup/input/codec/write/hash; not codec-only peak',
    node: process.versions.node, zlib: process.versions.zlib, zstd: process.versions.zstd ?? null }));
}
