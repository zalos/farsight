// The compatibility preview profile and exact shipped rule inventory. scanner-profile.ts composes the public
// registry and adds planner capability facts only for explicitly adopted and verified external assets. No module
// import starts work; plan admission stores the profile and the coordinator checks the executing registry again.
import { createHash } from 'node:crypto';
import type { Digest } from '../contracts/common.js';
import type { PlanStage } from '../contracts/plan.js';
import type { ResourcePolicy } from '../contracts/work.js';
import { createCapabilityTable, type CapabilityFact, type PlannerProfile } from '../planner/index.js';
import { createAdapterRegistry, type AdapterRegistry } from '../execution/registry.js';
import { executionProfileRecord, EXECUTION_PROFILE_SCHEMA, type ExecutionProfileRecord } from '../execution/profile.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { productionDrivers } from '../adapters/drivers/index.js';
import { PREVIEW_DETECTOR_ID } from '../adapters/preview-detector.js';
import { builtinPackDir, ownExecutable } from './package-paths.js';
import { readPackDirectory, validatePack } from '../rules/index.js';
import { realpathSync } from 'node:fs';
import type { PlanEnvelope } from '../contracts/plan.js';

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

/**
 * Exactly which rules each check adapter this build ships implements, read from the shipped pack's own bytes: the
 * family, its revision and its definition digest, which covers the definition and every file it names (the detector
 * description and the fixtures). A check adapter executes only these; being assigned a check of any other rule, or of
 * this family with other bytes, is not evidence that the adapter ran it, so such a plan is refused, never covered.
 */
export interface SupportedRule { readonly adapterId: string; readonly familyId: string; readonly revision: number; readonly definitionDigest: string }

let supportedCache: readonly SupportedRule[] | undefined;
export function supportedRules(): readonly SupportedRule[] {
  if (supportedCache) return supportedCache;
  const pack = validatePack(readPackDirectory(realpathSync.native(builtinPackDir('foundation-preview')!)));
  supportedCache = Object.freeze(pack.manifest.rules.map(definition => {
    const locked = pack.rules.find(r => r.familyId === definition.familyId && r.revision === definition.revision)!;
    return Object.freeze({ adapterId: definition.implementation.adapterId, familyId: locked.familyId, revision: locked.revision, definitionDigest: locked.definitionDigest });
  }));
  supportedCache = Object.freeze([...supportedCache, ...[...productionDrivers({ maxAdvisoryAgeMs: 7 * 86400000 }).values()].flatMap(e => e.driver.supportedRules().map(r => ({ ...r, adapterId: e.definition.id })))]);
  return supportedCache;
}

/** The check adapters this build ships (whose rules are bound by supportedRules). */
export const SHIPPED_CHECK_ADAPTERS: ReadonlySet<string> = new Set([PREVIEW_DETECTOR_ID, 'pattern-semgrep', 'advisories-osv', 'iac-trivy', 'ci-zizmor', 'secrets-gitleaks']);

/**
 * The plan's rules that a shipped check adapter would be asked to run but does not implement, exactly: any other
 * family, revision or definition bytes. Empty when every such rule is supported.
 */
export function unsupportedRules(plan: Pick<PlanEnvelope, 'pins'>): Array<{ familyId: string; revision: number; adapterId: string }> {
  const supported = supportedRules();
  return plan.pins.rules
    .filter(r => SHIPPED_CHECK_ADAPTERS.has(r.adapterId))
    .filter(r => !supported.some(s => s.adapterId === r.adapterId && s.familyId === r.familyId && s.revision === r.revision && s.definitionDigest === r.definitionDigest))
    .map(r => ({ familyId: r.familyId, revision: r.revision, adapterId: r.adapterId }));
}
