// Declared pipelines in the planner: the declaration is validated before anything is planned, stage ordering becomes
// unit dependencies, a stage reading another stage's output depends on its units, and a stage id expands to its
// units with the downstream stages previewed. Synthetic inputs through the real adapters; nothing runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PlanError,
  declaredAnalysis,
  defaultPipelineOf,
  planBootstrap,
  planPipelineAnalysis,
  planPipelineBootstrap,
  selectStages,
  stageModel,
  stagesOfUnits,
} from '../dist/planner/index.js';
import { analysisView, included, lockedRules, policyView, snapshotView, trustedProfile } from './planner-helpers.ts';

const code = (c: string) => (e: unknown) => e instanceof PlanError && e.code === c;
const profile = trustedProfile();
const BOOT = [
  { id: 'capture', kind: 'builtin', operation: 'capture' },
  { id: 'parse', kind: 'builtin', operation: 'parse', needs: ['capture'] },
  { id: 'inventory', kind: 'builtin', operation: 'inventory', needs: ['parse'] },
];
const pipeline = (stages: unknown[]): any => ({
  schema: 'sentinel-pipeline/draft-1',
  id: 'p',
  revision: 1,
  stages: [...BOOT, ...stages],
});
const EVAL = 'sentinel.ts.eval';
const CALL = 'sentinel.ts.call';
const tool = (id: string, rules: string[], over: Record<string, unknown> = {}) => ({
  id,
  kind: 'tool',
  adapter: 'sentinel-pattern',
  rules,
  needs: ['inventory'],
  ...over,
});

const boot = planBootstrap({ runId: 'run-1', sourceIds: ['web'], profile });
const inventory = [{ id: boot.units.at(-1)!.id, revision: 1 }];
const lock = lockedRules([{ familyId: EVAL }, { familyId: CALL }]).view;
function plan(p: any, over: Record<string, unknown> = {}) {
  return planPipelineAnalysis({
    runId: 'run-1',
    revision: 2,
    previous: boot,
    bootstrap: inventory,
    profile,
    snapshot: snapshotView(['web'], [included('web', 'src/a.ts'), included('web', 'src/b.ts')]).view,
    analyses: [
      analysisView('web', [
        { path: 'src/a.ts', class: 'parsed' },
        { path: 'src/b.ts', class: 'parsed' },
      ]),
    ],
    lock,
    policy: policyView([EVAL, CALL]).view,
    pipeline: p,
    ...over,
  });
}

test('a declaration that cannot be planned is refused with its reason before anything is planned', () => {
  const refused: Array<[unknown, string]> = [
    [{ ...pipeline([]), schema: 'sentinel-pipeline/1' }, 'sentinel.plan.pipelineInvalid'],
    [pipeline([{ id: 'Secrets', kind: 'tool', adapter: 'x', rules: [EVAL] }]), 'sentinel.plan.pipelineInvalid'],
    [pipeline([tool('a', [EVAL]), tool('a', [CALL])]), 'sentinel.plan.pipelineInvalid'],
    [pipeline([{ id: 'a', kind: 'tool', adapter: 'sentinel-pattern' }]), 'sentinel.plan.pipelineInvalid'],
    [pipeline([{ id: 'b', kind: 'builtin', operation: 'compile' }]), 'sentinel.plan.pipelineInvalid'],
    [pipeline([tool('a', [EVAL], { needs: ['nowhere'] })]), 'sentinel.plan.stageUnknown'],
    [pipeline([tool('a', [EVAL], { after: ['nowhere'] })]), 'sentinel.plan.stageUnknown'],
    [
      pipeline([
        tool('a', [EVAL]),
        {
          id: 'r',
          kind: 'agent',
          mode: 'brokered',
          runner: 'copilot-cli',
          model: 'm',
          needs: [{ stage: 'a', output: 'triage' }],
        },
      ]),
      'sentinel.plan.stageUnknown',
    ],
    [pipeline([tool('a', [EVAL], { after: ['b'] }), tool('b', [CALL], { after: ['a'] })]), 'sentinel.plan.stageCycle'],
    [pipeline([tool('a', [EVAL], { after: ['a'] })]), 'sentinel.plan.stageCycle'],
  ];
  for (const [p, c] of refused) assert.throws(() => stageModel(p as any), code(c), `${c}: ${JSON.stringify(p)}`);
  // A pipeline without its bootstrap stages has nothing to plan from.
  const noBoot = { ...pipeline([]), stages: [tool('a', [EVAL], { needs: [] })] };
  assert.throws(
    () => planPipelineBootstrap({ runId: 'run-1', sourceIds: ['web'], profile, pipeline: noBoot }),
    code('sentinel.plan.pipelineInvalid'),
  );
});

