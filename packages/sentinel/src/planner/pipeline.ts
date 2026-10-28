// Declared pipelines (Sentinel v2 §3.1): the stages an owner declares decide which work units a plan holds.
//
// A pipeline (contracts/pipeline.ts) is a list of stages of four kinds. `builtin` stages run Sentinel's own code:
// capture, parse and inventory are the bootstrap revision exactly as planBootstrap plans it; `walkthrough` (the
// bounded call paths) and `framework-controls` select their adapter's checks from the matrix like a tool; `report` is
// a fold over publications and plans no unit. A `tool` stage names a registered check adapter and the rule families
// it selects; its checks come from the same matrix planAnalysis has always built, and a policy rule no stage selects
// stays in the plan as `unsupported` with its reason, never dropped. An `agent` stage's units are the review units
// whose fan-out it declares (per check: the guided review; per source or per run: the general review); the review
// side supplies each unit's sealed model inputs as a seed, and the planner places it and seals the revision once. A
// `script` stage is planned by the host script stage, not by this module.
//
// Units keep their built-in stage ids (`capture` … `check`, `review-guided`, `review-general`), so every retained
// plan, work envelope and driver reads them as before; which declared stage a unit belongs to is derived from the
// declaration (stagesOfUnits), never stored in the unit. `needs` and `after` order stages: a unit of a check stage
// depends on every unit of the check stages it needs or runs after (bootstrap stages are the published inventory
// every analysis unit already depends on); a review unit depends on every deterministic unit, as it always has, so a
// model never runs before the evidence it may cite. A `{stage, output}` input names another stage's typed output; the
// coordinator resolves it to the producer's published artifact ids when the consumer's attempt starts
// (execution/stage-inputs.ts). A declaration that plans the same units as today's derivation plans the same revision,
// byte for byte: the default pipeline (defaultPipelineOf) is today's plan, declared.
//
// Pure: no file, clock, ledger or network.
import type { Digest, Id, WorkRef } from '../contracts/common.js';
import type { PlanInput, PlannedReview } from '../contracts/plan.js';
import type {
  AgentRunnerId,
  BuiltinOperation,
  NamedStageOutput,
  PipelineDefinition,
  ScriptStageDefinition,
  StageDefinition,
  StageFanOut,
  StageOutputDecl,
} from '../contracts/pipeline.js';
import { PREVIEW_DETECTOR_ID } from '../adapters/preview-detector.js';
import { PATHS_ADAPTER_ID } from '../analysis/paths/request.js';
import { digestOf } from '../store/ledger-json.js';
import { PlanError } from './errors.js';
import { deepFreeze } from './identity.js';
import type { PlannedWork, PlanRevision, PlannerRule } from './types.js';

export const PIPELINE_SCHEMA = 'sentinel-pipeline/draft-1' as const satisfies PipelineDefinition['schema'];

// ---- built-in vocabulary ----

export const BOOTSTRAP_OPERATIONS = Object.freeze(['capture', 'parse', 'inventory'] as const);
type BootstrapOperation = (typeof BOOTSTRAP_OPERATIONS)[number];
/** Built-in operations that select checks, by the registered adapter that runs them. */
export const BUILTIN_CHECK_OPERATIONS: Readonly<Partial<Record<BuiltinOperation, Id>>> = Object.freeze({
  'framework-controls': 'framework-controls',
  walkthrough: PATHS_ADAPTER_ID,
});
/** Scanner tool names a `tool` stage may write instead of the registry id. */
export const TOOL_ADAPTERS: Readonly<Record<string, Id>> = Object.freeze({
  gitleaks: 'secrets-gitleaks',
  'osv-scanner': 'advisories-osv',
  semgrep: 'pattern-semgrep',
  trivy: 'iac-trivy',
  zizmor: 'ci-zizmor',
});
/** The bootstrap inputs a `needs` entry may name when no declared stage has that id. */
const BOOTSTRAP_INPUTS: Readonly<Record<string, BootstrapOperation>> = Object.freeze({
  source: 'capture',
  parse: 'parse',
  inventory: 'inventory',
});
/** What each role produces besides the outputs a stage declares. */
const DEFAULT_OUTPUTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  capture: ['source'],
  parse: ['parse'],
  inventory: ['inventory'],
  check: ['findings', 'coverage'],
  walkthrough: ['findings', 'coverage', 'walkthrough', 'walkthrough-md'],
  report: ['report'],
  agent: ['observations'],
  script: [],
});
/** The review kind each agent fan-out plans; a per-entry fan-out has no review yet. */
const REVIEW_KIND_OF: Readonly<Partial<Record<StageFanOut, 'guided' | 'general'>>> = Object.freeze({
  'per-check': 'guided',
  'per-source': 'general',
  'per-run': 'general',
});

