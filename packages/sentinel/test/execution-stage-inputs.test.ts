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
import {
  adoptedPolicy,
  adoptWorkspaceSettings,
  followWorkspaceRun,
  promoteRulePack,
  workspaceOf,
} from '../dist/service/local.js';
import { executeRun, planWorkspaceCanonical } from '../dist/service/canonical.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { initWorkspace } from '../dist/cli/init.js';
import { loadPlan } from '../dist/execution/plans.js';
import { checkProfileForPlan, withPipeline } from '../dist/execution/profile.js';
import { expandStageTokens } from '../dist/execution/selection.js';
import {
  foldUpstreamBytes,
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
    let runId: string;
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
      runId = planned.disclosure.runId;
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

      // The preview stage also declares an output it never publishes, to read it as a producer that published
      // without the requested type.
      const declared = {
        ...implied,
        stages: implied.stages.map((s: any) =>
          s.id === 'preview' ? { ...s, produces: [{ name: 'notes', schema: 'sentinel.notes/v1' }] } : s,
        ),
      };
      const model = stageModel(
        reading(
          declared,
          [
            { stage: 'preview', output: 'findings' },
            { stage: 'preview', output: 'coverage' },
            { stage: 'ci', output: 'findings' },
            { stage: 'preview', output: 'notes' },
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
          ['waiting', 0, 3, 'not-applicable'],
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
      // Every producer published, none of them a `sentinel.notes/v1` document: missing, never resolved to nothing.
      assert.deepEqual([after[3]!.state, after[3]!.artifacts, after[3]!.producers.length], ['missing', [], 3]);
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

      // `rerun --stage preview` through the service: the stage expands to its units, the preview names what runs
      // after it, and confirming plans one linked child; an undeclared stage is refused.
      store.close();
      const now = new Date();
      const unknown = await followWorkspaceRun(ws, { mode: 'rerun', runId, stages: ['nowhere'], confirm: true, now });
      assert.deepEqual(
        [unknown.outcome, unknown.reasonCode, unknown.facts.unknown],
        ['configuration-failure', 'sentinel.service.stageUnknown', ['nowhere']],
      );
      const stages = (s: any) => [
        s.selected.map((x: any) => [x.stage, x.units.length]),
        s.downstream.map((x: any) => x.stage),
      ];
      const child = await followWorkspaceRun(ws, { mode: 'rerun', runId, stages: ['preview'], confirm: true, now });
      assert.equal(child.outcome, 'prepared', JSON.stringify(child));
      assert.equal(child.facts.parentId, runId);
      assert.notEqual(child.facts.runId, runId, 'a linked child run, the parent unchanged');
      assert.deepEqual(stages(child.facts.stages), [[['preview', 3]], ['report']]);
      // Asking again joins the same child.
      const again = await followWorkspaceRun(ws, { mode: 'rerun', runId, stages: ['preview'], confirm: true, now });
      assert.deepEqual([again.outcome, again.facts.runId], ['kept', child.facts.runId]);
      assert.deepEqual((child.facts.preview as any).selected, previewUnits.map((u) => u.id).sort());
    } finally {
      removeScratch(work);
    }
  },
);

test('every upstream artifact passes the fail-closed read boundary before an agent or a script may read it', () => {
  const clean = { id: 'producer-unit', adapterId: 'sentinel.preview.detector' };
  const json = (v: unknown) => Buffer.from(JSON.stringify(v));
  const names = new Set(['src/secrets.env']);
  const doc = { schema: 'sentinel-preview-findings/draft-1', findings: [{ path: 'src/users.ts', line: 1 }] };
  assert.equal(
    foldUpstreamBytes(json(doc), clean, names),
    null,
    'an inspectable document with nothing withheld passes',
  );
  // Withheld evidence anywhere in it: a withheld location, a withheld detail, a withheld flag.
  const withheldLocation = {
    location: 'withheld',
    snapshotId: 'snap-1',
    sourceId: 'workspace',
    entry: 4,
    content: `sha256:${'a'.repeat(64)}`,
  };
  for (const v of [
    { ...doc, findings: [{ evidence: [withheldLocation] }] },
    { records: [{ state: 'withheld', reasonCode: 'sentinel.report.withheld.secret' }] },
    { nested: { deeper: [{ withheld: true }] } },
  ])
    assert.equal(foldUpstreamBytes(json(v), clean, names), 'withheld-evidence', JSON.stringify(v));
  // A file an accepted secret match withheld, named anywhere in it.
  assert.equal(foldUpstreamBytes(json({ ...doc, files: ['src/secrets.env'] }), clean, names), 'secret-match-name');
  // What cannot be inspected does not pass: not UTF-8, not JSON, too deep.
  assert.equal(foldUpstreamBytes(Buffer.from([0xff, 0xfe, 0x7b]), clean, names), 'unreadable');
  assert.equal(foldUpstreamBytes(Buffer.from('not json'), clean, names), 'unreadable');
  let deep: unknown = 1;
  for (let i = 0; i < 80; i++) deep = [deep];
  assert.equal(foldUpstreamBytes(json(deep), clean, names), 'unreadable');
  // A secret scanner's own output never reaches a consumer, whatever it holds.
  assert.equal(foldUpstreamBytes(json(doc), { adapterId: 'secrets-gitleaks' }, names), 'secret-scanner-output');
});
