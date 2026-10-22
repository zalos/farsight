// The Trivy misconfiguration adapter: Trivy 0.76.1 at its official image digest, `trivy config` only (no dependency,
// secret or license scanning, so nothing duplicates the OSV adapter), with the pinned trivy-checks 2.3.0 bundle and
// nothing else, behind an original shell shim, run only through PR 07's isolated execution service. Holds the pins and
// the support statement; job.ts builds an attempt's inputs, normalize.ts reads its outputs, bundle.ts is the separate,
// owner-confirmed checks-bundle download.
import { createHash } from 'node:crypto';
import type { ExternalAdapterDefinition } from '../../execution/registry.js';
import { TRIVY_WORKER_SOURCE } from './worker-source.js';

/**
 * The official release (github.com/aquasecurity/trivy, v0.76.1, published 2026-10-21, tag commit e713f67). The image
 * index's `org.opencontainers.image.revision` and `.version` labels name the same commit and version.
 */
export const TRIVY_ENGINE = Object.freeze({
  name: 'trivy',
  version: '0.76.1',
  commit: 'e713f67f7d54decdcd9b3132c9751833dcced698',
  /** The official multi-platform image index, installed ahead and never pulled at scan time. */
  image: 'ghcr.io/aquasecurity/trivy@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c',
  license: 'Apache-2.0',
});

/**
 * The checks bundle the engine evaluates (github.com/aquasecurity/trivy-checks, v2.3.0, published 2026-10-14, tag
 * commit 6ceb337): the OCI manifest the release published and its one `bundle.tar.gz` layer. The manifest's
 * `org.opencontainers.image.revision` names the tag commit. Only this bundle is accepted; the copy embedded in the
 * binary is never used for a result (see the worker).
 */
export const TRIVY_CHECKS_BUNDLE = Object.freeze({
  name: 'trivy-checks',
  version: '2.3.0',
  commit: '6ceb33758a0f28d6e37e6cd571dc6816beeadbcc',
  repository: 'ghcr.io/aquasecurity/trivy-checks',
  manifest: 'sha256:3eae4436560566e77115396d0221a64e0cd86d94a3b45203f8ae3f9a85c027cd',
  layer: 'sha256:4bf8ba41d342b378e63707561806d7784373ddd6cc04fdaf085ec7f38a19ec9d',
  size: 240_203,
  created: '2026-10-14T08:54:43Z',
  license: 'MIT',
});

/** Platforms of the pinned index. Only a measured one's results are trusted. */
export const TRIVY_IMAGE_PLATFORMS = Object.freeze([
  Object.freeze({ platform: 'linux/arm64', architecture: 'arm64', state: 'measured' as const,
    manifest: 'sha256:fc223b6f033406fd0c5efe59b566295e90cff76ccd2af696bd0d66d53ad83a2d',
    evidence: 'darwin-arm64 host, Docker Desktop with Engine 29.2.1; Trivy conformance 2026-10-22' }),
  Object.freeze({ platform: 'linux/amd64', architecture: 'amd64', state: 'measured' as 'measured' | 'unmeasured',
    manifest: 'sha256:2e6c00d711ab4ae41d8a30c2c1fd3bd3b62704c177bb120f95012e939edfb3df',
    evidence: 'native Ubuntu 24.04.5 x86_64, Docker Engine 28.0.4 linux/amd64; 2026-10-22; https://github.com/zalos/farsight/actions/runs/39817213827/job/119958735627; tested merge 0d6daa8cd369835fe6ec8ec5a89b4d25cb23edc5' }),
]);
export const TRIVY_MEASURED_ARCHITECTURES: ReadonlySet<string> = new Set(TRIVY_IMAGE_PLATFORMS.filter(p => p.state === 'measured').map(p => p.architecture));

/** The configuration scanners selected; every other kind Trivy reads is out of scope and said so. */
export const TRIVY_MISCONFIG_SCANNERS = Object.freeze(['dockerfile', 'kubernetes', 'terraform'] as const);
export type TrivyConfigType = typeof TRIVY_MISCONFIG_SCANNERS[number];

/**
 * The fixed engine arguments, before the scanned folder: configuration scanning only, the cached bundle and no update,
 * no telemetry or version check, JSON, the selected scanners, and no repository ignore file (`--ignorefile=` disables
 * `.trivyignore`). Debug logging is what tells the worker which bundle loaded and which files were scanned; the log
 * itself never leaves the container.
 */