const STAGE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const CONTEXT_INPUT = /^farsight\.[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_STAGES = 64;
const isStageId = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && STAGE_ID.test(v);
const fail = (
  code: 'sentinel.plan.pipelineInvalid' | 'sentinel.plan.stageUnknown' | 'sentinel.plan.stageUnavailable',
  detail: string,
): never => {
  throw new PlanError(code, detail);
};

// ---- the stage model ----

/** What one declared stage plans. */
export type StageRole =
  | { readonly role: 'bootstrap'; readonly operation: BootstrapOperation }
  | {
      readonly role: 'check';
      readonly adapterId: Id;
      /** The rule families it selects; null: every rule of its adapter. */
      readonly rules: ReadonlySet<string> | null;
      /** A rule pack selector not yet resolved to rule families (adoption resolves it); planning refuses it. */
      readonly pack?: string;
    }
  | { readonly role: 'agent'; readonly review: 'guided' | 'general' | null }
  | { readonly role: 'script'; readonly runner: 'host' | 'container' }
  | { readonly role: 'none' };

export interface StageModel {
  readonly pipeline: PipelineDefinition;
  /** The canonical digest of the declaration. */
  readonly digest: Digest;
  /** Stage ids in a dependency order (needs and after before the stage), ties by declaration order. */
  readonly order: readonly string[];
  readonly stages: ReadonlyMap<string, StageDefinition>;
  readonly roles: ReadonlyMap<string, StageRole>;
  /** Each stage's direct upstream stages (needs and after), bootstrap stages included. */
  readonly upstream: ReadonlyMap<string, readonly string[]>;
  /** Each stage's `{stage, output}` inputs. */
  readonly inputs: ReadonlyMap<string, readonly { readonly stage: string; readonly output: string }[]>;
  /** Each stage's context inputs (`farsight.journeys`): pinned graph data, not stages. */
  readonly context: ReadonlyMap<string, readonly string[]>;
  /** Each stage's outputs, by name. */
  readonly outputs: ReadonlyMap<string, readonly string[]>;
  /** The stage id running each bootstrap operation. */
  readonly bootstrap: Readonly<Record<BootstrapOperation, string | undefined>>;
}

const outputName = (o: StageOutputDecl): unknown => (typeof o === 'string' ? o : o?.name);

function rulesOf(id: string, rules: unknown): { rules: ReadonlySet<string> | null; pack?: string } {
  // A pack selector (`pack:builtin:pattern`) names rule families by their pack; adopting the pipeline resolves it
  // against the promoted lock. Planning reads only the resolved family list (declaredAnalysis refuses a selector).
  if (typeof rules === 'string') {
    if (!/^pack:[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9-]{0,63}$/.test(rules))
      return fail('sentinel.plan.pipelineInvalid', `tool stage ${id} names a rule pack that is not a selector`);
    return { rules: null, pack: rules };
  }
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > 1024)
    return fail('sentinel.plan.pipelineInvalid', `tool stage ${id} names no rule families`);
  if (rules.some((r) => typeof r !== 'string' || !ID.test(r)))
    return fail('sentinel.plan.pipelineInvalid', `tool stage ${id} names a rule family that is not an id`);
  return { rules: new Set(rules as string[]) };
}

