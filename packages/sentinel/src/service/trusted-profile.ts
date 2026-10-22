// The command line's trusted execution profile: the narrow adapter registry this build ships and what Sentinel's own
// code says it establishes. The registry holds the coordinator's own bootstrap operations (capture, parse, inventory)
// and one check adapter, the built-in foundation-preview detector, which establishes source bytes, pattern match and
// source spans on the evidence of the original pack's fixtures, per file and rule. Nothing else: every scanner,
// framework or model capability stays unavailable, and a rule that needs one is planned unsupported, never run.
//
// The profile is kept as the coordinator's canonical execution profile record (execution/profile.ts), which a plan
// admission stores and the coordinator checks against this registry before anything runs.
import { createHash } from 'node:crypto';
import type { Digest } from '../contracts/common.js';
import type { PlanStage } from '../contracts/plan.js';
import type { ResourcePolicy } from '../contracts/work.js';
import { createCapabilityTable, type CapabilityFact, type PlannerProfile } from '../planner/index.js';
import { createAdapterRegistry, type AdapterRegistry } from '../execution/registry.js';
import { executionProfileRecord, EXECUTION_PROFILE_SCHEMA, type ExecutionProfileRecord } from '../execution/profile.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { PREVIEW_DETECTOR_ID } from '../adapters/preview-detector.js';
import { ownExecutable } from './package-paths.js';

export { EXECUTION_PROFILE_SCHEMA };
export const FOUNDATION_PROFILE_ID = 'foundation-preview';
export const OPERATIONS = Object.freeze({ capture: 'sentinel-capture', parse: 'sentinel-parse', inventory: 'sentinel-inventory' });

export interface TrustedProfile {
  readonly planner: PlannerProfile;
  readonly registry: AdapterRegistry;
  readonly record: ExecutionProfileRecord;
  /** The record's canonical digest. */
  readonly digest: Digest;
}

const EVIDENCE = 'foundation preview: the original rule pack rules/foundation-preview, held to its positive and negative fixtures';

/** What the built-in preview detector establishes, on that evidence. Nothing more. */
const FACTS: readonly CapabilityFact[] = Object.freeze([
  { capability: 'source-bytes', adapterId: PREVIEW_DETECTOR_ID, evidence: EVIDENCE },
  { capability: 'pattern-match', adapterId: PREVIEW_DETECTOR_ID, evidence: EVIDENCE },
  { capability: 'source-span', adapterId: PREVIEW_DETECTOR_ID, evidence: EVIDENCE },
]);

const LIMITS: ResourcePolicy = Object.freeze({ deadlineMs: 120_000, memoryBytes: 2_147_483_648, cpuQuota: 2, maxPids: 128, maxOutputBytes: 4_194_304 });
export const RESOURCES: Readonly<Record<PlanStage, ResourcePolicy>> = Object.freeze({ capture: LIMITS, parse: LIMITS, inventory: LIMITS, check: LIMITS });
/** The parse operation's selection and limits: part of the profile, because they decide what parsing publishes. */
export const PARSE: ExecutionProfileRecord['parse'] = Object.freeze({
  selection: { gitignore: true, testFiles: 'include' as const },
  limits: { maxFiles: 20_000, maxFileBytes: 1_048_576, maxTotalBytes: 268_435_456, maxEntries: 200_000, maxDurationMs: 120_000 },
}) as ExecutionProfileRecord['parse'];

let cached: AdapterRegistry | undefined;
/** The shipped registry: the bootstrap operations and the preview detector, run as this package's own executable. */
export function foundationRegistry(): AdapterRegistry {
  cached ??= createAdapterRegistry([
    { id: PREVIEW_DETECTOR_ID, version: 'preview-1', kind: 'built-in', isolation: 'child', module: ownExecutable(), coverage: 'per-file-per-rule' },
    { id: OPERATIONS.capture, version: '1', kind: 'operation', operation: 'capture' },
    { id: OPERATIONS.parse, version: '1', kind: 'operation', operation: 'parse' },
    { id: OPERATIONS.inventory, version: '1', kind: 'operation', operation: 'inventory' },
  ]);
  return cached;
}

export const profileDigest = (record: ExecutionProfileRecord): Digest =>
  `sha256:${createHash('sha256').update(canonicalJsonBytes(record)).digest('hex')}`;

/** The foundation-preview profile over a registry (the shipped one by default; a test passes its own). */
export function foundationProfile(registry: AdapterRegistry = foundationRegistry(), options: { operations?: boolean } = {}): TrustedProfile {
  const planner: PlannerProfile = Object.freeze({
    id: FOUNDATION_PROFILE_ID, registry, capabilities: createCapabilityTable(registry, FACTS), permits: Object.freeze(FACTS.map(f => f.capability)),
    ...(options.operations === false ? {} : { operations: OPERATIONS }),
  });
  const record = executionProfileRecord(planner, structuredClone(RESOURCES) as Record<PlanStage, ResourcePolicy>, structuredClone(PARSE));
  return Object.freeze({ planner, registry, record, digest: profileDigest(record) });
}
