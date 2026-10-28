// The execution profile record: the trusted profile a plan is made and run under, in a form the ledger can keep.
//
// The planner's PlannerProfile holds the live adapter registry and capability table, which cannot be stored. This
// record captures exactly what execution relies on: every adapter the profile may run by its registry digest, the
// capability facts, the permits, the bootstrap operations, the resources each stage is granted, and the parse
// operation's selection and limits (they decide its output). Admission (plans.ts) stores it beside the plan and
// checks it against the plan's pins; the coordinator checks it again against the live registry before anything runs.
import type { Digest, Id } from '../contracts/common.js';
import type { BuiltinPlanStage, PlanAdapterPin, PlanEnvelope } from '../contracts/plan.js';
import type { ResourcePolicy } from '../contracts/work.js';
import type { PlannerProfile } from '../planner/types.js';
import type { ParserLimits, ParserSelection } from '../snapshot/parser.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { ExecutionError } from './errors.js';
import type { AdapterRegistry } from './registry.js';

export const EXECUTION_PROFILE_SCHEMA = 'sentinel-execution-profile/draft-1';

export interface ExecutionProfileRecord {
  schema: typeof EXECUTION_PROFILE_SCHEMA;
  id: Id;
  /** Every adapter the profile may run, by its registry digest, sorted by id. */
  adapters: PlanAdapterPin[];
  capabilities: { capability: string; adapterId: Id; adapterDigest: Digest }[];
  permits: string[];
  operations: PlanEnvelope['pins']['operations'];
  resources: Record<BuiltinPlanStage, ResourcePolicy>;
  parse: { selection: ParserSelection; limits: Required<ParserLimits> };
}

const refuse = (reason: string): never => {
  throw new ExecutionError('sentinel.execution.planInvalid', { reason });
};
// Canonical comparison: a record read back from the store has its keys in canonical order.
const sameJson = (a: unknown, b: unknown) => Buffer.from(canonicalJsonBytes(a)).equals(canonicalJsonBytes(b));

/** The record for a planner profile, the resources each stage is granted, and the parse operation's settings. */
export function executionProfileRecord(
  profile: PlannerProfile,
  resources: Record<BuiltinPlanStage, ResourcePolicy>,
  parse: ExecutionProfileRecord['parse'],
): ExecutionProfileRecord {
  const pin = (id: Id | undefined) =>
    id === undefined ? null : { adapterId: id, digest: profile.registry.get(id).digest };
  const o = profile.operations ?? {};
  return structuredClone({
    schema: EXECUTION_PROFILE_SCHEMA,
    id: profile.id,
    adapters: [...profile.registry.ids]
      .sort()
      .map((id) => ({ adapterId: id, digest: profile.registry.get(id).digest })),
    capabilities: profile.capabilities.facts
      .map((f) => ({ capability: f.capability, adapterId: f.adapterId, adapterDigest: f.adapterDigest }))
      .sort((a, b) => (a.capability + a.adapterId < b.capability + b.adapterId ? -1 : 1)),
    permits: [...new Set(profile.permits)].sort(),
    operations: { capture: pin(o.capture), parse: pin(o.parse), inventory: pin(o.inventory) },
    resources,
    parse,
  });
}

/** The plan was made under this profile: same id and operations, and every adapter and fact it pins is the profile's. */
export function checkProfileForPlan(record: ExecutionProfileRecord, plan: PlanEnvelope): void {
  if (record?.schema !== EXECUTION_PROFILE_SCHEMA)
    refuse('the execution profile is not a sentinel-execution-profile/draft-1 record');
  if (record.id !== plan.pins.profileId) refuse('the plan was made under another profile');
  if (!sameJson(record.operations, plan.pins.operations))
    refuse('the plan binds other bootstrap operations than the profile');
  const adapters = new Map(record.adapters.map((a) => [a.adapterId, a.digest]));
  for (const a of plan.pins.adapters)
    if (adapters.get(a.adapterId) !== a.digest)
      refuse(`the plan pins adapter ${a.adapterId} at another digest than the profile`);
  for (const c of plan.pins.capabilities) {
    if (
      !record.capabilities.some(
        (f) => f.capability === c.capability && f.adapterId === c.adapterId && f.adapterDigest === c.adapterDigest,
      )
    ) {
      refuse(`the plan relies on capability ${c.capability} the profile does not establish`);
    }
    if (!record.permits.includes(c.capability))
      refuse(`the plan relies on capability ${c.capability} the profile does not permit`);
  }
  for (const stage of ['capture', 'parse', 'inventory', 'check'] as const)
    if (!record.resources?.[stage]) refuse(`the profile grants no resources to the ${stage} stage`);
}

/** Every adapter the profile names is registered now with the same digest: nothing changed since admission. */
export function checkProfileRegistry(record: ExecutionProfileRecord, registry: AdapterRegistry): void {
  for (const a of record.adapters) {
    if (!registry.ids.includes(a.adapterId)) refuse(`adapter ${a.adapterId} is no longer registered`);
    if (registry.get(a.adapterId).digest !== a.digest)
      refuse(`adapter ${a.adapterId} is registered with another digest than the profile recorded`);
  }
}
