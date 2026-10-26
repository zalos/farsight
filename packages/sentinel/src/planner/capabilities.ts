// Which rule capabilities this build can actually establish, and through which trusted adapter. A capability is
// available to a plan only when (1) Sentinel's own code recorded, in a capability table, that a registered adapter
// establishes it, with the evidence for that claim, (2) that adapter is still registered with the same digest in the
// trusted adapter registry (PR 07), and (3) the profile permits relying on it. A caller, a profile or a settings file
// can narrow what is permitted; none of them can make an unestablished capability available.
import type { Digest, Id } from '../contracts/common.js';
import type { AdapterRegistry } from '../execution/registry.js';
import { PlanError } from './errors.js';

/** One trusted fact: a registered adapter establishes a capability, and on what evidence. */
export interface CapabilityFact {
  readonly capability: string;
  readonly adapterId: Id;
  /** Where the qualification is recorded (a decision manifest entry, a backend measurement). */
  readonly evidence: string;
  /** The capability needs parser evidence for each file it reads: a file that did not parse cannot have it. */
  readonly perFileParse?: boolean;
}

export interface CapabilityTable {
  readonly facts: readonly (CapabilityFact & { readonly adapterDigest: Digest })[];
}

const tables = new WeakSet<object>();
const invalid = (detail: string) => new PlanError('sentinel.plan.invalidInput', detail);

/**
 * Builds the table from facts about adapters the trusted registry holds, pinning each adapter's digest now. A fact
 * about an adapter the registry does not hold is refused. Only a table built here is accepted by the planner.
 */
export function createCapabilityTable(registry: AdapterRegistry, facts: readonly CapabilityFact[]): CapabilityTable {
  const out = facts.map((f) => {
    if (!f || typeof f.capability !== 'string' || !f.capability || typeof f.evidence !== 'string' || !f.evidence)
      throw invalid('a capability fact names its capability and evidence');
    if (!registry.ids.includes(f.adapterId))
      throw invalid(`capability ${f.capability}: adapter ${f.adapterId} is not in the trusted registry`);
    return Object.freeze({
      capability: f.capability,
      adapterId: f.adapterId,
      evidence: f.evidence,
      ...(f.perFileParse ? { perFileParse: true } : {}),
      adapterDigest: registry.get(f.adapterId).digest,
    });
  });
  const table = Object.freeze({ facts: Object.freeze(out) });
  tables.add(table);
  return table;
}

export function isCapabilityTable(value: unknown): value is CapabilityTable {
  return typeof value === 'object' && value !== null && tables.has(value);
}

export interface CapabilityAnswer {
  readonly available: boolean;
  readonly reasonCode?: string;
  /** The fact the answer rests on, when available. */
  readonly fact?: CapabilityTable['facts'][number];
}

/** Whether `capability` is available: established by a still-registered adapter, and permitted. */
export function capabilityOf(
  table: CapabilityTable,
  registry: AdapterRegistry,
  permits: ReadonlySet<string>,
  capability: string,
): CapabilityAnswer {
  const fact = table.facts.find(
    (f) =>
      f.capability === capability &&
      registry.ids.includes(f.adapterId) &&
      registry.get(f.adapterId).digest === f.adapterDigest,
  );
  if (!fact) return { available: false, reasonCode: 'sentinel.plan.capabilityUnavailable' };
  if (!permits.has(capability)) return { available: false, reasonCode: 'sentinel.plan.capabilityNotPermitted' };
  return { available: true, fact };
}
