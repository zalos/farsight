// Two fixed coordinator operations, over a genuine admitted plan. No repository code or generic worker is called.
import type { WorkRef } from '../contracts/common.js';
import type { StageInputBinding } from '../contracts/pipeline.js';
import type { Principal } from '../contracts/policy.js';
import type { DecisionChannel } from '../contracts/disposition.js';
import type { SentinelStore } from '../store/index.js';
import type { EffectivePolicy } from '../policy/settings.js';
import type { ReceiptBook } from '../policy/receipts.js';
import { selectedSecretPrivacy } from '../reports/selected-privacy.js';
import { loadPlan } from '../execution/plans.js';
import { snapshot } from '../policy/immutable.js';
import { specDigest } from './session.js';
import { canonicalDigest } from '../policy/digest.js';
import { isValidatedPlan, type ValidatedPlan } from '../execution/plan.js';
import { ExecutionError } from '../execution/errors.js';
import type { PreparedOutputs } from '../execution/bootstrap.js';
import type { BudgetLedger } from './providers/budget.js';
import type { ModelBroker } from './providers/broker.js';
import { resolveReviewModel } from './providers/selection.js';
import { readReviewSpec } from './plan.js';
import { recheckPacks } from './packs.js';
import { providerCaller } from './caller.js';
import { LedgerCheckpointStore } from './checkpoints.js';
import { pinRunsNative, runnerForKind } from './runner.js';
import { runNativeReview } from './native-dispatch.js';
import { reviewFail } from './errors.js';
import { usageOf } from './operation.js';
export const REVIEW_IMPLEMENTATION_URL = import.meta.url;
export const REVIEW_ADAPTERS = Object.freeze([
  { id: 'sentinel.review.guided', version: '1', kind: 'operation' as const, operation: 'review-guided' as const },
  { id: 'sentinel.review.general', version: '1', kind: 'operation' as const, operation: 'review-general' as const },
]);
class ReviewWithheld extends Error {
  readonly code = 'sentinel.review.frontier.withheld';
  constructor() {
    super('accepted secret privacy withholds this optional review stage');
  }
}
export interface ReviewRuntime {
  /** The workspace trust folder: a spec's promoted pack bytes are re-checked there before the session starts. */
  readonly trustDir?: string;
  readonly ledger: BudgetLedger;
  readonly broker: ModelBroker;
  readonly currentPolicy: () => EffectivePolicy;
  readonly requestedBy: Readonly<{ principal: Principal; channel: DecisionChannel }>;
  readonly receipt?: { book: ReceiptBook; id: string };
  readonly receiptFor?: (
    request: import('./providers/broker.js').OpenEnvelopeRequest,
  ) => { book: ReceiptBook; id: string } | undefined;
}
const preparedFor = new WeakMap<object, { store: SentinelStore; plan: ValidatedPlan; work: string }>();
const envelopeCache = new WeakMap<ReviewRuntime, Map<string, import('./providers/broker.js').ModelEnvelope>>();
const bad = (): never => {
  throw new ExecutionError('sentinel.execution.planInvalid', {
    reason: 'review requires its exact admitted coordinator unit and current model binding',
  });
};
/**
 * Whether a sealed review spec may run on a pin: a native spec only on a pin that runs its own loop and names the
 * spec's runner, a brokered spec only on a pin that does not. Checked before the envelope opens.
 */
