// A declared stage's typed inputs, resolved against a run's publications (Sentinel v2 §3.1).
//
// A stage that reads another stage's output (`{stage, output}`) depends on every unit of that stage (planner/
// pipeline.ts), so by the time one of its units starts every producer has published or the unit is held. Resolution
// reads the producers' accepted publications from the ledger and keeps only the outputs of the declared type, by
// schema: the exact artifact ids the consumer's attempt is then bound to. Nothing is read from disk and nothing a
// producer said about itself is trusted beyond what the ledger accepted.
//
// Before any upstream artifact reaches an agent or a host script, the canonical secret-withholding fold runs over
// the run (reports/selected-privacy.ts, the same reader the reports and the review dispatch use): when an accepted
// secret scan of this run or its selected ancestry found a match, every resolved input is withheld and the attempt is
// refused, so a model or a script never sees bytes that may carry a secret.
//
// The pipeline a run was planned from is recorded in its execution profile when it was declared (profile.ts). A run
// planned without one (every run before declared pipelines, and every run planned from the implied default) reads as
// its implied default pipeline: the default pipeline over the rules it pins and the reviews it holds.
import type { ArtifactId, Id, WorkRef } from '../contracts/common.js';
import type { EffectivePolicy } from '../policy/settings.js';
import type { PipelineDefinition, StageInputBinding, StageOutputType } from '../contracts/pipeline.js';
import type { AgentRunnerId } from '../contracts/pipeline.js';
import { PREVIEW_FINDINGS_SCHEMA } from '../adapters/preview-detector.js';
import { PATHS_OUTPUT_SCHEMA } from '../analysis/paths/definitions.js';
import { defaultPipelineOf, stageModel, stagesOfUnits, type StageModel } from '../planner/pipeline.js';
import { PARSER_INDEX_SCHEMA, PARSER_RESULT_SCHEMA } from '../snapshot/parser.js';
import type { SentinelStore } from '../store/index.js';
import { CAPTURE_RECORD_SCHEMA, INVENTORY_RECORD_SCHEMA } from './bootstrap.js';
import { COVERAGE_SCHEMA } from './coverage.js';
import { ExecutionError } from './errors.js';
import type { AdmittedPlan } from './plans.js';

/**
 * The publication schemas each typed output is, so a consumer is bound to exactly that kind of artifact. Built on
 * first use: the schema constants live in modules that import this one back.
 */
let outputSchemas: Readonly<Record<string, readonly string[]>> | undefined;
export function outputSchemasOf(output: StageOutputType | 'walkthrough' | string): readonly string[] {
  outputSchemas ??= Object.freeze({
    source: [CAPTURE_RECORD_SCHEMA],
    parse: [PARSER_RESULT_SCHEMA, PARSER_INDEX_SCHEMA],
    inventory: [INVENTORY_RECORD_SCHEMA],
    // A scanner's report is part of its findings: a clean scan publishes its report and no finding record.
    findings: [
      'sentinel-driver-report/draft-1',
      'sentinel-driver-finding/draft-1',
      PREVIEW_FINDINGS_SCHEMA,
      'sentinel-paths/draft-1',
    ],
    coverage: [COVERAGE_SCHEMA],
    observations: ['sentinel-review-record/draft-1', 'sentinel-native-review/draft-1', 'sentinel-observation/draft-1'],
    'walkthrough-md': [PATHS_OUTPUT_SCHEMA],
    walkthrough: [PATHS_OUTPUT_SCHEMA],
    report: [],
  });
  return Object.hasOwn(outputSchemas, output) ? outputSchemas[output]! : [];
}

/** A worker's raw output is recorded under its media type; a JSON document names its own schema inside. */
const RAW_JSON = 'application/json';
const MAX_DOCUMENT_BYTES = 4_194_304;
async function documentSchemaOf(store: SentinelStore, id: string): Promise<string> {
  try {
    const bytes = await store.readArtifact(id as ArtifactId);
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) return '';
    const value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as { schema?: unknown };
    return typeof value?.schema === 'string' ? value.schema : '';
  } catch {
    return '';
  }
}

/** The provider kinds whose runner the contract names; the others are recorded as the hosted-API runner. */
const RUNNER_OF: Readonly<Record<string, AgentRunnerId>> = Object.freeze({
  'claude-cli': 'claude-cli',
  'copilot-cli': 'copilot-cli',
  ollama: 'ollama',
});

/**
 * The pipeline a plan with no recorded declaration was planned from: the default pipeline over the rules it pins (one
 * stage per adapter) and the reviews it holds. Its stage ids are the default ones, so `rerun --stage secrets` names
 * the same units on a run planned before declared pipelines as on one planned from the default declaration.
 */
