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
import { pathRequestOf, PATHS_ADAPTER_ID } from '../analysis/paths/request.js';
import type { PathRequestEnvelope } from '../contracts/pathrequest.js';
import type { CaptureEntry } from '../contracts/snapshot.js';
import { digestOf } from '../store/ledger-json.js';
import { validateEnvelope } from '../validate.js';
import type { NodeKind } from '@farsight/graph';
import { PlanError, type PlanReasonCode } from './errors.js';
import { capabilityOf, isCapabilityTable } from './capabilities.js';
import {
  bootstrapUnitIdOf,
  checkIdOf,
  checkUnitIdOf,
  deepFreeze,
  isTrustedView,
  reviewUnitIdOf,
  scriptUnitIdOf,
} from './identity.js';
import {
  crossStageDependencies,
  declaredAnalysis,
  requireBootstrap,
  scriptFingerprintOf,
  SCRIPT_CONTRACT,
  stageModel,
  type AgentUnitSeed,
  type DeclaredAnalysis,
} from './pipeline.js';
import type { PipelineDefinition } from '../contracts/pipeline.js';
import {
  CHECK_STATES,
  DEFAULT_PLANNER_LIMITS,
  PLAN_SCHEMA,
  type CheckState,
  type PlanPins,
  type PlanRevision,
  type PlannedCheck,
  type PlannedWork,
  type PlannerAnalysis,
  type PlannerLanguage,
  type PlannerLimits,
  type PlannerPolicy,
  type PlannerProfile,
  type PlannerRule,
  type PlannerRuleLock,
  type PlannerScopeKind,
  type PlannerSnapshot,
  type RuleGap,
} from './types.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const invalid = (detail: string) => new PlanError('sentinel.plan.invalidInput', detail);

function checkId(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length > 128 || !ID.test(value)) throw invalid(`${what} is not an id`);
  return value;
}
function checkDigest(value: unknown, what: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw invalid(`${what} is not a sha256 digest`);
  return value;
}

const byKey =
  <T>(key: (t: T) => string) =>
  (a: T, b: T) => {
    const x = key(a),
      y = key(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };

// ---- scope recognition ----

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, PlannerLanguage>> = Object.freeze({
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
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
  'package.json': ['typescript', 'javascript'],
  'package-lock.json': ['typescript', 'javascript'],
  'npm-shrinkwrap.json': ['typescript', 'javascript'],
  'pnpm-lock.yaml': ['typescript', 'javascript'],
  'yarn.lock': ['typescript', 'javascript'],
  'pom.xml': ['java'],
  'build.gradle': ['java'],
  'build.gradle.kts': ['java'],
  'gradle.lockfile': ['java'],
});

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const isCiConfig = (path: string) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) || path === '.gitlab-ci.yml';
/**
 * Infrastructure configuration by file name: Dockerfiles and Containerfiles (with or without an extension, or as the
 * extension), Terraform (.tf, .tf.json) and YAML that may be a Kubernetes manifest. Whether a YAML file is one is the
 * engine's decision; a file it does not recognize is reported, not dropped.
 */
const isInfrastructureConfig = (path: string) => {
  const base = baseName(path).toLowerCase();
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot) : '';
  if (['dockerfile', 'containerfile'].some((w) => base === w + ext || ext === `.${w}`)) return true;
  return base.endsWith('.tf') || base.endsWith('.tf.json') || /\.ya?ml$/.test(base);
};

/** Whether a captured path is a scope of the given kind for a rule with these languages. */
function scopeOfKind(kind: PlannerScopeKind, path: string, languages: readonly PlannerLanguage[]): boolean {
  if (kind === 'source-file') {
    const l = languageOf(path);
    return l !== undefined && languages.includes(l);
  }
  if (kind === 'dependency-manifest') {
    const m = MANIFESTS[baseName(path)];
    return m !== undefined && m.some((l) => languages.includes(l));
  }
  if (kind === 'ci-config') return isCiConfig(path);
  if (kind === 'infrastructure-config') return isInfrastructureConfig(path);
  return false;
}

// ---- dependency graph ----

/**
 * Refuses a dependency cycle, or a dependency on work that is neither in `work` nor among `external` (published by
 * an earlier plan). Kahn's algorithm over (id, revision) pairs.
 */
export function checkWorkGraph(
  work: readonly Pick<PlannedWork, 'id' | 'revision' | 'dependencies'>[],
  external: readonly WorkRef[] = [],
): void {
  const key = (r: WorkRef) => `${r.id}@${r.revision}`;
  const known = new Set(work.map((w) => key(w)));
  if (known.size !== work.length) throw invalid('a work unit appears twice');
  const outside = new Set(external.map(key));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const w of work) {
    let n = 0;
    for (const d of w.dependencies) {
      const k = key(d);
      if (known.has(k)) {
        n++;
        (dependents.get(k) ?? dependents.set(k, []).get(k)!).push(key(w));
      } else if (!outside.has(k)) throw new PlanError('sentinel.plan.unknownDependency', `${key(w)} → ${k}`);
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
    throw new PlanError(
      'sentinel.plan.cycle',
      [...indegree]
        .filter(([, n]) => n > 0)
        .map(([k]) => k)
        .sort()
        .slice(0, 8)
        .join(', '),
    );
  }
}

// ---- revisions ----

/**
 * Seals a revision: tallies, the digest, then the canonical contract's schema and invariants. A planner bug that
 * produced an inconsistent plan is refused here rather than handed to the coordinator.
 */
