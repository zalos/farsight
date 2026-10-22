// Trusted check drivers: the fixed, package-owned code that turns one admitted check unit into the exact job a
// registered scanner adapter runs, and turns that adapter's verified result into coverage and records. A driver is
// bound to an adapter id AND its implementation digest; it is Sentinel's own code, never a function supplied by a
// worker, a repository or IPC.
//
// The coordinator alone runs the attempt (ExecutionService.run with its journals, resources, cancel and retry):
// - prepare(context) receives the admitted plan, the unit and its checks, its exact source inputs, the resolved
//   rules for those checks with their pack files' bytes (each verified against the pinned lock's digest), the
//   restored snapshot root and the admitted profile. It returns a deterministic job (canonical JSON) and any
//   auxiliary inputs (rule files, configuration, a database snapshot) as files. The source inputs stay exactly the
//   plan's (verifyInputSet); the job and every auxiliary input are recorded separately, by digest and role, in the
//   execution binding accepted with the attempt's start.
// - normalize(context, verified) runs after the worker succeeded and its outputs were verified, before its work
//   folder is released. It returns the coverage view (checks covered, scope scanned, skipped, unresolved, and the
//   granularity the engine actually established) and any records to publish in the same publication.
// Coverage still passes through coverageRecords: never finer than the adapter's registered granularity, with every
// limitation attributed by the plan's own extents. A driver that cannot prove a check's rule is one its engine runs
// must report that check as not covered.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ArtifactId, Digest, Id } from '../contracts/common.js';
import type { CoverageGranularity } from '../contracts/coverage.js';
import type { PlanCheck, PlanEnvelope, PlanWork } from '../contracts/plan.js';
import type { ResultMessage } from '../contracts/protocol.js';
import type { ResolvedRule } from '../rules/resolve.js';
import { ExecutionError } from './errors.js';
import type { ExecutionProfileRecord } from './profile.js';
import type { AdapterRegistry } from './registry.js';
import type { CapturedInput, VerifiedOutput, WorkerOutcome } from './supervisor.js';

export interface RuleFiles {
  readonly rule: ResolvedRule;
  /** Every file the rule's definition names, with its bytes, each verified against the pack's recorded digest. */
  readonly files: readonly { readonly path: string; readonly digest: Digest; readonly bytes: Uint8Array }[];
}

export interface DriverContext {
  /** The same cancellation and absolute unit/run deadline signal used by the worker. */
  readonly signal: AbortSignal;
  readonly plan: Readonly<PlanEnvelope>;
  readonly unit: Readonly<PlanWork>;
  readonly checks: readonly Readonly<PlanCheck>[];
  readonly profile: Readonly<ExecutionProfileRecord>;
  /** The unit's source inputs, exactly the plan's, with the scopes each is. */
  readonly inputs: readonly CapturedInput[];
  readonly inputScopes: readonly { readonly input: ArtifactId; readonly scopes: readonly string[] }[];
  /** The rules of exactly this unit's checks, resolved under the pinned lock; empty when no pack bytes were given. */
  readonly rules: readonly RuleFiles[];
  /** The tools the plan pins for this unit's adapter (the lock's entry: version and image or artifact digest). */
  readonly tools: readonly { readonly adapterId: Id; readonly artifactDigest: Digest }[];
  /** The advisory databases the plan pins, as admitted owner copies, each verified against its snapshot digest. */
  readonly databases: readonly { readonly databaseId: Id; readonly snapshotDigest: Digest; readonly path: string }[];
  /** Where the pinned snapshot is restored for this drive. */
  readonly restored: string | null;
  /** A private folder for this attempt's prepared files; removed with the attempt. */
  readonly workDir: string;
}

export interface PreparedJob {
  /** The deterministic job the adapter runs, delivered to the worker as one more input (canonical JSON). */
  readonly job: unknown;
  /** Further inputs the job needs, as files, each with a role (`rule`, `config`, `database`, ...). */
  readonly auxiliary: readonly { readonly path: string; readonly role: string }[];
}

export interface NormalizedOutcome {
  /** The coverage view the coordinator turns into canonical records (bounded by the adapter's granularity). */
  readonly coverage: Pick<ResultMessage, 'coveredChecks' | 'scannedSet' | 'skipped' | 'unresolvedFrontiers'> & { readonly actualReadSet?: ResultMessage['actualReadSet'] } & { readonly granularity: CoverageGranularity };
  /** Records published with the result (observations, provenance), as canonical JSON. */
  readonly records: readonly { readonly value: unknown; readonly schema: string; readonly privacy?: 'metadata' | 'source-derived' | 'source' }[];
}

