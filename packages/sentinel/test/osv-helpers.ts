// Shared set-up for the OSV adapter tests: synthetic advisory snapshots (a stored ZIP of original OSV records, the
// archive layout OSV-Scanner reads offline) and a temporary captured tree in which the fixtures take their real names.
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = fileURLToPath(new URL('./fixtures/advisories/', import.meta.url));
export const sha = (b: Uint8Array | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** A ZIP with stored (uncompressed) entries: enough for the engine, and byte-for-byte reproducible. */
export function storedZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [],
    centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x5421, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, e.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x5421, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A synthetic snapshot for one ecosystem from the named fixture advisories, as acquisition would record it. */
export function syntheticSnapshot(
  dir: string,
  ecosystem: 'npm' | 'Maven',
  ids: number[],
  sourceLastModified: string | null,
) {
  const entries = ids
    .map((n) => `SENTINEL-FIXTURE-2026-${String(n).padStart(4, '0')}.json`)
    .map((name) => ({ name, data: readFileSync(join(FIXTURES, 'advisories', name)) }))
    .filter((e) => JSON.parse(e.data.toString()).affected[0].package.ecosystem === ecosystem);
  const zip = storedZip(entries);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${ecosystem}-${ids.join('-')}.zip`);
  writeFileSync(path, zip, { mode: 0o600 });
  return {
    path,
    snapshot: Object.freeze({
      schema: 'sentinel-advisory-snapshot/draft-1' as const,
      ecosystem,
      source: `synthetic:fixtures/${ids.join(',')}`,
      sha256: sha(zip),
      md5: createHash('md5').update(zip).digest('base64'),
      size: zip.length,
      sourceLastModified,
      etag: null,
      acquiredAt: '2026-10-22T00:00:00.000000000Z',
    }),
  };
}

/** The fixtures under their real names inside a temporary captured tree (never installed); returns the targets. */
export function capturedTree(
  root: string,
  layout: Record<string, string> = {
    'web/package-lock.json': 'package-lock-json.fixture',
    'web/pnpm-lock.yaml': 'pnpm-lock-yaml.fixture',
    'api/pom.xml': 'pom-xml.fixture',
    'api/target/bom.cdx.json': 'bom-cdx-json.fixture',
  },
  extra: Record<string, string> = {},
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const out: { relativePath: string; artifact: string; path: string }[] = [];
  const add = (rel: string, bytes: Buffer) => {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: 0o600 });
    out.push({ relativePath: rel, artifact: sha(bytes), path });
  };
  for (const [rel, fixture] of Object.entries(layout)) add(rel, readFileSync(join(FIXTURES, 'inputs', fixture)));
  for (const [rel, text] of Object.entries(extra)) add(rel, Buffer.from(text));
  return out;
}

export const advisoryIds = () => readdirSync(join(FIXTURES, 'advisories')).length;
