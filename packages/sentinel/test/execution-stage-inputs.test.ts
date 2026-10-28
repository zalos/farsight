// A declared stage's typed inputs resolved against a real run: the foundation-preview path planned canonically and
// run by the coordinator (the built-in preview detector as a real worker), then a stage reading `preview.findings`
// resolved before and after the preview units publish. Before: waiting, bound to nothing. After: the exact accepted
// findings artifacts of exactly the producing units, through the canonical secret fold. A stage id expands to its
// units over the run's implied default pipeline, and a recorded pipeline must claim every unit of the plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../dist/store/index.js';
import { adoptedPolicy, adoptWorkspaceSettings, promoteRulePack, workspaceOf } from '../dist/service/local.js';
import { executeRun, planWorkspaceCanonical } from '../dist/service/canonical.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { initWorkspace } from '../dist/cli/init.js';
import { loadPlan } from '../dist/execution/plans.js';
import { checkProfileForPlan, withPipeline } from '../dist/execution/profile.js';
import { expandStageTokens } from '../dist/execution/selection.js';
import {
  impliedPipelineOf,
  outputSchemasOf,
  pipelineOf,
  resolveStageInputs,
  stageInputsForUnit,
} from '../dist/execution/stage-inputs.js';
import { PREVIEW_FINDINGS_SCHEMA, PREVIEW_RULE } from '../dist/adapters/preview-detector.js';
import { COVERAGE_SCHEMA } from '../dist/execution/coverage.js';
import { stageModel, stagesOfUnits } from '../dist/planner/index.js';
import { scratchUnder, removeScratch } from './lease-helpers.ts';
import { needsStore, unlock } from './snapshot-helpers.ts';

/** The run's implied pipeline with one more stage reading the given outputs. */
const reading = (implied: any, needs: unknown[], extra: unknown[] = []) => ({
  ...implied,
  stages: [
    ...implied.stages,
    ...extra,
    { id: 'triage', kind: 'agent', mode: 'native', runner: 'claude-cli', model: 'm', needs, after: ['preview'] },
  ],
});

