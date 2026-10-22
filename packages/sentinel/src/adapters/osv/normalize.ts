// Reading one OSV attempt's verified outputs, coordinator-side. The engine reports packages and matches; this decides
// what they establish:
// - the run record must name the supplied job and the engine output it lists; a failed engine counts nothing (a
//   missing database still prints packages with no vulnerabilities, so its JSON is never read as clean);
// - every target is re-hashed against the job from the attempt's sealed copy;
// - each component carries its provenance (file, artifact, kind), identity (ecosystem, name, version, purl), how
//   certain its version is, and how far its transitive dependencies are known; only a component with an established
//   version is assessed, and a match on a guessed version (a Maven range's lower bound) is refused, not reported;
// - a finding is one component and one advisory group, once across every file that names the component, keyed by the
//   advisory snapshot too, so a new snapshot is a new assessment; advisory text is untrusted and not kept;
// - coverage is per file: complete, partial (versions unknown or transitives not resolved), database-absent,
//   database-stale (older than the owner's bound), empty, error, not applicable.
import { createHash } from 'node:crypto';
import type { ArtifactId } from '../../contracts/common.js';
import type { WorkerOutcome } from '../../execution/supervisor.js';
import { canonicalDigest } from '../../policy/digest.js';
import { deepFreeze } from '../../policy/immutable.js';
import { OSV_ENGINE, OSV_IMAGE_PLATFORMS, OSV_MAX_OUTPUT_BYTES, OSV_MEASURED_ARCHITECTURES } from './adapter.js';
import { osvFail } from './errors.js';
import { KIND_ECOSYSTEMS, type DependencyFileKind, type Ecosystem, type OsvJob, type OsvJobTarget } from './job.js';

export const OSV_CERTAINTIES = [
  'resolved-lockfile', 'declared-sbom', 'declared-exact', 'declared-property', 'declared-range', 'unknown-managed', 'unknown',
] as const;
export type VersionCertainty = typeof OSV_CERTAINTIES[number];
const ASSESSABLE: ReadonlySet<VersionCertainty> = new Set(['resolved-lockfile', 'declared-sbom', 'declared-exact', 'declared-property']);
export type TransitiveLimit = 'as-locked' | 'as-listed-by-sbom' | 'not-resolved';

export const OSV_COVERAGE_REASONS = [
  'sentinel.osv.coverage.complete', 'sentinel.osv.coverage.versionsUnknown', 'sentinel.osv.coverage.transitivesNotResolved',
  'sentinel.osv.coverage.databaseAbsent', 'sentinel.osv.coverage.databaseStale', 'sentinel.osv.coverage.noComponents',
  'sentinel.osv.coverage.notDependencyFile', 'sentinel.osv.coverage.inputMismatch', 'sentinel.osv.coverage.attemptFailed',
  'sentinel.osv.coverage.attemptTimedOut', 'sentinel.osv.coverage.attemptCanceled', 'sentinel.osv.coverage.engineFailed',
  'sentinel.osv.coverage.engineTimedOut', 'sentinel.osv.coverage.outputTruncated', 'sentinel.osv.coverage.platformUnmeasured',
  'sentinel.osv.coverage.databaseNotLoaded', 'sentinel.osv.coverage.componentsSkipped',
] as const;
export type OsvCoverageReason = typeof OSV_COVERAGE_REASONS[number];
export const OSV_REFUSAL_REASONS = [
  'sentinel.osv.refused.unknownSource', 'sentinel.osv.refused.versionUnverified', 'sentinel.osv.refused.ecosystem',
  'sentinel.osv.refused.malformed', 'sentinel.osv.refused.inputMismatch',
] as const;
export type OsvRefusalReason = typeof OSV_REFUSAL_REASONS[number];
export const OSV_ENGINE_FAILURES = [
  'sentinel.osv.engine.engineError', 'sentinel.osv.engine.noPackages', 'sentinel.osv.engine.killed', 'sentinel.osv.engine.unknown',
] as const;
export type OsvEngineFailure = typeof OSV_ENGINE_FAILURES[number];

