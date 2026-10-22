// The Gitleaks adapter (PR 11): Gitleaks 8.30.1 at its official image digest, behind the original shell shim, run only
// through PR 07's isolated execution service. Holds the pins, the fixed configuration and report template, and the
// support statement; job.ts builds an attempt's inputs, normalize.ts reads its outputs, run.ts joins them.
import { createHash } from 'node:crypto';
import type { ExternalAdapterDefinition } from '../../execution/registry.js';
import { GITLEAKS_DEFAULT_CONFIG_SHA256 } from './rules.js';
import { GITLEAKS_WORKER_SOURCE } from './worker-source.js';

/** The official release (github.com/gitleaks/gitleaks, v8.30.1, published 2026-03-21, MIT). */
export const GITLEAKS_ENGINE = Object.freeze({
  name: 'gitleaks',
  version: '8.30.1',
  commit: '83d9cd684c87d95d656c1458ef04895a7f1cbd8e',
  /** The official multi-platform image index (ghcr.io/gitleaks/gitleaks:v8.30.1), installed ahead, never pulled at scan time. */
  image: 'ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f',
  license: 'MIT',
  /** The default rules the binary embeds (config/gitleaks.toml at the tag); rules.ts is generated from it. */
  defaultConfig: GITLEAKS_DEFAULT_CONFIG_SHA256,
});

/** Platforms of the pinned index. Only a measured one's results are trusted. */
export const GITLEAKS_IMAGE_PLATFORMS = Object.freeze([
  Object.freeze({ platform: 'linux/arm64', architecture: 'arm64', state: 'measured' as const,
    manifest: 'sha256:6b2d52241f9d176fc59e6e3b026ea52c98f390070587d9475d6ee2bc64941815',
    evidence: 'darwin-arm64 host, Docker Desktop with Engine 29.2.1; Gitleaks conformance 2026-10-22' }),
  Object.freeze({ platform: 'linux/amd64', architecture: 'amd64', state: 'measured' as const,
    manifest: 'sha256:b109bc5f8f76a38196a3e413704fc5b9e3c32360bce4e4b603bd6f45b3721dbb',
    evidence: 'native Ubuntu 24.04.5 x64, Node 24.22.0; CI 39801723971 isolation/conformance 93 passed, zero skipped, 2026-10-22' }),
]);
export const GITLEAKS_MEASURED_ARCHITECTURES: ReadonlySet<string> = new Set(GITLEAKS_IMAGE_PLATFORMS.filter(p => p.state === 'measured').map(p => p.architecture));

/** The pinned configuration: the release's built-in rules, nothing added, nothing allowed. A repository's is never read. */
export const GITLEAKS_CONFIG = 'title = "sentinel-gitleaks-pinned"\n\n[extend]\nuseDefault = true\n';
/** The report template: rule, first and last line, file. Never the match, the secret or the line text. */
export const GITLEAKS_REPORT_TEMPLATE = '{{range .}}F\t{{.RuleID}}\t{{.StartLine}}\t{{.EndLine}}\t{{.File}}\n{{end}}';
/** Files above this are not sent; each is a skipped scope. Gitleaks' own limit is one MiB above it. */
export const GITLEAKS_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** The rendered report is held to this many bytes; more fails the scan rather than cutting it short. */
export const GITLEAKS_MAX_REPORT_BYTES = 3_145_728;
/** The worker's own bound on the engine run, inside the supervisor's deadline. */
export const GITLEAKS_ENGINE_TIMEOUT_SECONDS = 100;

export interface GitleaksAdapterBuild {
  readonly definition: ExternalAdapterDefinition;
  readonly workerBytes: Buffer;
  readonly workerDigest: string;
  /** The configuration and template the shim writes, for the audit. */
  readonly configDigest: string;
  readonly templateDigest: string;
}

const sha = (b: string | Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/**
 * Builds the adapter around the shim. A test variant (other id, extra engine arguments, template, report bound) gets
 * its own digests, so it can never pass for the production adapter.
 */
export function buildGitleaksAdapter(options: { id?: string; engineArgs?: readonly string[]; template?: string; maxReportBytes?: number } = {}): GitleaksAdapterBuild {
  const args = options.engineArgs ?? [];
  for (const a of args) if (!/^[A-Za-z0-9=.,_-]+$/.test(a)) throw new Error('sentinel.secrets: engine arguments are fixed plain tokens');
  const template = options.template ?? GITLEAKS_REPORT_TEMPLATE;
  for (const text of [GITLEAKS_CONFIG, template]) if (text.includes("'")) throw new Error('sentinel.secrets: embedded text cannot hold a quote');
  const maxReport = options.maxReportBytes ?? GITLEAKS_MAX_REPORT_BYTES;
  const workerBytes = Buffer.from(GITLEAKS_WORKER_SOURCE
    .replace('[MAX_REPORT]', () => String(maxReport)).replace('[SECS]', () => String(GITLEAKS_ENGINE_TIMEOUT_SECONDS))
    .replace('[MAX_MB]', () => String(GITLEAKS_MAX_FILE_BYTES / (1024 * 1024) + 1)).replace('[ENGINE_ARGS]', () => args.join(' '))
    .replace('[CONFIG]', () => GITLEAKS_CONFIG).replace('[TEMPLATE]', () => template), 'utf8');
  const workerDigest = sha(workerBytes);
  const definition = Object.freeze({
    id: options.id ?? 'secrets-gitleaks', version: GITLEAKS_ENGINE.version, kind: 'external', isolation: 'container', image: GITLEAKS_ENGINE.image,
    command: Object.freeze(['/bin/sh', `/input/${workerDigest.slice('sha256:'.length)}`]),
  }) as ExternalAdapterDefinition;
  return Object.freeze({ definition, workerBytes, workerDigest, configDigest: sha(GITLEAKS_CONFIG), templateDigest: sha(template) });
}

const PRODUCTION = buildGitleaksAdapter();
export const GITLEAKS_WORKER_BYTES = PRODUCTION.workerBytes;
export const GITLEAKS_WORKER_DIGEST = PRODUCTION.workerDigest;
export const GITLEAKS_CONFIG_DIGEST = PRODUCTION.configDigest;
/** The trusted registry definition; not registered in the production registry until integration. */
export const GITLEAKS_ADAPTER: ExternalAdapterDefinition = PRODUCTION.definition;
export const GITLEAKS_PRODUCTION_BUILD: GitleaksAdapterBuild = PRODUCTION;

/** What the adapter supports, and no more. */
export const GITLEAKS_SUPPORT = Object.freeze({
  adapter: GITLEAKS_ADAPTER.id,
  engine: `${GITLEAKS_ENGINE.name} ${GITLEAKS_ENGINE.version}`,
  mode: 'current-tree' as const,
  rules: 'the release default rules only',
  platforms: GITLEAKS_IMAGE_PLATFORMS,
  granularity: 'per-file' as const,
  location: 'whole lines' as const,
  /** The secret value is never kept; a finding cites the detector and the lines. */
  values: 'withheld' as const,
  /** Git history is not scanned by this adapter. */
  history: 'not-scanned' as const,
});