test(
  'a stage reading preview.findings waits until the preview publishes, then binds its exact accepted artifacts',
  needsStore,
  async (t) => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-stage-inputs-')));
    t.after(() => {
      unlock(dir);
      rmSync(dir, { recursive: true, force: true });
    });
    const path = join(dir, 'ws');
    mkdirSync(join(path, 'src'), { recursive: true });
    writeFileSync(
      join(path, 'src/users.ts'),
      'export const find = (id: string) => db.query("SELECT * FROM users WHERE id = " + id);\n',
    );
    writeFileSync(
      join(path, 'src/orders.ts'),
      'export const all = (k: string) => db.query("DELETE FROM orders WHERE k = " + k);\n',
    );
    writeFileSync(
      join(path, 'src/safe.ts'),
      'export const one = (id: string) => db.query("SELECT 1 WHERE id = ?", [id]);\n',
    );
    const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
    initWorkspace({ workspace: path });
    adoptWorkspaceSettings(ws, { confirm: true, now: new Date() });
    promoteRulePack(ws, {
      packDir: realpathSync.native(builtinPackDir('foundation-preview')!),
      confirm: true,
      now: new Date(),
    });
    const adopted = adoptedPolicy(ws);
    assert.ok('policy' in adopted);
    const store = await openStore(ws.storePath);
    t.after(() => {
      try {
        store.close();
      } catch {
        /* closed */
      }
    });
    const work = scratchUnder(store);
    try {
      const planned = await planWorkspaceCanonical(store, {
        workspace: path,
        trustDir: ws.trustDir,
        policy: adopted.policy,
        scratchRoot: work,
        now: new Date(),
      });
      const admitted = await loadPlan(store, planned.disclosure.runId, planned.disclosure.revision);
      assert.ok(admitted.plan.pins.rules.every((r) => r.familyId === PREVIEW_RULE));

      // A run planned without a declaration reads as its implied default pipeline: every unit is the preview stage's.
      const implied = impliedPipelineOf(admitted);
      assert.deepEqual(pipelineOf(admitted), implied);
      const owner = stagesOfUnits(stageModel(implied), admitted.plan);
      assert.deepEqual([...new Set(owner.values())], ['preview']);
      const previewUnits = admitted.plan.units.map((u) => ({ id: u.id, revision: u.revision }));
      assert.equal(previewUnits.length, 3, 'one unit per scope');

      // `rerun --stage preview` names every preview unit; a unit id is kept; an unknown token is reported.
      const one = previewUnits[0]!.id;
      const expanded = expandStageTokens(admitted, ['preview', one, 'nowhere']);
      assert.deepEqual(expanded.units, previewUnits.map((u) => u.id).sort());
      assert.deepEqual(expanded.unknown, ['nowhere']);
      assert.deepEqual(
        expanded.stages!.downstream.map((d) => d.stage),
        ['report'],
        'the report runs after the preview',
      );
      assert.deepEqual(expandStageTokens(admitted, [one]).units, [one]);

      const model = stageModel(
        reading(
          implied,
          [
            { stage: 'preview', output: 'findings' },
            { stage: 'preview', output: 'coverage' },
            { stage: 'ci', output: 'findings' },
          ],
          [{ id: 'ci', kind: 'tool', adapter: 'zizmor', rules: ['sentinel.ci.workflow-audit'], needs: ['inventory'] }],
        ),
      );
      // Before the run: the producers have not published, so nothing is bound.
      const before = await resolveStageInputs(store, admitted, model, 'triage');
      assert.deepEqual(
        before.map((i) => [i.state, i.artifacts.length, i.producers.length, i.secretFold]),
        [
          ['waiting', 0, 3, 'not-applicable'],
          ['waiting', 0, 3, 'not-applicable'],
          ['missing', 0, 0, 'not-applicable'],
        ],
      );

      const summary = await executeRun(store, planned.disclosure.runId, { scratchRoot: work });
      assert.equal(summary.state, 'completed', JSON.stringify(summary.failures));

      const after = await resolveStageInputs(store, admitted, model, 'triage');
      const outputs = previewUnits.flatMap((u) => store.ledger.getPublication(u)!.outputs);
      const coverage = outputs
        .filter((o) => o.schema === COVERAGE_SCHEMA)
        .map((o) => o.id)
        .sort();
      // The detector's findings document is a raw worker output (recorded as JSON) naming its own schema inside.
      const findings: string[] = [];
      for (const o of outputs.filter((x) => x.schema === 'application/json'))
        if (JSON.parse((await store.readArtifact(o.id as never)).toString('utf8')).schema === PREVIEW_FINDINGS_SCHEMA)
          findings.push(o.id);
      findings.sort();
      assert.equal(findings.length, 3, 'one findings document per preview unit');
      assert.deepEqual(after[0], {
        decl: { stage: 'preview', output: 'findings' },
        state: 'resolved',
        artifacts: findings,
        producers: [...previewUnits].sort((a, b) => (a.id < b.id ? -1 : 1)),
        secretFold: 'applied',
      });
      assert.ok(coverage.length > 0);
      assert.deepEqual(after[1]!.artifacts, coverage);
      assert.deepEqual([after[2]!.state, after[2]!.artifacts], ['missing', []]);
      assert.ok(outputSchemasOf('findings').includes(PREVIEW_FINDINGS_SCHEMA));

      // A unit of a run planned without a recorded pipeline is bound exactly as before: no stage inputs.
      assert.equal(await stageInputsForUnit(store, admitted, previewUnits[0]!), undefined);

      // A recorded pipeline must be the declaration the plan was made from.
      checkProfileForPlan(withPipeline(admitted.profile, implied), admitted.plan);
      // A valid declaration whose preview stage selects another rule claims none of this plan's units.
      const other = {
        ...implied,
        stages: implied.stages.map((s: any) => (s.id === 'preview' ? { ...s, rules: ['sentinel.other.rule'] } : s)),
      };
      assert.throws(
        () => checkProfileForPlan(withPipeline(admitted.profile, other), admitted.plan),
        (e: any) => e.code === 'sentinel.execution.planInvalid' && /not made from the pipeline/.test(e.message),
      );
    } finally {
      removeScratch(work);
    }
  },
);