export function impliedPipelineOf(admitted: Pick<AdmittedPlan, 'plan' | 'policy'>): PipelineDefinition {
  const { plan } = admitted;
  const providers = admitted.policy?.settings.providers ?? [];
  const reviews = new Map<'guided' | 'general', { kind: 'guided' | 'general'; runner: AgentRunnerId; model: string }>();
  for (const u of plan.units) {
    if (!u.review) continue;
    const kind = u.stage === 'review-guided' ? 'guided' : 'general';
    if (reviews.has(kind)) continue;
    const kindOf = providers.find((p) => p.id === u.review!.selection.providerId)?.kind ?? '';
    reviews.set(kind, { kind, runner: RUNNER_OF[kindOf] ?? 'hosted-api', model: u.review.selection.modelId });
  }
  return defaultPipelineOf({
    checks: plan.pins.rules.map((r) => ({ adapterId: r.adapterId, rules: [r.familyId] })),
    reviews: [...reviews.values()],
  });
}

/**
 * The default pipeline for planning terms: one check stage per adapter the policy's locked rules run under, and an
 * agent stage for each review stage the adopted settings configure (its runner from the configured provider's kind).
 * Planning it reproduces the derived plan; a run planned from it records no declaration.
 */
export function defaultPipelineFor(
  rules: readonly { readonly familyId: string; readonly adapterId: Id }[],
  policy: Pick<EffectivePolicy, 'rules' | 'settings'>,
): PipelineDefinition {
  const selected = new Set(policy.rules);
  const configured = policy.settings.reviewModels;
  const bindings = [...(configured?.stages ?? []), ...(configured?.segments ?? [])];
  const reviews = (['guided', 'general'] as const).flatMap((kind) => {
    const binding = bindings.find((b) => b.stage === kind);
    if (!binding) return [];
    const kindOf = policy.settings.providers.find((p) => p.id === binding.providerId)?.kind ?? '';
    return [
      {
        kind,
        runner: RUNNER_OF[kindOf] ?? ('hosted-api' as const),
        model: binding.modelId,
        provider: binding.providerId,
      },
    ];
  });
  return defaultPipelineOf({
    checks: rules.filter((r) => selected.has(r.familyId)).map((r) => ({ adapterId: r.adapterId, rules: [r.familyId] })),
    reviews,
  });
}

/** The declaration a run's admitted revision was planned from: recorded, or implied. */
export function pipelineOf(admitted: Pick<AdmittedPlan, 'plan' | 'policy' | 'profile'>): PipelineDefinition {
  return admitted.profile.pipeline ?? impliedPipelineOf(admitted);
}

/** The stage model of a run's admitted revision, with every unit claimed by one of its stages. */
export function runStages(admitted: Pick<AdmittedPlan, 'plan' | 'policy' | 'profile'>): {
  model: StageModel;
  owner: Map<Id, string>;
} {
  const model = stageModel(pipelineOf(admitted));
  return { model, owner: stagesOfUnits(model, admitted.plan) };
}

/** Why one upstream artifact may not reach a consumer. */
export type UpstreamWithheld = 'secret-scanner-output' | 'unreadable' | 'withheld-evidence' | 'secret-match-name';

/**
 * The read boundary every upstream artifact passes before an agent or a script may read it, fail-closed: the bytes
 * of a secret scanner's own output never pass; anything that is not a bounded UTF-8 JSON document cannot be
 * inspected, so it does not pass; a document carrying withheld evidence (a withheld location or detail, which marks
 * bytes near a secret) does not pass; nor does one naming a file an accepted secret match withheld (`names`, the
 * canonical fold's privacy names for this run and its selected ancestry). Returns null when the artifact passes.
 */
