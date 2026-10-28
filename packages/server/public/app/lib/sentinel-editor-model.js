// lib/sentinel-editor-model.js — the pure half of the PIPELINE stop's edit mode (Sentinel v2 §4, lane L-UX U-3).
//
// No imports and no DOM. The editor drawer edits a declared pipeline (`.farsight/sentinel/pipeline.json`, the
// `sentinel-pipeline/draft-1` contract of packages/sentinel/src/contracts/pipeline.ts) as plain data and hands the
// whole object to the owner service's `pipeline.write`, which validates it, previews what running it would do and
// writes it only on the owner's confirmation; it never adopts or runs. The browser checks nothing the service checks:
// every problem comes back from the service, keyed by stage. What this module guarantees is that an edit made here
// writes the same bytes the CLI would: key order is kept, a field is replaced where it stood, and the text is
// two-space JSON with a final newline (`pipelineBytesOf`).

/** The four kinds a stage may be, in the order the drawer offers them. */
export const STAGE_KINDS = Object.freeze(['builtin', 'tool', 'script', 'agent']);

/**
 * The fields the drawer shows for each kind, in order: `key` names the field in the stage; `list` takes several;
 * `words` names the catalog group a choice's words come from (`choiceKey`); `technical` is a value only the code
 * registers print (an id, a pack reference, a model name), never the business register.
 */
export const STAGE_FIELDS = Object.freeze({
  builtin: [
    {
      key: 'operation',
      words: 'operation',
      choices: ['capture', 'parse', 'inventory', 'walkthrough', 'framework-controls', 'report'],
    },
  ],
  tool: [
    { key: 'adapter', technical: true },
    { key: 'rules', list: true, technical: true },
  ],
  script: [
    { key: 'runner', words: 'scriptRunner', choices: ['container', 'host'] },
    { key: 'interpreter', words: 'interpreter', choices: ['node', 'sh'] },
    { key: 'entry', technical: true },
    { key: 'args', list: true, optional: true, technical: true },
  ],
  agent: [
    { key: 'mode', words: 'mode', choices: ['brokered', 'native'] },
    { key: 'runner', words: 'agentRunner', choices: ['copilot-cli', 'claude-cli', 'hosted-api', 'ollama'] },
    { key: 'provider', optional: true, technical: true },
    { key: 'model', technical: true },
    { key: 'prompt', optional: true, technical: true },
    { key: 'instructions', optional: true, technical: true },
    { key: 'skills', list: true, optional: true, technical: true },
  ],
});

/** Every kind's shared fields, after its own: inputs, outputs, ordering, fan-out, whether it is required, its budget. */
export const SHARED_FIELDS = Object.freeze([
  { key: 'needs', list: true, optional: true, technical: true },
  { key: 'produces', list: true, optional: true, technical: true },
  { key: 'after', list: true, optional: true, technical: true },
  { key: 'fanOut', words: 'fanOut', choices: ['per-run', 'per-source', 'per-entry', 'per-check'], optional: true },
  { key: 'required', optional: true },
  { key: 'budget', optional: true },
]);

const STAGE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** The catalog key a choice prints with: `sentinel.viewer.edit.choice.<group>.<value>`, the value in camel case. */
export function choiceKey(group, value) {
  return (
    'sentinel.viewer.edit.choice.' + group + '.' + String(value).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
  );
}

/** A scanner's words, by the adapter a tool stage names: the read model's names for the same checks. */
const ADAPTER_NAMES = Object.freeze({
  'sentinel.preview.detector': 'sentinel.viewer.stage.preview',
  'secrets-gitleaks': 'sentinel.viewer.stage.secrets',
  'advisories-osv': 'sentinel.viewer.stage.dependencies',
  'pattern-semgrep': 'sentinel.viewer.stage.patterns',
  'iac-trivy': 'sentinel.viewer.stage.infrastructure',
  'ci-zizmor': 'sentinel.viewer.stage.workflows',
});
const OPERATION_NAMES = Object.freeze({
  capture: 'sentinel.viewer.stage.capture',
  parse: 'sentinel.viewer.stage.parse',
  inventory: 'sentinel.viewer.stage.inventory',
  walkthrough: 'sentinel.viewer.stage.paths',
  'framework-controls': 'sentinel.viewer.stage.controls',
  report: 'sentinel.viewer.stage.report',
});

/**
 * The words a reader sees for a declared stage: the catalog's for Sentinel's own operations and the scanners it
 * knows, else the name the owner declared — its id, hyphens read as spaces. `{ key }` or `{ declared }`.
 */
