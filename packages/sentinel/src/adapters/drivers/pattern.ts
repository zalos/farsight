// The production driver for the pattern adapter (Semgrep 1.181.0, PR 10). It runs only the shipped original
// `sentinel-pattern` rules, at the exact definition digests below (pinned by a test against the pack's bytes), over
// the unit's captured source files; coverage is per file per rule, from the engine's own per-rule timings.
import { PATTERN_ADAPTER, PATTERN_ENGINE } from '../pattern/adapter.js';
import { buildPatternJob, type PatternJob, type PatternRule } from '../pattern/job.js';
import { normalizePatternRun } from '../pattern/normalize.js';
import { patternRulesFromResolved } from '../pattern/resolved.js';
import { bindRules, DriverError, fileScope, nothingToRun, ResultFacts, sha256 } from './common.js';
import type { CheckDriver, DriverNormalize, DriverPrepare, DriverRecord, SupportedRule } from './types.js';

/** The shipped `sentinel-pattern` pack's rules (rules/pattern), exactly. */
export const PATTERN_SUPPORTED_RULES: readonly SupportedRule[] = Object.freeze(
  [
    {
      familyId: 'sentinel.sql.concatenated-query-java',
      revision: 1,
      definitionDigest: 'sha256:195d3d38884eed273fa5348aa28a0497b1a9f9f470fdfc60f4c2a408da8003fb',
    },
    {
      familyId: 'sentinel.sql.concatenated-query-tsjs',
      revision: 1,
      definitionDigest: 'sha256:67ba6079878f243aa27c181e4f7716d869752653d70e1373dbfdd73e1e75660c',
    },
    {
      familyId: 'sentinel.sql.request-to-query-java',
      revision: 1,
      definitionDigest: 'sha256:18b7122fa792aaabbac92669255c4b887356e295793f228027e2c8dc14e1c19d',
    },
    {
      familyId: 'sentinel.sql.request-to-query-tsjs',
      revision: 1,
      definitionDigest: 'sha256:80f760ad32143e178cae9d5f1fd9f18939d13abbb5e2342fdca9b91631b6d0ff',
    },
  ].map((r) => Object.freeze(r)),
);

interface PatternContext {
  readonly schema: 'sentinel-driver-pattern/draft-1';
  readonly sourceId: string;
  readonly job: PatternJob;
  readonly jobDigest: string;
  readonly rules: readonly PatternRule[];
  /** Families whose checks never run here, with the reason. */
  readonly notRun: Readonly<Record<string, string>>;
}

/** The tool pin, when the plan names one for this adapter, must be the engine's image index. */
export function assertToolPin(ctx: DriverPrepare, adapterId: string, image: string): void {
  const digest = image.slice(image.indexOf('@') + 1);
  const pins = ctx.tools.filter((t) => t.adapterId === adapterId);
  if (pins.length !== 1 || pins[0]!.artifactDigest !== digest)
    throw new DriverError('sentinel.drivers.contextInvalid', `${adapterId}: the tool pin is not the engine's image`);
}

/**
 * The pattern check driver. Runs only {@link PATTERN_SUPPORTED_RULES} over the unit's captured source files and
 * covers per file per rule from the engine's own timings. Refuses, with a DriverError, a context whose tool pin is not
 * the pinned engine image or whose rule bytes are not the shipped ones; any other rule or scope is reported not run.
 */
export function patternDriver(): CheckDriver {
  return {
    adapterId: PATTERN_ADAPTER.id,
    supportedRules: PATTERN_SUPPORTED_RULES,
    async prepare(ctx) {
      assertToolPin(ctx, PATTERN_ADAPTER.id, PATTERN_ENGINE.image);
      const notRun: Record<string, string> = {};
      const { runnable, refused } = bindRules(PATTERN_ADAPTER.id, PATTERN_SUPPORTED_RULES, ctx.rules, ctx.checks);
      for (const f of refused) notRun[f] = 'sentinel.drivers.ruleUnsupported';
      for (const c of ctx.checks)
        if (c.scopeKind !== 'source-file') notRun[c.familyId] = 'sentinel.drivers.scopeUnsupported';
      const resolved = patternRulesFromResolved(
        runnable.filter((r) => !notRun[r.familyId]),
        ctx.rules.files,
        (d) => {
          const b = ctx.rules.bytesOf(d);
          if (!b || sha256(b) !== d)
            throw new DriverError('sentinel.drivers.ruleBytesInvalid', 'a pack file is not the bytes its digest names');
          return b;
        },
      );
      for (const u of resolved.unsupported) notRun[u.familyId] = u.reasonCode;
      const sourceId = ctx.unit.sourceId;
      const targets = ctx.inputs.map((i) => ({
        relativePath: i.input.relativePath,
        artifact: i.input.content,
        path: i.path,
      }));
      if (!resolved.rules.length || !targets.length || sourceId === null)
        return nothingToRun(
          PATTERN_ADAPTER.id,
          'per-file-per-rule',
          ctx.checks,
          notRun,
          'sentinel.drivers.nothingApplicable',
        );
      const built = buildPatternJob(resolved.rules, targets, ctx.scratch);
      const captured = new Set(targets.map((t) => t.artifact));
      const role = (id: string) =>
        id === built.jobDigest ? ('job' as const) : id === built.rulesDigest ? ('rules' as const) : ('worker' as const);
      const context: PatternContext = {
        schema: 'sentinel-driver-pattern/draft-1',
        sourceId,
        job: built.job,
        jobDigest: built.jobDigest,
        rules: resolved.rules,
        notRun,
      };
      return {
        artifacts: built.inputs
          .filter((i) => !captured.has(i.id))
          .map((i) => ({ id: i.id, path: i.path, role: role(i.id) })),
        context: JSON.parse(JSON.stringify(context)),
      };
    },
    normalize(ctx: DriverNormalize) {
      const c = ctx.context as PatternContext;
      if (c?.schema !== 'sentinel-driver-pattern/draft-1')
        throw new DriverError('sentinel.drivers.contextInvalid', 'not a pattern driver context');
      const run = normalizePatternRun({
        job: c.job,
        jobDigest: c.jobDigest,
        rules: c.rules,
        outcome: ctx.outcome as never,
        outputBytes: ctx.output,
        targetBytes: ctx.sealed,
      });
      const rows = new Map(
        run.coverage
          .filter((r) => r.familyId)
          .map((r) => [`${r.familyId}\u0000${fileScope({ sourceId: c.sourceId, relativePath: r.relativePath })}`, r]),
      );
      const facts = new ResultFacts();
      for (const check of ctx.checks) {
        const skip = c.notRun[check.familyId];
        if (skip) {
          facts.notRun(check, skip);
          continue;
        }
        const row = rows.get(`${check.familyId}\u0000${check.scopeId}`);
        if (!row) facts.notRun(check, 'sentinel.drivers.notReported');
        else if (row.status === 'complete') facts.ran(check);
        else if (row.status === 'partial') facts.ran(check, [row.reasonCode]);
        else facts.notRun(check, row.reasonCode);
      }
      const findings: DriverRecord[] = run.findings.map((f) => ({
        schema: 'sentinel-driver-finding/draft-1',
        value: { adapter: run.adapter, kind: 'pattern', ...f },
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
          coverage: run.coverage,
          refused: run.refused,
          notRun: c.notRun,
          findings: findings.length,
        },
      };
      return {
        result: facts.result(ctx.outcome.result as never, 'per-file-per-rule', report, findings),
        records: [report, ...findings],
      };
    },
  };
}
