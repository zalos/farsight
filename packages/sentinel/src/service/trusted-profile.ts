// The command line's trusted execution profile: the narrow adapter registry this build ships (the built-in
// foundation-preview detector only), what Sentinel's own code says it establishes, and what the profile permits,
// as the planner's live objects and as one canonical, versioned, serializable document. The document is what a plan
// admission pins: adapter ids and digests, capability facts and permits, never a live object. It claims nothing a
// registered adapter does not establish; every scanner, framework or model capability stays unavailable here.
//
// Bootstrap operations (capture, parse, inventory) are bound by the coordinator's bootstrap operations once they
// exist; until then they are absent, and the planner keeps those stages blocked rather than running them.
import { canonicalJsonBytes } from '../store/objects.js';
import { createHash } from 'node:crypto';
import type { Digest, Id } from '../contracts/common.js';
import type { PlanStage } from '../contracts/plan.js';
import type { ResourcePolicy } from '../contracts/work.js';
import { createCapabilityTable, type CapabilityFact, type ExecutionProfile, type PlannerProfile } from '../planner/index.js';
import type { AdapterRegistry } from '../execution/registry.js';
import { PREVIEW_DETECTOR_ID } from '../adapters/preview-detector.js';
import { PREVIEW_ADAPTERS } from './preview-plan.js';

export const EXECUTION_PROFILE_SCHEMA = 'sentinel-execution-profile/draft-1';
export const FOUNDATION_PROFILE_ID = 'foundation-preview';

/** The canonical profile document a plan pins. */
export interface ExecutionProfileDocument {
  readonly schema: typeof EXECUTION_PROFILE_SCHEMA;
  readonly id: Id;
  readonly adapters: readonly { readonly id: Id; readonly version: string; readonly kind: string; readonly digest: Digest }[];
  readonly capabilities: readonly { readonly capability: string; readonly adapterId: Id; readonly adapterDigest: Digest; readonly evidence: string; readonly perFileParse: boolean }[];
  readonly permits: readonly string[];
  readonly operations: { readonly capture: Id | null; readonly parse: Id | null; readonly inventory: Id | null };
  readonly resources: Readonly<Record<PlanStage, ResourcePolicy>>;
}

export interface TrustedProfile {
  readonly planner: PlannerProfile;
  readonly execution: ExecutionProfile;
  readonly registry: AdapterRegistry;
  readonly document: ExecutionProfileDocument;
  /** The document's canonical digest. */
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

/** The serializable form of a planner profile and its execution limits, in a fixed order. */
export function profileDocument(profile: PlannerProfile, execution: ExecutionProfile): ExecutionProfileDocument {
  const adapters = profile.registry.ids.map(id => profile.registry.get(id)).map(a => ({ id: a.id, version: a.version, kind: a.kind, digest: a.digest }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const capabilities = profile.capabilities.facts.map(f => ({ capability: f.capability, adapterId: f.adapterId, adapterDigest: f.adapterDigest,
    evidence: f.evidence, perFileParse: f.perFileParse === true }))
    .sort((a, b) => (a.capability + a.adapterId < b.capability + b.adapterId ? -1 : 1));
  return {
    schema: EXECUTION_PROFILE_SCHEMA, id: profile.id, adapters, capabilities, permits: [...profile.permits].sort(),
    operations: { capture: profile.operations?.capture ?? null, parse: profile.operations?.parse ?? null, inventory: profile.operations?.inventory ?? null },
    resources: execution.resources,
  };
}

export const profileDigest = (document: ExecutionProfileDocument): Digest =>
  `sha256:${createHash('sha256').update(canonicalJsonBytes(document)).digest('hex')}`;

/** The foundation-preview profile: the preview detector's facts over the shipped registry, permitting exactly those. */
export function foundationProfile(): TrustedProfile {
  const registry = PREVIEW_ADAPTERS;
  const planner: PlannerProfile = Object.freeze({
    id: FOUNDATION_PROFILE_ID, registry, capabilities: createCapabilityTable(registry, FACTS), permits: Object.freeze(FACTS.map(f => f.capability)),
  });
  const execution: ExecutionProfile = Object.freeze({ resources: Object.freeze({ capture: LIMITS, parse: LIMITS, inventory: LIMITS, check: LIMITS }) });
  const document = profileDocument(planner, execution);
  return Object.freeze({ planner, execution, registry, document, digest: profileDigest(document) });
}
