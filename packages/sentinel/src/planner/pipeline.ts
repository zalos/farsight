// Declared pipelines (Sentinel v2 §3.1): the stages an owner declares decide which work units a plan holds.
//
// A pipeline is a list of stages of four kinds. `builtin` stages run Sentinel's own code: capture, parse and inventory
// are the bootstrap revision exactly as planBootstrap plans it; `framework-controls`, `paths` (also called the
// walkthrough) and `preview` select checks from the matrix like a tool; `report` is a fold over publications and
// plans no unit. A `tool` stage names a registered scanner adapter and, optionally, the rule families it selects; its
// checks come from the same matrix planAnalysis has always built, and a policy rule no stage selects stays in the plan
// as `unsupported` with its reason, never dropped. An `agent` stage's units are the review units whose fan-out it
// declares (per check: the guided review; per source or per run: the general review); the review side supplies each
// unit's sealed model inputs as a seed, and the planner places it and seals the revision once. A `script` stage is
// declared here and planned by the host script stage, not by this module.
//
// `needs` and `after` order stages: a unit of a stage depends on every unit of the analysis stages it needs or runs
// after (bootstrap stages are the published inventory every analysis unit already depends on). `after` is ordering
// only. A `{stage, output}` input names another stage's typed output; it adds the same dependency, and the
// coordinator resolves it to the producer's published artifact ids when the consumer's attempt starts (execution/
// stage-inputs.ts). A declaration that plans the same units as today's derivation plans the same revision, byte for
// byte: the default pipeline (defaultPipelineOf) is today's plan, declared.
//
// Pure: no file, clock, ledger or network.
import type { Digest, Id, WorkRef } from '../contracts/common.js';
import type { PlanInput, PlannedReview } from '../contracts/plan.js';
import { PREVIEW_DETECTOR_ID } from '../adapters/preview-detector.js';
import { PATHS_ADAPTER_ID } from '../analysis/paths/request.js';
import { digestOf } from '../store/ledger-json.js';
import { PlanError } from './errors.js';
import { deepFreeze } from './identity.js';
import type { PlannedWork, PlanRevision, PlannerRule } from './types.js';

// ---- the declaration (a local mirror of contracts/pipeline.ts until the shared contract lands) ----

export const PIPELINE_SCHEMA = 'sentinel-pipeline/1' as const;
export type DeclaredStageKind = 'builtin' | 'tool' | 'script' | 'agent';
/** A typed input: a stage id or one of the bootstrap inputs (`source`, `parse`, `inventory`), or another stage's output. */
export type DeclaredInput = string | { readonly stage: string; readonly output: string };
/** A typed output: a built-in output name, or a named output with its schema. */
export type DeclaredOutput = string | { readonly name: string; readonly schema: string };
export type DeclaredFanOut = 'per-run' | 'per-source' | 'per-entry' | 'per-check';

export interface DeclaredStage {
  readonly id: string;
  readonly kind: DeclaredStageKind;
  /** `builtin`: capture, parse, inventory, framework-controls, paths (walkthrough), preview or report. */
  readonly operation?: string;
  /** `tool`: the registered scanner adapter, by registry id or its tool name (gitleaks, osv-scanner, …). */
  readonly adapter?: string;
  /** `tool`: the rule families this stage selects (all of its adapter's when absent). */
  readonly rules?: readonly string[];
  readonly needs?: readonly DeclaredInput[];
  readonly produces?: readonly DeclaredOutput[];
  readonly after?: readonly string[];
  readonly fanOut?: DeclaredFanOut;
  readonly required?: boolean;
  /** Runner, model, prompt, skills, mode and budget: read by the agent and script stages, not by planning. */
  readonly [field: string]: unknown;
}

export interface DeclaredPipeline {
  readonly schema: typeof PIPELINE_SCHEMA;
  readonly id: string;
  readonly revision: number;
  readonly stages: readonly DeclaredStage[];
  readonly flags?: Readonly<Record<string, boolean>>;
}

// ---- built-in vocabulary ----

