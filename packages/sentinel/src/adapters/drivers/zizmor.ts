// The production driver for the zizmor adapter (zizmor 1.31.1, PR 13). It runs only the shipped original
// `sentinel.ci.workflow-audit` rule, at its exact definition digest, offline, over the unit's captured CI files.
// Coverage is per file and never complete for a workflow or action: the audits that need the GitHub API are skipped
// offline and stay limitations.
import { ZIZMOR_ADAPTER, ZIZMOR_ENGINE } from '../zizmor/adapter.js';
import { buildZizmorJob, type ZizmorJob } from '../zizmor/job.js';
import { normalizeZizmorRun } from '../zizmor/normalize.js';
import { bindRules, DriverError, fileScope, nothingToRun, ruleFileBytes, ResultFacts } from './common.js';
import { assertToolPin } from './pattern.js';
import type { CheckDriver, DriverNormalize, DriverRecord, SupportedRule } from './types.js';

export const ZIZMOR_SUPPORTED_RULES: readonly SupportedRule[] = Object.freeze([
  Object.freeze({
    familyId: 'sentinel.ci.workflow-audit',
    revision: 1,
    definitionDigest: 'sha256:97cf24da47d4c490a05b029c5aa692e9037777f74728f0704433ae7061d4e8dc',
  }),
]);

interface ZizmorContext {
  readonly schema: 'sentinel-driver-zizmor/draft-1';
  readonly sourceId: string;
  readonly job: ZizmorJob;
  readonly jobDigest: string;
  readonly notRun: Readonly<Record<string, string>>;
}

const UNSENT_REASON: Record<string, string> = {
  'not-ci-configuration': 'sentinel.zizmor.coverage.notCiConfiguration',
  'path-unsupported': 'sentinel.zizmor.coverage.pathUnsupported',
  'too-large': 'sentinel.zizmor.coverage.tooLarge',
  'too-many': 'sentinel.zizmor.coverage.tooMany',
};

export function zizmorDriver(): CheckDriver {
  return {
    adapterId: ZIZMOR_ADAPTER.id,
    supportedRules: ZIZMOR_SUPPORTED_RULES,
    async prepare(ctx) {
      assertToolPin(ctx, ZIZMOR_ADAPTER.id, ZIZMOR_ENGINE.image);
      const notRun: Record<string, string> = {};
      const { runnable, refused } = bindRules(ZIZMOR_ADAPTER.id, ZIZMOR_SUPPORTED_RULES, ctx.rules, ctx.checks);
      for (const f of refused) notRun[f] = 'sentinel.drivers.ruleUnsupported';
      for (const rule of runnable) ruleFileBytes(ctx.rules, rule);
      for (const c of ctx.checks)
        if (c.scopeKind !== 'ci-config') notRun[c.familyId] = 'sentinel.drivers.scopeUnsupported';
      const sourceId = ctx.unit.sourceId;
      if (!runnable.some((r) => !notRun[r.familyId]) || !ctx.inputs.length || sourceId === null) {
        return nothingToRun(ZIZMOR_ADAPTER.id, 'per-file', ctx.checks, notRun, 'sentinel.drivers.nothingApplicable');
      }
      const targets = ctx.inputs.map((i) => ({
        relativePath: i.input.relativePath,
        artifact: i.input.content,
        path: i.path,
      }));
      const built = buildZizmorJob(targets, ctx.scratch);
      if (!built.jobDigest) {
        const why = new Map(
          built.job.unsent.map((u) => [
            fileScope({ sourceId, relativePath: u.relativePath }),
            UNSENT_REASON[u.reason]!,
          ]),
        );
        const facts = new ResultFacts();
        for (const c of ctx.checks)
          facts.notRun(c, notRun[c.familyId] ?? why.get(c.scopeId) ?? 'sentinel.drivers.nothingApplicable');
        const report: DriverRecord = {
          schema: 'sentinel-driver-report/draft-1',
          value: { adapter: ZIZMOR_ADAPTER.id, ran: false, notRun, unsent: built.job.unsent },
        };
        return { artifacts: [], context: null, skipRun: { result: facts.facts('per-file', report, []) } };
      }
      const captured = new Set(targets.map((t) => t.artifact));
      const context: ZizmorContext = {
        schema: 'sentinel-driver-zizmor/draft-1',
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
            role: i.id === built.jobDigest ? ('job' as const) : ('worker' as const),
          })),
        context: JSON.parse(JSON.stringify(context)),
      };
    },
    normalize(ctx: DriverNormalize) {
      const c = ctx.context as ZizmorContext;
      if (c?.schema !== 'sentinel-driver-zizmor/draft-1')
        throw new DriverError('sentinel.drivers.contextInvalid', 'not a zizmor driver context');
      const run = normalizeZizmorRun({
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
        else facts.notRun(check, row.reasonCode);
      }
      const findings: DriverRecord[] = run.findings.map((f) => ({
        schema: 'sentinel-driver-finding/draft-1',
        value: { adapter: run.adapter, kind: 'ci-audit', ...f },
      }));
      const report: DriverRecord = {
        schema: 'sentinel-driver-report/draft-1',
        value: {
          adapter: run.adapter,
          engine: run.engine,
          platform: run.platform,
          attempt: run.attempt,
          engineExit: run.engineExit,
          engineFailure: run.engineFailure,
          skippedAudits: run.skippedAudits,
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
