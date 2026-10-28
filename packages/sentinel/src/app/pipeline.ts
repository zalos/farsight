// Reading and checking a declared pipeline (README §3.3, `.farsight/sentinel/pipeline.json`). Pure: nothing here
// reads a file, the store, a clock, the network or the trust folder; app/pipeline-adoption.ts reads the file and
// records the owner's adoption, and the plan calls `checkPipeline` with what the workspace holds.
//
// A problem is one of two classes. `refused`: the pipeline cannot mean anything as written (a cycle, a stage that
// reads what nobody produces, an output its reader cannot read, a feature that is off, a pack that is not there);
// `plan` refuses it before anything runs, naming the code and the stage. `unavailable`: the pipeline is sound but
// this workspace cannot run a stage yet (a rule not promoted, a tool not adopted, a runner not configured); `plan`
// names it and goes on, and that stage's checks stay unplanned with their reason, as a missing tool's do today.
import { containsCredentialShape } from '@farsight/core/dist/credential-shapes.js';
import type {
  BuiltinOperation,
  ContextInputId,
  FeatureFlagName,
  PackRef,
  PipelineDefinition,
  RuleFamilyId,
  SettingsEnvelope,
  StageDefinition,
  StageId,
  StageInputDecl,
  StageOutputType,
} from '../contracts/index.js';
import { validateEnvelope } from '../validate.js';
import { featureEnabled } from '../policy/features.js';

/** The pipeline file's place in a workspace, beside the settings. */
export const PIPELINE_PATH = '.farsight/sentinel/pipeline.json';
/** The largest pipeline file read. */
export const MAX_PIPELINE_BYTES = 256 * 1024;

/** The reason codes of reading, checking and adopting a pipeline; each is a catalog key. */
export const PIPELINE_ERROR_CODES = [
  'sentinel.pipeline.unreadable',
  'sentinel.pipeline.invalid',
  'sentinel.pipeline.credentialValue',
  'sentinel.pipeline.duplicateStage',
  'sentinel.pipeline.unknownStage',
  'sentinel.pipeline.cycle',
  'sentinel.pipeline.missingInput',
  'sentinel.pipeline.incompatibleType',
  'sentinel.pipeline.flagDisabled',
  'sentinel.pipeline.unknownPack',
  'sentinel.pipeline.unknownAdapter',
  'sentinel.pipeline.unknownRule',
  'sentinel.pipeline.notPromoted',
  'sentinel.pipeline.toolNotAdopted',
  'sentinel.pipeline.runnerNotConfigured',
  'sentinel.pipeline.notAdopted',
  'sentinel.pipeline.changed',
  'sentinel.pipeline.adoptionUnauthorized',
] as const;
export type PipelineErrorCode = (typeof PIPELINE_ERROR_CODES)[number];

export class PipelineError extends Error {
  constructor(
    readonly code: PipelineErrorCode,
    readonly detail = '',
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PipelineError';
  }
}

