// The zizmor adapter's non-code package assets, staged by scripts/pack-sentinel.mjs: its in-container worker and a
// manifest of exact digests, sizes, rights and pins. The adapter stays internal and unregistered; no fixture ships.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

export async function stageAssets(pkgDir, outDir) {
  const {
    ZIZMOR_ADAPTER,
    ZIZMOR_ENGINE,
    ZIZMOR_ENGINE_ARGS,
    ZIZMOR_IMAGE_PLATFORMS,
    ZIZMOR_SUPPORT,
    ZIZMOR_WORKER_BYTES,
    ZIZMOR_WORKER_DIGEST,
  } = await import(pathToFileURL(join(pkgDir, 'dist', 'adapters', 'zizmor', 'adapter.js')).href);
  if (sha(ZIZMOR_WORKER_BYTES) !== ZIZMOR_WORKER_DIGEST)
    throw new Error('the built zizmor worker does not match its digest');
  mkdirSync(join(outDir, 'assets', 'zizmor'), { recursive: true });
  writeFileSync(join(outDir, 'assets', 'zizmor', 'worker.sh'), ZIZMOR_WORKER_BYTES);
  const manifest = {
    schema: 'sentinel-zizmor-assets/draft-1',
    adapter: {
      id: ZIZMOR_ADAPTER.id,
      version: ZIZMOR_ADAPTER.version,
      image: ZIZMOR_ADAPTER.image,
      command: [...ZIZMOR_ADAPTER.command],
      engine: { ...ZIZMOR_ENGINE },
      engineArgs: [...ZIZMOR_ENGINE_ARGS],
      platforms: JSON.parse(JSON.stringify(ZIZMOR_IMAGE_PLATFORMS)),
    },
    worker: {
      path: 'assets/zizmor/worker.sh',
      digest: ZIZMOR_WORKER_DIGEST,
      size: ZIZMOR_WORKER_BYTES.length,
      rights: { spdx: 'MIT', origin: 'sentinel-original' },
    },
    support: JSON.parse(JSON.stringify(ZIZMOR_SUPPORT)),
    registered: false,
  };
  writeFileSync(join(outDir, 'assets', 'zizmor', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { files: ['assets'], exports: { './assets/*': './assets/*' } };
}
