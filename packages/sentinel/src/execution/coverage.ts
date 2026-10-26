// Coverage records: what one executed attempt actually covered, as canonical sentinel-coverage/draft-1 envelopes,
// one per check the plan assigned to its unit. Required coverage is then evaluated only by PR 06's
// evaluateRequiredCoverage over these records, so a check the plan could not plan, a required rule gap, a unit that
// never ran or a failed attempt all stay incomplete; finishing work, or a worker's own claims, prove nothing alone.
//
// For each assigned check: `complete` when the result names the check, its scope is in the scanned set and no
// skipped or unresolved entry bears on it: its own scope, or any scope whose extent the plan cannot prove disjoint
// from it (a surface's graph id and an index frontier have no recorded extent, so they bear on every check of their
// source, and every such check bears on them), or a scope the result names that bears on none of the unit's checks,
// which is never dropped; `partial` when the result names the check but the scope was skipped,
// unresolved or not scanned; `not-run` when the result does not name it. The granularity is the coarser of the
// trusted adapter's (registry `coverage`) and the result's: an adapter never gains per-file coverage by claiming it.
// The assessed scope and the limitations behind each record are stored artifacts it names.
import { createHash } from 'node:crypto';
import type { ArtifactId, Id, ScopedReason } from '../contracts/common.js';
import type { CoverageEnvelope, CoverageGranularity, CoverageStatus } from '../contracts/coverage.js';
import type { PlanCheck, PlanEnvelope } from '../contracts/plan.js';
import type { ResultMessage } from '../contracts/protocol.js';
import { canonicalJsonBytes } from '../store/objects.js';

export const COVERAGE_SCHEMA = 'sentinel-coverage/draft-1';
export const ASSESSED_SCOPE_SCHEMA = 'sentinel-coverage-scope/draft-1';
export const LIMITATIONS_SCHEMA = 'sentinel-coverage-limitations/draft-1';

const ORDER: readonly CoverageGranularity[] = ['per-file-per-rule', 'per-file', 'aggregate'];
export const coarser = (a: CoverageGranularity, b: CoverageGranularity): CoverageGranularity =>
  ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
const idOf = (v: unknown): ArtifactId => `sha256:${createHash('sha256').update(canonicalJsonBytes(v)).digest('hex')}`;

/**
 * What a scope covers, read from the plan itself (PR 06's own records), never guessed from the string alone:
 * - `source`: a whole-repository check's scope, the source id itself;
 * - `path`: `<source>:<path>` where <path> is a file the plan's units read (a captured file);
 * - `folder`: `<source>:<folder>/`, a folder boundary the plan names;
 * - `unknown`: anything else, including a surface's graph id and an index frontier (`<source>:#...`). What file a
 *   surface lives in is not recorded with its check, so its extent cannot be compared.
 */
export type ScopeExtent =
  | { kind: 'source'; sourceId: Id }
  | { kind: 'path'; sourceId: Id; path: string }
  | { kind: 'folder'; sourceId: Id; path: string }
  | { kind: 'unknown'; sourceId: Id | null };

export interface ScopeIndex {
  /** The plan's checks by scope id. */
  checks: ReadonlyMap<string, Pick<PlanCheck, 'scopeId' | 'scopeKind' | 'sourceId'>>;
  /** Every captured file the plan's units read, as `<source>\u0000<path>`. */
  files: ReadonlySet<string>;
}

/** Index a plan's scopes once: its checks by scope id and the captured files its units read. */
export function scopeIndex(plan: Pick<PlanEnvelope, 'checks' | 'units'>): ScopeIndex {
  const checks = new Map<string, Pick<PlanCheck, 'scopeId' | 'scopeKind' | 'sourceId'>>();
  for (const c of plan.checks) if (!checks.has(c.scopeId)) checks.set(c.scopeId, c);
  const files = new Set<string>();
  for (const u of plan.units) for (const i of u.inputs) files.add(`${i.sourceId}\u0000${i.relativePath}`);
  return { checks, files };
}

export function extentOf(scope: string, index: ScopeIndex): ScopeExtent {
  const c = index.checks.get(scope);
  if (!c) return { kind: 'unknown', sourceId: null };
  if (c.scopeKind === 'repository' && scope === c.sourceId) return { kind: 'source', sourceId: c.sourceId };
  const prefix = `${c.sourceId}:`;
  if (!scope.startsWith(prefix)) return { kind: 'unknown', sourceId: c.sourceId };
  const rest = scope.slice(prefix.length);
  if (rest.endsWith('/') && rest.length > 1 && !rest.startsWith('/') && !rest.startsWith('#') && !rest.startsWith(':'))
    return { kind: 'folder', sourceId: c.sourceId, path: rest };
  if (index.files.has(`${c.sourceId}\u0000${rest}`)) return { kind: 'path', sourceId: c.sourceId, path: rest };
  return { kind: 'unknown', sourceId: c.sourceId };
}

