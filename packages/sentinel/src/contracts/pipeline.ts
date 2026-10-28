// The declared pipeline (Sentinel v2, README §3): a digest-pinned list of stages the owner writes in
// `.farsight/sentinel/pipeline.json`, what one stage run reads and writes, and the provenance of every stage run.
//
// A pipeline declares; it never grants. Its flags are requests checked against the adopted settings through the
// feature registry (policy/features.ts); a tool or a model it names runs only when the existing policy, capability
// and credential verdicts admit it. Stage ids are the plan's unit stage (`PlanStage`), so the built-in ids every
// retained plan carries stay valid. The four kinds map onto the work contract's `StageKind`: `builtin` is `coded`,
// `tool` is `external-tool`, `agent` is `agentic` and `script` is `script`.
import type { ArtifactId, Count, DecimalAmount, Digest, Id, Ordinal, ShortText, Timestamp, WorkRef } from './common.js';
import type { IdentitySource, UsageCertainty } from './attempt.js';
import type { CurrencyCode, ModelName } from './policy.js';
import type { RuleFamilyId } from './rules.js';
import type { WorkState } from './work.js';

/**
 * A stage id: a built-in plan stage (`capture`, `review-guided`) or one a pipeline declares (`secrets`, `triage`).
 * Lower-case words joined by single hyphens, so it never collides with a context input, which carries a dot.
 * @pattern ^[a-z][a-z0-9]*(-[a-z0-9]+)*$
 * @maxLength 64
 */
export type StageId = string;

/** Who implements a declared stage, in the words a pipeline author writes. */
export type PipelineStageKind = 'builtin' | 'tool' | 'script' | 'agent';

/**
 * What a `builtin` stage runs: Sentinel's own capture, parse and inventory, the bounded call paths under each entry
 * point (`walkthrough`, today's `analysis/paths`), the framework control facts, and the report.
 */
export type BuiltinOperation = 'capture' | 'parse' | 'inventory' | 'walkthrough' | 'framework-controls' | 'report';

/** The typed outputs Sentinel itself knows how to read. A custom output names a schema instead. */
export type StageOutputType =
  'source' | 'parse' | 'inventory' | 'findings' | 'coverage' | 'observations' | 'walkthrough-md' | 'report';

/**
 * The name one stage's output is wired by (`findings`, `walkthrough`, `triage`).
 * @pattern ^[a-z][a-z0-9]*(-[a-z0-9]+)*$
 * @maxLength 64
 */
export type StageOutputName = string;

/**
 * A custom output's schema id, `<area>.<name>/v<n>` (`sentinel.triage/v1`). Sentinel validates the stage's output
 * against it after the stage exits; a failed validation is a failed attempt, never a partial publication.
 * @pattern ^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+/v[1-9][0-9]{0,5}$
 * @maxLength 128
 */
export type OutputSchemaId = string;

/**
 * Context the application graph supplies (`farsight.journeys`): pinned Farsight data, never live disk.
 * @pattern ^farsight\.[a-z][a-z0-9]*(-[a-z0-9]+)*$
 * @maxLength 64
 */
export type ContextInputId = string;

/** One named output of an upstream stage. It resolves to exact artifact ids when the producer publishes. */
export interface StageOutputRef {
  stage: StageId;
  output: StageOutputName;
}

/** A typed input: every output of a stage (by its id), one named output of a stage, or graph context. */
export type StageInputDecl = StageId | ContextInputId | StageOutputRef;

/** A custom typed output: its name for wiring and the schema its bytes must validate against. */
export interface NamedStageOutput {
  name: StageOutputName;
  schema: OutputSchemaId;
}

/** A typed output a stage declares: one Sentinel knows, or a named custom one. */
export type StageOutputDecl = StageOutputType | NamedStageOutput;

/** How many units a stage becomes: one per run, per captured source, per entry point or per planned check. */
export type StageFanOut = 'per-run' | 'per-source' | 'per-entry' | 'per-check';

/**
 * A file inside a promoted stage pack, `stages/<id>@<revision>#<file>`, or a whole skill pack,
 * `skills/<id>@<revision>`. The pipeline's digest covers the referenced bytes, so a changed prompt is a new pipeline.
 * @pattern ^(stages|skills)/[a-z0-9][a-z0-9-]{0,63}@[1-9][0-9]{0,8}(#[A-Za-z0-9][A-Za-z0-9._-]{0,127}(/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,7})?$
 * @maxLength 512
 */