export interface VerifiedAttempt {
  /** The exact supervisor outcome, deep-frozen by the coordinator; image facts never come from worker metadata. */
  readonly outcome: Readonly<WorkerOutcome>;
  readonly result: ResultMessage;
  readonly outputs: readonly VerifiedOutput[];
  readonly workDir: string;
  /** The job prepare returned (as stored with the attempt's start). */
  readonly job: unknown;
  /** A verified output's bytes by id. */
  output(id: ArtifactId): Uint8Array;
  /** The attempt's sealed copy of an input (source, job or auxiliary) by id, or undefined. */
  sealed(id: ArtifactId): Uint8Array | undefined;
}

export interface CheckDriver {
  readonly adapterId: Id;
  /** The registered adapter's digest this driver is written for; any other digest is refused. */
  readonly implementationDigest: Digest;
  /**
   * The exact rule revisions this driver's engine runs, by their pinned definition digest. A plan whose checks name
   * any other rule for this adapter is refused before anything runs: no arbitrary rule can claim coverage.
   */
  supportedRules(): readonly { readonly familyId: string; readonly revision: number; readonly definitionDigest: Digest }[];
  prepare(context: DriverContext): Promise<PreparedJob>;
  normalize(context: DriverContext, verified: VerifiedAttempt): Promise<NormalizedOutcome>;
}

export interface CheckDriverRegistry {
  driverFor(adapterId: Id): CheckDriver | undefined;
  readonly ids: readonly Id[];
}

const drivers = new WeakSet<object>();
const refuse = (reason: string): never => { throw new ExecutionError('sentinel.execution.adapterInvalid', { reason }); };

/**
 * Bind drivers to the trusted registry: each names a registered check adapter (not an operation) at exactly its
 * digest, once. Only a registry built here is accepted by the coordinator.
 */
export function createCheckDriverRegistry(list: readonly CheckDriver[], registry: AdapterRegistry): CheckDriverRegistry {
  const byId = new Map<Id, CheckDriver>();
  for (const d of list) {
    if (!d || typeof d.prepare !== 'function' || typeof d.normalize !== 'function' || typeof d.supportedRules !== 'function') refuse('a driver has supportedRules, prepare and normalize');
    if (!registry.ids.includes(d.adapterId)) refuse(`driver for ${d.adapterId}: the adapter is not registered`);
    const adapter = registry.get(d.adapterId);
    if (adapter.kind === 'operation') refuse(`driver for ${d.adapterId}: an operation runs no check`);
    if (adapter.digest !== d.implementationDigest) refuse(`driver for ${d.adapterId}: written for another implementation digest`);
    if (byId.has(d.adapterId)) refuse(`two drivers for ${d.adapterId}`);
    byId.set(d.adapterId, Object.freeze({ ...d }));
  }
  const out = Object.freeze({ ids: Object.freeze([...byId.keys()]), driverFor: (id: Id) => byId.get(id) });
  drivers.add(out);
  return out;
}

export const isCheckDriverRegistry = (v: unknown): v is CheckDriverRegistry => typeof v === 'object' && v !== null && drivers.has(v);

export const fileDigest = (path: string): Digest => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

/**
 * Every check unit of the plan runs through a driver, and every rule its checks name is one its driver supports at
 * exactly the pinned definition digest. Returns the reason the plan cannot run, or undefined.
 */
export function driverRefusal(plan: Readonly<PlanEnvelope>, registry: CheckDriverRegistry, adapters: AdapterRegistry): string | undefined {
  const pins = new Map(plan.pins.rules.map(r => [`${r.familyId}@${r.revision}`, r]));
  for (const u of plan.units) {
    if (u.stage !== 'check' || u.adapterId === null) continue;
    const d = registry.driverFor(u.adapterId);
    if (!d) return `adapter ${u.adapterId} has no trusted driver`;
    if (!adapters.ids.includes(u.adapterId)) return `adapter ${u.adapterId} is not in the executing registry`;
    const adapter = adapters.get(u.adapterId);
    if (adapter.kind === 'operation' || d.implementationDigest !== adapter.digest || d.implementationDigest !== u.implementationDigest) {
      return `the driver for ${u.adapterId} is written for another implementation digest than the executing adapter and admitted unit`;
    }
    const supported = new Set(d.supportedRules().map(r => `${r.familyId}@${r.revision}@${r.definitionDigest}`));
    for (const id of u.checks) {
      const c = plan.checks.find(x => x.id === id)!;
      const pin = pins.get(`${c.familyId}@${c.ruleRevision}`);
      if (!pin || !supported.has(`${pin.familyId}@${pin.revision}@${pin.definitionDigest}`)) return `the driver for ${u.adapterId} does not run rule ${c.familyId} revision ${c.ruleRevision} at its pinned definition`;
    }
  }
  return undefined;
}