export const BOOTSTRAP_OPERATIONS = Object.freeze(['capture', 'parse', 'inventory'] as const);
type BootstrapOperation = (typeof BOOTSTRAP_OPERATIONS)[number];
/** Built-in operations that select checks, by the registered adapter that runs them. */
export const BUILTIN_CHECK_OPERATIONS: Readonly<Record<string, Id>> = Object.freeze({
  'framework-controls': 'framework-controls',
  paths: PATHS_ADAPTER_ID,
  walkthrough: PATHS_ADAPTER_ID,
  preview: PREVIEW_DETECTOR_ID,
});
const UNITLESS_OPERATIONS = Object.freeze(['report']);
/** Scanner tool names a `tool` stage may use instead of the registry id. */
export const TOOL_ADAPTERS: Readonly<Record<string, Id>> = Object.freeze({
  gitleaks: 'secrets-gitleaks',
  'osv-scanner': 'advisories-osv',
  semgrep: 'pattern-semgrep',
  trivy: 'iac-trivy',
  zizmor: 'ci-zizmor',
});
/** The bootstrap inputs a `needs` entry may name instead of a stage id. */
const BOOTSTRAP_INPUTS: Readonly<Record<string, BootstrapOperation>> = Object.freeze({
  source: 'capture',
  parse: 'parse',
  inventory: 'inventory',
});
/** What each kind produces when the stage declares nothing. */
const DEFAULT_OUTPUTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  capture: ['source'],
  parse: ['parse'],
  inventory: ['inventory'],
  check: ['findings', 'coverage'],
  paths: ['findings', 'coverage', 'walkthrough-md'],
  report: ['report'],
  agent: ['observations'],
  script: [],
});
/** The review kind each agent fan-out plans. */
const REVIEW_KIND_OF: Readonly<Partial<Record<DeclaredFanOut, 'guided' | 'general'>>> = Object.freeze({
  'per-check': 'guided',
  'per-source': 'general',
  'per-run': 'general',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_STAGES = 256;
const fail = (code: 'sentinel.plan.pipelineInvalid' | 'sentinel.plan.stageUnknown', detail: string): never => {
  throw new PlanError(code, detail);
};

// ---- the stage model ----

/** What one declared stage plans. */
export type StageRole =
  | { readonly role: 'bootstrap'; readonly operation: BootstrapOperation }
  | { readonly role: 'check'; readonly adapterId: Id; readonly rules: ReadonlySet<string> | null }
  | { readonly role: 'agent'; readonly review: 'guided' | 'general' | null }
  | { readonly role: 'script' }
  | { readonly role: 'none' };

export interface StageModel {
  readonly pipeline: DeclaredPipeline;
  /** The canonical digest of the declaration. */
  readonly digest: Digest;
  /** Stage ids in a dependency order (needs and after before the stage), ties by declaration order. */
  readonly order: readonly string[];
  readonly stages: ReadonlyMap<string, DeclaredStage>;
  readonly roles: ReadonlyMap<string, StageRole>;
  /** Each stage's direct upstream stages (needs and after), bootstrap stages included. */
  readonly upstream: ReadonlyMap<string, readonly string[]>;
  /** Each stage's `{stage, output}` inputs. */
  readonly inputs: ReadonlyMap<string, readonly { readonly stage: string; readonly output: string }[]>;
  /** Each stage's outputs, by name. */
  readonly outputs: ReadonlyMap<string, readonly string[]>;
  /** The stage id running each bootstrap operation. */
  readonly bootstrap: Readonly<Record<BootstrapOperation, string | undefined>>;
}

const outputName = (o: DeclaredOutput): string => (typeof o === 'string' ? o : o?.name);

function roleOf(s: DeclaredStage): StageRole {
  if (s.kind === 'builtin') {
    const op = s.operation;
    if (typeof op !== 'string') return fail('sentinel.plan.pipelineInvalid', `stage ${s.id} names no operation`);
    if ((BOOTSTRAP_OPERATIONS as readonly string[]).includes(op))
      return { role: 'bootstrap', operation: op as BootstrapOperation };
    if (Object.hasOwn(BUILTIN_CHECK_OPERATIONS, op))
      return { role: 'check', adapterId: BUILTIN_CHECK_OPERATIONS[op]!, rules: rulesOf(s) };
    if (UNITLESS_OPERATIONS.includes(op)) return { role: 'none' };
    return fail('sentinel.plan.pipelineInvalid', `stage ${s.id} names an unknown built-in operation`);
  }
  if (s.kind === 'tool') {
    if (typeof s.adapter !== 'string' || !(ID.test(s.adapter) || Object.hasOwn(TOOL_ADAPTERS, s.adapter)))
      return fail('sentinel.plan.pipelineInvalid', `tool stage ${s.id} names no adapter`);
    return { role: 'check', adapterId: TOOL_ADAPTERS[s.adapter] ?? s.adapter, rules: rulesOf(s) };
  }
  if (s.kind === 'agent') {
    const fanOut = s.fanOut ?? 'per-run';
    if (!['per-run', 'per-source', 'per-entry', 'per-check'].includes(fanOut))
      return fail('sentinel.plan.pipelineInvalid', `agent stage ${s.id} names an unknown fan-out`);
    return { role: 'agent', review: REVIEW_KIND_OF[fanOut] ?? null };
  }
  if (s.kind === 'script') return { role: 'script' };
  return fail('sentinel.plan.pipelineInvalid', `stage ${String((s as { id?: unknown }).id)} has an unknown kind`);
}

function rulesOf(s: DeclaredStage): ReadonlySet<string> | null {
  if (s.rules === undefined) return null;
  // A pack reference (`pack:…`) is resolved to its rule families when the pipeline is adopted, never here.
  if (!Array.isArray(s.rules) || s.rules.length > 2048 || s.rules.some((r) => typeof r !== 'string' || !ID.test(r)))
    return fail('sentinel.plan.pipelineInvalid', `stage ${s.id} names its rules as anything but rule family ids`);
  return new Set(s.rules);
}

/**
 * Validates a declaration and derives its stage model: unique ids, known kinds and operations, every `needs`, `after`
 * and input naming a declared stage (and an output it produces), and no cycle. Throws a PlanError naming the first
 * problem; a valid declaration always derives the same model.
 */
export function stageModel(pipeline: DeclaredPipeline): StageModel {
  if (!pipeline || typeof pipeline !== 'object' || pipeline.schema !== PIPELINE_SCHEMA)
    fail('sentinel.plan.pipelineInvalid', `the pipeline is not a ${PIPELINE_SCHEMA} declaration`);
  if (typeof pipeline.id !== 'string' || !ID.test(pipeline.id))
    fail('sentinel.plan.pipelineInvalid', 'the pipeline has no id');
  if (!Number.isSafeInteger(pipeline.revision) || pipeline.revision < 1)
    fail('sentinel.plan.pipelineInvalid', 'the pipeline revision is not a positive ordinal');
  if (!Array.isArray(pipeline.stages) || pipeline.stages.length === 0 || pipeline.stages.length > MAX_STAGES)
    fail('sentinel.plan.pipelineInvalid', `a pipeline declares 1 to ${MAX_STAGES} stages`);
  const stages = new Map<string, DeclaredStage>();
  const roles = new Map<string, StageRole>();
  const bootstrap: Record<BootstrapOperation, string | undefined> = {
    capture: undefined,
    parse: undefined,
    inventory: undefined,
  };
  for (const s of pipeline.stages) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !ID.test(s.id))
      fail('sentinel.plan.pipelineInvalid', 'a stage has no id');
    if (stages.has(s.id)) fail('sentinel.plan.pipelineInvalid', `stage ${s.id} is declared twice`);
    stages.set(s.id, s);
    const role = roleOf(s);
    roles.set(s.id, role);
    if (role.role === 'bootstrap') {
      if (bootstrap[role.operation])
        fail('sentinel.plan.pipelineInvalid', `two stages run the ${role.operation} operation`);
      bootstrap[role.operation] = s.id;
    }
  }
  const outputs = new Map<string, readonly string[]>();
  for (const [id, s] of stages) {
    const role = roles.get(id)!;
    const fallback =
      role.role === 'bootstrap'
        ? DEFAULT_OUTPUTS[role.operation]!
        : role.role === 'check'
          ? role.adapterId === PATHS_ADAPTER_ID
            ? DEFAULT_OUTPUTS.paths!
            : DEFAULT_OUTPUTS.check!
          : role.role === 'agent'
            ? DEFAULT_OUTPUTS.agent!
            : role.role === 'script'
              ? DEFAULT_OUTPUTS.script!
              : DEFAULT_OUTPUTS.report!;
    if (s.produces !== undefined && (!Array.isArray(s.produces) || s.produces.length > 64))
      fail('sentinel.plan.pipelineInvalid', `stage ${id} declares its outputs as anything but a list`);
    const declared = (s.produces ?? []).map(outputName);
    if (declared.some((n) => typeof n !== 'string' || !ID.test(n)) || new Set(declared).size !== declared.length)
      fail('sentinel.plan.pipelineInvalid', `stage ${id} declares an output without a name, or one twice`);
    outputs.set(id, [...new Set([...fallback, ...declared])]);
  }
  const upstream = new Map<string, string[]>();
  const inputs = new Map<string, { stage: string; output: string }[]>();
  for (const [id, s] of stages) {
    const up = new Set<string>();
    const typed: { stage: string; output: string }[] = [];
    if (s.needs !== undefined && (!Array.isArray(s.needs) || s.needs.length > 64))
      fail('sentinel.plan.pipelineInvalid', `stage ${id} declares its inputs as anything but a list`);
    for (const n of s.needs ?? []) {
      if (typeof n === 'string') {
        if (stages.has(n)) up.add(n);
        else if (Object.hasOwn(BOOTSTRAP_INPUTS, n)) {
          const by = bootstrap[BOOTSTRAP_INPUTS[n]!];
          if (!by) fail('sentinel.plan.stageUnknown', `stage ${id} needs ${n}, which no stage produces`);
          up.add(by!);
        } else if (!/^[a-z][a-z0-9-]*\.[a-z0-9.-]+$/.test(n)) {
          // A dotted name (`farsight.journeys`) is a context input read from outside the pipeline, not a stage.
          fail('sentinel.plan.stageUnknown', `stage ${id} needs ${n}, which is not a declared stage`);
        }
        continue;
      }
      if (!n || typeof n !== 'object' || typeof n.stage !== 'string' || typeof n.output !== 'string')
        fail(
          'sentinel.plan.pipelineInvalid',
          `stage ${id} declares an input that is neither a name nor a stage output`,
        );
      if (!stages.has(n.stage))
        fail('sentinel.plan.stageUnknown', `stage ${id} reads ${n.stage}, which is not declared`);
      if (!outputs.get(n.stage)!.includes(n.output))
        fail(
          'sentinel.plan.stageUnknown',
          `stage ${id} reads ${n.stage}.${n.output}, which ${n.stage} does not produce`,
        );
      up.add(n.stage);
      typed.push({ stage: n.stage, output: n.output });
    }
    if (s.after !== undefined && (!Array.isArray(s.after) || s.after.length > MAX_STAGES))
      fail('sentinel.plan.pipelineInvalid', `stage ${id} declares its ordering as anything but a list`);
    for (const a of s.after ?? []) {
      if (typeof a !== 'string' || !stages.has(a))
        fail('sentinel.plan.stageUnknown', `stage ${id} runs after ${String(a)}, which is not declared`);
      up.add(a);
    }
    if (up.has(id)) throw new PlanError('sentinel.plan.stageCycle', id);
    upstream.set(id, [...up]);
    inputs.set(id, typed);
  }
  // Kahn over the stage graph; ties keep declaration order, so the order is a function of the declaration.
  const declared = [...stages.keys()];
  const remaining = new Map(declared.map((id) => [id, upstream.get(id)!.length]));
  const order: string[] = [];
  while (order.length < declared.length) {
    const next = declared.find((id) => remaining.get(id) === 0);
    if (next === undefined) {
      const stuck = declared.filter((id) => (remaining.get(id) ?? 0) > 0);
      throw new PlanError('sentinel.plan.stageCycle', stuck.slice(0, 8).join(', '));
    }
    remaining.delete(next);
    order.push(next);
    for (const id of declared) if (upstream.get(id)!.includes(next)) remaining.set(id, remaining.get(id)! - 1);
  }
  return deepFreeze({
    pipeline: structuredClone(pipeline),
    digest: digestOf(pipeline),
    order,
    stages,
    roles,
    upstream,
    inputs,
    outputs,
    bootstrap,
  }) as StageModel;
}