test('stage shapes this build does not plan yet are refused, never left as work nobody runs', () => {
  const agent = (over: Record<string, unknown>) => ({
    id: 'review',
    kind: 'agent',
    mode: 'brokered',
    runner: 'copilot-cli',
    model: 'm',
    ...over,
  });
  for (const p of [
    pipeline([tool('a', [EVAL]), agent({ fanOut: 'per-entry' })]),
    pipeline([{ id: 'notes', kind: 'script', runner: 'host', interpreter: 'node', entry: 'stages/notes@1#run.mjs' }]),
    pipeline([tool('a', [EVAL]), tool('b', [CALL], { needs: [{ stage: 'a', output: 'findings' }] })]),
    pipeline([tool('a', 'pack:builtin:pattern' as never)]),
    pipeline([tool('a', [EVAL]), agent({ id: 'one' }), agent({ id: 'two', fanOut: 'per-check', after: ['one'] })]),
  ])
    assert.throws(() => plan(p), code('sentinel.plan.stageUnavailable'), JSON.stringify(p.stages.slice(3)));
  // Two stages claiming one rule leave which one runs it undecided.
  assert.throws(
    () => plan(pipeline([tool('a', [EVAL]), tool('b', [EVAL, CALL])])),
    code('sentinel.plan.stageAmbiguous'),
  );
});

test('the contract example declares a valid pipeline; this build plans none of its per-entry or script stages', () => {
  const example = JSON.parse(readFileSync(new URL('./fixtures/pipeline/example.json', import.meta.url), 'utf8'));
  const model = stageModel(example);
  const at = (id: string) => model.order.indexOf(id);
  for (const s of example.stages)
    for (const n of model.upstream.get(s.id)!) assert.ok(at(n) < at(s.id), `${n} before ${s.id}`);
  assert.deepEqual(model.context.get('triage'), ['farsight.journeys']);
  assert.deepEqual(model.inputs.get('review'), [
    { stage: 'walk', output: 'walkthrough' },
    { stage: 'patterns', output: 'findings' },
  ]);
  assert.throws(() => declaredAnalysis(model), code('sentinel.plan.stageUnavailable'));
});

test('ordering between check stages becomes unit dependencies; the default ordering adds none', () => {
  const flat = plan(pipeline([tool('evals', [EVAL]), tool('calls', [CALL])]));
  const derived = plan(defaultPipelineOf({ checks: [{ adapterId: 'sentinel-pattern', rules: [EVAL, CALL] }] }));
  for (const u of [...flat.units, ...derived.units]) assert.deepEqual(u.dependencies, inventory);
  // Two stages over one adapter never share a unit: each covers only its own stage's checks.
  const model = stageModel(pipeline([tool('evals', [EVAL]), tool('calls', [CALL])]));
  const owner = stagesOfUnits(model, flat);
  assert.deepEqual([...new Set(owner.values())].sort(), ['calls', 'evals']);
  const ordered = plan(pipeline([tool('evals', [EVAL]), tool('calls', [CALL], { after: ['evals'] })]));
  const own = stagesOfUnits(
    stageModel(pipeline([tool('evals', [EVAL]), tool('calls', [CALL], { after: ['evals'] })])),
    ordered,
  );
  const evals = ordered.units.filter((u) => own.get(u.id) === 'evals').map((u) => ({ id: u.id, revision: 1 }));
  assert.ok(evals.length > 0);
  for (const u of ordered.units.filter((x) => own.get(x.id) === 'calls'))
    assert.deepEqual(
      u.dependencies,
      [...inventory, ...evals].sort((a, b) => (a.id < b.id ? -1 : 1)),
      'a calls unit waits for every evals unit and the published inventory',
    );
  // Ordering through a unit-less stage (the report) carries over to what follows it.
  const via = pipeline([
    tool('evals', [EVAL]),
    { id: 'report', kind: 'builtin', operation: 'report', after: ['evals'] },
    tool('calls', [CALL], { after: ['report'] }),
  ]);
  const viaPlan = plan(via);
  const viaOwner = stagesOfUnits(stageModel(via), viaPlan);
  for (const u of viaPlan.units.filter((x) => viaOwner.get(x.id) === 'calls')) assert.ok(u.dependencies.length > 1);
});

