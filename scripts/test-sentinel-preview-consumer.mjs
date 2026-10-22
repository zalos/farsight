#!/usr/bin/env node
// The npm-only consumer's foundation-preview path (PR 09), canonical end to end: install the packed Sentinel tarball into a clean npm
// prefix and, with only Node and npm, initialize a synthetic workspace twice (keeping its settings), adopt them,
// plan, run and read the report through the installed `farsight-sentinel` alone: no pnpm, no Farsight checkout. Then
// a second plan is handed to the owner's background service (`run --detach --confirm`, started on demand), joined
// by a duplicate start, waited for and reported through the service, which is then stopped.
// The run is the foundation preview: it must end required coverage incomplete (exit 2), never satisfied. No scanner,
// container, model or network service is started; npm may fetch Sentinel's declared third-party dependencies.
//
//   pnpm pack:sentinel && node scripts/test-sentinel-preview-consumer.mjs [build/sentinel/farsight-sentinel-<v>.tgz]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual(Object.keys(assets), ['execution/launch-gate']);
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
  const second = (await sentinel('plan')).body.facts.planId;
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
  console.log(`sentinel preview consumer ok: npm-only install, init twice, adopt, promote the built-in pack, plan ${planId}, run (exit 2, preview), report; background run ${second} (detach, join, wait, report)`);
} finally {
  consumer.cleanup();
}