/** The bootstrap stages a pipeline must declare before anything it plans can run. */
export function requireBootstrap(model: StageModel): void {
  const missing = BOOTSTRAP_OPERATIONS.filter((op) => !model.bootstrap[op]);
  if (missing.length)
    throw new PlanError('sentinel.plan.pipelineInvalid', `the pipeline declares no ${missing.join(', ')} stage`);
}

/** The analysis-revision stages (checks and agents) a stage depends on, transitively through unit-less stages. */
function analysisUpstream(model: StageModel, id: string): string[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (s: string) => {
    for (const u of model.upstream.get(s) ?? []) {
      if (seen.has(u)) continue;
      seen.add(u);
      const r = model.roles.get(u)!.role;
      if (r === 'check' || r === 'agent' || r === 'script') out.add(u);
      else if (r === 'none') walk(u);
    }
  };
  walk(id);
  return [...out];
}

// ---- what the planner reads from a model ----

/** One review unit's sealed model inputs, built by the review side, placed by the planner. */
export interface AgentUnitSeed {
  readonly kind: 'guided' | 'general';
  readonly sourceId: Id;
  readonly segmentId: Id;
  readonly adapterId: Id;
  readonly adapterDigest: Digest;
  readonly review: PlannedReview;
  readonly inputs: readonly PlanInput[];
}

