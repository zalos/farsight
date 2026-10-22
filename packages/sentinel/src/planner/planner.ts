// The deterministic planner. Pure: the same inputs give the same plan revision, byte for byte, with no clock, file,
// ledger or network access. Two kinds of revision:
//
// - bootstrap: capture → parse (one unit per source) → inventory. It pins the profile's stage identities.
// - analysis: every check the policy's rules imply over the captured and parsed snapshot, with its state. Checks
//   the profile can run are batched into physical work units; a unit covers exactly the checks it lists. Every
//   other check stays in the plan with its reason (unsupported, applicability unknown, scope unavailable or
//   unknown), so nothing is dropped and nothing unplanned can be reported as covered.
//
// A revision is frozen and carries a digest of its content. A new rule lock or policy produces a new analysis
// revision (or a child run's first one) that depends on the already published bootstrap work, never a recapture,
// and never changes an earlier revision.
import type { Digest, Id, WorkRef } from '../contracts/common.js';
import type { CaptureEntry } from '../contracts/snapshot.js';
import { digestOf } from '../store/ledger-json.js';
import { validateEnvelope } from '../validate.js';
import type { NodeKind } from '@farsight/graph';
import { PlanError, type PlanReasonCode } from './errors.js';
import {
  CHECK_STATES, DEFAULT_PLANNER_LIMITS, PLAN_SCHEMA,
  type CheckState, type PlanPins, type PlanRevision, type PlanStage, type PlannedCheck, type PlannedWork, type PlannerAnalysis,
  type PlannerLanguage, type PlannerLimits, type PlannerPolicy, type PlannerProfile, type PlannerRule, type PlannerRuleLock,
  type PlannerScopeKind, type PlannerSnapshot, type RuleGap,
} from './types.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const shortHash = (value: unknown) => digestOf(value).slice(7, 31);
const invalid = (detail: string) => new PlanError('sentinel.plan.invalidInput', detail);

function checkId(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length > 128 || !ID.test(value)) throw invalid(`${what} is not an id`);
  return value;
}
function checkDigest(value: unknown, what: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw invalid(`${what} is not a sha256 digest`);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const byKey = <T>(key: (t: T) => string) => (a: T, b: T) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : 0; };

// ---- scope recognition ----

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, PlannerLanguage>> = Object.freeze({
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.java': 'java',
});

/** The language of a source path, by its extension; undefined for anything else. */
export function languageOf(path: string): PlannerLanguage | undefined {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot < path.lastIndexOf('/')) return undefined;
  const ext = path.slice(dot).toLowerCase();
  return path.toLowerCase().endsWith('.d.ts') ? 'typescript' : LANGUAGE_BY_EXTENSION[ext];
}

/** Dependency manifests and lockfiles, by file name, with the languages whose rules they serve. */
const MANIFESTS: Readonly<Record<string, readonly PlannerLanguage[]>> = Object.freeze({
  'package.json': ['typescript', 'javascript'], 'package-lock.json': ['typescript', 'javascript'],
  'npm-shrinkwrap.json': ['typescript', 'javascript'], 'pnpm-lock.yaml': ['typescript', 'javascript'],
  'yarn.lock': ['typescript', 'javascript'], 'pom.xml': ['java'], 'build.gradle': ['java'],
  'build.gradle.kts': ['java'], 'gradle.lockfile': ['java'],
});

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const isCiConfig = (path: string) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) || path === '.gitlab-ci.yml';

/** Whether a captured path is a scope of the given kind for a rule with these languages. */
function scopeOfKind(kind: PlannerScopeKind, path: string, languages: readonly PlannerLanguage[]): boolean {
  if (kind === 'source-file') { const l = languageOf(path); return l !== undefined && languages.includes(l); }
  if (kind === 'dependency-manifest') { const m = MANIFESTS[baseName(path)]; return m !== undefined && m.some(l => languages.includes(l)); }
  if (kind === 'ci-config') return isCiConfig(path);
  return false;
}

// ---- dependency graph ----

/**
 * Refuses a dependency cycle, or a dependency on work that is neither in `work` nor among `external` (published by
 * an earlier plan). Kahn's algorithm over (id, revision) pairs.
 */