function seal(body: Omit<PlanRevision, 'digest' | 'tallies' | 'requiredCoverageAchievable'>): PlanRevision {
  checkWorkGraph(body.units, body.reused);
  const checks = Object.fromEntries(CHECK_STATES.map((s) => [s, 0])) as Record<CheckState, number>;
  let required = 0,
    requiredNotPlanned = 0;
  for (const c of body.checks) {
    checks[c.state]++;
    if (c.required) {
      required++;
      if (c.state !== 'planned') requiredNotPlanned++;
    }
  }
  requiredNotPlanned += body.ruleGaps.filter((g) => g.required).length;
  const full = {
    ...body,
    tallies: { checks, required, requiredNotPlanned, units: body.units.length },
    requiredCoverageAchievable: requiredNotPlanned === 0,
  };
  const sealed = { ...full, digest: digestOf(full) };
  const checked = validateEnvelope('plan', sealed);
  if (!checked.ok)
    throw invalid(
      `the plan is not a valid ${PLAN_SCHEMA}: ${checked.errors[0]?.path || '/'} ${checked.errors[0]?.message ?? ''}`,
    );
  return deepFreeze(sealed);
}

function chainFrom(previous: PlanRevision | null, runId: string, revision: number): Digest | null {
  if (!Number.isSafeInteger(revision) || revision < 1) throw invalid('revision is not a positive ordinal');
  if (!previous) {
    if (revision !== 1) throw invalid('a revision after the first names its previous revision');
    return null;
  }
  if (previous.runId !== runId)
    throw new PlanError('sentinel.plan.pinMismatch', 'the previous revision belongs to another run');
  if (revision !== previous.revision + 1) throw invalid(`revision ${revision} does not follow ${previous.revision}`);
  if (previous.digest !== digestOf((({ digest: _d, ...rest }) => rest)(previous)))
    throw new PlanError('sentinel.plan.pinMismatch', 'the previous revision does not match its digest');
  return previous.digest;
}

function checkProfile(profile: PlannerProfile): PlannerProfile {
  checkId(profile?.id, 'profile id');
  if (!profile.registry || typeof profile.registry.get !== 'function' || !Array.isArray(profile.registry.ids))
    throw invalid('the profile names the trusted adapter registry');
  if (!isCapabilityTable(profile.capabilities))
    throw invalid('capabilities come only from a table createCapabilityTable built');
  return profile;
}

/** The registered adapters bound to the bootstrap stages; an unregistered binding is refused, an absent one is null. */
function operationPins(profile: PlannerProfile): PlanPins['operations'] {
  const pin = (id: Id | undefined) => {
    if (id === undefined) return null;
    if (!profile.registry.ids.includes(id)) throw invalid(`bootstrap operation ${id} is not in the trusted registry`);
    return { adapterId: id, digest: profile.registry.get(id).digest };
  };
  const o = profile.operations ?? {};
  return { capture: pin(o.capture), parse: pin(o.parse), inventory: pin(o.inventory) };
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
  const sources = [...new Set(request.sourceIds.map((s) => checkId(s, 'source id')))].sort();
  if (sources.length === 0 || sources.length !== request.sourceIds.length)
    throw invalid('source ids are one or more distinct ids');
  const profile = checkProfile(request.profile);
  const operations = operationPins(profile);
  const unit = (
    stage: 'capture' | 'parse' | 'inventory',
    sourceId: Id | null,
    dependencies: WorkRef[],
  ): PlannedWork => {
    const bound = operations[stage];
    // An unbound stage keeps a deterministic identity of "no operation" and is blocked at hand-off, never run.
    const implementationDigest = bound?.digest ?? digestOf({ unbound: `sentinel.stage.${stage}` });
    const inputFingerprint = digestOf({
      stage,
      sourceId,
      sources,
      implementationDigest,
      adapterId: bound?.adapterId ?? null,
      dependencies,
    });
    return {
      id: bootstrapUnitIdOf({ runId, revision, stage, sourceId }),
      revision: 1,
      stage,
      contract: `sentinel.stage.${stage}`,
      implementationDigest,
      sourceId,
      adapterId: bound?.adapterId ?? null,
      dependencies,
      inputFingerprint,
      checks: [],
      scopes: [],
      inputs: [],
      inputSetDigest: digestOf([]),
    };
  };
  const capture = unit('capture', null, []);
  const parses = sources.map((s) => unit('parse', s, [{ id: capture.id, revision: 1 }]));
  const inventory = unit(
    'inventory',
    null,
    parses.map((p) => ({ id: p.id, revision: 1 })),
  );
  return seal({
    schema: PLAN_SCHEMA,
    runId,
    revision,
    kind: 'bootstrap',
    previous,
    pins: {
      snapshotId: null,
      inventoryDigest: null,
      environment: null,
      ruleLockDigest: null,
      policyDigest: null,
      profileId: checkId(profile.id, 'profile id'),
      rules: [],
      tools: [],
      databases: [],
      analyses: [],
      operations,
      adapters: Object.values(operations)
        .filter((o): o is { adapterId: Id; digest: Digest } => o !== null)
        .filter((o, i, all) => all.findIndex((x) => x.adapterId === o.adapterId) === i)
        .sort(byKey((o) => o.adapterId)),
      capabilities: [],
    },
    reused: [],
    units: [capture, ...parses, inventory],
    checks: [],
    ruleGaps: [],
  });
}

