#!/usr/bin/env node
// The npm-only consumer's foundation-preview path (PR 09), canonical end to end: install the packed Sentinel tarball into a clean npm
// prefix and, with only Node and npm, initialize a synthetic workspace twice (keeping its settings), adopt them,
// plan, run and read the report through the installed `farsight-sentinel` alone: no pnpm, no Farsight checkout. Then
// a second plan is handed to the owner's background service (`run --detach --confirm`, started on demand), joined
// by a duplicate start, waited for and reported through the service, which is then stopped. With the workspace's
// source moved away, each of that run's units is rerun alone (`rerun --stage`) over the retained snapshot: the
// selection is the preview's, the other unit is held, the parent's report is unchanged, and nothing is recaptured.
// The run is the foundation preview: it must end required coverage incomplete (exit 2), never satisfied. No scanner,
// container, model or network service is started; npm may fetch Sentinel's declared third-party dependencies.
//
//   pnpm pack:sentinel && node scripts/test-sentinel-preview-consumer.mjs [build/sentinel/farsight-sentinel-<v>.tgz]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmConsumer } from './npm-consumer.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(readFileSync(join(root, 'packages', 'sentinel', 'package.json'), 'utf8'));
const artifact = resolve(process.argv[2] ?? join(root, 'build', 'sentinel', `farsight-sentinel-${source.version}.tgz`));
if (!existsSync(artifact)) {
  console.error(`test-sentinel-preview-consumer: ${artifact} is missing. Run \`pnpm pack:sentinel\` first.`);
  process.exit(1);
}