export function checkWorkGraph(work: readonly Pick<PlannedWork, 'id' | 'revision' | 'dependencies'>[], external: readonly WorkRef[] = []): void {
  const key = (r: WorkRef) => `${r.id}@${r.revision}`;
  const known = new Set(work.map(w => key(w)));
  if (known.size !== work.length) throw invalid('a work unit appears twice');
  const outside = new Set(external.map(key));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const w of work) {
    let n = 0;
    for (const d of w.dependencies) {
      const k = key(d);
      if (known.has(k)) { n++; (dependents.get(k) ?? dependents.set(k, []).get(k)!).push(key(w)); }
      else if (!outside.has(k)) throw new PlanError('sentinel.plan.unknownDependency', `${key(w)} → ${k}`);
    }
    indegree.set(key(w), n);
  }
  const ready = [...indegree].filter(([, n]) => n === 0).map(([k]) => k);
  let done = 0;
  while (ready.length) {
    const k = ready.pop()!;
    done++;
    for (const next of dependents.get(k) ?? []) {
      const n = indegree.get(next)! - 1;
      indegree.set(next, n);
      if (n === 0) ready.push(next);
    }
  }
  if (done !== work.length) {
    throw new PlanError('sentinel.plan.cycle', [...indegree].filter(([, n]) => n > 0).map(([k]) => k).sort().slice(0, 8).join(', '));
  }
}

// ---- revisions ----

/**
 * Seals a revision: tallies, the digest, then the canonical contract's schema and invariants. A planner bug that
 * produced an inconsistent plan is refused here rather than handed to the coordinator.
 */
function seal(body: Omit<PlanRevision, 'digest' | 'tallies' | 'requiredCoverageAchievable'>): PlanRevision {
  checkWorkGraph(body.units, body.reused);
  const checks = Object.fromEntries(CHECK_STATES.map(s => [s, 0])) as Record<CheckState, number>;
  let required = 0, requiredNotPlanned = 0;
  for (const c of body.checks) {
    checks[c.state]++;
    if (c.required) { required++; if (c.state !== 'planned') requiredNotPlanned++; }
  }
  requiredNotPlanned += body.ruleGaps.filter(g => g.required).length;
  const full = { ...body, tallies: { checks, required, requiredNotPlanned, units: body.units.length }, requiredCoverageAchievable: requiredNotPlanned === 0 };
  const sealed = { ...full, digest: digestOf(full) };
  const checked = validateEnvelope('plan', sealed);
  if (!checked.ok) throw invalid(`the plan is not a valid ${PLAN_SCHEMA}: ${checked.errors[0]?.path || '/'} ${checked.errors[0]?.message ?? ''}`);
  return deepFreeze(sealed);
}

function chainFrom(previous: PlanRevision | null, runId: string, revision: number): Digest | null {
  if (!Number.isSafeInteger(revision) || revision < 1) throw invalid('revision is not a positive ordinal');
  if (!previous) {
    if (revision !== 1) throw invalid('a revision after the first names its previous revision');
    return null;
  }
  if (previous.runId !== runId) throw new PlanError('sentinel.plan.pinMismatch', 'the previous revision belongs to another run');
  if (revision !== previous.revision + 1) throw invalid(`revision ${revision} does not follow ${previous.revision}`);
  if (previous.digest !== digestOf((({ digest: _d, ...rest }) => rest)(previous))) throw new PlanError('sentinel.plan.pinMismatch', 'the previous revision does not match its digest');
  return previous.digest;
}

export interface BootstrapRequest {
  readonly runId: Id;
  readonly revision?: number;
  readonly previous?: PlanRevision | null;
  readonly sourceIds: readonly Id[];
  readonly profile: PlannerProfile;
}