/** What planAnalysis consults when it plans a declared pipeline (planner.ts). */
export interface DeclaredAnalysis {
  /** The stage selecting a rule, or null when no stage selects it; two stages selecting it are refused. */
  stageOfRule(rule: Pick<PlannerRule, 'familyId' | 'adapterId'>): string | null;
  /** Analysis stages whose units a stage's units depend on. */
  dependsOn(stage: string): readonly string[];
  /** The agent stage a review seed belongs to; refused when none or two declare its fan-out. */
  stageOfSeed(seed: AgentUnitSeed): string;
}

export function declaredAnalysis(model: StageModel): DeclaredAnalysis {
  for (const [id, role] of model.roles) {
    if (role.role === 'script')
      throw new PlanError(
        'sentinel.plan.stageUnavailable',
        `${id}: a script stage is planned by the host script stage`,
      );
    if (role.role === 'agent' && role.review === null)
      throw new PlanError('sentinel.plan.stageUnavailable', `${id}: a per-entry agent fan-out`);
    if (role.role !== 'agent' && model.inputs.get(id)!.length)
      throw new PlanError('sentinel.plan.stageUnavailable', `${id}: only an agent stage reads another stage's output`);
    if (role.role === 'agent')
      for (const u of analysisUpstream(model, id))
        if (model.roles.get(u)!.role === 'agent')
          throw new PlanError('sentinel.plan.stageUnavailable', `${id}: an agent stage after another agent stage`);
  }
  const checkStages = [...model.roles].filter(([, r]) => r.role === 'check') as [
    string,
    Extract<StageRole, { role: 'check' }>,
  ][];
  return Object.freeze({
    stageOfRule(rule: Pick<PlannerRule, 'familyId' | 'adapterId'>) {
      const matching = checkStages.filter(
        ([, r]) => r.adapterId === rule.adapterId && (r.rules === null || r.rules.has(rule.familyId)),
      );
      if (matching.length > 1)
        throw new PlanError(
          'sentinel.plan.stageAmbiguous',
          `${rule.familyId}: ${matching.map(([id]) => id).join(', ')}`,
        );
      return matching[0]?.[0] ?? null;
    },
    dependsOn(stage: string) {
      return analysisUpstream(model, stage).filter((u) => model.roles.get(u)!.role === 'check');
    },
    stageOfSeed(seed: AgentUnitSeed) {
      const matching = [...model.roles].filter(([, r]) => r.role === 'agent' && r.review === seed.kind);
      if (matching.length !== 1)
        throw new PlanError(
          matching.length ? 'sentinel.plan.stageAmbiguous' : 'sentinel.plan.agentStageMissing',
          `the ${seed.kind} review: ${matching.map(([id]) => id).join(', ') || 'no agent stage declares it'}`,
        );
      return matching[0]![0];
    },
  });
}

