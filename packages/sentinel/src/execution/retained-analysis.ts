// Only the coordinator creates retained evidence, from its exact admitted plan and the ledger's accepted
// bootstrap. Artifact JSON, a caller's ids or a copied context cannot grant access to retained auxiliary bytes.
import type { ArtifactId, WorkRef } from '../contracts/common.js';
import type { PlanWork } from '../contracts/plan.js';
import { deepFreeze } from '../policy/immutable.js';
import type { AnalysisArtifact, ParserIndex, ParserResult } from '../snapshot/parser.js';
import type { SentinelStore } from '../store/index.js';
import { canonicalJsonBytes } from '../store/objects.js';
import type { RetainedAnalysis } from './check-drivers.js';
import { ExecutionError } from './errors.js';
import { isValidatedPlan, type ValidatedPlan } from './plan.js';
import type { ExecutionProfileRecord } from './profile.js';
import { RetainedBudget, verifyRetainedSource } from './retained-source.js';

export type AnalysisRole = 'analysis-result' | 'analysis-index' | 'analysis-artifact' | 'snapshot-manifest';
const retained = new WeakMap<object, Readonly<Record<AnalysisRole, Buffer>>>();
const same = (a: unknown, b: unknown) => canonicalJsonBytes(a ?? null).equals(canonicalJsonBytes(b ?? null));
const refSame = (a: WorkRef, b: WorkRef) => a.id === b.id && a.revision === b.revision;
const fail = (reason: string): never => {
  throw new ExecutionError('sentinel.execution.analysisUnavailable', { reason });
};

/** Copy on read: drivers cannot change the original retained bytes or mint this capability structurally. */
export function retainedBytesOf(value: RetainedAnalysis | null): Readonly<Record<AnalysisRole, Buffer>> {
  const bytes = value && retained.get(value);
  if (!bytes) return fail('not coordinator-produced retained evidence');
  return Object.fromEntries(Object.entries(bytes).map(([role, buffer]) => [role, Buffer.from(buffer)])) as Record<
    AnalysisRole,
    Buffer
  >;
}

/** The exact mapping the coordinator checks after prepare and records with the attempt's invocation. */
export function retainedBinding(value: RetainedAnalysis) {
  if (!retained.has(value)) return fail('not coordinator-produced retained evidence');
  return {
    inventory: value.inventory,
    result: value.result.id,
    index: value.index.id,
    artifact: value.artifact.id,
    manifest: value.manifest,
  };
}

export function verifyRetainedAuxiliary(
  value: RetainedAnalysis | null,
  auxiliary: readonly { id: ArtifactId; role: string }[],
): void {
  const roles: Record<AnalysisRole, ArtifactId> | null = value
    ? {
        'analysis-result': value.result.id,
        'analysis-index': value.index.id,
        'analysis-artifact': value.artifact.id,
        'snapshot-manifest': value.manifest,
      }
    : null;
  if (value) retainedBytesOf(value);
  if (roles && auxiliary.some((a) => Object.values(roles).includes(a.id) && !Object.hasOwn(roles, a.role)))
    throw new ExecutionError('sentinel.execution.inputMismatch', {
      reason: 'retained bytes have a foreign auxiliary role',
    });
  for (const role of ['analysis-result', 'analysis-index', 'analysis-artifact', 'snapshot-manifest'] as const) {
    const found = auxiliary.filter((a) => a.role === role);
    if (roles ? found.length !== 1 || found[0]!.id !== roles[role] : found.length !== 0) {
      throw new ExecutionError('sentinel.execution.inputMismatch', {
        reason: 'retained analysis auxiliary roles differ from the exact admitted evidence',
      });
    }
  }
}

