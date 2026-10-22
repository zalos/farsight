// A selected rerun's selection: which units of an admitted analysis revision run, and which are held.
//
// A selected-stage rerun is a child run of an ended run, over the parent's retained snapshot and its published
// bootstrap (reused through the parent chain, never captured or parsed again), planned under the terms current now.
// Its analysis revision is the planner's complete revision for those terms; the selection record, admitted with it
// and pinned beside it, names exactly the units this run executes: the units matching the selected parent units
// (same adapter and implementation, source, checks, captured inputs and input fingerprint) and every unit downstream
// of them. Every other unit is held (disabled by the selection, with its reason) and never runs here; the parent's
// own result for it, where it has one, stays the parent's. The rerun's required coverage counts only what it ran, so
// a held required check keeps it incomplete: nothing is reused as coverage (that needs PR 27's derivations).
import type { Id, WorkRef } from '../contracts/common.js';
import type { PlanEnvelope, PlanWork } from '../contracts/plan.js';
import { ExecutionError } from './errors.js';

export const SELECTION_SCHEMA = 'sentinel-rerun-selection/draft-1';
/** The hold a unit outside the selection carries in the ledger. */
export const NOT_SELECTED = 'sentinel.execution.notSelected';

export interface RerunSelection {
  schema: typeof SELECTION_SCHEMA;
  /** The ended run this one reruns, at the revision the selection was made against. */
  parent: { runId: Id; revision: number; planDigest: string; snapshotId: Id };
  /** The parent units asked for, and the units of this revision they are. */
  selected: Array<{ parentUnit: Id; unit: Id }>;
  /** Units of this revision downstream of a selected one: they run too. */
  downstream: Id[];
  /** Every other unit of this revision: not run here; `parentUnit` is its exact counterpart in the parent, if any. */
  held: Array<{ unit: Id; parentUnit: Id | null }>;
  /** Published work of the parent chain this revision depends on (its bootstrap). */
  reused: WorkRef[];
}

const refuse = (reason: string): never => { throw new ExecutionError('sentinel.execution.planInvalid', { reason }); };
const sorted = (xs: Iterable<string>) => [...xs].sort();

/** The units a selection runs: the selected and the downstream ones. */
export const unitsToRun = (s: RerunSelection): Set<Id> => new Set([...s.selected.map(x => x.unit), ...s.downstream]);

/**
 * What a selection runs within one revision: the chosen units and everything downstream of them, and `needed`, the
 * units of the same revision something that runs depends on but that do not run. A non-empty `needed` is refused by
 * the caller (fail-closed): reusing another analysis unit's published result is not supported yet (PR 27).
 */
export function selectionClosure(units: readonly Pick<PlanWork, 'id' | 'dependencies'>[], chosen: readonly Id[]): { run: Set<Id>; needed: Id[] } {
  const ids = new Set(units.map(u => u.id));
  const run = new Set(chosen);
  for (let grew = true; grew;) {
    grew = false;
    for (const u of units) if (!run.has(u.id) && u.dependencies.some(d => run.has(d.id))) { run.add(u.id); grew = true; }
  }
  const needed = new Set(units.filter(u => run.has(u.id)).flatMap(u => u.dependencies.filter(d => ids.has(d.id) && !run.has(d.id)).map(d => d.id)));
  return { run, needed: [...needed].sort() };
}

/**
 * The selection fits the revision: every unit is either run or held, once; what runs is closed downstream (anything
 * depending on a unit that runs runs too); and nothing that runs depends on a held unit of the same revision (that
 * prerequisite would have to be reused from the parent, which a revision cannot express yet). The revision's own
 * reused work is the selection's.
 */
export function checkSelection(plan: Readonly<PlanEnvelope>, s: RerunSelection): void {
  if (s?.schema !== SELECTION_SCHEMA) refuse('the selection is not a sentinel-rerun-selection/draft-1 record');
  if (plan.kind !== 'analysis') refuse('only an analysis revision is admitted with a selection');
  const ids = new Set(plan.units.map(u => u.id));
  const run = unitsToRun(s);
  const held = new Set(s.held.map(h => h.unit));
  if (run.size === 0) refuse('a selection runs at least one unit');
  for (const id of run) if (!ids.has(id) || held.has(id)) refuse(`unit ${id} is not a unit of the revision, or is both run and held`);
  if (run.size + held.size !== ids.size || [...held].some(id => !ids.has(id))) refuse('every unit of the revision is run or held, once');
  if (s.selected.length !== new Set(s.selected.map(x => x.unit)).size) refuse('a unit is selected twice');
  for (const u of plan.units) {
    for (const d of u.dependencies) {
      if (!ids.has(d.id)) continue;
      if (run.has(d.id) && !run.has(u.id)) refuse(`unit ${u.id} depends on ${d.id}, which runs, so it must run too`);
      if (run.has(u.id) && !run.has(d.id)) refuse(`unit ${u.id} needs ${d.id} of this revision, which is held`);
    }
  }
  if (JSON.stringify(sorted(plan.reused.map(r => `${r.id}@${r.revision}`))) !== JSON.stringify(sorted(s.reused.map(r => `${r.id}@${r.revision}`)))) {
    refuse('the selection reuses other work than the revision');
  }
}

/** The structural identity a parent unit and a rerun unit must share to be the same work under the same terms. */
export const unitIdentity = (u: Pick<PlanWork, 'stage' | 'adapterId' | 'implementationDigest' | 'sourceId' | 'checks' | 'inputSetDigest' | 'inputFingerprint' | 'scopes'>) =>
  JSON.stringify([u.stage, u.adapterId, u.implementationDigest, u.sourceId, sorted(u.checks), u.inputSetDigest, u.inputFingerprint, sorted(u.scopes)]);
