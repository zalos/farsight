// Object headers whose deflate stream spends more than 64 bytes on Huffman tables before its first output bytes.
// A fixed 64-byte prefix decoded only "blob " for such objects, so intact committed files were recorded as corrupt.
// Real Git repositories; the git CLI only builds fixtures, and the reader under test never starts a process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants as Z, deflateSync, inflateSync } from 'node:zlib';
import { GitReadError, GitRepository, HEADER_PREFIX_STEPS, inflateHeader } from '../dist/snapshot/git.js';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { commitRepo, git, needsStore, openCaptureStore, scratch } from './snapshot-helpers.ts';

const corrupt = (e: unknown) => e instanceof GitReadError && e.code === 'corrupt';
const looseFile = (root: string, oid: string) => join(root, '.git/objects', oid.slice(0, 2), oid.slice(2));
const prefixOutput = (bytes: Buffer, n: number) => inflateSync(bytes.subarray(0, n), { finishFlush: Z.Z_SYNC_FLUSH, maxOutputLength: 1 << 20 });

// The exact reproducer: a 1,264-byte Spring configuration (the PR 17 fixture) that zlib stores with a long dynamic
// Huffman table. Its first 64 compressed bytes decode to "blob " only.
const SPRING_CONFIG = `package app;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
public class SecurityConfig {

  // Earlier and narrower: deliberately open.
  @Bean
  @Order(1)
  public SecurityFilterChain openChain(HttpSecurity http) throws Exception {
    http.securityMatcher("/api/secure/public/**")
        .authorizeHttpRequests(auth -> auth.anyRequest().permitAll())
        .csrf(csrf -> csrf.disable());
    return http.build();
  }

  // Later and broader: requires authentication for what the open chain did not claim.
  @Bean
  @Order(2)
  public SecurityFilterChain secureChain(HttpSecurity http) throws Exception {
    http.securityMatcher("/api/secure/**")
        .authorizeHttpRequests(auth -> auth
            .requestMatchers(HttpMethod.POST, "/api/secure/admin/**").hasRole("ADMIN")
            .anyRequest().authenticated())
        .httpBasic(basic -> {});
    return http.build();
  }
}
`;

/** Writes a loose blob object with exactly these compressed bytes, as git would name it. */
function writeLoose(root: string, data: Buffer, compressed?: Buffer): string {
  const raw = Buffer.concat([Buffer.from(`blob ${data.length}\0`), data]);
  const oid = createHash('sha1').update(raw).digest('hex');
  mkdirSync(join(root, '.git/objects', oid.slice(0, 2)), { recursive: true });
  writeFileSync(looseFile(root, oid), compressed ?? deflateSync(raw));
  return oid;
}

/**
 * Deterministic source-like text: a few keywords, punctuation and a spread of printable characters. At 2 000 bytes and
 * more, zlib's default level emits a dynamic block whose Huffman tables outlast the first 64 compressed bytes.
 */
function sourceLike(length: number, seed = 1): Buffer {
  const words = ['public', 'class', 'return', 'import', 'security', 'matcher', 'request', 'authorize', 'chain', 'order',
    'bean', 'profile', 'http', 'build', 'permit', 'authenticated', 'role', 'admin', 'api', 'secure'];
  let x = seed;
  let s = '';
  const next = () => (x = (x * 1103515245 + 12345) & 0x7fffffff);
  while (s.length < length) {
    const w = words[next() % words.length]!;
    next();
    s += w + (x % 7 === 0 ? `("/${w}/**");\n` : x % 3 === 0 ? '.' : ' ') + String.fromCharCode(33 + ((x >> 4) % 90));
  }
  return Buffer.from(s.slice(0, length));
}

test('the reproducer: a committed loose blob whose header is past the first 64 compressed bytes reads intact', needsStore, async t => {
  const dir = scratch(t);
  const root = join(dir, 'repo');
  commitRepo(root, { 'SecurityConfig.java': SPRING_CONFIG });
  const oid = git(root, ['rev-parse', 'HEAD:SecurityConfig.java']).trim();
  const stored = readFileSync(looseFile(root, oid));
  // The precondition the old reader failed on: 64 compressed bytes do not reach the header's NUL.
  assert.equal(prefixOutput(stored, 64).indexOf(0), -1);
  assert.equal(prefixOutput(stored, 64).toString('latin1'), 'blob ');
  const repo = GitRepository.open(root);
  assert.deepEqual(repo.objectHeader(oid), { type: 'blob', size: Buffer.byteLength(SPRING_CONFIG) });
  assert.equal(repo.readObject(oid, 1 << 20)!.data.toString('utf8'), SPRING_CONFIG);
  repo.close();
  // End to end: committed-tree capture keeps the file instead of recording it as corrupt.
  const fx = await openCaptureStore(t, dir);
  const { snapshot } = await captureSnapshot(fx.store, { mode: 'committed-tree', sources: [{ sourceId: 'app', repositoryId: 'example/app', root }] });
  const entry: any = snapshot.entries.find((e: any) => e.relativePath === 'SecurityConfig.java');
  assert.equal(entry.disposition, 'included', JSON.stringify(entry));
});