const consumer = await npmConsumer('sentinel-preview-', [artifact]);
try {
  const scratch = realpathSync.native(consumer.scratch);
  const ws = join(scratch, 'workspace');
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'users.ts'), 'export const find = (id: string) => db.query("SELECT * FROM users WHERE id = " + id);\n');
  writeFileSync(join(ws, 'src', 'Orders.java'), 'class Orders { String q = "SELECT * FROM orders WHERE id = ?"; }\n');
  // Private owner state inside the scratch folder, never the real user's.
  const env = { ...consumer.env, HOME: join(scratch, 'home'), XDG_STATE_HOME: join(scratch, 'owner-state') };
  mkdirSync(env.HOME, { recursive: true });
  const bin = consumer.bin('farsight-sentinel');
  // The files the package starts by path (the launch gate) are installed where its manifest says, with those bytes.
  const installed = join(consumer.dir, 'node_modules', 'farsight-sentinel');
  const assets = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).sentinel?.assets ?? {};
  assert.deepEqual(Object.keys(assets), ['execution/launch-gate', 'frameworks/controls/worker']);
  for (const [name, { path, sha256 }] of Object.entries(assets)) {
    assert.equal(createHash('sha256').update(readFileSync(join(installed, path))).digest('hex'), sha256, `${name} is the recorded bytes`);
  }
  const sentinel = async (...args) => {
    try {
      const r = await consumer.exec(bin, [...args, '--json'], { cwd: ws, env });
      return { status: 0, body: JSON.parse(r.stdout) };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { status: error.code, body: JSON.parse(error.stdout) };
    }
  };

  assert.equal((await sentinel('init')).body.outcome, 'prepared');
  const settings = readFileSync(join(ws, '.farsight', 'sentinel', 'settings.json'));
  assert.equal((await sentinel('init')).body.outcome, 'kept', 'a second init keeps the configuration');
  assert.deepEqual(readFileSync(join(ws, '.farsight', 'sentinel', 'settings.json')), settings);
  assert.equal((await sentinel('settings', 'adopt')).status, 4, 'adoption waits for the owner');
  assert.equal((await sentinel('settings', 'adopt', '--confirm')).status, 0);
  // The rule pack the package ships, promoted by the owner from the installed tarball alone.
  assert.equal((await sentinel('rules', 'promote', 'builtin:foundation-preview')).status, 4, 'promotion waits for the owner');
  const promoted = await sentinel('rules', 'promote', 'builtin:foundation-preview', '--confirm');
  assert.deepEqual([promoted.status, promoted.body.facts.rules], [0, ['sentinel.preview.sql-string-concat']], JSON.stringify(promoted.body));
  const plan = await sentinel('plan');
  assert.equal(plan.status, 0, JSON.stringify(plan.body));
  const planId = plan.body.facts.planId;
  const run = await sentinel('run', planId);
  assert.equal(run.status, 2, JSON.stringify(run.body));
  assert.equal(run.body.outcome, 'required-coverage-incomplete', 'a preview is never a satisfied scan');
  assert.equal(run.body.facts.previewFindings, 1);
  const report = await consumer.exec(bin, ['report', planId], { cwd: ws, env });
  assert.match(report.stdout, /foundation preview/i);
  assert.match(report.stdout, /1 finding in this report/);

  // In the background: new content, a new plan, handed to the service only with the owner's confirmation.
  writeFileSync(join(ws, 'src', 'accounts.ts'), 'export const q = (n: string) => `DELETE FROM accounts WHERE name = ${n}`;\n');
  const secondPlan = (await sentinel('plan')).body.facts;
  const second = secondPlan.planId;
  assert.notEqual(second, planId);
  assert.equal((await sentinel('run', second, '--detach')).status, 4, 'a background run waits for the owner');
  const detached = await sentinel('run', second, '--detach', '--confirm');
  assert.deepEqual([detached.status, detached.body.outcome], [0, 'submitted'], JSON.stringify(detached.body));
  assert.equal((await sentinel('run', second, '--detach', '--confirm')).body.facts.runId, second, 'a duplicate start is the same run');
  const waited = await sentinel('wait', second);
  assert.deepEqual([waited.status, waited.body.facts.previewFindings], [2, 2], JSON.stringify(waited.body));
  const viaService = await consumer.exec(bin, ['report', second], { cwd: ws, env });
  assert.match(viaService.stdout, /2 findings in this report/);
  const services = join(env.XDG_STATE_HOME, 'farsight', 'sentinel', 'trust', 'services');
  for (const name of readdirSync(services)) {
    const { pid } = JSON.parse(readFileSync(join(services, name), 'utf8'));
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 200; i++) { try { process.kill(pid, 0); } catch { break; } await new Promise(r => setTimeout(r, 50)); }
  }
  // A selected rerun of the background run, with its source gone: only the retained snapshot is read.
  const units = secondPlan.unitIds;
  assert.equal(units.length, 3, JSON.stringify(units)); // one check unit per source file
  const reportBefore = (await sentinel('report', second)).body.facts.report;
  renameSync(join(ws, 'src'), join(scratch, 'src-away'));
  let found = 0;
  for (const unit of units) {
    const prepared = await sentinel('rerun', second, '--stage', unit);
    assert.deepEqual([prepared.status, prepared.body.outcome, prepared.body.facts.parentId], [0, 'prepared', second], JSON.stringify(prepared.body));
    const { preview } = prepared.body.facts;
    assert.deepEqual([preview.selected, preview.all, preview.units.length, preview.held.length], [[unit], false, 1, units.length - 1]);
    const ran = await sentinel('run', prepared.body.facts.runId);
    assert.deepEqual([ran.status, ran.body.facts.state], [2, 'completed'], JSON.stringify(ran.body));
    found += ran.body.facts.previewFindings;
  }
  assert.equal(found, 2, 'the selections between them find the parent\'s two findings');
  assert.deepEqual({ ...(await sentinel('report', second)).body.facts.report, generatedAt: null }, { ...reportBefore, generatedAt: null }, 'the parent is unchanged');
  renameSync(join(scratch, 'src-away'), join(ws, 'src'));
  // A pack the owner promotes that names the preview detector for another rule is refused before anything runs: the
  // detector implements exactly its own shipped rule, so a plan for anything else is never reported as covered.
  const custom = join(scratch, 'custom-pack');
  cpSync(join(installed, 'rules', 'foundation-preview'), custom, { recursive: true });
  const manifestPath = join(custom, 'sentinel-pack.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.packId = 'custom-pack';
  manifest.rules[0].familyId = 'sentinel.custom.other-rule';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const settingsPath = join(ws, '.farsight', 'sentinel', 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(readFileSync(settingsPath, 'utf8')), mandatoryRules: ['sentinel.custom.other-rule'] }));
  assert.equal((await sentinel('settings', 'adopt', '--confirm')).status, 0);
  assert.equal((await sentinel('rules', 'promote', custom, '--confirm')).status, 0);
  const refused = await sentinel('plan');
  assert.deepEqual([refused.status, refused.body.reasonCode], [3, 'sentinel.service.ruleUnsupported'], JSON.stringify(refused.body));
  console.log(`sentinel preview consumer ok: npm-only install, init twice, adopt, promote the built-in pack, plan ${planId}, run (exit 2, preview), report; background run ${second} (detach, join, wait, report); each of its units rerun alone with the source gone; a custom pack for the preview detector refused`);
} finally {
  consumer.cleanup();
}