export type OsvCoverageStatus = 'complete' | 'partial' | 'database-absent' | 'database-stale' | 'empty' | 'error' | 'not-applicable';

export interface OsvComponent {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly version: string | null;
  readonly purl: string | null;
  readonly certainty: VersionCertainty;
  readonly transitive: TransitiveLimit;
  readonly assessed: boolean;
  /**
   * The engine listed the component but would not match it: its package URL says `source=LOCAL` (an npm lock entry
   * with no registry source). OSV-Scanner 2.7.0 reports such a component with no advisories and no other sign.
   */
  readonly skippedByEngine: boolean;
  readonly relativePath: string;
  readonly artifact: ArtifactId;
  readonly kind: DependencyFileKind;
}

export interface OsvFinding {
  /** The assessment: component, advisory group and the advisory snapshot it was matched against. */
  readonly id: string;
  /** The component and advisory group alone: equal across snapshots, so a change can be explained. */
  readonly key: string;
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly version: string;
  readonly advisories: { readonly ids: readonly string[]; readonly aliases: readonly string[]; readonly modified: string | null };
  readonly certainty: VersionCertainty;
  readonly occurrences: readonly { readonly relativePath: string; readonly artifact: ArtifactId }[];
  readonly database: { readonly sha256: string; readonly sourceLastModified: string };
}

export interface OsvCoverage {
  readonly relativePath: string;
  readonly artifact: ArtifactId;
  readonly kind: DependencyFileKind | null;
  readonly status: OsvCoverageStatus;
  readonly reasonCode: OsvCoverageReason;
  /** Every limitation that applies, the status's reason first. */
  readonly limitations: readonly OsvCoverageReason[];
  readonly components: number;
  readonly unassessed: number;
}

export interface OsvDatabaseUse {
  readonly ecosystem: Ecosystem;
  readonly sha256: string;
  readonly sourceLastModified: string;
  readonly ageMs: number;
  readonly freshness: 'fresh' | 'stale';
}

export interface OsvRunResult {
  readonly adapter: string;
  readonly engine: string;
  readonly mode: 'full-offline';
  readonly attempt: WorkerOutcome['state'];
  readonly platform: { readonly architecture: string | null; readonly state: 'measured' | 'candidate' | 'refused' };
  readonly engineExit: number | null;
  readonly engineFailure: OsvEngineFailure | null;
  readonly databases: readonly OsvDatabaseUse[];
  readonly components: readonly OsvComponent[];
  readonly findings: readonly OsvFinding[];
  readonly coverage: readonly OsvCoverage[];
  readonly refused: readonly { readonly reasonCode: OsvRefusalReason; readonly relativePath: string | null }[];
}

export interface OsvNormalizeInput {
  job: OsvJob;
  jobDigest: ArtifactId;
  outcome: WorkerOutcome;
  outputBytes: (id: ArtifactId) => Uint8Array;
  /** The sealed input copy of a target, by artifact id. */
  targetBytes: (artifact: ArtifactId) => Uint8Array | undefined;
  /** The owner's freshness bound: a snapshot whose source changed longer ago than this is stale. */
  policy: { now: Date; maxDatabaseAgeMs: number };
  qualifyingArchitecture?: string;
}

const TARGET_PATH = /^\/tmp\/sentinel-osv\/t\/(\d+)\/[A-Za-z.-]+$/;
const ADVISORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const sha256 = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/**
 * The version text each dependency of a `pom.xml` declares, by `group:artifact`: null when it declares none (managed
 * by a parent or BOM, which offline reading cannot see). A bounded, deliberately small reading: no parent, profile,
 * import or property resolution of its own; it only says how the engine's version was obtained.
 */
export function pomDeclarations(bytes: Uint8Array): Map<string, string | null> {
  const text = new TextDecoder('utf-8').decode(bytes.subarray(0, 2 * 1024 * 1024)).replace(/<!--[\s\S]*?-->/g, '');
  const out = new Map<string, string | null>();
  const tag = (block: string, name: string) => { const m = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(block); return m ? m[1]! : null; };
  const deps = /<dependencies>([\s\S]*?)<\/dependencies>/.exec(text.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, ''));
  for (const m of (deps?.[1] ?? '').matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const g = tag(m[1]!, 'groupId'), a = tag(m[1]!, 'artifactId');
    if (g && a) out.set(`${g}:${a}`, tag(m[1]!, 'version'));
  }
  return out;
}