function roleOf(s: StageDefinition): StageRole {
  switch (s.kind) {
    case 'builtin': {
      const op = s.operation;
      if ((BOOTSTRAP_OPERATIONS as readonly string[]).includes(op))
        return { role: 'bootstrap', operation: op as BootstrapOperation };
      const adapterId = BUILTIN_CHECK_OPERATIONS[op];
      if (adapterId) return { role: 'check', adapterId, rules: null };
      if (op === 'report') return { role: 'none' };
      return fail('sentinel.plan.pipelineInvalid', `stage ${s.id} names an unknown built-in operation`);
    }
    case 'tool': {
      if (typeof s.adapter !== 'string' || !(ID.test(s.adapter) || Object.hasOwn(TOOL_ADAPTERS, s.adapter)))
        return fail('sentinel.plan.pipelineInvalid', `tool stage ${s.id} names no adapter`);
      return { role: 'check', adapterId: TOOL_ADAPTERS[s.adapter] ?? s.adapter, ...rulesOf(s.id, s.rules) };
    }
    case 'agent': {
      const fanOut = s.fanOut ?? 'per-run';
      if (!['per-run', 'per-source', 'per-entry', 'per-check'].includes(fanOut))
        return fail('sentinel.plan.pipelineInvalid', `agent stage ${s.id} names an unknown fan-out`);
      return { role: 'agent', review: REVIEW_KIND_OF[fanOut] ?? null };
    }
    case 'script':
      if (s.runner !== 'host' && s.runner !== 'container')
        return fail('sentinel.plan.pipelineInvalid', `script stage ${s.id} names no runner`);
      if (s.interpreter !== 'node' && s.interpreter !== 'sh')
        return fail('sentinel.plan.pipelineInvalid', `script stage ${s.id} names no interpreter`);
      return { role: 'script', runner: s.runner };
    default:
      return fail('sentinel.plan.pipelineInvalid', `stage ${String((s as { id?: unknown }).id)} has an unknown kind`);
  }
}

/**
 * Validates a declaration and derives its stage model: unique ids, known kinds and operations, every `needs`, `after`
 * and input naming a declared stage (and an output it produces), and no cycle. Throws a PlanError naming the first
 * problem; a valid declaration always derives the same model.
 */