test('a long Huffman-table header is found within the bounded prefix steps, with its exact type and size', t => {
  const root = join(scratch(t), 'repo');
  commitRepo(root, { 'seed.txt': 'seed\n' });
  for (const length of [2_000, 20_000, 300_000]) {
    const data = sourceLike(length);
    const oid = writeLoose(root, data);
    const stored = readFileSync(looseFile(root, oid));
    assert.equal(prefixOutput(stored, 64).indexOf(0), -1, `${length}: the header is not in the first 64 compressed bytes`);
    const repo = GitRepository.open(root);
    assert.deepEqual(repo.objectHeader(oid), { type: 'blob', size: length });
    assert.ok(repo.readObject(oid, length)!.data.equals(data));
    repo.close();
  }
});

test('packed objects and deltas report the same headers git does', t => {
  const root = join(scratch(t), 'repo');
  const base = Array.from({ length: 400 }, (_, i) => `line ${i} ${sourceLike(40).toString('base64')}`).join('\n');
  commitRepo(root, { 'a.txt': base });
  for (let v = 1; v <= 6; v++) {
    writeFileSync(join(root, 'a.txt'), base.replace(`line ${v * 30} `, `line ${v * 30} changed ${v} `) + `\ntail ${v}\n`);
    git(root, ['commit', '--quiet', '-am', `v${v}`]);
  }
  git(root, ['repack', '-adf', '--depth=8', '--window=10', '--quiet']);
  const batch = git(root, ['cat-file', '--batch-all-objects', '--batch-check']).trim().split('\n').map(l => l.split(' '));
  const repo = GitRepository.open(root);
  for (const [oid, type, size] of batch) assert.deepEqual(repo.objectHeader(oid!), { type, size: Number(size) }, oid);
  repo.close();
  const packDir = join(root, '.git/objects/pack');
  const idx = readdirSync(packDir).filter(n => n.endsWith('.idx')).map(n => join(packDir, n));
  assert.match(git(root, ['verify-pack', '-v', ...idx]), /chain length = [1-9]/, 'the pack really holds deltas');
});

test('a delta whose size varints are behind a long Huffman table decodes them', () => {
  // Two varints (base size 300 000, result size 299 990) followed by data that forces a dynamic table.
  const varints = Buffer.from([0xe0, 0xa7, 0x12, 0xd6, 0xa7, 0x12]);
  const stream = deflateSync(Buffer.concat([varints, sourceLike(5_000)]));
  assert.ok(prefixOutput(stream, 64).length < varints.length, 'precondition: 64 bytes do not reach both varints');
  const complete = (out: Buffer) => out.length >= varints.length;
  assert.deepEqual([...inflateHeader(stream, complete, 'a delta').subarray(0, 6)], [...varints]);
});

test('corrupt, truncated, garbage, over-long and bomb streams are refused within the bounds', t => {
  const root = join(scratch(t), 'repo');
  commitRepo(root, { 'seed.txt': 'seed\n' });
  const data = sourceLike(20_000);
  const good = writeLoose(root, data);
  const stored = readFileSync(looseFile(root, good));
  const variant = (name: string, bytes: Buffer) => {
    const oid = createHash('sha1').update(name).digest('hex');
    mkdirSync(join(root, '.git/objects', oid.slice(0, 2)), { recursive: true });
    writeFileSync(looseFile(root, oid), bytes);
    return oid;
  };
  const repo = GitRepository.open(root);
  // Cut inside the Huffman table: no header can be decoded.
  assert.throws(() => repo.objectHeader(variant('truncated', stored.subarray(0, 40))), corrupt);
  // Not a zlib stream.
  assert.throws(() => repo.objectHeader(variant('garbage', Buffer.from('this is not deflate data at all'))), corrupt);
  // Bytes flipped inside the stream: either it fails to decode or the content fails its hash.
  const flipped = Buffer.from(stored);
  for (let i = 30; i < 60; i++) flipped[i] = flipped[i]! ^ 0xff;
  const bad = variant('flipped', flipped);
  assert.throws(() => { repo.objectHeader(bad); repo.readObject(bad, 1 << 20); }, corrupt);
  // A header that never ends: longer than any real header, refused without decoding further.
  assert.throws(() => repo.objectHeader(variant('long-header', deflateSync(Buffer.from(`blob ${'9'.repeat(5_000)}\0`)))), corrupt);
  // A decompression bomb: 64 MiB of zeros. Its header reads from a few bytes; its body is refused by the size limit.
  const bombData = Buffer.alloc(64 * 1024 * 1024);
  const bomb = writeLoose(root, bombData, deflateSync(Buffer.concat([Buffer.from(`blob ${bombData.length}\0`), bombData])));
  const before = process.memoryUsage().arrayBuffers;
  assert.deepEqual(repo.objectHeader(bomb), { type: 'blob', size: bombData.length });
  assert.ok(process.memoryUsage().arrayBuffers - before < 32 * 1024 * 1024, 'reading a header does not decode the body');
  assert.throws(() => repo.readObject(bomb, 1 << 20), corrupt);
  repo.close();
  chmodSync(looseFile(root, good), 0o444);
  assert.deepEqual(HEADER_PREFIX_STEPS, [64, 256, 1024, 4096]);
});