/** Parses pipeline bytes: UTF-8 JSON, the draft schema, and no value shaped like a credential (never echoed). */
export function parsePipeline(bytes: Uint8Array): PipelineDefinition {
  if (bytes.byteLength > MAX_PIPELINE_BYTES)
    throw new PipelineError('sentinel.pipeline.unreadable', `larger than ${MAX_PIPELINE_BYTES} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new PipelineError('sentinel.pipeline.invalid', 'not UTF-8 JSON');
  }
  const checked = validateEnvelope('pipeline', value);
  if (!checked.ok)
    throw new PipelineError(
      'sentinel.pipeline.invalid',
      `${checked.errors[0]?.path || '/'}: ${checked.errors[0]?.message ?? 'invalid'}`,
    );
  for (const [path, text] of strings(checked.value, ''))
    if (containsCredentialShape(text))
      throw new PipelineError(
        'sentinel.pipeline.credentialValue',
        `${path} holds a value shaped like a credential; a pipeline holds none`,
      );
  return checked.value;
}

function* strings(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === 'string') yield [path, value];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* strings(value[i], `${path}/${i}`);
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) yield* strings(v, `${path}/${k}`);
}

// ---- outputs and inputs ----

/** One output a stage publishes, by the name a reader wires it with. A custom output's type is its schema id. */
export interface StageOutput {
  readonly name: string;
  readonly type: StageOutputType | 'custom';
  readonly schema?: string;
}

/** What each built-in operation publishes. */
const BUILTIN_OUTPUTS: Readonly<Record<BuiltinOperation, readonly StageOutputType[]>> = {
  'capture': ['source'],
  'parse': ['parse'],
  'inventory': ['inventory'],
  'walkthrough': ['walkthrough-md'],
  'framework-controls': ['findings', 'coverage'],
  'report': ['report'],
};
/** The output name a typed output is wired by: the type, except the walkthrough's Markdown (`walkthrough`). */
export const outputNameOf = (type: StageOutputType): string => (type === 'walkthrough-md' ? 'walkthrough' : type);

/** The types a stage of each kind can publish of its own (a declared `produces` must be among them). */
function naturalOutputs(stage: StageDefinition): readonly StageOutputType[] {
  switch (stage.kind) {
    case 'builtin':
      return BUILTIN_OUTPUTS[stage.operation];
    case 'tool':
      return ['findings', 'coverage'];
    case 'agent':
      return ['observations'];
    case 'script':
      return [];
  }
}
/** Output types a model or a script may declare: never coverage, and never what only Sentinel's own stages make. */
const DECLARABLE: ReadonlySet<StageOutputType> = new Set(['findings', 'observations', 'walkthrough-md']);

/** Every output a stage publishes: its natural ones, then those it declares. */
export function stageOutputs(stage: StageDefinition): readonly StageOutput[] {
  const out = new Map<string, StageOutput>();
  for (const t of naturalOutputs(stage)) out.set(outputNameOf(t), { name: outputNameOf(t), type: t });
  for (const d of stage.produces ?? []) {
    const o: StageOutput =
      typeof d === 'string' ? { name: outputNameOf(d), type: d } : { name: d.name, type: 'custom', schema: d.schema };
    if (!out.has(o.name)) out.set(o.name, o);
  }
  return [...out.values()];
}

/** The input types a stage can read. A stage reading anything else is refused. */
function accepts(stage: StageDefinition): ReadonlySet<StageOutputType | 'custom' | 'context'> {
  const all = new Set<StageOutputType | 'custom' | 'context'>([
    'source',
    'parse',
    'inventory',
    'findings',
    'coverage',
    'observations',
    'walkthrough-md',
    'report',
    'custom',
    'context',
  ]);
  switch (stage.kind) {
    case 'tool':
      return new Set(['source', 'parse', 'inventory']);
    case 'builtin':
      switch (stage.operation) {
        case 'capture':
          return new Set();
        case 'parse':
          return new Set(['source']);
        case 'inventory':
          return new Set(['source', 'parse']);
        case 'walkthrough':
        case 'framework-controls':
          return new Set(['source', 'parse', 'inventory']);
        case 'report':
          all.delete('source');
          return all;
      }
      return all;
    case 'agent':
    case 'script':
      return all;
  }
}

/** The input type a stage must read at least one of, or null when it needs none. */
function requires(stage: StageDefinition): StageOutputType | 'any' | null {
  switch (stage.kind) {
    case 'tool':
      return 'source';
    case 'agent':
      return 'any';
    case 'script':
      return null;
    case 'builtin':
      return stage.operation === 'capture'
        ? null
        : stage.operation === 'parse'
          ? 'source'
          : stage.operation === 'report'
            ? 'any'
            : 'parse';
  }
}

/** The application-graph context a stage may read: pinned Farsight data, never live disk. */
export const CONTEXT_INPUTS: readonly ContextInputId[] = Object.freeze(['farsight.journeys', 'farsight.graph']);

/** Every stage and skill pack reference a pipeline names, once each, in declaration order. */
export function packRefsOf(pipeline: PipelineDefinition): readonly PackRef[] {
  const refs = new Set<PackRef>();
  for (const s of pipeline.stages) {
    if (s.kind === 'agent') {
      if (s.prompt) refs.add(s.prompt);
      if (s.instructions) refs.add(s.instructions);
      for (const k of s.skills ?? []) refs.add(k);
    } else if (s.kind === 'script') refs.add(s.entry);
  }
  return Object.freeze([...refs]);
}

// ---- the check ----

export type PipelineProblemClass = 'refused' | 'unavailable';

export interface PipelineProblem {
  readonly class: PipelineProblemClass;
  readonly code: PipelineErrorCode;
  /** The stage it is about; null for the pipeline as a whole. */
  readonly stage: StageId | null;
  /** Safe context: stage ids, output names, pack references, feature names. Never a settings value. */
  readonly detail: string;
}

/**
 * What the workspace holds, for the checks that depend on it. A field left out is not checked: `pipeline validate`
 * without a workspace checks the pipeline's own meaning only.
 */
export interface PipelineEnvironment {
  /** The adopted settings (or the defaults): the features, and the providers a runner binds. */
  readonly settings?: Readonly<SettingsEnvelope> | null;
  /** The digest of a promoted stage or skill pack's referenced bytes, or undefined when it is not there. */
  readonly pack?: (ref: PackRef) => string | undefined;
  /** The rule families of a whole rule pack (`pack:builtin:pattern`), or undefined when there is none. */
  readonly rulePack?: (selector: string) => readonly RuleFamilyId[] | undefined;
  /** Every scanner adapter this build registers, with the rule families it implements. */
  readonly adapters?: ReadonlyMap<string, ReadonlySet<RuleFamilyId>>;
  /** The owner's promoted rule lock: each locked rule family and the adapter it runs under. */
  readonly locked?: ReadonlyMap<RuleFamilyId, string>;
  /** The adapters whose pinned tool and offline assets the owner adopted. */
  readonly installed?: ReadonlySet<string>;
}

const RUNNER_FEATURE: Readonly<Record<string, FeatureFlagName>> = {
  'claude-cli': 'runner.claude-cli',
  'copilot-cli': 'runner.copilot-cli',
  'hosted-api': 'review.hosted-api',
};
const FLAG_NAMES: readonly FeatureFlagName[] = [
  'stage.host-scripts',
  'runner.claude-cli',
  'runner.copilot-cli',
  'review.hosted-api',
];

/** The features one stage needs. */
function featuresOf(stage: StageDefinition): readonly FeatureFlagName[] {
  if (stage.kind === 'script' && stage.runner === 'host') return ['stage.host-scripts'];
  // A local model server is no gated feature: its adopted provider keeps the source on this machine.
  if (stage.kind === 'agent' && RUNNER_FEATURE[stage.runner]) return [RUNNER_FEATURE[stage.runner]!];
  return [];
}

/** Does the adopted settings provider list bind this agent stage's runner and model? */
function runnerConfigured(stage: Extract<StageDefinition, { kind: 'agent' }>, settings: Readonly<SettingsEnvelope>) {
  // Which adopted providers can serve each runner: the CLI of that name, a hosted API (an HTTP provider whose
  // disclosure is hosted), or a local model server (an Ollama provider that keeps the source here).
  const serves = (p: SettingsEnvelope['providers'][number]) =>
    stage.runner === 'hosted-api'
      ? (p.kind === 'openai-compatible' || p.kind === 'ollama') && p.disclosure === 'hosted'
      : stage.runner === 'ollama'
        ? p.kind === 'ollama' && p.disclosure === 'local-only'
        : p.kind === stage.runner;
  const providers = settings.providers.filter(
    (p) => serves(p) && (stage.provider === undefined || p.id === stage.provider),
  );
  if (stage.provider === undefined && providers.length > 1) return false;
  return providers.some((p) => (p.models ?? []).some((m) => m.model === stage.model && m.capability !== null));
}

/**
 * Every problem with a pipeline, in a fixed order (pipeline-wide first, then stage by stage in declaration order).
 * `refused` problems mean `plan` stops; `unavailable` ones are reported and the plan goes on.
 */
export function checkPipeline(pipeline: PipelineDefinition, env: PipelineEnvironment = {}): readonly PipelineProblem[] {
  const problems: PipelineProblem[] = [];
  const refuse = (code: PipelineErrorCode, stage: StageId | null, detail: string) =>
    problems.push(Object.freeze({ class: 'refused' as const, code, stage, detail }));
  const unavailable = (code: PipelineErrorCode, stage: StageId, detail: string) =>
    problems.push(Object.freeze({ class: 'unavailable' as const, code, stage, detail }));

  const byId = new Map<StageId, StageDefinition>();
  for (const s of pipeline.stages) {
    if (byId.has(s.id)) refuse('sentinel.pipeline.duplicateStage', s.id, `stage ${s.id} is declared twice`);
    else byId.set(s.id, s);
  }

  // Edges for the cycle check: every stage a stage reads from or waits for.
  const edges = new Map<StageId, StageId[]>();
  const inputType = (need: StageInputDecl): (StageOutputType | 'custom' | 'context')[] | undefined => {
    if (typeof need === 'string') {
      if (need.startsWith('farsight.')) return CONTEXT_INPUTS.includes(need) ? ['context'] : undefined;
      const producer = byId.get(need);
      return producer ? stageOutputs(producer).map((o) => o.type) : undefined;
    }
    const producer = byId.get(need.stage);
    const out = producer && stageOutputs(producer).find((o) => o.name === need.output);
    return out ? [out.type] : undefined;
  };

  for (const s of pipeline.stages) {
    const deps: StageId[] = [];
    const reads = accepts(s);
    const read: (StageOutputType | 'custom' | 'context')[] = [];
    for (const need of s.needs ?? []) {
      const producerId = typeof need === 'string' ? (need.startsWith('farsight.') ? null : need) : need.stage;
      if (producerId === s.id) {
        refuse('sentinel.pipeline.cycle', s.id, `stage ${s.id} reads its own output`);
        continue;
      }
      if (producerId !== null && !byId.has(producerId)) {
        refuse('sentinel.pipeline.unknownStage', s.id, `stage ${s.id} reads ${producerId}, which is not declared`);
        continue;
      }
      if (producerId !== null) deps.push(producerId);
      const types = inputType(need);
      if (types === undefined) {
        refuse(
          'sentinel.pipeline.missingInput',
          s.id,
          typeof need === 'string'
            ? `stage ${s.id} reads ${need}, which no workspace supplies`
            : `stage ${s.id} reads ${need.stage}.${need.output}, which ${need.stage} does not produce`,
        );
        continue;
      }
      const usable = types.filter((t) => reads.has(t));
      if (!usable.length) {
        refuse(
          'sentinel.pipeline.incompatibleType',
          s.id,
          `stage ${s.id} cannot read ${typeof need === 'string' ? need : `${need.stage}.${need.output}`} (${types.join(', ')})`,
        );
        continue;
      }
      read.push(...usable);
    }
    for (const after of s.after ?? []) {
      if (after === s.id) refuse('sentinel.pipeline.cycle', s.id, `stage ${s.id} waits for itself`);
      else if (!byId.has(after))
        refuse('sentinel.pipeline.unknownStage', s.id, `stage ${s.id} waits for ${after}, which is not declared`);
      else deps.push(after);
    }
    edges.set(s.id, deps);
    const need = requires(s);
    if (need === 'any' ? read.length === 0 : need !== null && !read.includes(need))
      refuse(
        'sentinel.pipeline.missingInput',
        s.id,
        `stage ${s.id} needs ${need === 'any' ? 'an input' : `a ${need} input`} and reads none`,
      );
    checkStage(s, refuse);
    checkFeatures(s, pipeline, env, refuse);
    checkPacks(s, env, refuse);
    checkAvailability(s, env, refuse, unavailable);
  }
  for (const name of FLAG_NAMES)
    if (pipeline.flags?.[name] === true && env.settings !== undefined && !featureEnabled(env.settings, name))
      refuse(
        'sentinel.pipeline.flagDisabled',
        null,
        `the pipeline needs ${name}, which the adopted settings leave off`,
      );
  const cycle = findCycle(
    pipeline.stages.map((s) => s.id),
    edges,
  );
  if (cycle) refuse('sentinel.pipeline.cycle', cycle[0]!, `the stages wait on each other: ${cycle.join(' → ')}`);
  return Object.freeze(problems);
}

type Refuse = (code: PipelineErrorCode, stage: StageId | null, detail: string) => void;

/** Fields that belong together within one stage. */
function checkStage(s: StageDefinition, refuse: Refuse): void {
  const natural = new Set(naturalOutputs(s));
  const names = new Set<string>();
  for (const d of s.produces ?? []) {
    const name = typeof d === 'string' ? outputNameOf(d) : d.name;
    if (names.has(name)) refuse('sentinel.pipeline.incompatibleType', s.id, `stage ${s.id} declares ${name} twice`);
    names.add(name);
    if (typeof d !== 'string') {
      if (s.kind === 'builtin' || s.kind === 'tool')
        refuse('sentinel.pipeline.incompatibleType', s.id, `a ${s.kind} stage produces only its own outputs`);
      continue;
    }
    if (natural.has(d)) continue;
    if (s.kind === 'builtin' || s.kind === 'tool' || !DECLARABLE.has(d))
      refuse('sentinel.pipeline.incompatibleType', s.id, `stage ${s.id} cannot produce ${d}`);
  }
  if ((s.kind === 'agent' || s.kind === 'script') && s.required === true)
    refuse(
      'sentinel.pipeline.incompatibleType',
      s.id,
      `stage ${s.id} cannot be required: only builtin and tool stages make coverage`,
    );
  if (s.fanOut === 'per-check' && s.kind !== 'tool')
    refuse('sentinel.pipeline.incompatibleType', s.id, `only a tool stage fans out per check`);
  if (s.kind === 'agent') {
    if (s.mode === 'brokered' && s.instructions !== undefined)
      refuse('sentinel.pipeline.incompatibleType', s.id, `a brokered stage sends a prompt, not instructions`);
    if (s.mode === 'native' && s.prompt !== undefined)
      refuse('sentinel.pipeline.incompatibleType', s.id, `a native stage reads instructions, not a prompt`);
    for (const [field, ref] of [
      ['prompt', s.prompt],
      ['instructions', s.instructions],
    ] as const)
      if (ref !== undefined && !/^stages\/[^#]+#.+$/.test(ref))
        refuse(
          'sentinel.pipeline.incompatibleType',
          s.id,
          `${field} names a file in a stage pack (stages/<id>@<n>#<file>)`,
        );
    for (const ref of s.skills ?? [])
      if (!/^skills\/[^#]+$/.test(ref))
        refuse('sentinel.pipeline.incompatibleType', s.id, `a skill is a whole skill pack (skills/<id>@<n>)`);
  }
  if (s.kind === 'script' && !/^stages\/[^#]+#.+$/.test(s.entry))
    refuse('sentinel.pipeline.incompatibleType', s.id, `entry names a file in a stage pack (stages/<id>@<n>#<file>)`);
}

function checkFeatures(s: StageDefinition, pipeline: PipelineDefinition, env: PipelineEnvironment, refuse: Refuse) {
  for (const name of featuresOf(s)) {
    if (pipeline.flags?.[name] === false)
      refuse('sentinel.pipeline.flagDisabled', s.id, `stage ${s.id} needs ${name}, which the pipeline turns off`);
    else if (env.settings !== undefined && !featureEnabled(env.settings, name))
      refuse(
        'sentinel.pipeline.flagDisabled',
        s.id,
        `stage ${s.id} needs ${name}, which the adopted settings leave off`,
      );
  }
}

function checkPacks(s: StageDefinition, env: PipelineEnvironment, refuse: Refuse) {
  const refs = packRefsOf({ schema: 'sentinel-pipeline/draft-1', id: 'stage', revision: 1, stages: [s] });
  if (env.pack)
    for (const ref of refs)
      if (env.pack(ref) === undefined)
        refuse('sentinel.pipeline.unknownPack', s.id, `stage ${s.id} names ${ref}, which is not a promoted pack`);
  if (s.kind === 'tool' && typeof s.rules === 'string' && env.rulePack && env.rulePack(s.rules) === undefined)
    refuse('sentinel.pipeline.unknownPack', s.id, `stage ${s.id} names ${s.rules}, which is not a rule pack`);
}

function checkAvailability(
  s: StageDefinition,
  env: PipelineEnvironment,
  refuse: Refuse,
  unavailable: (code: PipelineErrorCode, stage: StageId, detail: string) => void,
) {
  if (s.kind === 'tool' && env.adapters) {
    const implemented = env.adapters.get(s.adapter);
    if (!implemented) {
      refuse(
        'sentinel.pipeline.unknownAdapter',
        s.id,
        `stage ${s.id} names ${s.adapter}, which this build does not register`,
      );
      return;
    }
    const families = typeof s.rules === 'string' ? (env.rulePack?.(s.rules) ?? []) : s.rules;
    for (const f of families) {
      if (!implemented.has(f)) refuse('sentinel.pipeline.unknownRule', s.id, `${s.adapter} does not run ${f}`);
      else if (env.locked && env.locked.get(f) !== s.adapter)
        unavailable('sentinel.pipeline.notPromoted', s.id, `${f} is not in the owner's promoted rule lock`);
    }
    if (env.installed && !env.installed.has(s.adapter))
      unavailable('sentinel.pipeline.toolNotAdopted', s.id, `the pinned tool for ${s.adapter} is not adopted here`);
  }
  if (s.kind === 'agent' && env.settings && !runnerConfigured(s, env.settings))
    unavailable(
      'sentinel.pipeline.runnerNotConfigured',
      s.id,
      `no adopted ${s.runner} provider binds the model ${s.model}${s.provider ? ` through ${s.provider}` : ''}`,
    );
}

/** The first cycle over `edges`, as the stage ids around it, or null. */
function findCycle(ids: readonly StageId[], edges: ReadonlyMap<StageId, readonly StageId[]>): StageId[] | null {
  const state = new Map<StageId, 1 | 2>();
  const path: StageId[] = [];
  const visit = (id: StageId): StageId[] | null => {
    state.set(id, 1);
    path.push(id);
    for (const next of edges.get(id) ?? []) {
      if (next === id) continue;
      const seen = state.get(next);
      if (seen === 1) return [...path.slice(path.indexOf(next)), next];
      if (seen === undefined) {
        const found = visit(next);
        if (found) return found;
      }
    }
    path.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of ids)
    if (!state.has(id)) {
      const found = visit(id);
      if (found) return found;
    }
  return null;
}
