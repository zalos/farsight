// The production driver for the Trivy misconfiguration adapter (Trivy 0.76.1 `config`, PR 13). It runs only the
// shipped original `sentinel.iac.misconfiguration` rule, at its exact definition digest, over the unit's captured
// infrastructure files, with the owner-acquired trivy-checks bundle the plan pins (`trivy-checks`). Without that
// bundle nothing runs and every file is not run, never covered by the checks compiled into the binary.
import { TRIVY_ADAPTER, TRIVY_CHECKS_BUNDLE, TRIVY_ENGINE } from '../trivy/adapter.js';
import type { ChecksBundle } from '../trivy/bundle.js';
import { buildTrivyJob, type TrivyJob } from '../trivy/job.js';
import { normalizeTrivyRun, notRunResult } from '../trivy/normalize.js';
import { bindRules, DriverError, fileScope, nothingToRun, ruleFileBytes, ResultFacts } from './common.js';
import { assertToolPin } from './pattern.js';
import type { CheckDriver, DriverNormalize, DriverRecord, SupportedRule } from './types.js';

export const TRIVY_SUPPORTED_RULES: readonly SupportedRule[] = Object.freeze([
  Object.freeze({
    familyId: 'sentinel.iac.misconfiguration',
    revision: 1,
    definitionDigest: 'sha256:cc93ba1ee479a27efb8322be2335e6d1cd3cb6d04cb6b84b10d7ef9c45ec7c97',
  }),
]);
/** The plan's database id for the pinned checks bundle. */
export const TRIVY_CHECKS_DATABASE_ID = 'trivy-checks';

interface TrivyContext {
  readonly schema: 'sentinel-driver-trivy/draft-1';
  readonly sourceId: string;
  readonly job: TrivyJob;
  readonly jobDigest: string;
  readonly notRun: Readonly<Record<string, string>>;
}

/** An admitted bundle record, accepted only when it describes exactly the pinned bundle. */
function bundleOf(record: unknown, pin: { databaseId: string; snapshotDigest: string }): ChecksBundle {
  const b = record as ChecksBundle;
  if (
    b?.schema !== 'sentinel-trivy-checks/draft-1' ||
    pin.databaseId !== TRIVY_CHECKS_DATABASE_ID ||
    pin.snapshotDigest !== TRIVY_CHECKS_BUNDLE.layer ||
    b.name !== TRIVY_CHECKS_BUNDLE.name ||
    b.commit !== TRIVY_CHECKS_BUNDLE.commit ||
    b.repository !== TRIVY_CHECKS_BUNDLE.repository ||
    b.created !== TRIVY_CHECKS_BUNDLE.created ||
    typeof b.acquiredAt !== 'string' ||
    b.layer !== TRIVY_CHECKS_BUNDLE.layer ||
    b.manifest !== TRIVY_CHECKS_BUNDLE.manifest ||
    b.version !== TRIVY_CHECKS_BUNDLE.version ||
    b.size !== TRIVY_CHECKS_BUNDLE.size
  ) {
    throw new DriverError(
      'sentinel.drivers.contextInvalid',
      `${pin.databaseId}: the bundle record does not describe the pinned checks bundle`,
    );
  }
  return Object.freeze({ ...b });
}

