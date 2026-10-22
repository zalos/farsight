// The pattern adapter: Semgrep 1.181.0 at its measured image digest, behind the original protocol shim, run only
// through PR 07's isolated execution service. This module holds the pins and the support statement; job.ts builds an
// attempt's inputs, normalize.ts reads its outputs. Nothing here starts a process.
import { createHash } from 'node:crypto';
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
 * (--json --verbose --dataflow-traces --metrics=off --disable-version-check --jobs 1 --timeout 20) plus four
 * controls: in-source `nosemgrep` comments cannot hide a result, ignore files cannot drop a target, rule ids are not
 * rewritten with the config path, and only the open-source engine runs. The target size bound is the engine default.
 */
export const ENGINE_ARGS: readonly string[] = Object.freeze([
  '--json', '--verbose', '--dataflow-traces', '--metrics=off', '--disable-version-check', '--jobs', '1', '--timeout', '20',
  '--max-target-bytes', '1000000', '--disable-nosem', '--no-git-ignore', '--no-rewrite-rule-ids', '--oss-only',
]);
/** Files over this size are skipped by the engine (reported, never silently dropped). */
export const MAX_TARGET_BYTES = 1_000_000;
/** The worker's own bound on the engine run, inside the supervisor's deadline. */
export const ENGINE_TIMEOUT_SECONDS = 100;

const SHIM = PATTERN_WORKER_SOURCE.replace('[ENGINE_ARGS_JSON]', JSON.stringify(ENGINE_ARGS));
/** The shim's bytes, as supplied to the attempt as an input artifact. */
export const PATTERN_WORKER_BYTES: Buffer = Buffer.from(SHIM, 'utf8');
export const PATTERN_WORKER_DIGEST = `sha256:${createHash('sha256').update(PATTERN_WORKER_BYTES).digest('hex')}`;

/**
 * The trusted registry definition. Its fixed command names the shim by digest, so the adapter digest covers the
 * shim, the engine arguments and the image. The scheduler supplies the shim among the inputs.
 */
export const PATTERN_ADAPTER: ExternalAdapterDefinition = Object.freeze({
  id: 'pattern-semgrep',
  version: PATTERN_ENGINE.version,
  kind: 'external',
  isolation: 'container',
  image: PATTERN_ENGINE.image,
  command: Object.freeze([PATTERN_ENGINE.python, '-I', '-S', '-B', `/input/${PATTERN_WORKER_DIGEST.slice('sha256:'.length)}`]),
}) as ExternalAdapterDefinition;

/**
 * What this adapter supports, and no more. Measured scope: the feasibility micro-corpus and this package's original
 * conformance fixtures; it is not a general accuracy claim.
 */
export const PATTERN_SUPPORT = Object.freeze({
  adapter: PATTERN_ADAPTER.id,
  engine: `${PATTERN_ENGINE.name} ${PATTERN_ENGINE.version}`,
  languages: Object.freeze(['typescript', 'javascript', 'java'] as const),
  granularity: 'per-file' as const,
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
    'sentinel.pattern.limitation.perFileGranularity',
  ]),
});