export function stageModel(pipeline: PipelineDefinition): StageModel {
  if (!pipeline || typeof pipeline !== 'object' || pipeline.schema !== PIPELINE_SCHEMA)
    fail('sentinel.plan.pipelineInvalid', `the pipeline is not a ${PIPELINE_SCHEMA} declaration`);
  if (typeof pipeline.id !== 'string' || !ID.test(pipeline.id))
    fail('sentinel.plan.pipelineInvalid', 'the pipeline has no id');
  if (!Number.isSafeInteger(pipeline.revision) || pipeline.revision < 1)
    fail('sentinel.plan.pipelineInvalid', 'the pipeline revision is not a positive ordinal');
  if (!Array.isArray(pipeline.stages) || pipeline.stages.length === 0 || pipeline.stages.length > MAX_STAGES)
    fail('sentinel.plan.pipelineInvalid', `a pipeline declares 1 to ${MAX_STAGES} stages`);
  const stages = new Map<string, StageDefinition>();
  const roles = new Map<string, StageRole>();
  const bootstrap: Record<BootstrapOperation, string | undefined> = {
    capture: undefined,
    parse: undefined,
    inventory: undefined,
  };
  for (const s of pipeline.stages) {
    if (!s || typeof s !== 'object' || !isStageId(s.id)) fail('sentinel.plan.pipelineInvalid', 'a stage has no id');
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
            ? DEFAULT_OUTPUTS.walkthrough!
            : DEFAULT_OUTPUTS.check!
          : DEFAULT_OUTPUTS[role.role === 'none' ? 'report' : role.role]!;
    if (s.produces !== undefined && (!Array.isArray(s.produces) || s.produces.length > 16))
      fail('sentinel.plan.pipelineInvalid', `stage ${id} declares its outputs as anything but a list`);
    const declared = (s.produces ?? []).map(outputName);
    if (declared.some((n) => !isStageId(n)) || new Set(declared).size !== declared.length)
      fail('sentinel.plan.pipelineInvalid', `stage ${id} declares an output without a name, or one twice`);
    outputs.set(id, [...new Set([...fallback, ...(declared as string[])])]);
  }
  const upstream = new Map<string, string[]>();
  const inputs = new Map<string, { stage: string; output: string }[]>();
  const context = new Map<string, string[]>();
  for (const [id, s] of stages) {
    const up = new Set<string>();
    const typed: { stage: string; output: string }[] = [];
    const graph: string[] = [];
    if (s.needs !== undefined && (!Array.isArray(s.needs) || s.needs.length > 32))
      fail('sentinel.plan.pipelineInvalid', `stage ${id} declares its inputs as anything but a list`);
    for (const n of s.needs ?? []) {
      if (typeof n === 'string') {
        if (stages.has(n)) up.add(n);
        else if (Object.hasOwn(BOOTSTRAP_INPUTS, n) && bootstrap[BOOTSTRAP_INPUTS[n]!])
          up.add(bootstrap[BOOTSTRAP_INPUTS[n]!]!);
        else if (CONTEXT_INPUT.test(n) && n.length <= 64) graph.push(n);
        else fail('sentinel.plan.stageUnknown', `stage ${id} needs ${n}, which is not a declared stage`);
        continue;
      }
      if (!n || typeof n !== 'object' || typeof n.stage !== 'string' || typeof n.output !== 'string')
        fail('sentinel.plan.pipelineInvalid', `stage ${id} declares an input that is neither a name nor an output`);
      if (!stages.has(n.stage))
        fail('sentinel.plan.stageUnknown', `stage ${id} reads ${n.stage}, which is not declared`);
      if (!outputs.get(n.stage)!.includes(n.output))
        fail('sentinel.plan.stageUnknown', `stage ${id} reads ${n.stage}.${n.output}, which it does not produce`);
      up.add(n.stage);
      typed.push({ stage: n.stage, output: n.output });
    }
    if (s.after !== undefined && (!Array.isArray(s.after) || s.after.length > 32))
      fail('sentinel.plan.pipelineInvalid', `stage ${id} declares its ordering as anything but a list`);
    for (const a of s.after ?? []) {
      if (typeof a !== 'string' || !stages.has(a))
        fail('sentinel.plan.stageUnknown', `stage ${id} runs after ${String(a)}, which is not declared`);
      up.add(a);
    }
    if (up.has(id)) throw new PlanError('sentinel.plan.stageCycle', id);
    upstream.set(id, [...up]);
    inputs.set(id, typed);
    context.set(id, graph);
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
    context,
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

/** The stages a stage depends on that plan units, transitively through unit-less stages. */
function unitUpstream(model: StageModel, id: string): string[] {
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
  /** Check and script stages whose units a check or script stage's units depend on. */
  dependsOn(stage: string): readonly string[];
  /** The script stages, in dependency order: each plans one unit. */
  scripts(): readonly ScriptStageDefinition[];
  /** The agent stage a review seed belongs to; refused when none or two declare its fan-out. */
  stageOfSeed(seed: Pick<AgentUnitSeed, 'kind'>): string;
}

/**
 * The analysis view of a model. Refuses what this build does not plan yet rather than leaving work nobody runs: a
 * script stage, a per-entry agent fan-out, an agent stage after another agent stage, and an input another stage's
 * output feeds into anything but an agent stage.
 */
export function declaredAnalysis(model: StageModel): DeclaredAnalysis {
  for (const [id, role] of model.roles) {
    if (role.role === 'check' && role.pack !== undefined)
      throw new PlanError(
        'sentinel.plan.stageUnavailable',
        `${id}: rule pack ${role.pack} is not resolved to rule families`,
      );
    if (role.role === 'script') {
      const stage = model.stages.get(id) as ScriptStageDefinition;
      if (role.runner === 'container')
        throw new PlanError('sentinel.plan.stageUnavailable', `${id}: a script in a script-runner container`);
      if ((stage.fanOut ?? 'per-run') !== 'per-run')
        throw new PlanError('sentinel.plan.stageUnavailable', `${id}: a script fanned out ${stage.fanOut}`);
      if (!scriptOutputOf(stage))
        throw new PlanError('sentinel.plan.pipelineInvalid', `script stage ${id} declares exactly one named output`);
    }
    if (role.role === 'agent' && role.review === null)
      throw new PlanError('sentinel.plan.stageUnavailable', `${id}: an agent stage fanned out per entry point`);
    if (role.role !== 'agent' && role.role !== 'script' && model.inputs.get(id)!.length)
      throw new PlanError(
        'sentinel.plan.stageUnavailable',
        `${id}: only an agent or script stage reads another stage's output`,
      );
    // A review unit depends on every deterministic unit (checks and scripts), so a script never runs after an agent
    // stage and an agent stage never after another.
    if (role.role === 'agent' || role.role === 'script')
      for (const u of unitUpstream(model, id))
        if (model.roles.get(u)!.role === 'agent')
          throw new PlanError('sentinel.plan.stageUnavailable', `${id}: a stage after the agent stage ${u}`);
  }
  const checkStages = [...model.roles].filter(([, r]) => r.role === 'check') as [
    string,
    Extract<StageRole, { role: 'check' }>,
  ][];
  return Object.freeze({
    stageOfRule(rule: Pick<PlannerRule, 'familyId' | 'adapterId'>) {
      const matching = checkStages.filter(
        ([, r]) =>
          r.pack === undefined && r.adapterId === rule.adapterId && (r.rules === null || r.rules.has(rule.familyId)),
      );
      if (matching.length > 1)
        throw new PlanError(
          'sentinel.plan.stageAmbiguous',
          `${rule.familyId}: ${matching.map(([id]) => id).join(', ')}`,
        );
      return matching[0]?.[0] ?? null;
    },
    dependsOn(stage: string) {
      return unitUpstream(model, stage).filter((u) => model.roles.get(u)!.role !== 'agent');
    },
    scripts() {
      return model.order
        .filter((id) => model.roles.get(id)!.role === 'script')
        .map((id) => model.stages.get(id) as ScriptStageDefinition);
    },
    stageOfSeed(seed: Pick<AgentUnitSeed, 'kind'>) {
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
export function stagesOfUnits(model: StageModel, plan: Pick<PlanRevision, 'units' | 'checks'>): Map<Id, string> {
  const out = new Map<Id, string>();
  const familyOf = new Map(plan.checks.map((c) => [c.id, c.familyId]));
  for (const u of plan.units) {
    let stage: string | undefined;
    if (u.stage === 'capture' || u.stage === 'parse' || u.stage === 'inventory') stage = model.bootstrap[u.stage];
    else if (u.contract === SCRIPT_CONTRACT) stage = model.roles.get(u.stage)?.role === 'script' ? u.stage : undefined;
    else if (u.stage === 'review-guided' || u.stage === 'review-general') {
      const kind = u.stage === 'review-guided' ? 'guided' : 'general';
      stage = [...model.roles].find(([, r]) => r.role === 'agent' && r.review === kind)?.[0];
    } else {
      const families = new Set(u.checks.map((c) => familyOf.get(c)));
      const owners = [...model.roles].filter(
        ([, r]) =>
          r.role === 'check' &&
          r.pack === undefined &&
          r.adapterId === u.adapterId &&
          [...families].every((f) => f !== undefined && (r.rules === null || r.rules.has(f))),
      );
      stage = owners.length === 1 ? owners[0]![0] : undefined;
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
  /** Every unit the selection expands to: the selected stages' units (what a unit-id rerun names). */
  readonly units: readonly Id[];
}

/** Expands stage ids to the plan's unit ids and previews the downstream stages a rerun of them reaches. */
export function selectStages(
  model: StageModel,
  plan: Pick<PlanRevision, 'units' | 'checks'>,
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
  [PATHS_ADAPTER_ID]: 'walkthrough',
});
const BUILTIN_OPERATION_OF: Readonly<Record<Id, BuiltinOperation>> = Object.freeze({
  'framework-controls': 'framework-controls',
  [PATHS_ADAPTER_ID]: 'walkthrough',
});

/** A review stage of the default pipeline: which review, and the runner and model the adopted selection binds. */
export interface DefaultReview {
  readonly kind: 'guided' | 'general';
  readonly runner: AgentRunnerId;
  readonly model: string;
  readonly provider?: Id;
}

/**
 * Today's plan, declared: capture, parse and inventory; one stage per check adapter the policy's rules run under,
 * selecting exactly those rules (Sentinel's own walkthrough and framework controls as built-in stages); the guided
 * and general reviews as agent stages after every check stage; and the report. Planning it reproduces the derived
 * plan unit for unit and digest for digest.
 */
export function defaultPipelineOf(options: {
  readonly checks: readonly { readonly adapterId: Id; readonly rules: readonly string[] }[];
  readonly reviews?: readonly DefaultReview[];
}): PipelineDefinition {
  const rulesBy = new Map<Id, Set<string>>();
  for (const c of options.checks)
    for (const r of c.rules) (rulesBy.get(c.adapterId) ?? rulesBy.set(c.adapterId, new Set()).get(c.adapterId)!).add(r);
  // Any other adapter's stage is named after it; a name that is not a stage id, or one already taken, gets one from
  // the adapter id's digest, so the default pipeline is a valid declaration for every lock.
  const taken = new Set<string>(['capture', 'parse', 'inventory', 'report', 'review-guided', 'review-general']);
  const stageIdOf = (adapterId: Id): string => {
    const named = DEFAULT_CHECK_STAGES[adapterId];
    const plain = `check-${adapterId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')}`;
    const id =
      named && !taken.has(named)
        ? named
        : isStageId(plain) && !taken.has(plain)
          ? plain
          : `check-${digestOf(adapterId).slice(7, 23)}`;
    taken.add(id);
    return id;
  };
  const checks: StageDefinition[] = [...rulesBy.keys()].sort().map((adapterId) => {
    const id = stageIdOf(adapterId);
    const operation = BUILTIN_OPERATION_OF[adapterId];
    return operation
      ? { id, kind: 'builtin', operation, needs: ['inventory'] }
      : { id, kind: 'tool', adapter: adapterId, rules: [...rulesBy.get(adapterId)!].sort(), needs: ['inventory'] };
  });
  const after = checks.map((c) => c.id);
  const reviews: StageDefinition[] = [...(options.reviews ?? [])]
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
    .map((r) => ({
      id: `review-${r.kind}`,
      kind: 'agent',
      mode: 'brokered',
      runner: r.runner,
      ...(r.provider ? { provider: r.provider } : {}),
      model: r.model,
      fanOut: r.kind === 'guided' ? 'per-check' : 'per-source',
      needs: ['inventory'],
      ...(after.length ? { after } : {}),
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
        ...(after.length + reviews.length ? { after: [...after, ...reviews.map((r) => r.id)] } : {}),
      },
    ],
  });
}

/** Units a check stage's units depend on in an analysis revision, besides the published bootstrap. */
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

/** What a revision runs, in the planner's words. */
export type PlanShape = 'checks-and-review' | 'checks' | 'review-only' | 'bootstrap' | 'nothing';

/**
 * What a revision runs: deterministic checks, model review, both, the bootstrap, or nothing. A revision that holds
 * only review units checks nothing deterministically and names no scanner (an agentic-only plan); one with neither
 * plans nothing. The words are the catalog's `sentinel.plan.shape.*`.
 */
export function planShapeOf(plan: Pick<PlanRevision, 'kind' | 'units'>): PlanShape {
  if (plan.kind === 'bootstrap') return 'bootstrap';
  const checks = plan.units.some((u) => !u.review);
  const reviews = plan.units.some((u) => u.review);
  return checks && reviews ? 'checks-and-review' : checks ? 'checks' : reviews ? 'review-only' : 'nothing';
}

/** The catalog key of a plan shape's words. */
export const PLAN_SHAPE_KEYS: Readonly<Record<PlanShape, string>> = Object.freeze({
  'checks-and-review': 'sentinel.plan.shape.checksAndReview',
  checks: 'sentinel.plan.shape.checks',
  'review-only': 'sentinel.plan.shape.reviewOnly',
  bootstrap: 'sentinel.plan.shape.bootstrap',
  nothing: 'sentinel.plan.shape.nothing',
});

// ---- script stages ----

/** What a script stage's unit is pinned to: its entry's bytes and its output schema's bytes, by digest. */
export interface ScriptPins {
  readonly entry: Digest;
  readonly schema: Digest;
}

/** The contract a script stage's unit carries; its unit stage is the declared stage id. */
export const SCRIPT_CONTRACT = 'sentinel.stage.script.host';

/** The one typed output a script stage writes: its single declared named output. */
export function scriptOutputOf(stage: Pick<ScriptStageDefinition, 'id' | 'produces'>): NamedStageOutput | undefined {
  const produces = stage.produces ?? [];
  const named = produces.filter((p): p is NamedStageOutput => typeof p !== 'string');
  return named.length === 1 && produces.length === 1 ? named[0] : undefined;
}

/**
 * The input fingerprint of a script stage's unit: the stage as declared (interpreter, runner, arguments, inputs and
 * output), its entry and output schema by digest, the runner operation by digest and the units it waits for. A
 * changed entry or schema byte is a different unit (its id derives from this fingerprint).
 */
export function scriptFingerprintOf(
  stage: ScriptStageDefinition,
  pins: ScriptPins,
  runnerDigest: Digest,
  dependencies: readonly WorkRef[],
): Digest {
  return digestOf({
    stage: stage.id,
    runner: stage.runner,
    interpreter: stage.interpreter,
    entry: { ref: stage.entry, digest: pins.entry },
    outputSchema: pins.schema,
    args: [...(stage.args ?? [])],
    needs: structuredClone(stage.needs ?? []),
    produces: structuredClone(stage.produces ?? []),
    implementation: runnerDigest,
    dependencies: dependencies.map((d) => [d.id, d.revision]),
  }) as Digest;
}

/**
 * What a plan preview must say before it is confirmed, as catalog keys: a revision holding a host script stage runs
 * unconfined on this computer as the owner.
 */
export function planNoticesOf(plan: Pick<PlanRevision, 'units'>): string[] {
  return plan.units.some((u) => u.contract === SCRIPT_CONTRACT) ? ['sentinel.plan.notice.hostScriptUnconfined'] : [];
}