export type PackRef = string;

/**
 * A whole promoted rule pack a tool stage selects, `pack:<origin>:<name>` (`pack:builtin:pattern`).
 * @pattern ^pack:[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9-]{0,63}$
 * @maxLength 160
 */
export type RulePackSelector = string;

/**
 * Rule families a tool stage runs, by id.
 * @minItems 1
 * @maxItems 1024
 */
export type RuleFamilyList = RuleFamilyId[];

/** Bounds on one stage. Each is a ceiling the policy may lower; none is a grant. */
export interface StageBudget {
  /**
   * @asType integer
   * @minimum 1
   * @maximum 64
   */
  turns?: number;
  /**
   * Tokens in and out together, per unit.
   * @asType integer
   * @minimum 1
   * @maximum 10000000
   */
  tokens?: number;
  /** A monetary ceiling in US dollars, written as a decimal string so it is never a binary float. */
  usd?: DecimalAmount;
  /**
   * @asType integer
   * @minimum 1
   * @maximum 3600
   */
  seconds?: number;
}

/** What every declared stage carries, whatever its kind. */
interface StageDefinitionBase {
  id: StageId;
  /**
   * Typed inputs. A missing required input, a cycle or an incompatible type refuses the pipeline before anything runs.
   * @maxItems 32
   */
  needs?: StageInputDecl[];
  /** @maxItems 16 */
  produces?: StageOutputDecl[];
  /**
   * Ordering only: these stages finish first, and nothing of theirs is read.
   * @maxItems 32
   */
  after?: StageId[];
  /** Absent: one unit per run. */
  fanOut?: StageFanOut;
  /** A required stage that does not complete leaves required coverage incomplete. Only `builtin` and `tool` make coverage. */
  required?: boolean;
  budget?: StageBudget;
}

/** A stage implemented by Sentinel's own code, in-process or as a bounded child. */
export interface BuiltinStageDefinition extends StageDefinitionBase {
  kind: 'builtin';
  operation: BuiltinOperation;
}

/** A scanner adapter in a pinned Linux container, never pulled during a scan, with no host fallback. */
export interface ToolStageDefinition extends StageDefinitionBase {
  kind: 'tool';
  /** A registered scanner adapter (`gitleaks`, `semgrep`); availability is checked against the registry. */
  adapter: Id;
  /** The rule families it runs, or one whole promoted pack. Only locked rules are planned. */
  rules: RuleFamilyList | RulePackSelector;
}

/**
 * One argument passed to a script, as written. Never a credential: settings and pipelines hold none.
 * @maxLength 1024
 */
export type ScriptArgument = string;

/** An entry file from a promoted stage pack, run on the host (behind `stage.host-scripts`) or in a pinned container. */
export interface ScriptStageDefinition extends StageDefinitionBase {
  kind: 'script';
  /** `host` is the weaker isolation class and is named so in the report. */
  runner: 'host' | 'container';
  interpreter: 'node' | 'sh';
  entry: PackRef;
  /** @maxItems 64 */
  args?: ScriptArgument[];
}

/**
 * The agent runners a stage may name: the two CLIs, a hosted model API (off unless `review.hosted-api` is on), and a
 * local model server (an adopted `ollama` provider that keeps the source on this machine).
 */
export type AgentRunnerId = 'claude-cli' | 'copilot-cli' | 'hosted-api' | 'ollama';

/**
 * `brokered`: Sentinel runs the loop and the evidence broker serves cited slices. `native`: the CLI runs its own loop
 * over a scratch tree holding only the stage's declared inputs, and its full transcript is retained.
 */
export type AgentMode = 'brokered' | 'native';

/** A model stage. It proposes cited claims; it can never make coverage. */
export interface AgentStageDefinition extends StageDefinitionBase {
  kind: 'agent';
  mode: AgentMode;
  runner: AgentRunnerId;
  /** The adopted settings provider entry to bind; absent when the runner has exactly one adopted provider. */
  provider?: Id;
  model: ModelName;
  /** The prompt a brokered stage sends. */
  prompt?: PackRef;
  /** The instructions a native stage's CLI reads. */
  instructions?: PackRef;
  /**
   * Skill packs, in order: the order is part of the instruction bytes.
   * @maxItems 16
   */
  skills?: PackRef[];
}

/**
 * One declared stage.
 * @discriminator kind
 */
export type StageDefinition =
  BuiltinStageDefinition | ToolStageDefinition | ScriptStageDefinition | AgentStageDefinition;

