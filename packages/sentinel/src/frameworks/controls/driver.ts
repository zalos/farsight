// The framework inspection's trusted check driver (ADR 44): binds the plan's repository-scoped inspection checks to
// the built-in `framework-controls` child adapter. It reads the coordinator's retained parser evidence (`reads.analysis`)
// and never builds its own: the job names the retained snapshot manifest, parser result, index and artifact by id, and
// their original bytes reach the worker only as the coordinator's `retainedAuxiliary` files. The unit's source inputs
// stay exactly the plan's (every captured file of the source, which a repository check binds).
//
// The adapter's module is the generated closure entry (closure.ts), whose manifest also pins this driver and what it
// imports, so the registered implementation digest the driver is bound to covers the worker, the four libraries, the
// fact mapping, their packages and this file. Normalization reads the worker's one output, checks it against the job
// and the libraries' envelope contract, derives coverage with `inspect()` over the parser's route and page surfaces,
// and publishes one inspection report and each library's control-fact envelopes. Nothing here is a finding.
import type { ScopedReason } from '../../contracts/common.js';
import { createAdapterRegistry, type AdapterLimits, type BuiltInAdapterDefinition } from '../../execution/registry.js';
import {
  retainedAuxiliary,
  type CheckDriver,
  type DriverContext,
  type NormalizedOutcome,
  type PreparedJob,
  type VerifiedAttempt,
} from '../../execution/check-drivers.js';
import { surfacesFromIndex } from '../../planner/planner.js';
import { canonicalJsonBytes } from '../../store/objects.js';
import { deepFreeze } from '../../policy/immutable.js';
import { validateEnvelope } from '../../validate.js';
import { DriverError, sha256 } from '../../adapters/drivers/common.js';
import { writeBuiltinClosureEntry } from './closure.js';
import {
  CONTROL_FAMILIES,
  FRAMEWORKS,
  INSPECTED_PROPERTIES,
  inspect,
  inspectionReport,
  libraryPresent,
  type FrameworkName,
  type LibraryOutcome,
} from './facts.js';
import {
  CONTROLS_JOB_SCHEMA,
  CONTROLS_OUTPUT_MEDIA,
  CONTROLS_OUTPUT_SCHEMA,
  FRAMEWORK_CONTROLS_ADAPTER_ID,
  CONTROLS_SUPPORTED_RULES,
  CONTROLS_REPORT_SCHEMA,
  CONTROLS_ENVELOPE_SCHEMA,
  CONTROLS_MODELED_VERSIONS,
  type ControlsJob,
} from './definitions.js';
export {
  CONTROLS_SUPPORTED_RULES,
  CONTROLS_REPORT_SCHEMA,
  CONTROLS_ENVELOPE_SCHEMA,
  CONTROLS_MODELED_VERSIONS,
} from './definitions.js';

const invalid = (message: string): never => {
  throw new DriverError('sentinel.drivers.contextInvalid', message);
};

/** The admitted unit the job belongs to; normalization refuses a job bound to anything else. */
const bindingOf = (ctx: DriverContext) => ({
  plan: ctx.plan.digest,
  snapshot: ctx.plan.pins.snapshotId,
  unit: { id: ctx.unit.id, revision: ctx.unit.revision, inputFingerprint: ctx.unit.inputFingerprint },
  checks: ctx.checks.map((c) => ({ id: c.id, familyId: c.familyId, revision: c.ruleRevision, scope: c.scopeId })),
});

/** The retained evidence the coordinator verified for exactly this unit's source and snapshot. */
function analysisOf(ctx: DriverContext) {
  const a = ctx.analysis;
  if (!a) return invalid('the inspection reads the retained parser evidence, which the coordinator did not provide');
  if (ctx.unit.stage !== 'check' || a.sourceId !== ctx.unit.sourceId || a.snapshotId !== ctx.plan.pins.snapshotId)
    invalid("the retained evidence is not this unit's source and snapshot");
  return a;
}

/** Rules the unit's checks name must be this pack's, at their pinned and shipped definitions. */
function assertRules(ctx: DriverContext) {
  for (const c of ctx.checks) {
    const pin = ctx.plan.pins.rules.find((r) => r.familyId === c.familyId && r.revision === c.ruleRevision);
    const resolved = ctx.rules.find((r) => r.rule.familyId === c.familyId)?.rule;
    const shipped = CONTROLS_SUPPORTED_RULES.find((r) => r.familyId === c.familyId && r.revision === c.ruleRevision);
    if (
      !pin ||
      !shipped ||
      pin.definitionDigest !== shipped.definitionDigest ||
      pin.adapterId !== FRAMEWORK_CONTROLS_ADAPTER_ID ||
      (resolved && resolved.definitionDigest !== pin.definitionDigest)
    )
      invalid(`${c.familyId}: not this adapter's shipped rule at its pinned definition`);
  }
}

