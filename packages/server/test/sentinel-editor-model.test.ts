// The PIPELINE stop's edit mode, its pure half (Sentinel v2 lane L-UX U-3): an edit made in the drawer writes the same
// bytes the CLI would — key order kept, a field replaced where it stood, two-space JSON with a final newline — and a
// stage added, removed or re-kinded keeps the rest of the pipeline as it was. The service validates; this never does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const m = await import(join(here, '..', 'public', 'app', 'lib', 'sentinel-editor-model.js'));

/** A pipeline in the shape `init` writes (README §3.3), with a review stage to edit. */
const PIPELINE = {
  schema: 'sentinel-pipeline/draft-1',
  id: 'default',
  revision: 1,
  stages: [
    { id: 'capture', kind: 'builtin', operation: 'capture' },
    { id: 'parse', kind: 'builtin', operation: 'parse', needs: ['capture'], fanOut: 'per-source' },
    {
      id: 'review',
      kind: 'agent',
      mode: 'brokered',
      runner: 'copilot-cli',
      model: 'gpt-6-luna',
      prompt: 'stages/review@3#prompt.md',
      needs: ['parse'],
      budget: { turns: 3 },
    },
  ],
};

test('changing the review stage runner changes that one value and nothing else in the bytes', () => {
  const before = m.pipelineText(PIPELINE);
  assert.equal(before, JSON.stringify(PIPELINE, null, 2) + '\n', 'the form the CLI writes');
  const after = m.pipelineText(m.editStage(PIPELINE, 'review', 'runner', 'claude-cli'));
  assert.equal(after, before.replace('"runner": "copilot-cli"', '"runner": "claude-cli"'));
  assert.equal(m.editStage(PIPELINE, 'absent', 'runner', 'x'), PIPELINE, 'no such stage: the same pipeline');
  assert.equal(PIPELINE.stages[2].runner, 'copilot-cli', 'never in place');
});

test('a new field goes last, an emptied optional field is dropped', () => {
  const skills = m.editStage(PIPELINE, 'review', 'skills', ['skills/owasp-top10@2']);
  assert.deepEqual(Object.keys(skills.stages[2]).slice(-1), ['skills']);
  const none = m.editStage(skills, 'review', 'skills', []);
  assert.equal(m.pipelineText(none), m.pipelineText(PIPELINE));
});

test('re-kinding keeps the wiring and drops the other kind’s fields', () => {
  const tool = m.changeKind(PIPELINE, 'review', 'tool');
  assert.deepEqual(tool.stages[2], { id: 'review', kind: 'tool', needs: ['parse'], budget: { turns: 3 } });
  assert.equal(m.changeKind(PIPELINE, 'review', 'nope'), PIPELINE);
});

test('+ add a stage here reads the stage above it; removing a stage unhooks it everywhere', () => {
  const { pipeline, id } = m.addStageAfter(PIPELINE, 'parse', 'agent');
  assert.equal(id, 'review-2', 'a free id beside the existing review');
  assert.deepEqual(
    pipeline.stages.map((s: any) => s.id),
    ['capture', 'parse', 'review-2', 'review'],
  );
  assert.deepEqual(pipeline.stages[2], { id: 'review-2', kind: 'agent', needs: ['parse'] });
  const removed = m.removeStage(pipeline, 'parse');
  assert.deepEqual(
    removed.stages.map((s: any) => [s.id, s.needs ?? null]),
    [
      ['capture', null],
      ['review-2', null],
      ['review', null],
    ],
  );
  assert.equal(m.freeStageId(PIPELINE, 'Bad Id'), 'stage');
});

test('the service’s problems land on their stages; changed stages are named', () => {
  const by = m.problemsByStage([
    { class: 'refused', code: 'sentinel.pipeline.cycle', stage: 'review', detail: 'x' },
    { class: 'unavailable', code: 'sentinel.pipeline.flagDisabled', stage: null, detail: 'y' },
  ]);
  assert.equal(by.get('review').length, 1);
  assert.equal(by.get('').length, 1);
  assert.deepEqual(m.changedStages(PIPELINE, m.editStage(PIPELINE, 'review', 'model', 'gpt-6')), ['review']);
  assert.deepEqual(m.changedStages(PIPELINE, m.addStageAfter(PIPELINE, 'parse', 'tool').pipeline), ['tool']);
});

test('every kind has fields, and the drawer offers the contract’s four kinds', () => {
  assert.deepEqual(m.STAGE_KINDS, ['builtin', 'tool', 'script', 'agent']);
  for (const kind of m.STAGE_KINDS) assert.ok(m.STAGE_FIELDS[kind].length > 0, kind);
  assert.ok(m.SHARED_FIELDS.some((f: any) => f.key === 'needs'));
  // the choices are the contract's closed sets (packages/sentinel/src/contracts/pipeline.ts)
  const choices = (kind: string, key: string) => m.STAGE_FIELDS[kind].find((f: any) => f.key === key).choices;
  assert.deepEqual(choices('agent', 'runner'), ['copilot-cli', 'claude-cli', 'hosted-api', 'ollama']);
  assert.deepEqual(choices('agent', 'mode'), ['brokered', 'native']);
  assert.deepEqual(choices('script', 'runner'), ['container', 'host']);
  assert.deepEqual(choices('builtin', 'operation'), [
    'capture',
    'parse',
    'inventory',
    'walkthrough',
    'framework-controls',
    'report',
  ]);
});

test('every choice and every stage name the drawer prints is a catalog word, with both registers and a define', async () => {
  const { STRINGS } = await import('@farsight/core/dist/strings.js');
  assert.equal(m.choiceKey('agentRunner', 'copilot-cli'), 'sentinel.viewer.edit.choice.agentRunner.copilotCli');
  assert.equal(m.choiceKey('fanOut', 'per-source'), 'sentinel.viewer.edit.choice.fanOut.perSource');
  const keys: string[] = [];
  for (const f of [...Object.values(m.STAGE_FIELDS).flat(), ...m.SHARED_FIELDS] as any[]) {
    if (f.choices) {
      assert.ok(f.words, `${f.key} names its word group`);
      for (const c of f.choices) keys.push(m.choiceKey(f.words, c));
    }
  }
  for (const operation of ['capture', 'parse', 'inventory', 'walkthrough', 'framework-controls', 'report'])
    keys.push(m.stageName({ id: 'x', kind: 'builtin', operation }).key);
  for (const key of keys) {
    const e = (STRINGS as any)[key];
    assert.ok(e, key);
    assert.ok(e.hud && e.professional && e.define, key);
  }
  // a scanner the read model names reads the same here; an unknown one, a script and a model stage read as declared
  assert.deepEqual(m.stageName({ id: 'secrets', kind: 'tool', adapter: 'secrets-gitleaks' }), {
    key: 'sentinel.viewer.stage.secrets',
  });
  assert.deepEqual(m.stageName({ id: 'my-scanner', kind: 'tool', adapter: 'unknown' }), { declared: 'my scanner' });
  assert.deepEqual(m.stageName({ id: 'triage-findings', kind: 'agent' }), { declared: 'triage findings' });
  // the values only the code registers print
  const technical = [...Object.values(m.STAGE_FIELDS).flat(), ...m.SHARED_FIELDS]
    .filter((f: any) => f.technical)
    .map((f: any) => f.key);
  for (const key of ['adapter', 'rules', 'entry', 'model', 'prompt', 'instructions', 'skills', 'needs', 'produces'])
    assert.ok(technical.includes(key), key);
});