/** The gated features (policy/features.ts). The adopted settings decide each; a pipeline only says which it needs. */
export type FeatureFlagName = 'stage.host-scripts' | 'runner.claude-cli' | 'runner.copilot-cli' | 'review.hosted-api';

/**
 * The features a pipeline needs, by registry name. `true` asks for the feature: a stage that needs a feature the
 * adopted settings leave off is refused at plan, with the feature named. A request never turns anything on.
 */
export interface PipelineFlags {
  'stage.host-scripts'?: boolean;
  'runner.claude-cli'?: boolean;
  'runner.copilot-cli'?: boolean;
  'review.hosted-api'?: boolean;
}

/**
 * sentinel-pipeline/draft-1 — `.farsight/sentinel/pipeline.json`. Adopted by digest like the settings: its place in
 * a checkout does not make it trusted, and a changed byte (its own or a referenced pack's) is a new revision.
 */
export interface PipelineDefinition {
  schema: 'sentinel-pipeline/draft-1';
  id: Id;
  revision: Ordinal;
  /**
   * In declaration order; the dependency order comes from `needs` and `after`.
   * @minItems 1
   * @maxItems 64
   */
  stages: StageDefinition[];
  flags?: PipelineFlags;
}

/** One stage or skill pack a pipeline names, by the digest of its referenced bytes at adoption. */
export interface PipelinePackPin {
  ref: PackRef;
  digest: Digest;
}

/**
 * sentinel-pipeline-adoption/draft-1 — the owner's adoption of one pipeline for one workspace, kept in the owner's
 * trust folder outside every checkout. `digest` covers the pipeline file's bytes and every pinned pack's bytes; a
 * changed byte in either is no longer adopted.
 */
export interface PipelineAdoptionEnvelope {
  schema: 'sentinel-pipeline-adoption/draft-1';
  workspaceIdentity: Digest;
  /**
   * The canonical workspace path, recorded for the owner to read; the identity is what is compared.
   * @maxLength 4096
   */
  workspacePath: string;
  pipelineId: Id;
  revision: Ordinal;
  fileDigest: Digest;
  /** @maxItems 256 */
  packs: PipelinePackPin[];
  digest: Digest;
  /** The spent owner receipt that confirmed it. */
  receipt: Digest;
  adoptedAt: Timestamp;
}

// ---- one stage run: what it read, what it wrote, and the provenance of every attempt ----

/** One declared input as it resolved for one stage run. */
export interface StageInputBinding {
  /** The declaration, exactly as the pipeline wrote it. */
  decl: StageInputDecl;
  /** `waiting`: the producer has not published yet. `missing`: it never will in this run (held, failed or absent). */
  state: 'resolved' | 'waiting' | 'missing';
  /**
   * The exact artifacts the input resolved to, sealed into the attempt binding. Empty unless `resolved`.
   * @maxItems 1024
   */
  artifacts: ArtifactId[];
  /**
   * The published work that produced them; empty for capture-derived and graph context inputs.
   * @maxItems 1024
   */
  producers: WorkRef[];
  /** `applied`: the canonical secret-withholding fold ran over these bytes before the stage could read them. */
  secretFold: 'applied' | 'not-applicable';
}

/** One declared output as one stage run published it. */
export interface StageOutputBinding {
  decl: StageOutputDecl;
  /** @maxItems 1024 */
  artifacts: ArtifactId[];
  /** @maxItems 1024 */
  publishedBy: WorkRef[];
}

/** The resolved inputs and published outputs of one stage run. */
export interface StageIO {
  /** @maxItems 64 */
  inputs: StageInputBinding[];
  /** @maxItems 64 */
  outputs: StageOutputBinding[];
}

/** Where an attempt ran. `host` is a script on the owner's computer; `sandboxed-cli` an agent CLI under its sandbox. */
export type ExecutionSite = 'in-process' | 'child' | 'container' | 'host' | 'sandboxed-cli';

/** A container image as an attempt used it: the reference written and the image id actually run. */
export interface ProvenanceImage {
  reference: ShortText;
  id: Digest;
}

/**
 * Why a model stage's cost is not known: a subscription CLI reports no price, the usage itself was not confirmed, or
 * the provider has no owner-entered rates.
 */
export type CostUnobservedReason = 'subscription' | 'usage-unknown' | 'no-rates';