/** The worker's output, checked against the sealed job and the libraries' envelope contract. */
function outputOf(ctx: DriverContext, verified: VerifiedAttempt, jobId: string): LibraryOutcome[] {
  const outs = verified.outputs.filter((o) => o.mediaType === CONTROLS_OUTPUT_MEDIA);
  if (outs.length !== 1 || verified.outputs.length !== 1)
    invalid('the worker published other than one inspection document');
  let doc: any;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(verified.output(outs[0]!.id)));
  } catch {
    return invalid('the inspection document is not JSON');
  }
  if (doc?.schema !== CONTROLS_OUTPUT_SCHEMA || doc.job !== jobId || !Array.isArray(doc.libraries))
    invalid("the inspection document is not this job's");
  if (
    doc.libraries.length !== FRAMEWORKS.length ||
    doc.libraries.some((l: any, i: number) => l?.framework !== FRAMEWORKS[i])
  )
    invalid('the inspection document does not name each library once, in order');
  for (const l of doc.libraries as any[]) {
    if (
      !Array.isArray(l.envelopes) ||
      (l.refused !== undefined && (l.refused !== 'sentinel.controls.libraryRefused' || l.envelopes.length))
    )
      invalid('a library outcome is malformed');
    for (const e of l.envelopes) {
      if (!validateEnvelope('controls', e).ok || e.snapshotId !== ctx.plan.pins.snapshotId)
        invalid("a control-fact envelope is not this snapshot's");
    }
    if (
      l.frontiers !== undefined &&
      (!Array.isArray(l.frontiers) ||
        l.frontiers.some((f: any) => typeof f?.scopeId !== 'string' || typeof f?.reasonCode !== 'string'))
    )
      invalid('a library frontier is malformed');
  }
  return doc.libraries;
}

export interface FrameworkControlsAdapter {
  readonly definition: BuiltInAdapterDefinition;
  readonly driver: CheckDriver;
  readonly closureDigest: string;
}

/**
 * The adapter definition and its driver. `entryDir` is an owner-private folder for the generated closure entry; the
 * definition's module is that entry, so the implementation digest covers the worker's and this driver's closure.
 */
