// The production driver for the OSV advisory adapter (OSV-Scanner 2.7.0, PR 12). It runs only the shipped original
// `sentinel.deps.known-advisory` rule, at its exact definition digest, over the unit's captured dependency files and
// the owner-acquired advisory snapshots the plan pins (`osv:<ecosystem>`). Coverage is per file: a file is covered
// only when the engine matched it against a loaded database; stale, age-unknown, partial and empty assessments are
// never complete, and a file whose ecosystem has no pinned snapshot is not run.
import type { ScopeId } from '../../contracts/common.js';
import { OSV_ADAPTER, OSV_ENGINE } from '../osv/adapter.js';
import type { AdvisorySnapshot } from '../osv/acquire.js';
import { buildOsvJob, type Ecosystem, type OsvJob } from '../osv/job.js';
import { normalizeOsvRun } from '../osv/normalize.js';
import { bindRules, DriverError, fileScope, nothingToRun, ruleFileBytes, ResultFacts } from './common.js';
import { assertToolPin } from './pattern.js';
import type { CheckDriver, DriverNormalize, DriverRecord, SupportedRule } from './types.js';

export const OSV_SUPPORTED_RULES: readonly SupportedRule[] = Object.freeze([
  Object.freeze({ familyId: 'sentinel.deps.known-advisory', revision: 1, definitionDigest: 'sha256:6ddfd185269956d204381c3a5f842e6846bd7fbc60df5c5ae233829010864454' }),
]);
/** The plan's database id for an ecosystem's advisory snapshot. */
export const osvDatabaseId = (ecosystem: Ecosystem) => `osv:${ecosystem}`;
const ECOSYSTEMS: readonly Ecosystem[] = ['npm', 'Maven'];
const validStamp = (v: unknown): v is string => typeof v === 'string' && STAMP.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === `${v.slice(0, 23)}Z`;
const STAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{9}Z$/;

interface OsvContext {
  readonly schema: 'sentinel-driver-osv/draft-1';
  readonly sourceId: string;
  readonly job: OsvJob;
  readonly jobDigest: string;
  readonly maxDatabaseAgeMs: number;
  readonly notRun: Readonly<Record<string, string>>;
}

/** An admitted snapshot record, accepted only when it describes exactly the pinned archive. */
function snapshotOf(record: unknown, pin: { databaseId: string; snapshotDigest: string }, now: Date): AdvisorySnapshot {
  const s = record as AdvisorySnapshot;
  if (s?.schema !== 'sentinel-advisory-snapshot/draft-1' || !ECOSYSTEMS.includes(s.ecosystem) || pin.databaseId !== osvDatabaseId(s.ecosystem)
    || s.sha256 !== pin.snapshotDigest || !Number.isSafeInteger(s.size) || s.size < 1 || s.size > 512 * 1024 * 1024
    || typeof s.source !== 'string' || s.source.length > 2048 || typeof s.md5 !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(s.md5)
    || !validStamp(s.acquiredAt) || !(s.etag === null || (typeof s.etag === 'string' && s.etag.length <= 4096))
    || !(s.sourceLastModified === null || (validStamp(s.sourceLastModified) && Date.parse(s.sourceLastModified) <= now.getTime()))) {
    throw new DriverError('sentinel.drivers.contextInvalid', `${pin.databaseId}: the snapshot record does not describe the pinned archive`);
  }
  return Object.freeze({ ...s });
}