export interface AnalysisRequest {
  /** Optional structural task data. Requires independent store admission proof of its exact retained ancestor. */
  readonly pathRequest?: PathRequestEnvelope;
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

interface Candidate {
  scopeKind: PlannerScopeKind;
  scopeId: string;
  sourceId: string;
  path: string | null;
  entry?: CaptureEntry;
  boundary?: boolean;
  repositoryGap?: boolean;
  undiscovered?: boolean;
  frontier?: PlanReasonCode;
}

/** Every check the policy's locked rules imply over the snapshot, in a frozen analysis revision. */
export function planAnalysis(request: AnalysisRequest): PlanRevision {
  return planAnalysisOf(request, null);
}

/** The bootstrap revision of a declared pipeline: its capture, parse and inventory stages, planned as planBootstrap does. */
export function planPipelineBootstrap(
  request: BootstrapRequest & { readonly pipeline: PipelineDefinition },
): PlanRevision {
  const { pipeline, ...rest } = request;
  requireBootstrap(stageModel(pipeline));
  return planBootstrap(rest);
}

/**
 * The analysis revision of a declared pipeline (pipeline.ts): its check stages select rules from the same matrix
 * planAnalysis builds, a rule no stage selects stays as `unsupported` with sentinel.plan.stageNotDeclared, stage
 * ordering becomes unit dependencies, and each review seed is placed as a unit of the agent stage declaring its
 * fan-out. The revision is sealed once.
 */
export function planPipelineAnalysis(
  request: AnalysisRequest & {
    readonly pipeline: PipelineDefinition;
    readonly agents?: readonly AgentUnitSeed[];
    /** Each script stage's entry, by the digest of the bytes the owner adopted (keyed by stage id). */
    readonly scripts?: ReadonlyMap<string, Digest>;
  },
): PlanRevision {
  const { pipeline, agents, scripts, ...rest } = request;
  const model = stageModel(pipeline);
  requireBootstrap(model);
  return planAnalysisOf(rest, {
    analysis: declaredAnalysis(model),
    agents: agents ?? [],
    scripts: scripts ?? new Map(),
  });
}

/** At most this many review units in one revision (the review side's bound, review/plan.ts). */
const MAX_AGENT_UNITS = 32;

function planAnalysisOf(
  request: AnalysisRequest,
  declared: {
    readonly analysis: DeclaredAnalysis;
    readonly agents: readonly AgentUnitSeed[];
    readonly scripts: ReadonlyMap<string, Digest>;
  } | null,
): PlanRevision {
  const runId = checkId(request.runId, 'run id');
  const revision = request.revision ?? 1;
  const previous = chainFrom(request.previous ?? null, runId, revision);
  const limits = { ...DEFAULT_PLANNER_LIMITS, ...request.limits };
  for (const [k, v] of Object.entries(limits))
    if (!Number.isSafeInteger(v) || v < 1 || v > (DEFAULT_PLANNER_LIMITS as unknown as Record<string, number>)[k]!)
      throw invalid(`${k} must be 1..${(DEFAULT_PLANNER_LIMITS as unknown as Record<string, number>)[k]}`);
  const { snapshot, lock, policy } = request;
  let pathRequest: ReturnType<typeof pathRequestOf> | undefined;
  if (request.pathRequest !== undefined) {
    try {
      pathRequest = pathRequestOf(request.pathRequest);
    } catch {
      throw invalid('the structural path request is malformed or exceeds its bounds');
    }
    if (
      pathRequest.value.snapshotId !== snapshot.id ||
      !snapshot.sources.some((s) => s.sourceId === pathRequest!.value.sourceId) ||
      pathRequest.value.ancestor.runId === runId
    )
      throw new PlanError(
        'sentinel.plan.pinMismatch',
        'the structural request does not name an ancestor over this captured source',
      );
  }
  // Only the adapters' frozen derivations may carry a lock pin, a policy revision, a snapshot or analysis identity.
  for (const [what, view] of [
    ['rule lock', lock],
    ['policy', policy],
    ['snapshot', snapshot],
    ...request.analyses.map((a) => ['parser analysis', a] as const),
  ] as const) {
    if (!isTrustedView(view))
      throw new PlanError(
        'sentinel.plan.pinMismatch',
        `the ${what} is accepted only as its planner adapter derived it`,
      );
  }
  const profile = checkProfile(request.profile);
  const operations = operationPins(profile);
  const permits = new Set(profile.permits);
  if (request.bootstrap.length === 0) throw invalid('an analysis revision depends on published bootstrap work');
  for (const r of request.bootstrap) checkId(r.id, 'bootstrap work id');
  checkId(snapshot.id, 'snapshot id');
  const environment = checkDigest(snapshot.environmentProfileDigest, 'environment profile');
  checkDigest(snapshot.inventoryDigest, 'inventory digest');
  checkDigest(lock.digest, 'rule lock');
  checkDigest(policy.digest, 'policy');
  const sourceIds = snapshot.sources.map((s) => checkId(s.sourceId, 'source id'));
  const analyses = new Map(request.analyses.map((a) => [a.sourceId, a]));
  if (analyses.size !== request.analyses.length) throw invalid('one analysis per source');
  for (const s of sourceIds)
    if (!analyses.has(s)) throw new PlanError('sentinel.plan.pinMismatch', `no parser analysis for source ${s}`);
  for (const a of analyses.keys())
    if (!sourceIds.includes(a))
      throw new PlanError('sentinel.plan.pinMismatch', `analysis for source ${a} is not in the snapshot`);
  // Every analysis read this snapshot: its snapshot id, and every captured file it joined, must be the pinned ones.
  const captured = new Map<string, string>();
  for (const e of snapshot.entries)
    if (e.kind === 'file' && e.disposition === 'included')
      captured.set(`${e.sourceId}\u0000${e.relativePath}`, e.content);
  for (const a of analyses.values()) {
    if (a.snapshotId !== snapshot.id)
      throw new PlanError(
        'sentinel.plan.pinMismatch',
        `the analysis of ${a.sourceId} read snapshot ${a.snapshotId}, not ${snapshot.id}`,
      );
    for (const f of a.files) {
      if (f.content !== undefined && captured.get(`${a.sourceId}\u0000${f.path}`) !== f.content) {
        throw new PlanError(
          'sentinel.plan.pinMismatch',
          `the analysis of ${a.sourceId} read other bytes for ${f.path} than the snapshot captured`,
        );
      }
    }
    for (const s of a.surfaces) {
      if (!captured.has(`${a.sourceId}\u0000${s.path}`))
        throw new PlanError(
          'sentinel.plan.pinMismatch',
          `a surface of ${a.sourceId} is in ${s.path}, which the snapshot did not capture`,
        );
    }
  }

  // The policy selects rules; the lock pins them.
  const locked = new Map<string, PlannerRule>();
  for (const r of lock.rules) {
    if (locked.has(r.familyId)) throw invalid(`the lock pins ${r.familyId} twice`);
    checkDigest(r.definitionDigest, `${r.familyId} definition`);
    checkDigest(r.packDigest, `${r.familyId} pack`);
    locked.set(r.familyId, r);
  }
  /**
   * A rule's adapter must be registered. An external adapter runs only when the lock approved exactly that tool: a lock
   * entry for the adapter whose version is the registered version and whose artifact digest is the registered image's
   * digest. The registry's own digest is not the lock's approval of the tool.
   */
  const adapterAnswer = (id: Id): { digest: Digest } | { reasonCode: string } => {
    if (!profile.registry.ids.includes(id)) return { reasonCode: 'sentinel.plan.adapterNotRegistered' };
    const adapter = profile.registry.get(id);
    // A bootstrap operation checks nothing: it is never a rule's adapter.
    if (adapter.kind === 'operation') return { reasonCode: 'sentinel.plan.adapterNotRegistered' };
    if (adapter.kind === 'external') {
      const entries = lock.tools.filter((t) => t.adapterId === id);
      if (entries.length === 0) return { reasonCode: 'sentinel.plan.adapterNotLocked' };
      const image = `sha256:${adapter.image.slice(adapter.image.lastIndexOf('@sha256:') + 8)}`;
      if (!entries.some((t) => t.version === adapter.version && t.artifactDigest === image))
        return { reasonCode: 'sentinel.plan.toolMismatch' };
    }
    return { digest: adapter.digest };
  };
  const usedFacts = new Map<string, { capability: string; adapterId: Id; adapterDigest: Digest }>();
  const usedAdapters = new Map<Id, Digest>();
  const requiredCaps = new Set(policy.requiredCapabilities);
  const ruleGaps: RuleGap[] = [];
  const selected: Array<{ rule: PlannerRule; mandatory: boolean }> = [];
  /** The declared stage selecting each rule family; null when the pipeline declares none (planned derived). */
  const stageOf = new Map<string, string | null>();
  for (const p of [...policy.rules].sort(byKey((r) => r.familyId))) {
    const rule = locked.get(p.familyId);
    const mandatory = p.source !== 'requested';
    if (!rule) {
      ruleGaps.push({
        familyId: p.familyId,
        required: mandatory || policy.requireCompleteCoverage,
        reasonCode: 'sentinel.plan.ruleNotLocked',
      });
      continue;
    }
    selected.push({ rule, mandatory });
    if (declared) stageOf.set(rule.familyId, declared.analysis.stageOfRule(rule));
  }

  // Framework resolution per source: resolved where a lockfile in that source names it; unknown where any entry is.
  const resolved = new Map<string, Set<string>>();
  /** Unknown versions read for one source, and those with no source (unknown everywhere). */
  const unknownIn = new Map<string, Set<string>>();
  const unknownEverywhere = new Set<string>();
  const into = (m: Map<string, Set<string>>, k: string, v: string) => (m.get(k) ?? m.set(k, new Set()).get(k)!).add(v);
  for (const f of snapshot.frameworkVersions) {
    const name = f.framework.toLowerCase();
    if (f.state === 'resolved') into(resolved, f.provenance.sourceId, name);
    else if (f.sourceId !== undefined) into(unknownIn, f.sourceId, name);
    else unknownEverywhere.add(name);
  }

  const checks: PlannedCheck[] = [];
  /** The captured file each planned check reads (none for a repository scope). */
  const readsFile = new Map<string, string>();
  /** Each included file's content artifact, keyed by source and path. */
  const contentOf = new Map<string, string>();
  /** Every included file of each source, sorted: a repository check's complete input set. */
  const repositoryFiles = new Map<string, string[]>();
  for (const e of snapshot.entries) {
    if (e.kind !== 'file' || e.disposition !== 'included') continue;
    contentOf.set(`${e.sourceId}\u0000${e.relativePath}`, e.content);
    (repositoryFiles.get(e.sourceId) ?? repositoryFiles.set(e.sourceId, []).get(e.sourceId)!).push(e.relativePath);
  }
  for (const list of repositoryFiles.values()) list.sort();
  const add = (c: Omit<PlannedCheck, 'id' | 'environment' | 'mode'>, path: string | null) => {
    if (checks.length >= limits.maxChecks) throw new PlanError('sentinel.plan.tooManyChecks', String(limits.maxChecks));
    const id = checkIdOf({ scopeId: c.scopeId, familyId: c.familyId, ruleRevision: c.ruleRevision, environment });
    checks.push({ ...c, id, environment, mode: 'deterministic' });
    if (c.state === 'planned' && path !== null) readsFile.set(id, path);
  };

  const fileClass = new Map<string, Map<string, string>>(
    [...analyses].map(([s, a]) => [s, new Map(a.files.map((f) => [f.path, f.class]))]),
  );

  for (const { rule, mandatory } of selected) {
    const candidates: Candidate[] = [];
    for (const sourceId of sourceIds) {
      if (rule.scopeKind === 'repository') {
        candidates.push({ scopeKind: 'repository', scopeId: sourceId, sourceId, path: null });
        // Everything the whole-repository check cannot read stays an explicit gap: excluded, refused, unreadable or
        // unlisted entries are never silently left out of a repository check.
        for (const entry of snapshot.entries) {
          if (entry.sourceId !== sourceId || (entry.kind === 'file' && entry.disposition === 'included')) continue;
          candidates.push({
            scopeKind: 'repository',
            scopeId: `${sourceId}:${entry.relativePath}${entry.kind === 'directory-boundary' ? '/' : ''}`,
            sourceId,
            path: entry.relativePath,
            entry,
            boundary: entry.kind === 'directory-boundary',
            repositoryGap: true,
          });
        }
      } else if (rule.scopeKind === 'surface') {
        for (const s of analyses.get(sourceId)!.surfaces) {
          const l = languageOf(s.path);
          if (l && rule.languages.includes(l))
            candidates.push({ scopeKind: 'surface', scopeId: s.nodeId, sourceId, path: s.path });
        }
        // The parser index stopped at its bound or placed locations outside the capture: surfaces may be missing.
        const a = analyses.get(sourceId)!;
        if (a.omitted > 0)
          candidates.push({
            scopeKind: 'surface',
            scopeId: `${sourceId}:#index-omitted`,
            sourceId,
            path: null,
            frontier: 'sentinel.plan.surfacesOmitted',
          });
        if (a.unplaced > 0)
          candidates.push({
            scopeKind: 'surface',
            scopeId: `${sourceId}:#index-unplaced`,
            sourceId,
            path: null,
            frontier: 'sentinel.plan.surfacesUnplaced',
          });
        // Surfaces are discovered only in parsed files. A file of the rule's languages that did not parse, could not
        // be captured, or a folder capture could not list may hold surfaces nobody found: each stays a gap.
        for (const entry of snapshot.entries) {
          if (entry.sourceId !== sourceId || entry.disposition === 'excluded') continue;
          if (entry.kind === 'directory-boundary') {
            if (entry.knownDescendants !== 0)
              candidates.push({
                scopeKind: 'surface',
                scopeId: `${sourceId}:${entry.relativePath}/`,
                sourceId,
                path: entry.relativePath,
                entry,
                boundary: true,
              });
            continue;
          }
          const l = entry.kind === 'file' ? languageOf(entry.relativePath) : undefined;
          if (!l || !rule.languages.includes(l)) continue;
          if (entry.kind === 'file' && entry.disposition === 'included') {
            if (fileClass.get(sourceId)!.get(entry.relativePath) !== 'parsed') {
              candidates.push({
                scopeKind: 'surface',
                scopeId: `${sourceId}:${entry.relativePath}`,
                sourceId,
                path: entry.relativePath,
                undiscovered: true,
              });
            }
          } else {
            candidates.push({
              scopeKind: 'surface',
              scopeId: `${sourceId}:${entry.relativePath}`,
              sourceId,
              path: entry.relativePath,
              entry,
            });
          }
        }
      }
    }
    if (rule.scopeKind !== 'repository' && rule.scopeKind !== 'surface') {
      for (const entry of snapshot.entries) {
        if (!sourceIds.includes(entry.sourceId)) continue;
        if (entry.kind === 'directory-boundary') {
          // A deliberate exclusion is out of scope; a folder that could not be listed is unknown scope.
          if (entry.disposition !== 'excluded' && entry.knownDescendants !== 0) {
            candidates.push({
              scopeKind: rule.scopeKind,
              scopeId: `${entry.sourceId}:${entry.relativePath}/`,
              sourceId: entry.sourceId,
              path: entry.relativePath,
              entry,
              boundary: true,
            });
          }
          continue;
        }
        if (entry.kind !== 'file' || !scopeOfKind(rule.scopeKind, entry.relativePath, rule.languages)) continue;
        if (entry.disposition === 'excluded') continue;
        candidates.push({
          scopeKind: rule.scopeKind,
          scopeId: `${entry.sourceId}:${entry.relativePath}`,
          sourceId: entry.sourceId,
          path: entry.relativePath,
          entry,
        });
      }
    }
    const requiresRequired = rule.requires.some((c) => requiredCaps.has(c));
    const required = mandatory || policy.requireCompleteCoverage || requiresRequired;
    const answers = rule.requires.map((c) => capabilityOf(profile.capabilities, profile.registry, permits, c));
    const missing = answers.find((a) => !a.available);
    const needsParse = answers.some((a) => a.fact?.perFileParse);
    const adapter = adapterAnswer(rule.adapterId);
    for (const c of candidates.sort(byKey((x) => x.scopeId))) {
      const base = {
        familyId: rule.familyId,
        ruleRevision: rule.revision,
        scopeKind: c.scopeKind,
        scopeId: c.scopeId,
        sourceId: c.sourceId,
        required,
      };
      const state = (s: CheckState, reasonCode?: string) =>
        add(reasonCode ? { ...base, state: s, reasonCode } : { ...base, state: s }, c.path);
      if (rule.frameworks?.length) {
        const names = rule.frameworks.map((f) => f.toLowerCase());
        const here = resolved.get(c.sourceId);
        if (!names.some((n) => here?.has(n))) {
          // An unresolved version anywhere is unknown for every source (a snapshot's unknown entry names no source).
          // No entry at all is not evidence the framework is absent: it is recorded as not detected, never skipped.
          const unresolved = names.some((n) => unknownEverywhere.has(n) || unknownIn.get(c.sourceId)?.has(n));
          state(
            'applicability-unknown',
            unresolved ? 'sentinel.plan.frameworkUnresolved' : 'sentinel.plan.frameworkNotDetected',
          );
          continue;
        }
      }
      if (c.frontier) {
        state('scope-unknown', c.frontier);
        continue;
      }
      if (c.undiscovered) {
        state('scope-unknown', 'sentinel.plan.surfacesUndiscovered' satisfies PlanReasonCode);
        continue;
      }
      if (c.boundary) {
        if (c.repositoryGap && c.entry?.disposition === 'excluded') {
          state('scope-unavailable', c.entry.reasonCode);
          continue;
        }
        state('scope-unknown', 'sentinel.plan.unknownDescendants');
        continue;
      }
      if (
        c.entry &&
        c.entry.kind !== 'directory-boundary' &&
        !(c.entry.kind === 'file' && c.entry.disposition === 'included')
      ) {
        state('scope-unavailable', c.entry.reasonCode);
        continue;
      }
      if (declared && stageOf.get(rule.familyId) === null) {
        state('unsupported', 'sentinel.plan.stageNotDeclared' satisfies PlanReasonCode);
        continue;
      }
      if ('reasonCode' in adapter) {
        state('unsupported', adapter.reasonCode);
        continue;
      }
      if (missing) {
        state('unsupported', missing.reasonCode!);
        continue;
      }
      if (rule.adapterId === PATHS_ADAPTER_ID && (!pathRequest || pathRequest.value.sourceId !== c.sourceId)) {
        state('scope-unavailable', 'sentinel.plan.pathRequestUnavailable' satisfies PlanReasonCode);
        continue;
      }
      if (c.scopeKind === 'repository' && (repositoryFiles.get(c.sourceId)?.length ?? 0) > limits.maxRepositoryInputs) {
        state('scope-unavailable', 'sentinel.plan.repositoryTooLarge' satisfies PlanReasonCode);
        continue;
      }
      if (needsParse && c.path !== null && fileClass.get(c.sourceId)!.get(c.path) !== 'parsed') {
        state('scope-unavailable', 'sentinel.plan.parseRequired');
        continue;
      }
      if (c.path !== null && !contentOf.has(`${c.sourceId}\u0000${c.path}`)) {
        state('scope-unavailable', 'sentinel.plan.inputNotCaptured');
        continue;
      }
      state('planned');
      usedAdapters.set(rule.adapterId, adapter.digest);
      for (const a of answers)
        usedFacts.set(`${a.fact!.capability}\u0000${a.fact!.adapterId}`, {
          capability: a.fact!.capability,
          adapterId: a.fact!.adapterId,
          adapterDigest: a.fact!.adapterDigest,
        });
    }
  }
  checks.sort(byKey((c) => c.id));
  for (let i = 1; i < checks.length; i++)
    if (checks[i]!.id === checks[i - 1]!.id) throw invalid(`check ${checks[i]!.id} is planned twice`);

  // Physical batching: one adapter over one source's scopes, bounded. A unit lists exactly the checks it covers.
  const rulePin = new Map(selected.map(({ rule }) => [rule.familyId, rule]));
  const groups = new Map<string, PlannedCheck[]>();
  for (const c of checks) {
    if (c.state !== 'planned') continue;
    // A declared pipeline batches within a stage: two stages over one adapter never share a unit.
    const k = `${declared ? `${stageOf.get(c.familyId)}\u0000` : ''}${rulePin.get(c.familyId)!.adapterId}\u0000${c.sourceId}\u0000${c.scopeKind === 'repository' ? 'repository' : 'scoped'}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
  }
  const work: PlannedWork[] = [];
  const assigned = new Map<string, string>();
  const unitsByStage = new Map<string, WorkRef[]>();
  for (const k of [...groups.keys()].sort()) {
    const parts = k.split('\u0000');
    const stage = declared ? parts.shift()! : null;
    const [adapterId, sourceId, shape] = parts as [string, string, string];
    const wholeRepository = shape === 'repository';
    const members = groups.get(k)!.sort(byKey((c) => `${c.scopeId}\u0000${c.familyId}`));
    let batch: PlannedCheck[] = [];
    let scopes = new Set<string>();
    let files = new Set<string>();
    const flush = () => {
      if (!batch.length) return;
      if (work.length >= limits.maxWork) throw new PlanError('sentinel.plan.tooMuchWork', String(limits.maxWork));
      const ids = batch.map((c) => c.id).sort();
      const families = [...new Set(batch.map((c) => c.familyId))].sort();
      const implementationDigest = usedAdapters.get(adapterId)!;
      // A repository check reads the source's complete captured set; any other unit reads exactly its scopes' files.
      if (wholeRepository) files = new Set(repositoryFiles.get(sourceId) ?? []);
      const inputs = [...files].sort().map((relativePath) => ({
        sourceId,
        relativePath,
        content: contentOf.get(`${sourceId}\u0000${relativePath}`)!,
      }));
      const needsDatabases = families.some((f) => rulePin.get(f)!.requires.includes('advisory-database'));
      const inputFingerprint = digestOf({
        ...(adapterId === PATHS_ADAPTER_ID ? { pathRequest: pathRequest!.id } : {}),
        inventory: snapshot.inventoryDigest,
        environment,
        analysis: analyses.get(sourceId)!.analysisFingerprint,
        rules: families.map((f) => {
          const r = rulePin.get(f)!;
          return [r.familyId, r.revision, r.definitionDigest, r.packDigest];
        }),
        adapterId,
        implementationDigest,
        scopes: [...scopes].sort(),
        inputs: inputs.map((i) => [i.relativePath, i.content]),
        databases: needsDatabases ? lock.databases.map((d) => [d.databaseId, d.snapshotDigest]).sort() : [],
      });
      const id = checkUnitIdOf({ runId, revision, adapterId, sourceId, checks: ids });
      if (stage !== null)
        (unitsByStage.get(stage) ?? unitsByStage.set(stage, []).get(stage)!).push({ id, revision: 1 });
      work.push({
        id,
        revision: 1,
        stage: 'check',
        contract: `sentinel.stage.check.${adapterId}`,
        implementationDigest,
        sourceId,
        adapterId,
        dependencies: [...request.bootstrap]
          .map((r) => ({ id: r.id, revision: r.revision }))
          .sort(byKey((r) => `${r.id}@${r.revision}`)),
        inputFingerprint,
        checks: ids,
        scopes: [...scopes].sort(),
        inputs,
        inputSetDigest: digestOf(inputs),
      });
      for (const c of ids) assigned.set(c, id);
      batch = [];
      scopes = new Set();
      files = new Set();
    };
    for (const c of members) {
      const path = readsFile.get(c.id);
      if (
        batch.length >= limits.maxChecksPerWork ||
        (!scopes.has(c.scopeId) && scopes.size >= limits.maxScopesPerWork) ||
        (!wholeRepository && path !== undefined && !files.has(path) && files.size >= limits.maxScopesPerWork)
      )
        flush();
      batch.push(c);
      scopes.add(c.scopeId);
      if (path !== undefined) files.add(path);
    }
    flush();
  }
  const finalChecks = checks.map((c) =>
    c.state === 'planned' ? { ...c, unit: { id: assigned.get(c.id)!, revision: 1 } } : c,
  );
  // Declared ordering between analysis stages: a unit also depends on every unit of the check stages its stage needs
  // or runs after. The derived plan has none, so its dependencies are the published bootstrap alone, as always.
  // Script stages, in dependency order: one unit each, waiting for the published bootstrap and every unit of the check
  // and script stages it needs or runs after. Its own work is its entry, pinned by digest in its input fingerprint;
  // what runs it is the registered script runner operation.
  const scriptUnits: PlannedWork[] = [];
  if (declared) {
    const scripts = declared.analysis.scripts();
    const runnerId = scripts.length
      ? profile.registry.ids.find((id) => {
          const a = profile.registry.get(id);
          return a.kind === 'operation' && a.operation === 'script';
        })
      : undefined;
    for (const stage of scripts) {
      if (!runnerId)
        throw new PlanError('sentinel.plan.stageUnavailable', `${stage.id}: no script runner is registered`);
      const entryDigest = declared.scripts.get(stage.id);
      if (entryDigest === undefined || !DIGEST.test(entryDigest))
        throw new PlanError('sentinel.plan.stageUnavailable', `${stage.id}: its entry ${stage.entry} is not adopted`);
      const runner = profile.registry.get(runnerId);
      const dependencies = [
        ...new Map(
          [
            ...request.bootstrap.map((r) => ({ id: r.id, revision: r.revision })),
            ...crossStageDependencies(declared.analysis, stage.id, unitsByStage),
          ].map((r) => [`${r.id}@${r.revision}`, r]),
        ).values(),
      ].sort(byKey((r) => `${r.id}@${r.revision}`));
      const unit: PlannedWork = {
        id: scriptUnitIdOf({ runId, revision, stage: stage.id }),
        revision: 1,
        stage: stage.id,
        contract: SCRIPT_CONTRACT,
        implementationDigest: runner.digest,
        sourceId: null,
        adapterId: runner.id,
        dependencies,
        inputFingerprint: scriptFingerprintOf(stage, entryDigest, runner.digest, dependencies),
        checks: [],
        scopes: [],
        inputs: [],
        inputSetDigest: digestOf([]),
      };
      scriptUnits.push(unit);
      unitsByStage.set(stage.id, [{ id: unit.id, revision: 1 }]);
      if (!usedAdapters.has(runner.id)) usedAdapters.set(runner.id, runner.digest);
    }
  }
  if (declared) {
    const familyOfCheck = new Map(checks.map((c) => [c.id, c.familyId]));
    for (const w of work) {
      const stage = stageOf.get(familyOfCheck.get(w.checks[0]!)!)!;
      const extra = crossStageDependencies(declared.analysis, stage, unitsByStage);
      if (!extra.length) continue;
      const all = new Map([...w.dependencies, ...extra].map((r) => [`${r.id}@${r.revision}`, r]));
      w.dependencies = [...all.values()].sort(byKey((r) => `${r.id}@${r.revision}`));
    }
  }
  work.push(...scriptUnits);
  work.sort(byKey((w) => w.id));
  const reused = [...request.bootstrap]
    .map((r) => ({ id: r.id, revision: r.revision }))
    .sort(byKey((r) => `${r.id}@${r.revision}`));
  const adapterPins = [...usedAdapters].map(([adapterId, digest]) => ({ adapterId, digest }));
  // Review units of the declared agent stages: each seed's sealed model inputs as the review side built them, depending
  // on the published bootstrap and every deterministic unit, so a model never runs before the evidence it may cite.
  const units: PlannedWork[] = [...work];
  if (declared?.agents.length) {
    if (declared.agents.length > MAX_AGENT_UNITS)
      throw new PlanError(
        'sentinel.plan.tooMuchWork',
        `${declared.agents.length} review units, at most ${MAX_AGENT_UNITS}`,
      );
    const deterministic = work.map((w) => ({ id: w.id, revision: w.revision }));
    for (const seed of declared.agents) {
      declared.analysis.stageOfSeed(seed);
      if (
        seed.review.segmentId !== seed.segmentId ||
        !snapshot.sources.some((s) => s.sourceId === seed.sourceId) ||
        seed.inputs.some((i) => i.sourceId !== seed.sourceId)
      )
        throw invalid('a review seed names another source or segment than its inputs');
      const stage = `review-${seed.kind}` as const;
      const inputs = seed.inputs.map((i) => ({
        sourceId: i.sourceId,
        relativePath: i.relativePath,
        content: i.content,
      }));
      const unit: PlannedWork = {
        id: reviewUnitIdOf({
          runId,
          revision,
          stage,
          sourceId: seed.sourceId,
          segmentId: seed.segmentId,
          specDigest: seed.review.specDigest,
        }),
        revision: 1,
        stage,
        contract: `sentinel.stage.review.${seed.kind}`,
        implementationDigest: checkDigest(seed.adapterDigest, 'review adapter digest'),
        sourceId: seed.sourceId,
        adapterId: checkId(seed.adapterId, 'review adapter'),
        dependencies: [...reused.map((r) => ({ ...r })), ...deterministic.map((r) => ({ ...r }))],
        inputFingerprint: seed.review.specDigest,
        checks: [],
        scopes: [seed.sourceId],
        inputs,
        inputSetDigest: digestOf(inputs),
        review: structuredClone(seed.review),
      };
      if (units.some((u) => u.id === unit.id)) throw invalid(`review unit ${unit.id} is planned twice`);
      units.push(unit);
      if (!adapterPins.some((a) => a.adapterId === seed.adapterId))
        adapterPins.push({ adapterId: seed.adapterId, digest: seed.adapterDigest });
    }
    units.sort(byKey((w) => w.id));
  }

  const pins: PlanPins = {
    snapshotId: snapshot.id,
    inventoryDigest: snapshot.inventoryDigest,
    environment,
    ruleLockDigest: lock.digest,
    policyDigest: policy.digest,
    profileId: checkId(profile.id, 'profile id'),
    ...(pathRequest ? { pathRequest: pathRequest.id } : {}),
    rules: selected.map(({ rule: r }) => ({
      familyId: r.familyId,
      revision: r.revision,
      definitionDigest: r.definitionDigest,
      packDigest: r.packDigest,
      adapterId: r.adapterId,
    })),
    tools: [...lock.tools]
      .map((t) => ({ adapterId: t.adapterId, artifactDigest: t.artifactDigest }))
      .sort(byKey((t) => t.adapterId)),
    databases: [...lock.databases]
      .map((d) => ({ databaseId: d.databaseId, snapshotDigest: d.snapshotDigest }))
      .sort(byKey((d) => d.databaseId)),
    analyses: [...analyses.values()]
      .map((a) => ({ sourceId: a.sourceId, analysisFingerprint: a.analysisFingerprint }))
      .sort(byKey((a) => a.sourceId)),
    operations,
    adapters: adapterPins.sort(byKey((a) => a.adapterId)),
    capabilities: [...usedFacts.values()].sort(byKey((f) => `${f.capability}\u0000${f.adapterId}`)),
  };
  return seal({
    schema: PLAN_SCHEMA,
    runId,
    revision,
    kind: 'analysis',
    previous,
    pins,
    reused,
    units,
    checks: finalChecks,
    ruleGaps,
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
  return index.nodes
    .filter((n) => allowed.has(n.kind))
    .map((n) => ({ nodeId: n.nodeId, path: n.path, kind: n.kind }))
    .sort(byKey((n) => n.nodeId));
}