export function trivyDriver(): CheckDriver {
  return {
    adapterId: TRIVY_ADAPTER.id,
    supportedRules: TRIVY_SUPPORTED_RULES,
    async prepare(ctx) {
      assertToolPin(ctx, TRIVY_ADAPTER.id, TRIVY_ENGINE.image);
      const notRun: Record<string, string> = {};
      const { runnable, refused } = bindRules(TRIVY_ADAPTER.id, TRIVY_SUPPORTED_RULES, ctx.rules, ctx.checks);
      for (const f of refused) notRun[f] = 'sentinel.drivers.ruleUnsupported';
      for (const rule of runnable) ruleFileBytes(ctx.rules, rule);
      for (const c of ctx.checks)
        if (c.scopeKind !== 'infrastructure-config') notRun[c.familyId] = 'sentinel.drivers.scopeUnsupported';
      const sourceId = ctx.unit.sourceId;
      if (!runnable.some((r) => !notRun[r.familyId]) || !ctx.inputs.length || sourceId === null) {
        return nothingToRun(TRIVY_ADAPTER.id, 'per-file', ctx.checks, notRun, 'sentinel.drivers.nothingApplicable');
      }
      const held = ctx.databases.filter((d) => d.pin.databaseId === TRIVY_CHECKS_DATABASE_ID);
      const bundle = held.length ? { bundle: bundleOf(held[0]!.record, held[0]!.pin), path: held[0]!.path } : null;
      const targets = ctx.inputs.map((i) => ({
        relativePath: i.input.relativePath,
        artifact: i.input.content,
        path: i.path,
      }));
      const built = buildTrivyJob(targets, bundle, ctx.scratch);
      if (!built.jobDigest) {
        // No bundle, or nothing the engine reads: each file's own reason (bundle-missing, not configuration, ...).
        const rows = new Map(
          notRunResult(built.job, TRIVY_ADAPTER.id).coverage.map((r) => [
            fileScope({ sourceId, relativePath: r.relativePath }),
            r.reasonCode as string,
          ]),
        );
        const facts = new ResultFacts();
        for (const c of ctx.checks)
          facts.notRun(c, notRun[c.familyId] ?? rows.get(c.scopeId) ?? 'sentinel.drivers.nothingApplicable');
        const report: DriverRecord = {
          schema: 'sentinel-driver-report/draft-1',
          value: { adapter: TRIVY_ADAPTER.id, ran: false, notRun, unsent: built.job.unsent, bundle: bundle !== null },
        };
        return { artifacts: [], context: null, skipRun: { result: facts.facts('per-file', report, []) } };
      }
      const captured = new Set(targets.map((t) => t.artifact));
      const context: TrivyContext = {
        schema: 'sentinel-driver-trivy/draft-1',
        sourceId,
        job: built.job,
        jobDigest: built.jobDigest,
        notRun,
      };
      return {
        artifacts: built.inputs
          .filter((i) => !captured.has(i.id))
          .map((i) => ({
            id: i.id,
            path: i.path,
            role:
              i.id === TRIVY_CHECKS_BUNDLE.layer
                ? ('bundle' as const)
                : i.id === built.jobDigest
                  ? ('job' as const)
                  : ('worker' as const),
          })),
        context: JSON.parse(JSON.stringify(context)),
      };
    },
    normalize(ctx: DriverNormalize) {
      const c = ctx.context as TrivyContext;
      if (c?.schema !== 'sentinel-driver-trivy/draft-1')
        throw new DriverError('sentinel.drivers.contextInvalid', 'not a Trivy driver context');
      const run = normalizeTrivyRun({
        job: c.job,
        jobDigest: c.jobDigest,
        outcome: ctx.outcome as never,
        outputBytes: ctx.output,
        targetBytes: ctx.sealed,
      });
      const rows = new Map(
        run.coverage.map((r) => [fileScope({ sourceId: c.sourceId, relativePath: r.relativePath }), r]),
      );
      const facts = new ResultFacts();
      for (const check of ctx.checks) {
        const skip = c.notRun[check.familyId];
        if (skip) {
          facts.notRun(check, skip);
          continue;
        }
        const row = rows.get(check.scopeId);
        if (!row) facts.notRun(check, 'sentinel.drivers.notReported');
        else if (row.status === 'complete') facts.ran(check);
        else if (row.status === 'partial') facts.ran(check, row.limitations);
        // Not recognized as configuration, not reported, unparseable, no bundle loaded: never run.
        else facts.notRun(check, row.reasonCode);
      }
      // A finding against a Terraform module folder keeps its folder path and no artifact; it limits no file's coverage.
      const findings: DriverRecord[] = run.findings.map((f) => ({
        schema: 'sentinel-driver-finding/draft-1',
        value: { adapter: run.adapter, kind: 'misconfiguration', ...f },
      }));
      const report: DriverRecord = {
        schema: 'sentinel-driver-report/draft-1',
        value: {
          adapter: run.adapter,
          engine: run.engine,
          checks: run.checks,
          platform: run.platform,
          attempt: run.attempt,
          engineExit: run.engineExit,
          engineFailure: run.engineFailure,
          bundle: run.bundle,
          coverage: run.coverage,
          refused: run.refused,
          notRun: c.notRun,
          findings: findings.length,
        },
      };
      return {
        result: facts.result(ctx.outcome.result as never, 'per-file', report, findings),
        records: [report, ...findings],
      };
    },
  };
}