/** Two extents are disjoint only when that is proven; anything unknown overlaps everything in its source (or all). */
export function overlaps(a: ScopeExtent, b: ScopeExtent): boolean {
  if (a.sourceId !== null && b.sourceId !== null && a.sourceId !== b.sourceId) return false;
  if (a.kind === 'unknown' || b.kind === 'unknown' || a.kind === 'source' || b.kind === 'source') return true;
  const within = (inner: string, folder: string) => inner.startsWith(folder);
  if (a.kind === 'path' && b.kind === 'path') return a.path === b.path;
  if (a.kind === 'folder' && b.kind === 'folder') return within(a.path, b.path) || within(b.path, a.path);
  const [folder, other] = a.kind === 'folder' ? [a, b] : [b, a];
  return within(other.path, folder.path);
}

/** Whether a scope a result names bears on a check: its own scope, or any scope not proven disjoint from it. */
export function bearsOn(
  scope: string,
  c: Pick<PlanCheck, 'scopeId' | 'scopeKind' | 'sourceId'>,
  index: ScopeIndex,
): boolean {
  if (scope === c.scopeId) return true;
  return overlaps(extentOf(scope, index), extentOf(c.scopeId, index));
}

export interface CoverageRecords {
  envelopes: CoverageEnvelope[];
  /** The records to publish with the result, in order: each assessed scope and limitations, then each envelope. */
  records: Array<{ value: unknown; schema: string }>;
}

export function coverageRecords(input: {
  runId: Id;
  attemptId: Id;
  work: { id: Id; revision: number };
  checks: readonly PlanCheck[];
  adapterGranularity: CoverageGranularity;
  result: ResultMessage;
  recordedAt: string;
  scopes: ScopeIndex;
}): CoverageRecords {
  const { result } = input;
  const covered = new Set(result.coveredChecks.map((c) => c.checkId));
  const scanned = new Set(result.scannedSet);
  const granularity = coarser(input.adapterGranularity, result.granularity);
  const envelopes: CoverageEnvelope[] = [];
  const records: CoverageRecords['records'] = [];
  // A limitation the result reports for a scope that bears on none of the unit's checks cannot be attributed: it is
  // kept as a limitation of every check, never dropped. (With unknown extents overlapping, this is a scope proven
  // disjoint from every check of the unit, kept anyway.)
  const unattributed = (xs: readonly ScopedReason[]) =>
    xs.filter((x) => !input.checks.some((c) => bearsOn(x.scopeId, c, input.scopes)));
  const strayRows = { skipped: unattributed(result.skipped), unresolved: unattributed(result.unresolvedFrontiers) };
  for (const c of input.checks) {
    const pick = (xs: readonly ScopedReason[], stray: readonly ScopedReason[]) =>
      [...xs.filter((x) => bearsOn(x.scopeId, c, input.scopes)), ...stray].map((x) => ({
        scopeId: x.scopeId,
        reasonCode: x.reasonCode,
      }));
    const skipped: ScopedReason[] = pick(result.skipped, strayRows.skipped);
    const unresolved = pick(result.unresolvedFrontiers, strayRows.unresolved);
    const status: CoverageStatus = !covered.has(c.id)
      ? 'not-run'
      : scanned.has(c.scopeId) && skipped.length === 0 && unresolved.length === 0
        ? 'complete'
        : 'partial';
    const scope = {
      schema: ASSESSED_SCOPE_SCHEMA,
      checkId: c.id,
      scopeKind: c.scopeKind,
      scopeId: c.scopeId,
      scanned: scanned.has(c.scopeId),
    };
    const limitations = {
      schema: LIMITATIONS_SCHEMA,
      checkId: c.id,
      skipped,
      unresolved,
      resultGranularity: result.granularity,
      adapterGranularity: input.adapterGranularity,
    };
    const envelope: CoverageEnvelope = {
      schema: COVERAGE_SCHEMA,
      id: `cov-${createHash('sha256').update(`${input.runId}\u0000${c.id}\u0000${input.attemptId}`).digest('hex').slice(0, 40)}`,
      runId: input.runId,
      checkId: c.id,
      workId: input.work.id,
      workRevision: input.work.revision,
      status,
      granularity,
      assessedScopeArtifact: idOf(scope),
      limitationsArtifact: idOf(limitations),
      basis: { kind: 'executed', attemptId: input.attemptId },
      skipped,
      recordedAt: input.recordedAt,
    };
    envelopes.push(envelope);
    records.push(
      { value: scope, schema: ASSESSED_SCOPE_SCHEMA },
      { value: limitations, schema: LIMITATIONS_SCHEMA },
      { value: envelope, schema: COVERAGE_SCHEMA },
    );
  }
  return { envelopes, records };
}
