// The canonical derivations of plan identities, shared by the planner and the plan contract's validator, so a
// revision whose ids do not follow from their content is refused wherever it is checked. Also the trusted-view
// brand: planner inputs carry trusted identity (a lock pin, a policy revision, a snapshot or analysis identity)
// only as the deep-frozen copies the adapters produce.
import { digestOf } from '../store/ledger-json.js';

const shortHash = (value: unknown) => digestOf(value).slice(7, 31);

/** A check's id: (scope, rule family and revision, environment, mode). */
export const checkIdOf = (c: { scopeId: string; familyId: string; ruleRevision: number; environment: string }): string =>
  `chk-${shortHash({ scope: c.scopeId, family: c.familyId, revision: c.ruleRevision, environment: c.environment, mode: 'deterministic' })}`;

/** A check unit's id: its run and plan revision, adapter, source and exact checks. */
export const checkUnitIdOf = (u: { runId: string; revision: number; adapterId: string; sourceId: string; checks: readonly string[] }): string =>
  `work-check-${shortHash({ runId: u.runId, revision: u.revision, adapterId: u.adapterId, sourceId: u.sourceId, checks: [...u.checks] })}`;

/** A bootstrap unit's id: its run and plan revision, stage and source. */
export const bootstrapUnitIdOf = (u: { runId: string; revision: number; stage: string; sourceId: string | null }): string =>
  `work-${u.stage}-${shortHash({ runId: u.runId, revision: u.revision, stage: u.stage, sourceId: u.sourceId })}`;

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const trusted = new WeakSet<object>();

/** A private, deep-frozen copy of an adapter's derivation, recognised by isTrustedView. */
export function trustedView<T extends object>(value: T): T {
  const copy = deepFreeze(structuredClone(value));
  trusted.add(copy);
  return copy;
}

export const isTrustedView = (value: unknown): boolean => typeof value === 'object' && value !== null && trusted.has(value);

/** A review unit is pinned to its exact segment/spec and remains separate from check coverage. */
export const reviewUnitIdOf=(u:{runId:string;revision:number;stage:string;sourceId:string;segmentId:string;specDigest:string})=>`work-review-${shortHash(u)}`;