/** The review units of a plan as seeds: what the review side built, without where the planner placed it. */
export function agentSeedsOf(plan: Pick<PlanRevision, 'units'>): AgentUnitSeed[] {
  return plan.units
    .filter((u) => u.review)
    .map((u) => ({
      kind: u.stage === 'review-guided' ? ('guided' as const) : ('general' as const),
      sourceId: u.sourceId!,
      segmentId: u.review!.segmentId,
      adapterId: u.adapterId!,
      adapterDigest: u.implementationDigest,
      review: structuredClone(u.review!),
      inputs: structuredClone(u.inputs),
    }));
}

// ---- stages and units of a plan ----

/**
 * The declared stage each unit of a plan belongs to. Bootstrap units by their operation; check units by the stage
 * that selects their checks' rules; review units by the agent stage declaring their fan-out. A unit no stage claims
 * is refused: the plan was not made from this declaration.
 */
export function stagesOfUnits(
  model: StageModel,
  plan: Pick<PlanRevision, 'units' | 'checks' | 'pins'>,
): Map<Id, string> {
  const out = new Map<Id, string>();
  const familyOf = new Map(plan.checks.map((c) => [c.id, c.familyId]));
  for (const u of plan.units) {
    let stage: string | null | undefined;
    if (u.stage === 'capture' || u.stage === 'parse' || u.stage === 'inventory') stage = model.bootstrap[u.stage];
    else if (u.stage === 'review-guided' || u.stage === 'review-general') {
      const kind = u.stage === 'review-guided' ? 'guided' : 'general';
      stage = [...model.roles].find(([, r]) => r.role === 'agent' && r.review === kind)?.[0];
    } else {
      const families = new Set(u.checks.map((c) => familyOf.get(c)));
      const owners = new Set(
        [...model.roles]
          .filter(
            ([, r]) =>
              r.role === 'check' &&
              r.adapterId === u.adapterId &&
              [...families].every((f) => f !== undefined && (r.rules === null || r.rules.has(f))),
          )
          .map(([id]) => id),
      );
      stage = owners.size === 1 ? [...owners][0] : undefined;
    }
    if (!stage)
      throw new PlanError(
        'sentinel.plan.stageUnknown',
        `unit ${u.id} belongs to no stage of pipeline ${model.pipeline.id}`,
      );
    out.set(u.id, stage);
  }
  return out;
}

