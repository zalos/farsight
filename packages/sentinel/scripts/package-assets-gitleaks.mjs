// The Gitleaks adapter's non-code package assets, staged by scripts/pack-sentinel.mjs: its in-container worker and a
// manifest of exact digests, sizes, rights and pins. The adapter stays internal and unregistered; no image, binary,
// scan report or fixture ships (the pinned official image is installed by the owner, separately).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

export async function stageAssets(pkgDir, outDir) {
  const g = await import(pathToFileURL(join(pkgDir, 'dist', 'adapters', 'gitleaks', 'index.js')).href);
  if (sha(g.GITLEAKS_WORKER_BYTES) !== g.GITLEAKS_WORKER_DIGEST) throw new Error('the built Gitleaks worker does not match its digest');
  if (g.GITLEAKS_ADAPTER.command.at(-1) !== `/input/${g.GITLEAKS_WORKER_DIGEST.slice(7)}`) throw new Error('the Gitleaks command does not name its worker');
  mkdirSync(join(outDir, 'assets', 'gitleaks'), { recursive: true });
  writeFileSync(join(outDir, 'assets', 'gitleaks', 'worker.sh'), g.GITLEAKS_WORKER_BYTES);
  const manifest = {
    schema: 'sentinel-gitleaks-assets/draft-1',
    adapter: { id: g.GITLEAKS_ADAPTER.id, version: g.GITLEAKS_ADAPTER.version, image: g.GITLEAKS_ADAPTER.image, command: [...g.GITLEAKS_ADAPTER.command],
      engine: { ...g.GITLEAKS_ENGINE }, platforms: JSON.parse(JSON.stringify(g.GITLEAKS_IMAGE_PLATFORMS)) },
    worker: { path: 'assets/gitleaks/worker.sh', digest: g.GITLEAKS_WORKER_DIGEST, size: g.GITLEAKS_WORKER_BYTES.length, rights: { spdx: 'MIT', origin: 'sentinel-original' } },
    config: { digest: g.GITLEAKS_CONFIG_DIGEST, defaultRules: g.GITLEAKS_DEFAULT_CONFIG_SHA256, ruleCount: g.GITLEAKS_RULE_IDS.size },
    support: JSON.parse(JSON.stringify(g.GITLEAKS_SUPPORT)),
    image: 'installed separately by the owner, by digest; never bundled or pulled at scan time',
    registered: true,
  };
  writeFileSync(join(outDir, 'assets', 'gitleaks', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { files: ['assets'], exports: { './assets/*': './assets/*' } };
}
