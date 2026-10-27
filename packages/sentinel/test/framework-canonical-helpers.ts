// Genuine adopted owner settings and promoted installed packs; actual capture/parse/inventory and Coordinator.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../dist/store/index.js';
import { initWorkspace } from '../dist/cli/init.js';
import { adoptedPolicy, adoptWorkspaceSettings, promoteRulePack, workspaceOf } from '../dist/service/local.js';
import { scratchUnder, removeScratch } from './lease-helpers.ts';
import { executeRun, planWorkspaceCanonical } from '../dist/service/canonical.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { adoptScannerAsset } from '../dist/service/scanner-assets.js';
import { GITLEAKS_SUPPORTED_RULES } from '../dist/adapters/drivers/index.js';
import { loadPlan } from '../dist/execution/plans.js';
import { CONTROLS_SUPPORTED_RULES } from '../dist/frameworks/controls/driver.js';
import { commitRepo, scratch } from './snapshot-helpers.ts';
export async function frameworkFixture(
  t: any,
  files: Record<string, string>,
  options: { preview?: boolean; promote?: boolean; run?: boolean; secrets?: boolean } = {},
) {
  const dir = scratch(t, 'framework-canonical-'),
    path = join(dir, 'workspace');
  commitRepo(path, files);
  const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'owner') });
  initWorkspace({ workspace: path });
  const settings = join(path, '.farsight/sentinel/settings.json');
  writeFileSync(
    settings,
    JSON.stringify({
      ...JSON.parse(readFileSync(settings, 'utf8')),
      mandatoryRules: [
        ...CONTROLS_SUPPORTED_RULES.map((r) => r.familyId),
        ...(options.preview ? ['sentinel.preview.sql-string-concat'] : []),
        ...(options.secrets ? GITLEAKS_SUPPORTED_RULES.map((r) => r.familyId) : []),
      ],
    }),
  );
  assert.equal(adoptWorkspaceSettings(ws, { confirm: true, now: new Date() }).outcome, 'prepared');
  if (options.promote !== false)
    assert.equal(
      promoteRulePack(ws, { packDir: builtinPackDir('framework-controls')!, confirm: true, now: new Date() }).outcome,
      'prepared',
    );
  if (options.preview || options.promote === false)
    assert.equal(
      promoteRulePack(ws, { packDir: builtinPackDir('foundation-preview')!, confirm: true, now: new Date() }).outcome,
      'prepared',
    );
  if (options.secrets) {
    assert.equal(
      promoteRulePack(ws, { packDir: builtinPackDir('secrets')!, confirm: true, now: new Date() }).outcome,
      'prepared',
    );
    assert.equal(
      (await adoptScannerAsset(ws, { kind: 'tool', id: 'secrets-gitleaks', confirm: true, now: new Date() })).outcome,
      'prepared',
    );
  }
  const adopted = adoptedPolicy(ws);
  assert.ok('policy' in adopted);
  const store = await openStore(ws.storePath);
  t.after(() => {
    if (store.held) store.close();
  });
  const work = scratchUnder(store);
  t.after(() => removeScratch(work));
  const terms = { workspace: path, trustDir: ws.trustDir, policy: adopted.policy, scratchRoot: work, now: new Date() };
  const planned = await planWorkspaceCanonical(store, terms);
  const runId = planned.disclosure.runId;
  const admitted = await loadPlan(store, runId, planned.disclosure.revision);
  const run = () => executeRun(store, runId, { scratchRoot: work, trustDir: ws.trustDir });
  if (options.run !== false) {
    const result = await run();
    assert.equal(result.state, 'completed', JSON.stringify(result.failures));
  }
  return { dir, path, ws, store, work, terms, planned, runId, admitted, run };
}