function certaintyOf(kind: DependencyFileKind, version: string, name: string, pom: Map<string, string | null> | null): VersionCertainty {
  if (kind === 'npm-package-lock' || kind === 'npm-pnpm-lock') return version ? 'resolved-lockfile' : 'unknown';
  if (kind === 'cyclonedx-sbom') return version ? 'declared-sbom' : 'unknown';
  if (!pom!.has(name)) return 'unknown';
  const declared = pom!.get(name);
  if (declared === null || declared === undefined || declared === '') return 'unknown-managed';
  if (/^[[(]/.test(declared)) return 'declared-range';
  if (declared.includes('${')) return version ? 'declared-property' : 'unknown';
  return declared === version ? 'declared-exact' : 'unknown';
}

const transitiveOf = (kind: DependencyFileKind): TransitiveLimit =>
  kind === 'maven-pom' ? 'not-resolved' : kind === 'cyclonedx-sbom' ? 'as-listed-by-sbom' : 'as-locked';

export function normalizeOsvRun(input: OsvNormalizeInput): OsvRunResult {
  const { job, outcome } = input;
  const databases: OsvDatabaseUse[] = job.databases.map(d => {
    const ageMs = input.policy.now.getTime() - Date.parse(d.sourceLastModified);
    return { ecosystem: d.ecosystem, sha256: d.sha256, sourceLastModified: d.sourceLastModified, ageMs, freshness: ageMs > input.policy.maxDatabaseAgeMs ? 'stale' : 'fresh' };
  });
  const unsentRows: OsvCoverage[] = job.unsent.map(u => u.reason === 'not-dependency-file'
    ? { relativePath: u.relativePath, artifact: u.artifact, kind: null, status: 'not-applicable', reasonCode: 'sentinel.osv.coverage.notDependencyFile', limitations: ['sentinel.osv.coverage.notDependencyFile'], components: 0, unassessed: 0 }
    : { relativePath: u.relativePath, artifact: u.artifact, kind: u.kind, status: 'database-absent', reasonCode: 'sentinel.osv.coverage.databaseAbsent', limitations: ['sentinel.osv.coverage.databaseAbsent'], components: 0, unassessed: 0 });
  const sentRow = (t: OsvJobTarget, status: OsvCoverageStatus, reasonCode: OsvCoverageReason, extra: OsvCoverageReason[] = [], components = 0, unassessed = 0): OsvCoverage =>
    ({ relativePath: t.relativePath, artifact: t.artifact, kind: t.kind, status, reasonCode, limitations: status === 'complete' ? [] : [reasonCode, ...extra.filter(r => r !== reasonCode)], components, unassessed });
  const allError = (reason: OsvCoverageReason) => [...job.targets.map(t => sentRow(t, 'error', reason)), ...unsentRows];
  const base = { adapter: outcome.adapter.id, engine: `${OSV_ENGINE.name} ${OSV_ENGINE.version}`, mode: 'full-offline' as const, attempt: outcome.state, databases };
  const empty = { components: [], findings: [], refused: [] };

  if (outcome.state !== 'succeeded') {
    const reason: OsvCoverageReason = outcome.state === 'timed-out' ? 'sentinel.osv.coverage.attemptTimedOut' : outcome.state === 'canceled' ? 'sentinel.osv.coverage.attemptCanceled' : 'sentinel.osv.coverage.attemptFailed';
    return deepFreeze({ ...base, ...empty, platform: { architecture: outcome.container?.image?.architecture ?? null, state: 'refused' as const }, engineExit: null, engineFailure: null, coverage: allError(reason) });
  }
  const architecture = outcome.container?.image?.architecture ?? null;
  const candidate = architecture !== null && architecture === input.qualifyingArchitecture && OSV_IMAGE_PLATFORMS.some(p => p.architecture === architecture && p.state === 'unmeasured');
  if (!architecture || (!OSV_MEASURED_ARCHITECTURES.has(architecture) && !candidate)) {
    return deepFreeze({ ...base, ...empty, platform: { architecture, state: 'refused' as const }, engineExit: null, engineFailure: null, coverage: allError('sentinel.osv.coverage.platformUnmeasured') });
  }
  const platform = { architecture, state: candidate ? 'candidate' as const : 'measured' as const };

  const parse = (bytes: Uint8Array, limit: number, what: string): any => {
    if (bytes.byteLength > limit) osvFail('sentinel.osv.outputInvalid', `${what} exceeds ${limit} bytes`);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return osvFail('sentinel.osv.outputInvalid', `${what} is not UTF-8 JSON`); }
  };
  const recordOut = outcome.outputs.find(o => o.mediaType === 'application/vnd.sentinel.osv-run+json');
  if (!recordOut) return osvFail('sentinel.osv.outputInvalid', 'no run record');
  const record = parse(input.outputBytes(recordOut.id), 16 * 1024, 'the run record');
  if (record?.schema !== 'sentinel-osv-run/draft-1' || record.job !== input.jobDigest) osvFail('sentinel.osv.outputInvalid', 'the run record names another job');
  const engineOut = outcome.outputs.find(o => o.mediaType === 'application/vnd.osv.scan+json');
  if (!engineOut || engineOut.id !== record.engineOutput) return osvFail('sentinel.osv.outputInvalid', 'the engine output is not the one the run record names');
  const exit = Number.isSafeInteger(record.exitCode) ? record.exitCode as number : null;
  let engineFailure: OsvEngineFailure | null = null;
  if (exit !== 0 && exit !== 1) {
    const c = `sentinel.osv.engine.${typeof record.failure?.category === 'string' ? record.failure.category : 'unknown'}`;
    engineFailure = (OSV_ENGINE_FAILURES as readonly string[]).includes(c) ? c as OsvEngineFailure : 'sentinel.osv.engine.unknown';
    const reason = record.timedOut === true ? 'sentinel.osv.coverage.engineTimedOut' : 'sentinel.osv.coverage.engineFailed';
    return deepFreeze({ ...base, ...empty, platform, engineExit: exit, engineFailure, coverage: allError(reason) });
  }
  if (record.stdoutTruncated === true) return deepFreeze({ ...base, ...empty, platform, engineExit: exit, engineFailure, coverage: allError('sentinel.osv.coverage.outputTruncated') });
  const engine = parse(input.outputBytes(engineOut.id), OSV_MAX_OUTPUT_BYTES, 'the engine output');
  if (!Array.isArray(engine?.results)) osvFail('sentinel.osv.outputInvalid', 'the engine output lists no results');

  // The databases the engine reported loading. A component of an ecosystem whose database was not loaded was not
  // matched at all, whatever the exit code says.
  const loaded = new Set<string>((Array.isArray(record.loaded) ? record.loaded : []).filter((e: unknown) => e === 'npm' || e === 'Maven'));
  const refused: { reasonCode: OsvRefusalReason; relativePath: string | null }[] = [];
  const byIndex = new Map(job.targets.map(t => [t.index, t]));
  const verified = new Map<number, Uint8Array>();
  for (const t of job.targets) { const b = input.targetBytes(t.artifact); if (b && sha256(b) === t.artifact) verified.set(t.index, b); }
  const dbOf = new Map(databases.map(d => [d.ecosystem, d]));
  const components: OsvComponent[] = [];
  const findings = new Map<string, { f: Omit<OsvFinding, 'occurrences'>; occ: Map<string, { relativePath: string; artifact: ArtifactId }> }>();
  const reported = new Set<number>();

  for (const result of engine.results) {
    const m = TARGET_PATH.exec(String(result?.source?.path ?? ''));
    const target = m ? byIndex.get(Number(m[1])) : undefined;
    if (!target) { refused.push({ reasonCode: 'sentinel.osv.refused.unknownSource', relativePath: null }); continue; }
    const bytes = verified.get(target.index);
    if (!bytes) { refused.push({ reasonCode: 'sentinel.osv.refused.inputMismatch', relativePath: target.relativePath }); continue; }
    reported.add(target.index);
    const pom = target.kind === 'maven-pom' ? pomDeclarations(bytes) : null;
    for (const p of Array.isArray(result.packages) ? result.packages : []) {
      const pkg = p?.package;
      const ecosystem = pkg?.ecosystem;
      if (typeof pkg?.name !== 'string' || !pkg.name || pkg.name.length > 300 || typeof pkg.version !== 'string' || pkg.version.length > 100) {
        refused.push({ reasonCode: 'sentinel.osv.refused.malformed', relativePath: target.relativePath }); continue;
      }
      if ((ecosystem !== 'npm' && ecosystem !== 'Maven') || !KIND_ECOSYSTEMS[target.kind].includes(ecosystem)) {
        refused.push({ reasonCode: 'sentinel.osv.refused.ecosystem', relativePath: target.relativePath }); continue;
      }
      const certainty = certaintyOf(target.kind, pkg.version, pkg.name, pom);
      const purl = typeof pkg.purl === 'string' && pkg.purl.length <= 400 ? pkg.purl : null;
      const skippedByEngine = purl !== null && /[?&]source=LOCAL(&|$)/.test(purl);
      const assessed = ASSESSABLE.has(certainty) && pkg.version !== '' && loaded.has(ecosystem) && !skippedByEngine;
      components.push({
        ecosystem, name: pkg.name, version: pkg.version || null, purl, certainty, transitive: transitiveOf(target.kind), assessed,
        skippedByEngine, relativePath: target.relativePath, artifact: target.artifact, kind: target.kind,
      });
      const vulns = Array.isArray(p.vulnerabilities) ? p.vulnerabilities : [];
      if (!vulns.length) continue;
      if (!assessed) { refused.push({ reasonCode: 'sentinel.osv.refused.versionUnverified', relativePath: target.relativePath }); continue; }
      const groups = Array.isArray(p.groups) && p.groups.length ? p.groups : vulns.map((v: any) => ({ ids: [v?.id], aliases: v?.aliases ?? [] }));
      for (const g of groups) {
        const ids: string[] = (Array.isArray(g?.ids) ? g.ids : []).filter((x: unknown): x is string => typeof x === 'string' && ADVISORY_ID.test(x)).sort();
        if (!ids.length) { refused.push({ reasonCode: 'sentinel.osv.refused.malformed', relativePath: target.relativePath }); continue; }
        const aliases: string[] = [...new Set<string>((Array.isArray(g.aliases) ? g.aliases : []).filter((x: unknown): x is string => typeof x === 'string' && ADVISORY_ID.test(x)))].sort();
        const modified = vulns.filter((v: any) => ids.includes(v?.id) && typeof v.modified === 'string' && !Number.isNaN(Date.parse(v.modified))).map((v: any) => v.modified as string).sort().at(-1) ?? null;
        const db = dbOf.get(ecosystem)!;
        const key = canonicalDigest({ kind: 'sentinel-osv-component-advisory/1', ecosystem, name: pkg.name, version: pkg.version, ids });
        const id = canonicalDigest({ kind: 'sentinel-osv-assessment/1', key, database: db.sha256 });
        const entry = findings.get(id) ?? { f: { id, key, ecosystem, name: pkg.name, version: pkg.version, advisories: { ids, aliases, modified }, certainty, database: { sha256: db.sha256, sourceLastModified: db.sourceLastModified } }, occ: new Map() };
        entry.occ.set(target.relativePath, { relativePath: target.relativePath, artifact: target.artifact });
        findings.set(id, entry);
      }
    }
  }

  // Packages the engine dropped from matching as local or unscannable. It does not say which; any beyond the ones this
  // reading already treats as unversioned leave every file short of complete.
  const filtered = Number.isSafeInteger(record.filtered) && record.filtered > 0 ? record.filtered as number : 0;
  const explained = components.filter(c => c.version === null).length;
  const unexplainedSkips = filtered > explained;
  const coverage: OsvCoverage[] = job.targets.map(t => {
    if (!verified.has(t.index)) return sentRow(t, 'error', 'sentinel.osv.coverage.inputMismatch');
    const mine = components.filter(c => c.relativePath === t.relativePath);
    const unassessed = mine.filter(c => !c.assessed).length;
    // A component the engine was expected to match, of an ecosystem whose database it never loaded: nothing matched.
    if (mine.some(c => !c.skippedByEngine && c.version !== null && !loaded.has(c.ecosystem))) return sentRow(t, 'error', 'sentinel.osv.coverage.databaseNotLoaded', [], mine.length, unassessed);
    const limits: OsvCoverageReason[] = [];
    if (KIND_ECOSYSTEMS[t.kind].some(e => dbOf.get(e)?.freshness === 'stale')) limits.push('sentinel.osv.coverage.databaseStale');
    if (mine.some(c => !c.assessed && !c.skippedByEngine)) limits.push('sentinel.osv.coverage.versionsUnknown');
    if (t.kind === 'maven-pom') limits.push('sentinel.osv.coverage.transitivesNotResolved');
    if (unexplainedSkips || mine.some(c => c.skippedByEngine)) limits.push('sentinel.osv.coverage.componentsSkipped');
    if (!reported.has(t.index)) return sentRow(t, 'empty', 'sentinel.osv.coverage.noComponents', limits);
    if (limits[0] === 'sentinel.osv.coverage.databaseStale') return sentRow(t, 'database-stale', limits[0], limits, mine.length, unassessed);
    if (limits.length) return sentRow(t, 'partial', limits[0]!, limits, mine.length, unassessed);
    return sentRow(t, 'complete', 'sentinel.osv.coverage.complete', [], mine.length, 0);
  });
  const sortedFindings = [...findings.values()].map(e => ({ ...e.f, occurrences: [...e.occ.values()].sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1)) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return deepFreeze({ ...base, platform, engineExit: exit, engineFailure, components, findings: sortedFindings, coverage: [...coverage, ...unsentRows], refused });
}

export interface AdvisoryChange {
  readonly key: string;
  readonly change: 'new' | 'resolved';
  /** Why: the same component in the same captured bytes met a different advisory snapshot, or the source changed. */
  readonly because: 'advisory-database-changed' | 'source-changed';
  readonly from: { readonly database: string | null; readonly artifacts: readonly string[] };
  readonly to: { readonly database: string | null; readonly artifacts: readonly string[] };
}

/** Explains how findings moved between two assessments. */
export function explainAdvisoryChanges(previous: OsvRunResult, next: OsvRunResult): readonly AdvisoryChange[] {
  const keyed = (r: OsvRunResult) => new Map(r.findings.map(f => [f.key, f]));
  const prev = keyed(previous), cur = keyed(next);
  const artifactsOf = (r: OsvRunResult, ecosystem: string, name: string, version: string) =>
    r.components.filter(c => c.ecosystem === ecosystem && c.name === name && c.version === version).map(c => c.artifact).sort();
  const dbOf = (r: OsvRunResult, ecosystem: string) => r.databases.find(d => d.ecosystem === ecosystem)?.sha256 ?? null;
  const out: AdvisoryChange[] = [];
  const explain = (change: 'new' | 'resolved', f: OsvFinding) => {
    const a = artifactsOf(previous, f.ecosystem, f.name, f.version), b = artifactsOf(next, f.ecosystem, f.name, f.version);
    const sameSource = a.length > 0 && a.join() === b.join();
    out.push({ key: f.key, change, because: sameSource ? 'advisory-database-changed' : 'source-changed',
      from: { database: dbOf(previous, f.ecosystem), artifacts: a }, to: { database: dbOf(next, f.ecosystem), artifacts: b } });
  };
  for (const [k, f] of cur) if (!prev.has(k)) explain('new', f);
  for (const [k, f] of prev) if (!cur.has(k)) explain('resolved', f);
  return deepFreeze(out);
}
