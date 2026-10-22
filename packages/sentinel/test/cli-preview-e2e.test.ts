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
import { readdirSync } from 'node:fs';
import { unlock } from './snapshot-helpers.ts';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const QUALIFIED = qualificationFor(SQLITE_RELEASE_POLICY, `${process.platform}-${process.arch}`, process.versions.sqlite ?? '') !== undefined;
const needsStore = QUALIFIED || process.env.CI ? {} : { skip: 'not a qualified store host' };

/** Stops the workspace's background service (SIGTERM to the pid its private descriptor names) and waits for it. */
function stopService(env: { XDG_STATE_HOME: string }) {
  const dir = join(env.XDG_STATE_HOME, 'farsight', 'sentinel', 'trust', 'services');
  let names: string[] = [];
  try { names = readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return; }
  for (const n of names) {
    const { pid } = JSON.parse(readFileSync(join(dir, n), 'utf8')) as { pid: number };
    try { process.kill(pid, 'SIGTERM'); } catch { continue; }
    for (let i = 0; i < 200; i++) {
      try { process.kill(pid, 0); } catch { break; }
      spawnSync('sleep', ['0.05']);
    }
  }
}

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
  // Nothing is planned until the owner promotes a rule pack into the rule lock.
  assert.deepEqual([run('plan').status, run('plan').body.reasonCode], [3, 'sentinel.service.noRuleLock']);
  assert.equal(run('rules', 'promote', 'builtin:foundation-preview', '--confirm').status, 0);

  const plan = run('plan');
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(plan.body.outcome, 'prepared');
  assert.deepEqual(plan.body.facts.effects, ['local-artifacts']);
  assert.equal(plan.body.facts.label, 'foundation-preview');
  assert.equal(plan.body.facts.revision, 2, 'the admitted analysis follows the published bootstrap');
  assert.equal(plan.body.facts.checks.planned, 2, 'one check per TypeScript or Java file, planned from the published parse');
  assert.ok(Object.values(plan.body.verdicts).every((v: any) => v.asked && v.allowed), 'capture was admitted by all three verdicts');
  const planId = plan.body.facts.planId;
  const replanned = run('plan');
  assert.deepEqual([replanned.body.outcome, replanned.body.facts.planId], ['kept', planId], 'the same content, lock and policy are the same run');

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

  // In the background: only the owner's confirmation hands a run over; a finished run prints its result again.
  const unconfirmed = run('run', planId, '--detach');
  assert.deepEqual([unconfirmed.status, unconfirmed.body.reasonCode], [4, 'sentinel.service.needsOwnerConfirm']);
  const detached = run('run', planId, '--detach', '--confirm');
  assert.deepEqual([detached.status, detached.body.facts.state, detached.body.verdicts.policy.reasonCode], [2, 'completed', 'sentinel.service.ownerReceipt']);
  assert.equal(run('plan').body.reasonCode, 'sentinel.service.ownerServiceRunning', 'the service alone holds the store while it runs');
  assert.equal(run('status', planId).body.facts.state, 'completed', 'status reads through the service');
  assert.equal(run('wait', planId).status, 2);
  stopService(env);
  assert.equal(run('run', 'plan-' + '0'.repeat(32)).body.reasonCode, 'sentinel.service.planUnknown');
  // A settings change after planning invalidates the plan rather than running under other rules.
  const path = join(ws, '.farsight/sentinel/settings.json');
  writeFileSync(path, readFileSync(path, 'utf8').replace('"medium"', '"high"'));
  assert.equal(run('run', planId).body.reasonCode, 'sentinel.service.settingsNotAdopted');
});

test('run --detach: the service starts on demand, a duplicate joins, callers leave, wait and report read the result', needsStore, t => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-detach-')));
  const env = { PATH: process.env.PATH ?? '', HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') };
  t.after(() => { stopService(env); unlock(dir); rmSync(dir, { recursive: true, force: true }); });
  const ws = join(dir, 'ws');
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src/users.ts'), 'export const find = (id: string) => db.query("SELECT * FROM users WHERE id = " + id);\n');
  mkdirSync(env.HOME);
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd: ws, env, encoding: 'utf8', timeout: 60_000 });
    let body: any;
    try { body = JSON.parse(r.stdout); } catch { body = r.stdout; }
    return { status: r.status, body, stderr: r.stderr };
  };
  run('init');
  run('settings', 'adopt', '--confirm');
  run('rules', 'promote', 'builtin:foundation-preview', '--confirm');
  const planId = run('plan').body.facts.planId;
  assert.deepEqual([run('pause', planId).status, run('pause', planId).body.reasonCode], [4, 'sentinel.service.needsOwnerConfirm'], 'pausing is a write: it waits for the owner');
  assert.equal(run('pause', planId, '--confirm').body.reasonCode, 'sentinel.service.notRunning', 'no service, nothing to pause');

  const first = run('run', planId, '--detach', '--confirm');
  assert.deepEqual([first.status, first.body.outcome, first.body.facts.runId], [0, 'submitted', planId], first.stderr);
  const second = run('run', planId, '--detach', '--confirm');
  assert.equal(second.body.facts.runId, planId, 'one run for one plan');
  assert.ok(second.body.outcome === 'submitted' ? second.body.facts.joined === true : second.body.facts.state === 'completed');
  const waited = run('wait', planId);
  assert.deepEqual([waited.status, waited.body.outcome, waited.body.facts.previewFindings], [2, 'required-coverage-incomplete', 1]);
  const report = spawnSync(process.execPath, [CLI, 'report', planId], { cwd: ws, env, encoding: 'utf8' });
  assert.match(report.stdout, /1 finding in this report/);
  const events = run('status', planId, '--limit', '50').body.facts.events;
  // Capture, parse and inventory ran once when planning; the one check unit ran once in the background.
  assert.equal(events.filter((e: { kind: string }) => e.kind === 'attempt-started').length, 4, 'executed once');

  stopService(env);
  assert.equal(run('plan').status, 0, 'a stopped service releases the store');
  assert.equal(run('wait', planId).status, 2, 'wait reads a finished run from the store with no service');
});
