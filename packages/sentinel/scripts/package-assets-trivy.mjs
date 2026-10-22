// The Trivy adapter's non-code package assets, staged by scripts/pack-sentinel.mjs: its in-container worker and a
// manifest of exact digests, sizes, rights and pins. The adapter stays internal and unregistered; no checks bundle or
// fixture ships (the bundle is acquired by the owner, separately, and never bundled).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

export async function stageAssets(pkgDir, outDir) {
  const { TRIVY_ADAPTER, TRIVY_ENGINE, TRIVY_CHECKS_BUNDLE, TRIVY_ENGINE_ARGS, TRIVY_IMAGE_PLATFORMS, TRIVY_SUPPORT, TRIVY_WORKER_BYTES, TRIVY_WORKER_DIGEST } =
    await import(pathToFileURL(join(pkgDir, 'dist', 'adapters', 'trivy', 'adapter.js')).href);
  if (sha(TRIVY_WORKER_BYTES) !== TRIVY_WORKER_DIGEST) throw new Error('the built Trivy worker does not match its digest');
  mkdirSync(join(outDir, 'assets', 'trivy'), { recursive: true });
  writeFileSync(join(outDir, 'assets', 'trivy', 'worker.sh'), TRIVY_WORKER_BYTES);
  const manifest = {
    schema: 'sentinel-trivy-assets/draft-1',
    adapter: { id: TRIVY_ADAPTER.id, version: TRIVY_ADAPTER.version, image: TRIVY_ADAPTER.image, command: [...TRIVY_ADAPTER.command], engine: { ...TRIVY_ENGINE }, engineArgs: [...TRIVY_ENGINE_ARGS], platforms: JSON.parse(JSON.stringify(TRIVY_IMAGE_PLATFORMS)) },
    checks: { ...TRIVY_CHECKS_BUNDLE, shipped: false },
    worker: { path: 'assets/trivy/worker.sh', digest: TRIVY_WORKER_DIGEST, size: TRIVY_WORKER_BYTES.length, rights: { spdx: 'MIT', origin: 'sentinel-original' } },
    support: JSON.parse(JSON.stringify(TRIVY_SUPPORT)),
    registered: false,
  };
  writeFileSync(join(outDir, 'assets', 'trivy', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { files: ['assets'], exports: { './assets/*': './assets/*' } };
}
