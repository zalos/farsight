// The OSV adapter: OSV-Scanner 2.7.0 at its official image digest, in full offline mode, behind the original shell
// shim, run only through PR 07's isolated execution service. Holds the pins and the support statement; job.ts builds
// an attempt's inputs, normalize.ts reads its outputs, acquire.ts is the separate, owner-confirmed database download.
import { createHash } from 'node:crypto';
import type { ExternalAdapterDefinition } from '../../execution/registry.js';
import { OSV_WORKER_SOURCE } from './worker-source.js';

/** The official release (github.com/google/osv-scanner, v2.7.0, published 2026-10-12, commit bfe2f84). */
export const OSV_ENGINE = Object.freeze({
  name: 'osv-scanner',
  version: '2.7.0',
  commit: 'bfe2f84abd2f09fe0b83ba7f6dad40d296762f40',
  scalibr: '0.5.3',
  /** The official multi-platform image index, installed ahead and never pulled at scan time. */
  image: 'ghcr.io/google/osv-scanner@sha256:4f3b7e2c64b9d38a5febc5a7e4a3dfef1d1362f726dea7a2ef4762b46469fcd0',
  license: 'Apache-2.0',
});

/** Platforms of the pinned index. Only a measured one's results are trusted. */
export const OSV_IMAGE_PLATFORMS = Object.freeze([
  Object.freeze({ platform: 'linux/arm64', architecture: 'arm64', state: 'measured' as const,
    manifest: 'sha256:de2dcd79d417411e488fc6f2b37060685f33f1fcadf1a9282fae7322ec4c3a49',
    evidence: 'darwin-arm64 host, Docker Desktop 4.65.0 with Engine 29.2.1; OSV conformance 2026-10-22' }),
  Object.freeze({ platform: 'linux/amd64', architecture: 'amd64', state: 'measured' as const,
    manifest: 'sha256:d2c46aa2483c4e02759bc25f2224d28a5ceeb3dca5a1ecd1f569fbed83a626f0',
    evidence: 'native Ubuntu 24.04.5 x64, Docker 28.0.4, Node 24.22.0; 21 conformance tests, zero skips and installed worker one finding; https://github.com/zalos/farsight/actions/runs/39788785215' }),
]);
export const OSV_MEASURED_ARCHITECTURES: ReadonlySet<string> = new Set(OSV_IMAGE_PLATFORMS.filter(p => p.state === 'measured').map(p => p.architecture));

/**
 * The fixed engine arguments, before the `-L <file>` list: source scan, full offline mode (no network, no transitive
 * resolution, local databases only), JSON with every package listed so unmatched and unversioned components are
 * visible, and info verbosity so stderr carries the engine's "Loaded <ecosystem> local db" lines, the only evidence
 * that a database was actually read (stderr itself never leaves the container).
 */
export const OSV_ENGINE_ARGS: readonly string[] = Object.freeze(['scan', 'source', '--offline', '--format', 'json', '--all-packages', '--verbosity', 'info']);
/** The engine's JSON is held to this many bytes; more is a truncated run that counts nothing. */
export const OSV_MAX_OUTPUT_BYTES = 3_145_728;
/** The worker's own bound on the engine run, inside the supervisor's deadline. */
export const OSV_ENGINE_TIMEOUT_SECONDS = 100;

export interface OsvAdapterBuild {
  readonly definition: ExternalAdapterDefinition;
  readonly workerBytes: Buffer;
  readonly workerDigest: string;
}

/** Builds the adapter around the shim; a test variant (other id or arguments) gets its own digests. */
export function buildOsvAdapter(options: { id?: string; engineArgs?: readonly string[] } = {}): OsvAdapterBuild {
  const args = options.engineArgs ?? OSV_ENGINE_ARGS;
  for (const a of args) if (!/^[A-Za-z0-9=.,_-]+$/.test(a)) throw new Error('sentinel.osv: engine arguments are fixed plain tokens');
  const workerBytes = Buffer.from(OSV_WORKER_SOURCE.replace('[MAX_OUT]', String(OSV_MAX_OUTPUT_BYTES)).replace('[ENGINE_ARGS]', args.join(' ')), 'utf8');
  const workerDigest = `sha256:${createHash('sha256').update(workerBytes).digest('hex')}`;
  const definition = Object.freeze({
    id: options.id ?? 'advisories-osv', version: OSV_ENGINE.version, kind: 'external', isolation: 'container', image: OSV_ENGINE.image,
    command: Object.freeze(['/bin/sh', `/input/${workerDigest.slice('sha256:'.length)}`]),
  }) as ExternalAdapterDefinition;
  return Object.freeze({ definition, workerBytes, workerDigest });
}

const PRODUCTION = buildOsvAdapter();
export const OSV_WORKER_BYTES = PRODUCTION.workerBytes;
export const OSV_WORKER_DIGEST = PRODUCTION.workerDigest;
/** The trusted registry definition; not registered in the production registry until integration. */
export const OSV_ADAPTER: ExternalAdapterDefinition = PRODUCTION.definition;

/** What the adapter supports, and no more. */
export const OSV_SUPPORT = Object.freeze({
  adapter: OSV_ADAPTER.id,
  engine: `${OSV_ENGINE.name} ${OSV_ENGINE.version}`,
  mode: 'full-offline' as const,
  platforms: OSV_IMAGE_PLATFORMS,
  ecosystems: Object.freeze(['npm', 'Maven'] as const),
  inputs: Object.freeze({
    'package-lock.json': 'npm lockfile: resolved versions, transitive closure as locked',
    'pnpm-lock.yaml': 'npm (pnpm) lockfile: resolved versions, transitive closure as locked',
    'pom.xml': 'Maven manifest: declared direct dependencies only; transitives not resolved offline; ranges and managed versions unknown',
    '*.cdx.json': 'CycloneDX SBOM: components as the SBOM producer listed them',
  }),
  granularity: 'per-file' as const,
  /** Package advisories are matched by identity and version; reachability of vulnerable code is never claimed. */
  reachability: 'not-assessed' as const,
});
