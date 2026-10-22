// The npm-only consumer's path, through the executable alone: init → (plan refused) → settings adopt → plan → run →
// status → report, in a synthetic workspace with private state folders. The run is the foundation preview: its
// result is required coverage incomplete (exit 2), never satisfied. No network, scanner, container or model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { qualificationFor, SQLITE_RELEASE_POLICY } from '../dist/store/index.js';
import { unlock } from './snapshot-helpers.ts';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const QUALIFIED = qualificationFor(SQLITE_RELEASE_POLICY, `${process.platform}-${process.arch}`, process.versions.sqlite ?? '') !== undefined;
const needsStore = QUALIFIED || process.env.CI ? {} : { skip: 'not a qualified store host' };

test('init → adopt → plan → run → status → report, twice where it matters', needsStore, t => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-e2e-')));
  t.after(() => { unlock(dir); rmSync(dir, { recursive: true, force: true }); });
  const ws = join(dir, 'ws');
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src/users.ts'), 'export const find = (id: string) => db.query("SELECT * FROM users WHERE id = " + id);\n');
  writeFileSync(join(ws, 'src/Orders.java'), 'class Orders { String q = "SELECT * FROM orders WHERE id = ?"; }\n');
  const env = { PATH: process.env.PATH ?? '', HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') };
  mkdirSync(env.HOME);
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd: ws, env, encoding: 'utf8', timeout: 60_000 });
    let body: any;
    try { body = JSON.parse(r.stdout); } catch { body = r.stdout; }
    return { status: r.status, body, stderr: r.stderr };
  };

  assert.equal(run('init').status, 0);
  assert.equal(run('init').body.outcome, 'kept', 'initializing twice keeps the settings');
  const early = run('plan');
  assert.deepEqual([early.status, early.body.reasonCode], [3, 'sentinel.service.settingsNotAdopted'], 'nothing is planned before adoption');
  const preview = run('settings', 'adopt');
  assert.deepEqual([preview.status, preview.body.outcome], [4, 'awaiting-confirmation'], 'adoption waits for the owner');
  assert.deepEqual([run('settings', 'adopt', '--confirm').status], [0]);

  const plan = run('plan');
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(plan.body.outcome, 'prepared');
  assert.deepEqual(plan.body.facts.effects, ['local-artifacts']);
  assert.equal(plan.body.facts.label, 'foundation-preview');
  assert.ok(Object.values(plan.body.verdicts).every((v: any) => v.asked && v.allowed), 'capture was admitted by all three verdicts');
  const planId = plan.body.facts.planId;
  assert.equal(run('plan').body.facts.planId, planId, 'the same workspace and policy plan to the same id');

  const first = run('run', planId);
  assert.equal(first.status, 2, first.stderr);
  assert.deepEqual([first.body.outcome, first.body.reasonCode], ['required-coverage-incomplete', 'sentinel.service.previewNotCoverage']);
  assert.deepEqual([first.body.facts.runId, first.body.facts.state, first.body.facts.previewFindings], [planId, 'completed', 1]);
  // A duplicate start returns the same run and executes nothing again.
  const eventsBefore = run('status', planId, '--limit', '50').body.facts.events.length;
  const again = run('run', planId);
  assert.deepEqual([again.status, again.body.facts.runId], [2, planId]);
  assert.equal(run('status', planId, '--limit', '50').body.facts.events.length, eventsBefore, 'no second execution');

  const status = run('status', planId, '--limit', '2');
  assert.equal(status.body.facts.state, 'completed');
  assert.ok(status.body.facts.events.length <= 2 && status.body.facts.more === true, 'status is bounded and pages');
  const report = spawnSync(process.execPath, [CLI, 'report', planId], { cwd: ws, env, encoding: 'utf8' });
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /foundation preview/i);
  assert.match(report.stdout, /1 finding in this report/);
  const json = run('report', planId).body;
  const json2 = run('report', planId).body;
  assert.deepEqual([json.outcome, json.exitCode], ['answered', 0], 'with --json the report travels inside the typed result');
  assert.deepEqual({ ...json.facts.report, generatedAt: null }, { ...json2.facts.report, generatedAt: null }, 'the report regenerates from stored results alone');

  assert.deepEqual([run('run', planId, '--detach').status, run('run', planId, '--detach').body.outcome], [3, 'unavailable'], 'no background run is pretended');
  assert.equal(run('run', 'plan-' + '0'.repeat(32)).body.reasonCode, 'sentinel.service.planUnknown');
  // A settings change after planning invalidates the plan rather than running under other rules.
  const path = join(ws, '.farsight/sentinel/settings.json');
  writeFileSync(path, readFileSync(path, 'utf8').replace('"medium"', '"high"'));
  assert.equal(run('run', planId).body.reasonCode, 'sentinel.service.settingsNotAdopted');
});