export function osvDriver(options: { maxDatabaseAgeMs: number }): CheckDriver {
  if (!Number.isSafeInteger(options.maxDatabaseAgeMs) || options.maxDatabaseAgeMs < 1) throw new DriverError('sentinel.drivers.contextInvalid', 'the freshness bound is a positive integer');
  return {
    adapterId: OSV_ADAPTER.id,
    supportedRules: OSV_SUPPORTED_RULES,
    async prepare(ctx) {
      assertToolPin(ctx, OSV_ADAPTER.id, OSV_ENGINE.image);
      const notRun: Record<string, string> = {};
      const { runnable, refused } = bindRules(OSV_ADAPTER.id, OSV_SUPPORTED_RULES, ctx.rules, ctx.checks);
      for (const f of refused) notRun[f] = 'sentinel.drivers.ruleUnsupported';
      for (const rule of runnable) ruleFileBytes(ctx.rules, rule);
      for (const c of ctx.checks) if (c.scopeKind !== 'dependency-manifest') notRun[c.familyId] = 'sentinel.drivers.scopeUnsupported';
      const snapshots = ctx.databases.filter(d => d.pin.databaseId.startsWith('osv:')).map(d => ({ snapshot: snapshotOf(d.record, d.pin, ctx.now), path: d.path }));
      const sourceId = ctx.unit.sourceId;
      if (!runnable.some(r => !notRun[r.familyId]) || !ctx.inputs.length || sourceId === null) {
        return nothingToRun(OSV_ADAPTER.id, 'per-file', ctx.checks, notRun, 'sentinel.drivers.nothingApplicable');
      }
      const targets = ctx.inputs.map(i => ({ relativePath: i.input.relativePath, artifact: i.input.content, path: i.path }));
      const built = buildOsvJob(targets, snapshots, ctx.scratch);
      if (!built.job.targets.length) {
        // Nothing the engine reads, or no snapshot for any file's ecosystem: each file's own reason, and no run.
        const facts = new ResultFacts();
        const why = new Map<ScopeId, string>(built.job.unsent.map(u => [fileScope({ sourceId, relativePath: u.relativePath }),
          u.reason === 'database-absent' ? 'sentinel.drivers.databaseMissing' : 'sentinel.osv.coverage.notDependencyFile']));
        for (const c of ctx.checks) facts.notRun(c, notRun[c.familyId] ?? why.get(c.scopeId) ?? 'sentinel.drivers.nothingApplicable');
        const report: DriverRecord = { schema: 'sentinel-driver-report/draft-1', value: { adapter: OSV_ADAPTER.id, ran: false, notRun, unsent: built.job.unsent } };
        return { artifacts: [], context: null, skipRun: { result: facts.facts('per-file', report, []) } };
      }
      const captured = new Set(targets.map(t => t.artifact));
      const dbs = new Set(snapshots.map(s => s.snapshot.sha256));
      const context: OsvContext = { schema: 'sentinel-driver-osv/draft-1', sourceId, job: built.job, jobDigest: built.jobDigest, maxDatabaseAgeMs: options.maxDatabaseAgeMs, notRun };
      return {
        artifacts: built.inputs.filter(i => !captured.has(i.id)).map(i => ({ id: i.id, path: i.path,
          role: dbs.has(i.id) ? 'database' as const : i.id === built.jobDigest ? 'job' as const : 'worker' as const })),
        context: JSON.parse(JSON.stringify(context)),
      };
    },
    normalize(ctx: DriverNormalize) {
      const c = ctx.context as OsvContext;
      if (c?.schema !== 'sentinel-driver-osv/draft-1') throw new DriverError('sentinel.drivers.contextInvalid', 'not an OSV driver context');
      const run = normalizeOsvRun({ job: c.job, jobDigest: c.jobDigest, outcome: ctx.outcome as never, outputBytes: ctx.output, targetBytes: ctx.sealed,
        policy: { now: ctx.now, maxDatabaseAgeMs: c.maxDatabaseAgeMs } });
      const rows = new Map(run.coverage.map(r => [fileScope({ sourceId: c.sourceId, relativePath: r.relativePath }), r]));
      const facts = new ResultFacts();
      for (const check of ctx.checks) {
        const skip = c.notRun[check.familyId];
        if (skip) { facts.notRun(check, skip); continue; }
        const row = rows.get(check.scopeId);
        if (!row) facts.notRun(check, 'sentinel.drivers.notReported');
        else if (row.status === 'complete') facts.ran(check);
        // Matched, with limits: partial transitive or version knowledge, a stale or age-unknown snapshot.
        else if (row.status === 'partial' || row.status === 'database-stale' || row.status === 'database-age-unknown') facts.ran(check, row.limitations);
        // Not reported by the engine (empty), no snapshot, an error, or not a dependency input: never run.
        else facts.notRun(check, row.status === 'database-absent' ? 'sentinel.drivers.databaseMissing' : row.reasonCode);
      }
      const findings: DriverRecord[] = run.findings.map(f => ({ schema: 'sentinel-driver-finding/draft-1', value: { adapter: run.adapter, kind: 'advisory', ...f } }));
      const report: DriverRecord = { schema: 'sentinel-driver-report/draft-1', value: {
        adapter: run.adapter, engine: run.engine, platform: run.platform, attempt: run.attempt, engineExit: run.engineExit, engineFailure: run.engineFailure,
        databases: run.databases, coverage: run.coverage, refused: run.refused, notRun: c.notRun, findings: findings.length,
      } };
      return { result: facts.result(ctx.outcome.result as never, 'per-file', report, findings), records: [report, ...findings] };
    },
  };
}