/** The bootstrap revision: one capture, a parse per source after it, and the inventory after every parse. */
export function planBootstrap(request: BootstrapRequest): PlanRevision {
  const runId = checkId(request.runId, 'run id');
  const revision = request.revision ?? 1;
  const previous = chainFrom(request.previous ?? null, runId, revision);
  const sources = [...new Set(request.sourceIds.map(s => checkId(s, 'source id')))].sort();
  if (sources.length === 0 || sources.length !== request.sourceIds.length) throw invalid('source ids are one or more distinct ids');
  const stages = request.profile.stages;
  for (const [k, v] of Object.entries(stages)) checkDigest(v, `the ${k} stage`);
  const unit = (stage: PlanStage, sourceId: Id | null, dependencies: WorkRef[]): PlannedWork => {
    const implementationDigest = stages[stage as 'capture' | 'parse' | 'inventory'];
    const inputFingerprint = digestOf({ stage, sourceId, sources, implementationDigest, dependencies });
    return { id: `work-${stage}-${shortHash({ runId, revision, stage, sourceId })}`, revision: 1, stage, contract: `sentinel.stage.${stage}`,
      implementationDigest, sourceId, adapterId: null, dependencies, inputFingerprint, checks: [], scopes: [], inputs: [] };
  };
  const capture = unit('capture', null, []);
  const parses = sources.map(s => unit('parse', s, [{ id: capture.id, revision: 1 }]));
  const inventory = unit('inventory', null, parses.map(p => ({ id: p.id, revision: 1 })));
  return seal({
    schema: PLAN_SCHEMA, runId, revision, kind: 'bootstrap', previous,
    pins: { snapshotId: null, inventoryDigest: null, environment: null, ruleLockDigest: null, policyDigest: null,
      profileId: checkId(request.profile.id, 'profile id'), rules: [], tools: [], databases: [], analyses: [], stages: { ...stages } },
    reused: [], units: [capture, ...parses, inventory], checks: [], ruleGaps: [],
  });
}

export interface AnalysisRequest {
  readonly runId: Id;
  readonly revision?: number;
  readonly previous?: PlanRevision | null;
  /**
   * Published bootstrap work this revision depends on (the inventory unit, from this run or a parent run). Its
   * output is reused as published: planning a new rule never recaptures or reparses.
   */
  readonly bootstrap: readonly WorkRef[];
  readonly snapshot: PlannerSnapshot;
  readonly analyses: readonly PlannerAnalysis[];
  readonly lock: PlannerRuleLock;
  readonly policy: PlannerPolicy;
  readonly profile: PlannerProfile;
  readonly limits?: Partial<PlannerLimits>;
}

interface Candidate { scopeKind: PlannerScopeKind; scopeId: string; sourceId: string; path: string | null; entry?: CaptureEntry; boundary?: boolean }