export async function retainedAnalysisFor(
  store: SentinelStore,
  plan: ValidatedPlan,
  unit: Readonly<PlanWork>,
  profile: Readonly<ExecutionProfileRecord>,
  signal: AbortSignal,
  stillWithin: () => void = () => {},
): Promise<RetainedAnalysis> {
  // Before the genuine store is proven, the original boundary; after, the counted budget with its own deadline.
  let budget: RetainedBudget | undefined;
  const boundary = () => {
    if (budget) return budget.boundary();
    store.assertHeld();
    if (signal.aborted) throw new ExecutionError('sentinel.execution.canceled');
    stillWithin();
  };
  try {
    boundary();
    budget = new RetainedBudget(store, { signals: [signal], stillWithin: [stillWithin] });
    const read = (id: ArtifactId) => budget!.read(id, 'metadata');
    const load = budget.planLoader();
    if (!isValidatedPlan(store, plan) || unit.stage !== 'check' || !unit.sourceId || plan.unitOf(unit).unit !== unit)
      return fail('not an exact validated check unit');
    const checks = plan.unitOf(unit).checks;
    if (
      unit.scopes.length !== 1 ||
      unit.scopes[0] !== unit.sourceId ||
      !checks.length ||
      checks.length !== unit.checks.length ||
      checks.some(
        (c) =>
          c.state !== 'planned' ||
          c.scopeKind !== 'repository' ||
          c.scopeId !== unit.sourceId ||
          c.sourceId !== unit.sourceId,
      )
    )
      return fail('retained whole-source analysis requires repository-scoped checks');
    const admitted = await load(plan.run.id, plan.admitted.plan.revision);
    boundary();
    if (
      !same(admitted.record, plan.admitted.record) ||
      !same(admitted.plan, plan.admitted.plan) ||
      !same(profile, admitted.profile)
    )
      return fail('not the admitted plan and parse profile');
    if (unit.dependencies.length !== 1)
      return fail('a retained-analysis check depends on exactly one bootstrap inventory');
    const inventory = unit.dependencies[0]!;
    if (!plan.reusedProven(inventory) || !admitted.plan.reused.some((r) => refSame(r, inventory)))
      return fail('the dependency is not a proven reused bootstrap');

    const verified = await verifyRetainedSource(
      store,
      { read, boundary, loadPlan: load },
      { admitted, inventory, sourceId: unit.sourceId, profile },
    );
    const { record, source, opened, result, index, artifact } = verified;
    const { result: resultBytes, index: indexBytes, artifact: artifactBytes } = verified.bytes;
    const expectedInputs = opened.snapshot.entries
      .filter((e) => e.sourceId === unit.sourceId && e.kind === 'file' && e.disposition === 'included')
      .map((e) => ({
        sourceId: e.sourceId,
        relativePath: e.relativePath,
        content: e.kind === 'file' && e.disposition === 'included' ? e.content : '',
      }))
      .sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
    if (
      !same(
        [...unit.inputs].sort((a, b) =>
          a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
        ),
        expectedInputs,
      )
    )
      return fail('whole-source retained evidence requires every included captured source file');
    const manifestBytes = await read(record.manifest);
    const value: RetainedAnalysis = deepFreeze({
      sourceId: unit.sourceId,
      snapshotId: record.snapshotId,
      analysisFingerprint: source.analysisFingerprint,
      inventory: { ...inventory },
      result: { id: source.result, value: result as ParserResult },
      index: { id: source.index, value: index as ParserIndex },
      artifact: { id: source.artifact, value: artifact as AnalysisArtifact },
      manifest: record.manifest,
      entries: opened.snapshot.entries.filter((e) => e.sourceId === unit.sourceId),
    });
    budget.retain(resultBytes.length + indexBytes.length + artifactBytes.length + manifestBytes.length);
    // After the value is built: the deadline, cancellation and the genuine owner and epoch, then mint and return.
    boundary();
    retained.set(value, {
      'analysis-result': resultBytes,
      'analysis-index': indexBytes,
      'analysis-artifact': artifactBytes,
      'snapshot-manifest': manifestBytes,
    });
    return value;
  } catch (error) {
    boundary();
    // A refusal the budget raised inside another module's reader (the snapshot reader) keeps its own code and reason.
    if (budget?.failure !== undefined) throw budget.failure;
    if (
      error instanceof ExecutionError &&
      [
        'sentinel.execution.canceled',
        'sentinel.execution.deadlineExceeded',
        'sentinel.execution.runDeadline',
        'sentinel.execution.analysisUnavailable',
      ].includes(error.code)
    )
      throw error;
    throw new ExecutionError(
      'sentinel.execution.analysisUnavailable',
      { reason: 'retained bootstrap evidence is missing, malformed or mismatched' },
      { cause: error },
    );
  }
}
