// Canonical current-tree secret scanning. The existing repository scope includes every captured file kind;
// per-entry details retain the reviewed withheld-location evidence. No captured name leaves normalized records.
import type {
  CheckDriver,
  DriverContext,
  VerifiedAttempt,
  PreparedJob,
  NormalizedOutcome,
} from '../../execution/check-drivers.js';
import { createAdapterRegistry } from '../../execution/registry.js';
import { canonicalJsonBytes } from '../../store/objects.js';
import { deepFreeze } from '../../kernel/freeze.js';
import { resolveWithheldLocation } from '../../snapshot/locations.js';
import { GITLEAKS_ADAPTER, GITLEAKS_ENGINE } from '../gitleaks/adapter.js';
import { buildSecretsJob, type SecretsJob, type SecretsSnapshot } from '../gitleaks/job.js';
import { normalizeSecretsRun, entryScope } from '../gitleaks/normalize.js';
import { DriverError, sha256 } from './common.js';

/** The one rule the secrets driver runs: the shipped current-tree rule at its exact definition digest. */
export const GITLEAKS_SUPPORTED_RULES = Object.freeze([
  Object.freeze({
    familyId: 'sentinel.secrets.current-tree',
    revision: 1,
    definitionDigest: 'sha256:53f40d31e80b38893280413db4f103ddd7411a798d893a435af4dcfde37e0d89',
  }),
]);
/** The secrets adapter's registry definition with aggregate coverage: one scan answers for every captured file. */
export const GITLEAKS_DRIVER_DEFINITION = Object.freeze({ ...GITLEAKS_ADAPTER, coverage: 'aggregate' as const });
const invalid = (): never => {
  throw new DriverError(
    'sentinel.drivers.contextInvalid',
    'the secret scan does not match its admitted captured scope',
  );
};
const binding = (ctx: DriverContext) => ({
  plan: ctx.plan.digest,
  snapshot: ctx.plan.pins.snapshotId,
  unit: { id: ctx.unit.id, revision: ctx.unit.revision, inputFingerprint: ctx.unit.inputFingerprint },
  checks: ctx.checks.map((c) => ({ id: c.id, familyId: c.familyId, revision: c.ruleRevision, scope: c.scopeId })),
  inputs: ctx.unit.inputs,
});
interface Job {
  schema: 'sentinel-production-secrets-job/draft-1';
  binding: ReturnType<typeof binding>;
  job: SecretsJob;
  jobDigest: string;
}