/**
 * What a model stage cost: always one of two answers, never nothing. `rates`: the provider has owner-entered rates and
 * the usage was confirmed (list price, not a bill). `unobserved`: the cost is not known, with its reason, and is never
 * printed as a zero amount. Only a model stage has a cost; Sentinel's own stages, scanners and scripts have none.
 * @discriminator basis
 */
export type StageCost =
  | { basis: 'rates'; amount: DecimalAmount; currency: CurrencyCode }
  | { basis: 'unobserved'; reason: CostUnobservedReason };

/** What every provenance record carries. */
interface ProvenanceBase {
  stage: StageId;
  unit: WorkRef;
  /** The attempt this record describes; null for work satisfied by reuse. */
  attempt: Id | null;
  where: ExecutionSite;
  startedAt: Timestamp | null;
  endedAt: Timestamp | null;
  durationMs: Count | null;
  /**
   * Every artifact the attempt was allowed to read.
   * @maxItems 1024
   */
  read: ArtifactId[];
  /** @maxItems 1024 */
  wrote: ArtifactId[];
  /** The retained invocation record (executable digest, argv, environment names). Never a credential. */
  invocation: ArtifactId | null;
}

/** A Sentinel-implemented stage. */
export interface BuiltinProvenance extends ProvenanceBase {
  kind: 'builtin';
  operation: BuiltinOperation;
  moduleDigest: Digest;
  sentinelVersion: ShortText;
}

/** A pinned scanner in its container. */
export interface ToolProvenance extends ProvenanceBase {
  kind: 'tool';
  adapterId: Id;
  adapterVersion: ShortText;
  image: ProvenanceImage | null;
  workerDigest: Digest | null;
  /** @maxItems 2048 */
  rules: { familyId: RuleFamilyId; revision: Ordinal; definitionDigest: Digest }[];
  /** @maxItems 256 */
  databases: { databaseId: Id; snapshotDigest: Digest }[];
}

/**
 * An environment variable's name as a script saw it. Values are never recorded.
 * @pattern ^[A-Za-z_][A-Za-z0-9_]{0,127}$
 */
export type EnvironmentName = string;

/** A promoted script on the host or in a pinned script-runner container. */
export interface ScriptProvenance extends ProvenanceBase {
  kind: 'script';
  entryDigest: Digest;
  interpreter: { name: 'node' | 'sh'; version: ShortText; digest: Digest | null };
  /** @maxItems 64 */
  argv: ScriptArgument[];
  /** @maxItems 128 */
  environmentNames: EnvironmentName[];
  /** Present only when it ran in a container. */
  image: ProvenanceImage | null;
}

/** A model stage through a CLI runner or, behind its flag, a hosted API. */
export interface AgentProvenance extends ProvenanceBase {
  kind: 'agent';
  mode: AgentMode;
  runner: AgentRunnerId;
  runnerVersion: ShortText | null;
  executableDigest: Digest | null;
  model: { requested: ModelName; reported: ModelName | null; identitySource: IdentitySource };
  promptDigest: Digest | null;
  /**
   * In selection order.
   * @maxItems 16
   */
  skillDigests: Digest[];
  /**
   * Every retained request wire, in order.
   * @maxItems 1024
   */
  wires: ArtifactId[];
  /** The native mode's full transcript (every tool call and read); null for a brokered stage. */
  transcript: ArtifactId | null;
  turns: Count;
  tokens: { input: Count | null; output: Count | null; certainty: UsageCertainty };
  cost: StageCost;
  /** The stage deadline and how much of it the attempt used. */
  deadline: { grantedMs: Count; usedMs: Count | null };
}

/**
 * What ran for one unit of a stage: which implementation, which version, where, what it read and wrote, how long,
 * and for a model stage how many tokens and what it cost.
 * @discriminator kind
 */
export type Provenance = BuiltinProvenance | ToolProvenance | ScriptProvenance | AgentProvenance;

/** One declared stage within one run: its units, its resolved inputs and outputs, and their provenance. */
export interface StageRun {
  runId: Id;
  stage: StageId;
  kind: PipelineStageKind;
  /** The stage's state, folded from its units' work states. */
  state: WorkState;
  /** @maxItems 10000 */
  units: WorkRef[];
  io: StageIO;
  /**
   * One record per attempt that ran, in order; empty for held work.
   * @maxItems 10000
   */
  provenance: Provenance[];
  /** For a stage a linked child reused: the run whose publication it reused. */
  reusedFrom: Id | null;
}
