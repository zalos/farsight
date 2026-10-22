// Bind the scanner kernels to the coordinator's one trusted driver contract. No checkout, network, acquisition or
// process execution lives here: prepare uses admitted sealed paths; the coordinator alone starts the pinned worker.
import { readFileSync } from 'node:fs';
import type { DriverContext, VerifiedAttempt, CheckDriver, PreparedJob, NormalizedOutcome } from '../../execution/check-drivers.js';
import { createAdapterRegistry, type ExternalAdapterDefinition } from '../../execution/registry.js';
import { canonicalJsonBytes } from '../../store/objects.js';
import { deepFreeze } from '../../policy/immutable.js';
import { gitleaksDriver, GITLEAKS_DRIVER_DEFINITION } from './gitleaks.js';
import type { SecretsSnapshot } from '../gitleaks/job.js';
import { scannerKernels } from './kernels.js';
import { DriverError, fileScope, sha256 } from './common.js';
import type { CheckDriver as ScannerKernel, DriverPrepare } from './types.js';

export interface DatabaseRecord { readonly databaseId: string; readonly snapshotDigest: string; readonly record: unknown }
export interface ProductionDriverOptions {
  readonly maxAdvisoryAgeMs: number;
  readonly secretsSnapshot?: SecretsSnapshot;
  /** Explicit owner-held acquisition records; paths never imply provenance or permission to download. */
  readonly databaseRecords?: readonly DatabaseRecord[];
}
const invalid = (message: string): never => { throw new DriverError('sentinel.drivers.contextInvalid', message); };
const binding = (ctx: DriverContext) => ({ plan: ctx.plan.digest, snapshot: ctx.plan.pins.snapshotId,
  unit: { id: ctx.unit.id, revision: ctx.unit.revision, inputFingerprint: ctx.unit.inputFingerprint },
  checks: ctx.checks.map(c => ({ id: c.id, familyId: c.familyId, revision: c.ruleRevision, scope: c.scopeId })), inputs: ctx.unit.inputs });

function contextFor(ctx: DriverContext, records: readonly DatabaseRecord[]): DriverPrepare {
  if (ctx.unit.stage !== 'check' || ctx.unit.sourceId === null || ctx.plan.pins.snapshotId === null) return invalid('a scanner receives a source-scoped check unit');
  const used = new Set(ctx.checks.map(c => c.scopeId));
  const inputs = ctx.unit.inputs.filter(i => used.has(fileScope(i))).map(input => {
    if (input.sourceId !== ctx.unit.sourceId) invalid('an input names another source');
    const sealed = ctx.inputs.find(i => i.id === input.content);
    const scopes = ctx.inputScopes.find(i => i.input === input.content)?.scopes ?? [];
    if (!sealed || !scopes.includes(fileScope(input)) || !ctx.unit.scopes.includes(fileScope(input))) return invalid('an assigned file has no sealed input scope');
    if (sha256(readFileSync(sealed.path)) !== input.content) invalid('a source input is not its pinned bytes');
    return { input, scopes: [...scopes], path: sealed.path };
  });
  for (const c of ctx.checks) if (!inputs.some(i => fileScope(i.input) === c.scopeId && i.input.sourceId === c.sourceId)) invalid('an assigned check has no exact captured input');
  const files = ctx.rules.flatMap(r => r.files.map(f => ({ path: f.path, digest: f.digest, size: f.bytes.length })));
  const bytes = new Map(ctx.rules.flatMap(r => r.files.map(f => [f.digest, f.bytes] as const)));
  return { run: { id: ctx.plan.runId, snapshotId: ctx.plan.pins.snapshotId }, unit: ctx.unit, checks: ctx.checks,
    inputs, rules: { pins: ctx.plan.pins.rules, resolved: ctx.rules.map(r => r.rule), files, bytesOf: d => bytes.get(d) },
    tools: ctx.tools, databases: ctx.databases.map(d => ({ pin: d, path: d.path,
      record: records.find(r => r.databaseId === d.databaseId && r.snapshotDigest === d.snapshotDigest)?.record })),
    scratch: ctx.workDir, now: new Date() };
}