/** The snapshot comes only from openSnapshot of the admitted run, never a request body or neighboring file. */
export function gitleaksDriver(captured?: SecretsSnapshot): CheckDriver {
  const snapshot = captured ? deepFreeze(structuredClone(captured)) : undefined;
  const implementationDigest = createAdapterRegistry([GITLEAKS_DRIVER_DEFINITION]).get(GITLEAKS_ADAPTER.id).digest;
  const check = (ctx: DriverContext) => {
    if (
      !snapshot ||
      snapshot.id !== ctx.plan.pins.snapshotId ||
      ctx.unit.sourceId === null ||
      ctx.unit.adapterId !== GITLEAKS_ADAPTER.id
    )
      return invalid();
    if (
      !ctx.checks.length ||
      ctx.checks.some(
        (c) => c.scopeKind !== 'repository' || c.scopeId !== ctx.unit.sourceId || c.sourceId !== ctx.unit.sourceId,
      )
    )
      return invalid();
    for (const c of ctx.checks) {
      const supported = GITLEAKS_SUPPORTED_RULES.find(
        (r) => r.familyId === c.familyId && r.revision === c.ruleRevision,
      );
      const pin = ctx.plan.pins.rules.find((r) => r.familyId === c.familyId && r.revision === c.ruleRevision);
      const rule = ctx.rules.find((r) => r.rule.familyId === c.familyId && r.rule.revision === c.ruleRevision);
      if (
        !supported ||
        pin?.adapterId !== GITLEAKS_ADAPTER.id ||
        pin.definitionDigest !== supported.definitionDigest ||
        !rule ||
        rule.rule.definitionDigest !== pin.definitionDigest ||
        rule.rule.packDigest !== pin.packDigest
      )
        return invalid();
      for (const file of rule.files) if (sha256(file.bytes) !== file.digest) return invalid();
    }
    const tools = ctx.tools.filter((t) => t.adapterId === GITLEAKS_ADAPTER.id);
    if (tools.length !== 1 || tools[0]!.artifactDigest !== GITLEAKS_ENGINE.image.split('@')[1]) return invalid();
    const entries = snapshot.entries.flatMap((entry, index) =>
      entry.kind === 'file' && entry.disposition === 'included' && entry.sourceId === ctx.unit.sourceId
        ? [{ entry, index }]
        : [],
    );
    // Repository coverage is about the complete captured source, not an arbitrary subset chosen by a caller.
    if (entries.length !== ctx.unit.inputs.length) return invalid();
    const targets = ctx.unit.inputs.map((input) => {
      const entry = entries.find(
        (e) =>
          e.entry.relativePath === input.relativePath &&
          e.entry.content === input.content &&
          e.entry.sourceId === input.sourceId,
      );
      const sealed = ctx.inputs.find((i) => i.id === input.content);
      if (
        !entry ||
        input.sourceId !== ctx.unit.sourceId ||
        !sealed ||
        !ctx.inputScopes.some((i) => i.input === input.content && i.scopes.includes(ctx.unit.sourceId!))
      )
        return invalid();
      return { entry: entry.index, path: sealed.path };
    });
    if (new Set(targets.map((t) => t.entry)).size !== targets.length) return invalid();
    return { snapshot, targets, sourceId: ctx.unit.sourceId };
  };
  return Object.freeze({
    adapterId: GITLEAKS_ADAPTER.id,
    implementationDigest,
    supportedRules: () => GITLEAKS_SUPPORTED_RULES,
    async prepare(ctx: DriverContext): Promise<PreparedJob> {
      ctx.signal.throwIfAborted();
      const resolved = check(ctx);
      const built = buildSecretsJob(resolved, ctx.workDir);
      const source = new Set(ctx.unit.inputs.map((i) => i.content));
      const job: Job = {
        schema: 'sentinel-production-secrets-job/draft-1',
        binding: binding(ctx),
        job: built.job,
        jobDigest: built.jobDigest,
      };
      return deepFreeze({
        job,
        auxiliary: built.inputs
          .filter((i) => !source.has(i.id))
          .map((i) => ({ path: i.path, role: i.id === built.jobDigest ? 'job' : 'worker' })),
      });
    },
    async normalize(ctx: DriverContext, verified: VerifiedAttempt): Promise<NormalizedOutcome> {
      ctx.signal.throwIfAborted();
      const resolved = check(ctx);
      const job = verified.job as Job;
      if (
        job?.schema !== 'sentinel-production-secrets-job/draft-1' ||
        !canonicalJsonBytes(job.binding).equals(canonicalJsonBytes(binding(ctx)))
      )
        return invalid();
      const bytes = canonicalJsonBytes(job);
      const sealed = verified.sealed(sha256(bytes));
      if (
        !sealed ||
        !Buffer.from(sealed).equals(bytes) ||
        !Object.isFrozen(verified.outcome) ||
        verified.outcome.result !== verified.result
      )
        return invalid();
      const run = normalizeSecretsRun({
        job: job.job,
        jobDigest: job.jobDigest,
        outcome: verified.outcome as never,
        observedAt: new Date().toISOString(),
        outputBytes: verified.output,
        targetBytes: verified.sealed,
      });
      const assigned = ctx.checks.map((c) => ({ id: c.id, familyId: c.familyId, revision: c.ruleRevision }));
      const common = {
        adapter: GITLEAKS_ADAPTER.id,
        runId: ctx.plan.runId,
        snapshotId: resolved.snapshot.id,
        work: { id: ctx.unit.id, revision: ctx.unit.revision },
        attemptId: verified.result.attemptId,
      };
      const observations = run.observations.map((observation) => {
        if (
          observation.snapshotId !== resolved.snapshot.id ||
          observation.evidence.some(
            (e) =>
              !('location' in e) ||
              e.location !== 'withheld' ||
              !resolved.targets.some((t) => t.entry === e.entry) ||
              !resolveWithheldLocation(resolved.snapshot, e).ok,
          )
        )
          return invalid();
        return {
          schema: 'sentinel-driver-finding/draft-1',
          privacy: 'source-derived' as const,
          value: { ...observation, ...common, kind: 'secret', assignedChecks: assigned },
        };
      });
      const report = {
        schema: 'sentinel-driver-report/draft-1',
        privacy: 'source-derived' as const,
        value: {
          ...common,
          engine: `${GITLEAKS_ENGINE.name} ${GITLEAKS_ENGINE.version}`,
          status: run.status,
          platform: run.platform,
          audit: run.audit,
          ...(run.reasonCode ? { reasonCode: run.reasonCode } : {}),
          scanned: run.scanned,
          skipped: run.skipped,
          expectedEntries: resolved.targets.map((t) => entryScope(resolved.sourceId, t.entry)),
          actualReadSet: run.scanned,
          findings: observations.length,
        },
      };
      const ran = run.status !== 'error' && run.scanned.length > 0;
      const coverage = sha256(canonicalJsonBytes(report.value));
      return {
        records: [report, ...observations],
        coverage: {
          granularity: 'aggregate',
          coveredChecks: ran ? ctx.checks.map((c) => ({ checkId: c.id, coverage })) : [],
          scannedSet: ran ? [resolved.sourceId] : [],
          actualReadSet: ran ? [resolved.sourceId] : [],
          skipped: [...run.skipped],
          unresolvedFrontiers: [],
        },
      };
    },
  });
}