export function admitsMode(
  spec: Pick<import('./session.js').SessionSpec, 'native'>,
  binding: import('./providers/profile.js').ProviderBinding,
): boolean {
  const native = pinRunsNative(binding);
  if (native !== Boolean(spec.native)) return false;
  return !spec.native || spec.native.runner === runnerForKind(binding.kind).id;
}
export async function prepareAdmittedReview(
  store: SentinelStore,
  plan: ValidatedPlan,
  ref: WorkRef,
  runtime: ReviewRuntime | undefined,
) {
  if (!runtime || !isValidatedPlan(store, plan)) return bad();
  if (new Set(plan.admitted.plan.units.filter((u) => u.review).map((u) => u.review!.selection.bindingDigest)).size > 1)
    return bad();
  store.assertHeld();
  const unit = plan.unitOf(ref).unit;
  if (!unit.review || plan.admitted.plan.pins.snapshotId !== plan.run.snapshotId) return bad();
  if (await reviewSecretsKnown(store, plan.run.id, plan.admitted)) throw new ReviewWithheld();
  const spec = await readReviewSpec(store, unit);
  // The prompt and skills the spec sealed came from promoted packs: the trust folder must still hold exactly them.
  if (spec.packs?.length) {
    if (!runtime.trustDir) return bad();
    recheckPacks(runtime.trustDir, spec.packs);
  }
  const policy = runtime.currentPolicy(),
    resolved = resolveReviewModel(policy, spec.kind, spec.segmentId!);
  // Before any envelope opens: the sealed mode and runner are the current pin's.
  if (!admitsMode(spec, resolved.binding)) return bad();
  // The owner may select model review without an external scanner. A requested secret rule remains a gate even
  // when missing assets prevented a scanner unit from being planned; failed/partial scans never become optional.
  const secretScanSelected =
    policy.rules.includes('sentinel.secrets.current-tree') ||
    plan.admitted.plan.pins.rules.some((p) => p.adapterId === 'secrets-gitleaks') ||
    plan.admitted.plan.units.some((u) => u.adapterId === 'secrets-gitleaks');
  if (
    resolved.binding.disclosure === 'hosted' &&
    (policy.settings.hostedReviewSecretScan !== 'when-selected' || secretScanSelected)
  )
    await requireHostedSecretCoverage(store, plan.run.id, plan.admitted, unit.sourceId!);
  if (
    policy.revision !== plan.admitted.plan.pins.policyDigest ||
    resolved.selection.bindingDigest !== unit.review.selection.bindingDigest
  )
    return bad();
  const prior = runtime.ledger.loadCheckpoint(spec.sessionId);
  if (prior && prior.epoch !== store.epoch) runtime.ledger.recover([prior.epoch], new Date().toISOString());
  const request = {
    binding: resolved.binding,
    policy,
    runId: plan.run.id,
    budget: unit.review.terms.budget,
    requestedBy: runtime.requestedBy,
    stateDigest: canonicalDigest({
      store: store.storeId,
      run: plan.run.id,
      plan: plan.admitted.plan.digest,
      binding: resolved.selection.bindingDigest,
    }),
  };
  let cache = envelopeCache.get(runtime);
  if (!cache) envelopeCache.set(runtime, (cache = new Map()));
  const key = request.stateDigest;
  let envelope = cache.get(key);
  if (!envelope) {
    const receipt = runtime.receiptFor?.(request) ?? runtime.receipt;
    envelope = await runtime.broker.openEnvelope({ ...request, ...(receipt ? { receipt } : {}) });
    cache.set(key, envelope);
  }
  store.assertHeld();
  if (runtime.currentPolicy().revision !== policy.revision || store.ledger.getRun(plan.run.id)?.state === 'canceled')
    return bad();
  const { instructions, ...plain } = spec;
  const prepared = Object.freeze({
    spec: Object.freeze({ ...snapshot(plain), instructions }),
    resolved,
    envelope,
    runtime,
    review: snapshot({
      ...unit.review,
      policyRevision: policy.revision,
      envelopeId: envelope.id,
      admissionDigest: canonicalDigest(envelope.admission),
    }),
    admission: envelope.admission,
  });
  preparedFor.set(prepared, { store, plan, work: canonicalDigest({ id: ref.id, revision: ref.revision }) });
  return prepared;
}
export async function runAdmittedReview(
  store: SentinelStore,
  plan: ValidatedPlan,
  ref: WorkRef,
  attemptId: string,
  prepared: Awaited<ReturnType<typeof prepareAdmittedReview>>,
  signal: AbortSignal,
  deadlineAt: number,
  /**
   * The unit's declared inputs as the coordinator sealed them into its invocation: the exact accepted upstream
   * artifacts after the secret-withholding fold. They are the only upstream content the session may read, beside
   * its own captured scope; a binding that did not resolve, or was not folded, refuses the review.
   */
  stageInputs?: readonly StageInputBinding[],
): Promise<PreparedOutputs> {
  const seal = prepared && preparedFor.get(prepared);
  if (
    !isValidatedPlan(store, plan) ||
    !seal ||
    seal.store !== store ||
    seal.plan !== plan ||
    seal.work !== canonicalDigest({ id: ref.id, revision: ref.revision }) ||
    !plan.unitOf(ref).unit.review
  )
    return bad();
  store.assertHeld();
  const { runtime, spec, envelope } = prepared;
  const unit = plan.unitOf(ref).unit;
  if (specDigest(spec) !== unit.review!.specDigest) return bad();
  const current = () => {
    const policy = runtime.currentPolicy(),
      r = resolveReviewModel(policy, spec.kind, spec.segmentId!);
    if (
      policy.revision !== plan.admitted.plan.pins.policyDigest ||
      policy.revision !== prepared.review.policyRevision ||
      r.selection.bindingDigest !== unit.review!.selection.bindingDigest
    )
      return bad();
    return r.binding;
  };
  // What the session may read: its own captured scope and the fold-applied upstream artifacts it was bound to.
  for (const b of stageInputs ?? [])
    if (b.state !== 'resolved' || (b.secretFold !== 'applied' && b.secretFold !== 'not-applicable')) return bad();
  const readable = new Set<string>([
    ...spec.scope.files.map((f) => f.content),
    ...(stageInputs ?? []).flatMap((b) => b.artifacts),
  ]);
  // The admitted turn loop runs through the stage's agent runner; brokered mode is exactly the session below.
  const binding = prepared.resolved.binding,
    runner = runnerForKind(binding.kind);
  // Native mode: the runner the pin names runs its own loop over the unit's inputs; the same publication path.
  if (spec.native)
    return runNativeReview({
      store,
      unit,
      attemptId,
      spec: { ...spec, attemptId },
      runtime,
      envelope,
      binding: current,
      runner,
      signal,
      deadlineAt,
      ...(stageInputs ? { stageInputs } : {}),
    });
  const ran = await runner.run(
    {
      id: unit.stage,
      kind: 'agent',
      mode: 'brokered',
      runner: runner.id,
      model: binding.model,
      budget: { turns: spec.budget.maxSteps, seconds: Math.ceil(spec.budget.deadlineMs / 1000) },
    },
    [],
    {
      brokered: {
        spec: { ...spec, attemptId },
        options: {
          caller: providerCaller(runtime.broker, envelope, current, { deadlineAt }),
          checkpoints: new LedgerCheckpointStore(runtime.ledger, store.epoch),
          read: (id) => {
            if (!readable.has(id)) return bad();
            return store.readArtifact(id);
          },
          signal,
        },
      },
    },
  );
  if (ran.mode !== 'brokered') return bad();
  const result = ran.session;
  store.assertHeld();
  current();
  const artifacts = result.privateArtifacts ?? [],
    records = [
      {
        value: result.record,
        schema: 'sentinel-review-record/draft-1',
        privacy: 'source-derived' as const,
        links: artifacts.map((a) => a.id),
      },
      ...result.observations.map((value) => ({
        value,
        schema: value.schema,
        privacy: 'source-derived' as const,
        links: artifacts.map((a) => a.id),
      })),
    ];
  return {
    records,
    artifacts,
    outputs: records.map((r) => canonicalDigest(r.value)),
    bytes:
      artifacts.reduce((n, a) => n + a.bytes.byteLength, 0) +
      records.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r.value)), 0),
    usage: usageOf(runtime.ledger, envelope.id, result.record, prepared.resolved.binding.settingsBudget.currency),
  };
}

