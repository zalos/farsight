// Coverage records: what one executed attempt actually covered, as canonical sentinel-coverage/draft-1 envelopes,
// one per check the plan assigned to its unit. Required coverage is then evaluated only by PR 06's
// evaluateRequiredCoverage over these records, so a check the plan could not plan, a required rule gap, a unit that
// never ran or a failed attempt all stay incomplete; finishing work, or a worker's own claims, prove nothing alone.
//
// For each assigned check: `complete` when the result names the check, its scope is in the scanned set and no
// skipped or unresolved entry names the scope; `partial` when the result names the check but the scope was skipped,
// unresolved or not scanned; `not-run` when the result does not name it. The granularity is the coarser of the
// trusted adapter's (registry `coverage`) and the result's: an adapter never gains per-file coverage by claiming it.
// The assessed scope and the limitations behind each record are stored artifacts it names.
import { createHash } from 'node:crypto';
import type { ArtifactId, Id, ScopedReason } from '../contracts/common.js';
import type { CoverageEnvelope, CoverageGranularity, CoverageStatus } from '../contracts/coverage.js';
import type { PlanCheck } from '../contracts/plan.js';
import type { ResultMessage } from '../contracts/protocol.js';
import { canonicalJsonBytes } from '../store/objects.js';

export const COVERAGE_SCHEMA = 'sentinel-coverage/draft-1';
export const ASSESSED_SCOPE_SCHEMA = 'sentinel-coverage-scope/draft-1';
export const LIMITATIONS_SCHEMA = 'sentinel-coverage-limitations/draft-1';

const ORDER: readonly CoverageGranularity[] = ['per-file-per-rule', 'per-file', 'aggregate'];
export const coarser = (a: CoverageGranularity, b: CoverageGranularity): CoverageGranularity => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);
const idOf = (v: unknown): ArtifactId => `sha256:${createHash('sha256').update(canonicalJsonBytes(v)).digest('hex')}`;

export interface CoverageRecords {
  envelopes: CoverageEnvelope[];
  /** The records to publish with the result, in order: each assessed scope and limitations, then each envelope. */
  records: Array<{ value: unknown; schema: string }>;
}

export function coverageRecords(input: { runId: Id; attemptId: Id; work: { id: Id; revision: number }; checks: readonly PlanCheck[];
  adapterGranularity: CoverageGranularity; result: ResultMessage; recordedAt: string }): CoverageRecords {
  const { result } = input;
  const covered = new Set(result.coveredChecks.map(c => c.checkId));
  const scanned = new Set(result.scannedSet);
  const granularity = coarser(input.adapterGranularity, result.granularity);
  const envelopes: CoverageEnvelope[] = [];
  const records: CoverageRecords['records'] = [];
  for (const c of input.checks) {
    const skipped: ScopedReason[] = result.skipped.filter(s => s.scopeId === c.scopeId).map(s => ({ scopeId: s.scopeId, reasonCode: s.reasonCode }));
    const unresolved = result.unresolvedFrontiers.filter(s => s.scopeId === c.scopeId).map(s => ({ scopeId: s.scopeId, reasonCode: s.reasonCode }));
    const status: CoverageStatus = !covered.has(c.id) ? 'not-run'
      : scanned.has(c.scopeId) && skipped.length === 0 && unresolved.length === 0 ? 'complete' : 'partial';
    const scope = { schema: ASSESSED_SCOPE_SCHEMA, checkId: c.id, scopeKind: c.scopeKind, scopeId: c.scopeId, scanned: scanned.has(c.scopeId) };
    const limitations = { schema: LIMITATIONS_SCHEMA, checkId: c.id, skipped, unresolved, resultGranularity: result.granularity, adapterGranularity: input.adapterGranularity };
    const envelope: CoverageEnvelope = {
      schema: COVERAGE_SCHEMA, id: `cov-${createHash('sha256').update(`${input.runId}\u0000${c.id}\u0000${input.attemptId}`).digest('hex').slice(0, 40)}`,
      runId: input.runId, checkId: c.id, workId: input.work.id, workRevision: input.work.revision, status, granularity,
      assessedScopeArtifact: idOf(scope), limitationsArtifact: idOf(limitations), basis: { kind: 'executed', attemptId: input.attemptId },
      skipped, recordedAt: input.recordedAt,
    };
    envelopes.push(envelope);
    records.push({ value: scope, schema: ASSESSED_SCOPE_SCHEMA }, { value: limitations, schema: LIMITATIONS_SCHEMA }, { value: envelope, schema: COVERAGE_SCHEMA });
  }
  return { envelopes, records };
}