function checkRecords(ctx: DriverContext, attempt: VerifiedAttempt, normalized: ReturnType<ScannerKernel['normalize']>): NormalizedOutcome['records'] {
  const assigned = new Map(ctx.unit.inputs.map(i => [i.relativePath, i]));
  const findings = normalized.records.filter(r => r.schema === 'sentinel-driver-finding/draft-1');
  const accepted: Array<{ value: unknown; schema: string; privacy: 'source-derived' }> = [];
  for (const record of findings) {
    const f = record.value as any;
    const locations: Array<{ relativePath: string; artifact: string | null }> = f.occurrences ?? (f.primary ? [f.primary, ...(f.related ?? [])] : [f]);
    const paths = locations.filter(l => assigned.get(l.relativePath)?.content === l.artifact).map(l => l.relativePath);
    // Trivy can name a Terraform module folder: retain that folder location, with the exact assigned descendant
    // checks it relates to, rather than inventing one file location for it.
    if (f.kind === 'misconfiguration' && f.artifact === null && f.configType === 'terraform') {
      for (const path of assigned.keys()) if (f.relativePath === '.' || path.startsWith(`${f.relativePath}/`)) paths.push(path);
    }
    const checks = ctx.checks.filter(c => paths.some(path => c.scopeId === fileScope({ sourceId: c.sourceId, relativePath: path }))
      && (f.familyId === undefined || (f.familyId === c.familyId && f.revision === c.ruleRevision)));
    if (!checks.length) continue;
    accepted.push({ schema: record.schema, privacy: 'source-derived', value: { ...f, sourceId: ctx.unit.sourceId,
      assignedChecks: checks.map(c => ({ id: c.id, familyId: c.familyId, revision: c.ruleRevision })).sort((a, b) => a.id.localeCompare(b.id)),
      runId: ctx.plan.runId, snapshotId: ctx.plan.pins.snapshotId, work: { id: ctx.unit.id, revision: ctx.unit.revision }, attemptId: attempt.result.attemptId } });
  }
  const reports = normalized.records.filter(r => r.schema !== 'sentinel-driver-finding/draft-1').map(r => ({ ...r, privacy: 'source-derived' as const,
    value: { ...(r.value as object), findings: accepted.length, unassignedFindings: findings.length - accepted.length,
      runId: ctx.plan.runId, snapshotId: ctx.plan.pins.snapshotId, work: { id: ctx.unit.id, revision: ctx.unit.revision }, attemptId: attempt.result.attemptId,
      expectedScopes: ctx.unit.scopes, actualReadSet: normalized.result.actualReadSet } }));
  return [...reports, ...accepted];
}

function canonicalDriver(definition: ExternalAdapterDefinition, kernel: ScannerKernel, records: readonly DatabaseRecord[]): CheckDriver {
  const implementationDigest = createAdapterRegistry([definition]).get(definition.id).digest;
  return Object.freeze({ adapterId: definition.id, implementationDigest, supportedRules: () => kernel.supportedRules,
    async prepare(ctx: DriverContext): Promise<PreparedJob> {
      ctx.signal.throwIfAborted();
      const prepared = await kernel.prepare(contextFor(ctx, records));
      ctx.signal.throwIfAborted();
      if (prepared.skipRun) {
        const reason = prepared.skipRun.result.skipped[0]?.reasonCode ?? 'sentinel.drivers.nothingApplicable';
        // This coordinator seam cannot publish a worker-free check attempt. Refuse preparation; its checks stay
        // unknown/unpublished, with the reason, rather than run a worker without its required assets.
        throw new DriverError('sentinel.drivers.contextInvalid', reason);
      }
      return deepFreeze({ job: { schema: 'sentinel-production-driver-job/draft-1', binding: binding(ctx), context: prepared.context },
        auxiliary: prepared.artifacts.map(a => ({ path: a.path, role: a.role })) });
    },
    async normalize(ctx: DriverContext, verified: VerifiedAttempt): Promise<NormalizedOutcome> {
      ctx.signal.throwIfAborted();
      const job = verified.job as any;
      if (job?.schema !== 'sentinel-production-driver-job/draft-1' || !canonicalJsonBytes(job.binding).equals(canonicalJsonBytes(binding(ctx)))) invalid('the job belongs to another admitted unit');
      const jobBytes = canonicalJsonBytes(job);
      const sealedJob = verified.sealed(sha256(jobBytes));
      if (!sealedJob || !Buffer.from(sealedJob).equals(jobBytes)) invalid('the recorded job is not its sealed bytes');
      if (!Object.isFrozen(verified.outcome) || verified.outcome.result !== verified.result) invalid('normalization needs the exact frozen supervisor outcome');
      const normalized = kernel.normalize({ context: job.context, outcome: verified.outcome, unit: ctx.unit, checks: ctx.checks, now: new Date(), output: verified.output, sealed: verified.sealed });
      const records = checkRecords(ctx, verified, normalized);
      const report = records.find(r => r.schema === 'sentinel-driver-report/draft-1')!;
      const coverageId = sha256(canonicalJsonBytes(report.value));
      return { coverage: { granularity: normalized.result.granularity, coveredChecks: normalized.result.coveredChecks.map(c => ({ ...c, coverage: coverageId })),
        scannedSet: normalized.result.scannedSet, actualReadSet: normalized.result.actualReadSet, skipped: normalized.result.skipped, unresolvedFrontiers: normalized.result.unresolvedFrontiers }, records };
    } });
}

/** Unregistered until an explicit trusted profile selects installed pinned engines and owner-held assets. */
export function productionDrivers(options: ProductionDriverOptions): ReadonlyMap<string, { definition: ExternalAdapterDefinition; driver: CheckDriver }> {
  const records = deepFreeze(structuredClone(options.databaseRecords ?? []));
  const result = new Map<string, { definition: ExternalAdapterDefinition; driver: CheckDriver }>();
  for (const [id, entry] of scannerKernels(options)) {
    const definition = Object.freeze({ ...entry.definition, coverage: id === 'pattern-semgrep' ? 'per-file-per-rule' as const : 'per-file' as const });
    result.set(id, Object.freeze({ definition, driver: canonicalDriver(definition, entry.driver, records) }));
  }
  result.set(GITLEAKS_DRIVER_DEFINITION.id, Object.freeze({ definition: GITLEAKS_DRIVER_DEFINITION, driver: gitleaksDriver(options.secretsSnapshot) }));
  return result;
}