/** What rerunning stages of a plan means: their units, and the stages and units downstream of them. */
export interface StageSelection {
  /** The requested stages, each with its units in this plan. */
  readonly selected: readonly { readonly stage: string; readonly units: readonly Id[] }[];
  /** Stages that need or run after a selected one, transitively, with their units: they run again too. */
  readonly downstream: readonly { readonly stage: string; readonly units: readonly Id[] }[];
  /** Every unit the selection expands to: the selected stages' units (what `rerun --stage` names). */
  readonly units: readonly Id[];
}

/** Expands stage ids to the plan's unit ids and previews the downstream stages a rerun of them reaches. */
export function selectStages(
  model: StageModel,
  plan: Pick<PlanRevision, 'units' | 'checks' | 'pins'>,
  stageIds: readonly string[],
): StageSelection {
  const unknown = stageIds.filter((s) => !model.stages.has(s));
  if (unknown.length) throw new PlanError('sentinel.plan.stageUnknown', unknown.join(', '));
  const owner = stagesOfUnits(model, plan);
  const unitsOf = (stage: string) =>
    plan.units
      .filter((u) => owner.get(u.id) === stage)
      .map((u) => u.id)
      .sort();
  const chosen = new Set(stageIds);
  const below = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const id of model.order)
      if (!chosen.has(id) && !below.has(id) && model.upstream.get(id)!.some((u) => chosen.has(u) || below.has(u))) {
        below.add(id);
        grew = true;
      }
  }
  const selected = model.order.filter((s) => chosen.has(s)).map((stage) => ({ stage, units: unitsOf(stage) }));
  return deepFreeze({
    selected,
    downstream: model.order.filter((s) => below.has(s)).map((stage) => ({ stage, units: unitsOf(stage) })),
    units: [...new Set(selected.flatMap((s) => s.units))].sort(),
  });
}

