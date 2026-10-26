// Sentinel's non-code package assets, staged by scripts/pack-sentinel.mjs: the original pattern rule pack and the
// pattern adapter's in-container worker, with a manifest of exact digests, sizes and rights. The adapter and the
// execution service stay internal (not exported); these files let a consumer verify what the adapter would supply
// to the pinned image, byte for byte.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

export async function stageAssets(pkgDir, outDir) {
  const { PATTERN_ADAPTER, PATTERN_WORKER_BYTES, PATTERN_WORKER_DIGEST, ENGINE_ARGS, PATTERN_ENGINE, PATTERN_SUPPORT } =
    await import(pathToFileURL(join(pkgDir, 'dist', 'adapters', 'pattern', 'adapter.js')).href);
  if (sha(PATTERN_WORKER_BYTES) !== PATTERN_WORKER_DIGEST)
    throw new Error('the built pattern worker does not match its digest');
  const packSrc = join(pkgDir, 'rules', 'pattern');
  const pack = JSON.parse(readFileSync(join(packSrc, 'sentinel-pack.json'), 'utf8'));
  cpSync(packSrc, join(outDir, 'rules', 'pattern'), { recursive: true });
  const files = readdirSync(packSrc, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) =>
      relative(packSrc, join(e.parentPath ?? e.path, e.name))
        .split('\\')
        .join('/'),
    )
    .sort()
    .map((path) => {
      const bytes = readFileSync(join(packSrc, path));
      return { path, digest: sha(bytes), size: bytes.length };
    });
  mkdirSync(join(outDir, 'assets', 'pattern'), { recursive: true });
  writeFileSync(join(outDir, 'assets', 'pattern', 'worker.py'), PATTERN_WORKER_BYTES);
  const manifest = {
    schema: 'sentinel-pattern-assets/draft-1',
    adapter: {
      id: PATTERN_ADAPTER.id,
      version: PATTERN_ADAPTER.version,
      image: PATTERN_ADAPTER.image,
      command: [...PATTERN_ADAPTER.command],
      engine: { ...PATTERN_ENGINE },
      engineArgs: [...ENGINE_ARGS],
    },
    worker: {
      path: 'assets/pattern/worker.py',
      digest: PATTERN_WORKER_DIGEST,
      size: PATTERN_WORKER_BYTES.length,
      rights: { spdx: 'MIT', origin: 'sentinel-original' },
    },
    pack: { path: 'rules/pattern', packId: pack.packId, version: pack.version, rights: pack.rights, files },
    support: JSON.parse(JSON.stringify(PATTERN_SUPPORT)),
    registered: false,
  };
  writeFileSync(join(outDir, 'assets', 'pattern', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { files: ['rules', 'assets'], exports: { './rules/*': './rules/*', './assets/*': './assets/*' } };
}