/** Shared known-secret boundary: exact executed current/selected ancestry and explicit baseline, never latest admission. */
export async function reviewSecretsKnown(
  store: SentinelStore,
  runId: string,
  admitted: import('../execution/plans.js').AdmittedPlan,
): Promise<boolean> {
  const current = await selectedSecretPrivacy(store, runId, admitted, true);
  let matches = current.hasMatches;
  const base = store.ledger.getRun(runId)?.envelope.baselineId;
  if (base) {
    const row = store.ledger.getRun(base);
    if (!row) return bad();
    const baseline = await loadPlan(store, base, row.planRevision);
    matches = (await selectedSecretPrivacy(store, base, baseline, true)).hasMatches || matches;
  }
  store.assertHeld();
  return matches;
}

/** Additional disclosure gate, not absence proof: only the current run's genuinely accepted complete scan qualifies. */
export async function requireHostedSecretCoverage(
  store: SentinelStore,
  runId: string,
  admitted: import('../execution/plans.js').AdmittedPlan,
  sourceId: string,
): Promise<void> {
  const fail = (): never => reviewFail('sentinel.review.secretCoverageRequired');
  store.assertHeld();
  const current = await loadPlan(store, runId, admitted.plan.revision);
  if (
    current.plan.digest !== admitted.plan.digest ||
    store.ledger.getRun(runId)?.planRevision !== current.plan.revision
  )
    return fail();
  // This authenticates the actual owned-container publication, invocation, assigned checks and exact finding count.
  if ((await selectedSecretPrivacy(store, runId, current, true)).hasMatches) return fail();
  const evidence = await (
      await import('../execution/retained-bootstrap.js')
    ).retainedBootstrapForReport(store, runId, current),
    entries = evidence.snapshot.entries.flatMap((e, i) =>
      e.sourceId === sourceId && e.kind === 'file' && e.disposition === 'included'
        ? [{ entry: sourceId + '#entry:' + i, path: e.relativePath, content: e.content }]
        : [],
    );
  const same = (a: unknown, b: unknown) => canonicalDigest(a) === canonicalDigest(b),
    read = async (id: string) => {
      const bytes = await store.readArtifact(id as never);
      store.assertHeld();
      if (bytes.length > 4194304) return fail();
      try {
        return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
      } catch {
        return fail();
      }
    };
  for (const unit of current.plan.units.filter((u) => u.adapterId === 'secrets-gitleaks' && u.sourceId === sourceId)) {
    const publication = store.ledger.getPublication(unit),
      row = store.ledger.getWork(unit);
    if (!publication || row?.state !== 'published') continue;
    if (
      !same(unit.inputs.map((i) => [i.relativePath, i.content]).sort(), entries.map((e) => [e.path, e.content]).sort())
    )
      continue;
    const reports = publication.outputs.filter((o) => o.schema === 'sentinel-driver-report/draft-1');
    if (reports.length !== 1) continue;
    const report = await read(reports[0]!.id);
    const expected = entries.map((e) => e.entry).sort();
    if (
      report.status !== 'complete' ||
      report.findings !== 0 ||
      report.adapter !== 'secrets-gitleaks' ||
      report.runId !== runId ||
      report.snapshotId !== current.plan.pins.snapshotId ||
      !same(report.work, { id: unit.id, revision: unit.revision }) ||
      report.attemptId !== publication.attemptId ||
      !Array.isArray(report.expectedEntries) ||
      !Array.isArray(report.scanned) ||
      !Array.isArray(report.actualReadSet) ||
      !Array.isArray(report.skipped) ||
      report.skipped.length ||
      !same([...report.expectedEntries].sort(), expected) ||
      !same([...report.scanned].sort(), expected) ||
      !same([...report.actualReadSet].sort(), expected)
    )
      continue;
    const coverages = publication.outputs.filter((o) => o.schema === 'sentinel-coverage/draft-1');
    let complete = unit.checks.length > 0;
    for (const checkId of unit.checks) {
      const check = current.plan.checks.find((c) => c.id === checkId),
        pin =
          check &&
          current.plan.pins.rules.find((p) => p.familyId === check.familyId && p.revision === check.ruleRevision);
      if (
        !check ||
        check.state !== 'planned' ||
        check.scopeKind !== 'repository' ||
        check.sourceId !== sourceId ||
        check.scopeId !== sourceId ||
        check.familyId !== 'sentinel.secrets.current-tree' ||
        check.ruleRevision !== 1 ||
        pin?.adapterId !== 'secrets-gitleaks'
      ) {
        complete = false;
        break;
      }
      const values = await Promise.all(coverages.map((o) => read(o.id))),
        matches = values.filter((v) => v.checkId === checkId);
      if (matches.length !== 1) {
        complete = false;
        break;
      }
      const coverage = matches[0];
      const { validateEnvelope } = await import('../validate.js');
      if (
        !validateEnvelope('coverage', coverage).ok ||
        coverage.runId !== runId ||
        coverage.workId !== unit.id ||
        coverage.workRevision !== unit.revision ||
        coverage.status !== 'complete' ||
        coverage.basis?.kind !== 'executed' ||
        coverage.basis.attemptId !== publication.attemptId ||
        coverage.skipped.length
      ) {
        complete = false;
        break;
      }
      if (
        !publication.outputs.some((o) => o.id === coverage.assessedScopeArtifact) ||
        !publication.outputs.some((o) => o.id === coverage.limitationsArtifact)
      ) {
        complete = false;
        break;
      }
      const scope = await read(coverage.assessedScopeArtifact),
        limits = await read(coverage.limitationsArtifact);
      if (
        scope.schema !== 'sentinel-coverage-scope/draft-1' ||
        scope.checkId !== checkId ||
        scope.scopeKind !== 'repository' ||
        scope.scopeId !== sourceId ||
        scope.scanned !== true ||
        limits.schema !== 'sentinel-coverage-limitations/draft-1' ||
        limits.checkId !== checkId ||
        limits.skipped?.length !== 0 ||
        limits.unresolved?.length !== 0
      ) {
        complete = false;
        break;
      }
    }
    if (complete) {
      store.assertHeld();
      if (
        store.ledger.getRun(runId)?.planRevision !== current.plan.revision ||
        canonicalDigest(store.ledger.getPublication(unit)) !== canonicalDigest(publication)
      )
        return fail();
      return;
    }
  }
  return fail();
}