// ---- the default pipeline ----

/** The stage id the default pipeline gives each shipped check adapter. */
export const DEFAULT_CHECK_STAGES: Readonly<Record<Id, string>> = Object.freeze({
  'secrets-gitleaks': 'secrets',
  'advisories-osv': 'advisories',
  'pattern-semgrep': 'patterns',
  'iac-trivy': 'infrastructure',
  'ci-zizmor': 'ci',
  [PREVIEW_DETECTOR_ID]: 'preview',
  'framework-controls': 'framework-controls',
  [PATHS_ADAPTER_ID]: 'paths',
});
const BUILTIN_OPERATION_OF: Readonly<Record<Id, string>> = Object.freeze({
  [PREVIEW_DETECTOR_ID]: 'preview',
  'framework-controls': 'framework-controls',
  [PATHS_ADAPTER_ID]: 'paths',
});

/**
 * Today's plan, declared: capture, parse and inventory; one stage per check adapter the policy's rules run under,
 * selecting all of that adapter's rules; the guided and general reviews as agent stages after every check stage;
 * and the report. Planning it reproduces the derived plan unit for unit and digest for digest.
 */
export function defaultPipelineOf(options: {
  readonly adapters: readonly Id[];
  readonly reviews?: readonly ('guided' | 'general')[];
}): DeclaredPipeline {
  const adapters = [...new Set(options.adapters)].sort();
  const checks: DeclaredStage[] = adapters.map((adapterId) => {
    const id = DEFAULT_CHECK_STAGES[adapterId] ?? adapterId;
    const operation = BUILTIN_OPERATION_OF[adapterId];
    return operation
      ? { id, kind: 'builtin', operation, needs: ['inventory'] }
      : { id, kind: 'tool', adapter: adapterId, needs: ['inventory'] };
  });
  const after = checks.map((c) => c.id);
  const reviews: DeclaredStage[] = [...new Set(options.reviews ?? [])].sort().map((kind) => ({
    id: `review-${kind}`,
    kind: 'agent',
    mode: 'brokered',
    fanOut: kind === 'guided' ? 'per-check' : 'per-source',
    needs: ['inventory'],
    after,
  }));
  return deepFreeze({
    schema: PIPELINE_SCHEMA,
    id: 'default',
    revision: 1,
    stages: [
      { id: 'capture', kind: 'builtin', operation: 'capture' },
      { id: 'parse', kind: 'builtin', operation: 'parse', needs: ['capture'] },
      { id: 'inventory', kind: 'builtin', operation: 'inventory', needs: ['parse'] },
      ...checks,
      ...reviews,
      {
        id: 'report',
        kind: 'builtin',
        operation: 'report',
        needs: ['inventory'],
        after: [...after, ...reviews.map((r) => r.id)],
      },
    ],
  });
}

/** Units a stage's units depend on in an analysis revision, besides the published bootstrap: sorted, distinct. */
export function crossStageDependencies(
  declared: DeclaredAnalysis,
  stage: string,
  unitsByStage: ReadonlyMap<string, readonly Pick<PlannedWork, 'id' | 'revision'>[]>,
): WorkRef[] {
  const refs = new Map<string, WorkRef>();
  for (const up of declared.dependsOn(stage))
    for (const u of unitsByStage.get(up) ?? []) refs.set(`${u.id}@${u.revision}`, { id: u.id, revision: u.revision });
  return [...refs.values()];
}
