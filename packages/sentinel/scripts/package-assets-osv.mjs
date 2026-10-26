// The OSV adapter's non-code package assets, staged by scripts/pack-sentinel.mjs: its in-container worker and a
// manifest of exact digests, sizes, rights and pins. The adapter stays internal and unregistered; no advisory database
// or fixture ships (databases are acquired by the owner, separately, and never bundled).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

export async function stageAssets(pkgDir, outDir) {
  const {
    OSV_ADAPTER,
    OSV_ENGINE,
    OSV_ENGINE_ARGS,
    OSV_IMAGE_PLATFORMS,
    OSV_SUPPORT,
    OSV_WORKER_BYTES,
    OSV_WORKER_DIGEST,
  } = await import(pathToFileURL(join(pkgDir, 'dist', 'adapters', 'osv', 'adapter.js')).href);
  if (sha(OSV_WORKER_BYTES) !== OSV_WORKER_DIGEST) throw new Error('the built OSV worker does not match its digest');
  mkdirSync(join(outDir, 'assets', 'osv'), { recursive: true });
  writeFileSync(join(outDir, 'assets', 'osv', 'worker.sh'), OSV_WORKER_BYTES);
  const manifest = {
    schema: 'sentinel-osv-assets/draft-1',
    adapter: {
      id: OSV_ADAPTER.id,
      version: OSV_ADAPTER.version,
      image: OSV_ADAPTER.image,
      command: [...OSV_ADAPTER.command],
      engine: { ...OSV_ENGINE },
      engineArgs: [...OSV_ENGINE_ARGS],
      platforms: JSON.parse(JSON.stringify(OSV_IMAGE_PLATFORMS)),
    },
    worker: {
      path: 'assets/osv/worker.sh',
      digest: OSV_WORKER_DIGEST,
      size: OSV_WORKER_BYTES.length,
      rights: { spdx: 'MIT', origin: 'sentinel-original' },
    },
    support: JSON.parse(JSON.stringify(OSV_SUPPORT)),
    databases: 'acquired separately by the owner; none ship',
    registered: false,
  };
  writeFileSync(join(outDir, 'assets', 'osv', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { files: ['assets'], exports: { './assets/*': './assets/*' } };
}
