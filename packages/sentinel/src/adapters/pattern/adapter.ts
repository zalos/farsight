// The pattern adapter: Semgrep 1.181.0 at its measured image digest, behind the original protocol shim, run only
// through PR 07's isolated execution service. This module holds the pins and the support statement; job.ts builds an
// attempt's inputs, normalize.ts reads its outputs. Nothing here starts a process.
import { sha256Id } from '../../kernel/digest.js';
import type { ExternalAdapterDefinition } from '../../execution/registry.js';
import { PATTERN_WORKER_SOURCE } from './worker-source.js';

/** The engine the feasibility decision selected (feasibility-decisions.json engine.recommendedPatternDefault). */
export const PATTERN_ENGINE = Object.freeze({
  name: 'semgrep',
  version: '1.181.0',
  /** Installed ahead of time and never pulled; the reference is the measured digest, linux/arm64 observed. */
  image: 'semgrep/semgrep@sha256:81474464c1f07483ba0682a44787fd93c91397419762a04abe2bafaae396304b',
  python: '/usr/bin/python3',
  executable: '/usr/bin/semgrep',
});

/**
 * The fixed engine arguments, after `semgrep` and before `--config <rules> <tree>`. The measured invocation
 * (--json --verbose --dataflow-traces --metrics=off --disable-version-check --jobs 1 --timeout 20) plus five
 * controls: in-source `nosemgrep` comments cannot hide a result, ignore files cannot drop a target, rule ids are not
 * rewritten with the config path, only the open-source engine runs, and `--time` reports each rule's match time on
 * each file, which is the only evidence that a rule actually ran on a file. The target size bound is the engine
 * default.
 */
export const ENGINE_ARGS: readonly string[] = Object.freeze([
  '--json',
  '--verbose',
  '--dataflow-traces',
  '--metrics=off',
  '--disable-version-check',
  '--jobs',
  '1',
  '--timeout',
  '20',
  '--max-target-bytes',
  '1000000',
  '--disable-nosem',
  '--no-git-ignore',
  '--no-rewrite-rule-ids',
  '--oss-only',
  '--time',
]);
/**
 * The pinned reference is a multi-platform OCI index. Only the platform measured in conformance counts; another
 * platform's results are refused by the normalizer until it is measured on a native host. Nothing here acquires an image.
 */
export const PATTERN_IMAGE_PLATFORMS = Object.freeze([
  Object.freeze({
    platform: 'linux/arm64',
    architecture: 'arm64',
    state: 'measured' as const,
    manifest: 'sha256:db0579f992f6597840f96b249119f4999d44ffbc9e3f0a8854c367183e474c24',
    evidence:
      'darwin-arm64 host, Docker Desktop 4.65.0 with Engine 29.2.1, Linux 6.12 aarch64 server; pattern conformance 2026-10-22',
  }),
  Object.freeze({
    platform: 'linux/amd64',
    architecture: 'amd64',
    state: 'measured' as const,
    manifest: 'sha256:c47e426f7f0cfa19af6d7877560d0a7135f683b8090ad0efc97c4ec7810dc435',
    evidence:
      'native Ubuntu 24.04.5 x64, Docker 28.0.4, Node 24.21.0; 22 conformance tests, zero skips and installed worker six findings; https://github.com/zalos/farsight/actions/runs/39790599932',
  }),
]);
/** The architectures the pinned engine image was measured on; any other is unqualified. */
export const MEASURED_ARCHITECTURES: ReadonlySet<string> = new Set(
  PATTERN_IMAGE_PLATFORMS.filter((p) => p.state === 'measured').map((p) => p.architecture),
);

/** Files over this size are skipped by the engine (reported, never silently dropped). */
export const MAX_TARGET_BYTES = 1_000_000;
/** The worker's own bound on the engine run, inside the supervisor's deadline. */
export const ENGINE_TIMEOUT_SECONDS = 100;

/** A pattern adapter: its registry definition and the shim bytes its command names by digest. */
export interface PatternAdapterBuild {
  readonly definition: ExternalAdapterDefinition;
  readonly workerBytes: Buffer;
  readonly workerDigest: string;
  readonly engineArgs: readonly string[];
}

/**
 * Builds an adapter around the shim with these engine arguments. Production uses ENGINE_ARGS only; a test variant
 * gets its own shim digest and therefore its own adapter digest, so it can never pass for the qualified adapter.
 */
export function buildPatternAdapter(
  options: { id?: string; engineArgs?: readonly string[] } = {},
): PatternAdapterBuild {
  const engineArgs = Object.freeze([...(options.engineArgs ?? ENGINE_ARGS)]);
  const workerBytes = Buffer.from(
    PATTERN_WORKER_SOURCE.replace('[ENGINE_ARGS_JSON]', JSON.stringify(engineArgs)),
    'utf8',
  );
  const workerDigest = sha256Id(workerBytes);
  const definition = Object.freeze({
    id: options.id ?? 'pattern-semgrep',
    version: PATTERN_ENGINE.version,
    kind: 'external',
    isolation: 'container',
    image: PATTERN_ENGINE.image,
    command: Object.freeze([PATTERN_ENGINE.python, '-I', '-S', '-B', `/input/${workerDigest.slice('sha256:'.length)}`]),
  }) as ExternalAdapterDefinition;
  return Object.freeze({ definition, workerBytes, workerDigest, engineArgs });
}

const PRODUCTION = buildPatternAdapter();
/** The shim's bytes, as supplied to the attempt as an input artifact. */
export const PATTERN_WORKER_BYTES: Buffer = PRODUCTION.workerBytes;
/** The shim's content address; the registry definition's fixed command names it. */
export const PATTERN_WORKER_DIGEST = PRODUCTION.workerDigest;

/**
 * The trusted registry definition. Its fixed command names the shim by digest, so the adapter digest covers the
 * shim, the engine arguments and the image. The scheduler supplies the shim among the inputs.
 */
export const PATTERN_ADAPTER: ExternalAdapterDefinition = PRODUCTION.definition;

/**
 * What this adapter supports, and no more. Measured scope: the feasibility micro-corpus and this package's original
 * conformance fixtures; it is not a general accuracy claim.
 */
export const PATTERN_SUPPORT = Object.freeze({
  adapter: PATTERN_ADAPTER.id,
  engine: `${PATTERN_ENGINE.name} ${PATTERN_ENGINE.version}`,
  platforms: PATTERN_IMAGE_PLATFORMS,
  languages: Object.freeze(['typescript', 'javascript', 'java'] as const),
  /**
   * Per file per rule, from the engine's reported match times: a rule counts as run on a file only when the engine
   * reports a non-zero match time for it (a rule its file prefilter skipped reports zero and is not counted).
   */
  granularity: 'per-file-per-rule' as const,
  capabilities: Object.freeze({
    /** A syntactic locator: a candidate location to review, never proof of attacker control. */
    'structural-locator': 'qualified-original-direct-cases',
    /** Source and sink in one function of one file, with the engine's trace re-checked against captured bytes. */
    'local-taint': 'qualified-original-direct-local-cases',
    /** Zero of three cross-file positives in feasibility: never claimed. */
    'cross-file-taint': 'unsupported',
    'interprocedural-flow': 'unsupported',
  }),
  limitations: Object.freeze([
    'sentinel.pattern.limitation.locatorNotProof',
    'sentinel.pattern.limitation.localTaintOnly',
    'sentinel.pattern.limitation.ruleRunFromMatchTime',
  ]),
});