export function stageName(stage) {
  const key =
    stage?.kind === 'builtin'
      ? OPERATION_NAMES[stage.operation]
      : stage?.kind === 'tool'
        ? ADAPTER_NAMES[stage.adapter]
        : undefined;
  return key ? { key } : { declared: String(stage?.id ?? '').replace(/-/g, ' ') };
}

/** The text `pipeline.write` turns an object into, and the CLI's `init` writes: two-space JSON, a final newline. */
export function pipelineText(pipeline) {
  return JSON.stringify(pipeline, null, 2) + '\n';
}

const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * The pipeline with one field of one stage set: the field keeps its place when it already stood in the stage, a new
 * field goes after the last one, and an emptied optional field is dropped. Nothing else changes, so the bytes differ
 * from the file only where the edit did. Returns the same object when the stage does not exist.
 */
export function editStage(pipeline, stageId, key, value) {
  const at = (pipeline.stages || []).findIndex((s) => s.id === stageId);
  if (at < 0) return pipeline;
  const stage = pipeline.stages[at];
  const next = {};
  let placed = false;
  for (const [k, v] of Object.entries(stage)) {
    if (k !== key) next[k] = v;
    else {
      placed = true;
      if (!isEmpty(value)) next[k] = value;
    }
  }
  if (!placed && !isEmpty(value)) next[key] = value;
  const stages = pipeline.stages.slice();
  stages[at] = next;
  return { ...pipeline, stages };
}

/**
 * A stage's kind changed: its own fields go (they belong to the other kind) and the shared ones stay, so its
 * wiring survives the change; the new kind's fields start empty, for the service to say what is missing.
 */
export function changeKind(pipeline, stageId, kind) {
  if (!STAGE_KINDS.includes(kind)) return pipeline;
  const at = (pipeline.stages || []).findIndex((s) => s.id === stageId);
  if (at < 0) return pipeline;
  const shared = new Set(SHARED_FIELDS.map((f) => f.key));
  const stage = pipeline.stages[at];
  const next = { id: stage.id, kind };
  for (const [k, v] of Object.entries(stage)) if (shared.has(k)) next[k] = v;
  const stages = pipeline.stages.slice();
  stages[at] = next;
  return { ...pipeline, stages };
}

/** A free stage id near `base`: `review`, then `review-2`, `review-3`… */
export function freeStageId(pipeline, base = 'stage') {
  const ids = new Set((pipeline.stages || []).map((s) => s.id));
  const root = STAGE_ID.test(base) ? base : 'stage';
  if (!ids.has(root)) return root;
  for (let n = 2; ; n++) if (!ids.has(root + '-' + n)) return root + '-' + n;
}

/**
 * `+ add a stage here`: a new stage of `kind` right after `afterId`, reading that stage's outputs; its own fields
 * empty for the owner to fill. Returns the pipeline and the new stage's id.
 */
export function addStageAfter(pipeline, afterId, kind = 'agent') {
  const stages = (pipeline.stages || []).slice();
  const at = stages.findIndex((s) => s.id === afterId);
  const id = freeStageId(pipeline, kind === 'agent' ? 'review' : kind);
  const stage = { id, kind: STAGE_KINDS.includes(kind) ? kind : 'agent', ...(at >= 0 ? { needs: [afterId] } : {}) };
  stages.splice(at >= 0 ? at + 1 : stages.length, 0, stage);
  return { pipeline: { ...pipeline, stages }, id };
}

/** A stage removed, and every other stage's `needs` and `after` no longer naming it. */
export function removeStage(pipeline, stageId) {
  const stages = (pipeline.stages || [])
    .filter((s) => s.id !== stageId)
    .map((s) => {
      let out = s;
      for (const key of ['needs', 'after']) {
        if (!Array.isArray(out[key])) continue;
        const kept = out[key].filter((d) => (typeof d === 'string' ? d !== stageId : d && d.stage !== stageId));
        if (kept.length !== out[key].length) out = editStage({ stages: [out] }, out.id, key, kept).stages[0];
      }
      return out;
    });
  return { ...pipeline, stages };
}

/** The service's problems (`pipeline.write` facts) by the stage each names; the pipeline's own under `''`. */
export function problemsByStage(problems) {
  const out = new Map();
  for (const p of problems || []) {
    const id = typeof p.stage === 'string' ? p.stage : '';
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(p);
  }
  return out;
}

/** The stage ids whose definition differs between two pipelines, added and removed ones included. */
export function changedStages(before, after) {
  const a = new Map((before?.stages || []).map((s) => [s.id, JSON.stringify(s)]));
  const b = new Map((after?.stages || []).map((s) => [s.id, JSON.stringify(s)]));
  const ids = new Set([...a.keys(), ...b.keys()]);
  return [...ids].filter((id) => a.get(id) !== b.get(id));
}