test('a rule no stage selects stays an unsupported check with its reason; the rest of the plan is unchanged', () => {
  const both = plan(pipeline([tool('evals', [EVAL]), tool('calls', [CALL])]));
  const one = plan(pipeline([tool('evals', [EVAL])]));
  for (const c of one.checks.filter((x) => x.familyId === CALL))
    assert.deepEqual([c.state, c.reasonCode, c.required], ['unsupported', 'sentinel.plan.stageNotDeclared', true]);
  assert.equal(one.requiredCoverageAchievable, false);
  assert.deepEqual(
    one.units.map((u) => u.id),
    both.units
      .filter((u) => u.checks.every((c) => one.checks.find((x) => x.id === c)?.state === 'planned'))
      .map((u) => u.id),
  );
});

test('a stage id expands to its units, and a rerun of it previews the stages downstream', () => {
  const p = pipeline([
    tool('evals', [EVAL]),
    tool('calls', [CALL], { after: ['evals'] }),
    { id: 'report', kind: 'builtin', operation: 'report', needs: ['inventory'], after: ['evals', 'calls'] },
  ]);
  const revision = plan(p);
  const model = stageModel(p);
  const owner = stagesOfUnits(model, revision);
  const unitsOf = (s: string) =>
    revision.units
      .filter((u) => owner.get(u.id) === s)
      .map((u) => u.id)
      .sort();
  const pick = selectStages(model, revision, ['evals']);
  assert.deepEqual(pick.units, unitsOf('evals'));
  assert.deepEqual(
    pick.downstream.map((d) => [d.stage, d.units]),
    [
      ['calls', unitsOf('calls')],
      ['report', []],
    ],
  );
  assert.throws(() => selectStages(model, revision, ['nowhere']), code('sentinel.plan.stageUnknown'));
  // A plan another declaration made is not this pipeline's: a unit no stage claims is refused.
  assert.throws(
    () => stagesOfUnits(stageModel(pipeline([tool('calls', [CALL])])), revision),
    code('sentinel.plan.stageUnknown'),
  );
});

test('a plan names what it runs: checks, model review, both, the bootstrap, or nothing', async () => {
  const { planShapeOf, PLAN_SHAPE_KEYS } = await import('../dist/planner/index.js');
  const { SENTINEL_PLAN_STRINGS } = await import('@farsight/core/dist/strings-sentinel-plan.js');
  const checks = plan(pipeline([tool('evals', [EVAL]), tool('calls', [CALL])]));
  const review = { ...checks.units[0]!, review: {} };
  assert.equal(planShapeOf(boot), 'bootstrap');
  assert.equal(planShapeOf(checks), 'checks');
  assert.equal(planShapeOf({ ...checks, units: [...checks.units, review] }), 'checks-and-review');
  assert.equal(planShapeOf({ ...checks, units: [review] }), 'review-only');
  assert.equal(planShapeOf({ ...checks, units: [] }), 'nothing');
  for (const key of Object.values(PLAN_SHAPE_KEYS)) {
    const entry = (SENTINEL_PLAN_STRINGS as Record<string, any>)[key];
    assert.ok(entry?.hud && entry.professional && entry.define, key);
  }
});

test('the default pipeline is a valid declaration for any lock: every check stage gets a distinct stage id', () => {
  const p = defaultPipelineOf({
    checks: ['test.ok', 'test-ok', '9lives', 'secrets-gitleaks', 'UPPER_case'].map((adapterId) => ({
      adapterId,
      rules: [`sentinel.rule.${adapterId.length}`],
    })),
  });
  const model = stageModel(p);
  const ids = p.stages.map((s: any) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('secrets'));
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
  assert.equal([...model.roles.values()].filter((r: any) => r.role === 'check').length, 5);
});
