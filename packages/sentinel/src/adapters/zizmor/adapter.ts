// The zizmor adapter: zizmor 1.31.1 at its official image digest, fully offline, behind an original shell shim, run
// only through PR 07's isolated execution service. Holds the pins and the support statement; job.ts builds an
// attempt's inputs, normalize.ts reads its outputs.
import { createHash } from 'node:crypto';
import type { ExternalAdapterDefinition } from '../../execution/registry.js';
import { ZIZMOR_WORKER_SOURCE } from './worker-source.js';

/**
 * The official release (github.com/zizmorcore/zizmor, v1.31.1, published 2026-10-15, tag commit effdb35). The image
 * index's build provenance names `refs/tags/v1.31.1` at that commit, and its revision label the same commit.
 */
export const ZIZMOR_ENGINE = Object.freeze({
  name: 'zizmor',
  version: '1.31.1',
  commit: 'effdb35fa7868863f11655db256d9008922fa427',
  /** The official multi-platform image index, installed ahead and never pulled at scan time. */
  image: 'ghcr.io/zizmorcore/zizmor@sha256:42d409dbb851d4c5d35a058cf042b828bea1e3f2884378c526eb0974780e18d9',
  license: 'MIT',
});

/** Platforms of the pinned index. Only a measured one's results are trusted. */
export const ZIZMOR_IMAGE_PLATFORMS = Object.freeze([
  Object.freeze({
    platform: 'linux/arm64',
    architecture: 'arm64',
    state: 'measured' as const,
    manifest: 'sha256:15ce5a6ce0484be46752fb293617cf9c8107c309429e8fab9265eafa83404da1',
    evidence: 'darwin-arm64 host, Docker Desktop with Engine 29.2.1; zizmor conformance 2026-10-22',
  }),
  Object.freeze({
    platform: 'linux/amd64',
    architecture: 'amd64',
    state: 'measured' as 'measured' | 'unmeasured',
    manifest: 'sha256:cfc533b8fa781c51c6fb4085057945bc3eebb6b6e8a25ab7daa85c885f071269',
    evidence:
      'native Ubuntu 24.04.5 x86_64, Docker Engine 28.0.4 linux/amd64; 2026-10-22; https://github.com/zalos/farsight/actions/runs/39817213827/job/119958735627; tested merge 0d6daa8cd369835fe6ec8ec5a89b4d25cb23edc5',
  }),
]);
export const ZIZMOR_MEASURED_ARCHITECTURES: ReadonlySet<string> = new Set(
  ZIZMOR_IMAGE_PLATFORMS.filter((p) => p.state === 'measured').map((p) => p.architecture),
);

/**
 * Audits that need the GitHub API and are skipped offline, as zizmor 1.31.1 registers them (each refuses to load
 * without a client; the worker reports the engine's own "skipping" lines and the coordinator requires exactly these).
 */
export const ZIZMOR_ONLINE_AUDITS = Object.freeze([
  'impostor-commit',
  'known-vulnerable-actions',
  'ref-confusion',
  'ref-version-mismatch',
  'stale-action-refs',
] as const);
/**
 * Audits that run offline with less information: artipacked cannot resolve a commit-pinned checkout's version,
 * typosquat-uses cannot confirm a repository exists, unpinned-uses cannot resolve refs.
 */
export const ZIZMOR_OFFLINE_DEGRADED_AUDITS = Object.freeze(['artipacked', 'typosquat-uses', 'unpinned-uses'] as const);

/**
 * The fixed engine arguments, before the scanned folder: offline (no online audits, no remote inputs), no repository
 * configuration and no ignore comments (so the repository cannot suppress a finding), only workflows, composite
 * actions and Dependabot files, JSON, the regular persona, and debug logging so the worker can report which inputs
 * were collected and audited and which audits were skipped. The log itself never leaves the container.
 */