export const TRIVY_ENGINE_ARGS: readonly string[] = Object.freeze([
  'config', '--skip-check-update', '--disable-telemetry', '--skip-version-check', '--format', 'json',
  `--misconfig-scanners=${TRIVY_MISCONFIG_SCANNERS.join(',')}`, '--ignorefile=', '--exit-code', '0', '--debug',
]);
/** The engine's JSON is held to this many bytes; more is a truncated run that counts nothing. */
export const TRIVY_MAX_OUTPUT_BYTES = 8_388_608;
/** The worker's own bound on the engine run, inside the supervisor's deadline. */
export const TRIVY_ENGINE_TIMEOUT_SECONDS = 100;

export interface TrivyAdapterBuild {
  readonly definition: ExternalAdapterDefinition;
  readonly workerBytes: Buffer;
  readonly workerDigest: string;
}

/** Builds the adapter around the shim; a test variant (other id or arguments) gets its own digests. */
export function buildTrivyAdapter(options: { id?: string; engineArgs?: readonly string[]; maxOutputBytes?: number } = {}): TrivyAdapterBuild {
  const args = options.engineArgs ?? TRIVY_ENGINE_ARGS;
  if (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 0 || options.maxOutputBytes > TRIVY_MAX_OUTPUT_BYTES)) throw new Error('sentinel.trivy: the output bound is an integer up to the default');
  for (const a of args) if (!/^[A-Za-z0-9=.,_/-]+$/.test(a)) throw new Error('sentinel.trivy: engine arguments are fixed plain tokens');
  const workerBytes = Buffer.from(TRIVY_WORKER_SOURCE
    .replace('[MAX_OUT]', String(options.maxOutputBytes ?? TRIVY_MAX_OUTPUT_BYTES))
    .replace('[ENGINE_ARGS]', args.join(' '))
    .replace('[BUNDLE_LAYER]', TRIVY_CHECKS_BUNDLE.layer), 'utf8');
  const workerDigest = `sha256:${createHash('sha256').update(workerBytes).digest('hex')}`;
  const definition = Object.freeze({
    id: options.id ?? 'iac-trivy', version: TRIVY_ENGINE.version, kind: 'external', isolation: 'container', image: TRIVY_ENGINE.image,
    command: Object.freeze(['/bin/sh', `/input/${workerDigest.slice('sha256:'.length)}`]),
  }) as ExternalAdapterDefinition;
  return Object.freeze({ definition, workerBytes, workerDigest });
}

const PRODUCTION = buildTrivyAdapter();
export const TRIVY_WORKER_BYTES = PRODUCTION.workerBytes;
export const TRIVY_WORKER_DIGEST = PRODUCTION.workerDigest;
/** The trusted registry definition; not registered in the production registry until integration. */
export const TRIVY_ADAPTER: ExternalAdapterDefinition = PRODUCTION.definition;

/** What the adapter supports, and no more. */
export const TRIVY_SUPPORT = Object.freeze({
  adapter: TRIVY_ADAPTER.id,
  engine: `${TRIVY_ENGINE.name} ${TRIVY_ENGINE.version}`,
  checks: `${TRIVY_CHECKS_BUNDLE.name} ${TRIVY_CHECKS_BUNDLE.version}`,
  mode: 'misconfiguration-only' as const,
  platforms: TRIVY_IMAGE_PLATFORMS,
  inputs: Object.freeze({
    dockerfile: 'Dockerfile or Containerfile, with or without an extension, or a .dockerfile / .containerfile extension',
    kubernetes: '.yaml / .yml files the engine recognizes as Kubernetes manifests; any other YAML is not applicable',
    terraform: '.tf and .tf.json, evaluated per folder as a module; local modules only (remote modules are never fetched)',
  }),
  notSupported: Object.freeze([
    'Helm charts, CloudFormation, Azure ARM, Ansible, Terraform plans, Kubernetes JSON',
    'dependency, secret and license scanning (OSV and the secrets adapter own those)',
    'repository ignore files; custom checks; checks other than the pinned bundle',
  ]),
  /** Inline `trivy:` and `tfsec:` ignore comments are honoured by the engine and cannot be turned off: a file holding one is partial. */
  inlineIgnores: 'honoured-and-reported' as const,
  granularity: 'per-file' as const,
  /** Findings are configuration facts at a captured path and lines; no graph node is created for them. */
  graph: 'paths-only' as const,
});