export function foldUpstreamBytes(
  bytes: Uint8Array,
  producer: { readonly adapterId: Id | null },
  names: ReadonlySet<string>,
): UpstreamWithheld | null {
  if (producer.adapterId === 'secrets-gitleaks') return 'secret-scanner-output';
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) return 'unreadable';
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  } catch {
    return 'unreadable';
  }
  let withheld: UpstreamWithheld | null = null;
  const walk = (v: unknown, depth: number): void => {
    if (withheld) return;
    if (depth > 64) {
      withheld = 'unreadable';
      return;
    }
    if (typeof v === 'string') {
      if (names.has(v)) withheld = 'secret-match-name';
      return;
    }
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    if (o.location === 'withheld' || o.state === 'withheld' || o.withheld === true) {
      withheld = 'withheld-evidence';
      return;
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(value, 0);
  return withheld;
}

/**
 * The typed inputs of one declared stage, resolved against what this run accepted. Each input names the producers
 * (the producing stage's units of this revision, or the reused bootstrap work for a bootstrap stage). `resolved`:
 * every producer published at least one artifact of the declared type, and those are the artifacts, each through
 * the read boundary (foldUpstreamBytes) and the run's canonical secret fold. `waiting`: a producer has not published
 * yet. `missing`: a producer ended without publishing, published nothing of that type, or the stage has no unit.
 * Any upstream artifact the fold withholds refuses the consumer (stageInputWithheld): no partial input is bound.
 */
export async function resolveStageInputs(
  store: SentinelStore,
  admitted: AdmittedPlan,
  model: StageModel,
  stage: string,
): Promise<StageInputBinding[]> {
  store.assertHeld();
  const typed = model.inputs.get(stage);
  if (!typed) throw new ExecutionError('sentinel.execution.planInvalid', { reason: `stage ${stage} is not declared` });
  const owner = stagesOfUnits(model, admitted.plan);
  const out: Array<StageInputBinding & { from: Map<ArtifactId, Id | null> }> = [];
  for (const input of typed) {
    const role = model.roles.get(input.stage)!;
    const named = model.stages
      .get(input.stage)!
      .produces?.find((p) => typeof p !== 'string' && p.name === input.output) as { schema: string } | undefined;
    const schemas = new Set(named ? [named.schema] : outputSchemasOf(input.output));
    const producers: WorkRef[] =
      role.role === 'bootstrap'
        ? admitted.plan.reused.filter(
            (r) => store.ledger.getWork(r)?.envelope.stage.contract === `sentinel.stage.${role.operation}`,
          )
        : admitted.plan.units
            .filter((u) => owner.get(u.id) === input.stage)
            .map((u) => ({ id: u.id, revision: u.revision }));
    const from = new Map<ArtifactId, Id | null>();
    let state: StageInputBinding['state'] = producers.length ? 'resolved' : 'missing';
    for (const p of producers) {
      const publication = store.ledger.getPublication(p);
      if (publication) {
        let found = 0;
        for (const o of publication.outputs)
          if (schemas.has(o.schema) || (o.schema === RAW_JSON && schemas.has(await documentSchemaOf(store, o.id)))) {
            from.set(o.id as ArtifactId, admitted.plan.units.find((u) => u.id === p.id)?.adapterId ?? null);
            found++;
          }
        // Published without the declared output: it will never publish it in this run.
        if (found === 0) state = 'missing';
        continue;
      }
      const row = store.ledger.getWork(p);
      const ended = row && ['failed', 'blocked', 'disabled-by-policy', 'published'].includes(row.state);
      if (ended) state = 'missing';
      else if (state === 'resolved') state = 'waiting';
    }
    out.push({
      decl: { stage: input.stage, output: input.output },
      state,
      artifacts: state === 'resolved' ? [...from.keys()].sort() : [],
      producers: [...producers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.revision - b.revision)),
      secretFold: 'not-applicable',
      from,
    });
  }
  const strip = ({ from: _from, ...binding }: (typeof out)[number]): StageInputBinding => binding;
  if (!out.some((i) => i.artifacts.length)) return out.map(strip);
  // The canonical fold over the run (and its selected ancestry and baseline), then each artifact's own read boundary.
  const { selectedSecretPrivacy } = await import('../reports/selected-privacy.js');
  const privacy = await selectedSecretPrivacy(store, admitted.plan.runId, admitted, true);
  store.assertHeld();
  const names = new Set(privacy.names);
  const withheld: string[] = [];
  for (const input of out) {
    const d = input.decl as { stage: string; output: string };
    for (const id of input.artifacts) {
      const reason = privacy.hasMatches
        ? 'secret-match'
        : foldUpstreamBytes(await store.readArtifact(id), { adapterId: input.from.get(id) ?? null }, names);
      if (reason) withheld.push(`${d.stage}.${d.output} ${reason}`);
    }
  }
  store.assertHeld();
  if (withheld.length)
    throw new ExecutionError('sentinel.execution.stageInputWithheld', { stage, inputs: [...new Set(withheld)] });
  return out.map((i) => strip(i.artifacts.length ? { ...i, secretFold: 'applied' as const } : i));
}

/**
 * The resolved inputs one unit's attempt is bound to, for a unit whose stage reads other stages' outputs; undefined for
 * every other unit (its attempt is bound exactly as before). Every input must be resolved: a waiting or missing input
 * refuses the attempt before it starts, with the input named.
 */
export async function stageInputsForUnit(
  store: SentinelStore,
  admitted: AdmittedPlan,
  unit: WorkRef,
): Promise<StageInputBinding[] | undefined> {
  if (!admitted.profile.pipeline) return undefined;
  const { model, owner } = runStages(admitted);
  const stage = owner.get(unit.id);
  if (!stage || !model.inputs.get(stage)?.length) return undefined;
  const inputs = await resolveStageInputs(store, admitted, model, stage);
  const unresolved = inputs.filter((i) => i.state !== 'resolved');
  if (unresolved.length)
    throw new ExecutionError('sentinel.execution.stageInputMissing', {
      stage,
      inputs: unresolved.map((i) => {
        const d = i.decl as { stage: string; output: string };
        return `${d.stage}.${d.output} ${i.state}`;
      }),
    });
  return inputs;
}