export const ZIZMOR_ENGINE_ARGS: readonly string[] = Object.freeze([
  '--offline',
  '--no-config',
  '--no-ignores',
  '--collect=workflows,actions,dependabot',
  '--format=json',
  '--no-progress',
  '--color=never',
  '--persona=regular',
  '-vv',
]);
export const ZIZMOR_MAX_OUTPUT_BYTES = 8_388_608;
export const ZIZMOR_ENGINE_TIMEOUT_SECONDS = 100;

export interface ZizmorAdapterBuild {
  readonly definition: ExternalAdapterDefinition;
  readonly workerBytes: Buffer;
  readonly workerDigest: string;
}

/** Builds the adapter around the shim; a test variant (other id or arguments) gets its own digests. */
export function buildZizmorAdapter(
  options: { id?: string; engineArgs?: readonly string[]; maxOutputBytes?: number } = {},
): ZizmorAdapterBuild {
  const args = options.engineArgs ?? ZIZMOR_ENGINE_ARGS;
  if (
    options.maxOutputBytes !== undefined &&
    (!Number.isSafeInteger(options.maxOutputBytes) ||
      options.maxOutputBytes < 0 ||
      options.maxOutputBytes > ZIZMOR_MAX_OUTPUT_BYTES)
  )
    throw new Error('sentinel.zizmor: the output bound is an integer up to the default');
  for (const a of args)
    if (!/^[A-Za-z0-9=.,_/-]+$/.test(a)) throw new Error('sentinel.zizmor: engine arguments are fixed plain tokens');
  const workerBytes = Buffer.from(
    ZIZMOR_WORKER_SOURCE.replace('[MAX_OUT]', String(options.maxOutputBytes ?? ZIZMOR_MAX_OUTPUT_BYTES)).replace(
      '[ENGINE_ARGS]',
      args.join(' '),
    ),
    'utf8',
  );
  const workerDigest = `sha256:${createHash('sha256').update(workerBytes).digest('hex')}`;
  const definition = Object.freeze({
    id: options.id ?? 'ci-zizmor',
    version: ZIZMOR_ENGINE.version,
    kind: 'external',
    isolation: 'container',
    image: ZIZMOR_ENGINE.image,
    command: Object.freeze(['/bin/sh', `/input/${workerDigest.slice('sha256:'.length)}`]),
  }) as ExternalAdapterDefinition;
  return Object.freeze({ definition, workerBytes, workerDigest });
}

const PRODUCTION = buildZizmorAdapter();
export const ZIZMOR_WORKER_BYTES = PRODUCTION.workerBytes;
export const ZIZMOR_WORKER_DIGEST = PRODUCTION.workerDigest;
/** The trusted registry definition; not registered in the production registry until integration. */
export const ZIZMOR_ADAPTER: ExternalAdapterDefinition = PRODUCTION.definition;

export const ZIZMOR_SUPPORT = Object.freeze({
  adapter: ZIZMOR_ADAPTER.id,
  engine: `${ZIZMOR_ENGINE.name} ${ZIZMOR_ENGINE.version}`,
  mode: 'offline' as const,
  persona: 'regular' as const,
  platforms: ZIZMOR_IMAGE_PLATFORMS,
  inputs: Object.freeze({
    workflow: 'GitHub Actions workflows: .yml / .yaml directly in any .github/workflows folder',
    action: 'action definitions: action.yml / action.yaml anywhere',
    dependabot: 'Dependabot configuration: .github/dependabot.yml / .yaml',
  }),
  onlineAuditsSkipped: ZIZMOR_ONLINE_AUDITS,
  offlineDegradedAudits: ZIZMOR_OFFLINE_DEGRADED_AUDITS,
  notSupported: Object.freeze([
    'pre-commit configuration',
    'remote repositories',
    'other CI systems',
    'repository zizmor configuration and ignore comments',
  ]),
  granularity: 'per-file' as const,
  graph: 'paths-only' as const,
});