/** Every check the policy's locked rules imply over the snapshot, in a frozen analysis revision. */
export function planAnalysis(request: AnalysisRequest): PlanRevision {
  const runId = checkId(request.runId, 'run id');
  const revision = request.revision ?? 1;
  const previous = chainFrom(request.previous ?? null, runId, revision);
  const limits = { ...DEFAULT_PLANNER_LIMITS, ...request.limits };
  for (const [k, v] of Object.entries(limits)) if (!Number.isSafeInteger(v) || v < 1 || v > (DEFAULT_PLANNER_LIMITS as unknown as Record<string, number>)[k]!) throw invalid(`${k} must be 1..${(DEFAULT_PLANNER_LIMITS as unknown as Record<string, number>)[k]}`);
  const { snapshot, lock, policy, profile } = request;
  if (request.bootstrap.length === 0) throw invalid('an analysis revision depends on published bootstrap work');
  for (const r of request.bootstrap) checkId(r.id, 'bootstrap work id');
  checkId(snapshot.id, 'snapshot id');
  const environment = checkDigest(snapshot.environmentProfileDigest, 'environment profile');
  checkDigest(snapshot.inventoryDigest, 'inventory digest');
  checkDigest(lock.digest, 'rule lock');
  checkDigest(policy.digest, 'policy');
  const sourceIds = snapshot.sources.map(s => checkId(s.sourceId, 'source id'));
  const analyses = new Map(request.analyses.map(a => [a.sourceId, a]));
  if (analyses.size !== request.analyses.length) throw invalid('one analysis per source');
  for (const s of sourceIds) if (!analyses.has(s)) throw new PlanError('sentinel.plan.pinMismatch', `no parser analysis for source ${s}`);
  for (const a of analyses.keys()) if (!sourceIds.includes(a)) throw new PlanError('sentinel.plan.pinMismatch', `analysis for source ${a} is not in the snapshot`);

  // The policy selects rules; the lock pins them.
  const locked = new Map<string, PlannerRule>();
  for (const r of lock.rules) {
    if (locked.has(r.familyId)) throw invalid(`the lock pins ${r.familyId} twice`);
    checkDigest(r.definitionDigest, `${r.familyId} definition`);
    checkDigest(r.packDigest, `${r.familyId} pack`);
    locked.set(r.familyId, r);
  }
  const tools = new Map(lock.tools.map(t => [t.adapterId, t.artifactDigest]));
  const builtIn = new Map(profile.builtInAdapters.map(a => [a.adapterId, a.implementationDigest]));
  const capabilities = new Map(profile.capabilities.map(c => [c.capability, c]));
  const requiredCaps = new Set(policy.requiredCapabilities);
  const ruleGaps: RuleGap[] = [];
  const selected: Array<{ rule: PlannerRule; mandatory: boolean }> = [];
  for (const p of [...policy.rules].sort(byKey(r => r.familyId))) {
    const rule = locked.get(p.familyId);
    const mandatory = p.source !== 'requested';
    if (!rule) { ruleGaps.push({ familyId: p.familyId, required: mandatory || policy.requireCompleteCoverage, reasonCode: 'sentinel.plan.ruleNotLocked' }); continue; }
    selected.push({ rule, mandatory });
  }

  // Framework resolution per source: resolved where a lockfile in that source names it; unknown where any entry is.
  const resolved = new Map<string, Set<string>>();
  const unknown = new Set<string>();
  for (const f of snapshot.frameworkVersions) {
    const name = f.framework.toLowerCase();
    if (f.state === 'resolved') (resolved.get(f.provenance.sourceId) ?? resolved.set(f.provenance.sourceId, new Set()).get(f.provenance.sourceId)!).add(name);
    else unknown.add(name);
  }

  const checks: PlannedCheck[] = [];
  /** The captured file each planned check reads (none for a repository scope). */
  const readsFile = new Map<string, string>();
  /** Each included file's content artifact, keyed by source and path. */
  const contentOf = new Map<string, string>();
  for (const e of snapshot.entries) if (e.kind === 'file' && e.disposition === 'included') contentOf.set(`${e.sourceId}\u0000${e.relativePath}`, e.content);
  const add = (c: Omit<PlannedCheck, 'id' | 'environment' | 'mode'>, path: string | null) => {
    if (checks.length >= limits.maxChecks) throw new PlanError('sentinel.plan.tooManyChecks', String(limits.maxChecks));
    const id = `chk-${shortHash({ scope: c.scopeId, family: c.familyId, revision: c.ruleRevision, environment, mode: 'deterministic' })}`;
    checks.push({ ...c, id, environment, mode: 'deterministic' });
    if (c.state === 'planned' && path !== null) readsFile.set(id, path);
  };

  const fileClass = new Map<string, Map<string, string>>(
    [...analyses].map(([s, a]) => [s, new Map(a.files.map(f => [f.path, f.class]))]));

  for (const { rule, mandatory } of selected) {
    const candidates: Candidate[] = [];
    for (const sourceId of sourceIds) {
      if (rule.scopeKind === 'repository') candidates.push({ scopeKind: 'repository', scopeId: sourceId, sourceId, path: null });
      else if (rule.scopeKind === 'surface') {
        for (const s of analyses.get(sourceId)!.surfaces) {
          const l = languageOf(s.path);
          if (l && rule.languages.includes(l)) candidates.push({ scopeKind: 'surface', scopeId: s.nodeId, sourceId, path: s.path });
        }
      }
    }
    if (rule.scopeKind !== 'repository' && rule.scopeKind !== 'surface') {
      for (const entry of snapshot.entries) {
        if (!sourceIds.includes(entry.sourceId)) continue;
        if (entry.kind === 'directory-boundary') {
          // A deliberate exclusion is out of scope; a folder that could not be listed is unknown scope.
          if (entry.disposition !== 'excluded' && entry.knownDescendants !== 0) {
            candidates.push({ scopeKind: rule.scopeKind, scopeId: `${entry.sourceId}:${entry.relativePath}/`, sourceId: entry.sourceId, path: entry.relativePath, entry, boundary: true });
          }
          continue;
        }
        if (entry.kind !== 'file' || !scopeOfKind(rule.scopeKind, entry.relativePath, rule.languages)) continue;
        if (entry.disposition === 'excluded') continue;
        candidates.push({ scopeKind: rule.scopeKind, scopeId: `${entry.sourceId}:${entry.relativePath}`, sourceId: entry.sourceId, path: entry.relativePath, entry });
      }
    }
    const requiresRequired = rule.requires.some(c => requiredCaps.has(c));
    const required = mandatory || policy.requireCompleteCoverage || requiresRequired;
    const missingCapability = rule.requires.map(c => capabilities.get(c)).find(c => !c?.available);
    const missingName = rule.requires.find(c => !capabilities.get(c)?.available);
    const needsParse = rule.requires.some(c => capabilities.get(c)?.perFileParse);
    const adapterKnown = tools.has(rule.adapterId) || builtIn.has(rule.adapterId);
    for (const c of candidates.sort(byKey(x => x.scopeId))) {
      const base = { familyId: rule.familyId, ruleRevision: rule.revision, scopeKind: c.scopeKind, scopeId: c.scopeId, sourceId: c.sourceId, required };
      const state = (s: CheckState, reasonCode?: string) => add(reasonCode ? { ...base, state: s, reasonCode } : { ...base, state: s }, c.path);
      if (rule.frameworks?.length) {
        const names = rule.frameworks.map(f => f.toLowerCase());
        const here = resolved.get(c.sourceId);
        if (!names.some(n => here?.has(n))) {
          // An unresolved version anywhere is unknown for every source (a snapshot's unknown entry names no source).
          // No entry at all is not evidence the framework is absent: it is recorded as not detected, never skipped.
          state('applicability-unknown', names.some(n => unknown.has(n)) ? 'sentinel.plan.frameworkUnresolved' : 'sentinel.plan.frameworkNotDetected');
          continue;
        }
      }
      if (c.boundary) { state('scope-unknown', 'sentinel.plan.unknownDescendants'); continue; }
      if (c.entry && c.entry.kind === 'file' && c.entry.disposition !== 'included') { state('scope-unavailable', c.entry.reasonCode); continue; }
      if (!adapterKnown) { state('unsupported', 'sentinel.plan.adapterNotLocked' satisfies PlanReasonCode); continue; }
      if (missingName !== undefined) { state('unsupported', missingCapability?.reasonCode ?? 'sentinel.plan.capabilityUnavailable'); continue; }
      if (needsParse && c.path !== null && fileClass.get(c.sourceId)!.get(c.path) !== 'parsed') { state('scope-unavailable', 'sentinel.plan.parseRequired'); continue; }
      if (c.path !== null && !contentOf.has(`${c.sourceId}\u0000${c.path}`)) { state('scope-unavailable', 'sentinel.plan.inputNotCaptured'); continue; }
      state('planned');
    }
  }
  checks.sort(byKey(c => c.id));
  for (let i = 1; i < checks.length; i++) if (checks[i]!.id === checks[i - 1]!.id) throw invalid(`check ${checks[i]!.id} is planned twice`);

  // Physical batching: one adapter over one source's scopes, bounded. A unit lists exactly the checks it covers.
  const rulePin = new Map(selected.map(({ rule }) => [rule.familyId, rule]));
  const groups = new Map<string, PlannedCheck[]>();
  for (const c of checks) {
    if (c.state !== 'planned') continue;
    const k = `${rulePin.get(c.familyId)!.adapterId}\u0000${c.sourceId}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
  }
  const work: PlannedWork[] = [];
  const assigned = new Map<string, string>();
  for (const k of [...groups.keys()].sort()) {
    const [adapterId, sourceId] = k.split('\u0000') as [string, string];
    const members = groups.get(k)!.sort(byKey(c => `${c.scopeId}\u0000${c.familyId}`));
    let batch: PlannedCheck[] = [];
    let scopes = new Set<string>();
    let files = new Set<string>();
    const flush = () => {
      if (!batch.length) return;
      if (work.length >= limits.maxWork) throw new PlanError('sentinel.plan.tooMuchWork', String(limits.maxWork));
      const ids = batch.map(c => c.id).sort();
      const families = [...new Set(batch.map(c => c.familyId))].sort();
      const implementationDigest = tools.get(adapterId) ?? builtIn.get(adapterId)!;
      const needsDatabases = families.some(f => rulePin.get(f)!.requires.includes('advisory-database'));
      const inputFingerprint = digestOf({
        inventory: snapshot.inventoryDigest, environment, analysis: analyses.get(sourceId)!.analysisFingerprint,
        rules: families.map(f => { const r = rulePin.get(f)!; return [r.familyId, r.revision, r.definitionDigest, r.packDigest]; }),
        adapterId, implementationDigest, scopes: [...scopes].sort(),
        inputs: [...files].sort().map(f => [f, contentOf.get(`${sourceId}\u0000${f}`)!]),
        databases: needsDatabases ? lock.databases.map(d => [d.databaseId, d.snapshotDigest]).sort() : [],
      });
      const id = `work-check-${shortHash({ runId, revision, adapterId, sourceId, checks: ids })}`;
      work.push({ id, revision: 1, stage: 'check', contract: `sentinel.stage.check.${adapterId}`, implementationDigest, sourceId, adapterId,
        dependencies: [...request.bootstrap].map(r => ({ id: r.id, revision: r.revision })).sort(byKey(r => `${r.id}@${r.revision}`)),
        inputFingerprint, checks: ids, scopes: [...scopes].sort(),
        inputs: [...files].sort().map(relativePath => ({ sourceId, relativePath, content: contentOf.get(`${sourceId}\u0000${relativePath}`)! })) });
      for (const c of ids) assigned.set(c, id);
      batch = []; scopes = new Set(); files = new Set();
    };
    for (const c of members) {
      const path = readsFile.get(c.id);
      if (batch.length >= limits.maxChecksPerWork || (!scopes.has(c.scopeId) && scopes.size >= limits.maxScopesPerWork)
        || (path !== undefined && !files.has(path) && files.size >= limits.maxScopesPerWork)) flush();
      batch.push(c);
      scopes.add(c.scopeId);
      if (path !== undefined) files.add(path);
    }
    flush();
  }
  const finalChecks = checks.map(c => (c.state === 'planned' ? { ...c, unit: { id: assigned.get(c.id)!, revision: 1 } } : c));
  work.sort(byKey(w => w.id));

  const pins: PlanPins = {
    snapshotId: snapshot.id, inventoryDigest: snapshot.inventoryDigest, environment, ruleLockDigest: lock.digest, policyDigest: policy.digest,
    profileId: checkId(profile.id, 'profile id'),
    rules: selected.map(({ rule: r }) => ({ familyId: r.familyId, revision: r.revision, definitionDigest: r.definitionDigest, packDigest: r.packDigest })),
    tools: [...lock.tools].map(t => ({ adapterId: t.adapterId, artifactDigest: t.artifactDigest })).sort(byKey(t => t.adapterId)),
    databases: [...lock.databases].map(d => ({ databaseId: d.databaseId, snapshotDigest: d.snapshotDigest })).sort(byKey(d => d.databaseId)),
    analyses: [...analyses.values()].map(a => ({ sourceId: a.sourceId, analysisFingerprint: a.analysisFingerprint })).sort(byKey(a => a.sourceId)),
    stages: { ...profile.stages },
  };
  return seal({
    schema: PLAN_SCHEMA, runId, revision, kind: 'analysis', previous, pins,
    reused: [...request.bootstrap].map(r => ({ id: r.id, revision: r.revision })).sort(byKey(r => `${r.id}@${r.revision}`)),
    units: work, checks: finalChecks, ruleGaps,
  });
}

/** Recomputes a revision's digest: true only when no field was changed after sealing. */
export function verifyPlanRevision(plan: PlanRevision): boolean {
  const { digest, ...rest } = plan;
  return digest === digestOf(rest);
}

/**
 * The graph kinds that are surfaces (`@farsight/graph` NodeKind): `route`, an HTTP endpoint, and `page`, an
 * application/UI route. A handler is the function a route reaches, not a surface of its own; components, classes,
 * guards and every other kind are not surfaces.
 */
export const SURFACE_NODE_KINDS: readonly NodeKind[] = Object.freeze(['route', 'page'] as const);

/** Surfaces from parser index nodes, by an explicit allowlist of graph kinds (default SURFACE_NODE_KINDS). */
export function surfacesFromIndex(
  index: { readonly nodes: readonly { readonly nodeId: string; readonly kind: string; readonly path: string }[] },
  kinds: readonly string[] = SURFACE_NODE_KINDS,
): PlannerAnalysis['surfaces'] {
  const allowed = new Set(kinds);
  return index.nodes.filter(n => allowed.has(n.kind)).map(n => ({ nodeId: n.nodeId, path: n.path, kind: n.kind }))
    .sort(byKey(n => n.nodeId));
}