export function frameworkControlsAdapter(options: {
  readonly entryDir: string;
  readonly limits?: Partial<AdapterLimits>;
}): FrameworkControlsAdapter {
  const entry = writeBuiltinClosureEntry(options.entryDir, FRAMEWORK_CONTROLS_ADAPTER_ID);
  const definition: BuiltInAdapterDefinition = Object.freeze({
    id: FRAMEWORK_CONTROLS_ADAPTER_ID,
    version: '0.1.0',
    kind: 'built-in',
    isolation: 'child',
    module: entry.module,
    coverage: 'aggregate',
    ...(options.limits ? { limits: { ...options.limits } } : {}),
  });
  const implementationDigest = createAdapterRegistry([definition]).get(definition.id).digest;
  const driver: CheckDriver = Object.freeze({
    reads: Object.freeze({ analysis: true as const }),
    adapterId: FRAMEWORK_CONTROLS_ADAPTER_ID,
    implementationDigest,
    supportedRules: () => CONTROLS_SUPPORTED_RULES,
    async prepare(ctx: DriverContext): Promise<PreparedJob> {
      ctx.signal.throwIfAborted();
      const a = analysisOf(ctx);
      assertRules(ctx);
      const job: ControlsJob & { binding: ReturnType<typeof bindingOf> } = {
        schema: CONTROLS_JOB_SCHEMA,
        snapshotId: a.snapshotId,
        sourceId: a.sourceId,
        snapshot: a.manifest,
        analysis: { artifact: a.artifact.id, result: a.result.id, index: a.index.id },
        properties: [...INSPECTED_PROPERTIES],
        environment: { activeProfiles: null },
        binding: bindingOf(ctx),
      };
      return deepFreeze({ job, auxiliary: retainedAuxiliary(ctx) });
    },
    async normalize(ctx: DriverContext, verified: VerifiedAttempt): Promise<NormalizedOutcome> {
      ctx.signal.throwIfAborted();
      const a = analysisOf(ctx);
      const job = verified.job as any;
      if (
        job?.schema !== CONTROLS_JOB_SCHEMA ||
        !canonicalJsonBytes(job.binding).equals(canonicalJsonBytes(bindingOf(ctx))) ||
        job.snapshot !== a.manifest ||
        job.analysis?.artifact !== a.artifact.id ||
        job.analysis?.result !== a.result.id ||
        job.analysis?.index !== a.index.id
      ) {
        invalid('the job belongs to another admitted unit or other retained evidence');
      }
      const jobBytes = canonicalJsonBytes(job);
      const jobId = sha256(jobBytes);
      if (verified.outcome.invocation.record.job !== jobId || verified.binding?.derived?.job !== jobId)
        invalid('the invocation and prepared binding must name the exact job');
      const sealedJob = verified.sealed(jobId);
      if (!sealedJob || !Buffer.from(sealedJob).equals(jobBytes)) invalid('the recorded job is not its sealed bytes');
      if (!Object.isFrozen(verified.outcome) || verified.outcome.result !== verified.result)
        invalid('normalization needs the exact frozen supervisor outcome');
      const libraries = outputOf(ctx, verified, jobId);

      // Repository checks only: a check on any other scope is not this inspection's.
      const repository = ctx.checks.filter(
        (c) => c.scopeKind === 'repository' && c.scopeId === ctx.unit.sourceId && CONTROL_FAMILIES[c.familyId],
      );
      const surfaces = surfacesFromIndex(a.index.value).map((s) => s.nodeId);
      const r = inspect(
        repository.map((c) => ({ id: c.id, familyId: c.familyId, scopeId: c.scopeId })),
        libraries,
        surfaces,
        '',
      );
      // No library recognised a framework it models: routes served another way are not inspected, so nothing is
      // complete, even over an empty extent.
      const recognised = libraries.some(libraryPresent);
      const extra: ScopedReason[] = [];
      for (const c of ctx.checks) {
        if (!repository.includes(c))
          extra.push({ scopeId: c.scopeId, reasonCode: 'sentinel.drivers.scopeUnsupported' });
        else if (!recognised && r.coverage.coveredChecks.some((x) => x.checkId === c.id))
          extra.push({ scopeId: c.scopeId, reasonCode: 'sentinel.controls.frameworkNotRecognized' });
      }
      const checks = r.checks.map((c) =>
        !recognised && c.state === 'complete'
          ? { ...c, state: 'partial' as const, reasons: ['sentinel.controls.frameworkNotRecognized'] }
          : c,
      );
      const answered = (l: LibraryOutcome) =>
        [...new Set(l.envelopes.flatMap((e) => e.facts.map((f) => f.property)))].sort();
      const scope = Object.fromEntries(
        FRAMEWORKS.map((f) => [
          f,
          { versions: CONTROLS_MODELED_VERSIONS[f], properties: answered(libraries.find((l) => l.framework === f)!) },
        ]),
      ) as Record<FrameworkName, { versions: Record<string, string>; properties: string[] }>;
      const report = {
        ...inspectionReport(
          {
            adapter: FRAMEWORK_CONTROLS_ADAPTER_ID,
            runId: ctx.plan.runId,
            snapshotId: ctx.plan.pins.snapshotId,
            work: { id: ctx.unit.id, revision: ctx.unit.revision },
            attemptId: verified.result.attemptId,
            sourceId: a.sourceId,
            analysis: { result: a.result.id, index: a.index.id, artifact: a.artifact.id, manifest: a.manifest },
            extent: surfaces.length,
            recognised,
          },
          libraries,
          r.rows,
          checks,
          scope,
        ),
        findings: 0,
      };
      const reportId = sha256(canonicalJsonBytes(report));
      const sort = <T>(xs: Iterable<T>, key: (x: T) => string) =>
        [...xs].sort((p, q) => (key(p) < key(q) ? -1 : key(p) > key(q) ? 1 : 0));
      const skipped = new Map([...r.coverage.skipped, ...extra].map((x) => [`${x.scopeId}\u0000${x.reasonCode}`, x]));
      const envelopes = libraries.flatMap((l) =>
        l.envelopes.map((e) => ({ value: e, schema: CONTROLS_ENVELOPE_SCHEMA, privacy: 'source-derived' as const })),
      );
      return {
        coverage: {
          granularity: 'aggregate',
          coveredChecks: r.coverage.coveredChecks.map((c) => ({ checkId: c.checkId, coverage: reportId })),
          scannedSet: r.coverage.scannedSet,
          actualReadSet: r.coverage.scannedSet,
          skipped: sort(skipped.values(), (x) => `${x.scopeId}\u0000${x.reasonCode}`),
          unresolvedFrontiers: r.coverage.unresolvedFrontiers,
        },
        records: [{ value: report, schema: CONTROLS_REPORT_SCHEMA, privacy: 'source-derived' }, ...envelopes],
      };
    },
  });
  return Object.freeze({ definition, driver, closureDigest: entry.closureDigest });
}
